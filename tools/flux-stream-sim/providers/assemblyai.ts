// tools/flux-stream-sim/providers/assemblyai.ts
// AssemblyAI Universal-Streaming v3 behind contract A (spec 1.2, A.16, B.4).
// The key is read from a file and sent only in the Authorization header of this
// server-side websocket (never a URL, never a log line); no temporary token,
// which the spike measured at 2.2 to 2.8 s to Begin against 1.32 s.
//
// Mapping (probes P1, P2): partials and finals come from words[], never from
// `transcript` (its meaning differs by model) or `utterance`; a final is the
// words that just became final; before turn_end the rest are finalized; end
// of turn is deduplicated per turn_order (formatted preferred, 300 ms wait).
// Sending (P3, P4): audio goes out once 50 ms is buffered, at most 1000 ms per
// chunk, at most 3 s ahead of the provider clock since Begin; commit and
// close are barriers behind queued audio; a short tail is padded.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import WebSocket from "ws";

import { LIMITS, reconcileTextEnd, resolveSilences, splitAfterFinals, spokenWords, type StreamConfig } from "../../../shared/flux-stream-contract.ts";
import type { Provider, ProviderEvent, ProviderSession, Word } from "../provider.ts";

const WS_URL = "wss://streaming.assemblyai.com/v3/ws";
/** The spike: lowest latency and 0.3 % WER at the balanced defaults;
 *  universal-streaming-english lost words and split every pause fixture. */
const MODEL = "universal-3-6-pro";
const FORMAT_WAIT_MS = 300;

/** Turn knobs: the contract's presets (SILENCE_PRESETS; medium 400/1280, low
 *  holds a 1.3 s "Blues Brothers" pause, every turn about 1.76 s; high not yet
 *  measured), resolved by the contract's resolveSilences and sent explicitly at
 *  every eagerness. Only min_turn_silence and max_turn_silence are ever sent:
 *  the provider's older alias for the minimum is not, and the
 *  confidence threshold has no effect on this model and is never sent. */
export function resolvedAai(config: StreamConfig): StreamConfig {
  const { min, max } = resolveSilences(config);
  return { ...config, min_silence_ms: min, max_silence_ms: max };
}

function turnKnobs(config: StreamConfig): Record<string, string> {
  const r = resolvedAai(config);
  return { min_turn_silence: String(r.min_silence_ms), max_turn_silence: String(r.max_silence_ms) };
}

export function providerParams(config: StreamConfig, omitTurnKnobs = false): Record<string, string> {
  const params: Record<string, string> = {
    speech_model: MODEL,
    encoding: "pcm_s16le",
    sample_rate: String(config.sample_rate),
    format_turns: String(config.format),
    inactivity_timeout: String(Math.min(3600, config.idle_timeout_s + 15)),
    ...(omitTurnKnobs ? {} : turnKnobs(config)),
  };
  if (config.keyterms.length) params.keyterms_prompt = JSON.stringify(config.keyterms);
  return params;
}

// ── mapping ─────────────────────────────────────────────────────────────────
interface AaiTurn {
  opened: boolean;
  /** Provider words already finalized (a position in words[]). */
  finalized: number;
  /** The finals already emitted, word by word: immutable, and kept apart from
   *  the provider's later hypotheses (Astra 2 I3, Astra 4 I4). */
  sent: AaiWord[];
  lastPartial: string;
  span: [number, number] | null;
  pending: Record<string, unknown> | null;
  pendingSince: number;
}

export interface AaiState {
  fmt: boolean;
  turns: Map<number, AaiTurn>;
  closed: Set<number>;
  speechAnnounced: boolean;
  lastSpan: [number, number];
  /** Text-only ends that contradicted the finals already sent (Astra 3 I1). */
  conflicts: number;
}

export function newAaiState(fmt = true): AaiState {
  return { fmt, turns: new Map(), closed: new Set(), speechAnnounced: false, lastSpan: [0, 0], conflicts: 0 };
}

type AaiWord = { text: string; start: number; end: number; confidence?: number; word_is_final?: boolean };

const wordsOf = (msg: Record<string, unknown>): AaiWord[] =>
  (Array.isArray(msg.words) ? msg.words : []).filter((w): w is AaiWord => Boolean(w) && typeof (w as AaiWord).start === "number" && typeof (w as AaiWord).end === "number");
const neutral = (ws: AaiWord[]): Word[] => ws.map((w) => ({ text: w.text, start_ms: w.start, end_ms: w.end, confidence: w.confidence ?? null }));
const finalOf = (ws: AaiWord[]): ProviderEvent => ({ kind: "final", text: ws.map((w) => w.text).join(" "), startMs: ws[0].start, endMs: ws[ws.length - 1].end, words: neutral(ws) });

/** Close a turn (A.8, Astra I2, Astra 2 I3, Astra 3 I1, Astra 4 I4). The
 *  finals already sent are immutable, and the end is reconciled against them
 *  in spoken form whether it carries words or only text (splitAfterFinals:
 *  "25 dollars" after "twenty five" adds "dollars"; after "twenty" alone it
 *  adds "five dollars"). Only what comes after them becomes a last final. An
 *  end that contradicts them leaves them standing, the end carries their text,
 *  and the conflict is counted. With no words and no text the turn ends on
 *  what was already final, or is cancelled when nothing was; tentative words
 *  are never promoted. */
function endTurn(state: AaiState, order: number, t: AaiTurn, msg: Record<string, unknown>): ProviderEvent[] {
  const out: ProviderEvent[] = [];
  const own = wordsOf(msg);
  const committed = t.sent;
  state.closed.add(order);
  state.turns.delete(order);
  const finalized = committed.map((w) => w.text).join(" ");
  const conflict = (): ProviderEvent[] => {
    state.conflicts += 1; // counted, content-free
    const span: [number, number] = [committed[0].start, committed[committed.length - 1].end];
    state.lastSpan = span;
    return [turnEnd(msg, finalized, span, committed)];
  };
  if (own.length) {
    const cut = splitAfterFinals(finalized, own.map((w) => w.text));
    if (!cut) return conflict();
    let fresh = own.slice(cut.k);
    if (cut.carry.length) {
      const w = own[cut.k - 1]; // one formatted word covers a final and new words
      fresh = [{ text: cut.carry.join(" "), start: w.start, end: w.end, confidence: w.confidence }, ...fresh];
    }
    if (fresh.length) out.push(finalOf(fresh));
    const spoken = own.map((w) => w.text).join(" ");
    let text = String(msg.transcript ?? "").trim() || spoken;
    if (spokenWords(text).join(" ") !== spokenWords(spoken).join(" ")) {
      // the end's transcript disagrees with its own words, and so with the finals: the finals stand (Astra 5 I3)
      state.conflicts += 1;
      text = spoken;
    }
    const span: [number, number] = [own[0].start, own[own.length - 1].end];
    state.lastSpan = span;
    return [...out, turnEnd(msg, text, span, own)];
  }
  const text = String(msg.transcript ?? "").trim();
  if (!text && !committed.length) return t.opened ? [{ kind: "turn_cancelled" }] : [];
  const span: [number, number] = committed.length ? [committed[0].start, committed[committed.length - 1].end] : (t.span ?? state.lastSpan);
  state.lastSpan = span;
  if (!text) return [...out, turnEnd(msg, finalized, span, committed)];
  const r = reconcileTextEnd(finalized, text);
  if (r.conflict) return conflict();
  if (r.newFinal) out.push({ kind: "final", text: r.newFinal, startMs: span[0], endMs: span[1], words: [] });
  return [...out, turnEnd(msg, r.endText, span, committed)];
}

function turnEnd(msg: Record<string, unknown>, text: string, span: [number, number], ws: AaiWord[]): ProviderEvent {
  // diagnostic only: on universal-3-6-pro this is a silence ramp, 1.0 at every end of turn
  const confidence = typeof msg.end_of_turn_confidence === "number" ? msg.end_of_turn_confidence : null;
  return { kind: "turn_end", text, confidence, startMs: span[0], endMs: span[1], words: neutral(ws) };
}

export function flushPending(state: AaiState, nowMs: number): ProviderEvent[] {
  const out: ProviderEvent[] = [];
  for (const [order, t] of [...state.turns.entries()].sort((a, b) => a[0] - b[0])) {
    if (t.pending && nowMs - t.pendingSince >= FORMAT_WAIT_MS) out.push(...endTurn(state, order, t, t.pending));
  }
  return out;
}

export function mapAssemblyAI(raw: unknown, state: AaiState, nowMs: number): ProviderEvent[] {
  const msg = (raw ?? {}) as Record<string, unknown>;
  if (msg.type === "Termination") return [...flushPending(state, Number.POSITIVE_INFINITY), { kind: "closed" }];
  if (msg.type === "SpeechStarted") {
    state.speechAnnounced = true;
    return [{ kind: "speech_started", audioMs: Number(msg.timestamp ?? 0) }];
  }
  if (msg.type !== "Turn") return [];
  const order = Number(msg.turn_order);
  if (state.closed.has(order)) return []; // a duplicate or late end of turn
  const out = flushPending(state, nowMs);
  if (state.closed.has(order)) return out; // the flush just closed this very order (Astra I2)
  let t = state.turns.get(order);
  if (!t) {
    t = { opened: false, finalized: 0, sent: [], lastPartial: "", span: null, pending: null, pendingSince: 0 };
    state.turns.set(order, t);
  }
  if (state.speechAnnounced && !t.opened) {
    t.opened = true;
    state.speechAnnounced = false;
  }
  const ws = wordsOf(msg);
  if (ws.length) {
    t.span = [ws[0].start, ws[ws.length - 1].end];
    if (!t.opened) {
      t.opened = true;
      out.push({ kind: "speech_started", audioMs: ws[0].start });
    }
  }
  let nFinal = 0;
  // a formatted end's words may not line up with earlier ones ("twenty five"
  // becomes "25"): endTurn reconciles them, never by position (Astra 4 I4)
  const formattedEnd = msg.end_of_turn === true && msg.turn_is_formatted === true;
  while (!formattedEnd && nFinal < ws.length && ws[nFinal].word_is_final) nFinal += 1;
  if (nFinal > t.finalized) {
    out.push(finalOf(ws.slice(t.finalized, nFinal)));
    t.sent.push(...ws.slice(t.finalized, nFinal));
    t.finalized = nFinal;
  }
  if (msg.end_of_turn === true) {
    if (state.fmt && msg.turn_is_formatted !== true) {
      t.pending = msg;
      t.pendingSince = nowMs;
      return out;
    }
    return [...out, ...endTurn(state, order, t, msg)];
  }
  const text = ws.map((w) => w.text).join(" ").trim();
  if (text && text !== t.lastPartial) {
    t.lastPartial = text;
    out.push({ kind: "partial", text, startMs: ws[0].start, endMs: ws[ws.length - 1].end });
  }
  return out;
}

// ── ordered sending ─────────────────────────────────────────────────────────
type Item = { kind: "audio"; pcm: Buffer } | { kind: "control"; msg: Record<string, unknown> };

/** Pacing is a credit bucket (Astra I13): BURST ms of credit at Begin, refilled
 *  at real time, capped at BURST, so a long mute banks at most 3 s. Padding a
 *  short tail before a barrier is recorded, and toAccepted() maps provider
 *  times back to the accepted-audio clock. Bounded work (Astra 4 I3):
 *  outstandingMs() reserves the most padding each queued barrier can need;
 *  KeepAlive never queues (one at most is due, sent ahead of the queue);
 *  consecutive UpdateConfiguration messages merge; consecutive controls go out
 *  in one pump. `send` is synchronous here (ws buffers it), so nothing is in
 *  flight between pumps; Flux's adapter also counts its awaited chunk. */
export class OrderedSender {
  private readonly send: (data: Buffer | string) => void;
  private readonly now: () => number;
  private readonly bytesPerMs: number;
  private readonly minBytes: number;
  private readonly maxBytes: number;
  private queue: Item[] = [];
  private buf = Buffer.alloc(0);
  private creditMs: number = LIMITS.burstMs;
  private last: number;
  private providerMs = 0;
  private pads: Array<[number, number]> = [];
  private keepaliveDue = false;

  constructor(send: (data: Buffer | string) => void, sampleRate: number, now: () => number = Date.now) {
    this.send = send;
    this.now = now;
    this.bytesPerMs = (sampleRate * 2) / 1000;
    this.minBytes = Math.round(50 * this.bytesPerMs) & ~1;
    this.maxBytes = Math.round(1000 * this.bytesPerMs) & ~1;
    this.last = now();
  }

  toAccepted(providerMs: number): number {
    return providerMs - this.pads.reduce((n, [at, pad]) => (at < providerMs ? n + pad : n), 0);
  }

  audio(pcm: Buffer) {
    this.queue.push({ kind: "audio", pcm });
  }

  control(msg: Record<string, unknown>) {
    if (msg.type === "KeepAlive") {
      this.keepaliveDue = true; // one at most, ahead of the queue (Astra 4 I3)
      return;
    }
    const last = this.queue.at(-1);
    if (last?.kind === "control" && last.msg.type === msg.type) {
      if (msg.type === "ForceEndpoint") return; // a barrier right behind the same barrier adds nothing
      if (msg.type === "UpdateConfiguration") {
        last.msg = { ...last.msg, ...msg }; // consecutive updates merge, later values win
        return;
      }
    }
    this.queue.push({ kind: "control", msg });
  }

  /** The provider work still queued, in ms of provider audio: the audio
   *  itself plus the most silence each queued barrier can pad a short tail
   *  with, since pacing can leave any tail under 50 ms in front of it (Astra 3
   *  I8, Astra 4 I3). Admission and the commit and close deadlines use this. */
  outstandingMs(): number {
    const minMs = this.minBytes / this.bytesPerMs;
    let total = this.buf.length / this.bytesPerMs;
    let tail = total;
    for (const item of this.queue) {
      if (item.kind === "audio") {
        const ms = item.pcm.length / this.bytesPerMs;
        total += ms;
        tail += ms;
      } else {
        if (tail > 0) total += tail < minMs ? minMs - tail : minMs;
        tail = 0;
      }
    }
    return total;
  }

  /** The most silence one barrier can add: the 50 ms minimum chunk (Astra 5 I2). */
  barrierReserveMs(): number {
    return this.minBytes / this.bytesPerMs;
  }

  private allowance(): number {
    const t = this.now();
    this.creditMs = Math.min(LIMITS.burstMs, this.creditMs + (t - this.last));
    this.last = t;
    return this.creditMs;
  }

  private sendAudio(chunk: Buffer, paddingBytes = 0) {
    this.send(chunk);
    const ms = chunk.length / this.bytesPerMs;
    if (paddingBytes) this.pads.push([this.providerMs + ms - paddingBytes / this.bytesPerMs, paddingBytes / this.bytesPerMs]);
    this.providerMs += ms;
    this.creditMs -= ms;
  }

  /** Send what is allowed now. True while something is still queued. */
  pump(): boolean {
    if (this.keepaliveDue) {
      this.keepaliveDue = false;
      this.send(JSON.stringify({ type: "KeepAlive" }));
    }
    for (;;) {
      while (this.queue[0]?.kind === "audio") this.buf = Buffer.concat([this.buf, (this.queue.shift() as { pcm: Buffer }).pcm]);
      while (this.buf.length >= this.minBytes) {
        const allowed = Math.floor(Math.min(this.maxBytes, this.allowance() * this.bytesPerMs)) & ~1;
        if (allowed < this.minBytes) return true;
        const take = Math.min(this.buf.length, allowed);
        this.sendAudio(this.buf.subarray(0, take));
        this.buf = this.buf.subarray(take);
      }
      const head = this.queue[0];
      if (head?.kind !== "control") return this.buf.length > 0;
      if (this.buf.length) {
        if (this.allowance() < 50) return true;
        const padding = this.minBytes - this.buf.length;
        const tail = Buffer.concat([this.buf, Buffer.alloc(padding)]);
        this.buf = Buffer.alloc(0);
        this.sendAudio(tail, padding);
      }
      this.queue.shift();
      this.send(JSON.stringify(head.msg)); // then straight on: a control costs no pacing wait
    }
  }
}

// ── the bridge ──────────────────────────────────────────────────────────────
function readKey(keyFile?: string): string {
  return readFileSync(keyFile ?? `${homedir()}/.config/murage-mobile/assemblyai.key`, "utf8").trim();
}

/** omitTurnKnobs (sim CLI --provider-default-turns, off by default): send no
 *  min/max turn silence, so the provider's own defaults apply (R9 comparison). */
export function assemblyAIProvider(opts: { keyFile?: string; key?: string; wsUrl?: string; beginTimeoutMs?: number; omitTurnKnobs?: boolean } = {}): Provider {
  return {
    name: "assemblyai",
    async connect(config, _options, emit) {
      const key = opts.key ?? readKey(opts.keyFile);
      let current = config;
      let effective = resolvedAai(config);
      const state = newAaiState(config.format);
      const ws = new WebSocket(`${opts.wsUrl ?? WS_URL}?${new URLSearchParams(providerParams(config, opts.omitTurnKnobs))}`, { headers: { authorization: key } });
      ws.on("error", () => undefined); // errors surface as close below; a bare error must never crash the process
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("begin timeout")), opts.beginTimeoutMs ?? 10_000);
          ws.on("message", function first(data) {
            let msg: { type?: string } = {};
            try {
              msg = JSON.parse(String(data));
            } catch {
              return;
            }
            if (msg.type === "Begin") {
              clearTimeout(timer);
              ws.off("message", first);
              resolve();
            }
          });
          ws.once("close", () => {
            clearTimeout(timer);
            reject(new Error("closed before begin"));
          });
        });
      } catch (error) {
        ws.terminate(); // never leave a provider session open (FS-06)
        throw error;
      }

      let terminated = false;
      let onTerminated: (() => void) | undefined;
      const finish = (event: ProviderEvent) => {
        if (terminated) return;
        terminated = true;
        onTerminated?.();
        clearInterval(pump);
        clearInterval(flush);
        for (const e of flushPending(state, Number.POSITIVE_INFINITY)) emit(toAcceptedClock(e)); // an abnormal close ends pending turns on the accepted clock too
        emit(event);
      };
      ws.on("message", (data) => {
        let msg: unknown;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        for (const e of mapAssemblyAI(msg, state, Date.now())) {
          if (e.kind === "closed") return finish(e);
          emit(toAcceptedClock(e));
        }
      });
      ws.on("close", (code) => {
        if (code === 1000 || code === 3008) return finish({ kind: "closed" });
        finish({ kind: "error", code: code === 3009 ? "service_unavailable" : "capability_unavailable", message: `provider closed ${code}` });
      });

      const sender = new OrderedSender((d) => ws.readyState === WebSocket.OPEN && ws.send(d), config.sample_rate);
      /** Provider times back onto the accepted-audio clock (padding removed). */
      const toAcceptedClock = (e: ProviderEvent): ProviderEvent => {
        const at = (ms: number) => Math.round(sender.toAccepted(ms));
        if (e.kind === "speech_started") return { ...e, audioMs: at(e.audioMs) };
        if (e.kind === "partial") return { ...e, startMs: at(e.startMs), endMs: at(e.endMs) };
        if (e.kind === "final" || e.kind === "turn_end") {
          return { ...e, startMs: at(e.startMs), endMs: at(e.endMs), words: e.words?.map((w) => ({ ...w, start_ms: at(w.start_ms), end_ms: at(w.end_ms) })) };
        }
        return e;
      };
      const pump = setInterval(() => sender.pump(), 20);
      const flush = setInterval(() => {
        for (const e of flushPending(state, Date.now())) emit(toAcceptedClock(e));
      }, 100);

      const session: ProviderSession = {
        sendAudio(pcm) {
          sender.audio(pcm);
          sender.pump();
        },
        commit() {
          sender.control({ type: "ForceEndpoint" });
          sender.pump();
        },
        update(next) {
          const before = resolvedAai(current);
          const after = resolvedAai(next);
          const changed: Record<string, unknown> = { type: "UpdateConfiguration" };
          if (!opts.omitTurnKnobs && (before.min_silence_ms !== after.min_silence_ms || before.max_silence_ms !== after.max_silence_ms)) {
            // explicit values even when returning to medium: there is no "unset"
            Object.assign(changed, { min_turn_silence: after.min_silence_ms, max_turn_silence: after.max_silence_ms });
          }
          if (JSON.stringify(next.keyterms) !== JSON.stringify(current.keyterms)) changed.keyterms_prompt = next.keyterms; // [] clears them
          current = next;
          effective = after;
          if (Object.keys(changed).length > 1) sender.control(changed);
          return true;
        },
        keepalive() {
          sender.control({ type: "KeepAlive" });
          sender.pump();
        },
        backlogMs: () => sender.outstandingMs(),
        barrierReserveMs: () => sender.barrierReserveMs(),
        effectiveConfig() {
          return effective;
        },
        async close(deadlineMs) {
          if (terminated) return;
          let deadline: ReturnType<typeof setTimeout> | undefined;
          const done = new Promise<void>((resolve) => {
            ws.once("close", () => resolve());
            onTerminated = resolve; // Termination is the answer: the provider closes the socket about 0.9 s later, which must not count against the close deadline
            deadline = setTimeout(resolve, Math.max(0, deadlineMs));
          });
          sender.control({ type: "Terminate" });
          sender.pump();
          await done;
          clearTimeout(deadline); // the socket closing first must not leave the deadline pending
          if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
          finish({ kind: "closed" });
        },
      };
      return session;
    },
  };
}
