// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Connected-app event delivery (design GAP-APP-TRIGGERS-109 sections 6.2-6.3 and 13; slice AT-S1). The home's side of
// Flux connected-app events v1, behind an injected FluxAppEventsClient:
//
//   claim -> binding recheck -> filter / stale / refuse -> inbox commit (one transaction) -> ack -> 30 s / 20-event batch
//   -> seal -> run row -> reserve (literal zero child ceilings, the bot's billingRef) -> persist starting -> start
//   -> first newlyStarted:true submits once -> renew every 30 s
//
// Run settlement (finish) is not part of AT-S1: it moved whole to AT-S2 (the run executor), designed lease renewal first.
// Until then no run is finished from here; every run's Flux lease lapses (runLeaseSec, 90 s) once renewal stops.
//
// Event content is untrusted input. Routing, owner, binding and billing fields come from the home's own binding row,
// never from the payload; a delivery whose subscription is not this home's live binding is not retained. Nothing here
// runs a model: the submission is the injected `submit` callback (a stub in this slice; no engine runs). Flux answers
// that are states, not errors: capped or over capacity (429) is "Waiting for allowance" and waits retryAfterSec;
// filtered and stale deliveries are kept as dispositions.
import { createHash, randomUUID } from "node:crypto";
import { JcsError, parseStrictJsonBytes } from "../shared/app-trigger-canonical.mjs";
import {
  APP_BATCH_MAX_BYTES, APP_BATCH_WINDOW_MS, APP_RUN_CONTEXT, appAckResponseSchema, appClaimItemSchema, appClaimResponseSchema, appEventErrorBodySchema,
  batchMaxEvents, clientLimitsFrom, fluxRunViewSchema, fluxUuidSchema, matchesFilter, projectionWithinLimits,
  type AppClaimItem, type AppClientLimits, type AppEventErrorCode, type AppTriggerBinding, type FluxRunView,
} from "../shared/app-triggers.ts";
import type { AppEventRun, AppTriggerStore, CustodyEntry } from "./app-trigger-store.ts";
import { fluxUsageHeaders } from "./flux-usage-tags.ts";

// ── the client ───────────────────────────────────────────────────────────────

/** A Flux answer that is not 2xx, in the D-11 shape. `code` "unexpected" is a body that was not the envelope. */
export class FluxAppEventsError extends Error {
  readonly status: number;
  readonly code: AppEventErrorCode | "unexpected" | "transport";
  readonly retryable: boolean;
  readonly retryAfterSec?: number;
  // no parameter properties: the server runs with type stripping only
  constructor(status: number, code: AppEventErrorCode | "unexpected" | "transport", retryable: boolean, retryAfterSec?: number) {
    super(`flux app events: ${code} (${status})`);
    this.status = status; this.code = code; this.retryable = retryable;
    if (retryAfterSec !== undefined) this.retryAfterSec = retryAfterSec;
    this.name = "FluxAppEventsError";
  }
}

export interface ReserveBody { version: 1; subscriptionId: string; deliveryIds: string[]; policyDigest: string; billingRef: string; childCreates: 0; childHandoffs: 0 }

/** The calls the home makes (README route table). Each mutation takes the Idempotency-Key the caller derived. */
export interface FluxAppEventsClient {
  capabilities(): Promise<unknown>;
  catalog(): Promise<unknown>;
  claim(body: { consumerId: string; waitSec: number; maxRows: number }, key: string): Promise<unknown>;
  ack(body: { claimId: string; receipts: Array<{ deliveryId: string; disposition: "accepted" | "dropped" }> }, key: string): Promise<unknown>;
  reserve(runId: string, body: ReserveBody, key: string): Promise<unknown>;
  start(runId: string, body: { expectedRevision: number }, key: string): Promise<unknown>;
  renew(runId: string, body: { expectedRevision: number; state: "working" | "owner_wait" }, key: string): Promise<unknown>;
  getRun(runId: string): Promise<unknown>;
}

/** Reply bounds. A claim holds at most claimMaxBytes (256 KiB) of rows; its envelope and ids add well under the same
 * again. Every other reply is a control body (controlBodyMaxBytes, 32 KiB). Larger replies are refused unread. */
export const APP_CLAIM_REPLY_MAX_BYTES = 2 * 262_144;
export const APP_CONTROL_REPLY_MAX_BYTES = 32_768;

/** Read at most `maxBytes` of a reply; null when it is longer (the rest is never buffered). */
async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) { await response.body?.cancel().catch(() => undefined); return null; }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
}

/** The HTTP client: HTTPS only in production, redirects refused, a version:1 body on every request (DELETE too).
 * Replies are untrusted: read within a byte bound and parsed by the strict JSON reader (no duplicate members, no
 * floats, bounded depth) before any schema sees them (GrokBuild r1 H2, Astra r1 M7). */
export function createFluxAppEventsClient(options: { baseUrl: string; fetch: typeof fetch; accessToken: () => string; timeoutMs?: number }): FluxAppEventsClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const call = async (method: "GET" | "POST", path: string, body?: Record<string, unknown>, key?: string, maxBytes = APP_CONTROL_REPLY_MAX_BYTES): Promise<unknown> => {
    // usage tags: connected-app event control, which names no bot or conversation of its own (flux-usage-tags.ts)
    const headers: Record<string, string> = { authorization: `Bearer ${options.accessToken()}`, accept: "application/json", ...fluxUsageHeaders({ feature: "app_event" }) };
    if (body) headers["content-type"] = "application/json";
    if (key) headers["idempotency-key"] = key;
    let response: Response;
    try {
      response = await options.fetch(`${base}${path}`, { method, headers, redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 40_000), ...(body ? { body: JSON.stringify({ version: 1, ...body }) } : {}) });
    } catch { throw new FluxAppEventsError(0, "transport", true); }
    let bytes: Uint8Array | null;
    try { bytes = await readBounded(response, maxBytes); } catch { throw new FluxAppEventsError(0, "transport", true); }
    if (bytes === null) throw new FluxAppEventsError(response.status, "unexpected", false);
    let parsed: unknown = null;
    if (bytes.byteLength > 0) {
      try { parsed = parseStrictJsonBytes(bytes); }
      catch (error) {
        if (!(error instanceof JcsError)) throw error;
        // a 2xx that is not strict JSON is never acted on; an error reply that is not the envelope stays "unexpected"
        if (response.ok) throw new FluxAppEventsError(response.status, "unexpected", false);
        parsed = null;
      }
    }
    if (response.ok) return parsed;
    const envelope = appEventErrorBodySchema.safeParse(parsed);
    if (!envelope.success) throw new FluxAppEventsError(response.status, "unexpected", response.status >= 500);
    throw new FluxAppEventsError(response.status, envelope.data.error.code, envelope.data.error.retryable, envelope.data.error.retryAfterSec);
  };
  const runPath = (runId: string, step: string) => {
    if (!fluxUuidSchema.safeParse(runId).success) throw new Error("run ids are UUIDs");
    return `/v1/app-events/runs/${runId}${step}`;
  };
  return {
    capabilities: () => call("GET", "/v1/app-events/capabilities"),
    catalog: () => call("GET", "/v1/app-events/catalog"),
    claim: (body, key) => call("POST", "/v1/app-events/deliveries/claim", body, key, APP_CLAIM_REPLY_MAX_BYTES),
    ack: (body, key) => call("POST", "/v1/app-events/deliveries/ack", body, key),
    reserve: (runId, body, key) => { const { version: _version, ...rest } = body; return call("POST", runPath(runId, "/reserve"), rest, key); },
    start: (runId, body, key) => call("POST", runPath(runId, "/start"), body, key),
    renew: (runId, body, key) => call("POST", runPath(runId, "/renew"), body, key),
    getRun: runId => call("GET", runPath(runId, "")),
  };
}

/** A deterministic Idempotency-Key for one logical operation, so a retry after a crash replays instead of repeating. */
export function operationKey(...parts: Array<string | number>): string {
  const hex = createHash("sha256").update(`murage-app-events:${parts.join(":")}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// ── the delivery engine ──────────────────────────────────────────────────────

export interface AppHome { ownerAccountId: string; homeId: string; homeEpoch: number }

/** The one root submission of a run, in two steps so the hard zero can see the run before any turn of it exists:
 * `thread` makes the run thread (no turn), which is persisted as the run's lineage; only then `start` begins the
 * one root turn in it. In this slice both are stubs: no engine runs. */
export interface AppRunSubmit {
  thread(run: AppEventRun): Promise<string> | string;
  start(run: AppEventRun & { threadId: string }, deliveryIds: readonly string[]): Promise<{ generation: string }> | { generation: string };
}

/** What the owner sees for a run state (rule 9: say what it waits for). Never an error for capped or over capacity. */
export function appRunDisplay(run: Pick<AppEventRun, "state" | "waitReason">): string {
  switch (run.state) {
    case "budget_wait": return "Waiting for allowance";
    case "sealed": case "reserved": case "starting": return "Starting";
    case "running": return "Running";
    case "completed": return "Done";
    case "cancelled": return "Cancelled";
    case "outcome_unknown": return "Review outcome";
    case "refused": return run.waitReason === "billing_missing" || run.waitReason === "billing_revoked" ? "Bind the bot again" : "Needs your review";
    case "failed": return "Failed";
  }
}

const RETRY_SOON_MS = 30_000;
const GLOBAL_PAUSE_MAX_SEC = 60;
const PASS_LIMIT = 50;

export class AppTriggerDelivery {
  private limits: AppClientLimits | null = null;
  /** A 429 from Flux pauses every control call until this time (README "Rate limit"). */
  private waitUntil = 0;
  private readonly newId: () => string;

  /** `turnAlive` says whether the host still holds a run's root turn (startup reconciliation); absent means none does. */
  private readonly deps: { store: AppTriggerStore; client: FluxAppEventsClient; home: AppHome; consumerId: string; submit: AppRunSubmit; now: () => number; newId?: () => string; turnAlive?: (run: AppEventRun) => boolean };

  constructor(deps: AppTriggerDelivery["deps"]) {
    this.deps = deps;
    this.newId = deps.newId ?? randomUUID;
  }

  /** The published limits, read from GET /capabilities. Null holds admission (unknown revision or a missing limit). */
  async loadLimits(): Promise<AppClientLimits | null> {
    try { this.limits = clientLimitsFrom(await this.deps.client.capabilities()); }
    catch (error) { this.noteError(error); this.limits = null; }
    return this.limits;
  }

  get pausedUntil(): number { return this.waitUntil; }

  /** A 429 pauses every control call, for at most the rate-limit window (60 s, README "Rate limit"). That is under
   * runLeaseSec - runRenewIntervalSec, so a pause never lapses a renewed lease. A longer per-operation wait (a reserve
   * over allowance) stays on that run's own retry time. */
  private noteError(error: unknown): void {
    if (error instanceof FluxAppEventsError && error.status === 429) this.waitUntil = Math.max(this.waitUntil, this.deps.now() + Math.min(GLOBAL_PAUSE_MAX_SEC, Math.max(1, error.retryAfterSec ?? GLOBAL_PAUSE_MAX_SEC)) * 1000);
  }

  private paused(): boolean { return this.deps.now() < this.waitUntil; }

  // ── claim and custody ──

  /** One claim, custody, ack. Returns what happened; nothing is acknowledged that is not durably committed first. */
  async pollOnce(): Promise<{ claimed: number; acked: boolean; held?: "limits" | "capacity" }> {
    if (this.paused()) return { claimed: 0, acked: false, held: "capacity" };
    const limits = this.limits ?? (await this.loadLimits());
    if (!limits) return { claimed: 0, acked: false, held: this.paused() ? "capacity" : "limits" };
    // An ack whose answer was lost is replayed, identically, before any new claim (Astra r1 C1).
    if (!(await this.replayAcks())) return { claimed: 0, acked: false, ...(this.paused() ? { held: "capacity" as const } : {}) };
    const claimKey = randomUUID();
    let raw: unknown;
    try { raw = await this.deps.client.claim({ consumerId: this.deps.consumerId, waitSec: limits.claimWaitSec, maxRows: limits.claimMaxRows }, claimKey); }
    catch (error) { this.noteError(error); return { claimed: 0, acked: false, ...(this.paused() ? { held: "capacity" as const } : {}) }; }
    const claim = appClaimResponseSchema.safeParse(raw);
    if (!claim.success || claim.data.claimId === null || claim.data.deliveries.length === 0) return { claimed: 0, acked: false };
    const claimId = claim.data.claimId;
    const entries: CustodyEntry[] = [];
    for (const candidate of claim.data.deliveries.slice(0, limits.ackMaxReceipts)) {
      const entry = this.decide(candidate, limits);
      if (entry) entries.push(entry);
    }
    if (entries.length === 0) return { claimed: 0, acked: false };
    // Custody first: inbox rows, tombstones and the ack intent commit together, or nothing is acknowledged.
    const receipts = this.deps.store.commitClaim(claimId, entries, this.deps.now());
    return { claimed: entries.length, acked: (await this.sendAck(claimId, receipts)) === "acked" };
  }

  /** Send one claim's committed receipts. Only a confirmed answer marks them acknowledged; until then none of them
   * joins a batch. lease_expired means Flux did not commit them and will redeliver them under a new claim. */
  private async sendAck(claimId: string, receipts: Array<{ deliveryId: string; disposition: "accepted" | "dropped" }>): Promise<"acked" | "expired" | "pending"> {
    if (receipts.length === 0) return "acked";
    try {
      const ack = appAckResponseSchema.safeParse(await this.deps.client.ack({ claimId, receipts }, operationKey("ack", claimId, receipts.map(r => `${r.deliveryId}=${r.disposition}`).join(","))));
      if (!ack.success || ack.data.claimId !== claimId) return "pending";
    } catch (error) {
      this.noteError(error);
      if (error instanceof FluxAppEventsError && error.code === "lease_expired") { this.deps.store.releaseClaim(claimId); return "expired"; }
      return "pending";
    }
    this.deps.store.markAcked(claimId);
    return "acked";
  }

  /** Replays every unconfirmed ack. False when one is still pending (the next claim waits for it). */
  private async replayAcks(): Promise<boolean> {
    for (const claimId of this.deps.store.unackedClaims(PASS_LIMIT)) {
      if (this.paused()) return false;
      if ((await this.sendAck(claimId, this.deps.store.claimReceipts(claimId))) === "pending") return false;
    }
    return true;
  }

  /** Startup reconciliation, once, before the first pass (Astra r1 C2). A run that had been submitted is reattached
   * only when the host proves its root turn still exists; otherwise it is never resubmitted, keeps an uncertain
   * outcome for the owner to review, and its capacity is released. */
  async recover(): Promise<void> {
    for (const run of this.deps.store.submittedRuns(1_000)) {
      if (run.threadId && run.generation && this.deps.turnAlive?.(run) === true) continue;
      // Its usage is unknown, so no finish is invented: without renewal the Flux lease lapses (runLeaseSec).
      this.deps.store.update(run.runId, { state: "outcome_unknown", waitReason: "restart_unproven", renewDueAt: null, retryAt: null }, this.deps.now(), run.state);
    }
  }

  /** Binding recheck, freshness, bounds and filter, before anything is recorded. No model is involved. */
  private decide(candidate: unknown, limits: AppClientLimits): CustodyEntry | null {
    const parsed = appClaimItemSchema.safeParse(candidate);
    if (!parsed.success) {
      // A malformed item with a usable delivery id is dropped with an empty tombstone; without one it cannot be acked.
      const deliveryId = (candidate as { deliveryId?: unknown } | null)?.deliveryId;
      if (!fluxUuidSchema.safeParse(deliveryId).success) return null;
      return { item: { deliveryId } as unknown as AppClaimItem, binding: null, disposition: "rejected" };
    }
    const item = parsed.data;
    const binding = this.deps.store.bindingForSubscription(item.subscriptionId);
    if (!binding || !this.ownBinding(binding, item)) return { item, binding: null, disposition: "rejected" };
    if (binding.syncState !== "active") return { item, binding, disposition: "rejected" };
    if (Date.parse(item.deadlineAt) <= this.deps.now()) return { item, binding, disposition: "stale" };
    if (!projectionWithinLimits(item.projection, limits)) return { item, binding, disposition: "rejected" };
    if (!matchesFilter(binding.filter, item.projection)) return { item, binding, disposition: "filtered" };
    return { item, binding, disposition: "accept" };
  }

  /** The delivery belongs to this home's own binding: owner, home, epoch, subscription and type all match. */
  private ownBinding(binding: AppTriggerBinding, item: AppClaimItem): boolean {
    const home = this.deps.home;
    return binding.ownerAccountId === home.ownerAccountId && binding.homeId === home.homeId && binding.homeEpoch === home.homeEpoch
      && binding.subscriptionId === item.subscriptionId && binding.eventType === item.eventType;
  }

  // ── batching ──

  /** Ready deliveries join their trigger's batch (30 seconds, at most 20 events and 32 KiB); due batches seal. */
  batchPass(): void {
    const limits = this.limits;
    if (!limits) return;
    const now = this.deps.now();
    const bounds = { windowMs: APP_BATCH_WINDOW_MS, maxEvents: batchMaxEvents(limits), maxBytes: APP_BATCH_MAX_BYTES };
    for (const triggerId of this.deps.store.triggersWithReady(PASS_LIMIT)) {
      for (const ready of this.deps.store.readyDeliveries(triggerId, bounds.maxEvents)) {
        const delivery = this.deps.store.deliveryForRun(ready.deliveryId);
        if (!delivery || Date.parse(delivery.deadlineAt) <= now) { this.deps.store.markStale(ready.deliveryId); continue; }
        this.deps.store.addToBatch(triggerId, ready.deliveryId, ready.bytes, now, bounds, this.newId);
      }
    }
    this.deps.store.sealDue(now, PASS_LIMIT);
  }

  // ── runs ──

  /** Sealed batches get their run (one transaction with the membership already sealed), then due runs advance. */
  async runPass(): Promise<void> {
    if (this.paused() || !this.limits) return;
    const now = this.deps.now();
    for (const sealed of this.deps.store.sealedWithoutRun(PASS_LIMIT)) {
      const binding = this.deps.store.binding(sealed.triggerId);
      if (!binding || binding.syncState !== "active") continue;
      const run = this.deps.store.createRunForBatch({
        runId: this.newId(), batchId: sealed.batchId, triggerId: binding.triggerId, routineId: binding.routineId, botId: binding.botId,
        ownerAccountId: binding.ownerAccountId, subscriptionId: binding.subscriptionId, policyDigest: binding.policyDigest, billingRef: binding.billingRef ?? null, now,
      });
      this.deps.store.update(run.runId, { retryAt: now }, now);
    }
    for (const run of this.deps.store.dueRuns(now, PASS_LIMIT)) {
      if (this.paused()) return;
      await this.advance(run);
    }
  }

  private async advance(run: AppEventRun): Promise<void> {
    if (run.state === "sealed" || run.state === "budget_wait") return this.reserve(run);
    if (run.state === "reserved" || run.state === "starting") return this.start(run);
    if (run.state === "running") return this.renew(run);
  }

  /** Reserve with the literal zeros and the bot's billingRef. A run without one is refused here, before reserve. */
  private async reserve(run: AppEventRun): Promise<void> {
    const now = this.deps.now();
    if (!run.billingRef) { this.deps.store.update(run.runId, { state: "refused", waitReason: "billing_missing", retryAt: null }, now, run.state); return; }
    const body: ReserveBody = {
      version: 1, subscriptionId: run.subscriptionId, deliveryIds: this.deps.store.batchMembers(run.batchId), policyDigest: run.policyDigest, billingRef: run.billingRef,
      childCreates: APP_RUN_CONTEXT.childCreates, childHandoffs: APP_RUN_CONTEXT.childHandoffs,
    };
    let view: FluxRunView;
    try {
      const parsed = fluxRunViewSchema.safeParse(await this.deps.client.reserve(run.runId, body, operationKey("reserve", run.runId)));
      if (!parsed.success || parsed.data.runId !== run.runId) { this.deps.store.update(run.runId, { retryAt: now + RETRY_SOON_MS }, now, run.state); return; }
      view = parsed.data;
    } catch (error) {
      this.noteError(error);
      if (error instanceof FluxAppEventsError && (error.code === "capacity_exceeded" || error.code === "allowance_exhausted")) {
        // Waiting for allowance: a state, not a failure. The same reserve (same key, same body) is retried when Flux says.
        this.deps.store.update(run.runId, { state: "budget_wait", waitReason: error.code, retryAt: now + Math.max(1, error.retryAfterSec ?? 60) * 1000 }, now, run.state);
      } else if (error instanceof FluxAppEventsError && !error.retryable && error.code !== "unexpected") {
        this.deps.store.update(run.runId, { state: error.code === "billing_revoked" ? "refused" : "failed", waitReason: error.code, retryAt: null }, now, run.state);
      } else {
        this.deps.store.update(run.runId, { retryAt: now + RETRY_SOON_MS }, now, run.state);
      }
      return;
    }
    this.deps.store.update(run.runId, { state: "reserved", waitReason: null, fluxRevision: view.revision, reserveReceipt: view, retryAt: now }, now, run.state);
  }

  /** Persist `starting` before the call; only the first reserved->working answer (newlyStarted:true) submits, once. */
  private async start(run: AppEventRun): Promise<void> {
    const now = this.deps.now();
    if (run.submitted) return;
    const starting = run.state === "starting" ? run : this.deps.store.update(run.runId, { state: "starting" }, now, "reserved");
    if (!starting) return;
    let view: FluxRunView;
    try {
      const parsed = fluxRunViewSchema.safeParse(await this.deps.client.start(run.runId, { expectedRevision: starting.fluxRevision ?? 0 }, operationKey("start", run.runId)));
      if (!parsed.success || parsed.data.runId !== run.runId || parsed.data.newlyStarted === undefined) { this.deps.store.update(run.runId, { retryAt: now + RETRY_SOON_MS }, now, "starting"); return; }
      view = parsed.data;
    } catch (error) {
      this.noteError(error);
      const terminal = error instanceof FluxAppEventsError && !error.retryable && error.code !== "unexpected";
      this.deps.store.update(run.runId, terminal ? { state: "failed", waitReason: (error as FluxAppEventsError).code, retryAt: null } : { retryAt: now + RETRY_SOON_MS }, now, "starting");
      return;
    }
    if (view.newlyStarted !== true) {
      // A replayed or later start never authorizes a submission. Nothing was submitted from here (the receipt is
      // persisted before submitting), so the run cannot do its work: it is shown for review. No finish is sent (run
      // settlement moved to AT-S2): without renewal its Flux lease simply lapses in runLeaseSec (90 s), which releases
      // its capacity, as on the other uncertain paths.
      this.deps.store.update(run.runId, { state: "outcome_unknown", waitReason: "start_replayed", fluxRevision: view.revision, retryAt: null }, now, "starting");
      return;
    }
    // The first receipt is durable before the one submission; a crash after this line never submits again (startup
    // reconciliation then holds the run for review).
    const running = this.deps.store.update(run.runId, { state: "running", startReceipt: view, fluxRevision: view.revision, submitted: true, renewDueAt: now + this.renewMs(), retryAt: now + this.renewMs() }, now, "starting");
    if (!running) return;
    try {
      // The run thread is the run's lineage, persisted before its turn starts, so the hard zero sees every turn of it.
      const threadId = await this.deps.submit.thread(running);
      const withThread = this.deps.store.update(run.runId, { threadId }, this.deps.now(), "running");
      if (!withThread) return;
      const turn = await this.deps.submit.start({ ...withThread, threadId }, this.deps.store.batchMembers(running.batchId));
      this.deps.store.update(run.runId, { generation: turn.generation }, this.deps.now());
    } catch {
      // A turn may have begun, so no zero-usage finish is invented; without renewal the Flux lease lapses.
      this.deps.store.update(run.runId, { state: "outcome_unknown", waitReason: "submission_uncertain", renewDueAt: null, retryAt: null }, this.deps.now(), "running");
    }
  }

  private renewMs(): number { return (this.limits?.runRenewIntervalSec ?? 30) * 1000; }

  private async renew(run: AppEventRun): Promise<void> {
    const now = this.deps.now();
    try {
      const parsed = fluxRunViewSchema.safeParse(await this.deps.client.renew(run.runId, { expectedRevision: run.fluxRevision ?? 0, state: "working" }, operationKey("renew", run.runId, run.fluxRevision ?? 0)));
      if (!parsed.success) { this.deps.store.update(run.runId, { retryAt: now + 5_000 }, now, "running"); return; }
      this.deps.store.update(run.runId, { fluxRevision: parsed.data.revision, renewDueAt: now + this.renewMs(), retryAt: now + this.renewMs() }, now, "running");
    } catch (error) {
      this.noteError(error);
      if (error instanceof FluxAppEventsError && error.code === "revision_conflict") {
        try {
          const current = fluxRunViewSchema.safeParse(await this.deps.client.getRun(run.runId));
          if (current.success) this.deps.store.update(run.runId, { fluxRevision: current.data.revision, retryAt: now }, now, "running");
        } catch (inner) { this.noteError(inner); }
        return;
      }
      if (error instanceof FluxAppEventsError && (error.code === "lease_expired" || error.code === "run_expired" || error.code === "lease_conflict")) {
        // Renewal lost: later calls are fenced and the run keeps an uncertain outcome; nothing resubmits it.
        this.deps.store.update(run.runId, { state: "outcome_unknown", waitReason: error.code, retryAt: null }, now, "running");
        return;
      }
      this.deps.store.update(run.runId, { retryAt: now + 5_000 }, now, "running");
    }
  }
}
