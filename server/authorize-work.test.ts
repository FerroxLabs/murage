// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createWorkAdmission } from "./work-admission.ts";
import { completeRequest, insertRoomRequest, queueReviewWake, roomRequest } from "./room-requests.ts";
import { createRoomDispatcher } from "./room-dispatcher.ts";
import { channelToProjectRows } from "./project-settings.ts";
import { createProjectGoal } from "./project-goals.ts";
import { reopenProject, resumeGoalCloseSummaries, resumeProjectCloses, startGoalCloseSummary, startProjectClose } from "./project-close.ts";
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR, loadConfig, saveConfig } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import { teamIdFor } from "./team-identities.ts";
import { setAutomationProbe } from "./message-allow.ts";
import { authorizeWork, sharedWithTeam } from "./execution-audience.ts";
import { authorizeAdmission, sharedRowAudience } from "./shared-work.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
function fixture() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const make = (name: string, section: string) => { const bot = store.createBot(); store.patchBot(bot.id, { name, section }); return bot; };
  const iris = make("Iris", "Design"), carl = make("Carl", "Design"), sam = make("Sam", "Sales"), bob = make("Bob", "Sales"), zed = make("Zed", "Support");
  sam.chiefOfStaff = true;
  const sales = teamIdFor("Sales");
  iris.partitionedAt = zed.partitionedAt = 1;
  iris.sharedWith = zed.sharedWith = { mode: "list", teams: [{ id: sales, name: "Sales" }] };
  return { store, iris, carl, sam, bob, zed, sales };
}
it("allows Sam, refuses Bob and messageAllow into a partitioned target", () => {
  const { iris, sam, bob, sales } = fixture();
  const ask = (requester: typeof sam) => authorizeWork({ edge: "peer", requesterBotId: requester.id, requesterThreadId: requester.threadId, targetBotId: iris.id, verb: "ask", tag: null, ownerAudience: true });
  expect(ask(sam)).toMatchObject({ ok: true, clause: 5, issue: { kind: "team", team: sales } });
  expect(ask(bob)).toMatchObject({ ok: false, code: "not_reachable" });
  bob.messageAllow = { mode: "list", botIds: [iris.id] }; expect(ask(bob).ok).toBe(false);
});
it("team chains reach home members and shared bots but not another home", () => {
  const { store, iris, bob, carl, zed, sales } = fixture(); const work = store.createSharedWorkTask(iris.id, sales)!;
  const tag = { v: 1 as const, kind: "team" as const, team: sales, human: "owner" as const, rootRequestId: "root" };
  const ask = (id: string, ownerAudience = true) => authorizeWork({ edge: "peer", requesterBotId: iris.id, requesterThreadId: work.threadId, targetBotId: id, verb: "ask", tag, ownerAudience });
  expect(ask(bob.id)).toMatchObject({ ok: true, clause: 2 }); expect(ask(zed.id)).toMatchObject({ ok: true, clause: 2 }); expect(ask(carl.id).ok).toBe(false); expect(ask(zed.id, false).ok).toBe(false);
});
it("room partition cannot cross into another partitioned bot", () => {
  const { store, iris, bob, zed } = fixture(); const room = store.createGroup("mixed", [iris.id, bob.id, zed.id]);
  const ask = (id: string) => authorizeWork({ edge: "peer", requesterBotId: iris.id, requesterThreadId: room.threadId, targetBotId: id, verb: "ask", tag: null, ownerAudience: true });
  expect(ask(bob.id)).toMatchObject({ ok: true, clause: 3 }); expect(ask(zed.id).ok).toBe(false);
});
it("checks archived targets and dispatch binding", () => {
  const { store, iris, sales } = fixture(); const task = store.createSharedWorkTask(iris.id, sales)!;
  const edge = { edge: "dispatch" as const, requestId: "owner", ownerOrigin: true, targetBotId: iris.id, targetThreadId: task.threadId, tag: null, kind: "shared" as const };
  expect(authorizeWork(edge)).toMatchObject({ ok: false, code: "binding_mismatch" }); iris.hidden = true;
  expect(authorizeWork(edge)).toMatchObject({ ok: false, code: "archived" });
});

it("flag off holds shared starts, while a running turn resumes", () => {
  const { store, iris, sam, sales } = fixture();
  const cfg = loadConfig(); saveConfig({ ...cfg, features: { ...cfg.features, botsSharedAcrossTeams: false } });
  expect(authorizeWork({ edge: "peer", requesterBotId: sam.id, requesterThreadId: sam.threadId, targetBotId: iris.id, verb: "ask", tag: null, ownerAudience: true })).toMatchObject({ ok: false, code: "shared_paused", retry: "queue" });
  const work = store.createSharedWorkTask(iris.id, sales)!;
  const tag = { v: 1 as const, kind: "team" as const, human: "owner" as const, team: sales, rootRequestId: "run" };
  const db = database();
  insertRoomRequest(db, { id: "run", groupId: "pair", targetThreadId: work.threadId, toBotId: iris.id, verb: "ask", fromKind: "owner", admissionKey: "run", now: 1, state: "running", lineage: { rootThreadId: work.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false, executionAudience: tag } });
  expect(authorizeWork({ edge: "resume", botId: iris.id, threadId: work.threadId, generation: "gen", requestId: "run" })).toMatchObject({ ok: true });
});
it("closed work only admits its finishing request and delivery generation", () => {
  const { store, iris, sam, sales } = fixture(); const work = store.createSharedWorkTask(iris.id, sales)!;
  Object.assign(work.sharedWork!, { closedAt: 2, closedReason: "revoked", finishing: { generation: "generation" } });
  expect(authorizeWork({ edge: "peer", requesterBotId: sam.id, requesterThreadId: sam.threadId, targetBotId: iris.id, verb: "ask", ownerAudience: true, tag: null })).toMatchObject({ ok: false, code: "sharing_removed" });
  expect(authorizeWork({ edge: "deliver", fromBotId: iris.id, destinationThreadId: sam.threadId, generation: "generation" })).toMatchObject({ ok: true, clause: "finishing" });
  expect(authorizeWork({ edge: "resume", botId: iris.id, threadId: work.threadId, generation: "other", ownerOrigin: true })).toMatchObject({ ok: false, code: "sharing_removed" });
});
it("all covers a future named team, excluding home and General", () => {
  const { iris } = fixture(); iris.sharedWith = { mode: "all", teams: [] };
  expect(sharedWithTeam(iris, teamIdFor("Future"))).toBe(true);
  expect(sharedWithTeam(iris, teamIdFor("Design"))).toBe(false);
  expect(() => teamIdFor("")).toThrow();
});

it("project membership wins over sharing and team tags preserve the chain root", () => {
  const { store, iris, sam, zed, sales } = fixture();
  const project = store.createGroup("Project", [sam.id], false, "Sales"); database().prepare("INSERT INTO project_settings(group_id,updated_at) VALUES(?,1)").run(project.id);
  const desk = store.ensureProjectDesk(sam.id, project.id, "Project")!;
  const projectTag = { v: 1 as const, kind: "project" as const, human: "owner" as const, projectId: project.id, rootRequestId: "root" };
  expect(authorizeWork({ edge: "peer", requesterBotId: sam.id, requesterThreadId: desk.threadId, targetBotId: iris.id, verb: "ask", tag: projectTag, ownerAudience: true }).ok).toBe(false);
  const work = store.createSharedWorkTask(iris.id, sales)!, tag = { v: 1 as const, kind: "team" as const, human: "owner" as const, team: sales, rootRequestId: "root" };
  expect(authorizeWork({ edge: "peer", requesterBotId: iris.id, requesterThreadId: work.threadId, targetBotId: zed.id, verb: "delegate", tag, ownerAudience: true })).toMatchObject({ ok: true, clause: 2 });
});
it("a team-tagged home member does not escape to the Chief", () => {
  const { store, iris, bob, sales } = fixture(); const chief = store.createBot(); chief.chiefOfStaff = true; chief.chiefScope = "workspace";
  const tag = { v: 1 as const, kind: "team" as const, human: "owner" as const, team: sales, rootRequestId: "root" };
  const ask = (targetBotId: string) => authorizeWork({ edge: "peer", requesterBotId: bob.id, requesterThreadId: bob.threadId, targetBotId, verb: "ask", tag, ownerAudience: true });
  expect(ask(iris.id)).toMatchObject({ ok: true, clause: 2 }); expect(ask(chief.id).ok).toBe(false);
});
it("a retired team closes work and new labels never resurrect its grant", () => {
  const { store, iris, sam, sales } = fixture(); const task = store.createSharedWorkTask(iris.id, sales)!;
  Object.assign(task.sharedWork!, { closedAt: 10, closedReason: "team-deleted" }); database().prepare("UPDATE team_identities SET retired_at=10 WHERE team_id=?").run(sales);
  const tag = { v: 1 as const, kind: "team" as const, human: "owner" as const, team: sales, rootRequestId: "root" };
  expect(authorizeWork({ edge: "dispatch", requestId: "new", ownerOrigin: true, targetBotId: iris.id, targetThreadId: task.threadId, tag, kind: "shared" })).toMatchObject({ ok: false, code: "team_deleted" });
  teamIdFor("Sales"); expect(authorizeWork({ edge: "peer", requesterBotId: sam.id, requesterThreadId: sam.threadId, targetBotId: iris.id, tag: null, verb: "ask", ownerAudience: true }).ok).toBe(false);
});
it("the admission authorize seam preserves retryable and terminal refusals", () => {
  const admission = createWorkAdmission({ restoreReview: () => false, flags: () => ({ autonomy: true, budgets: false }), threadRunning: () => false, speakingInRoom: () => false, directThreads: () => 0, maxThreads: 3, installCardCap: 4, rootCounters: () => ({ wakes: 0, workMs: 0 }), askWouldDeadlock: () => false, reachable: () => { throw new Error("legacy reach must not run"); }, authorize: () => ({ ok: false, reason: "shared_paused", retryable: true }), dependencyOpen: () => false, claimWriterRoot: () => () => {}, now: () => 1 });
  expect(admission.admit({ kind: "ask", priority: "work", botId: "b", threadId: "t", ownerOrigin: true, audience: { ownerAudience: true, fingerprint: "owner" }, now: 1 })).toMatchObject({ admit: false, reason: "shared_paused", retry: "queue" });
});

it("finishing permits admitted children and wakes, and only new asks to team home members", () => {
  const { store, iris, bob, zed, sales } = fixture(); const work = store.createSharedWorkTask(iris.id, sales)!;
  const tag = { v: 1 as const, kind: "team" as const, human: "owner" as const, team: sales, rootRequestId: "root" };
  const root = insertRoomRequest(database(), { id: "root", groupId: "pair", targetThreadId: work.threadId, toBotId: iris.id, verb: "ask", fromKind: "owner", admissionKey: "root", now: 1, state: "running", lineage: { rootThreadId: work.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false, executionAudience: tag } }).request;
  const child = insertRoomRequest(database(), { parentId: root.id, groupId: "pair", targetThreadId: work.threadId, toBotId: iris.id, verb: "ask", fromKind: "bot", admissionKey: "child", now: 2 }).request;
  Object.assign(work.sharedWork!, { closedAt: 3, closedReason: "revoked", finishing: { requestId: root.id, rootRequestId: root.id } });
  const dispatch = (requestId: string) => authorizeWork({ edge: "dispatch", requestId, targetBotId: iris.id, targetThreadId: work.threadId, tag, kind: "shared" });
  expect(dispatch(child.id)).toMatchObject({ ok: true, clause: "finishing" });
  const wake = insertRoomRequest(database(), { parentId: root.id, groupId: "pair", targetThreadId: work.threadId, toBotId: iris.id, verb: "wake", fromKind: "murage", admissionKey: "wake", now: 4 }).request;
  expect(dispatch(wake.id)).toMatchObject({ ok: true, clause: "finishing" });
  const late = insertRoomRequest(database(), { parentId: root.id, groupId: "pair", targetThreadId: work.threadId, toBotId: iris.id, verb: "ask", fromKind: "bot", admissionKey: "late", now: 4 }).request;
  expect(dispatch(late.id)).toMatchObject({ ok: false, code: "sharing_removed" });
  const ask = (targetBotId: string) => authorizeWork({ edge: "peer", requesterBotId: iris.id, requesterThreadId: work.threadId, targetBotId, parentRequestId: root.id, verb: "ask", tag, ownerAudience: true });
  expect(ask(bob.id)).toMatchObject({ ok: true, clause: 2 }); expect(ask(zed.id).ok).toBe(false);
});

it("an unproven dispatch cannot claim the owner clause in a work thread", () => {
  const { store, iris, sales } = fixture(); const task = store.createSharedWorkTask(iris.id, sales)!;
  const tag = { v: 1 as const, kind: "team" as const, human: "owner" as const, team: sales, rootRequestId: "unproven" };
  insertRoomRequest(database(), { id: "unproven", groupId: "pair", targetThreadId: task.threadId, toBotId: iris.id, verb: "owner_send", fromKind: "owner", admissionKey: "unproven", now: 1, lineage: { rootThreadId: task.threadId, origin: "unproven", audienceFingerprint: "unproven", notOwnerAudience: true, unattended: true, executionAudience: tag } });
  expect(authorizeWork({ edge: "dispatch", requestId: "unproven", targetBotId: iris.id, targetThreadId: task.threadId, tag, kind: "shared" })).toMatchObject({ ok: false, code: "not_reachable" });
});

it("a persisted team chain refuses a lead moved to another team even with all-mode coverage",()=>{
  const {store,iris,sam,sales}=fixture();store.patchBot(iris.id,{sharedWith:{mode:"all",teams:[]}});store.patchBot(sam.id,{section:"Support",chiefOfStaff:true});teamIdFor("Support");
  expect(authorizeWork({edge:"peer",requesterBotId:sam.id,requesterThreadId:sam.threadId,targetBotId:iris.id,verb:"delegate",tag:{v:1,kind:"team",human:"owner",team:sales,rootRequestId:"old"},ownerAudience:true})).toMatchObject({ok:false,code:"binding_mismatch"});
});

// Final review C2: a mentionChain hop+1 member turn is a room_turn with no
// request row and no owner origin (index.ts admitRoomMember(..., undefined,
// "room_turn", false)); the plain room rule admits it by membership.
it("C2: a hop+1 room member turn with no request row is admitted by room membership", () => {
  const { store, iris, carl, bob, zed } = fixture();
  const room = store.createGroup("Chain", [carl.id, bob.id, iris.id], false, "Design");
  room.mentionChain = true; // a channel from before the turn engine: its replies summon the next member
  const admission = createWorkAdmission({ restoreReview: () => false, flags: () => ({ autonomy: true, budgets: false }), threadRunning: () => false, speakingInRoom: () => false, directThreads: () => 0, maxThreads: 3, installCardCap: 4, rootCounters: () => ({ wakes: 0, workMs: 0 }), askWouldDeadlock: () => false, reachable: () => false, authorize: authorizeAdmission, dependencyOpen: () => false, claimWriterRoot: () => () => {}, now: () => 1 });
  const hop = (botId: string) => admission.admit({ kind: "room_turn", priority: "coordinator", botId, threadId: room.threadId, ownerReplyTo: "owner", ownerOrigin: false, audience: { ownerAudience: true, fingerprint: "owner" }, now: 1 });
  const bobTurn = hop(bob.id); expect(bobTurn).toMatchObject({ admit: true }); if (bobTurn.admit) bobTurn.claim.release();
  // a partitioned member runs in its own partition of the room
  const irisTurn = hop(iris.id); expect(irisTurn).toMatchObject({ admit: true }); if (irisTurn.admit) irisTurn.claim.release();
  // a bot that is not in the room is still refused
  expect(hop(zed.id)).toMatchObject({ admit: false, reason: "not_reachable" });
});

// Final review C3: clause 1 (project) is the owner-audience project reach of
// the old reachProjectRoom gate. A project turn that is not the owner's
// audience (a contact's words) reaches only who plain messaging allows.
it.each(["ask", "delegate"] as const)("C3: a not-owner-audience project turn cannot %s across teams", verb => {
  const { store, carl, bob, sam } = fixture();
  const project = store.createGroup("Launch", [carl.id, bob.id, sam.id], false, "Design");
  database().prepare("INSERT INTO project_settings(group_id,updated_at) VALUES(?,1)").run(project.id);
  const desk = store.ensureProjectDesk(carl.id, project.id, "Launch")!;
  const tag = { v: 1 as const, kind: "project" as const, human: "owner" as const, projectId: project.id, rootRequestId: "root" };
  const reach = (targetBotId: string, ownerAudience: boolean) => authorizeWork({ edge: "peer", requesterBotId: carl.id, requesterThreadId: desk.threadId, targetBotId, verb, tag, ownerAudience });
  // the owner's project turn reaches every project member (E1's rule)
  expect(reach(bob.id, true)).toMatchObject({ ok: true, clause: 1 });
  // a contact's project turn does not cross into Sales
  expect(reach(bob.id, false)).toMatchObject({ ok: false, code: "not_reachable" });
  expect(reach(sam.id, false)).toMatchObject({ ok: false, code: "not_reachable" });
  // unless plain messaging already allows that pair
  store.patchBot(carl.id, { messageAllow: { mode: "list", botIds: [bob.id] } });
  expect(reach(bob.id, false)).toMatchObject({ ok: true, clause: 1 });
});

// Final review C4: a card row written before lane X has no execution_audience.
// Its dispatch reads as a project tag for the row's own project, so a
// partitioned member's non-home desk in a mixed-team project still runs.
it("C4: a pre-upgrade card row with no tag runs on a partitioned member's desk in a mixed-team project", () => {
  const { store, iris, sam } = fixture();
  const project = store.createGroup("Launch", [iris.id, sam.id], false, "Sales");
  database().prepare("INSERT INTO project_settings(group_id,updated_at) VALUES(?,1)").run(project.id);
  store.patchGroup(project.id, { channelProject: { goal: "fixture", status: "active", startedAt: 1, updatedAt: 1 } });
  const desk = store.ensureProjectDesk(iris.id, project.id, "Launch")!;
  const card = insertRoomRequest(database(), { groupId: project.id, toBotId: iris.id, verb: "assign", fromKind: "owner", admissionKey: "card", now: 1, workItemId: "card-1", lineage: { rootThreadId: project.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false } }).request;
  database().prepare("UPDATE room_requests SET execution_audience=NULL WHERE id=?").run(card.id);
  // what index.ts's card executor seam passes: the row's tag (null here)
  expect(authorizeWork({ edge: "dispatch", requestId: card.id, targetBotId: iris.id, targetThreadId: desk.threadId, tag: null, kind: "card" })).toMatchObject({ ok: true });
  expect(authorizeAdmission({ kind: "card_run", priority: "work", botId: iris.id, threadId: desk.threadId, requestId: card.id, workItemId: "card-1", ownerOrigin: false, audience: { ownerAudience: true, fingerprint: "owner" }, now: 1 })).toEqual({ ok: true });
  // a null tag never reaches a desk of another project
  const other = store.createGroup("Other", [iris.id, sam.id], false, "Sales");
  database().prepare("INSERT INTO project_settings(group_id,updated_at) VALUES(?,1)").run(other.id);
  const otherDesk = store.ensureProjectDesk(iris.id, other.id, "Other")!;
  expect(authorizeWork({ edge: "dispatch", requestId: card.id, targetBotId: iris.id, targetThreadId: otherDesk.threadId, tag: null, kind: "card" })).toMatchObject({ ok: false, code: "binding_mismatch" });
});

// Merge of lanes N and X: a close lesson is a Murage wake parented on its close
// summary so the lesson rides the summary's lineage. It is not a continuation
// of that summary (which is done, and went only to the lead), so the
// continuation rule must not judge it; its recorded close receipt does.
it("a project close or goal sign-off lesson wake reaches every member, while a look-alike wake on the same summary does not", () => {
  const { store, carl, bob } = fixture();
  const project = store.createGroup("Launch", [carl.id, bob.id], false, "Design");
  const db = database();
  channelToProjectRows(db, { groupId: project.id, bulletin: "", leadBotId: carl.id, now: 1 });
  const deps = { groupId: project.id, threadId: project.threadId, memberIds: [carl.id, bob.id], now: 10,
    lineage: { rootThreadId: project.threadId, origin: "server" as const, audienceFingerprint: "owner", notOwnerAudience: false, unattended: false },
    deliverables: () => [], routineNames: () => [], pauseRoutines: () => {}, post: () => {}, summary: () => "Done.", sync: () => {} };
  const dispatch = (id: string, botId: string) => { const row = roomRequest(db, id)!;
    return authorizeWork({ edge: "dispatch", requestId: id, targetBotId: botId, targetThreadId: project.threadId, tag: (row.executionAudience ?? null) as never, kind: "wake" }); };
  const lessons = (prefix: string) => db.prepare("SELECT id,to_bot_id FROM room_requests WHERE admission_key LIKE ? ORDER BY to_bot_id").all(`${prefix}%`) as Array<{ id: string; to_bot_id: string }>;
  // goal sign-off first: its lessons ride the goal summary
  const goal = createProjectGoal(db, { groupId: project.id, title: "Goal", now: 2 }); if (!goal.ok) throw new Error(goal.reason);
  db.prepare("UPDATE project_goals SET state='done' WHERE id=?").run(goal.goal.id);
  const goalSummary = startGoalCloseSummary(db, deps, goal.goal.id)!;
  completeRequest(db, goalSummary, { state: "done", now: 11 }, {}, { continuation: false }); resumeGoalCloseSummaries(db, deps);
  expect(lessons("goal-close-lesson:")).toHaveLength(2);
  for (const lesson of lessons("goal-close-lesson:")) expect(dispatch(lesson.id, lesson.to_bot_id)).toMatchObject({ ok: true });
  // then the project close: its lessons ride the close summary
  const { summaryRequestId } = startProjectClose(db, deps);
  completeRequest(db, summaryRequestId!, { state: "done", now: 12 }, {}, { continuation: false }); resumeProjectCloses(db, deps);
  const closeLessons = lessons("close-lesson:"); expect(closeLessons).toHaveLength(2);
  for (const lesson of closeLessons) expect(dispatch(lesson.id, lesson.to_bot_id)).toMatchObject({ ok: true });
  // a Murage wake on the same summary that is not a recorded lesson is still judged as a continuation
  const forged = insertRoomRequest(db, { groupId: project.id, verb: "wake", fromKind: "murage", toBotId: bob.id, targetThreadId: project.threadId, parentId: summaryRequestId!, admissionKey: "forged", now: 13 }).request;
  expect(dispatch(forged.id, bob.id)).toMatchObject({ ok: false, code: "not_reachable" });
  // so is a lesson-shaped key for a close that was never recorded
  const wrongClose = insertRoomRequest(db, { groupId: project.id, verb: "wake", fromKind: "murage", toBotId: bob.id, targetThreadId: project.threadId, parentId: summaryRequestId!, admissionKey: `close-lesson:${project.id}:999:${bob.id}`, now: 13 }).request;
  expect(dispatch(wrongClose.id, bob.id)).toMatchObject({ ok: false, code: "not_reachable" });
  // a lesson still queued after Reopen keeps its receipt and still runs (it never plans; see project-close-guard-api)
  reopenProject(db, { groupId: project.id, now: 14, sync: () => {} });
  for (const lesson of closeLessons) expect(dispatch(lesson.id, lesson.to_bot_id)).toMatchObject({ ok: true });
});

// Merge of lanes PF and X: an owner card's run that put its card in review
// wakes the lead (`wake:review:<run>`, readdressed `wake:review:<run>:<id>`,
// re-queued `wake:review:<run>:held:<n>`) and the old lead keeps its own
// answers (`wake:kept:<wake>`). Each is a Murage wake parented on the owner
// card's run, which returns to nobody: not a continuation, so the room
// dispatcher's real authorizeWork must not cancel it as unreachable.
it("review, readdressed, held and kept wakes of an owner card's run reach the lead through the room dispatcher", () => {
  const { store, iris, carl, bob, sam } = fixture();
  const project = store.createGroup("Launch", [carl.id, bob.id, sam.id], false, "Design");
  const db = database();
  channelToProjectRows(db, { groupId: project.id, bulletin: "", leadBotId: carl.id, now: 1 });
  const setLead = (botId: string) => db.prepare("UPDATE project_settings SET lead_bot_id=? WHERE group_id=?").run(botId, project.id);
  let members = [carl.id, bob.id, sam.id], lead = carl.id;
  const lineage = { rootThreadId: project.threadId, origin: "desktop" as const, audienceFingerprint: "owner", notOwnerAudience: false, unattended: false };
  const ownerRun = (key: string) => { const run = insertRoomRequest(db, { groupId: project.id, verb: "assign", fromKind: "owner", toBotId: bob.id, workItemId: `card-${key}`, admissionKey: key, now: 2, lineage }).request;
    db.prepare("UPDATE room_requests SET state='done', finished_at=3 WHERE id=?").run(run.id); return roomRequest(db, run.id)!; };
  const admission = createWorkAdmission({ restoreReview: () => false, flags: () => ({ autonomy: true, budgets: true }), threadRunning: () => false, speakingInRoom: () => false, directThreads: () => 0, maxThreads: 3, installCardCap: 4, rootCounters: () => ({ wakes: 0, workMs: 0 }), askWouldDeadlock: () => false, reachable: () => true, authorize: authorizeAdmission, dependencyOpen: () => false, claimWriterRoot: () => () => {}, now: () => 5 });
  admission.setBudgetGate({ check: () => ({ ok: true }) });
  const started: string[] = [], closed: string[] = [];
  // what index.ts's room dispatcher passes: the real authorizeWork on the row
  const dispatcher = createRoomDispatcher({ db: () => db, admission, now: () => 5, open: () => true, roomUsable: () => true, roomBusy: () => false,
    projectContext: () => ({ groupId: project.id, isProject: true, closed: false, runState: "running", mode: "ongoing", leadBotId: lead, boardOn: true, parallelCards: 1 }),
    memberIds: () => members, audienceStillValid: () => true, ownerOrigin: () => false, startOwnerSend: () => {},
    startMemberTurn: (request, claim) => { started.push(request.admissionKey); claim.release(); }, onClosed: (request, line) => { closed.push(`${request.admissionKey}: ${line}`); },
    onStillWaiting: () => {}, changed: () => {},
    authorize: request => authorizeWork({ edge: "dispatch", requestId: request.id, targetBotId: request.toBotId!, targetThreadId: request.targetThreadId ?? request.rootThreadId, tag: sharedRowAudience(request), kind: request.verb === "wake" ? "wake" : "room" }) });
  const pump = () => { for (let i = 0; i < 4; i++) dispatcher.pump(); };
  // the lead's review wake
  const first = ownerRun("run-1");
  const review = queueReviewWake(db, first, { toBotId: carl.id, threadId: project.threadId, now: 4 })!;
  pump();
  expect(closed).toEqual([]); expect(started).toEqual([review.admissionKey]);
  // re-queued under a fresh key once the base key's wake ended
  const held = queueReviewWake(db, first, { toBotId: carl.id, threadId: project.threadId, now: 4, key: `wake:review:${first.id}:held:1` })!;
  pump();
  expect(closed).toEqual([]); expect(started).toContain(held.admissionKey);
  // readdressed to a new lead before it was admitted
  const second = ownerRun("run-2");
  const stale = queueReviewWake(db, second, { toBotId: carl.id, threadId: project.threadId, now: 4 })!;
  setLead(sam.id); lead = sam.id;
  pump();
  const moved = `wake:review:${second.id}:${stale.id}`;
  expect(closed).toEqual([]); expect(started).toContain(moved); expect(roomRequest(db, stale.id)!.state).toBe("done");
  // a lead that is not a member holds the owner card's result; the old lead (still a member) keeps its own answer
  setLead(carl.id); lead = carl.id;
  const third = ownerRun("run-3");
  const ask = insertRoomRequest(db, { groupId: project.id, verb: "ask", fromKind: "bot", fromBotId: carl.id, toBotId: bob.id, targetThreadId: project.threadId, admissionKey: "carl-ask", now: 4, lineage }).request;
  const both = queueReviewWake(db, third, { toBotId: carl.id, threadId: project.threadId, now: 4 })!;
  db.prepare("UPDATE room_requests SET payload_text=? WHERE id=?").run(JSON.stringify([{ requestId: third.id, botId: bob.id, state: "done" }, { requestId: ask.id, botId: bob.id, state: "done" }]), both.id);
  setLead(iris.id); lead = iris.id;
  pump();
  expect(closed).toEqual([]); expect(started).toContain(`wake:kept:${both.id}`);
  expect(roomRequest(db, both.id)!.state).toBe("queued");
  // every other refusal stands: judged straight through authorizeWork
  const dispatch = (id: string, botId: string) => authorizeWork({ edge: "dispatch", requestId: id, targetBotId: botId, targetThreadId: project.threadId, tag: sharedRowAudience(roomRequest(db, id)!), kind: "wake" });
  const wake = (parentId: string, toBotId: string, key: string) => insertRoomRequest(db, { groupId: project.id, verb: "wake", fromKind: "murage", toBotId, targetThreadId: project.threadId, parentId, admissionKey: key, now: 6 }).request.id;
  setLead(carl.id); lead = carl.id;
  const fourth = ownerRun("run-4");
  expect(dispatch(wake(fourth.id, carl.id, `wake:review:${fourth.id}`), carl.id)).toMatchObject({ ok: true });
  // a review wake for anyone but the current lead
  expect(dispatch(wake(fourth.id, bob.id, `wake:review:${fourth.id}:held:9`), bob.id)).toMatchObject({ ok: false, code: "not_reachable" });
  // a review key naming another run
  expect(dispatch(wake(fourth.id, carl.id, `wake:review:${first.id}:held:9`), carl.id)).toMatchObject({ ok: false, code: "not_reachable" });
  // a kept wake for a bot the split review wake was not addressed to
  expect(dispatch(wake(third.id, sam.id, `wake:kept:${both.id}:7`), sam.id)).toMatchObject({ ok: false, code: "not_reachable" });
  // nor for an old lead who has left the project
  members = [bob.id, sam.id]; store.patchGroup(project.id, { memberIds: members });
  expect(dispatch(wake(third.id, carl.id, `wake:kept:${both.id}:8`), carl.id)).toMatchObject({ ok: false });
  members = [carl.id, bob.id, sam.id]; store.patchGroup(project.id, { memberIds: members });
  // a review-shaped wake on a lead's card run is judged as that run's continuation
  const leadRun = insertRoomRequest(db, { groupId: project.id, verb: "assign", fromKind: "bot", fromBotId: sam.id, returnBotId: sam.id, toBotId: bob.id, workItemId: "card-lead", admissionKey: "lead-run", now: 2, lineage }).request;
  db.prepare("UPDATE room_requests SET state='done' WHERE id=?").run(leadRun.id);
  expect(dispatch(wake(leadRun.id, carl.id, `wake:review:${leadRun.id}`), carl.id)).toMatchObject({ ok: false, code: "not_reachable" });
  // and the ordinary continuation of goal work, a card returning to the lead who handed it over, still runs
  expect(dispatch(wake(leadRun.id, sam.id, `wake:${leadRun.id}`), sam.id)).toMatchObject({ ok: true });
});

// Round 18 (F1): a lead change to a member moved the owner card's result and
// left the old lead's own answer on the base `wake:review:<run>` row, which the
// dispatcher refused (its addressee is no longer the lead) and the old lead
// never heard it. The answer rides its own `wake:kept:<wake>` row instead.
it("a lead change to a member hands the old lead its own answer through the room dispatcher", () => {
  const { store, carl, bob, sam } = fixture();
  const project = store.createGroup("Launch", [carl.id, bob.id, sam.id], false, "Design");
  const db = database();
  channelToProjectRows(db, { groupId: project.id, bulletin: "", leadBotId: carl.id, now: 1 });
  let lead = carl.id;
  const lineage = { rootThreadId: project.threadId, origin: "desktop" as const, audienceFingerprint: "owner", notOwnerAudience: false, unattended: false };
  const run = insertRoomRequest(db, { groupId: project.id, verb: "assign", fromKind: "owner", toBotId: bob.id, workItemId: "card-1", admissionKey: "run-1", now: 2, lineage }).request;
  db.prepare("UPDATE room_requests SET state='done', finished_at=3 WHERE id=?").run(run.id);
  const ask = insertRoomRequest(db, { groupId: project.id, verb: "ask", fromKind: "bot", fromBotId: carl.id, toBotId: bob.id, targetThreadId: project.threadId, admissionKey: "carl-ask", now: 4, lineage }).request;
  const base = queueReviewWake(db, roomRequest(db, run.id)!, { toBotId: carl.id, threadId: project.threadId, now: 4 })!;
  db.prepare("UPDATE room_requests SET payload_text=? WHERE id=?").run(JSON.stringify([{ requestId: run.id, botId: bob.id, state: "done" }, { requestId: ask.id, botId: bob.id, state: "done" }]), base.id);
  const admission = createWorkAdmission({ restoreReview: () => false, flags: () => ({ autonomy: true, budgets: true }), threadRunning: () => false, speakingInRoom: () => false, directThreads: () => 0, maxThreads: 3, installCardCap: 4, rootCounters: () => ({ wakes: 0, workMs: 0 }), askWouldDeadlock: () => false, reachable: () => true, authorize: authorizeAdmission, dependencyOpen: () => false, claimWriterRoot: () => () => {}, now: () => 5 });
  admission.setBudgetGate({ check: () => ({ ok: true }) });
  const started: string[] = [], closed: string[] = [];
  const dispatcher = createRoomDispatcher({ db: () => db, admission, now: () => 5, open: () => true, roomUsable: () => true, roomBusy: () => false,
    projectContext: () => ({ groupId: project.id, isProject: true, closed: false, runState: "running", mode: "ongoing", leadBotId: lead, boardOn: true, parallelCards: 1 }),
    memberIds: () => [carl.id, bob.id, sam.id], audienceStillValid: () => true, ownerOrigin: () => false, startOwnerSend: () => {},
    startMemberTurn: (request, claim) => { started.push(`${request.toBotId} ${request.admissionKey}`); claim.release(); }, onClosed: (request, line) => { closed.push(`${request.admissionKey}: ${line}`); },
    onStillWaiting: () => {}, changed: () => {},
    authorize: request => authorizeWork({ edge: "dispatch", requestId: request.id, targetBotId: request.toBotId!, targetThreadId: request.targetThreadId ?? request.rootThreadId, tag: sharedRowAudience(request), kind: request.verb === "wake" ? "wake" : "room" }) });
  db.prepare("UPDATE project_settings SET lead_bot_id=? WHERE group_id=?").run(sam.id, project.id); lead = sam.id;
  for (let i = 0; i < 4; i++) dispatcher.pump();
  expect(closed).toEqual([]);
  expect(started).toEqual(expect.arrayContaining([`${sam.id} wake:review:${run.id}:${base.id}`, `${carl.id} wake:kept:${base.id}`]));
  const kept = db.prepare("SELECT payload_text FROM room_requests WHERE admission_key=?").get(`wake:kept:${base.id}`) as { payload_text: string };
  expect((JSON.parse(kept.payload_text) as Array<{ requestId: string }>).map(result => result.requestId)).toEqual([ask.id]);
  expect(roomRequest(db, base.id)).toMatchObject({ state: "done", outcomeNote: "absorbed" });
});

it("one-way: the grantee starts a contact, the other bot cannot start one back", () => {
  const { store, carl, sam } = fixture();
  store.patchBot(carl.id, { messageAllow: { mode: "list", botIds: [sam.id] } });
  const ask = (from: typeof sam, to: typeof sam) => authorizeWork({ edge: "peer", requesterBotId: from.id, requesterThreadId: from.threadId, targetBotId: to.id, verb: "ask", tag: null, ownerAudience: true });
  expect(ask(carl, sam).ok).toBe(true);
  expect(ask(sam, carl).ok).toBe(false);
  store.patchBot(sam.id, { messageAllow: { mode: "list", botIds: [carl.id] } });
  expect(ask(sam, carl).ok).toBe(true);
});

it("one-way: A asks B, B's answer returns to A, and B cannot start anything fresh", () => {
  const { store, carl, sam } = fixture();
  store.patchBot(carl.id, { messageAllow: { mode: "list", botIds: [sam.id] } });
  const peer = (from: typeof sam, to: typeof sam, threadId = from.threadId) => authorizeWork({ edge: "peer", requesterBotId: from.id, requesterThreadId: threadId, targetBotId: to.id, verb: "ask", tag: null, ownerAudience: true });
  expect(peer(carl, sam).ok).toBe(true);
  const g = store.createGroup("Pair", [carl.id, sam.id], false, "Design");
  const root = insertRoomRequest(database(), { id: "ask1", groupId: g.id, targetThreadId: sam.threadId, toBotId: sam.id, fromBotId: carl.id, returnThreadId: carl.threadId, returnBotId: carl.id, verb: "ask", fromKind: "bot", admissionKey: "ask1", now: 1, state: "running", lineage: { rootThreadId: carl.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false, executionAudience: null } }).request;
  // B's answer flows back to A on the asked thread
  const answer = insertRoomRequest(database(), { parentId: root.id, groupId: g.id, targetThreadId: carl.threadId, toBotId: carl.id, fromBotId: sam.id, verb: "wake", fromKind: "bot", admissionKey: "ans1", now: 2 }).request;
  expect(authorizeWork({ edge: "dispatch", requestId: answer.id, targetBotId: carl.id, targetThreadId: carl.threadId, tag: null, kind: "wake" }).ok).toBe(true);
  // B starting a fresh request, on its own thread or on A's thread, is refused
  expect(peer(sam, carl).ok).toBe(false);
  expect(peer(sam, carl, carl.threadId).ok).toBe(false);
  // a forged destination: delivering B's answer to a thread that is not the asker's source is refused
  expect(authorizeWork({ edge: "deliver", requestId: answer.id, fromBotId: sam.id, destinationThreadId: sam.threadId }).ok).toBe(false);
  // permission changes are not a bot action: the reverse reach did not appear
  expect(sam.messageAllow).toBeUndefined();
});

it("Everyone does not apply to an unattended turn, a queued delegation, or a routine run", () => {
  const { carl, sam, iris } = fixture();
  carl.messageAllow = { mode: "all" };
  const ask = (extra: { unattended?: boolean } = {}) => authorizeWork({ edge: "peer", requesterBotId: carl.id, requesterThreadId: carl.threadId, targetBotId: sam.id, verb: "ask", tag: null, ownerAudience: true, ...extra });
  expect(ask().ok).toBe(true);
  expect(ask({ unattended: true }).ok).toBe(false);
  expect(authorizeWork({ edge: "peer", requesterBotId: carl.id, requesterThreadId: carl.threadId, targetBotId: iris.id, verb: "ask", tag: null, ownerAudience: true, unattended: true }).ok).toBe(true);
  setAutomationProbe((botId) => botId === carl.id);
  try { expect(ask().ok).toBe(false); } finally { setAutomationProbe(() => false); }
});

it("a project-scoped turn names the project, not Can talk to, for a same-team bot outside it", () => {
  const { store, carl, sam, iris } = fixture();
  const project = store.createGroup("Launch", [carl.id, sam.id], false, "Design");
  database().prepare("INSERT INTO project_settings(group_id,updated_at) VALUES(?,1)").run(project.id);
  store.patchGroup(project.id, { channelProject: { goal: "x", status: "active", startedAt: 1, updatedAt: 1 } });
  const desk = store.ensureProjectDesk(carl.id, project.id, "Launch")!;
  const tag = { v: 1 as const, kind: "project" as const, human: "owner" as const, projectId: project.id, rootRequestId: "root" };
  const refused = authorizeWork({ edge: "peer", requesterBotId: carl.id, requesterThreadId: desk.threadId, targetBotId: iris.id, verb: "ask", tag, ownerAudience: true });
  expect(refused).toMatchObject({ ok: false, line: "Add Iris to this project to ask Iris here." });
});
