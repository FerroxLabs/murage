import { checkpointFamily } from './checkpoints.ts';
import { randomUUID } from "node:crypto";
import { holdForgottenSources } from "../turn-source-holds.ts";
import { database, transaction } from "../database.ts";
import { requireMemoryOwner } from "./authority.ts";
import { applyForgetTombstones } from "./restore.ts";
import { forgetRecordKeys, forgetSourceKeys, forgottenMessages, keptSpanPairs, setForgottenMessagesHook, supportingTombstones, wakeMemoryRevocation, type ForgottenMessagesHook, type RevocationJob } from "./memory-revocation.ts";
import { notifyMemoryWork } from "./jobs.ts";
import { commitRevoke } from "./revoke-commit.ts";
import { holdRevoke } from "./revoke-marker.ts";

/** Told, inside the forget's own transaction (or the job step that ends more of its sources), which messages the forgotten
 * material came from: derived project text citing them goes stale (SPEC-P 15.3, project-tables.ts markProjectDerivedStale;
 * registered by index.ts). */
export function onMemoryMessagesForgotten(hook: ForgottenMessagesHook | null): void { setForgottenMessagesHook(hook); }

/** 1.0.21 cause10 v2 (FORGET-ATOMIC.md): a forget writes its WHOLE deny key set in its own commit (every revision's import key, every
 * supporting-source key), whatever the count: no reader ever waits on the job. This many newest evidence rows of a record are also ended
 * here (applyForgetTombstones); ending the rest, blanking older versions' text and the projection cleanup are the job's, space only. */
export const FORGET_INLINE_ROWS = 64;

export function forgetMemory(ticket: object, target: {kind:"source"|"record";id:string;revision?:number}) {
  const {result,pending}=forgetInTransaction(ticket,target);
  // What the forget left to do is a durable job committed with it (memory-revocation.ts): the runner takes it from here, in short
  // slices, and a restart resumes it. Readers are already protected by the deny facts committed above.
  // the owner's own action: it also resumes a runner parked on a storage failure (human-bounded, never a loop)
  if(pending)wakeMemoryRevocation(database,undefined,true);
  // The derived cleanup is not owner-gated (no engine call): the worker is told at once, not at its next idle sweep.
  if(result.derivedCleanup=="pending")notifyMemoryWork();
  return result;
}
type ForgetResult={status:'excluded';deletionEpoch:number;derivedCleanup:'pending'|'complete';externalHistory:string;originals:string};
function forgetInTransaction(ticket: object, target: {kind:"source"|"record";id:string;revision?:number}, familyMember=false):{result:ForgetResult;pending:boolean} {
  requireMemoryOwner(ticket);
  if(!target.id || target.revision!==undefined && (!Number.isSafeInteger(target.revision)||target.revision<0))throw new Error("INVALID_MEMORY_TARGET");
  let pending=false;
  const result=transaction(db=>{
    // A displayed rolling checkpoint is one owner-visible family. Preserve exact
    // record revocation paths for every retained member; head movement has none.
    const family=!familyMember&&target.kind==='record'?checkpointFamily(db,target.id,target.revision):undefined;
    if(family){
      db.prepare(`INSERT OR IGNORE INTO memory_checkpoint_exclusions SELECT ?,e.source_id,e.source_revision FROM memory_checkpoint_members m JOIN memory_evidence e ON e.record_id=m.record_id AND e.record_version=m.record_version WHERE m.family_id=?`).run(family.family_id,family.family_id);
      db.prepare("UPDATE memory_checkpoint_heads SET record_id=NULL,record_version=NULL,state='forgotten' WHERE family_id=?").run(family.family_id);
      let selected:ReturnType<typeof forgetInTransaction>['result']|undefined;
      for(const member of db.prepare('SELECT DISTINCT record_id FROM memory_checkpoint_members WHERE family_id=? ORDER BY record_id').all(family.family_id)){
        const forgotten=forgetInTransaction(ticket,{kind:'record',id:String(member.record_id)},true);
        pending ||= forgotten.pending;
        if(member.record_id===target.id)selected=forgotten.result;
      }
      if(!selected)throw new Error('MEMORY_NOT_FOUND');
      return {...selected,deletionEpoch:Number(db.prepare('SELECT deletion_epoch FROM memory_meta WHERE id=1').get()!.deletion_epoch),derivedCleanup:pending?'pending' as const:selected.derivedCleanup};
    }
    const exists=target.kind==="source"?db.prepare("SELECT 1 FROM memory_sources WHERE id=?").get(target.id):db.prepare("SELECT 1 FROM memory_records WHERE id=?").get(target.id);
    if(!exists)throw new Error("MEMORY_NOT_FOUND");
    db.exec("UPDATE memory_meta SET deletion_epoch=deletion_epoch+1,policy_revision=policy_revision+1 WHERE id=1");
    const epoch=Number(db.prepare("SELECT deletion_epoch FROM memory_meta WHERE id=1").get()!.deletion_epoch);
    const rev=target.revision??null;
    db.prepare("INSERT INTO memory_tombstones VALUES(?,?,?,?,NULL,?,'owner-forget',?)").run(randomUUID(),target.kind,target.id,rev,epoch,Date.now());
    // Memory screen B2 (spec r3 2.3): the pin goes in this commit, not at the job's affect step (memory-revocation.ts), which a large
    // record leaves to the runner; the next turn then never selects a pin it may not read. A primary-key range over this record's
    // versions; authority_pins_u moves the pin stamp, so the bundle's pin cache is not reused.
    if(target.kind==="record")db.prepare("UPDATE memory_records SET owner_pinned=0 WHERE id=? AND (? IS NULL OR version=?) AND owner_pinned=1").run(target.id,rev,rev);
    // A room's notes (its checkpoint) quote room messages every member still
    // reads. Forgetting the notes forgets the notes: a reply made with them is
    // withheld for using them, but the messages they quoted are not forgotten
    // with them (0.1.61 final check 2, N2: every earlier reply read "you chose
    // to forget it" and the bots lost the room's history).
    const notes=target.kind==="record"&&Boolean(db.prepare("SELECT 1 FROM memory_records WHERE id=? AND kind='checkpoint' AND (? IS NULL OR version=?) LIMIT 1").get(target.id,rev,rev));
    // Write-time privacy (DESIGN-WRITETIME 3): the revoke's marks for what is named, its pending window over everything that can rest on
    // it, and its marker job, in this commit (O(1)); the marker walks the rest in the background (revoke-marker.ts).
    const revokeId=commitRevoke(db,{kind:"memory",ref:{kind:target.kind,id:target.id,...(rev!==null&&rev>0?{version:rev}:{})},cause:"forget"});
    let ended: Array<{id:string;revision:number|null}>=[], told: string[]=[];
    let before: Array<"imports"|"supporting">=[], job: Partial<RevocationJob>={};
    if(target.kind==="source"){
      // no revision's contents may be imported again, from this commit on: every revision's import key, in one statement (cause10 v2).
      // A copy imported before is refused by the same key (deny-read.ts) and none can be admitted after (1.0.20 tombstoned past 64
      // revisions in the job and ended imports admitted meanwhile).
      forgetSourceKeys(db,{id:target.id,rev},epoch,Date.now());
      // a long source keeps 1.0.20's late-copy step as cleanup (no key left to write: `below` 1): a message line captured meanwhile with a
      // forgotten revision's bytes is ended, and the revoke holds it "checking" until then, as before (import-window-summary.test.ts)
      // `keys`: every key is in this commit, so the next open's pass over older builds' queued Forgets leaves this job alone (it wrote
      // every revision's key a second time and moved the watermark once more; legacy-forget-keys.ts LEGACY_FORGET_JOBS, forget-atomic FA9)
      if(Number(db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM memory_source_versions WHERE source_id=?${rev===null?"":" AND revision=?"} LIMIT ?)`).get(...(rev===null?[target.id]:[target.id,rev]),FORGET_INLINE_ROWS+1)!.n)>FORGET_INLINE_ROWS){
        before=["imports"];job={imports:{id:target.id,below:1,keys:true,mark:Number(db.prepare("SELECT max(rowid) AS m FROM memory_sources").get()?.m??0),scope:String(db.prepare("SELECT scope_id FROM memory_sources WHERE id=?").get(target.id)!.scope_id)}};
      }
      ended=[{id:target.id,revision:rev}];
    } else {
      // Forget means the words are gone from this commit on (Learn about me R5 C1): the record's newest versions lose their text here,
      // the rest in the expand phase; the state stays for that phase's affect, which reads it to queue what was derived from the record
      db.prepare(`UPDATE memory_records SET text='' WHERE rowid IN (SELECT rowid FROM memory_records WHERE id=?${rev===null?"":" AND version=?"} ORDER BY version DESC LIMIT ?) AND text!=''`).run(...(rev===null?[target.id]:[target.id,rev]),FORGET_INLINE_ROWS);
      // the newest evidence rows of the record (the largest primary keys, a descending range): their sources' supporting and import
      // tombstones now; every smaller key is the job's supporting phase
      const rows=db.prepare(`SELECT record_version AS v,source_id AS s,source_revision AS r,start_byte AS b FROM memory_evidence WHERE record_id=?${rev===null?"":" AND record_version=?"} ORDER BY record_version DESC,source_id DESC,source_revision DESC,start_byte DESC LIMIT ?`).all(...(rev===null?[target.id]:[target.id,rev]),FORGET_INLINE_ROWS+1);
      // 1.0.21 cause10 r2: a notebook chunk the chunk-diff import kept has ONE handle, moved to the notebook's newest revision; it rested,
      // with these words, on every revision since its version was written. Those revisions take the same tombstones (the newest here, the
      // rest in the supporting phase), or their contents could be imported again under another topic (memory-revocation.ts keptSpanPairs).
      const span=target.id.includes(":chunk:")?keptSpanPairs(db,{id:target.id,rev},null,FORGET_INLINE_ROWS):{pairs:[],next:null};
      ended=supportingTombstones(db,null,[...rows.slice(0,FORGET_INLINE_ROWS).map(row=>({id:String(row.s),revision:Number(row.r)})),...span.pairs],notes,true);
      // cause10 v2 (FORGET-ATOMIC.md): and the rest of the deny keys, every version, evidence row and kept revision, in set statements:
      // what the supporting phase still walks only ends and reclaims. The held turns and the learning purge are told of every source now.
      told=forgetRecordKeys(db,{id:target.id,rev},notes,epoch,Date.now());
      const last=rows[FORGET_INLINE_ROWS-1];
      job={record:{id:target.id,rev,notes,keys:true,...(rows.length>FORGET_INLINE_ROWS&&last?{after:[Number(last.v),String(last.s),Number(last.r),Number(last.b)]}:{}),...(span.next?{span:span.next}:{})}};
      if(rows.length>FORGET_INLINE_ROWS||span.next)before=["supporting"];
    }
    // Only this forget's targets are applied (restore.ts applyForgetTombstones): never the history of earlier forgets.
    const jobId=randomUUID();
    if(revokeId&&job.imports)holdRevoke(db,revokeId,jobId);
    const applied=applyForgetTombstones(db,{sources:ended,records:target.kind==="record"?[{id:target.id,revision:rev}]:[]},{job:{...job,id:jobId,...(revokeId?{revokeId}:{})},before});
    pending=applied.pending;
    // a turn that carried a message these sources were captured from no longer stands on it (server/turn-source-holds.ts): cause10 v2, every
    // source the record rested on (`told`), not only the inline rows'; the job's supporting phase holding them again later is harmless
    const forgottenSources=[...new Set([...ended.map(source=>source.id),...told])];
    holdForgottenSources(db,[...(target.kind==="source"?[target.id]:[]),...(notes?[]:forgottenSources)]);
    // The messages the room's notes quoted are not forgotten with them.
    if(!notes)forgottenMessages(db,forgottenSources);
    // the worker sets both statuses together, so the indexed lexical probe answers (memory_projection_pending); a job still running is pending too
    const cleanup=pending||Boolean(db.prepare("SELECT 1 FROM memory_projection_receipts WHERE lexical_status='delete-pending' LIMIT 1").get());
    return {status:"excluded" as const,deletionEpoch:epoch,derivedCleanup:cleanup?"pending" as const:"complete" as const,externalHistory:"already-delivered provider text cannot be erased",originals:"retained outside memory; supporting source revisions and automatic reimport excluded"};
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
