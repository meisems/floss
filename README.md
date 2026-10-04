# Floss

**Floss your wallet.** A Telegram bot for Solana traders. It gives you throwaway session wallets, sweeps profit to your cold wallet automatically, revokes token approvals, closes dead token accounts for their rent, and scans tokens or transactions for drainer tricks before you sign.

Everything deploys from the **Cloudflare dashboard and GitHub's website**. You never open a terminal.

---

## What it does

| | |
|---|---|
| **Session wallets** | `/session new` creates a burner keypair. Import its key into your trading bot. Your first deposit becomes the *float* (your trading stake). |
| **Auto-sweep** | When the wallet grows past float + threshold (default 1 SOL), the profit goes to your vault. Other options: a % gain, or "empty after N hours idle". |
| **Revoke + clean** | Token approvals (delegates) are revoked as soon as they're seen. Empty token accounts are closed and their rent goes to the vault. Token-2022 withheld fees are harvested so those accounts can close too. |
| **Pre-flight scan** | `/scan_token <mint \| tx \| Solana Pay / Blink link>` checks mint/freeze authority, permanent delegate, transfer fees and hooks, pausable mints, and hidden taxes (by simulating a real holder's transfer). For transactions it simulates the effects: approvals, ownership changes, SOL/token drains, durable-nonce traps. |
| **Vault time lock** | Changing your cold wallet takes 24h. If someone hijacks your Telegram, you have a day to `/set_cold_wallet cancel`. |
| **Fees + referrals** | **1%** of the SOL each floss delivers to your vault (swept SOL, reclaimed rent, unwrapped SOL). **25% of that fee** goes to whoever referred you, paid to their cold wallet inside the same transaction. Token transfers are fee-free. |
| **Mini App + website** | Dashboard inside Telegram, and on the web with Telegram login. 5 themes (Mint, Aurora, Ember, Glacier, Noir) in light and dark: balances, sweep progress rings, scans, referral earnings, rules, and activity. |

## Architecture

```
Telegram ──webhook──▶ Worker (grammY) ──▶ Queue ──▶ WalletSession Durable Object ──▶ SweepEngine
   ▲                     │   │                         (one per wallet: lock, trade guard,      │
   │                     │   └─ D1 (Prisma): users, vaults, rules, audit, encrypted keys       ▼
   │                     └─ KV + Cache API + isolate memory (layered cache)          Jito bundle / RPC
   │                                                                                          │
Pages Mini App ──/api/*──▶ Pages Function ──service binding──▶ Worker                         ▼
Helius webhook ──────────▶ Worker ──▶ Durable Object (activity → debounced evaluation)     Solana
Cron (2 min / hourly) ───▶ Worker: polling fallback, vault time locks, key rotation, Helius sync
```

- **Keys:** each session seed is encrypted with AES-256-GCM. The key comes from HKDF(`MASTER_KEY_V{n}` secret, per-user salt, wallet address), and the AAD ties each ciphertext to its user and wallet. The master key exists only as a Worker secret. Ending a session crypto-shreds the key.
- **Exact SOL math:** the fee is computed exactly from the compute-unit limit Floss sets. The wallet ends at exactly the float (profit mode) or exactly 0 (full mode), never in the "below rent" range that makes transactions fail.
- **No race with your trades:** every action for a wallet runs one at a time inside its Durable Object. Auto-sweeps wait 20s after the wallet's last outgoing transaction.
- **Fees without custody:** the fee and the referral share are plain transfers inside the user's own sweep transaction, so the split is atomic and Floss never holds anyone's money. If a referral share is too small to open the referrer's empty wallet (Solana's rent minimum), it is recorded as owed and paid on a later sweep out of the platform's portion. Every fee is logged in the `FeeLedger` table.
- **Caching:** blockhash (2s), priority fees (6s), Jito tip floor (15s), mint data (30–60s), and risk reports (60–120s; `/scan_token <mint> fresh` skips the cache). Balances, rent, vault address and rules are **never** cached: those feed signing decisions.

---

## Deploy (dashboard only)

You need: a **Cloudflare** account on the **Workers Paid plan** ($5/mo, needed for CPU time, Queues and Durable Objects), a **GitHub** account, a free **Helius** account, and **Telegram**.

### 1. Create the bot
In Telegram, open **@BotFather**, send `/newbot`, and copy the **token**.

### 2. Put the code on GitHub
1. github.com → **New repository** → name it `floss` → **Private** → Create.
2. **uploading an existing file** → drag in everything inside this `floss` folder *except* `node_modules`, `.wrangler`, `dist`, `src/generated` and `.dev.vars` (if present) → **Commit changes**.

### 3. Storage: nothing to do
The first Worker deploy creates the D1 database (`floss-db`), the KV namespace and both queues by itself (Wrangler automatic provisioning), and the Worker sets up its own database tables on first use. There are no IDs to paste and no SQL to run.

Optional, before going live: on GitHub, edit `wrangler.jsonc` and set `"FEE_WALLET"` to a wallet you control (empty = fees off). Send it about **0.01 SOL** once, so small fees can land in it (Solana won't create an account below its rent minimum).

*(Already created D1/KV by hand? Add `"database_id"` / `"id"` to those bindings in `wrangler.jsonc` and the Worker uses them. Tables you created from the console are recognised and not re-created.)*

### 4. Deploy the Worker
**Workers & Pages → Create → Import a repository** → pick `floss`:

| Setting | Value |
|---|---|
| Project name | `floss` (must match `name` in `wrangler.jsonc`) |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |

Deploy, then note the URL: `https://floss.<your-subdomain>.workers.dev`. Opening it shows `floss: ok`, and `/health` lists what's still missing (secrets, fee wallet). The Worker runs without them; the bot answers once the secrets below are added.

**Deploy the Worker before the Pages project**: Pages links to it by the name `floss` and fails with *"Service binding 'FLOSS_API' references Worker 'floss' which was not found"* until it exists.

### 5. Generate secrets
Open `https://floss.<your-subdomain>.workers.dev/admin/setup`. The **Generate a secret** buttons create random values in your browser (nothing is sent anywhere). Then go to **Worker → Settings → Variables and Secrets → Add** and add each one as type **Secret**:

| Secret | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | token from BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Token (hex) from the generator |
| `MASTER_KEY_V1` | MASTER_KEY (base64) from the generator. **Also back it up in your password manager. Lose it and session keys can't be decrypted.** |
| `ADMIN_SETUP_TOKEN` | Token (hex) |
| `HELIUS_API_KEY` | from dashboard.helius.dev |
| `HELIUS_WEBHOOK_AUTH` | Token (hex) |
| `HELIUS_WEBHOOK_ID` | after step 7 |
| `RPC_URL_FALLBACK` | *optional* second RPC (e.g. Triton) |
| `JITO_AUTH_UUID` | *optional* Jito auth key for higher rate limits |

> A Helius (or other private) RPC is required. Public Solana RPCs reject requests that come from Cloudflare Workers (403).

### 6. Deploy the Mini App (Pages)
**Workers & Pages → Create → Pages → Connect to Git** → pick `floss`:

| Setting | Value |
|---|---|
| Project name | `floss-app` |
| Framework preset | None |
| Build command | *(empty)* |
| Build output directory | `.` |
| Root directory | `web` |

> **Root directory must be `web`.** If the build log says *"A Wrangler configuration file was found but it does not appear to be valid … `pages_build_output_dir`"* or runs `npm install`, the project is pointed at the repo root: open the Pages project → **Settings → Build → Root directory** → `web`, clear the build command, then **Deployments → Retry deployment**. The Worker is a separate project (step 4); don't deploy it through Pages.

**Website login.** The same dashboard also works in any browser at your Pages URL: visitors see the landing page with live totals, and users log in with **Log in with Telegram**. For that button to work, tell Telegram your site's domain once: **@BotFather → /setdomain → pick your bot → `floss-app.pages.dev`** (your Pages domain, without `https://`). A login lasts 7 days; **Log out** is in the theme sheet.

The link to the Worker (`FLOSS_API`) is already set in [`web/wrangler.jsonc`](web/wrangler.jsonc). After it deploys, copy the URL (e.g. `https://floss-app.pages.dev`), set `"PAGES_URL"` in the root `wrangler.jsonc` on GitHub, and commit. The Worker redeploys by itself.

### 7. Helius webhook
dashboard.helius.dev → **Webhooks → New Webhook**:
- Type **Enhanced**, transaction types **Any**, network **Mainnet**
- URL `https://floss.<your-subdomain>.workers.dev/webhooks/helius`
- **Authorization header**: your `HELIUS_WEBHOOK_AUTH` value
- Account addresses: any one address for now. Floss manages this list itself from then on.

Copy the **Webhook ID** into the `HELIUS_WEBHOOK_ID` secret.

### 8. Finish setup
Open `/admin/setup` again, enter `ADMIN_SETUP_TOKEN`, and run it. Every row should say **OK**: bot, webhook, commands, menu button, D1, KV, master key, Helius, Jito.
Then **delete the `ADMIN_SETUP_TOKEN` secret** so the page can't be run again. A `fees` row marked FIX means `FEE_WALLET` is empty or unfunded.

### 9. Use it
In Telegram: `/start` → `/set_cold_wallet <your cold wallet>` → `/session new` → send a little SOL → `/floss preview`.

---

## Operate

| Task | Where |
|---|---|
| Logs | Worker → **Observability** (structured JSON) |
| Health | `GET /health` |
| Stuck jobs | Queues → `floss-jobs-dlq` |
| Roll back | Worker → **Deployments** → pick a version → Rollback |
| Rotate master key | Add secret `MASTER_KEY_V2` → set `MASTER_KEY_VERSION` to `"2"` in `wrangler.jsonc` → commit. The hourly cron re-encrypts every key. Once `/admin/setup` shows no keys left on v1, delete `MASTER_KEY_V1`. |
| Flush cache | Bump `CACHE_SCHEMA_VERSION` in `wrangler.jsonc` |
| Change fees | `FEE_BPS` (100 = 1%) and `REFERRAL_SHARE_BPS` (2500 = 25% of the fee) in `wrangler.jsonc` |
| Tests | Every push runs `.github/workflows/ci.yml` (typecheck, the full test suite, bundle check). Test tools aren't in `package.json` so Cloudflare's install stays lean; locally run `npm i --no-save vitest@4.1.11 litesvm@1.5.0` first. |

## Commands

```
/session            list · /session new [label]
/floss [label]      revoke + close + sweep profit     (also: all · tokens · clean · preview)
/sweep_now          alias of /floss
/scan_token <x>     mint, tx, or Solana Pay / Blink link   (add "fresh" to skip cache)
/set_cold_wallet    <addr> · cancel
/rules              profit 1.5 · percent 50 · idle 24h · float 0.5 · revoke on|off · close on|off
/referrals          your link, invites, earnings   (alias /ref)
/pause /resume /audit /app /help
```

## Referrals
Everyone gets a link: `t.me/<your bot>?start=ref_<code>` (see `/referrals` or the Earn tab). A new user who opens the bot through it is attributed to the referrer: once, within the first hour, never to themselves. From then on, 25% of every fee they pay goes to the referrer's cold wallet. A referrer who hasn't set a cold wallet yet accrues the share and gets it once they do.

## Limits worth knowing
- Token balances aren't sold. `/floss all tokens` moves them into your vault's token accounts. Tokens with transfer hooks or that are non-transferable are skipped and reported.
- A session is only purged once it's empty, unless you confirm "purge anyway" twice.
- D1 keeps 30 days of point-in-time history, so purged ciphertext stays in backups for that long. Without the master key it's useless, and the wallet is empty by then.
- If Jito is down or rate-limited, Floss falls back to normal RPC sending (not atomic, no tip) and says so in the result.
