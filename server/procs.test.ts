import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import {
  assertSafeCliArgv,
  cliVersionReader,
  confirmWindowsRootClose,
  describeSpawnFailure,
  estimatedWindowsCommandLineChars,
  execCli,
  killCliTree,
  killCliTreeWith,
  type KillCliTreeDeps,
  type StopRouteObservation,
  WINDOWS_SAFE_COMMAND_LINE_CHARS,
} from "./procs.ts";

// Route selection and fallback ordering with injected OS seams. These mocks
// pin killCliTree's logic only; they do not establish Windows runtime
// behavior (a real taskkill check is a separate native proof).
describe("killCliTree stop-route observation", () => {
  const fakeChild = (state: { exitCode?: number | null; killResult?: boolean } = {}) => {
    const kills: unknown[] = [];
    return {
      kills,
      child: {
        pid: 4242,
        exitCode: state.exitCode ?? null,
        signalCode: null,
        kill: (signal?: NodeJS.Signals | number) => {
          kills.push(signal);
          return state.killResult ?? true;
        },
      },
    };
  };
  const errno = (code: string) => Object.assign(new Error(`private ${code} detail /Users/someone`), { code });
  const deps = (platform: NodeJS.Platform, overrides: Partial<KillCliTreeDeps> = {}): KillCliTreeDeps => ({
    platform,
    execFile: () => { throw new Error("taskkill must not run on this route"); },
    killProcess: () => { throw new Error("process.kill must not run on this route"); },
    ...overrides,
  });

  it("POSIX signals the process group and reports the request before its outcome", () => {
    const seen: StopRouteObservation[] = [];
    const signalled: unknown[] = [];
    const { child, kills } = fakeChild();
    killCliTreeWith(child, (o) => seen.push(o), deps("darwin", { killProcess: (pid, signal) => {
      signalled.push([pid, signal, seen.length]);
    } }));
    expect(signalled).toEqual([[-4242, "SIGTERM", 1]]);
    expect(seen).toEqual([
      { route: "posix_group_sigterm", result: "requested" },
      { route: "posix_group_sigterm", result: "succeeded" },
    ]);
    expect(kills).toEqual([]);
  });

  it("POSIX falls back to the owned child when the group signal fails", () => {
    const seen: StopRouteObservation[] = [];
    const { child, kills } = fakeChild();
    killCliTreeWith(child, (o) => seen.push(o), deps("linux", { killProcess: () => { throw errno("ESRCH"); } }));
    expect(seen).toEqual([
      { route: "posix_group_sigterm", result: "requested" },
      { route: "posix_group_sigterm", result: "failed", errno: "ESRCH" },
      { route: "posix_child_sigterm", result: "fallback" },
      { route: "posix_child_sigterm", result: "succeeded" },
    ]);
    expect(kills).toEqual(["SIGTERM"]);
    expect(JSON.stringify(seen)).not.toContain("someone");
  });

  it("taskkill success is reported only when its callback arrives (mocked)", () => {
    const seen: StopRouteObservation[] = [];
    let finish: ((error: Error | null) => void) | undefined;
    let argv: string[] = [];
    const { child, kills } = fakeChild();
    killCliTreeWith(child, (o) => seen.push(o), deps("win32", { execFile: (command, args, options, callback) => {
      argv = [command, ...args, String(options.windowsHide)];
      finish = callback;
    } }));
    expect(argv).toEqual(["taskkill", "/PID", "4242", "/T", "/F", "true"]);
    expect(seen).toEqual([{ route: "windows_taskkill", result: "requested" }]);
    finish?.(null);
    expect(seen.at(-1)).toEqual({ route: "windows_taskkill", result: "succeeded" });
    expect(kills).toEqual([]);
  });

  it("unavailable taskkill falls back to killing the owned child (mocked)", () => {
    const seen: StopRouteObservation[] = [];
    const { child, kills } = fakeChild({ killResult: false });
    killCliTreeWith(child, (o) => seen.push(o), deps("win32", { execFile: (_command, _args, _options, callback) => callback(errno("ENOENT")) }));
    expect(seen).toEqual([
      { route: "windows_taskkill", result: "requested" },
      { route: "windows_taskkill", result: "failed", errno: "ENOENT" },
      { route: "windows_child_kill", result: "fallback" },
      { route: "windows_child_kill", result: "failed" },
    ]);
    expect(kills).toEqual([undefined]);
  });

  // 1.0.3 Windows gate (fuigo.1): taskkill took 5.3 s to refuse with "Access denied" in a session without WMI access, the
  // fallback kill went out after that, and a close deadline counted from the request had already expired. The route reports
  // when termination has actually been delivered, so the close budget can start there.
  it("reports delivery only once taskkill answered and, on failure, the fallback kill went out (mocked)", () => {
    const order: string[] = [];
    let answer: ((error: Error | null) => void) | undefined;
    const { child } = fakeChild();
    const kill = child.kill;
    child.kill = (signal) => { order.push("fallback kill"); return kill(signal); };
    killCliTreeWith(child, undefined, deps("win32", { execFile: (_command, _args, _options, callback) => { answer = callback; } }), () => order.push("delivered"));
    expect(order).toEqual([]);
    answer?.(errno("EPERM"));
    expect(order).toEqual(["fallback kill", "delivered"]);

    const ok: string[] = [];
    let succeed: ((error: Error | null) => void) | undefined;
    killCliTreeWith(fakeChild().child, undefined, deps("win32", { execFile: (_command, _args, _options, callback) => { succeed = callback; } }), () => ok.push("delivered"));
    expect(ok).toEqual([]);
    succeed?.(null);
    expect(ok).toEqual(["delivered"]);
  });

  it("reports delivery at once for a synchronous route or an exited child", () => {
    const delivered: string[] = [];
    killCliTreeWith(fakeChild().child, undefined, deps("darwin", { killProcess: () => {} }), () => delivered.push("posix"));
    killCliTreeWith(fakeChild({ exitCode: 0 }).child, undefined, deps("win32"), () => delivered.push("exited"));
    expect(delivered).toEqual(["posix", "exited"]);
  });

  it("an exited child needs no route and touches no OS seam", () => {
    const seen: StopRouteObservation[] = [];
    const { child, kills } = fakeChild({ exitCode: 0 });
    killCliTreeWith(child, (o) => seen.push(o), deps("darwin"));
    killCliTreeWith(child, (o) => seen.push(o), deps("win32"));
    expect(seen).toEqual([
      { route: "already_exited", result: "succeeded" },
      { route: "already_exited", result: "succeeded" },
    ]);
    expect(kills).toEqual([]);
  });

  it("a throwing observer never prevents termination", () => {
    const signalled: unknown[] = [];
    const { child } = fakeChild();
    expect(() => killCliTreeWith(child, () => { throw new Error("observer bug"); }, deps("linux", {
      killProcess: (pid, signal) => { signalled.push([pid, signal]); },
    }))).not.toThrow();
    expect(signalled).toEqual([[-4242, "SIGTERM"]]);
  });

  it("keeps the existing void API for callers without an observer", () => {
    const { child } = fakeChild({ exitCode: 1 });
    expect(killCliTree(child as unknown as ChildProcess)).toBeUndefined();
  });
});

describe("Windows CLI argument safety", () => {
  it("accepts ordinary launches", () => {
    const resolved = { command: "agy.exe", args: ["--model", "gemini-3.1-pro-high"] };
    expect(estimatedWindowsCommandLineChars(resolved)).toBeLessThan(WINDOWS_SAFE_COMMAND_LINE_CHARS);
    expect(() => assertSafeCliArgv(resolved, "win32")).not.toThrow();
  });

  it("rejects a prompt-sized argv before CreateProcess can fail opaquely", () => {
    const resolved = { command: "agy.exe", args: ["--print", "x".repeat(40_000)] };
    expect(() => assertSafeCliArgv(resolved, "win32")).toThrow(
      /pass large prompts through stdin or a file/,
    );
    try {
      assertSafeCliArgv(resolved, "win32");
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ENAMETOOLONG");
    }
  });

  it("does not impose the Windows limit on other platforms", () => {
    const resolved = { command: "agy", args: ["--print", "x".repeat(40_000)] };
    expect(() => assertSafeCliArgv(resolved, "linux")).not.toThrow();
  });

  it("turns ENAMETOOLONG into an actionable message without echoing argv", () => {
    const error = Object.assign(new Error("private prompt contents"), { code: "ENAMETOOLONG" });
    const failure = describeSpawnFailure(error, "agy");
    expect(failure).toEqual({
      message: "`agy` received too much launch data for Windows; update this provider or pass its prompt through stdin/a file",
      setup: false,
    });
    expect(failure.message).not.toContain("private prompt contents");
  });
});

// 1.0.3 Windows gate: Fuigo (fuigo.1) and Codex both end a turn with taskkill /PID <engine> /T /F. In a session without WMI
// access taskkill took ~5.3 s to refuse; the fallback kill went out after that, and the engine's MCP proxies (Murage.exe
// grandchildren holding its inherited stdio) let the root close only then. A 5 s confirmation timer started at the request
// read that as "did not close after Stop".
describe("confirmWindowsRootClose", () => {
  const fakeRoot = () => new EventEmitter() as unknown as ChildProcess;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("confirms a root whose stdio closes only after a slow kill route delivered (grandchildren held the pipes until then)", async () => {
    const root = fakeRoot();
    const owned: { closed: boolean; delivering?: Promise<void>; deliveredAt?: number } = { closed: false };
    const answer = confirmWindowsRootClose(root, owned, (done) => {
      setTimeout(() => { done(); setTimeout(() => (root as unknown as EventEmitter).emit("close", 1, null), 20); }, 150);
    }, 50, 2_000);
    await expect(answer).resolves.toBe(true);
    expect(owned.delivering).toBeUndefined();
    expect(typeof owned.deliveredAt).toBe("number");
  });

  it("joins a route already in flight instead of starting a second taskkill", async () => {
    const root = fakeRoot();
    let deliver!: () => void;
    const owned = { closed: false, delivering: new Promise<void>((resolve) => { deliver = resolve; }) };
    let started = 0;
    const answer = confirmWindowsRootClose(root, owned, () => { started++; }, 50, 2_000);
    await sleep(150);
    deliver();
    await sleep(10);
    (root as unknown as EventEmitter).emit("close", 1, null);
    await expect(answer).resolves.toBe(true);
    expect(started).toBe(0);
  });

  it("stays fail-closed for a root that does not close after delivery", async () => {
    const answer = confirmWindowsRootClose(fakeRoot(), { closed: false }, (done) => done(), 50, 2_000);
    await expect(answer).resolves.toBe(false);
  });

  it("stays fail-closed when the kill route never answers, at the absolute cap", async () => {
    const answer = confirmWindowsRootClose(fakeRoot(), { closed: false }, () => {}, 20, 150);
    await expect(answer).resolves.toBe(false);
  });

  // A real process tree: the root dies, its grandchild still holds the inherited stdout, so Node's close (all stdio at EOF)
  // has not happened and the stop is not confirmed; once the grandchild is gone the close lands and confirms.
  // On Windows the root (a Node process) puts every child it starts in libuv's own KILL_ON_JOB_CLOSE job, so a plain grandchild
  // dies with the root, its handles close, and the root's close truthfully confirms. The grandchild that outlives its root (one
  // a CLI started outside that job) is the detached one: it stays in the test's job only, alive and holding the pipe.
  it("does not confirm while a live grandchild holds the root's stdio, and confirms once it is gone", async () => {
    const script = "const {spawn}=require('child_process');const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit'],detached:process.platform==='win32'});process.stdout.write(String(g.pid)+'\\n');setInterval(()=>{},1000);";
    const root = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
    const grandchild = await new Promise<number>((resolve) => root.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim()))));
    try {
      const owned = { closed: false };
      const held = await confirmWindowsRootClose(root, owned, (done) => { root.kill("SIGKILL"); done(); }, 300, 2_000);
      expect(root.exitCode !== null || root.signalCode !== null).toBe(true);
      expect(() => process.kill(grandchild, 0)).not.toThrow(); // the grandchild really outlived its root
      expect(held).toBe(false);
      const after = confirmWindowsRootClose(root, { closed: false }, (done) => { process.kill(grandchild, "SIGKILL"); done(); }, 3_000, 5_000);
      await expect(after).resolves.toBe(true);
    } finally {
      try { process.kill(grandchild, "SIGKILL"); } catch { /* gone */ }
      try { root.kill("SIGKILL"); } catch { /* gone */ }
    }
  });
});

// Upstream #3433 (2da9ee214) and 1a6f071b8: a slow --version probe never reads as "not installed".
describe("CLI version probes", () => {
  it("keeps the last version through a timed-out probe and names the timeout without one", async () => {
    const timedOut = await new Promise<Error | null>((resolve) => {
      execCli(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 200 }, (error) => resolve(error));
    });
    expect(cliVersionReader("claude")(timedOut, "")).toEqual({ reason: expect.stringContaining("took longer than 8 seconds") });
    const read = cliVersionReader("claude");
    expect(read(null, " 2.1.302\n")).toEqual({ version: "2.1.302" });
    expect(read(timedOut, "")).toEqual({ version: "2.1.302" });
    // A CLI that traps SIGTERM exits with a number after the kill: still a timeout.
    const trapped = await new Promise<Error | null>((resolve) => {
      execCli(process.execPath, ["-e", "process.on('SIGTERM', () => process.exit(1)); setInterval(() => {}, 1000)"], { timeout: 200 }, (error) => resolve(error));
    });
    expect(read(trapped, "")).toEqual({ version: "2.1.302" });
    expect(read(Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }), "")).toEqual({ reason: "`claude` CLI not found" });
    // An output overflow is a failed answer, not a slow one.
    expect(read(Object.assign(new Error("maxBuffer"), { killed: true, code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), "")).toEqual({ reason: "`claude` CLI not found" });
    // The Cloud home and pi probes mark their own timeouts as killed runs.
    expect(read(Object.assign(new Error("Cloud CLI probe timed out"), { killed: true }), "")).toEqual({ version: "2.1.302" });
    // A newer answer replaces the held one.
    expect(read(null, "2.1.400")).toEqual({ version: "2.1.400" });
    expect(read(timedOut, "")).toEqual({ version: "2.1.400" });
  }, 20_000);
});
