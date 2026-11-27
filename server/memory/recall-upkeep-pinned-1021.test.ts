// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-scope (recall view upkeep, applier, reclaimer); consumer owner: cause18-idleperf (1.0.21 owner copy overnight idle load).
// 1.0.21 owner copy, 9.5 h overnight with no turn: the upkeep never left the 50 ms pace (about 1,127 ticks a minute) and each tick chose a
// reclaim victim again (two full memory_recall_views scans, the ready views sorted), finding none every time. These witnesses run the real
// maintenance on a full store: every view held by a live reader, the store over 75% of its quota, one first turn parked because every view
// is in use, and every view behind the journal with its write refused (the lock is busy: BEGIN IMMEDIATE answers SQLITE_BUSY at once, as it
// does while another connection holds the write lock, without the real busy wait per attempt). Nothing can advance, so the maintenance
// must rest and choose a victim again only when the views, contexts or leases change.
//
// PORT (r8-upkeep-port). The 50 ms setTimeout tick (upkeepTick, RECALL_LAGGING_SQL once per tick, RECALL_UPKEEP_IDLE_MS backoff) these rows
// counted was replaced by memv2 lane A's wake-driven applier and upkeep (recall-view.ts runRecallApplier / runRecallUpkeep on wake.ts) under:
//   MAIN-PICK 2026-11-23T00:35:11Z memv2-I = memv2-I-tests 70af151c66
//   MAIN-RULING 2026-11-23T03:41:32Z gate-1021-swarm ... merges memv2-I 70af151c66
// The counted unit "tick" (one RECALL_LAGGING_SQL each) becomes the bus slice (wake.ts wakeStats().runs: every applier and upkeep run, the
// production counter), with the same bar (<= 70 a minute, not ~1,200). The ">= 55: still ticking" premise (a timer that never stops) is
// restated as the new design's no-lost-wake bar: the parked first turn keeps one upkeep deadline armed. "One idle wait" is the literal
// 1,000 ms of the removed RECALL_UPKEEP_IDLE_MS; lag is read through recallViewProjection (fleet watermarks are persisted lazily, A3).
// Fake timers: the bus's deadlines are setTimeout on Date.now (both faked); its pump is setImmediate (left real, drained between steps).
import { mkdirSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { OWNER } from '../human-principals.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { ensureScope, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { RecallCapacityPending, RecallPreparationPending } from './recall-recovery.ts';
import { RECALL_UPKEEP_TOPIC } from './recall-view-schema.ts';
import { insertMemoryRecord } from './record-write.ts';
import { OWNER_PIN } from './schema.ts';
import { deadlineOf, wakeStats } from './wake.ts';
import * as views from './recall-view.ts';

const releases: (() => void)[] = [];
const lock = { held: false };
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database().exec(OWNER_PIN.sql); });
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  lock.held = false;
  for (const release of releases.splice(0)) release();
  views.setRecallReclaimLimitsForTest(); views.stopRecallViewMaintenance(); closeDatabase();
});

/** The literal pace of the removed spec/1021 idle tick (RECALL_UPKEEP_IDLE_MS) and recall-view.ts RECALL_UPKEEP_MS (not exported). */
const IDLE_WAIT_MS = 1_000, RECALL_UPKEEP_MS = 50;
const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
const immediate = () => new Promise<void>(resolve => setImmediate(resolve));
async function drain(): Promise<void> { for (let n = 0; n < 400; n++) { await immediate(); if (wakeStats().owed === 0) { await immediate(); if (wakeStats().owed === 0) return; } } }
/** Fake time in 10 ms steps; after each the bus is drained and any build or hydration in flight is let finish. */
async function run(ms: number, roster: MemoryRoster): Promise<void> {
  for (let t = 0; t < ms; t += 10) { vi.advanceTimersByTime(10); await drain(); await views.waitForRecallConstructionIdleForTest(roster); await drain(); }
}

const binding = (botId: string, threadId: string) => ({ botId, threadId, humanPrincipal: OWNER, notOwnerAudience: false });
const VICTIM_SQL = 'SELECT view_id,generation,state,authority_epoch,EXISTS(SELECT 1 FROM memory_recall_contexts c WHERE c.view_id=v.view_id AND c.generation=v.generation) AS bound FROM memory_recall_views v ORDER BY view_id,generation';

/** 128 views, each held by a live lease; one more bot's first turn refused and parked; the store over 75% of a small quota. */
async function pinnedStore(): Promise<{ roster: MemoryRoster; live: boolean[]; db: DatabaseSync }> {
  const bots = Array.from({ length: 128 }, (_, n) => ({ id: `bot-${n}`, threadId: `thread-${n}` }));
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [...bots, { id: 'late', threadId: 'late-thread' }], groups: [] };
  reconcileMemoryRoster(roster);
  views.stopRecallViewMaintenance();
  for (const bot of bots) await views.prepareRecallContext(bot.id, bot.threadId, roster);
  const db = database(), live = bots.map(() => true);
  expect(Number(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n)).toBe(128);
  for (const [n, bot] of bots.entries()) releases.push(views.retainRecallView(views.resolveRecallView(binding(bot.id, bot.threadId), roster).handle, binding(bot.id, bot.threadId), () => live[n]!));
  expect(() => views.resolveRecallView(binding('late', 'late-thread'), roster)).toThrow(RecallPreparationPending);
  await views.waitForRecallConstructionIdleForTest(roster);
  expect(() => views.resolveRecallView(binding('late', 'late-thread'), roster)).toThrow(RecallCapacityPending);
  await views.waitForRecallConstructionIdleForTest(roster);
  // over 75% of the quota (pressure: C and D are asked for every choice), with no room demand
  const used = views.recallStorageBytes(db);
  expect(used).toBeGreaterThan(0);
  views.setRecallReclaimLimitsForTest({ quota: Math.ceil(used / 0.8), headroom: 1 });
  return { roster, live, db };
}
const allViews = (db: DatabaseSync) => db.prepare('SELECT view_id,generation FROM memory_recall_views').all().map(row => ({ viewId: String(row.view_id), generation: String(row.generation) }));
/** Views whose read-through mark (the applied mark for a fleet member, else the persisted watermark) is below `newest`. */
const lagging = (db: DatabaseSync, newest: number) => allViews(db).filter(view => views.recallViewProjection(db, view)!.watermark < newest).length;
/** Every view falls behind the journal, and every write transaction is refused busy (SQLITE_BUSY, what a held write lock answers). */
function laggingAndRefused(db: DatabaseSync): number {
  insertMemoryRecord(db, { id: 'overnight-fact', version: 1, scopeId: ensureScope('bot', 'bot-0'), kind: 'fact', text: 'a fact the views have not read', assertion: 'owner-stated', state: 'active', validFrom: Date.now(), createdAt: Date.now() });
  const newest = Number(db.prepare('SELECT max(sequence) AS n FROM memory_recall_changes').get()!.n);
  const exec = db.exec.bind(db);
  vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
    if (lock.held && sql === 'BEGIN IMMEDIATE') throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5, errstr: 'database is locked' });
    return exec(sql);
  });
  lock.held = true;
  expect(lagging(db, newest)).toBe(128);
  return newest;
}
function meter(db: DatabaseSync) {
  const counts = { runs0: wakeStats().runs, victimScans: 0 };
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) => { if (sql === VICTIM_SQL) counts.victimScans++; return prepare(sql); });
  return { counts, slices: () => wakeStats().runs - counts.runs0 };
}

it('W-PIN a full store that cannot advance (127 held views + 1 lagging refused view, 1 parked first turn, over 75% of quota) rests: <= 70 bus slices a minute, not ~1,200', async () => {
  const { roster, db } = await pinnedStore();
  laggingAndRefused(db);
  fake();
  views.startRecallViewMaintenance();
  await run(2_000, roster); // the start's first looks
  const { counts, slices } = meter(db);
  await run(60_000, roster);
  console.log('W-PIN', JSON.stringify({ slices: slices(), victimScans: counts.victimScans, upkeepDue: deadlineOf(RECALL_UPKEEP_TOPIC) !== undefined }));
  // base c3f339db41: the parked reader, the storage-pressure flag its re-ask sets and the lagging views each held the 50 ms pace (~1,200)
  expect(slices()).toBeLessThanOrEqual(70);
  // nothing moved, so the victim choice that found none is not made again
  expect(counts.victimScans).toBeLessThanOrEqual(2);
  // still looking (no lost wake): the parked turn keeps the upkeep's deadline armed; it is still parked and refused on its card
  expect(deadlineOf(RECALL_UPKEEP_TOPIC)).toBeDefined();
  expect(() => views.resolveRecallView(binding('late', 'late-thread'), roster)).toThrow(RecallCapacityPending);
}, 600_000);

it('W-PIN-WAKE a lease that ends silently in the resting store is seen within the next idle waits: the parked first turn is built and the victim is chosen again', async () => {
  const { roster, live, db } = await pinnedStore();
  laggingAndRefused(db);
  fake();
  views.startRecallViewMaintenance();
  await run(30_000, roster);
  lock.held = false;
  const { counts } = meter(db);
  live[7] = false; // that turn ended without its release call
  await run(4 * IDLE_WAIT_MS, roster);
  console.log('W-PIN-WAKE', JSON.stringify({ victimScans: counts.victimScans }));
  expect(counts.victimScans).toBeGreaterThanOrEqual(1);
  expect(() => views.resolveRecallView(binding('late', 'late-thread'), roster)).not.toThrow();
}, 600_000);

it('W-PIN-CATCHUP once the lock is gone every lagging view catches up within one idle wait plus 50 ms per view (cause18d-viewtxn: all in one page), not one idle wait each', async () => {
  const { roster, db } = await pinnedStore();
  const newest = laggingAndRefused(db);
  fake();
  views.startRecallViewMaintenance();
  await run(10_000, roster);
  lock.held = false;
  // one idle wait to reach the first view, then one 50 ms step per view (plus slack); one idle wait each would be ~128 s
  await run(IDLE_WAIT_MS + 2 * 128 * RECALL_UPKEEP_MS, roster);
  expect(lagging(db, newest)).toBe(0);
}, 600_000);
