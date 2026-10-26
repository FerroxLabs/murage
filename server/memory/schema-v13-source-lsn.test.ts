// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory schema 13 (1.0.7 memory-recall-hydration D2): memory_source_lsn and its stamp trigger memory_source_lsn_insert. A new file and an
// upgraded one store one text; 12 -> 13 creates both empty (no backfill); 13 -> 12 drops the trigger then the table and leaves the frozen v12
// text; the validator wants both on a v13 file and neither on a v12 one (F6). F9: a downgrade and re-upgrade starts the table empty, so every
// source version made before the re-upgrade is bounded by the first new stamp and a window opened before the re-upgrade keeps holding it,
// on the same database handle too.
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { BRANCH_TABLES_SQL } from "../branch-index.ts";
import { memoryLookup } from "./deny-read.ts";
import { memoryRefKey, type MemoryRef } from "./lineage-types.ts";
import { MEMORY_SCHEMA, MEMORY_SCHEMA_V12, MEMORY_SCHEMA_VERSION, SOURCE_LSN_SCHEMA, downgradeMemorySchema, migrateMemorySchema, validateMemorySchema } from "./schema.ts";
import { CONTENT, MESSAGES_SQL } from "./testing/writetime-fixture.ts";

function open() { const db = new DatabaseSync(":memory:"); db.exec(MESSAGES_SQL); migrateMemorySchema(db, "active"); return db; }
/** The room scope the sources live in, and the branch tables the read gate seeks (deny.ts), as a real file has them. */
function room(db: DatabaseSync) { db.exec(BRANCH_TABLES_SQL); db.exec("INSERT OR IGNORE INTO memory_scopes(id,kind,owner_key,audience,revision) VALUES('s-room','room','s-room','[]',0)"); }
const pendingScope = (db: DatabaseSync, since: number, revoke: number) => db.prepare("INSERT INTO memory_deny_pending_scope(scope_id,since_lsn,revoke_id) VALUES('s-room',?,?)").run(since, revoke);
const version = (db: DatabaseSync) => Number(db.prepare("SELECT schema_version FROM memory_meta").get()!.schema_version);
const sqlOf = (db: DatabaseSync, name: string) => db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)?.sql as string | undefined;
const stamps = (db: DatabaseSync) => db.prepare("SELECT source_id,revision,created_lsn FROM memory_source_lsn ORDER BY source_id,revision").all().map(row => ({ ...row }));
const at = (db: DatabaseSync, next: number) => db.prepare("UPDATE memory_lsn SET next=? WHERE id=1").run(next);
const OBJECTS = ["memory_source_lsn", "memory_source_lsn_insert"];
function frozen(text: string) {
  const db = new DatabaseSync(":memory:");
  try { db.exec(text); return Object.fromEntries(OBJECTS.map(name => [name, sqlOf(db, name)])); } finally { db.close(); }
}
const sourceVersion = (db: DatabaseSync, id: string, revision = 1) => {
  if (revision === 1) db.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,turn_id,revision,content_hash,kind,speaker,outcome,branch_id,state) VALUES(?,'s-room',NULL,NULL,NULL,1,?,'message','user','ok',NULL,'active')").run(id, `h-${id}`);
  db.prepare("INSERT INTO memory_source_versions(source_id,revision,content_hash,payload,created_at) VALUES(?,?,?,'{\"text\":\"words\"}',0)").run(id, revision, `h-${id}-${revision}`);
};

it("v13-fresh: a new file is v13 with the source stamp table and trigger, and every new source version is stamped with the lsn counter", () => {
  const db = open();
  try {
    expect(MEMORY_SCHEMA_VERSION).toBe(13);
    expect(version(db)).toBe(13);
    expect(MEMORY_SCHEMA).toBe(MEMORY_SCHEMA_V12.replace("CHECK(schema_version=12)", "CHECK(schema_version=13)") + SOURCE_LSN_SCHEMA);
    const fresh = frozen(MEMORY_SCHEMA);
    for (const name of OBJECTS) expect(sqlOf(db, name), name).toBe(fresh[name]);
    expect(frozen(MEMORY_SCHEMA_V12)).toEqual({ memory_source_lsn: undefined, memory_source_lsn_insert: undefined });
    room(db);
    at(db, 7); sourceVersion(db, "a");
    at(db, 9); sourceVersion(db, "a", 2);
    expect(stamps(db)).toEqual([{ source_id: "a", revision: 1, created_lsn: 7 }, { source_id: "a", revision: 2, created_lsn: 9 }]);
    expect(Number(db.prepare("SELECT next FROM memory_lsn").get()!.next)).toBe(9); // a stamp takes no lsn of its own
    expect(() => validateMemorySchema(db)).not.toThrow();
  } finally { db.close(); }
});

it("12 -> 13 creates both objects empty (no backfill: older source versions stay unstamped) and stores the text a new file stores", () => {
  const db = open();
  try {
    room(db);
    expect(downgradeMemorySchema(db, 12)).toMatchObject({ status: "downgraded", from: 13, to: 12 });
    expect(version(db)).toBe(12);
    for (const name of OBJECTS) expect(sqlOf(db, name), name).toBeUndefined();
    expect(String(sqlOf(db, "memory_meta"))).toContain("CHECK(schema_version=12)");
    expect(() => validateMemorySchema(db)).not.toThrow();
    expect(downgradeMemorySchema(db, 12)).toMatchObject({ status: "already-v12" });
    sourceVersion(db, "old");
    migrateMemorySchema(db, "active");
    expect(version(db)).toBe(13);
    const fresh = frozen(MEMORY_SCHEMA);
    for (const name of OBJECTS) expect(sqlOf(db, name), name).toBe(fresh[name]);
    expect(stamps(db)).toEqual([]);
    expect(() => validateMemorySchema(db)).not.toThrow();
    at(db, 12); sourceVersion(db, "new");
    expect(stamps(db)).toEqual([{ source_id: "new", revision: 1, created_lsn: 12 }]);
  } finally { db.close(); }
});

it("F6 the validator refuses a v13 file missing the stamp trigger or the stamp table, and accepts a v12 file without them", () => {
  for (const drop of ["DROP TRIGGER memory_source_lsn_insert", "DROP TRIGGER memory_source_lsn_insert; DROP TABLE memory_source_lsn"]) {
    const db = open();
    try {
      expect(() => validateMemorySchema(db)).not.toThrow();
      db.exec(drop);
      expect(() => validateMemorySchema(db), drop).toThrow("MEMORY_SCHEMA_UNSUPPORTED");
    } finally { db.close(); }
  }
  const db = open();
  try {
    downgradeMemorySchema(db, 12);
    expect(() => validateMemorySchema(db)).not.toThrow();
    // a v12 file carrying v13's table is not a v12 file
    db.exec("CREATE TABLE memory_source_lsn (source_id TEXT NOT NULL, revision INTEGER NOT NULL, created_lsn INTEGER NOT NULL, PRIMARY KEY(source_id,revision)) WITHOUT ROWID");
    expect(() => validateMemorySchema(db)).toThrow("MEMORY_SCHEMA_UNSUPPORTED");
  } finally { db.close(); }
});

it("13 -> 10 is still the frozen 1.0.2 text (the v13 step drops its own objects first)", () => {
  const db = open();
  try {
    expect(downgradeMemorySchema(db, 10)).toMatchObject({ status: "downgraded", from: 13, to: 10 });
    for (const name of OBJECTS) expect(sqlOf(db, name), name).toBeUndefined();
    expect(String(sqlOf(db, "memory_meta"))).toContain("CHECK(schema_version=10)");
    expect(() => validateMemorySchema(db)).not.toThrow();
  } finally { db.close(); }
});

it("F9 13 -> 12, a source version written on v12, 13 again: a window opened before the re-upgrade keeps that version and every older one checking", () => {
  const db = open();
  try {
    room(db);
    const state = (id: string) => { const ref: MemoryRef = { kind: "source", id, version: 1 }; return memoryLookup(db, [ref], CONTENT).get(memoryRefKey(ref))?.state; };
    at(db, 10); sourceVersion(db, "a");
    at(db, 11); sourceVersion(db, "z"); db.prepare("DELETE FROM memory_source_lsn WHERE source_id='z'").run();
    // this handle learns the first stamp (10) before the round trip
    pendingScope(db, 9, 1);
    expect(state("z")).toBe("checking");
    db.prepare("DELETE FROM memory_deny_pending_scope").run();
    expect(state("z")).toBe("shown");

    expect(downgradeMemorySchema(db, 12)).toMatchObject({ status: "downgraded", from: 13, to: 12 });
    db.exec(BRANCH_TABLES_SQL);
    at(db, 20); sourceVersion(db, "b"); // written by a v12 build: no stamp
    at(db, 25); pendingScope(db, 25, 5); // a revoke opened on v12, before the re-upgrade
    at(db, 30);
    migrateMemorySchema(db, "active");
    db.exec(BRANCH_TABLES_SQL);
    expect(version(db)).toBe(13);
    expect(stamps(db)).toEqual([]);
    // no stamp yet: bounded by the counter now (30)
    expect(["a", "b", "z"].map(state)).toEqual(["checking", "checking", "checking"]);
    at(db, 40); sourceVersion(db, "c");
    // the first new stamp (40) bounds every unstamped version, on this same handle too (the floor it knew, 10, would show b)
    expect(["a", "b", "z", "c"].map(state)).toEqual(["checking", "checking", "checking", "checking"]);
    // that revoke's job leaves the window, and one opened after the first new stamp holds only what was made after it
    db.prepare("DELETE FROM memory_deny_pending_scope WHERE revoke_id=5").run();
    at(db, 45); pendingScope(db, 45, 6);
    expect(["a", "b", "z", "c"].map(state)).toEqual(["shown", "shown", "shown", "shown"]);
    at(db, 46); sourceVersion(db, "d");
    expect(state("d")).toBe("checking");
    expect(() => validateMemorySchema(db)).not.toThrow();
  } finally { db.close(); }
});
