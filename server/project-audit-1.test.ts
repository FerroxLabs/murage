// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { DATA_DIR } from "./config.ts";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { initializeProjectTables, markProjectDerivedStale, prepareProjectTablesForRestore, validateProjectRows } from "./project-tables.ts";
import { channelToProjectRows } from "./project-settings.ts";
import { applyGoalEnvelopeV2 } from "./project-envelope.ts";
import { createProjectGoal, startProjectGoal, pauseProjectGoal, resumeProjectGoal } from "./project-goals.ts";
import { applyCardRunDispatched, applyCardRunFailed, applyCardRunFinished, applyCardWaiting, createProjectCard, enqueueCardRun, reassignProjectCard } from "./project-cards.ts";
import { insertRoomRequest, projectCardById, projectGoalById, roomRequestById } from "./project-records.ts";
import { handleProjectRoute, handleProjectRouteWithInterrupt, type ProjectRouteInput } from "./project-routes.ts";

mkdirSync(DATA_DIR, { recursive: true });

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const owner = { kind: "owner" as const, lineage: { origin: "desktop" as const, rootThreadId: "room", audienceFingerprint: "owner" } };
function fixture() {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  initializeProjectTables(db);
  channelToProjectRows(db, { groupId: "g", bulletin: "Rules", leadBotId: "lead", now: 1 });
  const group = { id: "g", memberIds: ["lead", "worker", "other"], threadId: "room" };
  const rowContext = { groups: [{ id: "g", channelProject: {} }], botIds: new Set(group.memberIds), now: 10 };
  const made = createProjectGoal(db, { groupId: "g", title: "Goal", now: 1 });
  if (!made.ok) throw new Error("goal setup");
  const goalId = made.goal.id;
  expect(startProjectGoal(db, { goalId, now: 2, tz: "UTC" }).ok).toBe(true);
  insertRoomRequest(db, { id: "lead-request", groupId: "g", verb: "wake", fromKind: "murage", toBotId: "lead", state: "running", admissionKey: "wake:fixture", now: 2 });
  const ctx = { groupId: "g", goalId, leadBotId: "lead", leadRequestId: "lead-request", memberIds: group.memberIds, sourceMessageIds: ["source-plan"], memberCapabilities: new Map([["worker", new Set(["shell"])], ["other", new Set<string>()]]), now: 3 };
  const route = (body: unknown, cardId?: string): ProjectRouteInput => ({ origin: "desktop", method: "PATCH", path: `/api/groups/g/board/cards/${cardId}`, body, group, query: new URLSearchParams(), now: 8 });
  function card() {
    const result = createProjectCard(db, { groupId: "g", goalId, title: "Card", assigneeBotId: "worker", actor: owner, memberIds: group.memberIds, now: 3 });
    if (!result.ok) throw new Error("card setup");
    return result.card;
  }
  function run() {
    const c = card();
    const queued = enqueueCardRun(db, { cardId: c.id, actor: owner, now: 4 });
    if (!queued.ok) throw new Error("queue setup");
    expect(applyCardRunDispatched(db, { cardId: c.id, requestId: queued.requestId, deskThreadId: "desk", now: 5 }).ok).toBe(true);
    return { cardId: c.id, requestId: queued.requestId };
  }
  return { db, ctx, rowContext, group, route, card, run };
}

it("F1 binds envelope card provenance from the server turn", () => {
  const { db, ctx } = fixture();
  expect(applyGoalEnvelopeV2(db, ctx, { v: 2, status: "assign", cards: [{ key: "a", title: "Derived", assignee: "worker" }] }).ok).toBe(true);
  const row = db.prepare("SELECT id FROM project_work_items").get()!;
  expect(projectCardById(db, String(row.id))!.sourceMessageIds).toEqual(["source-plan"]);
  expect(markProjectDerivedStale(db, ["source-plan"])).toBe(1);
  expect(projectCardById(db, String(row.id))!.stale).toBe(true);
});
it("F1 binds blocked reason sources without losing original card sources", () => {
  const { db, ctx } = fixture();
  applyGoalEnvelopeV2(db, ctx, { v: 2, status: "assign", cards: [{ key: "a", title: "Derived", assignee: "worker" }] });
  const request = db.prepare("SELECT id, work_item_id FROM room_requests WHERE verb='assign'").get()!;
  const cardId = String(request.work_item_id), requestId = String(request.id);
  expect(applyCardRunDispatched(db, { cardId, requestId, deskThreadId: "desk", now: 4 }).ok).toBe(true);
  const input = { cardId, requestId, actor: { kind: "assignee" as const, botId: "worker" }, waiting: { kind: "blocked" as const }, reason: "Derived reason", sourceMessageIds: ["source-block"], now: 5 };
  expect(applyCardWaiting(db, input).ok).toBe(true);
  expect(projectCardById(db, cardId)!.sourceMessageIds).toEqual(["source-plan", "source-block"]);
  expect(markProjectDerivedStale(db, ["source-block"])).toBe(1);
});
it("F2 failure activity contains codes and references, never descriptive text", () => {
  const { db, run } = fixture(); const input = run();
  applyCardRunFailed(db, { ...input, reason: "private derived failure", now: 6 });
  const row = db.prepare("SELECT * FROM project_activity WHERE kind='card_failed'").get()!;
  expect(JSON.parse(String(row.detail))).toEqual({ code: "engine_problem", failures: 1 });
  expect(row.request_id).toBe(input.requestId);
  expect(row.work_item_id).toBe(input.cardId);
  expect(projectCardById(db, input.cardId)!.reason).toBe("private derived failure");
});
it.each([false, true])("F3 refuses invalid goal budgets with a named restore error (missing table %s)", missingTable => {
  const { db, ctx, rowContext } = fixture();
  if (missingTable) db.exec("DROP TABLE project_goals");
  else db.prepare("UPDATE project_budgets SET goal_id='missing' WHERE goal_id=?").run(ctx.goalId);
  const before = db.prepare("SELECT * FROM project_budgets").all();
  try { validateProjectRows(db, { ...rowContext, requirePaused: false }); throw new Error("accepted invalid budget"); }
  catch (error) {
    expect(error).toMatchObject({ code: "RESTORE_WORK_NOT_PAUSED" });
    expect(String((error as Error).cause)).toContain("project_budgets");
  }
  expect(db.prepare("SELECT * FROM project_budgets").all()).toEqual(before);
});
it("F4 Start after restore creates one fresh runnable attempt", () => {
  const { db, card, rowContext } = fixture(); const c = card();
  const old = enqueueCardRun(db, { cardId: c.id, actor: owner, now: 4 });
  if (!old.ok) throw new Error("queue setup");
  prepareProjectTablesForRestore(db, rowContext);
  db.exec("UPDATE project_settings SET run_state='running'");
  const next = enqueueCardRun(db, { cardId: c.id, actor: owner, now: 11 });
  expect(next.ok).toBe(true); if (!next.ok) return;
  expect(next.requestId).not.toBe(old.requestId);
  expect(roomRequestById(db, next.requestId)).toMatchObject({ state: "queued", attempt: 2, card_generation: 1 });
  expect(projectCardById(db, c.id)).toMatchObject({ attempt: 2, generation: 0 });
  expect(enqueueCardRun(db, { cardId: c.id, actor: owner, now: 12 })).toEqual(next);
  expect(applyCardRunDispatched(db, { cardId: c.id, requestId: next.requestId, deskThreadId: "desk", now: 13 }).ok).toBe(true);
});
it("F5 reassignment cancels the superseded queued assignment", () => {
  const { db, card, group } = fixture(); const c = card();
  const old = enqueueCardRun(db, { cardId: c.id, actor: owner, now: 4 }); if (!old.ok) throw new Error("queue setup");
  const next = reassignProjectCard(db, { cardId: c.id, assigneeBotId: "other", actor: owner, memberIds: group.memberIds, now: 5 });
  expect(next.ok).toBe(true);
  expect(roomRequestById(db, old.requestId)!.state).toBe("cancelled");
  expect(applyCardRunDispatched(db, { cardId: c.id, requestId: old.requestId, deskThreadId: "old", now: 6 }).ok).toBe(false);
  if (next.ok) expect(applyCardRunDispatched(db, { cardId: c.id, requestId: next.requestId!, deskThreadId: "new", now: 7 }).ok).toBe(true);
});
it.each(["card_generation", "attempt", "to_bot_id"])("F5 dispatch refuses stale %s without changing rows", field => {
  const { db, card } = fixture(); const c = card();
  const queued = enqueueCardRun(db, { cardId: c.id, actor: owner, now: 4 }); if (!queued.ok) throw new Error("queue setup");
  db.prepare(`UPDATE room_requests SET ${field}=? WHERE id=?`).run(field === "to_bot_id" ? "other" : 99, queued.requestId);
  const beforeCard = projectCardById(db, c.id), beforeRequest = roomRequestById(db, queued.requestId);
  expect(applyCardRunDispatched(db, { cardId: c.id, requestId: queued.requestId, deskThreadId: "desk", now: 5 }).ok).toBe(false);
  expect(projectCardById(db, c.id)).toEqual(beforeCard);
  expect(roomRequestById(db, queued.requestId)).toEqual(beforeRequest);
});
it.each(["cancelled", "done"])("F6 drag to %s interrupts before changing the live card", async toState => {
  const { db, run, route } = fixture(); const input = run();
  if (toState === "done") applyCardWaiting(db, { ...input, actor: { kind: "server" }, waiting: { kind: "owner_approval" }, now: 6 });
  const c = projectCardById(db, input.cardId)!;
  const calls: string[] = [];
  const result = await handleProjectRouteWithInterrupt(db, route({ action: "move", expectedRevision: c.revision, toState, confirm: true }, c.id), async current => {
    expect(projectCardById(db, c.id)).toEqual(c); calls.push(current.id);
  });
  expect(result?.status).toBe(200); expect(calls).toEqual([c.id]);
  expect(projectCardById(db, c.id)!.state).toBe(toState);
});
it("F7 missing assignee capability refuses the entire envelope", () => {
  const { db, ctx } = fixture();
  const envelope = { v: 2, status: "assign", cards: [{ key: "a", title: "Allowed", assignee: "worker", needs: ["shell"] }, { key: "b", title: "Refused", assignee: "other", needs: ["shell"] }] };
  expect(applyGoalEnvelopeV2(db, ctx, envelope)).toMatchObject({ ok: false, refused: [{ key: "b", reason: expect.stringContaining("shell") }] });
  expect(db.prepare("SELECT COUNT(*) n FROM project_work_items").get()!.n).toBe(0);
  expect(projectGoalById(db, ctx.goalId)!.state).toBe("planning");
  ctx.memberCapabilities.set("other", new Set(["shell"]));
  expect(applyGoalEnvelopeV2(db, ctx, envelope).ok).toBe(true);
});
it("F8 replay cannot rewrite dependencies or create an identity alias cycle", () => {
  const { db, ctx } = fixture();
  const first = applyGoalEnvelopeV2(db, ctx, { v: 2, status: "assign", cards: [{ key: "a", title: "A", assignee: "worker" }, { key: "b", title: "B", assignee: "worker", dependsOn: ["a"] }] });
  if (!first.ok || first.status !== "assign") throw new Error("envelope setup");
  const a = first.cards[0]!.cardId, b = first.cards[1]!.cardId;
  const before = db.prepare("SELECT * FROM project_work_items ORDER BY id").all();
  const activity = db.prepare("SELECT * FROM project_activity").all();
  expect(applyGoalEnvelopeV2(db, ctx, { v: 2, status: "assign", cards: [{ key: "a", title: "Ignored replay", assignee: "worker", dependsOn: [b] }] }).ok).toBe(true);
  expect(db.prepare("SELECT * FROM project_work_items ORDER BY id").all()).toEqual(before);
  expect(db.prepare("SELECT * FROM project_activity").all()).toEqual(activity);
  expect(projectCardById(db, a)!.dependsOn).toEqual([]);
});
it("F9 owner review-to-todo drag sends back and invalidates evidence", () => {
  const { db, ctx, run, route } = fixture(); const input = run();
  applyCardRunFinished(db, { ...input, reviewApplies: true, now: 6 });
  db.prepare("UPDATE project_goals SET criteria=? WHERE id=?").run(JSON.stringify([{ id: "c", text: "Done", met: true, by: "owner", evidence: { kind: "message", ref: "m", workItemId: input.cardId, attempt: 1 } }]), ctx.goalId);
  const c = projectCardById(db, input.cardId)!;
  expect(handleProjectRoute(db, route({ action: "move", expectedRevision: c.revision, toState: "todo" }, c.id))).toMatchObject({ status: 200, body: { card: { state: "todo", attempt: 2 } } });
  expect(projectGoalById(db, ctx.goalId)!.criteria[0]!.met).toBe(false);
  expect(db.prepare("SELECT attempt FROM room_requests WHERE work_item_id=? AND state='queued'").get(c.id)!.attempt).toBe(2);
});
it("F10 goals-off refuses Resume and explains the effective pause without writes", () => {
  const { db, ctx } = fixture();
  pauseProjectGoal(db, { goalId: ctx.goalId, actor: owner, reason: "Pause", now: 4 });
  const before = projectGoalById(db, ctx.goalId);
  expect(resumeProjectGoal(db, { goalId: ctx.goalId, now: 5, flags: { projectsGoals: false }, memberIds: ctx.memberIds }).ok).toBe(false);
  expect(projectGoalById(db, ctx.goalId)).toEqual(before);
});
it("F10 goals-off strip is derived without writing rows", () => {
  const { db, group } = fixture();
  const before = db.prepare("SELECT * FROM project_settings").all();
  expect(handleProjectRoute(db, { method: "GET", path: "/api/groups/g/project", body: {}, group, query: new URLSearchParams(), now: 5, flags: { projectsGoals: false } })).toMatchObject({ body: { strip: { line: "Paused: goals are off" } } });
  expect(db.prepare("SELECT * FROM project_settings").all()).toEqual(before);
});

it("F1 refuses model cards when the server has not bound source messages", () => {
  const { db, ctx } = fixture();
  expect(applyGoalEnvelopeV2(db, { ...ctx, sourceMessageIds: undefined }, { v: 2, status: "assign", cards: [{ key: "a", title: "Derived", assignee: "worker" }] }).ok).toBe(false);
  expect(db.prepare("SELECT COUNT(*) n FROM project_work_items").get()!.n).toBe(0);
});
it.each([{ label: "missing", sourceMessageIds: undefined }, { label: "overflow", sourceMessageIds: Array.from({ length: 51 }, (_, i) => `source-${i}`) }])("F1 refuses missing or overflowing blocked sources without changing the card ($label)", ({ sourceMessageIds }) => {
  const { db, run } = fixture(); const input = run();
  const before = projectCardById(db, input.cardId);
  expect(applyCardWaiting(db, { ...input, actor: { kind: "assignee", botId: "worker" }, waiting: { kind: "blocked" }, reason: "Derived", sourceMessageIds, now: 6 }).ok).toBe(false);
  expect(projectCardById(db, input.cardId)).toEqual(before);
});
