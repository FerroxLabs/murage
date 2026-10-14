// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// When the helper's stepped index maintenance (the merge a rolled deletion owes, index.ts) may run. It waits for quiet so a
// step never costs a search anything, but it does not wait for ever: a helper that is never idle (a search or an index
// batch always queued) once never serviced the obligation at all (msearch review round 4). After MAINTENANCE_MAX_DEFER_MS of
// being put off, one step runs anyway. A step is bounded (about 10 ms), so that is at most about one percent of the helper.
export const MAINTENANCE_MAX_DEFER_MS = 1000;
/** How long the maintenance loop sleeps between looks at the helper while it is busy. */
export const MAINTENANCE_POLL_MS = 50;

export interface MaintenanceClock { deferredSince: number | null }
/** Whether a step may run now. `busy`: work is queued or running. Updates the clock: it starts when a step is first put off and
 * resets when one runs. */
export function maintenanceMayRun(clock: MaintenanceClock, busy: boolean, now: number): boolean {
  if (!busy) { clock.deferredSince = null; return true; }
  clock.deferredSince ??= now;
  if (now - clock.deferredSince >= MAINTENANCE_MAX_DEFER_MS) { clock.deferredSince = null; return true; }
  return false;
}

/** After the stepped merge failed `failures` times in a row: how long to wait before the next pass. It doubles from `baseMs` to
 * `maxMs` and is never zero, so a durable obligation that cannot be paid does not spin the helper. */
export function maintenanceRetryDelayMs(failures: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(failures, 30) - 1));
}
