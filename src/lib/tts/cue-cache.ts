// Pre-synthesized acknowledgement clips ("One sec."), fetched once at call
// start so a slow turn can cue at once instead of waiting on a provider
// round trip. Best effort: a failed fetch just means no cue for that phrase.
import { t } from "@/lib/i18n";
import type { AckKey } from "@/lib/call-ack";

type CueVoice = { botId: string; voiceId?: string; locale: string };

export class CueCache {
  private readonly clips = new Map<string, Blob>();

  constructor(
    private readonly fetchClip: (text: string, o: { botId: string; voiceId?: string }) => Promise<Blob>,
    private readonly max = 16,
  ) {}

  private keyOf(o: CueVoice & { key: AckKey }): string {
    return `${o.botId}|${o.voiceId ?? ""}|${o.locale}|${o.key}`;
  }

  /** Fetches each key in turn (never in parallel: a call start must not
   *  burst the speech provider). Never rejects. */
  async prewarm(o: CueVoice & { keys: AckKey[] }): Promise<void> {
    for (const key of o.keys) {
      const id = this.keyOf({ ...o, key });
      if (this.clips.has(id)) continue;
      try {
        const clip = await this.fetchClip(t(key), { botId: o.botId, voiceId: o.voiceId });
        this.store(id, clip);
      } catch {
        // no cue for this phrase; nothing to show
      }
    }
  }

  get(o: CueVoice & { key: AckKey }): Blob | null {
    const id = this.keyOf(o);
    const clip = this.clips.get(id);
    if (!clip) return null;
    this.clips.delete(id);
    this.clips.set(id, clip);
    return clip;
  }

  /** Keeps a clip that was fetched live, so the next turn finds it. */
  put(o: CueVoice & { key: AckKey }, clip: Blob): void {
    this.store(this.keyOf(o), clip);
  }

  private store(id: string, clip: Blob): void {
    this.clips.delete(id);
    this.clips.set(id, clip);
    while (this.clips.size > this.max) {
      const oldest = this.clips.keys().next().value;
      if (oldest === undefined) break;
      this.clips.delete(oldest);
    }
  }
}
