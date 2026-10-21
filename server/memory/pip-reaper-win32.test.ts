// The Windows look at a process and the argv sweep, from the native process list (no PowerShell).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { observeProcess, sweepByArgv } from "./pip-reaper.ts";
import type { NativeProcess } from "../engine-exclusion.ts";

const sleeper = JSON.parse(readFileSync(new URL("../testdata/win-nops/native-sleeper.json", import.meta.url), "utf8")) as NativeProcess;
const other: NativeProcess = { ...sleeper, pid: 77, ppid: 1, argv: ["C:\\Windows\\notepad.exe"], exe: "C:\\Windows\\notepad.exe" };
const list = () => [sleeper, other];

describe("observeProcess on Windows", () => {
  it("present with the creation FILETIME as identity, absent when not listed", async () => {
    expect(await observeProcess(5296, "win32", undefined, list)).toEqual({ state: "present", startTime: "134370254388084370" });
    expect(await observeProcess(4242, "win32", undefined, list)).toEqual({ state: "absent" });
  });
  it("a failed list, a stop, or an unreadable creation time is unknown, never absent", async () => {
    expect(await observeProcess(5296, "win32", undefined, () => null)).toEqual({ state: "unknown" });
    const stopped = new AbortController(); stopped.abort();
    expect(await observeProcess(5296, "win32", stopped.signal, list)).toEqual({ state: "unknown" });
    expect(await observeProcess(5296, "win32", undefined, () => [{ ...sleeper, start: 0 }])).toEqual({ state: "unknown" });
  });
});

describe("sweepByArgv on Windows", () => {
  it("finds processes whose command line holds the needle, case-insensitively, never this process", async () => {
    expect(await sweepByArgv("F:\\TEMP\\CODEX\\NOPS-CAP\\PORT.TXT", "win32", undefined, "/proc", list)).toEqual([5296]);
    expect(await sweepByArgv("nothing-like-this", "win32", undefined, "/proc", list)).toEqual([]);
    expect(await sweepByArgv("node.exe", "win32", undefined, "/proc", () => [{ ...sleeper, pid: process.pid }])).toEqual([]);
  });
  it("an unreadable command line never matches; a failed list or a stop is null", async () => {
    expect(await sweepByArgv("port.txt", "win32", undefined, "/proc", () => [{ ...sleeper, argv: null }])).toEqual([]);
    expect(await sweepByArgv("port.txt", "win32", undefined, "/proc", () => null)).toBeNull();
    const stopped = new AbortController(); stopped.abort();
    expect(await sweepByArgv("port.txt", "win32", stopped.signal, "/proc", list)).toBeNull();
  });
});
