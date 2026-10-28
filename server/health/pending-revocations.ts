// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pending memory revocation jobs as maintained counters (1.0.9 Sentinel, GAP-SENTINEL-109 section 4.1, db_stats
// pending_revocations and oldest_pending_at). No backfill and no scan: the figures start unknown (NULL in a stats
// generation, never zero) and become known the first time the revocation runner's own bounded next-job read finds no
// job row; from there each job row written (memory-revocation.ts createRevocationJob) and each one the runner ends or
// parks keeps them current. The runner takes jobs oldest first, so a first-in first-out list of creation times (bounded)
// gives the oldest one. A count that drifted (a write rolled back, a row removed elsewhere) is put right at the next
// empty read; past the list's bound the oldest time is unknown rather than guessed.
import type { DbStatsObservation } from "./stats-publisher.ts";

/** Creation times kept for the oldest figure. Beyond this the count stays exact and the oldest time stays the head's. */
export const PENDING_REVOCATION_TIMES = 1_024;

let known = false;
let count = 0;
const times: number[] = [];
let timesLost = false;

/** A job row was written (in the caller's transaction). */
export function noteRevocationJobCreated(at = Date.now()): void {
  count++;
  if (times.length < PENDING_REVOCATION_TIMES) times.push(at); else timesLost = true;
}

/** The runner ended or parked the oldest job row (it always takes them in creation order). */
export function noteRevocationJobEnded(): void {
  if (count > 0) count--;
  times.shift();
  if (count === 0) { times.length = 0; timesLost = false; }
}

/** The runner's next-job read found no job row: nothing is pending, exactly. */
export function noteRevocationQueueEmpty(): void {
  known = true; count = 0; times.length = 0; timesLost = false;
}

export interface PendingRevocationFigures { pending_revocations: number | null; oldest_pending_at: number | null }

/** The current figures; null where not known. */
export function pendingRevocationFigures(): PendingRevocationFigures {
  if (!known) return { pending_revocations: null, oldest_pending_at: null };
  if (count === 0) return { pending_revocations: 0, oldest_pending_at: null };
  const head = times[0];
  return { pending_revocations: count, oldest_pending_at: head !== undefined && (!timesLost || times.length > 0) ? head : null };
}

/** The observation with the figures filled into the `messages` row (where the memory tables live) when that row has none. */
export function withPendingRevocations(observation: DbStatsObservation, figures: PendingRevocationFigures = pendingRevocationFigures()): DbStatsObservation {
  if (!Array.isArray(observation?.rows)) return observation;
  return {
    ...observation,
    rows: observation.rows.map(row => row?.role !== "messages" ? row : {
      ...row,
      pending_revocations: typeof row.pending_revocations === "number" ? row.pending_revocations : figures.pending_revocations,
      oldest_pending_at: typeof row.oldest_pending_at === "number" ? row.oldest_pending_at : figures.oldest_pending_at,
    }),
  };
}

/** Test hook: back to unknown. */
export function resetPendingRevocationsForTests(): void { known = false; count = 0; times.length = 0; timesLost = false; }
