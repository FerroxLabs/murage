// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer: store-patchbot owns structural roster revisions. Consumer: recall-scope owns this durable fence and derived views.
import { DatabaseSync } from '../sqlite-open.ts';
import { onWakeInstall, raise, wakeInstalled } from './wake.ts';

/** Derived data only. The original scopes, evidence and grants remain authority. */
// The storage charge of one derived table: every row costs 512 bytes (a term row also its term), counted in memory_recall_storage.
function storageTriggers(table:string):string {
 const cost=(row:string)=>table==='memory_recall_view_terms'?`(512+4*length(CAST(${row}.term AS BLOB)))`: '512';
 return `CREATE TRIGGER IF NOT EXISTS ${table}_storage_i BEFORE INSERT ON ${table} BEGIN
 SELECT CASE WHEN (SELECT bytes FROM memory_recall_storage WHERE id=1)+${cost('NEW')}>536870912 THEN RAISE(ABORT,'MEMORY_RECALL_STORAGE_LIMIT') END;
 UPDATE memory_recall_storage SET bytes=bytes+${cost('NEW')} WHERE id=1; END;
 CREATE TRIGGER IF NOT EXISTS ${table}_storage_d AFTER DELETE ON ${table} BEGIN UPDATE memory_recall_storage SET bytes=bytes-${cost('OLD')} WHERE id=1; END;`;
}
export const RECALL_VIEW_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_recall_epoch(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL,projection_floor INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO memory_recall_epoch(id,epoch) VALUES(1,0);
CREATE TABLE IF NOT EXISTS memory_recall_roster_proof(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL,hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory_recall_thread_readers(view_id TEXT NOT NULL,generation TEXT NOT NULL,eligible INTEGER NOT NULL,PRIMARY KEY(view_id,generation)) WITHOUT ROWID;
${['INSERT','UPDATE','DELETE'].map(event=>{
 const rows=event==='UPDATE'?['OLD','NEW']:[event==='DELETE'?'OLD':'NEW'];
 return `CREATE TRIGGER IF NOT EXISTS memory_recall_roster_proof_${event.toLowerCase()} AFTER ${event} ON memory_scope_bindings WHEN ${rows.map(row=>`${row}.id='memory-roster-policy'`).join(' OR ')} BEGIN DELETE FROM memory_recall_roster_proof; END;`;
}).join('\n')}
CREATE TABLE IF NOT EXISTS memory_recall_views(view_id TEXT NOT NULL,generation TEXT NOT NULL,authority_epoch INTEGER NOT NULL,roster_revision INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('building','ready')),scope_count INTEGER NOT NULL,digest TEXT NOT NULL,room_reader INTEGER NOT NULL,watermark INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(view_id,generation)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS memory_recall_contexts(context_key TEXT PRIMARY KEY,view_id TEXT NOT NULL,generation TEXT NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS memory_recall_context_view ON memory_recall_contexts(view_id,generation);
CREATE TABLE IF NOT EXISTS memory_recall_view_scopes(view_id TEXT NOT NULL,generation TEXT NOT NULL,scope_id TEXT NOT NULL,lineage_only INTEGER NOT NULL DEFAULT 0,person_scope INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(view_id,generation,scope_id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS memory_recall_scopes_reverse ON memory_recall_view_scopes(scope_id,view_id,generation);
CREATE TABLE IF NOT EXISTS memory_recall_view_records(view_id TEXT NOT NULL,generation TEXT NOT NULL,record_id TEXT NOT NULL,version INTEGER NOT NULL,sequence INTEGER NOT NULL,kind TEXT NOT NULL,pinned INTEGER NOT NULL,state TEXT NOT NULL,scope_id TEXT NOT NULL,PRIMARY KEY(view_id,generation,record_id,version)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS memory_recall_records_recent ON memory_recall_view_records(view_id,generation,sequence DESC,record_id,version);
CREATE INDEX IF NOT EXISTS memory_recall_records_pins ON memory_recall_view_records(view_id,generation,pinned,state,record_id,version);
CREATE INDEX IF NOT EXISTS memory_recall_records_kind ON memory_recall_view_records(view_id,generation,kind,record_id,version);
CREATE TABLE IF NOT EXISTS memory_recall_view_terms(view_id TEXT NOT NULL,generation TEXT NOT NULL,term TEXT NOT NULL,sequence INTEGER NOT NULL,record_id TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(view_id,generation,term,sequence,record_id,version)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS memory_recall_terms_record ON memory_recall_view_terms(view_id,generation,record_id,version,term);
CREATE INDEX IF NOT EXISTS memory_recall_terms_source ON memory_recall_view_terms(record_id,version,view_id,generation,term,sequence);
CREATE TABLE IF NOT EXISTS memory_recall_view_pending(view_id TEXT NOT NULL,generation TEXT NOT NULL,sequence INTEGER NOT NULL,record_id TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(view_id,generation,sequence,record_id,version)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS memory_recall_pending_record ON memory_recall_view_pending(view_id,generation,record_id,version);
CREATE TABLE IF NOT EXISTS memory_recall_view_jobs(view_id TEXT NOT NULL,generation TEXT NOT NULL,sequence INTEGER NOT NULL,job_id TEXT NOT NULL,PRIMARY KEY(view_id,generation,sequence,job_id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS memory_recall_jobs_id ON memory_recall_view_jobs(view_id,generation,job_id);
CREATE TABLE IF NOT EXISTS memory_recall_contains(view_id TEXT NOT NULL,generation TEXT NOT NULL,prior_view_id TEXT NOT NULL,prior_generation TEXT NOT NULL,PRIMARY KEY(view_id,generation,prior_view_id,prior_generation)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS memory_recall_excluded(thread_id TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS memory_recall_changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,object_id TEXT NOT NULL,version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memory_recall_change_cover(id INTEGER PRIMARY KEY CHECK(id=1),sequence INTEGER NOT NULL,lo_id TEXT NOT NULL,lo_version INTEGER NOT NULL,hi_id TEXT NOT NULL,hi_version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memory_recall_storage(id INTEGER PRIMARY KEY CHECK(id=1),bytes INTEGER NOT NULL CHECK(bytes>=0));
INSERT OR IGNORE INTO memory_recall_storage VALUES(1,0);
CREATE TRIGGER IF NOT EXISTS memory_recall_change_trim AFTER INSERT ON memory_recall_changes BEGIN
 UPDATE memory_recall_epoch SET projection_floor=max(projection_floor,NEW.sequence-1000000) WHERE id=1;
 DELETE FROM memory_recall_changes WHERE sequence=NEW.sequence-1000000; END;
${['memory_recall_view_scopes','memory_recall_view_records','memory_recall_view_terms','memory_recall_view_pending','memory_recall_view_jobs','memory_recall_contains'].map(storageTriggers).join('\n')}
CREATE TRIGGER IF NOT EXISTS memory_recall_record_i AFTER INSERT ON memory_records BEGIN INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('record',NEW.id,NEW.version); END;
CREATE TRIGGER IF NOT EXISTS memory_recall_record_u AFTER UPDATE ON memory_records BEGIN INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('record',OLD.id,OLD.version); INSERT INTO memory_recall_changes(kind,object_id,version) SELECT 'record',NEW.id,NEW.version WHERE NEW.id IS NOT OLD.id OR NEW.version IS NOT OLD.version; END;
CREATE TRIGGER IF NOT EXISTS memory_recall_record_d AFTER DELETE ON memory_records BEGIN INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('record',OLD.id,OLD.version); END;
CREATE TRIGGER IF NOT EXISTS memory_recall_job_i AFTER INSERT ON memory_jobs BEGIN INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('job',NEW.id,0); END;
CREATE TRIGGER IF NOT EXISTS memory_recall_job_u AFTER UPDATE ON memory_jobs BEGIN INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('job',NEW.id,0); END;
CREATE TRIGGER IF NOT EXISTS memory_recall_job_d AFTER DELETE ON memory_jobs BEGIN INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('job',OLD.id,0); END;
CREATE TRIGGER IF NOT EXISTS memory_recall_projection_i AFTER INSERT ON memory_projection_receipts BEGIN INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('record',NEW.record_id,NEW.record_version); END;
CREATE TRIGGER IF NOT EXISTS memory_recall_projection_u AFTER UPDATE OF record_id,record_version,lexical_status ON memory_projection_receipts WHEN OLD.record_id IS NOT NEW.record_id OR OLD.record_version IS NOT NEW.record_version OR OLD.lexical_status IS NOT NEW.lexical_status AND NOT EXISTS(SELECT 1 FROM memory_recall_change_cover c WHERE c.id=1 AND c.sequence=(SELECT max(sequence) FROM memory_recall_changes) AND (NEW.record_id,NEW.record_version)>=(c.lo_id,c.lo_version) AND (NEW.record_id,NEW.record_version)<=(c.hi_id,c.hi_version)) BEGIN INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('record',NEW.record_id,NEW.record_version); INSERT INTO memory_recall_changes(kind,object_id,version) SELECT 'record',OLD.record_id,OLD.record_version WHERE OLD.record_id IS NOT NEW.record_id OR OLD.record_version IS NOT NEW.record_version; END;
CREATE TRIGGER IF NOT EXISTS memory_recall_projection_d AFTER DELETE ON memory_projection_receipts BEGIN INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('record',OLD.record_id,OLD.record_version); END;
${['INSERT','UPDATE','DELETE'].map(event=>`CREATE TRIGGER IF NOT EXISTS memory_recall_scope_${event.toLowerCase()} AFTER ${event} ON memory_scopes BEGIN UPDATE memory_recall_epoch SET epoch=epoch+1 WHERE id=1; END;`).join('\n')}
${['INSERT','UPDATE','DELETE'].map(event=>{
 const rows=event==='UPDATE'?['OLD','NEW']:[event==='DELETE'?'OLD':'NEW'];
 const relevant=rows.map(row=>`(${row}.id IN ('memory-owner-settings','memory-roster-policy') OR ${row}.subject_type IN ('human-thread','human-binding','room','bot','person'))`).join(' OR ');
 return `CREATE TRIGGER IF NOT EXISTS memory_recall_binding_${event.toLowerCase()} AFTER ${event} ON memory_scope_bindings WHEN ${relevant} BEGIN
 UPDATE memory_recall_epoch SET epoch=epoch+1 WHERE id=1;
 DELETE FROM memory_recall_excluded;
 INSERT INTO memory_recall_excluded SELECT DISTINCT CAST(e.value AS TEXT) FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings'; END;`;
}).join('\n')}
CREATE TRIGGER IF NOT EXISTS memory_recall_binding_replace BEFORE INSERT ON memory_scope_bindings
 WHEN NEW.id IN ('memory-owner-settings','memory-roster-policy') OR NEW.subject_type IN ('human-thread','human-binding','room','bot','person')
 OR EXISTS(SELECT 1 FROM memory_scope_bindings previous WHERE previous.id=NEW.id AND previous.subject_type IN ('human-thread','human-binding','room','bot','person'))
 BEGIN UPDATE memory_recall_epoch SET epoch=epoch+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS memory_recall_membership_i BEFORE INSERT ON memory_recall_view_scopes WHEN EXISTS(SELECT 1 FROM memory_recall_views WHERE view_id=NEW.view_id AND generation=NEW.generation AND state='ready') BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECALL_MEMBERSHIP'); END;
CREATE TRIGGER IF NOT EXISTS memory_recall_membership_u BEFORE UPDATE ON memory_recall_view_scopes WHEN EXISTS(SELECT 1 FROM memory_recall_views WHERE (view_id=NEW.view_id AND generation=NEW.generation OR view_id=OLD.view_id AND generation=OLD.generation) AND state='ready') BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECALL_MEMBERSHIP'); END;
CREATE TRIGGER IF NOT EXISTS memory_recall_membership_d BEFORE DELETE ON memory_recall_view_scopes WHEN EXISTS(SELECT 1 FROM memory_recall_views WHERE view_id=OLD.view_id AND generation=OLD.generation AND state='ready') BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECALL_MEMBERSHIP'); END;
CREATE TRIGGER IF NOT EXISTS memory_recall_meta AFTER UPDATE OF policy_revision,deletion_epoch ON memory_meta WHEN OLD.policy_revision!=NEW.policy_revision OR OLD.deletion_epoch!=NEW.deletion_epoch BEGIN UPDATE memory_recall_epoch SET epoch=epoch+1 WHERE id=1; END;
`;
let expected: Map<string,{type:string;name:string;tbl_name:string;sql:string|null}> | undefined;
export function recallSchemaObjects() {
  if (expected) return expected;
  const db = new DatabaseSync(':memory:');
  try {
    // Triggers need target tables; only the named derived objects are registered.
    db.exec(`CREATE TABLE memory_scopes(id,kind,owner_key); CREATE TABLE memory_scope_bindings(id,subject_type,intent);
      CREATE TABLE memory_records(id,version); CREATE TABLE memory_jobs(id); CREATE TABLE memory_projection_receipts(record_id,record_version,lexical_status);
      CREATE TABLE memory_meta(policy_revision,deletion_epoch);`);
    db.exec(RECALL_VIEW_SCHEMA);
    expected = new Map((db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name LIKE 'memory_recall_%' OR tbl_name LIKE 'memory_recall_%'").all() as unknown as Array<{type:string;name:string;tbl_name:string;sql:string|null}>).map(row=>[row.name,row]));
    return expected;
  } finally { db.close(); }
}
/** The pending table stays exactly as 1.0.19 shipped it and is still written (recall-view.ts projectRecord), though the pending page reads the
 * receipts' own index (recall-view-index.ts): 1.0.19 refuses a file without it (MEMORY_SCHEMA_UNSUPPORTED, then its restore page), and a
 * 1.0.19 that opens a view built here reads that table. Retiring it waits for a release that bumps MEMORY_SCHEMA_VERSION. */
export const RECALL_PENDING_OBJECTS=['memory_recall_view_pending','memory_recall_pending_record','memory_recall_view_pending_storage_i','memory_recall_view_pending_storage_d'] as const;
/** A 1.0.20 candidate build dropped the pending table. Such a file gets it back empty, and every view goes stale in the same step (the
 * authority epoch moves), so no reader of either release trusts a view whose pending rows were never written. Whole or not at all. */
function restoreDroppedPending(db: DatabaseSync): boolean {
  if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_recall_view_pending'").get()
    || !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_recall_epoch'").get())return false;
  db.exec('SAVEPOINT recall_pending_restore');
  try {
    db.exec(RECALL_VIEW_SCHEMA);
    db.exec('UPDATE memory_recall_epoch SET epoch=epoch+1 WHERE id=1');
    db.exec('RELEASE recall_pending_restore');
  } catch(error) { db.exec('ROLLBACK TO recall_pending_restore');db.exec('RELEASE recall_pending_restore');throw error; }
  return true;
}
/** mem-f1 (MEMAUDIT F1, 1.0.21). A view stores a job as (job rowid, job id) and reads its conversation through the job's source. A lease,
 * a heartbeat, a settle or a cancel changes none of those, yet memory_recall_job_u journaled every one of them, and every view then read
 * each row: about half of a turn's journal. The persisted trigger keeps its exact text (1.0.19 and 1.0.20 refuse a file whose recall
 * objects differ, MEMORY_SCHEMA_UNSUPPORTED), so the guard is connection-local, like the other temp fences:
 *   - before a job UPDATE that keeps the row, the id and the source, the job id is noted;
 *   - the journal insert that the persisted trigger then makes for exactly that job is dropped (RAISE(IGNORE) abandons that one insert and
 *     nothing else; the UPDATE itself goes on), and the note is cleared, so it lets one row through for one update, never more;
 *   - a job INSERT or DELETE, or an UPDATE that moves the job to another source or id, clears the note first, so those are always journaled.
 * A connection without the guard (another process, an older build) journals every update as before, which the consumer still accepts. */
export const RECALL_JOB_GUARD=`
CREATE TEMP TABLE IF NOT EXISTS recall_job_same(id INTEGER PRIMARY KEY CHECK(id=1),job_id TEXT);
INSERT OR IGNORE INTO recall_job_same VALUES(1,NULL);
CREATE TEMP TRIGGER IF NOT EXISTS recall_job_same_u BEFORE UPDATE ON main.memory_jobs BEGIN
 UPDATE recall_job_same SET job_id=CASE WHEN OLD.rowid IS NEW.rowid AND OLD.id IS NEW.id AND OLD.source_id IS NEW.source_id THEN NEW.id END WHERE id=1; END;
CREATE TEMP TRIGGER IF NOT EXISTS recall_job_same_i BEFORE INSERT ON main.memory_jobs BEGIN UPDATE recall_job_same SET job_id=NULL WHERE id=1 AND job_id IS NOT NULL; END;
CREATE TEMP TRIGGER IF NOT EXISTS recall_job_same_d BEFORE DELETE ON main.memory_jobs BEGIN UPDATE recall_job_same SET job_id=NULL WHERE id=1 AND job_id IS NOT NULL; END;
CREATE TEMP TRIGGER IF NOT EXISTS recall_job_same_c BEFORE INSERT ON main.memory_recall_changes
 WHEN NEW.kind='job' AND NEW.version=0 AND NEW.object_id IS (SELECT job_id FROM recall_job_same WHERE id=1) BEGIN
 UPDATE recall_job_same SET job_id=NULL WHERE id=1; SELECT RAISE(IGNORE); END;
`;
/** memv2 lane A (MEMORY-V2-DESIGN 4.2 A1). Owner of both sides: lane A (these triggers write the table, the recall applier in recall-view.ts
 * reads and clears it). A change row names a key only, so a view that held the object under a scope it no longer has could be found only by
 * asking every view. The writer's own transaction therefore notes where the object WAS: (kind, id, version, old scope, the newest journal
 * sequence allocated before the write; the journal row this write makes is the next one). The applier then visits the views that hold
 * the current scope plus the views that hold a noted old scope, and no other. Connection-local like the job guard: nothing persisted changes.
 *   - scope '' means "old scope not known" (the job's source row is already gone): the applier removes that key from every view;
 *   - kind 'job-any' is a standing note that a source moved to another scope on this connection: from then on every job row is treated
 *     as not known (no product code moves a source; this keeps a future one correct instead of fast);
 *   - a row replaced in place (INSERT OR REPLACE fires no DELETE trigger) is noted by the BEFORE INSERT triggers;
 *   - a rolled-back write takes its note with it (TEMP tables are transactional).
 * A connection without these triggers writes no note, and its rows are not routed by notes: see recallBootMark in recall-view.ts. */
const OLD_SCOPE_AT="(SELECT coalesce((SELECT seq FROM main.sqlite_sequence WHERE name='memory_recall_changes'),0))";
/** A note is written as DELETE + INSERT, never with a conflict clause: SQLite replaces a trigger statement's own ON CONFLICT with that of
 * the statement that fired the trigger (lane W note 1), so an `INSERT OR REPLACE` here would become OR IGNORE under an owner's
 * `INSERT OR IGNORE` / `UPDATE OR IGNORE` (the note would keep an older sequence and be spent before its write is applied) and an ABORT
 * of the owner's own write under `INSERT OR ABORT` when the same key is noted twice. */
const noteOldScope=(kind:string,id:string,version:string,scope:string,sequence:string=OLD_SCOPE_AT)=>
  `DELETE FROM recall_old_scope WHERE kind='${kind}' AND object_id IS ${id} AND version IS ${version} AND scope_id IS ${scope};
 INSERT INTO recall_old_scope VALUES('${kind}',${id},${version},${scope},${sequence});`;
const JOB_SCOPE=(row:string)=>`coalesce((SELECT scope_id FROM main.memory_sources WHERE id=${row}.source_id),'')`;
const JOB_OLD_SCOPE=(row:string)=>noteOldScope('job',`${row}.id`,'0',JOB_SCOPE(row));
export const RECALL_OLD_SCOPE=`
CREATE TEMP TABLE IF NOT EXISTS recall_old_scope(kind TEXT NOT NULL,object_id TEXT NOT NULL,version INTEGER NOT NULL,scope_id TEXT NOT NULL,sequence INTEGER NOT NULL,PRIMARY KEY(kind,object_id,version,scope_id)) WITHOUT ROWID;
CREATE TEMP TRIGGER IF NOT EXISTS recall_old_scope_record_u BEFORE UPDATE ON main.memory_records WHEN OLD.scope_id IS NOT NEW.scope_id OR OLD.id IS NOT NEW.id OR OLD.version IS NOT NEW.version BEGIN
 ${noteOldScope('record','OLD.id','OLD.version','OLD.scope_id')} END;
CREATE TEMP TRIGGER IF NOT EXISTS recall_old_scope_record_d BEFORE DELETE ON main.memory_records BEGIN
 ${noteOldScope('record','OLD.id','OLD.version','OLD.scope_id')} END;
CREATE TEMP TRIGGER IF NOT EXISTS recall_old_scope_record_i BEFORE INSERT ON main.memory_records BEGIN
 DELETE FROM recall_old_scope WHERE kind='record' AND object_id IS NEW.id AND version IS NEW.version AND scope_id IN (SELECT r.scope_id FROM main.memory_records r WHERE r.id=NEW.id AND r.version=NEW.version AND r.scope_id IS NOT NEW.scope_id);
 INSERT INTO recall_old_scope SELECT 'record',r.id,r.version,r.scope_id,${OLD_SCOPE_AT} FROM main.memory_records r WHERE r.id=NEW.id AND r.version=NEW.version AND r.scope_id IS NOT NEW.scope_id; END;
CREATE TEMP TRIGGER IF NOT EXISTS recall_old_scope_job_u BEFORE UPDATE ON main.memory_jobs WHEN OLD.source_id IS NOT NEW.source_id OR OLD.id IS NOT NEW.id BEGIN ${JOB_OLD_SCOPE('OLD')} END;
CREATE TEMP TRIGGER IF NOT EXISTS recall_old_scope_job_d BEFORE DELETE ON main.memory_jobs BEGIN ${JOB_OLD_SCOPE('OLD')} END;
CREATE TEMP TRIGGER IF NOT EXISTS recall_old_scope_job_i BEFORE INSERT ON main.memory_jobs BEGIN
 DELETE FROM recall_old_scope WHERE kind='job' AND object_id IS NEW.id AND version=0 AND scope_id IN (SELECT ${JOB_SCOPE('j')} FROM main.memory_jobs j WHERE j.id=NEW.id AND j.source_id IS NOT NEW.source_id);
 INSERT INTO recall_old_scope SELECT 'job',j.id,0,${JOB_SCOPE('j')},${OLD_SCOPE_AT} FROM main.memory_jobs j WHERE j.id=NEW.id AND j.source_id IS NOT NEW.source_id; END;
CREATE TEMP TRIGGER IF NOT EXISTS recall_old_scope_source_u BEFORE UPDATE ON main.memory_sources WHEN OLD.scope_id IS NOT NEW.scope_id OR OLD.id IS NOT NEW.id BEGIN
 ${noteOldScope('job-any',"''",'0',"''",'9223372036854775807')} END;
CREATE TEMP TRIGGER IF NOT EXISTS recall_old_scope_source_d BEFORE DELETE ON main.memory_sources BEGIN
 DELETE FROM recall_old_scope WHERE kind='job' AND version=0 AND scope_id IS OLD.scope_id AND object_id IN (SELECT j.id FROM main.memory_jobs j WHERE j.source_id=OLD.id);
 INSERT INTO recall_old_scope SELECT 'job',j.id,0,OLD.scope_id,${OLD_SCOPE_AT} FROM main.memory_jobs j WHERE j.source_id=OLD.id; END;
`;
/** The journal row a note's write makes is the first one after note.sequence, so a note is spent once the applied mark has passed
 *  note.sequence (DELETE ... WHERE sequence < mark, in the applying transaction). */
export interface RecallOldScope { scope: string; sequence: number }
export function readRecallOldScopes(db: DatabaseSync): { notes: Map<string,RecallOldScope[]>; anyJob: boolean } {
  const notes=new Map<string,RecallOldScope[]>();let anyJob=false;
  for(const row of db.prepare('SELECT kind,object_id,version,scope_id,sequence FROM temp.recall_old_scope').all()) {
    if(row.kind==='job-any'){anyJob=true;continue;}
    const key=`${row.kind}\0${row.object_id}\0${row.version}`;
    notes.set(key,[...(notes.get(key)??[]),{scope:String(row.scope_id),sequence:Number(row.sequence)}]);
  }
  return {notes,anyJob};
}
export const recallOldScopeKey=(kind:'record'|'job',id:string,version:number)=>`${kind}\0${id}\0${version}`;
/** q1022-recallperf item 1 (HIDDEN-COST-opus #10): the charged bytes of each view, kept by triggers instead of a sum over its terms (the 412 ms
 *  statement, run per waiting build, per quota-refused turn and per cold view of a victim choice). The persisted storage triggers keep their
 *  exact text (1.0.19 and 1.0.20 refuse a file whose recall objects differ), so the counter is connection-local, like recall_job_same: a view
 *  is seeded from its rows once (recall-view.ts chargedViewBytes), and from then on every insert, delete or move of one of its charged rows on
 *  this connection adds or takes that row's charge (the same arithmetic as storageTriggers). A view row's delete drops its counter. A commit
 *  by another connection (PRAGMA data_version moved) empties the table, so a counter is never trusted past a write it did not see. */
export const RECALL_CHARGED_TABLES=['memory_recall_view_scopes','memory_recall_view_records','memory_recall_view_terms','memory_recall_view_pending','memory_recall_view_jobs','memory_recall_contains'] as const;
const chargeOf=(table:string,row:string)=>table==='memory_recall_view_terms'?`(512+4*length(CAST(${row}.term AS BLOB)))`:'512';
export const RECALL_VIEW_CHARGE=`
CREATE TEMP TABLE IF NOT EXISTS recall_view_charge(view_id TEXT NOT NULL,generation TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(view_id,generation)) WITHOUT ROWID;
${RECALL_CHARGED_TABLES.map(table=>`CREATE TEMP TRIGGER IF NOT EXISTS recall_view_charge_${table}_i AFTER INSERT ON main.${table} BEGIN
 UPDATE recall_view_charge SET bytes=bytes+${chargeOf(table,'NEW')} WHERE view_id=NEW.view_id AND generation=NEW.generation; END;
CREATE TEMP TRIGGER IF NOT EXISTS recall_view_charge_${table}_d AFTER DELETE ON main.${table} BEGIN
 UPDATE recall_view_charge SET bytes=bytes-${chargeOf(table,'OLD')} WHERE view_id=OLD.view_id AND generation=OLD.generation; END;
CREATE TEMP TRIGGER IF NOT EXISTS recall_view_charge_${table}_u AFTER UPDATE ON main.${table} BEGIN
 UPDATE recall_view_charge SET bytes=bytes-${chargeOf(table,'OLD')} WHERE view_id=OLD.view_id AND generation=OLD.generation;
 UPDATE recall_view_charge SET bytes=bytes+${chargeOf(table,'NEW')} WHERE view_id=NEW.view_id AND generation=NEW.generation; END;`).join('\n')}
CREATE TEMP TRIGGER IF NOT EXISTS recall_view_charge_view_d AFTER DELETE ON main.memory_recall_views BEGIN
 DELETE FROM recall_view_charge WHERE view_id=OLD.view_id AND generation=OLD.generation; END;
`;
export function ensureRecallJobGuard(db: DatabaseSync): void {
  if(Number(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name IN ('memory_jobs','memory_recall_changes')").get()!.n)===2)db.exec(RECALL_JOB_GUARD);
  if(Number(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name IN ('memory_jobs','memory_records','memory_sources','memory_recall_changes')").get()!.n)===4){db.exec(RECALL_OLD_SCOPE);ensureRecallJournalWake(db);}
  if(Number(db.prepare(`SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name IN (${[...RECALL_CHARGED_TABLES,'memory_recall_views'].map(name=>`'${name}'`).join(',')})`).get()!.n)===RECALL_CHARGED_TABLES.length+1)db.exec(RECALL_VIEW_CHARGE);
}
/** memv2 lane A (A6), on lane W's wake bus (wake.ts). The applier is woken by the `journal` topic, which the bus writes for every journal
 *  INSERT of this connection and raises after the commit. What the bus has no topic for is counted here: a write that could give the
 *  reclaimer something to free, or make a view maintainable with no journal row (a view or context row, the authority epoch). ONE
 *  registered function, called by TEMP triggers; it only counts and raises (a raise never runs a subscriber inline), it never touches
 *  the database. False when the bus is not on this connection (a read-only start, a failed install: memory then reads `checking`) or
 *  the SQLite build cannot register a function: nothing is installed and the applier does not run on this connection. */
export const RECALL_UPKEEP_TOPIC='recall-upkeep';
const RECLAIM_TOUCH_TRIGGERS=['recall_reclaim_view_i','recall_reclaim_view_d','recall_reclaim_view_u','recall_reclaim_context_i','recall_reclaim_context_d','recall_reclaim_context_u','recall_reclaim_epoch_u'] as const;
let reclaimChanges=0,viewChanges=0;
/** The applier wrote view rows (or left a range open): the reclaimer has cause to look again. */
export function reclaimTouched(): void { reclaimChanges++; raise(RECALL_UPKEEP_TOPIC); }
export function reclaimMark(): number { return reclaimChanges; }
/** A view or context row was written, or the authority epoch moved: the applier looks at who it maintains, the reclaimer at what is free. */
export function viewsTouched(): void { viewChanges++; reclaimChanges++; raise('journal'); raise(RECALL_UPKEEP_TOPIC); }
export function viewsMark(): number { return viewChanges; }
export function ensureRecallJournalWake(db: DatabaseSync): boolean {
  try {
    db.exec('DROP TRIGGER IF EXISTS temp.recall_journal_wake');
    if(!wakeInstalled(db))return false;
    (db as unknown as { function(name: string, fn: () => number): void }).function('recall_reclaim_touch',()=>{viewsTouched();return 0;});
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS recall_reclaim_view_i AFTER INSERT ON main.memory_recall_views BEGIN SELECT recall_reclaim_touch(); END;
      CREATE TEMP TRIGGER IF NOT EXISTS recall_reclaim_view_d AFTER DELETE ON main.memory_recall_views BEGIN SELECT recall_reclaim_touch(); END;
      CREATE TEMP TRIGGER IF NOT EXISTS recall_reclaim_view_u AFTER UPDATE OF view_id,generation,authority_epoch,roster_revision,state,scope_count,digest,room_reader ON main.memory_recall_views BEGIN SELECT recall_reclaim_touch(); END;
      CREATE TEMP TRIGGER IF NOT EXISTS recall_reclaim_context_i AFTER INSERT ON main.memory_recall_contexts BEGIN SELECT recall_reclaim_touch(); END;
      CREATE TEMP TRIGGER IF NOT EXISTS recall_reclaim_context_d AFTER DELETE ON main.memory_recall_contexts BEGIN SELECT recall_reclaim_touch(); END;
      CREATE TEMP TRIGGER IF NOT EXISTS recall_reclaim_context_u AFTER UPDATE ON main.memory_recall_contexts BEGIN SELECT recall_reclaim_touch(); END;
      CREATE TEMP TRIGGER IF NOT EXISTS recall_reclaim_epoch_u AFTER UPDATE OF epoch ON main.memory_recall_epoch BEGIN SELECT recall_reclaim_touch(); END;`);
    return true;
  } catch {
    for(const name of RECLAIM_TOUCH_TRIGGERS)try{db.exec(`DROP TRIGGER IF EXISTS temp.${name}`);}catch{/* nothing was installed */}
    // The applier and the upkeep do not run on this connection (a view is then caught up only by the reader that asks for it).
    console.warn('[memory] recall view upkeep is off on this connection: its wake signals could not be installed');
    return false;
  }
}
// M0, lane A's part: the schema pass of an open runs before the bus is installed, so lane A's TEMP objects are (re)installed by the bus's
// own open hook, on every open (they die with the handle). No scan: two catalogue reads and IF NOT EXISTS statements.
onWakeInstall(db=>{ensureRecallJobGuard(db);});
/** True when this connection wakes the applier by itself: lane W's bus is installed on it and lane A's own signals are too. */
export function hasRecallJournalWake(db: DatabaseSync): boolean {
  return wakeInstalled(db) && Number(db.prepare("SELECT count(*) AS n FROM temp.sqlite_schema WHERE type='trigger' AND name IN ('recall_reclaim_view_u','recall_reclaim_epoch_u')").get()!.n)===2;
}
/** False on a connection that could not install the notes (a file without the memory tables yet): the applier then asks every view. */
export function hasRecallOldScopes(db: DatabaseSync): boolean {
  return !!db.prepare("SELECT 1 FROM temp.sqlite_schema WHERE type='table' AND name='recall_old_scope'").get();
}
/** q1022-upgradecatchup. Owner of every side: this lane (the purge, the drop and the built marks here; the lazy, paced rebuild
 * and the paced reclaim in recall-view.ts).
 * Recall views are derived data. The views an earlier release left behind (1.0.21's rebuild loop filled the store with them) were
 * reclaimed row by row on the first 1.0.22 start: every row delete rewrites three b-tree pages into the log, hundreds of MB a minute
 * for minutes. They are dropped whole instead: DROP TABLE hands the pages to the free list (a few list pages are written, not one
 * frame per row), the tables come back empty from RECALL_VIEW_SCHEMA, and the turn that needs a view builds it.
 * WHEN: once per file (the mark), and again whenever the file holds a view this release did not build: every view built here is noted
 * by a connection-local trigger (RECALL_BUILT_MARKS), so a view an older build wrote after a rollback has no note and the next
 * start here drops again. A view built here survives every later start.
 * PRIVACY (MAIN-RULING UPCATCH-1022 D1, database.ts: a deleted conversation's words are overwritten in the file): the dropped tables are
 * derived copies of text that still exists in memory_records, so the drop itself runs with secure_delete off (on, it would write every
 * freed page as zeros, the whole size in one transaction at the open) and nothing scrubs the freed pages afterwards. The one exception
 * is purged FIRST, with secure_delete ON: the term rows of a record that is already forgotten (no memory_records row of that id and
 * version any more, a row in state 'deleted', or a record tombstone); and while a forget's walk is still owed (forgetWorkOwed)
 * the drop waits for a later open. Only memory_recall_view_terms holds words; the other derived
 * tables hold ids. The mark is a row in transcript_index_state (the per-file progress table older releases already carry and ignore
 * by name), so an older build that opens the file after a rollback sees ordinary empty view tables. Its `skipped` column is 1 on a
 * file where a drop ran: there warming builds only contexts a reader asked for (recall-view.ts recallWarmActiveOnly). */
export const RECALL_UPGRADE_MARK='recall_views_1022';
const BUILT='recall_built_1022:';
/** Connection-local, like the other temp fences: every view row this release writes is noted, and the note goes with the row. */
export const RECALL_BUILT_MARKS=`
CREATE TEMP TRIGGER IF NOT EXISTS recall_built_1022_i AFTER INSERT ON main.memory_recall_views BEGIN INSERT OR REPLACE INTO main.transcript_index_state(name,done,cursor,skipped) VALUES('${BUILT}'||NEW.view_id||':'||NEW.generation,1,0,0); END;
CREATE TEMP TRIGGER IF NOT EXISTS recall_built_1022_d AFTER DELETE ON main.memory_recall_views BEGIN DELETE FROM main.transcript_index_state WHERE name='${BUILT}'||OLD.view_id||':'||OLD.generation; END;`;
export const RECALL_DERIVED_TABLES=['memory_recall_view_terms','memory_recall_view_records','memory_recall_view_pending','memory_recall_view_jobs',
  'memory_recall_view_scopes','memory_recall_contains','memory_recall_thread_readers','memory_recall_contexts','memory_recall_views'] as const;
/** A forget or a revoke has committed but its bounded walk is still owed (memory-revocation.ts revocationWorkPending: a job row under
 *  REVOCATION_JOB_SUBJECT 'memory-revocation'; revoke-marker.ts memory_revoke_jobs): records it will end are not marked yet, so the
 *  purge below cannot name their terms. Read here by its durable rows (this module sits below both); any error reads as owed.
 *  A revoke job is owed in every state but the final 'done'/'undone' (q1023-upcatch): 'active', 'undoing', a bulk 'seeding' before
 *  its fold, a 'folded' member whose bulk carries it, and a 'quarantined' job (1.0.22 revokehealth) that a newer version retries. */
function forgetWorkOwed(db: DatabaseSync): boolean {
  try {
    if(db.prepare("SELECT 1 FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='memory-revocation' AND state IN ('granted','revoked') LIMIT 1").get())return true;
    return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_revoke_jobs'").get()
      && !!db.prepare("SELECT 1 FROM memory_revoke_jobs WHERE state NOT IN ('done','undone') LIMIT 1").get();
  } catch { return true; }
}
export function dropLeftoverRecallViews(db: DatabaseSync): number|undefined {
  if(Number((db.prepare('PRAGMA query_only').get() as {query_only?:number}|undefined)?.query_only??0))return undefined;
  db.exec("CREATE TABLE IF NOT EXISTS transcript_index_state(name TEXT PRIMARY KEY, done INTEGER NOT NULL, cursor INTEGER NOT NULL, skipped INTEGER NOT NULL) WITHOUT ROWID");
  const marked=!!db.prepare('SELECT 1 FROM transcript_index_state WHERE name=?').get(RECALL_UPGRADE_MARK);
  // a view with no note was written by a build that does not keep them: an older release ran on this file since the mark
  const foreign=()=>!!db.prepare(`SELECT 1 FROM memory_recall_views v WHERE NOT EXISTS(SELECT 1 FROM transcript_index_state s WHERE s.name='${BUILT}'||v.view_id||':'||v.generation) LIMIT 1`).get();
  if(marked && !foreign())return undefined;
  const free=()=>Number((db.prepare('PRAGMA freelist_count').get() as {freelist_count?:number}|undefined)?.freelist_count??0);
  const secure=Number((db.prepare('PRAGMA secure_delete').get() as {secure_delete?:number}|undefined)?.secure_delete??0);
  const before=free();
  db.exec('SAVEPOINT recall_upgrade_drop');
  try {
    let freed=0,dropped=false;
    // an empty file (a new install, or one with no view yet) only gets the mark
    if(db.prepare('SELECT 1 FROM memory_recall_views LIMIT 1').get() || db.prepare('SELECT 1 FROM memory_recall_contexts LIMIT 1').get()
      || db.prepare('SELECT 1 FROM memory_recall_view_terms LIMIT 1').get() || db.prepare('SELECT 1 FROM memory_recall_view_records LIMIT 1').get()) {
      // While a forget's walk is owed, the words it will remove cannot be told apart yet: nothing is dropped and no mark is written
      // at this open (neither a residue in freed pages nor a rewrite of every page). The views stand, the walk overwrites its own
      // rows (memory-revocation.ts, secure_delete ON), the paced reclaimer frees the rest, and a later open drops what is left.
      if(forgetWorkOwed(db)){db.exec('RELEASE recall_upgrade_drop');return undefined;}
      // words of an already-forgotten record are overwritten before their pages go to the free list (secure_delete ON for this delete)
      db.exec('PRAGMA secure_delete=ON');
      try {
        const tombstones=!!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_tombstones'").get();
        db.prepare(`DELETE FROM memory_recall_view_terms WHERE (record_id,version) IN (SELECT d.record_id,d.version FROM (SELECT DISTINCT record_id,version FROM memory_recall_view_terms) d
          WHERE NOT EXISTS(SELECT 1 FROM memory_records r WHERE r.id=d.record_id AND r.version=d.version AND r.state<>'deleted')
          ${tombstones?"OR EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.target_type='record' AND t.target_id=d.record_id)":''})`).run();
      } finally {db.exec(`PRAGMA secure_delete=${secure===2?'FAST':secure?'ON':'OFF'}`);}
      db.exec('PRAGMA secure_delete=OFF');
      try {for(const table of RECALL_DERIVED_TABLES)db.exec(`DROP TABLE IF EXISTS ${table}`);}
      finally {db.exec(`PRAGMA secure_delete=${secure===2?'FAST':secure?'ON':'OFF'}`);}
      db.exec(RECALL_VIEW_SCHEMA);
      db.exec('UPDATE memory_recall_storage SET bytes=0 WHERE id=1');
      db.prepare('DELETE FROM transcript_index_state WHERE name>=? AND name<?').run(BUILT,BUILT.slice(0,-1)+';');
      freed=Math.max(0,free()-before);dropped=true;
    }
    // done=1 at once (no scrub is owed). cursor = pages freed, skipped = 1 once a drop ran on this file (kept by a later mark).
    const lazy=dropped || Number(db.prepare('SELECT skipped FROM transcript_index_state WHERE name=?').get(RECALL_UPGRADE_MARK)?.skipped??0)===1;
    db.prepare('INSERT OR REPLACE INTO transcript_index_state(name,done,cursor,skipped) VALUES(?,1,?,?)').run(RECALL_UPGRADE_MARK,freed,lazy?1:0);
    db.exec('RELEASE recall_upgrade_drop');
    return freed;
  } catch(error) {
    // (a failure that already rolled the whole transaction back took the savepoint with it: the first error is the one reported)
    try {db.exec('ROLLBACK TO recall_upgrade_drop');db.exec('RELEASE recall_upgrade_drop');} catch { /* no savepoint left */ }
    throw error;
  }
}
/** 13 -> 14 (q1023-oneindex; MAIN: the shared bump 14 is q1023-denyrule's and oneindex adds its step to the same migration). Runs inside
 *  the one schema transaction of migrateMemorySchema, after denyRuleUpgradeRows. Recall reads the one shared index through the computed
 *  scope set (oneindex.ts), so every per-view copy goes in that transaction, forget work owed or not (dropLeftoverRecallViews waits while
 *  a walk is owed; a 1.0.22 file with a stuck revoke queue never dropped them). PRIVACY: while a forget's walk is owed its words cannot be
 *  told apart from live ones, so EVERY term row is deleted with secure_delete ON (freed pages zeroed) before the tables drop; the other
 *  derived tables hold ids only. The tables come back empty, the storage meter reads 0 and the upgrade mark is written with skipped=1
 *  (warm-active-only: a view is built only for a reader that asks). A crash before the commit leaves the file at 13 with its views. */
export function dropRecallViewsAtSchema14(db: DatabaseSync): { terms: number; views: number } {
  if(!db.isTransaction)throw new Error('MEMORY_RECALL_DROP_NO_TRANSACTION');
  if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_recall_views'").get())return { terms: 0, views: 0 };
  const secure=Number((db.prepare('PRAGMA secure_delete').get() as {secure_delete?:number}|undefined)?.secure_delete??0);
  const restore=()=>db.exec(`PRAGMA secure_delete=${secure===2?'FAST':secure?'ON':'OFF'}`);
  const free=()=>Number((db.prepare('PRAGMA freelist_count').get() as {freelist_count?:number}|undefined)?.freelist_count??0);
  const before=free(),views=Number((db.prepare('SELECT count(*) AS n FROM memory_recall_views').get() as {n:number}).n);
  let terms=0;
  db.exec('PRAGMA secure_delete=ON');
  try {terms=Number(db.prepare('DELETE FROM memory_recall_view_terms').run().changes);for(const table of RECALL_DERIVED_TABLES)db.exec(`DROP TABLE IF EXISTS ${table}`);}
  finally {restore();}
  db.exec(RECALL_VIEW_SCHEMA);
  db.exec('UPDATE memory_recall_storage SET bytes=0 WHERE id=1');
  db.exec("CREATE TABLE IF NOT EXISTS transcript_index_state(name TEXT PRIMARY KEY, done INTEGER NOT NULL, cursor INTEGER NOT NULL, skipped INTEGER NOT NULL) WITHOUT ROWID");
  db.prepare('DELETE FROM transcript_index_state WHERE name>=? AND name<?').run(BUILT,BUILT.slice(0,-1)+';');
  db.prepare('INSERT OR REPLACE INTO transcript_index_state(name,done,cursor,skipped) VALUES(?,1,?,1)').run(RECALL_UPGRADE_MARK,Math.max(0,free()-before));
  return { terms, views };
}
export function ensureRecallViewSchema(db: DatabaseSync) {
  if(!restoreDroppedPending(db))db.exec(RECALL_VIEW_SCHEMA);
  dropLeftoverRecallViews(db);
  if(!Number((db.prepare('PRAGMA query_only').get() as {query_only?:number}|undefined)?.query_only??0))db.exec(RECALL_BUILT_MARKS);
  ensureRecallJobGuard(db);
  db.exec(`INSERT OR IGNORE INTO memory_recall_excluded SELECT DISTINCT CAST(e.value AS TEXT) FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings'`);
}
/** One change row of kind 'receipts' stands for a producer chunk of receipt flips (FIX3-DESIGN, MAIN 2026-11-17T00:49Z). It names the chunk's
 * receipt key range [lo,hi] (SQLite order) and the highest receipt rowid at the time; the consumer re-checks every receipt in that range up to
 * that rowid, which covers every member. It is used only when the range holds at most RECALL_CHANGE_SET receipts (one bounded seek to count);
 * otherwise the chunk's flips log one row each as before. In the caller's transaction: the range row, the one-row cover naming its sequence,
 * the chunk's updates, then the cover leaves. projection_u skips a flip only inside the range and only while the cover names the newest
 * change row, so any other change ends the coalescing (fail closed). */
export const RECALL_CHANGE_SET=256;
export function coverReceiptChanges(db: DatabaseSync,members: ReadonlyArray<readonly [string,number]>,run: ()=>void): void {
  if(!members.length){run();return;}
  if(members.length>RECALL_CHANGE_SET)throw new Error('MEMORY_RECALL_CHANGE_SET_TOO_LARGE');
  const json=JSON.stringify(members.map(([id,version])=>[id,version]));
  const bound=(order:'ASC'|'DESC')=>db.prepare(`SELECT CAST(json_extract(value,'$[0]') AS TEXT) AS id,CAST(json_extract(value,'$[1]') AS INTEGER) AS version FROM json_each(?) ORDER BY 1 ${order},2 ${order} LIMIT 1`).get(json) as {id:string;version:number};
  const lo=bound('ASC'),hi=bound('DESC');
  const held=Number(db.prepare('SELECT count(*) AS n FROM (SELECT 1 FROM memory_projection_receipts WHERE (record_id,record_version)>=(?,?) AND (record_id,record_version)<=(?,?) LIMIT ?)').get(lo.id,lo.version,hi.id,hi.version,RECALL_CHANGE_SET+1)!.n);
  if(held>RECALL_CHANGE_SET){run();return;}
  const ceiling=Number(db.prepare('SELECT coalesce(max(rowid),0) AS n FROM memory_projection_receipts').get()!.n);
  const sequence=Number(db.prepare("INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('receipts',?,?)").run(JSON.stringify([lo.id,lo.version,hi.id,hi.version,ceiling]),held).lastInsertRowid);
  db.prepare('INSERT OR REPLACE INTO memory_recall_change_cover VALUES(1,?,?,?,?,?)').run(sequence,lo.id,lo.version,hi.id,hi.version);
  try { run(); }
  finally { db.prepare('DELETE FROM memory_recall_change_cover').run(); }
}
/** (Before memv2 lane A the reader below refused a range that had grown past RECALL_CHANGE_SET; it now pages it.)
 * The receipt keys a 'receipts' change row stands for; a row the consumer cannot read, or a range now holding more than RECALL_CHANGE_SET
 * receipts up to its rowid, is refused (the consumer never skips a row). */
export type RecallRangeCursor=readonly [string,number];
/** memv2 lane A (A3b, AF-H5). Owner of both sides: lane A (this reader; its two callers are the applier and the build replay in
 *  recall-view.ts). One piece of the range: at most RECALL_CHANGE_SET raw entries after `after`, and `next` when the range goes on. A
 *  range that has grown since its row was logged is therefore paged, never refused: the caller keeps the cursor and moves its mark past
 *  the row only when `next` is absent. A piece always ends on a whole key (receipts of several index generations share a record
 *  version), so no key is split between two pieces. */
export function recallChangeRangePage(db: DatabaseSync,objectId: string,after?: RecallRangeCursor): { members: Array<[string,number]>; next?: RecallRangeCursor } {
  let parsed: unknown;
  try { parsed=JSON.parse(objectId); } catch { throw new Error('MEMORY_RECALL_UNAVAILABLE'); }
  if(!Array.isArray(parsed) || parsed.length!==5 || typeof parsed[0]!=='string' || typeof parsed[2]!=='string' || ![parsed[1],parsed[3],parsed[4]].every(n=>Number.isSafeInteger(n)))throw new Error('MEMORY_RECALL_UNAVAILABLE');
  const from=after?'(record_id,record_version)>(?,?)':'(record_id,record_version)>=(?,?)',start=after??[parsed[0],parsed[1]];
  let raw=db.prepare(`SELECT record_id,record_version,rowid AS rid FROM memory_projection_receipts WHERE ${from} AND (record_id,record_version)<=(?,?) ORDER BY record_id,record_version LIMIT ?`).all(start[0],start[1],parsed[2],parsed[3],RECALL_CHANGE_SET+1) as Array<{record_id:string;record_version:number;rid:number}>;
  let next: RecallRangeCursor|undefined;
  if(raw.length>RECALL_CHANGE_SET) {
    // More to read: this piece ends before the last key seen (its other rows may lie beyond the read), unless that key is all there is.
    const last=raw[raw.length-1]!,same=(row:{record_id:string;record_version:number})=>row.record_id===last.record_id && Number(row.record_version)===Number(last.record_version);
    const whole=raw.filter(row=>!same(row));
    if(whole.length)raw=whole;
    else raw=db.prepare('SELECT record_id,record_version,rowid AS rid FROM memory_projection_receipts WHERE record_id=? AND record_version=?').all(last.record_id,last.record_version) as typeof raw;
    const end=raw[raw.length-1]!;next=[String(end.record_id),Number(end.record_version)];
  }
  // Receipts of several index generations share a record version: each version is named once (deduplicated after the bounded read).
  // A receipt written after the row was logged (rowid above its ceiling) is no member; its own change row names it.
  const members=new Map<string,[string,number]>();
  for(const row of raw)if(Number(row.rid)<=Number(parsed[4]))members.set(`${row.record_id}\u0000${row.record_version}`,[String(row.record_id),Number(row.record_version)]);
  return next?{members:[...members.values()],next}:{members:[...members.values()]};
}
export function dropRecallViewSchema(db: DatabaseSync): boolean {
  const objects=new Map([...recallSchemaObjects(),...recallExternalObjects()]);
  const present=!!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_recall_epoch'").get();
  for (const row of objects.values()) if (row.type==='trigger') db.exec(`DROP TRIGGER IF EXISTS ${row.name}`);
  for (const row of [...objects.values()].reverse()) if (row.type==='table') db.exec(`DROP TABLE IF EXISTS ${row.name}`);
  return present;
}

/** Additional structural inputs are application tables initialized after the memory schema. */
export const RECALL_EXTERNAL_SCHEMA=['team_identities','project_settings'].flatMap(table=>['INSERT','UPDATE','DELETE'].map(event=>
  `CREATE TRIGGER IF NOT EXISTS memory_recall_external_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN UPDATE memory_recall_epoch SET epoch=epoch+1 WHERE id=1; END;`)).join('\n');
let external: ReturnType<typeof recallSchemaObjects> | undefined;
export function recallExternalObjects(): ReturnType<typeof recallSchemaObjects> {
  if(external)return external;
  const db=new DatabaseSync(':memory:');
  try {db.exec('CREATE TABLE team_identities(id);CREATE TABLE project_settings(id);CREATE TABLE memory_recall_epoch(id,epoch);');db.exec(RECALL_EXTERNAL_SCHEMA);
    return external=new Map((db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name LIKE 'memory_recall_external_%'").all() as unknown as Array<{type:string;name:string;tbl_name:string;sql:string|null}>).map(row=>[row.name,row]));
  } finally {db.close();}
}
export function ensureExternalRecallEpoch(db: DatabaseSync): void {if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_recall_epoch'").get())db.exec(RECALL_EXTERNAL_SCHEMA);}
