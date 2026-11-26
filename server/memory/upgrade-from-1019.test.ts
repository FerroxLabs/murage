// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: schema-compat-1020 (was recallrest-1020). Producer: recall-view-schema.ts / session-proof-schema.ts (schema text, the repair of a file a
// 1.0.20 candidate build changed); consumer: schema.ts validateMemorySchema (what a start accepts), here and in the shipped 1.0.19.
// testing/schema-1019.json is every recall and session-proof object of a file made by the 1.0.19 release (3ead2c9023), read from that file's
// sqlite_schema. It is the shipped text, not text this build generates. 1.0.19 accepts these objects only with exactly this text (its
// validateMemorySchema), so a file this build leaves must hold exactly them: going back to 1.0.19 must start, not land on its restore page.
import { readFileSync } from 'node:fs';
import { beforeEach, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { closeDatabase, database } from '../database.ts';
import { stopSearchIndex } from '../message-search-index.ts';
import { stopWalMaintenance } from '../wal-maintenance.ts';
import { RECALL_PENDING_OBJECTS } from './recall-view-schema.ts';
import { sessionChecksCandidateSql } from './session-proof-schema.ts';
import { freshDataDir } from './testing/recall-fixture.ts';

type Row = { type: string; name: string; tbl_name: string; sql: string | null };
const SHIPPED = JSON.parse(readFileSync(new URL('./testing/schema-1019.json', import.meta.url), 'utf8')) as Row[];
const PENDING = ['memory_recall_view_pending', 'memory_recall_pending_record', 'memory_recall_view_pending_storage_i', 'memory_recall_view_pending_storage_d'];
const schema = (db: DatabaseSync) => db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name LIKE 'memory_recall_%' OR tbl_name LIKE 'memory_recall_%'
  OR name LIKE 'memory_session_proof_%' OR tbl_name IN ('memory_session_checks','memory_session_check_cites','memory_session_change_log','memory_session_state','memory_session_check_messages') ORDER BY name`).all() as unknown as Row[];
const shipped = (name: string) => SHIPPED.find(row => row.name === name)!.sql!;
const bytes = (db: DatabaseSync) => Number(db.prepare('SELECT bytes FROM memory_recall_storage WHERE id=1').get()!.bytes);
const epoch = (db: DatabaseSync) => Number(db.prepare('SELECT epoch FROM memory_recall_epoch WHERE id=1').get()!.epoch);
/** What a 1.0.20 candidate build (dev/1020q-late 3279cef67b) left: the pending table retired and one column added to the checks table. */
function shapeAsCandidate(db: DatabaseSync): void {
  db.exec('UPDATE memory_recall_storage SET bytes=max(0,bytes-512*(SELECT count(*) FROM memory_recall_view_pending)) WHERE id=1');
  db.exec('DROP TABLE memory_recall_view_pending');
  db.exec('ALTER TABLE memory_session_checks ADD COLUMN deny_generation INTEGER NOT NULL DEFAULT -1');
}
const refusedStart = async () => {
  closeDatabase();
  try { expect(() => database()).toThrow(/MEMORY_SCHEMA_UNSUPPORTED/); }
  finally { closeDatabase(); await stopWalMaintenance(); await stopSearchIndex(); }
};

beforeEach(() => freshDataDir('active'));

it('every recall and session-proof object this build makes is the 1.0.19 one, byte for byte, and there is nothing else', () => {
  expect(SHIPPED.length).toBe(89);
  expect([...RECALL_PENDING_OBJECTS].sort()).toEqual([...PENDING].sort());
  expect([...PENDING].sort()).toEqual(SHIPPED.filter(row => row.tbl_name === 'memory_recall_view_pending').map(row => row.name).sort());
  expect(schema(database()).map(row => ({ ...row }))).toEqual(SHIPPED);
});

it('a 1.0.19 file opens unchanged: its pending rows, their storage charge, its views and the epoch all stay', () => {
  let db = database();
  db.prepare("INSERT INTO memory_recall_views VALUES('v','g',0,1,'ready',0,'',0,0)").run();
  db.exec('UPDATE memory_recall_epoch SET epoch=epoch+1000 WHERE id=1');
  const before = bytes(db), at = epoch(db);
  for (let n = 1; n <= 3; n++) db.prepare("INSERT INTO memory_recall_view_pending VALUES('v','g',?,?,1)").run(n, `record-${n}`);
  expect(bytes(db)).toBe(before + 3 * 512);
  closeDatabase();
  db = database();
  expect(schema(db).map(row => ({ ...row }))).toEqual(SHIPPED);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_recall_view_pending WHERE view_id='v'").get()!.n)).toBe(3);
  expect(bytes(db)).toBe(before + 3 * 512);
  expect(epoch(db)).toBe(at);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_recall_views WHERE view_id='v' AND state='ready'").get()!.n)).toBe(1);
});

it('a file a 1.0.20 candidate changed opens and is handed back as the 1.0.19 file: pending table back, column gone, every view stale, rows kept', () => {
  let db = database();
  db.prepare("INSERT INTO memory_recall_views VALUES('v','g',0,1,'ready',0,'',0,0)").run();
  db.prepare("INSERT INTO memory_recall_view_pending VALUES('v','g',1,'record-1',1)").run();
  db.prepare(`INSERT INTO memory_session_checks(thread_id,driver_instance,native_session,reader_key,up_to,log_seq,recall_epoch,
    view_id,view_generation,view_digest,policy_revision,deletion_epoch,footprint,cites,seeding,checked)
    VALUES('thread-1020','engine','session','reader',0,0,0,NULL,NULL,NULL,1,0,'{"v":2,"s":[],"dg":0}',0,0,0)`).run();
  shapeAsCandidate(db);
  expect(String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='memory_session_checks'").get()!.sql)).toBe(sessionChecksCandidateSql());
  expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_recall_view_pending'").get()).toBeUndefined();
  const before = bytes(db), at = epoch(db);
  closeDatabase();
  db = database();
  expect(schema(db).map(row => ({ ...row }))).toEqual(SHIPPED);
  // the view 1.0.20 built has no pending rows: the moved epoch keeps both releases from reading it
  expect(epoch(db)).toBe(at + 1);
  expect(bytes(db)).toBe(before);
  expect({ ...db.prepare("SELECT footprint FROM memory_session_checks WHERE thread_id='thread-1020'").get() }).toEqual({ footprint: '{"v":2,"s":[],"dg":0}' });
  // a second start finds nothing left to do
  closeDatabase();
  db = database();
  expect(schema(db).map(row => ({ ...row }))).toEqual(SHIPPED);
  expect(epoch(db)).toBe(at + 1);
});

it('a pending table that lost its index and triggers is neither the 1.0.19 one nor a retired one: the start refuses it', async () => {
  const db = database();
  for (const name of PENDING.slice(1)) db.exec(`DROP ${name === 'memory_recall_pending_record' ? 'INDEX' : 'TRIGGER'} ${name}`);
  await refusedStart();
});

it('a pending table with any other text is not the 1.0.19 one: the start refuses it', async () => {
  const db = database();
  db.exec('DROP TABLE memory_recall_view_pending');
  db.exec(shipped('memory_recall_view_pending').replace('version INTEGER NOT NULL,PRIMARY KEY', 'version INTEGER NOT NULL,extra INTEGER,PRIMARY KEY'));
  expect(String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='memory_recall_view_pending'").get()!.sql)).toContain('extra INTEGER');
  for (const name of PENDING.slice(1)) db.exec(shipped(name));
  await refusedStart();
});

it('a checks table with the candidate column under any other text is refused', async () => {
  database().exec('ALTER TABLE memory_session_checks ADD COLUMN deny_generation INTEGER NOT NULL DEFAULT 0');
  await refusedStart();
});
