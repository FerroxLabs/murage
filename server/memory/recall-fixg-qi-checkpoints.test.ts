// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-fixg-qi. Consumers: bundle/readable, MAIN (integration).
import { beforeEach, expect, it } from 'vitest';
import { database, transaction } from '../database.ts';
import { refreshMemoryCheckpoint } from './consolidate.ts';
import { supersededThreadCheckpoint } from './checkpoints.ts';
import { accessFor, freshDataDir, THREAD } from './testing/recall-fixture.ts';
import { WritetimeFixture } from './testing/writetime-fixture.ts';
import { storeAnchorMessage } from './testing/anchor-message.ts';
import { captureSource } from './capture.ts';
import { captureWork } from './chunks.ts';
import { claimMemoryJob, publishMemoryWork } from './jobs.ts';
import { receipts, setupProofFixture } from './session-proof-fixture.ts';
import { proveRetainedSession } from './session-proof.ts';
import { LineageAllowance } from './lineage-allowance.ts';
import { forgetMemory } from './forget.ts';
import { ownerMemoryTicket } from './authority.ts';
import { openTurnLineage, closeTurnLineage, writeLineage } from './lineage-write.ts';
import { startFreshSession } from './session-incarnation.ts';

beforeEach(() => { freshDataDir('active'); new WritetimeFixture(database()).cert(true).ready(THREAD, true); });
function checkpoint(text: string, id: string, thread = THREAD) {
  const db = database();
  storeAnchorMessage(db, thread, id, text);
  writeLineage(db, { threadId: thread, messageId: id, author: 'owner' }, {});
  captureSource(db, { id, threadId: thread, messageId: id, kind: 'text', speaker: 'owner', outcome: 'recorded', text });
  const work = claimMemoryJob('fixture')!;
  publishMemoryWork(work, 'fixture', captureWork(work));
  const result = refreshMemoryCheckpoint(work.id);
  expect(result.status).toBe('updated');
  if (result.status === 'deferred') throw Error(result.reason);
  return result;
}

it('keeps the prior exact row and recognizes only its own later active family head', () => {
  const first = checkpoint('Initial completed evidence.', 'first-source');
  const next = checkpoint('Later completed evidence.', 'next-source');
  const db = database(), { access } = accessFor();
  expect(next.checkpointId).not.toBe(first.checkpointId);
  expect(next.version).toBe(1);
  expect(db.prepare('SELECT state FROM memory_records WHERE id=? AND version=?').get(first.checkpointId, first.version)?.state).toBe('active');
  expect(supersededThreadCheckpoint(first.checkpointId, first.version, access)).toBe(true);
  expect(supersededThreadCheckpoint(first.checkpointId, first.version, { threadId: 'sibling-thread' })).toBe(false);
  // The live head has no later head: it is current, not superseded.
  expect(supersededThreadCheckpoint(next.checkpointId, next.version, access)).toBe(false);
  db.prepare('UPDATE memory_records SET owner_pinned=1 WHERE id=? AND version=?').run(first.checkpointId, first.version);
  expect(supersededThreadCheckpoint(first.checkpointId, first.version, access)).toBe(false);
  db.prepare('UPDATE memory_records SET owner_pinned=0 WHERE id=? AND version=?').run(first.checkpointId, first.version);
  db.prepare("UPDATE memory_records SET state='archived' WHERE id=? AND version=?").run(next.checkpointId, next.version);
  expect(supersededThreadCheckpoint(first.checkpointId, first.version, access)).toBe(false);
  expect(db.prepare('SELECT * FROM memory_evidence WHERE record_id=? AND record_version=?').all(first.checkpointId, first.version)).toHaveLength(1);
});

it('a live retained proof survives its own head succession and still refuses a real source withdrawal', async () => {
  const f = setupProofFixture('direct');
  const first = checkpoint('Initial completed evidence.', 'native-first-source', f.key.threadId);
  const turn = openTurnLineage(database(), { threadId: f.key.threadId, turnId: 'fixture-live-turn' });
  const { key } = transaction(db => startFreshSession(db, f.key.threadId, f.key.driverInstance, f.key.nativeSession, turn));
  closeTurnLineage(turn);
  f.key = key;
  await receipts(f, 1);
  const prove = () => proveRetainedSession(LineageAllowance.tool(), f.key, { access: f.issue(), disclosed: true });
  expect(prove()).toEqual({ kind: 'resume' });
  checkpoint('Later completed evidence.', 'native-next-source', f.key.threadId);
  expect(database().prepare('SELECT state FROM memory_records WHERE id=? AND version=?').get(first.checkpointId, first.version)?.state).toBe('active');
  expect(prove()).toEqual({ kind: 'resume' });
  forgetMemory(ownerMemoryTicket(), { kind: 'source', id: 'native-first-source' });
  expect(prove().kind).toBe('fresh');
});
