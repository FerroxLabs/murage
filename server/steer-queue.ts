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
import { sendStore, pendingItem, type SendRow } from "./send-store.ts";
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

/** What one drain runs: the leading run of plain owner rows (they join, as always), or exactly the first row when it is a
 * share or ask-intent. Third-party words never join an owner line and never ride in an owner turn; the rest waits for the next drain. */
export function drainBatch(rows: SendRow[]): SendRow[] {
  const first = rows[0];
  if (!first) return [];
  if (first.via !== null) return [first];
  const end = rows.findIndex((row) => row.via !== null);
  return end === -1 ? rows : rows.slice(0, end);
}

/** What a queued start resolves to when the thread was taken (or briefly unavailable) and nothing ran: the rows it drained go back
 * into the queue where they were (same seq, so nothing accepted later passes them) and the thread is tried again. Any other outcome
 * (the turn was admitted, or the start failed for a reason of its own) is final for those rows. */
export const START_REQUEUE = "requeue" as const;

/** Threads whose drained batch is being started right now: from the drain until the start settles (admitted, failed or re-queued).
 * Nothing else drains on such a thread, so a later batch can never be admitted ahead of it. A start always settles: the
 * queued start bounds its waits before admission (the writer gate's ceiling, and PREPARE_DEADLINE_MS for the thread fill in
 * ask-turn-device.ts runQueuedStart); a fill that outlasts its deadline re-queues the rows. */
const starting = new Map<string, symbol>();
/** Threads whose last start was re-queued: when they may be tried next, and the one timer that tries them. */
const retries = new Map<string, { attempt: number; at: number; timer?: ReturnType<typeof setTimeout> }>();
/** Threads with lines waiting while a turn holds the thread: one timer that looks again, in case that turn's end does not drain. */
const watches = new Map<string, ReturnType<typeof setTimeout>>();
const RETRY_MIN_MS = 200;
const RETRY_MAX_MS = 2_000;

/** True while a drained batch on this thread is being started: a new send must wait behind it, never start ahead of it. */
export function queuedStartPending(threadId: string): boolean {
  return starting.has(threadId);
}

function clearRetry(threadId: string): void {
  const retry = retries.get(threadId);
  if (retry?.timer) clearTimeout(retry.timer);
  retries.delete(threadId);
}

/** Test helper: forget every start in flight and every retry timer. */
export function _resetQueuedStarts(): void {
  starting.clear();
  for (const threadId of [...retries.keys()]) clearRetry(threadId);
  for (const timer of watches.values()) clearTimeout(timer);
  watches.clear();
}

/** The rows of a start that never ran go back to the queue in place: the same seq (so they stay ahead of everything accepted after
 * them), the same via, device and origin, and the transcript line each already has (the next drain runs from it, never a copy). */
function requeueInPlace(rows: SendRow[], lines: Message[]): void {
  rows.forEach((row, i) => {
    const line = lines[i];
    if (!line) return;
    try { sendStore.requeueStarted(row.seq, line.id, line.text ?? row.text, row.prompt ?? undefined); } catch { /* the row moved on (cancelled or settled): nothing to put back */ }
  });
}

/** Try a re-queued thread again after a short back-off (doubling, capped), then keep looking at the cap while its line still waits.
 * Only a new refusal sets a back-off; a look that finds the thread held leaves any drain free to start the line at once. The one timer
 * ends when the thread starts its rows again or has nothing left waiting. */
function scheduleRetry(threadId: string, again: () => void, refused: boolean): void {
  const retry = retries.get(threadId) ?? { attempt: 0, at: 0 };
  if (retry.timer) clearTimeout(retry.timer);
  const delay = refused ? Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** retry.attempt) : RETRY_MAX_MS;
  if (refused) { retry.attempt += 1; retry.at = Date.now() + delay; }
  const watching = watches.get(threadId);
  if (watching) { clearTimeout(watching); watches.delete(threadId); }
  retry.timer = setTimeout(() => {
    retry.timer = undefined;
    if (retries.get(threadId) !== retry) return;
    retry.at = 0;
    try { again(); } catch { /* the next look tries again */ }
    if (retries.get(threadId) !== retry || retry.timer || starting.has(threadId)) return;
    let waiting = 0;
    try { waiting = sendStore.queuedCount(threadId, "bot"); } catch { waiting = 1; }
    if (waiting > 0) scheduleRetry(threadId, again, false); else clearRetry(threadId);
  }, delay);
  retry.timer.unref?.();
  retries.set(threadId, retry);
}

/** Lines wait on a thread a turn holds: look again at the cap, once at a time, until they drain or are gone. */
function watch(threadId: string, again: () => void): void {
  if (watches.has(threadId) || retries.has(threadId)) return;
  const timer = setTimeout(() => { watches.delete(threadId); again(); }, RETRY_MAX_MS);
  timer.unref?.();
  watches.set(threadId, timer);
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
    /** Which kind of batch this is: a share or ask-intent line runs alone, from the phone named here. */
    batch: { via: "share" | "ask-intent" | null; viaDevice: string | null },
  ) => void | Promise<unknown>,
  /** Holds a queue the thread's own busy flag cannot see, such as the bot
   * speaking in a room turn (upstream OpenMausBot #1664). */
  isBlocked?: (botId: string, threadId: string) => boolean,
  /** The images a held line binds to the conversation as it lands, exactly
   * as a line sent to an idle bot does (turn-images.ts promote). */
  bindAttachments?: (threadId: string, text: string) => NonNullable<Message["attachments"]>,
  /** True while a turn holds the thread (the server's direct run, which the busy flag can lag): a re-queued start is not tried
   * into it, and a start that was admitted does not drain its thread again (that turn's own end drains). */
  isOccupied?: (botId: string, threadId: string) => boolean,
): void {
  const again = () => drainSteeredMessages(store, run, isBlocked, bindAttachments, isOccupied);
  const occupied = (botId: string, threadId: string): boolean => { try { return isOccupied?.(botId, threadId) ?? false; } catch { return true; } };
  // One pass for one thread. True when a share or ask-intent batch was refused whole: nothing ran, so the owner lines queued behind it
  // are drainable now and the thread goes again (each pass settles at least the rows it refused, so the passes end).
  const drainOne = (threadId: string): boolean => {
    let waiting;
    try { waiting = sendStore.queuedRows(threadId, "bot"); } catch { return false; }
    const first = waiting[0];
    if (!first) return false;
    const bot = store.bot(first.ownerId);
    if (!bot) {
      // the bot was deleted while messages waited: nothing can steer them, and only the owner may
      // discard words, so each is kept as a refused row (never cleared by the system)
      for (const row of waiting) { try { sendStore.refuse(row.seq); } catch { /* retried at the next drain */ } }
      return false;
    }
    if (store.taskByThread ? store.taskByThread(bot.id, threadId)?.busy : bot.busy) return false;
    if (isBlocked?.(first.ownerId, threadId)) return false;
    if (starting.has(threadId)) return false;
    // a re-queued start goes again only once its back-off has passed (its timer tries it then)
    const retry = retries.get(threadId);
    if (retry && Date.now() < retry.at) return false;
    // a turn holds the thread though the busy flag does not show it yet: nothing is drained into it (its end drains; a timer looks too)
    if (occupied(first.ownerId, threadId)) { watch(threadId, again); return false; }
    // The turn is over, so an unconfirmed steer can no longer be folded into it:
    // it stays unconfirmed (never re-sent) and stops holding the line.
    sendStore.releaseThreadLate(threadId);
    const rows = drainBatch(sendStore.drainable(threadId, "bot"));
    if (!rows.length) return false;
    // committed to draining: the marker is durable before anything runs
    try { sendStore.markDispatchedMany(rows.map((row) => row.seq)); } catch { return false; }
    const appended: Message[] = [];
    // The engine is told only what committed: a row whose line could not be written became a
    // refused chip, and its words must never also run (the chip would offer a duplicate).
    const committed: typeof rows = [];
    for (const row of rows) {
      let line: Message | undefined;
      if (row.via !== null) {
        // Re-read at the drain, not only at admission: a via row runs only while it is still queue-only, still the same
        // via and still unproven. Anything else is third-party words that lost their fence, so they never run.
        let fresh: SendRow | undefined;
        try { fresh = sendStore.bySeq(row.seq); } catch { fresh = undefined; }
        // A stored file never rides as an owner-style attachment (Message.attachments is images only; the owner's composer
        // sends files as text paths), and a damaged column is never run with a guess: both fail closed.
        if (!fresh || !fresh.queueOnly || fresh.via !== row.via || fresh.origin !== "unproven" || fresh.attachmentsMalformed || fresh.attachments?.some((item) => item.kind !== "image")) {
          try { sendStore.refuse(row.seq); } catch { /* the row stays dispatched; the next start shows it */ }
          continue;
        }
      }
      if (row.existingMessageId) {
        // A line already in the transcript (a steer the engine later declined):
        // it runs from where it is, never a second copy.
        line = store.messageById ? store.messageById(threadId, row.existingMessageId) : store.messagesFor?.(threadId).find((message) => message.id === row.existingMessageId);
      }
      if (!line) {
        let attachments: NonNullable<Message["attachments"]> = [];
        if (row.attachments) {
          // a via row's images were stored with it: they bind without any pending registration, so a restart loses nothing
          attachments = row.attachments.flatMap((item) => item.kind === "image" ? [{ kind: "image" as const, path: item.path, mime: item.mime }] : []);
        } else {
          try { attachments = bindAttachments?.(threadId, row.text) ?? []; } catch { attachments = []; }
        }
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
            ...(row.via ? { via: row.via } : {}),
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
    if (!last) return rows[0]!.via !== null;
    const prompt = committed.map((row) => row.prompt ?? row.text).join("\n");
    // The held lines are in the transcript before the run starts, so a run that cannot start loses nothing: the words stay visible
    // and the caller shows why. A start is async (the thread is not taken until it is admitted): until it settles nothing else drains on
    // this thread, so a later batch is never admitted ahead of it. A start refused because the thread was taken puts its rows back
    // where they were and is tried again; a rejection never escapes unhandled.
    let started: unknown;
    try {
      started = run(
        first.ownerId,
        threadId,
        prompt,
        last,
        appended.map((message) => message.id),
        { via: first.via, viaDevice: first.via ? first.viaDevice : null },
      );
    } catch { /* same: the lines are already recorded */ }
    if (started && typeof (started as PromiseLike<unknown>).then === "function") {
      const token = Symbol(threadId);
      starting.set(threadId, token);
      const ownerId = first.ownerId;
      const settle = (outcome: unknown) => {
        if (starting.get(threadId) !== token) return;
        starting.delete(threadId);
        if (outcome === START_REQUEUE) {
          requeueInPlace(committed, appended);
          scheduleRetry(threadId, again, true);
          return;
        }
        clearRetry(threadId);
        // admitted: the turn now holds the thread and its own end drains; anything else (failed, or a turn already over) drains now
        if (!occupied(ownerId, threadId)) again();
      };
      Promise.resolve(started).then(settle, () => settle(undefined));
    } else {
      clearRetry(threadId);
    }
    return false;
  };
  for (const threadId of sendStore.queuedThreads("bot")) {
    for (let pass = 0; pass < 64 && drainOne(threadId); pass++) { /* the next pass sees the rows behind a refused via batch */ }
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
