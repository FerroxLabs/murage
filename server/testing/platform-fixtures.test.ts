// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { expect, it, vi } from "vitest";
import { denyFixtureRead, fixtureLink, fixturePlatformEnv, stopFixtureServer } from "./platform-fixtures.ts";

function childFixture() {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null, signalCode: null, connected: true,
    send: vi.fn((_message: unknown) => { setImmediate(() => { child.exitCode = 0; child.emit("close", 0); }); }),
    kill: vi.fn(() => { setImmediate(() => { child.exitCode = 0; child.emit("close", 0); }); return true; }),
  });
  return child;
}
it("Windows fixture shutdown uses the server's catchable desktop IPC request and joins close", async () => {
  const child = childFixture();
  await stopFixtureServer(child as unknown as ChildProcess, "win32");
  expect(child.send).toHaveBeenCalledExactlyOnceWith({ type: "murage:close" });
  expect(child.kill).not.toHaveBeenCalled();
  expect(child.exitCode).toBe(0);
});
it("POSIX fixture shutdown uses SIGTERM and joins close", async () => {
  const child = childFixture();
  await stopFixtureServer(child as unknown as ChildProcess, "linux");
  expect(child.send).not.toHaveBeenCalled();
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  expect(child.exitCode).toBe(0);
});
it("a Windows fixture without IPC fails clearly instead of silently terminating", async () => {
  const child = childFixture(); child.connected = false;
  await expect(stopFixtureServer(child as unknown as ChildProcess, "win32")).rejects.toThrow(/IPC/);
  expect(child.kill).not.toHaveBeenCalled();
});

const calls = vi.hoisted(() => ({ symlink: vi.fn(), chmod: vi.fn(), exec: vi.fn() }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), symlinkSync: calls.symlink, chmodSync: calls.chmod }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), execFileSync: calls.exec }));

it("uses native directory junctions on Windows and typed file symlinks on both systems", () => {
  calls.symlink.mockClear();
  fixtureLink("C:\\outside", "C:\\data\\link", "dir", "win32");
  fixtureLink("C:\\outside.txt", "C:\\data\\link.txt", "file", "win32");
  fixtureLink("/outside", "/data/link", "dir", "linux");
  expect(calls.symlink.mock.calls).toEqual([
    ["C:\\outside", "C:\\data\\link", "junction"],
    ["C:\\outside.txt", "C:\\data\\link.txt", "file"],
    ["/outside", "/data/link", "dir"],
  ]);
});
it("denies Windows fixture reads by the token SID and removes that deny before cleanup", () => {
  calls.exec.mockReset().mockImplementation((file: string) => file === "whoami.exe" ? '\"fixture\",\"S-1-5-21-1-2-3-1001\"\r\n' : "");
  calls.chmod.mockClear();
  const restore = denyFixtureRead("C:\\fixture\\locked.txt", "win32");
  expect(calls.exec.mock.calls.map(call => call.slice(0, 2))).toEqual([
    ["whoami.exe", ["/user", "/fo", "csv", "/nh"]],
    ["icacls.exe", ["C:\\fixture\\locked.txt", "/deny", "*S-1-5-21-1-2-3-1001:(R)"]],
  ]);
  restore();
  expect(calls.exec.mock.lastCall?.slice(0, 2)).toEqual(["icacls.exe", ["C:\\fixture\\locked.txt", "/remove:d", "*S-1-5-21-1-2-3-1001"]]);
  expect(calls.chmod).not.toHaveBeenCalled();
});
it("refuses to manufacture a Windows ACL when the token SID could not be read", () => {
  calls.exec.mockReset().mockReturnValue("not a SID");
  expect(() => denyFixtureRead("C:\\fixture\\locked.txt", "win32")).toThrow(/SID/);
  expect(calls.exec).toHaveBeenCalledTimes(1);
});
it("uses mode 000 with a mode 600 undo on POSIX", () => {
  calls.chmod.mockClear();
  const restore = denyFixtureRead("/fixture/locked.txt", "linux");
  restore();
  expect(calls.chmod.mock.calls).toEqual([["/fixture/locked.txt", 0o000], ["/fixture/locked.txt", 0o600]]);
});
it("keeps only fixture OS plumbing, without ambient credentials", () => {
  expect(fixturePlatformEnv({ SystemRoot: "C:\\Windows", Path: "untrusted", OPENAI_API_KEY: "fake-canary", TEMP: "C:\\tmp" })).toEqual({ SystemRoot: "C:\\Windows", TEMP: "C:\\tmp" });
});
