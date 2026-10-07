// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeProjectTables, rollupUsageLedger } from "./project-tables.ts";
import { insertRoomRequest, completeRequest, roomRequest, markRequestDispatched, reconcileRoomRequestsAtBoot } from "./room-requests.ts";
import { settleProjectUsage, projectUsage, settleProjectToolCharge } from "./usage-ledger.ts";
let db: DatabaseSync;
beforeEach(() => { db = new DatabaseSync(":memory:"); initializeProjectTables(db); });
afterEach(() => db.close());
function request(thread = "room", now = 1000) {
  return insertRoomRequest(db, { groupId: "g", projectGoalId: "goal", workItemId: "card", attempt: 2,
    verb: "room_turn", fromKind: "owner", toBotId: "bot", targetThreadId: thread,
    admissionKey: thread + now, now, state: "running",
    lineage: { rootThreadId: thread, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false },
  }).request;
}
const terminal = { threadId: "room", botId: "bot", engine: "fuigo", turnGeneration: "gen", providerTurnId: "one", at: 6000, ok: true, usage: { input: 100, output: 20, cachedInput: 30 } };
describe("project usage settlement", () => {
  it("banks once per thread and provider turn with frozen request attribution", () => {
    const first = request();
    expect(settleProjectUsage(db, first, terminal)).toBe(true);
    expect(settleProjectUsage(db, first, terminal)).toBe(false);
    settleProjectUsage(db, request("desk"), { ...terminal, threadId: "desk" });
    const rows = db.prepare("SELECT * FROM usage_ledger ORDER BY thread_id").all();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ group_id: "g", goal_id: "goal", work_item_id: "card", request_id: first.id, root_id: first.rootId, attempt: 2, input: 100, work_ms: 5000 });
  });
  it("excludes owner waits and settles failed and superseded executions", () => {
    const r = request();
    db.prepare("UPDATE room_requests SET owner_wait_ms=1000, waiting_since=4000, state='waiting_owner' WHERE id=?").run(r.id);
    completeRequest(db, r.id, { state: "cancelled", now: 6000 }, { cardGenerationCurrent: () => false,
      settleUsage: (conn, done) => settleProjectUsage(conn, done, { ...terminal, ok: false }) });
    expect(db.prepare("SELECT work_ms, ok FROM usage_ledger").get()).toMatchObject({ work_ms: 2000, ok: 0 });
  });
  it("uses request generation without a provider id and never invents missing tokens", () => {
    const r = request();
    settleProjectUsage(db, r, { ...terminal, providerTurnId: undefined, usage: undefined });
    expect(db.prepare("SELECT * FROM usage_ledger").get()).toMatchObject({ settle_key: `req:${r.id}:gen:dispatch:${r.dispatchedAt}`, tokens_reported: 0, input: null, output: null });
    expect(projectUsage(db, { groupId: "g" }).notReported).toEqual(["bot"]);
  });
  it("estimates a boot's unfinished run up to its last activity (no clock cap) and replaces it atomically with the later terminal", () => {
    const r = request();
    completeRequest(db, r.id, { state: "unknown", now: 9999999 });
    settleProjectUsage(db, roomRequest(db, r.id)!, { ...terminal, unknown: true, at: 9999999, lastActivityAt: 8000000 });
    expect(db.prepare("SELECT * FROM usage_ledger").get()).toMatchObject({ settle_key: `unknown:${r.id}:dispatch:${r.dispatchedAt}`, work_ms: 8000000 - r.dispatchedAt!, tokens_reported: 0, ok: 0 });
    settleProjectUsage(db, r, terminal);
    expect(db.prepare("SELECT * FROM usage_ledger").all()).toHaveLength(1);
    expect(projectUsage(db, { groupId: "g" }).totals.workMs).toBe(5000);
  });
  it("shows real charges only, keeps estimates separate, and deduplicates tool operations", () => {
    const r = request();
    settleProjectUsage(db, r, { ...terminal, engine: "claude", cost: 9 });
    settleProjectUsage(db, r, { ...terminal, providerTurnId: "two", charge: 0.2 });
    settleProjectToolCharge(db, r, { ...terminal, operationId: "image-op", charge: 0.3 });
    settleProjectToolCharge(db, r, { ...terminal, operationId: "image-op", charge: 0.3 });
    expect(projectUsage(db, { groupId: "g" }).totals.charge).toBe(0.5);
    expect(db.prepare("SELECT charge_kind FROM usage_ledger WHERE turn_id='one'").get()?.charge_kind).toBe("estimate");
  });
  it("rolls old rows once without crossing an open period or mixing charge kinds", () => {
    const r = request("room", 0);
    for (let n = 0; n < 2; n++) settleProjectUsage(db, r, { ...terminal, providerTurnId: String(n), at: 1000 + n, charge: 0.1 });
    const now = 200 * 86400000;
    db.prepare("INSERT INTO project_budgets (id,group_id,period,tz,period_start,max_work_minutes,created_at) VALUES ('b','g','week','UTC',0,120,0)").run();
    rollupUsageLedger(db, now);
    expect(db.prepare("SELECT * FROM usage_ledger WHERE rolled_up=1").all()).toHaveLength(0);
    db.prepare("UPDATE project_budgets SET period_start=?").run(now);
    rollupUsageLedger(db, now); rollupUsageLedger(db, now);
    expect(db.prepare("SELECT * FROM usage_ledger").all()).toHaveLength(1);
    expect(db.prepare("SELECT * FROM usage_ledger").get()).toMatchObject({ thread_id: "rollup", rolled_up: 1, input: 200, output: 40, charge: 0.2, work_ms: 2001 });
  });
  it("keeps per-card usage exact across the rollup and keeps legacy card-less rollup keys stable", () => {
    const day = 5 * 86400000;
    const row = db.prepare(`INSERT INTO usage_ledger (settle_key,group_id,goal_id,work_item_id,request_id,root_id,bot_id,thread_id,engine,model,input,output,tokens_reported,charge_kind,work_ms,ok,at)
      VALUES (?,'g','goal',?,?,'root','bot','room','fuigo','m',?,?,1,'none',?,1,?)`);
    // Same group, day, goal, root, bot, engine, model, audience and charge kind: only the card differs.
    row.run("a1", "card-a", "ra1", 100, 10, 1000, day + 1);
    row.run("a2", "card-a", "ra2", 50, 5, 500, day + 2);
    row.run("b1", "card-b", "rb1", 7, 3, 70, day + 3);
    row.run("n1", null, "rn1", 1, 1, 1, day + 4);
    const perCard = () => Object.fromEntries((db.prepare(`SELECT work_item_id AS card, SUM(work_ms) AS workMs, SUM(COALESCE(input,0)+COALESCE(output,0)) AS tokens
      FROM usage_ledger WHERE group_id='g' AND work_item_id IS NOT NULL GROUP BY work_item_id ORDER BY work_item_id`).all() as Array<{ card: string; workMs: number; tokens: number }>)
      .map(r => [r.card, { workMs: r.workMs, tokens: r.tokens }]));
    const before = perCard();
    expect(before).toEqual({ "card-a": { workMs: 1500, tokens: 165 }, "card-b": { workMs: 70, tokens: 10 } });
    rollupUsageLedger(db, 200 * 86400000);
    expect(db.prepare("SELECT COUNT(*) AS n FROM usage_ledger WHERE rolled_up=0").get()?.n).toBe(0);
    expect(perCard()).toEqual(before);
    expect(projectUsage(db, { groupId: "g" }).totals).toMatchObject({ workMs: 1571, input: 158, output: 19 });
    // A card-less bucket keeps the key the first rollup release wrote, so rows rolled before this fix stay no-ops.
    const legacy = createHash("sha256").update(JSON.stringify(["goal", "root", "bot", "fuigo", "m", null, "none"])).digest("hex").slice(0, 16);
    expect(db.prepare("SELECT work_item_id, work_ms FROM usage_ledger WHERE settle_key=?").get(`rollup:g:1970-01-06:${legacy}`)).toMatchObject({ work_item_id: null, work_ms: 1 });
    rollupUsageLedger(db, 200 * 86400000);
    expect(perCard()).toEqual(before);
  });
  it("leaves a late card row itemised beside an existing rollup row written before the fix", () => {
    const day = 5 * 86400000;
    const legacy = createHash("sha256").update(JSON.stringify(["goal", "root", "bot", "fuigo", "m", null, "none"])).digest("hex").slice(0, 16);
    db.prepare(`INSERT INTO usage_ledger (settle_key,group_id,goal_id,root_id,bot_id,thread_id,engine,model,input,output,tokens_reported,charge_kind,work_ms,ok,rolled_up,at)
      VALUES (?,'g','goal','root','bot','rollup','fuigo','m',9,9,1,'none',900,1,1,?)`).run(`rollup:g:1970-01-06:${legacy}`, day);
    db.prepare(`INSERT INTO usage_ledger (settle_key,group_id,goal_id,work_item_id,request_id,root_id,bot_id,thread_id,engine,model,input,output,tokens_reported,charge_kind,work_ms,ok,at)
      VALUES ('late','g','goal','card-a','r','root','bot','room','fuigo','m',4,4,1,'none',40,1,?)`).run(day + 9);
    rollupUsageLedger(db, 200 * 86400000);
    expect(db.prepare("SELECT SUM(work_ms) AS w FROM usage_ledger WHERE work_item_id='card-a'").get()?.w).toBe(40);
    expect(db.prepare("SELECT SUM(work_ms) AS w FROM usage_ledger").get()?.w).toBe(940);
    expect(db.prepare("SELECT work_ms FROM usage_ledger WHERE settle_key=?").get(`rollup:g:1970-01-06:${legacy}`)?.work_ms).toBe(900);
  });
});

it("settles an interrupted retry per dispatch after a one second failed launch", () => {
  const first = request();
  settleProjectUsage(db, first, { ...terminal, at: 2000, ok: false });
  db.prepare("UPDATE room_requests SET state='queued' WHERE id=?").run(first.id);
  expect(markRequestDispatched(db, first.id, { now: 7000 })).toBe(true);
  const retry = roomRequest(db, first.id)!;
  expect(retry).toMatchObject({ attempt: first.attempt, cardGeneration: first.cardGeneration });
  const hooks = { settleUsage: (conn: DatabaseSync, r: typeof retry) => settleProjectUsage(conn, r, { ...terminal, at: 22000, unknown: true }) };
  reconcileRoomRequestsAtBoot(db, 22000, hooks);
  expect(projectUsage(db, { groupId: "g" })).toMatchObject({ totals: { workMs: 16000 }, interrupted: true });
  expect(settleProjectUsage(db, retry, { ...terminal, at: 22000, unknown: true })).toBe(false);
  reconcileRoomRequestsAtBoot(db, 23000, hooks);
  expect(db.prepare("SELECT * FROM usage_ledger").all()).toHaveLength(2);
});


it("replaces a matching legacy unknown without doubling work", () => {
  const r = request(); settleProjectUsage(db, r, { ...terminal, unknown: true });
  db.prepare("UPDATE usage_ledger SET settle_key=?").run(`unknown:${r.id}`);
  expect(settleProjectUsage(db, r, terminal)).toBe(true);
  expect(projectUsage(db, { groupId: "g" })).toMatchObject({ totals: { workMs: 5000 }, interrupted: false });
  expect(db.prepare("SELECT * FROM usage_ledger").all()).toHaveLength(1);
});
it.each([true, false])("replaying a legacy terminal is a no-op (provider key: %s)", provider => {
  const r = request(), event = { ...terminal, providerTurnId: provider ? "one" : undefined };
  settleProjectUsage(db, r, event);
  db.prepare("UPDATE usage_ledger SET settle_key=substr(settle_key,1,length(settle_key)-length(?))").run(`:dispatch:${r.dispatchedAt}`);
  expect(settleProjectUsage(db, r, event)).toBe(false);
  expect(projectUsage(db, { groupId: "g" }).totals).toMatchObject({ workMs: 5000, input: 100, output: 20 });
});
it("a legacy failed launch never suppresses a later retry settlement", () => {
  const r = request(); settleProjectUsage(db, r, { ...terminal, at: 2000, ok: false });
  db.prepare("UPDATE usage_ledger SET settle_key=substr(settle_key,1,length(settle_key)-length(?))").run(`:dispatch:${r.dispatchedAt}`);
  const retry = { ...r, dispatchedAt: 7000 };
  expect(settleProjectUsage(db, retry, { ...terminal, unknown: true, at: 12000 })).toBe(true);
  expect(settleProjectUsage(db, retry, { ...terminal, at: 12000 })).toBe(true);
  expect(projectUsage(db, { groupId: "g" })).toMatchObject({ totals: { workMs: 6000, input: 200 }, interrupted: false });
});
it("preserves historical interruption through repeated rollups", () => {
  const r = request(); settleProjectUsage(db, r, { ...terminal, unknown: true });
  settleProjectUsage(db, request("other"), { ...terminal, threadId: "other" });
  rollupUsageLedger(db, 200 * 86400000); rollupUsageLedger(db, 201 * 86400000);
  expect(db.prepare("SELECT * FROM usage_ledger WHERE rolled_up=0").all()).toHaveLength(0);
  expect(projectUsage(db, { groupId: "g" })).toMatchObject({ totals: { workMs: 10000, input: 100 }, interrupted: true });
});

it("keeps an older legacy unknown separate from a later dispatch", () => {
  const r = request(); settleProjectUsage(db, r, { ...terminal, unknown: true, at: 2000 });
  db.prepare("UPDATE usage_ledger SET settle_key=?").run(`unknown:${r.id}`);
  expect(settleProjectUsage(db, { ...r, dispatchedAt: 7000 }, { ...terminal, at: 12000 })).toBe(true);
  expect(projectUsage(db, { groupId: "g" })).toMatchObject({ totals: { workMs: 6000 }, interrupted: true });
  expect(db.prepare("SELECT * FROM usage_ledger").all()).toHaveLength(2);
});
it("rolls back legacy unknown replacement if terminal insertion fails", () => {
  const r = request(); settleProjectUsage(db, r, { ...terminal, unknown: true });
  db.prepare("UPDATE usage_ledger SET settle_key=?").run(`unknown:${r.id}`);
  db.exec("CREATE TEMP TRIGGER reject_terminal BEFORE INSERT ON usage_ledger WHEN NEW.tokens_reported=1 BEGIN SELECT RAISE(ABORT, 'fixture insertion failure'); END");
  expect(() => settleProjectUsage(db, r, terminal)).toThrow("fixture insertion failure");
  expect(db.prepare("SELECT settle_key FROM usage_ledger").all()).toEqual([{ settle_key: `unknown:${r.id}` }]);
  expect(projectUsage(db, { groupId: "g" })).toMatchObject({ totals: { workMs: 5000 }, interrupted: true });
});
