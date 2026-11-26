// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// q1022-idlerest (owner: q1022-idlerest-opus) W-CHECKPOINT-CHECKING / W-CHECKPOINT-CHUNK: the 1.0.22 idle back-off of unmoved checkpoint
// debt (worker-controller.ts checkpointRetry, 500 ms up to 30 min) must not hold back debt that is moving or about to move.
// - CHECKING (OPUS 521b0d6ff7 H4b, ASTRA da966621a1): a roll deferred while its evidence is checked (a forget's pending window) drains by
//   itself; base retried at 500 ms, the back-off let it wait up to 30 min. Now the back-off stops at one idle sweep (MEMORY_IDLE_SWEEP_MS).
// - CHUNK (ASTRA da966621a1, worker-controller.ts:1112): a chunk of a larger debt that published nothing still moved the thread marker;
//   counted as unmoved, each chunk doubled the wait.
// The real controller, real database, a real owed tool row and its marker; only the shared roll (consolidate.ts refreshMemoryCheckpoint)
// answers "checking" or "one chunk" for a while, then runs for real.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeDatabase, database, transaction } from "../database.ts";
import { ownerFirst } from "../owner-first.ts";
import { stopSearchIndex } from "../message-search-index.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { captureMessage } from "./capture.ts";
import { resetHealthScan } from "./health.ts";
import { notifyMemoryWork } from "./jobs.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { stopRecallViewMaintenance } from "./recall-view.ts";
import { setMemoryMode } from "./repository.ts";
import { resetRetentionScan } from "./retention.ts";
import { storeAnchorMessage } from "./testing/anchor-message.ts";
import { freshDataDir } from "./testing/recall-fixture.ts";
import { WritetimeFixture } from "./testing/writetime-fixture.ts";
import { MEMORY_IDLE_SWEEP_MS, MemoryWorkerController } from "./worker-controller.ts";
import type { Message } from "../store.ts";

const fault = vi.hoisted(() => ({ checking: false, chunks: 0, calls: 0, stillChecking: new Set<string>() }));
vi.mock("./consolidate.ts", async original => {
  const actual = await original<typeof import("./consolidate.ts")>();
  return { ...actual, refreshMemoryCheckpoint: (...args: Parameters<typeof actual.refreshMemoryCheckpoint>) => {
    fault.calls++;
    if (fault.checking || fault.stillChecking.has(args[0])) return { status: "deferred" as const, reason: "evidence-checking" };
    // a chunk with nothing to quote (turn-capture-cost-1021 W-E3-CHUNK-EMPTY): the marker's start moved, nothing was published
    if (fault.chunks > 0) { fault.chunks--; return { status: "deferred" as const, reason: actual.CHECKPOINT_CHUNK_REASON }; }
    return actual.refreshMemoryCheckpoint(...args);
  } };
});

const T = "t-0", THREADS = ["t-0", "t-1", "t-2", "t-3", "t-4"];
let controller: MemoryWorkerController | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "Date", "performance"] });
  vi.setSystemTime(new Date("2026-11-21T00:00:00Z"));
  freshDataDir("active"); reconcileMemoryRoster({ memoryRosterRevision: 1, bots: THREADS.map((threadId, n) => ({ id: `bot-${n}`, threadId })), groups: [] });
  stopRecallViewMaintenance();
  const fixture = new WritetimeFixture(database()).cert(true);
  for (const thread of THREADS) fixture.ready(thread, true);
  resetHealthScan(); resetRetentionScan();
  vi.spyOn(ownerFirst, "admit").mockReturnValue({ admitted: true, forced: false });
  fault.checking = false; fault.chunks = 0; fault.calls = 0; fault.stillChecking.clear();
});
afterEach(async () => { await controller?.stop(); controller = undefined; stopRecallViewMaintenance(); closeDatabase(); vi.restoreAllMocks(); vi.useRealTimers(); });

const debts = (db: DatabaseSync) => db.prepare("SELECT id FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='checkpoint-pending'").all().length;
/** A finished tool row, captured as the server writes it: a born-complete job that owes its thread's checkpoint through one marker. */
async function owedToolRow(db: DatabaseSync, threads = [T]) {
  transaction(() => { for (const thread of threads) {
    storeAnchorMessage(db, thread, "tool-1", "notes.md: 3 lines kept", "bot");
    captureMessage(db, thread, { at: 1, id: "tool-1", role: "bot", kind: "activity", turnId: "turn-1", text: "notes.md: 3 lines kept", tool: { name: "read_file", ok: true } } as unknown as Message);
  } });
  expect(debts(db), "fixture: each tool row owes its thread's checkpoint marker").toBe(threads.length);
  await stopWalMaintenance(); await stopSearchIndex();
  setMemoryMode("capture");
  controller = new MemoryWorkerController({});
  controller.start();
  notifyMemoryWork();
}

// [threads, drained, drain offset]: with 5 threads only the newest marker's check drains, the 4 before it stay checking (a whole walk,
// every page); the drain lands at four points of the walk so its worst phase is met
it.each([[1, 1, 17_000], [3, 3, 17_000], [5, 1, 0], [5, 1, 8_000], [5, 1, 16_000], [5, 1, 24_000]])("W-CHECKPOINT-CHECKING debt of %i thread(s) whose evidence is checked for ten minutes stays quiet, then %i is rolled within one idle sweep of its check draining (offset %i ms)", async (threads: number, drained: number, offset: number) => {
  const db = database();
  fault.checking = true;
  await owedToolRow(db, THREADS.slice(0, threads));
  await vi.advanceTimersByTimeAsync(60_000);
  // the idle rest is kept: while the check lasts the debt is looked at no more than once per idle sweep (base: 120 times a minute)
  const perMinute: number[] = [];
  for (let minute = 0; minute < 9; minute++) { const before = fault.calls; await vi.advanceTimersByTimeAsync(60_000); perMinute.push(fault.calls - before); }
  expect(Math.max(...perMinute), `rolls tried per checking minute: ${JSON.stringify(perMinute)}`).toBeLessThanOrEqual(threads * (60_000 / MEMORY_IDLE_SWEEP_MS + 1));
  // the check drains (the forget's pending window ends) at an arbitrary point between sweeps; no notify: only the controller's own retry
  await vi.advanceTimersByTimeAsync(offset);
  const markers = db.prepare("SELECT substr(id,17) AS job FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='checkpoint-pending' ORDER BY rowid").all().map(row => String(row.job));
  for (const job of markers.slice(0, threads - drained)) fault.stillChecking.add(job);
  fault.checking = false;
  await vi.advanceTimersByTimeAsync(MEMORY_IDLE_SWEEP_MS + 1_000);
  expect(debts(db), "the drained debt is rolled within one idle sweep of its evidence check draining").toBe(threads - drained);
}, 60_000);

it("W-CHECKPOINT-CHUNK a debt rolled in six chunks that publish nothing is done within seconds: each chunk is a roll, not unmoved debt", async () => {
  const db = database();
  fault.chunks = 6;
  await owedToolRow(db);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(fault.chunks, "every chunk was rolled").toBe(0);
  expect(debts(db), "the last roll cleared the debt within twenty seconds (unmoved back-off: 500 ms doubling, over half an hour)").toBe(0);
}, 60_000);
