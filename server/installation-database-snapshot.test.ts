import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { acquireDataDirLease } from "../electron/data-dir-lease.mjs";
import { initializeArtifacts } from "./artifacts.ts";
import { initializeInbox } from "./inbox.ts";
import { snapshotInstallationDatabase, withOfflineInstallation, type OfflineInstallation } from "./installation-database-snapshot.ts";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
function fixture() {
  const scratch = mkdtempSync(join(tmpdir(), "murage-db-snapshot-"));
  roots.push(scratch);
  const data = join(scratch, "installation");
  mkdirSync(data);
  const db = new DatabaseSync(join(data, "messages.db"));
  databases.push(db);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE messages(thread_id TEXT,id TEXT,at INTEGER,role TEXT,kind TEXT,text TEXT,json TEXT,PRIMARY KEY(thread_id,id));
    CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY,active_leaf_id TEXT);`);
  db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?)").run("t", "m", 1, "bot", "goal.run", null, JSON.stringify({ id: "m", at: 1, role: "bot", kind: "goal.run", goalRun: { status: "completed", detail: "Receipt canary" } }));
  db.exec("INSERT INTO thread_state VALUES ('t','m')");
  return { scratch, data, db, target: join(scratch, "snapshot.db") };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([
  ["missing required column", "ALTER TABLE messages DROP COLUMN text", "DATABASE_SCHEMA_UNSUPPORTED"],
  ["unknown trigger", "CREATE TRIGGER hostile AFTER UPDATE ON messages BEGIN DELETE FROM thread_state; END", "DATABASE_SCHEMA_UNSUPPORTED"],
  ["column/JSON disagreement", "UPDATE messages SET role='user'", "INVALID_MESSAGE_IDENTITY"],
  ["missing parent", `UPDATE messages SET json=json_set(json,'$.parentId','missing')`, "INVALID_MESSAGE_PARENT"],
  ["self cycle", `UPDATE messages SET json=json_set(json,'$.parentId','m')`, "CYCLIC_MESSAGE_BRANCH"],
])("refuses %s while preserving the source", async (_name, sql, code) => {
  const f = fixture(); f.db.exec(sql);
  await expect(snapshotInstallationDatabase(f.data, f.target)).rejects.toMatchObject({ code });
  expect(existsSync(f.target)).toBe(false);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM messages").get()?.n).toBe(1);
});

it("preserves valid forks whose parent was inserted after an existing child", async () => {
  const f = fixture();
  f.db.prepare("UPDATE messages SET json=json_set(json,'$.parentId','later')").run();
  f.db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?)").run("t", "later", 2, "bot", "text", "parent", JSON.stringify({ id: "later", at: 2, role: "bot", kind: "text", text: "parent", parentId: null }));
  expect(await snapshotInstallationDatabase(f.data, f.target)).toMatchObject({ status: "copied", messages: 2 });
});

it("accepts the inbox and saved-file tables the harness creates, and an older archive without the migrated columns", async () => {
  // A real installation carries every table server/database.ts initializes;
  // the inspector refusing them would refuse every backup made since 0.1.48.
  const f = fixture();
  initializeInbox(f.db); initializeArtifacts(f.db);
  expect(await snapshotInstallationDatabase(f.data, f.target)).toMatchObject({ status: "copied", messages: 1, threads: 1 });
  const older = fixture();
  initializeInbox(older.db); initializeArtifacts(older.db);
  older.db.exec("ALTER TABLE artifacts DROP COLUMN publication_id; ALTER TABLE artifacts DROP COLUMN producer");
  expect(await snapshotInstallationDatabase(older.data, older.target)).toMatchObject({ status: "copied" });
});

it.each([
  ["an unknown table", "CREATE TABLE plugins(id TEXT PRIMARY KEY)"],
  ["an unknown index on a known table", "CREATE INDEX hostile ON artifacts(name)"],
  ["a known table with a foreign column", "ALTER TABLE inbox_item_state ADD COLUMN extra TEXT"],
  ["a migrated column out of order", "ALTER TABLE artifacts DROP COLUMN producer"],
])("still refuses %s", async (_name, sql) => {
  const f = fixture();
  initializeInbox(f.db); initializeArtifacts(f.db);
  f.db.exec(sql);
  await expect(snapshotInstallationDatabase(f.data, f.target)).rejects.toMatchObject({ code: "DATABASE_SCHEMA_UNSUPPORTED" });
  expect(existsSync(f.target)).toBe(false);
});

it("copies committed WAL data, branch head and terminal receipt without the runtime Store", async () => {
  const f = fixture();
  expect(existsSync(join(f.data, "messages.db-wal"))).toBe(true);
  const before = readFileSync(join(f.data, "messages.db"));
  const result = await snapshotInstallationDatabase(f.data, f.target);
  expect(result).toMatchObject({ status: "copied", messages: 1, threads: 1, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(readFileSync(join(f.data, "messages.db"))).toEqual(before);
  const copy = new DatabaseSync(f.target, { readOnly: true });
  try {
    expect(copy.prepare("SELECT active_leaf_id FROM thread_state").get()?.active_leaf_id).toBe("m");
    expect(JSON.parse(String(copy.prepare("SELECT json FROM messages").get()?.json)).goalRun.status).toBe("completed");
  } finally { copy.close(); }
});

it("refuses a live installation owner without producing a destination", async () => {
  const f = fixture();
  const owner = acquireDataDirLease(f.data);
  try { await expect(snapshotInstallationDatabase(f.data, f.target)).rejects.toThrow(); }
  finally { owner.release(); }
  expect(existsSync(f.target)).toBe(false);
});

it("never overwrites an existing destination", async () => {
  const f = fixture();
  writeFileSync(f.target, "existing-backup-canary");
  await expect(snapshotInstallationDatabase(f.data, f.target)).rejects.toMatchObject({ code: "DESTINATION_EXISTS" });
  expect(readFileSync(f.target, "utf8")).toBe("existing-backup-canary");
});

it("refuses invalid branch state without publishing a seemingly healthy backup", async () => {
  const f = fixture();
  f.db.exec("UPDATE thread_state SET active_leaf_id='missing'");
  await expect(snapshotInstallationDatabase(f.data, f.target)).rejects.toMatchObject({ code: "INVALID_ACTIVE_BRANCH" });
  expect(existsSync(f.target)).toBe(false);
  expect(f.db.prepare("SELECT active_leaf_id FROM thread_state").get()?.active_leaf_id).toBe("missing");
});

it("does not create an absent installation or put a snapshot inside it", async () => {
  const f = fixture();
  const absent = join(f.scratch, "absent");
  expect(await snapshotInstallationDatabase(absent, f.target)).toEqual({ status: "absent" });
  expect(existsSync(absent)).toBe(false);
  await expect(snapshotInstallationDatabase(f.data, join(f.data, "copy.db"))).rejects.toMatchObject({ code: "DESTINATION_INSIDE_INSTALLATION" });
});

it("holds the same epoch across database and other component work, then invalidates escaped operations", async () => {
  const f = fixture();
  let escaped: OfflineInstallation | undefined;
  await withOfflineInstallation(f.data, async installation => {
    escaped = installation;
    expect(() => acquireDataDirLease(f.data)).toThrow();
    await installation.snapshotDatabase(f.target);
    await new Promise(resolve => setTimeout(resolve, 1));
    expect(() => acquireDataDirLease(f.data)).toThrow();
    expect(readFileSync(join(f.data, "messages.db")).byteLength).toBeGreaterThan(0);
  });
  await expect(escaped!.snapshotDatabase(join(f.scratch, "late.db"))).rejects.toMatchObject({ code: "SNAPSHOT_EPOCH_CLOSED" });
  const owner = acquireDataDirLease(f.data);
  owner.release();
});

it.skipIf(process.platform === "win32")("rejects a destination symlink without touching its target", async () => {
  const f = fixture();
  const sentinel = join(f.scratch, "untouched");
  writeFileSync(sentinel, "must survive");
  symlinkSync(sentinel, f.target);
  await expect(snapshotInstallationDatabase(f.data, f.target)).rejects.toMatchObject({ code: "DESTINATION_EXISTS" });
  expect(readFileSync(sentinel, "utf8")).toBe("must survive");
});

it("rejects malformed message JSON with no secret-bearing diagnostics or staging debris", async () => {
  const f = fixture();
  f.db.prepare("UPDATE messages SET json=?").run('{"private":"never-echo-this",');
  let failure: unknown;
  try { await snapshotInstallationDatabase(f.data, f.target); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: "INVALID_MESSAGE_JSON" });
  expect(String(failure)).not.toContain("never-echo-this");
  expect((failure as Error).cause).toBeUndefined();
  expect(readdirSync(f.scratch).filter(name => name.startsWith(".murage-database-snapshot-"))).toEqual([]);
  expect(existsSync(f.target)).toBe(false);
  const owner = acquireDataDirLease(f.data);
  owner.release();
});
