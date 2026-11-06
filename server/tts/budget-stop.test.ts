// VOICE-402-STOP: a Flux key whose budget is used up answers every speech
// request with 402. One such answer must stop the asking, not every sentence
// of every message (FluxMain saw 122 budget errors in 40 minutes on one key).
import { afterEach, describe, expect, it, vi } from "vitest";

import { recheckFluxEleven, speak, useVoiceRoutes } from "./index.ts";
import { SpeechBudgetReached, VOICE_BUDGET_REACHED } from "./flux-speech.ts";
import { resetUnavailable, type VoiceEndpoint } from "../voice/voice-routes.ts";
import type { AppConfig } from "../config.ts";

const cfg = (tts?: AppConfig["tts"]) => ({ tts }) as AppConfig;
const FLUX: VoiceEndpoint = { via: "flux", label: "Flux Router", baseUrl: "https://flux.test/v1", key: "k1", model: "flux-voice-speak" };
const OPENAI: VoiceEndpoint = { via: "openai", label: "OpenAI", baseUrl: "https://openai.test/v1", key: "k2", model: "gpt-4o-mini-tts" };
const XAI = { baseUrl: "https://xai.test/v1", key: "k3" };
const NONE = { host: null, lookup: null, speech: null, transcribe: null } as any;
const SILENT = (async () => ({ stdout: "", stderr: "" })) as any;

const asked: string[] = [];
const budgetSpent = () =>
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(url);
    if (url.startsWith(FLUX.baseUrl) && url.endsWith("/audio/speech")) {
      return new Response(JSON.stringify({ error: { code: "budget_exceeded", message: "Key budget exceeded" } }), { status: 402 });
    }
    if (url.endsWith("/audio/voices")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    return new Response(new Uint8Array([7]), { status: 200, headers: { "content-type": "audio/mpeg" } });
  });
const fluxSpeech = () => asked.filter((u) => u.startsWith(FLUX.baseUrl) && u.endsWith("/audio/speech")).length;
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); asked.length = 0; resetUnavailable(); });

// what the client asked for 40 messages: about three clips each
const FORTY_MESSAGES = Array.from({ length: 120 }, (_, i) => `Sentence ${i}.`);

describe("a Flux budget 402 stops the asking", () => {
  it("40 messages after a budget 402 make 1 Flux speech call, not about 120", async () => {
    useVoiceRoutes({ speech: () => [FLUX], describe: () => NONE });
    budgetSpent();
    for (const text of FORTY_MESSAGES) {
      await speak(cfg(), text, "cedar").catch(() => undefined);
      await speak(cfg(), text, "ursa").catch(() => undefined);
    }
    expect(fluxSpeech()).toBe(1);
  });

  it("with no computer voice, says the plain budget line", async () => {
    useVoiceRoutes({ speech: () => [FLUX], describe: () => NONE });
    budgetSpent();
    await expect(speak(cfg(), "Hello.", "cedar")).rejects.toThrow(SpeechBudgetReached);
    await expect(speak(cfg(), "Hello.", "cedar")).rejects.toThrow(VOICE_BUDGET_REACHED);
    expect(VOICE_BUDGET_REACHED).not.toMatch(/—|\bsafe\b|\bfree\b/i);
  });

  it("a Grok voice tries no other paid route: not an own xAI key, not an own OpenAI key; the computer's voice speaks", async () => {
    useVoiceRoutes({ speech: () => [FLUX, OPENAI], describe: () => NONE, xai: () => null });
    budgetSpent();
    await speak(cfg(), "Hello.", "ursa", SILENT).catch(() => undefined);
    await speak(cfg(), "Hello.", "cedar", SILENT).catch(() => undefined);
    expect(asked.filter((u) => u.startsWith(OPENAI.baseUrl) || u.startsWith(XAI.baseUrl))).toEqual([]);
    expect(fluxSpeech()).toBe(1);
  });

  it("an OpenAI voice tries no own OpenAI key after the budget 402", async () => {
    useVoiceRoutes({ speech: () => [FLUX, OPENAI], describe: () => NONE });
    budgetSpent();
    await speak(cfg(), "Hello.", "cedar", SILENT).catch(() => undefined);
    expect(asked.filter((u) => u.startsWith(OPENAI.baseUrl))).toEqual([]);
  });

  it("a new key is asked again at once", async () => {
    let key = "k1";
    useVoiceRoutes({ speech: () => [{ ...FLUX, key }], describe: () => NONE });
    budgetSpent();
    await speak(cfg(), "Hello.", "cedar").catch(() => undefined);
    await speak(cfg(), "Hello.", "cedar").catch(() => undefined);
    expect(fluxSpeech()).toBe(1);
    key = "k9";
    await speak(cfg(), "Hello.", "cedar").catch(() => undefined);
    expect(fluxSpeech()).toBe(2);
  });

  it("Check again clears it, and so do ten minutes", async () => {
    useVoiceRoutes({ speech: () => [FLUX], describe: () => NONE });
    budgetSpent();
    await speak(cfg(), "Hello.", "cedar").catch(() => undefined);
    await recheckFluxEleven();
    await speak(cfg(), "Hello.", "cedar").catch(() => undefined);
    expect(fluxSpeech()).toBe(2);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 9 * 60_000);
    await speak(cfg(), "Hello.", "cedar").catch(() => undefined);
    expect(fluxSpeech()).toBe(2);
    vi.setSystemTime(Date.now() + 2 * 60_000);
    await speak(cfg(), "Hello.", "cedar").catch(() => undefined);
    expect(fluxSpeech()).toBe(3);
  });
});
