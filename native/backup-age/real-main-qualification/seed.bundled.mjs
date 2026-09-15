// native/backup-age/real-main-qualification/seed.ts
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { createHash } from "node:crypto";

// server/message-tables.ts
function initializeMessageTables(db2) {
  db2.exec(`CREATE TABLE IF NOT EXISTS messages (
      thread_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL,
      kind TEXT NOT NULL, text TEXT, json TEXT NOT NULL, PRIMARY KEY(thread_id,id));
      CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id);
      CREATE TABLE IF NOT EXISTS thread_state(thread_id TEXT PRIMARY KEY, active_leaf_id TEXT);`);
}

// server/image-operations-schema.ts
function initializeImageOperations(db2) {
  db2.exec("CREATE TABLE IF NOT EXISTS image_operations(id TEXT PRIMARY KEY, generation TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, state TEXT NOT NULL, result TEXT, updated_at INTEGER NOT NULL)");
}

// server/memory/schema.ts
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
var MEMORY_SCHEMA = `
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
var expected;
function expectedSchema() {
  if (expected) return expected;
  const db2 = new DatabaseSync(":memory:");
  try {
    db2.exec(MEMORY_SCHEMA);
    expected = new Map(db2.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema").all().map((row) => [row.name, row]));
    return expected;
  } finally {
    db2.close();
  }
}
function validateMemorySchema(db2) {
  const rows = db2.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema").all();
  const memoryRows = rows.filter((row) => row.name.startsWith("memory_") || row.tbl_name.startsWith("memory_"));
  if (!memoryRows.length) return /* @__PURE__ */ new Set();
  const schema = expectedSchema();
  if (memoryRows.length !== schema.size) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  for (const row of memoryRows) {
    const wanted = schema.get(row.name);
    if (!wanted || row.type !== wanted.type || row.tbl_name !== wanted.tbl_name || row.sql !== wanted.sql) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  }
  const meta = db2.prepare("SELECT * FROM memory_meta").all();
  if (meta.length !== 1 || meta[0].schema_version !== 1 || !/^[a-f0-9-]{36}$/.test(String(meta[0].installation_id))) throw new Error("INVALID_MEMORY_META");
  if (db2.prepare("PRAGMA foreign_key_check").all().length) throw new Error("INVALID_MEMORY_REFERENCE");
  for (const [table, column, kind] of [
    ["memory_scopes", "audience", "array"],
    ["memory_scope_bindings", "intent", "object"],
    ["memory_source_versions", "payload", "object"],
    ["memory_disclosures", "record_versions", "array"],
    ["memory_disclosures", "source_versions", "array"],
    ["memory_disclosures", "output_message_ids", "array"]
  ]) {
    if (db2.prepare(`SELECT 1 FROM ${table} WHERE json_type(${column})!=? LIMIT 1`).get(kind)) throw new Error("INVALID_MEMORY_JSON_SHAPE");
  }
  if (db2.prepare("SELECT 1 FROM memory_records WHERE assertion NOT IN ('owner-statement','tool-observation','assistant-inference','unverified-import') LIMIT 1").get()) throw new Error("INVALID_MEMORY_ASSERTION");
  return new Set(memoryRows.map((row) => row.name));
}
function migrateMemorySchema(db2, initialMode = "off") {
  const exists = db2.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_meta'").get();
  if (exists) {
    validateMemorySchema(db2);
    return;
  }
  db2.exec("BEGIN IMMEDIATE");
  try {
    db2.exec(MEMORY_SCHEMA);
    db2.prepare("INSERT INTO memory_meta(id,schema_version,installation_id,mode) VALUES(1,1,?,?)").run(randomUUID(), initialMode);
    db2.exec("COMMIT");
  } catch (error) {
    db2.exec("ROLLBACK");
    throw error;
  }
}

// native/backup-age/real-main-qualification/seed.ts
var root = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !root.endsWith("real-main-qualification")) throw Error("Explicit fresh qualification root required");
mkdirSync(root);
for (const name of ["data", "user-data", "home", "temp", "exports", "keys", "evidence"]) mkdirSync(join(root, name));
var data = join(root, "data");
var json = (name, value) => writeFileSync(join(data, name), JSON.stringify(value) + "\n", { flag: "wx" });
json("config.json", { profile: { name: "Synthetic Windows backup" }, instances: { fixture: { driver: "fuigoAgent", enabled: true, config: { apiKey: "FAKE-B20-PRIVATE-CANARY" } } } });
json("bots.json", [{ id: "bot", threadId: "thread", name: "Synthetic", autoApprove: true, resumeCursors: { fixture: "synthetic" } }]);
json("groups.json", []);
json("startup-background.json", { keepRunning: true, startAtLogin: true });
mkdirSync(join(data, "workspaces"));
writeFileSync(join(data, "workspaces", "report.md"), "B20 synthetic saved output\n", { flag: "wx" });
var db = new DatabaseSync2(join(data, "messages.db"));
try {
  initializeMessageTables(db);
  initializeImageOperations(db);
  migrateMemorySchema(db, "active");
  db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run(
    "thread",
    "receipt",
    1,
    "bot",
    "goal.run",
    null,
    JSON.stringify({ id: "receipt", at: 1, role: "bot", kind: "goal.run", goalRun: { status: "completed", detail: "B20 synthetic receipt" } })
  );
  db.exec("INSERT INTO thread_state VALUES('thread','receipt')");
  db.prepare("INSERT INTO memory_tombstones(id,target_type,target_id,epoch,reason,created_at) VALUES(?,?,?,?,?,?)").run("b20-tombstone", "source", "synthetic-deleted-source", 1, "synthetic deletion", 1);
  db.exec("UPDATE memory_meta SET deletion_epoch=1 WHERE id=1");
} finally {
  db.close();
}
var files = {};
function inventory(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) inventory(file);
    else {
      const stat = statSync(file, { bigint: true });
      files[relative(data, file).replaceAll("\\", "/")] = {
        sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
        dev: String(stat.dev),
        ino: String(stat.ino)
      };
    }
  }
}
inventory(data);
writeFileSync(join(root, "evidence", "source-files.json"), JSON.stringify(files, null, 2) + "\n", { flag: "wx" });
