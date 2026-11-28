// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.19 release blocker (Fable product review item 1): every database write is refused once the log reaches the admission ceiling while the
// checkpoint worker is down or behind. These runs use the real database handle, the real worker and its real supervisor. The ceiling and the stall bound
// are lowered through setWalRecoveryKnobsForTest (refuses outside Vitest); the refusal itself is the production one. The stall is the test barrier's
// park of the worker's poll tick (server/testing/wal-barrier.ts), a busy loop inside the real worker.
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { setAdmissionClockOffsetForFixture, ioBudget } from "./io-budget.ts";
import { JOURNAL_SIZE_LIMIT_BYTES, closeDatabase, database, transaction } from "./database.ts";
import { DatabaseBusyError } from "./db-busy.ts";
import { stopWalMaintenance, walMaintenanceCounters, walMaintenanceReady, walMaintenanceTestHooks, setWalRecoveryKnobsForTest, walWritesPaused, walBacklog, checkpointPassive, WAL_STALL_MS, WAL_PAUSED_MESSAGE } from "./wal-maintenance.ts";
import { installWalBarrier } from "./testing/wal-barrier.ts";
import { searchCleanupPending, stopSearchIndex } from "./message-search-index.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const MB = 1024 * 1024, CEILING = 12 * MB, STALL_MS = 2000, ROW = 256 * 1024;
const barrier = installWalBarrier(120_000);
const walFile = () => `${join(DATA_DIR, "messages.db")}-wal`;
const walSize = () => { try { return statSync(walFile()).size; } catch { return 0; } };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

it("progress refresh: a changed heartbeat restarts the stall deadline before a brief pause", () => {
  const source = readFileSync(new URL("./wal-maintenance.ts", import.meta.url), "utf8");
  const supervisor = source.slice(source.indexOf("function tick(m:"), source.indexOf("/** True while a deletion's scrub"));
  const slot = Number(source.match(/^const HEARTBEAT_SLOT = (\d+);/m)![1]);
  const shared = new Int32Array(new SharedArrayBuffer((slot + 1) * 4));
  const m = { failed: false, shared, lastBeat: 0, beatAt: 1000, walFile: "fixture.db-wal", lastResult: null, lastSize: 0, inflight: null };
  let now = 5000, replacements = 0;
  const context = { active: m, Atomics, HEARTBEAT_SLOT: slot, stallMs: STALL_MS, Date: { now: () => now }, writesPaused: true, TICK_RESUME_GAP_MS: 5000, TICK_ASK_BYTES: 1 << 20, WAL_PACE: { quietMs: 5000 }, // 1.0.22 q1022-sqlite: the tick reads them
    replaceStalled: () => { replacements++; return true; }, ioBudget: { admissionTick() {} }, statSync: () => ({ size: 0 }), checkpointPassive() {},
    releaseWalReaders() {} }; // 1.0.21 B5 (memv2-D): the watch also runs the half-gate release (no SQL); this test is about the stall deadline
  const tick = runInNewContext(ts.transpile(supervisor + "\ntick"), context) as (maintenance: typeof m) => void;
  Atomics.store(shared, slot, 1); tick(m);
  expect(m.beatAt, "progress refreshes the deadline even after a long healthy lifetime").toBe(now);
  expect(context.writesPaused).toBe(false);
  now += STALL_MS - 1; tick(m);
  expect(replacements, "a brief pause after progress is not a stall").toBe(0);
  now++; tick(m);
  expect(replacements, "the unchanged heartbeat reaches the same stall bound").toBe(1);
  Atomics.store(shared, slot, 2); now += STALL_MS; tick(m);
  expect(m.beatAt).toBe(now);
  now += STALL_MS - 1; tick(m);
  expect(replacements).toBe(1);
  now++; tick(m);
  expect(replacements).toBe(2);
});

// Each test starts in its own, fresh ledger minute (the ledger rations worker copies per minute), second 10 of it.
let testNo = 0;
function pinAdmissionClock(second: number) { setAdmissionClockOffsetForFixture(((second * 1000 - (Date.now() % 60_000)) % 60_000 + 60_000) % 60_000 + 60_000 * ++testNo); }
afterAll(() => setAdmissionClockOffsetForFixture(0));
beforeEach(async () => {
  pinAdmissionClock(10);
  closeDatabase(); await stopSearchIndex(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  walMaintenanceTestHooks.restartDelaysMs = [1000, 5000, 30_000, 120_000, 300_000]; // the production backoff
  setWalRecoveryKnobsForTest({ admissionBytes: CEILING, stallMs: STALL_MS });
  const db = database();
  await vi.waitFor(() => expect(searchCleanupPending(db)).toBe(false), { timeout: 10_000, interval: 10 });
  await stopSearchIndex();
});
afterEach(async () => {
  barrier.release(); barrier.disarm(); barrier.setHoldMs(0);
  setWalRecoveryKnobsForTest();
  ioBudget.stop(); closeDatabase(); await stopSearchIndex(); await stopWalMaintenance();
});

interface Attempt { id: number; committed: boolean; ms: number; error?: DatabaseBusyError }
let nextId = 0;
/** One owner write through the real transaction path. A refusal must be the named busy error; anything else fails the run. */
function write(row = ROW): Attempt {
  const id = ++nextId, started = performance.now();
  try {
    transaction(db => { db.prepare("INSERT INTO ledger VALUES(?, randomblob(?))").run(id, row); });
    return { id, committed: true, ms: performance.now() - started };
  } catch (error) {
    expect(error, `write ${id} failed with something other than the named busy refusal`).toBeInstanceOf(DatabaseBusyError);
    return { id, committed: false, ms: performance.now() - started, error: error as DatabaseBusyError };
  }
}
async function readyDb() {
  const db = database();
  db.exec("CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY, body BLOB)");
  await vi.waitFor(() => expect(walMaintenanceReady()).toBe(true), { timeout: 10_000 });
  return db;
}
/** Steady writes: every one must commit while the worker is healthy. */
async function steady(count: number, log: Attempt[]) {
  for (let index = 0; index < count; index++) { log.push(write(32 * 1024)); await sleep(25); }
  expect(log.filter(a => !a.committed), "no refusal while the worker is healthy").toEqual([]);
}
/** Writes in a tight burst until the ceiling refuses one; returns once refused. */
function burstUntilRefused(log: Attempt[]) {
  for (let index = 0; index < 200 && (log.length === 0 || log[log.length - 1]!.committed); index++) log.push(write());
  expect(log[log.length - 1]!.committed, `the log crossed the ceiling (${CEILING} bytes) and a write was refused`).toBe(false);
}
/** (a) honest state: every refusal is the named user-visible error and returns within a bound. */
function expectHonestRefusals(log: Attempt[]) {
  const refused = log.filter(a => !a.committed);
  expect(refused.length).toBeGreaterThan(0);
  for (let more = 0; more < 5; more++) refused.push(write());
  for (const attempt of refused) {
    expect(attempt.committed, "the write stays refused while the log is over the ceiling").toBe(false);
    expect(attempt.error).toMatchObject({ code: "DATABASE_BUSY", status: 503, op: "wal-recovery", message: "Busy for a moment, try again" });
    expect(attempt.ms, "a refused call returns promptly").toBeLessThan(250);
  }
  log.push(...refused.slice(-5));
}
/** (b) automatic recovery: with no restart of the app, a write commits again within `boundMs` and the log is back under the ceiling. */
async function expectResumes(since: number, boundMs: number, log: Attempt[], db: ReturnType<typeof database>) {
  let resumed: Attempt | null = null;
  while (performance.now() - since < boundMs && !resumed) {
    const attempt = write(); log.push(attempt);
    if (attempt.committed) resumed = attempt; else await sleep(50);
  }
  expect(resumed, `writes resumed within ${boundMs} ms of the failure, without an app restart`).not.toBeNull();
  const recoveryMs = Math.round(performance.now() - since);
  for (let index = 0; index < 5; index++) { const attempt = write(); log.push(attempt); expect(attempt.committed).toBe(true); await sleep(25); }
  // 1.0.22 MAIN-RULING SQLITE-1022 item 1b: a restarted log keeps its file up to 16 MiB (above this suite's 12 MiB test ceiling; the prod
  // ceiling is 512 MiB), so "back under the ceiling" is read as admission reads it: the live frames still to copy (walBacklog), and the
  // file itself no larger than the kept 16 MiB plus the writes above
  expect(walBacklog()!.backlog, "the log is back under the ceiling").toBeLessThan(CEILING);
  expect(walSize(), "the file is no more than the kept 16 MiB and the last writes").toBeLessThan(Math.max(CEILING, JOURNAL_SIZE_LIMIT_BYTES + 2 * 1024 * 1024));
  expect(database(), "same handle: no app restart").toBe(db);
  expect(walMaintenanceReady()).toBe(true);
  // no silent loss: every committed write is in the table, every refused one is not
  const ids = new Set((db.prepare("SELECT id FROM ledger").all() as { id: number }[]).map(row => row.id));
  for (const attempt of log) expect(ids.has(attempt.id), `write ${attempt.id} ${attempt.committed ? "committed" : "refused"}`).toBe(attempt.committed);
  return recoveryMs;
}

it("kill: the worker is killed under steady writes, the ceiling refuses by name, the supervisor restarts it and writes resume", async () => {
  const db = await readyDb();
  const log: Attempt[] = [];
  await steady(40, log);
  const gen = walMaintenanceCounters()!.gen;
  walMaintenanceTestHooks.terminate();
  const killedAt = performance.now();
  burstUntilRefused(log);
  expectHonestRefusals(log);
  const recoveryMs = await expectResumes(killedAt, 15_000, log, db);
  expect(walMaintenanceCounters()!.gen, "a new worker, started by the supervisor").toBeGreaterThan(gen);
  console.log(`WALREC kill recoveryMs=${recoveryMs} committed=${log.filter(a => a.committed).length} refused=${log.filter(a => !a.committed).length}`);
});

it("stall: a worker stuck in a busy loop is detected and replaced, the ceiling refuses by name, writes resume", async () => {
  expect(WAL_STALL_MS, "the production stall bound is bounded and longer than any real pass").toBeGreaterThanOrEqual(30_000);
  expect(WAL_STALL_MS).toBeLessThanOrEqual(120_000);
  const db = await readyDb();
  const log: Attempt[] = [];
  const beat = walMaintenanceTestHooks.heartbeat();
  await steady(40, log);
  expect(walMaintenanceTestHooks.heartbeat(), "the healthy worker clock advanced before the stall").toBeGreaterThan(beat);
  const gen = walMaintenanceCounters()!.gen;
  barrier.arm(3);
  log.push(write(1024)); // 1.0.21 W4 (memv2-D): the worker polls on a commit, not on a 25 ms clock, so one write brings it to the barrier
  await vi.waitFor(() => expect(barrier.parkedAt()).toBe(3), { timeout: 5000, interval: 10 });
  barrier.disarm(); // the replacement must not park too; the parked thread stays parked
  const stalledAt = performance.now();
  burstUntilRefused(log);
  expectHonestRefusals(log);
  expect(walMaintenanceReady(), "the stalled worker still claims to be ready until it is detected").toBe(true);
  const recoveryMs = await expectResumes(stalledAt, STALL_MS + 1000 + 1000 + 4000, log, db);
  expect(walMaintenanceCounters()!.gen, "a replacement worker was started").toBeGreaterThan(gen);
  console.log(`WALREC stall recoveryMs=${recoveryMs} committed=${log.filter(a => a.committed).length} refused=${log.filter(a => !a.committed).length}`);
});

it("slow but healthy: passes are slow under load while the worker's clock advances, so it is kept and never replaced or paused", async () => {
  await readyDb();
  const log: Attempt[] = [];
  await steady(40, log);
  const gen = walMaintenanceCounters()!.gen;
  barrier.setHoldMs(400); // every requested pass sits 400 ms in the worker (the clock runs between passes)
  const until = performance.now() + 3 * STALL_MS + 1000;
  while (performance.now() < until) {
    log.push(write(32 * 1024));
    await checkpointPassive();
    expect(walWritesPaused()).toBe(false);
  }
  expect(walMaintenanceCounters()!.gen, "a slow but healthy worker is never replaced").toBe(gen);
  expect(walMaintenanceReady()).toBe(true);
  expect(log.filter(a => !a.committed)).toEqual([]);
});

it("stalls again: one replacement, then writes paused (named state), no loop; progress resumes: paused clears and writes resume", async () => {
  const db = await readyDb();
  const log: Attempt[] = [];
  await steady(40, log);
  const gen = walMaintenanceCounters()!.gen;
  barrier.arm(3); // stays armed: the replacement parks too
  log.push(write(1024)); // 1.0.21 W4 (memv2-D): the worker polls on a commit, not on a 25 ms clock, so one write brings it to the barrier
  await vi.waitFor(() => expect(barrier.parkedAt()).toBe(3), { timeout: 5000, interval: 10 });
  burstUntilRefused(log);
  expectHonestRefusals(log);
  expect(walWritesPaused(), "not paused yet: the first stall is replaced").toBe(false);
  let pausedAtDecision: boolean | undefined, replacementReady = false;
  const warn = console.warn.bind(console);
  const warning = vi.spyOn(console, "warn").mockImplementation((...args) => {
    if (String(args[0]).startsWith("[wal] the replacement checkpointer is stalled too;")) pausedAtDecision = walWritesPaused();
    warn(...args);
  });
  const pauseDeadline = performance.now() + 9000;
  try {
    while (pausedAtDecision === undefined) {
      if (performance.now() >= pauseDeadline) throw new Error("timed out in second-stall observation");
      expect(walMaintenanceTestHooks.spawned(), "no second replacement inside the recovery window").toBeLessThanOrEqual(gen + 1);
      if (walMaintenanceTestHooks.spawned() === gen + 1 && walMaintenanceReady()) replacementReady = true;
      if (replacementReady) expect(walMaintenanceReady(), "the replacement is kept inside its recovery window").toBe(true);
      await sleep(50);
    }
    if (performance.now() > pauseDeadline) throw new Error("timed out in second-stall observation");
    expect(pausedAtDecision, "the supervisor's second-stall decision publishes paused before warning").toBe(true);
    expect(walWritesPaused()).toBe(true);
  } finally { warning.mockRestore(); }
  expect(walMaintenanceCounters()!.gen, "exactly one replacement").toBe(gen + 1);
  const paused = write(); log.push(paused);
  expect(paused.committed).toBe(false);
  expect(paused.error).toMatchObject({ code: "DATABASE_BUSY", status: 503, op: "wal-recovery-paused", message: WAL_PAUSED_MESSAGE });
  expect(paused.ms).toBeLessThan(250);
  await sleep(STALL_MS * 2); // well past another stall bound, inside the window: no further replacement
  expect(walMaintenanceCounters()!.gen, "no replacement loop").toBe(gen + 1);
  expect(walWritesPaused()).toBe(true);
  const stalledBeat = walMaintenanceTestHooks.heartbeat(), resumeDeadline = performance.now() + 5000;
  barrier.release(); // the stalled worker's clock runs again
  await vi.waitFor(() => expect(walMaintenanceTestHooks.heartbeat()).toBeGreaterThan(stalledBeat), { timeout: 5000, interval: 50 });
  let observedProgress = false;
  const admissionTick = ioBudget.admissionTick.bind(ioBudget);
  const observation = vi.spyOn(ioBudget, "admissionTick").mockImplementation(() => { admissionTick(); observedProgress = true; });
  try {
    const remaining = resumeDeadline - performance.now();
    if (remaining <= 0) throw new Error("timed out in resumed-clock observation");
    await vi.waitFor(() => expect(observedProgress).toBe(true), { timeout: remaining, interval: 50 });
    if (performance.now() > resumeDeadline) throw new Error("timed out in resumed-clock observation");
    expect(walWritesPaused(), "paused clears when progress resumes").toBe(false);
  } finally { observation.mockRestore(); }
  await expectResumes(performance.now(), 15_000, log, db);
  expect(walMaintenanceCounters()!.gen, "still the one replacement").toBe(gen + 1);
});
