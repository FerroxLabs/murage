// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WIN-IOB-QUICK (design note rev 3, design WIN-IOB-QUICK-READER-LIFETIME.md): the WAL-frame reader belongs to the
// MemoryIndex handle it reads: opened after that handle, closed after its db.close(), never by code that does not own the handle.
// Tests 1-6 are red on 021910b1a; test 7 (the existing io suites) is regression only. Real MemoryIndex and MemoryEligibility, no stubs.
// Descriptor checks read /proc/self/fd (Linux); the worker harness mirrors worker-io.test.ts.
import { expect, it, vi } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDirSync } from "../testing/cleanup.ts";

const opened = vi.hoisted(() => ({ shm: [] as string[], events: [] as string[] }));
vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  const mocked = { ...real, openSync: (...args: Parameters<typeof real.openSync>) => { const fd = real.openSync(...args); if (String(args[0]).endsWith("-shm")) { opened.shm.push(String(args[0])); opened.events.push("open-shm"); } return fd; }, renameSync: (...args: Parameters<typeof real.renameSync>) => { const result = real.renameSync(...args); if (String(args[0]).endsWith("-shm") && String(args[1]).includes(".corrupt-")) opened.events.push("set-aside-shm"); return result; } };
  return { ...mocked, default: mocked };
});
vi.mock("./embeddings.ts", () => ({ MemoryEmbeddings: class { identity = "fixture"; backend = "native"; embed(texts: string[]) { return Promise.resolve(texts.map(() => [1])); } } }));

const linux = process.platform === "linux";
const shmFds = (suffix: string) => readdirSync("/proc/self/fd").map(fd => { try { return readlinkSync(`/proc/self/fd/${fd}`); } catch { return ""; } }).filter(link => link.includes(suffix));
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

async function initWorker(indexPath: string, authorityPath: string, check: (sent: Array<Record<string, unknown>>) => void) {
  vi.resetModules();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
    const timer = realSetTimeout(...args); timers.push(timer); return timer;
  }) as typeof setTimeout);
  const realProcess = process, listeners = new Map<string, (message: unknown) => void>(), sent: Array<Record<string, unknown>> = [];
  const workerProcess = Object.create(realProcess) as NodeJS.Process;
  Object.defineProperties(workerProcess, {
    on: { value: (event: string, listener: (message: unknown) => void) => { if (event === "message" || event === "disconnect" || event === "error") { listeners.set(event, listener); return workerProcess; } return realProcess.on(event, listener); } },
    send: { value: (message: Record<string, unknown>) => { sent.push(message); return true; } },
    exit: { value: vi.fn() },
  });
  vi.stubGlobal("process", workerProcess);
  try {
    await import("./worker.ts");
    listeners.get("message")!({ type: "init", indexPath, authorityPath, modelDirectory: "/unused/model", manifest: { model: "fixture", revision: "1", dimensions: 1, files: [] } });
    await settle();
    check(sent);
  } finally {
    try { listeners.get("disconnect")?.(undefined); }
    finally { timers.forEach(clearTimeout); timeoutSpy.mockRestore(); vi.unstubAllGlobals(); vi.resetModules(); }
  }
}

function expectAuthorityLocked(path: string) {
  const probe = spawnSync(process.execPath, ["-e", `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA busy_timeout=50');
    try { db.exec('BEGIN EXCLUSIVE; UPDATE memory_meta SET data_revision=data_revision+1; ROLLBACK'); process.stdout.write('acquired'); }
    catch (error) { if (!/busy|locked/i.test(error.message)) throw error; process.stdout.write('excluded'); }
    finally { db.close(); }
  `, path], { windowsHide: true, encoding: "utf8", timeout: 5000 });
  expect(probe.error).toBeUndefined();
  expect(probe.status, probe.stderr).toBe(0);
  expect(probe.stdout).toBe("excluded");
}

function authority(dir: string) {
  const path = join(dir, "authority.db"), db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE memory_meta(id INTEGER PRIMARY KEY, policy_revision INTEGER, deletion_epoch INTEGER, data_revision INTEGER); INSERT INTO memory_meta VALUES(1,1,1,1); CREATE TABLE memory_records(scope_id TEXT, id TEXT, version INTEGER, state TEXT)");
  return { path, db };
}

it("1. WORKER INIT with <index>-shm linked to the authority shm: no descriptor is opened on that path (so none is closed under the eligibility lock)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "win-iob-lt1-"));
  const auth = authority(dir);
  try {
    const index = join(dir, "memory-index.db");
    writeFileSync(index, "");
    symlinkSync(`${auth.path}-shm`, `${index}-shm`);
    auth.db.exec("BEGIN IMMEDIATE; UPDATE memory_meta SET data_revision=data_revision+1");
    expectAuthorityLocked(auth.path);
    opened.shm.length = 0;
    await initWorker(index, auth.path, sent => {
      expect(sent.some(message => message.type === "error")).toBe(true);
      expect(sent.some(message => message.type === "initialised")).toBe(false);
      expectAuthorityLocked(auth.path);
      expect(opened.shm.filter(path => path.endsWith("memory-index.db-shm"))).toEqual([]);
      if (linux) expect(shmFds("authority.db-shm").length).toBeGreaterThan(0);
    });
  } finally { auth.db.close(); removeTempDirSync(dir); }
});

it.runIf(linux)("2. WORKER INIT on a damaged index: no descriptor stays on the set-aside (deleted) shm", async () => {
  const dir = mkdtempSync(join(tmpdir(), "win-iob-lt2-"));
  const auth = authority(dir);
  try {
    const index = join(dir, "memory-index.db");
    writeFileSync(index, Buffer.alloc(8192, 7));
    writeFileSync(`${index}-shm`, Buffer.alloc(32768));
    opened.events.length = 0;
    await initWorker(index, auth.path, sent => {
      expect(sent.some(message => message.type === "initialised")).toBe(true);
      // Base opens the OLD shm before quarantine; the replacement must open only after the rename.
      expect(opened.events).toContain("set-aside-shm");
      expect(opened.events.slice(0, opened.events.indexOf("set-aside-shm")).filter(e => e === "open-shm")).toEqual([]);
      expect(opened.events.slice(opened.events.indexOf("set-aside-shm") + 1)).toContain("open-shm");
      expect(shmFds("memory-index.db.corrupt-").filter(link => link.includes("-shm"))).toEqual([]);
    });
  } finally { auth.db.close(); removeTempDirSync(dir); }
});

it("3. constructor accounting: a fresh index reports ioBytes covering its schema frames", async () => {
  const dir = mkdtempSync(join(tmpdir(), "win-iob-lt3-"));
  try {
    const { MemoryIndex } = await import("./index.ts");
    const index = new MemoryIndex(join(dir, "memory-index.db"));
    try { expect(index.ioBytes?.() ?? 0).toBeGreaterThan(4096); } finally { index.close(); }
  } finally { removeTempDirSync(dir); }
});

it("4. every TRUNCATE checkpoint is preceded by a log sample; frames written across three rewrites are all counted", async () => {
  const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8").split("\n");
  const sites = source.map((line, i) => ({ line, i })).filter(({ line }) => /checkpointTruncate\(this\.db|checkpointTruncate\(db|wal_checkpoint\(TRUNCATE\)/.test(line) && !/^\s*(export |\/\/)/.test(line));
  expect(sites.length).toBeGreaterThanOrEqual(5);
  for (const { i, line } of sites) expect(`${source[i - 1]}\n${line}`, `line ${i + 1}`).toMatch(/sampleLog\(\);/);
  const dir = mkdtempSync(join(tmpdir(), "win-iob-lt4-"));
  try {
    const { MemoryIndex } = await import("./index.ts");
    const index = new MemoryIndex(join(dir, "memory-index.db"));
    try {
      const marks: number[] = [];
      for (let i = 0; i < 3; i++) {
        index.upsert([{ id: `r${i}`, version: 1, scopeId: "s", text: "word ".repeat(400), deleted: false }] as never);
        index.checkpointNow(); marks.push(index.ioBytes());
      }
      expect(marks[1]).toBeGreaterThan(marks[0]); expect(marks[2]).toBeGreaterThan(marks[1]);
    } finally { index.close(); }
  } finally { removeTempDirSync(dir); }
});

it.runIf(linux)("5. close order: failed db close retains the reader for retry; constructor failure releases every descriptor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "win-iob-lt5-"));
  try {
    const { MemoryIndex } = await import("./index.ts");
    const path = join(dir, "memory-index.db");
    const index = new MemoryIndex(path);
    try {
      index.upsert([{ id: "r", version: 1, scopeId: "s", text: "word", deleted: false }] as never);
      expect(shmFds(`${path}-shm`).length).toBeGreaterThanOrEqual(2); // base fails here: no owned reader
      const owned = index as unknown as { db: DatabaseSync; wal: { close(): void; fd(): number | undefined } };
      const events: string[] = [], closeError = new Error("fixture close failure");
      const realDbClose = owned.db.close.bind(owned.db), realReaderClose = owned.wal.close.bind(owned.wal);
      const readerFd = owned.wal.fd();
      expect(readerFd).toBeDefined();
      const dbClose = vi.spyOn(owned.db, "close").mockImplementationOnce(() => { events.push("db-throw"); throw closeError; })
        .mockImplementation(() => { realDbClose(); events.push("db-closed"); });
      const readerClose = vi.spyOn(owned.wal, "close").mockImplementation(() => { realReaderClose(); events.push("reader-closed"); });
      try {
        expect(() => index.close()).toThrow(closeError);
        expect(readerClose).not.toHaveBeenCalled();
        expect(owned.wal.fd()).toBe(readerFd);
        expect(readlinkSync(`/proc/self/fd/${readerFd}`)).toBe(`${path}-shm`);
        index.close(); index.close();
        expect(events).toEqual(["db-throw", "db-closed", "reader-closed"]);
        expect(dbClose).toHaveBeenCalledTimes(2);
        expect(readerClose).toHaveBeenCalledTimes(1);
      } finally { dbClose.mockRestore(); readerClose.mockRestore(); }
    } finally { index.close(); }
    expect(shmFds(path)).toEqual([]);

    // Throw after schema writes and the first sample has opened the reader's fd.
    // The reader exists and all three kinds of descriptor must be live here.
    const failure = new Error("fixture after reader creation"), live: string[][] = [];
    const prepare = DatabaseSync.prototype.prepare;
    const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.includes("key='delete_scrub_owed'")) { live.push(shmFds(path)); throw failure; }
      return prepare.call(this, sql);
    });
    try { expect(() => new MemoryIndex(path)).toThrow(failure); }
    finally { prepareSpy.mockRestore(); }
    expect(live).toHaveLength(1);
    for (const suffix of ["", "-wal", "-shm"]) expect(live[0]).toContain(path + suffix);
    expect(live[0].filter(link => link === `${path}-shm`).length).toBeGreaterThanOrEqual(2);
    expect(shmFds(path)).toEqual([]);
  } finally { removeTempDirSync(dir); }
});

it("6. snapshot scratch copy: the bytes noted equal the bytes written, and the -shm is not charged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "win-iob-lt6-"));
  try {
    const written = await import("../io-written.ts");
    const { withOfflineInstallation } = await import("../installation-database-snapshot.ts");
    const source = join(dir, "offline"); mkdirSync(source);
    const live = join(dir, "live.db"), path = join(source, "memory-index.db"), target = join(dir, "snapshot.db");
    const db = new DatabaseSync(live);
    try {
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE fixture(value); INSERT INTO fixture VALUES(randomblob(8192))");
      // Freeze a private offline fixture with committed WAL data; no live source handle.
      for (const suffix of ["", "-wal", "-shm"]) copyFileSync(live + suffix, path + suffix);
    } finally { db.close(); }
    const scratchBytes = statSync(path).size + statSync(`${path}-wal`).size;
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
    expect(statSync(`${path}-shm`).size).toBeGreaterThan(0);
    written.takeWrittenBytes();
    const charges: Array<Array<[string, number]>> = [], backupSizes: number[] = [];
    const noteFile = written.noteWrittenFile;
    const noteSpy = vi.spyOn(written, "noteWrittenFile").mockImplementation((name, file) => {
      charges.push(written.takeWrittenBytes()); // scratch copy completed before backup is charged
      backupSizes.push(statSync(file).size);
      noteFile(name, file);
    });
    try {
      // This public lease wrapper executes snapshotSqliteWhileOwned on both lane and base.
      const result = await withOfflineInstallation(source, installation => installation.snapshotMemoryIndex(target));
      expect(result.status).toBe("copied");
      expect(charges).toEqual([[["database-copy", scratchBytes]]]);
      expect(backupSizes).toEqual([statSync(target).size]);
      expect(written.takeWrittenBytes()).toEqual([["database-copy", statSync(target).size]]);
    } finally { noteSpy.mockRestore(); written.takeWrittenBytes(); }
  } finally { removeTempDirSync(dir); }
});
