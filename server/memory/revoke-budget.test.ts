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
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryRevocationIdle, memoryRevocationStats, resetMemoryRevocationStats, drainRevokeMarkerBounded, stopMemoryRevocation, wakeMemoryRevocation } from "./memory-revocation.ts";
import { beginRevokeMeasure, budgetedMarkerSlice, bytesPerChange, endRevokeMeasure, frameBytes, noteRevokeBytes, noteRevokeCost, REVOKE_COST_MEMORY_ROWS, REVOKE_WRITE_BUDGET, REVOKE_WRITE_WINDOW_MS, resetRevokeWriteBudget, revokeBytesWritten, revokeChangeCeiling, revokeCostPerChange, revokeMinuteChanges, revokeSliceNeed, revokeWriteMeter, revokeWriteWaitMs, setRevokeBudgetClock } from "./revoke-budget.ts";
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
      let c0 = changes(fx), w0 = walSize(fx);
      drainRevokeMarkerBounded(fx.db, { rows: 64, ms: 1_000_000 });
      const rows1 = changes(fx) - c0, bytes1 = walSize(fx) - w0;
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
      const rows2 = changes(fx) - c0, bytes2 = walSize(fx) - w0;
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

  it("a file with no index (no WAL) measures nothing and keeps the seed: the drain is charged the ceiling a row", () => {
    const fx = storm(8);
    setRevokeBudgetClock(() => 1_000_000);
    resetRevokeWriteBudget();
    try {
      flipAll(fx);
      const c0 = changes(fx);
      while (drainRevokeMarkerBounded(fx.db, { rows: 1_000_000, ms: 1_000_000 })) { /* drains */ }
      const changed = changes(fx) - c0;
      expect(changed).toBeGreaterThan(0);
      expect(revokeWriteMeter.measured).toBe(0);
      expect(revokeWriteMeter.slices).toBeGreaterThan(0);
      expect(revokeCostPerChange(fx.db)).toBe(revokeChangeCeiling(fx.db));
      expect(revokeBytesWritten()).toBe(changed * revokeChangeCeiling(fx.db));
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
      const bytes = endRevokeMeasure(fx.db, m);
      expect(bytes).toBe(walSize(fx));
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
      expect(endRevokeMeasure(fx.db, m)).toBe(walSize(fx));
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
