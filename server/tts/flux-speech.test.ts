import { afterEach, describe, expect, it, vi } from "vitest";

import { synthesize, synthesizeClip, FLUX_GROK_MODEL, FLUX_VOICES, SpeechUnavailable } from "./flux-speech.ts";
import { availableProviders, describeVoice, listVoices, speak, useVoiceRoutes, voiceProvider } from "./index.ts";
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
    expect(audio).toEqual({ bytes: new Uint8Array([1, 2, 3]), mime: "audio/mpeg", timing: { headersMs: expect.any(Number) } });
  });

  it("hands the audio on as it arrives when asked to stream, without reading it first", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulled += 1; controller.enqueue(new Uint8Array([pulled])); if (pulled === 3) controller.close(); } }, { highWaterMark: 0 });
    const call = (async () => new Response(body, { status: 200, headers: { "content-type": "audio/mpeg" } })) as typeof fetch;
    const clip = await synthesizeClip("Hello there.", "cedar", FLUX, true, call);
    expect("stream" in clip && clip.mime).toBe("audio/mpeg");
    expect(pulled).toBe(0);
    const reader = (clip as { stream: ReadableStream<Uint8Array> }).stream.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1]));
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
      [401, "rejected the saved key"],
      [429, "rate-limiting"],
    ] as const) {
      const call = (async () => new Response("{}", { status })) as unknown as typeof fetch;
      await expect(synthesize("Hi.", "marin", FLUX, call)).rejects.toThrow(words);
    }
    await expect(synthesize("Hi.", "marin", null)).rejects.toThrow("Add a Flux key, or an OpenAI key");
  });

  it("tells a plan without voices apart from an empty balance (Flux 402 codes)", async () => {
    const refuse = (code: string) => (async () => new Response(JSON.stringify({ error: { code, message: code === "premium_locked" ? "Premium" : "Insufficient balance" } }), { status: 402 })) as unknown as typeof fetch;
    await expect(synthesize("Hi.", "marin", FLUX, refuse("premium_locked"))).rejects.toThrow("need a paid plan");
    await expect(synthesize("Hi.", "marin", FLUX, refuse("insufficient_balance"))).rejects.toThrow("Check the account's balance");
  });

  it("never hands a reply that is not audio to the player", async () => {
    const page = (async () => new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    await expect(synthesize("Hi.", "marin", FLUX, page)).rejects.toThrow("something other than audio");
    const wav = (async () => new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "audio/wav" } })) as unknown as typeof fetch;
    expect((await synthesize("Hi.", "marin", FLUX, wav)).mime).toBe("audio/wav");
  });

  it("speaks xAI's voices on Flux's xAI alias, with Flux's own request shape", async () => {
    let sent: any;
    const call = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    }) as unknown as typeof fetch;
    await synthesize("Hi.", "rex", { ...FLUX, model: FLUX_GROK_MODEL }, call);
    expect(sent).toEqual({ model: "flux-voice-speak-grok", input: "Hi.", voice: "rex", response_format: "mp3" });
    // an OpenAI voice name on the xAI alias gets xAI's default, not a 400
    await synthesize("Hi.", "marin", { ...FLUX, model: FLUX_GROK_MODEL }, call);
    expect(sent.voice).toBe("eve");
  });

  it("reads Flux's \"key is valid, not permitted\" 403 as speech not switched on, and a plain 403 as a bad key", async () => {
    const notPermitted = (async () => new Response(JSON.stringify({ error: { message: "This key is not permitted to use flux-voice-speak. The key itself is valid — regenerating it will not change this.", type: "permission_error" } }), { status: 403 })) as unknown as typeof fetch;
    const refused = await synthesize("Hi.", "marin", FLUX, notPermitted).catch((e: Error) => e);
    expect(refused).toBeInstanceOf(SpeechUnavailable);
    expect((refused as Error).message).not.toMatch(/paste a fresh/i);
    const badKey = (async () => new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 403 })) as unknown as typeof fetch;
    await expect(synthesize("Hi.", "marin", FLUX, badKey)).rejects.toThrow("rejected the saved key");
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
    const first = await speak(cfg({ provider: "flux" }), "Hello there.", "marin");
    expect(first.bytes).toEqual(new Uint8Array([7]));
    expect(asked).toEqual([`${FLUX.baseUrl}/audio/speech`, `${OPENAI.baseUrl}/audio/speech`]);
    asked.length = 0;
    await speak(cfg({ provider: "flux" }), "Second sentence.", "marin");
    expect(asked).toEqual([`${OPENAI.baseUrl}/audio/speech`]);
  });

  it("with no source left, the computer's own voice speaks instead of nothing", async () => {
    useVoiceRoutes({ speech: () => [FLUX], describe: () => ({ host: null, lookup: null, speech: "flux", transcribe: null }) });
    serve(new Set([FLUX.baseUrl]));
    const said = await speak(cfg({ provider: "flux" }), "Hello there.", "marin", SILENT_RUN).catch((error) => error);
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

describe("each agent's own voice service", () => {
  afterEach(() => vi.unstubAllGlobals());
  const XAI = { baseUrl: "https://api.x.ai/v1", key: "own-xai" };

  it("an agent on xAI speaks through xAI's voices, whatever the workspace uses", async () => {
    let sent: any;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)) };
      return new Response(new Uint8Array([9]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    });
    useVoiceRoutes({ speech: () => [FLUX], describe: () => ({ host: null, lookup: null, speech: "flux", transcribe: null }), xai: () => XAI });
    const audio = await speak(cfg({ provider: "flux" }), "Morning, boss.", "rex", undefined, "xai");
    expect(audio.bytes).toEqual(new Uint8Array([9]));
    expect(sent).toEqual({ url: "https://api.x.ai/v1/tts", body: { text: "Morning, boss.", voice_id: "rex", language: "auto" } });
    // another service's voice id falls back to xAI's default
    await speak(cfg({ provider: "flux" }), "Hi.", "marin", undefined, "xai");
    expect(sent.body.voice_id).toBe("eve");
  });

  it("lists each service's voices and says which services can speak", async () => {
    useVoiceRoutes({ speech: () => [], describe: () => ({ host: null, lookup: null, speech: null, transcribe: null }), xai: () => XAI });
    expect(await listVoices(cfg(), undefined, "xai")).toHaveLength(28);
    expect(await listVoices(cfg(), undefined, "flux")).toHaveLength(13);
    expect(availableProviders(cfg())).toMatchObject({ xai: true, flux: false, elevenlabs: false });
    useVoiceRoutes({ speech: () => [], describe: () => ({ host: null, lookup: null, speech: null, transcribe: null }) });
    expect(availableProviders(cfg()).xai).toBe(false);
  });
});

describe("one Flux list with every Flux voice", () => {
  afterEach(() => vi.unstubAllGlobals());
  const XAI = { baseUrl: "https://api.x.ai/v1", key: "own-xai" };
  const routes = (xai?: typeof XAI) =>
    useVoiceRoutes({ speech: () => [FLUX], describe: () => ({ host: null, lookup: null, speech: "flux", transcribe: null }), ...(xai ? { xai: () => xai } : {}) });

  it("lists OpenAI's 13 and xAI's 28 under Flux, each with a gender and where it comes from", async () => {
    routes();
    const voices = await listVoices(cfg(), undefined, "flux");
    expect(voices).toHaveLength(41);
    expect(new Set(voices.map((v) => v.id)).size).toBe(41);
    expect(voices.filter((v) => v.provider === "openai")).toHaveLength(13);
    expect(voices.filter((v) => v.provider === "grok")).toHaveLength(28);
    for (const v of voices) {
      expect(["female", "male", "neutral"]).toContain(v.gender);
      expect(v.description).toBeTruthy();
      expect(`${v.label} ${v.description}`).not.toMatch(/—|\b(she|he|her|his|woman|man|female|male)\b/i);
    }
    const byId = Object.fromEntries(voices.map((v) => [v.id, v]));
    expect(byId.nova).toMatchObject({ gender: "female", provider: "openai", label: "Kira", description: "Upbeat, confident, American" });
    expect(byId.alloy!.gender).toBe("neutral");
    expect(byId.onyx!.gender).toBe("male");
    expect(byId.eve).toMatchObject({ gender: "female", provider: "grok", label: "Harriet", description: "Energetic, friendly, British" });
    expect(byId.rex).toMatchObject({ gender: "male", label: "Grant", description: "Confident, calm, American" });
    expect(voices.filter((v) => v.provider === "grok" && v.gender === "female").map((v) => v.id).sort())
      .toEqual(["ara", "aurora", "carina", "celeste", "eve", "iris", "liora", "luna", "ursa"]);
  });

  it("keeps OpenAI's 13 alone where only an own OpenAI key speaks (no Flux to reach xAI's voices)", async () => {
    useVoiceRoutes({ speech: () => [OPENAI], describe: () => ({ host: null, lookup: null, speech: "openai", transcribe: null }) });
    expect(await listVoices(cfg(), undefined, "flux")).toHaveLength(13);
  });

  it("a Grok voice picked under Flux plays through Flux's xAI alias, even with an own xAI key", async () => {
    let sent: any;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)) };
      return new Response(new Uint8Array([5]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    });
    routes(XAI);
    await speak(cfg({ provider: "flux" }), "Morning.", "ara", undefined, "flux");
    expect(sent).toEqual({ url: `${FLUX.baseUrl}/audio/speech`, body: { model: FLUX_GROK_MODEL, input: "Morning.", voice: "ara", response_format: "mp3" } });
    // an OpenAI voice under Flux stays on flux-voice-speak
    await speak(cfg({ provider: "flux" }), "Morning.", "nova", undefined, "flux");
    expect(sent.body).toMatchObject({ model: "flux-voice-speak", voice: "nova" });
  });

  it("a bot saved on xAI before this keeps working: own xAI key when set, else Flux's xAI alias", async () => {
    let sent: any;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)) };
      return new Response(new Uint8Array([5]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    });
    routes(XAI);
    await speak(cfg(), "Hi.", "leo", undefined, "xai");
    expect(sent.url).toBe("https://api.x.ai/v1/tts");
    routes();
    await speak(cfg(), "Hi.", "leo", undefined, "xai");
    expect(sent).toEqual({ url: `${FLUX.baseUrl}/audio/speech`, body: { model: FLUX_GROK_MODEL, input: "Hi.", voice: "leo", response_format: "mp3" } });
    expect(await listVoices(cfg(), undefined, "xai")).toHaveLength(28);
  });

  it("tells the picker whether the owner has an xAI key of their own", () => {
    routes(XAI);
    expect(describeVoice(cfg()).xaiKey).toBe(true);
    routes();
    expect(describeVoice(cfg()).xaiKey).toBe(false);
    expect(describeVoice(cfg()).available.xai).toBe(true);
  });
});

describe("Flux speech resilience", () => {
  const ok = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } });
  afterEach(() => vi.restoreAllMocks());

  it("retries once after a 5xx and then plays", async () => {
    const call = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 502 })).mockResolvedValueOnce(ok());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const audio = await synthesize("Hello there.", "cedar", FLUX, call as unknown as typeof fetch);
    expect(call).toHaveBeenCalledTimes(2);
    expect(audio).toEqual({ bytes: new Uint8Array([1, 2, 3]), mime: "audio/mpeg", timing: { headersMs: expect.any(Number) } });
  });

  it("retries once after a network error", async () => {
    const call = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(ok());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await synthesize("Hello there.", "cedar", FLUX, call as unknown as typeof fetch);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("gives up after the one retry", async () => {
    const call = vi.fn().mockResolvedValue(new Response("{}", { status: 502 }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(synthesize("Hello there.", "cedar", FLUX, call as unknown as typeof fetch)).rejects.toThrow("Speaking failed (502)");
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("never retries a 4xx", async () => {
    const call = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(synthesize("Hello there.", "cedar", FLUX, call as unknown as typeof fetch)).rejects.toThrow(/rejected the saved key/);
    expect(call).toHaveBeenCalledTimes(1);
  });

  // A call stub that never answers until its signal aborts, like a provider
  // that sends no headers.
  const silent = (calls: number[]) =>
    ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        calls.push(Date.now());
        init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })) as unknown as typeof fetch;

  it("gives a short clip 20 s to send headers, a longer one 60 s, and does not retry a slow failure", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls: number[] = [];
    const short = synthesize("Short.", "cedar", FLUX, silent(calls));
    const shortResult = expect(short).rejects.toThrow(/Couldn't reach/);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    await shortResult;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(1);
    const longCalls: number[] = [];
    const long = synthesize("x".repeat(450), "cedar", FLUX, silent(longCalls));
    const longResult = expect(long).rejects.toThrow(/Couldn't reach/);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(longCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await longResult;
    vi.useRealTimers();
  });

  it("the 20 s limit is for the headers only: a streamed body that keeps arriving is not cut", async () => {
    vi.useFakeTimers();
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        await new Promise((r) => setTimeout(r, 5_000));
        chunks += 1;
        c.enqueue(new Uint8Array([chunks]));
        if (chunks === 6) c.close();
      },
    });
    const call = (async (_u: string, init: RequestInit) => { void init; return new Response(body, { status: 200, headers: { "content-type": "audio/mpeg" } }); }) as unknown as typeof fetch;
    const clip = (await synthesizeClip("Short.", "cedar", FLUX, true, call)) as { stream: ReadableStream<Uint8Array> };
    const reader = clip.stream.getReader();
    const got: number[] = [];
    const reading = (async () => { for (;;) { const r = await reader.read(); if (r.done) break; got.push(r.value![0]); } })();
    await vi.advanceTimersByTimeAsync(31_000);
    await reading;
    expect(got).toEqual([1, 2, 3, 4, 5, 6]);
    vi.useRealTimers();
  });

  it("a body that sends nothing for 10 s is cut and logged", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1])); }, pull() { return new Promise(() => {}); } });
    const call = (async () => new Response(body, { status: 200, headers: { "content-type": "audio/mpeg" } })) as unknown as typeof fetch;
    const clip = (await synthesizeClip("Short.", "cedar", FLUX, true, call)) as { stream: ReadableStream<Uint8Array> };
    const reader = clip.stream.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1]));
    const next = reader.read().then(() => "value", () => "error");
    await vi.advanceTimersByTimeAsync(10_500);
    expect(await next).toBe("error");
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.startsWith("[tts] ") && l.includes("status=body-stall") && l.includes("provider=Flux"))).toBe(true);
    vi.useRealTimers();
  });

  it("an unstreamed clip whose body stalls rejects", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); } });
    const call = (async () => new Response(body, { status: 200, headers: { "content-type": "audio/mpeg" } })) as unknown as typeof fetch;
    const result = expect(synthesize("Short.", "cedar", FLUX, call)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_500);
    await result;
    vi.useRealTimers();
  });

  it("retries a 5xx only when it failed fast; a slow 5xx is not retried", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const slow = (async () => { n += 1; await new Promise((r) => setTimeout(r, 9_000)); return new Response("{}", { status: 502 }); }) as unknown as typeof fetch;
    const result = expect(synthesize("Hello there.", "cedar", FLUX, slow)).rejects.toThrow("Speaking failed (502)");
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
    expect(n).toBe(1);
    n = 0;
    const quick = (async () => { n += 1; await new Promise((r) => setTimeout(r, 7_000)); return new Response("{}", { status: 502 }); }) as unknown as typeof fetch;
    const again = expect(synthesize("Hello there.", "cedar", FLUX, quick)).rejects.toThrow("Speaking failed (502)");
    await vi.advanceTimersByTimeAsync(20_000);
    await again;
    expect(n).toBe(2);
    vi.useRealTimers();
  });

  it("logs 4xx and not-audio failures too, with status, provider, model, voice and length, and nothing else", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cases: Array<[Response, string]> = [
      [new Response('{"error":{"message":"secret words"}}', { status: 401 }), "status=401"],
      [new Response("{}", { status: 429 }), "status=429"],
      [new Response("{}", { status: 402 }), "status=402"],
      [new Response("{}", { status: 404 }), "status=404"],
      [new Response("{}", { status: 403 }), "status=403"],
      [new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }), "status=not-audio"],
    ];
    for (const [response, status] of cases) {
      warn.mockClear();
      await expect(synthesize("Secret sentence here.", "cedar", FLUX, (async () => response) as unknown as typeof fetch)).rejects.toThrow();
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines, status).toHaveLength(1);
      expect(lines[0]).toContain(status);
      expect(lines[0]).toContain("provider=Flux");
      expect(lines[0]).toContain("model=flux-voice-speak");
      expect(lines[0]).toContain("voice=cedar");
      expect(lines[0]).toContain("length=21");
      expect(lines[0]).not.toContain("secret");
      expect(lines[0]).not.toContain("Secret");
      expect(lines[0]).not.toContain("flux-test");
      expect(lines[0]).not.toContain("http");
    }
  });

  it("logs each failure with status, provider, model, voice and length, and never the text or key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const call = vi.fn().mockResolvedValue(new Response("{}", { status: 502 }));
    await expect(synthesize("Secret sentence here.", "cedar", FLUX, call as unknown as typeof fetch)).rejects.toThrow();
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) {
      expect(line.startsWith("[tts] ")).toBe(true);
      expect(line).toContain("status=502");
      expect(line).toContain("provider=Flux");
      expect(line).toContain("model=flux-voice-speak");
      expect(line).toContain("voice=cedar");
      expect(line).toContain(`length=${"Secret sentence here.".length}`);
      expect(line).not.toContain("Secret sentence");
      expect(line).not.toContain("flux-test");
    }
  });
});

describe("streamTranscribe", () => {
  it("is reported from the injected stream check and defaults to false", () => {
    useVoiceRoutes({ speech: () => [], describe: () => ({ host: null, lookup: null, speech: null, transcribe: null }) });
    expect(describeVoice(cfg()).streamTranscribe).toBe(false);
    useVoiceRoutes({ speech: () => [], describe: () => ({ host: null, lookup: null, speech: null, transcribe: null }), stream: () => true });
    expect(describeVoice(cfg()).streamTranscribe).toBe(true);
    useVoiceRoutes({ speech: () => [], describe: () => ({ host: null, lookup: null, speech: null, transcribe: null }) });
  });
});
