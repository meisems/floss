import { webhookCallback } from "grammy";
import type { Env } from "./env.ts";
import { createBot, getBotInfo } from "./bot/bot.ts";
import { LayeredCache } from "./lib/cache.ts";
import { errorMessage, log } from "./lib/util.ts";
import { handleHeliusWebhook } from "./http/helius.ts";
import { handleMiniApp } from "./http/miniapp.ts";
import { health, runSetup, setupForm } from "./http/admin.ts";
import { handleScheduled } from "./jobs/cron.ts";
import { handleQueue } from "./jobs/consumer.ts";
import { ensureSchema } from "./db/schema.ts";
import type { JobMessage } from "./jobs/types.ts";

export { WalletSession } from "./durable/WalletSession.ts";

async function telegram(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const cache = new LayeredCache(env, { waitUntil: (p) => exec.waitUntil(p) });
  const bot = createBot(env, exec, await getBotInfo(env, cache));
  // grammY checks X-Telegram-Bot-Api-Secret-Token against secretToken and rejects mismatches.
  // Long work (floss, scans) is queued or deferred with waitUntil, so handlers return well inside
  // Telegram's timeout; "return" answers 200 instead of letting Telegram retry a slow update.
  const handle = webhookCallback(bot, "cloudflare-mod", {
    secretToken: env.TELEGRAM_WEBHOOK_SECRET,
    timeoutMilliseconds: 9_000,
    onTimeout: "return",
  });
  return handle(req);
}

export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/") return new Response("floss: ok\n", { headers: { "content-type": "text/plain" } });
      if (url.pathname === "/admin/setup" && req.method === "GET") return setupForm();
      await ensureSchema(env.DB);
      if (url.pathname === "/telegram" && req.method === "POST") return await telegram(req, env, exec);
      if (url.pathname === "/webhooks/helius" && req.method === "POST") return await handleHeliusWebhook(req, env, exec);
      if (url.pathname.startsWith("/api/")) return await handleMiniApp(req, env, exec);
      if (url.pathname === "/admin/setup" && req.method === "POST") return await runSetup(req, env, exec);
      if (url.pathname === "/health") return await health(env);
      return new Response("not found", { status: 404 });
    } catch (err) {
      log("error", "unhandled request error", { path: url.pathname, err: errorMessage(err) });
      return new Response("internal error", { status: 500 });
    }
  },

  async scheduled(controller: ScheduledController, env: Env, exec: ExecutionContext): Promise<void> {
    exec.waitUntil(ensureSchema(env.DB).then(() => handleScheduled(controller, env)));
  },

  async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
    await ensureSchema(env.DB);
    await handleQueue(batch, env);
  },
} satisfies ExportedHandler<Env, JobMessage>;
