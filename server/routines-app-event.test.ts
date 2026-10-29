// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AT-S1 / AT-17 subset: a connected-app routine is not a calendar. It keeps its exact two-key event shape and a null
// next time through create, edit, load, clone and restore; a stale stored time never dispatches on a clock; Run now,
// a calendar drag and a kind change refuse; an unknown variant stays inert. The failure each case prevents: a routine
// meant to run only when an outside app sends an event starting on its own from a leftover time, or being turned into
// (or out of) a scheduled routine without the owner's review.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoutineManager, nextOccurrence, type RoutineManagerOptions } from "./routines.ts";
import { createRoutineEvent, routineEventForRun } from "../shared/routine-event.ts";
import { ROUTINE_RUN_TRIGGERS } from "../shared/record-values.ts";
import type { AppEventRunStore } from "./app-trigger-store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
const T0 = new Date(2026, 9, 29, 8, 0, 0).getTime();
const EVENT = { type: "app_event", triggerId: "trg-gmail-1" } as const;

function harness(file?: string) {
  let now = T0;
  const started: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "murage-routines-app-event-"));
  dirs.push(dir);
  const fakeStore = { marker: "app-run-store" } as unknown as AppEventRunStore;
  const options: RoutineManagerOptions = {
    file: file ?? join(dir, "routines.json"),
    now: () => now,
    botState: () => "ready",
    goalState: () => "ready",
    createTask: () => ({ threadId: `thread-${started.length + 1}` }),
    taskExists: () => true,
    startTurn: async (_botId, threadId) => { started.push(threadId); },
    appRunStore: fakeStore,
  };
  const manager = new RoutineManager(options);
  const base = { name: "New mail", prompt: "Summarise the new message", botId: "bot-a", target: "bot", runOn: "ember", enabled: true } as const;
  const createEvent = (extra: Record<string, unknown> = {}) => manager.create({ ...base, schedule: { ...EVENT }, ...extra } as never, undefined, { appEventSetup: true });
  return { manager, options, started, dir, fakeStore, createEvent, base, advance: (ms: number) => (now += ms), now: () => now };
}

describe("create", () => {
  it("keeps the exact event shape and no next time", () => {
    const h = harness();
    const routine = h.createEvent();
    expect(routine.schedule).toEqual(EVENT);
    expect(Object.keys(routine.schedule).sort()).toEqual(["triggerId", "type"]);
    expect(routine.nextRunAt).toBeNull();
    expect(h.manager.listRoutines().find(r => r.id === routine.id)!.schedule).toEqual(EVENT);
  });
  it("only the reviewed setup creates one: a chat card, a tool or the calendar API cannot", () => {
    const h = harness();
    expect(() => h.manager.create({ ...h.base, schedule: { ...EVENT } } as never)).toThrow(/review/);
    expect(h.manager.listRoutines()).toHaveLength(0);
  });
  it("new input is strict: calendar keys are refused, not dropped", () => {
    const h = harness();
    for (const extra of [{ at: T0 + 60_000 }, { time: "09:00", weekdays: [1] }, { everyMinutes: 5, anchorAt: T0 }, { engineKey: "engine:x" }]) {
      expect(() => h.manager.create({ ...h.base, schedule: { ...EVENT, ...extra } } as never, undefined, { appEventSetup: true })).toThrow();
    }
    expect(() => h.manager.create({ ...h.base, schedule: { type: "app_event", triggerId: "" } } as never, undefined, { appEventSetup: true })).toThrow();
  });
  it("no carried report chain for an event routine", () => {
    const h = harness();
    expect(h.createEvent({ carryLastReport: true }).carryLastReport).toBeUndefined();
  });
});

describe("edit and clone", () => {
  it("rename, new instructions, pause and resume keep the shape and the null next time", () => {
    const h = harness();
    const routine = h.createEvent();
    for (const patch of [{ name: "Renamed" }, { prompt: "Do it differently" }, { enabled: false }, { enabled: true }, { schedule: { ...EVENT } }]) {
      const updated = h.manager.update(routine.id, patch as never)!;
      expect(updated.schedule).toEqual(EVENT);
      expect(updated.nextRunAt).toBeNull();
    }
  });
  it("a returned routine is a copy: changing it changes nothing stored", () => {
    const h = harness();
    const routine = h.createEvent();
    const listed = h.manager.listRoutines()[0]!;
    (listed.schedule as { triggerId: string }).triggerId = "trg-other";
    expect(h.manager.listRoutines().find(r => r.id === routine.id)!.schedule).toEqual(EVENT);
  });
  it("a kind change refuses both ways, and so does another trigger", () => {
    const h = harness();
    const event = h.createEvent();
    expect(() => h.manager.update(event.id, { schedule: { type: "once", at: T0 + 3_600_000 } } as never)).toThrow(/switch/);
    expect(() => h.manager.update(event.id, { schedule: { type: "daily", time: "09:00", weekdays: [1, 2] } } as never)).toThrow(/switch/);
    expect(() => h.manager.update(event.id, { schedule: { type: "app_event", triggerId: "trg-other" } } as never)).toThrow(/new connected-app routine/);
    const daily = h.manager.create({ ...h.base, schedule: { type: "daily", time: "09:00", weekdays: [1] } } as never);
    expect(() => h.manager.update(daily.id, { schedule: { ...EVENT } } as never)).toThrow(/switch/);
    expect(h.manager.listRoutines().find(r => r.id === event.id)!.schedule).toEqual(EVENT);
  });
  it("a calendar drag (a new time for the routine) refuses", () => {
    const h = harness();
    const event = h.createEvent();
    expect(() => h.manager.update(event.id, { schedule: { type: "once", at: T0 + 86_400_000 } } as never)).toThrow();
    expect(h.manager.listRoutines()[0]!.nextRunAt).toBeNull();
  });
});

describe("never on a clock", () => {
  it("Run now refuses and makes no run", () => {
    const h = harness();
    const event = h.createEvent();
    expect(() => h.manager.runNow(event.id)).toThrow(/connected app sends an event/);
    expect(h.manager.listRuns()).toHaveLength(0);
  });
  it("nextOccurrence is null before any date is read", () => {
    expect(nextOccurrence({ ...EVENT }, T0)).toBeNull();
  });
  it("load normalizes mixed stored keys to two and a stale due time never dispatches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-routines-app-event-load-"));
    dirs.push(dir);
    const file = join(dir, "routines.json");
    const stored = {
      id: "r-app-1", name: "New mail", prompt: "Summarise", target: "bot", botId: "bot-a", runOn: "ember", enabled: true,
      // a stale time and calendar fields a downgrade or a hand edit left behind
      schedule: { type: "app_event", triggerId: "trg-gmail-1", at: T0 - 60_000, time: "07:00", weekdays: [0, 1, 2, 3, 4, 5, 6], engineKey: "engine:x" },
      durationMinutes: 30, attachments: [], nextRunAt: T0 - 60_000, carryLastReport: true, permissionMode: "ask", createdAt: T0 - 86_400_000, updatedAt: T0 - 86_400_000,
    };
    writeFileSync(file, JSON.stringify({ version: 1, routines: [stored] }));
    const h = harness(file);
    const loaded = h.manager.listRoutines().find(r => r.id === "r-app-1")!;
    expect(loaded.schedule).toEqual(EVENT);
    expect(loaded.nextRunAt).toBeNull();
    expect(loaded.carryLastReport).toBeUndefined();
    for (let i = 0; i < 3; i++) { h.advance(10 * 60_000); await h.manager.tick(); }
    expect(h.manager.listRuns()).toHaveLength(0);
    expect(h.started).toHaveLength(0);
  });
  it("restore (a reload of the same file) keeps the exact shape", () => {
    const first = harness();
    const routine = first.createEvent();
    const again = harness(first.options.file);
    const restored = again.manager.listRoutines().find(r => r.id === routine.id)!;
    expect(restored.schedule).toEqual(EVENT);
    expect(restored.nextRunAt).toBeNull();
  });
  it("a package cannot bring an event routine", () => {
    const h = harness();
    const routine = { id: "pkg-1", name: "x", prompt: "y", target: "bot", botId: "bot-a", runOn: "ember", enabled: false, schedule: { ...EVENT }, durationMinutes: 30, attachments: [], nextRunAt: null, createdAt: T0, updatedAt: T0 };
    expect(() => h.manager.preparePackageAddition([routine as never])).toThrow(/connected-app/);
  });
});

describe("unknown variants stay inert", () => {
  it("a schedule kind this build does not know, or an event without a valid trigger, is kept unloaded and never runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-routines-app-event-unknown-"));
    dirs.push(dir);
    const file = join(dir, "routines.json");
    const common = { name: "Future", prompt: "p", target: "bot", botId: "bot-a", runOn: "ember", enabled: true, durationMinutes: 30, attachments: [], nextRunAt: T0 - 1, createdAt: T0, updatedAt: T0 };
    writeFileSync(file, JSON.stringify({ version: 1, routines: [
      { ...common, id: "r-future", schedule: { type: "app_event_v2", triggerId: "trg-1", filter: {} } },
      { ...common, id: "r-bad-trigger", schedule: { type: "app_event", triggerId: "has space" } },
    ] }));
    const h = harness(file);
    expect(h.manager.listRoutines()).toHaveLength(0);
    expect(h.manager.unloadable().map(item => item.id).sort()).toEqual(["r-bad-trigger", "r-future"]);
    h.advance(60_000);
    await h.manager.tick();
    expect(h.manager.listRuns()).toHaveLength(0);
    // the unloaded rows ride along unchanged through the next save
    h.createEvent();
    const disk = JSON.parse(readFileSync(file, "utf8")) as { routines: Array<{ id: string; schedule: unknown }> };
    expect(disk.routines.find(r => r.id === "r-future")!.schedule).toEqual({ type: "app_event_v2", triggerId: "trg-1", filter: {} });
  });
});

describe("provenance and the run store", () => {
  it("record values know app runs; app provenance is built only from a run row that names its trigger", () => {
    expect(ROUTINE_RUN_TRIGGERS).toContain("app");
    const event = createRoutineEvent({ runId: "run-1", definitionId: "r-1", receivedAt: T0, source: "app", appTriggerId: "trg-1" });
    expect(event).toMatchObject({ source: "app", origin: { kind: "connected-app", triggerId: "trg-1" } });
    expect(() => createRoutineEvent({ runId: "run-1", definitionId: "r-1", receivedAt: T0, source: "app" })).toThrow();
    expect(() => createRoutineEvent({ runId: "run-1", definitionId: "r-1", receivedAt: T0, source: "manual", appTriggerId: "trg-1" })).toThrow();
    const row = { id: "run-1", routineId: "r-1", createdAt: T0, scheduledFor: T0, manual: false };
    expect(routineEventForRun({ ...row, triggerSource: "app", appTriggerId: "trg-1" })).toMatchObject({ source: "app" });
    // a label alone, or an app label mixed with another origin, gains no provenance
    expect(routineEventForRun({ ...row, triggerSource: "app" })).toBeUndefined();
    expect(routineEventForRun({ ...row, triggerSource: "app", appTriggerId: "trg-1", webhookId: "w-1" })).toBeUndefined();
    expect(routineEventForRun({ ...row, appTriggerId: "trg-1" })).toBeUndefined();
  });
  it("the manager exposes the indexed app run store it was given", () => {
    const h = harness();
    expect(h.manager.appRunStore).toBe(h.fakeStore);
  });
});
