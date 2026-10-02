import type { FlossMode, FlossReport } from "../engine/SweepEngine.ts";

export type FlossOrigin = "manual" | "auto" | "end" | "api";

export interface FlossJob {
  type: "floss";
  sessionId: string;
  mode: FlossMode;
  evacuateTokens: boolean;
  dryRun: boolean;
  origin: FlossOrigin;
  /** Same key => same result. Queue redeliveries and double taps never run twice. */
  idempotencyKey: string;
  /** Purge the key afterwards if the wallet ends empty. */
  endSession?: boolean;
  /** Purge even if token balances remain (user confirmed twice). */
  forcePurge?: boolean;
  /** Telegram message to edit with the result. */
  chatId?: string;
  messageId?: number;
}

export interface DeleteMessageJob {
  type: "delete_message";
  chatId: string;
  messageId: number;
}

export type JobMessage = FlossJob | DeleteMessageJob;

export interface FlossOutcome {
  ok: boolean;
  label: string;
  report?: FlossReport;
  error?: string;
  errorKind?: "busy" | "config" | "compromised" | "funds" | "purged" | "failed";
  purged?: boolean;
  /** Set when the session was asked to end but still holds assets. */
  blockedPurge?: boolean;
}
