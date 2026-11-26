// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: lane C (MEMORY V2 revoke engine), slice pace: the revoke runner and the waiters. Design 4.3 V8, V10, V13, V14.
// Witnesses on a real SQLite file with the real schema (WritetimeFixture). Each prints one MEMV2C line with what it measured.
// Namespace imports on purpose: the same file runs on the product base (f6ae52c670), where some of these exports do not exist yet, and a
// missing export must read as "the base does not do this" (RED), not as a module that fails to link.
// The heavy G-BACKLOG witness is memv2-c-pace-backlog-1021.test.ts (ci/extended-tests.txt).
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { refsLookup } from "./deny-read.ts";
import * as fencePending from "./fence-pending.ts";
import * as runner from "./memory-revocation.ts";
import { buildPrompt, promptPart } from "./prompt-parts.ts";
import * as budget from "./revoke-budget.ts";
import { commitRevoke } from "./revoke-commit.ts";
import * as marker from "./revoke-marker.ts";
import { assertSendFence, pendingFenceCheck } from "./send-fence.ts";
import { storm, THREADS } from "./testing/revoke-storm-fixture.ts";
import { CONTENT, WritetimeFixture } from "./testing/writetime-fixture.ts";

const OWNER = "zz-owner", HEAD = 9_000;
const hooks = <T extends object>(value: unknown): T => (value ?? {}) as T;
const floor0 = hooks<{ rowsPerMinute?: number }>((budget as Record<string, unknown>).REVOKE_CLOSING_FLOOR).rowsPerMinute;
let f: WritetimeFixture;
beforeEach(() => {
  budget.resetRevokeWriteBudget(); runner.resetMemoryRevocationStats(); runner.resetWaitedPendingAllowance();
  f = new WritetimeFixture().cert(true);
});
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers(); runner.stopMemoryRevocation(); f.close();
  budget.setRevokeBudgetClock(); budget.resetRevokeWriteBudget(); runner.resetMemoryRevocationStats();
  hooks<{ timeoutAllows?: boolean }>((runner as Record<string, unknown>).windowWaitTestHooks).timeoutAllows = false;
  hooks<{ muteGeneration?: boolean }>((marker as Record<string, unknown>).windowWakeTestHooks).muteGeneration = false;
  if (floor0 !== undefined) hooks<{ rowsPerMinute?: number }>((budget as Record<string, unknown>).REVOKE_CLOSING_FLOOR).rowsPerMinute = floor0;
});

const count = (db: DatabaseSync, sql: string, ...args: Array<string | number>) => Number(Object.values(db.prepare(sql).get(...args) ?? { n: NaN })[0]);
const activeJobs = () => count(f.db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state IN ('active','undoing')");
const pendingRows = (thread?: string) => thread ? count(f.db, "SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id=?", thread) : count(f.db, "SELECT count(*) AS n FROM memory_deny_pending");
/** Every statement this handle runs from now on, and every BEGIN IMMEDIATE among them. Installed before any module prepared a statement
 * on the handle, so the cached ones are counted too. */
function countStatements(db: DatabaseSync): { n: number; begins: number } {
  const seen = { n: 0, begins: 0 };
  const prepare = db.prepare.bind(db), exec = db.exec.bind(db);
  (db as { prepare: unknown }).prepare = (sql: string) => {
    const statement = prepare(sql) as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const method of ["get", "all", "run", "iterate"]) {
      const real = statement[method]?.bind(statement);
      if (real) statement[method] = (...args: unknown[]) => { seen.n++; return real(...args); };
    }
    return statement;
  };
  (db as { exec: unknown }).exec = (sql: string) => { seen.n++; if (/BEGIN\s+IMMEDIATE/i.test(sql)) seen.begins++; return exec(sql); };
  return seen;
}
/** A line revoke in mark with its line on the frontier and its own thread's window (mem-f3-revoke-queue-1021 lineJob). */
function lineJob(id: number): void {
  f.reply(`line-${id}`, "reply", id * 10).job(id, id * 10 + 1).pending(`line-${id}`, 1, id);
  f.db.prepare("UPDATE memory_revoke_jobs SET phase='mark' WHERE revoke_id=?").run(id);
  marker.enqueueNode(f.db, id, { kind: "line", threadId: `line-${id}`, lsn: id * 10 });
}
/** The owner's turn, held under its own thread's window of revoke 1 (fence-wait-own-row-1020). */
function heldTurn(): { error: unknown } {
  f.reply(OWNER, "delegated", HEAD, { turnLsn: 10 }).job(1, HEAD + 100).pending(OWNER, 1);
  const built = buildPrompt(undefined, [promptPart("[Delegated by @Sender] Re-sending the report", [{ kind: "prefix", threadId: OWNER, headLsn: HEAD }])]);
  try { assertSendFence(built, CONTENT, f.db); } catch (error) { return { error }; }
  throw new Error("fixture must refuse");
}
/** The bus runs a subscriber on a later turn of the event loop (setImmediate, as lane W's wake.ts does), and the fake clock does not own
 * setImmediate: simulated time moves in small steps with one real turn between, so a deadline that fired is delivered before the next. */
const loopTurn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
async function advance(ms: number, step = 4): Promise<void> {
  await loopTurn();
  for (let left = ms; left > 0; left -= step) { await vi.advanceTimersByTimeAsync(Math.min(step, left)); await loopTurn(); }
}
const fakeClock = () => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); budget.setRevokeBudgetClock(); vi.spyOn(console, "warn").mockImplementation(() => {}); };
/** The revoke has written every mark (phase tidy, no frontier): the existing proof site may now close the waiter's own row. */
function proveAndClose(): boolean {
  f.db.prepare("UPDATE memory_revoke_jobs SET phase='tidy' WHERE revoke_id=1").run();
  return runner.closeWaitedPending(f.db, [OWNER], []);
}

// ---- V14-W
it("V14-W: a waiting turn issues 0 statements while it waits and resolves in the event-loop turn its pending row is deleted", async () => {
  const seen = countStatements(f.db);
  const { error } = heldTurn();
  fakeClock();
  let settled: boolean | null = null;
  // the runner is not woken (`wake` does nothing): only the waiter's own work is counted
  void fencePending.awaitExactPendingCheck(f.db, error, undefined, undefined, () => {}).then(value => { settled = value; });
  await vi.advanceTimersByTimeAsync(100); // entry: its one exact check
  const atEntry = seen.n;
  await vi.advanceTimersByTimeAsync(10_000);
  const whileWaiting = seen.n - atEntry;
  expect(settled).toBeNull();
  expect(proveAndClose()).toBe(true);
  // no time passes: only the microtasks of this turn run
  await vi.advanceTimersByTimeAsync(0);
  const afterDelete = settled;
  console.log(`MEMV2C V14-W statementsIn10sWaiting=${whileWaiting} perSecond=${whileWaiting / 10} resolvedSameTurn=${afterDelete}`);
  expect(whileWaiting).toBe(0);
  expect(afterDelete).toBe(true);
  expect(pendingFenceCheck(error)?.(f.db).state).toBe("shown");
});

it("V14-W: the bound still refuses: 65 s with the window open resolves false, and the row is still there (a timeout never authorises a resend)", async () => {
  const { error } = heldTurn();
  fakeClock();
  let settled: boolean | null = null;
  void fencePending.awaitExactPendingCheck(f.db, error, undefined, undefined, () => {}).then(value => { settled = value; });
  await vi.advanceTimersByTimeAsync(fencePending.PENDING_FENCE_WAIT_MS - 1_000);
  expect(settled).toBeNull();
  await vi.advanceTimersByTimeAsync(2_000);
  console.log(`MEMV2C V14-W timeout settled=${settled} boundMs=${fencePending.PENDING_FENCE_WAIT_MS}`);
  expect(settled).toBe(false);
  expect(pendingRows(OWNER)).toBe(1);
  expect(pendingFenceCheck(error)?.(f.db)).toEqual({ state: "checking", reason: "pending" });
});

it("V14-W: a Stop ends the wait within the cancel look, with no statement", async () => {
  const seen = countStatements(f.db);
  const { error } = heldTurn();
  fakeClock();
  let settled: boolean | null = null, stop = false;
  void fencePending.awaitExactPendingCheck(f.db, error, () => stop, undefined, () => {}).then(value => { settled = value; });
  await vi.advanceTimersByTimeAsync(100);
  const atEntry = seen.n;
  stop = true;
  await vi.advanceTimersByTimeAsync(1_100);
  expect(settled).toBe(false);
  expect(seen.n - atEntry).toBe(0);
});

it("V14-W: a turn-start settle looks only at the windows covering its turn, not at the global queue, and does not drain", async () => {
  heldTurn();
  // another thread's revoke that can never finish (its flow node does not parse): the global queue never empties
  f.reply("other", "reply", 500).job(2, 501).pending("other", 1, 2);
  f.db.prepare("INSERT INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(2,-1,'not json')").run();
  f.db.prepare("UPDATE memory_revoke_jobs SET phase='tidy' WHERE revoke_id=1").run();
  fakeClock();
  let settled: boolean | null = null;
  const settle = runner.settleRevokesForTurn as (db: DatabaseSync, maxMs?: number, targets?: { threads: string[]; scopes: string[] }) => Promise<boolean>;
  void settle(f.db, 5_000, { threads: [OWNER], scopes: [] }).then(value => { settled = value; });
  await advance(4_000);
  console.log(`MEMV2C V14-W settle settled=${settled} ownRows=${pendingRows(OWNER)} otherRows=${pendingRows("other")} active=${activeJobs()}`);
  expect(settled).toBe(true);
  expect(pendingRows(OWNER)).toBe(0);
  expect(pendingRows("other")).toBe(1);   // the unfinished revoke keeps its window (fail closed)
  expect(marker.markerWorkPending(f.db)).toBe(true);
});

// ---- V10-W
it("V10-W: a job that throws on every step does not stop the jobs behind it; it keeps its window and sits out a doubling backoff", async () => {
  // the OLDEST job is in flow and its flow node does not parse: every flow phase runs before any mark, so on the base it is every slice's first step
  f.reply("bad", "reply", 5).job(1, 6).pending("bad", 1, 1);
  f.db.prepare("INSERT INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(1,-1,'not json')").run();
  f.db.exec("BEGIN"); for (let id = 2; id <= 40; id++) lineJob(id); f.db.exec("COMMIT");
  fakeClock();
  runner.wakeMemoryRevocation(() => f.db, { busy: () => false });
  await advance(30_000);
  const left = activeJobs(), errors = runner.memoryRevocationStats.errorRetries;
  console.log(`MEMV2C V10-W jobsBehind=39 leftActive=${left} errorsIn30s=${errors} badPending=${pendingRows("bad")} marks=${count(f.db, "SELECT count(DISTINCT revoke_id) AS n FROM memory_deny_line")}`);
  expect(left).toBe(1);
  expect(count(f.db, "SELECT count(DISTINCT revoke_id) AS n FROM memory_deny_line")).toBe(39);
  // fail closed: the failing job is still active, in flow, with its window
  expect(String(f.db.prepare("SELECT state||'/'||phase AS s FROM memory_revoke_jobs WHERE revoke_id=1").get()!.s)).toBe("active/flow");
  expect(pendingRows("bad")).toBe(1);
  // 1 s doubling: tries at about 0, 1, 3, 7, 15 s (never one per slice)
  expect(errors).toBeGreaterThanOrEqual(3);
  expect(errors).toBeLessThanOrEqual(8);
});

// ---- V13-W
it("V13-W: an owner's root walks inline to its end though the minute's ledger is spent", () => {
  f.close(); f = storm(2);
  budget.noteRevokeBytes(budget.REVOKE_WRITE_BUDGET.bytesPerMinute); // the minute is full: background work waits
  expect(budget.revokeWriteWaitMs(budget.revokeSliceNeed(f.db))).toBeGreaterThan(0);
  const inline = { ...runner.INLINE_REVOCATION };
  runner.INLINE_REVOCATION.ms = 5_000; // the deadline is not under test (a loaded box)
  let mine: number;
  try {
    f.db.exec("BEGIN IMMEDIATE");
    try { mine = commitRevoke(f.db, { kind: "line", threadId: THREADS[1]!, messageIds: ["r1"], cause: "forget" }); } finally { f.db.exec("COMMIT"); }
  } finally { Object.assign(runner.INLINE_REVOCATION, inline); }
  const state = String((f.db.prepare("SELECT state FROM memory_revoke_jobs WHERE revoke_id=?").get(mine) as { state?: string } | undefined)?.state ?? "done");
  const rows = count(f.db, "SELECT count(*) AS n FROM memory_deny_pending WHERE revoke_id=?", mine);
  console.log(`MEMV2C V13-W ledgerSpent=${budget.revokeBytesWritten()} state=${state} pendingRows=${rows}`);
  expect(state).toBe("done");
  expect(rows).toBe(0);
  expect(refsLookup(f.db, [{ kind: "line", threadId: THREADS[1]!, messageId: "r1" }], CONTENT).state).toBe("withheld");
  // still charged: the background pays for it
  expect(budget.revokeBytesWritten()).toBeGreaterThan(budget.REVOKE_WRITE_BUDGET.bytesPerMinute);
});

// ---- V8 floor
it("V8 floor: with a turn live for the whole minute and both ledgers spent, at least 256 rows of closing work are done", async () => {
  f.db.exec("PRAGMA journal_mode=WAL");
  f.db.exec("BEGIN"); for (let id = 1; id <= 400; id++) lineJob(id); f.db.exec("COMMIT");
  fakeClock();
  budget.noteRevokeBytes(budget.REVOKE_WRITE_BUDGET.bytesPerMinute); // the foreground spent the minute
  const rows0 = marker.totalChanges(f.db), jobs0 = activeJobs();
  runner.wakeMemoryRevocation(() => f.db, { busy: () => true });
  await advance(59_000);
  const rows = marker.totalChanges(f.db) - rows0, done = jobs0 - activeJobs();
  console.log(`MEMV2C V8-floor liveSeconds=59 rows=${rows} jobsDone=${done} floorSlices=${(runner.memoryRevocationStats as Record<string, number>).floorSlices} budgetWaits=${runner.memoryRevocationStats.budgetWaits}`);
  expect(rows).toBeGreaterThanOrEqual(256);
  expect(done).toBeGreaterThan(0);
  // and it is a floor, not a second budget: one floor's worth and one step past it
  expect(rows).toBeLessThanOrEqual(256 + marker.MARKER_STEP_RESERVE + 256);
});

// ---- the empty queue
it("empty queue: 50 wakes take 0 BEGIN IMMEDIATE, and 50 bus ticks issue 0 statements and leave no deadline armed", async () => {
  const seen = countStatements(f.db);
  const N = 50;
  for (let i = 0; i < N; i++) { runner.wakeMemoryRevocation(() => f.db, { busy: () => false }); await runner.memoryRevocationIdle(); }
  const wakes = { statements: seen.n, begins: seen.begins };
  const wake = await import("./revoke-wake.ts").catch(() => null) as null | { raise(topic: string): void; wakeProbe: { armed(topic: string): boolean } };
  const before = seen.n;
  for (let i = 0; i < N; i++) { wake?.raise("revoke"); await new Promise<void>(resolve => setImmediate(resolve)); }
  await runner.memoryRevocationIdle();
  console.log(`MEMV2C empty-queue wakes=${N} statements=${wakes.statements} perWake=${wakes.statements / N} beginImmediate=${wakes.begins} busTicks=${N} busStatements=${seen.n - before} armed=${wake?.wakeProbe.armed("revoke")}`);
  expect(wakes.begins).toBe(0);
  expect(wakes.statements / N).toBeLessThanOrEqual(6);
  expect(wake).not.toBeNull();
  expect(seen.n - before).toBe(0);
  expect(wake!.wakeProbe.armed("revoke")).toBe(false);
});

it("empty queue: a write that queues work after the runner saw it empty is not lost (the bus tick then runs it)", async () => {
  runner.wakeMemoryRevocation(() => f.db, { busy: () => false }); await runner.memoryRevocationIdle();
  f.db.exec("BEGIN"); lineJob(1); f.db.exec("COMMIT");
  runner.wakeIfStarted(); // what revoke-commit.ts calls after it queued a job
  await new Promise<void>(resolve => setTimeout(resolve, 20));
  await runner.memoryRevocationIdle();
  expect(activeJobs()).toBe(0);
  expect(pendingRows("line-1")).toBe(0);
});

// ---- M2 (section 5): the migration step lane I's runner registers
it("M2: the revoke-drain migration step is done exactly when no revoke has work left, writes nothing and wakes the runner while work stands", async () => {
  const step = (runner as unknown as { revokeDrainMigrationStep?: (db: DatabaseSync, cursor: unknown, now: number) => { cursor: unknown; done: boolean } }).revokeDrainMigrationStep;
  expect(step, "memory-revocation.ts exports revokeDrainMigrationStep").toBeTypeOf("function");
  expect(step!(f.db, null, Date.now())).toEqual({ cursor: { pending: false }, done: true });
  f.db.exec("BEGIN"); for (let id = 1; id <= 5; id++) lineJob(id); f.db.exec("COMMIT");
  fakeClock();
  runner.wakeMemoryRevocation(() => f.db, { busy: () => false });
  await advance(5_000);
  expect(activeJobs()).toBe(0); // the runner saw the queue and emptied it; it now holds no deadline
  f.db.exec("BEGIN"); for (let id = 6; id <= 10; id++) lineJob(id); f.db.exec("COMMIT"); // written behind its back (no in-process wake)
  const changes = marker.totalChanges(f.db);
  const first = step!(f.db, null, Date.now());
  expect(first).toEqual({ cursor: { pending: true }, done: false });
  expect(step!(f.db, first.cursor, Date.now())).toEqual(first); // idempotent from the same cursor
  expect(marker.totalChanges(f.db)).toBe(changes);              // the step itself writes no row
  await advance(5_000);                                          // the wake it raised drains the queue
  expect(activeJobs()).toBe(0);
  expect(step!(f.db, first.cursor, Date.now())).toEqual({ cursor: { pending: false }, done: true });
});
