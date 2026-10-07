// SPDX-License-Identifier: AGPL-3.0-or-later
// Fix D of the disk-burn defect: the JSON stores must not rewrite a whole file
// on every change. Counts are taken at writeFileAtomic, the one door every
// whole-file save goes through.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writes: Array<{ path: string; bytes: number }> = [];
vi.mock("./atomic.ts", async importOriginal => {
  const real = await importOriginal<typeof import("./atomic.ts")>();
  return { ...real, writeFileAtomic: (path: string, data: string | Uint8Array, options?: { mode?: number }) => {
    writes.push({ path, bytes: typeof data === "string" ? Buffer.byteLength(data) : data.length });
    return real.writeFileAtomic(path, data, options);
  } };
});

import * as atomic from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { RoutineManager, type RoutineManagerOptions } from "./routines.ts";
import { readRoutinesWithRuns, readRoutineRuns } from "./routine-runs-journal.ts";
import { DATA_DIR_ENTRIES } from "./data-dir-inventory.ts";
import { Store } from "./store.ts";

const flush = () => { (atomic as { flushCoalesced?: () => void }).flushCoalesced?.(); };
const writesTo = (name: string) => writes.filter(write => write.path.endsWith(name));
const dirs: string[] = [];
const botsWrites = () => (atomic as { atomicWriteCount?: (path: string) => number }).atomicWriteCount?.(join(DATA_DIR, "bots.json")) ?? 0;

beforeEach(() => { writes.length = 0; closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { flush(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("coalesced store writes", () => {
  const fresh = () => new Store(() => ({ instanceId: "engine-one", model: "one", effort: "medium", connectionId: "account-one" }));

  it("100 patchTask unread changes make at most one bots.json write per 250 ms window", () => {
    const store = fresh(), bot = store.createBot(), task = store.createTask(bot.id, "second")!;
    flush(); const before = botsWrites();
    for (let i = 0; i < 100; i += 1) store.patchTask(bot.id, task.threadId, { unread: i % 2 === 0 });
    flush();
    console.log(`METRIC bots.json writes for 100 patchTask: ${botsWrites() - before}`);
    expect(botsWrites() - before).toBeLessThanOrEqual(1);
    // Reads see the memory state, and the file holds the final state.
    expect(store.taskByThread(bot.id, task.threadId)?.unread).toBe(false);
    const disk = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"))[0];
    expect(disk.tasks.find((t: { threadId: string }) => t.threadId === task.threadId).unread).toBe(false);
  });

  it("keeps access changes immediate: a grant is on disk before patchTask returns", () => {
    const store = fresh(), bot = store.createBot(), task = store.createTask(bot.id, "second")!;
    flush();
    const before = botsWrites();
    store.patchTask(bot.id, task.threadId, { autoApprove: true });
    expect(botsWrites() - before).toBe(1);
    const disk = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"))[0];
    expect(disk.tasks.find((t: { threadId: string }) => t.threadId === task.threadId).autoApprove).toBe(true);
  });

  it("flushes the last state on an explicit flush and when a second Store reads after it", () => {
    const store = fresh(), bot = store.createBot(), task = store.createTask(bot.id, "second")!;
    store.patchTask(bot.id, task.threadId, { unread: true });
    flush();
    expect(fresh().taskByThread(bot.id, task.threadId)?.unread).toBe(true);
  });
});

describe("routine run history", () => {
  const harness = () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-perf-routines-")); dirs.push(dir);
    let now = new Date(2026, 7, 17, 8, 0, 0).getTime(), task = 0;
    const options: RoutineManagerOptions = {
      file: join(dir, "routines.json"), now: () => now, botState: () => "busy",
      createTask: () => ({ threadId: `thread-${++task}` }), startTurn: async () => {},
    };
    return { dir, options, file: options.file!, tick: () => (now += 1000) };
  };
  const input = { name: "Perf", prompt: "p", botId: "bot-a", target: "bot" as const, runOn: "ember" as const, enabled: false,
    schedule: { type: "interval" as const, everyMinutes: 30, anchorAt: 0 }, durationMinutes: 15 };

  it("appending runs does not rewrite routines.json and keeps runs out of it", () => {
    const h = harness(), manager = new RoutineManager(h.options), routine = manager.create(input);
    manager.runNow(routine.id);
    flush(); const base = readFileSync(h.file, "utf8").length; writes.length = 0;
    for (let i = 0; i < 40; i += 1) { h.tick(); manager.runNow(routine.id); }
    flush();
    expect(manager.listRuns().length).toBeGreaterThanOrEqual(30);
    console.log(`METRIC routines.json writes for 40 run appends: ${writesTo("routines.json").length}, bytes ${writesTo("routines.json").reduce((sum, write) => sum + write.bytes, 0)}, file bytes ${readFileSync(h.file, "utf8").length} (was ${base})`);
    expect(readFileSync(h.file, "utf8").length).toBe(base);
    expect(JSON.parse(readFileSync(h.file, "utf8")).runs).toEqual([]);
    expect(writesTo("routines.json").reduce((sum, write) => sum + write.bytes, 0)).toBeLessThanOrEqual(base);
    expect(readRoutineRuns(h.dir)).toHaveLength(manager.listRuns().length);
    expect(new RoutineManager(h.options).listRuns().map(run => run.id).sort()).toEqual(manager.listRuns().map(run => run.id).sort());
  });

  const legacyRun = (id: string, status: string) => ({ id, routineId: "r1", routineName: "R", botId: "bot-a", target: "bot", runOn: "ember", scheduledFor: 1, status, manual: true, createdAt: 1, triggerSource: "manual" });
  const legacyFile = (runs: unknown[]) => ({ version: 1, routines: [{ id: "r1", name: "R", prompt: "p", botId: "bot-a", target: "bot", runOn: "ember", enabled: false, schedule: { type: "interval", everyMinutes: 30, anchorAt: 0 }, durationMinutes: 15, nextRunAt: null, createdAt: 1, updatedAt: 1 }], runs });

  it("migrates runs out of a 0.1.61 routines.json once, idempotently, losing none", () => {
    const h = harness();
    writeFileSync(h.file, JSON.stringify(legacyFile([legacyRun("a", "completed"), legacyRun("b", "failed"), legacyRun("c", "running")])));
    const first = new RoutineManager(h.options);
    expect(first.listRuns().map(run => run.id).sort()).toEqual(["a", "b", "c"]);
    expect(first.listRuns().find(run => run.id === "c")?.status).toBe("failed");
    expect(JSON.parse(readFileSync(h.file, "utf8")).runs).toEqual([]);
    expect(readdirSync(join(h.dir, "events", "routine-runs"))).toEqual(["r1.jsonl"]);
    const journal = readFileSync(join(h.dir, "events", "routine-runs", "r1.jsonl"), "utf8");
    const second = new RoutineManager(h.options);
    expect(second.listRuns().map(run => run.id).sort()).toEqual(["a", "b", "c"]);
    expect(readFileSync(join(h.dir, "events", "routine-runs", "r1.jsonl"), "utf8")).toBe(journal);
  });

  it("recovers from a crash after the journal write but before routines.json was rewritten", () => {
    const h = harness();
    writeFileSync(h.file, JSON.stringify(legacyFile([legacyRun("a", "completed"), legacyRun("b", "completed")])));
    new RoutineManager(h.options);
    // Put the legacy file back, as if the rewrite never happened, and tear the journal's last line.
    writeFileSync(h.file, JSON.stringify(legacyFile([legacyRun("a", "completed"), legacyRun("b", "completed")])));
    appendFileSync(join(h.dir, "events", "routine-runs", "r1.jsonl"), '{"id":"zz","routineId":"r1","sta');
    const again = new RoutineManager(h.options);
    expect(again.listRuns().map(run => run.id).sort()).toEqual(["a", "b"]);
    expect(JSON.parse(readFileSync(h.file, "utf8")).runs).toEqual([]);
    again.runNow("r1");
    expect(new RoutineManager(h.options).listRuns().length).toBe(3);
  });

  it("a release that keeps runs inline sees an empty history, and upgrading again restores it", () => {
    const h = harness();
    writeFileSync(h.file, JSON.stringify(legacyFile([legacyRun("a", "completed")])));
    new RoutineManager(h.options);
    const disk = JSON.parse(readFileSync(h.file, "utf8"));
    // 0.1.61 reads `Array.isArray(disk.runs) ? ... : []`; its restore check needs the array.
    expect(disk.runs).toEqual([]);
    writeFileSync(h.file, JSON.stringify({ ...disk, runs: [legacyRun("d", "completed")] }));
    expect(new RoutineManager(h.options).listRuns().map(run => run.id).sort()).toEqual(["a", "d"]);
    expect(readRoutinesWithRuns(h.file).runs).toHaveLength(2);
  });
});

describe("coalescer", () => {
  it("keeps the last value per key and flushes synchronously on demand", () => {
    const seen: number[] = [];
    atomic.scheduleCoalesced("k", () => seen.push(1));
    atomic.scheduleCoalesced("k", () => seen.push(2));
    expect(atomic.hasPendingCoalesced("k")).toBe(true);
    atomic.flushCoalesced();
    expect(seen).toEqual([2]);
    expect(atomic.hasPendingCoalesced()).toBe(false);
  });
  it("writes by itself within the window", async () => {
    const seen: number[] = [];
    atomic.scheduleCoalesced("t", () => seen.push(1), 20);
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(seen).toEqual([1]);
  });
});


// Final-review additions (lane/0162-perf-stores): each failed on c6c12688.
describe("review: no lost writes, no double fire, downgrade-safe layout", () => {
  const fresh = () => new Store(() => ({ instanceId: "engine-one", model: "one", effort: "medium", connectionId: "account-one" }));
  const setup = (botState: "ready" | "busy" = "busy", start = new Date(2026, 7, 17, 8, 0, 0).getTime()) => {
    const dir = mkdtempSync(join(tmpdir(), "murage-perf-review-")); dirs.push(dir);
    const clock = { now: start }, started: string[] = [];
    let task = 0;
    const options: RoutineManagerOptions = {
      file: join(dir, "routines.json"), now: () => clock.now, botState: () => botState,
      createTask: () => ({ threadId: `thread-${++task}` }), startTurn: async (...args: unknown[]) => { started.push(String(args[0])); },
    } as RoutineManagerOptions;
    return { dir, clock, started, options, file: options.file! };
  };
  const scheduledRuns = (manager: RoutineManager, id: string) => manager.listRuns().filter(run => run.routineId === id && run.triggerSource === "schedule");

  it("a crash between the journal append and routines.json does not fire a one-time routine twice", async () => {
    const h = setup(), at = h.clock.now + 60_000;
    const first = new RoutineManager(h.options);
    const routine = first.create({ name: "Once", prompt: "p", botId: "bot-a", target: "bot", runOn: "ember", enabled: true, schedule: { type: "once", at }, durationMinutes: 15 });
    flush();
    h.clock.now = at + 1000;
    const before = readFileSync(h.file);
    await first.tick();
    first.stop();
    expect(scheduledRuns(first, routine.id)).toHaveLength(1);
    writeFileSync(h.file, before); // routines.json rename never happened
    const second = new RoutineManager(h.options);
    await second.tick();
    second.stop();
    expect(scheduledRuns(second, routine.id)).toHaveLength(1);
    const third = new RoutineManager(h.options);
    await third.tick();
    third.stop();
    expect(scheduledRuns(third, routine.id)).toHaveLength(1);
    expect(third.listRoutines()[0].nextRunAt).toBeNull();
  });

  it("the same crash on a recurring routine neither double-fires nor counts a phantom skip", async () => {
    const h = setup();
    const first = new RoutineManager(h.options);
    const routine = first.create({ name: "Every", prompt: "p", botId: "bot-a", target: "bot", runOn: "ember", enabled: true, schedule: { type: "interval", everyMinutes: 30, anchorAt: 0 }, durationMinutes: 15 });
    flush();
    h.clock.now = first.listRoutines()[0].nextRunAt! + 1000;
    const before = readFileSync(h.file);
    await first.tick(); first.stop();
    writeFileSync(h.file, before);
    const second = new RoutineManager(h.options);
    await second.tick(); second.stop();
    expect(scheduledRuns(second, routine.id)).toHaveLength(1);
    expect(second.listRoutines()[0].skippedRuns).toBeUndefined();
  });

  it("a used 0.1.61 data folder migrates and its scheduled routine still fires exactly once per occurrence", async () => {
    const h = setup("ready", Date.UTC(2026, 8, 30, 12, 0, 0));
    const base = h.clock.now - 30 * 86_400_000;
    const routines = ["r1", "r2", "r3"].map((id, index) => ({ id, name: `R${index}`, prompt: "p", botId: "bot-a", target: "bot", runOn: "ember",
      enabled: id === "r1", schedule: { type: "interval", everyMinutes: 60, anchorAt: 0 }, durationMinutes: 15,
      nextRunAt: id === "r1" ? h.clock.now - 60_000 : null, createdAt: base, updatedAt: base }));
    const runs = Array.from({ length: 600 }, (_, i) => ({ id: `old-${i}`, routineId: `r${(i % 3) + 1}`, routineName: "R", botId: "bot-a", target: "bot", runOn: "ember",
      scheduledFor: base + i * 3_600_000, status: i % 7 === 0 ? "failed" : "completed", manual: false, triggerSource: "schedule", createdAt: base + i * 3_600_000, finishedAt: base + i * 3_600_000 + 1 }));
    writeFileSync(h.file, JSON.stringify({ version: 1, routines, runs, routineRequestReceipts: [] }, null, 2));
    const first = new RoutineManager(h.options);
    expect(first.listRuns()).toHaveLength(600);
    expect(JSON.parse(readFileSync(h.file, "utf8")).runs).toEqual([]);
    await first.tick();
    await vi.waitFor(() => expect(h.started).toHaveLength(1));
    first.stop();
    expect(scheduledRuns(first, "r1").filter(run => !run.id.startsWith("old-"))).toHaveLength(1);
    // Restart inside the same occurrence: no second fire.
    const second = new RoutineManager(h.options);
    await second.tick(); second.stop();
    expect(h.started).toHaveLength(1);
    expect(second.listRuns()).toHaveLength(601);
    // The next occurrence fires once.
    h.clock.now += 3_600_000;
    const third = new RoutineManager(h.options);
    await third.tick();
    await vi.waitFor(() => expect(h.started).toHaveLength(2));
    third.stop();
    expect(scheduledRuns(third, "r1").filter(run => !run.id.startsWith("old-"))).toHaveLength(2);
    // Only names 0.1.61 already classifies sit at the top of the data folder.
    expect(readdirSync(h.dir).sort()).toEqual(["events", "routines.json"]);
    expect(DATA_DIR_ENTRIES.events?.backup).toBe("owner-folder");
  });

  it("keeps a rewind immediate: it is on disk before patchTask returns", () => {
    const store = fresh(), bot = store.createBot(), task = store.createTask(bot.id, "second")!;
    flush();
    store.patchTask(bot.id, task.threadId, { rewound: true });
    expect(atomic.hasPendingCoalesced()).toBe(false);
    const disk = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"))[0];
    expect(disk.tasks.find((t: { threadId: string }) => t.threadId === task.threadId).rewound).toBe(true);
  });

  it("a deferred write that fails stays pending and lands on the next flush", async () => {
    let fail = true;
    const seen: number[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    atomic.scheduleCoalesced("failing", () => { if (fail) throw new Error("disk full"); seen.push(1); }, 10);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(error).toHaveBeenCalled();
    expect(atomic.hasPendingCoalesced("failing")).toBe(true);
    expect(() => atomic.flushCoalesced("failing")).toThrow("disk full");
    expect(atomic.hasPendingCoalesced("failing")).toBe(true);
    fail = false;
    atomic.flushCoalesced();
    expect(seen).toEqual([1]);
    expect(atomic.hasPendingCoalesced()).toBe(false);
    error.mockRestore();
  });
});
