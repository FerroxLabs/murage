import type { HistoryRequest, HistorySource, ProcedureVersion } from "./procedure-history";
export interface MemoryEvolutionStatus {
  authorized:boolean;
  corpus:{id:string;version:string;kind:"synthetic"};
  policy:{revision:string};
  job:null|{id:string;status:"pending"|"running"|"waiting"|"deferred"|"complete"|"blocked";reason:string|null;started:boolean;decision:"accepted"|"rejected"|"no-change"|null;publishedRevision:string|null;costKnown:boolean;actualCostUsd:number|null;heldout:null|{corpusDigest:string;untouched:true;cases:number;baseline:number;candidate:number;regressions:number}};
}
export type MemoryEvolutionKind="recall"|"classification";
export type MemoryEvolutionAction={action:"evolution-authorize"}|{action:"evolution-authorize-classification"}|{action:"evolution-retry";jobId:string};
export const canRetryMemoryEvolution=(status:MemoryEvolutionStatus)=>status.authorized&&status.job?.status==="deferred"&&status.job.started;
export function memoryEvolutionReason(status:MemoryEvolutionStatus,kind:MemoryEvolutionKind="recall"):string {
  const job=status.job;if(!job)return `No ${kind} improvement check has been requested.`;
  if(job.status==="complete")return job.decision==="accepted"?(job.publishedRevision?`An improved ${kind} policy was applied.`:"The evaluation passed; application has not been recorded."):job.decision==="no-change"?"No improvement was found. The current policy was retained.":job.decision==="rejected"?"The candidate was rejected. No policy was applied by this check.":"The check finished without a recorded result.";
  if(job.status==="running")return `Checking ${kind} changes against synthetic examples.`;
  if(job.status==="pending")return `The ${kind} check is queued.`;
  const reasons:Record<string,string>={
    "extractor-busy":"Waiting for current memory processing to finish.",
    "extractor-unavailable":"Waiting for an available learning connection.",
    "MEMORY_EXTRACTOR_UNAVAILABLE":"Waiting for an available learning connection.",
    "MEMORY_EVOLUTION_MODEL_UNAVAILABLE":"Waiting for an available learning connection.",
    "GEPA_EXTRACTOR_UNAVAILABLE":"Waiting for an available learning connection.",
    "MEMORY_EVOLUTION_ADMISSION_REQUIRED":"Waiting for current authorization and automatic-learning settings.",
    "GEPA_COST_AUTHORITY_REQUIRED":"Your spending limit requires reliable cost information before this check can run.",
    "cost-estimate-unavailable":"Your spending limit requires reliable cost information before this check can run.",
    "budget-exhausted":"The memory processing limit has been reached.",
    "MEMORY_EVOLUTION_INTERRUPTED":"The earlier check was interrupted after it started.",
    "GEPA_RESOURCE_UNAVAILABLE":"Memory improvement tools are unavailable on this installation.",
    "GEPA_BUNDLED_RESOURCE_UNAVAILABLE":"Memory improvement tools are unavailable on this installation.",
  };
  return reasons[job.reason??""]??(job.status==="blocked"?"This check is blocked because its inputs or authority changed.":job.started?"The check stopped after it started. It has not been retried automatically.":"The check is waiting for its requirements to become available.");
}
export function memoryEvolutionCost(status:MemoryEvolutionStatus):string {
  const job=status.job;
  return job?.costKnown&&typeof job.actualCostUsd==="number"&&Number.isFinite(job.actualCostUsd)&&job.actualCostUsd>=0
    ?job.actualCostUsd.toLocaleString("en-US",{style:"currency",currency:"USD",minimumFractionDigits:2,maximumFractionDigits:6})
    :"Cost unavailable";
}
export async function runMemoryEvolutionAction(request:HistoryRequest,status:MemoryEvolutionStatus,action:MemoryEvolutionAction):Promise<MemoryEvolutionStatus> {
  if(action.action==="evolution-retry"&&(!canRetryMemoryEvolution(status)||status.job?.id!==action.jobId))throw Error("This check cannot be retried from its current state. Refresh its status.");
  return request("/api/memory/action",{method:"POST",body:JSON.stringify(action)});
}
interface EvolutionHistoryRow {revision:string;origin?:string;createdAt:number;rollbackOf?:string}
export function memoryEvolutionHistorySource(request:HistoryRequest,onRestored:()=>Promise<void>):HistorySource {
  return {load:async()=>{
    const result=await request("/api/memory/action",{method:"POST",body:JSON.stringify({action:"evolution-history"})}) as {current:{revision:string};revisions:EvolutionHistoryRow[]};
    if(!result.current?.revision||!Array.isArray(result.revisions))throw Error("Recall policy history is unavailable.");
    const versions:ProcedureVersion[]=result.revisions.map(row=>({revision:row.revision,origin:row.origin,createdAt:row.createdAt,rollbackOf:row.rollbackOf,description:row.origin==="rollback"?"Previously restored memory policy.":row.origin==="evaluated"?"Memory policy retained after evaluation on synthetic examples.":"Retained memory policy."}));
    if(result.current.revision!=="baseline")versions.push({revision:"baseline",createdAt:"",description:"Built-in memory policy before evaluated changes."});
    return {currentRevision:result.current.revision,current:versions.find(row=>row.revision===result.current.revision),revisions:versions.filter(row=>row.revision!==result.current.revision)};
  },restore:async(history,target)=>{
    if(!history.currentRevision||!target.revision)throw Error("Recall policy revision is unavailable. Refresh versions.");
    await request("/api/memory/action",{method:"POST",body:JSON.stringify({action:"evolution-rollback",expectedRevision:history.currentRevision,targetRevision:target.revision})});await onRestored();
  }};
}
