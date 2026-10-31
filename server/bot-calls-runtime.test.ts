// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot calls phase 4c (design BOT-CALLS-109 rev 4.2, 5.2, 5.5, 5.8): the harness wiring. CallEffects backed by the real push
// outbox on the machine's own connection, the dispatch fence's callRinging (without it no ring is ever sent), boot
// reconcile before the outbox starts, sendNow after commit, the card inside the transition, and the call routes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { WebSocket } from "ws";
import { attachCloudUpgradeGate } from "./cloud-home/upgrade-gate.ts";
import { setCloudIdentity, type CloudRequestIdentity } from "./cloud-request-identity.ts";
import { callCaller } from "./bot-calls-caller.ts";
import { DatabaseSync } from "node:sqlite";
import { initializeMessageTables } from "./message-tables.ts";
import { PushStore, initializeMobilePush } from "./mobile-push-store.ts";
import { PushOutbox, type OutboxWorld, type SendResult } from "./mobile-push-outbox.ts";
import { LEGACY_SESSION_PRINCIPAL, migrateSessionPrincipals, callsOffUntil, initializeBotCalls, insertCallRule, setBotCallsEnabled, setCallsOffUntil, type CallRuleInput } from "./bot-calls-schema.ts";
import { admitIntent, getIntent, type CallIntent } from "./bot-calls-machine.ts";
import { createBotCallsRuntime, matchTurnOwed } from "./bot-calls-runtime.ts";
import { createCallChannel, createCallTickets, handleCallsRoute, liveFrame, nextLocalMidnight, type CallsRouteDeps } from "./bot-calls-routes.ts";
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
      db: () => t.db, runtime: t.runtime, tickets: createCallTickets(), caller: () => "desktop", visible: () => visible,
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
      db: () => t.db, runtime: t.runtime, tickets: createCallTickets(), caller: () => "desktop", visible: () => true,
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
    expect(routePolicy("POST", "/api/calls/off-today")).toMatchObject({ class: "companion", cloudWrite: "browser-step-up" });
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
      db: () => t.db, runtime: t.runtime, tickets: createCallTickets(), caller: () => "desktop", visible: (id) => id === "t1",
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
      db: () => t.db, runtime: t.runtime, tickets: createCallTickets(), caller: () => "desktop", visible: (id) => id === "t1",
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
    db: () => t.db, runtime: t.runtime, tickets: createCallTickets(), caller: () => "desktop", visible,
    bot: (id) => id === "scout" ? { id, name: "Scout" } : null, opener: () => "Hi, it's Scout.", quietHours: () => null, voiceReady: () => true,
    setRingsForCalls: () => true, readBody: async () => ({}), now: () => t.now(),
  });
  it("M1: call.answered and every call.ended hint carry the call's threadId", async () => {
    const t = setup();
    t.runtime.boot();
    const id = t.intent();
    t.runtime.admitted(id);
    await t.settle(); await t.settle();
    const r = t.runtime.answer(id, "phone:abc", "desktop");
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
    const { callId } = t.runtime.openSession({ botId: "scout", threadId: "t1", device: "desktop:xyz", principal: "desktop" });
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

describe("the call channel on a Cloud home (BOT-CALLS-109 5.7)", () => {
  const servers: Server[] = [];
  afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }); });
  // Two of the owner's Cloud devices. The gate stub stands in for cloudRequestAuth: it resolves a bearer token to a device and
  // records it with setCloudIdentity, exactly where the real gate does; the routes and the channel then read the device through
  // the real callCaller and cloudIdentity, never from anything the client sent.
  const device = (id: string): CloudRequestIdentity => ({ id, account: "acct", scope: "owner-phone", publicKey: "", assertionKey: "", revoked: 0, factor: false });
  const TOKENS: Record<string, CloudRequestIdentity> = { "token-a": device("devA"), "token-b": device("devB") };
  const authenticate = (headers: Record<string, unknown>): boolean => {
    const match = /^Bearer (.+)$/.exec(String(headers.authorization ?? ""));
    const resolved = match ? TOKENS[match[1]!] : undefined;
    if (resolved) setCloudIdentity(headers, resolved);
    return Boolean(resolved);
  };
  // Headers, a body field and a query value that claim to be device A; none of them may count.
  const FORGED = { "x-murage-stream-principal": "companion:devA:s1", "x-test-device": "devA", "x-murage-approval-device": "devA", "x-murage-call-principal": "cloud:devA" };
  async function home(t: ReturnType<typeof setup>) {
    const tickets = createCallTickets();
    const channel = createCallChannel({ db: () => t.db, runtime: () => t.runtime, tickets, admitUpgrade: () => true,
      upgradeCaller: (req) => callCaller(req.headers, { cloudHome: true, upgrade: true }) });
    const server = createServer();
    servers.push(server);
    attachCloudUpgradeGate(server, async (req, res) => {
      if (authenticate(req.headers)) return false;
      res.writeHead(401); res.end(); return true;
    }, async (req, socket: Socket, head) => channel.handleUpgrade(req, socket, head));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return { tickets, channel, port: (server.address() as AddressInfo).port };
  }
  /** One HTTP call route as the request with this bearer token (null: none), with the forged claims added. */
  const route = (t: ReturnType<typeof setup>, tickets: ReturnType<typeof createCallTickets>, token: string | null, method: string, path: string, body: Record<string, unknown>) => {
    const headers: Record<string, unknown> = { ...FORGED, ...(token ? { authorization: `Bearer ${token}` } : {}) };
    authenticate(headers);
    const url = new URL(`http://h${path}?device=cloud:devA&principal=cloud:devA`);
    return handleCallsRoute(method, path, url, {
      db: () => t.db, runtime: t.runtime, tickets, caller: () => callCaller(headers as never, { cloudHome: true, upgrade: false, query: url.searchParams }), visible: () => true,
      bot: (id) => id === "scout" ? { id, name: "Scout" } : null, opener: () => "Hi, it's Scout.", quietHours: () => null, voiceReady: () => true,
      setRingsForCalls: () => true, readBody: async () => ({ ...body, principal: "cloud:devA", caller: "cloud:devA" }), now: () => t.now(),
    });
  };
  const open = (port: number, path: string, token: string | null) => new Promise<{ status: number; ws?: WebSocket }>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}&device=cloud:devA`, { headers: { ...FORGED, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    ws.once("open", () => resolve({ status: 101, ws }));
    ws.once("unexpected-response", (_req, res) => { resolve({ status: res.statusCode ?? 0 }); res.resume(); });
    ws.once("error", () => resolve({ status: 0 }));
  });
  const ticketOf = async (reply: Promise<{ status: number; body: unknown } | null>) => { const r = await reply; expect(r!.status).toBe(200); return (r!.body as { ticket: string }).ticket; };
  const livePath = (callId: string, ticket: string) => `/api/calls/sessions/${callId}/live?ticket=${encodeURIComponent(ticket)}`;

  it("only the authenticated device that opened the session gets its ticket and redeems it; forged claims count for nothing", async () => {
    const t = setup();
    t.runtime.boot();
    const { tickets, channel, port } = await home(t);
    // no Cloud device: forged headers, body and query alone open nothing
    expect((await route(t, tickets, null, "POST", "/api/calls/sessions", { botId: "scout", threadId: "t1", device: "desktop:xyz" }))!.status).toBe(403);
    const opened = await route(t, tickets, "token-a", "POST", "/api/calls/sessions", { botId: "scout", threadId: "t1", device: "desktop:xyz" });
    const callId = (opened!.body as { callId: string }).callId;
    const ticketFor = (token: string | null) => route(t, tickets, token, "POST", `/api/calls/sessions/${callId}/ticket`, { device: "desktop:xyz" });
    // ticket request: B read A's call id and device string from /api/calls/active, and is still refused
    expect((await ticketFor("token-b"))!.status).toBe(404);
    expect((await ticketFor(null))!.status).toBe(404);
    const ticket = await ticketOf(ticketFor("token-a"));
    // the gate runs first: an unauthenticated upgrade never reaches (or spends) the ticket
    expect((await open(port, livePath(callId, ticket), null)).status).toBe(401);
    // redemption: A's unused ticket does not work with B's valid Cloud session, whatever B claims
    expect((await open(port, livePath(callId, ticket), "token-b")).status).toBe(403);
    const second = await ticketOf(ticketFor("token-a"));
    const live = await open(port, livePath(callId, second), "token-a");
    expect(live.status).toBe(101);
    const echo = new Promise<string>((r) => live.ws!.once("message", (data) => r(String(data))));
    live.ws!.send(JSON.stringify({ type: "call.alive", seq: 1 }));
    expect(JSON.parse(await echo)).toMatchObject({ type: "call.live", seq: 1 });
    expect(channel.open(callId)).toBe(1);
    // single use: the same ticket again is refused, even for A
    expect((await open(port, livePath(callId, second), "token-a")).status).toBe(403);
    live.ws!.close();
    t.runtime.stop();
  });

  it("an answered call is bound to the device that answered it: a retry from B does not move it, and B cannot redeem A's ticket", async () => {
    const t = setup();
    t.runtime.boot();
    const { tickets, port } = await home(t);
    const id = t.intent();
    t.runtime.admitted(id);
    await t.settle();
    const answered = await route(t, tickets, "token-a", "POST", `/api/calls/${id}/answer`, { device: "phone:aaa" });
    expect(answered!.status).toBe(200);
    const callId = (answered!.body as { callId: string }).callId;
    expect((await route(t, tickets, "token-b", "POST", `/api/calls/${id}/answer`, { device: "phone:aaa" }))!.status).toBe(200);
    expect((await route(t, tickets, "token-b", "POST", `/api/calls/sessions/${callId}/ticket`, { device: "phone:aaa" }))!.status).toBe(404);
    const ticket = await ticketOf(route(t, tickets, "token-a", "POST", `/api/calls/sessions/${callId}/ticket`, { device: "phone:aaa" }));
    expect((await open(port, livePath(callId, ticket), "token-b")).status).toBe(403);
    const live = await open(port, livePath(callId, ticket), "token-a");
    expect(live.status).toBe(101);
    live.ws!.close();
    t.runtime.stop();
  });

  it("a session that existed before principals were recorded is marked legacy: it never binds and never gets a ticket", async () => {
    const t = setup();
    t.runtime.boot();
    const tickets = createCallTickets();
    // made the 1.0.9 way, before the column: an owner session and an answered ring
    const id = t.intent();
    t.runtime.admitted(id);
    await t.settle();
    const answered = t.runtime.answer(id, "phone:aaa", "desktop");
    expect(answered.status).toBe(200);
    const owner = t.runtime.openSession({ botId: "scout", threadId: "t1", device: "desktop:xyz", principal: "desktop" });
    const ringCall = (answered as { callId: string }).callId;
    // a 1.0.9 file: no column, so the principals this build wrote are gone
    t.db.exec("ALTER TABLE bot_call_sessions DROP COLUMN principal");
    initializeBotCalls(t.db);
    const principals = t.db.prepare("SELECT principal FROM bot_call_sessions").all() as Array<{ principal: string | null }>;
    expect(principals.map((row) => row.principal)).toEqual([LEGACY_SESSION_PRINCIPAL, LEGACY_SESSION_PRINCIPAL]);
    expect((await route(t, tickets, "token-a", "POST", `/api/calls/sessions/${owner.callId}/ticket`, { device: "desktop:xyz" }))!.status).toBe(404);
    // the answer retry returns the same session but binds nothing
    expect((await route(t, tickets, "token-a", "POST", `/api/calls/${id}/answer`, { device: "phone:aaa" }))!.status).toBe(200);
    expect((t.db.prepare("SELECT principal FROM bot_call_sessions WHERE call_id=?").get(ringCall) as { principal: string }).principal).toBe(LEGACY_SESSION_PRINCIPAL);
    expect((await route(t, tickets, "token-a", "POST", `/api/calls/sessions/${ringCall}/ticket`, { device: "phone:aaa" }))!.status).toBe(404);
    // and a row without a principal (only an older build writes one) gets no ticket either
    const unbound = t.runtime.openSession({ botId: "scout", threadId: "t1", device: "desktop:zzz", principal: "cloud:devA" });
    t.db.prepare("UPDATE bot_call_sessions SET principal=NULL WHERE call_id=?").run(unbound.callId);
    expect((await route(t, tickets, "token-a", "POST", `/api/calls/sessions/${unbound.callId}/ticket`, { device: "desktop:zzz" }))!.status).toBe(404);
    t.runtime.stop();
  });

  it("opening and answering leave no row without a principal at any await, and a second open of the database freezes no live call", async () => {
    const t = setup();
    t.runtime.boot();
    const { tickets, port } = await home(t);
    const nulls = () => (t.db.prepare("SELECT COUNT(*) AS n FROM bot_call_sessions WHERE principal IS NULL").get() as { n: number }).n;
    const id = t.intent();
    t.runtime.admitted(id);
    await t.settle();
    const answering = route(t, tickets, "token-b", "POST", `/api/calls/${id}/answer`, { device: "phone:bbb" });
    expect(nulls()).toBe(0);
    const answered = await answering;
    expect(answered!.status).toBe(200);
    const ring = (answered!.body as { callId: string }).callId;
    expect(nulls()).toBe(0);
    const opening = route(t, tickets, "token-a", "POST", "/api/calls/sessions", { botId: "scout", threadId: "t1", device: "desktop:xyz" });
    expect(nulls()).toBe(0);
    const opened = await opening;
    expect(opened!.status).toBe(200);
    const owner = (opened!.body as { callId: string }).callId;
    expect(nulls()).toBe(0);
    // the same process opens the database again (a reopen runs initializeBotCalls): both calls stay theirs
    initializeBotCalls(t.db);
    const principal = (callId: string) => (t.db.prepare("SELECT principal FROM bot_call_sessions WHERE call_id=?").get(callId) as { principal: string }).principal;
    expect(principal(owner)).toBe("cloud:devA");
    expect(principal(ring)).toBe("cloud:devB");
    const ownerTicket = await ticketOf(route(t, tickets, "token-a", "POST", `/api/calls/sessions/${owner}/ticket`, { device: "desktop:xyz" }));
    const ringTicket = await ticketOf(route(t, tickets, "token-b", "POST", `/api/calls/sessions/${ring}/ticket`, { device: "phone:bbb" }));
    for (const [callId, ticket, token] of [[owner, ownerTicket, "token-a"], [ring, ringTicket, "token-b"]] as const) {
      const live = await open(port, livePath(callId, ticket), token);
      expect(live.status).toBe(101);
      live.ws!.close();
    }
    t.runtime.stop();
  });
});

describe("the session principal backfill (at every open, one transaction)", () => {
  const principals = (db: DatabaseSync) => (db.prepare("SELECT principal FROM bot_call_sessions ORDER BY rowid").all() as Array<{ principal: string | null }>).map((row) => row.principal);
  const hasColumn = (db: DatabaseSync) => (db.prepare("PRAGMA table_info(bot_call_sessions)").all() as Array<{ name: string }>).some((c) => c.name === "principal");
  it("desktop 1.0.10, then 1.0.9, then 1.0.10 again: the sessions 1.0.9 made are legacy, the bound ones keep their device", () => {
    const t = setup();
    t.runtime.openSession({ botId: "scout", threadId: "t1", device: "desktop:a", principal: "desktop" });
    // 1.0.9 keeps the column (a downgrade to it does not drop it) and inserts sessions without a principal
    t.db.prepare("INSERT INTO bot_call_settings (key, value) VALUES ('sessions_principal_v1', '1')").run();
    for (const device of ["desktop:b", "desktop:c"]) {
      const { callId } = t.runtime.openSession({ botId: "scout", threadId: "t1", device, principal: "desktop" });
      t.db.prepare("UPDATE bot_call_sessions SET principal=NULL WHERE call_id=?").run(callId);
    }
    expect(principals(t.db)).toEqual(["desktop", null, null]);
    initializeBotCalls(t.db);
    expect(principals(t.db)).toEqual(["desktop", LEGACY_SESSION_PRINCIPAL, LEGACY_SESSION_PRINCIPAL]);
    expect(t.db.prepare("SELECT 1 AS x FROM bot_call_settings WHERE key='sessions_principal_v1'").get()).toBeUndefined();
  });
  it("an interrupted run leaves nothing half done, and the next open recovers", () => {
    const t = setup();
    t.runtime.openSession({ botId: "scout", threadId: "t1", device: "desktop:a", principal: "desktop" });
    t.db.exec("ALTER TABLE bot_call_sessions DROP COLUMN principal");
    // the backfill fails: the column add rolls back with it
    t.db.exec("CREATE TRIGGER fail_backfill BEFORE UPDATE ON bot_call_sessions BEGIN SELECT RAISE(ABORT, 'crash'); END");
    expect(() => migrateSessionPrincipals(t.db)).toThrow(/crash/);
    expect(hasColumn(t.db)).toBe(false);
    t.db.exec("DROP TRIGGER fail_backfill");
    initializeBotCalls(t.db);
    expect(principals(t.db)).toEqual([LEGACY_SESSION_PRINCIPAL]);
  });
  it("a session is written with its device, and one without a proper device is refused, the legacy sentinel included", async () => {
    const t = setup();
    t.runtime.boot();
    const id = t.intent();
    t.runtime.admitted(id);
    await t.settle();
    expect(() => t.runtime.answer(id, "phone:aaa", LEGACY_SESSION_PRINCIPAL)).toThrow();
    expect(() => t.runtime.answer(id, "phone:aaa", "")).toThrow();
    const answered = t.runtime.answer(id, "phone:aaa", "cloud:devA") as { status: number; callId: string };
    expect(answered.status).toBe(200);
    expect(principals(t.db)).toEqual(["cloud:devA"]);
    expect(() => t.runtime.openSession({ botId: "scout", threadId: "t1", device: "desktop:x", principal: LEGACY_SESSION_PRINCIPAL })).toThrow();
    expect(() => t.runtime.openSession({ botId: "scout", threadId: "t1", device: "desktop:x", principal: "companion:devA" })).toThrow();
    expect(principals(t.db)).toEqual(["cloud:devA"]);
    t.runtime.stop();
  });
});

describe("callCaller off Cloud", () => {
  it("is the desktop only: a companion-marked or unproven request, or a stamped principal header, is no call device", () => {
    expect(callCaller({ "x-murage-companion": "1", "x-murage-stream-principal": "companion:devA:s1" }, { cloudHome: false, upgrade: false })).toBeNull();
    expect(callCaller({ "x-murage-stream-principal": "companion:devA:s1" }, { cloudHome: false, upgrade: false })).toBeNull();
    expect(callCaller({ "x-murage-companion": "1", "x-murage-stream-principal": "companion:devA:s1" }, { cloudHome: false, upgrade: true })).toBeNull();
    // the desktop page's upgrade carries no headers: it is the desktop, proven by its ticket
    expect(callCaller({}, { cloudHome: false, upgrade: true })).toBe("desktop");
    // on a home, nothing without a resolved Cloud identity
    expect(callCaller({ "x-murage-stream-principal": "companion:devA:s1", "x-test-device": "devA" }, { cloudHome: true, upgrade: true })).toBeNull();
    // never the legacy sentinel, whatever the device id: a Cloud caller is always cloud:<id>
    for (const id of ["none", "legacy:none", "legacy", "x"]) {
      const headers = {};
      setCloudIdentity(headers, { id, account: "acct", scope: "owner-phone", publicKey: "", assertionKey: "", revoked: 0, factor: false });
      for (const upgrade of [false, true]) expect(callCaller(headers, { cloudHome: true, upgrade })).not.toBe(LEGACY_SESSION_PRINCIPAL);
    }
    for (const upgrade of [false, true]) expect(callCaller({}, { cloudHome: false, upgrade })).not.toBe(LEGACY_SESSION_PRINCIPAL);
  });
});
