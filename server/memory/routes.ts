import { isProjectCloseLesson, isCloseTurnRequest } from "../project-close.ts";
import { roomRequest } from "../room-requests.ts";
import { z } from "zod";
import { Buffer } from "node:buffer";
import { database,transaction } from "../database.ts";
import { assertMemoryAccess,type MemoryAccess } from "./policy.ts";
import { searchMemory,type MemorySearchBridge } from "./search.ts";
import { hydrateDisclosedMemoryRecord, hydrateMemoryRecord } from "./bundle.ts";
import { isPipKind } from "./pip-kinds.ts";
import { readerWithheldMessage } from "./disclosures.ts";
import { recordRestsOnWithheldMessage } from "./replay-lineage.ts";
import { memoryState } from "./repository.ts";
import { groundMemoryClaim, type TextOnlyExtractor } from "./extract.ts";
import { learningWriteDecision,learningEvidenceScopes,learningSourceBot } from "./learning-guard.ts";
import { recordLearningEvent } from "./learning-ledger.ts";
import { activateGroundedMemory, holdMemoryCandidate, ownerLearningRefusal } from "./automatic-learning.ts";
import { readMemoryLearning } from "./learning-policy.ts";
import { saveProjectCloseLesson, saveMemoryCandidate, saveGroundedMemory, assertMemoryCaptureComplete, assertGenericMemoryTarget } from "./authority.ts";
import { MEMORY_HANDLE_PATTERN } from "../../shared/memory.ts";
import { enqueueProcedureCorrectionReview } from "./procedure-review.ts";
import { revokeRecordDisclosures } from "./revocation.ts";

/** Resolves the turn-local handles of the dispatch this capability belongs to
 * (MemoryDispatchReceipt.resolveHandle). Absent when no dispatch is live. */
export interface MemoryHandleResolver {
  resolveHandle(handle:string,access:MemoryAccess):{id:string;version:number}|undefined;
  /** The dispatch notes what a lookup handed the turn (0.1.61 T2 R3-4). */
  noteLookup?(records:ReadonlyArray<{id:string;version:number;evidence:ReadonlyArray<{sourceId:string;revision:number}>}>,access:MemoryAccess):void;
}

const id=z.string().min(1).max(256);
const version=z.number().int().min(1);
const evidenceHandle=z.object({sourceId:id,revision:version,startByte:z.number().int().nonnegative(),endByte:z.number().int().positive()}).strict();
const evidence=z.array(evidenceHandle).min(1).max(20);
const key=z.string().regex(/^[\w-]{1,160}$/);
const search=z.object({query:z.string().min(1).refine(s=>Buffer.byteLength(s)<=4096),limit:z.number().int().min(1).max(20).optional(),historical:z.boolean().optional(),cursor:z.string().min(1).max(160).optional()}).strict();
const turnHandle=z.string().regex(MEMORY_HANDLE_PATTERN);
// A remembered line is addressed by its turn-local handle (m1, m2, …) or by
// the exact id/version memory_search returned; never by a mix of the two.
const reference=z.union([z.object({id,version}).strict(),z.object({handle:turnHandle}).strict()]);
const get=z.object({handles:z.array(reference).min(1).max(20)}).strict();
const save=z.object({text:z.string().min(1).max(4096),evidence,idempotencyKey:key,ownerInvitation:evidenceHandle.optional(),claimType:z.enum(["owner-statement","observation","inference","character-canon","procedure"]).optional()}).strict();
const proposal={replacement:z.string().min(1).max(4096),evidence,idempotencyKey:key};
const correction=z.union([z.object({id,version,...proposal}).strict(),z.object({handle:turnHandle,...proposal}).strict()]);

function bounded<T>(result:T):T {
  if(Buffer.byteLength(JSON.stringify(result))>32768)throw Object.assign(new Error("MEMORY_RESPONSE_LIMIT: request fewer records"),{status:413});
  return result;
}

/** Called only after the harness binds a live memory capability to this context. */
export async function memoryAgentRoute(path:string,body:unknown,access:MemoryAccess,bridge:MemorySearchBridge,handles?:MemoryHandleResolver,extractor:TextOnlyExtractor|null=null,options:{budgetGate?:(scopeId:string)=>boolean;executingRequestId?:string}={}) {
  const executingRequestId=options.executingRequestId;
  assertMemoryAccess(access);
  if(memoryState().mode!=="active")throw Object.assign(new Error("MEMORY_NOT_ACTIVE"),{status:409});
  /** A handle names a line of this turn's frame; anything else is unknown, not
   * a guessable record. The record it names is the one the turn was shown. */
  const resolve=(handle:string)=>{
    const record=handles?.resolveHandle(handle,access);
    if(!record)throw Object.assign(new Error(`MEMORY_HANDLE_UNKNOWN: ${handle} is not a remembered line of this request`),{status:404});
    return record;
  };
  try {
    if(path==="/api/internal/memory/search"){
      const input=search.parse(body);
      const result=bounded(await searchMemory(input.query,access,bridge,{...input,withheldMessage:readerWithheldMessage(access)}));
      handles?.noteLookup?.(result.hits.map(hit=>({id:hit.id,version:hit.version,evidence:hit.evidence.map(handle=>({sourceId:String(handle.sourceId),revision:Number(handle.revision)}))})),access);
      return result;
    }
    if(path==="/api/internal/memory/get"){
      const input=get.parse(body);
      // A room reader that is not the owner is not handed a line its
      // transcript leaves out (disclosures.ts readerWithheldMessage).
      const withheld=readerWithheldMessage(access);
      const unless=<T extends {id:string;version:number;pinned:boolean;kind:string}>(record:T):T=>{
        // Owner-authored continuity reaches the bot only through the frame (PIP A1).
        if(isPipKind(record.kind))throw new Error("MEMORY_RECORD_UNAVAILABLE");
        if(withheld&&recordRestsOnWithheldMessage(record.id,record.version,withheld))throw new Error("MEMORY_EVIDENCE_UNAVAILABLE");
        return record;
      };
      const records=input.handles.map(item=>{
        if(!("handle" in item))return unless(hydrateMemoryRecord(item.id,item.version,access));
        const {id:recordId,version:recordVersion}=resolve(item.handle);
        return {handle:item.handle,...unless(hydrateDisclosedMemoryRecord(recordId,recordVersion,access))};
      });
      assertMemoryAccess(access);
      const result=bounded({records});
      handles?.noteLookup?.(records.map(record=>({id:record.id,version:record.version,evidence:record.evidence.map(handle=>({sourceId:handle.sourceId,revision:handle.revision}))})),access);
      return result;
    }
    if(path==="/api/internal/memory/save"){
      const input=save.parse(body);
      if(input.ownerInvitation&&input.claimType!=="character-canon")throw Object.assign(new Error("Owner invitations can only support character canon."),{status:400});
      const executing = executingRequestId ? roomRequest(database(),executingRequestId) : null;
      // A close turn saves only through the lesson path, which refuses once its authority is gone
      // (a Reopen while the body was read); it never falls back to an ordinary grounded save.
      const candidateId=executing && (isProjectCloseLesson(database(),executing) || isCloseTurnRequest(database(),executing))
        ? saveProjectCloseLesson(input.text,input.evidence,input.idempotencyKey,access,executing.id)
        : await saveGroundedMemory(input.text,input.evidence,input.idempotencyKey,access,input.claimType,extractor,input.ownerInvitation,{budgetGate:options.budgetGate});
      const state=String(database().prepare("SELECT state FROM memory_records WHERE id=? AND version=1").get(candidateId)!.state);
      return {candidateId,state,pendingReview:state==="candidate"};
    }
    if(path==="/api/internal/memory/propose-correction"){
      const input=correction.parse(body);
      const target="handle" in input?resolve(input.handle):{id:input.id,version:input.version};
      hydrateMemoryRecord(target.id,target.version,access);
      const db=database();
      assertGenericMemoryTarget(db,target.id,target.version);
      const targetBefore=db.prepare("SELECT text,state,owner_pinned,scope_id FROM memory_records WHERE id=? AND version=?").get(target.id,target.version)!;
      const policyBefore=db.prepare("SELECT policy_revision,deletion_epoch FROM memory_meta").get()!;
      const learningBefore=readMemoryLearning(db).revision;
      // Persist the provisional proposal before optional evaluation. A quote
      // proves the owner's words, not their intent to replace this target.
      assertMemoryCaptureComplete(input.evidence,access);
      const proposalId=transaction(db=>{
        const candidateId=saveMemoryCandidate(input.replacement,input.evidence,input.idempotencyKey,access);
        const previous=db.prepare("SELECT state,supersedes_id FROM memory_records WHERE id=? AND version=1").get(candidateId);
        if(previous?.state!=="candidate"||(previous.supersedes_id&&previous.supersedes_id!==target.id))throw new Error("MEMORY_IDEMPOTENCY_CONFLICT");
        const recorded=db.prepare("SELECT parent_id,parent_version FROM memory_derivations WHERE child_id=? AND child_version=1").all(candidateId);
        if(recorded.some(row=>row.parent_id!==target.id||Number(row.parent_version)!==target.version))throw new Error("MEMORY_IDEMPOTENCY_CONFLICT");
        db.prepare("UPDATE memory_records SET supersedes_id=? WHERE id=? AND version=1").run(target.id,candidateId);
        db.prepare("INSERT OR IGNORE INTO memory_derivations VALUES(?,?,?,1)").run(target.id,target.version,candidateId);
        return candidateId;
      });
      let refusal=ownerLearningRefusal(db,input.evidence);
      let support={supported:false,reason:"correction-grounding-unavailable"};
      if(!refusal&&input.evidence.length===1&&targetBefore.state==="active"&&targetBefore.owner_pinned===0){
        const h=input.evidence[0];
        const source=db.prepare("SELECT s.*,v.payload FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision WHERE s.id=? AND s.revision=?").get(h.sourceId,h.revision);
        if(source?.speaker==="owner"&&source.scope_id===targetBefore.scope_id){
          const quote=Buffer.from(JSON.parse(String(source.payload)).text).subarray(h.startByte,h.endByte).toString("utf8");
          if(options.budgetGate&&!options.budgetGate(String(source.scope_id)))refusal="project-budget-reached";
          else support=await groundMemoryClaim({text:input.replacement,quote,claimType:"owner-statement",speaker:"owner",outcome:String(source.outcome),previousClaim:String(targetBefore.text)},extractor,new AbortController().signal);
        }
      }
      if(refusal)transaction(()=>holdMemoryCandidate(db,proposalId,refusal!));
      return transaction(db=>{
        assertMemoryAccess(access);assertGenericMemoryTarget(db,target.id,target.version);
        const policyAfter=db.prepare("SELECT policy_revision,deletion_epoch FROM memory_meta").get()!;
        if(policyAfter.policy_revision!==policyBefore.policy_revision||policyAfter.deletion_epoch!==policyBefore.deletion_epoch||readMemoryLearning(db).revision!==learningBefore)throw new Error("MEMORY_CONSOLIDATION_REVOKED");
        const latest=database().prepare("SELECT max(version) AS version FROM memory_records WHERE id=?").get(target.id);
        if(latest?.version!==target.version)throw new Error("MEMORY_VERSION_CONFLICT");
        const candidateId=saveMemoryCandidate(input.replacement,input.evidence,input.idempotencyKey,access);
        const previous=db.prepare("SELECT state,supersedes_id FROM memory_records WHERE id=? AND version=1").get(candidateId);
        const recorded=db.prepare("SELECT parent_id,parent_version FROM memory_derivations WHERE child_id=? AND child_version=1").all(candidateId);
        if(previous?.state!=="candidate"||previous.supersedes_id!==target.id||recorded.length!==1||recorded[0].parent_id!==target.id||Number(recorded[0].parent_version)!==target.version)throw new Error("MEMORY_IDEMPOTENCY_CONFLICT");
        const targetRow=db.prepare("SELECT state,owner_pinned,scope_id FROM memory_records WHERE id=? AND version=?").get(target.id,target.version);
        const candidateRow=db.prepare("SELECT scope_id FROM memory_records WHERE id=? AND version=1").get(candidateId);
        const evidence=input.evidence[0],source=evidence?db.prepare("SELECT thread_id FROM memory_sources WHERE id=?").get(evidence.sourceId):undefined;
        const bot=learningSourceBot(source?.thread_id?String(source.thread_id):null);
        const decision=evidence?learningWriteDecision(db,{writer:"correction-supersede",sourceId:evidence.sourceId,sourceRevision:evidence.revision,targetScopeId:String(candidateRow?.scope_id),evidenceScopeIds:[...learningEvidenceScopes(db,candidateId,1),...learningEvidenceScopes(db,target.id,target.version)],botId:bot?.id,target:"memory"}):undefined;
        const active=support.supported&&targetRow?.state==="active"&&targetRow.owner_pinned===0&&targetRow.scope_id===candidateRow?.scope_id&&activateGroundedMemory(db,candidateId,"owner-statement",support,{decision,connection:extractor?.learningConnection,superseding:true,reviewOnly:extractor?.reviewOnly});
        if(active){
          db.prepare("UPDATE memory_records SET state='superseded',valid_to=? WHERE id=? AND version=?").run(Date.now(),target.id,target.version);
          db.prepare("UPDATE memory_projection_receipts SET lexical_status='pending-archive' WHERE record_id=? AND record_version=?").run(target.id,target.version);
          db.exec("UPDATE memory_meta SET data_revision=data_revision+1");
          revokeRecordDisclosures(db,"correction-supersede",{recordIds:[target.id,candidateId]});
          recordLearningEvent(db,{kind:"superseded",scopeId:String(candidateRow!.scope_id),recordId:candidateId,recordVersion:1,priorId:target.id,priorVersion:target.version,sourceId:evidence.sourceId,sourceRevision:evidence.revision,botId:bot?.id,connection:extractor?.learningConnection});
          enqueueProcedureCorrectionReview(db,candidateId,1);
        }
        const savedState=String(db.prepare("SELECT state FROM memory_records WHERE id=? AND version=1").get(candidateId)!.state);
        return {candidateId,state:savedState,pendingReview:savedState==="candidate",record:{id:target.id,version:target.version},...("handle" in input?{handle:input.handle}:{})};
      });
    }
    throw Object.assign(new Error("MEMORY_ROUTE_UNAVAILABLE"),{status:404});
  }catch(error){
    if(error instanceof z.ZodError)throw Object.assign(new Error("INVALID_MEMORY_ARGUMENTS"),{status:400});
    throw error;
  }
}
