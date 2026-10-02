import type { Db } from "./client.ts";
import type { ColdVaultConfig, SessionWallet, SweepTriggerRule, User } from "../generated/prisma/client.ts";
import { LAMPORTS_PER_SOL } from "../config.ts";
import { newUserSalt } from "../lib/crypto.ts";
import { log, stringifyJson } from "../lib/util.ts";

export type { ColdVaultConfig, SessionWallet, SweepTriggerRule, User };

export const SessionStatus = {
  ACTIVE: "ACTIVE",
  PAUSED: "PAUSED",
  ENDING: "ENDING",
  PURGED: "PURGED",
} as const;
export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

export const RuleKind = {
  PROFIT_ABSOLUTE: "PROFIT_ABSOLUTE",
  PROFIT_PERCENT: "PROFIT_PERCENT",
  IDLE_TIMEOUT: "IDLE_TIMEOUT",
  REVOKE_ON_SIGHT: "REVOKE_ON_SIGHT",
  CLOSE_EMPTY: "CLOSE_EMPTY",
} as const;
export type RuleKind = (typeof RuleKind)[keyof typeof RuleKind];

export interface EffectiveRules {
  profitAbsolute: { enabled: boolean; thresholdLamports: bigint };
  profitPercent: { enabled: boolean; bps: number };
  idle: { enabled: boolean; minutes: number };
  revokeOnSight: boolean;
  /** Close empty token accounts after the wallet has been quiet this long (avoids rent churn mid-trade). */
  closeEmpty: { enabled: boolean; quietMinutes: number };
}

export const DEFAULT_RULES: EffectiveRules = {
  profitAbsolute: { enabled: true, thresholdLamports: LAMPORTS_PER_SOL },
  profitPercent: { enabled: false, bps: 5_000 },
  idle: { enabled: false, minutes: 24 * 60 },
  revokeOnSight: true,
  closeEmpty: { enabled: true, quietMinutes: 10 },
};

export async function getOrCreateUser(db: Db, args: { telegramId: string; chatId: string; username?: string | null }): Promise<User> {
  const existing = await db.user.findUnique({ where: { telegramId: args.telegramId } });
  if (existing) {
    if (existing.chatId !== args.chatId || (args.username ?? null) !== existing.username) {
      return db.user.update({ where: { id: existing.id }, data: { chatId: args.chatId, username: args.username ?? null } });
    }
    return existing;
  }
  return db.user.create({
    data: { telegramId: args.telegramId, chatId: args.chatId, username: args.username ?? null, keySalt: newUserSalt() },
  });
}

export function findUserByTelegramId(db: Db, telegramId: string): Promise<User | null> {
  return db.user.findUnique({ where: { telegramId } });
}

export function listSessions(db: Db, userId: string, opts: { includePurged?: boolean } = {}): Promise<SessionWallet[]> {
  return db.sessionWallet.findMany({
    where: { userId, ...(opts.includePurged ? {} : { status: { not: SessionStatus.PURGED } }) },
    orderBy: { createdAt: "asc" },
  });
}

export function countLiveSessions(db: Db, userId: string): Promise<number> {
  return db.sessionWallet.count({ where: { userId, status: { not: SessionStatus.PURGED } } });
}

export function getSessionForUser(db: Db, userId: string, sessionId: string): Promise<SessionWallet | null> {
  return db.sessionWallet.findFirst({ where: { id: sessionId, userId } });
}

/** Resolves "alpha", a session id, or an address prefix to one of the user's live sessions. */
export async function resolveSession(db: Db, userId: string, ref?: string): Promise<SessionWallet | null> {
  const sessions = await listSessions(db, userId);
  if (!ref) return sessions.length === 1 ? sessions[0]! : null;
  const r = ref.toLowerCase();
  return (
    sessions.find((s) => s.id === ref) ??
    sessions.find((s) => s.label.toLowerCase() === r) ??
    sessions.find((s) => s.address.toLowerCase().startsWith(r) && r.length >= 4) ??
    null
  );
}

export function findLiveSessionsByAddresses(db: Db, addresses: string[]): Promise<SessionWallet[]> {
  if (addresses.length === 0) return Promise.resolve([]);
  return db.sessionWallet.findMany({
    where: { address: { in: addresses }, status: { in: [SessionStatus.ACTIVE, SessionStatus.PAUSED, SessionStatus.ENDING] } },
  });
}

/**
 * Effective vault address. A time-locked change is honoured as soon as it is due, even if the
 * cron that tidies the row has not run yet, so sweeps never depend on cron timing.
 */
export function effectiveVaultAddress(vault: ColdVaultConfig | null, now = Date.now()): string | null {
  if (!vault) return null;
  if (vault.pendingAddress && vault.pendingEffectiveAt && vault.pendingEffectiveAt.getTime() <= now) return vault.pendingAddress;
  return vault.address;
}

export function getVault(db: Db, userId: string): Promise<ColdVaultConfig | null> {
  return db.coldVaultConfig.findUnique({ where: { userId } });
}

export async function resolveRules(db: Db, userId: string, sessionId?: string): Promise<EffectiveRules> {
  const rows = await db.sweepTriggerRule.findMany({
    where: { userId, scope: { in: sessionId ? ["default", sessionId] : ["default"] } },
  });
  // Session-scoped rows override user defaults.
  rows.sort((a, b) => (a.scope === "default" ? -1 : 1) - (b.scope === "default" ? -1 : 1));
  const rules: EffectiveRules = structuredClone(DEFAULT_RULES);
  for (const r of rows) {
    switch (r.kind) {
      case RuleKind.PROFIT_ABSOLUTE:
        rules.profitAbsolute = { enabled: r.enabled, thresholdLamports: r.thresholdLamports ?? rules.profitAbsolute.thresholdLamports };
        break;
      case RuleKind.PROFIT_PERCENT:
        rules.profitPercent = { enabled: r.enabled, bps: r.percentBps ?? rules.profitPercent.bps };
        break;
      case RuleKind.IDLE_TIMEOUT:
        rules.idle = { enabled: r.enabled, minutes: r.idleMinutes ?? rules.idle.minutes };
        break;
      case RuleKind.REVOKE_ON_SIGHT:
        rules.revokeOnSight = r.enabled;
        break;
      case RuleKind.CLOSE_EMPTY:
        rules.closeEmpty = { enabled: r.enabled, quietMinutes: r.idleMinutes ?? rules.closeEmpty.quietMinutes };
        break;
    }
  }
  return rules;
}

export function upsertRule(
  db: Db,
  args: { userId: string; scope?: string; kind: RuleKind; enabled: boolean; thresholdLamports?: bigint | null; percentBps?: number | null; idleMinutes?: number | null },
): Promise<SweepTriggerRule> {
  const scope = args.scope ?? "default";
  const data = {
    enabled: args.enabled,
    ...(args.thresholdLamports !== undefined ? { thresholdLamports: args.thresholdLamports } : {}),
    ...(args.percentBps !== undefined ? { percentBps: args.percentBps } : {}),
    ...(args.idleMinutes !== undefined ? { idleMinutes: args.idleMinutes } : {}),
  };
  return db.sweepTriggerRule.upsert({
    where: { userId_scope_kind: { userId: args.userId, scope, kind: args.kind } },
    create: { userId: args.userId, scope, kind: args.kind, ...data },
    update: data,
  });
}

export interface AuditEntry {
  userId?: string | null;
  sessionId?: string | null;
  action: string;
  status: "OK" | "FAILED" | "SKIPPED" | "PENDING";
  detail?: Record<string, unknown>;
  signature?: string | null;
  lamports?: bigint | null;
}

/** Audit writes never throw into the caller: losing a log line must not abort a sweep. */
export async function audit(db: Db, entry: AuditEntry): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        userId: entry.userId ?? null,
        sessionId: entry.sessionId ?? null,
        action: entry.action,
        status: entry.status,
        detail: stringifyJson(entry.detail ?? {}).slice(0, 8_000),
        signature: entry.signature ?? null,
        lamports: entry.lamports ?? null,
      },
    });
  } catch (err) {
    log("error", "audit write failed", { action: entry.action, err: String(err) });
  }
}

export function recentAudit(db: Db, userId: string, take = 10) {
  return db.auditLog.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take });
}

// ---- referrals ----------------------------------------------------------------------------------

const CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
/** How long after first contact a user can still be attributed to a referrer. */
const REFERRAL_ATTACH_WINDOW_MS = 60 * 60_000;

function newReferralCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

export async function ensureReferralCode(db: Db, user: User): Promise<string> {
  if (user.referralCode) return user.referralCode;
  for (let i = 0; i < 5; i++) {
    const code = newReferralCode();
    try {
      // Only set if still empty, so concurrent calls can't overwrite each other.
      const res = await db.user.updateMany({ where: { id: user.id, referralCode: null }, data: { referralCode: code } });
      if (res.count === 1) return code;
      const fresh = await db.user.findUnique({ where: { id: user.id }, select: { referralCode: true } });
      if (fresh?.referralCode) return fresh.referralCode;
    } catch {
      // Unique collision: try another code.
    }
  }
  throw new Error("Could not allocate a referral code");
}

/**
 * Attributes `user` to the owner of `code`. Only for brand-new users (or within an hour of first
 * contact, before any fee was paid), never to themselves, never twice, and never in a loop.
 */
export async function attachReferrer(db: Db, user: User, code: string): Promise<User | null> {
  if (user.referredById) return null;
  if (Date.now() - user.createdAt.getTime() > REFERRAL_ATTACH_WINDOW_MS) return null;
  const clean = code.trim().toLowerCase();
  if (!/^[a-z0-9]{6,16}$/.test(clean)) return null;
  const referrer = await db.user.findUnique({ where: { referralCode: clean } });
  if (!referrer || referrer.id === user.id || referrer.referredById === user.id) return null;
  const paid = await db.feeLedger.count({ where: { payerUserId: user.id } });
  if (paid > 0) return null;
  const res = await db.user.updateMany({ where: { id: user.id, referredById: null }, data: { referredById: referrer.id, referredAt: new Date() } });
  if (res.count !== 1) return null;
  await audit(db, { userId: user.id, action: "REFERRED", status: "OK", detail: { referrer: referrer.id } });
  return referrer;
}

export interface ReferralStats {
  code: string;
  invited: number;
  earnedLamports: bigint;
  owedLamports: bigint;
  feesPaidLamports: bigint;
  sweptLamports: bigint;
}

export async function referralStats(db: Db, user: User): Promise<ReferralStats> {
  const code = await ensureReferralCode(db, user);
  const [invited, earned, paid, swept, fresh] = await Promise.all([
    db.user.count({ where: { referredById: user.id } }),
    db.feeLedger.aggregate({ where: { referrerUserId: user.id, referrerStatus: "PAID" }, _sum: { referrerLamports: true } }),
    db.feeLedger.aggregate({ where: { payerUserId: user.id }, _sum: { feeLamports: true } }),
    db.auditLog.aggregate({
      where: { userId: user.id, status: "OK", action: { in: ["FLOSS", "AUTO_FLOSS", "SESSION_END_FLOSS"] } },
      _sum: { lamports: true },
    }),
    db.user.findUnique({ where: { id: user.id }, select: { referralOwedLamports: true } }),
  ]);
  return {
    code,
    invited,
    earnedLamports: earned._sum.referrerLamports ?? 0n,
    owedLamports: fresh?.referralOwedLamports ?? 0n,
    feesPaidLamports: paid._sum.feeLamports ?? 0n,
    sweptLamports: swept._sum.lamports ?? 0n,
  };
}

export function referralLink(botUsername: string, code: string): string {
  return `https://t.me/${botUsername}?start=ref_${code}`;
}
