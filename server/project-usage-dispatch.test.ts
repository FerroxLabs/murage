// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from "vitest";
import { BUDGET_STOP, budgetStopsRun, dispatchProjectUsageTurn, accountProjectOwnerWait, accountPresentedProjectEvent, stopRunsOverBudget, type ProjectUsageRun } from "./project-usage-dispatch.ts";
import type { RoomRequest } from "./room-requests.ts";
const DAY = 24 * 60 * 60_000;
afterEach(() => vi.useRealTimers());
it.each(["assign", "review"] as const)("binds %s before dispatch, holds asks, and no clock ever stops it", async verb => {
  vi.useFakeTimers();
  const request = { id: "card-request", verb, admissionKey: "card:1" } as RoomRequest;
  const run: ProjectUsageRun = { request, generation: "turn-1", botId: "jax", engine: "fake" };
  const bindings = new Map<string, string>(), pending = new Map<string, ProjectUsageRun>(), turns = new Map<string, ProjectUsageRun>();
  const interrupt = vi.fn(), failure = vi.fn();
  const send = vi.fn(async input => {
    expect(bindings.get("turn-1")).toBe("card-request");
    expect(pending.get("desk")?.request).toBe(request);
    expect(input).toMatchObject({ holdPermissionAsks: true, holdProjectAsks: true });
    return { turnId: "provider-1" };
  });
  await dispatchProjectUsageTurn({ threadId: "desk", text: "Work" }, run, { bindings, pending, turns, project: true, send, interrupt, failure });
  expect(turns.get(JSON.stringify(["desk", "provider-1"]))?.request.id).toBe("card-request");
  expect(pending.size).toBe(0);
  // SPEC-P 5.4 (2026-09-29): a day of work, no stop; silence, Stop or the budget end it
  await vi.advanceTimersByTimeAsync(DAY);
  expect(interrupt).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  run.stop!();
  expect(interrupt).toHaveBeenCalledTimes(1);
  expect(failure).not.toHaveBeenCalled();
});
it("settles a failed dispatch against the same request once", async () => {
  vi.useFakeTimers();
  const run: ProjectUsageRun = { request: { id: "card-request", verb: "review", admissionKey: "review:1" } as RoomRequest, generation: "turn", botId: "jax", engine: "fake" };
  const failure = vi.fn(), interrupt = vi.fn();
  await expect(dispatchProjectUsageTurn({ threadId: "desk", text: "Review" }, run, { bindings: new Map(), pending: new Map(), turns: new Map(), project: true,
    send: async () => { throw new Error("dispatch failed"); }, interrupt, failure })).rejects.toThrow("dispatch failed");
  expect(failure).toHaveBeenCalledExactlyOnceWith(run);
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(interrupt).not.toHaveBeenCalled();
});

it("counts overlapping permission and question waits once for card requests", () => {
  vi.useFakeTimers();
  const enter = vi.fn(), leave = vi.fn();
  const run: ProjectUsageRun = { request: { id: "card", verb: "assign" } as RoomRequest, generation: "turn", botId: "jax", engine: "fake" };
  accountProjectOwnerWait(run, { type: "request.opened", requestId: "permission" }, enter, leave);
  accountProjectOwnerWait(run, { type: "request.opened", requestId: "question" }, enter, leave);
  accountProjectOwnerWait(run, { type: "request.opened", requestId: "question" }, enter, leave);
  expect(enter).toHaveBeenCalledTimes(1);
  accountProjectOwnerWait(run, { type: "request.resolved", requestId: "permission" }, enter, leave);
  expect(leave).not.toHaveBeenCalled();
  accountProjectOwnerWait(run, { type: "request.resolved", requestId: "question" }, enter, leave);
  accountProjectOwnerWait(run, { type: "request.resolved", requestId: "question" }, enter, leave);
  expect(leave).toHaveBeenCalledTimes(1);
});

it("folder contention is work time until the approval is presented", async () => {
  vi.useFakeTimers();
  const run: ProjectUsageRun = { request: { id: "card", verb: "assign" } as RoomRequest, generation: "g", botId: "jax", engine: "fake" };
  const interrupt = vi.fn(), enter = vi.fn(), leave = vi.fn();
  await dispatchProjectUsageTurn({ threadId: "desk", text: "Work" }, run, { bindings: new Map(), pending: new Map(), turns: new Map(), project: true,
    send: async () => ({ turnId: "turn" }), interrupt, failure: vi.fn() });
  const approval = { type: "request.opened", requestId: "approval" };
  const account = () => accountProjectOwnerWait(run, approval, enter, leave);
  expect(accountPresentedProjectEvent(approval, () => true, account)).toBe(false);
  expect(enter).not.toHaveBeenCalled();
  expect(accountPresentedProjectEvent(approval, () => false, account)).toBe(true);
  expect(enter).toHaveBeenCalledTimes(1);
  accountProjectOwnerWait(run, { type: "request.resolved", requestId: "approval" }, enter, leave);
  expect(leave).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(DAY); expect(interrupt).not.toHaveBeenCalled();
});

it("keeps concurrent desk usage and waits independent with reused provider ids", async () => {
  vi.useFakeTimers();
  const bindings = new Map<string, string>(), pending = new Map<string, ProjectUsageRun>(), turns = new Map<string, ProjectUsageRun>();
  const runs: ProjectUsageRun[] = [], interrupts = [vi.fn(), vi.fn(), vi.fn()];
  for (let i = 0; i < 3; i++) {
    const run: ProjectUsageRun = { request: { id: `request-${i}`, verb: "assign", targetThreadId: `desk-${i}` } as RoomRequest, generation: `generation-${i}`, botId: `bot-${i}`, engine: "fake" };
    runs.push(run);
    await dispatchProjectUsageTurn({ threadId: `desk-${i}`, text: "Work" }, run, { bindings, pending, turns, project: true, send: async () => ({ turnId: "reused-provider-id" }), interrupt: interrupts[i], failure: vi.fn() });
  }
  expect(turns.size).toBe(3); expect(new Set(bindings.values()).size).toBe(3);
  const enter = vi.fn();
  accountProjectOwnerWait(runs[0], { type: "request.opened", requestId: "ask" }, enter, vi.fn());
  accountProjectOwnerWait(runs[1], { type: "request.opened", requestId: "ask" }, enter, vi.fn());
  expect(enter).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(DAY);
  for (const interrupt of interrupts) expect(interrupt).not.toHaveBeenCalled();
});

it("does not settle twice when a failed start emits its terminal before rejecting", async () => {
  vi.useFakeTimers();
  const run: ProjectUsageRun = { request: { id: "card", verb: "assign" } as RoomRequest, generation: "g", botId: "jax", engine: "fake" };
  const failure = vi.fn();
  await expect(dispatchProjectUsageTurn({ threadId: "desk", text: "Work" }, run, { bindings: new Map(), pending: new Map(), turns: new Map(), project: true,
    send: async () => { run.settled = true; throw new Error("429"); }, interrupt: vi.fn(), failure })).rejects.toThrow("429");
  expect(failure).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it("removes a failed launch's provider binding before a retry can reuse the desk", async () => {
  vi.useFakeTimers();
  const run: ProjectUsageRun = { request: { id: "card", verb: "assign" } as RoomRequest, generation: "g", botId: "jax", engine: "fake" };
  const pending = new Map<string, ProjectUsageRun>(), turns = new Map<string, ProjectUsageRun>(), bindings = new Map<string, string>();
  const failure = vi.fn();
  await expect(dispatchProjectUsageTurn({ threadId: "desk", text: "Work" }, run, { bindings, pending, turns, project: true,
    send: async () => { run.providerTurnId = "rejected-start"; turns.set(JSON.stringify(["desk", run.providerTurnId]), run); throw new Error("429"); }, interrupt: vi.fn(), failure })).rejects.toThrow("429");
  expect(failure).toHaveBeenCalledExactlyOnceWith(run);
  expect(pending.size).toBe(0); expect(turns.size).toBe(0); expect(bindings.size).toBe(0);
});

it("the budget stops card work only, in its own scope, once each", () => {
  expect(budgetStopsRun({ verb: "assign" } as RoomRequest)).toBe(true);
  expect(budgetStopsRun({ verb: "review" } as RoomRequest)).toBe(true);
  expect(budgetStopsRun({ verb: "wake", workItemId: "card-3" } as RoomRequest)).toBe(true);
  expect(budgetStopsRun({ verb: "wake" } as RoomRequest)).toBe(false);
  // a room reply stops only for silence or Stop
  expect(budgetStopsRun({ verb: "room_turn" } as RoomRequest)).toBe(false);
  const run = (id: string, groupId: string, projectGoalId: string | null, verb = "assign", extra: Partial<ProjectUsageRun> = {}) =>
    ({ request: { id, groupId, projectGoalId, verb } as RoomRequest, generation: id, botId: id, engine: "fake", stop: vi.fn(), ...extra }) as ProjectUsageRun;
  const goalA = run("a", "g", "goal-1"), goalB = run("b", "g", "goal-2"), noGoal = run("c", "g", null), other = run("d", "other", "goal-1");
  const room = run("e", "g", "goal-1", "room_turn"), done = run("f", "g", "goal-1", "assign", { settled: true });
  const all = [goalA, goalB, noGoal, other, room, done, goalA];
  expect(stopRunsOverBudget(all, "g", "goal-1")).toBe(1);
  // the card and the thread say the budget stopped it, not "Stopped by you"
  expect(goalA.stop).toHaveBeenCalledExactlyOnceWith(BUDGET_STOP);
  for (const r of [goalB, noGoal, other, room, done]) expect(r.stop).not.toHaveBeenCalled();
  // a period budget covers the whole project; nothing is stopped twice
  expect(stopRunsOverBudget(all, "g", null)).toBe(2);
  expect(goalA.stop).toHaveBeenCalledTimes(1);
  expect(goalB.stop).toHaveBeenCalledTimes(1);
  expect(noGoal.stop).toHaveBeenCalledTimes(1);
  expect(other.stop).not.toHaveBeenCalled();
  // a run parked on the owner's decision spends nothing: it is left to finish
  // deciding, and the next evaluation stops it once the decision is made
  const deciding = run("h", "g", null, "assign", { asks: new Set(["approval"]) });
  expect(stopRunsOverBudget([deciding], "g", null)).toBe(0);
  deciding.asks!.clear();
  expect(stopRunsOverBudget([deciding], "g", null)).toBe(1);
});
