import { Api, type InlineKeyboard } from "grammy";
import type { Env } from "../env.ts";
import type { Md } from "../bot/md.ts";
import { log } from "../lib/util.ts";

/** Out-of-band Telegram calls for code that runs outside a grammY update (DOs, queues, cron). */
export function telegramClientOptions(env: Env): { apiRoot: string } | undefined {
  return env.TELEGRAM_API_ROOT ? { apiRoot: env.TELEGRAM_API_ROOT.replace(/\/$/, "") } : undefined;
}

export function telegramApi(env: Env): Api {
  return new Api(env.TELEGRAM_BOT_TOKEN, telegramClientOptions(env));
}

export async function sendMd(env: Env, chatId: string | number, text: Md, keyboard?: InlineKeyboard): Promise<number | null> {
  try {
    const msg = await telegramApi(env).sendMessage(chatId, text.value, {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
    return msg.message_id;
  } catch (err) {
    log("warn", "telegram send failed", { chatId: String(chatId), err: String(err) });
    return null;
  }
}

export async function editMd(env: Env, chatId: string | number, messageId: number, text: Md, keyboard?: InlineKeyboard): Promise<void> {
  try {
    await telegramApi(env).editMessageText(chatId, messageId, text.value, {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  } catch (err) {
    // "message is not modified" and deleted messages are harmless; fall back to a fresh message otherwise.
    const msg = String(err);
    if (/not modified/i.test(msg)) return;
    log("warn", "telegram edit failed, sending new message", { err: msg });
    await sendMd(env, chatId, text, keyboard);
  }
}

export async function deleteMessage(env: Env, chatId: string | number, messageId: number): Promise<void> {
  try {
    await telegramApi(env).deleteMessage(chatId, messageId);
  } catch (err) {
    log("debug", "telegram delete failed", { err: String(err) });
  }
}
