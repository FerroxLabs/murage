// Settings v10 M0 (owner: core): Forget refuses a checkpoint head that moved on after the owner saw it (IA v10 §3, TASKS-v8 M0).
// Real publication, correction, archive and restore; the request goes through the owner memory route.
import { mkdirSync } from 'node:fs';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { storeAnchorMessage } from './testing/anchor-message.ts';
import { captureSource } from './capture.ts';
import { claimMemoryJob, publishMemoryWork, resetMemoryClaimCursor } from './jobs.ts';
import { captureWork } from './chunks.ts';
import { refreshMemoryCheckpoint } from './consolidate.ts';
import { reconcileMemoryRoster } from './policy.ts';
import { setMemoryMode } from './repository.ts';
import { WritetimeFixture } from './testing/writetime-fixture.ts';
import { stopMemoryRevocation } from './memory-revocation.ts';
import { archiveMemoryRecord, restoreArchivedMemoryRecord } from './retention.ts';
import { correctMemory, ownerMemoryTicket } from './authority.ts';
import { memoryOwnerRoute } from './settings.ts';

const roster = { bots: [{ id: 'reader', threadId: 'thread' }], groups: [] } as never;
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster({ bots: [{ id: 'reader', threadId: 'thread' }], groups: [] }); setMemoryMode('capture'); resetMemoryClaimCursor();
  new WritetimeFixture(database()).cert(true).ready('thread', true);
  database().exec("UPDATE memory_scopes SET audience='[]' WHERE id IN ('s-room','s-bot','s-other','s-project')");
});
afterEach(() => { stopMemoryRevocation(); closeDatabase(); });

function captured(id: string, text: string) {
  storeAnchorMessage(database(), 'thread', id, text);
  const lsn = Number(database().prepare('SELECT next FROM memory_lsn WHERE id=1').get()!.next);
  new WritetimeFixture(database()).lineage('thread', id, lsn, { generated: false, turnLsn: null }).ready('thread', true);
  captureSource(database(), { id, threadId: 'thread', messageId: id, origin: { kind: 'attended' }, kind: 'text', speaker: 'owner', outcome: 'recorded', text });
  const work = claimMemoryJob('checkpoint-fixture')!;
  expect(work).toBeTruthy(); publishMemoryWork(work, 'checkpoint-fixture', captureWork(work));
  return work.id;
}
function published(job: string) {
  const result = refreshMemoryCheckpoint(job);
  if (result.status !== 'updated') throw Error(`checkpoint not published: ${JSON.stringify(result)}`);
  return { id: result.checkpointId, version: result.version };
}
const head = () => database().prepare('SELECT family_id,sequence,record_id,record_version,state FROM memory_checkpoint_heads').get() as { family_id: string; sequence: number; record_id: string | null; record_version: number | null; state: string };
/** What the archived history row displays: the family's sequence, its member there, and that record's newest version. */
function archivedRow() {
  const h = head();
  expect(h.state).toBe('archived');
  const member = database().prepare('SELECT record_id FROM memory_checkpoint_members WHERE family_id=? AND sequence=?').get(h.family_id, h.sequence) as { record_id: string };
  const v = Number(database().prepare('SELECT max(version) AS v FROM memory_records WHERE id=?').get(member.record_id)!.v);
  return { familyId: h.family_id, sequence: h.sequence, memberRecordId: member.record_id, memberVersion: v, state: 'archived' as const };
}
const forget = (id: string, revision: number, expectedHead: object) =>
  memoryOwnerRoute('/api/memory/action', { action: 'forget', kind: 'record', id, revision, expectedHead }, ownerMemoryTicket(), roster);
/** Contents, deletion epoch and every row a Forget writes. */
function snapshot() {
  const db = database();
  const all = (sql: string) => JSON.stringify(db.prepare(sql).all());
  return {
    records: all('SELECT id,version,state,text FROM memory_records ORDER BY id,version'),
    epoch: all('SELECT deletion_epoch,policy_revision FROM memory_meta'),
    exclusions: all('SELECT * FROM memory_checkpoint_exclusions ORDER BY 1,2,3'),
    tombstones: all('SELECT target_type,target_id,revision,reason FROM memory_tombstones ORDER BY 1,2,3,4'),
    heads: all('SELECT * FROM memory_checkpoint_heads ORDER BY family_id'),
    jobs: all('SELECT count(*) AS n FROM memory_revoke_jobs'),
  };
}
async function refusedUnchanged(id: string, revision: number, confirmed: object) {
  const before = snapshot();
  await expect(forget(id, revision, confirmed)).rejects.toMatchObject({ message: 'MEMORY_CHANGED', status: 409 });
  expect(snapshot()).toEqual(before);
}

it('M0 (a): the corrected v2 checkpoint the owner archived is forgotten from its displayed row', async () => {
  const a = published(captured('message-a', 'First observation.'));
  const v2 = correctMemory(ownerMemoryTicket(), a.id, a.version, 'First observation, corrected.');
  expect(v2).toBe(a.version + 1);
  archiveMemoryRecord(ownerMemoryTicket(), a.id, v2);
  const row = archivedRow();
  expect(row.memberVersion).toBe(v2);
  await expect(forget(a.id, v2, row)).resolves.toMatchObject({ status: 'excluded' });
  expect(head().state).toBe('forgotten');
});

it("M0 (a'): an unedited archived checkpoint is forgotten from its displayed row", async () => {
  const a = published(captured('message-a', 'First observation.'));
  archiveMemoryRecord(ownerMemoryTicket(), a.id, a.version);
  const shown = archivedRow();
  await expect(forget(a.id, a.version, shown)).resolves.toMatchObject({ status: 'excluded' });
  expect(head().state).toBe('forgotten');
  // a second tap with the same confirmation forgets nothing again
  await refusedUnchanged(a.id, a.version, shown);
});

it('M0 (b): restore, publish and archive elsewhere after the row was shown refuses the old confirmation and changes nothing', async () => {
  const a = published(captured('message-a', 'First observation.'));
  archiveMemoryRecord(ownerMemoryTicket(), a.id, a.version);
  const shown = archivedRow();
  restoreArchivedMemoryRecord(ownerMemoryTicket(), a.id, a.version);
  const b = published(captured('message-b', 'Second observation.'));
  expect(b.id).not.toBe(a.id);
  archiveMemoryRecord(ownerMemoryTicket(), b.id, b.version);
  expect(head().sequence).not.toBe(shown.sequence);
  await refusedUnchanged(a.id, a.version, shown);
});

it('M0 (b2): a correction to v3 at the same sequence refuses the old v2 confirmation and changes nothing', async () => {
  const a = published(captured('message-a', 'First observation.'));
  const v2 = correctMemory(ownerMemoryTicket(), a.id, a.version, 'First observation, corrected.');
  archiveMemoryRecord(ownerMemoryTicket(), a.id, v2);
  const shown = archivedRow();
  restoreArchivedMemoryRecord(ownerMemoryTicket(), a.id, v2);
  const v3 = correctMemory(ownerMemoryTicket(), a.id, v2, 'First observation, corrected again.');
  archiveMemoryRecord(ownerMemoryTicket(), a.id, v3);
  expect(head().sequence).toBe(shown.sequence);
  await refusedUnchanged(a.id, v2, shown);
});

it('M0 (v8 active): a head moved to another record after it was shown refuses and changes nothing; the current head is forgotten', async () => {
  const a = published(captured('message-a', 'First observation.'));
  const shown = { familyId: head().family_id, recordId: a.id, version: a.version, state: 'active' as const };
  const b = published(captured('message-b', 'Second observation.'));
  expect(head()).toMatchObject({ record_id: b.id, state: 'active' });
  await refusedUnchanged(a.id, a.version, shown);
  await expect(forget(b.id, b.version, { familyId: head().family_id, recordId: b.id, version: b.version, state: 'active' })).resolves.toMatchObject({ status: 'excluded' });
});

it('M0: an archived confirmation for an active family refuses (a NULL never matches)', async () => {
  const a = published(captured('message-a', 'First observation.'));
  const h = head();
  await refusedUnchanged(a.id, a.version, { familyId: h.family_id, sequence: h.sequence, memberRecordId: a.id, memberVersion: a.version, state: 'archived' });
});
