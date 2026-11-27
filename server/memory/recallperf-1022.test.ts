// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner of these witnesses and of the fixes they guard: q1022-recallperf (items 1, 2 and 5). Owner of the reclaimer and its admission:
// recallcap-1020-n3c (recall-reclaim-1020.test.ts holds its own witnesses; the fixture helpers below are copied from there).
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { threadHumanPrincipal } from '../human-principals.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { RecallCapacityPending } from './recall-recovery.ts';
import * as views from './recall-view.ts';

type Row = Record<string, SQLInputValue>;
const events: views.RecallReclaimEvent[] = [];
let unsubscribe: () => void = () => {};
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  events.length = 0; unsubscribe = views.subscribeRecallReclaim(event => events.push({ ...event }));
});
afterEach(() => {
  unsubscribe(); views.stopRecallViewMaintenance(); views.setRecallReclaimClockForTest(); views.setRecallReclaimLimitsForTest();
  vi.useRealTimers(); vi.restoreAllMocks(); closeDatabase();
});

const binding = (thread: string) => ({ botId: 'reader', threadId: thread, humanPrincipal: threadHumanPrincipal(thread), notOwnerAudience: false });
function seed(threads: string[]): { roster: MemoryRoster; db: DatabaseSync } {
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: threads[0]!, tasks: threads.slice(1).map(threadId => ({ threadId })) }], groups: [] };
  reconcileMemoryRoster(roster);
  for (const thread of threads.filter(thread => !thread.startsWith('late'))) views.prepareRecallContextSync('reader', thread, roster);
  return { roster, db: database() };
}
const contextView = (db: DatabaseSync, thread: string) => db.prepare('SELECT view_id,generation FROM memory_recall_contexts WHERE context_key=?').get(views.recallContextKey(binding(thread))) as Row | undefined;
let termBatch = 0;
function terms(db: DatabaseSync, view: Row, n: number): void {
  const add = db.prepare('INSERT INTO memory_recall_view_terms VALUES(?,?,?,?,?,?)'), batch = ++termBatch;
  db.exec('BEGIN'); for (let i = 0; i < n; i++) add.run(view.view_id, view.generation, `t${i}`, i, `r${batch}-${i}`, 1); db.exec('COMMIT');
}
function clone(db: DatabaseSync, source: Row, termCount = 40): Row {
  const view = { view_id: randomUUID(), generation: randomUUID() };
  db.prepare(`INSERT INTO memory_recall_views SELECT ?,?,authority_epoch,roster_revision,'building',scope_count,digest,room_reader,watermark
    FROM memory_recall_views WHERE view_id=? AND generation=?`).run(view.view_id, view.generation, source.view_id, source.generation);
  db.prepare('INSERT INTO memory_recall_view_scopes SELECT ?,?,scope_id,lineage_only,person_scope FROM memory_recall_view_scopes WHERE view_id=? AND generation=?').run(view.view_id, view.generation, source.view_id, source.generation);
  db.prepare("UPDATE memory_recall_views SET state='ready' WHERE view_id=? AND generation=?").run(view.view_id, view.generation);
  db.prepare('INSERT INTO memory_recall_thread_readers SELECT ?,?,eligible FROM memory_recall_thread_readers WHERE view_id=? AND generation=?').run(view.view_id, view.generation, source.view_id, source.generation);
  terms(db, view, termCount);
  return view;
}
/** One view's charge recomputed from its rows, the storage triggers' arithmetic (the base's per-call scan). */
function recomputedViewCharge(db: DatabaseSync, view: Row): number {
  let bytes = Number(db.prepare('SELECT coalesce(sum(512+4*length(CAST(term AS BLOB))),0) AS n FROM memory_recall_view_terms WHERE view_id=? AND generation=?').get(view.view_id, view.generation)!.n);
  for (const table of ['memory_recall_view_scopes', 'memory_recall_view_records', 'memory_recall_view_pending', 'memory_recall_view_jobs', 'memory_recall_contains'])
    bytes += 512 * Number(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE view_id=? AND generation=?`).get(view.view_id, view.generation)!.n);
  return bytes;
}
const settle = async () => { for (let n = 0; n < 50; n++) await new Promise<void>(resolve => setImmediate(resolve)); };
/** The term scan of one view: the 412 ms statement in the owner's log (HIDDEN-COST-opus #10). */
const TERM_SCAN = /sum\(512\+4\*length\(CAST\(term AS BLOB\)\)\).*FROM memory_recall_view_terms WHERE view_id=\? AND generation=\?/s;

// ITEM 1 (recall-view.ts chargedViewBytes, :1901-1914 on base): a demand refused for quota is asked again on every turn. Each ask re-checks
// the bytes in use, which on base sums every term row of every view in use. With the trigger-kept counter, each view in use is counted once
// and every later ask reads its counter: 10 more turns run 0 term scans.
it('ITEM1: ten more turns on a quota-refused context scan no view terms, and the counter tracks every insert and delete', async () => {
  const { db, roster } = seed(['direct', 'late']);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const held = contextView(db, 'direct')!;
  db.prepare("UPDATE memory_recall_views SET digest='another-membership' WHERE view_id=?").run(held.view_id);
  terms(db, held, 300);
  // The held view is in use (an active build holds it), so every quota re-check charges it.
  const release = views.holdRecallViewForTest(db, String(held.view_id), 'build');
  views.setRecallReclaimLimitsForTest({ quota: 1, headroom: 1 });
  expect(() => views.resolveRecallView(binding('late'), roster)).toThrow();
  await settle();
  expect(events.filter(event => event.kind === 'refuse'), 'the demand is refused for quota').toHaveLength(1);
  const prepare = vi.spyOn(db, 'prepare');
  for (let turn = 0; turn < 10; turn++) {
    expect(() => views.resolveRecallView(binding('late'), roster)).toThrow(RecallCapacityPending);
    await settle();
  }
  // inUseBytes's own walk of the views: the refused demand's bytes in use were re-checked on the later turns.
  const rechecks = prepare.mock.calls.filter(([sql]) => sql === 'SELECT view_id,generation FROM memory_recall_views').length;
  expect(rechecks, 'the refused demand was re-checked on the later turns').toBeGreaterThanOrEqual(10);
  const scans = prepare.mock.calls.filter(([sql]) => TERM_SCAN.test(String(sql))).length;
  expect(scans, 'term scans over ten more turns of a refused context').toBe(0);
  prepare.mockRestore();
  // The counter is the triggers' arithmetic: inserts, deletes and a whole view's delete on this connection all reach it.
  expect(views.recallChargedViewBytesForTest(db, held), 'counter after seeding').toBe(recomputedViewCharge(db, held));
  terms(db, held, 25);
  db.prepare("DELETE FROM memory_recall_view_terms WHERE view_id=? AND generation=? AND term IN ('t1','t2','t3')").run(held.view_id, held.generation);
  db.prepare('INSERT INTO memory_recall_view_records VALUES(?,?,?,?,?,?,?,?,?)').run(held.view_id, held.generation, 'extra-record', 1, 9_999, 'fact', 0, 'active', 'scope-x');
  expect(views.recallChargedViewBytesForTest(db, held), 'counter after inserts and deletes').toBe(recomputedViewCharge(db, held));
  // A commit by another connection is never trusted to a counter: the next read counts again.
  const other = new DatabaseSync(String(db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')!.file));
  try { other.prepare('DELETE FROM memory_recall_view_terms WHERE view_id=? AND generation=? AND term=?').run(held.view_id, held.generation, 't10'); } finally { other.close(); }
  expect(views.recallChargedViewBytesForTest(db, held), 'counter after a foreign commit').toBe(recomputedViewCharge(db, held));
  release();
});

// ITEM 2 (recall-view.ts:1265 and the queue's again() on base): a waiting reader's build held at the reclaim bucket yields and is resumed on the
// next setImmediate, re-checking the gate as fast as the loop turns (one core). Now it looks again every RECALL_GATE_WAIT_MS. Timers are fake
// from the turn on, so the count is per simulated second: on base the immediates never let the clock move.
it('ITEM2: a waiting build held at the reclaim bucket checks the gate at most 20 times in one simulated second, and still waits', () => {
  const { db, roster } = seed(['direct', 'late']);
  const cold = contextView(db, 'direct')!;
  db.prepare("UPDATE memory_recall_views SET digest='another-membership' WHERE view_id=?").run(cold.view_id);
  // The bucket never refills (its clock stands still) and every measured slice costs 40 MB, so after one slice the bucket refuses the next.
  let gateChecks = 0, written = 0;
  const frozen = Date.now();
  views.setRecallReclaimClockForTest({ now: () => frozen, written: () => (written += 40_000_000), wal: () => { gateChecks++; return null; } });
  vi.useFakeTimers({ toFake: ['setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  expect(() => views.resolveRecallView(binding('late'), roster)).toThrow();
  const run = (ms: number) => { const until = Date.now() + ms; for (let step = 0; step < 5_000 && Date.now() < until; step++) vi.advanceTimersToNextTimer(); };
  run(200);
  const before = gateChecks;
  run(1_000);
  const inOneSecond = gateChecks - before;
  expect(before, 'the waiting build reached the bucket gate').toBeGreaterThan(0);
  expect(inOneSecond, 'the build still checks the gate while it waits').toBeGreaterThan(0);
  const late = contextView(db, 'late');
  const state = late ? db.prepare('SELECT state FROM memory_recall_views WHERE view_id=? AND generation=?').get(late.view_id, late.generation)?.state : undefined;
  expect(state, 'the build is still held at the gate').not.toBe('ready');
  expect(inOneSecond, 'gate checks in one simulated second of bucket wait').toBeLessThanOrEqual(20);
});

// ITEM 5 (recall-view.ts:2175-2179 on base): a context refused for quota stays refused until the epoch or roster moves or the bytes in use
// drop, with no time ceiling. Now the refusal stands for RECALL_QUOTA_RETRY_MS, and the first demand after it is admitted afresh.
it('ITEM5: a quota refusal stands until the time ceiling, then the next turn builds the context once room exists', async () => {
  const { db, roster } = seed(['direct', 'late']);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db.prepare("UPDATE memory_recall_views SET digest='another-membership' WHERE view_id=?").run(contextView(db, 'direct')!.view_id);
  clone(db, contextView(db, 'direct')!);
  let now = Date.now();
  views.setRecallReclaimClockForTest({ now: () => now, written: () => 0 });
  views.setRecallReclaimLimitsForTest({ quota: 1, headroom: 1 });
  expect(() => views.resolveRecallView(binding('late'), roster)).toThrow();
  await settle();
  expect(events.filter(event => event.kind === 'refuse'), 'refused for quota').toHaveLength(1);
  // The quota grows back (in the owner's store: views elsewhere were freed without touching the bytes this demand counted as in use).
  views.setRecallReclaimLimitsForTest();
  // The ceiling is ten minutes (a literal, so a mutated constant cannot move this clock with it).
  now += 600_000 - 1_000;
  expect(() => views.resolveRecallView(binding('late'), roster)).toThrow(RecallCapacityPending);
  // As long as the build below is given, so a retry inside the ceiling would have published by now.
  for (let n = 0; n < 40; n++) { await settle(); await new Promise(resolve => setTimeout(resolve, 25)); }
  expect(contextView(db, 'late'), 'inside the ceiling the refusal still stands').toBeUndefined();
  now += 2_000;
  expect(() => views.resolveRecallView(binding('late'), roster)).toThrow();
  for (let n = 0; n < 40 && !contextView(db, 'late'); n++) { await settle(); await new Promise(resolve => setTimeout(resolve, 25)); }
  expect(contextView(db, 'late'), 'past the ceiling the next turn builds the refused context').toBeDefined();
});
