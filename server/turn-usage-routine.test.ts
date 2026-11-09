// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RESIDUALS-1018-B row 7 (U28b M1 + M2, U28B-astra6-r1.md): a routine's turns land in that routine's share on
// Settings, Usage even when the run is no longer live at the turn's end. M1: a project routine's run is completed once its
// room request is queued, so the room turn is found through the request's run id. M2: a cancel marks the run cancelled
// before the turn stops, and a terminal event redelivered after a failed write finds the run already completed; both use
// the routine taken while the turn ran. On the base the end-of-turn lookup alone put all three under "Not from a routine".
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoutineManager, type RoutineManagerOptions } from "./routines.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import type { RuntimeEvent } from "./contracts.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness(extra: Partial<RoutineManagerOptions> = {}) {
  let now = Date.UTC(2026, 10, 6, 9);
  const dir = mkdtempSync(join(tmpdir(), "murage-usage-routine-")); dirs.push(dir);
  let task = 0;
  const manager = new RoutineManager({
    file: join(dir, "routines.json"), now: () => now, emit: () => {}, botState: () => "ready", goalState: () => "ready",
    createTask: () => ({ threadId: `thread-${++task}` }), createGoalTask: () => ({ threadId: `goal-thread-${++task}` }),
    startTurn: async () => {}, startGoal: async () => {}, ...extra,
  } as RoutineManagerOptions);
  const due = (botId: string, name: string) => {
    const routine = manager.create({ botId, name, prompt: `Work for ${botId}`, schedule: { type: "once", at: now + 60_000 } });
    now += 120_000;
    return routine;
  };
  return { manager, due };
}
const started = (threadId: string, turnId: string) => ({ type: "turn.started", threadId, turnId, eventId: `s-${turnId}` }) as unknown as RuntimeEvent;
const completed = (threadId: string, turnId: string, extra: Record<string, unknown> = {}) =>
  ({ type: "turn.completed", threadId, turnId, eventId: `c-${turnId}`, ok: true, stopReason: "end_turn", usage: { input: 10, output: 5 }, ...extra }) as unknown as RuntimeEvent;

describe("a routine's turns stay in its Usage share when the run is no longer live at the end (U28b M1, M2)", () => {
  it("M2: a run cancelled before its turn stops still banks the stopped turn under its routine", async () => {
    const { TurnUsageRoutines } = await import("./turn-usage-routine.ts");
    const h = harness();
    const routine = h.due("bot-a", "Morning digest");
    await h.manager.tick(); await flush();
    const run = h.manager.listRuns()[0]!;
    expect(run.status).toBe("running");
    const turns = new TurnUsageRoutines(RoutineManager.usageRoutine);
    // turn.started: the handler takes the live run (index.ts handleRuntimeEvent)
    h.manager.handleRuntimeEvent(started(run.threadId!, "t1"));
    expect(turns.take(run.threadId!, "t1", () => h.manager.usageRunForThread(run.threadId!))).toEqual({ id: routine.id, name: "Morning digest" });
    // the owner's Stop: cancelRun marks the run cancelled first, then the provider stops the turn
    await h.manager.cancelRun(run.id);
    const late = h.manager.handleRuntimeEvent(completed(run.threadId!, "t1", { ok: true, stopReason: "cancelled" }));
    expect(late, "the end-of-turn lookup alone finds no live run (the base's only source)").toBeNull();
    expect(h.manager.usageRunForThread(run.threadId!)).toBeNull();
    expect(turns.take(run.threadId!, "t1", () => late)).toEqual({ id: routine.id, name: "Morning digest" });
    turns.banked(run.threadId!, "t1");
    expect(turns.size).toBe(0);
  });

  it("M2: a terminal event redelivered after a failed write (SQLITE_BUSY) banks under the same routine", async () => {
    const { TurnUsageRoutines } = await import("./turn-usage-routine.ts");
    const h = harness();
    const routine = h.due("bot-b", "Inbox sweep");
    await h.manager.tick(); await flush();
    const run = h.manager.listRuns()[0]!;
    const turns = new TurnUsageRoutines(RoutineManager.usageRoutine);
    h.manager.handleRuntimeEvent(started(run.threadId!, "t2"));
    turns.take(run.threadId!, "t2", () => h.manager.usageRunForThread(run.threadId!));
    // first delivery: the run completes, then the usage write throws, so banked() never runs
    const first = h.manager.handleRuntimeEvent(completed(run.threadId!, "t2"));
    expect(first?.status).toBe("completed");
    expect(turns.take(run.threadId!, "t2", () => first)).toEqual({ id: routine.id, name: "Inbox sweep" });
    // the redelivery: the run is no longer live, so the handler returns null
    const again = h.manager.handleRuntimeEvent(completed(run.threadId!, "t2"));
    expect(again).toBeNull();
    expect(turns.take(run.threadId!, "t2", () => again)).toEqual({ id: routine.id, name: "Inbox sweep" });
  });

  it("M1: a project routine's room turn is found through its room request's run id, though the run completed at queue time", async () => {
    const { TurnUsageRoutines, projectRoutineRunId } = await import("./turn-usage-routine.ts");
    const h = harness({ projectRoutine: () => ({ threadId: "room-thread" }) });
    const routine = h.manager.create({ botId: "lead", name: "Weekly plan", prompt: "Plan the week", target: "room-goal", groupId: "g-1",
      enabled: false, schedule: { type: "once", at: Date.UTC(2026, 10, 8, 9) } });
    const queued = h.manager.runNow(routine.id)!;
    await flush(); await h.manager.tick(); await flush();
    const run = h.manager.runById(queued.id)!;
    expect(run).toMatchObject({ status: "completed", threadId: "room-thread" });
    // the base's lookups: no live run on the room thread
    expect(h.manager.handleRuntimeEvent(started("room-thread", "t3"))).toBeNull();
    expect(h.manager.roomGoalRunForThread("room-thread")).toBeNull();
    expect(h.manager.usageRunForThread("room-thread")).toBeNull();
    // the dispatched request (project-routines.ts recordProjectRoutine) names the run in its admission key
    const request = { verb: "routine", fromKind: "routine", origin: "server", admissionKey: `routine:${run.id}` } as const;
    expect(projectRoutineRunId(request)).toBe(run.id);
    const turns = new TurnUsageRoutines(RoutineManager.usageRoutine);
    expect(turns.take("room-thread", "t3", () => null, () => h.manager.runById(projectRoutineRunId(request)!))).toEqual({ id: routine.id, name: "Weekly plan" });
    // and is kept for the turn's end
    expect(turns.take("room-thread", "t3", () => null)).toEqual({ id: routine.id, name: "Weekly plan" });
  });

  it("only a server-made project routine request names a run; any other room request names none", async () => {
    const { projectRoutineRunId } = await import("./turn-usage-routine.ts");
    const ok = { verb: "routine", fromKind: "routine", origin: "server", admissionKey: "routine:abc" } as const;
    expect(projectRoutineRunId(ok)).toBe("abc");
    for (const bad of [{ ...ok, verb: "room_turn" }, { ...ok, fromKind: "owner" }, { ...ok, origin: "bot" }, { ...ok, admissionKey: "room_turn:m1:bot" },
      { ...ok, admissionKey: "routine:" }, { ...ok, admissionKey: "routine:a:b" }, null, undefined])
      expect(projectRoutineRunId(bad as never), JSON.stringify(bad)).toBeNull();
  });

  it("a channel run never counts as a routine, a turn without an id is looked up live only, and the kept turns are capped", async () => {
    const { TurnUsageRoutines } = await import("./turn-usage-routine.ts");
    const turns = new TurnUsageRoutines(RoutineManager.usageRoutine, 3);
    expect(turns.take("th", "c1", () => ({ routineId: "r", routineName: "Telegram message", triggerSource: "channel" }))).toBeUndefined();
    expect(turns.size).toBe(0);
    expect(turns.take("th", undefined, () => ({ routineId: "r", routineName: "R", triggerSource: "schedule" }))).toEqual({ id: "r", name: "R" });
    expect(turns.size).toBe(0);
    for (const id of ["a", "b", "c", "d"]) turns.take("th", id, () => ({ routineId: id, routineName: id, triggerSource: "schedule" }));
    expect(turns.size).toBe(3);
    expect(turns.take("th", "a", () => null)).toBeUndefined(); // the oldest went first
    expect(turns.take("th", "d", () => null)).toEqual({ id: "d", name: "d" });
  });

  it("M2: a usage write that throws (SQLITE_BUSY) keeps the turn's routine for the redelivery; a write that lands forgets it", async () => {
    const { TurnUsageRoutines } = await import("./turn-usage-routine.ts");
    const turns = new TurnUsageRoutines(RoutineManager.usageRoutine);
    const live = { routineId: "r1", routineName: "Nightly", triggerSource: "schedule" as const };
    const banked: unknown[] = [];
    const busy = () => { throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 }); };
    expect(() => turns.bank("th", "t9", busy, () => live)).toThrow("database is locked");
    expect(turns.size).toBe(1);
    // the redelivery: the run already completed, so the live lookup finds none
    turns.bank("th", "t9", (routine) => banked.push(routine), () => null);
    expect(banked).toEqual([{ id: "r1", name: "Nightly" }]);
    expect(turns.size).toBe(0);
  });

  it("M1: a project routine request records its routine, so a run deleted or pruned before the room turn still names it", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { initializeProjectTables } = await import("./project-tables.ts");
    const { channelToProjectRows } = await import("./project-settings.ts");
    const { recordProjectRoutine, projectRoutineUsageRun } = await import("./project-routines.ts");
    const db = new DatabaseSync(":memory:"); initializeProjectTables(db);
    try {
      channelToProjectRows(db, { groupId: "g", leadBotId: "lead", bulletin: "", now: 1 });
      const base = { groupId: "g", threadId: "room", memberIds: ["lead"], botId: "lead", prompt: "Plan it", now: 3 };
      const withRoutine = recordProjectRoutine(db, { ...base, runId: "run-1", name: "Weekly plan", routineId: "routine-1", trigger: "schedule" });
      expect(projectRoutineUsageRun(db, "g", withRoutine.requestId)).toEqual({ routineId: "routine-1", routineName: "Weekly plan", channel: false });
      const channel = recordProjectRoutine(db, { ...base, runId: "run-2", name: "Telegram message", routineId: "routine-2", trigger: "channel" });
      expect(projectRoutineUsageRun(db, "g", channel.requestId)).toEqual({ routineId: "routine-2", routineName: "Telegram message", channel: true });
      // a request recorded before this release names no routine, and another group never reads this one's
      const legacy = recordProjectRoutine(db, { ...base, runId: "run-3", name: "Old" });
      expect(projectRoutineUsageRun(db, "g", legacy.requestId)).toBeNull();
      expect(projectRoutineUsageRun(db, "other", withRoutine.requestId)).toBeNull();
    } finally { db.close(); }
  });

  it("index.ts takes the routine as the turn starts, banks with the kept one, falls back to the request's record, and forgets only after the write", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/if \(event\.type === "turn\.started" && !privateImageEvent\) turnUsageRoutines\.take\(event\.threadId, event\.turnId, \(\) => routines\?\.usageRunForThread\(event\.threadId\),\s*\(\) => speaker \? projectRoutineRunOfRoomTurn\(event\.threadId, speaker\.botId\) : null\);/);
    expect(source).toMatch(/turnUsageRoutines\.bank\(event\.threadId, event\.turnId, \(usageRoutine\) => store\.addTaskUsage\(/);
    expect(source).toMatch(/`\$\{event\.turnId \?\? event\.eventId\}`, usageRoutine\), \(\) => routineRun\);/);
    expect(source).toMatch(/turnUsageRoutines\.bank\(event\.threadId, event\.turnId, \(roomRoutine\) => store\.addRoomTurnUsage\(/);
    expect(source).toMatch(/\(\) => projectRoutineRunOfRoomTurn\(event\.threadId, speaker\.botId\)\);/);
    expect(source).toMatch(/const recorded = projectRoutineUsageRun\(database\(\), request\.groupId, request\.id\);/);
    expect(source).toMatch(/routineId: run\.routineId, \.\.\.\(run\.triggerSource \? \{ trigger: run\.triggerSource \} : \{\}\),/);
    expect(source).not.toMatch(/RoutineManager\.usageRoutine\(routineRun\)|RoutineManager\.usageRoutine\(roomRoutine\)/);
  });
});
