// Offline helpers: no runtime configuration, Store or provider imports.
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateMemorySchema, validateMemorySchema } from "./schema.ts";
import { reconcilePipStances } from "./pip-stance.ts";
import { purgeForgottenEvolutionCopies } from "./evolution-forgetting.ts";
import { RESTORE_REVIEW_FILE, readRestoreReview } from "../../electron/restore-review.mjs";
import { writeFileAtomic } from "../atomic.ts";
import { detachRestoredLedgerAccounts, mergeDestinationConnectedLedger } from "../connected-app-journal.ts";
import { bumpWriteEpoch } from "../app-write-revision.ts";
import { PARK_SQL, parkRetiredLeasedJobs } from "./park.ts";
import { addTarget, bringInCopiesOf, deferRecordsScan, endSourceWork, forgetJob, INLINE_REVOCATION, noteSource, startRevocationJob, type RevocationJob, type RevocationTarget } from "./memory-revocation.ts";
import { noteRevocation, RECORD_TOMBSTONE_AFFECTED, RECORD_TOMBSTONE_REVOCATION_SCAN_TAIL, revocationIndexReady, revokeAllDisclosures } from "./revocation.ts";
import { REF_MATCH } from "./revocation-ref-match.ts";
export { RECORD_TOMBSTONE_AFFECTED, RECORD_TOMBSTONE_REVOCATION_SCAN_TAIL };

/** Main holds both stopped installations' leases until selection publication. */
export function mergeOriginalMemoryDeletions(original: string, candidate: string) {
  const review=readRestoreReview(candidate);
  if(review?.version!==1||review.status!=="review-required"||!Array.isArray(review.modifications))throw new Error("INVALID_RESTORE_MEMORY_REVIEW");
  const result=mergeDestinationMemoryDeletions(original,candidate);
  // A connected-app action the original left unresolved keeps blocking its repeat in the restored installation.
  const ledger=mergeDestinationConnectedLedger(original,candidate);
  detachRestoredLedgerAccounts(candidate);
  const modifications=[...review.modifications,{component:"messages.db",action:`Current original memory ledger: ${result.history}; ${result.merged} tombstones retained before selection`},
    ...(ledger.merged?[{component:"connected-app-ledger.db",action:`${ledger.merged} connected app records from the original installation kept, still marked as possibly sent`}]:[])];
  writeFileAtomic(join(candidate,RESTORE_REVIEW_FILE),JSON.stringify({...review,modifications})+"\n",{mode:0o600});
  return result;
}

/** Forgotten material leaves memory everywhere it went: records resting on
 * it, records derived from those, and (0.1.61 lane M) a note brought into a
 * project from it (bring-in.ts: its source names what it came from). */
export function applyMemoryTombstones(db: DatabaseSync) {
  // a deleted conversation's or bot's deny rows (memory_deny, schema REVOKE_LATE_SQL) end its sources, and a bot's records
  const deny = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_deny'").get());
  if (deny) db.exec(`UPDATE memory_sources SET state='deleted' WHERE state!='deleted' AND (thread_id IN (SELECT id FROM memory_deny WHERE kind='thread') OR scope_id IN (SELECT id FROM memory_deny WHERE kind='scope'));`);
  reconcilePipStances(db);
  db.exec(`UPDATE memory_sources SET state='deleted' WHERE EXISTS (
    SELECT 1 FROM memory_tombstones t WHERE t.target_type='source' AND t.target_id=memory_sources.id
    AND (t.revision IS NULL OR t.revision=memory_sources.revision));
    UPDATE memory_sources SET state='deleted' WHERE kind='bring-in' AND state!='deleted' AND EXISTS (
      SELECT 1 FROM memory_source_versions v, json_each(v.payload,'$.broughtFrom.sources') j
      WHERE v.source_id=memory_sources.id AND v.revision=memory_sources.revision AND (
        EXISTS (SELECT 1 FROM memory_sources o WHERE o.id=json_extract(j.value,'$.id') AND (o.state='deleted' OR o.revision!=json_extract(j.value,'$.revision')))
        OR NOT EXISTS (SELECT 1 FROM memory_sources o WHERE o.id=json_extract(j.value,'$.id'))
        OR EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='source' AND t.target_id=json_extract(j.value,'$.id') AND (t.revision IS NULL OR t.revision=json_extract(j.value,'$.revision')))));
    WITH RECURSIVE affected(id,version) AS (
      SELECT r.id,r.version FROM memory_records r WHERE EXISTS (
        SELECT 1 FROM memory_tombstones t WHERE t.target_type='record' AND t.target_id=r.id AND (t.revision IS NULL OR t.revision=r.version))
      UNION SELECT e.record_id,e.record_version FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id WHERE s.state='deleted' OR EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='source' AND t.target_id=e.source_id AND (t.revision IS NULL OR t.revision=e.source_revision))
      ${deny ? "UNION SELECT r.id,r.version FROM memory_records r WHERE r.scope_id IN (SELECT id FROM memory_deny WHERE kind='scope')" : ""}
      UNION SELECT d.child_id,d.child_version FROM memory_derivations d JOIN affected a ON d.parent_id=a.id AND d.parent_version=a.version
    ) UPDATE memory_records SET state='deleted',owner_pinned=0 WHERE (id,version) IN (SELECT id,version FROM affected);
    -- a restored record that is forgotten keeps no words, the same end state a live Forget leaves (memory-revocation.ts affect);
    -- this also clears a backup made before Forget scrubbed text
    UPDATE memory_records SET text='' WHERE state='deleted' AND text!='';
    UPDATE memory_jobs SET status='cancelled',lease_generation=lease_generation+1,lease_owner=NULL,lease_until=0
      WHERE status!='cancelled' AND (source_id IN (SELECT id FROM memory_sources WHERE state='deleted') OR EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='source' AND t.target_id=memory_jobs.source_id AND (t.revision IS NULL OR t.revision=memory_jobs.source_revision)));
    ${PARK_SQL.forgetTombstoned};
    -- Completed deletion work stays completed (scale finding A6): a receipt the worker already
    -- marked 'deleted' (it sets that, for both indexes, only on a deleted record) is not queued
    -- again by every later forget. A restore first resets every receipt that is not
    -- delete-pending (pauseRestoredMemory), so a restored file's deleted records are still scrubbed.
    UPDATE memory_projection_receipts SET lexical_status='delete-pending',embedding_status='delete-pending'
      WHERE lexical_status!='deleted' AND (record_id,record_version) IN (SELECT id,version FROM memory_records WHERE state='deleted');
    `);
  // Tombstones end exactly the receipts that cite forgotten material: a
  // deleted record at the version cited, or a source that is deleted or
  // tombstoned at the revision cited. Read through the revocation index
  // (schema v8; revocation.ts), which holds only receipts not yet revoked,
  // once it is ready; until then, the 1.0.1 scan of every receipt's JSON.
  noteRevocation("records","tombstones",Number(db.prepare(revocationIndexReady(db)?TOMBSTONE_REVOCATION_SQL:TOMBSTONE_REVOCATION_SCAN_SQL).run().changes));
  if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_learning_events'").get())db.exec(`DELETE FROM memory_learning_events WHERE
    source_id IN (SELECT id FROM memory_sources WHERE state='deleted')
    OR EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.target_type='source' AND t.target_id=source_id AND (t.revision IS NULL OR t.revision=source_revision))
    OR (record_id,record_version) IN (SELECT id,version FROM memory_records WHERE state='deleted')
    OR (prior_id,prior_version) IN (SELECT id,version FROM memory_records WHERE state='deleted');`);
  purgeForgottenEvolutionCopies(db);
}

/** What one forget just tombstoned: the sources (revision null: every revision) and records it names. */
export type ForgetTargets = { sources: Array<{ id: string; revision: number | null }>; records: Array<{ id: string; revision: number | null }> };

/** Tombstone application for ONE forget (forget.ts), a deleted conversation or a deleted bot (capture.ts): the same end state as
 * applyMemoryTombstones for what it names, with nothing proportional to history before the commit. Inside the caller's
 * transaction: the named sources end (primary keys) with their own work, and copies brought in from them by their origin
 * (bounded). Everything else (more copies, PIP stances, the records resting on or derived from what ended, the receipts citing
 * them, evaluation bindings, what was learned) is a durable job (memory-revocation.ts): a small one finishes here within
 * INLINE_REVOCATION, a large one is left to the runner and resumes after a restart. Readers already refuse the material from
 * the caller's commit: the deletion-epoch bump, the tombstones and deny rows, read by ancestry (deny.ts). */
export function applyForgetTombstones(db: DatabaseSync, targets: ForgetTargets, options: { inline?: { rows: number; ms: number }; job?: Partial<RevocationJob>; before?: RevocationJob["phases"]; tail?: "all"; messages?: string } = {}): { sourceIds: string[]; pending: boolean; job: RevocationJob } {
  const markSource = db.prepare("UPDATE memory_sources SET state='deleted' WHERE id=? AND state!='deleted' AND (? IS NULL OR revision=?)");
  for (const t of targets.sources) markSource.run(t.id, t.revision, t.revision);
  const ended: RevocationTarget[] = targets.sources.map(t => ({ id: t.id, rev: t.revision }));
  endSourceWork(db, ended);
  ended.push(...bringInCopiesOf(db, ended));
  const job = forgetJob({ epoch: Number(db.prepare("SELECT deletion_epoch FROM memory_meta WHERE id=1").get()!.deletion_epoch), ...options.job });
  if (options.before) job.phases.unshift(...options.before);
  if (options.tail === "all") job.phases.splice(job.phases.indexOf("done"), 0, "all");
  for (const t of ended) noteSource(db, job, t.id, t.rev);
  // a deleted conversation's message ids, for the learning purge (one statement: the messages go in the same transaction)
  if (options.messages && db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='messages'").get())
    db.prepare("INSERT OR IGNORE INTO memory_revocation_targets(job_id,kind,id,rev) SELECT ?,'m',id,-1 FROM messages WHERE thread_id=?").run(job.id, options.messages);
  for (const t of targets.records) if (!job.record) job.record = { id: t.id, rev: t.revision, notes: false };
  const pending = startRevocationJob(db, job, options.inline ?? INLINE_REVOCATION);
  return { sourceIds: ended.map(t => t.id), pending, job };
}
export { addTarget };

/** Bounded tombstone application for ONE record id (PIP owner delete): marks
 * that record's versions (and anything derived from them) deleted, sets only
 * their projection receipts to delete-pending where they have not already been
 * deleted, and revokes only the disclosures that carried them. Nothing else is
 * touched, so other records' completed deletion receipts stay `deleted`.
 * applyMemoryTombstones keeps its installation-wide behaviour for every other
 * caller. Caller owns the surrounding transaction. */
export function applyRecordTombstone(db: DatabaseSync, recordId: string) {
  const affected=RECORD_TOMBSTONE_AFFECTED;
  db.prepare(`${affected} UPDATE memory_records SET state='deleted',owner_pinned=0 WHERE (id,version) IN (SELECT id,version FROM affected)`).run(recordId);
  // an owner identity delete forgets the words too, the same end state as every other forget (memory-revocation.ts affect)
  db.prepare(`${affected} UPDATE memory_records SET text='' WHERE (id,version) IN (SELECT id,version FROM affected) AND text!=''`).run(recordId);
  db.prepare(`${affected} UPDATE memory_projection_receipts SET lexical_status='delete-pending',embedding_status='delete-pending'
    WHERE lexical_status!='deleted' AND (record_id,record_version) IN (SELECT id,version FROM affected)`).run(recordId);
  // and the receipts that were shown one of their evidence sources (a quoted
  // reply, working context) without citing the record (revocation.ts)
  // index not ready: the request reads a bounded window of receipt rowids and a durable job the rest, never a scan of every receipt
  const deferred=revocationIndexReady(db)?null:deferRecordsScan(db,{recordIds:[recordId],sourceIds:[],via:1,cause:"record-tombstone",tombstoneOf:recordId});
  if(deferred){noteRevocation("records",deferred.deferred?"record-tombstone-deferred":"record-tombstone",deferred.revoked);return;}
  noteRevocation("records","record-tombstone",Number(db.prepare(`${affected} ${revocationIndexReady(db)?RECORD_TOMBSTONE_REVOCATION_TAIL:RECORD_TOMBSTONE_REVOCATION_SCAN_TAIL}`).run(recordId).changes));
}

/** The receipts that cite forgotten material, read through the revocation
 * index. The *_SCAN_* statements are the 1.0.1 full scans of every receipt's
 * JSON: the path while the index is not ready, and the equivalence tests'
 * reference. Each index statement compares `+x.ref_id`/`+x.ref_version` where
 * the scan compared json_extract (no affinity on either), and reaches the rows
 * through CAST(x.ref_id AS TEXT), which every TEXT id it is compared with
 * implies (revocation.ts REF_MATCH). */
export const TOMBSTONE_REVOCATION_SQL = `UPDATE memory_disclosures SET state='revoked' WHERE state!='revoked' AND bundle_id IN (
    SELECT x.bundle_id FROM memory_records r CROSS JOIN memory_disclosure_refs x ON x.kind='record' AND CAST(x.ref_id AS TEXT)=r.id
      AND r.id=+x.ref_id AND r.version=+x.ref_version WHERE r.state='deleted'
    UNION SELECT x.bundle_id FROM memory_sources s CROSS JOIN memory_disclosure_refs x ON x.kind='source' AND CAST(x.ref_id AS TEXT)=s.id
      AND s.id=+x.ref_id WHERE s.state='deleted'
    UNION SELECT x.bundle_id FROM memory_tombstones t CROSS JOIN memory_disclosure_refs x ON x.kind='source' AND CAST(x.ref_id AS TEXT)=t.target_id
      WHERE t.target_type='source' AND EXISTS (SELECT 1 FROM memory_sources s WHERE s.id=+x.ref_id AND t.target_id=s.id AND (t.revision IS NULL OR t.revision=+x.ref_version)))`;
export const TOMBSTONE_REVOCATION_SCAN_SQL = `UPDATE memory_disclosures SET state='revoked' WHERE state!='revoked' AND (EXISTS (
      SELECT 1 FROM json_each(memory_disclosures.record_versions) j JOIN memory_records r
      ON r.id=json_extract(j.value,'$.id') AND r.version=json_extract(j.value,'$.version') WHERE r.state='deleted'
    ) OR EXISTS (SELECT 1 FROM json_each(memory_disclosures.source_versions) j JOIN memory_sources s
      ON s.id=json_extract(j.value,'$.id') WHERE s.state='deleted' OR EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='source' AND t.target_id=s.id AND (t.revision IS NULL OR t.revision=json_extract(j.value,'$.revision')))))`;
/** After RECORD_TOMBSTONE_AFFECTED: the receipts citing one of its versions' ids, or an evidence source of one. */
export const RECORD_TOMBSTONE_REVOCATION_TAIL = `UPDATE memory_disclosures SET state='revoked' WHERE state!='revoked' AND bundle_id IN (
    SELECT x.bundle_id FROM memory_disclosure_refs x WHERE x.kind='record' AND ${REF_MATCH("SELECT id FROM affected")}
    UNION SELECT x.bundle_id FROM memory_disclosure_refs x WHERE x.kind='source' AND ${REF_MATCH("SELECT e.source_id FROM memory_evidence e JOIN affected a ON e.record_id=a.id AND e.record_version=a.version")})`;


/** Caller owns the surrounding offline restore transaction. */
export function pauseRestoredMemory(db: DatabaseSync) {
  if (!validateMemorySchema(db).size) return false;
  db.exec("UPDATE memory_meta SET mode='paused',policy_revision=policy_revision+1 WHERE id=1;");
  parkRetiredLeasedJobs(db);
  db.prepare("UPDATE memory_jobs SET status='pending',lease_owner=NULL,lease_until=0,lease_generation=lease_generation+1 WHERE status='leased'").run();
  revokeAllDisclosures(db,"restore");
  db.prepare("UPDATE memory_projection_receipts SET lexical_status=CASE WHEN (SELECT r.state FROM memory_records r WHERE r.id=record_id AND r.version=record_version)='active' THEN 'pending' ELSE 'pending-archive' END,embedding_status='pending' WHERE lexical_status!='delete-pending'").run();
  applyMemoryTombstones(db);return true;
}

/** Existing destination is held by the installation restore lease. */
export function mergeDestinationMemoryDeletions(destination: string, candidate: string) {
  const original=join(destination,"messages.db"), target=join(candidate,"messages.db");
  if(!existsSync(original))return {merged:0,history:"backup-only"};
  const stat=lstatSync(original);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new Error("UNSAFE_MEMORY_LEDGER");
  let rows: Array<Record<string,unknown>>, denyRows: Array<Record<string,unknown>> = [], identity:string, epoch:number;
  // A damaged or newer-schema destination is exactly the case the app tells
  // people to restore for (audit A-2): the restore goes ahead, and the review
  // says the destination's deletion ledger could not be read.
  try {
    const source=new DatabaseSync(original,{readOnly:true});
    try {
      if(!validateMemorySchema(source).size)return {merged:0,history:"legacy-destination"};
      rows=source.prepare("SELECT * FROM memory_tombstones").all();
      denyRows=source.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_deny'").get()?source.prepare("SELECT * FROM memory_deny").all():[];
      const meta=source.prepare("SELECT installation_id,deletion_epoch FROM memory_meta WHERE id=1").get()!;
      identity=String(meta.installation_id);epoch=Number(meta.deletion_epoch);
    } finally {source.close();}
  } catch {
    return {merged:0,history:"destination-ledger-unreadable"};
  }
  const db=new DatabaseSync(target);
  try {
    db.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    if(!existsSync(target)||!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='messages'").get()) {
      db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id)); CREATE INDEX messages_thread ON messages(thread_id); CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY,active_leaf_id TEXT);");
    }
    migrateMemorySchema(db);
    db.exec("BEGIN IMMEDIATE");
    const insert=db.prepare("INSERT OR IGNORE INTO memory_tombstones VALUES(?,?,?,?,?,?,?,?)");
    for(const row of rows)insert.run(String(row.id),String(row.target_type),String(row.target_id),row.revision as number|null,row.content_hash as string|null,Number(row.epoch),String(row.reason),Number(row.created_at));
    // a deleted conversation's or bot's deny rows travel with the tombstones (the target was migrated above: the table exists)
    const deny=db.prepare("INSERT OR IGNORE INTO memory_deny(kind,id,epoch,created_at) VALUES(?,?,?,?)");
    for(const row of denyRows)deny.run(String(row.kind),String(row.id),Number(row.epoch),Number(row.created_at));
    db.prepare("UPDATE memory_meta SET installation_id=?,deletion_epoch=max(deletion_epoch,?),policy_revision=policy_revision+1 WHERE id=1").run(identity,epoch);
    pauseRestoredMemory(db);
    bumpWriteEpoch(db); // the candidate is a different file from any whose figures were cached
    db.exec("COMMIT");
    return {merged:rows.length,history:"destination-ledger-preserved"};
  } catch(error) {try{db.exec("ROLLBACK");}catch{/* no transaction */}throw error;}
  finally{db.close();}
}
