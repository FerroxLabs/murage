import { sourceExecutionAudience } from "./execution-audience.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { initializeProjectTables } from "./project-tables.ts";
import { insertRoomRequest, inheritedRequestLineage, roomRequestById } from "./project-records.ts";
import { insertRoomRequest as insertE1, roomRequest, completeRequest } from "./room-requests.ts";
import { createProjectCard, enqueueCardRun, applyCardRunDispatched, applyCardRunFinished, applyCardRunFailed, assignCardReview, sendProjectCardBack, retryProjectCard } from "./project-cards.ts";
import { recordProjectRoutine } from "./project-routines.ts";
import { queueRoutineCardRun } from "./project-card-executor.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";
import { teamIdFor } from "./team-identities.ts";
import { queueDelegation, _resetPending, _loadPending, _pendingCount } from "./delegations.ts";
import { database } from "./database.ts";

it("the second writer inherits the parent's audience", () => {
  const path = "assign";
  const db = new DatabaseSync(":memory:"); initializeProjectTables(db);
  const tag = { v: 1, kind: "team", human: "owner", team: "sales", rootRequestId: "root" };
  const root = insertE1(db, { id: "root", groupId: "pair", verb: "ask", fromKind: "bot", admissionKey: "root", now: 1, lineage: { rootThreadId: "thread", origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false, executionAudience: tag } }).request;
  const child = insertRoomRequest(db, { ...inheritedRequestLineage(roomRequestById(db, root.id)!), groupId: "pair", verb: "assign", fromKind: "bot", admissionKey: path, now: 2 });
  expect(roomRequest(db, child!)?.executionAudience).toEqual(tag); db.close();
});
it("sync ask copies audience even when a child attempts to override it", () => {
  const db = new DatabaseSync(":memory:"); initializeProjectTables(db);
  const lineage = { rootThreadId: "thread", origin: "desktop" as const, audienceFingerprint: "owner", notOwnerAudience: false, unattended: false, executionAudience: { v: 1, kind: "team", human: "owner", team: "sales", rootRequestId: "r" } };
  const root = insertE1(db, { id: "r", groupId: "g", verb: "ask", fromKind: "bot", admissionKey: "root", now: 1, lineage }).request;
  const child = insertE1(db, { parentId: root.id, groupId: "g", verb: "ask", fromKind: "bot", admissionKey: "child", now: 2, lineage: { ...lineage, executionAudience: null } }).request;
  expect(child.executionAudience).toEqual(lineage.executionAudience); db.close();
});
it("continuation wakes preserve the completed parent's audience", () => {
  const db = new DatabaseSync(":memory:"); initializeProjectTables(db);
  const tag = { v: 1, kind: "team", human: "owner", team: "sales", rootRequestId: "r" };
  const root = insertE1(db, { id: "r", groupId: "g", verb: "assign", fromKind: "bot", toBotId: "iris", returnBotId: "sam", returnThreadId: "sam-thread", admissionKey: "root", now: 1, lineage: { rootThreadId: "thread", origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false, executionAudience: tag } }).request;
  completeRequest(db, root.id, { state: "done", now: 2 });
  const wake = db.prepare("SELECT execution_audience FROM room_requests WHERE verb='wake'").get(); expect(JSON.parse(String(wake?.execution_audience))).toEqual(tag); db.close();
});

function cards() {
  const db = new DatabaseSync(":memory:"); initializeProjectTables(db);
  db.exec(`INSERT INTO project_settings(group_id,mode,lead_bot_id,parts,parallel_cards,work_roots,work_profile,run_state,revision,updated_at) VALUES('p','conversation','lead','{"board":true,"review":true,"digest":false}',3,'[]','ask','running',0,1)`);
  const tag = { v: 1 as const, kind: "project" as const, human: "owner" as const, projectId: "p", rootRequestId: "root" };
  const root = insertE1(db, { id: "root", groupId: "p", verb: "room_turn", fromKind: "owner", admissionKey: "root", now: 1, lineage: { rootThreadId: "room", origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false, executionAudience: tag } }).request;
  const actor = { kind: "lead" as const, botId: "lead", lineage: inheritedRequestLineage(roomRequestById(db, root.id)!) };
  const made = createProjectCard(db, { groupId: "p", title: "Card", assigneeBotId: "iris", actor: { kind: "owner" }, memberIds: ["lead", "iris", "reviewer"], now: 2 });
  if (!made.ok) throw new Error(made.reason);
  const run = enqueueCardRun(db, { cardId: made.card.id, actor, now: 3 }); if (!run.ok) throw new Error(run.reason);
  return { db, tag, actor, cardId: made.card.id, requestId: run.requestId };
}
it("assign card transition preserves the lead's parent tag", () => {
  const f = cards(); expect(roomRequest(f.db, f.requestId)?.executionAudience).toEqual(f.tag); f.db.close();
});
it("review transition preserves the assignment's parent tag", () => {
  const f = cards(); expect(applyCardRunDispatched(f.db, { cardId: f.cardId, requestId: f.requestId, deskThreadId: "desk", now: 4 }).ok).toBe(true);
  expect(applyCardRunFinished(f.db, { cardId: f.cardId, requestId: f.requestId, reviewApplies: true, now: 5 }).ok).toBe(true);
  const review = assignCardReview(f.db, { cardId: f.cardId, reviewerBotId: "reviewer", leadBotId: "lead", memberIds: ["lead", "iris", "reviewer"], now: 6 });
  if (!review.ok) throw new Error(review.reason); expect(roomRequest(f.db, review.requestId)?.executionAudience).toEqual(f.tag); f.db.close();
});
it("retry transition preserves the original execution audience", () => {
  const f = cards(); expect(applyCardRunDispatched(f.db, { cardId: f.cardId, requestId: f.requestId, deskThreadId: "desk", now: 4 }).ok).toBe(true);
  expect(applyCardRunFailed(f.db, { cardId: f.cardId, requestId: f.requestId, reason: "fixture", now: 5 }).ok).toBe(true);
  const retry = retryProjectCard(f.db, { cardId: f.cardId, actor: f.actor, memberIds: ["lead", "iris"], now: 6 });
  if (!retry.ok) throw new Error(retry.reason); expect(roomRequest(f.db, retry.requestId!)?.executionAudience).toEqual(f.tag); f.db.close();
});
it("send-back transition preserves the calling lead's audience", () => {
  const f = cards(); expect(applyCardRunDispatched(f.db, { cardId: f.cardId, requestId: f.requestId, deskThreadId: "desk", now: 4 }).ok).toBe(true);
  expect(applyCardRunFinished(f.db, { cardId: f.cardId, requestId: f.requestId, reviewApplies: true, now: 5 }).ok).toBe(true);
  const back = sendProjectCardBack(f.db, { cardId: f.cardId, actor: f.actor, now: 6 });
  if (!back.ok) throw new Error(back.reason); expect(roomRequest(f.db, back.requestId!)?.executionAudience).toEqual(f.tag); f.db.close();
});
it("routine-card conversion copies the routine root's audience", () => {
  const f = cards();
  f.db.exec("UPDATE project_settings SET mode='ongoing'");
  const routine = recordProjectRoutine(f.db, { groupId: "p", threadId: "room", memberIds: ["lead", "iris"], runId: "routine", botId: "iris", name: "Routine", prompt: "Fixture", now: 10 });
  const parent = roomRequest(f.db, routine.requestId)!;
  const run = queueRoutineCardRun(f.db, parent, 11, {}); if (!run.ok) throw new Error(run.reason);
  expect(parent.executionAudience).toMatchObject({ kind: "project", projectId: "p" });
  expect(roomRequest(f.db, run.requestId)?.executionAudience).toEqual(parent.executionAudience); f.db.close();
});

it("delegation persists its tag and rejects malformed tags on restart", () => {
  _resetPending();
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" })), from = store.createBot(), target = store.createBot();
  const team = teamIdFor("Sales"), tag = { v: 1 as const, kind: "team" as const, human: "owner" as const, team, rootRequestId: "root" };
  const queued = queueDelegation({ store, broadcast: () => {} }, from, { toBotId: target.id, message: "fixture", depth: 0, executionAudience: tag }, 4);
  expect(queued.result).toBe("ok");
  const path = join(DATA_DIR, "delegations.json"), raw = JSON.parse(readFileSync(path, "utf8"));
  expect(raw[from.threadId][0].executionAudience).toEqual(tag);
  _resetPending(); _loadPending(); expect(_pendingCount(from.threadId)).toBe(1);
  raw[from.threadId][0].executionAudience = { ...tag, team: "../escape" }; writeFileSync(path, JSON.stringify(raw));
  _loadPending(); expect(_pendingCount(from.threadId)).toBe(0); _resetPending();
});

it("roots issue from the requesting partition and shared entry uses the actual request id", () => {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" })); const sam = store.createBot(), iris = store.createBot();
  store.patchBot(sam.id, { section: "Sales", chiefOfStaff: true }); const sales = teamIdFor("Sales");
  store.patchBot(iris.id, { section: "Design", sharedWith: { mode: "list", teams: [{ id: sales, name: "Sales" }] } });
  const shared = insertE1(database(), { id: "shared-root", groupId: "pair", verb: "ask", fromKind: "bot", fromBotId: sam.id, toBotId: iris.id, admissionKey: "shared-root", now: 1, lineage: { rootThreadId: sam.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false } }).request;
  expect(shared.executionAudience).toEqual({ v: 1, kind: "team", human: "owner", team: sales, rootRequestId: shared.id });
  const room = store.createGroup("Sales", [sam.id, iris.id], false, "Sales");
  const request = insertE1(database(), { id: "room-root", groupId: room.id, verb: "ask", fromKind: "bot", fromBotId: iris.id, toBotId: sam.id, admissionKey: "room-root", now: 2, lineage: { rootThreadId: room.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false } }).request;
  expect(request.executionAudience).toEqual({ v: 1, kind: "team", human: "owner", team: sales, rootRequestId: request.id });
  const work = store.createSharedWorkTask(iris.id, sales)!;
  const queued = queueDelegation({ store, broadcast: () => {} }, iris, { toBotId: sam.id, message: "root work", depth: 0 }, 4, work.threadId);
  expect(queued.result).toBe("ok");
  const persisted = JSON.parse(readFileSync(join(DATA_DIR, "delegations.json"), "utf8"))[work.threadId][0];
  expect(persisted.executionAudience).toEqual({ v: 1, kind: "team", human: "owner", team: sales, rootRequestId: queued.id });
  _resetPending();
});

it("delegation carries the bound turn audience through sourceExecutionAudience", () => {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const lead = store.createBot(), iris = store.createBot(), zed = store.createBot();
  store.patchBot(lead.id, { section: "Sales", chiefOfStaff: true }); const sales = teamIdFor("Sales");
  for (const bot of [iris, zed]) store.patchBot(bot.id, { section: bot.id, sharedWith: { mode: "all", teams: [] } });
  const work = store.createSharedWorkTask(iris.id, sales)!;
  const tag = { v: 1 as const, kind: "team" as const, human: "owner" as const, team: sales, rootRequestId: "bound-root" };
  const root = insertE1(database(), { id: "bound-root", groupId: "pair", targetThreadId: work.threadId, fromKind: "bot", fromBotId: lead.id, toBotId: iris.id, verb: "ask", admissionKey: "bound-root", now: 1,
    lineage: { rootThreadId: lead.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false, executionAudience: tag } }).request;
  const audience = sourceExecutionAudience(iris.id, work.threadId, root.id, true);
  const queued = queueDelegation({ store, broadcast: () => {} }, iris, { toBotId: zed.id, message: "bound", depth: 0, executionAudience: audience ?? undefined }, 4, work.threadId);
  expect(queued.result).toBe("ok");
  expect(JSON.parse(readFileSync(join(DATA_DIR, "delegations.json"), "utf8"))[work.threadId][0].executionAudience).toEqual(tag);
  _resetPending();
});
