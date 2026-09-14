import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", () => native);
vi.mock("./env-path.ts", () => ({ resolveCliSpawn: (command: string, args: string[]) => ({ command, args }) }));

import { awaitCliTreeStopped, spawnCli } from "./procs.ts";

// Simulated Windows only: no subprocess, taskkill or signal is executed.
// Use real spawnCli admission bookkeeping with an explicit mocked OS seam.
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
let child: ChildProcess;
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
  child = Object.assign(new EventEmitter(), {
    pid: process.pid + 10_000,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
  native.spawn.mockReset().mockReturnValue(child);
  native.execFile.mockReset().mockImplementation((_command, _args, _options, callback) => callback(null));
});
afterEach(() => {
  child.emit("close", child.exitCode, child.signalCode);
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.useRealTimers();
});

describe("owned Windows close confirmation (simulated)", () => {
  it.each(["exitCode", "signalCode"] as const)("waits for close after %s is recorded", async (field) => {
    const owned = spawnCli("fixture.exe", [], { stdio: ["pipe", "pipe", "pipe"] });
    Object.defineProperty(child, field, { value: field === "exitCode" ? 0 : "SIGTERM" });
    const stopped = awaitCliTreeStopped(owned);
    let resolved = false;
    void stopped.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);
    child.emit("close", child.exitCode, child.signalCode);
    await expect(stopped).resolves.toBe(true);
    expect(native.execFile).not.toHaveBeenCalled(); // exited root needs no new taskkill
  });

  it("times out without close even after root exit, then confirms a late close", async () => {
    const owned = spawnCli("fixture.exe", [], { stdio: ["pipe", "pipe", "pipe"] });
    Object.defineProperty(child, "exitCode", { value: 0 });
    const stopped = awaitCliTreeStopped(owned);
    let resolved = false;
    void stopped.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(stopped).resolves.toBe(false);
    child.emit("close", 0, null);
    await expect(awaitCliTreeStopped(owned)).resolves.toBe(true);
  });
});
