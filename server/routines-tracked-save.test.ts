// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.2 bgwork: an incremental save writes everything that changed, whichever path changed it.
// Every run, routine and the receipt list sit behind a write-tracking proxy (tracked-state.ts), so a path that
// changes persisted state without naming it to save() is still written by the next save, journal-only or full.
// And the "Prepare to reinstall Murage 1.0.1" step folds the journal-only state into the files 1.0.1 reads.
import { existsSync, readFileSync, readdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoutineManager, type RoutineManagerOptions } from "./routines.ts";
import { readRoutinesWithRuns, routineRunsDir } from "./routine-runs-journal.ts";
import { downgradeInstallationMemorySchema } from "./installation-memory-downgrade.ts";
import { plainCopy, track, untracked } from "./tracked-state.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

const START = new Date(2026, 9, 12, 8, 0, 0).getTime();
const HOUR = 60 * 60_000, DAY = 24 * HOUR;
const GRANT = "stop:delete:/Users/ada/Documents/old";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Internals = { routines: any[]; runs: any[]; routineRequestReceipts: any[]; save(options?: { runs?: unknown[]; routines?: unknown[] }): void };
const internals = (m: RoutineManager) => m as unknown as Internals;

function options(file: string, clock: { now: number }): RoutineManagerOptions {
  let task = 0, goalTask = 0;
  return {
    file, now: () => clock.now,
    botState: (botId) => botId === "busy-bot" ? "busy" : "ready",
    goalState: () => "ready",
    createTask: () => ({ threadId: `thread-${++task}` }),
    createGoalTask: () => ({ threadId: `goal-thread-${++goalTask}` }),
    startTurn: async () => {},
    startGoal: async () => {},
    interruptTurn: async () => {},
    interruptGoal: async () => {},
    taskExists: () => true,
    validateInstructionPromotion: () => true,
    validateInstructionEvidence: () => true,
  };
}

const request = (requestId: string, action: "create" | "update", threadId = "chat-1") => ({
  requestId, messageId: `message-${requestId}`, botId: "bot-a", threadId, action, fingerprintVersion: 1 as const, fingerprint: "a".repeat(64),
});

/** A data folder with a bot routine running, a second routine with a failed run, a room-goal run, a queued
 * webhook run with an event budget, and a confirmation receipt, all saved. */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "murage-tracked-")); dirs.push(dir);
  const file = join(dir, "routines.json"), clock = { now: START };
  const m = new RoutineManager(options(file, clock));
  const schedule = { type: "interval" as const, everyMinutes: 60, anchorAt: START + HOUR };
  const a = m.create({ name: "A", prompt: "Report A", botId: "bot-a", target: "bot", runOn: "ember", enabled: true, schedule }, request("req-create", "create") as never);
  const b = m.create({ name: "B", prompt: "Report B", botId: "bot-b", target: "bot", runOn: "ember", enabled: true, schedule });
  const g = m.create({ name: "G", prompt: "Goal", botId: "bot-g", target: "room-goal", groupId: "group-1", runOn: "ember", enabled: false, schedule } as never);
  const running = m.runNow(a.id)!;
  const failing = m.runNow(b.id)!;
  const goal = m.runNow(g.id)!;
  await m.tick();
  const live = m.listRuns();
  const threadOf = (id: string) => live.find(run => run.id === id)!.threadId!;
  m.failThread(threadOf(failing.id), "The engine stopped");
  const webhook = m.enqueueWebhook({ webhookId: "hook-1", webhookName: "Hook", prompt: "Handle", botId: "busy-bot", runOn: "ember", deliveryId: "delivery-1", receivedAt: START });
  await m.tick();
  internals(m).save();
  return { dir, file, clock, m, a, b, g, running, failing, goal, webhook, thread: threadOf(running.id), goalThread: threadOf(goal.id) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const byId = <T extends { id: string }>(items: T[]): Record<string, T> => Object.fromEntries(items.map(item => [item.id, item]));
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

/** What a fresh start would read equals what this manager holds. */
function expectOnDisk(f: Fixture) {
  const disk = readRoutinesWithRuns(f.file);
  const memory = internals(f.m);
  expect(byId(disk.routines)).toEqual(byId(plain(memory.routines)));
  expect(byId(disk.runs)).toEqual(byId(plain(memory.runs)));
  expect(disk.routineRequestReceipts).toEqual(plain(memory.routineRequestReceipts));
}

/** Every public RoutineManager method, each driven once against the fixture. */
const DRIVERS: Record<string, (f: Fixture) => unknown> = {
  listRoutines: f => f.m.listRoutines(),
  listRuns: f => f.m.listRuns(),
  activeRunForBot: f => f.m.activeRunForBot("bot-a"),
  activeBotRunForBot: f => f.m.activeBotRunForBot("bot-a"),
  activeBotRunForThread: f => f.m.activeBotRunForThread("bot-a", f.thread),
  activeBotRunsForBot: f => f.m.activeBotRunsForBot("bot-a"),
  routineRequestReceipt: f => f.m.routineRequestReceipt("req-create"),
  routineRequestReceiptOwners: f => f.m.routineRequestReceiptOwners(),
  forgetRoutineRequestReceipt: f => expect(f.m.forgetRoutineRequestReceipt(request("req-create", "create") as never)).toBe(true),
  forgetRoutineRequestReceiptsForThread: f => expect(f.m.forgetRoutineRequestReceiptsForThread("chat-1")).toBe(1),
  reconcileRoutineRequestReceipts: f => f.m.reconcileRoutineRequestReceipts([]),
  // SL-J (6f617d1a9): Undo as the receipt. The receipt with `before` is written before the change, a webhook's result in a second write,
  // and an undo restores `before` and stamps the receipt in one write
  beginRoutineRequest: f => expect(f.m.beginRoutineRequest(request("req-begin", "update") as never, { before: null }).requestId).toBe("req-begin"),
  completeRoutineRequest: f => { f.m.beginRoutineRequest(request("req-hook", "create") as never, { kind: "webhook", before: null }); f.m.completeRoutineRequest(request("req-hook", "create") as never, "hook-9", START); },
  markRoutineRequestUndone: f => f.m.markRoutineRequestUndone("req-create", START + 1),
  undoRoutineRequest: f => {
    const routine = f.m.listRoutines().find(item => item.id === f.a.id)!;
    expect(f.m.undoRoutineRequest("req-create", f.a.id, routine.updatedAt, { patch: { name: "Undone" } })).toBe("undone");
  },
  isActiveThread: f => f.m.isActiveThread(f.thread),
  activeRunOrigin: f => f.m.activeRunOrigin(f.thread),
  liveRunThreadIds: f => { expect(f.m.liveRunThreadIds("bot-a")).toBeInstanceOf(Set); },
  cardOpened: f => expect(f.m.cardOpened(f.thread, "card-1", "Approve the write")).toBe(true),
  cardClosed: f => { f.m.cardOpened(f.thread, "card-1", "Approve the write"); f.m.cardClosed(f.thread, "card-1"); },
  routineRunForThread: f => f.m.routineRunForThread(f.thread),
  routineForConversation: f => f.m.routineForConversation(f.thread),
  grantAlwaysAllow: f => expect(f.m.grantAlwaysAllow(f.a.id, GRANT)?.alwaysAllow).toEqual([GRANT]),
  revokeAlwaysAllow: f => { f.m.grantAlwaysAllow(f.a.id, GRANT); expect(f.m.revokeAlwaysAllow(f.a.id, GRANT)?.alwaysAllow ?? []).toEqual([]); },
  grantAlwaysAllowSet: f => expect(f.m.grantAlwaysAllowSet(f.a.id, [GRANT])?.alwaysAllow).toEqual([GRANT]),
  rememberAlwaysAllowSet: f => expect(f.m.rememberAlwaysAllowSet(f.a.id, [GRANT])?.added).toEqual([GRANT]),
  // plans only: nothing is written, and the plan names the key it would add
  planAlwaysAllowSet: f => expect(f.m.planAlwaysAllowSet(f.a.id, [GRANT])?.added).toEqual([GRANT]),
  create: f => f.m.create({ name: "New", prompt: "New", botId: "bot-n", target: "bot", runOn: "ember", enabled: true, schedule: { type: "interval", everyMinutes: 30, anchorAt: START + DAY } }),
  update: f => f.m.update(f.a.id, { name: "Renamed", schedule: { type: "interval", everyMinutes: 90, anchorAt: START + 2 * HOUR } }),
  promoteInstructions: f => promote(f),
  rollbackInstructions: f => {
    const promoted = promote(f);
    f.m.rollbackInstructions(f.a.id, promoted.instructionRevision!, promoted.updatedAt, f.a.instructionRevision!);
  },
  remove: f => expect(f.m.remove(f.b.id)).toBe(true),
  disableForBot: f => f.m.disableForBot("bot-a"),
  disableForGroup: f => f.m.disableForGroup("group-1"),
  rescheduleForZoneChange: f => {
    const daily = f.m.create({ name: "Daily", prompt: "Report", botId: "bot-a", target: "bot", runOn: "ember", enabled: true, schedule: { type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] } });
    // a next time worked out in the old zone
    internals(f.m).routines.find((routine: { id: string }) => routine.id === daily.id)!.nextRunAt! += HOUR;
    expect(f.m.rescheduleForZoneChange().map((routine) => routine.id)).toEqual([daily.id]);
  },
  runNow: f => expect(f.m.runNow(f.b.id)).not.toBeNull(),
  enqueueWebhook: f => f.m.enqueueWebhook({ webhookId: "hook-2", webhookName: "Hook 2", prompt: "Handle 2", botId: "busy-bot", runOn: "ember", deliveryId: "delivery-2", receivedAt: START }),
  findWebhookDelivery: f => f.m.findWebhookDelivery("hook-1", "delivery-1"),
  getEventBudget: f => f.m.getEventBudget(f.webhook.id),
  admitEventAction: f => expect(f.m.admitEventAction(f.webhook.id, "admission-1", "create")).toBe(true),
  closeEventBudget: f => expect(f.m.closeEventBudget(f.webhook.id)).toBe(true),
  admitEventActionDetailed: f => expect(f.m.admitEventActionDetailed(f.webhook.id, "admission-2", "handoff").ok).toBe(true),
  eventAdmissionExists: f => { f.m.admitEventAction(f.webhook.id, "admission-3", "create"); expect(f.m.eventAdmissionExists(f.webhook.id, "admission-3")).toBe(true); },
  eventAdmissionReceipt: f => { f.m.admitEventAction(f.webhook.id, "admission-4", "create"); f.m.eventAdmissionReceipt(f.webhook.id, "admission-4"); },
  recordEventAdmissionReceipt: f => { f.m.admitEventAction(f.webhook.id, "admission-5", "create"); expect(f.m.recordEventAdmissionReceipt(f.webhook.id, "admission-5", "done:task-1")).toBe(true); },
  releaseEventAdmission: f => { f.m.admitEventAction(f.webhook.id, "admission-6", "create"); expect(f.m.releaseEventAdmission(f.webhook.id, "admission-6")).toBe(true); },
  raiseEventLimit: f => expect(f.m.raiseEventLimit(f.webhook.id, "create", 5)).not.toBeNull(),
  extendEventBudget: f => expect(f.m.extendEventBudget(f.webhook.id, "handoff")).not.toBeNull(),
  declineEventKind: f => { f.m.declineEventKind(f.webhook.id, "handoff"); expect(f.m.eventKindDeclined(f.webhook.id, "handoff")).toBe(true); },
  eventKindDeclined: f => f.m.eventKindDeclined(f.webhook.id, "create"),
  interruptUnresolvedEventTimeouts: f => { f.m.admitEventAction(f.webhook.id, "admission-7", "handoff"); f.m.recordEventAdmissionReceipt(f.webhook.id, "admission-7", "timeout:task-9"); expect(f.m.interruptUnresolvedEventTimeouts(() => false)).toBe(1); },
  listRoutineNames: f => f.m.listRoutineNames(),
  activeWebhookRunCount: f => f.m.activeWebhookRunCount("hook-1"),
  cancelQueuedWebhook: f => f.m.cancelQueuedWebhook("hook-1", "The webhook was removed"),
  cancelRun: f => f.m.cancelRun(f.running.id),
  markAllSeen: f => expect(f.m.markAllSeen().length).toBeGreaterThan(0),
  markSeen: f => f.m.markSeen(f.failing.id),
  deleteRun: f => { expect(f.m.deleteRun(f.failing.id)?.id).toBe(f.failing.id); expect(f.m.listRuns().some(run => run.id === f.failing.id)).toBe(false); },
  start: f => { f.m.start(); f.m.stop(); },
  stop: f => f.m.stop(),
  enforceRunLimits: async f => { f.clock.now += 3 * DAY; await f.m.enforceRunLimits(); },
  tick: async f => { f.clock.now = START + 3 * HOUR; await f.m.tick(); },
  schedulerStatus: f => f.m.schedulerStatus(),
  unloadable: f => f.m.unloadable(),
  noteRunLine: f => f.m.noteRunLine(f.thread, "Ran a write whose folder Murage could not read: x"),
  handleRuntimeEvent: f => f.m.handleRuntimeEvent({ eventId: "done-1", provider: "fake", threadId: f.thread, createdAt: new Date(START).toISOString(), type: "turn.completed", ok: true } as never),
  failThread: f => f.m.failThread(f.thread, "Stopped"),
  finishGoalRun: f => f.m.finishGoalRun(f.goal.id, "completed", "Done"),
  runSeatWait: f => { f.m.runSeatWait(f.running.id, "working-folder"); f.m.runSeatWait(f.running.id, null); },
  notePinnedBundle: f => f.m.notePinnedBundle(f.thread, "bundle-1"),
  preparePackageAddition: f => {
    const routine = { ...f.m.listRoutines().find(item => item.id === f.b.id)!, id: "imported-1", name: "Imported", enabled: false, nextRunAt: null };
    delete (routine as { failureStreak?: number }).failureStreak;
    f.m.preparePackageAddition([routine]).publish();
  },
};

function promote(f: Fixture) {
  const routine = f.m.listRoutines().find(item => item.id === f.a.id)!;
  return f.m.promoteInstructions(f.a.id, { expectedRevision: routine.instructionRevision!, expectedUpdatedAt: routine.updatedAt, prompt: "Learned method", evaluationReceiptId: "receipt-1", evidence: [{ kind: "source", id: "source", revision: 1, scopeId: "private" }] })!;
}

/** The public methods of RoutineManager, read from its source, so a new one fails until it is driven here. */
function publicMethods(): string[] {
  const source = readFileSync(new URL("./routines.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export class RoutineManager"));
  const names = new Set<string>();
  for (const match of body.matchAll(/^ {2}(?:async )?([a-zA-Z_][a-zA-Z0-9_]*)\(/gm)) if (match[1] !== "constructor") names.add(match[1]!);
  return [...names].sort();
}

describe("every path that changes routine state reaches disk on the next save", () => {
  it("drives every public RoutineManager method", () => {
    const names = publicMethods();
    expect(names.length).toBeGreaterThan(40);
    expect(Object.keys(DRIVERS).sort()).toEqual(names);
  });

  it.each(Object.keys(DRIVERS))("%s: after one journal-only save, a fresh start reads exactly what the manager holds", async (name) => {
    const f = await fixture();
    expectOnDisk(f);
    await DRIVERS[name]!(f);
    // one save that names nothing as changed: the incremental path, as a hot path's save would take
    internals(f.m).save({ runs: [] });
    expectOnDisk(f);
    // and a restart (no stop, no flush) loads the same routines and runs
    const reloaded = new RoutineManager(options(f.file, f.clock));
    expect(byId(plain(internals(reloaded).routines))).toEqual(byId(plain(internals(f.m).routines)));
    expect(Object.keys(byId(plain(internals(reloaded).runs))).sort()).toEqual(Object.keys(byId(plain(internals(f.m).runs))).sort());
    f.m.stop(); reloaded.stop();
  }, 30_000);
});

describe("a change made off the hot paths survives a crash after one save", () => {
  it("a run field, a nested run field and a routine cursor written directly are on disk after a journal-only save", async () => {
    const f = await fixture();
    const before = readFileSync(f.file, "utf8"), beforeStat = statSync(f.file);
    const memory = internals(f.m);
    const run = memory.runs.find(item => item.id === f.running.id);
    const webhook = memory.runs.find(item => item.id === f.webhook.id);
    const routine = memory.routines.find(item => item.id === f.b.id);
    // paths that tell save() nothing: a top-level field, a nested array push, and a cursor
    run.output = "kept across the crash";
    webhook.eventBudget.admissions.push({ id: "nested-admission", kind: "create" });
    routine.nextRunAt = START + 5 * DAY;
    // a hot path's save that names something else entirely
    internals(f.m).save({ runs: [], routines: [] });
    // it was the journal-only save: routines.json itself was not rewritten
    expect(readFileSync(f.file, "utf8")).toBe(before);
    expect(statSync(f.file).mtimeMs).toBe(beforeStat.mtimeMs);
    // crash: no stop(), no flush; a new process reads the folder
    const reloaded = new RoutineManager(options(f.file, f.clock));
    const runs = byId(reloaded.listRuns());
    expect(runs[f.running.id]!.output).toBe("kept across the crash");
    expect(runs[f.webhook.id]!.eventBudget!.admissions).toContainEqual({ id: "nested-admission", kind: "create" });
    expect(reloaded.listRoutines().find(item => item.id === f.b.id)!.nextRunAt).toBe(START + 5 * DAY);
    f.m.stop(); reloaded.stop();
  }, 30_000);

  it("tracking never leaks a proxy into a copy, and reads never mark", () => {
    let writes = 0;
    const root = track({ a: { b: [1, { c: 2 }] }, d: "x" } as Record<string, any>, () => { writes += 1; });
    expect(root.a.b[1].c).toBe(2);
    expect(JSON.stringify(root)).toBe('{"a":{"b":[1,{"c":2}]},"d":"x"}');
    expect(writes).toBe(0);
    root.a.b[1].c = 3;
    expect(writes).toBe(1);
    root.e = { moved: root.a.b };
    expect(writes).toBe(2);
    // the raw state holds raw values only, so structuredClone works on it and on a plainCopy of a proxy
    expect(() => structuredClone(untracked(root))).not.toThrow();
    expect(structuredClone(plainCopy(root.e))).toEqual({ moved: [1, { c: 3 }] });
    root.d = "x";
    expect(writes).toBe(2);
  });
});

// ---- 1.0.1's reader, verbatim from server/routine-runs-journal.ts at the 1.0.1 tag (d950cbf67) ----
function parseJournal101(text: string, committed: number | undefined) {
  const runs = new Map<string, Record<string, unknown>>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    let value: Record<string, unknown> | null;
    try { value = JSON.parse(line) as Record<string, unknown> | null; } catch { continue; }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const tag = value.$c;
    if (tag !== undefined) {
      if (!Number.isSafeInteger(tag)) continue;
      if (committed !== undefined && (tag as number) > committed) continue;
    }
    const { $c: _tag, ...rest } = value;
    if (typeof rest.$del === "string") runs.delete(rest.$del);
    else if (typeof rest.id === "string") runs.set(rest.id, rest);
  }
  return runs;
}
function read101(dataDir: string) {
  const doc = JSON.parse(readFileSync(join(dataDir, "routines.json"), "utf8"));
  const committed = Number.isSafeInteger(doc.runsCommit) && doc.runsCommit >= 0 ? doc.runsCommit : undefined;
  const dir = routineRunsDir(dataDir);
  const runs: Array<Record<string, unknown>> = [];
  for (const name of existsSync(dir) ? readdirSync(dir).filter(item => item.endsWith(".jsonl")).sort() : []) runs.push(...parseJournal101(readFileSync(join(dir, name), "utf8"), committed).values());
  return { routines: doc.routines as Array<{ id: string; enabled: boolean; nextRunAt: number | null }>, runs };
}

describe("preparing to reinstall 1.0.1 folds journal-only routine state into the files 1.0.1 reads", () => {
  it("after journal-only saves, 1.0.1 sees the moved cursor and every run, so no occurrence is due again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-downgrade-")); dirs.push(dir);
    const file = join(dir, "routines.json"), clock = { now: START };
    const m = new RoutineManager(options(file, clock));
    const routine = m.create({ name: "Daily", prompt: "Report", botId: "bot-a", target: "bot", runOn: "ember", enabled: true, schedule: { type: "interval", everyMinutes: 1440, anchorAt: START + HOUR } });
    const written = readFileSync(file, "utf8");
    // the occurrence fires: cursor and new run go to the journal only
    clock.now = START + HOUR;
    await m.tick();
    const run = m.listRuns().find(item => item.routineId === routine.id)!;
    expect(run.scheduledFor).toBe(START + HOUR);
    m.handleRuntimeEvent({ eventId: "done", provider: "fake", threadId: run.threadId!, createdAt: new Date(clock.now).toISOString(), type: "turn.completed", ok: true } as never);
    const cursor = m.listRoutines()[0]!.nextRunAt;
    expect(cursor).toBe(START + HOUR + DAY);
    expect(readFileSync(file, "utf8")).toBe(written);
    // without the step, 1.0.1 would see the old cursor: the occurrence is due again and would run twice
    const unprepared = read101(dir);
    expect(unprepared.routines[0]!.nextRunAt).toBe(START + HOUR);
    expect(unprepared.routines.filter(item => item.enabled && item.nextRunAt !== null && item.nextRunAt <= clock.now)).toHaveLength(1);
    m.stop();

    // the "Prepare to reinstall Murage 1.0.1" step (memory-downgrade); no memory database in this folder
    expect(() => downgradeInstallationMemorySchema(dir, 6)).toThrow("MEMORY_DATABASE_MISSING");

    const prepared = read101(dir);
    expect(prepared.routines[0]!.nextRunAt).toBe(cursor);
    // 1.0.1's due check (enabled and nextRunAt <= now) finds nothing due now or until the next occurrence
    for (const at of [clock.now, START + HOUR + DAY - 1]) expect(prepared.routines.filter(item => item.enabled && item.nextRunAt !== null && item.nextRunAt <= at)).toHaveLength(0);
    expect(prepared.runs.filter(item => item.routineId === routine.id && item.scheduledFor === START + HOUR)).toEqual([expect.objectContaining({ id: run.id, status: "completed" })]);
    // no 1.0.2-only lines remain for 1.0.1 to skip
    for (const name of readdirSync(routineRunsDir(dir))) expect(readFileSync(join(routineRunsDir(dir), name), "utf8")).not.toContain("$routine");
    // idempotent, and 1.0.2 starting again reads the same schedule
    expect(() => downgradeInstallationMemorySchema(dir, 6)).toThrow("MEMORY_DATABASE_MISSING");
    expect(read101(dir)).toEqual(prepared);
    const again = new RoutineManager(options(file, clock));
    expect(again.listRoutines()[0]!.nextRunAt).toBe(cursor);
    expect(again.listRuns().filter(item => item.routineId === routine.id)).toHaveLength(1);
    again.stop();
  }, 30_000);
});
