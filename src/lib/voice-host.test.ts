import { describe, expect, it } from "vitest";

import { CALL_BUDGET_STOP, isBudgetFailure, openingOf, plainFailure } from "./voice-host";

describe("an engine failure, said on a call", () => {
  it.each([
    [
      "API error (status 429 Too Many Requests): subscription:free-usage-exhausted: You've used all the included free usage for model grok-4.7 for now. Usage resets…\nA",
      "You've used all the included free usage for model grok-4.7 for now.",
    ],
    ["error: Grok CLI is not signed in: run `grok login` in a terminal", "Grok CLI is not signed in: run grok login in a terminal"],
    ["This bot's model needs an AI provider connected first. Open Settings → Models to connect one.", "This bot's model needs an AI provider connected first."],
    ["", "The engine reported an error."],
  ])("%s", (details, said) => {
    expect(plainFailure(details)).toBe(said);
  });
});

describe("the opening of a long answer, when it cannot be told briefly", () => {
  it("reads the first paragraph of prose and points at the chat", () => {
    const answer = "It is 1:34pm in Bangkok. Nothing else is booked after 2:00.\n\n**Still on the day**\n\n- All day: Home\n- 1:30 buffer";
    expect(openingOf(answer)).toBe("It is 1:34pm in Bangkok. Nothing else is booked after 2:00. The rest is in the chat.");
    expect(openingOf("## Heading\n\n- one\n- two\n\nPlain words here.")).toBe("Plain words here. The rest is in the chat.");
  });
});

describe("the host request body", () => {
  it("a 1:1 turn sends no groupId key at all, and a room turn sends it", async () => {
    const { vi } = await import("vitest");
    const { hostTurn } = await import("./voice-host");
    const fetchMock = vi.fn(async () => new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await hostTurn("moss", { text: "hi", history: [] }, () => undefined);
      await hostTurn("moss", { text: "hi", history: [], groupId: "g1", roomHeard: [] }, () => undefined);
      const calls = fetchMock.mock.calls as unknown as Array<[string, { body: string }]>;
      const one = JSON.parse(calls[0][1].body);
      expect("groupId" in one).toBe(false);
      expect("roomHeard" in one).toBe(false);
      expect(JSON.parse(calls[1][1].body).groupId).toBe("g1");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("a turn that failed for the key's budget ends the call (VOICE-402-STOP)", () => {
  it.each([
    "error: API error (status 402 Payment Required): Key budget exceeded",
    "Flux returned 402: insufficient_balance",
    "You exceeded your current quota, please check your plan and billing details.",
    "This key has reached its budget.",
  ])("does not infer from prose: %s", (details) => expect(isBudgetFailure(details)).toBe(false));

  it.each([
    "API error (status 429 Too Many Requests): slow down",
    "Grok CLI is not signed in: run `grok login` in a terminal",
    "error: The model took too long.",
  ])("not %s", (details) => expect(isBudgetFailure(details)).toBe(false));

  it("accepts only the typed Flux signal", () => {
    expect(isBudgetFailure({ provider: "flux-router", fluxBudget: true })).toBe(true);
    expect(isBudgetFailure({ kind: "payment", httpStatus: 402 })).toBe(false);
  });

  it("says one plain line", () => {
    expect(CALL_BUDGET_STOP).not.toMatch(/—|\bsafe\b|\bfree\b/i);
  });
});

it("a terminal budget event cancels the host stream before any following hand-down", async () => {
  const { vi } = await import("vitest");
  const { hostTurn } = await import("./voice-host");
  const cancel = vi.fn();
  vi.stubGlobal("fetch", async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"error","reason":"budget","message":"spent"}\n\ndata: {"type":"hand_down","request":"work"}\n\n')); }, cancel,
  })));
  try {
    const events: unknown[] = [];
    await hostTurn("bot", { text: "hi", history: [] }, e => events.push(e));
    expect(events).toEqual([{ type: "error", reason: "budget", message: "spent" }]);
    expect(cancel).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); }
});

it.each([
  [{ error: { code: "budget_exceeded", message: "spent" } }, "budget"],
  [{ error: "budget_exceeded", message: "spent" }, "budget"],
  [{ error: { code: "premium_locked", message: "plan" } }, "premium"],
  [{ error: "premium_locked", message: "plan" }, "premium"],
])("classifies an HTTP 402 before opening a host stream: %j", async (body, reason) => {
  const { vi } = await import("vitest");
  const { hostTurn } = await import("./voice-host");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status: 402 }));
  try {
    const events: unknown[] = [];
    await hostTurn("bot", { text: "hi", history: [] }, e => events.push(e));
    expect(events).toEqual([expect.objectContaining({ type: "error", reason, message: expect.any(String) })]);
  } finally { vi.unstubAllGlobals(); }
});

it("retires a terminal stream even when its budget callback throws", async () => {
  const { vi } = await import("vitest");
  const { hostTurn } = await import("./voice-host");
  const cancel = vi.fn();
  vi.stubGlobal("fetch", async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"error","reason":"budget","message":"spent"}\n\ndata: {"type":"hand_down","request":"work"}\n\n')); }, cancel,
  })));
  const callback = vi.fn(() => { throw new Error("UI failed"); });
  try {
    await hostTurn("bot", { text: "hi", history: [] }, callback);
    expect(callback).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); }
});
