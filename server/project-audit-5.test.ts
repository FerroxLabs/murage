// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { initializeProjectTables, prepareProjectTablesForRestore } from "./project-tables.ts";
import { channelToProjectRows } from "./project-settings.ts";
import { applyCardRunDispatched, createProjectCard, enqueueCardRun } from "./project-cards.ts";
import { approveProjectPlan, createProjectGoal } from "./project-goals.ts";
import { insertRoomRequest, projectCardById, roomRequestById } from "./project-records.ts";
import { projectToolAccept, projectToolCardManage } from "./project-tools.ts";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const members = ["lead", "worker", "reviewer"];
const owner = { kind: "owner" as const, lineage: { origin: "desktop" as const, rootThreadId: "room", audienceFingerprint: "owner" } };
function fixture() {
  const db = new DatabaseSync(":memory:"); databases.push(db); initializeProjectTables(db);
  channelToProjectRows(db, { groupId: "g", bulletin: "Rules", leadBotId: "lead", now: 1 });
  db.exec("UPDATE project_settings SET mode='ongoing'");
  const goal = createProjectGoal(db, { groupId: "g", title: "Goal", planFirst: true, now: 2 });
  if (!goal.ok) throw new Error(goal.reason);
  db.prepare("UPDATE project_goals SET state='working' WHERE id=?").run(goal.goal.id);
  const made = createProjectCard(db, { groupId: "g", goalId: goal.goal.id, title: "Private card text", assigneeBotId: "worker", actor: owner, memberIds: members, now: 2 });
  if (!made.ok) throw new Error(made.reason);
  insertRoomRequest(db, { id: "lead-turn", groupId: "g", projectGoalId: goal.goal.id, verb: "wake", fromKind: "bot", toBotId: "lead", admissionKey: "wake:lead-turn", state: "running", rootId: "root", rootThreadId: "room", origin: "companion", audienceFingerprint: "bound-fingerprint", unattended: true, now: 2 });
  const ctx = { groupId: "g", botId: "lead", requestId: "lead-turn", memberIds: members, ownerAudience: true, now: 3 };
  return { db, card: made.card, goalId: goal.goal.id, ctx };
}

it.each(["paused", "stopped", "failed"].flatMap(state => ["cancel", "reassign", "accept"].map(action => [state, action])))("F1 a bound %s goal refuses %s without mutations", (state, action) => {
  const { db, card, goalId, ctx } = fixture();
  if (action === "accept") {
    db.prepare("UPDATE project_work_items SET state='review' WHERE id=?").run(card.id);
    insertRoomRequest(db, { id: "review", groupId: "g", verb: "review", fromKind: "bot", toBotId: "reviewer", workItemId: card.id, cardGeneration: card.generation, admissionKey: "review", state: "done", now: 2 });
    db.exec("UPDATE room_requests SET outcome_note='pass' WHERE id='review'");
  }
  db.prepare("UPDATE project_goals SET state=? WHERE id=?").run(state, goalId);
  const before = projectCardById(db, card.id);
  const count = db.prepare("SELECT count(*) AS n FROM project_activity").get();
  const result = action === "accept" ? projectToolAccept(db, ctx, { cardId: card.id }) : projectToolCardManage(db, ctx, { cardId: card.id, action, assigneeBotId: "reviewer" });
  expect(result).toMatchObject({ status: 409, body: { error: "not_allowed" } });
  expect(projectCardById(db, card.id)).toEqual(before);
  expect(db.prepare("SELECT count(*) AS n FROM project_activity").get()).toEqual(count);
});

it.each(["owner_turn", "owner_reply", "close"])("F1 preserves the %s goal-pause exception", exception => {
  const { db, card, goalId, ctx } = fixture();
  db.prepare("UPDATE project_goals SET state='paused' WHERE id=?").run(goalId);
  if (exception === "owner_turn") db.exec("UPDATE room_requests SET verb='room_turn', from_kind='owner' WHERE id='lead-turn'");
  if (exception === "owner_reply") {
    insertRoomRequest(db, { id: "owner-send", groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: "owner_send:g:send", sourceMessageId: "message", ...owner.lineage, now: 1 });
    // the lead's reply to the owner's message is recorded from the owner (hop 0);
    // the same row from a bot is a teammate's @mention (lane queuedhop, project-tools.test.ts)
    db.exec("UPDATE room_requests SET verb='room_turn', from_kind='owner', parent_id='owner-send', source_message_id='message', admission_key='room_turn:message:lead' WHERE id='lead-turn'");
  }
  if (exception === "close") db.exec("UPDATE room_requests SET admission_key='close:g:1' WHERE id='lead-turn'");
  expect(projectToolCardManage(db, ctx, { cardId: card.id, action: "cancel" }).status).toBe(200);
});

it.each([false, true])("F2 restored plan preserves immutable lineage including restricted audience=%s", notOwnerAudience => {
  const { db, card, goalId } = fixture();
  const queued = enqueueCardRun(db, { cardId: card.id, actor: { kind: "lead", botId: "lead", lineage: { rootId: "root", parentId: "lead-turn", rootThreadId: "room", origin: "companion", audienceFingerprint: "bound-fingerprint", unattended: true, notOwnerAudience } }, now: 3 });
  if (!queued.ok) throw new Error(queued.reason);
  db.prepare("UPDATE project_goals SET state='awaiting_plan_ok' WHERE id=?").run(goalId);
  prepareProjectTablesForRestore(db, { groups: [{ id: "g", channelProject: {} }], botIds: new Set(members), now: 4 });
  expect(roomRequestById(db, queued.requestId)?.state).toBe("expired");
  expect(approveProjectPlan(db, { goalId, now: 5, memberIds: members }).ok).toBe(true);
  const replacements = db.prepare("SELECT * FROM room_requests WHERE work_item_id=? AND state='queued'").all(card.id);
  expect(replacements).toHaveLength(1);
  expect(replacements[0]).toMatchObject({ parent_id: queued.requestId, root_id: "root", root_thread_id: "room", origin: "companion", audience_fingerprint: "bound-fingerprint", not_owner_audience: notOwnerAudience ? 1 : 0, unattended: 1, return_bot_id: "lead" });
});

it.each([false, true])("F3 normalized reassignment replay preserves running work (with edit=%s)", withEdit => {
  const { db, card, ctx } = fixture();
  // the lead may not edit writes/workRoot of an owner's card outside an owner-directed turn (lane cards), so the edit variant uses a lead-made card; see NOTES.md
  if (withEdit) db.prepare("UPDATE project_work_items SET created_by='lead' WHERE id=?").run(card.id);
  const body = { cardId: card.id, action: "reassign", assigneeBotId: "reviewer", note: "Private model note", ...(withEdit ? { writes: false } : {}) };
  const first = projectToolCardManage(db, ctx, body);
  expect(first.status).toBe(200);
  if (first.status !== 200) throw new Error(first.body.error);
  const request = db.prepare("SELECT * FROM room_requests WHERE work_item_id=? AND state='queued'").get(card.id)!;
  expect(applyCardRunDispatched(db, { cardId: card.id, requestId: String(request.id), deskThreadId: "desk", now: 4 }).ok).toBe(true);
  const before = projectCardById(db, card.id);
  const requests = db.prepare("SELECT * FROM room_requests ORDER BY id").all();
  const activities = db.prepare("SELECT * FROM project_activity ORDER BY id").all();
  const replay = projectToolCardManage(db, { ...ctx, now: 5 }, { ...(withEdit ? { writes: false } : {}), note: "  Private model note  ", assigneeBotId: "reviewer", action: "reassign", cardId: card.id });
  expect(replay.status).toBe(200);
  if (replay.status !== 200) throw new Error(replay.body.error);
  expect(projectCardById(db, card.id)).toEqual(before);
  expect(db.prepare("SELECT * FROM room_requests ORDER BY id").all()).toEqual(requests);
  expect(db.prepare("SELECT * FROM project_activity ORDER BY id").all()).toEqual(activities);
  expect(replay.body.requestId).toBe(request.id);
  expect(first.body.requestId).toBe(request.id);
  const receipt = db.prepare("SELECT * FROM project_activity WHERE request_id='lead-turn' AND kind='card_reassigned'").get()!;
  expect(JSON.parse(String(receipt.detail))).toMatchObject({ operation: expect.stringMatching(/^[a-f0-9]{64}$/), resultRequestId: request.id });
  expect(String(receipt.detail)).not.toContain("Private");
  // Receipt lookup still requires a live, authorized bound request.
  db.exec("UPDATE room_requests SET state='done' WHERE id='lead-turn'");
  expect(projectToolCardManage(db, ctx, body).status).toBe(403);
});

it("F3 changed operations and another bound lead request have distinct receipts", () => {
  const { db, card, ctx } = fixture();
  const body = { cardId: card.id, action: "reassign", assigneeBotId: "reviewer" };
  expect(projectToolCardManage(db, ctx, body).status).toBe(200);
  expect(projectToolCardManage(db, ctx, { ...body, assigneeBotId: "worker" }).status).toBe(200);
  expect(projectToolCardManage(db, ctx, body).status).toBe(200);
  expect(projectCardById(db, card.id)?.assigneeBotId).toBe("worker");
  insertRoomRequest(db, { id: "next-turn", groupId: "g", verb: "wake", fromKind: "bot", toBotId: "lead", admissionKey: "wake:next-turn", state: "running", now: 4 });
  expect(projectToolCardManage(db, { ...ctx, requestId: "next-turn" }, body).status).toBe(200);
  expect(projectCardById(db, card.id)?.assigneeBotId).toBe("reviewer");
  expect(db.prepare("SELECT count(*) AS n FROM room_requests WHERE work_item_id=?").get(card.id)?.n).toBe(3);
});
