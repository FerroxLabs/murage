// tools/flux-stream-sim/session.ts
// One contract-A session: framing, seq, turn numbering, limits, usage, leases
// (Flux's cumulative arithmetic, spec A.14), and the mapping from neutral
// provider events to contract messages.
import { randomUUID } from "node:crypto";
import type WebSocket from "ws";

import {
  CLOSE_DEADLINE_MS,
  COALESCE_BYTES,
  COMMIT_DEADLINE_MS,
  EXPIRING_NOTICE_MS,
  HANDSHAKE_TIMEOUT_MS,
  LIMITS,
  MAX_PROTOCOL_ERRORS,
  MAX_SESSION_CLOSE_REASON,
  SLOW_CONSUMER_BYTES,
  applyUpdate,
  billedSeconds,
  fatal,
  frameMs,
  frameProblem,
  notice,
  parseClientMessage,
  settledThrough,
  type ClientMessage,
  type Outbound,
  type StreamConfig,
  type StreamError,
} from "../../shared/flux-stream-contract.ts";
import type { Faults } from "./faults.ts";
import type { Provider, ProviderEvent, ProviderSession } from "./provider.ts";

export interface LeaseRow {
  session: string;
  account: string;
  lease: string;
  units: number;
}

export interface SessionOptions {
  ws: WebSocket;
  account: string;
  config: StreamConfig;
  ignored: string[];
  provider: Provider;
  faults: Faults;
  script?: string[];
  trace?: string;
  pingMs: number;
  usageEveryMs: number;
  leaseMs: number;
  ledger: LeaseRow[];
  onEnd: () => void;
  log: (line: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SimSession {
  readonly id = `fss_${randomUUID().replace(/-/g, "")}`;
  private readonly o: SessionOptions;
  private config: StreamConfig;
  private seq = 0;
  private provider: ProviderSession | null = null;
  private startedAt = 0;
  private early: Outbound[] = [];
  /** One ordered pre-start queue of audio and controls (Astra I10). */
  private prestart: Array<{ audio: Buffer } | { control: ClientMessage }> = [];
  private prestartMs = 0;
  private acceptedMs = 0;
  private droppedTotalMs = 0;
  /** Dropped runs since the last warning, each contiguous (Astra 3 I9). */
  private pendingDrops: Array<{ at: number; ms: number }> = [];
  /** A session.close was read before session.started: nothing after it is taken in (Astra 3 I6). */
  private intakeClosed = false;
  private lastDropWarning = 0;
  /** Client admission is a credit bucket capped at burst_ms (Astra 2 I9): idle
   *  time refills it only up to the cap, so the queue in front of the provider
   *  never holds more than the provider pacer can drain within the contract. */
  private creditMs: number = LIMITS.burstMs;
  private creditAt = 0;
  private acceptTimes: Array<[number, number]> = [];
  private lastActivity = Date.now();
  private turn = 0;
  private turnOpen = false;
  private finals: string[] = [];
  private turnSpan: [number, number] | null = null;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;
  private ended = false;
  private settled = false;
  private protocolErrors = 0;
  private expiringSent = false;
  private billedTotal = 0;
  private leaseN = 0;
  private armedSpeech: { ms: number; code: number } | null = null;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private timeouts: Array<ReturnType<typeof setTimeout>> = [];
  /** What the client has not yet read, independent of kernel socket buffers
   *  (which differ by OS and can swallow megabytes): bytes sent minus the bytes
   *  sent before the newest ping the client has answered. A pong only returns
   *  after the client has read everything ahead of its ping. */
  private sentBytes = 0;
  private ackedBytes = 0;
  private probeId = 0;
  private probeMarks = new Map<number, number>();
  private probeScheduled = false;

  constructor(options: SessionOptions) {
    this.o = options;
    this.config = options.config;
  }

  async start(): Promise<void> {
    const { ws, faults } = this.o;
    ws.on("message", (data, isBinary) => this.onClient(data as Buffer, isBinary));
    ws.on("pong", (data) => this.onPong(data));
    ws.on("close", () => {
      this.ended = true;
      void this.teardown();
    });
    if (faults.idleTimeoutS) this.config = { ...this.config, idle_timeout_s: faults.idleTimeoutS };
    if (faults.maxSessionS) this.config = { ...this.config, max_session_s: faults.maxSessionS };
    this.every(1000, () => this.checkLimits());
    this.every(100, () => this.maybeWarn());
    let provider: ProviderSession;
    try {
      const delay = Math.min(faults.beginDelayMs ?? 0, HANDSHAKE_TIMEOUT_MS);
      if (delay) await sleep(delay);
      if (this.ended) return;
      if ((faults.beginDelayMs ?? 0) >= HANDSHAKE_TIMEOUT_MS) return this.fail(fatal("upstream_timeout", "the transcription provider did not start in time"));
      provider = await this.o.provider.connect(this.config, { script: this.o.script, trace: this.o.trace }, (e) => this.onProvider(e));
    } catch {
      return this.fail(fatal("capability_unavailable", "the transcription provider is unavailable"));
    }
    if (this.ended) {
      await provider.close(0); // the client left during connect: nothing billed
      return;
    }
    this.provider = provider;
    this.startedAt = Date.now();
    // this.config stays the REQUESTED config (null silences mean "from the
    // preset"); only what is reported is the effective one (Astra I14)
    this.emit({
      type: "session.started",
      session_id: this.id,
      model: this.config.model,
      config: provider.effectiveConfig() as unknown as Record<string, unknown>,
      limits: { min_frame_ms: LIMITS.minFrameMs, max_frame_ms: LIMITS.maxFrameMs, prestart_buffer_ms: LIMITS.prestartBufferMs, burst_ms: LIMITS.burstMs },
      ignored_params: this.o.ignored,
      expires_at: Math.floor((this.startedAt + this.config.max_session_s * 1000) / 1000),
    });
    for (const message of this.early) this.emit(message);
    this.early = [];
    const queued = this.prestart;
    this.prestart = [];
    this.creditMs = Math.max(0, LIMITS.burstMs - this.prestartMs); // the replayed backlog spends the burst
    this.creditAt = Date.now();
    this.prestartMs = 0;
    for (const item of queued) {
      // a queued session.close is the barrier: nothing after it is accepted (Astra 2 I10)
      if (this.closing || this.ended) break;
      if ("audio" in item) {
        // the replay is admitted against the same provider bound as live audio (Astra 4 I3)
        const ms = frameMs(item.audio.length, this.config.sample_rate);
        if ((provider.backlogMs?.() ?? 0) + ms + (provider.barrierReserveMs?.() ?? 0) > LIMITS.burstMs) this.drop(ms);
        else this.accept(item.audio);
      } else this.applyControl(item.control); // at its place between the frames around it
    }
    this.maybeWarn(true); // pre-start and replay drops, each reported at its position
    this.every(this.o.pingMs, () => ws.ping());
    this.every(this.o.usageEveryMs, () => this.emit({ type: "usage", ...this.usage() }));
    this.every(this.o.leaseMs, () => this.renewLease());
    this.arm(faults);
  }

  /** Apply faults now (at start, or armed on an open session). */
  arm(f: Faults) {
    if (f.closeAfter) this.later(f.closeAfter.ms, () => this.fire(f.closeAfter!.code, "close_after_ms"));
    if (f.dropAfterMs) this.later(f.dropAfterMs, () => this.o.ws.terminate());
    if (f.closeAfterSpeech) this.armedSpeech = f.closeAfterSpeech;
    if (f.flood) this.every(5, () => this.emit({ type: "transcript.final", turn: this.turn, text: "x".repeat(4000), turn_text: "", audio_start_ms: 0, audio_end_ms: 0, server_lag_ms: 0 }));
    // numbered, so a client can see which ones coalescing dropped (P04): 4 KB every 5 ms,
    // 1.6 MB in two seconds, well past the 1 MiB slow-consumer line unless coalesced
    let k = 0;
    if (f.floodPartials) this.every(5, () => this.emit({ type: "transcript.partial", turn: this.turn, text: `flood ${k++} ${"x".repeat(4000)}`, audio_start_ms: 0, audio_end_ms: 0 }));
  }

  private fire(code: number, why: string) {
    this.o.log(`[sim] fault ${why} fired session=${this.id} turn=${this.turn} open=${this.turnOpen}`);
    if (code === 1001) void this.closeGracefully("going_away", 1001);
    else this.fail(fatalFor(code));
  }

  // ── client side ──
  private onClient(data: Buffer, isBinary: boolean) {
    if (this.ended || this.closing || this.intakeClosed) return; // after the close barrier nothing is accepted
    if (isBinary) return this.onAudio(data);
    if (data.length > LIMITS.maxTextBytes) return this.fail(fatal("invalid_request_error", `text messages hold at most ${LIMITS.maxTextBytes} bytes`));
    const msg = parseClientMessage(data.toString("utf8"));
    if ("invalid" in msg) return this.protocolError(notice(msg.invalid, msg.invalid === "invalid_json" ? "that message is not valid JSON" : "unknown message type"));
    this.lastActivity = Date.now();
    if (msg.type === "keepalive") return this.provider?.keepalive();
    if (!this.provider) {
      this.prestart.push({ control: msg }); // applied after session.started, in order with the audio
      // a close is a barrier the moment it is read: later audio can neither be
      // queued nor evict the audio before it (Astra 3 I6)
      if (msg.type === "session.close") this.intakeClosed = true;
      return;
    }
    this.applyControl(msg);
  }

  private applyControl(msg: ClientMessage) {
    if (msg.type === "turn.commit") {
      // at most one commit in flight: a later one is covered by it (Astra 3 I8)
      if (this.commitTimer) return;
      const backlog = this.backlog();
      // the pending commit exists BEFORE the provider hears it: the scripted
      // provider ends the turn synchronously, and that end must read as forced (Astra I15)
      this.commitTimer = setTimeout(() => {
        this.commitTimer = null;
        this.emit({ type: "turn.committed", turn: null });
      }, COMMIT_DEADLINE_MS + backlog);
      this.provider!.commit();
      return;
    }
    if (msg.type === "session.update") {
      const { config, problem } = applyUpdate(this.config, msg.config);
      if (problem) return this.protocolError(problem);
      if (!this.provider!.update(config)) return this.protocolError(notice("config_unsupported", "that change cannot be applied to a live session"));
      this.config = config; // requested; the provider resolves presets from it
      return this.emit({ type: "session.updated", config: this.provider!.effectiveConfig() as unknown as Record<string, unknown> });
    }
    if (msg.type === "session.close") void this.closeGracefully("client_close", 1000);
  }

  private onAudio(data: Buffer) {
    const problem = frameProblem(data.length, this.config.sample_rate);
    if (problem) return this.fail(problem);
    this.lastActivity = Date.now();
    const ms = frameMs(data.length, this.config.sample_rate);
    if (!this.provider) {
      this.prestart.push({ audio: data });
      this.prestartMs += ms;
      while (this.prestartMs > LIMITS.prestartBufferMs) {
        const i = this.prestart.findIndex((item) => "audio" in item); // the oldest audio; controls keep their place
        const old = (this.prestart.splice(i, 1)[0] as { audio: Buffer }).audio;
        const d = frameMs(old.length, this.config.sample_rate);
        this.prestartMs -= d;
        this.drop(d);
      }
      return;
    }
    const now = Date.now();
    this.creditMs = Math.min(LIMITS.burstMs, this.creditMs + (now - this.creditAt));
    this.creditAt = now;
    if (ms > this.creditMs) return this.drop(ms);
    // and never past what the provider pacer still has queued (Astra 3 I8)
    // one barrier's padding stays free, so a commit, update or close still fits (Astra 5 I2)
    if ((this.provider.backlogMs?.() ?? 0) + ms + (this.provider.barrierReserveMs?.() ?? 0) > LIMITS.burstMs) return this.drop(ms);
    this.creditMs -= ms;
    this.accept(data);
  }

  /** The provider work still queued (padding included), capped at burst_ms. */
  private backlog(): number {
    return Math.min(LIMITS.burstMs, this.provider?.backlogMs?.() ?? 0);
  }

  private accept(data: Buffer) {
    this.acceptedMs += frameMs(data.length, this.config.sample_rate);
    this.acceptTimes.push([this.acceptedMs, Date.now()]);
    while (this.acceptTimes.length && this.acceptedMs - this.acceptTimes[0][0] > 30_000) this.acceptTimes.shift();
    this.provider!.sendAudio(data);
  }

  private drop(ms: number) {
    // a run continues only while nothing was accepted since its start
    const last = this.pendingDrops.at(-1);
    if (last && last.at === this.acceptedMs) last.ms += ms;
    else this.pendingDrops.push({ at: this.acceptedMs, ms });
    this.droppedTotalMs += ms;
  }

  private maybeWarn(now = false) {
    if (!this.startedAt || !this.pendingDrops.length) return;
    if (!now && Date.now() - this.lastDropWarning < 1000) return;
    this.lastDropWarning = Date.now();
    const ranges = this.pendingDrops.map((d) => ({ at_audio_ms: Math.round(d.at), dropped_ms: Math.round(d.ms) }));
    this.emit({ type: "warning", code: "audio_dropped", message: "audio arrived faster than real time; the excess was dropped",
      dropped_ms: ranges.reduce((n, r) => n + r.dropped_ms, 0), at_audio_ms: ranges[0].at_audio_ms, ranges });
    this.pendingDrops = [];
  }

  private lagMs(audioEndMs: number): number {
    const hit = this.acceptTimes.find(([end]) => end >= audioEndMs);
    return hit ? Math.max(0, Date.now() - hit[1]) : 0;
  }

  private protocolError(error: StreamError) {
    this.protocolErrors += 1;
    if (this.protocolErrors >= MAX_PROTOCOL_ERRORS) return this.fail(fatal("too_many_protocol_errors", "too many invalid messages"));
    this.emit({ type: "error", error });
  }

  // ── provider side ──
  private onProvider(e: ProviderEvent) {
    if (this.ended) return;
    if (e.kind === "speech_started" || e.kind === "partial" || e.kind === "final") {
      if (!this.turnOpen) {
        this.turnOpen = true;
        if (this.armedSpeech) {
          const { ms, code } = this.armedSpeech;
          this.armedSpeech = null;
          this.later(ms, () => this.fire(code, "close_after_speech_ms"));
        }
        if (e.kind === "speech_started") this.emit({ type: "speech.started", turn: this.turn, audio_ms: e.audioMs });
      }
    }
    if (e.kind === "partial") {
      if (!this.config.partials || !e.text.trim()) return;
      const pct = this.o.faults.partialDropPct ?? 0;
      if (pct && Math.random() * 100 < pct) return;
      return this.emit({ type: "transcript.partial", turn: this.turn, text: e.text, audio_start_ms: e.startMs, audio_end_ms: e.endMs });
    }
    if (e.kind === "final") {
      const text = e.text.trim();
      if (!text) return;
      this.finals.push(text);
      this.turnSpan = [this.turnSpan?.[0] ?? e.startMs, e.endMs];
      return this.emit({
        type: "transcript.final",
        turn: this.turn,
        text,
        turn_text: this.finals.join(" "),
        audio_start_ms: e.startMs,
        audio_end_ms: e.endMs,
        server_lag_ms: this.lagMs(e.endMs),
        ...(this.config.words && e.words ? { words: e.words } : {}),
      });
    }
    if (e.kind === "turn_cancelled" || (e.kind === "turn_end" && !e.text.trim())) {
      if (this.turnOpen) {
        this.emit({ type: "turn.cancelled", turn: this.turn });
        this.nextTurn();
      }
      return;
    }
    if (e.kind === "turn_end") {
      const forced = this.commitTimer !== null;
      if (this.commitTimer) clearTimeout(this.commitTimer);
      this.commitTimer = null;
      const reason = this.closing ? "session_end" : forced ? "forced" : "endpoint";
      this.emit({
        type: "turn.end",
        turn: this.turn,
        text: e.text.trim(),
        reason,
        confidence: e.confidence,
        audio_start_ms: e.startMs,
        audio_end_ms: e.endMs,
        server_lag_ms: this.lagMs(e.endMs),
        ...(this.config.words && e.words ? { words: e.words } : {}),
      });
      return this.nextTurn();
    }
    if (e.kind === "error") return this.fail(fatal(e.code, e.message));
    if (e.kind === "closed" && !this.closing) this.fail(fatal("capability_unavailable", "the transcription provider ended the session"));
  }

  private nextTurn() {
    this.turn += 1;
    this.turnOpen = false;
    this.finals = [];
    this.turnSpan = null;
  }

  // ── limits, leases and lifecycle ──
  private checkLimits() {
    if (this.ended || this.closing) return;
    if (Date.now() - this.lastActivity > this.config.idle_timeout_s * 1000) {
      return this.fail(fatal("idle_timeout", `no audio or keepalive for ${this.config.idle_timeout_s} s`));
    }
    if (!this.startedAt) return;
    const left = this.startedAt + this.config.max_session_s * 1000 - Date.now();
    if (left <= EXPIRING_NOTICE_MS && !this.expiringSent) {
      this.expiringSent = true;
      this.emit({ type: "session.expiring", closes_in_ms: Math.max(0, left) });
    }
    if (left <= 0) void this.closeGracefully(MAX_SESSION_CLOSE_REASON, 1000);
  }

  private renewLease() {
    if (!this.startedAt || this.settled) return;
    this.bill(settledThrough(Date.now() - this.startedAt, false));
  }

  private settle() {
    if (!this.startedAt || this.settled) return;
    this.settled = true;
    this.bill(settledThrough(Date.now() - this.startedAt, true));
  }

  private bill(through: number) {
    const units = Math.max(0, through - this.billedTotal);
    this.o.ledger.push({ session: this.id, account: this.o.account, lease: `${this.id}:${this.leaseN}`, units });
    this.leaseN += 1;
    this.billedTotal += units;
  }

  private usage() {
    const sessionMs = this.startedAt ? Date.now() - this.startedAt : 0;
    const billed = this.settled ? this.billedTotal : this.startedAt ? billedSeconds(sessionMs) : 0;
    return {
      session_seconds: Math.round(sessionMs / 100) / 10,
      audio_seconds: Math.round(this.acceptedMs / 100) / 10,
      billed_seconds: billed,
      confirmed_seconds: this.billedTotal, // the simulator's ledger confirms at once
      pending_seconds: Math.max(0, billed - this.billedTotal),
      unit: "session_second" as const,
    };
  }

  private async closeGracefully(reason: string, code: number) {
    if (this.closing || this.ended) return;
    this.closing = true;
    this.maybeWarn(true); // every range still owed, before session.closed (Astra 4 I7)
    const backlog = this.backlog();
    const deadline = CLOSE_DEADLINE_MS + backlog;
    await Promise.race([this.provider?.close(deadline), sleep(deadline)]);
    if (this.turnOpen && this.finals.length) {
      this.emit({ type: "turn.end", turn: this.turn, text: this.finals.join(" "), reason: "session_end", confidence: null,
        audio_start_ms: this.turnSpan?.[0] ?? 0, audio_end_ms: this.turnSpan?.[1] ?? this.acceptedMs, server_lag_ms: 0 });
    } else if (this.turnOpen) {
      this.emit({ type: "turn.cancelled", turn: this.turn });
    }
    this.settle();
    this.emit({ type: "session.closed", reason, usage: this.usage() });
    this.finish(code, reason);
  }

  fail(error: StreamError) {
    if (this.ended) return;
    this.maybeWarn(true); // ranges still owed go out before the error (Astra 4 I7)
    this.emit({ type: "error", error });
    this.finish(error.close_code ?? 4500, error.code);
  }

  private finish(code: number, reason: string) {
    if (this.ended) return;
    this.ended = true;
    const ws = this.o.ws;
    const delay = this.o.faults.latencyMs ?? 0;
    setTimeout(() => ws.close(code, reason.slice(0, 120)), delay + 10);
    void this.teardown();
  }

  private tornDown = false;
  private async teardown() {
    // From finish() and from the socket's close; runs once.
    if (this.tornDown) return;
    this.tornDown = true;
    for (const t of this.timers) clearInterval(t);
    for (const t of this.timeouts) clearTimeout(t);
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.settle(); // a session the client dropped is billed like any other
    const provider = this.provider;
    this.provider = null;
    if (!this.closing) await provider?.close(0).catch(() => undefined);
    this.o.onEnd();
  }

  // No-ops once the session ended or tore down: a replay that fails inside
  // start() must not leave timers behind it, nothing would ever clear them.
  private every(ms: number, fn: () => void) {
    if (this.ended || this.tornDown) return;
    this.timers.push(setInterval(fn, ms));
  }

  private later(ms: number, fn: () => void) {
    if (this.ended || this.tornDown) return;
    this.timeouts.push(setTimeout(fn, ms));
  }

  /** Bytes queued for the client and not yet read by it. */
  private pressure(): number {
    return Math.max(this.o.ws.bufferedAmount, this.sentBytes - this.ackedBytes);
  }

  private onPong(data: Buffer) {
    const id = Number(data.toString());
    const mark = this.probeMarks.get(id);
    if (mark === undefined) return; // the keepalive ping, not a probe
    this.ackedBytes = Math.max(this.ackedBytes, mark);
    for (const k of [...this.probeMarks.keys()]) if (k <= id) this.probeMarks.delete(k);
  }

  /** One probe ping per 50 ms of sending, marked with the bytes sent so far. */
  private scheduleProbe() {
    if (this.probeScheduled) return;
    this.probeScheduled = true;
    this.later(50, () => {
      this.probeScheduled = false;
      const ws = this.o.ws;
      if (ws.readyState !== ws.OPEN) return;
      this.probeId += 1;
      this.probeMarks.set(this.probeId, this.sentBytes);
      ws.ping(Buffer.from(String(this.probeId)));
    });
  }

  private emit(message: Outbound) {
    const ws = this.o.ws;
    if (ws.readyState !== ws.OPEN) return;
    // session.started is always first: anything non-fatal before it waits
    if (!this.startedAt && message.type !== "session.started" && !(message.type === "error" && message.error.fatal)) {
      this.early.push(message);
      return;
    }
    // real pressure: a client that stops reading fills the socket buffer
    if (message.type === "transcript.partial" && this.pressure() > COALESCE_BYTES) return;
    if (this.pressure() > SLOW_CONSUMER_BYTES && message.type !== "error") {
      return this.fail(fatal("slow_consumer", "the client is not reading its messages"));
    }
    this.seq += 1;
    const stamped = JSON.stringify({ ...message, seq: this.seq, received_audio_ms: Math.round(this.acceptedMs) });
    this.sentBytes += stamped.length;
    this.scheduleProbe();
    const delay = this.o.faults.latencyMs ?? 0;
    if (delay) setTimeout(() => ws.readyState === ws.OPEN && ws.send(stamped), delay);
    else ws.send(stamped);
  }
}

function fatalFor(code: number): StreamError {
  const byCode: Record<number, string> = { 4500: "internal_error", 4502: "capability_unavailable", 4503: "service_unavailable", 4504: "upstream_timeout" };
  return fatal(byCode[code] ?? "capability_unavailable", "simulated failure");
}
