// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory schema v3 (0.1.61 lane M): the receipt output index. "Which receipts
// produced this message" was a scan of every receipt's JSON array in the
// thread (instr over output_message_ids, 0.1.61 T2 R2-12); v3 keeps one row
// per (receipt, output message), maintained by triggers, so the replay check
// is an index lookup. Covered here: fresh install, v1 and v2 upgrades with a
// backfill and a pre-upgrade copy, the triggers, the downgrade to v2 (0.1.60)
// and v1, a full round trip, the forward-only boundary (the 0.1.60 validator
// refuses a v3 file) and the archive check for a tampered index.
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { MEMORY_PRE_V3_SNAPSHOT, MEMORY_SCHEMA_V1, MEMORY_SCHEMA_V2, MEMORY_SCHEMA_VERSION, downgradeMemorySchema, migrateMemorySchema, validateMemorySchema } from "./schema.ts";
import { DEFAULT_MEMORY_LEARNING_V1 } from "./learning-policy.ts";

const databases: DatabaseSync[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function open(file = ":memory:") { const db = new DatabaseSync(file); databases.push(db); db.exec("PRAGMA foreign_keys=ON"); return db; }
type Row = { type: string; name: string; tbl_name: string; sql: string | null };
/** The validator 0.1.60 shipped: exact v1 or v2 text, nothing else memory_*. */
function validateAs0160(db: DatabaseSync) {
  const shapes = [MEMORY_SCHEMA_V1, MEMORY_SCHEMA_V2].map(text => {
    const reference = open(); reference.exec(text);
    return new Map((reference.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema").all() as Row[]).map(row => [row.name, row]));
  });
  const rows = (db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema").all() as Row[]).filter(row => row.name.startsWith("memory_") || row.tbl_name.startsWith("memory_"));
  const meta = rows.find(row => row.name === "memory_meta");
  const index = shapes.findIndex(shape => shape.get("memory_meta")?.sql === meta?.sql);
  if (index < 0 || rows.length !== shapes[index]!.size) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  for (const row of rows) { const wanted = shapes[index]!.get(row.name); if (!wanted || wanted.sql !== row.sql) throw new Error("MEMORY_SCHEMA_UNSUPPORTED"); }
  return index + 1;
}
function seed(db: DatabaseSync) {
  db.exec("INSERT INTO memory_scopes VALUES('scope','conversation','thread','[]',0);");
  db.exec(`INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
    VALUES('b1','thread','drv',NULL,'[]','[]','["m1","m2"]',0,0,1,'delivered',1),('b2','thread','drv',NULL,'[]','[]','["m2"]',0,0,1,'delivered',2),('b3','other','drv',NULL,'[]','[]','[]',0,0,1,'prepared',3);`);
}
function v2Installation() {
  const root = mkdtempSync(join(tmpdir(), "murage-memory-v3-")); roots.push(root);
  const db = open(join(root, "messages.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(MEMORY_SCHEMA_V2);
  db.prepare("INSERT INTO memory_meta VALUES(1,2,?,4,5,6,'active')").run(randomUUID());
  db.prepare("INSERT INTO memory_learning_config VALUES(1,3,?)").run(JSON.stringify({ ...DEFAULT_MEMORY_LEARNING_V1, reviewMode: false }));
  seed(db);
  return { root, db };
}
const index = (db: DatabaseSync) => db.prepare("SELECT bundle_id,thread_id,message_id FROM memory_disclosure_outputs ORDER BY bundle_id,message_id").all();
const BACKFILLED = [
  { bundle_id: "b1", thread_id: "thread", message_id: "m1" },
  { bundle_id: "b1", thread_id: "thread", message_id: "m2" },
  { bundle_id: "b2", thread_id: "thread", message_id: "m2" },
];

it("a fresh v4 install retains the v3 output index and the triggers keep the index equal to the receipts", () => {
  const db = open(); migrateMemorySchema(db, "active");
  expect(MEMORY_SCHEMA_VERSION).toBe(6);
  expect(db.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version).toBe(6);
  seed(db);
  expect(index(db)).toEqual(BACKFILLED);
  // linkMemoryDisclosureOutput appends to the array
  db.exec(`UPDATE memory_disclosures SET output_message_ids='["m3"]' WHERE bundle_id='b3';`);
  db.exec(`UPDATE memory_disclosures SET output_message_ids='["m1","m2","m4"]' WHERE bundle_id='b1';`);
  expect(index(db)).toContainEqual({ bundle_id: "b3", thread_id: "other", message_id: "m3" });
  expect(index(db)).toContainEqual({ bundle_id: "b1", thread_id: "thread", message_id: "m4" });
  // a shrinking array (never written by the app, but a merge could) is followed too
  db.exec(`UPDATE memory_disclosures SET output_message_ids='["m2"]' WHERE bundle_id='b1';`);
  expect(index(db).filter(row => row.bundle_id === "b1")).toEqual([{ bundle_id: "b1", thread_id: "thread", message_id: "m2" }]);
  db.exec("DELETE FROM memory_disclosures WHERE bundle_id='b2';");
  expect(index(db).some(row => row.bundle_id === "b2")).toBe(false);
  expect(validateMemorySchema(db).has("memory_disclosure_outputs")).toBe(true);
});

it("upgrades a 0.1.60 (v2) file: copy first, index backfilled, identity and learning policy kept", () => {
  const f = v2Installation();
  const meta = f.db.prepare("SELECT * FROM memory_meta").get();

  const snapshot = join(f.root, MEMORY_PRE_V3_SNAPSHOT);
  migrateMemorySchema(f.db, "off", { snapshotV2Path: snapshot });
  expect(f.db.prepare("SELECT * FROM memory_meta").get()).toEqual({ ...meta, schema_version: 6 });
  expect(JSON.parse(String(f.db.prepare("SELECT settings FROM memory_learning_config").get()?.settings))).toMatchObject({version:2,reviewMode:false});
  expect(index(f.db)).toEqual(BACKFILLED);
  expect(existsSync(snapshot)).toBe(true);
  const copy = open(snapshot);
  expect(validateAs0160(copy)).toBe(2);
  expect(copy.prepare("SELECT count(*) n FROM memory_disclosures").get()?.n).toBe(3);
  // a second start does nothing
  migrateMemorySchema(f.db, "off", { snapshotV2Path: join(f.root, "second.db") });
  expect(existsSync(join(f.root, "second.db"))).toBe(false);
});

it("upgrades a v1 file straight to v4 with the v3 output index", () => {
  const db = open(); db.exec(MEMORY_SCHEMA_V1);
  db.prepare("INSERT INTO memory_meta VALUES(1,1,?,0,0,0,'off')").run(randomUUID());
  seed(db);
  migrateMemorySchema(db);
  expect(db.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version).toBe(6);
  expect(index(db)).toEqual(BACKFILLED);
  expect(db.prepare("SELECT count(*) n FROM memory_learning_config").get()?.n).toBe(1);
});

it("the previous release refuses a v4 file; the downgrade to v2 is accepted by it with every row intact", () => {
  const f = v2Installation();
  migrateMemorySchema(f.db);
  expect(() => validateAs0160(f.db)).toThrow("MEMORY_SCHEMA_UNSUPPORTED");
  f.db.exec(`INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
    VALUES('after','thread','drv',NULL,'[]','[]','["m9"]',0,0,1,'delivered',9);`);
  expect(downgradeMemorySchema(f.db, 2)).toEqual({ status: "downgraded", from: 6, to: 2 });
  expect(validateAs0160(f.db)).toBe(2);
  expect(f.db.prepare("SELECT schema_version,policy_revision,deletion_epoch,data_revision,mode FROM memory_meta").get()).toEqual({ schema_version: 2, policy_revision: 4, deletion_epoch: 5, data_revision: 6, mode: "active" });
  expect(f.db.prepare("SELECT bundle_id,output_message_ids FROM memory_disclosures ORDER BY bundle_id").all().map(row => row.bundle_id)).toEqual(["after", "b1", "b2", "b3"]);
  expect(f.db.prepare("SELECT count(*) n FROM memory_learning_config").get()?.n).toBe(1);
  expect(downgradeMemorySchema(f.db, 2)).toEqual({ status: "already-v2", from: 2, to: 2 });
  // round trip: the next 0.1.61 start rebuilds the index, including rows written while downgraded
  migrateMemorySchema(f.db);
  expect(index(f.db)).toEqual([{ bundle_id: "after", thread_id: "thread", message_id: "m9" }, ...BACKFILLED]);
  expect(downgradeMemorySchema(f.db)).toEqual({ status: "downgraded", from: 6, to: 1 });
  expect(validateAs0160(f.db)).toBe(1);
  migrateMemorySchema(f.db);
  expect(f.db.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version).toBe(6);
  expect(index(f.db)).toHaveLength(4);
});

it("an archive whose index does not match its receipts is refused on the full check", () => {
  const db = open(); migrateMemorySchema(db); seed(db);
  expect(() => validateMemorySchema(db)).not.toThrow();
  db.exec("DELETE FROM memory_disclosure_outputs WHERE bundle_id='b2';");
  expect(() => validateMemorySchema(db)).toThrow("INVALID_MEMORY_OUTPUT_INDEX");
  expect(() => validateMemorySchema(db, { references: false })).not.toThrow();
  db.exec("INSERT INTO memory_disclosure_outputs VALUES('b2','thread','m2'),('b2','thread','forged');");
  expect(() => validateMemorySchema(db)).toThrow("INVALID_MEMORY_OUTPUT_INDEX");
});
