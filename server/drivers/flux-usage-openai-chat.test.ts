// control: legacy cases retain their original assertions unless individually labelled red-at-4df086541 below.
import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// USAGE-TAGS (1.0.10): the real openai-chat transport against a stubbed fetch standing in for Flux (a fake key, no network). Every
// request of a turn carries x-flux-bot-id / x-flux-feature / x-flux-thread-id, and the model Flux answered with (x-flux-routed-model
// beside x-flux-original-model, read when the response starts) reaches the turn as "turn.served-model".
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { setFluxMemorySettings } from "../flux-memory-headers.ts";
import { fluxThreadIdValue } from "../flux-usage-tags.ts";
import { recordEvents } from "../testing/events.ts";
import { createOpenAIChatRuntime } from "../testing/bound-openai-fixture.ts";
import { qualifyPromptCache } from "../../scripts/prompt-cache-qualify.ts";

type Sent = { url: string; headers: Headers };
const reply = (headers: Record<string, string> = {}) =>
  new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream", ...headers } });

describe("usage tags and the served model on an openai-compat turn", () => {
  const instances: ProviderInstance[] = [];
  let previousFetch: typeof globalThis.fetch;
  let sent: Sent[] = [];
  let answer: () => Response = () => reply();

  beforeEach(() => {
    ensureDirs();
    setFluxMemorySettings({});
    previousFetch = globalThis.fetch;
    sent = [];
    answer = () => reply();
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(input), headers: new Headers(init?.headers) });
      return answer();
    }) as typeof fetch;
  });
  afterEach(async () => {
    globalThis.fetch = previousFetch;
    setFluxMemorySettings({});
    for (const instance of instances.splice(0)) await instance.dispose();
  });

  const fluxRoute = { connectionId: "c1", preset: "flux" as const, protocol: "openai" as const, baseUrl: "https://api.fluxrouter.ai/v1", apiKey: "sk-flux-fake", model: "deepseek-v4", revision: "r1" };
  const otherRoute = { ...fluxRoute, preset: "openai" as const, baseUrl: "https://api.openai.com/v1", apiKey: "sk-other-fake", model: "gpt-fake" };

  const run = async (input: Partial<SendTurnInput> & { providerRoute: typeof fluxRoute | typeof otherRoute }): Promise<RuntimeEvent[]> => {
    const live = createOpenAIChatRuntime({
      input: { instanceId: "compat-usage", displayName: "Compat", environment: {}, enabled: true, config: {} },
      driverKind: "openai-compat",
      apiKey: "unused",
      apiUrl: "https://chat.invalid/v1",
      models: () => ({ default: "deepseek-v4", options: [{ id: "deepseek-v4", label: "DeepSeek V4" }] }),
      requestBody: (model, messages, stream) => ({ model, messages, stream }),
      httpErrorLabel: "Test",
      missingKeyError: "missing key",
      unavailableReason: "no key",
      timeoutMs: 10_000,
      retryScale: 0,
      includeUsageInCompleted: true,
      nativeLog: { source: "test.chat.completions", outgoing: (_t, messages, model) => ({ model, messages }), incoming: ({ text, usage }) => ({ text, usage }) },
    });
    instances.push(live);
    const recorder = recordEvents(live.adapter);
    await live.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "thread-usage", text: "question", warmIdentity: { botId: "bot-7f3a", audience: "owner", decidedOwner: true }, ...input });
    await recorder.until((event) => event.type === "turn.completed");
    recorder.stop();
    return recorder.events;
  };

  it("PC-F7 fake-provider qualification consumes the real adapter's terminal cache usage", async () => {
    const report = await qualifyPromptCache(async ({ system, scenario }) => {
      const usage = { prompt_tokens: 100, completion_tokens: 3, prompt_tokens_details: { cached_tokens: scenario === "warm" ? 80 : 0 } };
      answer = () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage }), { headers: { "content-type": "application/json" } });
      const done = (await run({ providerRoute: otherRoute, system })).find(event => event.type === "turn.completed");
      if (!done || done.type !== "turn.completed" || !done.usage) throw new Error("fixture adapter omitted terminal usage");
      return done.usage;
    }, [{ id: "house-rules", text: "PRIVATE_QUALIFICATION_SENTINEL" }]);
    expect(sent).toHaveLength(8);
    expect(sent.every(request => request.url.startsWith(otherRoute.baseUrl))).toBe(true);
    expect(report).toMatchObject({ samples: 8, knownSamples: 8, knownInput: 800, cachedRead: 400, tokenShare: 0.5, prefixStable: true, configurationChanged: true, audienceChanged: true });
    expect(JSON.stringify(report)).not.toContain("PRIVATE_QUALIFICATION_SENTINEL");
  });

  it("PC-R2-openai-cache-100-80", async () => {
    answer = () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 80 } } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    const events = await run({ providerRoute: otherRoute });
    expect(events.find(event => event.type === "turn.completed")).toMatchObject({ usage: { input: 100, output: 3, cachedInput: 80, usageAccounting: { version: 1, inputComplete: true, cacheComplete: true } } });
  });

  it.each(["stream", "json"])("PC-F1: %s reply preserves one valid cache count, including repeated streaming snapshots", async format => {
    const usage = { prompt_tokens: 100, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 80 } };
    answer = () => format === "json"
      ? new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage }), { headers: { "content-type": "application/json" } })
      : new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage })}\n\ndata: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    const events = await run({ providerRoute: otherRoute });
    expect(events.filter(e => e.type === "turn.completed")).toHaveLength(1);
    expect(events.find(e => e.type === "turn.completed")).toMatchObject({ usage: { input: 100, output: 3, cachedInput: 80, usageAccounting: { version: 1, inputComplete: true, cacheComplete: true } } });
  });
  it.each([undefined, null, -1, 0.5, 101, "80"])("PC-F1: cached wire value %s remains unreported", async cached_tokens => {
    answer = () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 3, prompt_tokens_details: { cached_tokens } } }), { headers: { "content-type": "application/json" } });
    const done = (await run({ providerRoute: otherRoute })).find(e => e.type === "turn.completed") as { usage?: unknown };
    expect(done.usage).toMatchObject({ input: 100, output: 3, usageAccounting: { version: 1, inputComplete: true, cacheComplete: false } });
    expect(done.usage).not.toHaveProperty("cachedInput");
  });

  it("a chat turn on Flux carries the bot, the chat feature and the opaque conversation tag", async () => {
    await run({ providerRoute: fluxRoute });
    expect(sent).toHaveLength(1);
    const headers = sent[0]!.headers;
    expect(headers.get("x-flux-feature")).toBe("chat");
    expect(headers.get("x-flux-bot-id")).toBe("bot-7f3a");
    expect(headers.get("x-flux-thread-id")).toBe(fluxThreadIdValue("thread-usage"));
    expect(headers.get("x-flux-thread-id")).not.toContain("thread-usage");
    expect(headers.get("x-flux-memory-app")).toBe("murage");
  });

  it("a routine turn says routine; a malformed bot id is dropped, never sent", async () => {
    await run({ providerRoute: fluxRoute, background: true, usageFeature: "routine", warmIdentity: { botId: "not a bot id", audience: "owner", decidedOwner: true } });
    expect(sent[0]!.headers.get("x-flux-feature")).toBe("routine");
    expect(sent[0]!.headers.get("x-flux-bot-id")).toBeNull();
  });

  it("a request to another provider carries no Flux tags", async () => {
    await run({ providerRoute: otherRoute });
    for (const name of ["x-flux-feature", "x-flux-bot-id", "x-flux-thread-id"]) expect(sent[0]!.headers.get(name)).toBeNull();
  });

  it("reports the model Flux answered with when it is not the one asked for", async () => {
    answer = () => reply({ "x-flux-routed-model": "claude-sonnet-5", "x-flux-original-model": "deepseek-v4" });
    const events = await run({ providerRoute: fluxRoute });
    const served = events.filter((event) => event.type === "turn.served-model");
    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({ routed: "claude-sonnet-5", requested: "deepseek-v4" });
    // reported before the reply text, so the reply row stores it
    const order = events.map((event) => event.type);
    expect(order.indexOf("turn.served-model")).toBeLessThan(order.findIndex((type) => type === "item.completed"));
  });

  it("reports a matching pair too (stored for Usage), and nothing without both headers", async () => {
    answer = () => reply({ "x-flux-routed-model": "deepseek-v4", "x-flux-original-model": "deepseek-v4" });
    expect((await run({ providerRoute: fluxRoute })).filter((event) => event.type === "turn.served-model")).toHaveLength(1);
    answer = () => reply({ "x-flux-routed-model": "deepseek-v4" });
    expect((await run({ providerRoute: fluxRoute })).filter((event) => event.type === "turn.served-model")).toHaveLength(0);
  });
});

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();
