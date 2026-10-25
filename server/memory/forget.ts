import { randomUUID } from "node:crypto";
import { holdForgottenSources } from "../turn-source-holds.ts";
import { database, transaction } from "../database.ts";
import { requireMemoryOwner } from "./authority.ts";
import { applyForgetTombstones } from "./restore.ts";
import { forgottenMessages, setForgottenMessagesHook, supportingTombstones, wakeMemoryRevocation, type ForgottenMessagesHook, type RevocationJob } from "./memory-revocation.ts";
import { notifyMemoryWork } from "./jobs.ts";
import { commitRevoke } from "./revoke-commit.ts";
import { holdRevoke } from "./revoke-marker.ts";

/** Told, inside the forget's own transaction (or the job step that ends more of its sources), which messages the forgotten
 * material came from: derived project text citing them goes stale (SPEC-P 15.3, project-tables.ts markProjectDerivedStale;
 * registered by index.ts). */
export function onMemoryMessagesForgotten(hook: ForgottenMessagesHook | null): void { setForgottenMessagesHook(hook); }

/** What a forget writes in its own commit, at most: the newest this many revisions of a source get their import tombstone, the
 * newest this many evidence rows of a record their supporting and import tombstones; the rest is the job's (imports, supporting). */
export const FORGET_INLINE_ROWS = 64;

export function forgetMemory(ticket: object, target: {kind:"source"|"record";id:string;revision?:number}) {
  const {result,pending}=forgetInTransaction(ticket,target);
  // What the forget left to do is a durable job committed with it (memory-revocation.ts): the runner takes it from here, in short
  // slices, and a restart resumes it. Readers are already protected by the deny facts committed above.
  if(pending)wakeMemoryRevocation(database);
  // The derived cleanup is not owner-gated (no engine call): the worker is told at once, not at its next idle sweep.
  if(result.derivedCleanup=="pending")notifyMemoryWork();
  return result;
}
function forgetInTransaction(ticket: object, target: {kind:"source"|"record";id:string;revision?:number}) {
  requireMemoryOwner(ticket);
  if(!target.id || target.revision!==undefined && (!Number.isSafeInteger(target.revision)||target.revision<0))throw new Error("INVALID_MEMORY_TARGET");
  let pending=false;
  const result=transaction(db=>{
    const exists=target.kind==="source"?db.prepare("SELECT 1 FROM memory_sources WHERE id=?").get(target.id):db.prepare("SELECT 1 FROM memory_records WHERE id=?").get(target.id);
    if(!exists)throw new Error("MEMORY_NOT_FOUND");
    db.exec("UPDATE memory_meta SET deletion_epoch=deletion_epoch+1,policy_revision=policy_revision+1 WHERE id=1");
    const epoch=Number(db.prepare("SELECT deletion_epoch FROM memory_meta WHERE id=1").get()!.deletion_epoch);
    const rev=target.revision??null;
    db.prepare("INSERT INTO memory_tombstones VALUES(?,?,?,?,NULL,?,'owner-forget',?)").run(randomUUID(),target.kind,target.id,rev,epoch,Date.now());
    // A room's notes (its checkpoint) quote room messages every member still
    // reads. Forgetting the notes forgets the notes: a reply made with them is
    // withheld for using them, but the messages they quoted are not forgotten
    // with them (0.1.61 final check 2, N2: every earlier reply read "you chose
    // to forget it" and the bots lost the room's history).
    const notes=target.kind==="record"&&Boolean(db.prepare("SELECT 1 FROM memory_records WHERE id=? AND kind='checkpoint' AND (? IS NULL OR version=?) LIMIT 1").get(target.id,rev,rev));
    // Write-time privacy (DESIGN-WRITETIME 3): the revoke's marks for what is named, its pending window over everything that can rest on
    // it, and its marker job, in this commit (O(1)); the marker walks the rest in the background (revoke-marker.ts).
    const revokeId=commitRevoke(db,{kind:"memory",ref:{kind:target.kind,id:target.id,...(rev!==null&&rev>0?{version:rev}:{})},cause:"forget"});
    let ended: Array<{id:string;revision:number|null}>=[];
    let before: Array<"imports"|"supporting">=[], job: Partial<RevocationJob>={};
    if(target.kind==="source"){
      // the newest revisions' contents may not be imported again; older ones in the job's imports phase
      const versions=db.prepare(`SELECT s.scope_id,v.revision,v.content_hash FROM memory_source_versions v JOIN memory_sources s ON s.id=v.source_id WHERE v.source_id=?${rev===null?"":" AND v.revision=?"} ORDER BY v.revision DESC LIMIT ?`).all(...(rev===null?[target.id]:[target.id,rev]),FORGET_INLINE_ROWS+1);
      for(const version of versions.slice(0,FORGET_INLINE_ROWS))db.prepare("INSERT INTO memory_tombstones VALUES(?,'import',?,NULL,?,?,'forgotten-original',?)").run(randomUUID(),String(version.scope_id),String(version.content_hash),epoch,Date.now());
      // the older revisions' hashes are the job's; a copy imported before they are tombstoned is found from memory_sources' rowid at this
      // commit and ended (revbound r3 A6), and the revoke keeps it "checking" until then (the hold)
      if(versions.length>FORGET_INLINE_ROWS){before=["imports"];job={imports:{id:target.id,below:Number(versions[FORGET_INLINE_ROWS-1]!.revision),mark:Number(db.prepare("SELECT max(rowid) AS m FROM memory_sources").get()?.m??0),scope:String(versions[0]!.scope_id)}};}
      ended=[{id:target.id,revision:rev}];
    } else {
      // Forget means the words are gone from this commit on (Learn about me R5 C1): the record's newest versions lose their text here,
      // the rest in the expand phase; the state stays for that phase's affect, which reads it to queue what was derived from the record
      db.prepare(`UPDATE memory_records SET text='' WHERE rowid IN (SELECT rowid FROM memory_records WHERE id=?${rev===null?"":" AND version=?"} ORDER BY version DESC LIMIT ?) AND text!=''`).run(...(rev===null?[target.id]:[target.id,rev]),FORGET_INLINE_ROWS);
      // the newest evidence rows of the record (the largest primary keys, a descending range): their sources' supporting and import
      // tombstones now; every smaller key is the job's supporting phase
      const rows=db.prepare(`SELECT record_version AS v,source_id AS s,source_revision AS r,start_byte AS b FROM memory_evidence WHERE record_id=?${rev===null?"":" AND record_version=?"} ORDER BY record_version DESC,source_id DESC,source_revision DESC,start_byte DESC LIMIT ?`).all(...(rev===null?[target.id]:[target.id,rev]),FORGET_INLINE_ROWS+1);
      ended=supportingTombstones(db,null,rows.slice(0,FORGET_INLINE_ROWS).map(row=>({id:String(row.s),revision:Number(row.r)})),notes);
      const last=rows[FORGET_INLINE_ROWS-1];
      job={record:{id:target.id,rev,notes,...(rows.length>FORGET_INLINE_ROWS&&last?{after:[Number(last.v),String(last.s),Number(last.r),Number(last.b)]}:{})}};
      if(rows.length>FORGET_INLINE_ROWS)before=["supporting"];
    }
    // Only this forget's targets are applied (restore.ts applyForgetTombstones): never the history of earlier forgets.
    const jobId=randomUUID();
    if(revokeId&&job.imports)holdRevoke(db,revokeId,jobId);
    const applied=applyForgetTombstones(db,{sources:ended,records:target.kind==="record"?[{id:target.id,revision:rev}]:[]},{job:{...job,id:jobId,...(revokeId?{revokeId}:{})},before});
    pending=applied.pending;
    // a turn that carried a message these sources were captured from no longer stands on it (server/turn-source-holds.ts); the sources past
    // the inline rows are held by the job's supporting phase (memory-revocation.ts supportingTombstones)
    holdForgottenSources(db,[...(target.kind==="source"?[target.id]:[]),...(notes?[]:ended.map(source=>source.id))]);
    // The messages the room's notes quoted are not forgotten with them.
    if(!notes)forgottenMessages(db,ended.map(source=>source.id));
    // the worker sets both statuses together, so the indexed lexical probe answers (memory_projection_pending); a job still running is pending too
    const cleanup=pending||Boolean(db.prepare("SELECT 1 FROM memory_projection_receipts WHERE lexical_status='delete-pending' LIMIT 1").get());
    return {status:"excluded" as const,deletionEpoch:epoch,derivedCleanup:cleanup?"pending":"complete",externalHistory:"already-delivered provider text cannot be erased",originals:"retained outside memory; supporting source revisions and automatic reimport excluded"};
  });
  return {result,pending};
}

/** The most a status figure counts before it reads "1,000+": a limited count through an index, never a scan. */
export const MEMORY_COUNT_CAP=1000;
/** The worker sets both statuses together, so the indexed lexical probe (memory_projection_pending) answers for both. */
export function memoryDeletionStatus() {
  const n=Number(database().prepare("SELECT count(*) AS n FROM (SELECT 1 FROM memory_projection_receipts WHERE lexical_status='delete-pending' LIMIT ?)").get(MEMORY_COUNT_CAP+1)!.n);
  return {pending:Math.min(n,MEMORY_COUNT_CAP),more:n>MEMORY_COUNT_CAP};
}
