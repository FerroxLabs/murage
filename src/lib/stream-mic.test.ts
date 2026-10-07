import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// No speech model in node: frames take the loudness path, synchronously.
vi.mock("./silero-vad", () => ({ SileroVad: { load: async () => { throw new Error("no model in tests"); } } }));

import type { ServerMessage } from "../../shared/flux-stream-contract";
import { FluxMic, type FrameSource, type MicEnd, type MicLine } from "./call-mic";
import { CALL_ENDPOINT_LONG_MS } from "./call-turns";
import { STREAM_COMMIT, STREAM_CONTINUATION_HOLD_MS, StreamMic, acceptedPos } from "./stream-mic";

type OnFrame = (f: Float32Array, at?: number, capturedAt?: number) => void;

class ManualSource implements FrameSource {
  opened = false;
  private onFrame: OnFrame | null = null;
  private at = 0;
  async open(onFrame: OnFrame) {
    this.onFrame = onFrame;
    this.opened = true;
  }
  close() {
    this.opened = false;
  }
  push(level: number, n = 1) {
    for (let i = 0; i < n; i += 1) {
      this.at += 64;
      vi.advanceTimersByTime(64);
      this.onFrame?.(new Float32Array(1024).fill(level), this.at, Date.now());
    }
  }
  /** Frames captured over the last `levels.length` x 64 ms and delivered
   *  together now (a native batch), each with its own capture time, as
   *  NativeFrameSource stamps them. */
  pushBatch(levels: number[]) {
    const now = Date.now();
    levels.forEach((level, i) => {
      this.at += 64;
      this.onFrame?.(new Float32Array(1024).fill(level), this.at, now - (levels.length - 1 - i) * 64);
    });
  }
}

function fakeUplink() {
  const messages = new Set<(m: ServerMessage) => void>();
  // like StreamUplink: messages that arrive before anyone subscribes are held,
  // and the first subscription flushes them synchronously
  let held: ServerMessage[] = [];
  const closes = new Set<(c: { code: number; error: unknown }) => void>();
  const u = {
    live: true,
    refuse: false,
    dropped: 0,
    sends: 0,
    connect: vi.fn(async (): Promise<void> => undefined),
    send: vi.fn(() => {
      u.sends += 1;
      return u.live && !u.refuse;
    }),
    commit: vi.fn(),
    keepalive: vi.fn(),
    update: vi.fn(),
    close: vi.fn(),
    onMessage: (fn: (m: ServerMessage) => void) => {
      messages.add(fn);
      const flush = held;
      held = [];
      for (const m of flush) fn(m);
      return () => messages.delete(fn);
    },
    onClose: (fn: (c: { code: number; error: unknown }) => void) => (closes.add(fn), () => closes.delete(fn)),
    emit(m: Partial<ServerMessage> & { type: string }) {
      const msg = { seq: 1, received_audio_ms: 0, audio_start_ms: 0, audio_end_ms: 0, server_lag_ms: 0, ...m } as ServerMessage;
      if (!messages.size) held.push(msg);
      for (const fn of messages) fn(msg);
    },
    drop(code: number, error: unknown = null) {
      u.live = false;
      for (const fn of closes) fn({ code, error });
    },
  };
  return u;
}

/** Set per describe: CallView restarts the mic synchronously inside its end
 *  handler (listen() and openTurn() call start() there), so the hand-over tests
 *  also run that way. */
let syncRestart = false;

async function setup(options: { commit?: boolean; syncRestart?: boolean } = {}) {
  vi.useFakeTimers();
  const sync = options.syncRestart ?? syncRestart;
  const source = new ManualSource();
  const uplinks: Array<ReturnType<typeof fakeUplink>> = [];
  const mic = new StreamMic(
    source,
    () => {
      const u = fakeUplink();
      uplinks.push(u);
      return u as never;
    },
    { commit: options.commit },
  );
  const lines: MicLine[] = [];
  const ends: MicEnd[] = [];
  mic.onLine((l) => lines.push(l));
  mic.onEnd((e) => ends.push(e));
  if (sync) mic.onEnd(() => void mic.start({ endpointMs: 850 }));
  await mic.open();
  await vi.advanceTimersByTimeAsync(0); // the background connect resolves
  await mic.start({ endpointMs: 850 });
  /** CallView listening again after a line: an explicit start(), unless the
   *  end handler already restarted the mic. */
  const listen = async () => {
    if (!sync) await mic.start({ endpointMs: 850 });
  };
  return { source, uplink: () => uplinks.at(-1)!, uplinks, mic, lines, ends, listen, sync };
}
const finals = (lines: MicLine[]) => lines.filter((l) => l.partial === false);

afterEach(() => vi.useRealTimers());

describe("StreamMic", () => {
  it("tees every frame to the stream, listening or not", async () => {
    const { source, uplink, mic } = await setup();
    source.push(0, 5);
    await mic.stop();
    source.push(0, 5);
    expect(uplink().sends).toBe(10);
    expect(mic.transport()).toBe("stream");
  });

  it("emits partial lines, then one final line timed by Silero, not the provider", async () => {
    const { source, uplink, lines, ends, mic } = await setup();
    source.push(0.2, 10);
    const speechEnd = Date.now();
    source.push(0, 3);
    uplink().emit({ type: "speech.started", turn: 0, audio_ms: 0 });
    uplink().emit({ type: "transcript.partial", turn: 0, text: "What's the", audio_start_ms: 0, audio_end_ms: 400 });
    expect(mic.pending()).toBe(true);
    uplink().emit({ type: "turn.end", turn: 0, text: "What's the weather like?", reason: "endpoint", confidence: 1, audio_start_ms: 0, audio_end_ms: 99_999 });
    expect(lines.filter((l) => l.text !== "…").map((l) => [l.text, l.partial])).toEqual([["What's the", true], ["What's the weather like?", false]]);
    expect(finals(lines)[0].endedAt).toBe(speechEnd); // the last loud frame's wall time; the provider's 99 999 is ignored
    expect(ends).toEqual([{ code: 0, reason: "completed" }]);
    expect(mic.pending()).toBe(false);
  });

  it("keeps pending() true for the long endpoint (2.8 s) after a line ending in a comma or an ellipsis", async () => {
    const { source, uplink, mic } = await setup();
    source.push(0.2, 10);
    source.push(0, 2);
    uplink().emit({ type: "turn.end", turn: 0, text: "Blues Brothers,", reason: "endpoint", confidence: 1, audio_start_ms: 0, audio_end_ms: 640 });
    expect(mic.pending()).toBe(true);
    source.push(0, Math.ceil((STREAM_CONTINUATION_HOLD_MS - 200) / 64)); // still inside the window
    expect(mic.pending()).toBe(true);
    source.push(0, 8);
    expect(mic.pending()).toBe(false);
  });

  it("commits once when a partial ends in . ? or ! after 400 ms of silence, never on silence alone or an ellipsis (switch on)", async () => {
    const { source, uplink } = await setup({ commit: true });
    source.push(0.2, 10);
    uplink().emit({ type: "transcript.partial", turn: 0, text: "Tell me about it because..." });
    source.push(0, 10); // 640 ms of silence, but the partial ends in an ellipsis
    expect(uplink().commit).not.toHaveBeenCalled();
    source.push(0.2, 5);
    uplink().emit({ type: "transcript.partial", turn: 0, text: "Tell me about it because it's late." });
    source.push(0, 4); // 256 ms: not yet
    expect(uplink().commit).not.toHaveBeenCalled();
    source.push(0, 4); // 512 ms
    expect(uplink().commit).toHaveBeenCalledTimes(1);
    source.push(0, 10);
    expect(uplink().commit).toHaveBeenCalledTimes(1);
  });

  it("hands the turn in flight to FluxMic's recorder on a fault, from the Silero start less preroll", async () => {
    const { source, uplink, mic } = await setup();
    const adopt = vi.spyOn(mic as never as { adoptUtterance: (f: Int16Array[], j: unknown[]) => void }, "adoptUtterance");
    source.push(0, 20);
    source.push(0.2, 15); // speaking
    uplink().emit({ type: "speech.started", turn: 0, audio_ms: 0 });
    uplink().drop(4502);
    expect(mic.transport()).toBe("batch");
    expect(adopt).toHaveBeenCalledTimes(1);
    const frames = adopt.mock.calls[0][0];
    // the voice gate opens after ~6 loud frames; the clip reaches back 384 ms (6 frames) before that
    expect(frames.length).toBeGreaterThanOrEqual(15);
    expect(frames.length).toBeLessThanOrEqual(21);
  });

  it("goes to batch for the call on a plan refusal, adopting only a turn in flight", async () => {
    const { uplink, mic } = await setup();
    const adopt = vi.spyOn(mic as never as { adoptUtterance: () => void }, "adoptUtterance");
    uplink().drop(4402);
    expect(mic.transport()).toBe("batch");
    expect(adopt).not.toHaveBeenCalled();
  });

  it("drops the line of a turn muted mid-way, and keeps the stream alive with keepalive", async () => {
    const { source, uplink, mic, lines } = await setup();
    source.push(0.2, 10);
    uplink().emit({ type: "speech.started", turn: 0, audio_ms: 0 });
    mic.setMuted(true);
    expect(uplink().commit).toHaveBeenCalledTimes(1);
    uplink().emit({ type: "turn.end", turn: 0, text: "half a thought", reason: "forced", confidence: null });
    expect(finals(lines)).toEqual([]);
    // nothing is sent while muted: a keepalive goes out once 10 s have passed
    // since the last frame (checked every 2 s, so by 12 s)
    vi.advanceTimersByTime(9_000);
    expect(uplink().keepalive).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3_000);
    expect(uplink().keepalive).toHaveBeenCalled();
  });

  it("ignores the old stream's close after a rollover", async () => {
    const { source, uplink, uplinks, mic } = await setup();
    uplink().emit({ type: "session.expiring", closes_in_ms: 30_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(uplinks).toHaveLength(2);
    source.push(0, 10); // silence: the tee switches
    const [old] = uplinks;
    expect(old.close).toHaveBeenCalled();
    old.drop(1000);
    expect(mic.transport()).toBe("stream");
  });

  it("closes a connect that resolves after hang-up", async () => {
    vi.useFakeTimers();
    let resolveConnect: () => void = () => {};
    const u = fakeUplink();
    u.connect = vi.fn(() => new Promise<void>((r) => (resolveConnect = r)));
    const mic = new StreamMic(new ManualSource(), () => u as never);
    await mic.open();
    mic.close();
    resolveConnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(u.close).toHaveBeenCalled();
  });

  it("delivers a line that ended while not listening at the next start", async () => {
    const { source, uplink, mic, lines } = await setup();
    source.push(0.2, 5);
    await mic.stop();
    uplink().emit({ type: "turn.end", turn: 0, text: "and one more thing.", reason: "endpoint", confidence: 1 });
    expect(finals(lines)).toEqual([]);
    await mic.start({ endpointMs: 850 });
    await vi.advanceTimersByTimeAsync(0);
    expect(finals(lines).map((l) => l.text)).toEqual(["and one more thing."]);
  });
  it("keeps each utterance's own speech end when its turn ends while the next is underway", async () => {
    const { source, uplink, mic, lines } = await setup();
    source.push(0.2, 10); // utterance 1
    const firstEnd = Date.now();
    source.push(0, 10); // the gate closes (8 quiet frames)
    source.push(0.2, 10); // utterance 2 is underway
    uplink().emit({ type: "turn.end", turn: 0, text: "Tell me a joke.", reason: "endpoint", confidence: 1, audio_start_ms: 0, audio_end_ms: 640 });
    expect(finals(lines)[0].endedAt).toBe(firstEnd); // not utterance 2's
    expect(mic.pending()).toBe(true); // utterance 2 is still owed a line
  });

  it("delivers lines after a fault, a batch sentence and a reconnect", async () => {
    const { source, uplink, uplinks, mic, lines } = await setup();
    uplink().drop(4502);
    expect(mic.transport()).toBe("batch");
    source.push(0, 20); // quiet: the reconnect is tried at a silence boundary
    await vi.advanceTimersByTimeAsync(1_100);
    expect(uplinks).toHaveLength(2);
    expect(mic.transport()).toBe("stream");
    await mic.start({ endpointMs: 850 });
    uplink().emit({ type: "turn.end", turn: 0, text: "First after the fault.", reason: "endpoint", confidence: 1 });
    await mic.start({ endpointMs: 850 });
    uplink().emit({ type: "turn.end", turn: 1, text: "And a second.", reason: "endpoint", confidence: 1 });
    expect(finals(lines).map((l) => l.text)).toEqual(["First after the fault.", "And a second."]);
  });

  it("closes a replacement stream that connects after a hold began", async () => {
    vi.useFakeTimers();
    const made: Array<ReturnType<typeof fakeUplink>> = [];
    let finishSecond: () => void = () => {};
    const mic = new StreamMic(new ManualSource(), () => {
      const u = fakeUplink();
      if (made.length === 1) u.connect = vi.fn(() => new Promise<void>((r) => (finishSecond = r)));
      made.push(u);
      return u as never;
    });
    await mic.open();
    await vi.advanceTimersByTimeAsync(0);
    made[0].emit({ type: "session.expiring", closes_in_ms: 30_000 });
    mic.suspend();
    finishSecond();
    await vi.advanceTimersByTimeAsync(0);
    expect(made[0].close).toHaveBeenCalled();
    expect(made[1].close).toHaveBeenCalled();
  });

  it("stops reconnecting after two faults", async () => {
    const { source, uplinks, mic } = await setup();
    uplinks[0].drop(4502);
    source.push(0, 20);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(uplinks).toHaveLength(2);
    uplinks[1].drop(4504);
    source.push(0, 20);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(uplinks).toHaveLength(2);
    expect(mic.transport()).toBe("batch");
  });

  // ── Astra confirming pass 2 ──
  it("matches each turn.end to the utterances it covers on the server's clock (I5)", async () => {
    const { source, uplink, mic, lines } = await setup();
    source.push(0.2, 8); // utterance 1: stream audio 0 to 512 ms
    const firstEnd = Date.now();
    source.push(0, 10); // the gate closes
    source.push(0.2, 8); // utterance 2 begins at about 1150 ms of stream audio
    const secondEnd = Date.now();
    source.push(0, 10);
    uplink().emit({ type: "turn.end", turn: 0, text: "One.", reason: "endpoint", confidence: 1, audio_start_ms: 0, audio_end_ms: 500 });
    expect(finals(lines).map((l) => l.endedAt)).toEqual([firstEnd]); // not 1000-ish: utterance 2 is not taken
    await mic.start({ endpointMs: 850 });
    uplink().emit({ type: "turn.end", turn: 1, text: "Two.", reason: "endpoint", confidence: 1, audio_start_ms: 1150, audio_end_ms: 1600 });
    expect(finals(lines).map((l) => l.endedAt)).toEqual([firstEnd, secondEnd]);
  });

  it("never lets a draining stream's end take the replacement's utterance (I5)", async () => {
    const { source, uplink, uplinks, lines } = await setup();
    uplink().emit({ type: "session.expiring", closes_in_ms: 30_000 });
    await vi.advanceTimersByTimeAsync(0);
    source.push(0, 10); // silence: the tee switches to the replacement
    const [old, next] = uplinks;
    source.push(0.2, 8); // said on the replacement
    old.emit({ type: "turn.end", turn: 3, text: "late from the old stream.", reason: "endpoint", confidence: 1, audio_end_ms: 99_999 });
    const line = finals(lines).at(-1)!;
    expect(line.text).toBe("late from the old stream.");
    source.push(0, 10);
    next.emit({ type: "turn.end", turn: 0, text: "On the new one.", reason: "endpoint", confidence: 1, audio_end_ms: 600 });
    expect(finals(lines).length).toBe(1); // queued: not listening since the last line
  });

  it("keeps each frame's own capture time when frames arrive together, never a time after delivery (I5, Astra 3 I3)", async () => {
    const { source, uplink, lines } = await setup();
    const t0 = Date.now();
    vi.advanceTimersByTime(18 * 64); // captured over 1152 ms, delivered at once
    source.pushBatch([...Array(8).fill(0.2), ...Array(10).fill(0)]);
    uplink().emit({ type: "turn.end", turn: 0, text: "Batched.", reason: "endpoint", confidence: 1, audio_end_ms: 600 });
    expect(finals(lines)[0].endedAt).toBe(t0 + 8 * 64); // the last loud frame's capture
    expect(finals(lines)[0].endedAt!).toBeLessThanOrEqual(Date.now());
  });

  it("delivers messages an uplink held before the mic subscribed (I6)", async () => {
    vi.useFakeTimers();
    const u = fakeUplink();
    u.emit({ type: "transcript.partial", turn: 0, text: "held" });
    u.emit({ type: "turn.end", turn: 0, text: "Held until attach.", reason: "endpoint", confidence: 1 });
    const mic = new StreamMic(new ManualSource(), () => u as never);
    const lines: MicLine[] = [];
    mic.onLine((l) => lines.push(l));
    await mic.start({ endpointMs: 850 });
    await mic.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(finals(lines).map((l) => l.text)).toEqual(["Held until attach."]);
  });

  it("drops audio muted while the stream was still connecting, so it is never sent later (I7)", async () => {
    vi.useFakeTimers();
    let finish: () => void = () => {};
    const u = fakeUplink();
    u.connect = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const source = new ManualSource();
    const mic = new StreamMic(source, () => u as never);
    await mic.open();
    source.push(0.2, 10); // speech waits in the start queue
    mic.setMuted(true);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(u.sends).toBe(0);
  });

  it("cancels a connect still opening when the call goes on hold (I8)", async () => {
    vi.useFakeTimers();
    const u = fakeUplink();
    u.connect = vi.fn(() => new Promise<void>(() => {})); // never resolves on its own
    const mic = new StreamMic(new ManualSource(), () => u as never);
    await mic.open();
    mic.suspend();
    expect(u.close).toHaveBeenCalled(); // not left to resolve some time later
  });

  // ── Controller amendments ──
  it("holds the line for CALL_ENDPOINT_LONG_MS, after any line soundsUnfinished says will go on", async () => {
    expect(STREAM_CONTINUATION_HOLD_MS).toBe(CALL_ENDPOINT_LONG_MS);
    expect(STREAM_CONTINUATION_HOLD_MS).toBe(2_800);
    const { source, uplink, mic } = await setup();
    source.push(0.2, 10);
    source.push(0, 2);
    uplink().emit({ type: "turn.end", turn: 0, text: "I was thinking about the", reason: "endpoint", confidence: 1, audio_start_ms: 0, audio_end_ms: 640 });
    source.push(0, Math.ceil((STREAM_CONTINUATION_HOLD_MS - 200) / 64));
    expect(mic.pending()).toBe(true);
    source.push(0, 8);
    expect(mic.pending()).toBe(false);
  });

  it("does not hold after a finished sentence", async () => {
    const { source, uplink, mic } = await setup();
    source.push(0.2, 10);
    source.push(0, 2);
    uplink().emit({ type: "turn.end", turn: 0, text: "That is all.", reason: "endpoint", confidence: 1, audio_start_ms: 0, audio_end_ms: 640 });
    expect(mic.pending()).toBe(false);
  });

  it("ships with the punctuation commit off: the default never sends turn.commit", async () => {
    expect(STREAM_COMMIT).toBe(false);
    const { source, uplink } = await setup();
    source.push(0.2, 10);
    uplink().emit({ type: "transcript.partial", turn: 0, text: "Tell me about it because it's late." });
    source.push(0, 20);
    expect(uplink().commit).not.toHaveBeenCalled();
  });

  it("passes start options through (Track C's signature)", async () => {
    const { mic } = await setup();
    await mic.start({ endpointMs: 1500, endpointLongMs: 2800, hints: ["Murage"] });
    expect(mic.transport()).toBe("stream");
  });

  it("at connect, a 429 stays batch for the call", async () => {
    vi.useFakeTimers();
    const made: Array<ReturnType<typeof fakeUplink>> = [];
    const source = new ManualSource();
    const mic = new StreamMic(source, () => {
      const u = fakeUplink();
      u.connect = vi.fn(async () => {
        throw Object.assign(new Error("refused"), { status: 429, reason: "rate_limit_error", retryAfterMs: 2000 });
      });
      made.push(u);
      return u as never;
    });
    await mic.open();
    await vi.advanceTimersByTimeAsync(0);
    source.push(0, 20);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(made.length).toBe(1);
    expect(mic.transport()).toBe("batch");
  });

  it("rolls over on an unrequested session.closed max_duration the expiring notice did not announce", async () => {
    const { source, uplink, uplinks, mic } = await setup();
    uplink().emit({ type: "session.closed", reason: "max_duration", usage: {} as never });
    await vi.advanceTimersByTimeAsync(0);
    expect(uplinks).toHaveLength(2); // a replacement was connected
    uplinks[0].drop(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(mic.transport()).toBe("stream");
    source.push(0, 10);
    expect(uplinks[1].sends).toBeGreaterThan(0); // frames flow to the replacement
  });

  it("does not treat a session.closed with another reason as a rollover", async () => {
    const { uplink, uplinks } = await setup();
    uplink().emit({ type: "session.closed", reason: "going_away", usage: {} as never });
    await vi.advanceTimersByTimeAsync(0);
    expect(uplinks).toHaveLength(1);
  });

  // ── Astra confirming pass 3 ──
  it("owns an utterance by its first SENT frame when its onset was refused (Astra 3 I2)", async () => {
    const { source, uplink, lines } = await setup();
    const u = uplink();
    u.live = false; // the onset (the voice gate opens about 6 loud frames in) is refused: kept in the ring, unsent
    source.push(0.2, 8);
    u.live = true;
    source.push(0.2, 4); // the rest of utterance 1 is sent from position 0
    const firstEnd = Date.now();
    source.push(0, 10);
    source.push(0.2, 8); // utterance 2, sent from position 960
    source.push(0, 10);
    u.emit({ type: "turn.end", turn: 0, text: "One.", reason: "endpoint", confidence: 1, audio_start_ms: 0, audio_end_ms: 500 });
    expect(finals(lines).map((l) => l.endedAt)).toEqual([firstEnd]); // not utterance 2's end
  });

  it("scopes a cancellation to its own stream (Astra 3 I2)", async () => {
    const { source, uplink, uplinks, mic } = await setup();
    uplink().emit({ type: "session.expiring", closes_in_ms: 30_000 });
    await vi.advanceTimersByTimeAsync(0);
    source.push(0, 10); // the tee switches to the replacement
    const [old] = uplinks;
    source.push(0.2, 8); // said on the replacement, and ended
    source.push(0, 10);
    old.emit({ type: "turn.cancelled", turn: 3 });
    expect(mic.pending()).toBe(true); // the replacement's utterance is still owed its line
  });

  it("continues an utterance the provider ended mid-speech, timing the next turn from there (Astra 3 I2)", async () => {
    const { source, uplink, mic, lines } = await setup();
    source.push(0.2, 8);
    uplink().emit({ type: "turn.end", turn: 0, text: "First part.", reason: "endpoint", confidence: 1, audio_end_ms: 400 });
    source.push(0.2, 8); // still speaking
    const secondEnd = Date.now();
    source.push(0, 10);
    expect(mic.pending()).toBe(true);
    await mic.start({ endpointMs: 850 });
    uplink().emit({ type: "turn.end", turn: 1, text: "Second part.", reason: "endpoint", confidence: 1, audio_end_ms: 1000 });
    expect(finals(lines).map((l) => l.endedAt).at(-1)).toBe(secondEnd);
  });

  it("an empty commit after a mute retires the discard, so the next turn 0 is delivered (Astra 3 I4)", async () => {
    const { source, uplink, mic, lines } = await setup();
    source.push(0.2, 8); // sent; the provider has opened no turn yet
    mic.setMuted(true);
    expect(uplink().commit).toHaveBeenCalledTimes(1);
    uplink().emit({ type: "turn.committed", turn: null });
    mic.setMuted(false);
    source.push(0, 4);
    source.push(0.2, 8);
    source.push(0, 10);
    uplink().emit({ type: "turn.end", turn: 0, text: "After the mute.", reason: "endpoint", confidence: 1, audio_start_ms: 800, audio_end_ms: 1200 });
    expect(finals(lines).map((l) => l.text)).toEqual(["After the mute."]);
  });

  it("drops the muted turn by position when the provider does answer it (Astra 3 I4)", async () => {
    const { source, uplink, mic, lines } = await setup();
    source.push(0.2, 8);
    mic.setMuted(true);
    uplink().emit({ type: "turn.end", turn: 0, text: "half a thought", reason: "forced", confidence: null, audio_start_ms: 0, audio_end_ms: 500 });
    mic.setMuted(false);
    source.push(0, 4);
    source.push(0.2, 8);
    source.push(0, 10);
    uplink().emit({ type: "turn.end", turn: 1, text: "The real one.", reason: "endpoint", confidence: 1, audio_start_ms: 800, audio_end_ms: 1200 });
    expect(finals(lines).map((l) => l.text)).toEqual(["The real one."]);
  });

  it("maps sent positions through each separate dropped range (Astra 3 I9)", () => {
    // sent 100-200 dropped, 200-300 accepted, 300-400 dropped: two ranges, at 100 and 200 on the accepted clock
    const drops = [{ at: 100, ms: 100 }, { at: 200, ms: 100 }];
    expect(acceptedPos(50, drops)).toBe(50);
    expect(acceptedPos(150, drops)).toBe(100); // inside the first gap: never reached the provider
    expect(acceptedPos(250, drops)).toBe(150); // between the gaps
    expect(acceptedPos(350, drops)).toBe(200); // inside the second
    expect(acceptedPos(450, drops)).toBe(250);
  });
});

// ── Fix round 1 ──
for (const sync of [false, true]) describe(`StreamMic fix round 1${sync ? " (CallView restarts the mic in its end handler)" : ""}`, () => {
  beforeEach(() => {
    syncRestart = sync;
  });
  afterEach(() => {
    syncRestart = false;
  });
  const stubFetch = () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ text: "batch words" }) }));
    vi.stubGlobal("fetch", f);
    return f;
  };
  afterEach(() => vi.unstubAllGlobals());
  const spyAdopt = (mic: unknown) => vi.spyOn(mic as { adoptUtterance: (f: Int16Array[], j: unknown[]) => void }, "adoptUtterance");
  const capErr = { code: "service_unavailable", type: "api_error", message: "busy", fatal: true, close_code: 4503, retry_after_ms: 3000 };

  it("1: a fault closes the rollover replacement and never attaches it", async () => {
    const { source, uplinks, mic } = await setup();
    uplinks[0].emit({ type: "session.expiring", closes_in_ms: 30_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(uplinks).toHaveLength(2);
    uplinks[0].drop(4502);
    expect(uplinks[1].close).toHaveBeenCalled();
    source.push(0, 20);
    await vi.advanceTimersByTimeAsync(1_100);
    source.push(0, 10);
    expect(uplinks[1].sends).toBe(0);
    expect(mic.transport()).toBe("stream");
  });

  it("1: a replacement that died before the switch is never attached", async () => {
    const { source, uplinks, mic } = await setup();
    uplinks[0].emit({ type: "session.expiring", closes_in_ms: 30_000 });
    await vi.advanceTimersByTimeAsync(0);
    uplinks[1].live = false;
    const before = uplinks[0].sends;
    source.push(0, 10);
    source.push(0, 5);
    expect(uplinks[1].close).toHaveBeenCalled();
    expect(uplinks[0].sends).toBe(before + 15);
    expect(mic.transport()).toBe("stream");
  });

  it("2: max_duration closed then 1000 opens one replacement, not two", async () => {
    const { source, uplinks, mic } = await setup();
    uplinks[0].emit({ type: "session.closed", reason: "max_duration", usage: {} as never });
    uplinks[0].drop(1000); // before the rollover connect resolves
    await vi.advanceTimersByTimeAsync(0);
    expect(uplinks).toHaveLength(2);
    expect(mic.transport()).toBe("stream");
    source.push(0, 5);
    expect(uplinks[1].sends).toBe(5);
  });

  it("2: a reconnect refused after 1000 is retried at a silence boundary, not batch for the call", async () => {
    vi.useFakeTimers();
    const made: Array<ReturnType<typeof fakeUplink>> = [];
    const source = new ManualSource();
    const mic = new StreamMic(source, () => {
      const u = fakeUplink();
      if (made.length === 1) u.connect = vi.fn(async () => { throw Object.assign(new Error("busy"), { status: 409, reason: "busy", retryAfterMs: null }); });
      made.push(u);
      return u as never;
    });
    await mic.open();
    await vi.advanceTimersByTimeAsync(0);
    await mic.start({ endpointMs: 850 });
    made[0].drop(1001);
    await vi.advanceTimersByTimeAsync(0);
    source.push(0, 20);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(made.length).toBeGreaterThanOrEqual(3);
    expect(mic.transport()).toBe("stream");
  });

  it("3: a 4503 after connect hands the turn over once, is one fault, and waits retry_after_ms", async () => {
    const { source, uplink, uplinks, mic } = await setup();
    const adopt = spyAdopt(mic);
    source.push(0.2, 10);
    uplink().emit({ type: "error", error: capErr } as never);
    uplink().drop(4503, capErr);
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(mic.transport()).toBe("batch");
    source.push(0, 20);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(uplinks).toHaveLength(1); // not before 3000 ms
    await vi.advanceTimersByTimeAsync(1_000);
    expect(uplinks).toHaveLength(2);
    expect(mic.transport()).toBe("stream");
  });

  it("4: a consumed utterance is not handed to batch again on a fault", async () => {
    const { source, uplink, mic, lines } = await setup();
    const adopt = spyAdopt(mic);
    source.push(0.2, 8);
    uplink().emit({ type: "turn.end", turn: 0, text: "Said already.", reason: "endpoint", confidence: 1, audio_end_ms: 400 });
    expect(finals(lines)).toHaveLength(1);
    uplink().drop(4502);
    expect(adopt).not.toHaveBeenCalled();
  });

  it("5: a draining stream's late turn.end after the new stream faults emits no duplicate", async () => {
    const { source, uplinks, mic, lines } = await setup();
    const adopt = spyAdopt(mic);
    source.push(0.2, 8); // owned by the old stream
    uplinks[0].emit({ type: "session.expiring", closes_in_ms: 30_000 });
    await vi.advanceTimersByTimeAsync(0);
    source.push(0, 12); // the tee switches; the old one drains
    uplinks[1].drop(4502);
    expect(adopt).toHaveBeenCalledTimes(1);
    uplinks[0].emit({ type: "turn.end", turn: 0, text: "late from the old one.", reason: "endpoint", confidence: 1, audio_end_ms: 500 });
    expect(finals(lines)).toEqual([]);
    expect(mic.transport()).toBe("batch");
  });

  it("6: a draining stream that closes before its turn.end hands its sentence to batch", async () => {
    const { source, uplinks, mic } = await setup();
    const adopt = spyAdopt(mic);
    source.push(0.2, 8); // owned by the old stream
    uplinks[0].emit({ type: "session.expiring", closes_in_ms: 30_000 });
    await vi.advanceTimersByTimeAsync(0);
    source.push(0, 12); // the tee switches, the old one drains
    expect(adopt).not.toHaveBeenCalled();
    uplinks[0].drop(1006);
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(mic.pending()).toBe(true);
  });

  it("6: a live 1000 that arrives without the flush hands its unlined sentence to batch", async () => {
    const { source, uplink, mic } = await setup();
    const adopt = spyAdopt(mic);
    source.push(0.2, 8);
    source.push(0, 10);
    uplink().drop(1000);
    expect(adopt).toHaveBeenCalledTimes(1);
  });

  it("7: batch-mode speech leaves nothing pending after a reconnect", async () => {
    const { source, uplinks, mic } = await setup();
    stubFetch();
    uplinks[0].drop(4502);
    source.push(0.2, 10);
    source.push(0, 15);
    await vi.advanceTimersByTimeAsync(0);
    source.push(0, 10);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(uplinks).toHaveLength(2);
    expect(mic.pending()).toBe(false);
  });

  it("8: speech refused under backpressure goes to batch and the provider's turn emits nothing", async () => {
    const { source, uplink, mic, lines } = await setup();
    const adopt = spyAdopt(mic);
    source.push(0.2, 5); // the preroll reaches the provider
    uplink().refuse = true;
    source.push(0.2, 5); // the voice gate opens here, and the stream refuses it
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(uplink().commit).toHaveBeenCalled(); // the provider is told to end what it heard
    uplink().refuse = false;
    source.push(0.2, 3);
    source.push(0, 12);
    uplink().emit({ type: "turn.end", turn: 0, text: "partial of it", reason: "forced", confidence: null, audio_start_ms: 0, audio_end_ms: 300 });
    expect(finals(lines)).toEqual([]);
    expect(adopt).toHaveBeenCalledTimes(1);
  });

  it("8: speech that overflows the start queue goes to batch", async () => {
    vi.useFakeTimers();
    const u = fakeUplink();
    u.connect = vi.fn(() => new Promise<void>(() => {}));
    const source = new ManualSource();
    const mic = new StreamMic(source, () => u as never);
    await mic.open();
    await mic.start({ endpointMs: 850 });
    const adopt = spyAdopt(mic);
    source.push(0.2, 60);
    expect(adopt).toHaveBeenCalled();
  });

  it("m1: a hold during a reconnect after 1000 keeps the stream for resume", async () => {
    vi.useFakeTimers();
    const made: Array<ReturnType<typeof fakeUplink>> = [];
    let fail: (e: unknown) => void = () => {};
    const mic = new StreamMic(new ManualSource(), () => {
      const u = fakeUplink();
      if (made.length === 1) u.connect = vi.fn(() => new Promise<void>((_, rej) => (fail = rej)));
      made.push(u);
      return u as never;
    });
    await mic.open();
    await vi.advanceTimersByTimeAsync(0);
    made[0].drop(1000);
    mic.suspend();
    fail(new Error("cancelled"));
    await vi.advanceTimersByTimeAsync(0);
    expect(mic.transport()).toBe("stream");
    await mic.resume();
    expect(made).toHaveLength(3);
    expect(mic.transport()).toBe("stream");
  });

  it("I2: a resume refused 429 busy goes to batch, then back to stream after the retry (not stayBatch)", async () => {
    vi.useFakeTimers();
    const made: Array<ReturnType<typeof fakeUplink>> = [];
    const mic = new StreamMic(new ManualSource(), () => {
      const u = fakeUplink();
      if (made.length === 1) {
        u.connect = vi.fn(async () => {
          throw Object.assign(new Error("busy"), { status: 429, reason: "busy", retryAfterMs: 1000 });
        });
      }
      made.push(u);
      return u as never;
    });
    await mic.open();
    await vi.advanceTimersByTimeAsync(0);
    mic.suspend();
    await mic.resume();
    expect(mic.transport()).toBe("batch");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(made).toHaveLength(3);
    expect(mic.transport()).toBe("stream");
  });

  it("rapid hold, resume, hold, resume: a stale connect result never forces batch", async () => {
    vi.useFakeTimers();
    const made: Array<ReturnType<typeof fakeUplink>> = [];
    const settle: Array<(v: void) => void> = [];
    const mic = new StreamMic(new ManualSource(), () => {
      const u = fakeUplink();
      if (made.length >= 1) u.connect = vi.fn(() => new Promise<void>((res) => settle.push(res)));
      made.push(u);
      return u as never;
    });
    await mic.open();
    await vi.advanceTimersByTimeAsync(0);
    mic.suspend();
    const first = mic.resume();
    mic.suspend();
    const second = mic.resume();
    // the first resume's connect is cancelled by the second hold: it resolves stale
    made[1].connect = vi.fn(async () => {
      throw new Error("cancelled");
    });
    settle[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    await first;
    expect(mic.transport()).toBe("stream");
    settle[1]?.();
    await vi.advanceTimersByTimeAsync(0);
    await second;
    expect(mic.transport()).toBe("stream");
  });

  it("hold, close, resume opens no uplink", async () => {
    vi.useFakeTimers();
    const made: Array<ReturnType<typeof fakeUplink>> = [];
    const mic = new StreamMic(new ManualSource(), () => {
      const u = fakeUplink();
      made.push(u);
      return u as never;
    });
    await mic.open();
    await vi.advanceTimersByTimeAsync(0);
    const before = made.length;
    mic.suspend();
    mic.close();
    await mic.resume();
    expect(made).toHaveLength(before);
  });

  it("m2: a hold while a fault reconnect is scheduled still reconnects on resume", async () => {
    const { source, uplinks, mic } = await setup();
    uplinks[0].drop(4502);
    mic.suspend();
    await mic.resume();
    source.push(0, 20);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(uplinks).toHaveLength(2);
    expect(mic.transport()).toBe("stream");
  });

  it("m3: a batch sentence from a fault between lines waits for the next start()", async () => {
    const f = stubFetch();
    const { source, uplink, lines, listen } = await setup();
    source.push(0.2, 8);
    uplink().emit({ type: "turn.end", turn: 0, text: "First.", reason: "endpoint", confidence: 1, audio_end_ms: 400 });
    source.push(0, 10);
    source.push(0.2, 8); // not listening: said between lines
    uplink().drop(4502);
    source.push(0, 15);
    await vi.advanceTimersByTimeAsync(0);
    if (!sync) {
      // waiting for start(): CallView restarting in its end handler starts it already
      expect(f).not.toHaveBeenCalled();
      expect(finals(lines).map((l) => l.text)).toEqual(["First."]);
    }
    await listen();
    await vi.advanceTimersByTimeAsync(0);
    expect(finals(lines).map((l) => l.text)).toEqual(["First.", "batch words"]);
  });
});

// ── Fix round 2 (the reviewer's probes P1 to P5, and the follow-ups) ──
for (const sync of [false, true]) describe(`StreamMic fix round 2${sync ? " (CallView restarts the mic in its end handler)" : ""}`, () => {
  beforeEach(() => {
    syncRestart = sync;
  });
  afterEach(() => {
    syncRestart = false;
  });
  const stubFetch = (text = "batch words") => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ text }) }));
    vi.stubGlobal("fetch", f);
    return f;
  };
  afterEach(() => vi.unstubAllGlobals());
  const spyAdopt = (mic: unknown) => vi.spyOn(mic as { adoptUtterance: (f: Int16Array[], j: unknown[]) => void }, "adoptUtterance");
  const texts = (lines: MicLine[]) => finals(lines).map((l) => l.text);

  it("P1/B1: every provider turn over handed-over audio is discarded, not just the first", async () => {
    stubFetch();
    const { source, uplink, mic, lines, listen } = await setup();
    const adopt = spyAdopt(mic);
    source.push(0.2, 8); // utterance A
    source.push(0, 6);
    source.push(0.2, 3);
    uplink().refuse = true;
    source.push(0.2, 1); // a refused frame: hand-over
    uplink().refuse = false;
    expect(adopt).toHaveBeenCalledTimes(1);
    source.push(0.2, 3);
    source.push(0, 20);
    uplink().emit({ type: "turn.end", turn: 0, text: "Sentence A.", reason: "endpoint", confidence: 1, audio_start_ms: 0, audio_end_ms: 500 });
    uplink().emit({ type: "turn.end", turn: 1, text: "Start of B", reason: "forced", confidence: null, audio_start_ms: 900, audio_end_ms: 1100 });
    await vi.advanceTimersByTimeAsync(10);
    await listen();
    await vi.advanceTimersByTimeAsync(10);
    expect(texts(lines)).not.toContain("Sentence A.");
    expect(texts(lines)).not.toContain("Start of B");
  });

  it("B1: a hand-over does not overwrite a mute's discard", async () => {
    const { source, uplink, mic, lines } = await setup();
    source.push(0.2, 8);
    mic.setMuted(true); // discard: 0 to 512 ms
    mic.setMuted(false);
    source.push(0, 4);
    source.push(0.2, 8);
    uplink().refuse = true;
    source.push(0.2, 1); // hand-over of the second
    uplink().refuse = false;
    source.push(0, 10);
    uplink().emit({ type: "turn.end", turn: 0, text: "muted one", reason: "forced", confidence: null, audio_start_ms: 0, audio_end_ms: 500 });
    uplink().emit({ type: "turn.end", turn: 1, text: "handed one", reason: "forced", confidence: null, audio_start_ms: 800, audio_end_ms: 1200 });
    expect(finals(lines)).toEqual([]);
  });

  it("P2/B2: a draining close hands over only its own utterance, and the new stream's keeps its line", async () => {
    stubFetch();
    const { source, uplinks, mic, lines, listen } = await setup();
    const adopt = spyAdopt(mic);
    source.push(0.2, 8); // A on the old stream
    uplinks[0].emit({ type: "session.expiring", closes_in_ms: 30_000 });
    await vi.advanceTimersByTimeAsync(0);
    source.push(0, 12);
    source.push(0.2, 6); // B on the new stream
    uplinks[0].drop(1006);
    expect(adopt).toHaveBeenCalledTimes(1);
    const frames = adopt.mock.calls[0][0].length;
    expect(frames).toBeGreaterThanOrEqual(15);
    expect(frames).toBeLessThanOrEqual(21); // A and the silence after it, not B
    expect(uplinks[1].commit).not.toHaveBeenCalled();
    source.push(0.2, 4);
    source.push(0, 20);
    uplinks[1].emit({ type: "turn.end", turn: 0, text: "Sentence B.", reason: "endpoint", confidence: 1, audio_start_ms: 0, audio_end_ms: 300 });
    await vi.advanceTimersByTimeAsync(10);
    // fix round 4 (O1): A was said first, so its batch line goes out first
    if (!sync) expect(texts(lines)).toEqual(["batch words"]); // B waits for start()
    await listen();
    await vi.advanceTimersByTimeAsync(10);
    expect(texts(lines)).toEqual(["batch words", "Sentence B."]);
  });

  it("P3/m3: a queued stream line and a between-lines hand-over reach CallView one per start()", async () => {
    stubFetch("batch C");
    const { source, uplink, lines, ends, listen } = await setup();
    source.push(0.2, 8);
    uplink().emit({ type: "turn.end", turn: 0, text: "A.", reason: "endpoint", confidence: 1, audio_end_ms: 400 });
    source.push(0, 10);
    source.push(0.2, 8);
    uplink().emit({ type: "turn.end", turn: 1, text: "B.", reason: "endpoint", confidence: 1, audio_start_ms: 900, audio_end_ms: 1400 });
    source.push(0, 10);
    source.push(0.2, 8);
    uplink().drop(4502);
    source.push(0, 15);
    await vi.advanceTimersByTimeAsync(0);
    if (!sync) expect(texts(lines)).toEqual(["A."]); // one per start()
    await listen();
    await vi.advanceTimersByTimeAsync(10);
    if (!sync) {
      expect(texts(lines)).toEqual(["A.", "B."]);
      expect(ends).toHaveLength(2);
    }
    await listen();
    await vi.advanceTimersByTimeAsync(10);
    expect(texts(lines)).toEqual(["A.", "B.", "batch C"]);
    expect(ends).toHaveLength(3);
  });

  it("P4/item 8: onset frames refused before the voice gate opens hand the utterance to batch", async () => {
    const { source, uplink, mic } = await setup();
    const adopt = spyAdopt(mic);
    uplink().refuse = true;
    for (let i = 0; i < 10; i += 1) {
      source.push(0.2, 1);
      if (i === 3) uplink().refuse = false;
    }
    source.push(0, 20);
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(uplink().commit).toHaveBeenCalled();
  });

  it("P5/B3: after a stream-mode hand-over's batch line, the next stream line waits for start()", async () => {
    stubFetch("batch B");
    const { source, uplink, lines, ends, listen } = await setup();
    source.push(0.2, 5);
    uplink().refuse = true;
    source.push(0.2, 5);
    uplink().refuse = false;
    source.push(0.2, 3);
    source.push(0, 20);
    await vi.advanceTimersByTimeAsync(10);
    expect(texts(lines)).toEqual(["batch B"]);
    expect(ends).toHaveLength(1);
    uplink().emit({ type: "turn.end", turn: 0, text: "forced part", reason: "forced", confidence: null, audio_start_ms: 0, audio_end_ms: 300 });
    source.push(0.2, 8);
    source.push(0, 10);
    uplink().emit({ type: "turn.end", turn: 1, text: "Sentence C.", reason: "endpoint", confidence: 1, audio_start_ms: 2000, audio_end_ms: 2500 });
    if (!sync) {
      expect(texts(lines)).toEqual(["batch B"]); // not before a start()
      expect(ends).toHaveLength(1);
    }
    await listen();
    await vi.advanceTimersByTimeAsync(10);
    expect(texts(lines)).toEqual(["batch B", "Sentence C."]);
  });

  it("a late provider turn for an utterance dropStale removed is not swallowed by a later hand-over", async () => {
    const { source, uplink, lines } = await setup();
    source.push(0.2, 8); // D
    source.push(0, 60); // 3.8 s of quiet: dropStale forgets D
    source.push(0.2, 5);
    uplink().refuse = true;
    source.push(0.2, 5); // E is handed over
    uplink().refuse = false;
    uplink().emit({ type: "turn.end", turn: 0, text: "Late D.", reason: "endpoint", confidence: 1, audio_start_ms: 0, audio_end_ms: 500 });
    expect(texts(lines)).toEqual(["Late D."]);
  });

  it("a rollover replacement refused with 4503 carries its retry_after to the reconnect", async () => {
    const { source, uplinks, mic } = await setup();
    uplinks[0].emit({ type: "session.expiring", closes_in_ms: 30_000 });
    await vi.advanceTimersByTimeAsync(0);
    uplinks[1].drop(4503, { code: "service_unavailable", type: "api_error", message: "busy", fatal: true, close_code: 4503, retry_after_ms: 3000 });
    source.push(0, 10);
    uplinks[0].drop(1000);
    expect(uplinks).toHaveLength(2);
    source.push(0, 5);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(uplinks).toHaveLength(2); // not before 3000 ms
    await vi.advanceTimersByTimeAsync(1_500);
    expect(uplinks).toHaveLength(3);
    expect(mic.transport()).toBe("stream");
  });
});

// ── Fix round 3 ──
for (const sync of [false, true]) describe(`StreamMic fix round 3${sync ? " (CallView restarts the mic in its end handler)" : ""}`, () => {
  beforeEach(() => {
    syncRestart = sync;
  });
  afterEach(() => {
    syncRestart = false;
  });
  const stubFetch = () => {
    let n = 0;
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ text: `batch ${(n += 1)}` }) }));
    vi.stubGlobal("fetch", f);
    return f;
  };
  afterEach(() => vi.unstubAllGlobals());
  const texts = (lines: MicLine[]) => finals(lines).map((l) => l.text);
  const spyAdopt = (mic: unknown) => vi.spyOn(mic as { adoptUtterance: (f: Int16Array[], j: unknown[]) => void }, "adoptUtterance");

  it("Q1/N1: a turn already open when its sentence is handed over is not said twice", async () => {
    stubFetch();
    const { source, uplink, lines, listen } = await setup();
    source.push(0.2, 6);
    uplink().emit({ type: "speech.started", turn: 0, audio_ms: 0 });
    uplink().emit({ type: "transcript.partial", turn: 0, text: "Book a", audio_start_ms: 0, audio_end_ms: 300 });
    uplink().refuse = true;
    source.push(0.2, 1);
    uplink().refuse = false;
    source.push(0.2, 3);
    source.push(0, 20);
    uplink().emit({ type: "turn.end", turn: 0, text: "Book a table.", reason: "forced", confidence: null, audio_start_ms: 0, audio_end_ms: 400 });
    await vi.advanceTimersByTimeAsync(10);
    await listen();
    await vi.advanceTimersByTimeAsync(10);
    await listen();
    await vi.advanceTimersByTimeAsync(10);
    expect(texts(lines)).toEqual(["batch 1"]);
  });

  it("Q4/N3: two hand-overs before one start() each reach CallView", async () => {
    const f = stubFetch();
    const { source, uplink, lines, listen } = await setup();
    source.push(0.2, 8);
    uplink().emit({ type: "turn.end", turn: 0, text: "First.", reason: "endpoint", confidence: 1, audio_start_ms: 0, audio_end_ms: 400 });
    source.push(0, 20);
    source.push(0.2, 4);
    uplink().refuse = true; source.push(0.2, 1); uplink().refuse = false;
    source.push(0.2, 3);
    source.push(0, 25);
    source.push(0.2, 4);
    uplink().refuse = true; source.push(0.2, 1); uplink().refuse = false;
    source.push(0.2, 3);
    source.push(0, 25);
    await vi.advanceTimersByTimeAsync(10);
    for (let i = 0; i < 3; i += 1) {
      await listen();
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(texts(lines)).toEqual(["First.", "batch 1", "batch 2"]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("Q5/N2: the next sentence's turn, reported a little early, is kept after a hand-over", async () => {
    stubFetch();
    const { source, uplink, lines, listen } = await setup();
    source.push(0.2, 6);
    uplink().refuse = true; source.push(0.2, 1); uplink().refuse = false;
    source.push(0.2, 3);
    source.push(0, 14);
    source.push(0.2, 8);
    source.push(0, 20);
    uplink().emit({ type: "turn.end", turn: 0, text: "A forced.", reason: "forced", confidence: null, audio_start_ms: 0, audio_end_ms: 380 });
    uplink().emit({ type: "turn.end", turn: 1, text: "Sentence N.", reason: "endpoint", confidence: 1, audio_start_ms: 300, audio_end_ms: 800 });
    await vi.advanceTimersByTimeAsync(10);
    for (let i = 0; i < 3; i += 1) {
      await listen();
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(texts(lines)).toContain("Sentence N.");
    expect(texts(lines)).not.toContain("A forced.");
  });

  it("N2: an early turn that arrives before the commit's answer is held, then kept once it is answered", async () => {
    stubFetch();
    const { source, uplink, lines, listen } = await setup();
    source.push(0.2, 6);
    uplink().refuse = true; source.push(0.2, 1); uplink().refuse = false;
    source.push(0.2, 3);
    source.push(0, 14);
    source.push(0.2, 8);
    source.push(0, 20);
    uplink().emit({ type: "turn.end", turn: 1, text: "Sentence N.", reason: "endpoint", confidence: 1, audio_start_ms: 300, audio_end_ms: 800 });
    expect(texts(lines)).toEqual([]); // held: it may be the handed-over audio's turn
    uplink().emit({ type: "turn.committed", turn: 0 });
    // fix round 4 (O1): kept, and it goes out after the handed sentence's batch line
    await vi.advanceTimersByTimeAsync(10);
    await listen();
    await vi.advanceTimersByTimeAsync(10);
    expect(texts(lines)).toEqual(["batch 1", "Sentence N."]);
  });

  it("N2: a held turn is dropped when the answer names it, and kept when the answer is null", async () => {
    const a = await setup();
    a.source.push(0.2, 6);
    a.uplink().refuse = true; a.source.push(0.2, 1); a.uplink().refuse = false;
    a.source.push(0, 20);
    a.uplink().emit({ type: "turn.end", turn: 0, text: "handed", reason: "forced", confidence: null, audio_start_ms: 0, audio_end_ms: 300 });
    a.uplink().emit({ type: "turn.committed", turn: 0 }); // the duplicate answer changes nothing
    expect(texts(a.lines)).toEqual([]);
    const b = await setup();
    b.source.push(0.2, 6);
    b.uplink().refuse = true; b.source.push(0.2, 1); b.uplink().refuse = false;
    b.source.push(0, 20);
    // fix round 4 (M2): after a null answer a turn ending inside the handed audio is the
    // handed audio's, so the kept one is a turn that runs past the edge (384 ms)
    b.uplink().emit({ type: "turn.end", turn: 0, text: "early one", reason: "endpoint", confidence: 1, audio_start_ms: 100, audio_end_ms: 600 });
    expect(texts(b.lines)).toEqual([]);
    b.uplink().emit({ type: "turn.committed", turn: null });
    expect(texts(b.lines)).toEqual(["early one"]);
  });

  it("N2: a held turn is emitted after 2 s if the answer never comes", async () => {
    stubFetch();
    const { source, uplink, lines, listen } = await setup();
    source.push(0.2, 6);
    uplink().refuse = true; source.push(0.2, 1); uplink().refuse = false;
    source.push(0, 20);
    uplink().emit({ type: "turn.end", turn: 0, text: "unanswered", reason: "endpoint", confidence: 1, audio_start_ms: 200, audio_end_ms: 300 });
    expect(texts(lines)).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_100);
    await listen(); // the batch line took the listening; the held one waits its start()
    await vi.advanceTimersByTimeAsync(10);
    expect(texts(lines)).toContain("unanswered");
  });

  it("Q6/N2: speech right after an unmute, its turn reported early, is kept", async () => {
    const { source, uplink, mic, lines } = await setup();
    source.push(0.2, 8);
    mic.setMuted(true);
    source.push(0.2, 20);
    mic.setMuted(false);
    source.push(0.2, 8);
    source.push(0, 20);
    uplink().emit({ type: "turn.end", turn: 0, text: "muted one", reason: "forced", confidence: null, audio_start_ms: 0, audio_end_ms: 500 });
    uplink().emit({ type: "turn.end", turn: 1, text: "After unmute.", reason: "endpoint", confidence: 1, audio_start_ms: 312, audio_end_ms: 1000 });
    expect(texts(lines)).toEqual(["After unmute."]);
  });

  it("minor: a continuation's first part, which already has its line, is not in a later batch clip", async () => {
    stubFetch();
    const { source, uplinks, mic } = await setup();
    const adopt = spyAdopt(mic);
    source.push(0.2, 8); // A on the old stream
    uplinks[0].emit({ type: "session.expiring", closes_in_ms: 30_000 });
    await vi.advanceTimersByTimeAsync(0);
    source.push(0, 12); // the tee switches
    source.push(0.2, 8); // U, on the new stream
    uplinks[1].emit({ type: "turn.end", turn: 0, text: "First part.", reason: "endpoint", confidence: 1, audio_start_ms: 0, audio_end_ms: 5_000 });
    source.push(0.2, 3); // U goes on: a continuation
    uplinks[1].drop(4502);
    expect(adopt).toHaveBeenCalledTimes(1);
    // A (8 loud + 12 quiet, with preroll) and the continuation's 3 frames: not U's 8 already said
    expect(adopt.mock.calls[0][0].length).toBeLessThanOrEqual(8 + 12 + 3 + 2);
  });
});

// ── Fix round 4 ──
for (const sync of [false, true]) {
  describe(`StreamMic fix round 4${sync ? " (CallView restarts the mic in its end handler)" : ""}`, () => {
    const stubFetch = (fail: number[] = []) => {
      let n = 0;
      const f = vi.fn(async () => {
        n += 1;
        if (fail.includes(n)) return { ok: false, status: 400, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ text: `batch ${n}` }) };
      });
      vi.stubGlobal("fetch", f);
      return f;
    };
    afterEach(() => vi.unstubAllGlobals());
    const texts = (lines: MicLine[]) => finals(lines).map((l) => l.text);
    const handOff = (source: ManualSource, uplink: () => ReturnType<typeof fakeUplink>) => {
      uplink().refuse = true;
      source.push(0.2, 1);
      uplink().refuse = false;
    };

    it("R1/I1: a backlogged hand-over is transcribed when CallView restarts the mic inside the end handler", async () => {
      const f = stubFetch();
      const { source, uplink, mic, lines, listen } = await setup({ syncRestart: true });
      source.push(0.2, 4);
      handOff(source, uplink); // X handed while listening
      source.push(0.2, 3);
      source.push(0, 15); // X reaches its endpoint and is out for transcription
      source.push(0.2, 4);
      handOff(source, uplink); // Y handed while X is in flight: it waits its turn
      source.push(0.2, 3);
      source.push(0, 25);
      await vi.advanceTimersByTimeAsync(10); // X's line; the end handler calls start() at once
      await vi.advanceTimersByTimeAsync(3_000);
      expect(texts(lines)).toEqual(["batch 1", "batch 2"]);
      expect(f).toHaveBeenCalledTimes(2);
      expect(mic.pending()).toBe(false);
      await listen();
      source.push(0.2, 6); // the owner says Z on the stream
      uplink().emit({ type: "turn.end", turn: 9, text: "Z.", reason: "endpoint", confidence: 1, audio_start_ms: 1_500, audio_end_ms: 1_900 });
      source.push(0, 20);
      await vi.advanceTimersByTimeAsync(10);
      expect(texts(lines)).toEqual(["batch 1", "batch 2", "Z."]);
    });

    it("O1: a later stream sentence waits for an earlier handed sentence's batch line (Q5)", async () => {
      stubFetch();
      const { source, uplink, lines, listen } = await setup();
      source.push(0.2, 6);
      handOff(source, uplink);
      source.push(0.2, 3);
      source.push(0, 14);
      source.push(0.2, 8);
      source.push(0, 20);
      uplink().emit({ type: "turn.end", turn: 0, text: "A forced.", reason: "forced", confidence: null, audio_start_ms: 0, audio_end_ms: 380 });
      uplink().emit({ type: "turn.end", turn: 1, text: "Sentence N.", reason: "endpoint", confidence: 1, audio_start_ms: 300, audio_end_ms: 800 });
      expect(texts(lines)).toEqual([]); // it waits: the handed sentence was said first
      await vi.advanceTimersByTimeAsync(10);
      for (let i = 0; i < 3; i += 1) {
        await listen();
        await vi.advanceTimersByTimeAsync(10);
      }
      expect(texts(lines)).toEqual(["batch 1", "Sentence N."]);
    });

    it("O1: a failed batch line goes out as its error end in its own slot, then the later stream line", async () => {
      stubFetch([1, 2]); // the transcription and its one retry both fail
      const { source, uplink, lines, ends, listen } = await setup();
      source.push(0.2, 6);
      handOff(source, uplink);
      source.push(0.2, 3);
      source.push(0, 14);
      source.push(0.2, 8);
      source.push(0, 20);
      uplink().emit({ type: "turn.committed", turn: null });
      uplink().emit({ type: "turn.end", turn: 0, text: "Sentence N.", reason: "endpoint", confidence: 1, audio_start_ms: 1_200, audio_end_ms: 1_700 });
      expect(texts(lines)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ends.map((e) => e.code)).toEqual([1]);
      expect(texts(lines)).toEqual([]);
      await listen();
      await vi.advanceTimersByTimeAsync(10);
      expect(texts(lines)).toEqual(["Sentence N."]);
      expect(ends.map((e) => e.code)).toEqual([1, 0]);
    });

    it("O1: a stream sentence said before a hand-over is not held behind it", async () => {
      stubFetch();
      const { source, uplink, uplinks, lines } = await setup();
      source.push(0.2, 8); // A on the old stream
      uplinks[0].emit({ type: "session.expiring", closes_in_ms: 30_000 });
      await vi.advanceTimersByTimeAsync(0);
      source.push(0, 12); // the tee switches; the old one drains
      source.push(0.2, 4);
      handOff(source, uplink); // B, on the new stream, handed while A's turn is still out
      source.push(0.2, 3);
      source.push(0, 20);
      uplinks[0].emit({ type: "turn.end", turn: 0, text: "A.", reason: "endpoint", confidence: 1, audio_start_ms: 0, audio_end_ms: 500 });
      expect(texts(lines)).toEqual(["A."]);
    });

    it("I1: a start() while a handed sentence is still being recorded keeps that recording", async () => {
      stubFetch();
      const { source, uplink, uplinks, lines, listen } = await setup();
      source.push(0.2, 8); // A on the old stream
      uplinks[0].emit({ type: "session.expiring", closes_in_ms: 30_000 });
      await vi.advanceTimersByTimeAsync(0);
      source.push(0, 12); // the tee switches; the old one drains
      source.push(0.2, 4);
      handOff(source, uplink); // B handed while it is still being said
      source.push(0.2, 2);
      uplinks[0].emit({ type: "turn.end", turn: 0, text: "A.", reason: "endpoint", confidence: 1, audio_start_ms: 0, audio_end_ms: 500 });
      expect(texts(lines)).toEqual(["A."]);
      await listen(); // CallView listens again while B is still being recorded
      source.push(0.2, 3);
      source.push(0, 20);
      await vi.advanceTimersByTimeAsync(10);
      await listen();
      await vi.advanceTimersByTimeAsync(10);
      expect(texts(lines)).toEqual(["A.", "batch 1"]);
    });

    it("N0/M2: after a null answer, a late turn that ends inside the handed audio is not said twice", async () => {
      stubFetch();
      const { source, uplink, lines, listen } = await setup();
      source.push(0.2, 6); // A: 384 ms sent, no provider turn yet
      handOff(source, uplink);
      source.push(0.2, 3);
      source.push(0, 20);
      uplink().emit({ type: "turn.committed", turn: null }); // a slow provider: the deadline passed
      uplink().emit({ type: "speech.started", turn: 0, audio_ms: 0 });
      uplink().emit({ type: "turn.end", turn: 0, text: "A late.", reason: "endpoint", confidence: 1, audio_start_ms: 0, audio_end_ms: 380 });
      await vi.advanceTimersByTimeAsync(10);
      for (let i = 0; i < 3; i += 1) {
        await listen();
        await vi.advanceTimersByTimeAsync(10);
      }
      expect(texts(lines)).toEqual(["batch 1"]);
    });

    it("M2: after a null answer, the next sentence that starts near the edge and runs past it is kept", async () => {
      stubFetch();
      const { source, uplink, mic, lines, listen } = await setup();
      source.push(0.2, 6);
      handOff(source, uplink);
      source.push(0.2, 3);
      source.push(0, 20);
      source.push(0.2, 8); // the next sentence, on the stream
      source.push(0, 20);
      uplink().emit({ type: "turn.committed", turn: null });
      uplink().emit({ type: "speech.started", turn: 0, audio_ms: 100 }); // reported early, near the edge
      expect(mic.pending()).toBe(true); // held until its end decides
      uplink().emit({ type: "turn.end", turn: 0, text: "Next one.", reason: "endpoint", confidence: 1, audio_start_ms: 100, audio_end_ms: 1_400 });
      await vi.advanceTimersByTimeAsync(10);
      for (let i = 0; i < 3; i += 1) {
        await listen();
        await vi.advanceTimersByTimeAsync(10);
      }
      expect(texts(lines)).toEqual(["batch 1", "Next one."]);
    });

    it("M3: a second hand-over while the first commit is unanswered sends no second commit, and the one answer covers both", async () => {
      stubFetch();
      const { source, uplink, lines, listen } = await setup();
      source.push(0.2, 6);
      handOff(source, uplink); // first: commit sent, range 0 to 384
      source.push(0.2, 3);
      source.push(0, 20);
      source.push(0.2, 6);
      handOff(source, uplink); // second, before the answer
      source.push(0.2, 3);
      source.push(0, 25);
      expect(uplink().commit).toHaveBeenCalledTimes(1);
      uplink().emit({ type: "turn.end", turn: 0, text: "first handed", reason: "forced", confidence: null, audio_start_ms: 0, audio_end_ms: 380 });
      // the second hand-over's audio lies past the commit's barrier: a turn well inside it is still thrown away
      uplink().emit({ type: "turn.end", turn: 1, text: "second handed", reason: "endpoint", confidence: 1, audio_start_ms: 600, audio_end_ms: 900 });
      await vi.advanceTimersByTimeAsync(10);
      for (let i = 0; i < 4; i += 1) {
        await listen();
        await vi.advanceTimersByTimeAsync(10);
      }
      expect(texts(lines)).toEqual(["batch 1", "batch 2"]);
      // answered: the next hand-over sends a commit of its own
      source.push(0.2, 6);
      handOff(source, uplink);
      expect(uplink().commit).toHaveBeenCalledTimes(2);
    });

    it("M3: with the punctuation commit on, none is sent while a discard-only commit is unanswered, and its forced end is not taken as one", async () => {
      stubFetch();
      const { source, uplink, lines, listen } = await setup({ commit: true });
      source.push(0.2, 8);
      uplink().emit({ type: "transcript.partial", turn: 0, text: "Book a table." });
      source.push(0, 10); // the punctuation commit goes out
      expect(uplink().commit).toHaveBeenCalledTimes(1);
      uplink().emit({ type: "turn.end", turn: 0, text: "Book a table.", reason: "forced", confidence: null, audio_start_ms: 0, audio_end_ms: 500 });
      expect(texts(lines)).toEqual(["Book a table."]); // its answer, not a discard
      await listen();
      source.push(0.2, 6);
      handOff(source, uplink); // a discard-only commit
      expect(uplink().commit).toHaveBeenCalledTimes(2);
      uplink().emit({ type: "transcript.partial", turn: 1, text: "Something else.", audio_start_ms: 2_000, audio_end_ms: 2_300 });
      source.push(0, 25); // past the hand-over's recorder, to the stream again
      expect(uplink().commit).toHaveBeenCalledTimes(2); // one in flight at a time
    });

    it("R2/M4: a continuation's turn.cancelled clears pending()", async () => {
      const { source, uplink, mic } = await setup();
      source.push(0.2, 6);
      uplink().emit({ type: "turn.end", turn: 0, text: "Blues Brothers.", reason: "endpoint", confidence: 1, audio_start_ms: 0, audio_end_ms: 380 });
      source.push(0.2, 4); // a continuation (Silero still open)
      source.push(0, 14); // the gate closes
      uplink().emit({ type: "speech.started", turn: 1, audio_ms: 400 });
      uplink().emit({ type: "turn.cancelled", turn: 1, received_audio_ms: 1_500 });
      await vi.advanceTimersByTimeAsync(10);
      expect(mic.pending()).toBe(false);
    });

    it("M4: a continuation's fault hands over the continuation, not the first part again", async () => {
      stubFetch();
      const { source, uplink, mic } = await setup();
      const adopt = vi.spyOn(mic as never as { adoptUtterance: (f: Int16Array[], j: unknown[]) => void }, "adoptUtterance");
      source.push(0.2, 6);
      uplink().emit({ type: "turn.end", turn: 0, text: "First part.", reason: "endpoint", confidence: 1, audio_start_ms: 0, audio_end_ms: 380 });
      source.push(0.2, 4); // continuation
      uplink().drop(4502);
      expect(adopt).toHaveBeenCalledTimes(1);
      expect(adopt.mock.calls[0][0].length).toBeLessThanOrEqual(4 + 1);
    });
  });
}

// ── Fix round 5 ──
for (const sync of [false, true]) {
  describe(`StreamMic fix round 5${sync ? " (CallView restarts the mic in its end handler)" : ""}`, () => {
    beforeEach(() => {
      syncRestart = sync;
    });
    afterEach(() => {
      syncRestart = false;
      vi.unstubAllGlobals();
    });
    const texts = (lines: MicLine[]) => finals(lines).map((l) => l.text);
    const handOff = (source: ManualSource, uplink: () => ReturnType<typeof fakeUplink>) => {
      uplink().refuse = true;
      source.push(0.2, 1);
      uplink().refuse = false;
    };
    /** Transcriptions numbered from 1; those in `hang` never answer, and `late`
     *  ones answer only when released. */
    const stubFetch = (hang: number[] = [], late: number[] = []) => {
      let n = 0;
      const release: Array<() => void> = [];
      const f = vi.fn(async () => {
        n += 1;
        const k = n;
        const answer = { ok: true, status: 200, json: async () => ({ text: `batch ${k}` }) };
        if (hang.includes(k)) return new Promise(() => {});
        if (late.includes(k)) return new Promise((resolve) => release.push(() => resolve(answer)));
        return answer;
      });
      vi.stubGlobal("fetch", f);
      return { f, release };
    };

    it("H1: a hung batch transcription does not silence the later lines, and ends as failed", async () => {
      stubFetch([1]);
      const { source, uplink, lines, ends, listen } = await setup();
      source.push(0.2, 6);
      handOff(source, uplink);
      source.push(0.2, 3);
      source.push(0, 20);
      uplink().emit({ type: "turn.committed", turn: null });
      for (let k = 0; k < 3; k += 1) {
        source.push(0.2, 8);
        source.push(0, 20);
        uplink().emit({ type: "turn.end", turn: k, text: `Later ${k}.`, reason: "endpoint", confidence: 1, audio_start_ms: 1500 + k * 1800, audio_end_ms: 1900 + k * 1800, received_audio_ms: 2500 + k * 1800 });
        await vi.advanceTimersByTimeAsync(10_000);
        await listen();
      }
      expect(texts(lines)).toEqual(["Later 0.", "Later 1.", "Later 2."]);
      await vi.advanceTimersByTimeAsync(60_000); // the transcription's own bound
      expect(ends.map((e) => e.code)).toEqual([0, 0, 0, 1]);
      expect(ends.at(-1)?.reason).toBe("transcription-failed");
    });

    it("H1: a batch line that comes after the later lines were let go is delivered late, never dropped", async () => {
      const { release } = stubFetch([], [1]);
      const { source, uplink, lines, listen } = await setup();
      source.push(0.2, 6);
      handOff(source, uplink);
      source.push(0.2, 3);
      source.push(0, 20);
      uplink().emit({ type: "turn.committed", turn: null });
      source.push(0.2, 8);
      source.push(0, 20);
      uplink().emit({ type: "turn.end", turn: 0, text: "Later.", reason: "endpoint", confidence: 1, audio_start_ms: 1500, audio_end_ms: 1900, received_audio_ms: 2500 });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(texts(lines)).toEqual([]); // still waiting its turn behind the handed sentence
      await vi.advanceTimersByTimeAsync(5_000);
      expect(texts(lines)).toEqual(["Later."]); // past the wait: let go
      await listen();
      release[0]();
      await vi.advanceTimersByTimeAsync(10);
      expect(texts(lines)).toEqual(["Later.", "batch 1"]);
    });

    it("S1: a short reply right after a hand-over is kept after a null answer, though reported ending inside the handed audio", async () => {
      stubFetch();
      const { source, uplink, lines, listen } = await setup();
      source.push(0.2, 6); // 0..384 sent
      handOff(source, uplink);
      source.push(0.2, 3);
      source.push(0, 14); // to FluxMic until its endpoint
      source.push(0, 3); // 384..576 sent (silence)
      source.push(0.2, 5); // "Yes." 576..896
      source.push(0, 20);
      uplink().emit({ type: "turn.committed", turn: null });
      uplink().emit({ type: "speech.started", turn: 0, audio_ms: 100 });
      uplink().emit({ type: "turn.end", turn: 0, text: "Yes.", reason: "endpoint", confidence: 1, audio_start_ms: 100, audio_end_ms: 380, received_audio_ms: 2_100 });
      await vi.advanceTimersByTimeAsync(10);
      for (let i = 0; i < 3; i += 1) {
        await listen();
        await vi.advanceTimersByTimeAsync(10);
      }
      expect(texts(lines)).toEqual(["batch 1", "Yes."]);
    });

    it("S2: a short reply right after an unmute is kept after a null answer", async () => {
      stubFetch();
      const { source, uplink, mic, lines, listen } = await setup();
      source.push(0.2, 6); // onset sent 0..384, no provider turn yet
      mic.setMuted(true);
      expect(uplink().commit).toHaveBeenCalledTimes(1);
      uplink().emit({ type: "turn.committed", turn: null });
      source.push(0.2, 20); // muted: nothing sent
      mic.setMuted(false);
      source.push(0, 3); // 384..576
      source.push(0.2, 5); // "Yes." 576..896
      source.push(0, 20);
      uplink().emit({ type: "turn.end", turn: 0, text: "Yes.", reason: "endpoint", confidence: 1, audio_start_ms: 150, audio_end_ms: 370, received_audio_ms: 2_100 });
      await vi.advanceTimersByTimeAsync(10);
      for (let i = 0; i < 2; i += 1) {
        await listen();
        await vi.advanceTimersByTimeAsync(10);
      }
      expect(texts(lines)).toEqual(["Yes."]);
    });

    it("M3: audio merged in past a commit's barrier gets a commit of its own once the first is answered", async () => {
      stubFetch();
      const { source, uplink } = await setup();
      source.push(0.2, 6);
      handOff(source, uplink); // first: commit sent
      source.push(0.2, 3);
      source.push(0, 20);
      source.push(0.2, 6);
      handOff(source, uplink); // second, merged before the answer
      source.push(0.2, 3);
      source.push(0, 25);
      expect(uplink().commit).toHaveBeenCalledTimes(1);
      uplink().emit({ type: "turn.end", turn: 0, text: "first handed", reason: "forced", confidence: null, audio_start_ms: 0, audio_end_ms: 380 });
      expect(uplink().commit).toHaveBeenCalledTimes(2); // the remainder past the barrier is force-ended too
    });

    it("M3: no follow-up commit while the owner is already saying something new", async () => {
      stubFetch();
      const { source, uplink } = await setup();
      source.push(0.2, 6);
      handOff(source, uplink);
      source.push(0.2, 3);
      source.push(0, 20);
      source.push(0.2, 6);
      handOff(source, uplink);
      source.push(0.2, 3);
      source.push(0, 25);
      source.push(0.2, 8); // a new sentence underway on the stream
      uplink().emit({ type: "turn.end", turn: 0, text: "first handed", reason: "forced", confidence: null, audio_start_ms: 0, audio_end_ms: 380 });
      expect(uplink().commit).toHaveBeenCalledTimes(1); // never an early end of the owner's turn
    });

    it("M3: no follow-up commit while the owner's onset is still inside the voice gate's pre-roll", async () => {
      stubFetch();
      const { source, uplink } = await setup();
      source.push(0.2, 6);
      handOff(source, uplink);
      source.push(0.2, 3);
      source.push(0, 20);
      source.push(0.2, 6);
      handOff(source, uplink);
      source.push(0.2, 3);
      source.push(0, 25);
      source.push(0.2, 2); // heard, but too few frames for Silero to open an utterance yet
      uplink().emit({ type: "turn.end", turn: 0, text: "first handed", reason: "forced", confidence: null, audio_start_ms: 0, audio_end_ms: 380 });
      expect(uplink().commit).toHaveBeenCalledTimes(1); // a commit would end the turn holding his first word
    });

    it("M3: the follow-up commit still fires once the pre-roll window has passed with quiet", async () => {
      stubFetch();
      const { source, uplink } = await setup();
      source.push(0.2, 6);
      handOff(source, uplink);
      source.push(0.2, 3);
      source.push(0, 20);
      source.push(0.2, 6);
      handOff(source, uplink);
      source.push(0.2, 3);
      source.push(0, 25);
      source.push(0.2, 2); // heard, inside the pre-roll window
      await vi.advanceTimersByTimeAsync(1_000); // the window passes with quiet
      uplink().emit({ type: "turn.end", turn: 0, text: "first handed", reason: "forced", confidence: null, audio_start_ms: 0, audio_end_ms: 380 });
      expect(uplink().commit).toHaveBeenCalledTimes(2);
    });
  });
}

describe("StreamMic and the dropped-turn rules", () => {
  it("is a flux mic: it inherits sinceSpeechMs, and reports none while no speech model judges frames", async () => {
    expect(StreamMic.prototype.sinceSpeechMs).toBe(FluxMic.prototype.sinceSpeechMs);
    const { source, mic } = await setup();
    source.push(0.2, 4);
    expect(mic.kind).toBe("flux");
    expect(mic.sinceSpeechMs()).toBeNull(); // CallView then falls back to the endpoint wait for the tail
  });

  it("starts an utterance with the caption-only placeholder that CallView never counts as words", async () => {
    const { source, lines } = await setup();
    source.push(0.2, 10);
    expect(lines[0]).toMatchObject({ text: "…", partial: true });
  });
});
