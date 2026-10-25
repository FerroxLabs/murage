// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F2 (1.0.4, fix/104-routines-gate): one bad run never holds the queue, a cancelled run stays cancelled, and work
// that would run on the Cloud VM waits for Cloud approvals (designs/F2-ROUTINES-104.md r3.1, section 4).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as runCopy from "../shared/routine-run.ts";
import { RoutineManager, type RoutineManagerOptions, type RoutineRun } from "./routines.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const PROJECT_CLOSED = "This project is closed. Reopen it to run its routines.";
const CLOUD = runCopy.CLOUD_ROUTINE_NOT_YET;
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const projectNotOpen = () => Object.assign(new Error(PROJECT_CLOSED), { code: "PROJECT_NOT_OPEN" });
const enospc = () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });

type Extra = { projectOpen?: (groupId: string) => boolean; boxEngine?: (botId: string) => boolean };
function harness(extra: Partial<RoutineManagerOptions> & Extra = {}, file?: string) {
  let now = Date.UTC(2026, 9, 21, 9);
  if (!file) { const dir = mkdtempSync(join(tmpdir(), "murage-f2-")); dirs.push(dir); file = join(dir, "routines.json"); }
  let task = 0;
  const tasks: string[] = [];
  const started: Array<{ botId: string; runOn: string; trigger: string }> = [];
  const emitted: any[] = [];
  const failed: RoutineRun[] = [];
  const dispatched: string[] = [];
  const options: RoutineManagerOptions & Extra = {
    file,
    now: () => now,
    emit: (payload) => emitted.push(payload),
    botState: () => "ready",
    goalState: () => "ready",
    createTask: (botId) => { tasks.push(botId); return { threadId: `thread-${++task}` }; },
    createGoalTask: () => ({ threadId: `goal-thread-${++task}` }),
    startTurn: async (botId, _thread, _prompt, runOn, trigger) => { started.push({ botId, runOn, trigger }); },
    startGoal: async () => {},
    onRunFailed: (run) => failed.push(run),
    onRunDispatch: (run) => dispatched.push(run.id),
    ...extra,
  };
  const manager = new RoutineManager(options);
  const run = (id: string) => manager.listRuns().find((candidate) => candidate.id === id)!;
  /** A scheduled bot routine that is due now. */
  const due = (botId: string, name = `Due ${botId}`) => {
    const routine = manager.create({ botId, name, prompt: `Work for ${botId}`, schedule: { type: "once", at: now + 60_000 } });
    now += 120_000;
    return routine;
  };
  const roomRoutine = () => manager.create({ botId: "lead", name: "Room check", prompt: "Check the room", target: "room-goal", groupId: "g-closed",
    enabled: false, schedule: { type: "once", at: now + 86_400_000 } });
  return { manager, options, tasks, started, emitted, failed, dispatched, run, due, roomRoutine, file,
    advance: (ms: number) => { now += ms; } };
}

it("1: a queued run of a closed project fails with the project copy and the next due run dispatches", async () => {
  const h = harness({ projectRoutine: () => { throw projectNotOpen(); } });
  const room = h.manager.runNow(h.roomRoutine().id)!;
  h.due("other");
  await flush(); await h.manager.tick(); await flush();
  expect(h.run(room.id)).toMatchObject({ status: "failed", error: PROJECT_CLOSED });
  expect(h.started).toEqual([expect.objectContaining({ botId: "other", trigger: "schedule" })]);
  expect(h.manager.listRuns().find((candidate) => candidate.botId === "other")?.status).toBe("running");
});

it("2: any other throw before a run starts fails that run, not the queue", async () => {
  const h = harness({ projectRoutine: () => { throw new Error("boom"); } });
  const room = h.manager.runNow(h.roomRoutine().id)!;
  h.due("other");
  await flush(); await h.manager.tick(); await flush();
  expect(h.run(room.id)).toMatchObject({ status: "failed", error: "boom" });
  expect(h.started.map((start) => start.botId)).toEqual(["other"]);
});

it("3: Run now on a closed project is refused with 409 and creates no run", () => {
  const h = harness({ projectOpen: () => false });
  const routine = h.roomRoutine();
  let thrown: unknown;
  try { h.manager.runNow(routine.id); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown).toMatchObject({ message: PROJECT_CLOSED, status: 409 });
  expect(runCopy).toHaveProperty("PROJECT_CLOSED_COPY", PROJECT_CLOSED);
  expect(h.manager.listRuns()).toEqual([]);
});

it("5: a run cancelled while its connected apps are checked stays cancelled", async () => {
  const probe = deferred<boolean>();
  const h = harness({ connectorsMissing: () => probe.promise });
  h.due("a");
  const ticking = h.manager.tick();
  await vi.waitFor(() => expect(h.manager.listRuns()).toHaveLength(1));
  await flush();
  const queued = h.manager.listRuns()[0]!;
  expect(await h.manager.cancelRun(queued.id)).toMatchObject({ status: "cancelled" });
  probe.resolve(false);
  await ticking; await flush();
  expect(h.run(queued.id).status).toBe("cancelled");
  expect(h.tasks).toEqual([]);
  expect(h.dispatched).toEqual([]);
  expect(h.started).toEqual([]);
});

it("6: a run cancelled while the startup gate is pending stays cancelled", async () => {
  const gate = deferred<boolean>();
  const h = harness({ startupReady: () => gate.promise });
  h.due("a");
  const ticking = h.manager.tick();
  await vi.waitFor(() => expect(h.manager.listRuns()).toHaveLength(1));
  await flush();
  const queued = h.manager.listRuns()[0]!;
  await h.manager.cancelRun(queued.id);
  gate.resolve(true);
  await ticking; await flush();
  expect(h.run(queued.id).status).toBe("cancelled");
  expect(h.tasks).toEqual([]);
  expect(h.dispatched).toEqual([]);
});

it("7: a rollback during the probe ends the tick; the cancel holds and no stale run object is written", async () => {
  const probe = deferred<boolean>();
  const h = harness({ connectorsMissing: (botId) => botId === "a" ? probe.promise : false });
  // routines list newest first, so "b" (made first) has its run behind "a"'s in the same tick
  h.due("b");
  h.due("a");
  const ticking = h.manager.tick();
  await vi.waitFor(() => expect(h.manager.listRuns()).toHaveLength(2));
  await flush();
  const first = h.manager.listRuns().find((candidate) => candidate.botId === "a")!;
  const save = vi.spyOn(h.manager as unknown as { saveNow: () => void }, "saveNow").mockImplementationOnce(() => { throw enospc(); });
  expect(() => h.manager.create({ botId: "z", name: "Unrelated", prompt: "Later", enabled: false, schedule: { type: "once", at: Date.now() + 86_400_000 } })).toThrow(/ENOSPC/);
  save.mockRestore();
  expect(await h.manager.cancelRun(first.id)).toMatchObject({ status: "cancelled" });
  probe.resolve(false);
  await ticking; await flush();
  expect(h.run(first.id).status).toBe("cancelled");
  expect(h.tasks).toEqual([]);
  expect(h.dispatched).toEqual([]);
  // the next tick sees the live objects and dispatches normally
  await h.manager.tick(); await flush();
  expect(h.run(first.id).status).toBe("cancelled");
  expect(h.tasks).toEqual(["b"]);
});

it("8: a webhook delivery for a Cloud VM webhook fails closed and never starts", async () => {
  const h = harness();
  const queued = h.manager.enqueueWebhook({ webhookId: "hook", webhookName: "Hook", prompt: "Hook", botId: "a", runOn: "cloud", deliveryId: "d1", receivedAt: Date.now() });
  await flush(); await h.manager.tick(); await flush();
  expect(h.run(queued.id)).toMatchObject({ status: "failed", error: CLOUD });
  expect(h.tasks).toEqual([]);
  expect(h.started).toEqual([]);
});

it("9: a bot whose engine is the Cloud VM has its webhook and scheduled runs refused", async () => {
  const h = harness({ boxEngine: (botId) => botId === "boxed" });
  const hook = h.manager.enqueueWebhook({ webhookId: "hook", webhookName: "Hook", prompt: "Hook", botId: "boxed", runOn: "ember", deliveryId: "d1", receivedAt: Date.now() });
  h.due("boxed");
  await flush(); await h.manager.tick(); await flush();
  expect(h.run(hook.id)).toMatchObject({ status: "failed", error: CLOUD });
  const scheduled = h.manager.listRuns().find((candidate) => candidate.id !== hook.id)!;
  expect(scheduled).toMatchObject({ status: "failed", error: CLOUD, triggerSource: "schedule" });
  expect(h.tasks).toEqual([]);
  expect(h.started).toEqual([]);
});

it("11a: a full disk while the guard fails a run: the card and the owner hear first, the fault is counted, the queue moves", async () => {
  let projectCalls = 0;
  const h = harness({ projectRoutine: () => { projectCalls++; throw new Error("boom"); } });
  const routine = h.roomRoutine();
  const room = h.manager.runNow(routine.id)!;
  // the next save (the run's failure, in the tick runNow queued) finds the disk full
  const save = vi.spyOn(h.manager as unknown as { saveNow: () => void }, "saveNow").mockImplementationOnce(() => { throw enospc(); });
  await flush();
  await expect(h.manager.tick()).resolves.toBeUndefined();
  save.mockRestore();
  expect(h.emitted).toContainEqual(expect.objectContaining({ kind: "routine.run", run: expect.objectContaining({ id: room.id, status: "failed", error: "boom" }) }));
  expect(h.failed).toEqual([expect.objectContaining({ id: room.id, status: "failed" })]);
  expect((h.manager.schedulerStatus() as { saveFaults?: number }).saveFaults).toBe(1);
  // never dispatched again in this process; a later run dispatches and its save clears the fault count
  h.due("later");
  await h.manager.tick(); await flush();
  expect(projectCalls).toBe(1);
  expect(h.run(room.id).status).toBe("failed");
  expect(h.tasks).toEqual(["later"]);
  expect((h.manager.schedulerStatus() as { saveFaults?: number }).saveFaults).toBe(0);
});

it("11b: a full disk while the Cloud refusal fails a run, and an owner notifier that throws, never stop the tick", async () => {
  const notified: RoutineRun[] = [];
  const h = harness({ onRunFailed: (run) => { notified.push(run); throw new Error("notifier down"); } });
  const routine = h.manager.create({ botId: "a", name: "Cloud", prompt: "On the VM", runOn: "cloud", enabled: false, schedule: { type: "once", at: Date.now() + 86_400_000 } });
  const queued = h.manager.runNow(routine.id)!;
  const save = vi.spyOn(h.manager as unknown as { saveNow: () => void }, "saveNow").mockImplementationOnce(() => { throw enospc(); });
  await flush();
  await expect(h.manager.tick()).resolves.toBeUndefined();
  save.mockRestore();
  expect(h.emitted).toContainEqual(expect.objectContaining({ kind: "routine.run", run: expect.objectContaining({ id: queued.id, status: "failed", error: CLOUD }) }));
  expect(notified).toEqual([expect.objectContaining({ id: queued.id, status: "failed" })]);
  expect(h.manager.schedulerStatus()).toMatchObject({ saveFaults: 1, consecutiveFailures: 0 });
  h.due("later");
  await h.manager.tick(); await flush();
  expect(h.tasks).toEqual(["later"]);
  expect(h.manager.schedulerStatus()).toMatchObject({ saveFaults: 0 });
});

it("12: after a restart a queued closed-project run is failed on the first tick and the next run dispatches", async () => {
  const first = harness({ dispatchOpen: () => false });
  const room = first.manager.runNow(first.roomRoutine().id)!;
  first.due("other");
  await first.manager.tick(); await flush();
  expect(first.manager.listRuns().map((candidate) => candidate.status)).toEqual(["queued"]);
  first.manager.stop();
  const h = harness({ projectRoutine: () => { throw projectNotOpen(); } }, first.file);
  h.advance(240_000);
  await h.manager.tick(); await flush();
  expect(h.run(room.id)).toMatchObject({ status: "failed", error: PROJECT_CLOSED });
  expect(h.started.map((start) => start.botId)).toEqual(["other"]);
});

it("14 (guard): a locked database stays queued for a retry, and a Cloud VM manual routine is still refused", async () => {
  const h = harness({ projectRoutine: () => { throw Object.assign(new Error("database is locked"), { errcode: 5 }); } });
  const room = h.manager.runNow(h.roomRoutine().id)!;
  const cloud = h.manager.runNow(h.manager.create({ botId: "a", name: "Cloud", prompt: "On the VM", runOn: "cloud", enabled: false, schedule: { type: "once", at: Date.now() + 86_400_000 } }).id)!;
  await flush(); await h.manager.tick(); await flush();
  expect(h.run(room.id).status).toBe("queued");
  expect(h.run(cloud.id)).toMatchObject({ status: "failed", error: CLOUD });
  h.manager.stop();
});
