// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { initializeProjectTables, prepareProjectTablesForRestore, assertProjectTablesPaused } from "./project-tables.ts";
import { channelToProjectRows } from "./project-settings.ts";
import { createProjectCard, enqueueCardRun } from "./project-cards.ts";
import { createProjectGoal, approveProjectPlan } from "./project-goals.ts";
import { insertRoomRequest, projectCardById, roomRequestById } from "./project-records.ts";
import { projectToolCardManage } from "./project-tools.ts";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const members = ["lead", "worker", "reviewer"];
const rows = { groups: [{ id: "g", channelProject: {} }], botIds: new Set(members), now: 5 };
const owner = { kind: "owner" as const, lineage: { origin: "desktop" as const, rootThreadId: "room", audienceFingerprint: "owner-fingerprint" } };
function fixture() {
  const db = new DatabaseSync(":memory:"); databases.push(db); initializeProjectTables(db);
  channelToProjectRows(db, { groupId: "g", bulletin: "Rules", leadBotId: "lead", now: 1 });
  db.exec("UPDATE project_settings SET mode='ongoing'");
  function card(goalId?: string) {
    const made = createProjectCard(db, { groupId: "g", goalId, title: "Card", assigneeBotId: "worker", actor: owner, memberIds: members, now: 2 });
    if (!made.ok) throw new Error(made.reason);
    return made.card;
  }
  return { db, card };
}

it.each(["retry", "reassign", "send_back"] as const)("F1 lead %s preserves bound lineage and the completion recipient", action => {
  const { db, card } = fixture(); const c = card();
  insertRoomRequest(db, { id: "lead-turn", groupId: "g", verb: "wake", fromKind: "bot", toBotId: "lead", admissionKey: "lead-turn", state: "running", rootId: "root", rootThreadId: "room", origin: "companion", audienceFingerprint: "bound-fingerprint", unattended: true, now: 2 });
  insertRoomRequest(db, { id: "old-run", groupId: "g", verb: "assign", fromKind: "bot", toBotId: "worker", workItemId: c.id, admissionKey: "old-run", state: "failed", rootId: "root", rootThreadId: "room", origin: "companion", audienceFingerprint: "bound-fingerprint", unattended: true, now: 2 });
  db.prepare("UPDATE project_work_items SET state=?, request_id='old-run' WHERE id=?").run(action === "retry" ? "failed" : action === "send_back" ? "review" : "todo", c.id);
  const result = projectToolCardManage(db, { groupId: "g", botId: "lead", requestId: "lead-turn", memberIds: members, ownerAudience: true, now: 3 }, { cardId: c.id, action, ...(action === "reassign" ? { assigneeBotId: "reviewer" } : {}) });
  expect(result.status).toBe(200);
  const request = db.prepare("SELECT * FROM room_requests WHERE work_item_id=? AND state='queued'").get(c.id);
  expect(request).toMatchObject({ parent_id: action === "retry" ? "old-run" : "lead-turn", root_id: "root", root_thread_id: "room", origin: "companion", audience_fingerprint: "bound-fingerprint", not_owner_audience: 0, unattended: 1, return_bot_id: "lead" });
});

it("F2 approval recreates an expired owner Start assignment with a new attempt", () => {
  const { db, card } = fixture();
  const goal = createProjectGoal(db, { groupId: "g", title: "Goal", planFirst: true, now: 2 });
  if (!goal.ok) throw new Error(goal.reason);
  db.prepare("UPDATE project_goals SET state='awaiting_plan_ok' WHERE id=?").run(goal.goal.id);
  const c = card(goal.goal.id);
  const queued = enqueueCardRun(db, { cardId: c.id, actor: owner, now: 3 });
  if (!queued.ok) throw new Error(queued.reason);
  prepareProjectTablesForRestore(db, rows);
  expect(roomRequestById(db, queued.requestId)?.state).toBe("expired");
  expect(approveProjectPlan(db, { goalId: goal.goal.id, now: 6, memberIds: members }).ok).toBe(true);
  const replacement = db.prepare("SELECT * FROM room_requests WHERE work_item_id=? AND state='queued'").all(c.id);
  expect(replacement).toHaveLength(1);
  expect(replacement[0]).toMatchObject({ attempt: c.attempt + 1, card_generation: c.generation + 1 });
  expect(projectCardById(db, c.id)?.attempt).toBe(c.attempt + 1);
});

it("F3 restore clears a missing return bot and records the repair", () => {
  const { db } = fixture();
  insertRoomRequest(db, { id: "run", groupId: "g", verb: "assign", fromKind: "bot", fromBotId: "lead", toBotId: "worker", returnBotId: "deleted", admissionKey: "run", state: "done", now: 2 });
  const notes = prepareProjectTablesForRestore(db, rows);
  expect(roomRequestById(db, "run")).toMatchObject({ from_bot_id: "lead", to_bot_id: "worker", return_bot_id: null });
  expect(JSON.stringify(notes)).toContain("deleted");
  expect(() => assertProjectTablesPaused(db, rows)).not.toThrow();
});

it("F3 read-only validation rejects a missing return bot without rewriting it", () => {
  const { db } = fixture();
  prepareProjectTablesForRestore(db, rows);
  insertRoomRequest(db, { id: "run", groupId: "g", verb: "assign", fromKind: "bot", returnBotId: "deleted", admissionKey: "run", state: "done", now: 2 });
  expect(() => assertProjectTablesPaused(db, rows)).toThrow();
  expect(roomRequestById(db, "run")?.return_bot_id).toBe("deleted");
});
