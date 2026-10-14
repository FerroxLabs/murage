// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Audit findings 1 and 3: the no-retain echo is required (and latches content
// off when missing), and the new message is never clipped to fit.
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDecider } from "./index.ts";
import { readDecisionModelSettings } from "./settings.ts";

import {
  fluxBackend, PRIVACY_PROBE_INTERVAL_MS, privacyLatched, resetPrivacyLatch,
} from "./flux.ts";
import {
  decideRoomResponder, EVERYONE_OPTION, estimateStateTokens, ROOM_ROUTING_TIMEOUT_MS, ROOM_ROUTING_REQUEST_BYTE_CAP, ROOM_ROUTING_REQUEST_TOKEN_BUDGET, roomRoutingRequest, type RoomRoutingInput,
} from "./room-routing.ts";
import type { BackendRequest } from "./types.ts";
import { decideRequestBody } from "./flux.ts";

const KEY = "sk-flux-privacy-test"; // secret-scan: fixture
const SECRET_TEXT = "PRIVATE-MESSAGE-TEXT";
const QUESTIONS = { answer: { type: "choice" as const, instructions: "Who?", options: { maya: "Maya.", theo: "Theo." } } };
const GOOD = { answers: { answer: { type: "choice", choice: "maya", probabilities: { maya: 0.9, theo: 0.1 } } } };
const reply = (echo: string | null, body: unknown = GOOD) =>
  new Response(JSON.stringify(body), { status: 200, headers: echo === null ? {} : { "x-flux-no-retain": echo } });

function request(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>, extra: Partial<BackendRequest> = {}): BackendRequest {
  return { key: KEY, state: { text: SECRET_TEXT }, questions: QUESTIONS, signal: new AbortController().signal, fetch: fetchImpl as unknown as typeof fetch, ...extra };
}
const bodies = (f: ReturnType<typeof vi.fn<typeof fetch>>) => f.mock.calls.map((call) => String((call[1] as RequestInit).body));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); resetPrivacyLatch(); });

describe("no-retain echo is required", () => {
  it("accepts a decision only when x-flux-no-retain is exactly applied", async () => {
    const f = vi.fn<typeof fetch>().mockImplementation(async () => reply("applied"));
    expect(await fluxBackend.decide(request(f))).toMatchObject({ ok: true });
    expect(privacyLatched()).toBe(false);
  });

  it.each([["missing", null], ["wrong value", "1"], ["off", "false"], ["case-changed", "Applied"]])("%s echo: result discarded, privacy_contract_failed, latched", async (_n, echo) => {
    const f = vi.fn<typeof fetch>().mockImplementation(async () => reply(echo));
    expect(await fluxBackend.decide(request(f))).toEqual({ ok: false, reason: "privacy_contract_failed" });
    expect(privacyLatched()).toBe(true);
  });

  it("while latched no room text is sent; one probe per interval, with no content", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T10:00:00Z"));
    const f = vi.fn<typeof fetch>().mockImplementation(async () => reply(null));
    await fluxBackend.decide(request(f));
    expect(f).toHaveBeenCalledTimes(1);
    // Inside the interval: nothing is sent at all.
    expect(await fluxBackend.decide(request(f))).toEqual({ ok: false, reason: "privacy_contract_failed" });
    expect(f).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + PRIVACY_PROBE_INTERVAL_MS + 1);
    expect(await fluxBackend.decide(request(f))).toEqual({ ok: false, reason: "privacy_contract_failed" });
    expect(f).toHaveBeenCalledTimes(2);
    expect(bodies(f)[1]).not.toContain(SECRET_TEXT);
    expect(privacyLatched()).toBe(true);
  });

  it("a probe that returns the echo lifts the latch and the real call goes through", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T10:00:00Z"));
    const f = vi.fn<typeof fetch>().mockImplementationOnce(async () => reply(null));
    await fluxBackend.decide(request(f));
    vi.setSystemTime(Date.now() + PRIVACY_PROBE_INTERVAL_MS + 1);
    f.mockImplementation(async () => reply("applied"));
    expect(await fluxBackend.decide(request(f))).toMatchObject({ ok: true });
    expect(privacyLatched()).toBe(false);
    const sent = bodies(f);
    expect(sent).toHaveLength(3);
    expect(sent[1]).not.toContain(SECRET_TEXT);
    expect(sent[2]).toContain(SECRET_TEXT);
  });

  it("an unreachable or failing probe keeps the latch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T10:00:00Z"));
    const f = vi.fn<typeof fetch>().mockImplementationOnce(async () => reply(null));
    await fluxBackend.decide(request(f));
    vi.setSystemTime(Date.now() + PRIVACY_PROBE_INTERVAL_MS + 1);
    f.mockImplementation(async () => { throw new TypeError("down"); });
    expect(await fluxBackend.decide(request(f))).toEqual({ ok: false, reason: "privacy_contract_failed" });
    expect(privacyLatched()).toBe(true);
  });

  it("the latch resets when the endpoint or the key changes", async () => {
    const f = vi.fn<typeof fetch>().mockImplementationOnce(async () => reply(null));
    await fluxBackend.decide(request(f));
    expect(privacyLatched()).toBe(true);
    f.mockImplementation(async () => reply("applied"));
    expect(await fluxBackend.decide(request(f, { baseUrl: "http://127.0.0.1:9999/v1" }))).toMatchObject({ ok: true });
    expect(privacyLatched()).toBe(false);
    resetPrivacyLatch();
    f.mockImplementationOnce(async () => reply(null));
    await fluxBackend.decide(request(f));
    f.mockImplementation(async () => reply("applied"));
    expect(await fluxBackend.decide(request(f, { key: "sk-flux-another-key" }))).toMatchObject({ ok: true });
  });

  it("a malformed body that did echo does not latch", async () => {
    const f = vi.fn<typeof fetch>().mockImplementation(async () => reply("applied", { answers: {} }));
    expect(await fluxBackend.decide(request(f))).toEqual({ ok: false, reason: "malformed" });
    expect(privacyLatched()).toBe(false);
  });
});

describe("the new message is never clipped", () => {
  const members = Array.from({ length: 6 }, (_v, i) => ({ id: `b${i}`, name: `Bot ${i}`, title: "Specialist", description: "Handles many things. ".repeat(20) }));
  const input = (text: string, recent: RoomRoutingInput["recent"] = []): RoomRoutingInput => ({ room: "#launch", humans: ["Milind"], members, recent, message: { from: "Milind", text } });

  it("keeps a long message, including a negation in its middle, byte for byte", () => {
    const text = `${"We reviewed the plan. ".repeat(60)}Do NOT ship this to production until Ravi signs off. ${"More detail follows. ".repeat(60)}Is that clear?`;
    const built = roomRoutingRequest(input(text));
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.state.new_message.text).toBe(text);
  });

  it("abstains with state_too_long instead of shortening", () => {
    expect(roomRoutingRequest(input(`${"a".repeat(9_000)} not now`))).toEqual({ ok: false, reason: "state_too_long" });
    expect(roomRoutingRequest(input("あ".repeat(1_000)))).toEqual({ ok: false, reason: "state_too_long" });
  });

  it("every outcome respects the budget on the final serialized request, and never clips the message", () => {
    const many = Array.from({ length: 40 }, (_v, i) => ({ id: `b${i}`, name: `Bot ${i}`, description: "d".repeat(300) }));
    let abstained = 0;
    for (let length = 0; length <= 7_000; length += 250) {
      const text = `${"x".repeat(length + 1)} not?`;
      const built = roomRoutingRequest({ ...input(text, [{ from: "Maya", text: "hello" }]), members: many });
      if (!built.ok) { abstained++; continue; }
      expect(built.state.new_message.text).toBe(text);
      const body = JSON.stringify(decideRequestBody(built.state, { answer: { type: "choice", ...built.question } }));
      expect(estimateStateTokens(body)).toBeLessThanOrEqual(ROOM_ROUTING_REQUEST_TOKEN_BUDGET);
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(ROOM_ROUTING_REQUEST_BYTE_CAP);
      expect(Object.keys(built.question.options)).toContain(EVERYONE_OPTION);
    }
    expect(abstained).toBeGreaterThan(0);
  });

  it("history gives way before the message does", () => {
    const recent = Array.from({ length: 30 }, (_v, i) => ({ from: "Maya", text: `line ${i} ${"y".repeat(250)}` }));
    const text = "z".repeat(3_000);
    const built = roomRoutingRequest(input(text, recent));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.state.new_message.text).toBe(text);
    expect(built.state.recent_messages?.some((m) => m.text.startsWith("line 0 "))).toBeFalsy();
  });
});

describe("1,100 ms absolute deadline", () => {
  const members = [{ id: "maya", name: "Maya" }, { id: "theo", name: "Theo" }];
  const room: RoomRoutingInput = { room: "#r", humans: ["Milind"], members, recent: [], message: { from: "Milind", text: "hi" } };

  it("is 1,100 ms", () => {
    expect(ROOM_ROUTING_TIMEOUT_MS).toBe(1_100);
  });

  it("covers reading the body, not just the fetch: headers arrive, body stalls", async () => {
    const stalled = vi.fn<typeof fetch>(async (_u, init) => {
      const body = new ReadableStream({ start(controller) { init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted"))); } });
      return new Response(body, { status: 200, headers: { "x-flux-no-retain": "applied" } });
    });
    const decider = createDecider({ settings: () => readDecisionModelSettings({ enabled: true, jobs: { roomRouting: true } }), credential: () => KEY, fetch: stalled as unknown as typeof fetch });
    const started = Date.now();
    expect(await decideRoomResponder(decider, room)).toEqual({ kind: "fallback", reason: "timeout" });
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(1_050);
    expect(took).toBeLessThan(1_400);
  });

  it("time already spent before the call counts against the budget", async () => {
    const f = vi.fn<typeof fetch>();
    const decider = createDecider({ settings: () => readDecisionModelSettings({ enabled: true, jobs: { roomRouting: true } }), credential: () => KEY, fetch: f as unknown as typeof fetch });
    expect(await decideRoomResponder(decider, room, { timeoutMs: 0 })).toEqual({ kind: "fallback", reason: "timeout" });
    expect(f).not.toHaveBeenCalled();
  });
});
