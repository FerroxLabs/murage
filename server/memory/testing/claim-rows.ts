// SPDX-License-Identifier: AGPL-3.0-or-later
// The claim's per-statement accounting for tests (CLAIM-DESIGN-FABLE.md 8.1): every execution of every prepared statement while
// `work` runs, with its parameters, and the rows that execution examines, from a formula per statement that its EXPLAIN QUERY PLAN
// justifies (claim-settle.test.ts T7 asserts each plan). node:sqlite has no sqlite3_stmt_status or scanstatus, so rows examined
// are accounted from the plan and the statement text. A statement the table does not know is reported in `unknown`: the tests
// fail on it (an unaccounted statement on the claim path). Test-only; never imported by the product.
import type { DatabaseSync } from "node:sqlite";
import { database } from "../../database.ts";
import { CLAIM_WINDOW, MEMORY_CLAIM_SQL } from "../jobs.ts";
import { CLAIM_INDEX_SQL, memoryClaimIndex } from "../claim-index.ts";
import { SETTLE_SQL } from "../claim-settle.ts";
import { SETTLE_SWEEP_SQL } from "../park.ts";

type Formula = (db: DatabaseSync, params: unknown[], result: unknown) => number;
const count = (db: DatabaseSync, sql: string, params: unknown[]) => Number(db.prepare(sql).get(...(params as never[]))!.n);
const ridCount = (db: DatabaseSync, list: unknown) => Number(db.prepare("SELECT json_array_length(?) AS n").get(list as string)!.n);
const returned = (result: unknown) => (Array.isArray(result) ? result.length : result === undefined ? 0 : 1);
const one: Formula = () => 1;

/** Statement text -> rows examined by one execution. */
const FORMULAS = new Map<string, Formula>([
  // window statements: every WHERE term is on the index key, so SQLite steps exactly the rows it returns (+1 to see the range end)
  [MEMORY_CLAIM_SQL.window, (db, p) => count(db, "SELECT count(*) AS n FROM (SELECT 1 FROM memory_jobs INDEXED BY memory_jobs_pending WHERE status=?1 AND retry_at<=?2 LIMIT ?3)", p) + 1],
  [MEMORY_CLAIM_SQL.windowTied, (db, p) => count(db, "SELECT count(*) AS n FROM (SELECT 1 FROM memory_jobs INDEXED BY memory_jobs_pending WHERE status=?1 AND retry_at=?2 AND rowid>?3 LIMIT ?5)", p) + 1],
  [MEMORY_CLAIM_SQL.windowLater, (db, p) => count(db, "SELECT count(*) AS n FROM (SELECT 1 FROM memory_jobs INDEXED BY memory_jobs_pending WHERE status=?1 AND retry_at>?2 AND retry_at<=?4 LIMIT ?5)", p) + 1],
  // one step per open status, then the leased rows still held (an expired one ends the probe), +1
  [MEMORY_CLAIM_SQL.anyOpen, (db, p) => 3 + count(db, "SELECT count(*) AS n FROM memory_jobs INDEXED BY memory_jobs_pending WHERE status='leased' AND retry_at<=?1 AND lease_until>=?2", p) + 1],
  [MEMORY_CLAIM_SQL.nextDue, db => 3 + count(db, "SELECT count(*) AS n FROM memory_jobs INDEXED BY memory_jobs_pending WHERE status='leased'", [])],
  // per window row: the job by rowid, the source by its key, two deny seeks, one tombstone seek, then the materialized row read
  // once by the aggregate (+1 for ANY_DENY)
  [MEMORY_CLAIM_SQL.scope, (db, p) => ridCount(db, p[1]) * 6 + 1],
  [MEMORY_CLAIM_SQL.head, (db, p) => ridCount(db, p[0]) * 6 + 1],
  // the recent fallback: per newest rowid, the CTE's own table row (read by the primary key, newest first), the job probe, the source
  // probe, two deny seeks and one tombstone seek
  [MEMORY_CLAIM_SQL.recentNewest, db => 6 * Math.min(CLAIM_WINDOW, count(db, "SELECT count(*) AS n FROM memory_jobs", []))],
  [MEMORY_CLAIM_SQL.byId, one], [MEMORY_CLAIM_SQL.row, one], [MEMORY_CLAIM_SQL.payload, one],
  ["SELECT * FROM memory_meta WHERE id=1", one],
  ["SELECT 1 FROM memory_scope_bindings WHERE id='memory-roster-policy' AND state='pending'", one],
  ["UPDATE memory_jobs SET status='leased',lease_owner=?,lease_generation=?,lease_until=?,policy_revision=?,deletion_epoch=? WHERE id=?", one],
  ["SELECT created_at FROM memory_source_versions WHERE source_id=? AND revision=?", one],
  // the transaction wrapper's identity-epoch reading (provenance-stamp.ts): a one-row temp table and the data_version pragma
  ["SELECT (SELECT n FROM temp.identity_epoch) AS epoch, (SELECT data_version FROM pragma_data_version) AS version", one],
  // the claim index: one candidate by rowid with its source and the deny/tombstone seeks; the table end and gap jumps are one step
  [CLAIM_INDEX_SQL.check, () => 5], [CLAIM_INDEX_SQL.end, one], [CLAIM_INDEX_SQL.nextRid, one], [CLAIM_INDEX_SQL.byId, one],
  // a chunk of the index build or of new rows: every rowid of the range and a source probe for each (the index's own reading,
  // also counted by memoryClaimIndex.stats.examined)
  [CLAIM_INDEX_SQL.scan, (_db, p) => Number(BigInt(p[1] as bigint) - BigInt(p[0] as bigint)) * 2],
  // a page of the open walk (the first build, a reconcile step): per index row returned, the job row and the source probe, +1 to see the end
  [CLAIM_INDEX_SQL.openFirst, (_db, _p, r) => returned(r) * 3 + 1], [CLAIM_INDEX_SQL.openTied, (_db, _p, r) => returned(r) * 3 + 1],
  [CLAIM_INDEX_SQL.openLater, (_db, _p, r) => returned(r) * 3 + 1],
  // the settle sweep's two seeks: rows returned, +1
  [SETTLE_SWEEP_SQL.tied, (_db, _p, r) => returned(r) + 1], [SETTLE_SWEEP_SQL.later, (_db, _p, r) => returned(r) + 1],
  // settles: per listed rowid, the rowid probe and the source probe (3 is a ceiling for the one-term categories); `denied` adds
  // its two deny seeks and one tombstone seek (5), +1 for ANY_DENY
  ...Object.entries(SETTLE_SQL).map(([category, sql]) => [`${sql} RETURNING rowid AS rid`, (db: DatabaseSync, p: unknown[]) => ridCount(db, p[0]) * (category === "denied" ? 5 : 3) + 1] as [string, Formula]),
]);

/** The ones whose count follows the rows they returned. */
const USES_RESULT = new Set<string>([SETTLE_SWEEP_SQL.tied, SETTLE_SWEEP_SQL.later, CLAIM_INDEX_SQL.openFirst, CLAIM_INDEX_SQL.openTied, CLAIM_INDEX_SQL.openLater]);

export interface Measured<T> { result: T; sqls: string[]; params: unknown[][]; rows: number[]; returned: number[]; total: number; unknown: string[]; checks: number }

/** Every execution (run, get, all) of every prepared statement while `work` runs, cached ones included, with the rows each examines. */
export function measure<T>(work: () => T): Measured<T> {
  const db = database();
  const proto = Object.getPrototypeOf(db.prepare("SELECT 1")) as Record<string, (...args: unknown[]) => unknown>;
  const sqls: string[] = [], params: unknown[][] = [], rows: number[] = [], returnedRows: number[] = [], unknown: string[] = [];
  const saved: Record<string, (...args: unknown[]) => unknown> = {};
  let accounting = false;
  for (const method of ["run", "get", "all"]) {
    const original = proto[method]!; saved[method] = original;
    proto[method] = function (this: { sourceSQL: string }, ...args: unknown[]) {
      if (accounting) return original.apply(this, args);
      const sql = this.sourceSQL;
      const formula = FORMULAS.get(sql);
      // the counts are read before the statement runs, against the same state it sees
      let before: number | null = null;
      accounting = true;
      try { if (formula && !USES_RESULT.has(sql)) before = formula(db, args, undefined); }
      finally { accounting = false; }
      const result = original.apply(this, args);
      accounting = true;
      try {
        sqls.push(sql); params.push(args); returnedRows.push(returned(result));
        if (!formula) { unknown.push(sql); rows.push(0); }
        else rows.push(before ?? formula(db, args, result));
      } finally { accounting = false; }
      return result;
    };
  }
  const checks = memoryClaimIndex.stats.checks;
  try {
    const result = work();
    return { result, sqls, params, rows, returned: returnedRows, total: rows.reduce((a, b) => a + b, 0), unknown, checks: memoryClaimIndex.stats.checks - checks };
  } finally { for (const method of Object.keys(saved)) proto[method] = saved[method]!; }
}
