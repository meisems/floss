import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCloseAccountInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getRevokeInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token";
import { AccountRole, address, type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import {
  CU_COST,
  MAX_TXS_PER_BUNDLE,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  type RuntimeConfig,
} from "../config.ts";
import { errorMessage, log, maxBig, sleep } from "../lib/util.ts";
import { JitoError, type JitoClient, type Urgency } from "../solana/jito.ts";
import { feeOn, solveSweepAndFee, splitFee, type FeeConfig, type FeeSplit } from "./fees.ts";
import type { LatestBlockhash, ParsedTokenAccount, SolanaRpc } from "../solana/rpc.ts";
import {
  buildTx,
  compileUnsigned,
  confirmSignatures,
  cuLimitFor,
  feeFor,
  packUnits,
  type BuiltTx,
  type PlannedIx,
} from "../solana/tx.ts";

/**
 *   clean   revoke delegates, harvest Token-2022 withheld fees, close empty token accounts
 *   profit  clean + sweep SOL above the working float to the vault
 *   full    clean + close wSOL + optionally evacuate tokens + sweep every lamport to the vault
 */
export type FlossMode = "clean" | "profit" | "full";

export interface FlossRequest {
  mode: FlossMode;
  /** Full mode only: move non-zero token balances to the vault's ATAs, then close the accounts. */
  evacuateTokens: boolean;
  /** Profit mode: lamports to leave in the wallet (raised to the rent-exempt minimum). */
  keepLamports: bigint;
  /** Profit mode: skip the SOL transfer when the sweepable amount is below this. */
  minSweepLamports: bigint;
  urgency: Urgency;
  /** Plan and simulate only. Nothing is sent. */
  dryRun: boolean;
  /** Service fee + referral split. Null or absent = no fee. */
  fees?: FeeConfig | null;
}

export interface FlossReport {
  mode: FlossMode;
  dryRun: boolean;
  wallet: string;
  vault: string;
  via: "jito" | "rpc" | "none";
  revoked: Array<{ account: string; mint: string; delegate: string }>;
  closed: Array<{ account: string; mint: string; lamports: bigint }>;
  harvested: number;
  evacuated: Array<{ mint: string; amount: bigint; decimals: number }>;
  skipped: Array<{ account: string; mint: string; reason: string }>;
  residualTokenAccounts: Array<{ account: string; mint: string; amount: bigint; decimals: number }>;
  rentReclaimedLamports: bigint;
  unwrappedLamports: bigint;
  sweptLamports: bigint;
  feesLamports: bigint;
  tipLamports: bigint;
  balanceBefore: bigint;
  balanceAfter: bigint | null;
  signatures: string[];
  bundleIds: string[];
  /** True when a submission is still in flight (we stopped waiting but the bundle may land). */
  pending: boolean;
  /** Service fee charged in the final transaction (null when fees are off or nothing was due). */
  serviceFee: FeeSplit | null;
  notes: string[];
}

export class WalletCompromisedError extends Error {
  constructor(
    readonly wallet: string,
    readonly newOwner: string,
  ) {
    super(`Wallet ${wallet} is now owned by program ${newOwner}. System transfers are impossible; treat this wallet as compromised.`);
    this.name = "WalletCompromisedError";
  }
}

export class InsufficientFeeBalanceError extends Error {
  constructor(
    readonly needed: bigint,
    readonly available: bigint,
  ) {
    super(`Wallet needs ${needed} lamports for fees but holds ${available}.`);
    this.name = "InsufficientFeeBalanceError";
  }
}

interface Unit {
  ixs: PlannedIx[];
  label: string;
  kind: "revoke" | "close" | "evacuate";
  account: ParsedTokenAccount;
}

interface Plan {
  evacuations: Unit[];
  cleanups: Unit[];
  skipped: FlossReport["skipped"];
  residual: FlossReport["residualTokenAccounts"];
}

export interface SweepDeps {
  rpc: SolanaRpc;
  jito: JitoClient | null;
  cfg: RuntimeConfig;
}

const MAX_ITERATIONS = 10;
const MAX_BUNDLE_ATTEMPTS = 3;

function is2022(acc: ParsedTokenAccount): boolean {
  return acc.programId === TOKEN_2022_PROGRAM;
}

/** Token-2022 HarvestWithheldTokensToMint (TransferFeeExtension = 26, sub-instruction 4). */
function harvestIx(mint: string, sources: string[]): Instruction {
  return {
    programAddress: address(TOKEN_2022_PROGRAM),
    accounts: [
      { address: address(mint), role: AccountRole.WRITABLE },
      ...sources.map((s) => ({ address: address(s), role: AccountRole.WRITABLE })),
    ],
    data: new Uint8Array([26, 4]),
  };
}

export class SweepEngine {
  constructor(private readonly deps: SweepDeps) {}

  /**
   * Plans what to do with each token account. Pure apart from ATA derivation.
   * Closes always send rent straight to the vault, so they never change the wallet's SOL math.
   */
  async plan(signer: TransactionSigner, vault: string, accounts: ParsedTokenAccount[], req: FlossRequest): Promise<Plan> {
    const wallet = signer.address as string;
    const vaultAddr = address(vault);
    const plan: Plan = { evacuations: [], cleanups: [], skipped: [], residual: [] };

    for (const acc of accounts) {
      const program = address(acc.programId);
      const t22 = is2022(acc);
      const accAddr = address(acc.pubkey);

      if (acc.owner !== wallet) {
        plan.skipped.push({ account: acc.pubkey, mint: acc.mint, reason: "owner mismatch" });
        continue;
      }
      if (acc.state === "frozen") {
        plan.skipped.push({ account: acc.pubkey, mint: acc.mint, reason: "frozen by freeze authority" });
        if (acc.amount > 0n) plan.residual.push({ account: acc.pubkey, mint: acc.mint, amount: acc.amount, decimals: acc.decimals });
        continue;
      }

      const foreignCloser = acc.closeAuthority !== null && acc.closeAuthority !== wallet;
      const closeIxs = (): PlannedIx[] => {
        const ixs: PlannedIx[] = [];
        if (t22 && acc.withheldAmount > 0n) {
          ixs.push({ ix: harvestIx(acc.mint, [acc.pubkey]), cu: CU_COST.harvest2022, label: `harvest ${acc.mint}` });
        }
        ixs.push({
          ix: getCloseAccountInstruction({ account: accAddr, destination: vaultAddr, owner: signer }, { programAddress: program }),
          cu: t22 ? CU_COST.close2022 : CU_COST.close,
          label: `close ${acc.pubkey}`,
        });
        return ixs;
      };
      const revokeUnit = (): Unit => ({
        kind: "revoke",
        account: acc,
        label: `revoke ${acc.pubkey}`,
        ixs: [
          {
            ix: getRevokeInstruction({ source: accAddr, owner: signer }, { programAddress: program }),
            cu: t22 ? CU_COST.revoke2022 : CU_COST.revoke,
            label: `revoke ${acc.pubkey}`,
          },
        ],
      });

      // Empty account (or wSOL in full mode): close it. Closing also drops any delegate.
      const closable = acc.amount === 0n || (acc.isNative && req.mode === "full");
      if (closable) {
        if (foreignCloser) {
          plan.skipped.push({ account: acc.pubkey, mint: acc.mint, reason: `close authority is ${acc.closeAuthority}` });
          if (acc.delegate) plan.cleanups.push(revokeUnit());
          continue;
        }
        plan.cleanups.push({ kind: "close", account: acc, label: `close ${acc.pubkey}`, ixs: closeIxs() });
        continue;
      }

      // Non-empty: evacuate in full mode when allowed, otherwise just strip the delegate.
      const canEvacuate =
        req.mode === "full" &&
        req.evacuateTokens &&
        !acc.isNative &&
        !acc.extensions.includes("transferHookAccount") &&
        !acc.extensions.includes("nonTransferableAccount");

      if (canEvacuate) {
        const [vaultAta] = await findAssociatedTokenPda({
          owner: vaultAddr,
          mint: address(acc.mint),
          tokenProgram: program,
        });
        const ixs: PlannedIx[] = [
          {
            ix: getCreateAssociatedTokenIdempotentInstruction({
              payer: signer,
              ata: vaultAta,
              owner: vaultAddr,
              mint: address(acc.mint),
              tokenProgram: program,
            }),
            cu: t22 ? CU_COST.createAtaIdempotent2022 : CU_COST.createAtaIdempotent,
            label: `create vault ATA ${acc.mint}`,
          },
          {
            ix: getTransferCheckedInstruction(
              {
                source: accAddr,
                mint: address(acc.mint),
                destination: vaultAta,
                authority: signer,
                amount: acc.amount,
                decimals: acc.decimals,
              },
              { programAddress: program },
            ),
            cu: t22 ? CU_COST.transferChecked2022 : CU_COST.transferChecked,
            label: `evacuate ${acc.mint}`,
          },
        ];
        if (!foreignCloser) ixs.push(...closeIxs());
        plan.evacuations.push({ kind: "evacuate", account: acc, label: `evacuate ${acc.mint}`, ixs });
        continue;
      }

      if (acc.delegate) plan.cleanups.push(revokeUnit());
      if (req.mode === "full") {
        const why = acc.extensions.includes("transferHookAccount")
          ? "transfer hook: needs program-specific accounts"
          : acc.extensions.includes("nonTransferableAccount")
            ? "non-transferable token"
            : acc.isNative
              ? "wrapped SOL"
              : "token balance left in place (evacuation off)";
        plan.skipped.push({ account: acc.pubkey, mint: acc.mint, reason: why });
      }
      plan.residual.push({ account: acc.pubkey, mint: acc.mint, amount: acc.amount, decimals: acc.decimals });
    }
    return plan;
  }

  /**
   * Simulates units one by one and drops the ones that fail, so a single bad account (paused mint,
   * frozen destination, odd extension) cannot block the rest of the clean-up.
   */
  private async pruneFailing(signer: TransactionSigner, units: Unit[], lifetime: LatestBlockhash, report: FlossReport): Promise<Unit[]> {
    if (units.length === 0) return units;
    // Cheap path first: one simulation per packed transaction. Only a failing group is bisected
    // down to individual units.
    const suspects: Unit[] = [];
    const kept: Unit[] = [];
    for (const group of packUnits(signer, units, [])) {
      const tx = compileUnsigned(signer, group.flatMap((u) => u.ixs.map((p) => p.ix)), lifetime);
      const sim = await this.deps.rpc.simulate(tx, { sigVerify: false, replaceRecentBlockhash: true });
      if (sim.err) suspects.push(...group);
      else kept.push(...group);
    }
    for (const unit of suspects) {
      const tx = compileUnsigned(signer, unit.ixs.map((p) => p.ix), lifetime);
      const sim = await this.deps.rpc.simulate(tx, { sigVerify: false, replaceRecentBlockhash: true });
      if (sim.err) {
        const reason = sim.logs.find((l) => /error|failed/i.test(l)) ?? JSON.stringify(sim.err);
        report.skipped.push({ account: unit.account.pubkey, mint: unit.account.mint, reason: `simulation failed: ${reason.slice(0, 160)}` });
        if (unit.account.amount > 0n) {
          report.residualTokenAccounts.push({
            account: unit.account.pubkey,
            mint: unit.account.mint,
            amount: unit.account.amount,
            decimals: unit.account.decimals,
          });
        }
      } else kept.push(unit);
    }
    return kept;
  }

  private async simulateAll(txs: BuiltTx[]): Promise<{ ok: true } | { ok: false; index: number; logs: string[]; err: unknown }> {
    for (let i = 0; i < txs.length; i++) {
      const sim = await this.deps.rpc.simulate(txs[i]!.base64, { sigVerify: false, replaceRecentBlockhash: true });
      if (sim.err) return { ok: false, index: i, logs: sim.logs, err: sim.err };
    }
    return { ok: true };
  }

  /** Lamports that closing these units sends straight to the vault (rent + wrapped SOL). */
  private closedValue(units: Unit[]): bigint {
    return units.reduce((sum, u) => (u.ixs.some((p) => p.label.startsWith("close")) ? sum + u.account.lamports : sum), 0n);
  }

  private record(report: FlossReport, units: Unit[]): void {
    for (const u of units) {
      const acc = u.account;
      if (u.kind === "revoke") {
        report.revoked.push({ account: acc.pubkey, mint: acc.mint, delegate: acc.delegate ?? "" });
        continue;
      }
      if (u.kind === "evacuate") report.evacuated.push({ mint: acc.mint, amount: acc.amount, decimals: acc.decimals });
      if (u.ixs.some((p) => p.label.startsWith("harvest"))) report.harvested++;
      if (u.ixs.some((p) => p.label.startsWith("close"))) {
        report.closed.push({ account: acc.pubkey, mint: acc.mint, lamports: acc.lamports });
        if (acc.isNative && u.kind === "close") {
          // wSOL: lamports = rent reserve + wrapped amount. Only the reserve is "rent".
          report.unwrappedLamports += acc.amount;
          report.rentReclaimedLamports += acc.lamports - acc.amount;
        } else report.rentReclaimedLamports += acc.lamports;
      }
    }
  }

  /**
   * Runs a floss end to end. Every iteration re-reads chain state and re-plans, so a retry after
   * an expired bundle or a partially completed multi-bundle run always starts from the truth.
   */
  async run(signer: TransactionSigner, vault: string, req: FlossRequest): Promise<FlossReport> {
    const { rpc, cfg } = this.deps;
    const wallet = signer.address as string;
    let jito = cfg.jitoEnabled && !req.dryRun ? this.deps.jito : null;

    const report: FlossReport = {
      mode: req.mode,
      dryRun: req.dryRun,
      wallet,
      vault,
      via: "none",
      revoked: [],
      closed: [],
      harvested: 0,
      evacuated: [],
      skipped: [],
      residualTokenAccounts: [],
      rentReclaimedLamports: 0n,
      unwrappedLamports: 0n,
      sweptLamports: 0n,
      feesLamports: 0n,
      tipLamports: 0n,
      balanceBefore: 0n,
      balanceAfter: null,
      signatures: [],
      bundleIds: [],
      pending: false,
      serviceFee: null,
      notes: [],
    };

    if (vault === wallet) throw new Error("Vault address equals the session wallet");
    // Fees never route back into the wallet being emptied or into the user's own vault.
    let feeCfg: FeeConfig | null = req.fees ?? null;
    if (feeCfg && (feeCfg.bps <= 0 || feeCfg.platformWallet === wallet || feeCfg.platformWallet === vault)) feeCfg = null;
    if (feeCfg?.referral && (feeCfg.referral.wallet === wallet || feeCfg.referral.wallet === vault || feeCfg.referral.wallet === feeCfg.platformWallet)) {
      feeCfg = { ...feeCfg, referral: null };
    }

    const ownerInfo = await rpc.getAccountOwner(wallet);
    if (ownerInfo && ownerInfo.owner !== SYSTEM_PROGRAM) throw new WalletCompromisedError(wallet, ownerInfo.owner);
    report.balanceBefore = ownerInfo?.lamports ?? 0n;

    let attempt = 0;
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      // ---- fresh state (never cached) -------------------------------------------------------
      const [balance, accounts, rentMin, lifetime] = await Promise.all([
        rpc.getBalance(wallet),
        rpc.getTokenAccounts(wallet),
        rpc.getMinimumBalanceForRentExemption(0),
        rpc.getLatestBlockhash(),
      ]);

      const plan = await this.plan(signer, vault, accounts, req);
      if (iteration === 0 || req.dryRun) {
        report.skipped = plan.skipped;
        report.residualTokenAccounts = plan.residual;
      }

      let evacuations = plan.evacuations;
      let cleanups = plan.cleanups;
      if (iteration === 0 && evacuations.length + cleanups.length > 0) {
        // Pre-flight every unit once so a single poisoned account can't sink the whole bundle.
        evacuations = await this.pruneFailing(signer, evacuations, lifetime, report);
        cleanups = await this.pruneFailing(signer, cleanups, lifetime, report);
      }

      const priority = await rpc
        .getPriorityFeeMicroLamports([wallet, vault], req.urgency === "high" ? "VeryHigh" : "High")
        .catch(() => 10_000n);
      const cuPrice = priority > cfg.maxPriorityFeeMicroLamports ? cfg.maxPriorityFeeMicroLamports : priority;

      const tipAccount = jito ? address(await jito.pickTipAccount()) : null;
      const reserveIxs: Instruction[] = [
        getTransferSolInstruction({ source: signer, destination: address(vault), amount: 1n }),
        ...(tipAccount ? [getTransferSolInstruction({ source: signer, destination: tipAccount, amount: 1n })] : []),
        ...(feeCfg ? [getTransferSolInstruction({ source: signer, destination: address(feeCfg.platformWallet), amount: 1n })] : []),
        ...(feeCfg?.referral ? [getTransferSolInstruction({ source: signer, destination: address(feeCfg.referral.wallet), amount: 1n })] : []),
      ];

      const evacGroups = packUnits(signer, evacuations, reserveIxs);
      const cleanGroups = packUnits(signer, cleanups, reserveIxs);
      const groups = [...evacGroups, ...cleanGroups];
      const perSend = jito ? MAX_TXS_PER_BUNDLE : 1;

      // Evacuations create ATAs whose rent is not knowable up front, and RPC mode is not atomic,
      // so those land first in their own submission and the loop re-plans from fresh balances.
      // (The final bundle appends sweep + tip to its last tx; packing reserved room for both.)
      const mustPreSend =
        evacGroups.length > 0 ||
        (jito ? groups.length > MAX_TXS_PER_BUNDLE : groups.length > 1 || (groups.length === 1 && req.mode !== "clean"));

      if (mustPreSend && groups.length > 0 && !req.dryRun) {
        const sendGroups = groups.slice(0, perSend);
        const units = sendGroups.flat();
        const txs: BuiltTx[] = [];
        let tip = 0n;
        for (let i = 0; i < sendGroups.length; i++) {
          const g = sendGroups[i]!.flatMap((u) => u.ixs);
          if (jito && tipAccount && i === sendGroups.length - 1) {
            tip = await jito.chooseTip({ urgency: req.urgency, attempt, valueLamports: 0n });
            g.push({ ix: getTransferSolInstruction({ source: signer, destination: tipAccount, amount: tip }), cu: CU_COST.systemTransfer, label: "jito tip" });
          }
          txs.push(await buildTx(signer, g, lifetime, cuPrice));
        }
        const fees = txs.reduce((s, t) => s + t.feeLamports, 0n);
        if (balance < fees + tip) throw new InsufficientFeeBalanceError(fees + tip, balance);
        const remaining = balance - fees - tip;
        if (remaining > 0n && remaining < rentMin) {
          throw new InsufficientFeeBalanceError(fees + tip + rentMin, balance);
        }

        const outcome = await this.submit(txs, jito, report, lifetime);
        if (outcome === "jito-down") {
          jito = null;
          report.notes.push("Jito unavailable; continued over standard RPC (non-atomic, no tip).");
          continue;
        }
        if (outcome === "expired") {
          attempt++;
          if (attempt >= MAX_BUNDLE_ATTEMPTS) throw new Error("Submission expired repeatedly; network congested. Try again shortly.");
          continue;
        }
        if (outcome === "pending") return report;
        this.record(report, units);
        report.feesLamports += fees;
        report.tipLamports += tip;
        continue;
      }

      // ---- final submission: remaining clean-up + SOL sweep + service fee ---------------------
      const finalGroups = groups.map((g) => g.flatMap((u) => u.ixs));
      if (finalGroups.length === 0) finalGroups.push([]);
      const lastIdx = finalGroups.length - 1;
      const units = groups.flat();

      // The fee legs are always present when fees are on (zero-lamport when nothing is due), so
      // the CU limit, and therefore the network fee, is known before any amount is decided.
      const feeLegs = feeCfg ? (feeCfg.referral ? 2 : 1) : 0;
      const extraCu = CU_COST.systemTransfer * (1 + (tipAccount ? 1 : 0) + feeLegs);
      // Fees are exact: each tx's priority fee is charged on the CU limit we set, not on usage.
      const fees = finalGroups.reduce(
        (s, g, i) => s + feeFor(cuLimitFor(g) + (i === lastIdx ? extraCu : 0), cuPrice),
        0n,
      );

      let keep: bigint;
      if (req.mode === "full") keep = 0n;
      else if (req.mode === "profit") keep = maxBig(req.keepLamports, rentMin);
      else keep = balance; // clean: SOL stays unless the remainder would strand below rent

      // Dry runs plan everything in one pass, so hold back an upper bound for the vault ATAs that
      // evacuations will create (live runs move tokens first and re-read the real balance).
      if (req.dryRun && evacuations.length > 0 && req.mode !== "clean") {
        const ataRentUpperBound = await rpc.getMinimumBalanceForRentExemption(300);
        keep += BigInt(evacuations.length) * ataRentUpperBound + rentMin;
      }

      const preTip = balance - fees - keep;
      let tip = 0n;
      if (jito && tipAccount) tip = await jito.chooseTip({ urgency: req.urgency, attempt, valueLamports: preTip > 0n ? preTip : 0n });

      // Value reaching the vault without passing through the sweep: rent from closed accounts and
      // unwrapped wSOL (this round's closes plus anything earlier rounds already landed).
      const otherValue = report.rentReclaimedLamports + report.unwrappedLamports + this.closedValue(units);
      const bps = feeCfg?.bps ?? 0;

      const solve = (available: bigint): { sweep: bigint; fee: bigint } => {
        if (!feeCfg) return { sweep: available > 0n ? available : 0n, fee: 0n };
        return solveSweepAndFee(available, otherValue, bps);
      };

      let sweep = 0n;
      let serviceFee = feeCfg ? feeOn(otherValue, bps) : 0n;
      if (req.mode !== "clean") {
        ({ sweep, fee: serviceFee } = solve(balance - fees - tip - keep));
        if (req.mode === "profit" && sweep < req.minSweepLamports) {
          sweep = 0n;
          serviceFee = feeCfg ? feeOn(otherValue, bps) : 0n;
        }
      }

      const hasCleanup = groups.length > 0;
      if (!hasCleanup && sweep === 0n && serviceFee === 0n) {
        report.notes.push(req.mode === "profit" ? "Nothing above the working float to sweep." : "Wallet already clean.");
        report.balanceAfter = balance;
        return report;
      }

      // Never let the fee make a clean-up unaffordable: it is capped at what the wallet can pay.
      const affordable = balance - fees - tip - sweep;
      if (affordable < 0n) throw new InsufficientFeeBalanceError(fees + tip, balance);
      if (serviceFee > affordable) serviceFee = affordable;

      // Rent guard: the wallet must end at exactly 0 or at/above the rent-exempt minimum.
      let after = affordable - serviceFee;
      if (after > 0n && after < rentMin) {
        ({ sweep, fee: serviceFee } = solve(balance - fees - tip));
        after = balance - fees - tip - sweep - serviceFee;
        report.notes.push("Remaining SOL was below rent-exempt minimum; swept it too to avoid a rent failure.");
      }

      // Split the fee. Recipients are checked live: a transfer that would create an account below
      // the rent minimum fails the whole transaction, so such shares accrue instead.
      let split: FeeSplit | null = null;
      if (feeCfg) {
        const probe = [feeCfg.platformWallet, ...(feeCfg.referral ? [feeCfg.referral.wallet] : [])];
        const funded = await rpc.getMultipleBalances(probe);
        split = splitFee(
          serviceFee,
          sweep + otherValue,
          feeCfg,
          {
            platformFunded: (funded.get(feeCfg.platformWallet) ?? 0n) > 0n,
            referrerFunded: feeCfg.referral ? (funded.get(feeCfg.referral.wallet) ?? 0n) > 0n : false,
          },
          rentMin,
        );
        if (split.waived > 0n) {
          // Fee the platform can't receive yet goes to the user's vault rather than staying stranded.
          sweep += split.waived;
          serviceFee -= split.waived;
          split.fee = serviceFee;
          report.notes.push("Service fee waived: fee wallet can't receive this amount yet.");
        }
      }

      const final = finalGroups[lastIdx]!;
      final.push({
        ix: getTransferSolInstruction({ source: signer, destination: address(vault), amount: sweep }),
        cu: CU_COST.systemTransfer,
        label: sweep > 0n ? "sweep" : "noop transfer",
      });
      if (feeCfg && split) {
        final.push({ ix: getTransferSolInstruction({ source: signer, destination: address(feeCfg.platformWallet), amount: split.platform }), cu: CU_COST.systemTransfer, label: "service fee" });
        if (feeCfg.referral) {
          final.push({ ix: getTransferSolInstruction({ source: signer, destination: address(feeCfg.referral.wallet), amount: split.referrer }), cu: CU_COST.systemTransfer, label: "referral reward" });
        }
      }
      if (jito && tipAccount) {
        final.push({ ix: getTransferSolInstruction({ source: signer, destination: tipAccount, amount: tip }), cu: CU_COST.systemTransfer, label: "jito tip" });
      }

      const txs: BuiltTx[] = [];
      for (const g of finalGroups) txs.push(await buildTx(signer, g, lifetime, cuPrice));
      const builtFees = txs.reduce((s, t) => s + t.feeLamports, 0n);
      if (builtFees !== fees) throw new Error(`Fee mismatch: planned ${fees}, built ${builtFees}`);

      if (req.dryRun) {
        const sim = await this.simulateAll(txs);
        if (!sim.ok) report.notes.push(`Simulation of tx ${sim.index + 1} failed: ${sim.logs.slice(-3).join(" | ") || JSON.stringify(sim.err)}`);
        else report.notes.push("Dry run: every transaction simulated successfully.");
        if (evacuations.length > 0) {
          report.notes.push("Live runs move tokens first, then re-read the balance; this preview holds back an estimate for vault ATA rent.");
        }
        this.record(report, units);
        report.sweptLamports = sweep;
        report.feesLamports = fees;
        report.tipLamports = tip;
        report.serviceFee = split;
        report.balanceAfter = after;
        return report;
      }

      const outcome = await this.submit(txs, jito, report, lifetime);
      if (outcome === "jito-down") {
        jito = null;
        report.notes.push("Jito unavailable; continued over standard RPC (non-atomic, no tip).");
        continue;
      }
      if (outcome === "expired") {
        attempt++;
        if (attempt >= MAX_BUNDLE_ATTEMPTS) throw new Error("Submission expired repeatedly; network congested. Try again shortly.");
        continue;
      }
      // A pending bundle carries the fee legs too; report them so the ledger stays complete.
      report.serviceFee = split;
      if (outcome === "pending") return report;

      this.record(report, units);
      report.sweptLamports += sweep;
      report.feesLamports += fees;
      report.tipLamports += tip;
      report.balanceAfter = after;
      return report;
    }
    throw new Error("Floss did not converge; state kept changing between iterations.");
  }

  /** Simulate, send (Jito bundle or RPC), confirm. */
  private async submit(
    txs: BuiltTx[],
    jito: JitoClient | null,
    report: FlossReport,
    lifetime: LatestBlockhash,
  ): Promise<"confirmed" | "expired" | "pending" | "jito-down"> {
    const sim = await this.simulateAll(txs);
    if (!sim.ok) {
      const tail = sim.logs.slice(-4).join(" | ");
      throw new Error(`Pre-flight simulation failed for tx ${sim.index + 1}/${txs.length}: ${tail || JSON.stringify(sim.err)}`);
    }

    const signatures = txs.map((t) => t.signature);
    if (jito) {
      let bundleId: string | null = null;
      for (let i = 0; i < 3 && !bundleId; i++) {
        try {
          bundleId = await jito.sendBundle(txs.map((t) => t.base64));
        } catch (err) {
          log("warn", "sendBundle failed", { err: errorMessage(err), try: i });
          if (err instanceof JitoError && !err.rateLimited && err.status !== undefined && err.status < 500) return "jito-down";
          await sleep(800 * (i + 1));
        }
      }
      if (!bundleId) return "jito-down";
      report.bundleIds.push(bundleId);
      report.via = "jito";
    } else {
      for (const t of txs) await this.deps.rpc.sendTransaction(t.base64, { skipPreflight: true });
      report.via = report.via === "jito" ? "jito" : "rpc";
    }

    const outcome = await confirmSignatures(this.deps.rpc, signatures, lifetime.lastValidBlockHeight);
    if (outcome.status === "confirmed") {
      report.signatures.push(...signatures);
      return "confirmed";
    }
    if (outcome.status === "failed") {
      report.signatures.push(...signatures);
      throw new Error(`Transaction failed on chain: ${JSON.stringify(outcome.err)}`);
    }
    if (outcome.status === "unknown") {
      report.signatures.push(...signatures);
      report.pending = true;
      report.notes.push("Still waiting for confirmation. The bundle may land; it was not resent.");
      return "pending";
    }
    return "expired";
  }
}

/** Exposed for tests. */
export const __test = { harvestIx, is2022 };
export type { Address };
