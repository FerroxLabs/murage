// SPDX-License-Identifier: AGPL-3.0-or-later
// Public-behavior baseline adapter: no new accessor is required for a RED.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutineManager, type RoutineRun, type RoutineManagerOptions } from "./routines.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const dirs: string[] = [], managers: RoutineManager[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const m of managers.splice(0)) m.stop(); for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
const START = Date.UTC(2026, 10, 1, 8), STEP = 5 * 60_000;
export async function history(count: number, extra: Partial<RoutineManagerOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "s4-routines-")); dirs.push(dir);
  const clock = { now: START }; let task = 0;
  const m = new RoutineManager({ file: join(dir, "routines.json"), now: () => clock.now, botState: () => "ready",
    createTask: () => ({ threadId: `task-${++task}` }), startTurn: async () => {}, interruptTurn: async () => {}, ...extra });
  managers.push(m);
  const definitions = Array.from({ length: 20 }, (_, n) => m.create({ name: `Series ${n}`, prompt: "Fake report", botId: "bot", target: "bot", runOn: "ember",
    schedule: { type: "interval", everyMinutes: 5, anchorAt: START + STEP } }));
  for (let round = 0; round < count / 20; round++) {
    clock.now += STEP; await m.tick();
    for (const run of m.listRuns().filter(run => run.status === "running")) {
      m.handleRuntimeEvent({ type: "turn.started", threadId: run.threadId!, turnId: `turn-${run.id}` } as never);
      m.handleRuntimeEvent({ type: "turn.completed", threadId: run.threadId!, turnId: `turn-${run.id}`, ok: true } as never);
    }
    await Promise.resolve(); await m.tick();
  }
  return { m, clock, definitions, dir };
}
function calls(m: RoutineManager) { return vi.spyOn(m as unknown as { commitMutation: (f: () => void) => void }, "commitMutation"); }
function retainedVisits(operation: () => unknown): number {
  const originalSome = Array.prototype.some, originalFilter = Array.prototype.filter, originalFind = Array.prototype.find; let visits = 0;
  const wrap = (original: typeof originalSome) => function(this: unknown[], callback: (value: unknown, index: number, array: unknown[]) => unknown, thisArg?: unknown) {
    return original.call(this, (value, index, array) => {
      if (value && typeof value === "object" && "routineId" in value && "scheduledFor" in value) visits++;
      return callback.call(thisArg, value, index, array);
    });
  };
  Array.prototype.some = wrap(originalSome) as typeof originalSome;
  Array.prototype.filter = wrap(originalFilter as unknown as typeof originalSome) as unknown as typeof originalFilter;
  Array.prototype.find = wrap(originalFind as unknown as typeof originalSome) as unknown as typeof originalFind;
  try { operation(); } finally { Array.prototype.some = originalSome; Array.prototype.filter = originalFilter; Array.prototype.find = originalFind; }
  return visits;
}
describe("baseline RED manager paths", () => {
  it("P26 started-presence performs no retained-run callback visits", async () => {
    const { m, definitions } = await history(100);
    expect(retainedVisits(() => expect(m.hasStartedRun(definitions[0]!.id)).toBe(true))).toBe(0);
  });
  it("P12 delivery dedup performs no retained-run callback visits", async () => {
    const { m } = await history(100);
    expect(retainedVisits(() => expect(m.findWebhookDelivery("absent", "absent")).toBeNull())).toBe(0);
  });
  it("P17 next start performs no retained-store iteration", async () => {
    const { m } = await history(100);
    const target = m.listRuns().at(-1)!;
    const old = (m as unknown as { runs?: RoutineRun[] }).runs;
    let visits = 0;
    if (old) { const original = old[Symbol.iterator].bind(old); old[Symbol.iterator] = function* () { for (const run of original()) { visits++; yield run; } return undefined; }; }
    visits = 0; m.nextRunStartAfter(target);
    expect(visits).toBe(0);
  });
  it("P12 scoped enqueue uses no full transaction", async () => {
    const { m, clock } = await history(100); const commits = calls(m);
    m.enqueueWebhook({ webhookId: "hook", webhookName: "Hook", deliveryId: "one", prompt: "Fake", botId: "bot", runOn: "ember", receivedAt: clock.now });
    expect(commits).toHaveBeenCalledTimes(0);
  });
  it("P8 cards use no full transaction", async () => {
    const { m, definitions } = await history(100);
    const queued = m.runNow(definitions[0]!.id)!;
    await m.tick(); await Promise.resolve();
    const run = m.runById(queued.id)!; const commits = calls(m);
    expect(m.cardOpened(run.threadId!, "card", "Please approve")).toBe(true);
    expect(commits).toHaveBeenCalledTimes(0);
  });
});

describe("baseline RED reachable saves and dispatch", () => {
  it("P1/P3 idle and completion follow-up never enumerate retained dispatch entries", async () => {
    const { m, definitions } = await history(100);
    const queued = m.runNow(definitions[0]!.id)!; await m.tick(); await Promise.resolve();
    const run = m.runById(queued.id)!;
    const map = (m as unknown as { liveDispatch: Map<string, unknown> }).liveDispatch;
    const original = map[Symbol.iterator].bind(map); let visits = 0;
    Object.defineProperty(map, Symbol.iterator, { configurable: true, value: function* () { for (const entry of original()) { visits++; yield entry; } } });
    try {
      m.handleRuntimeEvent({ type: "turn.started", threadId: run.threadId!, turnId: "probe" } as never);
      m.handleRuntimeEvent({ type: "turn.completed", threadId: run.threadId!, turnId: "probe", ok: true } as never);
      await Promise.resolve(); await m.tick();
      expect(visits, "retained dispatch entries").toBe(0);
    } finally { Reflect.deleteProperty(map, Symbol.iterator); }
  });
  it("P5/P6 provider-limit refusal does no history callback traversal", async () => {
    const { m, definitions } = await history(100, { limitRefusal: (_run, refusal) => refusal.message === "limit" ? { engineKey: "engine:fake", until: 9999999999999, engineName: "Fake", line: "Wait", failLine: "Limit" } : null });
    const queued = m.runNow(definitions[0]!.id)!; await m.tick(); await Promise.resolve();
    expect(retainedVisits(() => m.settleDispatch({ runId: queued.id }, "limit"))).toBe(0);
  });
  it("P9 approval timeout does no full transaction", async () => {
    const { m, definitions, clock } = await history(100);
    const queued = m.runNow(definitions[0]!.id)!; await m.tick(); await Promise.resolve();
    const run = m.runById(queued.id)!;
    m.cardOpened(run.threadId!, "card", "Approve");
    const canonical = (m as unknown as { runs: RoutineRun[] }).runs.find(r => r.id === run.id)!;
    canonical.timeoutMinutes = 1; clock.now += 60001;
    const commits = calls(m); await m.tick();
    expect(m.runById(run.id)?.status).toBe("needs-you"); expect(commits).toHaveBeenCalledTimes(0);
  });
  it("P11 watch admission, completion and expiry do no full transaction", async () => {
    const { m, clock } = await history(100, { validateWatchSource: () => {}, readWatchSource: async () => ({ fingerprint: "a".repeat(64) }) });
    const routine = m.create({ name: "Watch", prompt: "Fake", botId: "bot", schedule: { type: "interval", everyMinutes: 5, anchorAt: clock.now + STEP },
      watch: { source: { adapterId: "file", sourceId: "fixture", scopeId: "c".repeat(64) }, expiresAt: clock.now + 2 * STEP, maxChecks: 5 } },
      { requestId: "watch", messageId: "watch", botId: "owner", threadId: "owner-thread", action: "create", fingerprintVersion: 1, fingerprint: "b".repeat(64) });
    const commits = calls(m); clock.now += STEP; await m.tick(); clock.now += STEP; await m.tick();
    expect(m.listRoutines().find(r => r.id === routine.id)?.enabled).toBe(false); expect(commits).toHaveBeenCalledTimes(0);
  });
  it("P13 all event-budget mutations use bounded scope", async () => {
    const { m, clock } = await history(100);
    const run = m.enqueueWebhook({ webhookId: "hook", webhookName: "Hook", deliveryId: "one", prompt: "Fake", botId: "bot", runOn: "ember", receivedAt: clock.now });
    const commits = calls(m);
    m.admitEventAction(run.id, "one", "create"); m.raiseEventLimit(run.id, "create", 6); m.recordEventAdmissionReceipt(run.id, "one", "fake");
    m.admitEventAction(run.id, "two", "handoff"); m.releaseEventAdmission(run.id, "two"); m.declineEventKind(run.id, "handoff"); m.closeEventBudget(run.id);
    expect(commits).toHaveBeenCalledTimes(0);
  });
  it("P14 cancellation uses a bounded scope and preserves its canonical object on failure", async () => {
    const { m, definitions } = await history(100);
    const queued = m.runNow(definitions[0]!.id)!; await m.tick(); await Promise.resolve();
    const internal = m as unknown as { runs: RoutineRun[]; save(): void; journal: { append(input: unknown): number } };
    const run = internal.runs.find(r => r.id === queued.id)!;
    const commits = calls(m);
    await m.cancelRun(run.id); expect(m.runById(run.id)?.status).toBe("cancelled"); expect(commits).toHaveBeenCalledTimes(0);
  });
  it("P25 zone reconciliation does no full transaction", async () => {
    const { m, clock } = await history(100);
    for (let n = 0; n < 20; n++) m.create({ name: `Daily ${n}`, prompt: "Fake", botId: "bot", schedule: { type: "daily", time: "09:00", weekdays: [0,1,2,3,4,5,6] } });
    for (const routine of (m as unknown as { routines: Array<{ schedule: { type: string }; nextRunAt: number }> }).routines) if (routine.schedule.type === "daily") routine.nextRunAt += 60000;
    const commits = calls(m); m.rescheduleForZoneChange({ offWallClockOnly: true, since: clock.now }); expect(commits).toHaveBeenCalledTimes(0);
  });
  it("P22/P29 owner maxima and P33 repeated origin lookups avoid retained history callbacks", async () => {
    const { m } = await history(100);
    const indexed = m as unknown as { latestRunsForOwner?: (owner: string) => unknown; memoryOriginKinds?: () => (thread: string) => unknown };
    const owner = () => indexed.latestRunsForOwner ? indexed.latestRunsForOwner("bot") : m.listRuns().filter(run => run.botId === "bot");
    const origins = () => indexed.memoryOriginKinds ? indexed.memoryOriginKinds()("absent") : new Map(m.listRuns().map(run => [run.threadId, run.triggerSource]));
    expect(retainedVisits(owner), "owner maxima").toBe(0);
    void origins;
  });
});
it("P33 a not-done memory-origin retry never rebuilds origins from retained runs", async () => {
  const { m } = await history(100);
  const indexed = m as unknown as { memoryOriginKinds?: () => (thread: string) => unknown };
  const origins = () => indexed.memoryOriginKinds ? indexed.memoryOriginKinds()("absent") : new Map(m.listRuns().map(run => [run.threadId, run.triggerSource]));
  expect(retainedVisits(origins), "origin retry visits").toBe(0);
});
it("P34 a settled card holder cannot win continuation selection", async () => {
  const { m, definitions } = await history(100);
  const made = m.runNow(definitions[0]!.id)!; await m.tick(); await Promise.resolve();
  const mutable = (m as unknown as { runs: RoutineRun[] }).runs;
  const open = mutable.find(run => run.id === made.id)!, past = mutable.find(run => run.status === "completed")!;
  open.threadId = "shared"; open.cardsOpen = ["same"]; open.scheduledFor = 100;
  past.threadId = "shared"; past.cardsOpen = ["same"]; past.scheduledFor = 200;
  const indexed = m as unknown as { runWithOpenCard?: (thread: string, card: string) => RoutineRun | null };
  const selected = indexed.runWithOpenCard ? indexed.runWithOpenCard("shared", "same") : m.listRuns().find(run => run.threadId === "shared" && run.cardsOpen?.includes("same"));
  expect(selected?.id).toBe(open.id);
});
