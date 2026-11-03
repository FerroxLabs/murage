// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SMOOTH-FTS-MERGE R6 T10: the damaged export settles its scratch copy of messages.db (the scratch -shm deleted first, the -wal
// folded in) or withholds all three names with the approved sentence. Never a raw copy; a name is in exactly one list.
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as yauzl from "yauzl";
import { afterEach, expect, it, vi } from "vitest";
import { DAMAGED_EXPORT_DATABASE_WITHHELD, DAMAGED_EXPORT_FOLDED_REASON, DAMAGED_EXPORT_SHORT_DISK_LOG, writeInstallationDamagedExport, type DamagedExportManifest } from "./installation-damaged-export.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { ftsSettled, settleCopyIo } from "./settle-copy.ts";
import { DELETED_TEXT, deleteThreadRows, ftsBlocksHold, holdMerges, keptRows, seedMixed } from "./testing/fts-copy-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
const realFreeBytes = settleCopyIo.freeBytes;
afterEach(() => {
  settleCopyIo.freeBytes = realFreeBytes;
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const root of roots.splice(0)) removeTempDirSync(root);
});
const FAMILY = ["messages.db", "messages.db-wal", "messages.db-shm"];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-settle-damaged-")); roots.push(root);
  const data = join(root, "source"), target = join(root, "preservation.zip"); mkdirSync(data);
  writeFileSync(join(data, "config.json"), '{"profile":');
  return { root, data, target };
}
/** A live WAL-mode messages.db whose -wal holds committed frames: the deleted thread's tombstones and kept rows only in the WAL. */
function liveDatabase(data: string) {
  const db = new DatabaseSync(join(data, "messages.db")); databases.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  initializeMessageTables(db);
  holdMerges(db);
  seedMixed(db, { keptThread: "kept", deletedThread: "gone", kept: 300, deleted: 60, text: DELETED_TEXT.zh });
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  // after the checkpoint: these rows and the delete live only in the -wal
  seedMixed(db, { keptThread: "kept", deletedThread: "gone", kept: 100, deleted: 20, text: DELETED_TEXT.zh });
  deleteThreadRows(db, "gone");
  expect(ftsSettled(db)).toBe("owed");
  return db;
}
async function readZip(path: string) {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(path, { lazyEntries: true }, (error, value) => error ? reject(error) : resolve(value!)));
  const files = new Map<string, Buffer>();
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject); zip.on("end", resolve);
      zip.on("entry", entry => zip.openReadStream(entry, (error, stream) => {
        if (error) { reject(error); return; }
        const chunks: Buffer[] = [];
        stream!.on("error", reject);
        stream!.on("data", chunk => chunks.push(Buffer.from(chunk)));
        stream!.on("end", () => { files.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
      }));
      zip.readEntry();
    });
  } finally { zip.close(); }
  return files;
}
/** Every name of the family appears in exactly one of files, omitted and missing. */
function expectSingleList(manifest: DamagedExportManifest) {
  for (const name of FAMILY) {
    const places = [manifest.files.some(entry => entry.path === name), manifest.omitted.some(entry => entry.path === name), manifest.missing.includes(name)].filter(Boolean).length;
    expect(places, name).toBe(1);
  }
}
const expectWithheld = (manifest: DamagedExportManifest) => {
  for (const name of FAMILY) expect(manifest.omitted.filter(entry => entry.path === name)).toEqual([{ path: name, reason: DAMAGED_EXPORT_DATABASE_WITHHELD }]);
  expect(manifest.files.filter(entry => FAMILY.includes(entry.path))).toEqual([]);
  expectSingleList(manifest);
};

it("T10a: owed and opens: only the settled main file is exported, -wal and -shm listed as folded, kept rows from the WAL included", async () => {
  const f = fixture();
  const db = liveDatabase(f.data);
  // a -shm from another moment: the export deletes its scratch copy before SQLite opens the database
  db.exec("SELECT 1");
  writeFileSync(join(f.data, "messages.db-shm"), Buffer.alloc(32768, 7));
  const result = await writeInstallationDamagedExport(f.data, f.target);
  const manifest = result.manifest;
  expectSingleList(manifest);
  expect(manifest.omitted.filter(entry => FAMILY.includes(entry.path))).toEqual([
    { path: "messages.db-wal", reason: DAMAGED_EXPORT_FOLDED_REASON },
    { path: "messages.db-shm", reason: DAMAGED_EXPORT_FOLDED_REASON },
  ]);
  const entries = await readZip(f.target);
  expect(entries.has("preservation/messages.db-wal")).toBe(false);
  expect(entries.has("preservation/messages.db-shm")).toBe(false);
  const main = entries.get("preservation/messages.db")!;
  expect(main.includes(Buffer.from(DELETED_TEXT.zh))).toBe(false);
  expect(readFileSync(f.target).includes(Buffer.from(DELETED_TEXT.zh))).toBe(false);
  const out = join(f.root, "out.db"); writeFileSync(out, main);
  const copy = new DatabaseSync(out, { readOnly: true }); databases.push(copy);
  expect(ftsSettled(copy)).toBe("settled");
  expect(ftsBlocksHold(copy, DELETED_TEXT.zh)).toBe(false);
  expect(keptRows(copy, "kept")).toBe(400);
  expect(String(copy.prepare("PRAGMA quick_check").get()?.quick_check)).toBe("ok");
  const listed = manifest.files.find(entry => entry.path === "messages.db")!;
  expect(listed.bytes).toBe(main.length);
});

it("T10a: with no -wal on disk the settled main file is exported and the -wal stays in missing only", async () => {
  const f = fixture();
  const db = liveDatabase(f.data);
  db.close(); databases.splice(databases.indexOf(db), 1); // the last close folds and removes the -wal and -shm
  const result = await writeInstallationDamagedExport(f.data, f.target);
  expectSingleList(result.manifest);
  expect(result.manifest.missing).toEqual(expect.arrayContaining(["messages.db-wal", "messages.db-shm"]));
  expect(result.manifest.files.some(entry => entry.path === "messages.db")).toBe(true);
  expect(readFileSync(f.target).includes(Buffer.from(DELETED_TEXT.zh))).toBe(false);
});

it("T10b: a corrupt page plus a non-empty WAL is settled or withheld, never exported raw", async () => {
  const f = fixture();
  const db = liveDatabase(f.data);
  const rawMain = readFileSync(join(f.data, "messages.db"));
  const pageSize = Number(db.prepare("PRAGMA page_size").get()?.page_size);
  // overwrite one interior page of the main file (not page 1) with garbage while its -wal is non-empty
  const page = Math.floor(rawMain.length / pageSize / 2);
  const fd = openSync(join(f.data, "messages.db"), "r+");
  try { writeSync(fd, Buffer.alloc(pageSize, 0xa5), 0, pageSize, page * pageSize); } finally { closeSync(fd); }
  const corrupted = readFileSync(join(f.data, "messages.db"));
  const rawWal = readFileSync(join(f.data, "messages.db-wal"));
  expect(rawWal.length).toBeGreaterThan(0);
  const result = await writeInstallationDamagedExport(f.data, f.target);
  expectSingleList(result.manifest);
  const entries = await readZip(f.target);
  const main = entries.get("preservation/messages.db");
  if (main) {
    expect(main.equals(corrupted)).toBe(false);
    expect(main.includes(Buffer.from(DELETED_TEXT.zh))).toBe(false);
    const out = join(f.root, "out.db"); writeFileSync(out, main);
    const copy = new DatabaseSync(out, { readOnly: true }); databases.push(copy);
    expect(ftsSettled(copy)).toBe("settled");
  } else expectWithheld(result.manifest);
  expect(entries.has("preservation/messages.db-wal")).toBe(false);
  expect(readFileSync(f.target).includes(rawWal.subarray(0, 32))).toBe(false);
});

it("T10c: a database that will not open: all three names omitted with the exact sentence, nothing raw in the zip", async () => {
  const f = fixture();
  const put = (path: string, bytes: Buffer) => { mkdirSync(dirname(join(f.data, path)), { recursive: true }); writeFileSync(join(f.data, path), bytes); };
  put("messages.db", Buffer.from([0, 255, 1, 2, 3]));
  put("messages.db-wal", Buffer.from([8, 7, 6]));
  const result = await writeInstallationDamagedExport(f.data, f.target);
  expectWithheld(result.manifest);
  const entries = await readZip(f.target);
  expect([...entries.keys()].filter(name => name.startsWith("preservation/messages.db"))).toEqual([]);
  expect(DAMAGED_EXPORT_DATABASE_WITHHELD).toBe("This export does not include your conversations database, because Murage could not prove that deleted conversations are gone from it. The database is still in the data folder on this computer.");
});

it("T10c: a stale scratch folder a killed earlier export left in the parent is removed", async () => {
  const f = fixture();
  liveDatabase(f.data);
  const stale = join(f.root, ".murage-damaged-export-Zz09Yy");
  mkdirSync(join(stale, "preservation"), { recursive: true });
  writeFileSync(join(stale, "preservation", "messages.db"), DELETED_TEXT.zh);
  // its owner record names a process that is gone (no pid is this large on any system)
  const { hostname } = await import("node:os");
  const { SCRATCH_OWNER_FILE } = await import("./settle-copy.ts");
  writeFileSync(join(stale, SCRATCH_OWNER_FILE), JSON.stringify({ pid: 2_147_483_646, host: hostname(), at: 0 }));
  await writeInstallationDamagedExport(f.data, f.target);
  const { readdirSync } = await import("node:fs");
  expect(readdirSync(f.root).filter(name => name.startsWith(".murage-"))).toEqual([]);
});

it("R6.2: a short disk at the settle: the export completes, all three names withheld with the approved sentence, no scratch left, one owner log line", async () => {
  const f = fixture();
  liveDatabase(f.data);
  settleCopyIo.freeBytes = () => 1024;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const result = await writeInstallationDamagedExport(f.data, f.target);
  expectWithheld(result.manifest);
  const entries = await readZip(f.target);
  expect([...entries.keys()].filter(name => name.startsWith("preservation/messages.db"))).toEqual([]);
  expect(readFileSync(f.target).includes(Buffer.from(DELETED_TEXT.zh))).toBe(false);
  const { readdirSync } = await import("node:fs");
  expect(readdirSync(f.root).filter(name => name.startsWith(".murage-"))).toEqual([]);
  expect(warn.mock.calls.filter(call => String(call[0]) === `[damaged-export] ${DAMAGED_EXPORT_SHORT_DISK_LOG}`)).toHaveLength(1);
  expect(DAMAGED_EXPORT_SHORT_DISK_LOG).toBe("Murage left your conversations database out of this export because the disk does not have enough free space to clean it first. Free some disk space and export again to include it.");
});
