// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { DATA_DIR } from "./config.ts";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { initializeProjectTables, prepareProjectTablesForRestore, assertProjectTablesPaused, validateProjectRows } from "./project-tables.ts";
import { channelToProjectRows } from "./project-settings.ts";
import { applyGoalEnvelopeV2 } from "./project-envelope.ts";
import { createProjectGoal, startProjectGoal, sendProjectGoalBack } from "./project-goals.ts";
import { applyCardRunDispatched, applyCardRunFinished, assignCardReview, createProjectCard, enqueueCardRun, cancelProjectCard, restoreProjectCard, moveProjectCard } from "./project-cards.ts";
import { currentProjectBrief, insertRoomRequest, projectCardById, projectGoalById, projectSettingsFor, roomRequestById } from "./project-records.ts";
import { handleProjectRouteWithInterrupt, type ProjectRouteInput } from "./project-routes.ts";
import { projectToolBriefUpdate } from "./project-tools.ts";
import { launchVerificationServer } from "../scripts/control-murage.ts";

mkdirSync(DATA_DIR, { recursive: true });

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const owner = { kind: "owner" as const, lineage: { origin: "desktop" as const, rootThreadId: "room", audienceFingerprint: "owner" } };
function fixture() {
  const db = new DatabaseSync(":memory:"); databases.push(db); initializeProjectTables(db);
  channelToProjectRows(db, { groupId: "g", bulletin: "Rules", leadBotId: "lead", now: 1 });
  const group = { id: "g", memberIds: ["lead", "worker", "other"], threadId: "room" };
  const made = createProjectGoal(db, { groupId: "g", title: "Goal", now: 1 });
  if (!made.ok) throw new Error("goal setup");
  const goalId = made.goal.id;
  startProjectGoal(db, { goalId, now: 2, tz: "UTC" });
  insertRoomRequest(db, { id: "lead-request", groupId: "g", projectGoalId: goalId, verb: "wake", fromKind: "bot", toBotId: "lead", admissionKey: "wake:source", state: "running", rootId: "root", rootThreadId: "room", origin: "companion", audienceFingerprint: "audience", notOwnerAudience: true, unattended: true, targetThreadId: "lead-desk", now: 2 });
  const ctx = { groupId: "g", goalId, leadBotId: "lead", leadRequestId: "lead-request", memberIds: group.memberIds, sourceMessageIds: ["source"], now: 3 };
  const rows = { groups: [{ id: "g", channelProject: {} }], botIds: new Set(group.memberIds), now: 10 };
  const route = (path: string, body: unknown): ProjectRouteInput => ({ origin: "desktop", method: "PATCH", path, body, group, query: new URLSearchParams(), now: 8 });
  function card() {
    const result = createProjectCard(db, { groupId: "g", goalId, title: "Card", assigneeBotId: "worker", actor: owner, memberIds: group.memberIds, now: 3 });
    if (!result.ok) throw new Error("card setup"); return result.card;
  }
  function run() {
    const c = card(); const queued = enqueueCardRun(db, { cardId: c.id, actor: owner, now: 4 });
    if (!queued.ok) throw new Error("queue setup");
    applyCardRunDispatched(db, { cardId: c.id, requestId: queued.requestId, deskThreadId: "worker-desk", now: 5 });
    return { cardId: c.id, requestId: queued.requestId };
  }
  return { db, ctx, rows, group, route, card, run };
}
const plan = { v: 2, status: "assign", cards: [{ key: "a", title: "A", assignee: "worker" }] };
it("F1 assignments inherit the bound lead lineage and return address", () => {
  const { db, ctx } = fixture();
  expect(applyGoalEnvelopeV2(db, ctx, plan).ok).toBe(true);
  expect(db.prepare("SELECT * FROM room_requests WHERE verb='assign'").get()).toMatchObject({ parent_id: "lead-request", root_id: "root", root_thread_id: "room", origin: "companion", audience_fingerprint: "audience", not_owner_audience: 1, unattended: 1, return_bot_id: "lead" });
});
it.each(["missing", "wrong-group", "wrong-bot", "terminal"])("F1 refuses a %s lead binding without writes", kind => {
  const { db, ctx } = fixture();
  if (kind === "missing") db.exec("DELETE FROM room_requests WHERE id='lead-request'");
  if (kind === "wrong-group") db.exec("UPDATE room_requests SET group_id='elsewhere' WHERE id='lead-request'");
  if (kind === "wrong-bot") db.exec("UPDATE room_requests SET to_bot_id='other' WHERE id='lead-request'");
  if (kind === "terminal") db.exec("UPDATE room_requests SET state='done' WHERE id='lead-request'");
  expect(applyGoalEnvelopeV2(db, ctx, plan).ok).toBe(false);
  expect(db.prepare("SELECT COUNT(*) n FROM project_work_items").get()!.n).toBe(0);
});
it.each(["stop", "end"])("F2 %s interrupts every affected engine before cancellation", async action => {
  const { db, ctx, run, route } = fixture(); const running = run();
  const before = projectCardById(db, running.cardId)!;
  const calls: string[] = [];
  const input = action === "stop" ? route(`/api/groups/g/project/goals/${ctx.goalId}`, { action: "stop", expectedRevision: projectGoalById(db, ctx.goalId)!.revision }) : route("/api/groups/g", { channelProject: null });
  const result = await handleProjectRouteWithInterrupt(db, input, async target => {
    expect(projectCardById(db, before.id)).toEqual(before);
    expect(projectSettingsFor(db, "g")!.endedAt).toBeNull();
    expect(roomRequestById(db, "lead-request")!.state).toBe("running");
    calls.push(target.deskThreadId!);
  });
  expect(result?.status).toBe(200);
  expect(calls.sort()).toEqual(["lead-desk", "worker-desk"]);
  expect(roomRequestById(db, "lead-request")!.state).toBe("cancelled");
  expect(projectCardById(db, before.id)!.state).toBe("cancelled");
});
it.each(["stop", "end"])("F2 %s keeps rows when engine interruption fails", async action => {
  const { db, ctx, run, route } = fixture(); const running = run(); const before = projectCardById(db, running.cardId);
  const input = action === "stop" ? route(`/api/groups/g/project/goals/${ctx.goalId}`, { action: "stop", expectedRevision: projectGoalById(db, ctx.goalId)!.revision }) : route("/api/groups/g", { channelProject: null });
  await expect(handleProjectRouteWithInterrupt(db, input, async () => { throw new Error("not closed"); })).rejects.toThrow("not closed");
  expect(projectCardById(db, running.cardId)).toEqual(before);
  expect(projectSettingsFor(db, "g")!.endedAt).toBeNull();
});
it("F2 stale stop revision never interrupts", async () => {
  const { db, ctx, route } = fixture(); let calls = 0;
  expect(await handleProjectRouteWithInterrupt(db, route(`/api/groups/g/project/goals/${ctx.goalId}`, { action: "stop", expectedRevision: 999 }), async () => { calls++; })).toMatchObject({ status: 409 });
  expect(calls).toBe(0);
});
it("F3 archive cancels queued assignments and descendants before restore", () => {
  const { db, card } = fixture(); const c = card();
  const queued = enqueueCardRun(db, { cardId: c.id, actor: owner, now: 4 }); if (!queued.ok) throw new Error("queue setup");
  insertRoomRequest(db, { id: "child", groupId: "g", parentId: queued.requestId, verb: "ask", fromKind: "bot", admissionKey: "ask:child", now: 4 });
  insertRoomRequest(db, { id: "grandchild", groupId: "g", parentId: "child", verb: "ask", fromKind: "bot", admissionKey: "ask:grandchild", now: 4 });
  cancelProjectCard(db, { cardId: c.id, actor: owner, now: 5 }); restoreProjectCard(db, { cardId: c.id, actor: owner, now: 6 });
  for (const id of [queued.requestId, "child", "grandchild"]) expect(roomRequestById(db, id)!.state).toBe("cancelled");
  expect(applyCardRunDispatched(db, { cardId: c.id, requestId: queued.requestId, deskThreadId: "desk", now: 7 }).ok).toBe(false);
});
it("F3 cancelling a review card interrupts its reviewer before cancelling the request", async () => {
  const { db, group, run, route } = fixture(); const running = run();
  applyCardRunFinished(db, { ...running, reviewApplies: true, now: 6 });
  // The dispatcher completes the assignment before starting its review.
  db.prepare("UPDATE room_requests SET state='done', finished_at=6 WHERE id=?").run(running.requestId);
  const review = assignCardReview(db, { cardId: running.cardId, reviewerBotId: "other", leadBotId: "lead", memberIds: group.memberIds, now: 7 });
  if (!review.ok) throw new Error("review setup");
  db.prepare("UPDATE room_requests SET state='running', target_thread_id='review-desk' WHERE id=?").run(review.requestId);
  const card = projectCardById(db, running.cardId)!; const calls: string[] = [];
  const result = await handleProjectRouteWithInterrupt(db, route(`/api/groups/g/board/cards/${card.id}`, { action: "cancel", expectedRevision: card.revision }), async target => {
    expect(roomRequestById(db, review.requestId)!.state).toBe("running");
    calls.push(target.deskThreadId!);
  });
  expect(result?.status).toBe(200); expect(calls).toEqual(["review-desk"]);
  expect(roomRequestById(db, review.requestId)!.state).toBe("cancelled");
});
it("F4 absent goals table cannot leave dangling request references", () => {
  const { db, rows } = fixture(); db.exec("DELETE FROM project_budgets; DROP TABLE project_goals");
  expect(() => validateProjectRows(db, { ...rows, readOnly: true, requirePaused: false })).toThrow();
  prepareProjectTablesForRestore(db, rows);
  expect(roomRequestById(db, "lead-request")!.project_goal_id).toBeNull();
  expect(() => assertProjectTablesPaused(db, rows)).not.toThrow();
});
it("F5 column references use distinct group and column identities", () => {
  const { db, rows, card } = fixture(); const c = card();
  db.exec("INSERT INTO project_board_columns (group_id,id,title,state,position) VALUES ('gX','Y','Column','todo',0)");
  db.prepare("UPDATE project_work_items SET column_id='XY' WHERE id=?").run(c.id);
  expect(() => validateProjectRows(db, { ...rows, readOnly: true, requirePaused: false })).toThrow();
  validateProjectRows(db, { ...rows, requirePaused: false }); expect(projectCardById(db, c.id)!.columnId).toBeNull();
});
it.each(["failed", "cancelled", "unknown"])("F6 %s review can be assigned again with lineage", state => {
  const { db, group, run } = fixture(); const running = run();
  applyCardRunFinished(db, { ...running, reviewApplies: true, now: 6 });
  const args = { cardId: running.cardId, reviewerBotId: "other", leadBotId: "lead", memberIds: group.memberIds, now: 7 };
  const first = assignCardReview(db, args); if (!first.ok) throw new Error("review setup");
  db.prepare("UPDATE room_requests SET state=?, root_id='root', root_thread_id='room', origin='companion', audience_fingerprint='audience', not_owner_audience=1, unattended=1 WHERE id=?").run(state, first.requestId);
  const next = assignCardReview(db, { ...args, reviewerBotId: "lead", now: 8 });
  expect(next.ok).toBe(true); if (!next.ok) return;
  expect(next.requestId).not.toBe(first.requestId);
  expect(roomRequestById(db, next.requestId)).toMatchObject({ state: "queued", to_bot_id: "lead", parent_id: first.requestId, root_id: "root", origin: "companion", audience_fingerprint: "audience", not_owner_audience: 1, unattended: 1, admission_key: `review:${running.cardId}:1:1` });
  expect(assignCardReview(db, { ...args, reviewerBotId: "lead", now: 9 })).toMatchObject({ requestId: next.requestId });
});
it("F7 sign-off send-back queues a fenced lead assignment", () => {
  const { db, ctx, group } = fixture(); db.prepare("UPDATE project_goals SET state='awaiting_signoff' WHERE id=?").run(ctx.goalId);
  expect(sendProjectGoalBack(db, { actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, goalId: ctx.goalId, note: "Finish the export", memberIds: group.memberIds, now: 7 }).ok).toBe(true);
  const card = db.prepare("SELECT id FROM project_work_items").get()!;
  expect(db.prepare("SELECT * FROM room_requests WHERE work_item_id=?").get(card.id!)).toMatchObject({ state: "queued", to_bot_id: "lead", card_generation: 1, attempt: 1, admission_key: `assign:card:${card.id}:1:1` });
});
it("F8 legacy project status edits return Close or Reopen through HTTP", async () => {
  const server = await launchVerificationServer(process.env);
  try {
    const proof = await fetch(`${server.info.url}/api/desktop-secret`).then(r => r.json()) as { secret: string };
    const api = async (method: string, path: string, body: unknown) => {
      const response = await fetch(`${server.info.url}${path}`, { method, headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const bot = await api("POST", "/api/bots", { name: "Lead" });
    const group = await api("POST", "/api/groups", { name: "Project", memberIds: [bot.body.bot.id], channelProject: { goal: "Ship" } });
    expect(group.status).toBe(201);
    for (const status of ["done", "paused", "active"]) {
      expect(await api("PATCH", `/api/groups/${group.body.group.id}`, { channelProject: { status } })).toMatchObject({ status: 409, body: { error: "not_allowed", reason: expect.stringMatching(/Close.*Reopen/) } });
    }
  } finally { await server.close(); }
}, 60000);
it.each(["valid", "wrong-state", "missing"])("F9 cross-state drag validates and retains its %s column", kind => {
  const { db, run } = fixture(); const running = run(); applyCardRunFinished(db, { ...running, reviewApplies: true, now: 6 });
  db.prepare("INSERT INTO project_board_columns (group_id,id,title,state,position) VALUES ('g','custom','Column',?,0)").run(kind === "wrong-state" ? "done" : "todo");
  const card = projectCardById(db, running.cardId)!;
  const before = db.prepare("SELECT * FROM room_requests").all();
  const result = moveProjectCard(db, { actor: owner, cardId: card.id, expectedRevision: card.revision, toState: "todo", columnId: kind === "missing" ? "absent" : "custom", now: 8 });
  expect(result.ok).toBe(kind === "valid");
  if (kind === "valid") expect(projectCardById(db, card.id)).toMatchObject({ state: "todo", columnId: "custom" });
  else { expect(projectCardById(db, card.id)).toEqual(card); expect(db.prepare("SELECT * FROM room_requests").all()).toEqual(before); }
});
it.each(["decision", "note"])("F10 repeated %s tool returns the original brief receipt", kind => {
  const { db, ctx, group } = fixture();
  db.exec("CREATE TABLE messages(id TEXT, thread_id TEXT)");
  db.exec("INSERT INTO messages VALUES('source','room')");
  const tool = { groupId: "g", botId: "lead", requestId: ctx.leadRequestId, ownerAudience: true, memberIds: group.memberIds, now: 7, projectThreadIds: [group.threadId] };
  const body = kind === "decision" ? { decision: "Ship the export", sourceMessageIds: ["source"] } : { note: { text: "Export lives here", path: "out" }, sourceMessageIds: ["source"] };
  const first = projectToolBriefUpdate(db, tool, body); expect(first.status).toBe(200);
  projectToolBriefUpdate(db, tool, { decision: "Another decision", sourceMessageIds: ["source"] });
  const before = currentProjectBrief(db, "g");
  expect(projectToolBriefUpdate(db, { ...tool, now: 9 }, body)).toEqual(first);
  expect(currentProjectBrief(db, "g")).toEqual(before);
});
