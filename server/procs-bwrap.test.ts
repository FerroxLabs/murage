// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  child: undefined as unknown,
  root: { pid: 72001, start: "10" }, init: { pid: 72002, start: "11" }, engine: { pid: 72003, start: "12" },
  resolved: true, initReadable: true, enginePresent: true, initGone: false, groupGone: false, failEngineTerm: false, engineMatches: true,
}));
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(), spawn: () => state.child,
}));
vi.mock("./host-power.ts", async original => ({
  ...await original<typeof import("./host-power.ts")>(),
  hostPowerTestUnwrapped: () => false,
  planHostPower: () => ({ kind: "bwrap", command: "/fixture/bwrap", args: [], argsData: Buffer.alloc(0), bpf: "/fixture/filter", bpfSha256: "fixture", env: {} }),
  openPowerFilter: () => 99, closePowerFilter: () => {},
}));
vi.mock("./bwrap-process.ts", () => ({
  hostProcessIdentity: vi.fn((pid: number) => pid === state.root.pid ? state.root : pid === state.init.pid && state.initReadable ? state.init : undefined),
  resolveBwrapProcesses: vi.fn(() => state.resolved ? { init: state.init, engine: state.enginePresent ? state.engine : undefined } : {}),
  hostProcessGone: vi.fn(() => state.initGone),
  hostProcessIsChild: vi.fn(() => state.engineMatches),
}));
import { awaitCliTreeStopped, CLI_FORCE_WAIT_MS, CLI_TERM_GRACE_MS, cliTreeConfirmedStopped, cliTreeStoppedSignal, engineProcessPid, forceCliTreeStopped, hostPowerRefused, killCliTree, spawnCli } from "./procs.ts";
import { BWRAP_STATUS_FD } from "./host-power.ts";
import { hostProcessGone, hostProcessIdentity, hostProcessIsChild, resolveBwrapProcesses } from "./bwrap-process.ts";
import { TurnTeardowns } from "./drivers/child-teardown.ts";

const signals: Array<[number, string | number | undefined]> = [];
let child: ChildProcess;
function closeWrapper() {
  state.groupGone = true;
  child.emit("exit", null, "SIGTERM");
  child.emit("close", null, "SIGTERM");
}
function launch(report = true) {
  child = spawnCli("/bin/sh", [], { stdio: ["pipe", "pipe", "pipe"] }, { hostPower: true });
  // Pin the init while the wrapper is alive, just as the real status pipe does.
  if (report) (child.stdio as unknown as PassThrough[])[BWRAP_STATUS_FD].emit("data", Buffer.from(JSON.stringify({ "child-pid": state.init.pid }) + "\n"));
  return child;
}

describe.skipIf(process.platform !== "linux")("owned Linux bwrap stop ordering (mocked processes)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(state, { resolved: true, initReadable: true, enginePresent: true, initGone: false, groupGone: false, failEngineTerm: false, engineMatches: true });
    vi.clearAllMocks();
    signals.length = 0;
    const pipes = Array.from({ length: BWRAP_STATUS_FD + 1 }, () => new PassThrough());
    state.child = Object.assign(new EventEmitter(), {
      pid: state.root.pid, exitCode: null, signalCode: null,
      stdin: pipes[0], stdout: pipes[1], stderr: pipes[2], stdio: pipes,
      kill: vi.fn(() => true),
    });
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === 0) {
        if (state.groupGone) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        return true;
      }
      signals.push([pid, signal]);
      if (state.failEngineTerm && pid === state.engine.pid) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return true;
    });
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("engine-first: keeps the wrapper for the grace, then signals its group and escalates once", async () => {
    launch();
    expect(engineProcessPid(child)).toBe(state.engine.pid); // ACP parent comparisons use this host PID
    const close = vi.fn(); child.on("close", close);
    const stopped = awaitCliTreeStopped(child);
    killCliTree(child); // join, no second engine TERM
    expect(signals).toEqual([[state.engine.pid, "SIGTERM"]]);
    state.enginePresent = false;
    await vi.advanceTimersByTimeAsync(CLI_TERM_GRACE_MS - 1);
    expect(signals).toHaveLength(1);
    expect(cliTreeConfirmedStopped(child)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals).toEqual([[state.engine.pid, "SIGTERM"], [-state.root.pid, "SIGTERM"], [-state.root.pid, "SIGKILL"]]);
    state.initGone = true;
    closeWrapper();
    expect(await stopped).toBe(true);
    expect(await forceCliTreeStopped(child)).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(signals).toHaveLength(3);
  });

  it("wrapper-first: retains ownership past close and a deadline until the namespace is gone", async () => {
    launch();
    const close = vi.fn(); child.on("close", close);
    const durable = cliTreeStoppedSignal(child);
    const stopped = awaitCliTreeStopped(child);
    closeWrapper(); // all pipes may be closed while namespace descendants are still exiting
    await vi.advanceTimersByTimeAsync(CLI_TERM_GRACE_MS + CLI_FORCE_WAIT_MS + 1);
    expect(await stopped).toBe(false);
    expect(cliTreeConfirmedStopped(child)).toBe(false);
    expect(hostPowerRefused(child)).toBe(false);
    // The vanished group must not be targeted again, even if its numeric PID is reused.
    signals.length = 0;
    state.initGone = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await durable).toBe(true);
    expect(await forceCliTreeStopped(child)).toBe(true);
    expect(signals).toEqual([]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each(["unresolved", "identity changed", "signal failed"])("falls back immediately to the existing group path when %s", async reason => {
    state.resolved = reason !== "unresolved";
    state.engineMatches = reason !== "identity changed";
    state.failEngineTerm = reason === "signal failed";
    launch();
    if (!state.resolved) expect(engineProcessPid(child)).toBeUndefined();
    const stopped = awaitCliTreeStopped(child);
    expect(signals.at(-1)).toEqual([-state.root.pid, "SIGTERM"]);
    if (reason === "identity changed") {
      expect(hostProcessIsChild).toHaveBeenCalledWith(state.engine, state.init);
      expect(signals).toEqual([[-state.root.pid, "SIGTERM"]]);
    }
    await vi.advanceTimersByTimeAsync(CLI_TERM_GRACE_MS);
    expect(signals.at(-1)).toEqual([-state.root.pid, "SIGKILL"]);
    state.initGone = true;
    closeWrapper();
    expect(await stopped).toBe(true);
  });

  it("a forced join interrupts the engine grace immediately", async () => {
    launch();
    const stopped = awaitCliTreeStopped(child);
    const forced = forceCliTreeStopped(child);
    expect(signals).toEqual([[state.engine.pid, "SIGTERM"], [-state.root.pid, "SIGKILL"]]);
    state.initGone = true;
    closeWrapper();
    expect(await stopped).toBe(true);
    expect(await forced).toBe(true);
  });

  it("a close after an expired stop attempt remains a Stop, without a launch refusal", async () => {
    launch();
    const stopped = awaitCliTreeStopped(child);
    await vi.advanceTimersByTimeAsync(CLI_TERM_GRACE_MS + CLI_FORCE_WAIT_MS + 1);
    expect(await stopped).toBe(false);
    state.initGone = true;
    closeWrapper();
    expect(await cliTreeStoppedSignal(child)).toBe(true);
    expect(hostPowerRefused(child)).toBe(false);
  });

  it("pins the host child-pid from a split status record even when the walk is unavailable", async () => {
    state.resolved = false;
    launch(false);
    const status = (child.stdio as unknown as PassThrough[])[BWRAP_STATUS_FD];
    status.emit("data", Buffer.from('{"child-pid":'));
    expect(hostProcessIdentity).not.toHaveBeenCalledWith(state.init.pid);
    status.emit("data", Buffer.from(`${state.init.pid}}\n`));
    expect(hostProcessIdentity).toHaveBeenCalledWith(state.init.pid);
    const stopped = awaitCliTreeStopped(child);
    closeWrapper();
    await vi.advanceTimersByTimeAsync(CLI_TERM_GRACE_MS + CLI_FORCE_WAIT_MS + 1);
    expect(await stopped).toBe(false);
    expect(hostProcessGone).toHaveBeenCalledWith(state.init);
    state.initGone = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cliTreeConfirmedStopped(child)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a walk that disagrees with the status-pinned init without replacing its identity", () => {
    launch();
    vi.mocked(resolveBwrapProcesses).mockReturnValueOnce({ init: { ...state.init, start: "999" }, engine: state.engine });
    expect(engineProcessPid(child)).toBeUndefined();
    expect(engineProcessPid(child)).toBe(state.engine.pid);
    expect(vi.mocked(hostProcessIdentity).mock.calls.filter(([pid]) => pid === state.init.pid)).toHaveLength(1);
  });

  it("retries an unresolved reported init after wrapper close, retaining ownership until it exits", async () => {
    state.initReadable = false;
    launch();
    const stopped = awaitCliTreeStopped(child);
    closeWrapper();
    await vi.advanceTimersByTimeAsync(CLI_TERM_GRACE_MS + CLI_FORCE_WAIT_MS + 1);
    expect(await stopped).toBe(false);
    expect(cliTreeConfirmedStopped(child)).toBe(false);
    state.initReadable = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(hostProcessGone).toHaveBeenCalledWith(state.init);
    expect(cliTreeConfirmedStopped(child)).toBe(false);
    state.initGone = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cliTreeConfirmedStopped(child)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("confirms a never-created namespace only after wrapper close and group ESRCH", async () => {
    launch(false);
    const stopped = awaitCliTreeStopped(child);
    child.emit("exit", null, "SIGTERM");
    child.emit("close", null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(100);
    expect(cliTreeConfirmedStopped(child)).toBe(false);
    state.groupGone = true;
    await vi.advanceTimersByTimeAsync(25);
    expect(await stopped).toBe(true);
    expect(hostProcessGone).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])("backs off and records the 60-second timeout while retaining ownership (init readable: %s)", async readable => {
    state.initReadable = readable;
    launch();
    const retained = new TurnTeardowns();
    retained.track("fixture-thread", "fixture-turn", child);
    const released = vi.fn();
    void retained.closed("fixture-thread", "fixture-turn").then(released);
    const observation = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    killCliTree(child, observation);
    closeWrapper();
    await vi.advanceTimersByTimeAsync(4_001);
    expect(vi.getTimerCount()).toBe(1);
    vi.mocked(hostProcessGone).mockClear();
    vi.mocked(hostProcessIdentity).mockClear();
    await vi.advanceTimersByTimeAsync(1_098); // polls at 100, 300, 700, 1500, 3100, then 5100
    expect(hostProcessGone).not.toHaveBeenCalled();
    expect(hostProcessIdentity).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(readable ? hostProcessGone : hostProcessIdentity).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(54_900);
    expect(observation).toHaveBeenCalledWith({ route: "already_exited", result: "failed", errno: "ETIMEDOUT" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(cliTreeConfirmedStopped(child)).toBe(false);
    expect(retained.pending("fixture-thread")).toBe(true);
    expect(released).not.toHaveBeenCalled();
    const timedOut = retained.wait("fixture-thread", "fixture-turn", { closeMs: 1, maxMs: 1 });
    await vi.advanceTimersByTimeAsync(1);
    expect(await timedOut).toEqual({ closeConfirmed: false, reason: "timeout" });
    // An explicit retry still confirms later and releases the same retained owner.
    state.initReadable = true;
    state.initGone = true;
    const retry = forceCliTreeStopped(child);
    await vi.advanceTimersByTimeAsync(25);
    expect(await retry).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(retained.pending("fixture-thread")).toBe(false);
    expect(released).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
