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

export function resetFluxKeyHealthForTests(): void {
  refused = null;
  failures.clear();
}
