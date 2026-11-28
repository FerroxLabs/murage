// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.24 q1024-sweep1 (FABLE q1024-sweep1 ddd0e35edc H5, OPUS q1024-sweep1 ddd0e35edc High 4; owner: q1024-sweep1). Invariant: when the criterion text and
// evidence a card's retry, send back or reopen unmarks leave the goal row, the UPDATE runs at secure_delete=ON (project-records.ts unmarkCriteriaForCard,
// the one function project-cards.ts:304 / :688 / :728 / :889 call). The row enters through the production card transition (reopenProjectCard) on a done card
// whose criterion is met with that card as evidence, and reads PRAGMA secure_delete at the goal UPDATE.
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { channelToProjectRows } from "./project-settings.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { handleProjectRoute } from "./project-routes.ts";
import { createProjectCard, finishProjectCardByOwner, reopenProjectCard } from "./project-cards.ts";
import { probeSecureDelete } from "./testing/secure-delete-probe.ts";

const OWNER = { kind: "owner" as const, lineage: { origin: "desktop" as const, rootThreadId: "room", audienceFingerprint: "owner" } };
const mode = (db: DatabaseSync) => Number((db.prepare("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete);

it("REOPEN: unmarking the criteria of a reopened card runs the goal UPDATE at secure_delete ON", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA secure_delete=FAST");
  initializeProjectTables(db);
  channelToProjectRows(db, { groupId: "g", bulletin: "Rules", leadBotId: "lead", now: 1 });
  const group = { id: "g", memberIds: ["lead", "worker"], threadId: "room", dm: false };
  const made = handleProjectRoute(db, { origin: "desktop", method: "POST", path: "/api/groups/g/project/goals", query: new URLSearchParams(), body: { title: "ZQX owner goal", description: "d", criteria: ["ZQX criterion"] }, group, now: 100, flags: { projectsGoals: true } } as never)!;
  const goal = (made.body as { goal: { id: string } }).goal;
  const created = createProjectCard(db, { groupId: "g", title: "Card", assigneeBotId: "worker", actor: OWNER, memberIds: group.memberIds, now: 200 });
  if (!created.ok) throw new Error(`setup failed: ${JSON.stringify(created)}`);
  const card = created.card;
  expect(finishProjectCardByOwner(db, { cardId: card.id, confirm: true, now: 210 }).ok).toBe(true);
  const criteria = JSON.parse(String((db.prepare("SELECT criteria FROM project_goals WHERE id=?").get(goal.id) as { criteria: string }).criteria)) as Array<Record<string, unknown>>;
  criteria[0] = { ...criteria[0], met: true, metBy: "owner", evidence: { workItemId: card.id, attempt: 1, kind: "card" } };
  db.prepare("UPDATE project_goals SET criteria=? WHERE id=?").run(JSON.stringify(criteria), goal.id);
  expect(mode(db), "the connection's default is FAST").toBe(2);
  const probe = probeSecureDelete(db, "project_goals", { update: "criteria" });
  let reopened;
  try { reopened = reopenProjectCard(db, { cardId: card.id, actor: OWNER, now: 300 }); } finally { probe.stop(); }
  expect(reopened.ok).toBe(true);
  const after = JSON.parse(String((db.prepare("SELECT criteria FROM project_goals WHERE id=?").get(goal.id) as { criteria: string }).criteria)) as Array<Record<string, unknown>>;
  expect(after[0], "the criterion is unmarked and its evidence is gone").toMatchObject({ met: false });
  expect(after[0]).not.toHaveProperty("evidence");
  expect(probe.modes.length, "the reopen reached the goal UPDATE").toBeGreaterThan(0);
  expect(probe.modes, "the unmark ran at secure_delete ON (1), not FAST (2)").toEqual(probe.modes.map(() => 1));
  expect(mode(db), "the connection is back at FAST afterwards").toBe(2);
  db.close();
});
