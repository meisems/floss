import { LAMPORTS_PER_SOL } from "../config.ts";

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** JSON that survives bigint round-trips (lamports, token amounts). */
export function stringifyJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? { $big: v.toString() } : v));
}

export function parseJson<T>(text: string): T {
  return JSON.parse(text, (_k, v) =>
    v && typeof v === "object" && typeof v.$big === "string" && Object.keys(v).length === 1 ? BigInt(v.$big) : v,
  ) as T;
}

export function formatSol(lamports: bigint, maxDecimals = 4): string {
  const negative = lamports < 0n;
  const abs = negative ? -lamports : lamports;
  const whole = abs / LAMPORTS_PER_SOL;
  const frac = (abs % LAMPORTS_PER_SOL).toString().padStart(9, "0");
  let shown = frac.slice(0, maxDecimals).replace(/0+$/, "");
  // Never print a non-zero amount as "0".
  if (whole === 0n && shown === "" && abs > 0n) shown = frac.replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${shown ? `.${shown}` : ""}`;
}

/** Parses "1.5" / "0.25" SOL into lamports without floating point. */
export function parseSol(input: string): bigint | null {
  const match = /^\s*(\d{1,9})(?:\.(\d{1,9}))?\s*$/.exec(input);
  if (!match) return null;
  const whole = BigInt(match[1]!);
  const frac = BigInt((match[2] ?? "").padEnd(9, "0"));
  return whole * LAMPORTS_PER_SOL + frac;
}

export function formatTokenAmount(raw: bigint, decimals: number, maxDecimals = 4): string {
  if (decimals === 0) return raw.toString();
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(decimals, "0").slice(0, maxDecimals).replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""}`;
}

export function shortAddr(addr: string, size = 4): string {
  return addr.length <= size * 2 + 1 ? addr : `${addr.slice(0, size)}…${addr.slice(-size)}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function maxBig(...values: bigint[]): bigint {
  return values.reduce((a, b) => (a > b ? a : b));
}

export function minBig(...values: bigint[]): bigint {
  return values.reduce((a, b) => (a < b ? a : b));
}

/** Constant-time string comparison for secrets and HMACs. */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function randomId(bytes = 12): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return toBase64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type LogLevel = "debug" | "info" | "warn" | "error";

/** Structured JSON logs, picked up by Workers Logs (observability is enabled in wrangler.jsonc). */
export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  const line = stringifyJson({ level, msg, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
