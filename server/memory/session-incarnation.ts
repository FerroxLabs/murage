// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Lineage S6 rule 27: a clean incarnation from a durable allocator, nothing deleted. An engine may hand back a native session id it handed out
// before (a fresh start repeating an id, a restart): each fresh session.started takes the next n for (thread, driver instance, native id) from
// memory_session_incarnation, append-only, and the memory session key is the raw native id for n = 1 and `${nativeId}#${n}` from n = 2. The
// previous incarnation's rows stay under the old key and no longer judge the new one. Drivers always resume by the raw native id.
import type { DatabaseSync } from "node:sqlite";
import type { SessionKey, TurnLineage } from "./lineage-types.ts";
import { writeSessionLineage } from "./lineage-write.ts";

/** The one place a memory SessionKey is formed (a structural test fails on a `nativeSession:` literal elsewhere). A missing or 1 incarnation
 * is the raw id, so a session from before 1.0.3 (a lineage row, no allocator row) keeps its key. */
export function sessionKeyOf(threadId: string, instanceId: string, cursor: string, incarnation?: number): SessionKey {
  const n = incarnation !== undefined && Number.isInteger(incarnation) && incarnation >= 2 ? incarnation : 1;
  return { threadId, driverInstance: instanceId, nativeSession: n === 1 ? cursor : `${cursor}#${n}` };
}

/** Takes the next incarnation of a native id now (the ensureSessionNo shape): max plus one; for an id never allocated, 2 when a session row
 * from before 1.0.3 holds the raw id (it counts as n = 1), else 1. Run it in the transaction that writes the fresh session's row. */
export function allocateIncarnation(tx: DatabaseSync, threadId: string, instanceId: string, nativeId: string): number {
  return Number(tx.prepare(`INSERT INTO memory_session_incarnation(thread_id,driver_instance,native_id,n) VALUES(?1,?2,?3,(SELECT coalesce(max(n),
    (SELECT 1 FROM memory_session_lineage WHERE thread_id=?1 AND driver_instance=?2 AND native_session=?3),0)+1 FROM memory_session_incarnation WHERE thread_id=?1 AND driver_instance=?2 AND native_id=?3)) RETURNING n`)
    .get(threadId, instanceId, nativeId)!.n);
}

/** A fresh session.started (no cursor): the next incarnation and the session's stamped row, in the caller's transaction. A row that failed
 * to write leaves the allocation in place (the next fresh start takes the next n); a thrown transaction rolls both back. */
export function startFreshSession(tx: DatabaseSync, threadId: string, instanceId: string, nativeId: string, turn: TurnLineage): { key: SessionKey; incarnation: number; recorded: boolean } {
  const incarnation = allocateIncarnation(tx, threadId, instanceId, nativeId);
  const key = sessionKeyOf(threadId, instanceId, nativeId, incarnation);
  return { key, incarnation, recorded: writeSessionLineage(tx, key, turn, true) };
}

/** The latest incarnation of a native id (1 when none was allocated: a session from before 1.0.3 counts as n = 1). Allocates nothing. */
export function latestIncarnation(db: DatabaseSync, threadId: string, instanceId: string, nativeId: string): number {
  try {
    const row = db.prepare("SELECT max(n) AS n FROM memory_session_incarnation WHERE thread_id=? AND driver_instance=? AND native_id=?").get(threadId, instanceId, nativeId);
    return row && row.n !== null ? Number(row.n) : 1;
  } catch { return 1; }
}
