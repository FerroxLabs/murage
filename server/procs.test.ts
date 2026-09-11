import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  assertSafeCliArgv,
  describeSpawnFailure,
  estimatedWindowsCommandLineChars,
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
