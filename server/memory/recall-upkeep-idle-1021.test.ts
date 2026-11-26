// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-scope (recall view upkeep and applier); consumer owner: cause8-memload (the 1.0.21 owner-copy background write load).
// 1.0.21 owner copy (quiet minutes, no turn): the upkeep timer ran every 50 ms whether or not anything was left to do. Every quiet minute
// logged ~1,150 COMMITs and ~1,145 reclaim-victim scans, each tick opening a BEGIN IMMEDIATE (the write lock) for a view already at the
// newest change. These witnesses run the real maintenance (startRecallViewMaintenance on the real wake bus) on a real ready view: a quiet
// store takes no write transaction and does not run at all, and a record written after a long quiet spell still reaches the view at once.
//
// PORT (r8-upkeep-port). The mechanism these rows were written against (the 50 ms setTimeout tick with its 1000 ms idle backoff,
// RECALL_UPKEEP_IDLE_MS) was replaced by memv2 lane A's wake-driven applier and upkeep (recall-view.ts runRecallApplier / runRecallUpkeep,
// wake.ts) under:
//   MAIN-PICK 2026-11-23T00:35:11Z memv2-I = memv2-I-tests 70af151c66
//   MAIN-RULING 2026-11-23T03:41:32Z gate-1021-swarm ... merges memv2-I 70af151c66
// There is no timer at rest any more, so the "slows to its idle pace (55..70 ticks a minute)" premise is restated as the stronger bar of the
// new design: a quiet minute runs the bus 0 times, arms the upkeep 0 times and opens 0 write transactions. "Within one idle wait" (1,050 ms)
// becomes "within RECALL_APPLIER_MS (50 ms)": the journal commit wakes the applier itself. Watermarks are read through the production
// reader helper recallViewProjection (a fleet member's persisted watermark is written lazily, A3; its applied mark is what readers use).
// Fake timers: the bus's deadlines are setTimeout on Date.now (both faked); its pump is setImmediate (left real, drained between steps).
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { stopSearchIndex } from '../message-search-index.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { stopWalMaintenance } from '../wal-maintenance.ts';
import { ensureScope, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { insertMemoryRecord } from './record-write.ts';
import { RECALL_UPKEEP_TOPIC } from './recall-view-schema.ts';
import { deadlineOf, wakeStats } from './wake.ts';
import * as views from './recall-view.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { views.stopRecallViewMaintenance(); vi.restoreAllMocks(); vi.useRealTimers(); closeDatabase(); });

/** recall-view.ts RECALL_UPKEEP_MS (not exported): the pace the upkeep looks again at while it has a named cause. */
const RECALL_UPKEEP_MS = 50;
const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
const immediate = () => new Promise<void>(resolve => setImmediate(resolve));
/** Lets the bus's pump (real setImmediate) run every slice it owes. */
async function drain(): Promise<void> { for (let n = 0; n < 400; n++) { await immediate(); if (wakeStats().owed === 0) { await immediate(); if (wakeStats().owed === 0) return; } } }
/** Fake time in 10 ms steps, the bus drained after each (a deadline armed by a slice is then honoured by the next step). */
async function run(ms: number, each?: () => void): Promise<void> { for (let t = 0; t < ms; t += 10) { vi.advanceTimersByTime(10); await drain(); each?.(); } }

function readyView() {
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct' }], groups: [] };
  reconcileMemoryRoster(roster);
  views.prepareRecallContextSync('reader', 'direct', roster);
  const db = database();
  const view = db.prepare('SELECT v.view_id,v.generation,v.watermark FROM memory_recall_contexts c JOIN memory_recall_views v ON v.view_id=c.view_id AND v.generation=c.generation').get();
  expect(view).toBeTruthy();
  return { db, view: { viewId: String(view!.view_id), generation: String(view!.generation) } };
}
/** The two real worker threads the database starts (the message search index acknowledging its reset: one BEGIN IMMEDIATE at a real-time
 *  moment that can fall inside a simulated minute; the WAL checkpointer) are not the recall maintenance: stopped before fake time starts,
 *  as controller-idle-1021 does (FABLE memv2-E 8d5a955d63 M1). */
async function memoryOnly(): Promise<void> { await stopWalMaintenance(); await stopSearchIndex(); }
/** Counts what the maintenance does: bus slices run (applier and upkeep), upkeep deadlines armed, and write transactions opened. */
function meter(db: ReturnType<typeof database>) {
  const counts = { begins: 0, runs0: wakeStats().runs, arms: 0, last: deadlineOf(RECALL_UPKEEP_TOPIC) };
  const exec = db.exec.bind(db);
  vi.spyOn(db, 'exec').mockImplementation((sql: string) => { if (sql === 'BEGIN IMMEDIATE') counts.begins++; return exec(sql); });
  const sample = () => { const due = deadlineOf(RECALL_UPKEEP_TOPIC); if (due !== undefined && due !== counts.last) counts.arms++; counts.last = due; };
  return { counts, sample, runs: () => wakeStats().runs - counts.runs0 };
}
const mark = (db: ReturnType<typeof database>, view: { viewId: string; generation: string }) => views.recallViewProjection(db, view)!.watermark;

it('a quiet store: the maintenance takes no write transaction and does not run at all (one minute: 0 slices, 0 upkeep arms, not 1,200 ticks)', async () => {
  const { db } = readyView();
  await memoryOnly();
  fake();
  views.startRecallViewMaintenance();
  await run(2_000); // settle whatever the build left
  const { counts, sample, runs } = meter(db);
  await run(60_000, sample);
  // base 1.0.21: 1,200 ticks and one BEGIN IMMEDIATE each; spec/1021: 55..70 idle ticks. memv2: nothing written, nothing due, nothing runs.
  expect({ begins: counts.begins, runs: runs(), arms: counts.arms }).toEqual({ begins: 0, runs: 0, arms: 0 });
}, 240_000);

it('after a long quiet spell a new record still reaches the view at once (within RECALL_APPLIER_MS, no idle wait)', async () => {
  const { db, view } = readyView();
  await memoryOnly();
  fake();
  views.startRecallViewMaintenance();
  await run(60_000);
  insertMemoryRecord(db, { id: 'quiet-record', version: 1, scopeId: ensureScope('bot', 'reader'), kind: 'fact', text: 'the quiet spell ended', assertion: 'owner-stated', state: 'active', validFrom: Date.now(), createdAt: Date.now() });
  const newest = Number(db.prepare('SELECT max(sequence) AS n FROM memory_recall_changes').get()!.n);
  expect(mark(db, view)).toBeLessThan(newest);
  await run(views.RECALL_APPLIER_MS);
  const projected = Number(db.prepare("SELECT count(*) AS n FROM memory_recall_view_records WHERE view_id=? AND generation=? AND record_id='quiet-record'").get(view.viewId, view.generation)!.n);
  expect({ watermark: mark(db, view), projected }).toEqual({ watermark: newest, projected: 1 });
}, 240_000);

// Opus self-review M1: the owner copy keeps stale contexts (an epoch move leaves them persisted and refused until rebuilt). Each refuses
// its page, which is no progress; the views after them must still catch up at once, not one idle wait per stale context.
it('stale contexts ahead in the round robin do not slow the views that can catch up', async () => {
  const threads = Array.from({ length: 12 }, (_, n) => `t-${String(n).padStart(2, '0')}`);
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: threads[0]!, tasks: threads.slice(1).map(threadId => ({ threadId })) }], groups: [] };
  reconcileMemoryRoster(roster);
  for (const thread of threads) views.prepareRecallContextSync('reader', thread, roster);
  const db = database();
  const bound = db.prepare('SELECT c.context_key,v.view_id,v.generation FROM memory_recall_contexts c JOIN memory_recall_views v ON v.view_id=c.view_id AND v.generation=c.generation ORDER BY c.context_key').all();
  expect(bound.length).toBe(threads.length);
  // the first ten in context order go stale (as an epoch move leaves them); the last two stay current
  const stale = bound.slice(0, 10), live = bound.slice(10);
  for (const row of stale) db.prepare('UPDATE memory_recall_views SET authority_epoch=authority_epoch-1 WHERE view_id=? AND generation=?').run(String(row.view_id), String(row.generation));
  await memoryOnly();
  fake();
  views.startRecallViewMaintenance();
  await run(60_000);
  insertMemoryRecord(db, { id: 'after-quiet', version: 1, scopeId: ensureScope('bot', 'reader'), kind: 'fact', text: 'one more fact', assertion: 'owner-stated', state: 'active', validFrom: Date.now(), createdAt: Date.now() });
  const newest = Number(db.prepare('SELECT max(sequence) AS n FROM memory_recall_changes').get()!.n);
  // one 50 ms step per context in the lap (plus slack), with no idle wait to notice; one idle wait per stale context would be ~10 s
  await run(2 * threads.length * RECALL_UPKEEP_MS);
  expect(live.map(row => mark(db, { viewId: String(row.view_id), generation: String(row.generation) }))).toEqual(live.map(() => newest));
}, 240_000);
