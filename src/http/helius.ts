import type { Env } from "../env.ts";
import { getDb } from "../db/client.ts";
import { findLiveSessionsByAddresses } from "../db/repo.ts";
import { chunk, errorMessage, log, timingSafeEqual } from "../lib/util.ts";
import type { ActivityEvent } from "../durable/WalletSession.ts";

/** Subset of Helius "enhanced" webhook payload that Floss reads. Everything else is ignored. */
interface EnhancedTx {
  signature?: string;
  timestamp?: number;
  feePayer?: string;
  nativeTransfers?: Array<{ fromUserAccount?: string; toUserAccount?: string; amount?: number }>;
  tokenTransfers?: Array<{ fromUserAccount?: string; toUserAccount?: string }>;
  accountData?: Array<{ account?: string; nativeBalanceChange?: number }>;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function involved(tx: EnhancedTx): Set<string> {
  const out = new Set<string>();
  if (tx.feePayer) out.add(tx.feePayer);
  for (const t of tx.nativeTransfers ?? []) {
    if (t.fromUserAccount) out.add(t.fromUserAccount);
    if (t.toUserAccount) out.add(t.toUserAccount);
  }
  for (const t of tx.tokenTransfers ?? []) {
    if (t.fromUserAccount) out.add(t.fromUserAccount);
    if (t.toUserAccount) out.add(t.toUserAccount);
  }
  for (const a of tx.accountData ?? []) if (a.account) out.add(a.account);
  return out;
}

/**
 * POST /webhooks/helius
 * Authenticated by the static Authorization header configured on the Helius webhook.
 * Acknowledges immediately and fans out to Durable Objects in the background so Helius never
 * retries because of our latency.
 */
export async function handleHeliusWebhook(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  if (!env.HELIUS_WEBHOOK_AUTH) return new Response("webhook auth not configured", { status: 503 });
  const auth = req.headers.get("authorization") ?? "";
  if (!timingSafeEqual(auth, env.HELIUS_WEBHOOK_AUTH)) return new Response("unauthorized", { status: 401 });

  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) return new Response("too large", { status: 413 });

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const txs = (Array.isArray(payload) ? payload : [payload]) as EnhancedTx[];

  exec.waitUntil(
    (async () => {
      try {
        const addresses = new Set<string>();
        for (const tx of txs) for (const a of involved(tx)) addresses.add(a);
        const db = getDb(env.DB);
        // D1 caps bound parameters per statement; query in slices.
        const sessions = (await Promise.all(chunk([...addresses], 90).map((slice) => findLiveSessionsByAddresses(db, slice)))).flat();
        if (sessions.length === 0) return;
        const byAddress = new Map(sessions.map((s) => [s.address, s]));

        const calls: Promise<void>[] = [];
        for (const tx of txs) {
          for (const addr of involved(tx)) {
            const session = byAddress.get(addr);
            if (!session) continue;
            const evt: ActivityEvent = {
              signature: tx.signature ?? "",
              outgoing: tx.feePayer === addr,
              nativeDelta: tx.accountData?.find((a) => a.account === addr)?.nativeBalanceChange ?? 0,
              timestamp: (tx.timestamp ?? Math.floor(Date.now() / 1000)) * 1000,
            };
            const stub = env.WALLET_SESSION.get(env.WALLET_SESSION.idFromName(addr));
            calls.push(stub.onActivity(session.id, evt));
          }
        }
        const results = await Promise.allSettled(calls);
        const failed = results.filter((r) => r.status === "rejected").length;
        if (failed) log("warn", "activity fan-out failures", { failed, total: calls.length });
      } catch (err) {
        log("error", "helius webhook processing failed", { err: errorMessage(err) });
      }
    })(),
  );
  return new Response("ok");
}
