import { hmacSha256, toHex } from "./crypto.ts";
import { timingSafeEqual } from "./util.ts";

const INIT_DATA_MAX_AGE_S = 24 * 3600;

export interface TelegramWebAppUser {
  id: number;
  username?: string;
}

/**
 * Validates Telegram Mini App initData:
 *   secret = HMAC_SHA256(key = "WebAppData", data = bot_token)
 *   hash   = hex(HMAC_SHA256(key = secret, data = sorted "k=v" lines without hash))
 */
export async function verifyInitData(initData: string, botToken: string, nowS = Math.floor(Date.now() / 1000)): Promise<TelegramWebAppUser | null> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheck = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = await hmacSha256(new TextEncoder().encode("WebAppData"), botToken);
  const expected = toHex(await hmacSha256(secret, dataCheck));
  if (!timingSafeEqual(expected, hash)) return null;
  const authDate = Number(params.get("auth_date") ?? "0");
  if (!authDate || nowS - authDate > INIT_DATA_MAX_AGE_S) return null;
  try {
    const user = JSON.parse(params.get("user") ?? "null") as TelegramWebAppUser | null;
    return user && typeof user.id === "number" ? user : null;
  } catch {
    return null;
  }
}


const LOGIN_MAX_AGE_S = 7 * 24 * 3600;

/**
 * Validates a "Log in with Telegram" widget payload (the browser version of the dashboard):
 *   secret = SHA256(bot_token)
 *   hash   = hex(HMAC_SHA256(key = secret, data = sorted "k=v" lines without hash))
 * The payload acts as a 7-day session; after that the user logs in again.
 */
export async function verifyLoginWidget(query: string, botToken: string, nowS = Math.floor(Date.now() / 1000)): Promise<TelegramWebAppUser | null> {
  const params = new URLSearchParams(query);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheck = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(botToken)));
  const expected = toHex(await hmacSha256(secret, dataCheck));
  if (!timingSafeEqual(expected, hash)) return null;
  const authDate = Number(params.get("auth_date") ?? "0");
  if (!authDate || nowS - authDate > LOGIN_MAX_AGE_S || authDate - nowS > 300) return null;
  const id = Number(params.get("id"));
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const username = params.get("username") ?? undefined;
  return username ? { id, username } : { id };
}
