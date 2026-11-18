// SPDX-License-Identifier: AGPL-3.0-or-later
// Boot tolerance (docs/designs/boot-tolerance/ACCEPTANCE.md): the start decision (A1, the part that needs no small filesystem), the floor pin, and
// bootStep's contract (B1 with constructed errors; the real SQLITE_FULL/ENOSPC legs run in low-disk-repro.test.ts R0c).
import { existsSync, statSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { DatabaseBusyError, DiskFloorRefusal, isLowDisk } from "./db-busy.ts";
import { FLOOR_BYTES, RESERVE_BYTES, START_FLOOR_BYTES, bootStep, ensureReserve, reservePath, decideStartMode, enterReadOnly, isReadOnly, skippedAtStart } from "./read-only-start.ts";

import { MEMORY_SCHEMA_V3 } from "./memory/schema.ts";
import { DEFAULT_MEMORY_LEARNING_V1 } from "./memory/learning-policy.ts";
import { STRICT, onStrictMount, fillTo, MiB } from "./testing/strict-fs.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

describe("read-only start", () => {
  it("the start floor is twice the worker's floor, and the worker program carries the same 64 MiB", () => {
    expect(FLOOR_BYTES).toBe(64 * 1024 * 1024);
    expect(START_FLOOR_BYTES).toBe(2 * FLOOR_BYTES);
    expect(readFileSync(join(SERVER_DIR, "wal-maintenance.ts"), "utf8")).toContain("diskLow = disk.bavail * disk.bsize < 64*1048576;");
  });

  it("A1 decides from the nearest existing directory and creates nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "murage-ros-"));
    try {
      const missing = join(root, "not", "yet", ".murage");
      const decision = decideStartMode(missing);
      expect(decision.statPath).toBe(root);
      expect(existsSync(join(root, "not"))).toBe(false);
      expect(decision.mode).toBe(decision.freeBytes < START_FLOOR_BYTES ? "read-only" : "normal");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(!onStrictMount)("A1 caches both real filesystem decisions after free space changes", async () => {
    const root=join(STRICT,"a1-cache"), ballast=join(root,"ballast");mkdirSync(root,{recursive:true});
    const missing=join(root,"not","yet","data");
    try {
      vi.resetModules();const normal=await import("./read-only-start.ts");
      expect(normal.startMode(missing)).toBe("normal");
      fillTo(ballast,100*MiB);
      expect(normal.decideStartMode(missing).mode).toBe("read-only");
      expect(normal.startMode(missing)).toBe("normal");
      vi.resetModules();const low=await import("./read-only-start.ts");
      expect(low.startMode(missing)).toBe("read-only");
      rmSync(ballast);
      expect(low.decideStartMode(missing).mode).toBe("normal");
      expect(low.startMode(missing)).toBe("read-only");
      expect(existsSync(join(root,"not"))).toBe(false);
    } finally { rmSync(root,{recursive:true,force:true}); }
  });

  it.skipIf(!onStrictMount)("B1 real SQLITE_FULL and ENOSPC switch the start and hold later steps", async () => {
    const root=join(STRICT,"b1-real"), ballast=join(root,"ballast");mkdirSync(root,{recursive:true});
    const db=new DatabaseSync(join(root,"full.db"));
    try {
      db.exec("CREATE TABLE probe(v BLOB)");fillTo(ballast,0);
      let sql: unknown,fs: unknown;
      try { db.exec("INSERT INTO probe VALUES(randomblob(10000))"); } catch(error) { sql=error; }
      try { writeFileSync(join(root,"full-file"),"x"); } catch(error) { fs=error; }
      expect(sql).toMatchObject({errcode:13});expect(fs).toMatchObject({code:"ENOSPC"});
      rmSync(ballast);
      for(const error of [undefined,sql,fs]) {
        vi.resetModules();const mode=await import("./read-only-start.ts");
        const failure=error??new (await import("./db-busy.ts")).DiskFloorRefusal("disk-floor");
        expect(mode.bootStep("full",()=>{throw failure;},7)).toBe(7);
        expect(mode.isReadOnly()).toBe(true);
        let ran=false;expect(mode.bootStep("later",()=>{ran=true;return 1;},9)).toBe(9);
        expect(ran).toBe(false);expect(mode.skippedAtStart).toEqual(["full","later"]);
      }
    } finally { db.close();rmSync(root,{recursive:true,force:true}); }
  });

  it("B1 low disk switches the start to read-only; anything else is rethrown; read-only runs no step", () => {
    expect(isLowDisk(new DiskFloorRefusal("disk-floor"))).toBe(true);
    expect(isLowDisk(Object.assign(new Error("database or disk is full"), { errcode: 13 }))).toBe(true);
    expect(isLowDisk(Object.assign(new Error("no space"), { code: "ENOSPC" }))).toBe(true);
    expect(isLowDisk(new DatabaseBusyError("wal-recovery", 0))).toBe(false);
    expect(isLowDisk(Object.assign(new Error("database is locked"), { errcode: 5 }))).toBe(false);

    expect(() => bootStep("busy", () => { throw Object.assign(new Error("database is locked"), { errcode: 5 }); }, 0)).toThrow("database is locked");
    expect(() => bootStep("plain", () => { throw new Error("plain"); }, 0)).toThrow("plain");
    expect(isReadOnly()).toBe(false);
    expect(bootStep("normal", () => 1, 0)).toBe(1);

    expect(bootStep("full", () => { throw Object.assign(new Error("database or disk is full"), { errcode: 13 }); }, 7)).toBe(7);
    expect(isReadOnly()).toBe(true);
    let ran = false;
    expect(bootStep("later", () => { ran = true; return 1; }, 9)).toBe(9);
    expect(ran).toBe(false);
    expect(skippedAtStart).toEqual(["full", "later"]);
  });

  it("A6 no migration starts read-only", () => {
    // The existing pre-v4 schema and learning settings, as in the migration fixtures: the entire migration must remain unstarted.
    mkdirSync(DATA_DIR, { recursive: true });
    const file = join(DATA_DIR, "messages.db");
    const seed = new DatabaseSync(file);
    seed.exec("PRAGMA journal_mode=WAL; CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
    seed.exec(MEMORY_SCHEMA_V3);
    seed.exec("INSERT INTO memory_meta VALUES(1,3,'fixture-installation',4,5,6,'active')");
    seed.prepare("INSERT INTO memory_learning_config VALUES(1,3,?)").run(JSON.stringify(DEFAULT_MEMORY_LEARNING_V1));
    seed.close();
    enterReadOnly("a6-fixture");
    expect(isReadOnly()).toBe(true);
    try {
      expect(() => database()).toThrow(DiskFloorRefusal);
      expect(() => database()).toThrow(expect.objectContaining({ op: "start-migration" }));
    } finally { closeDatabase(); }
    expect(readdirSync(DATA_DIR).filter(name => /snapshot|pre-v|\.partial/i.test(name))).toEqual([]);
    const check = new DatabaseSync(file, { readOnly: true });
    try { expect(check.prepare("SELECT schema_version AS v FROM memory_meta WHERE id=1").get()).toEqual({ v: 3 }); } finally { check.close(); }
  });
});

describe("the low-disk reserve (R0b, 0 bytes free)", () => {
  it("a normal start writes it beside the data dir, once, never inside it", () => {
    const root = mkdtempSync(join(tmpdir(), "reserve-"));
    try {
      const data = join(root, "data"); mkdirSync(data);
      expect(dirname(reservePath(data))).toBe(root);
      if (decideStartMode(root).freeBytes < START_FLOOR_BYTES + RESERVE_BYTES) return; // a small filesystem: nothing to assert about a normal start
      ensureReserve(data);
      expect(statSync(reservePath(data)).size).toBe(RESERVE_BYTES);
      expect(readdirSync(data)).toEqual([]);
      ensureReserve(data);
      expect(statSync(reservePath(data)).size).toBe(RESERVE_BYTES);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
