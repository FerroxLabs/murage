// SPDX-License-Identifier: AGPL-3.0-or-later
// Closing out blocked jobs (1.0.2, CLAIM-REDESIGN.md).
//
// A job whose source can never be claimed at the job's revision does not stay
// in the open statuses: it is settled, so the (status,retry_at) index holds
// only claimable jobs, future retries and live leases. No schema change: the
// statuses used here are the ones the schema already allows and every older
// build treats as terminal.
//
// Each statement re-checks its own condition in SQL, inside the caller's
// transaction, so it can only close a job the claim predicate already excludes
// and never one a claim could take. A live lease is never settled.
//
// This is a leaf module (it imports only deny.ts, itself a leaf) so that the
// claim index and park.ts can both use it without an import cycle.
import type { DatabaseSync } from "node:sqlite";
import { DENIED_PLACE } from "./deny.ts";

export const MARKER_PREFIX = "parked:v1:";
export const PARK_SET = `status='cancelled',error='${MARKER_PREFIX}'||json_object('s',CASE status WHEN 'leased' THEN 'pending' ELSE status END,'e',error),
  lease_generation=lease_generation+1,lease_owner=NULL,lease_until=0`;

const OPEN = "('pending','partial','deferred','leased')";
/** The categories of blocked job, in the order their statements run. */
export type SettleCategory = "superseded" | "denied" | "working" | "tool" | "attempts" | "retired";
/** Order matters: a retired source in a denied place is cancelled (denied runs first), never parked; a capped job is failed, never parked. */
export const SETTLE_CATEGORIES: readonly SettleCategory[] = ["superseded", "denied", "working", "tool", "attempts", "retired"];

/** Source alias `s` is tombstoned at its own revision (one seek on the UNIQUE(target_type,target_id,revision) index per arm). */
export const TOMBSTONED = (s: string) => `EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='source' AND t.target_id=${s}.id AND (t.revision IS NULL OR t.revision=${s}.revision))`;
/** The one claimability predicate on source alias `s` (at the job's revision): every claim, redrive and reopen statement uses it.
 * A denied place (memory_deny is insert-only) or a tombstone is permanent, so such a job is settled, never claimed or revived. */
export const CLAIMABLE_SOURCE = (s: string) => `(${s}.state='active' AND ${s}.outcome!='working' AND NOT (${s}.kind IN ('tool-outcome','activity') AND ${s}.outcome='failed') AND NOT ${DENIED_PLACE(s)} AND NOT ${TOMBSTONED(s)})`;

const SOURCE_AT = (extra: string) => `EXISTS (SELECT 1 FROM memory_sources s WHERE s.id=memory_jobs.source_id AND s.revision=memory_jobs.source_revision AND ${extra})`;
// NOT INDEXED keeps the status index out of the plan: rows are sought by rowid, never by walking the open range.
const TARGET = `WHERE rowid IN (SELECT CAST(value AS INTEGER) FROM json_each(?1)) AND status IN ${OPEN} AND NOT (status='leased' AND lease_until>=?2)`;
const CLOSE = `lease_generation=lease_generation+1,lease_owner=NULL,lease_until=0`;

export const SETTLE_SQL: Readonly<Record<SettleCategory, string>> = {
  /** No source at the job's revision (a newer revision replaced it) or a deleted one: never claimable again. */
  superseded: `UPDATE memory_jobs NOT INDEXED SET status='cancelled',${CLOSE},error='settled:superseded' ${TARGET}
    AND NOT ${SOURCE_AT("s.state!='deleted'")}`,
  /** Its conversation or scope was deleted (a memory_deny row, never removed) or the source is tombstoned at its revision: never claimable again. */
  denied: `UPDATE memory_jobs NOT INDEXED SET status='cancelled',${CLOSE},error='settled:denied' ${TARGET}
    AND ${SOURCE_AT(`(${DENIED_PLACE("s")} OR ${TOMBSTONED("s")})`)}`,
  /** A turn still running: a settlement is a new revision, which cancels this job anyway. */
  working: `UPDATE memory_jobs NOT INDEXED SET status='cancelled',${CLOSE},error='settled:working' ${TARGET}
    AND ${SOURCE_AT("s.state='active' AND s.outcome='working'")}`,
  /** A failed tool outcome or activity: content is fixed per revision, so nothing to learn (as capture.ts writes new rows). */
  tool: `UPDATE memory_jobs NOT INDEXED SET status='complete',${CLOSE} ${TARGET}
    AND ${SOURCE_AT("s.state='active' AND s.kind IN ('tool-outcome','activity') AND s.outcome='failed'")}`,
  /** Out of attempts while still open. */
  attempts: `UPDATE memory_jobs NOT INDEXED SET status='failed',${CLOSE} ${TARGET} AND attempts>=3`,
  /** A retired source: parked with the restorable marker, reopened by the branch-change paths. */
  retired: `UPDATE memory_jobs NOT INDEXED SET ${PARK_SET} ${TARGET} AND ${SOURCE_AT("s.state='retired'")}`,
};

/** Settle the blocked ones among these job rowids. At most six statements, whatever the number of rows; only the
 * categories asked for run (all of them when the caller does not know which kind of block it met). Returns the rowids
 * that were closed out, so a caller holding them in memory (the claim index) can drop them without looking again. */
export function settleRows(db: DatabaseSync, rids: readonly (bigint | number | string)[], now: number, categories?: ReadonlySet<SettleCategory>): bigint[] {
  if (!rids.length) return [];
  const list = JSON.stringify(rids.map(String));
  const closed: bigint[] = [];
  for (const category of SETTLE_CATEGORIES) {
    if (categories && !categories.has(category)) continue;
    const statement = db.prepare(`${SETTLE_SQL[category]} RETURNING rowid AS rid`);
    statement.setReadBigInts(true);
    for (const row of statement.all(list, now)) closed.push(row.rid as bigint);
  }
  return closed;
}
