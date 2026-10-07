// The call's audio path (spec §4.3.2, §4.3.3, §4.3.5): which microphone and
// speaker a call uses, chosen when it opens, and what happens when the
// iPhone's native engine refuses, is not ready, or is lost mid-call.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CallAudio, HELD_RESUME_OFFER_MS, offerResumeWhenHeld } from "./call-audio";
import { createCallMic, type CallMic } from "./call-mic";
import { resetNativeShellForTest } from "./native-shell";
import { Speaker } from "./tts";

// No speech model in these tests: the loudness gate carries the call, which
// is enough to see frames reach the microphone's listeners.
vi.mock("./silero-vad", () => ({ SileroVad: { load: async () => Promise.reject(new Error("no model")) } }));

const FRAME = 1024;
const ALL = ["callAudioOpen", "callAudioClose", "callAudioPlay", "callAudioControl"];

function pcm(value: number): string {
  const ints = new Int16Array(FRAME).fill(value);
  return Buffer.from(ints.buffer).toString("base64");
}

type Log = string[];

function fakeNative(options: { methods?: string[]; opens?: Array<"denied" | "inactive" | "unavailable" | null> } = {}) {
  const log: Log = [];
  const handlers = { callAudio: new Set<(detail?: unknown) => unknown>(), resume: new Set<(detail?: unknown) => unknown>() };
  const opens = [...(options.opens ?? [])];
  let sessions = 0;
  const bridge = {
    hello: vi.fn(async () => ({ version: 1, methods: options.methods ?? ALL })),
    on: vi.fn((name: string, fn: (detail?: unknown) => unknown) => {
      const set = handlers[name as keyof typeof handlers];
      if (!set) return () => {};
      set.add(fn);
      return () => set.delete(fn);
    }),
    callAudioOpen: vi.fn(async () => {
      log.push("open");
      const error = opens.shift();
      if (error) throw Object.assign(new Error(error), { code: error });
      sessions += 1;
      return { session: `s${sessions}`, sampleRate: 16_000, frame: FRAME };
    }),
    callAudioClose: vi.fn(async (args: { session: string }) => {
      log.push(`close ${args.session}`);
      return true;
    }),
    callAudioPlay: vi.fn(async (args: Record<string, unknown>) => {
      log.push(`play ${String(args.session)} ${String(args.seq)}`);
      return true;
    }),
    callAudioControl: vi.fn(async (args: { session: string; action: string }) => {
      log.push(`control ${args.session} ${args.action}`);
      return true;
    }),
    emit(detail: unknown) {
      for (const fn of [...handlers.callAudio]) fn(detail);
    },
    appResume() {
      for (const fn of [...handlers.resume]) fn();
    },
    log,
  };
  vi.stubGlobal("murageNative", bridge);
  return bridge;
}

/** getUserMedia and Web Audio as the desktop has them, counted. */
function fakeWebAudio(log: Log = []) {
  const constructed = { contexts: 0, audios: 0 };
  class FakeContext {
    constructor() {
      constructed.contexts += 1;
    }
    createMediaStreamSource() {
      return { connect() {} };
    }
    createScriptProcessor() {
      return { connect() {}, disconnect() {}, onaudioprocess: null };
    }
    destination = {};
    close() {
      return Promise.resolve();
    }
  }
  class FakeAudio {
    constructor() {
      constructed.audios += 1;
    }
  }
  const getUserMedia = vi.fn(async (): Promise<{ getTracks: () => Array<{ stop(): void }> }> => {
    log.push("getUserMedia");
    return { getTracks: () => [] };
  });
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  return { constructed, getUserMedia };
}

function storage(values: Record<string, string>) {
  vi.stubGlobal("localStorage", { getItem: (key: string) => values[key] ?? null });
}

/** CallView's render-time choice: Flux transcription on a phone. */
function callAudio(kind: CallMic["kind"] = "flux") {
  return new CallAudio({ kindFor: () => kind, web: createCallMic(kind) });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  resetNativeShellForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("choosing the path when the call opens", () => {
  it("takes the native path when callAudioOpen is listed and the switch is on", async () => {
    const bridge = fakeNative();
    const web = fakeWebAudio();
    const audio = callAudio();
    await audio.open();
    expect(audio.path).toBe("native");
    expect(audio.source?.session).toBe("s1");
    expect(bridge.callAudioOpen).toHaveBeenCalledTimes(1);
    expect(web.getUserMedia).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith("[call-diag] audio native");
    audio.close();
  });

  it("takes the web path when the app does not list callAudioOpen", async () => {
    const bridge = fakeNative({ methods: ["haptic"] });
    const web = fakeWebAudio();
    const audio = callAudio();
    await audio.open();
    expect(audio.path).toBe("web");
    expect(audio.source).toBeNull();
    expect(bridge.callAudioOpen).not.toHaveBeenCalled();
    expect(web.getUserMedia).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith("[call-diag] audio web");
    audio.close();
  });

  it("takes the web path when the switch is off on this device", async () => {
    const bridge = fakeNative();
    storage({ "murage.call.nativeAudio": "off" });
    const web = fakeWebAudio();
    const audio = callAudio();
    await audio.open();
    expect(audio.path).toBe("web");
    expect(bridge.callAudioOpen).not.toHaveBeenCalled();
    expect(web.getUserMedia).toHaveBeenCalledTimes(1);
    audio.close();
  });

  it("takes the web path in a browser with no app around it", async () => {
    const web = fakeWebAudio();
    const audio = callAudio();
    await audio.open();
    expect(audio.path).toBe("web");
    expect(web.getUserMedia).toHaveBeenCalledTimes(1);
    audio.close();
  });

  it("never asks a Mac's bridge: Apple's recognizer is never the native path", async () => {
    const bridge = fakeNative();
    fakeWebAudio();
    const web = { kind: "apple", open: vi.fn(async () => undefined), close: vi.fn() } as unknown as CallMic;
    const audio = new CallAudio({ kindFor: () => "apple", web });
    await audio.open();
    expect(audio.path).toBe("web");
    expect(audio.mic).toBe(web);
    expect(bridge.hello).not.toHaveBeenCalled();
    audio.close();
  });

  it("counts capture as possible when the native method is there, even without mediaDevices", async () => {
    fakeNative();
    const kindFor = vi.fn((capture: boolean) => (capture ? ("flux" as const) : null));
    const audio = new CallAudio({ kindFor, web: createCallMic("flux") });
    await audio.open();
    expect(kindFor).toHaveBeenCalledWith(true);
    expect(audio.path).toBe("native");
    expect(audio.mic.kind).toBe("flux");
    audio.close();
  });

  it("chooses once: opening again reuses the session", async () => {
    const bridge = fakeNative();
    const audio = callAudio();
    await audio.open();
    const mic = audio.mic;
    await audio.open();
    expect(audio.mic).toBe(mic);
    expect(bridge.hello).toHaveBeenCalledTimes(1);
    expect(bridge.callAudioOpen).toHaveBeenCalledTimes(1);
    audio.close();
  });
});

describe("the page stays silent on the native path (spec §4.3.3)", () => {
  it("builds no AudioContext and no Audio: the mic, a reply and the pulse all go to native", async () => {
    const bridge = fakeNative();
    const web = fakeWebAudio();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/prepare")
          ? new Response(JSON.stringify({ ready: true, utterances: ["Hello there."] }))
          : new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }),
      ),
    );
    const audio = callAudio();
    await audio.open();
    const player = audio.player()!;
    const speaker = new Speaker();
    speaker.useOutput(player);
    const spoken = speaker.speak("Hello there.");
    await vi.waitFor(() => expect(bridge.callAudioPlay).toHaveBeenCalled());
    const clip = (bridge.callAudioPlay.mock.calls[0][0] as { clip: string }).clip;
    await vi.waitFor(() => expect(bridge.callAudioPlay.mock.calls.some(([args]) => args.last === true)).toBe(true));
    bridge.emit({ type: "clip", session: "s1", clip, state: "ended" });
    await spoken;
    audio.pulse(true);
    await settle();
    expect(bridge.log).toContain("control s1 pulseOn");
    expect(web.constructed).toEqual({ contexts: 0, audios: 0 });
    expect(web.getUserMedia).not.toHaveBeenCalled();
    speaker.stop();
    speaker.useOutput(null);
    audio.close();
  });

  it("the desktop path does build its capture context, so the guard above means something", async () => {
    fakeNative({ methods: [] });
    const web = fakeWebAudio();
    const audio = callAudio();
    await audio.open();
    expect(web.constructed.contexts).toBe(1);
    expect(audio.player()).toBeNull();
    audio.close();
  });

  it("pauses the page's own media before callAudioOpen", async () => {
    const bridge = fakeNative();
    const pause = vi.fn(() => bridge.log.push("pause media"));
    const playing = { paused: false, pause };
    const stopped = { paused: true, pause: vi.fn() };
    const querySelectorAll = vi.fn(() => [playing, stopped]);
    vi.stubGlobal("document", { querySelectorAll });
    const audio = callAudio();
    await audio.open();
    expect(querySelectorAll).toHaveBeenCalledWith("audio, video");
    expect(bridge.log.slice(0, 2)).toEqual(["pause media", "open"]);
    expect(stopped.pause).not.toHaveBeenCalled();
    audio.close();
  });

  it("does not touch page media on the web path", async () => {
    fakeNative({ methods: [] });
    fakeWebAudio();
    const querySelectorAll = vi.fn(() => []);
    vi.stubGlobal("document", { querySelectorAll });
    const audio = callAudio();
    await audio.open();
    expect(querySelectorAll).not.toHaveBeenCalled();
    audio.close();
  });
});

describe("when native says no (spec §4.3.2)", () => {
  it("inactive: tries once more on the app's next resume, and stays native", async () => {
    const bridge = fakeNative({ opens: ["inactive"] });
    const web = fakeWebAudio();
    const audio = callAudio();
    let opened = false;
    const opening = audio.open().then(() => (opened = true));
    await vi.waitFor(() => expect(bridge.callAudioOpen).toHaveBeenCalledTimes(1));
    await settle();
    expect(opened).toBe(false);
    bridge.appResume();
    await opening;
    expect(bridge.callAudioOpen).toHaveBeenCalledTimes(2);
    expect(audio.path).toBe("native");
    expect(audio.source?.session).toBe("s1");
    expect(web.getUserMedia).not.toHaveBeenCalled();
    audio.close();
  });

  it("inactive with no resume to follow (an alarm during the open): tries again after 3 s anyway", async () => {
    const bridge = fakeNative({ opens: ["inactive"] });
    const web = fakeWebAudio();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const audio = callAudio();
      let opened = false;
      const opening = audio.open().then(() => (opened = true));
      await vi.waitFor(() => expect(bridge.callAudioOpen).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(2_900);
      expect(bridge.callAudioOpen).toHaveBeenCalledTimes(1);
      expect(opened).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      await opening;
      expect(bridge.callAudioOpen).toHaveBeenCalledTimes(2);
      expect(audio.path).toBe("native");
      expect(web.getUserMedia).not.toHaveBeenCalled();
      // the resume that never came does not open a third time
      bridge.appResume();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(bridge.callAudioOpen).toHaveBeenCalledTimes(2);
      audio.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("inactive, then the resume comes first: the 3 s timer does not open again", async () => {
    const bridge = fakeNative({ opens: ["inactive"] });
    fakeWebAudio();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const audio = callAudio();
      const opening = audio.open();
      await vi.waitFor(() => expect(bridge.callAudioOpen).toHaveBeenCalledTimes(1));
      bridge.appResume();
      await opening;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(bridge.callAudioOpen).toHaveBeenCalledTimes(2);
      audio.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("inactive twice: the web path", async () => {
    const bridge = fakeNative({ opens: ["inactive", "inactive"] });
    const web = fakeWebAudio();
    const audio = callAudio();
    const opening = audio.open();
    await vi.waitFor(() => expect(bridge.callAudioOpen).toHaveBeenCalledTimes(1));
    bridge.appResume();
    await opening;
    expect(audio.path).toBe("web");
    expect(web.getUserMedia).toHaveBeenCalledTimes(1);
    audio.close();
  });

  it("unavailable: the web path at once, and it is logged", async () => {
    const bridge = fakeNative({ opens: ["unavailable"] });
    const web = fakeWebAudio();
    const audio = callAudio();
    await audio.open();
    expect(bridge.callAudioOpen).toHaveBeenCalledTimes(1);
    expect(audio.path).toBe("web");
    expect(audio.source).toBeNull();
    expect(audio.player()).toBeNull();
    expect(web.getUserMedia).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith("[call-diag] audio web, native unavailable");
    audio.close();
  });

  it("denied: rejects as denied and stays native, so Try again asks native again", async () => {
    const bridge = fakeNative({ opens: ["denied"] });
    const web = fakeWebAudio();
    const audio = callAudio();
    await expect(audio.open()).rejects.toMatchObject({ code: "denied" });
    expect(audio.path).toBe("native");
    expect(web.getUserMedia).not.toHaveBeenCalled();
    await audio.open();
    expect(bridge.callAudioOpen).toHaveBeenCalledTimes(2);
    expect(audio.source?.session).toBe("s1");
    audio.close();
  });

  it("a call closed while it waits for the app to come back never opens", async () => {
    const bridge = fakeNative({ opens: ["inactive"] });
    fakeWebAudio();
    const audio = callAudio();
    const opening = audio.open();
    await vi.waitFor(() => expect(bridge.callAudioOpen).toHaveBeenCalledTimes(1));
    audio.close();
    await expect(opening).rejects.toMatchObject({ code: "closed" });
    bridge.appResume();
    await settle();
    expect(bridge.callAudioOpen).toHaveBeenCalledTimes(1);
  });
});

describe("a hang-up during an open that answers inactive", () => {
  it("never waits and never opens again", async () => {
    const bridge = fakeNative();
    let answerInactive!: () => void;
    bridge.callAudioOpen.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          answerInactive = () => reject(Object.assign(new Error("inactive"), { code: "inactive" }));
        }),
    );
    const web = fakeWebAudio();
    const audio = callAudio();
    const opening = audio.open();
    await vi.waitFor(() => expect(bridge.callAudioOpen).toHaveBeenCalledTimes(1));
    audio.close();
    answerInactive();
    await expect(opening).rejects.toMatchObject({ code: "closed" });
    bridge.appResume();
    await settle();
    expect(bridge.callAudioOpen).toHaveBeenCalledTimes(1);
    expect(web.getUserMedia).not.toHaveBeenCalled();
  });
});

describe("a hang-up while the call is still opening", () => {
  it("closed while hello is pending: no callAudioOpen and no getUserMedia, ever", async () => {
    const bridge = fakeNative();
    let answer!: (value: { version: number; methods: string[] }) => void;
    bridge.hello.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const web = fakeWebAudio();
    const audio = callAudio();
    const opening = audio.open();
    await vi.waitFor(() => expect(bridge.hello).toHaveBeenCalled());
    audio.close();
    answer({ version: 1, methods: ALL });
    await expect(opening).rejects.toMatchObject({ code: "closed" });
    await settle();
    expect(bridge.callAudioOpen).not.toHaveBeenCalled();
    expect(web.getUserMedia).not.toHaveBeenCalled();
  });

  it("closed while hello is pending on a phone without the methods: no getUserMedia", async () => {
    const bridge = fakeNative({ methods: [] });
    let answer!: (value: { version: number; methods: string[] }) => void;
    bridge.hello.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const web = fakeWebAudio();
    const audio = callAudio();
    const opening = audio.open();
    await vi.waitFor(() => expect(bridge.hello).toHaveBeenCalled());
    audio.close();
    answer({ version: 1, methods: [] });
    await expect(opening).rejects.toMatchObject({ code: "closed" });
    expect(web.getUserMedia).not.toHaveBeenCalled();
  });

  it("closed while callAudioOpen is in flight, then unavailable: no web fallback opens", async () => {
    const bridge = fakeNative();
    let refuse!: () => void;
    bridge.callAudioOpen.mockImplementation(
      () => new Promise((_, reject) => (refuse = () => reject(Object.assign(new Error("unavailable"), { code: "unavailable" })))),
    );
    const web = fakeWebAudio();
    const audio = callAudio();
    const opening = audio.open();
    await vi.waitFor(() => expect(bridge.callAudioOpen).toHaveBeenCalled());
    audio.close();
    refuse();
    await expect(opening).rejects.toMatchObject({ code: "closed" });
    expect(web.getUserMedia).not.toHaveBeenCalled();
  });

  it("closed while getUserMedia is in flight: the capture it opens is closed again", async () => {
    fakeNative({ methods: [] });
    const web = fakeWebAudio();
    const stop = vi.fn();
    let grant!: () => void;
    web.getUserMedia.mockImplementation(() => new Promise((resolve) => (grant = () => resolve({ getTracks: () => [{ stop }] }))));
    const audio = callAudio();
    const opening = audio.open();
    await vi.waitFor(() => expect(web.getUserMedia).toHaveBeenCalled());
    audio.close();
    grant();
    await expect(opening).rejects.toMatchObject({ code: "closed" });
    expect(stop).toHaveBeenCalled();
  });

  it("a close and a new open (React's StrictMode probe): the first open is cancelled, the second opens once", async () => {
    const bridge = fakeNative();
    const audio = callAudio();
    const first = audio.open();
    audio.close();
    const second = audio.open();
    await expect(first).rejects.toMatchObject({ code: "closed" });
    await second;
    expect(bridge.callAudioOpen).toHaveBeenCalledTimes(1);
    expect(audio.source?.session).toBe("s1");
    audio.close();
  });
});

describe("the owner's mute survives a microphone the call did not have yet (callbar-rereview3.md A1)", () => {
  it("a mute set while the native engine is still opening reaches the session once it does", async () => {
    const bridge = fakeNative();
    fakeWebAudio();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ text: "hi" })));
    vi.stubGlobal("fetch", fetchSpy);
    let finishOpen!: () => void;
    bridge.callAudioOpen.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOpen = () => resolve({ session: "s1", sampleRate: 16_000, frame: FRAME });
        }),
    );
    const audio = callAudio();
    const opening = audio.open();
    // choose() has already swapped in the native microphone; its session is
    // still opening, same as a native call the owner mutes while it connects
    await vi.waitFor(() => expect(audio.path).toBe("native"));
    audio.setMuted(true);
    finishOpen();
    await opening;
    await audio.mic.start({ endpointMs: 300 });
    for (let i = 0; i < 20; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: pcm(20_000) });
    await settle();
    expect(fetchSpy).not.toHaveBeenCalled();
    audio.close();
  });

  it("a mute set before a retry's fresh CallAudio and microphone still applies to it", async () => {
    fakeNative();
    fakeWebAudio();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ text: "hi" })));
    vi.stubGlobal("fetch", fetchSpy);
    const first = callAudio();
    first.setMuted(true);
    first.close();
    // CallView's retryOpen never reuses a CallAudio (N1): a fresh one, same
    // as a retry after the first attempt's note and "Try again".
    const bridge = fakeNative();
    const retry = callAudio();
    retry.setMuted(true);
    await retry.open();
    await retry.mic.start({ endpointMs: 300 });
    for (let i = 0; i < 20; i += 1) bridge.emit({ type: "mic", session: "s1", pcm: pcm(20_000) });
    await settle();
    expect(fetchSpy).not.toHaveBeenCalled();
    retry.close();
  });
});

describe("Resume call after lost (spec §4.3.1, §4.3.5)", () => {
  it("opens a new session, keeps the microphone's listeners, and hands out a player for it", async () => {
    const bridge = fakeNative();
    const audio = callAudio();
    await audio.open();
    const voices: boolean[] = [];
    audio.mic.onVoice((speaking) => voices.push(speaking));
    const first = audio.player()!;
    bridge.emit({ type: "lost", session: "s1", reason: "restart-failed" });

    await audio.reopen();
    expect(bridge.log.filter((l) => l === "open" || l.startsWith("close"))).toEqual(["open", "close s1", "open"]);
    expect(audio.source?.session).toBe("s2");
    // the same listeners hear the new session's microphone
    for (let i = 0; i < 8; i += 1) bridge.emit({ type: "mic", session: "s2", pcm: pcm(9_830) });
    await settle();
    expect(voices).toEqual([true]);
    const second = audio.player()!;
    expect(second).not.toBe(first);
    audio.pulse(true);
    await settle();
    expect(bridge.log).toContain("control s2 pulseOn");
    audio.close();
  });

  it("pauses page media again before the new open", async () => {
    const bridge = fakeNative();
    const pause = vi.fn(() => bridge.log.push("pause media"));
    vi.stubGlobal("document", { querySelectorAll: () => [{ paused: false, pause }] });
    const audio = callAudio();
    await audio.open();
    await audio.reopen();
    expect(bridge.log.filter((l) => l === "open" || l === "pause media")).toEqual(["pause media", "open", "pause media", "open"]);
    audio.close();
  });

  it("a failed reopen rejects, for the note", async () => {
    fakeNative({ opens: [null, "unavailable"] });
    const audio = callAudio();
    await audio.open();
    await expect(audio.reopen()).rejects.toMatchObject({ code: "unavailable" });
    expect(audio.path).toBe("native");
    audio.close();
  });
});

describe("the working pulse on the native path", () => {
  it("sends each change once, and none without a session", async () => {
    const bridge = fakeNative();
    const audio = callAudio();
    audio.pulse(true);
    await audio.open();
    audio.pulse(true);
    audio.pulse(true);
    audio.pulse(false);
    audio.pulse(false);
    await settle();
    expect(bridge.log.filter((l) => l.startsWith("control"))).toEqual(["control s1 pulseOn", "control s1 pulseOff"]);
    audio.close();
  });

  it("does nothing on the web path", async () => {
    const bridge = fakeNative({ methods: [] });
    fakeWebAudio();
    const audio = callAudio();
    await audio.open();
    audio.pulse(true);
    await settle();
    expect(bridge.log).toEqual([]);
    audio.close();
  });

  it("closing the call closes the session", async () => {
    const bridge = fakeNative();
    const audio = callAudio();
    await audio.open();
    audio.close();
    await vi.waitFor(() => expect(bridge.log).toContain("close s1"));
  });
});

// I2 (c): a hold nothing on the phone ends (a call declined from the banner
// with no `.ended`) must not leave the owner with only Hang up.
describe("offerResumeWhenHeld", () => {
  function fakeDocument(visible = true) {
    const listeners = new Set<() => void>();
    return {
      visibilityState: visible ? "visible" : "hidden",
      addEventListener: (_: "visibilitychange", fn: () => void) => void listeners.add(fn),
      removeEventListener: (_: "visibilitychange", fn: () => void) => void listeners.delete(fn),
      set(visible: boolean) {
        this.visibilityState = visible ? "visible" : "hidden";
        for (const fn of listeners) fn();
      },
      listeners,
    };
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("offers Resume call after about 5 s held on screen", () => {
    expect(HELD_RESUME_OFFER_MS).toBe(5_000);
    const doc = fakeDocument();
    const offer = vi.fn();
    offerResumeWhenHeld(offer, doc);
    vi.advanceTimersByTime(HELD_RESUME_OFFER_MS - 1);
    expect(offer).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(offer).toHaveBeenCalledWith(true);
  });

  it("counts only time on screen, and withdraws the offer when hidden", () => {
    const doc = fakeDocument(false);
    const offer = vi.fn();
    offerResumeWhenHeld(offer, doc);
    vi.advanceTimersByTime(60_000); // a lock: the app's return restarts the engine itself
    expect(offer).not.toHaveBeenCalledWith(true);
    doc.set(true);
    vi.advanceTimersByTime(3_000);
    doc.set(false);
    expect(offer).toHaveBeenLastCalledWith(false);
    doc.set(true);
    vi.advanceTimersByTime(3_000);
    expect(offer).not.toHaveBeenCalledWith(true); // started over on return
    vi.advanceTimersByTime(2_000);
    expect(offer).toHaveBeenLastCalledWith(true);
  });

  it("stops cleanly when the hold ends", () => {
    const doc = fakeDocument();
    const offer = vi.fn();
    const stop = offerResumeWhenHeld(offer, doc);
    vi.advanceTimersByTime(1_000);
    stop();
    vi.advanceTimersByTime(HELD_RESUME_OFFER_MS);
    doc.set(false);
    doc.set(true);
    vi.advanceTimersByTime(HELD_RESUME_OFFER_MS);
    expect(offer).not.toHaveBeenCalled();
    expect(doc.listeners.size).toBe(0);
  });

  it("still offers it with no document to watch", () => {
    const offer = vi.fn();
    offerResumeWhenHeld(offer, null);
    vi.advanceTimersByTime(HELD_RESUME_OFFER_MS);
    expect(offer).toHaveBeenCalledWith(true);
  });
});


// callbar-rereview.md N1 (Critical): "Try again" while the first open is
// still pending. Round 1's retryOpen closed the pending CallAudio and then
// reopened that SAME instance — but `mic`/`source` are instance state, so
// the stale attempt's own late cleanup (`closes !== this.closes` in
// open()) ran against whatever the retry had since put there. These tests
// drive the real CallAudio/call-mic the way the reviewer's own repro did,
// with `settle()` between each step so the module-wide native turn
// (call-mic.ts's `nativeTurn`) and each promise's continuations land in a
// fixed, inspectable order.
describe("N1: a retry must only ever touch the resources it created", () => {
  it("(what round 1 did) closing and reopening the SAME CallAudio while the first open is pending silently closes the session it was just given", async () => {
    const bridge = fakeNative();
    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let opens = 0;
    bridge.callAudioOpen.mockImplementation(async () => {
      opens += 1;
      const mine = opens;
      if (mine === 1) await firstGate; // the first open is "slow"
      return { session: `s${mine}`, sampleRate: 16_000, frame: FRAME };
    });
    const audio = callAudio();
    const firstOpen = audio.open().catch(() => undefined);
    await settle();
    // Round 1's retryOpen: close(), then open() the SAME instance again.
    audio.close();
    await settle();
    const secondOpen = audio.open().catch(() => undefined);
    await settle();
    // The stale first open's native reply finally lands, well after the
    // "retry" (still the same instance) has already re-opened.
    releaseFirst!();
    await Promise.all([firstOpen, secondOpen]);
    // Broken: the second open() reports success (it never rejects — its
    // own `closes` matched), but the first open's late cleanup has since
    // closed the session out from under it. A silently dead call: the
    // screen would read "Listening" with nothing open.
    expect(audio.source?.session).toBeNull();
  });

  it("(the fix) closing the stale CallAudio and building a fresh one keeps the fresh session, even after the stale attempt settles late", async () => {
    const bridge = fakeNative();
    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let opens = 0;
    bridge.callAudioOpen.mockImplementation(async () => {
      opens += 1;
      const mine = opens;
      if (mine === 1) await firstGate; // the first open is "slow"
      return { session: `s${mine}`, sampleRate: 16_000, frame: FRAME };
    });
    const stale = callAudio();
    const staleOpen = stale.open().catch(() => undefined);
    await settle();

    // CallView.tsx's retryOpen now does this: close the stale attempt,
    // then build a brand new CallAudio for the retry (never the same
    // instance — see `buildAudio` there).
    stale.close();
    await settle();
    const fresh = callAudio();
    const freshOpen = fresh.open();
    await settle();

    // The stale attempt's native reply finally lands. Native serializes
    // every open/close through one turn (call-mic.ts's `nativeTurn`), so
    // the fresh attempt's own open only reaches the bridge after the
    // stale one's turn — sitting on `firstGate` — finishes.
    releaseFirst!();
    await freshOpen;
    await staleOpen;

    // The fresh attempt has its own, untouched session; the stale one
    // closed only itself.
    expect(fresh.source?.session).toBe("s2");
    expect(stale.source?.session).toBeNull();
    fresh.close();
  });

  it("web path: the stale attempt's own getUserMedia stream is stopped when it settles, and the fresh attempt's stream is never touched by it", async () => {
    fakeNative({ methods: [] }); // force the web path
    const web = fakeWebAudio();
    let releaseStale: (() => void) | null = null;
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    // Keyed by which attempt asked, not by resolution order: the fresh
    // attempt's prompt (unlgated) resolves BEFORE the stale one's (held on
    // staleGate), so array push order does not match "stale"/"fresh".
    const tracks: { stale?: { stop: ReturnType<typeof vi.fn> }; fresh?: { stop: ReturnType<typeof vi.fn> } } = {};
    let calls = 0;
    web.getUserMedia.mockImplementation(async () => {
      calls += 1;
      const label = calls === 1 ? "stale" : "fresh";
      if (label === "stale") await staleGate; // the first prompt sits unanswered
      const track = { stop: vi.fn() };
      tracks[label] = track;
      return { getTracks: () => [track] };
    });

    const stale = callAudio();
    const staleOpen = stale.open().catch(() => undefined);
    await settle();

    // The owner taps Try again before the first prompt is answered.
    stale.close();
    await settle();
    const fresh = callAudio();
    await fresh.open(); // getUserMedia calls are independent: this resolves at once
    expect(tracks.fresh?.stop).not.toHaveBeenCalled();
    expect(tracks.stale).toBeUndefined(); // the stale prompt has not answered yet

    // The stale prompt is finally answered, long after the retry opened.
    releaseStale!();
    await staleOpen;

    // The stale attempt's own stream is stopped once it settles — never
    // left capturing after the call has already moved on.
    expect(tracks.stale?.stop).toHaveBeenCalledTimes(1);
    // The fresh (now live) attempt's stream is untouched by that.
    expect(tracks.fresh?.stop).not.toHaveBeenCalled();

    fresh.close();
    expect(tracks.fresh?.stop).toHaveBeenCalledTimes(1);
  });
});

describe("streaming end of turn", () => {
  it("builds a streaming mic on the native path when the harness offers streaming", async () => {
    fakeNative();
    fakeWebAudio();
    const audio = new CallAudio({ kindFor: () => "stream", web: createCallMic("flux") });
    await audio.chosen();
    expect(audio.path).toBe("native");
    expect(audio.mic.transport?.()).toBe("stream");
    expect(audio.mic.kind).toBe("flux");
    audio.close();
  });

  it("loads the call modules in the app's order without an import cycle", async () => {
    // the app enters through call-mic (CallView, call-audio): StreamMic must still evaluate
    const mic = await import("./call-mic");
    const { StreamMic } = await import("./stream-mic");
    const { micFor } = await import("./call-audio");
    expect(new StreamMic()).toBeInstanceOf(mic.FluxMic);
    expect(micFor("stream").kind).toBe("flux");
  });
});
