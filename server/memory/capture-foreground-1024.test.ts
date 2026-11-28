// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owners: lane q1024-memcapture owns these witnesses and the rule they pin (io-budget.ts CAPTURE_FOREGROUND_SLICE_BYTES: capture runs at
// foreground priority); io-budget.ts (scperf-p1) owns the ledger; worker-controller.ts owns the worker's tick, claim and publication.
//
// 1.0.24 memory swarm cause C (field, 1.0.23: "[memory-worker] subsystem=capture cause=BG_DEFERRED count=7027 since=<14 h earlier>" while
// the start-up deletion pass and search.db writes spent each minute's allowance). MAIN 2026-11-27: "Capture must never starve: owner/bot
// requested captures run at foreground priority ... the start-up deletion pass and search.db writes must not crowd it out (capture
// backlog drains within minutes of start)". Base: the capture waited out BG_MAX_DEFERRAL_MS (ten minutes) and then shared one 4 MiB
// relief grant a minute with every other background family.
//
// The harness is the one of capture-bounded-deferral-1022.test.ts: real MemoryWorkerController (start, timer, tick, claim, publication),
// real database, the real gate (instrumentDatabase beforeWrite -> IoBudget.admit), real background writes spending every minute before
// the worker's timer fires. Stand-ins (not under test): the helper process answers a capture with the leased text as one chunk; vitest's clock.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isBgDeferred } from "../bg-admission.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ioBudget } from "../io-budget.ts";
import { appendMessage } from "../message-db.ts";
import { resetObserveWindows, setObserveSink } from "../observe.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { resetMemoryClaimCursor } from "./jobs.ts";
import { resetParkSweep } from "./park.ts";
import { setMemoryMode } from "./repository.ts";
import { settleFixtureIndexGrant } from "./testing/helper-permits.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import { resetWorkerLog } from "./worker-log.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import type { MemoryWork } from "./worker-protocol.ts";

// the design numbers, literal: a regression of the constant is a failure here, not a moved goalpost
// MAIN ruling 2026-11-24T22:25:23Z (one relief door): a lane enters the relief queue once it has been refused for ten minutes
const MAX_DEFERRAL_MINUTES = 10;
type Internals = { child: unknown; ready: boolean; work: MemoryWork | null; onWorkerMessage(child: unknown, message: unknown): void };
let controller: MemoryWorkerController, internals: Internals, sent: Array<Record<string, any>>, lines: string[];
const resultFor = (work: MemoryWork) => ({ type: "result", result: { id: work.id, leaseGeneration: work.leaseGeneration, status: "complete", nextCursor: work.totalBytes, chunks: [{ text: work.text, startByte: 0, endByte: Buffer.byteLength(work.text) }] } });

beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); resetParkSweep(); resetMemoryClaimCursor();
  sent = []; lines = []; resetWorkerLog(); resetObserveWindows(); setObserveSink(line => lines.push(line));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "Date"] });
  // one second into a fresh minute (a different hour for every test: the ledger's minute never repeats)
  vi.setSystemTime(Math.ceil((Date.now() + 3_600_000) / 3_600_000) * 3_600_000 + 1_000);
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  vi.spyOn(console, "warn").mockImplementation(() => {});
  (ioBudget as unknown as { resetBgRelief?: () => void }).resetBgRelief?.();
  controller = new MemoryWorkerController();
  internals = controller as unknown as Internals;
  internals.child = { kill() {}, on() {}, send: (message: any) => {
    sent.push(message);
    settleFixtureIndexGrant(message, event => internals.onWorkerMessage(internals.child, event)); /* index batches run on relief since round 2: the stand-in acknowledges them, as the helper does */ if (message.type === "index") setTimeout(() => internals.onWorkerMessage(internals.child, { type: "index-result", requestId: message.requestId, records: message.records.map((record: any) => ({ id: record.id, version: record.version, deleted: record.deleted })), embeddingStatus: "indexed" }), 10);
    // the helper's answer to a capture: the leased text as one chunk, a moment later
    if (message.stage === "capture") setTimeout(() => internals.onWorkerMessage(internals.child, resultFor(message as MemoryWork)), 10);
  } };
  internals.ready = true;
});
afterEach(async () => {
  ioBudget.setIsIdle(() => false);
  // the stand-in never exits: the controller lets go of it before its stop, on the real clock
  vi.useRealTimers(); internals.child = null; internals.work = null;
  await controller.stop().catch(() => {});
  vi.restoreAllMocks(); setObserveSink(); closeDatabase();
});

/** The load table. The log's checkpointer thread is stopped first: it shares the admission ledger and reads the real clock, and this
 *  test's minutes are vitest's (two clocks would roll the ledger's minute at every step). */
async function loadTable(): Promise<void> {
  database().exec("CREATE TABLE IF NOT EXISTS w1022_background_load(id INTEGER PRIMARY KEY, b BLOB)");
  const stopped = stopWalMaintenance();
  await vi.advanceTimersByTimeAsync(2_000);
  await stopped;
}
const jobs = () => database().prepare("SELECT status FROM memory_jobs ORDER BY rowid").all().map(row => String(row.status));
/** One background write through the gate, as a consolidation or maintenance slice makes it. True when the gate let it commit. */
function backgroundWrite(bytes: number): boolean {
  try { ioBudget.withSource("memory-idle", () => { database().prepare("INSERT INTO w1022_background_load(b) VALUES(zeroblob(?))").run(bytes); }); return true; }
  catch (error) { if (isBgDeferred(error)) return false; throw error; }
}
/** Background load: slices write until the gate refuses even a one-byte write. Returns the bytes the gate admitted. */
function spendBackgroundMinute(): number {
  let size = 512 * 1024, admitted = 0;
  for (let i = 0; i < 4_000; i++) {
    if (backgroundWrite(size)) { admitted += size; continue; }
    if (size === 1) break;
    size = Math.max(1, size >> 2);
  }
  // what is left is under one commit of that source; another background writer's ticket takes it (reserved and written in full)
  for (let i = 0; i < 64; i++) {
    const room = ioBudget.backgroundRoom();
    if (room <= 0) break;
    const ticket = ioBudget.admit("BG", room);
    if (!ticket) break;
    ioBudget.settle(ticket, room); admitted += room;
  }
  return admitted;
}
/** To five ms past the next minute's start, without running the worker's timer first; the load then takes that minute. */
async function nextMinuteUnderLoad(idleAfter = false): Promise<number> {
  const next = (Math.floor(Date.now() / 60_000) + 1) * 60_000;
  await vi.advanceTimersByTimeAsync(Math.max(0, next - Date.now() - 5));
  vi.setSystemTime(next + 5);
  ioBudget.setIsIdle(() => false);
  const admitted = spendBackgroundMinute();
  expect(backgroundWrite(1), "the gate refuses a one-byte background write: the minute is spent").toBe(false);
  // the owner goes idle for the rest of the minute: what the load wrote is already more than the idle allowance
  if (idleAfter) ioBudget.setIsIdle(() => true);
  return admitted;
}

/** Load takes minute 0 and every following minute before the worker's timer; returns the first minute at which `done` holds (0 = never). */
async function underLoad(idle: boolean, minutes: number, done: () => boolean, started = false): Promise<{ at: number; loadAdmitted: number[] }> {
  if (!started) expect(spendBackgroundMinute()).toBeGreaterThan(64 * 1024);
  expect(backgroundWrite(1), "minute 0 is spent before the worker starts").toBe(false);
  if (idle) ioBudget.setIsIdle(() => true);
  if (!started) controller.start();
  await vi.advanceTimersByTimeAsync(2_000);
  const loadAdmitted: number[] = [];
  let at = done() ? 0.5 : 0;
  for (let minute = 1; minute <= minutes && !at; minute++) {
    loadAdmitted.push(await nextMinuteUnderLoad(idle));
    await vi.advanceTimersByTimeAsync(40_000);
    if (done()) at = minute;
  }
  return { at, loadAdmitted };
}

for (const idle of [false, true]) {
  it(`W-CAPFG-${idle ? "IDLE" : "ACTIVE"} an owner line's capture under background load that spends every ${idle ? "idle " : ""}minute completes within the first minutes, not after BG_MAX_DEFERRAL_MS (${MAX_DEFERRAL_MINUTES} min; base: claimed at minute >= 10)`, async () => {
    await loadTable();
    appendMessage("thread", { id: "m0", at: 1, role: "user", kind: "text", text: "Durable evidence: the owner prefers short answers." });
    expect(jobs()).toEqual(["pending"]);
    const { at, loadAdmitted } = await underLoad(idle, 4, () => jobs()[0] === "complete");
    console.log(`[W-CAPFG-${idle ? "IDLE" : "ACTIVE"}] complete at minute ${at || "never"}, job ${jobs()[0]}, load ${JSON.stringify(loadAdmitted)}`);
    // the minute stayed spent for every other background writer (underLoad asserted the load first): only capture is foreground
    expect(backgroundWrite(1), "other background work is still refused").toBe(false);
    expect({ status: jobs()[0], completeWithinTwoMinutes: at > 0 && at <= 2 }).toEqual({ status: "complete", completeWithinTwoMinutes: true });
  }, 120_000);
}

it("W-CAPFG-BACKLOG a start-up backlog of 200 owed captures (pending and deferred, as a long starvation leaves them) drains within five minutes while background load spends every minute (base: relief slices, one 4 MiB grant a minute shared by every family, after ten minutes)", async () => {
  await loadTable();
  const db = database(), LINES = 200, first = Date.now() - 24 * 3_600_000;
  for (let i = 0; i < LINES; i++) appendMessage("thread", { id: `backlog-${i}`, ...(i ? { parentId: `backlog-${i - 1}` } : {}), at: first + i * 60_000, role: "user", kind: "text", text: `Durable evidence, line ${i}: the owner said something worth keeping.` });
  db.prepare("UPDATE memory_jobs SET status='deferred',attempts=1,retry_at=? WHERE rowid % 3 = 0 AND status='pending'").run(first);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_jobs").get()!.n)).toBe(LINES);
  const complete = () => Number(db.prepare("SELECT count(*) AS n FROM memory_jobs WHERE status='complete'").get()!.n);
  // an owner's turn on its way to the engine still comes first: while it is held the catch-up claims nothing
  const release = controller.holdForTurn();
  expect(spendBackgroundMinute()).toBeGreaterThan(64 * 1024);
  controller.start();
  await vi.advanceTimersByTimeAsync(1_500);
  expect(sent.filter(message => message.stage === "capture").length, "no capture claimed while an owner turn is held").toBe(0);
  release();
  const { at, loadAdmitted } = await underLoad(false, 6, () => complete() === LINES, true);
  console.log(`[W-CAPFG-BACKLOG] ${LINES} jobs: all complete at minute ${at || "never"} (complete now ${complete()}), load ${JSON.stringify(loadAdmitted)}`);
  // (the load is not asserted per minute here: the captures' own bytes are still charged on the ledger and take the minutes' room)
  expect({ complete: complete(), drainedWithinFiveMinutes: at > 0 && at <= 5 }).toEqual({ complete: LINES, drainedWithinFiveMinutes: true });
}, 240_000);
