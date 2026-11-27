// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owners: q1022-closing-opus owns these witnesses and the batch decision (revoke-budget.ts REVOKE_IDLE_CLOSING, memory-revocation.ts tick);
// revoke-budget.ts owns the 20 MiB ledger and the pace; io-budget.ts (scperf-p1) owns the idle verdict; MAIN owns the ruling.
// MAIN-RULING 2026-11-25T13:41:53Z q1022-closing-batch: the owner deletion/revoke closing walk at the SAME rows/min (V8: closing is never
// paced per minute) writes <= 5 MB/min via fewer, bigger idle-minute transactions; held-thread time not longer; a turn during the walk is
// admitted on time; an orphan pending row (no job row) is cleared at boot/tidy; idle after the walk <= 1 MB/min.
// Every row drives the real runner (memory-revocation.ts wakeMemoryRevocation) on a real WAL file. The idle verdict is the only input the
// test sets (the ledger's answer, as idle-quiet-1022.test.ts does). The oracle is the file's own log: the WAL index's mxFrame and salt read
// around every COMMIT the runner issues on the handle, times the frame size (page + 24-byte header), whatever the runner's pace believes.
//   WALK      a closing walk ('*' pending row, uncertified) over N=1000 threads x 8 lines on an idle minute: log bytes a minute and rows a
//             minute, against the base figures recorded in this lane's job dir (17 MB/min class)
//   HELD      the same walk: the time the '*' window holds every thread at checking is not longer than the 8 ms runner's (base)
//   TURN      an owner turn admitted mid-walk (a real work-admission claim read by the server's own busy predicate): no runner transaction
//             after it holds the write lock longer than one 8 ms runner slice (the idle batch is 4 of them), and the walk still moves
//   WALK-05B  CLOSING-1022 (MAIN-RULING 2026-11-25T17:44:19Z): the 05b-shape walk paced to a wall-clock byte budget: every 60 s <= 5 MB over a
//             14-minute walk that completes, batching kept (log a mark <= 0.5 of the 8 ms runner's)
//   TURN-05B  turns arriving at random real times during the idle 05b walk: at most 1 in 20 waits behind closing work, none past one batch
//   FENCE-05B a turn waiting on a window while the walk waits on its byte budget gets runner commits at once (never held by the pace)
//   ORPHAN    a pending row whose revoke job no longer exists is cleared at the start at listen; the store then reads non-closing and the
//             idle pause holds (0 rows written by the runner on the idle minute after)
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ioBudget } from "../io-budget.ts";
import { createWorkAdmission } from "../work-admission.ts";
import { walIndexReader } from "../io-written.ts";
import { PENDING_ALL_SCOPES, PENDING_ALL_THREADS } from "./lineage-types.ts";
import * as runner from "./memory-revocation.ts";
import * as budget from "./revoke-budget.ts";
import { noteRevokeClosing, resetRevokeWriteBudget, setRevokeBudgetClock } from "./revoke-budget.ts";
import * as marker from "./revoke-marker.ts";
import { WritetimeFixture } from "./testing/writetime-fixture.ts";

const loopTurn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
let f: WritetimeFixture | null = null;
beforeEach(() => { resetRevokeWriteBudget(); });
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers();
  runner.stopMemoryRevocation(); noteRevokeClosing(false); setRevokeBudgetClock(); resetRevokeWriteBudget();
  f?.close(); f = null;
});
function ledgerIdle(idle: () => boolean): void {
  vi.spyOn(ioBudget, "admissionIdle").mockImplementation(idle);
  vi.spyOn(ioBudget, "nextAdmissionMs").mockReturnValue(37_000);
}
async function advance(ms: number, step = 250): Promise<void> {
  await loopTurn();
  for (let left = ms; left > 0; left -= step) { await vi.advanceTimersByTimeAsync(Math.min(step, left)); await loopTurn(); }
}
const THREADS = 1000, LINES = 8;
const SLICE_MS = Number(process.env.Q22CLO_SLICE_MS ?? "1");
if (process.env.Q22CLO_BATCH) (budget as { REVOKE_IDLE_CLOSING?: { batch: number } }).REVOKE_IDLE_CLOSING!.batch = Number(process.env.Q22CLO_BATCH);
/** An owner's revoke in its mark phase whose '*' rows stand (uncertified: the whole walk is closing work), N threads x LINES line nodes. */
function walkFixture(): WritetimeFixture {
  const fx = new WritetimeFixture().cert(false);
  fx.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  fx.job(1, 11);
  fx.db.prepare("UPDATE memory_revoke_jobs SET phase='mark',kind='line' WHERE revoke_id=1").run();
  fx.db.exec("BEGIN");
  fx.pending(PENDING_ALL_THREADS, 1, 1).pendingScope(PENDING_ALL_SCOPES, 1, 1);
  for (let t = 0; t < THREADS; t++) for (let l = 0; l < LINES; l++) marker.enqueueNode(fx.db, 1, { kind: "line", threadId: `thread-${String(t).padStart(4, "0")}`, lsn: 10 + l });
  fx.db.exec("COMMIT");
  fx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return fx;
}
/** The 05b real-store shape (IDLECPU-1022 Cause 1; SEANMAC-IDLE-68ed-io.log, counts only): an owner deletion (a 'thread' revoke, cause
 * delete-conversation, so the walk reads and writes the COVER_REVOKE rows) walking memory records and lines of a store that already holds
 * the marks and cover rows of many earlier deletions, keyed by random ids. Each changed row lands on its own leaf of a deep b-tree, so a
 * commit carries many pages for few rows: the field's ~3 changed rows and ~36 KB of log per changed row on the 8 ms runner. STORE rows of
 * each deny/cover table (the store's earlier deletions), RECORDS record nodes and LINES line nodes (the field's ~300:170 a minute). */
const STORE = Number(process.env.Q22CLO_STORE ?? "150000"), RECORDS = Number(process.env.Q22CLO_RECORDS ?? "3000"), LINES05 = Number(process.env.Q22CLO_LINES ?? "2000");
const SLICE05_MS = Number(process.env.Q22CLO_SLICE05_MS ?? "1.4");
const hex = (n: number, salt: string) => createHash("sha1").update(`${salt}:${n}`).digest("hex");
function walkFixture05b(): WritetimeFixture {
  const fx = new WritetimeFixture().cert(false);
  fx.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  fx.db.exec("BEGIN");
  const line = fx.db.prepare("INSERT OR IGNORE INTO memory_deny_point(thread_id,lsn,revoke_id,mark_lsn,reason) VALUES(?,?,?,?,'delete-conversation')");
  const mem = fx.db.prepare("INSERT OR IGNORE INTO memory_deny_object(kind,id,version,revoke_id) VALUES('record',?,0,?)");
  const reached = fx.db.prepare("INSERT OR IGNORE INTO memory_revoke_reached(revoke_id,thread_id,from_lsn) VALUES(?,?,?)");
  for (let i = 0; i < STORE; i++) {
    const old = 1000 + (i % 64);
    line.run(hex(i, "t"), 10 + (i % 40), old, 10);
    mem.run(`mem-${hex(i, "m")}`, old);
    reached.run(-3, `${hex(i, "c")}${String(i).padStart(27, "0")}`, 10);
    reached.run(old, `r:mem-${hex(i, "m")}:0`, 0);
  }
  fx.db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(1,'thread',?,11,11,'mark','','active')").run(JSON.stringify({ cause: "delete-conversation" }));
  fx.pending(PENDING_ALL_THREADS, 1, 1).pendingScope(PENDING_ALL_SCOPES, 1, 1);
  for (let i = 0; i < Math.max(RECORDS, LINES05); i++) {
    if (i < RECORDS) marker.enqueueNode(fx.db, 1, { kind: "record", id: `mem-${hex(i, "walk-m")}`, version: 0 });
    if (i < LINES05) marker.enqueueNode(fx.db, 1, { kind: "line", threadId: hex(i, "walk-t"), lsn: 10 + (i % 8) });
  }
  fx.db.exec("COMMIT");
  fx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return fx;
}
const marks05 = (fx: WritetimeFixture) => Number(fx.db.prepare("SELECT (SELECT count(*) FROM memory_deny_point WHERE revoke_id=1)+(SELECT count(*) FROM memory_deny_object WHERE revoke_id=1) AS n").get()!.n);
/** CLOSING-1022 TURN-05B: turns arriving at random real times, from another thread on their own connection (a turn's write queues behind the
 * runner's write lock exactly as the server's does): every 4-20 ms for `ms` of real time, BEGIN IMMEDIATE (the write lock) then ROLLBACK
 * (nothing written, so the runner's own log measure is never refused); each arrival's wait for the lock, ms. */
function turnArrivals(file: string, ms: number): Promise<number[]> {
  const code = `const { parentPort, workerData } = require("node:worker_threads"); const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(workerData.file); db.exec("PRAGMA busy_timeout=5000");
    const waits = []; const end = performance.now() + workerData.ms;
    while (performance.now() < end) { const gap = performance.now() + 4 + Math.random() * 16; while (performance.now() < gap) {}
      const t = performance.now(); db.exec("BEGIN IMMEDIATE"); waits.push(performance.now() - t); db.exec("ROLLBACK"); }
    db.close(); parentPort.postMessage(waits);`;
  return new Promise((resolve, reject) => { const w = new Worker(code, { eval: true, workerData: { file, ms } }); w.once("message", resolve); w.once("error", reject); });
}
/** The log bytes every COMMIT on `db` adds (frames past the previous commit's mxFrame, or all frames after a log restart), the count, and
 * each commit's bytes at its Date.now() (WALK-05B-RT: the exact wall-clock window). */
function commitMeter(db: WritetimeFixture["db"]): { bytes: () => number; commits: () => number; log: Array<{ at: number; bytes: number }> } {
  const file = String(db.prepare("PRAGMA database_list").all().find(row => row.name === "main")!.file);
  const page = Number(db.prepare("PRAGMA page_size").get()!.page_size), read = walIndexReader(file);
  let bytes = 0, commits = 0;
  const log: Array<{ at: number; bytes: number }> = [];
  const exec = db.exec.bind(db);
  (db as { exec: (sql: string) => void }).exec = (sql: string) => {
    if (!/^\s*COMMIT\b/i.test(sql)) { exec(sql); return; }
    const before = read();
    exec(sql);
    const after = read();
    commits++;
    const was = bytes;
    if (after && before && after.salt === before.salt) bytes += (after.mxFrame - before.mxFrame) * (page + 24);
    else if (after) bytes += after.mxFrame * (page + 24);
    else bytes += statSync(`${file}-wal`).size; // unreadable index: the whole log, an over-count
    log.push({ at: Date.now(), bytes: bytes - was });
  };
  const m = { bytes: () => bytes, commits: () => commits, log };
  meters.set(db, m);
  return m;
}
const meters = new WeakMap<WritetimeFixture["db"], { bytes: () => number; commits: () => number }>();
const commitMeterTotal = (fx: WritetimeFixture) => meters.get(fx.db)!.bytes();
const pendingStands = (fx: WritetimeFixture) => Boolean(fx.db.prepare("SELECT 1 FROM memory_deny_pending WHERE revoke_id=1 UNION ALL SELECT 1 FROM memory_deny_pending_scope WHERE revoke_id=1 LIMIT 1").get());
const marked = (fx: WritetimeFixture) => Number(fx.db.prepare("SELECT count(*) AS n FROM memory_deny_point WHERE revoke_id=1").get()!.n);
/** Runs the walk on an idle minute until its '*' rows are gone (or `capMs` of runner time): fake minutes, log bytes, commits, rows. */
async function idleWalk(fx: WritetimeFixture, capMs = 20 * 60_000, opts: { rows?: (fx: WritetimeFixture) => number; sliceMs?: number } = {}): Promise<{ ms: number; bytes: number; commits: number; rows: number; done: boolean; maxMinuteBytes: number }> {
  ledgerIdle(() => true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); setRevokeBudgetClock();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const meter = commitMeter(fx.db), t0 = Date.now();
  runner.wakeMemoryRevocation(() => fx.db, { busy: () => false, sliceMs: opts.sliceMs ?? SLICE_MS });
  let done = false;
  // the log on the handle at every fake second: the most any 60 s of the walk wrote (CLOSING-1022: a wall-clock minute, not an average)
  const at: number[] = [0];
  while (Date.now() - t0 < capMs) { await advance(1000, 50); at.push(meter.bytes()); if (!pendingStands(fx)) { done = true; break; } }
  let maxMinuteBytes = 0;
  for (let i = 0; i < at.length; i++) maxMinuteBytes = Math.max(maxMinuteBytes, at[Math.min(at.length - 1, i + 60)] - at[i]);
  return { ms: Date.now() - t0, bytes: meter.bytes(), commits: meter.commits(), rows: (opts.rows ?? marked)(fx), done, maxMinuteBytes };
}
/** Base figures at 68ed0def17: this file run unchanged on the base worktree (job dir logs/base2.log): the walk took 242,000 and 244,000 ms of runner
 * time (base2.log, base3.log: HELD uses the slower) at 1,983 rows a minute and 6.1-6.3 MB of log a minute in 556 COMMITs (14.4 rows each). The slice is 1 ms (SLICE_MS):
 * this host's small file moves 76 rows in an 8 ms slice (1.9 MB/min, far from the field), the 05b store about 3 (IDLECPU-1022 Cause 1), so
 * 1 ms moves the fixture toward the field's small commits; it does not reproduce the field's 17 MB/min. Both runs use it; the fix multiplies it. */
const BASE = { rowsPerMinute: 1983, heldMs: 244_000 };
/** TURN runs the production slice (memory-revocation.ts REVOCATION_SLICE_MS, 8 ms: a live turn gets its half). Bound: one whole 8 ms runner
 * slice and 2 ms for its commit (synchronous=NORMAL): an idle batch (several 8 ms slices) is past it, a live half slice (4 ms) inside it. */
const TURN_SLICE_MS = 8, TURN_HOLD_BOUND_MS = 10;
/** TURN-05B: an arrival "waits behind closing work" past 0.5 ms (an uncontended BEGIN IMMEDIATE takes tens of microseconds). Measured
 * (q1022-closing-opus-r4 logs base2/pre1/tip5): 68ed0def17 2.1% wait, max 8.45 ms; e76c047de1 0.24%, 8.31 ms; paced tip 0.06%, 8.23 ms: the
 * longest wait is one commit's fsync on every sha, so the bound is 12 ms (one 12-slice batch of the 05b slice is 16.8 ms of work, which no
 * batch reaches before its commit cap here); a 200-slice batch waits 18 ms (M9). A GUARD: the base never held arrivals, it is not base-RED. */
const ARRIVAL_WAITED_MS = 0.5, ARRIVAL_WAITED_SHARE = 0.05, ARRIVAL_BOUND_MS = 12;

it("WALK: an idle owner closing walk over 1000 threads writes <= 5 MB of log a minute at no fewer rows a minute than the base runner, and <= 1 MB a minute once it is done", async () => {
  f = walkFixture();
  const r = await idleWalk(f);
  const minutes = r.ms / 60_000, mbMin = r.bytes / minutes / 1e6, rowsMin = r.rows / minutes;
  console.log(`Q22CLO WALK ms=${r.ms} bytes=${r.bytes} commits=${r.commits} rows=${r.rows} done=${r.done} MBmin=${mbMin.toFixed(3)} rowsMin=${rowsMin.toFixed(0)} bytesPerRow=${(r.bytes / Math.max(1, r.rows)).toFixed(0)} rowsPerCommit=${(r.rows / Math.max(1, r.commits)).toFixed(1)} sliceMs=${SLICE_MS} batch=${(budget as { REVOKE_IDLE_CLOSING?: { batch: number } }).REVOKE_IDLE_CLOSING?.batch ?? "none"}`);
  expect(r.done, "the walk finished while idle").toBe(true);
  expect(r.rows, "every line node was marked").toBe(THREADS * LINES);
  expect(rowsMin, "rows a minute not below the base runner's (V8: closing is never paced per minute)").toBeGreaterThanOrEqual(BASE.rowsPerMinute * 0.98);
  expect(mbMin, "log bytes a minute of the closing walk").toBeLessThanOrEqual(5);
  // the walk is done: its tidy is not closing work, so on the idle minutes after it the runner writes (almost) nothing
  const after = r.bytes, t1 = Date.now();
  await advance(3 * 60_000, 1000);
  const idleMb = (commitMeterTotal(f) - after) / ((Date.now() - t1) / 60_000) / 1e6;
  console.log(`Q22CLO IDLE-AFTER MBmin=${idleMb.toFixed(3)}`);
  expect(idleMb, "log bytes a minute on the idle minutes after the walk").toBeLessThanOrEqual(1);
}, 600_000);

it("HELD: the '*' window of the same walk holds every thread at checking no longer than the base runner's walk", async () => {
  f = walkFixture();
  const r = await idleWalk(f);
  console.log(`Q22CLO HELD ms=${r.ms} base=${BASE.heldMs}`);
  expect(r.done, "the walk finished while idle").toBe(true);
  expect(r.ms, "held time of the '*' window (runner time from the wake to the last pending row gone)").toBeLessThanOrEqual(BASE.heldMs);
}, 600_000);

it("TURN: an owner turn admitted mid-walk (the server's busy predicate, server/index.ts: workAdmission.liveTurns) holds the write lock behind no runner transaction longer than the 8 ms runner's", async () => {
  f = walkFixture();
  f.db.exec("PRAGMA synchronous=NORMAL"); // the hold is the runner's work, not the disk's fsync
  // the production admission and the production busy predicate (server/index.ts wakeMemoryRevocation at listen)
  const workAdmission = createWorkAdmission({ restoreReview: () => false, flags: () => ({ autonomy: true, budgets: false }), threadRunning: () => false, speakingInRoom: () => false, directThreads: () => 0, maxThreads: 3, installCardCap: 4, rootCounters: () => ({ wakes: 0, workMs: 0 }), askWouldDeadlock: () => false, reachable: () => true, dependencyOpen: () => false, claimWriterRoot: () => () => {}, now: () => 1 });
  ledgerIdle(() => true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); setRevokeBudgetClock();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // the oracle: how long each runner transaction holds the write lock (BEGIN IMMEDIATE .. COMMIT on the handle), in real time
  const holds: Array<{ ms: number; turn: boolean }> = [];
  let turnLive = false, began = 0;
  const exec = f.db.exec.bind(f.db);
  (f.db as { exec: (sql: string) => void }).exec = (sql: string) => {
    if (/^\s*BEGIN\b/i.test(sql)) { exec(sql); began = performance.now(); return; }
    if (/^\s*(COMMIT|ROLLBACK)\b/i.test(sql)) { exec(sql); holds.push({ ms: performance.now() - began, turn: turnLive }); return; }
    exec(sql);
  };
  runner.wakeMemoryRevocation(() => f!.db, { busy: () => workAdmission.liveTurns({}).length > 0, sliceMs: TURN_SLICE_MS });
  await advance(10_000, 50);
  expect(pendingStands(f), "the walk is still going").toBe(true);
  const idleMax = Math.max(...holds.map(h => h.ms));
  // the owner's turn is admitted; the ledger's idle verdict has not moved yet (its next section flips it)
  const turn = workAdmission.admit({ kind: "ask", priority: "work", botId: "b", threadId: "t", ownerOrigin: true, audience: { ownerAudience: true, fingerprint: "owner" }, now: 1 } as Parameters<typeof workAdmission.admit>[0]);
  expect(turn.admit, "the owner's turn is admitted").toBe(true);
  turnLive = true;
  const at = holds.length;
  // until the runner's first transactions under the turn have run (the walk may be waiting on its ledger's minute)
  for (let i = 0; i < 120 && holds.length - at < 3; i++) await advance(1_000, 50);
  if (turn.admit) turn.claim.release();
  const under = holds.slice(at).map(h => h.ms);
  console.log(`Q22CLO TURN idleMaxHoldMs=${idleMax.toFixed(1)} turnTx=${under.length} turnMaxHoldMs=${Math.max(...under).toFixed(1)} bound=${TURN_HOLD_BOUND_MS}`);
  expect(under.length, "the walk still moves under the turn (V8)").toBeGreaterThan(0);
  expect(Math.max(...under), "the longest write-lock hold a runner transaction puts ahead of the turn's writes, ms").toBeLessThanOrEqual(TURN_HOLD_BOUND_MS);
}, 600_000);

it("ORPHAN: a pending row whose revoke job no longer exists is cleared at the start at listen; the idle pause then holds for the tidy", async () => {
  f = new WritetimeFixture().cert(true);
  f.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  f.reply("line-1", "reply", 10).job(1, 11);
  // a revoke whose walk wrote every mark: phase tidy, no pending row of its own (not closing work)
  f.db.prepare("UPDATE memory_revoke_jobs SET phase='tidy' WHERE revoke_id=1").run();
  // the orphan: '*' rows of revoke 9, whose memory_revoke_jobs row is gone
  f.pending(PENDING_ALL_THREADS, 1, 9).pendingScope(PENDING_ALL_SCOPES, 1, 9); for (let i = 0; i < 300; i++) f.pending(`orphan-${i}`, 1, 9); // more than one sweep page (256)
  const orphans = () => Number(f!.db.prepare("SELECT (SELECT count(*) FROM memory_deny_pending WHERE revoke_id=9)+(SELECT count(*) FROM memory_deny_pending_scope WHERE revoke_id=9) AS n").get()!.n);
  const job = () => f!.db.prepare("SELECT phase,state FROM memory_revoke_jobs WHERE revoke_id=1").get() ?? null;
  const jobBefore = job();
  ledgerIdle(() => true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); setRevokeBudgetClock();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const meter = commitMeter(f.db);
  // the start at listen passes options (a resume wake)
  runner.wakeMemoryRevocation(() => f!.db, { busy: () => false });
  await advance(60_000, 250);
  expect(orphans(), "the orphan pending rows are cleared at the start").toBe(0);
  const cleared = meter.bytes(), t1 = Date.now();
  await advance(3 * 60_000, 1000);
  const idleMb = (meter.bytes() - cleared) / ((Date.now() - t1) / 60_000) / 1e6;
  console.log(`Q22CLO ORPHAN idleMBmin=${idleMb.toFixed(3)} commits=${meter.commits()}`);
  expect({ job: job(), closing: budget.revokeBacklogBurst() }, "with the orphan gone the tidy is not closing work and waits on the idle minute").toEqual({ job: jobBefore, closing: false });
  expect(idleMb, "log bytes a minute on the idle minutes after the sweep").toBeLessThanOrEqual(1);
}, 600_000);

it("ORPHAN-BUSY: a start whose orphan sweep meets another writer's lock keeps the sweep owed and clears the orphans on the lock retry", async () => {
  f = new WritetimeFixture().cert(true);
  f.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  f.reply("line-1", "reply", 10).job(1, 11);
  f.db.prepare("UPDATE memory_revoke_jobs SET phase='tidy' WHERE revoke_id=1").run();
  f.pending(PENDING_ALL_THREADS, 1, 9).pendingScope(PENDING_ALL_SCOPES, 1, 9);
  const orphans = () => Number(f!.db.prepare("SELECT (SELECT count(*) FROM memory_deny_pending WHERE revoke_id=9)+(SELECT count(*) FROM memory_deny_pending_scope WHERE revoke_id=9) AS n").get()!.n);
  const file = String(f.db.prepare("PRAGMA database_list").all().find(row => row.name === "main")!.file);
  // another connection holds the write lock when the start at listen runs
  const other = new DatabaseSync(file);
  other.exec("BEGIN IMMEDIATE");
  ledgerIdle(() => true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); setRevokeBudgetClock();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    runner.wakeMemoryRevocation(() => f!.db, { busy: () => false, retryMs: 1000 });
    await advance(3_000, 250);
    const whileLocked = orphans();
    other.exec("ROLLBACK");
    await advance(30_000, 250);
    console.log(`Q22CLO ORPHAN-BUSY whileLocked=${whileLocked} after=${orphans()} lockedRetries=${runner.memoryRevocationStats.lockedRetries}`);
    expect(whileLocked, "the lock held the sweep off").toBe(2);
    expect(orphans(), "the orphan pending rows are cleared once the lock is released").toBe(0);
  } finally { if (other.isTransaction) other.exec("ROLLBACK"); other.close(); }
}, 600_000);

it("WALK-05B: on the 05b real-store shape the idle owner deletion walk writes <= 5 MB of log in every minute of a 10+ minute walk, completes, and at most half the log a mark of the 8 ms runner's commits", async () => {
  const knob = (budget as { REVOKE_IDLE_CLOSING?: { batch: number } }).REVOKE_IDLE_CLOSING;
  const shipped = knob?.batch ?? 1;
  const walk = async (batch: number) => {
    if (knob) knob.batch = batch;
    resetRevokeWriteBudget();
    f = walkFixture05b();
    try { return await idleWalk(f, 60 * 60_000, { rows: marks05, sliceMs: SLICE05_MS }); }
    finally { runner.stopMemoryRevocation(); noteRevokeClosing(false); vi.restoreAllMocks(); vi.useRealTimers(); f.close(); f = null; }
  };
  let control: Awaited<ReturnType<typeof idleWalk>>, r: Awaited<ReturnType<typeof idleWalk>>;
  // the control: the same walk on the same host committing every 8 ms runner slice (the base's commits); then the shipped batch and pace
  try { control = await walk(1); r = await walk(shipped); } finally { if (knob) knob.batch = shipped; }
  const fig = (x: typeof r) => ({ perMark: x.bytes / Math.max(1, x.rows), mbMin: x.bytes / (x.ms / 60_000) / 1e6, maxMinuteMb: x.maxMinuteBytes / 1e6, marksMin: x.rows / (x.ms / 60_000), perCommit: x.rows / Math.max(1, x.commits), minutes: x.ms / 60_000 });
  const c = fig(control), b = fig(r);
  console.log(`Q22CLO WALK05B control: MBmin=${c.mbMin.toFixed(3)} maxMinuteMB=${c.maxMinuteMb.toFixed(3)} marksMin=${c.marksMin.toFixed(0)} minutes=${c.minutes.toFixed(1)} bytesPerMark=${c.perMark.toFixed(0)} marksPerCommit=${c.perCommit.toFixed(2)} | batch=${shipped}: MBmin=${b.mbMin.toFixed(3)} maxMinuteMB=${b.maxMinuteMb.toFixed(3)} marksMin=${b.marksMin.toFixed(0)} minutes=${b.minutes.toFixed(1)} bytesPerMark=${b.perMark.toFixed(0)} marksPerCommit=${b.perCommit.toFixed(2)} ratio=${(b.perMark / c.perMark).toFixed(3)} sliceMs=${SLICE05_MS} marks=${RECORDS + LINES05}`);
  expect([control.done, r.done], "both walks finished while idle").toEqual([true, true]);
  expect(r.rows, "every record and line node was marked").toBe(RECORDS + LINES05);
  // MAIN-RULING 2026-11-25T17:44:19Z CLOSING-1022: idle closing is paced to a wall-clock byte budget (V8 reversed for idle closing only), so
  // the marks a minute are no longer held at the control's; the walk's every minute is the ruling's figure
  expect(b.maxMinuteMb, "the most log any 60 s of the 05b closing walk wrote, MB").toBeLessThanOrEqual(5);
  expect(b.minutes, "the paced walk ran 10 minutes or more (the ruling's 10-minute run)").toBeGreaterThanOrEqual(10);
  expect(b.perMark / c.perMark, "log bytes a mark against the 8 ms runner's commits on the 05b shape (batching kept)").toBeLessThanOrEqual(0.5);
}, 3_600_000);

it("WALK-05B-RT: on real timers and the real clock, the idle 05b closing walk writes <= 5 MB of log in every wall-clock minute of a 10+ minute walk, keeps walking and completes", async () => {
  f = walkFixture05b();
  // no fake timer or Date: the runner, its pace (revoke-budget.ts clock) and the per-second samples all run on wall-clock time (Astra ccddeef0b0)
  ledgerIdle(() => true);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const RUN_MS = Number(process.env.Q22CLO_RT_MS ?? "1200000"); // a cap: the run ends when the walk is done
  const meter = commitMeter(f.db), marks0 = marks05(f), t0 = Date.now();
  runner.wakeMemoryRevocation(() => f!.db, { busy: () => false, sliceMs: SLICE05_MS });
  // the exact worst wall-clock 60 s: every window that starts at a commit (the heaviest window always does), over each commit's Date.now()
  const exactWorst = () => {
    let most = 0, sum = 0, j = 0;
    for (let i = 0; i < meter.log.length; i++) {
      while (j < meter.log.length && meter.log[j].at < meter.log[i].at + 60_000) sum += meter.log[j++].bytes;
      most = Math.max(most, sum); sum -= meter.log[i].bytes;
    }
    return most;
  };
  let worst = 0, done = false;
  // looked at every wall-clock second; a minute over the bound ends the run at once (it cannot come back under)
  while (Date.now() - t0 < RUN_MS) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    worst = exactWorst();
    if (worst > 5e6) break;
    if (!pendingStands(f)) { done = true; break; }
  }
  const minutes = (Date.now() - t0) / 60_000, moved = marks05(f) - marks0;
  console.log(`Q22CLO WALK05BRT minutes=${minutes.toFixed(2)} maxMinuteMB=${(worst / 1e6).toFixed(3)} MBmin=${(meter.bytes() / minutes / 1e6).toFixed(3)} commits=${meter.commits()} marksMoved=${moved} marksMin=${(moved / minutes).toFixed(0)} done=${done} waits=${runner.memoryRevocationStats.idleClosingWaits ?? "-"}`);
  expect(worst / 1e6, "the most log any wall-clock 60 s of the 05b closing walk wrote, MB").toBeLessThanOrEqual(5);
  expect(done, "the paced walk finished on the real clock (every '*' row gone)").toBe(true);
  expect(minutes, "the paced walk ran 10 wall-clock minutes or more (the ruling's 10-minute run)").toBeGreaterThanOrEqual(10);
  expect(moved / minutes, "marks a wall-clock minute: the paced walk keeps walking").toBeGreaterThanOrEqual(100);
}, 1_500_000);

it("TURN-05B: turns arriving at random times during the idle 05b closing walk are admitted to the write lock on time: at most 1 in 20 waits behind closing work, none longer than one batch", async () => {
  f = walkFixture05b();
  // the production admission and the production busy predicate (server/index.ts wakeMemoryRevocation at listen), real timers: real minutes
  const workAdmission = createWorkAdmission({ restoreReview: () => false, flags: () => ({ autonomy: true, budgets: false }), threadRunning: () => false, speakingInRoom: () => false, directThreads: () => 0, maxThreads: 3, installCardCap: 4, rootCounters: () => ({ wakes: 0, workMs: 0 }), askWouldDeadlock: () => false, reachable: () => true, dependencyOpen: () => false, claimWriterRoot: () => () => {}, now: () => 1 });
  ledgerIdle(() => true);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const file = String(f.db.prepare("PRAGMA database_list").all().find(row => row.name === "main")!.file);
  const shipped = (budget as { REVOKE_IDLE_CLOSING?: { batch: number } }).REVOKE_IDLE_CLOSING?.batch ?? 1;
  const meter = commitMeter(f.db);
  runner.wakeMemoryRevocation(() => f!.db, { busy: () => workAdmission.liveTurns({}).length > 0, sliceMs: SLICE05_MS });
  const ARRIVE_MS = Number(process.env.Q22CLO_ARRIVE_MS ?? "20000");
  const waits = await turnArrivals(file, ARRIVE_MS);
  const stillClosing = pendingStands(f), commits = meter.commits();
  const waited = waits.filter(w => w > ARRIVAL_WAITED_MS).length, share = waited / Math.max(1, waits.length);
  const bound = ARRIVAL_BOUND_MS;
  console.log(`Q22CLO TURN05B arrivals=${waits.length} waited=${waited} share=${share.toFixed(4)} maxWaitMs=${Math.max(...waits).toFixed(2)} bound=${bound.toFixed(1)} runnerCommits=${commits} closing=${stillClosing} marks=${marks05(f)} batch=${shipped}`);
  expect(waits.length, "turns arrived beside the walk").toBeGreaterThan(500);
  expect(commits, "the closing walk committed while the turns arrived").toBeGreaterThan(0);
  expect(stillClosing, "the walk was still closing for the whole run").toBe(true);
  expect(share, "share of turn arrivals that waited behind closing work for the write lock").toBeLessThanOrEqual(ARRIVAL_WAITED_SHARE);
  expect(Math.max(...waits), "the longest a turn's arrival waited for the write lock, ms").toBeLessThanOrEqual(bound);
}, 600_000);

it("FENCE-05B: a turn waiting on a window (settleRevokesForTurn, the send fence's settle) while the idle 05b walk waits on its byte budget is never held by the pace: the runner commits for it at once", async () => {
  f = walkFixture05b();
  ledgerIdle(() => true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); setRevokeBudgetClock();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const meter = commitMeter(f.db), stats = runner.memoryRevocationStats as Record<string, number>;
  const waits0 = stats.idleClosingWaits ?? 0;
  runner.wakeMemoryRevocation(() => f!.db, { busy: () => false, sliceMs: SLICE05_MS });
  // until the idle walk waits on its wall-clock byte budget (the pace), at most 2 fake minutes
  for (let i = 0; i < 120 && (stats.idleClosingWaits ?? 0) === waits0; i++) await advance(1000, 50);
  expect(pendingStands(f), "the walk is still going").toBe(true);
  const before = meter.commits(), s0 = { ...stats };
  const settle = runner.settleRevokesForTurn(f.db, 2_000);
  await advance(2_000, 50);
  await settle;
  const during = meter.commits() - before;
  console.log(`Q22CLO FENCE05B paceWaits=${(stats.idleClosingWaits ?? 0) - waits0} commitsDuringSettle=${during} marks=${marks05(f)} ${["budgetWaits", "floorSlices", "markerSlices", "lockedRetries", "busyPauses", "markerYields", "idleClosingWaits", "slices"].map(k => `${k}+${(stats[k] ?? 0) - (s0[k] ?? 0)}`).join(" ")} paceWaitMs=${budget.revokePaceWaitMs?.(0) ?? "-"}`);
  // the pace would hold the next commit for seconds (its 61 s window); one commit inside the settle proves the gate let the waiter through
  expect(during, "runner commits for the waiting turn within its 2 s settle").toBeGreaterThanOrEqual(1);
}, 600_000);

it.runIf(process.env.Q22CLO_PROBE === "1")("PROBE-05B: the 05b-shape walk's figures (calibration only)", async () => {
  f = walkFixture05b();
  const t = performance.now();
  const r = await idleWalk(f, 60 * 60_000, { rows: marks05, sliceMs: SLICE05_MS });
  const minutes = r.ms / 60_000;
  console.log(`Q22CLO PROBE05B ms=${r.ms} realMs=${(performance.now() - t).toFixed(0)} bytes=${r.bytes} commits=${r.commits} rows=${r.rows} done=${r.done} MBmin=${(r.bytes / minutes / 1e6).toFixed(3)} rowsMin=${(r.rows / minutes).toFixed(0)} commitsMin=${(r.commits / minutes).toFixed(0)} bytesPerRow=${(r.bytes / Math.max(1, r.rows)).toFixed(0)} rowsPerCommit=${(r.rows / Math.max(1, r.commits)).toFixed(2)} budgetWaits=${runner.memoryRevocationStats.budgetWaits} sliceMs=${SLICE05_MS} batch=${(budget as { REVOKE_IDLE_CLOSING?: { batch: number } }).REVOKE_IDLE_CLOSING?.batch ?? "none"} store=${STORE}`);
}, 3_600_000);
