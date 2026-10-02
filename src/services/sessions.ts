import { address, createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder, getBase58Decoder, type KeyPairSigner } from "@solana/kit";
import { runtimeConfig } from "../config.ts";
import type { Env } from "../env.ts";
import type { Db } from "../db/client.ts";
import { audit, countLiveSessions, SessionStatus, type SessionWallet, type User } from "../db/repo.ts";
import { decryptSeed, encryptSeed } from "../lib/crypto.ts";
import { log } from "../lib/util.ts";
import { heliusAddAddress, heliusRemoveAddress } from "./helius.ts";

export class SessionLimitError extends Error {
  constructor(limit: number) {
    super(`You already have ${limit} live sessions. End one first.`);
    this.name = "SessionLimitError";
  }
}

export class KeyPurgedError extends Error {
  constructor() {
    super("This session's key has been purged.");
    this.name = "KeyPurgedError";
  }
}

const LABELS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];

function cleanLabel(input: string | undefined): string | null {
  const v = (input ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 16);
  return v.length >= 2 ? v : null;
}

/**
 * Creates a session wallet. The seed exists in plaintext only inside this function and is zeroed
 * before returning.
 */
export async function createSession(
  env: Env,
  db: Db,
  user: User,
  opts: { label?: string; workingFloatLamports?: bigint; waitUntil?: (p: Promise<unknown>) => void } = {},
): Promise<SessionWallet> {
  const cfg = runtimeConfig(env);
  const live = await countLiveSessions(db, user.id);
  if (live >= cfg.maxSessionsPerUser) throw new SessionLimitError(cfg.maxSessionsPerUser);

  const existing = await db.sessionWallet.findMany({ where: { userId: user.id }, select: { label: true } });
  const taken = new Set(existing.map((s) => s.label));
  let label = cleanLabel(opts.label) ?? LABELS.find((l) => !taken.has(l)) ?? `s${existing.length + 1}`;
  if (taken.has(label)) label = `${label}${existing.length + 1}`;

  const seed = crypto.getRandomValues(new Uint8Array(32));
  try {
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed, false);
    const wallet = signer.address as string;
    const secret = await encryptSeed(env, { userId: user.id, userSalt: user.keySalt, wallet, seed, keyVersion: cfg.masterKeyVersion });
    const session = await db.sessionWallet.create({
      data: {
        userId: user.id,
        label,
        address: wallet,
        status: SessionStatus.ACTIVE,
        encryptedKey: secret.ciphertext,
        keyIv: secret.iv,
        keyVersion: secret.keyVersion,
        workingFloatLamports: opts.workingFloatLamports ?? 0n,
      },
    });
    await audit(db, { userId: user.id, sessionId: session.id, action: "SESSION_CREATED", status: "OK", detail: { label, address: wallet } });
    const watch = heliusAddAddress(env, wallet).catch((err) => log("warn", "helius add failed; cron will reconcile", { err: String(err) }));
    if (opts.waitUntil) opts.waitUntil(watch);
    else await watch;
    return session;
  } finally {
    seed.fill(0);
  }
}

/** Decrypts the session key into a non-extractable signer. The raw seed is zeroed immediately. */
export async function loadSigner(env: Env, user: User, session: SessionWallet): Promise<KeyPairSigner> {
  if (!session.encryptedKey || !session.keyIv || session.status === SessionStatus.PURGED) throw new KeyPurgedError();
  const seed = await decryptSeed(env, {
    userId: user.id,
    userSalt: user.keySalt,
    wallet: session.address,
    secret: { ciphertext: session.encryptedKey, iv: session.keyIv, keyVersion: session.keyVersion },
  });
  try {
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed, false);
    if (signer.address !== session.address) throw new Error("Decrypted key does not match session address");
    return signer;
  } finally {
    seed.fill(0);
  }
}

/**
 * 64-byte secret (seed || pubkey) in base58, the format Phantom, Solflare and most trading bots import.
 * The caller is responsible for deleting the Telegram message that carries it.
 */
export async function exportSecretKey(env: Env, db: Db, user: User, session: SessionWallet): Promise<string> {
  if (!session.encryptedKey || !session.keyIv || session.status === SessionStatus.PURGED) throw new KeyPurgedError();
  const seed = await decryptSeed(env, {
    userId: user.id,
    userSalt: user.keySalt,
    wallet: session.address,
    secret: { ciphertext: session.encryptedKey, iv: session.keyIv, keyVersion: session.keyVersion },
  });
  const full = new Uint8Array(64);
  try {
    full.set(seed, 0);
    full.set(new Uint8Array(getAddressEncoder().encode(address(session.address))), 32);
    const out = getBase58Decoder().decode(full);
    await db.sessionWallet.update({ where: { id: session.id }, data: { exportCount: { increment: 1 } } });
    await audit(db, { userId: user.id, sessionId: session.id, action: "KEY_EXPORTED", status: "OK", detail: { exportCount: session.exportCount + 1 } });
    return out;
  } finally {
    seed.fill(0);
    full.fill(0);
  }
}

/**
 * Crypto-shreds the session: ciphertext and IV are overwritten with NULL and the row is tombstoned.
 * D1 Time Travel keeps 30 days of history, which is why the master key never lives in D1: old
 * ciphertext without MASTER_KEY_V{n} is useless, and the wallet is emptied before purge anyway.
 */
export async function purgeSession(env: Env, db: Db, user: User, session: SessionWallet, reason: string): Promise<void> {
  await db.sessionWallet.update({
    where: { id: session.id },
    data: { encryptedKey: null, keyIv: null, status: SessionStatus.PURGED, purgedAt: new Date(), endedAt: session.endedAt ?? new Date() },
  });
  await audit(db, { userId: user.id, sessionId: session.id, action: "KEY_PURGED", status: "OK", detail: { reason } });
  await heliusRemoveAddress(env, session.address).catch((err) => log("warn", "helius remove failed; cron will reconcile", { err: String(err) }));
}

/** Hourly: re-encrypt sessions still on an older MASTER_KEY version (rotation without CLI). */
export async function reencryptOldKeys(env: Env, db: Db, limit = 50): Promise<{ migrated: number; remaining: number }> {
  const cfg = runtimeConfig(env);
  const stale = await db.sessionWallet.findMany({
    where: { keyVersion: { lt: cfg.masterKeyVersion }, encryptedKey: { not: null } },
    include: { user: true },
    take: limit,
  });
  let migrated = 0;
  for (const s of stale) {
    if (!s.encryptedKey || !s.keyIv) continue;
    const seed = await decryptSeed(env, {
      userId: s.userId,
      userSalt: s.user.keySalt,
      wallet: s.address,
      secret: { ciphertext: s.encryptedKey, iv: s.keyIv, keyVersion: s.keyVersion },
    });
    try {
      const secret = await encryptSeed(env, { userId: s.userId, userSalt: s.user.keySalt, wallet: s.address, seed, keyVersion: cfg.masterKeyVersion });
      // Optimistic guard: only replace the exact ciphertext we decrypted.
      const res = await db.sessionWallet.updateMany({
        where: { id: s.id, encryptedKey: s.encryptedKey },
        data: { encryptedKey: secret.ciphertext, keyIv: secret.iv, keyVersion: secret.keyVersion },
      });
      migrated += res.count;
    } finally {
      seed.fill(0);
    }
  }
  const remaining = await db.sessionWallet.count({ where: { keyVersion: { lt: cfg.masterKeyVersion }, encryptedKey: { not: null } } });
  if (migrated > 0) log("info", "re-encrypted session keys", { migrated, remaining, version: cfg.masterKeyVersion });
  return { migrated, remaining };
}
