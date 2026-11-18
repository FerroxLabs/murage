// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudHomeCopy } from "./copy.ts";
import {
  FENCE_UNAVAILABLE_MESSAGE, FLUX_REFUSAL_CODES, SERVICE_HOLD_MESSAGE, TRY_AGAIN_SOON_MESSAGE,
  classifyFluxRefusal, classifyFluxRefusalFromRpcError, creditsUsedMessage, fluxRefusalLogLine, reportFluxRefusal,
} from "./flux-credit-refusal.ts";
import { acpRpcErrorMessage } from "../drivers/acp/core.ts";

const ROUTER_TEXT = "Key budget reached for key flux-key-name-secret. Manage at https://fluxrouter.ai/manage/abc";
const budgetBody = (extra: Record<string, unknown> = {}) => ({
  error: { message: ROUTER_TEXT, type: "budget", provider_specific_fields: { error: "key_budget_reached", resets_at: "2026-11-01T00:00:00Z", manage_url: "https://fluxrouter.ai/manage/abc", key_id: "kid_123", key_name: "home-secret-name", ...extra } },
});
// The approved line names Flux by design (Sean's copy), so it is held to the same list minus the router's name.
const NEVER_NO_NAME = /manage_url|kid_123|home-secret-name|sk-flux|https?:|\u2013|\u2014|\bsafe\b|\bunsafe\b|\bsafety\b|\bkey\b|\bBYOK\b|provider settings|HTTP 40[123]/i;
const NEVER = /flux|fluxrouter|manage_url|kid_123|home-secret-name|sk-flux|https?:|\u2013|\u2014|\bsafe\b|\bunsafe\b|\bsafety\b|\bkey\b/i;

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("402 key_budget_reached: this home's credits for the month are used", () => {
  it("says the credits come back on the reset date and how to carry on, with none of the router's text", () => {
    const refusal = classifyFluxRefusal({ status: 402, body: budgetBody(), headers: new Headers() });
    expect(refusal).toMatchObject({ kind: "credits_used", retryable: false, errorCode: null, resetsAt: "2026-11-01T00:00:00.000Z" });
    expect(refusal!.message).toBe(`You've used this month's credits. They come back on November 1. ${cloudHomeCopy.creditsCarryOn}`);
    expect(refusal!.message).not.toMatch(NEVER);
  });
  it("reads the body from text, and finds the fields wherever the router nests them", () => {
    expect(classifyFluxRefusal({ status: 402, body: JSON.stringify(budgetBody()) })?.kind).toBe("credits_used");
    expect(classifyFluxRefusal({ status: 402, body: { provider_specific_fields: { error: "key_budget_reached", resets_at: "2026-12-05T10:00:00+02:00" } } })?.message)
      .toContain("They come back on December 5.");
  });
  it("leaves the carry-on sentence out when the home offers no sign-in engine", () => {
    expect(creditsUsedMessage({ resetsAt: "2026-11-01T00:00:00Z", carryOn: false })).toBe("You've used this month's credits. They come back on November 1.");
  });
  it("a missing or unreadable reset date still says credits are used, never a raw date or the router's text", () => {
    for (const resets_at of [undefined, "", "soon", "9999-99-99", 12, null, "x".repeat(200)]) {
      const refusal = classifyFluxRefusal({ status: 402, body: budgetBody({ resets_at }) });
      expect(refusal?.kind).toBe("credits_used");
      expect(refusal!.resetsAt).toBeNull();
      expect(refusal!.message).toContain("They come back when your month resets.");
      expect(refusal!.message).not.toMatch(NEVER);
    }
  });
  it("is not retried: the answer is not retryable and the retry classifier calls a 402 quota", async () => {
    expect(classifyFluxRefusal({ status: 402, body: budgetBody() })!.retryable).toBe(false);
    const { classifyError } = await import("../drivers/retry.ts");
    expect(classifyError({ data: { http_status: 402 } } as never).transient).toBe(false);
  });
});

describe("402 with X-Flux-Hold-Reason: the shared service stopped", () => {
  it("is on our side, never credits used up, and carries an errorCode to alarm on", () => {
    for (const headers of [new Headers({ "X-Flux-Hold-Reason": "incident" }), { "x-flux-hold-reason": "incident" }, { "X-FLUX-HOLD-REASON": ["incident"] }, [["X-Flux-Hold-Reason", "incident"]]]) {
      const refusal = classifyFluxRefusal({ status: 402, body: budgetBody(), headers });
      expect(refusal).toMatchObject({ kind: "service_hold", message: SERVICE_HOLD_MESSAGE, retryable: false, errorCode: FLUX_REFUSAL_CODES.serviceHold });
      expect(refusal!.message).not.toMatch(/credits|used/i);
      expect(refusal!.message).not.toMatch(NEVER);
    }
  });
  it("wins over a budget body, so a held service is never called used-up credits", () => {
    expect(classifyFluxRefusal({ status: 402, body: budgetBody(), headers: { "X-Flux-Hold-Reason": "x" } })!.kind).toBe("service_hold");
  });
  it("an empty header is no hold", () => {
    expect(classifyFluxRefusal({ status: 402, body: budgetBody(), headers: { "X-Flux-Hold-Reason": " " } })!.kind).toBe("credits_used");
  });
  it("logs the errorCode and nothing from the answer", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const refusal = classifyFluxRefusal({ status: 402, body: budgetBody(), headers: { "X-Flux-Hold-Reason": "secret-reason" } })!;
    reportFluxRefusal(refusal);
    expect(spy).toHaveBeenCalledWith(`Cloud model service refusal errorCode=${FLUX_REFUSAL_CODES.serviceHold} kind=service_hold`);
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/secret-reason|fluxrouter|kid_123/);
    expect(fluxRefusalLogLine(classifyFluxRefusal({ status: 402, body: budgetBody() })!)).toBeNull();
  });
  it("logs nothing off a Cloud home", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    reportFluxRefusal(classifyFluxRefusal({ status: 402, headers: { "X-Flux-Hold-Reason": "x" } })!);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("503 key_fence_unavailable: retryable, says nothing about credits", () => {
  it("is retryable with a plain sentence", () => {
    for (const body of [{ error: { code: "key_fence_unavailable", message: ROUTER_TEXT } }, { error: "key_fence_unavailable" }, { provider_specific_fields: { error: "key_fence_unavailable" } }, JSON.stringify({ error: { type: "key_fence_unavailable" } })]) {
      const refusal = classifyFluxRefusal({ status: 503, body });
      expect(refusal).toMatchObject({ kind: "fence_unavailable", message: FENCE_UNAVAILABLE_MESSAGE, retryable: true, errorCode: FLUX_REFUSAL_CODES.fenceUnavailable });
      expect(refusal!.message).not.toMatch(/credit|used|month/i);
      expect(refusal!.message).not.toMatch(NEVER);
    }
  });
  it("a 503 that is not the fence is not ours", () => {
    expect(classifyFluxRefusal({ status: 503, body: { error: "overloaded" } })).toBeNull();
    expect(classifyFluxRefusal({ status: 503, body: "<html>upstream</html>" })).toBeNull();
  });
});

describe("a missing or odd field falls back, never to raw text", () => {
  it("an unrecognised 402 from the router gets the plain try-again sentence", () => {
    for (const body of [undefined, "", "not json", "[1,2", {}, { error: "other" }, { error: { provider_specific_fields: { error: 7 } } }, budgetBodyWithout()]) {
      const refusal = classifyFluxRefusal({ status: 402, body }, { fromRouter: true });
      expect(refusal).toMatchObject({ kind: "payment_other", message: TRY_AGAIN_SOON_MESSAGE, retryable: false, errorCode: FLUX_REFUSAL_CODES.paymentOther });
      expect(refusal!.message).not.toMatch(NEVER_NO_NAME);
    }
  });
  it("without fromRouter an unrecognised 402 is left to the caller (a customer's own provider keeps its own words)", () => {
    expect(classifyFluxRefusal({ status: 402, body: { error: "other" } })).toBeNull();
  });
  it("a Flux 401, 402 or 403 on a Cloud home is the one approved line, and a plain provider 401 or 403 is left alone", () => {
    const approved = "Your Flux credit is still getting ready. Try again in a minute; if it keeps happening, we've been told and are on it.";
    expect(TRY_AGAIN_SOON_MESSAGE).toBe(approved);
    for (const status of [401, 402, 403]) {
      for (const options of [{ fromRouter: true }, { owned: true }]) {
        expect(classifyFluxRefusal({ status, body: { error: "other" } }, options), `${status} ${JSON.stringify(options)}`).toMatchObject({ kind: "payment_other", message: approved });
      }
      expect(classifyFluxRefusal({ status, body: { error: { code: "cloud_home_unfunded" } } }), `${status} unfunded`).toMatchObject({ message: approved });
      expect(classifyFluxRefusal({ status, body: { error: "other" } }), `${status} not Flux`).toBeNull();
    }
    expect(classifyFluxRefusal({ status: 401, body: {} }, { owned: true })!.errorCode).toBeNull();
  });
  it("other statuses and garbage input are not ours", () => {
    for (const raw of [{ status: 200 }, { status: 429, body: budgetBody() }, { status: "402" }, {}, { status: 402, headers: 5 }]) {
      expect(classifyFluxRefusal(raw as never)).toBeNull();
    }
  });
  it("a deeply nested or oversized body does not hang or throw", () => {
    let deep: unknown = { provider_specific_fields: { error: "key_budget_reached" } };
    for (let i = 0; i < 50; i++) deep = { nested: deep };
    expect(() => classifyFluxRefusal({ status: 402, body: deep }, { fromRouter: true })).not.toThrow();
    expect(classifyFluxRefusal({ status: 402, body: "{" + "a".repeat(100_000) }, { fromRouter: true })!.kind).toBe("payment_other");
  });
});

describe("every customer sentence is plain words", () => {
  it("has no router name, key words, links, dashes or banned words", () => {
    const sentences = [creditsUsedMessage({ resetsAt: "2026-11-01T00:00:00Z" }), creditsUsedMessage(), SERVICE_HOLD_MESSAGE, FENCE_UNAVAILABLE_MESSAGE,
      ...Object.entries(cloudHomeCopy).filter(([name]) => /^(flux|creditsCarryOn|signInEnginesNoFlux)/.test(name)).map(([, text]) => text)];
    for (const text of sentences) expect(text).not.toMatch(NEVER);
    expect(TRY_AGAIN_SOON_MESSAGE).not.toMatch(NEVER_NO_NAME);
  });
});

describe("through the engine error path on a Cloud home", () => {
  it("an engine error carrying the raw fields is worded by us", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const credits = acpRpcErrorMessage({ message: "Internal error", data: { http_status: 402, message: ROUTER_TEXT, body: budgetBody() } });
    expect(credits).toBe(`You've used this month's credits. They come back on November 1. ${cloudHomeCopy.creditsCarryOn}`);
    const hold = acpRpcErrorMessage({ message: "Internal error", data: { http_status: 402, message: ROUTER_TEXT, headers: { "x-flux-hold-reason": "incident" } } });
    expect(hold).toBe(SERVICE_HOLD_MESSAGE);
    const fence = acpRpcErrorMessage({ message: "Internal error", data: { http_status: 503, body: { error: { code: "key_fence_unavailable" } } } });
    expect(fence).toBe(FENCE_UNAVAILABLE_MESSAGE);
  });
  it("a router 402 whose fields did not come through gets the plain try-again sentence, never the router's text", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const text = acpRpcErrorMessage({ message: "Internal error", data: { http_status: 402, message: "monthly spend ceiling reached. See https://fluxrouter.ai/home/billing" } });
    expect(text).toBe(TRY_AGAIN_SOON_MESSAGE);
    expect(classifyFluxRefusalFromRpcError({ data: { http_status: 402, message: "x" } })).toBeNull();
  });
  it("a customer's own provider 402 keeps its own wording", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    // Desktop 1.0.12 L-COPY-C put every non-Flux provider's credit refusal into one plain sentence (no provider text);
    // what this guards is that a customer's own provider is never given the Flux wording (the reset date, the carry-on line).
    const text = acpRpcErrorMessage({ message: "Internal error", data: { http_status: 402, message: "credit balance is exhausted" } });
    expect(text).toBe("Your AI service says the account is out of credit. Add credit with your AI service, then try again, or pick another AI.");
    expect(text).not.toContain(cloudHomeCopy.creditsCarryOn);
  });
});

function budgetBodyWithout() { return { error: { provider_specific_fields: { resets_at: "2026-11-01T00:00:00Z" } } }; }
