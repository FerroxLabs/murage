// SPDX-License-Identifier: AGPL-3.0-or-later
// T5 on the 103,935-message copy (designs/SMOOTH-FTS-MERGE-R6.md §6, §8): the worker's merge transactions and the foreground stall they
// cause, measured on the production scheduler. The §6 maxima are a QUALIFICATION CONTRACT, not a runtime guarantee (the allowance is
// output pages checked at term boundaries, so nothing bounds one slice by construction):
//   ordinary slice BEGIN..COMMIT p99 <= 10 ms and max <= 50 ms; a finishing slice and merge-prove max <= 250 ms; BEGIN never waits
//   (busy_timeout=0, read back by the worker); foreground stall p99 <= 20 ms and max <= 250 ms with no owner-path DATABASE_BUSY (503)
//   and no raw SQLITE_BUSY.
// Workloads: (a) the largest thread deleted into mixed segments, (b) a segment that is mostly tombstones, (c) common trigrams, (d) first,
// finishing and prove transactions told apart, (e) a concurrent main-thread insert loop and the `[loop] stall blocked=` line, (f) the
// worker's first write after a log restart. Reports transaction ms (p50, p99, max per kind), foreground stall, checkpoint ms apart from
// slices, and the busy-handler overshoot. FTS_QUAL_T5_PAGES sets the starting allowance (default SEARCH_MERGE_PAGES, 4: the value that held the contract; 8 did not).
// Skipped unless FTS_QUAL_103K_DIR holds a fresh copy under t5/ (testing/search-merge-103k.ts).
import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, transaction } from "./database.ts";
import { DatabaseBusyError, isDatabaseBusy } from "./db-busy.ts";
import { closeMessageDb, deleteThread, insertMessage } from "./message-db.ts";
import { setObserveSink, startLoopStallWatch, stopLoopStallWatch } from "./observe.ts";
import { resumeSearchMerge, SEARCH_MERGE_PAGES, searchMergeBusy, searchMergeFastPath, searchMergeOwing, searchMergeTestHooks, type SearchMergeEvent } from "./search-merge-runner.ts";
import { checkpointPassive, mergeOpTestHooks, stopWalMaintenance, walMaintenanceReady, walMaintenanceTestHooks } from "./wal-maintenance.ts";
import type { Message } from "./store.ts";
import { haveCopy, takeCopy } from "./testing/search-merge-103k.ts";
import { markerRow, spread } from "./testing/search-merge-fixtures.ts";

const NAME = "t5";
const PAGES = Number(process.env.FTS_QUAL_T5_PAGES ?? SEARCH_MERGE_PAGES);
let clock = Date.now();
const msg = (id: string, text: string): Message => ({ id, role: "user", kind: "text", text, at: ++clock });
const events: (SearchMergeEvent & { at: number; workload: string; held?: boolean })[] = [];
/** Test only (MurageMain 11-03, T5): the one burst prove per workload holds its write lock this long before COMMIT, so the burst's
 * inserts collide with it deterministically (a prove takes about 0.3 ms). A held prove counts for the collision check and is left
 * out of the prove timing class (its ms includes the hold). */
const PROVE_HOLD_MS = 30;
let workload = "setup";
const stallLines: string[] = [];
/** Live hooks the test sets: a slice that wrote nothing (the prove comes next) and a finishing slice (the segment count fell). */
const live = { onProveNext: (() => {}) as () => void, onProve: (() => {}) as () => void, finishing: new Set<string>(), lastSegments: -1 };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function paid(timeout = 900_000) {
  await vi.waitFor(() => { expect(markerRow(database())).toBeUndefined(); expect(searchMergeOwing()).toBe(false); }, { timeout, interval: 100 });
}
async function idle() { await vi.waitFor(() => expect(searchMergeBusy()).toBe(false), { timeout: 300_000, interval: 50 }); }

describe.skipIf(!haveCopy(NAME))("T5 worker transactions and foreground stall on the 103k copy (qualification contract, not a runtime guarantee)", () => {
  beforeAll(async () => {
    closeMessageDb(); closeDatabase(); await stopWalMaintenance();
    mkdirSync(DATA_DIR, { recursive: true });
    takeCopy(NAME);
    searchMergeTestHooks.startPages = PAGES; searchMergeTestHooks.segments = true; searchMergeTestHooks.kickMs = 250;
    searchMergeTestHooks.onEvent = event => {
      const holding = Boolean(mergeOpTestHooks.extra.holdMs);
      events.push({ ...event, at: performance.now(), workload, ...(holding && event.kind === "prove" ? { held: true } : {}) });
      // the hold is for that one prove only: any answer but a busy prove (which is sent again, still held) ends it
      if (holding && !(event.kind === "prove" && event.reply?.busy)) mergeOpTestHooks.extra = {};
      const r = event.reply;
      if (!r || r.busy || r.error || r.unavailable) return;
      if (event.kind === "first" || event.kind === "slice") {
        const segs = Number(r.segments ?? -1);
        if (live.lastSegments >= 0 && segs >= 0 && segs < live.lastSegments) live.finishing.add(workload);
        live.lastSegments = segs;
        if (r.wrote === false) live.onProveNext();
      }
      if (event.kind === "prove") live.onProve();
    };
    walMaintenanceTestHooks.retryMs = 1000;
    database();
    await vi.waitFor(() => { expect(walMaintenanceReady()).toBe(true); expect(searchMergeFastPath()).toBe(true); }, { timeout: 120_000 });
  }, 900_000);
  afterAll(async () => {
    searchMergeTestHooks.onEvent = null; mergeOpTestHooks.extra = {}; searchMergeTestHooks.segments = false; searchMergeTestHooks.startPages = SEARCH_MERGE_PAGES;
    walMaintenanceTestHooks.retryMs = 30_000;
    stopLoopStallWatch(); setObserveSink();
    closeMessageDb(); closeDatabase(); await stopWalMaintenance();
  }, 120_000);

  it(`the §6 maxima hold on the 103k copy with a starting allowance of ${PAGES} pages`, { timeout: 3_600_000 }, async () => {
    const db = database();
    // (e) the foreground: one owner-path insert every 5 ms, each timed; the stall watch's line is captured. The loop runs only for a
    // measurement window per workload (from just before the deletion until the run has answered FG_SLICES slices or FG_WINDOW_MS has
    // passed), then stops so the run can settle: under continuous writes the design gives no bounded completion (new segments keep the
    // structure changing, so merge-prove never finds it equal).
    setObserveSink(line => { if (line.includes("[loop] stall blocked=")) stallLines.push(line); });
    startLoopStallWatch();
    const fg: number[] = [];
    let fgBusy503 = 0, fgRawBusy = 0, fgOther = 0, running = true, n = 0;
    let fgOn = false, fgLoop: Promise<void> = Promise.resolve();
    /** Each foreground insert's span: an insert collided with a worker transaction when the two overlap. */
    const fgSpans: [number, number][] = [];
    const startForeground = () => {
      if (fgOn) return;
      fgOn = true;
      fgLoop = (async () => {
        while (fgOn) {
          const began = performance.now();
          try { insertMessage("t5-foreground", msg(`fg-${n++}`, `foreground insert ${n} lima mike november`)); }
          catch (error) { if (error instanceof DatabaseBusyError) fgBusy503++; else if (isDatabaseBusy(error)) fgRawBusy++; else fgOther++; }
          const ended = performance.now();
          fg.push(ended - began); fgSpans.push([began, ended]);
          await sleep(5);
        }
      })();
    };
    const stopForeground = async () => { fgOn = false; await fgLoop; };
    // The window per workload: from just before the deletion until the run has answered FG_SLICES slices AND finished at least one merge
    // (a finishing slice, so inserts collide with one), or FG_WINDOW_MS has passed. After it, the first prove of each workload gets a
    // burst of inserts from the slice that wrote nothing until the prove answers, so inserts collide with a prove too; one burst per
    // workload, so the run can still settle (each burst can cost at most one not-settled prove). That prove holds its lock PROVE_HOLD_MS.
    const FG_SLICES = 40, FG_WINDOW_MS = 60_000;
    const burst = new Set<string>();
    let bursting = false;
    live.onProveNext = () => {
      if (!fgOn && !burst.has(workload) && workload !== "f-after-restart") { burst.add(workload); bursting = true; mergeOpTestHooks.extra = { holdMs: PROVE_HOLD_MS }; startForeground(); }
    };
    live.onProve = () => { if (bursting) { bursting = false; void stopForeground(); } };
    const measureWindow = async () => {
      const opened = performance.now();
      const answered = () => events.filter(e => e.workload === workload && (e.kind === "first" || e.kind === "slice" || e.kind === "prove")).length;
      while ((answered() < FG_SLICES || !live.finishing.has(workload)) && performance.now() - opened < FG_WINDOW_MS && searchMergeOwing()) await sleep(50);
      await stopForeground();
    };
    // checkpoint ms, apart from slices: sampled PASSIVE answers (the worker measures each)
    const passiveMs: number[] = [];
    const sampler = (async () => { while (running) { const r = await checkpointPassive(); if (r.ms > 0) passiveMs.push(r.ms); await sleep(250); } })();

    const threads = db.prepare("SELECT thread_id AS t, count(*) AS n FROM messages WHERE thread_id NOT LIKE 't5-%' GROUP BY thread_id ORDER BY n DESC").all() as { t: string; n: number }[];
    // (a) the largest thread, deleted into the copy's mixed segments
    workload = "a-largest";
    startForeground();
    deleteThread(threads[0]!.t);
    await measureWindow();
    await paid();
    // (b) a segment that is mostly tombstones: 1,900 deleted rows and 100 kept in one transaction
    workload = "b-tombstones";
    transaction(() => {
      for (let i = 0; i < 1900; i++) insertMessage("t5-mostly", msg(`mt-${i}`, `mostly tombstoned row ${i} oscar papa quebec ${i * 13}`));
      for (let i = 0; i < 100; i++) insertMessage("t5-kept-b", msg(`kb-${i}`, `kept beside the tombstones ${i} romeo`));
    });
    await idle();
    startForeground();
    deleteThread("t5-mostly");
    await measureWindow();
    await paid();
    // (c) common trigrams: long posting lists for every term of the deleted rows
    workload = "c-common";
    const common = "the and that this with have from they will would there their what about which when make like time just know take";
    transaction(() => {
      for (let i = 0; i < 3000; i++) insertMessage("t5-common", msg(`cm-${i}`, `${common} ${i}`));
      for (let i = 0; i < 1000; i++) insertMessage("t5-kept-c", msg(`kc-${i}`, `${common} kept ${i}`));
    });
    await idle();
    startForeground();
    deleteThread("t5-common");
    await measureWindow();
    await paid();
    // (f) the worker's first write after a log restart: copy the whole log, then a deletion's first slice is the first commit
    await stopForeground();
    workload = "f-after-restart";
    await vi.waitFor(async () => { const r = await checkpointPassive(); expect(r.busy).toBe(0); expect(r.log).toBe(r.checkpointed); }, { timeout: 60_000 });
    running = false; await stopForeground(); await sampler; // nothing may write before the worker's first slice
    const small = (db.prepare("SELECT thread_id AS t, count(*) AS n FROM messages WHERE thread_id NOT LIKE 't5-%' GROUP BY thread_id HAVING n BETWEEN 5 AND 200 LIMIT 1").get() as { t: string } | undefined)!;
    searchMergeTestHooks.halt = true;
    deleteThread(small.t);
    // the deletion's frames are copied into the file; nothing writes again until the worker's first slice, which restarts the log
    await vi.waitFor(async () => { const r = await checkpointPassive(); expect(r.busy).toBe(0); expect(r.log).toBe(r.checkpointed); }, { timeout: 60_000 });
    searchMergeTestHooks.halt = false; resumeSearchMerge();
    await paid();
    stopLoopStallWatch(); setObserveSink();

    // (d) kinds: first (the run's -N), finishing (the segment count fell), prove, ordinary
    const answered = events.filter(e => e.reply && !e.reply.error && !e.reply.unavailable && (e.kind === "first" || e.kind === "slice" || e.kind === "prove"));
    const busy = answered.filter(e => e.reply!.busy).length;
    const done = answered.filter(e => !e.reply!.busy);
    const kinds: Record<string, number[]> = { ordinary: [], first: [], finishing: [], prove: [], proveHeld: [], afterRestart: [], tidy: [] };
    /** Foreground inserts that overlapped a transaction of each kind (the reply arrives at COMMIT: the span is [at - ms, at]). */
    const collidedWith: Record<string, number> = { ordinary: 0, first: 0, finishing: 0, prove: 0, tidy: 0 };
    const overlaps = (from: number, to: number) => fgSpans.filter(([a, b]) => a < to && b > from).length;
    let lastSegments = -1;
    for (const e of done) {
      const segs = Number(e.reply!.segments ?? -1);
      const fell = (e.kind === "first" || e.kind === "slice") && lastSegments >= 0 && segs >= 0 && segs < lastSegments;
      if (e.kind === "first" || e.kind === "slice") lastSegments = segs;
      if (e.workload === "f-after-restart" && e.kind === "first") kinds.afterRestart!.push(e.reply!.ms);
      const kind = e.kind === "prove" ? "prove" : e.kind === "first" ? "first" : fell ? "finishing" : e.phase === "tidy" ? "tidy" : "ordinary";
      kinds[kind === "prove" && e.held ? "proveHeld" : kind]!.push(e.reply!.ms); // a held prove's ms includes the test's hold
      collidedWith[kind] = (collidedWith[kind] ?? 0) + overlaps(e.at - e.reply!.ms, e.at);
    }
    const begins = done.map(e => Number(e.reply!.beginMs ?? 0));
    const slowest = Math.max(0, ...done.map(e => e.reply!.ms));
    const collided = fg.filter(ms => ms > 2);
    const report = {
      pages: PAGES, halvings: done.filter(e => e.allowance < PAGES).length,
      ms: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, spread(v)])),
      // the slice classes the §6 maxima name: an ordinary one is a run slice or a tidy slice that finished no merge
      ordinaryAll: spread([...kinds.ordinary!, ...kinds.tidy!]),
      begin: spread(begins), busyReplies: busy,
      foreground: { ...spread(fg), busy503: fgBusy503, rawBusy: fgRawBusy, other: fgOther },
      checkpoint: spread(passiveMs),
      // the busy handler's sleeps can overshoot the lock release (sqlite3.c:184306-184342): a collided insert's ms past the slowest slice
      overshoot: { collided: spread(collided), pastSlowestSlice: Math.round((Math.max(0, ...fg) - slowest) * 100) / 100 },
      stallLines: stallLines.slice(0, 20), stallCount: stallLines.length, collidedWith, bursts: [...burst], proveHoldMs: PROVE_HOLD_MS,
    };
    console.log(`[T5] ${JSON.stringify(report)}`);
    // an empty class measures nothing: every class the §6 maxima name must have samples, and the foreground must have collided with
    // ordinary, finishing and prove transactions
    for (const k of ["first", "finishing", "prove", "afterRestart"]) expect(report.ms[k]!.n, `${k} transactions measured`).toBeGreaterThan(0);
    expect(report.ms.proveHeld!.n, "each burst's prove was held (and left out of the prove class)").toBeGreaterThan(0);
    expect(report.ordinaryAll.n, "ordinary transactions measured").toBeGreaterThan(0);
    expect(report.foreground.n, "foreground inserts measured").toBeGreaterThan(0);
    for (const k of ["ordinary", "finishing", "prove"]) expect(collidedWith[k], `foreground inserts collided with a ${k} transaction`).toBeGreaterThan(0);
    const ordinary = report.ordinaryAll;
    expect(ordinary.p99, "ordinary slice p99 <= 10 ms").toBeLessThanOrEqual(10);
    expect(ordinary.max, "ordinary slice max <= 50 ms").toBeLessThanOrEqual(50);
    expect(Math.max(report.ms.finishing!.max, report.ms.first!.max), "finishing slice max <= 250 ms").toBeLessThanOrEqual(250);
    expect(report.ms.prove!.max, "merge-prove max <= 250 ms").toBeLessThanOrEqual(250);
    expect(report.foreground.p99, "foreground stall p99 <= 20 ms").toBeLessThanOrEqual(20);
    expect(report.foreground.max, "foreground stall max <= 250 ms").toBeLessThanOrEqual(250);
    expect(fgBusy503, "no owner-path DATABASE_BUSY").toBe(0);
    expect(fgRawBusy, "no raw SQLITE_BUSY").toBe(0);
    expect(fgOther).toBe(0);
  });
});
