// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A delegated reply the result gate is still checking is waited for, not thrown away (1.0.5, DELEGATED-REPLY-WITHHELD.md). The finalizer
// (handoff-boundary.ts runFinalizeDelegationWatch) hands this scheduler the re-run of its own gate; the scheduler runs it again every
// DELEGATED_REPLY_RECHECK_MS until the gate answers, and tells the finalizer when the bound has passed so it can write the final line.
// Nothing here is persisted: a restart during a wait is settled by the started row (delegations.ts settleAfterFailure), and the words never
// leave the worker's conversation until the gate says they may.

/** The longest a hand-off waits for the check on its reply before the asker gets the final "still being checked" line. */
export const DELEGATED_REPLY_CHECK_WAIT_MS = 180_000;
/** How often the gate is asked again while a check is owed. */
export const DELEGATED_REPLY_RECHECK_MS = 5_000;
/** How long one hurry may drain the revoke marker inline (memory-revocation.ts settleRevokesForTurn), per re-check. */
export const DELEGATED_REPLY_HURRY_DRAIN_MS = 2_000;

export interface DelegatedReplyCheckOptions {
  /** A monotonic clock in ms (default performance.now). */
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  recheckMs?: number;
  waitMs?: number;
  log?: (line: string) => void;
}

interface Pending { since: number; timer: unknown; run: () => void; threadId: string; failures: number }
/** A run that keeps throwing logs its first failure, then once in this many (once a minute at the real gap). */
const FAILURE_LOG_EVERY = 12;

export class DelegatedReplyChecks {
  private readonly now: () => number;
  private readonly setTimer: (run: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly recheckMs: number;
  private readonly waitMs: number;
  private readonly log: (line: string) => void;
  private readonly pending = new Map<string, Pending>();

  private closed = false;
  constructor(options: DelegatedReplyCheckOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.setTimer = options.setTimer ?? ((run, ms) => { const timer = setTimeout(run, ms); timer.unref?.(); return timer; });
    this.clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.recheckMs = options.recheckMs ?? DELEGATED_REPLY_RECHECK_MS;
    this.waitMs = options.waitMs ?? DELEGATED_REPLY_CHECK_WAIT_MS;
    this.log = options.log ?? (line => console.log(line));
  }

  /** The bound a check is given, for the finalizer's own words. */
  get bound(): number { return this.waitMs; }

  /** Keep `run` (the finalizer's own re-run) owed for `key` and ask for it again after the re-check gap. `since` is when the check began
   * (the first defer sets it); it is handed back so the finalizer can measure the whole wait. Returns the moment the check began. */
  defer(key: string, threadId: string, run: () => void, since?: number): number {
    const began = since ?? this.pending.get(key)?.since ?? this.now();
    // closing: nothing is armed again (the started row settles a wait a restart cut short, F7)
    if (this.closed) return began;
    const existing = this.pending.get(key);
    if (existing) this.clearTimer(existing.timer);
    else this.log(`[delegation] reply to ${key} is being checked against earlier memory; waiting up to ${Math.round(this.waitMs / 1000)} s`);
    this.arm(key, { since: began, timer: undefined, run, threadId, failures: existing?.failures ?? 0 });
    return began;
  }

  /** Arm `entry`'s next run: within the bound the last one lands on the bound itself; past it (a run that threw) one full re-check gap later,
   * never a tight loop. */
  private arm(key: string, entry: Pending): void {
    const left = this.waitMs - (this.now() - entry.since);
    entry.timer = this.setTimer(() => this.fire(key), left > 0 ? Math.min(this.recheckMs, left) : this.recheckMs);
    this.pending.set(key, entry);
  }

  /** Run one owed check. A run that throws (a busy database, a hook) has settled nothing, so the check stays owed, in the bound or past it,
   * until a run returns (DELEGATED-REPLY-WITHHELD.md F16): it is armed again with its original beginning, so the first run that returns past
   * the bound gives the asker its one final line, without a restart. A cancel (the hand-off ended another way) or a restart (F7) ends it too. */
  private fire(key: string): void {
    const entry = this.pending.get(key);
    if (!entry || this.closed) return;
    this.pending.delete(key);
    try { entry.run(); } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entry.failures += 1;
      if (entry.failures === 1 || entry.failures % FAILURE_LOG_EVERY === 0) {
        this.log(`[delegation] re-check of ${key} failed${this.expired(entry.since) ? " past its wait" : ""} (${entry.failures}x), trying again: ${message}`);
      }
      // (a run that re-deferred itself before throwing already holds the key)
      if (!this.pending.has(key)) this.arm(key, entry);
    }
  }

  /** Has `since` run past the bound? */
  expired(since: number): boolean { return this.now() - since >= this.waitMs; }

  /** A check is owed for `key`. */
  has(key: string): boolean { return this.pending.has(key); }
  /** The threads with a check owed (the memory side is hurried for these). */
  threads(): string[] { return [...new Set([...this.pending.values()].map(entry => entry.threadId))]; }
  /** Forget an owed check (its hand-off settled another way). */
  cancel(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.clearTimer(entry.timer);
    this.pending.delete(key);
  }
  /** Run every owed check now (tests, and a caller that learned the memory side settled). */
  runNow(): void {
    for (const [key, entry] of [...this.pending]) { this.clearTimer(entry.timer); this.fire(key); }
  }
  /** Drop every owed check and arm none again (shutdown, tests): a finalizer that runs late finds the scheduler closed. */
  stop(): void { this.closed = true; for (const key of [...this.pending.keys()]) this.cancel(key); }
  /** The scheduler was stopped (the server is closing). */
  get stopped(): boolean { return this.closed; }
}
