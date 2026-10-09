// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The decision model on by default with a Flux key: defaults, paid and free
// plans, the 2,048 token state limit, and fail-open on every error.
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.ts", () => ({ loadConfig: () => ({}) }));

import { deciderUnavailable, markDeciderUnavailable, PLAN_COOLDOWN_MS, resetDeciderAvailability } from "./availability.ts";
import { createDecider } from "./index.ts";
import { DECIDE_PRIVACY_HEADERS } from "./flux.ts";
import { decideRoomResponder, estimateStateTokens, ROOM_ROUTING_REQUEST_TOKEN_BUDGET, routeLogRow, ROOM_ROUTING_STATE_TOKEN_BUDGET, ROOM_ROUTING_TIMEOUT_MS, roomRoutingRequest, type RoomRoutingInput } from "./room-routing.ts";
import { describeDecisionModelSettings, readDecisionModelSettings } from "./settings.ts";

const dataDir = join(process.env.TMPDIR ?? "/tmp", "murage-decider-clef-on-test");
const KEY = "sk-flux-clef-on-test";
const members = [
  { id: "maya", name: "Maya", title: "Designer", description: "UI." },
  { id: "theo", name: "Theo", title: "Engineer", description: "React." },
];
const input = (text = "new icon please", recent: RoomRoutingInput["recent"] = []): RoomRoutingInput => ({
  room: "#launch", humans: ["Milind (owner)"], members, recent, message: { from: "Milind", text },
});
const ok = () => new Response(JSON.stringify({ answers: { answer: { type: "choice", choice: "maya", probabilities: { maya: 0.95, theo: 0.05 } } } }), { status: 200 });
const planRefusal = () => new Response(JSON.stringify({ error: { code: "paid_plan_required", message: "x" } }), { status: 403 });

afterEach(() => {
  resetDeciderAvailability();
  vi.useRealTimers();
});

describe("defaults", () => {
  it("with nothing saved and no key it stays off", () => {
    const s = readDecisionModelSettings(undefined);
    expect(s.enabled).toBe(false);
    expect(s.jobs.roomRouting).toBe(false);
    expect(readDecisionModelSettings({}, { defaultOn: false }).enabled).toBe(false);
  });
  it("with a key and nothing saved, the master switch and room routing are on", () => {
    const s = readDecisionModelSettings({}, { defaultOn: true });
    expect(s.enabled).toBe(true);
    expect(s.jobs.roomRouting).toBe(true);
  });
  it("what the owner saved wins, either way", () => {
    expect(readDecisionModelSettings({ enabled: false }, { defaultOn: true }).enabled).toBe(false);
    expect(readDecisionModelSettings({ enabled: true, jobs: { roomRouting: false } }, { defaultOn: true }).jobs.roomRouting).toBe(false);
    expect(readDecisionModelSettings({ enabled: true, jobs: { roomRouting: true } }, { defaultOn: false })).toMatchObject({ enabled: true, jobs: { roomRouting: true } });
    expect(readDecisionModelSettings({ provider: "other" as never }, { defaultOn: true }).enabled).toBe(false);
  });
  it("the default settings path turns on when a Flux key is present, off when not", async () => {
    const f = vi.fn<typeof fetch>().mockImplementation(async () => ok());
    const on = createDecider({ credential: () => KEY, fetch: f as unknown as typeof fetch, dataDir });
    expect(await decideRoomResponder(on, input())).toMatchObject({ kind: "member", botId: "maya" });
    const none = vi.fn<typeof fetch>();
    const off = createDecider({ credential: () => null, fetch: none as unknown as typeof fetch, dataDir });
    expect(await decideRoomResponder(off, input())).toMatchObject({ kind: "fallback", reason: "disabled" });
    expect(none).not.toHaveBeenCalled();
  });
  it("describes availability for the app without a key", () => {
    const s = readDecisionModelSettings({}, { defaultOn: true });
    expect(describeDecisionModelSettings(s).available).toBe(true);
    expect(describeDecisionModelSettings(s, { available: false }).available).toBe(false);
    expect(JSON.stringify(describeDecisionModelSettings(s))).not.toContain("sk-");
  });
});

describe("paid and free plans", () => {
  it("a free plan (403 paid_plan_required) is remembered and not asked again, fail-open", async () => {
    const f = vi.fn<typeof fetch>().mockImplementation(async () => planRefusal());
    const decider = createDecider({ credential: () => KEY, fetch: f as unknown as typeof fetch, dataDir });
    expect(await decideRoomResponder(decider, input())).toEqual({ kind: "fallback", reason: "plan_required" });
    expect(deciderUnavailable(KEY)).toBe(true);
    expect(await decideRoomResponder(decider, input())).toEqual({ kind: "fallback", reason: "plan_required" });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("asks again after the cooldown, and another key is unaffected", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
    markDeciderUnavailable(KEY);
    expect(deciderUnavailable(KEY)).toBe(true);
    expect(deciderUnavailable("sk-flux-someone-else")).toBe(false);
    vi.setSystemTime(Date.now() + PLAN_COOLDOWN_MS + 1);
    expect(deciderUnavailable(KEY)).toBe(false);
  });
  it("a paid plan with other 403 bodies is not marked unavailable", async () => {
    const f = vi.fn<typeof fetch>().mockImplementation(async () => new Response("forbidden", { status: 403 }));
    const decider = createDecider({ credential: () => KEY, fetch: f as unknown as typeof fetch, dataDir });
    expect(await decideRoomResponder(decider, input())).toMatchObject({ kind: "fallback", reason: "disabled" });
    expect(deciderUnavailable(KEY)).toBe(false);
  });
});

describe("state fits 2,048 tokens", () => {
  const long = (n: number, text: string) => Array.from({ length: n }, (_v, i) => ({ from: `Member ${i % 7}`, text: `${i} ${text.repeat(200)}` }));
  it("a long English room", () => {
    const { state } = roomRoutingRequest(input("z".repeat(30_000), long(200, "word ")));
    expect(estimateStateTokens(state)).toBeLessThanOrEqual(ROOM_ROUTING_STATE_TOKEN_BUDGET);
    expect(state.recent_messages!.length).toBeGreaterThan(0);
    expect(state.recent_messages!.length).toBeLessThan(200);
  });
  it("a long room in a script that costs a token per character", () => {
    const { state } = roomRoutingRequest(input("あ".repeat(10_000), long(100, "日本語のメッセージ")));
    expect(estimateStateTokens(state)).toBeLessThanOrEqual(ROOM_ROUTING_STATE_TOKEN_BUDGET);
  });
  it("many members and huge names still fit, and the newest lines are the ones kept", () => {
    const many = Array.from({ length: 8 }, (_v, i) => ({ id: `b${i}`, name: `Bot ${i} ${"n".repeat(200)}`, description: "d".repeat(900) }));
    const recent = [{ from: "A", text: "oldest" }, ...long(40, "filler ")].concat([{ from: "B", text: "newest line" }]);
    const { state, question } = roomRoutingRequest({ ...input("hi", recent), members: many, humans: Array.from({ length: 20 }, (_v, i) => `Human ${i} ${"h".repeat(200)}`) });
    expect(estimateStateTokens(state)).toBeLessThanOrEqual(ROOM_ROUTING_STATE_TOKEN_BUDGET);
    expect(Object.keys(question.options)).toHaveLength(9);
    expect(state.recent_messages?.at(-1)?.text).toBe("newest line");
    expect(state.recent_messages?.some((m) => m.text === "oldest")).toBeFalsy();
  });
  it("sixty bots: the state still fits and the new message is always kept", () => {
    const sixty = Array.from({ length: 60 }, (_v, i) => ({ id: `b${i}`, name: `Bot ${i}`, description: "d".repeat(900) }));
    const { state, question } = roomRoutingRequest({ ...input("hello there", long(10, "x ")), members: sixty });
    expect(estimateStateTokens(state)).toBeLessThanOrEqual(ROOM_ROUTING_STATE_TOKEN_BUDGET);
    expect(state.new_message.text).toBe("hello there");
    expect(Object.keys(question.options)).toHaveLength(61);
  });
  it("a short room keeps all its history", () => {
    const { state } = roomRoutingRequest(input("hi", [{ from: "Maya", text: "one" }, { from: "Theo", text: "two" }]));
    expect(state.recent_messages).toHaveLength(2);
  });
});

describe("fail-open", () => {
  const cases: Array<[string, () => Promise<Response>]> = [
    ["state too long (422)", async () => new Response("{}", { status: 422 })],
    ["upstream deadline (504)", async () => new Response("{}", { status: 504 })],
    ["rate limited", async () => new Response("{}", { status: 429 })],
    ["bad key", async () => new Response("{}", { status: 401 })],
    ["not JSON", async () => new Response("<html>", { status: 200 })],
    ["network down", async () => { throw new TypeError("fetch failed"); }],
  ];
  for (const [name, make] of cases) {
    it(`${name} falls back to the lead and never throws`, async () => {
      const f = vi.fn<typeof fetch>().mockImplementation(make);
      const decider = createDecider({ credential: () => KEY, fetch: f as unknown as typeof fetch, dataDir });
      expect((await decideRoomResponder(decider, input())).kind).toBe("fallback");
    });
  }
  it("a hung call ends inside the 1.2 second budget", async () => {
    expect(ROOM_ROUTING_TIMEOUT_MS).toBeLessThanOrEqual(1_200);
    const hang = vi.fn<typeof fetch>((_u, init) => new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const decider = createDecider({ credential: () => KEY, fetch: hang as unknown as typeof fetch, dataDir });
    const started = Date.now();
    const route = await decideRoomResponder(decider, input());
    expect(route).toEqual({ kind: "fallback", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_600);
  });
});

describe("a busy room with a long message and six bots", () => {
  it("the whole request fits with margin, the new message is kept, oldest lines go first", () => {
    const six = ["Maya", "Theo", "Ravi", "Ines", "Kofi", "Lena"].map((name) => ({
      id: name.toLowerCase(), name, title: "Specialist ".repeat(30), description: `${name} handles things. `.repeat(60),
    }));
    const recent = Array.from({ length: 12 }, (_v, i) => ({ from: "Maya", text: `line ${i} ${"discussion ".repeat(80)}` }));
    const { state, question } = roomRoutingRequest({ ...input("Please review this: " + "details ".repeat(900), recent), members: six });
    const total = estimateStateTokens(state) + estimateStateTokens(question.options);
    expect(estimateStateTokens(state)).toBeLessThanOrEqual(ROOM_ROUTING_STATE_TOKEN_BUDGET);
    expect(total).toBeLessThanOrEqual(ROOM_ROUTING_REQUEST_TOKEN_BUDGET);
    expect(ROOM_ROUTING_REQUEST_TOKEN_BUDGET).toBeLessThan(2_048);
    expect(state.new_message.text.startsWith("Please review this")).toBe(true);
    const kept = state.recent_messages ?? [];
    if (kept.length) expect(kept.at(-1)!.text.startsWith("line 11")).toBe(true);
    expect(kept.some((m) => m.text.startsWith("line 0 "))).toBe(false);
  });
});

describe("no-retain and the route log", () => {
  it("the Flux call asks Flux not to keep the text, like the browser checker", async () => {
    const f = vi.fn<typeof fetch>().mockImplementation(async () => ok());
    const decider = createDecider({ credential: () => KEY, fetch: f as unknown as typeof fetch, dataDir });
    await decideRoomResponder(decider, input());
    const headers = (f.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-flux-no-retain"]).toBe("1");
    expect(headers["x-flux-memory-capture"]).toBe("off");
    expect(headers["x-flux-memory-inject"]).toBe("off");
    expect(DECIDE_PRIVACY_HEADERS["x-flux-no-retain"]).toBe("1");
  });
  it("the checker uses the same header name", async () => {
    const { NO_RETAIN_HEADER } = await import("../browser-action-checker-connection.ts");
    expect(Object.keys(DECIDE_PRIVACY_HEADERS)).toContain(NO_RETAIN_HEADER);
  });
  it("logs who was picked, or a plain reason for the fallback, without text", () => {
    const picked = routeLogRow({ kind: "member", botId: "maya", probability: 0.9 });
    expect(picked.route).toEqual({ kind: "member", botId: "maya" });
    const fell = routeLogRow({ kind: "fallback", reason: "low_confidence" });
    expect(fell.route?.why).toMatch(/not sure enough/);
    expect(JSON.stringify(fell)).not.toMatch(/new icon|Milind/);
  });
});
