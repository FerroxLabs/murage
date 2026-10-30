// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.8 owner zone: daily routines' next times follow the owner's zone
// (RoutineManager.rescheduleForZoneChange). A zone change saves the zone first;
// when the routine file then cannot be written, the change stays pending here:
// it is tried again before routines dispatch and by a save of the same zone,
// and the save answers that routines have not moved yet. At start the pending
// state is "boot": only routines whose next time is off their wall-clock time
// in the zone now in force are worked out again, so a change whose routine
// write failed before a restart is still carried over.

export type ZoneReschedule = (options: { offWallClockOnly?: boolean; since?: number }) => unknown;

export interface OwnerZoneReconciler {
  /** Runs what is pending; true when nothing is left pending. */
  reconcile(): boolean;
  /** After the owner's zone changed (or was saved again), with the new zone in force. True when routines moved. */
  changed(before: string | null, after: string): boolean;
  pending(): "boot" | "change" | null;
}

export function createOwnerZoneReconciler(reschedule: () => ZoneReschedule | null, warn: (message: string) => void = console.warn, now: () => number = Date.now): OwnerZoneReconciler {
  let pending: "boot" | "change" | null = "boot";
  let warnedAt = -Infinity;
  /** When the pending work began: the change, or the first boot pass. A retry works from this moment, so a next time
   *  that came due while the write kept failing is still replaced instead of running at the old zone's hour. */
  let pendingSince: number | undefined;
  const reconcile = (): boolean => {
    if (!pending) return true;
    const run = reschedule();
    if (!run) return true;
    pendingSince ??= now();
    try { run({ offWallClockOnly: pending === "boot", since: pendingSince }); }
    catch (error) {
      if (now() - warnedAt >= 60_000) {
        warnedAt = now();
        warn(`owner time zone: daily routines wait for their new times (${error instanceof Error ? error.message : String(error)})`);
      }
      return false;
    }
    pending = null;
    return true;
  };
  return {
    reconcile,
    changed(before, after) {
      if (before === after && pending !== "change") return true;
      if (pending !== "change") pendingSince = now();
      pending = "change";
      return reconcile();
    },
    pending: () => pending,
  };
}
