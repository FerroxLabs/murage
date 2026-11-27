// Debt producer owner: recall-fix-j. Recovery/status consumer owner: recall-prod-x.
// One marker per thread (memv2 E3: threadDebtMarker, oweThreadCheckpoint, moveSourceDebt): lane E, with capture.ts and consolidate.ts.
import type { DatabaseSync } from 'node:sqlite';
import { threadCheckpointId } from './checkpoints.ts';

/** Bound the index walk before reading any marker payload or source. */
export function checkpointDebtCount(db:DatabaseSync,limit=1):number {
  return Number(db.prepare("SELECT count(*) AS n FROM (SELECT 1 FROM memory_scope_bindings INDEXED BY memory_bindings_subject WHERE subject_type='system' AND subject_id='checkpoint-pending' LIMIT ?)").get(limit)?.n??0);
}

/** memv2 E3: a thread's checkpoint debt is ONE marker. Its id stays `checkpoint-debt:<job>` (a real complete job of the thread, so an older
 * build that meets it rolls that job as before) and its intent adds `threadId` and `from`, the job rowid the debt starts at. The roll
 * (consolidate.ts) covers every completed job of the thread from `from` on, so a later job of the thread adds no row of its own. */
type Marker={id:string;jobId:string;from:number;intent:Record<string,unknown>};
/** The debt markers of one thread in one scope, as `FROM ... WHERE ...` text (binds: scope, thread, thread, thread) over b (the marker),
 * j (its job) and s (that job's source). The thread is chosen BEFORE any limit (ASTRA memv2-E 8d5a955d63: a limit over the whole queue
 * first missed a thread whose marker sat past it, so its next job wrote a second marker and its roll missed the earlier range). The walk is
 * the debt index: a marker naming another thread (intent.threadId) is passed by its own row, with no join; only an older build's per-job
 * row, which names no thread, is joined to its job's source to learn it. CROSS JOIN keeps the marker the outer loop. */
export const THREAD_MARKERS=`FROM memory_scope_bindings b INDEXED BY memory_bindings_subject CROSS JOIN memory_jobs j CROSS JOIN memory_sources s
    WHERE b.subject_type='system' AND b.subject_id='checkpoint-pending' AND b.state='granted' AND b.scope_id=? AND substr(b.id,1,16)='checkpoint-debt:'
    AND coalesce(CASE WHEN octet_length(b.intent)<=4096 AND json_valid(b.intent) THEN json_extract(b.intent,'$.threadId') END,?)=?
    AND j.id=substr(b.id,17) AND s.id=j.source_id AND s.scope_id=b.scope_id AND s.thread_id=?`;
/** The thread's own debt marker in this scope (the lowest job first), a per-job row from an older build included: only one whose job can
 * still roll (complete, its source current, active and not forgotten) and that names that job, source and revision (the debt driver
 * refuses any other at every pass, MEMORY_CHECKPOINT_DEBT_INVALID: taken as the thread's, it would hold the thread's later jobs; the
 * thread's next job writes a marker that can roll, and that roll deletes the refused one with the thread's other markers). A row whose job cannot is refused by the debt driver at every
 * pass (an older build's, or one whose source left without capture seeing it): taken as the thread's, it would hold every later job. */
export function threadDebtMarker(db:DatabaseSync,scopeId:string,threadId:string):Marker|undefined {
  const row=db.prepare(`SELECT b.id,b.intent,j.rowid AS at ${THREAD_MARKERS}
    AND j.stage='capture' AND j.status='complete' AND s.revision=j.source_revision AND s.state='active' AND json_extract(j.coverage,'$.totalBytes')=j.cursor
    AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.target_type='source' AND t.target_id=s.id AND (t.revision IS NULL OR t.revision=s.revision))
    AND json_extract(b.intent,'$.jobId')=j.id AND json_extract(b.intent,'$.sourceId')=s.id AND json_extract(b.intent,'$.revision')=s.revision
    ORDER BY j.rowid LIMIT 1`).get(scopeId,threadId,threadId,threadId);
  if(!row)return undefined;
  const intent=JSON.parse(String(row.intent)) as Record<string,unknown>,at=Number(row.at);
  return {id:String(row.id),jobId:String(row.id).slice(16),from:Number.isSafeInteger(intent.from)?Math.min(Number(intent.from),at):at,intent};
}
/** Whether a job still owes its thread's checkpoint: through a marker of its own, or (E3) through its thread's marker, whose range reaches it,
 * with no publication of it to the thread's notes yet (FABLE memv2-E 8d5a955d63 M3: a check of the job's own marker alone read a job its
 * thread's marker covers as settled). */
export function jobOwesCheckpoint(db:DatabaseSync,jobId:string):boolean {
  if(db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id=? AND subject_id='checkpoint-pending'").get('checkpoint-debt:'+jobId))return true;
  const own=db.prepare('SELECT j.rowid AS at,s.scope_id,s.thread_id FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE j.id=?').get(jobId);
  if(typeof own?.thread_id!=='string'||typeof own.scope_id!=='string')return false;
  const marker=threadDebtMarker(db,own.scope_id,own.thread_id);
  return Boolean(marker&&marker.from<=Number(own.at)&&!db.prepare('SELECT 1 FROM memory_checkpoint_publications WHERE family_id=? AND job_id=?').get(threadCheckpointId(own.scope_id,own.thread_id),jobId));
}
/** A complete capture job owes its thread's checkpoint (capture's born-complete jobs, a helper's publish). Caller owns the transaction. */
export function oweThreadCheckpoint(db:DatabaseSync,job:{jobId:string;sourceId:string;revision:number;scopeId:string}){
  const own=db.prepare('SELECT j.rowid AS at,s.thread_id,s.kind FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE j.id=?').get(job.jobId);
  const threadId=typeof own?.thread_id==='string'?own.thread_id:undefined,at=Number(own?.at);
  const marker=threadId===undefined?undefined:threadDebtMarker(db,job.scopeId,threadId);
  if(marker){
    // already owed from an earlier job: the thread's roll covers this one; a job older than the debt's start moves the start back
    if(at<marker.from)db.prepare("UPDATE memory_scope_bindings SET intent=json_set(intent,'$.from',?,'$.threadId',?) WHERE id=?").run(at,threadId!,marker.id);
    return;
  }
  db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','checkpoint-pending',0,'granted',?)")
    .run('checkpoint-debt:'+job.jobId,job.scopeId,JSON.stringify({jobId:job.jobId,sourceId:job.sourceId,revision:job.revision,...threadId===undefined?{}:{threadId,from:Math.min(at,headStart(db,job.scopeId,threadId,at,own?.kind==='turn'))}}));
}
/** Past this many jobs (any thread's) between the notes' newest quoted job and a new debt, the debt's start is looked up in the jobs just
 * before it (consolidate.ts BOUNDED_RANGE: the serving thread's bounded roll waits whole past the same count). */
const DEBT_START_RANGE=4096;
/** "Since the head" (design 4.1 E3): the job of the newest source the thread's current notes quote (at most four, each found by its key).
 * With no notes record (FABLE memv2-E 8d5a955d63 M4, r5 D11: jobs an older build left owing without a marker were never covered), or notes
 * whose newest quoted job is more than DEBT_START_RANGE jobs behind (FABLE M2: a thread whose later jobs are never quoted re-walked that
 * range at every roll and its bounded roll always waited), the debt starts at the oldest job of the thread in the DEBT_START_RANGE jobs
 * before this one that could still be quoted and is not yet published: one bounded walk of the jobs b-tree, at a debt's start only.
 * A turn row (never quoted), a forgotten or retired source and a job not wholly covered cannot hold the start back; nor can anything
 * older than the window, so the walk and every roll after it stay bounded whatever the thread's history (r5 started such a debt at the
 * new job itself). */
function headStart(db:DatabaseSync,scopeId:string,threadId:string,at:number,turnRow=false):number {
  const family=threadCheckpointId(scopeId,threadId);
  const row=db.prepare(`SELECT max(j.rowid) AS at FROM memory_checkpoint_heads h JOIN memory_evidence e ON e.record_id=h.record_id AND e.record_version=h.record_version
    JOIN memory_jobs j ON j.source_id=e.source_id AND j.source_revision=e.source_revision AND j.stage='capture' AND j.stage_version='1'
    WHERE h.family_id=?`).get(family);
  const quoted=Number.isSafeInteger(row?.at)?Number(row!.at):undefined;
  if(quoted!==undefined&&at-quoted<=DEBT_START_RANGE)return quoted;
  // a turn row's debt on a thread already rolled to no notes (its head row has no record): that roll settled what came before, so the
  // window is not walked again at every turn of a thread that only ever has turn rows (Opus fix-check M2); a quotable job's debt still walks
  if(quoted===undefined&&turnRow&&db.prepare('SELECT 1 FROM memory_checkpoint_heads WHERE family_id=? AND record_id IS NULL').get(family))return Infinity;
  const first=db.prepare(`SELECT j.rowid AS at FROM memory_jobs j CROSS JOIN memory_sources s
    WHERE j.rowid>=? AND j.rowid<? AND s.id=j.source_id AND s.revision=j.source_revision AND s.thread_id=? AND s.scope_id=? AND s.state='active' AND s.kind<>'turn'
    AND j.stage='capture' AND j.status='complete' AND json_extract(j.coverage,'$.totalBytes')=j.cursor
    AND NOT EXISTS(SELECT 1 FROM memory_checkpoint_publications p WHERE p.family_id=? AND p.job_id=j.id)
    AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.target_type='source' AND t.target_id=s.id AND (t.revision IS NULL OR t.revision=s.revision))
    ORDER BY j.rowid LIMIT 1`).get(Math.max(quoted??0,at-DEBT_START_RANGE),at,threadId,scopeId,family);
  return Number.isSafeInteger(first?.at)?Number(first!.at):Infinity;
}
/** A source revised or leaving the branch takes its jobs' debt markers with it (their roll can never run: the source moved on). A thread
 * marker among them is handed to the next owed job of the thread, with the same start, so the thread's other owed jobs keep it: one
 * that can roll (its capture covered all its words: a failed or name-only tool's born-complete job never can, consolidate.ts). */
export function moveSourceDebt(db:DatabaseSync,sourceId:string){
  const rows=db.prepare(`SELECT b.id,b.scope_id,b.intent,j.rowid AS at,s.thread_id FROM memory_jobs j JOIN memory_scope_bindings b ON b.id='checkpoint-debt:'||j.id
    JOIN memory_sources s ON s.id=j.source_id WHERE j.source_id=? AND j.stage='capture' AND b.subject_type='system' AND b.subject_id='checkpoint-pending'`).all(sourceId);
  for(const row of rows){
    db.prepare('DELETE FROM memory_scope_bindings WHERE id=?').run(row.id);
    if(row.thread_id===null)continue;
    const intent=JSON.parse(String(row.intent)) as Record<string,unknown>,from=Number.isSafeInteger(intent.from)?Math.min(Number(intent.from),Number(row.at)):Number(row.at);
    const next=db.prepare(`SELECT j.id,j.source_id,j.source_revision FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision
      AND s.state='active' AND s.scope_id=? AND s.thread_id=? WHERE j.rowid>=? AND j.stage='capture' AND j.status='complete' AND j.source_id<>?
      AND json_extract(j.coverage,'$.totalBytes')=j.cursor
      AND NOT EXISTS(SELECT 1 FROM memory_checkpoint_publications p WHERE p.family_id=? AND p.job_id=j.id)
      AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.target_type='source' AND t.target_id=s.id AND (t.revision IS NULL OR t.revision=s.revision)) ORDER BY j.rowid LIMIT 1`)
      .get(row.scope_id,row.thread_id,from,sourceId,threadCheckpointId(String(row.scope_id),String(row.thread_id)));
    if(next)db.prepare("INSERT OR IGNORE INTO memory_scope_bindings VALUES(?,?,'system','checkpoint-pending',0,'granted',?)")
      .run('checkpoint-debt:'+next.id,row.scope_id,JSON.stringify({jobId:next.id,sourceId:next.source_id,revision:next.source_revision,threadId:row.thread_id,from}));
  }
}
