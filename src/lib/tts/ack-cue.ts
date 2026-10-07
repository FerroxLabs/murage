// The instant acknowledgement: a very short sound ("Mm.") in the bot's own
// voice, played the moment the owner finishes speaking or sending, so they
// know they were heard before any reply exists.
//
// It is made once per voice through the normal speech path (so it works on
// whatever engine and key the owner uses), then kept: in memory for the call,
// and in the browser's own store between launches. Playing it never touches
// the network, which is what keeps it under 100 ms.

import { desktopCallerHeaders } from "../live-events";
import { voiceFailure } from "./index";

export const ACK_TEXT = "Mm.";
/** Bump to drop cues made by an older recipe. */
const STORE_VERSION = "v1";

export interface CueStore {
  get(key: string): Promise<Blob | undefined>;
  set(key: string, clip: Blob): Promise<void>;
}

/** The browser's IndexedDB as a CueStore; every call is allowed to fail
 *  (private windows, blocked storage), in which case cues live in memory. */
export function indexedDbStore(): CueStore {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("murage-voice-cues", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("cues");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const run = async <T,>(mode: IDBTransactionMode, make: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const request = make(db.transaction("cues", mode).objectStore("cues"));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    get: async (key) => {
      const found = await run<unknown>("readonly", (store) => store.get(key));
      return found instanceof Blob ? found : undefined;
    },
    set: async (key, clip) => {
      await run("readwrite", (store) => store.put(clip, key));
    },
  };
}

/** The cue as the normal speech path makes it. */
async function fetchCue(botId: string | undefined, voiceId: string | undefined): Promise<Blob> {
  const res = await fetch("/api/tts/speak", {
    method: "POST",
    headers: { "content-type": "application/json", ...desktopCallerHeaders() },
    body: JSON.stringify({ text: ACK_TEXT, voiceId, botId }),
  });
  if (!res.ok) throw new Error(voiceFailure(res.status, undefined));
  return res.blob();
}

export class AckCues {
  private readonly cues = new Map<string, Blob>();
  private readonly priming = new Map<string, Promise<void>>();

  constructor(
    private readonly make: (botId: string | undefined, voiceId: string | undefined) => Promise<Blob> = fetchCue,
    private readonly store: CueStore | null = null,
  ) {}

  /** A voice's identity for caching: its id, else the bot that has the
   *  service's default. */
  key(botId: string | undefined, voiceId: string | undefined): string {
    return `${STORE_VERSION}:${voiceId || `bot:${botId ?? "default"}`}`;
  }

  has(botId: string | undefined, voiceId: string | undefined): boolean {
    return this.cues.has(this.key(botId, voiceId));
  }

  /**
   * Have this voice's cue ready: from the local store, else made once through
   * speech. Called when a call opens, never on the hot path. Never rejects; a
   * voice with no cue simply has no acknowledgement.
   */
  prime(botId: string | undefined, voiceId: string | undefined): Promise<void> {
    const key = this.key(botId, voiceId);
    if (this.cues.has(key)) return Promise.resolve();
    const running = this.priming.get(key);
    if (running) return running;
    const job = (async () => {
      try {
        const kept = await this.store?.get(key).catch(() => undefined);
        if (kept) {
          this.cues.set(key, kept);
          return;
        }
        const clip = await this.make(botId, voiceId);
        if (!clip.size) return;
        this.cues.set(key, clip);
        await this.store?.set(key, clip).catch(() => undefined);
      } catch {
        // no cue this time; the next call tries again
      } finally {
        this.priming.delete(key);
      }
    })();
    this.priming.set(key, job);
    return job;
  }

  /** Play the cue if it is cached, else nothing: no network, no waiting.
   *  True when a cue was started. */
  play(botId: string | undefined, voiceId: string | undefined, out: { cue(clip: Blob): Promise<void> }): boolean {
    const clip = this.cues.get(this.key(botId, voiceId));
    if (!clip) return false;
    void out.cue(clip);
    return true;
  }
}
