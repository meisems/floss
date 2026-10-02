import { describe, expect, it } from "vitest";
import { feeOn, solveSweepAndFee, splitFee, type FeeConfig } from "../src/engine/fees.ts";

const RENT = 890_880n;

describe("fee math", () => {
  it("1% fee rounds up", () => {
    expect(feeOn(1_000_000_000n, 100)).toBe(10_000_000n);
    expect(feeOn(1n, 100)).toBe(1n);
    expect(feeOn(0n, 100)).toBe(0n);
  });

  it("sweep + fee always equals available and the fee is exactly 1% of what lands", () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return BigInt(seed);
    };
    for (let i = 0; i < 2_000; i++) {
      const available = (rand() * rand()) % 50_000_000_000n;
      const other = i % 3 === 0 ? 0n : rand() % 100_000_000n;
      const { sweep, fee } = solveSweepAndFee(available, other, 100);
      if (sweep > 0n) {
        expect(sweep + fee).toBe(available);
        // Exactly 1%, or 1 lamport over when round-up leaves no exact split.
        expect(fee - feeOn(sweep + other, 100)).toBeGreaterThanOrEqual(0n);
        expect(fee - feeOn(sweep + other, 100)).toBeLessThanOrEqual(1n);
        // Maximal: one more lamport of sweep would not fit with its fee.
        expect(sweep + 1n + feeOn(sweep + 1n + other, 100)).toBeGreaterThan(available);
      }
    }
  });

  it("charges the fee on rent/unwrap value even when nothing is swept", () => {
    expect(solveSweepAndFee(0n, 2_039_280n, 100)).toEqual({ sweep: 0n, fee: 20_393n });
  });
});

describe("referral split", () => {
  const cfg = (owed = 0n): FeeConfig => ({ bps: 100, platformWallet: "P", referral: { userId: "r", wallet: "R", shareBps: 2_500, owedLamports: owed } });

  it("sends 25% of the fee to the referrer and 75% to the platform", () => {
    const s = splitFee(10_000_000n, 1_000_000_000n, cfg(), { platformFunded: true, referrerFunded: true }, RENT);
    expect(s).toMatchObject({ fee: 10_000_000n, platform: 7_500_000n, referrer: 2_500_000n, referrerStatus: "PAID" });
    expect(s.platform + s.referrer).toBe(s.fee);
  });

  it("accrues a share too small to open an unfunded referrer wallet", () => {
    const s = splitFee(100_000n, 10_000_000n, cfg(), { platformFunded: true, referrerFunded: false }, RENT);
    expect(s).toMatchObject({ platform: 100_000n, referrer: 0n, referrerStatus: "ACCRUED", owedAdded: 25_000n });
  });

  it("pays owed amounts later out of the platform's portion, capped at the fee", () => {
    const s = splitFee(10_000_000n, 1_000_000_000n, cfg(4_000_000n), { platformFunded: true, referrerFunded: true }, RENT);
    expect(s).toMatchObject({ referrer: 6_500_000n, platform: 3_500_000n, owedSettled: 4_000_000n });
    const capped = splitFee(1_000_000n, 100_000_000n, cfg(50_000_000n), { platformFunded: true, referrerFunded: true }, RENT);
    expect(capped).toMatchObject({ referrer: 1_000_000n, platform: 0n, owedSettled: 750_000n });
  });

  it("an owed balance big enough can open an unfunded referrer wallet", () => {
    const s = splitFee(100_000n, 10_000_000n, cfg(2_000_000n), { platformFunded: true, referrerFunded: false }, RENT);
    expect(s.referrerStatus).toBe("ACCRUED"); // 100k fee caps payout below rent; still owed
    const big = splitFee(5_000_000n, 500_000_000n, cfg(2_000_000n), { platformFunded: true, referrerFunded: false }, RENT);
    expect(big).toMatchObject({ referrerStatus: "PAID", referrer: 3_250_000n });
  });

  it("waives a platform share the fee wallet can't receive", () => {
    const s = splitFee(10_000n, 1_000_000n, { bps: 100, platformWallet: "P", referral: null }, { platformFunded: false, referrerFunded: false }, RENT);
    expect(s).toMatchObject({ platform: 0n, waived: 10_000n });
  });
});
