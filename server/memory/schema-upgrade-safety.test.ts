import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MEMORY_PRE_V2_SNAPSHOT, MEMORY_SCHEMA_V1, downgradeMemorySchema, migrateMemorySchema, validateMemorySchema } from "./schema.ts";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) { try { db.close(); } catch { /* already closed */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function dataDir() { const root = mkdtempSync(join(tmpdir(), "murage-memory-upgrade-")); roots.push(root); return root; }
function open(file: string) {
  const db = new DatabaseSync(file); databases.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  return db;
}
/** A 0.1.53-shaped data dir: messages table plus the frozen v1 memory schema and one record. */
function legacyInstallation(mode = "active") {
  const root = dataDir(), file = join(root, "messages.db"), db = open(file);
  db.exec("CREATE TABLE IF NOT EXISTS messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id));");
  db.exec("INSERT INTO messages VALUES('thread','m1',1,'user','text','before upgrade','{}');");
  db.exec(MEMORY_SCHEMA_V1);
  db.prepare("INSERT INTO memory_meta VALUES(1,1,?,7,8,9,?)").run(randomUUID(), mode);
  db.exec("INSERT INTO memory_scopes VALUES('scope','bot','bot','[]',3);");
  db.exec("INSERT INTO memory_records VALUES('fact',1,'scope','fact','Original preference','owner-statement','candidate',0,1,NULL,NULL,1);");
  return { root, file, db, snapshot: join(root, MEMORY_PRE_V2_SNAPSHOT) };
}
/** The validator 0.1.53 shipped: every memory_* row must match the frozen v1
 * text exactly, with no extra objects, and memory_meta.schema_version must be 1. */
function validateAs0153(db: DatabaseSync) {
  const reference = new DatabaseSync(":memory:"); databases.push(reference); reference.exec(MEMORY_SCHEMA_V1);
  const expected = new Map((reference.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema").all() as Array<{type: string; name: string; tbl_name: string; sql: string | null}>).map(row => [row.name, row]));
  const rows = (db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema").all() as Array<{type: string; name: string; tbl_name: string; sql: string | null}>)
    .filter(row => row.name.startsWith("memory_") || row.tbl_name.startsWith("memory_"));
  if (rows.length !== expected.size) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  for (const row of rows) {
    const wanted = expected.get(row.name);
    if (!wanted || row.type !== wanted.type || row.tbl_name !== wanted.tbl_name || row.sql !== wanted.sql) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  }
  const meta = db.prepare("SELECT * FROM memory_meta").all();
  if (meta.length !== 1 || meta[0].schema_version !== 1) throw new Error("INVALID_MEMORY_META");
  return new Set(rows.map(row => row.name));
}

describe("H1 pre-migration snapshot", () => {
  it("copies a v1 messages.db beside itself before migrating and leaves the copy at v1", () => {
    const f = legacyInstallation("active");
    expect(existsSync(f.snapshot)).toBe(false);
    migrateMemorySchema(f.db, "off", { snapshotPath: f.snapshot });
    expect(f.db.prepare("SELECT schema_version,mode FROM memory_meta").get()).toEqual({ schema_version: 2, mode: "active" });
    expect(existsSync(f.snapshot)).toBe(true);
    expect(existsSync(`${f.snapshot}-wal`)).toBe(false);
    if (process.platform !== "win32") expect(statSync(f.snapshot).mode & 0o777).toBe(0o600);
    const copy = open(f.snapshot);
    expect(validateAs0153(copy).size).toBeGreaterThan(12);
    expect(validateMemorySchema(copy).has("memory_learning_config")).toBe(false);
    expect(copy.prepare("SELECT schema_version,mode FROM memory_meta").get()).toEqual({ schema_version: 1, mode: "active" });
    expect(copy.prepare("SELECT text FROM memory_records").get()?.text).toBe("Original preference");
    expect(copy.prepare("SELECT text FROM messages").get()?.text).toBe("before upgrade");
  });
  it("does not overwrite an existing snapshot and does not snapshot a fresh or already-migrated database", () => {
    const f = legacyInstallation();
    writeFileSync(f.snapshot, "keep me");
    migrateMemorySchema(f.db, "off", { snapshotPath: f.snapshot });
    expect(statSync(f.snapshot).size).toBe("keep me".length);
    migrateMemorySchema(f.db, "off", { snapshotPath: join(f.root, "second.db") });
    expect(existsSync(join(f.root, "second.db"))).toBe(false);
    const fresh = dataDir(), db = open(join(fresh, "messages.db"));
    migrateMemorySchema(db, "active", { snapshotPath: join(fresh, MEMORY_PRE_V2_SNAPSHOT) });
    expect(existsSync(join(fresh, MEMORY_PRE_V2_SNAPSHOT))).toBe(false);
  });
  it("fails closed when the snapshot cannot be written: no migration, v1 intact, reason surfaced", () => {
    const f = legacyInstallation("capture");
    const before = f.db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
    const blocked = join(f.root, "missing-directory", MEMORY_PRE_V2_SNAPSHOT);
    expect(() => migrateMemorySchema(f.db, "off", { snapshotPath: blocked })).toThrow(/^MEMORY_SCHEMA_SNAPSHOT_FAILED: /);
    expect(existsSync(blocked)).toBe(false);
    expect(f.db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(before);
    expect(f.db.prepare("SELECT schema_version,mode FROM memory_meta").get()).toEqual({ schema_version: 1, mode: "capture" });
    expect(validateAs0153(f.db).size).toBeGreaterThan(12);
  });
});

describe("H2 downgrade", () => {
  it("v1 -> upgrade -> new rows -> downgrade is accepted by the 0.1.53 validator with every row intact", () => {
    const f = legacyInstallation("active");
    migrateMemorySchema(f.db, "off", { snapshotPath: f.snapshot });
    f.db.exec("INSERT INTO messages VALUES('thread','m2',2,'user','text','after upgrade','{}');");
    f.db.exec("INSERT INTO memory_records VALUES('later',1,'scope','fact','Learned after upgrade','owner-statement','active',0,2,NULL,NULL,2);");
    expect(f.db.prepare("SELECT count(*) n FROM memory_record_details").get()?.n).toBe(2);
    expect(downgradeMemorySchema(f.db)).toEqual({ status: "downgraded", from: 2, to: 1 });
    expect(validateAs0153(f.db).size).toBeGreaterThan(12);
    expect(validateMemorySchema(f.db).has("memory_record_details")).toBe(false);
    expect(f.db.prepare("SELECT schema_version,installation_id,policy_revision,deletion_epoch,data_revision,mode FROM memory_meta").get()).toMatchObject({ schema_version: 1, policy_revision: 7, deletion_epoch: 8, data_revision: 9, mode: "active" });
    expect(f.db.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='trigger'").get()?.n).toBe(0);
    expect(f.db.prepare("SELECT text FROM messages ORDER BY at").all().map(row => row.text)).toEqual(["before upgrade", "after upgrade"]);
    expect(f.db.prepare("SELECT id,text FROM memory_records ORDER BY id").all()).toEqual([{ id: "fact", text: "Original preference" }, { id: "later", text: "Learned after upgrade" }]);
    expect(downgradeMemorySchema(f.db)).toEqual({ status: "already-v1", from: 1, to: 1 });
    // The next 0.1.54 start re-migrates the downgraded file exactly as it did the first time.
    migrateMemorySchema(f.db, "off", { snapshotPath: f.snapshot });
    expect(f.db.prepare("SELECT count(*) n FROM memory_record_details").get()?.n).toBe(2);
  });
  it("refuses an unknown schema and rolls back when the inverse cannot complete", () => {
    const f = legacyInstallation();
    migrateMemorySchema(f.db);
    f.db.exec("CREATE TABLE memory_future(id INTEGER);");
    expect(() => downgradeMemorySchema(f.db)).toThrow("MEMORY_SCHEMA_UNSUPPORTED");
    f.db.exec("DROP TABLE memory_future;");
    const before = f.db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
    const exec = f.db.exec.bind(f.db);
    f.db.exec = (sql: string) => { if (sql.includes("DROP TABLE memory_meta_v2")) throw new Error("injected downgrade failure"); return exec(sql); };
    expect(() => downgradeMemorySchema(f.db)).toThrow("injected downgrade failure");
    f.db.exec = exec;
    expect(f.db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(before);
    expect(f.db.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version).toBe(2);
  });
});
