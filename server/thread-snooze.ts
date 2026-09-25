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
}

/** Snoozes still in effect at `now`, oldest wake first. An expired row is
 *  not in effect even before a sweep removes it, so a missed sweep can never
 *  keep a conversation quiet past the owner's time. */
export function listThreadSnoozes(db: DatabaseSync, now: number): ThreadSnooze[] {
  const rows = db.prepare("SELECT thread_id, snoozed_until FROM thread_snooze WHERE snoozed_until>? ORDER BY snoozed_until, thread_id")
    .all(now) as Array<{ thread_id: string; snoozed_until: number }>;
  return rows.map(row => ({ threadId: row.thread_id, until: row.snoozed_until }));
}

export function hasThreadSnooze(db: DatabaseSync, threadId: string): boolean {
  return db.prepare("SELECT 1 FROM thread_snooze WHERE thread_id=?").get(threadId) !== undefined;
}

export function snoozeThread(db: DatabaseSync, threadId: string, until: number, context: { now: number; owed: boolean }): ThreadSnooze {
  if (!Number.isSafeInteger(until) || until <= context.now || until > context.now + THREAD_SNOOZE_MAX_MS) {
    throw new ThreadSnoozeError(400, "Pick a time in the next 30 days.");
  }
  // Same principle as the Inbox: something owed is answered, never put off.
  if (context.owed) throw new ThreadSnoozeError(409, "This conversation is waiting on your answer. Answer it first, then snooze it.");
  db.prepare(`INSERT INTO thread_snooze(thread_id,snoozed_until,snoozed_at) VALUES(?,?,?)
    ON CONFLICT(thread_id) DO UPDATE SET snoozed_until=excluded.snoozed_until, snoozed_at=excluded.snoozed_at`)
    .run(threadId, until, context.now);
  return { threadId, until };
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
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "until")) {
        return { status: 400, body: { error: "Send only the time to snooze until." } };
      }
      snoozeThread(db, threadId, (body as { until?: unknown }).until as number, { now: deps.now(), owed: deps.owed().has(threadId) });
    } else {
      unsnoozeThread(db, threadId);
    }
    return { status: 200, body: { snoozes: sweepThreadSnoozes(db, deps) } };
  } catch (error) {
    if (error instanceof ThreadSnoozeError) return { status: error.status, body: { error: error.message } };
    throw error;
  }
}
