import type { Env } from "../src/env.ts";
import { toBase64 } from "../src/lib/util.ts";

/**
 * Minimal MarkdownV2 validator mirroring Telegram's parser rules closely enough to catch the
 * classic bug: an unescaped special character outside an entity.
 */
export function validateMarkdownV2(text: string): string | null {
  const specials = new Set(["_", "*", "[", "]", "(", ")", "~", "`", ">", "#", "+", "-", "=", "|", "{", "}", ".", "!"]);
  const open: Record<string, boolean> = { "*": false, _: false, "~": false, "||": false };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (text.startsWith("```", i)) {
      const end = findClosing(text, i + 3, "```");
      if (end < 0) return `unclosed pre at ${i}`;
      i = end + 3;
      continue;
    }
    if (c === "`") {
      const end = findClosing(text, i + 1, "`");
      if (end < 0) return `unclosed code at ${i}`;
      i = end + 1;
      continue;
    }
    if (c === "[") {
      const close = findClosing(text, i + 1, "]");
      if (close < 0 || text[close + 1] !== "(") return `bad link at ${i}`;
      const urlEnd = findClosing(text, close + 2, ")");
      if (urlEnd < 0) return `unclosed link url at ${i}`;
      const inner = validateMarkdownV2(text.slice(i + 1, close));
      if (inner) return `in link text: ${inner}`;
      i = urlEnd + 1;
      continue;
    }
    if (text.startsWith("||", i)) {
      open["||"] = !open["||"];
      i += 2;
      continue;
    }
    if (c === "*" || c === "_" || c === "~") {
      open[c] = !open[c];
      i++;
      continue;
    }
    if (specials.has(c)) return `unescaped '${c}' at ${i}: ...${text.slice(Math.max(0, i - 20), i + 10)}...`;
    i++;
  }
  const unbalanced = Object.entries(open).find(([, v]) => v);
  return unbalanced ? `unbalanced ${unbalanced[0]}` : null;
}

function findClosing(text: string, from: number, token: string): number {
  let i = from;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text.startsWith(token, i)) return i;
    i++;
  }
  return -1;
}

export class MemoryKV {
  store = new Map<string, { value: string; expires: number | null }>();
  async get(key: string): Promise<string | null> {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expires !== null && e.expires < Date.now()) return null;
    return e.value;
  }
  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    if (opts?.expirationTtl !== undefined && opts.expirationTtl < 60) throw new Error("KV expirationTtl must be >= 60");
    this.store.set(key, { value, expires: opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : null });
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

export class MemoryCache {
  store = new Map<string, Response>();
  async match(req: Request): Promise<Response | undefined> {
    const r = this.store.get(req.url);
    return r ? r.clone() : undefined;
  }
  async put(req: Request, res: Response): Promise<void> {
    this.store.set(req.url, res.clone());
  }
  async delete(req: Request): Promise<boolean> {
    return this.store.delete(req.url);
  }
}

export function installCaches(): MemoryCache {
  const cache = new MemoryCache();
  (globalThis as unknown as { caches: { default: MemoryCache } }).caches = { default: cache };
  return cache;
}

export function testEnv(overrides: Partial<Env> = {}): Env {
  const key = toBase64(new Uint8Array(32).map((_, i) => i + 1));
  return {
    DB: {} as D1Database,
    CACHE_KV: new MemoryKV() as unknown as KVNamespace,
    JOBS: {} as Env["JOBS"],
    WALLET_SESSION: {} as Env["WALLET_SESSION"],
    SOLANA_CLUSTER: "mainnet-beta",
    HELIUS_API_BASE: "https://api.helius.xyz",
    JITO_ENABLED: "true",
    JITO_BLOCK_ENGINE_URL: "https://mainnet.block-engine.jito.wtf",
    MAX_PRIORITY_FEE_MICROLAMPORTS: "2000000",
    MIN_JITO_TIP_LAMPORTS: "10000",
    MAX_JITO_TIP_LAMPORTS: "5000000",
    TRADE_GUARD_SECONDS: "20",
    COLD_WALLET_TIMELOCK_HOURS: "24",
    MAX_SESSIONS_PER_USER: "5",
    MASTER_KEY_VERSION: "1",
    CACHE_SCHEMA_VERSION: "1",
    TELEGRAM_BOT_TOKEN: "123456:TEST",
    TELEGRAM_WEBHOOK_SECRET: "test-secret-0123456789",
    MASTER_KEY_V1: key,
    ...overrides,
  } as Env;
}
