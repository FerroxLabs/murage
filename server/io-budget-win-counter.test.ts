// SPDX-License-Identifier: AGPL-3.0-or-later
// WIN-IOB-QUICK (1.0.18): on win32 resourceUsage().fsWrite counts pipe and IPC writes too (the Windows box probe: 2000 child.send
// calls read as 2000), so the OS floor is 0 there and the verdict comes from application bytes: WAL frames, and the logical output
// sizes the copy/snapshot/index sinks note (io-written.ts). These tests run on Linux with the platform passed in.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { IoBudget, ioBudget, osWriteBlocks } from "./io-budget.ts";
import { noteWrittenBytes, noteWrittenFile, takeWrittenBytes } from "./io-written.ts";
import { settleFtsCopy } from "./settle-copy.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const MINUTE = 60_000;
// 2000 * 512 is below the default 1 MiB idle budget; use a smaller test-only budget.
const BUDGET_BYTES = 512 * 1024;

function fakeUsage(fsWrite = 0): ReturnType<typeof process.resourceUsage> {
  return {
    userCPUTime: 0, systemCPUTime: 0, maxRSS: 0, sharedMemorySize: 0,
    unsharedDataSize: 0, unsharedStackSize: 0, minorPageFault: 0, majorPageFault: 0,
    swappedOut: 0, fsRead: 0, fsWrite, ipcSent: 0, ipcReceived: 0,
    signalsCount: 0, voluntaryContextSwitches: 0, involuntaryContextSwitches: 0,
  };
}

function rig(platform: NodeJS.Platform, written?: () => Iterable<[string, number]>) {
  const usage = fakeUsage();
  let at = 0;
  const lines: string[] = [], scales: number[] = [];
  const budget = new IoBudget({
    read: () => ({ at, fsWriteBlocks: osWriteBlocks(usage, platform), cpuMicros: 0 }),
    log: line => lines.push(line), onScale: scale => scales.push(scale),
    bytesPerMinute: BUDGET_BYTES, systemOverloaded: () => null, written,
  });
  budget.tick();
  const minute = () => {
    at += MINUTE;
    usage.fsWrite += 2000;
    return budget.tick();
  };
  return { budget, lines, scales, minute };
}

const dirs: string[] = [];
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "win-iob-")); dirs.push(dir); return dir; };
afterEach(() => { takeWrittenBytes(); while (dirs.length) removeTempDirSync(dirs.pop()!); });

describe("io-budget: Windows write operation counter", () => {
  it("(a) ignores 2000 Windows pipe writes per minute without tripping or deferring", () => {
    const { budget, lines, scales, minute } = rig("win32");
    for (let i = 0; i < 3; i++) {
      expect(minute()).toMatchObject({ writeBytesPerMinute: 0, tripped: false });
      expect(budget.shouldDefer("process")).toBe(false);
      expect(budget.deferredForMs("process")).toBe(0);
    }
    expect(lines).toEqual([]);
    expect(scales).toEqual([]);
    expect(budget.pollScale()).toBe(1);
  });

  it.each(["linux", "darwin"] as const)("(b) still charges 2000 * 512 bytes per minute on %s", platform => {
    const { budget, lines, scales, minute } = rig(platform);
    for (let i = 0; i < 3; i++) {
      expect(minute()).toMatchObject({ writeBytesPerMinute: 2000 * 512, tripped: true });
    }
    expect(lines).toHaveLength(3);
    expect(lines.every(line => line.startsWith("[io-budget] writing"))).toBe(true);
    expect(scales).toEqual([2, 4, 8]);
    expect(budget.shouldDefer("process")).toBe(true);
  });

  it("(c) still trips on Windows WAL bytes over budget", () => {
    const { budget, lines, minute } = rig("win32");
    let databaseBytes = 0;
    budget.registerByteSource("database:fixture.db", () => databaseBytes);
    databaseBytes += 2 * BUDGET_BYTES;
    expect(minute()).toMatchObject({ writeBytesPerMinute: 2 * BUDGET_BYTES, tripped: true, source: "database:fixture.db" });
    expect(lines[0]).toMatch(/^\[io-budget\] writing/);
    expect(budget.pollScale()).toBe(2);
    expect(budget.shouldDefer("database:fixture.db")).toBe(true);
  });

  it("(d) returns cumulative zero on Windows and unchanged fsWrite elsewhere", () => {
    const usage = fakeUsage();
    for (const fsWrite of [0, 2000, 4000, 6000]) {
      usage.fsWrite = fsWrite;
      expect(osWriteBlocks(usage, "win32")).toBe(0);
      for (const platform of ["linux", "darwin", "freebsd"] as const) expect(osWriteBlocks(usage, platform)).toBe(fsWrite);
    }
  });
});

describe("io-budget: logical output sizes still guard Windows (option c1)", () => {
  it("(e) a copy noted over budget trips on win32 beside the pipe storm, and names its sink", () => {
    const { budget, lines, minute } = rig("win32", takeWrittenBytes);
    noteWrittenBytes("database-copy", 2 * BUDGET_BYTES);
    expect(minute()).toMatchObject({ writeBytesPerMinute: 2 * BUDGET_BYTES, tripped: true, source: "database-copy" });
    expect(lines[0]).toMatch(/^\[io-budget\] writing .*source: database-copy/);
    // taken once: the next minute holds only the pipe storm, which charges nothing
    expect(minute()).toMatchObject({ writeBytesPerMinute: 0, tripped: false });
    expect(budget.shouldDefer("database-copy")).toBe(true);
  });

  it("logs both measured byte counts for an application-only trip on win32", () => {
    const { lines, minute } = rig("win32", takeWrittenBytes);
    noteWrittenBytes("database-copy", 2 * BUDGET_BYTES);
    expect(minute()).toMatchObject({ tripped: true, source: "database-copy" });
    expect(lines).toHaveLength(1);
    // Red before this change because the line carried neither field.
    expect(lines[0]).toContain(`; osBytes=0; applicationBytes=${2 * BUDGET_BYTES}; suppressed=0`);
    expect(lines[0]).toContain("source: database-copy");
  });

  it("(f) a small copy and the pipe storm together stay calm on win32", () => {
    const { minute } = rig("win32", takeWrittenBytes);
    noteWrittenBytes("skill-index-build", 64 * 1024);
    expect(minute()).toMatchObject({ writeBytesPerMinute: 64 * 1024, tripped: false });
  });

  it("(g) the process budget drains what the sinks noted; bad counts and missing files charge nothing; names stay bounded", () => {
    const dir = tempDir();
    const file = join(dir, "out.db");
    new DatabaseSync(file).close();
    const db = new DatabaseSync(file); db.exec("CREATE TABLE t(x); INSERT INTO t VALUES(randomblob(100000))"); db.close();
    noteWrittenFile("database-copy", file);
    noteWrittenFile("database-copy", join(dir, "missing.db"));
    noteWrittenBytes("database-copy", Number.NaN);
    noteWrittenBytes("database-copy", -5);
    const before = ioBudget.pendingBytes("database-copy");
    ioBudget.sampleBytes();
    expect(ioBudget.pendingBytes("database-copy") - before).toBe(readFileSync(file).length);
    for (let i = 0; i < 100; i++) noteWrittenBytes(`sink-${i}`, 1);
    const taken = takeWrittenBytes();
    expect(taken.length).toBeLessThanOrEqual(33);
    expect(taken.reduce((sum, [, bytes]) => sum + bytes, 0)).toBe(100);
    expect(takeWrittenBytes()).toEqual([]);
  });

  it("(h) a settle's VACUUM INTO charges the settled file's size under database-copy", () => {
    const dir = tempDir();
    const copy = join(dir, "copy.db.partial");
    const db = new DatabaseSync(copy); db.exec("CREATE TABLE t(x); INSERT INTO t SELECT randomblob(4096) FROM (WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<64) SELECT i FROM n)"); db.close();
    takeWrittenBytes();
    settleFtsCopy(copy, { check: false });
    const charged = takeWrittenBytes().find(([name]) => name === "database-copy")?.[1] ?? 0;
    expect(charged).toBeGreaterThan(64 * 4096);
    expect(charged).toBeLessThanOrEqual(readFileSync(copy).length + 4096);
  });

  it("(i) the memory helper's import graph stays light: worker.ts reads the leaf, and the leaf imports Node built-ins only", () => {
    const worker = readFileSync(new URL("./memory/worker.ts", import.meta.url), "utf8");
    expect(worker).not.toMatch(/from\s+"\.\.\/io-budget\.ts"/);
    expect(worker).toMatch(/from\s+"\.\.\/io-written\.ts"/);
    const leaf = readFileSync(new URL("./io-written.ts", import.meta.url), "utf8");
    const imports = [...leaf.matchAll(/^import\s.*from\s+"([^"]+)"/gm)].map(match => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every(name => name.startsWith("node:"))).toBe(true);
  });
});
