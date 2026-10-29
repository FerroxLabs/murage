// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The native HighLevel client (GAP-HIGHLEVEL-109 sections 7, 9.2 and 13). One typed function per manifest endpoint,
// outputs trimmed to what a person cares about. Ported from OpenMausBot server/highlevel/client.ts with these changes:
//   - credentials come from an injected HighLevelLeaseSource (the broker implements it later). The client never
//     stores a token beyond a short in-memory lease, never refreshes one itself and never holds a refresh token;
//   - a lease must name the connection, epoch, location and company the call was authorized for, so a refresh or
//     reconnect can never carry a call onto another sign-in (upstream 3ecde6284);
//   - the host is fixed: no constructor or environment override (follow-up R1-M2);
//   - a write is sent once. Only a confirmed refusal (401 or 429) may send it again, and after anything that may have
//     reached HighLevel (5xx, timeout, cut-off or malformed answer, redirect) its outcome is unknown (3ecde6284);
//   - Stop (H3): every wait (rate room, Retry-After, the one read retry) ends at once on the turn's abort signal, and
//     the turn is checked again after every wait and before every request, so no next request leaves for a stopped
//     turn (upstream b075d6be4). The turn is also checked before any lease request, because a lease request is what
//     lets the broker start a refresh: a stopped turn starts none, and a lease that arrives after Stop is dropped,
//     never used (upstream 746a718f4).
import { randomUUID } from "node:crypto";
import {
  endpointFor,
  HIGHLEVEL_API_ORIGIN,
  HIGHLEVEL_ENDPOINTS,
  HIGHLEVEL_PERMISSION_NAMES,
  type HighLevelOperation,
} from "./provider-contract.ts";

/** Client-side budget under HighLevel's 100 requests per 10 s per resource. */
export const BUDGET_CALLS = 90;
export const BUDGET_WINDOW_MS = 10_000;
export const BACKOFF_MAX_MS = 10_000;
/** The longest Retry-After a read waits out (in Stop-cancellable time); a longer one is reported, not waited. */
export const RETRY_AFTER_MAX_MS = 60_000;
/** A lease this close to the provider's expiry is not used; a new lease request lets the broker refresh. */
export const REFRESH_MARGIN_MS = 60_000;
/** A lease lives in runtime memory at most this long. */
export const LEASE_MEMORY_MS = 60_000;
export const REQUEST_DEADLINE_MS = 30_000;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const READ_RETRY_DELAY_MS = 1_000;
const CUSTOM_FIELDS_TTL_MS = 10 * 60_000;
const CUSTOM_FIELDS_ENTRIES = 100;
const LEASE_ENTRIES = 200;
const RATE_RESOURCES = 1_000;
const DAILY_HOLD_MS = 60_000;
const TEXT_MAX = 4_000;
export const PAGE_MAX = 50;
export const PAGE_NUMBER_MAX = 1_000;

export type HighLevelOutcome = "not_applied" | "outcome_unknown";

export class HighLevelError extends Error {
  readonly status: number | undefined;
  /** For a change: not_applied when HighLevel provably did not apply it, outcome_unknown when it may have. */
  readonly outcome: HighLevelOutcome;
  /** The connection needs Reconnect; the tool answer tells the bot to ask the person. */
  readonly signedOut: boolean;
  constructor(message: string, options: { status?: number; outcome?: HighLevelOutcome; signedOut?: boolean } = {}) {
    super(message);
    this.name = "HighLevelError";
    this.status = options.status;
    this.outcome = options.outcome ?? "not_applied";
    this.signedOut = options.signedOut === true;
  }
}

/** The turn was stopped before the request was sent. Thrown only before a send, so a change is provably not applied. */
export class HighLevelStopped extends Error {
  readonly reason = "stopped_before_send";
  constructor() {
    super("Stopped. Nothing more was sent to the CRM.");
    this.name = "HighLevelStopped";
  }
}

export type HighLevelConnectionState =
  | "connected" | "degraded" | "pending_browser_confirmation" | "needs_reconnect" | "disconnecting" | "disconnected";

/** Redacted connection metadata from the broker. Only `connected` and `degraded` can carry a call. */
export interface HighLevelConnectionView {
  connectionId: string;
  locationId: string;
  companyId: string;
  locationName?: string;
  epoch: number;
  state: HighLevelConnectionState;
}

/** One first-delivery credential lease (section 5, CredentialLease). Only the native client ever sees accessToken. */
export interface HighLevelLease {
  leaseId: string;
  requestId: string;
  connectionId: string;
  connectionEpoch: number;
  locationId: string;
  companyId: string;
  credentialVersion: number;
  accessToken: string;
  providerExpiresAt?: number;
  discardAt: number;
}

export interface HighLevelLeaseRequest {
  /** A new id per request: a lost response is never replayed, a new request is made. */
  requestId: string;
  connectionId: string;
  connectionEpoch: number;
  /** expired: HighLevel rejected the last lease's token, so the broker may rotate once. */
  reason: "use" | "expired";
}

/** The broker side. Implemented by the broker client later; tests use a fake. */
export interface HighLevelLeaseSource {
  connection(connectionId: string): Promise<HighLevelConnectionView | undefined>;
  lease(request: HighLevelLeaseRequest): Promise<HighLevelLease>;
}

/** What one tool call carries into the client. */
export interface HighLevelCallContext {
  connection: HighLevelConnectionView;
  /** Throws HighLevelStopped when the turn is no longer active. */
  assertActive(): void;
  /** Fired by Stop (highlevelCalls.turnEnded). */
  signal: AbortSignal;
  /** Called immediately before a change is sent (once: a change is never sent again). It rechecks the authority
   * and approval as they are now and records the send; it throws to refuse it. */
  onDispatch?: (attempt: number) => void | Promise<void>;
}

export type HighLevelSleep = (ms: number, signal: AbortSignal) => Promise<void>;

const defaultSleep: HighLevelSleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
  signal.addEventListener("abort", done, { once: true });
});

/** Any wait, ended at once by Stop whatever the injected sleep does. */
async function waitOrStop(sleep: HighLevelSleep, ms: number, ctx: HighLevelCallContext): Promise<void> {
  if (ctx.signal.aborted) throw new HighLevelStopped();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new HighLevelStopped());
    ctx.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(ms, ctx.signal), aborted]);
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
  }
  ctx.assertActive();
}

// ---- rate admission ---------------------------------------------------------------------------------------------------

type Slot = { at: number; spent: boolean };
export interface RateReservation { spend(): void; release(): void }

/** Shared admission per HighLevel resource (a location). waiting -> reserved -> spent, or waiting -> cancelled.
 * A reservation is released only while dispatch is provably absent; once spent it counts until its window ends. */
export class HighLevelRateGate {
  readonly #windows = new Map<string, Slot[]>();
  readonly #heldUntil = new Map<string, number>();
  readonly #dailyHeldUntil = new Map<string, number>();
  readonly #now: () => number;
  readonly #sleep: HighLevelSleep;

  constructor(options: { now?: () => number; sleep?: HighLevelSleep } = {}) {
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async admit(resource: string, ctx: HighLevelCallContext): Promise<RateReservation> {
    for (;;) {
      ctx.assertActive();
      const now = this.#now();
      if ((this.#dailyHeldUntil.get(resource) ?? 0) > now) {
        throw new HighLevelError("HighLevel's daily request limit for this location is used up. Nothing was sent; try again later.", { status: 429 });
      }
      const held = this.#heldUntil.get(resource) ?? 0;
      const slots = (this.#windows.get(resource) ?? []).filter((slot) => !slot.spent || now - slot.at < BUDGET_WINDOW_MS);
      this.#windows.set(resource, slots);
      if (held <= now && slots.length < BUDGET_CALLS) {
        const slot: Slot = { at: now, spent: false };
        slots.push(slot);
        this.#bound();
        return {
          spend: () => { slot.spent = true; slot.at = this.#now(); },
          release: () => {
            if (slot.spent) return;
            const list = this.#windows.get(resource);
            const index = list?.indexOf(slot) ?? -1;
            if (index >= 0) list!.splice(index, 1);
          },
        };
      }
      const oldest = slots.find((slot) => slot.spent);
      const until = Math.max(held, oldest ? oldest.at + BUDGET_WINDOW_MS : now + 1);
      await waitOrStop(this.#sleep, Math.min(BACKOFF_MAX_MS, Math.max(1, until - now)), ctx);
    }
  }

  /** Lower the budget from HighLevel's own headers: no burst room left holds the resource for its interval. */
  observe(resource: string, headers: Headers): void {
    const now = this.#now();
    if (headers.get("x-ratelimit-remaining")?.trim() === "0") {
      const interval = Number(headers.get("x-ratelimit-interval-milliseconds"));
      this.#heldUntil.set(resource, now + (Number.isFinite(interval) && interval > 0 ? Math.min(interval, BACKOFF_MAX_MS) : BUDGET_WINDOW_MS));
    }
    if (headers.get("x-ratelimit-daily-remaining")?.trim() === "0") this.#dailyHeldUntil.set(resource, now + DAILY_HOLD_MS);
  }

  /** Reservations not yet spent, for tests and health. */
  pending(resource: string): number {
    return (this.#windows.get(resource) ?? []).filter((slot) => !slot.spent).length;
  }

  #bound(): void {
    while (this.#windows.size > RATE_RESOURCES) {
      const key = [...this.#windows].find(([, slots]) => slots.every((slot) => slot.spent))?.[0];
      if (key === undefined) return;
      this.#windows.delete(key);
      this.#heldUntil.delete(key);
      this.#dailyHeldUntil.delete(key);
    }
  }
}

// ---- shapes and helpers -------------------------------------------------------------------------------------------------

type Query = Record<string, string | number | undefined>;
type Json = Record<string, unknown>;
interface RequestOptions { query?: Query; body?: unknown }

const isRecord = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value.slice(0, TEXT_MAX) : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const bool = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord).slice(0, 500) : []);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 200) : []);
const compact = <T extends object>(record: T): T => Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
const pageSize = (value: number | undefined) => Math.min(PAGE_MAX, Math.max(1, Math.floor(value ?? 20)));
const pageNumber = (value: number | undefined) => Math.min(PAGE_NUMBER_MAX, Math.max(1, Math.floor(value ?? 1)));
const id = (value: string) => encodeURIComponent(value);

export interface CustomFieldDefinition { id: string; name: string; key?: string; dataType?: string; model?: string; options?: string[] }

export interface ContactFields {
  firstName?: string; lastName?: string; name?: string; email?: string; phone?: string; companyName?: string;
  tags?: string[]; source?: string; address1?: string; city?: string; state?: string; postalCode?: string; country?: string;
  website?: string; timezone?: string; assignedTo?: string; dateOfBirth?: string;
  /** By custom field name or key; the client maps names to ids. */
  customFields?: Record<string, unknown>;
}

export interface TrimmedContact {
  id: string; name?: string; firstName?: string; lastName?: string; email?: string; phone?: string; companyName?: string;
  tags: string[]; source?: string; assignedTo?: string; dateAdded?: string; dateUpdated?: string; website?: string; timezone?: string;
  dnd?: boolean; address?: { address1?: string; city?: string; state?: string; postalCode?: string; country?: string };
  customFields?: Record<string, unknown>;
}

function thing(operation: HighLevelOperation): string {
  if (operation.startsWith("contacts.notes")) return "note";
  if (operation.startsWith("contacts.tasks")) return "task";
  if (operation.startsWith("contacts")) return "contact";
  if (operation.startsWith("pipelines")) return "pipeline";
  if (operation.startsWith("opportunities")) return "opportunity";
  if (operation.startsWith("conversations")) return "conversation";
  if (operation.startsWith("calendars")) return "calendar";
  if (operation.startsWith("locations")) return "location";
  return "record";
}

function rawApiMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const message = body.message ?? body.error;
  if (typeof message === "string") return message || undefined;
  if (Array.isArray(message)) return message.filter((item) => typeof item === "string").join("; ") || undefined;
  return undefined;
}

const SECRET_SHAPES = [/\bBearer\s+[\w.~+/=-]{8,}/giu, /\bpit-[\w-]{4,}/gu, /\beyJ[\w-]{6,}(?:\.[\w-]*)*/gu] as const;

/** Removes the given secrets and anything shaped like a token (Bearer values, pit- tokens, JWTs). */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  for (const shape of SECRET_SHAPES) out = out.replace(shape, "[redacted]");
  return out;
}

/** HighLevel's own short explanation, safe to show: secrets redacted, one line, cut short. */
export function apiMessage(body: unknown, secrets: readonly string[] = [], max = 300): string | undefined {
  const raw = rawApiMessage(body);
  if (!raw) return undefined;
  const text = redactSecrets(raw, secrets).replace(/[\p{Cc}\s]+/gu, " ").trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A live token that lacks a scope gets 401 too; only this wording says scope. It is a missing permission, not a sign-out. */
const SCOPE_REFUSAL = /not authori[sz]ed for (?:this|the) scope|insufficient[_ ]scope/iu;
export const isScopeRefusal = (body: unknown): boolean => SCOPE_REFUSAL.test(rawApiMessage(body) ?? "");

export const HIGHLEVEL_RECONNECT_TEXT = "HighLevel needs Reconnect for this location. Ask the owner to open the HighLevel CRM card and choose Reconnect, then end this turn.";

function refusal(status: number, operation: HighLevelOperation, body: unknown, secrets: readonly string[]): HighLevelError {
  const detail = apiMessage(body, secrets);
  const said = detail ? ` HighLevel said: ${detail}` : "";
  const scope = HIGHLEVEL_ENDPOINTS[operation].scope;
  const permission = HIGHLEVEL_PERMISSION_NAMES[scope] ? `${HIGHLEVEL_PERMISSION_NAMES[scope]} permission (${scope})` : `${scope} permission`;
  if ((status === 401 && isScopeRefusal(body)) || status === 403) {
    return new HighLevelError(`HighLevel refused this (${status}): the connection lacks the ${permission}. The owner can Reconnect and allow it.${said}`, { status });
  }
  if (status === 401) return new HighLevelError(HIGHLEVEL_RECONNECT_TEXT, { status, signedOut: true });
  if (status === 404) return new HighLevelError(`HighLevel has no ${thing(operation)} with that id (404).`, { status });
  if (status === 429) return new HighLevelError("HighLevel is limiting requests right now, so this was not done. Try again in a minute.", { status });
  return new HighLevelError(`HighLevel rejected this (${status})${detail ? `: ${detail}` : "."}`, { status });
}

function unknownOutcome(operation: HighLevelOperation, cause: string, status?: number): HighLevelError {
  return new HighLevelError(`${cause}, and the ${thing(operation)} may have been saved anyway. Check the CRM before trying again, so it is not added twice.`, { status, outcome: "outcome_unknown" });
}

function retryAfterMs(headers: Headers, now: number): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  const interval = Number(headers.get("x-ratelimit-interval-milliseconds"));
  if (Number.isFinite(interval) && interval > 0) return interval;
  return 2_000;
}

/** HighLevel's answer for a dead token. Only this permits asking for a rotated lease; an unreadable 401 does not. */
const EXPIRED_TOKEN = /invalid jwt|jwt (?:is )?expired|token (?:is |has )?expired|expired token/iu;
const isExpiredToken = (body: unknown): boolean => EXPIRED_TOKEN.test(rawApiMessage(body) ?? "");

/** The body as UTF-8 text, or null once it passes `max` bytes; reading stops there and counts real bytes. */
async function textUpTo(response: Response, max: number): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return new TextDecoder().decode(Buffer.concat(chunks));
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
}

// ---- the client -------------------------------------------------------------------------------------------------------

export interface HighLevelClientOptions {
  leases: HighLevelLeaseSource;
  /** Tests hand a fake fetch; the URL always starts with the fixed origin. */
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: HighLevelSleep;
  gate?: HighLevelRateGate;
  deadlineMs?: number;
}

type CachedLease = { lease: HighLevelLease; usableUntil: number };

/** A lease carries only the exact connection, epoch, location and company the call was authorized for. */
const leaseMatches = (lease: HighLevelLease, connection: HighLevelConnectionView): boolean =>
  lease.connectionId === connection.connectionId && lease.connectionEpoch === connection.epoch
  && lease.locationId === connection.locationId && lease.companyId === connection.companyId && Boolean(lease.accessToken);

export class HighLevelClient {
  readonly #leases: HighLevelLeaseSource;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: HighLevelSleep;
  readonly #deadlineMs: number;
  readonly gate: HighLevelRateGate;
  readonly #cache = new Map<string, CachedLease>();
  readonly #fields = new Map<string, { at: number; fields: CustomFieldDefinition[]; refused?: HighLevelError }>();

  constructor(options: HighLevelClientOptions) {
    this.#leases = options.leases;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#deadlineMs = options.deadlineMs ?? REQUEST_DEADLINE_MS;
    this.gate = options.gate ?? new HighLevelRateGate({ now: this.#now, sleep: this.#sleep });
  }

  /** Typed CRM calls bound to one authorized call. */
  crm(ctx: HighLevelCallContext): HighLevelCrm {
    return new HighLevelCrm(this, ctx);
  }

  /** Forget every lease for a connection (disconnect, epoch change, Stop of the whole app). */
  forget(connectionId: string): void {
    this.#cache.delete(connectionId);
    for (const key of this.#fields.keys()) if (key.startsWith(`${connectionId}\u0000`)) this.#fields.delete(key);
  }

  /** Whether a held lease can still carry a send right now. */
  #fresh(lease: HighLevelLease): boolean {
    const now = this.#now();
    return lease.discardAt > now && (lease.providerExpiresAt === undefined || lease.providerExpiresAt > now);
  }

  async #lease(ctx: HighLevelCallContext, reason: HighLevelLeaseRequest["reason"]): Promise<HighLevelLease> {
    const { connection } = ctx;
    const now = this.#now();
    const cached = this.#cache.get(connection.connectionId);
    if (reason === "use" && cached && cached.usableUntil > now && leaseMatches(cached.lease, connection)) return cached.lease;
    this.#cache.delete(connection.connectionId);
    // Stop before refresh (H3): a lease request is what lets the broker rotate, so a stopped turn sends none.
    ctx.assertActive();
    if (ctx.signal.aborted) throw new HighLevelStopped();
    const lease = await this.#leases.lease({ requestId: randomUUID(), connectionId: connection.connectionId, connectionEpoch: connection.epoch, reason });
    // A lease that arrives after Stop is never used by the stopped turn and never kept for another.
    ctx.assertActive();
    if (ctx.signal.aborted) throw new HighLevelStopped();
    if (!leaseMatches(lease, connection)) {
      throw new HighLevelError("The HighLevel connection changed while this call ran. Nothing was sent; run it again.", { status: 409 });
    }
    const after = this.#now();
    if (lease.discardAt <= after || (lease.providerExpiresAt !== undefined && lease.providerExpiresAt <= after)) {
      throw new HighLevelError("HighLevel's sign-in could not be renewed right now. Nothing was sent; try again in a minute.", { status: 503 });
    }
    const usableUntil = Math.min(lease.discardAt, after + LEASE_MEMORY_MS, (lease.providerExpiresAt ?? Infinity) - REFRESH_MARGIN_MS);
    if (usableUntil > after) {
      this.#cache.set(connection.connectionId, { lease, usableUntil });
      while (this.#cache.size > LEASE_ENTRIES) this.#cache.delete(this.#cache.keys().next().value!);
    }
    return lease;
  }

  /** One manifest request. A read may be sent again once in all (after 5xx, no answer, 429 or an expired token);
   * a change is sent exactly once: any failure after it may have left is outcome_unknown, a refusal is not_applied. */
  async request(ctx: HighLevelCallContext, operation: HighLevelOperation, path: string, options: RequestOptions = {}): Promise<unknown> {
    const declared = HIGHLEVEL_ENDPOINTS[operation];
    const entry = endpointFor(operation, declared.method, path);
    if (!entry) throw new HighLevelError("Murage never sends this request to HighLevel.", { status: 400 });
    const write = entry.retry === "write";
    const url = new URL(`${HIGHLEVEL_API_ORIGIN}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    if (url.origin !== HIGHLEVEL_API_ORIGIN || url.pathname !== path) throw new HighLevelError("Murage never sends this request to HighLevel.", { status: 400 });
    let reason: HighLevelLeaseRequest["reason"] = "use";
    let retried = false;
    for (;;) {
      ctx.assertActive();
      let lease = await this.#lease(ctx, reason);
      reason = "use";
      const reservation = await this.gate.admit(ctx.connection.locationId, ctx);
      try {
        ctx.assertActive();
        if (ctx.signal.aborted) throw new HighLevelStopped();
        // A long rate wait can outlive the lease: take a fresh one (Stop is checked first) rather than send a stale one.
        if (!this.#fresh(lease)) {
          this.#cache.delete(ctx.connection.connectionId);
          lease = await this.#lease(ctx, "use");
          ctx.assertActive();
        }
        if (write) await ctx.onDispatch?.(1);
        ctx.assertActive();
        if (ctx.signal.aborted) throw new HighLevelStopped();
      } catch (error) {
        reservation.release();
        throw error;
      }
      reservation.spend();
      const deadline = AbortSignal.timeout(this.#deadlineMs);
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: entry.method,
          redirect: "manual",
          headers: {
            authorization: `Bearer ${lease.accessToken}`,
            version: entry.version,
            accept: "application/json",
            ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          // A sent change is not recalled by Stop: its answer still decides the outcome.
          signal: write ? deadline : AbortSignal.any([deadline, ctx.signal]),
        });
      } catch {
        if (write) throw unknownOutcome(operation, "HighLevel did not answer (the request timed out or the network failed)", 503);
        if (ctx.signal.aborted) throw new HighLevelStopped();
        if (!retried) { retried = true; await waitOrStop(this.#sleep, READ_RETRY_DELAY_MS, ctx); continue; }
        throw new HighLevelError("HighLevel did not answer (the request timed out or the network failed); try again in a minute.", { status: 503 });
      }
      this.gate.observe(ctx.connection.locationId, response.headers);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        if (write) throw unknownOutcome(operation, `HighLevel answered with a redirect (${response.status}), which Murage never follows`, response.status);
        throw new HighLevelError(`HighLevel answered with a redirect (${response.status}), which Murage never follows.`, { status: response.status });
      }
      if (response.ok) return this.#body(response, operation, write, ctx);
      if (response.status >= 500) {
        await response.body?.cancel().catch(() => {});
        if (write) throw unknownOutcome(operation, `HighLevel had trouble (${response.status})`, response.status);
        if (!retried) { retried = true; await waitOrStop(this.#sleep, READ_RETRY_DELAY_MS, ctx); continue; }
        throw new HighLevelError(`HighLevel is having trouble (${response.status}); try again in a minute.`, { status: response.status });
      }
      let body: unknown = {};
      try {
        const text = await textUpTo(response, 64 * 1024);
        body = text ? JSON.parse(text) : {};
      } catch { body = {}; }
      const expired = response.status === 401 && !isScopeRefusal(body) && isExpiredToken(body);
      if (expired) this.#cache.delete(ctx.connection.connectionId);
      if (!write && !retried && expired) {
        // A confirmed refusal: one new lease, which may let the broker rotate once.
        retried = true;
        reason = "expired";
        continue;
      }
      if (!write && !retried && response.status === 429) {
        const wait = retryAfterMs(response.headers, this.#now());
        if (wait <= RETRY_AFTER_MAX_MS) {
          retried = true;
          await waitOrStop(this.#sleep, wait, ctx);
          continue;
        }
      }
      if (write && expired) throw new HighLevelError("HighLevel did not accept the sign-in for this change, so it was not made. Try again; if it keeps happening, the owner can Reconnect.", { status: 401 });
      throw refusal(response.status, operation, body, [lease.accessToken]);
    }
  }

  async #body(response: Response, operation: HighLevelOperation, write: boolean, ctx: HighLevelCallContext): Promise<unknown> {
    let text: string | null;
    try {
      text = await textUpTo(response, MAX_RESPONSE_BYTES);
    } catch {
      if (write) throw unknownOutcome(operation, "HighLevel's answer was cut off");
      if (ctx.signal.aborted) throw new HighLevelStopped();
      throw new HighLevelError("HighLevel's answer was cut off; try again in a minute.", { status: 503 });
    }
    if (text === null) {
      if (write) throw unknownOutcome(operation, "HighLevel's answer was too large to read", response.status);
      throw new HighLevelError("HighLevel's answer was too large to read; narrow the request.", { status: response.status });
    }
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      if (write) throw unknownOutcome(operation, "HighLevel's answer could not be read", response.status);
      throw new HighLevelError("HighLevel's answer could not be read; try again in a minute.", { status: response.status });
    }
  }

  /** Custom field definitions, cached per connection and epoch for ten minutes, at most 100 entries. */
  async customFields(ctx: HighLevelCallContext): Promise<CustomFieldDefinition[]> {
    const key = `${ctx.connection.connectionId}\u0000${ctx.connection.epoch}`;
    const cached = this.#fields.get(key);
    if (cached && this.#now() - cached.at < CUSTOM_FIELDS_TTL_MS) {
      if (cached.refused) throw cached.refused;
      return cached.fields;
    }
    let raw: unknown;
    try {
      raw = await this.request(ctx, "locations.customFields", `/locations/${id(ctx.connection.locationId)}/customFields`);
    } catch (error) {
      if (error instanceof HighLevelError && !error.signedOut && (error.status === 401 || error.status === 403)) this.#remember(key, { at: this.#now(), fields: [], refused: error });
      throw error;
    }
    const fields = list(isRecord(raw) ? raw.customFields : []).flatMap((field) => {
      const fieldId = str(field.id);
      const name = str(field.name);
      if (!fieldId || !name) return [];
      const options = strings(field.picklistOptions);
      return [compact<CustomFieldDefinition>({ id: fieldId, name, key: str(field.fieldKey), dataType: str(field.dataType), model: str(field.model), ...(options.length ? { options } : {}) })];
    });
    this.#remember(key, { at: this.#now(), fields });
    return fields;
  }

  #remember(key: string, entry: { at: number; fields: CustomFieldDefinition[]; refused?: HighLevelError }): void {
    this.#fields.delete(key);
    this.#fields.set(key, entry);
    while (this.#fields.size > CUSTOM_FIELDS_ENTRIES) this.#fields.delete(this.#fields.keys().next().value!);
  }
}

/** The twenty tools' provider calls, bound to one authorized call and its one location. */
export class HighLevelCrm {
  readonly #client: HighLevelClient;
  readonly #ctx: HighLevelCallContext;
  constructor(client: HighLevelClient, ctx: HighLevelCallContext) { this.#client = client; this.#ctx = ctx; }

  #req(operation: HighLevelOperation, path: string, options?: RequestOptions) { return this.#client.request(this.#ctx, operation, path, options); }
  /** A change's answer must show the saved record; a 2xx without it proves nothing, so the outcome is unknown. */
  #saved(operation: HighLevelOperation, raw: unknown, key: "contact" | "note" | "task" | "opportunity"): Json {
    const record = isRecord(raw) && isRecord(raw[key]) ? raw[key] : null;
    if (!record || !str(record.id)) throw unknownOutcome(operation, "HighLevel answered without the saved record", 200);
    return record;
  }
  #tagsSaved(operation: HighLevelOperation, raw: unknown): string[] {
    if (!isRecord(raw) || !Array.isArray(raw.tags)) throw unknownOutcome(operation, "HighLevel answered without the contact's tags", 200);
    return strings(raw.tags);
  }
  get #location() { return this.#ctx.connection.locationId; }
  /** Optional on reads: without View Custom Fields, fields show by id and the call still works. */
  #definitions(): Promise<CustomFieldDefinition[]> { return this.#client.customFields(this.#ctx).catch(() => []); }

  async #customFieldsByName(values: Record<string, unknown> | undefined): Promise<Array<{ id: string; field_value: unknown }> | undefined> {
    if (!values || Object.keys(values).length === 0) return undefined;
    const definitions = await this.#client.customFields(this.#ctx);
    const out: Array<{ id: string; field_value: unknown }> = [];
    for (const [name, value] of Object.entries(values)) {
      const wanted = name.trim().toLowerCase();
      const matches = definitions.filter((field) => field.id === name || field.name.toLowerCase() === wanted || field.key?.toLowerCase() === wanted || field.key?.toLowerCase() === `contact.${wanted}`);
      if (matches.length !== 1) {
        throw new HighLevelError(matches.length === 0
          ? `HighLevel has no custom field named "${name.slice(0, 80)}". HIGHLEVEL_GET_LOCATION lists the custom fields.`
          : `More than one custom field matches "${name.slice(0, 80)}". Use its id from HIGHLEVEL_GET_LOCATION.`, { status: 400 });
      }
      out.push({ id: matches[0]!.id, field_value: value });
    }
    return out;
  }

  #namedCustomFields(raw: unknown, definitions: CustomFieldDefinition[]): Record<string, unknown> | undefined {
    const entries = list(raw).flatMap((field) => {
      const fieldId = str(field.id);
      if (!fieldId) return [];
      const value = field.value ?? field.fieldValue ?? field.field_value;
      if (value === undefined || value === null || value === "") return [];
      const definition = definitions.find((candidate) => candidate.id === fieldId);
      return [[definition?.name ?? fieldId, typeof value === "string" ? value.slice(0, TEXT_MAX) : value] as const];
    });
    return entries.length ? Object.fromEntries(entries) : undefined;
  }

  #trimContact(raw: Json, definitions: CustomFieldDefinition[]): TrimmedContact {
    const address = compact({ address1: str(raw.address1), city: str(raw.city), state: str(raw.state), postalCode: str(raw.postalCode), country: str(raw.country) });
    return compact<TrimmedContact>({
      id: String(raw.id ?? ""), name: str(raw.name) ?? str(raw.contactName), firstName: str(raw.firstName), lastName: str(raw.lastName),
      email: str(raw.email), phone: str(raw.phone), companyName: str(raw.companyName), tags: strings(raw.tags), source: str(raw.source),
      assignedTo: str(raw.assignedTo), dateAdded: str(raw.dateAdded), dateUpdated: str(raw.dateUpdated), website: str(raw.website),
      timezone: str(raw.timezone), dnd: bool(raw.dnd), ...(Object.keys(address).length ? { address } : {}),
      customFields: this.#namedCustomFields(raw.customFields, definitions),
    });
  }

  async #contactBody(fields: ContactFields): Promise<Json> {
    const { customFields, ...plain } = fields;
    const mapped = await this.#customFieldsByName(customFields);
    return compact({ ...plain, ...(mapped ? { customFields: mapped } : {}) });
  }

  async searchContacts(input: { query?: string; tag?: string; email?: string; phone?: string; page?: number; limit?: number }) {
    const filters: Json[] = [];
    if (input.email) filters.push({ field: "email", operator: "eq", value: input.email });
    if (input.phone) filters.push({ field: "phone", operator: "eq", value: input.phone });
    if (input.tag) filters.push({ field: "tags", operator: "eq", value: input.tag });
    const current = pageNumber(input.page);
    const raw = await this.#req("contacts.search", "/contacts/search", { body: compact({
      locationId: this.#location, page: current, pageLimit: pageSize(input.limit), query: input.query?.trim() || undefined, ...(filters.length ? { filters } : {}),
    }) });
    const definitions = await this.#definitions();
    const record = isRecord(raw) ? raw : {};
    return compact({ contacts: list(record.contacts).slice(0, PAGE_MAX).map((contact) => this.#trimContact(contact, definitions)), total: num(record.total) ?? num(record.count), page: current });
  }

  async getContact(contactId: string): Promise<TrimmedContact> {
    const raw = await this.#req("contacts.get", `/contacts/${id(contactId)}`);
    return this.#trimContact(isRecord(raw) && isRecord(raw.contact) ? raw.contact : {}, await this.#definitions());
  }

  async createContact(fields: ContactFields): Promise<TrimmedContact> {
    const raw = await this.#req("contacts.create", "/contacts/", { body: { ...(await this.#contactBody(fields)), locationId: this.#location } });
    return this.#trimContact(this.#saved("contacts.create", raw, "contact"), await this.#definitions());
  }

  async updateContact(contactId: string, fields: ContactFields): Promise<TrimmedContact> {
    const raw = await this.#req("contacts.update", `/contacts/${id(contactId)}`, { body: await this.#contactBody(fields) });
    return this.#trimContact(this.#saved("contacts.update", raw, "contact"), await this.#definitions());
  }

  async addTags(contactId: string, tags: string[]) {
    const raw = await this.#req("contacts.tags.add", `/contacts/${id(contactId)}/tags`, { body: { tags } });
    return { contactId, tags: this.#tagsSaved("contacts.tags.add", raw) };
  }

  async removeTags(contactId: string, tags: string[]) {
    const raw = await this.#req("contacts.tags.remove", `/contacts/${id(contactId)}/tags`, { body: { tags } });
    return { contactId, tags: this.#tagsSaved("contacts.tags.remove", raw) };
  }

  #trimNote(raw: Json) {
    return compact({ id: String(raw.id ?? ""), body: str(raw.body), title: str(raw.title), dateAdded: str(raw.dateAdded), userId: str(raw.userId), pinned: bool(raw.pinned) });
  }

  async listNotes(contactId: string) {
    const raw = await this.#req("contacts.notes.list", `/contacts/${id(contactId)}/notes`);
    return { contactId, notes: list(isRecord(raw) ? raw.notes : []).slice(0, PAGE_MAX).map((note) => this.#trimNote(note)) };
  }

  async addNote(contactId: string, body: string) {
    const raw = await this.#req("contacts.notes.add", `/contacts/${id(contactId)}/notes`, { body: { body } });
    return { contactId, note: this.#trimNote(this.#saved("contacts.notes.add", raw, "note")) };
  }

  #trimTask(raw: Json) {
    return compact({ id: String(raw.id ?? ""), title: str(raw.title), body: str(raw.body), dueDate: str(raw.dueDate), completed: bool(raw.completed), assignedTo: str(raw.assignedTo) });
  }

  async listTasks(contactId: string) {
    const raw = await this.#req("contacts.tasks.list", `/contacts/${id(contactId)}/tasks`);
    return { contactId, tasks: list(isRecord(raw) ? raw.tasks : []).slice(0, PAGE_MAX).map((task) => this.#trimTask(task)) };
  }

  async addTask(contactId: string, input: { title: string; dueDate: string; body?: string; assignedTo?: string }) {
    const raw = await this.#req("contacts.tasks.add", `/contacts/${id(contactId)}/tasks`, {
      body: compact({ title: input.title, dueDate: input.dueDate, body: input.body, assignedTo: input.assignedTo, completed: false }),
    });
    return { contactId, task: this.#trimTask(this.#saved("contacts.tasks.add", raw, "task")) };
  }

  async listPipelines() {
    const raw = await this.#req("pipelines.list", "/opportunities/pipelines", { query: { locationId: this.#location } });
    return {
      pipelines: list(isRecord(raw) ? raw.pipelines : []).slice(0, PAGE_MAX).map((pipeline) => compact({
        id: String(pipeline.id ?? ""), name: str(pipeline.name),
        stages: list(pipeline.stages).slice(0, PAGE_MAX).map((stage) => compact({ id: String(stage.id ?? ""), name: str(stage.name), position: num(stage.position) })),
      })),
    };
  }

  #trimOpportunity(raw: Json) {
    const contact = isRecord(raw.contact) ? raw.contact : null;
    return compact({
      id: String(raw.id ?? ""), name: str(raw.name), status: str(raw.status), monetaryValue: num(raw.monetaryValue),
      pipelineId: str(raw.pipelineId), pipelineStageId: str(raw.pipelineStageId), contactId: str(raw.contactId),
      contact: contact ? compact({ id: str(contact.id), name: str(contact.name), email: str(contact.email), phone: str(contact.phone), companyName: str(contact.companyName) }) : undefined,
      assignedTo: str(raw.assignedTo), source: str(raw.source), createdAt: str(raw.createdAt), updatedAt: str(raw.updatedAt),
      lastStageChangeAt: str(raw.lastStageChangeAt), lastStatusChangeAt: str(raw.lastStatusChangeAt),
    });
  }

  async searchOpportunities(input: { query?: string; pipelineId?: string; stageId?: string; contactId?: string; status?: string; page?: number; limit?: number }) {
    const current = pageNumber(input.page);
    const raw = await this.#req("opportunities.search", "/opportunities/search", { query: {
      location_id: this.#location, q: input.query?.trim() || undefined, pipeline_id: input.pipelineId, pipeline_stage_id: input.stageId,
      contact_id: input.contactId, status: input.status, page: current, limit: pageSize(input.limit),
    } });
    const record = isRecord(raw) ? raw : {};
    const meta = isRecord(record.meta) ? record.meta : {};
    return compact({ opportunities: list(record.opportunities).slice(0, PAGE_MAX).map((item) => this.#trimOpportunity(item)), total: num(meta.total) ?? num(record.total), page: current });
  }

  async getOpportunity(opportunityId: string) {
    const raw = await this.#req("opportunities.get", `/opportunities/${id(opportunityId)}`);
    return this.#trimOpportunity(isRecord(raw) && isRecord(raw.opportunity) ? raw.opportunity : {});
  }

  async createOpportunity(input: { pipelineId: string; stageId?: string; contactId: string; name: string; value?: number; status?: string }) {
    const raw = await this.#req("opportunities.create", "/opportunities/", { body: compact({
      pipelineId: input.pipelineId, locationId: this.#location, name: input.name, pipelineStageId: input.stageId, status: input.status ?? "open",
      contactId: input.contactId, monetaryValue: input.value,
    }) });
    return this.#trimOpportunity(this.#saved("opportunities.create", raw, "opportunity"));
  }

  async updateOpportunity(opportunityId: string, input: { stageId?: string; status?: string; value?: number; name?: string }) {
    const raw = await this.#req("opportunities.update", `/opportunities/${id(opportunityId)}`, { body: compact({
      pipelineStageId: input.stageId, status: input.status, monetaryValue: input.value, name: input.name,
    }) });
    return this.#trimOpportunity(this.#saved("opportunities.update", raw, "opportunity"));
  }

  async searchConversations(input: { contactId?: string; query?: string; limit?: number }) {
    const raw = await this.#req("conversations.search", "/conversations/search", {
      query: { locationId: this.#location, contactId: input.contactId, query: input.query?.trim() || undefined, limit: pageSize(input.limit) },
    });
    const record = isRecord(raw) ? raw : {};
    return compact({
      conversations: list(record.conversations).slice(0, PAGE_MAX).map((item) => compact({
        id: String(item.id ?? ""), contactId: str(item.contactId), contactName: str(item.fullName) ?? str(item.contactName), email: str(item.email), phone: str(item.phone),
        type: str(item.type), lastMessageBody: str(item.lastMessageBody), lastMessageType: str(item.lastMessageType),
        lastMessageDate: str(item.lastMessageDate) ?? (num(item.lastMessageDate) !== undefined ? new Date(item.lastMessageDate as number).toISOString() : undefined),
        unreadCount: num(item.unreadCount), assignedTo: str(item.assignedTo),
      })),
      total: num(record.total),
    });
  }

  async readConversation(conversationId: string, input: { limit?: number; lastMessageId?: string } = {}) {
    const raw = await this.#req("conversations.messages", `/conversations/${id(conversationId)}/messages`, {
      query: { limit: pageSize(input.limit), lastMessageId: input.lastMessageId },
    });
    // Documented as { lastMessageId, nextPage, messages }; served as { messages: { lastMessageId, nextPage, messages } }.
    const record = isRecord(raw) ? raw : {};
    const page = isRecord(record.messages) ? record.messages : record;
    return compact({
      conversationId,
      messages: list(page.messages).slice(0, PAGE_MAX).map((message) => compact({
        id: String(message.id ?? ""), type: str(message.messageType) ?? (num(message.type) !== undefined ? String(message.type) : undefined),
        direction: str(message.direction), status: str(message.status), dateAdded: str(message.dateAdded), body: str(message.body),
        contentType: str(message.contentType), attachments: Array.isArray(message.attachments) ? message.attachments.length : undefined,
      })),
      nextPage: bool(page.nextPage), lastMessageId: str(page.lastMessageId),
    });
  }

  async listCalendars() {
    const raw = await this.#req("calendars.list", "/calendars/", { query: { locationId: this.#location } });
    return {
      calendars: list(isRecord(raw) ? raw.calendars : []).slice(0, PAGE_MAX).map((calendar) => compact({
        id: String(calendar.id ?? ""), name: str(calendar.name), description: str(calendar.description), isActive: bool(calendar.isActive),
        calendarType: str(calendar.calendarType), slotDuration: num(calendar.slotDuration), slotDurationUnit: str(calendar.slotDurationUnit),
        teamMembers: Array.isArray(calendar.teamMembers) ? calendar.teamMembers.length : undefined,
      })),
    };
  }

  async listEvents(input: { startTime: string; endTime: string; calendarId?: string; userId?: string }) {
    const ms = (value: string, name: string) => {
      const parsed = /^\d{10,}$/u.test(value.trim()) ? Number(value.trim()) : Date.parse(value);
      if (!Number.isFinite(parsed)) throw new HighLevelError(`${name} must be an ISO 8601 date-time.`, { status: 400 });
      return parsed;
    };
    const raw = await this.#req("calendars.events", "/calendars/events", { query: {
      locationId: this.#location, calendarId: input.calendarId, userId: input.userId, startTime: ms(input.startTime, "startTime"), endTime: ms(input.endTime, "endTime"),
    } });
    return {
      events: list(isRecord(raw) ? raw.events : []).slice(0, PAGE_MAX).map((event) => compact({
        id: String(event.id ?? ""), title: str(event.title), calendarId: str(event.calendarId), contactId: str(event.contactId),
        appointmentStatus: str(event.appointmentStatus), startTime: str(event.startTime), endTime: str(event.endTime),
        assignedUserId: str(event.assignedUserId), address: str(event.address), notes: str(event.notes),
      })),
    };
  }

  async getLocation() {
    const raw = await this.#req("locations.get", `/locations/${id(this.#location)}`);
    const location = isRecord(raw) && isRecord(raw.location) ? raw.location : {};
    const customFields = await this.#definitions();
    return compact({
      id: str(location.id) ?? this.#location, name: str(location.name), timezone: str(location.timezone), email: str(location.email), phone: str(location.phone),
      website: str(location.website), address: str(location.address), city: str(location.city), state: str(location.state), country: str(location.country),
      postalCode: str(location.postalCode), customFields,
    });
  }
}
