// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Murage's own HTTP calls to Flux are background work: each one carries
// x-flux-memory-app plus both off headers, and only when the endpoint is Flux
// (PROPOSAL-v2 5.4). The engines are in drivers/flux-header-matrix.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";

import { generateAvatarImage } from "./avatar-image.ts";
import { DEFAULT_CHECKER_MODELS, resolveCheckerConnection } from "./browser-action-checker-connection.ts";
import { createDecider } from "./decider/index.ts";
import { readDecisionModelSettings } from "./decider/settings.ts";
import { setFluxMemorySettings } from "./flux-memory-headers.ts";
import { searchFlux } from "./web-search.ts";
import { synthesize } from "./tts/flux-speech.ts";
import { cleanDictation } from "./voice/dictation-cleanup.ts";
import { transcribe } from "./voice/flux-voice.ts";
import { warmVoiceHost } from "./voice/voice-host.ts";
import type { VoiceEndpoint } from "./voice/voice-routes.ts";

const OFF = { "x-flux-memory-app": "murage", "x-flux-memory-capture": "off", "x-flux-memory-inject": "off" };
const KEY = "sk-flux-Dddddddddddddddddddddddddddddddddddddddddddd"; // secret-scan: fixture
const FLUX_EP: VoiceEndpoint = { via: "flux", label: "Flux Router", baseUrl: "https://api.fluxrouter.ai/v1", key: KEY, model: "flux-voice-fast" };
const OPENAI_EP: VoiceEndpoint = { via: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", key: "own-openai", model: "gpt-4o-mini" };

afterEach(() => { setFluxMemorySettings({}); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const memoryHeaders = (init: RequestInit | undefined): Record<string, string> => {
  const headers = new Headers(init?.headers);
  return Object.fromEntries([...headers.entries()].filter(([name]) => name.startsWith("x-flux-memory")));
};
const recording = (response: () => Response) => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = vi.fn(async (url: unknown, init?: RequestInit) => { calls.push({ url: String(url), init }); return response(); });
  return { fn: fn as unknown as typeof fetch, calls };
};
const chat = () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });

describe("direct Flux calls send off/off", () => {
  it("the decider", async () => {
    const { fn, calls } = recording(() => new Response("{}", { status: 500 }));
    const decider = createDecider({ settings: () => readDecisionModelSettings({ enabled: true, jobs: { roomRouting: true } }), credential: () => KEY, fetch: fn });
    await decider.choose("roomRouting", { new_message: { from: "A", text: "hi" } }, { instructions: "Who?", options: { a: "A bot", b: "B bot" } });
    expect(memoryHeaders(calls[0]!.init)).toEqual(OFF);
  });

  it("the decider sends nothing to a host that is not Flux", async () => {
    const { fn, calls } = recording(() => new Response("{}", { status: 500 }));
    const decider = createDecider({
      settings: () => readDecisionModelSettings({ enabled: true, jobs: { roomRouting: true }, byoKey: "own", baseUrl: "https://decide.example.com/v1" }),
      credential: () => KEY, fetch: fn,
    });
    await decider.choose("roomRouting", { new_message: { from: "A", text: "hi" } }, { instructions: "Who?", options: { a: "A bot", b: "B bot" } });
    expect(memoryHeaders(calls[0]!.init)).toEqual({});
  });

  it("the browser action checker, next to its no-retain header", async () => {
    const { fn, calls } = recording(chat);
    vi.stubGlobal("fetch", fn);
    const conn = resolveCheckerConnection({ switch: "flux", noRetainDeployed: true, instances: [], readKey: () => KEY })!;
    await conn.transport({ model: DEFAULT_CHECKER_MODELS.stage1, system: "s", user: "u", maxTokens: 4, signal: new AbortController().signal }).catch(() => undefined);
    expect(memoryHeaders(calls[0]!.init)).toEqual(OFF);
    expect(new Headers(calls[0]!.init?.headers).get("x-flux-no-retain")).toBe("1");
  });

  it("an avatar render", async () => {
    const { fn, calls } = recording(() => new Response("{}", { status: 500 }));
    await generateAvatarImage("", { name: "Sable", title: "Researcher", description: "Calm and careful." }, "a lighthouse", fn, 1000, KEY).catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
    expect(memoryHeaders(calls[0]!.init)).toEqual(OFF);
  });

  it("transcription, only on the Flux route", async () => {
    const flux = recording(() => new Response(JSON.stringify({ text: "hello" }), { status: 200, headers: { "content-type": "application/json" } }));
    await transcribe({ bytes: new Uint8Array([1, 2, 3]), filename: "c.ogg", mime: "audio/ogg" }, { fetchImpl: flux.fn, env: { FLUX_API_KEY: KEY } }).catch(() => undefined);
    expect(memoryHeaders(flux.calls[0]!.init)).toEqual(OFF);
    const own = recording(() => new Response(JSON.stringify({ text: "hello" }), { status: 200, headers: { "content-type": "application/json" } }));
    await transcribe({ bytes: new Uint8Array([1, 2, 3]), filename: "c.ogg", mime: "audio/ogg" }, { fetchImpl: own.fn, endpoint: OPENAI_EP }).catch(() => undefined);
    expect(memoryHeaders(own.calls[0]!.init)).toEqual({});
  });

  it("speech, only on the Flux route", async () => {
    const flux = recording(() => new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
    await synthesize("Hello there.", "cedar", FLUX_EP, flux.fn);
    expect(memoryHeaders(flux.calls[0]!.init)).toEqual(OFF);
    const own = recording(() => new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
    await synthesize("Hello there.", "cedar", OPENAI_EP, own.fn);
    expect(memoryHeaders(own.calls[0]!.init)).toEqual({});
  });

  it("dictation clean-up and the voice host warm-up, only on the Flux route", async () => {
    const flux = recording(chat);
    await cleanDictation("um so the the plan is to ship on friday ok", { endpoint: FLUX_EP, fetchImpl: flux.fn, names: [] } as never);
    expect(memoryHeaders(flux.calls[0]!.init)).toEqual(OFF);
    const own = recording(chat);
    await cleanDictation("um so the the plan is to ship on friday ok", { endpoint: OPENAI_EP, fetchImpl: own.fn, names: [] } as never);
    expect(memoryHeaders(own.calls[0]!.init)).toEqual({});
    const warm = recording(chat);
    await warmVoiceHost(FLUX_EP, warm.fn);
    expect(memoryHeaders(warm.calls[0]!.init)).toEqual(OFF);
  });

  it("web search through Flux", async () => {
    const { fn, calls } = recording(() => new Response("{}", { status: 500 }));
    await searchFlux({ baseUrl: "https://api.fluxrouter.ai/v1", apiKey: KEY, query: "weather" }, { fetch: fn }).catch(() => undefined);
    expect(memoryHeaders(calls[0]!.init)).toEqual(OFF);
  });

  it("the kill switch changes nothing for a direct call: it was already off", async () => {
    setFluxMemorySettings({ killSwitch: true });
    const { fn, calls } = recording(() => new Response("{}", { status: 500 }));
    await searchFlux({ baseUrl: "https://api.fluxrouter.ai/v1", apiKey: KEY, query: "weather" }, { fetch: fn }).catch(() => undefined);
    expect(memoryHeaders(calls[0]!.init)).toEqual(OFF);
  });
});
