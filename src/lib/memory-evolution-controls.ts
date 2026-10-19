import type { HistoryRequest, HistorySource, ProcedureVersion } from "./procedure-history";
import type { LocaleKey } from "@/locales";
import { t } from "./i18n";
export interface MemoryEvolutionStatus {
  authorized:boolean;
  corpus:{id:string;version:string;kind:"synthetic"};
  policy:{revision:string};
  job:null|{id:string;status:"pending"|"running"|"waiting"|"deferred"|"complete"|"blocked";reason:string|null;started:boolean;decision:"accepted"|"rejected"|"no-change"|null;publishedRevision:string|null;heldout:null|{corpusDigest:string;untouched:true;cases:number;baseline:number;candidate:number;regressions:number}};
}
export type MemoryEvolutionKind="recall"|"classification";
export type MemoryEvolutionAction={action:"evolution-authorize"}|{action:"evolution-authorize-classification"}|{action:"evolution-retry";jobId:string};
export const canRetryMemoryEvolution=(status:MemoryEvolutionStatus)=>status.authorized&&status.job?.status==="deferred"&&status.job.started;
export const memoryEvolutionKindWord=(kind:MemoryEvolutionKind):string=>t(kind==="classification"?"memoryEvolution.kindClassification":"memoryEvolution.kindRecall");
export function memoryEvolutionReason(status:MemoryEvolutionStatus,kind:MemoryEvolutionKind="recall"):string {
  const word=memoryEvolutionKindWord(kind);
  const job=status.job;if(!job)return t("memoryEvolution.reasonNone",{kind:word});
  if(job.status==="complete")return job.decision==="accepted"?(job.publishedRevision?t("memoryEvolution.reasonApplied",{kind:word}):t("memoryEvolution.reasonPassedUnrecorded")):job.decision==="no-change"?t("memoryEvolution.reasonNoChange"):job.decision==="rejected"?t("memoryEvolution.reasonRejected"):t("memoryEvolution.reasonFinishedNoResult");
  if(job.status==="running")return t("memoryEvolution.reasonRunning",{kind:word});
  if(job.status==="pending")return t("memoryEvolution.reasonQueued",{kind:word});
  const reasons:Record<string,LocaleKey>={
    "extractor-busy":"memoryEvolution.reasonExtractorBusy",
    "extractor-unavailable":"memoryEvolution.reasonConnection",
    "MEMORY_EXTRACTOR_UNAVAILABLE":"memoryEvolution.reasonConnection",
    "MEMORY_EVOLUTION_MODEL_UNAVAILABLE":"memoryEvolution.reasonConnection",
    "GEPA_EXTRACTOR_UNAVAILABLE":"memoryEvolution.reasonConnection",
    "MEMORY_EVOLUTION_ADMISSION_REQUIRED":"memoryEvolution.reasonAdmission",
    "GEPA_COST_AUTHORITY_REQUIRED":"memoryEvolution.reasonCostAuthority",
    "budget-exhausted":"memoryEvolution.reasonBudget",
    "MEMORY_EVOLUTION_INTERRUPTED":"memoryEvolution.reasonInterrupted",
    "GEPA_RESOURCE_UNAVAILABLE":"memoryEvolution.reasonResource",
    "GEPA_BUNDLED_RESOURCE_UNAVAILABLE":"memoryEvolution.reasonResource",
  };
  const known=reasons[job.reason??""];return known?t(known):job.status==="blocked"?t("memoryEvolution.reasonBlocked"):job.started?t("memoryEvolution.reasonStopped"):t("memoryEvolution.reasonWaitingRequirements");
}
export async function runMemoryEvolutionAction(request:HistoryRequest,status:MemoryEvolutionStatus,action:MemoryEvolutionAction):Promise<MemoryEvolutionStatus> {
  if(action.action==="evolution-retry"&&(!canRetryMemoryEvolution(status)||status.job?.id!==action.jobId))throw Error(t("memoryEvolution.errRetryState"));
  return request("/api/memory/action",{method:"POST",body:JSON.stringify(action)});
}
interface EvolutionHistoryRow {revision:string;origin?:string;createdAt:number;rollbackOf?:string}
export function memoryEvolutionHistorySource(request:HistoryRequest,onRestored:()=>Promise<void>):HistorySource {
  return {load:async()=>{
    const result=await request("/api/memory/action",{method:"POST",body:JSON.stringify({action:"evolution-history"})}) as {current:{revision:string};revisions:EvolutionHistoryRow[]};
    if(!result.current?.revision||!Array.isArray(result.revisions))throw Error(t("memoryEvolution.errHistoryUnavailable"));
    const versions:ProcedureVersion[]=result.revisions.map(row=>({revision:row.revision,origin:row.origin,createdAt:row.createdAt,rollbackOf:row.rollbackOf,description:row.origin==="rollback"?t("memoryEvolution.descRollback"):row.origin==="evaluated"?t("memoryEvolution.descEvaluated"):t("memoryEvolution.descRetained")}));
    if(result.current.revision!=="baseline")versions.push({revision:"baseline",createdAt:"",description:t("memoryEvolution.descBaseline")});
    return {currentRevision:result.current.revision,current:versions.find(row=>row.revision===result.current.revision),revisions:versions.filter(row=>row.revision!==result.current.revision)};
  },restore:async(history,target)=>{
    if(!history.currentRevision||!target.revision)throw Error(t("memoryEvolution.errRevisionUnavailable"));
    await request("/api/memory/action",{method:"POST",body:JSON.stringify({action:"evolution-rollback",expectedRevision:history.currentRevision,targetRevision:target.revision})});await onRestored();
  }};
}
