// What a steer finally came to, when the engine answered after the response
// deadline. The send was already recorded once as "unconfirmed" (never re-sent
// on its own, so it could not run twice); the late answer decides it:
//   delivered -> confirmed in place.
//   rejected  -> the engine proved it never took the words. Its row goes back to
//                the queue IN PLACE (same position in line, so it runs before
//                any message sent after it) and runs from the line already in
//                the transcript, never a second copy. If a later message has
//                already gone to the engine, the row is marked failed instead:
//                it is never queued behind a message the person sent after it.
// Either way the send is never left "unconfirmed" for good.

import type { SteerDelivery } from "./contracts.ts";

export interface LateSteerInput {
  botId: string;
  threadId: string;
  /** The durable send row (server/send-store.ts). */
  seq?: number;
  messageId?: string;
}

export interface LateSteerDeps {
  botExists(botId: string): boolean;
  patchMessage(threadId: string, messageId: string, patch: Record<string, unknown>): unknown;
  /** Record the outcome on the row. */
  delivered(seq: number, messageId?: string): void;
  /** A later message already went to the engine ahead of this one. */
  passedByLater(threadId: string, seq: number): boolean;
  requeue(seq: number, messageId: string): void;
  /** `messageId` is the transcript line that holds the words. */
  fail(seq: number, threadId: string, messageId: string): void;
  /** The line no longer holds up the messages sent after it. */
  release(seq: number): void;
  drain(): void;
}

export function reconcileLateSteer(deps: LateSteerDeps, input: LateSteerInput, late: SteerDelivery): void {
  try {
    if (late === "uncertain") return;
    try {
      if (late === "delivered") {
        if (input.messageId) deps.patchMessage(input.threadId, input.messageId, { steerUnconfirmed: false });
        if (input.seq !== undefined) deps.delivered(input.seq, input.messageId);
        return;
      }
      if (!input.messageId || input.seq === undefined) return;
      deps.patchMessage(input.threadId, input.messageId, { steered: false, steerUnconfirmed: false, steerId: undefined });
      if (!deps.botExists(input.botId) || deps.passedByLater(input.threadId, input.seq)) {
        deps.fail(input.seq, input.threadId, input.messageId);
        return;
      }
      deps.requeue(input.seq, input.messageId);
    } finally {
      if (input.seq !== undefined) deps.release(input.seq);
    }
    deps.drain();
  } catch { /* reconciliation never throws into the engine */ }
}
