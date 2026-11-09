import { ReplyFrameReader, REPLY_AUDIO_MIME } from "../../../shared/reply-speech";
export interface ReplyContext { desktop: boolean; hydrated: boolean; threadId: string | null; visible: boolean; call: boolean; botId?: string }
export interface ReplySession { sessionId: string; bootId: string; threadId: string; revision: number }
export interface ReplyTarget { threadId: string; messageId: string; botId?: string }
interface Candidate extends ReplyTarget { automatic: boolean; receivedAt: number; settlementId?: string; revision: number }
export type ReplyNotice = "budget" | "failed" | "hosted";
export interface ReplyView { status: "disconnected" | "idle" | "fetching" | "waiting-for-player-end"; threadId?: string; messageId?: string; enabled: boolean; notice?: ReplyNotice; noticeThreadId?: string; noticeMessageId?: string }
export interface ReplyPlayer { play(): Promise<void>; stop(): void }
export interface ReplyControllerDeps {
  post(path: string, body: unknown, signal?: AbortSignal): Promise<Response>;
  player(blob: Blob, ended: () => void, failed: () => void): ReplyPlayer;
  now?: () => number;
  enabled?: boolean;
  saveEnabled?: (value: boolean) => void;
}
interface Metadata { accountScopeId: string; planVersion: string; holdUntil: number; serverNow: number; available?: boolean }
const metadata = (body: unknown): Metadata | null => {
  if (!body || typeof body !== "object") return null;
  const row = body as Metadata;
  return typeof row.accountScopeId === "string" && typeof row.planVersion === "string" && Number.isFinite(row.holdUntil) && Number.isFinite(row.serverNow) ? row : null;
};
/** One volatile owner. Transcript rendering, replay and hydration never enqueue speech. */
export class ReplyController {
  private readonly deps: ReplyControllerDeps;
  private readonly now: () => number;
  private context: ReplyContext = { desktop: false, hydrated: false, threadId: null, visible: true, call: false };
  private connection?: { id: string; boot: string; ready: boolean };
  private session?: ReplySession;
  private handshaking?: { connection: NonNullable<ReplyController["connection"]>; threadId: string; revision: number };
  private epoch = 0;
  private sequence = 0;
  private queue: Candidate[] = [];
  private active?: { candidate: Candidate; abort: AbortController; player?: ReplyPlayer; attemptId?: string };
  private readonly holds = new Map<string, number>();
  private readonly budgetNotices = new Map<string, number>();
  private readonly hostedNotices = new Set<string>();
  private readonly authors = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private view: ReplyView;
  constructor(deps: ReplyControllerDeps) { this.deps = deps; this.now = deps.now ?? Date.now; this.view = { status: "disconnected", enabled: deps.enabled === true }; }
  get snapshot(): ReplyView { return this.view; }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<ReplyView>): void { this.view = { ...this.view, ...update }; for (const listener of this.listeners) listener(); }
  configure(context: ReplyContext): void {
    const threadChanged = context.threadId !== this.context.threadId;
    const lost = !context.desktop || !context.hydrated || !context.visible || context.call;
    const wasEligible = this.context.desktop && this.context.hydrated && this.context.visible && !this.context.call;
    this.context = context;
    if (threadChanged || lost && wasEligible) this.stop();
    if (threadChanged) this.authors.clear();
    if (threadChanged || !context.desktop || !context.hydrated) { this.session = undefined; this.publish({ status: "disconnected" }); }
    void this.handshake();
  }
  hello(connectionId?: string, bootId?: string): void {
    this.disconnect();
    if (connectionId && bootId) this.connection = { id: connectionId, boot: bootId, ready: false };
  }
  caughtUp(): void { if (this.connection) this.connection.ready = true; void this.handshake(); }
  disconnect(): void {
    this.stop(); this.connection = undefined; this.session = undefined; this.hostedNotices.clear(); this.publish({ status: "disconnected" });
  }
  private async handshake(): Promise<void> {
    if (this.session || this.handshaking?.connection === this.connection || !this.connection?.ready || !this.context.desktop || !this.context.hydrated || !this.context.threadId) return;
    const connection = this.connection, threadId = this.context.threadId, epoch = this.epoch;
    const handshake = { connection, threadId, revision: 0 };
    this.handshaking = handshake;
    try {
      const response = await this.deps.post("/api/tts/reply/session", { connectionId: connection.id, threadId });
      if (!response.ok) return;
      const body = await response.json() as ReplySession;
      if (this.epoch !== epoch || this.connection !== connection || this.context.threadId !== threadId || body.bootId !== connection.boot || body.threadId !== threadId || typeof body.sessionId !== "string" || !Number.isSafeInteger(body.revision)) return;
      body.revision = Math.max(body.revision, handshake.revision);
      this.session = body; this.sequence = 0; this.hostedNotices.clear(); this.publish({ status: "idle", notice: undefined });
    } catch { /* no retry or recovered queue */ }
    finally {
      // A stale response may still have replaced the server session. Finish it before
      // opening the current thread on this connection; ignoring its body is not ordering.
      if (this.handshaking === handshake) {
        this.handshaking = undefined;
        if (this.epoch !== epoch) void this.handshake();
      }
    }
  }
  setEnabled(enabled: boolean): void {
    this.deps.saveEnabled?.(enabled); this.publish({ enabled });
    if (!enabled) { this.queue = []; if (this.active?.candidate.automatic) this.stop(); }
  }
  setCall(call: boolean): void { this.configure({ ...this.context, call }); }
  setVisible(visible: boolean): void { this.configure({ ...this.context, visible }); }
  /** Immediate local teardown, plus an ordered server cancellation even after HTTP completion. */
  stop(): void {
    this.epoch++; this.queue = [];
    const active = this.active; this.active = undefined; active?.abort.abort(); active?.player?.stop();
    const session = this.session;
    if (session) void this.deps.post("/api/tts/reply/cancel", { sessionId: session.sessionId, threadId: session.threadId, commandSequence: ++this.sequence }).catch(() => {});
    this.publish({ status: session ? "idle" : "disconnected", threadId: undefined, messageId: undefined });
  }
  private eligible(candidate?: Candidate): boolean {
    return Boolean(this.session && this.connection?.ready && this.context.desktop && this.context.hydrated && this.context.visible && !this.context.call && this.context.threadId === this.session.threadId && (!candidate || candidate.threadId === this.session.threadId && candidate.revision === this.session.revision && (!candidate.automatic || this.view.enabled && this.now() - candidate.receivedAt < 60_000)));
  }
  /** Called exactly once, at raw receipt before any UI buffer. Controls ignore the toggle. */
  receive(frame: Record<string, unknown>, replayed = false): void {
    if ((frame.kind === "message" || frame.kind === "message.patch") && frame.threadId === this.context.threadId) {
      const row = frame.message as { id?: string; from?: { botId?: string } } | undefined;
      if (typeof row?.id === "string" && typeof row.from?.botId === "string") { if (this.authors.size >= 512) this.authors.delete(this.authors.keys().next().value!); this.authors.set(row.id, row.from.botId); }
      return;
    }
    const pending = this.handshaking;
    if (frame.kind === "speech.invalidate" && pending && pending.connection === this.connection && frame.bootId === pending.connection.boot && frame.threadId === pending.threadId && Number.isSafeInteger(frame.revision)) {
      pending.revision = Math.max(pending.revision, Number(frame.revision));
    }
    const session = this.session;
    if (frame.kind === "speech.sessionClosed" && session && frame.sessionId === session.sessionId && frame.bootId === session.bootId) { this.disconnect(); return; }
    if (frame.kind === "speech.invalidate" && session && frame.threadId === session.threadId && frame.bootId === session.bootId && Number.isSafeInteger(frame.revision) && Number(frame.revision) > session.revision) {
      this.stop(); session.revision = Number(frame.revision); return;
    }
    if (frame.kind !== "speech.ready" || replayed || !session || !this.eligible() || !this.view.enabled || frame.bootId !== session.bootId || frame.threadId !== session.threadId || frame.revision !== session.revision || typeof frame.messageId !== "string" || typeof frame.settlementId !== "string") return;
    const candidate: Candidate = { threadId: session.threadId, messageId: frame.messageId, botId: this.authors.get(frame.messageId) ?? this.context.botId, settlementId: frame.settlementId, revision: session.revision, automatic: true, receivedAt: this.now() };
    if (this.active?.candidate.messageId === candidate.messageId || this.queue.some(item => item.messageId === candidate.messageId)) return;
    this.queue.push(candidate); if (this.queue.length > 3) this.queue.shift(); this.drain();
  }
  manual(target: ReplyTarget): void {
    if (this.active?.candidate.threadId === target.threadId && this.active.candidate.messageId === target.messageId) { this.stop(); return; }
    this.stop();
    if (!this.eligible() || target.threadId !== this.session!.threadId) return;
    this.queue.push({ ...target, automatic: false, receivedAt: this.now(), revision: this.session!.revision }); this.drain();
  }
  private drain(): void {
    if (this.active) return;
    let candidate: Candidate | undefined;
    while ((candidate = this.queue.shift())) { if (this.eligible(candidate)) { void this.run(candidate); return; } }
  }
  private async run(candidate: Candidate): Promise<void> {
    const session = this.session!, epoch = this.epoch;
    const job: NonNullable<ReplyController["active"]> = { candidate, abort: new AbortController() }; this.active = job;
    const owned = () => this.active === job && this.epoch === epoch && this.session === session;
    const current = () => owned() && this.eligible(candidate) && !job.abort.signal.aborted;
    const check = () => { if (!current()) throw new DOMException("Cancelled", "AbortError"); };
    const done = () => { if (!owned()) return; this.active = undefined; job.player?.stop(); this.publish({ status: "idle", threadId: undefined, messageId: undefined }); this.drain(); };
    const failed = () => { if (!owned()) return; this.publish({ notice: "failed", noticeThreadId: candidate.threadId, noticeMessageId: candidate.messageId }); done(); };
    this.publish({ status: "fetching", threadId: candidate.threadId, messageId: candidate.messageId, notice: undefined });
    try {
      const target = { sessionId: session.sessionId, threadId: candidate.threadId, messageId: candidate.messageId };
      const response = await this.deps.post("/api/tts/reply/target", target, job.abort.signal); check();
      const body = await response.json(); check();
      const plan = metadata(body);
      if (!response.ok || !plan) { this.refusal(response.status, body, candidate); done(); return; }
      this.recordHold(plan);
      if (this.held(plan)) { this.publish({ noticeThreadId: candidate.threadId, noticeMessageId: candidate.messageId }); this.budget(plan); done(); return; }
      check();
      const audio = await this.deps.post("/api/tts/reply", { ...target, commandSequence: ++this.sequence, ...(candidate.automatic ? { settlementId: candidate.settlementId } : { action: "speak" }) }, job.abort.signal); check();
      if (audio.status === 204) { done(); return; }
      if (!audio.ok) { const refusal = await audio.json(); check(); this.refusal(audio.status, refusal, candidate); done(); return; }
      if (audio.headers.get("content-type")?.split(";")[0] !== REPLY_AUDIO_MIME || !audio.body) throw new Error("speech_transport");
      const chunks: Uint8Array<ArrayBuffer>[] = []; let mime = "";
      const parser = new ReplyFrameReader(frame => {
        check();
        if (frame.type === "start") { if (frame.value.revision !== candidate.revision) throw new Error("speech_revision"); job.attemptId = frame.value.attemptId; mime = frame.value.mime; }
        else if (frame.type === "audio") chunks.push(new Uint8Array(frame.bytes));
      });
      const reader = audio.body.getReader();
      const abort = () => { void reader.cancel().catch(() => {}); }; job.abort.signal.addEventListener("abort", abort, { once: true });
      try { for (;;) { check(); const part = await reader.read(); check(); if (part.done) break; parser.push(part.value); } parser.finish(); }
      finally { job.abort.signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
      check();
      // Buffered playback starts only after complete. The slot remains owned until ended.
      job.player = this.deps.player(new Blob(chunks, { type: mime }), done, failed);
      this.publish({ status: "waiting-for-player-end" }); check(); await job.player.play(); check();
    } catch {
      if (owned()) {
        if (current()) failed();
        else { job.abort.abort(); done(); }
      }
    }
  }
  private recordHold(plan: Metadata): void {
    const remaining = Math.max(0, plan.holdUntil - plan.serverNow);
    if (remaining) this.holds.set(plan.accountScopeId, this.now() + remaining);
    else this.holds.delete(plan.accountScopeId);
  }
  private held(plan: Metadata): boolean { return (this.holds.get(plan.accountScopeId) ?? 0) > this.now(); }
  private budget(plan: Metadata): void {
    this.queue = []; this.recordHold(plan);
    if ((this.budgetNotices.get(plan.accountScopeId) ?? 0) < plan.holdUntil) { this.budgetNotices.set(plan.accountScopeId, plan.holdUntil); this.publish({ notice: "budget" }); }
  }
  private refusal(status: number, body: unknown, candidate: Candidate): void {
    this.publish({ noticeThreadId: candidate.threadId, noticeMessageId: candidate.messageId });
    if (status === 409 && ["session_unavailable", "speech_unavailable"].includes(String((body as { error?: string } | null)?.error))) { this.disconnect(); return; }
    const plan = metadata(body);
    if (status === 402 && plan) { this.budget(plan); return; }
    if (status === 409 && (body as { error?: string } | null)?.error === "hosted_voice_required") {
      const key = candidate.botId ?? candidate.threadId;
      if (!this.hostedNotices.has(key)) { this.hostedNotices.add(key); this.publish({ notice: "hosted" }); }
      return;
    }
    this.publish({ notice: "failed", noticeThreadId: candidate.threadId, noticeMessageId: candidate.messageId });
  }
}
