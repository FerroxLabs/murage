import { readMemoryEvolutionPolicy, type MemoryEvolutionPolicy } from "./evolution-policy.ts";
import { createHash, randomUUID } from "node:crypto";
import { database, transaction } from "../database.ts";
import { extractCandidates, groundMemoryClaim, memoryExtractionMessages, type TextOnlyExtractor } from "./extract.ts";
import { redactSecretsInText } from "../redact.ts";
import { activateGroundedMemory } from "./automatic-learning.ts";
import { readMemoryLearning } from "./learning-policy.ts";
import { threadCheckpointId, unsettledIntention } from "./checkpoints.ts";
import { enqueueProcedureCorrectionReview } from "./procedure-review.ts";

type Handle={sourceId:string;revision:number;startByte:number;endByte:number};
const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
function completedSource(jobId:string){
  const row=database().prepare(`SELECT j.status,j.cursor,s.*,length(CAST(json_extract(v.payload,'$.text') AS BLOB)) AS bytes
    FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision
    JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
    WHERE j.id=? AND j.stage='capture'`).get(jobId);
  if(!row||row.status!=="complete"||row.state!=="active"||row.cursor!==row.bytes)throw new Error("MEMORY_COMPLETED_SOURCE_REQUIRED");
  if(database().prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(row.id,row.revision))throw new Error("MEMORY_SOURCE_UNAVAILABLE");
  return row;
}
function checkpointEvidence(handle:Handle,scopeId:string){
  const db=database();
  const source=db.prepare(`SELECT s.*,substr(CAST(json_extract(v.payload,'$.text') AS BLOB),?,?) AS excerpt
    FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
    WHERE s.id=? AND s.revision=? AND s.state='active' AND s.scope_id=?
    AND EXISTS(SELECT 1 FROM memory_jobs j WHERE j.source_id=s.id AND j.source_revision=s.revision AND j.stage='capture' AND j.status='complete'
      AND j.cursor=length(CAST(json_extract(v.payload,'$.text') AS BLOB)))`).get(handle.startByte+1,handle.endByte-handle.startByte,handle.sourceId,handle.revision,scopeId);
  if(!source||source.kind==="turn"||db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(handle.sourceId,handle.revision))return null;
  // A cancelled intention is not a completed effect; the same rule governs current recall.
  if(unsettledIntention(db,source))return null;
  const bytes=source.excerpt as Uint8Array;
  if(bytes.length!==handle.endByte-handle.startByte||bytes.length===0)return null;
  let text:string;try{text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{return null;}
  return {handle,text,speaker:String(source.speaker),outcome:String(source.outcome)};
}

/** Invoke once after an accepted complete capture publication, never on raw events.
 * Maintains at most four direct original-source references; never summarizes an
 * earlier summary, deletes source evidence, promotes authority, or writes pins.
 */
export function refreshMemoryCheckpoint(completedJobId:string){
  return transaction(db=>{
    const source=completedSource(completedJobId);
    if(!source.thread_id)return {status:"deferred" as const,reason:"source-has-no-thread"};
    const id=threadCheckpointId(String(source.scope_id),String(source.thread_id));
    const previous=db.prepare("SELECT * FROM memory_records WHERE id=? ORDER BY version DESC LIMIT 1").get(id);
    if(previous?.owner_pinned===1||previous?.assertion==="owner-statement")return {status:"deferred" as const,reason:"owner-controlled-checkpoint"};
    const handles:Handle[]=previous?db.prepare("SELECT source_id AS sourceId,source_revision AS revision,start_byte AS startByte,end_byte AS endByte FROM memory_evidence WHERE record_id=? AND record_version=?").all(id,previous.version) as unknown as Handle[]:[];
    if(source.kind!=="turn" && Number(source.bytes)>0){
      const raw=db.prepare("SELECT substr(CAST(json_extract(payload,'$.text') AS BLOB),1,96) AS bytes FROM memory_source_versions WHERE source_id=? AND revision=?").get(source.id,source.revision)!.bytes as Uint8Array;
      let length=raw.length;
      while(length>0){try{new TextDecoder("utf-8",{fatal:true}).decode(raw.subarray(0,length));break;}catch{length--;}}
      if(length)handles.unshift({sourceId:String(source.id),revision:Number(source.revision),startByte:0,endByte:length});
    }
    const seen=new Set<string>(),items=[];
    for(const handle of handles){
      if(seen.has(handle.sourceId))continue;seen.add(handle.sourceId);
      const item=checkpointEvidence(handle,String(source.scope_id));if(item)items.push(item);
      if(items.length===4)break;
    }
    if(!items.length){
      if(previous?.state==="active"){
        db.prepare("UPDATE memory_records SET state='archived',valid_to=? WHERE id=? AND version=?").run(Date.now(),id,previous.version);
        db.prepare("UPDATE memory_projection_receipts SET lexical_status='pending-archive' WHERE record_id=? AND record_version=?").run(id,previous.version);
        db.exec("UPDATE memory_meta SET data_revision=data_revision+1");
      }
      return {status:"deferred" as const,reason:"no-current-completed-evidence"};
    }
    const text="Working evidence; statements are not fulfilled commitments.\n"+items.map(item=>`${item.speaker==='owner'?'Owner statement':item.speaker==='tool'?'Observed tool outcome':'Assistant hypothesis'} (${item.outcome}): ${JSON.stringify(item.text)}`).join("\n");
    const previousHandles=previous?db.prepare("SELECT source_id AS sourceId,source_revision AS revision,start_byte AS startByte,end_byte AS endByte FROM memory_evidence WHERE record_id=? AND record_version=? ORDER BY source_id").all(id,previous.version):[];
    const ordered=items.map(item=>item.handle).sort((a,b)=>a.sourceId.localeCompare(b.sourceId));
    if(previous?.state==="active"&&previous.text===text&&JSON.stringify(previousHandles)===JSON.stringify(ordered))return {status:"unchanged" as const,checkpointId:id,version:Number(previous.version)};
    const version=previous?Number(previous.version)+1:1;
    if(previous){db.prepare("UPDATE memory_records SET state='archived',valid_to=? WHERE id=? AND version=? AND owner_pinned=0").run(Date.now(),id,previous.version);db.prepare("UPDATE memory_projection_receipts SET lexical_status='pending-archive' WHERE record_id=? AND record_version=?").run(id,previous.version);}
    db.prepare("INSERT INTO memory_records VALUES(?,?,?,'checkpoint',?,'assistant-inference','active',0,?,NULL,NULL,?)").run(id,version,source.scope_id,text,Date.now(),Date.now());
    for(const item of items)db.prepare("INSERT INTO memory_evidence VALUES(?,?,?,?,?,?)").run(id,version,item.handle.sourceId,item.handle.revision,item.handle.startByte,item.handle.endByte);
    db.prepare("INSERT INTO memory_projection_receipts VALUES(?,?,0,'pending','pending',NULL)").run(id,version);
    db.exec("UPDATE memory_meta SET data_revision=data_revision+1");
    return {status:"updated" as const,checkpointId:id,version};
  });
}

const CONSOLIDATION_CHUNK_BYTES=16*1024;
interface ConsolidationIntent {
  evolutionPolicyRevision?:string;
  jobId:string;sourceId:string;revision:number;cursor:number;totalBytes:number;
  status:"running"|"partial"|"deferred"|"complete";candidateIds:string[];candidateCount:number;
  generation?:string;expiresAt?:number;retryAfter?:number|null;reason?:string;updatedAt:number;
}

/** Existing metadata supplies bounded restart discovery. The controller owns its
 * timer and global task slot; this function never invokes a model or changes caps. */
export function pendingMemoryConsolidationJobs(limit=4):string[]{
  const count=Math.min(4,Math.max(1,Math.trunc(limit)||1)),now=Date.now(),db=database();
  // Existing (subject_type,subject_id) index bounds each polling visit to 64
  // pending receipts. Completed receipts are never JSON-scanned by the timer.
  const statement=db.prepare("SELECT rowid,intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='consolidation-pending' AND state='granted' AND rowid>? ORDER BY rowid LIMIT 64");
  let rows=statement.all(consolidationScanCursor);
  if(!rows.length){consolidationScanCursor=0;rows=statement.all(0);}
  const found:string[]=[];
  for(const row of rows){
    consolidationScanCursor=Number(row.rowid);
    const intent=JSON.parse(String(row.intent)) as ConsolidationIntent;
    if(!(intent.status==="partial"||intent.status==="deferred"&&typeof intent.retryAfter==="number"&&intent.retryAfter<=now||intent.status==="running"&&typeof intent.expiresAt==="number"&&intent.expiresAt<=now))continue;
    if(db.prepare("SELECT 1 FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision WHERE j.id=? AND j.status='complete' AND s.state='active'").get(intent.jobId))found.push(intent.jobId);
    if(found.length===count)break;
  }
  return found;
}
let consolidationScanCursor=0;
function retryAfter(reason:string,text:string,policy:MemoryEvolutionPolicy):number {
  const now=Date.now();
  if(reason!=="budget-exhausted")return now+(reason==="extractor-busy"?1000:60000);
  const day=new Date(now).toISOString().slice(0,10),row=database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(`extract-budget:${day}`);
  const budget=row?JSON.parse(String(row.intent)):{input:0,output:0};
  const input=Buffer.byteLength(JSON.stringify(memoryExtractionMessages(text,policy)));
  return budget.input+input>readMemoryLearning(database()).inputLimit||budget.output+Math.min(2000,readMemoryLearning(database()).outputLimit)>readMemoryLearning(database()).outputLimit?Date.parse(`${day}T00:00:00Z`)+86400000:(Math.floor(now/60000)+1)*60000;
}

/** One <=16KiB UTF-8 slice per invocation. Candidates and the absolute cursor
 * commit together; interrupted slices retry without replaying acknowledged ones.
 * Intent retains only this slice's <=20 IDs, keeping its metadata bounded.
 */
export async function consolidateMemorySource(completedJobId:string,extractor:TextOnlyExtractor|null,signal:AbortSignal){
  const db=database(),id=`consolidation:${hash(completedJobId)}`;
  const persist=(scope:unknown,intent:ConsolidationIntent)=>db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system',?,0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent,subject_id=excluded.subject_id").run(id,scope as string,intent.status==="complete"||intent.retryAfter===null?"consolidation":"consolidation-pending",JSON.stringify(intent));
  const claim=transaction(()=>{
    const source=completedSource(completedJobId),prior=db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(id);
    const saved=prior?JSON.parse(String(prior.intent)):null;
    const state:ConsolidationIntent={evolutionPolicyRevision:saved?.evolutionPolicyRevision??readMemoryEvolutionPolicy().revision,jobId:completedJobId,sourceId:String(source.id),revision:Number(source.revision),cursor:saved?.cursor??0,totalBytes:Number(source.bytes),status:saved?.status??"partial",candidateIds:saved?.candidateIds??[],candidateCount:saved?.candidateCount??saved?.candidateIds?.length??0,updatedAt:Date.now()};
    if(saved?.status==="complete")return {done:{status:"unchanged" as const,candidateIds:state.candidateIds,cursor:state.totalBytes,candidateCount:state.candidateCount}};
    if(!Number.isSafeInteger(state.cursor)||state.cursor<0||state.cursor>state.totalBytes)throw new Error("MEMORY_CONSOLIDATION_CURSOR_INVALID");
    if(saved?.status==="running"&&saved.expiresAt>Date.now())return {done:{status:"deferred" as const,reason:"extraction-already-running",candidateIds:[],cursor:state.cursor,candidateCount:state.candidateCount,retryAfter:saved.expiresAt as number}};
    if(!extractor||source.kind==="turn"||signal.aborted){
      const reason=signal.aborted?"extraction-incomplete":!extractor?"extractor-unavailable":"settlement-is-not-a-fact";
      const nextRetry=source.kind==="turn"?null:retryAfter(reason,"",readMemoryEvolutionPolicy(state.evolutionPolicyRevision));
      persist(source.scope_id,{...state,status:"deferred",reason,retryAfter:nextRetry});
      return {done:{status:"deferred" as const,reason,candidateIds:[],cursor:state.cursor,candidateCount:state.candidateCount,retryAfter:nextRetry}};
    }
    const raw=db.prepare("SELECT substr(CAST(json_extract(payload,'$.text') AS BLOB),?,?) AS bytes FROM memory_source_versions WHERE source_id=? AND revision=?").get(state.cursor+1,CONSOLIDATION_CHUNK_BYTES,source.id,source.revision)!.bytes as Uint8Array;
    let text:string|undefined,length=raw.length;
    for(let trim=0;trim<=3&&trim<=raw.length;trim++){try{length=raw.length-trim;text=new TextDecoder("utf-8",{fatal:true}).decode(raw.subarray(0,length));break;}catch{/* split code point at the chunk end */}}
    if(text===undefined||!length&&state.cursor<state.totalBytes)throw new Error("MEMORY_CONSOLIDATION_UTF8_INVALID");
    const generation=randomUUID(),meta=db.prepare("SELECT policy_revision,deletion_epoch FROM memory_meta").get()!;
    persist(source.scope_id,{...state,status:"running",generation,expiresAt:Date.now()+65000});
    return {source,state,generation,meta,text,length,learningRevision:readMemoryLearning(db).revision};
  });
  if(claim.done)return claim.done;
  const {source,state,generation,meta,text,length,learningRevision}=claim;
  const result=text!.trim()?await extractCandidates(text!,extractor,signal,readMemoryEvolutionPolicy(state!.evolutionPolicyRevision)):{status:"complete" as const,candidates:[]};
  const corrections=new Map<object,{id:string;version:number}>();
  const support=new Map<object,{supported:boolean;reason:string}>();
  if(result.status==="complete")for(const candidate of result.candidates){
    if(candidate.subject&&candidate.predicate&&candidate.update&&source!.speaker==="owner"){
      const prior=db.prepare(`SELECT r.id,r.version,r.text FROM memory_records r JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version
        WHERE r.scope_id=? AND r.state='active' AND r.owner_pinned=0 AND d.entities=? AND r.kind='fact' AND d.partition!='identity' ORDER BY r.created_at DESC LIMIT 2`).all(source!.scope_id,JSON.stringify([candidate.subject,candidate.predicate]));
      if(prior.length===1&&prior[0].text!==candidate.text){
        const checked=await groundMemoryClaim({text:candidate.text,quote:candidate.quote,claimType:candidate.claimType??"owner-statement",speaker:String(source!.speaker),outcome:String(source!.outcome),previousClaim:String(prior[0].text)},extractor,signal);
        if(checked.supported){corrections.set(candidate,{id:String(prior[0].id),version:Number(prior[0].version)});support.set(candidate,checked);}
      }
    }
    if(!support.has(candidate)&&candidate.claimType && candidate.claimType!=="inference" && candidate.text!==candidate.quote)
      support.set(candidate,await groundMemoryClaim({text:candidate.text,quote:candidate.quote,claimType:candidate.claimType,speaker:String(source!.speaker),outcome:String(source!.outcome)},extractor,signal));
  }
  return transaction(()=>{
    const current=db.prepare("SELECT policy_revision,deletion_epoch FROM memory_meta").get()!;
    completedSource(completedJobId);
    const intent=JSON.parse(String(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(id)!.intent));
    if(readMemoryLearning(db).revision!==learningRevision||intent.generation!==generation||current.policy_revision!==meta!.policy_revision||current.deletion_epoch!==meta!.deletion_epoch)throw new Error("MEMORY_CONSOLIDATION_REVOKED");
    if(result.status!=="complete"||signal.aborted){
      const reason=result.status!=="complete"?result.reason:"extraction-incomplete";
      const nextRetry=retryAfter(reason,text!,readMemoryEvolutionPolicy(state!.evolutionPolicyRevision));
      persist(source!.scope_id,{...state!,status:"deferred",reason,retryAfter:nextRetry,updatedAt:Date.now()});
      return {status:"deferred" as const,reason,candidateIds:[],cursor:state!.cursor,candidateCount:state!.candidateCount,retryAfter:nextRetry};
    }
    const candidateIds:string[]=[];let added=0;
    for(const candidate of result.candidates){
      const absolute={...candidate,startByte:state!.cursor+candidate.startByte,endByte:state!.cursor+candidate.endByte};
      const candidateId=`candidate:${hash(JSON.stringify([source!.id,source!.revision,absolute]))}`;candidateIds.push(candidateId);
      const inserted=db.prepare("INSERT OR IGNORE INTO memory_records VALUES(?,1,?,'fact',?,'assistant-inference','candidate',0,?,NULL,NULL,?)").run(candidateId,source!.scope_id,redactSecretsInText(candidate.text),Date.now(),Date.now());
      added+=Number(inserted.changes);
      db.prepare("INSERT OR IGNORE INTO memory_evidence VALUES(?,1,?,?,?,?)").run(candidateId,source!.id,source!.revision,absolute.startByte,absolute.endByte);
      if(inserted.changes){
        const active=activateGroundedMemory(db,candidateId,candidate.claimType,support.get(candidate));
        if(candidate.subject&&candidate.predicate)db.prepare("UPDATE memory_record_details SET entities=? WHERE record_id=? AND record_version=1").run(JSON.stringify([candidate.subject,candidate.predicate]),candidateId);
        const prior=corrections.get(candidate);
        if(active&&prior){
          const retired=db.prepare("UPDATE memory_records SET state='superseded',valid_to=? WHERE id=? AND version=? AND state='active' AND owner_pinned=0").run(Date.now(),prior.id,prior.version);
          if(retired.changes!==1)throw new Error("MEMORY_CORRECTION_TARGET_CHANGED");
          db.prepare("UPDATE memory_records SET supersedes_id=? WHERE id=? AND version=1").run(prior.id,candidateId);
          db.prepare("INSERT INTO memory_derivations VALUES(?,?,?,1)").run(prior.id,prior.version,candidateId);
          db.prepare("UPDATE memory_projection_receipts SET lexical_status='pending-archive' WHERE record_id=? AND record_version=?").run(prior.id,prior.version);
          db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE state!='revoked'").run();
          enqueueProcedureCorrectionReview(db,candidateId,1);
        }else if(active&&candidate.subject&&candidate.predicate){
          const conflict=db.prepare(`SELECT r.id FROM memory_records r JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version WHERE r.scope_id=? AND r.state='active' AND r.id!=? AND r.text!=? AND d.entities=? LIMIT 1`).get(source!.scope_id,candidateId,candidate.text,JSON.stringify([candidate.subject,candidate.predicate]));
          if(conflict)db.prepare("UPDATE memory_record_details SET claim_status='disputed' WHERE record_id=? AND record_version=1").run(candidateId);
        }
        if(!active&&support.has(candidate))db.prepare("UPDATE memory_record_details SET confidence_basis=? WHERE record_id=? AND record_version=1").run(support.get(candidate)!.reason,candidateId);
      }
    }
    const cursor=state!.cursor+length!,status=cursor===state!.totalBytes?"complete" as const:"partial" as const,candidateCount=state!.candidateCount+added;
    persist(source!.scope_id,{...state!,status,cursor,candidateIds,candidateCount,retryAfter:status==="partial"?Date.now():null,updatedAt:Date.now()});
    db.exec("UPDATE memory_meta SET data_revision=data_revision+1");
    return {status,candidateIds,cursor,candidateCount,retryAfter:status==="partial"?Date.now():null};
  });
}
