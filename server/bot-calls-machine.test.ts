// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot calls phase 2 (design BOT-CALLS-109 rev 4.2): the transitions of 5.4, the cancel of 5.6, the sessions of 5.7, the
// owed drain of 4.1 and the boot reconcile of 5.8, with failure rows F2, F4-F10, F14, F16-F22, F30, F33, F36, F56, F58, F59.
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initializeMessageTables } from "./message-tables.ts";
import { initializeMobilePush } from "./mobile-push-store.ts";
import { initializeBotCalls, insertCallRule, putCallRules, type CallRuleInput } from "./bot-calls-schema.ts";
import {
  admitIntent, answerCall, applyEscalation, applyInitial, bootReconcile, callIsLive, cancelBotCalls, declineCall, drainOwed, endSession, fenceCallLine, getIntent,
  getSession, markSeen, markTurnCall, matchChannelOwed, missCall, openOwnerSession, settleTurnOwed, sweepSessions, touchSession,
  type Admission, type CallEffects, type CallIntent, type OwedRow,
} from "./bot-calls-machine.ts";

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function fresh(): DatabaseSync {
  const db = new DatabaseSync(":memory:"); dbs.push(db);
  initializeMessageTables(db); initializeMobilePush(db); initializeBotCalls(db);
  return db;
}
const count = (db: DatabaseSync, sql: string, ...args: Array<string | number>) => Number((db.prepare(sql).get(...args) as { n: number }).n);
type Rec = Array<[string, string, string?]>;
function recorder(): { fx: CallEffects; log: Rec } {
  const log: Rec = [];
  return { log, fx: {
    ring: (i: CallIntent) => { log.push(["ring", i.id]); },
    note: (i: CallIntent) => { log.push(["note", i.id]); },
    resolve: (i: CallIntent, where) => { log.push(["resolve", i.id, where]); },
    card: (i: CallIntent) => { log.push(["card", i.id, i.outcome ?? i.state]); },
    dropNotes: (botId: string) => { log.push(["dropNotes", botId]); },
  } };
}
const T0 = 1_800_000_000_000;
const watchRule: CallRuleInput = { kind: "watch", params: { watchId: "w1" }, how: "ring", enabled: true, emergency: false };
function rule(db: DatabaseSync, botId = "scout", input: CallRuleInput = watchRule): string { return insertCallRule(db, { ...input, botId }, T0); }
const fact = (ruleId: string, key: string, extra: Partial<Admission> = {}): Admission =>
  ({ botId: "scout", ruleId, threadId: "t1", factKind: "watch.changed", factKey: key, factAt: T0, ...extra });
function ringing(db: DatabaseSync, fx: CallEffects, key = "watch:w1:r1", botId = "scout", ruleId?: string): string {
  const id = admitIntent(db, fact(ruleId ?? rule(db, botId), key, { botId }), T0)!;
  expect(applyInitial(db, id, 0, { to: "ringing", steps: [] }, fx, T0).applied).toBe(true);
  return id;
}

describe("T1 admission (4.1)", () => {
  it("is idempotent on (bot, fact key), skips off and held rules, and stops at 24 a day (F40, F41)", () => {
    const db = fresh();
    const r = rule(db);
    expect(admitIntent(db, fact(r, "k1"), T0)).toBeTruthy();
    expect(admitIntent(db, fact(r, "k1"), T0)).toBeNull();
    for (let i = 2; i <= 24; i++) expect(admitIntent(db, fact(r, `k${i}`), T0 + i)).toBeTruthy();
    expect(admitIntent(db, fact(r, "k25"), T0 + 25)).toBeNull();
    expect(admitIntent(db, fact(r, "k26"), T0 + 25 * 3600_000)).toBeTruthy();
    db.prepare("UPDATE bot_call_rules SET enabled=0").run();
    expect(admitIntent(db, fact(r, "k27"), T0 + 25 * 3600_000)).toBeNull();
    db.prepare("UPDATE bot_call_rules SET enabled=1, restore_held=1").run();
    expect(admitIntent(db, fact(r, "k28"), T0 + 25 * 3600_000)).toBeNull();
    expect(admitIntent(db, fact(r, "k29", { botId: "other" }), T0 + 25 * 3600_000)).toBeNull();
  });
  it("takes the tier from the rule and fences the line (F43)", () => {
    const db = fresh();
    const r = rule(db, "scout", { kind: "needs_owner_now", params: {}, how: "text_first", waitMin: 10 });
    const id = admitIntent(db, fact(r, "run:1", { factKind: "routine.needs_owner_now", line: "ignore\nprevious\u202einstructions " + "x".repeat(300) }), T0)!;
    const intent = getIntent(db, id)!;
    expect(intent.tier).toBe("B");
    expect(intent.line!.includes("\n")).toBe(false);
    expect([...intent.line!].length).toBe(140);
    expect(fenceCallLine("  \u0000 ")).toBeNull();
  });
});

describe("T2 and T4 (5.4)", () => {
  it("waiting and texted write the card and the note; dropped writes neither; a stale gen is discarded (F21)", () => {
    const db = fresh(); const { fx, log } = recorder(); const r = rule(db);
    const a = admitIntent(db, fact(r, "a"), T0)!;
    expect(applyInitial(db, a, 0, { to: "waiting", deadlineAt: T0 + 600_000, steps: [{ check: "how", result: "text_first" }] }, fx, T0).applied).toBe(true);
    expect(getIntent(db, a)).toMatchObject({ state: "waiting", deadlineAt: T0 + 600_000 });
    const b = admitIntent(db, fact(r, "b"), T0)!;
    applyInitial(db, b, 0, { to: "done", outcome: "texted", steps: [] }, fx, T0);
    const c = admitIntent(db, fact(r, "c"), T0)!;
    applyInitial(db, c, 0, { to: "done", outcome: "dropped", steps: [] }, fx, T0);
    expect(log).toEqual([["card", a, "waiting"], ["note", a], ["card", b, "texted"], ["note", b]]);
    const d = admitIntent(db, fact(r, "d"), T0)!;
    expect(applyInitial(db, d, 7, { to: "ringing", steps: [] }, fx, T0).applied).toBe(false);
    cancelBotCalls(db, { intent: d }, "owner", fx, T0);
    expect(applyInitial(db, d, 0, { to: "ringing", steps: [] }, fx, T0).applied).toBe(false);
    expect(count(db, "SELECT COUNT(*) AS n FROM bot_calls WHERE active_slot=1")).toBe(0);
  });
  it("a ring takes the one slot; a second bot's ring texts (F19)", () => {
    const db = fresh(); const { fx, log } = recorder();
    const a = ringing(db, fx, "a", "scout");
    const rb = rule(db, "atlas");
    const b = admitIntent(db, fact(rb, "b", { botId: "atlas" }), T0)!;
    expect(applyInitial(db, b, 0, { to: "ringing", steps: [] }, fx, T0).applied).toBe(true);
    expect(getIntent(db, a)).toMatchObject({ state: "ringing", activeSlot: true, rangAt: T0, deadlineAt: T0 + 45_000 });
    expect(getIntent(db, b)).toMatchObject({ state: "done", outcome: "texted", activeSlot: false });
    expect(getIntent(db, b)!.receipt.steps.at(-1)).toEqual({ check: "live", result: "on_call" });
    expect(log.filter(e => e[0] === "ring")).toEqual([["ring", a]]);
  });
  it("rolls the whole transition back when a write inside it fails (F10)", () => {
    const db = fresh(); const { fx } = recorder(); const r = rule(db);
    db.exec("CREATE TABLE scratch (x)");
    const id = admitIntent(db, fact(r, "a"), T0)!;
    const failing: CallEffects = { ...fx, ring: () => { db.exec("INSERT INTO scratch VALUES (1)"); throw new Error("fan-out failed"); } };
    expect(() => applyInitial(db, id, 0, { to: "ringing", steps: [] }, failing, T0)).toThrow("fan-out failed");
    expect(getIntent(db, id)).toMatchObject({ state: "pending", activeSlot: false, rangAt: null });
    expect(count(db, "SELECT COUNT(*) AS n FROM scratch")).toBe(0);
    expect(applyInitial(db, id, 0, { to: "ringing", steps: [] }, fx, T0).applied).toBe(true);
  });
  it("T4 rings, or ends texted or late with the receipt only (F23, F24)", () => {
    const db = fresh(); const { fx, log } = recorder(); const r = rule(db);
    const ids = ["a", "b", "c"].map(k => { const id = admitIntent(db, fact(r, k), T0)!; applyInitial(db, id, 0, { to: "waiting", deadlineAt: T0 + 1, steps: [] }, fx, T0); return id; });
    log.length = 0;
    applyEscalation(db, ids[0]!, 0, { to: "done", outcome: "texted", steps: [{ check: "quiet", result: "quiet" }] }, fx, T0 + 2);
    applyEscalation(db, ids[1]!, 0, { to: "done", outcome: "late", steps: [] }, fx, T0 + 2);
    applyEscalation(db, ids[2]!, 0, { to: "ringing", steps: [] }, fx, T0 + 2);
    expect(log).toEqual([["ring", ids[2]]]);
    expect(getIntent(db, ids[0]!)).toMatchObject({ state: "done", outcome: "texted" });
    expect(getIntent(db, ids[1]!)).toMatchObject({ state: "done", outcome: "late" });
  });
  it("T3: only an explicit seen on a waiting intent", () => {
    const db = fresh(); const { fx } = recorder(); const r = rule(db);
    const id = admitIntent(db, fact(r, "a"), T0)!;
    expect(markSeen(db, id, T0)).toBe(false);
    applyInitial(db, id, 0, { to: "waiting", deadlineAt: T0 + 60_000, steps: [] }, fx, T0);
    expect(markSeen(db, id, T0 + 5)).toBe(true);
    expect(getIntent(db, id)).toMatchObject({ state: "done", outcome: "seen", seenAt: T0 + 5 });
    expect(applyEscalation(db, id, 0, { to: "ringing", steps: [] }, fx, T0 + 60_000).applied).toBe(false);
  });
});

describe("T5 answer and its retry (5.4)", () => {
  it("first device wins; the other gets answered_elsewhere; the winner's retry returns the same session (F16)", () => {
    const db = fresh(); const { fx, log } = recorder();
    const id = ringing(db, fx);
    const first = answerCall(db, id, "phone:p1", fx, T0 + 100);
    expect(first.status).toBe(200);
    expect(answerCall(db, id, "desktop:d1", fx, T0 + 300)).toEqual({ status: 409, error: "answered_elsewhere" });
    const retry = answerCall(db, id, "phone:p1", fx, T0 + 400);
    expect(retry.status === 200 && first.status === 200 && retry.callId === first.callId).toBe(true);
    expect(log.filter(e => e[0] === "resolve")).toEqual([["resolve", id, "answered"]]);
    expect(getIntent(db, id)).toMatchObject({ state: "live", answeredOn: "phone:p1", activeSlot: true });
  });
  it("an answer after the deadline is 409 expired and runs T7 (F17)", () => {
    const db = fresh(); const { fx, log } = recorder();
    const id = ringing(db, fx);
    expect(answerCall(db, id, "phone:p1", fx, T0 + 47_000)).toEqual({ status: 409, error: "expired" });
    expect(getIntent(db, id)).toMatchObject({ state: "done", outcome: "missed", activeSlot: false });
    expect(log.slice(1)).toEqual([["resolve", id, "missed"], ["card", id, "missed"], ["note", id]]);
  });
  it("the winner's retry after the session ended, or went silent, is 410 (F18)", () => {
    const db = fresh(); const { fx } = recorder();
    const id = ringing(db, fx);
    const won = answerCall(db, id, "phone:p1", fx, T0 + 100);
    if (won.status !== 200) throw new Error("no answer");
    expect(answerCall(db, id, "phone:p1", fx, T0 + 100 + 61_000)).toEqual({ status: 410, error: "gone" });
    expect(getSession(db, won.callId)).toMatchObject({ endedBy: "lost" });
    expect(getIntent(db, id)).toMatchObject({ state: "done", outcome: "answered", activeSlot: false });
    expect(answerCall(db, id, "phone:p1", fx, T0 + 200_000)).toEqual({ status: 410, error: "gone" });
  });
});

describe("T6, T7, T8 (5.4)", () => {
  it("Not now frees the slot without a note; Text me instead adds the note; T7 waits for the deadline", () => {
    const db = fresh(); const { fx, log } = recorder();
    const a = ringing(db, fx, "a");
    expect(declineCall(db, a, "declined", fx, T0 + 1)).toBe(true);
    const b = ringing(db, fx, "b");
    expect(declineCall(db, b, "text_instead", fx, T0 + 1)).toBe(true);
    const c = ringing(db, fx, "c");
    expect(missCall(db, c, fx, T0 + 44_999)).toBe(false);
    expect(missCall(db, c, fx, T0 + 45_000)).toBe(true);
    expect(log.filter(e => e[0] === "note")).toEqual([["note", b], ["note", c]]);
    expect(log.filter(e => e[0] === "resolve").map(e => e[2])).toEqual(["declined", "declined", "missed"]);
    expect(declineCall(db, a, "declined", fx, T0 + 2)).toBe(false);
  });
  it("T8: the intent follows its session; lost reads The call dropped on the card (F30, F32, F36)", () => {
    const db = fresh(); const { fx } = recorder();
    const id = ringing(db, fx);
    const won = answerCall(db, id, "desktop:d1", fx, T0 + 1);
    if (won.status !== 200) throw new Error("no answer");
    expect(touchSession(db, won.callId, fx, T0 + 50_000)).toBe("live");
    expect(sweepSessions(db, fx, T0 + 100_000)).toEqual([]);
    expect(sweepSessions(db, fx, T0 + 50_000 + 60_001)).toEqual([won.callId]);
    expect(getIntent(db, id)).toMatchObject({ state: "done", outcome: "answered", activeSlot: false });
    expect(getIntent(db, id)!.receipt.ended).toBe("lost");
  });
  it("the end route closes a call once, and its intent runs T8", () => {
    const db = fresh(); const { fx } = recorder();
    const id = ringing(db, fx);
    const won = answerCall(db, id, "desktop:d1", fx, T0 + 1);
    if (won.status !== 200) throw new Error("no answer");
    expect(endSession(db, won.callId, "closed", fx, T0 + 120_000 - 1)).toEqual({ ended: true, intentId: id });
    expect(endSession(db, won.callId, "closed", fx, T0 + 120_000)).toEqual({ ended: false, intentId: id });
    expect(getIntent(db, id)).toMatchObject({ state: "done", outcome: "answered" });
    expect(getIntent(db, id)!.receipt.steps.at(-1)).toEqual({ check: "call", result: "closed", detail: "2" });
  });
  it("a request after 60 s of silence never revives the call (F59)", () => {
    const db = fresh(); const { fx } = recorder();
    const s = openOwnerSession(db, { botId: "scout", threadId: "t1", device: "desktop:d1" }, fx, T0);
    expect(touchSession(db, s.callId, fx, T0 + 60_001)).toBe("ended");
    expect(getSession(db, s.callId)).toMatchObject({ endedBy: "lost" });
    expect(touchSession(db, s.callId, fx, T0 + 60_002)).toBe("ended");
  });
  it("the backstop ends a call that keeps talking for 4 h", () => {
    const db = fresh(); const { fx } = recorder();
    const s = openOwnerSession(db, { botId: "scout", threadId: "t1", device: "desktop:d1" }, fx, T0);
    for (let t = T0; t < T0 + 4 * 3600_000; t += 30_000) touchSession(db, s.callId, fx, t);
    expect(sweepSessions(db, fx, T0 + 4 * 3600_000)).toEqual([s.callId]);
    expect(getSession(db, s.callId)).toMatchObject({ endedBy: "backstop" });
  });
  it("opening an ordinary call while an intent rings ends the ring as text_instead; while live, new intents text", () => {
    const db = fresh(); const { fx } = recorder();
    const id = ringing(db, fx);
    const s = openOwnerSession(db, { botId: "scout", threadId: "t2", device: "desktop:d1" }, fx, T0 + 5);
    expect(s.endedRing).toBe(id);
    expect(getIntent(db, id)).toMatchObject({ state: "done", outcome: "text_instead" });
    expect(getIntent(db, id)!.receipt.stop).toBe("another_call");
    expect(callIsLive(db, T0 + 30_000)).toBe(true);
    expect(callIsLive(db, T0 + 5 + 60_001)).toBe(false);
  });
});

describe("T9 cancelBotCalls (5.6)", () => {
  it("Stop ends every live session of the bot, ordinary calls included, and drops the bot's notes (F20, F22)", () => {
    const db = fresh(); const { fx, log } = recorder();
    const s = openOwnerSession(db, { botId: "scout", threadId: "t1", device: "desktop:d1" }, fx, T0);
    const other = openOwnerSession(db, { botId: "atlas", threadId: "t9", device: "desktop:d1" }, fx, T0);
    const r = rule(db);
    const w = admitIntent(db, fact(r, "w"), T0)!;
    applyInitial(db, w, 0, { to: "waiting", deadlineAt: T0 + 600_000, steps: [] }, fx, T0);
    log.length = 0;
    const out = cancelBotCalls(db, { bot: "scout" }, "stop", fx, T0 + 10);
    expect(out).toEqual({ intents: [w], callIds: [s.callId] });
    expect(getSession(db, s.callId)).toMatchObject({ endedBy: "stopped" });
    expect(getSession(db, other.callId)!.endedAt).toBeNull();
    expect(log).toEqual([["resolve", w, "stopped"], ["card", w, "cancelled"], ["dropNotes", "scout"]]);
    expect(callIsLive(db, T0 + 20)).toBe(true);
    cancelBotCalls(db, { bot: "atlas" }, "pause", fx, T0 + 20);
    expect(callIsLive(db, T0 + 30)).toBe(false);
  });
  it("Stop mid-ring and mid-intent-call; a rule cancel leaves a call the owner is in (F21)", () => {
    const db = fresh(); const { fx } = recorder();
    const r = rule(db);
    const id = ringing(db, fx, "a", "scout", r);
    const won = answerCall(db, id, "phone:p1", fx, T0 + 1);
    if (won.status !== 200) throw new Error("no answer");
    const p = admitIntent(db, fact(r, "p"), T0)!;
    expect(cancelBotCalls(db, { rule: r }, "rule_off", fx, T0 + 2)).toEqual({ intents: [p], callIds: [] });
    expect(getIntent(db, id)!.state).toBe("live");
    expect(cancelBotCalls(db, { bot: "scout" }, "stop", fx, T0 + 3)).toEqual({ intents: [id], callIds: [won.callId] });
    expect(getIntent(db, id)).toMatchObject({ state: "done", outcome: "cancelled", activeSlot: false });
    expect(() => cancelBotCalls(db, { bot: "scout" }, "rule_off", fx, T0)).toThrow();
  });
});

describe("owed admissions and the drain (4.1)", () => {
  const senderOf = (_threadId: string, json: Record<string, unknown>) => typeof json.sender === "string" ? json.sender : null;
  const insertMessage = (db: DatabaseSync, threadId: string, id: string, at: number, json: string) =>
    db.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?,?,?,?,?,?,?)").run(threadId, id, at, "user", "text", "hi", json);
  const match = (db: DatabaseSync) => (row: OwedRow) => matchChannelOwed(db, row, senderOf);

  it("the trigger writes the owed row with the message, even a damaged one; the drain admits once and deletes it (F2, F4, F6)", () => {
    const db = fresh();
    putCallRules(db, "scout", [{ kind: "sender", params: { threadId: "tg", senderIds: ["u1"] }, how: "ring", enabled: true, emergency: false }], T0);
    putCallRules(db, "atlas", [{ kind: "sender", params: { threadId: "tg", senderIds: ["u1", "u2"] }, how: "ring", enabled: true, emergency: false }], T0);
    insertMessage(db, "tg", "m1", T0, JSON.stringify({ sender: "u1", automation: { kind: "channel" } }));
    insertMessage(db, "tg", "m2", T0 + 1, "{damaged");
    insertMessage(db, "tg", "m3", T0 + 2, JSON.stringify({ sender: "u9", automation: { kind: "channel" } }));
    insertMessage(db, "other", "m4", T0 + 3, JSON.stringify({ sender: "u1", automation: { kind: "channel" } }));
    expect(count(db, "SELECT COUNT(*) AS n FROM bot_call_owed")).toBe(3);
    const damaged: string[] = [];
    const ids = drainOwed(db, match(db), T0 + 10, row => damaged.push(row.factKey));
    expect(ids.length).toBe(2);
    expect(db.prepare("SELECT bot_id AS b FROM bot_calls ORDER BY bot_id").all()).toEqual([{ b: "atlas" }, { b: "scout" }]);
    expect(damaged).toEqual(["channel:tg:m2"]);
    expect(count(db, "SELECT COUNT(*) AS n FROM bot_call_owed")).toBe(0);
    db.prepare("INSERT INTO bot_call_owed (fact_key, bot_id, kind, thread_id, source_id, at) VALUES ('channel:tg:m1','scout','channel','tg','m1',?)").run(T0);
    for (let i = 0; i < 3; i++) drainOwed(db, match(db), T0 + 20);
    expect(count(db, "SELECT COUNT(*) AS n FROM bot_calls")).toBe(2);
  });
  it("a rule turned off before the drain matches nothing (F7); a throwing drain transaction leaves the row (F5)", () => {
    const db = fresh();
    putCallRules(db, "scout", [{ id: "s1", kind: "sender", params: { threadId: "tg", senderIds: ["u1"] }, how: "ring", enabled: true, emergency: false }], T0);
    insertMessage(db, "tg", "m1", T0, JSON.stringify({ sender: "u1", automation: { kind: "channel" } }));
    db.prepare("UPDATE bot_call_rules SET enabled=0").run();
    expect(drainOwed(db, match(db), T0)).toEqual([]);
    expect(count(db, "SELECT COUNT(*) AS n FROM bot_call_owed")).toBe(0);
    db.prepare("INSERT INTO bot_call_owed (fact_key, bot_id, kind, thread_id, source_id, at) VALUES ('x','scout','channel','tg','m1',?)").run(T0);
    db.exec("CREATE TRIGGER no_delete BEFORE DELETE ON bot_call_owed BEGIN SELECT RAISE(ABORT, 'crash'); END");
    expect(drainOwed(db, () => [], T0)).toEqual([]);
    expect(count(db, "SELECT COUNT(*) AS n FROM bot_call_owed")).toBe(1);
  });
  it("an armed turn row waits until it settles (F58); boot settles it at the thread's newest message (F8)", () => {
    const db = fresh(); const { fx } = recorder();
    const { ruleId } = markTurnCall(db, { botId: "scout", threadId: "t1", turnId: "turn-1", how: "ring" }, T0);
    const turnMatch = (row: OwedRow) => [{ botId: row.botId, ruleId, threadId: row.threadId, factKind: "turn.ended" as const, factKey: row.factKey, factAt: row.at! }];
    expect(drainOwed(db, turnMatch, T0)).toEqual([]);
    expect(count(db, "SELECT COUNT(*) AS n FROM bot_call_owed WHERE armed=1 AND at IS NULL")).toBe(1);
    insertMessage(db, "t1", "m1", T0 + 3 * 60_000, "{}");
    const boot = bootReconcile(db, { fx, threadRunning: () => false, match: turnMatch }, T0 + 6 * 60_000);
    expect(boot.admitted.length).toBe(1);
    expect(getIntent(db, boot.admitted[0]!)).toMatchObject({ factAt: T0 + 3 * 60_000, state: "pending" });
    const second = markTurnCall(db, { botId: "scout", threadId: "t2", turnId: "turn-2", how: "ring" }, T0);
    expect(settleTurnOwed(db, "turn-2", T0 + 5)).toBe(true);
    expect(settleTurnOwed(db, "turn-2", T0 + 6)).toBe(false);
    expect(second.ruleId).toBeTruthy();
  });
});

describe("boot reconcile (5.8)", () => {
  it("ends every ring with T7b whatever time is left, re-decides pending under a new gen, and never rings a missed deadline (F9, F14, F56)", () => {
    const db = fresh(); const { fx, log } = recorder(); const r = rule(db);
    const ring = ringing(db, fx, "ring", "scout", r);
    const pending = admitIntent(db, fact(r, "pending"), T0)!;
    const lateWait = admitIntent(db, fact(r, "late"), T0)!;
    applyInitial(db, lateWait, 0, { to: "waiting", deadlineAt: T0 + 5_000, steps: [] }, fx, T0);
    const okWait = admitIntent(db, fact(r, "ok"), T0)!;
    applyInitial(db, okWait, 0, { to: "waiting", deadlineAt: T0 + 3_600_000, steps: [] }, fx, T0);
    log.length = 0;
    const boot = bootReconcile(db, { fx, threadRunning: () => false, match: () => [] }, T0 + 20_000);
    expect(boot.missed).toEqual([ring]);
    expect(boot.redecide).toEqual([{ id: pending, gen: 1 }]);
    expect(boot.late).toEqual([lateWait]);
    expect(boot.timers).toEqual([{ id: okWait, deadlineAt: T0 + 3_600_000 }]);
    expect(getIntent(db, ring)).toMatchObject({ state: "done", outcome: "missed", activeSlot: false });
    expect(log.filter(e => e[1] === lateWait)).toEqual([]);
    expect(log.filter(e => e[1] === ring)).toEqual([["resolve", ring, "missed"], ["card", ring, "missed"], ["note", ring]]);
    expect(applyInitial(db, pending, 0, { to: "ringing", steps: [] }, fx, T0 + 20_000).applied).toBe(false);
    expect(log.filter(e => e[0] === "ring")).toEqual([]);
  });
  it("gives open sessions 60 s of grace: back in time continues, gone ends lost (F33)", () => {
    const db = fresh(); const { fx } = recorder();
    const back = openOwnerSession(db, { botId: "scout", threadId: "t1", device: "desktop:d1" }, fx, T0);
    const gone = openOwnerSession(db, { botId: "atlas", threadId: "t2", device: "phone:p1" }, fx, T0);
    const boot = T0 + 10 * 60_000;
    bootReconcile(db, { fx, threadRunning: () => false, match: () => [] }, boot);
    expect(callIsLive(db, boot + 30_000)).toBe(true);
    expect(touchSession(db, back.callId, fx, boot + 40_000)).toBe("live");
    expect(sweepSessions(db, fx, boot + 61_000)).toEqual([gone.callId]);
    expect(getSession(db, back.callId)!.endedAt).toBeNull();
  });
});
