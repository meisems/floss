import type { Env } from "../env.ts";
import { log, parseJson, stringifyJson } from "./util.ts";

/**
 * Layered cache.
 *
 *   L0  per-isolate memory      microseconds, lost on isolate eviction, not shared
 *   L1  Cache API (per colo)    ~1 ms, shared by isolates in one data center
 *   L2  Workers KV (global)     eventually consistent (~60 s), minimum TTL 60 s
 *
 * Durable Objects and D1 are sources of truth and are never read through this cache when a value
 * feeds a signing decision (balances, rent, cold-vault address, rules).
 */

export interface CachePolicy {
  /** L0 lifetime in milliseconds. */
  l0Ms?: number;
  /** L1 (Cache API) lifetime in seconds. */
  l1Seconds?: number;
  /** L2 (KV) lifetime in seconds. KV enforces a 60 s minimum, so values below that are raised. */
  l2Seconds?: number;
  /** How long a `null` result (e.g. unknown mint) is remembered, in seconds. Applies to L0 and L1. */
  negativeSeconds?: number;
}

/**
 * TTL policy table. Each number is the longest staleness that is harmless for that data.
 */
export const CACHE_POLICY = {
  /** Blockhashes live ~60-90 s on chain; a 2 s copy is always valid and saves a call per tx. */
  blockhash: { l0Ms: 2_000 },
  /** Fee markets move per slot (~400 ms); 6 s keeps estimates close while cutting calls ~15x. */
  priorityFee: { l0Ms: 6_000, l1Seconds: 6 },
  /** Jito publishes tip percentiles over rolling windows; 15 s is well within its refresh rate. */
  jitoTipFloor: { l0Ms: 15_000, l1Seconds: 15 },
  /** Tip accounts change only with Jito releases. */
  jitoTipAccounts: { l0Ms: 600_000, l2Seconds: 3_600 },
  /** Authorities and extensions can be changed by the mint authority, so stay short. */
  mintInfo: { l0Ms: 15_000, l1Seconds: 30, l2Seconds: 60, negativeSeconds: 30 },
  /** Risk reports are shown with their age and can be bypassed with `fresh`. */
  riskReport: { l0Ms: 30_000, l1Seconds: 60, l2Seconds: 120 },
  /** Symbols and names almost never change. */
  tokenMeta: { l0Ms: 600_000, l1Seconds: 3_600, l2Seconds: 86_400, negativeSeconds: 600 },
  /** Display-only. Sweeps read settings straight from D1. Invalidated on every write. */
  userView: { l0Ms: 5_000, l2Seconds: 300 },
  /** grammY needs botInfo on every webhook; getMe once a day is plenty. */
  botInfo: { l0Ms: 3_600_000, l2Seconds: 86_400 },
} as const satisfies Record<string, CachePolicy>;

export type CacheSource = "l0" | "l1" | "l2" | "origin";

export interface CacheResult<T> {
  value: T;
  source: CacheSource;
  /** Age of the value in milliseconds (0 when freshly loaded). */
  ageMs: number;
}

interface Envelope<T> {
  v: T;
  /** Epoch ms when the origin produced the value. */
  at: number;
}

interface L0Entry {
  env: Envelope<unknown>;
  expires: number;
}

const L0_MAX_ENTRIES = 1_000;
const l0 = new Map<string, L0Entry>();
const inFlight = new Map<string, Promise<CacheResult<unknown>>>();

let hits = { l0: 0, l1: 0, l2: 0, origin: 0 };

export function cacheStats(): Readonly<typeof hits> {
  return { ...hits };
}

function l0Get<T>(key: string): Envelope<T> | undefined {
  const entry = l0.get(key);
  if (!entry) return undefined;
  if (entry.expires <= Date.now()) {
    l0.delete(key);
    return undefined;
  }
  // Refresh recency for LRU eviction.
  l0.delete(key);
  l0.set(key, entry);
  return entry.env as Envelope<T>;
}

function l0Set(key: string, env: Envelope<unknown>, ttlMs: number): void {
  if (ttlMs <= 0) return;
  if (l0.size >= L0_MAX_ENTRIES) {
    const oldest = l0.keys().next().value;
    if (oldest !== undefined) l0.delete(oldest);
  }
  l0.set(key, { env, expires: Date.now() + ttlMs });
}

export interface LayeredCacheOptions {
  /** Used to push L1/L2 writes past the response. Optional for code running inside Durable Objects. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export class LayeredCache {
  private readonly prefix: string;

  constructor(
    private readonly env: Env,
    private readonly opts: LayeredCacheOptions = {},
  ) {
    // Versioned keys: bumping CACHE_SCHEMA_VERSION in wrangler.jsonc invalidates everything at once.
    this.prefix = `v${env.CACHE_SCHEMA_VERSION || "1"}:${env.SOLANA_CLUSTER || "mainnet-beta"}:`;
  }

  private fullKey(key: string): string {
    return this.prefix + key;
  }

  private l1Request(fullKey: string): Request {
    return new Request(`https://floss-cache.internal/${encodeURIComponent(fullKey)}`);
  }

  private defer(promise: Promise<unknown>): void {
    const guarded = promise.catch((err) => log("warn", "cache write failed", { err: String(err) }));
    if (this.opts.waitUntil) this.opts.waitUntil(guarded);
  }

  /**
   * Read-through lookup with single-flight: concurrent misses for the same key inside one isolate
   * share one origin call, which prevents stampedes when many users scan the same mint.
   */
  async getOrLoad<T>(
    key: string,
    policy: CachePolicy,
    loader: () => Promise<T>,
    options: { fresh?: boolean } = {},
  ): Promise<CacheResult<T>> {
    const fk = this.fullKey(key);
    if (!options.fresh) {
      const cached = await this.read<T>(fk, policy);
      if (cached) return cached;
    }

    const pending = inFlight.get(fk);
    if (pending) return pending as Promise<CacheResult<T>>;

    const run = (async (): Promise<CacheResult<T>> => {
      const value = await loader();
      hits.origin++;
      const envelope: Envelope<T> = { v: value, at: Date.now() };
      this.write(fk, envelope, policy);
      return { value, source: "origin", ageMs: 0 };
    })();

    inFlight.set(fk, run as Promise<CacheResult<unknown>>);
    try {
      return await run;
    } finally {
      inFlight.delete(fk);
    }
  }

  async get<T>(key: string, policy: CachePolicy): Promise<CacheResult<T> | null> {
    return this.read<T>(this.fullKey(key), policy);
  }

  async set<T>(key: string, value: T, policy: CachePolicy): Promise<void> {
    this.write(this.fullKey(key), { v: value, at: Date.now() }, policy);
  }

  /** Removes a key from every layer. KV deletes propagate globally within ~60 s. */
  async invalidate(key: string): Promise<void> {
    const fk = this.fullKey(key);
    l0.delete(fk);
    await Promise.allSettled([caches.default.delete(this.l1Request(fk)), this.env.CACHE_KV.delete(fk)]);
  }

  private ttlFor(envelope: Envelope<unknown>, policy: CachePolicy) {
    const negative = envelope.v === null && policy.negativeSeconds !== undefined;
    return {
      l0Ms: negative ? Math.min(policy.l0Ms ?? 0, policy.negativeSeconds! * 1000) : (policy.l0Ms ?? 0),
      l1Seconds: negative ? Math.min(policy.l1Seconds ?? 0, policy.negativeSeconds!) : (policy.l1Seconds ?? 0),
      // Negative results never go to KV: a mint that did not exist a moment ago may exist now.
      l2Seconds: negative ? 0 : (policy.l2Seconds ?? 0),
    };
  }

  private async read<T>(fk: string, policy: CachePolicy): Promise<CacheResult<T> | null> {
    const now = Date.now();

    if (policy.l0Ms) {
      const hit = l0Get<T>(fk);
      if (hit) {
        hits.l0++;
        return { value: hit.v, source: "l0", ageMs: now - hit.at };
      }
    }

    if (policy.l1Seconds) {
      try {
        const res = await caches.default.match(this.l1Request(fk));
        if (res) {
          const envelope = parseJson<Envelope<T>>(await res.text());
          hits.l1++;
          if (policy.l0Ms) l0Set(fk, envelope, Math.min(policy.l0Ms, this.remainingMs(envelope, policy.l1Seconds)));
          return { value: envelope.v, source: "l1", ageMs: now - envelope.at };
        }
      } catch (err) {
        // Cache API can be unavailable (e.g. on some preview hosts). Degrade to the next layer.
        log("debug", "l1 read failed", { err: String(err) });
      }
    }

    if (policy.l2Seconds) {
      try {
        const text = await this.env.CACHE_KV.get(fk, "text");
        if (text) {
          const envelope = parseJson<Envelope<T>>(text);
          const ageMs = now - envelope.at;
          // KV's own expiry is coarse; enforce the policy TTL against the stored timestamp.
          if (ageMs <= policy.l2Seconds * 1000) {
            hits.l2++;
            if (policy.l0Ms) l0Set(fk, envelope, Math.min(policy.l0Ms, this.remainingMs(envelope, policy.l2Seconds)));
            if (policy.l1Seconds) this.writeL1(fk, envelope, Math.min(policy.l1Seconds, Math.ceil(this.remainingMs(envelope, policy.l2Seconds) / 1000)));
            return { value: envelope.v, source: "l2", ageMs };
          }
        }
      } catch (err) {
        log("warn", "l2 read failed", { err: String(err) });
      }
    }

    return null;
  }

  private remainingMs(envelope: Envelope<unknown>, ttlSeconds: number): number {
    return Math.max(0, envelope.at + ttlSeconds * 1000 - Date.now());
  }

  private write(fk: string, envelope: Envelope<unknown>, policy: CachePolicy): void {
    const ttl = this.ttlFor(envelope, policy);
    if (ttl.l0Ms) l0Set(fk, envelope, ttl.l0Ms);
    if (ttl.l1Seconds) this.writeL1(fk, envelope, ttl.l1Seconds);
    if (ttl.l2Seconds) {
      this.defer(
        this.env.CACHE_KV.put(fk, stringifyJson(envelope), { expirationTtl: Math.max(60, Math.ceil(ttl.l2Seconds)) }),
      );
    }
  }

  private writeL1(fk: string, envelope: Envelope<unknown>, seconds: number): void {
    if (seconds <= 0) return;
    const res = new Response(stringifyJson(envelope), {
      headers: { "content-type": "application/json", "cache-control": `max-age=${Math.ceil(seconds)}` },
    });
    this.defer(caches.default.put(this.l1Request(fk), res));
  }
}

/** Test hook: clears isolate memory. */
export function resetL0ForTests(): void {
  l0.clear();
  inFlight.clear();
  hits = { l0: 0, l1: 0, l2: 0, origin: 0 };
}
