// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot calls phase 3 (design BOT-CALLS-109 rev 4.2): decide() over the matrix of 4.3, the calendar answer of 4.4 and the
// Emergency switch of 4.6, with F21, F23-F27, F41, F45-F49, F54.
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initializeMessageTables } from "./message-tables.ts";
import { initializeMobilePush } from "./mobile-push-store.ts";
import { initializeBotCalls, insertCallRule, setBotCallsEnabled, setCallsOffUntil, type CallRuleInput } from "./bot-calls-schema.ts";
import { admitIntent, cancelBotCalls, getIntent, openOwnerSession, NO_CALL_EFFECTS } from "./bot-calls-machine.ts";
import { calendarAnswer, decide, type CalendarAnswer, type DecideWorld } from "./bot-calls-policy.ts";
import { quietHoursActive } from "../shared/notification-preferences.ts";

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const T0 = 1_800_000_000_000;
function fresh(): DatabaseSync {
  const db = new DatabaseSync(":memory:"); dbs.push(db);
  initializeMessageTables(db); initializeMobilePush(db); initializeBotCalls(db);
  setBotCallsEnabled(db, "scout", true);
  return db;
}
function world(o: Partial<DecideWorld> & { cal?: CalendarAnswer; quiet?: boolean } = {}): DecideWorld {
  return { quietHours: () => o.quiet ?? false, voiceReady: () => true, ringingDevice: () => true, factValid: () => true,
    calendar: async () => o.cal ?? "free", bootAt: T0 - 3600_000, ...o };
}
const A_RING: CallRuleInput = { kind: "watch", params: { watchId: "w" }, how: "ring" };
const A_TIMED: CallRuleInput = { kind: "timed", params: { routineId: "r" }, how: "ring" };
const B: CallRuleInput = { kind: "routine_problem", params: {}, how: "text_first", waitMin: 10 };
let n = 0;
function intent(db: DatabaseSync, input: CallRuleInput, extra: { emergency?: boolean; at?: number } = {}): string {
  const ruleId = insertCallRule(db, { ...input, emergency: extra.emergency ?? false, botId: "scout" }, T0);
  return admitIntent(db, { botId: "scout", ruleId, threadId: "t1", factKind: "watch.changed", factKey: `k${n++}`, factAt: extra.at ?? T0 }, T0)!;
}
const run = async (db: DatabaseSync, id: string, w: DecideWorld, at = T0 + 1000, entry: "initial" | "escalation" = "initial") =>
  decide(db, id, entry, w, NO_CALL_EFFECTS, () => at);
const outcome = (db: DatabaseSync, id: string) => { const i = getIntent(db, id)!; return i.state === "done" ? i.outcome : i.state; };
const last = (db: DatabaseSync, id: string) => getIntent(db, id)!.receipt.steps.at(-1);

describe("decide() over the matrix (4.3)", () => {
  it("all clear rings; unsure texts for every rule; busy texts unless Emergency (F45-F47)", async () => {
    const db = fresh();
    const a = intent(db, A_RING); await run(db, a, world());
    expect(outcome(db, a)).toBe("ringing");
    cancelBotCalls(db, { intent: a }, "owner", NO_CALL_EFFECTS, T0 + 1500);
    db.prepare("UPDATE bot_calls SET rang_at=NULL").run();
    const b = intent(db, A_RING); await run(db, b, world({ cal: "busy" }));
    expect([outcome(db, b), last(db, b)]).toEqual(["texted", { check: "calendar", result: "busy" }]);
    const c = intent(db, A_RING, { emergency: true }); await run(db, c, world({ cal: "unsure" }));
    expect(outcome(db, c)).toBe("texted");
    const d = intent(db, A_RING, { emergency: true }); await run(db, d, world({ cal: "busy", quiet: true }));
    expect(outcome(db, d)).toBe("ringing");
    expect(getIntent(db, d)!.receipt.steps.map(s => s.result)).toEqual(expect.arrayContaining(["emergency", "busy"]));
  });
  it("quiet hours: timed rings, call right away is card only, Emergency rings (F25, F45)", async () => {
    const db = fresh();
    const t = intent(db, A_TIMED); await run(db, t, world({ quiet: true }));
    expect(outcome(db, t)).toBe("ringing");
    cancelBotCalls(db, { intent: t }, "owner", NO_CALL_EFFECTS, T0);
    const a = intent(db, A_RING); await run(db, a, world({ quiet: true }));
    expect([outcome(db, a), last(db, a)]).toEqual(["texted", { check: "quiet", result: "quiet" }]);
    const timedBusy = intent(db, A_TIMED); await run(db, timedBusy, world({ quiet: true, cal: "unsure" }));
    expect(outcome(db, timedBusy)).toBe("texted");
  });
  it("Tier B messages first, then rings once at N unseen, never in quiet hours; demoted texts (F23, F24)", async () => {
    const db = fresh();
    const b = intent(db, B); await run(db, b, world());
    expect(getIntent(db, b)).toMatchObject({ state: "waiting", deadlineAt: T0 + 600_000 });
    await run(db, b, world({ quiet: true }), T0 + 600_000, "escalation");
    expect(outcome(db, b)).toBe("texted");
    const c = intent(db, B); await run(db, c, world());
    await run(db, c, world(), T0 + 600_000, "escalation");
    expect(outcome(db, c)).toBe("ringing");
    db.prepare("UPDATE bot_call_rules SET demoted=1 WHERE tier='B'").run();
    cancelBotCalls(db, { intent: c }, "owner", NO_CALL_EFFECTS, T0);
    const d = intent(db, B); db.prepare("UPDATE bot_call_rules SET demoted=1 WHERE tier='B'").run();
    await run(db, d, world());
    expect([outcome(db, d), last(db, d)]).toEqual(["texted", { check: "rule", result: "message_only" }]);
  });
  it("live call, bot switch, held rule and late facts text; caps and cooldown hold Emergency too (F48, F49, F54)", async () => {
    const db = fresh();
    openOwnerSession(db, { botId: "atlas", threadId: "x", device: "desktop:d" }, NO_CALL_EFFECTS, T0);
    const live = intent(db, A_RING, { emergency: true }); await run(db, live, world({ quiet: true }), T0 + 1000);
    expect(last(db, live)).toEqual({ check: "live", result: "on_call" });
    const late = intent(db, A_RING, { at: T0 - 11 * 60_000 }); await run(db, late, world(), T0 + 120_000);
    expect(outcome(db, late)).toBe("late");
    setBotCallsEnabled(db, "scout", false);
    const botOff = intent(db, A_RING); await run(db, botOff, world(), T0 + 120_000);
    expect(last(db, botOff)).toEqual({ check: "bot", result: "off" });
    setBotCallsEnabled(db, "scout", true);
    db.prepare("UPDATE bot_calls SET rang_at=? WHERE id IN (?, ?)").run(T0 + 100_000, live, late);
    const capped = intent(db, A_RING, { emergency: true }); await run(db, capped, world({ quiet: true }), T0 + 120_000);
    expect(last(db, capped)).toEqual({ check: "cap", result: "bot_hour", detail: "2" });
  });
  it("Calls off for today is quiet hours by another trigger: only Emergency rings (timed too is card only), and it lapses (calls-109.yaml v2, off-today)", async () => {
    const db = fresh();
    setCallsOffUntil(db, T0 + 3600_000);
    const a = intent(db, A_RING); await run(db, a, world());
    expect([outcome(db, a), last(db, a)]).toEqual(["texted", { check: "off_today", result: "off_today" }]);
    const e = intent(db, A_RING, { emergency: true }); await run(db, e, world());
    expect(outcome(db, e)).toBe("ringing");
    expect(getIntent(db, e)!.receipt.steps).toEqual(expect.arrayContaining([{ check: "off_today", result: "emergency" }]));
    cancelBotCalls(db, { intent: e }, "owner", NO_CALL_EFFECTS, T0 + 1500);
    db.prepare("UPDATE bot_calls SET rang_at=NULL").run();
    // a timed call is silenced too: the owner turned calls off more recently than they booked it (MurageMain 10-27)
    const t = intent(db, A_TIMED); await run(db, t, world());
    expect([outcome(db, t), last(db, t)]).toEqual(["texted", { check: "off_today", result: "off_today" }]);
    const tq = intent(db, A_TIMED); await run(db, tq, world({ quiet: true }));
    expect([outcome(db, tq), last(db, tq)]).toEqual(["texted", { check: "off_today", result: "off_today" }]);
    const te = intent(db, A_TIMED, { emergency: true }); await run(db, te, world());
    expect(outcome(db, te)).toBe("ringing");
    cancelBotCalls(db, { intent: te }, "owner", NO_CALL_EFFECTS, T0 + 1500);
    db.prepare("UPDATE bot_calls SET rang_at=NULL").run();
    // Emergency during calls off still needs a clear calendar, and never rings over a live call
    const busyUnsure = intent(db, A_RING, { emergency: true }); await run(db, busyUnsure, world({ cal: "unsure" }));
    expect(outcome(db, busyUnsure)).toBe("texted");
    openOwnerSession(db, { botId: "atlas", threadId: "x", device: "desktop:d" }, NO_CALL_EFFECTS, T0);
    const live = intent(db, A_RING, { emergency: true }); await run(db, live, world());
    expect(last(db, live)).toEqual({ check: "live", result: "on_call" });
    // quiet hours named first when both hold
    const both = fresh(); setCallsOffUntil(both, T0 + 3600_000);
    const q = intent(both, A_RING); await run(both, q, world({ quiet: true }));
    expect(last(both, q)).toEqual({ check: "quiet", result: "quiet" });
    // a lapsed value is not off: no timer clears it
    const lapsed = fresh(); setCallsOffUntil(lapsed, T0);
    const l = intent(lapsed, A_RING); await run(lapsed, l, world());
    expect(outcome(lapsed, l)).toBe("ringing");
  });
  it("a Stop while the calendar is asked discards the decision (F21)", async () => {
    const db = fresh();
    const a = intent(db, A_RING);
    const w = world({ calendar: async () => { cancelBotCalls(db, { bot: "scout" }, "stop", NO_CALL_EFFECTS, T0 + 500); return "free"; } });
    expect((await run(db, a, w)).applied).toBe(false);
    expect(getIntent(db, a)).toMatchObject({ state: "done", outcome: "cancelled", activeSlot: false });
  });
  it("a switch turned off while the calendar is asked wins at commit", async () => {
    const db = fresh();
    const a = intent(db, A_RING);
    await run(db, a, world({ calendar: async () => { setBotCallsEnabled(db, "scout", false); return "free"; } }));
    expect([outcome(db, a), last(db, a)]).toEqual(["texted", { check: "bot", result: "off" }]);
  });
});

describe("calendarAnswer (4.4)", () => {
  const w = { start: T0, end: T0 + 300_000 };
  const live = { ok: true, live: true, hasGooglecalendar: true };
  const body = (busy: unknown[]) => ({ calendars: { primary: { busy } } });
  it("free, busy, none and every unsure cause (F26, F27)", () => {
    expect(calendarAnswer({ mode: "managed", inventory: live, status: 200, body: body([]), window: w })).toBe("free");
    expect(calendarAnswer({ mode: "managed", inventory: live, status: 200, body: body([{ start: new Date(T0 + 60_000).toISOString(), end: new Date(T0 + 9e6).toISOString() }]), window: w })).toBe("busy");
    expect(calendarAnswer({ mode: "managed", inventory: { ok: true, live: true, hasGooglecalendar: false }, window: w })).toBe("none");
    expect(calendarAnswer({ mode: "unavailable", inventory: live, status: 200, body: body([]), window: w })).toBe("unsure");
    expect(calendarAnswer({ mode: "managed", inventory: { ok: true, live: false, hasGooglecalendar: false }, window: w })).toBe("unsure");
    expect(calendarAnswer({ mode: "managed", inventory: null, window: w })).toBe("unsure");
    for (const status of [401, 403, 500]) expect(calendarAnswer({ mode: "managed", inventory: live, status, body: body([]), window: w })).toBe("unsure");
    expect(calendarAnswer({ mode: "managed", inventory: live, status: 200, body: { errors: [{}], calendars: { primary: { busy: [] } } }, window: w })).toBe("unsure");
    expect(calendarAnswer({ mode: "managed", inventory: live, status: 200, body: { calendars: {} }, window: w })).toBe("unsure");
    expect(calendarAnswer({ mode: "managed", inventory: live, status: 200, body: { truncated: true, calendars: { primary: { busy: [] } } }, window: w })).toBe("unsure");
  });
  it("a calendar that never answers is unsure inside the 5 s budget", async () => {
    const db = fresh();
    const a = intent(db, A_RING);
    const started = Date.now();
    await decide(db, a, "initial", world({ calendar: () => new Promise(() => {}) }), NO_CALL_EFFECTS, () => T0 + 1000);
    expect(Date.now() - started).toBeLessThan(7_000);
    expect(last(db, a)).toEqual({ check: "calendar", result: "unsure" });
  }, 10_000);
});

describe("quietHoursActive", () => {
  it("is the notification rule, overnight windows included", () => {
    const prefs = { quietHours: { enabled: true, start: "22:00", end: "07:00", timeZone: "UTC" } };
    expect(quietHoursActive(prefs, new Date("2026-10-27T23:30:00Z"))).toBe(true);
    expect(quietHoursActive(prefs, new Date("2026-10-27T12:00:00Z"))).toBe(false);
    expect(quietHoursActive({}, new Date("2026-10-27T23:30:00Z"))).toBe(false);
  });
});
