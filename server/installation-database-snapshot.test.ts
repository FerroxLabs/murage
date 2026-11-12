import { seedCopyIntents } from "./testing/fts-copy-fixture.ts";
import { trigramQuery } from "./message-search-index.ts";
import { Worker } from "node:worker_threads";
import { spawn } from "node:child_process";
import { createDataWriterGate, stopDataWriters } from "./data-writers.ts";
import { removeMessageSearchFiles, settleFtsCopy } from "./settle-copy.ts";
import type { MemoryDowngradeTarget } from "./memory/schema.ts";
import { downgradeInstallationMemorySchema } from "./installation-memory-downgrade.ts";
import { classifyDataDirEntry } from "./data-dir-inventory.ts";
import { stageInstallationState } from "./installation-state-snapshot.ts";
import * as downgrade from "./installation-app-schema-downgrade.ts";
import { ADDED_TABLE_LIFECYCLE } from "./added-table-lifecycle.ts";
import { RESTORE_NOT_PENDING_WORK } from "./restore-fence.ts";
import { DEFAULT_MEMORY_LEARNING_V1 } from "./memory/learning-policy.ts";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, rmSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireDataDirLease } from "../electron/data-dir-lease.mjs";
import { initializeArtifacts } from "./artifacts.ts";
import { initializeInbox } from "./inbox.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { initializeImageLibrary, initializeImageOperations } from "./image-operations-schema.ts";
import { initializeThreadSnooze } from "./thread-snooze.ts";
import { initializeHighLevelThreadMarks } from "./highlevel/thread-marks.ts";
import { initializeMobilePush } from "./mobile-push-store.ts";
import { initializeSharedRequestProvenance } from "./shared-provenance-schema.ts";
import { initializePendingDelegations } from "./pending-delegations-schema.ts";
import { initializeDelegationPacks } from "./delegation-pack/schema.ts";
import { inspectInstallationDatabase, snapshotInstallationDatabase, withOfflineInstallation, type OfflineInstallation } from "./installation-database-snapshot.ts";
import { MEMORY_SCHEMA_VERSION,MEMORY_SCHEMA_V2,MEMORY_SCHEMA_V3,migrateMemorySchema } from "./memory/schema.ts";
import { pauseRestoredMemory } from "./memory/restore.ts";
import { readMemoryLearning, updateMemoryLearning } from "./memory/learning-policy.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const roots: string[] = [];
const databases: DatabaseSync[] = [];

it("preserves HighLevel conversation marks in a snapshot and accepts older archives without them", async () => {
  const marked = fixture();
  initializeHighLevelThreadMarks(marked.db);
  marked.db.prepare("INSERT INTO highlevel_thread_marks VALUES (?, ?)").run("t", 1);
  expect(await snapshotInstallationDatabase(marked.data, marked.target)).toMatchObject({ status: "copied" });
  const copy = new DatabaseSync(marked.target);
  try { expect(copy.prepare("SELECT marked_at FROM highlevel_thread_marks WHERE thread_id='t'").get()?.marked_at).toBe(1); }
  finally { copy.close(); }
  const older = fixture();
  expect(inspectInstallationDatabase(older.db)).toMatchObject({ messages: 1, threads: 1 });
  const altered = fixture();
  altered.db.exec("CREATE TABLE highlevel_thread_marks(thread_id TEXT PRIMARY KEY, marked_at TEXT)");
  expect(() => inspectInstallationDatabase(altered.db)).toThrow();
});
/** An installation database with the transcript tables the harness itself
 * creates (server/message-tables.ts), or the DDL an older release wrote. */
function fixture(transcriptDdl?: string) {
  const scratch = mkdtempSync(join(tmpdir(), "murage-db-snapshot-"));
  roots.push(scratch);
  const data = join(scratch, "installation");
  mkdirSync(data);
  const db = new DatabaseSync(join(data, "messages.db"));
  databases.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  if (transcriptDdl) db.exec(transcriptDdl); else initializeMessageTables(db);
  db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES (?,?,?,?,?,?,?)").run("t", "m", 1, "bot", "goal.run", null, JSON.stringify({ id: "m", at: 1, role: "bot", kind: "goal.run", goalRun: { status: "completed", detail: "Receipt canary" } }));
  db.exec("INSERT INTO thread_state VALUES ('t','m')");
  return { scratch, data, db, target: join(scratch, "snapshot.db") };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) removeTempDirSync(root);
});

it("copies v2 memory classification and learning controls into a separate paused database", async () => {
  const f=fixture();migrateMemorySchema(f.db,"active");
  f.db.exec("INSERT INTO memory_scopes VALUES('bot-scope','bot','bot','[]',0);");
  f.db.exec("INSERT INTO memory_records VALUES('fact',1,'bot-scope','fact','A preserved fact','owner-statement','active',1,1,NULL,NULL,1);");
  f.db.exec("UPDATE memory_record_details SET entities='[\"project\"]',confidence=.9,confidence_basis='owner confirmed',observed_at=42;");
  updateMemoryLearning(f.db,{reviewMode:true,ceiling:{input:200,output:200}},0);
  f.db.exec("INSERT INTO memory_learning_events(id,scope_id,kind,record_id,record_version,created_at) VALUES('event','bot-scope','activated','fact',1,1)");
  const original=f.db.prepare("SELECT * FROM memory_record_details").all(),settings=readMemoryLearning(f.db);
  expect(await snapshotInstallationDatabase(f.data,f.target)).toMatchObject({status:"copied"});
  const restored=new DatabaseSync(f.target);
  try{
    expect(restored.prepare("SELECT * FROM memory_record_details").all()).toEqual(original);
    expect(readMemoryLearning(restored)).toEqual(settings);
    expect(restored.prepare("SELECT id,kind FROM memory_learning_events").all()).toEqual([{id:"event",kind:"activated"}]);
    restored.exec("BEGIN IMMEDIATE");expect(pauseRestoredMemory(restored)).toBe(true);restored.exec("COMMIT");
    expect(restored.prepare("SELECT mode FROM memory_meta").get()?.mode).toBe("paused");
  }finally{restored.close();}
  expect(f.db.prepare("SELECT mode FROM memory_meta").get()?.mode).toBe("active");
  expect(f.db.prepare("SELECT * FROM memory_record_details").all()).toEqual(original);
});

it.each([
  ["missing required column", "ALTER TABLE messages DROP COLUMN text", "DATABASE_SCHEMA_UNSUPPORTED"],
  ["unknown trigger", "CREATE TRIGGER hostile AFTER UPDATE ON messages BEGIN DELETE FROM thread_state; END", "DATABASE_SCHEMA_UNSUPPORTED"],
  ["column/JSON disagreement", "UPDATE messages SET role='user'", "INVALID_MESSAGE_IDENTITY"],
  ["malformed parent", `UPDATE messages SET json=json_set(json,'$.parentId','not a message id')`, "INVALID_MESSAGE_PARENT"],
  ["self cycle", `UPDATE messages SET json=json_set(json,'$.parentId','m')`, "CYCLIC_MESSAGE_BRANCH"],
])("refuses %s while preserving the source", async (_name, sql, code) => {
  const f = fixture(); f.db.exec(sql);
  await expect(snapshotInstallationDatabase(f.data, f.target)).rejects.toMatchObject({ code });
  expect(existsSync(f.target)).toBe(false);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM messages").get()?.n).toBe(1);
});

it("preserves valid forks whose parent was inserted after an existing child", async () => {
  const f = fixture();
  f.db.prepare("UPDATE messages SET json=json_set(json,'$.parentId','later')").run();
  f.db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES (?,?,?,?,?,?,?)").run("t", "later", 2, "bot", "text", "parent", JSON.stringify({ id: "later", at: 2, role: "bot", kind: "text", text: "parent", parentId: null }));
  expect(await snapshotInstallationDatabase(f.data, f.target)).toMatchObject({ status: "copied", messages: 2 });
});

it("copies a message whose parent the thread no longer holds, which the runtime reads as a root", async () => {
  const f = fixture();
  f.db.prepare("UPDATE messages SET json=json_set(json,'$.parentId','gone')").run();
  expect(await snapshotInstallationDatabase(f.data, f.target)).toMatchObject({ status: "copied", messages: 1 });
  expect(existsSync(f.target)).toBe(true);
});

it("accepts the inbox and saved-file tables the harness creates, and an older archive without the migrated columns", async () => {
  // A real installation carries every table server/database.ts initializes;
  // the inspector refusing them would refuse every backup made since 0.1.48.
  const f = fixture();
  initializeInbox(f.db); initializeArtifacts(f.db);
  expect(await snapshotInstallationDatabase(f.data, f.target)).toMatchObject({ status: "copied", messages: 1, threads: 1 });
  const older = fixture();
  initializeInbox(older.db); initializeArtifacts(older.db);
  older.db.exec("ALTER TABLE artifacts DROP COLUMN publication_id; ALTER TABLE artifacts DROP COLUMN producer");
  expect(await snapshotInstallationDatabase(older.data, older.target)).toMatchObject({ status: "copied" });
});

it("does not hold the Inbox projection to its byte-exact text: it is derived data that restore discards", async () => {
  // A later release changes a trigger body, a counter or an index in the projection; every archive an earlier release wrote must still restore.
  const f = fixture();
  initializeInbox(f.db);
  f.db.exec(`DROP TRIGGER inbox_project_delete;
    CREATE TRIGGER inbox_project_delete AFTER DELETE ON messages BEGIN /* an earlier release's wording */ DELETE FROM inbox_raw WHERE thread_id=OLD.thread_id AND message_id=OLD.id; END;
    DROP INDEX inbox_raw_rank_4; CREATE INDEX inbox_raw_rank_4 ON inbox_raw(source_key,at DESC);
    DROP INDEX setup_marks_tail_4; CREATE INDEX setup_marks_tail_4 ON setup_marks(thread_id,at);`);
  expect(await snapshotInstallationDatabase(f.data, f.target)).toMatchObject({ status: "copied", messages: 1 });
  // a trigger that is not the projection's is still refused
  const hostile = fixture();
  initializeInbox(hostile.db);
  hostile.db.exec("CREATE TRIGGER hostile AFTER INSERT ON messages BEGIN DELETE FROM thread_state; END");
  await expect(snapshotInstallationDatabase(hostile.data, hostile.target)).rejects.toMatchObject({ code: "DATABASE_SCHEMA_UNSUPPORTED" });
});

it("accepts conversation snoozes with and without the until-new-activity column", async () => {
  const f = fixture();
  initializeThreadSnooze(f.db);
  f.db.prepare("INSERT INTO thread_snooze VALUES('t',2,1,1)").run();
  expect(await snapshotInstallationDatabase(f.data, f.target)).toMatchObject({ status: "copied" });
  const older = fixture();
  older.db.exec(`CREATE TABLE IF NOT EXISTS thread_snooze (
    thread_id TEXT PRIMARY KEY, snoozed_until INTEGER NOT NULL, snoozed_at INTEGER NOT NULL)`);
  expect(await snapshotInstallationDatabase(older.data, older.target)).toMatchObject({ status: "copied" });
  const hostile = fixture();
  initializeThreadSnooze(hostile.db);
  hostile.db.exec("ALTER TABLE thread_snooze ADD COLUMN extra TEXT");
  await expect(snapshotInstallationDatabase(hostile.data, hostile.target)).rejects.toMatchObject({ code: "DATABASE_SCHEMA_UNSUPPORTED" });
});

it("accepts a database built exactly as database() now builds it, including phone push state", () => {
  // database() calls initializeMessageTables, initializeInbox, initializeThreadSnooze,
  // initializeArtifacts and initializeMobilePush (in that order) on every open. If the
  // inspector doesn't know the push tables, every backup, restore and activation on
  // every installation breaks the moment database() runs once (H2 fix round 1).
  const f = fixture();
  initializeInbox(f.db); initializeThreadSnooze(f.db); initializeArtifacts(f.db); initializeMobilePush(f.db);
  expect(inspectInstallationDatabase(f.db)).toMatchObject({ messages: 1, threads: 1 });
});

it("accepts push_risk from before and after H9 added its revision column, with rows", async () => {
  // Plan 3a H9 fix round 1: push_risk gained a nullable revision column by
  // ALTER TABLE, so a database H2's initializer made and one made today (or
  // upgraded in place) must all pass, and a foreign extra column must not.
  const H2_PUSH_RISK = `CREATE TABLE push_risk (
      request_key TEXT PRIMARY KEY, risk TEXT NOT NULL CHECK (risk IN ('low','risky')), rated_at INTEGER NOT NULL)`;
  const older = fixture();
  initializeInbox(older.db); initializeThreadSnooze(older.db); initializeArtifacts(older.db); initializeMobilePush(older.db);
  older.db.exec("ALTER TABLE push_risk DROP COLUMN revision");
  older.db.exec("INSERT INTO push_risk VALUES ('t:r','low',1)");
  expect(inspectInstallationDatabase(older.db)).toMatchObject({ messages: 1, threads: 1 });
  expect(await snapshotInstallationDatabase(older.data, older.target)).toMatchObject({ status: "copied" });

  const upgraded = fixture();
  upgraded.db.exec(H2_PUSH_RISK);
  initializeInbox(upgraded.db); initializeThreadSnooze(upgraded.db); initializeArtifacts(upgraded.db); initializeMobilePush(upgraded.db);
  upgraded.db.exec("INSERT INTO push_risk VALUES ('t:r','low',1,1)");
  expect(inspectInstallationDatabase(upgraded.db)).toMatchObject({ messages: 1, threads: 1 });

  const fresh = fixture();
  initializeInbox(fresh.db); initializeThreadSnooze(fresh.db); initializeArtifacts(fresh.db); initializeMobilePush(fresh.db);
  const text = (db: DatabaseSync) => String((db.prepare("SELECT sql FROM sqlite_schema WHERE name='push_risk'").get() as { sql: string }).sql).replace(/\s+/g, " ");
  expect(text(upgraded.db)).toBe(text(fresh.db));

  const hostile = fixture();
  initializeInbox(hostile.db); initializeThreadSnooze(hostile.db); initializeArtifacts(hostile.db); initializeMobilePush(hostile.db);
  hostile.db.exec("ALTER TABLE push_risk ADD COLUMN extra TEXT");
  expect(() => inspectInstallationDatabase(hostile.db)).toThrow();
});

it("accepts push_bindings before and after key secrets and preview consent, with rows", async () => {
  // Plan 3a final review M2: push_bindings gained a nullable key_secret column
  // by ALTER TABLE (the host-only HMAC key for collapseKey and threadGroup).
  const older = fixture();
  initializeInbox(older.db); initializeThreadSnooze(older.db); initializeArtifacts(older.db); initializeMobilePush(older.db);
  older.db.exec("ALTER TABLE push_bindings DROP COLUMN rings_for_calls; ALTER TABLE push_bindings DROP COLUMN preview_content; ALTER TABLE push_bindings DROP COLUMN key_secret; ALTER TABLE push_bindings DROP COLUMN token_expires_at");
  older.db.exec("INSERT INTO push_bindings VALUES ('b1','d1','murage_pt_x',1)");
  expect(inspectInstallationDatabase(older.db)).toMatchObject({ messages: 1, threads: 1 });
  expect(await snapshotInstallationDatabase(older.data, older.target)).toMatchObject({ status: "copied" });

  const beforeConsent = fixture();
  initializeInbox(beforeConsent.db); initializeThreadSnooze(beforeConsent.db); initializeArtifacts(beforeConsent.db); initializeMobilePush(beforeConsent.db);
  beforeConsent.db.exec("ALTER TABLE push_bindings DROP COLUMN rings_for_calls; ALTER TABLE push_bindings DROP COLUMN token_expires_at; ALTER TABLE push_bindings DROP COLUMN preview_content");
  expect(inspectInstallationDatabase(beforeConsent.db)).toMatchObject({ messages: 1, threads: 1 });

  // 1.0.9 appended rings_for_calls: a 1.0.8 archive (every earlier column, not that one) is accepted
  const beforeCalls = fixture();
  initializeInbox(beforeCalls.db); initializeThreadSnooze(beforeCalls.db); initializeArtifacts(beforeCalls.db); initializeMobilePush(beforeCalls.db);
  beforeCalls.db.exec("ALTER TABLE push_bindings DROP COLUMN rings_for_calls");
  expect(inspectInstallationDatabase(beforeCalls.db)).toMatchObject({ messages: 1, threads: 1 });

  const upgraded = fixture();
  upgraded.db.exec(`CREATE TABLE push_bindings (
      binding_id TEXT PRIMARY KEY, device_id TEXT NOT NULL UNIQUE, publisher_token TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  initializeInbox(upgraded.db); initializeThreadSnooze(upgraded.db); initializeArtifacts(upgraded.db); initializeMobilePush(upgraded.db);
  upgraded.db.exec(`INSERT INTO push_bindings (binding_id,device_id,publisher_token,created_at,key_secret) VALUES ('b1','d1','murage_pt_x',1,'${"a".repeat(64)}')`);
  expect(inspectInstallationDatabase(upgraded.db)).toMatchObject({ messages: 1, threads: 1 });
  expect(await snapshotInstallationDatabase(upgraded.data, upgraded.target)).toMatchObject({ status: "copied" });

  const fresh = fixture();
  initializeInbox(fresh.db); initializeThreadSnooze(fresh.db); initializeArtifacts(fresh.db); initializeMobilePush(fresh.db);
  const text = (db: DatabaseSync) => String((db.prepare("SELECT sql FROM sqlite_schema WHERE name='push_bindings'").get() as { sql: string }).sql).replace(/\s+/g, " ");
  expect(text(upgraded.db)).toBe(text(fresh.db));

  const hostile = fixture();
  initializeInbox(hostile.db); initializeThreadSnooze(hostile.db); initializeArtifacts(hostile.db); initializeMobilePush(hostile.db);
  hostile.db.exec("ALTER TABLE push_bindings ADD COLUMN extra TEXT");
  expect(() => inspectInstallationDatabase(hostile.db)).toThrow();
});

it("accepts push_events with and without H10's request index, and refuses a re-targeted one", () => {
  // H10 fix round 1: push_events_request_id serves the per-request revision
  // lookup. Created by initializeMobilePush, so a fresh database has it and
  // one from before simply lacks it.
  const fresh = fixture();
  initializeInbox(fresh.db); initializeThreadSnooze(fresh.db); initializeArtifacts(fresh.db); initializeMobilePush(fresh.db);
  expect(fresh.db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name='push_events_request_id'").get()).toBeTruthy();
  expect(inspectInstallationDatabase(fresh.db)).toMatchObject({ messages: 1, threads: 1 });
  const older = fixture();
  initializeInbox(older.db); initializeThreadSnooze(older.db); initializeArtifacts(older.db); initializeMobilePush(older.db);
  older.db.exec("DROP INDEX push_events_request_id");
  expect(inspectInstallationDatabase(older.db)).toMatchObject({ messages: 1, threads: 1 });
  const hostile = fixture();
  initializeInbox(hostile.db); initializeThreadSnooze(hostile.db); initializeArtifacts(hostile.db); initializeMobilePush(hostile.db);
  hostile.db.exec("DROP INDEX push_events_request_id; CREATE INDEX push_events_request_id ON push_events(thread_id)");
  expect(() => inspectInstallationDatabase(hostile.db)).toThrow();
});

it("accepts the relay removal queue, with rows in it", async () => {
  // Plan 3a H8 fix round 1: push_relay_removals holds bindings still to be
  // deleted at the relay. A backup taken while one is queued must still copy.
  const f = fixture();
  initializeInbox(f.db); initializeThreadSnooze(f.db); initializeArtifacts(f.db); initializeMobilePush(f.db);
  f.db.prepare("INSERT INTO push_relay_removals (binding_id,publisher_token,attempts,next_attempt_at,created_at) VALUES (?,?,?,?,?)")
    .run("3f6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3", "murage_pt_x", 0, 1, 1);
  expect(inspectInstallationDatabase(f.db)).toMatchObject({ messages: 1, threads: 1 });
  expect(await snapshotInstallationDatabase(f.data, f.target)).toMatchObject({ status: "copied" });
});

it("accepts the saved prompt block, reference pack, render prompt and model check tables with their rows", async () => {
  const f = fixture();
  initializeImageLibrary(f.db);
  f.db.exec("INSERT INTO image_prompt_blocks VALUES('b1','workspace','','brand-lock',1,'Identity',8,'x','owner',1,NULL)");
  f.db.exec("INSERT INTO image_render_prompts VALUES('op','Identity','[]',8,'x',1)");
  f.db.exec("INSERT INTO image_reference_packs VALUES('p1','bot','bot-1','refs',1,'[]',0,'bot:bot-1',1,NULL)");
  f.db.exec("INSERT INTO image_model_probes VALUES('flux','flux-image',1,1,1,NULL,NULL,NULL,900,NULL)");
  expect(await snapshotInstallationDatabase(f.data, f.target)).toMatchObject({ status: "copied", messages: 1 });
});

it.each([
  ["an unknown table", "CREATE TABLE plugins(id TEXT PRIMARY KEY)"],
  ["an image operation trigger", "CREATE TRIGGER hostile_image AFTER UPDATE ON image_operations BEGIN DELETE FROM thread_state; END"],
  ["an image operation column", "ALTER TABLE image_operations ADD COLUMN extra TEXT"],
  ["an image operation index", "CREATE INDEX hostile_image ON image_operations(state)"],
  ["a prompt block column", "ALTER TABLE image_prompt_blocks ADD COLUMN extra TEXT"],
  ["a reference pack trigger", "CREATE TRIGGER hostile_pack AFTER INSERT ON image_reference_packs BEGIN DELETE FROM thread_state; END"],
  ["an unknown index on a known table", "CREATE INDEX hostile ON artifacts(name)"],
  ["a known table with a foreign column", "ALTER TABLE inbox_item_state ADD COLUMN extra TEXT"],
  ["a migrated column out of order", "ALTER TABLE artifacts DROP COLUMN producer"],
  // Names every plain object inherits must not pass as allowlisted tables.
  ["a table named constructor", `CREATE TABLE "constructor"(payload TEXT)`],
  ["a table named __proto__", `CREATE TABLE "__proto__"(payload TEXT)`],
  ["a table named toString", `CREATE TABLE "toString"(payload TEXT)`],
  ["a table named hasOwnProperty", `CREATE TABLE "hasOwnProperty"(payload TEXT)`],
  ["a table named valueOf", `CREATE TABLE "valueOf"(payload TEXT)`],
  ["an autoindex on a table named constructor", `CREATE TABLE "constructor"(id TEXT PRIMARY KEY)`],
  ["a named index on a table named constructor", `CREATE TABLE "constructor"(payload TEXT); CREATE INDEX messages_thread_ctor ON "constructor"(payload)`],
])("still refuses %s", async (_name, sql) => {
  const f = fixture();
  initializeInbox(f.db); initializeArtifacts(f.db);
  initializeImageOperations(f.db); initializeImageLibrary(f.db);
  f.db.exec(sql);
  await expect(snapshotInstallationDatabase(f.data, f.target)).rejects.toMatchObject({ code: "DATABASE_SCHEMA_UNSUPPORTED" });
  expect(existsSync(f.target)).toBe(false);
});

// An allowlisted index NAME is not an allowlisted index. Activation opens the
// restored file with the app's own CREATE INDEX IF NOT EXISTS, which keeps
// whatever definition already sits under that name, so a partial, expression,
// unique or re-targeted index would survive restore and change what the
// harness's queries and writes do. Every index and table definition must be
// the one the harness's initializers create (RED2B verifier follow-up).
it.each([
  ["a partial index under an allowed name", "DROP INDEX messages_thread; CREATE INDEX messages_thread ON messages(thread_id) WHERE kind='text'"],
  ["an expression index under an allowed name", "DROP INDEX messages_thread; CREATE INDEX messages_thread ON messages(lower(thread_id))"],
  ["an extra column in an allowed index", "DROP INDEX messages_thread; CREATE INDEX messages_thread ON messages(thread_id,at)"],
  ["a unique index under an allowed name", "DROP INDEX messages_thread; CREATE UNIQUE INDEX messages_thread ON messages(thread_id)"],
  ["a collation change in an allowed index", "DROP INDEX messages_thread; CREATE INDEX messages_thread ON messages(thread_id COLLATE NOCASE)"],
  ["an allowed index name moved to another known table", "DROP INDEX messages_thread; CREATE INDEX messages_thread ON thread_state(thread_id)"],
  ["a partial saved-file index", "DROP INDEX artifacts_kind_date; CREATE INDEX artifacts_kind_date ON artifacts(kind,created_at DESC) WHERE kind='image'"],
  ["a saved-file index with a changed sort order", "DROP INDEX artifacts_kind_date; CREATE INDEX artifacts_kind_date ON artifacts(kind,created_at)"],
  ["an expression inbox index", "DROP INDEX messages_inbox_kind_thread_at; CREATE INDEX messages_inbox_kind_thread_at ON messages(kind,thread_id,abs(at))"],
  ["a generated column PRAGMA table_info does not list", "ALTER TABLE inbox_item_state ADD COLUMN shadow TEXT GENERATED ALWAYS AS (source_key) VIRTUAL"],
  ["a CHECK constraint on a known table", "DROP TABLE thread_state; CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY,active_leaf_id TEXT CHECK(length(active_leaf_id)<8)); INSERT INTO thread_state VALUES('t','m')"],
  ["a replacing conflict clause on a known table", "DROP TABLE thread_state; CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY ON CONFLICT REPLACE,active_leaf_id TEXT); INSERT INTO thread_state VALUES('t','m')"],
])("refuses %s and leaves no snapshot behind", async (_name, sql) => {
  const f = fixture();
  initializeInbox(f.db); initializeArtifacts(f.db);
  f.db.exec(sql);
  await expect(snapshotInstallationDatabase(f.data, f.target)).rejects.toMatchObject({ code: "DATABASE_SCHEMA_UNSUPPORTED" });
  expect(existsSync(f.target)).toBe(false);
  expect(readdirSync(f.scratch).filter(name => name.startsWith(".murage-database-snapshot-"))).toEqual([]);
});

it.each([
  // server/store.ts wrote this multi-line DDL from #192 until 0.1.47 moved it
  // to server/database.ts; installations created then still carry the text.
  ["the pre-0.1.47 transcript DDL", `
    CREATE TABLE IF NOT EXISTS messages (
      thread_id TEXT NOT NULL,
      id TEXT NOT NULL,
      at INTEGER NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT,
      json TEXT NOT NULL,
      PRIMARY KEY (thread_id, id)
    );
    CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id);
    CREATE TABLE IF NOT EXISTS thread_state (
      thread_id TEXT PRIMARY KEY,
      active_leaf_id TEXT
    );`],
  // server/memory/restore.ts writes the compact form into a restore target.
  ["the memory restore target DDL", "CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id)); CREATE INDEX messages_thread ON messages(thread_id); CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY,active_leaf_id TEXT);"],
])("accepts %s, which differs from today's only in whitespace", async (_name, ddl) => {
  const f = fixture(ddl);
  initializeInbox(f.db); initializeArtifacts(f.db);
  expect(await snapshotInstallationDatabase(f.data, f.target)).toMatchObject({ status: "copied", messages: 1, threads: 1 });
});

it("copies committed WAL data, branch head and terminal receipt without the runtime Store", async () => {
  const f = fixture();
  expect(existsSync(join(f.data, "messages.db-wal"))).toBe(true);
  const before = readFileSync(join(f.data, "messages.db"));
  const result = await snapshotInstallationDatabase(f.data, f.target);
  expect(result).toMatchObject({ status: "copied", messages: 1, threads: 1, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(readFileSync(join(f.data, "messages.db"))).toEqual(before);
  const copy = new DatabaseSync(f.target, { readOnly: true });
  try {
    expect(copy.prepare("SELECT active_leaf_id FROM thread_state").get()?.active_leaf_id).toBe("m");
    expect(JSON.parse(String(copy.prepare("SELECT json FROM messages").get()?.json)).goalRun.status).toBe("completed");
  } finally { copy.close(); }
});

it("refuses a live installation owner without producing a destination", async () => {
  const f = fixture();
  const owner = acquireDataDirLease(f.data);
  try { await expect(snapshotInstallationDatabase(f.data, f.target)).rejects.toThrow(); }
  finally { owner.release(); }
  expect(existsSync(f.target)).toBe(false);
});

it("never overwrites an existing destination", async () => {
  const f = fixture();
  writeFileSync(f.target, "existing-backup-canary");
  await expect(snapshotInstallationDatabase(f.data, f.target)).rejects.toMatchObject({ code: "DESTINATION_EXISTS" });
  expect(readFileSync(f.target, "utf8")).toBe("existing-backup-canary");
});

it("refuses invalid branch state without publishing a seemingly healthy backup", async () => {
  const f = fixture();
  f.db.exec("UPDATE thread_state SET active_leaf_id='missing'");
  await expect(snapshotInstallationDatabase(f.data, f.target)).rejects.toMatchObject({ code: "INVALID_ACTIVE_BRANCH" });
  expect(existsSync(f.target)).toBe(false);
  expect(f.db.prepare("SELECT active_leaf_id FROM thread_state").get()?.active_leaf_id).toBe("missing");
});

it("does not create an absent installation or put a snapshot inside it", async () => {
  const f = fixture();
  const absent = join(f.scratch, "absent");
  expect(await snapshotInstallationDatabase(absent, f.target)).toEqual({ status: "absent" });
  expect(existsSync(absent)).toBe(false);
  await expect(snapshotInstallationDatabase(f.data, join(f.data, "copy.db"))).rejects.toMatchObject({ code: "DESTINATION_INSIDE_INSTALLATION" });
});

it("holds the same epoch across database and other component work, then invalidates escaped operations", async () => {
  const f = fixture();
  let escaped: OfflineInstallation | undefined;
  await withOfflineInstallation(f.data, async installation => {
    escaped = installation;
    expect(() => acquireDataDirLease(f.data)).toThrow();
    await installation.snapshotDatabase(f.target);
    await new Promise(resolve => setTimeout(resolve, 1));
    expect(() => acquireDataDirLease(f.data)).toThrow();
    expect(readFileSync(join(f.data, "messages.db")).byteLength).toBeGreaterThan(0);
  });
  await expect(escaped!.snapshotDatabase(join(f.scratch, "late.db"))).rejects.toMatchObject({ code: "SNAPSHOT_EPOCH_CLOSED" });
  const owner = acquireDataDirLease(f.data);
  owner.release();
});

it.skipIf(process.platform === "win32")("rejects a destination symlink without touching its target", async () => {
  const f = fixture();
  const sentinel = join(f.scratch, "untouched");
  writeFileSync(sentinel, "must survive");
  symlinkSync(sentinel, f.target);
  await expect(snapshotInstallationDatabase(f.data, f.target)).rejects.toMatchObject({ code: "DESTINATION_EXISTS" });
  expect(readFileSync(sentinel, "utf8")).toBe("must survive");
});

it("rejects malformed message JSON with no secret-bearing diagnostics or staging debris", async () => {
  const f = fixture();
  f.db.prepare("UPDATE messages SET json=?").run('{"private":"never-echo-this",');
  let failure: unknown;
  try { await snapshotInstallationDatabase(f.data, f.target); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: "INVALID_MESSAGE_JSON" });
  expect(String(failure)).not.toContain("never-echo-this");
  expect((failure as Error).cause).toBeUndefined();
  expect(readdirSync(f.scratch).filter(name => name.startsWith(".murage-database-snapshot-"))).toEqual([]);
  expect(existsSync(f.target)).toBe(false);
  const owner = acquireDataDirLease(f.data);
  owner.release();
});

it.each([2,3])("inspects and restores a v%s memory archive into v4",async version=>{
 const f=fixture();f.db.exec(version===2?MEMORY_SCHEMA_V2:MEMORY_SCHEMA_V3);
 f.db.prepare("INSERT INTO memory_meta VALUES(1,?,'00000000-0000-4000-8000-000000000000',0,0,0,'active')").run(version);
 f.db.prepare("INSERT INTO memory_learning_config VALUES(1,0,?)").run(JSON.stringify(DEFAULT_MEMORY_LEARNING_V1));
 expect(await snapshotInstallationDatabase(f.data,f.target)).toMatchObject({status:"copied"});
 const restored=new DatabaseSync(f.target);try{
 migrateMemorySchema(restored);restored.exec("BEGIN IMMEDIATE");pauseRestoredMemory(restored);restored.exec("COMMIT");
 expect(restored.prepare("SELECT schema_version,mode FROM memory_meta").get()).toEqual({schema_version:MEMORY_SCHEMA_VERSION,mode:"paused"});expect(readMemoryLearning(restored)).toMatchObject({version:3,ceiling:{input:100_000_000,output:15_000_000}});
 }finally{restored.close();}
});

it("accepts shared_request_provenance with rows, snapshots it, and still accepts an archive without it; refuses an altered one", async () => {
  const prep = (f: ReturnType<typeof fixture>) => { initializeInbox(f.db); initializeThreadSnooze(f.db); initializeArtifacts(f.db); initializeMobilePush(f.db); };
  const withTable = fixture();
  prep(withTable); initializeSharedRequestProvenance(withTable.db);
  withTable.db.exec("INSERT INTO shared_request_provenance VALUES ('r1','routine','ask','schedule'),('r2','none',NULL,NULL)");
  expect(inspectInstallationDatabase(withTable.db)).toMatchObject({ messages: 1, threads: 1 });
  expect(await snapshotInstallationDatabase(withTable.data, withTable.target)).toMatchObject({ status: "copied" });
  const copy = new DatabaseSync(withTable.target);
  try { expect(copy.prepare("SELECT COUNT(*) AS n FROM shared_request_provenance").get()?.n).toBe(2); } finally { copy.close(); }

  const without = fixture();
  prep(without);
  expect(inspectInstallationDatabase(without.db)).toMatchObject({ messages: 1, threads: 1 });
  expect(await snapshotInstallationDatabase(without.data, without.target)).toMatchObject({ status: "copied" });

  const hostile = fixture();
  prep(hostile);
  hostile.db.exec("CREATE TABLE shared_request_provenance (request_id TEXT PRIMARY KEY, origin TEXT NOT NULL, permission_mode TEXT, trigger_source TEXT)");
  expect(() => inspectInstallationDatabase(hostile.db)).toThrow();
});

it.each(["source", "destination"])("T-SCHEMA-SNAPSHOT: accepts delegation packs and older archives; rejects a changed %s index", column => {
  const older = fixture();
  expect(inspectInstallationDatabase(older.db)).toMatchObject({ messages: 1, threads: 1 });
  const fresh = fixture();
  initializeDelegationPacks(fresh.db);
  fresh.db.exec("INSERT INTO delegation_packs(id,delegation_id,source_thread_id,source_bot_id,target_bot_id,refs,cut_at,created_at) VALUES('pack','job','source','sable','ember','[\"line\"]',1,1)");
  expect(inspectInstallationDatabase(fresh.db)).toMatchObject({ messages: 1, threads: 1 });
  // Only the index's indexed column changes; the accepted table and row stay identical.
  fresh.db.exec(`DROP INDEX delegation_packs_${column}; CREATE INDEX delegation_packs_${column} ON delegation_packs(target_bot_id)`);
  expect(() => inspectInstallationDatabase(fresh.db)).toThrow(expect.objectContaining({ code: "DATABASE_SCHEMA_UNSUPPORTED" }));
});

// Astra r20 (e): the queue table is part of the reference schema; an older archive without it, and without the owed-set index, still passes.
it("accepts the pending_delegations table with its indexes, accepts an older archive without it, and rejects a tampered pd_due", () => {
  const fresh = fixture();
  initializePendingDelegations(fresh.db);
  fresh.db.prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item) VALUES('a','s','t','f','parked',1,'{}')").run();
  expect(inspectInstallationDatabase(fresh.db)).toMatchObject({ messages: 1, threads: 1 });
  const older = fixture();
  expect(inspectInstallationDatabase(older.db)).toMatchObject({ messages: 1, threads: 1 });
  for (const tamper of [
    "DROP INDEX pd_due; CREATE INDEX pd_due ON pending_delegations(retry_at)",                                            // no longer partial
    "DROP INDEX pd_due; CREATE INDEX pd_due ON pending_delegations(retry_at, id) WHERE retry_at IS NOT NULL AND phase='parked'",
    "DROP INDEX pd_thread; CREATE UNIQUE INDEX pd_thread ON pending_delegations(source_thread_id)",
    "CREATE INDEX pd_extra ON pending_delegations(item)",
  ]) {
    const hostile = fixture();
    initializePendingDelegations(hostile.db);
    hostile.db.exec(tamper);
    expect(() => inspectInstallationDatabase(hostile.db), tamper).toThrow();
  }
  const badTable = fixture();
  badTable.db.exec("CREATE TABLE pending_delegations (id TEXT PRIMARY KEY NOT NULL, item TEXT NOT NULL)");
  expect(() => inspectInstallationDatabase(badTable.db)).toThrow();
});

it("bot email (section 7): payloads and events are emptied in the staged copy, bindings and send receipts carried, tables kept", async () => {
  const { EmailStore } = await import("./email/email-store.ts");
  const f = fixture();
  const store = new EmailStore(f.db);
  store.insertBinding({ botId: "b1", inboxId: "ibx_1", address: "juniper@murage.email", username: "juniper", displayName: "Juniper", emailKeyRef: "key_b1", fluxAccountId: null, state: "active", step: null, opId: null, opStartedAt: null, policy: "auto", failure: null, updatedAt: 1 });
  store.putPayload("snd-1", [{ part: 0, name: null, contentType: "text/plain", size: 26, sha256: "0".repeat(64), data: new TextEncoder().encode("Frozen body canary 7Q2Z") }]);
  store.recordEvent({ eventId: "eev_1", type: "email.message.received", inboxId: "ibx_1", botId: "b1", clientReference: null, heldId: null, created: null, data: { subject: "Inbound canary 9K4W" } }, 1);
  // Astra r2 Medium: the send card in the transcript carries the mail text in its subtitle and draft; the backup keeps only the headers
  const card = { kind: "email-send", tool: "email_send", requestId: "email:snd-1", title: "Send this email?", subtitle: "To: a@x.test\nSubject: Hello\n\nCard body canary 3HX8\n\nAttachments:\nf.txt (1 KB, SHA-256 00)", pushBody: "Juniper wants to send an email", options: ["Send"], emailSend: { sendId: "snd-1", draft: { to: ["a@x.test"], cc: [], subject: "Hello", text: "Draft text canary 5PV1" } } };
  f.db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES (?,?,?,?,?,?,?)").run("t", "card", 3, "bot", "options", null, JSON.stringify({ id: "card", at: 3, role: "bot", kind: "options", card }));
  f.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  expect(await snapshotInstallationDatabase(f.data, f.target)).toMatchObject({ status: "copied" });
  const copied = new DatabaseSync(f.target, { readOnly: true });
  databases.push(copied);
  const count = (table: string) => (copied.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  expect([count("email_payloads"), count("email_events"), count("email_bindings")]).toEqual([0, 0, 1]);
  const bytes = readFileSync(f.target).toString("latin1");
  expect(bytes).not.toContain("Frozen body canary 7Q2Z");
  expect(bytes).not.toContain("Inbound canary 9K4W");
  expect(bytes).not.toContain("Card body canary 3HX8");
  expect(bytes).not.toContain("Draft text canary 5PV1");
  const kept = JSON.parse((copied.prepare("SELECT json FROM messages WHERE id='card'").get() as { json: string }).json);
  expect(kept.card.subtitle).toBe("To: a@x.test\nSubject: Hello");
  expect(kept.card.emailSend.draft).toEqual({ to: ["a@x.test"], cc: [], subject: "Hello", text: "" });
  // the source is untouched: only the staged copy is sanitized
  expect((f.db.prepare("SELECT COUNT(*) AS n FROM email_payloads").get() as { n: number }).n).toBe(1);
  // the fidelity archive takes messages.db from this same sanitized projection, never from the raw file
  const fidelity = readFileSync(join(import.meta.dirname, "installation-fidelity-snapshot.ts"), "utf8");
  expect(fidelity).toContain('file.path!=="messages.db"');
  expect(fidelity).toContain('path==="messages.db"?join(stage.directory,"state",file.path)');
});

it("T-COPY-SNAPSHOT: staged database drops retired postings before publication", async () => {
  const f = fixture();
  f.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(t, tokenize='trigram', content='', contentless_delete=1, detail=none); ALTER TABLE messages_fts RENAME TO messages_fts_retired; CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(t, tokenize='trigram', content='', contentless_delete=1, detail=none); INSERT INTO messages_fts_retired(rowid,t) VALUES(9999999,'qzxretiredcanary')");
  seedCopyIntents(f.db);
  expect(await snapshotInstallationDatabase(f.data, f.target)).toMatchObject({ status: "copied" });
  const copy = new DatabaseSync(f.target, { readOnly: true });
  try { expect(copy.prepare("SELECT * FROM search_intents").all()).toEqual([]); expect(copy.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'messages_fts_retired%'").all()).toEqual([]); }
  finally { copy.close(); }
  expect(readFileSync(f.target).includes(Buffer.from("qzx"))).toBe(false);
});


describe("separate search file lifecycle", () => {

  const roots: string[] = [];
  const ddl = "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(t, tokenize='trigram', content='', contentless_delete=1, detail=none)";
  const retired = Array.from({ length: 8 }, (_, i) => `messages_fts_retired${i ? `_${i + 1}` : ""}`);
  const family = ["search.db", "search.db-wal", "search.db-shm"];
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "murage-search-life-")); roots.push(root);
    const data = join(root, "data"); mkdirSync(data);
    return { root, data, file: join(data, "messages.db") };
  }
  function init(db: DatabaseSync) {
    initializeMessageTables(db);
    db.exec("CREATE TABLE IF NOT EXISTS search_intents(seq INTEGER PRIMARY KEY AUTOINCREMENT, nonce INTEGER NOT NULL, rowid INTEGER, thread_key TEXT, CHECK ((rowid IS NULL) <> (thread_key IS NULL)), CHECK (thread_key IS NULL OR length(CAST(thread_key AS BLOB)) <= 72))");
  }
  afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) removeTempDirSync(root); });

  it.each(family)("T-INVENTORY / M19: %s is excluded from every backup policy", name => {
    expect(classifyDataDirEntry(name)).toMatchObject({ backup: "excluded" });
  });

  it("T-SNAPSHOT-SIDECAR: search files may vanish or appear during staging", async () => {
    const f = fixture(); writeFileSync(join(f.data, "config.json"), "{}");
    const db = new DatabaseSync(f.file); init(db); db.close();
    for (const name of family) writeFileSync(join(f.data, name), "derived-only");
    const original = DatabaseSync.prototype.prepare;
    let changed = false;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (!changed && sql.includes("sqlite_schema")) {
        changed = true; for (const name of family) rmSync(join(f.data, name), { force: true });
      }
      return original.call(this, sql);
    });
    const stage = await stageInstallationState(f.data, f.root);
    expect(changed).toBe(true);
    expect(stage.manifest.files.some(file => family.includes(file.path))).toBe(false);
  });

  it.each(["legacy", "partial", "recreated", "none"])("T-ARCHIVE-STATES: inspect %s without trusting unregistered schema", state => {
    const db = new DatabaseSync(":memory:");
    try {
      init(db); db.exec(ddl);
      if (state !== "legacy") db.exec("ALTER TABLE messages_fts RENAME TO messages_fts_retired");
      if (state === "partial") db.exec("DELETE FROM messages_fts_retired WHERE rowid=1");
      if (state === "recreated") { db.exec(ddl); for (const name of retired.slice(1)) { db.exec(`ALTER TABLE messages_fts RENAME TO "${name}"`); db.exec(ddl); } }
      if (state === "none") db.exec("DROP TABLE messages_fts_retired");
      expect(() => inspectInstallationDatabase(db)).not.toThrow();
    } finally { db.close(); }
  });

  it("T-LIFECYCLE: queue and every retired table/shadow have explicit lifecycle and restore classifications", () => {
    for (const name of ["search_intents", ...retired.flatMap(name => [name, ...["_data", "_idx", "_docsize", "_config"].map(s => name + s)])]) {
      expect(downgrade.APP_SCHEMA_102_ADDITIONS.tables, name).toContain(name);
      expect(ADDED_TABLE_LIFECYCLE[name], name).toBeDefined();
      expect(RESTORE_NOT_PENDING_WORK[name], name).toBeDefined();
    }
  });

  it.each(["snapshot", "damaged-export", "project-migration", "memory-safety", "restore"])("T-COPY %s: removes every retired index and deleted trigram residue before publication", caller => {
    const f = fixture(), db = new DatabaseSync(f.file);
    try {
      init(db); seedCopyIntents(db); db.exec(ddl);
      for (const name of retired) {
        db.exec("INSERT INTO messages_fts(rowid,t) VALUES(1,'zqxcanarytrigram')");
        db.exec(`ALTER TABLE messages_fts RENAME TO "${name}"`); db.exec(ddl);
      }
    } finally { db.close(); }
    settleFtsCopy(f.file, { check: true });
    const copy = new DatabaseSync(f.file, { readOnly: true });
    try {
      expect(copy.prepare("SELECT * FROM search_intents").all(), caller).toEqual([]);
      expect(copy.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'messages_fts_retired%'").all(), caller).toEqual([]);
      expect(copy.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    } finally { copy.close(); }
    expect(readFileSync(f.file).includes(Buffer.from("zqx"))).toBe(false);
  });

  it("T-DOWNGRADE-CLEAN: offline app downgrade removes search queue and all retired slots idempotently", () => {
    const db = new DatabaseSync(":memory:");
    try {
      init(db); db.exec(ddl);
      for (const name of retired) { db.exec(`ALTER TABLE messages_fts RENAME TO "${name}"`); db.exec(ddl); }
      downgrade.downgradeApplicationSchemaTo101(db, fixture().data);
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='search_intents' OR name LIKE 'messages_fts_retired%'").all()).toEqual([]);
      expect(() => downgrade.downgradeApplicationSchemaTo101(db, fixture().data)).not.toThrow();
    } finally { db.close(); }
  });

  it.each([1,2,3,4,5,6,7,8,9,10,11,12,13] as MemoryDowngradeTarget[])("T-DOWNGRADE-ROUNDTRIP to %i: remove derived files and tables before publishing success", target => {
    const f = fixture(), db = new DatabaseSync(f.file);
    try { init(db); migrateMemorySchema(db, "off"); db.exec(ddl); db.exec("ALTER TABLE messages_fts RENAME TO messages_fts_retired"); }
    finally { db.close(); }
    for (const name of family) writeFileSync(join(f.data, name), "derived search postings");
    const run = () => downgradeInstallationMemorySchema(f.data, target, { testOnlyBefore102: true });
    run();
    for (const name of family) expect(existsSync(join(f.data, name)), name).toBe(false);
    const result = new DatabaseSync(f.file, { readOnly: true });
    try { expect(result.prepare("SELECT name FROM sqlite_schema WHERE name='search_intents' OR name LIKE 'messages_fts_retired%'").all()).toEqual([]); }
    finally { result.close(); }
    expect(run).not.toThrow();
  });

  // C16/C18 require B1's worker and lifecycle code together. The integration owner must
  // set this to the merged SHA; standalone lifecycle evidence must report these as gated.
  const mergedSha = process.env.MURAGE_TEST_FTS_MERGED_SHA;
  it.skipIf(!mergedSha).each(["C16", "C18"])("%s (merged SHA gate): SIGKILL, capture stale state, then rebuild from live authority", async id => {
    expect(mergedSha).toMatch(/^[a-f0-9]{40}$/);
    const f = fixture(), backupFile = join(f.root, "own-backup.db");
    const searchModule = new URL("./message-search-index.ts", import.meta.url).href;
    const tablesModule = new URL("./message-tables.ts", import.meta.url).href;
    const childSource = `
      import { DatabaseSync, backup } from 'node:sqlite';
      import * as api from ${JSON.stringify(searchModule)};
      import { initializeMessageTables } from ${JSON.stringify(tablesModule)};
      import { existsSync } from 'node:fs';
      const file=${JSON.stringify(f.file)}, index=${JSON.stringify(join(f.data, "search.db"))};
      const db=new DatabaseSync(file);
      db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
      initializeMessageTables(db);
      api.settleInheritedSearchMerge(db,true);
      const wait=async(predicate)=>{const until=Date.now()+20000;while(Date.now()<until){if(predicate())return;await new Promise(r=>setTimeout(r,25));}throw Error('worker did not converge');};
      const state=()=>{if(!existsSync(index))return null;let read;try{read=new DatabaseSync(index,{readOnly:true});return Object.fromEntries(read.prepare('SELECT k,v FROM search_state').all().map(r=>[r.k,r.v]));}catch{return null;}finally{read?.close();}};
      if(process.env.FTS_PHASE==='seed'){
        db.exec('BEGIN');
        db.exec("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t','m',1,'owner','text','жжж','{}')");
        api.syncMessageSearchRow(db,1,'жжж');db.exec('COMMIT');
      }
      api.startSearchIndex(db,file);
      await wait(()=>{const s=state();return api.messageSearchIndexReady(db) && s && !s.built && s.owner===String(db.prepare("SELECT done FROM transcript_index_state WHERE name='search_owner'").get().done) && Number(s.applied_seq)>=Number(db.prepare('SELECT MAX(seq) AS n FROM search_intents').get().n);});
      if(process.env.FTS_PHASE==='seed'){
        await backup(db,${JSON.stringify(backupFile)});
        db.exec('BEGIN');db.exec("UPDATE messages SET text='ффф' WHERE rowid=1");api.syncMessageSearchRow(db,1,'ффф');db.exec('COMMIT');
        await wait(()=>Number(state()?.applied_seq)>=Number(db.prepare('SELECT MAX(seq) AS n FROM search_intents').get().n));
      }
      process.send({state:state()});
      setInterval(()=>{},1000);
    `;
    const childFile = join(f.root, "search-life-child.mjs");
    writeFileSync(childFile, childSource);
    const crashAtReady = async (phase: string) => {
      const child = spawn(process.execPath, [childFile], { windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, FTS_PHASE: phase } });
      let stderr = ""; child.stderr!.on("data", part => { stderr += part; });
      try {
        const state = await new Promise<Record<string, string>>((resolve, reject) => {
          const timer = setTimeout(() => reject(Error(`child barrier timed out: ${stderr}`)), 25000);
          child.once("message", (message: any) => { clearTimeout(timer); resolve(message.state); });
          child.once("exit", (code, signal) => { clearTimeout(timer); reject(Error(`child exited ${code}/${signal}: ${stderr}`)); });
        });
        const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
        child.kill("SIGKILL"); await exited;
        return state;
      } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
    };
    const before = await crashAtReady("seed");
    // Capture both database families and the published backup BEFORE opening any of them.
    // Single Unicode trigrams stay contiguous in FTS leaf blocks (long words are prefix-compressed).
    const capture = (phase: string) => {
      const directory = join(f.root, phase); mkdirSync(directory);
      const raw = Object.fromEntries(["messages.db", "messages.db-wal", "search.db", "search.db-wal"].map(name => {
        const path = join(f.data, name), bytes = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
        if (bytes.length) writeFileSync(join(directory, name), bytes);
        return [name, bytes];
      }));
      copyFileSync(backupFile, join(directory, "own-backup.db"));
      return { directory, raw };
    };
    const staleCapture = capture("stale-capture");
    expect(staleCapture.raw["messages.db-wal"].includes(Buffer.from("ффф"))).toBe(true);
    expect(Buffer.concat([staleCapture.raw["search.db"], staleCapture.raw["search.db-wal"]]).includes(Buffer.from("ффф"))).toBe(true);
    const inspectSearch = (directory: string, stale: boolean) => {
      const db = new DatabaseSync(join(directory, "search.db"), { readOnly: true });
      try {
        expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all(trigramQuery("ффф"))).toEqual(stale ? [{ rowid: 1 }] : []);
        const blocks = db.prepare("SELECT block FROM messages_fts_data").all();
        expect(blocks.some(row => row.block instanceof Uint8Array && Buffer.from(row.block).includes(Buffer.from("ффф")))).toBe(stale);
        if (!stale) {
          const expectedRowid = id === "C16" ? 1 : 2;
          expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all(trigramQuery("жжж"))).toEqual([{ rowid: expectedRowid }]);
          expect(db.prepare("SELECT rowid FROM docs").all()).toEqual([{ rowid: expectedRowid }]);
        }
      } finally { db.close(); }
    };
    inspectSearch(staleCapture.directory, true);
    const published = new DatabaseSync(join(staleCapture.directory, "own-backup.db"), { readOnly: true });
    try {
      expect(published.prepare("SELECT rowid,text FROM messages").all()).toEqual([{ rowid: 1, text: "жжж" }]);
      expect(String(published.prepare("SELECT done FROM transcript_index_state WHERE name='search_owner'").get()?.done)).toBe(before.owner);
      expect(Number(published.prepare("SELECT MAX(seq) AS seq FROM search_intents").get()?.seq)).toBeLessThan(Number(before.seen_seq));
    }
    finally { published.close(); }
    expect(readFileSync(join(staleCapture.directory, "own-backup.db")).includes(Buffer.from("ффф"))).toBe(false);
    if (id === "C16") {
      for (const suffix of ["-wal","-shm"]) rmSync(f.file+suffix,{force:true});
      copyFileSync(backupFile,f.file);
    } else {
      // Frozen 1.0.18 contract: recreates the in-file FTS and writes no intents.
      const older = new DatabaseSync(f.file);
      try { older.exec(ddl); older.exec("DELETE FROM messages WHERE rowid=1; INSERT INTO messages(rowid,thread_id,id,at,role,kind,text,json) VALUES(2,'t','new',2,'owner','text','жжж','{}')"); }
      finally { older.close(); }
    }
    // Assert the actual mismatch at the activation barrier, independently of the repaired state.
    const barrier = capture("activation-capture");
    inspectSearch(barrier.directory, true);
    const authority = new DatabaseSync(join(barrier.directory, "messages.db"), { readOnly: true });
    try {
      expect(authority.prepare("SELECT rowid,text FROM messages").all()).toEqual([{ rowid: id === "C16" ? 1 : 2, text: "жжж" }]);
      expect(String(authority.prepare("SELECT done FROM transcript_index_state WHERE name='search_owner'").get()?.done)).toBe(before.owner);
      const newest = Number(authority.prepare("SELECT MAX(seq) AS seq FROM search_intents").get()?.seq);
      if (id === "C16") expect(newest).toBeLessThan(Number(before.seen_seq));
      else expect(newest).toBe(Number(before.seen_seq)); // the old writer emitted no intents
    }
    finally { authority.close(); }
    const after = await crashAtReady("resume");
    const repaired = capture("repaired-capture");
    expect(after.index_id).not.toBe(before.index_id);
    // Check saved bytes before SQLite recovery/checkpoint can hide a stale frame or free-page residue.
    for (const name of ["search.db", "search.db-wal"]) expect(repaired.raw[name].includes(Buffer.from("ффф")), name).toBe(false);
    inspectSearch(repaired.directory, false);
  }, 65000);

  it.skipIf(!mergedSha)("T-WIPE-LIVE / M32 (merged SHA gate): join a live recreating worker before deletion and lease release", async () => {
    const f = fixture();
    const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');const fs=require('node:fs');const path=require('node:path');const tick=()=>{for(const name of ['search.db','search.db-wal','search.db-shm'])fs.writeFileSync(path.join(workerData,name),'postings');};tick();const timer=setInterval(tick,5);parentPort.postMessage('ready');parentPort.on('message',()=>setTimeout(()=>{clearInterval(timer);process.exit(0);},80));`, { eval:true, workerData:f.data });
    let exited = false, released = false;
    const exit = new Promise<boolean>(resolve => worker.once("exit", () => { exited = true; resolve(true); }));
    try {
      await new Promise<void>(resolve => worker.once("message", () => resolve()));
      const stops = { closeDatabase() {}, stopEngineHistory: async () => true, stopWalMaintenance: async () => true,
        stopSearchIndex() { worker.postMessage("stop"); return exit; } };
      const gate = createDataWriterGate(() => stopDataWriters(stops), () => { released = true; });
      expect(await gate.stop()).toBe(true);
      expect(exited).toBe(true); expect(released).toBe(true);
      removeMessageSearchFiles(f.data);
      await new Promise(resolve => setTimeout(resolve,30));
      for (const name of family) expect(existsSync(join(f.data,name)),name).toBe(false);
    } finally { await worker.terminate(); }
  });
});
