// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory schema 12 (1.0.3 lineage S6 rules 25 and 27): the door epoch key, the door_epoch session column and the incarnation allocator. A new
// file and an upgraded one store one text; the upgrade rebuilds the two tables without losing memory_watermark_bump (a RENAME rewrites
// trigger bodies, so the trigger leaves first and the schema text makes it again); 12 -> 11 -> 10 leaves the frozen 1.0.2 text.
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { MEMORY_SCHEMA, MEMORY_SCHEMA_V10, MEMORY_SCHEMA_V11, MEMORY_SCHEMA_VERSION, downgradeMemorySchema, migrateMemorySchema, validateMemorySchema } from "./schema.ts";

const MESSAGES = "CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id));";
function open() { const db = new DatabaseSync(":memory:"); db.exec(MESSAGES); migrateMemorySchema(db); return db; }
const version = (db: DatabaseSync) => Number(db.prepare("SELECT schema_version FROM memory_meta").get()!.schema_version);
const sqlOf = (db: DatabaseSync, name: string) => db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)?.sql as string | undefined;
const meta = (db: DatabaseSync) => Object.fromEntries((db.prepare("SELECT key,value FROM memory_lineage_lsn_meta").all() as Array<{ key: string; value: number }>).map(r => [r.key, Number(r.value)]));
const next = (db: DatabaseSync) => Number(db.prepare("SELECT next FROM memory_lsn WHERE id=1").get()!.next);
const DOOR_OBJECTS = ["memory_lineage_lsn_meta", "memory_session_lineage", "memory_session_incarnation", "memory_watermark_bump"];
function frozen(text: string) {
  const db = new DatabaseSync(":memory:");
  try { db.exec(text); return Object.fromEntries(DOOR_OBJECTS.map(name => [name, sqlOf(db, name)])); } finally { db.close(); }
}
/** A policy bump moves the watermark keys and deny_generation (memory_watermark_bump is attached and points at the live table). */
function expectWatermarkMoves(db: DatabaseSync) {
  const before = meta(db), lsn = next(db);
  db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
  const after = meta(db);
  expect(next(db)).toBe(lsn + 1);
  expect(after.policy_bump_lsn).toBe(lsn + 1);
  expect(after.deny_generation).toBe(before.deny_generation + 1);
  expect(sqlOf(db, "memory_watermark_bump")).toContain("UPDATE memory_lineage_lsn_meta SET");
}
const session = (db: DatabaseSync, id: string) =>
  db.prepare("INSERT INTO memory_session_lineage(thread_id,driver_instance,native_session,first_lsn,last_lsn) VALUES('t','d',?,3,5)").run(id);

it("v12-fresh: a new file is v12 with the door epoch key at the lsn counter, the door_epoch column and the allocator", () => {
  const db = open();
  try {
    expect(MEMORY_SCHEMA_VERSION).toBe(13);
    expect(version(db)).toBe(13);
    expect(meta(db).reader_door_epoch).toBe(next(db));
    expect(sqlOf(db, "memory_session_lineage")).toContain("door_epoch INTEGER");
    expect(sqlOf(db, "memory_session_incarnation")).toContain("PRIMARY KEY(thread_id,driver_instance,native_id,n)");
    expect(MEMORY_SCHEMA_V11).toBe(MEMORY_SCHEMA_V10.replace("CHECK(schema_version=10)", "CHECK(schema_version=11)"));
    expect(() => validateMemorySchema(db)).not.toThrow();
    expectWatermarkMoves(db);
  } finally { db.close(); }
});

it("a v10 (1.0.2) file migrates to v12: same stored text as a new file, sessions kept with a NULL stamp, door epoch at the counter, watermark still moves", () => {
  const db = open();
  try {
    session(db, "old");
    db.exec("UPDATE memory_lsn SET next=40 WHERE id=1");
    expect(downgradeMemorySchema(db, 10)).toMatchObject({ status: "downgraded", from: 13, to: 10 });
    expect(version(db)).toBe(10);
    expect(meta(db).reader_door_epoch).toBeUndefined();
    expectWatermarkMoves(db);
    migrateMemorySchema(db);
    expect(version(db)).toBe(13);
    const fresh = frozen(MEMORY_SCHEMA);
    for (const name of DOOR_OBJECTS) expect(sqlOf(db, name)).toBe(fresh[name]);
    expect(db.prepare("SELECT native_session,first_lsn,last_lsn,door_epoch FROM memory_session_lineage").all()).toEqual([{ native_session: "old", first_lsn: 3, last_lsn: 5, door_epoch: null }]);
    expect(meta(db).reader_door_epoch).toBe(next(db));
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '%_v11'").all()).toEqual([]);
    expect(() => validateMemorySchema(db)).not.toThrow();
    expectWatermarkMoves(db);
  } finally { db.close(); }
});

it("12 -> 11 -> 12: the watermark moves at v11 and after the re-upgrade; the stamp and the allocator rows are dropped going down, the sessions stay", () => {
  const db = open();
  try {
    session(db, "s1");
    db.exec("UPDATE memory_session_lineage SET door_epoch=1; INSERT INTO memory_session_incarnation VALUES('t','d','s1',1)");
    expect(downgradeMemorySchema(db, 11)).toMatchObject({ status: "downgraded", from: 13, to: 11 });
    expect(version(db)).toBe(11);
    const v11 = frozen(MEMORY_SCHEMA_V11);
    for (const name of DOOR_OBJECTS) expect(sqlOf(db, name)).toBe(v11[name]);
    expect(sqlOf(db, "memory_session_incarnation")).toBeUndefined();
    expect(Object.keys(meta(db)).sort()).toEqual(["deny_generation", "epoch_bump_lsn", "lineage_upgrade_lsn", "policy_bump_lsn", "root_sets_dropped"]);
    expect(db.prepare("SELECT native_session,first_lsn,last_lsn FROM memory_session_lineage").all()).toEqual([{ native_session: "s1", first_lsn: 3, last_lsn: 5 }]);
    expect(() => validateMemorySchema(db)).not.toThrow();
    expectWatermarkMoves(db);
    expect(downgradeMemorySchema(db, 11)).toMatchObject({ status: "already-v11" });
    migrateMemorySchema(db);
    expect(version(db)).toBe(13);
    expect(db.prepare("SELECT door_epoch FROM memory_session_lineage").get()).toEqual({ door_epoch: null });
    expectWatermarkMoves(db);
  } finally { db.close(); }
});

it("a v12 file stepped to 10 is the frozen 1.0.2 text: the 1.0.2 validator accepts it and its watermark still moves", () => {
  const db = open();
  try {
    session(db, "s1");
    db.exec("INSERT INTO messages VALUES('t','m',1,'user','text','a chat line','{}')");
    downgradeMemorySchema(db, 10);
    const v10 = frozen(MEMORY_SCHEMA_V10);
    for (const name of DOOR_OBJECTS) expect(sqlOf(db, name)).toBe(v10[name]);
    expect(String(sqlOf(db, "memory_meta"))).toContain("CHECK(schema_version=10)");
    expect(() => validateMemorySchema(db)).not.toThrow();
    expect(db.prepare("SELECT text FROM messages").get()!.text).toBe("a chat line");
    expectWatermarkMoves(db);
  } finally { db.close(); }
});
