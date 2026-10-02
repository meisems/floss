import type { Env } from "../env.ts";
import { fromBase64, toBase64 } from "./util.ts";

/**
 * Session-key encryption.
 *
 *   master key   MASTER_KEY_V{n} Worker secret (32 random bytes, base64). Never stored in D1.
 *   user salt    32 random bytes per user, stored in User.keySalt.
 *   KEK          HKDF-SHA256(master, salt = user salt, info = "floss/session-key/v1/<wallet>")
 *   ciphertext   AES-256-GCM(KEK, iv = 12 random bytes, aad = "<userId>:<wallet>")
 *
 * Every wallet gets its own derived key and the AAD binds ciphertext to its row, so a ciphertext
 * copied onto another user's row fails authentication instead of decrypting.
 */

const HKDF_INFO_PREFIX = "floss/session-key/v1/";

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  keyVersion: number;
}

export class MasterKeyMissingError extends Error {
  constructor(version: number) {
    super(`MASTER_KEY_V${version} is not configured. Add it under Worker -> Settings -> Variables and Secrets.`);
    this.name = "MasterKeyMissingError";
  }
}

function masterKeyBytes(env: Env, version: number): Uint8Array {
  const raw = env[`MASTER_KEY_V${version}`];
  if (!raw) throw new MasterKeyMissingError(version);
  const bytes = fromBase64(raw.trim());
  if (bytes.length !== 32) throw new Error(`MASTER_KEY_V${version} must be exactly 32 bytes (base64).`);
  return bytes;
}

async function deriveKek(env: Env, version: number, userSalt: string, wallet: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", masterKeyBytes(env, version), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: fromBase64(userSalt),
      info: new TextEncoder().encode(HKDF_INFO_PREFIX + wallet),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function aad(userId: string, wallet: string): Uint8Array {
  return new TextEncoder().encode(`${userId}:${wallet}`);
}

export function newUserSalt(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)));
}

export function hasMasterKey(env: Env, version: number): boolean {
  try {
    masterKeyBytes(env, version);
    return true;
  } catch {
    return false;
  }
}

export async function encryptSeed(
  env: Env,
  args: { userId: string; userSalt: string; wallet: string; seed: Uint8Array; keyVersion: number },
): Promise<EncryptedSecret> {
  const kek = await deriveKek(env, args.keyVersion, args.userSalt, args.wallet);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(args.userId, args.wallet), tagLength: 128 },
    kek,
    args.seed,
  );
  return { ciphertext: toBase64(new Uint8Array(ct)), iv: toBase64(iv), keyVersion: args.keyVersion };
}

/**
 * Returns the 32-byte seed. Callers must `seed.fill(0)` as soon as the signer is created.
 */
export async function decryptSeed(
  env: Env,
  args: { userId: string; userSalt: string; wallet: string; secret: EncryptedSecret },
): Promise<Uint8Array> {
  const kek = await deriveKek(env, args.secret.keyVersion, args.userSalt, args.wallet);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(args.secret.iv), additionalData: aad(args.userId, args.wallet), tagLength: 128 },
    kek,
    fromBase64(args.secret.ciphertext),
  );
  const seed = new Uint8Array(pt);
  if (seed.length !== 32) {
    seed.fill(0);
    throw new Error("Decrypted seed has unexpected length");
  }
  return seed;
}

/** HMAC-SHA256 helper (Telegram Mini App initData validation). */
export async function hmacSha256(key: Uint8Array, data: string | Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, bytes));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
