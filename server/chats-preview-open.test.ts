import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const tracking = vi.hoisted(() => { vi.resetModules(); return { files: [] as string[], closedFiles: [] as string[], referenceRows: [] as number[], fault: false }; });
vi.mock("node:sqlite", async importOriginal => {
  const actual = await importOriginal<typeof import("node:sqlite")>();
  return { ...actual, DatabaseSync: class extends actual.DatabaseSync {
    private previewFile: string;
    constructor(file: string, options?: import("node:sqlite").DatabaseSyncOptions) {
      tracking.files.push(String(file));
      if (tracking.files.filter(path => path === String(file) && path.endsWith("messages.db")).length > 1) throw Error("recursive serving open");
      super(file, options ?? {});
      this.previewFile = String(file);
    }
    override close() {
      if (this.previewFile === ":memory:" && super.prepare("SELECT 1 FROM sqlite_schema WHERE name='chats_gen'").get())
        tracking.referenceRows.push(Number(super.prepare("SELECT count(*) AS n FROM chats_gen").get()!.n));
      super.close();
      tracking.closedFiles.push(this.previewFile);
    }
    override prepare(sql: string) {
      if (tracking.fault && sql.startsWith("UPDATE chats_gen SET epoch=")) throw Error("schema mint fault");
      return super.prepare(sql);
    }
  } };
});
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { CHATS_PREVIEW_TABLES, downgradeChatsPreviewTables, readChatsGen } from "./thread-summary.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, {recursive:true}); tracking.files=[]; tracking.closedFiles=[]; tracking.fault=false; });
afterEach(() => { tracking.fault=false; closeDatabase(); });
it("T-OPEN-CLOSED opens one serving connection, mints one row and preserves it on reopen and remints after downgrade", () => {
  const db=database(), gen=readChatsGen(db);
  expect(tracking.files.filter(file=>file===join(DATA_DIR,"messages.db"))).toHaveLength(1);
  expect(db.prepare("SELECT * FROM chats_gen").all()).toEqual([{id:1,...gen}]);
  expect(gen).toEqual({epoch:expect.stringMatching(/^[a-f0-9]{32}$/),rev:0});
  expect(database()).toBe(db); expect(readChatsGen(db)).toEqual(gen);
  closeDatabase(); tracking.files=[];
  expect(readChatsGen(database())).toEqual(gen);
  downgradeChatsPreviewTables(database()); closeDatabase(); tracking.files=[];
  const upgraded=database(); expect(readChatsGen(upgraded).epoch).not.toBe(gen.epoch);
  expect(upgraded.prepare("SELECT count(*) AS n FROM chats_gen").get()?.n).toBe(1);
  expect(tracking.files.filter(file=>file===join(DATA_DIR,"messages.db"))).toHaveLength(1);
});
it("T-OPEN-CLOSED rolls preview CREATE and mint back and closes the local handle on schema failure", () => {
  tracking.fault=true; expect(()=>database()).toThrow("schema mint fault");
  expect(tracking.closedFiles).toContain(join(DATA_DIR,"messages.db"));
  tracking.fault=false; tracking.files=[];
  const probe=new DatabaseSync(join(DATA_DIR,"messages.db"));
  try { for(const table of CHATS_PREVIEW_TABLES) expect(probe.prepare("SELECT name FROM sqlite_schema WHERE name=?").get(table)).toBeUndefined();
    probe.exec("BEGIN EXCLUSIVE; ROLLBACK");
  } finally { probe.close(); }
  tracking.files=[]; expect(readChatsGen(database()).rev).toBe(0);
});

it("T-HANDLE-ONLY cold reference inspection never opens a serving file or mints a reference generation", async () => {
  database(); closeDatabase(); tracking.files=[]; tracking.referenceRows=[];
  const db=new DatabaseSync(join(DATA_DIR,"messages.db"),{readOnly:true});
  try {
    const {inspectInstallationDatabase}=await import("./installation-database-snapshot.ts");
    inspectInstallationDatabase(db);
    expect(tracking.files.filter(file=>file===join(DATA_DIR,"messages.db"))).toHaveLength(1);
    expect(tracking.referenceRows).toContain(0);
    expect(tracking.referenceRows.every(count=>count===0)).toBe(true);
  } finally {db.close();}
});
