// SPDX-License-Identifier: AGPL-3.0-or-later
// One way to open a transaction frame on a shared database file (DBBUSY-1018).
//
// A top-level `SAVEPOINT` is a DEFERRED transaction: it takes its read snapshot at its first read and asks for the write lock
// only at its first write. Since the checkpointer worker writes search-index merge slices on its own connection
// (wal-maintenance.ts), a slice can commit between those two moments; the write then fails with SQLITE_BUSY_SNAPSHOT (517),
// which no busy wait can cure, and the owner sees "Busy for a moment". `beginWrite` claims the write lock FIRST
// (BEGIN IMMEDIATE) when no transaction is open, so a slice in progress makes it wait in busy_timeout instead, and its snapshot
// is taken after the lock is held. Inside an open transaction it is a plain SAVEPOINT, exactly as before.
//
// `beginRead` is the frame for a read that must see one snapshot but never writes (a project GET): a deferred BEGIN at top
// level, so it never waits for, nor holds, the writer lock. A write inside it would be exposed to 517 again, so it is for
// reads only.
//
// The named savepoint is opened in every case, so a caller's own `ROLLBACK TO <point>` (a refusal that keeps the
// transaction going) works unchanged; `endWrite` releases it and, for a frame opened at top level, commits.
// server/write-tx.structure.test.ts keeps every other top-level SAVEPOINT or deferred BEGIN out of server/.
import type { DatabaseSync } from "node:sqlite";

interface Frame { point: string; outer: boolean }
const frames = new WeakMap<DatabaseSync, Frame[]>();

/** Index of the newest frame named `point` on the handle's stack, or -1. */
function find(db: DatabaseSync, point: string): number {
  const stack = frames.get(db);
  if (!stack) return -1;
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i]!.point === point) return i;
  return -1;
}
/** Drops the frame at `index` and every frame above it (inner frames a failed caller left behind). */
function dropFrom(db: DatabaseSync, index: number): void {
  const stack = frames.get(db);
  if (stack && index >= 0) stack.length = Math.min(stack.length, index);
}
/** Ends the whole transaction the helper opened with ROLLBACK. The frames are cleared only once no transaction is open:
 * when the ROLLBACK fails and the transaction is still open, every frame stays (so a later undoWrite of the outer frame
 * tries again) and the ROLLBACK error is thrown; a ROLLBACK that fails because the transaction already ended is not an error. */
function abortOuter(db: DatabaseSync): void {
  if (db.isTransaction) {
    try { db.exec("ROLLBACK"); }
    catch (error) { if (db.isTransaction) throw error; }
  }
  frames.set(db, []);
}

/** Keep the initiating failure when cleanup fails too; ownership stays with
 * abortOuter so a later undoWrite can retry the rollback. */
function abortFailedWrite(db: DatabaseSync, error: unknown): never {
  try { abortOuter(db); }
  catch (cleanup) {
    throw new AggregateError([error, cleanup], `Write transaction and rollback failed: ${String(cleanup)}`, { cause: error });
  }
  throw error;
}

function open(db: DatabaseSync, point: string, begin: string): void {
  const outer = !db.isTransaction;
  if (outer) {
    db.exec(begin);
    frames.set(db, [{ point, outer }]); // owned from the BEGIN on, so a failed cleanup below never leaves it untracked
  }
  try { db.exec(`SAVEPOINT ${point}`); }
  catch (error) { if (outer) abortFailedWrite(db, error); throw error; }
  if (outer) return;
  const stack = frames.get(db);
  if (stack) stack.push({ point, outer }); else frames.set(db, [{ point, outer }]);
}

/** Opens a write frame named `point`: BEGIN IMMEDIATE plus the savepoint at top level, the savepoint alone inside an open transaction. */
export function beginWrite(db: DatabaseSync, point: string): void { open(db, point, "BEGIN IMMEDIATE"); }

/** Opens a READ-ONLY frame named `point`: a deferred BEGIN plus the savepoint at top level (one snapshot, no writer lock),
 * the savepoint alone inside an open transaction. Close it with `endWrite` (or `undoWrite`). Never write inside it. */
export function beginRead(db: DatabaseSync, point: string): void { open(db, point, "BEGIN"); }

/** Keeps what the frame wrote: RELEASE, and COMMIT when the frame opened the transaction.
 * A nested frame stays on the stack until its RELEASE succeeds, so a caller's `undoWrite` after a failed nested RELEASE still
 * finds it. A frame that opened the transaction stays on the stack until its COMMIT succeeds (or a ROLLBACK ends the
 * transaction): when its RELEASE or COMMIT fails, endWrite rolls the whole transaction back itself before rethrowing, and the
 * caller's `undoWrite` then finds nothing left to do. If that ROLLBACK fails too, both errors are thrown in an AggregateError and the outer
 * frame is still on the stack, so the caller's `undoWrite` issues a full ROLLBACK again (never a ROLLBACK TO a released point). */
export function endWrite(db: DatabaseSync, point: string): void {
  const index = find(db, point);
  const frame = index >= 0 ? frames.get(db)![index]! : undefined;
  if (!frame && !db.isTransaction) return;
  try { db.exec(`RELEASE ${point}`); }
  catch (error) { if (frame?.outer) abortFailedWrite(db, error); throw error; }
  if (!frame?.outer) { dropFrom(db, index); return; }
  if (db.isTransaction) {
    try { db.exec("COMMIT"); }
    catch (error) { abortFailedWrite(db, error); }
  }
  dropFrom(db, index); // COMMIT succeeded (or the transaction had already ended): the outer frame is done
}

/** Drops what the frame wrote and ends it: ROLLBACK for a frame that opened the transaction, ROLLBACK TO + RELEASE inside one.
 * The frame leaves the stack even when the nested ROLLBACK TO fails, so the enclosing frame's own undo still reaches it. */
export function undoWrite(db: DatabaseSync, point: string): void {
  const index = find(db, point);
  const frame = index >= 0 ? frames.get(db)![index]! : undefined;
  if (frame?.outer) { abortOuter(db); return; }
  dropFrom(db, index);
  if (!db.isTransaction) return;
  db.exec(`ROLLBACK TO ${point}; RELEASE ${point}`);
}
