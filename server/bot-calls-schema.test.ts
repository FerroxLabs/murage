// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot calls phase 1 (design BOT-CALLS-109 rev 4.2): the tables of 5.1, the rule writes and the restore fence of 5.9,
// with failure rows F6, F37, F39, F50, F55, F61 and F62.
import { afterCommit, onRollback } from "./tx-scope.ts";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initializeMessageTables } from "./message-tables.ts";
import { initializeMobilePush } from "./mobile-push-store.ts";
import { currentRestoreGeneration, issueRestoreGeneration } from "./send-store.ts";
import { fenceRestoredSql, RESTORE_FENCED_STORES } from "./restore-fence.ts";
import {
  BOT_CALLS_FENCE_PROOFS, CallRuleInputError, botCallsEnabled, callRulesHold, callsOffActive, callsOffUntil, deleteBotCallSettings, downgradeBotCallsTo108,
  fenceRestoredBotCalls, inTransaction, initializeBotCalls, insertCallRule, listCallRules, newestRestoreGeneration, pruneBotCalls, putCallRules, rearmCallRules,
  setBotCallsEnabled, setCallsOffUntil, tierOfKind, type CallRuleInput,
} from "./bot-calls-schema.ts";

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function fresh(): DatabaseSync {
  const db = new DatabaseSync(":memory:"); dbs.push(db);
  initializeMessageTables(db); initializeMobilePush(db); initializeBotCalls(db);
  return db;
}
const count = (db: DatabaseSync, sql: string, ...args: Array<string | number>) => Number((db.prepare(sql).get(...args) as { n: number }).n);
const sender = (threadId: string, extra: Partial<CallRuleInput> = {}): CallRuleInput => ({ kind: "sender", params: { threadId, senderIds: ["u1"] }, how: "ring", enabled: true, emergency: false, ...extra });
const timed: CallRuleInput = { kind: "timed", params: { routineId: "r1" }, how: "ring", enabled: true, emergency: false };
const problem: CallRuleInput = { kind: "routine_problem", params: {}, how: "text_first", waitMin: 10, enabled: true, emergency: false };
const rawInsert = (db: DatabaseSync, id: string, kind: string, emergency: number) =>
  db.prepare("INSERT INTO bot_call_rules (id,bot_id,position,kind,params,how,wait_min,emergency,created_at,updated_at) VALUES (?,?,0,?,'{}','text_first',10,?,1,1)").run(id, "bot", kind, emergency);
const holds = (db: DatabaseSync) => db.prepare("SELECT id, restore_held AS held, restore_gen AS gen FROM bot_call_rules ORDER BY id").all() as Array<{ id: string; held: number; gen: string | null }>;

describe("tables (5.1)", () => {
  it("runs on SQLite 3.31 or later and the generated column derives the tier from the kind", () => {
    const db = fresh();
    const version = String((db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v).split(".").map(Number);
    expect(version[0]! > 3 || (version[0] === 3 && version[1]! >= 31)).toBe(true);
    rawInsert(db, "a", "watch", 0);
    rawInsert(db, "b", "needs_owner_now", 0);
    expect(db.prepare("SELECT id, tier FROM bot_call_rules ORDER BY id").all()).toEqual([{ id: "a", tier: "A" }, { id: "b", tier: "B" }]);
    expect(() => db.prepare("UPDATE bot_call_rules SET tier='A' WHERE id='b'").run()).toThrow();
    expect(tierOfKind("turn_end")).toBe("A");
    expect(tierOfKind("routine_problem")).toBe("B");
    // every index and the trigger of the design exist
    const names = (db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'bot_call%'").all() as Array<{ name: string }>).map(r => r.name);
    expect(names).toEqual(expect.arrayContaining(["bot_call_rules_bot", "bot_calls_fact", "bot_calls_one_active", "bot_calls_open", "bot_calls_rule_created", "bot_calls_rule_rang",
      "bot_calls_bot_rang", "bot_calls_rang", "bot_calls_history", "bot_call_sessions_live", "bot_call_owed_at", "bot_call_owed_msg", "bot_call_watch_threads", "bot_call_settings"]));
    initializeBotCalls(db);   // idempotent
  });

  it("F50/F62: the CHECK on kind refuses Emergency on a Tier B kind from direct SQL; a client tier is never read", () => {
    const db = fresh();
    expect(() => rawInsert(db, "x", "needs_owner_now", 1)).toThrow(/CHECK/);
    expect(() => rawInsert(db, "y", "routine_problem", 1)).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO bot_call_rules (id,bot_id,position,kind,tier,params,how,created_at,updated_at) VALUES ('z','bot',0,'needs_owner_now','A','{}','text_first',1,1)").run()).toThrow();
    // the helper: 400 for Emergency on Tier B, and tier from input is ignored
    const tierB = { kind: "needs_owner_now", tier: "A", params: {}, how: "text_first", waitMin: 10, emergency: true } as CallRuleInput;
    expect(() => insertCallRule(db, { ...tierB, botId: "bot" }, 1)).toThrow(CallRuleInputError);
    expect(() => putCallRules(db, "bot", [tierB], 1)).toThrow(expect.objectContaining({ status: 400, code: "emergency_tier_b" }));
    const id = insertCallRule(db, { ...tierB, emergency: false, botId: "bot" }, 1);
    expect(db.prepare("SELECT tier FROM bot_call_rules WHERE id=?").get(id)).toEqual({ tier: "B" });
    expect(count(db, "SELECT COUNT(*) AS n FROM bot_call_rules")).toBe(1);
  });

  it("validates the closed lists", () => {
    const db = fresh();
    const bad: CallRuleInput[] = [
      { ...timed, kind: "dance" },
      { ...timed, how: "shout" },
      { ...problem, how: "ring", waitMin: undefined },
      { ...problem, waitMin: 20 },
      { ...timed, waitMin: 10 },
      { ...timed, label: "x".repeat(61) },
      { ...timed, params: [] },
      { ...timed, params: { routineId: "r1", extra: 1 } },
      { ...timed, params: {} },
      sender("t1", { params: { threadId: "t1", senderIds: [] } }),
    ];
    for (const input of bad) expect(() => putCallRules(db, "bot", [input], 1), JSON.stringify(input)).toThrow(CallRuleInputError);
    expect(count(db, "SELECT COUNT(*) AS n FROM bot_call_rules")).toBe(0);
    const rules = putCallRules(db, "bot", [{ ...timed, label: "y".repeat(60) }, { ...problem, waitMin: 60 }], 1);
    expect(rules.map(r => [r.kind, r.tier, r.waitMin])).toEqual([["timed", "A", null], ["routine_problem", "B", 60]]);
  });
});

describe("rule writes and the restore fence (5.9)", () => {
  it("F55: the PUT upsert keeps restore_held and restore_gen, a replayed PUT changes neither, and a rule left out is deleted", () => {
    const db = fresh();
    const [a, b] = putCallRules(db, "bot", [timed, sender("t1")], 1);
    const generation = issueRestoreGeneration(db, "gen-1");
    fenceRestoredBotCalls(db, generation, 2);
    const body = [{ ...timed, id: a!.id, label: "renamed" }, { ...sender("t1"), id: b!.id, enabled: false }];
    putCallRules(db, "bot", body, 3);
    putCallRules(db, "bot", body, 4);   // replayed
    // input carrying hold columns is not read
    putCallRules(db, "bot", body.map(rule => ({ ...rule, restore_held: 0, restoreHeld: false, restore_gen: null }) as unknown as CallRuleInput), 5);
    expect(holds(db)).toEqual([a!.id, b!.id].sort().map(id => ({ id, held: 1, gen: "gen-1" })));
    expect(listCallRules(db, "bot").map(r => [r.label, r.enabled])).toEqual([["renamed", true], [null, false]]);
    putCallRules(db, "bot", [body[0]!], 6);
    expect(listCallRules(db, "bot").map(r => r.id)).toEqual([a!.id]);
    // another bot's rule id is refused, nothing is written
    expect(() => putCallRules(db, "other", [{ ...timed, id: a!.id }], 7)).toThrow(CallRuleInputError);
    expect(listCallRules(db, "bot")).toHaveLength(1);
  });

  it("F61: a new rule is born held during a restore, and after a restore with no rules at all", () => {
    const db = fresh();
    const kept = insertCallRule(db, { ...timed, botId: "bot" }, 1);
    expect(holds(db)).toEqual([{ id: kept, held: 0, gen: null }]);
    issueRestoreGeneration(db, "gen-1");
    fenceRestoredBotCalls(db, "gen-1", 2);
    const born = insertCallRule(db, { ...sender("t1"), botId: "bot" }, 3);          // "Call me when..." or a call card
    const viaPut = putCallRules(db, "bot", [{ ...timed, id: kept }, { ...sender("t1"), id: born }, { ...problem }], 4).find(r => r.kind === "routine_problem")!;
    for (const id of [born, viaPut.id]) expect(holds(db).find(r => r.id === id)).toEqual({ id, held: 1, gen: "gen-1" });
    // a restore of a copy that held no rules: a new rule is still born held until the owner re-arms
    const empty = fresh();
    issueRestoreGeneration(empty, "gen-9");
    fenceRestoredBotCalls(empty, "gen-9", 1);
    const first = insertCallRule(empty, { ...timed, botId: "bot" }, 2);
    expect(holds(empty)).toEqual([{ id: first, held: 1, gen: "gen-9" }]);
    expect(callRulesHold(empty)).toEqual({ held: true, restoreGen: "gen-9" });
    expect(rearmCallRules(empty, "gen-9", 3)).toEqual({ ok: true, rearmed: 1 });
    const after = insertCallRule(empty, { ...timed, params: { routineId: "r2" }, botId: "bot" }, 4);
    expect(holds(empty).find(r => r.id === after)).toEqual({ id: after, held: 0, gen: null });
    expect(callRulesHold(empty)).toEqual({ held: false, restoreGen: "gen-9" });
  });

  it("F39: a stale re-arm token keeps every hold; the current token clears them", () => {
    const db = fresh();
    putCallRules(db, "bot", [timed, problem], 1);
    issueRestoreGeneration(db, "gen-1"); fenceRestoredBotCalls(db, "gen-1", 2);
    issueRestoreGeneration(db, "gen-2"); fenceRestoredBotCalls(db, "gen-2", 3);
    expect(newestRestoreGeneration(db)).toBe(currentRestoreGeneration(db));
    for (const token of ["gen-1", "", undefined, 7, "gen-3"]) expect(rearmCallRules(db, token, 4)).toEqual({ ok: false, reason: "stale" });
    expect(holds(db).every(r => r.held === 1 && r.gen === "gen-2")).toBe(true);
    expect(rearmCallRules(db, "gen-2", 5)).toEqual({ ok: true, rearmed: 2 });
    expect(holds(db).every(r => r.held === 0 && r.gen === null)).toBe(true);
    // a never-restored installation has no token to re-arm with
    expect(rearmCallRules(fresh(), "gen-2")).toEqual({ ok: false, reason: "stale" });
  });

  it("F37: after the fence every proof counts 0, through fenceRestoredSql and its registry entries", () => {
    const db = fresh();
    const [rule] = putCallRules(db, "bot", [sender("t1")], 1);
    const intent = db.prepare(`INSERT INTO bot_calls (id,bot_id,rule_id,tier,thread_id,fact_kind,fact_key,fact_at,fact_fields,state,active_slot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    intent.run("i1", "bot", rule!.id, "A", "t1", "channel.message", "channel:t1:m1", 1, "{}", "ringing", 1, 1);
    intent.run("i2", "bot", rule!.id, "A", "t1", "channel.message", "channel:t1:m2", 1, "{}", "waiting", null, 1);
    intent.run("i3", "bot", rule!.id, "A", "t1", "channel.message", "channel:t1:m3", 1, "{}", "done", null, 1);
    db.prepare("INSERT INTO bot_call_sessions (id,call_id,bot_id,intent_id,device,opened_at,last_seen_at,backstop_at) VALUES ('s1','c1','bot','i1','phone:p1',1,1,99)").run();
    db.prepare("INSERT INTO bot_call_owed (fact_key,bot_id,kind,thread_id,at) VALUES ('turn:x','bot','turn','t1',NULL)").run();
    const generation = issueRestoreGeneration(db, "gen-1");
    const notes = fenceRestoredSql(db, generation);
    expect(notes.map(n => n.action).join("\n")).toMatch(/bot call\(s\)/);
    const proofs = [...BOT_CALLS_FENCE_PROOFS.calls, ...BOT_CALLS_FENCE_PROOFS.owed, ...BOT_CALLS_FENCE_PROOFS.rules];
    for (const sql of proofs) expect(count(db, sql), sql).toBe(0);
    const registered = RESTORE_FENCED_STORES.filter(entry => entry.tables?.some(table => table.startsWith("bot_call")));
    expect(registered.map(entry => entry.mode).sort()).toEqual(["dropped", "paused", "terminalized"]);
    expect(registered.flatMap(entry => entry.proof ?? []).sort()).toEqual([...proofs].sort());
    expect(db.prepare("SELECT id, state, outcome, active_slot AS slot FROM bot_calls ORDER BY id").all()).toEqual([
      { id: "i1", state: "done", outcome: "restored", slot: null }, { id: "i2", state: "done", outcome: "restored", slot: null }, { id: "i3", state: "done", outcome: null, slot: null }]);
    expect(db.prepare("SELECT ended_by FROM bot_call_sessions").get()).toEqual({ ended_by: "restore" });
    expect(holds(db)).toEqual([{ id: rule!.id, held: 1, gen: "gen-1" }]);
    // an archive from before 1.0.9 has none of the tables: the fence skips them
    const old = new DatabaseSync(":memory:"); dbs.push(old); initializeMessageTables(old);
    expect(() => fenceRestoredSql(old, "gen-1")).not.toThrow();
  });
});

describe("the owed trigger and the watched threads (4.1)", () => {
  const message = (db: DatabaseSync, thread: string, id: string, json: string) =>
    db.prepare("INSERT INTO messages (thread_id,id,at,role,kind,text,json) VALUES (?,?,?,?,?,?,?)").run(thread, id, 1234, "user", "message", "hi", json);

  it("F6: a watched thread's message writes the owed row even with damaged JSON; an unwatched thread writes nothing", () => {
    const db = fresh();
    putCallRules(db, "bot", [sender("t1")], 1);
    message(db, "t1", "m1", "{not json");
    message(db, "t2", "m2", JSON.stringify({ id: "m2" }));
    expect(db.prepare("SELECT * FROM bot_call_owed").all()).toEqual([
      { fact_key: "channel:t1:m1", bot_id: "bot", kind: "channel", thread_id: "t1", source_id: "m1", at: 1234, armed: 0 }]);
    // the same message again changes nothing (INSERT OR IGNORE)
    db.prepare("DELETE FROM messages WHERE id='m1'").run();
    message(db, "t1", "m1", "{}");
    expect(count(db, "SELECT COUNT(*) AS n FROM bot_call_owed")).toBe(1);
  });

  it("is rewritten from the enabled sender rules with every rule write", () => {
    const db = fresh();
    const threads = () => db.prepare("SELECT thread_id AS t, bot_id AS b FROM bot_call_watch_threads ORDER BY thread_id").all();
    putCallRules(db, "bot", [sender("t1"), sender("t2"), sender("t3", { enabled: false }), timed], 1);
    expect(threads()).toEqual([{ t: "t1", b: "bot" }, { t: "t2", b: "bot" }]);
    putCallRules(db, "other", [sender("t2"), sender("t9")], 2);
    expect(threads()).toEqual([{ t: "t1", b: "bot" }, { t: "t2", b: "bot" }, { t: "t9", b: "other" }]);
    // the first bot stops watching t2: the other bot's rule keeps it watched
    const [first] = listCallRules(db, "bot");
    putCallRules(db, "bot", [{ ...sender("t1"), id: first!.id }], 3);
    expect(threads()).toEqual([{ t: "t1", b: "bot" }, { t: "t2", b: "other" }, { t: "t9", b: "other" }]);
    insertCallRule(db, { ...sender("t5"), botId: "bot" }, 4);
    expect(threads()).toContainEqual({ t: "t5", b: "bot" });
    // a failed write rolls back the whole list and the watch rows with it
    expect(() => putCallRules(db, "bot", [sender("t7"), { ...timed, kind: "nope" }], 5)).toThrow();
    expect(threads()).not.toContainEqual({ t: "t7", b: "bot" });
  });
});

describe("settings, retention and the step back", () => {
  it("keeps the bot switch and calls off for today, and forgets a deleted bot", () => {
    const db = fresh();
    expect(botCallsEnabled(db, "bot")).toBe(false);
    setBotCallsEnabled(db, "bot", true);
    expect(botCallsEnabled(db, "bot")).toBe(true);
    setCallsOffUntil(db, 5000);
    expect(callsOffUntil(db)).toBe(5000);
    expect(callsOffActive(db, 4999)).toBe(true);
    expect(callsOffActive(db, 5000)).toBe(false);
    setCallsOffUntil(db, null);
    expect(callsOffUntil(db)).toBeNull();
    deleteBotCallSettings(db, "bot");
    expect(botCallsEnabled(db, "bot")).toBe(false);
  });

  it("prunes done intents after 90 days and sessions a day after they end", () => {
    const db = fresh();
    const now = 200 * 24 * 3600_000;
    const intent = db.prepare("INSERT INTO bot_calls (id,bot_id,rule_id,tier,thread_id,fact_kind,fact_key,fact_at,fact_fields,state,created_at) VALUES (?,'bot','r','A','t','timed',?,1,'{}',?,?)");
    intent.run("old", "k1", "done", now - 91 * 24 * 3600_000);
    intent.run("open", "k2", "waiting", now - 91 * 24 * 3600_000);
    intent.run("recent", "k3", "done", now - 10 * 24 * 3600_000);
    const session = db.prepare("INSERT INTO bot_call_sessions (id,call_id,bot_id,device,opened_at,last_seen_at,backstop_at,ended_at) VALUES (?,?,'bot','desktop:d',1,1,1,?)");
    session.run("s-old", "c1", now - 25 * 3600_000);
    session.run("s-new", "c2", now - 3600_000);
    session.run("s-live", "c3", null);
    expect(pruneBotCalls(db, now)).toEqual({ calls: 1, sessions: 1 });
    expect((db.prepare("SELECT id FROM bot_calls ORDER BY id").all() as Array<{ id: string }>).map(r => r.id)).toEqual(["open", "recent"]);
    expect((db.prepare("SELECT id FROM bot_call_sessions ORDER BY id").all() as Array<{ id: string }>).map(r => r.id)).toEqual(["s-live", "s-new"]);
  });

  it("the step back to 1.0.8 drops the trigger, the tables and rings_for_calls; messages still write", () => {
    const db = fresh();
    putCallRules(db, "bot", [sender("t1")], 1);
    expect(downgradeBotCallsTo108(db).dropped).toBe(8);
    expect(count(db, "SELECT COUNT(*) AS n FROM sqlite_schema WHERE name LIKE 'bot_call%'")).toBe(0);
    expect((db.prepare("PRAGMA table_info(push_bindings)").all() as Array<{ name: string }>).map(c => c.name)).not.toContain("rings_for_calls");
    db.prepare("INSERT INTO messages (thread_id,id,at,role,kind,text,json) VALUES ('t1','m1',1,'user','message','hi','{}')").run();
    expect(downgradeBotCallsTo108(db)).toEqual({ dropped: 0 });
  });
});

describe("transition transactions carry a tx-scope frame (phase 4: CallEffects.card inside the transaction)", () => {
  it("a store effect registered in a transition runs only after the outermost commit, and a rollback runs the cache hooks instead", () => {
    const db = fresh();
    const seen: string[] = [];
    inTransaction(db, () => {
      afterCommit(() => seen.push(`emit:${db.isTransaction}`));
      inTransaction(db, () => { afterCommit(() => seen.push("inner-emit")); });
      expect(seen).toEqual([]);
    });
    expect(seen).toEqual(["emit:false", "inner-emit"]);
    seen.length = 0;
    expect(() => inTransaction(db, () => {
      afterCommit(() => seen.push("emit"));
      onRollback(() => seen.push("rollback"));
      throw new Error("boom");
    })).toThrow("boom");
    expect(seen).toEqual(["rollback"]);
    expect(db.isTransaction).toBe(false);
  });
});
