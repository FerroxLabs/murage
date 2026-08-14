// The speaker — one voice for the whole window.
//
// Deliberately a singleton: two bots talking over each other is never what
// anyone wants, so starting a new utterance cancels whatever was speaking.
// That single rule is also what makes barge-in work — call mode just calls
// stop() the moment the microphone hears you.
//
// Text is split into utterances by the HARNESS (/api/tts/prepare), not
// here. Both tiers need the same split, and the spoken-register transform
// is the piece most likely to be tuned against real transcripts — keeping
// it server-side means the local and hosted voices can never drift into
// saying different things, the same reasoning as the server-computed
// approval key.
import { DEFAULT_LOCAL_VOICE, synthesizeLocal } from "./local";

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

interface Prepared {
  provider: string;
  runsOn: "server" | "client";
  voice: string;
  utterances: string[];
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
    let plan: Prepared;
    try {
      plan = await this.prepare(text);
    } catch (e) {
      if (live()) this.set({ ...IDLE, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (!live()) return;
    if (!plan.utterances.length) {
      this.set(IDLE);
      return;
    }

    const voiceId = opts.voiceId || plan.voice || (plan.runsOn === "client" ? DEFAULT_LOCAL_VOICE : "");

    // Prefetch: render utterance n+1 while n is audible. This is what buys
    // hosted-voice responsiveness without holding a streaming socket open
    // for the whole turn — the only gap the listener hears is the first.
    let next: Promise<Blob> | null = this.render(plan, plan.utterances[0], voiceId);
    for (let i = 0; i < plan.utterances.length; i += 1) {
      const current = next;
      next = i + 1 < plan.utterances.length ? this.render(plan, plan.utterances[i + 1], voiceId) : null;
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
      this.set({ status: "speaking", botId: opts.botId, messageId: opts.messageId, caption: plan.utterances[i] });
      const finished = await this.play(blob, live);
      if (!finished || !live()) {
        next?.catch(() => {});
        return;
      }
    }
    if (live()) this.set(IDLE);
  }

  private async prepare(text: string): Promise<Prepared> {
    const res = await fetch("/api/tts/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error("couldn't reach the voice service");
    return (await res.json()) as Prepared;
  }

  private async render(plan: Prepared, text: string, voiceId: string): Promise<Blob> {
    if (plan.runsOn === "client") return synthesizeLocal(text, voiceId);
    const res = await fetch("/api/tts/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voiceId }),
    });
    // the harness decided mid-flight that this one belongs to the renderer
    // (the voice was switched while we were speaking) — just do it here
    if (res.status === 409) return synthesizeLocal(text, voiceId);
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
export { DEFAULT_LOCAL_VOICE, listLocalVoices, loadLocalVoice, onLocalVoiceProgress } from "./local";
export type { LoadProgress, LocalVoice } from "./local";
