// 1.0.10 C3: sleep is not silence. A card's deadline counts awake time only,
// and the stall watchdog never reads a sleep as a quiet turn.
//
// The wall clock is driven by hand (`wall`) and the timers by vitest's fake
// timers, so both shapes of a sleep are modelled:
//   - frozen(ms): the wall clock jumps and no timer runs (a process whose timer
//     clock stopped while the machine slept: macOS, Linux);
//   - burst(ms): the wall clock jumps and every timer due in that time runs at
//     once on wake (a timer clock that kept counting: Windows).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SleepClock, wakeAwareTimeout } from "./sleep-clock.ts";
import { TurnWatchdog, type WatchedTurn } from "./turn-watchdog.ts";

const MIN = 60_000;
let wall = 0;
let clock: SleepClock;

/** Awake time: the wall clock and the timers move together, a second at a time. */
const awake = (ms: number) => {
  for (let left = ms; left > 0; left -= 1_000) {
    const step = Math.min(1_000, left);
    wall += step;
    vi.advanceTimersByTime(step);
  }
};
const frozen = (ms: number) => { wall += ms; };
const burst = (ms: number) => { wall += ms; vi.advanceTimersByTime(ms); };

beforeEach(() => {
  vi.useFakeTimers();
  wall = 1_000_000;
  clock = new SleepClock({ now: () => wall });
  clock.start();
});
afterEach(() => {
  clock.stop();
  vi.useRealTimers();
});

describe("wakeAwareTimeout", () => {
  it("runs on time when nothing slept", () => {
    const fn = vi.fn();
    wakeAwareTimeout(fn, 15 * MIN, clock);
    awake(15 * MIN - 1_000);
    expect(fn).not.toHaveBeenCalled();
    awake(1_000);
    expect(fn).toHaveBeenCalledOnce();
  });

  for (const [shape, sleep] of [["frozen timers", frozen], ["timers that kept counting", burst]] as const) {
    it(`a 15-minute deadline with 10 awake minutes and a 20-minute sleep (${shape}) runs 5 awake minutes after the wake`, () => {
      const fn = vi.fn();
      wakeAwareTimeout(fn, 15 * MIN, clock);
      awake(10 * MIN);
      sleep(20 * MIN);
      awake(1_000);
      expect(fn).not.toHaveBeenCalled();
      awake(4 * MIN);
      expect(fn).not.toHaveBeenCalled();
      // the tick interval around the freeze is counted as sleep too (one tick, 2 s): later, never earlier
      awake(MIN + 5_000);
      expect(fn).toHaveBeenCalledOnce();
    });

    it(`two sleeps in one deadline (${shape}) both stay out of its awake time`, () => {
      const fn = vi.fn();
      wakeAwareTimeout(fn, 15 * MIN, clock);
      awake(5 * MIN);
      sleep(30 * MIN);
      awake(5 * MIN);
      sleep(30 * MIN);
      awake(4 * MIN);
      expect(fn).not.toHaveBeenCalled();
      awake(2 * MIN);
      expect(fn).toHaveBeenCalledOnce();
    });

    it(`a 4-second sleep with 2 seconds left (${shape}) does not run it early`, () => {
      const fn = vi.fn();
      wakeAwareTimeout(fn, 15 * MIN, clock);
      awake(15 * MIN - 2_000);
      sleep(4_000);
      awake(1_000);
      expect(fn).not.toHaveBeenCalled();
      awake(8_000);
      expect(fn).toHaveBeenCalledOnce();
    });
  }

  it("a suspension the process ran through (Windows modern standby) is counted from suspend to resume", () => {
    const fn = vi.fn();
    wakeAwareTimeout(fn, 15 * MIN, clock);
    awake(10 * MIN);
    clock.suspend();
    awake(20 * MIN); // timers run while suspended; the deadline keeps moving itself later
    expect(fn).not.toHaveBeenCalled();
    clock.resume();
    awake(4 * MIN + 50_000);
    expect(fn).not.toHaveBeenCalled();
    awake(10_000);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("a suspend heard only after a freeze does not count the freeze twice", () => {
    awake(10_000);
    burst(20 * MIN);
    clock.suspend();
    clock.resume();
    const slept = clock.sleptMs();
    expect(slept).toBeGreaterThanOrEqual(20 * MIN);
    expect(slept).toBeLessThanOrEqual(20 * MIN + 2_000);
  });

  it("clear() stops it", () => {
    const fn = vi.fn();
    const timer = wakeAwareTimeout(fn, MIN, clock);
    timer.clear();
    awake(2 * MIN);
    expect(fn).not.toHaveBeenCalled();
  });

  it("a clock that was never started counts nothing", () => {
    const idle = new SleepClock({ now: () => wall });
    frozen(30 * MIN);
    expect(idle.sleptMs()).toBe(0);
  });
});

describe("the stall watchdog across a sleep", () => {
  const watchdogOf = (stalls: WatchedTurn[]) => new TurnWatchdog({ stallMs: 20 * MIN, checkMs: MIN, now: () => wall, slept: () => clock.sleptMs(), onStall: turn => stalls.push(turn) });

  it("a quiet turn across a 25-minute sleep is not stopped; it is stopped 20 awake minutes after its last event", () => {
    const stalls: WatchedTurn[] = [];
    const watchdog = watchdogOf(stalls);
    watchdog.watch("t", "b");
    awake(5 * MIN);
    frozen(25 * MIN);
    watchdog.sweep();
    expect(stalls).toEqual([]);
    awake(14 * MIN);
    watchdog.sweep();
    expect(stalls).toEqual([]);
    awake(2 * MIN);
    watchdog.sweep();
    expect(stalls.map(turn => turn.stalledBy)).toEqual(["silence"]);
  });

  it("a touch after the wake and before the next sweep is not pushed into the future", () => {
    const stalls: WatchedTurn[] = [];
    const watchdog = watchdogOf(stalls);
    watchdog.watch("t", "b");
    awake(MIN);
    frozen(25 * MIN);
    watchdog.touch("t");
    awake(20 * MIN + 1_000);
    watchdog.sweep();
    expect(stalls).toHaveLength(1);
  });

  it("a turn admitted after the wake is judged from its own start", () => {
    const stalls: WatchedTurn[] = [];
    const watchdog = watchdogOf(stalls);
    awake(MIN);
    frozen(25 * MIN);
    watchdog.watch("t", "b");
    awake(20 * MIN + 1_000);
    watchdog.sweep();
    expect(stalls).toHaveLength(1);
  });

  it("with no sleep it stops a quiet turn at 20 minutes, as before", () => {
    const stalls: WatchedTurn[] = [];
    const watchdog = watchdogOf(stalls);
    watchdog.watch("t", "b");
    awake(20 * MIN - 1_000);
    watchdog.sweep();
    expect(stalls).toEqual([]);
    awake(1_000);
    watchdog.sweep();
    expect(stalls).toHaveLength(1);
  });
});
