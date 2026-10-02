
import { runtimeConfig } from "../config.ts";
import type { Env } from "../env.ts";
import { getBotInfo } from "../bot/bot.ts";
import { getDb, type Db } from "../db/client.ts";
import {
  audit,
  effectiveVaultAddress,
  findUserByTelegramId,
  getVault,
  listSessions,
  recentAudit,
  resolveRules,
  RuleKind,
  SessionStatus,
  referralLink,
  referralStats,
  upsertRule,
  type User,
} from "../db/repo.ts";
import { ScanInputError, SimulationGuard } from "../engine/SimulationGuard.ts";
import type { FlossMode } from "../engine/SweepEngine.ts";
import { CACHE_POLICY, LayeredCache } from "../lib/cache.ts";
import { verifyInitData } from "../lib/telegramAuth.ts";
import { errorMessage, parseSol, randomId } from "../lib/util.ts";
import { SolanaRpc } from "../solana/rpc.ts";
import type { FlossJob } from "../jobs/types.ts";

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const body = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return new Response(body, { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

function corsHeaders(env: Env, req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin || !env.PAGES_URL) return {};
  let allowed: string;
  try {
    allowed = new URL(env.PAGES_URL).origin;
  } catch {
    return {};
  }
  return origin === allowed
    ? { "access-control-allow-origin": allowed, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS", vary: "origin" }
    : {};
}

async function userView(env: Env, db: Db, user: User, cache: LayeredCache) {
  // Display-only snapshot. Sweeps never read this; writes invalidate it.
  const view = await cache.getOrLoad(`user:${user.id}:view`, CACHE_POLICY.userView, async () => {
    const [vault, sessions, rules] = await Promise.all([getVault(db, user.id), listSessions(db, user.id), resolveRules(db, user.id)]);
    return {
      paused: user.paused,
      vault: vault
        ? {
            address: effectiveVaultAddress(vault),
            pendingAddress: vault.pendingAddress,
            pendingEffectiveAt: vault.pendingEffectiveAt?.toISOString() ?? null,
          }
        : null,
      sessions: sessions.map((s) => ({
        id: s.id,
        label: s.label,
        address: s.address,
        status: s.status,
        floatLamports: s.workingFloatLamports.toString(),
        lastSweepAt: s.lastSweepAt?.toISOString() ?? null,
      })),
      rules: {
        profitAbsolute: { enabled: rules.profitAbsolute.enabled, thresholdLamports: rules.profitAbsolute.thresholdLamports.toString() },
        profitPercent: rules.profitPercent,
        idle: rules.idle,
        revokeOnSight: rules.revokeOnSight,
        closeEmpty: rules.closeEmpty,
      },
    };
  });
  // Balances are always live (one RPC call for all sessions).
  const rpc = new SolanaRpc(env, cache);
  const cfg = runtimeConfig(env);
  // Balances and earnings are live; only the settings snapshot above is cached.
  const [balances, stats, botInfo] = await Promise.all([
    rpc.getMultipleBalances(view.value.sessions.map((s) => s.address)).catch(() => new Map<string, bigint>()),
    referralStats(db, user),
    getBotInfo(env, cache).catch(() => null),
  ]);
  return {
    ...view.value,
    sessions: view.value.sessions.map((s) => ({ ...s, balanceLamports: balances.get(s.address)?.toString() ?? null })),
    stats: { sweptLamports: stats.sweptLamports.toString(), feesPaidLamports: stats.feesPaidLamports.toString() },
    referral: {
      code: stats.code,
      link: botInfo ? referralLink(botInfo.username, stats.code) : null,
      invited: stats.invited,
      earnedLamports: stats.earnedLamports.toString(),
      owedLamports: stats.owedLamports.toString(),
    },
    fees: { enabled: Boolean(cfg.feeWallet && cfg.feeBps > 0), bps: cfg.feeBps, referralShareBps: cfg.referralShareBps },
    cachedAgeMs: view.ageMs,
  };
}

/** /api/* — the Telegram Mini App backend. */
export async function handleMiniApp(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const cors = corsHeaders(env, req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const auth = req.headers.get("authorization") ?? "";
  const tgUser = auth.startsWith("tma ") ? await verifyInitData(auth.slice(4), env.TELEGRAM_BOT_TOKEN) : null;
  if (!tgUser) return json({ error: "unauthorized" }, 401, cors);

  const db = getDb(env.DB);
  const user = await findUserByTelegramId(db, String(tgUser.id));
  if (!user) return json({ error: "Open the bot and press Start first." }, 404, cors);

  const cache = new LayeredCache(env, { waitUntil: (p) => exec.waitUntil(p) });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, "");

  try {
    if (req.method === "GET" && path === "/me") return json(await userView(env, db, user, cache), 200, cors);

    if (req.method === "GET" && path === "/audit") {
      const rows = await recentAudit(db, user.id, 25);
      return json(rows.map((r) => ({ action: r.action, status: r.status, createdAt: r.createdAt, lamports: r.lamports, signature: r.signature })), 200, cors);
    }

    if (req.method === "GET" && path === "/scan") {
      const q = url.searchParams.get("q") ?? "";
      if (env.USER_RATE_LIMITER) {
        const { success } = await env.USER_RATE_LIMITER.limit({ key: `scan:${tgUser.id}` });
        if (!success) return json({ error: "Scan limit hit. Try again in a minute." }, 429, cors);
      }
      const sessions = await listSessions(db, user.id);
      const wallet = sessions.find((s) => s.status === SessionStatus.ACTIVE)?.address;
      const guard = new SimulationGuard(new SolanaRpc(env, cache), cache);
      try {
        const res = await guard.scan(q, { fresh: url.searchParams.get("fresh") === "1", wallet });
        return json(res, 200, cors);
      } catch (err) {
        if (err instanceof ScanInputError) return json({ error: err.message }, 400, cors);
        throw err;
      }
    }

    if (req.method === "POST" && path === "/floss") {
      const body = (await req.json()) as { sessionId?: string; mode?: FlossMode; dryRun?: boolean };
      const session = await db.sessionWallet.findFirst({ where: { id: body.sessionId ?? "", userId: user.id } });
      if (!session || session.status === SessionStatus.PURGED) return json({ error: "session not found" }, 404, cors);
      const mode: FlossMode = body.mode === "full" || body.mode === "clean" ? body.mode : "profit";
      const job: FlossJob = {
        type: "floss",
        sessionId: session.id,
        mode,
        evacuateTokens: false,
        dryRun: Boolean(body.dryRun),
        origin: "api",
        idempotencyKey: `api:${randomId()}`,
        chatId: user.chatId,
      };
      await env.JOBS.send(job);
      return json({ queued: true, note: "Result will arrive in your Telegram chat." }, 202, cors);
    }

    if (req.method === "POST" && path === "/rules") {
      const body = (await req.json()) as { kind?: string; enabled?: boolean; value?: string };
      const enabled = Boolean(body.enabled);
      switch (body.kind) {
        case RuleKind.PROFIT_ABSOLUTE: {
          const lamports = body.value ? parseSol(body.value) : null;
          if (enabled && (lamports === null || lamports <= 0n)) return json({ error: "value must be SOL > 0" }, 400, cors);
          await upsertRule(db, { userId: user.id, kind: RuleKind.PROFIT_ABSOLUTE, enabled, ...(lamports ? { thresholdLamports: lamports } : {}) });
          break;
        }
        case RuleKind.PROFIT_PERCENT: {
          const pct = Number(body.value);
          if (enabled && (!Number.isFinite(pct) || pct <= 0 || pct > 10_000)) return json({ error: "value must be a percent > 0" }, 400, cors);
          await upsertRule(db, { userId: user.id, kind: RuleKind.PROFIT_PERCENT, enabled, ...(enabled ? { percentBps: Math.round(pct * 100) } : {}) });
          break;
        }
        case RuleKind.IDLE_TIMEOUT: {
          const minutes = Number(body.value);
          if (enabled && (!Number.isInteger(minutes) || minutes < 10)) return json({ error: "value must be minutes >= 10" }, 400, cors);
          await upsertRule(db, { userId: user.id, kind: RuleKind.IDLE_TIMEOUT, enabled, ...(enabled ? { idleMinutes: minutes } : {}) });
          break;
        }
        case RuleKind.REVOKE_ON_SIGHT:
        case RuleKind.CLOSE_EMPTY:
          await upsertRule(db, { userId: user.id, kind: body.kind, enabled });
          break;
        default:
          return json({ error: "unknown rule" }, 400, cors);
      }
      await audit(db, { userId: user.id, action: "RULE_SET", status: "OK", detail: { via: "miniapp", kind: body.kind, enabled, value: body.value } });
      await cache.invalidate(`user:${user.id}:view`);
      return json(await userView(env, db, user, cache), 200, cors);
    }

    return json({ error: "not found" }, 404, cors);
  } catch (err) {
    return json({ error: `server error: ${errorMessage(err).slice(0, 160)}` }, 500, cors);
  }
}

