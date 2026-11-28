// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owners: lane q1022-bgstarve owns these witnesses and the rule they pin (io-budget.ts: BG_MAX_DEFERRAL_MS and the relief slices);
// io-budget.ts (scperf-p1) owns the background byte gate and its ledger; worker-controller.ts owns the worker's tick, claim and
// publication slices.
//
// 1.0.22 bgstarve, field (a live app, six days): "[memory-worker] subsystem=capture cause=BG_DEFERRED count=N since=2026-11-18...
// next=later". Other writers spent every minute's allowance, the background gate refused the capture's claim each minute, and nothing
// bounded it: an owner's lines were never learned. Rule: background memory work is refused for at most BG_MAX_DEFERRAL_MS, then admitted
// in small slices however full the minute is.
//
// Real MemoryWorkerController (start, its own timer, tick, claim, publication), real database, the real gate (instrumentDatabase
// beforeWrite -> IoBudget.admit). No deferral is injected: the load is real background writes through the same gate, repeated at the
// start of every minute before the worker's timer fires, until the gate itself refuses a one-byte write. Stand-ins, none of them under
// test: the helper process is an object that answers a capture with the leased text as one chunk; the clock is vitest's.
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
/** The replay: one owner line owes a capture; load takes every minute first, for eight minutes. */
async function captureUnderLoad(idle: boolean) {
  await loadTable();
  appendMessage("thread", { id: "m0", at: 1, role: "user", kind: "text", text: "Durable evidence: the owner prefers short answers." });
  expect(jobs()).toEqual(["pending"]);
  // minute 0: the load is first
  expect(spendBackgroundMinute()).toBeGreaterThan(64 * 1024);
  expect(backgroundWrite(1)).toBe(false);
  if (idle) ioBudget.setIsIdle(() => true);
  controller.start();
  await vi.advanceTimersByTimeAsync(2_000);
  const claimedAt: number[] = [], completedAt: number[] = [], loadAdmitted: number[] = [];
  const look = (minute: number) => {
    if (!claimedAt.length && sent.some(message => message.stage === "capture")) claimedAt.push(minute);
    if (!completedAt.length && jobs()[0] === "complete") completedAt.push(minute);
  };
  look(0);
  for (let minute = 1; minute <= MAX_DEFERRAL_MINUTES + 6; minute++) {
    loadAdmitted.push(await nextMinuteUnderLoad(idle));
    await vi.advanceTimersByTimeAsync(40_000);
    look(minute);
  }
  return { claimedAt, completedAt, loadAdmitted };
}

it("W-CAPTURE-BOUND a capture owed while background load spends every minute is claimed and completed within the bound: refused inside BG_MAX_DEFERRAL_MS, then admitted in small slices (base: never, the field's six days)", async () => {
  const { claimedAt, completedAt, loadAdmitted } = await captureUnderLoad(false);
  const deferredLines = lines.filter(line => line.includes("subsystem=capture cause=BG_DEFERRED")).length;
  console.log(`[W-CAPTURE-BOUND] claimed at minute ${claimedAt[0] ?? "never"}, complete at minute ${completedAt[0] ?? "never"}, job ${jobs()[0]}, BG_DEFERRED capture lines ${deferredLines}, relief ${JSON.stringify((ioBudget as unknown as { bgReliefStats?: unknown }).bgReliefStats ?? null)}`);
  // base: { claimed: false, status: "pending", ... }: eight minutes of load, the capture's claim refused in each
  expect({ claimed: claimedAt.length === 1, status: jobs()[0], completeWithinBound: completedAt.length === 1 && completedAt[0] <= MAX_DEFERRAL_MINUTES + 2 })
    .toEqual({ claimed: true, status: "complete", completeWithinBound: true });
  // the load was real in every minute: the gate admitted some of it before it refused the one-byte write (less each minute: the copy
  // debt of the earlier minutes' writes is carried, no checkpointer runs here)
  expect(loadAdmitted.every(bytes => bytes > 64 * 1024), JSON.stringify(loadAdmitted)).toBe(true);
  // FLIPPED 1.0.24 q1024-memcapture (MAIN 2026-11-27 memory swarm, cause C: "owner/bot-requested captures run at foreground priority ... the
  // start-up deletion pass and search.db writes must not crowd it out"): capture is no longer held for BG_MAX_DEFERRAL_MS; it is claimed at once.
  // was: expect(claimedAt[0]).toBeGreaterThanOrEqual(MAX_DEFERRAL_MINUTES);
  expect(claimedAt[0]).toBeLessThanOrEqual(1);
}, 120_000);

it("W-CAPTURE-IDLE the same on idle minutes (the field: budget 1, the owner away): the load has written more than the idle allowance before the owner goes idle in each minute, and the owed capture is still claimed and completed within the bound", async () => {
  const { claimedAt, completedAt, loadAdmitted } = await captureUnderLoad(true);
  console.log(`[W-CAPTURE-IDLE] claimed at minute ${claimedAt[0] ?? "never"}, complete at minute ${completedAt[0] ?? "never"}, job ${jobs()[0]}, idle ${ioBudget.admissionIdle()}`);
  expect(ioBudget.admissionIdle(), "the minutes the worker ran in were idle").toBe(true);
  expect({ claimed: claimedAt.length === 1, status: jobs()[0], completeWithinBound: completedAt.length === 1 && completedAt[0] <= MAX_DEFERRAL_MINUTES + 2 })
    .toEqual({ claimed: true, status: "complete", completeWithinBound: true });
  expect(loadAdmitted.every(bytes => bytes > 64 * 1024), JSON.stringify(loadAdmitted)).toBe(true);
  // FLIPPED 1.0.24 q1024-memcapture (MAIN 2026-11-27 memory swarm, cause C: "owner/bot-requested captures run at foreground priority ... the
  // start-up deletion pass and search.db writes must not crowd it out"): capture is no longer held for BG_MAX_DEFERRAL_MS; it is claimed at once.
  // was: expect(claimedAt[0]).toBeGreaterThanOrEqual(MAX_DEFERRAL_MINUTES);
  expect(claimedAt[0]).toBeLessThanOrEqual(1);
}, 120_000);

it("W-BACKLOG (MAIN ruling 2026-11-24T19:29:41Z) a backlog of captures deferred across six days catches up under the same load: every job completes with its whole coverage and is handed to learning, in bounded relief slices, an owner's turn still comes first, and no source or record is deleted", async () => {
  await loadTable();
  const db = database();
  const DAYS = 6, LINES = 24, day = 24 * 3_600_000, first = Date.now() - DAYS * day;
  for (let i = 0; i < LINES; i++) appendMessage("thread", { id: `backlog-${i}`, ...(i ? { parentId: `backlog-${i - 1}` } : {}), at: first + i * (DAYS * day / LINES), role: "user", kind: "text", text: `Durable evidence, day ${Math.floor(i * DAYS / LINES) + 1}, line ${i}: the owner said something worth keeping (${"detail ".repeat(i % 7)}end).` });
  // as the field left them: some never tried, some deferred by an earlier refusal with their retry time long past
  db.prepare("UPDATE memory_jobs SET status='deferred',attempts=1,retry_at=? WHERE rowid % 3 = 0 AND status='pending'").run(first);
  const seeded = db.prepare("SELECT status,count(*) AS n FROM memory_jobs GROUP BY status ORDER BY status").all().map(row => `${row.status}:${row.n}`);
  expect(seeded).toEqual(["deferred:8", "pending:16"]);
  const sourcesBefore = db.prepare("SELECT id,revision FROM memory_sources ORDER BY id").all().map(row => `${row.id}:${row.revision}`);
  const recordsBefore = db.prepare("SELECT id FROM memory_records ORDER BY id").all().map(row => String(row.id));
  expect(sourcesBefore).toHaveLength(LINES);
  // learning: the hook index.ts hands the controller (consolidation of a completed source); here it records what it was handed
  const learned: string[] = [];
  // (the controller of beforeEach was never started; this one takes the learning hook)
  controller = new MemoryWorkerController({ onCompletedSource: async (jobId: string) => { learned.push(jobId); return undefined as never; } });
  internals = controller as unknown as Internals;
  internals.child = { kill() {}, on() {}, send: (message: any) => {
    sent.push(message);
    settleFixtureIndexGrant(message, event => internals.onWorkerMessage(internals.child, event)); /* index batches run on relief since round 2: the stand-in acknowledges them, as the helper does */ if (message.type === "index") setTimeout(() => internals.onWorkerMessage(internals.child, { type: "index-result", requestId: message.requestId, records: message.records.map((record: any) => ({ id: record.id, version: record.version, deleted: record.deleted })), embeddingStatus: "indexed" }), 10);
    if (message.stage === "capture") setTimeout(() => internals.onWorkerMessage(internals.child, resultFor(message as MemoryWork)), 10);
  } };
  internals.ready = true;
  expect(spendBackgroundMinute()).toBeGreaterThan(64 * 1024);
  // an owner's turn on its way to the engine: while it is held the catch-up starts nothing
  let heldClaims = -1;
  { const release = controller.holdForTurn(); controller.start(); await vi.advanceTimersByTimeAsync(1_500); heldClaims = sent.filter(message => message.stage === "capture").length; release(); }
  await vi.advanceTimersByTimeAsync(500);
  const stats = (ioBudget as unknown as { bgReliefStats: { grants: number; written: number } }).bgReliefStats;
  const done = () => Number(db.prepare("SELECT count(*) AS n FROM memory_jobs WHERE status='complete'").get()!.n);
  const perMinute: Array<{ minute: number; complete: number; reliefWritten: number }> = [];
  let allAt = 0, learnedAt = 0;
  for (let minute = 1; minute <= 150 && !(allAt && learnedAt); minute++) {
    const before = stats?.written ?? 0;
    await nextMinuteUnderLoad();
    await vi.advanceTimersByTimeAsync(40_000);
    perMinute.push({ minute, complete: done(), reliefWritten: (stats?.written ?? 0) - before });
    if (!allAt && done() === LINES) allAt = minute;
    // the hand-off to learning follows each thread checkpoint roll, which is a write of its own
    if (!learnedAt && new Set(learned).size === LINES) learnedAt = minute;
  }
  console.log(`[W-BACKLOG] ${LINES} jobs over ${DAYS} days: all complete at minute ${allAt || "never"}, all handed to learning at minute ${learnedAt || "never"}; per minute ${JSON.stringify(perMinute.map(m => [m.minute, m.complete, m.reliefWritten]))}; learned ${learned.length}`);
  const rows = db.prepare("SELECT id,status,cursor,json_extract(coverage,'$.totalBytes') AS total,(SELECT length(CAST(json_extract(v.payload,'$.text') AS BLOB)) FROM memory_source_versions v WHERE v.source_id=memory_jobs.source_id AND v.revision=memory_jobs.source_revision) AS bytes FROM memory_jobs ORDER BY rowid").all();
  // (a) every one completes, none dropped, none complete without its whole coverage (base: none completes: the claim is refused every minute)
  expect({ jobs: rows.length, complete: rows.filter(row => row.status === "complete").length, whole: rows.filter(row => row.status === "complete" && Number(row.cursor) === Number(row.total) && Number(row.total) === Number(row.bytes) && Number(row.bytes) > 0).length })
    .toEqual({ jobs: LINES, complete: LINES, whole: LINES });
  expect([...new Set(learned)].sort()).toEqual(rows.map(row => String(row.id)).sort());
  // (b) bounded slices: no minute's relief wrote more than the per-minute relief allowance (4 MiB: a third of the background minute, a
  // twelfth of the write budget, so the catch-up cannot trip it), and an owner's held turn stopped new claims
  // (read from the gate's own record, minute by its minutes: one grant a minute, what its tickets had open and wrote never over 4 MiB)
  const grants = (ioBudget as unknown as { bgReliefLog: Array<{ minute: number; peak: number; written: number }> }).bgReliefLog;
  expect({ oneGrantAMinute: new Set(grants.map(row => row.minute)).size === grants.length, largest: Math.max(...grants.map(row => Math.max(row.peak, row.written))) <= 4 * 1024 * 1024 }).toEqual({ oneGrantAMinute: true, largest: true });
  // FLIPPED 1.0.24 q1024-memcapture (MAIN 2026-11-27 cause C, "capture backlog drains within minutes of start"): capture is foreground and
  // takes no relief; was: expect(perMinute.filter(m => m.reliefWritten > 0).length, "...slices, not one burst").toBeGreaterThan(1);
  expect(perMinute.filter(m => m.reliefWritten > 0).length, "capture takes no relief grant").toBe(0);
  expect(allAt, "the backlog drains within minutes").toBeLessThanOrEqual(5);
  // (the owner-turn hold now happens before the catch-up starts: it drains inside the first minutes, before the old minute-14 hold)
  expect(heldClaims).toBe(0);
  // (c) nothing deleted by the catch-up: every source the backlog had is still there at its revision, every earlier record too
  expect(db.prepare("SELECT id,revision FROM memory_sources ORDER BY id").all().map(row => `${row.id}:${row.revision}`)).toEqual(sourcesBefore);
  const recordsAfter = new Set(db.prepare("SELECT id FROM memory_records").all().map(row => String(row.id)));
  expect(recordsBefore.filter(id => !recordsAfter.has(id))).toEqual([]);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_tombstones").get()!.n)).toBe(0);
}, 240_000);

// MAIN ruling 2026-11-25T00:06:14Z (one dispatcher): a relief ticket is for a real pending job that has waited ten minutes. The first
// line's job is done, so the second line is a new job with a wait of its own: it is captured within ten minutes and a share, not at once.
it("W-CAPTURE-STREAM under the same load a second line stored after relief began is captured too, within its own ten minutes and a share, not days", async () => {
  await loadTable();
  appendMessage("thread", { id: "m0", at: 1, role: "user", kind: "text", text: "Durable evidence: the first line." });
  expect(spendBackgroundMinute()).toBeGreaterThan(64 * 1024);
  controller.start();
  await vi.advanceTimersByTimeAsync(2_000);
  for (let minute = 1; minute <= MAX_DEFERRAL_MINUTES + 3; minute++) { await nextMinuteUnderLoad(); await vi.advanceTimersByTimeAsync(40_000); }
  // (read here and asserted with the second line below: the base, where the first line is never captured, still stores the second and runs to that assertion)
  const first = jobs()[0];
  appendMessage("thread", { id: "m1", parentId: "m0", at: 2, role: "user", kind: "text", text: "Durable evidence: the second line." });
  controller.wake();
  let done = 0;
  for (let minute = 1; minute <= MAX_DEFERRAL_MINUTES + 4 && !done; minute++) { await nextMinuteUnderLoad(); await vi.advanceTimersByTimeAsync(40_000); if (jobs().every(status => status === "complete")) done = minute; }
  expect({ firstBeforeTheSecondWasStored: first, jobs: jobs(), withinMinutes: done > 0 && done <= MAX_DEFERRAL_MINUTES + 3 }).toEqual({ firstBeforeTheSecondWasStored: "complete", jobs: ["complete", "complete"], withinMinutes: true });
}, 120_000);
