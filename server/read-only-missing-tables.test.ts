// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Boot tolerance W11 (MAIN 2026-11-17 Q4): a read-only start on a message database that lacks the three lazily-created tables (image_operations,
// own_write_holds, owner_sends: a file last opened by a build before them) writes nothing, and each table reads as empty. The next normal start
// creates them in the file. Each start is a fresh load of the server modules (vi.resetModules), as a new process would be.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const LAZY = ["image_operations", "own_write_holds", "owner_sends"];
type Database = typeof import("./database.ts");
/** Every file under the data dir with the hash of its bytes (the -shm index a reader rebuilds is not data; there is no -wal after a clean close). */
const bytes = (dir = DATA_DIR): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? bytes(join(dir, entry.name))
  : entry.isFile() && !entry.name.endsWith("-shm") ? [`${join(dir, entry.name).slice(DATA_DIR.length)} ${createHash("sha256").update(readFileSync(join(dir, entry.name))).digest("hex")}`] : []);
const inFile = (names: string[]) => {
  const db = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
  try { return names.filter(name => db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name) !== undefined); } finally { db.close(); }
};
async function start(): Promise<Database> { vi.resetModules(); return await import("./database.ts"); }
/** A stopped process, by the production shutdown order (data-writers.ts): the server connection closes, then the log checkpointer and the search
 * worker have really exited, so no other handle on the file is left. Same module instances as this start's database.ts. */
const stop = async (db: Database) => {
  const [{ stopDataWriters }, { stopWalMaintenance }, { stopSearchIndex }] = await Promise.all([import("./data-writers.ts"), import("./wal-maintenance.ts"), import("./message-search-index.ts")]);
  expect(await stopDataWriters({ closeDatabase: db.closeDatabase, stopEngineHistory: async () => true, stopWalMaintenance, stopSearchIndex })).toBe(true);
};

beforeAll(async () => {
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  const first = await start();                                         // a normal first start makes every table (image_operations on its first use)
  const { initializeImageOperations } = await import("./image-operations-schema.ts");
  initializeImageOperations(first.database());
  await stop(first);
  const db = new DatabaseSync(join(DATA_DIR, "messages.db"));         // then the file is made the shape an older build left: the three tables absent
  for (const { name } of db.prepare(`SELECT name FROM sqlite_schema WHERE type='trigger' AND (${LAZY.map(() => "sql LIKE ?").join(" OR ")})`).all(...LAZY.map(t => `%${t}%`)) as Array<{ name: string }>) db.exec(`DROP TRIGGER "${name}"`);
  for (const table of LAZY) db.exec(`DROP TABLE ${table}`);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
  expect(inFile(LAZY)).toEqual([]);
});

it("W11 a read-only start on a file without the three lazy tables writes nothing and reads each as empty; the next normal start creates them", { timeout: 60_000 }, async () => {
  const before = bytes();
  const warn = vi.spyOn(console, "warn");
  const readOnly = await start();
  const { enterReadOnly } = await import("./read-only-start.ts");
  enterReadOnly("missing-tables-test");                               // the process is read-only before its database opens
  const db = readOnly.database();                                     // the open runs the owner_sends and own_write_holds initializers
  const { initializeImageOperations } = await import("./image-operations-schema.ts");
  initializeImageOperations(db);                                      // image_operations is made on first use (image-operations.ts db())
  for (const table of LAZY) expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get(), `${table} reads as empty`).toEqual({ n: 0 });
  expect(() => db.prepare("INSERT INTO owner_sends DEFAULT VALUES").run()).toThrow(/readonly/);
  const { initializeOwnerSends } = await import("./send-store.ts");
  initializeOwnerSends(db);                                           // a lazy caller after the open (send-store's first use) changes nothing either
  expect(() => db.prepare("INSERT INTO owner_sends DEFAULT VALUES").run()).toThrow(/readonly/);
  expect(warn.mock.calls.map(call => String(call[0])).filter(line => / reads as empty and the next normal start creates it$/.test(line)).sort())
    .toEqual(expect.arrayContaining(LAZY.map(table => `[startup] read-only start: table ${table} is not in this file; it reads as empty and the next normal start creates it`)));
  await stop(readOnly); warn.mockRestore();
  expect(inFile(LAZY), "no table was created in the file").toEqual([]);
  expect(bytes(), "every byte of the data dir is as it was").toEqual(before);

  const normal = await start();
  const { initializeImageOperations: firstUse } = await import("./image-operations-schema.ts");
  firstUse(normal.database()); await stop(normal);
  expect(inFile(LAZY), "the next normal start created them").toEqual(LAZY);
});


it("W13 a first-ever read-only primary store reads empty in memory and creates no database file", {timeout:60_000}, async () => {
  removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});
  const first=await start();const {enterReadOnly}=await import("./read-only-start.ts");enterReadOnly("first-empty-store");
  const before=bytes(),db=first.database();
  expect(db.prepare("SELECT count(*) AS n FROM messages").get()).toEqual({n:0});
  // H2: the in-memory store is kept for the process; a later call must not close it under a holder and build another empty one.
  expect(first.database(),"the same in-memory handle on every later call").toBe(db);
  expect(first.database()).toBe(db);
  expect(db.prepare("SELECT count(*) AS n FROM messages").get(),"the held connection is still open").toEqual({n:0});
  const {initializeImageOperations}=await import("./image-operations-schema.ts");initializeImageOperations(db);
  expect(first.database(),"still the same handle after a lazy initializer ran on it").toBe(db);
  for(const table of LAZY) expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({n:0});
  expect(()=>db.prepare("INSERT INTO owner_sends DEFAULT VALUES").run()).toThrow(/readonly/);
  // the server registers the chat-generation publisher right after the open (index.ts): a first-ever store needs its generation row in RAM
  const {readChatsGen,registerChatsGenPublisher}=await import("./thread-summary.ts");
  expect(readChatsGen(db).epoch,"a first-ever read-only store has a chat generation").toMatch(/^[0-9a-f]{32}$/);
  registerChatsGenPublisher(db,()=>{})();
  expect(existsSync(join(DATA_DIR,"messages.db")),"the primary store is only in memory").toBe(false);
  await stop(first);
  expect(bytes(),"no first-run file or worker database was created").toEqual(before);
});


it("W13b a read-only start on a file without the chat-generation table reads a generation and writes nothing", {timeout:60_000}, async () => {
  removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});
  const normal=await start();normal.database();await stop(normal);
  const old=new DatabaseSync(join(DATA_DIR,"messages.db"));            // a file last opened by a build before the chats preview tables
  try {old.exec("DROP TABLE chats_gen");old.exec("PRAGMA wal_checkpoint(TRUNCATE)");} finally {old.close();}
  const before=bytes(),readOnly=await start();
  const {enterReadOnly}=await import("./read-only-start.ts");enterReadOnly("missing-chats-gen");
  const db=readOnly.database();
  const {readChatsGen,registerChatsGenPublisher}=await import("./thread-summary.ts");
  expect(readChatsGen(db).epoch,"the generation reads from the temp table").toMatch(/^[0-9a-f]{32}$/);
  registerChatsGenPublisher(db,()=>{})();
  await stop(readOnly);
  expect(inFile(["chats_gen"]),"no table was created in the file").toEqual([]);
  // An empty (0-byte) messages.db-wal is left by this fixture's read-only open with or without the generation reads (pre-existing, reported
  // separately); it holds no data, so only that exact empty file is set aside. Every data byte must be as it was.
  const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  expect(bytes().filter(line => line !== `/messages.db-wal ${EMPTY}`),"every data byte of the data dir is as it was").toEqual(before);
});

it("W14 an existing non-WAL database opens read-only without changing its journal mode or any file byte", {timeout:60_000}, async () => {
  removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});
  const normal=await start();normal.database();await stop(normal);
  const seed=new DatabaseSync(join(DATA_DIR,"messages.db"));
  try {expect(seed.prepare("PRAGMA journal_mode=DELETE").get()).toEqual({journal_mode:"delete"});} finally {seed.close();}
  const before=bytes(),readOnly=await start();
  const {enterReadOnly}=await import("./read-only-start.ts");enterReadOnly("closed-archive");
  expect(readOnly.database().prepare("PRAGMA journal_mode").get()).toEqual({journal_mode:"delete"});
  expect(readOnly.database().prepare("SELECT count(*) AS n FROM messages").get()).toEqual({n:0});
  await stop(readOnly);expect(bytes()).toEqual(before);
});


it("W16 the last read-only handle leaves a terminated writer's committed WAL and main file byte-identical", {timeout:60_000}, async () => {
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR,{recursive:true});
  const normal=await start();normal.database();await stop(normal);
  const file=join(DATA_DIR,"messages.db");
  const writer=spawnSync(process.execPath,["--input-type=module","-e",`
    import {DatabaseSync} from "node:sqlite";
    const db=new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE retained_wal_probe(v); INSERT INTO retained_wal_probe VALUES (7)");
    process.kill(process.pid,"SIGKILL");
  `,file]);
  expect(writer.error).toBeUndefined();expect(writer.signal).toBe("SIGKILL");
  expect(readFileSync(file+"-wal").length).toBeGreaterThan(0);
  const before=bytes(),readOnly=await start();
  const {enterReadOnly}=await import("./read-only-start.ts");enterReadOnly("retained-wal");
  expect(readOnly.database().prepare("SELECT v FROM retained_wal_probe").all()).toEqual([{v:7}]);
  expect(()=>readOnly.database().prepare("INSERT INTO retained_wal_probe VALUES (8)").run()).toThrow(/readonly/);
  await stop(readOnly);
  expect(bytes(),"neither checkpoint into the main file nor deletion of the retained WAL is allowed").toEqual(before);
});
