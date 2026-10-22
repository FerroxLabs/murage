import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";

const native = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", () => native);
vi.mock("./env-path.ts", () => ({ resolveCliSpawn: (command: string, args: string[]) => ({ command, args }) }));
// The Windows job object is the engine-exclusion addon's (no PowerShell supervisor any more, murage-releases #1).
const addon = vi.hoisted(() => ({ jobCreate: vi.fn(), jobAssign: vi.fn(), jobClose: vi.fn(), jobStop: vi.fn() }));
vi.mock("./engine-exclusion.ts", () => ({ requireWindowsAddon: () => addon }));

import { awaitCliTreeStopped, cliJobRefused, forceCliTreeStopped, spawnCli } from "./procs.ts";

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
  addon.jobCreate.mockReset().mockImplementation((name: string) => ({ job: name }));
  addon.jobAssign.mockReset().mockReturnValue(true);
  addon.jobClose.mockReset();
  addon.jobStop.mockReset().mockResolvedValue({ state: "absent" });
});
afterEach(() => {
  child.emit("close", child.exitCode, child.signalCode);
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.useRealTimers();
  removeTempDirSync(base);
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
  const JOB = { name: "Local\\murage-pip-fixture" };
  it("root exits first with a surviving child: not stopped until the job is empty", async () => {
    let members = 1;
    addon.jobStop.mockImplementation(async () => ({ state: "present", activeProcesses: members }));
    const owned = spawnCli("claude.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, { name: "Local\\murage-pip-claude-fixture" });
    child.emit("close", 0, null); // the root is gone, one descendant still lives in the job
    await expect(awaitCliTreeStopped(owned)).resolves.toBe(false);
    members = 0;
    await expect(awaitCliTreeStopped(owned)).resolves.toBe(true);
  });

  it("a failing job stop is never reported as stopped", async () => {
    addon.jobStop.mockRejectedValue(new Error("the job could not be stopped"));
    const owned = spawnCli("claude.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, { name: "Local\\murage-pip-claude-fixture" });
    child.emit("close", 0, null);
    await expect(awaitCliTreeStopped(owned)).resolves.toBe(false);
  });

  it("creates the job first, spawns the CLI itself (no PowerShell) and puts it in the job at once", () => {
    const args = ["", 'a "quoted" value', "trailing\\", "line\nnext"];
    spawnCli("fixture.exe", args, { cwd: base, env: { FIXTURE: "value" }, stdio: ["pipe", "pipe", "pipe"] }, JOB);
    expect(addon.jobCreate).toHaveBeenCalledWith(JOB.name);
    expect(native.spawn).toHaveBeenCalledOnce();
    const [command, argv, options] = native.spawn.mock.calls[0];
    expect(command).toBe("fixture.exe");
    expect(argv).toEqual(args);
    expect(options.env.FIXTURE).toBe("value");
    expect(addon.jobAssign).toHaveBeenCalledWith({ job: JOB.name }, child.pid, 220);
    expect(addon.jobCreate.mock.invocationCallOrder[0]).toBeLessThan(native.spawn.mock.invocationCallOrder[0]!);
    expect(addon.jobClose).not.toHaveBeenCalled();
    // the CLI's exit closes the server's handle, which ends anything it left in the job (as the supervisor's exit did)
    child.emit("close", 0, null);
    expect(addon.jobClose).toHaveBeenCalledWith({ job: JOB.name });
  });

  it("a job that cannot be created refuses the run before any CLI starts", () => {
    addon.jobCreate.mockImplementation(() => { throw Object.assign(new Error("exists"), { code: "EEXIST" }); });
    expect(() => spawnCli("fixture.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, JOB)).toThrow(/memory maintenance was not started: EEXIST/);
    expect(native.spawn).not.toHaveBeenCalled();
  });

  it("a failed assignment closes the job; the addon has already ended the CLI with the refusal code", () => {
    addon.jobAssign.mockReturnValue(false);
    spawnCli("fixture.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, JOB);
    expect(addon.jobClose).toHaveBeenCalledOnce();
  });

  // Astra nops #3(a): an OpenProcess or AssignProcessToJobObject failure must never leave the CLI running outside its job.
  it.each([["the addon answers false (OpenProcess or assignment failed)", (): boolean => false], ["the addon throws", (): boolean => { throw new Error("EACCES"); }]] as const)(
    "a CLI that could not be put in its job is ended at once, gets no byte on stdin and the run is refused: %s", (_case, assign) => {
      addon.jobAssign.mockImplementation(assign);
      const written: string[] = [];
      (child.stdin as PassThrough).on("data", (chunk: Buffer) => written.push(chunk.toString()));
      const owned = spawnCli("fixture.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, JOB);
      expect(child.kill).toHaveBeenCalledOnce();
      expect(cliJobRefused(owned)).toBe(true);
      expect(addon.jobClose).toHaveBeenCalledOnce();
      try { owned.stdin.write("sensitive prompt"); } catch { /* destroyed */ }
      expect(owned.stdin.destroyed).toBe(true);
      expect(written).toEqual([]);
    });

  it("an assigned CLI is not refused, and is never killed by the spawn", () => {
    const owned = spawnCli("fixture.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, JOB);
    expect(cliJobRefused(owned)).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });

  // MurageMain ruling on #3(b): the spawn-to-assign window stays, but the assignment completes before the CLI's stdin gets a byte.
  it("job assignment completes before any byte reaches the CLI's stdin", () => {
    const order: string[] = [];
    addon.jobAssign.mockImplementation(() => { order.push("assign"); return true; });
    const write = (child.stdin as PassThrough).write.bind(child.stdin);
    (child.stdin as PassThrough).write = ((chunk: unknown, ...rest: unknown[]) => { order.push("stdin"); return (write as (...args: unknown[]) => boolean)(chunk, ...rest); }) as PassThrough["write"];
    native.spawn.mockImplementation(() => { order.push("spawn"); return child; });
    const owned = spawnCli("fixture.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, JOB);
    expect(order).toEqual(["spawn", "assign"]); // spawnCli returned: assigned, nothing written yet
    owned.stdin.write("prompt");
    expect(order).toEqual(["spawn", "assign", "stdin"]);
  });

  // Astra nops #4: a descendant that inherited stdout holds the root's streams (and its `close`) open.
  it("the root's exit closes the job at once, without waiting for its streams to close", () => {
    spawnCli("fixture.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, JOB);
    child.emit("exit", 0, null); // a descendant still holds stdout: no close
    expect(addon.jobClose).toHaveBeenCalledWith({ job: JOB.name });
  });

  it("stop terminates the job before waiting for the root's streams; a stdout-holding descendant cannot hold it up", async () => {
    let members = 2;
    addon.jobStop.mockImplementation(async () => { members = 0; queueMicrotask(() => child.emit("exit", null, "SIGTERM")); return { state: "present", activeProcesses: members }; });
    const owned = spawnCli("fixture.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, JOB);
    const stopped = awaitCliTreeStopped(owned);
    await vi.advanceTimersByTimeAsync(0);
    expect(addon.jobStop).toHaveBeenCalledWith(JOB.name, expect.any(Number)); // at once, no close needed
    await expect(stopped).resolves.toBe(true); // confirmed with no `close` ever emitted
  });

  it("stop is not confirmed while the job still has members", async () => {
    addon.jobStop.mockResolvedValue({ state: "present", activeProcesses: 1 });
    const owned = spawnCli("fixture.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, JOB);
    child.emit("exit", 0, null);
    await expect(awaitCliTreeStopped(owned)).resolves.toBe(false);
  });

  it.each([0, 2])("root close requires job confirmation (members=%s)", async activeProcesses => {
    addon.jobStop.mockResolvedValue({ state: "present", activeProcesses });
    const owned = spawnCli("fixture.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, JOB);
    child.emit("close", 0, null);
    expect(await awaitCliTreeStopped(owned)).toBe(activeProcesses === 0);
    expect(addon.jobStop).toHaveBeenCalledWith(JOB.name, expect.any(Number));
    expect(native.execFile).not.toHaveBeenCalled();
  });

  it("terminates the job first, then requires the root itself to have exited", async () => {
    const owned = spawnCli("fixture.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, JOB);
    const stopped = awaitCliTreeStopped(owned);
    await vi.advanceTimersByTimeAsync(0);
    expect(addon.jobStop).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledOnce(); // the root had not exited yet
    let resolved: boolean | undefined;
    void stopped.then(value => { resolved = value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBeUndefined();
    child.emit("exit", null, "SIGTERM");
    await expect(stopped).resolves.toBe(true);
  });

  it("a root that never exits is not confirmed as stopped", async () => {
    const owned = spawnCli("fixture.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, JOB);
    const stopped = awaitCliTreeStopped(owned);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(stopped).resolves.toBe(false);
  });
});
