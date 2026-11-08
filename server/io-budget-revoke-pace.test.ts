// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// IO-IDLE-DRAIN-1018 r3.5 (MurageMain rulings, 2026-11-07): the io watchdog exempts NOTHING the revoke drain writes (1.0.17 index.ts
// exempted the drain's rows x C charge, 17-19 MB a minute against 0.1-5.5 MB of real log, so other writes beside it went uncounted), and the
// drain is PACED on its measured bytes instead (revoke-budget.ts REVOKE_PACE, 0.8 MB in any 60 s against the 1 MB/min idle budget).
// M1-M3 are the Mac acceptance legs too (run this file on the Mac gate box; win32 has no OS floor and skips the real-drain describe).
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BLOCK_BYTES, IO_BUDGET_IDLE_BYTES_PER_MINUTE, IoBudget, type IoReading, readProcess, walFrameReader } from "./io-budget.ts";
import { drainRevokeMarkerBounded, stopMemoryRevocation } from "./memory/memory-revocation.ts";
import * as revokeBudget from "./memory/revoke-budget.ts";
import { resetRevokeWriteBudget, setRevokeBudgetClock } from "./memory/revoke-budget.ts";
import { MARKER_STEP_RESERVE } from "./memory/revoke-marker.ts";
import { flipAll, storm } from "./memory/testing/revoke-storm-fixture.ts";
import * as maintenance from "./wal-maintenance.ts";

const MINUTE = 60_000, MB = 1048576;
const fmt = (n: number) => (n / MB).toFixed(2);
const meter = (key: string) => Number((revokeBudget.revokeWriteMeter as unknown as Record<string, number>)[key] ?? 0);
/** The production OS write count, read directly (io-budget.ts readProcess: getrusage's blocks x 512 on Linux, the engine-exclusion addon's
 *  diskWritten on macOS, r3.6). An unreadable count fails the test: these legs judge the OS floor, never a 0 standing in for it. */
const wchar = () => { const r = readProcess(); expect(r.osKnown, "the OS write count is readable on this platform").not.toBe(false); return r.fsWriteBlocks * BLOCK_BYTES; };
const dbFile = (db: DatabaseSync) => (db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(r => r.name === "main")!.file;
const PACE0 = revokeBudget.REVOKE_PACE.bytesPerMinute, BUDGET0 = revokeBudget.REVOKE_WRITE_BUDGET.bytesPerMinute, COMMIT_ROWS0 = revokeBudget.REVOKE_PACE_COMMIT.rows;
/** r3.6 cap sweep (MurageMain: ship the smallest cap whose M1 stays under 86 min): IOD36_COMMIT_ROWS runs M1 at another commit cap. */
const sweepRows = Number(process.env.IOD36_COMMIT_ROWS ?? "");

afterEach(() => {
  revokeBudget.REVOKE_PACE.bytesPerMinute = PACE0; revokeBudget.REVOKE_WRITE_BUDGET.bytesPerMinute = BUDGET0; revokeBudget.REVOKE_PACE_COMMIT.rows = COMMIT_ROWS0;
  revokeBudget.revokePaceTestHooks.unmeasurable = false;
  setRevokeBudgetClock(); resetRevokeWriteBudget(); stopMemoryRevocation();
});

describe("no drain byte is hidden from the io watchdog", () => {
  it("production wires no planned-bytes or planned-copy reader into the io budget: nothing is taken off any minute", () => {
    // the 1.0.17 hole (f28a6bad8 server/index.ts:32668): ioBudget.setPlannedBytes(() => revokeBytesWritten(), ...). A mutant that restores
    // it, or any other planned reader, fails here.
    const server = path.join(import.meta.dirname);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(full); continue; }
        if (!/\.(ts|mts|mjs)$/.test(entry.name) || /\.test\.|\/testing\//.test(full)) continue;
        if (/\.setPlanned(Copy)?Bytes\s*\(/.test(fs.readFileSync(full, "utf8"))) offenders.push(path.relative(server, full));
      }
    };
    walk(server);
    expect(offenders).toEqual([]);
  });
  it("the pace is the production one and sits under the watchdog's idle budget", () => {
    expect(revokeBudget.REVOKE_PACE.bytesPerMinute).toBe(Math.round(0.8 * MB));
    expect(revokeBudget.REVOKE_PACE.bytesPerMinute).toBeLessThan(IO_BUDGET_IDLE_BYTES_PER_MINUTE);
    expect(revokeBudget.REVOKE_WRITE_BUDGET.bytesPerMinute).toBe(20 * MB);
  });
});

describe.skipIf(process.platform === "win32")("io-budget: a real drain on a real file, under the production budget and pace", { timeout: 900_000 }, () => {
  afterEach(async () => { await maintenance.stopWalMaintenance(); });

  /** A storm drained one io-budget sample a minute (fake clock): each minute the drain walks until it is done or the budget or the pace
   *  stops it, the checkpointer's pass copies what it wrote, and the watchdog, wired exactly as production wires it (no planned reader),
   *  judges the minute. */
  function realDrain(opts: { extraMb?: number; receipts?: number; maxMinutes?: number } = {}) {
    const fx = storm(opts.receipts ?? 5000);
    const file = dbFile(fx.db);
    const worker = new DatabaseSync(file);
    try {
      let now = 1_000_000;
      setRevokeBudgetClock(() => now); resetRevokeWriteBudget();
      fx.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0");
      worker.exec("PRAGMA busy_timeout=0");
      const pass = () => { worker.prepare("PRAGMA wal_checkpoint(PASSIVE)").get(); };
      flipAll(fx); // the revoke itself (the owner's commit, in its own turn), then the checkpointer's pass of it: before the drain's first minute
      pass();
      const wal = walFrameReader(file);
      let reading: IoReading = { at: 0, fsWriteBlocks: Math.floor(wchar() / BLOCK_BYTES), cpuMicros: 0 };
      const budget = new IoBudget({ read: () => reading, log: () => {}, onScale: () => {}, isIdle: () => true, systemOverloaded: () => null });
      budget.registerByteSource("database:messages.db", wal); // the application side, as instrumentDatabase registers it
      budget.tick();
      const minutes: Array<{ counted: number; tripped: boolean; os: number; walBytes: number; paced: number; ledger: number; stopped: boolean }> = [];
      let pending = true;
      const t0 = performance.now();
      for (let k = 1; pending && k <= (opts.maxMinutes ?? 90); k++) {
        const walBefore = wal(), os0 = wchar();
        let stopped = false;
        for (let n = 0; pending && n < 5000; n++) {
          pending = drainRevokeMarkerBounded(fx.db, { rows: 1_000_000, ms: 1_000_000 });
          if (pending && revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db), now) > 0) { stopped = true; break; }
        }
        const walBytes = wal() - walBefore;
        pass();
        if (k === 1 && (opts.extraMb ?? 0) > 0) { const fd = fs.openSync(`${file}.unplanned`, "w"); fs.writeSync(fd, Buffer.alloc(opts.extraMb! * MB)); fs.fsyncSync(fd); fs.closeSync(fd); }
        const os = wchar() - os0, paced = revokeBudget.revokePacedBytes(now), ledger = revokeBudget.revokeBytesWritten(now);
        reading = { at: k * MINUTE, fsWriteBlocks: Math.floor(wchar() / BLOCK_BYTES), cpuMicros: reading.cpuMicros + 0.05 * MINUTE * 1000 };
        const verdict = budget.tick()!;
        minutes.push({ counted: verdict.writeBytesPerMinute, tripped: verdict.tripped, os, walBytes, paced, ledger, stopped });
        now += MINUTE + 1; // the minute's charges and paced bytes age out
      }
      return { minutes, pending, wallMs: performance.now() - t0 };
    } finally { worker.close(); fx.close(); }
  }
  const log = (tag: string, minutes: ReturnType<typeof realDrain>["minutes"]) => {
    for (const [i, m] of minutes.entries()) console.log(`IODRAIN ${tag} platform=${process.platform} minute=${i + 1} counted=${fmt(m.counted)} os=${fmt(m.os)} wal=${fmt(m.walBytes)} paced=${fmt(m.paced)} ledger=${fmt(m.ledger)} stopped=${m.stopped} tripped=${m.tripped}`);
  };

  it("M1: the 5000-receipt storm, paced, trips no minute against the 1 MB idle budget, counts every byte, and finishes", () => {
    if (sweepRows > 0) revokeBudget.REVOKE_PACE_COMMIT.rows = sweepRows;
    console.log(`IODRAIN M1 commitRows=${revokeBudget.REVOKE_PACE_COMMIT.rows}`);
    const { minutes, pending, wallMs } = realDrain();
    log("M1", minutes);
    console.log(`IODRAIN M1 done=${!pending} minutes=${minutes.length} trips=${minutes.filter(m => m.tripped).length} maxCounted=${fmt(Math.max(...minutes.map(m => m.counted)))} paceMeasured=${fmt(meter("paceMeasured"))} unmeasured=${fmt(meter("paceUnmeasured"))} wallMs=${Math.round(wallMs)}`);
    expect(pending).toBe(false); // finished: no permanent stall
    for (const m of minutes) {
      expect(m.tripped).toBe(false);
      // nothing taken off: the watchdog's count is the minute's OS writes (to the block), or the log frames when they are more
      expect(m.counted).toBeGreaterThanOrEqual(Math.max(m.os, m.walBytes) - BLOCK_BYTES);
    }
  });
  it("M1 mutant: the same drain without the pace (the limit dropped) trips the idle budget", () => {
    revokeBudget.REVOKE_PACE.bytesPerMinute = Number.POSITIVE_INFINITY;
    const { minutes, pending } = realDrain();
    log("M1-nopace", minutes);
    expect(pending).toBe(false);
    expect(minutes.some(m => m.tripped)).toBe(true);
  });
  it("M2: 10 MB of other writes beside the paced drain trip the minute, counted in full", () => {
    const { minutes } = realDrain({ extraMb: 10, maxMinutes: 2 });
    log("M2", minutes);
    const first = minutes[0]!;
    expect(first.tripped).toBe(true);
    expect(first.counted).toBeGreaterThan(10 * MB); // Linux and macOS alike (r3.6: the macOS floor is the addon's diskWritten)
  });

  it("M-exhaust: a commit's OS bytes beyond its charge are charged to admission, stop the drain, and the next minute resumes it", () => {
    revokeBudget.REVOKE_PACE.bytesPerMinute = Number.POSITIVE_INFINITY; // admission alone
    const fx = storm(2000);
    try {
      let now = 1_000_000;
      setRevokeBudgetClock(() => now); resetRevokeWriteBudget();
      fx.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0");
      flipAll(fx);
      // earlier measured slices bring C down from its ceiling to what rows really cost, as in production
      for (let n = 0; n < 40; n++) { drainRevokeMarkerBounded(fx.db, { rows: 256, ms: 1_000_000 }); now += MINUTE + 1; }
      fx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      fx.db.exec("CREATE TABLE IF NOT EXISTS iod5_other(v BLOB)");
      fx.db.exec("BEGIN"); const other = fx.db.prepare("INSERT INTO iod5_other VALUES (?)"); for (let i = 0; i < 2000; i++) other.run(Buffer.alloc(4000, i % 251)); fx.db.exec("COMMIT");
      fx.db.exec("PRAGMA wal_autocheckpoint=1000"); // the drain's COMMIT checkpoints the other work's 8 MB on its own thread: OS bytes far past its charge
      const budget = revokeBudget.REVOKE_WRITE_BUDGET.bytesPerMinute, need = revokeBudget.revokeSliceNeed(fx.db);
      const sliceMax = Math.ceil((256 + MARKER_STEP_RESERVE) * revokeBudget.revokeCostPerChange(fx.db));
      // the minute so far leaves room for this slice's rows and the next one's need, but not for the overhead as well
      revokeBudget.noteRevokeBytes(budget - sliceMax - 2 * need, now);
      const ledger0 = revokeBudget.revokeBytesWritten(now), charged0 = meter("charged"), beyond0 = meter("osBeyond"), slices0 = meter("slices");
      const pending = drainRevokeMarkerBounded(fx.db, { rows: 256, ms: 1_000_000 }); // one slice, one transaction
      const beyond = meter("osBeyond") - beyond0, added = revokeBudget.revokeBytesWritten(now) - ledger0, rowsCharge = meter("charged") - charged0 - beyond;
      const wait = revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db), now);
      console.log(`IODRAIN EXH platform=${process.platform} slices=${meter("slices") - slices0} rowsCharge=${rowsCharge} beyond=${beyond} added=${added} wait=${wait}`);
      expect(pending).toBe(true);
      if (process.platform !== "linux") return; // the thread OS counter is Linux's
      expect(beyond).toBeGreaterThan(4 * MB); // forced past: the checkpoint's OS bytes on the drain's thread
      expect(added).toBe(rowsCharge + beyond); // admission holds the rows x C charge AND the overhead, exactly
      expect(ledger0 + rowsCharge + revokeBudget.revokeSliceNeed(fx.db)).toBeLessThanOrEqual(budget); // without the overhead there was room for the next slice
      expect(wait).toBeGreaterThan(0); // with it there is none: the stop is the overhead's (a mutant that drops it fails here)
      expect(drainRevokeMarkerBounded(fx.db, { rows: 256, ms: 1_000_000 })).toBe(true);
      expect(meter("slices") - slices0).toBe(1); // nothing more was admitted this minute
      now += MINUTE + 1; // recovery
      expect(revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db), now)).toBe(0);
      drainRevokeMarkerBounded(fx.db, { rows: 256, ms: 1_000_000 });
      expect(meter("slices") - slices0).toBe(2);
    } finally { fx.close(); }
  });

  it("M-expiry: a transaction's charge, overhead and paced bytes are dated at its COMMIT and leave the minute together", () => {
    const fx = storm(200);
    try {
      const T = 1_000_000;
      let now = T;
      setRevokeBudgetClock(() => now); resetRevokeWriteBudget();
      fx.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0");
      flipAll(fx);
      fx.db.exec("BEGIN IMMEDIATE");
      const measure = revokeBudget.beginRevokeMeasure(fx.db);
      const os0 = meter("osMeasured");
      expect(revokeBudget.budgetedMarkerSlice(fx.db, 256, 1_000_000, null)).toBe(true); // charged at T
      now = T + 5_000; // the transaction's COMMIT comes 5 s later
      fx.db.exec("COMMIT");
      revokeBudget.endRevokeMeasure(fx.db, measure);
      const osBytes = meter("osMeasured") - os0, held = revokeBudget.revokeBytesWritten(now), paced = revokeBudget.revokePacedBytes(now);
      console.log(`IODRAIN EXPIRY platform=${process.platform} held=${held} os=${osBytes} paced=${paced}`);
      expect(held).toBeGreaterThan(0); expect(paced).toBeGreaterThan(0);
      expect(held).toBeGreaterThanOrEqual(osBytes);
      for (const t of [T + 5_000, T + MINUTE, T + MINUTE + 1, T + 5_000 + MINUTE - 1]) { // past T + 60 s: a charge dated at T would be gone
        expect(revokeBudget.revokeBytesWritten(t)).toBe(held);
        expect(revokeBudget.revokePacedBytes(t)).toBe(paced);
      }
      expect(revokeBudget.revokeBytesWritten(T + 5_000 + MINUTE)).toBe(0); // and all of it together after
      expect(revokeBudget.revokePacedBytes(T + 5_000 + MINUTE)).toBe(0);
    } finally { fx.close(); }
  });

  it("fail closed: an unmeasurable transaction holds the pace at rows x W and waits; its unprovable copy is dated at the bound, ages, and it runs again", () => {
    const fx = storm(500);
    try {
      let now = 1_000_000;
      setRevokeBudgetClock(() => now); resetRevokeWriteBudget();
      fx.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0");
      flipAll(fx);
      revokeBudget.revokePaceTestHooks.unmeasurable = true;
      const charged0 = meter("charged");
      const pending = drainRevokeMarkerBounded(fx.db, { rows: 256, ms: 1_000_000 });
      const paced = revokeBudget.revokePacedBytes(now), rows = (meter("charged") - charged0) / revokeBudget.revokeCostPerChange(fx.db);
      console.log(`IODRAIN FAILCLOSED platform=${process.platform} paced=${paced} rows=${rows} measured=${meter("paceMeasured")} unmeasured=${meter("paceUnmeasured")}`);
      expect(pending).toBe(true);
      expect(meter("paceMeasured")).toBe(0);
      expect(paced).toBeGreaterThanOrEqual(Math.floor(2 * rows * revokeBudget.revokeChangeCeiling(fx.db))); // its full slice: frames and copy at the ceiling
      expect(revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db), now)).toBeGreaterThan(0); // and it waits
      const slices = meter("slices");
      expect(drainRevokeMarkerBounded(fx.db, { rows: 256, ms: 1_000_000 })).toBe(true);
      expect(meter("slices")).toBe(slices); // nothing admitted while the pace is full
      // r3.6c: its copy half cannot be proven (nothing is readable), so it stays debt until the bound, then is dated without proof (its copy
      // minute) and kept as a late copy; nothing waits for ever
      const T = now, W = revokeBudget.revokeChangeCeiling(fx.db);
      now = T + revokeBudget.COPY_PROOF_MAX_MS - 1;
      expect(revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db), now)).toBeGreaterThan(0);
      const held = revokeBudget.revokeOutstandingCopyBytes();
      expect(held).toBeGreaterThanOrEqual(Math.floor(rows * W)); // the copy half at rows x W
      now = T + revokeBudget.COPY_PROOF_MAX_MS;
      expect(revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db), now)).toBeGreaterThan(0); // its copy minute holds the pace
      expect(revokeBudget.revokeOutstandingCopyBytes()).toBe(0);
      expect(meter("copiesLapsed")).toBe(held);
      expect(revokeBudget.revokeLateCopyBytes()).toBe(held);
      expect(revokeBudget.revokePacedBytes(now)).toBeGreaterThanOrEqual(held);
      now += MINUTE + 1;
      expect(revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db), now)).toBe(0); // no permanent stall
      drainRevokeMarkerBounded(fx.db, { rows: 256, ms: 1_000_000 });
      expect(meter("slices")).toBeGreaterThan(slices);
      // readable again: the drain's own copy proves the log copied and lands the late copies, charged now; a minute later it has aged
      revokeBudget.revokePaceTestHooks.unmeasurable = false;
      revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db), now);
      expect(revokeBudget.revokeOutstandingCopyBytes()).toBe(0);
      expect(revokeBudget.revokeLateCopyBytes()).toBe(0);
      expect(meter("copiesLanded")).toBeGreaterThanOrEqual(held);
      now += MINUTE + 1;
      // the same slice measured (hooks off) holds the pace at what it measurably wrote, less than its full slice
      const c1 = meter("charged");
      drainRevokeMarkerBounded(fx.db, { rows: 256, ms: 1_000_000 });
      const measuredRows = (meter("charged") - c1) / revokeBudget.revokeCostPerChange(fx.db);
      expect(meter("paceMeasured")).toBeGreaterThan(0);
      expect(revokeBudget.revokePacedBytes(now)).toBeLessThan(2 * measuredRows * revokeBudget.revokeChangeCeiling(fx.db));
    } finally { fx.close(); }
  });

  it("M3 real minutes: the production checkpointer thread and the production io reader over 130 s of wall clock; the paced drain trips neither minute", async () => {
    const fx = storm(2000);
    const file = dbFile(fx.db);
    try {
      setRevokeBudgetClock(); resetRevokeWriteBudget(); // the wall clock
      fx.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
      maintenance.startWalMaintenance(file, { setAutocheckpoint: pages => fx.db.exec(`PRAGMA wal_autocheckpoint=${pages}`), nudge: async () => false });
      for (let n = 0; !maintenance.walMaintenanceReady() && n < 200; n++) await new Promise(r => setTimeout(r, 25));
      expect(maintenance.walMaintenanceReady()).toBe(true); // the production checkpointer thread is up before the minutes are judged
      const budget = new IoBudget({ read: readProcess, log: () => {}, onScale: () => {}, isIdle: () => true, systemOverloaded: () => null });
      budget.registerByteSource("database:messages.db", walFrameReader(file));
      flipAll(fx);
      budget.tick();
      const verdicts: Array<{ counted: number; tripped: boolean; slices: number }> = [];
      const copied0 = meter("copiesSettled");
      let minuteSlices = 0;
      const start = Date.now();
      let nextSample = start + MINUTE, pending = true, slices = 0;
      while (verdicts.length < 2) {
        if (pending) {
          const s0 = meter("slices");
          pending = drainRevokeMarkerBounded(fx.db, { rows: 1_000_000, ms: 50 });
          slices += meter("slices") - s0; minuteSlices += meter("slices") - s0;
          void maintenance.checkpointPassive();
        }
        const wait = pending ? revokeBudget.revokeWriteWaitMs(revokeBudget.revokeSliceNeed(fx.db)) : nextSample - Date.now();
        await new Promise(r => setTimeout(r, Math.max(5, Math.min(wait, nextSample - Date.now()))));
        if (Date.now() >= nextSample) { const v = budget.tick()!; verdicts.push({ counted: v.writeBytesPerMinute, tripped: v.tripped, slices: minuteSlices }); minuteSlices = 0; nextSample += MINUTE; }
      }
      console.log(`IODRAIN M3 platform=${process.platform} slices=${slices} pending=${pending} minutes=${verdicts.map(v => `${fmt(v.counted)}/${v.tripped}`).join(",")} paced=${fmt(meter("paceMeasured"))} wallS=${Math.round((Date.now() - start) / 1000)}`);
      expect(slices).toBeGreaterThan(0);
      for (const v of verdicts) { expect(v.tripped).toBe(false); expect(v.slices, "progress in every minute").toBeGreaterThan(0); }
      expect(meter("copiesSettled") - copied0, "the drain's frames were proven copied and the pace saw it").toBeGreaterThan(0);
    } finally { await maintenance.stopWalMaintenance(); fx.close(); }
  }, 400_000);
});
