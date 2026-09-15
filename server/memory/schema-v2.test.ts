import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { MEMORY_SCHEMA_V1, migrateMemorySchema, validateMemorySchema } from "./schema.ts";
import { readMemoryLearning, updateMemoryLearning } from "./learning-policy.ts";
import { captureMessage } from "./capture.ts";
import { applyMemoryTombstones, pauseRestoredMemory } from "./restore.ts";

const databases: DatabaseSync[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });
function legacy(mode = "active") {
  const db = new DatabaseSync(":memory:"); databases.push(db); db.exec("PRAGMA foreign_keys=ON"); db.exec(MEMORY_SCHEMA_V1);
  db.prepare("INSERT INTO memory_meta VALUES(1,1,?,7,8,9,?)").run(randomUUID(), mode);
  db.exec("INSERT INTO memory_scopes VALUES('scope','bot','bot','[]',3);");
  db.exec("INSERT INTO memory_records VALUES('fact',1,'scope','fact','Original preference','owner-statement','candidate',0,1,NULL,NULL,1);");
  db.exec("INSERT INTO memory_tombstones VALUES('deleted','record','forgotten',NULL,NULL,8,'owner-forgot',1);");
  return db;
}
it("retains the exact frozen v1 schema and validates old archives without modifying them", () => {
  expect(createHash("sha256").update(MEMORY_SCHEMA_V1).digest("hex")).toBe("3a9a0a2bc03ff1d573f664e66b8cf54279abc9488b85988f44f7a27ce5cf1571");
  const db = legacy(), before = db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
  db.exec("PRAGMA query_only=ON"); expect(validateMemorySchema(db).size).toBeGreaterThan(12);
  expect(db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(before);
});
it.each(["off", "paused", "capture", "active"])("migrates v1 %s without altering identity, records, scope or deletions", mode => {
  const db = legacy(mode), meta = db.prepare("SELECT * FROM memory_meta").get();
  const records = db.prepare("SELECT * FROM memory_records").all(), scopes = db.prepare("SELECT * FROM memory_scopes").all(), deleted = db.prepare("SELECT * FROM memory_tombstones").all();
  migrateMemorySchema(db, "active");
  expect(db.prepare("SELECT * FROM memory_meta").get()).toEqual({ ...meta, schema_version: 2 });
  expect(db.prepare("SELECT * FROM memory_records").all()).toEqual(records);
  expect(db.prepare("SELECT * FROM memory_scopes").all()).toEqual(scopes);
  expect(db.prepare("SELECT * FROM memory_tombstones").all()).toEqual(deleted);
  expect(db.prepare("SELECT partition,claim_status,observed_at FROM memory_record_details").get()).toEqual({ partition: "semantic", claim_status: "provisional", observed_at: null });
  expect(readMemoryLearning(db)).toMatchObject({ automaticFacts: true, automaticProcedures: true, reviewMode: false, dailyCostUsd: null });
  const after = db.prepare("SELECT * FROM memory_meta").get(); migrateMemorySchema(db);
  expect(db.prepare("SELECT * FROM memory_meta").get()).toEqual(after); expect(validateMemorySchema(db).has("memory_learning_config")).toBe(true);
});
it("rolls back a migration failure after the new schema has been created", () => {
  const db = legacy("off"), before = db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
  const exec = db.exec.bind(db);
  const spy = vi.spyOn(db, "exec").mockImplementation(sql => {
    if (sql.includes("DROP TABLE memory_meta_v1")) throw new Error("injected migration failure");
    return exec(sql);
  });
  expect(() => migrateMemorySchema(db)).toThrow("injected migration failure"); spy.mockRestore();
  expect(db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(before);
  expect(db.prepare("SELECT schema_version,mode FROM memory_meta").get()).toEqual({ schema_version: 1, mode: "off" });
  expect(db.prepare("SELECT text FROM memory_records").get()?.text).toBe("Original preference");
});
it("creates details for new records and scrubs them when a tombstone takes effect", () => {
  const db = legacy(); migrateMemorySchema(db);
  db.exec("UPDATE memory_record_details SET entities='[\"private entity\"]',confidence=.8,confidence_basis='private context',observed_at=123;");
  db.exec("UPDATE memory_records SET state='active' WHERE id='fact';");
  expect(db.prepare("SELECT claim_status FROM memory_record_details").get()?.claim_status).toBe("current");
  db.exec("INSERT INTO memory_tombstones VALUES('forget-now','record','fact',NULL,NULL,9,'owner-forgot',2);");
  applyMemoryTombstones(db);
  expect(db.prepare("SELECT attention,entities,confidence,confidence_basis,observed_at FROM memory_record_details").get())
    .toEqual({ attention: "historical", entities: "[]", confidence: null, confidence_basis: null, observed_at: null });
  db.exec("DELETE FROM memory_records WHERE id='fact';");
  expect(db.prepare("SELECT count(*) n FROM memory_record_details").get()?.n).toBe(0);
});
it("rejects unknown schema and malformed learning config without migration", () => {
  const db = legacy(); db.exec("ALTER TABLE memory_meta ADD COLUMN future TEXT;");
  expect(() => migrateMemorySchema(db)).toThrow("MEMORY_SCHEMA_UNSUPPORTED");
  const current = legacy(); migrateMemorySchema(current);
  current.exec("UPDATE memory_learning_config SET settings='{}';");
  expect(() => validateMemorySchema(current)).toThrow("INVALID_MEMORY_LEARNING_CONFIG");
});
it("owner learning policy updates are versioned and cannot silently widen limits", () => {
  const db = legacy(); migrateMemorySchema(db);
  expect(updateMemoryLearning(db, { automaticFacts: false, reviewMode: true, dailyCostUsd: 1 }, 0)).toMatchObject({ revision: 1, automaticFacts: false, reviewMode: true });
  expect(() => updateMemoryLearning(db, { automaticFacts: true }, 0)).toThrow("REVISION_CONFLICT");
  expect(() => updateMemoryLearning(db, { callsPerMinute: -1 }, 1)).toThrow();
  expect(() => updateMemoryLearning(db, { recipient: "unrelated" }, 1)).toThrow();
  expect(readMemoryLearning(db)).toMatchObject({ revision: 1, automaticFacts: false });
});
it("captures event time, actor, outcome detail and artifact references exactly once", () => {
  const db = legacy(); migrateMemorySchema(db);
  const message = { id: "action", at: 123, role: "bot" as const, kind: "activity" as const, turnId: "turn", from: { botId: "bot", name: "Fixture", color: "blue" },
    artifactIds: ["artifact1"], tool: { name: "Write report", ok: false, errorDetails: "Target unavailable" } };
  captureMessage(db, "thread", message); captureMessage(db, "thread", message);
  expect(db.prepare("SELECT count(*) n FROM memory_source_versions").get()?.n).toBe(1);
  expect(db.prepare("SELECT count(*) n FROM memory_jobs").get()?.n).toBe(1);
  const payload = JSON.parse(String(db.prepare("SELECT payload FROM memory_source_versions").get()?.payload));
  expect(payload).toMatchObject({ occurredAt: 123, actorId: "bot", artifactIds: ["artifact1"], outcome: "failed",
    action: { label: "Write report", reportedOutcome: "failed", detail: "Target unavailable", verification: "tool-reported" } });
  expect(payload.text).toContain("Target unavailable");
  db.exec("BEGIN IMMEDIATE"); expect(pauseRestoredMemory(db)).toBe(true); db.exec("COMMIT");
  expect(db.prepare("SELECT mode FROM memory_meta").get()?.mode).toBe("paused");
});
