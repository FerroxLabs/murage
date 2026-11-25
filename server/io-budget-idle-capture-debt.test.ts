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
import { BG_MINUTE_BYTES, BLOCK_BYTES, IoBudget, instrumentDatabase, isBgDeferred, IO_BUDGET_IDLE_BYTES_PER_MINUTE, RECALL_RECLAIM_SOURCE } from "./io-budget.ts";
import { DatabaseSync } from "./sqlite-open.ts";

const MINUTE = 60_000, START = 700 * MINUTE, MB = 1024 * 1024;
const IDLE_ROOM = IO_BUDGET_IDLE_BYTES_PER_MINUTE - 65536;
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
 const lines: string[] = [];
 // The capture's own writes are counted by the real meter as they happen (io-meter.ts, the count readProcess reads); `os` adds the
 // writes the fixture makes outside the database (each server counts from its own start). Both counters read the same total, as on a platform whose OS count is the meter's.
 const meterTotal = () => meter.ioMeterSnapshot()?.total ?? 0, meterAtStart = meterTotal();
 const metered = () => os + meterTotal() - meterAtStart;
 const budget = new IoBudget({ read: () => { const total = metered(); return { at, fsWriteBlocks: total / BLOCK_BYTES, cpuMicros: 0, meterBytes: total } as never; }, isIdle: () => idle, systemOverloaded: () => null, log: line => { lines.push(line); } });
 const db = new DatabaseSync(join(root, `idle-${++serial}.db`));
 db.exec(`PRAGMA page_size=${pageSize}; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE captured(n INTEGER PRIMARY KEY, body BLOB)`);
 const release = instrumentDatabase(db, budget);
 let n = 0;
 return {
  budget, db, lines, metered,
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

/** `minutes` idle minutes with planned recall upkeep running; `perMinute` captures fall due evenly in each, and a deferred capture is kept
 *  and retried at the next due time (never dropped). Returns how many captures were sent. */
function idleMinutes(server: ReturnType<typeof idleServer>, minutes: number, perMinute: number): number {
 let owed = 0;
 for (let minute = 0; minute < minutes; minute++) {
  for (let k = 0; k < perMinute; k++) {
   server.clock(START + minute * MINUTE + 2000 + k * Math.floor(50_000 / perMinute));
   server.wrote(RECALL_RECLAIM_SOURCE, Math.round(UPKEEP_PER_MINUTE / perMinute));
   owed++;
   while (owed > 0 && server.capture()) owed--;
  }
 }
 return minutes * perMinute;
}

it("WITNESS 1/min: ten idle minutes with recall upkeep running, one owed capture a minute, every capture lands", () => {
 const server = idleServer();
 try {
  const sent = idleMinutes(server, 10, 1);
  expect(server.rows(), "captures landed of 10 sent at 1 a minute").toBe(sent);
  // the copy debt is still carried (nothing here pays it): it is not hidden, it only no longer shrinks an idle capture's ceiling
  expect(server.budget.admissionState().debt, "carried copy debt stays on the ledger").toBeGreaterThan(3 * 100_000);
 } finally { server.close(); }
});

it("WITNESS 4/min: twenty-five idle minutes, four owed captures a minute, every capture lands (40/40 by minute ten, 100/100 at the end)", () => {
 const server = idleServer();
 try {
  expect(idleMinutes(server, 10, 4)).toBe(40);
  expect(server.rows(), "captures landed of 40 sent at 4 a minute in ten idle minutes").toBe(40);
  // carried on past the point where the unpaid copy debt alone is larger than the whole background minute (12 MiB)
  for (let minute = 10; minute < 25; minute++) for (let k = 0; k < 4; k++) {
   server.clock(START + minute * MINUTE + 2000 + k * 12_500);
   server.wrote(RECALL_RECLAIM_SOURCE, Math.round(UPKEEP_PER_MINUTE / 4));
   server.capture();
  }
  expect(server.rows(), "captures landed of 100 sent at 4 a minute in twenty-five idle minutes").toBe(100);
 } finally { server.close(); }
});

it("the idle ceiling stays: after an unplanned 4 MiB background write the owed capture is deferred, and it lands in the next minute", () => {
 const server = idleServer();
 try {
  server.clock(START + 2000);
  expect(server.capture(), "before the burst the capture lands").toBe(true);
  server.wrote("perf-background", 4 * MB);
  server.clock(START + 4000);
  expect(server.capture(), "an unplanned 4 MiB write closes the idle minute to the capture").toBe(false);
  expect(server.rows()).toBe(1);
  // and no other background source is admitted while idle at all
  expect(() => server.budget.withSource("memory-worker", () => server.db.exec("INSERT INTO captured VALUES(900, zeroblob(100))")), "a non-capture background write stays refused while idle").toThrow(/BG_DEFERRED/);
  server.clock(START + MINUTE + 2000);
  expect(server.capture(), "the next idle minute admits it").toBe(true);
  expect(server.rows()).toBe(2);
 } finally { server.close(); }
});

it("a refused, rolled-back write charges nothing: the ticket's bytes and copy debt are released and the next minute's capture lands", () => {
 const server = idleServer();
 try {
  server.clock(START + 2000);
  // unplanned writes leave room for a ticket (above one commit's ceiling) that is smaller than this capture's commit
  server.wrote("perf-background", IDLE_ROOM - 240_000);
  const before = server.budget.admissionState(), meteredBefore = server.metered();
  expect(server.budget.withSource("memory-capture", () => server.budget.backgroundRoom()), "a ticket is still offered").toBeGreaterThan(100_000);
  expect(server.capture(), "the native grant refuses the commit inside the ticket").toBe(false);
  expect(server.rows(), "the refused write rolled back").toBe(0);
  const after = server.budget.admissionState();
  // (the bytes the refused write did put on disk stay measured: the total grows by exactly what the meter counted, and by no charge)
  expect({ bg: after.bg, debt: after.debt, charged: after.total - before.total - (server.metered() - meteredBefore), reserved: after.reserved }, "a rolled-back write charges nothing").toEqual({ bg: before.bg, debt: before.debt, charged: 0, reserved: 0 });
  server.clock(START + MINUTE + 2000);
  expect(server.capture(), "the next idle minute admits the capture").toBe(true);
  expect(server.rows()).toBe(1);
 } finally { server.close(); }
});

// MAIN-RULING 2026-11-22T18:25:43Z idle-owed-capture: owed capture bytes are planned up to the BG minute ceiling, by ONE definition
// (io-budget.ts plannedWrites) that the minute tick and idle admission both call. The rig's T1000 cell had every capture land and the
// tick still wrote one over-budget line: admission had let the captures in and the tick judged their bytes against the idle megabyte.
it("WITNESS tick agrees with admission: ten idle minutes, ten owed captures a minute with recall upkeep, all land and the tick writes no over-budget line", () => {
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
  expect({ landed: server.rows(), tripped: verdicts.filter(Boolean).length, overBudget: server.overBudget() }, "100 owed captures land in ten idle minutes and no minute is over budget").toEqual({ landed: 100, tripped: 0, overBudget: [] });
 } finally { server.close(); }
});

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
  // the tick takes off the upkeep and the bytes the two landed captures wrote, and judges the rest: the 4 MiB burst, to the byte
  const text = `[io-budget] writing 4.0 MB/min (budget 1, ${((UPKEEP_PER_MINUTE + written) / MB).toFixed(1)} MB/min planned not counted)`;
  expect({ landed, afterBurst, tripped: verdict.tripped, judged: Math.round(verdict.writeBytesPerMinute), lines: server.overBudget().map(line => line.replace(/; source:.*$/, "")) }, "the unplanned burst is refused by admission and named by the tick").toEqual({ landed: [true, true], afterBurst: false, tripped: true, judged: 4 * MB, lines: [text] });
 } finally { server.close(); }
});

it("owed capture bytes are planned only up to the BG minute ceiling: what two admission minutes write inside one tick window past 12 MiB is judged", () => {
 // 64 KiB pages, so that the BG minute ceiling (held on the ledger's charge) lets more than 6 MiB of capture bytes be written a minute
 const server = idleServer(65536);
 try {
  // (the ledger reads the database's creation in minute 0; the windows are in the two minutes after it)
  server.clock(START + 1000);
  server.budget.admissionState();
  server.tick(START + MINUTE + 30_000);
  const from = server.metered();
  let n = 0;
  // two idle admission minutes inside ONE tick window, each filled with owed captures up to the BG minute ceiling
  for (const [first, last] of [[START + MINUTE + 30_500, START + MINUTE + 54_000], [START + 2 * MINUTE + 500, START + 2 * MINUTE + 29_500]]) {
   for (let at = first; at <= last; at += 250) {
    server.clock(at);
    if (server.capture(120_000)) n++;
   }
  }
  const verdict = server.tick(START + 2 * MINUTE + 30_000)!;
  // (the owed captures alone wrote more than the ceiling, so exactly one ceiling is planned, whatever else the window holds)
  const window = server.metered() - from;
  expect(window, `the fixture's owed captures write more than one BG minute ceiling inside the window (${n} captures)`).toBeGreaterThan(BG_MINUTE_BYTES + 2 * MB);
  expect({ tripped: verdict.tripped, judged: Math.round(verdict.writeBytesPerMinute) }, "bytes past the BG minute ceiling are not planned").toEqual({ tripped: true, judged: window - BG_MINUTE_BYTES });
 } finally { server.close(); }
});
