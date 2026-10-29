// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The phone job state machine (S12, design 4.4). Memory only: nothing here is persisted, so a restart cannot re-send (D12).
// The LEASED write in lease() is the revocation cutoff: a revoke before it reports "did not run", a revoke after it
// reports "may have run" and withholds the result. LEASED is never re-offered. One job in flight per device.
import { createHash, timingSafeEqual } from "node:crypto";
import type { PhoneAuthority } from "./authority.ts";
import { PHONE_COPY } from "./copy.ts";
import { RESULT_MAX_BYTES, resultSchema, resultValid, type PhoneCapability, type PhoneJobOffer, type TargetedAnswer } from "../../shared/phone-jobs-contract.ts";

export type JobState = "QUEUED" | "OFFERED" | "PARKED" | "LEASED" | "DONE" | "REVOKED" | "FAILED";
export type FailCode = "timeout" | "turn_ended" | "declined" | "offline" | "too_large" | "unsupported" | "denied" | "invalid_result";
export type BotOutcome =
  | { kind: "done"; result: unknown; phoneName: string }
  | { kind: "did_not_run"; line: string }
  | { kind: "may_have_run"; line: string }
  | { kind: "declined"; line: string };
export type LeaseAnswer = { active: true; leaseToken: string } | { active: false };

/** What the push layer sees of a job. */
export interface PhoneJobInfo {
  operationId: string; deviceId: string; eventRef: string; capability: PhoneCapability; action: string; botId: string; say: string; phoneName: string;
  /** The thread of the turn that asked, and when the job stops waiting (request time plus the deadline): the push needs both and no content. */
  threadId: string; expiresAt: number;
}

export interface PhoneJobsDeps {
  now(): number;
  setTimer(ms: number, fn: () => void): () => void;
  push: { park(job: PhoneJobInfo): void; withdraw(job: PhoneJobInfo): void };
  ids(): string;
  leaseToken(): string;
}

export interface PhoneJobRequest {
  authority: PhoneAuthority; deviceId: string; capability: PhoneCapability; action: string; args: unknown; say: string; provider: { id: string; name: string };
  /** The phone's own name for the result line; the card falls back to "your phone". */
  phoneName?: string;
  /** Shown on the card; default to the bot id and "Murage". */
  botName?: string;
  workspace?: string;
}

export const PARK_AFTER_MS = 3000;
export const REQUEST_DEADLINE_MS = 120000;
export const LEASE_MS = 45000;
export const SHEET_LEASE_MS = 180000;
export const POLL_MS = 20000;

const LINE_TIMEOUT = PHONE_COPY.timeout;
const LINE_DECLINED = PHONE_COPY.declined;
const LINE_CHANGED = PHONE_COPY.accessChanged;
const LINE_MAY_HAVE_RUN = PHONE_COPY.mayHaveRun;
const LINE_TURN_ENDED = PHONE_COPY.turnEnded;
const LINE_OFFLINE = PHONE_COPY.restarted;
const LINE_DENIED = PHONE_COPY.denied;
const LINE_UNSUPPORTED = PHONE_COPY.unsupported;

interface Job {
  operationId: string; deviceId: string; authority: PhoneAuthority; capability: PhoneCapability; action: string; args: unknown; say: string;
  provider: { id: string; name: string }; phoneName: string; botName: string; workspace: string; eventRef: string;
  state: JobState; offerId: string; leaseToken?: string; leasedAt?: number; expiresAt?: number; leaseMs: number; requestedAt: number;
  parked: boolean; endedAt?: number; cancelPark?: () => void; cancelDeadline?: () => void; cancelLease?: () => void; resolve: (o: BotOutcome) => void;
}
interface Waiter { done(v: PhoneJobOffer[]): void }

const NON_TERMINAL = new Set<JobState>(["QUEUED", "OFFERED", "PARKED", "LEASED"]);
const OFFERABLE = new Set<JobState>(["QUEUED", "OFFERED", "PARKED"]);
const SHEET_CAPABILITIES = new Set<PhoneCapability>(["messages", "calls"]);

export function eventRefFor(operationId: string): string {
  return createHash("sha256").update("murage-phone-job-event-ref/1\n" + operationId).digest("hex");
}

function sameToken(a: unknown, b: string | undefined): boolean {
  if (typeof a !== "string" || b === undefined) return false;
  const x = Buffer.from(a, "utf8"); const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

function jsonBytes(v: unknown): number | null {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? 0 : Buffer.byteLength(s, "utf8");
  } catch {
    return null;
  }
}

export class PhoneJobs {
  private readonly deps: PhoneJobsDeps;
  private readonly jobs = new Map<string, Job>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  // No parameter properties: the server runs under node --experimental-strip-types, which cannot erase them.
  constructor(deps: PhoneJobsDeps) { this.deps = deps; }

  eventRefFor(operationId: string): string { return eventRefFor(operationId); }

  request(input: PhoneJobRequest): { operationId: string; outcome: Promise<BotOutcome> } {
    this.prune();
    const operationId = this.deps.ids();
    let resolve!: (o: BotOutcome) => void;
    const outcome = new Promise<BotOutcome>((r) => { resolve = r; });
    const now = this.deps.now();
    const job: Job = {
      operationId, deviceId: input.deviceId, authority: input.authority, capability: input.capability, action: input.action, args: input.args, say: input.say,
      provider: input.provider, phoneName: input.phoneName ?? "your phone", botName: input.botName ?? input.authority.botId, workspace: input.workspace ?? "Murage",
      eventRef: eventRefFor(operationId), state: "QUEUED", offerId: this.deps.ids(), leaseMs: SHEET_CAPABILITIES.has(input.capability) ? SHEET_LEASE_MS : LEASE_MS,
      requestedAt: now, parked: false, resolve,
    };
    this.jobs.set(operationId, job);
    job.cancelDeadline = this.deps.setTimer(REQUEST_DEADLINE_MS, () => this.onDeadline(job));
    if (!this.wake(job.deviceId)) this.armPark(job);
    return { operationId, outcome };
  }

  poll(deviceId: string, signal: AbortSignal): Promise<PhoneJobOffer[]> {
    const ready = this.pick(deviceId);
    if (ready) return Promise.resolve([ready]);
    if (signal.aborted) return Promise.resolve([]);
    return new Promise<PhoneJobOffer[]>((resolve) => {
      let finished = false;
      let cancel: () => void = () => {};
      const waiter: Waiter = {
        done: (v) => {
          if (finished) return;
          finished = true;
          cancel();
          signal.removeEventListener("abort", onAbort);
          const set = this.waiters.get(deviceId);
          set?.delete(waiter);
          if (set && set.size === 0) this.waiters.delete(deviceId);
          resolve(v);
        },
      };
      const onAbort = () => waiter.done([]);
      let set = this.waiters.get(deviceId);
      if (!set) this.waiters.set(deviceId, (set = new Set()));
      set.add(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
      cancel = this.deps.setTimer(POLL_MS, () => waiter.done([]));
    });
  }

  byOperation(deviceId: string, operationId: string): TargetedAnswer {
    return this.targeted(this.jobs.get(operationId), deviceId);
  }

  byEventRef(deviceId: string, eventRef: string): TargetedAnswer {
    for (const job of this.jobs.values()) if (job.eventRef === eventRef) return this.targeted(job, deviceId);
    return { handled: true, reason: "unknown" };
  }

  decline(deviceId: string, operationId: string, offerId: string): boolean {
    const job = this.jobs.get(operationId);
    if (!job || job.deviceId !== deviceId || job.state !== "OFFERED" || job.offerId !== offerId) return false;
    this.end(job, "FAILED", { kind: "declined", line: LINE_DECLINED });
    return true;
  }

  /** The LEASED write is the cutoff. Only the current offer of an OFFERED job can lease, and only if every check still holds. */
  lease(deviceId: string, operationId: string, offerId: string, recheck: () => boolean): LeaseAnswer {
    const job = this.jobs.get(operationId);
    if (!job || job.deviceId !== deviceId || job.state !== "OFFERED" || job.offerId !== offerId) return { active: false };
    let holds = false;
    try { holds = recheck() === true; } catch { holds = false; }
    if (!holds) {
      this.end(job, "REVOKED", { kind: "did_not_run", line: LINE_CHANGED });
      return { active: false };
    }
    job.cancelPark?.(); job.cancelPark = undefined;
    job.cancelDeadline?.(); job.cancelDeadline = undefined;
    const now = this.deps.now();
    job.state = "LEASED";
    job.leaseToken = this.deps.leaseToken();
    job.leasedAt = now;
    job.expiresAt = now + job.leaseMs;
    job.cancelLease = this.deps.setTimer(job.leaseMs, () => this.onLeaseTimeout(job));
    return { active: true, leaseToken: job.leaseToken };
  }

  result(deviceId: string, operationId: string, body: unknown): 200 | 409 | 413 | 422 {
    const job = this.jobs.get(operationId);
    if (!job || job.deviceId !== deviceId || job.state !== "LEASED") return 409;
    if (typeof body !== "object" || body === null || !sameToken((body as { leaseToken?: unknown }).leaseToken, job.leaseToken)) return 409;
    const b = body as { ok?: unknown; result?: unknown; code?: unknown };
    const mayHaveRun: BotOutcome = { kind: "may_have_run", line: LINE_MAY_HAVE_RUN };
    if (b.result !== undefined) {
      const bytes = jsonBytes(b.result);
      if (bytes !== null && bytes > RESULT_MAX_BYTES) { this.end(job, "FAILED", mayHaveRun); return 413; }
      if (bytes === null) { this.end(job, "FAILED", mayHaveRun); return 422; }
    }
    const parsed = resultSchema.safeParse(body);
    if (!parsed.success) { this.end(job, "FAILED", mayHaveRun); return 422; }
    const r = parsed.data;
    if (r.ok) {
      if (!resultValid(job.action, r.result)) { this.end(job, "FAILED", mayHaveRun); return 422; }
      this.end(job, "DONE", { kind: "done", result: r.result, phoneName: job.phoneName });
      return 200;
    }
    switch (r.code) {
      case "denied": this.end(job, "FAILED", { kind: "did_not_run", line: LINE_DENIED }); break;
      case "unsupported": this.end(job, "FAILED", { kind: "did_not_run", line: LINE_UNSUPPORTED }); break;
      case "declined": this.end(job, "FAILED", { kind: "declined", line: LINE_DECLINED }); break;
      default: this.end(job, "FAILED", mayHaveRun); // too_large, invalid_result: the executor ran
    }
    return 200;
  }

  /** The app left the foreground: OFFERED goes back to QUEUED with a new offerId. QUEUED and PARKED stay; LEASED is untouched. */
  requeue(deviceId: string): void {
    for (const job of this.jobs.values()) {
      if (job.deviceId !== deviceId || job.state !== "OFFERED") continue;
      job.state = "QUEUED";
      job.offerId = this.deps.ids();
      this.armPark(job);
    }
  }

  /** Ends every open job that matches the scope. Before the LEASED write the bot hears "did not run"; after it, "may have run". Returns how many. */
  revokeFor(scope: { deviceId?: string; botId?: string; capabilities?: PhoneCapability[] }): number {
    let n = 0;
    for (const job of [...this.jobs.values()]) {
      if (!NON_TERMINAL.has(job.state)) continue;
      if (scope.deviceId !== undefined && job.deviceId !== scope.deviceId) continue;
      if (scope.botId !== undefined && job.authority.botId !== scope.botId) continue;
      if (scope.capabilities !== undefined && !scope.capabilities.includes(job.capability)) continue;
      this.end(job, "REVOKED", this.stopped(job, LINE_CHANGED));
      n++;
    }
    // A revoke for a device answers its open long polls at once: the phone must not sit on a 20 s wait for a job that can never come.
    if (scope.deviceId !== undefined && scope.botId === undefined && scope.capabilities === undefined) {
      for (const w of [...(this.waiters.get(scope.deviceId) ?? [])]) w.done([]);
    }
    return n;
  }

  /** For the push detail and the pending list: the capability of a job that is still open, by operation id alone. Nothing else of the job. */
  openCapability(operationId: string): PhoneCapability | undefined {
    const job = this.jobs.get(operationId);
    return job && NON_TERMINAL.has(job.state) ? job.capability : undefined;
  }

  /** What the routes need to know about a job of this device (null for another device's or an unknown job): never its arguments. */
  detail(deviceId: string, operationId: string): { authority: PhoneAuthority; capability: PhoneCapability; action: string; args: unknown; phoneName: string; state: JobState } | null {
    const job = this.jobs.get(operationId);
    if (!job || job.deviceId !== deviceId) return null;
    return { authority: job.authority, capability: job.capability, action: job.action, args: job.args, phoneName: job.phoneName, state: job.state };
  }

  turnEnded(generation: string): void { this.endTurns((j) => j.authority.generation === generation); }
  turnEndedForThread(threadId: string): void { this.endTurns((j) => j.authority.threadId === threadId); }
  turnEndedForBot(botId: string): void { this.endTurns((j) => j.authority.botId === botId); }
  turnEndedAll(): void { this.endTurns(() => true); }

  /** Restart: every non-terminal job is FAILED offline and never re-sent. */
  shutdown(): void {
    for (const job of [...this.jobs.values()]) if (NON_TERMINAL.has(job.state)) this.end(job, "FAILED", this.stopped(job, LINE_OFFLINE));
    for (const set of [...this.waiters.values()]) for (const w of [...set]) w.done([]);
  }

  // ---- internals ----

  private endTurns(match: (j: Job) => boolean): void {
    for (const job of [...this.jobs.values()]) if (NON_TERMINAL.has(job.state) && match(job)) this.end(job, "FAILED", this.stopped(job, LINE_TURN_ENDED));
  }

  /** The outcome of a stop the phone did not report: anything past the LEASED write may have run. */
  private stopped(job: Job, didNotRunLine: string): BotOutcome {
    return job.leasedAt !== undefined ? { kind: "may_have_run", line: LINE_MAY_HAVE_RUN } : { kind: "did_not_run", line: didNotRunLine };
  }

  private end(job: Job, state: "DONE" | "REVOKED" | "FAILED", outcome: BotOutcome): void {
    if (!NON_TERMINAL.has(job.state)) return;
    job.state = state;
    job.endedAt = this.deps.now();
    job.cancelPark?.(); job.cancelDeadline?.(); job.cancelLease?.();
    job.cancelPark = job.cancelDeadline = job.cancelLease = undefined;
    // A leased job was taken by the phone: its card is already open there, so nothing is withdrawn.
    if (job.parked && job.leasedAt === undefined) { try { this.deps.push.withdraw(this.info(job)); } catch { /* a push that cannot be withdrawn expires on its own */ } }
    job.resolve(outcome);
  }

  private onDeadline(job: Job): void {
    job.cancelDeadline = undefined;
    if (OFFERABLE.has(job.state)) this.end(job, "FAILED", { kind: "did_not_run", line: LINE_TIMEOUT });
  }

  private onLeaseTimeout(job: Job): void {
    job.cancelLease = undefined;
    if (job.state === "LEASED") this.end(job, "FAILED", { kind: "may_have_run", line: LINE_MAY_HAVE_RUN });
  }

  private armPark(job: Job): void {
    job.cancelPark?.();
    job.cancelPark = this.deps.setTimer(PARK_AFTER_MS, () => {
      job.cancelPark = undefined;
      if (job.state !== "QUEUED") return;
      job.state = "PARKED";
      if (job.parked) return;
      job.parked = true;
      try { this.deps.push.park(this.info(job)); } catch { /* the job still waits for a poll */ }
    });
  }

  private info(job: Job): PhoneJobInfo {
    return { operationId: job.operationId, deviceId: job.deviceId, eventRef: job.eventRef, capability: job.capability, action: job.action, botId: job.authority.botId, say: job.say, phoneName: job.phoneName, threadId: job.authority.threadId, expiresAt: job.requestedAt + REQUEST_DEADLINE_MS };
  }

  /** The head open job for the device, offered with a fresh offerId, unless one is already LEASED. */
  private pick(deviceId: string): PhoneJobOffer | null {
    let head: Job | undefined;
    for (const job of this.jobs.values()) {
      if (job.deviceId !== deviceId) continue;
      if (job.state === "LEASED") return null;
      if (!head && OFFERABLE.has(job.state)) head = job;
    }
    return head ? this.offer(head) : null;
  }

  private offer(job: Job): PhoneJobOffer {
    job.state = "OFFERED";
    job.offerId = this.deps.ids();
    job.cancelPark?.(); job.cancelPark = undefined;
    return {
      operationId: job.operationId, offerId: job.offerId, workspace: job.workspace, bot: { id: job.authority.botId, name: job.botName }, capability: job.capability,
      action: job.action, args: (typeof job.args === "object" && job.args !== null ? job.args : {}) as Record<string, unknown>, say: job.say, provider: job.provider,
      expiresAt: job.requestedAt + REQUEST_DEADLINE_MS, leaseMs: job.leaseMs as 45000 | 180000,
    };
  }

  /** A phone is already waiting on a long poll: hand it the head job now. */
  private wake(deviceId: string): boolean {
    const set = this.waiters.get(deviceId);
    if (!set || set.size === 0) return false;
    const offer = this.pick(deviceId);
    if (!offer) return false;
    const waiter = set.values().next().value as Waiter;
    waiter.done([offer]);
    return true;
  }

  private targeted(job: Job | undefined, deviceId: string): TargetedAnswer {
    if (!job || job.deviceId !== deviceId) return { handled: true, reason: "unknown" };
    switch (job.state) {
      case "LEASED": return { leased: true, expiresAt: job.expiresAt! };
      case "REVOKED": return { handled: true, reason: "revoked" };
      case "DONE": return { handled: true, reason: "done" };
      case "FAILED": return { handled: true, reason: "ended" };
      default: {
        // One job in flight per phone: a targeted read offers this job only if it is the head, so a second job never jumps the first.
        const offer = this.pick(deviceId);
        if (offer && offer.operationId === job.operationId) return { jobs: [offer] };
        return { handled: true, reason: "unknown" };
      }
    }
  }

  /** Keeps ended jobs long enough for a late targeted read ("Already handled"), then drops them. */
  private prune(): void {
    const cutoff = this.deps.now() - 10 * 60000;
    for (const [id, job] of this.jobs) if (job.endedAt !== undefined && job.endedAt < cutoff) this.jobs.delete(id);
  }
}
