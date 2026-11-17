// SPDX-License-Identifier: AGPL-3.0-or-later
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { endianness } from "node:os";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

import { checkpointLedger } from "./admission-shared.ts";

const source = readFileSync(new URL("./wal-maintenance.ts", import.meta.url), "utf8");
const program = source.match(/const WORKER_SOURCE = `([\s\S]*?)`;/)![1]!;
const little = endianness() === "LE";
const word = (b: Buffer, v: number, o: number) => little ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o);
function sum(b: Buffer, n: number) {
  let a = 0, c = 0;
  for (let o = 0; o < n; o += 8) {
    a = (a + (little ? b.readUInt32LE(o) : b.readUInt32BE(o)) + c) >>> 0;
    c = (c + (little ? b.readUInt32LE(o + 4) : b.readUInt32BE(o + 4)) + a) >>> 0;
  }
  return [a, c];
}
function walHeader(sequence = 2, salt1 = 7) {
  const b = Buffer.alloc(32);
  b.writeUInt32BE(little ? 0x377f0682 : 0x377f0683); b.writeUInt32BE(3007000, 4); b.writeUInt32BE(4096, 8);
  b.writeUInt32BE(sequence, 12); b.writeUInt32BE(salt1, 16); b.writeUInt32BE(9, 20);
  const [a, c] = sum(b, 24); b.writeUInt32BE(a!, 24); b.writeUInt32BE(c!, 28);
  return b;
}
function indexHeader(h: Buffer, frames = 3, backfill = frames) {
  const b = Buffer.alloc(100);
  word(b, 3007000, 0); b[12] = 1;
  little ? b.writeUInt16LE(4096, 14) : b.writeUInt16BE(4096, 14);
  word(b, frames, 16); h.copy(b, 32, 16, 24);
  const [a, c] = sum(b, 40); word(b, a!, 40); word(b, c!, 44);
  b.copy(b, 48, 0, 48); word(b, backfill, 96);
  return b;
}
function fixture() {
  let h = walHeader(), index = indexHeader(h), reads = 0, walReads = 0, changes = 0, opens = 0;
  let size = 32 + 3 * 4120, ino = 1, database = 1;
  let onCheck: (() => void) | undefined;
  let onIndex: (() => void) | undefined;
  const api = runInNewContext(program.slice(program.indexOf("const head ="), program.indexOf("let sampledSalt =")) + "\n({ header, indexHeader })", {
    Buffer, debtFd: -1, indexFd: 11, workerData: { file: "fixture.db" }, shared: new Int32Array(28), copied: new BigInt64Array(1),
    Date: { now: () => 0 }, openSync: () => { opens++; return 10; }, closeSync() {},
    statSync: (p: string) => ({ dev: 1, ino: p.endsWith("-wal") ? ino : database }),
    fstatSync: () => ({ size, dev: 1, ino, isFile: () => true }),
    readSync(fd: number, out: Buffer, offset: number, length: number, position: number) {
      if (fd === 11) { reads++; onIndex?.(); index.copy(out, offset); }
      else if (position === 0) {
        walReads++;
        if (out.length === 32 && walReads % 2 === 0) onCheck?.();
        h.copy(out, offset);
      } else { out.fill(0); h.copy(out, 8, 16, 24); }
      return length;
    },
  }) as { header(): { salt: string; index: { mxFrame: number } }; indexHeader(): { mxFrame: number } };
  return {
    api, reads: () => reads, walReads: () => walReads, opens: () => opens,
    invalid(kind: string) { index = indexHeader(h); if (kind === "copies") index[48] = index[48]! ^ 1; else if (kind === "init") { index[12] = 0; index[60] = 0; } else { index[40] = index[40]! ^ 1; index[88] = index[88]! ^ 1; } },
    onIndex(fn: () => void) { onIndex = fn; }, valid() { index = indexHeader(h); },
    corrupt() { h[24] = h[24]! ^ 1; },
    pinned() { index = indexHeader(h, 3, 1); },
    restart(kind = "benign") {
      onCheck = () => {
        changes++; onCheck = undefined;
        h = walHeader(kind === "sequence" ? 2 : 3, kind === "salt" ? 7 : 8);
        if (kind === "replaced") ino++;
        if (kind === "database") database++;
        if (kind === "truncated") size = 32;
        if (kind === "corrupt") h[24] = h[24]! ^ 1;
        index = indexHeader(h, 0);
        if (kind === "second") onCheck = () => { changes++; h = walHeader(4, 9); index = indexHeader(h, 0); onCheck = undefined; };
      };
    }, changes: () => changes,
  };
}

it.each(["copies", "init", "checksum"])("W-INDEX %s retries once then fails closed", kind => {
  const f = fixture(); f.invalid(kind);
  f.onIndex(() => { if (f.reads() === 3) f.valid(); }); // a forbidden third read would accept this repair
  expect(() => f.api.indexHeader()).toThrow("invalid WAL-index header");
  expect(f.reads()).toBe(2);
});
it.each(["copies", "init", "checksum"])("W-INDEX %s accepts the one immediate repaired re-read", kind => {
  const f = fixture(); f.invalid(kind);
  f.onIndex(() => { if (f.reads() === 2) f.valid(); });
  let result: { mxFrame: number } | undefined;
  try { result = f.api.indexHeader(); } catch { /* assert the repaired read below */ }
  expect(result?.mxFrame).toBe(3);
  expect(f.reads()).toBe(2);
});
it("W-RESTART a proven benign mismatch rereads exactly once", () => {
  const f = fixture(); f.api.header(); const reads = f.walReads(), opens = f.opens(); f.restart();
  let result: { index: { mxFrame: number } } | undefined;
  try { result = f.api.header(); } catch { /* assert the benign restart below */ }
  expect(result?.index.mxFrame).toBe(0);
  expect(f.walReads() - reads).toBe(4);
  expect(f.opens() - opens).toBe(1);
  expect(f.changes()).toBe(1);
});
it.each(["replaced", "truncated", "database", "corrupt", "sequence", "salt", "second"])("W-RESTART %s is refused after one re-read", kind => {
  const f = fixture(); f.api.header(); const reads = f.walReads(), opens = f.opens(); f.restart(kind);
  expect(() => f.api.header()).toThrow();
  expect(f.walReads() - reads).toBeLessThanOrEqual(4);
  expect(f.opens() - opens).toBe(1);
  if (kind === "second") expect(f.walReads() - reads).toBe(4);
  expect(f.changes()).toBe(kind === "second" ? 2 : 1);
});

function restartWork(invalid: boolean) {
  let h = walHeader(), index = indexHeader(h), frames = 3, dv = 1, now = 1000, passes = 0;
  let damaged = false, badReads = 0;
  let tick!: () => void;
  const shared = new Int32Array(new SharedArrayBuffer(28 * 4));
  const fs = {
    openSync: () => 10, closeSync() {}, statfsSync: () => ({ bavail: 1e9, bsize: 4096 }),
    statSync: () => ({ dev: 1, ino: 1 }), fstatSync: () => ({ dev: 1, ino: 1, size: 32 + frames * 4120, isFile: () => true }),
    readSync(fd: number, out: Buffer, offset: number, length: number, position: number) {
      if (fd === 11) {
        if (damaged && ++badReads === 3) { index = indexHeader(h, 0); damaged = false; }
        index.copy(out, offset);
      } else if (position === 0) h.copy(out, offset);
      else { out.fill(0); h.copy(out, 8, 16, 24); }
      return length;
    },
  };
  runInNewContext(program, {
    Buffer, performance, Date: { now: () => now },
    setInterval(fn: () => void) { const prior = tick; tick = prior ? () => { prior(); fn(); } : fn; return { unref() {} }; }, clearInterval() {},
    require(name: string) {
      if (name === "node:fs") return fs;
      if (name === "node:worker_threads") return {
        threadId: 1,
        workerData: { shared: shared.buffer, copied: new SharedArrayBuffer(8), file: "fixture.db", stepBytes: 4 * 1024 * 1024, pollMs: 25, dueMs: 250, debtBytes: 8 * 1024 * 1024, debtFd: { debt: -1, index: 11 }, admission: new SharedArrayBuffer(256), admissionSource: checkpointLedger.toString() },
        parentPort: { postMessage() {}, on() {} },
      };
      if (name === "node:sqlite") return { DatabaseSync: class {
        exec() {}
        prepare(sql: string) { return { all: () => {
          if (sql.includes("data_version")) return [{ data_version: dv }];
          if (sql.includes("wal_checkpoint")) { passes++; index = indexHeader(h, frames); return [{ busy: 0, log: frames, checkpointed: frames }]; }
          return [{ n: 1 }];
        } }; }
      } };
      throw Error(name);
    },
  });
  h = walHeader(3, 8); frames = 16384; dv++; index = indexHeader(h, 0);
  if (invalid) { damaged = true; index[40] = index[40]! ^ 1; index[88] = index[88]! ^ 1; }
  now += 25; tick();
  if (invalid) expect(badReads, "one immediate re-read before the poll takes the failure path").toBe(2);
  for (let i = 1; i < 20; i++) { now += 25; tick(); }
  if (invalid) {
    expect(shared[6], "invalid index arms the existing failed-read retry, never empty work").toBeGreaterThan(0);
    return;
  }
  expect(passes, "an uncommitted restart owes no pass").toBe(0);
  dv++; index = indexHeader(h, frames, 0); tick();
  expect(passes, "the real COMMIT remains owed").toBe(1);
  for (let i = 0; i < 20; i++) { now += 25; tick(); }
  expect(passes).toBe(1);
}
it("W-RESTART-WORK mxFrame zero stays idle for 500ms and COMMIT starts exactly one owed pass", () => restartWork(false));
it("W-INDEX invalid header takes the bounded re-read then the poll failure path", () => restartWork(true));

it("W-RESTART no full backfill cannot be called benign", () => {
  const f = fixture(); f.pinned(); f.api.header(); f.restart();
  expect(() => f.api.header()).toThrow("WAL generation changed");
});

it("W-INDEX-FD retains the shm descriptor and SQLite locks through identity-read failures", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "wal-index-")), file = join(dir, "fixture.db");
  const db = new DatabaseSync(file), held = new Set<number>();
  let failures = 0;
  const lifecycle = source.slice(source.indexOf("interface DebtFd"), source.indexOf("/** One PASSIVE checkpoint in the worker."));
  const api = runInNewContext(ts.transpile(lifecycle + "\n({ indexFdFor, closeDebtFd })"), {
    ...fs, performance, console: { warn() {} }, live: new Set(), FAILURE_LOG_GAP_MS: 600_000,
    openSync(...args: Parameters<typeof fs.openSync>) { const fd = fs.openSync(...args); held.add(fd); return fd; },
    closeSync(fd: number) { fs.closeSync(fd); held.delete(fd); },
    fstatSync(fd: number) {
      if (failures++ < 2) throw new Error("injected identity read failure");
      return fs.fstatSync(fd, { bigint: true });
    },
  }) as { indexFdFor(file: string): number; closeDebtFd(): void };
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE item(value); BEGIN IMMEDIATE; INSERT INTO item VALUES(1)");
    const fd = api.indexFdFor(file);
    expect(fd).toBeGreaterThanOrEqual(0);
    for (let restart = 0; restart < 3; restart++) {
      api.indexFdFor(file);
      let open = false;
      try { open = fs.fstatSync(fd).isFile(); } catch { /* assert before any other SQLite process opens */ }
      expect(open, "the current shm descriptor must remain open").toBe(true);
      expect([...held]).toEqual([fd]);
      const child = spawnSync(process.execPath, ["-e", `
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(process.argv[1]);
        db.exec('PRAGMA busy_timeout=0');
        try { db.exec('BEGIN IMMEDIATE; ROLLBACK'); console.log('unlocked'); }
        catch (error) { if (!/locked/.test(error.message)) throw error; console.log('locked'); }
        finally { db.close(); }
      `, file], { encoding: "utf8", timeout: 10_000 });
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout.trim()).toBe("locked");
    }
    expect(api.indexFdFor(file)).toBe(fd);
  } finally {
    db.exec("ROLLBACK"); db.close(); api.closeDebtFd();
    for (const fd of held) fs.closeSync(fd);
    removeTempDirSync(dir);
  }
  expect(held.size).toBe(0);
});

it("W-RESTART a stable corrupt header is refused", () => {
  const f = fixture(); f.corrupt();
  expect(() => f.api.header()).toThrow("invalid WAL header");
});

it.each(["benign", "replaced", "truncated", "database", "corrupt", "sequence", "salt", "second", "no-backfill"])("W-RESTART-FILE %s uses real file identities and bounded reads", kind => {
  const dir = fs.mkdtempSync(join(tmpdir(), "wal-files-")), file = join(dir, "fixture.db"), wal = file + "-wal";
  const descriptors: number[] = [];
  let reads = 0, armed = false;
  try {
    for (const path of [file, join(dir, "other.db")]) {
      const db = new DatabaseSync(path);
      try { db.exec("CREATE TABLE item(value)"); } finally { db.close(); }
    }
    const initial = walHeader(), bytes = Buffer.alloc(32 + 3 * 4120);
    initial.copy(bytes);
    for (let i = 0; i < 3; i++) initial.copy(bytes, 32 + i * 4120 + 8, 16, 24);
    fs.writeFileSync(wal, bytes); fs.writeFileSync(file + "-shm", indexHeader(initial, 3, kind === "no-backfill" ? 1 : 3));
    const debtFd = fs.openSync(file, "r"), indexFd = fs.openSync(file + "-shm", "r+");
    descriptors.push(debtFd, indexFd);
    const change = (second: boolean) => {
      const h = walHeader(second ? 4 : kind === "sequence" ? 1 : 3, second ? 9 : kind === "salt" ? 6 : 8);
      if (kind === "corrupt") h[24] = h[24]! ^ 1;
      const writer = fs.openSync(wal, "r+");
      try { fs.writeSync(writer, h, 0, 32, 0); } finally { fs.closeSync(writer); }
      fs.writeSync(indexFd, indexHeader(h, 0), 0, 100, 0);
      if (kind === "replaced") { fs.renameSync(wal, join(dir, "old.wal")); fs.copyFileSync(join(dir, "old.wal"), wal); }
      if (kind === "truncated") fs.truncateSync(wal, 32);
      if (kind === "database") { fs.renameSync(file, join(dir, "old.db")); fs.renameSync(join(dir, "other.db"), file); }
    };
    const api = runInNewContext(program.slice(program.indexOf("const head ="), program.indexOf("let sampledSalt =")) + "\n({ header })", {
      ...fs, Buffer, debtFd, indexFd, workerData: { file }, shared: new Int32Array(28), copied: new BigInt64Array(1), Date: { now: () => 0 },
      readSync(fd: number, out: Buffer, offset: number, length: number, position: number) {
        if (armed && fd !== indexFd && position === 0 && length === 32) {
          reads++;
          if (reads === 2 || (kind === "second" && reads === 4)) change(reads === 4);
        }
        return fs.readSync(fd, out, offset, length, position);
      },
    }) as { header(): { index: { mxFrame: number } } };
    api.header(); armed = true;
    if (kind === "benign") {
      let answer: { index: { mxFrame: number } } | undefined;
      try { answer = api.header(); } catch { /* assert the accepted snapshot */ }
      expect(answer?.index.mxFrame).toBe(0);
      expect(reads).toBe(4);
    } else {
      expect(() => api.header()).toThrow();
      expect(reads).toBeLessThanOrEqual(4);
      if (kind === "second") expect(reads).toBe(4);
    }
  } finally {
    for (const fd of descriptors) fs.closeSync(fd);
    removeTempDirSync(dir);
  }
});
