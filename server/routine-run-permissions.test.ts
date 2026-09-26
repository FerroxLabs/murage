// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The scheduler half of routine approval levels: the level is stored on the
// routine (absent = inherit), survives a reload, and is reported for the run
// working in a thread so the host can judge that run at it. Webhook and
// channel work never carries one.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RoutineManager, type RoutineManagerOptions, type RoutineRun } from "./routines.ts";
import { exactCommandKey } from "../shared/exact-command.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness(file?: string) {
  const dir = mkdtempSync(join(tmpdir(), "murage-routine-perm-"));
  dirs.push(dir);
  let now = new Date(2026, 8, 25, 8, 0, 0).getTime();
  let task = 0;
  const started: Array<{ threadId: string }> = [];
  const interrupted: string[] = [];
  const needsYou: RoutineRun[] = [];
  const failed: RoutineRun[] = [];
  const options: RoutineManagerOptions = {
    file: file ?? join(dir, "routines.json"),
    now: () => now,
    botState: () => "ready",
    createTask: () => ({ threadId: `thread-${++task}` }),
    startTurn: async (_botId, threadId) => { started.push({ threadId }); },
    interruptTurn: async (_botId, threadId) => { interrupted.push(threadId); },
    onRunNeedsYou: (run) => needsYou.push(run),
    onRunFailed: (run) => failed.push(run),
  };
  return { manager: new RoutineManager(options), options, started, interrupted, needsYou, failed, file: options.file!, advance: (ms: number) => (now += ms), now: () => now };
}

const input = (at: number, extra: Record<string, unknown> = {}) => ({
  name: "RWA watch", prompt: "Sweep", botId: "dax", schedule: { type: "interval" as const, everyMinutes: 30, anchorAt: at }, ...extra,
});

describe("a routine's stored approval level", () => {
  it("is absent (inherit) unless chosen, and survives a reload", () => {
    const h = harness();
    const inherit = h.manager.create(input(h.now()));
    expect(inherit).not.toHaveProperty("permissionMode");
    const chosen = h.manager.create(input(h.now(), { permissionMode: "full" }));
    expect(chosen.permissionMode).toBe("full");
    const reloaded = new RoutineManager({ ...h.options });
    expect(reloaded.listRoutines().find((routine) => routine.id === chosen.id)?.permissionMode).toBe("full");
    expect(reloaded.listRoutines().find((routine) => routine.id === inherit.id)).not.toHaveProperty("permissionMode");
  });

  it("goes back to inherit, and refuses a level that does not exist", () => {
    const h = harness();
    const routine = h.manager.create(input(h.now(), { permissionMode: "unlimited" }));
    expect(h.manager.update(routine.id, { permissionMode: "inherit" })).not.toHaveProperty("permissionMode");
    expect(h.manager.update(routine.id, { permissionMode: "ask" })?.permissionMode).toBe("ask");
    // an unrelated edit keeps it
    expect(h.manager.update(routine.id, { name: "Renamed" })?.permissionMode).toBe("ask");
    expect(() => h.manager.update(routine.id, { permissionMode: "root" as never })).toThrow(/approval level/);
    expect(() => h.manager.create(input(h.now(), { permissionMode: "root" }) as never)).toThrow(/approval level/);
  });

  it("loads an older file as inherit and drops an unknown level", () => {
    const h = harness();
    const routine = h.manager.create(input(h.now()));
    const disk = JSON.parse(readFileSync(h.file, "utf8"));
    disk.routines[0].permissionMode = "everything";
    writeFileSync(h.file, JSON.stringify(disk));
    const reloaded = new RoutineManager({ ...h.options });
    expect(reloaded.listRoutines().find((item) => item.id === routine.id)).not.toHaveProperty("permissionMode");
  });
});

describe("the routine behind a working thread", () => {
  it("names the routine and its level for a scheduled or manual run only while it works", async () => {
    const h = harness();
    const routine = h.manager.create(input(h.now(), { permissionMode: "full", enabled: false }));
    h.manager.runNow(routine.id);
    await h.manager.tick();
    const threadId = h.started[0]!.threadId;
    expect(h.manager.routineRunForThread(threadId)).toMatchObject({ routineId: routine.id, permissionMode: "full" });
    h.manager.handleRuntimeEvent({ type: "turn.completed", threadId, ok: true } as never);
    expect(h.manager.routineRunForThread(threadId)).toBeNull();
  });

  it("follows the routine's current level, and says inherit by leaving it out", async () => {
    const h = harness();
    const routine = h.manager.create(input(h.now(), { enabled: false }));
    h.manager.runNow(routine.id);
    await h.manager.tick();
    const threadId = h.started[0]!.threadId;
    expect(h.manager.routineRunForThread(threadId)).toEqual({ routineId: routine.id, botId: "dax", alwaysAllow: [] });
    h.manager.update(routine.id, { permissionMode: "auto" });
    expect(h.manager.routineRunForThread(threadId)?.permissionMode).toBe("auto");
  });

  it("never names one for webhook work", async () => {
    const h = harness();
    h.manager.enqueueWebhook({ webhookId: "hook", webhookName: "Hook", prompt: "p", botId: "dax", runOn: "ember", deliveryId: "d1", receivedAt: h.now() });
    await h.manager.tick();
    expect(h.started).toHaveLength(1);
    expect(h.manager.routineRunForThread(h.started[0]!.threadId)).toBeNull();
  });
});

describe("a routine's own always-allow list", () => {
  const exact = exactCommandKey({ engine: "claude", cwd: "/Users/ada/work", command: "curl -s https://example.com | jq ." })!;

  it("keeps scoped keys only, survives a reload, and is reported for a run", async () => {
    const h = harness();
    const routine = h.manager.create(input(h.now(), { enabled: false }));
    expect(h.manager.grantAlwaysAllow(routine.id, exact)?.alwaysAllow).toEqual([exact]);
    expect(h.manager.grantAlwaysAllow(routine.id, exact)?.alwaysAllow).toEqual([exact]);
    expect(h.manager.grantAlwaysAllow(routine.id, "stop:delete:/Users/ada/Documents/old")?.alwaysAllow).toHaveLength(2);
    expect(() => h.manager.grantAlwaysAllow(routine.id, "Bash")).toThrow(/exact command/);
    expect(() => h.manager.grantAlwaysAllow(routine.id, "Bash:git")).toThrow(/exact command/);
    expect(h.manager.grantAlwaysAllow("missing", exact)).toBeNull();
    const reloaded = new RoutineManager({ ...h.options });
    expect(reloaded.listRoutines()[0]?.alwaysAllow).toEqual([exact, "stop:delete:/Users/ada/Documents/old"]);
    h.manager.runNow(routine.id);
    await h.manager.tick();
    expect(h.manager.routineRunForThread(h.started[0]!.threadId)?.alwaysAllow).toEqual([exact, "stop:delete:/Users/ada/Documents/old"]);
  });

  it("is not something an edit can write, and removing the last one clears it", () => {
    const h = harness();
    const routine = h.manager.create({ ...input(h.now()), alwaysAllow: [exact] } as never);
    expect(routine).not.toHaveProperty("alwaysAllow");
    expect(h.manager.update(routine.id, { alwaysAllow: [exact] } as never)).not.toHaveProperty("alwaysAllow");
    h.manager.grantAlwaysAllow(routine.id, exact);
    expect(h.manager.update(routine.id, { name: "Renamed" })?.alwaysAllow).toEqual([exact]);
    expect(h.manager.revokeAlwaysAllow(routine.id, exact)).not.toHaveProperty("alwaysAllow");
  });

  it("drops a bare or unknown key a file was edited to hold", () => {
    const h = harness();
    h.manager.create(input(h.now()));
    const disk = JSON.parse(readFileSync(h.file, "utf8"));
    disk.routines[0].alwaysAllow = ["Bash", exact, "Bash:rm"];
    writeFileSync(h.file, JSON.stringify(disk));
    expect(new RoutineManager({ ...h.options }).listRoutines()[0]?.alwaysAllow).toEqual([exact]);
  });
});

describe("a run waiting on you at its run limit", () => {
  const MIN = 60_000;
  async function waitingRun(h: ReturnType<typeof harness>) {
    const routine = h.manager.create(input(h.now(), { enabled: false, timeoutMinutes: 20 }));
    h.manager.runNow(routine.id);
    await h.manager.tick();
    const threadId = h.started[0]!.threadId;
    h.manager.handleRuntimeEvent({ type: "request.opened", threadId, requestId: "r1", requestType: "permission", tool: "Bash", summary: "pkill -f x; rm -f /tmp/dax/a.txt" } as never);
    const run = () => h.manager.listRuns().find((item) => item.routineId === routine.id)!;
    return { routine, threadId, run };
  }

  it("ends as waiting on you, naming the action, instead of the generic time limit", async () => {
    const h = harness();
    const { run } = await waitingRun(h);
    h.advance(21 * MIN);
    await h.manager.enforceRunLimits();
    expect(run()).toMatchObject({ status: "needs-you", attention: "pkill -f x; rm -f /tmp/dax/a.txt" });
    expect(run().error).toBeUndefined();
    expect(h.interrupted).toEqual([]);
    expect(h.failed).toEqual([]);
    expect(h.needsYou.map((item) => item.status)).toEqual(["needs-you"]);
    // the clock has stopped: waiting longer changes nothing and says nothing new
    h.advance(120 * MIN);
    await h.manager.enforceRunLimits();
    expect(run().status).toBe("needs-you");
    expect(h.needsYou).toHaveLength(1);
    // it is not a failure for the routine's health either
    expect(h.manager.listRoutines()[0]).not.toHaveProperty("failureStreak");
  });

  it("answering resumes the same run with a fresh run limit", async () => {
    const h = harness();
    const { threadId, run } = await waitingRun(h);
    h.advance(21 * MIN);
    await h.manager.enforceRunLimits();
    h.manager.handleRuntimeEvent({ type: "request.resolved", threadId, requestId: "r1" } as never);
    expect(run()).toMatchObject({ status: "running" });
    expect(run().attention).toBeUndefined();
    h.advance(19 * MIN);
    await h.manager.enforceRunLimits();
    expect(run().status).toBe("running");
    h.manager.handleRuntimeEvent({ type: "turn.completed", threadId, ok: true } as never);
    expect(run().status).toBe("completed");
  });

  it("a run that is working, not waiting, still stops at its limit", async () => {
    const h = harness();
    const { threadId, run } = await waitingRun(h);
    h.manager.handleRuntimeEvent({ type: "request.resolved", threadId, requestId: "r1" } as never);
    h.advance(21 * MIN);
    await h.manager.enforceRunLimits();
    expect(run()).toMatchObject({ status: "failed", error: "Stopped after reaching the 20-minute run limit" });
    expect(h.interrupted).toEqual([threadId]);
  });

  it("holds the next occurrences back while it waits, and can be cancelled", async () => {
    const h = harness();
    const { routine, threadId, run } = await waitingRun(h);
    h.manager.update(routine.id, { enabled: true });
    h.advance(21 * MIN);
    await h.manager.enforceRunLimits();
    h.advance(40 * MIN);
    await h.manager.tick();
    expect(h.manager.listRuns().filter((item) => item.routineId === routine.id)).toHaveLength(1);
    expect(h.manager.listRoutines()[0]?.skippedRuns).toBeGreaterThan(0);
    expect(h.manager.isActiveThread(threadId)).toBe(true);
    expect((await h.manager.cancelRun(run().id))?.status).toBe("cancelled");
    expect(h.interrupted).toEqual([threadId]);
  });

  it("a restart cannot keep the turn, so the run fails as before", async () => {
    const h = harness();
    await waitingRun(h);
    h.advance(21 * MIN);
    await h.manager.enforceRunLimits();
    const reloaded = new RoutineManager({ ...h.options });
    expect(reloaded.listRuns()[0]).toMatchObject({ status: "failed", error: "Murage restarted while this routine was running" });
  });
});

describe("one conversation per routine", () => {
  function conversationHarness() {
    const h = harness();
    const tasks = new Set<string>();
    const busy = new Set<string>();
    const dispatched: Array<{ runId: string; reused: boolean; threadId?: string }> = [];
    let made = 0;
    h.options.createTask = () => { const threadId = `conv-${++made}`; tasks.add(threadId); return { threadId }; };
    h.options.taskExists = (_botId, threadId) => tasks.has(threadId);
    h.options.threadBusy = (_botId, threadId) => busy.has(threadId);
    h.options.onRunDispatch = (run, reused) => dispatched.push({ runId: run.id, reused, threadId: run.threadId });
    const manager = new RoutineManager(h.options);
    return { ...h, manager, tasks, busy, dispatched, made: () => made };
  }
  const finish = (h: { manager: RoutineManager }, threadId: string) =>
    h.manager.handleRuntimeEvent({ type: "turn.completed", threadId, ok: true } as never);

  it("every run of a routine works in the same conversation, and the routine remembers it", async () => {
    const h = conversationHarness();
    const routine = h.manager.create(input(h.now(), { enabled: false }));
    h.manager.runNow(routine.id);
    await h.manager.tick();
    finish(h, "conv-1");
    h.manager.runNow(routine.id);
    await h.manager.tick();
    finish(h, "conv-1");
    expect(h.started.map((item) => item.threadId)).toEqual(["conv-1", "conv-1"]);
    expect(h.made()).toBe(1);
    expect(h.manager.listRoutines()[0]?.threadId).toBe("conv-1");
    expect(h.manager.listRuns().map((run) => run.threadId)).toEqual(["conv-1", "conv-1"]);
    expect(h.dispatched.map((item) => item.reused)).toEqual([false, true]);
    // and it survives a reload
    expect(new RoutineManager({ ...h.options }).listRoutines()[0]?.threadId).toBe("conv-1");
  });

  it("waits while its conversation is busy instead of opening another", async () => {
    const h = conversationHarness();
    const routine = h.manager.create(input(h.now(), { enabled: false }));
    h.manager.runNow(routine.id);
    await h.manager.tick();
    finish(h, "conv-1");
    h.busy.add("conv-1");
    const queued = h.manager.runNow(routine.id)!;
    await h.manager.tick();
    expect(h.manager.listRuns().find((run) => run.id === queued.id)?.status).toBe("queued");
    expect(h.made()).toBe(1);
    h.busy.delete("conv-1");
    await h.manager.tick();
    expect(h.manager.listRuns().find((run) => run.id === queued.id)).toMatchObject({ status: "running", threadId: "conv-1" });
  });

  it("a manual run waits behind the routine's own live run in that conversation", async () => {
    const h = conversationHarness();
    const routine = h.manager.create(input(h.now(), { enabled: false }));
    h.manager.runNow(routine.id);
    await h.manager.tick();
    const second = h.manager.runNow(routine.id)!;
    await h.manager.tick();
    expect(h.manager.listRuns().find((run) => run.id === second.id)?.status).toBe("queued");
    finish(h, "conv-1");
    await h.manager.tick();
    expect(h.manager.listRuns().find((run) => run.id === second.id)).toMatchObject({ status: "running", threadId: "conv-1" });
  });

  it("opens a new one when the old conversation was deleted", async () => {
    const h = conversationHarness();
    const routine = h.manager.create(input(h.now(), { enabled: false }));
    h.manager.runNow(routine.id);
    await h.manager.tick();
    finish(h, "conv-1");
    h.tasks.delete("conv-1");
    h.manager.runNow(routine.id);
    await h.manager.tick();
    expect(h.started.at(-1)?.threadId).toBe("conv-2");
    expect(h.manager.listRoutines()[0]?.threadId).toBe("conv-2");
  });

  it("an edit cannot point a routine at another conversation", () => {
    const h = conversationHarness();
    const routine = h.manager.create({ ...input(h.now()), threadId: "someone-else" } as never);
    expect(routine).not.toHaveProperty("threadId");
    expect(h.manager.update(routine.id, { threadId: "someone-else" } as never)).not.toHaveProperty("threadId");
  });

  it("webhook work keeps its own conversation per delivery", async () => {
    const h = conversationHarness();
    for (const deliveryId of ["d1", "d2"]) {
      h.manager.enqueueWebhook({ webhookId: "hook", webhookName: "Hook", prompt: "p", botId: "dax", runOn: "ember", deliveryId, receivedAt: h.now() });
      await h.manager.tick();
      finish(h, h.started.at(-1)!.threadId);
    }
    expect(h.started.map((item) => item.threadId)).toEqual(["conv-1", "conv-2"]);
  });
});

// The harness's own cards (this computer's one-time consent, a paid image,
// a bot-to-bot contact) in a routine run: held open like permission cards,
// and a run whose turn ends while one is still open ends as waiting on you.
describe("a harness card in a routine run", () => {
  const MIN = 60_000;
  async function running(h: ReturnType<typeof harness>) {
    const routine = h.manager.create(input(h.now(), { enabled: false, timeoutMinutes: 20 }));
    h.manager.runNow(routine.id);
    await h.manager.tick();
    const threadId = h.started[0]!.threadId;
    const run = () => h.manager.listRuns().find((item) => item.routineId === routine.id)!;
    return { routine, threadId, run };
  }

  it("is held only in a scheduled or manual run, and marks it waiting", async () => {
    const h = harness();
    const { threadId, run } = await running(h);
    expect(h.manager.cardOpened(threadId, "host-1", "Let Dax use this computer?")).toBe(true);
    expect(run()).toMatchObject({ status: "waiting", attention: "Let Dax use this computer?" });
    expect(h.manager.cardOpened("not-a-run", "x", "y")).toBe(false);
    // answered while the turn is still going: the run carries on
    expect(h.manager.cardClosed(threadId, "host-1")).toBe(false);
    expect(run().status).toBe("running");
  });

  it("a turn that ends with the card still open ends the run as waiting on you", async () => {
    const h = harness();
    const { threadId, run } = await running(h);
    h.manager.cardOpened(threadId, "peer-1", "Dax wants to contact Kit");
    h.manager.handleRuntimeEvent({ type: "turn.completed", threadId, ok: true } as never);
    expect(run()).toMatchObject({ status: "needs-you", attention: "Dax wants to contact Kit" });
    expect(h.needsYou.map((item) => item.status)).toEqual(["needs-you"]);
    // the run limit leaves it alone; it is not a failure
    h.advance(120 * MIN);
    await h.manager.enforceRunLimits();
    expect(run().status).toBe("needs-you");
    // answering it resumes the same run in a new turn, with a fresh limit
    expect(h.manager.cardClosed(threadId, "peer-1")).toBe(true);
    expect(run()).toMatchObject({ status: "running" });
    h.manager.handleRuntimeEvent({ type: "turn.completed", threadId, ok: true } as never);
    expect(run().status).toBe("completed");
  });
});
