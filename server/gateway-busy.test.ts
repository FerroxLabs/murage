// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 (a Masterclass customer's two cards): a Fuigo / Flux refusal is read by Flux's own code words before the limit
// words, and only a reset time the server sent names an "until" time.
import { describe, expect, it } from "vitest";
import { gatewayBusy, isGatewayEngine, limitOfferCard, plainLimitLine } from "./limit-continuation.ts";
import { limitRefusal } from "./limit-refusal.ts";
import { fluxRefusalCode, fluxRefusalFinal } from "./flux-refusal.ts";
import { classifyError } from "./drivers/retry.ts";
import { rowToMessage, storedJson } from "./transcript-seq.ts";
import { wireThread, type SeqStore } from "./transcript-page.ts";
import type { Message } from "./store.ts";

const fuigo = { driverKind: "fuigoAgent", viaGateway: false };
const claude = { driverKind: "claudeAgent", viaGateway: false };
const with_ = (errorText: string, base = fuigo) => ({ ...base, errorText });

describe("gateway refusals are not limits", () => {
  it("Fuigo, a plan sign-in through the gateway and a Flux key are gateway engines; Claude is not", () => {
    expect(isGatewayEngine(fuigo)).toBe(true);
    expect(isGatewayEngine({ driverKind: "claudeAgent", viaGateway: true })).toBe(true);
    expect(isGatewayEngine({ driverKind: "openai-chat", viaGateway: false }, "flux")).toBe(true);
    expect(isGatewayEngine(claude)).toBe(false);
  });
  it("a Fuigo 429 with no reset time is busy, never a limit", () => {
    expect(gatewayBusy(with_("API error (status 429): Too Many Requests"), { resetsAt: null })).toBe("busy");
  });
  it("Flux code words win: credit_exhausted (402), credit_unresolved (402), a credit hold (429), free_cap_reached (429)", () => {
    expect(gatewayBusy(with_('402 {"error":{"code":"credit_exhausted","message":"credit exhausted"}}'), { resetsAt: null })).toBe("credit");
    expect(gatewayBusy(with_('402 {"error":{"code":"credit_unresolved"}}'), { resetsAt: null })).toBe("unresolved");
    expect(gatewayBusy(with_("429: Not enough credit is available because other requests have temporarily reserved it."), { resetsAt: null })).toBe("hold");
    expect(gatewayBusy(with_('429 {"error":{"type":"rate_limit_exceeded","state":"free_cap_reached","tier":"free"}}'), { resetsAt: Date.now() + 5_000 })).toBe("freeCap");
  });
  it("a gateway refusal with a real reset time, or a plain payment refusal, keeps its old path", () => {
    expect(gatewayBusy(with_("API error (status 429)"), { resetsAt: Date.now() + 60_000 })).toBeNull();
    expect(gatewayBusy(with_("API error (status 402): payment required"), { resetsAt: null })).toBeNull();
    expect(gatewayBusy(with_("API error (status 429)", claude), { resetsAt: null })).toBeNull();
  });
});

describe("only a real reset time names a time", () => {
  it("Retry-After and 'Retry in Ns' are read as the reset", () => {
    const now = 1_000_000;
    expect(limitRefusal("acp", { text: "429 Too Many Requests. Retry in 12s", kind: "rate_limited" }, now)).toEqual({ resetsAt: now + 12_000 });
    expect(limitRefusal("gateway", { text: "429 retry-after: 30" }, now)).toEqual({ resetsAt: now + 30_000 });
  });
  it("no reset: the line and the card name no time", () => {
    expect(plainLimitLine("Claude", 5_000_000, null)).toBe("Claude is at its limit.");
    const card = limitOfferCard({ requestId: "limit-x", engine: "Claude", until: 5_000_000, sourceMessageId: "m", from: { instanceId: "c", model: "m" }, resetsAt: null, choices: [] });
    expect(card.title).toBe("Claude is at its limit.");
  });
  it("a real reset keeps the until line as today", () => {
    expect(plainLimitLine("Claude", Date.now() + 3_600_000, Date.now() + 3_600_000)).toMatch(/^Claude is at its limit until about /);
  });
});

// Recorded from the Flux service's rate-limit and credit responses.
const FREE_CAP_BODY = { error: { type: "rate_limit_exceeded", state: "free_cap_reached", tier: "free",
  message: "Your account's monthly free-tier token allowance is exhausted. Free-tier allowances are enforced across every key on the account. Upgrade at https://fluxrouter.ai/home/billing to continue.",
  upgrade_url: "https://fluxrouter.ai/home/billing" } };
const LITELLM_REPR = "{'error': {'type': 'rate_limit_exceeded', 'state': 'free_cap_reached', 'tier': 'free', 'message': \"Your account's monthly free-tier token allowance is exhausted.\"}}";

describe("Flux's code is read wherever Flux puts it", () => {
  it("free_cap_reached in error.state (not in the sentence), in a LiteLLM Python repr, or in RPC data", () => {
    expect(FREE_CAP_BODY.error.message).not.toMatch(/free_cap_reached/);
    expect(fluxRefusalCode(JSON.stringify(FREE_CAP_BODY))).toBe("free_cap_reached");
    expect(fluxRefusalCode({ message: "API error (status 429)", data: FREE_CAP_BODY })).toBe("free_cap_reached");
    expect(fluxRefusalCode(Object.assign(new Error("HTTP 429"), { data: { message: LITELLM_REPR, http_status: 429 } }))).toBe("free_cap_reached");
  });
  it("402 credit_exhausted on the X-Flux-Hold-Reason header only (metering on) or in the dict body (metering off); credit_unresolved; a hold", () => {
    expect(fluxRefusalCode({ status: 402, message: "Your Flux credit is used up. Top up at https://fluxrouter.ai/home/billing", headers: { "X-Flux-Hold-Reason": "credit_exhausted" } })).toBe("credit_exhausted");
    expect(fluxRefusalCode({ error: "credit_exhausted", message: "Credit exhausted", upgrade_url: "https://fluxrouter.ai/home/billing" })).toBe("credit_exhausted");
    expect(fluxRefusalCode({ code: "credit_unresolved", message: "We could not confirm your credit." })).toBe("credit_unresolved");
    expect(fluxRefusalCode({ headers: { "x-flux-hold-reason": "concurrency", "Retry-After": "12" }, message: "Not enough credit is available because other requests have temporarily reserved it. Retry in 12s." })).toBe("hold");
    expect(fluxRefusalCode("API error (status 429): Too Many Requests")).toBeUndefined();
    expect(fluxRefusalFinal("free_cap_reached") && fluxRefusalFinal("credit_exhausted") && fluxRefusalFinal("credit_unresolved")).toBe(true);
    expect(fluxRefusalFinal("hold") || fluxRefusalFinal(undefined)).toBe(false);
  });
  it("the card reads the structured code when the sanitised errorText lost it", () => {
    const sanitised = with_("Your account's monthly free-tier token allowance is exhausted. Upgrade at fluxrouter.ai link to continue.");
    expect(gatewayBusy({ ...sanitised, gatewayCode: "free_cap_reached" }, { resetsAt: null })).toBe("freeCap");
    expect(gatewayBusy({ ...with_("Top up at fluxrouter.ai link"), gatewayCode: "credit_exhausted" }, { resetsAt: null })).toBe("credit");
    expect(gatewayBusy({ ...with_("API error"), gatewayCode: "hold" }, { resetsAt: null })).toBe("hold");
    expect(gatewayBusy({ ...with_("API error", claude), gatewayCode: "free_cap_reached" }, { resetsAt: null })).toBeNull();
  });
  it("the shared retry policy never resends a final Flux refusal, whatever its status says; a plain 429 stays transient", () => {
    expect(classifyError(Object.assign(new Error("HTTP 429"), { data: { http_status: 429, message: LITELLM_REPR, flux_code: "free_cap_reached" } }))).toEqual({ transient: false, reason: "quota" });
    expect(classifyError(Object.assign(new Error("HTTP 402"), { data: { http_status: 402, message: "Top up", flux_code: "credit_exhausted" } }))).toEqual({ transient: false, reason: "quota" });
    // Astra r4: the words alone, on a route that is not Flux (no flux_code), leave the status reading as it was.
    expect(classifyError(Object.assign(new Error("HTTP 429"), { data: { http_status: 429, message: LITELLM_REPR } })).transient).toBe(true);
    // A hold is not final: one more send is allowed.
    expect(classifyError(Object.assign(new Error("HTTP 429"), { data: { http_status: 429, message: "Not enough credit", flux_code: "hold" } })).transient).toBe(true);
    // Astra r5: a header-only hold carried as flux_code "hold" reads back as the hold.
    expect(fluxRefusalCode({ http_status: 429, message: "Not enough credit", flux_code: "hold" })).toBe("hold");
    expect(classifyError(Object.assign(new Error("HTTP 429"), { data: { http_status: 429, message: "slow down" } })).transient).toBe(true);
  });
});

describe("the busy card survives the trip from the server to the app", () => {
  const row = { id: "m1", role: "bot", kind: "activity", text: "", turnId: "t1", createdAt: "2026-11-06T00:00:00.000Z",
    tool: { name: "error: Fuigo", ok: false, busy: { engine: "Fuigo", reason: "freeCap" } } } as unknown as Message;
  it("stored and read back (messages.db), and on the wire (message and message.patch frames, pages)", () => {
    expect(rowToMessage({ seq: 3, json: storedJson(row) }).tool?.busy).toEqual({ engine: "Fuigo", reason: "freeCap" });
    const seq = { threadNumbered: () => true, newestSeq: () => 3, messageSeq: () => 3 } as unknown as SeqStore;
    for (const slim of [true, false]) {
      const wired = wireThread(seq, "th", { message: row }, { slim }).message as Message;
      expect(wired.tool?.busy).toEqual({ engine: "Fuigo", reason: "freeCap" });
    }
    const page = wireThread(seq, "th", { messages: [row] }).messages as Message[];
    expect(page[0].tool?.busy?.reason).toBe("freeCap");
  });
});

it("monthly allowance words alone keep the free-cap copy even after the state was stripped", () => {
  expect(gatewayBusy(with_("Your account's monthly free-tier token allowance is exhausted."), { resetsAt: null })).toBe("freeCap");
});
