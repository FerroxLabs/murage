// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-s1s2g (durable proof). Consumer owners: recall-s1s2g (dispatch), warm-keep (continuation).
import { DatabaseSync } from '../sqlite-open.ts';
import { copyFieldsChanged } from '../message-copy-fields.ts';
import type { SessionKey } from './lineage-types.ts';

export const SESSION_LOG_KEEP = 262144;
export const SESSION_PROOF_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_session_checks (
 thread_id TEXT NOT NULL,driver_instance TEXT NOT NULL,native_session TEXT NOT NULL,reader_key TEXT NOT NULL,
 up_to INTEGER NOT NULL,log_seq INTEGER NOT NULL,recall_epoch INTEGER NOT NULL,
 view_id TEXT,view_generation TEXT,view_digest TEXT,policy_revision INTEGER NOT NULL,deletion_epoch INTEGER NOT NULL,
 footprint TEXT NOT NULL,cites INTEGER NOT NULL,seeding INTEGER NOT NULL DEFAULT 0,checked INTEGER NOT NULL,
 PRIMARY KEY(thread_id,driver_instance,native_session,reader_key)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS memory_session_checks_checked ON memory_session_checks(checked);
CREATE TABLE IF NOT EXISTS memory_session_check_cites (
 thread_id TEXT NOT NULL,driver_instance TEXT NOT NULL,native_session TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('record','source')),ref_id TEXT NOT NULL,ref_version INTEGER NOT NULL,bundle_id TEXT NOT NULL,
 PRIMARY KEY(thread_id,driver_instance,native_session,kind,ref_id,ref_version)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS memory_session_check_cites_ref ON memory_session_check_cites(kind,ref_id);
CREATE TABLE IF NOT EXISTS memory_session_state (
 thread_id TEXT NOT NULL,driver_instance TEXT NOT NULL,native_session TEXT NOT NULL,had_frame INTEGER NOT NULL,
 PRIMARY KEY(thread_id,driver_instance,native_session)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS memory_session_check_messages (
 thread_id TEXT NOT NULL,driver_instance TEXT NOT NULL,native_session TEXT NOT NULL,source_thread TEXT NOT NULL,message_id TEXT NOT NULL,
 PRIMARY KEY(thread_id,driver_instance,native_session,source_thread,message_id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS memory_session_change_log(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS memory_session_change_log_id ON memory_session_change_log(id,seq);
CREATE TRIGGER IF NOT EXISTS memory_session_proof_trim AFTER INSERT ON memory_session_change_log BEGIN
 DELETE FROM memory_session_change_log WHERE seq=NEW.seq-${SESSION_LOG_KEEP}; END;
CREATE TRIGGER IF NOT EXISTS memory_session_proof_source AFTER UPDATE ON memory_sources
 WHEN OLD.state IS NOT NEW.state OR OLD.revision IS NOT NEW.revision OR OLD.scope_id IS NOT NEW.scope_id
 BEGIN INSERT INTO memory_session_change_log(id) VALUES('source:'||OLD.id); END;
CREATE TRIGGER IF NOT EXISTS memory_session_proof_record AFTER UPDATE ON memory_records
 WHEN OLD.state IS NOT NEW.state OR OLD.scope_id IS NOT NEW.scope_id OR OLD.version IS NOT NEW.version
 BEGIN INSERT INTO memory_session_change_log(id) VALUES('record:'||OLD.id); END;
CREATE TRIGGER IF NOT EXISTS memory_session_proof_tombstone AFTER INSERT ON memory_tombstones
 WHEN NEW.target_type IN ('source','record')
 BEGIN INSERT INTO memory_session_change_log(id) VALUES(NEW.target_type||':'||NEW.target_id); END;
CREATE TRIGGER IF NOT EXISTS memory_session_proof_receipt AFTER UPDATE ON memory_disclosures
 WHEN OLD.state IS NOT NEW.state AND NEW.state='revoked'
 BEGIN INSERT INTO memory_session_change_log(id) VALUES('receipt:'||NEW.bundle_id); END;
CREATE TRIGGER IF NOT EXISTS memory_session_proof_receipt_bind AFTER UPDATE OF native_session ON memory_disclosures
 WHEN OLD.native_session IS NOT NEW.native_session AND EXISTS (
  SELECT 1 FROM memory_session_checks c WHERE c.thread_id=NEW.thread_id AND c.driver_instance=NEW.driver_instance
   AND c.native_session=NEW.native_session AND c.up_to>=NEW.rowid)
 BEGIN INSERT INTO memory_session_change_log(id) VALUES('receipt:'||NEW.bundle_id); END;
`;
const SESSION_PROOF_DENIALS = `
CREATE TRIGGER IF NOT EXISTS memory_session_proof_deny_insert AFTER INSERT ON memory_deny
 BEGIN INSERT INTO memory_session_change_log(id) VALUES('deny-'||NEW.kind||':'||NEW.id); END;
CREATE TRIGGER IF NOT EXISTS memory_session_proof_deny_update AFTER UPDATE ON memory_deny
 BEGIN INSERT INTO memory_session_change_log(id) VALUES('deny-'||NEW.kind||':'||NEW.id); END;
`;
// DESIGN-B5-PROOF F2 (MAIN Q4): every deny_generation move is logged, so a proof can show which generation its window reached.
const SESSION_PROOF_DENY_GENERATION = `
CREATE TRIGGER IF NOT EXISTS memory_session_proof_deny_generation AFTER UPDATE OF value ON memory_lineage_lsn_meta
 WHEN NEW.key='deny_generation' AND NEW.value IS NOT OLD.value
 BEGIN INSERT INTO memory_session_change_log(id) VALUES('deny-gen:'||NEW.value); END;
`;
export const SESSION_PROOF_MESSAGES = `
CREATE TRIGGER IF NOT EXISTS memory_session_proof_line_update AFTER UPDATE ON messages
 WHEN ${copyFieldsChanged('OLD.json','NEW.json')} AND CASE WHEN json_valid(OLD.json) AND json_valid(NEW.json)
 THEN json_extract(OLD.json,'$.copyOf') IS NOT json_extract(NEW.json,'$.copyOf') OR
 (json_extract(NEW.json,'$.withheldFromBots') IS NOT NULL AND json_extract(NEW.json,'$.withheldFromBots') NOT IN (0,'')) ELSE 1 END
 BEGIN INSERT INTO memory_session_change_log(id) VALUES('line:'||OLD.thread_id||char(0)||OLD.id); END;
CREATE TRIGGER IF NOT EXISTS memory_session_proof_line_delete AFTER DELETE ON messages
 BEGIN INSERT INTO memory_session_change_log(id) VALUES('line:'||OLD.thread_id||char(0)||OLD.id); END;
`;
const SESSION_PROOF_RECEIPT_LINE_INVALIDATION = `
CREATE TRIGGER IF NOT EXISTS memory_session_proof_receipt_line_insert AFTER INSERT ON memory_receipt_lines WHEN NEW.session_no IS NOT NULL BEGIN
 DELETE FROM memory_session_checks WHERE up_to=0 AND (thread_id,driver_instance,native_session) IN
 (SELECT thread_id,driver_instance,native_session FROM memory_session_no WHERE no=NEW.session_no); END;
CREATE TRIGGER IF NOT EXISTS memory_session_proof_receipt_line_update AFTER UPDATE OF session_no ON memory_receipt_lines WHEN NEW.session_no IS NOT NULL BEGIN
 DELETE FROM memory_session_checks WHERE up_to=0 AND (thread_id,driver_instance,native_session) IN
 (SELECT thread_id,driver_instance,native_session FROM memory_session_no WHERE no=NEW.session_no); END;
`;
const SESSION_PROOF_ROOT_INVALIDATION = `
CREATE TRIGGER IF NOT EXISTS memory_session_proof_root_insert AFTER INSERT ON memory_session_roots WHEN NEW.set_id!='' BEGIN
 DELETE FROM memory_session_checks WHERE up_to=0 AND thread_id=NEW.thread_id AND driver_instance=NEW.driver_instance AND native_session=NEW.native_session; END;
CREATE TRIGGER IF NOT EXISTS memory_session_proof_root_update AFTER UPDATE OF set_id ON memory_session_roots WHEN NEW.set_id!='' BEGIN
 DELETE FROM memory_session_checks WHERE up_to=0 AND thread_id=NEW.thread_id AND driver_instance=NEW.driver_instance AND native_session=NEW.native_session; END;
`;
const tables=['memory_session_checks','memory_session_check_cites','memory_session_change_log','memory_session_state','memory_session_check_messages'] as const;
export const SESSION_CHECKS_LEGACY_SQL = SESSION_PROOF_SCHEMA.split(';',1)[0]!.trim().replace(' IF NOT EXISTS','');
export function ensureSessionProofSchema(db: DatabaseSync): void {
 db.exec(SESSION_PROOF_SCHEMA);
 if(!db.prepare("SELECT 1 FROM pragma_table_info('memory_session_checks') WHERE name='deny_generation'").get())db.exec('ALTER TABLE memory_session_checks ADD COLUMN deny_generation INTEGER NOT NULL DEFAULT -1');
 if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_deny'").get())db.exec(SESSION_PROOF_DENIALS);
 if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_lineage_lsn_meta'").get())db.exec(SESSION_PROOF_DENY_GENERATION);
 // the receipt-line pair does not wait for memory_session_roots: a file the reclaim has handed back still needs it
 if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_receipt_lines'").get())db.exec(SESSION_PROOF_RECEIPT_LINE_INVALIDATION);
 if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_receipt_lines'").get()&&db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_session_roots'").get())db.exec(SESSION_PROOF_ROOT_INVALIDATION);
 if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='messages'").get())db.exec(SESSION_PROOF_MESSAGES);
}
export function dropSessionProofSchema(db: DatabaseSync): void {
 for(const row of sessionProofSchemaObjects().values())if(row.type==='trigger')db.exec(`DROP TRIGGER IF EXISTS ${row.name}`);
 for(const table of tables)db.exec(`DROP TABLE IF EXISTS ${table}`);
}
/** The triggers ensureSessionProofSchema makes only while the table they sit on (or read) exists, in the pairs that go together: a file that never had
 * the table, or whose table was handed back (root sets, root-set-reclaim.ts), holds the rest of the set and each pair is whole or absent. */
export function sessionProofOptionalGroups():string[][] {
 return [
  ['memory_session_proof_deny_insert','memory_session_proof_deny_update'],
  ['memory_session_proof_receipt_line_insert','memory_session_proof_receipt_line_update'],
  ['memory_session_proof_root_insert','memory_session_proof_root_update'],
  ['memory_session_proof_line_update','memory_session_proof_line_delete'],
 ];
}
let objects:Map<string,{type:string;name:string;tbl_name:string;sql:string|null}>|undefined;
export function sessionProofSchemaObjects() {
 if(objects)return objects;
 const db=new DatabaseSync(':memory:');
 try {
  db.exec('CREATE TABLE memory_sources(id,state,revision,scope_id);CREATE TABLE memory_records(id,state,version,scope_id);CREATE TABLE memory_tombstones(target_type,target_id);CREATE TABLE memory_disclosures(bundle_id,state);CREATE TABLE memory_deny(kind,id);CREATE TABLE memory_lineage_lsn_meta(key,value);CREATE TABLE messages(thread_id,id,json);CREATE TABLE memory_receipt_lines(bundle_id,session_no);CREATE TABLE memory_session_no(no,thread_id,driver_instance,native_session);CREATE TABLE memory_session_roots(thread_id,driver_instance,native_session,set_id);');
  ensureSessionProofSchema(db);
  objects=new Map((db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name LIKE 'memory_session_proof_%' OR tbl_name IN ('memory_session_checks','memory_session_check_cites','memory_session_change_log','memory_session_state','memory_session_check_messages')").all() as unknown as Array<{type:string;name:string;tbl_name:string;sql:string|null}>).map(row=>[row.name,row]));
  return objects;
 }finally{db.close();}
}
/** Session reset invalidates the checkpoint immediately. Dependent proof history is reclaimed off the turn path. */
export function deleteSessionChecks(db: DatabaseSync,key: SessionKey): void {
 db.prepare('DELETE FROM memory_session_checks WHERE thread_id=? AND driver_instance=? AND native_session=?').run(key.threadId,key.driverInstance,key.nativeSession);
}
const collectAfter=new WeakMap<DatabaseSync,string[]>();
const dependentAfter=new WeakMap<DatabaseSync,Map<string,Array<string|number>>>();
/** Scan a primary-key page before testing liveness: filtering orphans in SQL could walk all live history. */
function collectDependentSlice(db:DatabaseSync,table:string,columns:string[]):void {
 let cursors=dependentAfter.get(db);if(!cursors){cursors=new Map();dependentAfter.set(db,cursors);}
 const after=cursors.get(table)??columns.map(()=>''),key=columns.join(','),params=columns.map(()=>'?').join(',');
 const rows=db.prepare(`SELECT ${key} FROM ${table} WHERE (${key})>(${params}) ORDER BY ${key} LIMIT 128`).all(...after);
 const live=db.prepare('SELECT 1 FROM memory_session_checks WHERE thread_id=? AND driver_instance=? AND native_session=? LIMIT 1');
 const remove=db.prepare(`DELETE FROM ${table} WHERE (${key})=(${params})`);
 for(const row of rows)if(!live.get(row.thread_id,row.driver_instance,row.native_session))remove.run(...columns.map(column=>row[column]));
 const last=rows.at(-1);cursors.set(table,rows.length===128&&last?columns.map(column=>last[column] as string|number):columns.map(()=>''));
}
/** Fixed index pages for checkpoint expiry, missing sessions, and dependent proof reclamation. */
export function collectSessionChecksSlice(db: DatabaseSync, now=Date.now()): number {
 const rows=db.prepare(`SELECT thread_id,driver_instance,native_session FROM memory_session_checks
 WHERE checked<? ORDER BY checked LIMIT 128`).all(now-30*24*60*60*1000);
 for(const row of rows)deleteSessionChecks(db,{threadId:String(row.thread_id),driverInstance:String(row.driver_instance),nativeSession:String(row.native_session)});
 const after=collectAfter.get(db)??['','','',''];
 const scan=db.prepare(`SELECT thread_id,driver_instance,native_session,reader_key FROM memory_session_checks WHERE (thread_id,driver_instance,native_session,reader_key)>(?,?,?,?) ORDER BY thread_id,driver_instance,native_session,reader_key LIMIT 128`).all(...after);
 for(const row of scan)if(!db.prepare('SELECT 1 FROM memory_session_lineage WHERE thread_id=? AND driver_instance=? AND native_session=?').get(row.thread_id,row.driver_instance,row.native_session))deleteSessionChecks(db,{threadId:String(row.thread_id),driverInstance:String(row.driver_instance),nativeSession:String(row.native_session)});
 const last=scan.at(-1);collectAfter.set(db,last?[String(last.thread_id),String(last.driver_instance),String(last.native_session),String(last.reader_key)]:['','','','']);
 collectDependentSlice(db,'memory_session_check_cites',['thread_id','driver_instance','native_session','kind','ref_id','ref_version']);
 collectDependentSlice(db,'memory_session_check_messages',['thread_id','driver_instance','native_session','source_thread','message_id']);
 return rows.length;
}

/** Missing state is unknown after restart, never inferred from receipt absence. */
export function sessionHadFrame(db: DatabaseSync,key:SessionKey):boolean|undefined {
 const row=db.prepare('SELECT had_frame FROM memory_session_state WHERE thread_id=? AND driver_instance=? AND native_session=?').get(key.threadId,key.driverInstance,key.nativeSession);
 return row?Number(row.had_frame)!==0:undefined;
}
export function noteSessionFrame(db:DatabaseSync,key:SessionKey,shown:boolean):void {
 if(shown)db.prepare('DELETE FROM memory_session_checks WHERE thread_id=? AND driver_instance=? AND native_session=? AND up_to=0').run(key.threadId,key.driverInstance,key.nativeSession);
 db.prepare(`INSERT INTO memory_session_state VALUES(?,?,?,?) ON CONFLICT(thread_id,driver_instance,native_session) DO UPDATE SET had_frame=max(had_frame,excluded.had_frame)`)
 .run(key.threadId,key.driverInstance,key.nativeSession,shown?1:0);
}
