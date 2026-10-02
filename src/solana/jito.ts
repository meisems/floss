import { JITO_TIP_ACCOUNTS_FALLBACK, type RuntimeConfig } from "../config.ts";
import type { Env } from "../env.ts";
import { CACHE_POLICY, type LayeredCache } from "../lib/cache.ts";
import { log, maxBig, minBig } from "../lib/util.ts";

const TIP_FLOOR_URL = "https://bundles.jito.wtf/api/v1/bundles/tip_floor";

export interface TipFloor {
  p25: bigint;
  p50: bigint;
  p75: bigint;
  p95: bigint;
  ema50: bigint;
}

export type Urgency = "normal" | "high";

export class JitoError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JitoError";
  }
  get rateLimited(): boolean {
    return this.status === 429;
  }
}

function solToLamports(sol: unknown): bigint {
  const n = typeof sol === "number" ? sol : Number(sol);
  if (!Number.isFinite(n) || n <= 0) return 0n;
  return BigInt(Math.ceil(n * 1e9));
}

export class JitoClient {
  constructor(
    private readonly env: Env,
    private readonly cfg: RuntimeConfig,
    private readonly cache?: LayeredCache,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.env.JITO_AUTH_UUID) h["x-jito-auth"] = this.env.JITO_AUTH_UUID;
    return h;
  }

  private async rpc<T>(path: string, method: string, params: unknown[]): Promise<T> {
    const res = await fetch(`${this.cfg.jitoUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new JitoError(`Jito ${method} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new JitoError(`Jito ${method}: ${body.error.message}`);
    return body.result as T;
  }

  /** Landed-tip percentiles. Cached ~15 s (CACHE_POLICY.jitoTipFloor). */
  async getTipFloor(): Promise<TipFloor | null> {
    const load = async (): Promise<Record<string, string> | null> => {
      try {
        const res = await fetch(TIP_FLOOR_URL, { signal: AbortSignal.timeout(5_000) });
        if (!res.ok) return null;
        const rows = (await res.json()) as Array<Record<string, number>>;
        const row = rows[0];
        if (!row) return null;
        return {
          p25: solToLamports(row.landed_tips_25th_percentile).toString(),
          p50: solToLamports(row.landed_tips_50th_percentile).toString(),
          p75: solToLamports(row.landed_tips_75th_percentile).toString(),
          p95: solToLamports(row.landed_tips_95th_percentile).toString(),
          ema50: solToLamports(row.ema_landed_tips_50th_percentile).toString(),
        };
      } catch (err) {
        log("warn", "jito tip floor unavailable", { err: String(err) });
        return null;
      }
    };
    const raw = this.cache ? (await this.cache.getOrLoad("jito:tipfloor", CACHE_POLICY.jitoTipFloor, load)).value : await load();
    if (!raw) return null;
    return {
      p25: BigInt(raw.p25 ?? "0"),
      p50: BigInt(raw.p50 ?? "0"),
      p75: BigInt(raw.p75 ?? "0"),
      p95: BigInt(raw.p95 ?? "0"),
      ema50: BigInt(raw.ema50 ?? "0"),
    };
  }

  /**
   * Dynamic tip:
   *   base     = EMA p50 (normal) or p75 (high urgency)
   *   retries  = base * 1.5^attempt, so a bundle that missed its slot is re-sent more competitively
   *   value    = never more than 5% of the SOL being moved (dust sweeps stay cheap)
   *   clamp    = [MIN_JITO_TIP_LAMPORTS, MAX_JITO_TIP_LAMPORTS]
   */
  async chooseTip(opts: { urgency: Urgency; attempt: number; valueLamports: bigint }): Promise<bigint> {
    const floor = await this.getTipFloor();
    let base: bigint;
    if (!floor) base = this.cfg.minJitoTipLamports * 5n;
    else base = opts.urgency === "high" ? maxBig(floor.p75, floor.ema50) : maxBig(floor.p50, floor.ema50);

    let tip = base;
    for (let i = 0; i < opts.attempt; i++) tip = (tip * 3n) / 2n;

    if (opts.valueLamports > 0n) tip = minBig(tip, maxBig(opts.valueLamports / 20n, this.cfg.minJitoTipLamports));
    return minBig(maxBig(tip, this.cfg.minJitoTipLamports), this.cfg.maxJitoTipLamports);
  }

  /** Tip accounts. Cached for an hour; falls back to Jito's published list. */
  async getTipAccounts(): Promise<string[]> {
    const load = async (): Promise<string[]> => {
      try {
        const accounts = await this.rpc<string[]>("/api/v1/getTipAccounts", "getTipAccounts", []);
        if (Array.isArray(accounts) && accounts.length > 0) return accounts;
      } catch (err) {
        log("warn", "getTipAccounts failed, using fallback list", { err: String(err) });
      }
      return [...JITO_TIP_ACCOUNTS_FALLBACK];
    };
    if (!this.cache) return load();
    return (await this.cache.getOrLoad("jito:tipaccounts", CACHE_POLICY.jitoTipAccounts, load)).value;
  }

  async pickTipAccount(): Promise<string> {
    const accounts = await this.getTipAccounts();
    const idx = crypto.getRandomValues(new Uint32Array(1))[0]! % accounts.length;
    return accounts[idx]!;
  }

  /** Submits base64 wire transactions as one atomic bundle. Returns the bundle id. */
  async sendBundle(base64Txs: string[]): Promise<string> {
    if (base64Txs.length === 0 || base64Txs.length > 5) throw new JitoError(`Bundle must have 1-5 txs, got ${base64Txs.length}`);
    return this.rpc<string>("/api/v1/bundles", "sendBundle", [base64Txs, { encoding: "base64" }]);
  }
}
