import { afterEach, describe, expect, it, vi } from "vitest";

import type { CallAudioEvent, NativeMethod } from "@/lib/native-shell";
import { Incoming } from "./index";
import { NativeClipPlayer, PIECE_BYTES } from "./native-player";

type Sent = { method: NativeMethod; args: Record<string, unknown> };

/** A fake bridge: the event source NativeFrameSource would hand over, and a
 *  callNative that records every call and answers true. */
function harness(session = "s1") {
  const listeners = new Set<(e: CallAudioEvent) => void>();
  const sent: Sent[] = [];
  let answer: (method: NativeMethod, args: Record<string, unknown>) => Promise<unknown> = async () => true;
  const call = vi.fn((method: NativeMethod, ...args: unknown[]) => {
    const record = { method, args: args[0] as Record<string, unknown> };
    sent.push(record);
    return answer(method, record.args);
  });
  const player = new NativeClipPlayer({
    session,
    onEvent: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    call,
  });
  const plays = () => sent.filter((s) => s.method === "callAudioPlay").map((s) => s.args);
  const controls = () => sent.filter((s) => s.method === "callAudioControl").map((s) => s.args);
  const clip = (state: "playing" | "progress" | "ended" | "failed" | "cut", id = plays()[0]?.clip as string) => {
    for (const fn of [...listeners]) fn({ type: "clip", session, clip: id, state });
  };
  return {
    player,
    call,
    sent,
    plays,
    controls,
    clip,
    listeners,
    answerWith: (fn: typeof answer) => (answer = fn),
  };
}

function streamed(mime = "audio/mpeg") {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
  return {
    clip: Incoming.read(body, mime),
    push: (bytes: Uint8Array) => ctl.enqueue(bytes),
    end: () => ctl.close(),
    fail: () => ctl.error(new Error("connection dropped")),
  };
}

const bytesOf = (n: number, seed = 0) => Uint8Array.from({ length: n }, (_, i) => (i + seed) % 251);
const decode = (b64: unknown) => new Uint8Array(Buffer.from(String(b64), "base64"));
const live = () => true;
const settledState = async (p: Promise<unknown>) => {
  let value: unknown = "pending";
  void p.then((v) => (value = v));
  await Promise.resolve();
  await Promise.resolve();
  return value;
};

describe("NativeClipPlayer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("always streams: the body is read as it arrives, MediaSource or not", () => {
    expect(harness().player.streams).toBe(true);
  });

  it("sends a Blob clip in 64 KB pieces, in order, with the last flagged", async () => {
    const h = harness();
    const source = bytesOf(150_000);
    const playing = h.player.play(new Blob([source], { type: "audio/mp3" }), live, { held: false });
    await vi.waitFor(() => expect(h.plays()).toHaveLength(3));

    const pieces = h.plays();
    expect(PIECE_BYTES).toBe(64 * 1024);
    expect(pieces.map((p) => p.seq)).toEqual([0, 1, 2]);
    expect(pieces.map((p) => p.last)).toEqual([false, false, true]);
    expect(pieces.every((p) => p.session === "s1" && p.clip === pieces[0].clip && p.mime === "audio/mpeg")).toBe(true);
    expect(pieces.map((p) => decode(p.bytes).byteLength)).toEqual([65_536, 65_536, 150_000 - 131_072]);
    const joined = new Uint8Array(pieces.flatMap((p) => [...decode(p.bytes)]));
    expect(joined).toEqual(source);
    expect(pieces[0]).not.toHaveProperty("paused");

    h.clip("playing");
    h.clip("ended");
    await expect(playing).resolves.toBe("ended");
  });

  it("waits for each piece's reply before sending the next", async () => {
    const h = harness();
    const replies: Array<() => void> = [];
    h.answerWith(() => new Promise((resolve) => replies.push(() => resolve(true))));
    void h.player.play(new Blob([bytesOf(140_000)]), live, { held: false });
    await vi.waitFor(() => expect(h.plays()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(h.plays()).toHaveLength(1);
    replies.shift()!();
    await vi.waitFor(() => expect(h.plays()).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 10));
    expect(h.plays()).toHaveLength(2);
    replies.shift()!();
    await vi.waitFor(() => expect(h.plays()).toHaveLength(3));
  });

  it("streams a download: pieces go out before the body ends, then an empty last piece", async () => {
    const h = harness();
    const download = streamed("audio/mpeg");
    const playing = h.player.play(download.clip, live, { held: false });
    download.push(bytesOf(1_000));
    await vi.waitFor(() => expect(h.plays()).toHaveLength(1));
    expect(h.plays()[0]).toMatchObject({ seq: 0, last: false });
    download.push(bytesOf(2_000, 7));
    await vi.waitFor(() => expect(h.plays()).toHaveLength(2));
    expect(h.plays()[1]).toMatchObject({ seq: 1, last: false });

    download.end();
    await vi.waitFor(() => expect(h.plays()).toHaveLength(3));
    expect(h.plays()[2]).toMatchObject({ seq: 2, last: true, bytes: "" });
    h.clip("ended");
    await expect(playing).resolves.toBe("ended");
  });

  it("a download that broke part-way still ends the clip with last for what arrived", async () => {
    const h = harness();
    const download = streamed();
    void h.player.play(download.clip, live, { held: false });
    download.push(bytesOf(500));
    await vi.waitFor(() => expect(h.plays()).toHaveLength(1));
    download.fail();
    await vi.waitFor(() => expect(h.plays().at(-1)).toMatchObject({ last: true }));
  });

  it("fails a clip where no audio arrived at all, without sending anything", async () => {
    const h = harness();
    const download = streamed();
    const playing = h.player.play(download.clip, live, { held: false });
    download.end();
    await expect(playing).resolves.toBe("failed");
    await expect(h.player.play(new Blob([]), live, { held: false })).resolves.toBe("failed");
    expect(h.plays()).toEqual([]);
  });

  it.each(["ended", "failed", "cut"] as const)("settles %s on the matching clip event", async (state) => {
    const h = harness();
    const playing = h.player.play(new Blob([bytesOf(10)]), live, { held: false });
    await vi.waitFor(() => expect(h.plays()).toHaveLength(1));
    h.clip(state);
    await expect(playing).resolves.toBe(state);
    expect(h.listeners.size).toBe(0);
  });

  it("ignores events for another clip or session", async () => {
    const h = harness();
    const playing = h.player.play(new Blob([bytesOf(10)]), live, { held: false });
    await vi.waitFor(() => expect(h.plays()).toHaveLength(1));
    h.clip("ended", "someone-else");
    for (const fn of [...h.listeners]) fn({ type: "clip", session: "old", clip: h.plays()[0].clip as string, state: "failed" });
    for (const fn of [...h.listeners]) fn({ type: "hold", session: "s1", reason: "interrupted" });
    expect(await settledState(playing)).toBe("pending");
    h.clip("ended");
    await expect(playing).resolves.toBe("ended");
  });

  it("gives every play() its own clip id, at most 64 characters even for a long session", async () => {
    const h = harness("x".repeat(200));
    for (let i = 0; i < 3; i += 1) {
      const playing = h.player.play(new Blob([bytesOf(10)]), live, { held: false });
      await vi.waitFor(() => expect(h.plays()).toHaveLength(i + 1));
      h.clip("ended", h.plays()[i].clip as string);
      await playing;
    }
    const ids = h.plays().map((p) => p.clip as string);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => id.length > 0 && id.length <= 64)).toBe(true);
  });

  it("marks only the first piece paused when the speaker is held", async () => {
    const h = harness();
    void h.player.play(new Blob([bytesOf(100_000)]), live, { held: true });
    await vi.waitFor(() => expect(h.plays()).toHaveLength(2));
    expect(h.plays()[0]).toMatchObject({ seq: 0, paused: true });
    expect(h.plays()[1]).not.toHaveProperty("paused");
  });

  it("maps pause, resume and stop to callAudioControl, and stop settles cut", async () => {
    const h = harness();
    const playing = h.player.play(new Blob([bytesOf(10)]), live, { held: false });
    await vi.waitFor(() => expect(h.plays()).toHaveLength(1));
    h.player.pause();
    h.player.resume();
    h.player.teardown();
    await expect(playing).resolves.toBe("cut");
    expect(h.controls()).toEqual([
      { session: "s1", action: "pause" },
      { session: "s1", action: "resume" },
      { session: "s1", action: "stop" },
    ]);
  });

  it("sends no control when no clip is in flight", () => {
    const h = harness();
    h.player.pause();
    h.player.resume();
    h.player.teardown();
    expect(h.sent).toEqual([]);
  });

  it("stops sending the rest of a clip once it is stopped", async () => {
    const h = harness();
    const replies: Array<() => void> = [];
    h.answerWith((method) => (method === "callAudioPlay" ? new Promise((r) => replies.push(() => r(true))) : Promise.resolve(true)));
    const playing = h.player.play(new Blob([bytesOf(200_000)]), live, { held: false });
    await vi.waitFor(() => expect(h.plays()).toHaveLength(1));
    h.player.teardown();
    replies.shift()!();
    await expect(playing).resolves.toBe("cut");
    await new Promise((r) => setTimeout(r, 10));
    expect(h.plays()).toHaveLength(1);
  });

  it("settles failed when callAudioPlay is refused", async () => {
    const h = harness();
    h.answerWith(async () => {
      throw Object.assign(new Error("unavailable"), { code: "unavailable" });
    });
    await expect(h.player.play(new Blob([bytesOf(10)]), live, { held: false })).resolves.toBe("failed");
  });

  it("settles cut, not failed, when the refusal lands after a stop", async () => {
    const h = harness();
    let refuse!: () => void;
    h.answerWith((method) =>
      method === "callAudioPlay"
        ? new Promise((_r, reject) => (refuse = () => reject(new Error("unavailable"))))
        : Promise.resolve(true),
    );
    const playing = h.player.play(new Blob([bytesOf(10)]), live, { held: false });
    await vi.waitFor(() => expect(h.plays()).toHaveLength(1));
    h.player.teardown();
    refuse();
    await expect(playing).resolves.toBe("cut");
  });

  it("settles cut without sending when the speech was already interrupted", async () => {
    const h = harness();
    await expect(h.player.play(new Blob([bytesOf(10)]), () => false, { held: false })).resolves.toBe("cut");
    expect(h.sent).toEqual([]);
  });

  it("marks the first piece paused when pause() lands before it goes out", async () => {
    const h = harness();
    const download = streamed();
    void h.player.play(download.clip, live, { held: false });
    h.player.pause();
    download.push(bytesOf(100));
    await vi.waitFor(() => expect(h.plays()).toHaveLength(1));
    expect(h.plays()[0]).toMatchObject({ seq: 0, paused: true });
  });

  it("fails a Blob that cannot be read at once, not after the stall clock", async () => {
    const h = harness();
    const broken = new Blob([bytesOf(10)]);
    broken.arrayBuffer = () => Promise.reject(new Error("unreadable"));
    await expect(h.player.play(broken, live, { held: false })).resolves.toBe("failed");
    expect(h.plays()).toEqual([]);
  });

  describe("the 8 s stall clock", () => {
    it("fails a clip that never reports playing", async () => {
      vi.useFakeTimers();
      const h = harness();
      const playing = h.player.play(new Blob([bytesOf(10)]), live, { held: false });
      await vi.advanceTimersByTimeAsync(7_900);
      expect(await settledState(playing)).toBe("pending");
      await vi.advanceTimersByTimeAsync(200);
      await expect(playing).resolves.toBe("failed");
    });

    it("stops the clip natively when it gives up, and ignores that clip's later events", async () => {
      vi.useFakeTimers();
      const h = harness();
      const playing = h.player.play(new Blob([bytesOf(10)]), live, { held: false });
      await vi.advanceTimersByTimeAsync(8_100);
      await expect(playing).resolves.toBe("failed");
      expect(h.controls()).toEqual([{ session: "s1", action: "stop" }]);
      // native starting late, after the page gave up, changes nothing
      h.clip("playing");
      h.clip("ended");
      expect(h.listeners.size).toBe(0);
      await expect(playing).resolves.toBe("failed");
    });

    it("sends no stop for a clip that is no longer the current one", async () => {
      vi.useFakeTimers();
      const h = harness();
      const first = h.player.play(new Blob([bytesOf(10)]), live, { held: false });
      await vi.advanceTimersByTimeAsync(0);
      // the page never does this, but a second play() takes over the player
      const second = h.player.play(new Blob([bytesOf(10)]), live, { held: true });
      await expect(first).resolves.toBe("cut");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.controls()).toEqual([]);
      expect(await settledState(second)).toBe("pending");
    });

    it("stops sending a streamed clip once it stalls mid-download", async () => {
      vi.useFakeTimers();
      const h = harness();
      const download = streamed();
      const playing = h.player.play(download.clip, live, { held: false });
      download.push(bytesOf(100));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.plays()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(8_100);
      await expect(playing).resolves.toBe("failed");
      download.push(bytesOf(100));
      download.end();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.plays()).toHaveLength(1);
      expect(h.controls()).toEqual([{ session: "s1", action: "stop" }]);
    });

    it("is re-armed by playing and progress, so a long clip is never cut short", async () => {
      vi.useFakeTimers();
      const h = harness();
      const playing = h.player.play(new Blob([bytesOf(10)]), live, { held: false });
      await vi.advanceTimersByTimeAsync(0);
      h.clip("playing");
      for (let i = 0; i < 6; i += 1) {
        await vi.advanceTimersByTimeAsync(5_000);
        h.clip("progress");
      }
      expect(await settledState(playing)).toBe("pending");
      h.clip("ended");
      await expect(playing).resolves.toBe("ended");
    });

    it("fails a clip that stalls after progress stops", async () => {
      vi.useFakeTimers();
      const h = harness();
      const playing = h.player.play(new Blob([bytesOf(10)]), live, { held: false });
      await vi.advanceTimersByTimeAsync(0);
      h.clip("playing");
      await vi.advanceTimersByTimeAsync(5_000);
      h.clip("progress");
      await vi.advanceTimersByTimeAsync(8_100);
      await expect(playing).resolves.toBe("failed");
    });

    it("is cleared by pause(), never trips during a 10 s hold, and re-arms on resume()", async () => {
      vi.useFakeTimers();
      const h = harness();
      const playing = h.player.play(new Blob([bytesOf(10)]), live, { held: false });
      await vi.advanceTimersByTimeAsync(0);
      h.clip("playing");
      await vi.advanceTimersByTimeAsync(3_000);
      h.player.pause();
      // a progress already in flight when the pause landed must not re-arm it
      h.clip("progress");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await settledState(playing)).toBe("pending");
      h.player.resume();
      await vi.advanceTimersByTimeAsync(8_100);
      await expect(playing).resolves.toBe("failed");
    });

    it("treats an under-run on a slow download as alive: audio still arriving re-arms the clock", async () => {
      vi.useFakeTimers();
      const h = harness();
      const download = streamed();
      const playing = h.player.play(download.clip, live, { held: false });
      download.push(bytesOf(100));
      await vi.advanceTimersByTimeAsync(0);
      h.clip("playing");
      // native ran dry and sends no progress, but the rest trickles in
      for (let i = 0; i < 4; i += 1) {
        await vi.advanceTimersByTimeAsync(6_000);
        download.push(bytesOf(100, i));
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(await settledState(playing)).toBe("pending");
      download.end();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.plays().at(-1)).toMatchObject({ last: true });
      h.clip("ended");
      await expect(playing).resolves.toBe("ended");
    });

    it("a piece arriving while paused does not arm the clock", async () => {
      vi.useFakeTimers();
      const h = harness();
      const download = streamed();
      const playing = h.player.play(download.clip, live, { held: false });
      download.push(bytesOf(100));
      await vi.advanceTimersByTimeAsync(0);
      h.player.pause();
      download.push(bytesOf(100));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await settledState(playing)).toBe("pending");
    });

    it("says when the clip's sound starts", async () => {
      const h = harness();
      const onPlaying = vi.fn();
      const playing = h.player.play(new Blob([bytesOf(10)]), live, { held: false, onPlaying });
      await vi.waitFor(() => expect(h.plays()).toHaveLength(1));
      expect(onPlaying).not.toHaveBeenCalled();
      h.clip("playing");
      h.clip("progress");
      expect(onPlaying).toHaveBeenCalledTimes(1);
      h.clip("ended");
      await playing;
    });

    it("never trips for a clip that starts held, until resume()", async () => {
      vi.useFakeTimers();
      const h = harness();
      const playing = h.player.play(new Blob([bytesOf(10)]), live, { held: true });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await settledState(playing)).toBe("pending");
      expect(h.plays()[0]).toMatchObject({ paused: true });
      h.player.resume();
      expect(h.controls()).toEqual([{ session: "s1", action: "resume" }]);
      h.clip("playing");
      h.clip("ended");
      await expect(playing).resolves.toBe("ended");
    });
  });
});
