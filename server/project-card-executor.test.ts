// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { initializeProjectTables } from "./project-tables.ts";
import { createProjectCard, enqueueCardRun, assignCardReview, applyCardRunFinished, retryProjectCard } from "./project-cards.ts";
import { recordProjectRoutine } from "./project-routines.ts";
import { projectCardById, type ProjectGoalState } from "./project-records.ts";
import { applyGoalPlanAccepted } from "./project-goals.ts";
import { roomRequest, reconcileRoomRequestsAtBoot, insertRoomRequest, completeRequest } from "./room-requests.ts";
import { applyCardRunEffect, cardGenerationCurrent } from "./project-turn-engine.ts";
import { createWorkAdmission } from "./work-admission.ts";
import { createProjectCardExecutor, cardRequestOwnerApproved, cardSteeringMode, cardRequestIsReview, queueRoutineCardRun, steerBusyDesk, projectRestartLine } from "./project-card-executor.ts";

const databases: DatabaseSync[] = [];
const executors: Array<{ stop(): void }> = [];
afterEach(() => { for (const executor of executors.splice(0)) executor.stop(); for (const db of databases.splice(0)) db.close(); });
function setup(goalState?: "awaiting_plan_ok", liveGoalId?: string) {
  const db = new DatabaseSync(":memory:"); databases.push(db); initializeProjectTables(db);
  db.exec("INSERT INTO project_settings(group_id,mode,lead_bot_id,updated_at) VALUES('g','ongoing','lead',1)");
  let now = 10000;
  const admission = createWorkAdmission({ restoreReview: () => false, flags: () => ({ autonomy: true, budgets: true }), threadRunning: () => false,
    speakingInRoom: () => false, directThreads: () => 0, maxThreads: 3, installCardCap: 4, rootCounters: () => ({ wakes: 0, workMs: 0 }),
    askWouldDeadlock: () => false, reachable: () => true, dependencyOpen: () => false, claimWriterRoot: () => () => {}, now: () => now });
  admission.setBudgetGate({ check: () => ({ ok: true }) });
  const restartLines: string[] = [];
  const restartCards = vi.fn((_groupId: string, cardIds: string[]) => {
    restartLines.push(projectRestartLine(cardIds.map(id => ({ name: "Jax", number: projectCardById(db, id)!.number }))));
  });
  const hooks = { restartCards, cardGenerationCurrent, cardEffect: (database: DatabaseSync, request: any) => applyCardRunEffect(database, request, { memberIds: ["lead", "jax"], now }), returnThread: () => "room" };
  const start = vi.fn();
  const executor = createProjectCardExecutor({ db: () => db, admission, now: () => now, open: () => true,
    context: () => ({ groupId: "g", isProject: true, closed: false, runState: "running", mode: "ongoing", leadBotId: "lead", boardOn: true, parallelCards: 1, ...(goalState ? {goalState, goalId:"goal-fixture"} : {}),
      ...(liveGoalId ? { goalId: liveGoalId, goalState: (db.prepare("SELECT state FROM project_goals WHERE id=?").get(liveGoalId) as { state: ProjectGoalState }).state } : {}) }),
    usable: () => true, desk: (request) => `desk-${request.toBotId}`, writerRoot: () => undefined, start, hooks, changed: vi.fn() });
  executors.push(executor);
  function card() {
    const made = createProjectCard(db, { groupId: "g", title: "Reconcile payments", assigneeBotId: "jax", actor: { kind: "owner" }, memberIds: ["lead", "jax"], now });
    if (!made.ok) throw new Error(made.reason);
    const queued = enqueueCardRun(db, { cardId: made.card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now });
    if (!queued.ok) throw new Error(queued.reason);
    db.prepare("UPDATE room_requests SET return_bot_id='lead' WHERE id=?").run(queued.requestId);
    return { id: made.card.id, requestId: queued.requestId };
  }
  return { db, executor, start, hooks, card, admission, restartCards, restartLines, advance: () => { now += 3000; } };
}
it("dispatches queued Start rows once in the desk and completes through the outbox once", () => {
  const f = setup(), card = f.card(); f.executor.pump(); f.executor.pump();
  const deliver = vi.fn();
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(projectCardById(f.db, card.id)).toMatchObject({ state: "doing", generation: 1, deskThreadId: "desk-jax" });
  f.executor.finish(card.requestId, { ok: true, resultMessageId: "result", deliver });
  f.executor.finish(card.requestId, { ok: true, resultMessageId: "result", deliver });
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(projectCardById(f.db, card.id)).toMatchObject({ state: "done", resultMessageId: "result" });
  expect(f.db.prepare("SELECT count(*) n FROM room_requests WHERE verb='wake'").get()).toMatchObject({ n: 1 });
  expect(reconcileRoomRequestsAtBoot(f.db, 20000, f.hooks).unknown).toBe(0);
});
it("serializes cards and holds the admission until terminal completion", () => {
  const f = setup(), a = f.card(); f.advance(); const b = f.card(); f.executor.pump(); f.advance(); f.executor.pump();
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(roomRequest(f.db, b.requestId)?.state).toBe("queued");
  f.executor.finish(a.requestId, { ok: true }); f.executor.pump();
  expect(f.start).toHaveBeenCalledTimes(2);
});
it("restart parks unknown cards for the owner without a lead wake or automatic retry", () => {
  const f = setup(), a = f.card(); f.executor.pump();
  expect(reconcileRoomRequestsAtBoot(f.db, 20000, f.hooks).unknown).toBe(1);
  expect(reconcileRoomRequestsAtBoot(f.db, 20001, f.hooks).unknown).toBe(0);
  expect(projectCardById(f.db, a.id)).toMatchObject({ state: "waiting", waitingOn: { kind: "restart" } });
  expect(roomRequest(f.db, a.requestId)?.state).toBe("unknown");
  f.executor.pump(); expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.restartCards).toHaveBeenCalledExactlyOnceWith("g", [a.id]);
  expect(f.restartLines).toEqual(["Jax's card 1 was interrupted by a restart. It waits for the owner: Retry step or Skip."]);
  expect(f.db.prepare("SELECT count(*) n FROM room_requests WHERE verb='wake'").get()).toMatchObject({ n: 0 });
  expect(retryProjectCard(f.db, { cardId: a.id, actor: { kind: "lead", botId: "lead" }, memberIds: ["lead", "jax"], now: 21000 }).ok).toBe(false);
  for (const claim of f.admission.liveTurns({})) claim.release(); // boot has no surviving engine claims
  const retry = retryProjectCard(f.db, { cardId: a.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, memberIds: ["lead", "jax"], now: 22000 });
  expect(retry.ok).toBe(true);
  f.advance(); f.executor.pump(); f.executor.pump();
  expect(f.start).toHaveBeenCalledTimes(2);
});
it("refuses stale completion effects while settling usage", () => {
  const f = setup(), a = f.card(); f.executor.pump();
  const settle = vi.fn(); Object.assign(f.hooks, { settleUsage: settle });
  f.db.prepare("UPDATE project_work_items SET generation=generation+1 WHERE id=?").run(a.id);
  f.executor.finish(a.requestId, { ok: true });
  expect(roomRequest(f.db, a.requestId)?.outcomeNote).toBe("superseded");
  expect(projectCardById(f.db, a.id)?.state).toBe("doing"); expect(settle).toHaveBeenCalledTimes(1);
  expect(f.db.prepare("SELECT count(*) n FROM room_requests WHERE verb='wake'").get()).toMatchObject({ n: 0 });
});
it("reports steering only when the engine supports both queueing and steer", () => {
  expect(cardSteeringMode({ capabilities: { queueing: true }, steer: async () => {} })).toBe("steer");
  expect(cardSteeringMode({ capabilities: { queueing: false }, steer: async () => {} })).toBe("queue");
  expect(cardSteeringMode({ capabilities: { queueing: true } })).toBe("queue");
});

// lane review: no verdict is recorded as such, not as changes; the lead decides
it("review runs in the reviewer desk and a missing verdict is recorded as none", () => {
  const f = setup(), a = f.card(); f.executor.pump();
  applyCardRunFinished(f.db, { cardId: a.id, requestId: a.requestId, reviewApplies: true, now: 11000 });
  const review = assignCardReview(f.db, { cardId: a.id, reviewerBotId: "lead", leadBotId: "lead", memberIds: ["lead", "jax"], now: 12000 });
  expect(review.ok).toBe(true); if (!review.ok) return;
  f.advance(); f.executor.pump();
  expect(roomRequest(f.db, review.requestId)).toMatchObject({ targetThreadId: "desk-lead", state: "running", cardGeneration: 1 });
  f.executor.finish(review.requestId, { ok: true });
  expect(roomRequest(f.db, review.requestId)?.outcomeNote).toBe("No verdict given");
  expect(projectCardById(f.db, a.id)?.state).toBe("review");
});

it("a teammate answer resumes the card desk before delivering the final handoff", () => {
  const f = setup(), a = f.card(); f.executor.pump();
  const child = insertRoomRequest(f.db, { groupId: "g", verb: "ask", fromKind: "bot", toBotId: "lead", parentId: a.requestId, admissionKey: "ask-card", now: 11000 }).request;
  f.executor.finish(a.requestId, { ok: true, resultMessageId: "intermediate" });
  expect(roomRequest(f.db, a.requestId)?.state).toBe("waiting_bot");
  completeRequest(f.db, child.id, { state: "done", now: 12000, resultMessageId: "answer" }, f.hooks);
  f.advance(); f.executor.pump();
  const continuation = f.db.prepare("SELECT id FROM room_requests WHERE admission_key=?").get(`wake:${a.requestId}`) as { id: string };
  expect(roomRequest(f.db, continuation.id)).toMatchObject({ state: "running", targetThreadId: "desk-jax" });
  f.executor.finish(continuation.id, { ok: true, resultMessageId: "final" });
  expect(projectCardById(f.db, a.id)).toMatchObject({ state: "done", resultMessageId: "final" });
  expect(f.db.prepare("SELECT count(*) n FROM room_requests WHERE verb='wake' AND to_bot_id='lead'").get()).toMatchObject({ n: 1 });
});

it("a review continuation remains read-only work", () => {
  const f = setup(), a = f.card(); f.executor.pump();
  applyCardRunFinished(f.db, { cardId: a.id, requestId: a.requestId, reviewApplies: true, now: 11000 });
  const review = assignCardReview(f.db, { cardId: a.id, reviewerBotId: "lead", leadBotId: "lead", memberIds: ["lead", "jax"], now: 12000 });
  if (!review.ok) throw new Error(review.reason);
  const wake = insertRoomRequest(f.db, { groupId: "g", verb: "wake", fromKind: "murage", parentId: review.requestId,
    workItemId: a.id, cardGeneration: 1, toBotId: "lead", admissionKey: "review-continuation", now: 13000 }).request;
  expect(cardRequestIsReview(f.db, wake)).toBe(true);
  expect(cardRequestIsReview(f.db, roomRequest(f.db, a.requestId)!)).toBe(false);
});

it("keeps a budget-refused card queued and dispatches once when the gate allows", () => {
  const f = setup(), a = f.card();
  f.admission.setBudgetGate({ check: () => ({ ok: false, budgetId: "budget", line: "Work budget reached." }) });
  f.executor.pump();
  expect(f.start).not.toHaveBeenCalled();
  expect(roomRequest(f.db, a.requestId)).toMatchObject({ state: "queued", refusal: "budget_reached" });
  f.admission.setBudgetGate({ check: () => ({ ok: true }) });
  f.advance(); f.executor.pump(); f.executor.pump();
  expect(f.start).toHaveBeenCalledTimes(1);
});

it("a routine card inherits its request and runs in the desk exactly once", () => {
  const f = setup();
  const routine = recordProjectRoutine(f.db, { groupId: "g", threadId: "routine-room", memberIds: ["lead", "jax"], runId: "run-1", botId: "jax", name: "Daily payments", prompt: "Count payments", now: 10000 });
  const request = roomRequest(f.db, routine.requestId)!;
  const queued = queueRoutineCardRun(f.db, request, 10001, f.hooks);
  expect(queued.ok).toBe(true);
  queueRoutineCardRun(f.db, request, 10002, f.hooks);
  f.executor.pump(); f.executor.pump();
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.start.mock.calls[0][0]).toMatchObject({ verb: "assign", parentId: request.id, rootId: request.rootId, rootThreadId: "routine-room", unattended: true, targetThreadId: "desk-jax" });
});
it("restart between completion and delivery retains exactly one lead wake", () => {
  const f = setup(), a = f.card(); f.executor.pump();
  const deliver = vi.fn();
  f.executor.finish(a.requestId, { ok: true, resultMessageId: "result", deliver });
  reconcileRoomRequestsAtBoot(f.db, 20000, f.hooks);
  f.executor.finish(a.requestId, { ok: true, resultMessageId: "result", deliver });
  expect(deliver).toHaveBeenCalledTimes(1);
  const wakes = f.db.prepare("SELECT state, result_message_id FROM room_requests WHERE verb='wake'").all();
  expect(wakes).toHaveLength(1);
  expect(wakes[0]).toMatchObject({ state: "queued" });
  expect(projectCardById(f.db, a.id)?.resultMessageId).toBe("result");
});
it("reports the owner restart decision in one Murage line", () => {
  expect(projectRestartLine([{ name: "Jax", number: 12 }])).toBe("Jax's card 12 was interrupted by a restart. It waits for the owner: Retry step or Skip.");
});
it("never steers a message that carries a picture: steer() is text-only, so it queues and runs as its own turn with the image", async () => {
  const steer = vi.fn(async () => true);
  const withImage = 'look at this\n\n<attached-image path="/d/attachments/a.png" />';
  expect(await steerBusyDesk({ capabilities: { queueing: true }, steer }, "desk", withImage, true)).toBe("queue");
  expect(steer).not.toHaveBeenCalled();
  expect(await steerBusyDesk({ capabilities: { queueing: true }, steer }, "desk", "no picture here", true)).toBe("steer");
  expect(steer).toHaveBeenCalledTimes(1);
});
it("steers a busy desk only on a steering engine and queues otherwise", async () => {
  const steer = vi.fn(async () => true);
  expect(await steerBusyDesk({ capabilities: { queueing: true }, steer }, "desk", "Check totals", true)).toBe("steer");
  expect(steer).toHaveBeenCalledExactlyOnceWith("desk", "Check totals", undefined, undefined); // third: the submission fence (beforeWrite), fourth: the interjection id, both absent here
  expect(await steerBusyDesk({ capabilities: { queueing: false }, steer }, "desk", "Later", true)).toBe("queue");
  expect(await steerBusyDesk({ capabilities: { queueing: true }, steer }, "desk", "Contact", false)).toBe("queue");
  expect(steer).toHaveBeenCalledTimes(1);
  expect(await steerBusyDesk({ capabilities: { queueing: true }, steer: async () => false }, "desk", "Later", true)).toBe("queue");
  expect(await steerBusyDesk({ capabilities: { queueing: true }, steer: async () => { throw new Error("ended"); } }, "desk", "Later", true)).toBe("queue");
});
it("hands the steer's fence and its id to the driver, which runs the fence right before its write", async () => {
  const steer = vi.fn(async () => "delivered" as const);
  const fence = () => {};
  expect(await steerBusyDesk({ capabilities: { queueing: true }, steer }, "desk", "Check totals", true, fence, "steer-1")).toBe("steer");
  expect(steer).toHaveBeenCalledExactlyOnceWith("desk", "Check totals", fence, "steer-1");
});
it("maps the three-state steer answer: delivered steers, rejected queues, uncertain is neither", async () => {
  const desk = (answer: "delivered" | "rejected" | "uncertain") => steerBusyDesk({ capabilities: { queueing: true }, steer: async () => answer }, "desk", "Check totals", true);
  expect(await desk("delivered")).toBe("steer");
  expect(await desk("rejected")).toBe("queue");
  expect(await desk("uncertain")).toBe("uncertain");
});

it("cancels an obsolete attempt and dispatches the next queued card", () => {
  const f = setup(), stale = f.card(); f.advance(); const next = f.card();
  f.db.prepare("UPDATE room_requests SET attempt=attempt+1 WHERE id=?").run(stale.requestId);
  expect(() => f.executor.pump()).not.toThrow();
  expect(roomRequest(f.db, stale.requestId)?.state).toBe("cancelled");
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.start.mock.calls[0][0].id).toBe(next.requestId);
});
it("isolates a dispatch refusal and continues the queue", () => {
  const f = setup(), stale = f.card(); f.advance(); const next = f.card();
  const admit = f.admission.admit.bind(f.admission);
  vi.spyOn(f.admission, "admit").mockImplementation(input => {
    const decision = admit(input);
    if (input.requestId === stale.requestId) f.db.prepare("UPDATE room_requests SET attempt=attempt+1 WHERE id=?").run(stale.requestId);
    return decision;
  });
  expect(() => f.executor.pump()).not.toThrow();
  expect(roomRequest(f.db, stale.requestId)?.state).toBe("cancelled");
  // Admission's existing stagger still applies after a refused dispatch.
  expect(roomRequest(f.db, next.requestId)?.refusal).toBe("stagger");
  f.advance(); f.executor.pump();
  expect(f.start.mock.calls[0][0].id).toBe(next.requestId);
});
it("commits terminal state and releases the claim when delivery throws", () => {
  const f = setup(), card = f.card(); f.executor.pump();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const deliver = vi.fn(() => { throw new Error("delivery failed"); });
  try {
    expect(() => f.executor.finish(card.requestId, { ok: true, deliver })).not.toThrow();
    expect(roomRequest(f.db, card.requestId)?.state).toBe("done");
    expect(projectCardById(f.db, card.id)?.state).toBe("done");
    expect(f.admission.liveTurns({})).toHaveLength(0);
    f.executor.finish(card.requestId, { ok: true, deliver });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally { warn.mockRestore(); }
});

it("an owner assign retains approval through ask continuation while awaiting plan OK", () => {
  const f = setup("awaiting_plan_ok"), a = f.card(); f.executor.pump();
  const child = insertRoomRequest(f.db, { groupId: "g", verb: "ask", fromKind: "bot", toBotId: "lead", parentId: a.requestId, admissionKey: "ask-card", now: 11000 }).request;
  f.executor.finish(a.requestId, { ok: true, resultMessageId: "intermediate" });
  expect(roomRequest(f.db, a.requestId)?.state).toBe("waiting_bot");
  completeRequest(f.db, child.id, { state: "done", now: 12000, resultMessageId: "answer" }, f.hooks);
  f.advance(); f.executor.pump();
  const continuation = f.db.prepare("SELECT id FROM room_requests WHERE admission_key=?").get(`wake:${a.requestId}`) as { id: string };
  expect(roomRequest(f.db, continuation.id)).toMatchObject({ state: "running", targetThreadId: "desk-jax" });
  f.executor.finish(continuation.id, { ok: true, resultMessageId: "final" });
  expect(projectCardById(f.db, a.id)).toMatchObject({ state: "done", resultMessageId: "final" });
  expect(f.db.prepare("SELECT count(*) n FROM room_requests WHERE verb='wake' AND to_bot_id='lead'").get()).toMatchObject({ n: 1 });
});

it.each(["attempt", "cardGeneration", "workItemId"] as const)("does not inherit approval across changed %s",field=>{
 const f=setup(),a=f.card();f.executor.pump();
 const parent=roomRequest(f.db,a.requestId)!;
 const wake={...parent,id:"wake-probe",verb:"wake" as const,fromKind:"murage" as const,parentId:parent.id};
 expect(cardRequestOwnerApproved(f.db,wake)).toBe(true);
 expect(cardRequestOwnerApproved(f.db,{...wake,[field]:field==="workItemId" ? "different-card" : Number(wake[field])+1})).toBe(false);
});

it("renders card cap, bot and silent stagger refusal lines", async () => {
  const { projectCardRefusalLine } = await import("./project-card-executor.ts");
  const f = setup(), a = f.card(); f.executor.pump(); const b = f.card();
  const queued = roomRequest(f.db, b.requestId)!;
  expect(projectCardRefusalLine(f.db, { ...queued, refusal: "bot_card_in_project" }, "Jax")).toBe("Jax is on card 1");
  expect(projectCardRefusalLine(f.db, { ...queued, refusal: "thread_running" }, "Jax")).toBe("Jax is on card 1");
  for (const refusal of ["project_card_cap", "install_card_cap"]) expect(projectCardRefusalLine(f.db, { ...queued, refusal }, "Jax")).toBe("Waiting for a free slot");
  expect(projectCardRefusalLine(f.db, { ...queued, refusal: "stagger" }, "Jax")).toBe(null);
  expect(a.id).toBeTruthy();
});

it("with plan approval on, the owner's own card runs while the lead's queued plan cards wait for the plan OK", () => {
  const f = setup(undefined, "goal-p");
  f.db.prepare("INSERT INTO project_goals(id,group_id,title,state,plan_first,created_at) VALUES('goal-p','g','Ship','planning',1,1)").run();
  const leadCards = [1, 2].map(n => {
    const made = createProjectCard(f.db, { sourceMessageIds: ["fixture-source"], groupId: "g", goalId: "goal-p", title: `Plan step ${n}`, assigneeBotId: "jax", actor: { kind: "lead", botId: "lead" }, memberIds: ["lead", "jax"], now: 10000 + n });
    if (!made.ok) throw new Error(made.reason);
    const queued = enqueueCardRun(f.db, { cardId: made.card.id, actor: { kind: "lead", botId: "lead" }, now: 10000 + n });
    if (!queued.ok) throw new Error(queued.reason);
    return { id: made.card.id, requestId: queued.requestId };
  });
  const own = createProjectCard(f.db, { groupId: "g", goalId: "goal-p", title: "Owner step", assigneeBotId: "jax", actor: { kind: "owner" }, memberIds: ["lead", "jax"], now: 10010 });
  if (!own.ok) throw new Error(own.reason);
  const ownRun = enqueueCardRun(f.db, { cardId: own.card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now: 10010 });
  if (!ownRun.ok) throw new Error(ownRun.reason);
  f.executor.pump(); f.advance(); f.executor.pump();
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.start.mock.calls[0][0].id).toBe(ownRun.requestId);
  for (const card of leadCards) expect(roomRequest(f.db, card.requestId)).toMatchObject({ state: "queued", refusal: "plan_not_approved" });
  expect(f.db.prepare("SELECT state FROM project_goals WHERE id='goal-p'").get()).toMatchObject({ state: "planning" });
  expect(applyGoalPlanAccepted(f.db, { goalId: "goal-p", now: 20000 })).toMatchObject({ ok: true, goal: { state: "awaiting_plan_ok" } });
  f.executor.finish(ownRun.requestId, { ok: true }); f.advance(); f.executor.pump();
  // lane review: the owner card's review may run; the plan's cards still wait
  expect(f.start.mock.calls.slice(1).map(call => call[0].verb)).toEqual(f.start.mock.calls.length > 1 ? ["review"] : []);
  for (const card of leadCards) expect(roomRequest(f.db, card.requestId)).toMatchObject({ state: "queued", refusal: "plan_not_approved" });
});
