import type { EffectiveRules } from "../db/repo.ts";
import type { FlossMode } from "./SweepEngine.ts";
import { maxBig } from "../lib/util.ts";

/** 0.001 SOL: below this an idle sweep or profit sweep is not worth the fee. */
export const DUST_LAMPORTS = 1_000_000n;

/** Pure trigger evaluation. Priority: full (idle) > profit > clean. */
export function decide(args: {
  rules: EffectiveRules;
  balance: bigint;
  baseline: bigint | null;
  float: bigint;
  tokens: Array<{ amount: bigint; delegate: string | null; state: string }>;
  quietMs: number;
}): { mode: FlossMode; keep: bigint; reason: string } | null {
  const { rules, balance, baseline, float, tokens, quietMs } = args;

  if (rules.idle.enabled && quietMs >= rules.idle.minutes * 60_000 && balance > DUST_LAMPORTS) {
    return { mode: "full", keep: 0n, reason: `idle ${rules.idle.minutes}m` };
  }
  if (rules.profitAbsolute.enabled && balance - float >= rules.profitAbsolute.thresholdLamports) {
    return { mode: "profit", keep: float, reason: "profit threshold" };
  }
  if (rules.profitPercent.enabled && baseline !== null && baseline > 0n) {
    if (balance * 10_000n >= baseline * BigInt(10_000 + rules.profitPercent.bps)) {
      return { mode: "profit", keep: maxBig(baseline, float), reason: `+${rules.profitPercent.bps / 100}%` };
    }
  }
  const delegates = tokens.some((t) => t.delegate && t.state !== "frozen");
  if (rules.revokeOnSight && delegates) return { mode: "clean", keep: balance, reason: "delegate found" };
  const empties = tokens.some((t) => t.amount === 0n && t.state !== "frozen");
  if (rules.closeEmpty.enabled && empties && quietMs >= rules.closeEmpty.quietMinutes * 60_000) {
    return { mode: "clean", keep: balance, reason: "empty accounts" };
  }
  return null;
}

