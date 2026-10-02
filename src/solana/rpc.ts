import { rpcUrls } from "../config.ts";
import type { Env } from "../env.ts";
import { CACHE_POLICY, type LayeredCache } from "../lib/cache.ts";
import { fromBase64, log, sleep } from "../lib/util.ts";

export type Commitment = "processed" | "confirmed" | "finalized";

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** Shapes returned by `jsonParsed` token account queries. */
export interface ParsedTokenAccount {
  pubkey: string;
  programId: string;
  lamports: bigint;
  mint: string;
  owner: string;
  amount: bigint;
  decimals: number;
  state: "initialized" | "frozen" | "uninitialized" | string;
  isNative: boolean;
  delegate: string | null;
  delegatedAmount: bigint;
  closeAuthority: string | null;
  /** Token-2022 TransferFeeAmount.withheldAmount, if the extension is present. */
  withheldAmount: bigint;
  /** Token-2022 extension names present on the account. */
  extensions: string[];
}

export interface ParsedMint {
  address: string;
  programId: string;
  decimals: number;
  supply: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  isInitialized: boolean;
  extensions: Array<{ extension: string; state?: Record<string, unknown> }>;
}

export interface SimulationResult {
  err: unknown;
  logs: string[];
  unitsConsumed: number | null;
  accounts: Array<{ lamports: number; owner: string; data: [string, string] } | null> | null;
  innerInstructions: unknown;
}

export interface LatestBlockhash {
  blockhash: string;
  lastValidBlockHeight: bigint;
}

interface JsonRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Minimal JSON-RPC client over fetch with timeouts, retries and endpoint failover.
 * Reads that feed signing decisions always go straight to the RPC; only reference data uses the cache.
 */
export class SolanaRpc {
  private readonly urls: string[];
  private requestId = 0;

  constructor(
    env: Env,
    private readonly cache?: LayeredCache,
  ) {
    this.urls = rpcUrls(env);
  }

  get isHelius(): boolean {
    return this.urls[0]?.includes("helius-rpc.com") ?? false;
  }

  async call<T>(method: string, params: unknown[] = [], opts: { timeoutMs?: number; retries?: number } = {}): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const retries = opts.retries ?? 2;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const url = this.urls[attempt % this.urls.length]!;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++this.requestId, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          if (RETRYABLE_HTTP.has(res.status) && attempt < retries) {
            lastError = new RpcError(`HTTP ${res.status} from RPC`, res.status);
            await sleep(250 * 2 ** attempt);
            continue;
          }
          throw new RpcError(`HTTP ${res.status} from RPC for ${method}`, res.status);
        }
        const body = (await res.json()) as JsonRpcResponse<T>;
        if (body.error) {
          // -32005 node behind, -32004 block not available: transient, retry on next endpoint.
          if ((body.error.code === -32005 || body.error.code === -32004) && attempt < retries) {
            lastError = new RpcError(body.error.message, body.error.code, body.error.data);
            await sleep(200 * 2 ** attempt);
            continue;
          }
          throw new RpcError(`${method}: ${body.error.message}`, body.error.code, body.error.data);
        }
        return body.result as T;
      } catch (err) {
        lastError = err;
        const transient = err instanceof DOMException || (err instanceof TypeError && !(err instanceof RpcError));
        if (!transient || attempt >= retries) break;
        await sleep(250 * 2 ** attempt);
      }
    }
    log("warn", "rpc call failed", { method, err: String(lastError) });
    throw lastError instanceof Error ? lastError : new RpcError(String(lastError));
  }

  /** Always live. Never cached: this number decides how much SOL leaves the wallet. */
  async getBalance(address: string, commitment: Commitment = "confirmed"): Promise<bigint> {
    const res = await this.call<{ value: number }>("getBalance", [address, { commitment }]);
    return BigInt(res.value);
  }

  async getMultipleBalances(addresses: string[], commitment: Commitment = "confirmed"): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    for (let i = 0; i < addresses.length; i += 100) {
      const slice = addresses.slice(i, i + 100);
      const res = await this.call<{ value: Array<{ lamports: number } | null> }>("getMultipleAccounts", [
        slice,
        { commitment, encoding: "base64", dataSlice: { offset: 0, length: 0 } },
      ]);
      slice.forEach((addr, idx) => out.set(addr, BigInt(res.value[idx]?.lamports ?? 0)));
    }
    return out;
  }

  /** Always live. Rent can change by feature gate; it is read at signing time, never cached. */
  async getMinimumBalanceForRentExemption(size: number): Promise<bigint> {
    return BigInt(await this.call<number>("getMinimumBalanceForRentExemption", [size, { commitment: "confirmed" }]));
  }

  async getLatestBlockhash(commitment: Commitment = "confirmed"): Promise<LatestBlockhash> {
    const load = async () => {
      const res = await this.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [
        { commitment },
      ]);
      return { blockhash: res.value.blockhash, lastValidBlockHeight: BigInt(res.value.lastValidBlockHeight) };
    };
    if (!this.cache) return load();
    return (await this.cache.getOrLoad(`blockhash:${commitment}`, CACHE_POLICY.blockhash, load)).value;
  }

  async getBlockHeight(commitment: Commitment = "confirmed"): Promise<bigint> {
    return BigInt(await this.call<number>("getBlockHeight", [{ commitment }]));
  }

  async getSignatureStatuses(
    signatures: string[],
  ): Promise<Array<{ confirmationStatus: Commitment | null; err: unknown } | null>> {
    const res = await this.call<{ value: Array<{ confirmationStatus: Commitment | null; err: unknown } | null> }>(
      "getSignatureStatuses",
      [signatures, { searchTransactionHistory: false }],
    );
    return res.value;
  }

  async getAccountInfoBase64(
    address: string,
    commitment: Commitment = "confirmed",
  ): Promise<{ lamports: bigint; owner: string; data: Uint8Array; executable: boolean } | null> {
    const res = await this.call<{
      value: { lamports: number; owner: string; data: [string, string]; executable: boolean } | null;
    }>("getAccountInfo", [address, { commitment, encoding: "base64" }]);
    if (!res.value) return null;
    return {
      lamports: BigInt(res.value.lamports),
      owner: res.value.owner,
      data: fromBase64(res.value.data[0]),
      executable: res.value.executable,
    };
  }

  async getAccountOwner(address: string): Promise<{ owner: string; lamports: bigint; executable: boolean; dataLength: number } | null> {
    const res = await this.call<{
      value: { lamports: number; owner: string; executable: boolean; space?: number; data: [string, string] } | null;
    }>("getAccountInfo", [address, { commitment: "confirmed", encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
    if (!res.value) return null;
    return {
      owner: res.value.owner,
      lamports: BigInt(res.value.lamports),
      executable: res.value.executable,
      dataLength: res.value.space ?? 0,
    };
  }

  async getMultipleOwners(addresses: string[]): Promise<Map<string, { owner: string; lamports: bigint } | null>> {
    const out = new Map<string, { owner: string; lamports: bigint } | null>();
    for (let i = 0; i < addresses.length; i += 100) {
      const slice = addresses.slice(i, i + 100);
      const res = await this.call<{ value: Array<{ lamports: number; owner: string } | null> }>("getMultipleAccounts", [
        slice,
        { commitment: "confirmed", encoding: "base64", dataSlice: { offset: 0, length: 0 } },
      ]);
      slice.forEach((addr, idx) => {
        const v = res.value[idx];
        out.set(addr, v ? { owner: v.owner, lamports: BigInt(v.lamports) } : null);
      });
    }
    return out;
  }

  /** Mint account via jsonParsed (authorities + Token-2022 extensions). Cached briefly; see CACHE_POLICY.mintInfo. */
  async getMint(mint: string, opts: { fresh?: boolean } = {}): Promise<{ value: ParsedMint | null; ageMs: number; cached: boolean }> {
    const load = async (): Promise<ParsedMint | null> => {
      const res = await this.call<{
        value: {
          owner: string;
          data: { program?: string; parsed?: { type: string; info: Record<string, unknown> } } | [string, string];
        } | null;
      }>("getAccountInfo", [mint, { commitment: "confirmed", encoding: "jsonParsed" }]);
      const v = res.value;
      if (!v || Array.isArray(v.data) || v.data.parsed?.type !== "mint") return null;
      const info = v.data.parsed.info as {
        decimals: number;
        supply: string;
        mintAuthority: string | null;
        freezeAuthority: string | null;
        isInitialized: boolean;
        extensions?: Array<{ extension: string; state?: Record<string, unknown> }>;
      };
      return {
        address: mint,
        programId: v.owner,
        decimals: info.decimals,
        supply: BigInt(info.supply),
        mintAuthority: info.mintAuthority ?? null,
        freezeAuthority: info.freezeAuthority ?? null,
        isInitialized: info.isInitialized,
        extensions: info.extensions ?? [],
      };
    };
    if (!this.cache) return { value: await load(), ageMs: 0, cached: false };
    const r = await this.cache.getOrLoad(`mint:${mint}`, CACHE_POLICY.mintInfo, load, opts);
    return { value: r.value, ageMs: r.ageMs, cached: r.source !== "origin" };
  }

  /** Every SPL Token + Token-2022 account owned by `owner`. Always live. */
  async getTokenAccounts(owner: string, commitment: Commitment = "confirmed"): Promise<ParsedTokenAccount[]> {
    const programs = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
    const results = await Promise.all(
      programs.map((programId) =>
        this.call<{
          value: Array<{
            pubkey: string;
            account: {
              lamports: number;
              owner: string;
              data: { parsed: { info: Record<string, unknown>; type: string } };
            };
          }>;
        }>("getTokenAccountsByOwner", [owner, { programId }, { commitment, encoding: "jsonParsed" }]),
      ),
    );
    const out: ParsedTokenAccount[] = [];
    for (const res of results) {
      for (const item of res.value) {
        const info = item.account.data.parsed.info as {
          mint: string;
          owner: string;
          state: string;
          isNative: boolean;
          tokenAmount: { amount: string; decimals: number };
          delegate?: string;
          delegatedAmount?: { amount: string };
          closeAuthority?: string;
          extensions?: Array<{ extension: string; state?: { withheldAmount?: number | string } }>;
        };
        const fee = info.extensions?.find((e) => e.extension === "transferFeeAmount");
        out.push({
          pubkey: item.pubkey,
          programId: item.account.owner,
          lamports: BigInt(item.account.lamports),
          mint: info.mint,
          owner: info.owner,
          amount: BigInt(info.tokenAmount.amount),
          decimals: info.tokenAmount.decimals,
          state: info.state,
          isNative: Boolean(info.isNative),
          delegate: info.delegate ?? null,
          delegatedAmount: BigInt(info.delegatedAmount?.amount ?? "0"),
          closeAuthority: info.closeAuthority ?? null,
          withheldAmount: BigInt(fee?.state?.withheldAmount ?? 0),
          extensions: (info.extensions ?? []).map((e) => e.extension),
        });
      }
    }
    return out;
  }

  async getTokenLargestAccounts(mint: string): Promise<Array<{ address: string; amount: bigint; decimals: number }>> {
    const res = await this.call<{ value: Array<{ address: string; amount: string; decimals: number }> }>(
      "getTokenLargestAccounts",
      [mint, { commitment: "confirmed" }],
    );
    return res.value.map((v) => ({ address: v.address, amount: BigInt(v.amount), decimals: v.decimals }));
  }

  async getAddressLookupTable(address: string): Promise<string[] | null> {
    const res = await this.call<{
      value: { data: { parsed?: { info?: { addresses?: string[] } } } | [string, string] } | null;
    }>("getAccountInfo", [address, { commitment: "confirmed", encoding: "jsonParsed" }]);
    const data = res.value?.data;
    if (!data || Array.isArray(data)) return null;
    return data.parsed?.info?.addresses ?? null;
  }

  async simulate(
    base64Tx: string,
    opts: { accounts?: string[]; sigVerify?: boolean; replaceRecentBlockhash?: boolean; innerInstructions?: boolean } = {},
  ): Promise<SimulationResult> {
    const config: Record<string, unknown> = {
      encoding: "base64",
      commitment: "confirmed",
      sigVerify: opts.sigVerify ?? false,
      replaceRecentBlockhash: opts.replaceRecentBlockhash ?? true,
      innerInstructions: opts.innerInstructions ?? false,
    };
    if (opts.accounts?.length) config.accounts = { encoding: "base64", addresses: opts.accounts };
    const res = await this.call<{ value: SimulationResult }>("simulateTransaction", [base64Tx, config], {
      timeoutMs: 15_000,
    });
    return {
      err: res.value.err ?? null,
      logs: res.value.logs ?? [],
      unitsConsumed: res.value.unitsConsumed ?? null,
      accounts: res.value.accounts ?? null,
      innerInstructions: res.value.innerInstructions ?? null,
    };
  }

  async sendTransaction(base64Tx: string, opts: { skipPreflight?: boolean } = {}): Promise<string> {
    return this.call<string>(
      "sendTransaction",
      [base64Tx, { encoding: "base64", skipPreflight: opts.skipPreflight ?? false, preflightCommitment: "confirmed", maxRetries: 0 }],
      { retries: 0, timeoutMs: 15_000 },
    );
  }

  /**
   * Priority fee in micro-lamports per CU for transactions touching `accounts`.
   * Uses Helius getPriorityFeeEstimate when available, otherwise the 75th percentile of
   * getRecentPrioritizationFees. Cached ~6 s (CACHE_POLICY.priorityFee).
   */
  async getPriorityFeeMicroLamports(accounts: string[], level: "Medium" | "High" | "VeryHigh" = "High"): Promise<bigint> {
    const load = async (): Promise<string> => {
      if (this.isHelius) {
        try {
          const res = await this.call<{ priorityFeeEstimate?: number }>(
            "getPriorityFeeEstimate",
            [{ accountKeys: accounts.slice(0, 20), options: { priorityLevel: level, recommended: level === "Medium" } }],
            { retries: 1 },
          );
          if (typeof res.priorityFeeEstimate === "number") return BigInt(Math.ceil(res.priorityFeeEstimate)).toString();
        } catch (err) {
          log("debug", "helius priority fee unavailable, falling back", { err: String(err) });
        }
      }
      const fees = await this.call<Array<{ prioritizationFee: number }>>("getRecentPrioritizationFees", [
        accounts.slice(0, 128),
      ]);
      const values = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
      if (values.length === 0) return "0";
      const pct = level === "Medium" ? 0.5 : level === "High" ? 0.75 : 0.9;
      return BigInt(values[Math.min(values.length - 1, Math.floor(values.length * pct))] ?? 0).toString();
    };
    // Fee markets are per writable account; key on the sorted account set.
    const key = `prio:${level}:${[...accounts].sort().slice(0, 8).join(",")}`;
    if (!this.cache) return BigInt(await load());
    return BigInt((await this.cache.getOrLoad(key, CACHE_POLICY.priorityFee, load)).value);
  }
}
