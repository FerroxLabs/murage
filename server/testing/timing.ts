// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Wall-clock guards for "this stays linear" tests. A pattern that is really
// quadratic is slow on every run, while a loaded CI runner (or a laptop doing
// something else) stalls one run now and then. Taking the fastest of a few
// runs keeps the first and ignores the second. A passing check stops after
// its first run, so the usual cost is one run.

/** The fastest of up to `tries` runs of `work`, stopping early once one run is under `limitMs`. */
export function fastestOfMs(work: () => unknown, limitMs: number, tries = 3): number {
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < tries && best >= limitMs; attempt++) {
    const started = performance.now();
    work();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/** The fastest of exactly `runs` runs of `work`: for comparing two sizes of the same work, where both sides need the same treatment. */
export function bestOfMs(work: () => unknown, runs = 5): number {
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < runs; attempt++) {
    const started = performance.now();
    work();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}
