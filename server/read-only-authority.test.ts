// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Boot tolerance, write authority: once the process is read-only, the two write primitives refuse on their own. No caller's guard is involved in
// any case below: each write is the raw call a forgotten guard would leave behind.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { SqliteOperationJournal, SqliteReceiptStore } from "./connected-app-journal.ts";
import { IoBudget } from "./io-budget.ts";
import { DiskFloorRefusal, isLowDisk } from "./db-busy.ts";
import { enterReadOnly, isReadOnly, schemaStep, startMode } from "./read-only-start.ts";
import { assertPiInventoryAvailable, installPiRootInventoryWiring } from "./pi-root-inventory.ts";
import { RootRegistry } from "./wipe/registry.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const outside = mkdtempSync(join(tmpdir(), "murage-authority-outside-"));
const inside = join(DATA_DIR, "authority.json");
const value = () => (database().prepare("SELECT v FROM authority_probe").get() as { v: number }).v;

beforeAll(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  expect(startMode(DATA_DIR)).toBe("normal");                       // the test volume has room: the start check itself says normal
  database().exec("CREATE TABLE authority_probe(v INTEGER); INSERT INTO authority_probe VALUES (1)");
  writeFileAtomic(inside, "before");
  writeFileAtomic(join(DATA_DIR, "pi-authority"), "MURAGE-PI-ROOTS 1 R fixture\n[]");
  const receipts=new SqliteReceiptStore(join(DATA_DIR,"receipt-authority.db"));
  for(const at of [1,10]) receipts.add({threadId:"thread-fixture",botId:"bot-fixture",generation:"fixture",classes:["send"],at},0,100);
  const operationSeed=join(outside,"operation-seed.db");
  new SqliteOperationJournal(operationSeed).put({handle:"operation-fixture",scope:"fixture",key:"fixture",label:undefined,startedAt:1,state:"pending",requirements:[],requirementsComplete:true});
  const copy=new DatabaseSync(operationSeed);try {copy.prepare("VACUUM INTO ?").run(join(DATA_DIR,"operation-authority.db"));} finally {copy.close();}
  const empty=new DatabaseSync(join(DATA_DIR,"empty-authority.db"));empty.exec("CREATE TABLE unrelated(v)");empty.close();
});

afterAll(() => { closeDatabase(); removeTempDirSync(outside); });

it("control: before the switch a raw statement and an atomic file write both land", () => {
  expect(isReadOnly()).toBe(false);
  database().prepare("UPDATE authority_probe SET v=2").run();
  expect(value()).toBe(2);
  expect(readFileSync(inside, "utf8")).toBe("before");
});

it("W1 a raw write on the open connection is refused by the engine from the moment a boot step turns the start read-only", () => {
  const db = database();
  enterReadOnly("authority-test");
  let caught: { errcode?: number } | undefined;
  try { db.prepare("UPDATE authority_probe SET v=3").run(); } catch (error) { caught = error as { errcode?: number }; }
  expect(caught?.errcode).toBe(8);                                  // SQLITE_READONLY: not a guard in a caller
  expect(() => db.exec("CREATE TABLE authority_other(v)")).toThrow();
  expect(value()).toBe(2);
});

it("W1 a connection opened in a read-only process refuses the same write", () => {
  closeDatabase();
  const db = database();
  let caught: { errcode?: number } | undefined;
  try { db.prepare("INSERT INTO authority_probe VALUES (9)").run(); } catch (error) { caught = error as { errcode?: number }; }
  expect(caught?.errcode).toBe(8);
  expect((db.prepare("SELECT COUNT(*) AS n FROM authority_probe").get() as { n: number }).n).toBe(1);
});

it("W2 an atomic file write inside the data dir is refused, typed as low disk, and leaves no file behind", () => {
  const listing = readdirSync(DATA_DIR).sort();
  let caught: unknown;
  try { writeFileAtomic(inside, "after"); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(DiskFloorRefusal);
  expect((caught as DiskFloorRefusal).op).toBe("read-only-start");
  expect(isLowDisk(caught)).toBe(true);
  expect(() => writeFileAtomic(join(DATA_DIR, "sub", "new.json"), "x")).toThrow(DiskFloorRefusal);
  expect(readFileSync(inside, "utf8")).toBe("before");
  expect(readdirSync(DATA_DIR).sort()).toEqual(listing);            // no temp file, no new file
});

it("W2 a path outside the data dir is not the gate's: it still writes", () => {
  const file = join(outside, "note.json");
  writeFileSync(file, "old");
  writeFileAtomic(file, "new");
  expect(readFileSync(file, "utf8")).toBe("new");
  // a sibling whose name only starts with the data dir's name is outside it too
  expect(() => writeFileAtomic(`${DATA_DIR}-sibling-authority.json`, "x")).not.toThrow();
  removeTempDirSync(`${DATA_DIR}-sibling-authority.json`);
});

it("W8 (MAIN 2026-11-17 Q4) a missing table reads as empty and is not created in the file; an existing one is left alone; the connection stays closed to writes", () => {
  const db = database();
  const inFile = (table: string) => db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name=?").get(table) !== undefined;
  let ran = 0;
  schemaStep(db, "authority_probe", () => { ran += 1; });            // already in the file: its initializer does not run
  expect(ran).toBe(0);
  const seen: DatabaseSync[] = [];
  schemaStep(db, "authority_lazy", (target) => { seen.push(target); target.exec("CREATE TABLE authority_lazy(v); CREATE TABLE authority_lazy_side(w)"); });
  expect(seen).toHaveLength(1);
  expect(seen[0] === db, "the initializer never runs on the data file's connection").toBe(false);
  expect([inFile("authority_lazy"), inFile("authority_lazy_side")]).toEqual([false, false]);
  expect(db.prepare("SELECT count(*) AS n FROM authority_lazy").get()).toEqual({ n: 0 });          // reads as empty
  expect(db.prepare("SELECT count(*) AS n FROM authority_lazy_side").get()).toEqual({ n: 0 });
  expect(() => db.prepare("INSERT INTO authority_lazy VALUES (1)").run()).toThrow(/readonly/);
  expect(() => db.exec("CREATE TABLE authority_after(v)")).toThrow(/readonly/);
  expect(() => schemaStep(db, "authority_never", () => { throw new Error("initializer failed"); })).toThrow("initializer failed");
  expect(() => db.prepare("INSERT INTO authority_probe VALUES (9)").run()).toThrow(/readonly/);   // still closed after a failed initializer
  expect(inFile("authority_never")).toBe(false);
});


it("W12 read-only secondary stores preserve existing records without pruning and missing files or tables read as empty", () => {
  const names=["receipt-authority.db","operation-authority.db","empty-authority.db"];
  const before=names.map(name=>readFileSync(join(DATA_DIR,name)));
  const listing=readdirSync(DATA_DIR).sort();
  const receipts=new SqliteReceiptStore(join(DATA_DIR,names[0]!));
  expect(receipts.load(5).map(row=>row.at)).toEqual([10]);
  expect(new SqliteOperationJournal(join(DATA_DIR,names[1]!)).load()).toMatchObject([{handle:"operation-fixture",state:"pending"}]);
  expect(new SqliteReceiptStore(join(DATA_DIR,names[2]!)).load(0)).toEqual([]);
  expect(new SqliteReceiptStore(join(DATA_DIR,"missing-receipts.db")).load(0)).toEqual([]);
  expect(new SqliteOperationJournal(join(DATA_DIR,"missing-operations.db")).load()).toEqual([]);
  expect(()=>receipts.add({threadId:"thread-fixture",botId:"bot-fixture",generation:"fixture",classes:["send"],at:20},0,100)).toThrow(DiskFloorRefusal);
  const raw=new DatabaseSync(join(DATA_DIR,names[0]!),{readOnly:true});
  try {expect(raw.prepare("SELECT at FROM connected_app_receipts ORDER BY at").all()).toEqual([{at:1},{at:10}]);} finally {raw.close();}
  expect(names.map(name=>readFileSync(join(DATA_DIR,name)))).toEqual(before);
  expect(readdirSync(DATA_DIR).sort()).toEqual(listing);
});

it("W15 a refused Pi inventory publication keeps the old bytes and fences execution without creating directories", () => {
  expect(isReadOnly()).toBe(true);
  const before = readdirSync(DATA_DIR).sort();
  for (const path of [join(DATA_DIR, "pi-authority"), join(DATA_DIR, "pi-absent", "inventory")]) {
    const registry = new RootRegistry({ realpath: path => path, isBlockDevice: () => false });
    try { installPiRootInventoryWiring({ bots: () => [], groups: () => [], groupRoots: () => [], onChange: () => () => {} }, registry, { path }).dispose(); }
    catch (error) { expect(error).toBeInstanceOf(DiskFloorRefusal); }
    expect(() => assertPiInventoryAvailable(path)).toThrow("wipe-root-inventory-unavailable");
  }
  expect(existsSync(join(DATA_DIR, "pi-authority")), "the old inventory remains").toBe(true);
  expect(readFileSync(join(DATA_DIR, "pi-authority"), "utf8")).toBe("MURAGE-PI-ROOTS 1 R fixture\n[]");
  expect(readdirSync(DATA_DIR).sort()).toEqual(before);
});

it("W17 BOOT_RECOVERY cannot admit a write in a read-only process even if its producer allows it", () => {
  enterReadOnly("authority-test");
  expect(isReadOnly()).toBe(true);
  const budget = new IoBudget({ read: () => ({ at: 30_000, fsWriteBlocks: 0, cpuMicros: 0 }), isIdle: () => true });
  try {
    budget.resetAdmissionForFixture();
    const recovery = budget.claimBootRecovery(() => true)!;
    expect(recovery).not.toBeNull();
    expect(budget.admit("BOOT_RECOVERY", 64 * 1024)).toBeNull();
    let ran = false;
    expect(() => recovery.run(() => { ran = true; })).toThrow();
    expect(ran).toBe(false);
    expect(budget.admissionState()).toMatchObject({ bg: 0, debt: 0, reserved: 0 });
    recovery.close();
  } finally { budget.stop(); }
});
