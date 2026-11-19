// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-fixg-qi. Consumers: recall-prod-y (proof), MAIN (integration).
import { beforeEach, expect, it } from 'vitest';
import { closeDatabase, database } from '../database.ts';
import { ensureSessionProofSchema } from './session-proof-schema.ts';
import { freshDataDir } from './testing/recall-fixture.ts';

beforeEach(() => freshDataDir('active'));

it('reopens a checks table a 1.0.20 candidate widened, hands its column back and keeps its rows: the table is the 1.0.19 one again', () => {
  const db = database();
  const shipped = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='memory_session_checks'").get()!.sql);
  expect(db.prepare("PRAGMA table_info(memory_session_checks)").all().some(row => row.name === 'deny_generation')).toBe(false);
  db.exec('ALTER TABLE memory_session_checks ADD COLUMN deny_generation INTEGER NOT NULL DEFAULT -1');
  db.prepare(`INSERT INTO memory_session_checks(thread_id,driver_instance,native_session,reader_key,up_to,log_seq,recall_epoch,
    view_id,view_generation,view_digest,policy_revision,deletion_epoch,footprint,cites,seeding,checked)
    VALUES('thread','engine','session','reader',0,0,0,NULL,NULL,NULL,1,0,'{"v":2,"s":[],"dg":0}',0,0,0)`).run();
  closeDatabase();
  const reopened = database();
  expect(reopened.prepare("PRAGMA table_info(memory_session_checks)").all().some(row => row.name === 'deny_generation')).toBe(false);
  expect(String(reopened.prepare("SELECT sql FROM sqlite_schema WHERE name='memory_session_checks'").get()!.sql)).toBe(shipped);
  ensureSessionProofSchema(reopened);
  expect(reopened.prepare('SELECT footprint FROM memory_session_checks').get()).toEqual({ footprint: '{"v":2,"s":[],"dg":0}' });
});

it('refuses a proof table with an unknown column instead of treating it as the legacy schema', () => {
  database().exec('ALTER TABLE memory_session_checks ADD COLUMN fixture_extra INTEGER');
  closeDatabase();
  expect(() => database()).toThrow('MEMORY_SCHEMA_UNSUPPORTED');
});

it('rebuilds the missing receipt-session index when reopening an existing supported database', () => {
  database().exec('DROP INDEX IF EXISTS memory_receipt_lines_session');
  closeDatabase();
  const db = database();
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name='memory_receipt_lines_session'").get()).toBeDefined();
  const plans = db.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM memory_receipt_lines WHERE session_no=1 LIMIT 1').all();
  expect(plans.map(row => row.detail).join(' ')).toContain('SEARCH memory_receipt_lines USING COVERING INDEX memory_receipt_lines_session');
});
