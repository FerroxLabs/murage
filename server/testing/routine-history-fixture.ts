// SPDX-License-Identifier: AGPL-3.0-or-later
import { join } from "node:path";
import { RoutineManager, type RoutineRun, type Routine, type RoutineManagerOptions, type RunIndexes } from "../routines.ts";

/** Genuine scheduled bot receipts, ten definitions, completed without acknowledging delivery. */
export async function routineHistoryFixture(dir: string, count: number) {
  if (count % 10) throw new Error("Fixture count must be divisible by ten");
  const clock = { now: Date.UTC(2026, 10, 11, 0) }, dispatched: Array<{ threadId: string; runId: string }> = [];
  let task = 0;
  const manager = new RoutineManager({
    file: join(dir, "routines.json"), now: () => clock.now, botState: () => "ready",
    maxConcurrentAutomaticRuns: 16, automaticCapCeiling: 16,
    createTask: () => ({ threadId: `fixture-thread-${++task}` }),
    startTurn: async (_bot, threadId, _prompt, _engine, _trigger, _error, _event, _generation, runId) => { dispatched.push({ threadId, runId: runId! }); },
  });
  const definitions = Array.from({ length: 10 }, (_, i) => manager.create({
    botId: `fixture-bot-${i}`, target: "bot", name: `Fixture ${i}`, prompt: "Fake work", timeoutMinutes: 30, runOn: "ember", enabled: true,
    schedule: { type: "interval", everyMinutes: 5, anchorAt: clock.now + 5 * 60_000 },
  }));
  const event = (threadId: string, type: string, extra: object = {}) => ({ type, eventId: `fixture-${threadId}-${type}`, provider: "fake", threadId, turnId: `turn-${threadId}`, createdAt: new Date(clock.now).toISOString(), ...extra }) as never;
  for (let n = 0; n < count / 10; n++) {
    clock.now += 5 * 60_000; await manager.tick();
    const batch = dispatched.splice(0);
    if (batch.length !== 10) throw new Error(`Fixture dispatched ${batch.length}, expected ten at ${n}`);
    for (const { threadId } of batch) {
      manager.handleRuntimeEvent(event(threadId, "item.completed", { itemType: "assistant_text", text: "Fake done" }));
      manager.handleRuntimeEvent(event(threadId, "turn.completed", { ok: true }));
    }
    await Promise.resolve(); await manager.tick(); await Promise.resolve();
  }
  await new Promise<void>(resolve => setImmediate(resolve));
  const runs = manager.listRuns();
  if (runs.length !== count || runs.some(run => run.status !== "completed" || run.delivery?.state !== "pending")) throw new Error(`Invalid protected fixture: wanted ${count}, got ${runs.length}`);
  return { manager, file: join(dir, "routines.json"), clock, definitions, dispatched, event, runs: runs as RoutineRun[] };
}

/** S1 seeds the canonical store directly; construction/persistence are outside every work window.
 * The existing dispatch-built fixture above remains available to its regression callers.
 * Owners: rhist-s1b (fixture/probe), rhist-h1 (H1 accessor), MAIN (deferred 1.0.20 work).
 */
export type HistoryInternals = {
  runStore: Set<RoutineRun>; indexes: RunIndexes; routines: Routine[];
  appendRun(run: RoutineRun): RoutineRun; removeRun(run: RoutineRun, tombstone?: boolean): void;
  replaceStore(runs: Iterable<RoutineRun>): void; saveFull(): void;
  save(input?: { runs?: RoutineRun[]; routines?: Routine[] }): void;
  dirtyRuns: Set<RoutineRun>; removedRuns: Map<string, RoutineRun>;
  fullSave: boolean; savedRunCount: number; savedRoutineCount: number;
  journal: import("../routine-runs-journal.ts").RoutineRunsJournal;
  liveDispatch: Map<string, unknown>; openDispatch: Set<string>;
  options: RoutineManagerOptions;
};
export const historyInside = (manager: RoutineManager) => manager as unknown as HistoryInternals;
export const HISTORY_NOW = Date.UTC(2026, 10, 11, 12);
export function seedRoutineHistory(manager: RoutineManager, count: number, definitions: Routine[], now = HISTORY_NOW, chats?: { botIds: string[]; groupIds: string[] }) {
  if (count < 10 || count % 10 || definitions.length !== 10) throw new Error("Use ten definitions and a multiple of ten receipts");
  const inside = historyInside(manager);
  // Exactly ten current-day receipts at both scales; the rest predate the seven-day query.
  // Three unseen failures are fixed live work, independent of retained successful history.
  const runs: RoutineRun[] = Array.from({ length: count }, (_, n) => {
    const routine = definitions[n < 10 ? n : 3 + n % 7]!;
    const at = n < 10 ? now - 60_000 - n : now - 8 * 86_400_000 - n;
    return { id: `history-run-${n}`, routineId: routine.id, routineName: routine.name,
      botId: routine.botId, target: routine.target, groupId: routine.groupId,
      prompt: routine.prompt, runOn: "ember", threadId: `history-thread-${n % 10}`, manual: false,
      triggerSource: "schedule", scheduledFor: at, startedAt: at, createdAt: at,
      finishedAt: now, status: n < 3 ? "failed" : "completed",
      ...(n < 3 ? { error: "Fixture failure" } : { output: "Fixture report" }),
      delivery: { state: "pending" },
    };
  });
  if (chats) for (const [n, run] of runs.entries()) {
    // Same 80 candidates and ten run-bearing chat threads at every N, including N=10.
    // Nine extra slots deepen thread zero to N/10 without changing lookup-hit cardinality.
    const slot = n % 100;
    const chat = slot < 10 ? slot : slot < 19 ? 0 : -1;
    if (chat < 0) run.threadId = `history-detached-${n}`;
    else if (chat < 6) { run.botId = chats.botIds[chat % 3]!; run.threadId = `history-chat-b${chat % 3}-${Math.floor(chat / 3)}`; }
    else { run.target = "room-goal"; run.groupId = chats.groupIds[(chat - 6) % 2]!; run.threadId = `history-chat-g${(chat - 6) % 2}-${Math.floor((chat - 6) / 2)}`; }
  }
  // Equal finish times: place the fixed three failures last so outcome state is identical at every scale.
  inside.replaceStore([...runs.slice(3), ...runs.slice(0, 3)]);
  inside.saveFull();
  inside.fullSave = false; inside.dirtyRuns.clear(); inside.removedRuns.clear();
  inside.savedRunCount = count; inside.savedRoutineCount = definitions.length;
  if (inside.runStore.size !== count) throw new Error("History was pruned during direct seeding");
  return runs;
}
export function directRoutineHistoryFixture(dir: string, count: number, options: Partial<RoutineManagerOptions> = {}) {
  const clock = { now: HISTORY_NOW }, dispatched: Array<{ threadId: string; runId: string; prompt: string }> = [];
  const recovered: RoutineRun[] = [];
  let task = 0;
  const manager = new RoutineManager({ file: join(dir, "routines.json"), now: () => clock.now,
    priorReplyCarryable: () => true, botState: () => "ready", taskExists: () => true, interruptTurn: async () => {},
    createTask: () => ({ threadId: `active-thread-${++task}` }),
    startTurn: async (_bot, threadId, prompt, _engine, _trigger, _error, _event, _generation, runId) => { dispatched.push({ threadId, runId: runId!, prompt }); },
    onRunRecovered: (_run, failed) => { recovered.push(failed); },
    ...options,
  });
  const definitions = Array.from({ length: 10 }, (_, n) => manager.create({ botId: `history-bot-${n}`,
    name: `History ${n}`, prompt: "Fixture work", target: "bot", enabled: false, runOn: "ember", carryLastReport: true,
    schedule: { type: "interval", everyMinutes: 5, anchorAt: clock.now + 300_000 }, timeoutMinutes: 5 }));
  seedRoutineHistory(manager, count, definitions, clock.now);
  const event = (run: RoutineRun, type: string, extra: object = {}) => ({ type, threadId: run.threadId!,
    turnId: `active-turn-${run.id}`, eventId: `active-${run.id}-${type}`, provider: "fake", createdAt: new Date(clock.now).toISOString(), ...extra }) as never;
  return { manager, clock, definitions, dispatched, recovered, event };
}

/** Slow reference computation intentionally kept outside measurement windows, for S2/S7 oracle consumers. */
export function routineHistoryOracle(manager: RoutineManager) {
  const runs = manager.listRuns(); // Stable scheduled order and quarantine exclusion are part of the oracle input.
  const open = (run: RoutineRun) => ["queued", "running", "waiting", "needs-you"].includes(run.status);
  return {
    chatRoutineOf: (threadId: string) => runs.find(run => run.threadId === threadId && (run.target === "room-goal" ? !!run.groupId : run.triggerSource !== "channel")),
    isAutomationThread: (threadId: string) => runs.some(run => run.threadId === threadId),
    hasCompletedRun: (routineId: string) => runs.some(run => run.routineId === routineId && run.status === "completed"),
    openRunsWhere: (predicate: (run: RoutineRun) => boolean) => runs.filter(run => open(run) && predicate(run)),
    channelRuns: (key: string) => runs.filter(run => (open(run) || !!run.eventBudget && !run.eventBudget.closed) &&
      (run.channelOrigin ? `${run.channelOrigin.platform}:${run.channelOrigin.connectionId}` === key : key === `telegram:${run.telegramConnectionId}`)),
    unseenProblems: () => runs.filter(run => (run.status === "failed" || run.status === "missed") && !run.seenAt),
    listRuns: (from?: number, to?: number) => runs.filter(run => (from == null || run.scheduledFor >= from) && (to == null || run.scheduledFor <= to)),
  };
}
