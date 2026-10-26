// Follow-up messages sent while a channel is working.
//
// The renderer must hand these to the harness immediately. Keeping them in a
// mounted composer loses the auto-send intent on navigation, reconnect, or a
// renderer reload. They stay off the transcript until the active channel
// operation settles so the current responder cannot appear to answer words it
// never saw.

import { sendFingerprint } from "./send-idempotency.ts";
import { sendStore, type SendRow } from "./send-store.ts";
import type { MessageOrigin } from "./store.ts";

// The waiting sends are rows of owner_sends (server/send-store.ts), the same
// SQLite file as the transcript: accepting one commits a row, so a send the
// person was told about survives a restart. There is no memory-only queue.

interface ChannelQueueItem {
  id: string;
  text: string;
  replyToId?: string;
  sendId?: string;
  mode: "chat" | "goal";
  origin?: MessageOrigin;
  /** The one member this send is pinned to (a room-call hand-down). */
  responderBotId?: string;
}

/** Told which thread's waiting list changed, so every client's chips follow. */
export function setChannelQueueObserver(fn: ((threadId: string) => void) | null): void { sendStore.setObserver(fn); }

export interface QueuedChannelMessage {
  id: string;
  /** The row's state: "cancelled" means an earlier attempt of this send id was cancelled. */
  status: string;
}

function itemOf(row: SendRow): ChannelQueueItem {
  return {
    id: row.queueId,
    text: row.text,
    replyToId: row.replyToId ?? undefined,
    sendId: row.sendId ?? undefined,
    // a typed stop row is born finished and never queued; only "goal" changes how a queued item runs
    mode: row.mode === "goal" ? "goal" : "chat",
    ...(row.origin ? { origin: row.origin as MessageOrigin } : {}),
    ...(row.responderId ? { responderBotId: row.responderId } : {}),
  };
}

/** Accept a send into the queue. Throws when the row cannot be written; the
 * send must then be refused, never acknowledged. */
export function queueChannelMessage(
  groupId: string,
  threadId: string,
  text: string,
  options: {
    replyToId?: string;
    sendId?: string;
    mode?: "chat" | "goal";
    origin?: MessageOrigin;
    responderBotId?: string;
    /** The owner's validated Send again on a restore-held chip, with the restore generation the chip carried. */
    resend?: boolean;
    restoreGen?: string;
    /** With resend: the stop token the chip carried, and the press's own action token. */
    stopGen?: string;
    actionId?: string;
  } = {},
): QueuedChannelMessage {
  const accepted = sendStore.accept({
    kind: "group", ownerId: groupId, threadId, text, status: "queued",
    ...(options.sendId ? { sendId: options.sendId } : {}),
    fingerprint: sendFingerprint(text, options.replyToId, options.mode ?? "chat", options.responderBotId),
    ...(options.replyToId ? { replyToId: options.replyToId } : {}),
    mode: options.mode ?? "chat",
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.responderBotId ? { responderId: options.responderBotId } : {}),
    ...(options.resend ? { resend: true, ...(options.restoreGen ? { restoreGen: options.restoreGen } : {}), ...(options.stopGen ? { stopGen: options.stopGen } : {}), ...(options.actionId ? { actionId: options.actionId } : {}) } : {}),
  });
  if (accepted.kind === "conflict") throw new Error("sendId already belongs to another message");
  return { id: accepted.row.queueId, status: accepted.row.status };
}

/** Find the stable receipt for an HTTP retry that is still waiting. */
export function queuedChannelMessage(
  groupId: string,
  threadId: string,
  sendId: string,
): ChannelQueueItem | null {
  const row = sendStore.bySendId(threadId, sendId);
  if (!row || row.kind !== "group" || row.ownerId !== groupId || row.status !== "queued") return null;
  return itemOf(row);
}

/** Whether a queued message is still waiting (not yet started or cancelled). */
export function channelMessageQueued(groupId: string, queueId: string): boolean {
  const row = sendStore.byQueueId(groupId, queueId);
  return Boolean(row && row.kind === "group" && row.status === "queued");
}

/** Remove one queued message before it starts. */
export function cancelChannelMessage(groupId: string, queueId: string): boolean {
  const row = sendStore.byQueueId(groupId, queueId);
  if (!row || row.kind !== "group") return false;
  return sendStore.cancel(groupId, queueId) !== null;
}

/** What starting a queued room message came to: the transcript line it landed as, or a refusal. */
export type ChannelRunOutcome = { messageId: string } | { refused: true };

/**
 * Start at most one follow-up per idle channel. The dispatched marker is
 * committed first, so repeated settle notifications are harmless and a crash
 * after it never sends the message again.
 *
 * The row settles "started" only with the id of the transcript line it became.
 * A message the room could not start (the responder left, the room is mid setup,
 * the engine refused) is NOT settled as started: it becomes "refused", keeping
 * its words, and the person sees it as a chip they can send again or dismiss.
 */
export function drainChannelMessages(
  isWorking: (groupId: string) => boolean,
  run: (input: ChannelQueueItem & { groupId: string; threadId: string }) => ChannelRunOutcome,
): void {
  for (const threadId of sendStore.queuedThreads("group")) {
    const rows = sendStore.drainable(threadId, "group");
    const row = rows[0];
    if (!row) continue;
    if (isWorking(row.ownerId)) continue;
    try { sendStore.markDispatchedMany([row.seq]); } catch { continue; }
    const item = itemOf(row);
    let outcome: ChannelRunOutcome;
    try { outcome = run({ ...item, groupId: row.ownerId, threadId }); } catch { outcome = { refused: true }; }
    try {
      if ("messageId" in outcome) sendStore.settle(row.seq, "started", outcome.messageId);
      else sendStore.refuse(row.seq);
    } catch { /* the row stays dispatched; the next start finds the line (or shows the message) */ }
  }
}

/** Test helper. */
export function _queuedChannelCount(threadId: string): number {
  return sendStore.queuedCount(threadId, "group");
}

/** The waiting sends of a thread as every client should show them. */
export function pendingChannelItems(threadId: string): Array<{ queueId: string; sendId?: string; text: string }> {
  return sendStore.queuedRows(threadId, "group").map((row) => ({ queueId: row.queueId, ...(row.sendId ? { sendId: row.sendId } : {}), text: row.text }));
}

export function channelQueueThreads(): string[] { return sendStore.queuedThreads("group"); }
