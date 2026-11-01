// The watcher that moves the browser door when Tailscale arrives after Murage.
//
// The bug it pins (11-01): Murage opened at login before Tailscale connected,
// the door came up with no MagicDNS name, and every phone request through
// `tailscale serve` was refused until someone pressed "Check Tailscale again".
// These drive the watcher through its real interval with fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BEAT_MS,
  createLateTailscaleWatch,
  doorRouteReady,
  RECHECK_DELAYS_MS,
  SLOW_AFTER_MS,
  SLOW_DELAY_MS,
  WAKE_GAP_MS,
} from "../src/tailscale-late.ts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

function rig(initiallyWaiting = true) {
  const state = {
    waiting: initiallyWaiting,
    times: [] as number[],
    logs: [] as string[],
    fixOn: Infinity,
    throwOn: -1,
  };
  const watch = createLateTailscaleWatch({
    waiting: () => state.waiting,
    recheck: async () => {
      state.times.push(Date.now());
      if (state.times.length === state.throwOn) throw new Error("probe broke");
      if (state.times.length >= state.fixOn) state.waiting = false;
    },
    log: (line) => state.logs.push(line),
  });
  return { state, watch };
}

const run = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe("what counts as a route", () => {
  it("is a Serve front, or a socket off loopback", () => {
    expect(doorRouteReady("127.0.0.1", null)).toBe(false);
    expect(doorRouteReady(null, null)).toBe(false);
    expect(doorRouteReady("127.0.0.1", { scheme: "https", host: "m.ts.net", port: 443 })).toBe(true);
    expect(doorRouteReady("100.101.102.103", null)).toBe(true);
  });
});

describe("a door that already has a tailnet route", () => {
  it("is never rechecked and gets no timer", async () => {
    const { state, watch } = rig(false);
    watch.start();
    expect(watch.running()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await run(10 * 60_000);
    expect(state.times).toEqual([]);
    expect(state.logs).toEqual([]);
  });
});

describe("a door waiting for Tailscale", () => {
  it("rechecks on a backoff that is capped at a minute, through the real interval", async () => {
    const { state, watch } = rig();
    const start = Date.now();
    watch.start();
    expect(watch.running()).toBe(true);
    await run(5 * 60_000);
    const gaps = state.times.map((t, i) => t - (i === 0 ? start : state.times[i - 1]));
    expect(gaps.slice(0, RECHECK_DELAYS_MS.length)).toEqual([...RECHECK_DELAYS_MS]);
    expect(gaps.slice(RECHECK_DELAYS_MS.length).every((g) => g === 60_000)).toBe(true);
    expect(BEAT_MS).toBe(1_000);
    watch.stop();
  });

  it("stops for good once the door has a route", async () => {
    const { state, watch } = rig();
    state.fixOn = 2;
    watch.start();
    await run(60_000);
    expect(state.times.length).toBe(2);
    expect(watch.running()).toBe(false);
    expect(state.logs.at(-1)).toBe("browser door: Tailscale route found; rechecks stopped");
    await run(10 * 60_000);
    expect(state.times.length).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops without a recheck when the button already moved the door", async () => {
    const { state, watch } = rig();
    watch.start();
    state.waiting = false;
    await run(RECHECK_DELAYS_MS[0]);
    expect(state.times).toEqual([]);
    expect(watch.running()).toBe(false);
  });

  it("rechecks straight away after the computer wakes, and starts the backoff again", async () => {
    const { state, watch } = rig();
    watch.start();
    await run(5 * 60_000); // at the one-minute cap
    const before = state.times.length;
    // Asleep: the wall clock jumps, the timers do not run.
    vi.setSystemTime(Date.now() + WAKE_GAP_MS + 60_000);
    await run(BEAT_MS);
    expect(state.times.length).toBe(before + 1);
    await run(RECHECK_DELAYS_MS[0]);
    expect(state.times.length).toBe(before + 2);
    watch.stop();
  });

  it("slows to every ten minutes after a quarter of an hour, and a wake still checks at once", async () => {
    const { state, watch } = rig();
    const start = Date.now();
    watch.start();
    await run(60 * 60_000);
    const late = state.times.filter((t) => t - start > SLOW_AFTER_MS + 60_000);
    const lateGaps = late.slice(1).map((t, i) => t - late[i]);
    expect(lateGaps.length).toBeGreaterThanOrEqual(3);
    expect(lateGaps.every((g) => g === SLOW_DELAY_MS)).toBe(true);
    // Under a minute apart before the switch.
    const early = state.times.filter((t) => t - start < SLOW_AFTER_MS);
    expect(early.slice(1).every((t, i) => t - early[i] <= 60_000)).toBe(true);

    // Asleep in the slow phase: the next beat checks, and the quick phase is back.
    const before = state.times.length;
    vi.setSystemTime(Date.now() + WAKE_GAP_MS + 60_000);
    await run(BEAT_MS);
    expect(state.times.length).toBe(before + 1);
    await run(RECHECK_DELAYS_MS[0] + RECHECK_DELAYS_MS[1]);
    expect(state.times.length).toBe(before + 3);
    watch.stop();
  });

  it("survives a recheck that throws and keeps going", async () => {
    const { state, watch } = rig();
    state.throwOn = 1;
    state.fixOn = 2;
    watch.start();
    await run(30_000);
    expect(state.logs).toContain("browser door: Tailscale recheck failed: probe broke");
    expect(state.times.length).toBe(2);
    expect(watch.running()).toBe(false);
  });

  it("survives a throwing logger and a throwing predicate without an unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    let calls = 0;
    const watch = createLateTailscaleWatch({
      waiting: () => {
        calls += 1;
        if (calls === 2) throw new Error("predicate broke");
        return true;
      },
      recheck: async () => {},
      log: () => {
        throw new Error("logger broke");
      },
    });
    watch.start();
    await run(30_000);
    expect(watch.running()).toBe(true);
    watch.stop();
    await vi.runAllTimersAsync();
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
