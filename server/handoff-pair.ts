// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A hand-off and its request are a pair: the hand-off's row (pending_delegations) and the room request of the same id. A row that goes while its request is
// still live would leave an executable request without its hand-off, so every bulk removal of rows (a deleted conversation, a restore, a forgotten thread, a
// reset) first ends the live requests of the rows it is about to remove, in the same transaction. The database backs this up with a trigger
// (pending-delegations-schema.ts ensureHandoffPairGuard). A leaf module: it imports only a type.
import type { DatabaseSync } from "node:sqlite";

/** The group the stand-in records of the development builds were filed under (pending-delegations-schema.ts OLD_OWNER_HANDOFF_GROUP; repeated here to stay a leaf). */
const STAND_IN_GROUP = "owner-handoff";
const LIVE = "state IN ('queued','running','waiting_owner','waiting_bot')";

const tableExists = (db: DatabaseSync, name: string): boolean => Boolean(db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE type='table' AND name=?").get(name));

/** Cancels the live requests of the hand-offs queued from one conversation. Call it, in the transaction, just before those rows are deleted. */
export function endLiveRequestsOfThread(db: DatabaseSync, threadId: string, note: string, now: number = Date.now()): void {
  if (!tableExists(db, "pending_delegations") || !tableExists(db, "room_requests")) return;
  db.prepare(`UPDATE room_requests SET state='cancelled', finished_at=?, outcome_note=?, waiting_since=NULL
    WHERE ${LIVE} AND group_id<>'${STAND_IN_GROUP}' AND id IN (SELECT id FROM pending_delegations WHERE source_thread_id=?)`).run(now, note, threadId);
}

/** Cancels the live requests of every queued hand-off. Call it, in the transaction, just before the whole table is emptied. */
export function endAllLivePairedRequests(db: DatabaseSync, note: string, now: number = Date.now()): void {
  if (!tableExists(db, "pending_delegations") || !tableExists(db, "room_requests")) return;
  db.prepare(`UPDATE room_requests SET state='cancelled', finished_at=?, outcome_note=?, waiting_since=NULL
    WHERE ${LIVE} AND group_id<>'${STAND_IN_GROUP}' AND id IN (SELECT id FROM pending_delegations)`).run(now, note);
}
