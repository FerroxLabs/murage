// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The writers and the gate of the branch index (branch-index.ts), over the
// installation's message database.
//
// Every thread is either PREPARED (its branch structure covers every row, and
// the writers keep it so) or not (a thread stored before the index existed, until
// its fill has reached the end). A read of an unprepared thread never gets a
// partial answer: a turn awaits `prepareThread` (a fill in slices of at most
// SLICE_MS, with the event loop free between them), and a synchronous caller that
// reaches an unprepared thread fills it on the spot, exactly but slowly, and is
// counted in `prepareStats.syncPrepares` (a number the suite and the harness
// hold at zero on every turn path).
import type { DatabaseSync } from "node:sqlite";
import { database as db, transaction } from "./database.ts";
import { fillOneSlice, noteSlice, prepareStats, prepareSyncOn } from "./branch-fill.ts";
import { lineClassesOf } from "./line-classes.ts";
import type { Message } from "./store.ts";
import {
  THREAD_PREPARED, branchOracle, childrenOf, compareOnBranch, isPlainRow, dropThread, encodeRow, ensureThreadKey, invalidateThread, moveRow,
  parentRowid, spliceAfter, spliceBefore, syncLines, threadKey, type FillResult, type ThreadKey,
} from "./branch-index.ts";

export { prepareStats };

type Shape = Message

/** Whether the thread holds any row besides `mrow`, the row being written. A thread with no key and another row was stored before
 * the index existed (or before a fill reached it): it is not prepared until its fill says so. Not "an earlier row": a patch of the
 * oldest row of an unfilled thread has none earlier, and is still not the whole thread. */
const hasOtherRows = (database: DatabaseSync, threadId: string, mrow: number) => () => Boolean(database.prepare("SELECT 1 AS present FROM messages WHERE thread_id = ? AND rowid != ? LIMIT 1").get(threadId, mrow));

/** Run derived-table work for a thread; a failure makes the thread unprepared (it is filled again) and never fails the write. */
function guarded(database: DatabaseSync, tk: ThreadKey, work: () => void): void {
  try { work(); }
  catch (error) {
    console.warn(`[branch-index] ${tk.threadId}: ${error instanceof Error ? error.message : String(error)}; the thread will be prepared again`);
    invalidateThread(database, tk);
  }
}

/** A row was stored at `mrow` (`prior`: the rowid it replaced, if any). `structure: "none"` is for a row a splice places itself. */
export function afterInsert(database: DatabaseSync, threadId: string, message: Shape, mrow: number, prior: number | undefined, structure: "append" | "none" = "append"): void {
  const tk = ensureThreadKey(database, threadId, hasOtherRows(database, threadId, mrow));
  if (prior !== undefined) database.prepare("UPDATE line SET mrow = ? WHERE key = ? AND mrow = ?").run(mrow, tk.key, prior);
  syncLines(database, tk, mrow, lineClassesOf(message), prior !== undefined);
  if (structure === "none") return;
  if (tk.state === THREAD_PREPARED) {
    guarded(database, tk, () => {
      const parent = parentRowid(database, threadId, mrow, message.parentId);
      if (prior !== undefined) moveRow(database, tk, prior, mrow, parent);
      else encodeRow(database, tk, mrow, parent);
    });
  } else if (prior !== undefined && tk.cursor >= prior) invalidateThread(database, tk);
}

/** A stored row was rewritten (same rowid). */
export function afterUpdate(database: DatabaseSync, threadId: string, message: Shape, mrow: number, parentChanged: boolean, splicing = false): void {
  const tk = ensureThreadKey(database, threadId, hasOtherRows(database, threadId, mrow));
  syncLines(database, tk, mrow, lineClassesOf(message));
  // "prepared" means every row has a branch entry: a row patched before it was ever placed (a lone legacy row, before its first fill) gets its entry now
  if (tk.state === THREAD_PREPARED && !database.prepare("SELECT 1 AS present FROM msg_branch WHERE mrow = ?").get(mrow)) {
    guarded(database, tk, () => encodeRow(database, tk, mrow, parentRowid(database, threadId, mrow, message.parentId)));
  }
  // a parent changed by anything but a splice is not something the structure can follow: the thread is filled again
  if (parentChanged && !splicing && (tk.state === THREAD_PREPARED || tk.cursor > 0)) invalidateThread(database, tk);
}

/** `fresh` was stored directly before `target`, which it took the parent of (`parentMrow`). */
export function afterSpliceBefore(database: DatabaseSync, threadId: string, fresh: number, target: number, parentMrow: number | null): void {
  const tk = threadKey(database, threadId);
  if (!tk) return;
  if (tk.state === THREAD_PREPARED) guarded(database, tk, () => { if (!spliceBefore(database, tk, fresh, target, parentMrow)) throw new Error("splice before: the neighbours are not where the index expects"); });
  else if (tk.cursor > 0) invalidateThread(database, tk);
}

/** `fresh` was stored directly after `anchor`, and took the anchor's children. */
export function afterSpliceAfter(database: DatabaseSync, threadId: string, fresh: number, anchor: number): void {
  const tk = threadKey(database, threadId);
  if (!tk) return;
  if (tk.state === THREAD_PREPARED) guarded(database, tk, () => { if (!spliceAfter(database, tk, fresh, anchor)) throw new Error("splice after: the anchor is not where the index expects"); });
  else if (tk.cursor > 0) invalidateThread(database, tk);
}

export function forgetThread(database: DatabaseSync, threadId: string): void { dropThread(database, threadId); }

// ── the gate ────────────────────────────────────────────────────────────────
/** Whether every row of the thread is covered. A thread with no rows is. */
export function isPrepared(threadId: string): boolean {
  const database = db();
  const tk = threadKey(database, threadId);
  if (tk) return tk.state === THREAD_PREPARED;
  return !database.prepare("SELECT 1 AS present FROM messages WHERE thread_id = ? LIMIT 1").get(threadId);
}

function slice(threadId: string): FillResult {
  const began = performance.now();
  const result = transaction((database) => fillOneSlice(database, threadId));
  prepareStats.rows += result.rows;
  noteSlice(performance.now() - began);
  return result;
}

/** Fill a thread on the spot (a caller that cannot wait). Exact, and as slow as the thread is long: counted as a defect. */
export function prepareThreadSync(threadId: string): void {
  prepareSyncOn(db(), threadId);
}

const running = new Map<string, Promise<void>>();
/** Fill a thread in short slices, with the event loop free between them. Callers for one thread share one fill. */
export function prepareThread(threadId: string): Promise<void> {
  if (isPrepared(threadId)) return Promise.resolve();
  const handle = db();
  const id = `${handleSerial(handle)}:${threadId}`;
  const held = running.get(id);
  if (held) return held;
  const fill = (async () => {
    for (;;) {
      if (db() !== handle) return; // the database was closed or swapped under the fill; the next reader starts it again
      if (slice(threadId).done) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  })().finally(() => { running.delete(id); });
  running.set(id, fill);
  return fill;
}
const serials = new WeakMap<DatabaseSync, number>();
let serial = 0;
const handleSerial = (handle: DatabaseSync): number => { let n = serials.get(handle); if (n === undefined) { n = ++serial; serials.set(handle, n); } return n; };

// ── the oracle ──────────────────────────────────────────────────────────────
/** Whether a row is on the branch ending at `leafId`, for the many rows one question asks about. The thread is prepared first (on the spot, counted). */
export function branchTester(threadId: string, leafId: string | null): (messageId: string) => boolean {
  if (leafId === null) return () => false;
  prepareThreadSync(threadId);
  const database = db();
  const tk = threadKey(database, threadId);
  if (!tk) return () => false;
  const rowid = (id: string): number | null => (database.prepare("SELECT rowid AS r FROM messages WHERE thread_id = ? AND id = ?").get(threadId, id) as { r: number } | undefined)?.r ?? null;
  const leaf = rowid(leafId);
  const test = branchOracle(database, tk, leaf);
  const memo = new Map<string, boolean>();
  return (messageId) => {
    let known = memo.get(messageId);
    if (known === undefined) { const row = rowid(messageId); known = row !== null && test(row); memo.set(messageId, known); }
    return known;
  };
}

/** The rowids of a row's children, oldest first (the thread is prepared first). */
export function childRowids(threadId: string, anchorMrow: number): number[] {
  prepareThreadSync(threadId);
  const tk = threadKey(db(), threadId);
  return tk ? childrenOf(db(), tk, anchorMrow) : [];
}

/** Rowid-keyed membership for the branch ending at `leafId`, and the order of two rows on it (the thread is prepared first). */
export function branchRows(threadId: string, leafId: string | null): { contains: (mrow: number) => boolean; after: (a: number, b: number) => boolean; compare: (a: number, b: number) => number; plain: (mrow: number) => boolean } {
  const none = { contains: () => false, after: () => false, compare: () => 0, plain: () => false };
  if (leafId === null) return none;
  prepareThreadSync(threadId);
  const database = db();
  const tk = threadKey(database, threadId);
  const leaf = (database.prepare("SELECT rowid AS r FROM messages WHERE thread_id = ? AND id = ?").get(threadId, leafId) as { r: number } | undefined)?.r ?? null;
  if (!tk || leaf === null) return none;
  return { contains: branchOracle(database, tk, leaf), after: (a, b) => compareOnBranch(database, tk, a, b) > 0, compare: (a, b) => compareOnBranch(database, tk, a, b), plain: (mrow) => isPlainRow(database, mrow) };
}
