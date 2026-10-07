// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane X final review (review-final-findings.md at dd93eeb6): C5, C6, L2, L3,
// L4 and the Chief roster's real "busy (shared work)" branch, each through the
// code the server runs.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import { teamIdFor } from "./team-identities.ts";
import { sourceExecutionAudience, threadPartition } from "./execution-audience.ts";
import { enqueueSharedWork } from "./shared-work.ts";
import { getOrCreateChannel, type CommsBus } from "./comms-visibility.ts";
import { drainDelegations, queueDelegation, _resetPending } from "./delegations.ts";
import { partitionSessionAudience } from "./session-audience.ts";
import { sharingRoute } from "./sharing-routes.ts";
import { standingContextParts } from "./standing-context.ts";
import { writeSectionContext } from "./section-context.ts";
import { insertRoomRequest } from "./room-requests.ts";
import { channelToProjectRows } from "./project-settings.ts";
import { projectBotNowAnywhere, projectMemberNow, withProjectNow } from "./project-roster.ts";
import { chiefOfStaffSystemPrompt } from "./chief-of-staff.ts";
import { partitionToolRefusal } from "./shared-bots-roster.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); });
afterEach(() => _resetPending());

function fixture() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const make = (name: string, section: string) => { const b = store.createBot(); store.patchBot(b.id, { name, section, approvePeerComms: false }); return store.bot(b.id)!; };
  const iris = make("Iris", "Design"), sam = make("Sam", "Sales"), bob = make("Bob", "Sales"), carl = make("Carl", "Design"), zed = make("Zed", "Support");
  const sales = teamIdFor("Sales"), support = teamIdFor("Support");
  store.patchBot(sam.id, { chiefOfStaff: true });
  store.patchBot(iris.id, { sharedWith: { mode: "list", teams: [{ id: sales, name: "Sales" }] } });
  return { store, iris: store.bot(iris.id)!, sam: store.bot(sam.id)!, bob, carl, zed, sales, support };
}
const openJournal = (teamId: string) => database().prepare("UPDATE team_identities SET op='rename',op_phase=1,op_label='Elsewhere',op_records=? WHERE team_id=?").run(JSON.stringify({ bots: [], groups: [] }), teamId);

// C5: while any team journal is open, starting shared work answers a plain
// line; nothing throws the raw identity error out of the ask path.
it("C5: opening a work thread while a team change is finishing is a plain refusal, not a throw", () => {
  const f = fixture();
  openJournal(f.support);
  expect(() => f.store.openSharedWork(f.iris.id, f.sales)).not.toThrow();
  expect(f.store.openSharedWork(f.iris.id, f.sales)).toEqual({ refused: "Iris can take work for Sales once the team change finishes. Try again in a moment." });
  expect(f.store.createSharedWorkTask(f.iris.id, f.sales)).toBeNull();
  let result: ReturnType<typeof enqueueSharedWork> | undefined;
  expect(() => { result = enqueueSharedWork(f.store, { fromBotId: f.sam.id, sourceThreadId: f.sam.threadId, toBotId: f.iris.id, message: "quote please", admissionKey: "c5", ownerAudience: true, now: 1 }); }).not.toThrow();
  expect(result).toMatchObject({ ok: false, retry: "queue", line: "Iris can take work for Sales once the team change finishes. Try again in a moment." });
  expect(f.store.bot(f.iris.id)!.tasks?.some(t => t.sharedWork)).toBe(false);
  // the journal closes: the same ask opens the work thread
  database().prepare("UPDATE team_identities SET op=NULL,op_phase=NULL,op_label=NULL,op_records=NULL").run();
  expect(enqueueSharedWork(f.store, { fromBotId: f.sam.id, sourceThreadId: f.sam.threadId, toBotId: f.iris.id, message: "quote please", admissionKey: "c5b", ownerAudience: true, now: 2 })).toMatchObject({ ok: true });
});

// C6: GET /sharing mints the bot's home team id; an unpartitioned bot's home
// session key is its label, so the mint never costs it its engine session.
it("C6: GET /sharing does not change an unpartitioned sectioned bot's session audience", async () => {
  const f = fixture();
  expect(database().prepare("SELECT 1 FROM team_identities WHERE label='Design'").get()).toBeUndefined();
  const before = partitionSessionAudience("owner", f.carl, f.carl.threadId);
  const reply = await sharingRoute({ method: "GET", path: `/api/bots/${f.carl.id}/sharing`, desktop: true, visible: () => true, readBody: async () => ({}), deps: { store: f.store } });
  expect(reply?.status).toBe(200);
  expect(database().prepare("SELECT 1 FROM team_identities WHERE label='Design'").get()).toBeDefined();
  expect(partitionSessionAudience("owner", f.carl, f.carl.threadId)).toBe(before);
});

// L2: a partitioned asker in a room(G) turn files its pair room under room(G),
// never the home pair room, on both the sync ask and the delegation path.
function roomAsk() {
  const f = fixture();
  const room = f.store.createGroup("Mixed", [f.iris.id, f.bob.id, f.carl.id], false, "Design");
  expect(threadPartition(f.iris, room.threadId)).toEqual({ kind: "room", groupId: room.id });
  // an earlier home exchange made the home pair room
  const homePair = getOrCreateChannel(f.store, f.iris, f.carl, f.iris.threadId, null);
  expect(threadPartition(f.iris, homePair.threadId)).toEqual({ kind: "home" });
  return { ...f, room, homePair };
}
it("L2: a sync ask from a room(G) turn mirrors into a room(G) pair room, not the home pair room", () => {
  const f = roomAsk();
  // what index.ts's ask-bot route passes: the source turn's own tag (NULL in a room)
  const channel = getOrCreateChannel(f.store, f.iris, f.carl, f.room.threadId, sourceExecutionAudience(f.iris.id, f.room.threadId));
  expect(channel.id).not.toBe(f.homePair.id);
  expect(channel.dmAudience).toEqual({ kind: "room", groupId: f.room.id });
  expect(threadPartition(f.iris, channel.threadId)).toEqual({ kind: "room", groupId: f.room.id });
  // the same ask again reuses it
  expect(getOrCreateChannel(f.store, f.iris, f.carl, f.room.threadId, null).id).toBe(channel.id);
});
it("L2: a delegation from a room(G) turn mirrors into a room(G) pair room, not the home pair room", async () => {
  const f = roomAsk();
  const bus: CommsBus = { store: f.store, broadcast: () => {} };
  const approvals = { store: f.store, broadcast: () => {} };
  expect(queueDelegation(bus, f.iris, { toBotId: f.carl.id, message: "please review", depth: 0 }, 4, f.room.threadId)).toMatchObject({ result: "ok" });
  const channels: Array<string | undefined> = [];
  drainDelegations(bus, approvals, f.room.threadId, (_to, _message, _depth, _source, channel) => { channels.push(channel?.id); });
  for (let tries = 0; !channels.length && tries < 80; tries++) await new Promise(resolve => setTimeout(resolve, 25));
  expect(channels).toHaveLength(1);
  const channel = f.store.group(channels[0]!)!;
  expect(channel.id).not.toBe(f.homePair.id);
  expect(channel.dmAudience).toEqual({ kind: "room", groupId: f.room.id });
  expect(threadPartition(f.iris, channel.threadId)).toEqual({ kind: "room", groupId: f.room.id });
  expect(f.store.messagesFor(f.homePair.threadId).some(m => m.text === "please review")).toBe(false);
});

// L3: a team partition whose id is unknown or retired has no brief; it never
// falls back to the General brief.
it("L3: an unknown or retired team id gets no General brief", () => {
  const f = fixture();
  writeSectionContext("", "CANARY_GENERAL_BRIEF");
  writeSectionContext("Sales", "CANARY_SALES_BRIEF");
  const brief = (teamId: string) => standingContextParts(f.iris, { ownerAudience: true, fileTools: false, partition: { kind: "team", teamId } }).teamBrief;
  expect(brief(f.sales)).toContain("CANARY_SALES_BRIEF");
  expect(brief("00000000-0000-4000-8000-000000000000")).toBe("");
  database().prepare("UPDATE team_identities SET retired_at=1 WHERE team_id=?").run(f.sales);
  expect(brief(f.sales)).toBe("");
});

// L4: an archived bot keeps its existing work threads readable, and gets no new one.
it("L4: POST work-threads opens an existing thread for an archived bot but creates none", async () => {
  const f = fixture();
  const post = (botId: string, body: unknown) => sharingRoute({ method: "POST", path: `/api/bots/${botId}/work-threads`, desktop: true, visible: () => true, readBody: async () => body, deps: { store: f.store } });
  const opened = await post(f.iris.id, { teamId: f.sales });
  expect(opened?.status).toBe(200);
  f.store.patchBot(f.iris.id, { sharedWith: { mode: "list", teams: [{ id: f.sales, name: "Sales" }, { id: f.support, name: "Support" }] } });
  f.store.patchBot(f.iris.id, { hidden: true });
  expect(await post(f.iris.id, { teamId: f.sales })).toEqual(opened);
  const refused = await post(f.iris.id, { teamId: f.support });
  expect(refused).toEqual({ status: 409, body: { error: "Iris is archived. Bring Iris back before opening new work." } });
  expect(f.store.bot(f.iris.id)!.tasks?.filter(t => t.sharedWork)).toHaveLength(1);
});

// The Chief roster line for a partitioned bot's non-home work names no team,
// project or card: the real projectBotNowAnywhere / projectMemberNow branch.
it("roster: a partitioned bot busy in a mixed-team project or a Sales work thread reads only busy (shared work)", () => {
  const f = fixture();
  const db = database();
  const project = f.store.createGroup("Launch Orion", [f.iris.id, f.sam.id], false, "Sales");
  channelToProjectRows(db, { groupId: project.id, bulletin: "", leadBotId: f.sam.id, now: 1 });
  f.store.patchGroup(project.id, { channelProject: { goal: "fixture", status: "active", startedAt: 1, updatedAt: 1 } });
  const desk = f.store.ensureProjectDesk(f.iris.id, project.id, "Launch Orion")!;
  expect(threadPartition(f.iris, desk.threadId)).toMatchObject({ kind: "project", homeMember: false });
  db.prepare(`INSERT INTO project_work_items(id, group_id, number, title, assignee_bot_id, state, position, created_by, created_at, updated_at) VALUES('c7',?,7,'Secret pricing sheet',?,'doing',1,'lead',1,1)`).run(project.id, f.iris.id);
  const card = insertRoomRequest(db, { groupId: project.id, toBotId: f.iris.id, verb: "assign", fromKind: "owner", admissionKey: "card", now: 1, workItemId: "c7", targetThreadId: desk.threadId, state: "running", lineage: { rootThreadId: project.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false } }).request;
  db.prepare("UPDATE room_requests SET dispatched_at=1 WHERE id=?").run(card.id);
  const names = (groupId: string) => f.store.group(groupId)?.name;
  // Carl leads Design: Iris is on his roster with her "now" (what index.ts builds)
  f.store.patchBot(f.carl.id, { chiefOfStaff: true });
  const chiefLine = () => {
    const roster = withProjectNow(f.store.bots, true, botId => projectBotNowAnywhere(db, botId, names, 60_001));
    return chiefOfStaffSystemPrompt(f.carl.id, roster, true).split("\n").find(line => line.includes("Iris")) ?? "";
  };
  for (const line of [projectBotNowAnywhere(db, f.iris.id, names, 60_001), projectMemberNow(db, project.id, f.iris.id, 60_001)]) expect(line).toBe("busy (shared work)");
  expect(chiefLine()).toContain("busy (shared work)");
  for (const leak of ["Launch", "Orion", "Secret", "pricing", "card 7", "Sales"]) expect(chiefLine()).not.toContain(leak);
  // the same for a Sales work thread
  db.prepare("UPDATE room_requests SET state='done' WHERE id=?").run(card.id);
  const work = f.store.createSharedWorkTask(f.iris.id, f.sales)!;
  insertRoomRequest(db, { groupId: "pair", toBotId: f.iris.id, verb: "ask", fromKind: "bot", fromBotId: f.sam.id, admissionKey: "shared", now: 2, targetThreadId: work.threadId, state: "running", lineage: { rootThreadId: f.sam.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false, executionAudience: { v: 1, kind: "team", human: "owner", team: f.sales, rootRequestId: "shared" } } });
  expect(projectBotNowAnywhere(db, f.iris.id, names, 60_001)).toBe("busy (shared work)");
  for (const leak of ["Sales", "Launch", "Secret"]) expect(chiefLine()).not.toContain(leak);
});

// L1 siblings: every internal route that manages a bot is refused from a
// shared bot's non-home thread, and still open at home (create-bot runs
// through the real route in shared-bots-socket.test.ts).
it("L1: bot management routes are refused from a work thread and open at home", () => {
  const f = fixture();
  const work = f.store.createSharedWorkTask(f.iris.id, f.sales)!;
  for (const path of ["/api/internal/create-bot", "/api/internal/bot-management", "/api/internal/access-request"]) {
    expect(partitionToolRefusal(f.iris, work.threadId, path)).toBe("Manage bots from Iris's own team.");
    expect(partitionToolRefusal(f.iris, f.iris.threadId, path)).toBeNull();
    expect(partitionToolRefusal(f.carl, f.carl.threadId, path)).toBeNull();
  }
  expect(partitionToolRefusal(f.iris, work.threadId, "/api/internal/ask-bot")).toBeNull();
});
