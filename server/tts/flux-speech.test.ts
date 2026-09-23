import { describe, expect, it } from "vitest";

import { synthesize, FLUX_VOICES } from "./flux-speech.ts";
import { voiceProvider } from "./index.ts";
import type { AppConfig } from "../config.ts";

const cfg = (tts?: AppConfig["tts"]) => ({ tts }) as AppConfig;
const withFlux = { FLUX_API_KEY: "flux-test" } as NodeJS.ProcessEnv;

describe("choosing the voice engine", () => {
  it("defaults to Flux when nothing was chosen and no ElevenLabs key is saved", () => {
    expect(voiceProvider(cfg(), withFlux)).toBe("flux");
    expect(voiceProvider(cfg(undefined), {} as NodeJS.ProcessEnv)).toBe("elevenlabs");
  });
  it("keeps an owner's ElevenLabs key and every explicit choice", () => {
    expect(voiceProvider(cfg({ key: "el" }), withFlux)).toBe("elevenlabs");
    expect(voiceProvider(cfg({ provider: "system" }), withFlux)).toBe("system");
    expect(voiceProvider(cfg({ provider: "elevenlabs" }), withFlux)).toBe("elevenlabs");
    expect(voiceProvider(cfg({ key: "el", provider: "flux" }), withFlux)).toBe("flux");
  });
});

describe("Flux speech", () => {
  it("asks for the voice as mp3 on flux-voice-speak and returns the audio", async () => {
    let sent: any;
    const call = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization };
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    }) as typeof fetch;
    const audio = await synthesize("Hello there.", "cedar", withFlux, call);
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
    await synthesize("Hi.", "21m00Tcm4TlvDq8ikWAM", withFlux, call);
    expect(voice).toBe("marin");
    expect(FLUX_VOICES.map((v) => v.id)).toContain("marin");
  });

  it("says what is wrong in the owner's terms", async () => {
    for (const [status, words] of [
      [404, "aren't switched on"],
      [402, "paid Flux plan"],
      [401, "rejected the workspace key"],
      [429, "rate-limiting"],
    ] as const) {
      const call = (async () => new Response("{}", { status })) as unknown as typeof fetch;
      await expect(synthesize("Hi.", "marin", withFlux, call)).rejects.toThrow(words);
    }
    await expect(synthesize("Hi.", "marin", {} as NodeJS.ProcessEnv)).rejects.toThrow("Add a Flux key");
  });
});
