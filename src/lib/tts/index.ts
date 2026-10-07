// The speaker — one voice for the whole window.
//
// Deliberately a singleton: two bots talking over each other is never what
// anyone wants, so starting a new utterance cancels whatever was speaking.
// That single rule is also what makes interrupting work — call mode just
// calls stop().
//
// Audio comes from the harness (POST /api/tts/speak), which holds the
// ElevenLabs key. The renderer never sees it, and never talks to
// ElevenLabs directly.
//
// Text is split into utterances by the harness too, next to the transform
// that produced it — it is the piece most likely to be tuned against real
// transcripts, and keeping it in one place is the same reasoning as the
// server-computed approval key.

import { desktopCallerHeaders } from "../live-events";

export type SpeechStatus = "idle" | "preparing" | "speaking";

export interface SpeechSnapshot {
  status: SpeechStatus;
  /** the sentences of this reply already heard, for the call screen's
   *  read-along; the ones still to come, as far as they are known */
  spoken?: string[];
  queued?: string[];
  /** what is being spoken, so the UI can show a stop button in the right place;
   *  after a failure, what failed, so the error shows where it was asked for */
  botId?: string;
  messageId?: string;
  /** the utterance currently audible — call mode shows it as a caption */
  caption?: string;
  error?: string;
}

interface SpeakOptions {
  voiceId?: string;
  botId?: string;
  messageId?: string;
  /** The first clip's sound started. */
  onPlaying?: () => void;
}

type TtsPrepareBody = { ready?: boolean; utterances?: string[]; error?: string };
type TtsErrorBody = { error?: string };

const IDLE: SpeechSnapshot = { status: "idle" };

/** Each <audio> the window's player creates, announced before it plays, so
 *  the call aura can read its loudness (src/lib/audio-level.ts). Listeners
 *  must not touch playback; the player goes on exactly as before. */
const clipWatchers = new Set<(audio: HTMLAudioElement) => void>();
export function onClipElement(fn: (audio: HTMLAudioElement) => void): () => void {
  clipWatchers.add(fn);
  return () => clipWatchers.delete(fn);
}

/** A clip that never starts, or stalls before "ended" fires, must not hang
 *  the call in "speaking" forever. */
export const CLIP_STALL_MS = 8_000;
/** Clips requested ahead of the one playing: one downloading while one plays.
 *  A turn's clips go out one after another, never as a burst (the service
 *  allows 60 speech requests per account per minute). */
export const PREFETCH_AHEAD = 2;
const CLIP_FAILED = "The generated voice clip couldn't be played.";
const VOICE_UNREACHABLE = "Murage couldn't reach its voice service. Try again in a moment.";
const VOICE_NO_ANSWER = "The voice service didn't answer. Try again in a moment.";

/** What to show when the harness refuses a voice request. Its own sentences
 *  ("Flux rejected the saved key...") are kept; a bare status, or the 404
 *  body it gives a request it will not place ("no such route"), is not. */
export function voiceFailure(status: number, said: unknown): string {
  const text = typeof said === "string" ? said.trim() : "";
  if (status === 404 || status === 403 || /^no such route$/i.test(text)) return VOICE_UNREACHABLE;
  return text || VOICE_NO_ANSWER;
}

/**
 * One sentence's audio, filling in as it downloads. Playing starts on the
 * first bytes rather than after the whole clip: measured 2026-09-23, OpenAI's
 * first audio comes in 0.5-1.2 s and the whole sentence in 1.4-3.3 s, xAI's
 * in 0.3 s and 1.1 s. Everything in between used to be silence.
 */
export class Incoming {
  readonly chunks: Uint8Array[] = [];
  done = false;
  failed = false;
  private waiters: Array<() => void> = [];

  constructor(readonly mime: string) {}

  static read(body: ReadableStream<Uint8Array>, mime: string, onFirstByte?: () => void): Incoming {
    const incoming = new Incoming(mime);
    const reader = body.getReader();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.byteLength) {
            if (!incoming.chunks.length) onFirstByte?.();
            incoming.chunks.push(value);
          }
          incoming.wake();
        }
      } catch {
        // aborted by stop(), or the connection dropped: keep what arrived
        incoming.failed = true;
      }
      incoming.done = true;
      incoming.wake();
    })();
    return incoming;
  }

  /** Resolves when more audio arrives or the download ends. */
  more(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private wake() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

export type Audible = Blob | Incoming;

/** When the first clip of a stream was asked for, answered (headers) and
 *  first heard arriving (epoch ms). For the call's timing line only. */
export interface ClipTiming {
  requestedAt: number;
  headersAt: number | null;
  firstByteAt: number | null;
}

/** How the first clip reached the player: the native player, MediaSource, or
 *  the whole clip as a blob first. */
export type PlayerKind = "native" | "mse" | "blob";

/**
 * How one clip ended (spec §4.3.4). "cut" is not the clip's fault: it was
 * interrupted (stop(), or native cutting it for a phone call, a route change
 * or background), so it ends the utterance loop but shows no error. Only
 * "failed" (undecodable, refused, or stalled) shows CLIP_FAILED.
 */
export type ClipOutcome = "ended" | "failed" | "cut";

/** Where the speaker's clips are heard. */
export interface ClipPlayer {
  /** True when every response body should be read as it downloads
   *  (Incoming), whatever MediaSource says. When false, render() streams
   *  only a type this window's MediaSource can play. */
  readonly streams: boolean;
  /** Plays one clip to its end. `held`: the speaker is paused, so the clip
   *  waits for resume() before it is heard. `onPlaying`: its sound started
   *  (or started again). Never rejects. */
  play(clip: Audible, live: () => boolean, opts: { held: boolean; onPlaying?: () => void }): Promise<ClipOutcome>;
  pause(): void;
  resume(): void;
  /** Drops the clip that is playing, settling its play() as "cut". */
  teardown(): void;
}

/** Whether this window can play `mime` while it downloads. */
function streamable(mime: string): boolean {
  try {
    return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(mime);
  } catch {
    return false;
  }
}

/**
 * The window's own <audio> element: voice messages, auto-speak, previews,
 * group calls and desktop calls. A downloading clip plays through
 * MediaSource when this window supports its type.
 */
export class HtmlAudioPlayer implements ClipPlayer {
  readonly streams = false;
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private settlePlayback: ((outcome: ClipOutcome) => void) | null = null;

  pause(): void {
    if (this.audio && !this.audio.paused) this.audio.pause();
  }

  resume(): void {
    if (this.audio?.paused && this.settlePlayback) void this.audio.play().catch(() => this.settlePlayback?.("failed"));
  }

  teardown(): void {
    // Pausing/removing an <audio> source does not reliably fire `ended` or
    // `error`. Resolve the play promise ourselves so every interrupted
    // speak() settles and call mode cannot leak a forever-pending task.
    if (this.settlePlayback) this.settlePlayback("cut");
    else this.teardownAudio();
  }

  private teardownAudio() {
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
      this.audio = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  /** "ended" when the clip finished, "cut" when it was interrupted, "failed"
   *  when it could not play or stalled. */
  play(clip: Audible, live: () => boolean, opts: { held: boolean; onPlaying?: () => void }): Promise<ClipOutcome> {
    return new Promise((resolve) => {
      if (!live()) return resolve("cut");
      this.teardownAudio();
      const source = clip instanceof Incoming ? new MediaSource() : null;
      const url = URL.createObjectURL(source ?? (clip as Blob));
      const audio = new Audio(url);
      this.audio = audio;
      this.objectUrl = url;
      for (const watch of [...clipWatchers]) {
        try {
          watch(audio);
        } catch {
          // a watcher's failure is never the clip's
        }
      }
      let settled = false;
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      const clearStall = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = null;
      };
      // (Re)armed on real progress ("playing", then every "timeupdate"
      // while it plays) and cleared while deliberately paused, so a clip
      // that never starts, or stalls before "ended" ever fires, gives up
      // instead of leaving the call stuck on "speaking" — but a long clip,
      // or a hold for the owner talking over the bot, is never cut short.
      const armStall = () => {
        clearStall();
        stallTimer = setTimeout(() => done("failed"), CLIP_STALL_MS);
      };
      const done = (outcome: ClipOutcome) => {
        if (settled) return;
        settled = true;
        clearStall();
        audio.onended = null;
        audio.onerror = null;
        audio.onplaying = null;
        audio.ontimeupdate = null;
        audio.onpause = null;
        if (this.settlePlayback === done) this.settlePlayback = null;
        if (this.audio === audio) this.teardownAudio();
        resolve(outcome);
      };
      this.settlePlayback = done;
      audio.onended = () => done("ended");
      // a clip that cannot decode should not strand the whole message
      audio.onerror = () => done("failed");
      audio.onplaying = () => {
        armStall();
        opts.onPlaying?.();
      };
      audio.ontimeupdate = armStall;
      audio.onpause = clearStall;
      if (source && clip instanceof Incoming) {
        source.addEventListener("sourceopen", () => void this.feed(source, clip, () => settled).catch(() => done("failed")), { once: true });
      }
      // held by pause() between clips: this one starts, and arms the stall
      // clock, on resume() instead (resume() calls this same audio.play())
      if (!opts.held) {
        audio.play().catch(() => done("failed"));
        armStall();
      }
    });
  }

  /** Hands a downloading clip to the player as its bytes arrive. */
  private async feed(source: MediaSource, clip: Incoming, over: () => boolean): Promise<void> {
    const buffer = source.addSourceBuffer(clip.mime);
    // mp3 carries no timestamps: play the pieces one after another
    buffer.mode = "sequence";
    let at = 0;
    for (;;) {
      if (over()) return;
      if (at < clip.chunks.length) {
        const pending = clip.chunks.slice(at);
        at = clip.chunks.length;
        const bytes = new Uint8Array(pending.reduce((n, c) => n + c.byteLength, 0));
        let offset = 0;
        for (const c of pending) {
          bytes.set(c, offset);
          offset += c.byteLength;
        }
        await new Promise<void>((resolve, reject) => {
          buffer.addEventListener("updateend", () => resolve(), { once: true });
          buffer.addEventListener("error", () => reject(new Error("the clip could not be decoded")), { once: true });
          buffer.appendBuffer(bytes);
        });
        continue;
      }
      if (clip.done) break;
      await clip.more();
    }
    if (over()) return;
    // nothing arrived at all: a failed clip, not a silent one
    if (!clip.chunks.length) throw new Error("no audio arrived");
    if (source.readyState === "open") source.endOfStream();
  }
}

/** A failed clip is skipped; this many failing back to back end the reply. */
const MAX_CLIPS_FAILED_IN_A_ROW = 2;
/** How long a skipped or failed clip's message stays up. */
const ERROR_SHOWN_MS = 4000;

export class Speaker {
  constructor(
    private readonly now: () => number = Date.now,
    /** Voice diagnostics: numbers only, never the words. */
    private readonly diag: (line: string) => void = (line) => console.warn(line),
  ) {}

  private snapshot: SpeechSnapshot = IDLE;
  private watchers = new Set<(s: SpeechSnapshot) => void>();
  /** bumped on every speak()/stop(); async work whose token is stale exits */
  private token = 0;
  private request: AbortController | null = null;
  private readonly html = new HtmlAudioPlayer();
  /** Set by useOutput(): the native call player while a native call is open. */
  private output: ClipPlayer | null = null;
  /** The player the speech in progress started with. */
  private current: ClipPlayer | null = null;

  subscribe(fn: (s: SpeechSnapshot) => void): () => void {
    this.watchers.add(fn);
    fn(this.snapshot);
    return () => this.watchers.delete(fn);
  }

  get state(): SpeechSnapshot {
    return this.snapshot;
  }

  private set(next: SpeechSnapshot) {
    this.snapshot = next;
    for (const watcher of [...this.watchers]) watcher(next);
  }

  /** True while this exact message is the one being spoken. */
  isSpeaking(messageId?: string): boolean {
    if (this.snapshot.status === "idle") return false;
    return messageId ? this.snapshot.messageId === messageId : true;
  }

  stop() {
    this.held = false;
    this.token += 1;
    this.request?.abort();
    this.request = null;
    // every interrupted play() settles "cut", so no speak() is left pending
    this.html.teardown();
    if (this.current && this.current !== this.html) this.current.teardown();
    this.current = null;
    if (this.snapshot.status !== "idle" || this.snapshot.error) this.set(IDLE);
  }

  /**
   * The owner talked over the bot: stop now. Playback is torn down and the
   * queued and in-flight clips are aborted in the same tick, so the bot is
   * quiet as soon as this returns. Returns the milliseconds that took (the
   * budget is 150), and logs it.
   */
  cut(): number {
    const started = this.now();
    this.stop();
    const took = this.now() - started;
    this.diag(`[voice-diag] barge-in stopped in ${took}ms`);
    return took;
  }

  /**
   * A short sound that is not speech: the instant acknowledgement. Plays
   * through the current output without touching the speech state, and ends
   * where the reply begins (a reply's first clip replaces it). Never rejects.
   */
  async cue(clip: Blob): Promise<void> {
    if (this.snapshot.status === "speaking") return;
    try {
      await (this.output ?? this.html).play(clip, () => this.snapshot.status !== "speaking", { held: false });
    } catch {
      // a cue is a courtesy; failing to play it must never matter
    }
  }

  /**
   * Hold the clip that is playing, without ending it. The call screen does
   * this the moment the owner seems to start talking and resumes if it was
   * a cough or a keyboard, not speech: LiveKit Agents' false-interruption
   * handling (voice/agent_activity.py, pause then resume after a timeout).
   * True when there was something to pause.
   */
  pause(): boolean {
    if (this.snapshot.status === "idle") return false;
    // held covers the gap between clips too: the next one waits for resume()
    this.held = true;
    (this.current ?? this.html).pause();
    return true;
  }

  /** Carry on from where pause() held it. */
  resume(): void {
    if (!this.held) return;
    this.held = false;
    (this.current ?? this.html).resume();
  }

  /** True while speech is held by pause(). */
  isPaused(): boolean {
    return this.held;
  }

  private held = false;

  /**
   * Where speech is heard from now on: the native call player (CallView's
   * begin(), after the native open resolves), or null for the window's own
   * <audio> (CallView's unmount cleanup, before callAudioClose). Speech
   * already under way keeps the player it started with, so a clip never
   * spans two players; CallView stops speech itself when the call ends.
   */
  useOutput(player: ClipPlayer | null): void {
    this.output = player;
  }

  /** Captured once per speak()/stream(): render() and every clip's play()
   *  in that utterance loop use the same player. */
  private begin(): ClipPlayer {
    this.current = this.output ?? this.html;
    return this.current;
  }

  /** End with an error that shows for a few seconds and then clears. */
  private fail(opts: SpeakOptions, message: string, mine: number) {
    this.set({ ...IDLE, botId: opts.botId, messageId: opts.messageId, error: message });
    setTimeout(() => {
      if (this.token === mine && this.snapshot.status === "idle" && this.snapshot.error === message) this.set(IDLE);
    }, ERROR_SHOWN_MS);
  }

  /**
   * Speak a message. Resolves when it finishes, is interrupted, or fails —
   * never rejects, because a voice failing is a thing to show, not a thing
   * that should take a caller's turn down with it.
   */
  async speak(text: string, opts: SpeakOptions = {}): Promise<void> {
    this.stop();
    const mine = this.token;
    const controller = new AbortController();
    this.request = controller;
    const live = () => this.token === mine && !controller.signal.aborted;
    const player = this.begin();

    this.set({ status: "preparing", botId: opts.botId, messageId: opts.messageId });
    let utterances: string[];
    try {
      utterances = await this.prepare(text, opts.voiceId, controller.signal, opts.botId);
    } catch (e) {
      if (live()) this.set({ ...IDLE, botId: opts.botId, messageId: opts.messageId, error: e instanceof Error ? e.message : String(e) });
      if (this.request === controller) this.request = null;
      return;
    }
    if (!live()) return;
    if (!utterances.length) {
      this.set(IDLE);
      if (this.request === controller) this.request = null;
      return;
    }

    // Prefetch: request utterance n+1 while n is audible. This is what buys
    // responsiveness without holding a streaming socket open for the whole
    // turn — the only gap the listener hears is the first.
    type Rendered = { blob: Audible; error?: never } | { blob?: never; error: unknown };
    const render = (utterance: string): Promise<Rendered> =>
      this.render(utterance, opts.voiceId, controller.signal, opts.botId, player).then(
        (blob) => ({ blob }),
        (error: unknown) => ({ error }),
      );
    // Sequential within a turn: the next request goes out once this one has
    // answered (the service allows 60 a minute per account, and a burst gets a
    // 429), and never more than PREFETCH_AHEAD are in flight.
    let next: Promise<Rendered> | null = render(utterances[0]);
    let failures = 0;
    for (let i = 0; i < utterances.length; i += 1) {
      const current = next;
      if (!current) break;
      const rendered = await current;
      next = i + 1 < utterances.length && live() ? render(utterances[i + 1]) : null;
      if ("error" in rendered) {
        const message = rendered.error instanceof Error ? rendered.error.message : String(rendered.error);
        failures += 1;
        if (!live()) return;
        if (failures >= MAX_CLIPS_FAILED_IN_A_ROW || i + 1 >= utterances.length) {
          this.fail(opts, message, mine);
          if (this.request === controller) this.request = null;
          // the sentence after this one may already be downloading: nobody
          // will play it, so stop it here (stop() cannot reach it any more)
          controller.abort();
          return;
        }
        // skip this clip: the rest of the reply still plays, and the next
        // clip's "speaking" state clears the message
        this.set({ status: "preparing", botId: opts.botId, messageId: opts.messageId, error: message });
        continue;
      }
      failures = 0;
      if (!live()) return;
      this.set({ status: "speaking", botId: opts.botId, messageId: opts.messageId, caption: utterances[i], spoken: utterances.slice(0, i), queued: utterances.slice(i + 1) });
      let sounded = false;
      const outcome = await player.play(rendered.blob, live, {
        held: this.held,
        onPlaying: () => {
          if (sounded) return;
          sounded = true;
          if (i === 0) opts.onPlaying?.();
        },
      });
      if (outcome !== "ended" || !live()) {
        // "cut" was not the clip's fault (a hold, a route change): no error
        if (live()) this.set(outcome === "failed" ? { ...IDLE, botId: opts.botId, messageId: opts.messageId, error: CLIP_FAILED } : IDLE);
        if (this.request === controller) this.request = null;
        controller.abort();
        return;
      }
    }
    if (live()) this.set(IDLE);
    if (this.request === controller) this.request = null;
  }

  /**
   * Speak sentences as they arrive rather than a finished message: the call
   * screen pushes each one the voice host streams, so the first is audible
   * while the rest are still being written. Sentence n+1 is rendered while n
   * plays, the same prefetch speak() uses.
   *
   * `done` resolves true when every pushed sentence was heard after end(),
   * false when interrupted or failed. It never rejects.
   */
  stream(opts: SpeakOptions = {}): {
    push(text: string): void;
    end(): void;
    done: Promise<boolean>;
    /** The sentences the listener actually heard, in order; one that was
     *  cut off part-way is included with "…" (what they heard of it). */
    heard(): string[];
    /** When the first clip began to sound (epoch ms), or null before. */
    playingAt(): number | null;
    /** Request, headers and first-byte times of the first clip; null until it is asked for. */
    firstClip(): ClipTiming | null;
    /** How the first clip was delivered; null until it has arrived. */
    player(): PlayerKind | null;
    /**
     * A short acknowledgement clip ("Let me have a look."), played before
     * anything real. It is the bot speaking for isSpeaking() and stop(), but
     * it is not part of the reply: never in heard(), the caption, spoken or
     * queued, and it does not move playingAt or fire onPlaying. Ignored once
     * a real piece was pushed; dropped if a real piece arrives before it
     * sounds; a cue already sounding plays out and the piece waits behind it.
     */
    cue(clip: Blob): Promise<void>;
    /** When the cue began to sound (epoch ms), or null if it did not. */
    cueAt(): number | null;
  } {
    this.stop();
    const mine = this.token;
    const controller = new AbortController();
    this.request = controller;
    const live = () => this.token === mine && !controller.signal.aborted;
    const player = this.begin();
    const queue: string[] = [];
    const played: string[] = [];
    let playing: string | null = null;
    let playingAt: number | null = null;
    const onPlaying = () => {
      if (playingAt === null) {
        playingAt = Date.now();
        opts.onPlaying?.();
      }
    };
    let ended = false;
    let wake: (() => void) | null = null;
    const poke = () => {
      wake?.();
      wake = null;
    };
    // The acknowledgement cue. `cueClip` waits to be handed to the player;
    // `cueTask` is its play() once handed over; `cueSounding` once heard.
    let pushedAny = false;
    let cueClip: Blob | null = null;
    let cueTask: Promise<ClipOutcome> | null = null;
    let cueSounding = false;
    let cueDropped = false;
    let cueAt: number | null = null;
    let cueSettled: (() => void) | null = null;
    const settleCue = () => {
      cueSettled?.();
      cueSettled = null;
    };
    // stop() aborts this controller; the loop may be parked waiting for the
    // next sentence, and must wake to see it has been interrupted
    controller.signal.addEventListener("abort", poke, { once: true });
    this.set({ status: "preparing", botId: opts.botId, messageId: opts.messageId });

    type Rendered = { text: string; blob?: Audible; error?: unknown };
    /** The sentences after the one playing: the one rendering, then the queue. */
    let rendering: string | null = null;
    const pendingTexts = () => (rendering ? [rendering, ...queue] : [...queue]);
    let firstTiming: ClipTiming | null = null;
    let firstKind: PlayerKind | null = null;
    const render = (text: string): Promise<Rendered> => {
      const clipTiming = firstTiming ? undefined : (firstTiming = { requestedAt: Date.now(), headersAt: null, firstByteAt: null });
      return this.render(text, opts.voiceId, controller.signal, opts.botId, player, clipTiming).then(
        (blob) => {
          if (clipTiming) firstKind = blob instanceof Incoming ? (player.streams ? "native" : "mse") : "blob";
          return { text, blob };
        },
        (error: unknown) => ({ text, error }),
      );
    };

    const run = async (): Promise<boolean> => {
      let next: Promise<Rendered> | null = null;
      let failures = 0;
      let lastFailure: string | null = null;
      for (;;) {
        if (!live()) return false;
        if (cueClip && !cueTask) {
          const clip = cueClip;
          cueClip = null;
          this.set({ status: "speaking", botId: opts.botId, messageId: opts.messageId });
          cueTask = player
            .play(clip, live, {
              held: this.held,
              onPlaying: () => {
                if (cueDropped || cueAt !== null) return;
                cueSounding = true;
                cueAt = Date.now();
              },
            })
            .finally(() => {
              cueSounding = false;
              // waiting for a real piece in silence is "preparing", not "speaking"
              if (live() && playing === null && this.snapshot.status === "speaking" && !this.snapshot.caption) {
                this.set({ status: "preparing", botId: opts.botId, messageId: opts.messageId });
              }
              settleCue();
              poke();
            });
        }
        if (!next) {
          if (!queue.length) {
            if (ended && !cueTask) break;
            if (ended && cueTask) {
              const outcome = await cueTask;
              cueTask = null;
              if (outcome === "cut" && !cueDropped) {
                if (live()) this.set(IDLE);
                controller.abort();
                return false;
              }
              continue;
            }
            await new Promise<void>((resolve) => (wake = resolve));
            continue;
          }
          rendering = queue[0];
          next = render(queue.shift()!);
        }
        const rendered = await next;
        rendering = queue.length ? queue[0] : null;
        next = queue.length ? render(queue.shift()!) : null;
        if (!live()) return false;
        if (rendered.error !== undefined || !rendered.blob) {
          const error = rendered.error;
          const message = error instanceof Error ? error.message : String(error ?? "the voice failed");
          failures += 1;
          if (failures >= MAX_CLIPS_FAILED_IN_A_ROW || (!next && !queue.length && ended)) {
            this.fail(opts, message, mine);
            controller.abort();
            return false;
          }
          // skip this sentence: the rest of the reply still plays
          lastFailure = message;
          this.set({ status: "preparing", botId: opts.botId, messageId: opts.messageId, error: message });
          continue;
        }
        failures = 0;
        lastFailure = null;
        this.set({ status: "speaking", botId: opts.botId, messageId: opts.messageId, caption: rendered.text, spoken: [...played], queued: pendingTexts() });
        if (cueTask) {
          // the cue is sounding: the piece (already downloading) waits behind it
          const cueOutcome = await cueTask;
          cueTask = null;
          if (!live()) return false;
          if (cueOutcome === "cut" && !cueDropped) {
            this.set(IDLE);
            controller.abort();
            return false;
          }
          this.set({ status: "speaking", botId: opts.botId, messageId: opts.messageId, caption: rendered.text, spoken: [...played], queued: pendingTexts() });
        }
        playing = rendered.text;
        const outcome = await player.play(rendered.blob, live, { held: this.held, onPlaying });
        playing = null;
        // A cut sentence reads like an interrupted one: what they heard of it.
        // So does one whose download broke part-way: native plays what arrived
        // and reports "ended", but the owner heard only the start of it
        // (callbar-rereview3.md A10).
        const broken = rendered.blob instanceof Incoming && rendered.blob.failed;
        if (outcome === "ended" && !broken) played.push(rendered.text);
        else played.push(`${rendered.text.replace(/[.!?]+$/, "")}…`);
        if (outcome !== "ended") {
          // A clip that failed, never started, or stalled without ever
          // firing "ended" must show the same failure speak() shows, not
          // leave the call thinking nothing went wrong (heard live: a
          // failed reply left the caption up with no sound and no error).
          // A "cut" (native stopped it for a hold or a route change) is
          // not the clip's fault and shows nothing.
          if (live()) this.set(outcome === "failed" ? { ...IDLE, botId: opts.botId, messageId: opts.messageId, error: CLIP_FAILED } : IDLE);
          controller.abort();
          return false;
        }
        if (!live()) return false;
      }
      // the last sentence failed and the reply ended there: say so briefly
      if (live() && lastFailure) this.fail(opts, lastFailure, mine);
      else if (live()) this.set(IDLE);
      return true;
    };
    const done = run().finally(() => {
      settleCue();
      if (this.request === controller) this.request = null;
    });
    return {
      push: (text: string) => {
        const clean = text.trim();
        if (!clean || ended || !live()) return;
        pushedAny = true;
        // a cue not yet sounding gives way to the real piece
        if (cueClip) {
          cueClip = null;
          settleCue();
        }
        if (cueTask && !cueSounding && !cueDropped) {
          cueDropped = true;
          player.teardown();
        }
        queue.push(clean);
        // the read-along shows what is still to come as it arrives
        if (this.snapshot.status === "speaking" && this.token === mine) this.set({ ...this.snapshot, queued: pendingTexts() });
        poke();
      },
      end: () => {
        ended = true;
        poke();
      },
      done,
      heard: () => (playing ? [...played, `${playing.replace(/[.!?]+$/, "")}…`] : [...played]),
      playingAt: () => playingAt,
      firstClip: () => (firstTiming ? { ...firstTiming } : null),
      player: () => firstKind,
      cue: (clip: Blob): Promise<void> => {
        if (pushedAny || cueTask || cueClip || cueAt !== null || !live()) return Promise.resolve();
        cueClip = clip;
        poke();
        return new Promise<void>((resolve) => {
          cueSettled = resolve;
        });
      },
      cueAt: () => cueAt,
    };
  }

  /** The whole clip for `text`, from /api/tts/speak. For short fixed phrases (the call's cue clips). */
  async fetchClip(text: string, opts: { botId?: string; voiceId?: string; signal?: AbortSignal }): Promise<Blob> {
    const res = await fetch("/api/tts/speak", {
      method: "POST",
      headers: { "content-type": "application/json", ...desktopCallerHeaders() },
      body: JSON.stringify({ text, voiceId: opts.voiceId, botId: opts.botId }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const body: TtsErrorBody = await res.json().catch(() => ({}));
      throw new Error(voiceFailure(res.status, body.error));
    }
    return res.blob();
  }

  // botId: the harness speaks with that agent's own voice service
  private async prepare(text: string, voiceId: string | undefined, signal: AbortSignal, botId?: string): Promise<string[]> {
    const res = await fetch("/api/tts/prepare", {
      method: "POST",
      headers: { "content-type": "application/json", ...desktopCallerHeaders() },
      body: JSON.stringify({ text, voiceId, botId }),
      signal,
    });
    const body: TtsPrepareBody = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(voiceFailure(res.status, body.error));
    if (!body.ready) {
      throw new Error("Set up a voice in a bot's settings on this computer, then pick a voice for the bot.");
    }
    return body.utterances ?? [];
  }

  /** Resolves as soon as the audio starts arriving; see Incoming. */
  private async render(text: string, voiceId: string | undefined, signal: AbortSignal, botId: string | undefined, player: ClipPlayer, timing?: ClipTiming): Promise<Audible> {
    const askedAt = this.now();
    const res = await fetch("/api/tts/speak", {
      method: "POST",
      headers: { "content-type": "application/json", ...desktopCallerHeaders() },
      body: JSON.stringify({ text, voiceId, botId }),
      signal,
    });
    if (!res.ok) {
      const body: TtsErrorBody = await res.json().catch(() => ({}));
      throw new Error(voiceFailure(res.status, body.error));
    }
    if (timing) timing.headersAt = Date.now();
    // the first byte as this window saw it, next to the harness's and the
    // gateway's own (x-murage-ttfb-ms, x-murage-flux-ttfb-ms): one line, times only
    const report = () => {
      const server = res.headers.get("x-murage-ttfb-ms");
      const flux = res.headers.get("x-murage-flux-ttfb-ms");
      this.diag(`[voice-diag] ttfb client=${this.now() - askedAt}ms server=${server ?? "n/a"}ms flux=${flux ?? "n/a"}ms length=${text.length}`);
    };
    const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    // the native player streams whatever the type, with or without MediaSource
    if (res.body && (player.streams || streamable(mime))) {
      return Incoming.read(res.body, mime, () => {
        if (timing) timing.firstByteAt ??= Date.now();
        report();
      });
    }
    const blob = await res.blob();
    if (timing) timing.firstByteAt = timing.headersAt;
    report();
    return blob;
  }
}

export const speaker = new Speaker();
