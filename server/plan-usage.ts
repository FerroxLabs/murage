// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Plan usage and reset clock, the native reporter core (GAP-PLAN-LIMITS rev 1.2, sections 4-6).
//
// What this module does: it reads plan windows from an engine that reports them natively over
// a connection Murage already owns (Codex app-server `account/rateLimits/read` and
// `account/rateLimits/updated`), keeps the latest reading per account in memory, and paces the
// reads. What it never does: open a credential file, a keyring or a Cloud credential store,
// make an HTTP call with a subscription token, start an engine, keep one alive longer, or run a
// model turn. The direct-reader registry (plan-usage-adapters.ts) is empty by design.
//
// Every reading lives in memory only (section 6.1 crash story): a restart begins with nothing
// and waits for an engine to report again.

import { versionAtLeast } from "./drivers/codex-hook.ts";
import {
  PLAN_WINDOWS_MAX,
  type LimitDecision,
  type PlanLimitKind,
  planEpochSecondsToMs,
  planLabel,
  planMinutesToSeconds,
  planPercent,
  type PlanObservation,
  type PlanReason,
  type PlanSource,
  type PlanWindow,
} from "../shared/plan-usage.ts";

// ---------------------------------------------------------------------------------------------
// P0 pins: the Codex versions that serve the native methods (read from openai/codex
// codex-rs/app-server-protocol at the release tags). `account/rateLimits/read` and
// `account/rateLimits/updated` exist from rust-v0.62.0; the multi-bucket view (`limitId`,
// `rateLimitsByLimitId`) from rust-v0.100.0; `excludeResetCreditDetails`, which skips the
// separate reset-credit lookup on a background read, from rust-v0.154.0. Below the minimum a
// primary-only snapshot could be taken for the whole plan, so no read is sent there: the
// account shows plan usage as not available, which is a shipped outcome, not an error.

/** The lowest Codex CLI whose app-server reports every plan bucket. */
export const CODEX_PLAN_USAGE_MIN = [0, 100, 0] as const;
/** From here a read asks Codex to skip the reset-credit detail lookup (less provider work per read). */
export const CODEX_PLAN_USAGE_LEAN_READ_MIN = [0, 154, 0] as const;

export const codexPlanUsageSupported = (version: string | undefined): boolean => versionAtLeast(version, CODEX_PLAN_USAGE_MIN);
export const codexPlanUsageLeanRead = (version: string | undefined): boolean => versionAtLeast(version, CODEX_PLAN_USAGE_LEAN_READ_MIN);

// ---------------------------------------------------------------------------------------------
// Bounds (section 5.2).

export const PLAN_USAGE_BOUNDS = {
  /** An account frame larger than this is discarded unread. */
  frameMaxChars: 256 * 1024,
  /** Distinct buckets in one report. */
  bucketsMax: 32,
  /** Global concurrent native reads (per environment). */
  concurrent: 2,
  /** Token bucket: starts per minute, burst. */
  startsPerMinute: 8,
  burst: 2,
  /** One read's deadline. */
  deadlineMs: 8_000,
  /** Waiting reads; excess demand is deferred. */
  queueMax: 128,
  /** A demanded subject is read at most this often, plus jitter. */
  normalIntervalMs: 5 * 60_000,
  normalJitterMs: 30_000,
  /** An owner Refresh coalesces within this interval. */
  ownerIntervalMs: 30_000,
  /** A reading stays current this long after its report. */
  freshMs: 10 * 60_000,
  /** Retry steps after a failed read, then the last step repeats. */
  retryStepsMs: [60_000, 5 * 60_000, 15 * 60_000] as readonly number[],
} as const;

// ---------------------------------------------------------------------------------------------
// The native Codex payload, normalized. Only allowlisted fields are read; everything else in the
// payload (plan type, credit balances, upsell, reset credits) is dropped here and goes nowhere.

export type NormalizedBuckets = Map<string, PlanWindow[]>;
export type NormalizeResult = { ok: true; buckets: NormalizedBuckets; hard: boolean } | { ok: false; reason: Extract<PlanReason, "schema"> };

const BUCKET_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const DEFAULT_BUCKET = "codex";
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Codex `rateLimitReachedType` to the limit kind: a depleted workspace credit pool is credits, any other reached limit the account's. */
export function codexLimitKind(reached: unknown): PlanLimitKind | null {
  if (reached === undefined || reached === null) return null;
  return typeof reached === "string" && reached.endsWith("_credits_depleted") ? "credits" : "engine";
}

function normalizeWindow(raw: unknown, bucketId: string, windowId: string, label: string, limitKind: PlanLimitKind | null): PlanWindow | null | "invalid" {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) return "invalid";
  // usedPercent is required on a present window; without it the window proves nothing
  const usedPercent = planPercent(raw.usedPercent);
  if (usedPercent === null) return "invalid";
  return {
    bucketId,
    windowId,
    label,
    // a named bucket is not proven to be one model's: it stays account scope until the engine says which model
    scope: "account",
    model: null,
    usedPercent,
    // optional values that do not validate become null, never zero
    windowSeconds: planMinutesToSeconds(raw.windowDurationMins),
    resetsAt: planEpochSecondsToMs(raw.resetsAt),
    enforcement: limitKind ? "hard" : "unknown",
    limitKind,
  };
}

function normalizeSnapshot(raw: unknown, fallbackBucket: string, into: NormalizedBuckets): boolean | "invalid" {
  if (!isRecord(raw)) return "invalid";
  const bucketId = raw.limitId === undefined || raw.limitId === null ? fallbackBucket : raw.limitId;
  if (typeof bucketId !== "string" || !BUCKET_ID.test(bucketId)) return "invalid";
  const label = planLabel(raw.limitName) ?? "Codex";
  const limitKind = codexLimitKind(raw.rateLimitReachedType);
  const hard = limitKind !== null;
  const windows: PlanWindow[] = [];
  for (const windowId of ["primary", "secondary"] as const) {
    const w = normalizeWindow(raw[windowId], bucketId, windowId, label, limitKind);
    if (w === "invalid") return "invalid";
    if (w) windows.push(w);
  }
  into.set(bucketId, windows);
  return hard;
}

/**
 * The windows of one native report: a read result (`{rateLimits, rateLimitsByLimitId?}`) or an
 * update notification's params (`{rateLimits}`). Invalid required data invalidates the whole
 * report; an over-capacity report is invalid rather than trimmed, so a possibly blocking bucket
 * is never hidden.
 */
export function normalizeCodexRateLimits(raw: unknown): NormalizeResult {
  const bad = { ok: false, reason: "schema" } as const;
  if (!isRecord(raw)) return bad;
  const buckets: NormalizedBuckets = new Map();
  let hard = false;
  const head = normalizeSnapshot(raw.rateLimits, DEFAULT_BUCKET, buckets);
  if (head === "invalid") return bad;
  hard ||= head;
  const byId = raw.rateLimitsByLimitId;
  if (byId !== undefined && byId !== null) {
    if (!isRecord(byId)) return bad;
    const entries = Object.entries(byId);
    if (entries.length > PLAN_USAGE_BOUNDS.bucketsMax) return bad;
    for (const [key, snapshot] of entries) {
      if (!BUCKET_ID.test(key)) return bad;
      const r = normalizeSnapshot(snapshot, key, buckets);
      if (r === "invalid") return bad;
      hard ||= r;
    }
  }
  if (buckets.size > PLAN_USAGE_BOUNDS.bucketsMax) return bad;
  let windows = 0;
  for (const list of buckets.values()) windows += list.length;
  if (windows > PLAN_WINDOWS_MAX) return bad;
  return { ok: true, buckets, hard };
}

// ---------------------------------------------------------------------------------------------
// An observed refusal as a limit decision (section 6.2). The existing refusal store
// (limit-state.ts) keeps `{resetsAt | null, at}`; with no named reset the retry falls back to
// LIMIT_NO_RESET_MS. That fallback is marked as a guess: owner surfaces show "Reset time not
// available" and the next retry, never the guess as a reset.

export function observedLimitDecision(input: {
  subjectKey: string;
  entry: { resetsAt: number | null; at: number };
  fallbackMs: number;
  limitKind?: PlanLimitKind;
  /** The model a model-window refusal named: that model alone is held. */
  model?: string | null;
  kind?: LimitDecision["kind"];
  evidence?: LimitDecision["evidence"];
  now: number;
}): LimitDecision {
  const { entry, now } = input;
  const named = typeof entry.resetsAt === "number" && Number.isFinite(entry.resetsAt) ? entry.resetsAt : null;
  const retryAt = named ?? entry.at + input.fallbackMs;
  const limitKind: PlanLimitKind = input.limitKind ?? (input.model ? "model" : "engine");
  const scope = limitKind === "model" && input.model ? "model" : "account";
  return {
    subjectKey: input.subjectKey,
    credentialRevision: null,
    scope,
    model: scope === "model" ? input.model! : null,
    bucketId: scope === "model" ? `model:${input.model}` : "account",
    // time passing never proves unused quota: a due limit is reset-due until a report or a working turn shows otherwise
    state: now < retryAt ? "limited" : "reset-due",
    kind: input.kind ?? "quota",
    limitKind,
    evidence: input.evidence ?? "observed",
    resetsAt: named,
    resetGuessed: named === null,
    retryAt,
    confirmedAt: entry.at,
    releaseId: null,
  };
}

/** Whether a held limit covers this model: an account limit covers every model, a model's own window only itself. */
export function limitCoversModel(decision: Pick<LimitDecision, "scope" | "model" | "state">, model: string | null | undefined): boolean {
  if (decision.state !== "limited") return false;
  return decision.scope === "account" || (model ?? null) === decision.model;
}

// ---------------------------------------------------------------------------------------------
// The service: one per environment (one server process). Native handles register while their
// process is up; readings are memory only.

/** A live native reporter: one already running, Murage-owned engine process bound to one account. */
export interface NativeUsageHandle {
  /** Opaque account subject (configured instance plus engine-home scope). Never an email or a path. */
  readonly subjectKey: string;
  /** Opaque revision of the account source; a change retires every older reading. */
  readonly credentialRevision: string;
  /** This process's generation, unique per process in this server. */
  readonly generation: number;
  /** One native read. Rejects with PlanReadError on a reported failure or the deadline. */
  read(): Promise<unknown>;
}

export class PlanReadError extends Error {
  // plain fields, no parameter properties: the server runs under Node's type stripping
  readonly reason: Extract<PlanReason, "unsupported" | "timeout" | "offline" | "schema">;
  constructor(reason: Extract<PlanReason, "unsupported" | "timeout" | "offline" | "schema">) {
    super(`plan usage read: ${reason}`);
    this.reason = reason;
  }
}

interface Bucket { windows: PlanWindow[]; seq: number }
interface Subject {
  credentialRevision: string;
  /** The process generation that brought the current revision: an older process cannot bring back an older source. */
  revisionGeneration: number;
  handles: Map<number, NativeUsageHandle>;
  buckets: Map<string, Bucket>;
  source: PlanSource | null;
  reason: PlanReason | null;
  observedAt: number | null;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  retryAt: number | null;
  retryStep: number;
  /** Generations that answered "method not available": no read until a new process. */
  unsupported: Set<number>;
  inFlight: boolean;
  queued: boolean;
  deferred: boolean;
  nextNormalAt: number;
  lastOwnerAt: number | null;
}

export interface PlanUsageClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  random(): number;
}

const systemClock: PlanUsageClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
};

export interface PlanUsageCounters { reads: number; ok: number; failed: number; discarded: number; deferred: number; events: number }

export class PlanUsageService {
  private readonly subjects = new Map<string, Subject>();
  private readonly queue: string[] = [];
  private running = 0;
  private seq = 0;
  private generations = 0;
  private tokens: number;
  private tokensAt: number;
  private pump: unknown = null;
  readonly counters: PlanUsageCounters = { reads: 0, ok: 0, failed: 0, discarded: 0, deferred: 0, events: 0 };

  private readonly clock: PlanUsageClock;

  constructor(clock: PlanUsageClock = systemClock) {
    this.clock = clock;
    this.tokens = PLAN_USAGE_BOUNDS.burst;
    this.tokensAt = clock.now();
  }

  /** A fresh generation for a new engine process. */
  nextGeneration(): number { return ++this.generations; }

  private subject(subjectKey: string, credentialRevision: string, generation: number): Subject | null {
    let s = this.subjects.get(subjectKey);
    // a process spawned before the current source's process (a late handshake) is superseded: never registered
    if (s && s.credentialRevision !== credentialRevision && generation < s.revisionGeneration) return null;
    if (s && s.credentialRevision !== credentialRevision) {
      // a different account source: nothing older carries over
      this.retireReadings(s, "source-changed");
      s.credentialRevision = credentialRevision;
      s.revisionGeneration = generation;
      s.unsupported.clear();
      // processes on the older source are never read or heard again; their own release is then a no-op
      s.handles.clear();
    }
    if (!s) {
      s = {
        credentialRevision, revisionGeneration: generation, handles: new Map(), buckets: new Map(), source: null, reason: "awaiting-session",
        observedAt: null, lastAttemptAt: null, lastSuccessAt: null, retryAt: null, retryStep: 0,
        unsupported: new Set(), inFlight: false, queued: false, deferred: false, nextNormalAt: 0, lastOwnerAt: null,
      };
      this.subjects.set(subjectKey, s);
    }
    return s;
  }

  private retireReadings(s: Subject, reason: PlanReason): void {
    s.buckets.clear();
    s.source = null;
    s.observedAt = null;
    s.lastSuccessAt = null;
    s.retryAt = null;
    s.retryStep = 0;
    s.nextNormalAt = 0;
    s.reason = reason;
  }

  /** A native handle is up. Returns its release, called when its process ends. */
  register(handle: NativeUsageHandle): () => void {
    const s = this.subject(handle.subjectKey, handle.credentialRevision, handle.generation);
    if (!s) return () => {};
    s.handles.set(handle.generation, handle);
    if (s.reason === "awaiting-session") s.reason = null;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(handle.subjectKey, handle.generation);
    };
  }

  private release(subjectKey: string, generation: number): void {
    const s = this.subjects.get(subjectKey);
    if (!s || !s.handles.delete(generation)) return;
    s.unsupported.delete(generation);
    // With no live process the account's identity is no longer proven: its readings go, and the
    // account shows plan usage as not available until an engine reports again.
    if (s.handles.size === 0) {
      this.retireReadings(s, "awaiting-session");
      if (!s.inFlight && !s.queued) this.subjects.delete(subjectKey);
    }
  }

  /** The engine says its account changed (sign-in, sign-out): every reading of the subject goes. */
  accountChanged(subjectKey: string, generation: number): void {
    const s = this.subjects.get(subjectKey);
    if (!s || !s.handles.has(generation)) return;
    this.retireReadings(s, "identity-unresolved");
    // No process on this subject proves the account any more: none is read or heard again (reads in flight fail
    // their binding check), so only a process that starts after the change can report.
    s.handles.clear();
    s.unsupported.clear();
    // the entry stays (one per configured account) so the account reads as unresolved, not as never seen
  }

  /** An update notification: changes only the buckets it names. A notification satisfies demand. */
  publishEvent(subjectKey: string, credentialRevision: string, generation: number, params: unknown): void {
    const s = this.subjects.get(subjectKey);
    // a late frame from a process no longer registered, or from another source, is discarded
    if (!s || s.credentialRevision !== credentialRevision || !s.handles.has(generation)) { this.counters.discarded++; return; }
    const norm = normalizeCodexRateLimits(params);
    if (!norm.ok) { this.counters.discarded++; return; }
    this.counters.events++;
    const seq = ++this.seq;
    for (const [bucketId, windows] of norm.buckets) s.buckets.set(bucketId, { windows, seq });
    if (!this.withinCapacity(s)) return;
    const now = this.clock.now();
    s.source = "native-event";
    s.observedAt = now;
    s.lastSuccessAt = now;
    s.reason = null;
    s.retryAt = null;
    s.retryStep = 0;
    s.nextNormalAt = now + PLAN_USAGE_BOUNDS.normalIntervalMs;
  }

  /**
   * Demand readings for these subjects. Owner demand coalesces within 30 s; normal demand within
   * five minutes plus jitter. Only subjects with a live native handle are ever read; the rest
   * report what is known. Returns at once; a read runs in the background under the budgets.
   */
  demand(subjectKeys: readonly string[], options: { owner?: boolean } = {}): void {
    const now = this.clock.now();
    for (const key of subjectKeys.slice(0, 32)) {
      const s = this.subjects.get(key);
      if (!s || s.inFlight || s.queued) continue;
      const handle = this.readableHandle(s);
      if (!handle) continue;
      if (s.retryAt !== null && now < s.retryAt) continue;
      if (options.owner) {
        if (s.lastOwnerAt !== null && now - s.lastOwnerAt < PLAN_USAGE_BOUNDS.ownerIntervalMs) continue;
      } else if (now < s.nextNormalAt) continue;
      if (this.queue.length >= PLAN_USAGE_BOUNDS.queueMax) { s.deferred = true; this.counters.deferred++; continue; }
      // a deferred owner Refresh is not counted, so the next one is not refused
      if (options.owner) s.lastOwnerAt = now;
      s.deferred = false;
      s.queued = true;
      this.queue.push(key);
    }
    this.drain();
  }

  private readableHandle(s: Subject): NativeUsageHandle | null {
    let best: NativeUsageHandle | null = null;
    for (const h of s.handles.values()) {
      if (h.credentialRevision !== s.credentialRevision || s.unsupported.has(h.generation)) continue;
      if (!best || h.generation > best.generation) best = h;
    }
    return best;
  }

  private takeToken(): boolean {
    const now = this.clock.now();
    const perMs = PLAN_USAGE_BOUNDS.startsPerMinute / 60_000;
    this.tokens = Math.min(PLAN_USAGE_BOUNDS.burst, this.tokens + (now - this.tokensAt) * perMs);
    this.tokensAt = now;
    // a hair under one token (floating refill) counts as one, so the pace is exactly the budget
    if (this.tokens < 1 - 1e-9) return false;
    this.tokens = Math.max(0, this.tokens - 1);
    return true;
  }

  private drain(): void {
    while (this.running < PLAN_USAGE_BOUNDS.concurrent && this.queue.length > 0) {
      if (!this.takeToken()) {
        if (this.pump === null) {
          const wait = Math.ceil((1 - this.tokens) / (PLAN_USAGE_BOUNDS.startsPerMinute / 60_000));
          this.pump = this.clock.setTimeout(() => { this.pump = null; this.drain(); }, Math.max(1, wait));
        }
        return;
      }
      const key = this.queue.shift()!;
      const s = this.subjects.get(key);
      if (!s) continue;
      s.queued = false;
      const handle = this.readableHandle(s);
      if (!handle) { this.tokens = Math.min(PLAN_USAGE_BOUNDS.burst, this.tokens + 1); this.forgetIfIdle(key, s); continue; }
      void this.runRead(key, s, handle);
    }
  }

  private forgetIfIdle(key: string, s: Subject): void {
    if (s.handles.size === 0 && !s.inFlight && !s.queued) this.subjects.delete(key);
  }

  private async runRead(key: string, s: Subject, handle: NativeUsageHandle): Promise<void> {
    this.running++;
    s.inFlight = true;
    const startSeq = ++this.seq;
    const revision = s.credentialRevision;
    const startedAt = this.clock.now();
    s.lastAttemptAt = startedAt;
    this.counters.reads++;
    let deadline: unknown = null;
    try {
      const raw = await Promise.race([
        handle.read(),
        new Promise<never>((_, reject) => { deadline = this.clock.setTimeout(() => reject(new PlanReadError("timeout")), PLAN_USAGE_BOUNDS.deadlineMs); }),
      ]);
      this.complete(key, s, handle, revision, startSeq, raw);
    } catch (error) {
      // a notification that landed during this read already made the reading current: the failure changes nothing
      if (s.lastSuccessAt === null || s.lastSuccessAt < startedAt) this.fail(key, s, handle, revision, error instanceof PlanReadError ? error.reason : "offline");
    } finally {
      if (deadline !== null) this.clock.clearTimeout(deadline);
      s.inFlight = false;
      this.running--;
      this.forgetIfIdle(key, s);
      this.drain();
    }
  }

  /** A completion is published only for the same subject, source revision and a still-live process. */
  private stillBound(key: string, s: Subject, handle: NativeUsageHandle, revision: string): boolean {
    return this.subjects.get(key) === s && s.credentialRevision === revision && s.handles.get(handle.generation) === handle;
  }

  private complete(key: string, s: Subject, handle: NativeUsageHandle, revision: string, startSeq: number, raw: unknown): void {
    if (!this.stillBound(key, s, handle, revision)) { this.counters.discarded++; return; }
    const norm = normalizeCodexRateLimits(raw);
    if (!norm.ok) { this.fail(key, s, handle, revision, "schema"); return; }
    this.counters.ok++;
    // A full read replaces the snapshot, except a bucket a notification updated after this read began.
    for (const [bucketId, bucket] of [...s.buckets]) if (bucket.seq < startSeq && !norm.buckets.has(bucketId)) s.buckets.delete(bucketId);
    for (const [bucketId, windows] of norm.buckets) {
      const prior = s.buckets.get(bucketId);
      if (!prior || prior.seq < startSeq) s.buckets.set(bucketId, { windows, seq: startSeq });
    }
    if (!this.withinCapacity(s)) return;
    const now = this.clock.now();
    s.source = "native-rpc";
    s.observedAt = now;
    s.lastSuccessAt = now;
    s.reason = null;
    s.retryAt = null;
    s.retryStep = 0;
    s.nextNormalAt = now + PLAN_USAGE_BOUNDS.normalIntervalMs + Math.floor(this.clock.random() * PLAN_USAGE_BOUNDS.normalJitterMs);
  }

  /** The merged snapshot stays within the window bound; past it the reading is unavailable, never trimmed. */
  private withinCapacity(s: Subject): boolean {
    let windows = 0;
    for (const b of s.buckets.values()) windows += b.windows.length;
    if (s.buckets.size <= PLAN_USAGE_BOUNDS.bucketsMax && windows <= PLAN_WINDOWS_MAX) return true;
    this.retireReadings(s, "schema");
    this.counters.discarded++;
    return false;
  }

  private fail(key: string, s: Subject, handle: NativeUsageHandle, revision: string, reason: PlanReason): void {
    if (!this.stillBound(key, s, handle, revision)) { this.counters.discarded++; return; }
    this.counters.failed++;
    // The prior reading stays, now stale; nothing else is tried (no other source, no other account).
    s.reason = reason;
    if (reason === "unsupported") { s.unsupported.add(handle.generation); s.retryAt = null; return; }
    const steps = PLAN_USAGE_BOUNDS.retryStepsMs;
    s.retryAt = this.clock.now() + steps[Math.min(s.retryStep, steps.length - 1)]!;
    s.retryStep++;
  }

  /** The subject's reading as owner surfaces see it. Unknown subjects read as awaiting a session. */
  observation(subjectKey: string): PlanObservation {
    const s = this.subjects.get(subjectKey);
    const now = this.clock.now();
    if (!s) {
      return {
        subjectKey, credentialRevision: "", source: null, status: "unavailable", reason: "awaiting-session",
        observedAt: null, lastAttemptAt: null, lastSuccessAt: null, freshUntil: null, retryAt: null, windows: [],
      };
    }
    const freshUntil = s.observedAt === null ? null : s.observedAt + PLAN_USAGE_BOUNDS.freshMs;
    const windows = [...s.buckets.values()].flatMap((b) => b.windows.map((w) => ({ ...w })));
    const readable = this.readableHandle(s) !== null;
    const status: PlanObservation["status"] = s.inFlight && s.handles.size > 0 && windows.length === 0 ? "checking"
      : windows.length > 0 && freshUntil !== null && now < freshUntil && s.reason === null ? "current"
      : windows.length > 0 ? "stale"
      : s.deferred ? "deferred"
      : "unavailable";
    const reason: PlanReason | null = status === "current" || status === "checking" ? null
      : s.reason ?? (s.handles.size === 0 ? "awaiting-session" : readable ? null : "unsupported");
    return {
      subjectKey, credentialRevision: s.credentialRevision, source: s.source, status,
      reason: status === "deferred" ? "queue-budget" : reason,
      observedAt: s.observedAt, lastAttemptAt: s.lastAttemptAt, lastSuccessAt: s.lastSuccessAt, freshUntil, retryAt: s.retryAt, windows,
    };
  }

  /** Tests only: an empty service with a full token bucket. */
  resetForTests(): void {
    this.subjects.clear();
    this.queue.length = 0;
    this.tokens = PLAN_USAGE_BOUNDS.burst;
    this.tokensAt = this.clock.now();
  }

  /** Every subject with a live handle or a reading, at most 32. */
  subjectKeys(): string[] { return [...this.subjects.keys()].slice(0, 32); }
}

/** The environment's one service. */
export const planUsageService = new PlanUsageService();

// ---------------------------------------------------------------------------------------------
// The Codex connection side (section 5.1). One channel per app-server process, fed every stdout
// line BEFORE the idle or turn handler and before native logging. It takes only account frames:
// replies to its own reads (reserved negative ids; turns use positive ids) and `account/*`
// notifications. Every other frame, server requests included, goes on unchanged.

export interface CodexAccountBinding { subjectKey: string; credentialRevision: string }

const ACCOUNT_FRAME_HINT = /"id"\s*:\s*-\d|"method"\s*:\s*"account\//;
const METHOD_ABSENT = new Set([-32601, -32600]);

export interface CodexAccountChannelOptions {
  write: (line: string) => void;
  service?: PlanUsageService;
  /** Null when this process is not a native plan reporter (another route, an unqualified home, an older Codex). */
  binding: CodexAccountBinding | null;
  leanRead?: boolean;
  clock?: PlanUsageClock;
}

export class CodexAccountChannel {
  readonly generation: number;
  private nextId = -1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: unknown }>();
  private unregister: (() => void) | null = null;
  private closed = false;

  private readonly opts: CodexAccountChannelOptions;

  constructor(opts: CodexAccountChannelOptions) {
    this.opts = opts;
    this.generation = (opts.service ?? planUsageService).nextGeneration();
  }
  private get service(): PlanUsageService { return this.opts.service ?? planUsageService; }
  private get clock(): PlanUsageClock { return this.opts.clock ?? systemClock; }

  /** True when the line was an account frame and is consumed here (never logged, never a turn's). */
  intercept(line: string): boolean {
    if (!ACCOUNT_FRAME_HINT.test(line)) return false;
    let msg: any;
    try { msg = JSON.parse(line); } catch { return false; }
    if (!isRecord(msg)) return false;
    const id = typeof msg.id === "number" ? msg.id : 0;
    const ours = id < 0 && msg.method === undefined;
    const accountNote = msg.id === undefined && typeof msg.method === "string" && msg.method.startsWith("account/");
    if (!ours && !accountNote) return false;
    if (line.length > PLAN_USAGE_BOUNDS.frameMaxChars) {
      if (ours) this.settle(id, undefined, new PlanReadError("schema"));
      return true;
    }
    if (ours) {
      if (msg.error !== undefined) {
        const code = isRecord(msg.error) ? msg.error.code : undefined;
        this.settle(id, undefined, new PlanReadError(typeof code === "number" && METHOD_ABSENT.has(code) ? "unsupported" : "offline"));
      } else this.settle(id, msg.result);
      return true;
    }
    const b = this.opts.binding;
    if (!b || this.closed) return true;
    if (msg.method === "account/rateLimits/updated") this.service.publishEvent(b.subjectKey, b.credentialRevision, this.generation, msg.params);
    else if (msg.method === "account/updated" || msg.method === "account/login/completed") this.service.accountChanged(b.subjectKey, this.generation);
    return true;
  }

  private settle(id: number, result: unknown, error?: Error): void {
    const p = this.pending.get(id);
    // a late reply to an expired read is discarded here, so no expired-id list grows
    if (!p) return;
    this.pending.delete(id);
    this.clock.clearTimeout(p.timer);
    if (error) p.reject(error); else p.resolve(result);
  }

  /** The process finished its handshake: from now on it may be read. */
  ready(): void {
    const b = this.opts.binding;
    if (!b || this.closed || this.unregister) return;
    this.unregister = this.service.register({
      subjectKey: b.subjectKey,
      credentialRevision: b.credentialRevision,
      generation: this.generation,
      read: () => this.read(),
    });
  }

  private read(): Promise<unknown> {
    if (this.closed) return Promise.reject(new PlanReadError("offline"));
    // the reserved negative sequence; never reused while the process lives
    const id = this.nextId--;
    return new Promise((resolve, reject) => {
      const timer = this.clock.setTimeout(() => this.settle(id, undefined, new PlanReadError("timeout")), PLAN_USAGE_BOUNDS.deadlineMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.opts.write(JSON.stringify({
          jsonrpc: "2.0", id, method: "account/rateLimits/read",
          ...(this.opts.leanRead ? { params: { excludeResetCreditDetails: true } } : {}),
        }) + "\n");
      } catch {
        this.settle(id, undefined, new PlanReadError("offline"));
      }
    });
  }

  /** The process ended or is being replaced: pending reads fail, the handle goes. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of [...this.pending.keys()]) this.settle(id, undefined, new PlanReadError("offline"));
    this.unregister?.();
    this.unregister = null;
  }

  /** Reads in flight on this process (tests and diagnostics). */
  get pendingReads(): number { return this.pending.size; }
}
