// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U24 (1.0.4), Windows engine stop (design: 104-lastresort-evidence/designs/U24-ENGINE-STOP.md). The OS seams are injected;
// the real job, launcher and taskkill are proven on the Windows gate box (the lane record). Covered here: the launcher's fixed
// environment and frame (R2), the taskkill cap and the route watchdog (R6), one deadline budget end to end (R7), and that
// a route answering after the stop settled arms no stray timer.
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GRACEFUL_CLOSE_TIMEOUT_MS } from "../electron/server-child-lifecycle.mjs";
import { PROVIDER_DISPOSE_BUDGET_MS, stopBudget } from "./drivers/child-teardown.ts";
import { SERVER_SHUTDOWN_TIMEOUT_MS } from "./graceful-shutdown.ts";
import {
  confirmWindowsRootClose,
  JOB_STOP_CAP_MS,
  killCliTreeWith,
  launcherEnvironment,
  launcherFrame,
  type KillCliTreeDeps,
  type StopRouteObservation,
  WINDOWS_ROOT_CLOSE_MS,
  WINDOWS_ROUTE_WATCHDOG_MS,
  WINDOWS_STOP_ROUTE_CAP_MS,
  WINDOWS_TASKKILL_CAP_MS,
} from "./procs.ts";

describe("U24 one deadline budget, end to end (R7)", () => {
  it("every inner bound sits strictly inside the next: job cap < dispose < server shutdown < Electron graceful close", () => {
    expect(JOB_STOP_CAP_MS).toBeLessThan(PROVIDER_DISPOSE_BUDGET_MS);
    expect(PROVIDER_DISPOSE_BUDGET_MS).toBeLessThan(SERVER_SHUTDOWN_TIMEOUT_MS);
    expect(SERVER_SHUTDOWN_TIMEOUT_MS).toBeLessThan(GRACEFUL_CLOSE_TIMEOUT_MS);
    // delivery on the taskkill route, fallback included, settles before Quit stops waiting
    expect(WINDOWS_TASKKILL_CAP_MS + WINDOWS_ROUTE_WATCHDOG_MS).toBeLessThanOrEqual(PROVIDER_DISPOSE_BUDGET_MS);
    expect(WINDOWS_STOP_ROUTE_CAP_MS).toBe(WINDOWS_TASKKILL_CAP_MS + WINDOWS_ROUTE_WATCHDOG_MS + WINDOWS_ROOT_CLOSE_MS);
  });

  it("an immediate stop (dispose, stopAll) waits the dispose budget on every platform; a graced Stop adds the route's cap", () => {
    expect(stopBudget(0, 5_000, "win32")).toEqual({ closeMs: 5_000, maxMs: PROVIDER_DISPOSE_BUDGET_MS });
    expect(stopBudget(0, 5_000, "darwin")).toEqual({ closeMs: 5_000, maxMs: PROVIDER_DISPOSE_BUDGET_MS });
    expect(stopBudget(5_000, 5_000, "win32")).toEqual({ closeMs: 5_000, maxMs: 5_000 + WINDOWS_STOP_ROUTE_CAP_MS });
    expect(stopBudget(5_000, 5_000, "linux")).toEqual({ closeMs: 5_000, maxMs: 10_000 });
  });
});

describe("U24 the launcher's fixed environment and frame (R2)", () => {
  it("the launcher gets nothing of the turn's: no NODE_OPTIONS, no credentials, only what the runtime needs to load", () => {
    const env = launcherEnvironment({ NODE_OPTIONS: "--require /tmp/evil.js", MURAGE_TOKEN: "secret", SystemRoot: "C:\\Windows", TEMP: "C:\\T", PATH: "C:\\x" });
    expect(env).toEqual({ ELECTRON_RUN_AS_NODE: "1", SystemRoot: "C:\\Windows", TEMP: "C:\\T" });
  });

  it("the frame carries the turn's whole environment and cwd, length-prefixed, so the CLI gets exactly what the driver built", () => {
    const frame = launcherFrame({ NODE_OPTIONS: "--max-old-space-size=100", MURAGE_TOKEN: "secret" }, "C:\\work").toString("utf8");
    const newline = frame.indexOf("\n");
    const length = Number(frame.slice(0, newline));
    const body = frame.slice(newline + 1);
    expect(Buffer.byteLength(body)).toBe(length);
    expect(JSON.parse(body)).toEqual({ env: { NODE_OPTIONS: "--max-old-space-size=100", MURAGE_TOKEN: "secret" }, cwd: "C:\\work" });
  });
});

describe("U24 the taskkill cap caps taskkill (R6)", () => {
  const fakeChild = () => ({ pid: 4242, exitCode: null, signalCode: null, kill: vi.fn(() => true) });
  const deps = (execFile: KillCliTreeDeps["execFile"]): KillCliTreeDeps => ({ platform: "win32", execFile, killProcess: () => { throw new Error("not this route"); } });

  it("taskkill runs with a timeout Node enforces and a kill signal, so a taskkill that never answers is ended at the cap", () => {
    let options: { windowsHide: boolean; timeout?: number; killSignal?: NodeJS.Signals } | undefined;
    killCliTreeWith(fakeChild(), undefined, deps((_c, _a, given) => { options = given; }));
    expect(options).toEqual({ windowsHide: true, timeout: WINDOWS_TASKKILL_CAP_MS, killSignal: "SIGKILL" });
  });

  it("a taskkill ended at the cap reports failure, the root kill goes out and delivery settles", () => {
    const seen: StopRouteObservation[] = [];
    const delivered: string[] = [];
    const child = fakeChild();
    let answer: ((error: Error | null) => void) | undefined;
    killCliTreeWith(child, (o) => seen.push(o), deps((_c, _a, _o, callback) => { answer = callback; }), () => delivered.push("delivered"));
    answer?.(Object.assign(new Error("taskkill killed at the cap"), { killed: true, signal: "SIGKILL" }));
    expect(child.kill).toHaveBeenCalledOnce();
    expect(seen.map((o) => `${o.route}:${o.result}`)).toEqual(["windows_taskkill:requested", "windows_taskkill:failed", "windows_child_kill:fallback", "windows_child_kill:succeeded"]);
    expect(delivered).toEqual(["delivered"]);
  });
});

describe("U24 confirmWindowsRootClose", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("a route that answers after the root already closed arms no timer", async () => {
    const root = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: () => true }) as unknown as ChildProcess;
    let deliver!: () => void;
    const answer = confirmWindowsRootClose(root, { closed: false }, (done) => { deliver = done; }, 5_000, 15_000);
    (root as unknown as EventEmitter).emit("close", 0, null);
    await expect(answer).resolves.toBe(true);
    deliver();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a route that never answers is settled by the watchdog, which sends the root kill: the close budget starts at cap + watchdog and the answer is false at the route cap", async () => {
    const kill = vi.fn(() => true);
    const root = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill }) as unknown as ChildProcess;
    const owned = { closed: false } as { closed: boolean; delivering?: Promise<void>; deliveredAt?: number };
    const answer = confirmWindowsRootClose(root, owned, () => { /* taskkill never calls back */ });
    let resolved: boolean | undefined;
    void answer.then((value) => { resolved = value; });
    await vi.advanceTimersByTimeAsync(WINDOWS_TASKKILL_CAP_MS + WINDOWS_ROUTE_WATCHDOG_MS - 1);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(kill).toHaveBeenCalledOnce(); // the watchdog's root kill went out before the close budget started
    expect(owned.delivering).toBeUndefined(); // delivery settled by the watchdog, a retry is not stuck behind it
    expect(typeof owned.deliveredAt).toBe("number");
    expect(resolved).toBeUndefined();
    await vi.advanceTimersByTimeAsync(WINDOWS_ROOT_CLOSE_MS);
    expect(resolved).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
