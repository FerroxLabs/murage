// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SPEC-P 11.3: internal project tools are authorised at the call from
// current state; each role refuses the other.
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeProjectTool, PROJECT_TOOL_ROLES, projectMemberRef, projectToolHandlers, projectToolRoleForTurn, handleProjectToolWithInterrupt } from "./project-tool-routing.ts";
import { applyGoalEnvelopeV2, projectRequestOwnerControl, projectRequestSourceMessages } from "./project-envelope.ts";
import { initializeProjectTables, markProjectDerivedStale } from "./project-tables.ts";
import { insertRoomRequest, markRequestDispatched, roomRequest, type RoomRequest } from "./room-requests.ts";

let db: DatabaseSync;
const lineage = { rootThreadId: "t", origin: "desktop" as const, audienceFingerprint: "owner", notOwnerAudience: false, unattended: false };
let turn: RoomRequest, cardRun: RoomRequest, review: RoomRequest;
const members = ["lead", "jax", "rev"];

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  initializeProjectTables(db);
  db.prepare("INSERT INTO project_settings (group_id, lead_bot_id, updated_at) VALUES ('g','lead',1)").run();
  const root = insertRoomRequest(db, { groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: "r", lineage, now: 1 }).request;
  turn = insertRoomRequest(db, { groupId: "g", verb: "room_turn", fromKind: "owner", toBotId: "lead", parentId: root.id, admissionKey: "t", state: "running", now: 2 }).request;
  cardRun = insertRoomRequest(db, { groupId: "g", verb: "assign", fromKind: "bot", toBotId: "jax", parentId: root.id, admissionKey: "a", workItemId: "c1", cardGeneration: 1, state: "running", now: 3 }).request;
  review = insertRoomRequest(db, { groupId: "g", verb: "review", fromKind: "bot", toBotId: "rev", parentId: root.id, admissionKey: "v", workItemId: "c1", cardGeneration: 1, state: "running", now: 4 }).request;
  db.prepare(`INSERT INTO project_work_items (id, group_id, number, title, state, position, assignee_bot_id, generation, review_request_id, created_by, created_at, updated_at)
    VALUES ('c1','g',12,'Pricing','review',1,'jax',1,?, 'lead',1,1)`).run(review.id);
});

const call = (name: string, botId: string, request: RoomRequest | null, body: Record<string, unknown> = {}, ownerAudience = true) =>
  authorizeProjectTool(db, { name, botId, request, body, memberIds: members, ownerAudience });

describe("project tool authorisation (SPEC-P 11.3)", () => {
  it("every tool names a role", () => {
    expect(Object.keys(PROJECT_TOOL_ROLES).sort()).toEqual(["accept", "assign", "blocked", "brief-update", "bring-in", "card-manage", "card-update", "criteria", "done", "read-messages", "review-assign", "review-result", "suggest", "summary-update"]);
  });
  it("the lead's tools answer only the lead, read from the rows at the call", () => {
    expect(call("assign", "lead", turn)).toMatchObject({ ok: true, role: "lead" });
    expect(call("assign", "jax", cardRun)).toMatchObject({ status: 403 });
    db.prepare("UPDATE project_settings SET lead_bot_id='jax'").run();
    expect(call("assign", "lead", turn)).toMatchObject({ status: 403, body: { error: "Only the project lead can do that." } });
  });
  it("an assignee acts on its own card only while its generation is current", () => {
    expect(call("card-update", "jax", cardRun, { cardId: "c1", milestone: "half way" })).toMatchObject({ ok: true, role: "assignee" });
    db.prepare("UPDATE project_work_items SET generation=2").run();
    expect(call("card-update", "jax", cardRun, { cardId: "c1", milestone: "x" })).toMatchObject({ status: 403, body: { error: "You are no longer on card 12." } });
  });
  it("only the current reviewer gives a verdict", () => {
    expect(call("review-result", "rev", review, { cardId: "c1", verdict: "pass" })).toMatchObject({ ok: true, role: "reviewer" });
    expect(call("review-result", "jax", cardRun, { cardId: "c1", verdict: "pass" })).toMatchObject({ status: 403 });
  });
  it("never on a turn that is not the owner's audience, or ended, or outside an open project", () => {
    expect(call("read-messages", "jax", cardRun, {}, false)).toMatchObject({ status: 403, body: { error: "Project tools are not available in this conversation." } });
    expect(call("read-messages", "jax", null)).toMatchObject({ status: 403 });
    db.prepare("UPDATE room_requests SET state='done' WHERE id=?").run(cardRun.id);
    expect(call("read-messages", "jax", roomRequest(db, cardRun.id))).toMatchObject({ status: 403, body: { error: "This turn has ended." } });
    expect(call("read-messages", "stranger", turn)).toMatchObject({ status: 403 });
    db.prepare("UPDATE project_settings SET ended_at=5").run();
    expect(call("assign", "lead", turn)).toMatchObject({ status: 403 });
  });
  it("a paused project still answers read-messages and a blocker, and nothing else", () => {
    db.prepare("UPDATE project_settings SET run_state='paused'").run();
    expect(call("assign", "lead", turn)).toMatchObject({ status: 409, body: { reason: "The project is paused." } });
    expect(call("read-messages", "lead", turn)).toMatchObject({ ok: true });
    expect(call("card-update", "jax", cardRun, { cardId: "c1", blocked: "waiting on the API key" })).toMatchObject({ ok: true });
    expect(call("card-update", "jax", cardRun, { cardId: "c1", milestone: "x" })).toMatchObject({ status: 409 });
  });
  it("every tool from a superseded card run is refused, not only the assignee's", () => {
    db.prepare("UPDATE project_work_items SET generation=5").run();
    expect(call("read-messages", "jax", cardRun)).toMatchObject({ status: 403, body: { error: "You are no longer on card 12." } });
  });
  it("an unknown tool is not found", () => {
    markRequestDispatched(db, turn.id, { now: 9 });
    expect(call("drop-table", "lead", turn)).toMatchObject({ status: 404 });
  });
});

it("the reviewer can give a verdict after its own card continuation, never another generation", () => {
  const wake = insertRoomRequest(db, { groupId: "g", verb: "wake", fromKind: "murage", parentId: review.id,
    toBotId: "rev", workItemId: "c1", cardGeneration: 1, state: "running", admissionKey: "review-wake", now: 5 }).request;
  expect(call("review-result", "rev", wake, { cardId: "c1", verdict: "pass" })).toMatchObject({ ok: true });
  db.prepare("UPDATE project_work_items SET generation=2").run();
  expect(call("review-result", "rev", wake, { cardId: "c1", verdict: "pass" })).toMatchObject({ status: 403 });
});

it("refuses every lead tool to members and every project tool to contact lineage", () => {
  for (const [name, role] of Object.entries(PROJECT_TOOL_ROLES)) {
    if (role === "lead") expect(call(name, "jax", cardRun)).toMatchObject({ status: 403 });
    expect(call(name, "lead", turn, {}, false)).toMatchObject({ status: 403 });
    expect(call(name, "lead", { ...turn, notOwnerAudience: true })).toMatchObject({ status: 403 });
  }
});
it("routes assign atomically with server-bound source messages and idempotency", () => {
  db.exec("INSERT INTO project_goals(id,group_id,title,state,review,created_at,started_at) VALUES('goal','g','Finish','working',0,1,1)");
  db.prepare("UPDATE room_requests SET source_message_id='owner-message' WHERE id=?").run(turn.id);
  const request = roomRequest(db, turn.id)!;
  const handler = projectToolHandlers.get("assign");
  expect(handler).toBeTypeOf("function");
  const context = { db, groupId: "g", botId: "lead", role: "lead" as const, request, memberIds: members, ownerAudience: true, now: 10 };
  const body = { cards: [{ key: "payments", assignee: "jax", title: "Assigned payments", writes: false }] };
  expect(handler!(context, body).status).toBe(200);
  expect(handler!(context, body).status).toBe(200);
  expect(db.prepare("SELECT source_message_ids FROM project_work_items WHERE title='Assigned payments'").all()).toEqual([{ source_message_ids: '["owner-message"]' }]);
  expect(db.prepare("SELECT count(*) n FROM room_requests WHERE admission_key=?").get(`assign:${turn.id}:payments`)).toMatchObject({ n: 1 });
});
it("routes a review to another member with the current generation and review key", () => {
  const handler = projectToolHandlers.get("review-assign");
  expect(handler).toBeTypeOf("function");
  const result = handler!({ db, groupId: "g", botId: "lead", role: "lead", request: turn, memberIds: members, ownerAudience: true, now: 10 }, { cardId: "c1", reviewer: "rev" });
  expect(result.status).toBe(200);
  expect(db.prepare("SELECT card_generation, admission_key FROM room_requests WHERE verb='review' AND admission_key LIKE 'review:%'").get()).toMatchObject({ card_generation: 1, admission_key: "review:c1:1" });
  db.prepare("UPDATE room_requests SET state='done' WHERE admission_key='review:c1:1'").run();
  expect(handler!({ db, groupId: "g", botId: "lead", role: "lead", request: turn, memberIds: members, ownerAudience: true, now: 11 }, { cardId: "c1", reviewer: "rev" }).status).toBe(200);
  expect(db.prepare("SELECT admission_key FROM room_requests WHERE admission_key='review:c1:1:1'").get()).toBeTruthy();
});

it("uses the current lead and owner audience for desk tool roles", () => {
  const group = { id: "g", channelProject: {}, memberIds: members };
  expect(projectToolRoleForTurn(db, group, "lead", true)).toBe("lead");
  expect(projectToolRoleForTurn(db, group, "jax", true)).toBe("member");
  expect(projectToolRoleForTurn(db, group, "lead", false)).toBeUndefined();
  expect(projectToolRoleForTurn(db, group, "stranger", true)).toBeUndefined();
  db.exec("UPDATE project_settings SET lead_bot_id='jax'");
  expect(projectToolRoleForTurn(db, group, "lead", true)).toBe("member");
  expect(projectToolRoleForTurn(db, group, "jax", true)).toBe("lead");
  db.exec("UPDATE project_settings SET ended_at=10");
  expect(projectToolRoleForTurn(db, group, "jax", true)).toBeUndefined();
});

it.each(["cancel", "reassign", "send_back"])("lead %s interrupts the running desk exactly once", async action => {
  db.exec("UPDATE project_settings SET mode='ongoing'");
  db.prepare("UPDATE project_work_items SET state=?,request_id=?,desk_thread_id='desk-jax' WHERE id='c1'").run(action === "send_back" ? "review" : "doing", cardRun.id);
  db.prepare("UPDATE room_requests SET state=?,target_thread_id='desk-rev' WHERE id=?").run(action === "send_back" ? "running" : "done", review.id);
  if (action === "send_back") db.prepare("UPDATE room_requests SET state='done' WHERE id=?").run(cardRun.id);
  db.prepare("UPDATE room_requests SET target_thread_id='desk-jax' WHERE id=?").run(cardRun.id);
  const interrupt = vi.fn(async () => {});
  const result = await handleProjectToolWithInterrupt("card-manage", {
    db, groupId: "g", botId: "lead", role: "lead", request: turn, memberIds: members, ownerAudience: true, now: 100,
  }, { cardId: "c1", action, ...(action === "reassign" ? { assigneeBotId: "rev" } : {}) }, interrupt);
  expect(result.status).toBe(200);
  expect(interrupt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(action === "send_back"
    ? { assigneeBotId: "rev", deskThreadId: "desk-rev" } : { assigneeBotId: "jax", deskThreadId: "desk-jax" }));
});
it("a refused lead card action does not interrupt an engine", async () => {
  const interrupt = vi.fn(async () => {});
  const result = await handleProjectToolWithInterrupt("card-manage", {
    db, groupId: "g", botId: "jax", role: "member", request: cardRun, memberIds: members, ownerAudience: true, now: 100,
  }, { cardId: "c1", action: "cancel" }, interrupt);
  expect(result.status).toBe(403);
  expect(interrupt).not.toHaveBeenCalled();
});

it("a replayed lead reassign does not interrupt the replacement run", async () => {
  db.exec("UPDATE project_settings SET mode='ongoing'");
  db.prepare("UPDATE project_work_items SET state='doing',request_id=?,desk_thread_id='desk-jax' WHERE id='c1'").run(cardRun.id);
  db.prepare("UPDATE room_requests SET target_thread_id='desk-jax' WHERE id=?").run(cardRun.id);
  db.prepare("UPDATE room_requests SET state='done' WHERE id=?").run(review.id);
  const interrupt = vi.fn(async () => {});
  const context = { db, groupId: "g", botId: "lead", role: "lead" as const, request: turn, memberIds: members, ownerAudience: true, now: 100 };
  const body = { cardId: "c1", action: "reassign", assigneeBotId: "rev" };
  expect((await handleProjectToolWithInterrupt("card-manage", context, body, interrupt)).status).toBe(200);
  // The replacement dispatch happens before the lead replays its same operation.
  db.exec("UPDATE project_work_items SET state='doing',desk_thread_id='desk-rev',request_id=(SELECT id FROM room_requests WHERE work_item_id='c1' AND state='queued') WHERE id='c1'");
  db.exec("UPDATE room_requests SET state='running',target_thread_id='desk-rev' WHERE work_item_id='c1' AND state='queued'");
  expect((await handleProjectToolWithInterrupt("card-manage", context, body, interrupt)).status).toBe(200);
  expect(interrupt).toHaveBeenCalledTimes(1);
});

// The AFTER-PF run: the lead guessed project_assign's input twice
// ({ assignee, task, due, priority } and { assignee, title, description, due })
// and never learned what it takes. Names are the display names of members.
describe("project tool input the model guesses", () => {
  const names = new Map([["lead", "Nova"], ["jax", "Jax"], ["rev", "Reed"]]);
  const lead = (now = 10) => ({ db, groupId: "g", botId: "lead", role: "lead" as const, request: roomRequest(db, turn.id)!, memberIds: members, memberNames: names, ownerAudience: true, now });
  const working = () => {
    db.exec("INSERT INTO project_goals(id,group_id,title,state,review,created_at,started_at) VALUES('goal','g','Finish','working',0,1,1)");
    db.prepare("UPDATE room_requests SET source_message_id='owner-message' WHERE id=?").run(turn.id);
  };
  const usage = "project_assign takes cards: [{ key, assignee (a bot id from list_bots or a member's name), title, description }].";

  it("names the expected input and every unknown field in one line", () => {
    working();
    const assign = projectToolHandlers.get("assign")!;
    expect(assign(lead(), { assignee: "Reed", task: "Research segments", due: "2026-09-30", priority: "high" }))
      .toEqual({ status: 400, body: { error: `${usage} Unknown fields: task, due, priority.` } });
    expect(assign(lead(), { assignee: "Reed", title: "Segments", description: "Three", due: "2026-09-30" }))
      .toEqual({ status: 400, body: { error: `${usage} Unknown fields: due.` } });
    expect(assign(lead(), { cards: [{ key: "a", assignee: "jax", title: "One", due: "soon" }], note: "x" }))
      .toEqual({ status: 400, body: { error: `${usage} Unknown fields: note, due.` } });
    expect(assign(lead(), { cards: "one card" })).toEqual({ status: 400, body: { error: usage } });
    expect(assign(lead(), { assignee: "Reed" })).toEqual({ status: 400, body: { error: `${usage} Missing: title.` } });
    expect(db.prepare("SELECT count(*) n FROM project_work_items WHERE goal_id='goal'").get()).toEqual({ n: 0 });
  });

  it("takes one card without the cards list, with a member's name for the assignee, once per card", () => {
    working();
    const assign = projectToolHandlers.get("assign")!;
    const one = { assignee: "reed", title: "Three segments", description: "Name three segments" };
    const first = assign(lead(), one);
    expect(first.status).toBe(200);
    expect(assign(lead(11), one)).toEqual(first);
    expect(assign(lead(12), { assignee: "JAX", title: "Pricing" }).status).toBe(200);
    expect(assign(lead(13), { cards: [{ key: "copy", assignee: "Nova", title: "Launch copy" }] }).status).toBe(200);
    expect(db.prepare("SELECT title, assignee_bot_id FROM project_work_items WHERE goal_id='goal' ORDER BY title").all())
      .toEqual([{ title: "Launch copy", assignee_bot_id: "lead" }, { title: "Pricing", assignee_bot_id: "jax" }, { title: "Three segments", assignee_bot_id: "rev" }]);
  });

  it("never resolves a name outside the members or one two members share", () => {
    working();
    const assign = projectToolHandlers.get("assign")!;
    const twins = { ...lead(), memberNames: new Map([["lead", "Nova"], ["jax", "Sam"], ["rev", "sam"]]) };
    // the refusal never echoes the model's ref (S7)
    const shared = { status: 400, body: { error: "That name belongs to more than one member. Use their bot id." } };
    expect(assign(twins, { assignee: "Sam", title: "Pricing" })).toEqual(shared);
    expect(projectToolHandlers.get("review-assign")!(twins, { cardId: "c1", reviewer: "sam" })).toEqual(shared);
    expect(assign(lead(), { assignee: "Cole", title: "Pricing" })).toMatchObject({ status: 409, body: { refused: [{ reason: "Cole is not a member of this project" }] } });
    expect(db.prepare("SELECT count(*) n FROM project_work_items WHERE goal_id='goal'").get()).toEqual({ n: 0 });
  });

  // Round 8: the shorthand key hashed only assignee and title, so a second
  // card with the same assignee and title replayed the first.
  it("keys a single card by the whole card: a retry stays one card, a different card with the same title is another", () => {
    working();
    const assign = projectToolHandlers.get("assign")!;
    const one = { assignee: "Reed", title: "Segments", description: "Name three segments" };
    const first = assign(lead(), one);
    expect(first.status).toBe(200);
    expect(assign(lead(11), { description: "Name three segments", title: "Segments", assignee: "rev" })).toEqual(first);
    // while that card is open, the same title for the same member is a repeat (round 11 D1)
    const repeat = assign(lead(12), { ...one, description: "Name five segments" });
    expect(repeat.status).toBe(409);
    expect(JSON.stringify(repeat.body)).toContain("already has card");
    db.prepare("UPDATE project_work_items SET state='done' WHERE goal_id='goal'").run();
    const other = assign(lead(12), { ...one, description: "Name five segments" });
    expect(other.status).toBe(200);
    expect(other).not.toEqual(first);
    expect(db.prepare("SELECT title, description FROM project_work_items WHERE goal_id='goal' ORDER BY description").all())
      .toEqual([{ title: "Segments", description: "Name five segments" }, { title: "Segments", description: "Name three segments" }]);
  });

  it("never takes a blank name, nor a name for a member whose bot is gone", async () => {
    const gone = { ...lead(), memberNames: new Map([["lead", "Nova"], ["jax", "Jax"], ["rev", ""]]) };
    expect(projectMemberRef(gone, "")).toBe("");
    expect(projectMemberRef(gone, "  ")).toBe("  ");
    expect(projectToolHandlers.get("review-assign")!(gone, { cardId: "c1", reviewer: "" }).status).toBe(409);
    expect(projectToolHandlers.get("review-assign")!(gone, { cardId: "c1", reviewer: " " }).status).toBe(409);
    expect(db.prepare("SELECT count(*) n FROM room_requests WHERE admission_key LIKE 'review:c1:%'").get()).toEqual({ n: 0 });
  });

  // Round 9 (C8): a caller who may not use the tool hears that first, not
  // that the name it sent is shared.
  it("authorises card-manage and suggest before refusing a shared name", async () => {
    const twins = new Map([["lead", "Nova"], ["jax", "Sam"], ["rev", "sam"]]);
    const interrupt = vi.fn(async () => {});
    const member = { ...lead(), botId: "jax", role: "member" as const, request: roomRequest(db, cardRun.id)!, memberNames: twins };
    expect(await handleProjectToolWithInterrupt("card-manage", member, { cardId: "c1", action: "reassign", assigneeBotId: "Sam" }, interrupt)).toMatchObject({ status: 403 });
    // suggest is any member's: here the turn is not the owner's audience
    expect(await handleProjectToolWithInterrupt("suggest", { ...lead(), memberNames: twins, ownerAudience: false }, { botId: "Sam", text: "x" }, interrupt)).toMatchObject({ status: 403 });
    expect(await handleProjectToolWithInterrupt("card-manage", { ...lead(), memberNames: twins }, { cardId: "c1", action: "reassign", assigneeBotId: "Sam" }, interrupt))
      .toEqual({ status: 400, body: { error: "That name belongs to more than one member. Use their bot id." } });
    expect(interrupt).not.toHaveBeenCalled();
  });

  // Round 9 (S5): a member named like another bot's id never takes work
  // sent to that id; an exact member id always wins.
  it("never reads a known bot id as a member's name", () => {
    working();
    const botIds = new Set(["lead", "jax", "rev", "cole"]);
    const named = { ...lead(), memberNames: new Map([["lead", "Nova"], ["jax", "jax"], ["rev", "cole"]]), botIds };
    expect(projectMemberRef(named, "cole")).toBe("cole");
    expect(projectMemberRef(named, "jax")).toBe("jax");
    expect(projectToolHandlers.get("assign")!(named, { assignee: "cole", title: "Pricing" })).toMatchObject({ status: 409, body: { refused: [{ reason: "cole is not a member of this project" }] } });
    expect(projectToolHandlers.get("review-assign")!(named, { cardId: "c1", reviewer: "cole" }).status).toBe(409);
    expect(db.prepare("SELECT count(*) n FROM room_requests WHERE to_bot_id='rev' AND admission_key LIKE 'review:c1:%'").get()).toEqual({ n: 0 });
  });

  // Round 10 (S3): a bot id with stray spaces or in another case is still
  // that id, never a member's name.
  it("never reads a trimmed or recased bot id as a member's name", () => {
    working();
    const botIds = new Set(["lead", "jax", "rev", "bot-x"]);
    const named = { ...lead(), memberNames: new Map([["lead", "Nova"], ["jax", "Jax"], ["rev", "bot-x"]]), botIds };
    expect(projectMemberRef(named, " bot-x")).toBe(" bot-x");
    expect(projectMemberRef(named, "BOT-X")).toBe("BOT-X");
    expect(projectMemberRef(named, " jax ")).toBe("jax");
    expect(projectMemberRef(named, "JAX")).toBe("jax");
    expect(projectToolHandlers.get("assign")!(named, { assignee: "BOT-X", title: "Pricing" })).toMatchObject({ status: 409 });
    expect(projectToolHandlers.get("review-assign")!(named, { cardId: "c1", reviewer: " bot-x" }).status).toBe(409);
    expect(db.prepare("SELECT count(*) n FROM room_requests WHERE to_bot_id='rev' AND (verb='assign' AND work_item_id<>'c1' OR admission_key LIKE 'review:c1:%')").get()).toEqual({ n: 0 });
  });

  it("takes a member's name for a reviewer", () => {
    const result = projectToolHandlers.get("review-assign")!(lead(), { cardId: "c1", reviewer: "Reed" });
    expect(result.status).toBe(200);
    expect(db.prepare("SELECT to_bot_id FROM room_requests WHERE admission_key LIKE 'review:c1:%'").all()).toEqual([{ to_bot_id: "rev" }]);
  });

  it("takes a member's name for a new assignee", async () => {
    db.exec("UPDATE project_settings SET mode='ongoing'");
    db.prepare("UPDATE project_work_items SET state='doing',request_id=?,desk_thread_id='desk-jax' WHERE id='c1'").run(cardRun.id);
    db.prepare("UPDATE room_requests SET target_thread_id='desk-jax' WHERE id=?").run(cardRun.id);
    db.prepare("UPDATE room_requests SET state='done' WHERE id=?").run(review.id);
    const interrupt = vi.fn(async () => {});
    expect((await handleProjectToolWithInterrupt("card-manage", lead(100), { cardId: "c1", action: "reassign", assigneeBotId: "Reed" }, interrupt)).status).toBe(200);
    expect(db.prepare("SELECT assignee_bot_id FROM project_work_items WHERE id='c1'").get()).toEqual({ assignee_bot_id: "rev" });
  });
});

// Round 8, the r7 real-engine run: the lead's first project_assign on the
// goal Start wake was refused ("Bind the card to its source messages
// first.") because the wake the owner's click queued carries no message, so
// no lead could ever plan a goal started from the goal controls.
describe("a lead's plan on a wake the owner's own control queued", () => {
  const cards = [{ key: "segments", assignee: "rev", title: "Segments", description: "Name three segments" }, { key: "pricing", assignee: "jax", title: "Pricing" }];
  const goalWake = (key: string, extra: Record<string, unknown> = {}) => {
    db.exec("INSERT INTO project_goals(id,group_id,title,state,review,created_at,started_at) VALUES('goal','g','Finish','planning',0,1,1)");
    return insertRoomRequest(db, { groupId: "g", verb: "wake", fromKind: "murage", toBotId: "lead", targetThreadId: "t", projectGoalId: "goal",
      payloadText: JSON.stringify({ goal: "start" }), admissionKey: key, lineage, priority: "coordinator", state: "running", now: 5, ...extra }).request;
  };
  const leadOn = (request: RoomRequest) => ({ db, groupId: "g", botId: "lead", role: "lead" as const, request, memberIds: members, ownerAudience: true, now: 10 });
  const made = () => db.prepare(`SELECT w.title, w.source_message_ids AS sources, r.state FROM project_work_items w JOIN room_requests r ON r.work_item_id=w.id
    WHERE w.goal_id='goal' AND w.created_by='lead' AND r.verb='assign' ORDER BY w.title`).all();

  it.each(["wake:goal-start:goal", "wake:goal-change:goal:1"])("project_assign on %s creates both cards and queues their runs", (key) => {
    const wake = goalWake(key);
    const result = projectToolHandlers.get("assign")!(leadOn(wake), { cards });
    expect(result).toMatchObject({ status: 200, body: { ok: true, status: "assign" } });
    expect(made()).toEqual([{ title: "Pricing", sources: "[]", state: "queued" }, { title: "Segments", sources: "[]", state: "queued" }]);
  });

  it("the <murage-goal> assign envelope on the Start wake does the same", () => {
    const wake = goalWake("wake:goal-start:goal");
    const outcome = applyGoalEnvelopeV2(db, { groupId: "g", goalId: "goal", leadBotId: "lead", leadRequestId: wake.id, memberIds: [...members],
      sourceMessageIds: projectRequestSourceMessages(db, wake.id), now: 10, roomThreadId: "t" }, { v: 2, status: "assign", cards });
    expect(outcome).toMatchObject({ ok: true, status: "assign" });
    expect(made()).toHaveLength(2);
  });

  // Round 9 (C2): the lead reads the owner card's result, so the plan binds
  // that card's sources and its result message; forgetting either makes it stale.
  const ownerCardWake = (sources: string, result: string | null) => {
    db.exec("INSERT INTO project_goals(id,group_id,title,state,review,created_at,started_at) VALUES('goal','g','Finish','working',1,1,1)");
    db.prepare(`INSERT INTO project_work_items (id, group_id, goal_id, number, title, state, position, assignee_bot_id, generation, source_message_ids, result_message_id, created_by, created_at, updated_at)
      VALUES ('c2','g','goal',13,'Owner card','review',2,'jax',1,?,?,'owner',1,1)`).run(sources, result);
    const run = insertRoomRequest(db, { groupId: "g", verb: "assign", fromKind: "owner", toBotId: "jax", workItemId: "c2", cardGeneration: 1, projectGoalId: "goal",
      admissionKey: "assign:card:c2:1:1", lineage, state: "running", now: 3 }).request;
    db.prepare("UPDATE room_requests SET state='done', result_message_id=? WHERE id=?").run(result, run.id);
    return insertRoomRequest(db, { groupId: "g", verb: "wake", fromKind: "murage", toBotId: "lead", targetThreadId: "t", parentId: run.id, projectGoalId: "goal",
      payloadText: "[]", admissionKey: `wake:review:${run.id}`, priority: "coordinator", state: "running", now: 5 }).request;
  };

  it("a lead plan on the review wake of an owner card binds that card's sources and its result", () => {
    const wake = ownerCardWake('["owner-card-message"]', "owner-card-result");
    expect(projectToolHandlers.get("assign")!(leadOn(wake), { cards: [cards[1]] }).status).toBe(200);
    expect(made()).toEqual([{ title: "Pricing", sources: '["owner-card-message","owner-card-result"]', state: "queued" }]);
    markProjectDerivedStale(db, ["owner-card-result"]);
    expect(db.prepare("SELECT stale FROM project_work_items WHERE goal_id='goal' AND created_by='lead'").get()).toEqual({ stale: 1 });
  });

  // Round 10 (R3): an owner card with sources or a result binds them; a
  // bare owner card from the board whose run wrote no answer has nothing to
  // bind, and the owner's own card is the authority, like a goal Start.
  it("an owner card with no sources still binds its result, and one with neither is the owner's own control", () => {
    const wake = ownerCardWake("[]", "owner-card-result");
    expect(projectRequestOwnerControl(db, wake.id)).toBe(false);
    expect(projectToolHandlers.get("assign")!(leadOn(wake), { cards: [cards[1]] }).status).toBe(200);
    expect(made()).toEqual([{ title: "Pricing", sources: '["owner-card-result"]', state: "queued" }]);
    db.exec("DELETE FROM project_work_items; DELETE FROM room_requests WHERE work_item_id IS NOT NULL OR admission_key LIKE 'wake:review:%'; DELETE FROM project_goals");
    const bare = ownerCardWake("[]", null);
    expect(projectRequestOwnerControl(db, bare.id)).toBe(true);
    expect(projectRequestOwnerControl(db, bare.id, () => false)).toBe(false);
    expect(projectToolHandlers.get("assign")!(leadOn(bare), { cards: [cards[1]] }).status).toBe(200);
    expect(made()).toEqual([{ title: "Pricing", sources: "[]", state: "queued" }]);
  });

  // Round 12 (M1): an owner card run while the room has a lead is returned
  // to that lead (project-card-executor.ts), and is still the owner's own
  // card; a card a routine or Murage made is not the owner's control.
  it("a bare owner card returned to the current lead is the owner's control; one returned elsewhere or made by the server is not", () => {
    const bare = ownerCardWake("[]", null);
    db.prepare("UPDATE room_requests SET return_bot_id='lead' WHERE work_item_id='c2'").run();
    expect(projectRequestOwnerControl(db, bare.id)).toBe(true);
    db.prepare("UPDATE room_requests SET return_bot_id='jax' WHERE work_item_id='c2'").run();
    expect(projectRequestOwnerControl(db, bare.id)).toBe(false);
    db.prepare("UPDATE room_requests SET return_bot_id='lead' WHERE work_item_id='c2'").run();
    db.prepare("UPDATE project_work_items SET created_by='server' WHERE id='c2'").run();
    expect(projectRequestOwnerControl(db, bare.id)).toBe(false);
    expect(projectToolHandlers.get("assign")!(leadOn(bare), { cards: [cards[1]] })).toMatchObject({ status: 409, body: { refused: [{ reason: "Bind the card to its source messages first." }] } });
  });

  it("a bare owner card from an unproven or unattended click is not the owner's control", () => {
    const bare = ownerCardWake("[]", null);
    db.prepare("UPDATE room_requests SET origin='unproven', unattended=1 WHERE work_item_id='c2'").run();
    expect(projectRequestOwnerControl(db, bare.id)).toBe(false);
    expect(projectToolHandlers.get("assign")!(leadOn(bare), { cards: [cards[1]] })).toMatchObject({ status: 409, body: { refused: [{ reason: "Bind the card to its source messages first." }] } });
  });

  it("a card with fifty sources still binds its result", () => {
    const wake = ownerCardWake(JSON.stringify(Array.from({ length: 50 }, (_, index) => `m-${index}`)), "owner-card-result");
    const bound = projectRequestSourceMessages(db, wake.id);
    expect(bound).toHaveLength(50);
    expect(bound).toContain("owner-card-result");
  });

  it("anything else without a source message is still refused", () => {
    db.exec("INSERT INTO project_goals(id,group_id,title,state,review,created_at,started_at) VALUES('goal','g','Finish','working',0,1,1)");
    // the owner's message with no message bound, a bot's wake, an unproven click
    const murage = insertRoomRequest(db, { groupId: "g", verb: "wake", fromKind: "murage", toBotId: "lead", targetThreadId: "t", projectGoalId: "goal",
      payloadText: "[]", admissionKey: "wake:other", lineage, state: "running", now: 5 }).request;
    const unproven = insertRoomRequest(db, { groupId: "g", verb: "wake", fromKind: "murage", toBotId: "lead", targetThreadId: "t", projectGoalId: "goal",
      payloadText: "{}", admissionKey: "wake:goal-start:goal", lineage: { ...lineage, origin: "unproven", unattended: true }, state: "running", now: 6 }).request;
    for (const request of [turn, murage, unproven]) {
      expect(projectToolHandlers.get("assign")!(leadOn(request), { cards })).toMatchObject({ status: 409, body: { refused: [{ reason: "Bind the card to its source messages first." }, { reason: "Bind the card to its source messages first." }] } });
    }
    expect(made()).toEqual([]);
  });

  // Round 9 (C7, S3, S4): what is not the owner's own control.
  it("a bot or routine root, a hop that is not the owner's audience, a cycle or a missing parent is not owner control", () => {
    const start = goalWake("wake:goal-start:goal");
    const wakeUnder = (parentId: string, key: string) => insertRoomRequest(db, { groupId: "g", verb: "wake", fromKind: "murage", toBotId: "lead", targetThreadId: "t", parentId,
      projectGoalId: "goal", payloadText: "[]", admissionKey: key, priority: "coordinator", state: "running", now: 6 }).request;
    const botRoot = insertRoomRequest(db, { groupId: "g", verb: "assign", fromKind: "bot", fromBotId: "jax", toBotId: "lead", admissionKey: "bot-root", lineage, now: 2 }).request;
    const routineRoot = insertRoomRequest(db, { groupId: "g", verb: "routine", fromKind: "routine", toBotId: "lead", admissionKey: "routine-root", lineage, now: 2 }).request;
    expect(projectRequestOwnerControl(db, wakeUnder(botRoot.id, "w-bot").id)).toBe(false);
    expect(projectRequestOwnerControl(db, wakeUnder(routineRoot.id, "w-routine").id)).toBe(false);
    // not the owner's audience part way up
    const ask = insertRoomRequest(db, { groupId: "g", verb: "ask", fromKind: "bot", fromBotId: "lead", toBotId: "jax", parentId: start.id, admissionKey: "ask-mid", now: 7 }).request;
    const back = wakeUnder(ask.id, "w-mid");
    expect(projectRequestOwnerControl(db, back.id)).toBe(true);
    db.prepare("UPDATE room_requests SET not_owner_audience=1 WHERE id=?").run(ask.id);
    expect(projectRequestOwnerControl(db, back.id)).toBe(false);
    // a parent cycle, and a parent that is gone
    const a = wakeUnder(start.id, "w-a"), b = wakeUnder(a.id, "w-b");
    db.prepare("UPDATE room_requests SET parent_id=? WHERE id=?").run(b.id, a.id);
    expect(projectRequestOwnerControl(db, b.id)).toBe(false);
    const orphan = wakeUnder(start.id, "w-orphan");
    db.prepare("UPDATE room_requests SET parent_id='gone' WHERE id=?").run(orphan.id);
    expect(projectRequestOwnerControl(db, orphan.id)).toBe(false);
  });

  it("a lineage through another member's ask or handover is not the owner's control; the lead's own hops are", () => {
    const start = goalWake("wake:goal-start:goal");
    // the lead handed a card over and the card's run asked the lead something
    const handover = insertRoomRequest(db, { groupId: "g", verb: "assign", fromKind: "bot", fromBotId: "lead", toBotId: "jax", parentId: start.id, admissionKey: "handover", now: 7 }).request;
    const askLead = insertRoomRequest(db, { groupId: "g", verb: "ask", fromKind: "bot", fromBotId: "jax", toBotId: "lead", targetThreadId: "t", parentId: handover.id, admissionKey: "jax-asks", state: "running", now: 8 }).request;
    expect(projectRequestOwnerControl(db, askLead.id)).toBe(false);
    expect(projectToolHandlers.get("assign")!(leadOn(askLead), { cards: [cards[1]] })).toMatchObject({ status: 409, body: { refused: [{ reason: "Bind the card to its source messages first." }] } });
    // the result of the lead's own handover coming back is
    const result = insertRoomRequest(db, { groupId: "g", verb: "wake", fromKind: "murage", toBotId: "lead", targetThreadId: "t", parentId: handover.id,
      projectGoalId: "goal", payloadText: "[]", admissionKey: `wake:${handover.id}`, priority: "coordinator", state: "running", now: 9 }).request;
    expect(projectRequestOwnerControl(db, result.id)).toBe(true);
  });

  it("a room that is no longer the owner's audience since the Start is refused", () => {
    const wake = goalWake("wake:goal-start:goal");
    expect(projectRequestOwnerControl(db, wake.id, () => false)).toBe(false);
    const checked: string[] = [];
    const stillOwner = (root: RoomRequest) => { checked.push(root.id); return false; };
    expect(projectToolHandlers.get("assign")!({ ...leadOn(wake), rootAudienceStillOwner: stillOwner }, { cards })).toMatchObject({ status: 409, body: { refused: [{ reason: "Bind the card to its source messages first." }, { reason: "Bind the card to its source messages first." }] } });
    expect(checked).toContain(wake.id);
    expect(made()).toEqual([]);
    expect(projectToolHandlers.get("assign")!({ ...leadOn(wake), rootAudienceStillOwner: () => true }, { cards }).status).toBe(200);
  });
});
