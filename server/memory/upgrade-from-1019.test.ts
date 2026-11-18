// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: recallrest-1020. Producer: recall-view-schema.ts / session-proof-schema.ts (schema text, the retirement of the 1.0.19 pending table);
// consumer: schema.ts validateMemorySchema (what a start accepts).
// testing/schema-1019.json is every recall and session-proof object of a file made by the 1.0.19 release (3ead2c9023), read from that file's
// sqlite_schema. It is the shipped text, not text this build generates, so these tests fail if this build stops accepting a 1.0.19 file.
import { readFileSync } from 'node:fs';
import { beforeEach, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { closeDatabase, database } from '../database.ts';
import { stopSearchIndex } from '../message-search-index.ts';
import { stopWalMaintenance } from '../wal-maintenance.ts';
import { recallLegacyPendingObjects } from './recall-view-schema.ts';
import { SESSION_CHECKS_LEGACY_SQL, sessionProofSchemaObjects } from './session-proof-schema.ts';
import { freshDataDir } from './testing/recall-fixture.ts';

type Row = { type: string; name: string; tbl_name: string; sql: string | null };
const SHIPPED = JSON.parse(readFileSync(new URL('./testing/schema-1019.json', import.meta.url), 'utf8')) as Row[];
const PENDING = ['memory_recall_view_pending', 'memory_recall_pending_record', 'memory_recall_view_pending_storage_i', 'memory_recall_view_pending_storage_d'];
const schema = (db: DatabaseSync) => db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name LIKE 'memory_recall_%' OR tbl_name LIKE 'memory_recall_%'
  OR name LIKE 'memory_session_proof_%' OR tbl_name IN ('memory_session_checks','memory_session_check_cites','memory_session_change_log','memory_session_state','memory_session_check_messages') ORDER BY name`).all() as unknown as Row[];
const shipped = (name: string) => SHIPPED.find(row => row.name === name)!.sql!;
const bytes = (db: DatabaseSync) => Number(db.prepare('SELECT bytes FROM memory_recall_storage WHERE id=1').get()!.bytes);
/** Turn the open file's recall and session-proof schema into the one 1.0.19 left, using the shipped text. */
function shapeAs1019(db: DatabaseSync): void {
  for (const type of ['table', 'index', 'trigger']) for (const row of SHIPPED) if (PENDING.includes(row.name) && row.type === type) db.exec(row.sql!);
  db.exec('ALTER TABLE memory_session_checks DROP COLUMN deny_generation');
}
const refusedStart = async () => {
  closeDatabase();
  try { expect(() => database()).toThrow(/MEMORY_SCHEMA_UNSUPPORTED/); }
  finally { closeDatabase(); await stopWalMaintenance(); await stopSearchIndex(); }
};

beforeEach(() => freshDataDir('active'));

it('every recall and session-proof object of a 1.0.19 file is unchanged in this build, except the retired pending table and the one column added to the checks table', () => {
  const current = new Map(schema(database()).map(row => [row.name, row]));
  const legacy = recallLegacyPendingObjects();
  expect(SHIPPED.length).toBe(89);
  expect([...legacy.keys()].sort()).toEqual([...PENDING].sort());
  for (const row of SHIPPED) {
    if (PENDING.includes(row.name)) {
      // what validation accepts is the shipped text, byte for byte
      expect({ ...legacy.get(row.name) }, row.name).toEqual(row);
      expect(current.has(row.name), row.name).toBe(false);
    } else if (row.name === 'memory_session_checks') {
      expect(row.sql).toBe(SESSION_CHECKS_LEGACY_SQL);
      expect(current.get(row.name)!.sql).toBe(sessionProofSchemaObjects().get(row.name)!.sql);
      expect(current.get(row.name)!.sql).toContain('deny_generation INTEGER NOT NULL DEFAULT -1');
    } else expect({ ...current.get(row.name) }, row.name).toEqual(row);
  }
  // Nothing new either: a 1.0.19 file is validated before this build could add an object, and a missing one is refused.
  expect([...current.keys()].filter(name => !SHIPPED.some(row => row.name === name))).toEqual([]);
});

it('the first start after the upgrade from 1.0.19 retires the pending table and nothing else: views, the epoch and proof rows stay, the storage charge is handed back', () => {
  let db = database();
  const current = schema(db);
  db.prepare("INSERT INTO memory_recall_views VALUES('v','g',0,1,'ready',0,'',0,0)").run();
  db.exec('UPDATE memory_recall_epoch SET epoch=epoch+1000 WHERE id=1');
  const epoch = Number(db.prepare('SELECT epoch FROM memory_recall_epoch WHERE id=1').get()!.epoch);
  shapeAs1019(db);
  // the file now holds exactly the 1.0.19 objects, in the shipped text
  expect(schema(db).map(row => ({ ...row }))).toEqual(SHIPPED);
  const before = bytes(db);
  // rows written by 1.0.19: each is charged 512 bytes by the shipped storage trigger
  for (let n = 1; n <= 3; n++) db.prepare("INSERT INTO memory_recall_view_pending VALUES('v','g',?,?,1)").run(n, `record-${n}`);
  expect(bytes(db)).toBe(before + 3 * 512);
  db.prepare(`INSERT INTO memory_session_checks(thread_id,driver_instance,native_session,reader_key,up_to,log_seq,recall_epoch,
    view_id,view_generation,view_digest,policy_revision,deletion_epoch,footprint,cites,seeding,checked)
    VALUES('thread-1019','engine','session','reader',0,0,0,NULL,NULL,NULL,1,0,'{"v":2,"s":[],"dg":0}',0,0,0)`).run();
  closeDatabase();
  db = database();
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE tbl_name='memory_recall_view_pending'").all()).toEqual([]);
  // byte for byte the schema a new file of this build has
  expect(schema(db)).toEqual(current);
  expect(bytes(db)).toBe(before);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_recall_views WHERE view_id='v' AND generation='g' AND state='ready'").get()!.n)).toBe(1);
  expect(Number(db.prepare('SELECT epoch FROM memory_recall_epoch WHERE id=1').get()!.epoch)).toBeGreaterThanOrEqual(epoch);
  expect({ ...db.prepare("SELECT footprint,deny_generation FROM memory_session_checks WHERE thread_id='thread-1019'").get() }).toEqual({ footprint: '{"v":2,"s":[],"dg":0}', deny_generation: -1 });
  // a second start finds nothing left to do
  closeDatabase();
  expect(schema(database())).toEqual(current);
});

it('a pending table that lost its index and triggers is not the 1.0.19 one: the start refuses it', async () => {
  database().exec(shipped('memory_recall_view_pending'));
  await refusedStart();
});

it('a pending table with any other text is not the 1.0.19 one: the start refuses it', async () => {
  const db = database();
  db.exec(shipped('memory_recall_view_pending').replace('version INTEGER NOT NULL,PRIMARY KEY', 'version INTEGER NOT NULL,extra INTEGER,PRIMARY KEY'));
  expect(String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='memory_recall_view_pending'").get()!.sql)).toContain('extra INTEGER');
  for (const name of PENDING.slice(1)) db.exec(shipped(name));
  await refusedStart();
});
