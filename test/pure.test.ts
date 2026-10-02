import { describe, expect, it } from "vitest";
import { generateKeyPairSigner } from "@solana/kit";
import { bold, code, esc, lines, md } from "../src/bot/md.ts";
import {
  auditView,
  errorView,
  exportKeyView,
  flossResultView,
  fundedView,
  helpView,
  newSessionView,
  referralView,
  riskReportView,
  rulesView,
  sessionCard,
  sessionsListView,
  vaultView,
  welcomeView,
} from "../src/bot/views.ts";
import { renderOutcome } from "../src/bot/render.ts";
import { DEFAULT_RULES, effectiveVaultAddress, type EffectiveRules } from "../src/db/repo.ts";
import { decide } from "../src/engine/triggers.ts";
import type { FlossReport } from "../src/engine/SweepEngine.ts";
import { classifyInput, decodeTokenAccount, ScanInputError, type RiskReport } from "../src/engine/SimulationGuard.ts";
import { decryptSeed, encryptSeed, newUserSalt } from "../src/lib/crypto.ts";
import { verifyInitData } from "../src/lib/telegramAuth.ts";
import { hmacSha256, toHex } from "../src/lib/crypto.ts";
import { formatSol, formatTokenAmount, parseJson, parseSol, stringifyJson, toBase64 } from "../src/lib/util.ts";
import { feeFor } from "../src/solana/tx.ts";
import { testEnv, validateMarkdownV2 } from "./helpers.ts";

const ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const VAULT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

describe("MarkdownV2", () => {
  it("escapes every special character", () => {
    expect(esc("a_b*c[d]e(f)g~h`i>j#k+l-m=n|o{p}q.r!s\\t").value).toBe(
      "a\\_b\\*c\\[d\\]e\\(f\\)g\\~h\\`i\\>j\\#k\\+l\\-m\\=n\\|o\\{p\\}q\\.r\\!s\\\\t",
    );
  });

  it("template escapes values, not formatting", () => {
    const out = md`*${"alpha-1.0"}* ${code("a`b")}`;
    expect(out.value).toBe("*alpha\\-1\\.0* `a\\`b`");
    expect(validateMarkdownV2(out.value)).toBeNull();
  });

  it("esc() output is never escaped twice", () => {
    expect(md`at ${esc("2026-10-02")}`.value).toBe("at 2026\\-10\\-02");
  });

  it("validator catches unescaped specials", () => {
    expect(validateMarkdownV2("hello. world")).not.toBeNull();
    expect(validateMarkdownV2(lines("hello. world", bold("x-y")).value)).toBeNull();
  });
});

describe("views render valid MarkdownV2", () => {
  const session = {
    id: "ckxyz123",
    userId: "u1",
    label: "degen_run-2",
    address: ADDR,
    status: "ACTIVE",
    encryptedKey: "x",
    keyIv: "y",
    keyVersion: 1,
    workingFloatLamports: 500_000_000n,
    baselineLamports: 2_000_000_000n,
    exportCount: 1,
    lastSweepAt: new Date(Date.now() - 90_000),
    lastCheckedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    endedAt: null,
    purgedAt: null,
  };
  const report: FlossReport = {
    mode: "full",
    dryRun: false,
    wallet: ADDR,
    vault: VAULT,
    via: "jito",
    revoked: [{ account: ADDR, mint: VAULT, delegate: ADDR }],
    closed: [{ account: ADDR, mint: VAULT, lamports: 2_039_280n }],
    harvested: 1,
    evacuated: [],
    skipped: [{ account: ADDR, mint: VAULT, reason: "simulation failed: Program log: Error: (custom) 0x11 [frozen]." }],
    residualTokenAccounts: [{ account: ADDR, mint: VAULT, amount: 5n, decimals: 6 }],
    rentReclaimedLamports: 2_039_280n,
    unwrappedLamports: 1_000n,
    sweptLamports: 1_234_567_890n,
    feesLamports: 15_000n,
    tipLamports: 10_000n,
    balanceBefore: 1_300_000_000n,
    balanceAfter: 0n,
    signatures: ["5Kx9dA1bH3rT7qW2eE4yU6iO8pA0sD2fG4hJ6kL8zX1cV3bN5mQ7wE9rT1yU3iO5p"],
    bundleIds: ["b1"],
    pending: false,
    serviceFee: { base: 1_236_607_170n, fee: 12_366_072n, platform: 9_274_554n, referrer: 3_091_518n, referrerStatus: "PAID", owedSettled: 0n, owedAdded: 0n, waived: 0n },
    notes: ["Remaining SOL was below rent-exempt minimum; swept it too (to avoid a rent failure)."],
  };
  const risk: RiskReport = {
    kind: "mint",
    target: VAULT,
    score: 85,
    level: "CRITICAL",
    findings: [
      { code: "PERMANENT_DELEGATE", severity: "critical", title: "Permanent delegate", detail: "X can burn (any) tokens." },
      { code: "TRANSFER_FEE", severity: "high", title: "Transfer fee 7.50%", detail: "Every transfer withholds 750 bps." },
      { code: "KNOWN_ISSUER", severity: "info", title: "Recognised: USDC (Circle)", detail: "ok." },
    ],
    mint: { address: VAULT, program: "token-2022", decimals: 6, supply: 10n ** 15n, mintAuthority: ADDR, freezeAuthority: null, extensions: ["transferFeeConfig", "permanentDelegate"] },
    simulation: { ran: true, ok: true, logsTail: [], probe: { sent: 1_000_000n, received: 925_000n, effectiveTaxBps: 750 } },
    balanceChanges: [
      { account: ADDR, kind: "SOL", before: 10n, after: 5n, delta: -5n },
      { account: ADDR, kind: "TOKEN", mint: VAULT, decimals: 6, before: 10n, after: 0n, delta: -10n },
    ],
    programs: ["System", "SPL Token", "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
    generatedAt: Date.now(),
  };
  const vault = { id: "v", userId: "u", address: VAULT, pendingAddress: ADDR, pendingEffectiveAt: new Date(Date.now() + 3_600_000), createdAt: new Date(), updatedAt: new Date() };

  const cases: Array<[string, () => { value: string }]> = [
    ["welcome (no vault)", () => welcomeView({ vault: null, vaultAddress: null, sessions: 0 })],
    ["welcome (vault)", () => welcomeView({ vault, vaultAddress: VAULT, sessions: 2 })],
    ["help", () => helpView()],
    ["session card", () => sessionCard({ session, balance: 1_482_100_000n, rules: DEFAULT_RULES, vaultAddress: VAULT, cluster: "mainnet-beta", userPaused: false })],
    ["sessions list", () => sessionsListView([{ session, balance: 1n }, { session, balance: null }])],
    ["sessions empty", () => sessionsListView([])],
    ["new session", () => newSessionView(session)],
    ["funded", () => fundedView("alpha", 2_000_000_000n, 2_000_000_000n, 1_000_000_000n)],
    ["export key", () => exportKeyView("alpha", "3x8K".repeat(22))],
    ["floss result", () => flossResultView("alpha", report, "mainnet-beta")],
    ["floss result dry", () => flossResultView("alpha", { ...report, dryRun: true, signatures: [] }, "devnet")],
    ["floss result empty", () => flossResultView("alpha", { ...report, revoked: [], closed: [], harvested: 0, sweptLamports: 0n, unwrappedLamports: 0n, via: "none" }, "mainnet-beta")],
    ["risk mint", () => riskReportView(risk, { cached: true, ageMs: 42_000, cluster: "mainnet-beta" })],
    ["risk tx", () => riskReportView({ ...risk, kind: "transaction", mint: undefined }, { cached: false, ageMs: 0, cluster: "mainnet-beta" })],
    ["vault", () => vaultView(vault, VAULT)],
    ["vault none", () => vaultView(null, null)],
    ["rules", () => rulesView({ ...DEFAULT_RULES, profitPercent: { enabled: true, bps: 5_000 }, idle: { enabled: true, minutes: 90 } }, 500_000_000n)],
    ["audit", () => auditView([{ action: "FLOSS", status: "OK", createdAt: new Date(), lamports: 1_000_000_000n }])],
    ["referrals", () => referralView({ link: "https://t.me/FlossSolBot?start=ref_k7m2xq9p", invited: 14, earned: 86_400_000n, owed: 1_250_000n, feeBps: 100, shareBps: 2_500 })],
    ["error", () => errorView("scan", "That address is not a token mint. (try again!)")],
    ["outcome ok", () => renderOutcome({ ok: true, label: "alpha", report }, "id", "mainnet-beta").text],
    ["outcome purged", () => renderOutcome({ ok: true, label: "alpha", report, purged: true }, "id", "mainnet-beta").text],
    ["outcome blocked", () => renderOutcome({ ok: true, label: "alpha", report, blockedPurge: true }, "id", "mainnet-beta").text],
    ["outcome error", () => renderOutcome({ ok: false, label: "alpha", error: "Wallet needs 5000 lamports (fees).", errorKind: "funds" }, "id", "mainnet-beta").text],
  ];
  for (const [name, render] of cases) {
    it(name, () => {
      const text = render().value;
      expect(validateMarkdownV2(text), text).toBeNull();
      expect(text.length).toBeLessThan(4096);
    });
  }
});

describe("amounts", () => {
  it("parses and formats SOL without floats", () => {
    expect(parseSol("1.5")).toBe(1_500_000_000n);
    expect(parseSol("0.000000001")).toBe(1n);
    expect(parseSol("1.0000000001")).toBeNull();
    expect(parseSol("-1")).toBeNull();
    expect(formatSol(1_500_000_000n)).toBe("1.5");
    expect(formatSol(2_039_280n, 6)).toBe("0.002039");
    expect(formatSol(5n)).toBe("0.000000005");
    expect(formatSol(-1_000_000_000n)).toBe("-1");
    expect(formatTokenAmount(1_234_567n, 6)).toBe("1.2345");
  });

  it("round-trips bigints through cache JSON", () => {
    const v = { a: 1n, b: [2n, { c: 3n }], d: "x" };
    expect(parseJson(stringifyJson(v))).toEqual(v);
  });

  it("computes exact fees", () => {
    // 200k CU at 1,000,000 microlamports/CU = 200,000 lamports priority + 5,000 base.
    expect(feeFor(200_000, 1_000_000n)).toBe(205_000n);
    // Priority fee rounds up.
    expect(feeFor(1, 1n)).toBe(5_001n);
    expect(feeFor(10_000, 0n)).toBe(5_000n);
  });
});

describe("session key encryption", () => {
  it("round-trips and binds ciphertext to user + wallet", async () => {
    const env = testEnv();
    const salt = newUserSalt();
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const secret = await encryptSeed(env, { userId: "u1", userSalt: salt, wallet: ADDR, seed, keyVersion: 1 });
    const back = await decryptSeed(env, { userId: "u1", userSalt: salt, wallet: ADDR, secret });
    expect([...back]).toEqual([...seed]);

    await expect(decryptSeed(env, { userId: "u2", userSalt: salt, wallet: ADDR, secret })).rejects.toThrow();
    await expect(decryptSeed(env, { userId: "u1", userSalt: newUserSalt(), wallet: ADDR, secret })).rejects.toThrow();
    await expect(decryptSeed(env, { userId: "u1", userSalt: salt, wallet: VAULT, secret })).rejects.toThrow();
    const otherMaster = testEnv({ MASTER_KEY_V1: toBase64(crypto.getRandomValues(new Uint8Array(32))) });
    await expect(decryptSeed(otherMaster, { userId: "u1", userSalt: salt, wallet: ADDR, secret })).rejects.toThrow();
  });

  it("supports key versions for rotation", async () => {
    const env = testEnv({ MASTER_KEY_V2: toBase64(crypto.getRandomValues(new Uint8Array(32))) } as never);
    const salt = newUserSalt();
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const v2 = await encryptSeed(env, { userId: "u", userSalt: salt, wallet: ADDR, seed, keyVersion: 2 });
    expect(v2.keyVersion).toBe(2);
    expect([...(await decryptSeed(env, { userId: "u", userSalt: salt, wallet: ADDR, secret: v2 }))]).toEqual([...seed]);
    await expect(encryptSeed(env, { userId: "u", userSalt: salt, wallet: ADDR, seed, keyVersion: 3 })).rejects.toThrow(/MASTER_KEY_V3/);
  });
});

describe("Telegram initData", () => {
  async function sign(params: Record<string, string>, token: string): Promise<string> {
    const dcs = Object.entries(params).map(([k, v]) => `${k}=${v}`).sort().join("\n");
    const secret = await hmacSha256(new TextEncoder().encode("WebAppData"), token);
    const hash = toHex(await hmacSha256(secret, dcs));
    return new URLSearchParams({ ...params, hash }).toString();
  }

  it("accepts valid data and rejects tampering / stale data", async () => {
    const now = Math.floor(Date.now() / 1000);
    const params = { auth_date: String(now), query_id: "AAE", user: JSON.stringify({ id: 42, username: "degen" }) };
    const good = await sign(params, "123:ABC");
    expect(await verifyInitData(good, "123:ABC")).toEqual({ id: 42, username: "degen" });
    expect(await verifyInitData(good, "123:XYZ")).toBeNull();
    expect(await verifyInitData(good.replace("42", "43"), "123:ABC")).toBeNull();
    const stale = await sign({ ...params, auth_date: String(now - 2 * 86_400) }, "123:ABC");
    expect(await verifyInitData(stale, "123:ABC")).toBeNull();
  });
});

describe("auto-sweep triggers", () => {
  const SOL = 1_000_000_000n;
  const rules = (patch: Partial<EffectiveRules> = {}): EffectiveRules => ({ ...structuredClone(DEFAULT_RULES), ...patch });

  it("sweeps profit above the float", () => {
    expect(decide({ rules: rules(), balance: 3n * SOL, baseline: 2n * SOL, float: 2n * SOL, tokens: [], quietMs: 0 })).toEqual({
      mode: "profit",
      keep: 2n * SOL,
      reason: "profit threshold",
    });
    expect(decide({ rules: rules(), balance: 2n * SOL + SOL / 2n, baseline: 2n * SOL, float: 2n * SOL, tokens: [], quietMs: 0 })).toBeNull();
  });

  it("percent rule keeps the baseline", () => {
    const r = rules({ profitAbsolute: { enabled: false, thresholdLamports: SOL }, profitPercent: { enabled: true, bps: 5_000 } });
    expect(decide({ rules: r, balance: 3n * SOL, baseline: 2n * SOL, float: SOL, tokens: [], quietMs: 0 })?.keep).toBe(2n * SOL);
    expect(decide({ rules: r, balance: 2n * SOL + SOL / 2n, baseline: 2n * SOL, float: SOL, tokens: [], quietMs: 0 })).toBeNull();
  });

  it("idle beats profit and empties the wallet", () => {
    const r = rules({ idle: { enabled: true, minutes: 60 } });
    expect(decide({ rules: r, balance: 5n * SOL, baseline: SOL, float: SOL, tokens: [], quietMs: 61 * 60_000 })?.mode).toBe("full");
  });

  it("revokes delegates on sight but ignores frozen accounts", () => {
    const tok = (delegate: string | null, state = "initialized", amount = 5n) => ({ amount, delegate, state });
    expect(decide({ rules: rules(), balance: SOL, baseline: SOL, float: SOL, tokens: [tok(ADDR)], quietMs: 0 })?.reason).toBe("delegate found");
    expect(decide({ rules: rules(), balance: SOL, baseline: SOL, float: SOL, tokens: [tok(ADDR, "frozen")], quietMs: 0 })).toBeNull();
  });

  it("closes empty accounts only after the quiet period", () => {
    const empty = { amount: 0n, delegate: null, state: "initialized" };
    expect(decide({ rules: rules(), balance: SOL, baseline: SOL, float: SOL, tokens: [empty], quietMs: 60_000 })).toBeNull();
    expect(decide({ rules: rules(), balance: SOL, baseline: SOL, float: SOL, tokens: [empty], quietMs: 11 * 60_000 })?.reason).toBe("empty accounts");
  });
});

describe("vault time lock", () => {
  it("switches to the pending address exactly when due", () => {
    const base = { id: "v", userId: "u", address: VAULT, pendingAddress: ADDR, createdAt: new Date(), updatedAt: new Date() };
    expect(effectiveVaultAddress({ ...base, pendingEffectiveAt: new Date(Date.now() + 1_000) })).toBe(VAULT);
    expect(effectiveVaultAddress({ ...base, pendingEffectiveAt: new Date(Date.now() - 1_000) })).toBe(ADDR);
    expect(effectiveVaultAddress(null)).toBeNull();
  });
});

describe("scan input + token layout", () => {
  it("classifies inputs", () => {
    expect(classifyInput(VAULT)).toEqual({ type: "mint", mint: VAULT });
    expect(classifyInput("solana:https://example.com/pay").type).toBe("url");
    expect(classifyInput("https://dial.to/?action=solana-action:https://x.y/a").type).toBe("url");
    expect(() => classifyInput("not an address")).toThrow(ScanInputError);
    const sig = "5Kx9dA1bH3rT7qW2eE4yU6iO8pA0sD2fG4hJ6kL8zX1cV3bN5mQ7wE9rT1yU3iO5pA2sD4fG6hJ8kL0zX2cV4bN";
    expect(() => classifyInput(sig)).toThrow(/signature|Could not read/);
  });

  it("decodes the SPL token account layout", async () => {
    const mint = await generateKeyPairSigner();
    const owner = await generateKeyPairSigner();
    const delegate = await generateKeyPairSigner();
    const { getAddressEncoder } = await import("@solana/kit");
    const enc = getAddressEncoder();
    const data = new Uint8Array(165);
    const view = new DataView(data.buffer);
    data.set(enc.encode(mint.address), 0);
    data.set(enc.encode(owner.address), 32);
    view.setBigUint64(64, 123_456n, true);
    view.setUint32(72, 1, true);
    data.set(enc.encode(delegate.address), 76);
    data[108] = 1;
    view.setBigUint64(121, 1_000n, true);
    view.setUint32(129, 0, true);
    expect(decodeTokenAccount(data)).toEqual({
      mint: mint.address,
      owner: owner.address,
      amount: 123_456n,
      delegate: delegate.address,
      state: 1,
      delegatedAmount: 1_000n,
      closeAuthority: null,
    });
    expect(decodeTokenAccount(new Uint8Array(100))).toBeNull();
  });
});
