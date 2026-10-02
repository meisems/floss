/**
 * Read-only checks against a real cluster. Skipped unless LIVE=1.
 *   LIVE=1 npx vitest run test/live.test.ts
 * Optional: LIVE_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
 */
import { describe, expect, it } from "vitest";
import { LayeredCache, resetL0ForTests } from "../src/lib/cache.ts";
import { SimulationGuard } from "../src/engine/SimulationGuard.ts";
import { SolanaRpc } from "../src/solana/rpc.ts";
import { installCaches, MemoryKV, testEnv } from "./helpers.ts";

const live = process.env.LIVE === "1";

describe.skipIf(!live)("live mainnet scans", () => {
  installCaches();
  resetL0ForTests();
  const env = testEnv({ CACHE_KV: new MemoryKV() as unknown as KVNamespace, RPC_URL: process.env.LIVE_RPC_URL ?? "https://api.mainnet-beta.solana.com" });
  const cache = new LayeredCache(env);
  const guard = new SimulationGuard(new SolanaRpc(env, cache), cache);

  it("PYUSD (Token-2022) reports its extensions", async () => {
    const { report } = await guard.scanMint("2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo");
    console.log(JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    expect(report.mint?.program).toBe("token-2022");
    expect(report.findings.map((f) => f.code)).toContain("PERMANENT_DELEGATE");
  }, 60_000);

  it("BONK probes a real holder transfer", async () => {
    const { report } = await guard.scanMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
    console.log(JSON.stringify({ level: report.level, score: report.score, findings: report.findings.map((f) => `${f.severity} ${f.title}`), sim: report.simulation }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    expect(report.mint?.program).toBe("spl-token");
    expect(report.mint?.mintAuthority).toBeNull();
  }, 60_000);

  it("second scan is served from cache", async () => {
    const res = await guard.scanMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
    expect(res.cached).toBe(true);
  });
});
