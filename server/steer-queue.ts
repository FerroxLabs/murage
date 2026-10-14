// Queue-and-steer for busy 1:1 bots.
//
// A message sent to a bot mid-turn waits until the bot settles, then lands in
// the thread and runs as ONE follow-up turn whose prompt is the queued texts
// joined with newlines.
//
// The waiting messages are rows of the owner_sends table (server/send-store.ts),
// the same SQLite file as the transcript. That table is the only record: there
// is no memory-only queue and no side file to fall behind it. A message is
// accepted by committing its row, so one that was acknowledged is never lost to
// a restart; drain reads the rows in the order they were accepted and writes a
// durable "dispatched" marker before anything runs.
//
// The rows are NOT in `messages[]` while the current turn is running: appending
// immediately would make the queued line the active leaf, so remaining
// tool/assistant events of *this* turn would hang off a user line the model has
// not seen. The composer shows a pending chip until drain appends the words.
//
// Unlike the delegation drain, an interrupted or failed turn does NOT discard
// these: they are the user's own words (stop-then-steer is the feature).

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { sendFingerprint } from "./send-idempotency.ts";
import { sendStore, pendingItem } from "./send-store.ts";
import type { BotRecord, Message, MessageOrigin } from "./store.ts";

/** The slice of Store this module needs — narrow so tests can fake it. */
export interface SteerStore {
  bot(id: string): BotRecord | null;
  taskByThread?(botId:string,threadId:string):{busy?:boolean}|undefined;
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">, stableId?: string): Message;
  /** Lets drain reuse a line already in the transcript (a steer the engine later refused). */
  messagesFor?(threadId: string): Message[];
  /** One row by id (Store.messageById): preferred over `messagesFor`, which reads the whole thread. */
  messageById?(threadId: string, messageId: string): Message | undefined;
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null;
}

/** Told which thread's waiting list just changed, so every client's chips can follow. */
export function setSteerQueueObserver(fn: ((threadId: string) => void) | null): void {
  sendStore.setObserver(fn);
}

/** The legacy queued-messages.json shape, read once at startup to carry a 1.0.1 folder forward. */
export interface LegacyQueueEntry {
  botId: string;
  items: Array<{ messageId: string; text: string; prompt: string; replyToId?: string; sendId?: string; origin?: MessageOrigin; existingMessageId?: string }>;
}
export type SteerQueueEntries = Array<[string, LegacyQueueEntry]>;

export interface QueuedSteer {
  id: string;
}

/** Hold a send off the transcript until drain. With `rowSeq` the already-accepted
 * row moves to the queue in place (keeping its position in line); otherwise a
 * new row is accepted straight into the queue. Throws if the row cannot be
 * written, and then the send must not be acknowledged. */
export function queueSteeredMessage(
  botId: string,
  threadId: string,
  text: string,
  options: { prompt?: string; replyToId?: string; sendId?: string; origin?: MessageOrigin; existingMessageId?: string; rowSeq?: number } = {},
): QueuedSteer {
  if (options.rowSeq !== undefined) {
    const row = sendStore.bySeq(options.rowSeq);
    if (!row) throw new Error("send record is gone");
    if (row.ownerId !== botId) throw new Error("queued task belongs to another bot");
    sendStore.queue(row.seq, options.existingMessageId, options.prompt);
    return { id: row.queueId };
  }
  const accepted = sendStore.accept({
    kind: "bot", ownerId: botId, threadId, text, status: "queued",
    ...(options.sendId ? { sendId: options.sendId } : {}),
    fingerprint: sendFingerprint(text, options.replyToId),
    ...(options.replyToId ? { replyToId: options.replyToId } : {}),
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.prompt ? { prompt: options.prompt } : {}),
  });
  if (accepted.kind === "conflict") throw new Error("sendId already belongs to another message");
  if (accepted.kind === "new" && options.existingMessageId) sendStore.queue(accepted.row.seq, options.existingMessageId);
  return { id: accepted.row.queueId };
}

/** Drain every queue whose bot is idle: append the held lines (leaf is now
 * the finished turn's last item), then one run per thread whose prompt is
 * the texts joined with newlines. `userMessage` is the last appended line
 * so startTurn does not duplicate it; `excludeIds` is every drained line
 * so transcript-replay adapters do not also see earlier queued texts.
 * The dispatched marker is committed for every row BEFORE anything runs, so
 * a settle racing another settle can never fire the same row twice, and a
 * crash after the marker never sends it again. */
export function drainSteeredMessages(
  store: SteerStore,
  run: (
    botId: string,
    threadId: string,
    prompt: string,
    userMessage: Message,
    excludeIds: string[],
  ) => void | Promise<void>,
  /** Holds a queue the thread's own busy flag cannot see, such as the bot
   * speaking in a room turn (upstream OpenMausBot #1664). */
  isBlocked?: (botId: string, threadId: string) => boolean,
  /** The images a held line binds to the conversation as it lands, exactly
   * as a line sent to an idle bot does (turn-images.ts promote). */
  bindAttachments?: (threadId: string, text: string) => NonNullable<Message["attachments"]>,
): void {
  for (const threadId of sendStore.queuedThreads("bot")) {
    let waiting;
    try { waiting = sendStore.queuedRows(threadId, "bot"); } catch { continue; }
    const first = waiting[0];
    if (!first) continue;
    const bot = store.bot(first.ownerId);
    if (!bot) {
      // the bot was deleted while messages waited: nothing can steer them, and only the owner may
      // discard words, so each is kept as a refused row (never cleared by the system)
      for (const row of waiting) { try { sendStore.refuse(row.seq); } catch { /* retried at the next drain */ } }
      continue;
    }
    if (store.taskByThread ? store.taskByThread(bot.id, threadId)?.busy : bot.busy) continue;
    if (isBlocked?.(first.ownerId, threadId)) continue;
    // The turn is over, so an unconfirmed steer can no longer be folded into it:
    // it stays unconfirmed (never re-sent) and stops holding the line.
    sendStore.releaseThreadLate(threadId);
    const rows = sendStore.drainable(threadId, "bot");
    if (!rows.length) continue;
    // committed to draining: the marker is durable before anything runs
    try { sendStore.markDispatchedMany(rows.map((row) => row.seq)); } catch { continue; }
    const appended: Message[] = [];
    // The engine is told only what committed: a row whose line could not be written became a
    // refused chip, and its words must never also run (the chip would offer a duplicate).
    const committed: typeof rows = [];
    for (const row of rows) {
      let line: Message | undefined;
      if (row.existingMessageId) {
        // A line already in the transcript (a steer the engine later declined):
        // it runs from where it is, never a second copy.
        line = store.messageById ? store.messageById(threadId, row.existingMessageId) : store.messagesFor?.(threadId).find((message) => message.id === row.existingMessageId);
      }
      if (!line) {
        let attachments: NonNullable<Message["attachments"]> = [];
        try { attachments = bindAttachments?.(threadId, row.text) ?? []; } catch { attachments = []; }
        try {
          // queueId is the pending-chip identity from the 202; append still
          // assigns a fresh transcript id so replay/exclude keep using message.id.
          // The row becomes "started" in the SAME transaction as the line it became.
          const lineId = randomUUID();
          line = sendStore.settleWithLine(row.seq, "started", lineId, () => store.appendMessage(threadId, {
            role: "user",
            kind: "text",
            text: row.text,
            ...(attachments.length ? { attachments } : {}),
            replyToId: row.replyToId ?? undefined,
            sendId: row.sendId ?? undefined,
            queueId: row.queueId,
            ...(row.origin ? { origin: row.origin as MessageOrigin } : {}),
          }, lineId));
        } catch {
          // The line could not be written (the thread went away, or the write failed): the accepted
          // words are kept as a refused row, a chip the owner can send again or dismiss. Pending
          // sends and startup recovery both list refused rows.
          try { sendStore.refuse(row.seq); } catch { /* the row stays dispatched; the next start shows it */ }
          continue;
        }
      }
      appended.push(line);
      committed.push(row);
      // A line already in the transcript (a refused steer) is its own receipt.
      if (row.existingMessageId && line.id === row.existingMessageId) {
        try { sendStore.settle(row.seq, "started", line.id); } catch { /* the transcript line carries the queue id; recovery finds it */ }
      }
    }
    const last = appended.at(-1);
    if (!last) continue;
    const prompt = committed.map((row) => row.prompt ?? row.text).join("\n");
    // The held lines are in the transcript before the run starts, so a run that
    // cannot start (a session reset that times out, say) loses nothing: the words
    // stay visible and the caller shows why. A rejection never escapes unhandled.
    try {
      void Promise.resolve(run(
        first.ownerId,
        threadId,
        prompt,
        last,
        appended.map((message) => message.id),
      )).catch(() => {});
    } catch { /* same: the lines are already recorded */ }
  }
}

/** Find the receipt for a retry whose message is still waiting to drain. */
export function queuedSteeredMessage(
  botId: string,
  threadId: string,
  sendId: string,
): { id: string; text: string; replyToId?: string } | null {
  const row = sendStore.bySendId(threadId, sendId);
  if (!row || row.ownerId !== botId || row.status !== "queued") return null;
  return { id: row.queueId, text: row.text, ...(row.replyToId ? { replyToId: row.replyToId } : {}) };
}

/** Drop one waiting send owned by this bot so it never drains. The row stays,
 * as a cancelled record, so a late retry of the same send id can never run it.
 * Returns false when it was already drained, belongs to another bot, or never
 * existed. */
export function cancelSteeredMessage(botId: string, queueId: string): boolean {
  return sendStore.cancel(botId, queueId) !== null;
}

/** Test helper: how many messages remain queued for a thread. */
export function _queuedCount(threadId: string): number {
  return sendStore.queuedCount(threadId, "bot");
}

/** How many sends are waiting on a thread. A new send never overtakes them. */
export function queuedSteerCount(threadId: string): number {
  return sendStore.queuedCount(threadId, "bot");
}

/** The waiting sends of a thread as every client should show them. */
export function pendingSteerItems(threadId: string): Array<{ queueId: string; sendId?: string; text: string }> {
  return sendStore.queuedRows(threadId, "bot").map((row) => {
    const { state: _state, ...item } = pendingItem(row);
    return item;
  });
}

/** Every thread with something waiting (for the hydrate snapshot). */
export function steerQueueThreads(): string[] {
  return sendStore.queuedThreads("bot");
}

/** What the legacy import did. `complete` is true only when every waiting line is durably in its
 * thread (or was already), so the caller may then, and only then, remove the old file. */
export interface LegacyImportResult { added: number; complete: boolean; problems: string[] }

/** The identity a legacy line keeps in its thread. The same line always gets the same id, so an
 * import interrupted after its writes and before the file was removed finds them again instead of
 * adding them a second time. `occurrence` separates identical texts that carry no ids at all. */
export function legacyLineId(threadId: string, item: LegacyQueueEntry["items"][number], occurrence: number): string {
  const digest = createHash("sha256").update(JSON.stringify([threadId, item.messageId ?? null, item.sendId ?? null, item.text, occurrence])).digest("hex");
  return `legacy-${digest.slice(0, 40)}`;
}

/** Newest rows a mirrored-queue item's send id is looked for in. */
const MIRRORED_QUEUE_ROWS = 1000;

/** Startup import of a 1.0.1 folder's queued-messages.json (the old side file): each waiting line goes back into its thread as the
 * message it was. A line already in the transcript (a late-rejected steer carries its
 * existingMessageId; any line may already be there by its sendId or its legacy identity) is never
 * appended a second time. One thread's lines are written in ONE transaction: all of them or none.
 * A thread the registry does not recognise is NOT assumed deleted (the registry may be missing): its
 * lines are kept and `complete` is false, unless `ownerDeleted` proves the owner deleted it. Any
 * other failure also leaves `complete` false and the file in place for the next start. */
export function recoverMirroredQueue(
  waiting: SteerQueueEntries,
  store: {
    appendMessage(threadId: string, message: any, stableId?: string): unknown;
    messagesFor?(threadId: string): ReadonlyArray<{ id: string; sendId?: string }>;
    /** Preferred over `messagesFor` (Store.messageById / Store.newestMatching): a keyed read and the newest rows, never the thread. */
    messageById?(threadId: string, messageId: string): { id: string } | undefined;
    newestMatching?(threadId: string, test: (message: { id: string; sendId?: string }) => boolean, limit?: number): { id: string } | undefined;
  },
  options: { atomically?: <T>(work: () => T) => T; threadIsLive?: (threadId: string) => boolean; ownerDeleted?: (threadId: string) => boolean } = {},
): LegacyImportResult {
  const atomically = options.atomically ?? (<T,>(work: () => T): T => sendStore.within(work));
  let added = 0;
  const problems: string[] = [];
  for (const [threadId, entry] of waiting) {
    if (!threadId || !entry || !Array.isArray(entry.items)) continue;
    if (options.threadIsLive && !options.threadIsLive(threadId)) {
      // A thread the registry does not know may be a deleted one, or the registry may simply be missing or
      // unreadable right now (bots.json absent at startup). Only a durable record that the OWNER deleted it
      // lets the words go; otherwise they stay in the file and the next start looks again.
      if (options.ownerDeleted?.(threadId)) continue;
      problems.push(`${threadId}: conversation not recognised; its words are kept`);
      continue;
    }
    try {
      let threadAdded = 0;
      atomically(() => {
        const seen = new Map<string, number>();
        for (const item of entry.items) {
          if (!item || typeof item.text !== "string" || !item.text) continue;
          const key = JSON.stringify([item.messageId ?? null, item.sendId ?? null, item.text]);
          const occurrence = seen.get(key) ?? 0;
          seen.set(key, occurrence + 1);
          // A line the queue wrote just before the 1.0.1 folder was closed is one of the newest rows: found by id, or by send id among the newest rows.
          const rows = store.messageById && store.newestMatching ? undefined : store.messagesFor?.(threadId) ?? [];
          const hasId = (id: string): boolean => rows ? rows.some((message) => message.id === id) : Boolean(store.messageById!(threadId, id));
          if (item.existingMessageId && hasId(item.existingMessageId)) continue;
          if (item.sendId && (rows ? rows.some((message) => message.sendId === item.sendId) : Boolean(store.newestMatching!(threadId, (message) => message.sendId === item.sendId, MIRRORED_QUEUE_ROWS)))) continue;
          const lineId = legacyLineId(threadId, item, occurrence);
          if (hasId(lineId)) continue;
          store.appendMessage(threadId, {
            role: "user",
            kind: "text",
            text: item.text,
            ...(item.replyToId ? { replyToId: item.replyToId } : {}),
            ...(item.sendId ? { sendId: item.sendId } : {}),
            // words that waited stay as proven as they were sent (final round, Kimi L2)
            ...(item.origin ? { origin: item.origin } : {}),
          }, lineId);
          threadAdded++;
        }
      });
      added += threadAdded;
    } catch (error) {
      problems.push(`${threadId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { added, complete: problems.length === 0, problems };
}

/** Read and import the legacy file; remove it only when every line is accounted for. A file that
 * cannot be read or understood, or an import that did not finish, stays on disk and is logged, and
 * the next start tries again (the import is idempotent). */
export function importLegacyQueueFile(
  file: string,
  store: Parameters<typeof recoverMirroredQueue>[1],
  options: Parameters<typeof recoverMirroredQueue>[2] & { log?: (message: string) => void } = {},
): { imported: number; removed: boolean } {
  const log = options.log ?? ((message: string) => console.error(message));
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { imported: 0, removed: false };
    log(`queued-messages.json could not be read; it is kept and will be tried again at the next start: ${error instanceof Error ? error.message : String(error)}`);
    return { imported: 0, removed: false };
  }
  let waiting: unknown;
  try { waiting = JSON.parse(raw); }
  catch {
    log("queued-messages.json is not valid JSON; it is kept (your words are still in it) and will be tried again at the next start");
    return { imported: 0, removed: false };
  }
  if (!Array.isArray(waiting)) {
    log("queued-messages.json has an unexpected shape; it is kept and will be tried again at the next start");
    return { imported: 0, removed: false };
  }
  const result = recoverMirroredQueue(waiting as SteerQueueEntries, store, options);
  if (!result.complete) {
    log(`queued-messages.json: ${result.problems.length} conversation(s) could not be restored (${result.problems.join("; ")}); the file is kept and will be tried again at the next start`);
    return { imported: result.added, removed: false };
  }
  try { unlinkSync(file); return { imported: result.added, removed: true }; }
  catch { return { imported: result.added, removed: false }; } // harmless: the next start finds every line already there
}
