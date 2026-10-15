// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The per-thread fill of the derived transcript tables, over a database handle
// (no import of database.ts, so the background pass in transcript-backfill.ts
// and the turn-time gate in branch-store.ts share it without a cycle).
import type { DatabaseSync } from "node:sqlite";
import { beginBackground } from "./db-busy.ts";
import { THREAD_PREPARED, fillSlice, threadKey, type FillResult, type FillSink } from "./branch-index.ts";
import { lineClassesOfFillRow } from "./line-classes.ts";
import { keyedCardsOf, mayBeKeyed } from "./keyed-cards.ts";
import { imagePathsOf } from "./message-image-paths.ts";
import { SWEEP_SLICE_MS } from "./slice-budget.ts";

/** What the fills have cost this process: sync prepares are defects (a turn prepares first); `sliceMs` is every slice's time, newest 5,000. */
export const prepareStats = { syncPrepares: 0, slices: 0, maxSliceMs: 0, rows: 0, sliceMs: [] as number[] };
/** A fill slice is bounded by the loop time it takes (SWEEP_SLICE_MS, slice-budget.ts), and by a row cap that keeps its first read small. */
export const SLICE_MS = SWEEP_SLICE_MS;
export const SLICE_ROWS = 500;

/** What the fill keeps for the rows it reads besides their place in the branch: the lines of their classes, the turn each began
 * (turn_first), the images they name (message_image), the keyed cards on text rows. Gathered and written once per slice. */
export function fillExtras(database: DatabaseSync, threadId: string): FillSink {
  const turn = database.prepare("INSERT INTO turn_first(thread_id, turn_id, first_rowid) VALUES (?, ?, ?) ON CONFLICT(thread_id, turn_id) DO UPDATE SET first_rowid = MIN(first_rowid, excluded.first_rowid)");
  const image = database.prepare("INSERT OR IGNORE INTO message_image(thread_id, path, id) VALUES (?, ?, ?)");
  const keyed = database.prepare("INSERT OR IGNORE INTO keyed_card(thread_id, family, key, id) VALUES (?, ?, ?, ?)");
  const lines: number[] = [];
  const turns = new Map<string, number>();
  return {
    row(row, key) {
      // rows come in rowid order, so the first row seen of a turn in a slice is its lowest
      if (typeof row.turn === "string" && row.turn !== "" && !turns.has(row.turn)) turns.set(row.turn, Number(row.mrow));
      for (const cls of lineClassesOfFillRow(row)) lines.push(key, cls, Number(row.mrow));
      if (row.body !== null) {
        let parsed: { role?: unknown; text?: unknown; attachments?: unknown };
        try { parsed = JSON.parse(row.body) as typeof parsed; } catch { return; }
        for (const path of imagePathsOf(parsed)) image.run(threadId, path, row.id);
        // the families that live on text rows (a steer, a setup line, a routine run's prompt, a digest line) are filed here;
        // the older option cards were filed by the global pass
        if (mayBeKeyed(parsed as never)) for (const { family, key: familyKey } of keyedCardsOf(parsed as never)) keyed.run(threadId, family, familyKey, row.id);
      }
    },
    flush() {
      for (let i = 0; i < lines.length; i += 900) {
        const chunk = lines.slice(i, i + 900);
        database.prepare(`INSERT OR IGNORE INTO line(key, cls, mrow) VALUES ${Array.from({ length: chunk.length / 3 }, () => "(?,?,?)").join(",")}`).run(...chunk);
      }
      for (const [turnId, mrow] of turns) turn.run(threadId, turnId, mrow);
      lines.length = 0; turns.clear();
    },
  };
}

/** One slice of a thread's fill, inside the caller's transaction. */
export function fillOneSlice(database: DatabaseSync, threadId: string): FillResult {
  return fillSlice(database, threadId, SLICE_ROWS, SLICE_MS, undefined, fillExtras(database, threadId));
}

/** The next thread (after `after`, by id) that is not prepared, or null. */
export function nextUnpreparedThread(database: DatabaseSync, after: string): string | null {
  let cursor = after;
  for (;;) {
    const row = database.prepare("SELECT thread_id AS threadId FROM messages WHERE thread_id > ? ORDER BY thread_id LIMIT 1").get(cursor) as { threadId: string } | undefined;
    if (!row) return null;
    const tk = threadKey(database, row.threadId);
    if (!tk || tk.state !== THREAD_PREPARED) return row.threadId;
    cursor = row.threadId;
  }
}

export function noteSlice(ms: number): void {
  prepareStats.slices++;
  prepareStats.maxSliceMs = Math.max(prepareStats.maxSliceMs, ms);
  if (prepareStats.sliceMs.length >= 5_000) prepareStats.sliceMs.shift();
  prepareStats.sliceMs.push(ms);
}

/** Fill a thread on the spot over this handle (a caller that cannot wait), inside the caller's transaction when there is
 * one. Exact, and as slow as the thread is long: counted as a defect (`prepareStats.syncPrepares`). */
export function prepareSyncOn(database: DatabaseSync, threadId: string): void {
  const tk = threadKey(database, threadId);
  if (tk ? tk.state === THREAD_PREPARED : !database.prepare("SELECT 1 AS present FROM messages WHERE thread_id = ? LIMIT 1").get(threadId)) return;
  prepareStats.syncPrepares++;
  for (;;) {
    const began = performance.now();
    let done: boolean;
    if (database.isTransaction) done = fillOneSlice(database, threadId).done;
    else {
      database.exec("BEGIN IMMEDIATE");
      try { done = fillOneSlice(database, threadId).done; database.exec("COMMIT"); } catch (error) { try { database.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
    }
    noteSlice(performance.now() - began);
    if (done) return;
  }
}

/** Whether every row of the thread is covered over this handle (a thread with no rows is). Never fills anything. */
export function threadIsReady(database: DatabaseSync, threadId: string): boolean {
  const tk = threadKey(database, threadId);
  return tk ? tk.state === THREAD_PREPARED : !database.prepare("SELECT 1 AS present FROM messages WHERE thread_id = ? LIMIT 1").get(threadId);
}

/** ONE slice (at most SLICE_MS) of a thread's fill, in its own transaction unless the caller holds one; true when the thread is
 * complete. For work that fills a thread a slice at a time with the loop free between slices (a pending branch change). */
export function fillOneSliceOn(database: DatabaseSync, threadId: string): boolean {
  if (threadIsReady(database, threadId)) return true;
  const began = performance.now();
  let done: boolean;
  if (database.isTransaction) done = fillOneSlice(database, threadId).done;
  else {
    // a slice of the branch-change drain (background): within the background budget, a busy start is retried by the drain
    beginBackground(database, "branch-fill");
    try { done = fillOneSlice(database, threadId).done; database.exec("COMMIT"); } catch (error) { try { database.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
  }
  noteSlice(performance.now() - began);
  return done;
}

/** The threads that had the newest messages and are not prepared yet, newest first (the first thing the background pass does:
 * the conversations in use are ready before the rest). */
export function recentUnpreparedThreads(database: DatabaseSync, scan = 2_000): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of database.prepare("SELECT thread_id AS threadId FROM messages INDEXED BY messages_at ORDER BY at DESC LIMIT ?").all(scan) as Array<{ threadId: string }>) {
    if (seen.has(row.threadId)) continue;
    seen.add(row.threadId);
    const tk = threadKey(database, row.threadId);
    if (!tk || tk.state !== THREAD_PREPARED) out.push(row.threadId);
  }
  return out;
}

// ── the front of the background fill ─────────────────────────────────────────
// A request that meets an unprepared thread never fills it: it answers a bounded way and queues the thread here. The background pass
// (transcript-backfill.ts) fills queued threads first, a slice at a time, and tells whoever was answered "pending" when one is ready.
const frontQueues = new WeakMap<DatabaseSync, Set<string>>();
export function queueFrontFill(database: DatabaseSync, threadId: string): void {
  let queue = frontQueues.get(database);
  if (!queue) frontQueues.set(database, queue = new Set());
  queue.add(threadId);
}
/** The oldest queued thread that is still not prepared (prepared ones are dropped on the way). */
export function nextQueuedFill(database: DatabaseSync): string | undefined {
  const queue = frontQueues.get(database);
  if (!queue) return undefined;
  for (const threadId of queue) {
    const tk = threadKey(database, threadId);
    if (tk ? tk.state !== THREAD_PREPARED : database.prepare("SELECT 1 AS present FROM messages WHERE thread_id = ? LIMIT 1").get(threadId)) return threadId;
    queue.delete(threadId);
  }
  return undefined;
}
/** Drop a thread from the front queue; true when it was there. */
export function dequeueFrontFill(database: DatabaseSync, threadId: string): boolean {
  return frontQueues.get(database)?.delete(threadId) ?? false;
}
