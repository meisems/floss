import { beforeEach, describe, expect, it } from "vitest";
import {
  generateKeyPairSigner,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type KeyPairSigner,
} from "@solana/kit";
import { SweepEngine, InsufficientFeeBalanceError, WalletCompromisedError, type FlossRequest } from "../src/engine/SweepEngine.ts";
import { runtimeConfig, SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, COMPUTE_BUDGET_PROGRAM } from "../src/config.ts";
import type { ParsedTokenAccount, SolanaRpc } from "../src/solana/rpc.ts";
import type { JitoClient } from "../src/solana/jito.ts";
import { testEnv } from "./helpers.ts";

const RENT_MIN = 890_880n;
const TIP = 10_000n;
const PRIO = 50_000n;
const TIP_ACCOUNT = "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5";
const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";

interface DecodedIx {
  program: string;
  accounts: string[];
  data: Uint8Array;
}

function decodeTx(base64: string): { feePayer: string; ixs: DecodedIx[] } {
  const bytes = new Uint8Array(getBase64Encoder().encode(base64));
  const tx = getTransactionDecoder().decode(bytes);
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (!("instructions" in msg)) throw new Error("unexpected v1 message");
  const keys = msg.staticAccounts as string[];
  return {
    feePayer: keys[0]!,
    ixs: msg.instructions.map((ci) => ({
      program: keys[ci.programAddressIndex]!,
      accounts: (ci.accountIndices ?? []).map((i) => keys[i]!),
      data: new Uint8Array(ci.data ?? []),
    })),
  };
}

/**
 * Tiny bank: applies fees, system transfers, closes, revokes and harvests to in-memory state so
 * the engine's re-planning loop sees the effects of what it sent.
 */
class FakeChain {
  // Jito tip accounts are long-lived and funded on mainnet.
  lamports = new Map<string, bigint>([[TIP_ACCOUNT, 10_000_000n]]);
  tokens: ParsedTokenAccount[] = [];
  sent: Array<{ via: "jito" | "rpc"; txs: DecodedIx[][] }> = [];
  signatures = new Set<string>();
  poison = new Set<string>();
  owner = SYSTEM_PROGRAM;

  balance(addr: string): bigint {
    return this.lamports.get(addr) ?? 0n;
  }

  apply(base64: string): void {
    const { feePayer, ixs } = decodeTx(base64);
    let limit = 200_000n;
    let price = 0n;
    for (const ix of ixs) {
      if (ix.program === COMPUTE_BUDGET_PROGRAM) {
        const v = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
        if (ix.data[0] === 2) limit = BigInt(v.getUint32(1, true));
        if (ix.data[0] === 3) price = v.getBigUint64(1, true);
      }
    }
    const fee = 5_000n + (limit * price + 999_999n) / 1_000_000n;
    this.debit(feePayer, fee);
    for (const ix of ixs) {
      if (ix.program === SYSTEM_PROGRAM && ix.data.length >= 12) {
        const v = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
        if (v.getUint32(0, true) === 2) {
          const amount = v.getBigUint64(4, true);
          this.debit(ix.accounts[0]!, amount);
          const dest = this.balance(ix.accounts[1]!) + amount;
          if (dest > 0n && dest < RENT_MIN) throw new Error(`InsufficientFundsForRent (destination ${ix.accounts[1]}): ${dest}`);
          this.lamports.set(ix.accounts[1]!, dest);
        }
      }
      if (ix.program === TOKEN_PROGRAM || ix.program === TOKEN_2022_PROGRAM) {
        const acct = this.tokens.find((t) => t.pubkey === ix.accounts[0]);
        if (ix.data[0] === 5 && acct) acct.delegate = null;
        if (ix.data[0] === 9 && acct) {
          if (acct.amount !== 0n && !acct.isNative) throw new Error("close with balance");
          if (acct.withheldAmount > 0n) throw new Error("close with withheld fees");
          this.lamports.set(ix.accounts[1]!, this.balance(ix.accounts[1]!) + acct.lamports);
          this.tokens = this.tokens.filter((t) => t !== acct);
        }
        if (ix.data[0] === 26 && ix.data[1] === 4) {
          for (const src of ix.accounts.slice(1)) {
            const t = this.tokens.find((x) => x.pubkey === src);
            if (t) t.withheldAmount = 0n;
          }
        }
      }
    }
    const after = this.balance(feePayer);
    if (after > 0n && after < RENT_MIN) throw new Error(`InsufficientFundsForRent: ${after}`);
  }

  private debit(addr: string, amount: bigint): void {
    const bal = this.balance(addr);
    if (bal < amount) throw new Error(`insufficient lamports: ${addr} has ${bal}, needs ${amount}`);
    this.lamports.set(addr, bal - amount);
  }

  rpc(): SolanaRpc {
    const chain = this;
    return {
      isHelius: false,
      async getAccountOwner(addr: string) {
        return { owner: chain.owner, lamports: chain.balance(addr), executable: false, dataLength: 0 };
      },
      async getBalance(addr: string) {
        return chain.balance(addr);
      },
      async getMultipleBalances(addrs: string[]) {
        return new Map(addrs.map((a) => [a, chain.balance(a)]));
      },
      async getTokenAccounts() {
        return chain.tokens.map((t) => ({ ...t }));
      },
      async getMinimumBalanceForRentExemption() {
        return RENT_MIN;
      },
      async getLatestBlockhash() {
        return { blockhash: BLOCKHASH, lastValidBlockHeight: 1_000n };
      },
      async getPriorityFeeMicroLamports() {
        return PRIO;
      },
      async simulate(base64: string) {
        const { ixs } = decodeTx(base64);
        const touched = ixs.flatMap((i) => i.accounts);
        const bad = touched.find((a) => chain.poison.has(a));
        return bad
          ? { err: { InstructionError: [0, "Custom"] }, logs: ["Program log: Error: Account is frozen"], unitsConsumed: 0, accounts: null, innerInstructions: null }
          : { err: null, logs: [], unitsConsumed: 1_000, accounts: null, innerInstructions: null };
      },
      async sendTransaction(base64: string) {
        chain.apply(base64);
        chain.sent.push({ via: "rpc", txs: [decodeTx(base64).ixs] });
        const sig = `sig${chain.signatures.size}`;
        chain.signatures.add(sig);
        return sig;
      },
      async getSignatureStatuses(sigs: string[]) {
        return sigs.map(() => ({ confirmationStatus: "confirmed" as const, err: null }));
      },
      async getBlockHeight() {
        return 0n;
      },
    } as unknown as SolanaRpc;
  }

  jito(): JitoClient {
    const chain = this;
    return {
      async pickTipAccount() {
        return TIP_ACCOUNT;
      },
      async chooseTip() {
        return TIP;
      },
      async sendBundle(txs: string[]) {
        // Atomic: apply to a snapshot, commit only if every tx succeeds.
        const snapshot = { lamports: new Map(chain.lamports), tokens: chain.tokens.map((t) => ({ ...t })) };
        try {
          for (const t of txs) chain.apply(t);
        } catch (err) {
          chain.lamports = snapshot.lamports;
          chain.tokens = snapshot.tokens;
          throw err;
        }
        chain.sent.push({ via: "jito", txs: txs.map((t) => decodeTx(t).ixs) });
        return `bundle-${chain.sent.length}`;
      },
    } as unknown as JitoClient;
  }
}

function tokenAccount(owner: string, patch: Partial<ParsedTokenAccount> & { pubkey: string; mint: string }): ParsedTokenAccount {
  return {
    programId: TOKEN_PROGRAM,
    lamports: 2_039_280n,
    owner,
    amount: 0n,
    decimals: 6,
    state: "initialized",
    isNative: false,
    delegate: null,
    delegatedAmount: 0n,
    closeAuthority: null,
    withheldAmount: 0n,
    extensions: [],
    ...patch,
  };
}

async function addr(): Promise<string> {
  return (await generateKeyPairSigner()).address;
}

const SOL = 1_000_000_000n;

describe("SweepEngine", () => {
  let signer: KeyPairSigner;
  let vault: string;
  let chain: FakeChain;
  const cfg = runtimeConfig(testEnv());
  const req = (patch: Partial<FlossRequest> = {}): FlossRequest => ({
    mode: "profit",
    evacuateTokens: false,
    keepLamports: 2n * SOL,
    minSweepLamports: 0n,
    urgency: "normal",
    dryRun: false,
    ...patch,
  });

  beforeEach(async () => {
    signer = await generateKeyPairSigner();
    vault = await addr();
    chain = new FakeChain();
  });

  const engine = (jito = true) => new SweepEngine({ rpc: chain.rpc(), jito: jito ? chain.jito() : null, cfg: { ...cfg, jitoEnabled: jito } });

  it("profit mode: one atomic bundle, wallet ends exactly at the float", async () => {
    const w = signer.address;
    chain.lamports.set(w, 3n * SOL + 123_456n);
    chain.tokens = [
      tokenAccount(w, { pubkey: await addr(), mint: await addr() }), // empty -> close
      tokenAccount(w, { pubkey: await addr(), mint: await addr(), amount: 50n, delegate: await addr(), delegatedAmount: 50n }), // revoke
    ];
    const r = await engine().run(signer, vault, req());

    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0]!.via).toBe("jito");
    expect(chain.balance(w)).toBe(2n * SOL);
    expect(r.balanceAfter).toBe(2n * SOL);
    expect(r.revoked).toHaveLength(1);
    expect(r.closed).toHaveLength(1);
    expect(chain.balance(vault)).toBe(r.sweptLamports + 2_039_280n);
    expect(chain.balance(TIP_ACCOUNT)).toBe(10_000_000n + TIP);
    expect(r.sweptLamports + r.feesLamports + r.tipLamports).toBe(SOL + 123_456n);
    expect(chain.tokens.every((t) => t.delegate === null)).toBe(true);
  });

  it("full mode: sweeps to exactly zero and closes wSOL into the vault", async () => {
    const w = signer.address;
    chain.lamports.set(w, 777_777_777n);
    chain.tokens = [tokenAccount(w, { pubkey: await addr(), mint: "So11111111111111111111111111111111111111112", isNative: true, amount: 1_000_000n, lamports: 2_039_280n + 1_000_000n })];
    const r = await engine().run(signer, vault, req({ mode: "full", keepLamports: 0n }));
    expect(chain.balance(w)).toBe(0n);
    expect(r.unwrappedLamports).toBe(1_000_000n);
    expect(r.rentReclaimedLamports).toBe(2_039_280n);
    expect(chain.balance(vault)).toBe(r.sweptLamports + 2_039_280n + 1_000_000n);
  });

  it("harvests Token-2022 withheld fees before closing", async () => {
    const w = signer.address;
    chain.lamports.set(w, SOL);
    const mint = await addr();
    chain.tokens = [tokenAccount(w, { pubkey: await addr(), mint, programId: TOKEN_2022_PROGRAM, withheldAmount: 42n, extensions: ["transferFeeAmount"] })];
    const r = await engine().run(signer, vault, req({ mode: "clean" }));
    expect(r.harvested).toBe(1);
    expect(r.closed).toHaveLength(1);
    expect(chain.tokens).toHaveLength(0);
  });

  it("clean mode never moves SOL unless the remainder would strand below rent", async () => {
    const w = signer.address;
    chain.lamports.set(w, SOL);
    chain.tokens = [tokenAccount(w, { pubkey: await addr(), mint: await addr() })];
    const r = await engine().run(signer, vault, req({ mode: "clean" }));
    expect(r.sweptLamports).toBe(0n);
    expect(chain.balance(w)).toBe(SOL - r.feesLamports - r.tipLamports);

    const chain2 = new FakeChain();
    chain = chain2;
    chain.lamports.set(w, 600_000n);
    chain.tokens = [tokenAccount(w, { pubkey: await addr(), mint: await addr() })];
    const r2 = await engine().run(signer, vault, req({ mode: "clean" }));
    expect(chain.balance(w)).toBe(0n);
    expect(r2.notes.join(" ")).toMatch(/rent/);
  });

  it("skips frozen accounts, foreign close authorities, and accounts that fail simulation", async () => {
    const w = signer.address;
    chain.lamports.set(w, 3n * SOL);
    const poisoned = await addr();
    chain.poison.add(poisoned);
    chain.tokens = [
      tokenAccount(w, { pubkey: await addr(), mint: await addr(), state: "frozen", amount: 10n }),
      tokenAccount(w, { pubkey: await addr(), mint: await addr(), closeAuthority: await addr() }),
      tokenAccount(w, { pubkey: poisoned, mint: await addr() }),
      tokenAccount(w, { pubkey: await addr(), mint: await addr() }),
    ];
    const r = await engine().run(signer, vault, req());
    expect(r.closed).toHaveLength(1);
    const reasons = r.skipped.map((s) => s.reason).join(" | ");
    expect(reasons).toMatch(/frozen/);
    expect(reasons).toMatch(/close authority/);
    expect(reasons).toMatch(/simulation failed/);
    expect(chain.balance(w)).toBe(2n * SOL);
  });

  it("splits many closes across bundles and still lands exactly on the float", async () => {
    const w = signer.address;
    chain.lamports.set(w, 5n * SOL);
    chain.tokens = await Promise.all(Array.from({ length: 120 }, async () => tokenAccount(w, { pubkey: await addr(), mint: await addr() })));
    const r = await engine().run(signer, vault, req());
    expect(chain.tokens).toHaveLength(0);
    expect(chain.sent.length).toBeGreaterThan(1);
    for (const b of chain.sent) expect(b.txs.length).toBeLessThanOrEqual(5);
    expect(r.closed).toHaveLength(120);
    expect(chain.balance(w)).toBe(2n * SOL);
    expect(chain.balance(vault)).toBe(r.sweptLamports + 120n * 2_039_280n);
  }, 60_000);

  it("RPC mode (no Jito) cleans first, then sweeps from a fresh balance", async () => {
    const w = signer.address;
    chain.lamports.set(w, 3n * SOL);
    chain.tokens = [tokenAccount(w, { pubkey: await addr(), mint: await addr() })];
    const r = await engine(false).run(signer, vault, req());
    expect(chain.sent).toHaveLength(2);
    expect(chain.sent.every((s) => s.via === "rpc")).toBe(true);
    expect(chain.balance(w)).toBe(2n * SOL);
    expect(r.tipLamports).toBe(0n);
  });

  it("refuses to run when fees can't be paid", async () => {
    const w = signer.address;
    chain.lamports.set(w, 1_000n);
    chain.tokens = [tokenAccount(w, { pubkey: await addr(), mint: await addr() })];
    await expect(engine().run(signer, vault, req({ mode: "clean" }))).rejects.toBeInstanceOf(InsufficientFeeBalanceError);
    expect(chain.sent).toHaveLength(0);
  });

  it("detects a wallet whose owner was reassigned by a drainer", async () => {
    chain.owner = "DrainerProgram1111111111111111111111111111111";
    chain.lamports.set(signer.address, SOL);
    await expect(engine().run(signer, vault, req())).rejects.toBeInstanceOf(WalletCompromisedError);
  });

  it("dry run sends nothing", async () => {
    const w = signer.address;
    chain.lamports.set(w, 4n * SOL);
    chain.tokens = [tokenAccount(w, { pubkey: await addr(), mint: await addr() })];
    const r = await engine().run(signer, vault, req({ dryRun: true }));
    expect(chain.sent).toHaveLength(0);
    expect(r.dryRun).toBe(true);
    expect(r.sweptLamports).toBe(4n * SOL - 2n * SOL - r.feesLamports);
    expect(chain.balance(w)).toBe(4n * SOL);
  });

  it("evacuates token balances to vault ATAs in full mode, skipping transfer-hook tokens", async () => {
    const w = signer.address;
    chain.lamports.set(w, SOL);
    chain.tokens = [
      tokenAccount(w, { pubkey: await addr(), mint: await addr(), amount: 1_000n }),
      tokenAccount(w, { pubkey: await addr(), mint: await addr(), amount: 5n, programId: TOKEN_2022_PROGRAM, extensions: ["transferHookAccount"] }),
    ];
    const plan = await new SweepEngine({ rpc: chain.rpc(), jito: chain.jito(), cfg }).plan(signer, vault, chain.tokens, req({ mode: "full", evacuateTokens: true }));
    expect(plan.evacuations).toHaveLength(1);
    expect(plan.evacuations[0]!.ixs.map((i) => i.label.split(" ")[0])).toEqual(["create", "evacuate", "close"]);
    expect(plan.skipped.map((s) => s.reason).join()).toMatch(/transfer hook/);
  });
});

describe("SweepEngine fees + referrals", () => {
  const cfg = runtimeConfig(testEnv());
  const RENT_ACCT = 2_039_280n;

  async function setup(opts: { referrerFunded: boolean }) {
    const signer = await generateKeyPairSigner();
    const vault = await addr();
    const platform = await addr();
    const referrer = await addr();
    const chain = new FakeChain();
    chain.lamports.set(platform, 50_000_000n);
    if (opts.referrerFunded) chain.lamports.set(referrer, 1_000_000_000n);
    return { signer, vault, platform, referrer, chain };
  }

  it("profit floss: 1% of everything reaching the vault, 25% of it to the referrer, wallet ends on the float", async () => {
    const { signer, vault, platform, referrer, chain } = await setup({ referrerFunded: true });
    const w = signer.address;
    chain.lamports.set(w, 5n * SOL);
    chain.tokens = [tokenAccount(w, { pubkey: await addr(), mint: await addr() })];
    const engine = new SweepEngine({ rpc: chain.rpc(), jito: chain.jito(), cfg });
    const r = await engine.run(signer, vault, {
      mode: "profit",
      evacuateTokens: false,
      keepLamports: 2n * SOL,
      minSweepLamports: 0n,
      urgency: "normal",
      dryRun: false,
      fees: { bps: 100, platformWallet: platform, referral: { userId: "u", wallet: referrer, shareBps: 2_500, owedLamports: 0n } },
    });

    const fee = r.serviceFee!;
    const delivered = r.sweptLamports + RENT_ACCT;
    const exact = (delivered * 100n + 9_999n) / 10_000n;
    expect(fee.fee - exact).toBeGreaterThanOrEqual(0n);
    expect(fee.fee - exact).toBeLessThanOrEqual(1n);
    expect(fee.referrer).toBe((fee.fee * 2_500n) / 10_000n);
    expect(fee.platform + fee.referrer).toBe(fee.fee);
    expect(chain.balance(platform)).toBe(50_000_000n + fee.platform);
    expect(chain.balance(referrer)).toBe(1_000_000_000n + fee.referrer);
    expect(chain.balance(vault)).toBe(delivered);
    expect(chain.balance(w)).toBe(2n * SOL);
    expect(r.sweptLamports + r.feesLamports + r.tipLamports + fee.fee).toBe(3n * SOL);
  });

  it("full floss ends at exactly 0 with fees on", async () => {
    const { signer, vault, platform, chain } = await setup({ referrerFunded: false });
    chain.lamports.set(signer.address, 777_777_777n);
    const r = await new SweepEngine({ rpc: chain.rpc(), jito: chain.jito(), cfg }).run(signer, vault, {
      mode: "full",
      evacuateTokens: false,
      keepLamports: 0n,
      minSweepLamports: 0n,
      urgency: "normal",
      dryRun: false,
      fees: { bps: 100, platformWallet: platform, referral: null },
    });
    expect(chain.balance(signer.address)).toBe(0n);
    expect(r.serviceFee!.referrerStatus).toBe("NONE");
    expect(chain.balance(platform)).toBe(50_000_000n + r.serviceFee!.fee);
  });

  it("accrues the referral share when the referrer wallet can't be opened yet, without failing the sweep", async () => {
    const { signer, vault, platform, referrer, chain } = await setup({ referrerFunded: false });
    chain.lamports.set(signer.address, 2n * SOL + 300_000_000n);
    const r = await new SweepEngine({ rpc: chain.rpc(), jito: chain.jito(), cfg }).run(signer, vault, {
      mode: "profit",
      evacuateTokens: false,
      keepLamports: 2n * SOL,
      minSweepLamports: 0n,
      urgency: "normal",
      dryRun: false,
      fees: { bps: 100, platformWallet: platform, referral: { userId: "u", wallet: referrer, shareBps: 2_500, owedLamports: 0n } },
    });
    // ~0.003 SOL fee -> 0.00075 SOL share < rent minimum -> owed, platform takes the whole fee.
    expect(r.serviceFee).toMatchObject({ referrerStatus: "ACCRUED", referrer: 0n });
    expect(r.serviceFee!.owedAdded).toBeGreaterThan(0n);
    expect(chain.balance(referrer)).toBe(0n);
    expect(chain.balance(signer.address)).toBe(2n * SOL);
  });

  it("clean-only floss charges 1% of reclaimed rent", async () => {
    const { signer, vault, platform, chain } = await setup({ referrerFunded: false });
    chain.lamports.set(signer.address, SOL);
    chain.tokens = await Promise.all([1, 2, 3].map(async () => tokenAccount(signer.address, { pubkey: await addr(), mint: await addr() })));
    const r = await new SweepEngine({ rpc: chain.rpc(), jito: chain.jito(), cfg }).run(signer, vault, {
      mode: "clean",
      evacuateTokens: false,
      keepLamports: 0n,
      minSweepLamports: 0n,
      urgency: "normal",
      dryRun: false,
      fees: { bps: 100, platformWallet: platform, referral: null },
    });
    expect(r.serviceFee!.fee).toBe((3n * RENT_ACCT * 100n + 9_999n) / 10_000n);
    expect(chain.balance(vault)).toBe(3n * RENT_ACCT);
  });

  it("never routes fees to the wallet being emptied or the user's own vault", async () => {
    const { signer, vault, chain } = await setup({ referrerFunded: false });
    chain.lamports.set(signer.address, 3n * SOL);
    const r = await new SweepEngine({ rpc: chain.rpc(), jito: chain.jito(), cfg }).run(signer, vault, {
      mode: "profit",
      evacuateTokens: false,
      keepLamports: 2n * SOL,
      minSweepLamports: 0n,
      urgency: "normal",
      dryRun: false,
      fees: { bps: 100, platformWallet: vault, referral: null },
    });
    expect(r.serviceFee).toBeNull();
  });
});
