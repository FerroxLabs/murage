// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerFirstGate, OWNER_FIRST_BACKOFF_MAX_MS, OWNER_FIRST_MAX_DEFER_MS, OWNER_INTERACTION_HOLD_MS } from "./owner-first.ts";
import { SystemLoad } from "./system-load.ts";
import { IoBudget } from "./io-budget.ts";
import { IndependentThreadRuns } from "./independent-thread-runs.ts";

afterEach(() => { vi.useRealTimers(); });

function gate(options: { overloaded?: () => boolean; random?: () => number } = {}) {
  let now = 1_000_000;
  const lines: string[] = [];
  const g = new OwnerFirstGate({ now: () => now, random: options.random ?? (() => 0.5), log: line => lines.push(line),
    load: { overloaded: options.overloaded ?? (() => false), reading: () => ({ at: now, cores: 8, load1: 12, busy: 0.97, overloaded: true, why: "load 12.0 on 8 cores" }) } });
  return { g, lines, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe("owner-first admission gate", () => {
  it("routine admission ignores starts while still yielding to owner turns, typing and load", () => {
    let overloaded = false;
    const { g, advance } = gate({ overloaded: () => overloaded });
    g.beginStart();
    const admit = () => g.admit("routine", { waitedMs: 0, ignoreStarts: true });
    expect(admit()).toEqual({ admitted: true, forced: false });
    expect(g.pressure()).toBe("work-starting");
    const endTurn = g.beginOwnerTurn();
    expect(admit()).toMatchObject({ admitted: false, reason: "owner-turn" });
    endTurn();
    g.noteOwnerInteraction();
    expect(admit()).toMatchObject({ admitted: false, reason: "owner-typing" });
    advance(OWNER_INTERACTION_HOLD_MS);
    overloaded = true;
    expect(admit()).toMatchObject({ admitted: false, reason: "system-load" });
    overloaded = false;
    expect(admit()).toEqual({ admitted: true, forced: false });
    expect(g.pressure()).toBe("work-starting");
  });

  it("admits when the owner is idle and the computer is not overloaded", () => {
    const { g, lines } = gate();
    expect(g.admit("memory-extract")).toEqual({ admitted: true, forced: false });
    expect(lines).toEqual([]);
  });

  it("defers while an owner turn runs (slot to the end of its reply) and resumes when it ends", () => {
    const { g } = gate();
    const end = g.beginOwnerTurn();
    const deferred = g.admit("memory-extract");
    expect(deferred).toMatchObject({ admitted: false, reason: "owner-turn" });
    end();
    expect(g.admit("memory-extract")).toEqual({ admitted: true, forced: false });
  });

  it("counts the owner's own sends in the run registry until they settle", () => {
    const runs = new IndependentThreadRuns<object>();
    const { g } = gate();
    g.setOwnerTurns(() => runs.ownerRunCount());
    const automation = runs.admit("bot", "t-routine", {}, [], {});
    expect(g.pressure()).toBeNull();
    const own = runs.admit("bot", "t-owner", {}, [], { ownerFirst: true });
    expect(g.pressure()).toBe("owner-turn");
    runs.settling(own);
    expect(g.pressure()).toBeNull();
    runs.release(own); runs.release(automation);
    expect(runs.ownerRunCount()).toBe(0);
  });

  it("defers while the owner types, for a few seconds after the last signal", () => {
    const { g, advance } = gate();
    g.noteOwnerInteraction();
    expect(g.admit("routine")).toMatchObject({ admitted: false, reason: "owner-typing" });
    advance(OWNER_INTERACTION_HOLD_MS + 1);
    expect(g.admit("routine").admitted).toBe(true);
  });

  it("defers while the computer is overloaded", () => {
    let hot = true;
    const { g, lines } = gate({ overloaded: () => hot });
    expect(g.admit("memory-idle")).toMatchObject({ admitted: false, reason: "system-load" });
    expect(lines[0]).toContain("load 12.0 on 8 cores");
    hot = false;
    expect(g.admit("memory-idle").admitted).toBe(true);
  });

  it("backs off exponentially with jitter, capped", () => {
    const random = vi.fn(() => 0);
    const { g } = gate({ random });
    g.beginOwnerTurn();
    const waits = Array.from({ length: 8 }, () => (g.admit("memory-extract") as { retryInMs: number }).retryInMs);
    expect(waits.slice(0, 4)).toEqual([250, 500, 1000, 2000]); // half of 500, 1000, 2000, 4000 at random()=0
    expect(Math.max(...waits)).toBeLessThanOrEqual(OWNER_FIRST_BACKOFF_MAX_MS * 1.5);
    random.mockReturnValue(0.999);
    const high = (g.admit("memory-extract") as { retryInMs: number }).retryInMs;
    expect(high).toBeGreaterThan(OWNER_FIRST_BACKOFF_MAX_MS);
  });

  it("never starves: work deferred for the bound is admitted, said in the log", () => {
    const { g, lines, advance } = gate();
    g.beginOwnerTurn(); // the owner never stops
    let admitted = false, elapsed = 0;
    while (!admitted && elapsed < OWNER_FIRST_MAX_DEFER_MS * 2) {
      const admission = g.admit("memory-extract");
      if (admission.admitted) { admitted = true; expect(admission.forced).toBe(true); break; }
      advance(admission.retryInMs); elapsed += admission.retryInMs;
    }
    expect(admitted).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(OWNER_FIRST_MAX_DEFER_MS);
    expect(elapsed).toBeLessThan(OWNER_FIRST_MAX_DEFER_MS + OWNER_FIRST_BACKOFF_MAX_MS * 1.5);
    expect(lines.some(line => line.includes("memory-extract waited 120 s"))).toBe(true);
  });

  it("a routine held back long ago is admitted at once (its bound counts from when it was first held)", () => {
    const { g } = gate();
    g.beginOwnerTurn();
    expect(g.admit("routine", { waitedMs: 5_000 }).admitted).toBe(false);
    expect(g.admit("routine", { waitedMs: OWNER_FIRST_MAX_DEFER_MS })).toEqual({ admitted: true, forced: true });
  });

  // Review finding 7: holds and the bound used Date.now, so a clock set back an hour held work for that hour.
  // Date.now is replaced BEFORE the gate exists, so a gate that reads the wall clock sees the rollback.
  function rolledBackClock() {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    return { rollBack: () => { offset = -3_600_000; }, restore: () => spy.mockRestore() };
  }
  it("a wall clock set back an hour does not extend a typing hold (monotonic time)", async () => {
    const clock = rolledBackClock();
    try {
      const g = new OwnerFirstGate({ log: () => {}, random: () => 0.5, load: { overloaded: () => false, reading: () => null } });
      g.noteOwnerInteraction(40);
      clock.rollBack();
      expect(g.admit("routine")).toMatchObject({ admitted: false, reason: "owner-typing" });
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(g.admit("routine")).toEqual({ admitted: true, forced: false });
    } finally { clock.restore(); }
  });

  it("a wall clock set back an hour does not stretch the maximum deferral (monotonic time)", async () => {
    const clock = rolledBackClock();
    try {
      const g = new OwnerFirstGate({ log: () => {}, random: () => 0.5, maxDeferMs: 40, load: { overloaded: () => false, reading: () => null } });
      g.beginOwnerTurn();
      expect(g.admit("memory-extract").admitted).toBe(false);
      clock.rollBack();
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(g.admit("memory-extract")).toEqual({ admitted: true, forced: true });
    } finally { clock.restore(); }
  });

  it("logs a kind's deferrals once per minute, not per attempt", () => {
    const { g, lines, advance } = gate();
    g.beginOwnerTurn();
    for (let i = 0; i < 40; i++) { g.admit("memory-idle"); advance(1_000); }
    expect(lines.filter(line => line.includes("memory-idle"))).toHaveLength(1);
    advance(30_000);
    g.admit("memory-idle");
    const summary = lines.filter(line => line.includes("memory-idle: deferred"));
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatch(/deferred 40 times in 60 s \(owner-turn\)/);
  });

  it("wait() resolves once the owner's turn ends, and rejects when its work is cancelled", async () => {
    vi.useFakeTimers();
    const g = new OwnerFirstGate({ log: () => {}, random: () => 0.5, load: { overloaded: () => false, reading: () => null } });
    const end = g.beginOwnerTurn();
    let done = false;
    const waiting = g.wait("memory-extract").then(result => { done = true; return result; });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(done).toBe(false);
    end();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(done).toBe(true);
    expect((await waiting).forced).toBe(false);
    const again = g.beginOwnerTurn();
    const abort = new AbortController();
    const cancelled = g.wait("memory-extract", abort.signal);
    abort.abort(new Error("stopped"));
    await expect(cancelled).rejects.toThrow("stopped");
    again();
  });
});

describe("system load", () => {
  it("is overloaded when the load average passes the core count, or when every core is busy (Windows has no load average)", () => {
    let load = [3, 0, 0], busy = 0, total = 0;
    const probe = { cores: () => 4, loadavg: () => load, cpuTimes: () => [{ busy, total }] };
    const s = new SystemLoad(probe);
    expect(s.sample().overloaded).toBe(false);
    load = [5, 0, 0];
    expect(s.sample()).toMatchObject({ overloaded: true, why: "load 5.0 on 4 cores" });
    load = [0, 0, 0]; busy += 960; total += 1000;
    expect(s.sample()).toMatchObject({ overloaded: true, why: "cpu 96% of 4 cores" });
    busy += 100; total += 1000;
    expect(s.sample().overloaded).toBe(false);
  });

  it("the I/O budget counts the whole computer's CPU, not only Murage's process", () => {
    let at = 0;
    const lines: string[] = [];
    const budget = new IoBudget({ read: () => ({ at: (at += 60_000), fsWriteBlocks: 0, cpuMicros: 0 }), log: line => lines.push(line), cpuMinutes: 2,
      systemOverloaded: () => ({ overloaded: true, why: "load 9.0 on 4 cores" }) });
    budget.tick();
    expect(budget.tick()?.tripped).toBe(false);
    expect(budget.tick()?.tripped).toBe(true);
    expect(lines[0]).toContain("computer: load 9.0 on 4 cores");
  });
});
