// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: idle admission of an owed capture (carried copy debt, the captures' own settled bytes, a rolled-back grant): cause-idlecap (this
// file; io-budget.ts admit/backgroundRoom/finishGrant). Ledger and native grant: scperf-p1. Copy admission on the checkpointer: walseam.
// MAIN 2026-11-22 idle-capture + PERF-PRODUCT-ADDENDUM 17:14Z: on an idle server three owed captures landed and then none. Each landed
// capture left copy debt that no idle minute paid, the debt was counted against the idle allowance of every later capture until the ticket
// was smaller than one commit, the native grant refused it mid-commit, and the rolled-back bytes were charged anyway.
// Every row here enters through the production write path: a real database handle under instrumentDatabase (beforeWrite -> admit -> the
// native grant -> finishGrant -> settle), a real IoBudget, the real meter addon built from native/.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { forgetExclusionAddon } from "./engine-exclusion.ts";
import * as meter from "./io-meter.ts";
import { BG_MINUTE_BYTES, BLOCK_BYTES, IoBudget, instrumentDatabase, isBgDeferred, IO_BUDGET_IDLE_BYTES_PER_MINUTE, plannedWrites, RECALL_RECLAIM_SOURCE } from "./io-budget.ts";
import { DatabaseSync } from "./sqlite-open.ts";
import type { IoSample } from "../shared/health-protocol.mjs";

const MINUTE = 60_000, START = 700 * MINUTE, MB = 1024 * 1024;
const IDLE_ROOM = IO_BUDGET_IDLE_BYTES_PER_MINUTE - 65536;
/** An active minute's total write ceiling (io-budget.ts admit: total+writes+ceiling <= 49 MiB). */
const ACTIVE_TOTAL = 49 * MB;
/** Recall upkeep at the rate the 1.0.21 idle rig measured: 3.9 MB a minute. */
const UPKEEP_PER_MINUTE = Math.round(3.9 * MB);
/** One capture's row: about 32 log frames, the size of the rig's capture transaction (PFDIAG: 34 frames, 139264 bytes of copy debt). */
const CAPTURE_BLOB = 126_000;
const root = mkdtempSync(join(tmpdir(), "idle-capture-fixture-"));
const prior = process.env.MURAGE_ENGINE_EXCLUSION_PATH;
let serial = 0;
beforeAll(() => {
 const binary = join(root, "meter.node");
 execFileSync("cc", ["-std=c11", "-D_GNU_SOURCE", "-O2", "-Wall", "-Werror", "-fPIC", "-shared", "-DNAPI_VERSION=9", "-I", resolve(dirname(process.execPath), "../include/node"), "native/engine-exclusion/exclusion.c", "native/engine-exclusion/meter.c", "-o", binary], { stdio: "pipe" });
 process.env.MURAGE_ENGINE_EXCLUSION_PATH = binary;
 forgetExclusionAddon(); meter.resetIoMeterForTest();
});
afterAll(() => {
 if (prior === undefined) delete process.env.MURAGE_ENGINE_EXCLUSION_PATH; else process.env.MURAGE_ENGINE_EXCLUSION_PATH = prior;
 forgetExclusionAddon(); meter.resetIoMeterForTest();
 rmSync(root, { recursive: true, force: true });
});

/** An idle server: the budget's clock and process counters are the test's (cumulative, as the process reads them), the database is real. */
function idleServer(pageSize = 4096) {
 let at = START, os = 0, idle = true;
 const lines: string[] = [], samples: IoSample[] = [];
 // The capture's own writes are counted by the real meter as they happen (io-meter.ts, the count readProcess reads); `os` adds the
 // writes the fixture makes outside the database (each server counts from its own start). Both counters read the same total, as on a platform whose OS count is the meter's.
 const meterTotal = () => meter.ioMeterSnapshot()?.total ?? 0, meterAtStart = meterTotal();
 const metered = () => os + meterTotal() - meterAtStart;
 const budget = new IoBudget({ read: () => { const total = metered(); return { at, fsWriteBlocks: total / BLOCK_BYTES, cpuMicros: 0, meterBytes: total } as never; }, isIdle: () => idle, systemOverloaded: () => null, log: line => { lines.push(line); }, onSample: sample => { samples.push(sample); } });
 const db = new DatabaseSync(join(root, `idle-${++serial}.db`));
 db.exec(`PRAGMA page_size=${pageSize}; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE captured(n INTEGER PRIMARY KEY, body BLOB)`);
 const release = instrumentDatabase(db, budget);
 let n = 0;
 return {
  budget, db, lines, samples, metered,
  clock: (next: number) => { at = next; },
  idle: (next: boolean) => { idle = next; },
  /** The minute tick, as the server's timer runs it (IoBudget.tick): the watchdog's verdict on the window since the last tick. */
  tick: (next: number) => { at = next; return budget.tick(); },
  /** The watchdog's over-budget lines so far (io-budget.ts tick: "[io-budget] writing N MB/min (budget B...)"). */
  overBudget: () => lines.filter(line => line.startsWith("[io-budget] writing ")),
  /** Bytes the process wrote outside the capture: observed by both counters, attributed through the production feed (noteBytes). */
  wrote: (source: string, bytes: number) => { os += bytes; budget.noteBytes(source, bytes); },
  /** One owed capture, as the memory worker runs it: one write under the memory-capture source. False when it is deferred. */
  capture: (blob = CAPTURE_BLOB): boolean => {
   try { budget.withSource("memory-capture", () => db.exec(`INSERT INTO captured VALUES(${++n}, zeroblob(${blob}))`)); return true; }
   catch (error) { if (isBgDeferred(error)) { n--; return false; } throw error; }
  },
  rows: () => Number(db.prepare("SELECT count(*) AS n FROM captured").get()?.n),
  close: () => { release(); db.close(); },
 };
}

/** `minutes` minutes from minute `from` with planned recall upkeep running; `perMinute` captures fall due evenly in each, and a deferred
 *  capture is kept and retried at the next due time (never dropped). `owed` carries captures deferred earlier. Returns what is still owed. */
function upkeepMinutes(server: ReturnType<typeof idleServer>, from: number, minutes: number, perMinute: number, owed = 0): number {
 for (let minute = from; minute < from + minutes; minute++) {
  for (let k = 0; k < perMinute; k++) {
   server.clock(START + minute * MINUTE + 2000 + k * Math.floor(50_000 / perMinute));
   server.wrote(RECALL_RECLAIM_SOURCE, Math.round(UPKEEP_PER_MINUTE / perMinute));
   owed++;
   while (owed > 0 && server.capture()) owed--;
  }
 }
 return owed;
}
/** The next ACTIVE minute: a turn or the owner made it active. Every capture still owed is retried once a second until none is left.
 *  `checkpoint`: at the minute's end the checkpointer reports a complete copy and log restart, as wal-maintenance.ts:868 does after its
 *  copy (io-budget.ts backfilled), so the copy debt moves into that minute and the next active minute starts without it. */
function activeDrain(server: ReturnType<typeof idleServer>, minute: number, owed: number, checkpoint = false): number {
 server.idle(false);
 for (let second = 2; owed > 0 && second < 54; second++) {
  server.clock(START + minute * MINUTE + second * 1000);
  while (owed > 0 && server.capture()) owed--;
 }
 if (checkpoint) { server.clock(START + minute * MINUTE + 55_000); server.budget.backfilled({ salt: `restart-${minute}`, frame: 0, complete: true }); }
 return owed;
}

// CHANGED-EXPECTATION (MAIN-RULING 2026-11-25T05:54:59Z idle DO LESS, 11:49:12Z rewrite; was: every owed capture lands on the idle
// minutes): (a) on the idle minutes no capture is admitted and nothing is written; (b) on the next ACTIVE minute every owed capture lands
// exactly once (the rows are numbered: none lost, none doubled), and the copy debt they leave is still carried on the ledger.
it("WITNESS 1/min: ten idle minutes with recall upkeep running, one owed capture a minute: none lands while idle, every capture lands once on the next active minute", () => {
 const server = idleServer();
 try {
  const owed = upkeepMinutes(server, 0, 10, 1);
  expect({ rows: server.rows(), owed, debt: server.budget.admissionState().debt }, "idle DO LESS: ten idle minutes admit no capture and write no copy debt").toEqual({ rows: 0, owed: 10, debt: 0 });
  expect(activeDrain(server, 10, owed), "the next active minute drains every owed capture").toBe(0);
  expect(server.rows(), "captures landed of 10 sent at 1 a minute").toBe(10);
  expect(Number(server.db.prepare("SELECT max(n) AS n FROM captured").get()?.n), "each capture landed exactly once").toBe(10);
  // the copy debt is still carried (nothing here pays it): it is not hidden
  expect(server.budget.admissionState().debt, "carried copy debt stays on the ledger").toBeGreaterThan(3 * 100_000);
 } finally { server.close(); }
});

it("WITNESS 4/min: twenty-five idle minutes, four owed captures a minute: none lands while idle, every capture lands once on the next active minutes (40/40, 100/100)", () => {
 const server = idleServer();
 try {
  let owed = upkeepMinutes(server, 0, 10, 4);
  expect({ rows: server.rows(), owed }, "idle DO LESS: no capture lands in ten idle minutes").toEqual({ rows: 0, owed: 40 });
  // (the first active minute lands what the BG minute ceiling holds beside their copy debt; the checkpointer pays that debt at its end)
  for (let minute = 10; owed > 0 && minute < 13; minute++) owed = activeDrain(server, minute, owed, true);
  expect(owed, "the next active minutes drain the 40 owed captures").toBe(0);
  expect(server.rows(), "captures landed of 40 sent at 4 a minute in ten idle minutes").toBe(40);
  server.idle(true);
  owed = upkeepMinutes(server, 11, 15, 4);
  expect({ rows: server.rows(), owed }, "idle DO LESS: fifteen more idle minutes land nothing").toEqual({ rows: 40, owed: 60 });
  for (let minute = 26; owed > 0 && minute < 30; minute++) owed = activeDrain(server, minute, owed, true);
  expect(server.rows(), "captures landed of 100 sent at 4 a minute in twenty-five idle minutes").toBe(100);
  expect(Number(server.db.prepare("SELECT max(n) AS n FROM captured").get()?.n), "each capture landed exactly once").toBe(100);
 } finally { server.close(); }
});

// CHANGED-EXPECTATION (idle DO LESS, 11:49:12Z; was: the idle ceiling admits the capture before an unplanned burst and the next idle minute
// admits it): (a) on the idle minute the capture is refused before AND after the burst, no other source writes, and the next idle minute
// still admits nothing; (b) on the next ACTIVE minute the deferred capture lands, once, and the next one lands too.
it("the idle ceiling stays: around an unplanned 4 MiB background write the owed capture is deferred while idle, and it lands once on the next active minute", () => {
 const server = idleServer();
 try {
  server.clock(START + 2000);
  expect(server.capture(), "idle DO LESS: before the burst the capture is deferred as well").toBe(false);
  server.wrote("perf-background", 4 * MB);
  server.clock(START + 4000);
  expect(server.capture(), "an unplanned 4 MiB write closes the idle minute to the capture").toBe(false);
  expect(server.rows()).toBe(0);
  // and no other background source is admitted while idle at all
  expect(() => server.budget.withSource("memory-worker", () => server.db.exec("INSERT INTO captured VALUES(900, zeroblob(100))")), "a non-capture background write stays refused while idle").toThrow(/BG_DEFERRED/);
  server.clock(START + MINUTE + 2000);
  expect(server.capture(), "idle DO LESS: the next idle minute admits nothing either").toBe(false);
  server.idle(false);
  server.clock(START + 2 * MINUTE + 2000);
  expect(server.capture(), "before the burst the capture lands").toBe(true);
  expect(server.rows()).toBe(1);
  expect(server.capture(), "the next active minute admits the next one").toBe(true);
  expect(server.rows()).toBe(2);
 } finally { server.close(); }
});

// idle DO LESS write gate (io-budget.ts instrumentDatabase beforeWrite, idleQuiet): on an idle minute a capture write is deferred to the next
// minute's look before any room or ticket is asked. Beside another holder's live reservation the admit path alone would answer a short-step
// reservation wait (refusalRetry), so an idle capture would retry every second all minute; the gate makes it wait for the minute. (Astra
// pre-check M2: the gate's own witness.) The next active minute lands it once.
it("the idle write gate: an idle capture beside a live reservation waits for the next minute's look, not a short-step retry, and lands once on the next active minute", () => {
 const server = idleServer();
 try {
  server.idle(false);
  server.clock(START + 2000);
  const live = server.budget.withSource("memory-worker", () => server.budget.admit("BG", 8192, 0))!;
  expect(live, "a reservation held from the active part of the minute").not.toBeNull();
  server.idle(true);
  server.clock(START + 3000);
  let refusal: unknown = null;
  try { server.budget.withSource("memory-capture", () => server.db.exec(`INSERT INTO captured VALUES(1, zeroblob(${CAPTURE_BLOB}))`)); } catch (error) { refusal = error; }
  const deferred = refusal as { retryInMs?: number; reservationWait?: boolean } | null;
  expect({ deferred: isBgDeferred(refusal), reservationWait: deferred?.reservationWait, retryInMs: deferred?.retryInMs, rows: server.rows() }, "idle DO LESS: the gate defers the idle capture to the next minute's look").toEqual({ deferred: true, reservationWait: false, retryInMs: server.budget.nextAdmissionMs(), rows: 0 });
  server.budget.settle(live, 0);
  server.idle(false);
  server.clock(START + MINUTE + 2000);
  expect(server.capture(), "the next active minute lands it").toBe(true);
  expect({ rows: server.rows(), last: Number(server.db.prepare("SELECT max(n) AS n FROM captured").get()?.n) }, "exactly once").toEqual({ rows: 1, last: 1 });
 } finally { server.close(); }
});

// CHANGED-EXPECTATION (idle DO LESS, 11:49:12Z; was: on an idle minute the native grant refuses a commit larger than its ticket and the
// rolled-back write charges nothing): (a) on the idle minute the capture is deferred before any ticket or byte (nothing is charged); (b) on
// the next ACTIVE minute, with unplanned writes leaving a ticket smaller than the commit, the native grant refuses inside the ticket, the
// rolled-back write charges nothing, and the minute after it the capture lands exactly once.
it("a refused, rolled-back write charges nothing: the ticket's bytes and copy debt are released and the next minute's capture lands", () => {
 const server = idleServer();
 try {
  server.clock(START + 2000);
  server.wrote("perf-background", IDLE_ROOM - 240_000);
  const idleBefore = server.budget.admissionState(), idleMetered = server.metered();
  expect(server.capture(), "idle DO LESS: the idle minute defers the capture before any ticket").toBe(false);
  const idleAfter = server.budget.admissionState();
  expect({ rows: server.rows(), wrote: server.metered() - idleMetered, bg: idleAfter.bg, debt: idleAfter.debt, reserved: idleAfter.reserved }, "the idle minute wrote and charged nothing").toEqual({ rows: 0, wrote: 0, bg: idleBefore.bg, debt: idleBefore.debt, reserved: 0 });
  server.idle(false);
  server.clock(START + MINUTE + 2000);
  // unplanned writes leave room for a ticket (above one commit's ceiling) that is smaller than this capture's commit
  server.wrote("perf-background", ACTIVE_TOTAL - 240_000);
  const before = server.budget.admissionState(), meteredBefore = server.metered();
  expect(server.budget.withSource("memory-capture", () => server.budget.backgroundRoom()), "a ticket is still offered").toBeGreaterThan(100_000);
  expect(server.capture(), "the native grant refuses the commit inside the ticket").toBe(false);
  expect(server.rows(), "the refused write rolled back").toBe(0);
  const after = server.budget.admissionState();
  // (the bytes the refused write did put on disk stay measured: the total grows by exactly what the meter counted, and by no charge)
  expect({ bg: after.bg, debt: after.debt, charged: after.total - before.total - (server.metered() - meteredBefore), reserved: after.reserved }, "a rolled-back write charges nothing").toEqual({ bg: before.bg, debt: before.debt, charged: 0, reserved: 0 });
  server.clock(START + 2 * MINUTE + 2000);
  expect(server.capture(), "the next active minute admits the capture").toBe(true);
  expect(server.rows()).toBe(1);
 } finally { server.close(); }
});

// MAIN-RULING 2026-11-22T18:25:43Z idle-owed-capture: owed capture bytes are planned up to the BG minute ceiling, by ONE definition
// (io-budget.ts plannedWrites) that the minute tick and idle admission both call. The rig's T1000 cell had every capture land and the
// tick still wrote one over-budget line: admission had let the captures in and the tick judged their bytes against the idle megabyte.
// CHANGED-EXPECTATION (idle DO LESS, 11:49:12Z; was: 100 owed captures land in ten idle minutes and no tick trips): (a) the ten idle
// minutes admit no capture and the tick, which excuses the planned upkeep, writes no over-budget line; (b) the next ACTIVE minutes land every
// owed capture exactly once and their ticks write no over-budget line either.
it("WITNESS tick agrees with admission: ten idle minutes, ten owed captures a minute with recall upkeep: none lands idle, all land once on the next active minutes and the tick writes no over-budget line", () => {
 const server = idleServer();
 try {
  server.tick(START);
  let owed = 0;
  const verdicts: boolean[] = [];
  for (let minute = 0; minute < 10; minute++) {
   for (let k = 0; k < 10; k++) {
    server.clock(START + minute * MINUTE + 2000 + k * 5000);
    server.wrote(RECALL_RECLAIM_SOURCE, Math.round(UPKEEP_PER_MINUTE / 10));
    owed++;
    while (owed > 0 && server.capture()) owed--;
   }
   verdicts.push(server.tick(START + (minute + 1) * MINUTE)!.tripped);
  }
  expect({ landed: server.rows(), owed, tripped: verdicts.filter(Boolean).length, overBudget: server.overBudget() }, "idle DO LESS: ten idle minutes land nothing and no minute is over budget").toEqual({ landed: 0, owed: 100, tripped: 0, overBudget: [] });
  for (let minute = 10; owed > 0 && minute < 16; minute++) {
   owed = activeDrain(server, minute, owed, true);
   verdicts.push(server.tick(START + (minute + 1) * MINUTE)!.tripped);
  }
  expect({ landed: server.rows(), tripped: verdicts.filter(Boolean).length, overBudget: server.overBudget() }, "100 owed captures land on the next active minutes and no minute is over budget").toEqual({ landed: 100, tripped: 0, overBudget: [] });
  expect(Number(server.db.prepare("SELECT max(n) AS n FROM captured").get()?.n), "each capture landed exactly once").toBe(100);
 } finally { server.close(); }
});

// CHANGED-EXPECTATION (idle DO LESS, 11:49:12Z; was: two owed captures land on the idle minute before the burst): (a) on the idle minute the
// owed captures are deferred before and after the burst, and the tick trips on exactly the unplanned bytes (the upkeep is planned, no capture
// wrote); (b) on the next ACTIVE minute the three deferred captures land exactly once.
it("the ceiling the tick and admission share stays: an unplanned 4 MiB write in a minute with owed captures defers the next capture AND trips the tick on exactly the unplanned bytes", () => {
 const server = idleServer();
 try {
  server.tick(START);
  server.clock(START + 2000);
  server.wrote(RECALL_RECLAIM_SOURCE, UPKEEP_PER_MINUTE);
  const before = server.metered();
  const landed = [server.capture(), server.capture()];
  const written = server.metered() - before;
  server.wrote("perf-background", 4 * MB);
  server.clock(START + 4000);
  const afterBurst = server.capture();
  const verdict = server.tick(START + MINUTE)!;
  // the tick takes off the upkeep and the bytes the landed captures wrote (none: idle DO LESS), and judges the rest: the 4 MiB burst, to the byte
  const text = `[io-budget] writing 4.0 MB/min (budget 1, ${((UPKEEP_PER_MINUTE + written) / MB).toFixed(1)} MB/min planned not counted)`;
  expect({ landed, written, afterBurst, tripped: verdict.tripped, judged: Math.round(verdict.writeBytesPerMinute), lines: server.overBudget().map(line => line.replace(/; source:.*$/, "")) }, "the unplanned burst is refused by admission and named by the tick").toEqual({ landed: [false, false], written: 0, afterBurst: false, tripped: true, judged: 4 * MB, lines: [text] });
  expect(activeDrain(server, 1, 3), "the next active minute drains the three deferred captures").toBe(0);
  expect({ rows: server.rows(), last: Number(server.db.prepare("SELECT max(n) AS n FROM captured").get()?.n) }, "each lands exactly once").toEqual({ rows: 3, last: 3 });
 } finally { server.close(); }
});

// CHANGED-EXPECTATION (idle DO LESS, 11:49:12Z; was: two IDLE admission minutes fill the window with owed captures that settle past one BG
// ceiling, judged = window - one ceiling): (a) the same two minutes while idle admit no capture and write nothing; (b) the same two minutes
// ACTIVE fill the window past the BG minute ceiling, and the tick, taken after the owner left (an idle verdict, judged against the idle
// megabyte as before), plans at most one ceiling of it. The exact "window - one ceiling" is not reachable in a one-minute window on active
// minutes (their captures carry the copy debt inside the ceiling, so they never settle past it); the cap is asserted on the one definition,
// plannedWrites, AND end to end through the tick in a half-minute active window whose landed captures settle past its ceiling (below).
it("owed capture bytes are planned only up to the BG minute ceiling: what two admission minutes write inside one tick window past 12 MiB is judged", () => {
 // 64 KiB pages, so that the BG minute ceiling (held on the ledger's charge) lets more than 6 MiB of capture bytes be written a minute
 const server = idleServer(65536);
 try {
  // (the ledger reads the database's creation in minute 0; the windows are in the minutes after it)
  server.clock(START + 1000);
  server.budget.admissionState();
  const windows = (from: number) => [[START + (from + 1) * MINUTE + 30_500, START + (from + 1) * MINUTE + 54_000], [START + (from + 2) * MINUTE + 500, START + (from + 2) * MINUTE + 29_500]];
  server.tick(START + MINUTE + 30_000);
  const idleFrom = server.metered();
  let refused = 0, attempts = 0;
  for (const [first, last] of windows(0)) for (let at = first; at <= last; at += 250) { server.clock(at); attempts++; if (!server.capture(120_000)) refused++; }
  server.tick(START + 2 * MINUTE + 30_000);
  expect({ rows: server.rows(), wrote: server.metered() - idleFrom, refused }, "idle DO LESS: the two idle minutes admit no capture and write nothing").toEqual({ rows: 0, wrote: 0, refused: attempts });
  server.idle(false);
  server.tick(START + 3 * MINUTE + 30_000);
  const from = server.metered();
  let n = 0, owed = attempts, own = 0, sent = attempts;
  // two ACTIVE admission minutes inside ONE tick window, each filled with owed captures up to the BG minute ceiling (the idle minutes'
  // deferred captures first, then new ones as they fall due); `own` is what the landed captures wrote, as the meter counted it
  for (const [first, last] of windows(2)) {
   for (let at = first; at <= last; at += 250) {
    server.clock(at);
    owed++; sent++;
    const before = server.metered();
    if (server.capture(120_000)) { n++; owed--; own += server.metered() - before; }
   }
  }
  server.idle(true);
  const verdict = server.tick(START + 4 * MINUTE + 30_000)!;
  // the window holds more than one BG minute ceiling; on ACTIVE minutes the carried copy debt counts against the captures' ceiling (admit's
  // BG clause), so what they settle stays inside it: all of it is planned, never more than one ceiling, and the rest is judged
  const window = server.metered() - from, sample = server.samples.at(-1)!;
  expect(window, `the fixture's owed captures write more than one BG minute ceiling inside the window (${n} captures)`).toBeGreaterThan(BG_MINUTE_BYTES + 2 * MB);
  // exactly what the landed captures wrote is planned (never more than one ceiling), and everything else in the window is judged
  expect({ tripped: verdict.tripped, planned: sample.plannedBytesAllowed, judged: Math.round(verdict.writeBytesPerMinute) }, "bytes past the BG minute ceiling are not planned").toEqual({ tripped: true, planned: Math.min(BG_MINUTE_BYTES, own), judged: window - Math.min(BG_MINUTE_BYTES, own) });
  // the one definition both read (io-budget.ts plannedWrites) still plans owed capture bytes past the ceiling as exactly one ceiling
  expect(plannedWrites(1, () => 0, BG_MINUTE_BYTES + 2 * MB, null, Infinity, () => 0).planned, "owed bytes past the ceiling are not planned").toBe(BG_MINUTE_BYTES);
  // every capture still owed (deferred on the idle minutes or in the window) lands on the next active minutes, each exactly once
  for (let minute = 5; owed > 0 && minute < 60; minute++) owed = activeDrain(server, minute, owed, true);
  expect({ owed, rows: server.rows(), last: Number(server.db.prepare("SELECT max(n) AS n FROM captured").get()?.n) }, "each owed capture landed exactly once").toEqual({ owed: 0, rows: sent, last: sent });
  // END TO END, the tick applies the cap on ACTIVE minutes (ASTRA 45a7d55227 :311). An active admission minute lands at most about half a BG
  // ceiling of capture bytes (each capture's copy debt counts against the same ceiling, 1:1), so a one-minute window can never hold more
  // than one ceiling of them. In a half-minute tick window across a minute boundary, with the checkpointer's report between the two
  // admission minutes (a complete copy moves the first minute's debt into it), the captures that land write past the tick's ceiling for
  // that window (BG_MINUTE_BYTES x 0.5): the tick plans exactly that ceiling, and the rest of the window is judged.
  const half = { from: START + 70 * MINUTE + 45_000, to: START + 71 * MINUTE + 15_000 };
  server.idle(false);
  server.tick(half.from);
  const halfFrom = server.metered();
  let halfOwn = 0, landed = 0;
  for (let at = half.from + 500; at < half.to; at += 250) {
   if (at >= START + 71 * MINUTE && at - 250 < START + 71 * MINUTE) { server.clock(START + 70 * MINUTE + 59_900); server.budget.backfilled({ salt: "restart-70", frame: 0, complete: true }); }
   server.clock(at);
   owed++; sent++;
   const before = server.metered();
   if (server.capture(120_000)) { landed++; owed--; halfOwn += server.metered() - before; }
  }
  server.idle(true);
  const halfVerdict = server.tick(half.to)!;
  const halfWindow = server.metered() - halfFrom, halfCeiling = BG_MINUTE_BYTES / 2, halfSample = server.samples.at(-1)!;
  expect(halfOwn, `the landed captures write past the half-minute window's BG ceiling (${landed} captures)`).toBeGreaterThan(halfCeiling + 2 * MB);
  expect({ tripped: halfVerdict.tripped, planned: halfSample.plannedBytesAllowed, judged: Math.round(halfVerdict.writeBytesPerMinute) }, "the tick plans owed capture bytes only up to its BG ceiling and judges the rest").toEqual({ tripped: true, planned: halfCeiling, judged: Math.round((halfWindow - halfCeiling) / 0.5) });
  // and every capture still owed lands once on the next active minutes
  for (let minute = 72; owed > 0 && minute < 120; minute++) owed = activeDrain(server, minute, owed, true);
  expect({ owed, rows: server.rows(), last: Number(server.db.prepare("SELECT max(n) AS n FROM captured").get()?.n) }, "each owed capture landed exactly once").toEqual({ owed: 0, rows: sent, last: sent });
 } finally { server.close(); }
});
