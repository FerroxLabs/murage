// Memory V2 retention (MEMORY-V2-DESIGN 4.10, migration step M5). Owner: lane I.
// Tables lane I owns here: `memory_jobs` (terminal jobs that published nothing) and `memory_source_versions.payload`
// (the notebook revision stub, [P] RET-W). Finished revoke rows are lane C (V15), the journal and dead terms lane A (A2, A5),
// session checks lane H (4.7): this file never deletes from those tables.
// NEVER deleted or altered here: a tombstone, a deny mark, a pending row, a `memory_source_versions` row or its `content_hash`,
// any `memory_evidence` row, any `memory_records` row, a job that published a record, any checkpoint row.
import type { DatabaseSync } from "node:sqlite";
import { threadCheckpointId } from "./checkpoints.ts";

export const RETENTION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Rows one batch looks at: one bounded page per transaction (I6), well inside the 8 ms slice on the fixture. */
export const RETENTION_PAGE = 256;
let page = RETENTION_PAGE;
/** Test seam (the kill harness wants many batch boundaries on a small fixture). */
export function setRetentionPageForTests(rows = RETENTION_PAGE): void { page = rows; }

/** A job is dead when it is terminal, its source version is older than 7 days, nothing it read is still the live answer
 * (the source moved to a newer revision, or was deleted, or is gone: a `retired` source, e.g. a branch switched away,
 * can become active again and needs its parked or complete job, park.ts:51), and no record, checkpoint publication or
 * receipt rests on the source version it processed. The current revision's `complete` capture job is the
 * learnability and health proof (learnable.ts:16, health.ts:63, consolidate.ts:65) and is kept while the source is active.
 * Checkpoint debt (CONTRACT-REQ I 1518, lane E): a job named by a `checkpoint-debt:<job id>` marker is kept while the marker exists
 * (its own debt, or its thread's whose roll starts at it: deleting it would leave a marker no roll can clear); an owed job without a
 * marker of its own is a complete capture of a current revision, which the source-revision test above already keeps.
 * The newest job row is never deleted: memory_jobs is a plain rowid table, and a deleted max(rowid) would be reused by the next job,
 * which readers of "rows since my last look" (claim-index.ts, the lap's `seen`) would then miss. */
const DEAD_JOB_FROM = `FROM memory_jobs j
  LEFT JOIN memory_source_versions v ON v.source_id=j.source_id AND v.revision=j.source_revision
  LEFT JOIN memory_sources s ON s.id=j.source_id
  WHERE j.rowid>?1 AND j.rowid<=?2
    AND j.status IN ('complete','failed','cancelled')
    AND v.created_at IS NOT NULL AND v.created_at<?3
    AND (s.id IS NULL OR s.revision>j.source_revision OR s.state='deleted')
    AND (j.error IS NULL OR j.error NOT LIKE 'parked:%')
    AND NOT EXISTS (SELECT 1 FROM memory_evidence_by_source e WHERE e.source_id=j.source_id AND e.source_revision=j.source_revision)
    AND j.rowid<(SELECT max(rowid) FROM memory_jobs)
    AND NOT EXISTS (SELECT 1 FROM memory_scope_bindings b WHERE b.id='checkpoint-debt:'||j.id)
    AND NOT EXISTS (SELECT 1 FROM memory_disclosure_refs r WHERE r.kind='source' AND CAST(r.ref_id AS TEXT)=j.source_id)`;
/** The by-source evidence lookup (memory_evidence_by_source, "did this revision publish a record?") and the receipt refs are each
 * complete only once their background build is ready (memory_late_build 'evidence', memory_revocation_index_build): until both are,
 * no job is deleted and nothing is stubbed (the runner sees no progress and backs off; the builds are lane C's). */
const lookupsReady = (db: DatabaseSync) => db.prepare("SELECT ready FROM memory_revocation_index_build").get()?.ready === 1
  && db.prepare("SELECT ready FROM memory_late_build WHERE name='evidence'").get()?.ready === 1;
const DEAD_JOBS = `SELECT j.rowid AS rid,j.id AS id,s.id AS sid,s.scope_id AS scope,s.thread_id AS thread ${DEAD_JOB_FROM}`;
/** A checkpoint publication of the job (4.10: any checkpoint row stays, and so does the job it names). The table's key is
 * (family_id, job_id) and the only producer (consolidate.ts) publishes into the job's own thread family, threadCheckpointId(scope,
 * thread), so the probe is one key seek; a source with no thread is never checkpointed (consolidate.ts 'source-has-no-thread'). A job
 * whose source row is gone has no family to seek: the probe by job id alone (a scan) runs only for those. */
function hasPublication(db: DatabaseSync, row: Record<string, unknown>): boolean {
  if (row.sid == null) return Boolean(db.prepare("SELECT 1 FROM memory_checkpoint_publications WHERE job_id=? LIMIT 1").get(String(row.id)));
  if (row.thread == null) return false;
  return Boolean(db.prepare("SELECT 1 FROM memory_checkpoint_publications WHERE family_id=? AND job_id=?").get(threadCheckpointId(String(row.scope), String(row.thread)), String(row.id)));
}
/** The same rule with the age test left out (?3 = +inf): of the jobs in the page that are dead in every way but age, the oldest
 * source-version time. The steady-state lap is due when that time is 7 days old (one deadline, no repeating timer). */
const YOUNG_JOBS = `SELECT min(v.created_at) AS young ${DEAD_JOB_FROM} AND v.created_at>=?4`;

export type RetentionStep = { cursor: number; done: boolean; deleted: number; young?: number };

/** One page of the `memory_jobs` pass, inside the caller's transaction (the cursor marker is written in the same one). */
export function pruneDeadJobsPage(db: DatabaseSync, after: number, now: number): RetentionStep {
  if (!lookupsReady(db)) return { cursor: after, done: false, deleted: 0 };
  const upper = db.prepare("SELECT rowid AS rid FROM memory_jobs WHERE rowid>? ORDER BY rowid LIMIT 1 OFFSET ?").get(after, page - 1)?.rid;
  const end = upper === undefined ? Number(db.prepare("SELECT max(rowid) AS rid FROM memory_jobs").get()?.rid ?? after) : Number(upper);
  if (end <= after) return { cursor: after, done: true, deleted: 0 };
  const dead = db.prepare(DEAD_JOBS).all(after, end, now - RETENTION_AGE_MS).filter(row => !hasPublication(db, row)).map(row => Number(row.rid));
  if (dead.length) db.prepare("DELETE FROM memory_jobs WHERE rowid IN (SELECT value FROM json_each(?))").run(JSON.stringify(dead));
  const young = db.prepare(YOUNG_JOBS).get(after, end, Number.MAX_SAFE_INTEGER, now - RETENTION_AGE_MS)?.young;
  return { cursor: end, done: upper === undefined, deleted: dead.length, ...(young == null ? {} : { young: Number(young) }) };
}

// ---- notebook payload stub ([P] RET-W, AO-H7, AF-H2) ----

/** Stubbing ships only once RET-W is GREEN on all four parts (MEMORY-V2-DESIGN 4.10). Part (1) (every payload reader run on
 * a stubbed row) is not complete in this lane round, so the fallback holds: no stubbing in the runner, notebook payload growth
 * is named as not bounded in 1.0.21. The function and its eligibility rule are built and witnessed so the switch is one line. */
export const PAYLOAD_STUB_ENABLED = false;

export const stubPayload = (contentHash: string) => JSON.stringify({ text: "", pruned: true, hash: contentHash });

/** A revision may be stubbed only when ALL hold: a notebook source; not the current revision and not one of the newest two;
 * older than 7 days; not already stubbed; no open job on the source; and every evidence row citing it belongs to a
 * superseded or archived record version with no receipt ref, no carry, no derivation child, no checkpoint membership,
 * and the revision is in no checkpoint exclusion. */
const STUBBABLE = `SELECT v.rowid AS rid,v.content_hash AS hash FROM memory_source_versions v JOIN memory_sources s ON s.id=v.source_id
  WHERE v.rowid>?1 AND v.rowid<=?2 AND v.source_id>='legacy:' AND v.source_id<'legacy;' AND s.state='active'
    AND v.revision<=s.revision-2 AND v.created_at<?3 AND json_extract(v.payload,'$.pruned') IS NOT 1
    AND NOT EXISTS (SELECT 1 FROM memory_jobs j WHERE j.source_id=v.source_id AND j.status IN ('pending','leased','partial','deferred'))
    AND NOT EXISTS (SELECT 1 FROM memory_checkpoint_exclusions x WHERE x.source_id=v.source_id AND x.source_revision=v.revision)
    AND NOT EXISTS (SELECT 1 FROM memory_disclosure_refs d WHERE d.kind='source' AND CAST(d.ref_id AS TEXT)=v.source_id)
    AND NOT EXISTS (SELECT 1 FROM memory_evidence_by_source e JOIN memory_records r ON r.id=e.record_id AND r.version=e.record_version
      WHERE e.source_id=v.source_id AND e.source_revision=v.revision AND (
        r.state NOT IN ('superseded','archived')
        OR EXISTS (SELECT 1 FROM memory_disclosure_refs d WHERE d.kind='record' AND CAST(d.ref_id AS TEXT)=r.id)
        OR EXISTS (SELECT 1 FROM memory_lineage_carry c WHERE c.child_kind=3 AND c.child_ref='record:'||r.id||':'||r.version)
        OR EXISTS (SELECT 1 FROM memory_derivations g WHERE g.parent_id=r.id AND g.parent_version=r.version)
        OR EXISTS (SELECT 1 FROM memory_checkpoint_members m WHERE m.record_id=r.id)))`;

/** One page of the payload stub pass. The row and its `content_hash` are kept (forget.ts builds import tombstones from them);
 * only `payload` is rewritten, and `secure_delete` (set on the handle) zeroes the old bytes. */
export function stubPayloadsPage(db: DatabaseSync, after: number, now: number): RetentionStep {
  if (!lookupsReady(db)) return { cursor: after, done: false, deleted: 0 };
  const upper = db.prepare("SELECT rowid AS rid FROM memory_source_versions WHERE rowid>? ORDER BY rowid LIMIT 1 OFFSET ?").get(after, page - 1)?.rid;
  const end = upper === undefined ? Number(db.prepare("SELECT max(rowid) AS rid FROM memory_source_versions").get()?.rid ?? after) : Number(upper);
  if (end <= after) return { cursor: after, done: true, deleted: 0 };
  const rows = db.prepare(STUBBABLE).all(after, end, now - RETENTION_AGE_MS);
  const update = db.prepare("UPDATE memory_source_versions SET payload=? WHERE rowid=?");
  for (const row of rows) update.run(stubPayload(String(row.hash)), Number(row.rid));
  return { cursor: end, done: upper === undefined, deleted: rows.length };
}
