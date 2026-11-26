// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner of both sides: q1022-upgradecatchup (the one-time drop in recall-view-schema.ts dropLeftoverRecallViews; the lazy, paced
// rebuild and the paced steady-state reclaim in recall-view.ts). MAIN-RULING q1022-upgradecatchup, 2026-11-25.
// The first 1.0.22 start over a store an earlier release filled with recall views reclaimed them row by row and rebuilt every context
// of the roster at once: 847-2317 MB/min for minutes. Here:
//   W-DROP   the views an earlier release left are gone after the open (the real boot path, database()), without writing their pages,
//            at the open or later (no scrub: MAIN-RULING UPCATCH-1022 D1);
//   W-PURGE  the words of already-forgotten records are overwritten before the drop (MAIN-RULING UPCATCH-1022 D1), only those;
//   W-FRESH  a file no drop ran on warms every context as before (the neighbour recall suites' fixtures);
//   W-MARK   the drop happens once per file: a view built afterwards survives the next open W-OWED: while a committed forget's walk is owed, nothing is dropped until a later open;
//   W-ROLLBACK views an older build wrote after a rollback (no built note) are dropped again at the next open here;
//   W-LAZY   the startup sweep builds nothing; the context a reader asks for is the only one built;
//   W-STEADY the steady-state reclaimer (recallReclaimStep, the upkeep's look) frees at the build pace, not from the 700 MB/min bucket;
//   W-PACE   a demanded build stops at the build pace and finishes once the pace allows it (the reader is refused meanwhile, never hung);
//   W-FLOOR  a polluted meter reading holds the pace for a minute at most (the debt is floored), never for hours;
//   W-CAP    the reclaim a waiting build does at the view cap is paced too, never a run of slices on every loop turn.
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts'; import { BLOCK_BYTES, readProcess } from '../io-budget.ts';
import { Store } from '../store.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { OWNER } from '../human-principals.ts';
import * as views from './recall-view.ts'; import { RecallHeld, RecallReadiness } from './recall-readiness.ts';

// Absent on a tree before the fix: the pace is whatever that tree has (the base run goes RED at the behaviour, not here).
const setPace = (bytes?: number) => (views as { setRecallBuildPaceForTest?: (bytes?: number) => void }).setRecallBuildPaceForTest?.(bytes);
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { setPace(); views.stopRecallViewMaintenance(); closeDatabase(); vi.restoreAllMocks(); });

const count = (table: string) => Number(database().prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
const mark = () => database().prepare("SELECT done,cursor,skipped FROM transcript_index_state WHERE name='recall_views_1022'").get() as { done: number; cursor: number; skipped: number } | undefined;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)); const metered = () => { const reading = readProcess(); return Math.max(reading.fsWriteBlocks * BLOCK_BYTES, reading.meterBytes ?? 0); }; // the process's write bytes, as the watchdog and the pace read them
/** The whole log copied into the file (0), asked again while another connection of the open (a worker leaving) still reads. */
async function checkpointed(): Promise<number> {
  let busy = 1;
  for (let attempt = 0; attempt < 100 && busy !== 0; attempt++) {
    busy = Number((database().prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number }).busy);
    if (busy !== 0) await sleep(100);
  }
  return busy;
}
const MARK_TABLE = 'CREATE TABLE IF NOT EXISTS transcript_index_state(name TEXT PRIMARY KEY, done INTEGER NOT NULL, cursor INTEGER NOT NULL, skipped INTEGER NOT NULL) WITHOUT ROWID';
function walBytes(dir = DATA_DIR): number {
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) bytes += walBytes(path); else if (entry.name.endsWith('-wal')) { try { bytes += statSync(path).size; } catch { /* removed by a connection that just closed */ } }
  }
  return bytes;
}
/** A file as an earlier release left it: `viewCount` ready views without the 1.0.22 mark, `terms` term rows on the first of them.
 *  Every term row is the word of a record that still exists (text 'leftover-term-...'), except `forgotten` more rows whose record is
 *  gone from memory_records (a forgotten item: 'forgotten-term-...'), one of them tombstoned and one in state 'deleted'. */
function leftoverViews(viewCount: number, terms: number, heavy = 0, forgotten = 0): void {
  const db = database();
  db.exec(MARK_TABLE); db.exec("DELETE FROM transcript_index_state WHERE name='recall_views_1022'");
  db.exec('PRAGMA foreign_keys=OFF'); db.exec('BEGIN');
  const view = db.prepare("INSERT INTO memory_recall_views(view_id,generation,authority_epoch,roster_revision,state,scope_count,digest,room_reader) VALUES(?,?,0,0,'ready',0,'',0)");
  for (let n = 0; n < viewCount; n++) view.run(`leftover-${String(n).padStart(4, '0')}`, 'g');
  const term = db.prepare('INSERT INTO memory_recall_view_terms(view_id,generation,term,sequence,record_id,version) VALUES(?,?,?,?,?,1)');
  const record = db.prepare("INSERT OR IGNORE INTO memory_records VALUES(?,1,'leftover-scope','constraint',?,'owner-statement',?,1,1,NULL,NULL,1)");
  const id = `leftover-${String(heavy).padStart(4, '0')}`;
  for (let n = 0; n < terms; n++) {
    // one live record per 100 term rows
    if (n % 100 === 0) record.run(`leftover-record-${n / 100}`, 'still here', 'active');
    term.run(id, 'g', `leftover-term-${String(n).padStart(8, '0')}-padding-padding-padding`, n, `leftover-record-${Math.floor(n / 100)}`);
  }
  for (let n = 0; n < forgotten; n++) term.run(id, 'g', `forgotten-term-${String(n).padStart(8, '0')}-padding-padding-padding`, terms + n, `forgotten-record-${n}`);
  if (forgotten) {
    record.run('deleted-record', '', 'deleted'); term.run(id, 'g', 'forgotten-term-deleted-state-padding-padding', terms + forgotten, 'deleted-record');
    record.run('tombstoned-record', '', 'active'); term.run(id, 'g', 'forgotten-term-tombstoned-padding-padding', terms + forgotten + 1, 'tombstoned-record');
    db.prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES('fixture-tombstone','record','tombstoned-record',NULL,NULL,0,'test',1)").run();
  }
  db.exec('COMMIT'); db.exec('PRAGMA foreign_keys=ON');
}
function binding(store: Store, bot = store.bots[0]): views.RecallViewBinding {
  return { botId: bot.id, threadId: bot.threadId, notOwnerAudience: false, humanPrincipal: OWNER };
}
/** Counts the derived term rows written and deleted on the real connection (TEMP triggers on the main table). */
function termCounters() {
  const db = database();
  db.exec('CREATE TEMP TABLE IF NOT EXISTS fixture_terms(written INTEGER NOT NULL,deleted INTEGER NOT NULL); DELETE FROM fixture_terms; INSERT INTO fixture_terms VALUES(0,0);');
  db.exec('CREATE TEMP TRIGGER IF NOT EXISTS fixture_term_i AFTER INSERT ON main.memory_recall_view_terms BEGIN UPDATE fixture_terms SET written=written+1; END;');
  db.exec('CREATE TEMP TRIGGER IF NOT EXISTS fixture_term_d AFTER DELETE ON main.memory_recall_view_terms BEGIN UPDATE fixture_terms SET deleted=deleted+1; END;');
  return () => db.prepare('SELECT written,deleted FROM fixture_terms').get() as unknown as { written: number; deleted: number };
}
/** A store with 3 bots x 3 threads and `records` records of 12 words in every conversation scope, booted the way the server boots it.
 *  `upgraded` (default): the file is one an earlier release left views in, opened once by this release (dropped and marked). */
async function start(records: number, upgraded = true): Promise<Store> {
  if (upgraded) { database(); leftoverViews(3, 100); closeDatabase(); database(); }
  const store = new Store(() => ({ instanceId: 'fixture', model: 'model' }));
  for (let n = 0; n < 3; n++) {
    const bot = store.createBot({ name: `Reader ${n}` }, { seedMessages: false });
    for (let t = 0; t < 2; t++) store.createTask(bot.id, `Task ${t}`, false);
  }
  const db = database(); let n = 0;
  db.exec('BEGIN');
  for (const row of db.prepare("SELECT id FROM memory_scopes WHERE kind='conversation'").all()) for (let k = 0; k < records; k++) {
    n++;
    db.prepare("INSERT INTO memory_records VALUES(?,1,?,'constraint',?,'owner-statement','active',1,1,NULL,NULL,1)")
      .run(`fixture-record-${n}`, row.id, Array.from({ length: 12 }, (_, w) => `word${w}x${n}`).join(' '));
  }
  db.exec('COMMIT');
  store.finishSharingBoot();
  await views.waitForRecallConstructionIdleForTest(store); views.stopRecallViewMaintenance();
  return store;
}

it('W-DROP: the recall views an earlier release left are dropped at the open, without writing their pages', async () => {
  database();
  leftoverViews(40, 20_000);
  expect(count('memory_recall_view_terms')).toBe(20_000);
  expect(await checkpointed()).toBe(0); closeDatabase(); // (the fixture's own pages are in the file before the open is metered)
  const before = walBytes(), meterBefore = metered();
  database(); // the boot path: the memory schema step runs ensureRecallViewSchema
  const written = walBytes() - before, openBytes = metered() - meterBefore;
  expect({ views: count('memory_recall_views'), terms: count('memory_recall_view_terms') }).toEqual({ views: 0, terms: 0 });
  expect(Number(database().prepare('SELECT bytes FROM memory_recall_storage WHERE id=1').get()!.bytes)).toBe(0);
  console.info('W-DROP', JSON.stringify({ walBytes: written, openBytes }));
  expect(openBytes, 'bytes the process wrote in the open itself (purge and drop): under the 5.9 MiB of pages the drop freed').toBeLessThan(3 * 1024 * 1024);
  // secure_delete is back on for everything after the drop
  expect(Number(database().prepare('PRAGMA secure_delete').get()!.secure_delete)).toBe(1);
  // MAIN-RULING UPCATCH-1022 D1: no scrub is owed (done=1 at once), the file is marked as one a drop ran on, and no filler row or
  // object a backup's inspection or an older build does not know was added
  expect(mark()).toMatchObject({ done: 1, skipped: 1 });
  expect(Number(mark()!.cursor)).toBeGreaterThan(600); // pages the drop freed
  expect(Number(database().prepare("SELECT count(*) AS n FROM transcript_index_state WHERE name LIKE 'recall_scrub_1022:%'").get()!.n)).toBe(0);
  expect(database().prepare("SELECT name FROM sqlite_schema WHERE name LIKE '%1022%'").all()).toEqual([]);
  // The cost the drop avoids, read from the file itself: the freed pages were handed to the free list as they were, not rewritten (a
  // drop under secure_delete, or a row-by-row reclaim, writes every one of them): the words of the records that still exist are
  // still readable in the freed pages, and the upkeep does not come back to overwrite them. The log is copied into the file first.
  for (let look = 0; look < 200; look++) views.runRecallUpkeepForTest();
  views.stopRecallViewMaintenance();
  expect(Number(database().prepare('PRAGMA freelist_count').get()!.freelist_count)).toBeGreaterThan(600);
  expect(await checkpointed()).toBe(0);
  closeDatabase();
  expect(readFileSync(join(DATA_DIR, 'messages.db')).includes('leftover-term-00000001-padding')).toBe(true);
}, 120_000);

it('W-PURGE: the words of an already-forgotten record are overwritten in the file before the drop; the words of live records are not rewritten', async () => {
  database();
  leftoverViews(40, 20_000, 0, 300);
  expect(count('memory_recall_view_terms')).toBe(20_302);
  expect(await checkpointed()).toBe(0);
  closeDatabase();
  // the fixture itself: the forgotten words are in the file before the upgrade
  expect(readFileSync(join(DATA_DIR, 'messages.db')).includes('forgotten-term-00000001-padding')).toBe(true);
  database(); // the boot path
  const left = { views: count('memory_recall_views'), terms: count('memory_recall_view_terms') };
  const secure = Number(database().prepare('PRAGMA secure_delete').get()!.secure_delete);
  expect(await checkpointed()).toBe(0);
  closeDatabase();
  const file = readFileSync(join(DATA_DIR, 'messages.db'));
  // gone record, record in state 'deleted', tombstoned record: none of their words is left anywhere in the file
  const found = { gone: file.includes('forgotten-term-0'), deleted: file.includes('forgotten-term-deleted-state'), tombstoned: file.includes('forgotten-term-tombstoned') };
  expect(found).toEqual({ gone: false, deleted: false, tombstoned: false });
  // and the purge took only those rows: the live records' words went to the free list unwritten
  expect(file.includes('leftover-term-00000001-padding')).toBe(true);
  expect(left).toEqual({ views: 0, terms: 0 });
  expect(secure).toBe(1);
}, 120_000);

it('W-MARK: the drop is once per file; a view built after it survives the next open', () => {
  database();
  leftoverViews(3, 100);
  closeDatabase(); database();
  expect(count('memory_recall_views')).toBe(0);
  database().prepare("INSERT INTO memory_recall_views(view_id,generation,authority_epoch,roster_revision,state,scope_count,digest,room_reader) VALUES('built-after','g',0,0,'ready',0,'',0)").run();
  closeDatabase(); database();
  expect(count('memory_recall_views')).toBe(1);
}, 120_000);

it('W-ROLLBACK: views an older build wrote after a rollback are dropped again at the next open; views built here survive it', () => {
  database();
  leftoverViews(3, 100);
  closeDatabase(); database(); // the first upgrade: dropped, marked
  expect(count('memory_recall_views')).toBe(0);
  database().prepare("INSERT INTO memory_recall_views(view_id,generation,authority_epoch,roster_revision,state,scope_count,digest,room_reader) VALUES('built-here','g',0,0,'ready',0,'',0)").run();
  closeDatabase(); database();
  expect(count('memory_recall_views')).toBe(1); // nothing foreign: the view built here stands
  closeDatabase();
  // the older build's own connection (it keeps no note of what it builds) fills the views again
  const older = new DatabaseSync(join(DATA_DIR, 'messages.db'));
  try {
    older.exec('PRAGMA busy_timeout=5000');
    const term = older.prepare('INSERT INTO memory_recall_view_terms(view_id,generation,term,sequence,record_id,version) VALUES(?,?,?,?,?,1)');
    older.exec('BEGIN');
    for (let n = 0; n < 5; n++) older.prepare("INSERT INTO memory_recall_views(view_id,generation,authority_epoch,roster_revision,state,scope_count,digest,room_reader) VALUES(?,?,0,0,'ready',0,'',0)").run(`rolled-back-${n}`, 'g');
    for (let n = 0; n < 500; n++) term.run('rolled-back-0', 'g', `rolled-back-term-${n}`, n, `rolled-back-record-${n}`);
    older.exec('COMMIT');
  } finally { older.close(); }
  database(); // the next start of this release
  expect({ views: count('memory_recall_views'), terms: count('memory_recall_view_terms') }).toEqual({ views: 0, terms: 0 });
  expect(mark()).toMatchObject({ done: 1, skipped: 1 });
}, 120_000);

it('W-LAZY: the startup sweep builds no view; only the context a reader asks for is built', async () => {
  const store = await start(4);
  const terms = termCounters();
  expect({ contexts: count('memory_recall_contexts'), views: count('memory_recall_views') }).toEqual({ contexts: 0, views: 0 });
  // the reader's first ask is refused (the turn goes out with the held line) and queues its own build
  expect(() => views.resolveRecallView(binding(store), store)).toThrow('MEMORY_RECALL_UNAVAILABLE');
  await views.waitForRecallConstructionIdleForTest(store); views.stopRecallViewMaintenance();
  expect(views.resolveRecallView(binding(store), store).handle.viewId).not.toBe('');
  expect(count('memory_recall_contexts')).toBe(1);
  expect(terms().written).toBeGreaterThan(0);
  // another context is still not built until it is asked for
  expect(() => views.resolveRecallView(binding(store, store.bots[1]), store)).toThrow('MEMORY_RECALL_UNAVAILABLE');
}, 120_000);

it('W-WARM: after a roster change, warming rebuilds the context a reader asked for in the last 15 minutes, and no other', async () => {
  const store = await start(4);
  try { views.resolveRecallView(binding(store), store); } catch { /* the first ask queues its build */ }
  await views.waitForRecallConstructionIdleForTest(store); views.stopRecallViewMaintenance();
  const first = views.resolveRecallView(binding(store), store).handle;
  expect(count('memory_recall_contexts')).toBe(1);
  store.createTask(store.bots[0].id, 'Another task', false); // a roster change in the asked context's own bot: its view is stale, every context is enumerated
  await views.waitForRecallConstructionIdleForTest(store); views.stopRecallViewMaintenance();
  console.info('W-WARM', JSON.stringify({ contexts: count('memory_recall_contexts'), views: count('memory_recall_views') }));
  // no context nobody asked for was built (the tree before the fix warms every context of the roster here)
  expect(count('memory_recall_contexts')).toBe(1);
  // the asked one was rebuilt by the warming itself: its reader gets the new view at once, with no refusal and no new ask
  let again = 'refused';
  try { again = views.resolveRecallView(binding(store), store).handle.generation; } catch { /* not rebuilt: the reader is refused and has to ask */ }
  expect({ refused: again === 'refused', rebuilt: again !== first.generation }).toEqual({ refused: false, rebuilt: true });
}, 120_000);

it('W-FRESH: on a file no drop ran on, the first start still builds every context (paced), as before this lane', async () => {
  // (a guard of this lane's own change: GREEN on the tree before the lane, RED when the lazy rule reaches a file no drop ran on)
  const store = await start(4, false);
  // 3 bots x 3 threads x 2 audiences
  expect(count('memory_recall_contexts')).toBeGreaterThanOrEqual(18);
  expect(views.resolveRecallView(binding(store), store).handle.viewId).not.toBe('');
}, 120_000);

/** No context is published and none is cached: the next ask has to build (on a tree whose startup sweep built them, too). */
function forgetContexts(): void { database().exec('DELETE FROM memory_recall_contexts'); }

it('W-PACE: a demanded build stops at the build pace and finishes once the pace allows it', async () => {
  const store = await start(300);
  forgetContexts();
  setPace(1); // one byte a minute: only the bucket's first room is left
  const terms = termCounters();
  expect(() => views.resolveRecallView(binding(store), store)).toThrow('MEMORY_RECALL_UNAVAILABLE');
  await sleep(6000);
  const paced = terms().written;
  // the reader is refused again at once (never a hang) while the build waits for the pace
  expect(() => views.resolveRecallView(binding(store), store)).toThrow('MEMORY_RECALL_UNAVAILABLE');
  setPace(1e15);
  await views.waitForRecallConstructionIdleForTest(store); views.stopRecallViewMaintenance();
  expect(views.resolveRecallView(binding(store), store).handle.viewId).not.toBe('');
  const total = terms().written;
  console.info('W-PACE', JSON.stringify({ paced, total }));
  // six seconds at one byte a minute: the first room (2 MiB) paid for 3,012 to 6,084 of 10,800 rows (by box) and the build still waits; unpaced, every row is written in about a second
  expect(paced).toBeLessThan(total);
  expect(total).toBeGreaterThan(0);
}, 120_000);

it('W-CAP: at the view cap a waiting build reclaims at the build pace, not a slice on every loop turn', async () => {
  const store = await start(4);
  forgetContexts();
  leftoverViews(129, 20_000); // the mark is set again by the open below only on a new file: here the views stand, as after a rollback
  database().prepare("INSERT OR IGNORE INTO transcript_index_state(name,done,cursor,skipped) VALUES('recall_views_1022',1,0,0)").run();
  setPace(1);
  const terms = termCounters();
  expect(() => views.resolveRecallView(binding(store), store)).toThrow();
  await sleep(2500);
  const deleted = terms().deleted;
  console.info('W-CAP', JSON.stringify({ deleted }));
  // one slice is 256 rows; the bucket's first room pays for a few, the rest waits for the pace (20,000 rows stand on the first view)
  expect(deleted).toBeGreaterThan(0);
  expect(deleted).toBeLessThan(10_000);
}, 120_000);

it('W-STEADY: the steady-state reclaimer frees leftover views at the build pace, not from the 700 MB/min bucket', async () => {
  await start(4);
  leftoverViews(20, 60_000); // unbound ready views, as a rollback or superseded generations leave them: the reclaimer's own victims
  database().prepare("INSERT OR IGNORE INTO transcript_index_state(name,done,cursor,skipped) VALUES('recall_views_1022',1,0,0)").run();
  await sleep(1500); // past the reclaimer's yield to the fixture's own writes (500 ms)
  setPace(1); // one byte a minute: only the bucket's first room (2 MiB) is left
  const terms = termCounters();
  for (let look = 0; look < 300; look++) views.runRecallUpkeepForTest(); // the upkeep's own look -> recallReclaimStep
  const paced = terms().deleted;
  setPace(1e15);
  for (let look = 0; look < 20_000 && terms().deleted < 60_000; look++) views.runRecallUpkeepForTest();
  views.stopRecallViewMaintenance();
  const total = terms().deleted;
  console.info('W-STEADY', JSON.stringify({ paced, total }));
  // the first room pays for a few slices; the tree before the fix frees every row from the 700 MB/min bucket in these looks
  expect(paced).toBeGreaterThan(0);
  expect(paced).toBeLessThan(30_000);
  // and the pace only delays: once it allows, every leftover row is freed
  expect(total).toBe(60_000);
}, 120_000);

it('W-FLOOR: a meter reading polluted by other writers holds the pace for a minute at most, never for hours', async () => {
  const store = await start(300);
  forgetContexts();
  // every reading of the meter is another terabyte (the start-up files worker writes next to a slice on the same process meter)
  let skew = 0, written = 0;
  views.setRecallReclaimClockForTest({ now: () => Date.now() + skew, written: () => (written += 1e12) });
  try {
    expect(() => views.resolveRecallView(binding(store), store)).toThrow('MEMORY_RECALL_UNAVAILABLE');
    await sleep(1500);
    // the pace holds the build while the meter says so (the reader is refused at once, never hung)
    expect(() => views.resolveRecallView(binding(store), store)).toThrow('MEMORY_RECALL_UNAVAILABLE');
    // ... and owes one minute at most per reading: a minute of the clock later the next slice runs, and so on to the end
    let ready = false, minutes = 0;
    for (; minutes < 400 && !ready; minutes++) {
      skew += 61_000; await sleep(150);
      try { ready = views.resolveRecallView(binding(store), store).handle.viewId !== ''; } catch { /* still building */ }
    }
    console.info('W-FLOOR', JSON.stringify({ minutes, ready }));
    expect(ready).toBe(true);
  } finally { views.setRecallReclaimClockForTest(); }
}, 240_000);

it('W-OWED: while a forget has committed and its walk is still owed, nothing is dropped; the drop runs at the open after the walk', async () => {
  database();
  leftoverViews(40, 20_000); // every term row belongs to a record that still stands: the walk has not marked anything yet
  const db = database();
  db.exec('PRAGMA foreign_keys=OFF');
  // the durable job row a committed forget leaves until its walk ends (memory-revocation.ts createRevocationJob)
  db.prepare("INSERT INTO memory_scope_bindings VALUES('memory-revocation:fixture','leftover-scope','system','memory-revocation',0,'granted','{}')").run();
  db.exec('PRAGMA foreign_keys=ON');
  expect(await checkpointed()).toBe(0); closeDatabase(); // (the fixture's own pages are in the file before the open is metered)
  const meterBefore = metered();
  database(); // the boot path, with the walk owed
  const owed = { views: count('memory_recall_views'), terms: count('memory_recall_view_terms'), marked: mark() !== undefined, openMiB: Math.round((metered() - meterBefore) / 1048576) };
  console.info('W-OWED', JSON.stringify(owed));
  // nothing dropped (no residue in freed pages), nothing rewritten (no burst at the open), and the file is not marked: a later open decides again
  expect(owed).toEqual({ views: 40, terms: 20_000, marked: false, openMiB: 0 });
  database().prepare("DELETE FROM memory_scope_bindings WHERE id='memory-revocation:fixture'").run(); // the walk ended
  closeDatabase(); database();
  expect({ views: count('memory_recall_views'), terms: count('memory_recall_view_terms') }).toEqual({ views: 0, terms: 0 });
  expect(mark()).toMatchObject({ done: 1, skipped: 1 });
}, 120_000);

// q1023-upcatch (self-review H1 on the F3 port): a forget job that has not finished its walk is owed in EVERY non-final state, not only
// 'active'/'undoing'. F3 (1.0.22 revokehealth) parks a job that keeps failing as 'quarantined' (revoke-marker.ts quarantineFailingJobs) and
// a bulk revoke sits in 'seeding' until its fold; a 'folded' member hands its work to such a bulk. What these cover is not yet marked deleted
// or tombstoned, so the purge cannot name its words and a drop with secure_delete off would leave them in freed pages.
it.each(['active', 'undoing', 'seeding', 'quarantined', 'folded'])('W-OWED-JOB %s: a forget job left in this state holds the drop back; the drop runs once the job is done', async (state) => {
  database();
  leftoverViews(40, 20_000);
  database().prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(77,'line','{}',1,1,'mark','',?)").run(state);
  closeDatabase();
  database(); // the boot path, with the job unfinished
  expect({ state, views: count('memory_recall_views'), terms: count('memory_recall_view_terms'), marked: mark() !== undefined })
    .toEqual({ state, views: 40, terms: 20_000, marked: false });
  database().prepare("UPDATE memory_revoke_jobs SET state='done' WHERE revoke_id=77").run(); // the walk ended
  closeDatabase(); database();
  expect({ state, views: count('memory_recall_views'), terms: count('memory_recall_view_terms') }).toEqual({ state, views: 0, terms: 0 });
}, 120_000);

// q1023-upcatch (ASTRA precheck High, MAIN-RULING local-memory-budget: no memory budget delays an owner turn): while the context's build
// waits only on the build pace, the turn's readiness wait (recall-readiness.ts, the wait admittedRecallRead runs for every owner dispatch)
// ends at once with the held line instead of waiting its 300 ms probes out on memory's own pace.
it('W-TURN-PACE: an owner turn whose context build waits on the pace is held at once, not after the probe wait', async () => {
  const store = await start(300);
  forgetContexts();
  setPace(1); // one byte a minute: the build spends the first room and then waits on the pace
  expect(() => views.resolveRecallView(binding(store), store)).toThrow('MEMORY_RECALL_UNAVAILABLE'); // the demand
  await sleep(3000);
  const readiness = new RecallReadiness();
  const t0 = performance.now();
  const outcome = await readiness.access(() => views.resolveRecallView(binding(store), store), new AbortController().signal, undefined, { owner: true })
    .then(() => 'recalled', (error: unknown) => error instanceof RecallHeld ? 'held' : String(error));
  const waitedMs = Math.round(performance.now() - t0);
  console.info('W-TURN-PACE', JSON.stringify({ outcome, waitedMs }));
  expect({ outcome, waitedUnder100ms: waitedMs < 100 }).toEqual({ outcome: 'held', waitedUnder100ms: true });
  setPace(1e15);
  await views.waitForRecallConstructionIdleForTest(store); views.stopRecallViewMaintenance();
  // once the pace allows it the build publishes, and the next turn gets its recall
  expect(await new RecallReadiness().access(() => views.resolveRecallView(binding(store), store).handle.viewId !== '', new AbortController().signal, undefined, { owner: true })).toBe(true);
}, 120_000);

// q1023-upcatch (ASTRA pass 3 High, the sibling path): a redispatch after a revoke reads through rebuildAccess (index.ts
// awaitRecallViewPublished / admittedRecallRead with rebuild). While its build waits only on the pace it ends at once with the same
// "view not ready" it would give at the 2 s deadline, never waiting the deadline out on memory's own pace.
it('W-TURN-PACE-REBUILD: a redispatch whose context build waits on the pace ends at once, not after the 2 s rebuild wait', async () => {
  const store = await start(300);
  forgetContexts();
  setPace(1);
  expect(() => views.resolveRecallView(binding(store), store)).toThrow('MEMORY_RECALL_UNAVAILABLE');
  await sleep(3000);
  const t0 = performance.now();
  const outcome = await new RecallReadiness().access(() => views.resolveRecallView(binding(store), store), new AbortController().signal, undefined, { owner: true, rebuild: true })
    .then(() => 'recalled', (error: unknown) => (error as Error)?.constructor?.name ?? String(error));
  const waitedMs = Math.round(performance.now() - t0);
  console.info('W-TURN-PACE-REBUILD', JSON.stringify({ outcome, waitedMs }));
  expect({ outcome, waitedUnder100ms: waitedMs < 100 }).toEqual({ outcome: 'RecallViewNotReady', waitedUnder100ms: true });
}, 120_000);
