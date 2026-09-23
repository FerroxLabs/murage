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

export type SpeechStatus = "idle" | "preparing" | "speaking";

export interface SpeechSnapshot {
  status: SpeechStatus;
  /** what is being spoken, so the UI can show a stop button in the right place */
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
}

type TtsPrepareBody = { ready?: boolean; utterances?: string[]; error?: string };
type TtsErrorBody = { error?: string };

const IDLE: SpeechSnapshot = { status: "idle" };

export class Speaker {
  private snapshot: SpeechSnapshot = IDLE;
  private watchers = new Set<(s: SpeechSnapshot) => void>();
  /** bumped on every speak()/stop(); async work whose token is stale exits */
  private token = 0;
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private settlePlayback: ((finished: boolean) => void) | null = null;
  private request: AbortController | null = null;

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
    // Pausing/removing an <audio> source does not reliably fire `ended` or
    // `error`. Resolve the play promise ourselves so every interrupted
    // speak() settles and call mode cannot leak a forever-pending task.
    if (this.settlePlayback) this.settlePlayback(false);
    else this.teardownAudio();
    if (this.snapshot.status !== "idle" || this.snapshot.error) this.set(IDLE);
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
    if (this.audio && !this.audio.paused) this.audio.pause();
    return true;
  }

  /** Carry on from where pause() held it. */
  resume(): void {
    if (!this.held) return;
    this.held = false;
    if (this.audio?.paused && this.settlePlayback) void this.audio.play().catch(() => this.settlePlayback?.(false));
  }

  /** True while speech is held by pause(). */
  isPaused(): boolean {
    return this.held;
  }

  private held = false;

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

    this.set({ status: "preparing", botId: opts.botId, messageId: opts.messageId });
    let utterances: string[];
    try {
      utterances = await this.prepare(text, opts.voiceId, controller.signal);
    } catch (e) {
      if (live()) this.set({ ...IDLE, error: e instanceof Error ? e.message : String(e) });
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
    type Rendered = { blob: Blob; error?: never } | { blob?: never; error: unknown };
    const render = (utterance: string): Promise<Rendered> =>
      this.render(utterance, opts.voiceId, controller.signal).then(
        (blob) => ({ blob }),
        (error: unknown) => ({ error }),
      );
    let next: Promise<Rendered> | null = render(utterances[0]);
    for (let i = 0; i < utterances.length; i += 1) {
      const current = next;
      next = i + 1 < utterances.length ? render(utterances[i + 1]) : null;
      if (!current) break;
      const rendered = await current;
      if ("error" in rendered) {
        if (live()) {
          this.set({
            ...IDLE,
            error: rendered.error instanceof Error ? rendered.error.message : String(rendered.error),
          });
        }
        if (this.request === controller) this.request = null;
        return;
      }
      if (!live()) return;
      this.set({ status: "speaking", botId: opts.botId, messageId: opts.messageId, caption: utterances[i] });
      const finished = await this.play(rendered.blob, live);
      if (!finished || !live()) {
        if (live()) this.set({ ...IDLE, error: "The generated voice clip couldn't be played." });
        if (this.request === controller) this.request = null;
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
  } {
    this.stop();
    const mine = this.token;
    const controller = new AbortController();
    this.request = controller;
    const live = () => this.token === mine && !controller.signal.aborted;
    const queue: string[] = [];
    const played: string[] = [];
    let playing: string | null = null;
    let ended = false;
    let wake: (() => void) | null = null;
    const poke = () => {
      wake?.();
      wake = null;
    };
    // stop() aborts this controller; the loop may be parked waiting for the
    // next sentence, and must wake to see it has been interrupted
    controller.signal.addEventListener("abort", poke, { once: true });
    this.set({ status: "preparing", botId: opts.botId, messageId: opts.messageId });

    type Rendered = { text: string; blob?: Blob; error?: unknown };
    const render = (text: string): Promise<Rendered> =>
      this.render(text, opts.voiceId, controller.signal).then(
        (blob) => ({ text, blob }),
        (error: unknown) => ({ text, error }),
      );

    const run = async (): Promise<boolean> => {
      let next: Promise<Rendered> | null = null;
      for (;;) {
        if (!live()) return false;
        if (!next) {
          if (!queue.length) {
            if (ended) break;
            await new Promise<void>((resolve) => (wake = resolve));
            continue;
          }
          next = render(queue.shift()!);
        }
        const rendered = await next;
        next = queue.length ? render(queue.shift()!) : null;
        if (!live()) return false;
        if (rendered.error !== undefined || !rendered.blob) {
          const error = rendered.error;
          this.set({ ...IDLE, error: error instanceof Error ? error.message : String(error ?? "the voice failed") });
          return false;
        }
        this.set({ status: "speaking", botId: opts.botId, messageId: opts.messageId, caption: rendered.text });
        playing = rendered.text;
        const finished = await this.play(rendered.blob, live);
        playing = null;
        if (finished) played.push(rendered.text);
        else played.push(`${rendered.text.replace(/[.!?]+$/, "")}…`);
        if (!finished || !live()) return false;
      }
      if (live()) this.set(IDLE);
      return true;
    };
    const done = run().finally(() => {
      if (this.request === controller) this.request = null;
    });
    return {
      push: (text: string) => {
        const clean = text.trim();
        if (!clean || ended || !live()) return;
        queue.push(clean);
        poke();
      },
      end: () => {
        ended = true;
        poke();
      },
      done,
      heard: () => (playing ? [...played, `${playing.replace(/[.!?]+$/, "")}…`] : [...played]),
    };
  }

  private async prepare(text: string, voiceId: string | undefined, signal: AbortSignal): Promise<string[]> {
    const res = await fetch("/api/tts/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voiceId }),
      signal,
    });
    const body: TtsPrepareBody = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `the voice service returned ${res.status}`);
    if (!body.ready) {
      throw new Error("Set up a voice in a bot's settings on this computer, then pick a voice for the bot.");
    }
    return body.utterances ?? [];
  }

  private async render(text: string, voiceId: string | undefined, signal: AbortSignal): Promise<Blob> {
    const res = await fetch("/api/tts/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voiceId }),
      signal,
    });
    if (!res.ok) {
      const body: TtsErrorBody = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `the voice service returned ${res.status}`);
    }
    return res.blob();
  }

  /** Resolves true when the clip finished, false when it was interrupted. */
  private play(blob: Blob, live: () => boolean): Promise<boolean> {
    return new Promise((resolve) => {
      if (!live()) return resolve(false);
      this.teardownAudio();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.audio = audio;
      this.objectUrl = url;
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        audio.onended = null;
        audio.onerror = null;
        if (this.settlePlayback === done) this.settlePlayback = null;
        if (this.audio === audio) this.teardownAudio();
        resolve(ok);
      };
      this.settlePlayback = done;
      audio.onended = () => done(true);
      // a clip that cannot decode should not strand the whole message
      audio.onerror = () => done(false);
      // held by pause() between clips: this one starts on resume()
      if (!this.held) audio.play().catch(() => done(false));
    });
  }
}

export const speaker = new Speaker();
