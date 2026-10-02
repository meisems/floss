import { InlineKeyboard } from "grammy";
import type { FlossOutcome } from "../jobs/types.ts";
import { errorView, flossResultView } from "./views.ts";
import { bold, code, lines, md, type Md } from "./md.ts";

/** Callback data is capped at 64 bytes; cuid ids are 25 chars, so these stay well under. */
export const CB = {
  floss: (id: string) => `f:${id}`,
  flossAll: (id: string) => `fa:${id}`,
  preview: (id: string) => `fp:${id}`,
  open: (id: string) => `o:${id}`,
  export: (id: string) => `x:${id}`,
  exportConfirm: (id: string) => `xc:${id}`,
  end: (id: string) => `e:${id}`,
  endConfirm: (id: string) => `ec:${id}`,
  endEvacuate: (id: string) => `ee:${id}`,
  forcePurge: (id: string) => `fx:${id}`,
  forcePurgeConfirm: (id: string) => `fxc:${id}`,
  pause: (id: string) => `p:${id}`,
  resume: (id: string) => `r:${id}`,
  /** Address fits in callback data (3 + 44 bytes). The confirm is only honoured for 10 minutes. */
  vaultConfirm: (addr: string) => `vc:${addr}`,
  cancel: () => "nop",
};

export function sessionKeyboard(id: string, status: string): InlineKeyboard {
  const kb = new InlineKeyboard().text("Floss", CB.floss(id)).text("Preview", CB.preview(id)).row();
  kb.text("Export key", CB.export(id));
  kb.text(status === "PAUSED" ? "Resume auto" : "Pause auto", status === "PAUSED" ? CB.resume(id) : CB.pause(id)).row();
  kb.text("Empty to vault", CB.flossAll(id)).text("End session", CB.end(id));
  return kb;
}

export function renderOutcome(outcome: FlossOutcome, sessionId: string, cluster: string): { text: Md; keyboard?: InlineKeyboard } {
  if (!outcome.ok || !outcome.report) {
    const hint =
      outcome.errorKind === "funds"
        ? "Top the wallet up with a little SOL for fees, then retry."
        : outcome.errorKind === "compromised"
          ? "Automation for this session is paused. Do not send more funds to it."
          : outcome.errorKind === "busy"
            ? "Another floss is in progress. It will retry automatically."
            : outcome.errorKind === "config"
              ? "Fix the configuration, then retry."
              : "";
    return { text: lines(errorView(`${outcome.label} · floss`, outcome.error ?? "failed"), hint || null) };
  }

  const body = flossResultView(outcome.label, outcome.report, cluster);
  if (outcome.purged) {
    return { text: lines(body, "", md`${code("[PURGED]")} session ended\\. Key destroyed\\. Do not send funds to this address again\\.`) };
  }
  if (outcome.blockedPurge) {
    const kb = new InlineKeyboard()
      .text("Move tokens + end", CB.endEvacuate(sessionId))
      .row()
      .text("Purge anyway", CB.forcePurge(sessionId))
      .text("Keep session", CB.cancel());
    return {
      text: lines(body, "", bold("Not purged: the wallet still holds assets."), "Move token balances to the vault first, or purge anyway (anything left becomes unrecoverable)."),
      keyboard: kb,
    };
  }
  return { text: body };
}
