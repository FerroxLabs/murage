// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owners: this pass (the deny keys of a Forget an OLDER build left queued) = lane cause10-v2-legacy; called by database.ts at every
// open, and by restore.ts mergeDestinationMemoryDeletions before a restore reads the live ledger (completeLegacyForgetsBeforeRestore,
// lane cause10-v2-r4-opus; the restore's fence/snapshot code around that call = memv2-CL1R-r4b). The key writers it calls
// (memory-revocation.ts forgetRecordKeys, forgetSourceKeys) and the keys of a Forget made by this build = cause10-redesign-opus
// (FORGET-ATOMIC.md). Readers (import.ts, deny-read.ts) and the job runner: unchanged.
//
// 1.0.20 and 1.0.21 (f6ae52c670) wrote, in a Forget's commit, the deny keys of the newest 64 evidence rows (a record) or revisions (a
// source) and left the rest to the Forget's job: its supporting or imports phase. On a profile whose runner does not drain (the owner's:
// about 2,376 queued jobs) those keys were never written, so a copy of the forgotten words imported before the Forget stayed recallable
// and, once the job row was lost (a restore), importable again. From cause10 v2 a Forget writes its whole key set in its commit; this pass
// does the same for the Forgets already queued, when the profile is opened, before the open returns: nothing is served before it.
//
// One state machine, one terminal path. A queued job is LEGACY while it names a record with a `supporting` phase left and no
// `record.keys`, or a source with an `imports` phase left and no `imports.keys`. The pass turns each into KEYED: the same set statements
// a Forget of this build runs (every revision's import key; for a record that is not a room's notes, every supporting-source key) and
// the mark on the job row, in ONE transaction. KEYED is terminal for the pass; the job itself stays queued, at its cursor, for the
// runner (what it still does only ends sources and reclaims space). There is no state between LEGACY and KEYED on disk, so a kill at
// any instant leaves each job either untouched or done, and the next open goes on with the ones left: no cursor, no epoch, no marker
// outside the job rows (rule C1: no table, index, trigger or view text changes; the rows are 1.0.20's own shapes).
// A downgrade: 1.0.20 ignores the marks and its runner writes import keys again (harmless duplicates, as FORGET-ATOMIC.md). A Forget
// 1.0.20 queues after a downgrade is LEGACY at the next open of this build: the pass runs at every open, and an open with no LEGACY job
// is one statement over the queued job rows (found through their index, each row's intent looked at: linear in the queue) and no write.
//
// Bound (legacy-forget-pass-1021.test.ts L4): one read of the queue through memory_bindings_subject; per LEGACY job at most 9
// statements, linear in the revisions that job forgets (never in the profile); one commit per LEGACY_FORGET_PASS.jobsPerCommit jobs.
// Measured there: 2,376 LEGACY jobs among 4,752 queued, 168,703 keys, 10 commits, about 2 s; the next open about 12 ms.
// Not done here, left to the job as on the older build: ending the sources, the All chats preview line and the project text derived
// from a forgotten message (memory-revocation.ts forgottenMessages; its hook is registered after the first open), blanking, receipts.
// Fail closed: an error ends the open (database.ts), as a failed memory migration does; nothing is served, the next start goes on.
import { existsSync, lstatSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { DatabaseSync as OpenDatabase } from "../sqlite-open.ts";
import { validateMemorySchema } from "./schema.ts";
import { holdForgottenSources } from "../turn-source-holds.ts";
import { forgetRecordKeys, forgetSourceKeys, type RevocationJob } from "./memory-revocation.ts";

/** The queued jobs that still owe deny keys, oldest first: read through the job rows' index (subject_type, subject_id). The subject is
 * memory-revocation.ts REVOCATION_JOB_SUBJECT, written out: database.ts loads this module, and that one loads database.ts. */
export const LEGACY_FORGET_JOBS = `SELECT b.id AS id FROM memory_scope_bindings b WHERE b.subject_type='system' AND b.subject_id='memory-revocation' AND b.state IN ('granted','revoked')
  AND CASE WHEN json_valid(b.intent) THEN
    (json_type(b.intent,'$.record.id')='text' AND json_extract(b.intent,'$.record.keys') IS NULL AND EXISTS (SELECT 1 FROM json_each(b.intent,'$.phases') WHERE value='supporting'))
    OR (json_type(b.intent,'$.imports.id')='text' AND json_extract(b.intent,'$.imports.keys') IS NULL AND EXISTS (SELECT 1 FROM json_each(b.intent,'$.phases') WHERE value='imports'))
  ELSE 0 END ORDER BY b.rowid`;

export type LegacyForgetPassStats = { jobs: number; commits: number; keys: number; ms: number };
/** `jobsPerCommit`: jobs to a transaction (a commit is a disk sync; a job's keys are a few hundred rows). `step`: told at each step of
 * the pass (the kill witness copies the files there). `last`: what the newest pass of this process did (`keys`: rows its key statements
 * changed, the rows their triggers wrote included). */
export const LEGACY_FORGET_PASS = {
  jobsPerCommit: 256,
  step: null as null | ((at: "begin" | "keys" | "marked" | "commit", jobRow: string | null) => void),
  last: null as LegacyForgetPassStats | null,
};

/** Writes the whole deny key set of every Forget an older build left queued (see the head of this file). The caller's connection, no
 * transaction open; throws on any error with nothing half-written (the open then fails closed). `onWork` is told once, before the
 * first write, when there is any (the start-up note's heartbeat). */
export function writeLegacyForgetKeys(db: DatabaseSync, onWork?: (jobs: number) => void): LegacyForgetPassStats {
  const t0 = performance.now(), stats: LegacyForgetPassStats = { jobs: 0, commits: 0, keys: 0, ms: 0 };
  const ids = db.prepare(LEGACY_FORGET_JOBS).all().map(row => String(row.id));
  if (ids.length) onWork?.(ids.length);
  const per = Math.max(1, Math.trunc(LEGACY_FORGET_PASS.jobsPerCommit));
  for (let at = 0; at < ids.length; at += per) {
    db.exec("BEGIN IMMEDIATE");
    try {
      LEGACY_FORGET_PASS.step?.("begin", null);
      const read = db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?");
      const mark = db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?");
      const bump = db.prepare("UPDATE memory_meta SET deletion_epoch=deletion_epoch+1,policy_revision=policy_revision+1 WHERE id=1");
      const epochNow = db.prepare("SELECT deletion_epoch FROM memory_meta WHERE id=1");
      let done = 0;
      for (const id of ids.slice(at, at + per)) {
        const row = read.get(id);
        let job: RevocationJob | null = null;
        try { job = JSON.parse(String(row?.intent)) as RevocationJob; } catch { /* gone or unreadable: names nothing to key */ }
        if (!job || !Array.isArray(job.phases)) continue;
        const record = job.record, imports = job.imports;
        const owesRecord = Boolean(record && typeof record.id === "string" && !record.keys && job.phases.includes("supporting"));
        const owesSource = Boolean(imports && typeof imports.id === "string" && !imports.keys && job.phases.includes("imports"));
        if (!owesRecord && !owesSource) continue;
        // The Forget takes its whole effect now, so the watermark moves as it does for a Forget (forget.ts): between the older build's
        // commit and this open a copy of the forgotten words read shown, and a receipt or a retained engine session made then carries
        // the watermark of that time. Every reader of those compares it with memory_meta (deny-read.ts "watermark", session-proof.ts
        // "writetime-watermark"), so they are judged again; the keys alone would refuse only new reads. Once per job, in the job's
        // transaction: the end state does not depend on where a kill fell or on jobsPerCommit.
        bump.run();
        const epoch = Number(epochNow.get()!.deletion_epoch);
        const before = changes(db), now = Date.now();
        if (owesRecord) {
          const rev = typeof record!.rev === "number" ? record!.rev : null, notes = record!.notes === true;
          const told = forgetRecordKeys(db, { id: record!.id, rev }, notes, epoch, now);
          stats.keys += changes(db) - before;
          // as the Forget of this build: a turn that carried a message one of these sources was captured from no longer stands on it
          if (!notes) holdForgottenSources(db, told);
          record!.keys = true;
        }
        if (owesSource) {
          const mid = changes(db);
          forgetSourceKeys(db, { id: imports!.id, rev: null }, epoch, now);
          stats.keys += changes(db) - mid;
          // no key is left for the imports phase to write: it goes straight to its late-copy window, as for a Forget of this build
          imports!.keys = true; imports!.below = 1;
          if (job.phases[0] === "imports" && job.c && typeof job.c.below === "number") job.c.below = 1;
        }
        LEGACY_FORGET_PASS.step?.("keys", id);
        mark.run(JSON.stringify(job), id);
        LEGACY_FORGET_PASS.step?.("marked", id);
        done++;
      }
      db.exec("COMMIT");
      stats.jobs += done; stats.commits++;
      LEGACY_FORGET_PASS.step?.("commit", null);
    } catch (error) {
      if (db.isTransaction) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } }
      console.error(`[memory] the keys of forgets an earlier version left queued could not be written (${error instanceof Error ? error.message : String(error)}); the start ends here and the next start goes on from the jobs left`);
      throw error;
    }
  }
  stats.ms = performance.now() - t0;
  LEGACY_FORGET_PASS.last = stats;
  return stats;
}
const changes = (db: DatabaseSync) => Number(db.prepare("SELECT total_changes() AS n").get()!.n);

/** 1.0.21 cause10 v2 r4 (ASTRA cbea3962df High, restore.ts:197): the installation restore carries the live file's deletion ledger
 * (memory_tombstones) onto the backup it restores, never the live file's job rows. A Forget an older build left queued owes deny keys
 * only its job row names; restored before any writable open of this build had keyed it (database.ts), those keys were lost with the
 * row, and a copy of the forgotten words imported before the Forget read shown again in the restored profile. So the restore calls this
 * first, on the live file (the installation is stopped and leased), before it reads that ledger: this pass, the one an open runs, keys
 * every such Forget, and the ledger the restore then reads holds the whole key set. On its own connection, closed before it returns.
 * - Nothing to key (no file, not a plain file, a memory schema the merge does not read, no job table, no LEGACY job): nothing is opened
 *   for writing; the merge goes on as before (unsafe, unreadable or legacy is still the merge's own case: UNSAFE_MEMORY_LEDGER,
 *   destination-ledger-unreadable, legacy-destination). The writes are the ones the next open of the live file would make, so a rollback
 *   to it (installation-restore.ts keeps it as the previous directory) finds them already made.
 * - A LEGACY job and the pass cannot finish (or the queue cannot be read): the restore is refused, RESTORE_LEGACY_FORGET_INCOMPLETE,
 *   before anything of the candidate is written. Each batch the pass committed stays committed (the next open goes on from the rest). */
export function completeLegacyForgetsBeforeRestore(file: string): LegacyForgetPassStats | null {
  if (!existsSync(file)) return null;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return null;
  let owed = 0;
  let read: DatabaseSync;
  try { read = new OpenDatabase(file, { readOnly: true }); } catch { return null; }
  try {
    // the merge's own gate: a file whose memory schema it does not read (damaged, newer, older than memory) carries no ledger, and the
    // restore of such a file stays possible (audit A-2); nothing is written to it here
    try { if (!validateMemorySchema(read).size || !read.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_scope_bindings'").get()) return null; }
    catch { return null; }
    try { owed = read.prepare(LEGACY_FORGET_JOBS).all().length; }
    catch (error) { throw refused(error); }
  } finally { read.close(); }
  if (!owed) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new OpenDatabase(file);
    db.exec("PRAGMA busy_timeout=5000");
    return writeLegacyForgetKeys(db);
  } catch (error) { throw refused(error); }
  finally { try { db?.close(); } catch { /* closed */ } }
}
const refused = (error: unknown) => { const out = new Error(`RESTORE_LEGACY_FORGET_INCOMPLETE: a forget an earlier version left unfinished could not be completed before the restore (${error instanceof Error ? error.message : String(error)}); nothing was restored. Start this version once on the current installation, then restore again`); console.error(`[memory] ${out.message}`); return out; };
