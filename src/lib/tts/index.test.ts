import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CallAudioEvent, NativeMethod } from "@/lib/native-shell";
import { Incoming, Speaker, type Audible, type ClipOutcome, type ClipPlayer } from "./index";
import { NativeClipPlayer } from "./native-player";

class FakeAudio {
  static latest: FakeAudio | null = null;

  src: string;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onplaying: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onpause: (() => void) | null = null;
  pause = vi.fn();
  play = vi.fn(async () => {});

  constructor(src: string) {
    this.src = src;
    FakeAudio.latest = this;
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A `/api/tts/speak` response whose body resolves in a plain microtask,
 *  not through Node's real Response/undici body-reading machinery — which
 *  schedules itself with real timers that fake timers cannot see through.
 *  Only the fake-timer tests below need this; the rest use a real Response
 *  under real timers, as the tests above already did. */
function fakeSpeakResponse(): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "audio/mpeg" },
    body: null,
    blob: async () => new Blob(["mp3"]),
    json: async () => ({}),
  } as unknown as Response;
}

describe("Speaker lifecycle", () => {
  beforeEach(() => {
    FakeAudio.latest = null;
    vi.restoreAllMocks();
    vi.stubGlobal("Audio", FakeAudio);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice-test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  it("settles an in-progress speak when stop interrupts audio", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/prepare")
          ? json({ ready: true, utterances: ["Hello there."] })
          : new Response(new Blob(["mp3"]), { status: 200 }),
      ),
    );
    const speaker = new Speaker();
    const speaking = speaker.speak("Hello there.");
    await vi.waitFor(() => expect(FakeAudio.latest).not.toBeNull());

    speaker.stop();

    await expect(speaking).resolves.toBeUndefined();
    expect(FakeAudio.latest!.pause).toHaveBeenCalled();
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("aborts preparation when stopped instead of leaving a request alive", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }),
    );
    const speaker = new Speaker();
    const speaking = speaker.speak("A long response");

    speaker.stop();

    await expect(speaking).resolves.toBeUndefined();
    expect(signal?.aborted).toBe(true);
    expect(speaker.state).toEqual({ status: "idle" });
  });

  /** A fetch that answers the first clip, then leaves later renders hanging
   *  until aborted; records each render's signal. */
  function hangingAfterFirst(utterances: string[]) {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/prepare")) return Promise.resolve(json({ ready: true, utterances }));
        signals.push(init!.signal!);
        if (signals.length === 1) return Promise.resolve(new Response(new Blob(["mp3"]), { status: 200 }));
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }),
    );
    return signals;
  }

  it("a clip that fails leaves no prefetched render downloading (A7)", async () => {
    const signals = hangingAfterFirst(["One.", "Two."]);
    const speaker = new Speaker();
    const speaking = speaker.speak("One. Two.");
    await vi.waitFor(() => expect(FakeAudio.latest).not.toBeNull());
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    FakeAudio.latest!.onerror?.();
    await speaking;
    expect(signals[1].aborted).toBe(true);
  });

  it("a streamed clip that fails leaves no prefetched render downloading (A7)", async () => {
    const signals = hangingAfterFirst([]);
    const speaker = new Speaker();
    const told = speaker.stream();
    told.push("One.");
    told.push("Two.");
    await vi.waitFor(() => expect(FakeAudio.latest).not.toBeNull());
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    FakeAudio.latest!.onerror?.();
    expect(await told.done).toBe(false);
    expect(signals[1].aborted).toBe(true);
  });

  describe("a clip the voice service fails is skipped, not the whole reply", () => {
    afterEach(() => vi.useRealTimers());
    const failing = (utterances: string[], bad: (n: number) => boolean) => {
      let n = 0;
      const spoken: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          if (String(input).endsWith("/prepare")) return json({ ready: true, utterances });
          n += 1;
          spoken.push(JSON.parse(String(init?.body)).text);
          return bad(n)
            ? new Response(JSON.stringify({ error: "Speaking failed (502)" }), { status: 502, headers: { "content-type": "application/json" } })
            : new Response(new Blob(["mp3"]), { status: 200 });
        }),
      );
      return spoken;
    };

    it("speak(): utterance 2 of 3 fails, 1 and 3 still play, and the error shows then clears", async () => {
      const spoken = failing(["One.", "Two.", "Three."], (n) => n === 2);
      const speaker = new Speaker();
      const errors: string[] = [];
      speaker.subscribe((s) => s.error && errors.push(s.error));
      const speaking = speaker.speak("One. Two. Three.");
      await vi.waitFor(() => expect(speaker.state.caption).toBe("One."));
      FakeAudio.latest!.onended?.();
      await vi.waitFor(() => expect(speaker.state.caption).toBe("Three."));
      expect(errors).toEqual(["Speaking failed (502)"]);
      expect(speaker.state.error).toBeUndefined();
      FakeAudio.latest!.onended?.();
      await speaking;
      expect(spoken).toEqual(["One.", "Two.", "Three."]);
      expect(speaker.state).toEqual({ status: "idle" });
    });

    it("stream(): the same, on the 1:1 path", async () => {
      failing([], (n) => n === 2);
      const speaker = new Speaker();
      const errors: string[] = [];
      speaker.subscribe((s) => s.error && errors.push(s.error));
      const stream = speaker.stream();
      stream.push("One.");
      stream.push("Two.");
      stream.push("Three.");
      await vi.waitFor(() => expect(speaker.state.caption).toBe("One."));
      FakeAudio.latest!.onended?.();
      await vi.waitFor(() => expect(speaker.state.caption).toBe("Three."));
      expect(errors).toEqual(["Speaking failed (502)"]);
      expect(speaker.state.error).toBeUndefined();
      stream.end();
      FakeAudio.latest!.onended?.();
      await expect(stream.done).resolves.toBe(true);
      expect(stream.heard()).toEqual(["One.", "Three."]);
    });

    it("a failed last clip shows the error briefly, then clears it", async () => {
      failing(["One.", "Two."], (n) => n === 2);
      const speaker = new Speaker();
      const speaking = speaker.speak("One. Two.");
      await vi.waitFor(() => expect(speaker.state.caption).toBe("One."));
      vi.useFakeTimers();
      FakeAudio.latest!.onended?.();
      await vi.waitFor(() => expect(speaker.state.error).toBe("Speaking failed (502)"));
      await speaking;
      expect(speaker.state.error).toBe("Speaking failed (502)");
      vi.advanceTimersByTime(5000);
      expect(speaker.state).toEqual({ status: "idle" });
    });

    it("two clips failing in a row end the reply", async () => {
      failing(["One.", "Two.", "Three.", "Four."], (n) => n === 2 || n === 3);
      const speaker = new Speaker();
      const speaking = speaker.speak("One. Two. Three. Four.");
      await vi.waitFor(() => expect(speaker.state.caption).toBe("One."));
      FakeAudio.latest!.onended?.();
      await speaking;
      expect(speaker.state.status).toBe("idle");
      expect(speaker.state.error).toBe("Speaking failed (502)");
      expect(FakeAudio.latest!.play).toHaveBeenCalledTimes(1);
    });
  });

  it("passes a per-bot voice through preparation and synthesis", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return String(input).endsWith("/prepare")
          ? json({ ready: true, utterances: ["Distinct voice."] })
          : new Response(new Blob(["mp3"]), { status: 200 });
      }),
    );
    const speaker = new Speaker();
    const speaking = speaker.speak("Distinct voice.", { voiceId: "voice-bot" });
    await vi.waitFor(() => expect(FakeAudio.latest).not.toBeNull());
    FakeAudio.latest!.onended?.();
    await speaking;

    expect(bodies).toEqual([
      { text: "Distinct voice.", voiceId: "voice-bot" },
      { text: "Distinct voice.", voiceId: "voice-bot" },
    ]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:voice-test");
  });

  it("streams pushed sentences in order and reports that all were heard", async () => {
    const spoken: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        spoken.push(JSON.parse(String(init?.body)).text);
        return new Response(new Blob(["mp3"]), { status: 200 });
      }),
    );
    const speaker = new Speaker();
    const stream = speaker.stream({ voiceId: "v" });
    stream.push("Let me look into that.");
    await vi.waitFor(() => expect(speaker.state.caption).toBe("Let me look into that."));
    stream.push("It is running now.");
    FakeAudio.latest!.onended?.();
    await vi.waitFor(() => expect(speaker.state.caption).toBe("It is running now."));
    stream.end();
    FakeAudio.latest!.onended?.();
    await expect(stream.done).resolves.toBe(true);
    expect(spoken).toEqual(["Let me look into that.", "It is running now."]);
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("settles a stream that is waiting for its next sentence when stopped", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["mp3"]), { status: 200 })));
    const speaker = new Speaker();
    const stream = speaker.stream();
    speaker.stop();
    await expect(stream.done).resolves.toBe(false);
    stream.push("too late");
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("an ended stream with nothing pushed finishes at once", async () => {
    const speaker = new Speaker();
    const stream = speaker.stream();
    stream.end();
    await expect(stream.done).resolves.toBe(true);
  });

  // "Never stuck on speaking" (call-fixes-brief.md): a reply clip that
  // fails, never starts, or stalls without an "ended" event used to leave
  // `done` unresolved and the snapshot stuck on "speaking" with no error,
  // so the call never returned to listening.
  describe("recovering from a clip that never finishes", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("settles false and shows the failure line when a played clip errors", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["mp3"]), { status: 200 })));
      const speaker = new Speaker();
      const stream = speaker.stream();
      stream.push("This will not play.");
      await vi.waitFor(() => expect(FakeAudio.latest).not.toBeNull());

      FakeAudio.latest!.onerror?.();

      await expect(stream.done).resolves.toBe(false);
      expect(speaker.state).toEqual({ status: "idle", error: "The generated voice clip couldn't be played." });
    });

    it("gives up after about 8s when the clip never starts playing", async () => {
      vi.useFakeTimers();
      vi.stubGlobal("fetch", vi.fn(async () => fakeSpeakResponse()));
      const speaker = new Speaker();
      const stream = speaker.stream();
      stream.push("Say this.");
      // let the fetch + render microtasks run so play() is reached, without
      // advancing the stall clock itself
      await vi.advanceTimersByTimeAsync(0);
      expect(FakeAudio.latest).not.toBeNull();
      // no "playing", "ended" or "error" ever arrives (the clip is silently
      // stuck): the 8s watchdog is what has to move things along
      await vi.advanceTimersByTimeAsync(8_000);

      await expect(stream.done).resolves.toBe(false);
      expect(speaker.state.error).toBe("The generated voice clip couldn't be played.");
    });

    it("gives up after about 8s when a clip starts but never fires ended", async () => {
      vi.useFakeTimers();
      vi.stubGlobal("fetch", vi.fn(async () => fakeSpeakResponse()));
      const speaker = new Speaker();
      const stream = speaker.stream();
      stream.push("Say this.");
      await vi.advanceTimersByTimeAsync(0);
      expect(FakeAudio.latest).not.toBeNull();

      // playback genuinely starts...
      FakeAudio.latest!.onplaying?.();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(speaker.state.status).toBe("speaking");
      // ...then stalls: no further progress, and "ended" never fires
      await vi.advanceTimersByTimeAsync(8_000);

      await expect(stream.done).resolves.toBe(false);
      expect(speaker.state.error).toBe("The generated voice clip couldn't be played.");
    });

    it("does not cut off a long clip that keeps making progress", async () => {
      vi.useFakeTimers();
      vi.stubGlobal("fetch", vi.fn(async () => fakeSpeakResponse()));
      const speaker = new Speaker();
      const stream = speaker.stream();
      stream.push("A rather long sentence.");
      stream.end();
      await vi.advanceTimersByTimeAsync(0);
      expect(FakeAudio.latest).not.toBeNull();
      const audio = FakeAudio.latest!;
      audio.onplaying?.();
      // progress every 3s, well inside the 8s stall window, for longer than
      // the stall timeout would otherwise allow
      for (let i = 0; i < 4; i += 1) {
        await vi.advanceTimersByTimeAsync(3_000);
        audio.ontimeupdate?.();
      }
      audio.onended?.();

      await expect(stream.done).resolves.toBe(true);
      expect(speaker.state).toEqual({ status: "idle" });
    });
  });
});

/** The native call player on a fake bridge, as CallView wires it from
 *  NativeFrameSource (spec §4.3.4). */
function nativeOutput() {
  const listeners = new Set<(e: CallAudioEvent) => void>();
  const sent: Array<{ method: NativeMethod; args: Record<string, unknown> }> = [];
  const player = new NativeClipPlayer({
    session: "s1",
    onEvent: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    call: async (method: NativeMethod, ...args: unknown[]) => {
      sent.push({ method, args: args[0] as Record<string, unknown> });
      return true;
    },
  });
  const plays = () => sent.filter((s) => s.method === "callAudioPlay").map((s) => s.args);
  const controls = () => sent.filter((s) => s.method === "callAudioControl").map((s) => s.args);
  const clips = () => [...new Set(plays().map((p) => p.clip))];
  /** Settle the newest clip with `state`. */
  const settle = (state: "ended" | "failed" | "cut" | "playing") => {
    const clip = plays().at(-1)!.clip as string;
    for (const fn of [...listeners]) fn({ type: "clip", session: "s1", clip, state });
  };
  return { player, plays, clips, controls, settle };
}

function speakFetch(speak: () => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/prepare")) {
        return json({ ready: true, utterances: [JSON.parse(String(init?.body)).text] });
      }
      return speak();
    }),
  );
}

const mp3 = () => new Response(new Blob([new Uint8Array([1, 2, 3])]), { status: 200, headers: { "content-type": "audio/mpeg" } });

describe("Speaker output (native call audio, spec §4.3.4)", () => {
  beforeEach(() => {
    FakeAudio.latest = null;
    vi.restoreAllMocks();
    vi.stubGlobal("Audio", FakeAudio);
    // the iPhone may have no MediaSource at all
    vi.stubGlobal("MediaSource", undefined);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice-test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams to the native player with MediaSource undefined: pieces go out before the body ends", async () => {
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    speakFetch(
      () =>
        new Response(new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) }), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        }),
    );
    const out = nativeOutput();
    const speaker = new Speaker();
    speaker.useOutput(out.player);
    const speaking = speaker.speak("Hello there.");
    await vi.waitFor(() => expect(ctl).toBeDefined());
    ctl.enqueue(new Uint8Array([9, 9, 9]));
    await vi.waitFor(() => expect(out.plays()).toHaveLength(1));
    expect(out.plays()[0]).toMatchObject({ session: "s1", seq: 0, mime: "audio/mpeg", last: false });

    ctl.close();
    await vi.waitFor(() => expect(out.plays()).toHaveLength(2));
    expect(out.plays()[1]).toMatchObject({ seq: 1, last: true, bytes: "" });
    out.settle("ended");
    await speaking;
    expect(speaker.state).toEqual({ status: "idle" });
    expect(FakeAudio.latest).toBeNull();
  });

  it("useOutput: speech goes native while set, and back to the HTML player once cleared", async () => {
    speakFetch(mp3);
    const out = nativeOutput();
    const speaker = new Speaker();
    speaker.useOutput(out.player);
    const first = speaker.speak("On the call.");
    await vi.waitFor(() => expect(out.clips()).toHaveLength(1));
    out.settle("ended");
    await first;
    expect(FakeAudio.latest).toBeNull();

    // CallView's unmount cleanup, before callAudioClose
    speaker.useOutput(null);
    const second = speaker.speak("A voice message after the call.");
    await vi.waitFor(() => expect(FakeAudio.latest).not.toBeNull());
    FakeAudio.latest!.onended?.();
    await second;
    expect(out.clips()).toHaveLength(1);
  });

  it("keeps the player it started with when the output changes mid-speech", async () => {
    speakFetch(mp3);
    const out = nativeOutput();
    const speaker = new Speaker();
    speaker.useOutput(out.player);
    const stream = speaker.stream();
    stream.push("First sentence.");
    await vi.waitFor(() => expect(out.clips()).toHaveLength(1));
    speaker.useOutput(null);
    stream.push("Second sentence.");
    out.settle("ended");
    await vi.waitFor(() => expect(out.clips()).toHaveLength(2));
    stream.end();
    out.settle("ended");
    await expect(stream.done).resolves.toBe(true);
    expect(FakeAudio.latest).toBeNull();
  });

  it("a cut ends a stream without the clip error, and heard() marks the cut sentence like an interrupted one", async () => {
    speakFetch(mp3);
    const out = nativeOutput();
    const speaker = new Speaker();
    speaker.useOutput(out.player);
    const stream = speaker.stream();
    stream.push("You asked about the build.");
    stream.push("It passed.");
    await vi.waitFor(() => expect(out.clips()).toHaveLength(1));
    out.settle("ended");
    await vi.waitFor(() => expect(out.clips()).toHaveLength(2));
    // AirPods out: native cuts the clip (reason "hold")
    out.settle("cut");
    await expect(stream.done).resolves.toBe(false);
    expect(speaker.state).toEqual({ status: "idle" });
    expect(stream.heard()).toEqual(["You asked about the build.", "It passed…"]);
  });

  it("a stream says when its first clip began to sound, for the call's turn timing", async () => {
    speakFetch(mp3);
    const out = nativeOutput();
    const speaker = new Speaker();
    speaker.useOutput(out.player);
    const stream = speaker.stream();
    stream.push("First.");
    await vi.waitFor(() => expect(out.clips()).toHaveLength(1));
    expect(stream.playingAt()).toBeNull();
    const before = Date.now();
    out.settle("playing");
    const at = stream.playingAt();
    expect(at).toBeGreaterThanOrEqual(before);
    out.settle("ended");
    stream.push("Second.");
    await vi.waitFor(() => expect(out.clips()).toHaveLength(2));
    out.settle("playing");
    expect(stream.playingAt()).toBe(at);
    stream.end();
    out.settle("ended");
    await expect(stream.done).resolves.toBe(true);
  });

  it("a cut ends speak() without the clip error", async () => {
    speakFetch(mp3);
    const out = nativeOutput();
    const speaker = new Speaker();
    speaker.useOutput(out.player);
    const speaking = speaker.speak("Cut short.");
    await vi.waitFor(() => expect(out.clips()).toHaveLength(1));
    out.settle("cut");
    await speaking;
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("a failed native clip shows the clip error", async () => {
    speakFetch(mp3);
    const out = nativeOutput();
    const speaker = new Speaker();
    speaker.useOutput(out.player);
    const stream = speaker.stream();
    stream.push("Undecodable.");
    await vi.waitFor(() => expect(out.clips()).toHaveLength(1));
    out.settle("failed");
    await expect(stream.done).resolves.toBe(false);
    expect(speaker.state).toEqual({ status: "idle", error: "The generated voice clip couldn't be played." });
  });

  it("a clip that starts while the speaker is held goes out paused and plays on resume", async () => {
    speakFetch(mp3);
    const out = nativeOutput();
    const speaker = new Speaker();
    speaker.useOutput(out.player);
    const speaking = speaker.speak("Held.");
    expect(speaker.pause()).toBe(true);
    await vi.waitFor(() => expect(out.clips()).toHaveLength(1));
    expect(out.plays()[0]).toMatchObject({ seq: 0, paused: true });
    speaker.resume();
    expect(out.controls()).toEqual([{ session: "s1", action: "resume" }]);
    out.settle("ended");
    await speaking;
  });

  it("stop() stops the native clip and settles the speech", async () => {
    speakFetch(mp3);
    const out = nativeOutput();
    const speaker = new Speaker();
    speaker.useOutput(out.player);
    const speaking = speaker.speak("Talk over me.");
    await vi.waitFor(() => expect(out.clips()).toHaveLength(1));
    speaker.stop();
    await speaking;
    expect(out.controls()).toEqual([{ session: "s1", action: "stop" }]);
    expect(speaker.state).toEqual({ status: "idle" });
  });
});

describe("early exits and broken downloads (callbar-rereview3.md A7, A10)", () => {
  beforeEach(() => {
    FakeAudio.latest = null;
    vi.restoreAllMocks();
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("MediaSource", undefined);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice-test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** /prepare answers `utterances`; the first render is a clip, every later
   *  one a download that only ends when its request is aborted. */
  function twoSentenceFetch(utterances: string[]) {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/prepare")) return json({ ready: true, utterances });
        signals.push(init!.signal!);
        if (signals.length === 1) return mp3();
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }),
    );
    return signals;
  }

  it("speak(): a failed clip aborts the prefetched render of the next sentence", async () => {
    const signals = twoSentenceFetch(["One.", "Two."]);
    const out = nativeOutput();
    const speaker = new Speaker();
    speaker.useOutput(out.player);
    const speaking = speaker.speak("One. Two.");
    await vi.waitFor(() => expect(out.clips()).toHaveLength(1));
    expect(signals).toHaveLength(2);
    expect(signals[1].aborted).toBe(false);
    out.settle("failed");
    await speaking;
    expect(signals[1].aborted).toBe(true);
  });

  it("stream(): a failed clip aborts the prefetched render of the next sentence", async () => {
    const signals = twoSentenceFetch([]);
    const out = nativeOutput();
    const speaker = new Speaker();
    speaker.useOutput(out.player);
    const stream = speaker.stream();
    stream.push("One.");
    stream.push("Two.");
    await vi.waitFor(() => expect(out.clips()).toHaveLength(1));
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    out.settle("failed");
    await expect(stream.done).resolves.toBe(false);
    expect(signals[1].aborted).toBe(true);
  });

  it("a clip whose download broke part-way is recorded as heard in part, not in full", async () => {
    let sentFirst = false;
    speakFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            // the first piece arrives, then the connection drops
            pull(c) {
              if (sentFirst) return c.error(new Error("connection dropped"));
              sentFirst = true;
              c.enqueue(new Uint8Array([9, 9, 9]));
            },
          }),
          { status: 200, headers: { "content-type": "audio/mpeg" } },
        ),
    );
    const out = nativeOutput();
    const speaker = new Speaker();
    speaker.useOutput(out.player);
    const stream = speaker.stream();
    stream.push("Hello there.");
    await vi.waitFor(() => expect(out.plays().some((p) => p.last === true)).toBe(true));
    // native plays what arrived and reports the clip ended
    out.settle("ended");
    stream.end();
    await stream.done;
    expect(stream.heard()).toEqual(["Hello there\u2026"]);
  });

  it("a complete download is still recorded in full", async () => {
    speakFetch(mp3);
    const out = nativeOutput();
    const speaker = new Speaker();
    speaker.useOutput(out.player);
    const stream = speaker.stream();
    stream.push("Hello there.");
    await vi.waitFor(() => expect(out.plays().some((p) => p.last === true)).toBe(true));
    out.settle("ended");
    stream.end();
    await stream.done;
    expect(stream.heard()).toEqual(["Hello there."]);
  });
});

describe("the call screen's read-along and aura (call-aura-design.md)", () => {
  beforeEach(() => {
    FakeAudio.latest = null;
    vi.restoreAllMocks();
    vi.stubGlobal("Audio", FakeAudio);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice-test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  it("announces each <audio> before it plays, and goes on whatever a watcher does", async () => {
    const { onClipElement } = await import("./index");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/prepare") ? json({ ready: true, utterances: ["Hello there."] }) : new Response(new Blob(["mp3"]), { status: 200 }),
      ),
    );
    const seen: unknown[] = [];
    const off = onClipElement((audio) => seen.push(audio));
    const broken = onClipElement(() => {
      throw new Error("a watcher's bug");
    });
    const speaker = new Speaker();
    const speaking = speaker.speak("Hello there.");
    await vi.waitFor(() => expect(FakeAudio.latest).not.toBeNull());
    expect(seen).toEqual([FakeAudio.latest]);
    expect(FakeAudio.latest!.play).toHaveBeenCalled();
    off();
    broken();
    speaker.stop();
    await speaking;
  });

  it("speak(): the snapshot carries what was heard and what is still to come", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/prepare") ? json({ ready: true, utterances: ["One.", "Two.", "Three."] }) : new Response(new Blob(["mp3"]), { status: 200 }),
      ),
    );
    const speaker = new Speaker();
    const speaking = speaker.speak("One. Two. Three.");
    await vi.waitFor(() => expect(speaker.state.status).toBe("speaking"));
    expect(speaker.state).toMatchObject({ caption: "One.", spoken: [], queued: ["Two.", "Three."] });
    const first = FakeAudio.latest!;
    first.onended?.();
    await vi.waitFor(() => expect(speaker.state.caption).toBe("Two."));
    expect(speaker.state).toMatchObject({ spoken: ["One."], queued: ["Three."] });
    speaker.stop();
    await speaking;
  });

  it("stream(): sentences the host sends while one plays show up as still to come", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["mp3"]), { status: 200 })));
    const speaker = new Speaker();
    const live = speaker.stream();
    live.push("One.");
    await vi.waitFor(() => expect(speaker.state.status).toBe("speaking"));
    expect(speaker.state).toMatchObject({ caption: "One.", spoken: [], queued: [] });
    live.push("Two.");
    live.push("Three.");
    expect(speaker.state.queued).toEqual(["Two.", "Three."]);
    FakeAudio.latest!.onended?.();
    await vi.waitFor(() => expect(speaker.state.caption).toBe("Two."));
    expect(speaker.state.spoken).toEqual(["One."]);
    expect(speaker.state.queued).toEqual(["Three."]);
    live.end();
    speaker.stop();
    await live.done;
  });
});

describe("first clip timing and player kind", () => {
  const stubPlayer = (streams: boolean) => ({
    streams,
    play: vi.fn(async (_clip: unknown, _live: () => boolean, opts: { onPlaying?: () => void }) => {
      opts.onPlaying?.();
      return "ended" as const;
    }),
    pause() {},
    resume() {},
    teardown() {},
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("firstClip(): the body that yields after 250 ms puts first byte 250 ms after the request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    vi.stubGlobal("MediaSource", undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            setTimeout(() => {
              c.enqueue(new Uint8Array([1, 2, 3]));
              c.close();
            }, 250);
          },
        });
        return { ok: true, status: 200, headers: { get: () => "audio/mpeg" }, body } as unknown as Response;
      }),
    );
    const speaker = new Speaker();
    speaker.useOutput(stubPlayer(true));
    const stream = speaker.stream();
    expect(stream.firstClip()).toBeNull();
    stream.push("Hello there.");
    stream.end();
    await vi.advanceTimersByTimeAsync(300);
    await stream.done;
    const t = stream.firstClip()!;
    expect(t.headersAt).toBe(t.requestedAt);
    expect(t.firstByteAt! - t.requestedAt).toBe(250);
    expect(stream.player()).toBe("native");
    expect(JSON.stringify(t)).not.toMatch(/Hello/);
  });

  it("player() is blob when MediaSource is missing and the player does not stream; firstByteAt is headersAt", async () => {
    vi.stubGlobal("MediaSource", undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["mp3"]), { status: 200, headers: { "content-type": "audio/mpeg" } })));
    const speaker = new Speaker();
    speaker.useOutput(stubPlayer(false));
    const stream = speaker.stream();
    expect(stream.player()).toBeNull();
    stream.push("Hello there.");
    stream.end();
    await stream.done;
    expect(stream.player()).toBe("blob");
    const t = stream.firstClip()!;
    expect(t.firstByteAt).toBe(t.headersAt);
  });

  it("player() is mse when the window can stream the type", async () => {
    vi.stubGlobal("MediaSource", { isTypeSupported: () => true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["mp3"]), { status: 200, headers: { "content-type": "audio/mpeg" } })));
    const speaker = new Speaker();
    speaker.useOutput(stubPlayer(false));
    const stream = speaker.stream();
    stream.push("Hello there.");
    stream.end();
    await stream.done;
    expect(stream.player()).toBe("mse");
  });

  it("onPlaying fires once, when the first clip sounds, for stream() and speak()", async () => {
    vi.stubGlobal("MediaSource", undefined);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith("/prepare")
        ? json({ ready: true, utterances: ["One.", "Two."] })
        : new Response(new Blob(["mp3"]), { status: 200, headers: { "content-type": "audio/mpeg" } })));
    const a = new Speaker();
    a.useOutput(stubPlayer(false));
    const streamed = vi.fn();
    const s = a.stream({ onPlaying: streamed });
    s.push("One.");
    s.push("Two.");
    s.end();
    await s.done;
    expect(streamed).toHaveBeenCalledTimes(1);
    const spoke = vi.fn();
    a.useOutput(stubPlayer(false));
    await a.speak("One. Two.", { onPlaying: spoke });
    expect(spoke).toHaveBeenCalledTimes(1);
  });
});

/** A player whose clips settle when the test says so; teardown cuts the one playing. */
function controlledPlayer() {
  const plays: Array<{ clip: Audible; settle: (o: ClipOutcome) => void; sound: () => void }> = [];
  const player: ClipPlayer = {
    streams: false,
    play: (clip, _live, opts) =>
      new Promise<ClipOutcome>((resolve) => {
        plays.push({ clip, settle: resolve, sound: () => opts.onPlaying?.() });
      }),
    pause: () => {},
    resume: () => {},
    teardown: () => {
      const last = plays.at(-1);
      last?.settle("cut");
    },
  };
  return { player, plays };
}

describe("Speaker cue clips", () => {
  const cueBlob = new Blob(["cue"]);

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("MediaSource", undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["real"]), { status: 200, headers: { "content-type": "audio/mpeg" } })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("a cue plays first and stays out of heard(), the caption and playingAt", async () => {
    const out = controlledPlayer();
    const speaker = new Speaker();
    speaker.useOutput(out.player);
    const onPlaying = vi.fn();
    const stream = speaker.stream({ onPlaying });
    stream.cue(cueBlob);
    await vi.waitFor(() => expect(out.plays).toHaveLength(1));
    expect(out.plays[0].clip).toBe(cueBlob);
    out.plays[0].sound();
    expect(stream.cueAt()).not.toBeNull();
    expect(stream.playingAt()).toBeNull();
    expect(onPlaying).not.toHaveBeenCalled();
    expect(speaker.isSpeaking()).toBe(true);
    expect(speaker.state.caption).toBeUndefined();
    expect(speaker.state.spoken ?? []).toEqual([]);

    stream.push("Here is the answer.");
    await Promise.resolve();
    expect(out.plays).toHaveLength(1); // queued behind the sounding cue
    out.plays[0].settle("ended");
    await vi.waitFor(() => expect(out.plays).toHaveLength(2));
    expect(speaker.state.caption).toBe("Here is the answer.");
    expect(stream.heard()).toEqual(["Here is the answer…"]);
    out.plays[1].sound();
    expect(onPlaying).toHaveBeenCalledTimes(1);
    expect(stream.playingAt()).toBeGreaterThanOrEqual(stream.cueAt()!);
    out.plays[1].settle("ended");
    stream.end();
    await expect(stream.done).resolves.toBe(true);
    expect(stream.heard()).toEqual(["Here is the answer."]);
  });

  it("a real push before the cue sounds drops it: the cue never reaches the player", async () => {
    const out = controlledPlayer();
    const speaker = new Speaker();
    speaker.useOutput(out.player);
    const stream = speaker.stream();
    stream.cue(cueBlob);
    stream.push("Real reply.");
    await vi.waitFor(() => expect(out.plays).toHaveLength(1));
    expect(out.plays[0].clip).not.toBe(cueBlob);
    expect(out.plays[0].clip instanceof Blob || out.plays[0].clip instanceof Incoming).toBe(true);
    out.plays[0].settle("ended");
    stream.end();
    await expect(stream.done).resolves.toBe(true);
    expect(out.plays).toHaveLength(1);
    expect(stream.cueAt()).toBeNull();
  });

  it("a cue asked for after a real piece was pushed is ignored", async () => {
    const out = controlledPlayer();
    const speaker = new Speaker();
    speaker.useOutput(out.player);
    const stream = speaker.stream();
    stream.push("Real reply.");
    stream.cue(cueBlob);
    await vi.waitFor(() => expect(out.plays).toHaveLength(1));
    out.plays[0].settle("ended");
    stream.end();
    await stream.done;
    expect(out.plays.every((p) => p.clip !== cueBlob)).toBe(true);
  });

  it("a real push while the cue is handed over but not yet sounding cuts it and plays the piece", async () => {
    const out = controlledPlayer();
    const speaker = new Speaker();
    speaker.useOutput(out.player);
    const stream = speaker.stream();
    stream.cue(cueBlob);
    await vi.waitFor(() => expect(out.plays).toHaveLength(1)); // handed over, no sound yet
    stream.push("Real reply.");
    await vi.waitFor(() => expect(out.plays).toHaveLength(2));
    expect(stream.cueAt()).toBeNull();
    out.plays[1].settle("ended");
    stream.end();
    await expect(stream.done).resolves.toBe(true);
  });

  it("stop() during the cue settles done false", async () => {
    const out = controlledPlayer();
    const speaker = new Speaker();
    speaker.useOutput(out.player);
    const stream = speaker.stream();
    stream.cue(cueBlob);
    await vi.waitFor(() => expect(out.plays).toHaveLength(1));
    out.plays[0].sound();
    speaker.stop();
    await expect(stream.done).resolves.toBe(false);
    expect(speaker.isSpeaking()).toBe(false);
  });

  it("after the cue ends with no real piece yet, the status goes back to preparing and cue() settles", async () => {
    const out = controlledPlayer();
    const speaker = new Speaker();
    speaker.useOutput(out.player);
    const stream = speaker.stream({ botId: "b" });
    const settled = vi.fn();
    void stream.cue(cueBlob)?.then(settled);
    await vi.waitFor(() => expect(out.plays).toHaveLength(1));
    out.plays[0].sound();
    expect(speaker.state.status).toBe("speaking");
    expect(settled).not.toHaveBeenCalled();
    out.plays[0].settle("ended");
    await vi.waitFor(() => expect(settled).toHaveBeenCalled());
    expect(speaker.state.status).toBe("preparing");
    stream.push("Real answer.");
    await vi.waitFor(() => expect(out.plays).toHaveLength(2));
    out.plays[1].settle("ended");
    stream.end();
    await expect(stream.done).resolves.toBe(true);
  });

  it("a cue that is ignored or dropped settles at once", async () => {
    const out = controlledPlayer();
    const speaker = new Speaker();
    speaker.useOutput(out.player);
    const stream = speaker.stream();
    stream.push("Already real.");
    await expect(stream.cue(cueBlob)).resolves.toBeUndefined();
    speaker.stop();
  });

  it("a cue-only stream ends with the cue", async () => {
    const out = controlledPlayer();
    const speaker = new Speaker();
    speaker.useOutput(out.player);
    const stream = speaker.stream();
    stream.cue(cueBlob);
    stream.end();
    await vi.waitFor(() => expect(out.plays).toHaveLength(1));
    out.plays[0].sound();
    expect(speaker.isSpeaking()).toBe(true);
    out.plays[0].settle("ended");
    await expect(stream.done).resolves.toBe(true);
    expect(stream.heard()).toEqual([]);
    expect(speaker.state).toEqual({ status: "idle" });
  });

  it("a failed cue is swallowed: no error shows and the real reply still plays", async () => {
    const out = controlledPlayer();
    const speaker = new Speaker();
    speaker.useOutput(out.player);
    const stream = speaker.stream();
    stream.cue(cueBlob);
    await vi.waitFor(() => expect(out.plays).toHaveLength(1));
    out.plays[0].settle("failed");
    stream.push("Real reply.");
    await vi.waitFor(() => expect(out.plays).toHaveLength(2));
    expect(speaker.state.error).toBeUndefined();
    out.plays[1].settle("ended");
    stream.end();
    await expect(stream.done).resolves.toBe(true);
  });

  it("the native player receives the cue Blob as one piece", async () => {
    const sent: Array<{ method: NativeMethod; args: Record<string, unknown> }> = [];
    const listeners = new Set<(e: CallAudioEvent) => void>();
    const player = new NativeClipPlayer({
      session: "s1",
      onEvent: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      call: async (method: NativeMethod, ...args: unknown[]) => {
        sent.push({ method, args: args[0] as Record<string, unknown> });
        return true;
      },
    });
    const speaker = new Speaker();
    speaker.useOutput(player);
    const stream = speaker.stream();
    stream.cue(new Blob([new Uint8Array([7, 7])], { type: "audio/mpeg" }));
    stream.end();
    await vi.waitFor(() => expect(sent.some((s) => s.method === "callAudioPlay")).toBe(true));
    const plays = sent.filter((s) => s.method === "callAudioPlay").map((s) => s.args);
    expect(plays).toHaveLength(1);
    expect(plays[0]).toMatchObject({ seq: 0, last: true });
    const clip = plays[0].clip as string;
    for (const fn of [...listeners]) fn({ type: "clip", session: "s1", clip, state: "ended" });
    await expect(stream.done).resolves.toBe(true);
  });
});

describe("Speaker.fetchClip", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the whole clip from /api/tts/speak", async () => {
    const fetchMock = vi.fn(async () => new Response(new Blob(["abc"]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
    vi.stubGlobal("fetch", fetchMock);
    const blob = await new Speaker().fetchClip("One sec.", { botId: "b", voiceId: "v" });
    expect(await blob.text()).toBe("abc");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/tts/speak");
    expect(JSON.parse(String(init.body))).toEqual({ text: "One sec.", voiceId: "v", botId: "b" });
  });

  it("rejects when the voice service refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 502 })));
    await expect(new Speaker().fetchClip("One sec.", { botId: "b" })).rejects.toThrow("nope");
  });
});
