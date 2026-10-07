// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import { teamIdFor } from "./team-identities.ts";
import { audienceTask, authorizeWork, homeThread, issueWorkAudience, learningDestination, markPartitions, setExecutionTurnLookup, threadPartition } from "./execution-audience.ts";
import { OWNER, humanTask, observeVerifiedHuman, linkHumanBinding, resolveHumanBinding } from "./human-principals.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { ensureScope } from "./memory/policy.ts";
import { insertRoomRequest } from "./room-requests.ts";
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
function fixture() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const make = (name: string, section: string) => { const b = store.createBot(); store.patchBot(b.id, { name, section }); return b; };
  const iris = make("Iris", "Design"), sam = make("Sam", "Sales"), bob = make("Bob", "Sales"), zed = make("Zed", "Support"), carl = make("Carl", "Design");
  const sales = teamIdFor("Sales"); store.patchBot(sam.id, { chiefOfStaff: true });
  for (const b of [iris, zed]) store.patchBot(b.id, { sharedWith: { mode: "list", teams: [{ id: sales, name: "Sales" }] } });
  const tag = { v: 1 as const, kind: "team" as const, human: "owner" as const, team: sales, rootRequestId: "root" };
  const peer = (from = sam, target = iris, thread = from.threadId, audience: typeof tag | null = null, parentRequestId?: string) => authorizeWork({ edge: "peer", requesterBotId: from.id, requesterThreadId: thread, targetBotId: target.id, verb: "ask", tag: audience, ownerAudience: true, parentRequestId });
  return { store, iris, sam, bob, zed, carl, sales, tag, peer };
}
it("R1.1 NULL room chain issues this request's team tag", () => {
  const f = fixture(), room = f.store.createGroup("Sales", [f.iris.id, f.sam.id], false, "Sales");
  expect(issueWorkAudience(f.iris.id, f.zed.id, room.threadId, null, "new-request", true)).toEqual({ ...f.tag, rootRequestId: "new-request" });
  expect(f.peer(f.iris, f.carl, room.threadId)).toMatchObject({ ok: false, code: "not_reachable", retry: "never" });
});
it("R1.2 deleted project desk never classifies as home", () => {
  const f = fixture(), desk = f.store.ensureProjectDesk(f.iris.id, "deleted-project", "Gone")!;
  expect(threadPartition(f.iris, desk.threadId)).toEqual({ kind: "project", groupId: "deleted-project", homeMember: false });
  expect(f.peer(f.iris, f.carl, desk.threadId)).toMatchObject({ ok: false, code: "not_reachable" });
});
it("R1.3 eager marking skips an unmarked project; old marker wins", () => {
  const f = fixture(), room = f.store.createGroup("Project", [f.carl.id, f.sam.id], false, "Sales");
  database().prepare("INSERT INTO project_settings(group_id,updated_at) VALUES(?,1)").run(room.id);
  f.store.patchGroup(room.id, { memberIds: [f.iris.id, f.sam.id] });
  expect(room.partitionedFor?.[f.iris.id]).toBeUndefined();
  expect(threadPartition(f.iris, room.threadId)).toEqual({ kind: "project", groupId: room.id, homeMember: false });
  expect(f.peer(f.iris, f.carl, room.threadId)).toMatchObject({ ok: false, code: "not_reachable" });
  expect(f.peer(f.iris, f.sam, room.threadId)).toMatchObject({ ok: true, clause: 1 });
});
it.each(["dispatch", "resume", "deliver"] as const)("R1.4 %s needs proven authority", edge => {
  const f = fixture();
  const input = edge === "dispatch" ? { edge, requestId: "missing", targetBotId: f.iris.id, targetThreadId: f.iris.threadId, tag: null, kind: "delegation" as const } : edge === "resume" ? { edge, requestId: "missing", generation: "missing", botId: f.iris.id, threadId: f.iris.threadId } : { edge, requestId: "missing", fromBotId: f.iris.id, destinationThreadId: f.iris.threadId };
  expect(authorizeWork(input)).toMatchObject({ ok: false, code: "not_reachable" });
});
it("R3c C2: a live home turn with no bound row resumes, a live non-home turn without a row does not", () => {
  const f = fixture(), work = f.store.createSharedWorkTask(f.iris.id, f.sales)!;
  setExecutionTurnLookup(generation => generation === "home-live" ? { botId: f.iris.id, threadId: f.iris.threadId } : generation === "work-live" ? { botId: f.iris.id, threadId: work.threadId } : undefined);
  try {
    expect(authorizeWork({ edge: "resume", generation: "home-live", botId: f.iris.id, threadId: f.iris.threadId })).toMatchObject({ ok: true, clause: 4 });
    expect(authorizeWork({ edge: "resume", generation: "work-live", botId: f.iris.id, threadId: work.threadId })).toMatchObject({ ok: false, code: "not_reachable" });
    expect(authorizeWork({ edge: "resume", generation: "home-live", botId: f.iris.id, threadId: work.threadId })).toMatchObject({ ok: false });
  } finally { setExecutionTurnLookup(() => undefined); }
});
it("R1.5 dispatch uses parent target, not root home, for shared descendants", () => {
  const f = fixture(), work = f.store.createSharedWorkTask(f.iris.id, f.sales)!, target = f.store.createSharedWorkTask(f.zed.id, f.sales)!;
  const lineage = { rootThreadId: f.sam.threadId, origin: "desktop" as const, audienceFingerprint: "owner", notOwnerAudience: false, unattended: false, executionAudience: f.tag };
  insertRoomRequest(database(), { id: "root", groupId: "pair", targetThreadId: work.threadId, fromKind: "bot", fromBotId: f.sam.id, toBotId: f.iris.id, verb: "ask", admissionKey: "root", now: 1, lineage });
  insertRoomRequest(database(), { id: "child", parentId: "root", groupId: "pair", targetThreadId: target.threadId, fromKind: "bot", fromBotId: f.iris.id, toBotId: f.zed.id, verb: "ask", admissionKey: "child", now: 2, lineage });
  expect(authorizeWork({ edge: "dispatch", requestId: "child", targetBotId: f.zed.id, targetThreadId: target.threadId, tag: f.tag, kind: "delegation" })).toMatchObject({ ok: true, clause: 2 });
});
it("R1.6 selecting a team task cannot mint unauthorized work", () => {
  const f = fixture(); expect(audienceTask(f.store, f.carl, OWNER, f.tag)).toBeNull();
  expect(f.carl.tasks?.some(t => t.sharedWork)).toBe(false);
  expect(f.peer(f.bob)).toMatchObject({ ok: false, code: "not_reachable" });
});
it.each(["slack", "discord", "telegram"] as const)("R1.7 owner-linked %s retains exact channel binding", platform => {
  const f = fixture(), bindingId = observeVerifiedHuman({ platform, connectionId: "fixture", authorityId: "fixture", userId: "owner" });
  linkHumanBinding(ownerMemoryTicket(), { bindingId, expectedRevision: 1, as: "owner" });
  const principal = resolveHumanBinding(bindingId), task = humanTask(f.store, f.iris.id, principal)!;
  expect(task.threadId).not.toBe(f.iris.threadId); expect(audienceTask(f.store, f.iris, principal, f.tag)).toBe(task);
});
it.each([false, true])("R1.8 unpartitioned scope retains room/project identity (project=%s)", project => {
  const f = fixture(), room = f.store.createGroup("Room", [f.carl.id], false, "Design");
  if (project) database().prepare("INSERT INTO project_settings(group_id,updated_at) VALUES(?,1)").run(room.id);
  // Final review C1 ruling: an unpartitioned bot is always home with the owner audience key; the room or
  // project scope keeps its identity as the destination scope itself.
  const scope = ensureScope("room", room.id);
  expect(learningDestination({ botId: f.carl.id, evidenceScopeIds: [scope], target: "memory" })).toEqual({ ok: true, scopeId: scope, partition: { kind: "home" }, audienceKey: `bot:${f.carl.id}:owner` });
});
it("R1.9 first all-mode admission mints lead team identity", () => {
  const f = fixture(); f.store.patchBot(f.iris.id, { sharedWith: { mode: "all", teams: [] } }); f.store.patchBot(f.sam.id, { section: "New" });
  expect(f.peer()).toMatchObject({ ok: true, clause: 5 });
});
it("R1.10 an earlier child cannot issue new finishing descendants", () => {
  const f = fixture(), work = f.store.createSharedWorkTask(f.iris.id, f.sales)!;
  insertRoomRequest(database(), { id: "earlier", groupId: "pair", fromKind: "bot", fromBotId: f.iris.id, toBotId: f.sam.id, targetThreadId: f.sam.threadId, verb: "ask", admissionKey: "earlier", now: 1, lineage: { rootThreadId: f.sam.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false, executionAudience: f.tag } });
  Object.assign(work.sharedWork!, { closedAt: 10, closedReason: "revoked", finishing: { requestId: "run", rootRequestId: "root" } });
  expect(f.peer(f.iris, f.sam, work.threadId, f.tag, "earlier")).toMatchObject({ ok: false, code: "sharing_removed" });
});
it("R1.11 unpartitioned active routine default is unchanged and does not scan history", () => {
  const f = fixture(), task = f.store.createTask(f.carl.id, "Routine", true)!;
  f.store.appendMessage(task.threadId, { role: "user", kind: "text", text: "run", routineRunPrompt: { trigger: "manual", routineName: "fixture" } });
  const spy = vi.spyOn(f.store, "messagesFor"); expect(homeThread(f.carl)).toBe(task); expect(spy).not.toHaveBeenCalled();
});
it("R1.12 eager markers tolerate an open journal without minting", () => {
  const f = fixture(), group = f.store.createGroup("Design", [f.iris.id], false, "Design");
  database().prepare("UPDATE team_identities SET op='rename',op_phase=1,op_label='Revenue',op_records=? WHERE team_id=?").run(JSON.stringify({ bots: [], groups: [] }), f.sales);
  group.section = "New"; expect(() => markPartitions(f.store)).not.toThrow(); expect(group.partitionedFor?.[f.iris.id]).toEqual({ kind: "room" });
});
it("R1.13 clause 4 positive, restored home marker negative, team audience key", () => {
  const f = fixture(); expect(f.peer(f.carl)).toMatchObject({ ok: true, clause: 4 });
  const room = f.store.createGroup("Design", [f.iris.id, f.carl.id], false, "Design"); room.partitionedFor = { [f.iris.id]: { kind: "team", teamId: teamIdFor("Design") } };
  expect(f.peer(f.iris, f.zed, room.threadId)).toMatchObject({ ok: false, code: "not_reachable" });
  expect(learningDestination({ botId: f.iris.id, evidenceScopeIds: [ensureScope("bot", `${f.iris.id}#team:${f.sales}`)], target: "memory" })).toMatchObject({ ok: true, audienceKey: `bot:${f.iris.id}:team:${f.sales}:owner` });
});
