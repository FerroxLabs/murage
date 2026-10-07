// The iPhone's native call player (spec §4.3.4). During a native call the
// page makes no sound of its own (§4.3.3): each clip goes to the shell's
// CallAudioEngine in pieces through callAudioPlay, and plays through the
// same voice-processed engine as the microphone, so the echo canceller
// hears it. Native reports back with clip events on the session's
// callAudio stream, which CallView hands over from NativeFrameSource.

import { callNative, type CallAudioEvent } from "@/lib/native-shell";
import { CLIP_STALL_MS, Incoming, type Audible, type ClipOutcome, type ClipPlayer } from "./index";
import { normaliseMime } from "./mime";

/** Source bytes per piece: 64 KB, about 87 KB of base64, well inside
 *  native's 256 KB cap (spec §4.1). */
export const PIECE_BYTES = 64 * 1024;
/** Native refuses a longer clip id (spec §4.1). */
const MAX_CLIP_ID = 64;

/** Unique for each play() on the page, across players. */
let clips = 0;

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export interface NativeClipPlayerOptions {
  /** The open native session (NativeFrameSource.session). */
  session: string;
  /** The session's non-mic callAudio events (NativeFrameSource.onEvent).
   *  Returns the unsubscribe. */
  onEvent: (fn: (event: CallAudioEvent) => void) => () => void;
  /** For tests. */
  call?: typeof callNative;
}

/** The clip in flight: one at a time, as native requires. */
interface Clip {
  id: string;
  /** Held by pause(), or started held. Clip events do not arm the stall
   *  clock while this is set, so a hold never fails the reply. */
  paused: boolean;
  settled: boolean;
  settle(outcome: ClipOutcome): void;
  arm(): void;
  clear(): void;
}

export class NativeClipPlayer implements ClipPlayer {
  readonly streams = true;
  private readonly session: string;
  private readonly onEvent: NativeClipPlayerOptions["onEvent"];
  private readonly call: typeof callNative;
  private clip: Clip | null = null;

  constructor(opts: NativeClipPlayerOptions) {
    this.session = opts.session;
    this.onEvent = opts.onEvent;
    this.call = opts.call ?? callNative;
  }

  play(audible: Audible, live: () => boolean, opts: { held: boolean; onPlaying?: () => void }): Promise<ClipOutcome> {
    return new Promise((resolve) => {
      if (!live()) return resolve("cut");
      // the page never sends a second clip before the first has settled
      this.clip?.settle("cut");
      clips += 1;
      let stall: ReturnType<typeof setTimeout> | null = null;
      const clip: Clip = {
        id: `c${clips}-${this.session}`.slice(0, MAX_CLIP_ID),
        paused: opts.held,
        settled: false,
        settle: (outcome) => {
          if (clip.settled) return;
          clip.settled = true;
          clip.clear();
          off();
          if (this.clip === clip) this.clip = null;
          resolve(outcome);
        },
        // Same rule as the <audio> player: (re)armed by real progress,
        // cleared while deliberately paused.
        arm: () => {
          clip.clear();
          stall = setTimeout(() => {
            // Give up out loud too: the <audio> path tears its element down,
            // so native must drop the clip, or a late start would be heard
            // after the page has shown the error and moved on (spec §5).
            const current = this.clip === clip;
            clip.settle("failed");
            if (current) this.control("stop");
          }, CLIP_STALL_MS);
        },
        clear: () => {
          if (stall) clearTimeout(stall);
          stall = null;
        },
      };
      // subscribed before the first piece goes out, so no event is missed
      const off = this.onEvent((event) => {
        if (event.type !== "clip" || event.session !== this.session || event.clip !== clip.id) return;
        if (event.state === "playing" || event.state === "progress") {
          if (event.state === "playing") opts.onPlaying?.();
          if (!clip.paused) clip.arm();
        } else {
          clip.settle(event.state);
        }
      });
      this.clip = clip;
      // a clip that starts held arms its clock on resume() instead
      if (!clip.paused) clip.arm();
      // a Blob that cannot be read fails now, not when the stall clock fires
      void this.send(clip, audible).catch(() => clip.settle("failed"));
    });
  }

  /** Sends the clip's pieces in order, each after the previous one's reply. */
  private async send(clip: Clip, audible: Audible): Promise<void> {
    const mime = normaliseMime(audible instanceof Incoming ? audible.mime : audible.type);
    let seq = 0;
    const piece = async (bytes: Uint8Array, last: boolean): Promise<boolean> => {
      if (clip.settled) return false;
      const args: Record<string, unknown> = { session: this.session, clip: clip.id, seq, mime, bytes: base64(bytes), last };
      // held when the clip starts, or by a pause() before its first piece
      if (seq === 0 && clip.paused) args.paused = true;
      seq += 1;
      try {
        await this.call("callAudioPlay", args);
      } catch {
        // refused (unavailable, badArgs): the clip's failure, unless it was
        // already stopped, in which case settle() has made it "cut"
        clip.settle("failed");
        return false;
      }
      // Audio still arriving is a clip still alive. While a slow download
      // runs dry, native under-runs and sends no progress (spec §4.2.4), and
      // the clock used to fail the clip and drop the rest of the reply.
      if (!clip.settled && !clip.paused) clip.arm();
      return !clip.settled;
    };
    const pieces = async (bytes: Uint8Array, done: boolean): Promise<boolean> => {
      if (!bytes.byteLength) return done ? piece(bytes, true) : true;
      for (let at = 0; at < bytes.byteLength; at += PIECE_BYTES) {
        const end = Math.min(at + PIECE_BYTES, bytes.byteLength);
        if (!(await piece(bytes.subarray(at, end), done && end === bytes.byteLength))) return false;
      }
      return true;
    };

    if (!(audible instanceof Incoming)) {
      const bytes = new Uint8Array(await audible.arrayBuffer());
      if (!bytes.byteLength) return clip.settle("failed");
      await pieces(bytes, true);
      return;
    }
    let at = 0;
    for (;;) {
      if (clip.settled) return;
      // read before taking the chunks: once done, every chunk is in
      const done = audible.done;
      const fresh = audible.chunks.slice(at);
      at += fresh.length;
      if (!fresh.length && !done) {
        await audible.more();
        continue;
      }
      // nothing arrived at all: a failed clip, not a silent one. A download
      // that broke part-way still ends with last for what did arrive.
      if (done && seq === 0 && !fresh.length) return clip.settle("failed");
      if (!(await pieces(fresh.length ? concat(fresh) : new Uint8Array(), done))) return;
      if (done) return;
    }
  }

  pause(): void {
    const clip = this.clip;
    if (!clip) return;
    clip.paused = true;
    clip.clear();
    this.control("pause");
  }

  resume(): void {
    const clip = this.clip;
    if (!clip) return;
    clip.paused = false;
    clip.arm();
    this.control("resume");
  }

  teardown(): void {
    const clip = this.clip;
    if (!clip) return;
    clip.settle("cut");
    this.control("stop");
  }

  private control(action: "pause" | "resume" | "stop") {
    void this.call("callAudioControl", { session: this.session, action }).catch(() => undefined);
  }
}
