// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner of the reclaimer, its pacing and these witnesses: recallcap-1020-n3c (recalldesign-1020-n1 section 6, W1-W10).
// Owner of the recall-reclaim admission class (server/io-budget.ts): recallcap-1020-n3c. Publication and authority fences: recall-scope.
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { threadHumanPrincipal } from '../human-principals.ts';
import { ioBudget, RECALL_RECLAIM_BYTES_PER_MINUTE } from '../io-budget.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { RecallCapacityPending } from './recall-recovery.ts';
import * as views from './recall-view.ts';
import * as wal from '../wal-maintenance.ts';

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
const contextView = (db: DatabaseSync, thread: string) => db.prepare('SELECT view_id,generation FROM memory_recall_contexts WHERE context_key=?').get(views.recallContextKey(binding(thread))) as Row;
let termBatch = 0;
function terms(db: DatabaseSync, view: Row, n: number): void {
  const add = db.prepare('INSERT INTO memory_recall_view_terms VALUES(?,?,?,?,?,?)'), batch = ++termBatch;
  db.exec('BEGIN'); for (let i = 0; i < n; i++) add.run(view.view_id, view.generation, `t${i}`, i, `r${batch}-${i}`, 1); db.exec('COMMIT');
}
/** A persisted copy of `source` (earlier versions left identical copies: the owner copy holds 7 of one view). */
function clone(db: DatabaseSync, source: Row, options: { state?: string; epoch?: number; watermark?: number; context?: string; terms?: number; digest?: string } = {}): Row {
  const view = { view_id: randomUUID(), generation: randomUUID() };
  // Built as the construction path does: membership rows first, while the row is still building, then its state.
  db.prepare(`INSERT INTO memory_recall_views SELECT ?,?,coalesce(?,authority_epoch),roster_revision,'building',scope_count,coalesce(?,digest),room_reader,coalesce(?,watermark)
    FROM memory_recall_views WHERE view_id=? AND generation=?`).run(view.view_id, view.generation, options.epoch ?? null, options.digest ?? null, options.watermark ?? null, source.view_id, source.generation);
  db.prepare('INSERT INTO memory_recall_view_scopes SELECT ?,?,scope_id,lineage_only,person_scope FROM memory_recall_view_scopes WHERE view_id=? AND generation=?').run(view.view_id, view.generation, source.view_id, source.generation);
  db.prepare('UPDATE memory_recall_views SET state=? WHERE view_id=? AND generation=?').run(options.state ?? 'ready', view.view_id, view.generation);
  db.prepare('INSERT INTO memory_recall_thread_readers SELECT ?,?,eligible FROM memory_recall_thread_readers WHERE view_id=? AND generation=?').run(view.view_id, view.generation, source.view_id, source.generation);
  if (options.context) db.prepare('INSERT INTO memory_recall_contexts VALUES(?,?,?)').run(options.context, view.view_id, view.generation);
  terms(db, view, options.terms ?? 40);
  return view;
}
const exists = (db: DatabaseSync, view: Row) => !!db.prepare('SELECT 1 FROM memory_recall_views WHERE view_id=? AND generation=?').get(view.view_id, view.generation);
/** Owner truth, the journal, the exclusion list and both authority fences, byte for byte. */
function ownerTruth(db: DatabaseSync): string {
  const hash = createHash('sha256');
  for (const table of ['memory_records', 'memory_jobs', 'memory_sources', 'memory_scopes', 'memory_scope_bindings', 'memory_projection_receipts', 'memory_recall_excluded',
    'memory_recall_epoch', 'memory_recall_roster_proof', 'memory_recall_changes', 'memory_recall_change_cover']) {
    hash.update(table);
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()) hash.update(JSON.stringify(row));
  }
  return hash.digest('hex');
}
/** The charge the triggers keep, recomputed from the rows that remain. */
function recomputedCharge(db: DatabaseSync): number {
  let bytes = Number(db.prepare('SELECT coalesce(sum(512+4*length(CAST(term AS BLOB))),0) AS n FROM memory_recall_view_terms').get()!.n);
  for (const table of ['memory_recall_view_scopes', 'memory_recall_view_records', 'memory_recall_view_pending', 'memory_recall_view_jobs', 'memory_recall_contains'])
    bytes += 512 * Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
  return bytes;
}
/** A clock one second further on each step (the bucket refills), and a meter that charges nothing unless a test says so. */
function steppedClock(cost = () => 0): void { let now = Date.now(), written = 0; views.setRecallReclaimClockForTest({ now: () => (now += 1000), written: () => (written += cost()) }); }
function drain(db: DatabaseSync, steps = 400): void { for (let n = 0; n < steps && views.recallReclaimStep(db); n++) { /* until nothing is left to free */ } }
const drops = () => events.filter(event => event.kind === 'drop');
const settle = async () => { for (let n = 0; n < 50; n++) await new Promise<void>(resolve => setImmediate(resolve)); };

// W2 + W5 + W6 (re-point): one store holding a crash leftover (A), a superseded view (B), a stale-authority view (C), two duplicates of a
// ready view (D) and a cold ready view (E). With no demand the reclaimer frees A < B < C < D < D, never E; duplicates' contexts point at the
// highest-watermark copy; every owner-truth table, the journal, the exclusion list, the epoch and the roster proof are byte-identical.
it('W2/W5/W6: frees waste in class order A < B < C < D, never a cold view without a demand, and never touches owner truth', () => {
  const { db } = seed(['direct']);
  const keep = contextView(db, 'direct'), cold = clone(db, keep, { digest: 'another-membership', context: 'ctx-cold' });
  db.prepare('UPDATE memory_recall_views SET watermark=10 WHERE view_id=?').run(keep.view_id);
  db.prepare("INSERT INTO memory_recall_excluded VALUES('excluded-thread')").run();
  const epoch = views.recallAuthorityEpoch(db);
  const a = clone(db, keep, { state: 'building' }), b = clone(db, keep), c = clone(db, keep, { epoch: epoch - 1, context: 'ctx-stale' });
  const d1 = clone(db, keep, { watermark: 5, context: 'ctx-d1' }), d2 = clone(db, keep, { watermark: 4, context: 'ctx-d2' });
  // The order is a property of the classes, not of the ids: a later class never goes first whatever the uuids sort as.
  const byId = new Map([[a.view_id, 'A'], [b.view_id, 'B'], [c.view_id, 'C'], [d1.view_id, 'D'], [d2.view_id, 'D'], [cold.view_id, 'E']]);
  terms(db, keep, 3000); terms(db, cold, 3000);
  const before = ownerTruth(db), charged = views.recallStorageBytes(db);
  // Far from full: only crash leftovers and superseded views go.
  views.setRecallReclaimLimitsForTest({ quota: charged * 10, headroom: 1 });
  steppedClock(); drain(db);
  expect(drops().map(event => byId.get(String(event.viewId)))).toEqual(['A', 'B']);
  // Over 75% of the quota (the kept and the cold view stay most of it): stale authority and duplicates go too, never the cold view.
  views.setRecallReclaimLimitsForTest({ quota: charged, headroom: 1 });
  drain(db);
  expect(drops().map(event => byId.get(String(event.viewId)))).toEqual(['A', 'B', 'C', 'D', 'D']);
  expect(drops().map(event => event.cls)).toEqual(['A', 'B', 'C', 'D', 'D']);
  for (const view of [a, b, c, d1, d2]) expect(exists(db, view)).toBe(false);
  expect(exists(db, cold)).toBe(true);
  expect(exists(db, keep)).toBe(true);
  for (const key of ['ctx-d1', 'ctx-d2']) expect(db.prepare('SELECT view_id FROM memory_recall_contexts WHERE context_key=?').get(key)?.view_id).toBe(keep.view_id);
  expect(db.prepare("SELECT 1 FROM memory_recall_contexts WHERE context_key='ctx-stale'").get()).toBeUndefined();
  expect(ownerTruth(db)).toBe(before);
  expect(views.recallStorageBytes(db)).toBe(recomputedCharge(db));
  expect(views.recallStorageBytes(db)).toBeLessThan(charged);
});

// W6 (adoption): a new build whose membership equals a ready view publishes that view and projects nothing of its own.
it('W6: a build with an equal digest adopts the ready view and writes 0 term rows', async () => {
  const { db, roster } = seed(['direct', 'late-twin']);
  const ready = contextView(db, 'direct');
  terms(db, ready, 25);
  // The twin's context is a different key with the same membership as one already ready: the reader principal and scopes match.
  const twin = { ...binding('direct'), notOwnerAudience: false };
  const key = views.recallContextKey(twin);
  db.prepare('DELETE FROM memory_recall_contexts WHERE context_key=?').run(key);
  db.prepare('INSERT INTO memory_recall_contexts VALUES(?,?,?)').run('ctx-keep', ready.view_id, ready.generation);
  views.evictRecallViewsForTest(db);
  // A store over 75% of its quota: a second copy would cost room.
  views.setRecallReclaimLimitsForTest({ quota: views.recallStorageBytes(db), headroom: 1 });
  const termsBefore = Number(db.prepare('SELECT count(*) AS n FROM memory_recall_view_terms').get()!.n);
  expect(() => views.resolveRecallView(twin, roster)).toThrow();
  await settle();
  expect(events.filter(event => event.kind === 'adopt').map(event => event.viewId)).toEqual([ready.view_id]);
  expect(contextView(db, 'direct').view_id).toBe(ready.view_id);
  expect(Number(db.prepare('SELECT count(*) AS n FROM memory_recall_view_terms').get()!.n)).toBe(termsBefore);
  expect(Number(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n)).toBe(1);
  expect(views.resolveRecallView(twin, roster).handle.viewId).toBe(ready.view_id);
});

// W7: a demand that cannot fit even with every allowed reclaim is refused at once: the capacity card, the "recall storage quota full" line,
// 0 deletes and 0 projection slices; asking again starts no build until the epoch, the roster or the bytes in use change.
it('W7: a view larger than quota minus in-use bytes is refused at once with nothing evicted and nothing built', async () => {
  const { db, roster } = seed(['direct', 'late']);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  db.prepare("UPDATE memory_recall_views SET digest='another-membership' WHERE view_id=?").run(contextView(db, 'direct').view_id);
  clone(db, contextView(db, 'direct'));
  views.setRecallReclaimLimitsForTest({ quota: 1, headroom: 1 });
  const viewsBefore = Number(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n);
  const scopesBefore = Number(db.prepare('SELECT count(*) AS n FROM memory_recall_view_scopes').get()!.n);
  expect(() => views.resolveRecallView(binding('late'), roster)).toThrow();
  await settle();
  expect(events.filter(event => event.kind === 'refuse')).toHaveLength(1);
  expect(() => views.resolveRecallView(binding('late'), roster)).toThrow(RecallCapacityPending);
  expect(warn.mock.calls.flat().join('\n')).toContain('recall storage quota full');
  expect(Number(db.prepare('SELECT count(*) AS n FROM memory_recall_view_scopes').get()!.n)).toBe(scopesBefore);
  const viewsAfterFirst = Number(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n);
  expect(viewsAfterFirst).toBeLessThanOrEqual(viewsBefore + 1);
  await settle();
  expect(Number(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n)).toBe(viewsAfterFirst);
  expect(drops()).toHaveLength(0);
  expect(events.filter(event => event.kind === 'mark')).toHaveLength(0);
});

// W8 + W5 (class E only for a demand) + W1 (the source): from a full store, a demand that fits waits for room; the reclaimer frees the cold
// view for it (class E runs only now), and the build starts once free >= P + headroom, exactly once, with no aborted build. The demand was
// raised inside an owner route; neither the build nor the reclaim runs under that route's source.
it('W8/W1: a demand waits for room, class E frees it, and the build starts once with free >= P + headroom, off the route source', async () => {
  const { db, roster } = seed(['direct', 'late']);
  // The only other view is cold and of another membership, so the demand can neither adopt it nor find waste to free.
  const cold = contextView(db, 'direct');
  db.prepare("UPDATE memory_recall_views SET digest='another-membership' WHERE view_id=?").run(cold.view_id);
  terms(db, cold, 600);
  views.setRecallReclaimLimitsForTest({ quota: views.recallStorageBytes(db), headroom: 512 });
  steppedClock();
  drain(db);
  expect(drops()).toHaveLength(0);
  ioBudget.withSource('route:POST /api/bots/:id/messages', () => { expect(() => views.resolveRecallView(binding('late'), roster)).toThrow(); });
  await settle();
  expect(events.filter(event => event.kind === 'wait')).toHaveLength(1);
  expect(views.recallReclaimDemandsForTest(db)).toHaveLength(1);
  expect(contextView(db, 'late')).toBeUndefined();
  ioBudget.withSource('route:POST /api/bots/:id/messages', () => drain(db));
  await settle();
  // The waiting build's own empty building row is a crash leftover once it parks (class A); the only view of value freed is the cold one.
  expect(drops().filter(event => event.cls === 'E').map(event => event.viewId)).toEqual([cold.view_id]);
  expect(drops().filter(event => event.cls !== 'E').map(event => event.cls)).toEqual(['A']);
  const admit = events.filter(event => event.kind === 'admit');
  expect(admit).toHaveLength(1);
  expect(admit[0]!.free!).toBeGreaterThanOrEqual(admit[0]!.bytes! + 512);
  expect(events.findIndex(event => event.kind === 'admit')).toBeGreaterThan(events.findIndex(event => event.kind === 'drop' && event.cls === 'E'));
  expect(events.filter(event => event.kind === 'wait')).toHaveLength(1);
  expect(contextView(db, 'late')).toBeTruthy();
  for (const event of events.filter(event => event.source !== undefined)) expect(event.source).not.toMatch(/^route:/);
  for (const event of events.filter(event => ['mark', 'slice', 'drop'].includes(event.kind))) expect(event.source).toBe('recall-reclaim');
});

// W4: a view held by a live reader, an active build, a hydration or an issued lease is never chosen, even as the only candidate.
it('W4: a view in use by a reader, a build, a hydration or an issued lease is never reclaimed', () => {
  const { db, roster } = seed(['direct']);
  const view = contextView(db, 'direct'), held = views.resolveRecallView(binding('direct'), roster).handle;
  db.prepare('DELETE FROM memory_recall_contexts WHERE view_id=?').run(view.view_id);
  steppedClock();
  for (const hold of [
    () => views.retainRecallView(held, binding('direct'), () => true),
    () => views.retainRecallView(held, binding('direct'), () => true, undefined, true),
    () => views.holdRecallViewForTest(db, String(view.view_id), 'build'),
    () => views.holdRecallViewForTest(db, String(view.view_id), 'hydrate'),
  ]) {
    db.prepare('INSERT OR IGNORE INTO memory_recall_contexts VALUES(?,?,?)').run('ctx-hold', view.view_id, view.generation);
    const release = hold();
    db.prepare("DELETE FROM memory_recall_contexts WHERE context_key='ctx-hold'").run();
    drain(db, 20);
    expect(exists(db, view)).toBe(true);
    expect(events.filter(event => event.kind === 'mark')).toHaveLength(0);
    release();
  }
  drain(db);
  expect(exists(db, view)).toBe(false);
});

// W3: the reclaimer never waits for the write lock (busy timeout 0): a held lock skips the tick at once, both before a victim is marked and in
// the middle of its slices, and no slice holds the lock long.
it('W3: a held write lock skips the reclaim tick without waiting, and every slice holds the lock briefly', () => {
  const { db } = seed(['direct']);
  const victim = clone(db, contextView(db, 'direct'), { terms: 30_000 });
  const other = new DatabaseSync(join(DATA_DIR, 'messages.db'));
  // Every step's meter charges the whole bucket, so each tick takes exactly one step: the mark, then one slice.
  // (each step costs the bucket's whole burst room; the clock moves only between ticks, by enough to refill it once)
  let now = Date.now();
  const room = RECALL_RECLAIM_BYTES_PER_MINUTE / 12;
  views.setRecallReclaimClockForTest({ now: () => now, written: () => events.filter(event => event.kind !== 'busy').length * room });
  const tick = () => { now += 10_000; views.recallReclaimStep(db); };
  const blocked = () => {
    other.exec('BEGIN IMMEDIATE');
    try {
      const started = performance.now();
      now += 10_000;
      expect(views.recallReclaimStep(db)).toBe(true);
      expect(performance.now() - started).toBeLessThan(30);
      expect(events.at(-1)!.kind).toBe('busy');
    } finally { other.exec('ROLLBACK'); }
  };
  try {
    blocked();
    expect(events.map(event => event.kind)).toEqual(['busy']);
    tick(); tick();
    expect(events.map(event => event.kind)).toEqual(['busy', 'mark', 'slice']);
    blocked();
    expect(exists(db, victim)).toBe(true);
  } finally { other.close(); }
  steppedClock(); drain(db);
  expect(exists(db, victim)).toBe(false);
  const holds = events.filter(event => event.kind === 'slice' || event.kind === 'drop').map(event => event.holdMs!);
  expect(holds.length).toBeGreaterThan(3);
  expect(Math.max(...holds)).toBeLessThan(150);
});

// W9: a crash after step 1, and again after some slices: the victim is never readable, a restart collects it, and the charge always equals the
// triggers' arithmetic over the rows that remain.
it('W9: a victim interrupted after marking or mid-slices is never readable and is collected after a restart', () => {
  let { db } = seed(['direct']);
  const ready = contextView(db, 'direct');
  const victim = clone(db, ready, { epoch: views.recallAuthorityEpoch(db) - 1, context: 'ctx-stale', terms: 5000 });
  const handle = { viewId: String(victim.view_id), generation: String(victim.generation), digest: String(db.prepare('SELECT digest FROM memory_recall_views WHERE view_id=?').get(victim.view_id)!.digest) };
  views.setRecallReclaimLimitsForTest({ quota: views.recallStorageBytes(db), headroom: 1 });
  // The meter charges the whole bucket for the mark, so this tick stops right after step 1: the "crash" point.
  let reads = 0; steppedClock(() => (++reads === 2 ? 1e12 : 0));
  views.recallReclaimStep(db);
  expect(events.map(event => event.kind)).toEqual(['mark']);
  expect(db.prepare('SELECT state FROM memory_recall_views WHERE view_id=?').get(victim.view_id)!.state).toBe('building');
  expect(() => views.assertRecallView(db, handle)).toThrow();
  closeDatabase(); db = database();
  expect(() => views.assertRecallView(db, handle)).toThrow();
  expect(views.recallStorageBytes(db)).toBe(recomputedCharge(db));
  // Restart: a few slices, then another crash.
  events.length = 0; steppedClock();
  for (let n = 0; n < 3; n++) views.recallReclaimStep(db);
  closeDatabase(); db = database();
  expect(views.recallStorageBytes(db)).toBe(recomputedCharge(db));
  expect(() => views.assertRecallView(db, handle)).toThrow();
  steppedClock(); drain(db);
  expect(exists(db, victim)).toBe(false);
  expect(views.recallStorageBytes(db)).toBe(recomputedCharge(db));
});

// W10: pacing. With every step charged 50 MB, the reclaimer spends at most the bucket's rate per minute (700 MB/min plus its 5 s burst room,
// far under 1 GB/min), and it starts no slice while an owner write request is open or for 500 ms after it closes.
it('W10: at most 700 MB/min (+5 s burst) of reclaim writes, and no slice within 500 ms of an owner send', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const start = Date.now();
  const { db } = seed(['direct']);
  const source = contextView(db, 'direct');
  for (let n = 0; n < 40; n++) clone(db, source, { terms: 20 });
  const at: number[] = [];
  const stop = views.subscribeRecallReclaim(event => { if (['mark', 'slice', 'drop'].includes(event.kind)) at.push(Date.now() - start); });
  views.setRecallReclaimClockForTest({ now: () => Date.now(), written: () => at.length * 50_000_000 });
  let send: (() => void) | null = null, sendClosedAt = -1;
  for (let t = 0; t < 180_000; t += 50) {
    vi.setSystemTime(start + t);
    if (t === 30_000) send = ioBudget.beginOwnerWrite('POST', '/api/bots/b1/messages');
    if (t === 30_200) { send!(); sendClosedAt = t; }
    views.recallReclaimStep(db);
  }
  stop();
  expect(sendClosedAt).toBe(30_200);
  const perMinute = [0, 1, 2].map(minute => at.filter(ms => ms >= minute * 60_000 && ms < (minute + 1) * 60_000).length * 50_000_000);
  expect(at.length).toBeGreaterThan(10);
  // The design's numbers, not the constant under test: 700 MB/min of refill, 5 s of burst room and at most one step's overshoot, under 1 GB/min.
  for (const bytes of perMinute) expect(bytes).toBeLessThanOrEqual(700_000_000 + 700_000_000 / 12 + 50_000_000);
  expect(Math.max(...perMinute)).toBeGreaterThan(500_000_000);
  expect(at.filter(ms => ms >= 30_000 && ms < 30_700)).toEqual([]);
});

// W8b (readiness within 2 turns): a turn's own scope write moves the epoch while its demanded build runs. The build is revoked, and the waiting
// demand asks again by itself under the new fences, so the view is ready before the next turn instead of after it.
it('W8b: a demanded build revoked by an epoch move is rebuilt under the new fences without a second demand', async () => {
  const { db, roster } = seed(['direct', 'late']);
  db.prepare("UPDATE memory_recall_views SET digest='another-membership' WHERE view_id=?").run(contextView(db, 'direct').view_id);
  let moved = false;
  const stop = views.subscribeRecallReclaim(event => { if (event.kind === 'admit' && !moved) { moved = true; db.prepare('UPDATE memory_recall_epoch SET epoch=epoch+1 WHERE id=1').run(); } });
  try {
    expect(() => views.resolveRecallView(binding('late'), roster)).toThrow();
    await settle(); await settle();
  } finally { stop(); }
  expect(moved).toBe(true);
  expect(events.filter(event => event.kind === 'admit')).toHaveLength(2);
  const view = contextView(db, 'late');
  expect(view).toBeTruthy();
  expect(db.prepare('SELECT authority_epoch FROM memory_recall_views WHERE view_id=?').get(view.view_id)!.authority_epoch).toBe(views.recallAuthorityEpoch(db));
});

// W10b: the engine's own /api/internal calls never hold the reclaimer, and a request still open after 5 s (waiting on a reply or a card, not on
// its write transaction) stops holding it.
it('W10b: internal engine calls and long-open requests do not starve the reclaimer', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const start = Date.now();
  vi.setSystemTime(start - 10_000); ioBudget.beginOwnerWrite('POST', '/api/bots/b1/messages')!(); vi.setSystemTime(start);
  expect(ioBudget.beginOwnerWrite('POST', '/api/internal/turn-step')).toBeNull();
  expect(ioBudget.beginOwnerWrite('GET', '/api/bots')).toBeNull();
  const open = ioBudget.beginOwnerWrite('POST', '/api/bots/b1/messages')!;
  expect(ioBudget.ownerWriteQuietMs(start + 1000)).toBe(0);
  expect(ioBudget.ownerWriteQuietMs(start + 5_001)).toBeGreaterThan(500);
  open();
});

// W10c: the reclaimer never feeds the WAL admission gate (which refuses every write, an owner send's too): no step once the log is within
// 64 MiB of the 512 MiB gate, copied or not; a smaller log never holds it, whatever the copy state.
it('W10c: no reclaim step while the WAL is near the admission gate', () => {
  const { db } = seed(['direct']);
  const victim = clone(db, contextView(db, 'direct'));
  let now = Date.now(), wal = { size: 0, backlog: 0 };
  views.setRecallReclaimClockForTest({ now: () => (now += 1000), written: () => 0, wal: () => wal });
  const truth0 = ownerTruth(db), changes0 = Number(db.prepare('SELECT total_changes() AS n').get()!.n), perCase: number[] = [];
  for (const held of [{ size: 460 * 1024 * 1024, backlog: 0 }, { size: 450 * 1024 * 1024, backlog: 450 * 1024 * 1024 }]) {
    wal = held;
    for (let n = 0; n < 5; n++) views.recallReclaimStep(db);
    expect(events.filter(event => ['mark', 'slice', 'drop'].includes(event.kind))).toEqual([]);
    expect(events.at(-1)!.kind).toBe('wal');
    perCase.push(events.filter(event => event.kind === 'wal' && event.rows !== undefined).length);
  }
  expect(perCase[1], 'no write at all to a log that is not fully copied').toBe(perCase[0]);
  // recallcap-1020-n3d: held and fully copied (460 MiB, backlog 0): value-identical derived-row writes restart the log, rate-limited to one per
  // 5 s of clock (5 steps, 1-4 writes, one changed row each), still no reclaim step and owner truth byte-identical. Not fully copied: no write.
  const restarts = events.filter(event => event.kind === 'wal' && event.rows !== undefined);
  expect(restarts.length, 'restart writes on a held, fully copied log').toBeGreaterThanOrEqual(1);
  expect(restarts.length, 'rate-limited, not one per step').toBeLessThan(5);
  expect(restarts.every(event => event.rows === 1)).toBe(true);
  expect(Number(db.prepare('SELECT total_changes() AS n').get()!.n) - changes0).toBe(restarts.length);
  expect(ownerTruth(db)).toEqual(truth0);
  wal = { size: 300 * 1024 * 1024, backlog: 300 * 1024 * 1024 };
  drain(db);
  expect(events.some(event => event.kind === 'mark')).toBe(true);
  expect(exists(db, victim)).toBe(false);
});

// W10d (Fable BLOCK on 191741e2a2): held at the log gate, the reclaimer asks the existing settleWal({nudge:true}) to copy and restart the log, one
// request in flight, instead of waiting minutes for owner activity to reset it. Once the restarted log is small, reclaim resumes.
it('W10d: held at the log gate, the reclaimer nudges the WAL once in flight and resumes after the restart', async () => {
  const { db } = seed(['direct']);
  const victim = clone(db, contextView(db, 'direct'));
  let now = Date.now(), log = { size: 460 * 1024 * 1024, backlog: 0 };
  views.setRecallReclaimClockForTest({ now: () => (now += 1000), written: () => 0, wal: () => log });
  const asked: Array<{ nudge?: boolean }> = [];
  let restart: (() => void) | undefined;
  vi.spyOn(wal, 'settleWal').mockImplementation(options => { asked.push({ nudge: options?.nudge }); return new Promise(done => { restart = () => done(true); }); });
  for (let n = 0; n < 5; n++) views.recallReclaimStep(db);
  expect(events.filter(event => ['mark', 'slice', 'drop'].includes(event.kind))).toEqual([]);
  expect(asked, 'one nudge while held, never a second while it is in flight').toEqual([{ nudge: true }]);
  restart!(); await Promise.resolve(); await new Promise(done => setTimeout(done, 0));
  views.recallReclaimStep(db);
  expect(asked, 'still held after a pass that did not restart the log: asks again').toEqual([{ nudge: true }, { nudge: true }]);
  log = { size: 4 * 1024 * 1024, backlog: 0 }; // the nudged log restarted and shrank to journal_size_limit
  restart!(); await new Promise(done => setTimeout(done, 0));
  drain(db);
  expect(asked, 'a small log is never nudged').toHaveLength(2);
  expect(events.some(event => event.kind === 'mark')).toBe(true);
  expect(exists(db, victim)).toBe(false);
});

// W10d-b: a refused copy (the I/O admission's busy 1, log -1) answers at once, and the build loop polls the gate: at most one nudge a second.
it('W10d-b: a nudge refused at once is not re-asked within the second', async () => {
  const { db } = seed(['direct']);
  clone(db, contextView(db, 'direct'));
  let now = Date.now() + 10_000;
  views.setRecallReclaimClockForTest({ now: () => now, written: () => 0, wal: () => ({ size: 460 * 1024 * 1024, backlog: 460 * 1024 * 1024 }) });
  const settle = vi.spyOn(wal, 'settleWal').mockResolvedValue(false);
  for (let n = 0; n < 5; n++) { views.recallReclaimStep(db); await new Promise(done => setTimeout(done, 0)); }
  expect(settle).toHaveBeenCalledTimes(1);
  now += 1000; views.recallReclaimStep(db);
  expect(settle).toHaveBeenCalledTimes(2);
  expect(events.filter(event => ['mark', 'slice', 'drop'].includes(event.kind))).toEqual([]);
});

// W-PRIO (Fable review of 892d3e4d6e, recallcap-1020-n4a): a demanded build outranks background reclaim. A brim-full store of 70 stale views and
// one demanded view; the meter charges every measured step the same cost, so the woken build and the reclaimer compete for one bucket. The
// demanded view is ready within 2 simulated minutes, and no victim is marked, sliced or dropped from its admission until it publishes.
it('W-PRIO: a woken demanded build is ready within 2 simulated minutes and no victim slice runs while it builds', async () => {
  const { db, roster } = seed(['direct', 'late']);
  const ready = contextView(db, 'direct');
  db.prepare("UPDATE memory_recall_views SET digest='another-membership' WHERE view_id=?").run(ready.view_id);
  const stale = Array.from({ length: 70 }, (_, n) => clone(db, ready, { epoch: views.recallAuthorityEpoch(db) - 1, context: `ctx-stale-${n}`, terms: 200 }));
  views.setRecallReclaimLimitsForTest({ quota: views.recallStorageBytes(db), headroom: 512 });
  let now = Date.now(), written = 0;
  views.setRecallReclaimClockForTest({ now: () => now, written: () => (written += 30_000_000) });
  expect(() => views.resolveRecallView(binding('late'), roster)).toThrow();
  await settle();
  expect(events.filter(event => event.kind === 'wait'), 'the demand first waits for room').toHaveLength(1);
  let seconds = 0;
  const isReady = () => { const view = contextView(db, 'late'); return !!view && db.prepare('SELECT state FROM memory_recall_views WHERE view_id=? AND generation=?').get(view.view_id, view.generation)?.state === 'ready'; };
  for (; seconds < 120 && !isReady(); seconds++) {
    now += 1000; views.recallReclaimStep(db);
    for (let n = 0; n < 5; n++) await new Promise<void>(resolve => setImmediate(resolve));
  }
  expect(isReady(), `demanded view ready within 2 simulated minutes (took ${seconds} s)`).toBe(true);
  const admitted = events.findIndex(event => event.kind === 'admit');
  expect(admitted, 'the woken build was admitted').toBeGreaterThan(events.findIndex(event => event.kind === 'wait'));
  expect(events.slice(admitted).filter(event => ['mark', 'slice', 'drop'].includes(event.kind)), 'no victim slice while the demanded build runs').toEqual([]);
  expect(events.slice(admitted).some(event => event.kind === 'yield'), 'the reclaimer yielded to the build').toBe(true);
  // Once the view is published, background reclaim resumes on the stale views.
  const before = events.length;
  for (let n = 0; n < 30; n++) { now += 1000; views.recallReclaimStep(db); }
  expect(events.slice(before).some(event => ['mark', 'slice', 'drop'].includes(event.kind)), 'background reclaim resumes after the publish').toBe(true);
  expect(stale.some(view => exists(db, view))).toBe(true);
});

// W-YIELD (Fable review of 892d3e4d6e (ii), recallcap-1020-n4a): once a minute's process writes passed 300 MB, an owner write holds reclaim for
// the rest of that minute instead of 500 ms; reclaim resumes in the next minute.
it('W-YIELD: after an owner write in a minute already over 300 MB, no reclaim slice until the minute ends', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const start = Math.ceil(Date.now() / 60_000) * 60_000 + 60_000;
  vi.setSystemTime(start);
  const { db } = seed(['direct']);
  const source = contextView(db, 'direct');
  for (let n = 0; n < 40; n++) clone(db, source, { terms: 20 });
  const at: number[] = [];
  const stop = views.subscribeRecallReclaim(event => { if (['mark', 'slice', 'drop'].includes(event.kind)) at.push(Date.now() - start); });
  // Slices cost 20 MB each; from second 10 the process meter also holds 400 MB of other writes (a start-up or turn burst in that minute).
  views.setRecallReclaimClockForTest({ now: () => Date.now(), written: () => at.length * 20_000_000 + (Date.now() - start >= 10_000 ? 400_000_000 : 0) });
  let send: (() => void) | null = null;
  for (let t = 0; t < 120_000; t += 50) {
    vi.setSystemTime(start + t);
    if (t === 20_000) send = ioBudget.beginOwnerWrite('POST', '/api/bots/b1/messages');
    if (t === 20_200) send!();
    views.recallReclaimStep(db);
  }
  stop();
  expect(at.some(ms => ms >= 10_000 && ms < 20_000), 'a slice read the meter over 300 MB before the send').toBe(true);
  expect(at.filter(ms => ms >= 20_000 && ms < 60_000), 'held for the rest of the minute').toEqual([]);
  expect(at.some(ms => ms >= 60_000), 'resumes in the next minute').toBe(true);
});

// W-PRIO2 (recallcap-1020-n4a, owner copy: Sable needs 436 MB, warming kept refilling what reclaim freed): while a demand waits for room, no
// speculative build starts (not even its building row), so the freed room stays the demand's.
it('W-PRIO2: no speculative build starts while a demand waits for room', async () => {
  const { db, roster } = seed(['direct', 'late', 'late-warm']);
  const cold = contextView(db, 'direct');
  db.prepare("UPDATE memory_recall_views SET digest='another-membership' WHERE view_id=?").run(cold.view_id);
  terms(db, cold, 600);
  views.setRecallReclaimLimitsForTest({ quota: views.recallStorageBytes(db), headroom: 512 });
  steppedClock();
  expect(() => views.resolveRecallView(binding('late'), roster)).toThrow();
  await settle();
  expect(views.recallReclaimDemandsForTest(db), 'the demand waits for room').toHaveLength(1);
  const rows = () => Number(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n);
  const before = rows();
  views.prepareRosterRecallViews(roster);
  await settle(); await settle();
  expect(rows(), 'no speculative building row while the demand waits').toBe(before);
  expect(contextView(db, 'late-warm')).toBeUndefined();
});
