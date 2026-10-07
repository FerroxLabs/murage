import { afterEach, describe, expect, it, vi } from "vitest";

import { BotVoiceLevel, defaultAudioContext, LevelSmoother, levelFromRms, OwnerVoiceLevel, OWNER_PULSE_MS, rmsOf, tapRoute, type AuraAudioContext } from "./audio-level";

describe("defaultAudioContext", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates no AudioContext where elements cannot be captured (iPhone/WebKit)", () => {
    const ctor = vi.fn();
    vi.stubGlobal("AudioContext", ctor);
    vi.stubGlobal("HTMLMediaElement", { prototype: {} });
    expect(defaultAudioContext()).toBeNull();
    expect(ctor).not.toHaveBeenCalled();
  });

  it("creates one where captureStream exists", () => {
    const ctor = vi.fn();
    vi.stubGlobal("AudioContext", ctor);
    vi.stubGlobal("HTMLMediaElement", { prototype: { captureStream: () => ({}) } });
    expect(defaultAudioContext()).not.toBeNull();
    expect(ctor).toHaveBeenCalledTimes(1);
  });
});

describe("level smoothing", () => {
  it("attacks fast and releases slowly, whatever the frame rate", () => {
    const s = new LevelSmoother(40, 260);
    expect(s.push(1, 40)).toBeCloseTo(0.632, 2);
    expect(s.push(1, 40)).toBeGreaterThan(0.85);
    const peak = s.current;
    expect(s.push(0, 40)).toBeGreaterThan(peak * 0.8);
    // the same wall time in one step or ten lands in the same place
    const one = new LevelSmoother(40, 260);
    one.push(1, 400);
    const ten = new LevelSmoother(40, 260);
    for (let i = 0; i < 10; i += 1) ten.push(1, 40);
    expect(Math.abs(one.current - ten.current)).toBeLessThan(0.02);
  });

  it("clamps to 0..1 and settles to exactly zero", () => {
    const s = new LevelSmoother(40, 100);
    expect(s.push(5, 1000)).toBeLessThanOrEqual(1);
    for (let i = 0; i < 100; i += 1) s.push(-1, 100);
    expect(s.current).toBe(0);
  });

  it("turns sample RMS into a level where ordinary speech sits near 0.8", () => {
    expect(rmsOf([0.5, -0.5, 0.5, -0.5])).toBe(0.5);
    expect(rmsOf([])).toBe(0);
    expect(levelFromRms(0.2)).toBeCloseTo(0.8);
    expect(levelFromRms(1)).toBe(1);
  });
});

/** A fake context that records every node made and every connection, and
 *  refuses to reroute an element: the whole point of the tap is that the
 *  bot's playback never passes through the AudioContext. */
function fakeContext(state: string = "running", { sample = 0.2 } = {}) {
  const calls: string[] = [];
  const connections: string[] = [];
  const context = {
    state,
    destination: { id: "destination" },
    resume: vi.fn(async () => {
      calls.push("resume");
    }),
    close: vi.fn(async () => {
      calls.push("close");
      context.state = "closed";
    }),
    createMediaElementSource: vi.fn(() => {
      throw new Error("createMediaElementSource reroutes playback and must never be called");
    }),
    createMediaStreamSource: vi.fn(() => {
      calls.push("source");
      return {
        connect: vi.fn((node: { id?: string }) => connections.push(`source->${node.id ?? "?"}`)),
        disconnect: vi.fn(() => calls.push("source.disconnect")),
      };
    }),
    createAnalyser: vi.fn(() => {
      calls.push("analyser");
      return {
        id: "analyser",
        fftSize: 0,
        smoothingTimeConstant: 0,
        connect: vi.fn((node: { id?: string }) => connections.push(`analyser->${node.id ?? "?"}`)),
        disconnect: vi.fn(() => calls.push("analyser.disconnect")),
        getFloatTimeDomainData: (array: Float32Array) => array.fill(sample),
      };
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return { context: context as unknown as AuraAudioContext & { state: string; createMediaElementSource: ReturnType<typeof vi.fn> }, calls, connections };
}

function fakeClips() {
  const watchers = new Set<(audio: HTMLMediaElement) => void>();
  return {
    subscribe: (fn: (audio: HTMLMediaElement) => void) => {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    announce: (audio: HTMLMediaElement) => {
      for (const fn of watchers) fn(audio);
    },
    get count() {
      return watchers.size;
    },
  };
}

/** A fake <audio>: Chromium-shaped (captureStream) unless told otherwise.
 *  Every property write and every method call on it is recorded, so a test
 *  can prove the tap never touched the element. */
function fakeAudio(over: Record<string, unknown> = {}, { capture = true, tracks = 1 } = {}) {
  const touched: string[] = [];
  const listeners = new Map<string, () => void>();
  const trackList = Array.from({ length: tracks }, () => ({ stop: vi.fn() }));
  const stream = {
    getAudioTracks: () => trackList,
    addEventListener: vi.fn((type: string, fn: () => void) => listeners.set(type, fn)),
    removeEventListener: vi.fn(),
  };
  const base: Record<string, unknown> = {
    paused: false,
    ended: false,
    currentTime: 0,
    duration: 2,
    src: "blob:a",
    getAttribute: (name: string) => (name === "src" ? "blob:a" : null),
    pause: () => touched.push("pause()"),
    play: () => touched.push("play()"),
    ...over,
  };
  if (capture) base.captureStream = vi.fn(() => stream);
  const audio = new Proxy(base, {
    set(target, key, value) {
      touched.push(`set ${String(key)}`);
      target[String(key)] = value;
      return true;
    },
  });
  const addTrack = () => {
    trackList.push({ stop: vi.fn() });
    listeners.get("addtrack")?.();
  };
  return { audio: audio as unknown as HTMLMediaElement, touched, stream, addTrack };
}

describe("the route the tap takes", () => {
  it("captures the element's stream on Chromium and leaves WebKit alone", () => {
    expect(tapRoute({ captureStream: () => ({}) } as unknown as HTMLMediaElement)).toBe("stream");
    expect(tapRoute({} as HTMLMediaElement)).toBe("none");
  });
});

describe("the bot's voice tap", () => {
  it("taps each clip through captureStream and an analyser, never through the element and never into the destination", () => {
    const { context, calls, connections } = fakeContext();
    const clips = fakeClips();
    const voice = new BotVoiceLevel(() => context, clips.subscribe);
    expect(voice.level()).toBe(0);
    expect(voice.hearing()).toBe(false);
    const detach = voice.attach();
    expect(clips.count).toBe(1);
    const { audio, touched, stream } = fakeAudio();
    clips.announce(audio);
    expect(context.createMediaElementSource).not.toHaveBeenCalled();
    expect(context.createMediaStreamSource).toHaveBeenCalledWith(stream);
    expect(calls).toEqual(["resume", "source", "analyser"]);
    // the analyser is a dead end: the element keeps its own output
    expect(connections).toEqual(["source->analyser"]);
    expect(touched).toEqual([]);
    expect(voice.tappedElement).toBe(audio);
    expect(voice.level()).toBeCloseTo(0.8);
    expect(voice.hearing()).toBe(true);
    // the next clip replaces the first tap's nodes
    clips.announce(fakeAudio({ src: "blob:b" }).audio);
    expect(calls.slice(3)).toEqual(["source.disconnect", "analyser.disconnect", "source", "analyser"]);
    detach();
  });

  it("the context suspends after tapping: the element is untouched, so playback stays audible", () => {
    const { context, connections } = fakeContext();
    const clips = fakeClips();
    const voice = new BotVoiceLevel(() => context, clips.subscribe);
    const detach = voice.attach();
    const { audio, touched } = fakeAudio();
    clips.announce(audio);
    context.state = "suspended";
    voice.level();
    voice.progress(10);
    expect(touched).toEqual([]);
    expect(connections.some((c) => c.endsWith("destination"))).toBe(false);
    // still a tapped clip: the aura goes quiet rather than inventing speech
    expect(voice.hearing()).toBe(true);
    detach();
    expect(touched).toEqual([]);
  });

  it("taps even while the context is suspended at the time, since the stream route cannot silence anything", () => {
    const { context } = fakeContext("suspended");
    const clips = fakeClips();
    const voice = new BotVoiceLevel(() => context, clips.subscribe);
    const detach = voice.attach();
    const { audio, touched } = fakeAudio();
    clips.announce(audio);
    expect(context.createMediaStreamSource).toHaveBeenCalledTimes(1);
    expect(context.resume).toHaveBeenCalled();
    expect(touched).toEqual([]);
    detach();
  });

  it("WebKit, or any element without captureStream: no tap at all, and the synthetic cadence stands in", () => {
    const { context } = fakeContext();
    const clips = fakeClips();
    const voice = new BotVoiceLevel(() => context, clips.subscribe);
    const detach = voice.attach();
    const { audio, touched } = fakeAudio({ currentTime: 1, duration: 4 }, { capture: false });
    clips.announce(audio);
    expect(context.createMediaStreamSource).not.toHaveBeenCalled();
    expect(context.createMediaElementSource).not.toHaveBeenCalled();
    expect(voice.tappedElement).toBeNull();
    expect(voice.level()).toBe(0);
    expect(voice.hearing()).toBe(false);
    // the read-along still reads the clip's clock
    expect(voice.progress(100)).toBe(0.25);
    expect(touched).toEqual([]);
    detach();
  });

  it("waits for the captured stream's audio track when it arrives late", () => {
    const { context, calls } = fakeContext();
    const clips = fakeClips();
    const voice = new BotVoiceLevel(() => context, clips.subscribe);
    const detach = voice.attach();
    const { audio, addTrack, stream } = fakeAudio({}, { tracks: 0 });
    clips.announce(audio);
    expect(context.createMediaStreamSource).not.toHaveBeenCalled();
    expect(stream.addEventListener).toHaveBeenCalledWith("addtrack", expect.any(Function));
    // the tap is committed: this clip is heard, not invented
    expect(voice.hearing()).toBe(true);
    expect(voice.level()).toBe(0);
    addTrack();
    expect(calls.slice(-2)).toEqual(["source", "analyser"]);
    expect(voice.level()).toBeCloseTo(0.8);
    detach();
  });

  it("hearing is the tap, not a loud sample: the bot's own pauses are silence, never synthetic speech", () => {
    const { context } = fakeContext("running", { sample: 0 });
    const clips = fakeClips();
    const voice = new BotVoiceLevel(() => context, clips.subscribe);
    const detach = voice.attach();
    const { audio } = fakeAudio();
    clips.announce(audio);
    // a gap between sentences: zero samples, still heard
    expect(voice.level()).toBe(0);
    expect(voice.hearing()).toBe(true);
    // the clip finished and the next is still rendering: quiet, still heard
    (audio as unknown as { ended: boolean }).ended = true;
    expect(voice.level()).toBe(0);
    expect(voice.hearing()).toBe(true);
    detach();
    expect(voice.hearing()).toBe(false);
  });

  it("hang-up mid-clip disconnects every node, closes the context and never touches the element", () => {
    const { context, calls } = fakeContext();
    const clips = fakeClips();
    const voice = new BotVoiceLevel(() => context, clips.subscribe);
    const detach = voice.attach();
    const { audio, touched } = fakeAudio();
    clips.announce(audio);
    detach();
    expect(calls.slice(-3)).toEqual(["source.disconnect", "analyser.disconnect", "close"]);
    expect(touched).toEqual([]);
    expect(context.removeEventListener).toHaveBeenCalled();
    expect(clips.count).toBe(0);
    expect(voice.attached).toBe(false);
    expect(voice.tappedElement).toBeNull();
    expect(voice.level()).toBe(0);
    expect(voice.progress(10)).toBeNull();
    // a clip after the hang-up is nobody's business
    clips.announce(fakeAudio({ src: "blob:late" }).audio);
    expect(context.createMediaStreamSource).toHaveBeenCalledTimes(1);
    // detaching twice is harmless
    detach();
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("shares one context between the call screens on it and closes it with the last", () => {
    const { context } = fakeContext();
    const clips = fakeClips();
    const factory = vi.fn(() => context);
    const voice = new BotVoiceLevel(factory, clips.subscribe);
    const a = voice.attach();
    const b = voice.attach();
    expect(factory).toHaveBeenCalledTimes(1);
    a();
    expect(context.close).not.toHaveBeenCalled();
    b();
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("survives a window with no AudioContext at all", () => {
    const clips = fakeClips();
    const voice = new BotVoiceLevel(() => null, clips.subscribe);
    const detach = voice.attach();
    expect(clips.count).toBe(0);
    expect(voice.level()).toBe(0);
    expect(voice.hearing()).toBe(false);
    detach();
  });

  it("reads the clip's progress for the read-along, and reports nothing for a clip the player has torn down", () => {
    const { context } = fakeContext();
    const clips = fakeClips();
    const voice = new BotVoiceLevel(() => context, clips.subscribe);
    const detach = voice.attach();
    clips.announce(fakeAudio({ currentTime: 1, duration: 4, buffered: { length: 0 } as TimeRanges }).audio);
    expect(voice.progress(100)).toBe(0.25);
    // torn down by the player (src = ""): the src property then reflects the
    // document URL, only the attribute says the clip is gone
    clips.announce(
      fakeAudio({ paused: true, currentTime: 1, duration: 4, src: "http://localhost/", getAttribute: () => "" }).audio,
    );
    expect(voice.progress(100)).toBeNull();
    detach();
  });
});

describe("the owner's voice", () => {
  it("follows the microphone's frames and forgets a stale one", () => {
    let now = 1000;
    const owner = new OwnerVoiceLevel(() => now);
    owner.push(0.2);
    now += 16;
    expect(owner.level()).toBeGreaterThan(0.1);
    for (let i = 0; i < 20; i += 1) {
      now += 16;
      owner.push(0.2);
      owner.level();
    }
    expect(owner.level()).toBeGreaterThan(0.7);
    // no frame for a quarter second: the voice has stopped and the level drains
    now += 300;
    const after = owner.level();
    now += 2000;
    expect(owner.level()).toBeLessThan(after);
  });

  it("pulses on a partial transcript, holds it long enough for dictation's gaps, and keeps the recent pulses for the ripples", () => {
    let now = 1000;
    const owner = new OwnerVoiceLevel(() => now);
    owner.pulse();
    for (let i = 0; i < 4; i += 1) {
      now += 16;
      owner.level();
    }
    expect(owner.level()).toBeGreaterThan(0.3);
    expect(owner.recentPulses(300)).toEqual([1000]);
    // dictation reports a partial every few hundred ms: the pulse must
    // outlast that gap so the wash holds up through a sentence
    expect(OWNER_PULSE_MS).toBeGreaterThanOrEqual(450);
    now = 1000 + OWNER_PULSE_MS - 10;
    const held = owner.level();
    now += 16;
    expect(owner.level()).toBeGreaterThanOrEqual(held * 0.98);
    now += 400;
    expect(owner.recentPulses(300)).toEqual([]);
    owner.reset();
    expect(owner.level()).toBe(0);
  });
});
