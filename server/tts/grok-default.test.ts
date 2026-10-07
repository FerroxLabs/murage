// Grok through Flux is the default voice; every fallback step is exercised
// against a stubbed fetch, never the network.
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_GROK_VOICE, listVoices, speak, useVoiceRoutes } from "./index.ts";
import { FLUX_GROK_MODEL, SpeechUnavailable } from "./flux-speech.ts";
import { resetUnavailable, type VoiceEndpoint } from "../voice/voice-routes.ts";
import type { AppConfig } from "../config.ts";

const cfg = (tts?: AppConfig["tts"]) => ({ tts }) as AppConfig;
const FLUX: VoiceEndpoint = { via: "flux", label: "Flux Router", baseUrl: "https://flux.test/v1", key: "k1", model: "flux-voice-speak" };
const OPENAI: VoiceEndpoint = { via: "openai", label: "OpenAI", baseUrl: "https://openai.test/v1", key: "k2", model: "gpt-4o-mini-tts" };
const XAI = { baseUrl: "https://xai.test/v1", key: "k3" };
const NONE = { host: null, lookup: null, speech: null, transcribe: null } as any;
const SILENT = (async () => ({ stdout: "", stderr: "" })) as any;

const asked: Array<{ url: string; body: any }> = [];
const serve = (dark: string[]) =>
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    asked.push({ url, body: JSON.parse(String(init.body)) });
    if (dark.some((d) => url.startsWith(d))) return new Response("{}", { status: 404 });
    return new Response(new Uint8Array([7]), { status: 200, headers: { "content-type": "audio/mpeg" } });
  });
afterEach(() => { vi.unstubAllGlobals(); asked.length = 0; resetUnavailable(); });

describe("Grok is the default voice through Flux", () => {
  it("a bot with no voice speaks the default Grok voice on flux-voice-speak-grok", async () => {
    useVoiceRoutes({ speech: () => [FLUX], describe: () => NONE });
    serve([]);
    await speak(cfg(), "Hello.");
    expect(DEFAULT_GROK_VOICE).toBe("eve");
    expect(asked[0]!.body).toMatchObject({ model: FLUX_GROK_MODEL, voice: "eve" });
  });

  it("an explicit OpenAI voice is kept", async () => {
    useVoiceRoutes({ speech: () => [FLUX], describe: () => NONE });
    serve([]);
    await speak(cfg(), "Hello.", "cedar");
    expect(asked[0]!.body).toMatchObject({ model: "flux-voice-speak", voice: "cedar" });
  });

  it("an assigned Grok voice speaks on the Grok alias", async () => {
    useVoiceRoutes({ speech: () => [FLUX], describe: () => NONE });
    serve([]);
    await speak(cfg(), "Hello.", "ursa");
    expect(asked[0]!.body).toMatchObject({ model: FLUX_GROK_MODEL, voice: "ursa" });
  });

  it("fallback 1: Flux won't speak Grok, an own xAI key does", async () => {
    useVoiceRoutes({ speech: () => [FLUX], describe: () => NONE, xai: () => XAI });
    serve([`${FLUX.baseUrl}`]);
    await speak(cfg(), "Hello.", "ursa");
    expect(asked.map((a) => a.url)).toEqual([`${FLUX.baseUrl}/audio/speech`, `${XAI.baseUrl}/tts`]);
    expect(asked[1]!.body.voice_id).toBe("ursa");
  });

  it("fallback 2: no own xAI key, the Flux OpenAI voices speak; the refusal is remembered", async () => {
    useVoiceRoutes({ speech: () => [FLUX], describe: () => NONE });
    let n = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      asked.push({ url, body });
      if (body.model === FLUX_GROK_MODEL) return new Response("{}", { status: 404 });
      n++;
      return new Response(new Uint8Array([7]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    });
    await speak(cfg(), "One.", "ursa");
    expect(asked.map((a) => a.body.model)).toEqual([FLUX_GROK_MODEL, "flux-voice-speak"]);
    expect(asked[1]!.body.voice).toBe("marin");
    asked.length = 0;
    await speak(cfg(), "Two.", "ursa");
    expect(asked.map((a) => a.body.model)).toEqual(["flux-voice-speak"]);
    expect(n).toBe(2);
  });

  it("fallback 3: nothing hosted answers, the system voice speaks", async () => {
    useVoiceRoutes({ speech: () => [FLUX], describe: () => NONE });
    serve([FLUX.baseUrl]);
    const said = await speak(cfg(), "Hello.", "ursa", SILENT).catch((e) => e);
    expect(asked.map((a) => a.body.model)).toEqual([FLUX_GROK_MODEL, "flux-voice-speak"]);
    expect(said).not.toBeInstanceOf(SpeechUnavailable);
  });

  it("an own OpenAI key and no Flux keeps today's default voice", async () => {
    useVoiceRoutes({ speech: () => [OPENAI], describe: () => NONE });
    serve([]);
    await speak(cfg(), "Hello.");
    expect(asked[0]!.body).toMatchObject({ model: "gpt-4o-mini-tts", voice: "marin" });
  });

  it("an owner on ElevenLabs is not handed an assigned Grok voice", async () => {
    useVoiceRoutes({ speech: () => [], describe: () => NONE });
    serve([]);
    await speak(cfg({ provider: "elevenlabs", key: "el", voice: "EL_VOICE" }), "Hello.", "ursa");
    expect(asked[0]!.url).toContain("elevenlabs");
    expect(asked[0]!.url).toContain("EL_VOICE");
  });

  it("the picker list leads with Grok voices when Flux serves them", async () => {
    useVoiceRoutes({ speech: () => [FLUX], describe: () => NONE });
    const voices = await listVoices(cfg(), undefined, "flux");
    expect(voices.slice(0, 28).every((v) => v.provider === "grok")).toBe(true);
    expect(voices.slice(28).every((v) => v.provider === "openai")).toBe(true);
  });
});
