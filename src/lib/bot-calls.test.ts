// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot calls on the desktop (design BOT-CALLS-109 rev 4.2, sections 3 and 8). Pure helpers, plus source contracts for the
// wiring: the renderer suite runs with no DOM.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { botCallHeaders, takeBotCallOpener } from "./bot-call-session";
import { BOT_CALL_WORDS, CALL_EVENT, callsOffNow, cardActions, desktopCallDevice, isCallsOffToday, receiptLines } from "./bot-calls";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("receipt sentences (design 8)", () => {
  it("names the stopping check in the design's words", () => {
    expect(receiptLines({ steps: [{ check: "fresh", result: "ok" }, { check: "gates", result: "ok" }, { check: "caps", result: "ok" }, { check: "calendar", result: "busy" }] }, "texted"))
      .toEqual(["Calendar: busy, so I messaged instead."]);
    expect(receiptLines({ steps: [{ check: "calendar", result: "unsure" }] }, "texted")).toEqual(["Couldn't check your calendar, so I messaged instead."]);
    expect(receiptLines({ steps: [{ check: "live", result: "on_call" }] }, "texted")).toEqual(["You were on a call, so I messaged instead."]);
    expect(receiptLines({ steps: [{ check: "quiet", result: "quiet" }] }, "texted")).toEqual(["Quiet hours, so I left a message without a notification."]);
    expect(receiptLines({ steps: [{ check: "rule", result: "message_only" }] }, "texted")).toEqual(["You set this rule to message only."]);
    expect(receiptLines({ steps: [{ check: "cap", result: "bot_hour", detail: "2" }] }, "texted")).toEqual(["Over the hourly limit (2), so I messaged instead."]);
    expect(receiptLines({ steps: [{ check: "quiet", result: "emergency" }, { check: "calendar", result: "busy", detail: "emergency" }] }, "answered"))
      .toEqual(["Emergency rule, so I rang during quiet hours.", "Emergency rule, so I rang although your calendar showed busy."]);
    expect(receiptLines({ steps: [{ check: "off_today", result: "off_today" }] }, "texted")).toEqual(["Calls were off for today, so I left a message."]);
    expect(receiptLines({ steps: [] }, "cancelled")).toEqual(["Stopped by you."]);
    expect(receiptLines({ steps: [] }, "restored")).toEqual(["Ended by a restore."]);
    expect(receiptLines({ steps: [], ended: "lost" }, "answered")).toEqual(["The call dropped."]);
  });
});

describe("card buttons (design 3, 8)", () => {
  it("missed and declined offer Call back; a waiting card offers Call me now; nothing while ringing", () => {
    expect(cardActions({ state: "done", outcome: "missed" })).toEqual(["callBack", "neverAgain", "whyCalled"]);
    expect(cardActions({ state: "done", outcome: "declined" })).toEqual(["callBack", "neverAgain", "whyCalled"]);
    expect(cardActions({ state: "waiting", outcome: null })).toEqual(["callMeNow", "neverAgain", "whyCalled"]);
    expect(cardActions({ state: "ringing", outcome: null })).toEqual([]);
    expect(BOT_CALL_WORDS.callBack).toBe("Call back");
    expect(BOT_CALL_WORDS.neverAgain).toBe("Don't call me about this again");
    expect(BOT_CALL_WORDS.whyCalled).toBe("Why I called");
    expect(BOT_CALL_WORDS.callMeNow).toBe("Call me now");
  });
});

describe("helpers", () => {
  it("keeps one desktop device name, valid for the answer route", () => {
    const box = new Map<string, string>();
    const storage = { getItem: (k: string) => box.get(k) ?? null, setItem: (k: string, v: string) => void box.set(k, v) };
    const first = desktopCallDevice(storage, () => "ab-12");
    expect(first).toBe("desktop:ab-12");
    expect(desktopCallDevice(storage, () => "other")).toBe(first);
    expect(desktopCallDevice(null, () => "x!y")).toBe("desktop:xy");
  });
  it("reads turn-end's calls_off_today refusal, and off-today only while it holds", () => {
    expect(isCallsOffToday({ status: 409, body: { error: "calls_off_today", code: "calls_off_today" } })).toBe(true);
    expect(isCallsOffToday({ status: 409, body: { error: "calls_off" } })).toBe(false);
    expect(callsOffNow(2000, 1000)).toBe(true);
    expect(callsOffNow(500, 1000)).toBe(false);
    expect(callsOffNow(null, 1000)).toBe(false);
  });
  it("words follow the copy rules: no em dashes, never safe/unsafe/safety", () => {
    const sources = [read("./bot-calls.ts"), read("../components/BotCallCard.tsx"), read("../components/BotCallRing.tsx"), read("../components/CallMeWhenDone.tsx"), read("../components/CallsSettings.tsx"), read("./bot-call-session.ts")];
    for (const source of sources) {
      expect(source).not.toMatch(/—/);
      expect(source).not.toMatch(/\b(safe|unsafe|safety)\b/i);
    }
    expect(BOT_CALL_WORDS.offToday).toBe("Calls off for today");
    expect(BOT_CALL_WORDS.offTodayHelp).toBe("Back on at midnight.");
    expect(BOT_CALL_WORDS.offTodayRefusal).toBe("Calls are off for today. Turn them back on to get this call.");
    expect(BOT_CALL_WORDS.turnBackOn).toBe("Turn calls back on");
  });
});

describe("wiring (source contracts)", () => {
  it("the live stream hands kind call frames to the call surfaces", () => {
    expect(read("../state/store.tsx")).toMatch(/frame\.kind === "call"\) \{ window\.dispatchEvent\(new CustomEvent\(CALL_EVENT/);
    expect(CALL_EVENT).toBe("murage:bot-call");
    expect(read("../components/BotCallRing.tsx")).toContain("window.addEventListener(CALL_EVENT");
    expect(read("../components/BotCallRing.tsx")).toContain('api("/api/calls/active")');
  });
  it("no ring is shown on a call screen still opening its session (Grok p5 r4)", () => {
    const ring = read("../components/BotCallRing.tsx");
    expect(ring).toContain("const ring = ringing && !callSessionOpening() ? ringing : null;");
    expect(ring).toContain("useOnCall();");
    // the banner, its OS notification and its buttons all read the held-back ring, never the raw one
    expect(ring).toContain("if (!ring && !note) return null;");
    expect(ring).toContain("if (!ring || notified.current === ring.intentId) return;");
    expect(ring).toContain("if (!ring || busy) return;");
  });
  it("a ring already showing hides when a call screen starts opening its session (p5 r5 Medium A)", () => {
    const ring = read("../components/BotCallRing.tsx");
    expect(ring).toContain("useEffect(() => onCallSessionChange(sessionChanged), []);");
    const session = read("./bot-call-session.ts");
    // the subscriber is told right after start(), before the open's POST can hang
    expect(session).toMatch(/const s = start\(\{ botId, device, callId: null, opener: null \}\);\n  changed\(\);/);
  });
  it("Call me when this finishes posts turn-end beside Stop; Calls off for today offers to turn them back on, then asks again", () => {
    const composer = read("../components/Composer.tsx");
    expect(composer).toMatch(/<CallMeWhenDone threadId=\{threadId\}/);
    const button = read("../components/CallMeWhenDone.tsx");
    expect(button).toContain('api("/api/calls/turn-end", { method: "POST", body: JSON.stringify({ threadId }) })');
    const back = button.slice(button.indexOf("const turnBackOn"));
    expect(back.indexOf('JSON.stringify({ on: false })')).toBeGreaterThan(0);
    expect(back.indexOf("await mark()")).toBeGreaterThan(back.indexOf('JSON.stringify({ on: false })'));
  });
  it("call cards render in the chat, and the Calls switch reads offUntil from GET /api/calls/active", () => {
    expect(read("../components/ChatView.tsx")).toContain("if (message.botCall) return");
    const settings = read("../components/CallsSettings.tsx");
    expect(settings).toContain("setOffUntil(active.offUntil ?? null)");
    expect(settings).toContain('"/api/calls/off-today"');
    expect(read("../components/SettingsModal.tsx")).toContain("<CallsSettings />");
  });
});

describe("an answered call keeps its session (Astra p5 r1 item 5)", () => {
  it("no call id header and no opener when no bot call was answered", () => {
    expect(botCallHeaders()).toEqual({});
    expect(takeBotCallOpener("scout")).toBeNull();
  });
  it("Answer attaches the session; call requests carry the call id; the call screen says the opener; ending the call ends it", () => {
    const ring = read("../components/BotCallRing.tsx");
    expect(ring.indexOf("attachAnsweredCall({ intentId, callId: r.callId, botId, device })")).toBeGreaterThan(0);
    expect(ring.indexOf("attachAnsweredCall(")).toBeLessThan(ring.indexOf("startCall(botId)"));
    expect(read("./voice-host.ts")).toContain("...botCallHeaders() }");
    expect(read("../components/CallView.tsx")).toContain("takeBotCallOpener(bot.id)");
    expect(read("../components/CallView.tsx")).toContain("holdCallSession(bot.id, threadRef.current)");
    // one direction: the session follows the call (onCallChange); call.ts knows nothing of sessions
    expect(read("./call.ts")).not.toMatch(/from "\.\/bot-call-session"/);
    expect(read("./bot-call-session.ts")).toContain("onCallChange(");
    const session = read("./bot-call-session.ts");
    expect(session).toContain("/api/calls/sessions/${callId}/ticket");
    expect(session).toContain("/api/calls/sessions/${callId}/live?ticket=");
    expect(session).toContain("/api/calls/sessions/${s.callId}/end");
  });
});
