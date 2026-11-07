import { beforeEach, expect, it, vi } from "vitest";
import { warmVoiceHost, type VoiceHostEvent, type VoiceHostState } from "./voice-host.ts";
import { runVoiceBrief, runVoiceHostTurn } from "../testing/protected-host.ts";
import { isBudgetReached, markBudgetReached, resetUnavailable, type VoiceEndpoint } from "./voice-routes.ts";
const host: VoiceEndpoint = { via: "flux", label: "Flux", baseUrl: "http://mock.invalid/v1", key: "mock", model: "host" };
const lookup = { ...host, model: "lookup" };
const state: VoiceHostState = { botName: "Test", now: 0, task: { title: "", busy: false, activity: [] }, recent: [], otherTasks: [], needsYou: [] };
const options = { host, lookup, state, history: [], said: "What is the weather?" };
const collect = async (stream: AsyncGenerator<VoiceHostEvent>) => { const events = []; for await (const event of stream) events.push(event); return events; };
const sse = (...frames: unknown[]) => new Response(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const text = { choices: [{ delta: { content: "Let me check. " } }] };
const tool = { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "quick_lookup", arguments: '{"query":"weather"}' } }] } }] };
const shapes = [{ error: { code: "budget_exceeded", message: "spent" } }, { error: "key_budget_reached", message: "spent" }, { error: "Payment required", code: "key_budget_reached" }];
beforeEach(resetUnavailable);
for (const shape of shapes) {
  it(`stops HTTP 402 and memoizes ${JSON.stringify(shape)}`, async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(shape), { status: 402 }));
    const events = await collect(runVoiceHostTurn({ ...options, fetchImpl }));
    expect(events).toEqual([expect.objectContaining({ type: "error", reason: "budget" })]);
    expect(isBudgetReached(lookup)).toBe(true);
    await collect(runVoiceHostTurn({ ...options, fetchImpl }));
    await collect(runVoiceBrief({ host, state, answer: "answer", fetchImpl }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it(`warm-up remembers ${JSON.stringify(shape)}`, async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(shape), { status: 402 }));
    await warmVoiceHost(host, fetchImpl);
    await warmVoiceHost(host, fetchImpl);
    await collect(runVoiceHostTurn({ ...options, fetchImpl }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(isBudgetReached(lookup)).toBe(true);
  });
  for (const partial of [false, true]) it(`stream budget terminates before tools (partial=${partial}, ${JSON.stringify(shape)})`, async () => {
    const fetchImpl = vi.fn(async () => sse(...(partial ? [text, tool] : []), shape, tool));
    const events = await collect(runVoiceHostTurn({ ...options, fetchImpl }));
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "budget" });
    expect(events.some(e => e.type === "hand_down" || e.type === "lookup" || e.type === "done")).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(isBudgetReached(host)).toBe(true);
  });
  it(`lookup budget never hands down ${JSON.stringify(shape)}`, async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(sse(tool)).mockResolvedValueOnce(new Response(JSON.stringify(shape), { status: 402 }));
    const events = await collect(runVoiceHostTurn({ ...options, fetchImpl }));
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "budget" });
    expect(events.some(e => e.type === "hand_down")).toBe(false);
  });
}
it("does not start a lookup with a budget memo even when host uses another key", async () => {
  markBudgetReached(lookup);
  const fetchImpl = vi.fn(async () => sse(tool));
  const events = await collect(runVoiceHostTurn({ ...options, host: { ...host, key: "other" }, fetchImpl }));
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(events.at(-1)).toMatchObject({ type: "error", reason: "budget" });
  expect(events.some(e => e.type === "hand_down")).toBe(false);
});
for (const shape of [{ error: { code: "premium_locked", message: "plan" } }, { error: "premium_locked", message: "plan" }, { error: "Plan required", code: "premium_locked" }]) it("preserves premium refusals", async () => {
  const events = await collect(runVoiceHostTurn({ ...options, fetchImpl: async () => new Response(JSON.stringify(shape), { status: 402 }) }));
  expect(events.at(-1)).toMatchObject({ type: "error", reason: "premium" });
  expect(isBudgetReached(host)).toBe(false);
});

for (const shape of shapes) for (const partial of [false, true]) it(`brief stream budget stops (partial=${partial}, ${JSON.stringify(shape)})`, async () => {
  const events = await collect(runVoiceBrief({ host, state, answer: "answer", fetchImpl: async () => sse(...(partial ? [text] : []), shape, text) }));
  expect(events.at(-1)).toMatchObject({ type: "error", reason: "budget" });
  expect(events.some(e => e.type === "done")).toBe(false);
  expect(isBudgetReached(host)).toBe(true);
});
for (const shape of shapes) for (const partial of [false, true]) it(`lookup stream budget stops (partial=${partial}, ${JSON.stringify(shape)})`, async () => {
  const fetchImpl = vi.fn().mockResolvedValueOnce(sse(tool)).mockResolvedValueOnce(sse(...(partial ? [text] : []), { object: "flux.voice.lookup.error", ...shape }));
  const events = await collect(runVoiceHostTurn({ ...options, fetchImpl }));
  expect(events.at(-1)).toMatchObject({ type: "error", reason: "budget" });
  expect(events.some(e => e.type === "hand_down" || e.type === "done")).toBe(false);
  expect(isBudgetReached(host)).toBe(true);
});
it("a new key and an expired memo can be used", async () => {
  markBudgetReached(host);
  const fetchImpl = vi.fn(async () => sse({ choices: [{ delta: { content: "Hello." } }] }));
  await collect(runVoiceHostTurn({ ...options, host: { ...host, key: "new" }, fetchImpl }));
  markBudgetReached(host, Date.now() - 11 * 60_000);
  await collect(runVoiceHostTurn({ ...options, fetchImpl }));
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it.each(["openai", "xai", "anthropic"] as const)("owner %s lookup 402 never sets Flux budget or holds the route", async via => {
  const own = { ...lookup, via, key: "owner" };
  const fetchImpl = vi.fn().mockResolvedValueOnce(sse(tool)).mockResolvedValueOnce(new Response('{}', { status: 402 })).mockResolvedValue(sse(text));
  const events = await collect(runVoiceHostTurn({ ...options, lookup: own, fetchImpl }));
  expect(events.some(e => e.type === "error" && e.reason === "budget")).toBe(false);
  expect(isBudgetReached(own)).toBe(false);
});

it("a concurrent warm-up refusal prevents the host first-token retry", async () => {
  vi.useFakeTimers();
  try {
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const pending = collect(runVoiceHostTurn({ ...options, fetchImpl }));
    await warmVoiceHost(host, async () => new Response('{"error":"key_budget_reached"}', { status: 402 }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toContainEqual(expect.objectContaining({ reason: "budget" }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});
