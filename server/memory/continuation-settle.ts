// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: warm-keep owns continuation preparation; revoke-marker/revoke-budget
// own marking and write admission. This consumer never invents a shown verdict.
import type { DatabaseSync } from 'node:sqlite';
import { sessionLookup } from './deny-read.ts';
import type { LineageReader, LineageVerdict, SessionKey } from './lineage-types.ts';
import type { LineageAllowance } from './lineage-allowance.ts';
import { admitMarkerSlice, beginRevokeMeasure, endRevokeMeasure } from './revoke-budget.ts';
import { validateSettleJob } from './settle-target.ts';
import { accountedDatabase } from './release-budget.ts';
import { readyImportedThread } from './lineage-write.ts';

export const CONTINUATION_SETTLE = Object.freeze({ jobs: 32, slices: 8, rows: 64, threadRows: 256, ms: 25 });
// Early and after-recall preparation share one turn allowance: no fresh budget on each check.
const attempted = new WeakSet<LineageAllowance>();
/** A rebuild of a refused turn spends no second settle: its checks stay the read-only predicate (index.ts startTurn). */
export function forgoContinuationSettle(allowance: LineageAllowance): void { attempted.add(allowance); }

/** Finish bounded work covering THIS session before interpreting an unproven
 * continuation as a reset. Final submission/tool/steer checks remain read-only.
 * Only the existing marker can narrow a pending window or mark a real revoke;
 * every return is the ordinary write-time predicate, never an exception to it.
 * Missing lineage/certificates, oversized readiness checks, orphaned jobs, folds
 * and exhausted budgets stay closed.
 */
export function continuationSessionVerdict(db: DatabaseSync, key: SessionKey, reader: LineageReader, allowance: LineageAllowance): LineageVerdict {
  let verdict = sessionLookup(db, key, reader);
  if (verdict.state !== 'checking' || (verdict.reason !== 'pending' && verdict.reason !== 'thread-not-ready')
    || (allowance.scope !== 'turn' && allowance.scope !== 'room')
    || attempted.has(allowance) || db.isTransaction || allowance.spentOut()) return verdict;
  attempted.add(allowance);
  const deadline = performance.now() + CONTINUATION_SETTLE.ms;
  try {
    allowance.spendNodes(key.threadId, 1);
    const file = accountedDatabase(db);
    if (verdict.reason === 'thread-not-ready') {
      finishThreadReadiness(file, key.threadId, allowance, deadline);
      if (performance.now() >= deadline || allowance.spentOut()) return verdict;
      verdict = sessionLookup(db, key, reader);
      if (verdict.state !== 'checking' || verdict.reason !== 'pending') return verdict;
    }
    const session = file.prepare('SELECT first_lsn,last_lsn FROM memory_session_lineage WHERE thread_id=? AND driver_instance=? AND native_session=?')
      .get(key.threadId, key.driverInstance, key.nativeSession);
    if (!session) return verdict;
    // Two primary-key ranges, never all jobs or all receipts. Keep orphaned and
    // seeding rows in the candidate set: validation refuses them, fail closed.
    const candidates = file.prepare(`WITH raw AS MATERIALIZED (
      SELECT since_lsn,revoke_id FROM memory_deny_pending
      WHERE thread_id IN (?, '*') AND since_lsn<=? LIMIT ?)
      SELECT raw.*,j.started_lsn,j.state,
        EXISTS(SELECT 1 FROM memory_revoke_audience a WHERE a.revoke_id=raw.revoke_id) AS audience_only
      FROM raw LEFT JOIN memory_revoke_jobs j ON j.revoke_id=raw.revoke_id`)
      .all(key.threadId, Number(session.last_lsn), CONTINUATION_SETTLE.jobs + 1);
    allowance.spendRows(key.threadId, candidates.length);
    if (candidates.length > CONTINUATION_SETTLE.jobs) return verdict;
    const ids = [...new Set(candidates.filter(row => !(reader.audience === null && Number(row.audience_only)))
      .filter(row => row.started_lsn === null || row.state === 'seeding'
        || Number(row.since_lsn) > Number(row.started_lsn) || Number(session.first_lsn) < Number(row.started_lsn))
      .map(row => Number(row.revoke_id)))];
    for (let slice = 0; ids.length && slice < CONTINUATION_SETTLE.slices && performance.now() < deadline; slice++) {
      allowance.spendRows(key.threadId, CONTINUATION_SETTLE.rows);
      // Central admission owns pace, the minute's byte cap, measured commits and
      // rollback charges. Do not use the owner's unpaced inline-revoke policy.
      file.exec('BEGIN IMMEDIATE');
      const measure = beginRevokeMeasure(file);
      let progress = false;
      try {
        const id = ids[0]!;
        if (!validateSettleJob(file, id)) {
          const result = admitMarkerSlice(file, CONTINUATION_SETTLE.rows, Math.max(0, deadline - performance.now()), null, { kind: 'only', revokeId: id }, 'drain');
          progress = result.admitted && result.outcome === 'progress';
        }
        file.exec('COMMIT'); endRevokeMeasure(file, measure);
      } catch (error) {
        if (file.isTransaction) file.exec('ROLLBACK');
        endRevokeMeasure(file, measure, false, false);
        throw error;
      }
      if (performance.now() >= deadline || allowance.spentOut()) return verdict;
      verdict = sessionLookup(db, key, reader);
      if (verdict.state !== 'checking' || verdict.reason !== 'pending') return verdict;
      if (!progress) return verdict;
      // A completed/narrowed job may leave another overlapping window. Rotate
      // within the fixed candidate set; never select an unrelated backlog job.
      ids.push(ids.shift()!);
    }
  } catch { /* incomplete proof: retain the strict verdict, never mark receipts revoked */ }
  return verdict;
}

/** The import writer proves ordering with a window over this thread. Bound both
 * sides first, inside the same writer transaction, so neither a large history
 * nor concurrent import can turn that check into an unbounded scan. Never
 * certify the global upgrade or repair absent lineage from receipts alone. */
function finishThreadReadiness(db: DatabaseSync, threadId: string, allowance: LineageAllowance, deadline: number): void {
  const cap = CONTINUATION_SETTLE.threadRows;
  // Reserve the whole possible read before beginning it, not after a short
  // allowance has already read more rows than it could pay for.
  allowance.spendRows(threadId, 2 * (cap + 1));
  db.exec('BEGIN IMMEDIATE');
  try {
    const cert = db.prepare('SELECT ready FROM memory_lineage_cert WHERE id=1').get();
    const no = db.prepare('SELECT no FROM memory_thread_no WHERE thread_id=?').get(threadId)?.no;
    if (Number(cert?.ready) === 1 && no !== undefined && performance.now() < deadline) {
      const messages = db.prepare(`SELECT l.lsn FROM messages m LEFT JOIN memory_line_lineage l
        ON l.thread_no=? AND l.message_id=m.id WHERE m.thread_id=? LIMIT ?`).all(no, threadId, cap + 1);
      const lines = db.prepare('SELECT lsn FROM memory_line_lineage WHERE thread_no=? LIMIT ?').all(no, cap + 1);
      if (messages.length <= cap && lines.length <= cap && messages.length === lines.length
        && messages.every(row => row.lsn !== null && row.lsn !== undefined)
        && performance.now() < deadline && !allowance.spentOut()) readyImportedThread(db, threadId);
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
