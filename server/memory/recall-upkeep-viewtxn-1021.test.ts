// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-scope (recall view applier and upkeep, change journal); consumer owner: cause18d-viewtxn (PERF-JUDGE cause18 items 1-3).
// PERF-JUDGE cause18 2e5e70360c item 2: the upkeep caught each held view up in its OWN write transaction (BEGIN IMMEDIATE), so one change
// row cost 127 write transactions (~1.3 MB of WAL), and every commit re-armed the victim choice and the session lap (item 3). These witnesses
// run the real maintenance on 127 views each held by a live reader: one new record (one change row) must reach every view in at most 3 write
// transactions, a quiet store never arms the 50 ms pace, and the single transaction keeps each view's mark exact (a failed commit moves
// no view; one failing view never holds the others back).
//
// PORT (r8-upkeep-port). The 50 ms setTimeout tick (upkeepTick, maintainViews: one transaction, a savepoint per view) these rows drove was
// replaced by memv2 lane A's wake-driven fleet applier and upkeep (recall-view.ts runRecallApplier / applyRecallChanges / runRecallUpkeep on
// wake.ts) under:
//   MAIN-PICK 2026-11-23T00:35:11Z memv2-I = memv2-I-tests 70af151c66
//   MAIN-RULING 2026-11-23T03:41:32Z gate-1021-swarm ... merges memv2-I 70af151c66
// Bars kept: <= 3 write transactions for 127 views; a quiet minute arms the upkeep 0 times at 50 ms and at most 61 times and opens no write
// transaction; a failed commit moves no view and the next run (the applier's first retry, 1 s = the removed idle wait) moves all in ONE
// transaction; a failing view rolls back alone while the other 126 commit. Restated: an upkeep "arm" is a new due time of the
// recall-upkeep deadline (wake.ts deadlineOf) instead of a setTimeout(upkeepTick); the ">= 55 arms: the meter sees the upkeep at all"
// premise (a timer that never stops) is gone, and the meter is shown live instead by the catch-up it watched. The fleet persists member
// watermarks lazily (A3), so lag is read through recallViewProjection, the readers' own helper; the view's page writes are the fleet's set
// statements (one statement for every holder), so the crash and isolation faults are injected at those statements.
// Fake timers: the bus's deadlines are setTimeout on Date.now (both faked); its pump is setImmediate (left real, drained between steps).
import { mkdirSync } from 'node:fs';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { OWNER } from '../human-principals.ts';
import { stopSearchIndex } from '../message-search-index.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { stopWalMaintenance } from '../wal-maintenance.ts';
import { ensureScope, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { RECALL_UPKEEP_TOPIC } from './recall-view-schema.ts';
import { insertMemoryRecord } from './record-write.ts';
import { OWNER_PIN } from './schema.ts';
import { deadlineOf, wakeStats } from './wake.ts';
import * as views from './recall-view.ts';

const releases: (() => void)[] = [];
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database().exec(OWNER_PIN.sql); });
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const release of releases.splice(0)) release();
  views.stopRecallViewMaintenance(); closeDatabase();
});

/** The literal pace of the removed spec/1021 idle tick (RECALL_UPKEEP_IDLE_MS) and recall-view.ts RECALL_UPKEEP_MS (not exported). */
const IDLE_WAIT_MS = 1_000, RECALL_UPKEEP_MS = 50;
const immediate = () => new Promise<void>(resolve => setImmediate(resolve));
async function drain(): Promise<void> { for (let n = 0; n < 400; n++) { await immediate(); if (wakeStats().owed === 0) { await immediate(); if (wakeStats().owed === 0) return; } } }
/** Fake time in 10 ms steps; after each the bus is drained and any build or hydration in flight is let finish. */
async function run(ms: number, roster: MemoryRoster, each?: () => void): Promise<void> {
  for (let t = 0; t < ms; t += 10) { vi.advanceTimersByTime(10); await drain(); await views.waitForRecallConstructionIdleForTest(roster); await drain(); each?.(); }
}
const binding = (botId: string, threadId: string) => ({ botId, threadId, humanPrincipal: OWNER, notOwnerAudience: false });

/** 127 views, each held by a live reader, the maintenance running on faked deadlines and settled. */
async function heldStore(): Promise<{ roster: MemoryRoster; db: DatabaseSync; viewOf: (bot: string) => string }> {
  const bots = Array.from({ length: 127 }, (_, n) => ({ id: `bot-${n}`, threadId: `thread-${n}` }));
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots, groups: [] };
  reconcileMemoryRoster(roster);
  views.stopRecallViewMaintenance();
  for (const bot of bots) await views.prepareRecallContext(bot.id, bot.threadId, roster);
  const db = database(), ids = new Map<string, string>();
  expect(Number(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n)).toBe(127);
  for (const bot of bots) {
    const handle = views.resolveRecallView(binding(bot.id, bot.threadId), roster).handle;
    ids.set(bot.id, handle.viewId);
    releases.push(views.retainRecallView(handle, binding(bot.id, bot.threadId), () => true));
  }
  // the database's two worker threads (the search index's reset acknowledgement is one BEGIN IMMEDIATE at a real-time moment that can fall
  // inside a simulated window; the WAL checkpointer) are not the recall maintenance: stopped first, as controller-idle-1021 does
  await stopWalMaintenance(); await stopSearchIndex();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  views.startRecallViewMaintenance();
  await run(5_000, roster);
  return { roster, db, viewOf: bot => ids.get(bot)! };
}
const allViews = (db: DatabaseSync) => db.prepare('SELECT view_id,generation FROM memory_recall_views').all().map(row => ({ viewId: String(row.view_id), generation: String(row.generation) }));
/** Views whose read-through mark (the applied mark for a fleet member, else the persisted watermark) is below `newest`. */
const lagging = (db: DatabaseSync, newest: number) => allViews(db).filter(view => views.recallViewProjection(db, view)!.watermark < newest).length;
/** The one captured fact: a single record write, one change row in the shared journal that every view must read. */
function captureOne(db: DatabaseSync): number {
  insertMemoryRecord(db, { id: 'captured-fact', version: 1, scopeId: ensureScope('bot', 'bot-0'), kind: 'fact', text: 'one captured message the views have not read', assertion: 'owner-stated', state: 'active', validFrom: Date.now(), createdAt: Date.now() });
  const newest = Number(db.prepare('SELECT max(sequence) AS n FROM memory_recall_changes').get()!.n);
  expect(lagging(db, newest)).toBe(127);
  return newest;
}
const projected = (db: DatabaseSync, viewId: string) => Number(db.prepare("SELECT count(*) AS n FROM memory_recall_view_records WHERE view_id=? AND record_id='captured-fact'").get(viewId)!.n);
/** A view page's projection write: the fleet's set insert (every holder in one statement) or a lone view's own insert. */
const isViewRecordInsert = (sql: string) => sql.startsWith('INSERT INTO memory_recall_view_records');
/** Counts BEGIN IMMEDIATE; with failCommits, fails that many COMMITs of transactions that wrote a view's projection rows (the applier's
 *  pages, never the record write, the reclaim or the session steps). */
function countExec(db: DatabaseSync, failCommits = 0) {
  const counts = { begins: 0, failCommits, wroteView: false };
  const exec = db.exec.bind(db), prepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) => { if (isViewRecordInsert(sql)) counts.wroteView = true; return prepare(sql); });
  vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
    if (sql === 'BEGIN IMMEDIATE') { counts.begins++; counts.wroteView = false; }
    if (sql === 'COMMIT' && counts.wroteView && counts.failCommits > 0) { counts.failCommits--; throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10, errstr: 'disk I/O error' }); }
    return exec(sql);
  });
  return counts;
}
/** 50 ms steps until no view lags (or the step budget runs out: 20 s of maintenance). */
async function untilCaughtUp(db: DatabaseSync, roster: MemoryRoster, newest: number, steps = 400): Promise<void> {
  for (let n = 0; n < steps && lagging(db, newest) > 0; n++) await run(RECALL_UPKEEP_MS, roster);
}

it('W-VIEWTXN one captured message reaches all 127 held views in at most 3 write transactions, not 127', async () => {
  const { roster, db, viewOf } = await heldStore();
  const counts = countExec(db);
  const newest = captureOne(db);
  const before = counts.begins; // the record write's own transaction is not the maintenance's
  await untilCaughtUp(db, roster, newest);
  expect(lagging(db, newest)).toBe(0);
  // base 2e5e70360c: one BEGIN IMMEDIATE per view (127), each ~10 KB of WAL and a total_changes move that re-arms the victim choice and session lap
  expect(counts.begins - before).toBeLessThanOrEqual(3);
  // per view the page is exact: the one view whose scope holds the record projected it, no other did
  expect(projected(db, viewOf('bot-0'))).toBe(1);
  expect(projected(db, viewOf('bot-1'))).toBe(0);
}, 600_000);

it('W-QUIET-ARMS (PERF-JUDGE item 1 corrected bar) after the catch-up a quiet minute arms the upkeep 0 times at 50 ms and at most 61 times', async () => {
  const { roster, db } = await heldStore();
  const watched = countExec(db);
  const newest = captureOne(db);
  const before = watched.begins;
  await untilCaughtUp(db, roster, newest);
  expect(lagging(db, newest)).toBe(0);
  expect(watched.begins - before).toBeGreaterThanOrEqual(1); // the meter is live: it saw the catch-up's write transaction
  await run(5_000, roster); // warmup: whatever the catch-up left
  vi.restoreAllMocks();
  const counts = countExec(db);
  const arms: number[] = [];
  let last = deadlineOf(RECALL_UPKEEP_TOPIC);
  const sample = () => { const due = deadlineOf(RECALL_UPKEEP_TOPIC); if (due !== undefined && due !== last) arms.push(due - Date.now()); last = due; };
  await run(60_000, roster, sample);
  console.log('W-QUIET-ARMS', JSON.stringify({ arms: arms.length, fast: arms.filter(delay => delay <= RECALL_UPKEEP_MS).length, begins: counts.begins }));
  expect(arms.filter(delay => delay <= RECALL_UPKEEP_MS)).toEqual([]);
  expect(arms.length).toBeLessThanOrEqual(61);
  expect(counts.begins).toBe(0); // and a quiet minute opens no write transaction
}, 600_000);

it('W-VIEWTXN-CRASH a page whose commit fails moves no view past its applied page; the next run moves them all', async () => {
  const { roster, db, viewOf } = await heldStore();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const counts = countExec(db, 1);
  const newest = captureOne(db);
  // the first applier commit after the capture fails (an I/O error at COMMIT, the crash point between the pages and their marks)
  for (let n = 0; n < 40 && counts.failCommits > 0; n++) await run(RECALL_UPKEEP_MS, roster);
  expect(counts.failCommits).toBe(0);
  // all or nothing: no view kept a mark or a projected row from the page that failed
  expect(lagging(db, newest)).toBe(127);
  expect(projected(db, viewOf('bot-0'))).toBe(0);
  // the failed page is not progress (the next run comes within one idle wait), and that one run moves every view, in one transaction
  const begins = counts.begins;
  await run(IDLE_WAIT_MS, roster);
  expect(lagging(db, newest)).toBe(0);
  expect(counts.begins - begins).toBe(1);
  expect(projected(db, viewOf('bot-0'))).toBe(1);
}, 600_000);

const FACTS = [['fact-a', 'bot-0'], ['fact-b', 'bot-0'], ['fact-c', 'bot-1']] as const;
/** Three captured facts: two in bot-0's scope (one change page for its view projects fact-a, then fact-b), one in bot-1's. */
function captureFacts(db: DatabaseSync): number {
  for (const [id, bot] of FACTS) insertMemoryRecord(db, { id, version: 1, scopeId: ensureScope('bot', bot), kind: 'fact', text: `captured message ${id} the views have not read`, assertion: 'owner-stated', state: 'active', validFrom: Date.now(), createdAt: Date.now() });
  const newest = Number(db.prepare('SELECT max(sequence) AS n FROM memory_recall_changes').get()!.n);
  expect(lagging(db, newest)).toBe(127);
  return newest;
}
/** The projection rows (records or terms) one view holds for the captured facts. */
const factRows = (db: DatabaseSync, viewId: string, table: 'memory_recall_view_records' | 'memory_recall_view_terms') =>
  Number(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE view_id=? AND record_id IN ('fact-a','fact-b','fact-c')`).get(viewId)!.n);
const markOf = (db: DatabaseSync, viewId: string) => {
  const row = db.prepare('SELECT generation FROM memory_recall_views WHERE view_id=?').get(viewId)!;
  return views.recallViewProjection(db, { viewId, generation: String(row.generation) })!.watermark;
};
/** The statement a page writes a view's rows with, whose `?1` (a JSON list of [view, generation]) or `?` view binding names the view. */
const names = (values: unknown[], viewId: string) => values.some(value => value === viewId || (typeof value === 'string' && value.startsWith('[') && value.includes(JSON.stringify(viewId))));
/** Fails, for one view only, its projection write of fact-b (after the same page already wrote fact-a's rows: the record rows insert) or
 *  its last write of the page (after it wrote both facts' record rows: fact-b's term rows insert, the page's final write for that view; the
 *  fleet keeps no per-view watermark statement in a page, A3). Counts each injected failure, so a pass proves the view really ran its page
 *  and failed inside it. */
function breakView(db: DatabaseSync, viewId: string, at: 'projection' | 'watermark') {
  const broken: { at: 'projection' | 'watermark' | 'healed'; failures: number } = { at, failures: 0 };
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    const statement = prepare(sql);
    const target = isViewRecordInsert(sql) ? 'projection' : sql.startsWith('INSERT INTO memory_recall_view_terms') ? 'watermark' : undefined;
    if (!target) return statement;
    return new Proxy(statement, { get(object, key) {
      const value = Reflect.get(object, key, object);
      if (key !== 'run') return typeof value === 'function' ? value.bind(object) : value;
      return (...args: Parameters<StatementSync['run']>) => {
        const values = args as unknown[];
        if (broken.at === target && names(values, viewId) && values.includes('fact-b')) {
          broken.failures++;
          throw Object.assign(new Error('constraint failed'), { code: 'ERR_SQLITE_ERROR', errcode: 19, errstr: 'constraint failed' });
        }
        return statement.run(...args);
      };
    } });
  });
  return broken;
}

it.each(['watermark', 'projection'] as const)('W-VIEWTXN-ISOLATE (%s write fails) the failed view rolls back its projection rows and stays at its mark; the other 126 commit', async at => {
  const { roster, db, viewOf } = await heldStore();
  const victim = viewOf('bot-0'), mark = markOf(db, victim);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const broken = breakView(db, victim, at);
  const newest = captureFacts(db);
  for (let n = 0; n < 200 && lagging(db, newest) > 1; n++) await run(RECALL_UPKEEP_MS, roster);
  // the victim keeps being retried (and failing) after the others are done
  const failures = broken.failures;
  await run(3 * IDLE_WAIT_MS, roster);
  console.log('W-VIEWTXN-ISOLATE', at, JSON.stringify({ failures: broken.failures, before: failures, lagging: lagging(db, newest) }));
  expect(broken.failures).toBeGreaterThan(failures);
  // the other 126 views committed their pages, projection rows included (bot-1's view holds fact-c)
  expect(lagging(db, newest)).toBe(1);
  expect(factRows(db, viewOf('bot-1'), 'memory_recall_view_records')).toBe(1);
  // the victim's rollback undid every row its failed page wrote (fact-a's record and terms, and fact-b's record for the late failure)
  expect(factRows(db, victim, 'memory_recall_view_records')).toBe(0);
  expect(factRows(db, victim, 'memory_recall_view_terms')).toBe(0);
  expect(markOf(db, victim)).toBe(mark);
  // healed, the victim projects both facts from its exact mark
  broken.at = 'healed';
  await untilCaughtUp(db, roster, newest);
  expect(lagging(db, newest)).toBe(0);
  expect(factRows(db, victim, 'memory_recall_view_records')).toBe(2);
}, 600_000);
