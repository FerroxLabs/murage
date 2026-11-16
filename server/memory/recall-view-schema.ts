// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer: store-patchbot owns structural roster revisions. Consumer: recall-scope owns this durable fence and derived views.
import { DatabaseSync } from '../sqlite-open.ts';

/** Derived data only. The original scopes, evidence and grants remain authority. */
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
CREATE TABLE IF NOT EXISTS memory_recall_storage(id INTEGER PRIMARY KEY CHECK(id=1),bytes INTEGER NOT NULL CHECK(bytes>=0));
INSERT OR IGNORE INTO memory_recall_storage VALUES(1,0);
CREATE TRIGGER IF NOT EXISTS memory_recall_change_trim AFTER INSERT ON memory_recall_changes BEGIN
 UPDATE memory_recall_epoch SET projection_floor=max(projection_floor,NEW.sequence-1000000) WHERE id=1;
 DELETE FROM memory_recall_changes WHERE sequence=NEW.sequence-1000000; END;
${['memory_recall_view_scopes','memory_recall_view_records','memory_recall_view_terms','memory_recall_view_pending','memory_recall_view_jobs','memory_recall_contains'].map(table=>{
 const cost=(row:string)=>table==='memory_recall_view_terms'?`(512+4*length(CAST(${row}.term AS BLOB)))`: '512';
 return `CREATE TRIGGER IF NOT EXISTS ${table}_storage_i BEFORE INSERT ON ${table} BEGIN
 SELECT CASE WHEN (SELECT bytes FROM memory_recall_storage WHERE id=1)+${cost('NEW')}>536870912 THEN RAISE(ABORT,'MEMORY_RECALL_STORAGE_LIMIT') END;
 UPDATE memory_recall_storage SET bytes=bytes+${cost('NEW')} WHERE id=1; END;
 CREATE TRIGGER IF NOT EXISTS ${table}_storage_d AFTER DELETE ON ${table} BEGIN UPDATE memory_recall_storage SET bytes=bytes-${cost('OLD')} WHERE id=1; END;`;
}).join('\n')}
CREATE TRIGGER IF NOT EXISTS memory_recall_record_i AFTER INSERT ON memory_records BEGIN INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('record',NEW.id,NEW.version); END;
CREATE TRIGGER IF NOT EXISTS memory_recall_record_u AFTER UPDATE ON memory_records BEGIN INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('record',OLD.id,OLD.version); INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('record',NEW.id,NEW.version); END;
CREATE TRIGGER IF NOT EXISTS memory_recall_record_d AFTER DELETE ON memory_records BEGIN INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('record',OLD.id,OLD.version); END;
CREATE TRIGGER IF NOT EXISTS memory_recall_job_i AFTER INSERT ON memory_jobs BEGIN INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('job',NEW.id,0); END;
CREATE TRIGGER IF NOT EXISTS memory_recall_job_u AFTER UPDATE ON memory_jobs BEGIN INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('job',NEW.id,0); END;
CREATE TRIGGER IF NOT EXISTS memory_recall_job_d AFTER DELETE ON memory_jobs BEGIN INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('job',OLD.id,0); END;
CREATE TRIGGER IF NOT EXISTS memory_recall_projection_i AFTER INSERT ON memory_projection_receipts BEGIN INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('record',NEW.record_id,NEW.record_version); END;
CREATE TRIGGER IF NOT EXISTS memory_recall_projection_u AFTER UPDATE ON memory_projection_receipts BEGIN INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('record',NEW.record_id,NEW.record_version); END;
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
      CREATE TABLE memory_records(id,version); CREATE TABLE memory_jobs(id); CREATE TABLE memory_projection_receipts(record_id,record_version);
      CREATE TABLE memory_meta(policy_revision,deletion_epoch);`);
    db.exec(RECALL_VIEW_SCHEMA);
    expected = new Map((db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name LIKE 'memory_recall_%' OR tbl_name LIKE 'memory_recall_%'").all() as unknown as Array<{type:string;name:string;tbl_name:string;sql:string|null}>).map(row=>[row.name,row]));
    return expected;
  } finally { db.close(); }
}
export function ensureRecallViewSchema(db: DatabaseSync) {
  db.exec(RECALL_VIEW_SCHEMA);
  db.exec(`INSERT OR IGNORE INTO memory_recall_excluded SELECT DISTINCT CAST(e.value AS TEXT) FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings'`);
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
