/**
 * Mainnet dry run (LIVE=1). Picks a busy trader wallet from recent Pump.fun activity, then plans and
 * simulates a real floss for it with a no-op signer (sigVerify off). The real SPL Token, Token-2022,
 * ATA and System programs execute every instruction Floss builds against live account state.
 * Nothing is signed or sent.
 */
import { describe, expect, it } from "vitest";
import { address, createNoopSigner, generateKeyPairSigner } from "@solana/kit";
import { SweepEngine } from "../src/engine/SweepEngine.ts";
import { runtimeConfig } from "../src/config.ts";
import { LayeredCache } from "../src/lib/cache.ts";
import { SolanaRpc } from "../src/solana/rpc.ts";
import { installCaches, MemoryKV, testEnv } from "./helpers.ts";

const live = process.env.LIVE === "1";
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

describe.skipIf(!live)("live mainnet dry-run floss", () => {
  installCaches();
  const env = testEnv({ CACHE_KV: new MemoryKV() as unknown as KVNamespace, RPC_URL: process.env.LIVE_RPC_URL ?? "https://api.mainnet-beta.solana.com", JITO_ENABLED: "false" });
  const rpc = new SolanaRpc(env, new LayeredCache(env));

  async function findWallet(): Promise<string> {
    if (process.env.LIVE_WALLET) return process.env.LIVE_WALLET;
    const sigs = await rpc.call<Array<{ signature: string; err: unknown }>>("getSignaturesForAddress", [PUMP, { limit: 25 }]);
    let best: { wallet: string; empties: number } | null = null;
    for (const s of sigs.filter((x) => !x.err).slice(0, 12)) {
      const tx = await rpc.call<{ transaction: { message: { accountKeys: Array<{ pubkey: string; signer: boolean }> } } } | null>("getTransaction", [
        s.signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
      ]);
      const payer = tx?.transaction.message.accountKeys.find((k) => k.signer)?.pubkey;
      if (!payer) continue;
      const accounts = await rpc.getTokenAccounts(payer).catch(() => []);
      const empties = accounts.filter((a) => a.amount === 0n).length;
      if (empties > 0 && (!best || empties > best.empties)) best = { wallet: payer, empties };
      if (best && best.empties >= 5) break;
    }
    if (!best) throw new Error("no candidate wallet with empty token accounts found");
    return best.wallet;
  }

  it("plans and simulates clean + profit + full/evacuate against real programs", async () => {
    const wallet = await findWallet();
    const accounts = await rpc.getTokenAccounts(wallet);
    const balance = await rpc.getBalance(wallet);
    console.log(
      JSON.stringify({
        wallet,
        sol: Number(balance) / 1e9,
        tokenAccounts: accounts.length,
        empty: accounts.filter((a) => a.amount === 0n).length,
        delegated: accounts.filter((a) => a.delegate).length,
        token2022: accounts.filter((a) => a.programId.startsWith("Tokenz")).length,
        withheld: accounts.filter((a) => a.withheldAmount > 0n).length,
      }),
    );

    const signer = createNoopSigner(address(wallet));
    const vault = (await generateKeyPairSigner()).address;
    const engine = new SweepEngine({ rpc, jito: null, cfg: { ...runtimeConfig(env), jitoEnabled: false } });

    // Full mode on a small, mixed subset (public RPCs rate-limit thousands of simulations):
    // classic + Token-2022 balances to evacuate, Token-2022 accounts with withheld fees, and empties.
    const subset = [
      ...accounts.filter((a) => a.amount > 0n && a.programId.startsWith("Tokenkeg") && a.state !== "frozen").slice(0, 2),
      ...accounts.filter((a) => a.withheldAmount > 0n && a.state !== "frozen" && !a.extensions.includes("transferHookAccount")).slice(0, 2),
      ...accounts.filter((a) => a.amount === 0n && a.state !== "frozen").slice(0, 2),
    ];
    const subsetRpc = Object.create(rpc) as SolanaRpc;
    subsetRpc.getTokenAccounts = async () => subset.map((a) => ({ ...a }));
    const subsetEngine = new SweepEngine({ rpc: subsetRpc, jito: null, cfg: { ...runtimeConfig(env), jitoEnabled: false } });

    for (const mode of ["clean", "profit", "full"] as const) {
      const r = await (mode === "full" ? subsetEngine : engine).run(signer, vault, {
        mode,
        evacuateTokens: mode === "full",
        keepLamports: balance / 2n,
        minSweepLamports: 0n,
        urgency: "normal",
        dryRun: true,
      });
      console.log(
        mode,
        JSON.stringify({
          revoke: r.revoked.length,
          close: r.closed.length,
          harvest: r.harvested,
          evacuate: r.evacuated.length,
          skipped: r.skipped.slice(0, 5).map((s) => s.reason),
          sweep: r.sweptLamports.toString(),
          fees: r.feesLamports.toString(),
          notes: r.notes,
        }),
      );
      expect(r.notes.join(" ")).not.toMatch(/Simulation of tx \d+ failed/);
      expect(r.closed.length + r.revoked.length + r.evacuated.length + (r.sweptLamports > 0n ? 1 : 0)).toBeGreaterThan(0);
    }
  }, 180_000);
});
