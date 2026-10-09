// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.62 memmigrate: the v2 -> v4 upgrade of messages.db writes a full copy
// first. A 645 MB file means about 1.3 GB if two copies were taken. Covered
// here: free-space check before anything is written, one copy per upgrade,
// a full disk during the copy or during the upgrade transaction leaving
// messages.db at its old version with no partial file, a killed copy never
// mistaken for a finished one, and the message a newer-schema file produces.
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { MEMORY_PRE_V3_SNAPSHOT, MEMORY_PRE_V4_SNAPSHOT, MEMORY_SCHEMA, MEMORY_SCHEMA_V2, MemoryMigrationError, migrateMemorySchema, validateMemorySchema } from "./schema.ts";
import { DEFAULT_MEMORY_LEARNING_V1 } from "./learning-policy.ts";

const databases: DatabaseSync[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function v2Installation() {
  const root = mkdtempSync(join(tmpdir(), "murage-memmigrate-")); roots.push(root);
  const file = join(root, "messages.db");
  const db = new DatabaseSync(file); databases.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  db.exec("INSERT INTO messages VALUES('t','m1',1,'user','text','hello','{}')");
  db.exec(MEMORY_SCHEMA_V2);
  db.prepare("INSERT INTO memory_meta VALUES(1,2,?,4,5,6,'active')").run(randomUUID());
  db.prepare("INSERT INTO memory_learning_config VALUES(1,3,?)").run(JSON.stringify({ ...DEFAULT_MEMORY_LEARNING_V1, reviewMode: false }));
  return { root, file, db, v3: join(root, MEMORY_PRE_V3_SNAPSHOT), v4: join(root, MEMORY_PRE_V4_SNAPSHOT) };
}
const version = (db: DatabaseSync) => Number(db.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version);
const GIB = 1024 ** 3;
const diskFull = () => Object.assign(new Error("database or disk is full"), { code: "ERR_SQLITE_ERROR", errcode: 13, errstr: "database or disk is full" });

it("refuses to start the upgrade when the disk is too small, naming how much to free, and leaves messages.db at v2", () => {
  const f = v2Installation();
  let caught: unknown;
  try { migrateMemorySchema(f.db, "off", { snapshotV2Path: f.v3, snapshotV3Path: f.v4, freeBytes: () => 1000 }); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(MemoryMigrationError);
  const error = caught as MemoryMigrationError;
  expect(error.code).toBe("MEMORY_MIGRATION_DISK_SPACE");
  expect(error.shortBytes).toBeGreaterThan(0);
  expect(error.message).toMatch(/free up at least \d+(\.\d)? (MB|GB)/i);
  expect(error.message).not.toMatch(/safe|—|composio/i);
  expect(version(f.db)).toBe(2);
  expect(readdirSync(f.root).filter(name => name.startsWith("messages.pre"))).toEqual([]);
  // the next launch with room just works
  migrateMemorySchema(f.db, "off", { snapshotV2Path: f.v3, snapshotV3Path: f.v4, freeBytes: () => 100 * GIB });
  expect(version(f.db)).toBe(7);
});

it("takes exactly one copy for a v2 file going to v4: the pre-v3 copy, no pre-v4 copy", () => {
  const f = v2Installation();
  migrateMemorySchema(f.db, "off", { snapshotV2Path: f.v3, snapshotV3Path: f.v4, freeBytes: () => 100 * GIB });
  expect(version(f.db)).toBe(7);
  expect(readdirSync(f.root).filter(name => name.startsWith("messages.pre"))).toEqual([MEMORY_PRE_V3_SNAPSHOT]);
  const copy = new DatabaseSync(f.v3); databases.push(copy);
  expect(version(copy)).toBe(2);
  expect(copy.prepare("SELECT count(*) n FROM messages").get()?.n).toBe(1);
});

it("a full disk during the copy removes the partial copy, never starts the upgrade and reports the shortfall", () => {
  const f = v2Installation();
  let seen = "";
  const copy = (_db: DatabaseSync, path: string) => { seen = path; writeFileSync(path, "half a copy"); throw diskFull(); };
  let caught: unknown;
  try { migrateMemorySchema(f.db, "off", { snapshotV2Path: f.v3, freeBytes: () => 100 * GIB, copy }); } catch (error) { caught = error; }
  expect(seen).not.toBe(f.v3); // written beside the final name, renamed only when whole
  expect((caught as MemoryMigrationError).code).toBe("MEMORY_MIGRATION_DISK_SPACE");
  expect(version(f.db)).toBe(2);
  expect(readdirSync(f.root).filter(name => name.startsWith("messages.pre"))).toEqual([]);
  expect(existsSync(seen)).toBe(false);
});

it("a full disk inside the upgrade transaction (SQLite already rolled back) reports the disk, not 'no transaction is active', and leaves v2 whole", () => {
  const f = v2Installation();
  const real = f.db;
  const failing = new Proxy(real, {
    get(target, property) {
      if (property === "exec") return (sql: string) => {
        if (/INSERT INTO memory_meta SELECT/.test(sql)) { real.exec("ROLLBACK"); throw diskFull(); }
        return target.exec(sql);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let caught: unknown;
  try { migrateMemorySchema(failing, "off", { snapshotV2Path: f.v3, freeBytes: () => 100 * GIB }); } catch (error) { caught = error; }
  expect((caught as MemoryMigrationError).code).toBe("MEMORY_MIGRATION_DISK_SPACE");
  expect(version(real)).toBe(2);
  expect(() => validateMemorySchema(real)).not.toThrow();
  expect(real.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='memory_learning_events'").get()?.n).toBe(0);
  // retry once there is room
  migrateMemorySchema(real, "off", { snapshotV2Path: f.v3, freeBytes: () => 100 * GIB });
  expect(version(real)).toBe(7);
});

it("a copy left half-written by a killed start is discarded, not trusted", () => {
  const f = v2Installation();
  writeFileSync(`${f.v3}.partial`, "truncated by a killed app");
  migrateMemorySchema(f.db, "off", { snapshotV2Path: f.v3, freeBytes: () => 100 * GIB });
  expect(existsSync(`${f.v3}.partial`)).toBe(false);
  const copy = new DatabaseSync(f.v3); databases.push(copy);
  expect(version(copy)).toBe(2);
});

it("reports each step to the start-up screen with the expected copy size", () => {
  const f = v2Installation();
  const phases: string[] = []; let copyBytes = 0;
  migrateMemorySchema(f.db, "off", { snapshotV2Path: f.v3, freeBytes: () => 100 * GIB, onPhase: event => { phases.push(event.phase); copyBytes = event.copyBytes; } });
  expect(phases).toEqual(["checking", "copying", "migrating"]);
  expect(copyBytes).toBeGreaterThan(0);
});

it("a file written by a newer Murage gets a plain message that names the fix", () => {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  db.exec(MEMORY_SCHEMA.replace("CHECK(schema_version=7)", "CHECK(schema_version=8)")); // what a future build would write
  db.prepare("INSERT INTO memory_meta VALUES(1,8,?,0,0,0,'off')").run(randomUUID());
  let caught: unknown;
  try { validateMemorySchema(db); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(MemoryMigrationError);
  const error = caught as MemoryMigrationError;
  expect(error.code).toBe("MEMORY_SCHEMA_NEWER");
  expect(error.message).toMatch(/Install the latest version of Murage/);
  expect(error.message).toContain("memory-downgrade --data-dir <your Murage data folder> --to 7");
  expect(error.message).not.toMatch(/safe|—|composio/i);
});

it("an unrecognised (not newer) memory_meta is still the bare unsupported error", () => {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  db.exec("CREATE TABLE memory_meta(id INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL CHECK(schema_version=0))");
  expect(() => validateMemorySchema(db)).toThrow("MEMORY_SCHEMA_UNSUPPORTED");
});

// Review (Opus, 2026-10-02) additions.
it("a volume whose statfs reports no size (some network and FUSE mounts) is unknown, not full", async () => {
  const { freeBytesFromStatfs } = await import("./schema.ts");
  expect(freeBytesFromStatfs({ blocks: 0, bavail: 0, bsize: 4096 })).toBeNull();
  expect(freeBytesFromStatfs({ blocks: 100, bavail: 10, bsize: 0 })).toBeNull();
  expect(freeBytesFromStatfs({ blocks: Number.NaN, bavail: 10, bsize: 4096 })).toBeNull();
  expect(freeBytesFromStatfs({ blocks: 100, bavail: 10, bsize: 4096 })).toBe(40960);
  expect(freeBytesFromStatfs({ blocks: 100n, bavail: 10n, bsize: 4096n })).toBe(40960);
});

it("a disk that fills during the copy although the check passed never asks to free a token 1 MB", () => {
  const f = v2Installation();
  let caught: unknown;
  const copy = () => { throw diskFull(); };
  try { migrateMemorySchema(f.db, "off", { snapshotV2Path: f.v3, freeBytes: () => 100 * GIB, copy }); } catch (error) { caught = error; }
  const error = caught as MemoryMigrationError;
  expect(error.code).toBe("MEMORY_MIGRATION_DISK_SPACE");
  expect(error.shortBytes).toBeGreaterThanOrEqual(64 * 1048576);
  expect(error.message).not.toMatch(/at least 1 MB/);
  expect(version(f.db)).toBe(2);
});

it("a killed or full-disk copy's SQLite side files are cleared with it", () => {
  const f = v2Installation();
  for (const suffix of [".partial", ".partial-journal", ".partial-wal", ".partial-shm"]) writeFileSync(`${f.v3}${suffix}`, "left by a killed start");
  migrateMemorySchema(f.db, "off", { snapshotV2Path: f.v3, freeBytes: () => 100 * GIB });
  expect(readdirSync(f.root).filter(name => name.includes(".partial"))).toEqual([]);
  const g = v2Installation();
  const copy = (_db: DatabaseSync, path: string) => { writeFileSync(path, "half"); writeFileSync(`${path}-journal`, "journal"); throw diskFull(); };
  expect(() => migrateMemorySchema(g.db, "off", { snapshotV2Path: g.v3, freeBytes: () => 100 * GIB, copy })).toThrow(MemoryMigrationError);
  expect(readdirSync(g.root).filter(name => name.includes(".partial"))).toEqual([]);
});
