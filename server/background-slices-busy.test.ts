// SPDX-License-Identifier: AGPL-3.0-or-later
// T4 (STALLS-FINAL-DESIGN 3.1, database.ts invariant 1): every background slice runner that ran after listen takes the write lock through
// beginBackground. With the lock held by another connection, one slice gives up within the background budget with a "try later" error
// (never the handle's 1 s wait), leaves its cursor where it was, and makes progress once the lock is released.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, DatabaseBusyError, isDatabaseBusy } from "./database.ts";
import { dropThread } from "./branch-index.ts";
import * as messages from "./message-db.ts";
import { stepMessageSearchBackfill } from "./message-search-index.ts";
import { walkMessagesChunk } from "./message-walker.ts";
import { readIndexState, writeIndexState } from "./transcript-backfill.ts";
import { branchChangeTuning, pendingBranchChanges, runBranchChangeSlice } from "./memory/branch-change.ts";
import { beginIntegrityPass, readIntegrityPass } from "./memory/integrity-state.ts";
import { stepIntegrityPass } from "./memory/integrity-pass.ts";
import { lineageBackfillSlice } from "./memory/lineage-backfill.ts";
import { memoryRevocationIdle, memoryRevocationStats, resetMemoryRevocationStats, stopMemoryRevocation, wakeMemoryRevocation } from "./memory/memory-revocation.ts";
import { openTurnsStep } from "./memory/open-turns.ts";
import { parkStuckJobsStep, parkSweepFinished, resetParkReconcile, resetParkSweep } from "./memory/park.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { buildRevocationIndexStep } from "./memory/revocation-index.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

let other: DatabaseSync | null = null;
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  setMemoryMode("capture"); resetParkSweep(); resetParkReconcile(); delete branchChangeTuning.sync; delete branchChangeTuning.slice;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { stopMemoryRevocation(); release(); try { other?.close(); } catch { /* closed */ } other = null; closeDatabase(); vi.restoreAllMocks(); });
function hold(): void { other ??= new DatabaseSync(join(DATA_DIR, "messages.db")); other.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); }
function release(): void { try { if (other?.isTransaction) other.exec("ROLLBACK"); } catch { /* none open */ } }
/** One busy attempt: the error is the background budget's, it came within 150 ms, and no transaction was left open. */
function busyAttempt(run: () => unknown): void {
  const db = database(), started = performance.now();
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  expect(caught, "the slice met the held lock").toBeInstanceOf(DatabaseBusyError);
  expect(isDatabaseBusy(caught)).toBe(true);
  expect(performance.now() - started).toBeLessThan(150);
  expect(db.isTransaction).toBe(false);
}
const text = (id: string, parentId: string | null = null) => ({ id, text: `words of ${id}`, parentId, at: 1, role: "user" as const, kind: "text" as const });

it("the revocation index backfill", { tags: ["perf-budget"] }, () => {
  const db = database();
  db.exec("UPDATE memory_revocation_index_build SET ready=0,cursor=NULL,done=0,finished_at=NULL WHERE id=1");
  const before = db.prepare("SELECT ready,cursor,done FROM memory_revocation_index_build").get();
  hold();
  busyAttempt(() => buildRevocationIndexStep(db, 32, { budgetMs: 5 }));
  expect(db.prepare("SELECT ready,cursor,done FROM memory_revocation_index_build").get()).toEqual(before);
  release();
  expect(buildRevocationIndexStep(db, 32, { budgetMs: 5 }).ready).toBe(true);
});

it("the open-turns reconcile", { tags: ["perf-budget"] }, () => {
  const db = database();
  db.exec("UPDATE memory_open_turns_build SET ready=0,cursor=NULL,done=0,finished_at=NULL WHERE id=1");
  const before = db.prepare("SELECT ready,cursor,done FROM memory_open_turns_build").get();
  hold();
  busyAttempt(() => openTurnsStep(db, () => {}, 32, { budgetMs: 5 }));
  expect(db.prepare("SELECT ready,cursor,done FROM memory_open_turns_build").get()).toEqual(before);
  release();
  expect(openTurnsStep(db, () => {}, 32, { budgetMs: 5 }).ready).toBe(true);
});

it("the revocation job runner retries a held lock as a lock, never as a failure", async () => {
  database();
  resetMemoryRevocationStats();
  hold();
  wakeMemoryRevocation(() => database(), { retryMs: 20 });
  await new Promise(resolve => setTimeout(resolve, 80));
  expect(memoryRevocationStats.lockedRetries).toBeGreaterThan(0);
  expect(memoryRevocationStats.errorRetries).toBe(0);
  release();
  await memoryRevocationIdle();
  expect(memoryRevocationStats.errorRetries).toBe(0);
});

it("the integrity pass", { tags: ["perf-budget"] }, () => {
  const db = database();
  beginIntegrityPass(db);
  const before = readIntegrityPass(db);
  hold();
  busyAttempt(() => stepIntegrityPass(db, { budgetMs: 5 }));
  expect(readIntegrityPass(db)).toEqual(before);
  release();
  stepIntegrityPass(db, { budgetMs: 50 });
  const after = readIntegrityPass(db);
  expect([after?.done !== before?.done, after?.phase !== before?.phase, after?.finishedAt !== before?.finishedAt].some(Boolean)).toBe(true);
});

it("the lineage write-time backfill", { tags: ["perf-budget"] }, () => {
  const db = database();
  db.exec("UPDATE memory_lineage_cert SET ready=0,phase='u1',cursor='',done=0 WHERE id=1");
  const before = db.prepare("SELECT phase,cursor,done,ready FROM memory_lineage_cert WHERE id=1").get();
  hold();
  busyAttempt(() => lineageBackfillSlice(db, { budgetMs: 5 }));
  expect(db.prepare("SELECT phase,cursor,done,ready FROM memory_lineage_cert WHERE id=1").get()).toEqual(before);
  release();
  lineageBackfillSlice(db, { budgetMs: 50 });
  expect(db.prepare("SELECT phase,cursor,done,ready FROM memory_lineage_cert WHERE id=1").get()).not.toEqual(before);
});

it("the search index fill", { tags: ["perf-budget"] }, () => {
  const db = database();
  messages.appendMessage("t", text("m1"));
  writeIndexState(db, "search_fts", { done: 0, cursor: 0, skipped: 0 });
  hold();
  busyAttempt(() => stepMessageSearchBackfill(db));
  expect(readIndexState(db, "search_fts")).toMatchObject({ done: 0, cursor: 0 });
  release();
  stepMessageSearchBackfill(db);
  expect(readIndexState(db, "search_fts").done).toBe(1);
});

it("the message walker", { tags: ["perf-budget"] }, () => {
  const db = database();
  messages.appendMessage("t", text("m1"));
  writeIndexState(db, "open_card", { done: 0, cursor: 0, skipped: 0 });
  hold();
  busyAttempt(() => walkMessagesChunk(db, { rows: 100 }));
  expect(readIndexState(db, "open_card")).toMatchObject({ done: 0, cursor: 0 });
  release();
  walkMessagesChunk(db, { rows: 100 });
  expect(readIndexState(db, "open_card").done).toBe(1);
});

it("parking maintenance", { tags: ["perf-budget"] }, () => {
  const db = database();
  const marker = () => db.prepare("SELECT intent FROM memory_scope_bindings WHERE id='memory-parked-sweep'").get();
  const before = marker();
  hold();
  busyAttempt(() => parkStuckJobsStep(db, () => {}));
  expect(marker()).toEqual(before);
  expect(parkSweepFinished()).toBe(false);
  release();
  expect(parkStuckJobsStep(db, () => {}).done).toBe(true);
  expect(parkSweepFinished()).toBe(true);
});

it("the branch-change drain and its thread fill (an unprepared thread)", { tags: ["perf-budget"] }, () => {
  const db = database();
  let previous: string | null = null;
  for (let i = 1; i <= 6; i++) { messages.appendMessage("t", text(`m${i}`, previous)); previous = `m${i}`; }
  // the thread loses its indexes (an older file): the branch move is recorded and done after a fill in slices
  db.exec("BEGIN IMMEDIATE"); dropThread(db, "t"); db.prepare("DELETE FROM turn_first WHERE thread_id = 't'").run(); db.exec("COMMIT");
  messages.setActiveLeaf("t", "m3");
  expect(pendingBranchChanges(db)).toBe(1);
  hold();
  busyAttempt(() => runBranchChangeSlice(db)); // the thread fill's slice (branch-fill.ts) meets the lock first
  expect(pendingBranchChanges(db)).toBe(1);
  release();
  for (let n = 0; n < 1000 && runBranchChangeSlice(db); n++) { /* one slice at a time */ }
  expect(pendingBranchChanges(db)).toBe(0);
});
