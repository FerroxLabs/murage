// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Write-time privacy: which lines a memory receipt produced (STORAGE-AUDIT 3; Sean approved 2026-10-12 as the design, replacing the receipt
// output table for write-time).
//
// A receipt's outputs are the lines of its thread from its first output on: memory_receipt_lines holds, per receipt, its thread, that
// starting position and its engine session (interned in memory_session_no). It is written when the receipt's first output is linked (and
// by U1 for the history, from the RC's output index). A receipt revoke is exact and flat: one line node at the first output (its
// positional range covers every later line of the thread that could rest on the receipt, the session's continuations included) and the
// session reset, and the revoke's pending window starts there. Nothing in the write-time model reads memory_disclosure_outputs (the RC's
// read-time judge still does until S6, which drops the table and its JSON column).
//
// Every path that turns a receipt 'revoked' (settings, restore, bookkeeping, the dispatch checks) goes through the v10 trigger
// memory_receipt_flip into memory_receipt_flips; readers hold the receipt's lines "checking" from its first output (deny-read.ts) until
// drainReceiptFlips commits it as a receipt root (run first in every marker slice).
import type { DatabaseSync } from "node:sqlite";
import { ensureThreadNo, threadIdOf } from "./thread-no.ts";
import type { SessionKey } from "./lineage-types.ts";

/** The session's interned number, taken now when it has none. */
function ensureSessionNo(db: DatabaseSync, session: SessionKey): number {
  const held = db.prepare("SELECT no FROM memory_session_no WHERE thread_id=? AND driver_instance=? AND native_session=?").get(session.threadId, session.driverInstance, session.nativeSession);
  if (held) return Number(held.no);
  return Number(db.prepare("INSERT INTO memory_session_no(thread_id,driver_instance,native_session,no) VALUES(?,?,?,(SELECT coalesce(max(no),0)+1 FROM memory_session_no)) RETURNING no")
    .get(session.threadId, session.driverInstance, session.nativeSession)!.no);
}

/** A receipt's output at `lsn` in `threadId`: the receipt's range starts at its earliest output; its session is recorded when known. */
export function noteReceiptOutput(db: DatabaseSync, bundleId: string, threadId: string, lsn: number, session?: { driverInstance: string; nativeSession: string | null }): void {
  const sessionNo = session?.nativeSession ? ensureSessionNo(db, { threadId, driverInstance: session.driverInstance, nativeSession: session.nativeSession }) : null;
  db.prepare("INSERT INTO memory_receipt_lines(bundle_id,thread_no,first_lsn,session_no) VALUES(?,?,?,?) ON CONFLICT(bundle_id) DO UPDATE SET first_lsn=min(first_lsn,excluded.first_lsn),session_no=coalesce(excluded.session_no,session_no)")
    .run(bundleId, ensureThreadNo(db, threadId), lsn, sessionNo);
}

/** The engine session a receipt was bound to (bindMemoryDisclosureSession), once it is known. */
export function noteReceiptSession(db: DatabaseSync, bundleIds: readonly string[], session: SessionKey): void {
  const no = ensureSessionNo(db, session);
  for (const bundleId of bundleIds) db.prepare("UPDATE memory_receipt_lines SET session_no=? WHERE bundle_id=?").run(no, bundleId);
}

/** Where a receipt's outputs start and its session, or null when it produced no output (a receipt revoke then resets its session only). */
export function receiptStart(db: DatabaseSync, bundleId: string): { threadId: string; firstLsn: number; session: SessionKey | null } | null {
  const row = db.prepare("SELECT r.thread_no,r.first_lsn,s.thread_id AS st,s.driver_instance AS d,s.native_session AS n FROM memory_receipt_lines r LEFT JOIN memory_session_no s ON s.no=r.session_no WHERE r.bundle_id=?").get(bundleId);
  if (!row) return null;
  const threadId = threadIdOf(db, Number(row.thread_no));
  if (threadId === null) return null;
  const session = typeof row.d === "string" && typeof row.n === "string" ? { threadId: String(row.st), driverInstance: row.d, nativeSession: row.n } : null;
  return { threadId, firstLsn: Number(row.first_lsn), session };
}

/** Commits up to `limit` queued flips as receipt roots (the caller's transaction), oldest first. Returns how many it committed. */
export function drainReceiptFlips(db: DatabaseSync, commit: (bundleId: string) => void, limit = 64): number {
  let done = 0;
  for (const row of db.prepare("SELECT thread_no,first_lsn,bundle_id FROM memory_receipt_flips LIMIT ?").all(limit)) {
    commit(String(row.bundle_id));
    db.prepare("DELETE FROM memory_receipt_flips WHERE thread_no=? AND first_lsn=? AND bundle_id=?").run(Number(row.thread_no), Number(row.first_lsn), String(row.bundle_id));
    done++;
  }
  return done;
}

/** Wakes the marker after a flip (memory-revocation.ts sets it: a module with no import of the runner, so no import cycle). */
let wake: () => void = () => {};
export function setFlipWake(next: () => void): void { wake = next; }
export function wakeFlipMarker(): void { wake(); }
