import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { ChildTeardown } from "./drivers/child-teardown.ts";

const native = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", () => native);
vi.mock("./env-path.ts", () => ({ resolveCliSpawn: (command: string, args: string[]) => ({ command, args }) }));
// The Windows job object is the engine-exclusion addon's (no PowerShell supervisor any more, murage-releases #1).
const addon = vi.hoisted(() => ({ jobCreate: vi.fn(), jobAssign: vi.fn(), jobClose: vi.fn(), jobStop: vi.fn(), processes: vi.fn() }));
// `present: false` is a build without the addon (engineJob then keeps the taskkill route).
const addonState = vi.hoisted(() => ({ present: true }));
vi.mock("./engine-exclusion.ts", () => ({
  requireWindowsAddon: () => { if (!addonState.present) throw new Error("the engine-exclusion addon is not available"); return addon; },
  loadExclusionAddon: () => (addonState.present ? addon : null),
}));
// The job launcher file (U24): the real one by default; a test can point at a missing file to simulate a build without it.
const proxyState = vi.hoisted(() => ({ launcher: "" }));
vi.mock("./proxy-paths.ts", () => ({ SPAWNED_PROXIES: { get jobLauncher() { return proxyState.launcher; } } }));
const REAL_LAUNCHER = fileURLToPath(new URL("./job-launcher.ts", import.meta.url));

import { fileURLToPath } from "node:url";
import {
  awaitCliTreeStopped, cliContainment, cliJobRefused, cliProcessPid, cliStopDelivery, cliTreeConfirmedStopped, engineJob, engineProcessPid,
  ENGINE_CONTAINMENT_CODE, forceCliTreeStopped, JOB_STOP_CAP_MS, killCliTree, launcherEnvironment, spawnCli, WINDOWS_ROUTE_WATCHDOG_MS, WINDOWS_TASKKILL_CAP_MS,
} from "./procs.ts";

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
  addonState.present = true;
  addon.processes.mockReset().mockReturnValue([]);
  proxyState.launcher = REAL_LAUNCHER;
});
/** The frame spawnCli wrote to the launcher's stdin, parsed; every byte written is collected by `written`. */
const frameOf = (written: string[]) => {
  const all = written.join("");
  const newline = all.indexOf("\n");
  const length = Number(all.slice(0, newline));
  const body = all.slice(newline + 1, newline + 1 + length);
  return { frame: JSON.parse(body) as { env: Record<string, string>; cwd: string }, after: all.slice(newline + 1 + length) };
};
const nextTick = () => new Promise<void>((resolve) => process.nextTick(resolve));
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

  // U24 design R2: the job exists first; the launcher (not the CLI) is spawned with a fixed environment and put in the job
  // while it is blocked; the CLI's argv rides after "--" and its environment in the frame, written only after assignment.
  it("creates the job first, spawns the launcher with a fixed environment, puts it in the job, then hands it the CLI's environment", () => {
    const args = ["", 'a "quoted" value', "trailing\\", "line\nnext"];
    const written: string[] = [];
    (child.stdin as PassThrough).on("data", (chunk: Buffer) => written.push(chunk.toString()));
    spawnCli("fixture.exe", args, { cwd: base, env: { FIXTURE: "value", NODE_OPTIONS: "--require evil" }, stdio: ["pipe", "pipe", "pipe"] }, JOB);
    expect(addon.jobCreate).toHaveBeenCalledWith(JOB.name);
    expect(native.spawn).toHaveBeenCalledOnce();
    const [command, argv, options] = native.spawn.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(argv).toEqual([REAL_LAUNCHER, "--", "fixture.exe", ...args]);
    expect(options.env).toEqual(launcherEnvironment());
    expect(options.env.FIXTURE).toBeUndefined();
    expect(options.env.NODE_OPTIONS).toBeUndefined();
    expect(options.cwd).toBe(base);
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe", "pipe"]);
    expect(options.windowsHide).toBe(true);
    expect(addon.jobAssign).toHaveBeenCalledWith({ job: JOB.name }, child.pid, 220);
    const { frame, after } = frameOf(written);
    expect(frame).toEqual({ env: { FIXTURE: "value", NODE_OPTIONS: "--require evil" }, cwd: base });
    expect(after).toBe("");
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
    expect(order).toEqual(["spawn", "assign", "stdin"]); // spawnCli returned: assigned, then the frame (the only write)
    owned.stdin.write("prompt");
    expect(order).toEqual(["spawn", "assign", "stdin", "stdin"]); // the prompt follows the frame in the same pipe
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

  // U24 design R5: the launcher and the CLI are members before their first instruction, so an empty job is the whole tree
  // gone; nothing is waited for after it. A root still reported alive gets the root kill, which closes the handle.
  it("an empty job confirms at once; a root not yet seen exited gets the root kill, and nothing is waited for", async () => {
    const owned = spawnCli("fixture.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, JOB);
    const stopped = awaitCliTreeStopped(owned);
    await vi.advanceTimersByTimeAsync(0);
    expect(addon.jobStop).toHaveBeenCalledOnce();
    await expect(stopped).resolves.toBe(true);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(native.execFile).not.toHaveBeenCalled();
  });

  // U24 design R5 / T5d: the first caller, a caller that joins later, and the ChildTeardown that joins on root close all read
  // false at JOB_STOP_CAP_MS; the native empty answer after the cap marks the tree stopped and releases the teardown through
  // the stopped signal, with no further Stop.
  it("T5d: root close joins the attempt, every caller reads false at the cap, and a late empty answer releases the teardown", async () => {
    let answer!: (value: { state: string; activeProcesses?: number }) => void;
    addon.jobStop.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const owned = spawnCli("fixture.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, JOB);
    const teardown = new ChildTeardown(owned); // real confirm (awaitCliTreeStopped) and real stopped signal
    const closedAt: number[] = [];
    teardown.onClosed(() => closedAt.push(Date.now()));
    const results: Array<[string, boolean]> = [];
    const first = awaitCliTreeStopped(owned); void first.then((v) => results.push(["first", v]));
    await vi.advanceTimersByTimeAsync(1_000);
    const joined = awaitCliTreeStopped(owned); void joined.then((v) => results.push(["joined", v]));
    teardown.markStopRequested();
    child.emit("close", null, "SIGTERM"); // root close: the teardown joins the attempt too
    const wait = teardown.wait({ closeMs: 5_000, maxMs: 5_000 });
    let waited: unknown; void wait.then((v) => { waited = v; });
    await vi.advanceTimersByTimeAsync(JOB_STOP_CAP_MS - 1_000); // 4.5 s after the first caller
    expect(results).toEqual([["first", false]]);
    await vi.advanceTimersByTimeAsync(1_000); // 4.5 s after the joined caller
    expect(results).toEqual([["first", false], ["joined", false]]);
    expect(teardown.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(500); // the teardown's own 5 s budget
    expect(waited).toEqual({ closeConfirmed: false, reason: "timeout" });
    expect(addon.jobStop).toHaveBeenCalledOnce(); // one attempt, joined by everyone
    await vi.advanceTimersByTimeAsync(300);
    answer({ state: "absent" }); // 6.3 s in, well after every caller's cap: the attempt was never ended
    await vi.advanceTimersByTimeAsync(0);
    expect(cliTreeConfirmedStopped(owned)).toBe(true);
    expect(teardown.closed).toBe(true);
    expect(closedAt).toHaveLength(1);
    await expect(teardown.wait({ closeMs: 5_000, maxMs: 5_000 })).resolves.toEqual({ closeConfirmed: true });
  });

  // Astra final review r2: an explicit longer deadline (a reset or dispatch caller's CLI_CALLER_DEADLINE_MS) is clamped to the cap.
  it("an explicit deadline longer than JOB_STOP_CAP_MS is clamped to it, for the first caller and for one that joins", async () => {
    addon.jobStop.mockImplementation(() => new Promise(() => {}));
    const owned = spawnCli("fixture.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, JOB);
    const results: string[] = [];
    void awaitCliTreeStopped(owned, undefined, 5_500).then((v) => results.push(`first:${v}`));
    await vi.advanceTimersByTimeAsync(500);
    void awaitCliTreeStopped(owned, undefined, 9_000).then((v) => results.push(`joined:${v}`));
    await vi.advanceTimersByTimeAsync(JOB_STOP_CAP_MS - 500);
    expect(results).toEqual(["first:false"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(results).toEqual(["first:false", "joined:false"]);
  });

  it("a job stop that never answers: every caller reads false at JOB_STOP_CAP_MS; a late empty answer still marks the tree stopped", async () => {
    let answer!: (value: { state: string; activeProcesses?: number }) => void;
    addon.jobStop.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const owned = spawnCli("fixture.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, JOB);
    const stopped = awaitCliTreeStopped(owned);
    let resolved: boolean | undefined;
    void stopped.then(value => { resolved = value; });
    await vi.advanceTimersByTimeAsync(JOB_STOP_CAP_MS - 1);
    expect(resolved).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(false);
    expect(cliTreeConfirmedStopped(owned)).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    answer({ state: "absent" });
    await vi.advanceTimersByTimeAsync(0);
    expect(cliTreeConfirmedStopped(owned)).toBe(true);
  });
});

// U24 design R2/R3: on Windows an engine turn runs on the job route (launcher first, CLI inside the job) or is refused, exactly
// as PIP is; no engine turn ever runs on the taskkill route.
describe("Windows engine job: contained or refused (U24)", () => {
  const ENGINE_NAME = /^Local\\murage-pip-eng-[0-9a-f-]{36}$/;
  const withReport = () => {
    const report = new PassThrough();
    (child as unknown as { stdio: unknown[] }).stdio = [child.stdin, child.stdout, child.stderr, report];
    return report;
  };

  it("engineJob always names a fresh job on Windows, and nothing off it", () => {
    const a = engineJob(), b = engineJob();
    expect(a).toEqual({ name: expect.stringMatching(ENGINE_NAME) });
    expect(b!.name).not.toBe(a!.name);
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
    try { expect(engineJob()).toBeUndefined(); } finally { Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" }); }
  });

  it("the engine job is created like the PIP job: the name only, no breakaway of any kind", () => {
    const job = engineJob()!;
    spawnCli("fuigo.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, job);
    expect(addon.jobCreate).toHaveBeenCalledWith(job.name);
    expect(addon.jobCreate.mock.calls[0]).toHaveLength(1);
  });

  it("the launcher is in the job before the CLI exists: the frame is written only after jobAssign succeeded; no table is read", () => {
    const order: string[] = [];
    addon.jobAssign.mockImplementation(() => { order.push("assign"); return true; });
    (child.stdin as PassThrough).on("data", () => order.push("frame"));
    native.spawn.mockImplementation(() => { order.push("spawn"); return child; });
    const owned = spawnCli("fuigo.exe", ["--acp"], { cwd: base, env: { MURAGE_TOKEN: "t" }, stdio: ["pipe", "pipe", "pipe"] }, engineJob());
    expect(order).toEqual(["spawn", "assign", "frame"]);
    expect(addon.jobAssign).toHaveBeenCalledWith(expect.anything(), child.pid, 220); // Node's own handle pins that pid
    expect(addon.processes).not.toHaveBeenCalled();
    expect(cliJobRefused(owned)).toBe(false);
    expect(cliContainment(owned)).toBe("job");
  });

  it("the launcher's report names the engine CLI; a CLI that could not start becomes an error event on the child", async () => {
    const report = withReport();
    const owned = spawnCli("fuigo.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, engineJob());
    expect(cliProcessPid(owned)).toBeUndefined();
    expect(engineProcessPid(owned)).toBe(child.pid);
    report.write('{"pid":777}\n');
    await nextTick();
    expect(cliProcessPid(owned)).toBe(777);
    expect(engineProcessPid(owned)).toBe(777); // tree probes look at the engine, not the launcher

    const errors: NodeJS.ErrnoException[] = [];
    const second = Object.assign(new EventEmitter(), { pid: child.pid! + 1, exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) }) as unknown as ChildProcess;
    const secondReport = new PassThrough();
    (second as unknown as { stdio: unknown[] }).stdio = [second.stdin, second.stdout, second.stderr, secondReport];
    native.spawn.mockReturnValue(second);
    const failed = spawnCli("missing.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, engineJob());
    failed.on("error", (error) => errors.push(error));
    secondReport.write('{"error":{"code":"ENOENT","syscall":"spawn","path":"missing.exe"}}\n');
    await nextTick();
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("ENOENT");
    expect(errors[0].syscall).toBe("spawn");
    second.emit("close", 127, null);
  });

  it("a launcher that could not be put in its job is ended, gets no frame, and the engine turn is refused with ECONTAIN; its own exit confirms it", async () => {
    addon.jobAssign.mockReturnValue(false);
    const written: string[] = [];
    (child.stdin as PassThrough).on("data", (chunk: Buffer) => written.push(chunk.toString()));
    const errors: NodeJS.ErrnoException[] = [];
    const owned = spawnCli("fuigo.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, engineJob());
    owned.on("error", (error) => errors.push(error));
    expect(child.kill).toHaveBeenCalledOnce();
    expect(addon.jobClose).toHaveBeenCalledOnce();
    expect(owned.stdin.destroyed).toBe(true);
    expect(written).toEqual([]);
    expect(native.spawn).toHaveBeenCalledOnce(); // no second, uncontained spawn
    expect(cliJobRefused(owned)).toBe(true);
    expect(cliContainment(owned)).toBe("none");
    await nextTick();
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe(ENGINE_CONTAINMENT_CODE);
    expect(errors[0].message).toContain("Restart Murage");
    expect(errors[0].message).not.toMatch(/safe|unsafe|\u2014/);
    // ownership until its exit: a refusal that stays alive is never "stopped"
    const stopped = awaitCliTreeStopped(owned);
    let resolved: boolean | undefined;
    void stopped.then((value) => { resolved = value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBeUndefined();
    child.emit("exit", 220, null);
    await expect(stopped).resolves.toBe(true);
    expect(native.execFile).not.toHaveBeenCalled();
    expect(addon.jobStop).not.toHaveBeenCalled();
  });

  // T9d: a driver tracks the refused child like any child; the thread is released only on its close.
  it("a refused launcher tracked by a ChildTeardown keeps the teardown pending until it closes", async () => {
    addon.jobAssign.mockReturnValue(false);
    const owned = spawnCli("fuigo.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, engineJob());
    owned.on("error", () => {});
    const teardown = new ChildTeardown(owned);
    teardown.markStopRequested();
    const wait = teardown.wait({ closeMs: 1_000, maxMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(wait).resolves.toEqual({ closeConfirmed: false, reason: "timeout" });
    expect(teardown.closed).toBe(false);
    child.emit("exit", 220, null);
    child.emit("close", 220, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(teardown.closed).toBe(true);
  });

  it("a refused launcher that never exits is not confirmed, and is named in the app log once it is overdue (T9b)", async () => {
    addon.jobAssign.mockReturnValue(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const owned = spawnCli("fuigo.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, engineJob());
      owned.on("error", () => {});
      const stopped = awaitCliTreeStopped(owned);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain(`refused launcher (pid ${child.pid}) is still running`);
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(stopped).resolves.toBe(false);
    } finally { warn.mockRestore(); }
  });

  it.each([
    ["no job launcher file in the build", () => { proxyState.launcher = join(base, "missing-launcher.js"); }],
    ["the job could not be created", () => { addon.jobCreate.mockImplementation(() => { throw Object.assign(new Error("exists"), { code: "EEXIST" }); }); }],
    ["no usable addon", () => { addonState.present = false; }],
  ])("%s: the engine turn is refused before anything starts, as Node reports ENOENT", async (_case, arrange) => {
    arrange();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const events: string[] = [];
      const owned = spawnCli("fuigo.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] }, engineJob());
      owned.on("error", (error: NodeJS.ErrnoException) => events.push(`error:${error.code}`));
      owned.on("exit", (code) => events.push(`exit:${code}`));
      owned.on("close", (code) => events.push(`close:${code}`));
      expect(owned.pid).toBeUndefined();
      expect(native.spawn).not.toHaveBeenCalled();
      await nextTick();
      await nextTick();
      expect(events).toEqual([`error:${ENGINE_CONTAINMENT_CODE}`, "exit:-2", "close:-2"]);
      await expect(awaitCliTreeStopped(owned)).resolves.toBe(true); // nothing started: nothing to stop
      // (1b) the exact cause reaches the app log
      expect(warn.mock.calls.map((call) => call.map(String).join(" ")).join("\n")).toContain("engine launch refused for fuigo.exe");
    } finally { warn.mockRestore(); }
  });

  it("engineJob says exactly once per server process when the build cannot contain engines, and nothing when it can", async () => {
    vi.resetModules(); // a fresh procs.ts: the once-per-process flag starts clear (the mocks stay)
    const fresh = await import("./procs.ts");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      fresh.engineJob(); fresh.engineJob();
      expect(warn).not.toHaveBeenCalled();
      addonState.present = false;
      fresh.engineJob(); fresh.engineJob(); fresh.engineJob();
      expect(warn.mock.calls.filter((call) => String(call[0]).includes("cannot be contained"))).toHaveLength(1);
    } finally { warn.mockRestore(); }
  });
});

// U24 design R4/R6: the taskkill route (non-turn Windows CLIs). One taskkill per root, ever; a taskkill that never answers is
// settled by the watchdog, which sends the root kill, so a retry is never stuck behind it.
describe("Windows taskkill route: one taskkill per root and the watchdog (U24)", () => {
  it("a repeat stop after a delivered taskkill sends the root kill only, never a second taskkill", async () => {
    const owned = spawnCli("tool.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] });
    killCliTree(owned);
    await vi.advanceTimersByTimeAsync(0);
    expect(native.execFile).toHaveBeenCalledOnce();
    expect(cliStopDelivery(owned).pending).toBeNull();
    killCliTree(owned);
    expect(native.execFile).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  // Astra final review 2: a confirmation after a delivered taskkill must not issue a second taskkill either.
  it("a confirmation after a delivered taskkill sends the root kill only: still one taskkill per root", async () => {
    const owned = spawnCli("tool.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] });
    killCliTree(owned);
    await vi.advanceTimersByTimeAsync(0);
    expect(native.execFile).toHaveBeenCalledOnce();
    const stopped = awaitCliTreeStopped(owned);
    await vi.advanceTimersByTimeAsync(0);
    expect(native.execFile).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit("close", null, "SIGTERM");
    await expect(stopped).resolves.toBe(true);
  });

  // Astra final review 3: a confirmation started with no taskkill in flight whose taskkill never calls back: the watchdog's
  // root kill goes out before the close budget starts.
  it("a confirmation whose taskkill never answers gets the watchdog's root kill at cap + watchdog, then the close budget", async () => {
    native.execFile.mockImplementation(() => {});
    const owned = spawnCli("tool.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] });
    const stopped = awaitCliTreeStopped(owned);
    await vi.advanceTimersByTimeAsync(WINDOWS_TASKKILL_CAP_MS + WINDOWS_ROUTE_WATCHDOG_MS - 1);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(cliStopDelivery(owned).pending).toBeNull();
    child.emit("close", null, "SIGTERM");
    await expect(stopped).resolves.toBe(true);
    expect(native.execFile).toHaveBeenCalledOnce();
  });

  it("a taskkill whose callback never comes: the watchdog sends the root kill and settles delivery at cap + watchdog", async () => {
    native.execFile.mockImplementation(() => {});
    const owned = spawnCli("tool.exe", [], { cwd: base, stdio: ["pipe", "pipe", "pipe"] });
    killCliTree(owned);
    expect(cliStopDelivery(owned).pending).not.toBeNull();
    await vi.advanceTimersByTimeAsync(WINDOWS_TASKKILL_CAP_MS + WINDOWS_ROUTE_WATCHDOG_MS - 1);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(cliStopDelivery(owned).pending).toBeNull();
    killCliTree(owned); // a retry: the root kill again, still one taskkill
    expect(native.execFile).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledTimes(2);
  });
});
