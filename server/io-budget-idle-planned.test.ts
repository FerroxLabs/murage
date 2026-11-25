// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: idle admission of planned writes: cause-idlecap (this file, io-budget.ts plannedWrites/publishPlanned). Ledger slot 32 reader on
// the checkpointer thread: walseam (admission-shared.ts beginCopy). Planned producers: the recall reclaimer (recall-view.ts reclaimCharge).
// MAIN-RULING 2026-11-22 idle-capture: under idle, admission counted every observed write against the idle allowance, the recall upkeep
// the minute tick already excuses as planned included, so an owed capture was deferred minute after minute while upkeep ran. Admission
// now takes off exactly what the tick takes off (one definition, plannedWrites); the idle ceiling stays for every unplanned write.
import { expect, it } from "vitest";
import { checkpointLedger } from "./admission-shared.ts";
import * as io from "./io-budget.ts";
import { BLOCK_BYTES, IoBudget, IO_BUDGET_IDLE_BYTES_PER_MINUTE, RECALL_RECLAIM_SOURCE, RECALL_SEED_SOURCE, SEARCH_SEED_SOURCE } from "./io-budget.ts";
import type { IoSample } from "../shared/health-protocol.mjs";

const MINUTE = 60_000, START = 600 * MINUTE, MB = 1024 * 1024;
const IDLE_ROOM = IO_BUDGET_IDLE_BYTES_PER_MINUTE - 65536;
/** One log frame as the meter charges it (one OS page of header plus the page) and the copy it owes: database.ts beforeWrite's split. */
const FRAME = 8192, COPY = 4096;
/** Recall upkeep at the rate the 1.0.21 idle rig measured: 3.9 MB a minute. */
const UPKEEP_PER_SECOND = Math.round(3.9 * MB / 60);

function world(startAt = START) {
  let at = startAt, os = 0, frame = 0, idle = true;
  const lines: string[] = [], samples: IoSample[] = [];
  // The same reading feeds the tick and admission, as in the process: cumulative OS blocks and metered bytes.
  const budget = new IoBudget({ read: () => ({ at, fsWriteBlocks: os / BLOCK_BYTES, cpuMicros: 0, meterBytes: os }) as never, log: line => lines.push(line), isIdle: () => idle, systemOverloaded: () => null, onSample: sample => samples.push(sample) });
  const buffer = budget.checkpointAdmissionBuffer(false);
  /** A write the process makes: observed by both counters, attributed to `source` through the production feed (noteBytes). */
  const write = (source: string | null, bytes: number) => { os += bytes; if (source) budget.noteBytes(source, bytes); };
  /** One owed capture through the production admission sequence (io-budget.ts instrumentDatabase beforeWrite, then finishGrant): the
   *  room, the frame/copy split of the ceiling, admit, the write, settle with its copy debt. False when admission refuses it. */
  const capture = (frames = 2): boolean => budget.withSource("memory-capture", () => {
    const room = budget.backgroundRoom(), need = frames * FRAME;
    const cap = Math.min(Math.floor(room * FRAME / (FRAME + COPY)), MB);
    if (cap < need) return false;
    const ticket = budget.admit("BG", cap, Math.floor(cap / FRAME) * COPY);
    if (!ticket) return false;
    os += need;
    budget.settle(ticket, need, { salt: "capture", frame: frame += frames }, frames * COPY, need);
    return true;
  });
  return { budget, buffer, lines, samples, write, capture, clock: (next: number) => { at = next; }, now: () => at, idle: (next: boolean) => { idle = next; } };
}

/** One minute (`minute` after START): `upkeep` writes every second, and 32 owed captures arrive evenly; `carried` were owed already; a
 *  refused capture is kept and retried every second (the memory worker's retry), until the minute's closing guard. Returns how many landed. */
function idleMinute(w: ReturnType<typeof world>, upkeep: (second: number) => void, captures = 32, minute = 0, carried = 0): number {
  let owed = 0, landed = 0;
  for (let second = 0; second < 54; second++) {
    w.clock(START + minute * MINUTE + second * 1000 + 500);
    upkeep(second);
    owed = carried + Math.min(captures, Math.floor((second + 1) * captures / 50));
    while (landed < owed && w.capture()) landed++;
  }
  return landed;
}

// CHANGED-EXPECTATION (MAIN-RULING 2026-11-25T05:54:59Z idle DO LESS, 11:49:12Z rewrite; was: 32 owed captures land in one idle minute
// beside planned upkeep): (a) the idle minute admits none and spends nothing; (b) the next ACTIVE minute, the same upkeep running, lands the
// 32 owed captures exactly once, and their bytes and copy debt fit the allowance as before.
it("WITNESS: with recall upkeep at its real rate (3.9 MB/min, planned), 32 owed captures wait out the idle minute and land once on the next active minute", () => {
  const w = world();
  const upkeep = () => w.write(RECALL_RECLAIM_SOURCE, UPKEEP_PER_SECOND);
  const idleLanded = idleMinute(w, upkeep);
  expect({ landed: idleLanded, bg: w.budget.admissionState().bg, debt: w.budget.admissionState().debt }, "idle DO LESS: the idle minute admits no capture").toEqual({ landed: 0, bg: 0, debt: 0 });
  w.idle(false);
  const landed = idleMinute(w, upkeep, 0, 1, 32);
  expect(landed, "every owed capture lands while planned recall upkeep runs").toBe(32);
  // the captures' own bytes and copy debt are what the allowance was spent on: still inside it, and each capture counted once
  const state = w.budget.admissionState();
  expect(state.bg).toBe(32 * 2 * FRAME);
  expect(state.bg + state.debt).toBeLessThanOrEqual(IDLE_ROOM);
});

// CHANGED-EXPECTATION (idle DO LESS, 11:49:12Z; was: the capture before the burst is admitted on the idle minute): (a) on the idle minute
// unplanned upkeep and a 4 MiB burst leave everything refused, the capture before the burst included; (b) on the next ACTIVE minute the
// deferred captures land, each once.
it("the idle ceiling stays: the same upkeep bytes written unplanned refuse the owed captures, and one unplanned 4 MiB write closes the minute", () => {
  // the same 3.9 MB/min, but from a source with no budget of its own: the allowance is spent by it within the minute
  const unplanned = world();
  const landed = idleMinute(unplanned, () => unplanned.write("recall-build", UPKEEP_PER_SECOND));
  expect(landed, "unplanned writes still count against the idle allowance").toBeLessThan(32);
  expect(unplanned.budget.withSource("memory-capture", () => unplanned.budget.backgroundRoom())).toBe(0);
  unplanned.idle(false);
  expect(idleMinute(unplanned, () => unplanned.write("recall-build", UPKEEP_PER_SECOND), 0, 1, 32 - landed), "the next active minute lands every capture the idle minute deferred").toBe(32 - landed);
  // one background burst (the perf rig's mutant write): nothing more is admitted that minute, capture included
  const burst = world();
  burst.clock(START + 1000);
  expect(burst.capture(), "idle DO LESS: before the burst the idle capture is refused as well").toBe(false);
  burst.write("perf-background", 4 * MB);
  burst.clock(START + 2000);
  expect(burst.capture(), "after an unplanned 4 MiB write the idle capture is refused").toBe(false);
  expect(burst.budget.withSource("memory-capture", () => burst.budget.admit("BG", FRAME, COPY)), "admit itself refuses").toBeNull();
  expect(burst.budget.admit("FGCOPY", FRAME), "an idle copy is refused as well").toBeNull();
  expect(burst.budget.copyRoom()).toBe(0);
  burst.idle(false);
  burst.clock(START + MINUTE + 1000);
  expect(burst.capture(), "before the burst the capture is admitted").toBe(true);
  expect(burst.capture(), "the second deferred capture lands too").toBe(true);
  expect(burst.budget.admissionState().bg, "each capture counted once").toBe(2 * 2 * FRAME);
});

// One row per kind of write, driven through the tick AND through admission in the same minute: what the tick excuses is exactly what
// admission does not count. `planned` is the expected verdict of both.
const KINDS: { name: string; planned: boolean; arrange: (w: ReturnType<typeof world>, bytes: number) => void }[] = [
  { name: "recall-reclaim bucket (recall build and reclaim slices)", planned: true, arrange: (w, bytes) => w.write(RECALL_RECLAIM_SOURCE, bytes) },
  { name: "recall-seed (first build of recall views)", planned: true, arrange: (w, bytes) => w.write(RECALL_SEED_SOURCE, bytes) },
  { name: "search-seed (first search index)", planned: true, arrange: (w, bytes) => w.write(SEARCH_SEED_SOURCE, bytes) },
  { name: "a writer that reports its own budgeted bytes (setPlannedBytes)", planned: true, arrange: (w, bytes) => { w.write(null, bytes); w.budget.setPlannedBytes(() => bytes, 20 * MB); } },
  { name: "recall-build attribution alone (not charged to the bucket)", planned: false, arrange: (w, bytes) => w.write("recall-build", bytes) },
  { name: "another memory writer", planned: false, arrange: (w, bytes) => w.write("memory-worker", bytes) },
  { name: "an unattributed background write", planned: false, arrange: (w, bytes) => w.write(null, bytes) },
  { name: "a named background write with no budget", planned: false, arrange: (w, bytes) => w.write("perf-background", bytes) },
];
// CHANGED-EXPECTATION (idle DO LESS, 11:49:12Z; was: idle admission of the owed capture follows the tick's planned verdict): (a) on the idle
// minute the tick's verdict and the planned share are as before and no capture is admitted (nothing of its own is planned); (b) on the next
// ACTIVE minute the same write leaves the owed capture admitted, once, and admission and the tick still take off the same planned bytes.
it.each(KINDS)("the tick and idle admission agree on $name", ({ planned, arrange }) => {
  const w = world();
  w.budget.tick();
  w.clock(START + 30_000);
  arrange(w, 2 * MB);
  const admitted = w.capture();
  const state = w.budget.admissionState() as { total: number; idleUsed?: number };
  const excusedByAdmission = state.total - (state.idleUsed ?? state.total);
  w.clock(START + MINUTE);
  const verdict = w.budget.tick()!;
  const sample = w.samples.at(-1)!;
  expect(verdict.tripped, "the tick's verdict on the minute").toBe(!planned);
  expect(admitted, "idle DO LESS: no idle admission of the owed capture in that minute").toBe(false);
  expect(excusedByAdmission, "admission takes off the bytes the tick takes off").toBe(sample.plannedBytesAllowed);
  expect(sample.plannedBytesAllowed).toBe(planned ? 2 * MB : 0);
  // the next minute, active: the same write, and the owed capture lands
  w.idle(false);
  w.clock(START + MINUTE + 30_000);
  arrange(w, 2 * MB);
  expect(w.capture(), "the owed capture is admitted on the next active minute").toBe(true);
  const active = w.budget.admissionState() as { total: number; idleUsed?: number };
  w.clock(START + 2 * MINUTE);
  const activeVerdict = w.budget.tick()!;
  const activeSample = w.samples.at(-1)!;
  expect(activeVerdict.tripped, "the active minute is under the active budget").toBe(false);
  expect(active.total - (active.idleUsed ?? active.total), "admission takes off the bytes the tick takes off").toBe(activeSample.plannedBytesAllowed);
  // (idle-owed-capture: the admitted capture's own settled bytes, two frames, are planned by the same definition, counted once)
  expect(activeSample.plannedBytesAllowed).toBe(planned ? 2 * MB + 2 * FRAME : 2 * FRAME);
});

// SITES: every place the idle allowance is compared (grep IO_BUDGET_IDLE_BYTES_PER_MINUTE-65536 and 1024*1024-65536). One row per site,
// each driven through that site, in a minute holding 2 MiB of planned upkeep and again holding 2 MiB of unplanned writes.
const SITES: { site: string; ticket?: true; open: (w: ReturnType<typeof world>) => boolean }[] = [
  { site: "admit BG capture (io-budget.ts admit, BG clause)", ticket: true, open: w => { const t = w.budget.withSource("memory-capture", () => w.budget.admit("BG", FRAME, COPY)); if (t) w.budget.settle(t, 0); return t !== null; } },
  { site: "admit FGCOPY while idle (io-budget.ts admit, idle clause)", open: w => { const t = w.budget.admit("FGCOPY", FRAME); if (t) w.budget.settle(t, 0); return t !== null; } },
  { site: "copyRoom", open: w => w.budget.copyRoom() > 0 },
  { site: "backgroundRoom for the capture", open: w => w.budget.withSource("memory-capture", () => w.budget.backgroundRoom()) > 0 },
  { site: "refusalRetry / claimRetryMs behind a live reservation (reservationOnlyRefusal)", ticket: true, open: w => {
    const live = w.budget.withSource("memory-capture", () => w.budget.admit("BG", FRAME, 0));
    try { return w.budget.withSource("memory-capture", () => w.budget.refusalRetry()).reservationWait === true && w.budget.claimRetryMs(true) <= 1000; }
    finally { if (live) w.budget.settle(live, 0); }
  } },
  { site: "the checkpointer's beginCopy (admission-shared.ts)", open: w => {
    w.budget.admissionState(); // the owner's reading publishes the minute, as its 25 ms timer does
    const worker = checkpointLedger(w.buffer, 7), ticket = worker.beginCopy(FRAME, w.now());
    if (ticket) worker.endCopy(ticket, 0, 0, undefined, w.now());
    return ticket !== null;
  } },
];
// CHANGED-EXPECTATION (idle DO LESS, 11:49:12Z; was: open on the idle minute at every site): the two capture-ticket sites (admit BG, the
// reservation retry) are (a) closed on the idle minute whatever is planned, and (b) open on the next ACTIVE minute beside the same planned
// upkeep; every other site is still open on the idle minute, as before.
it.each(SITES)("SITE $site: planned upkeep leaves the idle allowance open", ({ ticket, open }) => {
  const w = world();
  w.clock(START + 10_000);
  w.write(RECALL_RECLAIM_SOURCE, 2 * MB);
  if (!ticket) { expect(open(w)).toBe(true); return; }
  expect(open(w), "idle DO LESS: no capture ticket on the idle minute").toBe(false);
  w.idle(false);
  w.clock(START + MINUTE + 10_000);
  w.write(RECALL_RECLAIM_SOURCE, 2 * MB);
  expect(open(w), "the next active minute opens it beside the same planned upkeep").toBe(true);
});
it.each(SITES)("SITE $site: unplanned writes of the same size close it", ({ site, open }) => {
  const w = world();
  w.clock(START + 10_000);
  // (the retry row needs its live reservation admitted first: the burst lands after it, as in the minute it describes)
  if (site.startsWith("refusalRetry")) {
    const live = w.budget.withSource("memory-capture", () => w.budget.admit("BG", FRAME, 0))!;
    w.write("perf-background", 2 * MB);
    expect(w.budget.withSource("memory-capture", () => w.budget.refusalRetry()).reservationWait).toBe(false);
    w.budget.settle(live, 0);
    return;
  }
  w.write("perf-background", 2 * MB);
  expect(open(w)).toBe(false);
});

it("the planned share is never more than the planned bytes: unplanned writes beside planned upkeep still spend the allowance", () => {
  const w = world();
  w.clock(START + 10_000);
  w.write(RECALL_RECLAIM_SOURCE, 2 * MB);
  w.write("perf-background", IDLE_ROOM - 3 * FRAME);
  const state = w.budget.admissionState() as { total: number; idleUsed?: number };
  expect(state.idleUsed, "only the unplanned part is counted").toBe(IDLE_ROOM - 3 * FRAME);
  expect(w.budget.withSource("memory-capture", () => w.budget.backgroundRoom())).toBe(3 * FRAME);
  w.write("perf-background", 3 * FRAME);
  expect(w.capture(1), "the allowance is spent by the unplanned bytes").toBe(false);
});

it("the planned share is bounded by what was observed: a bucket charge larger than the minute's writes adds no room", () => {
  const w = world();
  w.clock(START + 10_000);
  w.budget.noteBytes(RECALL_RECLAIM_SOURCE, 8 * MB); // charged to the bucket; the counters saw 1 MiB
  w.write(null, MB);
  const state = w.budget.admissionState() as { total: number; idleUsed?: number };
  expect(state.total).toBe(MB);
  expect(state.idleUsed).toBe(0);
  expect(new BigInt64Array(w.buffer)[32]).toBe(BigInt(MB));
  expect(w.budget.withSource("memory-capture", () => w.budget.backgroundRoom()), "never more than the idle allowance itself").toBe(IDLE_ROOM);
  expect(w.budget.copyRoom()).toBe(IDLE_ROOM);
});

// CHANGED-EXPECTATION (idle DO LESS, 11:49:12Z; was: the planned minute's capture lands on the idle minute): (a) the idle planned minute
// admits no capture; (b) the next ACTIVE planned minute lands it once; the idle minute after it excuses nothing of the planned share.
it("the planned share ends with its minute, on the owner's reading and on a rotation the checkpointer sees first", () => {
  const w = world();
  w.clock(START + 10_000);
  w.write(RECALL_RECLAIM_SOURCE, 2 * MB);
  expect(w.capture(), "idle DO LESS: the idle minute admits no capture").toBe(false);
  w.idle(false);
  w.clock(START + MINUTE + 10_000);
  w.write(RECALL_RECLAIM_SOURCE, 2 * MB);
  expect(w.capture()).toBe(true);
  expect(w.budget.admissionState().bg, "the capture landed once").toBe(2 * FRAME);
  w.idle(true);
  // next minute, owner's reading first: 2 MiB unplanned, nothing planned
  w.clock(START + 2 * MINUTE + 10_000);
  w.write("perf-background", 2 * MB);
  expect(w.capture(), "last minute's planned bytes excuse nothing in this one").toBe(false);
  const state = w.budget.admissionState() as { total: number; idleUsed?: number };
  expect(state.idleUsed).toBe(state.total);
  // the minute after: the checkpointer rotates the ledger before any owner reading, then charges an unplanned copy
  const v = world();
  v.clock(START + 10_000);
  v.write(RECALL_RECLAIM_SOURCE, 2 * MB);
  v.budget.admissionState();
  const slots = new BigInt64Array(v.buffer);
  expect(Number(slots[32]), "slot 32 holds the minute's planned share").toBe(2 * MB);
  const worker = checkpointLedger(v.buffer, 7), next = START + MINUTE + 1000;
  const first = worker.beginCopy(FRAME, next)!;
  expect(first, "a fresh idle minute admits the copy").not.toBeNull();
  expect(Number(slots[32]), "the rotation cleared the planned share").toBe(0);
  worker.endCopy(first, 2 * MB, 0, undefined, next);
  expect(worker.beginCopy(FRAME, next + 1000), "the unplanned copy spent the new minute's idle allowance").toBeNull();
});

it("one definition: the tick and admission read planned through plannedWrites, and only the named sources are planned", () => {
  const api = io as unknown as { isPlannedSource?: (source: string) => boolean; plannedWrites?: (minutes: number, wrote: (source: string) => number, owedCapture: number, reader: (() => number) | null, cap: number, spent: (source: string) => number) => { planned: number } };
  expect(typeof api.isPlannedSource).toBe("function");
  expect(typeof api.plannedWrites).toBe("function");
  expect([RECALL_RECLAIM_SOURCE, RECALL_SEED_SOURCE, SEARCH_SEED_SOURCE].map(api.isPlannedSource!)).toEqual([true, true, true]);
  expect(["recall-build", "memory-capture", "memory-worker", "perf-background", "", "toString", "__proto__"].map(api.isPlannedSource!)).toEqual([false, false, false, false, false, false, false]);
  // a source that is not planned contributes nothing, whatever it wrote
  expect(api.plannedWrites!(1, () => 5 * MB, 0, null, Infinity, () => 0).planned).toBe(3 * 5 * MB);
  expect(api.plannedWrites!(1, source => source === "perf-background" ? 5 * MB : 0, 0, null, Infinity, () => 0).planned).toBe(0);
});

it("the unknown-minute line names its cause: coverage when the OS count was read, diskWritten only when it was not", () => {
  const minute = (extra: Record<string, unknown>) => {
    let at = 0, flags: Record<string, unknown> = {};
    const lines: string[] = [];
    const budget = new IoBudget({ read: () => ({ at, fsWriteBlocks: 0, cpuMicros: 0, ...flags }) as never, log: line => lines.push(line), isIdle: () => true, systemOverloaded: () => null });
    budget.tick();
    flags = extra; at = MINUTE;
    budget.tick();
    return lines.filter(line => line.includes("unknown"));
  };
  const coverage = minute({ coverageKnown: false });
  expect(coverage).toHaveLength(1);
  expect(coverage[0]).toMatch(/^\[io-budget\] write coverage unknown \(/);
  expect(coverage[0]).not.toMatch(/diskWritten could not be read|os writes unknown/);
  expect(coverage[0]).toMatch(/background work runs at half rate/);
  const os = minute({ osKnown: false });
  expect(os).toHaveLength(1);
  expect(os[0]).toMatch(/^\[io-budget\] os writes unknown \(the engine-exclusion helper's diskWritten could not be read\)/);
});
