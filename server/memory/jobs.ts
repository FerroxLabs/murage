import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { BACKGROUND_BUSY_MS, database, isDatabaseBusy, transaction } from "../database.ts";
import { resultSchema, type MemoryWork, type MemoryWorkResult } from "./worker-protocol.ts";
import { recordMemoryProcessing } from "./health.ts";
import { logSwallowed } from "./worker-log.ts";
import { traceSlowStep } from "./claim-trace.ts";
import { jobErrorText } from "./park.ts";
import { memoryClaimIndex } from "./claim-index.ts";
import { writeStamp } from "../io-budget.ts";
import { branchChangesMayBePending } from "./branch-change-flag.ts";
import { CLAIMABLE_SOURCE, settleRows, TOMBSTONED } from "./claim-settle.ts";
import { DENIED_PLACE } from "./deny.ts";
import { inheritEdge } from "./revoke-commit.ts";

let lastScope = "";
const workListeners=new Set<()=>void>();
export function notifyMemoryWork(){for(const listener of workListeners)listener();}
export function onMemoryWork(listener:()=>void){workListeners.add(listener);return ()=>{workListeners.delete(listener);};}

/** Use the queue index before starting a helper or opening a claim transaction. One index probe: blocked jobs are not in
 * the open statuses (claim-settle.ts), so an open and due job is a claimable one. Before the settle sweep has passed an
 * old file, `true` can also mean "a claim has rows to close out", which is just as much a reason to claim. */
export function hasClaimableMemoryJob(now=Date.now()):boolean {
  const db=database();
  if(db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id='memory-roster-policy' AND state='pending'").get())return false;
  return Boolean(db.prepare(MEMORY_CLAIM_SQL.anyOpen).get(now,now));
}

/** Future retries and expiring leases keep their due time between notifications: four index seeks in one statement, no source join. */
export function nextMemoryJobDelay(now=Date.now()):number|undefined {
  const row=database().prepare(MEMORY_CLAIM_SQL.nextDue).get(now,now,now,now,now);
  return row?.due==null?undefined:Math.max(1,Number(row.due)-now);
}
/** Test hook: forget which scope was served last (the round-robin restarts). */
export function resetMemoryClaimCursor() { lastScope = ""; invalidateMemoryClaimIndex(); }

/* The claim chooses a job from the in-process ready index (claim-index.ts, A10):
 * O(1) per claim in the common case, with every candidate re-checked by rowid
 * against the rules below. The aggregate statements here are its fallback,
 * run when the index finds nothing (or gives up) while the database has
 * changed since the fallback last agreed with it; a fallback that finds a job
 * the index missed rebuilds the index.
 *
 * The claim chooses a job WITHOUT touching memory_source_versions.payload (the
 * big column, on overflow pages): the old single statement computed the
 * payload length of every candidate and sorted them by a computed CASE before
 * LIMIT 1, so one claim cost O(pending) payload reads and a draining backlog
 * O(N^2) of them on the server's one synchronous thread.
 *
 * Order is unchanged: the first scope after the last one served (scope ids
 * ascending), wrapping to the lowest scope; inside it the lowest job rowid.
 * That is two aggregate queries over the (status,retry_at) index with a
 * primary-key probe per candidate, no ORDER BY and so no sort, and then the
 * payload of the ONE chosen job is read. No new index: memory tables are
 * validated against an exact schema (validateMemorySchema), so an extra index
 * would make an older build refuse the file. */
const CLAIM_FROM = `FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision`;
/** Everything that makes a job claimable now; `due` and `lease` are the parameter tokens of the time (they differ between the
 * statements that number their parameters and those that do not). The source terms are the one shared predicate
 * (claim-settle.ts CLAIMABLE_SOURCE): a deleted conversation or scope, or a tombstoned source, is never claimed. */
const claimWhere = (due: string, lease: string) => `${CLAIMABLE_SOURCE("s")} AND j.attempts<3 AND j.retry_at<=${due}
  AND j.status IN ('pending','partial','deferred','leased') AND (j.status!='leased' OR j.lease_until<${lease})`;
const CLAIM_WHERE = claimWhere("?", "?");
/** The most claimable jobs the scope and head aggregates look at. Fairness is unchanged while the backlog is under this, and the cost stays bounded above it. */
export const CLAIM_WINDOW = 256;
/** The statuses a claim can take, in the order the (status,retry_at) index holds them. */
const CLAIM_STATUSES = ["deferred","leased","partial","pending"] as const;
/** Most windows one claim reads (CLAIM_MAX_WINDOWS x CLAIM_WINDOW index rows, whatever the backlog). Only a file not yet
 * swept of blocked jobs ever needs more than the first. */
export const CLAIM_MAX_WINDOWS = 4;
/** One window's rows (?2 rowids as JSON strings, ?3 now), each with its scope and two flags: `live` (a lease still held: it waits)
 * and `ok` (claimable now). A row that is neither is blocked for good and is settled by the caller. Primary-key probes only.
 * `r` is materialized so the deny and tombstone seeks run once per row, not once per aggregate that reads `ok`. */
const WINDOW_ROWS = (rids: string, now: string) => `c AS MATERIALIZED (SELECT CAST(value AS INTEGER) AS rid FROM json_each(${rids})),
  r AS MATERIALIZED (SELECT j.rowid AS rid,s.scope_id AS scope_id,(j.status='leased' AND j.lease_until>=${now}) AS live,
    (NOT (j.status='leased' AND j.lease_until>=${now}) AND s.id IS NOT NULL AND j.attempts<3 AND ${CLAIMABLE_SOURCE("s")}) AS ok
    FROM c JOIN memory_jobs j ON j.rowid=c.rid LEFT JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision)`;
export const MEMORY_CLAIM_SQL = {
  /** Idle guard: is any job due? Index only, no join, no write lock. The first probe steps at most one index row per status;
   * the second keeps its lease residual on purpose and is bounded by the leased rows (live leases, at most the workers, and
   * expired ones, the first of which ends it), so a process's own lease in flight is not "work to do". */
  anyOpen: `SELECT 1 WHERE EXISTS (SELECT 1 FROM memory_jobs j INDEXED BY memory_jobs_pending WHERE j.status IN ('pending','partial','deferred') AND j.retry_at<=?1)
    OR EXISTS (SELECT 1 FROM memory_jobs j INDEXED BY memory_jobs_pending WHERE j.status='leased' AND j.retry_at<=?1 AND j.lease_until<?2)`,
  /** The first page of waiting jobs of one status, from the front of the (status,retry_at) index: ?1 status, ?2 now, ?3 page size.
   * Index columns and LIMIT only (no residual term), so the rows stepped are the rows returned. */
  window: `SELECT j.rowid AS rid,j.retry_at AS retry_at FROM memory_jobs j INDEXED BY memory_jobs_pending
    WHERE j.status=?1 AND j.retry_at<=?2 LIMIT ?3`,
  /** Later pages of the same claim, in two seeks (the tuple comparison would seek on retry_at only and walk the tied rows
   * again): the rest of the cursor's own retry_at (?2, already due) after its rowid (?3), then the later retry_at values up to
   * now (?4). ?5 page size. Index columns and LIMIT only. */
  windowTied: `SELECT j.rowid AS rid,j.retry_at AS retry_at FROM memory_jobs j INDEXED BY memory_jobs_pending
    WHERE j.status=?1 AND j.retry_at=?2 AND j.rowid>?3 ORDER BY j.rowid LIMIT ?5`,
  windowLater: `SELECT j.rowid AS rid,j.retry_at AS retry_at FROM memory_jobs j INDEXED BY memory_jobs_pending
    WHERE j.status=?1 AND j.retry_at>?2 AND j.retry_at<=?4 ORDER BY j.retry_at,j.rowid LIMIT ?5`,
  /** When the next retry or lease comes due: the soonest future retry of each waiting status (one index seek each, no residual: a
   * capped row wakes the worker once and the claim settles it), and the leased range (at most a worker's count of rows), whose due
   * time is the later of its retry and its lease end. Five parameters, all the time. */
  nextDue: `SELECT min(due) AS due FROM (
    SELECT (SELECT j.retry_at FROM memory_jobs j INDEXED BY memory_jobs_pending WHERE j.status='deferred' AND j.retry_at>? ORDER BY j.retry_at LIMIT 1) AS due UNION ALL SELECT (SELECT j.retry_at FROM memory_jobs j INDEXED BY memory_jobs_pending WHERE j.status='partial' AND j.retry_at>? ORDER BY j.retry_at LIMIT 1) UNION ALL SELECT (SELECT j.retry_at FROM memory_jobs j INDEXED BY memory_jobs_pending WHERE j.status='pending' AND j.retry_at>? ORDER BY j.retry_at LIMIT 1)
    UNION ALL SELECT min(max(j.retry_at,j.lease_until+1)) FROM memory_jobs j INDEXED BY memory_jobs_pending
      WHERE j.status='leased' AND j.attempts<3 AND (j.retry_at>? OR j.lease_until>=?))`,
  /** The scope to serve among a window's jobs (?2: their rowids as a JSON array of strings, ?3 now): first after the last served
   * (?1), else the lowest; how many are claimable, and how many are blocked (neither claimable nor a live lease: the caller settles them). */
  scope: `WITH ${WINDOW_ROWS("?2", "?3")}
    SELECT min(scope_id) FILTER (WHERE ok AND scope_id>?1) AS after,min(scope_id) FILTER (WHERE ok) AS first,count(*) AS window,
      count(*) FILTER (WHERE ok) AS claimable,count(*) FILTER (WHERE NOT ok AND NOT live) AS blocked FROM r`,
  /** The oldest claimable job of that scope (?2) among the same window (?1), ?3 now. */
  head: `WITH ${WINDOW_ROWS("?1", "?3")} SELECT min(rid) AS rid FROM r WHERE ok AND scope_id=?2`,
  /** Recent-scopes mode while the claim index cannot answer (warming, catching up, over budget): the newest capture job of the
   * listed scopes (?3) among the newest CLAIM_WINDOW (?6) job rowids only, by the primary key, newest first. ?1 ?2 now; ?4 the
   * turn's thread (or NULL) and ?5 its message ids (JSON) that are left out: the turn already holds them. A turn's catch-up is
   * for messages written a moment ago, which are the newest rowids; anything older is the worker's round robin. */
  recentNewest: `WITH n AS MATERIALIZED (SELECT rowid AS rid FROM memory_jobs NOT INDEXED ORDER BY rowid DESC LIMIT ?6)
    SELECT max(j.rowid) AS rid FROM n CROSS JOIN memory_jobs j ON j.rowid=n.rid CROSS JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision
    WHERE ${claimWhere("?1", "?2")} AND j.stage='capture' AND s.scope_id IN (SELECT value FROM json_each(?3))
    AND NOT (?4 IS NOT NULL AND s.thread_id=?4 AND s.message_id IN (SELECT value FROM json_each(?5)))`,
  /** One job by its primary key, if it is claimable (a turn's own capture). */
  byId: `SELECT j.rowid AS rid ${CLAIM_FROM} WHERE ${CLAIM_WHERE} AND j.id=?`,
  row: `SELECT j.*,s.scope_id,s.kind,s.speaker,s.outcome ${CLAIM_FROM} WHERE j.rowid=?`,
  /** The single payload read of a claim: length and first slice, one parse. */
  payload: `WITH t AS MATERIALIZED (SELECT CAST(json_extract(payload,'$.text') AS BLOB) AS b FROM memory_source_versions WHERE source_id=? AND revision=?)
    SELECT length(b) AS total_bytes,substr(b,?,65536) AS bytes FROM t`,
} as const;

/** A claim that cannot read its job: the one job fails, in its own small transaction, and the claim moves on. */
class PoisonedClaim extends Error {
  readonly jobId: string;
  readonly cause: string;
  constructor(jobId: string, cause: string) { super(cause); this.jobId = jobId; this.cause = cause; }
}
/** How many poisoned jobs one claim call steps over before returning (the rest wait for the next tick). */
const POISON_STEP_LIMIT = 8;
export interface ClaimOptions { /** Lock wait before the claim gives up; BUSY means "try later". Default: the background budget. */ busyMs?: number;
  /** Recent-scopes mode only: messages of this thread that are not claimed. */ exclude?: { threadId: string; messageIds: readonly string[] };
  /** Recent-scopes mode only: a newest job older than this is left to the worker (a standing backlog is not a turn's business). */ recentWithinMs?: number;
  /** Claim exactly this job (a primary-key read), if it is claimable: no scope search, no claim-index read. A starting turn's own capture. */ jobId?: string }

export function claimMemoryJob(worker: string, now = Date.now(), recentScopes?: readonly string[], options: ClaimOptions = {}): MemoryWork | null {
  const started = performance.now();
  try {
    // a branch move still being flipped (branch-change.ts) leaves sources on the wrong side: nothing is claimed until it is done
    if (branchChangesMayBePending(database())) return null;
    for (let step = 0; ; step++) {
      try { return claimOnce(worker, now, recentScopes, options.busyMs ?? BACKGROUND_BUSY_MS, options.exclude, options.recentWithinMs, options.jobId); }
      catch (error) {
        if (error instanceof PoisonedClaim && step < POISON_STEP_LIMIT) { failPoisonedJob(error); continue; }
        if (error instanceof PoisonedClaim) { failPoisonedJob(error); return null; }
        // Another connection holds the write lock (DatabaseBusyError): not an error and not an attempt. The caller tries again shortly.
        throw error;
      }
    }
  }
  finally { traceSlowStep("memory.claim", performance.now() - started); }
}
function bigStatement(db: DatabaseSync, sql: string) { const statement = db.prepare(sql); statement.setReadBigInts(true); return statement; }
/** The job could not be read (a resume cursor inside a character, a payload that will not decode): it is failed with
 * its cause so it stops blocking the scope. Permanent: attempts are set to the cap. */
function failPoisonedJob(poison: PoisonedClaim) {
  try {
    transaction(db => { db.prepare("UPDATE memory_jobs SET status='failed',attempts=3,lease_owner=NULL,lease_until=0,error=? WHERE id=? AND status IN ('pending','partial','deferred','leased')").run(jobErrorText(poison.cause), poison.jobId); },
      { op: "claim-poison", busyMs: BACKGROUND_BUSY_MS });
  } catch (error) { if (!isDatabaseBusy(error)) throw error; /* the next claim meets the same job and tries again */ }
  logSwallowed("capture", poison.cause);
}
/** A byte that continues a character (10xxxxxx). */
const isContinuation = (byte: number) => (byte & 0xc0) === 0x80;
/** Decode a slice that may start inside a character and may end inside one. Returns the text, how many leading bytes were
 * dropped (at most 3) and the decoded length in bytes, or null when no alignment decodes. */
export function decodeCaptureSlice(payload: Uint8Array, atEnd: boolean): { text: string; skipped: number; used: number } | null {
  let skipped = 0;
  while (skipped < 3 && skipped < payload.length && isContinuation(payload[skipped])) skipped++;
  if (skipped < payload.length && isContinuation(payload[skipped])) return null;
  const body = payload.subarray(skipped);
  // A slice cut at the 64 KiB boundary may end inside a character: trim up to 3 bytes. The true end of the source may not.
  const trim = atEnd ? 0 : 3;
  for (let end = body.length; end >= Math.max(0, body.length - trim); end--) {
    try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(0, end)), skipped, used: end }; } catch { /* trim one more */ }
  }
  return null;
}
/** The last window pick stopped on its budget with jobs unexamined: "nothing found" is not "nothing there". */
let claimYielded = false;
/** Where a later window of the same claim starts (never kept between claims). */
interface WindowPos { si: number; retryAt: bigint; rowid: bigint }
/** One window: up to CLAIM_WINDOW waiting jobs in index order after `from`, read as at most one bounded page per status.
 * The first window starts at the front of the open range; later ones of the same claim continue by two seeks. */
function readClaimWindow(db: DatabaseSync, now: number, from: WindowPos | null): { rids: bigint[]; last: WindowPos | null; end: boolean } {
  const rids: bigint[] = [];
  let last = from;
  for (let si = from?.si ?? 0; si < CLAIM_STATUSES.length && rids.length < CLAIM_WINDOW; si++) {
    const start = from !== null && from.si === si ? from : null;
    const room = CLAIM_WINDOW - rids.length;
    const page: Array<Record<string, unknown>> = [];
    if (start === null) page.push(...bigStatement(db, MEMORY_CLAIM_SQL.window).all(CLAIM_STATUSES[si], now, room));
    else {
      page.push(...bigStatement(db, MEMORY_CLAIM_SQL.windowTied).all(CLAIM_STATUSES[si], start.retryAt, start.rowid, now, room));
      if (page.length < room) page.push(...bigStatement(db, MEMORY_CLAIM_SQL.windowLater).all(CLAIM_STATUSES[si], start.retryAt, 0n, now, room - page.length));
    }
    for (const row of page) { rids.push(row.rid as bigint); last = { si, retryAt: row.retry_at as bigint, rowid: row.rid as bigint }; }
  }
  return { rids, last, end: rids.length < CLAIM_WINDOW };
}
/** The job to claim, by bounded work, with no position kept between claims: every claim starts at the front of the open
 * range, where (once blocked jobs are closed out) the claimable ones are. A window with blocked jobs in it (a file not yet
 * swept) is closed out on sight, so each blocked job is met once, ever. At most CLAIM_MAX_WINDOWS windows are read; when the
 * budget is spent the worker is woken, so the jobs behind the blocked ones are not left waiting. */
function pickFromWindows(db: DatabaseSync, now: number): bigint | null {
  claimYielded = false;
  let from: WindowPos | null = null;
  for (let used = 0; used < CLAIM_MAX_WINDOWS; used++) {
    const win = readClaimWindow(db, now, from);
    if (win.rids.length > 0) {
      const ids = JSON.stringify(win.rids.map(String));
      const pick = db.prepare(MEMORY_CLAIM_SQL.scope).get(lastScope, ids, now);
      const claimable = Number(pick?.claimable ?? 0);
      // Rows that are neither claimable nor a live lease are blocked for good, and are closed out now (a live lease only waits:
      // it never triggers a settle, or every claim behind the worker's own lease would run one).
      if (Number(pick?.blocked ?? 0) > 0) memoryClaimIndex.dropped(settleRows(db, win.rids, now));
      const scope = pick?.after ?? pick?.first;
      if (claimable > 0 && scope != null) return (bigStatement(db, MEMORY_CLAIM_SQL.head).get(ids, scope, now)?.rid as bigint | null | undefined) ?? null;
    }
    if (win.end) return null;
    // Rows closed out leave the range, but the next window continues after the last row read, so none is read twice.
    from = win.last;
  }
  claimYielded = true;
  notifyMemoryWork();
  return null;
}
function claimOnce(worker: string, now: number, recentScopes: readonly string[] | undefined, busyMs: number, exclude?: ClaimOptions["exclude"], recentWithinMs?: number, onlyJobId?: string): MemoryWork | null {
  // Idle guard: with nothing open this is one indexed probe, not a write transaction. A claim by id is its own probe (the primary key).
  if (onlyJobId === undefined && !database().prepare(MEMORY_CLAIM_SQL.anyOpen).get(now,now)) return null;
  return transaction(db => {
    const meta = db.prepare("SELECT * FROM memory_meta WHERE id=1").get()!;
    if (!["capture","active"].includes(String(meta.mode))) return null;
    if (db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id='memory-roster-policy' AND state='pending'").get()) return null;
    // Rowids are read and bound as BigInt: a rowid past 2^53 does not fit a JS number.
    let rid: bigint | null | undefined;
    if (onlyJobId !== undefined) {
      rid = bigStatement(db,MEMORY_CLAIM_SQL.byId).get(now,now,onlyJobId)?.rid as bigint | undefined;
    } else if (recentScopes) {
      rid = memoryClaimIndex.recent(db, now, recentScopes, exclude?.messageIds.length ? { exclude: { threadId: exclude.threadId, messageIds: new Set(exclude.messageIds) } } : {});
      // Only when the index gave up: a turn's catch-up is for messages written a moment ago, which the index
      // always has (new rows are scanned by rowid); anything older is the worker's.
      if (rid === undefined) {
        const excluded = exclude?.messageIds.length ? exclude : undefined;
        rid = bigStatement(db,MEMORY_CLAIM_SQL.recentNewest).get(now,now,JSON.stringify(recentScopes),excluded?.threadId ?? null,JSON.stringify(excluded?.messageIds ?? []),CLAIM_WINDOW)?.rid as bigint | undefined;
      }
    } else {
      const picked = memoryClaimIndex.next(db, now, lastScope);
      rid = picked?.rid;
      // While the index is still reading the table, null means "not read yet", never "nothing open": the aggregate SQL
      // over every open job is not asked on the server thread; the index wakes the claimer as it files rows.
      if (picked === undefined || (picked === null && !memoryClaimIndex.warming && fallbackDue(db))) {
        rid = pickFromWindows(db, now);
        if (picked === null) {
          // The index missed a claimable job (something reopened it behind its back): rebuild it.
          // An index still reading the table has simply not reached the job yet: nothing was missed, nothing to rebuild.
          if (rid != null) { if (!memoryClaimIndex.warming) memoryClaimIndex.invalidate(); }
          else if (!claimYielded) fallbackAgreed = { stamp: writeStamp(db), at: performance.now() };
        }
      }
    }
    const row = rid == null ? undefined : db.prepare(MEMORY_CLAIM_SQL.row).get(rid);
    if (!row) return null;
    if ((recentScopes || onlyJobId !== undefined) && recentWithinMs !== undefined) {
      const written = db.prepare("SELECT created_at FROM memory_source_versions WHERE source_id=? AND revision=?").get(row.source_id,row.source_revision);
      if (!written || now - Number(written.created_at) > recentWithinMs) return null;
    }
    if(!recentScopes && onlyJobId === undefined)lastScope=String(row.scope_id);
    const jobId = String(row.id);
    try {
      let cursor=Number(row.cursor);
      const slice = db.prepare(MEMORY_CLAIM_SQL.payload).get(row.source_id,row.source_revision,cursor+1)!;
      const totalBytes=Number(slice.total_bytes), payload=slice.bytes as Uint8Array;
      const decoded = payload.length ? decodeCaptureSlice(payload, cursor + payload.length >= totalBytes) : { text: "", skipped: 0, used: 0 };
      if (!decoded || (!decoded.text && cursor + decoded.skipped < totalBytes)) throw new Error("INVALID_SOURCE_UTF8");
      // A resume cursor that landed inside a character moves forward past its tail (at most 3 bytes).
      cursor += decoded.skipped;
      const text = decoded.text;
      const generation=Number(row.lease_generation)+1;
      db.prepare("UPDATE memory_jobs SET status='leased',lease_owner=?,lease_generation=?,lease_until=?,policy_revision=?,deletion_epoch=? WHERE id=?")
        .run(worker,generation,now+30000,meta.policy_revision,meta.deletion_epoch,row.id);
      memoryClaimIndex.leased(rid!, String(row.scope_id), now+30000);
      return {id:jobId,sourceId:String(row.source_id),revision:Number(row.source_revision),leaseGeneration:generation,
        policyRevision:Number(meta.policy_revision),deletionEpoch:Number(meta.deletion_epoch),scopeId:String(row.scope_id),stage:String(row.stage),kind:String(row.kind),speaker:String(row.speaker),outcome:String(row.outcome),cursor,totalBytes,text};
    } catch (error) {
      // The claim transaction rolls back with this throw; the job is failed in its own transaction by the caller.
      // A database error is not the job's fault (full disk, I/O): it propagates and nothing is failed.
      if ((error as { errcode?: unknown }).errcode !== undefined) throw error;
      throw new PoisonedClaim(jobId, error instanceof Error && /^[A-Z_0-9]{4,60}$/.test(error.message) ? error.message : "MEMORY_CLAIM_FAILED");
    }
  }, { op: "claim", busyMs });
}

/** When the fallback last found nothing the index had not: the database write count then, and the time. */
let fallbackAgreed: { stamp: number | undefined; at: number } | null = null;
/** How long an agreeing fallback is trusted while nothing at all has been written. */
const FALLBACK_TRUST_MS = 30_000;
/** The index found nothing: ask SQL only when the database changed since SQL last agreed (or it agreed long ago). */
function fallbackDue(db: DatabaseSync): boolean {
  if (!fallbackAgreed) return true;
  return fallbackAgreed.stamp !== writeStamp(db) || performance.now() - fallbackAgreed.at > FALLBACK_TRUST_MS;
}
/** Test hook and the redrive's: rebuild the ready index at the next claim. */
export function invalidateMemoryClaimIndex() { memoryClaimIndex.invalidate(); fallbackAgreed = null; }
/** File a job the claim may take again, by its current state (after the write that changed it committed). */
/** The index finished a background step (a build or a catch-up): the claimer has rows it did not have. */
memoryClaimIndex.onProgress(() => notifyMemoryWork());
function hintClaimIndex(jobId: string) { try { memoryClaimIndex.hint(database(), jobId); } catch { /* the fallback finds it */ } }

/** A publication refused because the authority moved under the lease: the
 * source revision, the policy revision or the deletion epoch changed while
 * the worker held the job (STALE_MEMORY_SOURCE), or the lease itself is no
 * longer the holder's (STALE_MEMORY_LEASE). The work is discarded either way;
 * what differs is what happens to the job next. */
export function isStaleMemoryPublication(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === "STALE_MEMORY_SOURCE" || message === "STALE_MEMORY_LEASE";
}

/** Return a job whose publication was refused as stale to `pending` at once,
 * so the next claim runs it under the current authority. Attempts are not
 * counted: the worker did not fail, the authority moved. Only the holder's
 * own live lease is released; a lease another worker took over (a newer
 * generation) and a job cancelled by a newer source revision are untouched,
 * and the next claim's generation still fences the old holder's late output.
 * The current authority can claim the released job immediately (RED2J). */
export function requeueStaleMemoryWork(work: MemoryWork, worker: string): boolean {
  const requeued = Boolean(database().prepare("UPDATE memory_jobs SET status='pending',lease_owner=NULL,lease_until=0 WHERE id=? AND lease_owner=? AND lease_generation=? AND status='leased'").run(work.id,worker,work.leaseGeneration).changes);
  if (requeued) hintClaimIndex(work.id);
  return requeued;
}

/** Up to five stale requeues preserve the attempt count (RED2K). Further
 * authority changes use ordinary deferral and its three-attempt cap. The
 * controller tracks each job and source revision until publication or
 * deferral settles that lease cycle (RED2L). */
export const STALE_MEMORY_REQUEUE_LIMIT = 5;

/** Defer a job whose publication was refused as stale, spending one attempt
 * exactly as publishMemoryWork does for a worker's own deferral (retry in 5 s
 * on the first attempt, 30 s after; `failed` at the attempt cap). The source
 * and policy fence is what refused the publication, so this bypasses only
 * that; the lease fence is the same as requeueStaleMemoryWork: only the
 * holder's own live lease, never one another worker took over or a job a
 * newer source revision cancelled. */
export function deferStaleMemoryWork(work: MemoryWork, worker: string, reason: string, now=Date.now()): boolean {
  const deferred = Boolean(database().prepare(`UPDATE memory_jobs SET status=CASE WHEN attempts+1>=3 THEN 'failed' ELSE 'deferred' END,
    attempts=attempts+1,retry_at=?+CASE WHEN attempts=0 THEN 5000 ELSE 30000 END,lease_owner=NULL,lease_until=0,error=?
    WHERE id=? AND lease_owner=? AND lease_generation=? AND status='leased'`).run(now,jobErrorText(reason),work.id,worker,work.leaseGeneration).changes);
  if (deferred) hintClaimIndex(work.id);
  return deferred;
}

/** Renew the holder's lease. The fence is the lease generation, not the clock (A11, 1.0.2): a beat that comes late
 * because the server's loop was busy (a long synchronous step, a held write lock) still renews a lease nobody took
 * over, since taking over always moves the generation (claimOnce, a restore, a park). Before, a lease that ran out
 * under a stalled loop failed its next beat and its publication (STALE_MEMORY_LEASE), and the work was thrown away
 * and requeued although no one else had touched the job. */
export function heartbeatMemoryJob(work: MemoryWork, worker: string, now=Date.now()) {
  return Boolean(database().prepare("UPDATE memory_jobs SET lease_until=max(lease_until,?) WHERE id=? AND lease_owner=? AND lease_generation=? AND status='leased'").run(now+30000,work.id,worker,work.leaseGeneration).changes);
}

/** Causes that say nothing about the job: the worker was stopped, the database or the helper was busy, a timeout.
 * Such a failure reschedules the job without spending one of its three attempts (PROPOSAL-v2 10.4). */
export const TRANSIENT_JOB_REASONS: ReadonlySet<string> = new Set([
  "MEMORY_WORKER_STOPPED", "MEMORY_WORKER_TIMEOUT", "MEMORY_WORKER_BUSY", "MEMORY_DATABASE_BUSY", "MEMORY_WORKER_EXITED_RESTART",
  "extractor-busy", "daily-allowance", "budget-exhausted", "spend-ceiling",
]);
/** A job that keeps failing for a transient cause is not retried for free forever: after this many free reschedules it spends attempts. */
export const TRANSIENT_FREE_LIMIT = 20;
const ERROR_SHAPE = /^(redriven:)?(?:transient:(\d+):)?(.*)$/s;
export function parseJobError(error: unknown): { redriven: boolean; transient: number; reason: string } {
  const match = ERROR_SHAPE.exec(String(error ?? ""));
  return { redriven: Boolean(match?.[1]), transient: Number(match?.[2] ?? 0), reason: match?.[3] ?? "" };
}
function transientBackoffMs(count: number) { return Math.min(160_000, 5_000 * 2 ** Math.min(count, 5)); }

export interface PublishOptions { /** Lock wait before BUSY. Omitted: the handle's usual wait. */ busyMs?: number }
export function publishMemoryWork(work: MemoryWork, worker: string, input: MemoryWorkResult, now=Date.now(), options: PublishOptions = {}) {
  const result=resultSchema.parse(input);
  transaction(db => {
    const job=db.prepare("SELECT * FROM memory_jobs WHERE id=?").get(work.id), meta=db.prepare("SELECT * FROM memory_meta WHERE id=1").get()!;
    const source=db.prepare("SELECT revision,state FROM memory_sources WHERE id=?").get(work.sourceId);
    // Fenced by owner and generation (see heartbeatMemoryJob): a lease that ran out while nobody took it over is still the holder's.
    if (!job || job.status!=="leased" || job.lease_owner!==worker || job.lease_generation!==work.leaseGeneration || result.id!==work.id || result.leaseGeneration!==work.leaseGeneration) throw new Error("STALE_MEMORY_LEASE");
    if (!source || source.revision!==work.revision || source.state!=="active" || meta.policy_revision!==work.policyRevision || meta.deletion_epoch!==work.deletionEpoch) throw new Error("STALE_MEMORY_SOURCE");
    if (result.status==="deferred" || result.status==="failed") {
      if(result.chunks.length || result.nextCursor!==work.cursor) throw new Error("INVALID_FAILURE_COVERAGE");
      const reason=result.reason??"worker-failed", prior=parseJobError(job.error), keep=prior.redriven?"redriven:":"";
      if(TRANSIENT_JOB_REASONS.has(reason) && prior.transient<TRANSIENT_FREE_LIMIT) {
        db.prepare("UPDATE memory_jobs SET status='deferred',retry_at=?,lease_owner=NULL,lease_until=0,error=? WHERE id=?")
          .run(now+transientBackoffMs(prior.transient),jobErrorText(`${keep}transient:${prior.transient+1}:${reason}`),work.id);return;
      }
      const attempts=Number(job.attempts)+1;
      db.prepare("UPDATE memory_jobs SET status=?,attempts=?,retry_at=?,lease_owner=NULL,lease_until=0,error=? WHERE id=?")
        .run(attempts>=3?"failed":"deferred",attempts,now+(attempts===1?5000:30000),jobErrorText(`${keep}${reason}`),work.id);return;
    }
    const expectedEnd=work.cursor+Buffer.byteLength(work.text);
    if(result.nextCursor!==expectedEnd || (result.status==="complete")!==(expectedEnd===work.totalBytes)) throw new Error("INCOMPLETE_MEMORY_SOURCE");
    let cursor=work.cursor;
    for (const chunk of result.chunks) {
      if (chunk.startByte!==cursor || chunk.endByte!==cursor+Buffer.byteLength(chunk.text) || chunk.text!==Buffer.from(work.text).subarray(cursor-work.cursor,chunk.endByte-work.cursor).toString("utf8")) throw new Error("INVALID_MEMORY_CHUNK");
      cursor=chunk.endByte;
      const id=createHash("sha256").update(`${work.sourceId}:${work.revision}:${chunk.startByte}:${chunk.endByte}`).digest("hex");
      const assertion=work.speaker==="owner"?"owner-statement":work.speaker==="tool"?"tool-observation":"assistant-inference";
      db.prepare("INSERT OR IGNORE INTO memory_records VALUES(?,1,?,'source',?,?,'active',0,?,NULL,NULL,?)").run(id,work.scopeId,chunk.text,assertion,now,now);
      db.prepare("INSERT OR IGNORE INTO memory_evidence VALUES(?,1,?,?,?,?)").run(id,work.sourceId,work.revision,chunk.startByte,chunk.endByte);
      inheritEdge(db,{kind:"record",id,version:1},{kind:"source",id:work.sourceId});
      db.prepare("INSERT OR IGNORE INTO memory_projection_receipts VALUES(?,1,1,'pending','pending',NULL)").run(id);
    }
    if (work.kind!=="turn" && cursor!==expectedEnd) throw new Error("INCOMPLETE_MEMORY_COVERAGE");
    if(result.chunks.length)db.exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1");
    db.prepare("UPDATE memory_jobs SET status=?,cursor=?,coverage=?,lease_owner=NULL,lease_until=0,error=NULL WHERE id=?")
      .run(result.status,result.nextCursor,JSON.stringify({throughByte:result.nextCursor,totalBytes:work.totalBytes}),work.id);
    if(result.status==="complete")recordMemoryProcessing(now);
  }, options.busyMs===undefined?{}:{ op: "publish", busyMs: options.busyMs });
  // A partial job is claimable again at once, a deferral when its retry comes due.
  if (result.status !== "complete") hintClaimIndex(work.id);
}

/** Failed jobs the cause of which says nothing about the conversation (the helper died, timed out, the database was busy).
 * At the next start each is given its three attempts back, once: `redriven:` stays on the row so a second failure is final. */
const REDRIVABLE = ["MEMORY_WORKER_EXITED","MEMORY_WORKER_TIMEOUT","MEMORY_WORKER_STOPPED","MEMORY_RESULT_REJECTED","MEMORY_STALE_REQUEUE_LIMIT","MEMORY_DATABASE_BUSY","MEMORY_WORKER_BUSY"];
export const REDRIVE_LIMIT = 1000;
const REDRIVE_STATE = "(SELECT s.state FROM memory_sources s WHERE s.id=memory_jobs.source_id AND s.revision=memory_jobs.source_revision)";
/** ?1 now, ?2 the causes (JSON), ?3 limit. A job whose source is claimable goes back to `pending`; one whose source is retired
 * (a branch the owner left) is parked with the same restorable marker (claim-settle.ts PARK_SET, prior status `pending`, error
 * `redriven:<cause>`), so selecting the branch again reopens it already redriven. A job of a deleted conversation or scope, of a
 * tombstoned, deleted or superseded source, of a working turn or a failed tool stays `failed`: never revived (whatever the start
 * order of the worker and the revocation runner). */
export const REDRIVE_SQL = `UPDATE memory_jobs SET
    status=CASE WHEN ${REDRIVE_STATE}='retired' THEN 'cancelled' ELSE 'pending' END,
    error=CASE WHEN ${REDRIVE_STATE}='retired' THEN 'parked:v1:'||json_object('s','pending','e','redriven:'||coalesce(error,'')) ELSE 'redriven:'||coalesce(error,'') END,
    lease_generation=lease_generation+1,attempts=0,retry_at=?1,lease_owner=NULL,lease_until=0
  WHERE id IN (SELECT id FROM memory_jobs WHERE status='failed' AND error IS NOT NULL AND error NOT LIKE 'redriven:%' AND error IN (SELECT value FROM json_each(?2))
    AND EXISTS (SELECT 1 FROM memory_sources s WHERE s.id=memory_jobs.source_id AND s.revision=memory_jobs.source_revision
      AND s.state IN ('active','retired') AND s.outcome!='working' AND NOT (s.kind IN ('tool-outcome','activity') AND s.outcome='failed')
      AND NOT ${DENIED_PLACE("s")} AND NOT ${TOMBSTONED("s")}) LIMIT ?3)`;
export function redriveTransientFailedJobs(limit = REDRIVE_LIMIT, now = Date.now()): number {
  const list = JSON.stringify(REDRIVABLE);
  invalidateMemoryClaimIndex();
  return transaction(db => Number(db.prepare(REDRIVE_SQL).run(now,list,Math.max(0,Math.floor(limit))).changes), { op: "redrive", busyMs: BACKGROUND_BUSY_MS });
}

/** How many failed jobs there are, by plain cause, for the Details line "N messages could not be learned from". */
export function failedMemoryJobsByCause(): Array<{ cause: "unreadable" | "helper-stopped" | "timeout" | "other"; count: number }> {
  const rows = database().prepare("SELECT error,count(*) AS n FROM memory_jobs WHERE status='failed' GROUP BY error").all();
  const totals = new Map<string, number>();
  for (const row of rows) {
    const reason = parseJobError(row.error).reason;
    const cause = /UTF8|CLAIM|COVERAGE|CHUNK/.test(reason) ? "unreadable" : /EXITED|STOPPED/.test(reason) ? "helper-stopped" : /TIMEOUT/.test(reason) ? "timeout" : "other";
    totals.set(cause, (totals.get(cause) ?? 0) + Number(row.n));
  }
  return [...totals].map(([cause, count]) => ({ cause: cause as "unreadable" | "helper-stopped" | "timeout" | "other", count }));
}
