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

const IDLE: SpeechSnapshot = { status: "idle" };

class Speaker {
  private snapshot: SpeechSnapshot = IDLE;
  private watchers = new Set<(s: SpeechSnapshot) => void>();
  /** bumped on every speak()/stop(); async work whose token is stale exits */
  private token = 0;
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;

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
    this.token += 1;
    this.teardownAudio();
    if (this.snapshot.status !== "idle") this.set(IDLE);
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

  /**
   * Speak a message. Resolves when it finishes, is interrupted, or fails —
   * never rejects, because a voice failing is a thing to show, not a thing
   * that should take a caller's turn down with it.
   */
  async speak(text: string, opts: SpeakOptions = {}): Promise<void> {
    this.stop();
    const mine = this.token;
    const live = () => this.token === mine;

    this.set({ status: "preparing", botId: opts.botId, messageId: opts.messageId });
    let utterances: string[];
    try {
      utterances = await this.prepare(text);
    } catch (e) {
      if (live()) this.set({ ...IDLE, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (!live()) return;
    if (!utterances.length) {
      this.set(IDLE);
      return;
    }

    // Prefetch: request utterance n+1 while n is audible. This is what buys
    // responsiveness without holding a streaming socket open for the whole
    // turn — the only gap the listener hears is the first.
    let next: Promise<Blob> | null = this.render(utterances[0], opts.voiceId);
    for (let i = 0; i < utterances.length; i += 1) {
      const current = next;
      next = i + 1 < utterances.length ? this.render(utterances[i + 1], opts.voiceId) : null;
      if (!current) break;
      let blob: Blob;
      try {
        blob = await current;
      } catch (e) {
        // swallow the prefetch we will never use, or the browser logs an
        // unhandled rejection for a request nobody is waiting on
        next?.catch(() => {});
        if (live()) this.set({ ...IDLE, error: e instanceof Error ? e.message : String(e) });
        return;
      }
      if (!live()) return;
      this.set({ status: "speaking", botId: opts.botId, messageId: opts.messageId, caption: utterances[i] });
      const finished = await this.play(blob, live);
      if (!finished || !live()) {
        next?.catch(() => {});
        return;
      }
    }
    if (live()) this.set(IDLE);
  }

  private async prepare(text: string): Promise<string[]> {
    const res = await fetch("/api/tts/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error("couldn't reach the voice service");
    const body = (await res.json()) as { ready: boolean; utterances: string[] };
    if (!body.ready) throw new Error("Add an ElevenLabs key in App Settings to turn on voice.");
    return body.utterances;
  }

  private async render(text: string, voiceId?: string): Promise<Blob> {
    const res = await fetch("/api/tts/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voiceId }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as { error?: string });
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
      const done = (ok: boolean) => {
        audio.onended = null;
        audio.onerror = null;
        resolve(ok);
      };
      audio.onended = () => done(true);
      // a clip that cannot decode should not strand the whole message
      audio.onerror = () => done(false);
      audio.play().catch(() => done(false));
    });
  }
}

export const speaker = new Speaker();
