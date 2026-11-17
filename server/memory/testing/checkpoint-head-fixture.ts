// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MAIN RULING 1115-RECALL-R7 (GrokBuild)
// Producer owner: recall-r7-a; consumer owner: MAIN (six granted family-head witnesses).
import { expect } from 'vitest';
import { database } from '../../database.ts';
import { authorityStamp } from '../authority-epoch.ts';

export function checkpointHead(thread: string) {
  const row = database().prepare('SELECT record_id,record_version FROM memory_checkpoint_heads WHERE thread_id=?').get(thread)!;
  return { id: String(row.record_id), version: Number(row.record_version) };
}
export function checkpointSnapshot(thread: string) {
  const ref = checkpointHead(thread), db = database();
  return { ref, record: db.prepare('SELECT * FROM memory_records WHERE id=? AND version=?').get(ref.id, ref.version),
    citations: db.prepare('SELECT * FROM memory_evidence WHERE record_id=? AND record_version=? ORDER BY source_id').all(ref.id, ref.version), stamp: authorityStamp() };
}
export function assertCheckpointRetained(before: ReturnType<typeof checkpointSnapshot>) {
  const db = database(), { id, version } = before.ref;
  expect(db.prepare('SELECT * FROM memory_records WHERE id=? AND version=?').get(id, version)).toEqual(before.record);
  expect(db.prepare('SELECT * FROM memory_evidence WHERE record_id=? AND record_version=? ORDER BY source_id').all(id, version)).toEqual(before.citations);
  expect(authorityStamp()).toBe(before.stamp);
}
