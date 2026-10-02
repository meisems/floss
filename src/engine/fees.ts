/**
 * Service fee + referral split.
 *
 *   base      SOL value a floss delivers to the user's vault: the SOL sweep, rent from closed
 *             token accounts, and unwrapped wSOL. Token transfers carry no SOL price and are free.
 *   fee       base * FEE_BPS / 10_000, rounded up (default 1%).
 *   referrer  fee * REFERRAL_SHARE_BPS / 10_000, rounded down (default 25% of the fee).
 *
 * Both legs are plain System transfers inside the same transaction as the sweep, so the split is
 * atomic and Floss never holds anyone's funds. Solana refuses to create an account holding less
 * than the rent-exempt minimum, so a share that can't land yet (unfunded recipient + tiny amount)
 * is recorded as owed and paid on a later floss out of the platform's portion.
 */

export interface ReferralTarget {
  userId: string;
  wallet: string;
  shareBps: number;
  /** Previously accrued amount reserved for this run. */
  owedLamports: bigint;
}

export interface FeeConfig {
  bps: number;
  platformWallet: string;
  referral: ReferralTarget | null;
}

export interface FeeSplit {
  base: bigint;
  fee: bigint;
  platform: bigint;
  referrer: bigint;
  referrerStatus: "PAID" | "ACCRUED" | "NONE";
  /** Part of `referrer` that settled earlier accruals. */
  owedSettled: bigint;
  /** New amount owed to the referrer after this floss. */
  owedAdded: bigint;
  /** Platform share skipped because the platform wallet could not receive it. */
  waived: bigint;
}

const BPS = 10_000n;

function ceilDiv(a: bigint, b: bigint): bigint {
  return a <= 0n ? 0n : (a + b - 1n) / b;
}

export function feeOn(base: bigint, bps: number): bigint {
  return ceilDiv(base * BigInt(bps), BPS);
}

/**
 * Splits `available` lamports between the SOL sweep and the fee, where the fee is charged on
 * (sweep + other) and both come out of the same wallet balance:
 *   sweep + fee = available,  fee = ceil((sweep + other) * bps / 10_000)
 * Returns the largest sweep that satisfies this exactly.
 */
export function solveSweepAndFee(available: bigint, other: bigint, bps: number): { sweep: bigint; fee: bigint } {
  if (bps <= 0) return { sweep: available > 0n ? available : 0n, fee: 0n };
  const b = BigInt(bps);
  if (available <= 0n) return { sweep: 0n, fee: feeOn(other, bps) };

  // Largest sweep s with s + ceil((s + other) * bps / 10_000) <= available. Because of the
  // round-up there may be no exact fixed point; the remainder (at most 1 lamport) joins the fee so
  // the wallet still lands exactly on its target.
  const fits = (s: bigint) => s + feeOn(s + other, bps) <= available;
  let sweep = (available * BPS - other * b) / (BPS + b);
  if (sweep < 0n) sweep = 0n;
  while (sweep > 0n && !fits(sweep)) sweep--;
  while (fits(sweep + 1n)) sweep++;
  if (sweep === 0n) return { sweep: 0n, fee: feeOn(other, bps) };
  return { sweep, fee: available - sweep };
}

export function splitFee(
  fee: bigint,
  base: bigint,
  cfg: FeeConfig,
  dest: { platformFunded: boolean; referrerFunded: boolean },
  rentMin: bigint,
): FeeSplit {
  const out: FeeSplit = { base, fee, platform: fee, referrer: 0n, referrerStatus: "NONE", owedSettled: 0n, owedAdded: 0n, waived: 0n };
  const landable = (amount: bigint, funded: boolean) => amount === 0n || funded || amount >= rentMin;

  if (cfg.referral) {
    const share = (fee * BigInt(cfg.referral.shareBps)) / BPS;
    const pay = share + cfg.referral.owedLamports > fee ? fee : share + cfg.referral.owedLamports;
    if (pay > 0n && landable(pay, dest.referrerFunded)) {
      out.referrer = pay;
      out.owedSettled = pay - share;
      out.referrerStatus = "PAID";
    } else if (share > 0n) {
      out.owedAdded = share;
      out.referrerStatus = "ACCRUED";
    } else {
      out.referrerStatus = pay > 0n ? "ACCRUED" : "NONE";
    }
    out.platform = fee - out.referrer;
  }

  if (!landable(out.platform, dest.platformFunded)) {
    out.waived = out.platform;
    out.platform = 0n;
  }
  return out;
}
