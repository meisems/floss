import type { Env } from "../env.ts";
import { getDb } from "../db/client.ts";
import { audit, SessionStatus } from "../db/repo.ts";
import { heliusReconcile } from "../services/helius.ts";
import { reencryptOldKeys } from "../services/sessions.ts";
import { sendMd } from "../telegram/notify.ts";
import { code, lines, md } from "../bot/md.ts";
import { errorMessage, log } from "../lib/util.ts";

export const CRON_FAST = "*/2 * * * *";
export const CRON_HOURLY = "17 * * * *";

/** Sessions per fast tick. Each is one Durable Object call (a few RPC reads when nothing fires). */
const POLL_BATCH = 40;
const POLL_STALE_MS = 4 * 60_000;
const AUDIT_RETENTION_DAYS = 180;

async function promotePendingVaults(env: Env): Promise<void> {
  const db = getDb(env.DB);
  const due = await db.coldVaultConfig.findMany({
    where: { pendingAddress: { not: null }, pendingEffectiveAt: { lte: new Date() } },
    include: { user: true },
    take: 100,
  });
  for (const v of due) {
    if (!v.pendingAddress) continue;
    await db.coldVaultConfig.update({
      where: { id: v.id },
      data: { address: v.pendingAddress, pendingAddress: null, pendingEffectiveAt: null },
    });
    await audit(db, { userId: v.userId, action: "COLD_WALLET_ACTIVATED", status: "OK", detail: { from: v.address, to: v.pendingAddress } });
    await sendMd(env, v.user.chatId, lines(md`*VAULT* ${code("[ACTIVE]")}`, "Time lock passed. Sweeps now go to:", code(v.pendingAddress)));
  }
}

/** Fallback for missed webhooks: re-check sessions that have not been evaluated recently. */
async function pollSessions(env: Env): Promise<void> {
  const db = getDb(env.DB);
  const stale = await db.sessionWallet.findMany({
    where: {
      status: SessionStatus.ACTIVE,
      OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(Date.now() - POLL_STALE_MS) } }],
    },
    orderBy: { lastCheckedAt: "asc" },
    take: POLL_BATCH,
    select: { id: true, address: true },
  });
  const results = await Promise.allSettled(
    stale.map((s) => env.WALLET_SESSION.get(env.WALLET_SESSION.idFromName(s.address)).evaluate(s.id, "cron")),
  );
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed) log("warn", "cron evaluations failed", { failed, total: stale.length });
}

async function hourly(env: Env): Promise<void> {
  const db = getDb(env.DB);
  const tasks: Array<[string, () => Promise<unknown>]> = [
    ["helius reconcile", () => heliusReconcile(env, db)],
    ["key rotation", () => reencryptOldKeys(env, db)],
    [
      "audit retention",
      () => db.auditLog.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - AUDIT_RETENTION_DAYS * 86_400_000) } } }),
    ],
  ];
  for (const [name, task] of tasks) {
    try {
      await task();
    } catch (err) {
      log("error", `cron task failed: ${name}`, { err: errorMessage(err) });
    }
  }
}

export async function handleScheduled(controller: ScheduledController, env: Env): Promise<void> {
  if (controller.cron === CRON_HOURLY) {
    await hourly(env);
    return;
  }
  const steps: Array<[string, () => Promise<void>]> = [
    ["vault promotion", () => promotePendingVaults(env)],
    ["session poll", () => pollSessions(env)],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (err) {
      log("error", `cron step failed: ${name}`, { err: errorMessage(err) });
    }
  }
}
