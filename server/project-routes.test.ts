// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { DATA_DIR } from "./config.ts";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { initializeProjectTables } from "./project-tables.ts";
import { channelToProjectRows } from "./project-settings.ts";
import { createDefaultPeriodBudget } from "./project-defaults.ts";
import { insertRoomRequest } from "./room-requests.ts";
import { handleProjectRoute } from "./project-routes.ts";
import { insertProjectActivity } from "./project-records.ts";

mkdirSync(DATA_DIR, { recursive: true });

it("sums usage per card without leaking other cards or groups and handles an absent ledger", () => {
  const { db, call } = fixture();
  try {
    const card = call("POST", "board/cards", { clientId: "usage", title: "Usage" })!.body.card as { id: string };
    call("POST", "board/cards", { clientId: "empty", title: "Empty" });
    const put = db.prepare(`INSERT INTO usage_ledger (settle_key,group_id,work_item_id,bot_id,thread_id,engine,input,output,tokens_reported,charge_kind,work_ms,ok,at) VALUES (? ,?,?,'bot','desk','fake',?,?,?,'none',?,1,100)`);
    put.run("a", "g", card.id, 10, 20, 1, 1000);
    put.run("b", "g", card.id, 5, 2, 1, 2000);
    put.run("other", "other", card.id, 900, 900, 1, 9000);
    expect(call("GET", "board")).toMatchObject({ body: { cards: [
      { id: card.id, usage: { workMs: 3000, tokens: 37, tokensReported: true } },
      { usage: { workMs: 0, tokens: 0, tokensReported: false } },
    ] } });
    put.run("missing", "g", card.id, null, null, 0, 500);
    expect((call("GET", "board")!.body.cards as Array<{ usage: unknown }>)[0].usage).toEqual({ workMs: 3500, tokens: 37, tokensReported: false });
    db.exec("DROP TABLE usage_ledger");
    expect((call("GET", "board")!.body.cards as Array<{ usage: unknown }>)[0].usage).toEqual({ workMs: 0, tokens: 0, tokensReported: false });
  } finally { db.close(); }
});

it("filters card history before paging and validates the card id", () => {
  const { db, group } = fixture();
  try {
    for (let at = 1; at <= 5; at++) insertProjectActivity(db, { groupId: "g", kind: "card_moved", actor: "owner", workItemId: at % 2 ? "c-1" : "c-2", at });
    insertProjectActivity(db, { groupId: "other", kind: "card_moved", actor: "owner", workItemId: "c-1", at: 3 });
    const read = (q: string) => handleProjectRoute(db, { method: "GET", path: "/api/groups/g/activity", query: new URLSearchParams(q), body: {}, group, now: 100 });
    expect(read("card=c-1&before=5&limit=1")).toMatchObject({ status: 200, body: { items: [{ workItemId: "c-1", at: 3 }] } });
    expect((read("card=c-1&before=3")!.body.items as unknown[])).toHaveLength(1);
    expect(read("card=bad%2Fid")!.status).toBe(400);
    expect(read("card=")!.status).toBe(400);
    expect((read("card=missing")!.body.items as unknown[])).toHaveLength(0);
  } finally { db.close(); }
});

function fixture() {
  const db = new DatabaseSync(":memory:");
  initializeProjectTables(db);
  channelToProjectRows(db, { groupId: "g", bulletin: "Rules", leadBotId: "lead", now: 1 });
  const group = { id: "g", memberIds: ["lead", "worker"], threadId: "room", dm: false };
  const call = (method: string, tail: string, body: unknown = {}, flags = {}) => handleProjectRoute(db, { origin: "desktop", method, path: `/api/groups/g/${tail}`, query: new URLSearchParams(), body, group, now: 100, flags });
  return { db, group, call };
}

describe("project route contract", () => {
  it("reads the aggregate and records owner viewed without changing revision", () => {
    const { db, call } = fixture();
    expect(call("GET", "project")).toMatchObject({ status: 200, body: { lifecycle: "open", brief: { rules: "Rules" }, revision: 0 } });
    expect(call("POST", "project/viewed")).toMatchObject({ status: 200 });
    expect(db.prepare("SELECT owner_viewed_at, revision FROM project_settings").get()).toMatchObject({ owner_viewed_at: 100, revision: 0 });
    db.close();
  });
  it("refuses unknown fields and stale revisions across all owner writes", () => {
    const { db, call } = fixture();
    expect(call("PATCH", "project/brief", { expectedVersion: 0 })).toMatchObject({ status: 409, body: { error: "changed", brief: { version: 1 } } });
    expect(call("PATCH", "project/settings", { expectedRevision: 3 })).toMatchObject({ status: 409, body: { error: "changed" } });
    expect(call("PUT", "board/columns", { expectedRevision: 3, columns: [] })).toMatchObject({ status: 409 });
    expect(call("POST", "project/goals", { title: "Goal", extra: true })).toMatchObject({ status: 400 });
    expect(call("POST", "project/goals", { title: null })).toMatchObject({ status: 400 });
    db.close();
  });
  it("creates idempotent cards and checks revisions before actions", () => {
    const { db, call } = fixture();
    const body = { clientId: "one", title: "Do it", assigneeBotId: "worker" };
    const first = call("POST", "board/cards", body)!;
    expect(first.status).toBe(200);
    expect(call("POST", "board/cards", body)).toEqual(first);
    const card = first.body.card as { id: string };
    expect(call("PATCH", `board/cards/${card.id}`, { expectedRevision: 9, action: "cancel" })).toMatchObject({ status: 409, body: { error: "changed" } });
    expect(call("PATCH", `board/cards/${card.id}`, { expectedRevision: 0, action: "cancel" })).toMatchObject({ status: 200, body: { card: { state: "cancelled" } } });
    db.close();
  });
  it("preserves ended history, refuses writes, and hides pair rooms", () => {
    const { db, group, call } = fixture();
    db.prepare("UPDATE project_settings SET ended_at=2").run();
    for (const tail of ["project", "board", "activity", "project/brief/versions"]) expect(call("GET", tail)).toMatchObject({ status: 200, body: { lifecycle: "ended" } });
    expect(call("POST", "project/viewed")).toMatchObject({ status: 409 });
    group.dm = true;
    expect(call("GET", "project")).toMatchObject({ status: 404 });
    db.close();
  });
  it("folds flags into reads without writes and refuses goal start", () => {
    const { db, call } = fixture();
    const result = call("POST", "project/goals", { title: "Goal" })!;
    const goal = result.body.goal as { id: string };
    const before = db.prepare("SELECT * FROM project_settings").get();
    expect(call("GET", "project", {}, { projectsLead: false })).toMatchObject({ body: { strip: { line: "Paused: the lead is off" } } });
    expect(db.prepare("SELECT * FROM project_settings").get()).toEqual(before);
    expect(call("PATCH", `project/goals/${goal.id}`, { expectedRevision: 0, action: "start" }, { projectsGoals: false })).toMatchObject({ status: 409 });
    db.close();
  });
});

it("Interrupt card fails a current run and cancels its open asks", () => {
  const { db, call } = fixture();
  const made = call("POST", "board/cards", { clientId: "run", title: "Run", assigneeBotId: "worker" })!;
  const cardId = (made.body.card as { id: string }).id;
  const queued = call("PATCH", `board/cards/${cardId}`, { expectedRevision: 0, action: "start" })!;
  const requestId = String(queued.body.requestId);
  db.prepare("UPDATE project_work_items SET state='doing', request_id=?, generation=1 WHERE id=?").run(requestId, cardId);
  db.prepare("UPDATE room_requests SET state='running', card_generation=1 WHERE id=?").run(requestId);
  const rev = Number(db.prepare("SELECT revision FROM project_work_items WHERE id=?").get(cardId)!.revision);
  expect(call("PATCH", `board/cards/${cardId}`, { expectedRevision: rev, action: "interrupt" })).toMatchObject({ status: 200, body: { card: { state: "failed", failures: 1 } } });
  db.close();
});

it("pins every U1 aggregate field and the empty usage shape", () => {
  const { db, call } = fixture();
  try {
    expect(call("GET", "project")).toMatchObject({ status: 200, body: {
      lifecycle: "open", settings: { groupId: "g", mode: "conversation", leadBotId: "lead", parts: { board: true, review: true, digest: false }, runState: "running", runStateReason: null, closedAt: null, endedAt: null, revision: 0 },
      brief: { version: 1, summary: "", doneMeans: "", rules: "Rules", whereWorkIs: [] }, goal: null, budgets: [],
      strip: { line: "", needsYou: 0, usage: { workMs: 0, input: 0, output: 0, tokensReported: false, charge: null } },
      sinceYouLeft: { messages: 0, cards: 0, decisions: 0 }, revision: 0,
    } });
    expect(Object.keys(call("GET", "project")!.body).sort()).toEqual(["brief", "budgets", "closeStep", "closing", "goal", "lifecycle", "revision", "settings", "sinceYouLeft", "strip"]);
    const goal = call("POST", "project/goals", { title: "Finish" })!.body.goal as { id: string };
    const whereWorkIs = [{ text: "Draft", path: "/work/draft", by: "owner", at: 100 }];
    expect(call("PATCH", "project/brief", { expectedVersion: 1, whereWorkIs })!.status).toBe(200);
    const budget = createDefaultPeriodBudget(db, { groupId: "g", period: "week", tz: "UTC", now: 1 });
    expect(call("GET", "project")).toMatchObject({ body: {
      brief: { version: 2, whereWorkIs }, goal: { id: goal.id, title: "Finish", state: "draft", stateReason: null, revision: 0 },
      budgets: [budget],
    } });
    expect(call("POST", "project/viewed")).toEqual({ status: 200, body: { ok: true } });
    expect(call("GET", "project")).toMatchObject({ body: { revision: 0, sinceYouLeft: { messages: 0, cards: 0, decisions: 0 } } });
  } finally { db.close(); }
});

it("returns complete usage totals for reported, unreported and mixed ledger rows", () => {
  const { db, call } = fixture();
  try {
    const insert = db.prepare(`INSERT INTO usage_ledger (settle_key, group_id, bot_id, thread_id, engine, input, output, tokens_reported, charge_kind, work_ms, ok, at) VALUES (?, ?, 'worker', 'room', 'fake', ?, ?, ?, 'none', 60000, 1, 1)`);
    insert.run("one", "g", 4, 6, 1);
    insert.run("other", "other", 999, 999, 1);
    expect(call("GET", "project")).toMatchObject({ body: { strip: { usage: { workMs: 60000, input: 4, output: 6, tokensReported: true, charge: null } } } });
    insert.run("two", "g", null, null, 0);
    expect(call("GET", "project")).toMatchObject({ body: { strip: { usage: { workMs: 120000, input: 4, output: 6, tokensReported: false, charge: null } } } });
    db.prepare("DELETE FROM usage_ledger WHERE settle_key='one'").run();
    expect(call("GET", "project")).toMatchObject({ body: { strip: { usage: { workMs: 60000, input: 0, output: 0, tokensReported: false, charge: null } } } });
  } finally { db.close(); }
});

it("pins U1 board columns, card keys and revision-fenced reassign and take-over bodies", () => {
  const { db, call } = fixture();
  try {
    const made = call("POST", "board/cards", { clientId: "ui", title: "Draft", assigneeBotId: "worker" })!;
    const card = made.body.card as { id: string };
    expect(call("PUT", "board/columns", { expectedRevision: 0, columns: [{ id: "custom", title: "Next", state: "todo", position: 1 }] })!.status).toBe(200);
    const board = call("GET", "board")!;
    expect(Object.keys(board.body).sort()).toEqual(["cards", "columns", "columnsRevision", "lifecycle"]);
    expect(board).toMatchObject({ status: 200, body: { lifecycle: "open", columnsRevision: 1, cards: [{ id: card.id, title: "Draft", state: "todo", revision: 0, assigneeBotId: "worker" }] } });
    expect(board.body.columns).toEqual(expect.arrayContaining([
      { id: "todo", title: "To do", state: "todo", position: 0 },
      expect.objectContaining({ id: "custom", title: "Next", state: "todo", position: 1 }),
    ]));
    expect(call("PATCH", `board/cards/${card.id}`, { action: "reassign", expectedRevision: 0, assigneeBotId: "lead" })).toMatchObject({ status: 200, body: { card: { assigneeBotId: "lead", revision: 1 } } });
    expect(call("PATCH", `board/cards/${card.id}`, { action: "take_over", expectedRevision: 0 })).toMatchObject({ status: 409, body: { error: "changed", card: { revision: 1 } } });
    expect(call("PATCH", `board/cards/${card.id}`, { action: "take_over", expectedRevision: 1 })).toMatchObject({ status: 200, body: { card: { assigneeBotId: null, revision: 2 } } });
  } finally { db.close(); }
});

it("a restart Skip needs confirmation and records Skipped by you",()=>{
  const {db,call}=fixture();try{
    const created=call("POST","board/cards",{clientId:"restart-skip",title:"Interrupted step"})!;
    const card=created.body.card as {id:string;revision:number};
    db.prepare("UPDATE project_work_items SET state='waiting',waiting_on=? WHERE id=?").run(JSON.stringify({kind:"restart"}),card.id);
    expect(call("PATCH",`board/cards/${card.id}`,{expectedRevision:card.revision,action:"done"})?.status).toBe(409);
    expect(call("PATCH",`board/cards/${card.id}`,{expectedRevision:card.revision,action:"done",confirm:true})).toMatchObject({status:200,body:{card:{state:"done",reason:"Skipped by you"}}});
  }finally{db.close();}
});

it.each([["planning", "Waiting for the lead's plan"], ["awaiting_plan_ok", "Waiting for your OK on the plan"], ["paused", "Paused"]])("PF strip explains %s", (state, reason) => {
  const { db, call } = fixture();
  db.prepare("INSERT INTO project_goals(id,group_id,title,state,created_at) VALUES('goal','g','Ship',?,1)").run(state);
  expect(call("GET", "project")).toMatchObject({ body: { strip: { reason } } });
  db.close();
});

it("counts waiting card slots, excludes reviews and preserves pause precedence", () => {
  const { db, call } = fixture();
  try {
    for (const [id, verb, groupId] of [["a", "assign", "g"], ["b", "wake", "g"], ["review", "review", "g"], ["other", "assign", "other"]] as const) {
      const request = insertRoomRequest(db, { groupId, verb, fromKind: "owner", toBotId: id, workItemId: id, admissionKey: id, lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false }, state: "running", now: 1 }).request;
      db.prepare("UPDATE room_requests SET state='waiting_owner' WHERE id=?").run(request.id);
    }
    expect(call("GET", "project")).toMatchObject({ body: { strip: { line: "2 of 3 slots waiting on you" } } });
    expect(call("GET", "project", {}, { projectsParallelCards: false })).toMatchObject({ body: { strip: { line: "2 of 2 slots waiting on you" } } });
    db.exec("UPDATE project_settings SET parallel_cards=1");
    expect(call("GET", "project")).toMatchObject({ body: { strip: { line: "2 of 2 slots waiting on you" } } });
    db.exec("UPDATE project_settings SET run_state='paused'");
    expect(call("GET", "project")).toMatchObject({ body: { strip: { line: "Paused" } } });
    expect(call("GET", "project", {}, { projectsGoals: false })).toMatchObject({ body: { strip: { line: "Paused: goals are off" } } });
    expect(call("GET", "project", {}, { projectsLead: false, projectsGoals: false })).toMatchObject({ body: { strip: { line: "Paused: the lead is off" } } });
  } finally { db.close(); }
});
