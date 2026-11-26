// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owners: lane q1022-idleburn-opus owns these witnesses; observe.ts owns the loop-lag monitor and the stall watch; index.ts owns the busy
// predicate it hands to setLoopWatchBusy (the io budget's own idle test) and the startLoopLagMonitor call at listen.
//
// 1.0.22 idle burn (HIDDEN-COST-opus row 8): monitorEventLoopDelay at 20 ms resolution (its own timer, 50 wakeups a second) plus the 200 ms
// stall tick, both from listen until quit, about 55 wakeups a second with nothing to do. Counted here: every fire of an interval the monitor
// started (fake clock) plus the histogram's samples (its resolution over the time it was enabled; node:perf_hooks' histogram is replaced by a
// recorder with the same surface, so nothing else about the monitor changes).
import { afterEach, expect, it, vi } from "vitest";

const histogram = vi.hoisted(() => ({ resolution: 0, enabledAt: undefined as number | undefined, enabledMs: 0 }));
vi.mock("node:perf_hooks", async original => {
  const real = await original<typeof import("node:perf_hooks")>();
  return {
    ...real,
    monitorEventLoopDelay: (options?: { resolution?: number }) => {
      histogram.resolution = options?.resolution ?? 10;
      return {
        enable() { if (histogram.enabledAt === undefined) histogram.enabledAt = Date.now(); return true; },
        disable() { if (histogram.enabledAt !== undefined) { histogram.enabledMs += Date.now() - histogram.enabledAt; histogram.enabledAt = undefined; } return true; },
        percentile: () => 0, max: 0, reset() { /* recorder */ },
      };
    },
  };
});
// server/testing/setup.ts already loaded observe.ts (with the real perf_hooks) before this file's mock: a fresh instance is taken here
vi.resetModules();
const observe = await import("./observe.ts");

const setBusy = (read: () => boolean) => (observe as unknown as { setLoopWatchBusy?: (r?: () => boolean) => void }).setLoopWatchBusy?.(read);
// a turn's start site (index.ts) calls this; optional so the base runs reach the assertions
const wake = () => (observe as unknown as { wakeLoopWatch?: () => void }).wakeLoopWatch?.();
afterEach(() => { observe.stopLoopLagMonitor(); setBusy(() => true); observe.setObserveSink(); vi.useRealTimers(); });

/** Wakeups of the monitor's timers and histogram over `ms` of fake clock, from startLoopLagMonitor (the listen-time entry point). */
function wakeupsOver(ms: number, between?: (at: number) => void): number {
  histogram.resolution = 0; histogram.enabledAt = undefined; histogram.enabledMs = 0;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date", "performance"] });
  const fake = globalThis.setInterval;
  let fires = 0;
  globalThis.setInterval = ((fn: (...a: unknown[]) => void, every: number, ...rest: unknown[]) => fake(() => { fires++; fn(...rest); }, every)) as typeof setInterval;
  try {
    observe.startLoopLagMonitor();
    for (let at = 0; at < ms; at += 1000) { between?.(at); vi.advanceTimersByTime(1000); }
    if (histogram.enabledAt !== undefined) { histogram.enabledMs += Date.now() - histogram.enabledAt; histogram.enabledAt = Date.now(); }
    return fires + (histogram.resolution ? Math.floor(histogram.enabledMs / histogram.resolution) : 0);
  } finally { globalThis.setInterval = fake; }
}

it("W-OBSERVE-IDLE ten idle minutes: the loop monitor does not wake at all (parked; base: about 55 a second)", () => {
  setBusy(() => false);
  const wakeups = wakeupsOver(600_000);
  console.log(`[W-OBSERVE-IDLE] ${wakeups} wakeups in 600 s (${(wakeups / 600).toFixed(2)}/s)`);
  expect(wakeups).toBe(0);
});

it("W-OBSERVE-TURN a turn's start wakes the fine stall tick at once, and it parks again when the turn ends", () => {
  let busy = false;
  setBusy(() => busy);
  // idle 60 s, a turn for 60 s, idle 60 s; the turn's start calls wakeLoopWatch as index.ts's start sites do (booted: loop-watch-boot-1022)
  const wakeups = wakeupsOver(180_000, at => { const was = busy; busy = at >= 60_000 && at < 120_000; if (busy && !was) wake(); });
  const tick = observe.stallTickFor(observe.STALL_THRESHOLD_MS);
  // the turn's minute at the fine tick (60 s / tick), the idle minutes none; the histogram adds its samples in the turn only
  expect(wakeups).toBeGreaterThanOrEqual(Math.floor(59_000 / tick));
  expect(wakeups).toBeLessThanOrEqual(Math.ceil(61_000 / tick) + Math.ceil(61_000 / 200) + 2);
});

it("W-OBSERVE-STALL a block during a turn is still reported as a stall line, with the turn's fine tick (real clock)", async () => {
  const lines: string[] = [];
  observe.setObserveSink(line => lines.push(line));
  let busy = false;
  setBusy(() => busy);
  observe.startLoopLagMonitor();
  busy = true;
  wake();   // the turn's start wakes the parked watch with the fine tick
  await new Promise(r => setTimeout(r, 100));
  const end = performance.now() + observe.STALL_THRESHOLD_MS + 400;
  while (performance.now() < end) { /* the turn holds the main thread */ }
  await new Promise(r => setTimeout(r, 2 * observe.stallTickFor(observe.STALL_THRESHOLD_MS) + 100));
  const stall = lines.find(line => line.startsWith("[loop] stall blocked="));
  expect(stall, lines.join("\n")).toBeDefined();
  // measured against the fine tick: within one fine tick of the real block
  const blocked = Number(/blocked=(\d+)ms/.exec(stall!)![1]);
  expect(blocked).toBeGreaterThanOrEqual(observe.STALL_THRESHOLD_MS + 400 - observe.stallTickFor(observe.STALL_THRESHOLD_MS) - 50);
}, 20_000);
