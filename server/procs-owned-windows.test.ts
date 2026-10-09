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

import { awaitCliTreeStopped, spawnCli } from "./procs.ts";

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

describe("Windows tree confirmation without a job (simulated)", () => {
  it("a failed taskkill is not a stopped tree, even when the fallback then closes the root", async () => {
    native.execFile.mockImplementation((_command, _args, _options, callback) => callback(new Error("access denied")));
    child.kill = vi.fn(() => { queueMicrotask(() => child.emit("close", 1, null)); return true; });
    const owned = spawnCli("fixture.exe", [], { stdio: ["pipe", "pipe", "pipe"] });
    await expect(awaitCliTreeStopped(owned)).resolves.toBe(false);
    expect(child.kill).toHaveBeenCalled();
  });

  it("a successful taskkill plus root close is a stopped tree", async () => {
    native.execFile.mockImplementation((_command, _args, _options, callback) => { queueMicrotask(() => child.emit("close", 1, null)); callback(null); });
    const owned = spawnCli("fixture.exe", [], { stdio: ["pipe", "pipe", "pipe"] });
    await expect(awaitCliTreeStopped(owned)).resolves.toBe(true);
    expect(native.execFile).toHaveBeenCalledWith("taskkill", expect.arrayContaining(["/T", "/F"]), expect.any(Object), expect.any(Function));
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

describe("windowsCommandResolvable", () => {
  it("finds a command by path or on PATH with PATHEXT, and reports a missing one", async () => {
    const { windowsCommandResolvable } = await import("./procs.ts");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(base, "tool.CMD"), "");
    const env = { Path: `${join(base, "nowhere")};${base}`, PATHEXT: ".EXE;.CMD" };
    expect(windowsCommandResolvable("tool", env)).toBe(true);
    expect(windowsCommandResolvable(join(base, "tool"), env)).toBe(true);
    expect(windowsCommandResolvable("absent", env)).toBe(false);
    expect(windowsCommandResolvable(join(base, "absent"), env)).toBe(false);
  });
});
