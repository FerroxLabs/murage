// src/lib/stream-mic.ts
// The call's microphone on the streaming path (spec C.4). Everything FluxMic
// does (Silero, the voice gate, onVoice, preroll, the batch upload) is kept.
// On top: every frame goes to a 30 s ring and is teed to the Flux stream; each
// Flux turn.end becomes one final line; CallView's HeldLine and joinTurn decide
// what a whole turn is. A fault mid-turn hands the ring's audio to FluxMic's
// recorder, whose own endpoint finishes the sentence.
//
// All timing is this device's: each utterance runs from its Silero voice-gate
// start to its last Silero speech frame, stamped when the frame was CAPTURED
// (not when Silero got to it). Provider times only order messages (the spike
// found them hundreds of ms off).
import { MAX_SESSION_CLOSE_REASON, type ServerMessage } from "../../shared/flux-stream-contract";
import { CALL_ENDPOINT_LONG_MS, soundsUnfinished } from "./call-turns";
import { FluxMic, toInt16, utteranceSpeech, type FrameSource, type FrameSpeech, type MicEnd, type MicLine } from "./call-mic";
import { StreamUplink, UplinkRefused } from "./stream-uplink";

const FRAME_MS = 64;
const RING_FRAMES = Math.ceil(30_000 / FRAME_MS); // FluxMic's utterance cap
const START_QUEUE_FRAMES = Math.ceil(3_000 / FRAME_MS);
const PREROLL_MS = 384;
const KEEPALIVE_MS = 10_000;
const STALE_TURN_MS = 3_000;
const RECONNECT_WINDOW_MS = 60_000;
/** A fleet start cap with no retry_after_ms: wait this long before the next try. */
const CAP_BACKOFF_MS = 5_000;
/** Provider word times run up to about a second early (the spike), so a discard
 *  range reaches this far before the audio it covers. */
const DISCARD_SLACK_MS = 1_000;
/** A held turn is emitted anyway after this long, and a commit with no answer
 *  after this long is taken as lost (spec A.7 promises one within 1000 ms plus
 *  the backlog). */
const HOLD_BOUND_MS = 2_000;
/** Speech past a range's edge that counts as the owner speaking again: Silero's
 *  own voice-gate length (about 0.2 s), so a short "Yes." counts and a click does not. */
const SPOKE_AGAIN_FRAMES = 3;
/** Budgets per call (Astra I9): at most two faults (each may hand one sentence
 *  to batch, the bound spec A.14 discloses), and at most four connect attempts
 *  after the first, successful or not. */
const MAX_FAULTS = 2;
const MAX_ATTEMPTS = 4;
/** After a line that soundsUnfinished (a comma, an ellipsis, or a last word a
 *  clause cannot end on) the owner may go on: pending() stays true this long
 *  from the Silero speech end, so CallView's HeldLine keeps waiting. It is the
 *  call's long endpoint window, the same wait the batch path gives. */
export const STREAM_CONTINUATION_HOLD_MS = CALL_ENDPOINT_LONG_MS;
/** How long a handed sentence's batch line may hold back the lines said after
 *  it, from the end of its clip. It mirrors CallView's TRANSCRIPT_WAIT_MS (its
 *  wait for a transcription, from the voice end): past it the later lines go
 *  out, and the batch line follows late when it comes (H1). */
export const BATCH_LINE_WAIT_MS = 6_000;
/** A partial ending in . ? or ! plus this much Silero silence: ask Flux to end
 *  the turn now. Never on silence alone: that split every pause fixture. */
export const COMMIT_SILENCE_MS = 400;
/** Whether the punctuation turn.commit is sent. Built and tested, but shipped
 *  OFF (Sean's end-of-turn rule): Murage ends a turn only on the provider's
 *  turn.end, and never reads or thresholds `confidence`. */
export const STREAM_COMMIT = false;
/** Closes that mean "this path will not work on this call". */
const STAY_BATCH = new Set([4400, 4401, 4402, 4403, 4404, 4413, 4429]);
const TERMINAL = /[.?!]$/;
const ELLIPSIS = /(?:\.\.\.|…)$/;

type Uplink = Pick<StreamUplink, "connect" | "send" | "commit" | "keepalive" | "update" | "close" | "onMessage" | "onClose" | "live">;

interface RingFrame {
  pcm: Int16Array;
  judged: FrameSpeech | null;
  /** When the audio was captured (the source's sample clock mapped to epoch ms). */
  capturedAt: number;
  /** The stream it was handed to, and its position there (ms of audio sent on
   *  that stream before it); null while unsent (start queue, or refused under
   *  backpressure, when it stays here for a fallback). */
  uplink: Uplink | null;
  pos: number | null;
  /** The utterance this frame belongs to, if any. */
  utt: Utterance | null;
  /** The stream refused it (backpressure) or it fell off the start queue. */
  refused: boolean;
  /** Whether it counted as speech (Silero, or loudness without a model). */
  voiced: boolean;
}

/** One owner utterance on this device's clock (Astra I6). It is owned by the
 *  stream its first SENT frame went to, at that frame's position (Astra 3 I2):
 *  frames of it dropped from the start queue or refused under backpressure do
 *  not leave it unowned; the first of its frames that is sent decides. */
interface Utterance {
  start: number;
  lastSpeech: number;
  ended: boolean;
  owner: Uplink | null;
  firstPos: number | null;
  /** A provider turn ended while Silero still had it open: it is owed no
   *  line unless speech resumes, which makes it a continuation (Astra 3 I2). */
  consumed: boolean;
  /** A frame of it never reached the stream (refused, or past the start queue):
   *  the stream cannot give the whole sentence, so batch takes it (fix 8). */
  lost: boolean;
}

/** Audio on one stream that is not the stream's to say (a mute, or a hand-over
 *  to batch), in that stream's SENT positions. `open` while the commit that
 *  covers it is unanswered. */
interface DiscardRange {
  from: number;
  to: number;
  open: boolean;
}

/** State per stream: a draining or replacement stream keeps its own (Astra I8). */
interface StreamState {
  turn: number | null;
  lastTurnSeen: number;
  discardThrough: number;
  /** The one turn.commit awaiting its answer here (spec A.7: one sent while one
   *  is unanswered is covered by it and gets no answer of its own, so a second
   *  is never sent; M3). `at` is its barrier (the sent position when it went),
   *  `range` the discarded audio it answers for (null: a punctuation commit). */
  commit: { at: number; sentAt: number; range: DiscardRange | null } | null;
  /** The discarded audio. Until the answer, a range decides by position. The
   *  answer (`turn.committed {turn}`, or the forced `turn.end` it sends first)
   *  names the turn it ended: every turn over the audio before the barrier is
   *  at or below it, every later sentence above it, so from then on numbers
   *  decide (`discardThrough`) and only audio merged in after the barrier stays
   *  a range. A null answer means no turn ended in time (perhaps a slow
   *  provider), and the whole range stays, answered. */
  ranges: DiscardRange[];
  /** Turns judged once at their first sign, those thrown away, and those held
   *  (all their messages, in order) while their range cannot yet say whose
   *  they are: just short of an unanswered range's upper edge (the provider's
   *  early times make them ambiguous), or near an answered range's edge until
   *  their own end decides (M2). */
  seen: Set<number>;
  gone: Set<number>;
  answeredTurns: Set<number>;
  held: Map<number, { msgs: ServerMessage[]; since: number }>;
  holdTimer: ReturnType<typeof setTimeout> | null;
  committed: Set<number>;
  lastPartial: { turn: number; text: string } | null;
  offs: Array<() => void>;
  /** ms of audio sent on this stream; the next frame's position. */
  sentMs: number;
  /** Each contiguous range the server dropped (`audio_dropped` ranges, Astra 3
   *  I9): at `at` on the accepted clock, `ms` long, in order. */
  drops: Array<{ at: number; ms: number }>;
}

/** A sent position (ms of audio this client sent on the stream) on the server's
 *  accepted-audio clock (spec A.5): each dropped range before it shifts it
 *  back by its length; a position inside a dropped range never reached the
 *  provider and maps to the gap itself. */
export function acceptedPos(pos: number, drops: ReadonlyArray<{ at: number; ms: number }>): number {
  let shift = 0;
  for (const d of drops) {
    const sentStart = d.at + shift;
    if (pos < sentStart) break;
    if (pos < sentStart + d.ms) return d.at;
    shift += d.ms;
  }
  return pos - shift;
}

/** One final line (or a failed transcription's end) in speech order: `at` is
 *  when its speech began on this device's clock. A hand-over's slot is
 *  reserved when its audio goes to FluxMic's recorder and filled when the
 *  batch line (or its failure) comes back; until then every later sentence
 *  waits behind it (O1). */
interface Slot {
  at: number;
  line: MicLine | null;
  end: MicEnd | null;
  /** When a hand-over's clip was complete (null: still being said). */
  clipEnd: number | null;
}

/** Where a provider message says its turn began, on the server's clock. */
const startOf = (m: ServerMessage): number | null => (m.type === "speech.started" ? m.audio_ms : "audio_start_ms" in m ? m.audio_start_ms : null);

export class StreamMic extends FluxMic {
  private readonly makeUplink: () => Uplink;
  private mode: "stream" | "batch" = "stream";
  private uplink: Uplink | null = null;
  private draining: Uplink | null = null;
  private pendingSwitch: { next: Uplink | null; deadline: number; connecting: boolean; attachWhenReady: boolean } | null = null;
  private states = new Map<Uplink, StreamState>();
  /** Connects in flight: owned from the moment they start, so a hold or a
   *  hang-up cancels them rather than waiting for them to resolve (Astra 2 I8). */
  private opening = new Set<Uplink>();
  private generation = 0;
  private suspended = false;
  private closed = false;
  /** Listening for a line (start() .. the line or stop()), whatever the transport (Astra I7). */
  private listening = false;
  /** Every final line, stream or batch, waits here in speech order and leaves
   *  one per start() (the lines CallView ignores outside "listening" would
   *  otherwise be lost); a slot still waiting for its batch line holds back
   *  everything said after it. */
  private out: Slot[] = [];
  /** The slot of the clip FluxMic's recorder holds now: its next line or end. */
  private adopted: Slot | null = null;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private outLines = new Set<(line: MicLine) => void>();
  private outEnds = new Set<(end: MicEnd) => void>();
  /** FluxMic's final line waiting for its end, to be queued as one. */
  private batchLine: MicLine | null = null;
  /** A rollover replacement was refused with a retry_after: no reconnect before. */
  private retryUntil = 0;
  private hintOffs = new Map<Uplink, () => void>();
  /** Hand-overs that found FluxMic's recorder busy (one clip at a time): they
   *  wait here, and are adopted from the ring when it is free (N3). */
  private handBacklog: Array<{ hand: Utterance[]; at: number; slot: Slot }> = [];
  /** A deferred hand-over's sentence is still being said: keep its frames out of
   *  the stream (and FluxMic) until it ends. */
  private holdFeed = false;
  private ring: RingFrame[] = [];
  private startQueue: RingFrame[] = [];
  private utterances: Utterance[] = [];
  private lastHeardAt = 0;
  private lastStreamEvent = 0;
  private holdUntil = 0;
  private faults = 0;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setInterval> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastSentAt = 0;
  private dropped = 0;
  /** The status of the last refused connect (a 429 means batch for the call). */
  private lastRefusalStatus = 0;
  private lastRefusalReason: string | null = null;
  private lastRefusalRetryMs: number | null = null;
  /** This call must stay on batch (a plan refusal, a rate limit). */
  private stayBatch = false;
  /** FluxMic's recorder holds a hand-over: frames go to it, not to the stream,
   *  until it has heard its endpoint's worth of silence (fix 6 and 8). */
  private feedBatch = false;
  private feedSilent = 0;
  private batchEndpointFrames = Math.max(4, Math.round((850 * 16_000) / 1000 / 1024));
  private readonly commitEnabled: boolean;

  constructor(source?: FrameSource, makeUplink?: () => Uplink, options: { commit?: boolean } = {}) {
    super(source);
    this.makeUplink = makeUplink ?? (() => new StreamUplink());
    this.commitEnabled = options.commit ?? STREAM_COMMIT;
    // FluxMic's own lines (the batch path) reach the caller only through the
    // queue above; this is the one subscription to them
    super.onLine((line) => this.fromBatchLine(line));
    super.onEnd((end) => this.fromBatchEnd(end));
  }

  onLine(fn: (line: MicLine) => void) {
    this.outLines.add(fn);
    return () => this.outLines.delete(fn);
  }

  onEnd(fn: (end: MicEnd) => void) {
    this.outEnds.add(fn);
    return () => this.outEnds.delete(fn);
  }

  private fromBatchLine(line: MicLine) {
    if (line.partial === false) this.batchLine = line;
    else this.emitLine(line);
  }

  private fromBatchEnd(end: MicEnd) {
    const line = end.code === 0 ? this.batchLine : null;
    this.batchLine = null;
    const slot = this.adopted;
    this.adopted = null;
    if (slot) {
      // a hand-over's line, or its failure: it goes out in its own place
      slot.line = line;
      slot.end = end;
    } else this.place({ at: line?.endedAt ?? Date.now(), line, end, clipEnd: null }); // FluxMic's own (batch mode)
    // the next waiting hand-over goes to the recorder before this line goes out,
    // since CallView may call start() inside its end handler (I1)
    this.drainBacklog();
    this.flush();
  }

  /** Into the outbound queue in speech order. */
  private place(slot: Slot) {
    let i = this.out.length;
    while (i > 0 && this.out[i - 1].at > slot.at) i -= 1;
    this.out.splice(i, 0, slot);
  }

  private dropSlot(slot: Slot | null) {
    if (!slot) return;
    this.out = this.out.filter((s) => s !== slot);
    if (this.adopted === slot) this.adopted = null;
    this.flush();
  }

  /** The next line and its end, if CallView is listening and the next in
   *  speech order is ready. Listening is over after each. */
  private flush() {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    if (!this.listening) return;
    // a handed sentence whose batch line is overdue holds nothing back: the
    // lines after it go out, and it goes out late when it comes, never dropped (H1)
    const now = Date.now();
    let i = 0;
    while (i < this.out.length && !this.out[i].end && this.overdue(this.out[i], now)) i += 1;
    const next = this.out[i];
    if (!next) return;
    if (!next.end) {
      if (next.clipEnd !== null) this.releaseTimer = setTimeout(() => this.flush(), next.clipEnd + BATCH_LINE_WAIT_MS - now);
      return;
    }
    this.out.splice(i, 1);
    this.listening = false;
    if (next.line) this.emitLine(next.line);
    this.emitEnd(next.end);
  }

  private overdue(slot: Slot, now = Date.now()) {
    return !slot.end && slot.clipEnd !== null && now - slot.clipEnd >= BATCH_LINE_WAIT_MS;
  }

  /** A hand-over's clip is complete: its wait for the batch line runs from here. */
  private clipEnded(slot: Slot | null) {
    if (!slot || slot.clipEnd !== null) return;
    slot.clipEnd = Date.now();
    this.flush();
  }

  transport(): "stream" | "batch" {
    return this.mode;
  }

  async open() {
    await super.open();
    this.keepaliveTimer ??= setInterval(() => {
      if (this.uplink?.live && Date.now() - this.lastSentAt >= KEEPALIVE_MS) this.uplink.keepalive();
    }, 2_000);
    void this.connectFirst();
  }

  private query(): Record<string, string> {
    // Task 14 live sweep kept medium: it resolves to 400/1280 ms, which Flux sends explicitly
    // (docs/superpowers/results/2026-10-01-flux-stream-baseline.md)
    return { eagerness: "medium", partials: "true" };
  }

  /** A connect under the current generation; anything that resolves after a
   *  hang-up or a hold is closed at once. */
  private async connect(replace = false): Promise<Uplink | null> {
    const generation = this.generation;
    const uplink = this.makeUplink();
    this.opening.add(uplink);
    this.lastRefusalStatus = 0;
    this.lastRefusalReason = null;
    this.lastRefusalRetryMs = null;
    try {
      await uplink.connect(this.query(), { replace });
    } catch (error) {
      if (generation === this.generation) {
        const refused = error as Partial<UplinkRefused>;
        this.lastRefusalStatus = refused.status ?? 0;
        this.lastRefusalReason = refused.reason ?? null;
        this.lastRefusalRetryMs = refused.retryAfterMs ?? null;
        console.warn(`[call-diag] stream: unavailable (${refused.reason ?? "connect"})`);
      }
      return null;
    } finally {
      this.opening.delete(uplink);
    }
    if (generation !== this.generation || this.suspended) {
      uplink.close();
      return null;
    }
    return uplink;
  }

  private attach(uplink: Uplink) {
    this.hintOffs.get(uplink)?.();
    this.hintOffs.delete(uplink);
    const state: StreamState = { turn: null, lastTurnSeen: -1, discardThrough: -1, commit: null, ranges: [], seen: new Set(), gone: new Set(), answeredTurns: new Set(), held: new Map(), holdTimer: null, committed: new Set(), lastPartial: null, offs: [], sentMs: 0, drops: [] };
    // state and ownership first: subscribing flushes messages the uplink held
    // (a final, an expiry notice, an error), and they need both (Astra 2 I6)
    this.states.set(uplink, state);
    this.uplink = uplink;
    this.mode = "stream";
    state.offs.push(uplink.onMessage((m) => this.onStream(m, uplink)), uplink.onClose(({ code, error }) => this.onClosed(code, uplink, error)));
    if (this.uplink !== uplink) return; // a held close already ended it
    for (const f of this.startQueue.splice(0)) this.sendFrame(f);
    this.handOverLost();
    console.warn("[call-diag] stream: live");
  }

  private detach(uplink: Uplink | null) {
    if (!uplink) return;
    for (const off of this.states.get(uplink)?.offs ?? []) off();
    this.states.delete(uplink);
  }

  private async connectFirst() {
    const generation = this.generation;
    const uplink = await this.connect();
    if (uplink) this.attach(uplink);
    else if (generation === this.generation && !this.suspended) this.connectFailed("connect");
  }

  /** The first connect (or the resume) did not come up. A fleet start cap
   *  arrives as an `error` and a 4503 close AFTER connect (the harness accepts
   *  the page socket first), so it is handled in onClosed, never here. Here
   *  every refusal is batch for the call; speech while connecting goes to
   *  batch whole. */
  private connectFailed(why: string) {
    if (this.refusedBusy()) {
      // the previous stream's slot is still releasing (a quick resume or redial): retry, do not give up the call
      this.toBatch(why, true);
      this.scheduleReconnect(this.lastRefusalRetryMs ?? CAP_BACKOFF_MS);
      return;
    }
    this.stayBatch = true;
    this.toBatch(why, true);
  }

  /** The last connect was refused 429 "busy": a transient one-stream-per-principal clash. */
  private refusedBusy(): boolean {
    return this.lastRefusalStatus === 429 && this.lastRefusalReason === "busy";
  }

  async start(options: { endpointMs: number; endpointLongMs?: number; hints?: string[] }) {
    this.batchEndpointFrames = Math.max(4, Math.round((options.endpointMs * 16_000) / 1000 / 1024));
    // listening from the call, not from when FluxMic's start settles: a
    // hand-over adopted meanwhile (CallView calls this inside its end handler,
    // while the last line's end is still going out) must see FluxMic's start as
    // this call's, never as a stale one to let go of (I1)
    this.listening = true;
    await super.start(options); // unchanged: the batch fallback keeps Track C's timing
    if (this.out.length) queueMicrotask(() => this.flush());
    this.drainBacklog();
  }

  async stop() {
    this.listening = false;
    const stopped = super.stop(); // aborts FluxMic's transcription in flight: that line never comes
    this.dropSlot(this.adopted);
    await stopped;
  }

  pending() {
    const waiting = this.out.some((s) => !this.overdue(s)) || this.handBacklog.length > 0;
    if (this.mode === "batch") return super.pending() || waiting;
    if (super.pending() || waiting) return true; // a hand-over is with FluxMic's recorder, or a line waits
    const turnOpen = [...this.states.values()].some((st) => st.turn !== null || st.held.size > 0);
    return turnOpen || this.utterances.some((u) => !u.consumed) || Date.now() < this.holdUntil;
  }

  setMuted(muted: boolean) {
    super.setMuted(muted); // FluxMic drops a half-heard utterance on mute; so does the stream
    if (muted) this.discardOpenTurns();
  }

  resetDetection() {
    super.resetDetection();
    this.discardOpenTurns();
    // a transcription still out lands later as a line of its own
    this.out = [];
    this.adopted = null;
  }

  /** Every stream's open turn (current and draining) is committed and its line
   *  dropped; audio not yet sent is dropped here, so nothing said before the
   *  mute is sent after it (Astra 2 I7). */
  private discardOpenTurns() {
    this.startQueue = [];
    for (const b of this.handBacklog.splice(0)) this.dropSlot(b.slot);
    this.holdFeed = false;
    this.feedBatch = false;
    // FluxMic dropped a clip it was still recording or holding; one already
    // out for transcription still answers
    if (!super.pending()) this.dropSlot(this.adopted);
    for (const [uplink, st] of this.states) {
      if (st.turn !== null || this.utterances.some((u) => u.owner === uplink)) {
        // what was sent so far is discarded, whatever turns the provider makes
        // of it; the commit only stops later speech merging in
        if (st.turn !== null) st.discardThrough = Math.max(st.discardThrough, st.turn);
        this.discardRange(uplink, st, 0, st.sentMs);
      }
      st.turn = null;
      st.lastPartial = null;
    }
    this.utterances = [];
    this.holdUntil = 0;
  }


  suspend() {
    this.suspended = true;
    this.generation += 1; // a connect in flight is closed when it resolves (Astra I8)
    if (this.reconnectTimer) clearInterval(this.reconnectTimer);
    this.reconnectTimer = null;
    this.closeAll();
    this.startQueue = [];
    this.utterances = [];
    console.warn("[call-diag] stream: closed (hold)");
  }

  async resume() {
    if (this.closed || !this.suspended) return;
    this.suspended = false;
    if (this.mode !== "stream") {
      // a fault's reconnect was cancelled by the hold: it comes back with the call
      if (!this.stayBatch && this.faults < MAX_FAULTS && this.attempts < MAX_ATTEMPTS) this.scheduleReconnect();
      return;
    }
    const generation = this.generation; // a hold or close meanwhile makes this result stale
    const uplink = await this.connect();
    if (uplink) this.attach(uplink);
    else if (generation === this.generation && !this.suspended) this.connectFailed("resume");
  }

  close() {
    this.closed = true;
    this.generation += 1;
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    if (this.reconnectTimer) clearInterval(this.reconnectTimer);
    this.keepaliveTimer = this.reconnectTimer = null;
    this.closeAll();
    super.close();
    this.outLines.clear();
    this.outEnds.clear();
    this.handBacklog = [];
    this.out = [];
    this.adopted = null;
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
  }

  /** Every stream this mic owns: live, draining, a ready replacement, and any
   *  still connecting (their connect is cancelled). */
  private closeAll() {
    for (const u of [this.uplink, this.draining, this.pendingSwitch?.next ?? null, ...this.opening]) {
      if (!u) continue;
      this.detach(u);
      u.close();
    }
    this.opening.clear();
    this.uplink = this.draining = null;
    this.pendingSwitch = null;
  }

  // ── frames ──
  protected frame(frame: Float32Array, voiced: boolean, change: "start" | "end" | null, judged: FrameSpeech | null, capturedAt = Date.now()) {
    // Capture always passes the capture time; the default only keeps this a valid
    // override of FluxMic.frame, whose own signature is shorter
    const entry: RingFrame = { pcm: toInt16(frame), judged, capturedAt, uplink: null, pos: null, utt: null, refused: false, voiced };
    this.ring.push(entry);
    if (this.ring.length > RING_FRAMES) this.ring.shift();
    const speech = judged?.speech || (judged === null && voiced);
    if (speech) this.lastHeardAt = capturedAt;
    if (this.holdFeed && this.mode === "stream") {
      this.feedSilent = voiced ? 0 : this.feedSilent + 1;
      if (this.feedSilent >= this.batchEndpointFrames) {
        this.holdFeed = false;
        for (const b of this.handBacklog) this.clipEnded(b.slot);
      }
      return;
    }
    // FluxMic's recorder owns the audio (batch for now, or a hand-over it has
    // not finished): nothing is tracked or teed here, so nothing is said twice
    if (this.mode === "batch" || this.feedBatch) {
      super.frame(frame, voiced, change, judged);
      if (this.feedBatch) {
        this.feedSilent = voiced ? 0 : this.feedSilent + 1;
        if (this.feedSilent >= this.batchEndpointFrames) {
          this.feedBatch = false;
          this.clipEnded(this.adopted);
        }
      }
      return;
    }
    if (change === "start") {
      // the frames before the voice gate opened are part of it (FluxMic's preroll):
      // one the stream refused means the stream cannot give its first word
      const onsetRefused = this.ring.some((f) => f.refused && f.capturedAt >= capturedAt - PREROLL_MS);
      const began: Utterance = { start: capturedAt, lastSpeech: capturedAt, ended: false, owner: null, firstPos: null, consumed: false, lost: onsetRefused };
      this.utterances.push(began);
      // its onset (the preroll) is its own: a clip of another sentence never takes it
      for (let i = this.ring.length - 1; i >= 0 && this.ring[i].capturedAt >= capturedAt - PREROLL_MS; i -= 1) this.ring[i].utt ??= began;
      this.holdUntil = 0;
    }
    let current = this.utterances.at(-1);
    if (current && current.consumed && speech && change !== "start") {
      // speech resumed after the provider ended its turn: the rest is a
      // continuation, a new utterance timed and owned from here. The first
      // part, which has its line, keeps its own tag so no clip repeats it, and
      // leaves the books: a cancel or a turn-only hand-over is the
      // continuation's business, never its (M4)
      current.ended = true;
      const first = current;
      this.utterances = this.utterances.filter((u) => u !== first);
      current = { start: capturedAt, lastSpeech: capturedAt, ended: false, owner: null, firstPos: null, consumed: false, lost: false };
      this.utterances.push(current);
    }
    if (current && (!current.ended || change === "end")) entry.utt = current;
    if (speech && current && !current.ended) current.lastSpeech = capturedAt;
    if (change === "end" && current) {
      current.ended = true;
      if (current.consumed) this.utterances = this.utterances.filter((u) => u !== current); // nothing followed its turn
    }
    // FluxMic's "…" says an utterance began; CallView holds the bot on it
    if (change === "start" && this.listening) this.emitLine({ text: "…", partial: true });
    if (!this.suspended) this.toStream(entry);
    this.handOverLost();
    this.maybeCommit(capturedAt);
    this.maybeSwitch(capturedAt);
    this.dropStale(capturedAt);
  }

  private dropStale(now: number) {
    // an onset whose words never came: forgotten once nothing has happened for a while
    const st = this.uplink ? this.states.get(this.uplink) : undefined;
    if (now - Math.max(this.lastStreamEvent, this.lastHeardAt) <= STALE_TURN_MS) return;
    if (st) st.turn = null;
    this.utterances = this.utterances.filter((u) => !u.ended);
  }

  private toStream(entry: RingFrame) {
    if (!this.uplink?.live) {
      this.startQueue.push(entry);
      if (this.startQueue.length > START_QUEUE_FRAMES) {
        const gone = this.startQueue.shift();
        if (gone) gone.refused = true;
        if (gone?.utt) gone.utt.lost = true;
        this.dropped += 1;
      }
      return;
    }
    this.sendFrame(entry);
  }

  private sendFrame(entry: RingFrame) {
    const uplink = this.uplink;
    const st = uplink ? this.states.get(uplink) : undefined;
    if (uplink && st && uplink.send(entry.pcm)) {
      entry.uplink = uplink;
      entry.pos = st.sentMs;
      if (entry.utt && entry.utt.owner === null) {
        entry.utt.owner = uplink;
        entry.utt.firstPos = st.sentMs;
      }
      st.sentMs += (entry.pcm.length * 1000) / 16_000;
      this.lastSentAt = Date.now();
    } else {
      // unsent: it stays in the ring, and its sentence goes to batch (fix 8)
      this.dropped += 1;
      entry.refused = true;
      if (entry.utt) entry.utt.lost = true;
    }
  }

  private maybeCommit(now: number) {
    if (!this.commitEnabled) return;
    const st = this.uplink ? this.states.get(this.uplink) : undefined;
    const p = st?.lastPartial;
    // one commit in flight at a time (spec A.7): a later one would get no answer of its own
    if (!st || !p || st.commit || st.committed.has(p.turn) || p.turn !== st.turn) return;
    if (now - this.lastHeardAt < COMMIT_SILENCE_MS) return;
    if (!TERMINAL.test(p.text) || ELLIPSIS.test(p.text)) return;
    st.committed.add(p.turn);
    this.uplink!.commit();
    st.commit = { at: st.sentMs, sentAt: Date.now(), range: null };
  }

  private maybeSwitch(now: number) {
    const s = this.pendingSwitch;
    if (!s || !s.next || this.suspended) return;
    const st = this.uplink ? this.states.get(this.uplink) : undefined;
    const quiet = (st?.turn ?? null) === null && !this.utterances.some((u) => !u.ended) && now - this.lastHeardAt > 300;
    if (!quiet && now < s.deadline) return;
    this.pendingSwitch = null;
    if (!s.next.live) {
      // died while waiting: never attach a dead stream; the old one carries on
      this.detach(s.next);
      s.next.close();
      return;
    }
    const old = this.uplink;
    this.draining = old; // it keeps its own turn state; its last turn.end still counts
    this.attach(s.next);
    old?.close();
  }

  private async rollover(closesInMs: number) {
    if (this.pendingSwitch || !this.uplink) return;
    // the deadline is fixed when the notice arrives, not after the new stream connects (Astra I8)
    const ps: NonNullable<StreamMic["pendingSwitch"]> = { next: null, deadline: Date.now() + closesInMs - 2_000, connecting: false, attachWhenReady: false };
    this.pendingSwitch = ps;
    if (this.attempts >= MAX_ATTEMPTS) return;
    this.attempts += 1;
    ps.connecting = true;
    const next = await this.connect(true);
    ps.connecting = false;
    if (this.pendingSwitch !== ps) return next?.close(); // a fault, a hold or a hang-up got there first
    if (next) this.watchReplacement(next);
    if (ps.attachWhenReady) {
      // the live stream closed (1000/1001) while this connect was in flight: it is the reconnect
      this.pendingSwitch = null;
      if (next) return this.attach(next);
      return this.reconnectFailed("rollover failed");
    }
    ps.next = next;
    // no replacement: the old stream closes 1000 at the limit and onClosed reconnects
  }

  /** A replacement that is refused (4503) before it is switched to still says
   *  how long to wait; the reconnect that follows the old stream's close honours it. */
  private watchReplacement(next: Uplink) {
    this.hintOffs.set(next, next.onClose(({ error }) => {
      if (error?.retry_after_ms != null) this.retryUntil = Date.now() + error.retry_after_ms;
    }));
  }

  /** Audio `from`..`to` (sent positions) on this stream is not the stream's to
   *  say: the provider is asked to end what it heard (a discard-only commit,
   *  never an early end of the owner's turn), and every turn over it is thrown
   *  away. With a commit already unanswered none is sent (it would get no
   *  answer of its own); the pending one's range grows to cover this audio, and
   *  its one answer settles both (M3). */
  private discardRange(uplink: Uplink, st: StreamState, from: number, to: number) {
    if (st.commit && Date.now() - st.commit.sentAt >= HOLD_BOUND_MS) this.commitLost(st);
    const c = st.commit;
    if (c) {
      if (c.range) {
        c.range.from = Math.min(c.range.from, from);
        c.range.to = Math.max(c.range.to, to);
      } else {
        c.range = { from, to, open: true };
        st.ranges.push(c.range);
      }
      return;
    }
    uplink.commit();
    const range: DiscardRange = { from, to, open: true };
    st.ranges.push(range);
    st.commit = { at: st.sentMs, sentAt: Date.now(), range };
  }

  /** A commit that was never answered: its range stops waiting for a number. */
  private commitLost(st: StreamState) {
    if (st.commit?.range) st.commit.range.open = false;
    st.commit = null;
  }

  /** What to do with a turn that began at `began` on the server's clock (and,
   *  once known, ended at `end`): throw it away, hold it, or let it through.
   *  Only the audio a range covers is in question. A turn well inside it is
   *  discarded. One just short of its upper edge is held while the commit is
   *  unanswered; once answered without a number that covers it, it is the
   *  discarded audio's only if it ends inside it (M2) and the owner has not
   *  spoken again past the edge (speech frames sent there) in audio the server
   *  already had (S1, S2: a
   *  short reply said right after a hand-over or an unmute sits at the edge
   *  on the stream's clock, and the provider's early times put its end inside),
   *  so it is held until its end says. */
  private judge(st: StreamState, stream: Uplink, began: number | null, ended: { end: number; received: number } | null): "discard" | "hold" | "pass" {
    if (began === null) return "pass";
    for (const r of st.ranges) {
      const from = acceptedPos(r.from, st.drops) - DISCARD_SLACK_MS;
      const to = acceptedPos(r.to, st.drops);
      if (began < from || began >= to) continue;
      if (began < to - DISCARD_SLACK_MS) return "discard";
      if (r.open || ended === null) return "hold";
      if (ended.end > to) return "pass";
      // speech sent past the edge, at least Silero's voice-gate length (3 frames), that the server had
      const spoken = this.ring.filter((f) => f.uplink === stream && f.voiced && f.pos !== null && f.pos >= r.to && acceptedPos(f.pos, st.drops) < ended.received);
      const spokeAgain = spoken.length >= SPOKE_AGAIN_FRAMES;
      return spokeAgain ? "pass" : "discard";
    }
    return "pass";
  }

  /** The provider answered the commit in flight: `turn` is the turn it ended
   *  (null: none ended in time). */
  private answer(st: StreamState, turn: number | null, from: Uplink) {
    const c = st.commit;
    if (!c) return;
    st.commit = null;
    if (turn !== null) st.answeredTurns.add(turn);
    const r = c.range;
    if (r) {
      r.open = false;
      if (turn !== null) {
        st.discardThrough = Math.max(st.discardThrough, turn);
        // numbers decide up to the barrier; audio merged in after it stays a range
        if (r.to <= c.at) st.ranges = st.ranges.filter((x) => x !== r);
        else r.from = Math.max(r.from, c.at);
      }
      // the commit did not cover audio merged in past its barrier (spec A.7): it
      // gets a commit of its own, unless the owner is already saying something
      // new, which a commit would end early. Audio heard within the voice gate's
      // pre-roll counts too: Silero has not opened an utterance for it yet, but
      // those frames are already on the stream (the owner's first word)
      const speaking =
        st.turn !== null ||
        Date.now() - this.lastHeardAt < PREROLL_MS ||
        this.utterances.some((u) => !u.consumed && (u.owner === from || u.owner === null));
      if (r.to > c.at && !speaking && this.states.get(from) === st) {
        from.commit();
        r.open = true;
        st.commit = { at: st.sentMs, sentAt: Date.now(), range: r };
      }
    }
    this.settle(st, from);
  }

  private hold(st: StreamState, from: Uplink, m: ServerMessage & { turn: number }) {
    st.held.set(m.turn, { msgs: [m], since: Date.now() });
    this.settle(st, from);
  }

  /** Held turns leave the hold once their range can say whose they are:
   *  dropped if they are the discarded audio's, else replayed in order. One
   *  held for HOLD_BOUND_MS goes through anyway. */
  private settle(st: StreamState, from: Uplink) {
    const now = Date.now();
    if (st.commit && now - st.commit.sentAt >= HOLD_BOUND_MS) this.commitLost(st);
    for (const [turn, h] of [...st.held]) {
      if (st.held.get(turn) !== h) continue; // a replay below settled it already
      let verdict: "discard" | "hold" | "pass";
      if (turn <= st.discardThrough) verdict = "discard";
      else if (now - h.since >= HOLD_BOUND_MS) verdict = "pass";
      else {
        const done = h.msgs.find((x) => x.type === "turn.end" || x.type === "turn.cancelled");
        // a cancelled turn has nothing to say: an ambiguous one is let go
        const ended = !done ? null : done.type === "turn.end" ? { end: done.audio_end_ms, received: done.received_audio_ms } : { end: -Infinity, received: -Infinity };
        verdict = this.judge(st, from, startOf(h.msgs[0]), ended);
      }
      if (verdict === "hold") continue;
      st.held.delete(turn);
      if (verdict === "discard") {
        st.gone.add(turn);
        continue;
      }
      for (const x of h.msgs) if (this.states.get(from) === st) this.onStream(x, from);
    }
    if (st.holdTimer) clearTimeout(st.holdTimer);
    st.holdTimer = null;
    if (st.held.size && this.states.get(from) === st) {
      const due = Math.min(...[...st.held.values()].map((h) => h.since)) + HOLD_BOUND_MS - now;
      st.holdTimer = setTimeout(() => this.settle(st, from), Math.max(0, due));
    }
  }

  // ── stream events ──
  private onStream(m: ServerMessage, from: Uplink) {
    const st = this.states.get(from);
    if (!st) return;
    this.lastStreamEvent = Date.now();
    if (m.type === "session.expiring" && from === this.uplink) return void this.rollover(m.closes_in_ms);
    // an unrequested max_duration close on the live stream (the expiring notice
    // may have been missed): the same rollover, now. A close this mic asked for
    // comes from a stream it has already detached, so it never gets here.
    if (m.type === "session.closed" && m.reason === MAX_SESSION_CLOSE_REASON && from === this.uplink) return void this.rollover(0);
    if (m.type === "warning" && m.code === "audio_dropped") {
      this.dropped += Math.round((m.dropped_ms ?? 0) / FRAME_MS);
      const ranges = m.ranges ?? (m.at_audio_ms !== undefined && m.dropped_ms ? [{ at_audio_ms: m.at_audio_ms, dropped_ms: m.dropped_ms }] : []);
      for (const r of ranges) st.drops.push({ at: r.at_audio_ms, ms: r.dropped_ms });
    }
    if (m.type === "turn.committed" && m.turn !== null && st.answeredTurns.has(m.turn)) return; // the forced end already answered it
    if (m.type === "turn.committed") this.answer(st, m.turn, from);
    if (!("turn" in m) || m.turn === null) return;
    st.lastTurnSeen = Math.max(st.lastTurnSeen, m.turn);
    // a commit's forced end is its answer, ahead of turn.committed; the one
    // commit in flight says whether it was a discard or the punctuation one
    if (m.type === "turn.end" && m.reason === "forced" && st.commit) this.answer(st, m.turn, from);
    if (!this.states.has(from)) return; // a replayed message closed it
    const held = st.held.get(m.turn);
    if (held) {
      held.msgs.push(m);
      if (m.type === "turn.end" || m.type === "turn.cancelled") this.settle(st, from); // its end may decide it
      return;
    }
    if (!st.seen.has(m.turn)) {
      // judged once, at its first sign
      st.seen.add(m.turn);
      if (m.turn > st.discardThrough) {
        const verdict = this.judge(st, from, startOf(m), m.type === "turn.end" ? { end: m.audio_end_ms, received: m.received_audio_ms } : null);
        if (verdict === "discard") st.gone.add(m.turn);
        if (verdict === "hold") return this.hold(st, from, { ...m, turn: m.turn });
      }
    }
    const discarded = m.turn <= st.discardThrough || st.gone.has(m.turn);
    if (m.type === "speech.started" || m.type === "transcript.partial" || m.type === "transcript.final") {
      if (discarded) return;
      st.turn = m.turn;
      if (m.type === "transcript.partial") {
        st.lastPartial = { turn: m.turn, text: m.text.trim() };
        if (this.listening && from === this.uplink && m.text.trim()) this.emitLine({ text: m.text, partial: true, ...this.evidence(this.utterances[0]?.start) });
      }
      return;
    }
    if (m.type === "turn.cancelled") {
      if (st.turn === m.turn) st.turn = null;
      // scoped to this stream (Astra 3 I2): its earliest ended utterance the
      // server had received, never another stream's
      const gone = this.utterances.find((u) => u.owner === from && u.ended && acceptedPos(u.firstPos!, st.drops) <= m.received_audio_ms);
      if (gone) this.utterances = this.utterances.filter((u) => u !== gone);
      return;
    }
    if (m.type !== "turn.end") return;
    if (st.turn === m.turn) st.turn = null;
    st.lastPartial = null;
    if (discarded) return;
    // the utterances this turn covers (Astra 2 I5): only those sent on THIS
    // stream, and of those the ones that began before the turn's end on the
    // server's clock (at least the earliest); an utterance sent on another
    // stream, or begun after this turn ended, is never taken
    const mine = this.utterances.filter((u) => u.owner === from && !u.consumed);
    let spans = mine.filter((u) => acceptedPos(u.firstPos!, st.drops) <= m.audio_end_ms);
    // provider word times drift (the spike): an end whose span precedes every
    // utterance still takes this stream's earliest one the server had received
    if (!spans.length) spans = mine.filter((u) => acceptedPos(u.firstPos!, st.drops) <= m.received_audio_ms).slice(0, 1);
    const open = spans.find((u) => !u.ended);
    this.utterances = this.utterances.filter((u) => u === open || !spans.includes(u));
    const endedAt = spans.at(-1)?.lastSpeech ?? this.lastHeardAt;
    // its place in speech order: its utterance's Silero start, else the first
    // speech sent from where the provider says it began, outside the discarded
    // audio (a turn let through is never that audio's), read back from the ring
    const fromStart = this.ring.filter((f) => f.uplink === from && f.pos !== null && acceptedPos(f.pos, st.drops) >= m.audio_start_ms);
    const discardedAt = (pos: number) => st.ranges.some((r) => pos >= r.from && pos < r.to);
    const at = spans[0]?.start ?? fromStart.find((f) => f.voiced && !discardedAt(f.pos!))?.capturedAt ?? fromStart[0]?.capturedAt ?? Date.now();
    const line: MicLine = { text: m.text, partial: false, endedAt, ...this.evidence(spans[0]?.start, endedAt) };
    // Silero still has it open: it is owed nothing more unless speech resumes,
    // and then the rest is a continuation timed and owned from there (Astra 3 I2)
    if (open) open.consumed = true;
    this.holdUntil = soundsUnfinished(m.text) ? endedAt + STREAM_CONTINUATION_HOLD_MS : 0;
    console.warn(`[call-diag] stream-timing speech_end=${endedAt} eot_rx=${Date.now()} eot_lag=${Date.now() - endedAt} server_lag=${m.server_lag_ms} backlog=${m.received_audio_ms - m.audio_end_ms} reason=${m.reason} committed=${st.committed.has(m.turn) ? 1 : 0} dropped=${this.dropped}`);
    this.dropped = 0;
    // said while the last line was out, or after a hand-over still with batch: it waits
    this.place({ at, line, end: { code: 0, reason: "completed" }, clipEnd: null });
    this.flush();
  }

  private evidence(from: number | undefined, until = Date.now()) {
    const start = (from ?? until) - PREROLL_MS;
    const speech = utteranceSpeech(this.ring.filter((f) => f.capturedAt >= start && f.capturedAt <= until).map((f) => f.judged));
    return speech ? { speech } : {};
  }

  // ── faults ──
  private onClosed(code: number, from: Uplink, error: { retry_after_ms: number | null } | null = null) {
    const wasDraining = from === this.draining;
    this.detach(from);
    if (wasDraining) {
      this.draining = null;
      // it closed before its last turn.end: what it still owed goes to batch, once (fix 6)
      this.handOver(this.utterances.filter((u) => u.owner === from));
      return;
    }
    if (from !== this.uplink || this.suspended) return;
    this.uplink = null;
    if (code === 1000 || code === 1001) {
      // a graceful end (max session, or the harness restarting): the open turn
      // was flushed; a sentence it still owes (no flush came) goes to batch
      console.warn(`[call-diag] stream: closed ${code} -> reconnect`);
      this.handOver(this.utterances.filter((u) => u.owner === from));
      const ps = this.pendingSwitch;
      if (ps?.next?.live) {
        this.pendingSwitch = null;
        return this.attach(ps.next);
      }
      if (ps?.connecting) {
        // a rollover connect is already in flight: it is the reconnect (fix 2),
        // so no second connect races it for the one slot
        ps.attachWhenReady = true;
        return;
      }
      ps?.next?.close();
      this.pendingSwitch = null;
      return this.reconnectNow(code);
    }
    this.faults += 1;
    if (STAY_BATCH.has(code)) this.stayBatch = true;
    this.toBatch(`closed ${code}`, true);
    // a fleet start cap (4503) names how long to wait; otherwise the next silence boundary
    const wait = code === 4503 ? (error?.retry_after_ms ?? CAP_BACKOFF_MS) : 0;
    if (!this.stayBatch && this.faults < MAX_FAULTS && this.attempts < MAX_ATTEMPTS) this.scheduleReconnect(wait);
  }

  /** Reconnect after a graceful close with nothing to switch to. */
  private reconnectNow(code: number) {
    const wait = this.retryUntil - Date.now();
    if (wait > 0) {
      // the replacement was refused with a retry_after: batch until then
      this.retryUntil = 0;
      this.toBatch(`closed ${code}, replacement refused`, true);
      if (!this.stayBatch && this.attempts < MAX_ATTEMPTS) this.scheduleReconnect(wait);
      return;
    }
    if (this.attempts >= MAX_ATTEMPTS) {
      this.stayBatch = true;
      return this.toBatch(`closed ${code}, no attempts left`, true);
    }
    this.attempts += 1;
    const generation = this.generation;
    void this.connect().then((u) => {
      if (generation !== this.generation || this.suspended) return u?.close(); // a hold or hang-up: resume or nothing decides (m1)
      if (u) this.attach(u);
      else this.reconnectFailed(`reconnect after ${code}`);
    });
  }

  /** A reconnect that did not come up: batch meanwhile, and the stream is tried
   *  again at a silence boundary within the budgets; only a 429 is final. */
  private reconnectFailed(why: string) {
    const busy = this.refusedBusy();
    if (this.lastRefusalStatus === 429 && !busy) this.stayBatch = true;
    this.toBatch(why, true);
    if (!this.stayBatch && this.attempts < MAX_ATTEMPTS) this.scheduleReconnect(busy ? (this.lastRefusalRetryMs ?? CAP_BACKOFF_MS) : 0);
  }

  /** Utterances the stream cannot finish (a frame never reached it, or it
   *  closed owing a line) go to FluxMic's recorder, exactly once: they leave
   *  this mic's books, and every provider turn over their audio is discarded
   *  by position (a discard-only turn.commit, never an early end of the
   *  owner's turn). Only their own frames go: another stream's utterance
   *  underway is left alone. */
  private handOver(utts: Utterance[]) {
    let mine = utts.filter((u) => !u.consumed);
    if (!mine.length) return;
    // a live owner's other unlined sentences go too: one forced end covers them all
    const owners = new Set(mine.map((u) => u.owner).filter((o): o is Uplink => o !== null && this.states.has(o)));
    // an unowned one may still have sent its preroll: the live stream is told to end what it heard
    if (mine.some((u) => u.owner === null) && this.uplink && this.states.has(this.uplink)) owners.add(this.uplink);
    mine = this.utterances.filter((u) => !u.consumed && (mine.includes(u) || (u.owner !== null && owners.has(u.owner))));
    this.utterances = this.utterances.filter((u) => !mine.includes(u));
    this.startQueue = this.startQueue.filter((f) => !f.utt || !mine.includes(f.utt));
    const since = Math.min(...mine.map((u) => u.start)) - PREROLL_MS;
    for (const owner of owners) {
      const st = this.states.get(owner)!;
      const first = this.ring.find((f) => f.uplink === owner && f.pos !== null && f.capturedAt >= since);
      // a turn already open is the handed sentence's: its line is never wanted
      if (st.turn !== null) st.discardThrough = Math.max(st.discardThrough, st.turn);
      this.discardRange(owner, st, first?.pos ?? st.sentMs, st.sentMs);
      st.turn = null;
      st.lastPartial = null;
    }
    this.adoptFor(mine);
  }

  private handOverLost() {
    const lost = this.utterances.filter((u) => u.lost && !u.consumed);
    if (lost.length) this.handOver(lost);
  }

  /** FluxMic's recorder takes these utterances' audio from the ring (from the
   *  first one's Silero start less preroll, never the provider's time), less any
   *  frame of a sentence that already has its line, and stopping where another
   *  live utterance begins. If every one has ended, or the clip was cut short, the
   *  recorder is told so at once (silence); else it follows the live frames until
   *  its own endpoint. With no utterance (a turn open only), from now. */
  private adoptFor(hand: Utterance[], turnOnlyAt = Date.now()) {
    const at = hand.length ? Math.min(...hand.map((u) => u.start)) : turnOnlyAt;
    // its line has its place in speech order from now: what was said after waits for it (O1)
    const slot: Slot = { at, line: null, end: null, clipEnd: null };
    this.place(slot);
    if (super.pending() || this.handBacklog.length) {
      // FluxMic holds one clip at a time: this one waits its turn, from the ring
      this.handBacklog.push({ hand, at, slot });
      if (hand.some((u) => !u.ended)) {
        this.holdFeed = true;
        this.feedSilent = 0;
      } else this.clipEnded(slot);
      return;
    }
    this.adoptNow(hand, at, slot);
  }

  private drainBacklog() {
    if (!this.handBacklog.length || super.pending()) return;
    const next = this.handBacklog.shift()!;
    if (!this.handBacklog.length) this.holdFeed = false;
    this.adoptNow(next.hand, next.at, next.slot);
  }

  private adoptNow(hand: Utterance[], startAt: number, slot: Slot) {
    if (this.adopted) this.dropSlot(this.adopted); // FluxMic let its clip go without a word
    this.adopted = slot;
    const set = new Set(hand);
    const maxHand = hand.length ? Math.max(...hand.map((u) => u.start)) : startAt;
    const others = this.utterances.filter((u) => !set.has(u) && !u.consumed && u.start >= maxHand);
    const limit = others.length ? Math.min(...others.map((u) => u.start)) - PREROLL_MS : Infinity;
    const frames = this.ring.filter((f) => f.capturedAt >= startAt - PREROLL_MS && f.capturedAt < limit && (!hand.length || !f.utt || set.has(f.utt)));
    // between lines FluxMic is still live from the last start(): let go of that,
    // so the sentence waits for the next start() like any line said then (m3)
    if (!this.listening && !super.pending()) void super.stop();
    this.adoptUtterance(frames.map((f) => f.pcm), frames.map((f) => f.judged));
    let quiet = 0;
    for (let i = this.ring.length - 1; i >= 0 && !this.ring[i].voiced; i -= 1) quiet += 1;
    const cut = limit !== Infinity;
    if (cut || quiet >= this.batchEndpointFrames || (hand.length > 0 && hand.every((u) => u.ended))) {
      const silence = new Float32Array(1024);
      for (let i = 0; i < this.batchEndpointFrames; i += 1) super.frame(silence, false, null, null);
      this.feedBatch = false;
      this.clipEnded(slot);
    } else {
      this.feedBatch = true;
      this.feedSilent = 0;
    }
  }

  private toBatch(why: string, handOver: boolean) {
    // a sentence the provider already ended (consumed) has its line: never again (fix 4)
    const owed = this.utterances.filter((u) => !u.consumed);
    const turnOnly = owed.length === 0 && this.utterances.length === 0 && [...this.states.values()].some((st) => st.turn !== null);
    this.mode = "batch";
    this.feedBatch = false;
    console.warn(`[call-diag] stream: ${why} -> batch${handOver && (owed.length || turnOnly) ? " (turn in flight handed to batch)" : ""}`);
    // the hand-over owns its audio now: a draining stream's late turn.end or an
    // unused replacement must not say it again or hold the only slot (fix 1, 5)
    for (const u of [this.draining, this.pendingSwitch?.next ?? null]) {
      if (!u) continue;
      this.detach(u);
      u.close();
    }
    this.draining = null;
    this.pendingSwitch = null;
    if (handOver && (owed.length || turnOnly)) this.adoptFor(owed);
    for (const st of this.states.values()) st.turn = null;
    this.utterances = [];
    this.startQueue = [];
    this.holdUntil = 0;
  }

  /** Back to the stream at a silence boundary, retried for a minute within the attempt budget. */
  private scheduleReconnect(afterMs = 0) {
    const generation = this.generation;
    const notBefore = Date.now() + afterMs; // a refusal's retry_after_ms
    const until = notBefore + RECONNECT_WINDOW_MS;
    let trying = false;
    if (this.reconnectTimer) clearInterval(this.reconnectTimer);
    this.reconnectTimer = setInterval(async () => {
      if (generation !== this.generation || this.suspended || Date.now() > until || this.attempts >= MAX_ATTEMPTS) {
        clearInterval(this.reconnectTimer!);
        this.reconnectTimer = null;
        return;
      }
      if (trying || Date.now() < notBefore || super.pending() || Date.now() - this.lastHeardAt < 600) return;
      trying = true;
      this.attempts += 1; // every attempt counts, failed or not (Astra I9)
      const uplink = await this.connect();
      trying = false;
      if (!uplink || super.pending()) return uplink?.close();
      clearInterval(this.reconnectTimer!);
      this.reconnectTimer = null;
      this.attach(uplink); // listening is untouched: the next line is delivered (Astra I7)
    }, 500);
  }

  private emitLine(line: MicLine) {
    for (const fn of [...this.outLines]) fn(line);
  }

  private emitEnd(end: MicEnd) {
    for (const fn of [...this.outEnds]) fn(end);
  }
}
