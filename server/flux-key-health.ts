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

/** First wait after a failed catalog fetch; doubles on every failure after. */
export const CATALOG_BACKOFF_BASE_MS = 15 * 60_000;
/** The wait never grows past this, so an offline boot cannot disable the live list. */
export const CATALOG_BACKOFF_MAX_MS = 6 * 3_600_000;

const fingerprint = (key: string): string => createHash("sha256").update(key.trim()).digest("hex").slice(0, 16);

let refused: string | null = null;
const failures = new Map<string, { count: number; nextAt: number }>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* a listener must not break the caller */ }
  }
}

/** Called when Flux answered 401 to this key. */
export function noteFluxKeyRefused(key: string): void {
  const id = fingerprint(key);
  if (refused === id) return;
  refused = id;
  changed();
}

/** Called when Flux accepted this key, which clears an earlier refusal of it. */
export function noteFluxKeyAccepted(key: string): void {
  failures.delete(fingerprint(key));
  if (refused !== fingerprint(key)) return;
  refused = null;
  changed();
}

export function fluxKeyRefused(key: string | null | undefined): boolean {
  return Boolean(key && key.trim() && refused === fingerprint(key));
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
 *  exit 0. Only Flux accepting the key (noteFluxKeyAccepted) does that. */
export function noteCatalogResult(key: string, outcome: "ok" | "refused" | "failed", now = Date.now()): void {
  const id = fingerprint(key);
  if (outcome === "ok") { failures.delete(id); return; }
  if (outcome === "refused") return noteFluxKeyRefused(key);
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
// KEY_INFO_TTL_MS, an invalid one until the key changes (no retries), any other
// failure on the 1 minute to 1 hour backoff.
export const FLUX_KEY_INFO_URL = "https://api.fluxrouter.ai/key/info";
export const KEY_INFO_TTL_MS = 10 * 60_000;
export type FluxKeyInfo = { blocked: boolean; expires: string | null; maxBudget: number | null; spend: number | null };
export type FluxKeyCheck = { state: "valid"; info: FluxKeyInfo } | { state: "invalid" } | { state: "unknown" };

const keyInfo = new Map<string, { check: FluxKeyCheck; at: number; failures: number; nextAt: number }>();
let keyInfoInFlight = new Map<string, Promise<FluxKeyCheck>>();

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
  if (held?.check.state === "invalid") return held.check;
  if (held?.check.state === "valid" && now - held.at < KEY_INFO_TTL_MS && !options.manual) return held.check;
  if (held && held.check.state === "unknown" && now < held.nextAt && !options.manual) return held.check;
  const running = keyInfoInFlight.get(id);
  if (running) return running;
  const run = (async (): Promise<FluxKeyCheck> => {
    const failures = held?.failures ?? 0;
    const fail = (): FluxKeyCheck => {
      const count = failures + 1;
      const check: FluxKeyCheck = { state: "unknown" };
      keyInfo.set(id, { check, at: now, failures: count, nextAt: now + fluxRetryDelayMs(count) });
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
        keyInfo.set(id, { check, at: now, failures: 0, nextAt: Number.POSITIVE_INFINITY });
        noteFluxKeyRefused(key);
        return check;
      }
      if (!response.ok) { void response.body?.cancel().catch(() => {}); return fail(); }
      const info = parseKeyInfo(await response.json().catch(() => null));
      if (!info) return fail();
      const check: FluxKeyCheck = { state: "valid", info };
      keyInfo.set(id, { check, at: now, failures: 0, nextAt: 0 });
      noteFluxKeyAccepted(key);
      return check;
    } catch {
      return fail();
    }
  })().finally(() => { keyInfoInFlight.delete(id); });
  keyInfoInFlight.set(id, run);
  return run;
}

/** A person acted on the key (pressed Test, saved or re-entered it): drop every
 *  cached /key/info answer, the 401 latch included, so the next check asks Flux
 *  once, fresh. A re-enabled key recovers without a restart. The refused flag is
 *  left until Flux answers, so the screen does not flicker. Automatic paths never
 *  call this, so they keep the latch. */
export function requestFluxKeyRecheck(): void {
  keyInfo.clear();
}

export function resetFluxKeyHealthForTests(): void {
  refused = null;
  failures.clear();
  keyInfo.clear();
  keyInfoInFlight = new Map();
}
