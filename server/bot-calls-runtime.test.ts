// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot calls phase 4c (design BOT-CALLS-109 rev 4.2, 5.2, 5.5, 5.8): the harness wiring. CallEffects backed by the real push
// outbox on the machine's own connection, the dispatch fence's callRinging (without it no ring is ever sent), boot
// reconcile before the outbox starts, sendNow after commit, the card inside the transition, and the call routes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initializeMessageTables } from "./message-tables.ts";
import { PushStore, initializeMobilePush } from "./mobile-push-store.ts";
import { PushOutbox, type OutboxWorld, type SendResult } from "./mobile-push-outbox.ts";
import { callsOffUntil, initializeBotCalls, insertCallRule, setBotCallsEnabled, setCallsOffUntil, type CallRuleInput } from "./bot-calls-schema.ts";
import { admitIntent, getIntent, type CallIntent } from "./bot-calls-machine.ts";
import { createBotCallsRuntime, matchTurnOwed } from "./bot-calls-runtime.ts";
import { createCallTickets, handleCallsRoute, liveFrame, nextLocalMidnight, type CallsRouteDeps } from "./bot-calls-routes.ts";
import { routeAdmits, routeClass, routePolicy } from "./route-policy.ts";
import { callCardRow, callOpener } from "./bot-calls-card.ts";

const B1 = "3f6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3";
const T0 = 1_800_000_000_000;
const RING: CallRuleInput = { kind: "watch", params: { watchId: "w" }, how: "ring" };
const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); vi.useRealTimers(); });

function setup(o: { card?: (intent: CallIntent) => void; world?: Partial<OutboxWorld> } = {}) {
  const db = new DatabaseSync(":memory:"); dbs.push(db);
  initializeMessageTables(db); initializeMobilePush(db); initializeBotCalls(db);
  setBotCallsEnabled(db, "scout", true);
  const store = new PushStore(db);
  store.putBinding({ bindingId: B1, deviceId: "d1", publisherToken: "murage_pt_1", createdAt: 1 });
  let now = T0;
  let refs = 0;
  const publish = vi.fn(async (): Promise<SendResult> => "accepted");
  const order: string[] = [];
  // eslint-disable-next-line prefer-const
  let runtime: ReturnType<typeof createBotCallsRuntime>;
  const world: OutboxWorld = {
    visible: () => true, present: () => false, badge: () => 0, latestMessageId: () => undefined,
    stillPending: (_t, r) => runtime.owns(r) ? runtime.stillPending(r) : true, risk: () => "low", timeSensitive: () => false, actionable: () => true,
    callRinging: (id) => runtime.callRinging(id), ...o.world,
  };
  const outbox = new PushOutbox({ store, world, sender: { publish }, now: () => now, randomRef: () => (++refs).toString(16).padStart(64, "0") });
  const sendNow = vi.spyOn(outbox, "sendNow");
  const cards: CallIntent[] = [];
  const hints: unknown[] = [];
  runtime = createBotCallsRuntime({
    db: () => db, outbox,
    card: o.card ?? ((intent) => { cards.push(intent); }),
    world: { quietHours: () => false, voiceReady: () => true, ringingDevice: () => true, factValid: () => true, calendar: async () => "free" },
    hint: (h) => { hints.push(h); },
    threadRunning: () => false, senderOf: () => null,
    startOutbox: () => { order.push("outbox"); },
    now: () => now,
  });
  const intent = (key = "k1") => admitIntent(db, { botId: "scout", ruleId: insertCallRule(db, { ...RING, botId: "scout" }, now), threadId: "t1", factKind: "watch.changed", factKey: key, factAt: now }, now)!;
  const settle = () => new Promise<void>((r) => setImmediate(r));
  return { db, store, outbox, publish, sendNow, runtime, order, cards, hints, intent, settle, tick: (ms: number) => { now += ms; }, now: () => now };
}
const rows = (db: DatabaseSync) => db.prepare("SELECT kind, category, state, attempts, request_id AS requestId FROM push_events ORDER BY rowid").all() as Array<Record<string, unknown>>;

describe("boot (5.8) before the outbox (5.5)", () => {
  it("ends a ring of the previous process (T7b) before the outbox starts, and sends nothing before boot", async () => {
    const t = setup();
    const id = t.intent();
    t.db.prepare("UPDATE bot_calls SET state='ringing', active_slot=1, rang_at=?, deadline_at=? WHERE id=?").run(t.now(), t.now() + 30_000, id);
    t.runtime.admitted(id);
    expect(t.runtime.callRinging(id)).toBe(false); // not ready: fenced
    expect(t.sendNow).not.toHaveBeenCalled();
    t.runtime.boot();
    expect(getIntent(t.db, id)).toMatchObject({ state: "done", outcome: "missed" });
    expect(t.order).toEqual(["outbox"]);
    expect(t.runtime.ready()).toBe(true);
    expect(t.sendNow).toHaveBeenCalledWith(id);
    t.runtime.stop();
  });
  it("a reconcile that throws still starts the outbox for other kinds, and calls stay fenced", () => {
    const t = setup();
    const id = t.intent();
    t.db.prepare("UPDATE bot_calls SET state='ringing', active_slot=1, rang_at=?, deadline_at=? WHERE id=?").run(t.now(), t.now() + 30_000, id);
    t.db.exec("DROP TABLE bot_call_owed");
    t.runtime.boot();
    expect(t.order).toEqual(["outbox"]);
    expect(t.runtime.ready()).toBe(false);
    expect(t.runtime.callRinging(id)).toBe(false);
  });
});

describe("CallEffects on the outbox, the fence and sendNow", () => {
  it("decide(initial) rings: one call row, sent right after commit, exactly once; the fence passes only while ringing", async () => {
    const t = setup();
    t.runtime.boot();
    const id = t.intent();
    t.runtime.admitted(id);
    await t.settle(); await t.settle();
    expect(getIntent(t.db, id)!.state).toBe("ringing");
    expect(t.runtime.callRinging(id)).toBe(true);
    expect(t.sendNow).toHaveBeenCalledWith(id);
    await t.settle();
    expect(t.publish).toHaveBeenCalledTimes(1);
    expect(rows(t.db)).toEqual([expect.objectContaining({ kind: "call", category: "call", state: "sent", attempts: 1, requestId: id })]);
    expect(t.hints).toContainEqual(expect.objectContaining({ type: "call.ring", intentId: id }));
    await t.outbox.flush();
    expect(t.publish).toHaveBeenCalledTimes(1);
    t.tick(46_000);
    expect(t.runtime.callRinging(id)).toBe(false);
    t.runtime.stop();
  });
  it("without callRinging in the outbox world no ring is ever sent (fail closed)", async () => {
    const t = setup({ world: { callRinging: undefined } });
    t.runtime.boot();
    const id = t.intent();
    t.runtime.admitted(id);
    await t.settle(); await t.settle(); await t.settle();
    expect(getIntent(t.db, id)!.state).toBe("ringing");
    expect(t.publish).not.toHaveBeenCalled();
    expect(rows(t.db)[0]).toMatchObject({ kind: "call", state: "dropped" });
    t.runtime.stop();
  });
  it("decline resolves the ring (a resolved revision for the phone that may have rung) and writes the card in the transition", async () => {
    const t = setup();
    t.runtime.boot();
    const id = t.intent();
    t.runtime.admitted(id);
    await t.settle(); await t.settle(); await t.settle();
    expect(t.runtime.decline(id, "declined")).toBe(true);
    expect(getIntent(t.db, id)).toMatchObject({ state: "done", outcome: "declined" });
    expect(t.cards.at(-1)).toMatchObject({ id, outcome: "declined" });
    expect(rows(t.db).map((r) => r.category)).toEqual(["call", "resolved"]);
    expect(t.runtime.stillPending(id)).toBe(true); // a declined call's note stays until seen
    t.runtime.stop();
  });
  it("a card write that throws rolls the whole transition back (5.2)", async () => {
    const t = setup({ card: () => { throw new Error("disk full"); } });
    t.runtime.boot();
    const id = t.intent();
    t.runtime.admitted(id);
    await t.settle(); await t.settle(); await t.settle();
    expect(() => t.runtime.decline(id, "declined")).toThrow("disk full");
    expect(getIntent(t.db, id)!.state).toBe("ringing");
    expect(rows(t.db).map((r) => r.category)).toEqual(["call"]);
    t.runtime.stop();
  });
  it("the ring timer ends an unanswered ring as missed at its deadline (T7)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const t = setup();
    t.runtime.boot();
    const id = t.intent();
    t.runtime.admitted(id);
    await vi.waitFor(() => expect(getIntent(t.db, id)!.state).toBe("ringing"));
    t.tick(45_000);
    vi.advanceTimersByTime(45_000);
    expect(getIntent(t.db, id)).toMatchObject({ state: "done", outcome: "missed" });
    t.runtime.stop();
  });
});

describe("drain wake and turn settle (4.1)", () => {
  it("a marked turn admits its turn_end rule once it completes", () => {
    const t = setup();
    const ruleId = insertCallRule(t.db, { kind: "turn_end", params: { threadId: "t1", turnId: "turn-1" }, how: "ring", botId: "scout" }, t.now());
    expect(matchTurnOwed(t.db, { factKey: "turn:turn-1", botId: "scout", kind: "turn", threadId: "t1", sourceId: "turn-1", at: t.now(), armed: true }))
      .toEqual([expect.objectContaining({ ruleId, factKind: "turn.ended", factKey: "turn:turn-1" })]);
    expect(matchTurnOwed(t.db, { factKey: "turn:other", botId: "scout", kind: "turn", threadId: "t1", sourceId: "other", at: t.now(), armed: true })).toEqual([]);
  });
});

describe("call routes", () => {
  function routes(t: ReturnType<typeof setup>, visible = true) {
    const deps: CallsRouteDeps = {
      db: () => t.db, runtime: t.runtime, tickets: createCallTickets(), visible: () => visible,
      bot: (id) => id === "scout" ? { id, name: "Scout" } : null, opener: () => "Hi, it's Scout.", quietHours: () => null, voiceReady: () => true,
      setRingsForCalls: () => true, readBody: async () => ({}), now: () => t.now(),
    };
    const call = (method: string, path: string, body: unknown = {}) => handleCallsRoute(method, path, new URL(`http://x${path}`), { ...deps, readBody: async () => body });
    return { call, deps };
  }
  it("answers its own routes only, and the answer flow returns a session; a second device gets 409", async () => {
    const t = setup();
    t.runtime.boot();
    const { call } = routes(t);
    expect(await call("GET", "/api/bots/scout/profile")).toBeNull();
    expect(await call("GET", "/api/health")).toBeNull();
    const id = t.intent();
    t.runtime.admitted(id);
    await t.settle(); await t.settle();
    const active = await call("GET", "/api/calls/active");
    expect(active).toMatchObject({ status: 200, body: { ringing: { intentId: id, botName: "Scout" }, live: [] } });
    const answered = await call("POST", `/api/calls/${id}/answer`, { device: "phone:abc" });
    expect(answered).toMatchObject({ status: 200, body: { threadId: "t1" } });
    expect(await call("POST", `/api/calls/${id}/answer`, { device: "desktop:xyz" })).toMatchObject({ status: 409, body: { error: "answered_elsewhere" } });
    const { callId } = answered!.body as { callId: string };
    expect(await call("POST", `/api/calls/sessions/${callId}/ticket`, { device: "desktop:xyz" })).toMatchObject({ status: 404 });
    expect(await call("POST", `/api/calls/sessions/${callId}/ticket`, { device: "phone:abc" })).toMatchObject({ status: 200, body: { ticket: expect.any(String) } });
    expect(await call("POST", `/api/calls/sessions/${callId}/end`)).toMatchObject({ status: 200, body: { ended: true } });
    expect(getIntent(t.db, id)).toMatchObject({ state: "done", outcome: "answered" });
    t.runtime.stop();
  });
  it("rules: Emergency on a Tier B kind is 400; switching the bot off cancels its calls", async () => {
    const t = setup();
    t.runtime.boot();
    const { call } = routes(t);
    expect(await call("PUT", "/api/bots/scout/calls/rules", { rules: [{ kind: "routine_problem", params: {}, how: "text_first", waitMin: 10, enabled: true, emergency: true }] }))
      .toMatchObject({ status: 400 });
    const id = t.intent();
    t.runtime.admitted(id);
    await t.settle(); await t.settle();
    const off = await call("PUT", "/api/bots/scout/calls/rules", { enabled: false });
    expect(off).toMatchObject({ status: 200, body: { enabled: false } });
    expect(getIntent(t.db, id)).toMatchObject({ state: "done", outcome: "cancelled" });
    expect(await call("GET", "/api/bots/nobody/calls/rules")).toMatchObject({ status: 404 });
    t.runtime.stop();
  });
  it("a call in a conversation the caller cannot see answers like a missing one", async () => {
    const t = setup();
    t.runtime.boot();
    const id = t.intent();
    const { call } = routes(t, false);
    expect(await call("GET", `/api/calls/${id}`)).toMatchObject({ status: 404 });
    expect(await call("POST", `/api/calls/${id}/decline`)).toMatchObject({ status: 404 });
    t.runtime.stop();
  });
});

describe("Calls off for today (calls-109.yaml v2, off-today)", () => {
  function routes(t: ReturnType<typeof setup>) {
    const deps: CallsRouteDeps = {
      db: () => t.db, runtime: t.runtime, tickets: createCallTickets(), visible: () => true,
      bot: (id) => id === "scout" ? { id, name: "Scout" } : null, opener: () => "", quietHours: () => null, voiceReady: () => true,
      setRingsForCalls: () => true, readBody: async () => ({}), now: () => t.now(),
    };
    return (method: string, path: string, body: unknown = {}) => handleCallsRoute(method, path, new URL(`http://x${path}`), { ...deps, readBody: async () => body });
  }
  it("turning it on stops a ring already on its way, except an Emergency rule's (5.6, Astra p5 r1 item 4)", async () => {
    const t = setup();
    t.runtime.boot();
    const call = routes(t);
    const plain = t.intent("k-plain");
    const urgentRule = insertCallRule(t.db, { ...RING, botId: "scout", emergency: true }, t.now());
    const urgent = admitIntent(t.db, { botId: "scout", ruleId: urgentRule, threadId: "t1", factKind: "watch.changed", factKey: "k-urgent", factAt: t.now() }, t.now())!;
    for (const id of [plain, urgent]) t.db.prepare("UPDATE bot_calls SET state='ringing', rang_at=?, deadline_at=? WHERE id=?").run(t.now(), t.now() + 30_000, id);
    expect((await call("POST", "/api/calls/off-today", { on: true, tz: "UTC" }))!.status).toBe(200);
    expect(getIntent(t.db, plain)).toMatchObject({ state: "done", outcome: "cancelled" });
    expect(getIntent(t.db, plain)!.receipt.stop).toBe("calls_off");
    expect(getIntent(t.db, urgent)).toMatchObject({ state: "ringing" });
    t.runtime.stop();
  });
  it("next local midnight in the device's zone, the host's zone when missing or invalid, across DST", () => {
    const at = Date.parse("2026-10-27T15:30:00Z");
    expect(nextLocalMidnight(at, "UTC")).toBe(Date.parse("2026-10-28T00:00:00Z"));
    expect(nextLocalMidnight(at, "Asia/Bangkok")).toBe(Date.parse("2026-10-27T17:00:00Z")); // 22:30 local, UTC+7
    expect(nextLocalMidnight(at, "America/New_York")).toBe(Date.parse("2026-10-28T04:00:00Z"));
    expect(nextLocalMidnight(Date.parse("2026-11-01T12:00:00Z"), "America/New_York")).toBe(Date.parse("2026-11-02T05:00:00Z")); // EDT to EST
    expect(nextLocalMidnight(Date.parse("2026-03-08T12:00:00Z"), "America/New_York")).toBe(Date.parse("2026-03-09T04:00:00Z")); // EST to EDT
    const host = nextLocalMidnight(at);
    for (const bad of ["Not/AZone", "", 42, "x".repeat(65), null]) expect(nextLocalMidnight(at, bad)).toBe(host);
    expect(host).toBeGreaterThan(at);
    expect(host - at).toBeLessThanOrEqual(25 * 3600_000);
  });
  it("on:true is idempotent and owner-wide, on:false clears, GET active shows it, bad bodies are 400, and it lapses with no timer", async () => {
    const t = setup();
    t.runtime.boot();
    const call = routes(t);
    const midnight = nextLocalMidnight(t.now(), "Asia/Bangkok");
    expect(await call("POST", "/api/calls/off-today", { on: true, tz: "Asia/Bangkok" })).toEqual({ status: 200, body: { offUntil: midnight } });
    expect(await call("POST", "/api/calls/off-today", { on: true, tz: "Asia/Bangkok" })).toEqual({ status: 200, body: { offUntil: midnight } });
    expect(await call("POST", "/api/calls/off-today", { on: true, tz: "UTC" })).toEqual({ status: 200, body: { offUntil: nextLocalMidnight(t.now(), "UTC") } });
    expect(await call("GET", "/api/calls/active")).toMatchObject({ status: 200, body: { offUntil: nextLocalMidnight(t.now(), "UTC") } });
    for (const body of [{}, { on: "yes" }, { on: 1 }, null]) expect(await call("POST", "/api/calls/off-today", body)).toMatchObject({ status: 400, body: { error: expect.any(String) } });
    expect(await call("POST", "/api/calls/off-today", { on: false })).toEqual({ status: 200, body: { offUntil: null } });
    expect(callsOffUntil(t.db)).toBeNull();
    setCallsOffUntil(t.db, t.now() + 1000);
    t.tick(1000);
    expect(await call("GET", "/api/calls/active")).toMatchObject({ body: { offUntil: null } });
    t.runtime.stop();
  });
  it("is an owner route: the desktop and the companion proof pass, a bot's capability is refused", () => {
    expect(routePolicy("POST", "/api/calls/off-today")).toMatchObject({ class: "companion", cloudWrite: "ordinary" });
    const cls = routeClass("POST", "/api/calls/off-today");
    expect(routeAdmits(cls, { desktop: true, companion: false, door: false, bot: false })).toBe(true);
    expect(routeAdmits(cls, { desktop: false, companion: true, door: false, bot: false })).toBe(true);
    expect(routeAdmits(cls, { desktop: false, companion: false, door: false, bot: true })).toBe(false);
    expect(routeAdmits(cls, { desktop: false, companion: false, door: true, bot: false })).toBe(false);
  });
  it("while off, a call that texts makes no note push (card only), as in quiet hours", async () => {
    const t = setup();
    t.runtime.boot();
    setCallsOffUntil(t.db, t.now() + 3600_000);
    const id = t.intent();
    t.runtime.admitted(id);
    await t.settle(); await t.settle();
    expect(getIntent(t.db, id)).toMatchObject({ state: "done", outcome: "texted" });
    expect(rows(t.db).filter((r) => r.requestId === id)).toEqual([]);
    expect(t.cards.some((c) => c.id === id)).toBe(true);
    t.runtime.stop();
  });
});

describe("Call me when this finishes (calls-109.yaml, turn-end)", () => {
  it("marks the running turn once, needs the bot's switch and a running turn, and the owed row settles on turn.completed", async () => {
    const t = setup();
    let running: { turnId: string; botId: string } | null = { turnId: "turn-9", botId: "scout" };
    const deps: CallsRouteDeps = {
      db: () => t.db, runtime: t.runtime, tickets: createCallTickets(), visible: (id) => id === "t1",
      bot: (id) => id === "scout" ? { id, name: "Scout" } : null, opener: () => "", quietHours: () => null, voiceReady: () => true,
      setRingsForCalls: () => true, readBody: async () => ({}), now: () => t.now(), runningTurn: () => running,
    };
    const call = (body: unknown) => handleCallsRoute("POST", "/api/calls/turn-end", new URL("http://x/api/calls/turn-end"), { ...deps, readBody: async () => body });
    setBotCallsEnabled(t.db, "scout", false);
    expect(await call({ threadId: "t1" })).toEqual({ status: 409, body: { error: "calls_off" } });
    setBotCallsEnabled(t.db, "scout", true);
    expect((await call({ threadId: "t2" }))!.status).toBe(404);
    expect((await call({ threadId: "t1", how: "text_first", waitMin: 7 }))!.status).toBe(400);
    const first = await call({ threadId: "t1" });
    expect(first).toEqual({ status: 200, body: { ruleId: expect.any(String), turnId: "turn-9" } });
    expect(await call({ threadId: "t1", how: "text_first" })).toEqual(first);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM bot_call_rules WHERE kind='turn_end'").get()).toEqual({ n: 1 });
    expect(t.db.prepare("SELECT at, armed FROM bot_call_owed WHERE fact_key='turn:turn-9'").get()).toEqual({ at: null, armed: 1 });
    t.runtime.turnCompleted("turn-9");
    const settled = t.db.prepare("SELECT at FROM bot_call_owed WHERE fact_key='turn:turn-9'").get() as { at: number | null } | undefined;
    expect(settled === undefined || settled.at !== null).toBe(true); // settled, or already drained by the wake
    running = null;
    expect(await call({ threadId: "t1" })).toEqual({ status: 409, body: { error: "not_running" } });
  });
  it("while Calls off for today holds it answers 409 calls_off_today and queues nothing; turned back on, the retry marks the turn", async () => {
    const t = setup();
    const deps: CallsRouteDeps = {
      db: () => t.db, runtime: t.runtime, tickets: createCallTickets(), visible: (id) => id === "t1",
      bot: (id) => id === "scout" ? { id, name: "Scout" } : null, opener: () => "", quietHours: () => null, voiceReady: () => true,
      setRingsForCalls: () => true, readBody: async () => ({}), now: () => t.now(), runningTurn: () => ({ turnId: "turn-7", botId: "scout" }),
    };
    const post = (path: string, body: unknown) => handleCallsRoute("POST", path, new URL(`http://x${path}`), { ...deps, readBody: async () => body });
    setBotCallsEnabled(t.db, "scout", true);
    expect((await post("/api/calls/off-today", { on: true, tz: "UTC" }))!.status).toBe(200);
    expect(await post("/api/calls/turn-end", { threadId: "t1" })).toEqual({ status: 409, body: { error: "calls_off_today", code: "calls_off_today" } });
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM bot_call_rules WHERE kind='turn_end'").get()).toEqual({ n: 0 });
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM bot_call_owed WHERE fact_key='turn:turn-7'").get()).toEqual({ n: 0 });
    expect(await post("/api/calls/off-today", { on: false })).toEqual({ status: 200, body: { offUntil: null } });
    expect(await post("/api/calls/turn-end", { threadId: "t1" })).toEqual({ status: 200, body: { ruleId: expect.any(String), turnId: "turn-7" } });
    expect(routePolicy("POST", "/api/calls/turn-end")).toMatchObject({ class: "companion" });
  });
});

describe("card and opener words (design 8)", () => {
  const base = { id: "i", botId: "scout", tier: "A", state: "done", rangAt: T0, createdAt: T0, factAt: T0, factKind: "timed", line: null, receipt: { steps: [] } } as unknown as CallIntent;
  const clock = () => "14:02";
  it("missed, declined and late read as designed; ringing owes no card", () => {
    expect(callCardRow({ ...base, outcome: "missed" }, "Scout", clock, T0)?.text).toBe("Scout tried to call you at 14:02");
    expect(callCardRow({ ...base, outcome: "declined" }, "Scout", clock, T0)?.text).toBe("Scout tried to call you at 14:02\nYou declined.");
    expect(callCardRow({ ...base, outcome: "late" }, "Scout", clock, T0)?.text).toBe("Scout would have called you at 14:02, while Murage wasn't running.");
    expect(callCardRow({ ...base, state: "ringing", outcome: null }, "Scout", clock, T0)).toBeNull();
    expect(callOpener(base, { firstName: "Sean", botName: "Scout", ago: () => "just now", clock })).toBe("Hi Sean, it's Scout. You asked me to call you at 14:02. Want the details?");
  });
});

describe("the call channel echoes the heartbeat number (R3-H1)", () => {
  it("call.live carries the call.alive seq back; any other frame still gets a plain call.live", () => {
    expect(JSON.parse(liveFrame(JSON.stringify({ type: "call.alive", seq: 7 })))).toEqual({ type: "call.live", seq: 7 });
    expect(JSON.parse(liveFrame(Buffer.from(JSON.stringify({ type: "call.alive", seq: 8 }))))).toEqual({ type: "call.live", seq: 8 });
    for (const bad of ["not json", JSON.stringify({ seq: -1 }), JSON.stringify({ seq: 1.5 }), JSON.stringify({ seq: "3" }), JSON.stringify({})]) {
      expect(JSON.parse(liveFrame(bad))).toEqual({ type: "call.live" });
    }
  });
});

describe("bot calls follow-up (Grok union-server M1, M2, L1)", () => {
  const deps = (t: ReturnType<typeof setup>, visible: (threadId: string) => boolean): CallsRouteDeps => ({
    db: () => t.db, runtime: t.runtime, tickets: createCallTickets(), visible,
    bot: (id) => id === "scout" ? { id, name: "Scout" } : null, opener: () => "Hi, it's Scout.", quietHours: () => null, voiceReady: () => true,
    setRingsForCalls: () => true, readBody: async () => ({}), now: () => t.now(),
  });
  it("M1: call.answered and every call.ended hint carry the call's threadId", async () => {
    const t = setup();
    t.runtime.boot();
    const id = t.intent();
    t.runtime.admitted(id);
    await t.settle(); await t.settle();
    const r = t.runtime.answer(id, "phone:abc");
    expect(r.status).toBe(200);
    const { callId } = r as { callId: string };
    expect(t.runtime.endSession(callId)).toBe(true);
    const calls = t.hints.filter((h) => (h as { type: string }).type !== "call.ring") as Array<Record<string, unknown>>;
    expect(calls).toContainEqual(expect.objectContaining({ type: "call.answered", callId, threadId: "t1" }));
    expect(calls).toContainEqual(expect.objectContaining({ type: "call.ended", callId, threadId: "t1" }));
    expect(calls).toContainEqual(expect.objectContaining({ type: "call.ended", intentId: id, threadId: "t1" }));
    for (const h of calls) expect(h.threadId).toBe("t1");
    t.runtime.stop();
  });
  it("M2: a caller the request check refuses touches nothing, so the session still goes silent and ends", () => {
    const t = setup();
    t.runtime.boot();
    const { callId } = t.runtime.openSession({ botId: "scout", threadId: "t1", device: "desktop:xyz" });
    const seen = () => (t.db.prepare("SELECT last_seen_at AS s FROM bot_call_sessions WHERE call_id=?").get(callId) as { s: number }).s;
    const opened = seen();
    t.tick(30_000);
    expect(t.runtime.touch(callId, (s) => s.device === "phone:other")).toBe("unknown");
    expect(seen()).toBe(opened);
    expect(t.runtime.touch("no-such-call", () => true)).toBe("unknown");
    expect(t.runtime.touch(callId, (s) => s.threadId === "t1")).toBe("live");
    expect(seen()).toBe(T0 + 30_000);
    t.tick(30_000);
    for (let i = 0; i < 5; i++) t.runtime.touch(callId, () => false);
    t.tick(31_000);
    t.runtime.sweep();
    expect(t.db.prepare("SELECT ended_at IS NOT NULL AS ended FROM bot_call_sessions WHERE call_id=?").get(callId)).toEqual({ ended: 1 });
    t.runtime.stop();
  });
  it("p5 r5 Medium B: the session open answers the call id on its headers as well as its body", async () => {
    const t = setup();
    t.runtime.boot();
    const reply = await handleCallsRoute("POST", "/api/calls/sessions", new URL("http://x/api/calls/sessions"), { ...deps(t, () => true), readBody: async () => ({ botId: "scout", threadId: "t1", device: "desktop:xyz" }) });
    const { callId } = reply!.body as { callId: string };
    expect(reply).toMatchObject({ status: 200, headers: { "x-murage-call-id": callId } });
    t.runtime.stop();
  });
  it("L1: the history cursor never comes from a call in a hidden conversation", async () => {
    const t = setup();
    const rule = insertCallRule(t.db, { ...RING, botId: "scout" }, t.now());
    const admit = (threadId: string, key: string, at: number) => admitIntent(t.db, { botId: "scout", ruleId: rule, threadId, factKind: "watch.changed", factKey: key, factAt: at }, at)!;
    const older = admit("t1", "a", T0);
    const newer = admit("t1", "b", T0 + 1);
    admit("hidden", "c", T0 + 5);
    const history = async (q: string) => (await handleCallsRoute("GET", "/api/calls/history", new URL(`http://x/api/calls/history${q}`), deps(t, (th) => th !== "hidden")))!.body as { items: Array<{ intentId: string }>; next: number | null };
    const first = await history("?limit=1");
    expect(first.items.map((i) => i.intentId)).toEqual([newer]);
    expect(first.next).toBe(T0 + 1);
    const second = await history(`?limit=1&before=${first.next}`);
    expect(second.items.map((i) => i.intentId)).toEqual([older]);
    expect(second.next).toBeNull();
    const all = await history("?limit=5");
    expect(all.items.map((i) => i.intentId)).toEqual([newer, older]);
    expect(all.next).toBeNull();
  });
});
