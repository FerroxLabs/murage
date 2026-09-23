import { afterEach, describe, expect, it, vi } from "vitest";

import { synthesize, FLUX_VOICES, SpeechUnavailable } from "./flux-speech.ts";
import { speak, useVoiceRoutes, voiceProvider } from "./index.ts";
import type { AppConfig } from "../config.ts";
import type { VoiceEndpoint } from "../voice/voice-routes.ts";

const cfg = (tts?: AppConfig["tts"]) => ({ tts }) as AppConfig;
const FLUX: VoiceEndpoint = { via: "flux", label: "Flux Router", baseUrl: "https://api.fluxrouter.ai/v1", key: "flux-test", model: "flux-voice-speak" };
const OPENAI: VoiceEndpoint = { via: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", key: "own-openai", model: "gpt-4o-mini-tts" };

describe("choosing the voice engine", () => {
  it("defaults to hosted voices when nothing was chosen, no ElevenLabs key is saved, and Flux or an OpenAI key can speak", () => {
    expect(voiceProvider(cfg(), true)).toBe("flux");
    expect(voiceProvider(cfg(undefined), false)).toBe("elevenlabs");
  });
  it("keeps an owner's ElevenLabs key and every explicit choice", () => {
    expect(voiceProvider(cfg({ key: "el" }), true)).toBe("elevenlabs");
    expect(voiceProvider(cfg({ provider: "system" }), true)).toBe("system");
    expect(voiceProvider(cfg({ provider: "elevenlabs" }), true)).toBe("elevenlabs");
    expect(voiceProvider(cfg({ key: "el", provider: "flux" }), true)).toBe("flux");
  });
});

describe("Flux speech", () => {
  it("asks for the voice as mp3 on flux-voice-speak and returns the audio", async () => {
    let sent: any;
    const call = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization };
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    }) as typeof fetch;
    const audio = await synthesize("Hello there.", "cedar", FLUX, call);
    expect(sent.url).toMatch(/\/audio\/speech$/);
    expect(sent.body).toEqual({ model: "flux-voice-speak", input: "Hello there.", voice: "cedar", response_format: "mp3" });
    expect(sent.auth).toBe("Bearer flux-test");
    expect(audio).toEqual({ bytes: new Uint8Array([1, 2, 3]), mime: "audio/mpeg" });
  });

  it("gives an agent carrying another engine's voice Flux's default instead of a 400", async () => {
    let voice = "";
    const call = (async (_url: string, init: RequestInit) => {
      voice = JSON.parse(String(init.body)).voice;
      return new Response(new Uint8Array([1]), { status: 200 });
    }) as typeof fetch;
    await synthesize("Hi.", "21m00Tcm4TlvDq8ikWAM", FLUX, call);
    expect(voice).toBe("marin");
    expect(FLUX_VOICES.map((v) => v.id)).toContain("marin");
  });

  it("says what is wrong in the owner's terms", async () => {
    for (const [status, words] of [
      [404, "aren't switched on"],
      [402, "need a paid plan"],
      [401, "rejected the saved key"],
      [429, "rate-limiting"],
    ] as const) {
      const call = (async () => new Response("{}", { status })) as unknown as typeof fetch;
      await expect(synthesize("Hi.", "marin", FLUX, call)).rejects.toThrow(words);
    }
    await expect(synthesize("Hi.", "marin", null)).rejects.toThrow("Add a Flux key, or an OpenAI key");
  });

  it("speaks the same voice on an owner's own OpenAI key when there is no Flux", async () => {
    let sent: any;
    const call = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization };
      return new Response(new Uint8Array([7]), { status: 200 });
    }) as typeof fetch;
    await synthesize("Hello.", "cedar", OPENAI, call);
    expect(sent).toEqual({
      url: "https://api.openai.com/v1/audio/speech",
      auth: "Bearer own-openai",
      body: { model: "gpt-4o-mini-tts", input: "Hello.", voice: "cedar", response_format: "mp3" },
    });
    const rejected = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    await expect(synthesize("Hi.", "marin", OPENAI, rejected)).rejects.toThrow("OpenAI rejected the saved key");
  });
});

describe("when a speech source is not switched on", () => {
  const SILENT_RUN = (async () => ({ stdout: "", stderr: "" })) as any;
  const asked: string[] = [];
  const serve = (dark: Set<string>) =>
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url);
      if ([...dark].some((base) => url.startsWith(base))) return new Response("{}", { status: 404 });
      return new Response(new Uint8Array([7]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    });
  afterEach(() => {
    vi.unstubAllGlobals();
    asked.length = 0;
  });

  it("the next source speaks, and the refusing one is skipped on the next sentence", async () => {
    useVoiceRoutes({ speech: () => [FLUX, OPENAI], describe: () => ({ host: null, lookup: null, speech: "flux", transcribe: null }) });
    serve(new Set([FLUX.baseUrl]));
    const first = await speak(cfg({ provider: "flux" }), "Hello there.");
    expect(first.bytes).toEqual(new Uint8Array([7]));
    expect(asked).toEqual([`${FLUX.baseUrl}/audio/speech`, `${OPENAI.baseUrl}/audio/speech`]);
    asked.length = 0;
    await speak(cfg({ provider: "flux" }), "Second sentence.");
    expect(asked).toEqual([`${OPENAI.baseUrl}/audio/speech`]);
  });

  it("with no source left, the computer's own voice speaks instead of nothing", async () => {
    useVoiceRoutes({ speech: () => [FLUX], describe: () => ({ host: null, lookup: null, speech: "flux", transcribe: null }) });
    serve(new Set([FLUX.baseUrl]));
    const said = await speak(cfg({ provider: "flux" }), "Hello there.", undefined, SILENT_RUN).catch((error) => error);
    expect(asked).toEqual([`${FLUX.baseUrl}/audio/speech`]);
    // the system runner was used: not the Flux refusal
    expect(said).not.toBeInstanceOf(SpeechUnavailable);
  });

  it("a real failure is reported, not papered over with another voice", async () => {
    useVoiceRoutes({ speech: () => [FLUX, OPENAI], describe: () => ({ host: null, lookup: null, speech: "flux", transcribe: null }) });
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url);
      return new Response("{}", { status: 401 });
    });
    await expect(speak(cfg({ provider: "flux" }), "Hello.")).rejects.toThrow("Flux rejected the saved key");
    expect(asked).toEqual([`${FLUX.baseUrl}/audio/speech`]);
  });
});
