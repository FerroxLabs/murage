// SPDX-License-Identifier: AGPL-3.0-or-later
// W-ANCHOR-RATE (q1022). The routine link anchor (routineMessageAnchor: sixteen
// reads of routine_link_nodes) used to run for every routine on every Inbox
// snapshot and on every message change of a routine's thread. It may run once
// per (thread, time) until a message of that thread is added, moved or removed.
import { mkdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { InboxRoutineLifecycle } from "./inbox-routine-lifecycle.ts";
import type { RoutineRun } from "./routines.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const ANCHOR_SQL = "FROM routine_link_nodes WHERE thread_id=? AND node>=? AND node<=? AND max_at>=?";
const ROUTINES = 8, WALK = 16;

beforeEach(() => {
  closeDatabase();
  removeTempDirSync(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
});
afterEach(() => { vi.restoreAllMocks(); closeDatabase(); });

/** Counts every execution of the anchor statement on the real connection:
 * routineMessageAnchor prepares it once per read, so prepares are reads. */
function countAnchorReads(db: DatabaseSync) {
  const spy = vi.spyOn(db, "prepare");
  return () => spy.mock.calls.filter(([sql]) => String(sql).includes(ANCHOR_SQL)).length;
}

async function fixture() {
  const store = new Store();
  const db = database();
  const reads = countAnchorReads(db);
  const owner = store.createBot({ name: "Routine fixture" });
  const bystander = store.createBot({ name: "Unrelated fixture" });
  const started = Date.now() - 60_000, anchorAt = started - 5_000;
  const runs: RoutineRun[] = [];
  const threads: string[] = [];
  const firstIds: string[] = [];
  for (let i = 0; i < ROUTINES; i++) {
    const task = store.createTask(owner.id, `Routine task ${i}`, false)!;
    threads.push(task.threadId);
    // One row before the run began, then the run's first two rows.
    store.appendMessage(task.threadId, { role: "user", kind: "text", text: `earlier ${i}`, at: anchorAt - 1_000 });
    firstIds.push(store.appendMessage(task.threadId, { role: "user", kind: "text", text: `first ${i}`, at: anchorAt + 100 }).id);
    store.appendMessage(task.threadId, { role: "user", kind: "text", text: `second ${i}`, at: anchorAt + 200 });
    runs.push({
      id: `run-${i}`, routineId: `routine-${i}`, routineName: `Routine ${i}`, botId: owner.id, threadId: task.threadId, target: "bot", runOn: "fixture", manual: true,
      scheduledFor: started, startedAt: started, createdAt: started, status: "completed", finishedAt: started + 1_000,
    } as unknown as RoutineRun);
  }
  const lifecycle = new InboxRoutineLifecycle(db, store, { listRuns: () => runs });
  lifecycle.start();
  for (let turn = 0; turn < 50 && !lifecycle.ready; turn++) await new Promise<void>(resolve => setImmediate(resolve));
  expect(lifecycle.ready).toBe(true);
  const link = (i: number) => lifecycle.snapshot().find(run => run.runId === `run-${i}`)?.link;
  const fresh = (i: number) => {
    const first = store.firstMessageSince(threads[i]!, anchorAt);
    return first ? { threadId: threads[i]!, messageId: first.id } : undefined;
  };
  return { store, db, reads, lifecycle, owner, bystander, threads, firstIds, anchorAt, link, fresh };
}

it("W-ANCHOR-RATE: snapshots and unrelated messages do not re-walk the anchor index", async () => {
  const { store, reads, lifecycle, bystander, threads, firstIds, fresh } = await fixture();
  const expected = threads.map((_, i) => fresh(i));
  expect(expected.map(link => link?.messageId)).toEqual(firstIds);
  const baseline = reads(); // includes the direct oracle reads just made
  for (let round = 0; round < 200; round++) {
    const snapshot = lifecycle.snapshot();
    expect(snapshot).toHaveLength(ROUTINES);
    if (round % 50 === 0) for (let i = 0; i < ROUTINES; i++)
      expect(snapshot.find(run => run.runId === `run-${i}`)?.link).toEqual(expected[i]);
    store.appendMessage(bystander.threadId, { role: "user", kind: "text", text: `unrelated ${round}` });
  }
  await new Promise<void>(resolve => setImmediate(resolve));
  const startup = baseline - ROUTINES * WALK, replay = reads() - baseline;
  console.info("W-ANCHOR-RATE", JSON.stringify({ routines: ROUTINES, snapshots: 200, unrelatedAppends: 200, startupReads: startup, replayReads: replay }));
  // Unfixed: 200 snapshots x 8 routines x 16 reads = 25,600 in the replay,
  // growing with every snapshot. Fixed: one walk per routine at startup and
  // none in the replay (one spare walk per routine is allowed).
  expect(startup).toBeGreaterThan(0);
  expect(startup).toBeLessThanOrEqual(ROUTINES * WALK * 2);
  expect(replay).toBeLessThanOrEqual(ROUTINES * WALK);
});

it("W-ANCHOR-RATE: an in-place edit of a run's own thread (a streamed line) costs no anchor walk and keeps the link", async () => {
  const { store, reads, lifecycle, threads, link, fresh } = await fixture();
  const streamed = store.appendMessage(threads[0]!, { role: "user", kind: "text", text: "streaming" });
  const anchored = fresh(0);
  expect(anchored).toBeDefined();
  expect(link(0)).toEqual(anchored);
  const before = reads();
  for (let round = 0; round < 100; round++) {
    store.patchMessage(threads[0]!, streamed.id, { text: `streaming ${round}` });
    lifecycle.snapshot();
  }
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(reads() - before).toBeLessThanOrEqual(WALK);
  expect(link(0)).toEqual(anchored);
  expect(link(0)).toEqual(fresh(0));
});

it("W-ANCHOR-RATE: the kept anchor is never stale after an append, an edit, a time change or a deletion in the run's own thread", async () => {
  const { store, owner, threads, firstIds, anchorAt, link, fresh } = await fixture();
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  const agrees = async (i: number) => { await settle(); const direct = fresh(i); expect(link(i)).toEqual(direct); return direct; };
  expect(await agrees(0)).toEqual({ threadId: threads[0], messageId: firstIds[0] });

  // Append: a later row never displaces the first row at or after the time.
  store.appendMessage(threads[0]!, { role: "user", kind: "text", text: "later" });
  expect(await agrees(0)).toEqual({ threadId: threads[0], messageId: firstIds[0] });

  // Edit in place: the same row, new words.
  store.patchMessage(threads[0]!, firstIds[0]!, { text: "first, edited" });
  expect(await agrees(0)).toEqual({ threadId: threads[0], messageId: firstIds[0] });

  // Time change: the anchor row drops out of the window, so the next stored
  // row at or after the time takes its place. Whatever the store made of the
  // edit, the link is the one a direct read gives.
  store.patchMessage(threads[0]!, firstIds[0]!, { at: anchorAt - 500 });
  const moved = await agrees(0);
  if (store.messageById(threads[0]!, firstIds[0]!)?.at === anchorAt - 500) expect(moved?.messageId).not.toBe(firstIds[0]);
  store.patchMessage(threads[0]!, firstIds[0]!, { at: anchorAt + 100 });
  await agrees(0);

  // Deletion: the conversation goes, and so does the link.
  expect(store.deleteTask(owner.id, threads[2]!)).not.toBeNull();
  await settle();
  expect(fresh(2)).toBeUndefined();
  expect(link(2)).toBeUndefined();
  // The other routines are untouched by that.
  for (let i = 3; i < ROUTINES; i++) expect(await agrees(i)).toEqual({ threadId: threads[i], messageId: firstIds[i] });
});

it("W-ANCHOR-RATE: a run that falls back to the newest row follows every append to its thread", async () => {
  const store = new Store();
  const db = database();
  const owner = store.createBot({ name: "Fallback fixture" });
  const thread = owner.threadId;
  const started = Date.now() + 3_600_000; // after every stored row: the anchor is the newest row
  const only = store.appendMessage(thread, { role: "user", kind: "text", text: "one" });
  const runs = [{ id: "run-late", routineId: "routine-late", routineName: "Late", botId: owner.id, threadId: thread, target: "bot", runOn: "fixture", manual: true,
    scheduledFor: started, startedAt: started, createdAt: started, status: "completed", finishedAt: started } as unknown as RoutineRun];
  const lifecycle = new InboxRoutineLifecycle(db, store, { listRuns: () => runs });
  lifecycle.start();
  for (let turn = 0; turn < 50 && !lifecycle.ready; turn++) await new Promise<void>(resolve => setImmediate(resolve));
  expect(lifecycle.ready).toBe(true);
  const link = () => lifecycle.snapshot()[0]?.link?.messageId;
  expect(link()).toBe(store.firstMessageSince(thread, started - 5_000)?.id);
  for (let round = 0; round < 5; round++) {
    const next = store.appendMessage(thread, { role: "user", kind: "text", text: `more ${round}` });
    expect(store.firstMessageSince(thread, started - 5_000)?.id).toBe(next.id);
    expect(link()).toBe(next.id);
  }
  expect(link()).not.toBe(only.id);
});
