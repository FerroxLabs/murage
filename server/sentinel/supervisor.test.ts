// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { HEALTH_LIMITS } from "../../shared/health-protocol.mjs";
import { EXIT, WatchSupervisor, allowlistedEnv, installationJitterMs, isFailedAttempt, runChildScan, scrubEnvironment, type ChildSpec } from "./supervisor.ts";

const INST = "0123456789abcdef0123456789abcdef";
const node = (code: string): ChildSpec => ({ execPath: process.execPath, args: ["-e", code], env: {} });

describe("supervised child scans", () => {
  it("kills a child still running at the wall deadline and reports it as a failed attempt", async () => {
    const started = Date.now();
    const result = await runChildScan(node("setInterval(() => {}, 1000)"), { deadlineMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(isFailedAttempt(result)).toBe(true);
    expect(Date.now() - started).toBeLessThan(HEALTH_LIMITS.scanWallMs);
  });

  it("passes a child's own exit code through; only a failure code counts as a failed attempt", async () => {
    const ok = await runChildScan(node("process.exit(0)"));
    expect(ok).toMatchObject({ code: 0, timedOut: false });
    expect(isFailedAttempt(ok)).toBe(false);
    const busy = await runChildScan(node(`process.exit(${EXIT.alreadyRunning})`));
    expect(isFailedAttempt(busy)).toBe(false);
    const failed = await runChildScan(node(`process.exit(${EXIT.failed})`));
    expect(isFailedAttempt(failed)).toBe(true);
  });

  it("reports a child that cannot start as a failed attempt instead of throwing", async () => {
    const result = await runChildScan({ execPath: "/nonexistent/murage-runtime", args: [], env: {} });
    expect(isFailedAttempt(result)).toBe(true);
  });

  it("uses the default 5 s deadline", () => {
    expect(HEALTH_LIMITS.scanWallMs).toBe(5_000);
  });
});

describe("environment", () => {
  it("passes only allowlisted variables to the child", () => {
    const env = allowlistedEnv({ HOME: "/home/owner", ANTHROPIC_API_KEY: "sk-secret", PATH: "/usr/bin", LOCALAPPDATA: "C:\\x", MURAGE_FLUX_KEY: "k" });
    expect(env).toEqual({ HOME: "/home/owner", LOCALAPPDATA: "C:\\x" });
  });

  it("scrubs credentials from the scanner's own environment", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/h", OPENAI_API_KEY: "sk", TZ: "UTC" };
    scrubEnvironment(env);
    expect(env).toEqual({ HOME: "/h", TZ: "UTC" });
  });
});

describe("watch cadence", () => {
  it("jitter is deterministic per installation and within 0..15 s", () => {
    expect(installationJitterMs(INST)).toBe(installationJitterMs(INST));
    for (let i = 0; i < 200; i++) {
      const j = installationJitterMs(i.toString(16).padStart(32, "0"));
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThanOrEqual(15_000);
    }
    expect(new Set(Array.from({ length: 50 }, (_, i) => installationJitterMs(i.toString(16).padStart(32, "a")))).size).toBeGreaterThan(1);
  });

  it("runs one scan, then schedules the next only after it ends, at 120 s plus jitter; a late timer runs one scan, no catch-up", async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    let spawned = 0;
    const results: number[] = [];
    let resolveScan: (() => void) | null = null;
    const supervisor = new WatchSupervisor({
      spec: node("process.exit(0)"), installationId: INST,
      spawnChild: spec => { spawned++; return spawn(spec.execPath, [...spec.args], { stdio: "ignore", env: spec.env }); },
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimer: () => {},
      onResult: () => { results.push(Date.now()); resolveScan?.(); },
    });
    const first = new Promise<void>(resolve => { resolveScan = resolve; });
    supervisor.start();
    supervisor.start(); // a second start while one runs adds nothing
    await first;
    await new Promise(resolve => setImmediate(resolve));
    expect(spawned).toBe(1);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(120_000 + installationJitterMs(INST));
    expect(supervisor.delayMs).toBe(HEALTH_LIMITS.scanCadenceMs + installationJitterMs(INST));
    // The host slept through many intervals: the one pending timer fires once and runs one scan.
    const second = new Promise<void>(resolve => { resolveScan = resolve; });
    timers[0]!.fn();
    await second;
    await new Promise(resolve => setImmediate(resolve));
    expect(spawned).toBe(2);
    expect(timers).toHaveLength(2);
    await supervisor.stop();
  });

  it("records failed attempts through onFailure", async () => {
    const failures: number[] = [];
    let done: () => void = () => {};
    const finished = new Promise<void>(resolve => { done = resolve; });
    const supervisor = new WatchSupervisor({
      spec: node(`process.exit(${EXIT.failed})`), installationId: INST, now: () => 42,
      setTimer: () => 1, clearTimer: () => {},
      onFailure: at => failures.push(at), onResult: () => done(),
    });
    supervisor.start();
    await finished;
    await supervisor.stop();
    expect(failures).toEqual([42]);
  });
});

describe("a watcher another scheduler replaced", () => {
  it("retires after the descriptor's revision moved on at two scans in a row, never on one that is put back", async () => {
    const owned = [true, false, true, false, false, true];
    const timers: Array<() => void> = [];
    let spawned = 0;
    let retired = 0;
    const fakeChild = () => {
      spawned++;
      const child = new EventEmitter() as EventEmitter & { pid: number; kill: () => boolean };
      child.pid = 1;
      child.kill = () => true;
      setImmediate(() => child.emit("exit", 0, null));
      return child as never;
    };
    const supervisor = new WatchSupervisor({
      spec: node("process.exit(0)"), installationId: INST, spawnChild: fakeChild,
      setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer: () => {},
      stillOwned: () => owned.shift() ?? true, onRetire: () => { retired++; },
    });
    const settle = () => new Promise(resolve => setTimeout(resolve, 10));
    supervisor.start(); await settle(); // owned: scan 1
    timers.shift()!(); await settle(); // not owned once: no scan, check again next cycle
    timers.shift()!(); await settle(); // put back: scan 2
    timers.shift()!(); await settle(); // moved on
    expect(retired).toBe(0);
    timers.shift()!(); await settle(); // moved on again: retire
    expect(retired).toBe(1);
    expect(spawned).toBe(2);
    expect(timers).toHaveLength(0);
    await supervisor.stop();
  });
});
