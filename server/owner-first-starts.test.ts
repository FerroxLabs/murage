// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.2 bgwork: background work yields while routine runs and engines are starting, not only during owner
// turns. RC1's routine burst was 26.6 s p50 late from each run's own slot: every cold engine handshake waited
// behind a main loop busy with background slices (memory-idle, checkpoints, the run save).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OwnerFirstGate, OWNER_FIRST_START_HOLD_MAX_MS } from "./owner-first.ts";
import { RoutineManager, type RoutineManagerOptions } from "./routines.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function gate() {
  let now = 5_000_000;
  const g = new OwnerFirstGate({ now: () => now, random: () => 0.5, log: () => {}, load: { overloaded: () => false, reading: () => null } });
  return { g, advance: (ms: number) => { now += ms; } };
}

describe("owner-first: routine and engine starts", () => {
  it("holds background work while a start is in flight; routine admission is not held by starts; a start lapses", () => {
    const { g, advance } = gate();
    const release = g.beginStart();
    expect(g.admit("memory-idle")).toMatchObject({ admitted: false, reason: "work-starting" });
    expect(g.admit("memory-upgrade")).toMatchObject({ admitted: false, reason: "work-starting" });
    // routines never hold each other back
    expect(g.admit("routine", { ignoreStarts: true }).admitted).toBe(true);
    release();
    expect(g.admit("memory-idle").admitted).toBe(true);
    g.beginStart(); // never released (an engine that never answers)
    advance(OWNER_FIRST_START_HOLD_MAX_MS);
    expect(g.admit("memory-idle").admitted).toBe(true);
  });

  it("a turn's start names its thread: startingThreads lists it until the release or the lapse; a routine start names none", () => {
    const { g, advance } = gate();
    const routine = g.beginStart();
    expect(g.startingThreads()).toEqual([]);
    const turn = g.beginStart("thread-a");
    g.beginStart("thread-a");
    expect(g.startingThreads()).toEqual(["thread-a"]);
    // the hold itself still stands for every other caller
    expect(g.admit("memory-idle")).toMatchObject({ admitted: false, reason: "work-starting" });
    turn(); routine();
    expect(g.startingThreads()).toEqual(["thread-a"]);
    advance(OWNER_FIRST_START_HOLD_MAX_MS);
    expect(g.startingThreads()).toEqual([]);
    expect(g.admit("memory-idle").admitted).toBe(true);
  });

  it("a narrowed caller yields only to the reasons it names", () => {
    const { g } = gate();
    const endTurn = g.beginOwnerTurn();
    expect(g.admit("memory-worker", { only: ["owner-typing", "work-starting"] }).admitted).toBe(true);
    g.noteOwnerInteraction();
    expect(g.admit("memory-worker", { only: ["owner-typing", "work-starting"] })).toMatchObject({ admitted: false, reason: "owner-typing" });
    endTurn();
  });
});

const START = new Date(2026, 9, 12, 8, 59, 0).getTime();
const TOP = START + 60_000;

function fleet(extra: Partial<RoutineManagerOptions> = {}) {
  let now = START, task = 0;
  const dir = mkdtempSync(join(tmpdir(), "murage-starts-")); dirs.push(dir);
  const options: RoutineManagerOptions = {
    file: join(dir, "routines.json"), now: () => now, botState: () => "ready",
    createTask: () => ({ threadId: `thread-${++task}` }),
    startTurn: async () => {},
    ...extra,
  };
  const manager = new RoutineManager(options);
  return { manager, setNow: (value: number) => { now = value; }, now: () => now };
}

describe("a due routine holds background work until its engine start", () => {
  it("between the due run's dispatch and its engine start no background pass is admitted", async () => {
    const { g } = gate();
    const seen: Array<{ at: string; admitted: boolean }> = [];
    let engineStarted!: () => void;
    const h = fleet({
      beginStart: () => g.beginStart(),
      admitAutomatic: (_run, waitedMs) => g.admit("routine", { waitedMs, ignoreStarts: true }).admitted,
      createTask: () => { seen.push({ at: "task", admitted: g.admit("memory-idle").admitted }); return { threadId: "thread-1" }; },
      // the engine handshake: background work is asked mid-way and must still be held
      startTurn: async () => {
        seen.push({ at: "engine", admitted: g.admit("memory-idle").admitted });
        await new Promise<void>(resolve => { engineStarted = resolve; setTimeout(resolve, 20); });
        seen.push({ at: "engine-done", admitted: g.admit("memory-idle").admitted });
      },
    });
    h.manager.create({ name: "Hourly", prompt: "Report", botId: "bot-1", target: "bot", runOn: "ember", enabled: true, schedule: { type: "interval", everyMinutes: 60, anchorAt: TOP } });
    expect(g.admit("memory-idle").admitted).toBe(true);
    h.setNow(TOP);
    await h.manager.tick();
    expect(engineStarted).toBeTypeOf("function");
    expect(seen).toEqual([{ at: "task", admitted: false }, { at: "engine", admitted: false }, { at: "engine-done", admitted: false }]);
    // started: background work goes again
    expect(g.admit("memory-idle").admitted).toBe(true);
  });

  it("sixty routines due at once each start within the per-slot budget (fake engines answer at once)", async () => {
    const { g } = gate();
    const slotOf = (id: string, scheduledFor: number) => scheduledFor + RoutineManager.staggerOffset(id, 60_000);
    let h!: ReturnType<typeof fleet>;
    const lateness: number[] = [];
    const tickMs: number[] = [];
    h = fleet({
      dispatchStaggerMs: 60_000,
      maxConcurrentAutomaticRuns: 3,
      beginStart: () => g.beginStart(),
      admitAutomatic: (_run, waitedMs) => g.admit("routine", { waitedMs, ignoreStarts: true }).admitted,
      startTurn: async (_botId, threadId) => {
        const run = h.manager.listRuns().find(item => item.threadId === threadId)!;
        lateness.push(h.now() - slotOf(run.routineId, run.scheduledFor));
        // the fake engine answers at once
        queueMicrotask(() => h.manager.handleRuntimeEvent({ eventId: threadId, provider: "fake", threadId, createdAt: new Date().toISOString(), type: "turn.completed", ok: true } as never));
      },
    });
    for (let index = 0; index < 60; index++) h.manager.create({ name: `Hourly ${index}`, prompt: `Report ${index}`, botId: `bot-${index % 30}`, target: "bot", runOn: "ember", enabled: true,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: TOP } });
    // the scheduler ticks once a second through the spread minute
    for (let at = TOP; at <= TOP + 62_000; at += 1_000) {
      h.setNow(at);
      const t0 = performance.now();
      await h.manager.tick();
      await new Promise(resolve => setImmediate(resolve));
      tickMs.push(performance.now() - t0);
    }
    expect(lateness).toHaveLength(60);
    const sorted = [...lateness].sort((a, b) => a - b);
    const p50 = sorted[29]!, p90 = sorted[53]!;
    // budget: 1 s p50 and 2 s p90 late from each run's own slot (RC1: 26.6 s and 108 s)
    expect(p50).toBeLessThanOrEqual(1_000);
    expect(p90).toBeLessThanOrEqual(2_000);
    // and the scheduler's own work per tick never holds the loop for long
    expect(Math.max(...tickMs)).toBeLessThan(250);
    expect(h.manager.listRuns().filter(run => run.status === "completed")).toHaveLength(60);
  });
});
