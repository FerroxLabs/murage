// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// q1022-idlerest W-LAG-MONITOR-IDLE (HIDDEN-COST-fable M1): the turn line's 10 ms event-loop monitor was enabled at import and never
// disabled, 100 native wake-ups a second for the life of the main process. It now runs only while a turn is being prepared.
import { afterEach, expect, it, vi } from "vitest";

const monitors = vi.hoisted(() => [] as Array<{ resolution: number; enabled: boolean; enables: number }>);
vi.mock("node:perf_hooks", async original => {
  const actual = await original<typeof import("node:perf_hooks")>();
  return { ...actual, monitorEventLoopDelay: (options?: { resolution?: number }) => {
    const state = { resolution: options?.resolution ?? 10, enabled: false, enables: 0 };
    monitors.push(state);
    return { enable: () => { const was = state.enabled; state.enabled = true; state.enables++; return !was; }, disable: () => { const was = state.enabled; state.enabled = false; return was; },
      reset: () => {}, percentile: () => 0 };
  } };
});
afterEach(() => { vi.useRealTimers(); });

it("no turn: the lag monitor is off through ten idle minutes; a turn turns it on and its finish (or the idle limit) turns it off", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const { PreDispatchTimer } = await import("./turn-spans.ts");
  const mine = () => monitors.filter(m => m.resolution === 10);
  expect(mine().length, "the turn-spans monitor is the mocked one").toBe(1);
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(mine().map(m => m.enabled), "monitor enabled with no turn").toEqual(mine().map(() => false));
  const turn = new PreDispatchTimer(() => {});
  expect(mine().some(m => m.enabled), "monitor on while a turn is prepared").toBe(true);
  turn.finish();
  expect(mine().some(m => m.enabled), "monitor off once the turn line is done").toBe(false);
  // a turn that returns before its line (no finish) still leaves the monitor off after the idle limit
  new PreDispatchTimer(() => {});
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mine().some(m => m.enabled), "monitor off after an unfinished turn").toBe(false);
});
