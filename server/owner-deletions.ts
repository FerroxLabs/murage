// SPDX-License-Identifier: AGPL-3.0-or-later
import { endLiveRequestsOfThread } from "./handoff-pair.ts";
import type { DatabaseSync } from "node:sqlite";

/**
 * The durable record that the OWNER deleted a conversation (a bot, a channel, or one of their
 * tasks). It is written in the same transaction that removes the conversation's rows
 * (message-db.ts deleteThread), so it exists exactly when the deletion committed.
 *
 * It is the ONLY proof that lets code drop an owner's words that wait in a send row, a room request
 * or the legacy queued-messages.json. A conversation merely absent from bots.json or groups.json
 * (the file is missing, unreadable, or only partly loaded) is NOT deleted: its words are kept.
 */
export const OWNER_DELETIONS_DDL = "CREATE TABLE IF NOT EXISTS owner_deleted_threads (thread_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL)";
export function initializeOwnerDeletions(db: DatabaseSync): void {
  db.exec(OWNER_DELETIONS_DDL);
}

/** The key under which the deletion of a whole channel is recorded (its threads are recorded under their own ids). */
export const groupDeletionKey = (groupId: string): string => `group:${groupId}`;

/** The key under which the deletion of a whole bot is recorded: the only proof that a bot id missing from the registry is gone (a registry
 * that is not loaded yet, or only partly, also lacks it). Work addressed to a bot with no such record is kept, never settled. */
export const botDeletionKey = (botId: string): string => `bot:${botId}`;

/** Hand-offs queued from a deleted conversation must not outlive its deletion record. Called in the transaction that writes the record:
 * the queue rows go (started ones too: their turn needs no second chance once its conversation is gone), in the same commit. A database
 * without the table has nothing to remove. */
function dropHandoffsOfDeletedThread(db: DatabaseSync, threadId: string): void {
  if (db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='pending_delegations'").get()) {
    // The request of a hand-off that shared work or a room would run is executable on its own: it is cancelled in this same commit (whatever live state it is
    // in), so the row's going cannot leave work behind that dispatch would still start.
    endLiveRequestsOfThread(db, threadId, "source-deleted");
    db.prepare("DELETE FROM pending_delegations WHERE source_thread_id=?").run(threadId);
  }
}

export function recordOwnerDeletion(db: DatabaseSync, threadId: string, now: number = Date.now()): void {
  initializeOwnerDeletions(db);
  db.prepare("INSERT OR IGNORE INTO owner_deleted_threads (thread_id, deleted_at) VALUES (?, ?)").run(threadId, now);
  if (!threadId.startsWith("bot:") && !threadId.startsWith("group:")) dropHandoffsOfDeletedThread(db, threadId);
  wakeRetainedFor(db, threadId);
  for (const listener of listeners) { try { listener(threadId); } catch { /* a listener never decides whether the deletion was recorded */ } }
}

/** Code that keeps parked work in memory (delegations.ts) listens for recorded deletions, so a tombstone settles what it names at once instead of
 * at the end of a backoff. A listener is called with the recorded key (a thread id, `bot:<id>` or `group:<id>`). */
const listeners = new Set<(key: string) => void>();
export function onOwnerDeletion(listener: (key: string) => void): void { listeners.add(listener); }

/** A retained request (room-request-owed.ts room_request_retry) waits out a backoff; a recorded deletion is exactly what settles it, so the
 * requests that name that bot, room or thread are made due now. Touches the retained set only, and only when it exists. */
function wakeRetainedFor(db: DatabaseSync, key: string): void {
  // A finished shared result owed to a thread the owner just deleted is decided by that tombstone: made due now (room-request-owed.ts).
  if (!key.startsWith("bot:") && !key.startsWith("group:") && db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='room_request_owed'").get()) {
    db.prepare("UPDATE room_request_owed SET retry_at=0 WHERE kind='shared_delivery' AND destination_thread_id=? AND retry_at>0").run(key);
  }
  if (!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='room_request_retry'").get()) return;
  const cond = key.startsWith("bot:") ? "r.to_bot_id=?" : key.startsWith("group:") ? "r.group_id=?" : "(r.target_thread_id=? OR r.root_thread_id=?)";
  const id = key.startsWith("bot:") ? key.slice(4) : key.startsWith("group:") ? key.slice(6) : key;
  const args = cond.includes(" OR ") ? [id, id] : [id];
  db.prepare(`UPDATE room_request_retry SET retry_at=0 WHERE request_id IN (SELECT t.request_id FROM room_request_retry t JOIN room_requests r ON r.id=t.request_id WHERE ${cond})`).run(...args);
}

/** Whether the owner's deletion of this conversation was recorded. A database without the table has no record. */
export function ownerDeletedThread(db: DatabaseSync, threadId: string): boolean {
  if (!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='owner_deleted_threads'").get()) return false;
  return db.prepare("SELECT 1 AS x FROM owner_deleted_threads WHERE thread_id=?").get(threadId) !== undefined;
}

/** Takes back a record whose deletion did not commit (the registry write failed, so the conversation still exists). */
export function withdrawOwnerDeletion(db: DatabaseSync, threadId: string): void {
  if (!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='owner_deleted_threads'").get()) return;
  db.prepare("DELETE FROM owner_deleted_threads WHERE thread_id=?").run(threadId);
}

/** Whether the owner's deletion of this bot was recorded (the bot-level tombstone; its threads are recorded under their own ids). */
export function botDeleted(db: DatabaseSync, botId: string): boolean {
  return ownerDeletedThread(db, botDeletionKey(botId));
}
