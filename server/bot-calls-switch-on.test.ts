// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BOT-CALLS-UNREACHABLE (1.0.14, MurageMain 11-02): bot calls can be switched on from the app. Bot settings > Voice &
// alerts > Calls writes PUT /api/bots/:id/calls/rules with { enabled } and { neededNow } (design BOT-CALLS-109 3: the
// switch is off until the owner turns it on, and disabled with no voice). "Call me when this finishes" never touches that
// switch: its one-time rule rings while the switch is off and no other rule wakes (MurageMain 11-02, GrokBuild r1 #2).
// needs_owner_now is offered on a turn only while the switch is on AND the urgent rule is on.
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { initializeMessageTables } from "./message-tables.ts";
import { PushStore, initializeMobilePush } from "./mobile-push-store.ts";
import { PushOutbox, type OutboxWorld } from "./mobile-push-outbox.ts";
import { botCallsEnabled, fenceRestoredBotCalls, initializeBotCalls, insertCallRule, listCallRules, setBotCallsEnabled, setCallsOffUntil, setNeedsOwnerNowRule } from "./bot-calls-schema.ts";
import { admitIntent, drainOwed, getIntent, settleTurnOwed } from "./bot-calls-machine.ts";
import { createBotCallsRuntime, matchTurnOwed } from "./bot-calls-runtime.ts";
import { needsOwnerNowOffered } from "./bot-calls-facts.ts";
import { evaluate, type DecideWorld } from "./bot-calls-policy.ts";
import { issueRestoreGeneration } from "./send-store.ts";
import { createCallTickets, handleCallsRoute, type CallsRouteDeps } from "./bot-calls-routes.ts";

const T0 = 1_800_000_000_000;
const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

function setup(o: { voice?: boolean; running?: { turnId: string; botId: string } | null } = {}) {
  const db = new DatabaseSync(":memory:"); dbs.push(db);
  initializeMessageTables(db); initializeMobilePush(db); initializeBotCalls(db);
  const now = T0;
  let voice = o.voice ?? true;
  const world: OutboxWorld = {
    visible: () => true, present: () => false, badge: () => 0, latestMessageId: () => undefined, stillPending: () => true,
    risk: () => "low", timeSensitive: () => false, actionable: () => true, callRinging: () => false,
  };
  const outbox = new PushOutbox({ store: new PushStore(db), world, sender: { publish: async () => "accepted" }, now: () => now, randomRef: () => "0".repeat(64) });
  const runtime = createBotCallsRuntime({
    db: () => db, outbox, card: () => {}, hint: () => {},
    world: { quietHours: () => false, voiceReady: () => voice, ringingDevice: () => true, factValid: () => true, calendar: async () => "free" },
    threadRunning: () => false, senderOf: () => null, startOutbox: () => {}, now: () => now,
  });
  const deps: CallsRouteDeps = {
    db: () => db, runtime, tickets: createCallTickets(), caller: () => "desktop", visible: (id) => id === "t1",
    bot: (id) => id === "scout" ? { id, name: "Scout" } : null, opener: () => "", quietHours: () => null, voiceReady: () => voice,
    setRingsForCalls: () => true, readBody: async () => ({}), now: () => now, runningTurn: () => o.running === undefined ? { turnId: "turn-1", botId: "scout" } : o.running,
  };
  const call = (method: string, path: string, body: unknown = {}) => handleCallsRoute(method, path, new URL(`http://x${path}`), { ...deps, readBody: async () => body });
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return { db, runtime, call, count, now: () => now, setVoice: (v: boolean) => { voice = v; } };
}
const RULES = "/api/bots/scout/calls/rules";

describe("needs_owner_now is offered per state (design 5.10)", () => {
  it("off by default; needs the switch AND an enabled urgent rule; off again when either goes", () => {
    const t = setup();
    expect(needsOwnerNowOffered(t.db, "scout")).toBe(false); // a new bot: nothing on
    setNeedsOwnerNowRule(t.db, "scout", true, t.now());
    expect(needsOwnerNowOffered(t.db, "scout")).toBe(false); // rule only
    setBotCallsEnabled(t.db, "scout", true);
    expect(needsOwnerNowOffered(t.db, "scout")).toBe(true); // both
    setNeedsOwnerNowRule(t.db, "scout", false, t.now());
    expect(needsOwnerNowOffered(t.db, "scout")).toBe(false); // switch only
    setNeedsOwnerNowRule(t.db, "scout", true, t.now());
    setBotCallsEnabled(t.db, "scout", false);
    expect(needsOwnerNowOffered(t.db, "scout")).toBe(false);
    expect(needsOwnerNowOffered(t.db, "other")).toBe(false); // per bot
  });
  it("a turn_end mark alone never offers the tool", () => {
    const t = setup();
    setBotCallsEnabled(t.db, "scout", true);
    insertCallRule(t.db, { botId: "scout", kind: "turn_end", params: { threadId: "t1", turnId: "turn-1" }, how: "ring" }, t.now());
    expect(needsOwnerNowOffered(t.db, "scout")).toBe(false);
  });
  it("the harness reads it from the shared helper when it launches the tool server", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(index).toMatch(/needsOwnerNowOfferedFor\(database\(\), botId\)/);
    expect(index).toMatch(/needsOwnerNowOffered\(botId\) \? \{ MURAGE_NEEDS_OWNER_NOW: "1" \}/);
  });
});

describe("Bot settings Calls switch: PUT /api/bots/:id/calls/rules", () => {
  it("switching on with neededNow makes the urgent rule (message first, 10 min, no Emergency) and offers the tool", async () => {
    const t = setup();
    expect(await t.call("GET", RULES)).toMatchObject({ status: 200, body: { enabled: false, rules: [], voice: true } });
    const on = await t.call("PUT", RULES, { enabled: true, neededNow: true });
    expect(on).toMatchObject({ status: 200, body: { enabled: true, rules: [{ kind: "needs_owner_now", tier: "B", how: "text_first", waitMin: 10, enabled: true, emergency: false }] } });
    expect(needsOwnerNowOffered(t.db, "scout")).toBe(true);
    // a second on never makes a second rule
    await t.call("PUT", RULES, { enabled: true, neededNow: true });
    expect(t.count("SELECT COUNT(*) AS n FROM bot_call_rules WHERE kind='needs_owner_now'")).toBe(1);
  });
  it("neededNow writes only the urgent rule: a turn mark made meanwhile is kept", async () => {
    const t = setup();
    await t.call("PUT", RULES, { enabled: true, neededNow: true });
    const mark = await t.call("POST", "/api/calls/turn-end", { threadId: "t1" });
    expect(mark).toMatchObject({ status: 200 });
    await t.call("PUT", RULES, { neededNow: false });
    await t.call("PUT", RULES, { neededNow: true });
    expect(listCallRules(t.db, "scout").map((r) => r.kind).sort()).toEqual(["needs_owner_now", "turn_end"]);
    expect(t.count("SELECT COUNT(*) AS n FROM bot_call_rules WHERE kind='needs_owner_now'")).toBe(1);
  });
  it("neededNow false switches the rule off (kept, not deleted) and cancels its open call", async () => {
    const t = setup();
    t.runtime.boot();
    await t.call("PUT", RULES, { enabled: true, neededNow: true });
    const rule = listCallRules(t.db, "scout")[0];
    const id = admitIntent(t.db, { botId: "scout", ruleId: rule.id, threadId: "t1", factKind: "routine.needs_owner_now", factKey: "run:r1", factAt: t.now() }, t.now())!;
    expect(id).toBeTruthy();
    const off = await t.call("PUT", RULES, { neededNow: false });
    expect(off).toMatchObject({ status: 200, body: { enabled: true, rules: [{ id: rule.id, enabled: false }] } });
    expect(getIntent(t.db, id)).toMatchObject({ state: "done", outcome: "cancelled" });
    expect(needsOwnerNowOffered(t.db, "scout")).toBe(false);
    t.runtime.stop();
  });
  it("with no voice the switch cannot be turned on and nothing is written; turning off still works", async () => {
    const t = setup({ voice: false });
    expect(await t.call("PUT", RULES, { enabled: true, neededNow: true })).toEqual({ status: 409, body: { error: "no_voice" } });
    expect(botCallsEnabled(t.db, "scout")).toBe(false);
    expect(t.count("SELECT COUNT(*) AS n FROM bot_call_rules")).toBe(0);
    setBotCallsEnabled(t.db, "scout", true);
    expect(await t.call("PUT", RULES, { enabled: false })).toMatchObject({ status: 200, body: { enabled: false } });
  });
  it("bad bodies are 400 and write nothing", async () => {
    const t = setup();
    expect(await t.call("PUT", RULES, { neededNow: "yes" })).toMatchObject({ status: 400 });
    expect(await t.call("PUT", RULES, { neededNow: true, rules: [] })).toMatchObject({ status: 400 });
    expect(t.count("SELECT COUNT(*) AS n FROM bot_call_rules")).toBe(0);
    expect(botCallsEnabled(t.db, "scout")).toBe(false);
  });
  it("during a restore the urgent rule is born held (5.9, F61)", async () => {
    const t = setup();
    issueRestoreGeneration(t.db, "gen-1");
    fenceRestoredBotCalls(t.db, "gen-1", t.now());
    const on = await t.call("PUT", RULES, { enabled: true, neededNow: true });
    expect(on).toMatchObject({ status: 200, body: { held: true, rules: [{ kind: "needs_owner_now", restoreHeld: true }] } });
  });
});

describe("Call me when this finishes rings once with the switch off and never touches it (MurageMain 11-02, GrokBuild r1 #2)", () => {
  const world: DecideWorld = { quietHours: () => false, voiceReady: () => true, ringingDevice: () => true, factValid: () => true, calendar: async () => "free", bootAt: T0 - 3600_000 };
  it("switch off: the tap marks the turn, the switch stays off, and the bot gains no tool", async () => {
    const t = setup();
    const r = await t.call("POST", "/api/calls/turn-end", { threadId: "t1" });
    expect(r).toEqual({ status: 200, body: { ruleId: expect.any(String), turnId: "turn-1" } });
    expect(botCallsEnabled(t.db, "scout")).toBe(false);
    expect(t.db.prepare("SELECT at, armed FROM bot_call_owed WHERE fact_key='turn:turn-1'").get()).toEqual({ at: null, armed: 1 });
    expect(needsOwnerNowOffered(t.db, "scout")).toBe(false);
    // an old client's enableCalls is ignored: it never turns the switch on
    expect(await t.call("POST", "/api/calls/turn-end", { threadId: "t1", enableCalls: true })).toEqual(r);
    expect(botCallsEnabled(t.db, "scout")).toBe(false);
    expect(listCallRules(t.db, "scout").map((x) => x.kind)).toEqual(["turn_end"]);
  });
  it("the one-time rule rings with the switch off; no other rule wakes", async () => {
    const t = setup();
    // the owner had the switch on, made the urgent rule and a ringing watch rule, then turned the switch off
    await t.call("PUT", RULES, { enabled: true, neededNow: true });
    const watch = insertCallRule(t.db, { botId: "scout", kind: "watch", params: { watchId: "w1" }, how: "ring", enabled: true }, t.now());
    await t.call("PUT", RULES, { enabled: false });
    expect(botCallsEnabled(t.db, "scout")).toBe(false);
    const mark = await t.call("POST", "/api/calls/turn-end", { threadId: "t1" });
    const turnRule = (mark!.body as { ruleId: string }).ruleId;
    expect(botCallsEnabled(t.db, "scout")).toBe(false);
    const urgentRule = listCallRules(t.db, "scout").find((x) => x.kind === "needs_owner_now")!.id;
    const admit = (ruleId: string, factKind: "turn.ended" | "routine.needs_owner_now" | "watch.changed", factKey: string) =>
      getIntent(t.db, admitIntent(t.db, { botId: "scout", ruleId, threadId: "t1", factKind, factKey, factAt: t.now() }, t.now())!)!;
    expect(evaluate(t.db, admit(turnRule, "turn.ended", "turn:turn-1"), "initial", world, t.now())).toMatchObject({ ring: true });
    expect(evaluate(t.db, admit(urgentRule, "routine.needs_owner_now", "run:r1"), "initial", world, t.now()))
      .toEqual({ final: expect.objectContaining({ to: "done", steps: expect.arrayContaining([{ check: "bot", result: "off" }]) }) });
    expect(evaluate(t.db, admit(watch, "watch.changed", "w1:1"), "initial", world, t.now()))
      .toEqual({ final: expect.objectContaining({ to: "done", steps: expect.arrayContaining([{ check: "bot", result: "off" }]) }) });
    // a standing turn_end rule (no turnId, made through the rule list) is not the owner's one-time tap: it needs the switch
    const standing = insertCallRule(t.db, { botId: "scout", kind: "turn_end", params: { threadId: "t1" }, how: "ring", enabled: true }, t.now());
    expect(evaluate(t.db, admit(standing, "turn.ended", "turn:turn-2"), "initial", world, t.now()))
      .toEqual({ final: expect.objectContaining({ to: "done", steps: expect.arrayContaining([{ check: "bot", result: "off" }]) }) });
    expect(needsOwnerNowOffered(t.db, "scout")).toBe(false);
  });
  it("every refusal writes nothing: no voice, Calls off for today, no running turn, a hidden conversation", async () => {
    const noVoice = setup({ voice: false });
    expect(await noVoice.call("POST", "/api/calls/turn-end", { threadId: "t1" })).toEqual({ status: 409, body: { error: "no_voice" } });
    expect(noVoice.count("SELECT COUNT(*) AS n FROM bot_call_rules")).toBe(0);

    const offToday = setup();
    setCallsOffUntil(offToday.db, offToday.now() + 3600_000);
    expect(await offToday.call("POST", "/api/calls/turn-end", { threadId: "t1" })).toEqual({ status: 409, body: { error: "calls_off_today", code: "calls_off_today" } });
    expect(offToday.count("SELECT COUNT(*) AS n FROM bot_call_rules")).toBe(0);

    const idle = setup({ running: null });
    expect(await idle.call("POST", "/api/calls/turn-end", { threadId: "t1" })).toEqual({ status: 409, body: { error: "not_running" } });

    const t = setup();
    expect((await t.call("POST", "/api/calls/turn-end", { threadId: "hidden" }))!.status).toBe(404);
    for (const x of [noVoice, offToday, idle, t]) expect(botCallsEnabled(x.db, "scout")).toBe(false);
    expect(t.count("SELECT COUNT(*) AS n FROM bot_call_rules")).toBe(0);
  });
});

describe("switch off is a newer don't call me: it removes the bot's pending one-turn marks (MurageMain 11-02, Astra r2 #1)", () => {
  const world: DecideWorld = { quietHours: () => false, voiceReady: () => true, ringingDevice: () => true, factValid: () => true, calendar: async () => "free", bootAt: T0 - 3600_000 };
  const marks = (t: ReturnType<typeof setup>) => t.count("SELECT COUNT(*) AS n FROM bot_call_rules WHERE kind='turn_end'");
  const owed = (t: ReturnType<typeof setup>) => t.count("SELECT COUNT(*) AS n FROM bot_call_owed WHERE kind='turn'");
  const intents = (t: ReturnType<typeof setup>) => t.count("SELECT COUNT(*) AS n FROM bot_calls");
  const finish = (t: ReturnType<typeof setup>) => { settleTurnOwed(t.db, "turn-1", t.now()); return drainOwed(t.db, (row) => matchTurnOwed(t.db, row), t.now()); };

  it("switch off before the call is lined up: the mark and its owed row go, and the turn's end admits nothing", async () => {
    const t = setup();
    await t.call("PUT", RULES, { enabled: true });
    await t.call("POST", "/api/calls/turn-end", { threadId: "t1" });
    // a standing turn_end rule (no turnId) is the owner's rule list, not a tap: switch off keeps it
    insertCallRule(t.db, { botId: "scout", kind: "turn_end", params: { threadId: "t1" }, how: "ring", enabled: true }, t.now());
    expect([marks(t), owed(t)]).toEqual([2, 1]);
    await t.call("PUT", RULES, { enabled: false });
    expect([marks(t), owed(t)]).toEqual([1, 0]);
    expect(listCallRules(t.db, "scout").map((r) => r.params)).toEqual([{ threadId: "t1" }]);
    expect(settleTurnOwed(t.db, "turn-1", t.now())).toBe(false);
    expect(finish(t)).toEqual([]);
    expect(intents(t)).toBe(0);
  });
  it("switch off after the call is lined up: the intent is cancelled and the mark goes", async () => {
    const t = setup();
    await t.call("PUT", RULES, { enabled: true });
    await t.call("POST", "/api/calls/turn-end", { threadId: "t1" });
    const [id] = finish(t);
    expect(getIntent(t.db, id)!.state).not.toBe("done");
    await t.call("PUT", RULES, { enabled: false });
    expect(getIntent(t.db, id)).toMatchObject({ state: "done", outcome: "cancelled" });
    expect([marks(t), owed(t)]).toEqual([0, 0]);
  });
  it("switch off, then a new tap: a fresh mark that rings with the switch off", async () => {
    const t = setup();
    await t.call("PUT", RULES, { enabled: true });
    const first = (await t.call("POST", "/api/calls/turn-end", { threadId: "t1" }))!.body as { ruleId: string };
    await t.call("PUT", RULES, { enabled: false });
    const again = await t.call("POST", "/api/calls/turn-end", { threadId: "t1" });
    const second = (again!.body as { ruleId: string }).ruleId;
    expect(again!.status).toBe(200);
    expect(second).not.toBe(first.ruleId);
    expect(t.db.prepare("SELECT at, armed FROM bot_call_owed WHERE fact_key='turn:turn-1'").get()).toEqual({ at: null, armed: 1 });
    const [id] = finish(t);
    expect(getIntent(t.db, id)!.ruleId).toBe(second);
    expect(botCallsEnabled(t.db, "scout")).toBe(false);
    expect(evaluate(t.db, getIntent(t.db, id)!, "initial", world, t.now())).toMatchObject({ ring: true });
  });
  it("switch already off at the tap: a later off write changes nothing and the call rings", async () => {
    const t = setup();
    expect(botCallsEnabled(t.db, "scout")).toBe(false);
    await t.call("POST", "/api/calls/turn-end", { threadId: "t1" });
    await t.call("PUT", RULES, { enabled: false });
    expect([marks(t), owed(t)]).toEqual([1, 1]);
    const [id] = finish(t);
    expect(id).toEqual(expect.any(String));
    expect(evaluate(t.db, getIntent(t.db, id)!, "initial", world, t.now())).toMatchObject({ ring: true });
  });
});

describe("the urgent rule's open Mediums (GrokBuild r1)", () => {
  it("turning it on with no voice is 409 no_voice and writes nothing, even with the switch already on", async () => {
    const t = setup({ voice: false });
    expect(await t.call("PUT", RULES, { neededNow: true })).toEqual({ status: 409, body: { error: "no_voice" } });
    setBotCallsEnabled(t.db, "scout", true);
    expect(await t.call("PUT", RULES, { neededNow: true })).toEqual({ status: 409, body: { error: "no_voice" } });
    expect(t.count("SELECT COUNT(*) AS n FROM bot_call_rules")).toBe(0);
  });
  it("turning it on lifts an earlier Don't call me about this again; until then the app shows it off", async () => {
    const t = setup();
    await t.call("PUT", RULES, { enabled: true, neededNow: true });
    const rule = listCallRules(t.db, "scout")[0];
    t.db.prepare("UPDATE bot_call_rules SET demoted=1 WHERE id=?").run(rule.id);
    // the app reads enabled && !demoted (src/lib/bot-calls.ts neededNowOn), so it shows off here
    expect(listCallRules(t.db, "scout")[0]).toMatchObject({ enabled: true, demoted: true });
    const on = await t.call("PUT", RULES, { neededNow: true });
    expect(on).toMatchObject({ status: 200, body: { rules: [{ id: rule.id, enabled: true, demoted: false }] } });
    expect(listCallRules(t.db, "scout")[0]).toMatchObject({ enabled: true, demoted: false });
    expect(t.count("SELECT COUNT(*) AS n FROM bot_call_rules WHERE kind='needs_owner_now'")).toBe(1);
  });
});

describe("the app uses these routes", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  it("Bot settings writes PUT /api/bots/:id/calls/rules with enabled and neededNow, never the whole rule list", () => {
    const src = read("../src/components/BotCallsSettings.tsx");
    expect(src).toContain("/calls/rules`, { method: \"PUT\"");
    expect(src).toMatch(/neededNow: !urgent/);
    expect(src).not.toMatch(/rules: \[/);
    expect(read("../src/components/SettingsPanel.tsx")).toMatch(/<BotCallsSettings key=\{`calls-\$\{bot\.id\}`\} botId=\{bot\.id\} botName=\{bot\.name\} \/>/);
  });
  it("Call me when this finishes sends only the conversation, never a switch change", () => {
    const button = read("../src/components/CallMeWhenDone.tsx");
    expect(button).toContain("JSON.stringify({ threadId })");
    expect(button).not.toContain("enableCalls");
    expect(button).not.toContain("callsTurnedOn");
  });
});
