import type { RuntimeConfig } from "../config.ts";
import type { Db } from "../db/client.ts";
import { effectiveVaultAddress, type User } from "../db/repo.ts";
import type { FeeConfig } from "../engine/fees.ts";
import type { FlossReport } from "../engine/SweepEngine.ts";
import { log } from "../lib/util.ts";

/**
 * Fee lifecycle around one floss:
 *   prepare  build the FeeConfig and atomically reserve whatever the referrer is owed, so two
 *            sweeps running for different referees can't both pay the same debt
 *   settle   return unused reservation, add new accruals, write the ledger row
 *   release  undo the reservation when nothing was sent
 */
export interface PreparedFees {
  config: FeeConfig | null;
  settle(report: FlossReport, sessionId: string): Promise<void>;
  release(): Promise<void>;
}

const NOOP: PreparedFees = { config: null, settle: async () => undefined, release: async () => undefined };

export async function prepareFees(db: Db, cfg: RuntimeConfig, user: User, opts: { dryRun: boolean }): Promise<PreparedFees> {
  if (!cfg.feeWallet || cfg.feeBps <= 0) return NOOP;

  let referrerId: string | null = null;
  let referrerWallet: string | null = null;
  let reserved = 0n;

  if (user.referredById) {
    const referrer = await db.user.findUnique({ where: { id: user.referredById }, include: { coldVault: true } });
    if (referrer) {
      referrerId = referrer.id;
      referrerWallet = effectiveVaultAddress(referrer.coldVault);
      const owed = referrer.referralOwedLamports;
      if (!opts.dryRun && referrerWallet && owed > 0n) {
        const res = await db.user.updateMany({
          where: { id: referrer.id, referralOwedLamports: { gte: owed } },
          data: { referralOwedLamports: { decrement: owed } },
        });
        if (res.count === 1) reserved = owed;
      }
    }
  }

  const config: FeeConfig = {
    bps: cfg.feeBps,
    platformWallet: cfg.feeWallet,
    referral: referrerId && referrerWallet ? { userId: referrerId, wallet: referrerWallet, shareBps: cfg.referralShareBps, owedLamports: reserved } : null,
  };

  const adjustOwed = async (delta: bigint) => {
    if (!referrerId || delta === 0n) return;
    await db.user.update({
      where: { id: referrerId },
      data: { referralOwedLamports: delta > 0n ? { increment: delta } : { decrement: -delta } },
    });
  };

  return {
    config,
    async release() {
      await adjustOwed(reserved).catch((err) => log("error", "failed to release referral reservation", { referrerId, reserved, err: String(err) }));
      reserved = 0n;
    },
    async settle(report, sessionId) {
      const split = report.serviceFee;
      try {
        if (!split || split.fee === 0n) {
          await adjustOwed(reserved);
          return;
        }
        let referrerLamports = split.referrer;
        let status = split.referrerStatus;
        let owedDelta = 0n;

        if (config.referral) {
          // Reservation not consumed goes back; new accruals are added.
          owedDelta = reserved - split.owedSettled + split.owedAdded;
        } else if (referrerId) {
          // Referrer has no vault yet: the platform took the whole fee, their share is owed.
          owedDelta = (split.fee * BigInt(cfg.referralShareBps)) / 10_000n;
          referrerLamports = 0n;
          status = owedDelta > 0n ? "ACCRUED" : "NONE";
        }
        await adjustOwed(owedDelta);

        await db.feeLedger.create({
          data: {
            payerUserId: user.id,
            sessionId,
            referrerUserId: referrerId,
            baseLamports: split.base,
            feeLamports: split.fee,
            platformLamports: split.platform,
            referrerLamports,
            referrerStatus: status,
            signature: report.signatures.at(-1) ?? null,
          },
        });
      } catch (err) {
        log("error", "fee settlement failed", { userId: user.id, err: String(err) });
      } finally {
        reserved = 0n;
      }
    },
  };
}
