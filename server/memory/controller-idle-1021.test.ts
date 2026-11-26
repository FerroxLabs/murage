// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: memv2 lane E (MEMORY-V2-DESIGN 4.1 E6, I1/I2: the capture controller's own tick and sweep). The riders the sweep still runs
// (onMaintenance, onContinuity) belong to lane K and are not passed here; io-budget's own timers are lane D's and it is not started.
//
// An idle capture controller (no job queued or leased, no projection pending, no checkpoint owed) does no memory work: over five idle
// minutes it runs no SQL statement. Before: the tick re-armed every 30 s and each tick, and each 30 s sweep, read the queue, the
// projections, the debt markers and the status figures again although nothing had been written.
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { ownerFirst } from "../owner-first.ts";
import { flushMemoryCounters, memoryHealth, recordMemoryRetrieval, resetHealthScan, resetMemoryCounters } from "./health.ts";
import { memoryRetentionStatus, resetRetentionScan } from "./retention.ts";
import { ioBudget } from "../io-budget.ts";
import { PagedScan, pagedScanWaitMs } from "./status-scan.ts";
import { notifyMemoryWork } from "./jobs.ts";
import { stopSearchIndex } from "../message-search-index.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { ensureScope } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";

// the controller's call into the real flush, observed (the write itself is io-budget's to admit: not started here, it refuses)
vi.mock("./health.ts", async original => {
  const actual = await original<typeof import("./health.ts")>();
  return { ...actual, flushMemoryCounters: vi.fn(actual.flushMemoryCounters) };
});
let controller: MemoryWorkerController | undefined;
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "Date", "performance"] });
  vi.setSystemTime(new Date("2026-11-21T00:00:00Z"));
  setMemoryMode("capture");
  // the figures' scans are process-wide: a test's clock must not inherit another test's interval
  resetHealthScan(); resetRetentionScan();
  vi.spyOn(ownerFirst, "admit").mockReturnValue({ admitted: true, forced: false });
});
afterEach(async () => { await controller?.stop(); controller = undefined; closeDatabase(); vi.restoreAllMocks(); vi.useRealTimers(); });

/** Every statement run on the connection after this point, by its first words. */
function meter(db: DatabaseSync) {
  const seen: string[] = [];
  const prepare = db.prepare.bind(db), exec = db.exec.bind(db);
  (db as { prepare: (sql: string) => StatementSync }).prepare = (sql: string) => {
    const statement = prepare(sql);
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => { if (key === "run" || key === "get" || key === "all" || key === "iterate") seen.push(sql.replace(/\s+/g, " ").trim().slice(0, 90)); return (value as (...a: unknown[]) => unknown).apply(target, args); };
    } });
  };
  (db as { exec: (sql: string) => void }).exec = (sql: string) => { seen.push(sql.replace(/\s+/g, " ").trim().slice(0, 90)); exec(sql); };
  return { seen, restore: () => { delete (db as { prepare?: unknown }).prepare; delete (db as { exec?: unknown }).exec; } };
}

/** Two real worker threads start with the database and finish starting at a real-time moment that can fall inside a simulated window: the
 * message search worker acknowledges its reset (message-search-index.ts, not memory; FABLE memv2-E 8d5a955d63 M1: one run in 40 read its
 * 5 statements, BEGIN IMMEDIATE / INSERT INTO search_intents / COMMIT and the two busy_timeout pragmas, as the controller's) and the WAL
 * checkpointer reports ready (wal-maintenance.ts, lane D 4.9: PRAGMA wal_autocheckpoint=0). Both are stopped, as index-debt-controller-1021
 * does, so the window measures this controller alone. */
async function memoryOnly() { const db = database(); await stopWalMaintenance(); await stopSearchIndex(); return db; }
it("W-E6-IDLE an idle capture controller runs no statement in five idle minutes, and arms no timer for an empty queue", async () => {
  const db = await memoryOnly();
  controller = new MemoryWorkerController({});
  controller.start();
  // start-up is allowed its bounded reads (I11); the first minute settles them
  await vi.advanceTimersByTimeAsync(60_000);
  const { seen, restore } = meter(db);
  const ticks = (controller as unknown as { wakes: number }).wakes;
  try { await vi.advanceTimersByTimeAsync(5 * 60_000); } finally { restore(); }
  const wakes = (controller as unknown as { wakes: number }).wakes - ticks;
  // database.ts's WAL maintenance pins journal_size_limit on its own timer (wal-maintenance.ts, lane D 4.9): not this controller's
  const own = seen.filter(sql => sql !== "PRAGMA journal_size_limit");
  seen.length = 0; seen.push(...own);
  const kinds = [...new Set(seen)];
  console.log("W-E6-IDLE", JSON.stringify({ minutes: 5, statements: seen.length, ticks: wakes, kinds: kinds.slice(0, 12) }));
  expect(seen.length, `statements in the idle window: ${JSON.stringify(kinds)}`).toBe(0);
  expect(wakes).toBe(0);
  // reads are memoized on the wake bus (lane W), so a tick at rest can cost no statement: the timer itself is what must not exist
  expect((controller as unknown as { timer: unknown }).timer, "no tick timer armed at rest").toBeNull();
  // the effect, not only the count: a job written now is still picked up (the controller is not simply dead)
  const woke = (controller as unknown as { wakes: number }).wakes;
  db.prepare("INSERT INTO memory_scope_bindings VALUES('checkpoint-debt:none',?,'system','checkpoint-pending',0,'granted','{}')").run(ensureScope("conversation", "idle-fixture"));
  notifyMemoryWork(); // the notice io-budget sends for a memory_scope_bindings write (io-budget is not started here: lane D's timers)
  await vi.advanceTimersByTimeAsync(2_000);
  expect((controller as unknown as { wakes: number }).wakes).toBeGreaterThan(woke);
}, 60_000);

it("W-E6-IDLE-NOTHING a wake that finds nothing to do ends with no tick timer: the controller is idle again at once, not on a sweep cadence", async () => {
  const db = await memoryOnly();
  controller = new MemoryWorkerController({});
  controller.start();
  await vi.advanceTimersByTimeAsync(60_000);
  const internals = controller as unknown as { wakes: number; timer: unknown };
  const before = internals.wakes;
  // a notice with nothing written behind it (as io-budget sends for a write memory does not own): the controller ticks once
  notifyMemoryWork();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(internals.wakes, "the notice woke a tick").toBeGreaterThan(before);
  // that tick found nothing: no timer (memv2 E6). Before, a tick that found nothing re-armed itself every 30 s
  expect(internals.timer, "a tick that found nothing arms no timer").toBeNull();
  const after = internals.wakes;
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(internals.wakes - after, "no tick in the next five idle minutes").toBe(0);
  expect(db.prepare("SELECT count(*) AS n FROM memory_jobs").get()!.n).toBe(0);
}, 60_000);

it("W-E6-SWEEP with no rider the sweep runs on a cause only: none in five idle minutes; a count arms its flush (a refused one is tried again once allowed); a memory write alone arms no sweep and no figures' pass", async () => {
  controller = new MemoryWorkerController({});
  const sweeps = vi.spyOn(controller as unknown as { independentWork: (startup?: boolean) => void }, "independentWork");
  const scans = vi.spyOn(controller as unknown as { scheduleStatusScan: (delay: number) => void }, "scheduleStatusScan");
  controller.start();
  await vi.advanceTimersByTimeAsync(60_000);
  sweeps.mockClear(); scans.mockClear();
  // pre-change: the 30 s interval ran the sweep 10 times in these five minutes with nothing to flush or re-measure
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(sweeps, "no sweep on a clock").toHaveBeenCalledTimes(0);
  // a search is counted (memory only): the count arms the flush at once (f6ae52c670 / pre-change: at the next 30 s sweep)
  const flushes = vi.mocked(flushMemoryCounters);
  flushes.mockClear();
  // that background write is refused, as a spent minute refuses it (flushMemoryCounters on BG_DEFERRED: false, the counts kept); the
  // refusal is the cause of one more sweep at the next allowed flush, not of a standing timer; the next one is admitted and written
  flushes.mockImplementationOnce(() => false).mockImplementationOnce(() => { resetMemoryCounters(); return true; });
  recordMemoryRetrieval(3);
  await vi.advanceTimersByTimeAsync(100);
  expect(flushes, "the count armed its flush").toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(61_000);
  expect(flushes, "the refused flush was tried again").toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(flushes, "written: nothing more").toHaveBeenCalledTimes(2);
  // a memory write: it wakes the queue, and that is all; the figures wait for Details to ask (memv2 E6; r3 re-measured them on the write)
  sweeps.mockClear(); scans.mockClear();
  notifyMemoryWork();
  await vi.advanceTimersByTimeAsync(31 * 60_000);
  expect(sweeps, "a write arms no sweep").toHaveBeenCalledTimes(0);
  expect(scans, "a write arms no figures' pass").toHaveBeenCalledTimes(0);
  // Details asks: that is the cause of the pass
  memoryHealth(null);
  await vi.advanceTimersByTimeAsync(100);
  expect(scans, "an ask arms the figures' pass").toHaveBeenCalledTimes(1);
}, 60_000);

it("W-E6-STATUS the figures are measured when Details asks: a write nobody asks about is never walked, an ask is the cause of one pass (health and retention), an ask inside the 10-minute interval is measured when the interval ends", async () => {
  const db = database();
  vi.spyOn(ioBudget, "backgroundRoom").mockReturnValue(1 << 30);
  // a store past SMALL_STORE_ROWS: Details reads the paged figures (status-scan.ts), not a measure on the spot
  const scope = ensureScope("conversation", "status-fixture");
  const add = (from: number, n: number) => {
    db.prepare(`WITH RECURSIVE k(i) AS (SELECT ? UNION ALL SELECT i+1 FROM k WHERE i<?)
      INSERT INTO memory_sources SELECT 'status-'||i,?,'status-fixture',NULL,NULL,1,'h'||i,'text','owner','recorded',NULL,'active' FROM k`).run(from, from + n - 1, scope);
    db.prepare(`WITH RECURSIVE k(i) AS (SELECT ? UNION ALL SELECT i+1 FROM k WHERE i<?)
      INSERT INTO memory_source_versions SELECT 'status-'||i,1,'h'||i,json_object('text','fixture words '||i),1 FROM k`).run(from, from + n - 1);
  };
  /** page reads of the health figures (memory_sources) and of the retention figures (memory_source_versions) while `fn` runs */
  const walked = async (fn: () => unknown) => {
    const { seen, restore } = meter(db);
    try { await fn(); } finally { restore(); }
    return { health: seen.filter(sql => sql.startsWith("SELECT s.rowid AS rid")).length, retention: seen.filter(sql => sql.startsWith("SELECT rowid AS rid,length(CAST(payload")).length };
  };
  add(1, 5001);
  controller = new MemoryWorkerController({});
  controller.start();
  // the start-up pass, before anyone asks
  expect((await walked(() => vi.advanceTimersByTimeAsync(60_000))).health, "the start-up pass").toBeGreaterThan(0);
  // Details reads the stored figures: the serving thread walks nothing
  let figures = 0, bytes = 0;
  expect(await walked(() => { figures = memoryHealth(null).captured.sources; bytes = memoryRetentionStatus().sourceBytes; }), "an ask reads, it does not walk").toEqual({ health: 0, retention: 0 });
  expect(figures).toBe(5001);
  // that ask came inside the start-up pass's interval: settled at the interval's end, nothing changed, so nothing walked
  expect(await walked(() => vi.advanceTimersByTimeAsync(10 * 60_000)), "an ask with nothing changed walks nothing").toEqual({ health: 0, retention: 0 });
  // a write nobody asks about: 30 minutes, three intervals, and the figures' passes never walk (r3: re-walked at the interval's end)
  add(5002, 1); notifyMemoryWork();
  expect(await walked(() => vi.advanceTimersByTimeAsync(30 * 60_000)), "a write alone is not walked").toEqual({ health: 0, retention: 0 });
  expect(memoryHealth(null).captured.sources, "not measured yet").toBe(5001);
  // that ask is the cause of one pass of each figure, run by the controller at once
  const asked = await walked(() => vi.advanceTimersByTimeAsync(1_000));
  expect(asked.health, "the ask's health pass").toBeGreaterThan(0);
  expect(asked.retention, "the ask's retention pass").toBeGreaterThan(0);
  expect(memoryHealth(null).captured.sources, "measured for the ask").toBe(5002);
  expect(memoryRetentionStatus().sourceBytes, "retention measured for the ask").toBeGreaterThan(bytes);
  // one more source, then an ask 1 minute into the interval that pass began: the interval holds
  await vi.advanceTimersByTimeAsync(60_000);
  add(5003, 1); notifyMemoryWork();
  expect(memoryHealth(null).captured.sources, "the interval still holds").toBe(5002);
  // the ask stays owed: the controller walks it when the interval ends, before anyone asks again
  expect((await walked(() => vi.advanceTimersByTimeAsync(10 * 60_000))).health, "the owed ask is walked at the interval's end").toBeGreaterThan(0);
  const sweeps = vi.spyOn(controller as unknown as { independentWork: (startup?: boolean) => void }, "independentWork");
  expect(await walked(() => vi.advanceTimersByTimeAsync(30 * 60_000)), "nothing owed: nothing walked").toEqual({ health: 0, retention: 0 });
  expect(sweeps, "nothing owed: no sweep").toHaveBeenCalledTimes(0);
}, 60_000);

// last in the file: a scan made here stays in status-scan.ts's process-wide set
it("W-E6-STATUS-RIDER with the shipped riders' 30 s sweep, a write nobody asks about is still never walked", async () => {
  const db = database();
  vi.spyOn(ioBudget, "backgroundRoom").mockReturnValue(1 << 30);
  const scope = ensureScope("conversation", "status-fixture");
  const add = (from: number, n: number) => {
    db.prepare(`WITH RECURSIVE k(i) AS (SELECT ? UNION ALL SELECT i+1 FROM k WHERE i<?)
      INSERT INTO memory_sources SELECT 'status-'||i,?,'status-fixture',NULL,NULL,1,'h'||i,'text','owner','recorded',NULL,'active' FROM k`).run(from, from + n - 1, scope);
    db.prepare(`WITH RECURSIVE k(i) AS (SELECT ? UNION ALL SELECT i+1 FROM k WHERE i<?)
      INSERT INTO memory_source_versions SELECT 'status-'||i,1,'h'||i,json_object('text','fixture words '||i),1 FROM k`).run(from, from + n - 1);
  };
  const walked = async (fn: () => unknown) => {
    const { seen, restore } = meter(db);
    try { await fn(); } finally { restore(); }
    return { health: seen.filter(sql => sql.startsWith("SELECT s.rowid AS rid")).length, retention: seen.filter(sql => sql.startsWith("SELECT rowid AS rid,length(CAST(payload")).length };
  };
  add(1, 5001);
  // the server passes lane K's maintenance rider: its interval sweeps every 30 s (worker-controller.ts start)
  const rider = vi.fn(async () => {});
  controller = new MemoryWorkerController({ onMaintenance: rider });
  controller.start();
  await vi.advanceTimersByTimeAsync(11 * 60_000); // the start-up pass and its interval
  add(5002, 1); notifyMemoryWork();
  expect(await walked(() => vi.advanceTimersByTimeAsync(30 * 60_000)), "a write alone is not walked, sweeps or not").toEqual({ health: 0, retention: 0 });
  expect(rider.mock.calls.length, "the rider's sweeps ran").toBeGreaterThan(10);
}, 60_000);
it("W-E6-STATUS-RUNNING a write while a figures' pass is part way is owed past the full interval that pass starts when it ends", () => {
  const db = database();
  const scan = new PagedScan<{ pages: number }, number>({ init: () => ({ pages: 0 }), page: (_db, cursor, acc) => { acc.pages++; return cursor < 3 ? cursor + 1 : null; }, finish: acc => acc.pages }, 600_000);
  expect(scan.waitMs(), "never run: nothing holds it off").toBe(0);
  scan.step(db, 0);   // one page (the clock does not move here): part way, its stamp read before any write made now
  expect(scan.running).toBe(true);
  expect(scan.waitMs()).toBe(600_000);
  expect(pagedScanWaitMs(), "the controller's owed wait (worker-controller.ts scheduleStatusScan)").toBeGreaterThanOrEqual(600_000);
  for (let n = 0; scan.running && n < 10; n++) scan.step(db, 0);
  expect(scan.result).toBe(4);
  expect(scan.waitMs()).toBe(600_000);
});
