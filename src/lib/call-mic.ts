// The call's microphone, on every desktop platform.
//
// ONE CAPTURE, ECHO CANCELLED. The microphone is opened once per call through
// Chromium with echoCancellation on. Chromium's canceller removes what this
// app itself plays, so the bot's voice does not come back in as the owner's
// words, and the microphone can stay open while the bot speaks: the owner
// talks over it and it stops. Measured on a USB mic with separate USB
// speakers, the common desk: without cancellation the recognizer transcribed
// the bot's whole sentence; with it, nothing of the bot, while a voice from
// outside the app came through word for word. Apple's own voice processing
// was tried first and cannot initialise on that hardware (-10875: it needs
// input and output on one device), which is why the capture lives here.
//
// TWO RECOGNIZERS BEHIND ONE SHAPE. The call screen sees the same four calls
// it always used (start, stop, transcript lines, end), so its turn-taking did
// not have to be rewritten per platform:
//   - macOS: Apple's on-device recognizer in the native helper, fed this
//     echo-cancelled audio instead of opening the mic itself (--pcm-file).
//     Partial words stream as today.
//   - Windows and Linux: a small voice-activity detector finds the end of an
//     utterance and Flux transcribes it (POST /api/voice/transcribe). No
//     partial words, about 1.5-3 s after you stop, but it works everywhere.
//
// WHERE THE FRAMES COME FROM. Capture reads 16 kHz mono frames from a
// FrameSource (spec §4.3.1). On the desktop that is getUserMedia with
// Chromium's canceller (WebAudioFrameSource, the code described above). On
// an iPhone build that lists callAudioOpen it is the shell's own voice-
// processing engine (NativeFrameSource), because WebKit's capture cannot
// hold a clean full-duplex call. Everything after the frame (Silero, the
// voice gate, Flux's endpointing) is the same code on both.

import { desktopCallerHeaders } from "./live-events";
import { callNative, onNativeEvent, type CallAudioEvent } from "./native-shell";
import type { SileroVad } from "./silero-vad";
import { SPEECH_CONFIDENCE } from "./vad-threshold";

export interface MicLine {
  text?: string;
  partial?: boolean;
  error?: string;
  /** What Silero heard in the audio this line was transcribed from (Flux's
   *  final lines only; absent when no speech model ran on all of it).
   *  `heard`: any speech at all; `share`: the share of the utterance, up to
   *  its last speech, that was speech. A Flux line lands 1.5-3 s after the
   *  owner stopped, when a window ending "now" holds only silence. */
  speech?: { heard: boolean; share: number };
  /** When the utterance ended (epoch ms): Flux's final lines, for the
   *  call's turn timing. */
  endedAt?: number;
  /** The Mac helper's final line, when it ended the turn on its long window
   *  (the last word sounded unfinished): the owner has already been silent
   *  that long, so the call holds the line only briefly. */
  longEndpoint?: boolean;
}
export interface MicEnd {
  code: number | null;
  reason?: string;
}

export interface CallMic {
  readonly kind: "apple" | "flux";
  /** True when the microphone can stay open while the bot speaks (echo
   *  cancelled). False only for the fallback below. */
  readonly duplex: boolean;
  /** Open the microphone for the call. Rejects when capture is refused. */
  open(): Promise<void>;
  /** Begin recognising one turn. */
  start(options: { endpointMs: number; endpointLongMs?: number; hints?: string[] }): Promise<void>;
  /** Stop recognising (the microphone itself stays open). */
  stop(): Promise<void>;
  /** Stop sending audio without ending the call. */
  setMuted(muted: boolean): void;
  onLine(fn: (line: MicLine) => void): () => void;
  onEnd(fn: (end: MicEnd) => void): () => void;
  /** Called with true while sustained speech is heard, false after it ends.
   *  The call screen uses it to stop the bot when the owner talks over it. */
  onVoice(fn: (speaking: boolean) => void): () => void;
  /** Each frame's loudness (RMS, 0 while muted), for the call screen's
   *  visuals only; absent on a microphone the page never hears. */
  onLevel?(fn: (rms: number) => void): () => void;
  /** Whether speech (not just sound: Silero VAD) was heard within the last
   *  `ms`; null when no speech model runs here and only loudness is known. */
  speechWithin(ms: number): boolean | null;
  /** The share (0 to 1) of the last `ms` of audio that was speech; null
   *  without a speech model. Speech runs high; music trips the model now
   *  and then, so its share stays low. */
  speechShare(ms: number): number | null;
  /** How long ago the last speech frame was; null without a speech model or
   *  before any speech. */
  sinceSpeechMs(): number | null;
  /** True while an utterance is being recorded or transcribed and its
   *  final line is still to come (Flux); always false for a recognizer
   *  that streams its words (Apple). */
  pending(): boolean;
  /** Streaming (Flux end of turn) or batch (silence endpoint then upload).
   *  Absent on recognizers that have only one path. */
  transport?(): "stream" | "batch";
  /** The call is on hold: release what the hold makes idle (a stream). */
  suspend?(): void;
  /** Back from hold. */
  resume?(): Promise<void>;
  /** Forget what was heard (the voice gate, Silero's state, recent speech
   *  and a half-heard utterance), as after a hold (spec §4.3.5). */
  resetDetection(): void;
  close(): void;
}

/**
 * Where a call's 16 kHz mono frames come from. `at`, when a source knows it,
 * is the frame's time in ms counted by samples since the source first
 * opened; a source that leaves it out is timed by the wall clock.
 */
export interface FrameSource {
  readonly opened: boolean;
  open(onFrame: (frame: Float32Array, at?: number, capturedAt?: number) => void): Promise<void>;
  close(): void;
}

const RATE = 16_000;
const FRAME = 1024; // 64 ms at 16 kHz
/** Echo left over after cancellation sits near 0.0003 RMS with brief single
 *  spikes to about 0.05 as the canceller adapts; speech is sustained. So a
 *  voice is sustained energy above the threshold, never one loud frame. */
const VOICE_RMS = 0.02;
const VOICE_FRAMES_ON = 6; // ~0.38 s
const VOICE_FRAMES_OFF = 8; // ~0.5 s
/** With Silero deciding each frame is speech: ~0.19 s (Pipecat: 0.2 s). */
const SPEECH_FRAMES_ON = 3;
/** Below this, a frame is silence whatever a model says about it. */
const SPEECH_FLOOR_RMS = 0.004;
const ANY_SPEECH_CONFIDENCE = 0.5;
const PREROLL_FRAMES = 6; // keep ~0.38 s before speech was detected
const MAX_UTTERANCE_FRAMES = Math.round((30 * RATE) / FRAME);

type Listener<T> = Set<(value: T) => void>;
/** Silero on one frame: `speech` at the bar that stops the bot, `any` at
 *  the lower "was anyone speaking" bar. */
export type FrameSpeech = { speech: boolean; any: boolean };

/** The evidence a Flux line carries (MicLine.speech), from its own frames;
 *  null when any of them went unjudged (the model was not loaded yet). */
export function utteranceSpeech(frames: Array<FrameSpeech | null>): MicLine["speech"] | null {
  if (!frames.length || frames.some((f) => f === null)) return null;
  const judged = frames as FrameSpeech[];
  // up to the last speech: the silence that only ended it is not the owner
  // going quiet mid-sentence, and would halve a short "stop"'s share
  let end = judged.length;
  while (end > 0 && !judged[end - 1].speech) end -= 1;
  const spoken = judged.slice(0, end).filter((f) => f.speech).length;
  return { heard: judged.some((f) => f.any), share: end ? spoken / end : 0 };
}

function emit<T>(set: Listener<T>, value: T) {
  for (const fn of [...set]) fn(value);
}

export function toInt16(frame: Float32Array): Int16Array {
  const out = new Int16Array(frame.length);
  for (let i = 0; i < frame.length; i += 1) out[i] = Math.max(-1, Math.min(1, frame[i])) * 0x7fff;
  return out;
}

function rms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

/** A mono 16-bit WAV of the given PCM frames. Exported for tests. */
export function wavFrom(frames: Int16Array[], rate = RATE): Blob {
  const samples = frames.reduce((n, f) => n + f.length, 0);
  const view = new DataView(new ArrayBuffer(44 + samples * 2));
  const tag = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, samples * 2, true);
  let offset = 44;
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i += 1, offset += 2) view.setInt16(offset, frame[i], true);
  }
  return new Blob([view.buffer], { type: "audio/wav" });
}

/**
 * Tracks sustained voice from per-frame levels. Pure, so the thresholds that
 * decide barge-in are tested without a microphone.
 */
export class VoiceGate {
  private above = 0;
  private below = 0;
  speaking = false;

  /** Returns "start" or "end" on a transition, else null. */
  push(level: number): "start" | "end" | null {
    return this.decide(level > VOICE_RMS, VOICE_FRAMES_ON);
  }

  /** The same, from a speech model's yes or no per frame. A model needs
   *  less confirmation than loudness does (Pipecat starts after 0.2 s). */
  pushSpeech(speech: boolean): "start" | "end" | null {
    return this.decide(speech, SPEECH_FRAMES_ON);
  }

  private decide(voiced: boolean, framesOn: number): "start" | "end" | null {
    if (voiced) {
      this.above += 1;
      this.below = 0;
      if (!this.speaking && this.above >= framesOn) {
        this.speaking = true;
        return "start";
      }
    } else {
      this.below += 1;
      this.above = 0;
      if (this.speaking && this.below >= VOICE_FRAMES_OFF) {
        this.speaking = false;
        return "end";
      }
    }
    return null;
  }

  reset() {
    this.above = 0;
    this.below = 0;
    this.speaking = false;
  }
}

/** The desktop: Chromium's echo-cancelled getUserMedia capture. */
export class WebAudioFrameSource implements FrameSource {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: ScriptProcessorNode | null = null;

  get opened() {
    return this.stream !== null;
  }

  async open(onFrame: (frame: Float32Array) => void): Promise<void> {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });
    this.context = new AudioContext({ sampleRate: RATE });
    const source = this.context.createMediaStreamSource(this.stream);
    // ScriptProcessor rather than an AudioWorklet: it is the capture path the
    // echo measurements above were taken with, it needs no separate module
    // file in the bundle, and 64 ms frames are light work for the main
    // thread. (Deprecated in the spec, still supported by Chromium.)
    this.node = this.context.createScriptProcessor(FRAME, 1, 1);
    this.node.onaudioprocess = (event) => onFrame(new Float32Array(event.inputBuffer.getChannelData(0)));
    source.connect(this.node);
    // a ScriptProcessor only runs while connected to an output; it writes
    // silence, so nothing is heard
    this.node.connect(this.context.destination);
  }

  close() {
    if (this.node) this.node.onaudioprocess = null;
    this.node?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    void this.context?.close().catch(() => undefined);
    this.node = null;
    this.stream = null;
    this.context = null;
  }
}

/** Why a native open failed, as the call screen branches on it (spec §4.3.2):
 *  `denied` points to Settings, `inactive` retries on the next resume, and
 *  `unavailable` falls back to the web path. */
export type NativeOpenError = Error & { code: "denied" | "inactive" | "unavailable" };

function openError(error: unknown): NativeOpenError {
  const said = error && typeof error === "object" ? (error as { code?: unknown; message?: unknown }) : {};
  const raw = typeof said.code === "string" && said.code !== "native-unavailable" ? said.code : said.message;
  const code: NativeOpenError["code"] = raw === "denied" || raw === "inactive" ? raw : "unavailable";
  return Object.assign(new Error(code), { code });
}

/** Most events kept between native starting the microphone and the page
 *  reading the open's reply (a mic burst is one or two). Past this, events
 *  of any type are dropped; they would be stale by then anyway. */
const EARLY_EVENTS = 16;

/** Native has ONE engine: an open while another is open or opening gets the
 *  same session (spec §4.1). So every open and close, on every instance, runs
 *  one after another here. Otherwise a close for an open that was abandoned
 *  could land after a newer open was handed that same session, and stop the
 *  engine under it: a microphone that is silently dead. */
let nativeTurn: Promise<unknown> = Promise.resolve();

function inTurn<T>(task: () => Promise<T>): Promise<T> {
  const run = nativeTurn.then(task);
  nativeTurn = run.catch(() => undefined);
  return run;
}

/** Nothing the page hangs off a frame or an event may stop the source from
 *  answering native: an unanswered mic event counts toward the watchdog
 *  (spec §4.2.7), which closes the engine after about 2 s of them. */
function guarded(fn: () => void) {
  try {
    fn();
  } catch (error) {
    console.error(error);
  }
}

/**
 * The iPhone shell's call audio engine (spec §4.1): one session per open,
 * frames as base64 16-bit PCM in `callAudio` mic events. Everything else the
 * session reports (hold, resume, lost, route, clip) goes to `onEvent`, for
 * the call screen and the speaker. It can be closed and opened again ("Resume
 * call" after `lost`) without Capture noticing, and `onEvent` listeners stay.
 */
export class NativeFrameSource implements FrameSource {
  private current: string | null = null;
  private off: (() => void) | null = null;
  /** Bumped by close(), so an open that finishes afterwards is undone. */
  private generation = 0;
  /** The open in flight, which a second open() waits on. */
  private opening: Promise<void> | null = null;
  private events: Listener<CallAudioEvent> = new Set();
  private pending = new Float32Array(FRAME);
  private filled = 0;
  /** Samples handed on since the first open; the frame clock. It does not
   *  move while native sends nothing (a hold), and it carries on across a
   *  reopen so frame times never run backwards. */
  private samples = 0;
  /** The newest frame's capture time (epoch ms), so stamps never run backwards. */
  private lastCapturedAt = 0;

  get opened() {
    return this.current !== null;
  }

  /** The open session, or null. */
  get session() {
    return this.current;
  }

  /** The session's non-mic events. Returns the unsubscribe. */
  onEvent(fn: (event: CallAudioEvent) => void) {
    this.events.add(fn);
    return () => this.events.delete(fn);
  }

  open(onFrame: (frame: Float32Array, at?: number, capturedAt?: number) => void): Promise<void> {
    if (this.current) return Promise.resolve();
    if (this.opening) return this.opening;
    const generation = this.generation;
    const opening = inTurn(() => this.start(onFrame, generation)).finally(() => {
      if (this.opening === opening) this.opening = null;
    });
    this.opening = opening;
    return opening;
  }

  private async start(onFrame: (frame: Float32Array, at?: number, capturedAt?: number) => void, generation: number): Promise<void> {
    // closed before its turn came: nothing to open
    if (generation !== this.generation) return;
    // Subscribe first: native starts sending once the microphone runs, and
    // that can overtake the reply. Until the session is known, events wait.
    let early: CallAudioEvent[] | null = [];
    const deliver = (event: CallAudioEvent) => {
      if (event.session !== this.current) return;
      if (event.type === "mic") this.decode(event.pcm, onFrame);
      else for (const fn of [...this.events]) guarded(() => fn(event));
    };
    const off = onNativeEvent("callAudio", (event) => {
      if (early) {
        if (early.length < EARLY_EVENTS) early.push(event);
        return;
      }
      deliver(event);
    });
    this.off = off;
    let session: string;
    try {
      const reply = await callNative("callAudioOpen");
      const value = reply && typeof reply === "object" ? (reply as { session?: unknown }).session : undefined;
      if (typeof value !== "string" || value.length === 0) throw new Error("unavailable");
      session = value;
    } catch (error) {
      off();
      if (this.off === off) this.off = null;
      throw openError(error);
    }
    if (generation !== this.generation) {
      // Closed while opening: the engine must not outlive the call. This
      // close is awaited inside the turn, so the next open starts after it.
      off();
      await callNative("callAudioClose", { session }).catch(() => undefined);
      return;
    }
    this.current = session;
    this.pending = new Float32Array(FRAME);
    this.filled = 0;
    const waiting = early;
    early = null;
    for (const event of waiting) deliver(event);
  }

  /** Base64 16-bit little-endian PCM to Float32, cut into exact frames. */
  private decode(pcm: string, onFrame: (frame: Float32Array, at?: number, capturedAt?: number) => void) {
    let bytes: string;
    try {
      bytes = atob(pcm);
    } catch {
      return;
    }
    // The event arrived when its LAST sample was captured (at the latest), so a
    // frame is stamped the arrival less the audio after it in the same event.
    // Spacing inside a batch is kept, no frame is stamped after it arrived, and
    // a hold (native sends nothing) shifts nothing: nothing carries over.
    const arrived = Date.now();
    const total = this.filled + Math.floor(bytes.length / 2);
    let completed = 0;
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const unsigned = bytes.charCodeAt(i) | (bytes.charCodeAt(i + 1) << 8);
      this.pending[this.filled] = (unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned) / 0x8000;
      this.filled += 1;
      if (this.filled === FRAME) {
        const frame = this.pending;
        this.pending = new Float32Array(FRAME);
        this.filled = 0;
        this.samples += FRAME;
        completed += 1;
        const at = (this.samples * 1000) / RATE;
        const after = total - completed * FRAME; // samples of this event after this frame
        const capturedAt = Math.min(arrived, Math.max(this.lastCapturedAt, arrived - (after * 1000) / RATE));
        this.lastCapturedAt = capturedAt;
        guarded(() => onFrame(frame, at, capturedAt));
      }
    }
  }

  close() {
    this.generation += 1;
    this.opening = null;
    this.off?.();
    this.off = null;
    const session = this.current;
    this.current = null;
    if (session) void inTurn(() => callNative("callAudioClose", { session })).catch(() => undefined);
  }
}

abstract class Capture {
  protected lines: Listener<MicLine> = new Set();
  protected ends: Listener<MicEnd> = new Set();
  protected voices: Listener<boolean> = new Set();
  private levels: Listener<number> = new Set();
  protected muted = false;
  private gate = new VoiceGate();
  /** Silero, once loaded; until then (or if it cannot run) loudness. */
  private vad: SileroVad | null = null;
  private vadLoading = false;
  private vadQueue: Promise<void> = Promise.resolve();
  private lastSpeechAt = -Infinity;
  /** Recent frames: when, and whether each was speech. */
  private recent: Array<{ at: number; speech: boolean }> = [];
  /** The newest frame's time, for a source that counts samples; null on a
   *  source timed by the wall clock. */
  private frameClock: number | null = null;
  /** Bumped by resetDetection(), so frames still queued for Silero from
   *  before it are dropped rather than heard afterwards. */
  private epoch = 0;

  constructor(protected readonly source: FrameSource = new WebAudioFrameSource()) {}

  async open(): Promise<void> {
    if (this.source.opened) return;
    await this.source.open((frame, at, capturedAt) => this.capture(frame, at, capturedAt));
    // a source reopened mid-call ("Resume call") keeps the model it has, or
    // the one on its way
    if (this.vad || this.vadLoading) return;
    this.vadLoading = true;
    // onnxruntime is the heaviest thing a call needs and nothing else needs
    // it, so the model and its runtime arrive with the first open microphone
    // rather than with the app (spec §6). A chunk that fails to load is the
    // same as a model that cannot run: the loudness gate carries the call.
    void import("./silero-vad")
      .then(({ SileroVad }) => SileroVad.load())
      .catch(() => null)
      .then((vad) => {
        this.vadLoading = false;
        if (this.source.opened) this.vad = vad;
      });
  }

  private capture(frame: Float32Array, at?: number, capturedAt: number = Date.now()) {
    if (at !== undefined) this.frameClock = at;
    const level = this.muted ? 0 : rms(frame);
    if (this.levels.size) emit(this.levels, level);
    const vad = this.vad;
    if (!vad) {
      const change = this.gate.push(level);
      if (change) emit(this.voices, change === "start");
      if (!this.muted) this.frame(frame, level > VOICE_RMS, change, null, capturedAt);
      return;
    }
    // Speech, not sound: a beep or a keyboard is loud but is not the
    // owner. Frames are judged in order, a millisecond or so each.
    const epoch = this.epoch;
    this.vadQueue = this.vadQueue.then(async () => {
      if (epoch !== this.epoch) return;
      const p = this.muted ? 0 : await vad.push(frame).catch(() => 0);
      if (epoch !== this.epoch) return;
      const speech = level > SPEECH_FLOOR_RMS && p >= SPEECH_CONFIDENCE;
      const now = at ?? Date.now();
      // "was anyone speaking at all" uses a lower bar than "stop the bot",
      // so a quiet speaker's words are never thrown away as noise
      const any = level > SPEECH_FLOOR_RMS && p >= ANY_SPEECH_CONFIDENCE;
      if (any) this.lastSpeechAt = now;
      this.recent.push({ at: now, speech });
      while (this.recent.length && now - this.recent[0].at > 5_000) this.recent.shift();
      const change = this.gate.pushSpeech(speech);
      if (change) emit(this.voices, change === "start");
      if (!this.muted && this.source.opened) this.frame(frame, speech, change, { speech, any }, capturedAt);
    });
  }

  onLevel(fn: (rms: number) => void) {
    this.levels.add(fn);
    return () => this.levels.delete(fn);
  }

  /** One captured frame; `voiced` is speech (or, without a model, sound).
   *  `judged` is Silero's verdict on it at both bars, null without a model. */
  protected abstract frame(frame: Float32Array, voiced: boolean, change: "start" | "end" | null, judged: FrameSpeech | null, capturedAt: number): void;

  pending() {
    return false;
  }

  /** "Now": the newest frame's time on a sample-counting source, so a burst
   *  of frames or a hold does not skew the windows below. */
  private now() {
    return this.frameClock ?? Date.now();
  }

  speechWithin(ms: number): boolean | null {
    if (!this.vad) return null;
    return this.now() - this.lastSpeechAt <= ms;
  }

  /** How long ago the last speech frame was, null without a VAD or before any. */
  sinceSpeechMs(): number | null {
    if (!this.vad || !Number.isFinite(this.lastSpeechAt)) return null;
    return Math.max(0, this.now() - this.lastSpeechAt);
  }

  speechShare(ms: number): number | null {
    if (!this.vad) return null;
    const since = this.now() - ms;
    const frames = this.recent.filter((f) => f.at >= since);
    return frames.length ? frames.filter((f) => f.speech).length / frames.length : 0;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (muted) {
      // muted mid-speech: the voice has ended, as far as anyone listening
      // is concerned (a bot paused for it must not wait on it for good)
      if (this.gate.speaking) emit(this.voices, false);
      this.gate.reset();
      this.vad?.reset();
    }
  }

  resetDetection() {
    this.epoch += 1;
    this.gate.reset();
    this.vad?.reset();
    this.lastSpeechAt = -Infinity;
    this.recent = [];
  }

  onLine(fn: (line: MicLine) => void) {
    this.lines.add(fn);
    return () => this.lines.delete(fn);
  }
  onEnd(fn: (end: MicEnd) => void) {
    this.ends.add(fn);
    return () => this.ends.delete(fn);
  }
  onVoice(fn: (speaking: boolean) => void) {
    this.voices.add(fn);
    return () => this.voices.delete(fn);
  }

  close() {
    this.source.close();
    this.lines.clear();
    this.ends.clear();
    this.voices.clear();
  }
}

/** macOS: Apple's recognizer in the native helper, fed this audio. */
class AppleMic extends Capture implements CallMic {
  readonly kind = "apple" as const;
  readonly duplex = true;
  private live = false;
  private offLine: (() => void) | null = null;
  private offEnd: (() => void) | null = null;

  async open() {
    await super.open();
    const bridge = window.muragebox!;
    this.offLine = bridge.onSpeechTranscript((line) => emit(this.lines, line));
    this.offEnd = bridge.onSpeechEnd((end) => {
      this.live = false;
      emit(this.ends, end);
    });
  }

  async start(options: { endpointMs: number; endpointLongMs?: number; hints?: string[] }) {
    this.live = true;
    await window.muragebox!.speechStart({ endpointMs: options.endpointMs, endpointLongMs: options.endpointLongMs, fed: true, hints: options.hints });
  }

  async stop() {
    this.live = false;
    await window.muragebox!.speechStop();
  }

  protected frame(frame: Float32Array) {
    if (!this.live) return;
    const pcm = toInt16(frame);
    window.muragebox!.speechFeed?.(new Uint8Array(pcm.buffer));
  }

  close() {
    this.offLine?.();
    this.offEnd?.();
    if (this.live) void window.muragebox?.speechStop().catch(() => undefined);
    super.close();
  }
}


/** The Flux mic's end reasons for a transcription that did not come back. */
export const isTranscriptionFailure = (reason: string | undefined): boolean => typeof reason === "string" && reason.startsWith("transcription-");

/** Pause before the one retry of a transcription that failed to arrive. */
const TRANSCRIBE_RETRY_MS = 400;

/** A transcription with no answer this long ends as failed: just over the
 *  server's own 60 s limit, so it never cuts a slow answer short, only one
 *  that will never come. */
export const TRANSCRIBE_TIMEOUT_MS = 65_000;

/** Windows and Linux: find the utterance here, transcribe it through Flux. */
export class FluxMic extends Capture implements CallMic {
  readonly kind = "flux" as const;
  readonly duplex = true;
  private live = false;
  private recording: Int16Array[] | null = null;
  private preroll: Int16Array[] = [];
  /** Silero's verdict on each recorded frame, and on each preroll frame. */
  private judged: Array<FrameSpeech | null> = [];
  private prerollJudged: Array<FrameSpeech | null> = [];
  private silentFrames = 0;
  private endpointFrames = Math.round((850 * RATE) / 1000 / FRAME);
  /** The transcription in flight. */
  private inFlight: AbortController | null = null;
  /** Still hearing while a transcription is out. The owner often goes on
   *  after a pause ("Blues Brothers, ... Heartbreak Ridge"), and those words
   *  used to fall into the 1.5 s the microphone recorded nothing. They are
   *  kept here and picked up by the next start(). */
  private carrying = false;
  /** An utterance that began and ended while the last one was out. */
  private queued: { clip: Blob; speech: MicLine["speech"] | null; endedAt: number } | null = null;

  /** No partial transcript here (Flux transcribes after the clip), so the
   *  long window is accepted and unused: the base window applies flat. */
  async start(options: { endpointMs: number; endpointLongMs?: number }) {
    this.endpointFrames = Math.max(4, Math.round((options.endpointMs * RATE) / 1000 / FRAME));
    const carried = this.carrying;
    this.carrying = false;
    this.live = true;
    const queued = this.queued;
    this.queued = null;
    if (queued) {
      // said in full while the last line was out: transcribe it now
      this.live = false;
      this.carrying = true;
      this.recording = null;
      emit(this.lines, { text: "…", partial: true });
      void this.transcribe(queued.clip, queued.speech, queued.endedAt);
      return;
    }
    if (carried && this.recording) {
      // begun while the last line was out, and still going: carry on with it
      emit(this.lines, { text: "…", partial: true });
      return;
    }
    // the moments just before this start are the preroll, when they were heard
    this.silentFrames = 0;
    if (carried) return;
    this.recording = null;
    this.preroll = [];
    this.prerollJudged = [];
  }

  async stop() {
    this.live = false;
    this.carrying = false;
    this.queued = null;
    this.recording = null;
    this.inFlight?.abort();
    this.inFlight = null;
  }

  resetDetection() {
    super.resetDetection();
    this.recording = null;
    this.queued = null;
    this.preroll = [];
    this.prerollJudged = [];
    this.silentFrames = 0;
  }

  /** Muting drops a half-heard utterance: unmuted, the next one must not
   *  arrive spliced onto it, and nothing is pending while muted. */
  setMuted(muted: boolean) {
    super.setMuted(muted);
    if (!muted) return;
    this.recording = null;
    this.queued = null;
    this.judged = [];
    this.preroll = [];
    this.prerollJudged = [];
    this.silentFrames = 0;
  }

  /** An utterance is being recorded, or is out for transcription. */
  pending() {
    return this.recording !== null || this.inFlight !== null || this.queued !== null;
  }

  /** Take over an utterance another path began (StreamMic's fallback): the
   *  frames heard so far become the recording, and this recognizer's own
   *  endpoint ends and transcribes it, so a sentence cut by a stream fault is
   *  finished rather than cut. It is carried whether or not a start() is
   *  live, so a start() that comes while it is still being said goes on with
   *  it instead of starting over. */
  protected adoptUtterance(frames: Int16Array[], judged: Array<FrameSpeech | null>) {
    this.recording = [...frames];
    this.judged = [...judged];
    this.silentFrames = 0;
    this.carrying = true;
  }

  protected frame(frame: Float32Array, voiced: boolean, change: "start" | "end" | null, judged: FrameSpeech | null) {
    if (!this.live && !this.carrying) return;
    const pcm = toInt16(frame);
    if (!this.recording) {
      this.preroll.push(pcm);
      this.prerollJudged.push(judged);
      if (this.preroll.length > PREROLL_FRAMES) {
        this.preroll.shift();
        this.prerollJudged.shift();
      }
      if (change === "start") {
        this.recording = [...this.preroll];
        this.judged = [...this.prerollJudged];
        this.silentFrames = 0;
        // while the last line is out, its own "…" comes with the next start()
        if (this.live) emit(this.lines, { text: "…", partial: true });
      }
      return;
    }
    this.recording.push(pcm);
    this.judged.push(judged);
    this.silentFrames = voiced ? 0 : this.silentFrames + 1;
    if (this.silentFrames >= this.endpointFrames || this.recording.length >= MAX_UTTERANCE_FRAMES) {
      const clip = wavFrom(this.recording);
      const speech = utteranceSpeech(this.judged);
      this.recording = null;
      this.judged = [];
      if (!this.live) {
        // a whole utterance while the last one was out: it waits its turn,
        // and nothing more is kept until then
        this.queued = { clip, speech, endedAt: Date.now() };
        this.carrying = false;
        return;
      }
      this.live = false;
      this.carrying = true;
      this.preroll = [];
      this.prerollJudged = [];
      void this.transcribe(clip, speech, Date.now());
    }
  }

  private async transcribe(clip: Blob, speech: MicLine["speech"] | null, endedAt: number) {
    const controller = new AbortController();
    this.inFlight = controller;
    try {
      // One more try after a short backoff for a blip: a dropped tunnel or a
      // 5xx. A refusal (busy, too large, empty) is the server's answer and is
      // reported as it stands.
      let res: Response | null = null;
      let reached = false;
      let timedOut = false;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        // each attempt is bounded, and a stop() still aborts it
        const tries = new AbortController();
        const abort = () => tries.abort();
        controller.signal.addEventListener("abort", abort);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), TRANSCRIBE_TIMEOUT_MS)));
        try {
          const answer = await Promise.race([
            fetch("/api/voice/transcribe", {
              method: "POST",
              headers: { "content-type": "audio/wav", ...desktopCallerHeaders() },
              body: clip,
              signal: tries.signal,
            }),
            timeout,
          ]);
          if (answer === "timeout") {
            tries.abort();
            res = null;
            timedOut = true;
          } else res = answer;
          reached = true;
        } catch {
          res = null;
          if (controller.signal.aborted) return;
        } finally {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", abort);
        }
        if (timedOut) break; // it was reached and did not answer: failed, not tried again
        if (res && res.status < 500) break;
        if (attempt === 1) {
          await new Promise((resolve) => setTimeout(resolve, TRANSCRIBE_RETRY_MS));
          if (controller.signal.aborted) return;
        }
      }
      if (!res) {
        if (this.inFlight === controller) this.inFlight = null;
        emit(this.ends, { code: 1, reason: reached ? "transcription-failed" : "transcription-unreachable" });
        return;
      }
      const body = await res.json().catch(() => null);
      if (controller.signal.aborted) return;
      // answered: nothing is pending while the line is handled
      if (this.inFlight === controller) this.inFlight = null;
      if (!res.ok) {
        // the end names a transcription failure whatever the server called
        // it; the call says so and listens again (isTranscriptionFailure)
        emit(this.ends, { code: 1, reason: "transcription-failed" });
        return;
      }
      emit(this.lines, { text: typeof body?.text === "string" ? body.text : "", partial: false, ...(speech ? { speech } : {}), endedAt });
      emit(this.ends, { code: 0, reason: "completed" });
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  close() {
    this.inFlight?.abort();
    super.close();
  }
}

/**
 * The Mac helper opening the microphone itself, as calls did before 0.1.59:
 * no echo cancellation, so the call stays half duplex. Used only when the
 * renderer could not capture the microphone.
 */
class BridgeMic implements CallMic {
  readonly kind = "apple" as const;
  readonly duplex = false;
  /** The call's mute: while set, the helper is never started, so nothing
   *  is recorded, whatever the screen says. */
  private muted = false;
  async open() {}
  async start(options: { endpointMs: number; endpointLongMs?: number; hints?: string[] }) {
    if (this.muted) return;
    await window.muragebox?.speechStart({ endpointMs: options.endpointMs, endpointLongMs: options.endpointLongMs, hints: options.hints });
  }
  async stop() {
    await window.muragebox?.speechStop();
  }
  setMuted(muted: boolean) {
    this.muted = muted;
    if (muted) void Promise.resolve(window.muragebox?.speechStop()).catch(() => undefined);
  }
  onLine(fn: (line: MicLine) => void) {
    return window.muragebox?.onSpeechTranscript(fn) ?? (() => {});
  }
  onEnd(fn: (end: MicEnd) => void) {
    return window.muragebox?.onSpeechEnd(fn) ?? (() => {});
  }
  onVoice() {
    return () => {};
  }
  speechWithin() {
    return null;
  }
  speechShare() {
    return null;
  }
  sinceSpeechMs() {
    return null;
  }
  pending() {
    return false;
  }
  resetDetection() {}
  close() {}
}

export function createFallbackMic(): CallMic {
  return new BridgeMic();
}

/** The recognizer this machine should use for a call, or null for none. */
export function callMicKind(options: {
  appleSpeech: boolean;
  /** The harness can transcribe (Flux, or an own Groq or OpenAI key). */
  fluxConfigured: boolean;
  capture: boolean;
}): CallMic["kind"] | null {
  if (!options.capture) return null;
  if (options.appleSpeech) return "apple";
  if (options.fluxConfigured) return "flux";
  return null;
}

/** The call's microphone. `source` defaults to the desktop's getUserMedia
 *  capture; the iPhone's native path passes a NativeFrameSource. */
export function createCallMic(kind: CallMic["kind"], options: { source?: FrameSource } = {}): CallMic {
  return kind === "apple" ? new AppleMic(options.source) : new FluxMic(options.source);
}
