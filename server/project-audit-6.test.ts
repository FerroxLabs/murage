// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { initializeProjectTables, prepareProjectTablesForRestore } from "./project-tables.ts";
import { channelToProjectRows } from "./project-settings.ts";
import { createProjectCard, enqueueCardRun } from "./project-cards.ts";
import { approveProjectPlan, createProjectGoal } from "./project-goals.ts";
import { insertRoomRequest, projectCardById, roomRequestById } from "./project-records.ts";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

it.each([false, true])("approves a mixed restored plan without starting the owner card (restricted audience=%s)", notOwnerAudience => {
  const db = new DatabaseSync(":memory:"); databases.push(db); initializeProjectTables(db);
  const members = ["lead", "worker"];
  const owner = { kind: "owner" as const, lineage: { origin: "desktop" as const, rootThreadId: "room", audienceFingerprint: "owner" } };
  channelToProjectRows(db, { groupId: "g", bulletin: "Rules", leadBotId: "lead", now: 1 });
  const goal = createProjectGoal(db, { groupId: "g", title: "Goal", planFirst: true, now: 2 });
  if (!goal.ok) throw new Error(goal.reason);
  db.prepare("UPDATE project_goals SET state='awaiting_plan_ok' WHERE id=?").run(goal.goal.id);
  const makeCard = (title: string, now: number) => {
    const made = createProjectCard(db, { groupId: "g", goalId: goal.goal.id, title, assigneeBotId: "worker", actor: owner, memberIds: members, now });
    if (!made.ok) throw new Error(made.reason);
    return made.card;
  };
  const unscheduled = makeCard("Owner card waiting for Start", 3);
  const planned = makeCard("Previously assigned card", 4);
  insertRoomRequest(db, { id: "lead-turn", groupId: "g", projectGoalId: goal.goal.id, verb: "wake", fromKind: "bot", toBotId: "lead", admissionKey: "wake:lead-turn", state: "running", rootId: "plan-root", rootThreadId: "room", origin: "companion", audienceFingerprint: "plan-audience", unattended: true, notOwnerAudience, now: 4 });
  const assigned = enqueueCardRun(db, { cardId: planned.id, actor: { kind: "lead", botId: "lead", lineage: { parentId: "lead-turn", rootId: "plan-root", rootThreadId: "room", origin: "companion", audienceFingerprint: "plan-audience", unattended: true, notOwnerAudience } }, now: 5 });
  if (!assigned.ok) throw new Error(assigned.reason);
  prepareProjectTablesForRestore(db, { groups: [{ id: "g", channelProject: {} }], botIds: new Set(members), now: 6 });
  expect(roomRequestById(db, assigned.requestId)?.state).toBe("expired");
  const waitingCard = projectCardById(db, unscheduled.id);
  expect(waitingCard).toMatchObject({ state: "todo", requestId: null });
  expect(db.prepare("SELECT id FROM room_requests WHERE work_item_id=?").all(unscheduled.id)).toHaveLength(0);

  expect(approveProjectPlan(db, { goalId: goal.goal.id, now: 7, memberIds: members })).toMatchObject({ ok: true, goal: { state: "working" } });
  expect(projectCardById(db, unscheduled.id)).toEqual(waitingCard);
  expect(db.prepare("SELECT id FROM room_requests WHERE work_item_id=?").all(unscheduled.id)).toHaveLength(0);
  const replacements = db.prepare("SELECT * FROM room_requests WHERE work_item_id=? AND state='queued'").all(planned.id);
  expect(replacements).toHaveLength(1);
  expect(replacements[0]).toMatchObject({ parent_id: assigned.requestId, root_id: "plan-root", root_thread_id: "room", origin: "companion", audience_fingerprint: "plan-audience", not_owner_audience: notOwnerAudience ? 1 : 0, unattended: 1, return_bot_id: "lead" });
  expect(roomRequestById(db, assigned.requestId)?.state).toBe("expired");

  const started = enqueueCardRun(db, { cardId: unscheduled.id, actor: owner, now: 8 });
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(started.reason);
  expect(roomRequestById(db, started.requestId)).toMatchObject({ state: "queued", work_item_id: unscheduled.id, origin: "desktop", audience_fingerprint: "owner" });
});
