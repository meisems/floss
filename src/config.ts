import type { Env } from "./env.ts";

export const LAMPORTS_PER_SOL = 1_000_000_000n;

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const NATIVE_MINT = "So11111111111111111111111111111111111111112";

/** Base fee per signature, in lamports. */
export const LAMPORTS_PER_SIGNATURE = 5_000n;

/** Jito's published mainnet tip accounts. Used only if getTipAccounts is unreachable. */
export const JITO_TIP_ACCOUNTS_FALLBACK = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
] as const;

/**
 * Compute-unit budget per instruction. Deliberately generous: the priority fee is charged on the
 * requested limit, so these numbers make the fee exact and predictable instead of estimated.
 */
export const CU_COST = {
  computeBudget: 200,
  systemTransfer: 450,
  revoke: 4_500,
  revoke2022: 7_000,
  close: 4_500,
  close2022: 9_000,
  harvest2022: 12_000,
  createAtaIdempotent: 32_000,
  createAtaIdempotent2022: 45_000,
  transferChecked: 7_500,
  transferChecked2022: 20_000,
  safetyMargin: 5_000,
} as const;

/** Jito accepts at most 5 transactions per bundle. */
export const MAX_TXS_PER_BUNDLE = 5;

export interface RuntimeConfig {
  cluster: string;
  jitoEnabled: boolean;
  jitoUrl: string;
  maxPriorityFeeMicroLamports: bigint;
  minJitoTipLamports: bigint;
  maxJitoTipLamports: bigint;
  tradeGuardMs: number;
  coldWalletTimelockMs: number;
  maxSessionsPerUser: number;
  masterKeyVersion: number;
  cacheSchemaVersion: string;
  feeWallet: string | null;
  feeBps: number;
  referralShareBps: number;
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function big(value: string | undefined, fallback: bigint): bigint {
  try {
    const parsed = BigInt((value ?? "").trim());
    return parsed >= 0n ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function runtimeConfig(env: Env): RuntimeConfig {
  return {
    cluster: env.SOLANA_CLUSTER || "mainnet-beta",
    jitoEnabled: env.JITO_ENABLED !== "false",
    jitoUrl: (env.JITO_BLOCK_ENGINE_URL || "https://mainnet.block-engine.jito.wtf").replace(/\/$/, ""),
    maxPriorityFeeMicroLamports: big(env.MAX_PRIORITY_FEE_MICROLAMPORTS, 2_000_000n),
    // Jito's documented floor is 1,000 lamports.
    minJitoTipLamports: [big(env.MIN_JITO_TIP_LAMPORTS, 10_000n), 1_000n].reduce((a, b) => (a > b ? a : b)),
    maxJitoTipLamports: big(env.MAX_JITO_TIP_LAMPORTS, 5_000_000n),
    tradeGuardMs: int(env.TRADE_GUARD_SECONDS, 20) * 1000,
    coldWalletTimelockMs: int(env.COLD_WALLET_TIMELOCK_HOURS, 24) * 3_600_000,
    maxSessionsPerUser: Math.max(1, int(env.MAX_SESSIONS_PER_USER, 5)),
    masterKeyVersion: Math.max(1, int(env.MASTER_KEY_VERSION, 1)),
    cacheSchemaVersion: env.CACHE_SCHEMA_VERSION || "1",
    feeWallet: env.FEE_WALLET?.trim() || null,
    feeBps: Math.min(1_000, int(env.FEE_BPS, 100)),
    referralShareBps: Math.min(10_000, int(env.REFERRAL_SHARE_BPS, 2_500)),
  };
}

export function rpcUrls(env: Env): string[] {
  const urls: string[] = [];
  if (env.RPC_URL) urls.push(env.RPC_URL);
  else if (env.HELIUS_API_KEY) {
    const host = env.SOLANA_CLUSTER === "devnet" ? "devnet.helius-rpc.com" : "mainnet.helius-rpc.com";
    urls.push(`https://${host}/?api-key=${env.HELIUS_API_KEY}`);
  }
  if (env.RPC_URL_FALLBACK) urls.push(env.RPC_URL_FALLBACK);
  if (urls.length === 0) {
    urls.push(env.SOLANA_CLUSTER === "devnet" ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com");
  }
  return urls;
}

export function explorerTx(signature: string, cluster: string): string {
  return `https://solscan.io/tx/${signature}${cluster === "devnet" ? "?cluster=devnet" : ""}`;
}

export function explorerAccount(addr: string, cluster: string): string {
  return `https://solscan.io/account/${addr}${cluster === "devnet" ? "?cluster=devnet" : ""}`;
}
