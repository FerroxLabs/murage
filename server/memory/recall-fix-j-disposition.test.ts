// SPDX-License-Identifier: AGPL-3.0-or-later
// Receipt/disposition owner: recall-fix-j. Admitted recovery owner: recall-prod-x; MAIN integrates.
import { beforeEach, expect, it } from 'vitest';
import { closeDatabase, database } from '../database.ts';
import { authorityParts } from './authority-epoch.ts';
import { captureSource } from './capture.ts';
import { captureWork } from './chunks.ts';
import { refreshMemoryCheckpoint } from './consolidate.ts';
import { claimMemoryJob, publishMemoryWork } from './jobs.ts';
import { setMemoryMode } from './repository.ts';
import { storeAnchorMessage } from './testing/anchor-message.ts';
import { freshDataDir, THREAD } from './testing/recall-fixture.ts';
import { WritetimeFixture } from './testing/writetime-fixture.ts';

beforeEach(() => {
  freshDataDir('active'); new WritetimeFixture(database()).cert(true).ready(THREAD, true);
  database().exec("UPDATE memory_scopes SET audience='[]' WHERE id IN ('s-room','s-bot','s-other','s-project')");
});
function captured(kind = 'text', id = 'fixture-source') {
  const text = 'The fixture gate is green.', db = database();
  storeAnchorMessage(db, THREAD, id, text);
  captureSource(db, { id, threadId: THREAD, messageId: id, kind, speaker: 'owner', outcome: 'recorded', text });
  const work = claimMemoryJob('fixture')!;
  expect(work).toBeTruthy();
  publishMemoryWork(work, 'fixture', captureWork(work));
  return work;
}
const debt = (id: string) => database().prepare('SELECT * FROM memory_scope_bindings WHERE id=?').get('checkpoint-debt:' + id);
const page = () => database().prepare("SELECT id FROM memory_scope_bindings INDEXED BY memory_bindings_subject WHERE subject_type='system' AND subject_id='checkpoint-pending' AND rowid>? ORDER BY rowid LIMIT 2").all(0);

it.each(['source-has-no-thread', 'owner-archived-checkpoint', 'owner-controlled-checkpoint', 'no-current-completed-evidence', 'published-evidence-unavailable'])('commits exact durable %s disposition outside the recovery range', reason => {
  let work = captured();
  const db = database();
  if (reason === 'source-has-no-thread') db.prepare('UPDATE memory_sources SET thread_id=NULL WHERE id=?').run(work.sourceId);
  if (reason.startsWith('owner-')) {
    expect(refreshMemoryCheckpoint(work.id).status).toBe('updated');
    work = captured('text', 'fixture-next');
    if (reason === 'owner-archived-checkpoint') db.exec("UPDATE memory_checkpoint_heads SET state='archived'");
    else db.exec('UPDATE memory_records SET owner_pinned=1 WHERE kind=\'checkpoint\'');
  }
  if (reason === 'no-current-completed-evidence') db.prepare("UPDATE memory_sources SET kind='turn' WHERE id=?").run(work.sourceId);
  if (reason === 'published-evidence-unavailable') {
    expect(refreshMemoryCheckpoint(work.id).status).toBe('updated');
    const marker = { jobId: work.id, sourceId: work.sourceId, revision: work.revision };
    db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','checkpoint-pending',0,'granted',?)").run('checkpoint-debt:' + work.id, work.scopeId, JSON.stringify(marker));
    db.exec("UPDATE memory_records SET state='archived' WHERE kind='checkpoint'");
  }
  const original = debt(work.id)!, before = authorityParts()!.hard;
  expect(refreshMemoryCheckpoint(work.id)).toEqual({ status: 'deferred', reason });
  expect(debt(work.id)).toEqual({ ...original, subject_id: 'checkpoint-disposition', state: 'revoked', intent: JSON.stringify({ ...JSON.parse(String(original.intent)), disposition: reason }) });
  expect(authorityParts()!.hard).toBe(before);
  expect(page()).toEqual([]);
  closeDatabase();
  expect(debt(work.id)?.subject_id).toBe('checkpoint-disposition');
});

it('checking and bounded-payload refusal preserve the exact pending debt until a receipt commits', () => {
  const work = captured(), original = debt(work.id), db = database();
  expect(refreshMemoryCheckpoint(work.id, { maxPayloadBytes: 1 })).toEqual({ status: 'deferred', reason: 'evidence-checking' });
  expect(debt(work.id)).toEqual(original);
  new WritetimeFixture(db).pendingScope(work.scopeId, 0, 7).job(7, 1_000_000);
  expect(refreshMemoryCheckpoint(work.id)).toEqual({ status: 'deferred', reason: 'evidence-checking' });
  expect(debt(work.id)).toEqual(original);
  db.exec('DELETE FROM memory_deny_pending_scope; DELETE FROM memory_revoke_jobs');
  expect(refreshMemoryCheckpoint(work.id).status).toBe('updated');
  expect(debt(work.id)).toBeUndefined();
});

it('all three successful receipt paths consume debt without changing exact publication identity', () => {
  const work = captured(), db = database(), original = debt(work.id)!;
  const first = refreshMemoryCheckpoint(work.id);
  expect(first.status).toBe('updated'); expect(debt(work.id)).toBeUndefined();
  db.prepare('INSERT INTO memory_scope_bindings VALUES(?,?,?,?,?,?,?)').run(...Object.values(original));
  expect(refreshMemoryCheckpoint(work.id)).toEqual({ ...first, status: 'unchanged' });
  expect(debt(work.id)).toBeUndefined();
  const turn = captured('turn', 'fixture-turn');
  expect(refreshMemoryCheckpoint(turn.id)).toEqual({ ...first, status: 'unchanged' });
  expect(debt(turn.id)).toBeUndefined();
  expect(db.prepare('SELECT count(*) AS n FROM memory_checkpoint_publications').get()?.n).toBe(2);
});

it('a failed debt receipt rolls the new checkpoint and head back with it', () => {
  const work = captured(), db = database(), original = debt(work.id);
  db.exec("CREATE TEMP TRIGGER fixture_receipt_failure BEFORE DELETE ON memory_scope_bindings BEGIN SELECT RAISE(ABORT,'fixture receipt failed'); END");
  expect(() => refreshMemoryCheckpoint(work.id)).toThrow('fixture receipt failed');
  expect(debt(work.id)).toEqual(original);
  for (const table of ['memory_checkpoint_publications', 'memory_checkpoint_heads', 'memory_checkpoint_members']) expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
});

it('a failed disposition rolls selection clearing back and leaves debt recoverable', () => {
  const first = captured(), db = database();
  expect(refreshMemoryCheckpoint(first.id).status).toBe('updated');
  const turn = captured('turn', 'fixture-turn'), original = debt(turn.id);
  db.prepare("UPDATE memory_sources SET state='retired' WHERE id=?").run(first.sourceId);
  const head = db.prepare('SELECT * FROM memory_checkpoint_heads').get();
  db.exec("CREATE TEMP TRIGGER fixture_disposition_failure BEFORE UPDATE ON memory_scope_bindings WHEN NEW.subject_id='checkpoint-disposition' BEGIN SELECT RAISE(ABORT,'fixture disposition failed'); END");
  expect(() => refreshMemoryCheckpoint(turn.id)).toThrow('fixture disposition failed');
  expect(debt(turn.id)).toEqual(original);
  expect(db.prepare('SELECT * FROM memory_checkpoint_heads').get()).toEqual(head);
});

it('restart seeks pending debt past thirty thousand durable dispositions', () => {
  const db = database();
  db.exec("WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<30000) INSERT INTO memory_scope_bindings SELECT 'fixture-history:'||i,'s-room','system','checkpoint-disposition',0,'revoked','{}' FROM n");
  const work = captured(); closeDatabase();
  expect(page()).toEqual([{ id: 'checkpoint-debt:' + work.id }]);
  const plan = database().prepare("EXPLAIN QUERY PLAN SELECT id FROM memory_scope_bindings INDEXED BY memory_bindings_subject WHERE subject_type='system' AND subject_id='checkpoint-pending' AND rowid>? ORDER BY rowid LIMIT 2").all(0).map(row => row.detail).join(' ');
  expect(plan).toContain('SEARCH'); expect(plan).toContain('rowid>?'); expect(plan).not.toContain('TEMP B-TREE');
});

it.each(['off', 'paused'] as const)('current %s mode retains exact debt without publishing or disposing it', mode => {
  const work = captured(), original = debt(work.id);
  setMemoryMode(mode);
  expect(() => refreshMemoryCheckpoint(work.id)).toThrow('MEMORY_DISABLED');
  expect(debt(work.id)).toEqual(original);
  expect(database().prepare('SELECT * FROM memory_checkpoint_publications').all()).toEqual([]);
});
