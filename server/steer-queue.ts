// Queue-and-steer for busy 1:1 bots.
//
// A message sent to a bot mid-turn used to bounce with a 409. Now it waits
// here until the bot settles, then lands in the thread and runs as ONE
// follow-up turn whose prompt is the queued texts joined with newlines.
//
// The queue is memory-only and is NOT in `messages[]` while the current
// turn is running: appending immediately would make the queued line the
// active leaf, so remaining tool/assistant events of *this* turn would
// hang off a user line the model has not seen. The composer shows a pending
// chip until drain appends the words.
//
// The queue used to be lost on restart with no trace at all — the person's
// words simply vanished (F7). It is now mirrored to disk on every change, so
// a restart can put them back where the person left them. The mirror is a
// convenience copy: a missing or unreadable file only costs the queue, never
// the app.
//
// Unlike the delegation drain, an interrupted or failed turn does NOT
// discard this queue: delegations are a bot's fan-out (dropping them on
// Stop is a safety property), but these are the user's own words —
// stop-then-steer (queue a correction, hit Stop, the correction runs) is
// the feature.

import { unlinkSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";
import { newId } from "./contracts.ts";
import type { BotRecord, Message, MessageOrigin } from "./store.ts";

/** The slice of Store this module needs — narrow so tests can fake it. */
export interface SteerStore {
  bot(id: string): BotRecord | null;
  taskByThread?(botId:string,threadId:string):{busy?:boolean}|undefined;
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message;
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null;
}

interface QueueEntry {
  /** Kept beside the threadId because the settle that frees the bot can
   * happen on a DIFFERENT thread (a room turn) — drain matches on "this
   * queue's bot is idle now", which needs the bot, not the settling thread. */
  botId: string;
  items: Array<{ messageId: string; text: string; prompt: string; replyToId?: string; sendId?: string; origin?: MessageOrigin }>;
}

const queues = new Map<string, QueueEntry>(); // threadId → waiting sends

/** Set by the server so every change is mirrored to disk. Tests leave it
 * unset and keep the old memory-only behaviour. */
let mirror: ((entries: Array<[string, QueueEntry]>) => void) | null = null;

export function setSteerQueueMirror(write: ((entries: Array<[string, QueueEntry]>) => void) | null): void {
  mirror = write;
}

function saveQueues(): void {
  try { mirror?.(Array.from(queues)); } catch { /* the queue is not worth failing a send over */ }
}

/** The server's mirror writer. The file holds the person's own unsent words,
 * so it is owner only like the rest of the data folder's records (upstream
 * #1620 left it at the 0644 default); an empty queue leaves no file. */
export function writeSteerQueueMirror(file: string, entries: Array<[string, QueueEntry]>): void {
  if (entries.length === 0) { try { unlinkSync(file); } catch { /* already gone */ } return; }
  writeFileAtomic(file, JSON.stringify(entries), { mode: 0o600 });
}

/** Put a mirrored queue back after a restart. Returns the entries, newest
 * thread last, so the caller can decide what to do with them. */
export function restoreSteerQueues(entries: Array<[string, QueueEntry]>): void {
  for (const [threadId, entry] of entries) {
    if (!threadId || !entry || typeof entry.botId !== "string" || !Array.isArray(entry.items) || entry.items.length === 0) continue;
    queues.set(threadId, {
      botId: entry.botId,
      items: entry.items
        .filter((item) => item && typeof item.text === "string" && typeof item.messageId === "string")
        .map((item) => ({
          messageId: item.messageId,
          text: item.text,
          prompt: typeof item.prompt === "string" ? item.prompt : item.text,
          ...(item.replyToId ? { replyToId: item.replyToId } : {}),
          ...(item.sendId ? { sendId: item.sendId } : {}),
        })),
    });
  }
}

export type SteerQueueEntries = Array<[string, QueueEntry]>;

export interface QueuedSteer {
  id: string;
}

/** Hold a mid-turn send off the transcript until drain. */
export function queueSteeredMessage(
  botId: string,
  threadId: string,
  text: string,
  options: { prompt?: string; replyToId?: string; sendId?: string; origin?: MessageOrigin } = {},
): QueuedSteer {
  const id = newId();
  const entry = queues.get(threadId) ?? { botId, items: [] };
  // A thread cannot legitimately change owners. Refuse to merge unrelated
  // queues even if a corrupt caller reuses a thread id.
  if (entry.botId !== botId) throw new Error("queued task belongs to another bot");
  entry.items.push({
    messageId: id,
    text,
    prompt: options.prompt ?? text,
    replyToId: options.replyToId,
    sendId: options.sendId,
    ...(options.origin ? { origin: options.origin } : {}),
  });
  queues.set(threadId, entry);
  saveQueues();
  return { id };
}

/** Drain every queue whose bot is idle: append the held lines (leaf is now
 * the finished turn's last item), then one run per thread whose prompt is
 * the texts joined with newlines. `userMessage` is the last appended line
 * so startTurn does not duplicate it; `excludeIds` is every drained line
 * so transcript-replay adapters do not also see earlier queued texts.
 * Entries leave the map BEFORE running so a settle racing another settle
 * can never fire the same queue twice. */
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
): void {
  // deleting only the entry being visited is safe under Map iteration
  for (const [threadId, entry] of queues) {
    const bot = store.bot(entry.botId);
    if (!bot) {
      // the bot was deleted while messages waited — nothing left to steer
      queues.delete(threadId);
      saveQueues();
      continue;
    }
    if (store.taskByThread ? store.taskByThread(bot.id,threadId)?.busy : bot.busy) continue;
    if (isBlocked?.(entry.botId, threadId)) continue;
    // committed to draining: the entry leaves the map before anything runs,
    // so a settle racing another settle can never fire the same queue twice
    queues.delete(threadId);
    saveQueues();
    const appended: Message[] = [];
    for (const item of entry.items) {
      // queueId is the pending-chip identity from the 202; append still
      // assigns a fresh transcript id so replay/exclude keep using message.id.
      appended.push(
        store.appendMessage(threadId, {
          role: "user",
          kind: "text",
          text: item.text,
          replyToId: item.replyToId,
          sendId: item.sendId,
          queueId: item.messageId,
          ...(item.origin ? { origin: item.origin } : {}),
        }),
      );
    }
    const last = appended.at(-1);
    if (!last) continue;
    const prompt = entry.items.map((item) => item.prompt).join("\n");
    void run(
      entry.botId,
      threadId,
      prompt,
      last,
      appended.map((message) => message.id),
    );
  }
}

/** Find the receipt for a retry whose message is still waiting to drain. */
export function queuedSteeredMessage(
  botId: string,
  threadId: string,
  sendId: string,
): { id: string; text: string; replyToId?: string } | null {
  const entry = queues.get(threadId);
  if (!entry || entry.botId !== botId) return null;
  const item = entry.items.find((candidate) => candidate.sendId === sendId);
  return item ? { id: item.messageId, text: item.text, replyToId: item.replyToId } : null;
}

/** Drop one waiting send owned by this bot so it never drains. The queue id
 * is stable even if the bot switches away from the task while the request is
 * in flight. Returns false when it was already drained, belongs to another
 * bot, or a restart lost the in-memory auto-run intent. */
export function cancelSteeredMessage(botId: string, messageId: string): boolean {
  for (const [threadId, entry] of queues) {
    if (entry.botId !== botId) continue;
    const items = entry.items.filter((item) => item.messageId !== messageId);
    if (items.length === entry.items.length) continue;
    if (items.length === 0) queues.delete(threadId);
    else queues.set(threadId, { botId: entry.botId, items });
    saveQueues();
    return true;
  }
  return false;
}

/** Test helper: how many messages remain queued for a thread. */
export function _queuedCount(threadId: string): number {
  return queues.get(threadId)?.items.length ?? 0;
}
