// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// D1 (step threshold and pass size), D2 (deferral and accepted-start stamps, late poll) and D3 (two-phase deterministic recovery of the idle verdict)
// of DESIGN-WALFLAKE6 rev8. The checkpointer's scheduler clock and ticks are test-driven through the WAL source transform
// (server/testing/wal-transform-edits.mjs, test-only): a tick happens only on a test message and is acknowledged after it completed.
import { Worker } from "node:worker_threads";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { checkpointLedger } from "./admission-shared.ts";
import { ADMISSION_MISS_BACKOFF_MS, ioBudget } from "./io-budget.ts";
import { JOURNAL_SIZE_LIMIT_BYTES, closeDatabase, database } from "./database.ts";
import { checkpointPassive, readWalHeader, settleWal, startWalMaintenance, stopWalMaintenance, walMaintenanceCounters, walMaintenanceReady, walResetFence } from "./wal-maintenance.ts";
import { searchCleanupPending, stopSearchIndex } from "./message-search-index.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { TRANSFORM_MARKER } from "./testing/wal-transform.mjs";

const MB = 1024 * 1024;
const messagesFile = () => join(DATA_DIR, "messages.db");
const walFile = () => `${messagesFile()}-wal`;

// The D13 schedule stays independent of the source transformed by the worker.
const stepBytes = 4 * MB;
const expectedSchedule = { STEP_BYTES: stepBytes, DUE_MS: 250, threshold: stepBytes };

function scheduleConstants() {
  const dir = process.env.WAL_PROD_HEAD_DIR;
  if (!dir) return expectedSchedule;
  const src = readFileSync(join(dir, "server/wal-maintenance.ts"), "utf8");
  const step = /export const STEP_BYTES = (\d+) \* 1024 \* 1024;/.exec(src);
  const due = /export const DUE_MS = (\d+);/.exec(src);
  const rule = /work = changed && \(saltChanged \|\| h\.logSize - base >= stepBytes( \* (\d+))?\);/.exec(src);
  expect(step && due && rule, "the unmutated source carries the STEP_BYTES, DUE_MS and step-rule anchors").toBeTruthy();
  const STEP_BYTES = Number(step![1]) * MB, DUE_MS = Number(due![1]);
  expect(expectedSchedule).toEqual({ STEP_BYTES, DUE_MS, threshold: STEP_BYTES * Number(rule![2] ?? 1) });
  return expectedSchedule;
}

// ---- the checkpointer workers this file starts, captured at construction ----
const workers: Worker[] = [];
const builtin = process.getBuiltinModule("node:worker_threads") as typeof import("node:worker_threads");
const realWorker = builtin.Worker;
const syncBuiltins = () => (process.getBuiltinModule("node:module") as unknown as { syncBuiltinESMExports(): void }).syncBuiltinESMExports();
let nextRpc = 0;
function rpc(worker: Worker, message: Record<string, unknown>, ackType: string): Promise<{ rec: TickRecord | null; t: number }> {
  const id = ++nextRpc;
  return new Promise((resolve, reject) => {
    const on = (m: { type?: string; id?: number; rec?: TickRecord | null; t?: number }) => {
      if (m && m.type === ackType && m.id === id) { worker.off("message", on); worker.off("error", reject); resolve({ rec: m.rec ?? null, t: m.t ?? 0 }); }
    };
    worker.on("message", on); worker.once("error", reject);
    worker.postMessage({ ...message, id });
  });
}
interface TickRecord { now: number; lastAt: number; due: boolean; work: boolean; started: boolean; deferredAt: number | null; accept: { acceptedStartAt: number; deferredAt: number | null } | null }
const tick = (advance = 0) => rpc(workers[workers.length - 1]!, { walTest: "tick", advance }, "walTickAck");

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
async function cleanSlate() {
  closeDatabase(); await stopSearchIndex(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
}
beforeEach(() => {
  workers.length = 0; unhandled.length = 0; process.on("unhandledRejection", onUnhandled);
  builtin.Worker = class extends realWorker {
    constructor(source: string | URL, options?: ConstructorParameters<typeof realWorker>[1]) {
      super(source as string, options);
      if (typeof source === "string" && source.includes(`/*${TRANSFORM_MARKER}*/`)) workers.push(this);
    }
  } as typeof realWorker;
  syncBuiltins();
});
afterEach(async () => {
  vi.useRealTimers(); ioBudget.stop();
  process.off("unhandledRejection", onUnhandled);
  delete process.env.WAL_TEST_CLOCK;
  (globalThis as { __walTimerPublications?: number }).__walTimerPublications = undefined;
  await cleanSlate();
  builtin.Worker = realWorker; syncBuiltins();
  expect(unhandled, "no unhandled rejection").toEqual([]);
});

function stepPorts(db: DatabaseSync) {
  return {
    setAutocheckpoint(pages: number) { db.exec(`PRAGMA wal_autocheckpoint=${pages}`); },
    async nudge() { const version = Number(db.prepare("PRAGMA user_version").get()!.user_version); db.exec(`PRAGMA user_version=${version}`); return true; },
    journalSizeLimit: () => Number(db.prepare("PRAGMA journal_size_limit").get()!.journal_size_limit),
    pinJournalSizeLimit: () => { db.exec(`PRAGMA journal_size_limit=${JOURNAL_SIZE_LIMIT_BYTES}`); },
  };
}
function commit(db: DatabaseSync, megabytes: number) {
  db.exec("BEGIN IMMEDIATE");
  const insert = db.prepare("INSERT INTO canary VALUES(?, randomblob(?))");
  for (let index = 0; index < megabytes; index++) insert.run("filler", MB);
  db.exec("COMMIT");
}
/** The app's connection and a checkpointer whose clock and ticks the test drives (WAL_TEST_CLOCK is read by the transformed worker at creation). */
async function drivenReady() {
  await cleanSlate();
  process.env.WAL_TEST_CLOCK = "1";
  const db = database();
  await vi.waitFor(() => expect(searchCleanupPending(db)).toBe(false), { timeout: 10_000, interval: 10 });
  await stopSearchIndex();
  await vi.waitFor(() => expect(walMaintenanceReady()).toBe(true), { timeout: 10_000, interval: 5 });
  db.exec("CREATE TABLE IF NOT EXISTS canary(thread_id TEXT, body BLOB)");
  expect(await settleWal({ nudge: true })).toBe(true);
  startWalMaintenance(messagesFile(), stepPorts(db));
  await vi.waitFor(() => expect(walMaintenanceReady()).toBe(true), { timeout: 10_000, interval: 5 });
  expect(workers.length, "the checkpointer carries the transform marker").toBeGreaterThan(0);
  return db;
}
/** A reader that pins the log (no restart, so the salt stays) and can move its snapshot to the end so the checkpoint can still copy. */
function pinReader() {
  const reader = new DatabaseSync(messagesFile());
  const snapshot = () => { reader.prepare("SELECT count(*) AS n FROM canary").get(); };
  reader.exec("BEGIN"); snapshot();
  return { advance() { reader.exec("COMMIT"); reader.exec("BEGIN"); snapshot(); }, close() { try { reader.exec("COMMIT"); } catch { /* none open */ } reader.close(); } };
}
const salt = () => JSON.stringify(readWalHeader(walFile()).header);
const walBytes = () => statSync(walFile()).size;

// ---------------------------------------------------------------- D1
it("D1 threshold: a commit of at least the step threshold is work on the first tick, and the pass starts", { timeout: 60_000 }, async () => {
  const { threshold, DUE_MS } = scheduleConstants();
  const db = await drivenReady();
  const pin = pinReader();
  try {
    const saltBefore = salt();
    const baseline = walBytes();
    commit(db, 5);
    const growth = walBytes() - baseline;
    expect(salt(), "the pinned salt is unchanged (a salt change would count as work by itself)").toBe(saltBefore);
    expect(growth, "growth reaches the threshold").toBeGreaterThanOrEqual(threshold);
    expect(growth, "and stays below 4,000 MiB").toBeLessThan(4000 * MB);
    pin.advance();
    const first = await tick(0);
    expect(first.t - first.rec!.lastAt, "the worker clock is below DUE_MS: only the step rule can start this pass").toBeLessThan(DUE_MS);
    expect(first.rec!.work, "the first tick after the commit sees work").toBe(true);
    expect(first.rec!.started, "and starts the timed pass").toBe(true);
  } finally { pin.close(); }
});

it("D1 pass size: ten commits of one step each are copied one step at a time, never as one large pass", { timeout: 120_000 }, async () => {
  const { STEP_BYTES, DUE_MS, threshold } = scheduleConstants();
  const db = await drivenReady();
  const pin = pinReader();
  try {
    const clockStart = (await tick(0)).t;
    const inflated = threshold * 1000;
    let aggregate = 0, last = clockStart;
    for (let index = 0; index < 10; index++) {
      const baseline = walBytes();
      commit(db, 5);
      const growth = walBytes() - baseline;
      expect(growth, `commit ${index}: at least STEP_BYTES`).toBeGreaterThanOrEqual(STEP_BYTES);
      expect(growth, `commit ${index}: below the three-step pass bound`).toBeLessThan(3 * STEP_BYTES);
      aggregate += growth;
      pin.advance();
      last = (await tick(0)).t; // acknowledged COMPLETED tick before the next commit
    }
    expect(aggregate, "the aggregate stays below the inflated threshold").toBeLessThan(inflated);
    expect(last - clockStart, "the worker clock stayed below DUE_MS during accumulation").toBeLessThan(DUE_MS);
    await tick(DUE_MS); // the clock reaches lastAt + DUE_MS
    const counters = walMaintenanceCounters()!;
    expect(counters.maxPassCopyKiB, "passes really copied").toBeGreaterThan(0);
    expect(counters.maxPassCopyKiB, "the largest single pass stays within three steps").toBeLessThan(3 * STEP_BYTES / 1024);
  } finally { pin.close(); }
});

// ---------------------------------------------------------------- D2
it("D2 stamps: the deferral and the accepted start are on one worker clock, and the accepted start follows the deferral within DUE_MS", { timeout: 60_000 }, async () => {
  const { DUE_MS } = scheduleConstants();
  const db = await drivenReady();
  const pin = pinReader();
  try {
    commit(db, 5);
    pin.advance();
    walResetFence().enter(); // a reset wants the log: the timed pass is deferred
    const deferred = await tick(0);
    expect(deferred.rec!.started, "the pass was deferred, not started").toBe(false);
    expect(deferred.rec!.deferredAt, "the deferral is stamped").not.toBeNull();
    walResetFence().leave();
    const started = await tick(0);
    expect(started.rec!.started, "the next tick starts the pass").toBe(true);
    const accept = started.rec!.accept!;
    expect(accept, "the accepted start is stamped").not.toBeNull();
    expect(accept.deferredAt, "the matching deferral was kept before it was cleared").toBe(deferred.rec!.deferredAt);
    expect(accept.acceptedStartAt).toBeGreaterThanOrEqual(accept.deferredAt!);
    expect(accept.acceptedStartAt - accept.deferredAt!, "the start gate: accepted at most DUE_MS after the deferral").toBeLessThanOrEqual(DUE_MS);
  } finally { walResetFence().leave(); pin.close(); }
});

it("D2 late poll: a change below the step threshold starts a pass exactly when the worker clock reaches lastAt + DUE_MS", { timeout: 60_000 }, async () => {
  const { DUE_MS } = scheduleConstants();
  const db = await drivenReady();
  const pin = pinReader();
  try {
    commit(db, 5);
    pin.advance();
    expect((await tick(0)).rec!.started, "setup: the first step is copied").toBe(true);
    db.prepare("INSERT INTO canary VALUES(?, randomblob(?))").run("small", 100); // changed, far below the step threshold
    pin.advance();
    const early = await tick(DUE_MS - 1);
    expect(early.rec!.work, "below the step threshold").toBe(false);
    expect(early.rec!.started, "DUE_MS - 1 after the last pass: not yet").toBe(false);
    const due = await tick(1);
    expect(due.t - due.rec!.lastAt, "the clock is exactly DUE_MS after the last pass").toBe(DUE_MS);
    expect(due.rec!.started, "DUE_MS after the last pass: the timed rule starts the pass on this tick").toBe(true);
  } finally { pin.close(); }
});

// ---------------------------------------------------------------- D3
it("D3 recovery: one held 25 ms invocation misses (slot 7 = 1); the next invocation alone republishes (slot 7 = 0)", { timeout: 60_000 }, async () => {
  await cleanSlate();
  // Fake timers BEFORE anything starts: the main thread's own timers (the budget's 25 ms read, the maintenance tick) are then driven by this test alone.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  process.env.WAL_TEST_CLOCK = "1"; // the checkpointer never ticks by itself
  database(); // opening the database starts the checkpointer this test drives
  const spin = async (until: () => boolean) => { const stop = performance.now() + 10_000; while (!until() && performance.now() < stop) await new Promise<void>(r => setImmediate(r)); };
  await spin(() => walMaintenanceReady());
  expect(walMaintenanceReady()).toBe(true);
  ioBudget.start();
  const slots = new BigInt64Array(ioBudget.checkpointAdmissionBuffer());
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const holder = new realWorker(`const { parentPort, workerData, threadId } = require("node:worker_threads");
    const ledger = (0, eval)("(" + workerData.src + ")")(workerData.buf, threadId);
    const flag = new Int32Array(workerData.flag);
    ledger.lock(); parentPort.postMessage("held"); Atomics.wait(flag, 0, 0, 20000); ledger.unlock(); parentPort.postMessage("released");`,
  { eval: true, workerData: { buf: slots.buffer, src: checkpointLedger.toString(), flag: flag.buffer } });
  const publications = () => (globalThis as { __walTimerPublications?: number }).__walTimerPublications ?? 0;
  try {
    await new Promise<void>((resolve, reject) => { holder.once("message", () => resolve()); holder.once("error", reject); });
    // setup observations, then reset the counters
    expect(slots[7], "idle verdict before the window").toBe(0n);
    (globalThis as { __walTimerPublications?: number }).__walTimerPublications = 0;
    const before = ioBudget.admissionHealth();
    // Phase 1: the ledger is held for exactly one scheduled invocation
    vi.advanceTimersByTime(25);
    const missed = ioBudget.admissionHealth();
    expect(missed.lockTimeouts - before.lockTimeouts, "phase 1: exactly one miss").toBe(1);
    expect(slots[7], "phase 1: the miss fails closed (slot 7 = 1)").toBe(1n);
    expect(publications(), "phase 1: nothing was published").toBe(0);
    // acknowledge the release
    Atomics.store(flag, 0, 1); Atomics.notify(flag, 0);
    await new Promise<void>(resolve => { holder.once("message", () => resolve()); holder.once("exit", () => resolve()); });
    // Phase 2: the next invocation, asserted BEFORE anything is awaited. CHANGED EXPECTATION (MAIN-RULING 2026-11-25T13:37:06Z IDLECPU-1022 cause 3,
    // q1022-lockloop-opus): after a miss the refresh backs off ADMISSION_MISS_BACKOFF_MS (250 ms), never a 25 ms re-arm, so the next invocation is at 250 ms.
    vi.advanceTimersByTime(25);
    expect(publications(), "phase 2: backed off, no invocation 25 ms after the miss").toBe(0);
    vi.advanceTimersByTime(ADMISSION_MISS_BACKOFF_MS - 25);
    expect(publications(), "phase 2: exactly one successful timer-origin publication").toBe(1);
    expect(slots[7], "phase 2: slot 7 = 0").toBe(0n);
    expect(ioBudget.admissionHealth().lockTimeouts, "no second miss").toBe(missed.lockTimeouts);
    // close the exclusive window, then drive the worker and await its acknowledged result
    ioBudget.stop(); vi.useRealTimers();
    expect(await settleWal({ nudge: true }), "the settle after the window completes").toBe(true);
    expect((await checkpointPassive()).busy, "the worker answers").toBeDefined();
  } finally {
    Atomics.store(flag, 0, 1); Atomics.notify(flag, 0);
    ioBudget.stop(); vi.useRealTimers();
    await holder.terminate();
  }
});
