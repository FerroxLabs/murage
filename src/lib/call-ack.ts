// When the bot says a short cue ("Let me have a look.") on a slow turn.
// Pure: the call screens own the clip and the player, this only decides
// whether and when. At most one cue per turn, never once the real reply has
// started, and never after the turn is cancelled (barge-in, hang-up, a
// superseded turn).

/** No first text by this long after the send: the reply is slow. */
export const ACK_AFTER_MS = 1_300;

export const ACK_KEYS = ["calls.ack.look", "calls.ack.oneSec", "calls.ack.onIt", "calls.ack.checking"] as const;
export type AckKey = (typeof ACK_KEYS)[number];

/** A random cue that is never the one used for the turn before. */
export function pickAck(last: AckKey | null, random: () => number, keys: readonly AckKey[] = ACK_KEYS): AckKey {
  const others = keys.filter((key) => key !== last);
  const pool = others.length ? others : keys;
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
  return pool[index];
}

/** A cue clip fetched after it was asked for is dropped once it is this old:
 *  "One sec." after the answer has started is worse than silence. */
export const ACK_STALE_MS = 1_500;

/** Whether a cue that is ready may sound now. Pure; the call screens read
 *  their refs into it. `otherSpeech`: the bot is already saying something
 *  that is not this cue (a cue must never cut it off). `instantCued`: the
 *  instant cached cue already played for this turn, so at most one cue
 *  sounds. */
export function cueMayPlay(s: { live: boolean; superseded: boolean; held: boolean; realStarted: boolean; otherSpeech: boolean; closed: boolean; ageMs: number; instantCued?: boolean }): boolean {
  return !s.instantCued && s.live && !s.superseded && !s.held && !s.realStarted && !s.otherSpeech && !s.closed && s.ageMs <= ACK_STALE_MS;
}

/** The room's speech queue: inside the cue's own job its id is still queued,
 *  so only a second job counts as other speech. */
export function roomOtherSpeech(s: { queuedJobs: number; inJob: boolean; speaking: boolean }): boolean {
  return s.queuedJobs > (s.inJob ? 1 : 0) || s.speaking;
}

/** Where a call goes when its cue has ended and no real reply has started:
 *  out of "speaking" (which would change turn semantics and hide the lookup
 *  pulse) back to waiting. Null: leave the phase alone. */
export function phaseAfterCue(s: { live: boolean; realStarted: boolean; phase: string; busy: boolean }): "sending" | "working" | null {
  if (!s.live || s.realStarted || s.phase !== "speaking") return null;
  return s.busy ? "working" : "sending";
}

export class AckGate {
  private readonly fireKey: (key: AckKey) => void;
  private readonly afterMs: number;
  private readonly random: () => number;
  private readonly keys: readonly AckKey[];
  private last: AckKey | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private armed = false;
  private done = false;
  private real = false;

  constructor(opts: { fire: (key: AckKey) => void; afterMs?: number; last?: AckKey | null; random?: () => number; keys?: readonly AckKey[] }) {
    this.fireKey = opts.fire;
    this.afterMs = opts.afterMs ?? ACK_AFTER_MS;
    this.last = opts.last ?? null;
    this.random = opts.random ?? Math.random;
    this.keys = opts.keys ?? ACK_KEYS;
  }

  /** Arms the timer for this turn, counted from the moment the line was sent. */
  start(sentAt: number): void {
    this.clear();
    this.armed = true;
    this.done = false;
    this.real = false;
    const wait = Math.max(0, this.afterMs - (Date.now() - sentAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.go();
    }, wait);
  }

  /** The first real text arrived: the reply is on its way, so no cue. */
  realPiece(): void {
    this.real = true;
    this.clear();
  }

  /** The turn is known to be slow (an engine turn, a lookup): cue now. */
  slow(_reason: "engine" | "lookup"): void {
    this.go();
  }

  /** Barge-in, hang-up or a superseded turn: no cue from here on. */
  cancel(): void {
    this.armed = false;
    this.clear();
  }

  /** The key used last, for the next turn's gate. */
  get lastKey(): AckKey | null {
    return this.last;
  }

  get fired(): boolean {
    return this.done;
  }

  private go(): void {
    if (!this.armed || this.done || this.real) return;
    this.done = true;
    this.clear();
    const key = pickAck(this.last, this.random, this.keys);
    this.last = key;
    this.fireKey(key);
  }

  private clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
