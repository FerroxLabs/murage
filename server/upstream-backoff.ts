// SPDX-License-Identifier: AGPL-3.0-or-later
// One backoff rule for every call this app makes to Flux Router / Composio on
// its own initiative (readiness, inventory, account status, tool lists). All
// installs share one upstream rate limit, so a refused or failing call must
// make the app quieter, never louder:
//  - 429 and 5xx back off exponentially (30 s base, 15 min cap) with jitter;
//  - a Retry-After (seconds or an HTTP date) is a floor, with no client truncation;
//  - the delay only ever grows until a success clears the key.

export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_CAP_MS = 15 * 60_000;
/** Jitter spreads each delay over [0.5, 1.0] of its nominal value. */
export const BACKOFF_JITTER_FLOOR = 0.5;

let random: () => number = Math.random;
/** Test hook: fix (or, with no argument, restore) the jitter source. */
export function setBackoffRandomForTests(source?: () => number): void {
  random = source ?? Math.random;
}

/** Shared injected jitter source for the transport authority. */
export function upstreamBackoffRandom(): number { return random(); }

/** A status that should slow the caller down: a request limit or a server fault. */
export const isBackoffStatus = (status: number): boolean => status === 429 || (status >= 500 && status <= 599);

/** Retry-After as milliseconds from `now`: delta-seconds or an HTTP date. Null when absent or unreadable. */
export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | null {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number.isFinite(Number(text) * 1000) ? Number(text) * 1000 : null;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** The delay after the `failures`-th consecutive failure, jitter included. Never below Retry-After. */
export function backoffDelayMs(failures: number, retryAfterMs?: number | null): number {
  const nominal = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, Math.min(failures - 1, 20)), BACKOFF_CAP_MS);
  const jittered = Math.round(nominal * (BACKOFF_JITTER_FLOOR + (1 - BACKOFF_JITTER_FLOOR) * random()));
  return Math.max(jittered, retryAfterMs ?? 0);
}

/** Per-key backoff state. A key is whatever the caller wants kept apart (an owner, a route). */
export class BackoffGate {
  private readonly state = new Map<string, { failures: number; until: number; status: number }>();

  /** Milliseconds until `key` may call upstream again; 0 when it may now. */
  remainingMs(key: string, now = Date.now()): number {
    const held = this.state.get(key);
    return held ? Math.max(0, held.until - now) : 0;
  }
  blocked(key: string, now = Date.now()): boolean { return this.remainingMs(key, now) > 0; }
  /** The status that last opened the gate for `key`, while it is open. */
  lastStatus(key: string, now = Date.now()): number | undefined {
    return this.blocked(key, now) ? this.state.get(key)?.status : undefined;
  }
  failures(key: string): number { return this.state.get(key)?.failures ?? 0; }

  /** Record a refused or failed call; returns the delay now in force. */
  failure(key: string, status: number, retryAfter?: string | null, now = Date.now()): number {
    const failures = (this.state.get(key)?.failures ?? 0) + 1;
    const delay = Math.max(this.remainingMs(key, now), backoffDelayMs(failures, parseRetryAfterMs(retryAfter, now)));
    this.state.set(key, { failures, until: now + delay, status });
    if (this.state.size > 64) this.state.delete(this.state.keys().next().value!);
    return delay;
  }
  success(key: string): void { this.state.delete(key); }
  clear(): void { this.state.clear(); }
}

/** One request in flight per key: callers that arrive while it runs share its answer. */
export class SingleFlight {
  private readonly flights = new Map<string, Promise<unknown>>();
  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const running = this.flights.get(key);
    if (running) return running as Promise<T>;
    const flight: Promise<T> = work().finally(() => { if (this.flights.get(key) === flight) this.flights.delete(key); });
    this.flights.set(key, flight);
    return flight;
  }
}
