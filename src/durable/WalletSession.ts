import { DurableObject } from "cloudflare:workers";
import { createNoopSigner, address, type TransactionSigner } from "@solana/kit";
import { runtimeConfig, type RuntimeConfig } from "../config.ts";
import type { Env } from "../env.ts";
import { getDb, type Db } from "../db/client.ts";
import {
  audit,
  effectiveVaultAddress,
  resolveRules,
  SessionStatus,
  type SessionWallet,
  type User,
} from "../db/repo.ts";
import { InsufficientFeeBalanceError, SweepEngine, WalletCompromisedError, type FlossReport, type FlossRequest } from "../engine/SweepEngine.ts";
import { LayeredCache } from "../lib/cache.ts";
import { MasterKeyMissingError } from "../lib/crypto.ts";
import { errorMessage, log } from "../lib/util.ts";
import { JitoClient } from "../solana/jito.ts";
import { SolanaRpc } from "../solana/rpc.ts";
import { KeyPurgedError, loadSigner, purgeSession } from "../services/sessions.ts";
import { sendMd } from "../telegram/notify.ts";
import { prepareFees } from "../services/fees.ts";
import { errorView, flossResultView, fundedView } from "../bot/views.ts";
import type { FlossJob, FlossOutcome } from "../jobs/types.ts";
import { decide, DUST_LAMPORTS } from "../engine/triggers.ts";

/** Fed by the Helius webhook handler. */
export interface ActivityEvent {
  signature: string;
  /** The session wallet paid the fee, i.e. the user (or their bot) is trading right now. */
  outgoing: boolean;
  nativeDelta: number;
  timestamp: number;
}

interface Lease {
  owner: string;
  expiresAt: number;
}

const LEASE_MS = 180_000;
const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;
const AUTO_MIN_INTERVAL_MS = 60_000;
const ERROR_NOTIFY_INTERVAL_MS = 3_600_000;

/**
 * One instance per session wallet (idFromName(address)).
 *
 * Durable Objects run one request at a time only until the first `await` on I/O; fetches to RPC
 * let other calls interleave. `exclusive()` chains every state-changing operation so a manual
 * /floss, a webhook-triggered auto-sweep and a cron check can never build transactions against
 * the same balance concurrently. The persisted lease covers the window where a redeploy replaces
 * the instance mid-run.
 */
export class WalletSession extends DurableObject<Env> {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly instanceId = crypto.randomUUID();

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private cfg(): RuntimeConfig {
    return runtimeConfig(this.env);
  }

  private deps() {
    const cache = new LayeredCache(this.env, { waitUntil: (p) => this.ctx.waitUntil(p) });
    const rpc = new SolanaRpc(this.env, cache);
    const cfg = this.cfg();
    return { rpc, cfg, jito: new JitoClient(this.env, cfg, cache), cache };
  }

  private async acquireLease(): Promise<boolean> {
    const lease = await this.ctx.storage.get<Lease>("lease");
    const now = Date.now();
    if (lease && lease.owner !== this.instanceId && lease.expiresAt > now) return false;
    await this.ctx.storage.put("lease", { owner: this.instanceId, expiresAt: now + LEASE_MS } satisfies Lease);
    return true;
  }

  private async releaseLease(): Promise<void> {
    const lease = await this.ctx.storage.get<Lease>("lease");
    if (lease?.owner === this.instanceId) await this.ctx.storage.delete("lease");
  }

  private async scheduleAt(ts: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    const now = Date.now();
    if (current === null || current < now || ts < current) await this.ctx.storage.setAlarm(Math.max(ts, now + 1_000));
  }

  private async load(db: Db, sessionId: string): Promise<{ session: SessionWallet; user: User } | null> {
    const session = await db.sessionWallet.findUnique({ where: { id: sessionId }, include: { user: true } });
    if (!session) return null;
    const { user, ...rest } = session;
    return { session: rest as SessionWallet, user };
  }

  // ---- RPC: manual / queued floss ------------------------------------------------------------

  async runFloss(job: FlossJob): Promise<FlossOutcome> {
    await this.ctx.storage.put("sessionId", job.sessionId);
    return this.exclusive(async () => {
      const idemKey = `idem:${job.idempotencyKey}`;
      const prior = await this.ctx.storage.get<{ at: number; outcome: FlossOutcome }>(idemKey);
      if (prior) return prior.outcome;

      if (!(await this.acquireLease())) {
        return { ok: false, label: "?", error: "Another floss is still running for this wallet.", errorKind: "busy" };
      }
      try {
        const outcome = await this.executeJob(job);
        // Busy/transient outcomes are not memoised, so the queue retry can actually retry.
        if (outcome.errorKind !== "busy") await this.ctx.storage.put(idemKey, { at: Date.now(), outcome });
        return outcome;
      } finally {
        await this.releaseLease();
      }
    });
  }

  private async executeJob(job: FlossJob): Promise<FlossOutcome> {
    const db = getDb(this.env.DB);
    const loaded = await this.load(db, job.sessionId);
    if (!loaded) return { ok: false, label: "?", error: "Session not found.", errorKind: "failed" };
    const { session, user } = loaded;
    const label = session.label;
    if (session.status === SessionStatus.PURGED) return { ok: false, label, error: "Session already purged.", errorKind: "purged" };

    // Never cached: the vault address decides where funds go.
    const vaultRow = await db.coldVaultConfig.findUnique({ where: { userId: user.id } });
    const vault = effectiveVaultAddress(vaultRow);
    if (!vault) return { ok: false, label, error: "No cold wallet set. Use /set_cold_wallet first.", errorKind: "config" };

    const req: FlossRequest = {
      mode: job.mode,
      evacuateTokens: job.evacuateTokens,
      keepLamports: session.workingFloatLamports,
      minSweepLamports: 0n,
      urgency: job.origin === "end" ? "high" : "normal",
      dryRun: job.dryRun,
    };

    try {
      const report = await this.execute(user, session, vault, req);
      const outcome: FlossOutcome = { ok: true, label, report };

      if (!job.dryRun) {
        await db.sessionWallet.update({ where: { id: session.id }, data: { lastSweepAt: new Date() } });
        await audit(db, {
          userId: user.id,
          sessionId: session.id,
          action: job.endSession ? "SESSION_END_FLOSS" : "FLOSS",
          status: report.pending ? "PENDING" : "OK",
          detail: summarize(report, job.origin),
          signature: report.signatures.at(-1) ?? null,
          lamports: report.sweptLamports + report.rentReclaimedLamports + report.unwrappedLamports,
        });
      }

      if (job.endSession && !job.dryRun) {
        const residual = report.residualTokenAccounts.filter((t) => t.amount > 0n);
        const empty = !report.pending && report.balanceAfter === 0n && residual.length === 0;
        if (empty || job.forcePurge) {
          await purgeSession(this.env, db, user, session, job.forcePurge && !empty ? "forced" : "ended empty");
          await this.ctx.storage.deleteAlarm();
          outcome.purged = true;
        } else {
          await db.sessionWallet.update({ where: { id: session.id }, data: { status: SessionStatus.ENDING, endedAt: new Date() } });
          outcome.blockedPurge = true;
        }
      }
      return outcome;
    } catch (err) {
      return this.failure(db, user, session, err, job.origin);
    }
  }

  private async execute(user: User, session: SessionWallet, vault: string, req: FlossRequest): Promise<FlossReport> {
    const { rpc, cfg, jito } = this.deps();
    // Dry runs never decrypt the key: a no-op signer is enough for sigVerify:false simulation.
    const signer: TransactionSigner = req.dryRun
      ? createNoopSigner(address(session.address))
      : await loadSigner(this.env, user, session);

    const fees = await prepareFees(getDb(this.env.DB), cfg, user, { dryRun: req.dryRun });
    let report: FlossReport;
    try {
      report = await new SweepEngine({ rpc, cfg, jito }).run(signer, vault, { ...req, fees: fees.config });
    } catch (err) {
      if (!req.dryRun) await fees.release();
      throw err;
    }
    if (req.dryRun) await fees.release();
    else await fees.settle(report, session.id);
    return report;
  }

  private async failure(db: Db, user: User, session: SessionWallet, err: unknown, origin: string): Promise<FlossOutcome> {
    const message = errorMessage(err);
    let errorKind: FlossOutcome["errorKind"] = "failed";
    if (err instanceof WalletCompromisedError) errorKind = "compromised";
    else if (err instanceof InsufficientFeeBalanceError) errorKind = "funds";
    else if (err instanceof KeyPurgedError) errorKind = "purged";
    else if (err instanceof MasterKeyMissingError) errorKind = "config";

    if (errorKind === "compromised") {
      // Stop automation on a wallet we can no longer move funds from.
      await db.sessionWallet.update({ where: { id: session.id }, data: { status: SessionStatus.PAUSED } });
    }
    await audit(db, { userId: user.id, sessionId: session.id, action: "FLOSS", status: "FAILED", detail: { origin, error: message.slice(0, 500), errorKind } });
    log("warn", "floss failed", { session: session.id, origin, errorKind, err: message });
    return { ok: false, label: session.label, error: message, errorKind };
  }

  // ---- RPC: activity from Helius -------------------------------------------------------------

  async onActivity(sessionId: string, evt: ActivityEvent): Promise<void> {
    await this.ctx.storage.put("sessionId", sessionId);
    const now = Date.now();
    await this.ctx.storage.put("lastActivityAt", now);
    if (evt.outgoing) await this.ctx.storage.put("lastOutgoingAt", now);
    // Evaluate once the trade guard has passed. Repeated activity keeps pushing it out.
    await this.scheduleAt(now + this.cfg().tradeGuardMs + 500);
  }

  // ---- RPC: periodic / alarm evaluation --------------------------------------------------------

  async evaluate(sessionId: string, reason: "cron" | "alarm" | "api"): Promise<{ action: string }> {
    await this.ctx.storage.put("sessionId", sessionId);
    return this.exclusive(() => this.evaluateInner(sessionId, reason));
  }

  override async alarm(): Promise<void> {
    const sessionId = await this.ctx.storage.get<string>("sessionId");
    await this.pruneIdempotency();
    if (!sessionId) return;
    await this.exclusive(() => this.evaluateInner(sessionId, "alarm")).catch((err) =>
      log("error", "alarm evaluation failed", { sessionId, err: errorMessage(err) }),
    );
  }

  private async pruneIdempotency(): Promise<void> {
    const entries = await this.ctx.storage.list<{ at: number }>({ prefix: "idem:" });
    const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
    const stale = [...entries].filter(([, v]) => v.at < cutoff).map(([k]) => k);
    if (stale.length) await this.ctx.storage.delete(stale);
  }

  private async evaluateInner(sessionId: string, reason: string): Promise<{ action: string }> {
    const db = getDb(this.env.DB);
    const loaded = await this.load(db, sessionId);
    if (!loaded) return { action: "missing" };
    const { session, user } = loaded;
    if (session.status !== SessionStatus.ACTIVE || user.paused) return { action: "paused" };

    const cfg = this.cfg();
    const now = Date.now();
    const [lastActivityAt, lastOutgoingAt, lastAutoAt] = await Promise.all([
      this.ctx.storage.get<number>("lastActivityAt"),
      this.ctx.storage.get<number>("lastOutgoingAt"),
      this.ctx.storage.get<number>("lastAutoAt"),
    ]);

    // Trade guard: never sweep while the user's bot is mid-trade.
    if (lastOutgoingAt && now - lastOutgoingAt < cfg.tradeGuardMs) {
      await this.scheduleAt(lastOutgoingAt + cfg.tradeGuardMs + 500);
      return { action: "trade-guard" };
    }
    if (lastAutoAt && now - lastAutoAt < AUTO_MIN_INTERVAL_MS) {
      await this.scheduleAt(lastAutoAt + AUTO_MIN_INTERVAL_MS);
      return { action: "cooldown" };
    }

    const vaultRow = await db.coldVaultConfig.findUnique({ where: { userId: user.id } });
    const vault = effectiveVaultAddress(vaultRow);
    if (!vault) return { action: "no-vault" };
    const rules = await resolveRules(db, user.id, session.id);

    const { rpc } = this.deps();
    const [balance, tokens] = await Promise.all([
      rpc.getBalance(session.address),
      rules.revokeOnSight || rules.closeEmpty.enabled ? rpc.getTokenAccounts(session.address) : Promise.resolve([]),
    ]);
    await db.sessionWallet.update({ where: { id: session.id }, data: { lastCheckedAt: new Date() } });

    // First funding sets the baseline for percentage rules and, if no float was chosen, makes the
    // deposit the float: the stake stays for trading and only gains above it get swept.
    let baseline = session.baselineLamports;
    let float = session.workingFloatLamports;
    if (baseline === null && balance > 0n) {
      baseline = balance;
      const setFloat = float === 0n;
      if (setFloat) float = balance;
      await db.sessionWallet.update({
        where: { id: session.id },
        data: { baselineLamports: balance, ...(setFloat ? { workingFloatLamports: balance } : {}) },
      });
      await sendMd(
        this.env,
        user.chatId,
        fundedView(session.label, balance, float, rules.profitAbsolute.enabled ? rules.profitAbsolute.thresholdLamports : null),
      );
    }

    const quietMs = lastActivityAt ? now - lastActivityAt : Number.POSITIVE_INFINITY;
    const decision = decide({ rules, balance, baseline, float, tokens, quietMs });

    // Plan the next wake-up for time-based rules even when nothing fires now.
    const deadlines: number[] = [];
    if (rules.idle.enabled && lastActivityAt) deadlines.push(lastActivityAt + rules.idle.minutes * 60_000);
    if (rules.closeEmpty.enabled && lastActivityAt && tokens.some((t) => t.amount === 0n)) {
      deadlines.push(lastActivityAt + rules.closeEmpty.quietMinutes * 60_000);
    }
    const future = deadlines.filter((d) => d > now);
    if (future.length) await this.scheduleAt(Math.min(...future));

    if (!decision) return { action: "none" };

    const req: FlossRequest = {
      mode: decision.mode,
      evacuateTokens: false,
      keepLamports: decision.keep,
      minSweepLamports: decision.mode === "profit" ? DUST_LAMPORTS : 0n,
      urgency: decision.mode === "clean" && decision.reason.startsWith("delegate") ? "high" : "normal",
      dryRun: false,
    };

    if (!(await this.acquireLease())) return { action: "busy" };
    await this.ctx.storage.put("lastAutoAt", now);
    try {
      const report = await this.execute(user, session, vault, req);
      await db.sessionWallet.update({ where: { id: session.id }, data: { lastSweepAt: new Date() } });
      await audit(db, {
        userId: user.id,
        sessionId: session.id,
        action: "AUTO_FLOSS",
        status: report.pending ? "PENDING" : "OK",
        detail: { ...summarize(report, "auto"), trigger: decision.reason, via: reason },
        signature: report.signatures.at(-1) ?? null,
        lamports: report.sweptLamports + report.rentReclaimedLamports,
      });
      const didSomething = report.sweptLamports > 0n || report.revoked.length > 0 || report.closed.length > 0;
      if (didSomething) {
        await sendMd(this.env, user.chatId, flossResultView(`${session.label} · auto: ${decision.reason}`, report, cfg.cluster));
      }
      return { action: decision.mode };
    } catch (err) {
      const outcome = await this.failure(db, user, session, err, "auto");
      const lastNotified = (await this.ctx.storage.get<number>("lastErrorNotifiedAt")) ?? 0;
      if (outcome.errorKind === "compromised" || now - lastNotified > ERROR_NOTIFY_INTERVAL_MS) {
        await this.ctx.storage.put("lastErrorNotifiedAt", now);
        await sendMd(this.env, user.chatId, errorView(`${session.label} · auto-floss`, outcome.error ?? "failed"));
      }
      return { action: "error" };
    } finally {
      await this.releaseLease();
    }
  }
}

function summarize(r: FlossReport, origin: string): Record<string, unknown> {
  return {
    origin,
    mode: r.mode,
    via: r.via,
    revoked: r.revoked.length,
    closed: r.closed.length,
    evacuated: r.evacuated.length,
    skipped: r.skipped.length,
    swept: r.sweptLamports,
    rent: r.rentReclaimedLamports,
    fees: r.feesLamports,
    tip: r.tipLamports,
    bundles: r.bundleIds,
    pending: r.pending,
  };
}
