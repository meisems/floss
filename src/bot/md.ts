/**
 * Telegram MarkdownV2 helpers.
 *
 * Outside entities every one of _ * [ ] ( ) ~ ` > # + - = | { } . ! and \ must be escaped.
 * Inside `code` and ```pre``` only ` and \ are special. Inside a link URL only ) and \ are.
 */

const TEXT_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;

function escText(text: string | number | bigint): string {
  return String(text).replace(TEXT_SPECIAL, (c) => `\\${c}`);
}

/** Escapes plain text. Returns Md, so a value escaped once is never escaped again by md``. */
export function esc(text: string | number | bigint): Md {
  return new Md(escText(text));
}

function escCode(text: string): string {
  return text.replace(/[`\\]/g, (c) => `\\${c}`);
}

function escUrl(url: string): string {
  return url.replace(/[)\\]/g, (c) => `\\${c}`);
}

/** Already-escaped MarkdownV2. Lets helpers compose without double escaping. */
export class Md {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export const raw = (s: string) => new Md(s);
export const bold = (s: string | Md) => new Md(`*${s instanceof Md ? s.value : escText(s)}*`);
export const italic = (s: string | Md) => new Md(`_${s instanceof Md ? s.value : escText(s)}_`);
export const code = (s: string) => new Md(`\`${escCode(s)}\``);
export const pre = (s: string) => new Md(`\`\`\`\n${escCode(s)}\n\`\`\``);
export const spoiler = (s: string | Md) => new Md(`||${s instanceof Md ? s.value : escText(s)}||`);
export const link = (label: string, url: string) => new Md(`[${escText(label)}](${escUrl(url)})`);

/**
 * Tagged template: literal parts are trusted MarkdownV2, interpolations are escaped unless they
 * are Md values.
 *   md`*FLOSSED* · ${label}`   ->  label is escaped, the asterisks are formatting.
 */
export function md(strings: TemplateStringsArray, ...values: Array<string | number | bigint | Md | null | undefined>): Md {
  let out = "";
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) {
      const v = values[i];
      if (v === null || v === undefined) return;
      out += v instanceof Md ? v.value : escText(v);
    }
  });
  return new Md(out);
}

export function lines(...parts: Array<Md | string | null | undefined | false>): Md {
  return new Md(
    parts
      .filter((p): p is Md | string => p !== null && p !== undefined && p !== false)
      .map((p) => (p instanceof Md ? p.value : escText(p)))
      .join("\n"),
  );
}

/** Left-aligned two-column rows for use inside pre blocks. */
export function table(rows: Array<[string, string]>, pad?: number): string {
  const width = pad ?? Math.max(...rows.map(([k]) => k.length)) + 2;
  return rows.map(([k, v]) => `${k.padEnd(width)}${v}`).join("\n");
}
