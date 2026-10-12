// SPDX-License-Identifier: AGPL-3.0-or-later
// F19, A21: sixty routines due at the top of the hour. Install-wide cap, a spread over the minute, owner first,
// an indexed due time, and every run started exactly once.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoutineManager, type RoutineManagerOptions } from "./routines.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const START = new Date(2026, 9, 10, 8, 59, 0).getTime();
const TOP = START + 60_000; // 9:00

function fleet(extra: Partial<RoutineManagerOptions> = {}, file?: string) {
  let now = START;
  const started: Array<{ botId: string; threadId: string }> = [];
  let task = 0;
  const options: RoutineManagerOptions = {
    file: file ?? join((() => { const dir = mkdtempSync(join(tmpdir(), "murage-burst-")); dirs.push(dir); return dir; })(), "routines.json"),
    now: () => now,
    botState: () => "ready",
    createTask: () => ({ threadId: `thread-${file ? "b" : "a"}-${++task}` }),
    startTurn: async (botId, threadId) => { started.push({ botId, threadId }); },
    ...extra,
  };
  const manager = new RoutineManager(options);
  return { manager, options, started, setNow: (value: number) => { now = value; }, now: () => now };
}
function addRoutines(manager: RoutineManager, count: number, anchorAt = TOP) {
  return Array.from({ length: count }, (_, index) => manager.create({
    name: `Hourly ${index}`, prompt: `Report ${index}`, botId: `bot-${index % 30}`, target: "bot", runOn: "ember", enabled: true,
    schedule: { type: "interval", everyMinutes: 60, anchorAt },
  }));
}
const runsPerRoutine = (manager: RoutineManager) => {
  const counts = new Map<string, number>();
  for (const run of manager.listRuns()) counts.set(run.routineId, (counts.get(run.routineId) ?? 0) + 1);
  return counts;
};

describe("routine bursts at the top of the hour", () => {
  it("caps automatic runs install-wide: the rest stay queued in order and start as runs finish, each exactly once", async () => {
    // aging off: this is the plain cap (aging past the cap has its own test below)
    const h = fleet({ maxConcurrentAutomaticRuns: 4, automaticAgingMs: Infinity });
    const routines = addRoutines(h.manager, 60);
    expect(routines.every(routine => routine.nextRunAt === TOP)).toBe(true);
    h.setNow(TOP);
    await h.manager.tick();
    expect(h.started).toHaveLength(4);
    expect(h.manager.listRuns().filter(run => run.status === "queued")).toHaveLength(56);
    // nothing more while all four still run
    await h.manager.tick();
    expect(h.started).toHaveLength(4);
    for (let round = 0; round < 40 && h.started.length < 60; round++) {
      const running = h.manager.listRuns().filter(run => run.status === "running");
      expect(running.length).toBeLessThanOrEqual(4);
      for (const run of running.slice(0, 2)) h.manager.failThread(run.threadId!, "done for the test");
      h.setNow(h.now() + 10_000);
      await h.manager.tick();
    }
    expect(h.started).toHaveLength(60);
    expect(new Set(h.started.map(start => start.threadId)).size).toBe(60);
    expect([...runsPerRoutine(h.manager).values()].every(count => count === 1)).toBe(true);
    expect(h.manager.listRuns().filter(run => run.status === "missed")).toHaveLength(0);
  });

  it("spreads on-time runs over the minute: each routine at its own fixed offset, none twice, none missed", async () => {
    const h = fleet({ dispatchStaggerMs: 60_000 });
    addRoutines(h.manager, 60);
    const perTick: number[] = [];
    for (let at = TOP; at <= TOP + 70_000; at += 10_000) {
      h.setNow(at);
      const before = h.started.length;
      await h.manager.tick();
      perTick.push(h.started.length - before);
    }
    expect(h.started).toHaveLength(60);
    expect(Math.max(...perTick)).toBeLessThanOrEqual(20);
    expect(perTick.filter(count => count > 0).length).toBeGreaterThanOrEqual(5);
    expect([...runsPerRoutine(h.manager).values()].every(count => count === 1)).toBe(true);
    // the offset is a pure function of the routine id and the window
    expect(RoutineManager.staggerOffset("routine-a", 60_000)).toBe(RoutineManager.staggerOffset("routine-a", 60_000));
    expect(RoutineManager.staggerOffset("routine-a", 0)).toBe(0);
  });

  it("a restart in the middle of the spread starts the rest once, never a second copy", async () => {
    const first = fleet({ dispatchStaggerMs: 60_000 });
    addRoutines(first.manager, 30);
    first.setNow(TOP + 20_000);
    await first.manager.tick();
    const early = first.started.length;
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(30);
    first.manager.stop();
    // the app restarts 30 s later from the same file
    const second = fleet({ dispatchStaggerMs: 60_000 }, first.options.file);
    second.setNow(TOP + 50_000);
    await second.manager.tick();
    second.setNow(TOP + 70_000);
    await second.manager.tick();
    expect(early + second.started.length).toBe(30);
    expect([...runsPerRoutine(second.manager).values()].every(count => count === 1)).toBe(true);
  });

  it("waits for the owner (owner-first gate) and keeps the run queued, not missed", async () => {
    let ownerBusy = true;
    const asked: number[] = [];
    const h = fleet({ admitAutomatic: run => { asked.push(run.scheduledFor); return !ownerBusy; } });
    addRoutines(h.manager, 5);
    h.setNow(TOP);
    await h.manager.tick();
    expect(h.started).toHaveLength(0);
    expect(asked.every(at => at === TOP)).toBe(true);
    expect(h.manager.listRuns().filter(run => run.status === "queued")).toHaveLength(5);
    h.setNow(TOP + 10_000);
    await h.manager.tick();
    expect(h.started).toHaveLength(0);
    ownerBusy = false;
    h.setNow(TOP + 20_000);
    await h.manager.tick();
    expect(h.started).toHaveLength(5);
    expect([...runsPerRoutine(h.manager).values()].every(count => count === 1)).toBe(true);
  });

  it("manual runs are the owner's own: neither capped nor held", async () => {
    const h = fleet({ maxConcurrentAutomaticRuns: 1, admitAutomatic: () => false });
    const [a, b] = addRoutines(h.manager, 2, TOP + 3_600_000);
    h.manager.runNow(a!.id); h.manager.runNow(b!.id);
    await h.manager.tick();
    expect(h.started).toHaveLength(2);
  });

  it("the indexed due time follows edits: a routine created or moved earlier after a tick still runs on time", async () => {
    const h = fleet();
    const [late] = addRoutines(h.manager, 1, TOP + 3_600_000);
    await h.manager.tick(); // remembers 10:00 as the fleet's earliest due time
    const [early] = addRoutines(h.manager, 1, TOP);
    h.manager.update(late!.id, { schedule: { type: "interval", everyMinutes: 60, anchorAt: TOP + 30_000 } });
    h.setNow(TOP);
    await h.manager.tick();
    expect(h.manager.listRuns().map(run => run.routineId)).toEqual([early!.id]);
    h.setNow(TOP + 30_000);
    await h.manager.tick();
    expect(new Set(h.manager.listRuns().map(run => run.routineId))).toEqual(new Set([early!.id, late!.id]));
  });
  // Review finding 3: dispatch walked the runs newest first, so fresh arrivals took every freed place under the cap
  // while older queued runs waited indefinitely.
  it("the cap serves the oldest queued run first: newer arrivals never starve older ones", async () => {
    const h = fleet({ maxConcurrentAutomaticRuns: 2, automaticAgingMs: Infinity });
    // two runs hold the cap when the two older runs come due at 9:00
    addRoutines(h.manager, 2, TOP - 30_000);
    h.setNow(TOP - 30_000);
    await h.manager.tick();
    expect(h.started).toHaveLength(2);
    const [old1, old2] = addRoutines(h.manager, 2, TOP);
    h.setNow(TOP);
    await h.manager.tick();
    expect(h.manager.listRuns().filter(run => run.status === "queued").map(run => run.routineId).sort()).toEqual([old1!.id, old2!.id].sort());
    const startedRoutines = () => h.manager.listRuns().filter(run => run.startedAt !== undefined).map(run => run.routineId);
    for (const run of h.manager.listRuns().filter(run => run.status === "running")) h.manager.failThread(run.threadId!, "done for the test");
    let at = TOP + 60_000;
    for (let round = 0; round < 35; round++) {
      // two newer routines come due every simulated minute
      for (let k = 0; k < 2; k++) h.manager.create({ name: `New ${round}.${k}`, prompt: "new", botId: `bot-n${round}-${k}`, target: "bot", runOn: "ember", enabled: true,
        schedule: { type: "once", at } });
      h.setNow(at);
      await h.manager.tick();
      if (round === 0) expect(h.manager.listRuns().filter(run => run.status === "running").map(run => run.routineId).sort()).toEqual([old1!.id, old2!.id].sort());
      for (const run of h.manager.listRuns().filter(run => run.status === "running")) h.manager.failThread(run.threadId!, "done for the test");
      at += 60_000;
    }
    expect(startedRoutines()).toEqual(expect.arrayContaining([old1!.id, old2!.id]));
    // and the arrivals are served in order of arrival too: nothing older than the newest started run is left queued
    const queued = h.manager.listRuns().filter(run => run.status === "queued");
    const newestStart = Math.max(...h.manager.listRuns().filter(run => run.startedAt !== undefined).map(run => run.scheduledFor));
    expect(queued.every(run => run.scheduledFor >= newestStart)).toBe(true);
  });

  it("a run held back past the aging bound gets past the cap (up to twice the cap), and the gate is told how long it waited", async () => {
    const waited: number[] = [];
    const h = fleet({ maxConcurrentAutomaticRuns: 1, automaticAgingMs: 120_000, admitAutomatic: (_run, waitedMs) => { waited.push(waitedMs); return true; } });
    const [first] = addRoutines(h.manager, 1, TOP);
    h.setNow(TOP);
    await h.manager.tick();
    expect(h.started).toHaveLength(1); // first runs, and never finishes in this test
    const [second] = addRoutines(h.manager, 1, TOP + 10_000);
    h.setNow(TOP + 10_000);
    await h.manager.tick();
    expect(h.started).toHaveLength(1);
    h.setNow(TOP + 10_000 + 119_000);
    await h.manager.tick();
    expect(h.started).toHaveLength(1);
    h.setNow(TOP + 10_000 + 120_000);
    await h.manager.tick();
    expect(h.started).toHaveLength(2);
    expect(waited.at(-1)).toBe(120_000);
    expect(h.manager.listRuns().filter(run => run.status === "running").map(run => run.routineId).sort()).toEqual([first!.id, second!.id].sort());
    // a third run, also aged, finds twice the cap taken and waits
    addRoutines(h.manager, 1, TOP + 140_000);
    h.setNow(TOP + 140_000); await h.manager.tick();
    h.setNow(TOP + 400_000); await h.manager.tick();
    expect(h.started).toHaveLength(2);
  });

  // Round 2: the 120 s is elapsed time. A Mac asleep moves the wall clock and not the monotonic one; a relaunch must not reset it.
  it("sleep counts toward the aging bound (the wall clock moved while the monotonic clock did not)", async () => {
    const waited: number[] = [];
    let mono = 0;
    const h = fleet({ maxConcurrentAutomaticRuns: 1, automaticAgingMs: 120_000, monotonicNow: () => mono, admitAutomatic: (_run, waitedMs) => { waited.push(waitedMs); return true; } });
    addRoutines(h.manager, 1, TOP);
    h.setNow(TOP); await h.manager.tick();
    expect(h.started).toHaveLength(1);
    addRoutines(h.manager, 1, TOP + 10_000);
    h.setNow(TOP + 10_000); mono += 10_000; await h.manager.tick();
    expect(h.started).toHaveLength(1);
    h.setNow(TOP + 10_000 + 200_000); mono += 1_000; // the lid was closed for 200 s
    await h.manager.tick();
    expect(h.started).toHaveLength(2);
    expect(waited.at(-1)).toBeGreaterThanOrEqual(120_000);
  });

  it("a wall clock set back adds nothing, and the monotonic wait still counts", async () => {
    let mono = 0;
    const h = fleet({ maxConcurrentAutomaticRuns: 1, automaticAgingMs: 120_000, monotonicNow: () => mono });
    addRoutines(h.manager, 1, TOP);
    h.setNow(TOP); await h.manager.tick();
    addRoutines(h.manager, 1, TOP + 10_000);
    h.setNow(TOP + 10_000); mono += 10_000; await h.manager.tick();
    h.setNow(TOP - 3_600_000); mono += 119_000; await h.manager.tick(); // an hour back
    expect(h.started).toHaveLength(1);
    h.setNow(TOP - 3_600_000 + 1_500); mono += 1_500; await h.manager.tick();
    expect(h.started).toHaveLength(2);
  });

  it("a relaunch keeps the wait a queued run had, short of the aging bound", async () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-burst-")); dirs.push(dir);
    const file = join(dir, "routines.json");
    let now = START;
    const base = (waits: number[]): RoutineManagerOptions => ({ file, now: () => now, botState: () => "ready", createTask: () => ({ threadId: "t" }), startTurn: async () => {},
      maxConcurrentAutomaticRuns: 4, automaticAgingMs: 120_000, admitAutomatic: (_run, waitedMs) => { waits.push(waitedMs); return false; } });
    const first: number[] = [];
    const a = new RoutineManager(base(first));
    addRoutines(a, 1, TOP);
    now = TOP; await a.tick();
    now = TOP + 100_000; await a.tick();
    expect(first.at(-1)).toBe(100_000);
    now = TOP + 105_000; // the app was quit and opened again
    const second: number[] = [];
    const b = new RoutineManager(base(second));
    await b.tick();
    expect(second[0]).toBeGreaterThanOrEqual(100_000);
    expect(second[0]).toBeLessThan(120_000);
  });

  // Review finding 4: projectRoutine() delivered and continued before the cap and the owner-first gate.
  it("project routines ask the gate and the cap before delivery, and active project work counts against the cap", async () => {
    let admit = false, projectActive = 0;
    const asked: string[] = [];
    const delivered: string[] = [];
    const h = fleet({ maxConcurrentAutomaticRuns: 2, goalState: () => "ready", activeProjectRoutineRuns: () => projectActive,
      admitAutomatic: run => { asked.push(run.id); return admit; },
      projectRoutine: run => { delivered.push(run.id); projectActive++; return { threadId: "project-chat" }; } });
    for (let index = 0; index < 5; index++) h.manager.create({ name: `Project ${index}`, prompt: "check", target: "room-goal", botId: "chief-1", groupId: "room-1",
      schedule: { type: "once", at: TOP } });
    h.setNow(TOP);
    await h.manager.tick();
    expect(delivered).toHaveLength(0);
    expect(asked.length).toBeGreaterThan(0);
    admit = true;
    h.setNow(TOP + 1_000);
    await h.manager.tick();
    expect(delivered).toHaveLength(2); // the cap: two project executions are active
    h.setNow(TOP + 2_000);
    await h.manager.tick();
    expect(delivered).toHaveLength(2);
    projectActive = 0; // the room finished them
    h.setNow(TOP + 3_000);
    await h.manager.tick();
    expect(delivered).toHaveLength(4);
  });
});
