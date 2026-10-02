import { explorerAccount, explorerTx } from "../config.ts";
import type { EffectiveRules, SessionWallet, ColdVaultConfig } from "../db/repo.ts";
import type { FlossReport } from "../engine/SweepEngine.ts";
import type { RiskReport, Severity } from "../engine/SimulationGuard.ts";
import { formatSol, formatTokenAmount, shortAddr } from "../lib/util.ts";
import { bold, code, esc, italic, link, lines, md, pre, raw, spoiler, table, type Md } from "./md.ts";

export const TAG = {
  active: code("[ACTIVE]"),
  paused: code("[PAUSED]"),
  ending: code("[ENDING]"),
  purged: code("[PURGED]"),
  flossed: code("[FLOSSED]"),
  cleaned: code("[CLEANED]"),
  rent: code("[RENT RECLAIMED]"),
  swept: code("[SWEPT]"),
  cached: code("[CACHED]"),
  pending: code("[PENDING]"),
  failed: code("[FAILED]"),
  dry: code("[DRY RUN]"),
  risk: (level: string) => code(`[RISK: ${level}]`),
} as const;

function statusTag(status: string): Md {
  switch (status) {
    case "ACTIVE":
      return TAG.active;
    case "PAUSED":
      return TAG.paused;
    case "ENDING":
      return TAG.ending;
    default:
      return TAG.purged;
  }
}

function age(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

function rulesLine(rules: EffectiveRules): string {
  const parts: string[] = [];
  if (rules.profitAbsolute.enabled) parts.push(`>${formatSol(rules.profitAbsolute.thresholdLamports)} SOL`);
  if (rules.profitPercent.enabled) parts.push(`+${rules.profitPercent.bps / 100}%`);
  if (rules.idle.enabled) parts.push(`idle ${rules.idle.minutes >= 60 ? `${rules.idle.minutes / 60}h` : `${rules.idle.minutes}m`}`);
  return parts.length ? parts.join(" · ") : "manual only";
}

export function welcomeView(args: { vault: ColdVaultConfig | null; vaultAddress: string | null; sessions: number }): Md {
  return lines(
    md`*FLOSS* · floss your wallet`,
    "",
    "Burner session wallets that sweep profit to cold storage, revoke approvals, and close dead token accounts. Your vault key never touches this bot.",
    "",
    pre(
      table([
        ["vault", args.vaultAddress ? shortAddr(args.vaultAddress, 6) : "not set"],
        ["sessions", String(args.sessions)],
      ]),
    ),
    args.vaultAddress ? null : md`Step 1: ${code("/set_cold_wallet <address>")}`,
    md`${args.vaultAddress ? "Next" : "Step 2"}: ${code("/session new")}`,
    "",
    md`${code("/floss")} clean \\+ sweep   ${code("/scan_token <mint>")} risk check   ${code("/help")} everything else`,
  );
}

export function helpView(): Md {
  const rows: Array<[string, string]> = [
    ["/session", "list sessions"],
    ["/session new [label]", "new burner wallet"],
    ["/floss [label]", "revoke + close + sweep profit"],
    ["/floss [label] all", "empty the wallet into vault"],
    ["/floss [label] preview", "dry run, nothing sent"],
    ["/sweep_now", "alias of /floss"],
    ["/scan_token <mint|tx|link>", "pre-flight risk scan"],
    ["/scan_token <mint> fresh", "skip cache"],
    ["/set_cold_wallet <addr>", "set vault (24h lock on change)"],
    ["/set_cold_wallet cancel", "cancel pending change"],
    ["/rules", "show auto-sweep rules"],
    ["/rules profit 1.5", "sweep when >1.5 SOL above float"],
    ["/rules percent 50", "sweep gains past +50%"],
    ["/rules idle 24h", "empty after 24h idle (off: 0)"],
    ["/rules float 0.5", "SOL kept for trading"],
    ["/rules revoke on|off", "auto-revoke delegates"],
    ["/pause  /resume", "stop / start auto-sweeps"],
    ["/audit", "last 10 actions"],
    ["/referrals", "your link + earnings"],
  ];
  return lines(md`*FLOSS* · commands`, pre(table(rows, 29)));
}

export function sessionCard(args: {
  session: SessionWallet;
  balance: bigint | null;
  rules: EffectiveRules;
  vaultAddress: string | null;
  cluster: string;
  userPaused: boolean;
}): Md {
  const s = args.session;
  const rows: Array<[string, string]> = [
    ["wallet", shortAddr(s.address, 6)],
    ["balance", args.balance === null ? "?" : `${formatSol(args.balance)} SOL`],
    ["float", `${formatSol(s.workingFloatLamports)} SOL`],
    ["vault", args.vaultAddress ? shortAddr(args.vaultAddress, 6) : "not set"],
    ["auto", args.userPaused || s.status === "PAUSED" ? "paused" : rulesLine(args.rules)],
    ["revoke", args.rules.revokeOnSight ? "on sight" : "manual"],
  ];
  if (s.lastSweepAt) rows.push(["last floss", `${age(Date.now() - s.lastSweepAt.getTime())} ago`]);
  return lines(
    md`*${s.label}* ${statusTag(s.status)}`,
    pre(table(rows)),
    md`${code(s.address)}  ${link("explorer", explorerAccount(s.address, args.cluster))}`,
  );
}

export function sessionsListView(items: Array<{ session: SessionWallet; balance: bigint | null }>): Md {
  if (items.length === 0) return lines(md`*FLOSS* · no sessions`, md`Start one: ${code("/session new")}`);
  const rows: Array<[string, string]> = items.map(({ session, balance }) => [
    session.label,
    `${session.status.padEnd(7)} ${balance === null ? "?" : `${formatSol(balance)} SOL`}  ${shortAddr(session.address)}`,
  ]);
  return lines(md`*FLOSS* · sessions`, pre(table(rows)));
}

export function newSessionView(session: SessionWallet): Md {
  return lines(
    md`*${session.label}* ${TAG.active}`,
    "Fund this address, then import its key into your trading bot. Profit above the float goes to your vault automatically.",
    "",
    code(session.address),
    "",
    md`Key: tap ${bold("Export key")} below\\. It self\\-destructs after 60s\\.`,
  );
}

export function fundedView(label: string, balance: bigint, float: bigint, threshold: bigint | null): Md {
  const rows: Array<[string, string]> = [
    ["deposit", `${formatSol(balance)} SOL`],
    ["float", `${formatSol(float)} SOL (kept for trading)`],
    ["sweeps at", threshold === null ? "manual only" : `${formatSol(float + threshold)} SOL`],
  ];
  return lines(md`*${label}* ${TAG.active} funded`, pre(table(rows)), md`Change with ${code("/rules float <sol>")} or ${code("/rules profit <sol>")}`);
}

export function exportKeyView(label: string, secret: string): Md {
  return lines(
    md`*${label}* · private key`,
    spoiler(raw(code(secret).value)),
    "",
    italic("Deleting in 60 seconds. Paste it into one bot only. If that bot leaks it, Floss still sweeps profit out and you lose at most the float."),
  );
}

export function flossResultView(label: string, r: FlossReport, cluster: string): Md {
  const head = r.dryRun ? TAG.dry : r.pending ? TAG.pending : TAG.flossed;
  const rows: Array<[string, string]> = [];
  if (r.revoked.length) rows.push(["[CLEANED]", `${r.revoked.length} delegate${r.revoked.length === 1 ? "" : "s"} revoked`]);
  if (r.closed.length) rows.push(["[RENT RECLAIMED]", `${r.closed.length} account${r.closed.length === 1 ? "" : "s"}  +${formatSol(r.rentReclaimedLamports, 6)} SOL`]);
  if (r.harvested) rows.push(["[HARVESTED]", `${r.harvested} withheld-fee account${r.harvested === 1 ? "" : "s"}`]);
  if (r.unwrappedLamports > 0n) rows.push(["[UNWRAPPED]", `${formatSol(r.unwrappedLamports)} wSOL -> vault`]);
  if (r.evacuated.length) rows.push(["[MOVED]", `${r.evacuated.length} token balance${r.evacuated.length === 1 ? "" : "s"} -> vault`]);
  if (r.sweptLamports > 0n) rows.push(["[SWEPT]", `${formatSol(r.sweptLamports)} SOL -> vault`]);
  if (rows.length === 0) rows.push(["[CLEAN]", "nothing to do"]);
  rows.push(["network", `${formatSol(r.feesLamports + r.tipLamports, 6)} SOL${r.tipLamports > 0n ? ` (tip ${formatSol(r.tipLamports, 6)})` : ""}`]);
  if (r.serviceFee && r.serviceFee.fee > 0n) rows.push(["floss fee", `${formatSol(r.serviceFee.fee, 6)} SOL`]);
  if (r.via !== "none") rows.push(["route", r.via === "jito" ? "jito bundle" : "rpc"]);
  if (r.balanceAfter !== null) rows.push(["left", `${formatSol(r.balanceAfter)} SOL`]);

  const skipped = r.skipped.slice(0, 5).map((s) => `- ${shortAddr(s.mint)}: ${s.reason}`);
  const residual = r.residualTokenAccounts.filter((t) => t.amount > 0n);

  return lines(
    md`*${label}* ${head}`,
    pre(table(rows, 18)),
    skipped.length ? lines(bold("skipped"), pre(skipped.join("\n"))) : null,
    residual.length && r.mode === "full"
      ? md`${residual.length} token balance${residual.length === 1 ? "" : "s"} still in the wallet\\. Use ${code("/floss " + label + " all")} with evacuation, or sell first\\.`
      : null,
    ...r.notes.map((n) => italic(n)),
    r.signatures.length
      ? lines(...r.signatures.slice(-3).map((sig, i) => link(`tx ${i + 1}: ${shortAddr(sig, 6)}`, explorerTx(sig, cluster))))
      : null,
  );
}

export function flossQueuedView(label: string, mode: string): Md {
  return md`*${label}* ${TAG.pending}\nflossing \\(${mode}\\)…`;
}

export function errorView(title: string, detail: string): Md {
  return lines(md`*${title}* ${TAG.failed}`, detail);
}

const SEV_TAG: Record<Severity, string> = { critical: "CRIT", high: "HIGH", medium: "MED ", low: "LOW ", info: "INFO" };

export function riskReportView(r: RiskReport, opts: { cached: boolean; ageMs: number; cluster: string }): Md {
  const header =
    r.kind === "mint"
      ? md`*SCAN* · ${r.mint?.knownAs ?? shortAddr(r.target, 6)} ${TAG.risk(r.level)}${opts.cached ? raw(` ${TAG.cached.value} ${esc(age(opts.ageMs))}`) : null}`
      : md`*SCAN* · transaction ${TAG.risk(r.level)}`;

  const facts: Array<[string, string]> = [["score", `${r.score}/100`]];
  if (r.mint) {
    facts.push(["program", r.mint.program]);
    facts.push(["mint auth", r.mint.mintAuthority ? shortAddr(r.mint.mintAuthority) : "none"]);
    facts.push(["freeze auth", r.mint.freezeAuthority ? shortAddr(r.mint.freezeAuthority) : "none"]);
    if (r.mint.extensions.length) facts.push(["extensions", r.mint.extensions.slice(0, 4).join(", ")]);
  }
  if (r.simulation) {
    const sim = r.simulation;
    facts.push(["simulation", !sim.ran ? `skipped (${sim.error ?? "n/a"})` : sim.ok ? "passes" : "REVERTS"]);
    if (sim.probe) facts.push(["sell probe", `${sim.probe.effectiveTaxBps / 100}% lost in transfer`]);
  }
  if (r.programs?.length) facts.push(["programs", r.programs.slice(0, 4).map((p) => (p.length > 20 ? shortAddr(p) : p)).join(", ")]);

  const findingLines = r.findings
    .filter((f) => f.severity !== "info" || r.findings.length <= 3)
    .slice(0, 8)
    .map((f) => `${SEV_TAG[f.severity]}  ${f.title}`);

  const changes = (r.balanceChanges ?? []).slice(0, 6).map((c) =>
    c.kind === "SOL"
      ? `SOL      ${c.delta >= 0n ? "+" : ""}${formatSol(c.delta, 6)}`
      : `${shortAddr(c.mint ?? "", 4).padEnd(9)}${c.delta >= 0n ? "+" : ""}${formatTokenAmount(c.delta, c.decimals ?? 0)}`,
  );

  const top = r.findings.find((f) => f.severity === "critical" || f.severity === "high");
  return lines(
    header,
    pre(table(facts)),
    findingLines.length ? pre(findingLines.join("\n")) : pre("no findings"),
    changes.length ? lines(bold("balance changes"), pre(changes.join("\n"))) : null,
    top ? italic(top.detail) : null,
    r.kind === "mint" ? md`${code(r.target)}  ${link("explorer", explorerAccount(r.target, opts.cluster))}` : null,
  );
}

export function vaultView(vault: ColdVaultConfig | null, effective: string | null): Md {
  if (!vault) return lines(md`*VAULT* · not set`, md`${code("/set_cold_wallet <address>")}`);
  const rows: Array<[string, string]> = [["active", shortAddr(effective ?? vault.address, 6)]];
  if (vault.pendingAddress && vault.pendingEffectiveAt && vault.pendingEffectiveAt.getTime() > Date.now()) {
    rows.push(["pending", shortAddr(vault.pendingAddress, 6)]);
    rows.push(["unlocks in", age(vault.pendingEffectiveAt.getTime() - Date.now())]);
  }
  return lines(md`*VAULT*`, pre(table(rows)), code(effective ?? vault.address));
}

export function rulesView(rules: EffectiveRules, floatLamports: bigint | null): Md {
  const rows: Array<[string, string]> = [
    ["profit", rules.profitAbsolute.enabled ? `sweep when > ${formatSol(rules.profitAbsolute.thresholdLamports)} SOL above float` : "off"],
    ["percent", rules.profitPercent.enabled ? `sweep gains past +${rules.profitPercent.bps / 100}%` : "off"],
    ["idle", rules.idle.enabled ? `empty after ${rules.idle.minutes} min quiet` : "off"],
    ["revoke", rules.revokeOnSight ? "on sight" : "manual"],
    ["close empty", rules.closeEmpty.enabled ? `after ${rules.closeEmpty.quietMinutes} min quiet` : "off"],
  ];
  if (floatLamports !== null) rows.push(["float", `${formatSol(floatLamports)} SOL`]);
  return lines(md`*RULES*`, pre(table(rows)));
}

export function auditView(rows: Array<{ action: string; status: string; createdAt: Date; lamports: bigint | null }>): Md {
  if (rows.length === 0) return md`*AUDIT* · empty`;
  const body = rows.map((r) => {
    const t = r.createdAt.toISOString().slice(5, 16).replace("T", " ");
    return `${t}  ${r.status.padEnd(7)} ${r.action}${r.lamports ? ` ${formatSol(r.lamports)}` : ""}`;
  });
  return lines(md`*AUDIT*`, pre(body.join("\n")));
}

export function referralView(args: {
  link: string;
  invited: number;
  earned: bigint;
  owed: bigint;
  feeBps: number;
  shareBps: number;
}): Md {
  const sharePct = (args.feeBps / 100) * (args.shareBps / 10_000);
  const rows: Array<[string, string]> = [
    ["invited", String(args.invited)],
    ["earned", `${formatSol(args.earned, 6)} SOL`],
  ];
  if (args.owed > 0n) rows.push(["pending", `${formatSol(args.owed, 6)} SOL`]);
  rows.push(["you get", `${args.shareBps / 100}% of every fee (${sharePct}% of volume)`]);
  return lines(
    md`*REFERRALS*`,
    pre(table(rows)),
    code(args.link),
    italic("Paid straight to your vault inside your friends' sweep transactions."),
  );
}
