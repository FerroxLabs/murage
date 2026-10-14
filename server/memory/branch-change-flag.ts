// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Whether a branch move may still be waiting to have its memory sources flipped
// (memory/branch-change.ts), known without a statement: counted once when the
// database opens, then kept by the code that stores and finishes changes. Memory's
// claim loop asks it before every claim.
import type { DatabaseSync } from "node:sqlite";

const mayBePending = new WeakMap<DatabaseSync, boolean>();

/** Count the changes still pending and remember whether there are any. */
export function pendingBranchChanges(db: DatabaseSync): number {
  const n = Number((db.prepare("SELECT COUNT(*) AS n FROM branch_change").get() as { n: number }).n);
  mayBePending.set(db, n > 0);
  return n;
}
export function noteBranchChangeStored(db: DatabaseSync): void { mayBePending.set(db, true); }
/** Whether a change may still be pending (the first ask on a handle counts). */
export function branchChangesMayBePending(db: DatabaseSync): boolean {
  const known = mayBePending.get(db);
  return known === undefined ? pendingBranchChanges(db) > 0 : known;
}
