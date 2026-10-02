import { runtimeConfig } from "../config.ts";
import type { Env } from "../env.ts";
import { getDb } from "../db/client.ts";
import { renderOutcome } from "../bot/render.ts";
import { deleteMessage, editMd, sendMd } from "../telegram/notify.ts";
import { errorMessage, log } from "../lib/util.ts";
import type { FlossJob, JobMessage } from "./types.ts";

const MAX_BUSY_RETRIES = 6;

async function handleFloss(env: Env, msg: Message<JobMessage>, job: FlossJob): Promise<void> {
  const db = getDb(env.DB);
  const session = await db.sessionWallet.findUnique({ where: { id: job.sessionId } });
  if (!session) {
    msg.ack();
    return;
  }
  const stub = env.WALLET_SESSION.get(env.WALLET_SESSION.idFromName(session.address));
  const outcome = await stub.runFloss(job);

  if (outcome.errorKind === "busy" && msg.attempts < MAX_BUSY_RETRIES) {
    msg.retry({ delaySeconds: 10 * msg.attempts });
    return;
  }

  if (job.chatId) {
    const { text, keyboard } = renderOutcome(outcome, session.id, runtimeConfig(env).cluster);
    if (job.messageId) await editMd(env, job.chatId, job.messageId, text, keyboard);
    else await sendMd(env, job.chatId, text, keyboard);
  }
  msg.ack();
}

/**
 * Queue consumer. Messages for different wallets run in parallel; the WalletSession Durable Object
 * serialises work per wallet, and idempotency keys make redelivery harmless.
 */
export async function handleQueue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
  await Promise.all(
    batch.messages.map(async (msg) => {
      const job = msg.body;
      try {
        if (job.type === "delete_message") {
          await deleteMessage(env, job.chatId, job.messageId);
          msg.ack();
          return;
        }
        if (job.type === "floss") {
          await handleFloss(env, msg, job);
          return;
        }
        log("warn", "unknown job type", { job });
        msg.ack();
      } catch (err) {
        log("error", "job failed", { type: job.type, attempts: msg.attempts, err: errorMessage(err) });
        // Exponential-ish backoff; after max_retries the message lands in the dead-letter queue.
        msg.retry({ delaySeconds: Math.min(300, 15 * 2 ** (msg.attempts - 1)) });
      }
    }),
  );
}
