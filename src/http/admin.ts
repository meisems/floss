import { telegramApi } from "../telegram/notify.ts";
import { runtimeConfig } from "../config.ts";
import type { Env } from "../env.ts";
import { BOT_COMMANDS } from "../bot/bot.ts";
import { CACHE_POLICY, LayeredCache, cacheStats } from "../lib/cache.ts";
import { hasMasterKey } from "../lib/crypto.ts";
import { errorMessage, timingSafeEqual } from "../lib/util.ts";
import { heliusStatus } from "../services/helius.ts";
import { SolanaRpc } from "../solana/rpc.ts";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(title: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>
:root{--bg:#0b0d0c;--fg:#e8ece9;--muted:#8b958f;--line:#232826;--accent:#7cf0b4;--bad:#ff7a6b}
@media (prefers-color-scheme: light){:root{--bg:#f6f7f6;--fg:#111513;--muted:#5d6762;--line:#dfe3e0;--accent:#0f8f57;--bad:#c23b2b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
main{max-width:720px;margin:0 auto;padding:32px 16px}h1{font-size:20px;letter-spacing:.04em;margin:0 0 4px}p{color:var(--muted)}
.box{border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0}
input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg)}
input{width:100%}button{cursor:pointer;border-color:var(--accent);color:var(--accent);margin-top:10px}
table{width:100%;border-collapse:collapse}td{padding:6px 0;border-bottom:1px solid var(--line);vertical-align:top}td:first-child{color:var(--muted);width:40%}
.ok{color:var(--accent)}.bad{color:var(--bad)}code{word-break:break-all}
</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'",
    },
  });
}

const KEYGEN = `
<div class="box"><b>Generate a secret</b>
<p>Random values made in your browser (never sent anywhere). Use one for MASTER_KEY_V1 (32 bytes, base64), and fresh ones for TELEGRAM_WEBHOOK_SECRET, HELIUS_WEBHOOK_AUTH and ADMIN_SETUP_TOKEN.</p>
<button type="button" onclick="g('k',32,'b64')">MASTER_KEY (base64)</button>
<button type="button" onclick="g('k',32,'hex')">Token (hex)</button>
<p><code id="k"></code></p>
<script>function g(id,n,f){const b=crypto.getRandomValues(new Uint8Array(n));document.getElementById(id).textContent=f==='hex'?[...b].map(x=>x.toString(16).padStart(2,'0')).join(''):btoa(String.fromCharCode(...b));}</script>
</div>`;

/** GET /admin/setup: token form + in-browser secret generator. */
export function setupForm(): Response {
  return page(
    "Floss setup",
    `<h1>FLOSS · setup</h1><p>One-time: registers the Telegram webhook, bot commands and menu button.</p>
<form method="post" class="box"><label>ADMIN_SETUP_TOKEN<input type="password" name="token" autocomplete="off" required></label><button type="submit">Run setup</button></form>
${KEYGEN}`,
  );
}

/** POST /admin/setup */
export async function runSetup(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  if (!env.ADMIN_SETUP_TOKEN) return page("Floss setup", `<h1>Setup disabled</h1><p>Add the ADMIN_SETUP_TOKEN secret to enable this page.</p>`);
  const form = await req.formData().catch(() => null);
  const token = String(form?.get("token") ?? "");
  if (!timingSafeEqual(token, env.ADMIN_SETUP_TOKEN)) {
    return page("Floss setup", `<h1 class="bad">Wrong token</h1><p><a href="/admin/setup">Back</a></p>`);
  }

  const origin = new URL(req.url).origin;
  const rows: Array<[string, boolean, string]> = [];
  const api = telegramApi(env);
  const cache = new LayeredCache(env, { waitUntil: (p) => exec.waitUntil(p) });

  try {
    const me = await api.getMe();
    await cache.set("botinfo", me, CACHE_POLICY.botInfo);
    rows.push(["bot", true, `@${me.username}`]);
  } catch (err) {
    rows.push(["bot", false, `getMe failed: ${errorMessage(err)}. Check TELEGRAM_BOT_TOKEN.`]);
  }

  if (!env.TELEGRAM_WEBHOOK_SECRET || !/^[A-Za-z0-9_-]{16,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET)) {
    rows.push(["webhook", false, "TELEGRAM_WEBHOOK_SECRET missing or invalid (16-256 chars of A-Z a-z 0-9 _ -)."]);
  } else {
    try {
      await api.setWebhook(`${origin}/telegram`, {
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"],
        max_connections: 40,
      });
      rows.push(["webhook", true, `${origin}/telegram`]);
    } catch (err) {
      rows.push(["webhook", false, errorMessage(err)]);
    }
  }

  try {
    await api.setMyCommands(BOT_COMMANDS);
    rows.push(["commands", true, `${BOT_COMMANDS.length} registered`]);
  } catch (err) {
    rows.push(["commands", false, errorMessage(err)]);
  }

  if (env.PAGES_URL) {
    try {
      await api.setChatMenuButton({ menu_button: { type: "web_app", text: "Floss", web_app: { url: env.PAGES_URL } } });
      rows.push(["menu button", true, env.PAGES_URL]);
    } catch (err) {
      rows.push(["menu button", false, errorMessage(err)]);
    }
  } else rows.push(["menu button", true, "skipped (PAGES_URL not set)"]);

  rows.push(...(await healthRows(env)));

  const table = rows
    .map(([k, ok, v]) => `<tr><td>${escapeHtml(k)}</td><td class="${ok ? "ok" : "bad"}">${ok ? "OK" : "FIX"} · <code>${escapeHtml(v)}</code></td></tr>`)
    .join("");
  return page(
    "Floss setup",
    `<h1>FLOSS · setup result</h1><div class="box"><table>${table}</table></div>
<p>Done? Delete or rotate ADMIN_SETUP_TOKEN in the dashboard so this page can't be re-run.</p>`,
  );
}

async function healthRows(env: Env): Promise<Array<[string, boolean, string]>> {
  const cfg = runtimeConfig(env);
  const rows: Array<[string, boolean, string]> = [];
  try {
    const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "User"`).first<{ n: number }>();
    rows.push(["d1", true, `${r?.n ?? 0} users`]);
  } catch (err) {
    rows.push(["d1", false, `${errorMessage(err)}. Paste migrations/0001_init.sql into the D1 Console.`]);
  }
  try {
    await env.CACHE_KV.get("health-probe");
    rows.push(["kv", true, "reachable"]);
  } catch (err) {
    rows.push(["kv", false, errorMessage(err)]);
  }
  rows.push([`MASTER_KEY_V${cfg.masterKeyVersion}`, hasMasterKey(env, cfg.masterKeyVersion), hasMasterKey(env, cfg.masterKeyVersion) ? "present" : "missing or not 32 bytes"]);
  try {
    const stale = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "SessionWallet" WHERE "keyVersion" < ? AND "encryptedKey" IS NOT NULL`)
      .bind(cfg.masterKeyVersion)
      .first<{ n: number }>();
    const n = stale?.n ?? 0;
    rows.push(["key rotation", true, n === 0 ? "all keys on current version" : `${n} key(s) still on an older version (hourly cron migrates them)`]);
  } catch {
    /* reported by the d1 row above */
  }
  const helius = await heliusStatus(env);
  rows.push([
    "helius webhook",
    !helius.configured || Boolean(helius.ok),
    !helius.configured ? "not configured (cron polling only)" : helius.ok ? `${helius.addresses} addresses -> ${helius.url}` : (helius.error ?? "error"),
  ]);
  rows.push(["jito", true, cfg.jitoEnabled ? cfg.jitoUrl : "disabled (RPC only)"]);
  if (!cfg.feeWallet) {
    rows.push(["fees", false, "FEE_WALLET is empty in wrangler.jsonc, so fees and referral rewards are off"]);
  } else {
    try {
      const bal = await new SolanaRpc(env).getBalance(cfg.feeWallet);
      rows.push([
        "fees",
        bal > 0n,
        bal > 0n
          ? `${cfg.feeBps / 100}% -> ${cfg.feeWallet} (${cfg.referralShareBps / 100}% of it to referrers)`
          : `fee wallet ${cfg.feeWallet} has 0 SOL. Send it 0.01 SOL so small fees can land.`,
      ]);
    } catch (err) {
      rows.push(["fees", false, `could not check fee wallet: ${errorMessage(err)}`]);
    }
  }
  return rows;
}

/** GET /health: booleans only, safe to expose. */
export async function health(env: Env): Promise<Response> {
  const rows = await healthRows(env);
  const body = {
    ok: rows.every(([, ok]) => ok),
    checks: Object.fromEntries(rows.map(([k, ok]) => [k, ok])),
    cache: cacheStats(),
    cluster: runtimeConfig(env).cluster,
  };
  return new Response(JSON.stringify(body), { status: body.ok ? 200 : 503, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
