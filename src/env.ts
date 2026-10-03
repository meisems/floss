import type { WalletSession } from "./durable/WalletSession.ts";
import type { JobMessage } from "./jobs/types.ts";

/**
 * Bindings come from wrangler.jsonc (deployed by Workers Builds).
 * Secrets are set in the dashboard: Worker -> Settings -> Variables and Secrets.
 */
export interface Env {
  // Bindings
  DB: D1Database;
  CACHE_KV: KVNamespace;
  JOBS: Queue<JobMessage>;
  JOBS_DLQ?: Queue<JobMessage>;
  WALLET_SESSION: DurableObjectNamespace<WalletSession>;
  USER_RATE_LIMITER?: RateLimit;

  // Plain vars (wrangler.jsonc "vars")
  SOLANA_CLUSTER: string;
  RPC_URL?: string;
  HELIUS_API_BASE: string;
  JITO_ENABLED: string;
  JITO_BLOCK_ENGINE_URL: string;
  MAX_PRIORITY_FEE_MICROLAMPORTS: string;
  MIN_JITO_TIP_LAMPORTS: string;
  MAX_JITO_TIP_LAMPORTS: string;
  TRADE_GUARD_SECONDS: string;
  COLD_WALLET_TIMELOCK_HOURS: string;
  MAX_SESSIONS_PER_USER: string;
  MASTER_KEY_VERSION: string;
  PAGES_URL?: string;
  /** Optional: self-hosted Bot API server (or a local stub in tests). Defaults to api.telegram.org. */
  TELEGRAM_API_ROOT?: string;
  CACHE_SCHEMA_VERSION: string;
  /** Platform fee recipient (a wallet you control). Fees are off while empty. */
  FEE_WALLET?: string;
  /** Fee in basis points of SOL value delivered to the vault. 100 = 1%. */
  FEE_BPS: string;
  /** Referrer share of the fee in basis points. 2500 = 25% of the fee. */
  REFERRAL_SHARE_BPS: string;

  // Secrets
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ADMIN_SETUP_TOKEN?: string;
  HELIUS_API_KEY?: string;
  HELIUS_WEBHOOK_ID?: string;
  HELIUS_WEBHOOK_AUTH?: string;
  RPC_URL_FALLBACK?: string;
  JITO_AUTH_UUID?: string;
  /** MASTER_KEY_V1, MASTER_KEY_V2, ... base64-encoded 32-byte keys. */
  [masterKey: `MASTER_KEY_V${number}`]: string | undefined;
}
