// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMINDEX-BUSY-109. A healthy memory index is never set aside because another connection held a lock or was running WAL recovery while
// the helper checked it; a damaged one still is, and the set-aside copy (with its log files) is removed once the new index is open, so the
// words of deleted conversations do not outlive the deletion in it. Copies an earlier build left are removed at the next start. Nothing
// outside the index's own directory, and no other quarantine, is touched. Fixtures in throwaway temp directories only.
import { chmodSync, copyFileSync, renameSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { closeMemoryIndexReader, indexScrubOwed } from "./index-reader.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import { MemoryIndex } from "./index.ts";
import { indexDamaged, IndexDamagedError, indexFilesRegular, prepareIndexOpen, quarantineIndex, removeIndexQuarantines } from "./index-quarantine.ts";

const MARKER = "quarantinedorchidwords";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
function fresh(): { root: string; data: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "memindex-busy-")); roots.push(root);
  const data = join(root, "data"); mkdirSync(data);
  return { root, data, path: join(data, "memory-index.db") };
}
const row = (id: string, text: string) => ({ id, version: 1, scopeId: "scope", text, deleted: false });
function seed(path: string, text = MARKER): void { const index = new MemoryIndex(path); try { index.upsert([row("kept", text)]); } finally { index.close(); } }
const quarantines = (dir: string) => readdirSync(dir).filter(name => name.includes(".corrupt-"));
const holding = (dir: string) => readdirSync(dir).filter(name => { const file = join(dir, name); return statSync(file).isFile() && readFileSync(file).includes(Buffer.from(MARKER)); });
const finds = (index: MemoryIndex, text: string) => index.search(text, [{ id: "kept", version: 1 }], null, "unused").hits.map(hit => hit.id);

/** Another connection takes the file's exclusive lock (as a writer or WAL recovery does) and keeps it until told, or for `releaseAfterMs`. */
async function holdLock(path: string, releaseAfterMs?: number): Promise<{ release: () => Promise<void> }> {
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(workerData.path);
    db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; SELECT count(*) FROM sqlite_schema; COMMIT;");
    const done = () => { db.close(); parentPort.postMessage("released"); parentPort.close(); };
    parentPort.on("message", done);
    if (typeof workerData.releaseAfterMs === "number") setTimeout(done, workerData.releaseAfterMs);
    parentPort.postMessage("locked");`, { eval: true, workerData: { path, releaseAfterMs } });
  const exited = new Promise<void>(resolve => worker.once("exit", () => resolve()));
  await new Promise<void>((resolve, reject) => { worker.once("message", () => resolve()); worker.once("error", reject); });
  return { release: async () => { worker.postMessage("release"); await exited; } };
}

it("classifies only SQLITE_CORRUPT, SQLITE_NOTADB and a failed check as damage; busy, locked and recovery are not", () => {
  const sqlite = (errcode: number) => Object.assign(new Error("sqlite"), { errcode });
  expect(indexDamaged(new IndexDamagedError("*** in database main ***"))).toBe(true);
  for (const code of [11, 26, 267]) expect(indexDamaged(sqlite(code)), String(code)).toBe(true);
  // SQLITE_BUSY, SQLITE_BUSY_RECOVERY (261, "database is locked" while another connection recovers the WAL), SQLITE_BUSY_SNAPSHOT,
  // SQLITE_LOCKED, SQLITE_IOERR, SQLITE_NOMEM, SQLITE_CANTOPEN, and anything that is not a SQLite error
  for (const code of [5, 261, 517, 6, 262, 10, 7, 14]) expect(indexDamaged(sqlite(code)), String(code)).toBe(false);
  expect(indexDamaged(new Error("database is locked"))).toBe(false);
  expect(indexDamaged(null)).toBe(false);
});

it("waits out another connection's lock during the check and opens the same index, set aside nothing", async () => {
  const { data, path } = fresh();
  seed(path);
  const lock = await holdLock(path, 400);
  const started = Date.now();
  const index = new MemoryIndex(path);
  try {
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(index.rebuilt).toBe(false);
    expect(finds(index, MARKER)).toEqual(["kept"]);
    expect(quarantines(data)).toEqual([]);
  } finally { index.close(); await lock.release().catch(() => {}); }
});

it("a lock held past the wait fails the open (the helper's start is retried) and never sets the healthy index aside", async () => {
  const { data, path } = fresh();
  seed(path);
  const lock = await holdLock(path);
  try {
    let thrown: unknown = null;
    try { new MemoryIndex(path).close(); } catch (error) { thrown = error; }
    expect((thrown as { errcode?: number } | null)?.errcode, String(thrown)).toBeTypeOf("number");
    expect(((thrown as { errcode: number }).errcode & 0xff)).toBe(5);
    expect(quarantines(data)).toEqual([]);
    expect(existsSync(path)).toBe(true);
  } finally { await lock.release(); }
  const index = new MemoryIndex(path);
  try { expect(index.rebuilt).toBe(false); expect(finds(index, MARKER)).toEqual(["kept"]); } finally { index.close(); }
}, 30_000);

it("a file that is not a database is set aside, rebuilt empty, and the set-aside copy and its log are removed", () => {
  const { data, path } = fresh();
  writeFileSync(path, Buffer.concat([Buffer.from("not a sqlite file at all "), Buffer.from(MARKER), Buffer.alloc(8192, 7)]));
  writeFileSync(`${path}-wal`, Buffer.concat([Buffer.from("stale log "), Buffer.from(MARKER)]));
  writeFileSync(`${path}-shm`, Buffer.alloc(32768, 1));
  const index = new MemoryIndex(path);
  try {
    expect(index.rebuilt).toBe(true);
    expect(finds(index, MARKER)).toEqual([]);
    expect(quarantines(data)).toEqual([]);
    expect(holding(data)).toEqual([]);
  } finally { index.close(); }
});

it("an index whose pages are damaged is set aside and rebuilt, and no copy of its words is left in the directory", () => {
  const { data, path } = fresh();
  const index0 = new MemoryIndex(path);
  try { index0.upsert(Array.from({ length: 400 }, (_, n) => row(`r${n}`, `${MARKER} filler${n} ${"x".repeat(200)}`))); index0.checkpointNow(); } finally { index0.close(); }
  expect(existsSync(`${path}-wal`) && statSync(`${path}-wal`).size > 0).toBe(false);
  const bytes = readFileSync(path), page = bytes.readUInt16BE(16) || 65536;
  // overwrite every page after the schema page with noise, keeping the header valid so the file still opens as SQLite
  for (let at = page; at < bytes.length; at++) bytes[at] = (at * 31) & 0xff;
  for (let at = page * 2; at < bytes.length; at += page * 3) bytes.write(MARKER, at + 64);
  writeFileSync(path, bytes);
  const index = new MemoryIndex(path);
  try {
    expect(index.rebuilt).toBe(true);
    expect(quarantines(data)).toEqual([]);
    expect(holding(data)).toEqual([]);
  } finally { index.close(); }
});

it("a set-aside copy an earlier build left behind is removed at the next start of a healthy index", () => {
  const { data, path } = fresh();
  seed(path, "currentwords");
  for (const name of ["memory-index.db.corrupt-1790000000000", "memory-index.db.corrupt-1790000000000-wal", "memory-index.db.corrupt-1790000000000-shm", "memory-index.db.corrupt-1700000000001"])
    writeFileSync(join(data, name), Buffer.from(`old copy ${MARKER}`));
  const index = new MemoryIndex(path);
  try {
    expect(index.rebuilt).toBe(false);
    expect(finds(index, "currentwords")).toEqual(["kept"]);
    expect(quarantines(data)).toEqual([]);
    expect(holding(data)).toEqual([]);
  } finally { index.close(); }
});

it("touches nothing outside the index's directory, nothing nested, no other quarantine, no link and no look-alike name", () => {
  const { root, data, path } = fresh();
  seed(path, "currentwords");
  const outside = join(root, "memory-index.db.corrupt-1790000000000"), nested = join(data, "sub", "memory-index.db.corrupt-1790000000001");
  mkdirSync(join(data, "sub"));
  writeFileSync(outside, MARKER); writeFileSync(nested, MARKER);
  const kept = ["messages.db.corrupt-1790000000002", "messages.db.corrupt-1790000000002-wal", "memory-index.db.corrupt-abc", "memory-index.db.corrupt-1790000000003.bak",
    "xmemory-index.db.corrupt-1790000000004", "memory-index.db.corrupt-", "coordination-roots.json.invalid-1790000000005"];
  for (const name of kept) writeFileSync(join(data, name), MARKER);
  mkdirSync(join(data, "memory-index.db.corrupt-1790000000006"));
  writeFileSync(join(data, "memory-index.db.corrupt-1790000000006", "inside"), MARKER);
  let linked = false;
  try { symlinkSync(outside, join(data, "memory-index.db.corrupt-1790000000007")); linked = true; } catch { /* no symlink permission (Windows) */ }
  const index = new MemoryIndex(path);
  try {
    expect(index.rebuilt).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe(MARKER);
    expect(readFileSync(nested, "utf8")).toBe(MARKER);
    for (const name of kept) expect(existsSync(join(data, name)), name).toBe(true);
    expect(readFileSync(join(data, "memory-index.db.corrupt-1790000000006", "inside"), "utf8")).toBe(MARKER);
    if (linked) expect(readdirSync(data)).toContain("memory-index.db.corrupt-1790000000007");
  } finally { index.close(); }
  // the sweep reads only the directory it is given an index path in, by that index's own file name
  expect(removeIndexQuarantines(join(data, "other.db"))).toEqual({ removed: [], left: [] });
  expect(existsSync(outside)).toBe(true);
});

it("a set-aside copy that cannot be removed now is reported as left, and removed on a later try", () => {
  const { data, path } = fresh();
  writeFileSync(join(data, "memory-index.db.corrupt-1790000000000"), MARKER);
  chmodSync(data, 0o555);
  let first: ReturnType<typeof removeIndexQuarantines>;
  try { first = removeIndexQuarantines(path); } finally { chmodSync(data, 0o755); }
  // root (or Windows) can unlink in a read-only directory: then the first try already removes it
  if (first.removed.length === 0) expect(first.left).toEqual(["memory-index.db.corrupt-1790000000000"]);
  expect(removeIndexQuarantines(path).left).toEqual([]);
  expect(quarantines(data)).toEqual([]);
  expect(removeIndexQuarantines(join(data, "missing", "memory-index.db"))).toEqual({ removed: [], left: [] });
});

it.each(["off", "capture"] as const)("with memory %s and nothing owed (no helper starts), the controller removes an old set-aside copy at start", async mode => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode(mode);
  const names = ["memory-index.db.corrupt-1790000000000", "memory-index.db.corrupt-1790000000000-wal", "memory-index.db.corrupt-1790000000000-shm"];
  for (const name of names) writeFileSync(join(DATA_DIR, name), MARKER);
  writeFileSync(join(DATA_DIR, "messages.db.corrupt-1790000000001"), MARKER);
  const controller = new MemoryWorkerController({ modelDirectory: join(DATA_DIR, "no-model") });
  try {
    controller.start();
    await vi.waitFor(() => expect(quarantines(DATA_DIR)).toEqual(["messages.db.corrupt-1790000000001"]), { timeout: 20_000, interval: 25 });
    expect((controller as unknown as { child: unknown }).child).toBeNull();
  } finally { await controller.stop().catch(() => {}); closeMemoryIndexReader(); closeDatabase(); }
}, 30_000);

/** A real write-ahead log holding MARKER: copied from a live index while its writes are still in the log (not yet checkpointed). */
function realWal(): Buffer {
  const { path } = fresh();
  const index = new MemoryIndex(path);
  try {
    index.upsert([row("kept", MARKER)]);
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
    return readFileSync(`${path}-wal`);
  } finally { index.close(); }
}
const unsafe = (make: () => unknown) => { try { make(); } catch (error) { return String((error as Error).message); } return "no error"; };

it("a log-file rename that fails moves the whole set back (a real WAL stays with its index file) and throws", () => {
  const { data, path } = fresh();
  seed(path, "currentwords");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA wal_autocheckpoint=0");
  db.exec(`CREATE TABLE walrow(text TEXT); INSERT INTO walrow VALUES('${MARKER}')`);
  const live = join(data, "live-copy");
  mkdirSync(live);
  copyFileSync(path, join(live, "memory-index.db")); copyFileSync(`${path}-wal`, join(live, "memory-index.db-wal"));
  db.close();
  const copy = join(live, "memory-index.db"), wal = readFileSync(`${copy}-wal`);
  expect(wal.length).toBeGreaterThan(0);
  mkdirSync(`${copy}.corrupt-123-wal`); // the log's set-aside name is taken: its rename fails after the index file's succeeded
  expect(() => quarantineIndex(copy, 123)).toThrow();
  expect(existsSync(copy)).toBe(true);
  expect(readFileSync(`${copy}-wal`).equals(wal)).toBe(true);
  expect(existsSync(`${copy}.corrupt-123`)).toBe(false);
  // the set is whole again: the index opens with the row its log held
  const index = new MemoryIndex(copy);
  try { expect(index.rebuilt).toBe(false); expect(finds(index, "currentwords")).toEqual(["kept"]); } finally { index.close(); }
  const check = new DatabaseSync(copy);
  try { expect(check.prepare("SELECT text FROM walrow").get()?.text).toBe(MARKER); } finally { check.close(); }
});

it("with no index file, a real WAL left at the live name is removed before the fresh index opens, so none of its words come back", () => {
  const { data, path } = fresh();
  writeFileSync(`${path}-wal`, realWal());
  writeFileSync(`${path}-shm`, Buffer.alloc(32768, 0));
  const index = new MemoryIndex(path);
  try {
    expect(index.rebuilt).toBe(true);
    expect(finds(index, MARKER)).toEqual([]);
    expect(holding(data)).toEqual([]);
  } finally { index.close(); }
});

it("with no index file, a log that cannot be removed fails the start and no fresh index is opened beside it", () => {
  const { data, path } = fresh();
  writeFileSync(`${path}-wal`, realWal());
  chmodSync(data, 0o555);
  let message: string;
  try { message = unsafe(() => new MemoryIndex(path).close()); } finally { chmodSync(data, 0o755); }
  // root (or Windows) can unlink in a read-only directory: then the log is removed and the fresh index opens
  if (message === "no error") { expect(holding(data)).toEqual([]); return; }
  expect(existsSync(path)).toBe(false);
  expect(existsSync(`${path}-wal`)).toBe(true);
});

it("a log file that is a link is refused (UNSAFE_MEMORY_INDEX), with or without the index file, and its target is untouched", () => {
  const { root, path } = fresh();
  const target = join(root, "elsewhere");
  writeFileSync(target, MARKER);
  try { symlinkSync(target, `${path}-wal`); } catch { return; /* no symlink permission (Windows) */ }
  expect(unsafe(() => new MemoryIndex(path).close())).toBe("UNSAFE_MEMORY_INDEX");
  expect(existsSync(path)).toBe(false);
  unlinkSync(`${path}-wal`);
  seed(path, "currentwords");
  symlinkSync(target, `${path}-shm`);
  expect(unsafe(() => new MemoryIndex(path).close())).toBe("UNSAFE_MEMORY_INDEX");
  expect(readlinkSync(`${path}-shm`)).toBe(target);
  expect(readFileSync(target, "utf8")).toBe(MARKER);
  // setting a damaged index aside refuses a linked log too, and leaves the index file where it was
  expect(unsafe(() => quarantineIndex(path, 456))).toBe("UNSAFE_MEMORY_INDEX");
  expect(existsSync(path)).toBe(true);
  expect(existsSync(`${path}.corrupt-456`)).toBe(false);
});

it.skipIf(process.platform !== "linux")("a start that throws after the open leaves no connection on the file", () => {
  const { path } = fresh();
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE index_meta(x)"); // passes the check; the first read of index_meta then fails
  db.close();
  const open = () => readdirSync("/proc/self/fd").filter(fd => { try { return readlinkSync(`/proc/self/fd/${fd}`).startsWith(path); } catch { return false; } });
  expect(open()).toEqual([]);
  expect(unsafe(() => new MemoryIndex(path).close())).not.toBe("no error");
  expect(open()).toEqual([]);
});

it("past the check the handle waits for no lock (busy_timeout 0)", () => {
  const { path } = fresh();
  const index = new MemoryIndex(path);
  try { expect(Object.values((index as unknown as { db: DatabaseSync }).db.prepare("PRAGMA busy_timeout").get() ?? {})).toEqual([0]); } finally { index.close(); }
});

/** An index whose last writes (MARKER among them) are still only in its real log, with a -shm beside it. */
function indexWithLiveWal(): { data: string; copy: string } {
  const { data, path } = fresh();
  seed(path, "currentwords");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA wal_autocheckpoint=0");
  db.exec(`CREATE TABLE walrow(text TEXT); INSERT INTO walrow VALUES('${MARKER}')`);
  const live = join(data, "live");
  mkdirSync(live);
  const copy = join(live, "memory-index.db");
  copyFileSync(path, copy); copyFileSync(`${path}-wal`, `${copy}-wal`);
  db.close();
  writeFileSync(`${copy}-shm`, Buffer.alloc(32768, 0));
  return { data: live, copy };
}

it("when a log cannot be put back after a failed set-aside, the index file stays aside and the next start rebuilds without the old words", () => {
  const { data, copy } = indexWithLiveWal();
  expect(readFileSync(`${copy}-wal`).includes(Buffer.from(MARKER))).toBe(true);
  // forward: the index file and its -wal move, the -shm fails; back: the -wal fails
  const rename = (from: string, to: string) => {
    if (from === `${copy}-shm` || from === `${copy}.corrupt-789-wal`) throw Object.assign(new Error("EBUSY: held open"), { code: "EBUSY" });
    renameSync(from, to);
  };
  expect(() => quarantineIndex(copy, 789, rename)).toThrow("EBUSY");
  expect(existsSync(copy)).toBe(false);               // not restored without its log
  expect(existsSync(`${copy}.corrupt-789`)).toBe(true);
  const index = new MemoryIndex(copy);
  try {
    expect(index.rebuilt).toBe(true);
    expect(finds(index, "currentwords")).toEqual([]);
    expect(holding(data)).toEqual([]);
    expect(quarantines(data)).toEqual([]);
  } finally { index.close(); }
});

it("with no index file, a log whose removal fails stops the start before any open (directory writable)", () => {
  const { path } = fresh();
  writeFileSync(`${path}-wal`, realWal());
  const refuse = () => { throw Object.assign(new Error("EBUSY: held open"), { code: "EBUSY" }); };
  expect(() => prepareIndexOpen(path, refuse)).toThrow("EBUSY");
  expect(existsSync(`${path}-wal`)).toBe(true);
  expect(existsSync(path)).toBe(false);
  // ENOENT (removed by someone else meanwhile) is not a failure
  expect(() => prepareIndexOpen(path, () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); })).not.toThrow();
});

it("an index path that is a link, dangling or not, is refused before the open and nothing is created at its target", () => {
  const { root, path } = fresh();
  const target = join(root, "outside.db");
  try { symlinkSync(target, path); } catch { return; /* no symlink permission (Windows) */ }
  expect(unsafe(() => new MemoryIndex(path).close())).toBe("UNSAFE_MEMORY_INDEX");
  expect(existsSync(target)).toBe(false);
  expect(indexFilesRegular(path)).toBe(false);
});

it("read-only connections refuse a linked log too: the controller's start-up read leaves the link's target untouched", () => {
  closeMemoryIndexReader(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  const path = join(DATA_DIR, "memory-index.db");
  seed(path);
  expect(indexFilesRegular(path)).toBe(true);
  const target = join(fresh().root, "outside-shm");
  writeFileSync(target, Buffer.alloc(64, 9));
  try {
    try { symlinkSync(target, `${path}-shm`); } catch { return; /* no symlink permission (Windows) */ }
    expect(indexFilesRegular(path)).toBe(false);
    expect(indexScrubOwed()).toBeNull(); // unknown: the helper starts, and its constructor refuses the link
    expect(readFileSync(target).equals(Buffer.alloc(64, 9))).toBe(true);
  } finally { closeMemoryIndexReader(); }
});

it("a set-aside copy that cannot be looked at now is reported as left, not taken as gone, and removed once it can be", () => {
  const { data, path } = fresh();
  writeFileSync(join(data, "memory-index.db.corrupt-1790000000000"), MARKER);
  chmodSync(data, 0o444); // the names can be listed but not looked at (no search permission)
  let first: ReturnType<typeof removeIndexQuarantines>;
  try { first = removeIndexQuarantines(path); } finally { chmodSync(data, 0o755); }
  // root (or Windows) can look anyway: then the first try already removes it
  if (first.removed.length === 0) expect(first.left).toEqual(["memory-index.db.corrupt-1790000000000"]);
  expect(removeIndexQuarantines(path)).toEqual({ removed: first.removed.length ? [] : ["memory-index.db.corrupt-1790000000000"], left: [] });
  expect(quarantines(data)).toEqual([]);
});
