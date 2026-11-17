// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { historyKey, RoutineHistoryIndex } from "./routines.ts";

describe("A1 fixed-depth history indexes", () => {
  it("orders finite values, signed zero and infinities and exposes a successor after maximum deletion", () => {
    const trie = new RoutineHistoryIndex<number>();
    const values = [-Infinity, -9, -0, 1, 27, Infinity];
    values.forEach((value, order) => trie.set(historyKey(value, -order), order));
    expect([...trie.entries()].map(([, value]) => value)).toEqual([5, 4, 3, 2, 1, 0]);
    expect(historyKey(-0)).toBe(historyKey(0));
    expect(trie.latest(historyKey(27, -Infinity))).toBe(3);
    trie.delete(historyKey(Infinity, -5));
    expect(trie.latest()).toBe(4);
    expect(trie.countAfter(historyKey(1, -3))).toBe(1);
    expect(trie.audit()).toEqual([]);
  });
  it("finds oldest eligible without moving expired holds and audits interior aggregates", () => {
    const trie = new RoutineHistoryIndex<number>(16);
    for (let order = 0; order < 2500; order++) trie.set(historyKey(order), order, order < 2000 ? Infinity : 100);
    expect(trie.oldestEligible(99)).toBeUndefined();
    expect(trie.oldestEligible(100)).toBe(2000);
    expect(trie.oldestEligible(99)).toBeUndefined();
    const child = trie.root.children.values().next().value!;
    child.size++;
    child.minEligibleBase = -Infinity;
    expect(trie.audit()).toEqual(expect.arrayContaining(["size", "minEligibleBase"]));
  });
});

import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import { RoutineManager, routineWorkCounters, ScopeEscape, type RoutineRun, type Routine, type RoutineManagerOptions } from "./routines.ts";
import { plainCopy } from "./tracked-state.ts";
import { readRoutinesWithRuns } from "./routine-runs-journal.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const roots: string[] = [], instances: RoutineManager[] = [];
const measurements: Array<{ test?: string; work: typeof routineWorkCounters; history: Record<string, number> }> = [];
afterEach(() => {
  if (process.env.S4_MEASURE_PATH && measurements.length) appendFileSync(process.env.S4_MEASURE_PATH, measurements.splice(0).map(row => JSON.stringify(row)).join("\n") + "\n");
  else measurements.length = 0;
  vi.restoreAllMocks(); for (const m of instances.splice(0)) m.stop(); for (const root of roots.splice(0)) removeTempDirSync(root); });
const EPOCH = Date.UTC(2026, 10, 1, 8), STEP = 300_000, KEEP = 86_400_000;
type Internal = {
  runStore: Set<RoutineRun>; indexes: import("./routines.ts").RunIndexes;
  routines: Routine[]; ownerRunList: RoutineRun[]; runsGeneration: number;
  liveDispatch: Map<string, unknown>; openDispatch: Set<string>; dirtyRuns: Set<RoutineRun>; dirtyRoutines: Set<Routine>;
  unsavedStartTasks: Map<string, string>; watchReads: Map<string, AbortController>; fullSave: boolean; savedRunCount: number;
  rollbackPending: Set<RoutineRun>; recoveryRequired: boolean; journal: { append(input: unknown): number };
  openRequests: Map<string, unknown>; deferrals: Map<string, unknown>; heldByStartup: Set<string>; automaticHeldSince: Map<string, unknown>; requiredToolCalls: Map<string, unknown>;
  commitScoped(scope: { runs?: RoutineRun[]; routines?: Routine[]; append?: RoutineRun }, mutate: () => void): void;
  appendRun(run: RoutineRun): RoutineRun;
  save(options?: { runs?: RoutineRun[]; routines?: Routine[]; defer?: boolean }): void;
  saveFull(): void; withMaintenance<T>(work: () => T): T;
};
const inside = (m: RoutineManager) => m as unknown as Internal;
const ev = (type: string, run: RoutineRun, extra: object = {}) => ({ type, threadId: run.threadId!, turnId: `turn-${run.id}`, ...extra }) as never;
function fixture(options: Partial<RoutineManagerOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "s4-core-")); roots.push(root); let task = 0;
  const clock = { now: EPOCH };
  const terminal = vi.fn();
  const m = new RoutineManager({ file: join(root, "routines.json"), now: () => clock.now, botState: () => "ready",
    taskExists: () => true, createTask: () => ({ threadId: `task-${++task}` }), startTurn: async () => {}, interruptTurn: async () => {},
    onRunRecovered: () => {}, onRoutineRunTerminal: terminal, ...options });
  instances.push(m);
  return { root, clock, m, terminal };
}
async function productionHistory(count: number) {
  const f = fixture();
  const definitions = Array.from({ length: 20 }, (_, n) => f.m.create({ name: `Series ${n}`, prompt: "Fake report", botId: `bot-${n}`, target: "bot", runOn: "ember", carryLastReport: true,
    schedule: { type: "interval", everyMinutes: 5, anchorAt: EPOCH + STEP } }));
  for (let round = 0; round < count / 20; round++) {
    f.clock.now += STEP; await f.m.tick();
    const active = [...inside(f.m).indexes.liveRuns];
    expect(active).toHaveLength(20);
    for (const run of active) {
      f.m.handleRuntimeEvent(ev("turn.started", run));
      f.m.handleRuntimeEvent(ev("turn.completed", run, { ok: true }));
    }
    await Promise.resolve(); await f.m.tick();
  }
  expect(inside(f.m).runStore.size).toBe(count);
  expect(inside(f.m).liveDispatch.size).toBe(count);
  expect([...inside(f.m).runStore].filter(run => run.delivery?.state === "pending")).toHaveLength(count);
  return { ...f, definitions };
}
const resetWork = () => {
  for (const key of Object.keys(routineWorkCounters) as Array<keyof typeof routineWorkCounters>) {
    if (key === "trieCalls") routineWorkCounters.trieCalls = {}; else routineWorkCounters[key] = 0;
  }
};
const forbiddenWork: Record<string, number> = {};
function forbidHistory(m: RoutineManager): () => void {
  const items = [[inside(m).runStore, "runStore"], [inside(m).indexes.indexedRuns, "indexedRuns"], [inside(m).liveDispatch, "liveDispatch"], [inside(m).indexes.scheduledByOwner, "scheduledByOwner"]] as const;
  const undo: Array<() => void> = [];
  for (const key of Object.keys(forbiddenWork)) delete forbiddenWork[key];
  for (const [collection, label] of items) for (const key of [Symbol.iterator, "entries", "keys", "values", "forEach"]) {
    const previous = Reflect.getOwnPropertyDescriptor(collection, key), original = Reflect.get(collection, key).bind(collection);
    Object.defineProperty(collection, key, { value: (...args: unknown[]) => {
      forbiddenWork[label + ".calls"] = (forbiddenWork[label + ".calls"] ?? 0) + 1;
      if (key === "forEach") {
        const callback = args[0] as (...args: unknown[]) => unknown;
        return original((...values: unknown[]) => { forbiddenWork[label + ".forEachVisit"] = (forbiddenWork[label + ".forEachVisit"] ?? 0) + 1; return callback.apply(args[1], values); });
      }
      const iterator = original(...args);
      return { [Symbol.iterator]() { return this; }, next() { const next = iterator.next(); forbiddenWork[label + ".next"] = (forbiddenWork[label + ".next"] ?? 0) + 1; return next; } };
    }, configurable: true });
    undo.push(() => { if (previous) Object.defineProperty(collection, key, previous); else Reflect.deleteProperty(collection, key); });
  }
  resetWork(); return () => { for (const restore of undo) restore(); };
}
function bounded(maxClones = 4, maxTrieCalls = 6000) {
  expect(routineWorkCounters.runsMaterialized, "P27 owner materialisations").toBe(0);
  expect(routineWorkCounters.fullCommits, "full transactions").toBe(0);
  expect(routineWorkCounters.recoverySaves, "M-COMMIT-FULLSAVE direct saveFull").toBe(0);
  expect(routineWorkCounters.fullVerifiers, "inline verifier").toBe(0);
  expect(Object.entries(routineWorkCounters.trieCalls).filter(([method]) => /^(entries|audit):/.test(method)), "diagnostic trie enumeration").toEqual([]);
  expect(routineWorkCounters.cloneRun).toBeLessThanOrEqual(maxClones);
  expect(routineWorkCounters.retired).toBeLessThanOrEqual(32);
  expect(routineWorkCounters.expiryServiced).toBeLessThanOrEqual(routineWorkCounters.retired);
  expect(Object.values(routineWorkCounters.trieCalls).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(maxTrieCalls);
  expect(forbiddenWork, "forbidden labelled history work").toEqual({});
  measurements.push({ test: expect.getState().currentTestName, work: { ...routineWorkCounters, trieCalls: { ...routineWorkCounters.trieCalls } }, history: { ...forbiddenWork } });
}
function definition(m: RoutineManager, name = "One", extra: object = {}) {
  return m.create({ name, prompt: "Fake report", botId: "bot", target: "bot", runOn: "ember", enabled: false,
    schedule: { type: "interval", everyMinutes: 5, anchorAt: EPOCH + STEP }, ...extra });
}
async function manual(f: ReturnType<typeof fixture>, id?: string) {
  const routine = id ?? definition(f.m).id;
  const queued = f.m.runNow(routine)!; await f.m.tick(); await Promise.resolve();
  const run = inside(f.m).indexes.runsById.get(queued.id)!;
  f.m.handleRuntimeEvent(ev("turn.started", run));
  return run;
}

describe("A2/A3/A4 bounded manager", () => {
  for (const count of [100, 2000]) it(`P1/P2/P3/P8/P9/P15/P17/P19/P26/P27: ${count} real dispatches`, async () => {
    const f = await productionHistory(count), i = inside(f.m);
    expect(f.m.verifyIndexes(true)).toEqual([]);
    f.m.listRuns(); // A prewarmed owner cache is not an internal save dependency.
    const sample = i.indexes.runsById.values().next().value!;
    let undo = forbidHistory(f.m);
    try {
      await f.m.tick();
      expect(f.m.schedulerStatus().consecutiveFailures).toBe(0);
      expect(f.m.runById(sample.id)?.id).toBe(sample.id);
      expect(f.m.hasStartedRun(sample.routineId)).toBe(true);
      expect(f.m.nextRunStartAfter(sample)).toBeGreaterThan(sample.startedAt!);
      expect(f.m.findWebhookDelivery("absent", "absent")).toBeNull();
      expect(f.m.activeWebhookRunCount("absent")).toBe(0);
      expect(f.m.memoryOriginKinds()(sample.threadId!)).toEqual(new Set(["schedule"]));
      expect(f.m.latestRunsForOwner("bot-0").size).toBe(1);
      bounded(2);
    } finally { undo(); }
    f.clock.now += STEP;
    undo = forbidHistory(f.m);
    try { await f.m.tick(); bounded(60, 20000); } finally { undo(); }
    expect(f.m.verifyIndexes()).toEqual([]);
    const run = [...i.indexes.liveRuns][0]!;
    run.timeoutMinutes = 1; f.clock.now += 60_001;
    undo = forbidHistory(f.m);
    try {
      expect(f.m.cardOpened(run.threadId!, "card", "Please approve")).toBe(true);
      await f.m.tick();
      expect(run.status).toBe("needs-you");
      expect(f.m.runWithOpenCard(run.threadId!, "card")?.id).toBe(run.id);
      bounded(8, 10000);
    } finally { undo(); }
    undo = forbidHistory(f.m);
    try {
      f.m.cardClosed(run.threadId!, "card");
      f.m.handleRuntimeEvent(ev("turn.started", run));
      f.m.handleRuntimeEvent(ev("turn.completed", run, { ok: true }));
      await Promise.resolve(); await f.m.tick();
      expect(run.status).toBe("completed");
      bounded(10, 10000);
    } finally { undo(); }
    for (const map of [i.openRequests, i.requiredToolCalls, i.deferrals, i.heldByStartup, i.unsavedStartTasks, i.automaticHeldSince]) expect(map.has(run.id)).toBe(false);
    expect(i.openDispatch.has(run.id)).toBe(false);
    expect(f.m.verifyIndexes(true)).toEqual([]);
  }, 120_000);

  it("P23/P28: exactly 2500 protected receipts retire 32 per tick, with rollback of time and a shared save token", async () => {
    const f = await productionHistory(2500), i = inside(f.m);
    for (const r of f.definitions) f.m.update(r.id, { enabled: false });
    const original = [...i.runStore].map(run => run.id), protectedAt = f.clock.now;
    f.clock.now += KEEP + 1;
    let undo = forbidHistory(f.m);
    try {
      i.withMaintenance(() => { i.save({ runs: [] }); i.save({ runs: [] }); });
      expect(routineWorkCounters.retired).toBe(32); expect(i.runStore.size).toBe(2468); bounded(0, 3000);
    } finally { undo(); }
    expect([...i.runStore].map(run => run.id)).toEqual(original.slice(32));
    f.clock.now = protectedAt;
    undo = forbidHistory(f.m);
    try { await f.m.tick(); expect(routineWorkCounters.retired).toBe(0); bounded(0); } finally { undo(); }
    f.clock.now += KEEP + 1;
    for (let tick = 1; tick < 16; tick++) {
      undo = forbidHistory(f.m);
      try { await f.m.tick(); expect(routineWorkCounters.retired).toBe(tick === 15 ? 20 : 32); bounded(0, 3000); } finally { undo(); }
    }
    expect(i.runStore.size).toBe(2000); expect([...i.runStore].map(run => run.id)).toEqual(original.slice(500));
    expect(f.m.verifyIndexes(true)).toEqual([]);
  }, 180_000);

  it("P12/P13/P27: scoped ingress and every event-budget mutation preserve the ledger and exclude foreign dirtiness", async () => {
    const f = fixture({ dispatchOpen: () => false }), i = inside(f.m);
    const foreign = definition(f.m), canonical = i.routines.find(r => r.id === foreign.id)!;
    canonical.name = "unsaved foreign";
    const undo = forbidHistory(f.m);
    let run!: RoutineRun;
    try {
      const input = { webhookId: "hook", webhookName: "Hook", deliveryId: "one", prompt: "Fake", botId: "bot", runOn: "ember" as const, receivedAt: f.clock.now };
      run = f.m.enqueueWebhook(input); expect(i.savedRunCount).toBe(1); expect(f.m.findWebhookDelivery("hook", "one")?.id).toBe(run.id);
      expect(i.dirtyRoutines.has(canonical)).toBe(true);
      expect(f.m.admitEventAction(run.id, "one", "create")).toBe(true);
      f.m.raiseEventLimit(run.id, "create", 6);
      f.m.recordEventAdmissionReceipt(run.id, "one", "fake-receipt");
      f.m.admitEventAction(run.id, "two", "handoff"); f.m.releaseEventAdmission(run.id, "two");
      f.m.declineEventKind(run.id, "handoff"); f.m.closeEventBudget(run.id);
      expect(f.m.activeWebhookRunCount("hook")).toBe(1); bounded(14, 10000);
    } finally { undo(); }
    expect(readRoutinesWithRuns(join(f.root, "routines.json")).routines.find((r: Routine) => r.id === foreign.id).name).toBe("One");
    i.save({ runs: [] }); expect(i.savedRunCount).toBe(1); expect(i.fullSave).toBe(false);
    expect(f.m.verifyIndexes()).toEqual([]);
    f.m.cancelQueuedWebhook("hook", "Stopped"); expect(f.m.activeWebhookRunCount("hook")).toBe(0);
  });

  it("P24: every list/record trap rejects before mutation and restores prior scoped writes", async () => {
    const f = fixture(), a = await manual(f), b = await manual(f), i = inside(f.m);
    const list = i.ownerRunList, routines = i.routines, before = plainCopy(a), other = plainCopy(b);
    const disk = readFileSync(join(f.root, "routines.json"), "utf8"), generation = i.runsGeneration;
    const forbidden = [
      () => { b.error = "escaped"; }, () => { b.eventBudget!.limits.create = 999; },
      () => Object.defineProperty(b, "error", { value: "escaped" }),
      () => Object.defineProperty(list, "0", { value: b }), () => Object.defineProperty(list, "length", { value: 0 }),
      () => Object.defineProperty(routines, "0", { value: routines[0] }), () => Object.defineProperty(routines, "length", { value: 0 }),
      () => { list.length = 0; }, () => { Reflect.deleteProperty(list, "0"); }, () => { list.push(b); },
      () => { (list as unknown as Record<string, unknown>).custom = true; }, () => Reflect.setPrototypeOf(list, {}),
      () => Object.freeze(list), () => Object.seal(routines), () => Object.preventExtensions(a),
      () => Object.defineProperty(a, "error", { get: () => "escaped" }), () => Object.freeze(a), () => { a.id = "changed"; },
      () => i.save({ runs: [] }), () => i.commitScoped({ runs: [b] }, () => {}),
    ];
    for (const escape of forbidden) {
      expect(() => i.commitScoped({ runs: [a] }, () => { a.error = "temporary"; escape(); })).toThrow(ScopeEscape);
      expect(plainCopy(a)).toEqual(before); expect(plainCopy(b)).toEqual(other);
      expect(Object.isExtensible(a)).toBe(true); expect(Object.isExtensible(list)).toBe(true);
      expect(list).toHaveLength(2); expect(i.runsGeneration).toBe(generation);
      expect(readFileSync(join(f.root, "routines.json"), "utf8")).toBe(disk);
    }
    expect(f.m.verifyIndexes()).toEqual([]);
  });

  it("P31: membership and malformed orders produce named failures before dereference; repair also audits card keys/min aggregates", async () => {
    const f = fixture(), a = await manual(f), i = inside(f.m);
    i.indexes.indexedRuns.delete(a);
    expect(() => expect(f.m.verifyRunIndexes()).toContain("indexedRuns.membership")).not.toThrow(); expect(f.m.repairIndexes()).toEqual([]);
    for (const order of [undefined, NaN, 1.5, -1]) {
      (i.indexes.indexedRuns.get(a)! as unknown as { order: unknown }).order = order;
      expect(f.m.verifyRunIndexes()).toContain("indexedRuns.order.invalid"); expect(f.m.repairIndexes()).toEqual([]);
    }
    i.indexes.scheduledAll.root.children.values().next().value!.size++;
    expect(f.m.verifyRunIndexes()).toContain("scheduledAll.size"); expect(f.m.repairIndexes()).toEqual([]);
  });
});

describe("A3 exact indexed projections", () => {
  it("P5/P6: provider-limit buckets follow engine-only edits and queued-to-running changes", async () => {
    const f = fixture({ limitRefusal: (_run, refusal) => refusal.message === "limit" ? { engineKey: "engine:a", until: EPOCH + 3600000, engineName: "Fake", line: "Wait", failLine: "Limit" } : null });
    const a = await manual(f), b = await manual(f), i = inside(f.m);
    let undo = forbidHistory(f.m);
    try {
      f.m.settleDispatch({ runId: a.id }, "limit"); f.m.settleDispatch({ runId: b.id }, "limit");
      expect(a.limitWait?.until).toBe(EPOCH + 3600000); expect(b.limitWait?.until).toBe(EPOCH + 3660000);
      a.limitWait!.engineKey = "engine:b";
      expect(i.indexes.queuedLimitWaitsByEngine.get("engine:a")?.size).toBe(1);
      expect(i.indexes.queuedLimitWaitsByEngine.get("engine:b")?.has(a)).toBe(true);
      a.status = "running";
      expect(i.indexes.queuedLimitWaitsByEngine.has("engine:b")).toBe(false);
      bounded(8, 5000);
    } finally { undo(); }
    expect(f.m.verifyIndexes()).toEqual([]);
    // A refusal applies to live work. Re-enter running as the next dispatch would before each refusal.
    b.status = "running"; f.m.settleDispatch({ runId: b.id }, "limit");
    b.status = "running"; f.m.settleDispatch({ runId: b.id }, "limit");
    expect(b.status).toBe("failed"); expect(i.openDispatch.has(b.id)).toBe(false);
  });
  it("P17/P21/P26/P33: strict finite starts differ from started-presence, and origin lookup follows edits/rollback", async () => {
    const f = fixture(), a = await manual(f), b = await manual(f, a.routineId), i = inside(f.m);
    a.startedAt = 10; b.startedAt = 10;
    expect(f.m.nextRunStartAfter(a)).toBeUndefined();
    b.startedAt = 11; expect(f.m.nextRunStartAfter(a)).toBe(11);
    a.startedAt = -0; b.startedAt = 0; expect(f.m.nextRunStartAfter(a)).toBeUndefined();
    a.startedAt = NaN; expect(f.m.nextRunStartAfter(a)).toBeUndefined(); expect(f.m.hasStartedRun(a.routineId)).toBe(true);
    a.startedAt = undefined; b.startedAt = undefined; expect(f.m.hasStartedRun(a.routineId)).toBe(false);
    (a as unknown as { startedAt: null }).startedAt = null; expect(f.m.hasStartedRun(a.routineId)).toBe(true);
    expect(f.m.memoryOriginKinds()(a.threadId!)).toEqual(new Set(["manual"]));
    a.triggerSource = "webhook";
    expect(f.m.memoryOriginKinds()(a.threadId!)).toEqual(new Set(["webhook"]));
    expect(() => i.commitScoped({ runs: [a] }, () => { a.threadId = "moved"; a.triggerSource = "channel"; throw new Error("rollback"); })).toThrow("rollback");
    expect(f.m.memoryOriginKinds()("moved")).toBeUndefined(); expect(f.m.memoryOriginKinds()(a.threadId!)).toEqual(new Set(["webhook"]));
    expect(f.m.verifyIndexes()).toEqual([]);
  });
  it("P22/P29: list-first accessors agree with the owner oracle through 200 deterministic mutations", async () => {
    const f = fixture(), a = await manual(f), b = await manual(f), i = inside(f.m);
    const runs = [a, b]; let state = 19;
    for (let n = 0; n < 200; n++) {
      state = (state * 1664525 + 1013904223) >>> 0;
      const run = runs[n % 2]!;
      run.threadId = `thread-${state % 3}`; run.scheduledFor = (state % 7) - 3;
      run.cardsOpen = state % 2 ? ["shared"] : [];
      run.status = (["queued", "running", "waiting", "needs-you", "completed"] as const)[state % 5]!;
      run.event = { ...run.event!, id: `event-${state % 3}` };
      const list = f.m.listRuns();
      for (let thread = 0; thread < 3; thread++) {
        const id = `thread-${thread}`, live = list.find(r => r.threadId === id && ["running", "waiting", "needs-you"].includes(r.status));
        expect(f.m.newestLiveRunInThread(id)?.id).toBe(live?.id);
        const card = list.find(r => r.threadId === id && ["queued", "running", "waiting", "needs-you"].includes(r.status) && r.cardsOpen?.includes("shared"));
        expect(f.m.runWithOpenCard(id, "shared")?.id).toBe(card?.id);
        const event = list.find(r => r.threadId === id && (r.id === "event-1" || r.event?.id === "event-1"));
        expect(f.m.automationRunFor(id, "event-1")?.id).toBe(event?.id);
        expect(f.m.automationRunFor(id, "missing")).toBeUndefined();
      }
      expect(f.m.verifyRunIndexes()).toEqual([]);
    }
    resetWork();
    expect([...f.m.latestRunsForOwner("bot").keys()].sort()).toEqual([a.routineId, b.routineId].sort());
    expect(routineWorkCounters.ownerDefinitionsVisited).toBe(2);
    f.m.remove(a.routineId);
    resetWork(); expect(f.m.latestRunsForOwner("bot").has(a.routineId)).toBe(false); expect(routineWorkCounters.ownerDefinitionsVisited).toBe(1);
    expect(i.indexes.scheduledByOwner.size).toBeGreaterThanOrEqual(1);
  });
  it("P25: timezone reconciliation examines eight definitions, holds its cursor on failure and resumes after recovery", () => {
    const f = fixture(), i = inside(f.m);
    for (let n = 0; n < 20; n++) definition(f.m, `Daily ${n}`, { enabled: true, schedule: { type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] } });
    for (const routine of i.routines) routine.nextRunAt! += 60000;
    i.save({ routines: i.routines });
    const undo = forbidHistory(f.m);
    try {
      expect(f.m.rescheduleForZoneChangeStep({ offWallClockOnly: true, since: EPOCH }).done).toBe(false);
      expect(routineWorkCounters.zoneExamined).toBe(8); bounded(0, 2000);
    } finally { undo(); }
    resetWork(); expect(f.m.rescheduleForZoneChangeStep({ offWallClockOnly: true, since: EPOCH }).done).toBe(false);
    expect(routineWorkCounters.zoneExamined).toBe(8);
    resetWork(); expect(f.m.rescheduleForZoneChangeStep({ offWallClockOnly: true, since: EPOCH }).done).toBe(true);
    expect(routineWorkCounters.zoneExamined).toBe(4);
    expect(f.m.verifyIndexes()).toEqual([]);
  });
  it("P34: 2000 settled card holders contribute zero leaves; duplicate open maxima update synchronously", async () => {
    const f = await productionHistory(2000), i = inside(f.m);
    // Persisted cards may remain on settled receipts. Changing one record exercises the same tracked choke point.
    for (const run of i.runStore) { run.threadId = "shared"; run.cardsOpen = ["card"]; }
    i.save({ runs: [...i.runStore] });
    const a = f.m.enqueueWebhook({ webhookId: "hook", webhookName: "Hook", deliveryId: "a", prompt: "Fake", botId: "busy", runOn: "ember", receivedAt: f.clock.now });
    const b = f.m.enqueueWebhook({ webhookId: "hook", webhookName: "Hook", deliveryId: "b", prompt: "Fake", botId: "busy", runOn: "ember", receivedAt: f.clock.now + 1 });
    const one = i.indexes.runsById.get(a.id)!, two = i.indexes.runsById.get(b.id)!;
    for (const run of [one, two]) i.commitScoped({ runs: [run] }, () => { run.threadId = "shared"; run.cardsOpen = ["card"]; });
    const bucket = i.indexes.cardRuns.get(JSON.stringify(["shared", "card"]))!;
    expect(i.runStore.size).toBe(2002); expect(bucket.size).toBe(2);
    const undo = forbidHistory(f.m);
    const originalEntries = bucket.entries.bind(bucket);
    const forbidden = vi.spyOn(bucket, "entries").mockImplementation(originalEntries);
    try {
      expect(f.m.runWithOpenCard("shared", "card")?.id).toBe(two.id);
      two.scheduledFor = one.scheduledFor; expect(f.m.runWithOpenCard("shared", "card")?.id).toBe(one.id);
      one.scheduledFor = two.scheduledFor - 1; expect(f.m.runWithOpenCard("shared", "card")?.id).toBe(two.id);
      two.status = "completed"; expect(i.indexes.cardRuns.get(JSON.stringify(["shared", "card"]))?.size).toBe(1); expect(f.m.runWithOpenCard("shared", "card")?.id).toBe(one.id);
      two.status = "queued"; two.threadId = "moved";
      expect(f.m.runWithOpenCard("shared", "card")?.id).toBe(one.id); expect(f.m.runWithOpenCard("moved", "card")?.id).toBe(two.id);
      one.status = "completed"; expect(f.m.runWithOpenCard("shared", "card")).toBeNull();
      one.status = "queued";
      expect(() => i.commitScoped({ runs: [one] }, () => { one.cardsOpen = []; throw new Error("rollback"); })).toThrow("rollback");
      expect(f.m.runWithOpenCard("shared", "card")?.id).toBe(one.id);
      expect(forbidden).toHaveBeenCalledTimes(0); bounded(12, 5000);
    } finally { forbidden.mockRestore(); undo(); }
    expect(f.m.verifyRunIndexes()).toEqual([]);
  }, 120000);
});

it("P23 scoped enqueue never services eligible retirement, before any regular save", async () => {
  const f = await productionHistory(2500), i = inside(f.m);
  for (const r of f.definitions) f.m.update(r.id, { enabled: false });
  f.clock.now += KEEP + 1;
  const undo = forbidHistory(f.m);
  try {
    f.m.enqueueWebhook({ webhookId: "hook", webhookName: "Fake", deliveryId: "one", prompt: "Fake", botId: "bot", runOn: "ember", receivedAt: f.clock.now });
    expect(routineWorkCounters.retired, "scope retirement").toBe(0); expect(i.runStore.size).toBe(2501); bounded(2, 2000);
  } finally { undo(); }
}, 180000);
it("P19 a real startup-held queued cancellation drains all standing side references", async () => {
  const f = fixture({ startupReady: () => false, startupWaitMs: 3600000 }), i = inside(f.m);
  const r = definition(f.m, "Held", { enabled: true }); f.clock.now += STEP; await f.m.tick();
  const run = [...i.runStore][0]!; expect(run.status).toBe("queued"); expect(i.heldByStartup.has(run.id)).toBe(true);
  await f.m.cancelRun(run.id);
  expect(i.heldByStartup.has(run.id)).toBe(false); expect(i.deferrals.has(run.id)).toBe(false); expect(i.openDispatch.has(run.id)).toBe(false);
  expect(f.terminal).toHaveBeenCalledTimes(1); expect(f.m.runById(run.id)?.routineId).toBe(r.id);
});
it("P31 the card membership comparison is independently required", async () => {
  const f = fixture(), run = await manual(f), i = inside(f.m);
  f.m.cardOpened(run.threadId!, "one", "Fake card");
  i.indexes.cardRuns.clear(); expect(f.m.verifyRunIndexes()).toContain("cardRuns.membership");
  expect(f.m.repairIndexes()).toEqual([]);
});
it("P27 source audit: accounting, scoped writes and gated lookups cannot materialise an owner view", () => {
  const source = readFileSync(new URL("./routines.ts", import.meta.url), "utf8");
  expect(source.match(/this\.runs\b/g) ?? [], "internal old owner view reads").toEqual([]);
  expect(source.match(/this\.runsRaw\b/g) ?? [], "internal raw array reads").toEqual([]);
  for (const name of ["saveNow", "sweep", "hasStartedRun", "nextRunStartAfter", "rescheduleForZoneChangeStep", "commitScoped"]) {
    const start = source.indexOf(`${name}(`), body = source.slice(start, source.indexOf("\n  }", start));
    expect(body, name).not.toMatch(/Array\.from\(this\.runStore\)|this\.ownerRunList|this\.runs\b|this\.runsRaw\b/);
  }
});
for (const retained of [100, 2000]) it(`P3: 200 individual completion and follow-up windows with ${retained} retained runs`, async () => {
  const f = await productionHistory(retained), i = inside(f.m);
  let measured = 0;
  for (let round = 0; round < 10; round++) {
    f.clock.now += STEP; await f.m.tick();
    for (const run of [...i.indexes.liveRuns]) {
      f.m.handleRuntimeEvent(ev("turn.started", run));
      const undo = forbidHistory(f.m);
      try {
        f.m.handleRuntimeEvent(ev("turn.completed", run, { ok: true }));
        await Promise.resolve(); await f.m.tick();
        bounded(5, 2000);
        expect(routineWorkCounters.compactCopied).toBeLessThanOrEqual(256);
        expect(routineWorkCounters.journalLines + routineWorkCounters.compactCopied).toBeLessThanOrEqual(260);
        expect(f.m.schedulerStatus().consecutiveFailures).toBe(0);
      } finally { undo(); }
      measured++;
    }
  }
  expect(measured).toBe(200); expect(f.m.verifyIndexes(true)).toEqual([]);
}, 180000);
it("P25 a mid-slice durability fault preserves the cursor and previous durable moves", () => {
  const f = fixture(), i = inside(f.m);
  for (let n = 0; n < 20; n++) definition(f.m, `Daily ${n}`, { enabled: true, schedule: { type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] } });
  for (const routine of i.routines) routine.nextRunAt! += 60000;
  i.save({ routines: i.routines });
  const real = i.journal.append.bind(i.journal); let calls = 0;
  const append = vi.spyOn(i.journal, "append").mockImplementation(input => { if (++calls === 2) throw new Error("mid-slice fault"); return real(input); });
  expect(() => f.m.rescheduleForZoneChangeStep({ offWallClockOnly: true, since: EPOCH })).toThrow("mid-slice fault");
  append.mockRestore(); const first = i.routines[0]!, second = i.routines[1]!;
  expect(new Date(first.nextRunAt!).getMinutes()).toBe(0); expect(new Date(second.nextRunAt!).getMinutes()).toBe(1);
  f.m.recoverPersistence(); resetWork();
  const retry = f.m.rescheduleForZoneChangeStep({ offWallClockOnly: true, since: EPOCH });
  expect(retry.done).toBe(false); expect(retry.moved.some(r => r.id === first.id)).toBe(false); expect(retry.moved.some(r => r.id === second.id)).toBe(true);
  expect(routineWorkCounters.zoneExamined).toBe(8);
  while (!f.m.rescheduleForZoneChangeStep({ offWallClockOnly: true, since: EPOCH }).done) { /* separate ordinary coordinator invocations */ }
  expect(f.m.verifyIndexes()).toEqual([]);
});
it("P22/P24 card arrays are clone-isolated and in-place scoped edits roll back", async () => {
  const f = fixture(), run = await manual(f), i = inside(f.m);
  f.m.cardOpened(run.threadId!, "original", "Fake");
  const clone = f.m.runWithOpenCard(run.threadId!, "original")!;
  clone.cardsOpen!.push("foreign");
  expect(run.cardsOpen).toEqual(["original"]);
  expect(() => i.commitScoped({ runs: [run] }, () => { run.cardsOpen!.push("temporary"); throw new Error("rollback"); })).toThrow("rollback");
  expect(run.cardsOpen).toEqual(["original"]);
  expect(f.m.runWithOpenCard(run.threadId!, "temporary")).toBeNull(); expect(f.m.verifyRunIndexes()).toEqual([]);
});
it("P25 runtime progress does not restart the timezone definition cursor", () => {
  const f = fixture(), i = inside(f.m);
  for (let n = 0; n < 20; n++) definition(f.m, `Daily ${n}`, { enabled: true, schedule: { type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] } });
  for (const routine of i.routines) routine.nextRunAt! += 60000;
  i.save({ routines: i.routines });
  expect(f.m.rescheduleForZoneChangeStep({ offWallClockOnly: true, since: EPOCH }).done).toBe(false);
  i.routines[0]!.threadId = "runtime-progress";
  expect(f.m.rescheduleForZoneChangeStep({ offWallClockOnly: true, since: EPOCH }).done).toBe(false);
  resetWork(); expect(f.m.rescheduleForZoneChangeStep({ offWallClockOnly: true, since: EPOCH }).done).toBe(true);
  expect(routineWorkCounters.zoneExamined).toBe(4);
});
it("P33 unknown retained trigger kinds stay an O(1) unknown origin, preserving the backfill skip", async () => {
  const f = await productionHistory(100), i = inside(f.m);
  for (const [n, run] of [...i.runStore].entries()) {
    run.threadId = "unknown-shared";
    (run as unknown as { triggerSource: string }).triggerSource = `future-or-corrupt-${n}`;
  }
  expect(i.indexes.originKindsByThread.has("unknown-shared")).toBe(false);
  [...i.runStore][0]!.triggerSource = "schedule";
  expect(i.indexes.originKindsByThread.get("unknown-shared")?.size).toBe(1);
  expect(f.m.memoryOriginKinds()("unknown-shared")).toBeUndefined();
  const undo = forbidHistory(f.m);
  try { expect(f.m.memoryOriginKinds()("unknown-shared")).toBeUndefined(); bounded(0); } finally { undo(); }
  for (const run of i.runStore) run.triggerSource = "schedule";
  expect(f.m.memoryOriginKinds()("unknown-shared")).toEqual(new Set(["schedule"]));
  expect(f.m.verifyRunIndexes()).toEqual([]);
});
it("P27 held records cannot rejoin dirty membership or resurrect after canonical removal", async () => {
  const f = fixture(), run = await manual(f), i = inside(f.m);
  f.m.failThread(run.threadId!, "Fake end");
  f.m.deleteRun(run.id);
  run.error = "late write through an old owner reference";
  expect(i.dirtyRuns.has(run)).toBe(false);
  const routine = i.routines.find(r => r.id === run.routineId)!;
  f.m.remove(routine.id); routine.name = "late removed definition";
  expect(i.dirtyRoutines.has(routine)).toBe(false);
  i.save({ runs: [run], routines: [routine] });
  expect(f.m.runById(run.id)).toBeNull();
  const disk = readRoutinesWithRuns(join(f.root, "routines.json"));
  expect(disk.runs.some((r: RoutineRun) => r.id === run.id)).toBe(false); expect(disk.routines.some((r: Routine) => r.id === routine.id)).toBe(false);
  expect(f.m.verifyIndexes()).toEqual([]);
});
it("P24 foreign tracked payload aliases are rejected before stripping or mutation", async () => {
  const f = fixture(), a = await manual(f), b = await manual(f), i = inside(f.m);
  const beforeA = plainCopy(a), beforeB = plainCopy(b);
  const supplied = { nested: b.eventBudget! };
  const original = supplied.nested;
  expect(() => i.commitScoped({ runs: [a] }, () => { a.eventBudget = b.eventBudget; })).toThrow(ScopeEscape);
  expect(() => i.commitScoped({ runs: [a] }, () => {
    Object.defineProperty(a, "foreign", { value: supplied, writable: true, enumerable: true, configurable: true });
  })).toThrow(ScopeEscape);
  expect(supplied.nested).toBe(original); expect(plainCopy(a)).toEqual(beforeA); expect(plainCopy(b)).toEqual(beforeB);
  expect(f.m.verifyIndexes()).toEqual([]);
});
it("P9 a durable timeout is needs-you in raw replay and failed only at constructor restart recovery", async () => {
  const f = fixture(), run = await manual(f);
  run.timeoutMinutes = 1; f.m.cardOpened(run.threadId!, "approval", "Please approve"); f.clock.now += 60001;
  const undo = forbidHistory(f.m);
  try { await f.m.tick(); expect(run.status).toBe("needs-you"); bounded(3, 2000); } finally { undo(); }
  const file = join(f.root, "routines.json");
  expect(readRoutinesWithRuns(file).runs.find((r: RoutineRun) => r.id === run.id).status).toBe("needs-you");
  f.m.stop();
  const reloaded = new RoutineManager({ file, now: () => f.clock.now, dispatchOpen: () => false, botState: () => "ready", createTask: () => ({ threadId: "fake" }), startTurn: async () => {} }); instances.push(reloaded);
  expect(reloaded.runById(run.id)?.status).toBe("failed"); expect(reloaded.runById(run.id)?.error).toMatch(/restarted/);
});
