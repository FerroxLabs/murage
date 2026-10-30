// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A branch change (an edit, a switch between versions) moves the rows between two
// heads from one side of the visible branch to the other. Memory flips the
// sources of exactly those rows, and parks or reopens their jobs. The work is the
// rows that changed sides, found by following parent links from each head while
// the row is not yet on the other head's branch (asked of the branch index, so a
// row spliced in anywhere is judged by its place, never by its rowid), and never
// the rows both branches share.
//
// The first BRANCH_CHANGE_SYNC_STEPS rows of each side are flipped in the
// transaction of the write that moved the head. A longer change (an edit far back)
// leaves a branch_change row with the two cursors and the rest runs in short
// slices off the write path. While a change is pending for a thread, a memory
// recall or a job claim waits for it (drainBranchChanges), so nothing reads a
// source that is on the wrong side. A second change to a thread whose first is
// still pending finishes the first. A change of a thread the owner has excluded is dropped: the exclusion retired every source of the
// thread, and from this build on no change sets one active again. That covers this writer only: what an older build already flipped stays
// until BRANCH-EXCLUDE-HEAL, so state='active' is not by itself a full exclusion answer.
import type { DatabaseSync } from "node:sqlite";
import { beginBackground, isDatabaseBusy } from "../db-busy.ts";
import { branchOracle, threadKey } from "../branch-index.ts";
import { fillOneSliceOn, queueFrontFill, threadIsReady } from "../branch-fill.ts";
import { memoryClaimIndex } from "./claim-index.ts";
import { noteBranchChangeStored, pendingBranchChanges } from "./branch-change-flag.ts";
import { threadExcluded } from "./deny.ts";

export { branchChangesMayBePending, pendingBranchChanges } from "./branch-change-flag.ts";
import { parkRetiredThreadJobs, reopenParkedThreadJobs } from "./park.ts";

export const BRANCH_CHANGE_SYNC_STEPS = 400;
export const BRANCH_CHANGE_SLICE_STEPS = 400;
/** Test hook: the steps of the write and of a slice (the defaults when absent). */
export const branchChangeTuning: { sync?: number; slice?: number } = {};

interface Change {
  thread_id: string; from_id: string | null; to_id: string; leave_at: string | null; join_at: string | null;
  leave_done: number; join_done: number; all_cursor: string | null;
}

const rowidOf = (db: DatabaseSync, threadId: string, id: string): number | null =>
  (db.prepare("SELECT rowid AS r FROM messages WHERE thread_id = ? AND id = ?").get(threadId, id) as { r: number } | undefined)?.r ?? null;

/** A row's parent id as a load reads it: its parentId, or for a legacy row with none the row stored before it. Null at a root. */
export function parentOf(db: DatabaseSync, threadId: string, id: string): string | null {
  const row = db.prepare("SELECT rowid AS pos, CASE WHEN json_valid(json) THEN json_type(json, '$.parentId') END AS t, CASE WHEN json_valid(json) THEN json_extract(json, '$.parentId') END AS p FROM messages WHERE thread_id = ? AND id = ?")
    .get(threadId, id) as { pos: number; t: string | null; p: string | null } | undefined;
  if (!row) return null;
  if (row.t === null) {
    const before = db.prepare("SELECT id FROM messages WHERE thread_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT 1").get(threadId, row.pos) as { id: string } | undefined;
    return before?.id ?? null;
  }
  return row.t === "null" || typeof row.p !== "string" ? null : row.p;
}

const SET_STATE = "UPDATE memory_sources SET state=? WHERE thread_id=? AND message_id IN (SELECT value FROM json_each(?)) AND state!='deleted' AND state!=? AND kind IN ('text','tool-outcome')";

/** Flip up to `steps` rows of each side; returns whether the change is complete. Runs inside the caller's transaction. */
function step(db: DatabaseSync, change: Change, steps: number): boolean {
  const threadId = change.thread_id;
  if (threadExcluded(db, threadId)) { change.leave_done = change.join_done = 1; return true; }
  if (!threadIsReady(db, threadId)) return false; // never filled here: the drain fills the thread a slice at a time, then steps
  const tk = threadKey(db, threadId);
  const toRow = rowidOf(db, threadId, change.to_id);
  if (!tk || toRow === null) { change.leave_done = change.join_done = 1; return true; }
  const onNew = branchOracle(db, tk, toRow);
  if (change.from_id === null) return stepAll(db, change, onNew, tk.key, steps);
  const fromRow = rowidOf(db, threadId, change.from_id);
  const onOld = branchOracle(db, tk, fromRow);
  const set = db.prepare(SET_STATE);
  const walk = (start: string | null, otherSide: (mrow: number) => boolean): { ids: string[]; at: string | null; done: boolean } => {
    const ids: string[] = [];
    let at = start;
    while (at !== null && ids.length < steps) {
      const mrow = rowidOf(db, threadId, at);
      if (mrow !== null && otherSide(mrow)) return { ids, at, done: true };
      ids.push(at);
      at = parentOf(db, threadId, at);
    }
    return { ids, at, done: at === null };
  };
  if (!change.leave_done) {
    const left = walk(change.leave_at, onNew);
    if (left.ids.length) { set.run("retired", threadId, JSON.stringify(left.ids), "retired"); parkRetiredThreadJobs(db, threadId, left.ids); }
    change.leave_at = left.at; change.leave_done = left.done ? 1 : 0;
  }
  if (!change.join_done) {
    const joined = walk(change.join_at, onOld);
    if (joined.ids.length) { set.run("active", threadId, JSON.stringify(joined.ids), "active"); reopenParkedThreadJobs(db, threadId, joined.ids); }
    change.join_at = joined.at; change.join_done = joined.done ? 1 : 0;
  }
  return change.leave_done === 1 && change.join_done === 1;
}

/** A head that came from nowhere (a thread with no stored head): every source of the thread is judged against the new branch. */
function stepAll(db: DatabaseSync, change: Change, onNew: (mrow: number) => boolean, _key: number, steps: number): boolean {
  const threadId = change.thread_id;
  const sources = db.prepare("SELECT id, message_id, state FROM memory_sources WHERE thread_id=? AND message_id IS NOT NULL AND id > ? AND state!='deleted' AND kind IN ('text','tool-outcome') ORDER BY id LIMIT ?")
    .all(threadId, change.all_cursor ?? "", steps) as Array<{ id: string; message_id: string; state: string }>;
  const retire: string[] = [], activate: string[] = [];
  for (const source of sources) {
    const mrow = rowidOf(db, threadId, source.message_id);
    const on = mrow !== null && onNew(mrow);
    if (on && source.state !== "active") activate.push(source.message_id);
    if (!on && source.state !== "retired") retire.push(source.message_id);
  }
  const set = db.prepare(SET_STATE);
  if (retire.length) { set.run("retired", threadId, JSON.stringify(retire), "retired"); parkRetiredThreadJobs(db, threadId, retire); }
  if (activate.length) { set.run("active", threadId, JSON.stringify(activate), "active"); reopenParkedThreadJobs(db, threadId, activate); }
  if (sources.length < steps) { change.leave_done = change.join_done = 1; return true; }
  change.all_cursor = sources[sources.length - 1]!.id;
  return false;
}

const store = (db: DatabaseSync, change: Change) => db.prepare(
  "INSERT OR REPLACE INTO branch_change(thread_id, from_id, to_id, leave_at, join_at, leave_done, join_done, all_cursor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
).run(change.thread_id, change.from_id, change.to_id, change.leave_at, change.join_at, change.leave_done, change.join_done, change.all_cursor);
const read = (db: DatabaseSync, threadId: string): Change | undefined => db.prepare("SELECT * FROM branch_change WHERE thread_id = ?").get(threadId) as Change | undefined;

/** The head of `threadId` moved from `from` (null: it had none) to `to`: flip what changed sides, as much as fits the
 * write, and leave the rest to the slices. Inside the caller's transaction. */
export function startBranchChange(db: DatabaseSync, threadId: string, from: string | null, to: string): void {
  const pending = read(db, threadId);
  const ready = threadIsReady(db, threadId);
  let change: Change = { thread_id: threadId, from_id: from, to_id: to, leave_at: from, join_at: to, leave_done: from === to ? 1 : 0, join_done: from === to ? 1 : 0, all_cursor: null };
  if (pending && !ready) {
    // an earlier move is pending on a thread not yet filled: it cannot be finished here (a request never fills a whole thread). Every
    // source of the thread is judged against the new head instead, which is right whatever the earlier move had done.
    change = { thread_id: threadId, from_id: null, to_id: to, leave_at: null, join_at: null, leave_done: 0, join_done: 0, all_cursor: null };
  } else if (pending) { while (!step(db, pending, Number.MAX_SAFE_INTEGER)) { /* finish the earlier move before this one */ } db.prepare("DELETE FROM branch_change WHERE thread_id = ?").run(threadId); }
  // an unfilled thread (stored before the indexes) has its move recorded now and done by the drain once the thread is filled
  if (!ready) queueFrontFill(db, threadId);
  else if (step(db, change, branchChangeTuning.sync ?? BRANCH_CHANGE_SYNC_STEPS)) return;
  store(db, change);
  noteBranchChangeStored(db);
  scheduleBranchChangeDrain(db);
}

/** One slice of the oldest pending change; false when nothing is pending. */
export function runBranchChangeSlice(db: DatabaseSync): boolean {
  const change = db.prepare("SELECT * FROM branch_change ORDER BY thread_id LIMIT 1").get() as Change | undefined;
  if (!change) return false;
  // a thread not yet filled is filled a slice at a time first (the work of this call), then its move runs
  if (!threadIsReady(db, change.thread_id)) { fillOneSliceOn(db, change.thread_id); return true; }
  beginBackground(db, "branch-change");
  try {
    if (step(db, change, branchChangeTuning.slice ?? BRANCH_CHANGE_SLICE_STEPS)) { db.prepare("DELETE FROM branch_change WHERE thread_id = ?").run(change.thread_id); memoryClaimIndex.reopened(); }
    else store(db, change);
    db.exec("COMMIT");
    pendingBranchChanges(db); // sets the flag from what is left
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
  return true;
}

const draining = new WeakMap<DatabaseSync, Promise<void>>();
/** Run the pending changes in slices, the event loop free between them. One drain per handle; callers share it. */
export function drainBranchChanges(db: DatabaseSync): Promise<void> {
  if (!pendingBranchChanges(db)) return Promise.resolve();
  let run = draining.get(db);
  if (!run) {
    run = (async () => {
      for (;;) {
        try { if (!runBranchChangeSlice(db)) return; } catch (error) {
          if (!db.isOpen) return;
          // a held write lock is "try again shortly", never a warning
          if (isDatabaseBusy(error)) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
          console.warn(`[memory] branch change: ${error instanceof Error ? error.message : String(error)}; retrying`);
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })().finally(() => { draining.delete(db); });
    draining.set(db, run);
  }
  return run;
}

/** Start the drain without waiting for it. */
export function scheduleBranchChangeDrain(db: DatabaseSync): void {
  if (process.env.VITEST && !process.env.MURAGE_TEST_BACKFILL) return; // a test drains explicitly
  void drainBranchChanges(db).catch(() => { /* a drain is retried by the next reader */ });
}
