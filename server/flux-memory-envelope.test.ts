// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Flux memory envelope (lane 2.2): shape, 8 KB item-boundary cut, sha256, one memory block per turn
// in every case, response header read and recorded. The wire runs through the real openai-chat
// runtime behind the memory adapter against a stub fetch standing in for Flux (no real key).
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MEMORY_REFERENCE_CLOSE, MEMORY_REFERENCE_OPEN, MEMORY_REFERENCE_PREAMBLE, type MemoryBundle } from "../shared/memory.ts";
import { ensureDirs } from "./config.ts";
import type { ProviderInstance, SendTurnInput } from "./contracts.ts";
import { createOpenAIChatRuntime } from "./drivers/openai-chat.ts";
import {
  FLUX_FALLBACK_MAX_BYTES, buildFluxMemoryEnvelope, clearFluxMemoryReports, cutRecallAtItemBoundary, fluxEnvelopeApplies,
  fluxExternalMemoryOn, fluxMemoryReportFor, fluxMemorySettingState, readFluxMemoryResponse, setFluxExternalMemory,
} from "./flux-memory-envelope.ts";
import { assertNoForbiddenFluxHeaders, fluxMemoryDecision, setFluxMemorySettings } from "./flux-memory-headers.ts";
import { decorateMemoryInstance } from "./harness/memory-adapter.ts";
import { recordEvents } from "./testing/events.ts";

const item = (n: number, text = `fact number ${n}`) => `- m${n} (you said; note) ${JSON.stringify(text)}`;
const block = (items: string[]) => [MEMORY_REFERENCE_PREAMBLE, MEMORY_REFERENCE_OPEN, ...items, MEMORY_REFERENCE_CLOSE].join("\n");
const countBlocks = (text: string) => text.split(MEMORY_REFERENCE_OPEN).length - 1;
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("recall cut", () => {
  it("keeps a small block whole", () => {
    const text = block([item(1), item(2)]);
    expect(cutRecallAtItemBoundary(text)).toEqual({ text, items: 2 });
  });
  it("cuts an oversized block at an item boundary within 8,192 UTF-8 bytes", () => {
    const items = Array.from({ length: 200 }, (_, i) => item(i + 1, `${"é".repeat(40)} ${i}`));
    const cut = cutRecallAtItemBoundary(block(items))!;
    expect(Buffer.byteLength(cut.text, "utf8")).toBeLessThanOrEqual(FLUX_FALLBACK_MAX_BYTES);
    expect(cut.items).toBeGreaterThan(0);
    expect(cut.items).toBeLessThan(200);
    const lines = cut.text.split("\n");
    expect(lines.at(-1)).toBe(MEMORY_REFERENCE_CLOSE);
    expect(lines.filter((line) => line.startsWith("- m"))).toEqual(items.slice(0, cut.items));
    // one more whole item would not have fit
    expect(Buffer.byteLength(block(items.slice(0, cut.items + 1)), "utf8")).toBeGreaterThan(FLUX_FALLBACK_MAX_BYTES);
  });
  it("is null for an empty block", () => {
    expect(cutRecallAtItemBoundary("")).toBeNull();
    expect(buildFluxMemoryEnvelope("")).toEqual({ mode: "on" });
  });
  it("sha256 is over the cut text", () => {
    const envelope = buildFluxMemoryEnvelope(block(Array.from({ length: 150 }, (_, i) => item(i + 1, "x".repeat(60)))));
    const fallback = envelope.fallback_recall!;
    expect(envelope.mode).toBe("on");
    expect(fallback.sha256).toBe(sha(fallback.text));
    expect(Buffer.byteLength(fallback.text, "utf8")).toBeLessThanOrEqual(FLUX_FALLBACK_MAX_BYTES);
  });
});

describe("switch and response headers", () => {
  beforeEach(() => { setFluxMemorySettings({}); setFluxExternalMemory(undefined); });
  afterEach(() => setFluxExternalMemory(undefined));
  const route = { baseUrl: "https://api.fluxrouter.ai/v1", apiKey: "sk-flux-test" };
  it("is on by default with a key, off when saved off", () => {
    expect(fluxExternalMemoryOn()).toBe(true);
    expect(fluxEnvelopeApplies({ providerRoute: route }, { driverCarries: true })).toBe(true);
    setFluxExternalMemory(false);
    expect(fluxEnvelopeApplies({ providerRoute: route }, { driverCarries: true })).toBe(false);
  });
  it("Settings shows it on only with a Flux key: off with no key, off again once the key is removed", () => {
    expect(fluxMemorySettingState(false)).toEqual({ external: false, keyPresent: false });
    expect(fluxMemorySettingState(true)).toEqual({ external: true, keyPresent: true });
    expect(fluxMemorySettingState(false)).toEqual({ external: false, keyPresent: false });
    setFluxExternalMemory(false);
    expect(fluxMemorySettingState(true)).toEqual({ external: false, keyPresent: true });
  });
  it("the switch drives the header decision: off means capture off and inject off on the owner's turn", () => {
    const owner = { audience: "owner" as const };
    expect(fluxMemoryDecision(owner)).toMatchObject({ capture: "on", inject: "on", reason: "owner" });
    setFluxExternalMemory(false);
    expect(fluxMemoryDecision(owner)).toMatchObject({ capture: "off", inject: "off", reason: "external-off" });
    expect(fluxMemoryDecision(owner).headers).toEqual({ "x-flux-memory-app": "murage", "x-flux-memory-capture": "off", "x-flux-memory-inject": "off" });
  });
  it("with no Flux key nothing is sent: no envelope on a keyless route", () => {
    expect(fluxEnvelopeApplies({ providerRoute: { ...route, apiKey: "" } }, { driverCarries: true })).toBe(false);
  });
  it("needs a key, a Flux host and a carrying driver", () => {
    expect(fluxEnvelopeApplies({ providerRoute: route }, { driverCarries: true, hasKey: false })).toBe(false);
    expect(fluxEnvelopeApplies({ providerRoute: { baseUrl: "https://api.openai.com/v1", apiKey: "k" } }, { driverCarries: true })).toBe(false);
    expect(fluxEnvelopeApplies({ providerRoute: route }, { driverCarries: false })).toBe(false);
    expect(fluxEnvelopeApplies({ providerRoute: route, engineCommand: {} }, { driverCarries: true })).toBe(false);
    expect(fluxEnvelopeApplies({}, { driverCarries: true })).toBe(false);
  });
  it("reads x-flux-memory and its reason", () => {
    expect(readFluxMemoryResponse(new Headers({ "x-flux-memory": "Fallback", "x-flux-memory-reason": "flux-store-slow" }))).toEqual({ source: "fallback", reason: "flux-store-slow" });
    expect(readFluxMemoryResponse(new Headers({ "x-flux-memory": "flux" }))).toEqual({ source: "flux" });
    expect(readFluxMemoryResponse(new Headers({ "x-flux-memory": "maybe" }))).toBeUndefined();
    expect(readFluxMemoryResponse(new Headers())).toBeUndefined();
  });
  it("the response header name is still never sent", () => {
    expect(() => assertNoForbiddenFluxHeaders({ "x-flux-memory": "flux" })).toThrow();
  });
});

describe("wire: openai-chat behind the memory adapter", () => {
  const instances: ProviderInstance[] = [];
  let previousFetch: typeof globalThis.fetch;
  let sent: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  let answerHeaders: Record<string, string> = {};

  beforeEach(() => {
    ensureDirs();
    clearFluxMemoryReports();
    setFluxExternalMemory(undefined);
    previousFetch = globalThis.fetch;
    sent = [];
    answerHeaders = {};
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers) });
      const frames = `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
      return new Response(frames, { status: 200, headers: { "content-type": "text/event-stream", ...answerHeaders } });
    }) as typeof fetch;
  });
  afterEach(async () => {
    globalThis.fetch = previousFetch;
    setFluxExternalMemory(undefined);
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
    await recorder.until((event) => event.type === "turn.completed");
    recorder.stop();
    const request = sent.at(-1)!;
    const prompt = JSON.stringify(request.body.messages);
    return { request, prompt, metadata: (request.body.metadata ?? {}) as { flux_memory?: { mode: string; fallback_recall?: { text: string; sha256: string } } } };
  };

  it("default-on with a key: envelope sent, no local injection, exactly one block (in the fallback)", async () => {
    answerHeaders = { "x-flux-memory": "fallback", "x-flux-memory-reason": "flux-store-slow" };
    const recall = block([item(1), item(2)]);
    const { metadata, prompt } = await turn(recall, fluxRoute);
    const envelope = metadata.flux_memory!;
    expect(envelope.mode).toBe("on");
    expect(envelope.fallback_recall!.text).toBe(recall);
    expect(envelope.fallback_recall!.sha256).toBe(sha(recall));
    expect(countBlocks(prompt)).toBe(0);
    expect(countBlocks(envelope.fallback_recall!.text)).toBe(1);
    expect(fluxMemoryReportFor("t-flux-env")).toMatchObject({ source: "fallback", reason: "flux-store-slow", bundleId: "b1" });
  });

  it("flux source is recorded", async () => {
    answerHeaders = { "x-flux-memory": "flux" };
    await turn(block([item(1)]), fluxRoute, "t-flux-src");
    expect(fluxMemoryReportFor("t-flux-src")).toMatchObject({ source: "flux" });
  });

  it("oversized recall: cut to 8,192 bytes at an item boundary", async () => {
    const items = Array.from({ length: 300 }, (_, i) => item(i + 1, `${"w".repeat(50)} ${i}`));
    const { metadata, prompt } = await turn(block(items), fluxRoute, "t-big");
    const fallback = metadata.flux_memory!.fallback_recall!;
    expect(Buffer.byteLength(fallback.text, "utf8")).toBeLessThanOrEqual(FLUX_FALLBACK_MAX_BYTES);
    expect(fallback.sha256).toBe(sha(fallback.text));
    expect(countBlocks(prompt)).toBe(0);
  });

  it("empty recall: mode on without fallback_recall, nothing injected", async () => {
    const { metadata, prompt } = await turn("", fluxRoute, "t-empty");
    expect(metadata.flux_memory).toEqual({ mode: "on" });
    expect(countBlocks(prompt)).toBe(0);
  });

  it("external off: no envelope, no Flux capture or inject, local injection, exactly one block", async () => {
    setFluxExternalMemory(false);
    const { request, metadata, prompt } = await turn(block([item(1)]), fluxRoute, "t-off");
    expect(metadata.flux_memory).toBeUndefined();
    expect(request.headers.get("x-flux-memory-capture")).toBe("off");
    expect(request.headers.get("x-flux-memory-inject")).toBe("off");
    expect(countBlocks(prompt)).toBe(1);
  });

  it("external on (the default with a key): the owner's turn sends no off headers", async () => {
    const { request } = await turn(block([item(1)]), fluxRoute, "t-on-headers");
    expect(request.headers.get("x-flux-memory-capture")).toBeNull();
    expect(request.headers.get("x-flux-memory-inject")).toBeNull();
  });

  it("a non-owner audience (the 1.0.2 headers say inject off): no envelope, local injection, exactly one block", async () => {
    const { metadata, prompt } = await turn(block([item(1)]), fluxRoute, "t-guest", { botId: "b1", audience: "non-owner" });
    expect(metadata.flux_memory).toBeUndefined();
    expect(countBlocks(prompt)).toBe(1);
  });

  it("non-Flux route: no envelope, local injection, exactly one block", async () => {
    const { request, metadata, prompt } = await turn(block([item(1)]), otherRoute, "t-other");
    expect(request.url).toContain("api.openai.com");
    expect(metadata.flux_memory).toBeUndefined();
    expect(countBlocks(prompt)).toBe(1);
  });
});
