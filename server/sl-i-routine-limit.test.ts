// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 SL-I I3: a routine whose engine is at its limit waits for the reset
// instead of failing, and a "when a limit resets" routine fires once per reset.
// Each test names the owner's failure it prevents.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { LIMIT_RESET_DELAY_MS, RoutineManager, setLimitResetReader, type RoutineManagerOptions, type RoutineRun } from "./routines.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const roots: string[] = [];
afterEach(() => { setLimitResetReader(() => null); for (const root of roots.splice(0)) removeTempDirSync(root); });

const KEY = "engine:claude";
const HOUR = 3_600_000;

function harness(file?: string) {
  const root = mkdtempSync(join(tmpdir(), "murage-routine-limit-")); roots.push(root);
  const state = { now: Date.UTC(2026, 9, 20, 9), task: 0, until: 0 };
  const started: Array<{ threadId: string; runId?: string }> = [];
  const options: RoutineManagerOptions = {
    file: file ?? join(root, "routines.json"), now: () => state.now,
    botState: () => "ready", createTask: () => ({ threadId: `thread-${++state.task}` }),
    taskExists: () => true,
    startTurn: async (_bot, threadId, _prompt, _runOn, _trigger, _fail, _budget, _audience, runId) => { started.push({ threadId, runId }); },
    limitRefusal: (_run: RoutineRun, refusal) => {
      const text = refusal.event ? String((refusal.event as { stopReason?: string }).stopReason ?? "") : refusal.message ?? "";
      if (!/limit/.test(text)) return null;
      return { engineKey: KEY, until: state.until, engineName: "Claude", line: "Claude is at its limit; this run continues after it resets", failLine: "Claude is still at its limit, so this run stopped." };
    },
  };
  const manager = new RoutineManager(options);
  return { manager, state, started, file: options.file };
}

const refuse = (manager: RoutineManager, threadId: string, stopReason = "usage limit reached") =>
  manager.handleRuntimeEvent({ eventId: `e-${threadId}-${Math.random()}`, provider: "fake", threadId, createdAt: new Date().toISOString(), type: "turn.completed", ok: false, stopReason } as never);

it("a run refused for its engine's limit goes back to queued until the reset, then carries on in its own conversation", async () => {
  const h = harness();
  h.state.until = h.state.now + HOUR;
  const routine = h.manager.create({ botId: "b", name: "Brief", prompt: "Brief", schedule: { type: "once", at: h.state.now + 86_400_000 } });
  h.manager.start();
  h.manager.runNow(routine.id);
  await h.manager.tick();
  await vi.waitFor(() => expect(h.started).toHaveLength(1));
  refuse(h.manager, h.started[0]!.threadId);
  const waiting = h.manager.listRuns()[0]!;
  expect(waiting.status).toBe("queued");
  expect(waiting.limitWait).toMatchObject({ engineKey: KEY, until: h.state.until, n: 1 });
  expect(waiting.attention).toContain("continues after it resets");
  expect(h.manager.listRoutines()[0]!.failureStreak).toBeUndefined();
  await h.manager.tick();
  expect(h.started).toHaveLength(1);
  // restart before the reset: still waiting, nothing dispatched
  h.manager.stop();
  const again = harness(h.file);
  again.state.now = h.state.now + HOUR / 2; again.state.until = h.state.until;
  again.manager.start();
  await again.manager.tick();
  expect(again.started).toHaveLength(0);
  expect(again.manager.listRuns()[0]).toMatchObject({ status: "queued", limitWait: { n: 1 } });
  // restart after the reset: dispatched once, in the same conversation
  again.state.now = h.state.until + 1;
  await again.manager.tick();
  await vi.waitFor(() => expect(again.started).toHaveLength(1));
  expect(again.started[0]!.threadId).toBe(h.started[0]!.threadId);
  again.manager.stop();
});

it("the third refusal fails the run with its line; a plain failure still fails at once", async () => {
  const h = harness();
  h.state.until = h.state.now;
  const routine = h.manager.create({ botId: "b", name: "Brief", prompt: "Brief", schedule: { type: "once", at: h.state.now + 86_400_000 } });
  h.manager.start();
  h.manager.runNow(routine.id);
  for (let i = 1; i <= 3; i++) {
    h.state.now += 1;
    await h.manager.tick();
    await vi.waitFor(() => expect(h.started).toHaveLength(i));
    refuse(h.manager, h.started[i - 1]!.threadId);
  }
  expect(h.manager.listRuns()[0]).toMatchObject({ status: "failed", error: "Claude is still at its limit, so this run stopped." });
  h.manager.runNow(routine.id);
  await h.manager.tick();
  await vi.waitFor(() => expect(h.started).toHaveLength(4));
  refuse(h.manager, h.started[3]!.threadId, "crashed");
  expect(h.manager.listRuns().filter(run => run.status === "failed").map(run => run.error?.includes("limit"))).toEqual(expect.arrayContaining([true, false]));
  h.manager.stop();
});

it("two routines waiting on one reset are spread a minute apart", async () => {
  const h = harness();
  h.state.until = h.state.now + HOUR;
  const a = h.manager.create({ botId: "a", name: "A", prompt: "A", schedule: { type: "once", at: h.state.now + 86_400_000 } });
  const b = h.manager.create({ botId: "b", name: "B", prompt: "B", schedule: { type: "once", at: h.state.now + 86_400_000 } });
  h.manager.start();
  h.manager.runNow(a.id); h.manager.runNow(b.id);
  await h.manager.tick();
  await vi.waitFor(() => expect(h.started).toHaveLength(2));
  for (const { threadId } of h.started) refuse(h.manager, threadId);
  const untils = h.manager.listRuns().map(run => run.limitWait!.until).sort();
  expect(untils[1]! - untils[0]!).toBe(60_000);
  h.manager.stop();
});

it("a run waiting on an approval is untouched: limit waits are queued runs only", async () => {
  const h = harness();
  const routine = h.manager.create({ botId: "b", name: "Brief", prompt: "Brief", schedule: { type: "once", at: h.state.now + 86_400_000 } });
  h.manager.start();
  h.manager.runNow(routine.id);
  await h.manager.tick();
  await vi.waitFor(() => expect(h.started).toHaveLength(1));
  h.manager.handleRuntimeEvent({ type: "request.opened", threadId: h.started[0]!.threadId, requestId: "ask", requestType: "permission", tool: "Bash", summary: "ls" } as never);
  expect(h.manager.listRuns()[0]).toMatchObject({ status: "waiting" });
  expect(h.manager.listRuns()[0]!.limitWait).toBeUndefined();
  h.manager.stop();
});

it("a 'when a limit resets' routine fires once, five minutes after the reset limit-state records", async () => {
  const h = harness();
  let resetsAt: number | null = null;
  setLimitResetReader(key => (key === KEY ? resetsAt : null));
  h.manager.create({ botId: "b", name: "After reset", prompt: "Go", schedule: { type: "limit_reset", engineKey: KEY } as never });
  h.manager.start();
  await h.manager.tick();
  expect(h.started).toHaveLength(0);
  resetsAt = h.state.now + HOUR;
  await h.manager.tick();
  expect(h.manager.listRoutines()[0]!.nextRunAt).toBe(resetsAt + LIMIT_RESET_DELAY_MS);
  h.state.now = resetsAt + LIMIT_RESET_DELAY_MS;
  await h.manager.tick();
  await vi.waitFor(() => expect(h.started).toHaveLength(1));
  h.state.now += HOUR;
  await h.manager.tick();
  await h.manager.tick();
  expect(h.started).toHaveLength(1);
  h.manager.stop();
});
