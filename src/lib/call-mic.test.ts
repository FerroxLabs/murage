// The call's microphone behind a frame source (spec §4.3.1): the desktop's
// getUserMedia capture and the iPhone's native engine feed the same Capture,
// so Silero, the voice gate and Flux's endpointing run on both.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCallMic, createFallbackMic, NativeFrameSource, utteranceSpeech, WebAudioFrameSource } from "./call-mic";
import { resetNativeShellForTest } from "./native-shell";

// A stand-in for Silero: anything clearly loud is speech. The real model
// needs onnxruntime and a WASM file, neither of which the tests load.
const { vadReset, vadLoad } = vi.hoisted(() => {
  const vadReset = vi.fn();
  const vadLoad = vi.fn(async () => ({
    push: async (frame: Float32Array) => (Math.abs(frame[0] ?? 0) > 0.1 ? 0.95 : 0),
    reset: vadReset,
  }));
  return { vadReset, vadLoad };
});
vi.mock("./silero-vad", () => ({ SileroVad: { load: vadLoad } }));

const FRAME = 1024;

function pcm(samples: number[] | Int16Array): string {
  const ints = samples instanceof Int16Array ? samples : Int16Array.from(samples);
  return Buffer.from(ints.buffer, ints.byteOffset, ints.byteLength).toString("base64");
}
const loud = () => pcm(new Int16Array(FRAME).fill(9_830)); // 0.3
const quiet = () => pcm(new Int16Array(FRAME));

function fakeNative(options: { open?: () => Promise<unknown> } = {}) {
  const listeners = new Set<(detail?: unknown) => unknown>();
  let sessions = 0;
  const bridge = {
    hello: vi.fn(async () => ({ version: 1, methods: ["callAudioOpen", "callAudioClose"] })),
    on: vi.fn((name: string, listener: (detail?: unknown) => unknown) => {
      if (name !== "callAudio") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    callAudioOpen: vi.fn(
      options.open ?? (async () => ({ session: `s${(sessions += 1)}`, sampleRate: 16_000, frame: FRAME })),
    ),
    callAudioClose: vi.fn(async (_args?: unknown) => true),
    /** Like the shells' deliver(): handled only when a listener says `true`. */
    emit(detail: unknown): boolean {
      let handled = false;
      for (const listener of [...listeners]) if (listener(detail) === true) handled = true;
      return handled;
    },
    listeners,
  };
  vi.stubGlobal("murageNative", bridge);
  return bridge;
}

/** Let the Silero queue (a promise chain) drain. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function openWithSilero(mic: ReturnType<typeof createCallMic>) {
  await mic.open();
  await vi.waitFor(() => expect(mic.speechWithin(1)).not.toBeNull());
}

beforeEach(() => {
  vadReset.mockClear();
  vadLoad.mockClear();
});

/** Native as spec §4.1 has it: ONE engine, so an open while another is open
 *  or still opening gets the same session, and a close ends it. */
function fakeEngine() {
  let live: string | null = null;
  let count = 0;
  let starting: Promise<unknown> | null = null;
  const bridge = fakeNative({
    open: () => {
      if (live) return Promise.resolve({ session: live, sampleRate: 16_000, frame: FRAME });
      starting ??= new Promise((resolve) =>
        setTimeout(() => {
          live = `e${(count += 1)}`;
          starting = null;
          resolve({ session: live, sampleRate: 16_000, frame: FRAME });
        }, 5),
      );
      return starting;
    },
  });
  bridge.callAudioClose.mockImplementation(async (args: unknown) => {
    if ((args as { session: string }).session === live) live = null;
    return true;
  });
  return { bridge, live: () => live };
}

afterEach(() => {
  resetNativeShellForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("NativeFrameSource", () => {
  it("opens through callAudioOpen and hands on decoded 1024-sample frames", async () => {
    const bridge = fakeNative();
    const source = new NativeFrameSource();
    const frames: Float32Array[] = [];
    await source.open((frame) => frames.push(frame));
    expect(source.opened).toBe(true);
    expect(source.session).toBe("s1");

    const samples = new Int16Array(FRAME);
    samples.set([0, 16_384, -32_768, 32_767, -16_384]);
    expect(bridge.emit({ type: "mic", session: "s1", pcm: pcm(samples) })).toBe(true);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveLength(FRAME);
    expect([...frames[0].slice(0, 5)]).toEqual([0, 0.5, -1, 32_767 / 32_768, -0.5]);
  });

  it("re-cuts pieces of another length into exact 1024-sample frames", async () => {
    const bridge = fakeNative();
    const source = new NativeFrameSource();
    const frames: Float32Array[] = [];
    await source.open((frame) => frames.push(frame));
    bridge.emit({ type: "mic", session: "s1", pcm: pcm(new Int16Array(600).fill(100)) });
    expect(frames).toHaveLength(0);
    bridge.emit({ type: "mic", session: "s1", pcm: pcm(new Int16Array(600).fill(200)) });
    expect(frames).toHaveLength(1);
    expect(frames[0][599]).toBeCloseTo(100 / 32_768);
    expect(frames[0][600]).toBeCloseTo(200 / 32_768);
  });

  it("ignores another session's events and passes its own non-mic events on", async () => {
    const bridge = fakeNative();
    const source = new NativeFrameSource();
    const frames: Float32Array[] = [];
    const events: unknown[] = [];
    source.onEvent((event) => events.push(event));
    await source.open((frame) => frames.push(frame));
    // still answered, so the watchdog does not count them as unheard
    expect(bridge.emit({ type: "mic", session: "old", pcm: loud() })).toBe(true);
    expect(bridge.emit({ type: "hold", session: "old", reason: "interrupted" })).toBe(true);
    expect(frames).toHaveLength(0);
    expect(events).toEqual([]);
    bridge.emit({ type: "hold", session: "s1", reason: "background" });
    bridge.emit({ type: "resume", session: "s1" });
    bridge.emit({ type: "route", session: "s1", output: "bluetooth" });
    bridge.emit({ type: "clip", session: "s1", clip: "c1", state: "ended" });
    bridge.emit({ type: "lost", session: "s1", reason: "restart-failed" });
    expect(events.map((event) => (event as { type: string }).type)).toEqual(["hold", "resume", "route", "clip", "lost"]);
  });

  it("keeps frames that arrive before the open's reply", async () => {
    let bridge: ReturnType<typeof fakeNative>;
    bridge = fakeNative({
      open: async () => {
        bridge.emit({ type: "mic", session: "early", pcm: loud() });
        return { session: "early", sampleRate: 16_000, frame: FRAME };
      },
    });
    const source = new NativeFrameSource();
    const frames: Float32Array[] = [];
    await source.open((frame) => frames.push(frame));
    expect(frames).toHaveLength(1);
  });

  it("closes its session and unsubscribes, then opens a new one without losing event listeners", async () => {
    const bridge = fakeNative();
    const source = new NativeFrameSource();
    const frames: Float32Array[] = [];
    const events: unknown[] = [];
    source.onEvent((event) => events.push(event));
    await source.open((frame) => frames.push(frame));
    source.close();
    expect(source.opened).toBe(false);
    expect(source.session).toBeNull();
    await settle();
    expect(bridge.callAudioClose).toHaveBeenCalledWith({ session: "s1" });
    expect(bridge.listeners.size).toBe(0);

    await source.open((frame) => frames.push(frame));
    expect(source.session).toBe("s2");
    bridge.emit({ type: "mic", session: "s1", pcm: loud() });
    expect(frames).toHaveLength(0);
    bridge.emit({ type: "mic", session: "s2", pcm: loud() });
    bridge.emit({ type: "resume", session: "s2" });
    expect(frames).toHaveLength(1);
    expect(events).toEqual([{ type: "resume", session: "s2" }]);
  });

  it("closes a session whose open finished after close()", async () => {
    let answer!: (value: unknown) => void;
    const bridge = fakeNative({ open: () => new Promise((resolve) => (answer = resolve)) });
    const source = new NativeFrameSource();
    const opening = source.open(() => {});
    await settle();
    source.close();
    answer({ session: "late", sampleRate: 16_000, frame: FRAME });
    await opening;
    await settle();
    expect(source.opened).toBe(false);
    expect(bridge.callAudioClose).toHaveBeenCalledWith({ session: "late" });
    expect(bridge.listeners.size).toBe(0);
  });

  it.each(["denied", "inactive", "unavailable"])("surfaces the %s error with its code", async (code) => {
    const bridge = fakeNative({ open: async () => Promise.reject(new Error(code)) });
    const source = new NativeFrameSource();
    await expect(source.open(() => {})).rejects.toMatchObject({ code });
    expect(source.opened).toBe(false);
    expect(bridge.listeners.size).toBe(0);
  });

  it("reports anything else, or an app without the method, as unavailable", async () => {
    fakeNative({ open: async () => ({ nope: true }) });
    await expect(new NativeFrameSource().open(() => {})).rejects.toMatchObject({ code: "unavailable" });
    resetNativeShellForTest();
    vi.stubGlobal("murageNative", { hello: async () => ({ version: 1, methods: [] }) });
    await expect(new NativeFrameSource().open(() => {})).rejects.toMatchObject({ code: "unavailable" });
  });

  it("waits for a late hello before opening", async () => {
    const bridge = fakeNative();
    let greet!: () => void;
    bridge.hello.mockImplementation(
      () => new Promise((resolve) => (greet = () => resolve({ version: 1, methods: ["callAudioOpen", "callAudioClose"] }))),
    );
    const source = new NativeFrameSource();
    const opening = source.open(() => {});
    await settle();
    expect(bridge.callAudioOpen).not.toHaveBeenCalled();
    greet();
    await opening;
    expect(source.session).toBe("s1");
  });
});

describe("NativeFrameSource open and close, one engine", () => {
  it("a close during an open, then a quick reopen, leaves the new session running", async () => {
    const engine = fakeEngine();
    const source = new NativeFrameSource();
    const first = source.open(() => {});
    await settle(); // callAudioOpen is on its way
    source.close();
    await source.open(() => {});
    await first;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(source.session).not.toBeNull();
    expect(source.session).toBe(engine.live());
  });

  it("serialises across instances too", async () => {
    const engine = fakeEngine();
    const a = new NativeFrameSource();
    const b = new NativeFrameSource();
    const first = a.open(() => {});
    await settle();
    a.close();
    await b.open(() => {});
    await first;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(a.opened).toBe(false);
    expect(b.session).toBe(engine.live());
    expect(b.session).not.toBeNull();
  });

  it("a second open while one is in flight waits for it and opens once", async () => {
    const bridge = fakeNative();
    const source = new NativeFrameSource();
    const one = source.open(() => {});
    const two = source.open(() => {});
    await two;
    expect(source.opened).toBe(true);
    await one;
    expect(bridge.callAudioOpen).toHaveBeenCalledTimes(1);
  });
});

describe("NativeFrameSource edges", () => {
  it("ignores bad base64 and still answers the event", async () => {
    const bridge = fakeNative();
    const source = new NativeFrameSource();
    const frames: Float32Array[] = [];
    await source.open((frame) => frames.push(frame));
    expect(bridge.emit({ type: "mic", session: "s1", pcm: "%%%not base64%%%" })).toBe(true);
    expect(frames).toHaveLength(0);
  });

  it("drops a trailing odd byte without shifting later samples", async () => {
    const bridge = fakeNative();
    const source = new NativeFrameSource();
    const frames: Float32Array[] = [];
    await source.open((frame) => frames.push(frame));
    const odd = Buffer.concat([Buffer.from(new Int16Array(FRAME).fill(100).buffer), Buffer.from([0x7f])]);
    bridge.emit({ type: "mic", session: "s1", pcm: odd.toString("base64") });
    bridge.emit({ type: "mic", session: "s1", pcm: pcm(new Int16Array(FRAME).fill(200)) });
    expect(frames).toHaveLength(2);
    expect(frames[1][0]).toBeCloseTo(200 / 32_768);
    expect(frames[1][FRAME - 1]).toBeCloseTo(200 / 32_768);
  });

  it("drops a partial frame on reopen and keeps the clock running across it", async () => {
    const bridge = fakeNative();
    const source = new NativeFrameSource();
    const times: Array<number | undefined> = [];
    const frames: Float32Array[] = [];
    const take = (frame: Float32Array, at?: number) => {
      frames.push(frame);
      times.push(at);
    };
    await source.open(take);
    bridge.emit({ type: "mic", session: "s1", pcm: loud() });
    bridge.emit({ type: "mic", session: "s1", pcm: pcm(new Int16Array(600).fill(100)) });
    source.close();
    await source.open(take);
    bridge.emit({ type: "mic", session: "s2", pcm: pcm(new Int16Array(FRAME).fill(200)) });
    expect(frames).toHaveLength(2);
    expect(frames[1][0]).toBeCloseTo(200 / 32_768);
    expect(times).toEqual([64, 128]);
  });

  it("keeps at most 16 events from before the reply", async () => {
    let bridge: ReturnType<typeof fakeNative>;
    bridge = fakeNative({
      open: async () => {
        for (let i = 0; i < 20; i += 1) bridge.emit({ type: "mic", session: "early", pcm: loud() });
        return { session: "early", sampleRate: 16_000, frame: FRAME };
      },
    });
    const source = new NativeFrameSource();
    const frames: Float32Array[] = [];
    await source.open((frame) => frames.push(frame));
    expect(frames).toHaveLength(16);
  });

  it("answers native even when a frame or event listener throws", async () => {
    const bridge = fakeNative();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const source = new NativeFrameSource();
    source.onEvent(() => {
      throw new Error("listener");
    });
    await source.open(() => {
      throw new Error("frame");
    });
    expect(bridge.emit({ type: "mic", session: "s1", pcm: loud() })).toBe(true);
    expect(bridge.emit({ type: "resume", session: "s1" })).toBe(true);
    expect(error).toHaveBeenCalledTimes(2);
  });
});

describe("Capture on native frames", () => {
  it("runs Silero, so speech is judged rather than loudness", async () => {
    const bridge = fakeNative();
    const mic = createCallMic("flux", { source: new NativeFrameSource() });
    await openWithSilero(mic);
    const voices: boolean[] = [];
    mic.onVoice((speaking) => voices.push(speaking));
    for (let i = 0; i < 4; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: loud() });
    await settle();
    expect(mic.speechWithin(500)).toBe(true);
    expect(voices).toEqual([true]);
    mic.close();
  });

  it("times frames by samples, so a burst does not squash the window", async () => {
    const bridge = fakeNative();
    const mic = createCallMic("flux", { source: new NativeFrameSource() });
    await openWithSilero(mic);
    // all of this lands in the same millisecond of wall time
    for (let i = 0; i < 5; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: loud() });
    for (let i = 0; i < 30; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: quiet() });
    await settle();
    // 30 quiet frames are 1.92 s of audio after the last speech
    expect(mic.speechWithin(1_000)).toBe(false);
    expect(mic.speechWithin(2_500)).toBe(true);
    expect(mic.speechShare(1_000)).toBe(0);
    expect(mic.speechShare(5_000)).toBeCloseTo(5 / 35);
    mic.close();
  });

  it("does not age speech while no frames arrive (a hold)", async () => {
    const bridge = fakeNative();
    const mic = createCallMic("flux", { source: new NativeFrameSource() });
    await openWithSilero(mic);
    for (let i = 0; i < 5; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: loud() });
    await settle();
    const spy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    expect(mic.speechWithin(500)).toBe(true);
    spy.mockRestore();
    mic.close();
  });

  it("resetDetection forgets speech, the gate, Silero and a half-heard utterance", async () => {
    const bridge = fakeNative();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ text: "hi" })));
    vi.stubGlobal("fetch", fetch);
    const mic = createCallMic("flux", { source: new NativeFrameSource() });
    await openWithSilero(mic);
    const lines: unknown[] = [];
    const voices: boolean[] = [];
    mic.onLine((line) => lines.push(line));
    mic.onVoice((speaking) => voices.push(speaking));
    await mic.start({ endpointMs: 300 });
    for (let i = 0; i < 4; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: loud() });
    await settle();
    expect(lines).toEqual([{ text: "…", partial: true }]);

    mic.resetDetection();
    expect(vadReset).toHaveBeenCalled();
    expect(mic.speechWithin(60_000)).toBe(false);
    expect(mic.speechShare(60_000)).toBe(0);
    // the recording was dropped: silence after it transcribes nothing, and
    // the gate starts over, so it never reports the old speech ending
    for (let i = 0; i < 12; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: quiet() });
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(voices).toEqual([true]);
    mic.close();
  });

  it("without a reset, the same silence ends and transcribes the utterance", async () => {
    const bridge = fakeNative();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ text: "hi" })));
    vi.stubGlobal("fetch", fetch);
    const mic = createCallMic("flux", { source: new NativeFrameSource() });
    await openWithSilero(mic);
    await mic.start({ endpointMs: 300 });
    for (let i = 0; i < 4; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: loud() });
    for (let i = 0; i < 12; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: quiet() });
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    mic.close();
  });

  it("a Flux line carries the speech Silero heard in its own utterance, not in the last moments", async () => {
    const bridge = fakeNative();
    // the transcription answers only when the test says, 2.5 s of audio later
    let answer: (response: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))));
    const mic = createCallMic("flux", { source: new NativeFrameSource() });
    await openWithSilero(mic);
    const lines: Array<Record<string, unknown>> = [];
    mic.onLine((line) => lines.push({ ...line }));
    await mic.start({ endpointMs: 300 });
    // 3 quiet frames (the preroll before speech), 4 of speech, then the
    // silence that ends it (5 frames at 300 ms)
    for (let i = 0; i < 3; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: quiet() });
    for (let i = 0; i < 4; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: loud() });
    for (let i = 0; i < 5; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: quiet() });
    await settle();
    expect(mic.pending()).toBe(true);
    // Flux takes its time: by the answer, the speech is long out of any window
    for (let i = 0; i < 40; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: quiet() });
    await settle();
    expect(mic.speechWithin(1_500)).toBe(false);
    expect(mic.speechShare(1_500)).toBe(0);
    answer(new Response(JSON.stringify({ text: "stop" })));
    await vi.waitFor(() => expect(lines.at(-1)).toMatchObject({ text: "stop", partial: false }));
    // share over the utterance up to its last speech: 4 of 7 frames, the
    // trailing silence that only ended it left out
    expect(lines.at(-1)!.speech).toEqual({ heard: true, share: expect.closeTo(4 / 7, 5) });
    expect(mic.pending()).toBe(false);
    mic.close();
  });

  it("is pending from the first word of an utterance until its line is out, and not after stop or a reset", async () => {
    const bridge = fakeNative();
    let answer: (response: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))));
    const mic = createCallMic("flux", { source: new NativeFrameSource() });
    await openWithSilero(mic);
    const pendingAtLine: boolean[] = [];
    mic.onLine((line) => {
      if (line.partial === false) pendingAtLine.push(mic.pending());
    });
    await mic.start({ endpointMs: 300 });
    expect(mic.pending()).toBe(false);
    for (let i = 0; i < 4; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: loud() });
    await settle();
    expect(mic.pending()).toBe(true); // recording
    for (let i = 0; i < 5; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: quiet() });
    await settle();
    expect(mic.pending()).toBe(true); // transcribing
    answer(new Response(JSON.stringify({ text: "" })));
    await vi.waitFor(() => expect(pendingAtLine).toEqual([false]));
    // the gate hears that speech end before the next one starts
    for (let i = 0; i < 8; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: quiet() });

    // stop() aborts a transcription in flight: nothing is pending after it
    await mic.start({ endpointMs: 300 });
    for (let i = 0; i < 4; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: loud() });
    for (let i = 0; i < 5; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: quiet() });
    await settle();
    expect(mic.pending()).toBe(true);
    await mic.stop();
    expect(mic.pending()).toBe(false);
    for (let i = 0; i < 8; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: quiet() });

    // a reset drops a half-heard utterance
    await mic.start({ endpointMs: 300 });
    for (let i = 0; i < 4; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: loud() });
    await settle();
    expect(mic.pending()).toBe(true);
    mic.resetDetection();
    expect(mic.pending()).toBe(false);
    mic.close();
  });

  it("a line heard without a speech model carries no evidence, so the call falls back to its windows", async () => {
    const bridge = fakeNative();
    vadLoad.mockRejectedValueOnce(new Error("no onnxruntime"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ text: "hello there" }))));
    const mic = createCallMic("flux", { source: new NativeFrameSource() });
    await mic.open();
    await settle();
    expect(mic.speechWithin(1)).toBeNull();
    const lines: Array<Record<string, unknown>> = [];
    mic.onLine((line) => lines.push({ ...line }));
    await mic.start({ endpointMs: 300 });
    for (let i = 0; i < 8; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: loud() });
    for (let i = 0; i < 10; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: quiet() });
    await vi.waitFor(() => expect(lines.at(-1)).toMatchObject({ text: "hello there", partial: false }));
    expect(lines.at(-1)).not.toHaveProperty("speech");
    mic.close();
  });

  it("muting mid-utterance drops it and ends the voice, so nothing waits on it", async () => {
    const bridge = fakeNative();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ text: "hi" })));
    vi.stubGlobal("fetch", fetch);
    const mic = createCallMic("flux", { source: new NativeFrameSource() });
    await openWithSilero(mic);
    const voices: boolean[] = [];
    mic.onVoice((speaking) => voices.push(speaking));
    await mic.start({ endpointMs: 300 });
    for (let i = 0; i < 4; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: loud() });
    await settle();
    expect(mic.pending()).toBe(true);
    mic.setMuted(true);
    expect(mic.pending()).toBe(false);
    expect(voices).toEqual([true, false]);
    // unmuted: silence ends nothing, because nothing is being recorded
    mic.setMuted(false);
    for (let i = 0; i < 12; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: quiet() });
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    mic.close();
  });

  describe("hearing while a line is out for transcription", () => {
    /** A fetch whose answers the test gives, in order. */
    function slowFetch() {
      const answers: Array<(response: Response) => void> = [];
      const bodies: Blob[] = [];
      const fetch = vi.fn((_url: string, init: RequestInit) => {
        bodies.push(init.body as Blob);
        return new Promise<Response>((resolve) => answers.push(resolve));
      });
      vi.stubGlobal("fetch", fetch);
      return { fetch, answers, bodies };
    }
    const frames = (bridge: ReturnType<typeof fakeNative>, make: () => string, n: number) => {
      for (let i = 0; i < n; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: make() });
    };

    it("keeps words begun while the last line was out, and the next start carries on with them", async () => {
      const bridge = fakeNative();
      const slow = slowFetch();
      const mic = createCallMic("flux", { source: new NativeFrameSource() });
      await openWithSilero(mic);
      const lines: Array<Record<string, unknown>> = [];
      mic.onLine((line) => lines.push({ ...line }));
      await mic.start({ endpointMs: 300 });
      frames(bridge, loud, 4);
      frames(bridge, quiet, 8);
      await settle();
      expect(slow.fetch).toHaveBeenCalledTimes(1);
      // the owner goes on while the first half is out
      frames(bridge, loud, 4);
      await settle();
      expect(lines.filter((l) => l.text === "…")).toHaveLength(1);
      expect(mic.pending()).toBe(true);
      slow.answers[0](new Response(JSON.stringify({ text: "Blues Brothers," })));
      await vi.waitFor(() => expect(lines.at(-1)).toMatchObject({ text: "Blues Brothers,", partial: false }));
      // the call opens the next turn: the utterance under way is its start
      await mic.start({ endpointMs: 300 });
      expect(lines.at(-1)).toEqual({ text: "…", partial: true });
      frames(bridge, loud, 2);
      frames(bridge, quiet, 5);
      await settle();
      expect(slow.fetch).toHaveBeenCalledTimes(2);
      // every loud frame since it began is in the clip (6 speech, plus preroll)
      expect(slow.bodies[1].size).toBeGreaterThanOrEqual(44 + 6 * FRAME * 2);
      mic.close();
    });

    it("an utterance said in full while the last line was out is transcribed on the next start", async () => {
      const bridge = fakeNative();
      const slow = slowFetch();
      const mic = createCallMic("flux", { source: new NativeFrameSource() });
      await openWithSilero(mic);
      const lines: Array<Record<string, unknown>> = [];
      mic.onLine((line) => lines.push({ ...line }));
      await mic.start({ endpointMs: 300 });
      frames(bridge, loud, 4);
      frames(bridge, quiet, 8);
      frames(bridge, loud, 4);
      frames(bridge, quiet, 8);
      await settle();
      // one at a time, in order
      expect(slow.fetch).toHaveBeenCalledTimes(1);
      slow.answers[0](new Response(JSON.stringify({ text: "dead on the money." })));
      await vi.waitFor(() => expect(lines.at(-1)).toMatchObject({ text: "dead on the money.", partial: false }));
      await mic.start({ endpointMs: 300 });
      expect(slow.fetch).toHaveBeenCalledTimes(2);
      slow.answers[1](new Response(JSON.stringify({ text: "across the board there." })));
      await vi.waitFor(() => expect(lines.at(-1)).toMatchObject({ text: "across the board there.", partial: false }));
      mic.close();
    });

    it("stop() drops what was heard while the line was out", async () => {
      const bridge = fakeNative();
      const slow = slowFetch();
      const mic = createCallMic("flux", { source: new NativeFrameSource() });
      await openWithSilero(mic);
      await mic.start({ endpointMs: 300 });
      frames(bridge, loud, 4);
      frames(bridge, quiet, 8);
      frames(bridge, loud, 4);
      await settle();
      await mic.stop();
      expect(mic.pending()).toBe(false);
      await mic.start({ endpointMs: 300 });
      frames(bridge, quiet, 8);
      await settle();
      expect(slow.fetch).toHaveBeenCalledTimes(1);
      mic.close();
    });
  });

  it("drops frames still queued for Silero when detection resets", async () => {
    const bridge = fakeNative();
    const mic = createCallMic("flux", { source: new NativeFrameSource() });
    await openWithSilero(mic);
    for (let i = 0; i < 5; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: loud() });
    mic.resetDetection();
    await settle();
    expect(mic.speechWithin(60_000)).toBe(false);
    expect(mic.speechShare(60_000)).toBe(0);
    mic.close();
  });

  it("loads Silero once when the source reopens while it is still loading", async () => {
    fakeNative();
    const source = new NativeFrameSource();
    const mic = createCallMic("flux", { source });
    await mic.open();
    source.close();
    await mic.open();
    await vi.waitFor(() => expect(mic.speechWithin(1)).not.toBeNull());
    expect(vadLoad).toHaveBeenCalledTimes(1);
    mic.close();
  });

  it("reopens the source after lost without dropping Capture's listeners", async () => {
    const bridge = fakeNative();
    const source = new NativeFrameSource();
    const mic = createCallMic("flux", { source });
    await openWithSilero(mic);
    const voices: boolean[] = [];
    mic.onVoice((speaking) => voices.push(speaking));
    bridge.emit({ type: "lost", session: "s1", reason: "restart-failed" });
    source.close();
    await mic.open();
    expect(source.session).toBe("s2");
    for (let i = 0; i < 4; i += 1) bridge.emit({ type: "mic", session: "s2", pcm: loud() });
    await settle();
    expect(voices).toEqual([true]);
    mic.close();
    await settle();
    expect(bridge.callAudioClose).toHaveBeenLastCalledWith({ session: "s2" });
  });
});

describe("the desktop source", () => {
  function fakeWebAudio() {
    const track = { stop: vi.fn() };
    const node = {
      onaudioprocess: null as null | ((event: unknown) => void),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const contexts: unknown[] = [];
    class FakeAudioContext {
      destination = {};
      constructor(public options: unknown) {
        contexts.push(this);
      }
      createMediaStreamSource() {
        return { connect: vi.fn() };
      }
      createScriptProcessor() {
        return node;
      }
      close = vi.fn(async () => undefined);
    }
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const feed = (value: number) =>
      node.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(FRAME).fill(value) } });
    return { track, node, contexts, getUserMedia, feed };
  }

  it("is the default, captures echo-cancelled audio, and runs Silero on it", async () => {
    const web = fakeWebAudio();
    const mic = createCallMic("flux");
    await openWithSilero(mic);
    expect(web.getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });
    expect(web.contexts).toHaveLength(1);
    for (let i = 0; i < 4; i += 1) web.feed(0.3);
    await settle();
    expect(mic.speechWithin(500)).toBe(true);
    mic.close();
    expect(web.track.stop).toHaveBeenCalled();
    expect(web.node.onaudioprocess).toBeNull();
  });

  it("opens once", async () => {
    const web = fakeWebAudio();
    const source = new WebAudioFrameSource();
    await source.open(() => {});
    await source.open(() => {});
    expect(web.getUserMedia).toHaveBeenCalledTimes(1);
    expect(source.opened).toBe(true);
    source.close();
    expect(source.opened).toBe(false);
  });
});

describe("utteranceSpeech", () => {
  const f = (speech: boolean, any = speech) => ({ speech, any });

  it("is null when any frame went unjudged, or there are none", () => {
    expect(utteranceSpeech([f(true), null, f(true)])).toBeNull();
    expect(utteranceSpeech([])).toBeNull();
  });

  it("counts a pause inside the utterance, and leaves out only the silence after its last speech", () => {
    // speech, a mid-sentence pause, speech, then the endpoint silence
    const frames = [f(true), f(true), f(false), f(false), f(true), f(false), f(false), f(false)];
    expect(utteranceSpeech(frames)).toEqual({ heard: true, share: 3 / 5 });
  });

  it("is no speech at all when nothing reached the speech bar", () => {
    expect(utteranceSpeech([f(false), f(false)])).toEqual({ heard: false, share: 0 });
    // heard at the lower bar only: someone spoke, quietly, but no share
    expect(utteranceSpeech([f(false, true), f(false)])).toEqual({ heard: true, share: 0 });
  });
});

describe("a failed transcription (callbar-rereview3.md A5)", () => {
  /** One utterance said to a Flux mic whose fetch the test scripts. */
  async function sayOnce(answers: Array<() => Promise<Response>>) {
    const bridge = fakeNative();
    const fetchSpy = vi.fn(async () => (answers.shift() ?? answers[0])!());
    vi.stubGlobal("fetch", fetchSpy);
    const mic = createCallMic("flux", { source: new NativeFrameSource() });
    await openWithSilero(mic);
    const lines: Array<Record<string, unknown>> = [];
    const ends: Array<{ code: number | null; reason?: string }> = [];
    mic.onLine((line) => lines.push({ ...line }));
    mic.onEnd((end) => ends.push({ ...end }));
    await mic.start({ endpointMs: 300 });
    for (let i = 0; i < 4; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: loud() });
    for (let i = 0; i < 12; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: quiet() });
    return { mic, lines, ends, fetchSpy };
  }

  it("one tunnel blip is retried once, and the owner's words still arrive", async () => {
    const { mic, lines, ends, fetchSpy } = await sayOnce([
      async () => Promise.reject(new TypeError("network down")),
      async () => new Response(JSON.stringify({ text: "what is on the board" })),
    ]);
    await vi.waitFor(() => expect(lines.at(-1)).toMatchObject({ text: "what is on the board", partial: false }), { timeout: 3_000 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(ends).toEqual([{ code: 0, reason: "completed" }]);
    mic.close();
  });

  it("a server error is retried once too", async () => {
    const { mic, lines, fetchSpy } = await sayOnce([
      async () => new Response(JSON.stringify({ error: "x", reason: "upstream" }), { status: 502 }),
      async () => new Response(JSON.stringify({ text: "hello" })),
    ]);
    await vi.waitFor(() => expect(lines.at(-1)).toMatchObject({ text: "hello", partial: false }), { timeout: 3_000 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    mic.close();
  });

  it("still down after the retry: one transcription-unreachable end, so the call can say so and listen again", async () => {
    const { mic, ends, fetchSpy } = await sayOnce([async () => Promise.reject(new TypeError("network down"))]);
    await vi.waitFor(() => expect(ends).toHaveLength(1), { timeout: 3_000 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(ends[0]).toEqual({ code: 1, reason: "transcription-unreachable" });
    mic.close();
  });

  it("a refusal is not retried, and ends as a transcription failure whatever the server called it", async () => {
    const { mic, ends, fetchSpy } = await sayOnce([async () => new Response(JSON.stringify({ error: "too big", reason: "too_large" }), { status: 413 })]);
    await vi.waitFor(() => expect(ends).toHaveLength(1), { timeout: 3_000 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(ends[0]).toEqual({ code: 1, reason: "transcription-failed" });
    mic.close();
  });
});

describe("the Mac helper's own microphone follows the call's mute (review I1)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a muted helper mic never starts recognition, and stops one running", async () => {
    const speechStart = vi.fn(async () => {});
    const speechStop = vi.fn(async () => {});
    vi.stubGlobal("window", { muragebox: { speechStart, speechStop } });
    const mic = createFallbackMic();
    mic.setMuted(true);
    expect(speechStop).toHaveBeenCalledTimes(1);
    await mic.start({ endpointMs: 300 });
    expect(speechStart).not.toHaveBeenCalled();
    mic.setMuted(false);
    await mic.start({ endpointMs: 300 });
    expect(speechStart).toHaveBeenCalledTimes(1);
  });
});

describe("onLevel: loudness for the call screen's visuals", () => {
  /** A source the test feeds by hand. */
  class HandSource {
    opened = false;
    private onFrame: ((frame: Float32Array, at?: number) => void) | null = null;
    async open(onFrame: (frame: Float32Array, at?: number) => void) {
      this.opened = true;
      this.onFrame = onFrame;
    }
    feed(value: number) {
      this.onFrame?.(new Float32Array(1024).fill(value), 64);
    }
    close() {
      this.opened = false;
      this.onFrame = null;
    }
  }

  it("hands out each frame's RMS as it is computed, 0 while muted, and stops when unsubscribed", async () => {
    const source = new HandSource();
    const mic = createCallMic("flux", { source });
    await mic.open();
    const levels: number[] = [];
    const off = mic.onLevel!((rms) => levels.push(rms));
    source.feed(0.25);
    expect(levels).toEqual([0.25]);
    mic.setMuted(true);
    source.feed(0.25);
    expect(levels).toEqual([0.25, 0]);
    mic.setMuted(false);
    off();
    source.feed(0.25);
    expect(levels).toEqual([0.25, 0]);
    mic.close();
  });
});

describe("capture times from the native source (Astra 3 I3)", () => {
  it("stamps a delivered batch back from its arrival, keeps spacing, and never shifts after a hold", async () => {
    vi.useFakeTimers();
    try {
      const bridge = fakeNative();
      const source = new NativeFrameSource();
      const stamps: number[] = [];
      await source.open((_frame, _at, capturedAt) => stamps.push(capturedAt!));
      const t0 = Date.now();
      bridge.emit({ type: "mic", session: "s1", pcm: pcm(new Int16Array(FRAME * 3)) }); // three frames arrive together
      expect(stamps).toEqual([t0 - 128, t0 - 64, t0]); // spaced, the last at arrival, none in the future
      vi.advanceTimersByTime(30_000); // a hold: native sends nothing
      bridge.emit({ type: "mic", session: "s1", pcm: quiet() });
      expect(stamps.at(-1)).toBe(t0 + 30_000); // its own arrival, not 30 s in the past
    } finally {
      vi.useRealTimers();
    }
  });
});
