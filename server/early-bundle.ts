// A turn's memory bundle does not depend on what the integration mounts
// produce (tool lists, connectors): its inputs are the query, the reader's
// access and the context budget, all known at admission. This starts the build
// as soon as those are known so it overlaps the mounts, and hands the one
// result to the dispatch step. A failure is held until `take()` (so it
// surfaces where the sequential build would have), and `cancel()` aborts the
// build and silences its rejection when the turn ends before it is used.
export class EarlyBundle<T, A = unknown> {
  private readonly controller = new AbortController();
  private promise: Promise<T> | undefined;
  private spent = false;
  readonly access: A;
  constructor(access: A) { this.access = access; }

  start(build: (signal: AbortSignal) => Promise<T>): void {
    if (this.promise || this.spent) throw new Error("EARLY_BUNDLE_STARTED: one bundle per dispatch");
    const promise = build(this.controller.signal);
    // Never an unhandled rejection: take() rethrows it, cancel() drops it.
    promise.catch(() => {});
    this.promise = promise;
  }

  /** The single result, or undefined when nothing was started or it was taken. */
  take(): Promise<T> | undefined {
    if (this.spent) return undefined;
    this.spent = true;
    return this.promise;
  }

  cancel(): void {
    this.spent = true;
    this.controller.abort();
  }
}

/** What the dispatch step works from once the mounts are done.
 * `access` is the early one only while it is still current: if it was
 * revoked meanwhile (a forget, a tombstone, a policy change) the early bundle
 * is cancelled and a fresh access is minted, so the turn rebuilds in place as
 * it did before the early bundle existed. `earlyVerdictHolds` says the
 * continuation check the early step already ran still stands: the access is
 * the early one and `stamp()` has not moved since `checkedAt`, so the check
 * need not run a second time. */
export function dispatchAccess<T, A>(
  early: EarlyBundle<T, A> | undefined,
  checkedAt: string | undefined,
  hooks: { assertCurrent(access: A): void; stamp(): string | undefined; mint(): A },
): { access: A; earlyVerdictHolds: boolean } {
  if (early) {
    try {
      hooks.assertCurrent(early.access);
      const now = hooks.stamp();
      return { access: early.access, earlyVerdictHolds: checkedAt !== undefined && now === checkedAt };
    } catch { early.cancel(); }
  }
  return { access: hooks.mint(), earlyVerdictHolds: false };
}
