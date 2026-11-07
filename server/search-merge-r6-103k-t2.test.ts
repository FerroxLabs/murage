// SPDX-License-Identifier: AGPL-3.0-or-later
// T2 on the 103,935-message copy (designs/SMOOTH-FTS-MERGE-R6.md §6, §8). QUALIFICATION CONTRACT, not a runtime guarantee: the one
// budgeted figure is the deletion's main-thread time with the fast path active (< 100 ms for the 2,056-row thread with a run in flight
// and 4 level-0 segments). Every other case is degraded, unbudgeted latency that is measured and reported, never asserted: the config
// forced back to the defaults (flag false), the COMMIT that crosses the crisismerge threshold with the worker stopped and in backoff,
// and a cascade into level 1. Skipped unless FTS_QUAL_103K_DIR holds a fresh copy under t2/ (testing/search-merge-103k.ts).
import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { closeMessageDb, deleteThread, insertMessage } from "./message-db.ts";
import { kickSearchMerge, resumeSearchMerge, searchMergeFastPath, searchMergeOwing, searchMergeTestHooks, type SearchMergeEvent, SEARCH_MERGE_PAGES } from "./search-merge-runner.ts";
import { mergeOpTestHooks, stopWalMaintenance, walMaintenanceReady, walMaintenanceTestHooks } from "./wal-maintenance.ts";
import type { Message } from "./store.ts";
import { haveCopy, takeCopy } from "./testing/search-merge-103k.ts";
import { ftsLevels, markerRow, spread, tombstonePages } from "./testing/search-merge-fixtures.ts";

const NAME = "t2";
const events: SearchMergeEvent[] = [];
const report: Record<string, unknown> = {};
let clock = Date.now();
const msg = (id: string, text: string): Message => ({ id, role: "user", kind: "text", text, at: ++clock });
const threads = () => database().prepare("SELECT thread_id AS t, count(*) AS n FROM messages GROUP BY thread_id ORDER BY n DESC").all() as { t: string; n: number }[];
const config = () => Object.fromEntries(database().prepare("SELECT k, v FROM messages_fts_config WHERE k IN ('automerge','deletemerge','usermerge')").all().map(r => [String(r.k), Number(r.v)]));
async function paid(timeout = 600_000) {
  await vi.waitFor(() => { expect(markerRow(database())).toBeUndefined(); expect(searchMergeOwing()).toBe(false); }, { timeout, interval: 100 });
}
/** Inserts one row per commit until level 0 shrinks (crisismerge fired inside a COMMIT); returns that COMMIT's ms and the count. */
function untilCrisis(tag: string, limit = 400) {
  for (let i = 0; i < limit; i++) {
    const before = ftsLevels(database())[0]?.segments ?? 0;
    const began = performance.now();
    insertMessage(`crisis-${tag}`, msg(`${tag}-${i}`, `crisis ${tag} insert ${i} golf hotel india`));
    const ms = performance.now() - began;
    if ((ftsLevels(database())[0]?.segments ?? 0) < before) return { inserts: i + 1, ms: Math.round(ms * 100) / 100 };
  }
  return { inserts: -1, ms: -1 };
}

describe.skipIf(!haveCopy(NAME))("T2 fast path on the 103k copy (qualification contract)", () => {
  beforeAll(async () => {
    closeMessageDb(); closeDatabase(); await stopWalMaintenance();
    mkdirSync(DATA_DIR, { recursive: true });
    takeCopy(NAME);
    searchMergeTestHooks.onEvent = event => { events.push(event); };
    walMaintenanceTestHooks.retryMs = 1000;
    const opened = performance.now();
    database();
    report.openMs = Math.round(performance.now() - opened);
    await vi.waitFor(() => { expect(walMaintenanceReady()).toBe(true); expect(searchMergeFastPath()).toBe(true); }, { timeout: 120_000 });
    report.messages = Number(database().prepare("SELECT count(*) AS n FROM messages").get()!.n);
    report.indexed = Number(database().prepare("SELECT count(*) AS n FROM messages_fts_docsize").get()!.n);
    report.levelsAtOpen = ftsLevels(database()).map(l => l.segments);
  }, 900_000);
  afterAll(async () => {
    console.log(`[T2] ${JSON.stringify(report)}`);
    searchMergeTestHooks.onEvent = null; searchMergeTestHooks.halt = false; searchMergeTestHooks.startPages = SEARCH_MERGE_PAGES; mergeOpTestHooks.extra = {};
    walMaintenanceTestHooks.retryMs = 30_000;
    closeMessageDb(); closeDatabase(); await stopWalMaintenance();
  }, 120_000);

  it("deleting the 2,056-row thread with a run in flight and 4 level-0 segments takes < 100 ms on the main thread (fast path read back 0, 0, 4)", { timeout: 900_000 }, async () => {
    const all = threads();
    // the design's figure is the 2,056-row thread of the 1.0.15 measurement; the pristine copy today has none of exactly that size, so the
    // budget is held on the thread closest to it (2,053 rows on the 11-03 copy); the true largest is timed on the fast path below too
    const largest = [...all].sort((a, b) => Math.abs(a.n - 2056) - Math.abs(b.n - 2056))[0]!;
    report.budgetThread = largest.n;
    expect(Math.abs(largest.n - 2056)).toBeLessThanOrEqual(10);
    expect(config()).toEqual({ automerge: 0, deletemerge: 0, usermerge: 4 });
    expect(searchMergeFastPath()).toBe(true);
    // a run in flight: a small deletion owes a merge; the run is held after a few slices with its merge in progress
    const small = [...all].reverse().find(row => row.n >= 20 && row.n <= 200)!;
    searchMergeTestHooks.startPages = 1;
    let slices = 0;
    searchMergeTestHooks.onEvent = event => { events.push(event); if ((event.kind === "first" || event.kind === "slice") && ++slices >= 3) searchMergeTestHooks.halt = true; };
    deleteThread(small.t);
    await vi.waitFor(() => expect(slices).toBeGreaterThanOrEqual(3), { timeout: 60_000 });
    // 4 level-0 segments: 4 rows, one commit each
    for (let i = 0; i < 4; i++) insertMessage("level0", msg(`l0-${i}`, `level zero segment ${i} juliet kilo`));
    report.levelsBeforeDelete = ftsLevels(database()).map(l => ({ segs: l.segments, merging: l.merging }));
    expect(ftsLevels(database())[0]!.segments).toBeGreaterThanOrEqual(4);
    expect(ftsLevels(database()).some(l => l.merging > 0)).toBe(true);
    searchMergeTestHooks.onEvent = event => { events.push(event); };
    searchMergeTestHooks.halt = false; resumeSearchMerge(); // the next slice is posted now: in flight in the worker as the delete begins
    const began = performance.now();
    deleteThread(largest.t);
    const deleteMs = performance.now() - began;
    report.deleteMsFastPath = Math.round(deleteMs * 100) / 100;
    console.log(`[T2] fast path: deleteThread(${largest.n} rows) main-thread ms=${report.deleteMsFastPath}`);
    expect(deleteMs).toBeLessThan(100);
    searchMergeTestHooks.startPages = SEARCH_MERGE_PAGES;
    const runStarted = Date.now();
    await paid();
    report.runToScrubDoneMs = Date.now() - runStarted;
    expect(tombstonePages(database())).toBe(false);
    // the true largest thread on the fast path, with a run in flight: timed and reported (the budget names the 2,056-row thread)
    const biggest = threads()[0]!;
    const fresh = events.length; // only this run's events count: the run must really be in flight
    deleteThread(threads().find(row => row.n >= 20 && row.n <= 200 && row.t !== biggest.t)!.t);
    await vi.waitFor(() => expect(events.slice(fresh).some(e => e.kind === "first")).toBe(true), { timeout: 60_000 });
    const began2 = performance.now();
    deleteThread(biggest.t);
    report.deleteMsLargestFastPath = { rows: biggest.n, ms: Math.round((performance.now() - began2) * 100) / 100 };
    console.log(`[T2] fast path, largest thread: ${JSON.stringify(report.deleteMsLargestFastPath)} (reported)`);
    await paid();
  });

  it("the config forced back to the defaults (flag false): the same kind of delete is timed and reported, not budgeted", { timeout: 900_000 }, async () => {
    const db = database();
    searchMergeTestHooks.halt = true;
    mergeOpTestHooks.extra = { configReadOnly: true }; // the worker reads back without rewriting, so the flag goes false
    db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('automerge', 4)");
    db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('deletemerge', 10)");
    searchMergeTestHooks.halt = false;
    kickSearchMerge();
    await vi.waitFor(() => expect(events.some(e => e.kind === "config" && e.reply?.fast === false)).toBe(true), { timeout: 60_000 });
    expect(searchMergeFastPath()).toBe(false);
    const next = threads()[0]!;
    searchMergeTestHooks.halt = true;
    const began = performance.now();
    deleteThread(next.t);
    report.deleteMsDefaults = { rows: next.n, ms: Math.round((performance.now() - began) * 100) / 100 };
    console.log(`[T2] defaults (flag false): deleteThread(${next.n} rows) ms=${JSON.stringify(report.deleteMsDefaults)} (degraded, unbudgeted)`);
    mergeOpTestHooks.extra = {};
    searchMergeTestHooks.halt = false; resumeSearchMerge();
    await paid();
    kickSearchMerge(); // the next marker read rewrites the literals and declares the fast path again
    await vi.waitFor(() => expect(searchMergeFastPath()).toBe(true), { timeout: 60_000 });
  });

  it("crisismerge: the COMMIT that crosses 16 level-0 segments with the worker stopped, and with it in backoff, and a cascade into level 1, are timed and reported", { timeout: 900_000 }, async () => {
    searchMergeTestHooks.halt = true; // the worker stopped: no merge op is posted
    report.crisisStopped = untilCrisis("stopped");
    // in backoff: a lost reply sends the scheduler into a long backoff
    searchMergeTestHooks.halt = false; searchMergeTestHooks.replyLostMs = 200; searchMergeTestHooks.backoffFirstMs = 600_000;
    mergeOpTestHooks.extra = { drop: true };
    kickSearchMerge();
    await vi.waitFor(() => expect(events.some(e => e.kind === "backoff")).toBe(true), { timeout: 60_000 });
    mergeOpTestHooks.extra = {};
    report.crisisBackoff = untilCrisis("backoff");
    // a cascade: level-0 crises fill level 1 until it reaches 16 and crisismerge climbs (no latency budget). Level 1 grows by far less
    // than one segment per crisis on this copy (promotion folds outputs: 7 after 40 rounds on 11-03), so the rounds run until it is seen
    searchMergeTestHooks.halt = true;
    const crossings: number[] = [];
    const shapes: number[][] = [];
    for (let round = 0; round < 1200; round++) {
      const before = ftsLevels(database()).map(l => l.segments);
      const crossing = untilCrisis(`cascade${round}`);
      crossings.push(crossing.ms);
      const after = ftsLevels(database()).map(l => l.segments);
      shapes.push(after);
      // a cascade: some level above 0 lost segments in the same COMMIT
      if (after.some((n, level) => level > 0 && n < (before[level] ?? 0))) { report.cascade = { round, ms: crossing.ms, before, after }; break; }
    }
    report.cascadeShapes = shapes.slice(0, 6).concat(shapes.slice(-3));
    report.cascadeCrossings = { rounds: crossings.length, ...spread(crossings) };
    console.log(`[T2] crisismerge (reported, not budgeted): stopped=${JSON.stringify(report.crisisStopped)} backoff=${JSON.stringify(report.crisisBackoff)} cascade=${JSON.stringify(report.cascade ?? null)} crossings=${JSON.stringify(report.cascadeCrossings)}`);
    expect((report.crisisStopped as { inserts: number }).inserts).toBeGreaterThan(0);
    expect((report.crisisBackoff as { inserts: number }).inserts, "the crossing with the worker in backoff was seen").toBeGreaterThan(0);
    expect(report.cascade, "a cascade above level 0 was seen").toBeDefined();
    searchMergeTestHooks.halt = false; searchMergeTestHooks.replyLostMs = 60_000; searchMergeTestHooks.backoffFirstMs = 30_000;
  });
});
