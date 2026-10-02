import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from "@solana-program/token";
import {
  address,
  createNoopSigner,
  getAddressDecoder,
  getBase58Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  isAddress,
} from "@solana/kit";
import { COMPUTE_BUDGET_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM } from "../config.ts";
import { CACHE_POLICY, type LayeredCache } from "../lib/cache.ts";
import { errorMessage, fromBase64, toBase64 } from "../lib/util.ts";
import type { ParsedMint, SolanaRpc } from "../solana/rpc.ts";
import { compileUnsigned } from "../solana/tx.ts";

export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface Finding {
  code: string;
  severity: Severity;
  title: string;
  detail: string;
}

export interface BalanceChange {
  account: string;
  kind: "SOL" | "TOKEN";
  mint?: string;
  decimals?: number;
  before: bigint;
  after: bigint;
  delta: bigint;
}

export interface RiskReport {
  kind: "mint" | "transaction";
  target: string;
  score: number;
  level: RiskLevel;
  findings: Finding[];
  mint?: {
    address: string;
    program: "spl-token" | "token-2022";
    decimals: number;
    supply: bigint;
    mintAuthority: string | null;
    freezeAuthority: string | null;
    extensions: string[];
    knownAs?: string;
  };
  simulation?: {
    ran: boolean;
    ok: boolean;
    error?: string;
    unitsConsumed?: number | null;
    logsTail: string[];
    probe?: { sent: bigint; received: bigint; effectiveTaxBps: number };
  };
  balanceChanges?: BalanceChange[];
  programs?: string[];
  wallet?: string;
  generatedAt: number;
}

export interface ScanResult {
  report: RiskReport;
  cached: boolean;
  ageMs: number;
}

export class ScanInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScanInputError";
  }
}

const SEVERITY_WEIGHT: Record<Severity, number> = { info: 0, low: 5, medium: 15, high: 35, critical: 70 };

/** Regulated issuers whose authorities are expected. Severity is lowered, never hidden. */
const KNOWN_MINTS: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC (Circle)",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT (Tether)",
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": "PYUSD (Paxos)",
  So11111111111111111111111111111111111111112: "Wrapped SOL",
};

const KNOWN_PROGRAMS: Record<string, string> = {
  [SYSTEM_PROGRAM]: "System",
  [TOKEN_PROGRAM]: "SPL Token",
  [TOKEN_2022_PROGRAM]: "Token-2022",
  [ASSOCIATED_TOKEN_PROGRAM]: "Associated Token",
  [COMPUTE_BUDGET_PROGRAM]: "Compute Budget",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
  Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo: "Memo v1",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter v6",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM v4",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "Raydium CLMM",
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: "Raydium CPMM",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpools",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora DLMM",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "PumpSwap",
};

/** The worst single finding sets the floor; many small ones can raise it one step at most. */
function levelFor(score: number, findings: Finding[]): RiskLevel {
  if (findings.some((f) => f.severity === "critical") || score >= 90) return "CRITICAL";
  if (findings.some((f) => f.severity === "high") || score >= 60) return "HIGH";
  if (findings.some((f) => f.severity === "medium") || score >= 25) return "MEDIUM";
  return "LOW";
}

function finalize(report: Omit<RiskReport, "score" | "level">): RiskReport {
  const score = Math.min(100, report.findings.reduce((s, f) => s + SEVERITY_WEIGHT[f.severity], 0));
  const order: Severity[] = ["critical", "high", "medium", "low", "info"];
  report.findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  return { ...report, score, level: levelFor(score, report.findings) };
}

function downgrade(sev: Severity): Severity {
  return sev === "critical" ? "medium" : sev === "high" ? "low" : sev === "medium" ? "info" : sev;
}

// ---- SPL token account layout (first 165 bytes, identical for Token-2022) -----------------------
interface DecodedTokenAccount {
  mint: string;
  owner: string;
  amount: bigint;
  delegate: string | null;
  state: number;
  delegatedAmount: bigint;
  closeAuthority: string | null;
}

const addressDecoder = getAddressDecoder();

export function decodeTokenAccount(data: Uint8Array): DecodedTokenAccount | null {
  if (data.length < 165) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pk = (offset: number) => addressDecoder.decode(data.subarray(offset, offset + 32)) as string;
  return {
    mint: pk(0),
    owner: pk(32),
    amount: view.getBigUint64(64, true),
    delegate: view.getUint32(72, true) === 1 ? pk(76) : null,
    state: data[108]!,
    delegatedAmount: view.getBigUint64(121, true),
    closeAuthority: view.getUint32(129, true) === 1 ? pk(133) : null,
  };
}

// ---- input classification ---------------------------------------------------------------------
export type ScanTarget =
  | { type: "mint"; mint: string }
  | { type: "tx"; bytes: Uint8Array }
  | { type: "url"; url: string };

export function classifyInput(raw: string): ScanTarget {
  const input = raw.trim();
  if (!input) throw new ScanInputError("Send a mint address, a base64/base58 transaction, or a Solana Pay / Blink link.");
  if (/^(https?:|solana:|solana-action:)/i.test(input)) return { type: "url", url: input };
  if (isAddress(input)) return { type: "mint", mint: input };

  if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(input)) {
    const bytes = new Uint8Array(getBase58Encoder().encode(input));
    if (bytes.length === 64) throw new ScanInputError("That looks like a transaction signature. Paste the mint, the unsigned transaction, or the link that produced it.");
    if (bytes.length > 100) return { type: "tx", bytes };
  }
  if (/^[A-Za-z0-9+/=]+$/.test(input) && input.length > 100) {
    try {
      return { type: "tx", bytes: fromBase64(input) };
    } catch {
      /* fall through */
    }
  }
  throw new ScanInputError("Could not read that. Send a mint address, a base64/base58 transaction, or a Solana Pay / Blink link.");
}

// ---- URL resolution (Solana Pay transaction requests and Actions/Blinks) -------------------------
const MAX_BODY = 256 * 1024;

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length > MAX_BODY) throw new ScanInputError("Response from link is too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw new ScanInputError("Link did not return JSON.");
  }
}

function normalizeUrl(raw: string): string {
  let url = raw.trim();
  // dial.to and similar wrappers: https://dial.to/?action=solana-action:https://...
  try {
    const u = new URL(url);
    const action = u.searchParams.get("action");
    if (action) url = action;
  } catch {
    /* not a URL yet */
  }
  url = url.replace(/^solana-action:/i, "").replace(/^solana:/i, "");
  url = decodeURIComponent(url);
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new ScanInputError("Only https links are scanned.");
  return parsed.toString();
}

export async function fetchTransactionFromLink(rawUrl: string, account: string): Promise<{ bytes: Uint8Array; url: string; message?: string }> {
  let url = normalizeUrl(rawUrl);
  const headers = { "content-type": "application/json", accept: "application/json" };

  // Actions expose their POST targets via GET metadata. Solana Pay endpoints answer GET with a label.
  try {
    const meta = (await readJson(await fetch(url, { headers, signal: AbortSignal.timeout(8_000) }))) as {
      links?: { actions?: Array<{ href?: string; parameters?: unknown[] }> };
    };
    const first = meta.links?.actions?.find((a) => a.href && !/\{.+\}/.test(a.href));
    if (first?.href) url = new URL(first.href, url).toString();
  } catch {
    /* GET is optional */
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ account }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new ScanInputError(`Link answered HTTP ${res.status}.`);
  const body = (await readJson(res)) as { transaction?: string; message?: string };
  if (typeof body.transaction !== "string") throw new ScanInputError("Link did not return a transaction.");
  return { bytes: fromBase64(body.transaction), url, message: body.message };
}

// ---- the guard --------------------------------------------------------------------------------
export class SimulationGuard {
  constructor(
    private readonly rpc: SolanaRpc,
    private readonly cache: LayeredCache,
  ) {}

  /** Mint risk report. Cached (CACHE_POLICY.riskReport); `fresh` bypasses every layer. */
  async scanMint(mint: string, opts: { fresh?: boolean } = {}): Promise<ScanResult> {
    const res = await this.cache.getOrLoad(`risk:mint:${mint}`, CACHE_POLICY.riskReport, () => this.buildMintReport(mint, opts.fresh ?? false), opts);
    return { report: res.value, cached: res.source !== "origin", ageMs: res.ageMs };
  }

  private mintFindings(m: ParsedMint, findings: Finding[]): void {
    const known = KNOWN_MINTS[m.address];
    const sev = (s: Severity) => (known ? downgrade(s) : s);

    if (m.mintAuthority) {
      findings.push({ code: "MINT_AUTHORITY", severity: sev("high"), title: "Mint authority active", detail: `${m.mintAuthority} can print unlimited supply.` });
    }
    if (m.freezeAuthority) {
      findings.push({ code: "FREEZE_AUTHORITY", severity: sev("high"), title: "Freeze authority active", detail: `${m.freezeAuthority} can freeze your token account. Classic honeypot lever.` });
    }

    for (const ext of m.extensions) {
      const state = (ext.state ?? {}) as Record<string, unknown>;
      switch (ext.extension) {
        case "transferFeeConfig": {
          const newer = state.newerTransferFee as { transferFeeBasisPoints?: number; maximumFee?: number | string } | undefined;
          const older = state.olderTransferFee as { transferFeeBasisPoints?: number } | undefined;
          const bps = Number(newer?.transferFeeBasisPoints ?? 0);
          if (bps > 0) {
            const s: Severity = bps >= 2000 ? "critical" : bps >= 500 ? "high" : "medium";
            findings.push({ code: "TRANSFER_FEE", severity: sev(s), title: `Transfer fee ${(bps / 100).toFixed(2)}%`, detail: `Every transfer withholds ${bps} bps (max ${newer?.maximumFee ?? "?"} base units).` });
          }
          if (older && Number(older.transferFeeBasisPoints ?? 0) !== bps) {
            findings.push({ code: "TRANSFER_FEE_CHANGING", severity: sev("medium"), title: "Transfer fee is changing", detail: `Fee moves from ${older.transferFeeBasisPoints} to ${bps} bps at the next epoch boundary.` });
          }
          if (state.transferFeeConfigAuthority) {
            findings.push({ code: "TRANSFER_FEE_AUTHORITY", severity: sev("high"), title: "Fee can be raised", detail: `${state.transferFeeConfigAuthority} can raise the transfer fee (up to 100%).` });
          }
          break;
        }
        case "permanentDelegate":
          findings.push({ code: "PERMANENT_DELEGATE", severity: sev("critical"), title: "Permanent delegate", detail: `${state.delegate ?? "An authority"} can transfer or burn tokens out of any holder's account at any time.` });
          break;
        case "transferHook":
          findings.push({
            code: "TRANSFER_HOOK",
            severity: sev(state.programId ? "high" : "medium"),
            title: "Transfer hook",
            detail: state.programId ? `Program ${state.programId} runs on every transfer and can block sells.` : `Hook authority ${state.authority ?? "?"} can attach a program later.`,
          });
          break;
        case "nonTransferable":
          findings.push({ code: "NON_TRANSFERABLE", severity: "critical", title: "Non-transferable", detail: "Tokens can never be moved or sold." });
          break;
        case "defaultAccountState":
          if (String(state.accountState).toLowerCase() === "frozen") {
            findings.push({ code: "DEFAULT_FROZEN", severity: sev("high"), title: "New accounts start frozen", detail: "Buyers' token accounts are frozen until the issuer thaws them." });
          }
          break;
        case "pausableConfig":
          findings.push({
            code: "PAUSABLE",
            severity: state.paused ? "critical" : sev("high"),
            title: state.paused ? "Transfers are paused" : "Pausable",
            detail: state.paused ? "The issuer has paused all transfers right now." : `${state.authority ?? "An authority"} can pause all transfers.`,
          });
          break;
        case "mintCloseAuthority":
          findings.push({ code: "MINT_CLOSE_AUTHORITY", severity: sev("medium"), title: "Mint can be closed", detail: `${state.closeAuthority ?? "An authority"} can close the mint once supply is zero.` });
          break;
        case "interestBearingConfig":
        case "scaledUiAmountConfig":
          findings.push({ code: "UI_AMOUNT_MUTABLE", severity: sev("medium"), title: "Displayed amount is adjustable", detail: "Wallet UIs show a scaled balance an authority can change. Raw balances can look bigger than they are." });
          break;
        case "confidentialTransferMint":
          findings.push({ code: "CONFIDENTIAL", severity: "low", title: "Confidential transfers", detail: "Some balances and transfers are encrypted; flows are harder to audit." });
          break;
        case "tokenMetadata":
          if (state.updateAuthority) {
            findings.push({ code: "METADATA_MUTABLE", severity: "low", title: "Metadata mutable", detail: `${state.updateAuthority} can rename or re-image the token.` });
          }
          break;
        default:
          break;
      }
    }
  }

  private async buildMintReport(mint: string, fresh: boolean): Promise<RiskReport> {
    const { value: m } = await this.rpc.getMint(mint, { fresh });
    if (!m) throw new ScanInputError("That address is not a token mint.");

    const findings: Finding[] = [];
    this.mintFindings(m, findings);
    const extensionNames = m.extensions.map((e) => e.extension);
    const knownAs = KNOWN_MINTS[mint];
    if (knownAs) findings.push({ code: "KNOWN_ISSUER", severity: "info", title: `Recognised: ${knownAs}`, detail: "Authorities are expected for this issuer; severities lowered." });

    // Holder concentration.
    let largest: Awaited<ReturnType<SolanaRpc["getTokenLargestAccounts"]>> = [];
    try {
      largest = await this.rpc.getTokenLargestAccounts(mint);
    } catch (err) {
      findings.push({ code: "HOLDERS_UNAVAILABLE", severity: "info", title: "Holder data unavailable", detail: errorMessage(err).slice(0, 120) });
    }
    if (m.supply > 0n && largest.length > 0 && !knownAs) {
      const top1 = Number((largest[0]!.amount * 10_000n) / m.supply) / 100;
      const top10 = Number((largest.slice(0, 10).reduce((s, a) => s + a.amount, 0n) * 10_000n) / m.supply) / 100;
      if (top1 >= 50) findings.push({ code: "CONCENTRATION", severity: "medium", title: `Top holder owns ${top1.toFixed(1)}%`, detail: `Top 10 hold ${top10.toFixed(1)}%. May be a pool or a burn address; check before trusting.` });
      else if (top10 >= 80) findings.push({ code: "CONCENTRATION", severity: "low", title: `Top 10 hold ${top10.toFixed(1)}%`, detail: "Supply is concentrated." });
    }

    const simulation = await this.probeTransfer(m, largest);
    if (simulation.ran && !simulation.ok) {
      findings.push({ code: "TRANSFER_BLOCKED", severity: "critical", title: "Transfer fails in simulation", detail: `A holder-to-new-wallet transfer reverted: ${simulation.error ?? "unknown error"}. Selling may be impossible.` });
    }
    if (simulation.probe) {
      const declaredBps = Number(
        ((m.extensions.find((e) => e.extension === "transferFeeConfig")?.state?.newerTransferFee as { transferFeeBasisPoints?: number } | undefined)
          ?.transferFeeBasisPoints) ?? 0,
      );
      if (simulation.probe.effectiveTaxBps > declaredBps + 5) {
        findings.push({
          code: "HIDDEN_TAX",
          severity: "critical",
          title: `Hidden transfer tax ${(simulation.probe.effectiveTaxBps / 100).toFixed(2)}%`,
          detail: `Receiver got ${simulation.probe.received} of ${simulation.probe.sent} base units; declared fee is ${declaredBps} bps.`,
        });
      }
    }

    return finalize({
      kind: "mint",
      target: mint,
      findings,
      mint: {
        address: mint,
        program: m.programId === TOKEN_2022_PROGRAM ? "token-2022" : "spl-token",
        decimals: m.decimals,
        supply: m.supply,
        mintAuthority: m.mintAuthority,
        freezeAuthority: m.freezeAuthority,
        extensions: extensionNames,
        knownAs,
      },
      simulation,
      generatedAt: Date.now(),
    });
  }

  /**
   * Sell-ability probe: simulate a real holder sending one token to a brand-new wallet, with
   * signature verification off. Catches reverting hooks, pauses, blacklists via freeze, and
   * hidden taxes, without needing anyone's key.
   */
  private async probeTransfer(m: ParsedMint, largest: Array<{ address: string; amount: bigint }>): Promise<NonNullable<RiskReport["simulation"]>> {
    const exts = m.extensions.map((e) => e.extension);
    if (exts.includes("nonTransferable")) return { ran: false, ok: false, error: "non-transferable", logsTail: [] };
    // A hook with no program attached is inert; only a live hook program needs extra accounts.
    const hook = m.extensions.find((e) => e.extension === "transferHook");
    if (hook?.state?.programId) return { ran: false, ok: false, error: "transfer hook needs program-specific accounts; not probed", logsTail: [] };
    if (largest.length === 0) return { ran: false, ok: false, error: m.supply === 0n ? "no supply" : "holder list unavailable", logsTail: [] };

    // Find a holder whose token account is unfrozen and whose owner is a funded system wallet.
    const candidates = largest.filter((a) => a.amount > 0n).slice(0, 12);
    const accounts = await Promise.all(candidates.map((c) => this.rpc.getAccountInfoBase64(c.address).catch(() => null)));
    const decoded = candidates
      .map((c, i) => ({ c, d: accounts[i] ? decodeTokenAccount(accounts[i]!.data) : null }))
      .filter((x): x is { c: (typeof candidates)[number]; d: DecodedTokenAccount } => x.d !== null && x.d.state === 1);
    const owners = await this.rpc.getMultipleOwners(decoded.map((x) => x.d.owner));
    const holder = decoded.find((x) => {
      const o = owners.get(x.d.owner);
      return o && o.owner === SYSTEM_PROGRAM && o.lamports >= 5_000_000n;
    });
    if (!holder) return { ran: false, ok: false, error: "no funded wallet among top holders (likely pools); not probed", logsTail: [] };

    const program = address(m.programId);
    const mintAddr = address(m.address);
    const ownerSigner = createNoopSigner(address(holder.d.owner));
    const receiver = addressDecoder.decode(crypto.getRandomValues(new Uint8Array(32)));
    const [receiverAta] = await findAssociatedTokenPda({ owner: receiver, mint: mintAddr, tokenProgram: program });
    const unit = 10n ** BigInt(m.decimals);
    const sent = holder.d.amount < unit ? holder.d.amount : unit;

    const ixs = [
      getCreateAssociatedTokenIdempotentInstruction({ payer: ownerSigner, ata: receiverAta, owner: receiver, mint: mintAddr, tokenProgram: program }),
      getTransferCheckedInstruction(
        { source: address(holder.c.address), mint: mintAddr, destination: receiverAta, authority: ownerSigner, amount: sent, decimals: m.decimals },
        { programAddress: program },
      ),
    ];
    const lifetime = await this.rpc.getLatestBlockhash();
    const sim = await this.rpc.simulate(compileUnsigned(ownerSigner, ixs, lifetime, 400_000), {
      accounts: [receiverAta],
      sigVerify: false,
      replaceRecentBlockhash: true,
    });
    const logsTail = sim.logs.slice(-4);
    if (sim.err) {
      const reason = sim.logs.find((l) => /error|failed|frozen|paused/i.test(l)) ?? JSON.stringify(sim.err);
      return { ran: true, ok: false, error: reason.slice(0, 200), unitsConsumed: sim.unitsConsumed, logsTail };
    }
    const post = sim.accounts?.[0];
    const received = post ? (decodeTokenAccount(fromBase64(post.data[0]))?.amount ?? 0n) : 0n;
    const effectiveTaxBps = sent > 0n ? Number(((sent - received) * 10_000n) / sent) : 0;
    return { ran: true, ok: true, unitsConsumed: sim.unitsConsumed, logsTail, probe: { sent, received, effectiveTaxBps } };
  }

  /**
   * Transaction scan: decode, simulate against current state with the target wallet's accounts
   * watched, and diff before/after. Effects are judged by state, not by instruction names, so a
   * drainer hiding Approve/SetAuthority inside a CPI is still caught.
   */
  async scanTransaction(bytes: Uint8Array, opts: { wallet?: string; source?: string } = {}): Promise<RiskReport> {
    const findings: Finding[] = [];
    let tx: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>;
    let msg: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;
    try {
      tx = getTransactionDecoder().decode(bytes);
      msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    } catch (err) {
      throw new ScanInputError(`Not a valid Solana transaction (${errorMessage(err).slice(0, 80)}).`);
    }

    // Resolve the full account list, including address lookup tables.
    const accountsList: string[] = [...msg.staticAccounts];
    const lookups = "addressTableLookups" in msg ? (msg.addressTableLookups ?? []) : [];
    const writableLookups: string[] = [];
    const readonlyLookups: string[] = [];
    for (const lu of lookups) {
      const table = await this.rpc.getAddressLookupTable(lu.lookupTableAddress);
      if (!table) {
        findings.push({ code: "ALT_MISSING", severity: "medium", title: "Lookup table missing", detail: `${lu.lookupTableAddress} does not exist; transaction cannot be fully resolved.` });
        continue;
      }
      for (const i of lu.writableIndexes) if (table[i]) writableLookups.push(table[i]!);
      for (const i of lu.readonlyIndexes) if (table[i]) readonlyLookups.push(table[i]!);
    }
    accountsList.push(...writableLookups, ...readonlyLookups);

    const numSigners = msg.header.numSignerAccounts;
    const signers = msg.staticAccounts.slice(0, numSigners) as string[];
    const feePayer = signers[0] ?? "";
    const wallet = opts.wallet && signers.includes(opts.wallet) ? opts.wallet : feePayer;
    if (opts.wallet && !signers.includes(opts.wallet)) {
      findings.push({ code: "WALLET_NOT_SIGNER", severity: "info", title: "Your wallet is not a signer", detail: `Analysed from the fee payer's view (${feePayer}).` });
    }
    if (numSigners > 1) {
      findings.push({ code: "MULTI_SIGNER", severity: "low", title: `${numSigners} signers required`, detail: "Another party also signs this transaction." });
    }

    // Normalise instructions across legacy / v0 / v1 messages.
    type Ix = { program: string; accounts: string[]; data: Uint8Array };
    const ixs: Ix[] = [];
    if ("instructions" in msg) {
      for (const ci of msg.instructions) {
        ixs.push({
          program: accountsList[ci.programAddressIndex] ?? "?",
          accounts: (ci.accountIndices ?? []).map((i) => accountsList[i] ?? "?"),
          data: new Uint8Array(ci.data ?? []),
        });
      }
    } else if ("instructionHeaders" in msg) {
      msg.instructionHeaders.forEach((h, i) => {
        const p = msg.instructionPayloads[i];
        ixs.push({
          program: accountsList[h.programAccountIndex] ?? "?",
          accounts: (p?.instructionAccountIndices ?? []).map((idx) => accountsList[idx] ?? "?"),
          data: new Uint8Array(p?.instructionData ?? []),
        });
      });
    }

    // Static instruction heuristics (top level only; state diff below covers CPIs).
    const programs = [...new Set(ixs.map((i) => i.program))];
    const firstIx = ixs[0];
    if (firstIx && firstIx.program === SYSTEM_PROGRAM && firstIx.data.length >= 4 && new DataView(firstIx.data.buffer, firstIx.data.byteOffset).getUint32(0, true) === 4) {
      findings.push({ code: "DURABLE_NONCE", severity: "high", title: "Durable nonce", detail: "This signature never expires. Whoever holds it can submit it days later, after you have forgotten it." });
    }
    for (const ix of ixs) {
      const d0 = ix.data[0];
      if (ix.program === SYSTEM_PROGRAM && ix.data.length >= 4) {
        const disc = new DataView(ix.data.buffer, ix.data.byteOffset).getUint32(0, true);
        if ((disc === 1 || disc === 10) && ix.accounts[0] === wallet) {
          findings.push({ code: "ASSIGN", severity: "critical", title: "Wallet ownership transfer", detail: "System Assign hands control of your wallet account to another program. Drainer signature." });
        }
      }
      if ((ix.program === TOKEN_PROGRAM || ix.program === TOKEN_2022_PROGRAM) && d0 !== undefined) {
        if (d0 === 4 || d0 === 13) findings.push({ code: "APPROVE_IX", severity: "high", title: "Token approval", detail: `Grants a delegate spending rights over ${ix.accounts[0]}.` });
        if (d0 === 6) findings.push({ code: "SET_AUTHORITY_IX", severity: "critical", title: "SetAuthority", detail: `Changes an authority on ${ix.accounts[0]}. If it's your token account, you lose it.` });
      }
    }
    const unknown = programs.filter((p) => !KNOWN_PROGRAMS[p]);
    if (unknown.length > 0) {
      findings.push({ code: "UNKNOWN_PROGRAMS", severity: "low", title: `${unknown.length} unrecognised program(s)`, detail: unknown.slice(0, 4).join(", ") });
    }

    // Watch list: the wallet plus every token account it owns now.
    const walletTokens = wallet ? await this.rpc.getTokenAccounts(wallet).catch(() => []) : [];
    const watched = walletTokens.slice(0, 60);
    const preLamports = wallet ? await this.rpc.getBalance(wallet).catch(() => 0n) : 0n;

    // Simulate the transaction as provided (signatures not verified, blockhash replaced).
    const sim = await this.rpc.simulate(toBase64(bytes), {
      accounts: [wallet, ...watched.map((t) => t.pubkey)].filter(Boolean),
      sigVerify: false,
      replaceRecentBlockhash: true,
    });
    const logsTail = sim.logs.slice(-6);
    const simulation: NonNullable<RiskReport["simulation"]> = {
      ran: true,
      ok: !sim.err,
      error: sim.err ? (sim.logs.find((l) => /error|failed/i.test(l)) ?? JSON.stringify(sim.err)).slice(0, 200) : undefined,
      unitsConsumed: sim.unitsConsumed,
      logsTail,
    };
    if (sim.err) {
      findings.push({ code: "SIM_FAILED", severity: "medium", title: "Transaction fails in simulation", detail: `${simulation.error}. Effects below may be incomplete.` });
    }

    // CPI-level hints from program logs.
    const logText = sim.logs.join("\n");
    if (/Instruction: Approve/.test(logText) && !findings.some((f) => f.code === "APPROVE_IX")) {
      findings.push({ code: "APPROVE_CPI", severity: "high", title: "Hidden approval", detail: "A program grants a token delegate via CPI." });
    }
    if (/Instruction: SetAuthority/.test(logText) && !findings.some((f) => f.code === "SET_AUTHORITY_IX")) {
      findings.push({ code: "SET_AUTHORITY_CPI", severity: "critical", title: "Hidden SetAuthority", detail: "A program changes a token account authority via CPI." });
    }

    // State diff.
    const balanceChanges: BalanceChange[] = [];
    if (!sim.err && sim.accounts) {
      const walletPost = sim.accounts[0];
      if (walletPost) {
        const after = BigInt(walletPost.lamports);
        balanceChanges.push({ account: wallet, kind: "SOL", before: preLamports, after, delta: after - preLamports });
        if (walletPost.owner !== SYSTEM_PROGRAM) {
          findings.push({ code: "WALLET_REASSIGNED", severity: "critical", title: "Wallet would be reassigned", detail: `After this tx your wallet is owned by ${walletPost.owner}.` });
        }
        const loss = preLamports - after;
        if (loss > 0n) {
          const pct = preLamports > 0n ? Number((loss * 10_000n) / preLamports) / 100 : 0;
          if (pct >= 50) findings.push({ code: "SOL_DRAIN", severity: "critical", title: `Loses ${pct.toFixed(1)}% of SOL`, detail: `${loss} lamports leave the wallet.` });
          else if (loss > 50_000_000n) findings.push({ code: "SOL_OUTFLOW", severity: "high", title: "Large SOL outflow", detail: `${loss} lamports leave the wallet.` });
        }
      }
      watched.forEach((t, i) => {
        const post = sim.accounts?.[i + 1];
        if (!post) {
          if (t.amount > 0n) findings.push({ code: "TOKEN_ACCOUNT_CLOSED", severity: "high", title: "Token account closed", detail: `${t.pubkey} (${t.mint}) is closed with a balance.` });
          return;
        }
        const d = decodeTokenAccount(fromBase64(post.data[0]));
        if (!d) return;
        if (d.amount !== t.amount) {
          balanceChanges.push({ account: t.pubkey, kind: "TOKEN", mint: t.mint, decimals: t.decimals, before: t.amount, after: d.amount, delta: d.amount - t.amount });
          if (d.amount < t.amount && t.amount > 0n && (t.amount - d.amount) * 2n >= t.amount) {
            findings.push({ code: "TOKEN_DRAIN", severity: "high", title: "Token balance mostly leaves", detail: `${t.mint}: ${t.amount} -> ${d.amount}.` });
          }
        }
        if (d.owner !== t.owner) {
          findings.push({ code: "TOKEN_OWNER_CHANGED", severity: "critical", title: "Token account stolen", detail: `${t.pubkey} owner changes to ${d.owner}.` });
        }
        if (d.delegate && (d.delegate !== t.delegate || d.delegatedAmount > t.delegatedAmount)) {
          const full = d.delegatedAmount >= d.amount && d.amount > 0n;
          findings.push({
            code: "DELEGATE_SET",
            severity: full ? "critical" : "high",
            title: "Delegate added",
            detail: `${d.delegate} may move ${d.delegatedAmount} of ${t.mint} without asking you.`,
          });
        }
        if (d.closeAuthority && d.closeAuthority !== wallet && d.closeAuthority !== t.closeAuthority) {
          findings.push({ code: "CLOSE_AUTHORITY_SET", severity: "high", title: "Close authority handed over", detail: `${d.closeAuthority} can close ${t.pubkey}.` });
        }
      });
    }

    return finalize({
      kind: "transaction",
      target: opts.source ?? `${toBase64(bytes).slice(0, 16)}…`,
      findings,
      simulation,
      balanceChanges,
      programs: programs.map((p) => KNOWN_PROGRAMS[p] ?? p),
      wallet,
      generatedAt: Date.now(),
    });
  }

  /** Entry point for /scan_token and the Mini App. */
  async scan(input: string, opts: { fresh?: boolean; wallet?: string } = {}): Promise<ScanResult> {
    const target = classifyInput(input);
    if (target.type === "mint") return this.scanMint(target.mint, opts);
    if (target.type === "tx") return { report: await this.scanTransaction(target.bytes, { wallet: opts.wallet }), cached: false, ageMs: 0 };
    if (!opts.wallet) throw new ScanInputError("Links build a transaction for a specific wallet. Start a session first (/session new) so the scan uses your session wallet, never your vault.");
    const fetched = await fetchTransactionFromLink(target.url, opts.wallet);
    const report = await this.scanTransaction(fetched.bytes, { wallet: opts.wallet, source: fetched.url });
    if (fetched.message) report.findings.push({ code: "LINK_MESSAGE", severity: "info", title: "Link message", detail: fetched.message.slice(0, 200) });
    return { report, cached: false, ageMs: 0 };
  }
}
