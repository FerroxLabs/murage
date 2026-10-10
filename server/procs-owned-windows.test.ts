import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", () => native);
vi.mock("./env-path.ts", () => ({ resolveCliSpawn: (command: string, args: string[]) => ({ command, args }) }));

import { awaitCliTreeStopped, forceCliTreeStopped, spawnCli } from "./procs.ts";

// Simulated Windows only: no subprocess, taskkill or signal is executed.
// Use real spawnCli admission bookkeeping with an explicit mocked OS seam.
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
let child: ChildProcess;
let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "pip-procs-win-"));
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
  rmSync(base, { recursive: true, force: true });
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

// Windows without a job keeps the 1.0.1 stop semantics exactly. True descendant
// confirmation arrives with the native Job Object lane.
describe("Windows tree stop without a job keeps the 1.0.1 semantics (simulated)", () => {
  it("one taskkill /T /F while the root is alive; the root's close confirms the stop", async () => {
    native.execFile.mockImplementation((_command, _args, _options, callback) => { queueMicrotask(() => child.emit("close", 1, null)); callback(null); });
    const owned = spawnCli("fixture.exe", [], { stdio: ["pipe", "pipe", "pipe"] });
    await expect(awaitCliTreeStopped(owned)).resolves.toBe(true);
    expect(native.execFile).toHaveBeenCalledTimes(1);
    expect(native.execFile).toHaveBeenCalledWith("taskkill", expect.arrayContaining(["/T", "/F"]), expect.any(Object), expect.any(Function));
  });

  it("a failed taskkill falls back to killing the root; its close is what 1.0.1 treated as stopped", async () => {
    native.execFile.mockImplementation((_command, _args, _options, callback) => callback(new Error("access denied")));
    child.kill = vi.fn(() => { queueMicrotask(() => child.emit("close", 1, null)); return true; });
    const owned = spawnCli("fixture.exe", [], { stdio: ["pipe", "pipe", "pipe"] });
    await expect(awaitCliTreeStopped(owned)).resolves.toBe(true);
    expect(child.kill).toHaveBeenCalled();
  });

  it("never re-issues taskkill against a retained pid after the root has closed", async () => {
    native.execFile.mockImplementation((_command, _args, _options, callback) => callback(new Error("access denied")));
    child.kill = vi.fn(() => { queueMicrotask(() => child.emit("close", 1, null)); return true; });
    const owned = spawnCli("fixture.exe", [], { stdio: ["pipe", "pipe", "pipe"] });
    await awaitCliTreeStopped(owned);
    const calls = native.execFile.mock.calls.length;
    await expect(awaitCliTreeStopped(owned)).resolves.toBe(true);
    await expect(awaitCliTreeStopped(owned)).resolves.toBe(true);
    expect(native.execFile.mock.calls.length).toBe(calls);
  });

  it("an exit-128 taskkill gets no success shortcut: only the root's close confirms", async () => {
    native.execFile.mockImplementation((_command, _args, _options, callback) => callback(Object.assign(new Error("not found"), { code: 128 })));
    child.kill = vi.fn(() => false);
    const owned = spawnCli("fixture.exe", [], { stdio: ["pipe", "pipe", "pipe"] });
    const stopped = awaitCliTreeStopped(owned);
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(stopped).resolves.toBe(false);
  });
});

describe("one shared in-flight confirmation (simulated)", () => {
  it("concurrent callers share ONE taskkill, and a slow success reaches every caller and later ones", async () => {
    let answer: ((err: Error | null) => void) | undefined;
    native.execFile.mockImplementation((_command, _args, _options, callback) => { answer = callback; });
    const owned = spawnCli("fixture.exe", [], { stdio: ["pipe", "pipe", "pipe"] });
    const a = awaitCliTreeStopped(owned);
    const b = awaitCliTreeStopped(owned);
    const c = forceCliTreeStopped(owned);
    await vi.advanceTimersByTimeAsync(4_000); // slower than a reset's wait, inside the stop's own 5 s
    answer!(null);
    child.emit("close", 1, null);
    // the force caller's own 2.5 s deadline passed at 4 s, so it reads not stopped;
    // the shared confirmation still reached the others and every later caller
    await expect(Promise.all([a, b, c])).resolves.toEqual([true, true, false]);
    expect(native.execFile).toHaveBeenCalledTimes(1);
    await expect(awaitCliTreeStopped(owned)).resolves.toBe(true);
    expect(native.execFile).toHaveBeenCalledTimes(1);
  });
});

describe("Windows PIP job ownership", () => {
  it("root exits first with a surviving child: not stopped until the job is empty", async () => {
    let members = 1;
    native.execFile.mockImplementation((_command, _args, _options, callback) => callback(null, JSON.stringify({ state: "present", activeProcesses: members })));
    const owned = spawnCli("claude.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, { name: "Local\\murage-pip-claude-fixture", argsFile: join(base, "args.json") });
    child.emit("close", 0, null); // the root is gone, one descendant still lives in the job
    await expect(awaitCliTreeStopped(owned)).resolves.toBe(false);
    members = 0;
    await expect(awaitCliTreeStopped(owned)).resolves.toBe(true);
  });

  it("a failing job helper is never reported as stopped", async () => {
    native.execFile.mockImplementation((_command, _args, _options, callback) => callback(new Error("helper failed"), ""));
    const owned = spawnCli("claude.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, { name: "Local\\murage-pip-claude-fixture", argsFile: join(base, "args.json") });
    child.emit("close", 0, null);
    await expect(awaitCliTreeStopped(owned)).resolves.toBe(false);
  });

  it("spawns only the supervisor with CLI arguments in a JSON file", () => {
    const args = ["", 'a "quoted" value', "trailing\\", "line\nnext"];
    const argsFile = join(base, "job-args.json");
    spawnCli("fixture.exe", args, { cwd: base, env: { FIXTURE: "value" }, stdio: ["pipe", "pipe", "pipe"] }, { name: "Local\\murage-pip-fixture", argsFile });
    expect(native.spawn).toHaveBeenCalledOnce();
    const [command, argv, options] = native.spawn.mock.calls[0];
    expect(command).toBe("powershell.exe");
    expect(argv).toEqual(expect.arrayContaining(["-JobName", "Local\\murage-pip-fixture", "-Cwd", base, "-ArgsFile", argsFile]));
    expect(argv).not.toContain("fixture.exe");
    expect(argv).not.toContain(args[1]);
    expect(JSON.parse(readFileSync(argsFile, "utf8"))).toEqual({ command: "fixture.exe", args });
    expect(options.env.FIXTURE).toBe("value");
    native.execFile.mockImplementation((_command, _args, _options, callback) => callback(null, '{"state":"absent"}'));
  });

  it.each([0, 2])("root close requires job confirmation (members=%s)", async activeProcesses => {
    native.execFile.mockImplementation((_command, _args, _options, callback) => callback(null, JSON.stringify({ state: "present", activeProcesses })));
    const owned = spawnCli("fixture.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, { name: "Local\\murage-pip-fixture", argsFile: join(base, "args.json") });
    child.emit("close", 0, null);
    expect(await awaitCliTreeStopped(owned)).toBe(activeProcesses === 0);
    expect(native.execFile).toHaveBeenCalledWith("powershell.exe", expect.arrayContaining(["-Stop", "-JobName", "Local\\murage-pip-fixture"]), expect.any(Object), expect.any(Function));
  });

  it("closes the exact supervisor before confirming a not-yet-created job", async () => {
    native.execFile.mockImplementation((_command, _args, _options, callback) => callback(null, '{"state":"absent"}'));
    const owned = spawnCli("fixture.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, { name: "Local\\murage-pip-fixture", argsFile: join(base, "args.json") });
    const stopped = awaitCliTreeStopped(owned);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(native.execFile).not.toHaveBeenCalled();
    child.emit("close", null, "SIGTERM");
    await expect(stopped).resolves.toBe(true);
  });
});
