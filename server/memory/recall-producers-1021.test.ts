// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: memv2 lane A (MEMORY-V2-DESIGN 4.2 A10, witness A10-W; gate row G-PRODUCER). Consumer owner of the journal: the recall applier
// (recall-view.ts, lane A).
// A producer of bulk receipt changes (an index reset, a model adoption through Settings, the controller's receipt writes after an index
// batch) writes one journal range row per 256 receipts (the reset and the adoption in transactions of at most 256; the controller inside
// its own 2,048-receipt slice, which a pinned byte budget depends on), and waits between pages until the recall applier
// and every view build in flight are within the producer room. Before the fix an index reset and a model adoption were ONE statement
// over every receipt (one journal row per receipt, one transaction), and an index batch wrote up to 2,048 receipts per transaction.
// The design's witness names 200,000 receipts; this file uses RECEIPTS (1,500: six pages) and scales the room down with
// setRecallProducerRoomForTest so the wait is really exercised: the mechanism is per page, so the count only changes the run time.
// The same file runs on f6ae52c670 (the RED run): what does not exist there is reached through optional calls, and the model adoption,
// which has no callable entry on that tree, is its one statement as settings.ts:340 wrote it.
import { mkdirSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database, transaction } from '../database.ts';
import { ioBudget } from '../io-budget.ts';
import { ensureScope, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { setMemoryMode } from './repository.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import * as viewModule from './recall-view.ts';
import { completeIndexReset, indexResetDue, MemoryWorkerController, requestIndexOpenReset } from './worker-controller.ts';

type Views = typeof viewModule & Partial<{
  recallJournalRoom(db: DatabaseSync): boolean; setRecallProducerRoomForTest(rows?: number): void; runRecallApplierForTest(): void;
  recallAppliedMarkForTest(db: DatabaseSync): { applied: number | undefined };
}>;
const views = viewModule as Views;
interface Producers {
  startModelAdoption(db?: DatabaseSync): boolean; modelAdoptionPending(db: DatabaseSync): boolean; reinstallModelAdoptionForTest(): void;
  recallProducerStats(): { pages: number; waits: number; resumed: number; widestPage: number; receipts: number }; resetRecallProducerStatsForTest(): void;
  MODEL_ADOPTION_MARKER: string;
}
const producerModule = './recall-producers.ts';
const producers: Producers | undefined = await import(/* @vite-ignore */ producerModule).catch(() => undefined);
const wakeModule = './wake.ts';

const RECEIPTS = 1500, PAGE = 256;
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); producers?.resetRecallProducerStatsForTest(); });
afterEach(() => { vi.useRealTimers(); views.setRecallProducerRoomForTest?.(); views.stopRecallViewMaintenance(); closeDatabase(); });

const journalHead = (db: DatabaseSync) => Number(db.prepare('SELECT coalesce(max(sequence),0) AS n FROM memory_recall_changes').get()!.n);
const journalRowsAfter = (db: DatabaseSync, after: number) => db.prepare('SELECT kind,count(*) AS n FROM memory_recall_changes WHERE sequence>? GROUP BY kind').all(after)
  .reduce<Record<string, number>>((all, row) => ({ ...all, [String(row.kind)]: Number(row.n) }), {});
const statusCount = (db: DatabaseSync, lexical: string, embedding: string) => Number(db.prepare('SELECT count(*) AS n FROM memory_projection_receipts WHERE lexical_status=? AND embedding_status=?').get(lexical, embedding)!.n);
const floorOf = (db: DatabaseSync) => Number(db.prepare('SELECT projection_floor FROM memory_recall_epoch WHERE id=1').get()!.projection_floor);
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
type Handle = { viewId: string; generation: string; digest: string };
const viewOfBot = (db: DatabaseSync, bot: number): Handle | undefined => {
  const row = db.prepare('SELECT v.view_id,v.generation,v.digest FROM memory_recall_contexts c JOIN memory_recall_views v ON v.view_id=c.view_id AND v.generation=c.generation WHERE c.context_key LIKE ?').get(`["bot-${bot}",%`);
  return row ? { viewId: String(row.view_id), generation: String(row.generation), digest: String(row.digest) } : undefined;
};
const bound = (db: DatabaseSync): Handle[] => db.prepare(`SELECT v.view_id,v.generation,v.digest FROM memory_recall_contexts c JOIN memory_recall_views v
  ON v.view_id=c.view_id AND v.generation=c.generation ORDER BY c.context_key`).all().map(row => ({ viewId: String(row.view_id), generation: String(row.generation), digest: String(row.digest) }));
const current = (db: DatabaseSync, view: Handle) => views.recallViewCurrent ? views.recallViewCurrent(db, view)
  : Number(db.prepare('SELECT watermark FROM memory_recall_views WHERE view_id=? AND generation=?').get(view.viewId, view.generation)!.watermark) >= journalHead(db);
/** Every bound view reads the whole journal: by the applier's own runs on this tree, by the old per-view walk on a tree without it. */
function drain(db: DatabaseSync): void {
  const behind = () => bound(db).filter(view => !current(db, view));
  for (let run = 0; run < 8192 && behind().length; run++) {
    if (views.runRecallApplierForTest) views.runRecallApplierForTest();
    else for (const view of behind()) views.maintainRecallViewSlice(view);
  }
  expect(behind().length, 'every bound view reads the whole journal').toBe(0);
}
/** The journal rows the views have not read: above the applier's mark (above the lowest watermark on a tree without the applier). */
function lag(db: DatabaseSync): number {
  const applied = views.recallAppliedMarkForTest?.(db).applied
    ?? Number(db.prepare("SELECT coalesce(min(watermark),0) AS n FROM memory_recall_views WHERE state='ready'").get()!.n);
  return journalHead(db) - applied;
}
function content(db: DatabaseSync, view: { viewId: string; generation: string }) {
  const args = [view.viewId, view.generation];
  return {
    records: db.prepare('SELECT record_id,version,sequence,kind,pinned,state,scope_id FROM memory_recall_view_records WHERE view_id=? AND generation=? ORDER BY record_id,version').all(...args).map(row => ({ ...row })),
    terms: db.prepare('SELECT term,sequence,record_id,version FROM memory_recall_view_terms WHERE view_id=? AND generation=? ORDER BY record_id,version,term').all(...args).map(row => ({ ...row })),
    pending: db.prepare('SELECT sequence,record_id,version FROM memory_recall_view_pending WHERE view_id=? AND generation=? ORDER BY sequence,record_id').all(...args).map(row => ({ ...row })),
  };
}
interface World { db: DatabaseSync; roster: MemoryRoster; shared: string }
/** The oracle of every lane A witness (W-F1-EQUAL): each context's view against a fresh build of the same context. */
function expectFreshEqual(w: World): void {
  const { db } = w;
  const keys = db.prepare('SELECT context_key FROM memory_recall_contexts ORDER BY context_key').all().map(row => String(row.context_key));
  const viewAt = (key: string) => db.prepare('SELECT view_id,generation FROM memory_recall_contexts WHERE context_key=?').get(key)!;
  const before = new Map(keys.map(key => { const row = viewAt(key); return [key, { id: `${row.view_id}/${row.generation}`, content: content(db, { viewId: String(row.view_id), generation: String(row.generation) }) }]; }));
  db.exec('UPDATE memory_recall_epoch SET epoch=epoch+1 WHERE id=1');
  for (const bot of w.roster.bots) views.prepareRecallContextSync(bot.id, bot.threadId!, w.roster);
  views.stopRecallViewMaintenance();
  expect(keys.length).toBeGreaterThan(0);
  for (const [key, old] of before) {
    const row = viewAt(key);
    expect(`${row.view_id}/${row.generation}`, `context ${key} was rebuilt`).not.toBe(old.id);
    expect(old.content, `context ${key} equals its fresh build`).toEqual(content(db, { viewId: String(row.view_id), generation: String(row.generation) }));
  }
}
const TEXT = 'saffron harbour lantern quartz meadow violin';
/** `bots` bots, a ready view for the first `built` of them, and RECEIPTS records with one receipt each in a scope every view reads. */
function world(bots: number, built: number, lexical: string, embedding: string, receipts = RECEIPTS, archivedEvery = 4): World {
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: Array.from({ length: bots }, (_, n) => ({ id: `bot-${n}`, threadId: `thread-${n}` })), groups: [] };
  reconcileMemoryRoster(roster); setMemoryMode('active'); views.stopRecallViewMaintenance();
  const db = database();
  ensureScope('conversation', 'elsewhere');
  for (const bot of roster.bots.slice(0, built)) views.prepareRecallContextSync(bot.id, bot.threadId!, roster);
  views.stopRecallViewMaintenance();
  const mine = viewOfBot(db, 0)!;
  const shared = db.prepare(`SELECT s.scope_id FROM memory_recall_view_scopes s WHERE s.view_id=? AND s.generation=? AND s.lineage_only=0
    AND (SELECT count(*) FROM memory_recall_view_scopes o WHERE o.scope_id=s.scope_id AND o.lineage_only=0)=? ORDER BY s.scope_id LIMIT 1`).get(mine.viewId, mine.generation, built);
  expect(shared, 'a scope every view reads').toBeTruthy();
  transaction(() => {
    const record = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement',?,0,1,NULL,NULL,1)");
    const receipt = db.prepare('INSERT INTO memory_projection_receipts VALUES(?,1,1,?,?,NULL)');
    // every fourth record is archived: an index reset owes it as 'pending-archive'
    for (let n = 0; n < receipts; n++) { const id = `rec-${String(n).padStart(5, '0')}`; record.run(id, String(shared!.scope_id), `${TEXT} n${n}`, archivedEvery && n % archivedEvery === archivedEvery - 1 ? 'archived' : 'active'); receipt.run(id, lexical, embedding); }
  });
  drain(db);
  return { db, roster, shared: String(shared!.scope_id) };
}
/** Receipts changed by each write transaction of `work`: the widest one is the page size the producer really used. */
function widestTransaction(db: DatabaseSync, changed: () => number, work: () => void): { widest: number; transactions: number } {
  // (the connection's own exec is an instrumented own property: it is put back, never deleted)
  const own = db.exec, exec = db.exec.bind(db);
  let widest = 0, transactions = 0, at = changed(), depth = 0;
  (db as { exec: (sql: string) => void }).exec = (sql: string) => {
    const result = exec(sql);
    if (/^BEGIN/i.test(sql)) { depth++; at = changed(); }
    if (/^COMMIT/i.test(sql)) { depth = Math.max(0, depth - 1); const now = changed(); if (now !== at) { transactions++; widest = Math.max(widest, Math.abs(now - at)); } at = now; }
    return result;
  };
  try { work(); } finally { db.exec = own; }
  return { widest, transactions };
}

/** Watches every write transaction until `stop()`: the most receipts one changed, and how many changed receipts although the producer
 *  had no room when the transaction began (asked inside the transaction itself, so the answer is the one the producer had). */
function pageWatch(db: DatabaseSync, changed: () => number) {
  const own = db.exec, exec = db.exec.bind(db), seen = { widest: 0, pages: 0, withoutRoom: 0 };
  let at = changed(), room = true;
  (db as { exec: (sql: string) => void }).exec = (sql: string) => {
    const result = exec(sql);
    if (/^BEGIN/i.test(sql)) { at = changed(); room = views.recallJournalRoom ? views.recallJournalRoom(db) : true; }
    if (/^COMMIT/i.test(sql)) { const now = changed(); if (now !== at) { seen.pages++; seen.widest = Math.max(seen.widest, Math.abs(now - at)); if (!room) seen.withoutRoom++; } at = now; }
    return result;
  };
  return { seen, stop: () => { db.exec = own; return seen; } };
}

it('A10-W reset (one transaction, MEMW rule 1): an index reset completed in the caller\'s transaction owes every receipt and journals one range row per 256 receipts, not one row per receipt', () => {
  const w = world(2, 2, 'indexed', 'indexed'), { db } = w;
  expect(requestIndexOpenReset()).toBe(true);
  const request = indexResetDue()!;
  const head = journalHead(db);
  expect(completeIndexReset(request.resetId)).toBe('done');
  expect(completeIndexReset(request.resetId), 'the handshake answers once').toBe('none');
  const owed = Number(db.prepare("SELECT count(*) AS n FROM memory_projection_receipts p JOIN memory_records r ON r.id=p.record_id AND r.version=p.record_version WHERE p.embedding_status='pending' AND p.lexical_status=CASE WHEN r.state='active' THEN 'pending' ELSE 'pending-archive' END").get()!.n);
  expect(owed, 'every receipt is owed again, by its record state').toBe(RECEIPTS);
  const rows = journalRowsAfter(db, head), total = Object.values(rows).reduce((a, b) => a + b, 0);
  console.log(`GATE-MEASURE A10-W reset-atomic journal rows for ${RECEIPTS} receipts: ${total} ${JSON.stringify(rows)} (bound ${Math.ceil(RECEIPTS / PAGE) + 1})`);
  expect(total, 'journal rows of the reset').toBeLessThanOrEqual(Math.ceil(RECEIPTS / PAGE) + 1);
  // the effect: every view shows every owed receipt as waiting, and equals a fresh build
  drain(db);
  expect(Number(db.prepare('SELECT count(*) AS n FROM memory_recall_view_pending').get()!.n), 'both views hold every waiting receipt').toBe(2 * RECEIPTS);
  expectFreshEqual(w);
}, 240_000);

it('A10-W reset (paged): under a memory source each call is one transaction of at most 256 receipts, the producer stops while the applier is more than the room behind and goes on after the applier\'s commit, with no timer of its own', async () => {
  const w = world(2, 2, 'indexed', 'indexed'), { db } = w, ROOM = 2;
  views.setRecallProducerRoomForTest?.(ROOM);
  views.startRecallViewMaintenance();
  if ('runRecallApplierForTest' in views) drain(db);
  expect(requestIndexOpenReset()).toBe(true);
  const request = indexResetDue()!;
  const owedNow = () => statusCount(db, 'pending', 'pending') + statusCount(db, 'pending-archive', 'pending');
  const timers: string[] = [], realTimeout = globalThis.setTimeout;
  let calls = 0, waits = 0, widestLag = 0, result: string = 'pending', widest = 0, wokenAfterWait = 0;
  const { onWake } = await import(/* @vite-ignore */ wakeModule).catch(() => ({ onWake: undefined })) as { onWake?: (topic: string, fn: () => void) => () => void };
  const off = onWake?.('projection', () => { wokenAfterWait++; });
  (globalThis as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => { timers.push(String(new Error().stack)); return (realTimeout as unknown as (...args: unknown[]) => ReturnType<typeof setTimeout>)(fn, ms, ...rest); }) as typeof setTimeout;
  try {
    // One synchronous loop: nothing else runs between the producer's calls, so the applier moves only when this witness runs it.
    while (result === 'pending' && calls < 4096) {
      const before = owedNow();
      const page = widestTransaction(db, owedNow, () => { result = ioBudget.withSource('memory-worker', () => completeIndexReset(request.resetId)); });
      calls++; widest = Math.max(widest, page.widest); widestLag = Math.max(widestLag, lag(db));
      if (result === 'pending' && owedNow() === before) {
        // Still owed and nothing written: the producer is waiting for the applier. It never waits with room to spare.
        waits++;
        expect(views.recallJournalRoom!(db), 'a producer that wrote nothing had no room').toBe(false);
        drain(db);
        expect(views.recallJournalRoom!(db), 'the applier\'s commit makes room').toBe(true);
      }
    }
  } finally { (globalThis as { setTimeout: unknown }).setTimeout = realTimeout; }
  console.log(`GATE-MEASURE A10-W reset-paged receipts per transaction ${widest} (bound ${PAGE}); journal rows above the applied mark ${widestLag} (bound ${ROOM + 1}); producer waits ${waits}; calls ${calls}`);
  expect(result).toBe('done');
  expect(owedNow(), 'every receipt is owed again').toBe(RECEIPTS);
  expect(widest, 'receipts changed by one transaction').toBeLessThanOrEqual(PAGE);
  expect(widestLag, 'journal rows the views had not read, at the worst moment of the burst').toBeLessThanOrEqual(ROOM + 1);
  expect(waits, 'the producer waited for the applier at least once').toBeGreaterThan(0);
  expect(timers.filter(stack => /recall-producers|oweReceiptsToNewIndex|completeIndexReset/.test(stack)), 'the producer armed no timer').toEqual([]);
  // the wait is settled by the applier's commit: the receipt wake was raised for the caller that serves receipts
  for (let turns = 0; turns < 64 && !wokenAfterWait; turns++) await turn();
  expect(wokenAfterWait, 'the receipt wake was raised for whoever serves receipts (one slice per subscriber per turn of the loop)').toBeGreaterThan(0);
  off?.();
  drain(db);
  expect(Number(db.prepare('SELECT count(*) AS n FROM memory_recall_view_pending').get()!.n)).toBe(2 * RECEIPTS);
  expectFreshEqual(w);
}, 240_000);

it('A10-W model adoption with a build in flight: pages of at most 256 receipts, the producer waits for the build, the build completes without a restart, the floor never passes its snapshot, no view is rebuilt, and an owner write during the burst commits', async () => {
  const w = world(3, 2, 'indexed', 'unavailable'), { db } = w;
  views.setRecallProducerRoomForTest?.(0);
  views.startRecallViewMaintenance();
  const kept = [viewOfBot(db, 0)!, viewOfBot(db, 1)!];
  // The build of bot-2's view starts now and is in flight when the adoption begins; its snapshot is the journal head of this moment.
  const snapshot = journalHead(db);
  const build = views.prepareRecallContext('bot-2', 'thread-2', w.roster);
  await turn(); await turn();
  const building = db.prepare("SELECT view_id FROM memory_recall_views WHERE state='building'").all().map(row => String(row.view_id));
  expect(building.length, 'one view is being built').toBe(1);
  const head = journalHead(db), adopted = () => statusCount(db, 'pending', 'pending');
  let widest = 0, ownerCommitted = false, floorMax = floorOf(db), withoutRoom = 0;
  const sample = () => { floorMax = Math.max(floorMax, floorOf(db)); };
  if (producers) {
    const watch = pageWatch(db, adopted);
    const done = producers.startModelAdoption(db);
    sample();
    expect(done, 'six pages are not one').toBe(false);
    expect(producers.modelAdoptionPending(db), 'the adoption keeps its place in a marker row').toBe(true);
    for (let turns = 0; turns < 200_000 && producers.modelAdoptionPending(db); turns++) {
      await turn(); sample();
      if (!ownerCommitted && adopted() >= PAGE) {
        // an owner send in the middle of the burst: it commits at once, whatever the producer is waiting for
        transaction(() => { db.prepare("INSERT INTO memory_records VALUES('owner-note',1,?,'fact','an owner note written during the burst','owner-statement','active',0,1,NULL,NULL,1)").run(w.shared); });
        ownerCommitted = !!db.prepare("SELECT 1 FROM memory_records WHERE id='owner-note'").get() && producers.modelAdoptionPending(db);
      }
    }
    expect(producers.modelAdoptionPending(db), 'the adoption finished').toBe(false);
    ({ widest, withoutRoom } = watch.stop());
  } else {
    // f6ae52c670, settings.ts:340: the adoption is this one statement.
    const page = widestTransaction(db, adopted, () => transaction(() => { db.prepare("UPDATE memory_projection_receipts SET lexical_status='pending',embedding_status='pending' WHERE embedding_status='unavailable' AND lexical_status='indexed'").run(); }));
    widest = page.widest; floorMax = Math.max(floorMax, floorOf(db));
    transaction(() => { db.prepare("INSERT INTO memory_records VALUES('owner-note',1,?,'fact','an owner note written during the burst','owner-statement','active',0,1,NULL,NULL,1)").run(w.shared); });
    ownerCommitted = true;
  }
  await build;
  const rows = journalRowsAfter(db, head), stats = producers?.recallProducerStats();
  console.log(`GATE-MEASURE A10-W adoption receipts per transaction ${widest} (bound ${PAGE}); journal rows ${JSON.stringify(rows)}; producer waits ${stats?.waits ?? 'n/a'}; pages ${stats?.pages ?? 1}; floor ${floorMax} snapshot ${snapshot}`);
  expect(adopted(), 'every receipt indexed without a model is owed again').toBe(RECEIPTS);
  expect(widest, 'receipts changed by one transaction').toBeLessThanOrEqual(PAGE);
  expect(rows.record ?? 0, 'journal rows that name one receipt each (the owner note is one)').toBeLessThanOrEqual(1);
  expect(ownerCommitted, 'an owner write committed while the adoption was still running').toBe(true);
  expect(stats!.waits, 'the producer waited for the build at least once').toBeGreaterThan(0);
  expect(withoutRoom, 'pages written while the build in flight was more than the room behind').toBe(0);
  expect(floorMax, 'projection_floor never passed the build\'s snapshot').toBeLessThanOrEqual(snapshot);
  const built = viewOfBot(db, 2)!;
  expect(building, 'the build completed without a restart: the view it started is the one published').toContain(built.viewId);
  expect([viewOfBot(db, 0)!.viewId, viewOfBot(db, 1)!.viewId], 'no view was rebuilt').toEqual(kept.map(view => view.viewId));
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_recall_views WHERE state='ready'").get()!.n)).toBe(3);
  drain(db);
  expectFreshEqual(w);
}, 240_000);

it('A10-W crash in the middle of a model adoption: the next start finds the marker with one single-row read and finishes the rest; a start with no marker does nothing', async () => {
  let w = world(2, 2, 'indexed', 'unavailable'), db = w.db;
  expect(producers, 'the paged adoption exists').toBeTruthy();
  const p = producers!;
  expect(p.startModelAdoption(db)).toBe(false);
  expect(statusCount(db, 'pending', 'pending'), 'the first page committed with the marker').toBe(PAGE);
  const marker = () => database().prepare('SELECT subject_type,subject_id,state,intent FROM memory_scope_bindings WHERE id=?').get(p.MODEL_ADOPTION_MARKER);
  expect(marker(), 'the cursor is a marker row in the shape of design 3.5').toMatchObject({ subject_type: 'system', subject_id: 'memory-v2', state: 'granted' });
  expect(JSON.parse(String(marker()!.intent)).cursor, 'the cursor names the last key of the page').toEqual([`rec-${String(PAGE - 1).padStart(5, '0')}`, 1]);
  // The process dies here: nothing it had queued in memory survives, the file does.
  // (the subscriber is taken off the bus with the slice that was queued for it, then subscribed again as a new process does at load)
  p.reinstallModelAdoptionForTest();
  views.stopRecallViewMaintenance(); closeDatabase();
  p.resetRecallProducerStatsForTest();
  db = database(); w = { ...w, db };
  expect(p.recallProducerStats().resumed, 'the open found the marker').toBe(1);
  for (let turns = 0; turns < 200_000 && p.modelAdoptionPending(db); turns++) await turn();
  expect(p.modelAdoptionPending(db), 'the restart finished the adoption').toBe(false);
  expect(statusCount(db, 'pending', 'pending'), 'every receipt is owed, none twice').toBe(RECEIPTS);
  expect(p.recallProducerStats().widestPage).toBeLessThanOrEqual(PAGE);
  expect(marker(), 'the marker leaves with the last page').toBeUndefined();
  // a start with nothing to resume raises nothing and writes nothing
  closeDatabase(); p.resetRecallProducerStatsForTest();
  db = database();
  expect(p.recallProducerStats()).toMatchObject({ resumed: 0, pages: 0 });
}, 240_000);

it('A10-W the controller\'s receipt writes after an index batch: one journal range row per 256 receipts inside its 2,048-receipt transaction, and no transaction while a build in flight is more than the room behind', async () => {
  const BATCH = 700;
  const w = world(3, 2, 'pending', 'pending', BATCH, 0), { db } = w;
  views.setRecallProducerRoomForTest?.(0);
  const controller = new MemoryWorkerController();
  const internals = controller as unknown as { child: unknown; ready: boolean; indexing: boolean; indexRequestId: string | null; indexSent: Map<string, string>; indexRolled: Set<string>; onWorkerMessage(child: unknown, message: unknown): void; registerWorkerBytes(): void };
  internals.child = { kill() {}, on() {}, send() {} }; internals.ready = true; internals.registerWorkerBytes();
  const records = db.prepare("SELECT r.id,r.version,r.state FROM memory_records r WHERE r.id LIKE 'rec-%' AND r.state='active' ORDER BY r.id").all().map(row => ({ id: String(row.id), version: Number(row.version), state: String(row.state) }));
  internals.indexing = true; internals.indexRequestId = 'batch-1'; internals.indexRolled = new Set();
  internals.indexSent = new Map(records.map(row => [`${row.id}\u0000${row.version}`, row.state]));
  const indexed = () => Number(db.prepare("SELECT count(*) AS n FROM memory_projection_receipts WHERE lexical_status='indexed'").get()!.n);
  // a build is in flight when the batch is answered
  const build = views.prepareRecallContext('bot-2', 'thread-2', w.roster);
  await turn(); await turn();
  expect(db.prepare("SELECT 1 FROM memory_recall_views WHERE state='building'").get(), 'a view is being built').toBeTruthy();
  // One journal row lands after the build took its snapshot: the build is now behind (the room is 0 rows), so the batch's first
  // transaction has to wait for it.
  db.prepare("INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('job','no-such-job',0)").run();
  expect(views.recallJournalRoom(db), 'the build in flight is behind the journal').toBe(false);
  const head = journalHead(db);
  let sawNoRoom = false;
  const watch = pageWatch(db, indexed);
  try {
    internals.onWorkerMessage(internals.child, { type: 'index-result', requestId: 'batch-1', records: records.map(row => ({ id: row.id, version: row.version, deleted: false })), embeddingStatus: 'indexed' });
    for (let turns = 0; turns < 200_000 && indexed() < records.length; turns++) {
      if (views.recallJournalRoom && !views.recallJournalRoom(db)) sawNoRoom = true;
      await turn();
    }
    await build;
  } finally { watch.stop(); await controller.stop().catch(() => {}); }
  const { widest, withoutRoom: wroteWithoutRoom } = watch.seen;
  const rows = journalRowsAfter(db, head);
  // The transaction keeps the X3 slice (2,048 receipts: recall-prod-x3-r2-window W3 pins the drain at 480 bytes a row; transactions of
  // 256 measured 1,075). What A10 bounds here is the journal: one range row per 256 receipts, and the wait before each transaction.
  const SLICE = 2048;
  console.log(`GATE-MEASURE A10-W controller receipts per transaction ${widest} (bound ${SLICE}) for a batch of ${records.length}; journal rows ${JSON.stringify(rows)} (bound: one range row per ${PAGE}); saw no room ${sawNoRoom}; transactions written without room ${wroteWithoutRoom}`);
  expect(indexed(), 'every receipt of the batch is written').toBe(records.length);
  expect(widest, 'receipts changed by one transaction').toBeLessThanOrEqual(SLICE);
  expect(rows, 'one journal range row per page of the batch').toEqual({ receipts: Math.ceil(records.length / PAGE) });
  expect(sawNoRoom, 'the build in flight was behind the burst at some moment').toBe(true);
  expect(wroteWithoutRoom, 'pages written while the build was more than the room behind').toBe(0);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_recall_views WHERE state='ready'").get()!.n), 'the build completed').toBe(3);
  views.startRecallViewMaintenance();
  drain(db);
  expectFreshEqual(w);
}, 240_000);
