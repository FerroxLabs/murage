// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// IO-IDLE-DRAIN-1018 r3.6 (MurageMain rulings 2026-11-07/08): the revoke drain is paced on what its own commits MEASURED (revoke-budget.ts
// REVOKE_PACE): nothing is estimated or learned. A drain transaction is capped at REVOKE_PACE_COMMIT.rows (plus the marker's step reserve),
// is admitted only into an empty pace or with room for the previous commit's measured bytes, and is charged its measured write and copy at
// its COMMIT. Each rule has a test here by name; the real-file legs (M1-M3) stay in io-budget-revoke-pace.test.ts. Also the macOS OS write
// floor (os-disk-written.ts) and the watchdog's unknown minute.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BLOCK_BYTES, IO_BUDGET_IDLE_BYTES_PER_MINUTE, IoBudget, type IoReading, readProcess, walFrameReader } from "./io-budget.ts";
import { darwinWrittenBytes, resetDarwinWrittenForTest } from "./os-disk-written.ts";
import { drainRevokeMarkerBounded, lateBuildStep, stopMemoryRevocation } from "./memory/memory-revocation.ts";
import * as revokeBudget from "./memory/revoke-budget.ts";
import { beginRevokeMeasure, budgetedMarkerSlice, endRevokeMeasure, resetRevokeWriteBudget, setRevokeBudgetClock, walIndexMark } from "./memory/revoke-budget.ts";
import { receiptCommitCost } from "./memory/revoke-commit.ts";
import { MARKER_STEP_RESERVE, totalChanges } from "./memory/revoke-marker.ts";
import { flipAll, storm } from "./memory/testing/revoke-storm-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const MINUTE = 60_000, MB = 1048576;
const meter = (key: string) => Number((revokeBudget.revokeWriteMeter as unknown as Record<string, number>)[key] ?? 0);
const PACE0 = revokeBudget.REVOKE_PACE.bytesPerMinute, ROWS0 = revokeBudget.REVOKE_PACE_COMMIT.rows;
const dbFile = (db: DatabaseSync) => (db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(r => r.name === "main")!.file;
/** Everything one drain commit put into the pace: its write and copy halves (read or, unreadable, at W). */
const committed = () => meter("paceMeasured") + meter("paceUnmeasured");

afterEach(() => {
  revokeBudget.REVOKE_PACE.bytesPerMinute = PACE0; revokeBudget.REVOKE_PACE_COMMIT.rows = ROWS0;
  revokeBudget.revokePaceTestHooks.unmeasurable = false; revokeBudget.revokePaceTestHooks.osUnknown = false; revokeBudget.revokePaceTestHooks.inResetWindow = null; revokeBudget.revokePaceTestHooks.beforeResetGuard = null;
  revokeBudget.revokePaceTestHooks.resetCounter = null; revokeBudget.revokePaceTestHooks.dataVersion = null; revokeBudget.revokePaceTestHooks.platform = null;
  setRevokeBudgetClock(); resetRevokeWriteBudget(); stopMemoryRevocation(); resetDarwinWrittenForTest();
});

/** A WAL storm on a fake clock with the checkpointer off (the test passes it by hand). */
function walStorm(receipts: number) {
  const fx = storm(receipts);
  fx.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0");
  return fx;
}

/** A storm drained one io-budget sample a minute (fake clock), judged by the watchdog wired as production wires it. In minute `misAt` the
 *  previous commit is forced to read 0 bytes once the pace refuses (the worst one misestimate: a commit admitted with no room for it).
 *  `pin`: a reader takes a snapshot just before that commit and holds it until the next minute, so the checkpoint copies the minute's
 *  earlier frames and the misestimated commit's frames only a minute later (the copy split across two minutes). */
function paceMinutes(opts: { receipts: number; minutes: number; misAt: number; pin: boolean }) {
  const fx = walStorm(opts.receipts);
  const file = dbFile(fx.db);
  const worker = new DatabaseSync(file), reader = new DatabaseSync(file);
  try {
    let now = 1_000_000;
    setRevokeBudgetClock(() => now); resetRevokeWriteBudget();
    flipAll(fx);
    worker.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
    const wal = walFrameReader(file);
    let reading: IoReading = { at: 0, fsWriteBlocks: 0, cpuMicros: 0 };
    const budget = new IoBudget({ read: () => reading, log: () => {}, onScale: () => {}, isIdle: () => true, systemOverloaded: () => null });
    budget.registerByteSource("database:messages.db", wal);
    budget.tick();
    const counted: number[] = [], dated: number[] = [];
    let worst = 0, worstRows = 0, misPut = -1, misK = -1, pinned = false, pending = true, heldAtMis = -1;
    for (let k = 1; k <= opts.minutes && pending; k++) {
      if (pinned) { reader.exec("COMMIT"); pinned = false; } // released in the next minute: the rest of the copy happens here
      const os0 = readProcess().fsWriteBlocks, d0 = meter("paceDated");
      let forced = false;
      for (let n = 0; n < 2000; n++) {
        const c0 = committed(), r0 = totalChanges(fx.db), paced0 = revokeBudget.revokePacedBytes(now);
        pending = drainRevokeMarkerBounded(fx.db, { rows: 256, ms: 1_000_000 }); // one commit
        const put = committed() - c0, rows = totalChanges(fx.db) - r0;
        if (rows > 0) {
          worst = Math.max(worst, put); worstRows = Math.max(worstRows, rows);
          expect(revokeBudget.revokePacedBytes(now)).toBeGreaterThanOrEqual(paced0 + put - 1); // charged at once
          if (forced && misPut < 0) misPut = put;
        }
        if (!pending) break;
        if (revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db), now) > 0) {
          // from minute misAt, the first refusal that is the PACE's alone (the rows x C ledger has room) with the pace not over, so a commit
          // is admitted that had no room in the pace
          const ledgerWait = revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db), now, 0);
          if (k < opts.misAt || forced || misK > 0 || ledgerWait > 0 || revokeBudget.revokePacedBytes(now) > revokeBudget.REVOKE_PACE.bytesPerMinute) break;
          forced = true; misK = k;
          if (opts.pin) { reader.exec("BEGIN"); reader.prepare("SELECT count(*) AS n FROM sqlite_master").get(); pinned = true; }
          revokeBudget.setRevokeLastCommitForTest(0);
        }
      }
      if (k === misK) heldAtMis = revokeBudget.revokeOutstandingCopyBytes();
      worker.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
      reading = { at: k * MINUTE, fsWriteBlocks: reading.fsWriteBlocks + Math.max(0, readProcess().fsWriteBlocks - os0), cpuMicros: 0 };
      counted.push(budget.tick()!.writeBytesPerMinute);
      dated.push(meter("paceDated") - d0);
      now += MINUTE + 1;
    }
    if (pinned) reader.exec("COMMIT");
    return { counted, dated, heldAtMis, worst, worstRows, misPut, misK, W: revokeBudget.revokeChangeCeiling(fx.db), frame: revokeBudget.frameBytes(fx.db) };
  } finally { reader.close(); worker.close(); fx.close(); }
}
/** R1 exactly (MurageMain): the most one minute is over the pace, (cap + step reserve) x 2W. */
const r1Max = (W: number) => (revokeBudget.REVOKE_PACE_COMMIT.rows + MARKER_STEP_RESERVE) * 2 * W;
/** Frames in the log and a reader's snapshot on them, taken before the drain's next commit: the drain's own copy cannot pass it. */
function pin(fx: ReturnType<typeof walStorm>, reader: DatabaseSync): void {
  fx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  fx.db.exec("CREATE TABLE IF NOT EXISTS iod36_pin(x); INSERT INTO iod36_pin VALUES (1)");
  reader.exec("BEGIN"); reader.prepare("SELECT count(*) AS n FROM sqlite_master").get();
}

describe.skipIf(process.platform === "win32")("r3.6: the pace on measured commits", { timeout: 900_000 }, () => {
  it("cap: every drain transaction changes at most cap + step reserve rows, is charged its measured write and copy at its COMMIT, and the next admission needs room for exactly that", () => {
    const fx = walStorm(1000);
    try {
      let now = 1_000_000;
      setRevokeBudgetClock(() => now); resetRevokeWriteBudget();
      flipAll(fx);
      let commits = 0;
      for (let n = 0; n < 400; n++) {
        const c0 = committed(), r0 = totalChanges(fx.db), paced0 = revokeBudget.revokePacedBytes(now);
        const pending = drainRevokeMarkerBounded(fx.db, { rows: 256, ms: 1_000_000 });
        const put = committed() - c0, rows = totalChanges(fx.db) - r0;
        if (rows > 0) {
          commits++;
          expect(rows).toBeLessThanOrEqual(revokeBudget.REVOKE_PACE_COMMIT.rows + MARKER_STEP_RESERVE);
          expect(revokeBudget.revokePacedBytes(now)).toBeGreaterThanOrEqual(paced0 + put - 1);
          expect(revokeBudget.revokePaceNeed(fx.db)).toBe(Math.min(put, revokeBudget.REVOKE_PACE.bytesPerMinute));
        }
        if (!pending) break;
        if (revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db), now) > 0) now += MINUTE + 1;
      }
      expect(commits).toBeGreaterThan(3);
    } finally { fx.close(); }
  });

  it("(i) one misestimate costs at most one minute over the idle budget, by at most one commit of (cap + step reserve) x 2W", () => {
    const { counted, dated, worst, worstRows, misPut, misK, W } = paceMinutes({ receipts: 5000, minutes: 6, misAt: 2, pin: false });
    const PACE = revokeBudget.REVOKE_PACE.bytesPerMinute, R1 = r1Max(W);
    const over = counted.filter(c => c > IO_BUDGET_IDLE_BYTES_PER_MINUTE).length, paceOver = dated.filter(d => d > PACE).length;
    console.log(`IODRAIN MIS pace=${PACE} r1=${R1} limit=${PACE + R1} dated=${dated.join(",")} counted=${counted.map(c => (c / MB).toFixed(2)).join(",")} misMinute=${misK} misCommit=${(misPut / MB).toFixed(3)}MB worst=${(worst / MB).toFixed(3)}MB rows=${worstRows} over=${over} paceOver=${paceOver}`);
    expect(misPut).toBeGreaterThan(0); // the misestimated commit ran
    expect(worstRows).toBeLessThanOrEqual(revokeBudget.REVOKE_PACE_COMMIT.rows + MARKER_STEP_RESERVE);
    expect(worst).toBeLessThanOrEqual(R1);
    for (const [i, d] of dated.entries()) {
      expect(d).toBeLessThanOrEqual(PACE + R1); // the exact bound: 0.8 MB + (cap + reserve) x 2W
      // R1: a commit that costs more than the one before it may put its minute over the pace; outside the misestimated minute that is an
      // ordinary commit, over by at most its own measured bytes
      if (d > PACE && i !== misK - 1) expect(d - PACE).toBeLessThanOrEqual(worst);
    }
    for (const c of counted) expect(c).toBeLessThanOrEqual(IO_BUDGET_IDLE_BYTES_PER_MINUTE + R1); // the watchdog's count, the same bound
    expect(over).toBeLessThanOrEqual(1);
  });

  it("R1 split copy: a reader pinned across the misestimated commit splits its copy into the next minute; at most its write minute and its copy minute are over, each by at most one commit", () => {
    const { counted, dated, heldAtMis, worst, misPut, misK, W } = paceMinutes({ receipts: 5000, minutes: 6, misAt: 2, pin: true });
    const PACE = revokeBudget.REVOKE_PACE.bytesPerMinute, R1 = r1Max(W);
    const over = counted.filter(c => c > IO_BUDGET_IDLE_BYTES_PER_MINUTE).length;
    console.log(`IODRAIN SPLIT pace=${PACE} r1=${R1} limit=${PACE + R1} dated=${dated.join(",")} counted=${counted.map(c => (c / MB).toFixed(2)).join(",")} misMinute=${misK} misCommit=${(misPut / MB).toFixed(3)}MB heldAtMis=${heldAtMis} settled=${meter("copiesSettled")} lapsed=${meter("copiesLapsed")} over=${over}`);
    expect(misPut).toBeGreaterThan(0);
    expect(heldAtMis).toBeGreaterThan(0); // the pinned copy is RETAINED as debt through its write minute
    expect(meter("copiesLapsed")).toBe(0); // and SETTLED by a proven copy in the next minute, never by the bound
    expect(revokeBudget.revokeOutstandingCopyBytes()).toBe(0);
    expect(over).toBeLessThanOrEqual(2);
    for (const [i, d] of dated.entries()) {
      expect(d).toBeLessThanOrEqual(PACE + R1); // the exact bound: 0.8 MB + (cap + reserve) x 2W
      // over the pace by more than one ordinary commit: only its write minute and its copy minute (0-based)
      if (d > PACE && ![misK - 1, misK].includes(i)) expect(d - PACE).toBeLessThanOrEqual(worst);
    }
    for (const [i, c] of counted.entries()) if (c > IO_BUDGET_IDLE_BYTES_PER_MINUTE) expect([misK - 1, misK]).toContain(i);
  });

  it("(ii) a reading that cannot be taken charges W: both halves at rows x W", () => {
    const fx = walStorm(500);
    try {
      let now = 1_000_000;
      setRevokeBudgetClock(() => now); resetRevokeWriteBudget();
      flipAll(fx);
      const W = revokeBudget.revokeChangeCeiling(fx.db);
      revokeBudget.revokePaceTestHooks.unmeasurable = true;
      const r0 = totalChanges(fx.db), u0 = meter("paceUnmeasured");
      drainRevokeMarkerBounded(fx.db, { rows: 256, ms: 1_000_000 });
      const rows = totalChanges(fx.db) - r0;
      expect(rows).toBeGreaterThan(0);
      expect(meter("paceUnmeasured") - u0).toBe(2 * Math.ceil(rows * W));
      expect(revokeBudget.revokePacedBytes(now)).toBeGreaterThanOrEqual(2 * rows * W);
    } finally { fx.close(); }
  });

  it("H1: a commit costlier than the pace's minute runs alone in an empty pace, and the wait never spins", () => {
    const fx = walStorm(400);
    try {
      let now = 1_000_000;
      setRevokeBudgetClock(() => now); resetRevokeWriteBudget();
      flipAll(fx);
      revokeBudget.REVOKE_PACE.bytesPerMinute = 10 * revokeBudget.frameBytes(fx.db); // under any one commit
      const s0 = meter("slices");
      drainRevokeMarkerBounded(fx.db, { rows: 256, ms: 1_000_000 });
      expect(meter("slices") - s0).toBe(1);
      for (let n = 0; n < 50; n++) {
        // what the runner does: wait, then retry. At the same instant admission refuses and the wait is never 0 (no 1 ms spin)
        expect(revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db), now)).toBeGreaterThanOrEqual(1);
        drainRevokeMarkerBounded(fx.db, { rows: 256, ms: 1_000_000 });
        expect(meter("slices") - s0).toBe(1);
        now += 500;
      }
      now += MINUTE + 1;
      expect(revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db), now)).toBe(0);
      drainRevokeMarkerBounded(fx.db, { rows: 256, ms: 1_000_000 });
      expect(meter("slices") - s0).toBe(2);
    } finally { fx.close(); }
  });

  it("H4: a job step or late build takes the transaction's rows left under the cap, is charged rows x C at once, and waits when the pace does not admit", () => {
    const fx = walStorm(100);
    try {
      let now = 1_000_000;
      setRevokeBudgetClock(() => now); resetRevokeWriteBudget();
      const C = revokeBudget.revokeCostPerChange(fx.db), cap = revokeBudget.REVOKE_PACE_COMMIT.rows;
      expect(revokeBudget.revokePaceRows(fx.db, now)).toBe(cap);
      fx.db.exec("BEGIN IMMEDIATE");
      const measure = beginRevokeMeasure(fx.db);
      fx.db.exec("CREATE TABLE iod36_h4(x)");
      fx.db.prepare("INSERT INTO iod36_h4 WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 300) SELECT x FROM c").run();
      expect(revokeBudget.revokePaceRows(fx.db, now)).toBe(cap - 300); // the whole transaction counts
      revokeBudget.chargeRevokeRows(fx.db, 300);
      expect(revokeBudget.revokeBytesWritten(now)).toBe(Math.ceil(300 * C));
      fx.db.exec("COMMIT");
      endRevokeMeasure(fx.db, measure, false);
      expect(revokeBudget.revokePacedBytes(now)).toBeGreaterThan(0); // measured into the pace at the COMMIT
      revokeBudget.REVOKE_PACE.bytesPerMinute = revokeBudget.revokePacedBytes(now); // full
      expect(revokeBudget.revokePaceRows(fx.db, now)).toBe(0); // a job step waits like a slice
      expect(revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db), now)).toBeGreaterThan(0);
      now += MINUTE + 1;
      expect(revokeBudget.revokePaceRows(fx.db, now)).toBe(cap);
    } finally { fx.close(); }
  });

  it("H4 wiring: the runner's job-step and late-build branch is capped by revokePaceRows and charged by chargeRevokeRows", async () => {
    const source = (await import("node:fs")).readFileSync(new URL("./memory/memory-revocation.ts", import.meta.url), "utf8");
    const tick = source.slice(source.indexOf("const cap = revokePaceRows(db);"), source.indexOf("memoryRevocationStats.maxWorkMs = Math.max"));
    expect(tick).toContain("stepJobRow(db, row, Math.min(rowsPerSlice, cap), budget)");
    expect(tick).toContain("lateBuildStep(db, Math.min(rowsPerSlice, cap))");
    expect(tick).toContain("finally { chargeRevokeRows(db, totalChanges(db) - before); }");
    expect(tick).toContain("if (cap === 0) { budgetWait = true; more = true; }");
  });

  it("R2 huge origins: one late-build input row whose origins array fans out past the cap is charged at once at its COMMIT, and the next step waits", () => {
    const fx = walStorm(10);
    try {
      let now = 1_000_000;
      setRevokeBudgetClock(() => now); resetRevokeWriteBudget();
      const W = revokeBudget.revokeChangeCeiling(fx.db), fan = 40000;
      fx.db.exec("PRAGMA foreign_keys=OFF");
      const payload = JSON.stringify({ broughtFrom: { sources: Array.from({ length: fan }, (_, i) => ({ id: `origin-${String(i).padStart(5, "0")}` })) } });
      fx.db.prepare("INSERT INTO memory_source_versions(source_id,revision,content_hash,payload,created_at) VALUES('bring-in:huge',0,'h',?,0)").run(payload);
      fx.db.exec("DELETE FROM memory_source_origins; INSERT OR REPLACE INTO memory_late_build VALUES('evidence',1,NULL),('origins',0,NULL)");
      fx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const cap = revokeBudget.revokePaceRows(fx.db, now);
      fx.db.exec("BEGIN IMMEDIATE");
      const measure = beginRevokeMeasure(fx.db), r0 = totalChanges(fx.db);
      expect(lateBuildStep(fx.db, Math.min(1, cap))).toBe(true); // ONE input row
      const rows = totalChanges(fx.db) - r0;
      revokeBudget.chargeRevokeRows(fx.db, rows);
      fx.db.exec("COMMIT");
      const c0 = committed();
      endRevokeMeasure(fx.db, measure, false);
      const put = committed() - c0;
      console.log(`IODRAIN R2 fan=${fan} rows=${rows} put=${(put / MB).toFixed(3)}MB cap=${cap}`);
      expect(rows).toBeGreaterThan(cap + MARKER_STEP_RESERVE); // past the per-commit row bound: bounded per input row instead
      expect(put).toBeGreaterThan(0);
      expect(put).toBeLessThanOrEqual(2 * rows * W + 2 * 32);
      expect(revokeBudget.revokePacedBytes(now)).toBeGreaterThanOrEqual(put - 1); // charged at once
      expect(put).toBeGreaterThan(revokeBudget.REVOKE_PACE.bytesPerMinute); // the one row alone is more than the pace's minute
      expect(revokeBudget.revokePaceRows(fx.db, now)).toBe(0); // the next step waits
      expect(revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db), now)).toBeGreaterThan(0);
      now += MINUTE + 1;
      expect(revokeBudget.revokePaceRows(fx.db, now)).toBe(revokeBudget.REVOKE_PACE_COMMIT.rows); // and resumes once it has aged
    } finally { fx.close(); }
  });

  it("(c) flip cutoff: a receipt whose commit would pass cap + step reserve is planned on the wildcard pair, so no flip overrides the cap", () => {
    const fx = walStorm(20);
    try {
      flipAll(fx);
      const cutoff = revokeBudget.revokeFlipCutoffRows(fx.db);
      expect(cutoff).toBe(Math.min(revokeBudget.revokeMinuteChanges(fx.db), revokeBudget.REVOKE_PACE_COMMIT.rows + MARKER_STEP_RESERVE));
      const bundle = String((fx.db.prepare("SELECT bundle_id FROM memory_receipt_flips LIMIT 1").get() as { bundle_id: string }).bundle_id);
      const items = 700; // one carry thread each: 16 + 700 + 701 + 8 rows unheld, over 1,024
      fx.db.prepare("UPDATE memory_disclosures SET record_versions=? WHERE bundle_id=?").run(JSON.stringify(Array.from({ length: items }, (_, i) => ({ id: `rec-${i}`, version: 1 }))), bundle);
      const cost = receiptCommitCost(fx.db, bundle) + 8; // with its bulk's opening, as the head flip is priced
      expect(cost).toBeLessThanOrEqual(cutoff);
    } finally { fx.close(); }
  });

  it("H-a self copy: with no checkpointer, a reader that pins the drain's post-COMMIT copy holds it as debt; once the reader ends, the drain's next wait decision copies the log itself and proves it", () => {
    const fx = walStorm(500);
    const reader = new DatabaseSync(dbFile(fx.db));
    try {
      let now = 1_000_000;
      setRevokeBudgetClock(() => now); resetRevokeWriteBudget();
      flipAll(fx);
      pin(fx, reader);
      const c0 = meter("selfCopies");
      drainRevokeMarkerBounded(fx.db, { rows: 256, ms: 1_000_000 });
      const held = revokeBudget.revokeOutstandingCopyBytes();
      expect(held).toBeGreaterThan(0);
      expect(meter("selfCopies") - c0).toBeGreaterThan(0); // it tried at its COMMIT; the reader stopped it
      now += 30_000; // inside the bound
      revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db), now); // a wait decision: its own copy is tried again, and cannot pass
      expect(revokeBudget.revokeOutstandingCopyBytes()).toBe(held); // pinned: still debt, and it holds the pace
      expect(revokeBudget.revokePacedBytes(now)).toBeGreaterThanOrEqual(held);
      reader.exec("COMMIT");
      const s0 = meter("copiesSettled");
      revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db), now); // the runner's next wait decision; no other connection checkpoints
      expect(revokeBudget.revokeOutstandingCopyBytes()).toBe(0);
      expect(meter("copiesSettled") - s0).toBe(held);
      expect(meter("copiesLapsed")).toBe(0);
      const index = walIndexMark(fx.db)!;
      expect(index.nBackfill).toBeGreaterThanOrEqual(index.mxFrame); // the drain's own copy really ran
      expect(revokeBudget.revokePacedBytes(now)).toBeGreaterThanOrEqual(held); // dated at the copy
      expect(revokeBudget.revokePacedBytes(now + MINUTE + 1)).toBe(0);
    } finally { reader.close(); fx.close(); }
  });

  it("H-a bound and the late copy: a reader pinned past COPY_PROOF_MAX_MS dates the debt at the bound and the drain runs on; the copy is charged again in the minute it lands, and the watchdog counts that minute", () => {
    const fx = walStorm(500);
    const file = dbFile(fx.db);
    const reader = new DatabaseSync(file);
    try {
      let now = 1_000_000;
      setRevokeBudgetClock(() => now); resetRevokeWriteBudget();
      flipAll(fx);
      pin(fx, reader);
      drainRevokeMarkerBounded(fx.db, { rows: 256, ms: 1_000_000 });
      const held = revokeBudget.revokeOutstandingCopyBytes();
      expect(held).toBeGreaterThan(0);
      now += revokeBudget.COPY_PROOF_MAX_MS - 1;
      revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db), now);
      expect(revokeBudget.revokeOutstandingCopyBytes()).toBe(held); // inside the bound: still debt
      now += 1;
      revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db), now);
      expect(revokeBudget.revokeOutstandingCopyBytes()).toBe(0);
      expect(meter("copiesLapsed")).toBe(held);
      expect(revokeBudget.revokeLateCopyBytes()).toBe(held);
      expect(revokeBudget.revokePacedBytes(now)).toBeGreaterThanOrEqual(held); // dated at the bound: its copy minute
      now += MINUTE + 1;
      expect(revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db), now)).toBe(0); // never a wait for ever
      const s0 = meter("slices");
      drainRevokeMarkerBounded(fx.db, { rows: 256, ms: 1_000_000 });
      expect(meter("slices")).toBeGreaterThan(s0); // the drain ran on behind the reader
      const held2 = revokeBudget.revokeOutstandingCopyBytes();
      now += 30_000;
      // the minute in which the late copy lands, judged by the watchdog wired as production wires it
      const wal = walFrameReader(file);
      let reading: IoReading = { at: 0, fsWriteBlocks: readProcess().fsWriteBlocks, cpuMicros: 0 };
      const budget = new IoBudget({ read: () => reading, log: () => {}, onScale: () => {}, isIdle: () => true, systemOverloaded: () => null });
      budget.registerByteSource("database:messages.db", wal);
      budget.tick();
      reader.exec("COMMIT");
      const d0 = meter("paceDated"), os0 = readProcess().fsWriteBlocks;
      revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db), now); // the drain's next wait decision: its own copy lands both
      const os = (readProcess().fsWriteBlocks - os0) * BLOCK_BYTES;
      reading = { at: MINUTE, fsWriteBlocks: readProcess().fsWriteBlocks, cpuMicros: 0 };
      const verdict = budget.tick()!;
      wal.close();
      console.log(`IODRAIN LATE held=${held} held2=${held2} landed=${meter("copiesLanded")} dated=${meter("paceDated") - d0} os=${os} counted=${verdict.writeBytesPerMinute}`);
      expect(revokeBudget.revokeLateCopyBytes()).toBe(0);
      expect(meter("copiesLanded")).toBe(held);
      expect(meter("paceDated") - d0).toBe(held + held2); // the late copy is charged in the minute it lands, with the debt proven with it
      expect(revokeBudget.revokePacedBytes(now)).toBeGreaterThanOrEqual(held + held2);
      expect(os).toBeGreaterThan(0); // the copy wrote the main file in this minute
      expect(verdict.writeBytesPerMinute).toBeGreaterThanOrEqual(os - BLOCK_BYTES); // and the watchdog counted it: nothing taken off
    } finally { reader.close(); fx.close(); }
  });

  it("ruling B two readers: a late copy lands, and is charged, when ITS frames are copied while a newer reader still pins the drain's later commit", () => {
    const fx = walStorm(1000);
    const file = dbFile(fx.db);
    const first = new DatabaseSync(file), second = new DatabaseSync(file);
    try {
      let now = 1_000_000;
      setRevokeBudgetClock(() => now); resetRevokeWriteBudget();
      flipAll(fx);
      pin(fx, first);
      drainRevokeMarkerBounded(fx.db, { rows: 256, ms: 1_000_000 }); // commit A, pinned by the first reader
      const a = revokeBudget.revokeOutstandingCopyBytes();
      expect(a).toBeGreaterThan(0);
      now += revokeBudget.COPY_PROOF_MAX_MS;
      revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db), now);
      expect(revokeBudget.revokeLateCopyBytes()).toBe(a); // A lapsed into the late record
      second.exec("BEGIN"); second.prepare("SELECT count(*) AS n FROM sqlite_master").get(); // a newer snapshot, after A
      now += MINUTE + 1;
      drainRevokeMarkerBounded(fx.db, { rows: 256, ms: 1_000_000 }); // commit B, pinned by the second reader
      const b = revokeBudget.revokeOutstandingCopyBytes();
      expect(b).toBeGreaterThan(0);
      expect(revokeBudget.revokeLateCopyBytes()).toBe(a); // the first reader still pins A
      first.exec("COMMIT");
      const d0 = meter("paceDated");
      revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db), now); // the drain's own copy reaches A's frames, not B's
      const index = walIndexMark(fx.db)!;
      console.log(`IODRAIN TWOREADERS a=${a} b=${b} landed=${meter("copiesLanded")} dated=${meter("paceDated") - d0} nBackfill=${index.nBackfill} mxFrame=${index.mxFrame}`);
      expect(index.nBackfill).toBeLessThan(index.mxFrame); // the log is NOT completely copied: B is still pinned
      expect(revokeBudget.revokeLateCopyBytes()).toBe(0);
      expect(meter("copiesLanded")).toBe(a); // A is charged in the minute it landed
      expect(meter("paceDated") - d0).toBe(a);
      expect(revokeBudget.revokeOutstandingCopyBytes()).toBe(b); // B stays debt
    } finally { first.close(); second.close(); fx.close(); }
  });

  it("ruling A guard: a foreign commit between the proof and the guard skips the reset, so nothing of it is copied under the writer lock", () => {
    const fx = walStorm(500);
    const other = new DatabaseSync(dbFile(fx.db));
    try {
      let now = 1_000_000;
      setRevokeBudgetClock(() => now); resetRevokeWriteBudget();
      flipAll(fx);
      other.exec("CREATE TABLE IF NOT EXISTS iod36_grd(x BLOB)");
      other.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
      revokeBudget.revokePaceTestHooks.beforeResetGuard = () => {
        revokeBudget.revokePaceTestHooks.beforeResetGuard = null;
        other.prepare("INSERT INTO iod36_grd VALUES (randomblob(20000))").run(); // after the proof, before the guard
      };
      const s0 = meter("logResetsSkipped"), r0 = meter("logResets");
      revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db), now);
      const after = walIndexMark(fx.db)!;
      console.log(`IODRAIN GUARD skipped=${meter("logResetsSkipped") - s0} resets=${meter("logResets") - r0} mxFrame=${after.mxFrame} nBackfill=${after.nBackfill}`);
      expect(meter("logResetsSkipped") - s0).toBe(1);
      expect(meter("logResets") - r0).toBe(0);
      expect(after.mxFrame).toBeGreaterThan(after.nBackfill); // the foreign commit is left in the log, uncopied by the drain
    } finally { other.close(); fx.close(); }
  });

  it("H-b restart: a log restart the drain did not make, between its COMMIT and its read (another connection copies its frames and restarts the log smaller), is charged rows x W, never the smaller generation", () => {
    const fx = walStorm(500);
    const other = new DatabaseSync(dbFile(fx.db));
    try {
      let now = 1_000_000;
      setRevokeBudgetClock(() => now); resetRevokeWriteBudget();
      flipAll(fx);
      const W = revokeBudget.revokeChangeCeiling(fx.db);
      fx.db.exec("CREATE TABLE IF NOT EXISTS iod36_hb(x); PRAGMA wal_checkpoint(TRUNCATE)");
      fx.db.exec("BEGIN IMMEDIATE");
      const measure = beginRevokeMeasure(fx.db);
      budgetedMarkerSlice(fx.db, 256, 1_000_000);
      fx.db.exec("COMMIT");
      const rows = totalChanges(fx.db) - measure.changes;
      other.prepare("PRAGMA wal_checkpoint(PASSIVE)").get(); // the drain's frames copied by another connection
      other.exec("INSERT INTO iod36_hb VALUES (1)"); // whose next write restarts the log: a smaller generation under a new salt
      expect(walIndexMark(fx.db)!.salt).not.toBe(measure.mark!.salt);
      const u0 = meter("paceUnmeasured"), s0 = meter("copiesSettled");
      endRevokeMeasure(fx.db, measure);
      console.log(`IODRAIN HB rows=${rows} W=${W} unmeasured=${meter("paceUnmeasured") - u0}`);
      expect(rows).toBeGreaterThan(0);
      expect(meter("paceUnmeasured") - u0).toBeGreaterThanOrEqual(2 * Math.ceil(rows * W)); // both halves at rows x W
      expect(meter("copiesSettled") - s0 + revokeBudget.revokeOutstandingCopyBytes()).toBe(Math.ceil(rows * W)); // the copy half too
    } finally { other.close(); fx.close(); }
  });

  it("H-b exact: with no reader, consecutive drain commits are measured under the salt they marked (the drain's own copy resets the log), never at rows x W", () => {
    const fx = walStorm(1000);
    try {
      let now = 1_000_000;
      setRevokeBudgetClock(() => now); resetRevokeWriteBudget();
      flipAll(fx);
      fx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const u0 = meter("paceUnmeasured"), m0 = meter("paceMeasured"), z0 = meter("logResets");
      let commits = 0;
      for (let n = 0; n < 6; n++) {
        const r0 = totalChanges(fx.db);
        drainRevokeMarkerBounded(fx.db, { rows: 256, ms: 1_000_000 });
        if (totalChanges(fx.db) - r0 > 0) commits++;
        now += MINUTE + 1;
      }
      console.log(`IODRAIN HBX commits=${commits} measured=${meter("paceMeasured") - m0} unmeasured=${meter("paceUnmeasured") - u0} resets=${meter("logResets") - z0}`);
      expect(commits).toBeGreaterThan(2);
      expect(meter("paceUnmeasured")).toBe(u0);
      expect(meter("paceMeasured") - m0).toBeGreaterThan(0);
      expect(meter("logResets") - z0).toBeGreaterThanOrEqual(commits);
    } finally { fx.close(); }
  });

  it("H-b ready: a log another connection's checkpoint left completely copied is reset before the drain's next transaction, so that commit is measured under its own salt, never rows x W", () => {
    const fx = walStorm(500);
    const other = new DatabaseSync(dbFile(fx.db));
    try {
      let now = 1_000_000;
      setRevokeBudgetClock(() => now); resetRevokeWriteBudget();
      flipAll(fx); // the owner's writes, then another connection's checkpoint copies all of them and leaves the log as it is
      other.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
      const before = walIndexMark(fx.db)!;
      expect(before.mxFrame).toBeGreaterThan(0);
      expect(before.nBackfill).toBe(before.mxFrame);
      const u0 = meter("paceUnmeasured"), m0 = meter("paceMeasured"), r0 = totalChanges(fx.db);
      drainRevokeMarkerBounded(fx.db, { rows: 256, ms: 1_000_000 });
      console.log(`IODRAIN HBR rows=${totalChanges(fx.db) - r0} measured=${meter("paceMeasured") - m0} unmeasured=${meter("paceUnmeasured") - u0}`);
      expect(totalChanges(fx.db) - r0).toBeGreaterThan(0);
      expect(meter("paceUnmeasured")).toBe(u0);
      expect(meter("paceMeasured") - m0).toBeGreaterThan(0);
    } finally { other.close(); fx.close(); }
  });

  it("ruling 1: the drain's log reset never waits while another connection holds the writer (busy_timeout 0 for that call, restored), and a reset that returns busy leaves the next commit at rows x W", () => {
    const fx = walStorm(1000);
    const file = dbFile(fx.db);
    const reader = new DatabaseSync(file), writer = new DatabaseSync(file);
    try {
      let now = 1_000_000;
      setRevokeBudgetClock(() => now); resetRevokeWriteBudget();
      flipAll(fx);
      const W = revokeBudget.revokeChangeCeiling(fx.db);
      fx.db.exec("PRAGMA busy_timeout=5000");
      pin(fx, reader);
      drainRevokeMarkerBounded(fx.db, { rows: 256, ms: 1_000_000 });
      expect(revokeBudget.revokeOutstandingCopyBytes()).toBeGreaterThan(0);
      reader.exec("COMMIT");
      writer.exec("BEGIN IMMEDIATE"); // holds the writer lock and writes nothing
      const b0 = meter("logResetsBusy"), t0 = performance.now();
      revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db), now); // its own copy: PASSIVE copies all; the reset meets the writer
      const ms = performance.now() - t0;
      console.log(`IODRAIN RESETBUSY ms=${ms.toFixed(1)} busy=${meter("logResetsBusy") - b0}`);
      expect(ms).toBeLessThan(1000); // it never waited (the handle's own wait is 5 s)
      expect(meter("logResetsBusy") - b0).toBe(1);
      expect(Number((fx.db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout)).toBe(5000); // restored
      expect(revokeBudget.revokeOutstandingCopyBytes()).toBe(0); // the copy itself is proven by the PASSIVE result
      const index = walIndexMark(fx.db)!;
      expect(index.mxFrame).toBeGreaterThan(0); // not reset
      expect(index.nBackfill).toBe(index.mxFrame);
      writer.exec("ROLLBACK");
      now += MINUTE + 1;
      // the drain's next transaction straight away (no wait decision in between to reset again): its first write restarts the copied log,
      // a restart it did not prove, so both halves are rows x W
      const u0 = meter("paceUnmeasured");
      fx.db.exec("BEGIN IMMEDIATE");
      const measure = beginRevokeMeasure(fx.db);
      budgetedMarkerSlice(fx.db, 256, 1_000_000);
      fx.db.exec("COMMIT");
      const rows = totalChanges(fx.db) - measure.changes;
      endRevokeMeasure(fx.db, measure);
      expect(rows).toBeGreaterThan(0);
      expect(meter("paceUnmeasured") - u0).toBeGreaterThanOrEqual(2 * Math.ceil(rows * W));
    } finally { reader.close(); writer.close(); fx.close(); }
  });

  it("Medium: a drain-owned transaction open past 60 s leaves the pace and admission together, dated at its COMMIT", () => {
    const fx = walStorm(500);
    try {
      let now = 1_000_000;
      setRevokeBudgetClock(() => now); resetRevokeWriteBudget();
      flipAll(fx);
      fx.db.exec("BEGIN IMMEDIATE");
      const measure = beginRevokeMeasure(fx.db);
      budgetedMarkerSlice(fx.db, 256, 1_000_000);
      now += 3 * MINUTE; // held open
      expect(revokeBudget.revokeBytesWritten(now)).toBeGreaterThan(0); // tagged with the open transaction, not aged out
      fx.db.exec("COMMIT");
      endRevokeMeasure(fx.db, measure);
      expect(revokeBudget.revokeBytesWritten(now)).toBeGreaterThan(0);
      expect(revokeBudget.revokePacedBytes(now)).toBeGreaterThan(0);
      fx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      revokeBudget.revokePaceRows(fx.db, now);
      expect(revokeBudget.revokeBytesWritten(now + MINUTE + 1)).toBe(0);
      expect(revokeBudget.revokePacedBytes(now + MINUTE + 1)).toBe(0);
    } finally { fx.close(); }
  });
});

describe("r3.6: the macOS OS write floor and the unknown minute", () => {
  it("R1 darwinWrittenBytes: a count, else null for no reader, null, a throw, NaN, a negative or a count that went down (never 0)", () => {
    expect(darwinWrittenBytes(() => 4096)).toBe(4096);
    expect(darwinWrittenBytes(() => 8192)).toBe(8192);
    expect(darwinWrittenBytes(() => 4096)).toBeNull(); // went down
    expect(darwinWrittenBytes(() => undefined)).toBeNull(); // no addon or no diskWritten
    expect(darwinWrittenBytes(() => null)).toBeNull();
    expect(darwinWrittenBytes(() => { throw new Error("x"); })).toBeNull();
    expect(darwinWrittenBytes(() => Number.NaN)).toBeNull();
    expect(darwinWrittenBytes(() => -1)).toBeNull();
    expect(readProcess("darwin", () => 5120)).toMatchObject({ fsWriteBlocks: 5120 / BLOCK_BYTES });
    expect(readProcess("darwin", () => null).osKnown).toBe(false);
    expect(readProcess("linux", () => null).osKnown).toBeUndefined(); // Linux reads getrusage, never the addon
  });

  it.runIf(process.platform === "darwin")("R1 on a Mac: the real addon's diskWritten is readable and counts an fsynced write", async () => {
    const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
    const before = readProcess();
    expect(before.osKnown).not.toBe(false);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "iod36-")), "w.bin");
    const fd = fs.openSync(file, "w"); fs.writeSync(fd, Buffer.alloc(4 * MB, 7)); fs.fsyncSync(fd); fs.closeSync(fd);
    const after = readProcess();
    expect((after.fsWriteBlocks - before.fsWriteBlocks) * BLOCK_BYTES).toBeGreaterThanOrEqual(4 * MB);
    removeTempDirSync(path.dirname(file));
  });

  it("R2 fail closed: a minute whose OS count is unknown is never calm, halves the poll rate, is never valid evidence, and says so once", () => {
    let at = 0, known = true;
    const lines: string[] = [], scales: number[] = [], samples: boolean[] = [];
    const budget = new IoBudget({ read: () => ({ at, fsWriteBlocks: 0, cpuMicros: 0, ...(known ? {} : { osKnown: false }) }), log: l => lines.push(l), onScale: s => scales.push(s), isIdle: () => true, systemOverloaded: () => null, onSample: s => samples.push(s.discontinuity) });
    budget.tick();
    known = false;
    for (let k = 1; k <= 30; k++) { at = k * MINUTE; budget.tick(); }
    expect(scales).toContain(2);
    expect(scales.filter(s => s < 2)).toEqual([]); // never stepped back while unknown
    expect(samples.length).toBe(30);
    expect(samples.every(Boolean)).toBe(true);
    expect(lines.filter(l => l.includes("os writes unknown"))).toHaveLength(1);
  });
});

/** A copied log before any drain commit, with another connection in this process for the reset window. */
function resetFixture() {
  const fx = walStorm(500), other = new DatabaseSync(dbFile(fx.db));
  setRevokeBudgetClock(() => 1_000_000); resetRevokeWriteBudget();
  other.exec("PRAGMA wal_autocheckpoint=0; CREATE TABLE iod36_reset(x BLOB)");
  other.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
  const foreign = () => { other.exec("INSERT INTO iod36_reset VALUES (randomblob(20000))"); other.exec("INSERT INTO iod36_reset VALUES (randomblob(20000))"); };
  const reset = () => revokeBudget.revokePaceNeed(fx.db);
  const fallback = () => (revokeBudget.REVOKE_PACE_COMMIT.rows + 512) * revokeBudget.revokeChangeCeiling(fx.db);
  return { fx, other, foreign, reset, fallback, close: () => { other.close(); fx.close(); } };
}

// These cases seed real FULL-synchronous files, including several seeds within one test.
describe("r3.6d reset accounting on every OS", { timeout: 900_000 }, () => {
  it("reset charges foreign commits", () => {
    const fx = walStorm(500);
    const other = new DatabaseSync(dbFile(fx.db));
    try {
      let now = 1_000_000;
      setRevokeBudgetClock(() => now); resetRevokeWriteBudget();
      flipAll(fx);
      other.exec("CREATE TABLE IF NOT EXISTS iod36_win(x BLOB)");
      other.prepare("PRAGMA wal_checkpoint(PASSIVE)").get(); // a completely copied log: the drain's next look resets it
      let foreign = -1, tail = -1, counter = 1000;
      revokeBudget.revokePaceTestHooks.resetCounter = () => counter;
      revokeBudget.revokePaceTestHooks.inResetWindow = () => {
        revokeBudget.revokePaceTestHooks.inResetWindow = null;
        const m0 = walIndexMark(fx.db)!;
        other.prepare("INSERT INTO iod36_win VALUES (randomblob(20000))").run(); // the first foreign commit inside the window
        expect(Number((other.prepare("SELECT count(*) AS n FROM iod36_win").get() as { n: number }).n)).toBe(1);
        other.prepare("INSERT INTO iod36_win VALUES (randomblob(20000))").run();
        counter += 123456;
        const m1 = walIndexMark(fx.db)!;
        foreign = m1.salt === m0.salt ? m1.mxFrame - m0.mxFrame : m1.mxFrame; // its own frames (a restart starts the log at them)
        tail = m1.mxFrame - m1.nBackfill; // all the TRUNCATE has to copy
      };
      const r0 = meter("logResets"), d0 = meter("paceDated"), p0 = revokeBudget.revokePacedBytes(now);
      revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db), now); // a wait decision: readyLog, guard, then the window
      const after = walIndexMark(fx.db)!;
      console.log(`IODRAIN WINDOW foreign=${foreign} tail=${tail} resets=${meter("logResets") - r0} mxFrame=${after.mxFrame}`);
      expect(foreign).toBeGreaterThan(0);
      expect(tail).toBeLessThanOrEqual(foreign); // the reset copied the foreign frames
      expect(meter("logResets") - r0).toBe(1);
      expect(after.mxFrame).toBe(0); // and it was copied and reset: nothing else was in the log
      expect(Number((other.prepare("SELECT count(*) AS n FROM iod36_win").get() as { n: number }).n)).toBe(2);
      expect(meter("paceDated") - d0).toBe(123456);
      expect(revokeBudget.revokePacedBytes(now) - p0).toBe(123456);
      expect(meter("resetForeignMeasured")).toBe(1);
      expect(meter("resetForeignUnknown")).toBe(0);
    } finally { other.close(); fx.close(); }
  });

  it("reset zero counter is unknown", () => {
    const f = resetFixture();
    try {
      revokeBudget.revokePaceTestHooks.resetCounter = () => 100;
      revokeBudget.revokePaceTestHooks.inResetWindow = f.foreign;
      f.reset();
      expect(revokeBudget.revokePacedBytes()).toBe(f.fallback());
      expect(meter("resetForeignUnknown")).toBe(1);
      expect(meter("resetForeignMeasured")).toBe(0);
    } finally { f.close(); }
  });

  it("reset quiet", () => {
    const f = resetFixture();
    try {
      let counter = 0;
      revokeBudget.revokePaceTestHooks.resetCounter = () => counter += 4096;
      f.reset();
      expect(revokeBudget.revokePacedBytes()).toBe(0);
      expect(meter("logResets")).toBe(1);
      expect(meter("resetForeignMeasured") + meter("resetForeignUnknown")).toBe(0);
    } finally { f.close(); }
  });

  it("reset unknown counter win32", () => {
    const f = resetFixture();
    try {
      revokeBudget.revokePaceTestHooks.platform = "win32";
      revokeBudget.revokePaceTestHooks.inResetWindow = f.foreign;
      f.reset();
      expect(revokeBudget.revokePacedBytes()).toBe(f.fallback());
      expect(meter("resetForeignUnknown")).toBe(1);
      expect(meter("resetForeignMeasured")).toBe(0);
    } finally { f.close(); }
  });

  it("data_version same-process connection", () => {
    const f = resetFixture();
    const dv = () => Number(f.fx.db.prepare("PRAGMA data_version").get()!.data_version);
    try {
      const before = dv();
      revokeBudget.revokePaceTestHooks.resetCounter = () => null;
      f.reset();
      expect(dv()).toBe(before);
      expect(revokeBudget.revokePacedBytes()).toBe(0);
      f.other.exec("INSERT INTO iod36_reset VALUES (1)");
      f.other.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
      const next = dv();
      revokeBudget.revokePaceTestHooks.inResetWindow = () => { f.foreign(); expect(dv()).not.toBe(next); };
      f.reset();
      expect(dv()).not.toBe(next);
      expect(revokeBudget.revokePacedBytes()).toBe(f.fallback());
    } finally { f.close(); }
  });

  it("reset busy copies foreign", () => {
    const f = resetFixture(), reader = new DatabaseSync(dbFile(f.fx.db));
    try {
      let counter = 0, frames = 0;
      f.fx.db.exec("PRAGMA busy_timeout=5000");
      revokeBudget.revokePaceTestHooks.resetCounter = () => counter;
      revokeBudget.revokePaceTestHooks.inResetWindow = () => {
        f.foreign();
        frames = walIndexMark(f.fx.db)!.mxFrame;
        reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM iod36_reset").get();
        counter = 65536;
      };
      f.reset();
      expect(meter("logResetsBusy")).toBe(1);
      expect(meter("logResets")).toBe(0);
      expect(walIndexMark(f.fx.db)!.nBackfill).toBe(frames);
      expect(frames).toBeGreaterThan(0);
      expect(revokeBudget.revokePacedBytes()).toBe(65536);
      expect(meter("paceDated")).toBe(65536);
      expect(meter("resetForeignMeasured")).toBe(1);
      expect(Number(f.fx.db.prepare("PRAGMA busy_timeout").get()!.timeout)).toBe(5000);
    } finally { reader.close(); f.close(); }
  });

  it("readyLog before first commit", () => {
    for (const samples of [[null, null], [100, 50], [100, 100]]) {
      const f = resetFixture();
      try {
        let i = 0;
        revokeBudget.revokePaceTestHooks.resetCounter = () => samples[i++]!;
        revokeBudget.revokePaceTestHooks.inResetWindow = f.foreign;
        f.reset();
        expect(revokeBudget.revokePacedBytes()).toBe(f.fallback());
        expect(revokeBudget.revokePacedBytes()).toBeGreaterThan(0);
        expect(meter("resetForeignUnknown")).toBe(1);
        expect(meter("resetForeignMeasured")).toBe(0);
      } finally { f.close(); }
    }
  });

  it("data_version unreadable", () => {
    for (const beforeMissing of [true, false]) {
      const f = resetFixture(); flipAll(f.fx); f.other.prepare("PRAGMA wal_checkpoint(PASSIVE)").get(); // a copied log, as in the win32 sibling: the TRUNCATE is deterministic
      try {
        let reads = 0, counter = 0, called = false;
        f.fx.db.exec("PRAGMA busy_timeout=5000");
        revokeBudget.revokePaceTestHooks.dataVersion = () => beforeMissing || reads++ > 0 ? null : 1;
        revokeBudget.revokePaceTestHooks.resetCounter = () => counter += 4096;
        revokeBudget.revokePaceTestHooks.inResetWindow = () => { called = true; f.foreign(); };
        f.reset();
        expect(called).toBe(!beforeMissing);
        expect(Number(f.fx.db.prepare("PRAGMA busy_timeout").get()!.timeout)).toBe(5000);
        expect(meter("logResetsSkipped")).toBe(beforeMissing ? 1 : 0);
        expect(meter("logResets")).toBe(beforeMissing ? 0 : 1); expect(meter("logResetsBusy")).toBe(0);
        expect(revokeBudget.revokePacedBytes()).toBe(beforeMissing ? 0 : f.fallback());
        expect(meter("resetForeignUnknown")).toBe(beforeMissing ? 0 : 1);
        expect(meter("resetForeignMeasured")).toBe(0);
      } finally { revokeBudget.revokePaceTestHooks.dataVersion = null; f.close(); }
    }
  });
});

/** Copy debt on a real WAL, with snapshots chosen by each landing test. */
function copyFixture() {
  const fx = walStorm(500), first = new DatabaseSync(dbFile(fx.db)), second = new DatabaseSync(dbFile(fx.db));
  let now = 1_000_000;
  setRevokeBudgetClock(() => now); resetRevokeWriteBudget();
  fx.db.exec("CREATE TABLE iod36_copy(x BLOB)");
  pin(fx, first);
  const look = () => revokeBudget.revokePaceNeed(fx.db);
  const lapse = () => { now += revokeBudget.COPY_PROOF_MAX_MS; look(); };
  const append = () => fx.db.exec("INSERT INTO iod36_copy VALUES (randomblob(20000))");
  const snapshot = (db: DatabaseSync) => { db.exec("BEGIN"); db.prepare("SELECT count(*) FROM iod36_copy").get(); };
  const commit = (mode: "readable" | "unreadable" | "bytes" = "readable") => {
    fx.db.exec("BEGIN IMMEDIATE");
    const from = beginRevokeMeasure(fx.db);
    expect(from.mark).not.toBeNull(); // the BEGIN index is readable even when the COMMIT index is not
    append(); fx.db.exec("COMMIT");
    if (mode === "unreadable") revokeBudget.revokePaceTestHooks.unmeasurable = true;
    if (mode === "bytes") { from.mark = null; from.os = null; }
    const bytes = endRevokeMeasure(fx.db, from);
    if (mode !== "readable") expect(bytes).toBeNull();
    const held = revokeBudget.revokeOutstandingCopyBytes();
    expect(held).toBeGreaterThan(0);
    return { held, from };
  };
  return { fx, first, second, look, lapse, append, snapshot, commit, close: () => { first.close(); second.close(); fx.close(); } };
}

describe("r3.6d copy landing marks", { timeout: 900_000 }, () => {
  it("ruling B two lapsed copies", () => {
    const f = copyFixture();
    try {
      const a = f.commit().held;
      const markA = walIndexMark(f.fx.db)!;
      f.lapse();
      expect(revokeBudget.revokeLateCopyBytes()).toBe(a);
      f.snapshot(f.second);
      const b = f.commit().held;
      const markB = walIndexMark(f.fx.db)!;
      expect(markB.salt).toBe(markA.salt);
      expect(markB.mxFrame).toBeGreaterThan(markA.mxFrame);
      f.lapse();
      expect(revokeBudget.revokeLateCopyBytes()).toBe(a + b);
      expect(meter("copiesLanded")).toBe(0);
      f.first.exec("COMMIT");
      const d0 = meter("paceDated");
      f.look();
      const partial = walIndexMark(f.fx.db)!;
      expect(partial.nBackfill).toBeGreaterThanOrEqual(markA.mxFrame);
      expect(partial.nBackfill).toBeLessThan(markB.mxFrame);
      expect(meter("paceDated")).toBe(d0);
      expect(meter("copiesLanded")).toBe(0);
      expect(revokeBudget.revokeLateCopyBytes()).toBe(a + b);
      f.second.exec("COMMIT"); f.look();
      expect(meter("paceDated") - d0).toBe(a + b);
      expect(meter("copiesLanded")).toBe(a + b);
      expect(revokeBudget.revokeLateCopyBytes()).toBe(0);
      f.look();
      expect(meter("paceDated") - d0).toBe(a + b);
    } finally { f.close(); }
  });

  it("unavailable mark recovery", () => {
    for (const mode of ["unreadable", "bytes"] as const) {
      const f = copyFixture();
      try {
        const { held } = f.commit(mode);
        f.lapse();
        expect(revokeBudget.revokeLateCopyBytes()).toBe(held);
        revokeBudget.revokePaceTestHooks.unmeasurable = false;
        f.look(); // an unreadable COMMIT adopts the first later mark
        expect(meter("copiesLanded")).toBe(0);
        const mark = walIndexMark(f.fx.db)!;
        f.snapshot(f.second); f.append();
        f.first.exec("COMMIT");
        const d0 = meter("paceDated");
        f.look();
        const partial = walIndexMark(f.fx.db)!;
        expect(partial.nBackfill).toBeGreaterThanOrEqual(mark.mxFrame);
        expect(partial.nBackfill).toBeLessThan(partial.mxFrame);
        expect(meter("copiesLanded")).toBeGreaterThan(0);
        expect(meter("copiesLanded")).toBe(held);
        expect(meter("paceDated") - d0).toBe(held);
      } finally { revokeBudget.revokePaceTestHooks.unmeasurable = false; f.close(); }
    }
  });

  it("deferred mark after restart", () => {
    const f = copyFixture();
    try {
      const { held, from } = f.commit("unreadable");
      expect(from.mark).not.toBeNull();
      f.lapse();
      expect(revokeBudget.revokeLateCopyBytes()).toBe(held);
      f.first.exec("COMMIT");
      f.fx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      f.append(); f.snapshot(f.first); f.append();
      f.fx.db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
      const recovery = walIndexMark(f.fx.db)!;
      expect(recovery.salt).not.toBe(from.mark!.salt);
      expect(recovery.nBackfill).toBeGreaterThan(0);
      expect(recovery.nBackfill).toBeLessThan(recovery.mxFrame);
      const d0 = meter("paceDated");
      revokeBudget.revokePaceTestHooks.unmeasurable = false;
      f.look();
      expect(meter("copiesLanded")).toBe(0);
      expect(meter("paceDated")).toBe(d0);
      expect(revokeBudget.revokeLateCopyBytes()).toBe(held);
      f.look();
      expect(meter("copiesLanded")).toBe(0);
      f.snapshot(f.second); f.append(); f.first.exec("COMMIT");
      f.look();
      const landed = walIndexMark(f.fx.db)!;
      expect(landed.nBackfill).toBeGreaterThanOrEqual(recovery.mxFrame);
      expect(landed.nBackfill).toBeLessThan(landed.mxFrame);
      expect(meter("copiesLanded")).toBe(held);
      expect(meter("paceDated") - d0).toBe(held);
      expect(revokeBudget.revokeLateCopyBytes()).toBe(0);
    } finally { f.close(); }
  });

  it("deferred mark partial landing", () => {
    const f = copyFixture();
    try {
      const { held } = f.commit("unreadable");
      f.lapse();
      const d0 = meter("paceDated");
      revokeBudget.revokePaceTestHooks.unmeasurable = false;
      f.look();
      const adopted = walIndexMark(f.fx.db)!;
      expect(meter("copiesLanded")).toBe(0);
      expect(meter("paceDated")).toBe(d0);
      f.snapshot(f.second); f.append();
      f.look();
      expect(meter("copiesLanded")).toBe(0);
      expect(meter("paceDated")).toBe(d0);
      f.first.exec("COMMIT"); f.look();
      const partial = walIndexMark(f.fx.db)!;
      expect(partial.salt).toBe(adopted.salt);
      expect(partial.nBackfill).toBeGreaterThanOrEqual(adopted.mxFrame);
      expect(partial.nBackfill).toBeLessThan(partial.mxFrame);
      expect(meter("copiesLanded")).toBe(held);
      expect(meter("paceDated") - d0).toBe(held);
      expect(revokeBudget.revokeLateCopyBytes()).toBe(0);
    } finally { f.close(); }
  });

  it.runIf(process.platform === "darwin")("darwin diskWritten cross-check", () => {
    const fx = walStorm(500);
    try {
      fx.db.exec("CREATE TABLE iod36_dw(x BLOB); PRAGMA wal_checkpoint(TRUNCATE)");
      fx.db.exec("INSERT INTO iod36_dw VALUES (randomblob(2097152))");
      const mark = walIndexMark(fx.db)!;
      const frames = (mark.mxFrame - mark.nBackfill) * revokeBudget.frameBytes(fx.db);
      expect(frames).toBeGreaterThanOrEqual(MB);
      expect(frames).toBeLessThanOrEqual(10 * MB);
      const before = darwinWrittenBytes();
      const result = fx.db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get()!;
      const after = darwinWrittenBytes();
      console.log(`IODRAIN DW before=${before} after=${after} frames=${frames}`);
      expect(Number(result.checkpointed)).toBe(Number(result.log));
      expect(before).not.toBeNull(); expect(after).not.toBeNull();
      expect(after! - before!).toBeGreaterThanOrEqual(frames / 2);
    } finally { fx.close(); }
  });
});
