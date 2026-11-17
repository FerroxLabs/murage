// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-fix-i (capture debt). Consumer owner: recall-prod-x (admitted recovery); MAIN integrates.
import { beforeEach, expect, it, vi } from 'vitest';
import { closeDatabase, database } from '../database.ts';
import { captureSource } from './capture.ts';
import { authorityParts } from './authority-epoch.ts';
import { captureWork } from './chunks.ts';
import { refreshMemoryCheckpoint } from './consolidate.ts';
import { claimMemoryJob, publishMemoryWork } from './jobs.ts';
import { freshDataDir, THREAD } from './testing/recall-fixture.ts';
import { storeAnchorMessage } from './testing/anchor-message.ts';

beforeEach(() => {
  freshDataDir('active');
  database().exec("UPDATE memory_lineage_cert SET ready=1,phase='done' WHERE id=1");
  database().prepare('INSERT OR REPLACE INTO memory_lineage_thread_ready(thread_id,ready) VALUES(?,1)').run(THREAD);
});

function work(text = 'The fixture gate is green.') {
  const db = database();
  storeAnchorMessage(db, THREAD, 'message', text);
  captureSource(db, { id: 'fixture-source', threadId: THREAD, messageId: 'message', kind: 'text', speaker: 'owner', outcome: 'recorded', text });
  return claimMemoryJob('fixture')!;
}
const debt = (id: string) => database().prepare('SELECT * FROM memory_scope_bindings WHERE id=?').get('checkpoint-debt:' + id);

it('capture and its exact checkpoint debt survive reopen through the existing marker index', () => {
  const w = work();
  publishMemoryWork(w, 'fixture', captureWork(w));
  closeDatabase();
  const db = database();
  expect(db.prepare('SELECT status,cursor FROM memory_jobs WHERE id=?').get(w.id)).toMatchObject({ status: 'complete', cursor: w.totalBytes });
  expect(debt(w.id)).toMatchObject({ scope_id: w.scopeId, subject_type: 'system', subject_id: 'checkpoint-pending', state: 'granted' });
  expect(JSON.parse(String(debt(w.id)!.intent))).toEqual({ jobId: w.id, sourceId: w.sourceId, revision: w.revision });
  const sql = "SELECT id FROM memory_scope_bindings INDEXED BY memory_bindings_subject WHERE subject_type='system' AND subject_id='checkpoint-pending' AND rowid>? ORDER BY rowid LIMIT 2";
  expect(db.prepare(sql).all(0)).toEqual([{ id: 'checkpoint-debt:' + w.id }]);
  expect(db.prepare('EXPLAIN QUERY PLAN ' + sql).all(0).map(row => row.detail).join(' ')).toContain('USING INDEX memory_bindings_subject');
});

it('a debt write failure rolls back capture records, evidence, receipts, coverage and job completion', () => {
  const w = work(), db = database(), prepare = db.prepare.bind(db);
  const before = db.prepare('SELECT * FROM memory_jobs WHERE id=?').get(w.id);
  const spy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
    if (sql.includes('INSERT') && sql.includes('memory_scope_bindings')) throw Error('fixture debt write failed');
    return prepare(sql);
  });
  try { expect(() => publishMemoryWork(w, 'fixture', captureWork(w))).toThrow('fixture debt write failed'); }
  finally { spy.mockRestore(); }
  expect(db.prepare('SELECT * FROM memory_jobs WHERE id=?').get(w.id)).toEqual(before);
  for (const table of ['memory_records', 'memory_evidence', 'memory_projection_receipts']) expect(db.prepare(`SELECT * FROM ${table}`).all()).toHaveLength(0);
  expect(debt(w.id)).toBeUndefined();
});

it('checkpoint failure preserves completed capture and exact durable debt', () => {
  const w = work(), db = database();
  publishMemoryWork(w, 'fixture', captureWork(w));
  db.exec("CREATE TEMP TRIGGER fixture_checkpoint_failure BEFORE INSERT ON memory_checkpoint_publications BEGIN SELECT RAISE(ABORT,'fixture checkpoint failed'); END");
  expect(() => refreshMemoryCheckpoint(w.id)).toThrow('fixture checkpoint failed');
  expect(db.prepare('SELECT status FROM memory_jobs WHERE id=?').get(w.id)).toEqual({ status: 'complete' });
  expect(debt(w.id)).toMatchObject({ subject_id: 'checkpoint-pending' });
  expect(db.prepare('SELECT * FROM memory_checkpoint_heads').all()).toHaveLength(0);
});

it('partial coverage creates no checkpoint obligation', () => {
  const w = work('x'.repeat(3 * 65536));
  const result = captureWork(w);
  expect(result.status).toBe('partial');
  publishMemoryWork(w, 'fixture', result);
  expect(database().prepare('SELECT status,cursor FROM memory_jobs WHERE id=?').get(w.id)).toMatchObject({ status: 'partial', cursor: result.nextCursor });
  expect(debt(w.id)).toBeUndefined();
});

it('checkpoint debt is bookkeeping while a real binding still changes authority', () => {
  const w = work(), db = database(), before = authorityParts()!;
  publishMemoryWork(w, 'fixture', captureWork(w));
  expect(authorityParts()!.hard).toBe(before.hard);
  db.prepare("UPDATE memory_scope_bindings SET state='revoked' WHERE id=?").run('checkpoint-debt:' + w.id);
  expect(authorityParts()!.hard).toBe(before.hard);
  db.prepare('DELETE FROM memory_scope_bindings WHERE id=?').run('checkpoint-debt:' + w.id);
  expect(authorityParts()!.hard).toBe(before.hard);
  db.prepare("INSERT INTO memory_scope_bindings VALUES('fixture-person',?,'person','fixture-person',0,'granted','{}')").run(w.scopeId);
  expect(authorityParts()!.hard).not.toBe(before.hard);
});
