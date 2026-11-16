// Checkpoint publication producer/consumer: recall-s1s2k; memory integration: MurageMain.
import { DatabaseSync } from '../sqlite-open.ts';

const SQL = `
CREATE TABLE IF NOT EXISTS memory_checkpoint_heads (
 family_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, thread_id TEXT NOT NULL,
 sequence INTEGER NOT NULL DEFAULT 0 CHECK(sequence>=0),
 record_id TEXT, record_version INTEGER,
 state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','archived','forgotten')),
 UNIQUE(scope_id,thread_id), CHECK((record_id IS NULL)=(record_version IS NULL))
);
CREATE TABLE IF NOT EXISTS memory_checkpoint_members (
 family_id TEXT NOT NULL REFERENCES memory_checkpoint_heads(family_id), sequence INTEGER NOT NULL,
 record_id TEXT NOT NULL, record_version INTEGER NOT NULL, handles TEXT NOT NULL CHECK(json_valid(handles)),
 PRIMARY KEY(family_id,sequence), UNIQUE(record_id,record_version)
);
CREATE TABLE IF NOT EXISTS memory_checkpoint_publications (
 family_id TEXT NOT NULL REFERENCES memory_checkpoint_heads(family_id), job_id TEXT NOT NULL,
 record_id TEXT NOT NULL, record_version INTEGER NOT NULL,
 PRIMARY KEY(family_id,job_id)
);
CREATE TABLE IF NOT EXISTS memory_checkpoint_exclusions (
 family_id TEXT NOT NULL REFERENCES memory_checkpoint_heads(family_id), source_id TEXT NOT NULL, source_revision INTEGER NOT NULL,
 PRIMARY KEY(family_id,source_id,source_revision)
);
`;
let objects:Map<string,{type:string;tbl_name:string;sql:string|null}>|undefined;
export function checkpointSchemaObjects() {
 if(!objects){const db=new DatabaseSync(':memory:');try{db.exec(SQL);objects=new Map((db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name LIKE 'memory_checkpoint_%'").all() as Array<{name:string;type:string;tbl_name:string;sql:string|null}>).map(row=>[row.name,row]));}finally{db.close();}}
 return objects;
}
/** Downgrade consumer: MurageMain; checkpoint metadata producer: recall-s1s2k.
 * Family membership and exclusions cannot be reconstructed by an older binary.
 * Only an entirely unused extension may leave without discarding owner state. */
export function assertCheckpointDowngradeSafe(db:DatabaseSync) {
 if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_checkpoint_heads'").get())return;
 for(const table of ['memory_checkpoint_heads','memory_checkpoint_members','memory_checkpoint_publications','memory_checkpoint_exclusions'])
  if(db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())throw new Error('MEMORY_SCHEMA_UNSUPPORTED');
}
export function dropEmptyCheckpointSchema(db:DatabaseSync) {
 assertCheckpointDowngradeSafe(db);
 db.exec('DROP TABLE IF EXISTS memory_checkpoint_exclusions; DROP TABLE IF EXISTS memory_checkpoint_publications; DROP TABLE IF EXISTS memory_checkpoint_members; DROP TABLE IF EXISTS memory_checkpoint_heads');
}
/** Metadata only: legacy records, archived versions and receipts remain byte-for-byte intact. */
export function ensureCheckpointSchema(db:DatabaseSync) {
 const installed=Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_checkpoint_heads'").get());
 if(installed)return;
 const nested=db.isTransaction;
 db.exec(nested?'SAVEPOINT checkpoint_schema':'BEGIN IMMEDIATE');
 try {
  db.exec(SQL);
  // Legacy publication used the deterministic family id. Seed only a valid active head.
  const rows=db.prepare("SELECT r.* FROM memory_records r WHERE r.kind='checkpoint' AND r.state='active' AND r.id LIKE 'checkpoint:%' AND NOT EXISTS(SELECT 1 FROM memory_records n WHERE n.id=r.id AND n.version>r.version) AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.target_type='record' AND t.target_id=r.id AND (t.revision IS NULL OR t.revision=r.version))").all();
  for(const row of rows){
   const evidence=db.prepare('SELECT e.source_id AS sourceId,e.source_revision AS revision,e.start_byte AS startByte,e.end_byte AS endByte,s.thread_id,s.state,s.revision AS currentRevision FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id WHERE e.record_id=? AND e.record_version=? ORDER BY e.source_id').all(row.id,row.version);
   const thread=evidence[0]?.thread_id;
   if(typeof thread!=='string'||!evidence.length||evidence.some(e=>e.thread_id!==thread||e.state!=='active'||e.currentRevision!==e.revision)||db.prepare("SELECT 1 FROM memory_evidence e JOIN memory_tombstones t ON t.target_type='source' AND t.target_id=e.source_id AND (t.revision IS NULL OR t.revision=e.source_revision) WHERE e.record_id=? AND e.record_version=? LIMIT 1").get(row.id,row.version))continue;
   const handles=evidence.map(({sourceId,revision,startByte,endByte})=>({sourceId,revision,startByte,endByte}));
   db.prepare('INSERT INTO memory_checkpoint_heads(family_id,scope_id,thread_id,sequence,record_id,record_version) VALUES(?,?,?,1,?,?)').run(row.id,row.scope_id,thread,row.id,row.version);
   db.prepare('INSERT INTO memory_checkpoint_members VALUES(?,1,?,?,?)').run(row.id,row.id,row.version,JSON.stringify(handles));
  }
  db.exec(nested?'RELEASE checkpoint_schema':'COMMIT');
 } catch(error){db.exec(nested?'ROLLBACK TO checkpoint_schema; RELEASE checkpoint_schema':'ROLLBACK');throw error;}
}
