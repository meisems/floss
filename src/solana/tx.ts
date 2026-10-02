import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isTransactionMessageWithinSizeLimit,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { CU_COST, LAMPORTS_PER_SIGNATURE } from "../config.ts";
import { sleep } from "../lib/util.ts";
import type { LatestBlockhash, SolanaRpc } from "./rpc.ts";

/** An instruction plus the compute units budgeted for it. */
export interface PlannedIx {
  ix: Instruction;
  cu: number;
  label: string;
}

export interface BuiltTx {
  base64: string;
  signature: string;
  cuLimit: number;
  cuPriceMicroLamports: bigint;
  feeLamports: bigint;
  labels: string[];
  ixCount: number;
}

/** A syntactically valid blockhash used only to measure message size while packing. */
const SIZING_BLOCKHASH = {
  blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k" as Blockhash,
  lastValidBlockHeight: 0n,
};

export function cuLimitFor(ixs: PlannedIx[]): number {
  return ixs.reduce((sum, p) => sum + p.cu, 0) + CU_COST.computeBudget * 2 + CU_COST.safetyMargin;
}

/** Exact fee for a single-signer transaction: base fee + ceil(limit * price / 1e6). */
export function feeFor(cuLimit: number, cuPriceMicroLamports: bigint, signatures = 1): bigint {
  const priority = (BigInt(cuLimit) * cuPriceMicroLamports + 999_999n) / 1_000_000n;
  return LAMPORTS_PER_SIGNATURE * BigInt(signatures) + priority;
}

function buildMessage(
  feePayer: TransactionSigner,
  ixs: Instruction[],
  lifetime: LatestBlockhash,
  cuLimit: number,
  cuPriceMicroLamports: bigint,
) {
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: lifetime.blockhash as Blockhash, lastValidBlockHeight: lifetime.lastValidBlockHeight },
        m,
      ),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getSetComputeUnitLimitInstruction({ units: cuLimit }),
          getSetComputeUnitPriceInstruction({ microLamports: cuPriceMicroLamports }),
          ...ixs,
        ],
        m,
      ),
  );
}

/**
 * Greedy packing of units (groups of instructions that belong together) into as few transactions
 * as fit the 1232-byte limit. `reserve` instructions (tip + sweep transfer) are included in every
 * size check so whichever transaction ends up last can always absorb them.
 */
export function packUnits<T extends { ixs: PlannedIx[]; label: string }>(
  feePayer: TransactionSigner,
  units: T[],
  reserve: Instruction[],
): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  const fits = (candidate: T[]) =>
    isTransactionMessageWithinSizeLimit(
      buildMessage(
        feePayer,
        [...candidate.flatMap((u) => u.ixs.map((p) => p.ix)), ...reserve],
        SIZING_BLOCKHASH,
        1_400_000,
        1_000_000n,
      ),
    );

  for (const unit of units) {
    const next = [...current, unit];
    if (fits(next)) {
      current = next;
      continue;
    }
    if (current.length === 0) throw new Error(`"${unit.label}" does not fit in a transaction on its own`);
    groups.push(current);
    current = [unit];
    if (!fits(current)) throw new Error(`"${unit.label}" does not fit in a transaction on its own`);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

export async function buildTx(
  feePayer: TransactionSigner,
  planned: PlannedIx[],
  lifetime: LatestBlockhash,
  cuPriceMicroLamports: bigint,
): Promise<BuiltTx> {
  const cuLimit = cuLimitFor(planned);
  const message = buildMessage(
    feePayer,
    planned.map((p) => p.ix),
    lifetime,
    cuLimit,
    cuPriceMicroLamports,
  );
  if (!isTransactionMessageWithinSizeLimit(message)) throw new Error("Transaction exceeds size limit after packing");
  // Partial signing lets dry runs use a NoopSigner; real runs carry a KeyPairSigner and come out fully signed.
  const signed = await partiallySignTransactionMessageWithSigners(message);
  const isSigned = Boolean(signed.signatures[feePayer.address]);
  return {
    base64: getBase64EncodedWireTransaction(signed),
    // Dry runs (NoopSigner) produce an unsigned transaction with no signature yet.
    signature: isSigned ? getSignatureFromTransaction(signed) : "",
    cuLimit,
    cuPriceMicroLamports,
    feeLamports: feeFor(cuLimit, cuPriceMicroLamports),
    labels: planned.map((p) => p.label),
    ixCount: planned.length,
  };
}

/** Unsigned wire transaction for simulation-only paths (sigVerify: false). */
export function compileUnsigned(feePayer: TransactionSigner, ixs: Instruction[], lifetime: LatestBlockhash, cuLimit = 1_400_000): string {
  const message = buildMessage(feePayer, ixs, lifetime, cuLimit, 0n);
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

export type ConfirmOutcome =
  | { status: "confirmed"; signatures: string[] }
  | { status: "failed"; signatures: string[]; err: unknown }
  | { status: "expired"; signatures: string[] }
  /** Gave up waiting while the blockhash was still valid. The bundle may still land; do not resend. */
  | { status: "unknown"; signatures: string[] };

/**
 * Polls signature statuses until every signature is confirmed, any fails, or the blockhash expires.
 * Jito bundles are atomic, so "expired" means nothing from the bundle landed and a rebuild is safe.
 */
export async function confirmSignatures(
  rpc: SolanaRpc,
  signatures: string[],
  lastValidBlockHeight: bigint,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<ConfirmOutcome> {
  const deadline = Date.now() + (opts.timeoutMs ?? 75_000);
  const pollMs = opts.pollMs ?? 1_500;
  let polls = 0;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    polls++;
    const statuses = await rpc.getSignatureStatuses(signatures).catch(() => null);
    if (statuses) {
      const failed = statuses.find((s) => s?.err);
      if (failed) return { status: "failed", signatures, err: failed.err };
      const done = statuses.every((s) => s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized"));
      if (done) return { status: "confirmed", signatures };
    }
    // Checking block height every few polls bounds RPC usage while catching expiry promptly.
    if (polls % 3 === 0) {
      const height = await rpc.getBlockHeight().catch(() => null);
      if (height !== null && height > lastValidBlockHeight) {
        // One last look: a bundle can land in the final valid slot.
        const final = await rpc.getSignatureStatuses(signatures).catch(() => null);
        if (final?.every((s) => s && !s.err && s.confirmationStatus !== "processed")) return { status: "confirmed", signatures };
        return { status: "expired", signatures };
      }
    }
  }
  const height = await rpc.getBlockHeight().catch(() => null);
  if (height !== null && height > lastValidBlockHeight) return { status: "expired", signatures };
  return { status: "unknown", signatures };
}
