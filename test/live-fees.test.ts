/**
 * Mainnet dry run with fees (LIVE=1, LIVE_WALLET=<busy wallet>). Proves on real programs that the
 * fee legs land, including a 0-lamport transfer to a referrer wallet that does not exist yet.
 */
import { describe, expect, it } from "vitest";
import { address, createNoopSigner, generateKeyPairSigner } from "@solana/kit";
import { SweepEngine } from "../src/engine/SweepEngine.ts";
import { runtimeConfig } from "../src/config.ts";
import { LayeredCache } from "../src/lib/cache.ts";
import { SolanaRpc } from "../src/solana/rpc.ts";
import { installCaches, MemoryKV, testEnv } from "./helpers.ts";

const live = process.env.LIVE === "1" && Boolean(process.env.LIVE_WALLET);

describe.skipIf(!live)("live mainnet dry-run with fees", () => {
  installCaches();
  const env = testEnv({ CACHE_KV: new MemoryKV() as unknown as KVNamespace, RPC_URL: process.env.LIVE_RPC_URL ?? "https://api.mainnet-beta.solana.com", JITO_ENABLED: "false" });
  const rpc = new SolanaRpc(env, new LayeredCache(env));

  it("fee + referral legs simulate on real programs", async () => {
    const wallet = process.env.LIVE_WALLET!;
    const balance = await rpc.getBalance(wallet);
    const subsetRpc = Object.create(rpc) as SolanaRpc;
    subsetRpc.getTokenAccounts = async () => (await rpc.getTokenAccounts(wallet)).filter((a) => a.amount === 0n && a.state !== "frozen").slice(0, 3);
    const engine = new SweepEngine({ rpc: subsetRpc, jito: null, cfg: { ...runtimeConfig(env), jitoEnabled: false } });
    const vault = (await generateKeyPairSigner()).address;
    const platform = "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"; // any funded account
    const freshReferrer = (await generateKeyPairSigner()).address; // does not exist on chain

    for (const [label, keep, referrerWallet] of [
      ["profit, referrer paid", balance - 5_000_000_000n, platform === freshReferrer ? platform : "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh"],
      ["clean-sized fee, referrer accrues (0-lamport leg to a new account)", balance - 1_000_000n, freshReferrer],
    ] as const) {
      const r = await engine.run(createNoopSigner(address(wallet)), vault, {
        mode: "profit",
        evacuateTokens: false,
        keepLamports: keep,
        minSweepLamports: 0n,
        urgency: "normal",
        dryRun: true,
        fees: { bps: 100, platformWallet: platform, referral: { userId: "u", wallet: referrerWallet, shareBps: 2_500, owedLamports: 0n } },
      });
      console.log(label, JSON.stringify({ sweep: r.sweptLamports.toString(), fee: r.serviceFee, notes: r.notes }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
      expect(r.notes.join(" ")).toMatch(/simulated successfully/);
    }
  }, 120_000);
});
