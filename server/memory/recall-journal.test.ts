// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Journal producer: the memory_projection_receipts triggers in recall-view-schema.ts (owner: recall-journal). Consumer: recall-view.ts
// projectRecord / maintainRecallViewSlice / publishRecallView, and the pending page (recall-view-index.ts), owner: recall-journal.
// The pending page is read from the receipts joined to view membership. The projection triggers are the ones 1.0.19 shipped, unchanged (a 1.0.19
// file is validated by its exact text): an uncovered lexical_status flip journals one row, a producer chunk under a cover journals one row for
// the chunk (recall-change-set.test.ts), and a key change journals the new and the old key.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import * as searchIndex from '../message-search-index.ts';
import { stopSearchIndex } from '../message-search-index.ts';
import * as walMaintenance from '../wal-maintenance.ts';
import { stopWalMaintenance } from '../wal-maintenance.ts';
import { ensureScope, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { RecallWorkBudget, VIEW_PENDING_PAGE_SQL, pendingViewPage } from './recall-view-index.ts';
import { recallSchemaObjects, ensureRecallViewSchema, coverReceiptChanges, RECALL_CHANGE_SET, RECALL_PENDING_LEGACY_SCHEMA } from './recall-view-schema.ts';
import { migrateMemorySchema } from './schema.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

const roster = (): MemoryRoster => ({ memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct', tasks: [{ threadId: 'task' }] }], groups: [] });
const record = (id: string, scope: string, text = 'zephyr') => database().prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES(?,1,?,'fact',?,'a','active',0,0)").run(id, scope, text);
const receipt = (id: string) => database().prepare("INSERT INTO memory_projection_receipts VALUES(?,1,0,'pending','pending',NULL)").run(id);
const journal = () => database().prepare('SELECT sequence,kind,object_id,version FROM memory_recall_changes ORDER BY sequence').all().map(row => `${row.kind}:${row.object_id}:${row.version}`);
const rows = () => Number(database().prepare('SELECT count(*) n FROM memory_recall_changes').get()!.n);
const setView = (state: 'building' | 'ready', watermark: number, id = 'v') => database().prepare("INSERT INTO memory_recall_views VALUES(?,'g',0,1,?,0,'',0,?)").run(id, state, watermark);
const fixture = () => { const scope = ensureScope('bot', 'reader'); record('a', scope); record('b', scope); receipt('a'); receipt('b'); return scope; };

const setStatus = (id: string, status: string) => database().prepare('UPDATE memory_projection_receipts SET lexical_status=? WHERE record_id=?').run(status, id);

// recallrest-1020 (port onto 1.0.19): these three pinned the lane's own projection trigger (no row for a flip, one row for a key change). The
// port keeps the trigger 1.0.19 shipped, so they pin that trigger's journal instead; the drain's volume is bounded by the producer cover.
it('an uncovered lexical status flip journals one row, in any direction; no other receipt column journals', () => {
  fixture();
  const before = rows();
  for (const status of ['pending-archive', 'indexed', 'pending', 'delete-pending', 'deleted']) setStatus('a', status);
  expect(rows()).toBe(before + 5);
  expect(journal().slice(-5)).toEqual(Array.from({ length: 5 }, () => 'record:a:1'));
  // a write that leaves the status as it was journals nothing
  setStatus('a', 'deleted');
  const db = database();
  db.prepare("UPDATE memory_projection_receipts SET embedding_status='indexed',error='x' WHERE record_id='a'").run();
  db.prepare("UPDATE memory_projection_receipts SET index_generation=index_generation WHERE record_id='b'").run();
  expect(rows()).toBe(before + 5);
});
it('a drain of many receipts under the producer cover writes one journal row per chunk, not one per receipt', () => {
  const scope = ensureScope('bot', 'reader'), db = database();
  const ids = Array.from({ length: 300 }, (_, n) => `r${String(n).padStart(3, '0')}`);
  for (const id of ids) { record(id, scope); receipt(id); }
  const before = rows();
  for (let at = 0; at < ids.length; at += RECALL_CHANGE_SET) {
    const chunk = ids.slice(at, at + RECALL_CHANGE_SET);
    coverReceiptChanges(db, chunk.map(id => [id, 1] as const), () => { db.prepare("UPDATE memory_projection_receipts SET lexical_status='indexed',embedding_status='indexed' FROM json_each(?) j WHERE record_id=j.value").run(JSON.stringify(chunk)); });
  }
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_projection_receipts WHERE lexical_status='indexed'").get()!.n)).toBe(300);
  expect(rows()).toBe(before + 2);
  expect(journal().slice(-2).map(row => row.split(':')[0])).toEqual(['receipts', 'receipts']);
});
it('a key change journals the new key and the old key; insert and delete of a receipt still journal once', () => {
  fixture(); const db = database(), scope = ensureScope('bot', 'reader'); record('c', scope);
  const moved = rows();
  db.prepare("UPDATE memory_projection_receipts SET record_id='c' WHERE record_id='b'").run();
  expect(rows()).toBe(moved + 2);
  expect(journal().slice(-2)).toEqual(['record:c:1', 'record:b:1']);
  db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES('c',2,?,'fact','z','a','active',0,0)").run(scope);
  const before = rows();
  db.prepare("UPDATE memory_projection_receipts SET record_version=2 WHERE record_id='c'").run();
  expect(rows()).toBe(before + 2);
  expect(journal().slice(-2)).toEqual(['record:c:2', 'record:c:1']);
  const n = rows(); receipt('b'); expect(rows()).toBe(n + 1);
  db.prepare("DELETE FROM memory_projection_receipts WHERE record_id='b'").run(); expect(rows()).toBe(n + 2);
});
it('the pending view table no longer exists and no index is added to the receipts for the pending read', () => {
  const names = [...recallSchemaObjects().keys()];
  for (const gone of ['memory_recall_view_pending', 'memory_recall_pending_record', 'memory_recall_view_pending_storage_i', 'memory_recall_pending_seq']) expect(names).not.toContain(gone);
  fixture();
  expect(database().prepare("SELECT name FROM sqlite_schema WHERE name LIKE '%view_pending%' OR (tbl_name='memory_projection_receipts' AND name LIKE 'memory_recall_%' AND type='index')").all()).toEqual([]);
});

// Pending page plan: a bounded indexed range read in receipt rowid order. No sort, no scan of the receipts table, no scan of the join.
it('each pending page statement is a keyed range read of the receipts\' existing pending index with no temp b-tree and no scan', () => {
  fixture(); const db = database();
  expect(VIEW_PENDING_PAGE_SQL).toHaveLength(3);
  for (const sql of VIEW_PENDING_PAGE_SQL) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('v', 'g', '', -1, 16).map(row => String(row.detail));
    expect(plan.join('\n'), sql).not.toMatch(/TEMP B-TREE/);
    expect(plan.filter(detail => /^SCAN/.test(detail)), plan.join('\n')).toEqual([]);
    expect(plan[0]).toMatch(/^SEARCH r USING (COVERING )?INDEX memory_projection_pending \(lexical_status=\?/);
    expect(plan.some(detail => /SEARCH v USING (PRIMARY KEY|INDEX|COVERING INDEX)/.test(detail)), plan.join('\n')).toBe(true);
  }
});
// Consumer equivalence. The legacy path (journal row per flip, memory_recall_view_pending maintained by the old projectRecord rules) exists only
// here. After every step of a scripted drain the new page must return the same refs as the legacy table (in key order, which the pending walk allows: it looks for any readable record).
const PIPS = "'concern'";
const LEGACY_TABLE = 'CREATE TABLE legacy_pending(view_id TEXT,generation TEXT,sequence INTEGER,record_id TEXT,version INTEGER,PRIMARY KEY(view_id,generation,sequence,record_id,version)) WITHOUT ROWID';
const LEGACY_JOURNAL = "CREATE TABLE legacy_changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT,record_id TEXT,version INTEGER); CREATE TRIGGER legacy_u AFTER UPDATE ON memory_projection_receipts BEGIN INSERT INTO legacy_changes(record_id,version) VALUES(NEW.record_id,NEW.record_version); END; CREATE TRIGGER legacy_i AFTER INSERT ON memory_projection_receipts BEGIN INSERT INTO legacy_changes(record_id,version) VALUES(NEW.record_id,NEW.record_version); END;";
type Step = { sql: string };
const SCRIPT: Step[] = [
  { sql: "UPDATE memory_projection_receipts SET lexical_status='pending-archive' WHERE record_id='b'" },
  { sql: "UPDATE memory_projection_receipts SET lexical_status='indexed',embedding_status='indexed' WHERE record_id='b'" },
  { sql: "UPDATE memory_projection_receipts SET lexical_status='pending' WHERE record_id='b'" },
  { sql: "UPDATE memory_projection_receipts SET lexical_status='indexed' WHERE record_id='a'" },
  { sql: "UPDATE memory_projection_receipts SET lexical_status='delete-pending' WHERE record_id='a'" },
  { sql: "UPDATE memory_projection_receipts SET lexical_status='pending' WHERE record_id='p'" },
  { sql: "UPDATE memory_projection_receipts SET lexical_status='delete-pending' WHERE record_id='p'" },
  { sql: "UPDATE memory_projection_receipts SET lexical_status='deleted' WHERE record_id='a'" },
  { sql: "UPDATE memory_projection_receipts SET lexical_status='pending' WHERE record_id IN ('a','b','c')" },
  { sql: "UPDATE memory_projection_receipts SET lexical_status='indexed'" },
  { sql: "UPDATE memory_projection_receipts SET lexical_status='pending-archive' WHERE record_id IN ('c','b')" },
];
it('the new pending page returns the legacy table\'s refs after every step of a scripted drain (as the same set; the page is in key order), pip kinds included', async () => {
  const views = await import('./recall-view.ts'), r = roster(); reconcileMemoryRoster(r);
  const db = database(), scope = ensureScope('bot', 'reader');
  for (const id of ['a', 'b', 'c']) record(id, scope);
  db.prepare(`INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES('p',1,?,${PIPS},'pip','a','active',0,0)`).run(scope);
  for (const id of ['c', 'a', 'b', 'p']) receipt(id); // receipt rowid order differs from record order
  await views.prepareRecallContext('reader', 'direct', r);
  const view = db.prepare("SELECT view_id,generation,digest FROM memory_recall_views WHERE state='ready'").get()!;
  const handle = { viewId: String(view.view_id), generation: String(view.generation), digest: String(view.digest) };
  db.exec(LEGACY_TABLE); db.exec(LEGACY_JOURNAL);
  const project = (id: string, version: number) => { // the legacy projectRecord tail, verbatim in effect
    db.prepare('DELETE FROM legacy_pending WHERE view_id=? AND generation=? AND record_id=? AND version=?').run(handle.viewId, handle.generation, id, version);
    const row = db.prepare('SELECT kind FROM memory_records WHERE id=? AND version=?').get(id, version);
    const member = db.prepare('SELECT 1 FROM memory_recall_view_records WHERE view_id=? AND generation=? AND record_id=? AND version=?').get(handle.viewId, handle.generation, id, version);
    if (!row || !member) return;
    const rc = db.prepare('SELECT rowid AS seq,lexical_status FROM memory_projection_receipts WHERE record_id=? AND record_version=?').get(id, version);
    if (rc && (String(row.kind) !== 'concern' || rc.lexical_status === 'delete-pending') && ['pending', 'pending-archive', 'delete-pending'].includes(String(rc.lexical_status)))
      db.prepare('INSERT INTO legacy_pending VALUES(?,?,?,?,?)').run(handle.viewId, handle.generation, rc.seq, id, version);
  };
  for (const id of ['a', 'b', 'c', 'p']) project(id, 1);
  let mark = Number(db.prepare('SELECT coalesce(max(sequence),0) m FROM legacy_changes').get()!.m);
  const legacyRefs = () => db.prepare('SELECT record_id AS id,version,sequence AS rowid FROM legacy_pending ORDER BY record_id,version').all().map(x => `${x.id}:${x.version}:${x.rowid}`);
  const pageRefs = (limit: number) => { const out: string[] = []; let after = ''; for (let turns = 0; ; turns++) { expect(turns, 'a cursor that does not advance').toBeLessThan(20); const page = pendingViewPage(db, handle, after, limit); for (const x of page) out.push(`${x.id}:${x.version}:${x.rowid}`); if (page.length < limit) return out; after = JSON.stringify([page[page.length - 1].id, page[page.length - 1].version]); } };
  const trace: string[][] = [];
  expect(pageRefs(2)).toEqual(legacyRefs());
  for (const step of SCRIPT) {
    db.prepare(step.sql).run();
    for (const x of db.prepare('SELECT record_id,version FROM legacy_changes WHERE sequence>? ORDER BY sequence').all(mark)) project(String(x.record_id), Number(x.version));
    mark = Number(db.prepare('SELECT max(sequence) m FROM legacy_changes').get()!.m);
    while (!views.maintainRecallViewSlice(handle)) { /* drain real journal */ }
    for (const limit of [1, 2, 100]) expect(pageRefs(limit), `${step.sql} limit ${limit}`).toEqual(legacyRefs());
    trace.push(legacyRefs());
  }
  expect(trace.some(refs => refs.length === 0)).toBe(true);
  expect(trace.some(refs => refs.length >= 3)).toBe(true);
  expect(trace.flat().some(ref => ref.startsWith('p:'))).toBe(true); // the pip kind appears only through delete-pending
  expect(trace[5]).not.toContainEqual(expect.stringMatching(/^p:/)); // pending pip kind: excluded
});
it('a record outside the view\'s scopes never appears in its pending page', async () => {
  const views = await import('./recall-view.ts'), r = roster(); reconcileMemoryRoster(r);
  const db = database(), mine = ensureScope('bot', 'reader'), other = ensureScope('bot', 'other');
  record('mine', mine); record('theirs', other); receipt('mine'); receipt('theirs');
  await views.prepareRecallContext('reader', 'direct', r);
  const view = db.prepare("SELECT view_id,generation,digest FROM memory_recall_views WHERE state='ready'").get()!;
  const handle = { viewId: String(view.view_id), generation: String(view.generation), digest: String(view.digest) };
  expect(pendingViewPage(db, handle, '', 10).map(x => x.id)).toEqual(['mine']);
});

// recallrest-1020: 1.0.19 shipped the pending table, so it has a migration. Only that table leaves; the views are not dropped (a rebuild of
// every view at the upgrade is not needed: nothing reads the table any more, so no stale page can be served).
it('a database that still has the 1.0.19 pending table has only that table retired: no stale page survives, the views stay, its storage charge is handed back, and the schema is whole', () => {
  const db = database(), scope = ensureScope('bot', 'reader'); record('a', scope); receipt('a');
  const bytes = () => Number(db.prepare('SELECT bytes FROM memory_recall_storage').get()!.bytes), before = bytes();
  db.exec(RECALL_PENDING_LEGACY_SCHEMA);
  db.exec("INSERT INTO memory_recall_view_pending VALUES('v','old',1,'a',1)");
  expect(bytes()).toBe(before + 512);
  setView('ready', 0, 'v');
  db.exec('DROP TRIGGER memory_recall_projection_u');
  ensureRecallViewSchema(db);
  expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_recall_view_pending'").get()).toBeUndefined();
  expect(db.prepare('SELECT count(*) n FROM memory_recall_views').get()!.n).toBe(1);
  expect(bytes()).toBe(before);
  // the six memory_recall_external_* triggers sit on application tables (recallExternalObjects) and stay as well
  const rows = db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'memory_recall_%' AND name NOT LIKE 'memory_recall_external_%'").all().map(x => String(x.name)).sort();
  expect(rows).toEqual([...recallSchemaObjects().keys()].sort());
});

// Entry path. A normal start validates the file before ensureRecallViewSchema runs. The exact 1.0.19 pending table is accepted and retired
// (upgrade-from-1019.test.ts); a pending table with any other text is not that table, and the start refuses the file untouched (fail closed).
it.each(['initial WAL', 'final search'] as const)('a normal start refuses a file whose pending table is not the exact 1.0.19 one, and leaves that file exactly as it was (no migration, no stale page served), joining %s shutdown', async phase => {
  let opens = 0;
  let signal!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { signal = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const realWalStop = stopWalMaintenance, realSearchStop = stopSearchIndex;
  const inspect = (file: string) => { opens++; return new DatabaseSync(file); };
  const workflow = (async () => {
    const db = database(), scope = ensureScope('bot', 'reader'); record('a', scope); receipt('a'); setView('ready', 0, 'v');
    // not the 1.0.19 table: that one came with its record index and its two storage triggers
    db.exec(`CREATE TABLE memory_recall_view_pending(view_id TEXT NOT NULL,generation TEXT NOT NULL,sequence INTEGER NOT NULL,record_id TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(view_id,generation,sequence,record_id,version)) WITHOUT ROWID;
      INSERT INTO memory_recall_view_pending VALUES('v','old',1,'a',1);`);
    closeDatabase();
    // Hold the acknowledgement after real exits, so bypassing the join exposes an actual raw open.
    if (phase === 'initial WAL') vi.spyOn(walMaintenance, 'stopWalMaintenance').mockImplementationOnce(async () => {
      const exited = await realWalStop(); expect(await realSearchStop()).toBe(true);
      signal(); await gate; return exited;
    });
    expect(await stopWalMaintenance()).toBe(true); expect(await stopSearchIndex()).toBe(true);
    const file = join(DATA_DIR, 'messages.db');
    const state = (raw: DatabaseSync) => JSON.stringify([
      raw.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name LIKE 'memory_recall_%' OR tbl_name LIKE 'memory_recall_%' ORDER BY name").all(),
      raw.prepare('SELECT * FROM memory_recall_view_pending').all(), raw.prepare('SELECT * FROM memory_recall_views').all()]);
    let raw = inspect(file); const before = state(raw);
    try { expect(() => migrateMemorySchema(raw)).toThrow('MEMORY_SCHEMA_UNSUPPORTED'); expect(state(raw)).toBe(before); } finally { raw.close(); }
    try { expect(() => database()).toThrow(/MEMORY_SCHEMA_UNSUPPORTED/); }
    finally {
      closeDatabase(); expect(await stopWalMaintenance()).toBe(true);
      if (phase === 'final search') vi.spyOn(searchIndex, 'stopSearchIndex').mockImplementationOnce(async () => {
        const exited = await realSearchStop(); signal(); await gate; return exited;
      });
      expect(await stopSearchIndex()).toBe(true);
    }
    raw = inspect(file);
    try {
      expect(state(raw)).toBe(before);
      expect(raw.prepare('SELECT count(*) n FROM memory_recall_view_pending').get()!.n).toBe(1);
      expect(raw.prepare('SELECT count(*) n FROM memory_recall_views').get()!.n).toBe(1);
    } finally { raw.close(); }
  })();
  const result = workflow.catch(() => {});
  try {
    await Promise.race([entered, workflow.then(() => entered)]);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(opens, 'raw inspection must wait for the pending shutdown acknowledgement').toBe(phase === 'initial WAL' ? 0 : 1);
  } finally { release(); await result; vi.restoreAllMocks(); }
  await workflow;
});

const readyView = async (r: MemoryRoster) => {
  const views = await import('./recall-view.ts'); reconcileMemoryRoster(r); await views.prepareRecallContext('reader', 'direct', r);
  const view = database().prepare("SELECT view_id,generation,digest FROM memory_recall_views WHERE state='ready'").get()!;
  return { viewId: String(view.view_id), generation: String(view.generation), digest: String(view.digest) };
};
// H1: LIMIT is applied to raw receipts, and every raw receipt read is charged, so pending receipts of other views cost the request its allowance.
it('pending receipts of unrelated views are charged to the budget and cannot make the page read unbounded history', async () => {
  const r = roster(), db = database(), mine = ensureScope('bot', 'reader'), other = ensureScope('bot', 'other');
  for (let n = 0; n < 200; n++) { record(`a${String(n).padStart(3, '0')}`, other); receipt(`a${String(n).padStart(3, '0')}`); }
  record('z', mine); receipt('z');
  const handle = await readyView(r);
  const small = new RecallWorkBudget(32);
  expect(pendingViewPage(db, handle, '', 16, small)).toEqual([]);
  expect(small.raw, 'raw receipts read are charged').toBe(32);
  expect(small.remaining).toBe(0);
  const large = new RecallWorkBudget(2000);
  expect(pendingViewPage(db, handle, '', 16, large).map(x => x.id)).toEqual(['z']);
  expect(large.raw).toBeGreaterThanOrEqual(201);
  expect(large.raw).toBeLessThanOrEqual(201 + 3 * 16);
});
// H2 (MAIN 2026-11-17T00:55Z condition): keyset-resumable drain, no starvation, rows appearing below and above an active cursor.
it('a drain in key order that gains pending rows below and above its cursor drains every one within two passes', async () => {
  const r = roster(), db = database(), scope = ensureScope('bot', 'reader');
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) { record(id, scope); receipt(id); setStatus(id, 'indexed'); }
  const handle = await readyView(r);
  for (const id of ['c', 'd']) setStatus(id, 'pending');
  const drained: string[] = []; let passes = 0, injected = false;
  for (; passes < 6; passes++) {
    let after = '', any = false;
    for (let turns = 0; turns < 20; turns++) {
      const page = pendingViewPage(db, handle, after, 1); if (!page.length) break;
      any = true; const ref = page[0]; drained.push(ref.id); setStatus(ref.id, 'indexed');
      if (!injected) { injected = true; setStatus('a', 'pending'); setStatus('f', 'delete-pending'); } // below and above the active cursor (c)
      after = JSON.stringify([ref.id, ref.version]);
    }
    if (!any) break;
  }
  expect(drained.sort()).toEqual(['a', 'c', 'd', 'f']);
  expect(passes, 'productive passes before the empty confirming pass: every inserted row drains within two').toBeLessThanOrEqual(2);
  expect(db.prepare("SELECT count(*) n FROM memory_projection_receipts WHERE lexical_status<>'indexed'").get()!.n).toBe(0);
});
