// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-s1s2g (durable proof). Consumer owners: recall-s1s2g (dispatch), warm-keep (continuation).
import { closeSync, openSync, readSync, statSync } from 'node:fs';
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
// A 1.0.20 candidate build added this column; 1.0.19 refuses the table with it (MEMORY_SCHEMA_UNSUPPORTED, then its restore page). The
// generation a check was proven at is the footprint envelope's dg, so the column carried nothing else. validateMemorySchema accepts the
// candidate's exact text only, and ensureSessionProofSchema hands the column back, leaving the 1.0.19 table.
export const SESSION_CHECKS_CANDIDATE_COLUMN = 'deny_generation INTEGER NOT NULL DEFAULT -1';
let candidateSql: string | undefined;
export function sessionChecksCandidateSql(): string {
 if(candidateSql!==undefined)return candidateSql;
 const db=new DatabaseSync(':memory:');
 try {
  db.exec(SESSION_PROOF_SCHEMA.split(';',1)[0]!);
  db.exec(`ALTER TABLE memory_session_checks ADD COLUMN ${SESSION_CHECKS_CANDIDATE_COLUMN}`);
  return candidateSql=String((db.prepare("SELECT sql FROM sqlite_schema WHERE name='memory_session_checks'").get() as {sql:string}).sql);
 } finally { db.close(); }
}
export function ensureSessionProofSchema(db: DatabaseSync): void {
 db.exec(SESSION_PROOF_SCHEMA);
 if(db.prepare("SELECT 1 FROM pragma_table_info('memory_session_checks') WHERE name='deny_generation'").get())db.exec('ALTER TABLE memory_session_checks DROP COLUMN deny_generation');
 if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_deny'").get())db.exec(SESSION_PROOF_DENIALS);
 if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_lineage_lsn_meta'").get())db.exec(SESSION_PROOF_DENY_GENERATION);
 // the receipt-line pair does not wait for memory_session_roots: a file the reclaim has handed back still needs it
 if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_receipt_lines'").get())db.exec(SESSION_PROOF_RECEIPT_LINE_INVALIDATION);
 if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_receipt_lines'").get()&&db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_session_roots'").get())db.exec(SESSION_PROOF_ROOT_INVALIDATION);
 if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='messages'").get())db.exec(SESSION_PROOF_MESSAGES);
}
export function dropSessionProofSchema(db: DatabaseSync): void {
 collectors.delete(db); // the TEMP guards go with the tables: the connection starts over
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
/** Memory V2 4.7 (lane H). The collector does work only when something changed: TEMP triggers on this connection count the writes that can
 * create work (a registered function, no SQL), so a tick over an unchanged table is a few comparisons and issues no statement. The only
 * persisted thing is the marker row of the one lineage lap. A connection without the guards (a worker, an older build) never caches. */
const SESSION_LAP_BUILD = 1;
const SESSION_LAP_MARKER = 'memory-v2:session-orphans';
const lapApp=()=>process.env.MURAGE_APP_VERSION??'';
const SESSION_EXPIRY_MS = 30*24*60*60*1000;
const PAGE = 128;
const DRAIN = 16;
const RECHECK_MS = 30_000;
type GoneKey = {t:string;d:string;n:string};
/** One pass over the distinct sessions of the cites table (0), then of the messages table (1). Memory only. */
/** `borrowed`: a window of this cycle ran inside a caller's transaction, which may still roll back what the window saw. */
export type OrphanCycle = {table: 0|1; after: [string,string,string]; gen0: number; ver0: number|undefined; guarded: boolean; found: number; borrowed: boolean};
export type SessionCollector = {
 guards: boolean; retryAt: number; degradedAt: number;
 checksWrites: number; seedInputs: number; gone: Map<string,GoneKey>;
 /** How many ended sessions the queue holds before a key is dropped (the cycle finds it again). A test may lower it on its own connection. */
 goneCap: number;
 expirySeen: number; expiryDue: number;
 lap: {done: boolean; known: boolean; at: number; after: string[]};
 /** `done` is a cache of "a whole cycle saw no orphan and nothing was deleted anywhere meanwhile". It is never persisted and never read
  * from anywhere else; every checkpoint deletion path clears it. `at` paces the next cycle after one that found nothing. */
 orphans: {done: boolean; doneVer: number; doneGen: number; cycle: OrphanCycle|undefined; at: number};
 /** Deletion generation of this connection: moves with every clear. */
 dgen: number;
 /** While `done`: when the next look at another connection's commits is due (one read of data_version). */
 foreignDueAt: number;
 /** The database files as they were when data_version was last read (commitSign): while it is unchanged no connection has committed,
  * so no statement is needed; when it moves the next slice reads data_version on this connection. */
 sign: string;
 /** Lane W's foreign-commit wake calls this: another connection committed, so the cache is compared with data_version now. */
 foreignCommit: () => void;
 /** While `done`: some connection may have committed (the files' commit sign moved; no statement). The upkeep's session rider runs then. */
 commitMoved: () => boolean;
 seed: {cleanKey: string|undefined; cleanAt: number; holdUntil: number; holdAt: number; holdKey: string; misses: number};
};
const collectors=new WeakMap<DatabaseSync,SessionCollector>();
/** The CLEAR: a check may have been deleted, so the cache is void and the next slice starts (or, mid-cycle, repeats) the orphan cycle. */
function clearOrphansDone(st: SessionCollector): void { st.dgen++;st.orphans.done=false;st.orphans.at=0; }
let installFault={left:0,stage:0};
/** Test seam: the next `count` guard installs throw at `stage` (0 before the function is registered, 1 before the triggers, 2 after them).
 * It injects a failure only. */
export function setSessionCollectorInstallFaultForTest(count: number, stage: 0|1|2 = 0): void { installFault={left:count,stage}; }
function installFaultAt(stage: number): void {
 if(installFault.left>0&&installFault.stage===stage){installFault.left--;throw new Error('session collector guard install fault');}
}
/** Installs the per-connection guards once, outside any transaction (a rolled-back install would leave the flag set with no trigger).
 * A check deleted before the guards were live was seen by nobody, so a successful install runs the CLEAR. */
function installCollectorGuards(db: DatabaseSync, st: SessionCollector, now: number): void {
 if(st.guards||db.isTransaction||now<st.retryAt)return;
 try {
  installFaultAt(0);
  db.function('mem_h_touch',{varargs:true},(kind:unknown,t:unknown,d:unknown,n:unknown)=>{
   if(kind===1||kind===3)st.checksWrites++;
   if(kind===2||kind===3)st.seedInputs++;
   // a full queue drops the key: the CLEAR makes the cycle find it again
   if(kind===3){clearOrphansDone(st);if(st.gone.size<st.goneCap)st.gone.set(`${t}\0${d}\0${n}`,{t:String(t),d:String(d),n:String(n)});}
   // integrator spec-cand-1021-r9 (W-SESSION-WRITE): a cite or message row written on this connection for a session that has no check is an
   // orphan the cached-done cycle would never look at again; it is queued like an ended session (S1 tests liveness again at its delete, so
   // a proof that writes its rows before its check keeps them); a full queue voids the cache instead
   if(kind===4){if(st.gone.size<st.goneCap)st.gone.set(`${t}\0${d}\0${n}`,{t:String(t),d:String(d),n:String(n)});else clearOrphansDone(st);}
   return 0;
  });
  installFaultAt(1);
  db.exec(`
CREATE TEMP TRIGGER IF NOT EXISTS mem_h_checks_insert AFTER INSERT ON main.memory_session_checks BEGIN SELECT mem_h_touch(1); SELECT mem_h_touch(2); END;
CREATE TEMP TRIGGER IF NOT EXISTS mem_h_checks_update AFTER UPDATE ON main.memory_session_checks BEGIN SELECT mem_h_touch(1); SELECT mem_h_touch(2); END;
CREATE TEMP TRIGGER IF NOT EXISTS mem_h_checks_delete AFTER DELETE ON main.memory_session_checks BEGIN SELECT mem_h_touch(3,OLD.thread_id,OLD.driver_instance,OLD.native_session); END;`);
  // a dependent row whose session has no check, written on this connection (TEMP, like the three above; another connection's is seen
  // through the commit sign and data_version). One statement: all four or none. An UPDATE matters only when it moves the session key.
  db.exec(RECOVER_TABLES.flatMap(table=>['INSERT','UPDATE OF thread_id,driver_instance,native_session'].map(event=>`
CREATE TEMP TRIGGER IF NOT EXISTS mem_h_${table.slice('memory_session_check_'.length)}_${event.split(' ')[0].toLowerCase()} AFTER ${event} ON main.${table}
 WHEN NOT EXISTS(SELECT 1 FROM main.memory_session_checks x WHERE x.thread_id=NEW.thread_id AND x.driver_instance=NEW.driver_instance AND x.native_session=NEW.native_session)
 BEGIN SELECT mem_h_touch(4,NEW.thread_id,NEW.driver_instance,NEW.native_session); END;`)).join(''));
  // seed inputs: a receipt or a session that was not there before
  if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_disclosures'").get())db.exec(`
CREATE TEMP TRIGGER IF NOT EXISTS mem_h_disclosure_insert AFTER INSERT ON main.memory_disclosures BEGIN SELECT mem_h_touch(2); END;
CREATE TEMP TRIGGER IF NOT EXISTS mem_h_disclosure_update AFTER UPDATE ON main.memory_disclosures BEGIN SELECT mem_h_touch(2); END;`);
  if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_session_lineage'").get())db.exec(`
CREATE TEMP TRIGGER IF NOT EXISTS mem_h_lineage_insert AFTER INSERT ON main.memory_session_lineage BEGIN SELECT mem_h_touch(2); END;`);
  installFaultAt(2);
  st.guards=true;
  clearOrphansDone(st);
 } catch { st.retryAt=now+RECHECK_MS; }
}
/** The PRAGMA statement on this connection, never the pragma_data_version table function in any form: a table or view of that name (TEMP, or
 * persisted in main by any connection) answers for the bare and for the main-qualified function, and one without the column fails to prepare. */
function dataVersion(db: DatabaseSync): number {
 return Number(db.prepare('PRAGMA data_version').get()!.data_version);
}
/** D7: a commit by another connection may have been a checkpoint delete. data_version moves only for other connections' commits. */
function foreignCheck(db: DatabaseSync, st: SessionCollector, now: number): void {
 st.foreignDueAt=now+RECHECK_MS;
 st.sign=commitSign(db); // before the read: a commit after it moves the sign again
 if(dataVersion(db)!==st.orphans.doneVer)clearOrphansDone(st);
}
/** integrator spec-cand-1021-r9 (W-SESSION-FOREIGN): what a commit by any connection changes in the files, read without a statement: the
 * WAL index header (its change counter moves on every commit), the -wal file and the database file (size, mtime). A slice whose sign moved
 * reads data_version (one PRAGMA statement), so another connection's delete is seen on the next slice, not 30 s later. Unreadable files
 * give a fixed sign: the 30 s look stays the fallback. Our own commits move it too; they cost that one read, then it is quiet again. */
const SHM_HEADER = Buffer.alloc(48);
function commitSign(db: DatabaseSync): string {
 let file: string|null|undefined;
 try { file=(db as unknown as {location(): string|null}).location(); } catch { return 'closed'; }
 if(!file)return 'memory';
 let sign='';
 try {
  const fd=openSync(`${file}-shm`,'r');
  try { const n=readSync(fd,SHM_HEADER,0,48,0); sign+=SHM_HEADER.toString('hex',0,n); } finally { closeSync(fd); }
 } catch { sign+='-'; }
 for(const name of [`${file}-wal`,file]) {
  try { const st=statSync(name,{bigint:true,throwIfNoEntry:false}); sign+=st?`|${st.ino}:${st.size}:${st.mtimeNs}`:'|-'; } catch { sign+='|?'; }
 }
 return sign;
}
/** The collector state of one connection. Without guards every 30 s counts as a change: the old behaviour at a thirtieth of the rate. */
export function sessionCollector(db: DatabaseSync, now=Date.now()): SessionCollector {
 let st=collectors.get(db);
 if(!st) {
  const made: SessionCollector={guards:false,retryAt:0,degradedAt:0,checksWrites:0,seedInputs:0,gone:new Map(),goneCap:4096,expirySeen:-1,expiryDue:0,
   lap:{done:false,known:false,at:0,after:[]},orphans:{done:false,doneVer:-1,doneGen:-1,cycle:undefined,at:0},dgen:0,foreignDueAt:0,sign:'',
   foreignCommit:()=>{if(made.orphans.done)foreignCheck(db,made,Date.now());},
   commitMoved:()=>made.orphans.done&&commitSign(db)!==made.sign,
   seed:{cleanKey:undefined,cleanAt:-1,holdUntil:0,holdAt:-1,holdKey:'',misses:0}};
  st=made;collectors.set(db,st);
 }
 installCollectorGuards(db,st,now);
 if(!st.guards&&now>=st.degradedAt){st.degradedAt=now+RECHECK_MS;st.checksWrites++;st.seedInputs++;}
 return st;
}
/** Session reset invalidates the checkpoint immediately. Dependent proof history is reclaimed off the turn path. */
export function deleteSessionChecks(db: DatabaseSync,key: SessionKey): void {
 clearOrphansDone(sessionCollector(db)); // before the delete, guards or not
 db.prepare('DELETE FROM memory_session_checks WHERE thread_id=? AND driver_instance=? AND native_session=?').run(key.threadId,key.driverInstance,key.nativeSession);
}
function sessionKeyArgs(row:{thread_id?:unknown;driver_instance?:unknown;native_session?:unknown}): SessionKey {
 return {threadId:String(row.thread_id),driverInstance:String(row.driver_instance),nativeSession:String(row.native_session)};
}
const DEPENDENTS=[['memory_session_check_cites','kind,ref_id,ref_version'],['memory_session_check_messages','source_thread,message_id']] as const;
/** S1: cites and messages of a session that no longer has a check, one bounded page of each. The liveness test is part of each DELETE, so a
 * check another connection commits in between keeps its rows. True when a page was full (more may remain). */
function clearDependents(db: DatabaseSync, k: GoneKey): boolean {
 let more=false;
 for(const [table,cols] of DEPENDENTS) {
  const r=db.prepare(`DELETE FROM ${table} WHERE (thread_id,driver_instance,native_session,${cols}) IN
   (SELECT thread_id,driver_instance,native_session,${cols} FROM ${table} WHERE thread_id=?1 AND driver_instance=?2 AND native_session=?3 LIMIT ${PAGE})
   AND NOT EXISTS(SELECT 1 FROM memory_session_checks WHERE thread_id=?1 AND driver_instance=?2 AND native_session=?3)`).run(k.t,k.d,k.n);
  if(Number(r.changes)>=PAGE)more=true;
 }
 return more;
}
/** The orphan query: a skip-scan over the distinct sessions of one dependent table after a cursor, one primary-key seek into the checks
 * for each, never a session's rows. At most ?4 sessions. It reads no data_version: orphanWindow reads it by the PRAGMA statement. */
export function orphanQuerySql(table: 'memory_session_check_cites'|'memory_session_check_messages'): string {
 return `WITH RECURSIVE s(k,i) AS (
 SELECT (SELECT json_array(thread_id,driver_instance,native_session) FROM ${table}
         WHERE (thread_id,driver_instance,native_session)>(?1,?2,?3)
         ORDER BY thread_id,driver_instance,native_session LIMIT 1),1
 UNION ALL
 SELECT (SELECT json_array(c.thread_id,c.driver_instance,c.native_session) FROM ${table} c
         WHERE (c.thread_id,c.driver_instance,c.native_session)>(s.k->>0,s.k->>1,s.k->>2)
         ORDER BY c.thread_id,c.driver_instance,c.native_session LIMIT 1),i+1
 FROM s WHERE s.k IS NOT NULL AND i<?4)
SELECT i,k->>0 AS t,k->>1 AS d,k->>2 AS n,
 NOT EXISTS(SELECT 1 FROM memory_session_checks x WHERE x.thread_id=k->>0 AND x.driver_instance=k->>1 AND x.native_session=k->>2) AS orphan
FROM s WHERE k IS NOT NULL`;
}
const RECOVER_TABLES=['memory_session_check_cites','memory_session_check_messages'] as const;
/** One window of the orphan cycle. An orphan is a cite or message row whose session has no check: that is decided by the rows alone, never
 * by the lap marker, the guards or a flag. Orphan sessions go to the S1 queue. A cycle is never restarted mid-way: a delete or a foreign
 * commit during it only means its end can not be cached. `done` is set only inside the collector's own transaction around the last window,
 * when that window and the whole cycle found nothing, no other connection committed (ver), this one deleted nothing (dgen), the guards
 * were live throughout (so dgen saw every delete) and no window ran inside a caller's transaction (a rollback moves neither fence). */
function orphanWindow(db: DatabaseSync, st: SessionCollector, now: number): void {
 const o=st.orphans;
 const c=o.cycle??={table:0,after:['','',''],gen0:st.dgen,ver0:undefined,guarded:st.guards,found:0,borrowed:false};
 if(db.isTransaction)c.borrowed=true;
 const own=c.table===1&&!db.isTransaction;
 if(own)db.exec('BEGIN');
 try {
  type Row={i:number;t:string|null;d:string|null;n:string|null;orphan:number};
  // The version first, on this connection: in the collector's own transaction this PRAGMA opens the read snapshot the window then reads,
  // so the two are the same; anywhere else it is read before the window's snapshot, never after it, so a commit in between can only make
  // the cycle's end look changed (never cached), not hide what it deleted.
  const sign=commitSign(db);
  const ver=dataVersion(db);
  const sessions=(db.prepare(orphanQuerySql(RECOVER_TABLES[c.table])).all(...c.after,PAGE) as Row[]).sort((a,b)=>Number(a.i)-Number(b.i));
  if(c.ver0===undefined)c.ver0=ver;
  let found=0;
  for(const row of sessions) {
   if(!Number(row.orphan))continue;
   found++;
   const k={t:String(row.t),d:String(row.d),n:String(row.n)};
   if(st.gone.size<st.goneCap)st.gone.set(`${k.t}\0${k.d}\0${k.n}`,k);
  }
  c.found+=found;
  const last=sessions.at(-1);
  if(last)c.after=[String(last.t),String(last.d),String(last.n)];
  if(sessions.length<PAGE) {
   if(c.table===0){c.table=1;c.after=['','',''];}
   else {
    o.cycle=undefined;
    const quiet=c.found===0&&st.dgen===c.gen0&&st.gone.size===0&&!c.borrowed;
    if(own&&quiet&&ver===c.ver0&&st.guards&&c.guarded){o.done=true;o.doneVer=ver;o.doneGen=st.dgen;st.foreignDueAt=now+RECHECK_MS;st.sign=sign;}
    // nothing found and nothing deleted here: only a foreign commit or missing guards keep the cache open; each is looked at again in 30 s
    else if(own&&quiet)o.at=now+RECHECK_MS;
   }
  }
 } catch(error) { if(own){try{db.exec('ROLLBACK');}catch{/* the first error is the one to report */}} throw error; }
 if(own) {
  try{db.exec('COMMIT');}
  catch(error){o.done=false;try{db.exec('ROLLBACK');}catch{/* as above */} throw error;}
 }
}
function lapMarkerRead(db: DatabaseSync): boolean {
 try {
  if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_scope_bindings'").get())return false;
  const row=db.prepare('SELECT intent FROM memory_scope_bindings WHERE id=?').get(SESSION_LAP_MARKER);
  const intent=row?JSON.parse(String(row.intent)):undefined;
  return !!intent&&Number(intent.build)>=SESSION_LAP_BUILD&&intent.app===lapApp();
 } catch { return false; }
}
function lapMarkerWrite(db: DatabaseSync): void {
 try {
  if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_scope_bindings'").get())return;
  const scope=db.prepare('SELECT id FROM memory_scopes LIMIT 1').get()?.id;
  if(scope)db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','session-orphan-lap',0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent")
   .run(SESSION_LAP_MARKER,scope,JSON.stringify({build:SESSION_LAP_BUILD,app:lapApp()}));
 } catch { /* the lap runs again next start; it only ends checks that have no lineage */ }
}
/** S3: one paced lap per app version over the checks, ending those without a lineage. A step is one page, one second apart. Their rows are
 * the orphan cycle's work (deleteSessionChecks runs the CLEAR); the marker says nothing about orphans. */
function lapStep(db: DatabaseSync, st: SessionCollector, now: number): void {
 const lap=st.lap;
 if(lap.done||now<lap.at)return;
 lap.at=now+1000;
 const scan=db.prepare(`SELECT thread_id,driver_instance,native_session,reader_key FROM memory_session_checks WHERE (thread_id,driver_instance,native_session,reader_key)>(?,?,?,?) ORDER BY thread_id,driver_instance,native_session,reader_key LIMIT ${PAGE}`).all(...(lap.after.length?lap.after:['','','','']));
 for(const row of scan)if(!db.prepare('SELECT 1 FROM memory_session_lineage WHERE thread_id=? AND driver_instance=? AND native_session=?').get(row.thread_id,row.driver_instance,row.native_session))deleteSessionChecks(db,sessionKeyArgs(row));
 const last=scan.at(-1);
 if(scan.length===PAGE&&last){lap.after=[String(last.thread_id),String(last.driver_instance),String(last.native_session),String(last.reader_key)];return;}
 lap.after=[];lap.done=true;
 lapMarkerWrite(db);
}
function expiryDueAt(db: DatabaseSync): number {
 const min=db.prepare('SELECT min(checked) AS m FROM memory_session_checks').get()?.m;
 return min==null?Infinity:Number(min)+SESSION_EXPIRY_MS;
}
/** Checkpoint expiry (S2), the dependents of a deleted check (S1), the orphan cycle that finds what S1 never heard of (a kill, a delete
 * without guards or by another connection) and the one lineage lap (S3). A tick over an unchanged guarded connection issues no statement,
 * except one read of data_version every 30 s until lane W's foreign-commit wake replaces it. Each call is bounded: one expiry page, 16
 * queued sessions, one window of 128 sessions, one lap page. Returns the number of expired checkpoints. */
export function collectSessionChecksSlice(db: DatabaseSync, now=Date.now()): number {
 const st=sessionCollector(db,now);
 let removed=0;
 if(st.orphans.done&&(now>=st.foreignDueAt||st.checksWrites!==st.expirySeen||now>=st.expiryDue||st.gone.size>0||(!st.lap.done&&now>=st.lap.at)||commitSign(db)!==st.sign))foreignCheck(db,st,now);
 if(st.checksWrites!==st.expirySeen)st.expiryDue=expiryDueAt(db);
 if(now>=st.expiryDue) {
  const rows=db.prepare(`SELECT thread_id,driver_instance,native_session FROM memory_session_checks WHERE checked<? ORDER BY checked LIMIT ${PAGE}`).all(now-SESSION_EXPIRY_MS);
  for(const row of rows)deleteSessionChecks(db,sessionKeyArgs(row));
  removed=rows.length;
  st.expiryDue=removed===PAGE?now:expiryDueAt(db);
 }
 st.expirySeen=st.checksWrites;
 // a bounded handful of ended sessions per slice; a key leaves the queue only when both of its statements ran, and one with more rows than a
 // page goes to the back
 const batch: Array<[string,GoneKey]>=[];
 for(const entry of st.gone){batch.push(entry);if(batch.length>=DRAIN)break;}
 for(const [key,k] of batch) {
  let more: boolean;
  try{more=clearDependents(db,k);}catch(error){clearOrphansDone(st);throw error;}
  st.gone.delete(key);
  if(more)st.gone.set(key,k);
 }
 // rows cleared inside a caller's transaction come back if it rolls back, and their key has left the queue: the cycle looks again
 if(batch.length&&db.isTransaction)clearOrphansDone(st);
 if(!st.orphans.done&&now>=st.orphans.at)orphanWindow(db,st,now);
 if(!st.lap.known){st.lap.known=true;st.lap.done=lapMarkerRead(db);}
 lapStep(db,st,now);
 st.expirySeen=st.checksWrites;
 return removed;
}

/** Missing state is unknown after restart, never inferred from receipt absence. */
export function sessionHadFrame(db: DatabaseSync,key:SessionKey):boolean|undefined {
 const row=db.prepare('SELECT had_frame FROM memory_session_state WHERE thread_id=? AND driver_instance=? AND native_session=?').get(key.threadId,key.driverInstance,key.nativeSession);
 return row?Number(row.had_frame)!==0:undefined;
}
export function noteSessionFrame(db:DatabaseSync,key:SessionKey,shown:boolean):void {
 const st=sessionCollector(db);
 // a frame is shown on most turns and rarely ends a check: the CLEAR runs when the delete removed one (with guards the trigger ran it already)
 if(shown&&Number(db.prepare('DELETE FROM memory_session_checks WHERE thread_id=? AND driver_instance=? AND native_session=? AND up_to=0').run(key.threadId,key.driverInstance,key.nativeSession).changes)>0)clearOrphansDone(st);
 db.prepare(`INSERT INTO memory_session_state VALUES(?,?,?,?) ON CONFLICT(thread_id,driver_instance,native_session) DO UPDATE SET had_frame=max(had_frame,excluded.had_frame)`)
 .run(key.threadId,key.driverInstance,key.nativeSession,shown?1:0);
}
