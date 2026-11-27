// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-prod-x3 (worker-controller receipt chunks); consumer owner: recall-scope (recall-view change pages).
// 1.0.19 R12 Fix 3 (MAIN 2026-11-17T00:49Z): a producer chunk of receipt flips is one 'receipts' change row naming its receipt range, and the
// view still re-checks every member. Every other flip logs one row each, and a cover that is not the newest change row hides nothing (fail closed).
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { maintainRecallViewSlice, prepareRecallContext, RECALL_BUILD_SLICE, stopRecallViewMaintenance } from './recall-view.ts';
import { advanceRevocationJob, type RevocationJob } from './memory-revocation.ts';
import { coverReceiptChanges, recallChangeRangePage, RECALL_CHANGE_SET } from './recall-view-schema.ts';
import { pendingViewPage } from './recall-view-index.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { stopRecallViewMaintenance(); closeDatabase(); });

const mark = () => Number(database().prepare('SELECT coalesce(max(sequence),0) AS n FROM memory_recall_changes').get()!.n);
const ceiling = () => Number(database().prepare('SELECT max(rowid) AS n FROM memory_projection_receipts').get()!.n);
const since = (at: number) => database().prepare('SELECT kind,object_id,version FROM memory_recall_changes WHERE sequence>? ORDER BY sequence').all(at) as Array<{ kind: string; object_id: string; version: number }>;
const flip = (ids: string[]) => database().prepare("UPDATE memory_projection_receipts SET lexical_status='indexed' FROM json_each(?) j WHERE record_id=j.value AND record_version=1").run(JSON.stringify(ids));
const produce = (ids: string[]) => { for (let at = 0; at < ids.length; at += RECALL_CHANGE_SET) { const chunk = ids.slice(at, at + RECALL_CHANGE_SET); coverReceiptChanges(database(), chunk.map(id => [id, 1] as const), () => { flip(chunk); }); } };

async function fixture(records: number) {
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct' }], groups: [] };
  reconcileMemoryRoster(roster);
  const db = database(), scope = ensureScope('bot', 'reader'), ids = Array.from({ length: records }, (_, i) => `fixture-${String(i).padStart(4, '0')}`);
  const record = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact','Fixture harbour note','owner-statement','active',0,1,NULL,NULL,1)");
  const receipt = db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,0,'pending','pending',NULL)");
  for (const id of ids) { record.run(id, scope); receipt.run(id); }
  await prepareRecallContext('reader', 'direct', roster); stopRecallViewMaintenance();
  const registry = new InternalCapabilities(); registry.begin('reader', 'direct', 'generation');
  const token = registry.mint({ botId: 'reader', threadId: 'direct', generation: 'generation', depth: 0, kind: 'memory', skillAuthoring: false });
  const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  for (let n = 0; n < 1000 && !maintainRecallViewSlice(access.view); n++);
  // recallrest-1020 (port onto 1.0.19): the per-view pending table is retired; the pending page is what a reader is served (recall-view-index.ts).
  // It reads the receipts themselves, so a flip shows at once, not at the view's next re-check.
  const pending = () => [...new Set(pendingViewPage(db, access.view, '', 4096).map(row => row.id))];
  const watermark = () => Number(db.prepare('SELECT watermark FROM memory_recall_views WHERE view_id=? AND generation=?').get(access.view.viewId, access.view.generation)!.watermark);
  return { access, ids, pending, watermark };
}

/** How many times the view re-checks each record version while `work` runs: projectRecord's keyed read, counted on this connection. */
function rechecks(work: () => void): Record<string, number> {
  const db = database(), previous = db.prepare, seen: Record<string, number> = {};
  (db as any).prepare = (sql: string) => {
    const statement = previous.call(db, sql);
    if (!sql.startsWith('SELECT rowid AS seq,scope_id,text,kind,owner_pinned,state FROM memory_records WHERE id=? AND version=?')) return statement;
    return new Proxy(statement, { get(target, key) {
      const value = (target as any)[key];
      if (key !== 'get') return typeof value === 'function' ? value.bind(target) : value;
      return (...args: unknown[]) => { seen[String(args[0])] = (seen[String(args[0])] ?? 0) + 1; return value.apply(target, args); };
    } });
  };
  try { work(); } finally { (db as any).prepare = previous; }
  return seen;
}

it('one producer flip is one change row, and one view page re-checks that record exactly once', async () => {
  const f = await fixture(2);
  expect(f.pending()).toEqual(f.ids);
  const at = mark();
  produce([f.ids[0]!]);
  expect(since(at)).toEqual([{ kind: 'receipts', object_id: JSON.stringify([f.ids[0], 1, f.ids[0], 1, ceiling()]), version: 1 }]);
  expect(database().prepare('SELECT count(*) AS n FROM memory_recall_change_cover').get()!.n).toBe(0);
  let done = false;
  const seen = rechecks(() => { done = maintainRecallViewSlice(f.access.view); });
  expect(done).toBe(true);
  expect(seen).toEqual({ [f.ids[0]!]: 1 });
  expect(f.pending()).toEqual([f.ids[1]]);
  expect(f.watermark()).toBe(mark());
  // Nothing is left to re-check: a second page reads no record.
  expect(rechecks(() => { maintainRecallViewSlice(f.access.view); })).toEqual({});
});

it('a range holding receipts of two index generations re-checks each record version exactly once in one page', async () => {
  const f = await fixture(2);
  database().prepare("INSERT INTO memory_projection_receipts VALUES(?,1,1,'pending','pending',NULL)").run(f.ids[0]);
  for (let n = 0; n < 1000 && !maintainRecallViewSlice(f.access.view); n++);
  const at = mark();
  produce(f.ids);
  expect(since(at)).toEqual([{ kind: 'receipts', object_id: JSON.stringify([f.ids[0], 1, f.ids[1], 1, ceiling()]), version: 3 }]);
  let done = false;
  const seen = rechecks(() => { done = maintainRecallViewSlice(f.access.view); });
  expect(done).toBe(true);
  expect(seen).toEqual({ [f.ids[0]!]: 1, [f.ids[1]!]: 1 });
  expect(f.pending()).toEqual([]);
  expect(f.watermark()).toBe(mark());
});

it('a plain flip still logs one row per record, and the view sees it', async () => {
  const f = await fixture(2);
  const at = mark();
  flip([f.ids[1]!]);
  expect(since(at)).toEqual([{ kind: 'record', object_id: f.ids[1], version: 1 }]);
  expect(maintainRecallViewSlice(f.access.view)).toBe(true);
  expect(f.pending()).toEqual([f.ids[0]]);
});

it('fail closed: a cover that is not the newest change row hides nothing, and an uncovered member logs its own row', async () => {
  const f = await fixture(3);
  // a stale cover row (as a bug might leave): any later change row ends it
  const db = database();
  db.prepare('INSERT INTO memory_recall_change_cover VALUES(1,?,?,1,?,1)').run(mark(), f.ids[0], f.ids[2]);
  db.prepare("INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('job','fixture-job',0)").run();
  let at = mark();
  flip([f.ids[0]!]);
  expect(since(at)).toEqual([{ kind: 'record', object_id: f.ids[0], version: 1 }]);
  db.exec('DELETE FROM memory_recall_change_cover');
  // a covered statement that also flips a record outside its set: that record logs its own row
  at = mark();
  coverReceiptChanges(db, [[f.ids[1]!, 1]], () => { flip([f.ids[1]!, f.ids[2]!]); });
  const rows = since(at);
  expect(rows[0]).toEqual({ kind: 'receipts', object_id: JSON.stringify([f.ids[1], 1, f.ids[1], 1, ceiling()]), version: 1 });
  expect(rows.filter(row => row.kind === 'record').map(row => row.object_id)).toContain(f.ids[2]);
  for (let n = 0; n < 10 && !maintainRecallViewSlice(f.access.view); n++);
  expect(f.pending()).toEqual([]);
});

it('a page re-checks at most RECALL_BUILD_SLICE records, and the watermark moves only past whole set rows', async () => {
  const f = await fixture(600);
  const at = mark();
  produce(f.ids);
  const rows = since(at);
  expect(rows.map(row => [row.kind, row.version])).toEqual([['receipts', 256], ['receipts', 256], ['receipts', 88]]);
  const sequences = (database().prepare('SELECT sequence FROM memory_recall_changes WHERE sequence>? ORDER BY sequence').all(at) as Array<{ sequence: number }>).map(row => Number(row.sequence));
  expect(RECALL_BUILD_SLICE).toBe(RECALL_CHANGE_SET);
  expect(maintainRecallViewSlice(f.access.view)).toBe(false);
  expect(f.watermark()).toBe(sequences[0]);
  // recallrest-1020 (port onto 1.0.19): the retired per-view table held the 344 records not yet re-checked here. The pending page reads the
  // receipts, and all 600 are flipped already; how far the view has re-checked is the watermark above.
  expect(f.pending()).toEqual([]);
  expect(maintainRecallViewSlice(f.access.view)).toBe(false);
  expect(f.watermark()).toBe(sequences[1]);
  expect(maintainRecallViewSlice(f.access.view)).toBe(true);
  expect(f.watermark()).toBe(sequences[2]);
  expect(f.pending()).toEqual([]);
});

// memv2 lane A (MEMORY-V2-DESIGN 4.2 A3b, AF-H5; Sean's 1.0.21 memory ruling adopted by MAIN 2026-11-21T15:34Z): a range that holds more than
// RECALL_CHANGE_SET receipts when it is read used to be refused, which left every view unavailable for good (the row never shrinks). It is
// now paged with a cursor inside the row; the mark passes the row only when the whole range is read. The three tests below that asserted
// the refusal assert the paging instead; a row that cannot be parsed is still refused, and nothing is ever skipped.
it('a range row the consumer cannot read is refused; one now holding more than RECALL_CHANGE_SET receipts is paged; neither is ever skipped', async () => {
  const f = await fixture(300);
  const before = f.watermark();
  database().prepare("INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('receipts','not json',1)").run();
  expect(() => maintainRecallViewSlice(f.access.view)).toThrow('MEMORY_RECALL_UNAVAILABLE');
  expect(f.watermark()).toBe(before);
  database().exec("DELETE FROM memory_recall_changes WHERE kind='receipts'");
  database().prepare("INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('receipts',?,1)").run(JSON.stringify([f.ids[0], 1, f.ids[299], 1, ceiling()]));
  // 300 receipts: the first page reads RECALL_CHANGE_SET of them and the mark stays before the row; the next page finishes it.
  const seen = rechecks(() => { expect(maintainRecallViewSlice(f.access.view)).toBe(false); });
  expect(Object.keys(seen).length).toBeLessThanOrEqual(RECALL_CHANGE_SET);
  expect(f.watermark(), 'the mark does not pass a range that is half read').toBe(before);
  const rest = rechecks(() => { for (let n = 0; n < 10 && !maintainRecallViewSlice(f.access.view); n++); });
  expect(f.watermark()).toBeGreaterThan(before);
  expect(new Set([...Object.keys(seen), ...Object.keys(rest)]).size, 'every member of the range was re-checked').toBe(300);
  expect(() => coverReceiptChanges(database(), Array.from({ length: RECALL_CHANGE_SET + 1 }, (_, i) => [`x${i}`, 1] as const), () => {})).toThrow('MEMORY_RECALL_CHANGE_SET_TOO_LARGE');
});

it('a chunk whose range holds more than RECALL_CHANGE_SET receipts is not coalesced: each flip logs its own row', async () => {
  const f = await fixture(300);
  const at = mark(), sparse = [f.ids[0]!, f.ids[299]!];
  coverReceiptChanges(database(), sparse.map(id => [id, 1] as const), () => { flip(sparse); });
  expect(since(at).map(row => [row.kind, row.object_id])).toEqual(sparse.map(id => ['record', id]));
  for (let n = 0; n < 10 && !maintainRecallViewSlice(f.access.view); n++);
  expect(f.pending()).toHaveLength(298);
});

it('a delayed consumer reads a range that history has outgrown in bounded pieces: raw entries examined per read are capped, and the row is paged', async () => {
  const f = await fixture(2);
  const db = database(), scope = ensureScope('bot', 'reader');
  produce([f.ids[0]!, f.ids[1]!]);
  const record = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact','Fixture harbour note','owner-statement','active',0,1,NULL,NULL,1)");
  const receipt = db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,0,'pending','pending',NULL)");
  // newer receipts inside the logged key range, past its rowid ceiling: fewer than the cap are tolerated (the view's own change rows pick them up)
  for (let n = 0; n < 10; n++) { const id = `${f.ids[0]}-late${n}`; record.run(id, scope); receipt.run(id); }
  expect(() => { for (let n = 0; n < 10 && !maintainRecallViewSlice(f.access.view); n++); }).not.toThrow();
  // history keeps growing inside the range while the consumer is behind: each read is bounded, and the row is read in pieces (A3b)
  produce([f.ids[0]!, f.ids[1]!]);
  const before = f.watermark();
  for (let n = 10; n < RECALL_CHANGE_SET + 5; n++) { const id = `${f.ids[0]}-late${n}`; record.run(id, scope); receipt.run(id); }
  expect(maintainRecallViewSlice(f.access.view), 'the first piece does not finish the row').toBe(false);
  expect(f.watermark()).toBe(before);
  expect(() => { for (let n = 0; n < 20 && !maintainRecallViewSlice(f.access.view); n++); }).not.toThrow();
  expect(f.watermark()).toBeGreaterThan(before);
  expect(f.pending()).not.toContain(f.ids[1]);
});

it('a range row names each record version once, even when it holds receipts of several index generations', async () => {
  const f = await fixture(2);
  database().prepare("INSERT INTO memory_projection_receipts VALUES(?,1,1,'pending','pending',NULL)").run(f.ids[0]);
  expect(recallChangeRangePage(database(), JSON.stringify([f.ids[0], 1, f.ids[1], 1, ceiling()]))).toEqual({ members: [[f.ids[0], 1], [f.ids[1], 1]] });
});

it('the range read itself is bounded: it returns at most RECALL_CHANGE_SET+1 receipts however many the range now holds', async () => {
  const f = await fixture(RECALL_CHANGE_SET + 40), db = database(), previous = db.prepare; let most = 0;
  (db as any).prepare = (sql: string) => {
    const statement = previous.call(db, sql);
    if (!sql.includes('FROM memory_projection_receipts WHERE (record_id,record_version)>=')) return statement;
    return new Proxy(statement, { get(target, key) {
      const value = (target as any)[key];
      if (key !== 'all') return typeof value === 'function' ? value.bind(target) : value;
      return (...args: unknown[]) => { const rows = value.apply(target, args); most = Math.max(most, rows.length); return rows; };
    } });
  };
  let page: ReturnType<typeof recallChangeRangePage> | undefined;
  try { page = recallChangeRangePage(db, JSON.stringify([f.ids[0], 1, f.ids.at(-1), 1, ceiling()])); }
  finally { (db as any).prepare = previous; }
  // A3b: the piece is bounded and says where the range goes on, instead of refusing the row.
  expect(page!.members.length).toBeLessThanOrEqual(RECALL_CHANGE_SET);
  expect(page!.next).toEqual([f.ids[RECALL_CHANGE_SET - 1], 1]);
  expect(most).toBeGreaterThan(0);
  expect(most).toBeLessThanOrEqual(RECALL_CHANGE_SET + 1);
});

// MAIN 2026-11-17T07:44Z s12d-1: revocation is the second range-row producer.
it('one revocation records step logs one receipt range while retaining every record change and view re-check', async () => {
  const f = await fixture(3), db = database(), at = mark();
  const scope = ensureScope('bot', 'reader');
  const job: RevocationJob = { v: 2, id: 'fixture-revoke', phases: ['scope'], scopes: [scope], c: { table: 'records', rec: null } };
  db.exec('BEGIN IMMEDIATE');
  try { advanceRevocationJob(db, job, 3); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
  const rows = since(at);
  expect(rows.filter(row => row.kind === 'receipts')).toEqual([{ kind: 'receipts', object_id: JSON.stringify([f.ids[0], 1, f.ids[2], 1, ceiling()]), version: 3 }]);
  expect(rows.filter(row => row.kind === 'record').map(row => row.object_id)).toEqual(f.ids);
  expect(db.prepare('SELECT count(*) AS n FROM memory_recall_change_cover').get()!.n).toBe(0);
  expect(db.prepare("SELECT count(*) AS n FROM memory_projection_receipts WHERE lexical_status='delete-pending' AND embedding_status='delete-pending'").get()!.n).toBe(3);
  expect(db.prepare("SELECT count(*) AS n FROM memory_records WHERE state='deleted' AND text='' AND owner_pinned=0").get()!.n).toBe(3);
  expect(maintainRecallViewSlice(f.access.view)).toBe(true);
  expect(f.pending()).toEqual(f.ids);
  expect(db.prepare('SELECT record_id,state FROM memory_recall_view_records WHERE view_id=? AND generation=? ORDER BY record_id').all(f.access.view.viewId, f.access.view.generation)).toEqual(f.ids.map(record_id => ({ record_id, state: 'deleted' })));
  expect(db.prepare('SELECT count(*) AS n FROM memory_recall_view_terms WHERE view_id=? AND generation=?').get(f.access.view.viewId, f.access.view.generation)!.n).toBe(0);
  expect(f.watermark()).toBe(mark());
});
