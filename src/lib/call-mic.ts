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

import { SileroVad, SPEECH_CONFIDENCE } from "./silero-vad";

export interface MicLine {
  text?: string;
  partial?: boolean;
  error?: string;
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
  start(options: { endpointMs: number; hints?: string[] }): Promise<void>;
  /** Stop recognising (the microphone itself stays open). */
  stop(): Promise<void>;
  /** Stop sending audio without ending the call. */
  setMuted(muted: boolean): void;
  onLine(fn: (line: MicLine) => void): () => void;
  onEnd(fn: (end: MicEnd) => void): () => void;
  /** Called with true while sustained speech is heard, false after it ends.
   *  The call screen uses it to stop the bot when the owner talks over it. */
  onVoice(fn: (speaking: boolean) => void): () => void;
  /** Whether speech (not just sound: Silero VAD) was heard within the last
   *  `ms`; null when no speech model runs here and only loudness is known. */
  speechWithin(ms: number): boolean | null;
  /** The share (0 to 1) of the last `ms` of audio that was speech; null
   *  without a speech model. Speech runs high; music trips the model now
   *  and then, so its share stays low. */
  speechShare(ms: number): number | null;
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

function emit<T>(set: Listener<T>, value: T) {
  for (const fn of [...set]) fn(value);
}

function toInt16(frame: Float32Array): Int16Array {
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

abstract class Capture {
  protected lines: Listener<MicLine> = new Set();
  protected ends: Listener<MicEnd> = new Set();
  protected voices: Listener<boolean> = new Set();
  protected muted = false;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: ScriptProcessorNode | null = null;
  private gate = new VoiceGate();
  /** Silero, once loaded; until then (or if it cannot run) loudness. */
  private vad: SileroVad | null = null;
  private vadQueue: Promise<void> = Promise.resolve();
  private lastSpeechAt = 0;
  /** Recent frames: when, and whether each was speech. */
  private recent: Array<{ at: number; speech: boolean }> = [];

  async open(): Promise<void> {
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
    void SileroVad.load().then((vad) => {
      if (this.stream) this.vad = vad;
    });
    this.node.onaudioprocess = (event) => {
      const frame = new Float32Array(event.inputBuffer.getChannelData(0));
      const level = this.muted ? 0 : rms(frame);
      const vad = this.vad;
      if (!vad) {
        const change = this.gate.push(level);
        if (change) emit(this.voices, change === "start");
        if (!this.muted) this.frame(frame, level > VOICE_RMS, change);
        return;
      }
      // Speech, not sound: a beep or a keyboard is loud but is not the
      // owner. Frames are judged in order, a millisecond or so each.
      this.vadQueue = this.vadQueue.then(async () => {
        const p = this.muted ? 0 : await vad.push(frame).catch(() => 0);
        const speech = level > SPEECH_FLOOR_RMS && p >= SPEECH_CONFIDENCE;
        // "was anyone speaking at all" uses a lower bar than "stop the bot",
        // so a quiet speaker's words are never thrown away as noise
        if (level > SPEECH_FLOOR_RMS && p >= ANY_SPEECH_CONFIDENCE) this.lastSpeechAt = Date.now();
        const now = Date.now();
        this.recent.push({ at: now, speech });
        while (this.recent.length && now - this.recent[0].at > 5_000) this.recent.shift();
        const change = this.gate.pushSpeech(speech);
        if (change) emit(this.voices, change === "start");
        if (!this.muted && this.stream) this.frame(frame, speech, change);
      });
    };
    source.connect(this.node);
    // a ScriptProcessor only runs while connected to an output; it writes
    // silence, so nothing is heard
    this.node.connect(this.context.destination);
  }

  /** One captured frame; `voiced` is speech (or, without a model, sound). */
  protected abstract frame(frame: Float32Array, voiced: boolean, change: "start" | "end" | null): void;

  speechWithin(ms: number): boolean | null {
    if (!this.vad) return null;
    return Date.now() - this.lastSpeechAt <= ms;
  }

  speechShare(ms: number): number | null {
    if (!this.vad) return null;
    const since = Date.now() - ms;
    const frames = this.recent.filter((f) => f.at >= since);
    return frames.length ? frames.filter((f) => f.speech).length / frames.length : 0;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (muted) {
      this.gate.reset();
      this.vad?.reset();
    }
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
    if (this.node) this.node.onaudioprocess = null;
    this.node?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    void this.context?.close().catch(() => undefined);
    this.node = null;
    this.stream = null;
    this.context = null;
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

  async start(options: { endpointMs: number; hints?: string[] }) {
    this.live = true;
    await window.muragebox!.speechStart({ endpointMs: options.endpointMs, fed: true, hints: options.hints });
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

/** Windows and Linux: find the utterance here, transcribe it through Flux. */
class FluxMic extends Capture implements CallMic {
  readonly kind = "flux" as const;
  readonly duplex = true;
  private live = false;
  private recording: Int16Array[] | null = null;
  private preroll: Int16Array[] = [];
  private silentFrames = 0;
  private endpointFrames = Math.round((850 * RATE) / 1000 / FRAME);
  private pending: AbortController | null = null;

  async start(options: { endpointMs: number }) {
    this.live = true;
    this.recording = null;
    this.preroll = [];
    this.silentFrames = 0;
    this.endpointFrames = Math.max(4, Math.round((options.endpointMs * RATE) / 1000 / FRAME));
  }

  async stop() {
    this.live = false;
    this.recording = null;
    this.pending?.abort();
    this.pending = null;
  }

  protected frame(frame: Float32Array, voiced: boolean, change: "start" | "end" | null) {
    if (!this.live) return;
    const pcm = toInt16(frame);
    if (!this.recording) {
      this.preroll.push(pcm);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
      if (change === "start") {
        this.recording = [...this.preroll];
        this.silentFrames = 0;
        emit(this.lines, { text: "…", partial: true });
      }
      return;
    }
    this.recording.push(pcm);
    this.silentFrames = voiced ? 0 : this.silentFrames + 1;
    if (this.silentFrames >= this.endpointFrames || this.recording.length >= MAX_UTTERANCE_FRAMES) {
      const clip = wavFrom(this.recording);
      this.recording = null;
      this.live = false;
      void this.transcribe(clip);
    }
  }

  private async transcribe(clip: Blob) {
    const controller = new AbortController();
    this.pending = controller;
    try {
      const res = await fetch("/api/voice/transcribe", {
        method: "POST",
        headers: { "content-type": "audio/wav" },
        body: clip,
        signal: controller.signal,
      });
      const body = await res.json().catch(() => null);
      if (controller.signal.aborted) return;
      if (!res.ok) {
        emit(this.lines, { error: body?.error ?? "transcription-failed" });
        emit(this.ends, { code: 1, reason: body?.reason ?? "transcription-failed" });
        return;
      }
      emit(this.lines, { text: typeof body?.text === "string" ? body.text : "", partial: false });
      emit(this.ends, { code: 0, reason: "completed" });
    } catch {
      if (controller.signal.aborted) return;
      emit(this.ends, { code: 1, reason: "transcription-unreachable" });
    } finally {
      if (this.pending === controller) this.pending = null;
    }
  }

  close() {
    this.pending?.abort();
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
  async open() {}
  async start(options: { endpointMs: number; hints?: string[] }) {
    await window.muragebox?.speechStart({ endpointMs: options.endpointMs, hints: options.hints });
  }
  async stop() {
    await window.muragebox?.speechStop();
  }
  setMuted() {}
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

export function createCallMic(kind: CallMic["kind"]): CallMic {
  return kind === "apple" ? new AppleMic() : new FluxMic();
}
