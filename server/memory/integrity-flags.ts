// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What the connection knows about the background upgrade work, kept in one leaf module so the database, the replay gate, the memory
// state and the health answer all read the same facts. Per connection (a restore or a data-dir switch opens a new one and starts clean).
export interface IntegrityFlags {
  /** The integrity pass has not finished: replay of earlier outputs is withheld. */
  pending: boolean;
  /** Code of a source-data mismatch the pass found: memory is set aside (recall, disclosure, replay and learning writes stop). */
  hold: string | null;
  /** When the unfinished pass began (ms since the epoch): what was learned before it is not yet proven; null when the pass has finished or never began. */
  startedAt: number | null;
  /** Highest rowid each table held when the unfinished pass began (integrity-state.ts); null when no pass is running. A row at or below its floor is
   * earlier memory: it is written down by the pass row, not by a clock. */
  lessonsFloor: number | null;
  feedbackFloor: number | null;
  eventsFloor: number | null;
}
const flags = new WeakMap<object, IntegrityFlags>();
export function integrityFlags(db: object): IntegrityFlags {
  let value = flags.get(db);
  if (!value) flags.set(db, value = { pending: false, hold: null, startedAt: null, lessonsFloor: null, feedbackFloor: null, eventsFloor: null });
  return value;
}
export function integrityPending(db: object): boolean { return flags.get(db)?.pending === true; }
/** Read only by memory-gate.ts (the one place that decides whether memory may be used). */
export function integrityHoldCode(db: object): string | null { return flags.get(db)?.hold ?? null; }
/** A hold of the connection itself, which no pass result clears (MEMORY V2 3.1: the wake install failed on a writable handle, so a wake
 * could be hidden). Every READ and every use of earlier memory is refused until the next open; capture stays open (memory-gate.ts),
 * because what it writes is found by the next open's probes and refusing it would lose the session's memories. A new connection
 * starts without it. */
const connectionHolds = new WeakMap<object, string>();
export function setConnectionHold(db: object, code: string): void { connectionHolds.set(db, code); }
export function connectionHoldCode(db: object): string | null { return connectionHolds.get(db) ?? null; }
export function setIntegrityFlags(db: object, next: Partial<IntegrityFlags>): void { Object.assign(integrityFlags(db), next); }

/** The background check of earlier memory that runs outside the upgrade's own jobs: the proofs of large root sets a replay asked for in this
 * process (replay-lineage.ts registers how many wait). Kept here, a leaf, so the status reading can say "checking" without importing the replay. */
let checkingSource: (() => number) | null = null;
export function setMemoryCheckingSource(source: (() => number) | null): void { checkingSource = source; }
/** True while such a check is waiting or running, false when none is; "unknown" when the count cannot be read. */
export function memoryChecking(): boolean | "unknown" {
  if (!checkingSource) return false;
  try { return checkingSource() > 0; } catch { return "unknown"; }
}
