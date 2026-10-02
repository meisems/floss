import type { Env } from "../env.ts";
import type { Db } from "../db/client.ts";
import { SessionStatus } from "../db/repo.ts";
import { log } from "../lib/util.ts";

/**
 * The Helius webhook is created once in the Helius dashboard. Floss then owns its address list:
 * it adds a wallet when a session starts, removes it on purge, and the cron reconciles drift
 * (e.g. two sessions created at the same instant racing on GET-modify-PUT).
 */

interface HeliusWebhook {
  webhookID: string;
  webhookURL: string;
  transactionTypes: string[];
  accountAddresses: string[];
  webhookType: string;
  authHeader?: string;
}

function configured(env: Env): boolean {
  return Boolean(env.HELIUS_API_KEY && env.HELIUS_WEBHOOK_ID);
}

function endpoint(env: Env): string {
  const base = (env.HELIUS_API_BASE || "https://api.helius.xyz").replace(/\/$/, "");
  return `${base}/v0/webhooks/${env.HELIUS_WEBHOOK_ID}?api-key=${env.HELIUS_API_KEY}`;
}

async function getWebhook(env: Env): Promise<HeliusWebhook> {
  const res = await fetch(endpoint(env), { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`Helius GET webhook HTTP ${res.status}`);
  return (await res.json()) as HeliusWebhook;
}

async function putAddresses(env: Env, hook: HeliusWebhook, addresses: string[]): Promise<void> {
  const res = await fetch(endpoint(env), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      webhookURL: hook.webhookURL,
      transactionTypes: hook.transactionTypes,
      accountAddresses: addresses,
      webhookType: hook.webhookType,
      // Preserve the auth header so our verification keeps working.
      ...(hook.authHeader || env.HELIUS_WEBHOOK_AUTH ? { authHeader: hook.authHeader || env.HELIUS_WEBHOOK_AUTH } : {}),
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Helius PUT webhook HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
}

export async function heliusAddAddress(env: Env, address: string): Promise<void> {
  if (!configured(env)) return;
  const hook = await getWebhook(env);
  if (hook.accountAddresses.includes(address)) return;
  await putAddresses(env, hook, [...hook.accountAddresses, address]);
}

export async function heliusRemoveAddress(env: Env, address: string): Promise<void> {
  if (!configured(env)) return;
  const hook = await getWebhook(env);
  if (!hook.accountAddresses.includes(address)) return;
  const next = hook.accountAddresses.filter((a) => a !== address);
  // Helius rejects an empty list; leave the last address until a new session replaces it.
  if (next.length === 0) return;
  await putAddresses(env, hook, next);
}

/** Cron: make the webhook's address list equal the set of live session wallets. */
export async function heliusReconcile(env: Env, db: Db): Promise<{ added: number; removed: number } | null> {
  if (!configured(env)) return null;
  const live = await db.sessionWallet.findMany({
    where: { status: { not: SessionStatus.PURGED } },
    select: { address: true },
  });
  const desired = new Set(live.map((s) => s.address));
  const hook = await getWebhook(env);
  const current = new Set(hook.accountAddresses);
  const added = [...desired].filter((a) => !current.has(a)).length;
  const removed = [...current].filter((a) => !desired.has(a)).length;
  if (added === 0 && removed === 0) return { added, removed };
  if (desired.size === 0) return { added: 0, removed: 0 };
  await putAddresses(env, hook, [...desired]);
  log("info", "helius webhook reconciled", { added, removed, total: desired.size });
  return { added, removed };
}

export async function heliusStatus(env: Env): Promise<{ configured: boolean; ok?: boolean; addresses?: number; url?: string; error?: string }> {
  if (!configured(env)) return { configured: false };
  try {
    const hook = await getWebhook(env);
    return { configured: true, ok: true, addresses: hook.accountAddresses.length, url: hook.webhookURL };
  } catch (err) {
    return { configured: true, ok: false, error: String(err) };
  }
}
