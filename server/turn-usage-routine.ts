// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RESIDUALS-1018-B row 7 (U28b M1 + M2, handoffs/U28B-astra6-r1.md): the routine each provider turn's usage belongs to on
// Settings, Usage. The routine is taken while the turn runs and kept, by thread and provider turn id, until that turn's
// usage is banked, because a live-run lookup at the end of the turn misses it in three cases:
// - M1: a project routine's run is completed as soon as its room request is queued (routines.ts, room-goal delivery), so
//   the room member's turn finds no live run. It is found through the dispatched room request's run id instead
//   (projectRoutineRunId: the request's admission key is `routine:<runId>`, project-routines.ts recordProjectRoutine).
// - M2: cancelRun marks the run cancelled before it interrupts the provider, so the stopped turn's turn.completed finds
//   no live run; and a terminal event redelivered after a failed write (SQLITE_BUSY) finds the run already completed.
// Attribution only: nothing here grants or refuses anything.
import type { RoomRequest } from "./room-requests.ts";
import type { RoutineRun } from "./routines.ts";

export type UsageRoutine = { id: string; name: string };
export type UsageRun = Pick<RoutineRun, "routineId" | "routineName" | "triggerSource">;
/** Turns kept at once; the oldest goes first (a turn whose usage was never banked, such as a replaced thread's). */
export const TURN_USAGE_ROUTINE_CAP = 1_000;

/** The routine run a room request was dispatched for: a server-made project routine request (verb and kind `routine`)
 *  carries its run id in its admission key. Null for any other request. */
export function projectRoutineRunId(request: Pick<RoomRequest, "verb" | "fromKind" | "origin" | "admissionKey"> | null | undefined): string | null {
  if (!request || request.verb !== "routine" || request.fromKind !== "routine" || request.origin !== "server") return null;
  const key = typeof request.admissionKey === "string" ? request.admissionKey : "";
  const runId = key.startsWith("routine:") ? key.slice("routine:".length) : "";
  return runId && !runId.includes(":") ? runId : null;
}

export class TurnUsageRoutines {
  private readonly kept = new Map<string, UsageRoutine>();
  private readonly toUsage: (run: UsageRun | null | undefined) => UsageRoutine | undefined;
  private readonly cap: number;
  // no parameter properties: the server runs under node's strip-only TypeScript mode
  constructor(toUsage: (run: UsageRun | null | undefined) => UsageRoutine | undefined, cap = TURN_USAGE_ROUTINE_CAP) { this.toUsage = toUsage; this.cap = cap; }

  private static key(threadId: string, turnId: string): string { return `${threadId}\n${turnId}`; }

  /** The turn's routine: the one kept for it, else the first lookup that finds a routine run (kept from then on). The
   *  lookups are asked in order and only until one answers. A turn with no id is looked up live only. */
  take(threadId: string, turnId: string | undefined, ...lookups: Array<() => UsageRun | null | undefined>): UsageRoutine | undefined {
    const key = turnId ? TurnUsageRoutines.key(threadId, turnId) : undefined;
    const kept = key ? this.kept.get(key) : undefined;
    if (kept) return kept;
    for (const lookup of lookups) {
      const found = this.toUsage(lookup());
      if (!found) continue;
      if (key) {
        if (this.kept.size >= this.cap) this.kept.delete(this.kept.keys().next().value!);
        this.kept.set(key, found);
      }
      return found;
    }
    return undefined;
  }

  /** Bank one turn's usage: `write` gets the turn's routine, and the turn is forgotten only once `write` returned. A write
   *  that throws (SQLITE_BUSY) keeps it, so the redelivered terminal event banks under the same routine. */
  bank<T>(threadId: string, turnId: string | undefined, write: (routine: UsageRoutine | undefined) => T, ...lookups: Array<() => UsageRun | null | undefined>): T {
    const result = write(this.take(threadId, turnId, ...lookups));
    this.banked(threadId, turnId);
    return result;
  }

  /** The turn's usage is banked: forget it. */
  banked(threadId: string, turnId: string | undefined): void {
    if (turnId) this.kept.delete(TurnUsageRoutines.key(threadId, turnId));
  }

  get size(): number { return this.kept.size; }
}
