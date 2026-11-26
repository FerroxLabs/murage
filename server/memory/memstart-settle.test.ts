import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as revocation from "./memory-revocation.ts";
import { noteRevokeBytes, resetRevokeWriteBudget, REVOKE_WRITE_BUDGET, revokeSliceNeed, revokeWriteWaitMs } from "./revoke-budget.ts";
import { enqueueNode, markerWorkPending, totalChanges, WINDOW_WAKE } from "./revoke-marker.ts";
import { raise } from "./revoke-wake.ts";
import { WritetimeFixture } from "./testing/writetime-fixture.ts";

// MEMSTART D / T11 observed the exits of the turn-start settle (settleRevokesForTurn) and its one diagnostic line.
//
// MEMORY V2 V14 rewrote that function (design 4.3): "Waiters wait on the `window` wake. `fence-pending` and the turn-start settle resolve
// when a pending row they are under is deleted or the generation moves; the 65 s bound and "a timeout never authorises a resend" stay; no
// poll, no drain in the waiter; a settle looks only at the windows covering its turn. While a waiter exists the runner has the full ledger."
//
// Test mechanics: this file used to slice the function's source text out of memory-revocation.ts and evaluate it with a stand-in clock,
// drain and budget. The sliced region now holds other exported declarations and the function no longer calls the dependencies that were
// injected (drainRevokeMarkerBounded, revokeWriteWaitMs, revokeSliceNeed, setImmediate). Every exit is now observed on the real exported
// function over a real store (WritetimeFixture), on a fake clock moved in small steps with one real event-loop turn between (the wake bus
// delivers by setImmediate; same helper as memv2-c-pace-1021.test.ts).
//
// What V14 changes in every case below: the waiter runs no drain, so the line always says slices=0 (was 1 to 3 drain attempts), and it
// never reads the write budget, so the "budget" exit is gone (the wait goes to its bound and still answers false). Kept: the return value
// of every exit (true only when the work is really done), the line's shape, the -1 count when the count cannot be read, and that a failing
// diagnostic never changes an answer.

let f: WritetimeFixture, lines: string[], warnFails = false;
const failure = new Error("private diagnostic detail");
beforeEach(() => {
  resetRevokeWriteBudget(); revocation.resetMemoryRevocationStats(); revocation.resetWaitedPendingAllowance();
  f = new WritetimeFixture().cert(true);
  lines = []; warnFails = false;
  vi.spyOn(console, "warn").mockImplementation((line?: unknown) => {
    if (!String(line).startsWith("[memory] settle outcome=")) return; // the runner's own lines are not under test
    lines.push(String(line));
    if (warnFails) throw failure;
  });
});
afterEach(() => {
  revocation.stopMemoryRevocation(); vi.restoreAllMocks(); vi.useRealTimers();
  try { if (f.db.isTransaction) f.db.exec("ROLLBACK"); } catch { /* closed by its test */ }
  f.close(); resetRevokeWriteBudget();
});

const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
const loopTurn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
async function advance(ms: number, step = 1): Promise<void> {
  await loopTurn();
  for (let left = ms; left > 0; left -= step) { await vi.advanceTimersByTimeAsync(Math.min(step, left)); await loopTurn(); }
  // the bus runs one subscriber a turn: a few more turns, with the clock standing still, deliver everything raised at the last step
  for (let turn = 0; turn < 6; turn++) await loopTurn();
}
type Seen = { out: boolean | null; threw: unknown };
/** Starts the real settle; `out` stays null while it waits. A rejection is kept apart: no exit may throw. */
function settle(maxMs = 20, db: DatabaseSync = f.db): Seen {
  const seen: Seen = { out: null, threw: undefined };
  void revocation.settleRevokesForTurn(db, maxMs).then(value => { seen.out = value; }, error => { seen.threw = error ?? "rejected"; });
  return seen;
}
function line(outcome: string, ms: number, jobs: number): void {
  expect(lines).toEqual([`[memory] settle outcome=${outcome} ms=${ms} slices=0 activeJobs=${jobs}`]);
}
const count = (sql: string) => Number(Object.values(f.db.prepare(sql).get() ?? { n: NaN })[0]);
/** A revoke that can never finish: its flow node does not parse, so its window stays (fail closed) and marker work stays pending. */
function stuckJob(): void {
  f.reply("stuck", "reply", 5).job(1, 6).pending("stuck", 1, 1);
  f.db.prepare("INSERT INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(1,-1,'not json')").run();
}
/** A line revoke in mark with its line on the frontier and its own thread's window: the runner can finish it. */
function lineJob(id: number): void {
  f.reply(`line-${id}`, "reply", id * 10).job(id, id * 10 + 1).pending(`line-${id}`, 1, id);
  f.db.prepare("UPDATE memory_revoke_jobs SET phase='mark' WHERE revoke_id=?").run(id);
  enqueueNode(f.db, id, { kind: "line", threadId: `line-${id}`, lsn: id * 10 });
}
const spendLedger = () => { noteRevokeBytes(REVOKE_WRITE_BUDGET.bytesPerMinute); expect(revokeWriteWaitMs(revokeSliceNeed(f.db))).toBeGreaterThan(20); };

describe("MEMSTART D / T11 observes existing settle exits", () => {
  // was "cleared, one actual drain attempt" (slices=1). V14: "no poll, no drain in the waiter": cleared at entry by one look, 0 slices.
  it("cleared at entry, with no wait and no drain attempt", async () => {
    fakeClock();
    const changes = totalChanges(f.db);
    const seen = settle();
    await advance(0);
    expect(seen).toEqual({ out: true, threw: undefined });
    expect(totalChanges(f.db)).toBe(changes);
    line("cleared", 0, 0);
  });

  // was "deadline keeps the same yields and drain count" (two setImmediate yields, 3 drains). V14: "no poll, no drain in the waiter":
  // the wait sits out its bound on the wake and answers false there, not before.
  it("deadline: work that stands for the whole bound answers false at the bound, with no drain", async () => {
    stuckJob();
    fakeClock();
    const seen = settle();
    await advance(19);
    expect(seen.out).toBeNull();
    await advance(1);
    expect(seen).toEqual({ out: false, threw: undefined });
    line("deadline", 20, 1);
    expect(count("SELECT count(*) AS n FROM memory_deny_pending")).toBe(1); // the window is still there (fail closed)
    expect(markerWorkPending(f.db)).toBe(true);
  });

  // was "budget beyond deadline exits without a wait" (false at once, outcome=budget). V14: "no poll, no drain in the waiter ... While a
  // waiter exists the runner has the full ledger": the waiter never reads the write budget, so there is no budget exit. Same answer
  // (false), given at the bound.
  it("a spent write budget is not an exit of the waiter: it waits to its bound and answers false", async () => {
    stuckJob();
    fakeClock();
    spendLedger();
    const seen = settle();
    await advance(19);
    expect(seen.out).toBeNull();
    await advance(1);
    expect(seen).toEqual({ out: false, threw: undefined });
    line("deadline", 20, 1);
  });

  // was "shorter budget wait still retries" (a 6 ms timer, then a second drain clears). V14: the waiter does not retry on a timer; it
  // "resolve[s] when a pending row they are under is deleted or the generation moves". The work is done by the runner it woke.
  it("work that finishes during the wait clears it before the bound, done by the runner and not by the waiter", async () => {
    lineJob(1);
    fakeClock();
    const seen = settle(5_000);
    await advance(0);
    expect(seen.out).toBeNull(); // not cleared at entry: the walk has not run
    await advance(2_000, 4);
    expect(seen).toEqual({ out: true, threw: undefined });
    expect(lines).toHaveLength(1);
    const match = /^\[memory\] settle outcome=cleared ms=(\d+) slices=0 activeJobs=0$/.exec(lines[0]!);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeLessThan(2_000);
    expect(count("SELECT count(*) AS n FROM memory_deny_pending")).toBe(0);
    expect(count("SELECT count(*) AS n FROM memory_deny_line WHERE revoke_id=1")).toBe(1);
    expect(markerWorkPending(f.db)).toBe(false);
  });

  // was "in-tx loops to the existing deadline, never drains" (setImmediate yields). Kept: inside a caller's transaction nothing is read
  // or walked, the answer at the bound is false and the line says in-tx. V14: the wait is the wake and one short recheck, not a loop.
  it("in-tx waits to the existing deadline, never drains", async () => {
    fakeClock();
    f.db.exec("BEGIN");
    const changes = totalChanges(f.db);
    const seen = settle();
    await advance(19);
    expect(seen.out).toBeNull();
    await advance(1);
    expect(seen).toEqual({ out: false, threw: undefined });
    expect(f.db.isTransaction).toBe(true); // the caller's transaction was neither committed nor rolled back
    expect(totalChanges(f.db)).toBe(changes);
    line("in-tx", 20, 0);
  });

  // was "in-tx can end and then clear, with only one drain". Kept: a settle entered inside a transaction clears soon after it ends, well
  // before its bound. V14: by its own look (no drain).
  it("in-tx can end and then clear", async () => {
    fakeClock();
    f.db.exec("BEGIN");
    setTimeout(() => f.db.exec("COMMIT"), 10);
    const seen = settle(1_000);
    await advance(9);
    expect(seen.out).toBeNull();
    await advance(11);
    expect(seen).toEqual({ out: true, threw: undefined });
    expect(lines).toHaveLength(1);
    const match = /^\[memory\] settle outcome=cleared ms=(\d+) slices=0 activeJobs=0$/.exec(lines[0]!);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(10);
    expect(Number(match![1])).toBeLessThanOrEqual(20);
  });

  // was "in-tx budget is still the budget exit" (false at once, outcome=budget). V14: no budget exit (see above); inside a transaction
  // with the ledger spent the answer is still false, at the bound, and the line says in-tx.
  it("in-tx with a spent write budget still answers false at the bound", async () => {
    fakeClock();
    spendLedger();
    f.db.exec("BEGIN");
    const seen = settle();
    await advance(19);
    expect(seen.out).toBeNull();
    await advance(1);
    expect(seen).toEqual({ out: false, threw: undefined });
    line("in-tx", 20, 0);
  });

  // was "caught drain error still returns false" (the drain threw). V14: there is no drain; the error a settle can meet at entry is its
  // own handle failing. Kept: false, outcome=error, no wait.
  it("an error at entry still returns false", async () => {
    fakeClock();
    f.db.close();
    const seen = settle();
    await advance(0);
    expect(seen).toEqual({ out: false, threw: undefined });
    line("error", 0, -1);
  });

  // was "uncaught wait computation error still throws the same object" (revokeWriteWaitMs threw between two drains). V14: "no poll, no
  // drain in the waiter": the wait computation is gone, and an error met during the wait is answered false (both callers already mapped
  // a throw to false: `.catch(() => false)`). Never true, never a hang to the bound's far side, never a throw.
  it("an error during the wait answers false with outcome=error and does not throw", async () => {
    stuckJob();
    fakeClock();
    const seen = settle(5_000);
    await advance(8);
    expect(seen.out).toBeNull();
    f.db.close();
    raise(WINDOW_WAKE);
    await advance(8);
    expect(seen).toEqual({ out: false, threw: undefined });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[memory\] settle outcome=error ms=\d+ slices=0 activeJobs=-1$/);
  });

  it("query failure does not hide the exit or invent a count", async () => {
    fakeClock();
    const prepare = f.db.prepare.bind(f.db);
    vi.spyOn(f.db, "prepare").mockImplementation((sql: string) => { if (sql.includes("AS activeJobs")) throw failure; return prepare(sql); });
    const seen = settle();
    await advance(0);
    expect(seen).toEqual({ out: true, threw: undefined });
    line("cleared", 0, -1);
  });

  // the second half was "an uncaught error is still the same exception"; under V14 no exit throws (see above), so it is: still false.
  it("logging failure changes neither return nor exception", async () => {
    fakeClock();
    warnFails = true;
    const seen = settle();
    await advance(0);
    expect(seen).toEqual({ out: true, threw: undefined });
    expect(lines).toHaveLength(1);
    const other = new WritetimeFixture().cert(true);
    other.db.close();
    try {
      const failed = settle(20, other.db);
      await advance(0);
      expect(failed).toEqual({ out: false, threw: undefined });
      expect(lines).toHaveLength(2);
    } finally { other.close(); }
  });
});
