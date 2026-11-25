// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: mem-f1 (MEMAUDIT F1, 1.0.21). Consumer owner of the view tables: recall-scope.
// The cost of keeping recall views current must follow what changed, never the number of views. Before the fix every change-journal row was
// replayed into every view, one view and one write transaction at a time, and every job status update (lease, heartbeat, settle) wrote a
// journal row no view can use. The scale witnesses count statements, row changes, journal rows and commits on the real connection for the
// same turn on a store with few views and one with many; the privacy witnesses pin that a forget, a move and a delete still reach every view.
// memv2 lane A (MEMORY-V2-DESIGN 4.2 A1-A6) took the file over: one applier with one applied mark kept in memory, a change routed to the
// views that hold its scope now or held it before (notes written by the writer), the persisted watermark written lazily, no timer. The
// oracle of every witness is W-F1-EQUAL (harvested from mem-f1-opusrace): after the applier, every view equals a fresh build of its context.
import { mkdirSync } from 'node:fs';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { ensureScope, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { setMemoryMode } from './repository.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import * as views from './recall-view.ts';
// Absent on a tree before lane A (the RED run on f6ae52c670): the witnesses that measure a cost still run there.
// Lane W's wake bus (absent on the base this file is also run on: then nothing can be armed and the reads below answer "none").
const wakeModule = './wake.ts';
const bus: { deadlineOf(topic: string): number | undefined; wakeStats(): { timerArmed: boolean; deadlines: number; owed: number } } | undefined = await import(/* @vite-ignore */ wakeModule).catch(() => undefined);
const wake = { armedDeadlinesForTest: (): string[] => bus ? [...['journal', 'recall-upkeep'].filter(topic => bus.deadlineOf(topic) !== undefined), ...(bus.wakeStats().timerArmed ? ['timer'] : [])] : [] };
// Lane H's session collector is not on this branch; its two riders would keep the upkeep's deadline armed (as the 50 ms tick did).
// The witnesses run with a collector whose figures never move, which is what lane H's export answers on an idle connection, and
// count the rider calls; W-A-TIMER covers both forms.
const riders = { calls: 0, figures: { checksWrites: 0, seedInputs: 0, expiryDue: 0, lap: { done: true, at: 0 } } as { checksWrites: number; seedInputs: number; expiryDue: number; lap: { done: boolean; at: number }; recover?: { done: boolean } } };

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  riders.calls = 0; riders.figures = { checksWrites: 0, seedInputs: 0, expiryDue: 0, lap: { done: true, at: 0 } };
  views.setRecallSessionRidersForTest?.(() => riders.figures, () => { riders.calls++; }); });
afterEach(() => { views.stopRecallViewMaintenance(); views.setRecallSessionRidersForTest?.(); closeDatabase(); });

interface Cost { statements: number; rows: number; begins: number; commits: number; termInserts: number; termDeletes: number; widestList: number; watermarkWrites: number; recall: number }
/** Counts, on the real connection: every statement executed (run/get/all), row changes with trigger rows (total_changes), write
 *  transactions opened and committed, and the term rows written to and removed from the views. */
function meter(db: DatabaseSync) {
  const cost: Cost = { statements: 0, rows: 0, begins: 0, commits: 0, termInserts: 0, termDeletes: 0, widestList: 0, watermarkWrites: 0, recall: 0 };
  // The connection's own prepare/exec are instance properties (the io-budget wrapper, which is also where lane W's bus sees a commit):
  // stop() must put exactly those back, never fall through to the prototype's raw methods.
  const own = { prepare: Object.getOwnPropertyDescriptor(db, 'prepare'), exec: Object.getOwnPropertyDescriptor(db, 'exec') };
  const prepare = db.prepare.bind(db), exec = db.exec.bind(db);
  const total = prepare('SELECT total_changes() AS n');
  const before = Number(total.get()!.n);
  let noteSql = (_sql: string) => {};
  (db as { prepare: (sql: string) => StatementSync }).prepare = (sql: string) => {
    noteSql(sql);
    const statement = prepare(sql);
    const terms = /^\s*(INSERT|DELETE)\b[^;]*\bmemory_recall_view_terms\b/i.exec(sql)?.[1]?.toUpperCase();
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function' || !['run', 'get', 'all'].includes(String(key))) return typeof value === 'function' ? value.bind(target) : value;
      return (...args: unknown[]) => {
        cost.statements++;
        // Statements on the views' own tables (the journal, the views, their rows): lane A's share of an idle minute.
        if (/memory_recall_/.test(sql)) cost.recall++;
        // The widest list of views one unconditional removal names (dropRecordFrom, dropJobFrom: the form used for views that do not read
        // the object; a change that has to ask every view names them all), and the watermark rows written.
        if (/^DELETE FROM memory_recall_view_\w+ WHERE \(view_id,generation.*FROM json_each\(\?1\)\)$/s.test(sql) && typeof args[0] === 'string') cost.widestList = Math.max(cost.widestList, (JSON.parse(args[0]) as unknown[]).length);
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (/^UPDATE memory_recall_views SET watermark/.test(sql)) cost.watermarkWrites += Number((result as { changes: number | bigint }).changes);
        if (terms && key === 'run') cost[terms === 'INSERT' ? 'termInserts' : 'termDeletes'] += Number((result as { changes: number | bigint }).changes);
        return result;
      };
    } });
  };
  (db as { exec: (sql: string) => void }).exec = (sql: string) => {
    if (sql === 'BEGIN IMMEDIATE') cost.begins++;
    if (sql === 'COMMIT') cost.commits++;
    return exec(sql);
  };
  const self = { cost, reclaimSql: '', stop: () => { delete (db as { prepare?: unknown }).prepare; delete (db as { exec?: unknown }).exec; if (own.prepare) Object.defineProperty(db, 'prepare', own.prepare); if (own.exec) Object.defineProperty(db, 'exec', own.exec); cost.rows = Number(total.get()!.n) - before; return cost; } };
  noteSql = (sql: string) => { if (/FROM memory_recall_views v ORDER BY view_id,generation/.test(sql)) self.reclaimSql = sql; };
  return self;
}

const journalHead = (db: DatabaseSync) => Number(db.prepare('SELECT coalesce(max(sequence),0) AS n FROM memory_recall_changes').get()!.n);
const lagging = (db: DatabaseSync) => Number(db.prepare(`SELECT count(*) AS n FROM memory_recall_views v WHERE v.state='ready'
  AND EXISTS(SELECT 1 FROM memory_recall_contexts c WHERE c.view_id=v.view_id AND c.generation=v.generation) AND v.watermark<?`).get(journalHead(db))!.n);
type Handle = { viewId: string; generation: string; digest: string };
const bound = (db: DatabaseSync): Handle[] => db.prepare(`SELECT v.view_id,v.generation,v.digest FROM memory_recall_contexts c JOIN memory_recall_views v
  ON v.view_id=c.view_id AND v.generation=c.generation ORDER BY c.context_key`).all().map(row => ({ viewId: String(row.view_id), generation: String(row.generation), digest: String(row.digest) }));
/** Is the view current? The one helper every reader uses (the applied mark is in memory); the persisted watermark on a tree without it. */
const current = (db: DatabaseSync, view: Handle) => views.recallViewCurrent ? views.recallViewCurrent(db, view)
  : Number(db.prepare('SELECT watermark FROM memory_recall_views WHERE view_id=? AND generation=?').get(view.viewId, view.generation)!.watermark) >= journalHead(db);
/** The applier's own run, as a journal wake makes it, until the fleet has read the whole journal (no statement of the witness is counted:
 *  the loop asks the in-memory mark). On a tree without the applier: the old upkeep walk, one maintainRecallViewSlice a context. */
function apply(db: DatabaseSync): number {
  let slices = 0;
  if (views.runRecallApplierForTest) {
    const head = journalHead(db);
    do { views.runRecallApplierForTest(); slices++; } while (slices < 4096 && (views.recallAppliedMarkForTest(db).applied ?? head) < head);
    return slices;
  }
  for (let lap = 0; lap < 64 && lagging(db); lap++) for (const view of bound(db)) { if (!lagging(db)) break; views.maintainRecallViewSlice(view); slices++; }
  return slices;
}
/** Until every bound view is current. On this tree by the applier's own runs ALONE (one fleet page and one page for one view behind it a
 *  run): no witness helps a view along by asking for it by name, so a view the applier would not serve fails the witness here. On a tree
 *  without the applier: the old upkeep walk. */
function drain(db: DatabaseSync): number {
  let slices = apply(db);
  const behind = () => bound(db).filter(view => !current(db, view));
  if (views.runRecallApplierForTest) for (let run = 0; run < 2048 && behind().length; run++) { views.runRecallApplierForTest(); slices++; }
  else for (let lap = 0; lap < 64 && behind().length; lap++) for (const view of behind()) { views.maintainRecallViewSlice(view); slices++; }
  expect(behind().length, 'every bound view reads the whole journal').toBe(0);
  return slices;
}
/** Everything a view derives, keyed without its own id: what the applier must leave equal to a fresh build (W-F1-EQUAL). */
function content(db: DatabaseSync, view: { viewId: string; generation: string }) {
  const args = [view.viewId, view.generation];
  return {
    records: db.prepare('SELECT record_id,version,sequence,kind,pinned,state,scope_id FROM memory_recall_view_records WHERE view_id=? AND generation=? ORDER BY record_id,version').all(...args).map(row => ({ ...row })),
    terms: db.prepare('SELECT term,sequence,record_id,version FROM memory_recall_view_terms WHERE view_id=? AND generation=? ORDER BY record_id,version,term').all(...args).map(row => ({ ...row })),
    pending: db.prepare('SELECT sequence,record_id,version FROM memory_recall_view_pending WHERE view_id=? AND generation=? ORDER BY sequence,record_id').all(...args).map(row => ({ ...row })),
    jobs: db.prepare('SELECT sequence,job_id FROM memory_recall_view_jobs WHERE view_id=? AND generation=? ORDER BY sequence,job_id').all(...args).map(row => ({ ...row })),
  };
}
/** Every context's view against a fresh generation of the same context, built from the authoritative rows after the authority epoch moved. */
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
/** Every persisted object, as text (K1 / rule C1: lane A adds, drops and edits none; its guards, notes and wakes are TEMP). */
const persistedSchema = (db: DatabaseSync) => JSON.stringify(db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name').all());
const QUEUE = 40;
interface World { db: DatabaseSync; roster: MemoryRoster; own: string; foreign: string; shared: string; viewOf: (bot: number) => { viewId: string; generation: string; digest: string } }
/** `count` bots, one ready view each, and a standing queue of QUEUE pending jobs of another conversation. */
function world(count: number): World {
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: Array.from({ length: count }, (_, n) => ({ id: `bot-${n}`, threadId: `thread-${n}` })), groups: [] };
  reconcileMemoryRoster(roster); setMemoryMode('active'); views.stopRecallViewMaintenance();
  const db = database(), foreign = ensureScope('conversation', 'elsewhere');
  for (let n = 0; n < QUEUE; n++) addJob(db, `queued-${n}`, foreign, 'elsewhere');
  for (const bot of roster.bots) views.prepareRecallContextSync(bot.id, bot.threadId!, roster);
  views.stopRecallViewMaintenance();
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_recall_views WHERE state='ready'").get()!.n), 'one ready view per bot').toBe(count);
  const viewOf = (bot: number) => {
    const row = database().prepare('SELECT v.view_id,v.generation,v.digest FROM memory_recall_contexts c JOIN memory_recall_views v ON v.view_id=c.view_id AND v.generation=c.generation WHERE c.context_key LIKE ?').get(`["bot-${bot}",%`)!;
    return { viewId: String(row.view_id), generation: String(row.generation), digest: String(row.digest) };
  };
  const mine = viewOf(0);
  const holders = (scope: string) => Number(db.prepare('SELECT count(*) AS n FROM memory_recall_view_scopes WHERE scope_id=? AND lineage_only=0').get(scope)!.n);
  // A scope only bot-0's view reads, and one every view reads: taken from the views themselves, so the fixture cannot drift from the policy.
  const own = db.prepare(`SELECT s.scope_id FROM memory_recall_view_scopes s WHERE s.view_id=? AND s.generation=? AND s.lineage_only=0
    AND (SELECT count(*) FROM memory_recall_view_scopes o WHERE o.scope_id=s.scope_id AND o.lineage_only=0)=1 ORDER BY s.scope_id LIMIT 1`).get(mine.viewId, mine.generation);
  const shared = db.prepare(`SELECT s.scope_id FROM memory_recall_view_scopes s WHERE s.view_id=? AND s.generation=? AND s.lineage_only=0
    AND (SELECT count(*) FROM memory_recall_view_scopes o WHERE o.scope_id=s.scope_id AND o.lineage_only=0)=? ORDER BY s.scope_id LIMIT 1`).get(mine.viewId, mine.generation, count);
  expect(own, 'a scope only one view reads').toBeTruthy(); expect(shared, 'a scope every view reads').toBeTruthy();
  expect(holders(foreign), 'no view reads the queue\'s conversation').toBe(0);
  drain(db);
  return { db, roster, own: String(own!.scope_id), foreign, shared: String(shared!.scope_id), viewOf };
}
function addJob(db: DatabaseSync, id: string, scope: string, thread: string): void {
  db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,?,'text','owner','recorded',NULL,'active')").run(`src-${id}`, scope, thread, `m-${id}`, `h-${id}`);
  db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,'{}',1)").run(`src-${id}`, `h-${id}`);
  db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch) VALUES(?,?,1,'capture','1','pending',0,0,0,0,0)").run(id, `src-${id}`);
}
/** What a worker does to one job: lease, two heartbeats, settle. Status only; the job keeps its id and its source. */
function workJob(db: DatabaseSync, id: string): void {
  db.prepare("UPDATE memory_jobs SET status='leased',lease_owner='w',lease_generation=lease_generation+1,lease_until=1000 WHERE id=?").run(id);
  db.prepare('UPDATE memory_jobs SET lease_until=max(lease_until,?) WHERE id=?').run(2000, id);
  db.prepare('UPDATE memory_jobs SET lease_until=max(lease_until,?) WHERE id=?').run(3000, id);
  db.prepare("UPDATE memory_jobs SET status='complete',cursor=1,lease_owner=NULL,lease_until=0,error=NULL WHERE id=?").run(id);
}
const TEXT = 'saffron harbour lantern quartz meadow violin copper orchard glacier ember willow compass';
/** A record as the pipeline writes it: the record, its projection receipt, then the receipt's flip (three journal rows). */
function addRecord(db: DatabaseSync, id: string, scope: string, text = TEXT): void {
  db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',0,1,NULL,NULL,1)").run(id, scope, text);
  db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,1,'pending','pending',NULL)").run(id);
  db.prepare("UPDATE memory_projection_receipts SET lexical_status='indexed' WHERE record_id=? AND record_version=1").run(id);
}
const termsOf = (db: DatabaseSync, id: string) => db.prepare('SELECT view_id,count(*) AS n FROM memory_recall_view_terms WHERE record_id=? GROUP BY view_id ORDER BY view_id').all(id).map(row => [String(row.view_id), Number(row.n)] as const);
const recordsOf = (db: DatabaseSync, id: string) => db.prepare('SELECT view_id,state FROM memory_recall_view_records WHERE record_id=? ORDER BY view_id').all(id).map(row => [String(row.view_id), String(row.state)] as const);
const jobsOf = (db: DatabaseSync, id: string) => db.prepare('SELECT view_id FROM memory_recall_view_jobs WHERE job_id=? ORDER BY view_id').all(id).map(row => String(row.view_id));

/** One turn of one bot against a standing queue: eight queued jobs of another conversation are worked, and the bot's own conversation gets
 *  one job (worked to completion) and one new record. Returns what the writes journaled and what the upkeep then cost. */
function turn(count: number) {
  const w = world(count), { db } = w, mine = w.viewOf(0).viewId;
  let head = journalHead(db);
  for (let n = 0; n < 8; n++) workJob(db, `queued-${n}`);
  const queueJournal = journalHead(db) - head; head = journalHead(db);
  addJob(db, 'turn-job', w.own, 'thread-0'); workJob(db, 'turn-job');
  addRecord(db, 'turn-record', w.own);
  const turnJournal = journalHead(db) - head;
  const measured = meter(db);
  let slices = 0;
  try { slices = apply(db); } finally { measured.stop(); }
  expect(bound(db).filter(view => !current(db, view)).length, 'every view is current after the applier').toBe(0);
  const terms = termsOf(db, 'turn-record'), records = recordsOf(db, 'turn-record'), jobs = jobsOf(db, 'turn-job');
  // The same answer on every tree: the change reaches exactly the one view that reads its scope.
  expect(records).toEqual([[mine, 'active']]);
  expect(terms).toEqual([[mine, 12]]);
  expect(jobs).toEqual([mine]);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_recall_view_jobs WHERE job_id LIKE 'queued-%'").get()!.n)).toBe(0);
  const result = { views: count, queueJournal, turnJournal, slices, ...measured.cost };
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  return result;
}

it('W-F1-SCALE one turn costs the same upkeep on 4 views and on 48: statements, per-row writes and commits do not grow with the views', () => {
  const few = turn(4), many = turn(48);
  console.log('W-F1-SCALE', JSON.stringify({ few, many }));
  // Fix 1: a status-only job update (lease, heartbeat, settle) changes nothing a view stores, so it journals nothing. 8 queued jobs x 4
  // updates wrote 32 journal rows before; the turn's own job writes its insert only.
  expect(many.queueJournal, 'status updates of a standing queue write no journal row').toBe(0);
  expect(many.turnJournal, 'the turn journals its job insert and its record three times').toBe(4);
  // I3/I4 (G-TURN view slope): the same statements, the same ROWS and the same single write transaction whatever the number of views.
  // No view that cannot read the change costs a statement or a row; not even a watermark row (A3: the applied mark is in memory).
  console.log(`GATE-MEASURE G-TURN-slope statements ${few.statements} -> ${many.statements} rows ${few.rows} -> ${many.rows} commits ${few.commits} -> ${many.commits} (4 views -> 48 views; bound: equal)`);
  expect(many.statements, 'statements do not grow with the views').toBe(few.statements);
  expect(many.rows, 'row changes do not grow with the views').toBe(few.rows);
  expect([many.begins, many.commits], 'one page reaches every view in one transaction').toEqual([1, 1]);
  expect([few.begins, few.commits]).toEqual([1, 1]);
  expect(many.slices).toBe(few.slices);
  expect(many.watermarkWrites, 'no watermark row is written for a page').toBe(0);
  // Fix 3: the record is journaled three times and its terms are written once.
  expect(many.termInserts, 'terms written once').toBe(12);
  expect(many.termDeletes, 'no term removed to be written again').toBe(0);
}, 180_000);

it('W-F1-FORGET a forgotten record leaves every view that held it, with its words, in the first slice; a moved one leaves the views that lost it', () => {
  const w = world(12), { db } = w, all = db.prepare("SELECT view_id FROM memory_recall_views ORDER BY view_id").all().map(row => String(row.view_id));
  addRecord(db, 'shared-record', w.shared); addRecord(db, 'moved-record', w.own); addRecord(db, 'gone-record', w.shared);
  drain(db);
  expect(termsOf(db, 'shared-record')).toEqual(all.map(view => [view, 12]));
  expect(termsOf(db, 'moved-record')).toEqual([[w.viewOf(0).viewId, 12]]);
  // The owner forgets one, as memory-revocation writes it: state, pin and text in place, the same record version.
  db.prepare("UPDATE memory_records SET state='deleted',owner_pinned=0,text='' WHERE id='shared-record' AND version=1").run();
  // One record changes conversation, and one is removed outright (neither is a production write; both stay exact).
  db.prepare("UPDATE memory_records SET scope_id=? WHERE id='moved-record'").run(w.foreign);
  db.prepare("DELETE FROM memory_projection_receipts WHERE record_id='gone-record'").run();
  db.prepare("DELETE FROM memory_records WHERE id='gone-record'").run();
  // One slice asked for one view is enough for all three: at most 3 x 12 projections, inside one page.
  views.maintainRecallViewSlice(w.viewOf(7));
  const afterOne = { forgotten: termsOf(db, 'shared-record'), states: recordsOf(db, 'shared-record'), moved: [termsOf(db, 'moved-record'), recordsOf(db, 'moved-record')], gone: [termsOf(db, 'gone-record'), recordsOf(db, 'gone-record')] };
  drain(db);
  expect(termsOf(db, 'shared-record'), 'no view keeps a word of a forgotten record').toEqual([]);
  expect(recordsOf(db, 'shared-record')).toEqual(all.map(view => [view, 'deleted']));
  expect([termsOf(db, 'moved-record'), recordsOf(db, 'moved-record')], 'a view that lost the scope loses the record').toEqual([[], []]);
  expect([termsOf(db, 'gone-record'), recordsOf(db, 'gone-record')], 'a removed record leaves every view').toEqual([[], []]);
  expect(afterOne, 'and all of it in the first slice').toEqual({ forgotten: [], states: all.map(view => [view, 'deleted']), moved: [[], []], gone: [[], []] });
}, 180_000);

it('W-F1-JOBMOVE a job that changes source, or is removed, is still journaled and leaves the view; a status update is not journaled', () => {
  const w = world(6), { db } = w, mine = w.viewOf(0).viewId;
  addJob(db, 'moving', w.own, 'thread-0'); addJob(db, 'removed', w.own, 'thread-0'); addJob(db, 'arriving', w.foreign, 'elsewhere');
  drain(db);
  expect([jobsOf(db, 'moving'), jobsOf(db, 'removed'), jobsOf(db, 'arriving')]).toEqual([[mine], [mine], []]);
  let head = journalHead(db);
  workJob(db, 'moving');
  expect(journalHead(db) - head, 'four status updates, no journal row').toBe(0);
  // A status update right before each real change must not swallow that change's journal row.
  db.prepare("UPDATE memory_jobs SET attempts=attempts+1 WHERE id='moving'").run();
  db.prepare("UPDATE memory_jobs SET source_id='src-queued-0',stage='extract' WHERE id='moving'").run();
  db.prepare("UPDATE memory_jobs SET attempts=attempts+1 WHERE id='removed'").run();
  db.prepare("DELETE FROM memory_jobs WHERE id='removed'").run();
  db.prepare("UPDATE memory_jobs SET attempts=attempts+1 WHERE id='arriving'").run();
  db.prepare("UPDATE memory_jobs SET source_id='src-moving',stage='extract' WHERE id='arriving'").run();
  db.prepare("UPDATE memory_jobs SET attempts=attempts+1 WHERE id='arriving'").run();
  addJob(db, 'after-update', w.own, 'thread-0');
  expect(journalHead(db) - head, 'the move, the removal, the arrival and the insert are journaled').toBe(4);
  // A multi-row status update journals nothing either.
  head = journalHead(db);
  expect(Number(db.prepare("UPDATE memory_jobs SET retry_at=retry_at+1 WHERE status='pending'").run().changes)).toBeGreaterThan(30);
  expect(journalHead(db) - head).toBe(0);
  drain(db);
  expect([jobsOf(db, 'moving'), jobsOf(db, 'removed'), jobsOf(db, 'arriving'), jobsOf(db, 'after-update')]).toEqual([[], [], [mine], [mine]]);
  // A job written again under the same id is a new row: the view must name the row the job has now, not the one it held.
  const sequenceOf = (id: string) => db.prepare('SELECT sequence FROM memory_recall_view_jobs WHERE job_id=?').all(id).map(row => Number(row.sequence));
  const rowOf = (id: string) => Number(db.prepare('SELECT rowid AS n FROM memory_jobs WHERE id=?').get(id)!.n);
  const held = rowOf('after-update');
  expect(sequenceOf('after-update')).toEqual([held]);
  db.prepare("INSERT OR REPLACE INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch) VALUES('after-update','src-after-update',1,'capture','1','pending',0,0,0,0,0)").run();
  expect(rowOf('after-update'), 'the replacement is a new row').not.toBe(held);
  drain(db);
  expect(sequenceOf('after-update')).toEqual([rowOf('after-update')]);
  // An update the database itself skips (a uniqueness clash under OR IGNORE) fires no journal trigger. What it noted must not swallow the
  // journal row of the job's removal that follows.
  db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch) VALUES('twin','src-after-update',1,'extract','1','pending',0,0,0,0,0)").run();
  drain(db);
  expect(jobsOf(db, 'twin')).toEqual([mine]);
  expect(Number(db.prepare("UPDATE OR IGNORE memory_jobs SET stage='capture' WHERE id='twin'").run().changes), 'the clashing update is skipped').toBe(0);
  head = journalHead(db);
  db.prepare("DELETE FROM memory_jobs WHERE id='twin'").run();
  expect(journalHead(db) - head, 'the removal after a skipped update is journaled').toBe(1);
  drain(db);
  expect(jobsOf(db, 'twin')).toEqual([]);
}, 180_000);

it('W-A-FLEET the applier moves its views together: a view behind reads alone and then joins, a view with no reader is left alone, a page is bounded and skips no row', () => {
  const w = world(40), { db } = w, behind = w.viewOf(5), unbound = w.viewOf(9), ahead = w.viewOf(13);
  const watermark = (view: { viewId: string }) => Number(db.prepare('SELECT watermark FROM memory_recall_views WHERE view_id=?').get(view.viewId)!.watermark);
  const holds = (id: string, view: { viewId: string }) => termsOf(db, id).some(([held, n]) => held === view.viewId && n === 12);
  const members = () => views.recallAppliedMarkForTest(db).members;
  // bot-5's view misses a change the others read (its context is away while they do), so it is behind the applied mark.
  const context = db.prepare('SELECT context_key,view_id,generation FROM memory_recall_contexts WHERE view_id=?').get(behind.viewId)!;
  const start = watermark(behind);
  db.prepare('DELETE FROM memory_recall_contexts WHERE view_id=?').run(behind.viewId);
  addRecord(db, 'early', w.shared);
  apply(db);
  db.prepare('INSERT INTO memory_recall_contexts VALUES(?,?,?)').run(context.context_key, context.view_id, context.generation);
  expect([watermark(behind), holds('early', behind), members().includes(behind.viewId)]).toEqual([start, false, false]);
  // The fleet never carries a view past rows it has not read: the view reads them alone, exactly, and joins afterwards.
  addRecord(db, 'solo', w.shared);
  const fleetPage = meter(db);
  try { views.maintainRecallViewSlice(w.viewOf(0)); } finally { fleetPage.stop(); }
  expect([members().includes(behind.viewId), current(db, behind), holds('solo', behind)], 'a view behind the applied mark is not in the fleet, and the fleet\'s page does not touch it').toEqual([false, false, false]);
  expect(holds('solo', w.viewOf(1))).toBe(true);
  // The applier's own run serves it: one page alone a run, until it has read every row it missed.
  drain(db);
  expect([watermark(behind), holds('early', behind), holds('solo', behind)], 'its own pages read every row it missed').toEqual([journalHead(db), true, true]);
  addRecord(db, 'joined', w.shared);
  apply(db);
  expect([members().includes(behind.viewId), holds('joined', behind)], 'caught up, it is kept by the fleet').toEqual([true, true]);
  // bot-9's context is gone (no reader); bot-13's persisted watermark is past the journal head (it is never moved back).
  db.prepare('DELETE FROM memory_recall_contexts WHERE view_id=?').run(unbound.viewId);
  const frozen = watermark(unbound), head = journalHead(db);
  db.prepare('UPDATE memory_recall_views SET watermark=? WHERE view_id=?').run(head + 500, ahead.viewId);
  // 12 records x 3 journal rows x 39 readers is past one page's allowance: the page stops early, in one transaction, for all of them alike.
  for (let n = 0; n < 12; n++) addRecord(db, `late-${n}`, w.shared);
  const measured = meter(db);
  try { views.runRecallApplierForTest(); } finally { measured.stop(); }
  const mark = views.recallAppliedMarkForTest(db).applied!;
  expect(mark, 'the first page is cut by the projection allowance').toBeLessThan(journalHead(db));
  expect(mark).toBeGreaterThan(head);
  expect([measured.cost.begins, measured.cost.commits]).toEqual([1, 1]);
  expect(measured.cost.termInserts, 'one page writes a bounded number of terms').toBeLessThanOrEqual(12 * (views.RECALL_FLEET_PROJECTIONS + 39));
  // No member is past a row it has not applied: every late record journaled at or below the mark is in every member, whole.
  const fleet = members();
  expect(fleet.length).toBe(39);
  const firstRow = (id: string) => Number(db.prepare("SELECT min(sequence) AS n FROM memory_recall_changes WHERE kind='record' AND object_id=?").get(id)!.n);
  let applied = 0;
  for (let n = 0; n < 12; n++) if (firstRow(`late-${n}`) + 2 <= mark) { applied++; for (const viewId of fleet) expect(holds(`late-${n}`, { viewId }), `late-${n} is in ${viewId}`).toBe(true); }
  expect(applied).toBeGreaterThan(0);
  drain(db);
  expect([watermark(unbound), holds('late-0', unbound), holds('late-11', unbound)], 'a view with no context is not maintained').toEqual([frozen, false, false]);
  expect(watermark(ahead), 'a persisted watermark is never moved back').toBe(head + 500);
  for (let n = 0; n < 12; n++) { const holders = termsOf(db, `late-${n}`); expect(holders.length, `late-${n} reaches every maintained view`).toBe(39); expect(holders.every(([, terms]) => terms === 12)).toBe(true); }
}, 180_000);

/** The changes of A1-DEL: a forget in place, an edit in place (same version, new words), a move out, a move in, a delete, and a job that
 *  moves away and one that is removed. Returns what a view must show afterwards. */
function churn(w: World): void {
  const { db } = w;
  db.prepare("UPDATE memory_records SET state='deleted',owner_pinned=0,text='' WHERE id='shared-record' AND version=1").run();
  db.prepare("UPDATE memory_records SET text='amber thistle bellows' WHERE id='edited-record' AND version=1").run();
  db.prepare("UPDATE memory_records SET scope_id=? WHERE id='moved-record'").run(w.foreign);
  db.prepare("UPDATE memory_records SET scope_id=? WHERE id='arriving-record'").run(w.own);
  db.prepare("DELETE FROM memory_projection_receipts WHERE record_id='gone-record'").run();
  db.prepare("DELETE FROM memory_records WHERE id='gone-record'").run();
  db.prepare("UPDATE memory_jobs SET source_id='src-queued-0',stage='extract' WHERE id='moving-job'").run();
  db.prepare("DELETE FROM memory_jobs WHERE id='removed-job'").run();
}
function seedChurn(w: World): void {
  const { db } = w;
  addRecord(db, 'shared-record', w.shared); addRecord(db, 'edited-record', w.shared); addRecord(db, 'moved-record', w.own);
  addRecord(db, 'arriving-record', w.foreign); addRecord(db, 'gone-record', w.own);
  addJob(db, 'moving-job', w.own, 'thread-0'); addJob(db, 'removed-job', w.own, 'thread-0');
  drain(db);
}
function expectChurned(w: World): void {
  const { db } = w, mine = w.viewOf(0).viewId, all = db.prepare("SELECT view_id FROM memory_recall_views WHERE state='ready' ORDER BY view_id").all().map(row => String(row.view_id));
  expect(termsOf(db, 'shared-record'), 'no view keeps a word of a forgotten record').toEqual([]);
  expect(recordsOf(db, 'shared-record')).toEqual(all.map(view => [view, 'deleted']));
  expect(termsOf(db, 'edited-record'), 'an edit in place replaces the words in every view').toEqual(all.map(view => [view, 3]));
  expect([termsOf(db, 'moved-record'), recordsOf(db, 'moved-record')], 'the view that lost the scope loses the record').toEqual([[], []]);
  expect(recordsOf(db, 'arriving-record')).toEqual([[mine, 'active']]);
  expect([termsOf(db, 'gone-record'), recordsOf(db, 'gone-record')], 'a removed record leaves the view').toEqual([[], []]);
  expect([jobsOf(db, 'moving-job'), jobsOf(db, 'removed-job')]).toEqual([[], []]);
}

it('W-A1-DEL a forget, an edit, a move, a delete and a job move reach exactly the views that held or hold the object, by index, and every view equals a fresh build', () => {
  const run = (count: number) => {
    const w = world(count), { db } = w;
    seedChurn(w);
    const schema = persistedSchema(db);
    const mark = views.recallAppliedMarkForTest(db);
    expect(mark.members.length, 'every view is in the fleet').toBe(count);
    churn(w);
    expect(Number(db.prepare('SELECT count(*) AS n FROM temp.recall_old_scope').get()!.n), 'the writers noted where the moved and removed objects were').toBeGreaterThanOrEqual(4);
    const measured = meter(db);
    try { apply(db); } finally { measured.stop(); }
    expectChurned(w);
    expect(Number(db.prepare('SELECT count(*) AS n FROM temp.recall_old_scope').get()!.n), 'the notes are spent in the applying transaction').toBe(0);
    const cost = measured.cost;
    expectFreshEqual(w);
    expect(persistedSchema(db), 'notes, routing and the applier changed no persisted object (schema v13 text-exact)').toBe(schema);
    expect(Number(db.prepare("SELECT count(*) AS n FROM temp.sqlite_schema WHERE name LIKE 'recall_%'").get()!.n), 'they live in TEMP objects').toBeGreaterThan(10);
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    return { views: count, ...cost };
  };
  const few = run(6), many = run(40);
  console.log(`GATE-MEASURE A1-DEL widest view list ${few.widestList} -> ${many.widestList}; rows ${few.rows} -> ${many.rows}; commits ${many.commits} (6 views -> 40 views)`);
  // I4: no change asks every view. The moved, removed and job rows name only the one view that held them; the shared forget and edit
  // are written to their holders (every view: the N-1 residual), never as a list of views to be searched.
  expect(many.widestList, 'a change names only the views that held the object').toBeLessThanOrEqual(1);
  expect(few.widestList).toBeLessThanOrEqual(1);
  expect(many.commits).toBe(1);
}, 240_000);

it('W-A1-CRASH changes committed and never applied (the process died first) are applied exactly by the next process, which has no notes: every view equals a fresh build', () => {
  const w = world(12), { db } = w;
  seedChurn(w);
  churn(w);
  // The writer committed; the applier never ran. The process dies: no clean-stop flush (the applied mark was only in memory, so the
  // persisted watermarks are behind even the rows that WERE applied), its notes are gone, and the next one reads the same file.
  const persisted = Number(db.prepare("SELECT min(watermark) AS n FROM memory_recall_views WHERE state='ready'").get()!.n);
  if ('forgetRecallFleetForTest' in views) {
    expect(persisted, 'the persisted watermarks are behind the rows applied in memory').toBeLessThan(views.recallAppliedMarkForTest(db).applied!);
    views.forgetRecallFleetForTest(db);
  }
  closeDatabase();
  if ('forgetRecallFleetForTest' in views) expect(Number(database().prepare("SELECT min(watermark) AS n FROM memory_recall_views WHERE state='ready'").get()!.n), 'the death flushed nothing').toBe(persisted);
  const next = database();
  expect(Number(next.prepare('SELECT count(*) AS n FROM temp.recall_old_scope').get()!.n)).toBe(0);
  const mark = views.recallAppliedMarkForTest(next);
  expect(mark.exact, 'rows of the earlier process are not routed by notes').toBe(journalHead(next));
  const measured = meter(next);
  try { apply(next); } finally { measured.stop(); }
  expect(measured.cost.widestList, 'they ask every view once').toBeGreaterThanOrEqual(11);
  const again: World = { ...w, db: next };
  drain(next);
  expectChurned(again);
  expectFreshEqual(again);
}, 180_000);

it('W-A1-FOREIGN a removal journaled by a connection that writes no note (a worker, an older build) is applied by asking every view once; W-P1 a forget hides the record from a word search before the applier has run', async () => {
  const { DatabaseSync: Raw } = await import('node:sqlite');
  const { lexicalViewPage } = await import('./recall-view-index.ts');
  const w = world(8), { db } = w, mine = w.viewOf(0), other = w.viewOf(4);
  addRecord(db, 'foreign-gone', w.own); addRecord(db, 'forgotten', w.shared);
  drain(db);
  expect(recordsOf(db, 'foreign-gone')).toEqual([[mine.viewId, 'active']]);
  expect(lexicalViewPage(db, 'saffron', other, 10).hits.map(hit => hit.id)).toContain('forgotten');
  // P1: the forget is effective for recall in the forgetting commit; the applier has not run and no view row has changed yet.
  db.prepare("UPDATE memory_records SET state='deleted',owner_pinned=0,text='' WHERE id='forgotten' AND version=1").run();
  expect(termsOf(db, 'forgotten').length, 'the view rows are still the old snapshot').toBe(8);
  for (const view of [mine, other]) expect(lexicalViewPage(db, 'saffron', view, 10).hits.map(hit => hit.id), 'a forgotten record is not a hit, applier stopped').not.toContain('forgotten');
  const file = String((db.prepare('PRAGMA database_list').all().find(row => row.name === 'main') as { file: string }).file);
  const outside = new Raw(file);
  try {
    expect(Number(outside.prepare("SELECT count(*) AS n FROM temp.sqlite_schema WHERE name='recall_old_scope'").get()!.n)).toBe(0);
    outside.exec("PRAGMA busy_timeout=5000; DELETE FROM memory_projection_receipts WHERE record_id='foreign-gone'; DELETE FROM memory_records WHERE id='foreign-gone'");
  } finally { outside.close(); }
  expect(Number(db.prepare('SELECT count(*) AS n FROM temp.recall_old_scope').get()!.n), 'nothing was noted').toBe(0);
  const measured = meter(db);
  try { apply(db); } finally { measured.stop(); }
  expect(recordsOf(db, 'foreign-gone'), 'the removed record left the view').toEqual([]);
  expect(measured.cost.widestList, 'found by asking every view, once').toBe(8);
  // P1-W2: once the forget's own change has been applied, no view holds a word of it.
  expect(termsOf(db, 'forgotten')).toEqual([]);
  expectFreshEqual(w);
}, 180_000);

it('W-A3b a receipts range that has grown past one page is paged by the applier and by a view reading alone: never refused, no member skipped', async () => {
  const { coverReceiptChanges } = await import('./recall-view-schema.ts');
  const w = world(6), { db } = w, behind = w.viewOf(4);
  const flipped = Array.from({ length: 10 }, (_, n) => `rng-${n}00`);
  for (const id of flipped) {
    db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',0,1,NULL,NULL,1)").run(id, w.shared, TEXT);
    db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,1,'pending','pending',NULL)").run(id);
  }
  drain(db);
  const pendingOf = () => Number(db.prepare("SELECT count(*) AS n FROM memory_recall_view_pending WHERE record_id LIKE 'rng-_00'").get()!.n);
  expect(pendingOf(), 'every view holds the ten waiting receipts').toBe(60);
  // bot-4's view is away while the rest happens; it will read the same rows alone. Its watermark is written first, so it stands exactly
  // where the fleet stands when the range row arrives (a view that could rejoin the fleet at once).
  views.flushRecallWatermarks(db);
  const context = db.prepare('SELECT context_key,view_id,generation FROM memory_recall_contexts WHERE view_id=?').get(behind.viewId)!;
  db.prepare('DELETE FROM memory_recall_contexts WHERE view_id=?').run(behind.viewId);
  // One producer chunk flips the ten receipts: one change row that names their key range.
  const head = journalHead(db);
  coverReceiptChanges(db, flipped.map(id => [id, 1] as const), () => { for (const id of flipped) db.prepare("UPDATE memory_projection_receipts SET lexical_status='indexed' WHERE record_id=?").run(id); });
  expect(db.prepare('SELECT kind FROM memory_recall_changes WHERE sequence>?').all(head).map(row => String(row.kind)), 'the chunk is one range row').toEqual(['receipts']);
  // Before anyone reads that row, 300 new records are written whose keys sort inside the range: it now holds 310 raw entries.
  for (let n = 0; n < 300; n++) addRecord(db, `rng-5${String(n).padStart(3, '0')}`, w.own);
  // The first page reads one piece of the range. The view comes back NOW, in the middle of it: it must not ride on from the fleet's
  // cursor (it has not read the first piece); it reads the whole range alone.
  views.runRecallApplierForTest();
  expect(views.recallAppliedMarkForTest(db).applied, 'the mark stays before a range that is half read').toBe(head);
  db.prepare('INSERT INTO memory_recall_contexts VALUES(?,?,?)').run(context.context_key, context.view_id, context.generation);
  const slices = 1 + drain(db);
  expect(slices, 'the range took more than one page').toBeGreaterThan(2);
  expect(bound(db).every(view => current(db, view))).toBe(true);
  expect(pendingOf(), 'every member of the range was applied, in the fleet and in the view that came back in the middle of it').toBe(0);
  expectFreshEqual(w);
}, 240_000);

it('W-A3-LAZY the persisted watermark is a lower bound written lazily: none per page, all in one statement at a flush and at a clean stop, and a replay from it writes nothing', () => {
  const w = world(16), { db } = w;
  const marks = (handle: DatabaseSync) => handle.prepare("SELECT DISTINCT watermark FROM memory_recall_views WHERE state='ready' ORDER BY watermark").all().map(row => Number(row.watermark));
  views.flushRecallWatermarks(db);
  const flushed = journalHead(db);
  expect(marks(db)).toEqual([flushed]);
  addRecord(db, 'first', w.shared); addRecord(db, 'second', w.own);
  let measured = meter(db);
  try { apply(db); } finally { measured.stop(); }
  expect(measured.cost.watermarkWrites, 'a page writes no watermark').toBe(0);
  expect(marks(db), 'the persisted watermarks stay where the last flush left them').toEqual([flushed]);
  expect(bound(db).every(view => current(db, view)), 'and every view is current by the applied mark').toBe(true);
  expect(views.recallAppliedMarkForTest(db).applied).toBe(journalHead(db));
  // A view asked for by name has its own watermark written: one row.
  measured = meter(db);
  try { views.maintainRecallViewSlice(w.viewOf(3)); } finally { measured.stop(); }
  expect([measured.cost.watermarkWrites, measured.cost.begins]).toEqual([1, 0]);
  // The flush: one statement for all the others; a second flush writes nothing at all (I5).
  measured = meter(db);
  try { views.flushRecallWatermarks(db); } finally { measured.stop(); }
  expect([measured.cost.statements, measured.cost.watermarkWrites]).toEqual([1, 15]);
  expect(marks(db)).toEqual([journalHead(db)]);
  measured = meter(db);
  try { views.flushRecallWatermarks(db); } finally { measured.stop(); }
  expect([measured.cost.statements, measured.cost.rows]).toEqual([0, 0]);
  // A clean stop flushes: the next process finds every watermark at the head and applies nothing.
  addRecord(db, 'third', w.shared);
  apply(db);
  const head = journalHead(db);
  expect(marks(db)).toEqual([head - 3]);
  closeDatabase();
  let next = database();
  expect(marks(next), 'the clean stop wrote the applied mark').toEqual([head]);
  // An unclean stop: the rows were applied, the watermark was not written. The replay from the lower bound finds every row already
  // applied and writes no view row (A4: compare before write), and every view still equals a fresh build.
  next.prepare("UPDATE memory_recall_views SET watermark=? WHERE state='ready'").run(flushed);
  closeDatabase();
  next = database();
  expect(marks(next)).toEqual([flushed]);
  measured = meter(next);
  try { drain(next); } finally { measured.stop(); }
  expect([measured.cost.termInserts, measured.cost.termDeletes], 'a row applied before the stop is read, not written again').toEqual([0, 0]);
  expect(termsOf(next, 'third').length).toBe(16);
  expectFreshEqual({ ...w, db: next });
}, 180_000);

it('W-A2-FLOOR the journal is trimmed below the flushed mark and the floor follows in the same transaction: no view is lost, none below the floor is accepted, the authority epoch does not move', () => {
  const w = world(10), { db } = w, away = w.viewOf(7);
  const count = () => Number(db.prepare('SELECT count(*) AS n FROM memory_recall_changes').get()!.n);
  const first = () => Number(db.prepare('SELECT min(sequence) AS n FROM memory_recall_changes').get()!.n);
  const floor = () => Number(db.prepare('SELECT projection_floor AS n FROM memory_recall_epoch WHERE id=1').get()!.n);
  const epoch = () => Number(db.prepare('SELECT epoch AS n FROM memory_recall_epoch WHERE id=1').get()!.n);
  views.setRecallFlushRowsForTest(48);
  try {
    const before = { count: count(), epoch: epoch(), floor: floor() };
    expect(before.count).toBeGreaterThanOrEqual(40);
    for (let n = 0; n < 40; n++) addRecord(db, `kept-${n}`, n % 2 ? w.shared : w.own);
    const measured = meter(db);
    try { apply(db); } finally { measured.stop(); }
    const head = journalHead(db);
    console.log(`GATE-MEASURE G-BOUNDED journal rows ${before.count + 120} -> ${count()} at rest (flush every 48 rows in this witness; floor ${before.floor} -> ${floor()})`);
    expect(count(), 'the journal holds what was written since the last flush, not its history').toBeLessThanOrEqual(48 + views.RECALL_BUILD_SLICE);
    expect(count(), 'the newest row is never deleted').toBeGreaterThanOrEqual(1);
    expect(journalHead(db)).toBe(head);
    expect(floor(), 'the floor is the highest deleted sequence').toBe(first() - 1);
    expect(epoch(), 'trimming moves no authority epoch').toBe(before.epoch);
    // Every view is still valid (watermark >= floor), current, and equal to a fresh build.
    expect(Number(db.prepare("SELECT count(*) AS n FROM memory_recall_views WHERE state='ready' AND watermark<?").get(floor())!.n), 'no ready view fell below the floor').toBe(0);
    for (const view of bound(db)) { expect(() => views.assertRecallView(db, view)).not.toThrow(); expect(current(db, view)).toBe(true); }
    const schema = persistedSchema(db);
    // A view that is behind (its context is away while the others read) holds the trim back: it is never thrown away by it.
    const context = db.prepare('SELECT context_key,view_id,generation FROM memory_recall_contexts WHERE view_id=?').get(away.viewId)!;
    views.maintainRecallViewSlice(away);
    const stayed = Number(db.prepare('SELECT watermark AS n FROM memory_recall_views WHERE view_id=?').get(away.viewId)!.n);
    db.prepare('DELETE FROM memory_recall_contexts WHERE view_id=?').run(away.viewId);
    for (let n = 0; n < 40; n++) addRecord(db, `later-${n}`, w.shared);
    apply(db);
    expect(floor(), 'the floor never passes a ready view of the current epoch').toBeLessThanOrEqual(stayed);
    expect(first()).toBeLessThanOrEqual(stayed + 1);
    db.prepare('INSERT INTO memory_recall_contexts VALUES(?,?,?)').run(context.context_key, context.view_id, context.generation);
    expect(() => views.assertRecallView(db, away), 'the view behind is still valid').not.toThrow();
    drain(db);
    expect(termsOf(db, 'later-39').length).toBe(10);
    // Once it has caught up the trim goes on; a watermark below a deleted row is then refused (it can no longer be replayed).
    for (let n = 0; n < 40; n++) addRecord(db, `last-${n}`, w.own);
    apply(db);
    expect(first(), 'the journal was trimmed past the rows the view had been holding').toBeGreaterThan(stayed + 1);
    expect(floor()).toBe(first() - 1);
    expectFreshEqual(w);
    // The authority epoch moves and all views but one are re-stamped (what a reader does when it comes back). The one still waiting keeps
    // its place: the trim does not pass its watermark, so it can be re-stamped later instead of rebuilt.
    const w2 = { ...w }, waiting = w2.viewOf(6);
    views.flushRecallWatermarks(db);
    const held = Number(db.prepare('SELECT watermark AS n FROM memory_recall_views WHERE view_id=? AND generation=?').get(waiting.viewId, waiting.generation)!.n);
    db.exec('UPDATE memory_recall_epoch SET epoch=epoch+1 WHERE id=1');
    db.prepare('UPDATE memory_recall_views SET authority_epoch=(SELECT epoch FROM memory_recall_epoch WHERE id=1) WHERE NOT (view_id=? AND generation=?)').run(waiting.viewId, waiting.generation);
    for (let n = 0; n < 40; n++) addRecord(db, `restamp-${n}`, w.own);
    apply(db);
    expect(views.recallAppliedMarkForTest(db).members.length, 'the re-stamped views are the fleet').toBe(9);
    expect(floor(), 'the floor does not pass a view that waits to be re-stamped').toBeLessThanOrEqual(held);
    db.prepare('UPDATE memory_recall_views SET authority_epoch=(SELECT epoch FROM memory_recall_epoch WHERE id=1) WHERE view_id=? AND generation=?').run(waiting.viewId, waiting.generation);
    drain(db);
    expect(() => views.assertRecallView(db, waiting), 're-stamped later, it is valid and caught up, not rebuilt').not.toThrow();
    expect(termsOf(db, 'restamp-39')).toEqual([[w.viewOf(0).viewId, 12]]);
    const stale = w.viewOf(2);
    views.flushRecallWatermarks(db);
    db.prepare('UPDATE memory_recall_views SET watermark=? WHERE view_id=? AND generation=?').run(first() - 2, stale.viewId, stale.generation);
    expect(() => views.assertRecallView(db, stale), 'a view whose watermark is below deleted rows is refused').toThrow();
    expect(persistedSchema(db), 'flush, trim, floor and a rebuild changed no persisted object').toBe(schema);
  } finally { views.setRecallFlushRowsForTest(); }
}, 180_000);

it('W-A-LEASED (G-IDLE-LEASED) a job leased for a minute costs the views nothing: no journal row, no wake armed, no write transaction', async () => {
  const w = world(24), { db } = w;
  addJob(db, 'leased', w.own, 'thread-0');
  drain(db);
  await new Promise(resolve => setTimeout(resolve, 120));
  const head = journalHead(db);
  db.prepare("UPDATE memory_jobs SET status='leased',lease_owner='w',lease_generation=lease_generation+1,lease_until=1000 WHERE id='leased'").run();
  for (let beat = 1; beat <= 6; beat++) db.prepare('UPDATE memory_jobs SET lease_until=max(lease_until,?) WHERE id=?').run(1000 + beat * 10_000, 'leased');
  expect(journalHead(db) - head, 'a lease and six heartbeats write no journal row').toBe(0);
  expect(wake.armedDeadlinesForTest(), 'nothing woke the applier').toEqual([]);
  const measured = meter(db);
  try { if (views.runRecallApplierForTest) views.runRecallApplierForTest(); else apply(db); } finally { measured.stop(); }
  console.log(`GATE-MEASURE G-IDLE-LEASED journal rows ${journalHead(db) - head} statements ${measured.cost.statements} begins ${measured.cost.begins} rows ${measured.cost.rows} (bound: 0 rows, 0 begins, <= 10 statements)`);
  expect([measured.cost.begins, measured.cost.rows], 'even a forced run takes no lock and writes nothing').toEqual([0, 0]);
  expect(measured.cost.statements).toBeLessThanOrEqual(2);
}, 180_000);

it('W-A-IDLE (G-IDLE, the views\' share) with the upkeep running and nothing changing, no statement touches the journal or a view; a change wakes the applier and the reclaimer, and they go quiet again', async () => {
  const w = world(12), { db } = w;
  const events: string[] = [];
  const unsubscribe = views.subscribeRecallReclaim(event => { events.push(event.kind); });
  try {
    views.startRecallViewMaintenance();
    const settle = async () => { for (const until = Date.now() + 8000; Date.now() < until;) { const before = events.length; await new Promise(resolve => setTimeout(resolve, 400)); if (events.length === before && wake.armedDeadlinesForTest().length === 0) break; } };
    await settle();
    const idle = meter(db);
    try { await new Promise(resolve => setTimeout(resolve, 1500)); } finally { idle.stop(); }
    console.log(`GATE-MEASURE G-IDLE(recall share) ${idle.cost.recall} statements, ${idle.cost.begins} BEGIN IMMEDIATE, ${idle.cost.rows} rows in 1.5 s of upkeep ticks on 12 views (bound: 0; per idle minute: x40)`);
    expect([idle.cost.recall, idle.cost.begins, idle.cost.rows], 'an idle upkeep issues no statement on the journal or the views, takes no lock, writes no row').toEqual([0, 0, 0]);
    // A change: the applier applies it, and because it wrote view rows (the store grew) the reclaimer looks once more, then rests.
    addRecord(db, 'after-idle', w.shared);
    const active = meter(db);
    try { for (const until = Date.now() + 5000; Date.now() < until && termsOf(db, 'after-idle').length < 12;) await new Promise(resolve => setTimeout(resolve, 20)); await new Promise(resolve => setTimeout(resolve, 300)); } finally { active.stop(); }
    expect(termsOf(db, 'after-idle').length, 'the change reached every view').toBe(12);
    expect(/FROM memory_recall_views v ORDER BY view_id,generation/.test(active.reclaimSql), 'the reclaimer asked again after the applier wrote').toBe(true);
    await settle();
    const rest = meter(db);
    try { await new Promise(resolve => setTimeout(resolve, 500)); } finally { rest.stop(); }
    expect([rest.cost.recall, rest.reclaimSql], 'and both are quiet again').toEqual([0, '']);
    // A context goes away (no journal row, nothing for the applier to write): that write alone makes the reclaimer look again.
    const head = journalHead(db);
    const freed = meter(db);
    try { db.prepare('DELETE FROM memory_recall_contexts WHERE view_id=?').run(w.viewOf(5).viewId); await new Promise(resolve => setTimeout(resolve, 500)); } finally { freed.stop(); }
    expect(journalHead(db)).toBe(head);
    expect(/FROM memory_recall_views v ORDER BY view_id,generation/.test(freed.reclaimSql), 'the reclaimer asked again after a context row changed').toBe(true);
  } finally { unsubscribe(); views.stopRecallViewMaintenance(); }
}, 180_000);

it('W-A-BEHIND a view whose own page keeps failing never stands in front of another view that is behind; a view that becomes maintainable with no journal write is served by the wake alone', async () => {
  const w = world(8), { db } = w, LIMIT = 536870912;
  // The view the applier looks at first (lowest id) and one other fall behind: their contexts are away while the fleet reads on.
  const ordered = bound(db).slice().sort((a, b) => a.viewId < b.viewId ? -1 : 1), first = ordered[0]!, other = ordered[3]!;
  const firstOwn = String(db.prepare(`SELECT s.scope_id FROM memory_recall_view_scopes s WHERE s.view_id=? AND s.generation=? AND s.lineage_only=0
    AND (SELECT count(*) FROM memory_recall_view_scopes o WHERE o.scope_id=s.scope_id AND o.lineage_only=0)=1 ORDER BY s.scope_id LIMIT 1`).get(first.viewId, first.generation)!.scope_id);
  addRecord(db, 'to-forget', w.shared);
  drain(db);
  const contexts = [first, other].map(view => db.prepare('SELECT context_key,view_id,generation FROM memory_recall_contexts WHERE view_id=?').get(view.viewId)!);
  for (const view of [first, other]) db.prepare('DELETE FROM memory_recall_contexts WHERE view_id=?').run(view.viewId);
  addRecord(db, 'needs-room', firstOwn);
  db.prepare("UPDATE memory_records SET state='deleted',owner_pinned=0,text='' WHERE id='to-forget' AND version=1").run();
  apply(db);
  // The store is full: the first view cannot take its new record; the other one only has words to lose.
  const padding = LIMIT - 64 - Number(db.prepare('SELECT bytes FROM memory_recall_storage WHERE id=1').get()!.bytes);
  db.prepare('UPDATE memory_recall_storage SET bytes=bytes+? WHERE id=1').run(padding);
  for (const row of contexts) db.prepare('INSERT INTO memory_recall_contexts VALUES(?,?,?)').run(row.context_key, row.view_id, row.generation);
  for (let run = 0; run < 6; run++) views.runRecallApplierForTest();
  expect([current(db, first), current(db, other)], 'the failing view waits; the other one was caught up by the applier itself').toEqual([false, true]);
  expect(termsOf(db, 'to-forget'), 'and lost the forgotten words').toEqual([[first.viewId, 12]]);
  // With room again the first view is served when its own delay ends (1 s after its first failure).
  db.prepare('UPDATE memory_recall_storage SET bytes=bytes-? WHERE id=1').run(padding);
  await new Promise(resolve => setTimeout(resolve, 1200));
  drain(db);
  expect([termsOf(db, 'to-forget'), termsOf(db, 'needs-room')]).toEqual([[], [[first.viewId, 12]]]);
  // No journal write at all: a view that waited for its re-stamp (stale authority epoch, so not maintained) is stamped again while the
  // upkeep runs. That write itself wakes the applier, which serves the view; nobody asks for it by name.
  const away = ordered[5]!;
  db.prepare('UPDATE memory_recall_views SET authority_epoch=authority_epoch-1 WHERE view_id=? AND generation=?').run(away.viewId, away.generation);
  addRecord(db, 'missed', w.shared);
  apply(db);
  expect(termsOf(db, 'missed').length, 'the view that waits was not maintained').toBe(7);
  views.startRecallViewMaintenance();
  try {
    await new Promise(resolve => setTimeout(resolve, 200));
    const head = journalHead(db);
    db.prepare('UPDATE memory_recall_views SET authority_epoch=(SELECT epoch FROM memory_recall_epoch WHERE id=1) WHERE view_id=? AND generation=?').run(away.viewId, away.generation);
    expect(journalHead(db), 'the re-stamp writes no journal row').toBe(head);
    for (const until = Date.now() + 5000; Date.now() < until && termsOf(db, 'missed').length < 8;) await new Promise(resolve => setTimeout(resolve, 20));
    expect([current(db, away), termsOf(db, 'missed').some(([view]) => view === away.viewId)], 'the view was caught up with nobody asking for it').toEqual([true, true]);
  } finally { views.stopRecallViewMaintenance(); }
  expectFreshEqual(w);
}, 180_000);

it('W-A6-WAKE a journal write wakes the applier by itself (no upkeep walk, no call by a reader), and once it has applied nothing stays armed', async () => {
  const w = world(8), { db } = w;
  views.startRecallViewMaintenance();
  await new Promise(resolve => setTimeout(resolve, 150));
  addRecord(db, 'woken', w.shared);
  db.prepare("UPDATE memory_records SET scope_id=? WHERE id='woken'").run(w.own);
  const until = Date.now() + 5000;
  while (Date.now() < until && !(termsOf(db, 'woken').length === 1 && bound(db).every(view => current(db, view)))) await new Promise(resolve => setTimeout(resolve, 20));
  expect(termsOf(db, 'woken'), 'the change was applied without anyone asking').toEqual([[w.viewOf(0).viewId, 12]]);
  expect(views.recallAppliedMarkForTest(db).applied).toBe(journalHead(db));
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(wake.armedDeadlinesForTest(), 'no deadline is left armed at rest').toEqual([]);
  views.stopRecallViewMaintenance();
}, 180_000);

it('W-A-SHARED (G-TURN-SHARED) a change in a scope every view reads costs the same statements for 3 holders and for 48; only the rows follow the holders', () => {
  const run = (count: number) => {
    const w = world(count), { db } = w;
    addRecord(db, 'common', w.shared);
    addJob(db, 'own-job', w.own, 'thread-0');
    const measured = meter(db);
    try { apply(db); } finally { measured.stop(); }
    expect(termsOf(db, 'common').map(([, terms]) => terms), 'every holder has the record whole').toEqual(Array.from({ length: count }, () => 12));
    expect(recordsOf(db, 'common').length).toBe(count);
    // The same change again (its receipt is touched, nothing a view stores differs): read, not written.
    db.prepare("UPDATE memory_projection_receipts SET lexical_status='pending' WHERE record_id='common'").run();
    db.prepare("UPDATE memory_projection_receipts SET lexical_status='indexed' WHERE record_id='common'").run();
    const again = meter(db);
    try { apply(db); } finally { again.stop(); }
    expectFreshEqual(w);
    const result = { holders: count, ...measured.cost, againTermWrites: again.cost.termInserts + again.cost.termDeletes };
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    return result;
  };
  const few = run(3), many = run(48);
  console.log(`GATE-MEASURE G-TURN-SHARED statements ${few.statements} -> ${many.statements} rows ${few.rows} -> ${many.rows} (3 holders -> 48 holders; N-1 residual rows per holder ${(many.rows - few.rows) / 45})`);
  expect(many.statements, 'statements do not follow the holders').toBe(few.statements);
  expect([many.begins, many.commits]).toEqual([1, 1]);
  // rows: holders x (12 terms + 1 record + the pending row written and removed again) plus the storage counter rows of each, and a constant.
  const perHolder = (many.rows - few.rows) / 45;
  expect(Number.isInteger(perHolder), 'every holder costs the same rows').toBe(true);
  expect(many.termInserts).toBe(48 * 12);
  expect(many.rows, 'rows are bounded by holders x (terms + 1) with their storage charges').toBeLessThanOrEqual(48 * (12 + 1) * 2 + 48 * 4 + 20);
  expect([few.againTermWrites, many.againTermWrites], 'a row that changes nothing a view stores rewrites no term').toEqual([0, 0]);
}, 240_000);

it('W-A5 (MISSED 3) the dead versions of a much-revised note do not hide a live record from a word search; the historical search still finds them', async () => {
  const { lexicalViewPage, RecallWorkBudget } = await import('./recall-view-index.ts');
  const w = world(4), { db } = w, mine = w.viewOf(0);
  const WORD = 'saffron';
  addRecord(db, 'older-live', w.own);
  for (let version = 1; version <= 40; version++) {
    if (version > 1) db.prepare("UPDATE memory_records SET state='superseded' WHERE id='revised' AND version=?").run(version - 1);
    db.prepare("INSERT INTO memory_records VALUES('revised',?,?,'fact',?,'owner-statement','active',0,1,NULL,NULL,1)").run(version, w.own, `${TEXT} revision${version}`);
  }
  db.prepare("INSERT INTO memory_records VALUES('shelved',1,?,'fact',?,'owner-statement','archived',0,1,NULL,NULL,1)").run(w.own, TEXT);
  drain(db);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_recall_view_records WHERE view_id=? AND record_id IN ('revised','shelved')").get(mine.viewId)!.n), 'every version keeps its view row').toBe(41);
  const key = (hit: { id: string; version: number }) => `${hit.id}:${hit.version}`;
  // A search that only a live version can answer, with room for 8 candidates a word: the 39 dead versions are newer than 'older-live'.
  // This build stores no terms for dead versions (W-A5-WRITE). The read filter is for a profile an older build wrote, before the paced
  // pass has removed them: the stored dead terms of that profile are put back here, exactly as the older build wrote them.
  if (deadTerms(db) === 0) for (let version = 1; version < 40; version++) {
    const seq = Number(db.prepare("SELECT rowid AS seq FROM memory_records WHERE id='revised' AND version=?").get(version)!.seq);
    for (const term of `${TEXT} revision${version}`.split(' ')) db.prepare('INSERT INTO memory_recall_view_terms VALUES(?,?,?,?,?,?)').run(mine.viewId, mine.generation, term, seq, 'revised', version);
  }
  const live = lexicalViewPage(db, WORD, mine, 10, 0, new RecallWorkBudget(8), true).hits.map(key).sort();
  const all = lexicalViewPage(db, WORD, mine, 10, 0, new RecallWorkBudget(8)).hits.map(key);
  console.log(`GATE-MEASURE A5 live-only word search: ${live.length} hits (${live.join(',')}); unfiltered page of 8 holds ${all.filter(hit => hit.startsWith('revised:') && hit !== 'revised:40').length} dead versions`);
  expect(live, 'the live records are found, the dead versions skipped inside the statement').toEqual(['older-live:1', 'revised:40']);
  // The historical search still finds superseded and archived versions (from stored terms where an older build left them, else from
  // their text: 'shelved' has no term row on this build).
  const historical = lexicalViewPage(db, WORD, mine, 100, 0, new RecallWorkBudget(4096), false, true).hits.map(key);
  expect(historical).toContain('revised:7');
  expect(historical).toContain('shelved:1');
  // (the terms put back above are not what a fresh build writes: the paced pass removes them before the views are compared)
  if (views.recallDeadTermsStep) { let cursor: unknown = null; for (let run = 0; run < 64; run++) { const step = views.recallDeadTermsStep(db, cursor, Date.now()); cursor = step.cursor; if (step.done) break; } }
  expectFreshEqual(w);
}, 180_000);

it('W-F1-QUOTA a view the storage quota refuses stalls alone: a forget still reaches every other view in the same slice', () => {
  const w = world(8), { db } = w, full = w.viewOf(0), other = w.viewOf(3), LIMIT = 536870912;
  const watermark = (view: { viewId: string }) => Number(db.prepare('SELECT watermark FROM memory_recall_views WHERE view_id=?').get(view.viewId)!.watermark);
  addRecord(db, 'forgotten', w.shared);
  drain(db);
  expect(termsOf(db, 'forgotten').length).toBe(8);
  // The quota is used up (the counter says so; the triggers read nothing else). bot-0's view cannot take its new record.
  const padding = LIMIT - 64 - Number(db.prepare('SELECT bytes FROM memory_recall_storage WHERE id=1').get()!.bytes);
  db.prepare('UPDATE memory_recall_storage SET bytes=bytes+? WHERE id=1').run(padding);
  const stalled = watermark(full);
  // r3: a refused fleet view's persisted watermark is written at the page start (the applied mark it had fully read), in the page's own
  // transaction, so its rows and its watermark agree; it never passes a refused row.
  const pageStart = views.recallAppliedMarkForTest ? views.recallAppliedMarkForTest(db).applied ?? stalled : stalled;
  expect(pageStart, 'the lazy flush left the persisted mark behind the applied one, so the write at the refusal is seen').toBeGreaterThan(stalled);
  addRecord(db, 'no-room', w.own);
  db.prepare("UPDATE memory_records SET state='deleted',owner_pinned=0,text='' WHERE id='forgotten' AND version=1").run();
  expect(() => views.maintainRecallViewSlice(other), 'a refused rider does not fail the page').not.toThrow();
  expect(watermark(other)).toBe(journalHead(db));
  expect(termsOf(db, 'forgotten'), 'only the stalled view still holds the words, as before').toEqual([[full.viewId, 12]]);
  expect([watermark(full), termsOf(db, 'no-room')], 'the refused view keeps its mark and none of the refused rows').toEqual([pageStart, []]);
  // Asked for itself while the quota is still used up (the forget freed some; it is taken again), the view fails its own page, as it always did.
  const again = LIMIT - 64 - Number(db.prepare('SELECT bytes FROM memory_recall_storage WHERE id=1').get()!.bytes);
  expect(again).toBeGreaterThan(0);
  db.prepare('UPDATE memory_recall_storage SET bytes=bytes+? WHERE id=1').run(again);
  expect(() => views.maintainRecallViewSlice(full)).toThrow('MEMORY_RECALL_STORAGE_LIMIT');
  expect(watermark(full)).toBe(pageStart);
  db.prepare('UPDATE memory_recall_storage SET bytes=bytes-? WHERE id=1').run(padding + again);
  drain(db);
  expect([termsOf(db, 'forgotten'), termsOf(db, 'no-room')], 'with room again the stalled view catches up').toEqual([[], [[full.viewId, 12]]]);
}, 180_000);

// ---- memv2 lane A round 2: the wake bus (lane W), A5 write side, A6 remainder, the migration steps ----
const turns = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const bindingOf = (db: DatabaseSync, view: Handle) => {
  const [botId, threadId, humanPrincipal, notOwnerAudience] = JSON.parse(String(db.prepare('SELECT context_key FROM memory_recall_contexts WHERE view_id=? AND generation=?').get(view.viewId, view.generation)!.context_key));
  return { botId, threadId, humanPrincipal, notOwnerAudience };
};
const deadTerms = (db: DatabaseSync) => Number(db.prepare(`SELECT count(*) AS n FROM memory_recall_view_terms t JOIN memory_records r ON r.id=t.record_id AND r.version=t.version
  WHERE r.state NOT IN ('active','candidate') AND t.term<>char(0)||'window'`).get()!.n);

it('W-A5-WRITE (F20) a superseded or archived version keeps its view row and stores no terms; the historical search reads its words from the text; the paced pass removes terms stored by an older build', async () => {
  const { lexicalViewPage, RecallWorkBudget } = await import('./recall-view-index.ts');
  const w = world(4), { db } = w, mine = w.viewOf(0), WORD = 'saffron';
  for (let version = 1; version <= 12; version++) {
    if (version > 1) db.prepare("UPDATE memory_records SET state='superseded' WHERE id='revised' AND version=?").run(version - 1);
    db.prepare("INSERT INTO memory_records VALUES('revised',?,?,'fact',?,'owner-statement','active',0,1,NULL,NULL,1)").run(version, w.shared, `${TEXT} revision${version}`);
    if (version === 6) drain(db);
  }
  db.prepare("INSERT INTO memory_records VALUES('shelved',1,?,'fact',?,'owner-statement','archived',0,1,NULL,NULL,1)").run(w.own, TEXT);
  // What never had terms must not be found by the scan either: a PIP kind (never through search, never ranked) and a rolled checkpoint.
  db.prepare("INSERT INTO memory_records VALUES('trait',1,?,'self-trait',?,'owner-statement','superseded',0,1,NULL,NULL,1)").run(w.own, `${TEXT} traitword`);
  db.prepare("INSERT INTO memory_records VALUES('trait',2,?,'self-trait',?,'owner-statement','active',0,1,NULL,NULL,1)").run(w.own, `${TEXT} traitword`);
  drain(db);
  const live = Number(db.prepare("SELECT count(*) AS n FROM memory_recall_view_terms WHERE record_id='revised' AND version=12").get()!.n);
  console.log(`GATE-MEASURE A5-WRITE term rows of dead versions ${deadTerms(db)} (bound: 0); of the live version ${live} (4 views x 13 words)`);
  expect(deadTerms(db), 'no term row is stored for a superseded or archived version').toBe(0);
  expect(live, 'the live version has its words in every view').toBe(4 * 13);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_recall_view_records WHERE view_id=? AND record_id IN ('revised','shelved')").get(mine.viewId)!.n), 'every version keeps its view row').toBe(13);
  const key = (hit: { id: string; version: number }) => `${hit.id}:${hit.version}`;
  // Historical: the dead versions are found by their words although they carry no terms; a live-only search finds only the live one.
  const historical = lexicalViewPage(db, WORD, mine, 50, 0, new RecallWorkBudget(), false, true);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_recall_view_records WHERE view_id=? AND record_id='trait' AND state='superseded'").get(mine.viewId)!.n), 'the view does hold the dead PIP version').toBe(1);
  expect(historical.hits.map(key).sort(), 'the historical word search finds every version the view holds, and no PIP version').toEqual([...Array.from({ length: 12 }, (_, n) => `revised:${n + 1}`), 'shelved:1'].sort());
  expect(lexicalViewPage(db, 'traitword', mine, 50, 0, new RecallWorkBudget(), false, true).hits.map(key), 'a PIP record is never ranked by a word search, live or dead').toEqual([]);
  expect(historical.bounded).toBe(false);
  expect(lexicalViewPage(db, 'revision3', mine, 50, 0, new RecallWorkBudget(), false, true).hits.map(key), 'by a word only one dead version has').toEqual(['revised:3']);
  expect(lexicalViewPage(db, WORD, mine, 50, 0, new RecallWorkBudget(), true).hits.map(key)).toEqual(['revised:12']);
  // The scan is charged to the request: a budget it uses up says the answer is bounded, and never reads past it.
  const small = new RecallWorkBudget(8), cut = lexicalViewPage(db, WORD, mine, 50, 0, small, false, true);
  expect([cut.bounded, small.raw <= 8]).toEqual([true, true]);
  // An older build stored terms for dead versions (here: put back by hand in two views, one version with more rows than one batch).
  const rowOf = (version: number) => Number(db.prepare("SELECT rowid AS seq FROM memory_records WHERE id='revised' AND version=?").get(version)!.seq);
  const others = [w.viewOf(1), w.viewOf(2)];
  for (const view of others) {
    for (const version of [2, 3]) for (const term of TEXT.split(' ')) db.prepare('INSERT INTO memory_recall_view_terms VALUES(?,?,?,?,?,?)').run(view.viewId, view.generation, term, rowOf(version), 'revised', version);
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1500) INSERT INTO memory_recall_view_terms SELECT ?,?,'pad'||i,?,'revised',5 FROM n`).run(view.viewId, view.generation, rowOf(5));
  }
  const stored = deadTerms(db);
  expect(stored).toBe(2 * (2 * 12 + 1500));
  const schema = persistedSchema(db), epoch = Number(db.prepare('SELECT epoch FROM memory_recall_epoch WHERE id=1').get()!.epoch);
  let cursor: unknown = null, batches = 0, widest = 0;
  for (;;) {
    const before = deadTerms(db), measured = meter(db);
    let step: { cursor: unknown; done: boolean };
    try { step = views.recallDeadTermsStep(db, cursor, Date.now()); } finally { measured.stop(); }
    widest = Math.max(widest, before - deadTerms(db)); batches++;
    cursor = step.cursor;
    if (step.done || batches > 64) break;
  }
  console.log(`GATE-MEASURE M4 dead terms ${stored} -> ${deadTerms(db)} in ${batches} batches, widest batch ${widest} rows (bound: ${views.RECALL_DEAD_TERMS_ROWS})`);
  expect(deadTerms(db), 'the pass removed every stored dead term').toBe(0);
  expect(batches, 'in more than one bounded batch').toBeGreaterThan(1);
  // Idempotent: run again from the first cursor (a crash before any marker was stored) it deletes nothing more and ends done.
  const total = Number(db.prepare('SELECT count(*) AS n FROM memory_recall_view_terms').get()!.n);
  let replay: unknown = null; for (let run = 0; run < 64; run++) { const step = views.recallDeadTermsStep(db, replay, Date.now()); replay = step.cursor; if (step.done) break; }
  expect([Number(db.prepare('SELECT count(*) AS n FROM memory_recall_view_terms').get()!.n), JSON.stringify(replay)], 'a replay from the start changes nothing and ends at the same cursor').toEqual([total, JSON.stringify(cursor)]);
  expect(widest).toBeLessThanOrEqual(views.RECALL_DEAD_TERMS_ROWS);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_recall_view_terms WHERE record_id='revised' AND version=12").get()!.n), 'and no live term').toBe(live);
  expect([persistedSchema(db), Number(db.prepare('SELECT epoch FROM memory_recall_epoch WHERE id=1').get()!.epoch)], 'no persisted object and no authority stamp moved').toEqual([schema, epoch]);
  expectFreshEqual(w);
}, 240_000);

it('W-M3 the long journal of an existing profile is trimmed in bounded ranges with the floor in the same step: never past a view, never the newest row, never while a build is in flight', () => {
  const w = world(6), { db } = w;
  addRecord(db, 'kept', w.shared);
  drain(db);
  views.flushRecallWatermarks(db);
  // An older build left 10,000 applied rows behind (its ring keeps 1,000,000): every view has read them, one view is 3,000 rows short.
  db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000) INSERT INTO memory_recall_changes(kind,object_id,version) SELECT 'job','gone-'||i,0 FROM n`).run();
  const head = journalHead(db), short = w.viewOf(4);
  db.prepare("UPDATE memory_recall_views SET watermark=? WHERE state='ready'").run(head);
  db.prepare('UPDATE memory_recall_views SET watermark=? WHERE view_id=? AND generation=?').run(head - 3000, short.viewId, short.generation);
  closeDatabase();
  const again = database(), rows = () => Number(again.prepare('SELECT count(*) AS n FROM memory_recall_changes').get()!.n);
  const floor = () => Number(again.prepare('SELECT projection_floor FROM memory_recall_epoch WHERE id=1').get()!.projection_floor);
  const epoch = Number(again.prepare('SELECT epoch FROM memory_recall_epoch WHERE id=1').get()!.epoch), schema = persistedSchema(again), start = rows();
  // Held: a build in flight keeps its snapshot above the floor, so nothing is deleted and the step is not done.
  const release = views.holdRecallViewForTest(again, 'some-build', 'build');
  expect([views.recallJournalTrimStep(again, null, Date.now()).done, rows()], 'held by a build: nothing deleted, asked again').toEqual([false, start]);
  release();
  let cursor: unknown = null, batches = 0, widest = 0;
  for (;;) {
    const before = rows(), step = views.recallJournalTrimStep(again, cursor, Date.now());
    const deleted = before - rows(); widest = Math.max(widest, deleted); batches++;
    if (deleted) expect(floor(), 'the floor is the highest deleted sequence, in the same step').toBe(Number(again.prepare('SELECT min(sequence) AS n FROM memory_recall_changes').get()!.n) - 1);
    cursor = step.cursor;
    if (step.done || batches > 16) break;
  }
  console.log(`GATE-MEASURE M3 journal rows ${start} -> ${rows()} in ${batches} batches, widest ${widest} (bound: ${views.RECALL_FLUSH_ROWS} a batch); floor ${floor()}, short view at ${head - 3000}`);
  expect(widest).toBeLessThanOrEqual(views.RECALL_FLUSH_ROWS);
  expect(batches).toBeGreaterThan(1);
  expect(floor(), 'never past the view that is behind').toBe(head - 3000);
  expect(rows(), 'what that view has not read is kept').toBe(3000);
  expect(Number(again.prepare("SELECT count(*) AS n FROM memory_recall_views v JOIN memory_recall_epoch e ON e.id=1 WHERE v.state='ready' AND v.watermark<e.projection_floor").get()!.n), 'no ready view fell below the floor').toBe(0);
  expect([Number(again.prepare('SELECT epoch FROM memory_recall_epoch WHERE id=1').get()!.epoch), persistedSchema(again)], 'no authority stamp and no persisted object moved').toEqual([epoch, schema]);
  // A second run from the stored cursor does nothing more; with every view caught up the rest goes, but never the newest row.
  expect([views.recallJournalTrimStep(again, cursor, Date.now()).done, rows()]).toEqual([true, 3000]);
  drain(again);
  views.flushRecallWatermarks(again);
  for (let run = 0; run < 4 && !views.recallJournalTrimStep(again, cursor, Date.now()).done; run++) { /* bounded batches */ }
  expect(rows(), 'the newest row is always kept').toBe(1);
  expectFreshEqual({ ...w, db: again });
}, 240_000);

it('W-A1-CONFLICT a write with its own conflict clause still notes where the object was: the note is never refused, never left at an older sequence, and the owner\'s write never aborts on it', () => {
  const w = world(6), { db } = w, away = String(db.prepare(`SELECT s.scope_id FROM memory_recall_view_scopes s WHERE s.view_id=? AND s.lineage_only=0
    AND (SELECT count(*) FROM memory_recall_view_scopes o WHERE o.scope_id=s.scope_id AND o.lineage_only=0)=1 ORDER BY s.scope_id LIMIT 1`).get(w.viewOf(3).viewId)!.scope_id);
  addRecord(db, 'mover', w.own);
  addJob(db, 'job-mover', w.own, 'thread-0');
  drain(db);
  const note = (scope: string) => db.prepare("SELECT sequence FROM temp.recall_old_scope WHERE kind='record' AND object_id='mover' AND scope_id=?").get(scope)?.sequence;
  // The same old scope is noted three times before the applier runs (own -> away -> own -> away). A trigger statement's own conflict
  // clause is replaced by the firing statement's: under OR IGNORE a note written with OR REPLACE kept its older sequence (and was
  // spent before its write was applied); under OR ABORT it failed the owner's write.
  db.prepare("UPDATE OR IGNORE memory_records SET scope_id=? WHERE id='mover'").run(away);
  const first = Number(note(w.own));
  db.prepare("UPDATE OR IGNORE memory_records SET scope_id=? WHERE id='mover'").run(w.own);
  addRecord(db, 'filler', w.foreign);
  db.prepare("UPDATE OR IGNORE memory_records SET scope_id=? WHERE id='mover'").run(away);
  expect(Number(note(w.own)), 'the note carries the sequence of the latest write that left the scope, also under OR IGNORE').toBe(journalHead(db) - 1);
  expect(Number(note(w.own))).toBeGreaterThan(first);
  // A job moved between two sources and back, each update carrying OR ABORT: the second note of the same scope must not fail the write.
  db.prepare("INSERT INTO memory_sources VALUES('src-job-other',?,'thread-3','m-job-other',NULL,1,'h-job-other','text','owner','recorded',NULL,'active')").run(away);
  db.prepare("INSERT INTO memory_source_versions VALUES('src-job-other',1,'h-job-other','{}',1)").run();
  const jobNote = () => db.prepare("SELECT scope_id,sequence FROM temp.recall_old_scope WHERE kind='job' AND object_id='job-mover' ORDER BY scope_id").all().map(row => [String(row.scope_id), Number(row.sequence)]);
  db.prepare("UPDATE OR ABORT memory_jobs SET source_id='src-job-other' WHERE id='job-mover'").run();
  db.prepare("UPDATE OR ABORT memory_jobs SET source_id='src-job-mover' WHERE id='job-mover'").run();
  expect(() => db.prepare("UPDATE OR ABORT memory_jobs SET source_id='src-job-other' WHERE id='job-mover'").run(), 'the owner\'s write is not aborted by a note already there').not.toThrow();
  expect(jobNote().find(([scope]) => scope === w.own)?.[1], 'and the job\'s note is the latest one').toBe(journalHead(db) - 1);
  expect(() => db.prepare("INSERT OR REPLACE INTO memory_records VALUES('mover',1,?,'fact',?,'owner-statement','active',0,1,NULL,NULL,1)").run(w.shared, TEXT)).not.toThrow();
  // The applier's page ends between the first and the last move of the record (one row a page would do it; here: a run now, more later).
  drain(db);
  expect(termsOf(db, 'mover').length, 'the record is where its last write put it: every view of the shared scope, and no other row').toBe(6);
  expect(jobsOf(db, 'job-mover'), 'the job is in the one view that reads its new source\'s scope').toEqual([w.viewOf(3).viewId]);
  expectFreshEqual(w);
}, 180_000);

it('W-A6-TURN the applier runs at once when no turn is running; while a turn is live it waits for 64 pending rows or 50 ms, and a reader\'s release wakes the upkeep', async () => {
  const w = world(6), { db } = w, mine = w.viewOf(0);
  views.startRecallViewMaintenance();
  await new Promise(resolve => setTimeout(resolve, 150));
  const applied = () => views.recallAppliedMarkForTest(db).applied;
  // No turn: one commit, applied on the next turns of the event loop, nothing armed.
  addRecord(db, 'quiet', w.shared);
  await turns();
  expect([applied(), bus!.deadlineOf('journal')], 'no turn is running: applied at once, no deadline').toEqual([journalHead(db), undefined]);
  // A turn is live (a reader holds its view): a small change waits, with one deadline for 50 ms after the first wake.
  let live = true;
  const release = views.retainRecallView(mine, bindingOf(db, mine), () => live);
  const before = Date.now();
  addRecord(db, 'during-turn', w.shared);
  await turns();
  const due = bus!.deadlineOf('journal');
  expect(applied(), 'a few rows during a turn are not applied commit by commit').toBeLessThan(journalHead(db));
  expect(due !== undefined && due - before <= views.RECALL_APPLIER_MS + 30 && due >= before, 'one deadline, 50 ms after the first pending wake').toBe(true);
  addRecord(db, 'during-turn-2', w.shared);
  await turns();
  expect(bus!.deadlineOf('journal'), 'a later commit does not push the deadline out').toBe(due);
  for (const until = Date.now() + 3000; Date.now() < until && applied() !== journalHead(db);) await new Promise(resolve => setTimeout(resolve, 10));
  expect([applied(), termsOf(db, 'during-turn-2').length], 'both commits were applied by the deadline, in one run').toEqual([journalHead(db), 6]);
  // 64 rows pending: applied without waiting for the deadline.
  db.exec('BEGIN'); for (let n = 0; n < 22; n++) addRecord(db, `burst-${n}`, w.foreign); db.exec('COMMIT');
  await turns(12);
  expect([applied(), bus!.deadlineOf('journal')], '66 pending rows are applied at once even during a turn').toEqual([journalHead(db), undefined]);
  // The turn ends without any row written: the release itself wakes the upkeep (the reclaimer looks again), and then nothing is armed.
  const looked = meter(db);
  try { live = false; release(); await new Promise(resolve => setTimeout(resolve, 200)); } finally { looked.stop(); }
  expect(/FROM memory_recall_views v ORDER BY view_id,generation/.test(looked.reclaimSql), 'a release with no row written makes the reclaimer look').toBe(true);
  for (const until = Date.now() + 3000; Date.now() < until && wake.armedDeadlinesForTest().length;) await new Promise(resolve => setTimeout(resolve, 50));
  expect(wake.armedDeadlinesForTest()).toEqual([]);
  views.stopRecallViewMaintenance();
  expectFreshEqual(w);
}, 180_000);

it('W-A-TIMER the upkeep holds no timer at rest: no setInterval or setTimeout of its own, lane H\'s riders run when their figures move or a time is due, and without lane H\'s figures they keep one deadline', async () => {
  const source = (await import('node:fs')).readFileSync(new URL('./recall-view.ts', import.meta.url), 'utf8');
  const schemaSource = (await import('node:fs')).readFileSync(new URL('./recall-view-schema.ts', import.meta.url), 'utf8');
  expect([/\bsetInterval\(/.test(source), /\bset(Interval|Timeout)\(/.test(schemaSource)], 'no repeating timer in either file').toEqual([false, false]);
  // The one setTimeout left in recall-view.ts is lane A2's room wait in the context queue (scheduleContextQueue); none is lane A's.
  expect(source.match(/\bsetTimeout\(/g) ?? []).toHaveLength(source.includes('setTimeout(advance,RECALL_ROOM_WAIT_MS)') ? 1 : 0);
  const w = world(6), { db } = w;
  views.startRecallViewMaintenance();
  const rest = async () => { for (const until = Date.now() + 5000; Date.now() < until && wake.armedDeadlinesForTest().length;) await new Promise(resolve => setTimeout(resolve, 50)); };
  await new Promise(resolve => setTimeout(resolve, 200)); await rest();
  const timers = bus!.wakeStats(), calls = riders.calls;
  const idle = meter(db);
  try { await new Promise(resolve => setTimeout(resolve, 600)); } finally { idle.stop(); }
  console.log(`GATE-MEASURE G-TIMER upkeep at rest: deadlines ${bus!.wakeStats().deadlines}, timer armed ${bus!.wakeStats().timerArmed}, rider calls in 600 ms ${riders.calls - calls}, recall statements ${idle.cost.recall}, BEGIN IMMEDIATE ${idle.cost.begins} (bound: 0, false, 0, 0, 0; base: 12 timer fires and 24 rider calls)`);
  expect([timers.timerArmed, timers.deadlines, riders.calls - calls, idle.cost.recall, idle.cost.begins], 'at rest: no timer, no deadline, no rider call, no recall statement, no lock').toEqual([false, 0, 0, 0, 0]);
  // Lane H's figures move (a session check was written): the next look runs the riders once, and rests again.
  riders.figures = { ...riders.figures, checksWrites: 1 };
  db.prepare('UPDATE memory_recall_contexts SET view_id=view_id WHERE context_key=(SELECT min(context_key) FROM memory_recall_contexts)').run();
  await new Promise(resolve => setTimeout(resolve, 200)); await rest();
  expect(riders.calls - calls, 'the riders ran because a figure moved').toBe(1);
  // A time of theirs is due later: one deadline for exactly that time, the riders run then.
  const due = Date.now() + 400;
  riders.figures = { ...riders.figures, expiryDue: due };
  views.runRecallUpkeepForTest();
  expect([bus!.deadlineOf('recall-upkeep'), riders.calls - calls], 'one deadline, at the time lane H named; nothing run before it').toEqual([due, 1]);
  await new Promise(resolve => setTimeout(resolve, 600));
  expect(riders.calls - calls, 'run when it fell due').toBeGreaterThanOrEqual(2);
  riders.figures = { ...riders.figures, expiryDue: 0 };
  await new Promise(resolve => setTimeout(resolve, 200)); await rest();
  // CONTRACT-REQ A memv2-H (r2 amendment): while lane H's restart sweep is not done (recover.done false) every look runs one slice and
  // looks again, with no figure moving; once it is done the upkeep rests.
  let slices = 0;
  views.setRecallSessionRidersForTest(() => riders.figures, () => { riders.calls++; if (++slices >= 3) riders.figures = { ...riders.figures, recover: { done: true } }; });
  riders.figures = { ...riders.figures, recover: { done: false } };
  const sweep = riders.calls;
  views.runRecallUpkeepForTest();
  await new Promise(resolve => setTimeout(resolve, 400)); await rest();
  expect([riders.calls - sweep, wake.armedDeadlinesForTest()], 'one sweep slice a look until recover.done, then rest').toEqual([3, []]);
  views.setRecallSessionRidersForTest(() => riders.figures, () => { riders.calls++; });
  // Without lane H's figures (this branch before lane H is merged) the riders are asked on every look, as the tick did: one deadline stays armed.
  views.setRecallSessionRidersForTest(null, () => { riders.calls++; });
  const without = riders.calls;
  views.runRecallUpkeepForTest();
  await new Promise(resolve => setTimeout(resolve, 400));
  // (armed, or fired this instant and about to run and arm again)
  expect([riders.calls - without >= 3, bus!.deadlineOf('recall-upkeep') !== undefined || bus!.wakeStats().owed > 0], 'no figures: the riders keep the upkeep deadline armed').toEqual([true, true]);
  // Inside a writer's open transaction the upkeep does not run (a rollback would undo a reclaim step): it looks again later.
  views.setRecallSessionRidersForTest(() => riders.figures, () => { riders.calls++; });
  await new Promise(resolve => setTimeout(resolve, 200)); await rest();
  db.exec('BEGIN IMMEDIATE');
  const inside = meter(db), ridersBefore = riders.calls;
  try { views.runRecallUpkeepForTest(); } finally { inside.stop(); }
  expect([inside.cost.statements, riders.calls - ridersBefore, bus!.deadlineOf('recall-upkeep') !== undefined], 'nothing runs inside the open transaction; one deadline to look again').toEqual([0, 0, true]);
  db.exec('ROLLBACK');
  views.stopRecallViewMaintenance();
  expect(wake.armedDeadlinesForTest(), 'a stop disarms it').toEqual([]);
}, 180_000);

it('W-A6-QUOTA a view the full store refuses twice gets a reclaim look, then the largest idle view is retired (sized from a figure kept in memory); no other view is stopped', async () => {
  const w = world(8), { db } = w, LIMIT = 536870912;
  const ordered = bound(db).slice().sort((a, b) => a.viewId < b.viewId ? -1 : 1), first = ordered[0]!, big = ordered[4]!;
  const ownOf = (view: Handle) => String(db.prepare(`SELECT s.scope_id FROM memory_recall_view_scopes s WHERE s.view_id=? AND s.generation=? AND s.lineage_only=0
    AND (SELECT count(*) FROM memory_recall_view_scopes o WHERE o.scope_id=s.scope_id AND o.lineage_only=0)=1 ORDER BY s.scope_id LIMIT 1`).get(view.viewId, view.generation)!.scope_id);
  for (let n = 0; n < 30; n++) addRecord(db, `bulk-${n}`, ownOf(big), `${TEXT} bulk${n}`);
  drain(db);
  // The per-view byte figure is counted once and then answered from memory.
  const counted = views.recallViewBytesForTest(db, big), cached = meter(db);
  try { expect(views.recallViewBytesForTest(db, big)).toBe(counted); } finally { cached.stop(); }
  expect(cached.cost.statements, 'the second ask reads nothing').toBe(0);
  expect(counted).toBeGreaterThan(views.recallViewBytesForTest(db, first));
  const events: Array<{ kind: string; viewId?: string; source?: string }> = [];
  const unsubscribe = views.subscribeRecallReclaim(event => { events.push({ kind: event.kind, viewId: event.viewId, source: event.source }); });
  try {
    const padding = LIMIT - 64 - Number(db.prepare('SELECT bytes FROM memory_recall_storage WHERE id=1').get()!.bytes);
    db.prepare('UPDATE memory_recall_storage SET bytes=bytes+? WHERE id=1').run(padding);
    addRecord(db, 'no-room', ownOf(first));
    addRecord(db, 'elsewhere', w.foreign);
    const state = (view: Handle) => String(db.prepare('SELECT state FROM memory_recall_views WHERE view_id=? AND generation=?').get(view.viewId, view.generation)?.state);
    for (let run = 0; run < 4; run++) views.runRecallApplierForTest();
    expect([state(first), state(big), current(db, first)], 'refused once: the view waits alone, nothing is retired yet').toEqual(['ready', 'ready', false]);
    expect(ordered.filter(view => view !== first).every(view => current(db, view)), 'every other view read on').toBe(true);
    await new Promise(resolve => setTimeout(resolve, 1100));
    for (let run = 0; run < 3; run++) views.runRecallApplierForTest();
    const retired = events.filter(event => event.source === 'recall-applier-quota');
    console.log(`GATE-MEASURE A6-QUOTA retired ${retired.length} view (largest ${counted} bytes) after the second refusal; others current ${ordered.filter(view => view !== first && view !== big).every(view => current(db, view))}`);
    expect(retired.map(event => event.viewId), 'refused twice: exactly the largest idle view is retired').toEqual([big.viewId]);
    expect([state(big), Number(db.prepare('SELECT count(*) AS n FROM memory_recall_contexts WHERE view_id=?').get(big.viewId)!.n)], 'it reads building and has left its contexts, so the reclaimer frees it and a reader rebuilds it').toEqual(['building', 0]);
    expect(ordered.filter(view => view !== first && view !== big).every(view => state(view) === 'ready' && current(db, view)), 'no other view was stopped or retired').toBe(true);
    // The store stays full and the view is refused again and again: while the victim is still being freed, no second view is retired.
    for (let round = 0; round < 3; round++) { await new Promise(resolve => setTimeout(resolve, 700)); for (let run = 0; run < 3; run++) views.runRecallApplierForTest(); }
    expect(events.filter(event => event.source === 'recall-applier-quota').length, 'one victim at a time').toBe(1);
    expect(ordered.filter(view => view !== first && view !== big).every(view => state(view) === 'ready'), 'and every other view is still ready').toBe(true);
    // What the reclaimer then frees is room: the refused view is served at its next look.
    db.prepare('UPDATE memory_recall_storage SET bytes=bytes-? WHERE id=1').run(padding);
    await new Promise(resolve => setTimeout(resolve, 2100));
    for (let run = 0; run < 6 && !current(db, first); run++) views.runRecallApplierForTest();
    expect([current(db, first), termsOf(db, 'no-room')]).toEqual([true, [[first.viewId, 12]]]);
  } finally { unsubscribe(); }
}, 180_000);

it('W-A6-WHOLE (Astra High on cdb3e4725f) a set of holder writes the quota refuses in a later statement is undone as a whole: no view keeps a record row without its terms behind an old watermark', () => {
  const w = world(8), { db } = w, LIMIT = 536870912;
  const watermarks = () => db.prepare("SELECT view_id,watermark FROM memory_recall_views WHERE state='ready' ORDER BY view_id").all().map(row => [String(row.view_id), Number(row.watermark)]);
  addRecord(db, 'settled', w.shared);
  drain(db);
  views.flushRecallWatermarks(db);
  const before = watermarks(), head = journalHead(db);
  // Room for the eight record rows of the next change (512 bytes each) and not for one term: the set's first insert succeeds, its
  // term insert is refused.
  const free = 8 * 512 + 100;
  db.prepare('UPDATE memory_recall_storage SET bytes=? WHERE id=1').run(LIMIT - free);
  addRecord(db, 'half', w.shared);
  for (let run = 0; run < 4; run++) views.runRecallApplierForTest();
  console.log(`GATE-MEASURE A6-WHOLE view rows of the refused record ${recordsOf(db, 'half').length}, term rows ${termsOf(db, 'half').length}, pending rows ${Number(db.prepare("SELECT count(*) AS n FROM memory_recall_view_pending WHERE record_id='half'").get()!.n)} (bound: 0, 0, 0)`);
  expect([recordsOf(db, 'half'), termsOf(db, 'half')], 'no view holds any row of the refused change').toEqual([[], []]);
  views.flushRecallWatermarks(db);
  expect(watermarks().every(([, mark]) => Number(mark) <= head), 'and no watermark moved past it').toBe(true);
  expect(watermarks()).toEqual(before);
  expect(Number(db.prepare('SELECT bytes FROM memory_recall_storage WHERE id=1').get()!.bytes), 'the storage counter was given back with the rows').toBe(LIMIT - free);
  // With room again every view takes the whole change.
  db.prepare('UPDATE memory_recall_storage SET bytes=bytes-? WHERE id=1').run(64 * 1024 * 1024);
  drain(db);
  expect([recordsOf(db, 'half').length, termsOf(db, 'half').map(([, n]) => n)]).toEqual([8, Array(8).fill(12)]);
}, 180_000);

it('W-A3b-DOWNGRADE (A3b-W case 2) a crash inside a grown range leaves every persisted watermark before the range row, so f6ae52c670 opening the file meets the row and refuses it (no wrong row served), and this build pages it at its next open without a rebuild', async () => {
  const { coverReceiptChanges } = await import('./recall-view-schema.ts');
  const w = world(4), { db } = w;
  const flipped = Array.from({ length: 10 }, (_, n) => `rng-${n}00`);
  for (const id of flipped) {
    db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',0,1,NULL,NULL,1)").run(id, w.shared, TEXT);
    db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,1,'pending','pending',NULL)").run(id);
  }
  drain(db);
  views.flushRecallWatermarks(db);
  const head = journalHead(db);
  coverReceiptChanges(db, flipped.map(id => [id, 1] as const), () => { for (const id of flipped) db.prepare("UPDATE memory_projection_receipts SET lexical_status='indexed' WHERE record_id=?").run(id); });
  const range = db.prepare("SELECT sequence,object_id FROM memory_recall_changes WHERE sequence>? AND kind='receipts'").get(head)!;
  for (let n = 0; n < 300; n++) addRecord(db, `rng-5${String(n).padStart(3, '0')}`, w.own);
  // This build is inside the range (one piece read) when the process dies. Whatever was flushed, no watermark is past the row.
  views.runRecallApplierForTest();
  views.flushRecallWatermarks(db);
  const persisted = () => db.prepare("SELECT view_id,generation,watermark FROM memory_recall_views WHERE state='ready' ORDER BY view_id").all().map(row => ({ id: `${row.view_id}/${row.generation}`, mark: Number(row.watermark) }));
  expect(persisted().every(view => view.mark < Number(range.sequence)), 'every persisted watermark is before the half-read range row').toBe(true);
  const identities = persisted().map(view => view.id);
  views.forgetRecallFleetForTest(db);
  closeDatabase();
  // What f6ae52c670 does with this file: each view replays from its own watermark, reaches the range row, and its reader makes this
  // bounded read (the statement of recallChangeRangeMembers at that commit, vendored here) and refuses a range past 256 entries with
  // MEMORY_RECALL_UNAVAILABLE. The view reads unavailable: fail closed, nothing past the row is served.
  const old = database(), [lo, loVersion, hi, hiVersion] = JSON.parse(String(range.object_id)) as [string, number, string, number, number];
  const raw = old.prepare('SELECT record_id,record_version,rowid AS rid FROM memory_projection_receipts WHERE (record_id,record_version)>=(?,?) AND (record_id,record_version)<=(?,?) ORDER BY record_id,record_version LIMIT ?').all(lo, loVersion, hi, hiVersion, 257);
  expect(raw.length, 'the older reader finds the range grown past its 256 entries and refuses the row').toBe(257);
  expect(Number(old.prepare('SELECT count(*) AS n FROM memory_recall_views v JOIN memory_recall_epoch e ON e.id=1 WHERE v.watermark<e.projection_floor').get()!.n), 'and no view is below the floor: the older build does not rebuild either').toBe(0);
  // This build again: the range is paged from its start, every view ends equal to a fresh build, and none was rebuilt on the way.
  drain(old);
  views.flushRecallWatermarks(old);
  const after = old.prepare("SELECT view_id,generation,watermark FROM memory_recall_views WHERE state='ready' ORDER BY view_id").all().map(row => ({ id: `${row.view_id}/${row.generation}`, mark: Number(row.watermark) }));
  expect(after.map(view => view.id), 'the same views, repaired in place').toEqual(identities);
  expect(after.every(view => view.mark === journalHead(old))).toBe(true);
  expect(Number(old.prepare("SELECT count(*) AS n FROM memory_recall_view_pending WHERE record_id LIKE 'rng-_00'").get()!.n), 'every member of the range was applied').toBe(0);
  expectFreshEqual({ ...w, db: old });
}, 180_000);

it('W-A10-ROOM a bulk producer waits only for an applier that can serve it: room at once when it is stopped, settled by its commit, and given up on (never stalled) when it keeps failing', async () => {
  const w = world(4), { db } = w;
  // Stopped: nobody would make room, so there is room.
  views.setRecallProducerRoomForTest(2);
  try {
    addRecord(db, 'ahead-0', w.shared); addRecord(db, 'ahead-1', w.shared);
    expect(views.recallJournalRoom(db), 'no applier running: a producer is not held').toBe(true);
    views.startRecallViewMaintenance();
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(views.recallAppliedMarkForTest(db).applied).toBe(journalHead(db));
    // Running and behind by more than the room: the producer waits, and the applier's own commit settles it (no timer of the producer's).
    db.exec('BEGIN'); for (let n = 0; n < 4; n++) addRecord(db, `burst-${n}`, w.foreign); 
    const head = journalHead(db);
    expect(views.recallJournalRoom(db), 'the journal head is past the room').toBe(false);
    let settled = 0;
    const waiting = views.whenRecallJournalRoom(db).then(() => { settled = Date.now(); });
    db.exec('COMMIT');
    await waiting;
    expect([settled > 0, views.recallAppliedMarkForTest(db).applied], 'settled by the commit that applied the burst').toEqual([true, head]);
    // The applier fails on every page (its read of who is maintained throws). Producers wait while it retries, then are let go.
    const own = Object.getOwnPropertyDescriptor(db, 'prepare'), prepare = db.prepare.bind(db);
    (db as { prepare: (sql: string) => StatementSync }).prepare = (sql: string) => { if (sql.startsWith('SELECT v.view_id,v.generation,v.digest,v.watermark FROM memory_recall_views v JOIN')) throw new Error('injected applier fault'); return prepare(sql); };
    const warn = console.warn; console.warn = () => {};
    try {
      for (let n = 0; n < 4; n++) addRecord(db, `stuck-${n}`, w.foreign);
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(views.recallJournalRoom(db), 'failing for less than the give-up time: still held').toBe(false);
      const started = Date.now(); let released = 0;
      const stuck = views.whenRecallJournalRoom(db).then(() => { released = Date.now() - started; });
      await Promise.race([stuck, new Promise(resolve => setTimeout(resolve, 30_000))]);
      console.log(`GATE-MEASURE A10-ROOM producer released after ${released} ms of a failing applier (give-up at a retry delay of ${views.RECALL_PRODUCER_GIVE_UP_MS} ms; bound 30,000)`);
      expect(released > 0 && released < 30_000, 'the producer is released while the applier still fails').toBe(true);
      expect(views.recallJournalRoom(db), 'and is not held again while it does').toBe(true);
    } finally { console.warn = warn; delete (db as { prepare?: unknown }).prepare; if (own) Object.defineProperty(db, 'prepare', own); }
    // The fault gone, the applier catches up on its next retry and every view is whole.
    views.stopRecallViewMaintenance();
    drain(db);
    expectFreshEqual(w);
  } finally { views.setRecallProducerRoomForTest(); }
}, 180_000);

// ---- memv2 lane A round 3: Astra BLOCK on cdb3e4725f, every insert position and every crash step ----
/** A refusal at one chosen insert of the view tables, counted row by row (a set INSERT ... SELECT fires the trigger once a row). The
 *  counter lives in JavaScript, so a ROLLBACK TO does not reset it: position k is refused exactly once. 'quota' raises the storage
 *  quota's own error and keeps refusing the view it hit (the store stays full for it); 'die' raises an error no code handles, standing
 *  for the process dying inside the page's transaction (SQLite loses an uncommitted transaction either way). TEMP: gone with the
 *  connection. */
const VIEW_TABLES = ['records', 'terms', 'jobs', 'pending'] as const;
function refuser(db: DatabaseSync) {
  const state = { count: 0, at: 0, kind: 'quota' as 'quota' | 'die', hit: undefined as undefined | { view: string; table: string; earlier: number }, perView: new Map<string, number>() };
  (db as unknown as { function(name: string, fn: (...args: unknown[]) => number): void }).function('recall_refuse_for_test', (view, table) => {
    if (!state.at) return 0;
    state.count++;
    if (!state.hit && state.count === state.at) state.hit = { view: String(view), table: String(table), earlier: state.perView.get(String(view)) ?? 0 };
    state.perView.set(String(view), (state.perView.get(String(view)) ?? 0) + 1);
    if (!state.hit) return 0;
    return state.kind === 'die' ? 2 : state.hit.view === String(view) ? 1 : 0;
  });
  for (const table of VIEW_TABLES) db.exec(`CREATE TEMP TRIGGER recall_refuse_${table} BEFORE INSERT ON main.memory_recall_view_${table} BEGIN
    SELECT CASE recall_refuse_for_test(NEW.view_id,'${table}') WHEN 1 THEN RAISE(ABORT,'MEMORY_RECALL_STORAGE_LIMIT') WHEN 2 THEN RAISE(ABORT,'SIMULATED_PROCESS_DEATH') END; END`);
  return {
    arm(at: number, kind: 'quota' | 'die') { Object.assign(state, { count: 0, at, kind, hit: undefined, perView: new Map() }); },
    disarm() { const { hit, count } = state; state.at = 0; return { hit, count }; },
  };
}
/** One change set touching every kind of holder write: two new records in the scope every view reads, one in bot-0's own scope, a job
 *  there, an edit in place of a shared record (one term replaced in every view) a forget of the shared record the step before added, and a scope move. */
function step(w: World, i: number): void {
  const { db } = w;
  addRecord(db, `q${i}-shared`, w.shared); addRecord(db, `forget-${i}`, w.shared); addRecord(db, `q${i}-own`, w.own);
  addJob(db, `q${i}-job`, w.own, 'thread-0');
  db.prepare("UPDATE memory_records SET text=? WHERE id='edit-me' AND version=1").run(`amber thistle bellow${i}`);
  db.prepare("UPDATE memory_records SET state='deleted',owner_pinned=0,text='' WHERE id=? AND version=1").run(`forget-${i - 1}`);
  // A scope move with the step (A2-FLOOR: a concurrent scope move): the step before's own record leaves for a conversation no view reads.
  db.prepare('UPDATE memory_records SET scope_id=? WHERE id=?').run(w.foreign, `q${i - 1}-own`);
}
function seedSteps(w: World): void { addRecord(w.db, 'edit-me', w.shared); addRecord(w.db, 'forget-0', w.shared); drain(w.db); views.flushRecallWatermarks(w.db); }
function expectStep(w: World, i: number, label: string): void {
  const { db } = w, mine = w.viewOf(0).viewId, all = db.prepare("SELECT view_id FROM memory_recall_views WHERE state='ready' ORDER BY view_id").all().map(row => String(row.view_id));
  expect([recordsOf(db, `q${i}-shared`), termsOf(db, `q${i}-shared`)], `${label}: the new shared record in every view, whole`).toEqual([all.map(view => [view, 'active']), all.map(view => [view, 12])]);
  expect([termsOf(db, `q${i}-own`), jobsOf(db, `q${i}-job`)], `${label}: bot-0's record and job in its view alone`).toEqual([[[mine, 12]], [mine]]);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_recall_view_terms WHERE record_id='edit-me' AND term=?").get(`bellow${i}`)!.n), `${label}: the edit reached every view`).toBe(all.length);
  expect(termsOf(db, 'edit-me'), `${label}: and replaced the old word`).toEqual(all.map(view => [view, 3]));
  expect([termsOf(db, `forget-${i - 1}`), recordsOf(db, `forget-${i - 1}`)], `${label}: the forget left every view`).toEqual([[], all.map(view => [view, 'deleted'])]);
  expect([termsOf(db, `q${i - 1}-own`), recordsOf(db, `q${i - 1}-own`)], `${label}: the moved record left bot-0's view`).toEqual([[], []]);
}

it('W-A6-EVERY (Astra High on cdb3e4725f) the quota refusing a fleet page at ANY insert, the first one or one after earlier writes of the same view, in any view table, leaves the refused view with nothing of the page and its watermark at the page start, in the same transaction; every other view takes the page whole', () => {
  const w = world(3), { db } = w;
  seedSteps(w);
  const refuse = refuser(db), tables = new Set<string>();
  // No flush between steps: a view's persisted watermark stays behind the applied mark (A3, lazy), so the watermark written at the
  // refusal is seen (a refused view that kept its old persisted mark would read below the page start).
  let behindAtRefusal = 0;
  const watermark = (viewId: string) => Number(db.prepare('SELECT watermark FROM memory_recall_views WHERE view_id=?').get(viewId)!.watermark);
  let positions = 0, afterEarlier = 0, k = 1;
  for (; k <= 1000; k++) {
    const start = journalHead(db), before = new Map(bound(db).map(view => [view.viewId, content(db, view)]));
    const persistedBefore = new Map(bound(db).map(view => [view.viewId, watermark(view.viewId)]));
    step(w, k);
    refuse.arm(k, 'quota');
    views.applyRecallPageForTest(db);
    const { hit } = refuse.disarm();
    if (hit) {
      positions++; tables.add(hit.table); if (hit.earlier > 0) afterEarlier++; if (persistedBefore.get(hit.view)! < start) behindAtRefusal++;
      const label = `refused at insert ${k} (${hit.table}, after ${hit.earlier} rows of its own)`;
      expect(content(db, { viewId: hit.view, generation: bound(db).find(view => view.viewId === hit.view)!.generation }), `${label}: the refused view keeps nothing of the page`).toEqual(before.get(hit.view));
      expect(watermark(hit.view), `${label}: its persisted watermark is the page start`).toBe(start);
      expect(views.recallViewCurrent(db, bound(db).find(view => view.viewId === hit.view)!), `${label}: and it is not served as current`).toBe(false);
      const others = bound(db).filter(view => view.viewId !== hit.view);
      expect(others.every(view => views.recallViewCurrent(db, view)), `${label}: every other view is current`).toBe(true);
      expect(recordsOf(db, `q${k}-shared`).map(([view]) => view), `${label}: and holds the page`).toEqual(others.map(view => view.viewId).sort());
    }
    drain(db);
    expectStep(w, k, `step ${k}`);
    if (!hit) break;
  }
  console.log(`GATE-MEASURE A6-EVERY insert positions refused ${positions} (every one of the page; ${afterEarlier} after earlier rows of the same view), tables ${[...tables].sort().join(',')}, refused while persisted behind ${behindAtRefusal}`);
  expect(positions, 'every insert position of the page was refused once, then a page past the last went through').toBe(k - 1);
  expect(positions).toBeGreaterThanOrEqual(40);
  expect(afterEarlier, 'positions after the view already wrote rows of this page (the case Astra named)').toBeGreaterThan(0);
  expect(behindAtRefusal, 'refusals of a view whose persisted watermark was behind the page start').toBeGreaterThan(0);
  expect([...tables].sort()).toEqual(expect.arrayContaining(['jobs', 'records', 'terms']));
  expectFreshEqual(w);
}, 600_000);

it('W-A1-CRASH-EVERY the process dying at ANY insert of a fleet page (its transaction is lost), after the page commits and before the lazy flush, or after a flush and trim made inside the page: the persisted watermarks never pass what was committed, and the next process, with no notes, applies exactly what is left', () => {
  let w = world(3);
  seedSteps(w);
  const watermarks = (db: DatabaseSync) => db.prepare("SELECT view_id,watermark FROM memory_recall_views WHERE state='ready' ORDER BY view_id").all().map(row => [String(row.view_id), Number(row.watermark)]);
  let i = 0, inside = 0, committed = 0;
  try {
    for (const rows of [undefined, 1]) {
      views.setRecallFlushRowsForTest(rows);
      for (let k = 1; k <= 1000; k++) {
        const { db } = w;
        step(w, ++i);
        const persisted = watermarks(db), refuse = refuser(db);
        refuse.arm(k, 'die');
        let died = false;
        try { views.applyRecallPageForTest(db); } catch (error) { if (!String((error as Error).message).includes('SIMULATED_PROCESS_DEATH')) throw error; died = true; }
        const { hit } = refuse.disarm();
        const label = `flush every ${rows ?? 'default'} rows, death ${died ? `at insert ${k}` : 'after the page committed'}`;
        if (died) { inside++; expect(watermarks(db), `${label}: the lost transaction moved no watermark`).toEqual(persisted); }
        else committed++;
        expect(died, `${label}: the death happened inside the page exactly when an insert was hit`).toBe(!!hit);
        // The process dies: no clean-stop flush, the applied mark and the notes are gone; the next one opens the same file.
        views.forgetRecallFleetForTest(db);
        const left = watermarks(db);
        closeDatabase();
        const next = database();
        expect(watermarks(next), `${label}: the death flushed nothing`).toEqual(left);
        expect(Number(next.prepare('SELECT count(*) AS n FROM temp.recall_old_scope').get()!.n)).toBe(0);
        w = { ...w, db: next };
        drain(next); views.flushRecallWatermarks(next);
        expectStep(w, i, label);
        if (!hit) break;
      }
    }
  } finally { views.setRecallFlushRowsForTest(); }
  console.log(`GATE-MEASURE A1-CRASH-EVERY deaths inside the page ${inside}, after its commit ${committed} (2: lazy flush, flush and trim in the page)`);
  expect(committed).toBe(2);
  expect(inside).toBeGreaterThanOrEqual(80);
  expectFreshEqual(w);
}, 600_000);
