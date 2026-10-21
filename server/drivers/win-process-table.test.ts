// The Windows process table without PowerShell, against output captured from a real Windows 11 machine
// (server/testdata/win-nops/README.txt).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTasklistMemory, rowsFromNative } from "./win-process-table.ts";
import type { NativeProcess } from "../engine-exclusion.ts";

const fixture = (name: string) => readFileSync(new URL(`../testdata/win-nops/${name}`, import.meta.url), "utf8");
const sleeper = JSON.parse(fixture("native-sleeper.json")) as NativeProcess;

describe("tasklist /FO CSV /NH (real capture)", () => {
  it("reads every row's working set from its digits, whatever the separators", () => {
    const memory = parseTasklistMemory(fixture("tasklist.csv"))!;
    expect(memory.get(4)).toBe(30_280 * 1024);
    expect(memory.get(1320)).toBe(1_704 * 1024);
    expect(memory.get(5296)).toBe(57_144 * 1024);
    // other display languages group the number differently and translate the unit
    expect(parseTasklistMemory('"node.exe","7","Console","1","57.144 KB"\r\n')!.get(7)).toBe(57_144 * 1024);
    expect(parseTasklistMemory('"node.exe","7","Console","1","57\u00a0144 Ko"\r\n')!.get(7)).toBe(57_144 * 1024);
  });
  it("a row without a size is left out; a damaged or empty answer is no table", () => {
    expect(parseTasklistMemory('"node.exe","7","Console","1","N/A"\r\n')!.has(7)).toBe(false);
    for (const bad of ["", "\r\n", "INFO: nothing\r\n", fixture("tasklist.csv") + "garbage\r\n", '"a","x","b","1","2 K"\r\n']) expect(parseTasklistMemory(bad)).toBeNull();
  });
});

describe("native process entry (real capture)", () => {
  it("carries the parent, the creation FILETIME and the command line", () => {
    expect(sleeper.pid).toBe(5296);
    expect(sleeper.ppid).toBe(60408);
    expect(sleeper.exe).toMatch(/node\.exe$/);
    const rows = rowsFromNative([sleeper], new Map([[5296, 57_144 * 1024]]));
    expect(rows).toEqual([{ pid: 5296, ppid: 60408, startMs: 1792551838808, start: "134370254388084370", rssBytes: 57_144 * 1024 }]);
  });
  it("keeps the parent link when the parent started first, and drops it when the pid was reused later", () => {
    const parent: NativeProcess = { ...sleeper, pid: 60408, ppid: 1, start: sleeper.start - 100 };
    expect(rowsFromNative([parent, sleeper], null).find((row) => row.pid === 5296)!.ppid).toBe(60408);
    const reused: NativeProcess = { ...parent, start: sleeper.start + 100 };
    expect(rowsFromNative([reused, sleeper], null).find((row) => row.pid === 5296)!.ppid).toBe(0);
  });
  it("a process whose times cannot be read has no identity; an ended one is not listed", () => {
    const rows = rowsFromNative([{ ...sleeper, start: 0 }, { ...sleeper, pid: 9, ppid: 1, exe: "" }], null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ startMs: null, start: "" });
  });
});
