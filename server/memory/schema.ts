import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/** Ordinary authoritative tables only. Search indexes are rebuilt separately. */
export const MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_meta (
 id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL CHECK(schema_version=1),
 installation_id TEXT NOT NULL, policy_revision INTEGER NOT NULL DEFAULT 0 CHECK(policy_revision>=0),
 deletion_epoch INTEGER NOT NULL DEFAULT 0 CHECK(deletion_epoch>=0),
 data_revision INTEGER NOT NULL DEFAULT 0 CHECK(data_revision>=0),
 mode TEXT NOT NULL DEFAULT 'off' CHECK(mode IN ('off','capture','active','paused')));
CREATE TABLE IF NOT EXISTS memory_scopes (
 id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('conversation','bot','room','team','project','workspace','preferences')),
 owner_key TEXT NOT NULL, audience TEXT NOT NULL CHECK(json_valid(audience)), revision INTEGER NOT NULL CHECK(revision>=0));
CREATE TABLE IF NOT EXISTS memory_scope_bindings (
 id TEXT PRIMARY KEY NOT NULL, scope_id TEXT NOT NULL REFERENCES memory_scopes(id), subject_type TEXT NOT NULL,
 subject_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), state TEXT NOT NULL CHECK(state IN ('granted','pending','revoked')),
 intent TEXT NOT NULL CHECK(json_valid(intent)));
CREATE INDEX IF NOT EXISTS memory_bindings_subject ON memory_scope_bindings(subject_type,subject_id);
CREATE TABLE IF NOT EXISTS memory_sources (
 id TEXT PRIMARY KEY NOT NULL, scope_id TEXT NOT NULL REFERENCES memory_scopes(id), thread_id TEXT,
 message_id TEXT, turn_id TEXT, revision INTEGER NOT NULL CHECK(revision>=0), content_hash TEXT NOT NULL,
 kind TEXT NOT NULL, speaker TEXT NOT NULL, outcome TEXT NOT NULL, branch_id TEXT,
 state TEXT NOT NULL CHECK(state IN ('active','retired','deleted')));
CREATE INDEX IF NOT EXISTS memory_sources_thread ON memory_sources(thread_id,message_id);
CREATE TABLE IF NOT EXISTS memory_source_versions (
 source_id TEXT NOT NULL REFERENCES memory_sources(id), revision INTEGER NOT NULL CHECK(revision>=0),
 content_hash TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), created_at INTEGER NOT NULL CHECK(created_at>=0),
 PRIMARY KEY(source_id,revision));
CREATE TABLE IF NOT EXISTS memory_jobs (
 id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL, source_revision INTEGER NOT NULL, stage TEXT NOT NULL,
 stage_version TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','leased','partial','deferred','complete','failed','cancelled')),
 cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor>=0), coverage TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(coverage)),
 retry_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 lease_owner TEXT, lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation>=0), lease_until INTEGER NOT NULL DEFAULT 0,
 policy_revision INTEGER NOT NULL, deletion_epoch INTEGER NOT NULL, error TEXT,
 FOREIGN KEY(source_id,source_revision) REFERENCES memory_source_versions(source_id,revision),
 UNIQUE(source_id,source_revision,stage,stage_version));
CREATE INDEX IF NOT EXISTS memory_jobs_pending ON memory_jobs(status,retry_at);
CREATE TABLE IF NOT EXISTS memory_records (
 id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>=1), scope_id TEXT NOT NULL REFERENCES memory_scopes(id),
 kind TEXT NOT NULL, text TEXT NOT NULL, assertion TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('candidate','active','superseded','archived','deleted')),
 owner_pinned INTEGER NOT NULL DEFAULT 0 CHECK(owner_pinned IN (0,1)), valid_from INTEGER NOT NULL,
 valid_to INTEGER, supersedes_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(id,version));
CREATE INDEX IF NOT EXISTS memory_records_scope ON memory_records(scope_id,state);
CREATE TABLE IF NOT EXISTS memory_evidence (
 record_id TEXT NOT NULL, record_version INTEGER NOT NULL, source_id TEXT NOT NULL, source_revision INTEGER NOT NULL,
 start_byte INTEGER NOT NULL CHECK(start_byte>=0), end_byte INTEGER NOT NULL CHECK(end_byte>=start_byte),
 PRIMARY KEY(record_id,record_version,source_id,source_revision,start_byte),
 FOREIGN KEY(record_id,record_version) REFERENCES memory_records(id,version),
 FOREIGN KEY(source_id,source_revision) REFERENCES memory_source_versions(source_id,revision));
CREATE TABLE IF NOT EXISTS memory_derivations (
 parent_id TEXT NOT NULL, parent_version INTEGER NOT NULL, child_id TEXT NOT NULL, child_version INTEGER NOT NULL,
 PRIMARY KEY(parent_id,parent_version,child_id,child_version),
 FOREIGN KEY(parent_id,parent_version) REFERENCES memory_records(id,version),
 FOREIGN KEY(child_id,child_version) REFERENCES memory_records(id,version));
CREATE TABLE IF NOT EXISTS memory_tombstones (
 id TEXT PRIMARY KEY NOT NULL, target_type TEXT NOT NULL CHECK(target_type IN ('source','record','import')),
 target_id TEXT NOT NULL, revision INTEGER, content_hash TEXT, epoch INTEGER NOT NULL CHECK(epoch>=0), reason TEXT NOT NULL,
 created_at INTEGER NOT NULL, UNIQUE(target_type,target_id,revision));
CREATE TABLE IF NOT EXISTS memory_projection_receipts (
 record_id TEXT NOT NULL, record_version INTEGER NOT NULL, index_generation INTEGER NOT NULL,
 lexical_status TEXT NOT NULL, embedding_status TEXT NOT NULL, error TEXT,
 PRIMARY KEY(record_id,record_version,index_generation), FOREIGN KEY(record_id,record_version) REFERENCES memory_records(id,version));
CREATE TABLE IF NOT EXISTS memory_disclosures (
 bundle_id TEXT PRIMARY KEY NOT NULL, thread_id TEXT NOT NULL, driver_instance TEXT NOT NULL, native_session TEXT,
 record_versions TEXT NOT NULL CHECK(json_valid(record_versions)), source_versions TEXT NOT NULL CHECK(json_valid(source_versions)),
 output_message_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(output_message_ids)),
 policy_revision INTEGER NOT NULL, deletion_epoch INTEGER NOT NULL, token_count INTEGER NOT NULL CHECK(token_count>=0),
 state TEXT NOT NULL CHECK(state IN ('prepared','delivered','revoked')), created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS memory_projection_pending ON memory_projection_receipts(lexical_status,record_id,record_version);
CREATE INDEX IF NOT EXISTS memory_disclosures_thread ON memory_disclosures(thread_id,driver_instance,native_session);
CREATE INDEX IF NOT EXISTS memory_derivations_child ON memory_derivations(child_id,child_version);
`;

type SchemaRow = {type: string; name: string; tbl_name: string; sql: string | null};
let expected: Map<string, SchemaRow> | undefined;
function expectedSchema() {
  if (expected) return expected;
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(MEMORY_SCHEMA);
    expected = new Map((db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema").all() as SchemaRow[]).map(row => [row.name,row]));
    return expected;
  } finally { db.close(); }
}

/** Read-only archive validation. Never executes schema supplied by an archive. */
export function validateMemorySchema(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema").all() as SchemaRow[];
  const memoryRows = rows.filter(row => row.name.startsWith("memory_") || row.tbl_name.startsWith("memory_"));
  if (!memoryRows.length) return new Set(); // private.7 legacy archive
  const schema = expectedSchema();
  if (memoryRows.length !== schema.size) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  for (const row of memoryRows) {
    const wanted = schema.get(row.name);
    if (!wanted || row.type !== wanted.type || row.tbl_name !== wanted.tbl_name || row.sql !== wanted.sql) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  }
  const meta = db.prepare("SELECT * FROM memory_meta").all();
  if (meta.length !== 1 || meta[0].schema_version !== 1 || !/^[a-f0-9-]{36}$/.test(String(meta[0].installation_id))) throw new Error("INVALID_MEMORY_META");
  if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("INVALID_MEMORY_REFERENCE");
  for (const [table,column,kind] of [
    ["memory_scopes","audience","array"], ["memory_scope_bindings","intent","object"],
    ["memory_source_versions","payload","object"], ["memory_disclosures","record_versions","array"],
    ["memory_disclosures","source_versions","array"], ["memory_disclosures","output_message_ids","array"],
  ]) {
    if (db.prepare(`SELECT 1 FROM ${table} WHERE json_type(${column})!=? LIMIT 1`).get(kind)) throw new Error("INVALID_MEMORY_JSON_SHAPE");
  }
  if (db.prepare("SELECT 1 FROM memory_records WHERE assertion NOT IN ('owner-statement','tool-observation','assistant-inference','unverified-import') LIMIT 1").get()) throw new Error("INVALID_MEMORY_ASSERTION");
  return new Set(memoryRows.map(row => row.name));
}

export function migrateMemorySchema(db: DatabaseSync, initialMode: "off" | "active" = "off") {
  const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_meta'").get();
  if (exists) { validateMemorySchema(db); return; }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(MEMORY_SCHEMA);
    db.prepare("INSERT INTO memory_meta(id,schema_version,installation_id,mode) VALUES(1,1,?,?)").run(randomUUID(),initialMode);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
