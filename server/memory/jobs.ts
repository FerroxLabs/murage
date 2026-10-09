import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { BACKGROUND_BUSY_MS, database, isDatabaseBusy, transaction } from "../database.ts";
import { resultSchema, type MemoryWork, type MemoryWorkResult } from "./worker-protocol.ts";
import { recordMemoryProcessing } from "./health.ts";
import { logSwallowed } from "./worker-log.ts";
import { traceSlowStep } from "./claim-trace.ts";
import { jobErrorText } from "./park.ts";

let lastScope = "";
const workListeners=new Set<()=>void>();
export function notifyMemoryWork(){for(const listener of workListeners)listener();}
export function onMemoryWork(listener:()=>void){workListeners.add(listener);return ()=>{workListeners.delete(listener);};}

/** Use the queue index before starting a helper or opening a claim transaction. */
export function hasClaimableMemoryJob(now=Date.now()):boolean {
  const db=database();
  if(db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id='memory-roster-policy' AND state='pending'").get())return false;
  return Boolean(db.prepare(`SELECT 1 FROM memory_jobs j
    JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision
    JOIN memory_source_versions v ON v.source_id=j.source_id AND v.revision=j.source_revision
    WHERE j.status IN ('pending','partial','deferred','leased') AND j.attempts<3 AND j.retry_at<=?
    AND (j.status!='leased' OR j.lease_until<?) AND s.state='active' AND s.outcome!='working'
    AND NOT (s.kind IN ('tool-outcome','activity') AND s.outcome='failed') LIMIT 1`).get(now,now));
}

/** Future retries and expiring leases keep their due time between notifications. */
export function nextMemoryJobDelay(now=Date.now()):number|undefined {
  const row=database().prepare(`SELECT MIN(CASE WHEN j.status='leased' THEN MAX(j.retry_at,j.lease_until+1) ELSE j.retry_at END) AS due
    FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision
    WHERE j.status IN ('pending','partial','deferred','leased') AND j.attempts<3
    AND (j.retry_at>? OR (j.status='leased' AND j.lease_until>=?))
    AND s.state='active' AND s.outcome!='working' AND NOT (s.kind IN ('tool-outcome','activity') AND s.outcome='failed')`).get(now,now);
  return row?.due==null?undefined:Math.max(1,Number(row.due)-now);
}
/** Test hook: forget which scope was served last (the round-robin restarts). */
export function resetMemoryClaimCursor() { lastScope = ""; }

/* The claim chooses a job WITHOUT touching memory_source_versions.payload (the
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
const CLAIM_WHERE = `s.state='active' AND s.outcome!='working' AND NOT (s.kind IN ('tool-outcome','activity') AND s.outcome='failed') AND j.attempts<3 AND j.retry_at<=?
  AND j.status IN ('pending','partial','deferred','leased') AND (j.status!='leased' OR j.lease_until<?)`;
export const MEMORY_CLAIM_SQL = {
  /** Idle guard: is any job open at all? Index only, no join, no write lock. */
  anyOpen: `SELECT 1 FROM memory_jobs j WHERE j.attempts<3 AND j.retry_at<=? AND j.status IN ('pending','partial','deferred','leased') AND (j.status!='leased' OR j.lease_until<?) LIMIT 1`,
  /** The scope to serve: first after the last served, else the lowest. */
  scope: `SELECT min(s.scope_id) FILTER (WHERE s.scope_id>?) AS after,min(s.scope_id) AS first ${CLAIM_FROM} WHERE ${CLAIM_WHERE}`,
  /** The oldest claimable job of that scope. */
  head: `SELECT min(j.rowid) AS rid ${CLAIM_FROM} WHERE ${CLAIM_WHERE} AND s.scope_id=?`,
  /** Recent-scopes mode: newest capture job of the listed scopes. */
  recent: `SELECT max(j.rowid) AS rid ${CLAIM_FROM} WHERE ${CLAIM_WHERE} AND j.stage='capture' AND s.scope_id IN (SELECT value FROM json_each(?))`,
  /** The same, leaving out the messages a turn already holds (its own prompt): they need no catching up for that turn. */
  recentExcluding: `SELECT max(j.rowid) AS rid ${CLAIM_FROM} WHERE ${CLAIM_WHERE} AND j.stage='capture' AND s.scope_id IN (SELECT value FROM json_each(?))
    AND NOT (s.thread_id=? AND s.message_id IN (SELECT value FROM json_each(?)))`,
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
  /** Recent-scopes mode only: a newest job older than this is left to the worker (a standing backlog is not a turn's business). */ recentWithinMs?: number }

export function claimMemoryJob(worker: string, now = Date.now(), recentScopes?: readonly string[], options: ClaimOptions = {}): MemoryWork | null {
  const started = performance.now();
  try {
    for (let step = 0; ; step++) {
      try { return claimOnce(worker, now, recentScopes, options.busyMs ?? BACKGROUND_BUSY_MS, options.exclude, options.recentWithinMs); }
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
function claimOnce(worker: string, now: number, recentScopes: readonly string[] | undefined, busyMs: number, exclude?: ClaimOptions["exclude"], recentWithinMs?: number): MemoryWork | null {
  // Idle guard: with nothing open this is one indexed probe, not a write transaction.
  if (!database().prepare(MEMORY_CLAIM_SQL.anyOpen).get(now,now)) return null;
  return transaction(db => {
    const meta = db.prepare("SELECT * FROM memory_meta WHERE id=1").get()!;
    if (!["capture","active"].includes(String(meta.mode))) return null;
    if (db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id='memory-roster-policy' AND state='pending'").get()) return null;
    // Rowids are read and bound as BigInt: a rowid past 2^53 does not fit a JS number.
    let rid: bigint | null | undefined;
    if (recentScopes && exclude?.messageIds.length) rid = bigStatement(db,MEMORY_CLAIM_SQL.recentExcluding).get(now,now,JSON.stringify(recentScopes),exclude.threadId,JSON.stringify(exclude.messageIds))?.rid as bigint | undefined;
    else if (recentScopes) rid = bigStatement(db,MEMORY_CLAIM_SQL.recent).get(now,now,JSON.stringify(recentScopes))?.rid as bigint | undefined;
    else {
      const pick = db.prepare(MEMORY_CLAIM_SQL.scope).get(lastScope,now,now);
      const scope = pick?.after ?? pick?.first;
      if (scope == null) return null;
      rid = bigStatement(db,MEMORY_CLAIM_SQL.head).get(now,now,scope)?.rid as bigint | null | undefined;
    }
    const row = rid == null ? undefined : db.prepare(MEMORY_CLAIM_SQL.row).get(rid);
    if (!row) return null;
    if (recentScopes && recentWithinMs !== undefined) {
      const written = db.prepare("SELECT created_at FROM memory_source_versions WHERE source_id=? AND revision=?").get(row.source_id,row.source_revision);
      if (!written || now - Number(written.created_at) > recentWithinMs) return null;
    }
    if(!recentScopes)lastScope=String(row.scope_id);
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
  return Boolean(database().prepare("UPDATE memory_jobs SET status='pending',lease_owner=NULL,lease_until=0 WHERE id=? AND lease_owner=? AND lease_generation=? AND status='leased'").run(work.id,worker,work.leaseGeneration).changes);
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
  return Boolean(database().prepare(`UPDATE memory_jobs SET status=CASE WHEN attempts+1>=3 THEN 'failed' ELSE 'deferred' END,
    attempts=attempts+1,retry_at=?+CASE WHEN attempts=0 THEN 5000 ELSE 30000 END,lease_owner=NULL,lease_until=0,error=?
    WHERE id=? AND lease_owner=? AND lease_generation=? AND status='leased'`).run(now,jobErrorText(reason),work.id,worker,work.leaseGeneration).changes);
}

export function heartbeatMemoryJob(work: MemoryWork, worker: string, now=Date.now()) {
  return Boolean(database().prepare("UPDATE memory_jobs SET lease_until=? WHERE id=? AND lease_owner=? AND lease_generation=? AND status='leased' AND lease_until>=?").run(now+30000,work.id,worker,work.leaseGeneration,now).changes);
}

/** Causes that say nothing about the job: the worker was stopped, the database or the helper was busy, a timeout.
 * Such a failure reschedules the job without spending one of its three attempts (PROPOSAL-v2 10.4). */
export const TRANSIENT_JOB_REASONS: ReadonlySet<string> = new Set([
  "MEMORY_WORKER_STOPPED", "MEMORY_WORKER_TIMEOUT", "MEMORY_WORKER_BUSY", "MEMORY_DATABASE_BUSY", "MEMORY_WORKER_EXITED_RESTART",
  "extractor-busy", "daily-allowance", "budget-exhausted",
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
    if (!job || job.status!=="leased" || job.lease_owner!==worker || job.lease_generation!==work.leaseGeneration || Number(job.lease_until)<now || result.id!==work.id || result.leaseGeneration!==work.leaseGeneration) throw new Error("STALE_MEMORY_LEASE");
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
      db.prepare("INSERT OR IGNORE INTO memory_projection_receipts VALUES(?,1,1,'pending','pending',NULL)").run(id);
    }
    if (work.kind!=="turn" && cursor!==expectedEnd) throw new Error("INCOMPLETE_MEMORY_COVERAGE");
    if(result.chunks.length)db.exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1");
    db.prepare("UPDATE memory_jobs SET status=?,cursor=?,coverage=?,lease_owner=NULL,lease_until=0,error=NULL WHERE id=?")
      .run(result.status,result.nextCursor,JSON.stringify({throughByte:result.nextCursor,totalBytes:work.totalBytes}),work.id);
    if(result.status==="complete")recordMemoryProcessing(now);
  }, options.busyMs===undefined?{}:{ op: "publish", busyMs: options.busyMs });
}

/** Failed jobs the cause of which says nothing about the conversation (the helper died, timed out, the database was busy).
 * At the next start each is given its three attempts back, once: `redriven:` stays on the row so a second failure is final. */
const REDRIVABLE = ["MEMORY_WORKER_EXITED","MEMORY_WORKER_TIMEOUT","MEMORY_WORKER_STOPPED","MEMORY_RESULT_REJECTED","MEMORY_STALE_REQUEUE_LIMIT","MEMORY_DATABASE_BUSY","MEMORY_WORKER_BUSY"];
export const REDRIVE_LIMIT = 1000;
export function redriveTransientFailedJobs(limit = REDRIVE_LIMIT, now = Date.now()): number {
  const list = JSON.stringify(REDRIVABLE);
  return transaction(db => Number(db.prepare(`UPDATE memory_jobs SET status='pending',attempts=0,retry_at=?,lease_owner=NULL,lease_until=0,error='redriven:'||coalesce(error,'')
    WHERE id IN (SELECT id FROM memory_jobs WHERE status='failed' AND error IS NOT NULL AND error NOT LIKE 'redriven:%' AND error IN (SELECT value FROM json_each(?)) LIMIT ?)`)
    .run(now,list,Math.max(0,Math.floor(limit))).changes), { op: "redrive", busyMs: BACKGROUND_BUSY_MS });
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
