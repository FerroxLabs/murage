// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// q1023-seanclean: the one-time clean-up of a store whose revoke queue never drains while the app runs (thousands of active
// revoke jobs, tens of thousands of pending windows: every owner turn reads "checking", the leftover-view drop is withheld).
// Owner of this module and of its command (server/memory-reset-hidden-rules.ts, electron/memory-reset-entry.mjs): q1023-seanclean.
// Owner of every step it calls: the revoke marker (revoke-marker.ts, revoke-commit.ts, memory-revocation.ts).
//
// Run with the app closed. It changes revoke state only through the marker's own steps:
//   FINISH    drainRevokeMarker: every revoke's flow, mark, hold and tidy phases and every bookkeeping job they wait on run to
//             their end, unpaced (no turn is waiting). Nothing is withdrawn: every mark the revoke owed is written, then its
//             pending windows go, exactly as the runner would do it over days.
//   A revoke FINISH cannot end (it does not parse, it keeps failing, or the time allowed ran out) stays exactly as it is, with its
//   marks and its windows: this command never withdraws a revoke. (The app refuses to undo audience, deletion and folded revokes
//   because a finished revoke may have skipped work under their marks, revoke-marker.ts foldRefusesUndo; so does this command.)
//   The report then reads "incomplete" and the app's runner carries on as before.
//   SWEEP     pending rows no job owns (clearOrphanPending), and the audience cover rows once no job is left (the quiet tidy's
//             own last stage).
// Its own statements never name a record, a source, a message, a tombstone, memory_deny or a deny mark. (The clean-up jobs the
// drain finishes are the owner's own committed deletions: they end what he deleted, as the app's runner does.) Every step is its
// own transaction: a stop at any point leaves a store the app opens as usual. Counts only are reported, never content.
import type { DatabaseSync } from "node:sqlite";
import { COVER_REVOKE, WALKER_REVOKE } from "./lineage-types.ts";
import { drainRevokeMarker, REVOCATION_JOB_SUBJECT, setForgottenMessagesHook, type ForgottenMessagesHook } from "./memory-revocation.ts";
// the flip drain and the revoke fold register with the marker when revoke-commit.ts loads (setFlipDrain, revoke-fold.ts setFoldHooks):
// without them a queued flip or a seeding fold bulk stops every slice. memory-revocation.ts already loads it; named here so a change
// of that module's imports cannot take it away from this command (witness W-FLIP)
import "./revoke-commit.ts";
import { bumpDenyGeneration, clearOrphanPending, hasWritetime } from "./revoke-marker.ts";

/** Slices one FINISH batch runs before the clock is read again. */
export const FINISH_BATCH_SLICES = 2_000;
const ORPHAN_PAGE = 4_096;
const OPEN_JOB = "state NOT IN ('done','undone')";

export interface HiddenRuleCounts {
  jobsOpen: number; jobsActive: number; jobsFolded: number; jobsSeeding: number; jobsUndoing: number; jobsFinished: number;
  pendingThreads: number; pendingScopes: number; frontier: number; flips: number; bookkeeping: number;
  denyRules: number; denyLines: number; denyRanges: number; denyMemory: number;
}
export interface ResetReport {
  status: "clean" | "incomplete" | "nothing-to-do" | "not-a-memory-store";
  before: HiddenRuleCounts; after: HiddenRuleCounts;
  finishSlices: number; finishTimedOut: boolean; finishError: string | null;
  orphansCleared: number; coverCleared: number;
}
export interface ResetOptions {
  /** q1023-cleanfix: the hook the app's runner runs when a Forget job ends more of its sources (server/forgotten-messages-hook.ts, the
   * same body server/index.ts registers): derived project text citing the messages goes stale and they leave the event log. Required:
   * FINISH ends Forget jobs, and a job step that ends sources without it is deleted with nothing to retry the hook. */
  forgottenMessages: ForgottenMessagesHook;
  /** The longest FINISH may run (default 30 minutes). What is not finished by then stays as it is (the report reads "incomplete"). */
  finishMs?: number;
  now?: () => number;
  /** Called between steps with counts only. */
  progress?: (phase: string, counts: HiddenRuleCounts) => void;
  /** Test seam: slices per FINISH batch. */
  batchSlices?: number;
}

const has = (db: DatabaseSync, table: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table));
const n = (db: DatabaseSync, sql: string): number => Number(db.prepare(sql).get()?.n ?? 0);
const countOf = (db: DatabaseSync, table: string, where = "1"): number => (has(db, table) ? n(db, `SELECT count(*) AS n FROM ${table} WHERE ${where}`) : 0);

export function hiddenRuleCounts(db: DatabaseSync): HiddenRuleCounts {
  const jobs = (where: string) => countOf(db, "memory_revoke_jobs", where);
  return {
    jobsOpen: jobs(OPEN_JOB), jobsActive: jobs("state='active'"), jobsFolded: jobs("state='folded'"), jobsSeeding: jobs("state='seeding'"),
    jobsUndoing: jobs("state='undoing'"), jobsFinished: jobs("state IN ('done','undone')"),
    pendingThreads: countOf(db, "memory_deny_pending"), pendingScopes: countOf(db, "memory_deny_pending_scope"),
    frontier: countOf(db, "memory_revoke_frontier"), flips: countOf(db, "memory_receipt_flips"),
    bookkeeping: countOf(db, "memory_scope_bindings", `subject_type='system' AND subject_id='${REVOCATION_JOB_SUBJECT}' AND state IN ('granted','revoked')`),
    denyRules: countOf(db, "memory_deny"), denyLines: countOf(db, "memory_deny_line"), denyRanges: countOf(db, "memory_deny_range"),
    denyMemory: countOf(db, "memory_deny_memory"),
  };
}
/** Whether nothing hidden is left that pauses memory or withholds the leftover-view drop. */
export function hiddenRulesSettled(c: HiddenRuleCounts): boolean {
  return c.jobsOpen === 0 && c.pendingThreads === 0 && c.pendingScopes === 0 && c.frontier === 0 && c.flips === 0 && c.bookkeeping === 0;
}

function inTransaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const out = run(); db.exec("COMMIT"); return out; }
  catch (error) { if (db.isTransaction) { try { db.exec("ROLLBACK"); } catch { /* rolled back */ } } throw error; }
}
/** An error's class for the report: its code or name, never its text (a message can quote a row). */
const errorClass = (error: unknown): string => {
  const e = error as { code?: unknown; errcode?: unknown; name?: unknown };
  return String(e?.code ?? e?.errcode ?? e?.name ?? "error").slice(0, 64);
};

/** FINISH: the marker drain in batches, until nothing moves, an error, or the time allowed. */
function finish(db: DatabaseSync, deadline: number, now: () => number, batch: number, report: ResetReport, progress: ResetOptions["progress"]): void {
  for (;;) {
    try {
      const drained = drainRevokeMarker(db, batch);
      report.finishSlices += drained.slices;
      return;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "MEMORY_REVOKE_DRAIN_UNBOUNDED") { report.finishError = errorClass(error); return; }
      report.finishSlices += batch;
    }
    progress?.("finish", hiddenRuleCounts(db));
    if (now() >= deadline) { report.finishTimedOut = true; return; }
  }
}

/** SWEEP: pending rows no job owns; the cover rows once no job is open. */
function sweep(db: DatabaseSync, report: ResetReport): void {
  for (;;) {
    const gone = inTransaction(db, () => clearOrphanPending(db, ORPHAN_PAGE));
    report.orphansCleared += gone;
    if (gone < ORPHAN_PAGE) break;
  }
  if (countOf(db, "memory_revoke_jobs", OPEN_JOB) > 0) return;
  for (;;) {
    const gone = inTransaction(db, () => Number(db.prepare(`DELETE FROM memory_revoke_reached WHERE revoke_id IN (${COVER_REVOKE},${WALKER_REVOKE}) AND thread_id IN
      (SELECT thread_id FROM memory_revoke_reached WHERE revoke_id IN (${COVER_REVOKE},${WALKER_REVOKE}) LIMIT ${ORPHAN_PAGE})`).run().changes));
    report.coverCleared += gone;
    if (gone < ORPHAN_PAGE) break;
  }
}

/** The clean-up, whole. The caller owns the connection (opened as the app opens it) and the data folder's lease. */
export function resetHiddenRules(db: DatabaseSync, options: ResetOptions): ResetReport {
  const now = options.now ?? Date.now, batch = Math.max(1, options.batchSlices ?? FINISH_BATCH_SLICES);
  const before = hiddenRuleCounts(db);
  const report: ResetReport = { status: "clean", before, after: before, finishSlices: 0, finishTimedOut: false, finishError: null, orphansCleared: 0, coverCleared: 0 };
  if (!hasWritetime(db)) { report.status = "not-a-memory-store"; return report; }
  if (hiddenRulesSettled(before)) { report.status = "nothing-to-do"; return report; }
  options.progress?.("start", before);
  // every Forget step FINISH runs tells the hook in its own transaction, as the runner's does (memory-revocation.ts forgottenMessages)
  setForgottenMessagesHook(options.forgottenMessages);
  finish(db, now() + Math.max(0, options.finishMs ?? 30 * 60_000), now, batch, report, options.progress);
  options.progress?.("finished", hiddenRuleCounts(db));
  sweep(db, report);
  inTransaction(db, () => bumpDenyGeneration(db));
  report.after = hiddenRuleCounts(db);
  report.status = hiddenRulesSettled(report.after) ? "clean" : "incomplete";
  return report;
}
