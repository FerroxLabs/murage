import { DEFAULT_MEMORY_LEARNING_V1 } from "./memory/learning-policy.ts";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { acquireDataDirLease } from "../electron/data-dir-lease.mjs";
import { initializeArtifacts } from "./artifacts.ts";
import { initializeInbox } from "./inbox.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { initializeImageLibrary, initializeImageOperations } from "./image-operations-schema.ts";
import { initializeThreadSnooze } from "./thread-snooze.ts";
import { initializeMobilePush } from "./mobile-push-store.ts";
import { initializeSharedRequestProvenance } from "./shared-provenance-schema.ts";
import { inspectInstallationDatabase, snapshotInstallationDatabase, withOfflineInstallation, type OfflineInstallation } from "./installation-database-snapshot.ts";
import { MEMORY_SCHEMA_V2,MEMORY_SCHEMA_V3,migrateMemorySchema } from "./memory/schema.ts";
import { pauseRestoredMemory } from "./memory/restore.ts";
import { readMemoryLearning, updateMemoryLearning } from "./memory/learning-policy.ts";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
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
  db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?)").run("t", "m", 1, "bot", "goal.run", null, JSON.stringify({ id: "m", at: 1, role: "bot", kind: "goal.run", goalRun: { status: "completed", detail: "Receipt canary" } }));
  db.exec("INSERT INTO thread_state VALUES ('t','m')");
  return { scratch, data, db, target: join(scratch, "snapshot.db") };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("copies v2 memory classification and learning controls into a separate paused database", async () => {
  const f=fixture();migrateMemorySchema(f.db,"active");
  f.db.exec("INSERT INTO memory_scopes VALUES('bot-scope','bot','bot','[]',0);");
  f.db.exec("INSERT INTO memory_records VALUES('fact',1,'bot-scope','fact','A preserved fact','owner-statement','active',1,1,NULL,NULL,1);");
  f.db.exec("UPDATE memory_record_details SET entities='[\"project\"]',confidence=.9,confidence_basis='owner confirmed',observed_at=42;");
  updateMemoryLearning(f.db,{reviewMode:true,dailyOutputTokens:200},0);
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
  ["missing parent", `UPDATE messages SET json=json_set(json,'$.parentId','missing')`, "INVALID_MESSAGE_PARENT"],
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
  f.db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?)").run("t", "later", 2, "bot", "text", "parent", JSON.stringify({ id: "later", at: 2, role: "bot", kind: "text", text: "parent", parentId: null }));
  expect(await snapshotInstallationDatabase(f.data, f.target)).toMatchObject({ status: "copied", messages: 2 });
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
  older.db.exec("ALTER TABLE push_bindings DROP COLUMN preview_content; ALTER TABLE push_bindings DROP COLUMN key_secret; ALTER TABLE push_bindings DROP COLUMN token_expires_at");
  older.db.exec("INSERT INTO push_bindings VALUES ('b1','d1','murage_pt_x',1)");
  expect(inspectInstallationDatabase(older.db)).toMatchObject({ messages: 1, threads: 1 });
  expect(await snapshotInstallationDatabase(older.data, older.target)).toMatchObject({ status: "copied" });

  const beforeConsent = fixture();
  initializeInbox(beforeConsent.db); initializeThreadSnooze(beforeConsent.db); initializeArtifacts(beforeConsent.db); initializeMobilePush(beforeConsent.db);
  beforeConsent.db.exec("ALTER TABLE push_bindings DROP COLUMN token_expires_at; ALTER TABLE push_bindings DROP COLUMN preview_content");
  expect(inspectInstallationDatabase(beforeConsent.db)).toMatchObject({ messages: 1, threads: 1 });

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
 expect(restored.prepare("SELECT schema_version,mode FROM memory_meta").get()).toEqual({schema_version:6,mode:"paused"});expect(readMemoryLearning(restored)).toMatchObject({version:2,dailyInputTokens:400000});
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
