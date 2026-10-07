// Copyright 2026 Ferrox Labs
// Fixtures follow OpenClaw extensions/whatsapp reconnect.test.ts and Hermes
// scripts/whatsapp-bridge/bridge.reconnect.test.mjs (MIT, both).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  computeBackoff, createReconnectScheduler, createVersionResolver, DEFAULT_RECONNECT_POLICY, decideClose, nextReconnect, resolveReconnectPolicy,
  SECOND_515_WINDOW_MS, watchdogShouldRestart, WATCHDOG_FRAME_TIMEOUT_MS,
} from "./close-decision.ts";

const fresh = { postPairingRestarted: false, nowMs: 1_000_000 };

describe("decideClose, every row of design 2.4", () => {
  it("515 restarts once and waits for creds to persist", () => {
    expect(decideClose(515, fresh)).toMatchObject({ action: "restart-once", state: "restarting", reconnect: true, awaitCredsPersisted: true, wipeAuth: false });
  });
  it("a second 515 within 2 minutes is a retry; after 2 minutes the guard lets one more through", () => {
    const used = { postPairingRestarted: true, restartedAtMs: 1_000_000, nowMs: 1_000_000 + 60_000 };
    expect(decideClose(515, used)).toMatchObject({ action: "retry", state: "retry", reconnect: true });
    expect(decideClose(515, { ...used, nowMs: 1_000_000 + SECOND_515_WINDOW_MS })).toMatchObject({ action: "restart-once" });
    expect(decideClose(515, { postPairingRestarted: true, nowMs: 5 })).toMatchObject({ action: "retry" });
  });
  it("401 and 500 wipe the auth dir and report logged-out", () => {
    for (const code of [401, 500]) expect(decideClose(code, fresh)).toMatchObject({ action: "stop-logged-out", state: "logged-out", reconnect: false, wipeAuth: true });
  });
  it("440 is a conflict: stop, no retry, no wipe", () => {
    expect(decideClose(440, fresh)).toMatchObject({ action: "stop-conflict", state: "conflict", reconnect: false, wipeAuth: false });
  });
  it("428, 408 and 503 retry with backoff", () => {
    for (const code of [428, 408, 503]) expect(decideClose(code, fresh)).toMatchObject({ action: "retry", state: "retry", reconnect: true, wipeAuth: false });
  });
  it("403 and 411 block with their reasons", () => {
    expect(decideClose(403, fresh)).toMatchObject({ action: "stop-blocked", state: "blocked", reconnect: false, blockedReason: "forbidden" });
    expect(decideClose(411, fresh)).toMatchObject({ action: "stop-blocked", state: "blocked", reconnect: false, blockedReason: "multidevice-mismatch" });
  });
  it("an unknown or missing code retries", () => {
    expect(decideClose(undefined, fresh)).toMatchObject({ action: "retry", reconnect: true });
    expect(decideClose(999, fresh)).toMatchObject({ action: "retry", reconnect: true });
  });
});

describe("reconnect policy (OpenClaw reconnect.test)", () => {
  it("uses the documented defaults", () => {
    expect(DEFAULT_RECONNECT_POLICY).toEqual({ initialMs: 2000, maxMs: 30000, factor: 1.8, jitter: 0.25, maxAttempts: 12 });
  });
  it("resolves sane values with clamps", () => {
    const policy = resolveReconnectPolicy({ initialMs: 100, maxMs: 5, factor: 20, jitter: 2, maxAttempts: -1 });
    expect(policy.initialMs).toBe(250);
    expect(policy.maxMs).toBeGreaterThanOrEqual(policy.initialMs);
    expect(policy.factor).toBeLessThanOrEqual(10);
    expect(policy.jitter).toBeLessThanOrEqual(1);
    expect(policy.maxAttempts).toBeGreaterThanOrEqual(0);
  });
  it("computes increasing backoff, capped, with jitter only adding", () => {
    const flat = { ...DEFAULT_RECONNECT_POLICY, jitter: 0 };
    expect(computeBackoff(flat, 1)).toBe(2000);
    expect(computeBackoff(flat, 2)).toBe(3600);
    expect(computeBackoff(flat, 3)).toBe(6480);
    expect(computeBackoff(flat, 20)).toBe(30000);
    expect(computeBackoff(DEFAULT_RECONNECT_POLICY, 1, () => 1)).toBe(2500);
    expect(computeBackoff(DEFAULT_RECONNECT_POLICY, 1_016)).toBe(30000);
  });
  it("blocks with retry-limit after 12 attempts", () => {
    expect(nextReconnect(1, DEFAULT_RECONNECT_POLICY, () => 0)).toEqual({ kind: "wait", attempt: 1, delayMs: 2000 });
    expect(nextReconnect(12, DEFAULT_RECONNECT_POLICY, () => 0)).toMatchObject({ kind: "wait", attempt: 12 });
    expect(nextReconnect(13)).toEqual({ kind: "blocked", reason: "retry-limit" });
  });
});

describe("watchdog", () => {
  it("restarts only a connected socket that has been frame-silent for 3 minutes", () => {
    expect(watchdogShouldRestart("connected", 0, WATCHDOG_FRAME_TIMEOUT_MS - 1)).toBe(false);
    expect(watchdogShouldRestart("connected", 0, WATCHDOG_FRAME_TIMEOUT_MS)).toBe(true);
    expect(watchdogShouldRestart("retry", 0, WATCHDOG_FRAME_TIMEOUT_MS * 5)).toBe(false);
    expect(watchdogShouldRestart("linking", 0, WATCHDOG_FRAME_TIMEOUT_MS * 5)).toBe(false);
  });
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("createReconnectScheduler (Hermes bridge.reconnect.test)", () => {
  it("reschedules a rejecting start at the retry delay and stops after a success", async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const logs: string[] = [];
    let attempts = 0;
    const schedule = createReconnectScheduler(async () => { attempts += 1; if (attempts === 1) throw new Error("boom"); }, {
      retryDelayMs: 5000, log: (line) => logs.push(line), setTimeoutFn: (fn, ms) => timers.push({ fn, ms }),
    });
    schedule(3000);
    expect(timers.map((t) => t.ms)).toEqual([3000]);
    timers[0].fn();
    await tick(); await tick();
    expect(attempts).toBe(1);
    expect(logs[0]).toMatch(/Reconnect failed \(boom\)/);
    expect(timers.map((t) => t.ms)).toEqual([3000, 5000]);
    timers[1].fn();
    await tick(); await tick();
    expect(attempts).toBe(2);
    expect(timers).toHaveLength(2);
  });
  it("contains a synchronous throw the same way", async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const logs: string[] = [];
    const schedule = createReconnectScheduler(() => { throw new Error("sync boom"); }, { retryDelayMs: 1000, log: (l) => logs.push(l), setTimeoutFn: (fn, ms) => timers.push({ fn, ms }) });
    schedule(0);
    timers[0].fn();
    await tick(); await tick();
    expect(logs[0]).toMatch(/sync boom/);
    expect(timers).toHaveLength(2);
  });
});

describe("createVersionResolver (Hermes bridge.reconnect.test)", () => {
  it("returns and caches a successful fetch", async () => {
    const resolve = createVersionResolver(async () => ({ version: [2, 3000, 99] }), { log: () => undefined });
    expect(await resolve()).toEqual([2, 3000, 99]);
  });
  it("bounds a fetch that never settles and yields null before any success", async () => {
    const logs: string[] = [];
    const resolve = createVersionResolver(() => new Promise<{ version: number[] }>(() => undefined), { timeoutMs: 20, log: (l) => logs.push(l) });
    expect(await resolve()).toBeNull();
    expect(logs[0]).toMatch(/timed out/);
    expect(logs[0]).toMatch(/library default/);
  });
  it("falls back to the last good version", async () => {
    const logs: string[] = [];
    let calls = 0;
    const resolve = createVersionResolver(async () => { calls += 1; if (calls === 1) return { version: [2, 3000, 42] }; throw new Error("network down"); }, { timeoutMs: 20, log: (l) => logs.push(l) });
    expect(await resolve()).toEqual([2, 3000, 42]);
    expect(await resolve()).toEqual([2, 3000, 42]);
    expect(logs[0]).toMatch(/network down/);
    expect(logs[0]).toMatch(/cached version/);
  });
  it("starts from a persisted last-good version", async () => {
    const resolve = createVersionResolver(async () => { throw new Error("offline"); }, { initial: [2, 1, 1], log: () => undefined });
    expect(await resolve()).toEqual([2, 1, 1]);
  });
});

describe("401 never restart-loops (OpenClaw b765ada174a)", () => {
  it("a remote logout stops, wipes and reports logged-out, however many times it is asked", () => {
    for (const postPairingRestarted of [false, true]) {
      const decision = decideClose(401, { postPairingRestarted, restartedAtMs: 1, nowMs: 2 });
      expect(decision).toMatchObject({ action: "stop-logged-out", state: "logged-out", reconnect: false, wipeAuth: true });
    }
  });
  it("440 is the only non-retryable close that keeps the credentials; 428 stays on retry", () => {
    expect(decideClose(440, { postPairingRestarted: false, nowMs: 0 })).toMatchObject({ reconnect: false, wipeAuth: false });
    expect(decideClose(428, { postPairingRestarted: false, nowMs: 0 })).toMatchObject({ action: "retry", reconnect: true });
  });
});

