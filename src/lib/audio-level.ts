// Loudness for the call aura: a smoother the painter reads every frame, and
// the tap on the bot's voice. The bot speaks through HtmlAudioPlayer's own
// <audio> element (src/lib/tts/index.ts); the player announces each element
// and this file reads its loudness off a copy of its stream. Playback is
// never rerouted: on Chromium (Electron, Android WebView, Chrome) the tap is
// element.captureStream() into an AnalyserNode that connects to nothing, so
// the element keeps its own output and a context that suspends or closes
// can only freeze the aura. WebKit has no captureStream, and a
// createMediaElementSource tap would put the clip on the context's output
// for the rest of its life (silent once the context suspends, which on iOS
// it does on every interruption), so there the clip is not tapped at all
// and the painter's synthetic cadence stands in.

import { clipProgress } from "./call-aura";
import { onClipElement } from "./tts";

/** RMS of a frame of samples. */
export function rmsOf(samples: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/** Microphone or playback RMS to a 0..1 level: speech sits around 0.05 to
 *  0.25 RMS, so ordinary speech lands near 0.8 and shouting clips at 1. */
export function levelFromRms(rms: number, gain = 4): number {
  return Math.max(0, Math.min(1, rms * gain));
}

/**
 * Fast attack, slow release, independent of frame rate: a syllable lights
 * the aura at once and the light drains away over a few hundred
 * milliseconds rather than flickering with every sample.
 */
export class LevelSmoother {
  private value = 0;

  constructor(private readonly attackMs = 40, private readonly releaseMs = 260) {}

  /** Feed the latest raw level; `dtMs` is the time since the previous feed. */
  push(level: number, dtMs: number): number {
    const target = Math.max(0, Math.min(1, level));
    const tau = target > this.value ? this.attackMs : this.releaseMs;
    const k = tau <= 0 ? 1 : 1 - Math.exp(-Math.max(0, dtMs) / tau);
    this.value += (target - this.value) * k;
    if (this.value < 0.001) this.value = 0;
    return this.value;
  }

  get current(): number {
    return this.value;
  }

  reset() {
    this.value = 0;
  }
}

/** The slice of AudioContext this file uses, so tests can hand in a fake. */
export interface AuraAudioContext {
  readonly state: "suspended" | "running" | "closed" | string;
  resume(): Promise<void>;
  close(): Promise<void>;
  createMediaStreamSource(stream: AuraCapturedStream): AuraSourceNode;
  createAnalyser(): AuraAnalyserNode;
  addEventListener?(type: "statechange", fn: () => void): void;
  removeEventListener?(type: "statechange", fn: () => void): void;
}
/** What captureStream() hands back, as far as the tap needs it. */
export interface AuraCapturedStream {
  getAudioTracks(): ArrayLike<unknown>;
  addEventListener?(type: "addtrack", fn: () => void): void;
  removeEventListener?(type: "addtrack", fn: () => void): void;
}
/** An element that can hand out a copy of its stream (Chromium). */
type CapturableElement = HTMLMediaElement & { captureStream?: () => AuraCapturedStream };

export type TapRoute = "stream" | "none";

/** How a clip may be read: a captured stream where the element offers one
 *  (Chromium), otherwise not at all. There is deliberately no third route
 *  through createMediaElementSource, which reroutes playback. */
export function tapRoute(audio: HTMLMediaElement): TapRoute {
  return typeof (audio as CapturableElement).captureStream === "function" ? "stream" : "none";
}
export interface AuraSourceNode {
  connect(node: unknown): unknown;
  disconnect(): void;
}
export interface AuraAnalyserNode {
  fftSize: number;
  smoothingTimeConstant: number;
  connect(node: unknown): unknown;
  disconnect(): void;
  getFloatTimeDomainData(array: Float32Array): void;
}

const ANALYSER_FFT = 256;

/**
 * The bot's voice level. attach() while a call screen is up (one context
 * for all attachers); level() is the loudness of the clip playing now, 0
 * when nothing plays or nothing could be tapped. detach disconnects every
 * node and closes the context once the last attacher is gone, so a
 * hang-up leaves nothing behind. Nothing here ever writes to the element.
 */
/** The real context, or none where the page cannot tap an element anyway
 *  (WebKit, so iPhone): then no context is created and the audio session
 *  stays untouched. */
export function defaultAudioContext(): AuraAudioContext | null {
  const canTap = typeof HTMLMediaElement !== "undefined" && typeof (HTMLMediaElement.prototype as CapturableElement).captureStream === "function";
  return canTap && typeof AudioContext === "function" ? (new AudioContext() as unknown as AuraAudioContext) : null;
}

export class BotVoiceLevel {
  private context: AuraAudioContext | null = null;
  private attachers = 0;
  private offClips: (() => void) | null = null;
  private source: AuraSourceNode | null = null;
  private analyser: AuraAnalyserNode | null = null;
  private tapped: HTMLMediaElement | null = null;
  /** The captured stream still waiting for its audio track, and how to stop waiting. */
  private pending: { stream: AuraCapturedStream; onTrack: () => void } | null = null;
  /** The clip playing now, tapped or not, for the read-along's progress. */
  private current: HTMLMediaElement | null = null;
  private buffer = new Float32Array(ANALYSER_FFT);
  private readonly onState = () => {
    // interrupted mid-call (a route change, a system sound): come back
    if (this.context?.state === "suspended" && this.attachers > 0) void this.context.resume().catch(() => undefined);
  };

  constructor(
    private readonly create: () => AuraAudioContext | null = defaultAudioContext,
    private readonly clips: (fn: (audio: HTMLMediaElement) => void) => () => void = onClipElement,
  ) {}

  /** Start reading the bot's voice. Returns the detach. */
  attach(): () => void {
    this.attachers += 1;
    if (this.attachers === 1) {
      try {
        this.context = this.create();
      } catch {
        this.context = null;
      }
      if (this.context) {
        this.context.addEventListener?.("statechange", this.onState);
        void this.context.resume().catch(() => undefined);
        this.offClips = this.clips((audio) => {
          this.current = audio;
          this.tap(audio);
        });
      }
    }
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      this.attachers -= 1;
      if (this.attachers > 0) return;
      this.release();
      this.current = null;
      this.offClips?.();
      this.offClips = null;
      const context = this.context;
      this.context = null;
      if (context) {
        context.removeEventListener?.("statechange", this.onState);
        void context.close().catch(() => undefined);
      }
    };
  }

  /** Whether any attacher is live. */
  get attached(): boolean {
    return this.attachers > 0;
  }

  /** The element whose sound is being read, for tests. */
  get tappedElement(): HTMLMediaElement | null {
    return this.tapped;
  }

  private tap(audio: HTMLMediaElement) {
    const context = this.context;
    this.release();
    if (!context || context.state === "closed" || tapRoute(audio) !== "stream") return;
    let stream: AuraCapturedStream;
    try {
      stream = (audio as CapturableElement).captureStream!();
    } catch {
      // a tainted or already-captured element: the clip plays as before, unread
      return;
    }
    // from here the clip counts as heard: its silences are silences
    this.tapped = audio;
    // Chromium refuses a source for a stream with no audio track yet, and
    // the element is announced before its metadata lands: wait for the track
    if (stream.getAudioTracks().length > 0) {
      this.read(context, stream);
      return;
    }
    const onTrack = () => {
      if (this.pending?.stream !== stream) return;
      stream.removeEventListener?.("addtrack", onTrack);
      this.pending = null;
      if (this.tapped === audio && stream.getAudioTracks().length > 0) this.read(context, stream);
    };
    this.pending = { stream, onTrack };
    stream.addEventListener?.("addtrack", onTrack);
  }

  /** Hangs the analyser off a captured stream: a dead end, connected to no
   *  output, so it reads the sound without carrying it. */
  private read(context: AuraAudioContext, stream: AuraCapturedStream) {
    try {
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = ANALYSER_FFT;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);
      this.source = source;
      this.analyser = analyser;
    } catch {
      // a context that shut between the announcement and the track: unread
      this.source = null;
      this.analyser = null;
    }
  }

  private release() {
    if (this.pending) {
      this.pending.stream.removeEventListener?.("addtrack", this.pending.onTrack);
      this.pending = null;
    }
    try {
      this.source?.disconnect();
    } catch {
      // already gone
    }
    try {
      this.analyser?.disconnect();
    } catch {
      // already gone
    }
    this.source = null;
    this.analyser = null;
    this.tapped = null;
  }

  /** The loudness now, 0..1; 0 without a tapped clip or while it is paused. */
  level(): number {
    const analyser = this.analyser;
    if (!analyser || !this.tapped || this.tapped.paused || this.tapped.ended) return 0;
    analyser.getFloatTimeDomainData(this.buffer);
    return levelFromRms(rmsOf(this.buffer));
  }

  /** Where the clip playing now has got to, 0..1 by its own clock, or null
   *  when no element is playing (the native path, or between clips). */
  progress(chars: number): number | null {
    const audio = this.current;
    if (!audio || audio.ended || clipGone(audio)) return null;
    let bufferedEnd: number | null = null;
    try {
      const buffered = audio.buffered;
      if (buffered && buffered.length) bufferedEnd = buffered.end(buffered.length - 1);
    } catch {
      bufferedEnd = null;
    }
    return clipProgress({ currentTime: audio.currentTime, duration: audio.duration, bufferedEnd }, chars);
  }

  /** True while a clip is tapped: its level is the truth, pauses included.
   *  The painter falls back to a gentle synthetic cadence only while this is
   *  false (the iPhone's native player, where the page never hears the clip,
   *  and WebKit, where nothing may be tapped). */
  hearing(): boolean {
    return this.tapped !== null;
  }
}

/** A clip the player has torn down (`src = ""`): the src property then
 *  reflects the document's URL, only the attribute says it is gone. */
function clipGone(audio: HTMLMediaElement): boolean {
  if (typeof audio.getAttribute === "function") return !audio.getAttribute("src");
  return !audio.src;
}

/** The window's one tap on the bot's voice. */
export const botVoice = new BotVoiceLevel();

/** How long one partial transcript counts as the owner talking. Dictation
 *  reports a partial every few hundred milliseconds through a sentence, so
 *  the hold outlasts that gap and the wash stays up until the owner stops. */
export const OWNER_PULSE_MS = 450;

/**
 * The owner's voice. Fed by whichever signal this machine has: the
 * microphone's frame RMS on the browser and phone path (push), or, on the
 * Mac, one pulse per partial transcript (pulse), since dictation reports
 * words and not levels. Read each frame by the painter and the mood.
 */
export class OwnerVoiceLevel {
  private readonly smoother = new LevelSmoother(60, 800);
  private raw = 0;
  private rawAt = 0;
  private pulseUntil = 0;
  private lastAt = 0;
  /** When each pulse arrived, for the listening ripples. */
  private pulses: number[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** A microphone frame's RMS. */
  push(rms: number) {
    this.raw = levelFromRms(rms);
    this.rawAt = this.now();
  }

  /** A new partial transcript: the owner is talking. */
  pulse() {
    const at = this.now();
    this.pulseUntil = at + OWNER_PULSE_MS;
    this.pulses.push(at);
    if (this.pulses.length > 8) this.pulses.shift();
  }

  /** Pulses within the last `ms`. */
  recentPulses(ms: number): number[] {
    const since = this.now() - ms;
    this.pulses = this.pulses.filter((at) => at >= since);
    return this.pulses;
  }

  /** The smoothed level now, 0..1. */
  level(): number {
    const at = this.now();
    // the first read counts as one frame, so a pulse just before it shows
    const dt = this.lastAt ? at - this.lastAt : 16;
    this.lastAt = at;
    // a frame older than a quarter second is stale: the mic has gone quiet
    const mic = at - this.rawAt <= 250 ? this.raw : 0;
    const pulse = at < this.pulseUntil ? 0.9 : 0;
    return this.smoother.push(Math.max(mic, pulse), dt);
  }

  reset() {
    this.smoother.reset();
    this.raw = 0;
    this.pulseUntil = 0;
    this.pulses = [];
  }
}
