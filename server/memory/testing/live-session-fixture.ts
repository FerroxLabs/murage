// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MAIN RULING 1115-RECALL-R7 (GrokBuild)
// Producer owner: recall-r7-a; consumer owner: MAIN (granted retained-session witnesses).
import { strict as assert } from 'node:assert';
import { database, transaction } from '../../database.ts';
import { assertMemoryAccess, type MemoryAccess } from '../policy.ts';
import { FreshReplaySessionConfirmation } from '../fresh-replay-session.ts';
import { captureSendReplayProof } from '../replay-lineage.ts';
import { closeTurnLineage, openTurnLineage, writeLineage } from '../lineage-write.ts';
import { startFreshSession } from '../session-incarnation.ts';
import { initializeFreshSessionProof } from '../session-proof.ts';
import { noteSessionFrame } from '../session-proof-schema.ts';
import { storeAnchorMessage } from './anchor-message.ts';

export function storeLiveAnchor(...args: Parameters<typeof storeAnchorMessage>) {
  storeAnchorMessage(...args);
  const [db, threadId, messageId, , role = 'user'] = args;
  writeLineage(db, { threadId, messageId, author: role === 'user' ? 'owner' : 'generated' }, {});
}

/** Only a new live start can initialize; an existing retained key is never repaired here. */
export function startLiveSession(access: MemoryAccess, instance: string, session: string, bindFrame?: () => void) {
  const db = database(), threadId = access.threadId;
  if (db.prepare('SELECT 1 FROM memory_session_lineage WHERE thread_id=? AND driver_instance=? AND native_session=?').get(threadId, instance, session)) return;
  const turnId = `fixture-start:${session}`;
  const turn = openTurnLineage(db, { threadId, turnId });
  let key;
  try {
    const started = transaction(tx => startFreshSession(tx, threadId, instance, session, turn));
    assert.equal(started.recorded, true, 'Fixture live session must record its native start');
    key = started.key;
  }
  finally { closeTurnLineage(turn); }
  const confirmation = new FreshReplaySessionConfirmation(captureSendReplayProof(threadId, []), instance, () => assertMemoryAccess(access), { generation: access.generation });
  confirmation.sessionStarted(turnId, key, true);
  confirmation.engineWritten(); confirmation.accepted(turnId);
  assert.equal(confirmation.firstFrameSessionCurrent(key, access.generation), true, 'Fixture live session must confirm this generation');
  noteSessionFrame(db, key, false);
  initializeFreshSessionProof(key, access, bindFrame, { fresh: true, confirmation });
  return confirmation;
}

// A live frame carries each selected record's exact source revisions too.
export function liveFrameSources(records: readonly { id: string; version: number }[]) {
  const sources = records.flatMap(record => database().prepare('SELECT source_id AS id,source_revision AS revision FROM memory_evidence WHERE record_id=? AND record_version=?').all(record.id, record.version));
  return [...new Map(sources.map(row => [JSON.stringify([row.id,row.revision]), { id: String(row.id), revision: Number(row.revision) }])).values()];
}
