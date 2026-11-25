// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: q1022-ordfiles (the io-budget minute line, io-budget.ts tick; io-written.ts takeDatabaseBuckets). Meter: scperf-p1 (native/).
// q1022-ordfiles round 2 (ASTRA/FABLE/OPUS 13165251d5): the attribution rows go through the PRODUCTION meter, with no injected reading:
// the process singleton ioBudget (its readers wired as the server wires them: readProcess, takeWrittenBytes, takeDatabaseBuckets), the
// real meter addon built from native/, a real ordinary-file append through counted-fs (the health log's writer) and real sqlite WAL
// writes on a temp messages.db. Only the wall clock is the test's (Date), so a minute passes without waiting one.
import { execFileSync } from "node:child_process";
import { closeSync, fsyncSync, mkdtempSync, openSync, rmSync, writeSync as rawWriteSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { forgetExclusionAddon } from "./engine-exclusion.ts";
import * as meter from "./io-meter.ts";
import { writeSync } from "./counted-fs.ts";
import { ioBudget, instrumentDatabase, IO_BUDGET_INTERVAL_MS } from "./io-budget.ts";
import { DatabaseSync } from "./sqlite-open.ts";

const MB = 1024 * 1024;
const root = mkdtempSync(join(tmpdir(), "io-meter-1022-"));
// a disk-backed directory (the OS write count does not see a RAM file system), removed after the file
const disk = mkdtempSync(join(process.cwd(), ".io-os-1022-"));
const prior = process.env.MURAGE_ENGINE_EXCLUSION_PATH;
const lines: string[] = [];
let now = Date.UTC(2026, 10, 24, 6, 0, 0);
beforeAll(() => {
  const binary = join(root, "meter.node");
  execFileSync("cc", ["-std=c11", "-D_GNU_SOURCE", "-O2", "-Wall", "-Werror", "-fPIC", "-shared", "-DNAPI_VERSION=9", "-I", resolve(dirname(process.execPath), "../include/node"), "native/engine-exclusion/exclusion.c", "native/engine-exclusion/meter.c", "-o", binary], { stdio: "pipe" });
  process.env.MURAGE_ENGINE_EXCLUSION_PATH = binary;
  forgetExclusionAddon(); meter.resetIoMeterForTest();
  // the meter must be live before any database below opens (its VFS counts every xWrite, per database file)
  expect(meter.ioMeterActive()).toBe(true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.spyOn(console, "warn").mockImplementation((line: unknown) => { lines.push(String(line)); });
  ioBudget.setIsIdle(() => true);
});
afterAll(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  if (prior === undefined) delete process.env.MURAGE_ENGINE_EXCLUSION_PATH; else process.env.MURAGE_ENGINE_EXCLUSION_PATH = prior;
  forgetExclusionAddon(); meter.resetIoMeterForTest();
  rmSync(root, { recursive: true, force: true }); rmSync(disk, { recursive: true, force: true });
});
/** One minute passes on the wall clock, then the server's minute timer runs (IoBudget.tick). */
function nextMinute() { now += IO_BUDGET_INTERVAL_MS; vi.setSystemTime(now); lines.length = 0; return ioBudget.tick(); }
/** The health log's writer: an append through counted-fs, which the meter counts as ordinary-files (health/publisher.ts). */
function healthAppend(bytes: number) {
  const fd = openSync(join(root, "server.current.ndjson"), "a");
  try { writeSync(fd, Buffer.alloc(bytes, 0x61)); } finally { closeSync(fd); }
}
const rows = (db: DatabaseSync, count: number) => { const insert = db.prepare("INSERT INTO t(body) VALUES (?)"); db.exec("BEGIN"); for (let i = 0; i < count; i++) insert.run(Buffer.alloc(64 * 1024, i & 255)); db.exec("COMMIT"); };
const writing = () => lines.filter(line => line.startsWith("[io-budget] writing "));

it("W-FIRST: bytes named before the budget's first reading (boot) are not charged to the first judged minute", () => {
  // boot: a database commit and an ordinary-file write, both named, before the server's first tick (io-budget.ts start)
  const boot = new DatabaseSync(join(root, "boot.db"));
  boot.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(n INTEGER PRIMARY KEY, body BLOB)");
  const release = instrumentDatabase(boot);
  rows(boot, 32);
  healthAppend(2 * MB);
  expect(ioBudget.tick()).toBeNull(); // the first reading: the baseline
  // an idle first minute that wrote nothing: under the idle budget, no over-budget line
  const verdict = nextMinute();
  expect(writing()).toEqual([]);
  expect(verdict?.tripped).toBe(false);
  release(); boot.close();
});

it("W-UNNAMED-PROD: database bytes no source took, beside the health append, are named unnamed with the file, not ordinary-files", () => {
  nextMinute();
  // a connection no source instruments (a worker thread's own connection; a WAL copy-back): 4 MB of log, then its copy into messages.db
  const worker = new DatabaseSync(join(root, "messages.db"));
  worker.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(n INTEGER PRIMARY KEY, body BLOB)");
  rows(worker, 64);
  worker.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  worker.close();
  healthAppend(800);
  const verdict = nextMinute();
  expect(verdict?.tripped).toBe(true);
  expect(writing()).toHaveLength(1);
  expect(writing()[0]).toMatch(/; source: unnamed \(meter: database:messages\.db\); bytes: os /);
  expect(writing()[0]).toMatch(/, named 0\.0 MB \(ordinary-files 0\.0\), unnamed [1-9]\d*\.\d MB \(meter by file: database:messages\.db [1-9]\d*\.\d\)/);
  // the deferral key is the top named source, as before: only the line names the bytes
  expect(verdict?.source).toBe("ordinary-files");
});

it("W-UNNAMED-OS-PROD: bytes the OS counted that no meter saw, beside the health append, are named unnamed (no file), not ordinary-files", () => {
  nextMinute();
  // a write outside every Murage meter (raw node:fs, not counted-fs: as a native library or a non-routed writer would), flushed to disk
  const fd = openSync(join(disk, "outside-the-meter.bin"), "w");
  try { for (let i = 0; i < 48; i++) rawWriteSync(fd, Buffer.alloc(64 * 1024, i & 255)); fsyncSync(fd); } finally { closeSync(fd); }
  healthAppend(800);
  const verdict = nextMinute();
  expect(verdict?.tripped).toBe(true);
  expect(writing()).toHaveLength(1);
  expect(writing()[0]).toMatch(/; source: unnamed; bytes: os [1-9]\d*\.\d MB, meter 0\.0 MB, named 0\.0 MB \(ordinary-files 0\.0\), unnamed [1-9]\d*\.\d MB;/);
  expect(verdict?.source).toBe("ordinary-files");
});
