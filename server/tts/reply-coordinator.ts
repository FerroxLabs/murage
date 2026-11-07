import type { Clip } from "./elevenlabs.ts";
import { ReplyProvider, type ReplyVoiceTarget } from "./reply-provider.ts";
import { ReplyState, SpeechRefusal, type SpeechAttempt, type SpeechReservation, type SpeechTarget } from "./reply-state.ts";
export interface StoredSpeechTarget extends SpeechTarget, ReplyVoiceTarget { source: string; prefix?: string }
export interface ReplyJob {
  attempt: SpeechAttempt; controller: AbortController; audio: Promise<Clip>; closed: Promise<void>;
  confirmed: boolean; terminal: boolean;
}
/** A synchronous launch lane, with a cancellation barrier before asynchronous replacements. */
export class ReplyCoordinator {
  private readonly jobs = new Map<string, ReplyJob>();
  private readonly pending = new Map<string, number>();
  readonly state: ReplyState;
  readonly provider: ReplyProvider;
  private readonly target: (threadId: string, messageId: string) => StoredSpeechTarget;
  private readonly cancellationMs: number;
  constructor(state: ReplyState, provider: ReplyProvider, target: (threadId: string, messageId: string) => StoredSpeechTarget, cancellationMs = 2000) {
    this.state = state; this.provider = provider; this.target = target; this.cancellationMs = cancellationMs;
  }
  metadata(threadId: string, messageId: string) {
    const target = this.target(threadId, messageId);
    if (!target.eligible) throw new SpeechRefusal(404, "reply_unavailable");
    const plan = this.provider.resolve(target);
    return { accountScopeId: plan.accountScopeId, planVersion: plan.planVersion, holdUntil: plan.holdUntil, serverNow: plan.serverNow, available: true };
  }
  async launch(input: SpeechReservation, signal: AbortSignal): Promise<ReplyJob | null> {
    this.state.sequence(input);
    const previousSequence = this.pending.get(input.sessionId) ?? 0;
    if (input.commandSequence <= previousSequence) throw new SpeechRefusal(409, "stale_command");
    this.pending.set(input.sessionId, input.commandSequence);
    try {
      const old = this.jobs.get(input.threadId);
      if (old) {
        if (input.action !== "speak" || old.attempt.sessionId !== input.sessionId) throw new SpeechRefusal(409, "speech_busy");
        old.controller.abort();
        this.state.finish(old.attempt, "cancelled");
        // Socket close is not the barrier. Actual fetch/reader cancellation is.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([old.closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SpeechRefusal(409, "cancellation_unconfirmed")), this.cancellationMs); })]); }
        catch { throw new SpeechRefusal(409, "cancellation_unconfirmed"); }
        finally { clearTimeout(timer); }
        if (this.jobs.get(input.threadId) === old) this.jobs.delete(input.threadId);
      }
      signal.throwIfAborted();
      if (this.pending.get(input.sessionId) !== input.commandSequence) throw new SpeechRefusal(409, "stale_command");
      this.state.sequence(input);
      const target = this.target(input.threadId, input.messageId);
      const prepared = this.provider.prepare(target, target.source, target.prefix);
      if (!prepared.text) return null;
      const attempt = this.state.reserve(input, () => {
        const fresh = this.target(input.threadId, input.messageId), plan = this.provider.resolve(fresh);
        if (fresh.source !== target.source || fresh.prefix !== target.prefix || plan.planVersion !== prepared.plan.planVersion) throw new SpeechRefusal(409, "voice_changed");
        return { target: fresh, account: plan };
      });
      const controller = new AbortController();
      this.state.install(attempt, () => controller.abort());
      // No await between durable reservation, installation and the real adapter.
      let started: ReturnType<ReplyProvider["start"]>;
      try { started = this.provider.start(prepared, controller.signal); }
      catch (error) { this.state.finish(attempt, "failed"); throw error; }
      const job: ReplyJob = { attempt, controller, ...started, confirmed: false, terminal: false };
      this.jobs.set(input.threadId, job);
      void job.closed.then(() => { job.confirmed = true; this.release(job); }, () => { /* retain the uncertain local ownership barrier */ });
      return job;
    } finally { if (this.pending.get(input.sessionId) === input.commandSequence) this.pending.delete(input.sessionId); }
  }
  current(job: ReplyJob): boolean {
    if (job.controller.signal.aborted || this.jobs.get(job.attempt.threadId) !== job || !this.state.current(job.attempt)) return false;
    try { return this.target(job.attempt.threadId, job.attempt.messageId).eligible; } catch { return false; }
  }
  finish(job: ReplyJob, outcome: "complete" | "failed" | "cancelled" | "budget"): void {
    if (job.terminal) return;
    job.terminal = true;
    if (outcome !== "complete") job.controller.abort();
    try { this.state.finish(job.attempt, outcome); } finally { this.release(job); }
  }
  private release(job: ReplyJob): void {
    if (job.confirmed && job.terminal && this.jobs.get(job.attempt.threadId) === job) this.jobs.delete(job.attempt.threadId);
  }
}
