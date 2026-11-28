// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import * as voice from "./index.ts";
import * as eleven from "./elevenlabs.ts";

const ready = { tts: { key: "fixture-voice", voice: "fixtureVoice" } };
afterEach(() => { vi.unstubAllGlobals(); voice.useVoiceRoutes({ speech: () => [], describe: () => ({ host: null, lookup: null, speech: null, transcribe: null }) }); });

describe("ElevenLabs language selection", () => {
  it.each([false, true])("speaks Thai with v3, streamed=%s, without a language switch", async (streamed) => {
    const call = vi.fn(async () => new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } }));
    vi.stubGlobal("fetch", call);
    const clip = await eleven.synthesizeClip("สวัสดี hello", "fixtureVoice", "fixture-voice", streamed);
    expect(JSON.parse((call.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ text: "สวัสดี hello", model_id: "eleven_v3" });
    expect((call.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe("error");
    if ("stream" in clip) await clip.stream.cancel();
  });
  it.each(["Hello", "Bonjour", "こんにちは", "你好", "مرحبا", "हैलो"])('keeps Flash for "%s"', async (text) => {
    const call = vi.fn(async () => new Response(new Uint8Array([1]))); vi.stubGlobal("fetch", call);
    await voice.speak(ready, text);
    expect(JSON.parse((call.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).model_id).toBe("eleven_flash_v2_5");
  });
  it("keeps the existing missing-key error without making a request", () => {
    const call = vi.fn(); vi.stubGlobal("fetch", call);
    expect(() => voice.speak({}, "สวัสดี")).toThrow("Add an ElevenLabs key in Settings on the computer to turn on voice.");
    expect(call).not.toHaveBeenCalled();
  });
});

describe("listening on an own ElevenLabs key", () => {
  it("uploads one bounded recording using Scribe and a server-only key", async () => {
    const call = vi.fn(async () => Response.json({ text: " สวัสดี ", language_code: "tha" })); vi.stubGlobal("fetch", call);
    const result = await voice.transcribe(ready, { bytes: new Uint8Array([1, 2]), filename: "clip.webm", mime: "audio/webm" });
    expect(result).toMatchObject({ text: "สวัสดี", language: "tha" });
    const [url, init] = call.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/speech-to-text"); expect(url).not.toContain(ready.tts.key);
    expect(init.headers).toEqual({ "xi-api-key": ready.tts.key }); expect(init.redirect).toBe("error");
    const form = init.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v2"); expect((form.get("file") as File).name).toBe("clip.webm");
    expect(form.get("tag_audio_events")).toBe("false");
    expect(JSON.stringify(voice.describeVoice(ready))).not.toContain(ready.tts.key);
    expect(voice.describeVoice(ready).routes?.transcribe).toBe("elevenlabs");
  });
  it("keeps an existing transcription route first even with an ElevenLabs key", async () => {
    const call = vi.fn(async () => Response.json({ text: "Hello" })); vi.stubGlobal("fetch", call);
    await voice.transcribe(ready, { bytes: new Uint8Array([1]), filename: "clip.wav" }, { endpoint: { via: "openai", baseUrl: "https://audio.example/v1", key: "fixture-audio", model: "fixture-model" } });
    expect((call.mock.calls[0] as unknown as [string])[0]).toBe("https://audio.example/v1/audio/transcriptions");
  });
  it("refuses oversized and empty recordings without uploading", async () => {
    const call = vi.fn(); vi.stubGlobal("fetch", call);
    await expect(voice.transcribe(ready, { bytes: new Uint8Array(8 * 1024 * 1024 + 1), filename: "clip.wav" })).rejects.toMatchObject({ reason: "too_large" });
    await expect(voice.transcribe(ready, { bytes: new Uint8Array(), filename: "clip.wav" })).rejects.toMatchObject({ reason: "format" });
    expect(call).not.toHaveBeenCalled();
  });
  it.each([401, 429, 502])("does not display provider text or the key after HTTP %s", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ detail: ready.tts.key }, { status })));
    await expect(voice.transcribe(ready, { bytes: new Uint8Array([1]), filename: "clip.wav" })).rejects.not.toThrow(ready.tts.key);
  });
});

describe("ElevenLabs transcription send contract", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it("sends only the requested audio, fixed fields and a language code, without private hints or paths", async () => {
    const audio = new Uint8Array([3, 1, 4]);
    const call = vi.fn(async () => Response.json({ text: "Hello" }));
    await eleven.transcribe({ bytes: audio, filename: "/private/recordings/meeting.WEBM", mime: "audio/webm;private=fixture-context" }, "fixture-voice", {
      fetchImpl: call, language: "THA", prompt: "fixture-memory-content",
      endpoint: { via: "fixture", baseUrl: "https://other.example/v1", key: "fixture-other", model: "fixture-context" },
      env: { MURAGE_ELEVENLABS_API: "https://other.example/v1" },
    });
    expect(call).toHaveBeenCalledTimes(1);
    const [url, init] = call.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "xi-api-key": "fixture-voice" });
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const form = init.body as FormData;
    expect([...form.keys()].sort()).toEqual(["file", "language_code", "model_id", "tag_audio_events"]);
    expect(form.get("model_id")).toBe("scribe_v2");
    expect(form.get("tag_audio_events")).toBe("false");
    expect(form.get("language_code")).toBe("tha");
    const file = form.get("file") as File;
    expect(file.name).toBe("clip.webm");
    expect(file.type).toBe("audio/webm");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio);
  });

  it("replaces unrecognized filename and MIME metadata with neutral values", async () => {
    const call = vi.fn(async () => Response.json({ text: "Hello" }));
    await eleven.transcribe({ bytes: new Uint8Array([1]), filename: "private-context.txt", mime: "application/private-context" }, "fixture-voice", { fetchImpl: call });
    const init = (call.mock.calls[0] as unknown as [string, RequestInit])[1];
    const form = init.body as FormData;
    expect([...form.keys()].sort()).toEqual(["file", "model_id", "tag_audio_events"]);
    expect((form.get("file") as File).name).toBe("clip");
    expect((form.get("file") as File).type).toBe("application/octet-stream");
  });

  it.each(["", "   "])("refuses a missing owner key before sending (%j)", async key => {
    const call = vi.fn();
    await expect(eleven.transcribe({ bytes: new Uint8Array([1]), filename: "clip.wav" }, key, { fetchImpl: call })).rejects.toMatchObject({ reason: "key" });
    expect(call).not.toHaveBeenCalled();
  });

  it.each(["", "fixture-memory-content", "en\r\nprivate", "en-US"])("refuses non-code language metadata before sending (%j)", async language => {
    const call = vi.fn();
    await expect(eleven.transcribe({ bytes: new Uint8Array([1]), filename: "clip.wav" }, "fixture-voice", { fetchImpl: call, language })).rejects.toMatchObject({ reason: "format" });
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    "https://other.example/v1", "https://api.elevenlabs.io.other.example/v1",
    "http://api.elevenlabs.io/v1", "https://fixture-user@api.elevenlabs.io/v1",
    "https://api.elevenlabs.io:444/v1", "https://api.elevenlabs.io/other",
    "https://api.elevenlabs.io/v1?private=fixture-context", "https://api.elevenlabs.io/v1#fixture-context",
    "not a URL",
  ])("refuses an unapproved provider destination before sending (%s)", async base => {
    vi.stubEnv("MURAGE_ELEVENLABS_API", base);
    vi.resetModules();
    const adapter = await import("./elevenlabs.ts");
    const call = vi.fn();
    await expect(adapter.transcribe({ bytes: new Uint8Array([1]), filename: "clip.wav" }, "fixture-voice", { fetchImpl: call })).rejects.toMatchObject({ reason: "upstream" });
    expect(call).not.toHaveBeenCalled();
  });
});
