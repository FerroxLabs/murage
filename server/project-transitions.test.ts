// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import * as card from "./project-cards.ts";
import * as goal from "./project-goals.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { channelToProjectRows } from "./project-settings.ts";
import { projectCardById } from "./project-records.ts";

const actors = [{ kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, { kind: "lead", botId: "lead" }, { kind: "assignee", botId: "worker" }, { kind: "server" }] as const;
function fresh() {
  const db = new DatabaseSync(":memory:"); initializeProjectTables(db);
  channelToProjectRows(db, { groupId: "g", bulletin: "", leadBotId: "lead", now: 1 });
  db.prepare("UPDATE project_settings SET mode='ongoing'").run();
  return db;
}
const members = ["lead", "worker", "reviewer"];
type Role = (typeof actors)[number]["kind"];
type Row = { name: string; state: string; roles: Role[]; apply: (db: DatabaseSync, input: any) => { ok: boolean } };
const cardRows: Row[] = [
  { name: "create", state: "todo", roles: ["owner", "lead", "server"], apply: (db, input) => card.createProjectCard(db, { ...input, groupId: "g", title: "New" }) },
  { name: "dispatch", state: "todo", roles: ["server"], apply: card.applyCardRunDispatched },
  { name: "live wait", state: "doing", roles: ["server", "assignee"], apply: (db, input) => card.applyCardWaiting(db, { ...input, waiting: { kind: input.actor.kind === "assignee" ? "blocked" : "owner_approval" } }) },
  { name: "dead wait", state: "doing", roles: ["server"], apply: (db, input) => card.applyCardWaiting(db, { ...input, waiting: { kind: "restart" } }) },
  { name: "resume", state: "waiting", roles: ["server"], apply: card.applyCardRunResumed },
  { name: "finish review", state: "doing", roles: ["server"], apply: (db, input) => card.applyCardRunFinished(db, { ...input, reviewApplies: true }) },
  { name: "finish done", state: "doing", roles: ["server"], apply: (db, input) => card.applyCardRunFinished(db, { ...input, reviewApplies: false }) },
  { name: "failed", state: "doing", roles: ["server"], apply: (db, input) => card.applyCardRunFailed(db, { ...input, reason: "Failed" }) },
  { name: "owner done", state: "doing", roles: ["owner"], apply: card.finishProjectCardByOwner },
  { name: "accept", state: "review", roles: ["owner", "lead", "server"], apply: card.acceptProjectCard },
  { name: "send back", state: "review", roles: ["owner", "lead"], apply: card.sendProjectCardBack },
  { name: "retry", state: "failed", roles: ["owner", "lead"], apply: card.retryProjectCard },
  { name: "reassign", state: "todo", roles: ["owner", "lead"], apply: (db, input) => card.reassignProjectCard(db, { ...input, assigneeBotId: "reviewer" }) },
  { name: "take over", state: "todo", roles: ["owner"], apply: card.takeOverProjectCard },
  { name: "done without review", state: "todo", roles: ["owner"], apply: (db, input) => card.finishProjectCardByOwner(db, { ...input, confirm: true }) },
  { name: "cancel", state: "todo", roles: ["owner", "server"], apply: card.cancelProjectCard },
  { name: "restore", state: "cancelled", roles: ["owner"], apply: card.restoreProjectCard },
  { name: "reopen", state: "done", roles: ["owner"], apply: card.reopenProjectCard },
  { name: "reorder", state: "todo", roles: ["owner"], apply: card.moveProjectCard },
];
describe("SPEC-P 5.1 actor matrix", () => {
  for (const row of cardRows) it.each(actors)(`${row.name}: $kind`, actor => {
    const db = fresh();
    const made = card.createProjectCard(db, { groupId: "g", title: "Card", assigneeBotId: "worker", actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, memberIds: members, now: 1 });
    if (!made.ok) throw new Error("fixture");
    const queued = card.enqueueCardRun(db, { cardId: made.card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now: 2 });
    if (!queued.ok) throw new Error("fixture");
    if (row.state !== "todo") card.applyCardRunDispatched(db, { cardId: made.card.id, requestId: queued.requestId, deskThreadId: "desk", now: 3 });
    db.prepare("UPDATE project_work_items SET state=?, waiting_on=?, owner_took_over=?, archived_at=? WHERE id=?").run(row.state, row.state === "waiting" ? '{"kind":"owner_approval"}' : null, row.name === "owner done" ? 1 : 0, row.state === "cancelled" ? 3 : null, made.card.id);
    if (row.name === "accept") {
      const review = card.assignCardReview(db, { cardId: made.card.id, reviewerBotId: "reviewer", leadBotId: "lead", memberIds: members, now: 4 });
      if (!review.ok) throw new Error("fixture review");
      card.applyReviewVerdict(db, { cardId: made.card.id, requestId: review.requestId, verdict: "pass", reviewerBotId: "reviewer", now: 5 });
    }
    const input = { sourceMessageIds: ["fixture-source"], cardId: made.card.id, requestId: queued.requestId, deskThreadId: "desk", actor, memberIds: members, expectedRevision: projectCardById(db, made.card.id)!.revision, now: 6 };
    expect(row.apply(db, input).ok).toBe(row.roles.includes(actor.kind));
    db.close();
  });
});
const goalRows: Row[] = [
  { name: "create", state: "draft", roles: ["owner"], apply: (db, input) => goal.createProjectGoal(db, { groupId: "g", title: "New", actor: input.actor, now: 6 } as never) },
  { name: "start", state: "draft", roles: ["owner"], apply: (db, input) => goal.startProjectGoal(db, { ...input, tz: "UTC" }) },
  { name: "plan accepted", state: "planning", roles: ["server"], apply: goal.applyGoalPlanAccepted },
  { name: "plan needs approval", state: "planning", roles: ["server"], apply: goal.applyGoalPlanAccepted },
  { name: "request signoff", state: "working", roles: ["server", "lead"], apply: goal.requestGoalSignoff },
  { name: "approve plan", state: "awaiting_plan_ok", roles: ["owner"], apply: (db, input) => goal.approveProjectPlan(db, { ...input, memberIds: members }) },
  { name: "change plan", state: "awaiting_plan_ok", roles: ["owner"], apply: (db, input) => goal.changeProjectPlan(db, { ...input, note: "Change it" }) },
  { name: "sign off", state: "awaiting_signoff", roles: ["owner"], apply: goal.signOffProjectGoal },
  { name: "send back", state: "awaiting_signoff", roles: ["owner"], apply: (db, input) => goal.sendProjectGoalBack(db, { ...input, note: "Change it", memberIds: members }) },
  { name: "pause", state: "working", roles: ["owner", "server"], apply: (db, input) => goal.pauseProjectGoal(db, { ...input, reason: "Hold" }) },
  { name: "resume", state: "paused", roles: ["owner"], apply: (db, input) => goal.resumeProjectGoal(db, { ...input, memberIds: members }) },
  { name: "stop", state: "working", roles: ["owner", "server"], apply: goal.stopProjectGoal },
  { name: "fail", state: "working", roles: ["server"], apply: (db, input) => goal.failProjectGoal(db, { ...input, reason: "Gone" }) },
];
describe("SPEC-P 5.3 actor matrix", () => {
  for (const row of goalRows) it.each(actors)(`${row.name}: $kind`, actor => {
    const db = fresh();
    const made = goal.createProjectGoal(db, { groupId: "g", title: "Goal", now: 1 });
    if (!made.ok) throw new Error("fixture");
    db.prepare("UPDATE project_goals SET state=? WHERE id=?").run(row.state, made.goal.id);
    if (row.name === "plan needs approval") db.prepare("UPDATE project_goals SET plan_first=1 WHERE id=?").run(made.goal.id);
    if (row.name === "request signoff") {
      const madeCard = card.createProjectCard(db, { groupId: "g", title: "Proof", goalId: made.goal.id, assigneeBotId: "worker", actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, memberIds: members, now: 2 });
      if (!madeCard.ok) throw new Error("fixture card");
      const run = card.enqueueCardRun(db, { cardId: madeCard.card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now: 3 });
      if (!run.ok) throw new Error("fixture request");
      card.applyCardRunDispatched(db, { cardId: madeCard.card.id, requestId: run.requestId, deskThreadId: "desk", now: 4 });
      card.applyCardRunFinished(db, { cardId: madeCard.card.id, requestId: run.requestId, reviewApplies: false, resultMessageId: "proof", now: 5 });
      db.prepare("UPDATE room_requests SET result_message_id='proof', state='done' WHERE id=?").run(run.requestId);
      db.prepare("UPDATE project_goals SET criteria=? WHERE id=?").run(JSON.stringify([{ id: "criterion", text: "Proof", setBy: "owner", proposed: false, met: true, evidence: { kind: "message", ref: "proof", workItemId: madeCard.card.id, attempt: 1, at: 4 } }]), made.goal.id);
    }
    expect(row.apply(db, { goalId: made.goal.id, actor, now: 6 }).ok).toBe(row.roles.includes(actor.kind));
    db.close();
  });
});
