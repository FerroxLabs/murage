// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owners: lane q1022-bgstarve owns these witnesses and the rule they pin (io-budget.ts: the ONE relief door, MAIN ruling
// 2026-11-24T22:25:23Z: ten minutes refused, one first-in first-out queue over every memory lane, one grant a minute of at most 4 MiB,
// jobs cut to it, none while an owner's turn is held, a clock that ends only when the job ran); io-budget.ts (scperf-p1) owns the background byte gate and its ledger; worker-controller.ts owns the sweeps, the sources
// they run under and the turn hold; MAIN owns the ruling.
//
// MAIN ruling 2026-11-24 (q1022-bgstarve, binding): "extend bounded relief to learning, reflection and maintenance, including on idle
// minutes. No memory subsystem may stay deferred more than 10 min. After that it runs in relief slices with the same cap as capture
// (<= ~4 MiB written/min total across all relief, shared, never during a held owner turn)." Field: learning, reflection and maintenance
// BG_DEFERRED since 2026-11-18 on a computer whose owner was away (idle budget 1) while other writers spent every minute.
//
// Real MemoryWorkerController (start, its sweep timer, its tick, the sources it runs each pass under, its turn hold), real database,
// the real gate (instrumentDatabase beforeWrite -> IoBudget.admit). No deferral is injected. Stand-ins, none of them under test: the
// helper process answers a capture with the leased text; the clock is vitest's; and the BODIES of the learning, reflection and
// maintenance passes (index.ts hands the controller closures over engines and the whole server) are passes that write their owed steps
// to a table through the gate, under whatever source the controller gave them, and throw the gate's refusal as the real passes do.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { BG_MINUTE_BYTES, IoBudget, ioBudget, isBgDeferred } from "../io-budget.ts";
import { ioMeterActive } from "../io-meter.ts";
import { appendMessage } from "../message-db.ts";
import { resetObserveWindows, setObserveSink } from "../observe.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { resetMemoryClaimCursor } from "./jobs.ts";
import { resetParkSweep } from "./park.ts";
import { pendingProjectionRecords } from "./projection.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import { resetWorkerLog } from "./worker-log.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import type { MemoryWork } from "./worker-protocol.ts";

// the ruling's numbers, literal
const MAX_DEFERRAL_MINUTES = 10, RELIEF_CAP_BYTES = 4 * 1024 * 1024;
// The owner's turn is held for longer than the worker's own hold timer (worker-controller.ts TURN_HOLD_MAX_MS, 3 s) and than one sweep
// (30 s): the passes are started again inside the hold, by the real sweep, and relief must still wait for the RELEASE.
const TURN_HELD_MS = 35_000;
// "within 10 min + its share": five lanes (capture, index, learning, reflection, maintenance) take the minutes in turn; a share is one
// round of them and two minutes of slack
const SHARE_MINUTES = 7;
type ReliefRow = { minute: number; lane: string; tickets: number; reserved: number; peak: number; written: number };
type Subsystem = "learning" | "reflection" | "maintenance";
const SUBSYSTEMS: Subsystem[] = ["learning", "reflection", "maintenance"];
type Internals = { child: unknown; ready: boolean; work: MemoryWork | null; onWorkerMessage(child: unknown, message: unknown): void };
type Step = { key: string; bytes: number };
type LoadShape = "spent" | "foreground" | "partial" | "active-partial" | "active-index" | "active-slice" | "quiet";
let controller: MemoryWorkerController | null, internals: Internals | null, sent: Array<Record<string, any>>, lines: string[], loadShape: LoadShape;
const resultFor = (work: MemoryWork) => ({ type: "result", result: { id: work.id, leaseGeneration: work.leaseGeneration, status: "complete", nextCursor: work.totalBytes, chunks: [{ text: work.text, startByte: 0, endByte: Buffer.byteLength(work.text) }] } });
// (the base has no relief door and so no record of one: the replay reads zeros there and runs to its behavioural assertions)
const NO_RELIEF = { grants: 0, bytes: 0, written: 0 };
const reliefStats = () => (ioBudget as unknown as { bgReliefStats?: { grants: number; bytes: number; written: number } }).bgReliefStats ?? NO_RELIEF;
const reliefLog = (): ReliefRow[] => ((ioBudget as unknown as { bgReliefLog?: ReliefRow[] }).bgReliefLog ?? []).map(row => ({ ...row }));

beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); resetParkSweep(); resetMemoryClaimCursor();
  sent = []; lines = []; controller = null; internals = null; loadShape = "spent"; resetWorkerLog(); resetObserveWindows(); setObserveSink(line => lines.push(line));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "Date"] });
  vi.setSystemTime(Math.ceil((Date.now() + 3_600_000) / 3_600_000) * 3_600_000 + 1_000);
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  vi.spyOn(console, "warn").mockImplementation(() => {});
  (ioBudget as unknown as { resetBgRelief?: () => void }).resetBgRelief?.();
});
afterEach(async () => {
  ioBudget.setIsIdle(() => false);
  ioBudget.stop();
  vi.useRealTimers();
  if (internals) { internals.child = null; internals.work = null; }
  await controller?.stop().catch(() => {});
  vi.restoreAllMocks(); setObserveSink(); closeDatabase();
});

/** The other writers of a minute, then the owner is away for the rest of it (idle). Three shapes:
 *  "spent": another background writer takes the whole background minute by the gate's own rules (one ticket for exactly the room the
 *  rules leave, written in full: never a relief slice) and a phone-delivery writer, which the background gate does not judge, writes
 *  twice the idle allowance (the field: "source=push-delivery ... against budget 1");
 *  "foreground": the phone-delivery writer alone: the idle allowance is spent, the whole background minute is left (the field minute
 *  of the reviews of f9913b21a2: most "budget 1" minutes write far under the minute's total);
 *  "partial": as "spent", but 256 KiB of the background minute is left: room, less than one slice;
 *  "active-partial": as "partial", and the owner is NOT away (an active minute with room under one slice);
 *  "active-index": an active minute with 3 MiB of the background minute left: room for slices, not for a helper index step;
 *  "active-slice": an active minute with room for one slice and under 2 MiB (the write gate reserves half of it: under 1 MiB of writes);
 *  "quiet": the owner is away and the one other writer stays under the idle allowance (256 KiB of rows): the gate's idle rule alone refuses
 *  the passes, and nothing but relief can take the minute over the watchdog's budget. */
function otherWritersSpendTheMinute(): void {
  ioBudget.setIsIdle(() => false);
  const active = loadShape === "active-partial" || loadShape === "active-index" || loadShape === "active-slice";
  const leave = loadShape === "partial" || loadShape === "active-partial" ? 256 * 1024 : loadShape === "active-index" ? 3 * 1024 * 1024 : loadShape === "active-slice" ? 1600 * 1024 : 0;
  for (let i = 0; i < 8 && loadShape !== "foreground" && loadShape !== "quiet"; i++) {
    const s = ioBudget.admissionState(), own = Math.min(BG_MINUTE_BYTES - s.bg - s.debt - s.reserved, 49 * 1024 * 1024 - s.total - s.reserved) - leave;
    if (own <= 0) break;
    const ticket = ioBudget.admit("BG", own);
    if (!ticket) break;
    ioBudget.settle(ticket, own);
  }
  ioBudget.withSource("push-delivery", () => { database().prepare("INSERT INTO w1022_other_writers(b) VALUES(zeroblob(?))").run(loadShape === "quiet" ? 256 * 1024 : 2 * 1024 * 1024); });
  // CHANGED-EXPECTATION (MAIN-RULING 2026-11-25T05:54:59Z idle DO LESS, MAIN-RULING 2026-11-25T06:57:58Z): an idle minute now pauses every
  // background memory write and the relief grant (io-budget.ts idleQuiet; witnessed in idle-quiet-1022.test.ts CAPTURE / W-GATE), so the
  // owner-away minutes these rows drove are ACTIVE minutes here: the other writers have spent the background minute and relief must still
  // drain every family on an active minute. (was: setIsIdle(() => true) for the shapes below; their titles keep the old wording)
  if (!active) ioBudget.setIsIdle(() => false);
  const after = ioBudget.admissionState(), room = BG_MINUTE_BYTES - after.bg - after.debt - after.reserved;
  if (loadShape === "spent") expect(room, "the background minute is spent by the gate's own rules").toBeLessThanOrEqual(0);
  if (loadShape === "active-index") expect(room >= 1536 * 1024 && room <= 3 * 1024 * 1024 && !ioBudget.admissionIdle(), `an active minute with room for slices and none for an index step (${room})`).toBe(true);
  if (loadShape === "active-slice") expect(room >= 1536 * 1024 && room < 1664 * 1024 && !ioBudget.admissionIdle(), `an active minute with room for one slice and under 2 MiB (${room})`).toBe(true);
  if (loadShape === "partial" || loadShape === "active-partial") expect(room > 0 && room < 1536 * 1024, `background room left, less than one slice (${room})`).toBe(true);
  if (loadShape === "foreground") expect({ idleAllowanceSpent: after.idleUsed > 1024 * 1024 - 65536, backgroundRoomLeft: room >= 1536 * 1024 }, JSON.stringify(after)).toEqual({ idleAllowanceSpent: true, backgroundRoomLeft: true });
}
async function nextMinute(): Promise<void> {
  const next = (Math.floor(Date.now() / 60_000) + 1) * 60_000;
  await vi.advanceTimersByTimeAsync(Math.max(0, next - Date.now() - 5));
  vi.setSystemTime(next + 5);
  otherWritersSpendTheMinute();
}

/** The replay. `captures` owner lines owe a capture each (each completed one is handed to learning by the controller); reflection and
 *  maintenance owe `steps` steps of `stepBytes` each. Other writers take every minute first and the owner is away in each (idle). */
async function replay(options: { captures: number; steps: number; stepBytes: number; minutes: number; only?: Subsystem; hold?: boolean; holdAcrossMinute?: boolean; swallow?: boolean; judge?: boolean; vanishing?: boolean; backlogDays?: number; load?: LoadShape; indexStepWrites?: number; eachMinute?: (minute: number) => void }) {
  loadShape = options.load ?? "spent";
  const db = database();
  db.exec("CREATE TABLE IF NOT EXISTS w1022_other_writers(id INTEGER PRIMARY KEY, b BLOB); CREATE TABLE IF NOT EXISTS w1022_subsystem_work(subsystem TEXT NOT NULL, key TEXT NOT NULL, b BLOB, PRIMARY KEY(subsystem,key))");
  const stopped = stopWalMaintenance();
  await vi.advanceTimersByTimeAsync(2_000);
  await stopped;
  const day = 24 * 3_600_000, first = Date.now() - (options.backlogDays ?? 0) * day;
  for (let i = 0; i < options.captures; i++) appendMessage("thread", { id: `line-${i}`, ...(i ? { parentId: `line-${i - 1}` } : {}), at: options.backlogDays ? first + i * (options.backlogDays * day / options.captures) : i + 1, role: "user", kind: "text", text: `Durable evidence, line ${i}: the owner said something worth keeping.` });
  // as the field left a backlog: some never tried, some deferred by an earlier refusal with their retry time long past
  if (options.backlogDays) db.prepare("UPDATE memory_jobs SET status='deferred',attempts=1,retry_at=? WHERE rowid % 3 = 0 AND status='pending'").run(first);
  const sourcesBefore = db.prepare("SELECT id,revision FROM memory_sources ORDER BY id").all().map(row => `${row.id}:${row.revision}`);
  const recordsBefore = db.prepare("SELECT id FROM memory_records ORDER BY id").all().map(row => String(row.id));
  const owed: Record<Subsystem, Step[]> = { learning: [], reflection: [], maintenance: [] };
  for (const subsystem of ["reflection", "maintenance"] as const) for (let i = 0; i < options.steps && (!options.only || options.only === subsystem); i++) owed[subsystem].push({ key: `${subsystem}-${i}`, bytes: options.stepBytes });
  // (the owner's turn witness: small steps behind the owed ones, 200 ms apart, so a pass is in flight on relief for seconds)
  if (options.hold) for (const subsystem of ["maintenance", "reflection"] as const) for (let i = 0; i < 40; i++) owed[subsystem].push({ key: `held-${subsystem}-${i}`, bytes: 4096 });
  const active: Record<Subsystem, number> = { learning: 0, reflection: 0, maintenance: 0 };
  const done: Array<{ subsystem: Subsystem; key: string; minute: number; source: string | undefined; idle: boolean }> = [];
  const handed = new Set<string>();
  let minute = 0, swallowed = 0;
  const pass = async (subsystem: Subsystem): Promise<boolean> => {
    if (active[subsystem] || !owed[subsystem].length) return false;
    active[subsystem]++;
    try {
      while (owed[subsystem].length) {
        const step = owed[subsystem][0];
        // the gate's refusal (BgDeferred) leaves the step owed and ends the pass, as it ends a real one
        // (swallow: the pass catches the refusal itself and returns, as production maintenance steps do: the controller sees no throw)
        try { database().prepare("INSERT OR REPLACE INTO w1022_subsystem_work(subsystem,key,b) VALUES(?,?,zeroblob(?))").run(subsystem, step.key, step.bytes); }
        catch (error) { if (options.swallow && isBgDeferred(error)) { swallowed++; return false; } throw error; }
        owed[subsystem].shift();
        done.push({ subsystem, key: step.key, minute, source: ioBudget.currentSource(), idle: ioBudget.admissionIdle() });
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      return true;
    } finally { active[subsystem]--; }
  };
  controller = new MemoryWorkerController({
    onMaintenance: async () => { await pass("maintenance"); },
    onContinuity: async () => { await pass("reflection"); },
    // learning: a completed source is handed over once; a refused pass keeps it owed for the next hand-off or the idle learning pass
    onCompletedSource: async (jobId: string) => { if (!handed.has(jobId)) { handed.add(jobId); if (owedAt.learning < 0) owedAt.learning = minute; owed.learning.push({ key: jobId, bytes: options.stepBytes }); } await pass("learning"); return undefined as never; },
    onIdleConsolidation: async () => pass("learning"),
  } as ConstructorParameters<typeof MemoryWorkerController>[0]);
  internals = controller as unknown as Internals;
  const indexPending0 = () => pendingProjectionRecords(db, 64, false).length;
  const indexBatches: Array<{ minute: number; records: number; granted: number; relief: boolean }> = [];
  const owedAt = { learning: -1, index: -1, reflection: 0, maintenance: 0 };
  internals.child = { kill() {}, on() {}, send: (message: any) => {
    sent.push(message);
    // the helper's answer to an index batch: it settles the step it was granted with what the step wrote, then acknowledges every record
    if (message.type === "index") {
      indexBatches.push({ minute, records: message.records.length, granted: Number(message.grant?.bytes ?? 0), relief: message.grant?.relief === true });
      if (typeof message.grant?.id === "string") internals!.onWorkerMessage(internals!.child, { type: "bg-grant-settle", id: message.grant.id, used: Math.min(Number(message.grant.bytes), options.indexStepWrites ?? 256 * 1024) });
      setTimeout(() => internals!.onWorkerMessage(internals!.child, { type: "index-result", requestId: message.requestId, records: message.records.map((record: any) => ({ id: record.id, version: record.version, deleted: record.deleted })), embeddingStatus: "indexed" }), 10);
    }
    if (message.stage === "capture") setTimeout(() => internals!.onWorkerMessage(internals!.child, resultFor(message as MemoryWork)), 10);
  } };
  internals.ready = true;
  // minute 0: the other writers are first, then the owner is away
  otherWritersSpendTheMinute();
  // (judge: the watchdog as the server boots it, index.ts ioBudget.start(): the process singleton, its production readers (readProcess:
  // the OS count and the real meter), its own minute timer. No reading is injected; the verdicts are read off its tick. The test's
  // own, as everywhere in this file: the clock, the idle verdict (setIsIdle) and the bodies of the passes.)
  const ticks = options.judge ? vi.spyOn(ioBudget, "tick") : null;
  if (options.judge) ioBudget.start();
  controller.start();
  await vi.advanceTimersByTimeAsync(40_000);
  const stats = reliefStats();
  if (indexPending0() > 0) owedAt.index = 0;
  const expected = () => ({ learning: options.captures, reflection: options.only && options.only !== "reflection" ? 0 : options.steps, maintenance: options.only && options.only !== "maintenance" ? 0 : options.steps });
  // the dispatcher's ticket array (read only: worker-controller.ts reliefQueue), before and after each minute, for the order oracle
  const queue = (): string[] => (controller as unknown as { reliefQueue?: () => string[] }).reliefQueue?.() ?? [];
  const queues: Array<{ minute: number; gate: number; before: string[]; after: string[] }> = [];
  const count = (subsystem: Subsystem) => new Set(done.filter(step => step.subsystem === subsystem && !step.key.startsWith("held-")).map(step => step.key)).size;
  const completeAt: Record<Subsystem, number> = { learning: 0, reflection: 0, maintenance: 0 };
  const perMinute: Array<{ minute: number; reliefWritten: number }> = [];
  const run0 = { heldAt: -1 };
  const held = { ran: false, inFlight: false, grantsBefore: 0, grants: -1, steps: -1, captureClaims: -1, owedThrough: false, minuteStarts: 0, ticketsAtMinuteStart: 0 };
  const indexPending = () => pendingProjectionRecords(db, 64, false).length;
  let indexDoneAt = 0;
  const everything = () => SUBSYSTEMS.every(subsystem => completeAt[subsystem] > 0) && indexDoneAt > 0;
  let afterHold = false;
  for (minute = 1; minute <= options.minutes && !(everything() && (held.ran || !options.hold) && !owed.maintenance.length && !owed.reflection.length); minute++) {
    let writtenBefore = stats.written;
    await nextMinute();
    // (the hold ran past its minute's end: what the rest of that minute granted after the release is not this minute's; the gate's own
    // record, one row a gate minute, judges both)
    if (afterHold) { writtenBefore = stats.written; afterHold = false; }
    // (a family refused once whose job then goes away: reflection owes one step from minute 2, taken back at minute 5)
    if (options.vanishing && minute === 2) owed.reflection.push({ key: "vanishing", bytes: options.stepBytes });
    if (options.vanishing && minute === 5) owed.reflection.length = 0;
    const before = queue(), gate = Math.floor(Date.now() / 60_000);
    let spent = 0;
    // (the helper asks after the tick's look at the minute's start, as its retry does)
    if (options.eachMinute) { await vi.advanceTimersByTimeAsync(200); spent += 200; options.eachMinute(minute); }
    const heldDone = () => done.filter(step => step.key.startsWith("held-")).length;
    const inFlight = () => active.maintenance + active.reflection > 0 && heldDone() >= 4 && stats.grants > 0;
    // (a pass the dispatcher started at this minute's start is in flight within seconds)
    if (options.hold && !held.ran) for (; spent < 3_000 && !inFlight(); spent += 100) await vi.advanceTimersByTimeAsync(100);
    if (options.hold && !held.ran && inFlight()) {
      // an owner's turn on its way to the engine while a maintenance or a reflection pass is in flight on relief: more steps are owed
      // (small ones, 200 ms apart: the pass would write all through the hold), and while the turn is held no relief slice starts
      held.ran = true; run0.heldAt = minute;
      held.inFlight = active.maintenance + active.reflection > 0 && heldDone() >= 4;
      held.grantsBefore = stats.grants;
      const release = controller.holdForTurn(), steps = heldDone(), claims = sent.filter(message => message.stage === "capture").length;
      await vi.advanceTimersByTimeAsync(TURN_HELD_MS); spent += TURN_HELD_MS; afterHold = true;
      // (the turn is still live when the NEXT minute starts: the dispatcher's own timer runs the tick at that minute's start, long
      // after the worker's 3 s hold timer has lapsed, with tickets waiting and the minute's grant free; a hold that reads the timer
      // and not the live turn grants here. Twenty seconds into that minute the turn is still held.)
      if (options.holdAcrossMinute) { await nextMinute(); minute++; held.minuteStarts++; await vi.advanceTimersByTimeAsync(20_000); spent = 20_000; held.ticketsAtMinuteStart = queue().length; writtenBefore = reliefStats().written; }
      held.grants = stats.grants - held.grantsBefore; held.steps = heldDone() - steps; held.captureClaims = sent.filter(message => message.stage === "capture").length - claims;
      held.owedThrough = owed.maintenance.length + owed.reflection.length > 0;
      release();
    }
    await vi.advanceTimersByTimeAsync(Math.max(0, 40_000 - spent));
    perMinute.push({ minute, reliefWritten: stats.written - writtenBefore });
    if (!afterHold) queues.push({ minute, gate, before, after: queue() });
    // (the index is owed from the first minute records wait for a batch)
    if (owedAt.index < 0 && (indexBatches.length || indexPending() > 0)) owedAt.index = minute;
    for (const subsystem of SUBSYSTEMS) if (!completeAt[subsystem] && count(subsystem) === expected()[subsystem]) completeAt[subsystem] = minute;
    if (!indexDoneAt && indexBatches.length && indexPending() === 0 && Number(db.prepare("SELECT count(*) AS n FROM memory_jobs WHERE status<>'complete'").get()!.n) === 0) indexDoneAt = minute;
  }
  const firstAt = (subsystem: Subsystem) => Math.min(Infinity, ...done.filter(step => step.subsystem === subsystem).map(step => step.minute));
  const deferredLines = (subsystem: string) => lines.filter(line => line.includes(`subsystem=${subsystem} cause=BG_DEFERRED`)).length;
  const index = { owedAt: owedAt.index, granted: indexBatches.map(batch => batch.granted), relief: indexBatches.map(batch => batch.relief), batches: indexBatches.length, records: indexBatches.reduce((sum, batch) => sum + batch.records, 0), firstAt: indexBatches[0]?.minute ?? null, doneAt: indexDoneAt, pending: indexPending(), minutes: indexBatches.map(batch => batch.minute).join(" ") };
  const captureFirstAt = sent.some(message => message.stage === "capture") ? 1 : null;
  const log = reliefLog();
  /** Oldest ticket first, strict round-robin, seen from the tick's grants (the gate's record) against the dispatcher's one ticket array
   *  read before and after each minute: the family granted a minute is the oldest ticket of that minute, so no family that held a
   *  ticket ahead of it still holds one after (it was passed over); a family granted that had no ticket before (it came due in this
   *  look) is granted only when nobody else that had one still has one; and the granted family, if it still has work, is at the BACK. */
  const jumped = queues.flatMap(({ minute: at, gate, before, after }) => {
    const granted = log.find(row => row.minute === gate)?.lane;
    // (a family whose pass found nothing to write hands its grant back and loses its ticket: no grant then is no fault)
    if (!granted) return before.some(family => after.includes(family)) && run0.heldAt !== at ? [`minute ${at}: tickets ${before.join(",")} and no grant`] : [];
    const ahead = before.includes(granted) ? before.slice(0, before.indexOf(granted)) : before;
    const passed = ahead.filter(family => after.includes(family)).map(family => `minute ${at}: ${granted} granted ahead of ${family} (${before.join(",")})`);
    return after.includes(granted) && after[after.length - 1] !== granted ? [...passed, `minute ${at}: ${granted} not re-enqueued at the back (${after.join(",")})`] : passed;
  });
  const judged = (ticks?.mock.results ?? []).map(result => result.value as ReturnType<IoBudget["tick"]>).filter(verdict => verdict !== null && verdict !== undefined);
  return { judged, swallowed, log, jumped, queues, owedAt, db, done, owed, handed, completeAt, perMinute, held, firstAt, count, expected: expected(), deferredLines, sourcesBefore, recordsBefore, stats, index, captureFirstAt };
}


/** The one relief door, read from the gate's own record of the replay the tick drove: one grant a minute to one lane, every relief
 *  ticket in it (so what the tickets wrote is all relief written: nothing was granted outside the door), never over the cap. */
function oneDoor(run: { log: ReliefRow[]; stats: { grants: number; written: number }; perMinute: Array<{ reliefWritten: number }> }) {
  return {
    oneGrantAMinute: new Set(run.log.map(row => row.minute)).size === run.log.length,
    everyTicketCounted: run.log.reduce((sum, row) => sum + row.tickets, 0) === run.stats.grants && run.log.reduce((sum, row) => sum + row.written, 0) === run.stats.written,
    underTheCap: Math.max(0, ...run.log.map(row => Math.max(row.peak, row.written)), ...run.perMinute.map(m => m.reliefWritten)) <= RELIEF_CAP_BYTES,
  };
}
const within = (at: number, owed: number) => at > 0 && owed >= 0 && at <= owed + MAX_DEFERRAL_MINUTES + SHARE_MINUTES;

it("W-RELIEF-ALL (MAIN ruling 2026-11-24T22:25:23Z, one relief door) capture, index, learning, reflection and maintenance, each refused for ten minutes on idle minutes other writers have spent (idle budget 1), then each complete within ten minutes and its share: one grant a minute to one lane, first in first out, never over 4 MiB, none while an owner's turn is held (base: none ever runs)", async () => {
  const run = await replay({ captures: 2, steps: 3, stepBytes: 16 * 1024, minutes: 60, hold: true, holdAcrossMinute: true });
  const { completeAt, perMinute, held, firstAt, count, expected, done, owedAt, index, log } = run;
  console.log(`[W-RELIEF-ALL] grants ${JSON.stringify(log.map(row => [row.minute, row.lane, row.tickets, row.peak, row.written]))}, owed at ${JSON.stringify(owedAt)}, index ${JSON.stringify(index)}, complete at minute ${JSON.stringify(completeAt)}, first step at ${JSON.stringify(Object.fromEntries(SUBSYSTEMS.map(s => [s, firstAt(s)])))}, per minute ${JSON.stringify(perMinute.map(m => [m.minute, m.reliefWritten]))}, held ${JSON.stringify(held)}, sources ${JSON.stringify([...new Set(done.map(step => `${step.subsystem}:${step.source}:${step.idle ? "idle" : "active"}`))])}`);
  // every family completes everything it owed within ten minutes and its share of the queue, counted from when it was first owed
  // (base: { learning: 0, reflection: 0, maintenance: 0 }, no index batch: the gate refuses each of them in every minute, for ever)
  expect({ ...Object.fromEntries(SUBSYSTEMS.map(subsystem => [subsystem, { steps: count(subsystem), within: within(completeAt[subsystem], owedAt[subsystem]) }])), index: { pending: index.pending, sent: index.batches > 0, within: within(index.firstAt ?? 0, owedAt.index) && index.doneAt > 0 } })
    .toEqual({ ...Object.fromEntries(SUBSYSTEMS.map(subsystem => [subsystem, { steps: expected[subsystem], within: true }])), index: { pending: 0, sent: true, within: true } });
  // the entry is ten minutes refused, not a bypass: no family's first step, and no index batch, before it
  // (learning is handed its first source inside the capture's grant, which waited its ten minutes)
  expect({ ...Object.fromEntries(SUBSYSTEMS.map(subsystem => [subsystem, firstAt(subsystem) >= (subsystem === "learning" ? 0 : owedAt[subsystem]) + MAX_DEFERRAL_MINUTES])), index: (index.firstAt ?? 0) >= owedAt.index + MAX_DEFERRAL_MINUTES, firstGrant: log[0].minute >= MAX_DEFERRAL_MINUTES }).toEqual({ learning: true, reflection: true, maintenance: true, index: true, firstGrant: true });
  // every step ran on an idle minute, under a source the controller runs that pass under
  expect([...new Set(done.map(step => `${step.subsystem}:${step.source}:${step.idle ? "idle" : "active"}`))].filter(seen => !["learning:memory-worker:idle", "learning:memory-idle:idle", "maintenance:memory-idle:idle", "reflection:memory-continuity:idle"].includes(seen))).toEqual([]);
  // ONE door: one grant a minute, to one lane, every relief ticket counted in it, never over the cap
  expect(oneDoor(run)).toEqual({ oneGrantAMinute: true, everyTicketCounted: true, underTheCap: true });
  // ONE queue over all the families: each lane held a grant (learning is handed its sources inside the capture's grant, worker-controller.ts
  // onCompletedSource, and has a lane of its own for the idle learning pass)
  expect(["capture", "index", "maintenance", "reflection"].filter(lane => !log.some(row => row.lane === lane))).toEqual([]);
  // first in, first out
  expect(run.jumped).toEqual([]);
  // the owner's turn: a pass was in flight on relief when it was held, steps stayed owed all through it, and for as long as it was
  // held (35 s: past the worker's own 3 s hold timer and past a sweep, then through the start of the NEXT minute, where the dispatcher's
  // tick ran with tickets waiting and that minute's grant free, and 20 s into it) nothing was granted or written
  expect({ ran: held.ran, inFlight: held.inFlight, reliefBefore: held.grantsBefore > 0, owedThrough: held.owedThrough, minuteStartsHeld: held.minuteStarts, ticketsWaited: held.ticketsAtMinuteStart > 0 }).toEqual({ ran: true, inFlight: true, reliefBefore: true, owedThrough: true, minuteStartsHeld: 1, ticketsWaited: true });
  expect({ grants: held.grants, steps: held.steps, captureClaims: held.captureClaims }, "no relief before the owner's turn releases").toEqual({ grants: 0, steps: 0, captureClaims: 0 });
  // and what the hold refused was not lost: the steps owed then are all done after it
  expect({ maintenance: run.owed.maintenance.length, reflection: run.owed.reflection.length, heldDone: new Set(done.filter(step => step.key.startsWith("held-")).map(step => step.key)).size }).toEqual({ maintenance: 0, reflection: 0, heldDone: 80 });
}, 400_000);

it("W-BACKLOG-ALL (MAIN rulings 2026-11-24T19:29:41Z and 22:25:23Z) a six-day backlog over ALL families (capture, index, learning, reflection, maintenance) drains on idle minutes other writers have spent: every job completes, none dropped, captures whole and indexed, one grant a minute in turn under the cap, nothing deleted", async () => {
  const CAPTURES = 12, STEPS = 30;
  const run = await replay({ captures: CAPTURES, steps: STEPS, stepBytes: 192 * 1024, minutes: 150, backlogDays: 6, hold: true });
  const { db, completeAt, held, count, expected, index, log, owedAt } = run;
  console.log(`[W-BACKLOG-ALL] grants ${JSON.stringify(log.map(row => [row.minute, row.lane, row.tickets, row.peak, row.written]))}, owed at ${JSON.stringify(owedAt)}, index ${JSON.stringify(index)}, complete at minute ${JSON.stringify(completeAt)}, held ${JSON.stringify(held)}`);
  const jobs = db.prepare("SELECT id,status,cursor,json_extract(coverage,'$.totalBytes') AS total FROM memory_jobs ORDER BY rowid").all();
  // (a) every one completes and none is dropped, the index included (base: 0 of each)
  expect({ captures: jobs.filter(row => row.status === "complete" && Number(row.cursor) === Number(row.total) && Number(row.total) > 0).length, learning: count("learning"), reflection: count("reflection"), maintenance: count("maintenance"), indexPending: index.pending, indexSent: index.batches > 0 })
    .toEqual({ captures: CAPTURES, learning: expected.learning, reflection: STEPS, maintenance: STEPS, indexPending: 0, indexSent: true });
  expect([...run.handed].sort()).toEqual(jobs.map(row => String(row.id)).sort());
  // the ruling's bound while the backlog drains: no family waits longer than ten minutes and its share for its first step or between two
  const longestWait = (subsystem: Subsystem) => { const at = [Math.max(0, owedAt[subsystem]), ...run.done.filter(step => step.subsystem === subsystem && !step.key.startsWith("held-")).map(step => step.minute)]; return Math.max(...at.slice(1).map((minute, i) => minute - at[i])); };
  // (learning: a source whose hand-off the capture's grant could not hold is left to the idle learning pass, which the controller runs
  // only once the worker has nothing to claim: it waits the captures out and then its own turn, two shares)
  expect(SUBSYSTEMS.map(subsystem => longestWait(subsystem) <= MAX_DEFERRAL_MINUTES + (subsystem === "learning" ? 2 : 1) * SHARE_MINUTES), JSON.stringify(SUBSYSTEMS.map(longestWait))).toEqual([true, true, true]);
  expect(Number(db.prepare("SELECT count(*) AS n FROM w1022_subsystem_work WHERE key NOT LIKE 'held-%' AND length(b)=?").get(192 * 1024)!.n), "every step's write is in the database").toBe(CAPTURES + 2 * STEPS);
  // (b) the one door: the backlog owes several minutes' grants; one grant a minute, every ticket counted, never over the cap; in turn
  expect(oneDoor(run)).toEqual({ oneGrantAMinute: true, everyTicketCounted: true, underTheCap: true });
  expect(log.length, "grants over several minutes, not one burst").toBeGreaterThanOrEqual(8);
  expect(["capture", "index", "maintenance", "reflection"].filter(lane => !log.some(row => row.lane === lane))).toEqual([]);
  expect(run.jumped).toEqual([]);
  expect(index.granted.every(bytes => bytes > 0 && bytes <= RELIEF_CAP_BYTES) && index.relief.every(Boolean), JSON.stringify(index)).toBe(true);
  expect({ grants: held.grants, steps: held.steps, captureClaims: held.captureClaims }).toEqual({ grants: 0, steps: 0, captureClaims: 0 });
  // (c) nothing deleted by the catch-up
  expect(db.prepare("SELECT id,revision FROM memory_sources ORDER BY id").all().map(row => `${row.id}:${row.revision}`)).toEqual(run.sourcesBefore);
  const recordsAfter = new Set(db.prepare("SELECT id FROM memory_records").all().map(row => String(row.id)));
  expect(run.recordsBefore.filter(id => !recordsAfter.has(id))).toEqual([]);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_tombstones").get()!.n)).toBe(0);
}, 900_000);

it("W-INDEX-RELIEF (one relief door; reviews of f9913b21a2 and 757fec950e) helper index batches are not deferred without limit and never reserve more than the grant: the records four captures left for the index, on idle minutes other writers have spent, are sent to the helper in steps CUT to the minute's grant and acknowledged (base: no batch is ever sent)", async () => {
  const run = await replay({ captures: 4, steps: 0, stepBytes: 16 * 1024, minutes: 60, indexStepWrites: 3 * 1024 * 1024 });
  const { index, perMinute, owedAt, log } = run;
  console.log(`[W-INDEX-RELIEF] grants ${JSON.stringify(log.map(row => [row.minute, row.lane, row.tickets, row.peak, row.written]))}, index ${JSON.stringify(index)}, per minute ${JSON.stringify(perMinute.map(m => [m.minute, m.reliefWritten]))}`);
  // every record the captures left for the index was sent and acknowledged (base: { sent: false, pending: > 0 })
  expect({ sent: index.batches > 0, pending: index.pending, within: within(index.firstAt ?? 0, owedAt.index) && index.doneAt > 0 }).toEqual({ sent: true, pending: 0, within: true });
  // an entry, not a bypass: no step before the index was refused ten minutes
  expect(index.firstAt).toBeGreaterThanOrEqual(owedAt.index + MAX_DEFERRAL_MINUTES);
  // split to fit: no step reserved more than the grant (a whole step's ceilings are over 7 MiB), and each was sent as a relief cut
  expect({ largest: Math.max(...index.granted) <= RELIEF_CAP_BYTES, smallest: Math.min(...index.granted) >= 1024 * 1024, relief: index.relief.every(Boolean) }, JSON.stringify(index)).toEqual({ largest: true, smallest: true, relief: true });
  // the steps are in the one door like everything else: each wrote 3 MiB, and no minute is over the cap
  expect(oneDoor(run)).toEqual({ oneGrantAMinute: true, everyTicketCounted: true, underTheCap: true });
  expect(Math.max(...log.filter(row => row.lane === "index").map(row => row.written))).toBeGreaterThanOrEqual(3 * 1024 * 1024);
}, 400_000);

for (const shape of ["foreground", "partial", "active-partial", "active-index"] as const) it(`W-FIELD-MINUTE ${shape} (the field minute: non-background writers every minute; reviews of f9913b21a2, 757fec950e, bd816535c0) ${{ foreground: "idle, the idle allowance spent by a foreground writer and the whole background minute left", partial: "idle, background room left under one slice", "active-partial": "ACTIVE, background room left under one slice", "active-index": "ACTIVE, room for slices and none for a helper index step" }[shape]}: capture, learning, reflection, maintenance and the index all complete within ten minutes and their share`, async () => {
  const run = await replay({ captures: 2, steps: 3, stepBytes: 16 * 1024, minutes: 60, load: shape });
  const { completeAt, count, expected, index, firstAt, owedAt, log } = run;
  const jobs = run.db.prepare("SELECT status FROM memory_jobs ORDER BY rowid").all().map(row => String(row.status));
  console.log(`[W-FIELD-MINUTE ${shape}] grants ${JSON.stringify(log.map(row => [row.minute, row.lane, row.tickets, row.peak, row.written]))}, jobs ${JSON.stringify(jobs)}, owed at ${JSON.stringify(owedAt)}, complete at ${JSON.stringify(completeAt)}, first step at ${JSON.stringify(Object.fromEntries(SUBSYSTEMS.map(s => [s, firstAt(s)])))}, index ${JSON.stringify(index)}`);
  // (base: the index never gets a batch in any shape; on the idle shapes nothing runs at all)
  expect({ captures: jobs, learning: count("learning"), reflection: count("reflection"), maintenance: count("maintenance"), indexPending: index.pending, indexSent: index.batches > 0, within: SUBSYSTEMS.every(subsystem => within(completeAt[subsystem], owedAt[subsystem])) && within(index.firstAt ?? 0, owedAt.index) && index.doneAt > 0 })
    .toEqual({ captures: ["complete", "complete"], learning: expected.learning, reflection: expected.reflection, maintenance: expected.maintenance, indexPending: 0, indexSent: true, within: true });
  // the index step never fits the room of any of these minutes: it waited its ten minutes and was cut to the grant
  expect({ indexWaited: (index.firstAt ?? 0) >= owedAt.index + MAX_DEFERRAL_MINUTES, cut: index.granted.every(bytes => bytes <= RELIEF_CAP_BYTES) && index.relief.every(Boolean) }, JSON.stringify(index)).toEqual({ indexWaited: true, cut: true });
  // on the idle shapes the gate's own rules admit none of the passes: none ran before its ten minutes
  if (shape === "foreground" || shape === "partial") expect({ reflection: firstAt("reflection") >= MAX_DEFERRAL_MINUTES, maintenance: firstAt("maintenance") >= MAX_DEFERRAL_MINUTES, learning: firstAt("learning") >= MAX_DEFERRAL_MINUTES }).toEqual({ reflection: true, maintenance: true, learning: true });
  // gate room first: with room for slices on an active minute the passes ran by the gate's own rules, at once, and only the index took relief
  if (shape === "active-index") expect({ early: firstAt("reflection") < MAX_DEFERRAL_MINUTES && firstAt("maintenance") < MAX_DEFERRAL_MINUTES, reliefLanes: [...new Set(log.map(row => row.lane))] }).toEqual({ early: true, reliefLanes: ["index"] });
  expect(oneDoor(run)).toEqual({ oneGrantAMinute: true, everyTicketCounted: true, underTheCap: true });
}, 400_000);

it("W-INDEX-STEP-REQUEST the helper's own ask for an index step (bg-grant-request, through the controller's message handler) on idle minutes other writers have spent: refused for ten minutes, then cut to what is left of the minute's one grant, never more (base: refused in every minute)", async () => {
  const asked: Array<{ minute: number; granted: boolean; stepBytes: number | null; bytes: number; relief: boolean; again: number }> = [];
  await replay({ captures: 0, steps: 0, stepBytes: 16 * 1024, minutes: 16, eachMinute: minute => {
    // the production entry of a helper message (the child's "message" listener): dispatchWorkerMessage, under the worker's source
    const ask = () => {
      const replies = sent.length;
      (controller as unknown as { dispatchWorkerMessage(child: unknown, message: unknown): void }).dispatchWorkerMessage(internals!.child, { type: "bg-grant-request", ceiling: 11 * 1024 * 1024, purpose: "bg", replan: true });
      return sent.slice(replies).find(message => message.type === "bg-grant");
    };
    const reply = ask();
    // the step wrote 3 MiB of what it was granted; the helper asks again in the same minute: only what is left of the one grant
    if (reply?.ticket) internals!.onWorkerMessage(internals!.child, { type: "bg-grant-settle", id: reply.ticket.id, used: 3 * 1024 * 1024 });
    const again = reply?.ticket ? ask() : null;
    if (again?.ticket) internals!.onWorkerMessage(internals!.child, { type: "bg-grant-settle", id: again.ticket.id, used: 0 });
    asked.push({ minute, granted: Boolean(reply?.ticket), stepBytes: reply?.ticket?.stepBytes ?? null, bytes: Number(reply?.ticket?.bytes ?? 0), relief: reply?.ticket?.relief === true, again: Number(again?.ticket?.bytes ?? 0) });
  } });
  console.log(`[W-INDEX-STEP-REQUEST] ${JSON.stringify(asked)}`);
  // (the helper asks once, at the first instant of each minute: it is served in the minutes the index lane is first in the queue)
  expect({ insideTenMinutes: asked.filter(ask => ask.minute <= 10 && ask.granted).length, after: asked.filter(ask => ask.minute > 10 && ask.granted).length >= 2 }, JSON.stringify(asked)).toEqual({ insideTenMinutes: 0, after: true });
  const granted = asked.filter(ask => ask.granted);
  expect(granted.every(ask => ask.relief && ask.stepBytes === ask.bytes && ask.bytes === RELIEF_CAP_BYTES && ask.again === RELIEF_CAP_BYTES - 3 * 1024 * 1024), "each grant is a relief cut of exactly the minute's grant, and a second ask gets only what the first left").toBe(true);
}, 240_000);

it("W-DISPATCH-ORDER (MAIN ruling 2026-11-25T00:06:14Z, RELIEF DOOR = ONE DISPATCHER) through the real tick: capture, the index, reflection and maintenance all owe more than a minute's grant; the minutes go to the OLDEST ticket, one family a minute, each family again only after every other family that still has a ticket (strict round-robin, the index included), and the backlog drains (base: no grant is ever given)", async () => {
  const run = await replay({ captures: 6, steps: 120, stepBytes: 192 * 1024, minutes: 120, backlogDays: 6 });
  const { log, queues, index, count } = run;
  console.log(`[W-DISPATCH-ORDER] grants ${JSON.stringify(log.map(row => [row.minute, row.lane, row.tickets, row.written]))}, queues ${JSON.stringify(queues.filter(q => q.before.length || q.after.length).map(q => [q.minute, q.before.join(","), q.after.join(",")]))}, index ${JSON.stringify(index)}`);
  // everything owed was done, through the door (base: nothing)
  expect({ reflection: count("reflection"), maintenance: count("maintenance"), learning: count("learning"), indexPending: index.pending, indexSent: index.batches > 0 }).toEqual({ reflection: 120, maintenance: 120, learning: 6, indexPending: 0, indexSent: true });
  // strict order: in every minute the family granted is the oldest ticket, and it goes to the back
  expect(run.jumped).toEqual([]);
  // at least three families held a ticket in the same minute, the index among them
  const three = queues.filter(q => q.before.length >= 3);
  expect({ minutesWithThreeTickets: three.length >= 3, indexAmongThem: three.some(q => q.before.includes("index")) }, JSON.stringify(queues)).toEqual({ minutesWithThreeTickets: true, indexAmongThem: true });
  // seen from the grants alone: while three or more families hold tickets, the same family is never granted two minutes running, and
  // the family granted a minute is the head of the array as it stood before that minute
  // (a head whose pass found nothing to write hands the grant back and has no ticket after: the minute is the next ticket's)
  const heads = three.map(q => ({ minute: q.minute, granted: log.find(row => row.minute === q.gate)?.lane ?? null, after: q.after, before: q.before })).map(h => ({ minute: h.minute, granted: h.granted, head: h.before.find(family => family === h.granted || h.after.includes(family)) ?? null }));
  expect(heads.filter(h => h.granted !== h.head)).toEqual([]);
  expect(log.filter((row, i) => i > 0 && log[i - 1].minute === row.minute - 1 && log[i - 1].lane === row.lane && queues.some(q => q.gate === row.minute && q.before.length >= 2)).map(row => `${row.lane}@${row.minute}`)).toEqual([]);
  expect(oneDoor(run)).toEqual({ oneGrantAMinute: true, everyTicketCounted: true, underTheCap: true });
}, 600_000);

it("W-DISPATCH-JOBLESS (MAIN ruling 2026-11-25T00:06:14Z) through the real tick: maintenance alone owes work; reflection, learning, the notebook, capture and the index are present and polled by every sweep with NO job. A family with no job never gets a ticket and never delays the one that has: from its tenth minute maintenance holds the grant of EVERY minute until it is done (base: maintenance never runs)", async () => {
  // (20 steps: about five minutes of grants, inside the ruling's ten minutes and a share)
  const run = await replay({ captures: 0, steps: 20, stepBytes: 192 * 1024, minutes: 40, only: "maintenance" });
  const { log, queues, count, completeAt } = run;
  console.log(`[W-DISPATCH-JOBLESS] grants ${JSON.stringify(log.map(row => [row.minute, row.lane, row.tickets, row.written]))}, complete at ${JSON.stringify(completeAt)}, queues ${JSON.stringify(queues.filter(q => q.before.length || q.after.length).map(q => [q.minute, q.before.join(","), q.after.join(",")]))}`);
  // (base: nothing is ever granted, so no family is)
  // only the family with a job ever held a ticket or a grant
  expect({ granted: [...new Set(log.map(row => row.lane))], ticketed: [...new Set(queues.flatMap(q => [...q.before, ...q.after]))] }).toEqual({ granted: ["maintenance"], ticketed: ["maintenance"] });
  expect({ maintenance: count("maintenance"), within: within(completeAt.maintenance, 0) }).toEqual({ maintenance: 20, within: true });
  // and no minute was kept for, offered to or lost to a family without one: its grants are consecutive minutes, more than one of them
  const work = log.filter(row => row.written > 0);
  expect({ several: work.length >= 3, consecutive: work.every((row, i) => i === 0 || row.minute === work[i - 1].minute + 1), firstAfterTen: queues.find(q => q.before.length || q.after.length)!.minute >= MAX_DEFERRAL_MINUTES }, JSON.stringify(log)).toEqual({ several: true, consecutive: true, firstAfterTen: true });
}, 400_000);

it("W-DISPATCH-VANISHED (MAIN ruling 2026-11-25T00:06:14Z; self-review of 5e3d0e1266) through the real tick: reflection is refused a write once and its job then goes away; maintenance owes minutes of work. Reflection's ticket costs nobody a minute: its pass finds nothing, the grant it took no byte of is handed back and the SAME minute goes to maintenance, whose grants stay consecutive (base: nothing is ever granted)", async () => {
  const run = await replay({ captures: 0, steps: 20, stepBytes: 192 * 1024, minutes: 40, only: "maintenance", vanishing: true });
  const { log, queues, count, completeAt } = run;
  console.log(`[W-DISPATCH-VANISHED] grants ${JSON.stringify(log.map(row => [row.minute, row.lane, row.tickets, row.written]))}, complete at ${JSON.stringify(completeAt)}, queues ${JSON.stringify(queues.filter(q => q.before.length || q.after.length).map(q => [q.minute, q.before.join(","), q.after.join(",")]))}`);
  // the refused family did get a ticket (it was refused a real write), and never a minute; maintenance did all its work
  const work = log.filter(row => row.written > 0);
  expect({ reflectionTicketed: queues.some(q => q.before.includes("reflection") || q.after.includes("reflection")), granted: [...new Set(log.map(row => row.lane))], maintenance: count("maintenance"), consecutive: work.length >= 3 && work.every((row, i) => i === 0 || row.minute === work[i - 1].minute + 1), ticketGone: !queues[queues.length - 1].after.includes("reflection") }, JSON.stringify(log))
    .toEqual({ reflectionTicketed: true, granted: ["maintenance"], maintenance: 20, consecutive: true, ticketGone: true });
  expect(run.jumped).toEqual([]);
}, 400_000);

it("W-ONE-DOOR-GATE (unit level, in addition to the tick witnesses: an IoBudget of its own, direct admissions) the gate's side of the one dispatcher: it has no queue and no clock (nothing is granted to anybody the dispatcher did not name, however long it was refused), one family a minute, at most the grant, none while a turn is held, a question about room changes nothing, and a job that ran by the gate's own rules is recorded", () => {
  type Gate = IoBudget & { grantBgRelief?(lane: string): boolean; bgReliefFree?(): boolean; bgLaneRanAt?(lane: string): number; holdBgReliefWhile?(held: () => boolean): () => void; bgReliefLog?: ReliefRow[] };
  const state = { at: 3_600_000 * 48 + 1_000, idle: true, turnHeld: false };
  const budget = new IoBudget({ read: () => ({ at: state.at, fsWriteBlocks: 0, cpuMicros: 0 }), log: () => {}, isIdle: () => state.idle }) as Gate;
  budget.holdBgReliefWhile?.(() => state.turnHeld);
  const ask = (source: string, bytes = 128 * 1024, wrote = bytes) => budget.withSource(source, () => { const ticket = budget.admit("BG", bytes); if (ticket) budget.settle(ticket, wrote); return ticket !== null; });
  const poll = (source: string) => budget.withSource(source, () => budget.backgroundRoom());
  // no clock in the gate: refused for twelve minutes and still refused (the dispatcher decides, not the gate), and polls change nothing
  const unnamed: boolean[] = [];
  for (let minute = 0; minute < 12; minute++) { unnamed.push(ask("memory-idle"), ask("not-a-memory-source")); poll("memory-idle"); state.at += 60_000; }
  expect(unnamed.some(Boolean), "nobody is served that the dispatcher did not name").toBe(false);
  // the dispatcher names one family: it is served from the one grant, up to the cap and no more; nobody else is; a second grant in the minute is refused
  const named = { granted: budget.grantBgRelief?.("memory-idle") ?? false, second: budget.grantBgRelief?.("memory-continuity") ?? false, other: ask("memory-continuity"), room: poll("memory-idle") > 0, over: ask("memory-idle", RELIEF_CAP_BYTES + 4096), wrote: 0 };
  for (let i = 0; i < 64; i++) if (ask("memory-idle")) named.wrote += 128 * 1024;
  expect(named, "one family a minute, at most the grant").toEqual({ granted: true, second: false, other: false, room: true, over: false, wrote: RELIEF_CAP_BYTES });
  // the next minute has no holder until the dispatcher names one
  state.at += 60_000;
  expect([ask("memory-idle"), budget.bgReliefFree?.() ?? false], "a grant is one minute's").toEqual([false, true]);
  // an owner's turn is held: no grant is given, and a family that holds the minute gets no ticket until the release
  state.turnHeld = true;
  const heldGrant = budget.grantBgRelief?.("memory-continuity") ?? true;
  state.turnHeld = false;
  const given = budget.grantBgRelief?.("memory-continuity") ?? false;
  state.turnHeld = true; const heldAsk = ask("memory-continuity"); state.turnHeld = false;
  expect({ heldGrant, given, heldAsk, afterRelease: ask("memory-continuity") }, "none while a turn is held").toEqual({ heldGrant: false, given: true, heldAsk: false, afterRelease: true });
  // the minute's last five seconds: the door is closed
  state.at = (Math.floor(state.at / 60_000) + 2) * 60_000 - 3_000;
  expect(budget.grantBgRelief?.("memory-idle") ?? true, "no grant in the minute's last 5 s").toBe(false);
  // a job that ran by the gate's own rules is a fact for the dispatcher: a whole slice that wrote; not a relief ticket, not a slice that wrote nothing
  state.at += 4_000; state.idle = false;
  const ran = () => budget.bgLaneRanAt?.("capture") ?? -1;
  const facts = { before: ran(), nothingWritten: (ask("memory-capture", 1536 * 1024, 0), ran()), wrote: (ask("memory-capture", 1536 * 1024, 4096), ran() > 0), reliefNeverCounts: budget.bgLaneRanAt?.("memory-idle") ?? -1 };
  expect(facts).toEqual({ before: 0, nothingWritten: 0, wrote: true, reliefNeverCounts: 0 });
  expect((budget.bgReliefLog ?? []).map(row => [row.lane, row.written])).toEqual([["memory-idle", RELIEF_CAP_BYTES], ["memory-continuity", 128 * 1024]]);
});

it("W-RELIEF-JUDGE (MAIN ruling 2026-11-24T23:23:46Z IDLE HEADROOM (b); review of 9622ad0770) the minute judge (IoBudget.tick, the watchdog's own entry) adds the relief grant x1.2 to THAT minute's allowance and says so on one relief-grant line instead of an over-budget line; bytes beyond grant x1.2 are over budget; the allowance is not carried to a later minute", () => {
  const MIB = 1024 * 1024, lines: string[] = [];
  const state = { at: 3_600_000 * 48 + 1_000, written: 0 };
  // an idle computer (idle budget 1 MiB a minute); the process's write count is the test's, cumulative, as the OS reports it
  const budget = new IoBudget({ read: () => ({ at: state.at, fsWriteBlocks: 0, cpuMicros: 0, meterBytes: state.written }) as never, log: line => { lines.push(line); }, isIdle: () => true, systemOverloaded: () => null });
  /** A maintenance pass asks for `slices` slices of 1 MiB and writes them (the gate's own rules refuse it on an idle minute: only the relief door grants). */
  const name = () => (budget as unknown as { grantBgRelief?(lane: string): boolean }).grantBgRelief?.("memory-idle");
  const pass = (slices: number) => { let granted = 0; for (let i = 0; i < slices; i++) budget.withSource("memory-idle", () => { const ticket = budget.admit("BG", MIB); if (ticket) { budget.settle(ticket, MIB); granted += MIB; } }); return granted; };
  /** The judge's verdict on the minute that just ended, and the lines it wrote. */
  const judge = () => { const from = lines.length; state.at += 60_000; const verdict = budget.tick(); const said = lines.slice(from); return { tripped: verdict?.tripped ?? null, reliefGrant: said.filter(line => line.startsWith("[io-budget] relief grant")).length, overBudget: said.filter(line => line.startsWith("[io-budget] writing ")).length }; };
  budget.tick();
  // ten minutes refused (nothing granted, nothing written, nothing said)
  let early = 0;
  for (let minute = 0; minute < 10; minute++) { early += pass(1); const said = judge(); early += said.reliefGrant + said.overBudget; }
  expect(early, "refused for ten minutes: no grant, no line").toBe(0);
  // minute A: the door grants 3 MiB; the disk saw them and 15% on top (the OS amplification): 3.45 MiB against the idle budget of 1
  name(); const a = pass(3); state.written += Math.round(3 * MIB * 1.15);
  const minuteA = { granted: a, ...judge() };
  // minute B: the same grant, and other writers put 1.5 MiB more on the disk: 5.1 MiB is over budget + grant x1.2 = 4.6 MiB
  name(); const b = pass(3); state.written += Math.round(3 * MIB * 1.2 + 1.5 * MIB);
  const minuteB = { granted: b, ...judge() };
  // two quiet minutes (under the budget), then minute E: no grant, 3.45 MiB written: minute A's allowance is not carried
  state.written += MIB / 2; const minuteC = judge();
  state.written += MIB / 2; const minuteD = judge();
  state.written += Math.round(3 * MIB * 1.15); const minuteE = judge();
  console.log(`[W-RELIEF-JUDGE] ${JSON.stringify({ minuteA, minuteB, minuteC, minuteD, minuteE })} ${JSON.stringify(lines)}`);
  expect(minuteA, "the grant x1.2 is added to the minute's allowance: one relief-grant line, no over-budget line, not tripped").toEqual({ granted: 3 * MIB, tripped: false, reliefGrant: 1, overBudget: 0 });
  expect(minuteB, "bytes beyond grant x1.2 are over budget").toEqual({ granted: 3 * MIB, tripped: true, reliefGrant: 0, overBudget: 1 });
  expect([minuteC, minuteD], "a minute under the budget says nothing").toEqual([{ tripped: false, reliefGrant: 0, overBudget: 0 }, { tripped: false, reliefGrant: 0, overBudget: 0 }]);
  expect(minuteE, "the allowance is that minute's only").toEqual({ tripped: true, reliefGrant: 0, overBudget: 1 });
});

for (const [shape, kib, where] of [["spent", 272, "idle minutes other writers have spent: the gate's own rules give nothing and the reservation is sized from the grant (6ebaf6f091: one slice, halved to 768 KiB)"], ["active-slice", 288, "ACTIVE minutes with room for one slice and under 2 MiB: the gate's own rules admit a reservation of half that room, under 800 KiB (91f1fb7727: the holder of the grant was still told that room)"]] as const) it(`W-RELIEF-OVERSIZED ${shape} (reviews of 6ebaf6f091 and 91f1fb7727, io-budget.ts bgReliefRoom and backgroundRoom) through the real tick: maintenance owes steps that are ONE transaction of ${kib} KiB of rows each, more than the reservation holds and inside the 1 MiB the gate's own rules give one transaction (measured on idle minutes: 256 KiB and up are refused at 768 KiB, up to 288 KiB fit 1 MiB). On ${where}. Refused ten minutes, then every step is written under relief, never over the grant (before: each is refused on every relief turn with the whole grant free; base: no relief at all)`, async () => {
  const STEPS = 6, BYTES = kib * 1024;
  const run = await replay({ captures: 0, steps: STEPS, stepBytes: BYTES, minutes: 40, only: "maintenance", load: shape });
  const { log, count, completeAt, db } = run;
  console.log(`[W-RELIEF-OVERSIZED ${shape}] grants ${JSON.stringify(log.map(row => [row.minute, row.lane, row.tickets, row.reserved, row.peak, row.written]))}, complete at ${JSON.stringify(completeAt)}`);
  expect({ maintenance: count("maintenance"), within: within(completeAt.maintenance, 0), inTheDatabase: Number(db.prepare("SELECT count(*) AS n FROM w1022_subsystem_work WHERE subsystem='maintenance' AND length(b)=?").get(BYTES)!.n) }).toEqual({ maintenance: STEPS, within: true, inTheDatabase: STEPS });
  // an entry, not a bypass, and the one door's cap holds with the larger reservation
  expect({ firstAfterTen: run.firstAt("maintenance") >= MAX_DEFERRAL_MINUTES, lanes: [...new Set(log.map(row => row.lane))] }).toEqual({ firstAfterTen: true, lanes: ["maintenance"] });
  expect(oneDoor(run)).toEqual({ oneGrantAMinute: true, everyTicketCounted: true, underTheCap: true });
}, 400_000);

for (const [shape, site] of [["spent", "the write gate finds no room to size a reservation from and admit is never asked (io-budget.ts beforeWrite)"], ["active-partial", "an ACTIVE minute with 256 KiB of room: admit grants a 128 KiB reservation by its own rules and the native grant then refuses the 192 KiB transaction (io-budget.ts finishGrant)"]] as const) it(`W-RELIEF-SWALLOWED ${shape} (reviews of 5e3d0e1266 and 6ebaf6f091) through the real tick: a maintenance pass that CATCHES the gate's refusal itself and returns (as production maintenance steps do, so the controller never sees a throw) is still a real pending job. Refusal site: ${site}. The gate's own count of the family's refused writes gives it a ticket after ten minutes and its steps are all written, through the one door (base and a gate that does not count that refusal: it never runs)`, async () => {
  const STEPS = 8;
  const run = await replay({ captures: 0, steps: STEPS, stepBytes: 192 * 1024, minutes: 40, only: "maintenance", swallow: true, load: shape });
  const { log, count, completeAt, queues } = run;
  console.log(`[W-RELIEF-SWALLOWED ${shape}] grants ${JSON.stringify(log.map(row => [row.minute, row.lane, row.tickets, row.written]))}, complete at ${JSON.stringify(completeAt)}, swallowed ${run.swallowed}`);
  expect({ maintenance: count("maintenance"), within: within(completeAt.maintenance, 0), refusalsSwallowed: run.swallowed > 0 }).toEqual({ maintenance: STEPS, within: true, refusalsSwallowed: true });
  expect({ firstAfterTen: run.firstAt("maintenance") >= MAX_DEFERRAL_MINUTES, ticketed: [...new Set(queues.flatMap(q => [...q.before, ...q.after]))], lanes: [...new Set(log.map(row => row.lane))] }).toEqual({ firstAfterTen: true, ticketed: ["maintenance"], lanes: ["maintenance"] });
  expect(oneDoor(run)).toEqual({ oneGrantAMinute: true, everyTicketCounted: true, underTheCap: true });
}, 400_000);

it("W-RELIEF-METER (MAIN rulings 2026-11-25T00:06:14Z witness list 'zero over-budget lines' and 2026-11-24T23:23:46Z (b); reviews of 6ebaf6f091) the dispatcher and the PRODUCTION watchdog together: the process's own io budget started as the server starts it (its minute timer, the OS write count and the real meter; no reading injected), the real tick dispatching relief to maintenance and reflection on quiet idle minutes. The relief minutes are over the idle budget on the meter, and the judge writes ZERO over-budget lines and ONE relief-grant line for each (base: no relief, nothing is ever written; a judge without the allowance: an over-budget line)", async () => {
  const STEPS = 24, MIB = 1024 * 1024;
  const run = await replay({ captures: 0, steps: STEPS, stepBytes: 192 * 1024, minutes: 45, load: "quiet", judge: true });
  const { log, count, judged } = run;
  const said = vi.mocked(console.warn).mock.calls.map(call => String(call[0])).filter(line => line.startsWith("[io-budget] "));
  const overBudget = said.filter(line => line.startsWith("[io-budget] writing ")), reliefGrant = said.filter(line => line.startsWith("[io-budget] relief grant"));
  // the judged minutes the meter saw over the idle budget (1 MiB): with a quiet other writer, only relief takes a minute there
  const over = judged.filter(verdict => verdict!.writeBytesPerMinute > MIB);
  console.log(`[W-RELIEF-METER] meter ${ioMeterActive()}, grants ${JSON.stringify(log.map(row => [row.minute, row.lane, row.tickets, row.written]))}, judged ${JSON.stringify(judged.map(verdict => [Math.round(verdict!.writeBytesPerMinute), verdict!.tripped]))}, said ${JSON.stringify(said)}`);
  expect(ioMeterActive(), "the real meter is loaded (the production reader, not a stand-in)").toBe(true);
  expect({ maintenance: count("maintenance"), reflection: count("reflection"), overBudgetLines: overBudget.length, reliefGrantLines: reliefGrant.length > 0 }).toEqual({ maintenance: STEPS, reflection: STEPS, overBudgetLines: 0, reliefGrantLines: true });
  // the allowance was needed and is the reason: several judged minutes are over the idle budget on the production meter, each of them
  // has its one relief-grant line and none of them an over-budget line; no line for a minute relief did not carry
  expect({ minutesOverTheIdleBudget: over.length >= 3, oneReliefGrantLineEach: reliefGrant.length === over.length, noMoreThanTheGrants: reliefGrant.length <= log.filter(row => row.written > 0).length + 1 }, JSON.stringify(said)).toEqual({ minutesOverTheIdleBudget: true, oneReliefGrantLineEach: true, noMoreThanTheGrants: true });
  expect(oneDoor(run)).toEqual({ oneGrantAMinute: true, everyTicketCounted: true, underTheCap: true });
}, 400_000);
