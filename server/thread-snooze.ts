// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Conversation snooze storage and routes. The rules, and why a decision can
// never sit behind a snooze, are in shared/thread-snooze.ts.
//
// Stored next to the Inbox's own item snoozes (inbox_item_state) in
// messages.db, keyed by thread, so a bot's conversation and a channel's
// conversation are the same thing here and neither record shape changes.
import type { DatabaseSync } from "node:sqlite";
import { THREAD_SNOOZE_MAX_MS, type ThreadSnooze } from "../shared/thread-snooze.ts";

export class ThreadSnoozeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function initializeThreadSnooze(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS thread_snooze (
    thread_id TEXT PRIMARY KEY, snoozed_until INTEGER NOT NULL, snoozed_at INTEGER NOT NULL)`);
  // Until new activity: 1 when the snooze waits for news, snoozed_until then
  // being its latest wake. Added after 0.1.60, so an existing database gains it.
  const columns = db.prepare("PRAGMA table_info(thread_snooze)").all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === "until_activity")) db.exec("ALTER TABLE thread_snooze ADD COLUMN until_activity INTEGER");
}

type SnoozeRow = { thread_id: string; snoozed_until: number; until_activity: number | null };
const snoozeOf = (row: SnoozeRow): ThreadSnooze =>
  ({ threadId: row.thread_id, until: row.snoozed_until, ...(row.until_activity === 1 ? { untilActivity: true as const } : {}) });

/** Snoozes still in effect at `now`, oldest wake first. An expired row is
 *  not in effect even before a sweep removes it, so a missed sweep can never
 *  keep a conversation quiet past the owner's time. */
export function listThreadSnoozes(db: DatabaseSync, now: number): ThreadSnooze[] {
  const rows = db.prepare("SELECT thread_id, snoozed_until, until_activity FROM thread_snooze WHERE snoozed_until>? ORDER BY snoozed_until, thread_id")
    .all(now) as SnoozeRow[];
  return rows.map(snoozeOf);
}

export function hasThreadSnooze(db: DatabaseSync, threadId: string): boolean {
  return db.prepare("SELECT 1 FROM thread_snooze WHERE thread_id=?").get(threadId) !== undefined;
}

/** Snooze until a time, or with "activity" until the conversation's next
 *  new activity (and at most the usual 30 days). */
export function snoozeThread(db: DatabaseSync, threadId: string, until: number | "activity", context: { now: number; owed: boolean }): ThreadSnooze {
  const untilActivity = until === "activity";
  const wake = untilActivity ? context.now + THREAD_SNOOZE_MAX_MS : until;
  if (!Number.isSafeInteger(wake) || wake <= context.now || wake > context.now + THREAD_SNOOZE_MAX_MS) {
    throw new ThreadSnoozeError(400, "Pick a time in the next 30 days.");
  }
  // Same principle as the Inbox: something owed is answered, never put off.
  if (context.owed) throw new ThreadSnoozeError(409, "This conversation is waiting on your answer. Answer it first, then snooze it.");
  db.prepare(`INSERT INTO thread_snooze(thread_id,snoozed_until,snoozed_at,until_activity) VALUES(?,?,?,?)
    ON CONFLICT(thread_id) DO UPDATE SET snoozed_until=excluded.snoozed_until, snoozed_at=excluded.snoozed_at, until_activity=excluded.until_activity`)
    .run(threadId, wake, context.now, untilActivity ? 1 : null);
  return { threadId, until: wake, ...(untilActivity ? { untilActivity: true as const } : {}) };
}

/** New activity in a conversation: something the owner did not write. A
 *  reply, a card or a run report from a bot, or words the owner cannot have
 *  written: from an unproven caller, or in a channel person's own
 *  conversation (`fromChannelPerson`; the webhook writes those without an
 *  origin). A working step (a tool chip, a screen frame) is not news, and
 *  the owner's own words never wake their own snooze. */
export function isSnoozeActivity(message: { role: "bot" | "user"; kind: string; origin?: string }, fromChannelPerson = false): boolean {
  if (message.role === "user") return fromChannelPerson || message.origin === "unproven";
  return message.kind !== "activity" && message.kind !== "screen";
}

const FINISHED_ROUTINE = new Set(["completed", "failed", "cancelled", "missed"]);
type RunCard = { role: "bot" | "user"; kind: string; routineRun?: { status: string }; goalRun?: { status: string } };
/** A run report updated in place is news when the run just finished: a
 *  routine reaching its end, or a channel goal run leaving "working".
 *  Progress, a replayed finished card, or a patch with no earlier copy is
 *  not. (A card that needs the owner wakes every snooze on its own.) */
export function isSnoozeReport(before: RunCard | undefined, after: RunCard): boolean {
  if (!before || after.role !== "bot" || before.kind !== after.kind) return false;
  if (after.kind === "routine.run") {
    return !!after.routineRun && FINISHED_ROUTINE.has(after.routineRun.status) && !FINISHED_ROUTINE.has(before.routineRun?.status ?? "");
  }
  if (after.kind === "goal.run") return before.goalRun?.status === "working" && !!after.goalRun && after.goalRun.status !== "working";
  return false;
}

type SnoozeChange =
  | { type: "message"; threadId: string; message: RunCard & { origin?: string } }
  | { type: "message.patch"; threadId: string; message: RunCard; before?: RunCard }
  | { type: string; threadId?: string };
/** The store listener's rule for "until new activity": a new message that is
 *  activity, or a run report patched into its end. `channelPerson` says
 *  whether a conversation belongs to a person on a channel. */
export function wakesActivitySnooze(change: SnoozeChange, channelPerson: (threadId: string) => boolean): boolean {
  if (change.type === "message" && "message" in change) {
    return isSnoozeActivity(change.message, change.message.role === "user" && channelPerson(change.threadId));
  }
  if (change.type === "message.patch" && "message" in change) return isSnoozeReport(change.before, change.message);
  return false;
}

/** Ends this conversation's snooze if it was waiting for new activity. */
export function wakeThreadOnActivity(db: DatabaseSync, threadId: string): boolean {
  return Number(db.prepare("DELETE FROM thread_snooze WHERE thread_id=? AND until_activity=1").run(threadId).changes) > 0;
}

export function unsnoozeThread(db: DatabaseSync, threadId: string): boolean {
  return Number(db.prepare("DELETE FROM thread_snooze WHERE thread_id=?").run(threadId).changes) > 0;
}

export type ThreadWakeReason = "time" | "owed" | "gone";

/** Ends every snooze whose time has come, whose conversation now owes the
 *  owner something, or whose conversation no longer exists. Each is removed
 *  once, so the caller's "mark it unread" happens once. */
export function wakeThreadSnoozes(db: DatabaseSync, context: { now: number; owed: ReadonlySet<string>; known: ReadonlySet<string> }):
  Array<{ threadId: string; reason: ThreadWakeReason }> {
  const rows = db.prepare("SELECT thread_id, snoozed_until FROM thread_snooze").all() as Array<{ thread_id: string; snoozed_until: number }>;
  const woken: Array<{ threadId: string; reason: ThreadWakeReason }> = [];
  for (const row of rows) {
    const reason: ThreadWakeReason | null = !context.known.has(row.thread_id) ? "gone"
      : context.owed.has(row.thread_id) ? "owed"
        : row.snoozed_until <= context.now ? "time" : null;
    if (!reason) continue;
    unsnoozeThread(db, row.thread_id);
    woken.push({ threadId: row.thread_id, reason });
  }
  return woken;
}

export interface ThreadSnoozeDeps {
  now(): number;
  /** Every conversation the owner has, bots' and channels' alike. */
  threads(): ReadonlySet<string>;
  /** Conversations with something owed to the owner right now. */
  owed(): ReadonlySet<string>;
  /** A snooze ended by itself; "gone" is never passed here. */
  wake(threadId: string, reason: Exclude<ThreadWakeReason, "gone">): void;
}

/** Sweep, then report. Every read goes through here, so whatever the owner
 *  sees is already woken. */
export function sweepThreadSnoozes(db: DatabaseSync, deps: ThreadSnoozeDeps): ThreadSnooze[] {
  const now = deps.now();
  if (db.prepare("SELECT 1 FROM thread_snooze LIMIT 1").get() === undefined) return [];
  for (const { threadId, reason } of wakeThreadSnoozes(db, { now, owed: deps.owed(), known: deps.threads() })) {
    if (reason !== "gone") deps.wake(threadId, reason);
  }
  return listThreadSnoozes(db, now);
}

const ROUTE = /^\/api\/thread-snoozes(?:\/([^/]+))?$/;

/** `null` when the path is not this module's. Desktop only, reads included:
 *  a paired device sees a scoped slice of the workspace and has no business
 *  learning which of the owner's conversations are quiet. */
export function threadSnoozeRequest(db: DatabaseSync,
  request: { method: string; path: string; body?: unknown; desktop: boolean }, deps: ThreadSnoozeDeps):
  { status: number; body: unknown } | null {
  const match = ROUTE.exec(request.path);
  if (!match) return null;
  if (!request.desktop) return { status: 404, body: { error: "no such route" } };
  let threadId: string | undefined;
  try { threadId = match[1] === undefined ? undefined : decodeURIComponent(match[1]); }
  catch { return { status: 400, body: { error: "Invalid conversation." } }; }
  try {
    if (request.method === "GET" && threadId === undefined) return { status: 200, body: { snoozes: sweepThreadSnoozes(db, deps) } };
    if (threadId === undefined || (request.method !== "PUT" && request.method !== "DELETE")) {
      return { status: 405, body: { error: "Choose snooze or unsnooze." } };
    }
    if (!deps.threads().has(threadId)) return { status: 404, body: { error: "That conversation is gone." } };
    if (request.method === "PUT") {
      const body = request.body;
      const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : null;
      const activity = keys?.length === 1 && keys[0] === "untilActivity";
      if (!keys || !(activity || (keys.length === 1 && keys[0] === "until"))) {
        return { status: 400, body: { error: "Send only the time to snooze until, or untilActivity." } };
      }
      if (activity && (body as { untilActivity?: unknown }).untilActivity !== true) return { status: 400, body: { error: "untilActivity must be true." } };
      snoozeThread(db, threadId, activity ? "activity" : (body as { until?: unknown }).until as number, { now: deps.now(), owed: deps.owed().has(threadId) });
    } else {
      unsnoozeThread(db, threadId);
    }
    return { status: 200, body: { snoozes: sweepThreadSnoozes(db, deps) } };
  } catch (error) {
    if (error instanceof ThreadSnoozeError) return { status: error.status, body: { error: error.message } };
    throw error;
  }
}
