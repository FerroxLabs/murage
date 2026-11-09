import { afterEach, describe, expect, it, vi } from "vitest";
import { synthesizeClip as flux, SpeechUnavailable } from "./flux-speech.ts";
import { synthesizeClip as xai } from "./xai-speech.ts";
import { synthesizeClip as eleven, type Clip } from "./elevenlabs.ts";
import type { SpeechPolicy } from "./speech-policy.ts";
afterEach(() => { vi.unstubAllGlobals(); });
const endpoint = { via: "flux" as const, label: "fixture", baseUrl: "https://fixture.invalid/v1", key: "fixture", model: "flux-voice-speak" };
const adapters: Array<[string, (policy: SpeechPolicy) => Promise<Clip>]> = [
  ["Flux", policy => flux("Protected words.", "marin", endpoint, true, fetch, 0, policy)],
  ["xAI", policy => xai("Protected words.", "eve", endpoint, true, fetch, policy)],
  ["ElevenLabs", policy => eleven("Protected words.", "fixtureVoice", "fixture", true, policy)],
];
describe.each(adapters)("H-A1-2 actual %s adapter caller cancellation", (_name, synthesize) => {
  it("refuses an already cancelled caller without a fetch", async () => {
    const call = vi.fn(); vi.stubGlobal("fetch", call);
    const control = new AbortController(); control.abort();
    await expect(synthesize({ signal: control.signal, attempts: 1 })).rejects.toThrow(); expect(call).not.toHaveBeenCalled();
  });
  it("aborts the actual pending fetch before headers and confirms local ownership ended", async () => {
    let signal: AbortSignal | undefined;
    const call = vi.fn((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init.signal as AbortSignal;
      signal.addEventListener("abort", () => reject(new DOMException("fixture cancelled", "AbortError")), { once: true });
    })); vi.stubGlobal("fetch", call);
    const control = new AbortController(), tracked: Promise<void>[] = [];
    const pending = synthesize({ signal: control.signal, attempts: 1, track: promise => tracked.push(promise) });
    expect(call).toHaveBeenCalledOnce(); control.abort();
    await expect(pending).rejects.toThrow(); await Promise.all(tracked);
    expect(signal?.aborted).toBe(true); expect(call).toHaveBeenCalledOnce();
  });
  it("keeps cancellation linked after headers, cancels the actual reader, and waits for local cancel confirmation", async () => {
    let confirm!: () => void;
    const cancellation = new Promise<void>(resolve => { confirm = resolve; });
    const cancel = vi.fn(() => cancellation);
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({ pull() {}, cancel }, { highWaterMark: 0 }), { headers: { "content-type": "audio/mpeg" } });
    }));
    const control = new AbortController(), tracked: Promise<void>[] = [];
    const clip = await synthesize({ signal: control.signal, attempts: 1, track: promise => tracked.push(promise) });
    expect("stream" in clip).toBe(true); if (!("stream" in clip)) throw Error("expected stream");
    const reader = clip.stream.getReader(); const reading = reader.read();
    let closed = false; const closure = Promise.all(tracked).then(() => { closed = true; });
    control.abort(); await expect(reading).rejects.toThrow();
    expect(signal?.aborted).toBe(true); expect(cancel).toHaveBeenCalledOnce(); expect(closed).toBe(false);
    confirm(); await closure; expect(closed).toBe(true); reader.releaseLock();
  });
  it("does not confirm cancellation when the actual reader rejects cancellation", async () => {
    const failure = new Error("fixture cancellation unconfirmed");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ pull() {}, cancel() { return Promise.reject(failure); } }), { headers: { "content-type": "audio/mpeg" } })));
    const control = new AbortController(), tracked: Promise<void>[] = [];
    const clip = await synthesize({ signal: control.signal, attempts: 1, track: promise => tracked.push(promise) });
    if (!("stream" in clip)) throw Error("expected stream");
    const reader = clip.stream.getReader(), read = reader.read();
    control.abort(); await expect(read).rejects.toThrow(); await expect(Promise.all(tracked)).rejects.toBe(failure); reader.releaseLock();
  });
  it("releases caller listeners when a successful body ends", async () => {
    const control = new AbortController(); const tracked: Promise<void>[] = [];
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(out) { out.enqueue(Uint8Array.of(1, 2)); out.close(); }, cancel }), { headers: { "content-type": "audio/mpeg" } })));
    const clip = await synthesize({ signal: control.signal, attempts: 1, track: promise => tracked.push(promise) });
    if (!("stream" in clip)) throw Error("expected stream");
    expect([...new Uint8Array(await new Response(clip.stream).arrayBuffer())]).toEqual([1, 2]); await Promise.all(tracked);
    control.abort(); expect(cancel).not.toHaveBeenCalled();
  });
});
it.each([500, 502, 503, 429, 404, 403, 400, 402])("P-fallback Flux single-attempt policy makes one fetch on HTTP %s", async status => {
  const call = vi.fn(async () => new Response(JSON.stringify({ error: { message: "fixture refusal", code: "model_not_allowed" } }), { status }));
  await expect(flux("Safe words.", "marin", endpoint, true, call, 0, { attempts: 1 })).rejects.toThrow();
  expect(call).toHaveBeenCalledOnce();
});
it("P-fallback Flux single-attempt policy does not retry a network error and keeps call defaults", async () => {
  const call = vi.fn(async () => { throw Error("fixture network failure"); });
  await expect(flux("Safe words.", "marin", endpoint, true, call, 0, { attempts: 1 })).rejects.toThrow(); expect(call).toHaveBeenCalledOnce();
  call.mockClear(); await expect(flux("Safe words.", "marin", endpoint, true, call, 0)).rejects.toThrow(); expect(call).toHaveBeenCalledTimes(2);
});
it("unread refusal bodies are cancelled and local ownership is released", async () => {
  const cancel = vi.fn(); const tracked: Promise<void>[] = [];
  const call = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 404 }));
  await expect(flux("Safe words.", "marin", endpoint, true, call, 0, { attempts: 1, track: promise => tracked.push(promise) })).rejects.toBeInstanceOf(SpeechUnavailable);
  await Promise.all(tracked); expect(cancel).toHaveBeenCalledOnce();
});

it("call synthesis carries its source cancellation to the actual provider and cannot enter fallback after abort", async () => {
  const { speakStreamed, useVoiceRoutes } = await import("./index.ts");
  useVoiceRoutes({ speech: () => [endpoint], describe: () => ({ host: "flux", lookup: "flux", speech: "flux", transcribe: "flux" }), xai: () => ({ key: "alternate", baseUrl: "https://alternate.invalid" }) });
  let signal: AbortSignal | undefined;
  const call = vi.fn((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    signal = init.signal as AbortSignal;
    signal.addEventListener("abort", () => reject(Error("fixture interrupted")), { once: true });
  })); vi.stubGlobal("fetch", call);
  const control = new AbortController();
  const pending = speakStreamed({ tts: { provider: "flux" } } as any, "Safe words.", "eve", "flux", { signal: control.signal });
  expect(call).toHaveBeenCalledOnce(); control.abort();
  await expect(pending).rejects.toThrow(); expect(signal?.aborted).toBe(true); expect(call).toHaveBeenCalledOnce();
  useVoiceRoutes({ speech: () => [], describe: () => ({ host: null, lookup: null, speech: null, transcribe: null }) });
});
