// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ElevenLabs' voices through Flux (flux-voice-speak-eleven) on the Flux key
// alone. Every answer below is a fixture from the 1.0.7 contract
// (FLUX-ELEVEN-CONTRACT-107): fetch is stubbed, nothing reaches the network.
import { afterEach, describe, expect, it, vi } from "vitest";

import { describeVoice, fluxElevenStatus, listVoices, recheckFluxEleven, speak, speakStreamed, useVoiceRoutes, NoVoiceConfigured } from "./index.ts";
import {
  DEFAULT_ELEVEN_VOICE,
  ELEVEN_LOCKED,
  ELEVEN_NOT_ON_KEY,
  ElevenNotOnKey,
  ElevenVoiceNotOffered,
  FLUX_ELEVEN_MODEL,
  FLUX_ELEVEN_VOICES,
  FLUX_GROK_MODEL,
  SpeechUnavailable,
  isFluxElevenVoice,
  readElevenCatalog,
  synthesizeClip,
} from "./flux-speech.ts";
import { resetUnavailable, type VoiceEndpoint } from "../voice/voice-routes.ts";
import type { AppConfig } from "../config.ts";

const cfg = (tts?: AppConfig["tts"]) => ({ tts }) as AppConfig;
const FLUX: VoiceEndpoint = { via: "flux", label: "Flux Router", baseUrl: "https://flux.test/v1", key: "k1", model: "flux-voice-speak" };
const OPENAI: VoiceEndpoint = { via: "openai", label: "OpenAI", baseUrl: "https://openai.test/v1", key: "k2", model: "gpt-4o-mini-tts" };
const NONE = { host: null, lookup: null, speech: null, transcribe: null } as any;
const AUDIO = () => new Response(new Uint8Array([7]), { status: 200, headers: { "content-type": "audio/mpeg" } });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** Flux's answers, word for word from the contract. */
const NOT_ALLOWED = () => json(403, { error: { message: "This key is not allowed to use flux-voice-speak-eleven.", type: "permission_error", code: "model_not_allowed" } });
const UNKNOWN_VOICE = () => json(400, { error: { message: "Unknown voice.", type: "invalid_request_error", param: "voice" } });
const PROVIDER_REJECTED = () => json(400, { error: { message: "speech provider rejected the request", type: "invalid_request_error" } });

/** GET /v1/audio/voices as flux-router master answers it (voice_catalog_route.py):
 *  filtered to the calling key, every row tagged with the key's entitlement. */
const ELEVEN_NAMES = FLUX_ELEVEN_VOICES.map((v) => v.id);
function voiceList(eleven: string[] = ELEVEN_NAMES, entitlement = "open"): () => Response {
  const row = (id: string, model: string) => ({ id, model, name: id, gender: "female", description: "Standard voice", languages: ["multilingual"], entitlement });
  return () => json(200, { object: "list", data: [row("marin", "flux-voice-speak"), row("eve", FLUX_GROK_MODEL), ...eleven.map((id) => row(id, FLUX_ELEVEN_MODEL))] });
}

const asked: Array<{ url: string; body: any }> = [];
const listed: Array<{ url: string; method: string; auth: string }> = [];
/** Flux: its voice list from `list`, the ElevenLabs model answered with
 *  `eleven`, everything else with audio. */
function serve(eleven: () => Response = AUDIO, list: () => Response = voiceList()) {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/audio/voices")) {
      listed.push({ url, method: String(init.method), auth: String((init.headers as Record<string, string>).authorization) });
      return list();
    }
    const body = JSON.parse(String(init.body));
    asked.push({ url, body });
    return body.model === FLUX_ELEVEN_MODEL ? eleven() : AUDIO();
  });
}
const onFlux = () => useVoiceRoutes({ speech: () => [FLUX], describe: () => NONE });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); asked.length = 0; listed.length = 0; resetUnavailable(); });

describe("the ElevenLabs voices Flux offers", () => {
  it("are the contract's 20 names, tagged elevenlabs, each with a gender and a description", () => {
    expect(FLUX_ELEVEN_VOICES.map((v) => v.id).sort()).toEqual(
      ["Aria", "Roger", "Sarah", "Laura", "Charlie", "George", "Callum", "River", "Liam", "Alice", "Matilda", "Will", "Jessica", "Eric", "Chris", "Brian", "Daniel", "Lily", "Adam", "Bill"].sort(),
    );
    for (const v of FLUX_ELEVEN_VOICES) {
      expect(v).toMatchObject({ provider: "elevenlabs", label: v.id });
      expect(["female", "male", "neutral"]).toContain(v.gender);
      expect(v.description).toBeTruthy();
      expect(`${v.label} ${v.description}`).not.toMatch(/—|\b(she|he|her|his|woman|man|female|male)\b/i);
    }
    expect(isFluxElevenVoice("Aria")).toBe(true);
    // never mistaken for OpenAI's or xAI's ids, or an own key's raw ids
    expect(isFluxElevenVoice("aria")).toBe(false);
    expect(isFluxElevenVoice("eve")).toBe(false);
    expect(isFluxElevenVoice("9BWtsMINqrJLrRacOk9x")).toBe(false);
  });

  it("follow OpenAI's in the Flux list when Flux is connected, with no ElevenLabs key", async () => {
    onFlux();
    serve();
    const voices = await listVoices(cfg(), undefined, "flux");
    expect(voices.slice(41).map((v) => v.id)).toEqual(FLUX_ELEVEN_VOICES.map((v) => v.id));
    expect(fluxElevenStatus()).toBe("on");
    expect(describeVoice(cfg()).available.elevenlabs).toBe(false);
  });

  it("are not offered where only an own OpenAI key speaks (no Flux to reach them)", async () => {
    useVoiceRoutes({ speech: () => [OPENAI], describe: () => NONE });
    serve();
    const voices = await listVoices(cfg(), undefined, "flux");
    expect(voices.some((v) => v.provider === "elevenlabs")).toBe(false);
    expect(fluxElevenStatus()).toBe("none");
    expect(listed).toHaveLength(0);
  });
});

describe("speaking an ElevenLabs voice through Flux", () => {
  it("asks flux-voice-speak-eleven for the voice by name, mp3 only, no speed and no SSE", async () => {
    onFlux();
    serve();
    await speak(cfg(), "Hello.", "Brian");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.url).toBe(`${FLUX.baseUrl}/audio/speech`);
    expect(asked[0]!.body).toEqual({ model: FLUX_ELEVEN_MODEL, input: "Hello.", voice: "Brian", response_format: "mp3" });
  });

  it("routes per bot: a bot on the Flux list with an ElevenLabs voice, next to one with an OpenAI voice", async () => {
    onFlux();
    serve();
    await speak(cfg(), "One.", "Lily", undefined, "flux");
    await speak(cfg(), "Two.", "cedar", undefined, "flux");
    expect(asked.map((a) => [a.body.model, a.body.voice])).toEqual([[FLUX_ELEVEN_MODEL, "Lily"], ["flux-voice-speak", "cedar"]]);
  });

  it("the workspace's own voice can be one of them too", async () => {
    onFlux();
    serve();
    await speak(cfg({ provider: "flux", voice: "Daniel" }), "Hello.");
    expect(asked[0]!.body).toMatchObject({ model: FLUX_ELEVEN_MODEL, voice: "Daniel" });
  });

  it("on the ElevenLabs model, a voice Flux does not list becomes the default name", async () => {
    let sent: any;
    const call = (async (_url: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return AUDIO(); }) as typeof fetch;
    await synthesizeClip("Hi.", "marin", { ...FLUX, model: FLUX_ELEVEN_MODEL }, false, call);
    expect(sent).toEqual({ model: FLUX_ELEVEN_MODEL, input: "Hi.", voice: DEFAULT_ELEVEN_VOICE, response_format: "mp3" });
  });

  it("leaves the own-key ElevenLabs path exactly as it was", async () => {
    useVoiceRoutes({ speech: () => [], describe: () => NONE });
    serve();
    await speak(cfg({ provider: "elevenlabs", key: "el", voice: "EL_VOICE" }), "Hello.");
    expect(asked[0]!.url).toContain("/text-to-speech/EL_VOICE?output_format=mp3_44100_64");
    expect(asked[0]!.body).toEqual({ text: "Hello.", model_id: "eleven_flash_v2_5" });
  });

  it("never hands a Flux ElevenLabs name to an own ElevenLabs key", async () => {
    useVoiceRoutes({ speech: () => [], describe: () => NONE });
    serve();
    await speak(cfg({ provider: "elevenlabs", key: "el", voice: "EL_VOICE" }), "Hello.", "Aria");
    expect(asked[0]!.url).toContain("/text-to-speech/EL_VOICE");
    // speak() refuses before any request, synchronously, as it always has
    expect(() => speak(cfg({ provider: "elevenlabs", key: "el" }), "Hello.", "Aria")).toThrow(NoVoiceConfigured);
    expect(asked).toHaveLength(1);
  });
});

describe("403 model_not_allowed: this key may not use ElevenLabs voices", () => {
  it("is its own refusal, never 'paste a fresh key'", async () => {
    const call = (async () => NOT_ALLOWED()) as typeof fetch;
    const error = await synthesizeClip("Hi.", "Aria", { ...FLUX, model: FLUX_ELEVEN_MODEL }, false, call).catch((e) => e);
    expect(error).toBeInstanceOf(ElevenNotOnKey);
    expect(error).toBeInstanceOf(SpeechUnavailable);
    expect(error.message).toBe(ELEVEN_NOT_ON_KEY);
    expect(error.message).not.toMatch(/fresh|paste/i);
  });

  it("a call keeps talking in the Flux list's default voice, and the list then leaves them out and says why", async () => {
    onFlux();
    serve(NOT_ALLOWED);
    await speak(cfg(), "One.", "Aria");
    expect(asked.map((a) => [a.body.model, a.body.voice])).toEqual([[FLUX_ELEVEN_MODEL, "Aria"], [FLUX_GROK_MODEL, "eve"]]);
    // remembered: the next sentence goes straight to the default voice
    asked.length = 0;
    await speak(cfg(), "Two.", "Aria");
    expect(asked.map((a) => a.body.model)).toEqual([FLUX_GROK_MODEL]);
    expect(fluxElevenStatus()).toBe("notOnKey");
    const voices = await listVoices(cfg(), undefined, "flux");
    expect(voices.some((v) => v.provider === "elevenlabs")).toBe(false);
    expect(voices).toHaveLength(41);
  });

  it("a preview from the picker says why instead of playing another voice", async () => {
    onFlux();
    serve(NOT_ALLOWED);
    const first = await speakStreamed(cfg(), "Sample.", "Aria", "flux", { preview: true }).catch((e) => e);
    expect(first).toBeInstanceOf(ElevenNotOnKey);
    expect(first.message).toBe(ELEVEN_NOT_ON_KEY);
    expect(asked.map((a) => a.body.model)).toEqual([FLUX_ELEVEN_MODEL]);
    // and again, without asking Flux a second time
    asked.length = 0;
    const again = await speakStreamed(cfg(), "Sample.", "Aria", "flux", { preview: true }).catch((e) => e);
    expect(again).toBeInstanceOf(ElevenNotOnKey);
    expect(asked).toHaveLength(0);
  });

  it("the rest of Flux is untouched: OpenAI voices still speak on flux-voice-speak", async () => {
    onFlux();
    serve(NOT_ALLOWED);
    await speak(cfg(), "One.", "Aria");
    asked.length = 0;
    await speak(cfg(), "Two.", "cedar");
    expect(asked.map((a) => [a.body.model, a.body.voice])).toEqual([["flux-voice-speak", "cedar"]]);
  });

  it("model_not_allowed by its code alone counts on Flux's other models too", async () => {
    const call = (async () => json(403, { error: { message: "Forbidden.", code: "model_not_allowed" } })) as typeof fetch;
    const error = await synthesizeClip("Hi.", "cedar", FLUX, false, call).catch((e) => e);
    expect(error).toBeInstanceOf(SpeechUnavailable);
    expect(error).not.toBeInstanceOf(ElevenNotOnKey);
  });

  it("any other 403 on the ElevenLabs model is still a key Flux rejected", async () => {
    const call = (async () => json(403, { error: { message: "Invalid key." } })) as typeof fetch;
    const error = await synthesizeClip("Hi.", "Aria", { ...FLUX, model: FLUX_ELEVEN_MODEL }, false, call).catch((e) => e);
    expect(error).not.toBeInstanceOf(SpeechUnavailable);
    expect(error.message).toBe("Flux rejected the saved key. Paste a fresh one in Settings.");
  });
});

describe("400 on the ElevenLabs model", () => {
  it("an unknown voice name: a preview says to pick another, a call keeps talking", async () => {
    onFlux();
    serve(UNKNOWN_VOICE);
    await listVoices(cfg(), undefined, "flux");
    const preview = await speakStreamed(cfg(), "Sample.", "Bill", "flux", { preview: true }).catch((e) => e);
    expect(preview).toBeInstanceOf(ElevenVoiceNotOffered);
    expect(preview.message).toBe("Flux no longer offers the ElevenLabs voice Bill. Pick another voice.");
    asked.length = 0;
    await speak(cfg(), "One.", "Bill");
    expect(asked.map((a) => a.body.model)).toEqual([FLUX_ELEVEN_MODEL, FLUX_GROK_MODEL]);
    // one name gone does not hide the other nineteen
    expect(fluxElevenStatus()).toBe("on");
  });

  it("the provider rejecting the request: a preview says it plainly, a call keeps talking", async () => {
    onFlux();
    serve(PROVIDER_REJECTED);
    await listVoices(cfg(), undefined, "flux");
    const error = await speakStreamed(cfg(), "Sample.", "Bill", "flux", { preview: true }).catch((e) => e);
    expect(error.message).toBe("ElevenLabs couldn't speak this text through Flux. Try again, or pick another voice.");
    expect(asked.map((a) => a.body.model)).toEqual([FLUX_ELEVEN_MODEL]);
    asked.length = 0;
    await speak(cfg(), "One.", "Bill");
    expect(asked.map((a) => a.body.model)).toEqual([FLUX_ELEVEN_MODEL, FLUX_GROK_MODEL]);
    expect(fluxElevenStatus()).toBe("on");
  });

  it("a workspace voice saved from the Flux list is not sent to an own ElevenLabs key", () => {
    useVoiceRoutes({ speech: () => [], describe: () => NONE });
    serve();
    expect(() => speak(cfg({ provider: "elevenlabs", key: "el", voice: "Aria" }), "Hello.")).toThrow(NoVoiceConfigured);
    expect(asked).toHaveLength(0);
  });
});

describe("Flux's voice list decides which ElevenLabs voices are offered", () => {
  it("is read once with the Flux key (GET, bearer) and kept, not asked again on the next open", async () => {
    onFlux();
    serve();
    await listVoices(cfg(), undefined, "flux");
    await listVoices(cfg(), undefined, "flux");
    expect(listed).toEqual([{ url: "https://flux.test/v1/audio/voices", method: "GET", auth: "Bearer k1" }]);
    expect(asked).toHaveLength(0);
  });

  it("a key whose list leaves them out: none shown, and nothing is spoken to find out", async () => {
    onFlux();
    serve(AUDIO, voiceList([]));
    const voices = await listVoices(cfg(), undefined, "flux");
    expect(voices).toHaveLength(41);
    expect(fluxElevenStatus()).toBe("notOnKey");
    const preview = await speakStreamed(cfg(), "Sample.", "Aria", "flux", { preview: true }).catch((e) => e);
    expect(preview).toBeInstanceOf(ElevenNotOnKey);
    expect(preview.message).toBe(ELEVEN_NOT_ON_KEY);
    await speak(cfg(), "One.", "Aria");
    expect(asked.map((a) => [a.body.model, a.body.voice])).toEqual([[FLUX_GROK_MODEL, "eve"]]);
  });

  it("premium_locked: not playable, the preview says what to do, a call keeps talking in the default voice", async () => {
    onFlux();
    serve(AUDIO, voiceList(ELEVEN_NAMES, "premium_locked"));
    const voices = await listVoices(cfg(), undefined, "flux");
    expect(voices.some((v) => v.provider === "elevenlabs")).toBe(false);
    expect(fluxElevenStatus()).toBe("locked");
    const preview = await speakStreamed(cfg(), "Sample.", "Aria", "flux", { preview: true }).catch((e) => e);
    expect(preview.message).toBe(ELEVEN_LOCKED);
    expect(ELEVEN_LOCKED).not.toMatch(/—|\$|price|safe/i);
    await speak(cfg(), "One.", "Aria");
    expect(asked.map((a) => a.body.model)).toEqual([FLUX_GROK_MODEL]);
  });

  it("open and paid_cleared both play", async () => {
    for (const entitlement of ["open", "paid_cleared"]) {
      onFlux();
      serve(AUDIO, voiceList(ELEVEN_NAMES, entitlement));
      expect((await listVoices(cfg(), undefined, "flux")).filter((v) => v.provider === "elevenlabs")).toHaveLength(20);
      expect(fluxElevenStatus()).toBe("on");
      asked.length = 0;
      await speak(cfg(), "One.", "Aria");
      expect(asked.map((a) => [a.body.model, a.body.voice])).toEqual([[FLUX_ELEVEN_MODEL, "Aria"]]);
    }
  });

  it("only the names the list returns are shown; an unlisted one is not asked for", async () => {
    onFlux();
    serve(AUDIO, voiceList(["Aria", "Roger"]));
    const voices = await listVoices(cfg(), undefined, "flux");
    expect(voices.filter((v) => v.provider === "elevenlabs").map((v) => v.id)).toEqual(["Aria", "Roger"]);
    const preview = await speakStreamed(cfg(), "Sample.", "Bill", "flux", { preview: true }).catch((e) => e);
    expect(preview).toBeInstanceOf(ElevenVoiceNotOffered);
    await speak(cfg(), "One.", "Bill");
    expect(asked.map((a) => a.body.model)).toEqual([FLUX_GROK_MODEL]);
  });

  it("an unreadable list shows none ('unchecked'); a call still tries, with the 403 as the backstop", async () => {
    for (const list of [() => json(503, { error: { message: "Voice catalogue unavailable" } }), () => { throw new TypeError("fetch failed"); }]) {
      onFlux();
      serve(NOT_ALLOWED, list as () => Response);
      expect((await listVoices(cfg(), undefined, "flux")).some((v) => v.provider === "elevenlabs")).toBe(false);
      expect(fluxElevenStatus()).toBe("unchecked");
      asked.length = 0;
      await speak(cfg(), "One.", "Aria");
      expect(asked.map((a) => a.body.model)).toEqual([FLUX_ELEVEN_MODEL, FLUX_GROK_MODEL]);
      expect(fluxElevenStatus()).toBe("notOnKey");
    }
  });

  it("an unreadable re-read keeps the last good list for the same key", async () => {
    onFlux();
    let answer = voiceList();
    serve(AUDIO, () => answer());
    await listVoices(cfg(), undefined, "flux");
    answer = () => json(503, {});
    expect(await recheckFluxEleven()).toBe("on");
    expect((await listVoices(cfg(), undefined, "flux")).filter((v) => v.provider === "elevenlabs")).toHaveLength(20);
  });

  it("an expired list that cannot be re-read shows none, matching the status", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-25T12:00:00Z"));
    onFlux();
    let answer = voiceList();
    serve(AUDIO, () => answer());
    await listVoices(cfg(), undefined, "flux");
    answer = () => json(503, {});
    vi.setSystemTime(new Date("2026-10-25T12:10:01Z"));
    expect((await listVoices(cfg(), undefined, "flux")).some((v) => v.provider === "elevenlabs")).toBe(false);
    expect(fluxElevenStatus()).toBe("unchecked");
  });

  it("is read again after ten minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-25T12:00:00Z"));
    onFlux();
    serve();
    await listVoices(cfg(), undefined, "flux");
    vi.setSystemTime(new Date("2026-10-25T12:09:00Z"));
    await listVoices(cfg(), undefined, "flux");
    expect(listed).toHaveLength(1);
    vi.setSystemTime(new Date("2026-10-25T12:10:01Z"));
    await listVoices(cfg(), undefined, "flux");
    expect(listed).toHaveLength(2);
  });

  it("Check again: a key fixed at Flux shows its voices at once, even after a 403", async () => {
    onFlux();
    let answer = voiceList([]);
    serve(NOT_ALLOWED, () => answer());
    await listVoices(cfg(), undefined, "flux");
    await speak(cfg(), "One.", "Aria"); // not tried: the list already said no
    expect(fluxElevenStatus()).toBe("notOnKey");
    answer = voiceList();
    // without the recheck the kept answer stands
    expect((await listVoices(cfg(), undefined, "flux")).some((v) => v.provider === "elevenlabs")).toBe(false);
    expect(await recheckFluxEleven()).toBe("on");
    expect((await listVoices(cfg(), undefined, "flux")).filter((v) => v.provider === "elevenlabs")).toHaveLength(20);
    expect(listed).toHaveLength(2);
  });

  it("Check again also clears a 403 the speech call remembered", async () => {
    onFlux();
    serve(NOT_ALLOWED);
    await speak(cfg(), "One.", "Aria");
    expect(fluxElevenStatus()).toBe("notOnKey");
    expect(await recheckFluxEleven()).toBe("on");
  });

  it("only a Flux endpoint is asked for the list", async () => {
    const call = vi.fn(async () => voiceList()());
    expect(await readElevenCatalog(OPENAI, call as unknown as typeof fetch)).toBeNull();
    expect(call).not.toHaveBeenCalled();
    expect(await readElevenCatalog({ ...FLUX, model: FLUX_ELEVEN_MODEL }, call as unknown as typeof fetch)).toMatchObject({ status: "on" });
  });
});
