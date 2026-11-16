// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// One synchronous SQLite writer owner for learning and consuming releases.
import type { DatabaseSync } from "node:sqlite";
import { txScopeBegin, txScopeEnd } from "../tx-scope.ts";

declare const releaseContextBrand: unique symbol;
/** A context is minted only while this module owns the exact connection's
 * writer transaction. Its nominal brand is not exported or constructible. */
export interface ReleaseContext { readonly [releaseContextBrand]: true }
type Active = { db: DatabaseSync; joining: boolean };
const contexts = new WeakMap<ReleaseContext, Active>();
let owner: ReleaseContext | undefined;
export class ReleaseCommitFailed extends Error {
  constructor() { super("RELEASE_COMMIT_FAILED"); this.name = "ReleaseCommitFailed"; }
}
function synchronous<T>(result: T): T {
  if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("ASYNC_RELEASE_TRANSACTION");
  return result;
}
export function assertReleaseContext(context: ReleaseContext, db: DatabaseSync): void {
  const active = contexts.get(context);
  if (owner !== context || !active || active.db !== db || !db.isTransaction) throw new Error("INVALID_RELEASE_CONTEXT");
}
/** A's validators join C's ownership; they cannot start a second transaction,
 * borrow another installation, recur, or reuse a captured context later. */
export function joinReleaseTransaction<T>(context: ReleaseContext, db: DatabaseSync, validate: () => T): T {
  assertReleaseContext(context, db);
  const active = contexts.get(context)!;
  if (active.joining) throw new Error("RECURSIVE_RELEASE_CONTEXT");
  active.joining = true;
  try { return synchronous(validate()); }
  finally { active.joining = false; }
}
export interface ReleaseOperation<T> {
  validate?: (context: ReleaseContext) => void;
  /** Reserve once, after all validation and immediately before the sink. */
  onRelease?: () => void;
  /** Must enqueue synchronously. Return a plain result, or an explicit object
   * holding an already-issued response promise to await after this returns. */
  emit: (context: ReleaseContext) => T;
  onHold?: (milliseconds: number) => void;
}
export function releaseTransaction<T>(db: DatabaseSync, operation: ReleaseOperation<T>): T {
  if (owner || db.isTransaction) throw new Error("NESTED_RELEASE_TRANSACTION");
  db.exec("BEGIN IMMEDIATE");
  const started = performance.now();
  const context = Object.freeze(Object.create(null)) as ReleaseContext;
  contexts.set(context, { db, joining: false }); owner = context;
  txScopeBegin();
  let committed = false;
  try {
    synchronous(operation.validate?.(context));
    assertReleaseContext(context, db);
    synchronous(operation.onRelease?.());
    // After entry to the sink, even a thrown/false result might have accepted
    // bytes. Persist accounting, never refund or automatically resend.
    try { return synchronous(operation.emit(context)); }
    finally {
      try { db.exec("COMMIT"); committed = true; }
      catch { throw new ReleaseCommitFailed(); }
    }
  } finally {
    contexts.delete(context); owner = undefined;
    if (!committed) { try { if (db.isTransaction) db.exec("ROLLBACK"); } catch { /* retain the original failure, including a closed handle */ } }
    txScopeEnd(committed);
    try { operation.onHold?.(performance.now() - started); } catch { /* metrics cannot change release accounting */ }
  }
}
