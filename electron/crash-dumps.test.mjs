// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CRASH_DUMP_QUESTION,
  createCrashDumpLinker,
  crashDumpNamesInLog,
  freshCrashDump,
  includeCrashDumpOnRequest,
  listCrashDumps,
  pruneCrashDumps,
  startLocalCrashReporter,
  unnamedCrashDumps,
} from "./crash-dumps.mjs";
import { formatDesktopCrashRecord } from "./diagnostics.mjs";

const withDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "murage-crash-dumps-"));
  try { return fn(dir); } finally { rmSync(dir, { force: true, recursive: true }); }
};
const withDirAsync = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "murage-crash-dumps-"));
  try { return await fn(dir); } finally { rmSync(dir, { force: true, recursive: true }); }
};
const T0 = Date.UTC(2026, 9, 23, 12, 0, 0);
function dump(dir, name, { at = T0, bytes = 16, sub = "completed" } = {}) {
  const folder = join(dir, sub);
  mkdirSync(folder, { recursive: true });
  const file = join(folder, name);
  writeFileSync(file, Buffer.alloc(bytes, 1));
  utimesSync(file, new Date(at), new Date(at));
  return file;
}

describe("startLocalCrashReporter", () => {
  it("starts Crashpad with uploads off, no server address and compression", () => {
    const start = vi.fn();
    expect(startLocalCrashReporter({ start })).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ uploadToServer: false, submitURL: "", compress: true });
  });

  it("lets the app start when the reporter throws", () => {
    expect(startLocalCrashReporter({ start: () => { throw new Error("no crashpad"); } })).toBe(false);
  });
});

describe("pruneCrashDumps", () => {
  it("keeps the newest 10 dumps and removes older ones with their .meta", () => withDir((dir) => {
    for (let i = 0; i < 14; i += 1) dump(dir, `d${String(i).padStart(2, "0")}.dmp`, { at: T0 + i * 1000, sub: i % 2 ? "completed" : "pending" });
    writeFileSync(join(dir, "pending", "d00.meta"), "meta");
    const { kept, removed } = pruneCrashDumps(dir);
    expect(kept.map((d) => d.name)).toEqual(["d13", "d12", "d11", "d10", "d09", "d08", "d07", "d06", "d05", "d04"].map((n) => `${n}.dmp`));
    expect(removed.map((d) => d.name).sort()).toEqual(["d00.dmp", "d01.dmp", "d02.dmp", "d03.dmp"]);
    expect(listCrashDumps(dir)).toHaveLength(10);
    expect(existsSync(join(dir, "pending", "d00.meta"))).toBe(false);
  }));

  it("holds the total near the byte cap and always keeps the newest dump", () => withDir((dir) => {
    dump(dir, "old.dmp", { at: T0, bytes: 600 });
    dump(dir, "mid.dmp", { at: T0 + 1000, bytes: 600 });
    dump(dir, "new.dmp", { at: T0 + 2000, bytes: 1500 });
    const { kept } = pruneCrashDumps(dir, { maxBytes: 1000 });
    expect(kept.map((d) => d.name)).toEqual(["new.dmp"]);
    expect(listCrashDumps(dir).map((d) => d.name)).toEqual(["new.dmp"]);
  }));

  it("touches only Crashpad-named regular .dmp files", () => withDir((dir) => {
    for (let i = 0; i < 11; i += 1) dump(dir, `d${i}.dmp`, { at: T0 + i * 1000 });
    writeFileSync(join(dir, "settings.dat"), "crashpad");
    writeFileSync(join(dir, "completed", "notes.txt"), "keep");
    const outside = join(dir, "..", `outside-${process.pid}.dmp`);
    writeFileSync(outside, "user file");
    try {
      if (process.platform !== "win32") symlinkSync(outside, join(dir, "completed", "aaa.dmp"));
      pruneCrashDumps(dir);
      expect(existsSync(join(dir, "settings.dat"))).toBe(true);
      expect(existsSync(join(dir, "completed", "notes.txt"))).toBe(true);
      expect(readFileSync(outside, "utf8")).toBe("user file");
    } finally { rmSync(outside, { force: true }); }
  }));

  it("is a no-op for a missing folder", () => {
    expect(pruneCrashDumps(join(tmpdir(), "murage-no-such-crash-folder"))).toEqual({ kept: [], removed: [] });
    expect(pruneCrashDumps("")).toEqual({ kept: [], removed: [] });
  });
});

describe("crash line names the dump", () => {
  it("adds dump=<file> to the renderer and child crash lines", () => {
    expect(formatDesktopCrashRecord({ kind: "renderer", surface: "main-window", reason: "crashed", exitCode: 5, dump: "6c1b2f0e-1111-4222-8333-944445555666.dmp" }))
      .toBe("event=render-process-gone surface=main-window reason=crashed exitCode=5 mem=none dump=6c1b2f0e-1111-4222-8333-944445555666.dmp");
    expect(formatDesktopCrashRecord({ kind: "child", type: "GPU", reason: "crashed", exitCode: 1, dump: "none" }))
      .toBe("event=child-process-gone type=GPU reason=crashed exitCode=1 dump=none");
    expect(formatDesktopCrashRecord({ kind: "earlier-dump", dump: "abc.dmp" })).toBe("event=earlier-crash dump=abc.dmp");
  });

  it("never writes a path or a strange name", () => {
    const line = formatDesktopCrashRecord({ kind: "renderer", reason: "crashed", exitCode: 5, dump: "/Users/ada/secret.dmp" });
    expect(line).toContain(" dump=none");
    expect(line).not.toContain("ada");
    expect(formatDesktopCrashRecord({ kind: "earlier-dump", dump: "../x.dmp" })).toBeNull();
    expect(formatDesktopCrashRecord({ kind: "renderer", reason: "crashed", exitCode: 5 })).not.toContain("dump=");
  });

  it("names the dump Crashpad writes after the process is gone", () => withDir((dir) => {
    const lines = [];
    const timers = [];
    let clock = T0;
    const linker = createCrashDumpLinker({
      directory: () => dir,
      write: (event) => lines.push(formatDesktopCrashRecord(event)),
      now: () => clock,
      schedule: (fn) => { timers.push(fn); return timers.length; },
      cancel: () => {},
    });
    dump(dir, "older.dmp", { at: T0 - 60_000 });
    linker.record({ kind: "renderer", surface: "main-window", reason: "crashed", exitCode: 11 });
    expect(lines).toEqual([]);
    clock = T0 + 1500;
    dump(dir, "fresh.dmp", { at: T0 + 1200, sub: "pending" });
    timers[0]();
    expect(lines).toEqual(["event=render-process-gone surface=main-window reason=crashed exitCode=11 mem=none dump=fresh.dmp"]);
    timers[1]();
    expect(lines).toHaveLength(1);
  }));

  it("writes dump=none when Crashpad wrote nothing, and flushes pending lines at exit", () => withDir((dir) => {
    const lines = [];
    const timers = [];
    const linker = createCrashDumpLinker({
      directory: () => dir, write: (event) => lines.push(formatDesktopCrashRecord(event)), now: () => T0,
      schedule: (fn) => { timers.push(fn); return timers.length; }, cancel: () => {},
    });
    linker.record({ kind: "child", type: "GPU", reason: "crashed", exitCode: 3 });
    timers[0]();
    expect(lines).toEqual([]);
    timers[1]();
    expect(lines).toEqual(["event=child-process-gone type=GPU reason=crashed exitCode=3 dump=none"]);
    linker.record({ kind: "renderer", reason: "oom", exitCode: 9 });
    dump(dir, "late.dmp", { at: T0 + 100 });
    linker.flush();
    expect(lines[1]).toBe("event=render-process-gone surface=auxiliary reason=oom exitCode=9 mem=none dump=late.dmp");
  }));

  it("names each dump once and finds dumps no line names", () => withDir((dir) => {
    dump(dir, "a.dmp", { at: T0 });
    dump(dir, "b.dmp", { at: T0 + 1000 });
    const claimed = crashDumpNamesInLog("[t] event=render-process-gone reason=crashed dump=a.dmp\n[t] event=x dump=none\n");
    expect([...claimed]).toEqual(["a.dmp"]);
    expect(unnamedCrashDumps(dir, claimed)).toEqual(["b.dmp"]);
    expect(freshCrashDump(dir, { sinceMs: T0 + 9000, claimed: new Set(["b.dmp"]) })).toBeNull();
  }));
});

describe("includeCrashDumpOnRequest", () => {
  it("never adds a dump unless the person chooses it", () => withDirAsync(async (dir) => {
    const dumps = join(dir, "Crashpad");
    dump(dumps, "only.dmp");
    const report = join(dir, "murage-diagnostics-20261023-120000.txt");
    writeFileSync(report, "report");
    const ask = vi.fn(async () => false);
    expect(await includeCrashDumpOnRequest({ reportPath: report, directory: dumps, ask })).toBeNull();
    expect(ask).toHaveBeenCalledWith(CRASH_DUMP_QUESTION);
    expect(existsSync(join(dir, "murage-diagnostics-20261023-120000-crash.dmp"))).toBe(false);
    // A closed dialog is not a yes either.
    expect(await includeCrashDumpOnRequest({ reportPath: report, directory: dumps, ask: async () => undefined })).toBeNull();
  }));

  it("does not ask when there is no dump", () => withDirAsync(async (dir) => {
    const ask = vi.fn(async () => true);
    expect(await includeCrashDumpOnRequest({ reportPath: join(dir, "r.txt"), directory: join(dir, "none"), ask })).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  }));

  it("copies the newest dump beside the report when chosen, private to the user", () => withDirAsync(async (dir) => {
    const dumps = join(dir, "Crashpad");
    dump(dumps, "old.dmp", { at: T0, bytes: 4 });
    dump(dumps, "new.dmp", { at: T0 + 1000, bytes: 8 });
    const report = join(dir, "murage-diagnostics-20261023-120000.txt");
    const target = await includeCrashDumpOnRequest({ reportPath: report, directory: dumps, ask: async () => true });
    expect(target).toBe(join(dir, "murage-diagnostics-20261023-120000-crash.dmp"));
    expect(statSync(target).size).toBe(8);
    if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o600);
    await expect(includeCrashDumpOnRequest({ reportPath: report, directory: dumps, ask: async () => true })).rejects.toThrow();
  }));

  it("asks in plain words", () => {
    for (const text of [CRASH_DUMP_QUESTION.message, CRASH_DUMP_QUESTION.detail, ...CRASH_DUMP_QUESTION.buttons]) {
      expect(text).not.toMatch(/—|\b(?:safe|safely|safety|unsafe)\b/i);
    }
  });
});
