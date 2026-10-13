// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A run's completion that fails to commit (a locked database, an I/O error) is tried again with a capped backoff, whatever the
// error. If it still fails after `settleAfter` tries, the request is durably settled as failed (an owed row the delivery sweep
// finishes) and only that releases ownership. If even the settlement cannot be written, the retry carries on: the run's claim and
// listener are never given up on an unwritten completion.
export type CompletionRetryHost<Event> = {
  /** The completion; throws with nothing committed. */
  run(event: Event): void;
  /** Writes the failed settlement. True once it committed; false or a throw leaves the retry going. */
  settleFailed(event: Event, error: unknown): boolean;
  schedule(run: () => void, ms: number): void;
  onError?(error: unknown, tries: number): void;
  settleAfter?: number;
  baseMs?: number;
  maxMs?: number;
};
export function createCompletionRetry<Event>(host: CompletionRetryHost<Event>) {
  let pending = false;
  const settleAfter = host.settleAfter ?? 8, base = host.baseMs ?? 250, cap = host.maxMs ?? 5_000;
  const attempt = (event: Event, tries: number): void => {
    try { host.run(event); pending = false; return; }
    catch (error) {
      pending = true;
      host.onError?.(error, tries);
      if (tries >= settleAfter) {
        try { if (host.settleFailed(event, error)) { pending = false; return; } } catch (settleError) { host.onError?.(settleError, tries); }
      }
      host.schedule(() => attempt(event, tries + 1), Math.min(cap, base * 2 ** Math.min(tries, 10)));
    }
  };
  return {
    /** Starts a completion; a second one while an earlier is still retrying is the same completion and is not started twice. */
    start(event: Event): void { if (!pending) attempt(event, 0); },
    pending: () => pending,
  };
}
