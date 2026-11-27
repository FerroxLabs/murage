// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owners: lane q1022-idleburn-opus owns these witnesses; message-search-index.ts owns the step timer, the worker's replies and nudge();
// search-index-worker.ts owns the step itself.
//
// 1.0.22 idle burn (HIDDEN-COST-opus row 7): every idle reply of the search worker re-armed the step at 250 ms (10 ms after an append),
// forever: a worker step, a prune check and a retirement probe four times a second on an app doing nothing (x1117 a minute in the field).
// Real worker, real messages.db and search.db, the real reply handler (startSearchIndex). The clock is faked on the main thread only after
// the index is built and idle; each step timer that fires is counted (searchIndexTestHooks "timer") and its real worker reply awaited.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { initializeMessageTables } from "./message-tables.ts";
import * as search from "./message-search-index.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import * as wal from "./wal-maintenance.ts";

const realSetTimeout = globalThis.setTimeout;
const realSleep = (ms: number) => new Promise(r => realSetTimeout(r, ms));
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  vi.useRealTimers();
  search.searchIndexTestHooks.event = null;
  await search.stopSearchIndex();
  await wal.stopWalMaintenance(100, 1000);
  for (const f of cleanup.splice(0).reverse()) await f();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "murage-search-park-")); cleanup.push(() => removeTempDirSync(dir));
  const file = join(dir, "messages.db"), db = new DatabaseSync(file); cleanup.push(() => db.close());
  db.exec("PRAGMA journal_mode=WAL;PRAGMA journal_size_limit=0");
  initializeMessageTables(db);
  const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('fixture-thread',?,?,'user','text',?,'{}')");
  const append = (n: number, text: string) => { const row = insert.run(`m${n}`, n, text); search.syncMessageSearchRow(db, Number(row.lastInsertRowid), text); };
  const counts = { timers: 0, idle: 0, replies: 0, applied: 0 };
  search.searchIndexTestHooks.event = (e: { type: string; worked?: boolean; rebuilding?: boolean; applied?: number }) => {
    if (e.type === "timer") counts.timers++;
    if (e.type === "stepped") { counts.replies++; if (!e.worked && e.rebuilding === false) counts.idle++; if (e.worked && Number.isSafeInteger(e.applied)) counts.applied = Math.max(counts.applied, e.applied!); }
  };
  return { db, file, append, counts };
}
async function until(ms: number, done: () => boolean): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end && !done()) await realSleep(20);
  return done();
}
const found = (db: DatabaseSync, word: string) => search.readMessageSearchCandidates(db, search.trigramQuery(word), 500).rowids.length;

/** Move the fake main-thread clock `ms` in `step` slices; whenever a step timer fired, wait for the worker's real reply (and the timer it
 *  re-arms) before the clock moves on. Stops early once `done` holds. */
async function drive(f: ReturnType<typeof fixture>, ms: number, done: () => boolean = () => false, step = 25) {
  for (let t = 0; t < ms && !done(); t += step) {
    const before = f.counts.timers, replies = f.counts.replies;
    vi.advanceTimersByTime(step);
    if (f.counts.timers > before) await until(5_000, () => f.counts.replies > replies);
    else await new Promise(r => setImmediate(r));
  }
  return done();
}

it("W-SEARCH-PARK ten idle minutes on a fake clock: the search step wakes at most once a minute; a write still wakes it and is searchable", async () => {
  // the main thread's timers are fake from the start, so the step timer is always one this test moves (the worker runs on its own clock)
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const f = fixture();
  for (let n = 1; n <= 20; n++) f.append(n, `fixture words number ${n} alpha beta gamma`);
  search.startSearchIndex(f.db, f.file);
  // built, applied and pruned: the index is idle and owes nothing (at least one idle reply seen)
  const ready = () => search.messageSearchIndexReady(f.db) && search.intentCount(f.db) <= 1 && f.counts.idle >= 1;
  for (let i = 0; i < 400 && !ready(); i++) { await drive(f, 250, ready); if (!ready()) await realSleep(10); }
  expect(ready(), JSON.stringify(f.counts)).toBe(true);
  await drive(f, 2_000);
  const timers0 = f.counts.timers;
  await drive(f, 600_000, undefined, 250);
  const wakeups = f.counts.timers - timers0;
  console.log(`[W-SEARCH-PARK] step wakeups in 10 idle minutes: ${wakeups}`);
  // base: one every 250 ms, about 2,400
  expect(wakeups).toBeLessThanOrEqual(10);
  // still a working index: the old rows are found, and an append wakes the parked step and is indexed
  expect(found(f.db, "gamma")).toBe(20);
  // the worker itself must apply it (a pending row is also found by the fallback scan, so "found" alone would not prove the wake)
  const applied0 = f.counts.applied;
  f.append(21, "fixture words number 21 zebra quokka");
  const indexed = () => f.counts.applied > applied0 && found(f.db, "quokka") === 1;
  for (let i = 0; i < 200 && !indexed(); i++) { await drive(f, 100, indexed); if (!indexed()) await realSleep(10); }
  expect(indexed(), JSON.stringify(f.counts)).toBe(true);
}, 180_000);
