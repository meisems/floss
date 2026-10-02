import { beforeEach, describe, expect, it } from "vitest";
import { LayeredCache, resetL0ForTests } from "../src/lib/cache.ts";
import { installCaches, MemoryKV, testEnv } from "./helpers.ts";

describe("LayeredCache", () => {
  let kv: MemoryKV;
  let pending: Promise<unknown>[];
  let cache: LayeredCache;

  beforeEach(() => {
    resetL0ForTests();
    installCaches();
    kv = new MemoryKV();
    pending = [];
    cache = new LayeredCache(testEnv({ CACHE_KV: kv as unknown as KVNamespace }), { waitUntil: (p) => pending.push(p) });
  });

  const flush = () => Promise.all(pending.splice(0));

  it("serves L0, then L1, then L2, then origin", async () => {
    let calls = 0;
    const loader = async () => ++calls;
    const policy = { l0Ms: 60_000, l1Seconds: 60, l2Seconds: 120 };

    expect((await cache.getOrLoad("k", policy, loader)).source).toBe("origin");
    await flush();
    expect((await cache.getOrLoad("k", policy, loader)).source).toBe("l0");

    resetL0ForTests();
    expect((await cache.getOrLoad("k", policy, loader)).source).toBe("l1");

    resetL0ForTests();
    installCaches(); // new colo: empty L1
    const r = await cache.getOrLoad("k", policy, loader);
    expect(r.source).toBe("l2");
    expect(r.value).toBe(1);
    expect(calls).toBe(1);
  });

  it("collapses concurrent misses into one origin call", async () => {
    let calls = 0;
    const loader = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return "v";
    };
    const results = await Promise.all(Array.from({ length: 10 }, () => cache.getOrLoad("same", { l0Ms: 1_000 }, loader)));
    expect(calls).toBe(1);
    expect(results.every((r) => r.value === "v")).toBe(true);
  });

  it("never writes negative results to KV and respects KV's 60s minimum", async () => {
    await cache.getOrLoad("missing", { l0Ms: 1_000, l1Seconds: 10, l2Seconds: 300, negativeSeconds: 5 }, async () => null);
    await cache.getOrLoad("short", { l2Seconds: 10 }, async () => "x");
    await flush();
    expect(kv.store.has("v1:mainnet-beta:missing")).toBe(false);
    expect(kv.store.has("v1:mainnet-beta:short")).toBe(true);
  });

  it("bypasses with fresh and invalidates every layer", async () => {
    let n = 0;
    const policy = { l0Ms: 60_000, l1Seconds: 60, l2Seconds: 120 };
    await cache.getOrLoad("x", policy, async () => ++n);
    await flush();
    expect((await cache.getOrLoad("x", policy, async () => ++n, { fresh: true })).value).toBe(2);
    await flush();
    await cache.invalidate("x");
    expect((await cache.getOrLoad("x", policy, async () => ++n)).source).toBe("origin");
  });

  it("round-trips bigints through L1 and L2", async () => {
    const policy = { l1Seconds: 60, l2Seconds: 120 };
    await cache.getOrLoad("big", policy, async () => ({ supply: 10n ** 18n }));
    await flush();
    const r = await cache.getOrLoad("big", policy, async () => ({ supply: 0n }));
    expect(r.value.supply).toBe(10n ** 18n);
  });

  it("degrades to origin when KV throws", async () => {
    const broken = new LayeredCache(
      testEnv({ CACHE_KV: { get: async () => { throw new Error("kv down"); }, put: async () => { throw new Error("kv down"); }, delete: async () => undefined } as unknown as KVNamespace }),
      { waitUntil: (p) => pending.push(p) },
    );
    const r = await broken.getOrLoad("y", { l2Seconds: 120 }, async () => 7);
    await flush();
    expect(r.value).toBe(7);
  });
});
