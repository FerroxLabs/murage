import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { database, transaction } from "../database.ts";
import { insertMessage, readThread } from "../message-db.ts";
import { inspectInstallationDatabase } from "../installation-database-snapshot.ts";
import { migrateMemorySchema, validateMemorySchema } from "./schema.ts";
import { memoryState } from "./repository.ts";

beforeEach(() => mkdirSync(DATA_DIR, {recursive: true}));

it("creates private off-by-default memory in the authoritative database", () => {
  expect(memoryState().mode).toBe("off");
  expect(memoryState().installationId).toMatch(/^[a-f0-9-]{36}$/);
  expect(database().prepare("PRAGMA synchronous").get()?.synchronous).toBe(2);
  expect(() => inspectInstallationDatabase(database())).not.toThrow();
});

it("rolls back conversation, source revision and job as one transaction", () => {
  const id = randomUUID();
  expect(() => transaction(db => {
    insertMessage(id, {id, at: 1, role: "user", kind: "text", text: "source evidence"});
    db.prepare("INSERT INTO memory_scopes VALUES(?, 'conversation', ?, '[]', 0)").run(id,id);
    db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,?,'text','user','completed',NULL,'active')").run(id,id,id,id,"hash");
    db.prepare("INSERT INTO memory_source_versions VALUES(?,1,'hash','{}',1)").run(id);
    db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,policy_revision,deletion_epoch) VALUES(?,?,1,'capture','1','pending',0,0)").run(id,id);
    throw new Error("injected boundary failure");
  })).toThrow("injected boundary failure");
  expect(readThread(id, "/nonexistent-fixture-legacy").messages).toEqual([]);
  expect(database().prepare("SELECT 1 FROM memory_sources WHERE id=?").get(id)).toBeUndefined();
  expect(database().prepare("SELECT 1 FROM memory_jobs WHERE id=?").get(id)).toBeUndefined();
});

it("preserves completed memory schema identity on reopen/migration", () => {
  const db = database(); const before = memoryState();
  migrateMemorySchema(db);
  expect(memoryState()).toEqual(before);
  expect(validateMemorySchema(db).size).toBeGreaterThan(12);
});

it("rejects unknown executable schema and partial memory schemas", () => {
  const db = database();
  db.exec("CREATE TRIGGER memory_injected AFTER INSERT ON messages BEGIN DELETE FROM memory_jobs; END;");
  expect(() => inspectInstallationDatabase(db)).toThrow("DATABASE_SCHEMA_UNSUPPORTED");
  db.exec("DROP TRIGGER memory_injected");
  const partial = new DatabaseSync(":memory:");
  try {
    partial.exec("CREATE TABLE memory_meta(id INTEGER)");
    expect(() => validateMemorySchema(partial)).toThrow("MEMORY_SCHEMA_UNSUPPORTED");
  } finally { partial.close(); }
});

it("rejects dangling memory references without trusting archive foreign-key settings", () => {
  const db = database();
  db.exec("PRAGMA foreign_keys=OFF");
  db.prepare("INSERT INTO memory_scope_bindings VALUES(?,'absent','bot','b',0,'granted','{}')").run(randomUUID());
  expect(() => inspectInstallationDatabase(db)).toThrow("DATABASE_SCHEMA_UNSUPPORTED");
});
