import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_MEMORY_LEARNING, memoryLearningSchema } from "./learning-policy.ts";

/** Ordinary authoritative tables only. Search indexes are rebuilt separately. */
export const MEMORY_SCHEMA_V1 = `
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

const LEARNING_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_record_details (
 record_id TEXT NOT NULL, record_version INTEGER NOT NULL,
 partition TEXT NOT NULL CHECK(partition IN ('working','episodic','semantic','procedural','identity')),
 attention TEXT NOT NULL CHECK(attention IN ('current','useful','historical')),
 claim_status TEXT NOT NULL CHECK(claim_status IN ('provisional','current','disputed')),
 entities TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(entities) AND json_type(entities)='array'),
 confidence REAL CHECK(confidence IS NULL OR (confidence>=0 AND confidence<=1)),
 confidence_basis TEXT, observed_at INTEGER CHECK(observed_at IS NULL OR observed_at>=0),
 PRIMARY KEY(record_id,record_version), FOREIGN KEY(record_id,record_version) REFERENCES memory_records(id,version) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS memory_learning_config (
 id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>=0),
 settings TEXT NOT NULL CHECK(json_valid(settings) AND json_type(settings)='object'));
CREATE TRIGGER IF NOT EXISTS memory_record_details_insert AFTER INSERT ON memory_records BEGIN
 INSERT INTO memory_record_details(record_id,record_version,partition,attention,claim_status,observed_at)
 VALUES(NEW.id,NEW.version,CASE NEW.kind WHEN 'source' THEN 'episodic' WHEN 'checkpoint' THEN 'working'
 WHEN 'procedure' THEN 'procedural' WHEN 'identity' THEN 'identity' ELSE 'semantic' END,
 CASE WHEN NEW.state IN ('archived','superseded','deleted') THEN 'historical' ELSE 'useful' END,
 CASE WHEN NEW.state='candidate' THEN 'provisional' ELSE 'current' END,NULL);
END;
CREATE TRIGGER IF NOT EXISTS memory_record_details_state AFTER UPDATE OF state ON memory_records BEGIN
 UPDATE memory_record_details SET
 attention=CASE WHEN NEW.state IN ('archived','superseded','deleted') THEN 'historical' ELSE 'useful' END,
 claim_status=CASE WHEN NEW.state='candidate' THEN 'provisional' WHEN OLD.state='candidate' AND NEW.state='active' THEN 'current' ELSE claim_status END,
 entities=CASE WHEN NEW.state='deleted' THEN '[]' ELSE entities END,
 confidence=CASE WHEN NEW.state='deleted' THEN NULL ELSE confidence END,
 confidence_basis=CASE WHEN NEW.state='deleted' THEN NULL ELSE confidence_basis END,
 observed_at=CASE WHEN NEW.state='deleted' THEN NULL ELSE observed_at END
 WHERE record_id=NEW.id AND record_version=NEW.version;
END;
`;
export const MEMORY_SCHEMA_VERSION = 2;
export const MEMORY_SCHEMA = MEMORY_SCHEMA_V1.replace("CHECK(schema_version=1)", "CHECK(schema_version=2)") + LEARNING_SCHEMA;

type SchemaRow = {type: string; name: string; tbl_name: string; sql: string | null};
const expected = new Map<number, Map<string, SchemaRow>>();
function expectedSchema(version: number) {
  const cached = expected.get(version);
  if (cached) return cached;
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(version === 1 ? MEMORY_SCHEMA_V1 : MEMORY_SCHEMA);
    const schema = new Map((db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema").all() as SchemaRow[]).map(row => [row.name,row]));
    expected.set(version, schema);
    return schema;
  } finally { db.close(); }
}

/** Read-only archive validation. Never executes schema supplied by an archive.
 *
 * `references` controls the FULL-FILE foreign key sweep. It is the one check
 * here that is not proportional to the schema: `PRAGMA foreign_key_check`
 * walks every reference in the database, measured at 1.86s on a real 312MB
 * store, while every other check in this function costs single-digit
 * milliseconds. It ran on EVERY database open, including the overwhelmingly
 * common one where the schema is already current and nothing is going to be
 * rewritten — around two seconds of every app start, spent re-proving what
 * `PRAGMA foreign_keys=ON` (set in database()) already enforces on every
 * write this installation makes.
 *
 * So it is spent where it can still buy something: a schema rewrite, and any
 * file that came from outside this installation — restore, merge, archive,
 * downgrade. Those keep the sweep, and it defaults to on, so a new caller
 * gets the strict behaviour unless it opts out on purpose. A boolean is
 * evaluated lazily as a callback when the decision depends on the meta row,
 * which this function only trusts after it has validated its shape. */
export function validateMemorySchema(db: DatabaseSync, options: { references?: boolean | (() => boolean) } = {}): Set<string> {
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema").all() as SchemaRow[];
  const memoryRows = rows.filter(row => row.name.startsWith("memory_") || row.tbl_name.startsWith("memory_"));
  if (!memoryRows.length) return new Set(); // private.7 legacy archive
  // Recognize only an exact known meta table before reading its version field.
  const metaSchema = memoryRows.find(row => row.name === "memory_meta");
  const version = [1, 2].find(value => metaSchema?.sql === expectedSchema(value).get("memory_meta")?.sql);
  if (!version) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  const schema = expectedSchema(version);
  if (memoryRows.length !== schema.size) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  for (const row of memoryRows) {
    const wanted = schema.get(row.name);
    if (!wanted || row.type !== wanted.type || row.tbl_name !== wanted.tbl_name || row.sql !== wanted.sql) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  }
  const meta = db.prepare("SELECT * FROM memory_meta").all();
  if (meta.length !== 1 || meta[0].schema_version !== version || !/^[a-f0-9-]{36}$/.test(String(meta[0].installation_id))) throw new Error("INVALID_MEMORY_META");
  const sweep = options.references ?? true;
  if ((typeof sweep === "function" ? sweep() : sweep) && db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("INVALID_MEMORY_REFERENCE");
  for (const [table,column,kind] of [
    ["memory_scopes","audience","array"], ["memory_scope_bindings","intent","object"],
    ["memory_source_versions","payload","object"], ["memory_disclosures","record_versions","array"],
    ["memory_disclosures","source_versions","array"], ["memory_disclosures","output_message_ids","array"],
  ]) {
    if (db.prepare(`SELECT 1 FROM ${table} WHERE json_type(${column})!=? LIMIT 1`).get(kind)) throw new Error("INVALID_MEMORY_JSON_SHAPE");
  }
  if (db.prepare("SELECT 1 FROM memory_records WHERE assertion NOT IN ('owner-statement','tool-observation','assistant-inference','unverified-import') LIMIT 1").get()) throw new Error("INVALID_MEMORY_ASSERTION");
  if (version === 2) {
    const settings = db.prepare("SELECT settings FROM memory_learning_config WHERE id=1").get();
    if (!settings || !memoryLearningSchema.safeParse(JSON.parse(String(settings.settings))).success) throw new Error("INVALID_MEMORY_LEARNING_CONFIG");
    if (db.prepare("SELECT 1 FROM memory_records r LEFT JOIN memory_record_details d ON r.id=d.record_id AND r.version=d.record_version WHERE d.record_id IS NULL LIMIT 1").get()) throw new Error("INVALID_MEMORY_RECORD_DETAILS");
  }
  return new Set(memoryRows.map(row => row.name));
}

/** Consistent single-file copy of a v1 messages.db, taken before the one-way
 * v1 -> v2 memory migration so a 0.1.53 install can be restored by hand.
 * Lives beside messages.db in the data dir; backup sweeps classify it as
 * excluded so it is never archived twice or restored as live data. */
export const MEMORY_PRE_V2_SNAPSHOT = "messages.pre-memory-v2.db";

export interface MigrateMemoryOptions {
  /** Where to write the pre-migration copy. Omitted: no copy (restore/merge paths, tests). */
  snapshotPath?: string;
}

function snapshotBeforeMigration(db: DatabaseSync, path: string) {
  if (existsSync(path)) return; // an earlier attempt already preserved the v1 file
  if (db.isTransaction) throw new Error("MEMORY_SCHEMA_SNAPSHOT_FAILED: VACUUM INTO cannot run inside a transaction");
  try {
    db.prepare("VACUUM INTO ?").run(path);
    try { chmodSync(path, 0o600); } catch { /* matches messages.db handling on platforms without POSIX modes */ }
  } catch (error) {
    try { rmSync(path, { force: true }); } catch { /* partial output already absent */ }
    const reason = error instanceof Error ? error.message : String(error);
    throw Object.assign(new Error(`MEMORY_SCHEMA_SNAPSHOT_FAILED: ${reason}`), { code: "MEMORY_SCHEMA_SNAPSHOT_FAILED", cause: error });
  }
}

export function migrateMemorySchema(db: DatabaseSync, initialMode: "off" | "active" = "off", options: MigrateMemoryOptions = {}) {
  const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_meta'").get();
  if (exists) {
    // Structure, meta and row shapes on every open; the whole-file reference
    // sweep only when this open is actually going to rewrite the schema.
    validateMemorySchema(db, { references: () => db.prepare("SELECT schema_version FROM memory_meta WHERE id=1").get()?.schema_version !== MEMORY_SCHEMA_VERSION });
    if (db.prepare("SELECT schema_version FROM memory_meta WHERE id=1").get()?.schema_version === MEMORY_SCHEMA_VERSION) return;
    // Fail closed: without the copy the upgrade would be irreversible for a 0.1.53 reinstall.
    if (options.snapshotPath) snapshotBeforeMigration(db, options.snapshotPath);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    if (exists) {
      db.exec("ALTER TABLE memory_meta RENAME TO memory_meta_v1;");
      db.exec(MEMORY_SCHEMA);
      db.exec(`INSERT INTO memory_meta SELECT id,2,installation_id,policy_revision,deletion_epoch,data_revision,mode FROM memory_meta_v1;
        DROP TABLE memory_meta_v1;
        INSERT INTO memory_record_details(record_id,record_version,partition,attention,claim_status,observed_at)
        SELECT id,version,CASE kind WHEN 'source' THEN 'episodic' WHEN 'checkpoint' THEN 'working' WHEN 'procedure' THEN 'procedural' WHEN 'identity' THEN 'identity' ELSE 'semantic' END,
          CASE WHEN state IN ('archived','superseded','deleted') THEN 'historical' ELSE 'useful' END,
          CASE WHEN state='candidate' THEN 'provisional' ELSE 'current' END,NULL FROM memory_records;`);
    } else {
      db.exec(MEMORY_SCHEMA);
      db.prepare("INSERT INTO memory_meta(id,schema_version,installation_id,mode) VALUES(1,2,?,?)").run(randomUUID(),initialMode);
    }
    // An existing install kept every candidate in "Needs review" before v2; keep
    // that behaviour until the owner opts into automatic activation. Fresh installs
    // take the shipped default. dailyCostUsd stays null: any value disables learning.
    const learning = exists ? { ...DEFAULT_MEMORY_LEARNING, reviewMode: true } : DEFAULT_MEMORY_LEARNING;
    db.prepare("INSERT INTO memory_learning_config VALUES(1,0,?)").run(JSON.stringify(learning));
    validateMemorySchema(db);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

/** Exact inverse of the v1 -> v2 branch above, for reinstalling a 0.1.x
 * build: drops the two learning tables and two triggers and restores the
 * frozen v1 memory_meta text. Chats and memory rows written after the upgrade
 * survive; learning details and the learning policy are discarded, and the
 * next 0.1.54+ start re-runs the same migration. Caller owns no transaction. */
export function downgradeMemorySchema(db: DatabaseSync): { status: "downgraded" | "already-v1"; from: number; to: 1 } {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_meta'").get()) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  validateMemorySchema(db);
  const from = Number(db.prepare("SELECT schema_version FROM memory_meta WHERE id=1").get()?.schema_version);
  if (from === 1) return { status: "already-v1", from, to: 1 };
  if (from !== MEMORY_SCHEMA_VERSION) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`DROP TRIGGER memory_record_details_insert; DROP TRIGGER memory_record_details_state;
      DROP TABLE memory_record_details; DROP TABLE memory_learning_config;
      ALTER TABLE memory_meta RENAME TO memory_meta_v2;`);
    db.exec(MEMORY_SCHEMA_V1); // CREATE IF NOT EXISTS: only memory_meta (v1 text) is recreated
    db.exec(`INSERT INTO memory_meta SELECT id,1,installation_id,policy_revision,deletion_epoch,data_revision,mode FROM memory_meta_v2;
      DROP TABLE memory_meta_v2;`);
    if (db.prepare("SELECT schema_version FROM memory_meta WHERE id=1").get()?.schema_version !== 1) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
    validateMemorySchema(db);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { status: "downgraded", from, to: 1 };
}
