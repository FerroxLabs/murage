// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What Flux Router last said about the saved key, and when Murage may ask it
// again. Kept per key (by a short fingerprint, never the key), so a new key
// starts clean and the old key's refusal is forgotten the moment it changes.
//
// Why this exists: on 2026-10-01 Flux ingress saw installs asking
// GET /v1/models with a refused credential every 60 to 65 seconds, forever.
// A refused key is now asked about once, then not again until the owner
// changes it; any other catalog failure backs off exponentially up to a
// ceiling. Nothing here turns the catalog off for the rest of the process.
//
// What counts as "refused": Flux's own answer (401 or 403) to Murage's own
// catalog call (server/provider-connections.ts, wired in server/index.ts).
// Fuigo's exit code is no signal: Fuigo 1.0.20 falls back to its bundled
// models and exits 0 on a 401.
import { createHash } from "node:crypto";
import { fluxUsageHeaders } from "./flux-usage-tags.ts";
import { noteInstanceAuthFailure, noteKeyAccepted, noteKeyRejected } from "./key-rejections.ts";

/** First wait after a failed catalog fetch; doubles on every failure after. */
export const CATALOG_BACKOFF_BASE_MS = 15 * 60_000;
/** The wait never grows past this, so an offline boot cannot disable the live list. */
export const CATALOG_BACKOFF_MAX_MS = 6 * 3_600_000;

const fingerprint = (key: string): string => createHash("sha256").update(key.trim()).digest("hex").slice(0, 16);

/** Keys Flux has refused, by fingerprint: one entry per key, never a single slot, so a late answer about an old key cannot disturb the current one.
 *  An active refusal is never evicted (only an accepted answer clears it). */
const refusedKeys = new Set<string>();
/** Evidence order. Every request that can say whether a key works takes a number when it STARTS. */
let evidenceClock = 0;
/** What is remembered per key fingerprint. The shared Flux refusal and each engine rejection are updated independently,
 *  so each keeps its OWN watermark: evidence only advances the watermark of the state it actually updates. */
type KeyState = {
  flux: number;
  engine: number;
  engineRefused: boolean;
  /** Tickets taken and not yet reported: seq -> time taken. */
  outstanding: Map<number, number>;
};
const keyStates = new Map<string, KeyState>();
export const KEY_STATES_MAX = 256;
/** A ticket that was never reported (a request that died) stops protecting its key after this long. */
export const TICKET_OUTSTANDING_MS = 30 * 60_000;
/** Bumped by every recheck. A refusal from a request that began under an older number is from before the person acted. */
let recheckGeneration = 0;
/** The newest accepted evidence applied to any key (an engine authentication failure noticed after it is older news). */
let lastAcceptedSeq = 0;
const failures = new Map<string, { count: number; nextAt: number }>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* a listener must not break the caller */ }
  }
}

// ONE RULE FOR KEY EVIDENCE (accepted or refused), whichever path it arrives by (/key/info, a catalog refresh, a web search,
// a chat turn, a Settings Test): a request takes a ticket when it STARTS (beginFluxKeyEvidence) and reports through
// reportFluxKeyEvidence when it ends. The report is applied only if
//   (1) ticket.generation is the current recheck generation (no recheck since the request began), AND
//   (2) ticket.seq is newer than the last evidence applied for the SAME key fingerprint.
// Anything else is an answer older than what we know and changes nothing. State is kept per key. The setters below the
// rule (noteFluxKeyRefused, noteFluxKeyAccepted and key-rejections' noteKey*) must be called only from here; a test
// (server/flux-evidence-lint.test.ts) fails when any other file calls them.
export type FluxKeyTicket = { seq: number; generation: number; id: string };
export type FluxKeyEvidenceOptions = {
  /** Also keep the Flux refusal latch for this key (default true). A non-Flux provider key passes false. */
  flux?: boolean;
  /** Where an engine key mark lives (key-rejections.ts): an engine address or ANY_ADDRESS. Absent: no engine mark is touched. */
  scope?: string;
};
function stateFor(id: string): KeyState {
  let state = keyStates.get(id);
  if (state) keyStates.delete(id);
  else state = { flux: 0, engine: 0, engineRefused: false, outstanding: new Map() };
  keyStates.set(id, state); // most recently used last
  return state;
}
function settled(state: KeyState, id: string, now: number): boolean {
  for (const [seq, at] of state.outstanding) if (now - at > TICKET_OUTSTANDING_MS) state.outstanding.delete(seq);
  return state.outstanding.size === 0 && !state.engineRefused && !refusedKeys.has(id);
}
/** Keep memory bounded: drop the least recently used key that is settled, accepted and idle. Never one with a request in flight or a refusal. */
function evictIdle(): void {
  if (keyStates.size <= KEY_STATES_MAX) return;
  const now = Date.now();
  for (const [id, state] of keyStates) {
    if (keyStates.size <= KEY_STATES_MAX) return;
    if (settled(state, id, now)) keyStates.delete(id);
  }
}
export function beginFluxKeyEvidence(key: string): FluxKeyTicket {
  const id = fingerprint(key), seq = ++evidenceClock;
  stateFor(id).outstanding.set(seq, Date.now());
  evictIdle();
  return { seq, generation: recheckGeneration, id };
}
/** Is the ticket still allowed to change anything? False after a recheck. */
export function fluxKeyTicketCurrent(ticket: { generation: number }): boolean {
  return ticket.generation === recheckGeneration;
}
/** Report what a request learned about its key. Returns whether it changed (or confirmed) any state.
 *  A refusal needs the ticket to be from after the latest recheck; an acceptance does not (a request that worked is still news,
 *  unless a newer answer already replaced it). Each state it touches is ordered by its own watermark. */
export function reportFluxKeyEvidence(ticket: FluxKeyTicket, key: string, outcome: "accepted" | "refused", options: FluxKeyEvidenceOptions = {}): boolean {
  if (ticket.id !== fingerprint(key)) return false;
  const state = stateFor(ticket.id);
  state.outstanding.delete(ticket.seq);
  if (outcome === "refused" && !fluxKeyTicketCurrent(ticket)) { evictIdle(); return false; }
  let applied = false;
  if (options.flux !== false && ticket.seq > state.flux) {
    state.flux = ticket.seq;
    if (outcome === "refused") noteFluxKeyRefused(key); else noteFluxKeyAccepted(key);
    applied = true;
  }
  if (options.scope !== undefined && ticket.seq > state.engine) {
    state.engine = ticket.seq;
    if (outcome === "refused") { state.engineRefused = true; noteKeyRejected(options.scope, key); }
    else { state.engineRefused = false; noteKeyAccepted(options.scope, key); }
    applied = true;
  }
  if (applied && outcome === "accepted") {
    lastAcceptedSeq = Math.max(lastAcceptedSeq, ticket.seq);
    // An older probe's cached "invalid" for this key is now older than what we know: drop it so it is neither returned nor re-latched.
    if (keyInfo.get(ticket.id)?.check.state === "invalid") keyInfo.delete(ticket.id);
  }
  evictIdle();
  return applied;
}

/** An engine that runs on a Flux key (Fuigo) reports an authentication failure it noticed late in a turn. Take the ticket when the turn starts. */
export function beginEngineAuthEvidence(): { seq: number; generation: number } {
  return { seq: ++evidenceClock, generation: recheckGeneration };
}
/** Whether a failure noticed by a turn that began at `ticket` is still news: not after a recheck, nor after the key was accepted since. */
export function engineAuthEvidenceCurrent(ticket: { seq: number; generation: number }): boolean {
  return ticket.generation === recheckGeneration && ticket.seq > lastAcceptedSeq;
}
/** The one door for an engine's authentication-failure mark when its key is a Flux key (see the rule above). */
export function reportEngineAuthFailure(ticket: { seq: number; generation: number }, instanceId: string, now = Date.now(), options: { signIn?: boolean } = {}): boolean {
  if (!engineAuthEvidenceCurrent(ticket)) return false;
  noteInstanceAuthFailure(instanceId, now, options);
  return true;
}

/** LOW LEVEL (see the rule above): Flux answered 401 to this key. */
export function noteFluxKeyRefused(key: string): void {
  const id = fingerprint(key);
  if (refusedKeys.has(id)) return;
  refusedKeys.add(id);
  changed();
}

/** LOW LEVEL (see the rule above): Flux accepted this key, which clears an earlier refusal of it. */
export function noteFluxKeyAccepted(key: string): void {
  const id = fingerprint(key);
  failures.delete(id);
  if (!refusedKeys.delete(id)) return;
  changed();
}

export function fluxKeyRefused(key: string | null | undefined): boolean {
  return Boolean(key && key.trim() && refusedKeys.has(fingerprint(key)));
}

/** May the engine catalog ask Flux about this key right now? A refusal always
 *  blocks; a person-initiated refresh (picker open, Check again) skips the
 *  failure wait, a background one does not. */
export function catalogFetchAllowed(key: string, now = Date.now(), options: { manual?: boolean } = {}): boolean {
  if (fluxKeyRefused(key)) return false;
  if (options.manual) return true;
  const state = failures.get(fingerprint(key));
  return !state || now >= state.nextAt;
}

/** What a `fuigo models` run showed. "ok" only clears the failure count: it
 *  never clears a refusal, because Fuigo answers a 401 with bundled models and
 *  exit 0. Only Flux accepting the key (reportFluxKeyEvidence) does that. A
 *  "refused" here is not evidence and changes nothing: refusals arrive with a ticket. */
export function noteCatalogResult(key: string, outcome: "ok" | "refused" | "failed", now = Date.now()): void {
  const id = fingerprint(key);
  if (outcome === "ok") { failures.delete(id); return; }
  if (outcome === "refused") return;
  const count = (failures.get(id)?.count ?? 0) + 1;
  failures.set(id, { count, nextAt: now + Math.min(CATALOG_BACKOFF_BASE_MS * 2 ** Math.min(count - 1, 20), CATALOG_BACKOFF_MAX_MS) });
}

/** Notified when the refusal state changes, so the app can tell the owner. */
export function onFluxKeyHealthChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Wait after a refused or failed Flux call: 1 minute, doubling, never past 1 hour. */
export const FLUX_RETRY_BASE_MS = 60_000;
export const FLUX_RETRY_MAX_MS = 3_600_000;
export function fluxRetryDelayMs(failures: number): number {
  return Math.min(FLUX_RETRY_BASE_MS * 2 ** Math.max(0, Math.min(failures - 1, 20)), FLUX_RETRY_MAX_MS);
}

// Key validity: GET https://api.fluxrouter.ai/key/info (no /v1) with the key as
// a Bearer. 200 means valid and carries info{blocked, expires, max_budget,
// spend}; 401 means invalid. Cached per key fingerprint: a valid answer for
// KEY_INFO_TTL_MS, an invalid one on the 1, 5, 15 minute backoff above, any other
// failure on the 1 minute to 1 hour backoff.
export const FLUX_KEY_INFO_URL = "https://api.fluxrouter.ai/key/info";
export const KEY_INFO_TTL_MS = 10 * 60_000;
export type FluxKeyInfo = { blocked: boolean; expires: string | null; maxBudget: number | null; spend: number | null };
export type FluxKeyCheck = { state: "valid"; info: FluxKeyInfo } | { state: "invalid" } | { state: "unknown" };

/** A refused (401) key is asked about again after 1, then 5, then 15 minutes, and every 15 minutes after that. Long enough that
 *  a truly dead key costs Flux a handful of calls an hour; short enough that a key refused only while its account was on hold
 *  (Cloud's email-unverified hold lasts a few minutes) recovers by itself. */
export const KEY_REFUSED_RETRY_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000];
const refusedRetryMs = (refusals: number): number => KEY_REFUSED_RETRY_MS[Math.min(Math.max(refusals, 1), KEY_REFUSED_RETRY_MS.length) - 1];

const keyInfo = new Map<string, { check: FluxKeyCheck; at: number; failures: number; nextAt: number; refusals: number }>();
let keyInfoInFlight = new Map<string, { generation: number; promise: Promise<FluxKeyCheck> }>();

function parseKeyInfo(body: unknown): FluxKeyInfo | null {
  const raw = body && typeof body === "object" ? (body as { info?: unknown }).info : undefined;
  if (!raw || typeof raw !== "object") return null;
  const info = raw as Record<string, unknown>;
  const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return {
    blocked: info.blocked === true,
    expires: typeof info.expires === "string" ? info.expires : null,
    maxBudget: num(info.max_budget),
    spend: num(info.spend),
  };
}

/** Is this key valid? At most one request in flight per key, and none at all
 *  while an answer is fresh, the key is known invalid, or a failure is backing
 *  off. `unknown` means "could not tell; do not treat the key as bad". */
export async function checkFluxKey(key: string, options: { fetchImpl?: typeof fetch; now?: number; manual?: boolean } = {}): Promise<FluxKeyCheck> {
  const id = fingerprint(key);
  const now = options.now ?? Date.now();
  const held = keyInfo.get(id);
  if (held?.check.state === "invalid" && !options.manual && now < held.nextAt) return held.check;
  if (held?.check.state === "valid" && now - held.at < KEY_INFO_TTL_MS && !options.manual) return held.check;
  if (held && held.check.state === "unknown" && now < held.nextAt && !options.manual) return held.check;
  const running = keyInfoInFlight.get(id);
  // A probe that began before the latest recheck is not joined: it may carry a refusal from before the person acted.
  if (running && running.generation === recheckGeneration) return running.promise;
  const generation = recheckGeneration;
  const ticket = beginFluxKeyEvidence(key);
  const run = (async (): Promise<FluxKeyCheck> => {
    // Queued after the stale probe, so two requests for one key are never in flight together.
    if (running) await running.promise.catch(() => {});
    const base = keyInfo.get(id); // after the wait: a recheck has cleared what the stale probe saw
    // Still current: a probe a later recheck has overtaken answers its own callers and writes nothing.
    const current = (): boolean => generation === recheckGeneration;
    const failures = base?.failures ?? 0;
    const fail = (): FluxKeyCheck => {
      const count = failures + 1;
      const check: FluxKeyCheck = { state: "unknown" };
      if (current()) keyInfo.set(id, { check, at: now, failures: count, nextAt: now + fluxRetryDelayMs(count), refusals: base?.refusals ?? 0 });
      return check;
    };
    try {
      const response = await (options.fetchImpl ?? fetch)(FLUX_KEY_INFO_URL, {
        headers: { authorization: `Bearer ${key.trim()}`, accept: "application/json", ...fluxUsageHeaders({ feature: "other" }) },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 401) {
        void response.body?.cancel().catch(() => {});
        const check: FluxKeyCheck = { state: "invalid" };
        if (!current()) return check;
        // Older than evidence already applied for this key (a newer acceptance): it neither latches nor is cached.
        if (!reportFluxKeyEvidence(ticket, key, "refused")) return fluxKeyRefused(key) ? check : { state: "unknown" };
        const refusals = (base?.refusals ?? 0) + 1;
        keyInfo.set(id, { check, at: now, failures: 0, nextAt: now + refusedRetryMs(refusals), refusals });
        return check;
      }
      if (!response.ok) { void response.body?.cancel().catch(() => {}); return fail(); }
      const info = parseKeyInfo(await response.json().catch(() => null));
      if (!info) return fail();
      const check: FluxKeyCheck = { state: "valid", info };
      if (!current()) return check;
      // A refusal recorded after this probe began is newer evidence than this answer: it neither clears the refusal nor is cached.
      if (!reportFluxKeyEvidence(ticket, key, "accepted")) return fluxKeyRefused(key) ? { state: "invalid" } : check;
      keyInfo.set(id, { check, at: now, failures: 0, nextAt: 0, refusals: 0 });
      return check;
    } catch {
      return fail();
    }
  })().finally(() => { if (keyInfoInFlight.get(id)?.promise === run) keyInfoInFlight.delete(id); });
  keyInfoInFlight.set(id, { generation, promise: run });
  return run;
}

/** A person acted on the key (pressed Test, saved or re-entered it): drop every
 *  cached /key/info answer, the 401 latch included, so the next check asks Flux
 *  once, fresh. A re-enabled key recovers without a restart. The refused flag is
 *  left until Flux answers, so the screen does not flicker. Automatic paths never
 *  call this, so they keep the latch. */
export function requestFluxKeyRecheck(): void {
  recheckGeneration++;
  keyInfo.clear();
}

export function resetFluxKeyHealthForTests(): void {
  refusedKeys.clear();
  keyStates.clear();
  lastAcceptedSeq = 0;
  evidenceClock = 0;
  recheckGeneration = 0;
  failures.clear();
  keyInfo.clear();
  keyInfoInFlight = new Map();
}
