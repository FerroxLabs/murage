// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 revoke storm, M3 (REVOKE-STORM-DESIGN-M, agreed): the marker walks in bounded slices under a hard write budget per minute, every
// write counted, and yields to foreground turns. Total work is unchanged; it no longer hogs the Mac.
// 1.0.3 revoke drain F2, Option S (REVOKE-BUDGET-DESIGN section 5): every slice is charged rows x C at its own marker call and the charge
// ages out 60 s later whatever its transaction does (S1); C is the per-row cost the runner measures on the transactions it BEGINs and
// COMMITs itself, seeded at the 2-frame ceiling and capped there (S2); admission and sizing are at C (S3); every 60 s window of charges is
// at or under the budget plus the most recent slice's excess over its allowance (S4); the index is read through a descriptor that is never
// closed (S6). Nothing is inferred from SQL or the WAL for a transaction the drain does not own, and there are no records.
import fs, { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SETTLE_ACTIVE_FLOW, SETTLE_SEEDING_FOLD } from "./schema.ts";
import * as budget from "./revoke-budget.ts";
import * as marker from "./revoke-marker.ts";
import { commitRevoke, drainFlipsIntoBulk, receiptCommitCost } from "./revoke-commit.ts";
import type { WritetimeFixture } from "./testing/writetime-fixture.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryRevocationIdle, memoryRevocationStats, resetMemoryRevocationStats, drainRevokeMarkerBounded, stopMemoryRevocation, wakeMemoryRevocation } from "./memory-revocation.ts";
import { beginRevokeMeasure, budgetedMarkerSlice, bytesPerChange, endRevokeMeasure, frameBytes, noteRevokeBytes, noteRevokeCost, REVOKE_COMMIT_REBALANCE_FRAMES, REVOKE_COST_MEMORY_ROWS, REVOKE_PACE, REVOKE_PACE_COMMIT, REVOKE_WRITE_BUDGET, REVOKE_WRITE_WINDOW_MS, resetRevokeWriteBudget, revokeBytesWritten, revokeChangeCeiling, revokeCostPerChange, revokeMinuteChanges, revokeSliceNeed, revokeWriteMeter, revokeWriteWaitMs, setRevokeBudgetClock } from "./revoke-budget.ts";
import { instrumentDatabase } from "../io-budget.ts";
import { headFlipCost, MARKER_STEP_RESERVE } from "./revoke-marker.ts";
import { changes, flipAll, num, storm } from "./testing/revoke-storm-fixture.ts";
import { windowsNightly } from "../testing/windows-hosted.ts";

type Fx = ReturnType<typeof storm>;
/** Receipt `bundle` cites `n` records none of which was ever interned (as revoke-storm-holes.test.ts does). */
function cite(fx: Fx, bundle: string, n: number): void {
  const list = Array.from({ length: n }, (_, i) => ({ id: `${bundle}-cited-${i}`, version: 1 }));
  fx.db.prepare("UPDATE memory_disclosures SET record_versions=? WHERE bundle_id=?").run(JSON.stringify(list), bundle);
}

const MB20 = 20 * 1024 * 1024;
const paceLimit = REVOKE_PACE.bytesPerMinute, commitLimit = REVOKE_PACE_COMMIT.rows;
// These cases isolate the charged write budget. The measured pace and commit cap have their own bounds tests.
beforeEach(() => { REVOKE_PACE.bytesPerMinute = Number.POSITIVE_INFINITY; REVOKE_PACE_COMMIT.rows = 1_000_000; });
afterEach(() => { REVOKE_PACE.bytesPerMinute = paceLimit; REVOKE_PACE_COMMIT.rows = commitLimit; vi.restoreAllMocks(); });
afterEach(() => { setRevokeBudgetClock(); resetRevokeWriteBudget(); REVOKE_WRITE_BUDGET.bytesPerMinute = MB20; stopMemoryRevocation(); resetMemoryRevocationStats(); });

describe("M3: the marker stays inside its write budget and yields to foreground turns", () => {
  it("never writes more than the budget in a minute; the rest waits for the next minute and finishes", windowsNightly(), () => {
    const fx = storm(122);
    let now = 1_000_000;
    setRevokeBudgetClock(() => now);
    resetRevokeWriteBudget();
    const page = bytesPerChange(fx.db);
    REVOKE_WRITE_BUDGET.bytesPerMinute = 1800 * page;
    try {
      flipAll(fx);
      let minutes = 0, pending = true;
      while (pending) {
        expect(minutes).toBeLessThan(60);
        const before = changes(fx);
        // the send fence, a refused turn's settle and the upgrade all drain through this, as often as they like within the minute
        for (let n = 0; n < 50 && pending; n++) pending = drainRevokeMarkerBounded(fx.db, { rows: 1_000_000, ms: 1_000_000 });
        const written = (changes(fx) - before) * page;
        expect(written).toBeLessThanOrEqual(REVOKE_WRITE_BUDGET.bytesPerMinute);
        expect(revokeBytesWritten()).toBeLessThanOrEqual(REVOKE_WRITE_BUDGET.bytesPerMinute);
        minutes++;
        now += 61_000;
      }
      // the storm needed more than one minute's budget, and every write of it was charged
      expect(minutes).toBeGreaterThan(1);
      expect(num(fx, "SELECT count(*) AS n FROM memory_receipt_flips")).toBe(0);
      expect(num(fx, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state IN ('active','seeding')")).toBe(0);
      expect(num(fx, "SELECT count(*) AS n FROM (SELECT DISTINCT thread_id,driver_instance,native_session FROM memory_deny_session)")).toBe(122);
    } finally { fx.close(); }
  });

  it("the runner trickles while a foreground turn is live (a half slice per busy pause, never a stop), then finishes once it ends", async () => {
    // 1.0.3 walked nothing under a live turn and ran one slice every 10 s: a bot whose turns never stop kept every window open for days
    // (SELF-OVERLOAD-105 item 1c). Now each busy tick is a shorter slice, counted as a yield, spaced by the busy pause.
    const fx = storm(8);
    let busy = true;
    try {
      flipAll(fx);
      wakeMemoryRevocation(() => fx.db, { busy: () => busy, busyPauseMs: 40, pauseMs: 1 });
      await new Promise(resolve => setTimeout(resolve, 100));
      // under the turn the marker moved (a flip drained or a job walked), at the busy cadence: at most a handful of slices in 100 ms
      expect(memoryRevocationStats.markerYields).toBeGreaterThan(0);
      expect(memoryRevocationStats.markerYields).toBeLessThanOrEqual(4);
      expect(num(fx, "SELECT count(*) AS n FROM memory_receipt_flips") + num(fx, "SELECT count(*) AS n FROM memory_revoke_jobs")).toBeGreaterThan(0);
      busy = false;
      await memoryRevocationIdle();
      expect(num(fx, "SELECT count(*) AS n FROM memory_receipt_flips")).toBe(0);
      expect(num(fx, "SELECT count(*) AS n FROM memory_deny_session")).toBe(8);
    } finally { stopMemoryRevocation(); fx.close(); }
  });
});

const walFile = (fx: { db: Fx["db"] }) => `${(fx.db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(row => row.name === "main")!.file}-wal`;
const walSize = (fx: { db: Fx["db"] }) => { try { return statSync(walFile(fx)).size; } catch { return 0; } };
/** A WAL-mode storm with its log emptied after the flips, so every byte the log grows by from here is the marker's. */
function walStorm(receipts: number): Fx {
  const fx = storm(receipts);
  fx.db.exec("PRAGMA journal_mode=WAL"); fx.db.exec("PRAGMA wal_autocheckpoint=0");
  flipAll(fx);
  fx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return fx;
}
/** C after one measurement of `bytes` over `rows`, from `from` (S2: rows-weighted, memory M, capped at W). */
const next = (from: number, bytes: number, rows: number, W: number) => Math.min(W, (from * REVOKE_COST_MEMORY_ROWS + bytes) / (REVOKE_COST_MEMORY_ROWS + rows));

describe("S2: C is measured only on the runner's own commits, seeded at the ceiling and capped there", () => {
  it("starts at the 2-frame ceiling; a runner commit on a WAL file moves it to exactly (W M + bytes) / (M + rows), and the drain charges rows x C", () => {
    const fx = walStorm(40);
    setRevokeBudgetClock(() => 1_000_000);
    resetRevokeWriteBudget();
    try {
      const W = revokeChangeCeiling(fx.db);
      expect(W).toBe(2 * frameBytes(fx.db));
      expect(revokeCostPerChange(fx.db)).toBe(W);
      // one slice, as the send fence runs it: BEGIN, the slice, COMMIT, then the drain's own measurement of what its commit wrote
      let committedWal = 0;
      const exec = fx.db.exec.bind(fx.db);
      vi.spyOn(fx.db, "exec").mockImplementation(sql => {
        exec(sql);
        // The drain may checkpoint and reset immediately after COMMIT; capture the bytes before that copy.
        if (sql.trim().toUpperCase() === "COMMIT") committedWal = walSize(fx);
      });
      let c0 = changes(fx), w0 = walSize(fx);
      drainRevokeMarkerBounded(fx.db, { rows: 64, ms: 1_000_000 });
      const rows1 = changes(fx) - c0, bytes1 = committedWal - w0;
      expect(rows1).toBeGreaterThan(0);
      expect(bytes1).toBeGreaterThan(0);
      // charged at the C it was admitted with (the seed), whole, at the call
      expect(revokeBytesWritten()).toBe(Math.ceil(rows1 * W));
      expect(revokeWriteMeter.slices).toBe(1);
      expect(revokeWriteMeter.measured).toBe(1);
      expect(revokeWriteMeter.measuredBytes).toBe(bytes1);
      expect(revokeWriteMeter.measuredChanges).toBe(rows1);
      const C1 = next(W, bytes1, rows1, W);
      expect(revokeCostPerChange(fx.db)).toBeCloseTo(C1, 6);
      expect(C1).toBeLessThan(W);
      // the next slice is charged at the measured C, and moves C again from what it wrote
      c0 = changes(fx); w0 = walSize(fx);
      const charged0 = revokeBytesWritten();
      drainRevokeMarkerBounded(fx.db, { rows: 64, ms: 1_000_000 });
      const rows2 = changes(fx) - c0, bytes2 = committedWal - w0;
      expect(rows2).toBeGreaterThan(0);
      expect(revokeBytesWritten() - charged0).toBe(Math.ceil(rows2 * C1));
      expect(revokeCostPerChange(fx.db)).toBeCloseTo(next(C1, bytes2, rows2, W), 6);
      expect(revokeWriteMeter.measured).toBe(2);
      expect(revokeWriteMeter.overCeiling).toBe(0);
    } finally { fx.close(); }
  });

  it("a measurement of 10 frames a row leaves C at the cap and counts over the ceiling; a cheap one lowers it by its weight in M rows", () => {
    const fx = storm(1);
    resetRevokeWriteBudget();
    try {
      const F = frameBytes(fx.db), W = revokeChangeCeiling(fx.db);
      noteRevokeCost(fx.db, 10 * F * 500, 500);
      expect(revokeCostPerChange(fx.db)).toBe(W);
      expect(revokeWriteMeter.overCeiling).toBe(1);
      expect(revokeWriteMeter.maxPerChange).toBe(10 * F);
      noteRevokeCost(fx.db, Math.round(0.25 * F) * 1000, 1000);
      expect(revokeCostPerChange(fx.db)).toBeCloseTo((W * REVOKE_COST_MEMORY_ROWS + Math.round(0.25 * F) * 1000) / (REVOKE_COST_MEMORY_ROWS + 1000), 6);
      expect(revokeWriteMeter.overCeiling).toBe(1);
      // a heavy measurement brings it back up, and never past the cap
      noteRevokeCost(fx.db, 3 * F * 100_000, 100_000);
      expect(revokeCostPerChange(fx.db)).toBe(W);
      expect(revokeWriteMeter.overCeiling).toBe(2);
      // nothing measured over zero rows, or with no bytes
      noteRevokeCost(fx.db, 1000, 0);
      noteRevokeCost(fx.db, 0, 1000);
      expect(revokeCostPerChange(fx.db)).toBe(W);
      expect(revokeWriteMeter.measured).toBe(3);
      // a run of cheap samples (held jobs saved unchanged: one frame over thousands of rows) stops at the floor, an eighth of the ceiling,
      // and the next real sample lifts it again from there
      for (let n = 0; n < 50; n++) noteRevokeCost(fx.db, F, 4096);
      expect(revokeCostPerChange(fx.db)).toBe(W / 8);
      noteRevokeCost(fx.db, F, 4096);
      expect(revokeCostPerChange(fx.db)).toBe(W / 8);
      noteRevokeCost(fx.db, 1.5 * F * 4096, 4096);
      expect(revokeCostPerChange(fx.db)).toBeCloseTo((W / 8 * REVOKE_COST_MEMORY_ROWS + 1.5 * F * 4096) / (REVOKE_COST_MEMORY_ROWS + 4096), 6);
      expect(revokeCostPerChange(fx.db)).toBeGreaterThan(W / 8);
    } finally { fx.close(); }
  });

  it("B14: a commit of a few rows that splits its leaves reads past W a row, yet is within the ceiling: a split is the commit's cost, not each row's", () => {
    const fx = walStorm(4);
    setRevokeBudgetClock(() => 1_000_000);
    resetRevokeWriteBudget();
    try {
      const F = frameBytes(fx.db), W = revokeChangeCeiling(fx.db);
      expect(bytesPerChange(fx.db)).toBe(4096); // the probe below is sized for 4 KiB pages
      // the 1.0.6 rc1 gate's measurement: 5 rows, 11 frames (9,064 bytes a row against W = 8,240) is one split, not a model error
      noteRevokeCost(fx.db, 11 * F, 5);
      expect(11 * F / 5).toBeGreaterThan(W);
      expect(revokeWriteMeter.overCeiling).toBe(0);
      expect(revokeWriteMeter.maxPerChange).toBe(11 * F / 5);
      expect(revokeCostPerChange(fx.db)).toBe(W);
      // past one commit's rebalances it still counts, however few the rows
      noteRevokeCost(fx.db, (5 * 2 + REVOKE_COMMIT_REBALANCE_FRAMES + 1) * F, 5);
      expect(revokeWriteMeter.overCeiling).toBe(1);
      // real one-row commits into a table and its one index (as memory_deny_memory and its revoke index): measured as the runner measures,
      // each splitting commit writes more than 2 frames for its one row, and none counts over the ceiling
      fx.db.exec("CREATE TABLE b14_probe(id INTEGER PRIMARY KEY, k TEXT, v TEXT); CREATE INDEX b14_probe_k ON b14_probe(k)");
      fx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      resetRevokeWriteBudget();
      const insert = fx.db.prepare("INSERT INTO b14_probe(k,v) VALUES(?,?)");
      let split = 0;
      for (let i = 0; i < 60; i++) {
        fx.db.exec("BEGIN IMMEDIATE");
        const m = beginRevokeMeasure(fx.db);
        insert.run(`${String(i).padStart(4, "0")}${"k".repeat(300)}`, "v".repeat(300));
        fx.db.exec("COMMIT");
        const bytes = endRevokeMeasure(fx.db, m);
        expect(bytes).not.toBeNull();
        if (bytes! - (i === 0 ? 32 : 0) > W) split++;
        expect(bytes!).toBeLessThanOrEqual(32 + W + REVOKE_COMMIT_REBALANCE_FRAMES * F);
      }
      expect(split).toBeGreaterThan(0);
      expect(revokeWriteMeter.measured).toBe(60);
      expect(revokeWriteMeter.overCeiling).toBe(0);
      // sustained excess still counts: one-row commits of 3 frames each are within the tolerance one by one, but once a memory's worth of
      // rows is past W a row on the whole, each further one is over
      resetRevokeWriteBudget();
      for (let i = 0; i < REVOKE_COST_MEMORY_ROWS - 1; i++) noteRevokeCost(fx.db, 3 * F, 1);
      expect(revokeWriteMeter.overCeiling).toBe(0);
      noteRevokeCost(fx.db, 3 * F, 1);
      noteRevokeCost(fx.db, 3 * F, 1);
      expect(revokeWriteMeter.overCeiling).toBe(2);
    } finally { fx.close(); }
  });

  it("a file with no index (no WAL) measures nothing and keeps the seed: the drain is charged the ceiling a row", () => {
    const fx = storm(8);
    // With no index nothing proves the drain's copy, so the pace (r3.6c) keeps its copy debt until the 60 s bound: on a frozen clock the drain
    // answers "pending" for ever. Each pass is therefore a minute on, and the loop is bounded and FAILS when the drain does not finish (an
    // unbounded synchronous spin here held every full vitest run for hours: VTHANG-1019).
    let now = 1_000_000;
    setRevokeBudgetClock(() => now);
    resetRevokeWriteBudget();
    try {
      flipAll(fx);
      const c0 = changes(fx), charged0 = revokeWriteMeter.charged;
      let passes = 0;
      while (drainRevokeMarkerBounded(fx.db, { rows: 1_000_000, ms: 1_000_000 })) {
        expect(++passes).toBeLessThan(20);
        now += REVOKE_WRITE_WINDOW_MS + 1_000;
      }
      const changed = changes(fx) - c0;
      expect(changed).toBeGreaterThan(0);
      expect(revokeWriteMeter.measured).toBe(0);
      expect(revokeWriteMeter.slices).toBeGreaterThan(0);
      expect(revokeCostPerChange(fx.db)).toBe(revokeChangeCeiling(fx.db));
      // each pass's charge ages out a minute later, so the whole drain is read off the meter's running total
      expect(revokeWriteMeter.charged - charged0).toBe(changed * revokeChangeCeiling(fx.db));
    } finally { fx.close(); }
  });

  it("the measurement is the log's growth over the runner's own transaction: a log that restarts under a truncating checkpoint still measures every frame", () => {
    const fx = walStorm(40);
    setRevokeBudgetClock(() => 1_000_000);
    resetRevokeWriteBudget();
    try {
      fx.db.exec("CREATE TABLE budget_probe(x INTEGER, y TEXT)");
      fx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      expect(walSize(fx)).toBe(0);
      // a transaction of known rows: measured whole, the log's header included, and C moves by exactly that
      let m = beginRevokeMeasure(fx.db);
      fx.db.exec("BEGIN IMMEDIATE");
      m = beginRevokeMeasure(fx.db);
      const insert = fx.db.prepare("INSERT INTO budget_probe VALUES(?,?)");
      for (let i = 0; i < 300; i++) insert.run(i, "x".repeat(200));
      fx.db.exec("COMMIT");
      const committedBytes = walSize(fx);
      const bytes = endRevokeMeasure(fx.db, m);
      expect(bytes).toBe(committedBytes);
      expect(revokeWriteMeter.measuredChanges).toBe(300);
      const W = revokeChangeCeiling(fx.db);
      expect(revokeCostPerChange(fx.db)).toBeCloseTo(next(W, bytes!, 300, W), 6);
      // the log is checkpointed and truncated: the next runner transaction restarts it, with a new salt and frames counted from one
      fx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      expect(walSize(fx)).toBe(0);
      fx.db.exec("BEGIN IMMEDIATE");
      m = beginRevokeMeasure(fx.db);
      budgetedMarkerSlice(fx.db, 4096, 1_000_000);
      fx.db.exec("COMMIT");
      const restartedBytes = walSize(fx);
      expect(endRevokeMeasure(fx.db, m)).toBe(restartedBytes);
      expect(revokeWriteMeter.measured).toBe(2);
      // a transaction that changed nothing measures nothing; a measure begun outside any transaction measures nothing
      fx.db.exec("BEGIN IMMEDIATE"); m = beginRevokeMeasure(fx.db); fx.db.exec("COMMIT");
      expect(endRevokeMeasure(fx.db, m)).toBeNull();
      expect(revokeWriteMeter.measured).toBe(2);
    } finally { fx.close(); }
  });

  it("S6: reads the WAL index through one descriptor kept for the connection: no close ever touches the -shm file during a drain", windowsNightly(), () => {
    // closing ANY descriptor on the -shm drops every POSIX lock this process holds on it, SQLite's included: the memory worker could then
    // reset the shm under SQLite's live mapping (SIGBUS, 1.0.3 rehearsal). A per-slice open, read and close fails this test.
    const fx = storm(400);
    fx.db.exec("PRAGMA journal_mode=WAL"); fx.db.exec("PRAGMA wal_autocheckpoint=0");
    let now = 1_200_000;
    setRevokeBudgetClock(() => now);
    resetRevokeWriteBudget();
    const opens = vi.spyOn(fs, "openSync"), closes = vi.spyOn(fs, "closeSync");
    try {
      flipAll(fx);
      const shm = walFile(fx).replace(/-wal$/, "-shm");
      // the first measured slice opens the descriptor; from then on the process's open descriptors stay as they are
      drainRevokeMarkerBounded(fx.db, { rows: 64, ms: 1_000_000 });
      expect(revokeWriteMeter.measured).toBe(1);
      const descriptors = () => { try { return fs.readdirSync("/dev/fd").length; } catch { return -1; } };
      const held = descriptors();
      let pending = true;
      // the drain waits for the minute's room as the runner does (the virtual clock moves on), slice after slice to the end
      for (let n = 0; n < 10_000 && pending; n++) { now += Math.max(1, revokeWriteWaitMs(revokeSliceNeed(fx.db))); pending = drainRevokeMarkerBounded(fx.db, { rows: 64, ms: 1_000_000 }); }
      expect(pending).toBe(false);
      expect(revokeWriteMeter.measured).toBeGreaterThan(10);
      const shmOpens = opens.mock.calls.filter(call => String(call[0]) === shm);
      expect(shmOpens.length).toBe(1);
      const fd = opens.mock.results[opens.mock.calls.findIndex(call => String(call[0]) === shm)]!.value as number;
      expect(closes.mock.calls.some(call => call[0] === fd)).toBe(false);
      if (held >= 0) expect(descriptors()).toBe(held);
      // closing the connection closes nothing of ours either: a close would drop the locks of any other connection on that inode
      fx.close();
      expect(closes.mock.calls.some(call => call[0] === fd)).toBe(false);
    } finally { opens.mockRestore(); closes.mockRestore(); try { fx.close(); } catch { /* closed above */ } }
  });
});

// S3, S4: admission and sizing at C, and the bound on charges over every 60 s window.
type Charge = { at: number; bytes: number; changed: number; allowance: number };
/** Drains a storm through budgeted slices as the runner does (wait for room, BEGIN, slice, COMMIT, measure) on a virtual clock, recording
 * every slice's charge by its time with the allowance it was admitted under, so every 60 s window of charges can be checked. */
function drainCharges(receipts: number, wal: boolean, budget: number): { charges: Charge[]; fx: Fx; minutes: number } {
  const fx = wal ? walStorm(receipts) : storm(receipts);
  if (!wal) flipAll(fx);
  let now = 2_000_000;
  const start = now;
  setRevokeBudgetClock(() => now);
  resetRevokeWriteBudget();
  REVOKE_WRITE_BUDGET.bytesPerMinute = budget;
  const charges: Charge[] = [];
  for (let n = 0; ; n++) {
    expect(n).toBeLessThan(20_000);
    const wait = revokeWriteWaitMs(revokeSliceNeed(fx.db));
    expect(wait).toBeLessThanOrEqual(REVOKE_WRITE_WINDOW_MS);
    now += Math.max(1, wait);
    const allowance = budget - revokeBytesWritten();
    const c0 = changes(fx), charged0 = revokeWriteMeter.charged;
    fx.db.exec("BEGIN IMMEDIATE");
    const m = beginRevokeMeasure(fx.db);
    let moved: boolean | "budget";
    try { moved = budgetedMarkerSlice(fx.db, 4096, 1_000_000); fx.db.exec("COMMIT"); } catch (e) { fx.db.exec("ROLLBACK"); throw e; }
    endRevokeMeasure(fx.db, m);
    const changed = changes(fx) - c0;
    if (changed > 0) charges.push({ at: now, bytes: revokeWriteMeter.charged - charged0, changed, allowance });
    if (moved === false) break;
  }
  return { charges, fx, minutes: (now - start) / REVOKE_WRITE_WINDOW_MS };
}
/** Every 60 s window ending at a charge (the busiest windows do): its charged bytes, and the excess of its most recent charge over the
 * allowance that slice was admitted with (S4). */
function windows(charges: Charge[]): Array<{ bytes: number; excess: number }> {
  return charges.map(end => {
    const inside = charges.filter(c => c.at > end.at - REVOKE_WRITE_WINDOW_MS && c.at <= end.at);
    return { bytes: inside.reduce((a, c) => a + c.bytes, 0), excess: Math.max(0, end.bytes - end.allowance) };
  });
}

describe("S3, S4: a slice is admitted and sized at C, charged whole at its call, and no window of charges exceeds the budget by more than one slice's excess", () => {
  it("every 60 s window of charges is at or under the budget plus its most recent slice's excess, at the seed and with C measured; the measured drain needs fewer minutes", windowsNightly(), () => {
    const results: Record<string, { minutes: number; peak: number; slices: number }> = {};
    for (const wal of [false, true]) {
      const run = drainCharges(400, wal, 1800 * 4096);
      try {
        const seen = windows(run.charges);
        for (const w of seen) expect(w.bytes).toBeLessThanOrEqual(1800 * 4096 + w.excess);
        // the drain spanned several windows, so windows were tested
        expect(run.minutes).toBeGreaterThan(1);
        if (wal) { expect(revokeWriteMeter.measured).toBe(run.charges.length); expect(revokeCostPerChange(run.fx.db)).toBeLessThan(revokeChangeCeiling(run.fx.db)); }
        else expect(revokeWriteMeter.measured).toBe(0);
        results[wal ? "measured" : "seed"] = { minutes: run.minutes, peak: Math.max(...seen.map(w => w.bytes)), slices: run.charges.length };
      } finally { run.fx.close(); }
    }
    expect(results.measured!.minutes).toBeLessThan(results.seed!.minutes);
    console.log(`S4 seed: ${results.seed!.slices} slices in ${results.seed!.minutes.toFixed(1)} min, peak ${(results.seed!.peak / 1048576).toFixed(2)} MB; measured: ${results.measured!.slices} slices in ${results.measured!.minutes.toFixed(1)} min, peak ${(results.measured!.peak / 1048576).toFixed(2)} MB`);
  });

  it("S3: a slice is admitted only with room for its least rows at C, and never changes more rows than the room holds at C", windowsNightly(), () => {
    const fx = walStorm(400);
    setRevokeBudgetClock(() => 4_000_000);
    resetRevokeWriteBudget();
    try {
      const budget = REVOKE_WRITE_BUDGET.bytesPerMinute, C = revokeCostPerChange(fx.db);
      const need = Math.ceil(C * (64 + MARKER_STEP_RESERVE));
      expect(revokeSliceNeed(fx.db)).toBe(need);
      expect(need).toBeLessThan(budget);
      // one byte short of the least slice's room: nothing runs and nothing is charged
      noteRevokeBytes(budget - need + 1);
      let c0 = changes(fx);
      fx.db.exec("BEGIN IMMEDIATE");
      expect(budgetedMarkerSlice(fx.db, 1_000_000, 1_000_000)).toBe("budget");
      fx.db.exec("COMMIT");
      expect(changes(fx) - c0).toBe(0);
      expect(revokeWriteMeter.slices).toBe(0);
      expect(revokeBytesWritten()).toBe(budget - need + 1);
      // exactly the room: the slice runs and changes at most what the room holds at C
      resetRevokeWriteBudget();
      noteRevokeBytes(budget - need);
      c0 = changes(fx);
      fx.db.exec("BEGIN IMMEDIATE"); budgetedMarkerSlice(fx.db, 1_000_000, 1_000_000); fx.db.exec("COMMIT");
      const changed = changes(fx) - c0;
      expect(changed).toBeGreaterThan(0);
      expect(changed).toBeLessThanOrEqual(Math.floor(need / C));
      expect(revokeBytesWritten()).toBe(budget - need + Math.ceil(changed * C));
      // an empty window: the slice changes at most what the whole budget holds at C, and the charge stays inside the budget
      resetRevokeWriteBudget();
      c0 = changes(fx);
      fx.db.exec("BEGIN IMMEDIATE"); budgetedMarkerSlice(fx.db, 1_000_000, 1_000_000); fx.db.exec("COMMIT");
      expect(changes(fx) - c0).toBeLessThanOrEqual(Math.floor(budget / C));
      expect(revokeBytesWritten()).toBeLessThanOrEqual(budget);
      // sized at the C of the day: a cheaper C admits more rows for the same room
      resetRevokeWriteBudget();
      noteRevokeCost(fx.db, Math.round(0.5 * frameBytes(fx.db)) * 1_000_000, 1_000_000);
      const cheap = revokeCostPerChange(fx.db);
      expect(cheap).toBeLessThan(C / 2);
      expect(revokeSliceNeed(fx.db)).toBe(Math.ceil(cheap * (64 + MARKER_STEP_RESERVE)));
      noteRevokeBytes(budget - revokeSliceNeed(fx.db));
      c0 = changes(fx);
      fx.db.exec("BEGIN IMMEDIATE"); budgetedMarkerSlice(fx.db, 1_000_000, 1_000_000); fx.db.exec("COMMIT");
      expect(changes(fx) - c0).toBeLessThanOrEqual(Math.floor(revokeSliceNeed(fx.db) / cheap));
    } finally { fx.close(); }
  });

  it("S5: an empty window admits the oldest flip with no exception, and a flip costing the whole minute at the ceiling commits in one slice", () => {
    const fx = storm(1);
    let now = 5_000_000;
    setRevokeBudgetClock(() => now);
    resetRevokeWriteBudget();
    try {
      const page = bytesPerChange(fx.db);
      REVOKE_WRITE_BUDGET.bytesPerMinute = 4000 * page;
      const minute = revokeMinuteChanges(fx.db);
      expect(minute).toBe(Math.floor((4000 * page) / revokeChangeCeiling(fx.db)));
      // the receipt cites as many items as a whole minute holds (an edge and an intern row each, with its own rows): it hangs on each item,
      // not the wildcard pair
      cite(fx, "b0", Math.floor((minute - 25) / 2));
      flipAll(fx);
      const head = headFlipCost(fx.db);
      expect(head).toBeGreaterThan(minute - 40);
      expect(head).toBeLessThanOrEqual(minute);
      // the window is full: the flip waits, at most a minute
      noteRevokeBytes(REVOKE_WRITE_BUDGET.bytesPerMinute);
      expect(revokeWriteWaitMs(revokeSliceNeed(fx.db))).toBeGreaterThan(0);
      expect(revokeWriteWaitMs(revokeSliceNeed(fx.db))).toBeLessThanOrEqual(REVOKE_WRITE_WINDOW_MS);
      fx.db.exec("BEGIN IMMEDIATE");
      expect(budgetedMarkerSlice(fx.db, 1_000_000, 1_000_000)).toBe("budget");
      fx.db.exec("COMMIT");
      expect(num(fx, "SELECT count(*) AS n FROM memory_receipt_flips")).toBe(1);
      // the window empties: the flip is admitted at once and commits whole in one slice
      now += REVOKE_WRITE_WINDOW_MS + 1;
      expect(revokeWriteWaitMs(revokeSliceNeed(fx.db))).toBe(0);
      const c0 = changes(fx);
      fx.db.exec("BEGIN IMMEDIATE");
      expect(budgetedMarkerSlice(fx.db, 1_000_000, 1_000_000)).toBe(true);
      fx.db.exec("COMMIT");
      expect(num(fx, "SELECT count(*) AS n FROM memory_receipt_flips")).toBe(0);
      expect(changes(fx) - c0).toBeLessThanOrEqual(minute);
      expect(revokeBytesWritten()).toBeLessThanOrEqual(REVOKE_WRITE_BUDGET.bytesPerMinute);
    } finally { fx.close(); }
  });
});

describe("S1: every charge is dated at its marker call and ages out in 60 s; nothing settles, re-dates, releases or infers", () => {
  it("an inline walk inside an owner transaction held open past the minute is charged rows x C at its call, in the ledger at 59 s and gone at 61 s; later calls, the commit, a checkpoint and an unrelated commit move nothing", windowsNightly(), () => {
    const fx = walStorm(400);
    // the handle as database.ts opens it: instrumented, and the budget watches none of it
    const release = instrumentDatabase(fx.db);
    let now = 3_000_000;
    setRevokeBudgetClock(() => now);
    resetRevokeWriteBudget();
    try {
      fx.db.exec("CREATE TABLE budget_probe(x INTEGER)");
      fx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const C = revokeCostPerChange(fx.db);
      const c0 = changes(fx);
      fx.db.exec("BEGIN IMMEDIATE");
      expect(budgetedMarkerSlice(fx.db, 64, 1_000_000)).toBe(true);
      const first = changes(fx) - c0;
      expect(first).toBeGreaterThan(0);
      const charged = Math.ceil(first * C);
      expect(revokeBytesWritten()).toBe(charged);
      // the transaction stays open: a marker call in it changes nothing of the charge, and the charge leaves the ledger at its minute
      now += 59_000;
      expect(revokeSliceNeed(fx.db)).toBeGreaterThan(0);
      expect(revokeBytesWritten()).toBe(charged);
      now += 2_000;
      expect(revokeBytesWritten()).toBe(0);
      expect(fx.db.isTransaction).toBe(true);
      // a second slice of the same open transaction is charged its own rows only, at the same C
      const c1 = changes(fx);
      expect(budgetedMarkerSlice(fx.db, 64, 1_000_000)).toBe(true);
      const second = changes(fx) - c1;
      expect(second).toBeGreaterThan(0);
      expect(revokeBytesWritten()).toBe(Math.ceil(second * C));
      // the owner commits, nobody measures: C and the ledger are as they were
      fx.db.exec("COMMIT");
      expect(revokeBytesWritten()).toBe(Math.ceil(second * C));
      expect(revokeWriteMeter.measured).toBe(0);
      expect(revokeCostPerChange(fx.db)).toBe(C);
      // a truncating checkpoint and an unrelated commit that restarts the log, then a marker call: nothing moves
      fx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      fx.db.prepare("INSERT INTO budget_probe VALUES(?)").run(1);
      now += 1_000;
      expect(revokeSliceNeed(fx.db)).toBeGreaterThan(0);
      expect(revokeBytesWritten()).toBe(Math.ceil(second * C));
      expect(revokeWriteMeter.measured).toBe(0);
      now += REVOKE_WRITE_WINDOW_MS;
      expect(revokeBytesWritten()).toBe(0);
      expect(revokeWriteMeter.slices).toBe(2);
      expect(revokeWriteMeter.charged).toBe(charged + Math.ceil(second * C));
    } finally { release(); fx.close(); }
  });

  it("a bounded drain whose slice rolls back is charged rows x C once, at its call; later marker calls neither re-date nor grow it, and the window has room a minute later", windowsNightly(), () => {
    const fx = walStorm(400);
    let now = 8_000_000;
    setRevokeBudgetClock(() => now);
    resetRevokeWriteBudget();
    try {
      // the slice enqueues rows, then one of its statements fails: the drain rolls its transaction back and reports the error
      fx.db.exec("CREATE TRIGGER budget_boom AFTER INSERT ON memory_revoke_frontier WHEN (SELECT count(*) FROM memory_revoke_frontier) > 40 BEGIN SELECT RAISE(ABORT, 'boom'); END");
      const C = revokeCostPerChange(fx.db), c0 = changes(fx);
      expect(() => drainRevokeMarkerBounded(fx.db, { rows: 1_000_000, ms: 1_000_000 })).toThrow(/boom/);
      expect(fx.db.isTransaction).toBe(false);
      const changed = changes(fx) - c0;
      expect(changed).toBeGreaterThan(0);
      expect(revokeWriteMeter.slices).toBe(1);
      const charged = revokeBytesWritten();
      expect(charged).toBe(Math.ceil(changed * C));
      expect(revokeWriteMeter.measured).toBe(0);
      now += REVOKE_WRITE_WINDOW_MS - 1_000;
      expect(revokeSliceNeed(fx.db)).toBeGreaterThan(0);
      expect(revokeBytesWritten()).toBe(charged);
      now += 1_001;
      expect(revokeBytesWritten()).toBe(0);
      expect(revokeWriteWaitMs(revokeSliceNeed(fx.db))).toBe(0);
      expect(revokeBytesWritten()).toBe(0);
    } finally { fx.close(); }
  });

  it("the owner's inline walk is charged the runner's estimate: rows x C, and after the runner measures a cheaper C the next walk is charged at that", windowsNightly(), () => {
    const fx = walStorm(400);
    let now = 9_000_000;
    setRevokeBudgetClock(() => now);
    resetRevokeWriteBudget();
    try {
      const W = revokeChangeCeiling(fx.db);
      // the first inline walk of the process: the seed
      let c0 = changes(fx);
      fx.db.exec("BEGIN IMMEDIATE"); expect(budgetedMarkerSlice(fx.db, 64, 1_000_000)).toBe(true); fx.db.exec("COMMIT");
      expect(revokeBytesWritten()).toBe(Math.ceil((changes(fx) - c0) * W));
      // the runner measures: its own commits on this file cost less than the ceiling
      now += REVOKE_WRITE_WINDOW_MS + 1;
      for (let n = 0; n < 20; n++) drainRevokeMarkerBounded(fx.db, { rows: 4096, ms: 1_000_000 });
      expect(revokeWriteMeter.measured).toBeGreaterThan(0);
      const C = revokeCostPerChange(fx.db);
      expect(C).toBeLessThan(W);
      // the next inline walk is charged at the measured C, and measures nothing itself
      now += REVOKE_WRITE_WINDOW_MS + 1;
      expect(revokeBytesWritten()).toBe(0);
      const measured = revokeWriteMeter.measured;
      c0 = changes(fx);
      fx.db.exec("BEGIN IMMEDIATE"); expect(budgetedMarkerSlice(fx.db, 64, 1_000_000)).toBe(true); fx.db.exec("COMMIT");
      const changed = changes(fx) - c0;
      expect(changed).toBeGreaterThan(0);
      expect(revokeBytesWritten()).toBe(Math.ceil(changed * C));
      expect(revokeWriteMeter.measured).toBe(measured);
      expect(revokeCostPerChange(fx.db)).toBe(C);
    } finally { fx.close(); }
  });
});

// Targeted settlement is not wired into the runner or owner paths. Exercise its contract on isolated files.

describe("targeted settlement admission", () => {
  type Target = { kind: "global" | "flips" | "flows" } | { kind: "only"; revokeId: number };
  const targets: Target[] = [{ kind: "global" }, { kind: "flips" }, { kind: "flows" }, { kind: "only", revokeId: 1 }];
  const saved = { ledger: budget.REVOKE_WRITE_BUDGET.bytesPerMinute, pace: budget.REVOKE_PACE.bytesPerMinute, rows: budget.REVOKE_PACE_COMMIT.rows };
  const fixtures: WritetimeFixture[] = [];
  let now = 1_000_000;
  const fresh = (receipts = 0) => { const fx = storm(receipts); fx.db.exec(SETTLE_ACTIVE_FLOW.sql); fx.db.exec(SETTLE_SEEDING_FOLD.sql); fixtures.push(fx); return fx; };
  const noFold = () => marker.setFoldHooks({ need: () => 0, pending: () => false, slice: () => null });
  function measured<T>(db: DatabaseSync, run: () => T, rollback = false): T {
    db.exec("BEGIN IMMEDIATE");
    const m = budget.beginRevokeMeasure(db);
    try {
      const result = run();
      db.exec(rollback ? "ROLLBACK" : "COMMIT");
      budget.endRevokeMeasure(db, m, !rollback, !rollback);
      return result;
    } catch (error) {
      if (db.isTransaction) { db.exec("ROLLBACK"); budget.endRevokeMeasure(db, m, false, false); }
      throw error;
    }
  }
  function admit(db: DatabaseSync, target: Target, rows = 64) {
    return budget.admitMarkerSlice(db, rows, 1000, null, target, "drain");
  }
  function content(fx: WritetimeFixture): number {
    fx.owner("own", "u", 2000).reply("own", "r", 2001);
    return commitRevoke(fx.db, { kind: "line", threadId: "own", messageIds: ["u"], cause: "forget" }, { inline: false });
  }
  beforeEach(() => {
    now = 1_000_000;
    // The legacy tests above lift the pace globally; targeted admission must exercise the real caps.
    budget.REVOKE_WRITE_BUDGET.bytesPerMinute = saved.ledger;
    budget.REVOKE_PACE.bytesPerMinute = saved.pace;
    budget.REVOKE_PACE_COMMIT.rows = saved.rows;
    budget.resetRevokeWriteBudget(); budget.setRevokeBudgetClock(() => now);
    budget.revokePaceTestHooks.osUnknown = true;
    noFold();
    marker.setFlipDrain(drainFlipsIntoBulk, db => {
      const row = db.prepare("SELECT bundle_id FROM memory_receipt_flips LIMIT 1").get();
      return row ? receiptCommitCost(db, String(row.bundle_id)) + 8 : 0;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const fx of fixtures.splice(0)) fx.close();
    budget.REVOKE_WRITE_BUDGET.bytesPerMinute = saved.ledger;
    budget.REVOKE_PACE.bytesPerMinute = saved.pace;
    budget.REVOKE_PACE_COMMIT.rows = saved.rows;
    budget.revokePaceTestHooks.osUnknown = false;
    budget.revokePaceTestHooks.unmeasurable = false;
    budget.resetRevokeWriteBudget(); budget.setRevokeBudgetClock();
  });

  describe("T4a: target wait and admission agree", () => {
    for (const target of targets) for (const state of ["too-small", "exact", "short", "expired", "pace"] as const) {
      it(`${target.kind}: ${state}`, () => {
        const { db } = fresh();
        const need = budget.revokeCostPerChange(db) * (marker.MARKER_STEP_RESERVE + 64);
        budget.REVOKE_WRITE_BUDGET.bytesPerMinute = state === "too-small" ? need - 1 : need;
        if (state === "short" || state === "expired") budget.noteRevokeBytes(1);
        if (state === "expired") now += 60_001;
        if (state === "pace") {
          budget.REVOKE_PACE.bytesPerMinute = 1;
          measured(db, () => db.exec("UPDATE memory_lsn SET next=next+1"));
          budget.REVOKE_WRITE_BUDGET.bytesPerMinute = saved.ledger;
        }
        const wait = budget.revokeSettleWaitMs(db, target);
        const result = measured(db, () => admit(db, target));
        expect(result.admitted).toBe(wait === 0);
        if (state === "too-small") expect(wait).toBe(Infinity);
        else if (state === "short" || state === "pace") {
          expect(wait).toBeGreaterThan(0);
          expect(result).toEqual({ admitted: false, refused: state === "pace" ? "pace" : "ledger" });
        } else expect(wait).toBe(0);
      });
    }
    it.each(["global", "flips"] as const)("%s escapes only a dominating oversized cost in an empty ledger", kind => {
      const { db } = fresh();
      marker.setFlipDrain(drainFlipsIntoBulk, () => 900);
      budget.REVOKE_WRITE_BUDGET.bytesPerMinute = budget.revokeCostPerChange(db) * 100;
      const target = { kind };
      expect(budget.revokeSettleWaitMs(db, target)).toBe(0);
      expect(measured(db, () => admit(db, target)).admitted).toBe(true);
      budget.noteRevokeBytes(1);
      expect(budget.revokeSettleWaitMs(db, target)).toBe(60_000);
      expect(measured(db, () => admit(db, target))).toEqual({ admitted: false, refused: "ledger" });
      now += 60_001;
      expect(budget.revokeSettleWaitMs(db, target)).toBe(0);
    });
    it("only global sizes admission and its escape with the fold cost", () => {
      const { db } = fresh();
      marker.setFoldHooks({ need: () => 900, pending: () => true, slice: () => "blocked" });
      expect(marker.headFlipCost(db)).toBe(900);
      expect(marker.receiptFlipCost(db)).toBe(0);
      budget.REVOKE_WRITE_BUDGET.bytesPerMinute = budget.revokeCostPerChange(db) * 100;
      for (const target of targets) {
        expect(budget.revokeSettleWaitMs(db, target)).toBe(target.kind === "global" ? 0 : Infinity);
        const result = measured(db, () => admit(db, target));
        expect(result.admitted).toBe(target.kind === "global");
        if (target.kind === "global") expect(result).toEqual({ admitted: true, outcome: "blocked", cause: "fold-room", changed: 0 });
      }
    });
    it("recomputes the wait clock after copy accounting", () => {
      const { db } = fresh();
      const need = budget.revokeCostPerChange(db) * 576;
      budget.REVOKE_WRITE_BUDGET.bytesPerMinute = need;
      budget.noteRevokeBytes(1);
      const prepare = db.prepare.bind(db);
      vi.spyOn(db, "prepare").mockImplementation((...args) => { now = 1_060_001; return prepare(...args); });
      expect(budget.revokeSettleWaitMs(db, { kind: "only", revokeId: 1 })).toBe(0);
    });
  });

  describe("T4a: assertions, detailed branches and wrapper compatibility", () => {
    it("requires the measured transaction on the same handle, and enforces every policy pair", () => {
      const a = fresh().db, b = fresh().db;
      for (const target of targets) expect(() => admit(a, target)).toThrow();
      a.exec("BEGIN");
      for (const target of targets) expect(() => admit(a, target)).toThrow();
      for (const target of targets.filter(t => t.kind !== "only")) {
        expect(() => budget.admitMarkerSlice(a, 64, 1000, null, target, "inline")).toThrow();
      }
      expect(budget.admitMarkerSlice(a, 64, 1000, null, { kind: "only", revokeId: 1 }, "inline").admitted).toBe(true);
      const m = budget.beginRevokeMeasure(a);
      expect(() => budget.admitMarkerSlice(a, 64, 1000, null, { kind: "unknown" } as never, "drain")).toThrow();
      expect(() => budget.admitMarkerSlice(a, 64, 1000, null, { kind: "flows" }, "unknown" as never)).toThrow();
      expect(() => budget.admitMarkerSlice(a, 64, 1000, null, { kind: "only", revokeId: 1 }, "inline")).toThrow();
      b.exec("BEGIN");
      expect(() => admit(b, { kind: "flows" })).toThrow();
      expect(budget.admitMarkerSlice(b, 64, 1000, null, { kind: "only", revokeId: 1 }, "inline").admitted).toBe(true);
      b.exec("ROLLBACK"); a.exec("COMMIT"); budget.endRevokeMeasure(a, m);
      a.exec("BEGIN");
      expect(() => admit(a, { kind: "flows" })).toThrow();
      expect(budget.admitMarkerSlice(a, 64, 1000, null, { kind: "only", revokeId: 1 }, "inline").admitted).toBe(true);
      a.exec("ROLLBACK");
    });
    it("measurement initialization failure publishes no ownership, and a throwing finalizer clears it", () => {
      const { db } = fresh();
      db.exec("BEGIN");
      const changes = vi.spyOn(marker, "totalChanges").mockImplementationOnce(() => { throw new Error("measurement input"); });
      expect(() => budget.beginRevokeMeasure(db)).toThrow("measurement input");
      expect(budget.admitMarkerSlice(db, 64, 1000, null, { kind: "only", revokeId: 1 }, "inline").admitted).toBe(true);
      const m = budget.beginRevokeMeasure(db);
      db.exec("COMMIT");
      changes.mockImplementationOnce(() => { throw new Error("finalizer input"); });
      expect(() => budget.endRevokeMeasure(db, m)).toThrow("finalizer input");
      db.exec("BEGIN");
      expect(() => admit(db, { kind: "flows" })).toThrow();
      expect(budget.admitMarkerSlice(db, 64, 1000, null, { kind: "only", revokeId: 1 }, "inline").admitted).toBe(true);
      db.exec("ROLLBACK");
    });
    it("admission accounting consumes the slice allowance before marker execution", () => {
      const { db } = fresh();
      let tick = 0;
      vi.spyOn(performance, "now").mockImplementation(() => tick);
      const pending = vi.fn(() => { tick = 100; return 0; });
      marker.setFlipDrain(drainFlipsIntoBulk, pending);
      const run = vi.spyOn(marker, "markerSliceDetailed");
      const result = measured(db, () => budget.admitMarkerSlice(db, 64, 50, null, { kind: "flips" }, "drain"));
      expect(pending).toHaveBeenCalled();
      expect(result).toEqual({ admitted: true, outcome: "idle", changed: 0 });
      expect(run).not.toHaveBeenCalled();
    });
    it("legacy only with a queued flip remains false and uncharged", () => {
      const fx = fresh(1); flipAll(fx);
      fx.db.exec("BEGIN");
      expect(budget.budgetedMarkerSlice(fx.db, 64, 1000, null, { only: 1 })).toBe(false);
      fx.db.exec("ROLLBACK");
      expect(budget.revokeBytesWritten()).toBe(0);
      expect(budget.revokeWriteMeter.slices).toBe(0);
    });
    it("rejects mutually exclusive marker options before writes", () => {
      const { db } = fresh();
      for (const opts of [{ only: 1, flipsOnly: true as const }, { only: 1, flowsOnly: true as const }, { flipsOnly: true as const, flowsOnly: true as const }]) {
        const before = marker.totalChanges(db);
        expect(() => marker.markerSliceDetailed(db, 64, 1000, null, 1000, opts)).toThrow();
        expect(() => marker.markerSlice(db, 64, 1000, null, 1000, opts)).toThrow();
        expect(marker.totalChanges(db)).toBe(before);
      }
    });
    it("flips only never folds or walks; only and flows name the queued-flip block", () => {
      const fx = fresh(2); const id = content(fx); flipAll(fx);
      const fold = vi.fn(() => { throw new Error("must not fold"); });
      marker.setFoldHooks({ need: () => 1_000_000, pending: () => true, slice: fold });
      for (const target of [{ kind: "only", revokeId: id }, { kind: "flows" }] as Target[]) {
        expect(measured(fx.db, () => admit(fx.db, target))).toEqual({ admitted: true, outcome: "blocked", cause: "flip-queued", changed: 0 });
      }
      expect(marker.markerSlice(fx.db, 64, 1000, null, 1000, { only: id })).toBe(false);
      expect(marker.markerSliceDetailed(fx.db, 64, 1000, null, -512, { flipsOnly: true })).toEqual({ outcome: "blocked", cause: "flip-room" });
      const result = measured(fx.db, () => admit(fx.db, { kind: "flips" }));
      expect(result).toMatchObject({ admitted: true, outcome: "progress" });
      expect(fx.db.prepare("SELECT phase FROM memory_revoke_jobs WHERE revoke_id=?").get(id)?.phase).toBe("flow");
      expect(marker.markerSliceDetailed(fx.db, 64, 1000, null, 1000, { flipsOnly: true })).toEqual({ outcome: "idle" });
      // The targeted path reads the indexed database state, independently of the legacy fold hook.
      fx.job(id + 1, 3000, "seeding");
      fx.db.prepare("UPDATE memory_revoke_jobs SET kind='bulk',root=? WHERE revoke_id=?").run('{"kind":"bulk","cause":"fold"}', id + 1);
      expect(marker.markerSliceDetailed(fx.db, 64, 1000, null, 1000, { flowsOnly: true })).toEqual({ outcome: "blocked", cause: "fold-seeding" });
      expect(fold).not.toHaveBeenCalled();
    });
    it("flows only narrows without marking, and never calls the fold slice", () => {
      const fx = fresh(); const id = content(fx);
      const fold = vi.fn(() => null);
      marker.setFoldHooks({ need: () => 0, pending: () => false, slice: fold });
      expect(marker.markerSliceDetailed(fx.db, 4096, 1000, null, 10_000, { flowsOnly: true })).toEqual({ outcome: "progress" });
      expect(fx.db.prepare("SELECT phase FROM memory_revoke_jobs WHERE revoke_id=?").get(id)?.phase).toBe("mark");
      expect(marker.markerSliceDetailed(fx.db, 4096, 1000, null, 10_000, { flowsOnly: true })).toEqual({ outcome: "idle" });
      expect(fold).not.toHaveBeenCalled();
    });
    it("an idle saved cursor is charged but is not progress", () => {
      const fx = fresh(); const id = content(fx);
      fx.db.prepare("UPDATE memory_revoke_jobs SET phase='hold' WHERE revoke_id=?").run(id);
      fx.db.prepare("INSERT INTO memory_revoke_reached VALUES(?, 'hold:waiting', 0)").run(id);
      fx.db.exec("INSERT INTO memory_scope_bindings(id,scope_id,subject_type,subject_id,revision,state,intent) VALUES('memory-revocation:waiting','s-room','system','memory-revocation',0,'granted','{}')");
      const result = measured(fx.db, () => admit(fx.db, { kind: "only", revokeId: id }));
      expect(result).toMatchObject({ admitted: true, outcome: "idle" });
      expect(result.admitted && result.changed).toBeGreaterThan(0);
      expect(budget.revokeBytesWritten()).toBeGreaterThan(0);
    });
    it("drain row caps exclude unrelated fold costs and count prior transaction rows", () => {
      const { db } = fresh();
      marker.setFoldHooks({ need: () => 100_000, pending: () => false, slice: () => null });
      const run = vi.spyOn(marker, "markerSliceDetailed");
      measured(db, () => {
        db.exec("UPDATE memory_lsn SET next=next+1");
        admit(db, { kind: "only", revokeId: 1 });
        expect(run.mock.calls.at(-1)?.[4]).toBe(budget.REVOKE_PACE_COMMIT.rows - 1);
      });
    });
    it.each(["idle", "progress", "blocked", "throw"] as const)("legacy wrapper preserves %s and finally charges", mode => {
      const { db } = fresh(); const error = new Error("fold failure");
      marker.setFoldHooks({ need: () => 0, pending: () => false, slice: handle => {
        if (mode !== "idle") handle.exec("UPDATE memory_lsn SET next=next+1");
        if (mode === "throw") throw error;
        return mode === "blocked" ? "blocked" : mode === "progress";
      } });
      const c = budget.revokeCostPerChange(db);
      db.exec("BEGIN");
      if (mode === "throw") expect(() => budget.budgetedMarkerSlice(db, 64, 1000)).toThrow(error);
      else expect(budget.budgetedMarkerSlice(db, 64, 1000)).toBe(mode === "blocked" ? "budget" : mode === "progress");
      db.exec("ROLLBACK");
      expect(budget.revokeBytesWritten()).toBe(mode === "idle" ? 0 : c);
    });
  });

  describe("T9a: settle and runner accounting share ledger, pace and copies", () => {
    it("interleaves runner and settle commits; ledger admission and measured pace refuse independently", () => {
      const fx = fresh(3); flipAll(fx);
      const c = budget.revokeCostPerChange(fx.db);
      let changed = 0;
      measured(fx.db, () => {
        const before = marker.totalChanges(fx.db);
        expect(budget.budgetedMarkerSlice(fx.db, 64, 1000)).toBe(true);
        changed = marker.totalChanges(fx.db) - before;
      });
      expect(budget.revokeBytesWritten()).toBe(changed * c);
      expect(budget.revokePacedBytes()).toBe(changed * budget.revokeChangeCeiling(fx.db) * 2);
      budget.REVOKE_PACE.bytesPerMinute = 1;
      expect(measured(fx.db, () => admit(fx.db, { kind: "flows" }))).toEqual({ admitted: false, refused: "pace" });
      budget.REVOKE_PACE.bytesPerMinute = 1e9;
      budget.noteRevokeBytes(saved.ledger);
      expect(measured(fx.db, () => admit(fx.db, { kind: "flows" }))).toEqual({ admitted: false, refused: "ledger" });
      now += 60_001;
      expect(budget.revokeSettleWaitMs(fx.db, { kind: "flows" })).toBe(0);
      expect(measured(fx.db, () => admit(fx.db, { kind: "flows" }))).toMatchObject({ admitted: true, outcome: "progress" });
      expect(budget.revokePacedBytes()).toBeGreaterThan(0);
      expect(budget.revokeBytesWritten()).toBeGreaterThan(0);
      now += 60_001;
      expect(measured(fx.db, () => budget.budgetedMarkerSlice(fx.db, 64, 1000))).toBe(true);
    });
    it("a throwing admitted marker charges every changed row through rollback", () => {
      const { db } = fresh(); const error = new Error("marker failure");
      marker.setFoldHooks({ need: () => 0, pending: () => false, slice: handle => {
        handle.exec("UPDATE memory_lsn SET next=next+1");
        throw error;
      } });
      const c = budget.revokeCostPerChange(db);
      expect(() => measured(db, () => admit(db, { kind: "global" }))).toThrow(error);
      expect(db.isTransaction).toBe(false);
      expect(budget.revokeBytesWritten()).toBe(c);
      expect(budget.revokePacedBytes()).toBe(c * 2);
      expect(budget.revokeWriteMeter.slices).toBe(1);
    });
    it("rollback keeps the settle slice's charge, dated at finalization", () => {
      const fx = fresh(); const id = content(fx); const c = budget.revokeCostPerChange(fx.db);
      const before = marker.totalChanges(fx.db);
      measured(fx.db, () => {
        expect(admit(fx.db, { kind: "only", revokeId: id })).toMatchObject({ admitted: true, outcome: "progress" });
        now += 61_000;
        expect(budget.revokeBytesWritten()).toBeGreaterThan(0);
      }, true);
      const changed = marker.totalChanges(fx.db) - before;
      expect(changed).toBeGreaterThan(0);
      expect(budget.revokeBytesWritten()).toBe(changed * c);
      expect(budget.revokePacedBytes()).toBe(changed * c * 2);
      expect(fx.db.prepare("SELECT phase FROM memory_revoke_jobs WHERE revoke_id=?").get(id)?.phase).toBe("flow");
      now += 60_001;
      expect(budget.revokeBytesWritten()).toBe(0);
    });
    it("a refused admission charges no marker rows; finalization still charges measured transaction bytes", () => {
      const { db } = fresh();
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE probe(x BLOB)");
      budget.revokePaceTestHooks.osUnknown = false;
      budget.REVOKE_WRITE_BUDGET.bytesPerMinute = 1;
      measured(db, () => {
        db.exec("INSERT INTO probe VALUES(zeroblob(100000))");
        expect(admit(db, { kind: "only", revokeId: 1 })).toEqual({ admitted: false, refused: "ledger" });
        expect(budget.revokeWriteMeter.slices).toBe(0);
        expect(budget.revokeBytesWritten()).toBe(0);
      });
      expect(budget.revokeWriteMeter.slices).toBe(0);
      expect(budget.revokeBytesWritten()).toBe(budget.revokeWriteMeter.osBeyond);
      expect(budget.revokeWriteMeter.osBeyond).toBeGreaterThan(0);
      expect(budget.revokePacedBytes()).toBeGreaterThan(0);
    });
    it("a pinned copy blocks all drain targets; release is measured by the next wait", () => {
      const fx = fresh(10); flipAll(fx);
      fx.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0");
      const file = String(fx.db.prepare("PRAGMA database_list").get()!.file);
      const reader = new DatabaseSync(file);
      try {
        reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM memory_revoke_jobs").get();
        measured(fx.db, () => expect(admit(fx.db, { kind: "flips" })).toMatchObject({ admitted: true, outcome: "progress" }));
        const held = budget.revokeOutstandingCopyBytes();
        expect(held).toBeGreaterThan(0);
        budget.REVOKE_PACE.bytesPerMinute = 1;
        for (const target of targets) {
          expect(budget.revokeSettleWaitMs(fx.db, target)).toBeGreaterThan(0);
          expect(measured(fx.db, () => admit(fx.db, target))).toEqual({ admitted: false, refused: "pace" });
        }
        reader.exec("COMMIT");
        budget.revokeSettleWaitMs(fx.db, { kind: "flows" });
        expect(budget.revokeOutstandingCopyBytes()).toBe(0);
        expect(budget.revokeWriteMeter.copiesSettled).toBeGreaterThanOrEqual(held);
        expect(budget.revokePacedBytes()).toBeGreaterThanOrEqual(held);
      } finally { reader.close(); }
    });
  });
});
