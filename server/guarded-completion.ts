// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A request's completion: the durable write comes FIRST, and only once it has committed is the run marked finished and its
// listener removed. A locked database throws out of `attempt` with nothing changed, so it can run again (the bus redelivers to the
// listener; every other caller goes through `finish`, which retries on a timer). What follows the write (follow-up records) is
// retried the same way, and the claim is released only when it has gone through or failed for a reason a retry cannot cure.
export type GuardedCompletionHost<Event, Done> = {
  /** The durable completion write. Throws (a locked database, say) with nothing committed. */
  write(event: Event | undefined, note: string | undefined): Done | undefined;
  /** Records that follow the write; repeatable. */
  follow(done: Done): void;
  unsubscribe(): void;
  release(): void;
  isBusy(error: unknown): boolean;
  isFinished?(): boolean;
  schedule?(run: () => void, ms: number): void;
  retryMs?: number;
  /** The write is retried at most this often before the error reaches the caller; the follow-up never gives up on a lock
   * (its work is owed: a claim must not be released with the follow-up unfinished). */
  maxTries?: number;
  /** Longest wait between follow-up retries (the wait doubles from `retryMs`). */
  maxRetryMs?: number;
  onError?(error: unknown): void;
};
export function createGuardedCompletion<Event, Done>(host: GuardedCompletionHost<Event, Done>) {
  let finished = false;
  const ms = host.retryMs ?? 250, max = host.maxTries ?? 600;
  const schedule = host.schedule ?? ((run, after) => { (setTimeout(run, after) as { unref?: () => void }).unref?.(); });
  const cap = host.maxRetryMs ?? 5_000;
  const settle = (done: Done, tries = 0): void => {
    try { host.follow(done); }
    catch (error) {
      // A locked database only ever delays the follow-up: it is retried until it goes through, never abandoned.
      if (host.isBusy(error)) { schedule(() => settle(done, tries + 1), Math.min(cap, ms * 2 ** Math.min(tries, 10))); return; }
      host.onError?.(error);
    }
    host.release();
  };
  /** Throws a locked database with nothing changed; the caller (the bus) runs it again. */
  const attempt = (event?: Event, note?: string): void => {
    if (finished) return;
    const done = host.write(event, note);
    if (done === undefined) return;
    finished = true; host.unsubscribe();
    settle(done);
  };
  const finish = (event?: Event, note?: string, tries = 0): void => {
    try { attempt(event, note); }
    catch (error) {
      if (host.isBusy(error) && tries < max) { schedule(() => finish(event, note, tries + 1), ms); return; }
      throw error;
    }
  };
  return { attempt, finish, isFinished: () => finished };
}
