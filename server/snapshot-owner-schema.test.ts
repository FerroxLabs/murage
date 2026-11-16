// SPDX-License-Identifier: AGPL-3.0-or-later
// Send-schema producer: tri-s1-rd. Snapshot compatibility consumer: c4-misc-d.
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { initializeMessageTables } from './message-tables.ts';
import { initializeOwnerSends } from './send-store.ts';
import { inspectInstallationDatabase } from './installation-database-snapshot.ts';
import { downgradeOwnerSendAskProof, downgradePhoneObjectsTo108 } from './installation-app-schema-downgrade.ts';

it.each([false, true])('snapshot: actual historical owner-send migration retains exact schema compatibility, before turn-id=%s', beforeTurn => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeMessageTables(db); initializeOwnerSends(db);
    for (const name of ['late_refused', 'isolated', 'via_proof', 'attachments', 'via_device', 'queue_only', 'via', ...(beforeTurn ? ['turn_id'] : [])]) {
      db.exec('ALTER TABLE owner_sends DROP COLUMN ' + name);
    }
    expect(() => inspectInstallationDatabase(db)).not.toThrow();
    initializeOwnerSends(db);
    expect(() => inspectInstallationDatabase(db)).not.toThrow();
    db.exec('ALTER TABLE owner_sends ADD COLUMN arbitrary_proof TEXT');
    expect(() => inspectInstallationDatabase(db)).toThrow(expect.objectContaining({ code: 'DATABASE_SCHEMA_UNSUPPORTED' }));
  } finally { db.close(); }
});

it.each(['proof', 'phone'] as const)('snapshot: the real %s downgrade is accepted before and after reopening a settled send', kind => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeMessageTables(db); initializeOwnerSends(db);
    db.exec("INSERT INTO owner_sends(kind,owner_id,thread_id,queue_id,fingerprint,status,created_at,updated_at) VALUES('bot','fixture','thread','queue','digest','delivered',1,1)");
    if (kind === 'proof') downgradeOwnerSendAskProof(db);
    else downgradePhoneObjectsTo108(db);
    expect(() => inspectInstallationDatabase(db)).not.toThrow();
    initializeOwnerSends(db);
    expect(() => inspectInstallationDatabase(db)).not.toThrow();
    db.exec('ALTER TABLE owner_sends ADD COLUMN arbitrary_proof TEXT');
    expect(() => inspectInstallationDatabase(db)).toThrow(expect.objectContaining({ code: 'DATABASE_SCHEMA_UNSUPPORTED' }));
  } finally { db.close(); }
});
