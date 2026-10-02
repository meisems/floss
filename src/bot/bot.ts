import { Bot, InlineKeyboard, type CallbackQueryContext, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { isAddress, isOffCurveAddress, address } from "@solana/kit";
import { runtimeConfig, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../config.ts";
import type { Env } from "../env.ts";
import { getDb, type Db } from "../db/client.ts";
import {
  attachReferrer,
  audit,
  effectiveVaultAddress,
  getOrCreateUser,
  getVault,
  listSessions,
  recentAudit,
  referralLink,
  referralStats,
  resolveRules,
  resolveSession,
  RuleKind,
  SessionStatus,
  upsertRule,
  type SessionWallet,
  type User,
} from "../db/repo.ts";
import { ScanInputError, SimulationGuard } from "../engine/SimulationGuard.ts";
import type { FlossMode } from "../engine/SweepEngine.ts";
import { CACHE_POLICY, LayeredCache } from "../lib/cache.ts";
import { errorMessage, formatSol, log, parseSol, shortAddr } from "../lib/util.ts";
import { SolanaRpc } from "../solana/rpc.ts";
import { createSession, exportSecretKey, purgeSession, SessionLimitError } from "../services/sessions.ts";
import type { FlossJob } from "../jobs/types.ts";
import { telegramApi, telegramClientOptions } from "../telegram/notify.ts";
import { bold, code, esc, italic, lines, md, type Md } from "./md.ts";
import { CB, sessionKeyboard } from "./render.ts";
import {
  auditView,
  errorView,
  referralView,
  exportKeyView,
  flossQueuedView,
  helpView,
  newSessionView,
  riskReportView,
  rulesView,
  sessionCard,
  sessionsListView,
  vaultView,
  welcomeView,
} from "./views.ts";

export const BOT_COMMANDS = [
  { command: "start", description: "Status and setup" },
  { command: "session", description: "List or create session wallets" },
  { command: "floss", description: "Revoke, close empty accounts, sweep profit" },
  { command: "sweep_now", description: "Alias of /floss" },
  { command: "scan_token", description: "Risk scan a mint, tx, or link" },
  { command: "set_cold_wallet", description: "Set your vault address" },
  { command: "rules", description: "Auto-sweep rules" },
  { command: "pause", description: "Pause all auto-sweeps" },
  { command: "resume", description: "Resume auto-sweeps" },
  { command: "audit", description: "Recent actions" },
  { command: "referrals", description: "Your referral link and earnings" },
  { command: "help", description: "All commands" },
];

const KEY_MESSAGE_TTL_SECONDS = 60;
const VAULT_CONFIRM_WINDOW_S = 600;

interface Deps {
  env: Env;
  exec: ExecutionContext;
  db: Db;
  cache: LayeredCache;
}

/** Sends MarkdownV2 with link previews off. */
async function reply(ctx: Context, text: Md, keyboard?: InlineKeyboard) {
  return ctx.reply(text.value, {
    parse_mode: "MarkdownV2",
    link_preview_options: { is_disabled: true },
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
}

async function edit(ctx: Context, text: Md, keyboard?: InlineKeyboard) {
  try {
    await ctx.editMessageText(text.value, {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  } catch (err) {
    if (!/not modified/i.test(String(err))) await reply(ctx, text, keyboard);
  }
}

function matchId(match: string | RegExpMatchArray): string {
  return typeof match === "string" ? match : (match[1] ?? "");
}

function args(ctx: Context): string[] {
  const m = typeof ctx.match === "string" ? ctx.match : "";
  return m.trim().split(/\s+/).filter(Boolean);
}

async function currentUser(ctx: Context, deps: Deps): Promise<User> {
  const from = ctx.from!;
  return getOrCreateUser(deps.db, {
    telegramId: String(from.id),
    chatId: String(ctx.chat?.id ?? from.id),
    username: from.username ?? null,
  });
}

/** Mini App data is display-only and cached; every write drops it. */
async function invalidateUserView(deps: Deps, userId: string): Promise<void> {
  await deps.cache.invalidate(`user:${userId}:view`);
}

async function enqueueFloss(ctx: Context, deps: Deps, session: SessionWallet, opts: { mode: FlossMode; evacuate?: boolean; dryRun?: boolean; end?: boolean }) {
  const label = opts.dryRun ? `${opts.mode} preview` : opts.end ? "end session" : opts.mode;
  const status = await reply(ctx, flossQueuedView(session.label, label));
  const job: FlossJob = {
    type: "floss",
    sessionId: session.id,
    mode: opts.mode,
    evacuateTokens: opts.evacuate ?? false,
    dryRun: opts.dryRun ?? false,
    origin: opts.end ? "end" : "manual",
    endSession: opts.end ?? false,
    // update_id makes Telegram's webhook redeliveries collapse into one job.
    idempotencyKey: `tg:${ctx.update.update_id}`,
    chatId: String(ctx.chat!.id),
    messageId: status.message_id,
  };
  await deps.env.JOBS.send(job);
}

async function pickSession(ctx: Context, deps: Deps, user: User, ref: string | undefined, action: (id: string) => string): Promise<SessionWallet | null> {
  const session = await resolveSession(deps.db, user.id, ref);
  if (session) return session;
  const sessions = await listSessions(deps.db, user.id);
  if (sessions.length === 0) {
    await reply(ctx, md`No sessions yet\\. ${code("/session new")}`);
    return null;
  }
  const kb = new InlineKeyboard();
  sessions.forEach((s, i) => {
    kb.text(s.label, action(s.id));
    if (i % 3 === 2) kb.row();
  });
  await reply(ctx, ref ? md`No session called ${code(ref)}\\. Pick one:` : md`Which session?`, kb);
  return null;
}

async function rateLimited(deps: Deps, key: string): Promise<boolean> {
  if (!deps.env.USER_RATE_LIMITER) return false;
  try {
    const { success } = await deps.env.USER_RATE_LIMITER.limit({ key });
    return !success;
  } catch {
    return false;
  }
}

async function loadOwnedSession(deps: Deps, ctx: Context, sessionId: string): Promise<{ user: User; session: SessionWallet } | null> {
  const user = await currentUser(ctx, deps);
  const session = await deps.db.sessionWallet.findFirst({ where: { id: sessionId, userId: user.id } });
  if (!session) {
    await ctx.answerCallbackQuery({ text: "Session not found." });
    return null;
  }
  return { user, session };
}

async function showCard(ctx: Context, deps: Deps, user: User, session: SessionWallet, mode: "reply" | "edit") {
  const rpc = new SolanaRpc(deps.env, deps.cache);
  const [balance, rules, vault] = await Promise.all([
    rpc.getBalance(session.address).catch(() => null),
    resolveRules(deps.db, user.id, session.id),
    getVault(deps.db, user.id),
  ]);
  const text = sessionCard({
    session,
    balance,
    rules,
    vaultAddress: effectiveVaultAddress(vault),
    cluster: runtimeConfig(deps.env).cluster,
    userPaused: user.paused,
  });
  const kb = session.status === SessionStatus.PURGED ? undefined : sessionKeyboard(session.id, session.status);
  if (mode === "edit") await edit(ctx, text, kb);
  else await reply(ctx, text, kb);
}

function parseDuration(input: string): number | null {
  const m = /^(\d+)(m|h|d)?$/i.exec(input.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "m").toLowerCase();
  return unit === "d" ? n * 1440 : unit === "h" ? n * 60 : n;
}

export async function getBotInfo(env: Env, cache: LayeredCache): Promise<UserFromGetMe> {
  const res = await cache.getOrLoad("botinfo", CACHE_POLICY.botInfo, () => telegramApi(env).getMe());
  return res.value;
}

export function createBot(env: Env, exec: ExecutionContext, botInfo: UserFromGetMe): Bot {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN, { botInfo, client: telegramClientOptions(env) });
  const cache = new LayeredCache(env, { waitUntil: (p) => exec.waitUntil(p) });
  const deps: Deps = { env, exec, db: getDb(env.DB), cache };
  const cfg = runtimeConfig(env);

  // Private chats only: session keys must never be posted into a group.
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== "private") return;
    if (!ctx.from) return;
    // Telegram redelivers on timeouts; drop updates we've already handled.
    const seenKey = `upd:${ctx.update.update_id}`;
    const seen = await cache.get<boolean>(seenKey, { l0Ms: 120_000, l1Seconds: 120 });
    if (seen) return;
    await cache.set(seenKey, true, { l0Ms: 120_000, l1Seconds: 120 });
    if (await rateLimited(deps, `tg:${ctx.from.id}`)) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Slow down a little." });
      else await ctx.reply("Slow down a little.");
      return;
    }
    await next();
  });

  // ---- /start /help ---------------------------------------------------------------------------
  bot.command("start", async (ctx) => {
    const user = await currentUser(ctx, deps);
    // Deep link: t.me/<bot>?start=ref_<code>
    const payload = typeof ctx.match === "string" ? ctx.match.trim() : "";
    const referrer = payload.startsWith("ref_") ? await attachReferrer(deps.db, user, payload.slice(4)) : null;
    if (referrer) {
      await invalidateUserView(deps, user.id);
      await reply(ctx, md`${code("[REFERRED]")} welcome in\\.`);
    }
    const [vault, sessions] = await Promise.all([getVault(deps.db, user.id), listSessions(deps.db, user.id)]);
    const kb = env.PAGES_URL ? new InlineKeyboard().webApp("Open dashboard", env.PAGES_URL) : undefined;
    await reply(ctx, welcomeView({ vault, vaultAddress: effectiveVaultAddress(vault), sessions: sessions.length }), kb);
  });

  bot.command(["referrals", "ref"], async (ctx) => {
    const user = await currentUser(ctx, deps);
    const stats = await referralStats(deps.db, user);
    const link = referralLink(ctx.me.username, stats.code);
    const share = new InlineKeyboard().url("Share link", `https://t.me/share/url?url=${encodeURIComponent(link)}`);
    await reply(
      ctx,
      referralView({ link, invited: stats.invited, earned: stats.earnedLamports, owed: stats.owedLamports, feeBps: cfg.feeBps, shareBps: cfg.referralShareBps }),
      share,
    );
  });

  bot.command("help", (ctx) => reply(ctx, helpView()));

  // ---- /session -------------------------------------------------------------------------------
  bot.command("session", async (ctx) => {
    const user = await currentUser(ctx, deps);
    const [sub, label] = args(ctx);

    if (sub === "new") {
      const vault = await getVault(deps.db, user.id);
      try {
        const session = await createSession(env, deps.db, user, { label, waitUntil: (p) => exec.waitUntil(p) });
        await invalidateUserView(deps, user.id);
        const kb = new InlineKeyboard().text("Export key", CB.export(session.id)).text("Open", CB.open(session.id));
        await reply(ctx, lines(newSessionView(session), vault ? null : md`\n${bold("No vault yet.")} ${code("/set_cold_wallet <address>")}`), kb);
      } catch (err) {
        if (err instanceof SessionLimitError) await reply(ctx, errorView("session", err.message));
        else throw err;
      }
      return;
    }

    if (sub) {
      const session = await resolveSession(deps.db, user.id, sub);
      if (!session) {
        await reply(ctx, md`No session called ${code(sub)}\\.`);
        return;
      }
      await showCard(ctx, deps, user, session, "reply");
      return;
    }

    const sessions = await listSessions(deps.db, user.id);
    if (sessions.length === 1) {
      await showCard(ctx, deps, user, sessions[0]!, "reply");
      return;
    }
    const rpc = new SolanaRpc(env, cache);
    const balances = await rpc.getMultipleBalances(sessions.map((s) => s.address)).catch(() => new Map<string, bigint>());
    const kb = new InlineKeyboard();
    sessions.forEach((s, i) => {
      kb.text(s.label, CB.open(s.id));
      if (i % 3 === 2) kb.row();
    });
    kb.row().text("+ New session", "new");
    await reply(ctx, sessionsListView(sessions.map((s) => ({ session: s, balance: balances.get(s.address) ?? null }))), kb);
  });

  // ---- /floss /sweep_now ----------------------------------------------------------------------
  const flossHandler = async (ctx: Context) => {
    const user = await currentUser(ctx, deps);
    const parts = args(ctx);
    const flags = new Set(parts.filter((p) => ["all", "preview", "clean", "tokens"].includes(p.toLowerCase())).map((p) => p.toLowerCase()));
    const ref = parts.find((p) => !flags.has(p.toLowerCase()));
    const mode: FlossMode = flags.has("all") ? "full" : flags.has("clean") ? "clean" : "profit";
    const session = await pickSession(ctx, deps, user, ref, mode === "full" ? CB.flossAll : flags.has("preview") ? CB.preview : CB.floss);
    if (!session) return;
    if (session.status === SessionStatus.PURGED) {
      await reply(ctx, errorView(session.label, "Session is purged."));
      return;
    }
    await enqueueFloss(ctx, deps, session, { mode, evacuate: flags.has("tokens"), dryRun: flags.has("preview") });
  };
  bot.command(["floss", "sweep_now"], flossHandler);

  // ---- /scan_token ----------------------------------------------------------------------------
  bot.command("scan_token", async (ctx) => {
    const parts = args(ctx);
    const fresh = parts.some((p) => p.toLowerCase() === "fresh");
    const input = parts.filter((p) => p.toLowerCase() !== "fresh").join("");
    if (!input) {
      await reply(ctx, lines(md`*SCAN*`, md`${code("/scan_token <mint>")}`, md`${code("/scan_token <base64 or base58 tx>")}`, md`${code("/scan_token <solana pay or blink link>")}`));
      return;
    }
    if (await rateLimited(deps, `scan:${ctx.from!.id}`)) {
      await reply(ctx, md`Scan limit hit\\. Try again in a minute\\.`);
      return;
    }
    const user = await currentUser(ctx, deps);
    const sessions = await listSessions(deps.db, user.id);
    const wallet = sessions.find((s) => s.status === SessionStatus.ACTIVE)?.address;
    const placeholder = await reply(ctx, md`*SCAN* ${code("[PENDING]")} simulating…`);
    const chatId = ctx.chat!.id;

    // Respond to Telegram now; finish the scan in the background and edit the placeholder.
    exec.waitUntil(
      (async () => {
        const guard = new SimulationGuard(new SolanaRpc(env, cache), cache);
        let text: Md;
        try {
          const res = await guard.scan(input, { fresh, wallet });
          text = riskReportView(res.report, { cached: res.cached, ageMs: res.ageMs, cluster: cfg.cluster });
          await audit(deps.db, { userId: user.id, action: "SCAN", status: "OK", detail: { target: res.report.target, level: res.report.level, score: res.report.score, cached: res.cached } });
        } catch (err) {
          text = errorView("scan", err instanceof ScanInputError ? err.message : `Scan failed: ${errorMessage(err).slice(0, 200)}`);
        }
        await ctx.api
          .editMessageText(chatId, placeholder.message_id, text.value, { parse_mode: "MarkdownV2", link_preview_options: { is_disabled: true } })
          .catch((err) => log("warn", "scan edit failed", { err: String(err) }));
      })(),
    );
  });

  // ---- /set_cold_wallet /vault ---------------------------------------------------------------
  bot.command(["set_cold_wallet", "vault"], async (ctx) => {
    const user = await currentUser(ctx, deps);
    const [arg] = args(ctx);
    const vault = await getVault(deps.db, user.id);

    if (!arg) {
      await reply(ctx, vaultView(vault, effectiveVaultAddress(vault)));
      return;
    }
    if (arg.toLowerCase() === "cancel") {
      if (vault?.pendingAddress) {
        await deps.db.coldVaultConfig.update({ where: { id: vault.id }, data: { pendingAddress: null, pendingEffectiveAt: null } });
        await audit(deps.db, { userId: user.id, action: "COLD_WALLET_CANCELLED", status: "OK", detail: { cancelled: vault.pendingAddress } });
        await invalidateUserView(deps, user.id);
        await reply(ctx, md`Pending vault change cancelled\\. Sweeps keep going to ${code(vault.address)}`);
      } else await reply(ctx, md`No pending change\\.`);
      return;
    }
    if (!isAddress(arg)) {
      await reply(ctx, errorView("vault", "That is not a valid Solana address."));
      return;
    }
    const sessions = await listSessions(deps.db, user.id, { includePurged: true });
    if (sessions.some((s) => s.address === arg)) {
      await reply(ctx, errorView("vault", "That is one of your session wallets. The vault must be a wallet whose key Floss never holds."));
      return;
    }

    const rpc = new SolanaRpc(env, cache);
    const info = await rpc.getAccountOwner(arg).catch(() => null);
    if (info?.executable) {
      await reply(ctx, errorView("vault", "That address is a program, not a wallet."));
      return;
    }
    if (info && (info.owner === TOKEN_PROGRAM || info.owner === TOKEN_2022_PROGRAM)) {
      await reply(ctx, errorView("vault", "That is a token account or a mint. Paste the wallet address itself."));
      return;
    }
    const notes: Array<Md | string> = [];
    if (!info) notes.push("New address with no SOL yet. That's fine for a fresh cold wallet.");
    else if (info.owner !== SYSTEM_PROGRAM) notes.push(`Owned by program ${shortAddr(info.owner)}. Sweeps will still land, but double-check this is yours.`);
    if (isOffCurveAddress(address(arg))) notes.push("Off-curve address (a PDA). Fine for a Squads multisig vault; otherwise make sure you can sign for it.");

    const timelocked = Boolean(vault);
    const kb = new InlineKeyboard().text(timelocked ? "Confirm (24h lock)" : "Confirm", CB.vaultConfirm(arg)).text("Cancel", CB.cancel());
    await reply(
      ctx,
      lines(
        md`*VAULT* · confirm`,
        code(arg),
        ...notes.map((n) => (typeof n === "string" ? italic(n) : n)),
        timelocked
          ? md`Changing an existing vault takes effect after ${String(cfg.coldWalletTimelockMs / 3_600_000)}h\\. If someone hijacks your Telegram, you have that long to cancel\\.`
          : null,
      ),
      kb,
    );
  });

  // ---- /rules ---------------------------------------------------------------------------------
  bot.command("rules", async (ctx) => {
    const user = await currentUser(ctx, deps);
    const [key, value, ref] = args(ctx);
    const usage = () =>
      reply(ctx, lines(md`Usage:`, code("/rules profit 1.5 | off"), code("/rules percent 50 | off"), code("/rules idle 24h | off"), code("/rules float 0.5 [session]"), code("/rules revoke on|off"), code("/rules close on|off|15m")));

    if (!key) {
      const session = await resolveSession(deps.db, user.id);
      await reply(ctx, rulesView(await resolveRules(deps.db, user.id, session?.id), session?.workingFloatLamports ?? null));
      return;
    }
    const v = (value ?? "").toLowerCase();
    const off = v === "off" || v === "0";
    switch (key.toLowerCase()) {
      case "profit": {
        const lamports = off ? null : parseSol(v);
        if (!off && (lamports === null || lamports <= 0n)) return usage();
        await upsertRule(deps.db, { userId: user.id, kind: RuleKind.PROFIT_ABSOLUTE, enabled: !off, ...(lamports ? { thresholdLamports: lamports } : {}) });
        break;
      }
      case "percent": {
        const pct = Number(v.replace("%", ""));
        if (!off && (!Number.isFinite(pct) || pct <= 0 || pct > 10_000)) return usage();
        await upsertRule(deps.db, { userId: user.id, kind: RuleKind.PROFIT_PERCENT, enabled: !off, ...(off ? {} : { percentBps: Math.round(pct * 100) }) });
        break;
      }
      case "idle": {
        const minutes = off ? null : parseDuration(v);
        if (!off && (!minutes || minutes < 10)) return usage();
        await upsertRule(deps.db, { userId: user.id, kind: RuleKind.IDLE_TIMEOUT, enabled: !off, ...(minutes ? { idleMinutes: minutes } : {}) });
        break;
      }
      case "revoke":
        if (v !== "on" && v !== "off") return usage();
        await upsertRule(deps.db, { userId: user.id, kind: RuleKind.REVOKE_ON_SIGHT, enabled: v === "on" });
        break;
      case "close": {
        const minutes = v === "on" ? undefined : off ? undefined : parseDuration(v);
        if (v !== "on" && !off && !minutes) return usage();
        await upsertRule(deps.db, { userId: user.id, kind: RuleKind.CLOSE_EMPTY, enabled: !off, ...(minutes ? { idleMinutes: minutes } : {}) });
        break;
      }
      case "float": {
        const lamports = parseSol(v);
        if (lamports === null) return usage();
        const session = await pickSession(ctx, deps, user, ref, CB.open);
        if (!session) return;
        await deps.db.sessionWallet.update({ where: { id: session.id }, data: { workingFloatLamports: lamports } });
        await audit(deps.db, { userId: user.id, sessionId: session.id, action: "FLOAT_SET", status: "OK", lamports });
        break;
      }
      default:
        return usage();
    }
    await audit(deps.db, { userId: user.id, action: "RULE_SET", status: "OK", detail: { key, value } });
    await invalidateUserView(deps, user.id);
    const session = await resolveSession(deps.db, user.id, key === "float" ? ref : undefined);
    await reply(ctx, rulesView(await resolveRules(deps.db, user.id, session?.id), session?.workingFloatLamports ?? null));
  });

  // ---- /pause /resume /audit /app -------------------------------------------------------------
  bot.command("pause", async (ctx) => {
    const user = await currentUser(ctx, deps);
    await deps.db.user.update({ where: { id: user.id }, data: { paused: true } });
    await audit(deps.db, { userId: user.id, action: "PAUSE_ALL", status: "OK" });
    await invalidateUserView(deps, user.id);
    await reply(ctx, md`${code("[PAUSED]")} auto\\-sweeps off for every session\\. Manual ${code("/floss")} still works\\.`);
  });

  bot.command("resume", async (ctx) => {
    const user = await currentUser(ctx, deps);
    await deps.db.user.update({ where: { id: user.id }, data: { paused: false } });
    await audit(deps.db, { userId: user.id, action: "RESUME_ALL", status: "OK" });
    await invalidateUserView(deps, user.id);
    await reply(ctx, md`${code("[ACTIVE]")} auto\\-sweeps back on\\.`);
  });

  bot.command("audit", async (ctx) => {
    const user = await currentUser(ctx, deps);
    await reply(ctx, auditView(await recentAudit(deps.db, user.id, 10)));
  });

  bot.command("app", async (ctx) => {
    if (!env.PAGES_URL) {
      await reply(ctx, md`Dashboard not configured\\.`);
      return;
    }
    await reply(ctx, md`*FLOSS* · dashboard`, new InlineKeyboard().webApp("Open dashboard", env.PAGES_URL));
  });

  // ---- buttons --------------------------------------------------------------------------------
  bot.callbackQuery("nop", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Cancelled." });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
  });

  bot.callbackQuery("new", async (ctx) => {
    const user = await currentUser(ctx, deps);
    await ctx.answerCallbackQuery();
    try {
      const session = await createSession(env, deps.db, user, { waitUntil: (p) => exec.waitUntil(p) });
      await invalidateUserView(deps, user.id);
      await reply(ctx, newSessionView(session), new InlineKeyboard().text("Export key", CB.export(session.id)).text("Open", CB.open(session.id)));
    } catch (err) {
      await reply(ctx, errorView("session", errorMessage(err)));
    }
  });

  bot.callbackQuery(/^o:(.+)$/, async (ctx) => {
    const owned = await loadOwnedSession(deps, ctx, matchId(ctx.match));
    if (!owned) return;
    await ctx.answerCallbackQuery();
    await showCard(ctx, deps, owned.user, owned.session, "edit");
  });

  const flossButton = (mode: FlossMode, dryRun: boolean) => async (ctx: CallbackQueryContext<Context>) => {
    const owned = await loadOwnedSession(deps, ctx, matchId(ctx.match));
    if (!owned) return;
    await ctx.answerCallbackQuery({ text: dryRun ? "Simulating…" : "Flossing…" });
    await enqueueFloss(ctx, deps, owned.session, { mode, dryRun });
  };
  bot.callbackQuery(/^f:(.+)$/, flossButton("profit", false));
  bot.callbackQuery(/^fa:(.+)$/, flossButton("full", false));
  bot.callbackQuery(/^fp:(.+)$/, flossButton("profit", true));

  bot.callbackQuery(/^x:(.+)$/, async (ctx) => {
    const owned = await loadOwnedSession(deps, ctx, matchId(ctx.match));
    if (!owned) return;
    await ctx.answerCallbackQuery();
    await reply(
      ctx,
      lines(
        md`*${owned.session.label}* · export key`,
        "Anyone with this key controls the wallet. Floss keeps sweeping profit out, but the float is exposed.",
        owned.session.exportCount > 0 ? italic(`Exported ${owned.session.exportCount} time(s) before.`) : null,
      ),
      new InlineKeyboard().text(`Show for ${KEY_MESSAGE_TTL_SECONDS}s`, CB.exportConfirm(owned.session.id)).text("Cancel", CB.cancel()),
    );
  });

  bot.callbackQuery(/^xc:(.+)$/, async (ctx) => {
    const owned = await loadOwnedSession(deps, ctx, matchId(ctx.match));
    if (!owned) return;
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    const secret = await exportSecretKey(env, deps.db, owned.user, owned.session);
    const sent = await reply(ctx, exportKeyView(owned.session.label, secret));
    await env.JOBS.send({ type: "delete_message", chatId: String(ctx.chat!.id), messageId: sent.message_id }, { delaySeconds: KEY_MESSAGE_TTL_SECONDS });
  });

  bot.callbackQuery(/^e:(.+)$/, async (ctx) => {
    const owned = await loadOwnedSession(deps, ctx, matchId(ctx.match));
    if (!owned) return;
    await ctx.answerCallbackQuery();
    await reply(
      ctx,
      lines(
        md`*${owned.session.label}* · end session`,
        "Revokes delegates, closes token accounts, moves every lamport to your vault, then destroys the key.",
        "Token balances: choose whether to move them to your vault too.",
      ),
      new InlineKeyboard()
        .text("End (SOL only)", CB.endConfirm(owned.session.id))
        .text("End + move tokens", CB.endEvacuate(owned.session.id))
        .row()
        .text("Cancel", CB.cancel()),
    );
  });

  const endButton = (evacuate: boolean) => async (ctx: CallbackQueryContext<Context>) => {
    const owned = await loadOwnedSession(deps, ctx, matchId(ctx.match));
    if (!owned) return;
    await ctx.answerCallbackQuery({ text: "Ending session…" });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    await enqueueFloss(ctx, deps, owned.session, { mode: "full", evacuate, end: true });
  };
  bot.callbackQuery(/^ec:(.+)$/, endButton(false));
  bot.callbackQuery(/^ee:(.+)$/, endButton(true));

  bot.callbackQuery(/^fx:(.+)$/, async (ctx) => {
    const owned = await loadOwnedSession(deps, ctx, matchId(ctx.match));
    if (!owned) return;
    await ctx.answerCallbackQuery();
    await reply(
      ctx,
      lines(md`*${owned.session.label}* · purge anyway?`, bold("Anything still in this wallet becomes unrecoverable."), "Export the key first if you might want it."),
      new InlineKeyboard().text("Destroy key", CB.forcePurgeConfirm(owned.session.id)).text("Cancel", CB.cancel()),
    );
  });

  bot.callbackQuery(/^fxc:(.+)$/, async (ctx) => {
    const owned = await loadOwnedSession(deps, ctx, matchId(ctx.match));
    if (!owned) return;
    await ctx.answerCallbackQuery();
    await purgeSession(env, deps.db, owned.user, owned.session, "forced by user");
    await invalidateUserView(deps, owned.user.id);
    await edit(ctx, md`*${owned.session.label}* ${code("[PURGED]")} key destroyed\\.`);
  });

  const statusButton = (status: "ACTIVE" | "PAUSED") => async (ctx: CallbackQueryContext<Context>) => {
    const owned = await loadOwnedSession(deps, ctx, matchId(ctx.match));
    if (!owned) return;
    if (owned.session.status === SessionStatus.PURGED || owned.session.status === SessionStatus.ENDING) {
      await ctx.answerCallbackQuery({ text: "Session is ending." });
      return;
    }
    const session = await deps.db.sessionWallet.update({ where: { id: owned.session.id }, data: { status } });
    await audit(deps.db, { userId: owned.user.id, sessionId: session.id, action: status === "PAUSED" ? "SESSION_PAUSED" : "SESSION_RESUMED", status: "OK" });
    await invalidateUserView(deps, owned.user.id);
    await ctx.answerCallbackQuery({ text: status === "PAUSED" ? "Auto-sweeps paused" : "Auto-sweeps on" });
    await showCard(ctx, deps, owned.user, session, "edit");
  };
  bot.callbackQuery(/^p:(.+)$/, statusButton("PAUSED"));
  bot.callbackQuery(/^r:(.+)$/, statusButton("ACTIVE"));

  bot.callbackQuery(/^vc:(.+)$/, async (ctx) => {
    const addr = matchId(ctx.match);
    const sentAt = ctx.callbackQuery.message?.date ?? 0;
    if (!isAddress(addr) || Date.now() / 1000 - sentAt > VAULT_CONFIRM_WINDOW_S) {
      await ctx.answerCallbackQuery({ text: "Expired. Run /set_cold_wallet again." });
      return;
    }
    const user = await currentUser(ctx, deps);
    const vault = await getVault(deps.db, user.id);
    await ctx.answerCallbackQuery();

    if (!vault) {
      await deps.db.coldVaultConfig.create({ data: { userId: user.id, address: addr } });
      await audit(deps.db, { userId: user.id, action: "COLD_WALLET_SET", status: "OK", detail: { address: addr } });
      await invalidateUserView(deps, user.id);
      await edit(ctx, lines(md`*VAULT* ${code("[ACTIVE]")}`, code(addr), md`Next: ${code("/session new")}`));
      return;
    }
    if (effectiveVaultAddress(vault) === addr) {
      await edit(ctx, md`That is already your vault\\.`);
      return;
    }
    const effectiveAt = new Date(Date.now() + cfg.coldWalletTimelockMs);
    await deps.db.coldVaultConfig.update({ where: { id: vault.id }, data: { pendingAddress: addr, pendingEffectiveAt: effectiveAt } });
    await audit(deps.db, { userId: user.id, action: "COLD_WALLET_PENDING", status: "PENDING", detail: { from: vault.address, to: addr, effectiveAt: effectiveAt.toISOString() } });
    await invalidateUserView(deps, user.id);
    await edit(
      ctx,
      lines(
        md`*VAULT* ${code("[PENDING]")}`,
        md`New vault ${code(addr)}`,
        md`activates ${effectiveAt.toISOString().replace("T", " ").slice(0, 16)} UTC\\. Until then sweeps go to ${code(vault.address)}\\.`,
        md`Didn't do this? ${code("/set_cold_wallet cancel")}`,
      ),
    );
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) {
      await reply(ctx, md`Unknown command\\. ${code("/help")}`);
      return;
    }
    // A bare address or link is almost always "is this safe?".
    const text = ctx.message.text.trim();
    if (isAddress(text) || /^(https?:|solana:|solana-action:)/i.test(text)) {
      await reply(ctx, md`Scan it: ${code(`/scan_token ${text}`)}`);
    }
  });

  bot.catch(async (err) => {
    log("error", "bot handler error", { err: errorMessage(err.error), update: err.ctx.update.update_id });
    try {
      await err.ctx.reply("Something broke on our side. Nothing was sent on chain. Try again in a moment.");
    } catch {
      /* ignore */
    }
  });

  return bot;
}

