// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.24 q1024-sweep1 (Astra 7412 High on fix/1023-sqlite-fix 239809febe, server/project-goals.ts:66; owner: q1024-sweep1). Invariant: a write that drops
// the owner's typed words from a project goal (an edit of its title, description or criteria, a removed criterion) runs at secure_delete=ON on the
// connection (server/secure-delete.ts); a write that only moves its state stays at FAST. Each row enters through the production route
// (handleProjectRoute PATCH /api/groups/g/project/goals/:id, project-routes.ts "goal-patch") and reads PRAGMA secure_delete at the UPDATE.
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { channelToProjectRows } from "./project-settings.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { handleProjectRoute } from "./project-routes.ts";
import { probeSecureDelete } from "./testing/secure-delete-probe.ts";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA secure_delete=FAST");
  initializeProjectTables(db);
  channelToProjectRows(db, { groupId: "g", bulletin: "Rules", leadBotId: "lead", now: 1 });
  const group = { id: "g", memberIds: ["lead", "worker"], threadId: "room", dm: false };
  const call = (method: string, tail: string, body: unknown = {}) => handleProjectRoute(db, { origin: "desktop", method, path: `/api/groups/g/${tail}`, query: new URLSearchParams(), body, group, now: 100, flags: { projectsGoals: true } } as never)!;
  const goal = call("POST", "project/goals", { title: "ZQX owner goal title", description: "ZQX owner goal description ".repeat(40), criteria: ["ZQX first criterion", "ZQX second criterion"] }).body.goal as { id: string; revision: number };
  return { db, call, goal };
}
const mode = (db: DatabaseSync) => Number((db.prepare("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete);

it("EDIT-TEXT: the owner changing a goal's title and description runs the UPDATE at secure_delete ON", () => {
  const { db, call, goal } = fixture();
  expect(mode(db), "the connection's default is FAST").toBe(2);
  const probe = probeSecureDelete(db, "project_goals", { update: "description" });
  let res;
  try { res = call("PATCH", `project/goals/${goal.id}`, { expectedRevision: goal.revision, title: "Renamed", description: "short" }); } finally { probe.stop(); }
  expect(res.status).toBe(200);
  expect(db.prepare("SELECT description FROM project_goals WHERE id=?").get(goal.id)).toEqual({ description: "short" });
  expect(probe.modes.length, "the edit reached its UPDATE").toBeGreaterThan(0);
  expect(probe.modes, "the edit ran at secure_delete ON (1), not FAST (2)").toEqual(probe.modes.map(() => 1));
  expect(mode(db), "the connection is back at FAST afterwards").toBe(2);
  db.close();
});

it("EDIT-CRITERIA: removing a criterion runs the UPDATE at secure_delete ON", () => {
  const { db, call, goal } = fixture();
  const criteria = (JSON.parse(String((db.prepare("SELECT criteria FROM project_goals WHERE id=?").get(goal.id) as { criteria: string }).criteria)) as Array<{ id: string; text: string }>);
  const probe = probeSecureDelete(db, "project_goals", { update: "criteria" });
  let res;
  try { res = call("PATCH", `project/goals/${goal.id}`, { expectedRevision: goal.revision, criteria: [{ id: criteria[0]!.id, text: criteria[0]!.text }] }); } finally { probe.stop(); }
  expect(res.status).toBe(200);
  expect(JSON.parse(String((db.prepare("SELECT criteria FROM project_goals WHERE id=?").get(goal.id) as { criteria: string }).criteria))).toHaveLength(1);
  expect(probe.modes.length, "the edit reached its UPDATE").toBeGreaterThan(0);
  expect(probe.modes, "the criterion removal ran at secure_delete ON (1), not FAST (2)").toEqual(probe.modes.map(() => 1));
  db.close();
});

it("STATE-ONLY: a goal action that drops no words (start) stays at the FAST default", () => {
  const { db, call, goal } = fixture();
  const probe = probeSecureDelete(db, "project_goals", { update: "state" });
  let res;
  try { res = call("PATCH", `project/goals/${goal.id}`, { expectedRevision: goal.revision, action: "start" }); } finally { probe.stop(); }
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(probe.modes.length, "the start reached its UPDATE").toBeGreaterThan(0);
  expect(probe.modes, "a state move stays FAST (2)").toEqual(probe.modes.map(() => 2));
  db.close();
});
