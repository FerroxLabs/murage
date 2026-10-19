// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Astra lane2-build r2 H1: "Use Flux memory" switched off reaches work already underway. The Flux memory headers and envelope are decided
// at the moment each HTTP request leaves (every redirect hop, every retry), never reused from dispatch. The real openai-chat transport
// behind the memory adapter, against a stubbed fetch standing in for Flux (no real key).
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MEMORY_REFERENCE_CLOSE, MEMORY_REFERENCE_OPEN, MEMORY_REFERENCE_PREAMBLE, type MemoryBundle } from "../../shared/memory.ts";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";
import { clearFluxMemoryReports, setFluxExternalMemory } from "../flux-memory-envelope.ts";
import { fluxMemoryAtSend, fluxMemorySend, setFluxMemorySettings } from "../flux-memory-headers.ts";
import { decorateMemoryInstance } from "../harness/memory-adapter.ts";
import { recordEvents } from "../testing/events.ts";

const item = (n: number) => `- m${n} (you said; note) ${JSON.stringify(`fact number ${n}`)}`;
const block = (items: string[]) => [MEMORY_REFERENCE_PREAMBLE, MEMORY_REFERENCE_OPEN, ...items, MEMORY_REFERENCE_CLOSE].join("\n");

type Sent = { url: string; body: Record<string, unknown>; headers: Headers };
const ok = () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
const isOff = (request: Sent) => request.headers.get("x-flux-memory-capture") === "off" && request.headers.get("x-flux-memory-inject") === "off";
const envelopeOf = (request: Sent) => (request.body.metadata as { flux_memory?: { mode: string } } | undefined)?.flux_memory;

describe("Flux memory decided at every request write (openai-chat)", () => {
  const instances: ProviderInstance[] = [];
  let previousFetch: typeof globalThis.fetch;
  let sent: Sent[] = [];
  /** answers request n (0-based); may await, and may flip the switch while the request is out */
  let answer: (n: number) => Promise<Response> = async () => ok();

  beforeEach(() => {
    ensureDirs();
    clearFluxMemoryReports();
    setFluxExternalMemory(undefined);
    setFluxMemorySettings({});
    previousFetch = globalThis.fetch;
    sent = [];
    answer = async () => ok();
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers) });
      return answer(sent.length - 1);
    }) as typeof fetch;
  });
  afterEach(async () => {
    globalThis.fetch = previousFetch;
    setFluxExternalMemory(undefined);
    setFluxMemorySettings({});
    for (const instance of instances.splice(0)) await instance.dispose();
  });

  const fluxRoute = { connectionId: "c1", preset: "flux" as const, protocol: "openai" as const, baseUrl: "https://api.fluxrouter.ai/v1", apiKey: "sk-flux-stub", model: "flux-auto", revision: "r1" };
  const otherRoute = { ...fluxRoute, preset: "openai" as const, baseUrl: "https://api.openai.com/v1", apiKey: "sk-other-stub", model: "gpt-stub" };

  const owner = { botId: "b1", audience: "owner" as const, decidedOwner: true };
  const turn = async (recall: string, providerRoute: typeof fluxRoute | typeof otherRoute, threadId = "t-flux-env", warmIdentity: NonNullable<SendTurnInput["warmIdentity"]> = owner) => {
    const raw = createOpenAIChatRuntime({
      input: { instanceId: "compat-test", displayName: "Compat", environment: {}, enabled: true, config: {} },
      driverKind: "openai-compat",
      apiKey: "unused",
      apiUrl: "https://chat.invalid/v1",
      models: () => ({ default: "flux-auto", options: [{ id: "flux-auto", label: "Flux auto" }] }),
      requestBody: (model, messages, stream) => ({ model, messages, stream }),
      httpErrorLabel: "Test",
      missingKeyError: "missing key",
      unavailableReason: "no key",
      timeoutMs: 10_000,
      retryScale: 0,
      includeUsageInCompleted: true,
      nativeLog: { source: "test.chat.completions", outgoing: (_t, messages, model) => ({ model, messages }), incoming: ({ text, usage }) => ({ text, usage }) },
    });
    const live = decorateMemoryInstance(raw);
    instances.push(live);
    const recorder = recordEvents(live.adapter);
    const memoryContext = recall
      ? ({ bundleId: "b1", text: recall, policyRevision: 1, deletionEpoch: 0, tokenCount: 1, recordVersions: [], sourceVersions: [] } as MemoryBundle)
      : undefined;
    await live.adapter.sendTurn({ threadId, text: "question", providerRoute, warmIdentity, ...(memoryContext ? { memoryContext } : {}) });
    const done = await recorder.until((event) => event.type === "turn.completed");
    recorder.stop();
    return done;
  };

  const recall = block([item(1), item(2)]);

  it("switched off while awaiting a 307: the redirected POST carries the off headers and no envelope", async () => {
    answer = async (n) => {
      if (n > 0) return ok();
      await new Promise((resolve) => setTimeout(resolve, 5));
      setFluxExternalMemory(false);
      return new Response(null, { status: 307, headers: { location: "https://api.fluxrouter.ai/v1/chat/completions?hop=2" } });
    };
    const done = await turn(recall, fluxRoute, "t-307");
    expect(done).toMatchObject({ type: "turn.completed", ok: true });
    expect(sent).toHaveLength(2);
    // dispatched with the switch on: the first write carried Flux memory
    expect(envelopeOf(sent[0]!)).toMatchObject({ mode: "on" });
    expect(isOff(sent[0]!)).toBe(false);
    // the hop after the switch went off: off/off, no envelope
    expect(sent[1]!.url).toContain("hop=2");
    expect(isOff(sent[1]!)).toBe(true);
    expect(envelopeOf(sent[1]!)).toBeUndefined();
    expect(sent[1]!.body.metadata).toBeUndefined();
  });

  it("switched off while a request fails with a 5xx: the retry carries the off headers and no envelope", async () => {
    answer = async (n) => {
      if (n > 0) return ok();
      setFluxExternalMemory(false);
      return new Response("upstream busy", { status: 503 });
    };
    const done = await turn(recall, fluxRoute, "t-503");
    expect(done).toMatchObject({ type: "turn.completed", ok: true });
    expect(sent).toHaveLength(2);
    expect(envelopeOf(sent[0]!)).toMatchObject({ mode: "on" });
    expect(isOff(sent[1]!)).toBe(true);
    expect(envelopeOf(sent[1]!)).toBeUndefined();
  });

  it("the kill switch turned on mid-turn reaches the next hop too", async () => {
    answer = async (n) => {
      if (n > 0) return ok();
      setFluxMemorySettings({ killSwitch: true });
      return new Response(null, { status: 308, headers: { location: "https://api.fluxrouter.ai/v1/chat/completions?hop=2" } });
    };
    await turn(recall, fluxRoute, "t-kill");
    expect(sent).toHaveLength(2);
    expect(isOff(sent[1]!)).toBe(true);
    expect(envelopeOf(sent[1]!)).toBeUndefined();
  });

  it("switch unchanged: every hop keeps the turn's Flux memory", async () => {
    answer = async (n) => n > 0 ? ok() : new Response(null, { status: 307, headers: { location: "https://api.fluxrouter.ai/v1/chat/completions?hop=2" } });
    await turn(recall, fluxRoute, "t-same");
    expect(sent).toHaveLength(2);
    for (const request of sent) {
      expect(isOff(request)).toBe(false);
      expect(envelopeOf(request)).toMatchObject({ mode: "on" });
    }
  });

  it("never widens past dispatch: off at dispatch stays off on a hop after the switch comes back on", () => {
    setFluxExternalMemory(false);
    const send = fluxMemorySend({ audience: "owner" }, { envelope: { mode: "on" } });
    setFluxExternalMemory(true);
    const now = fluxMemoryAtSend(send);
    expect(now.decision).toMatchObject({ capture: "off", inject: "off" });
    expect(now.envelope).toBeUndefined();
  });
});
