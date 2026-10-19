import type { HistoryRequest } from "./procedure-history";
import { t } from "./i18n";
export interface PendingProcedureReview {
  id:string;target:{kind:"skill"|"routine";ownerId:string;artifactId:string;scopeId:string;threadId:string;baseRevision:string};
  status:string;reason:string|null;started:boolean;
}
export interface ProcedureEvolutionStatus {reviews:PendingProcedureReview[];max:number}
export interface ProcedureEvaluationPreview {
  previewId:string;reviewId:string;instruction:string;
  target:{kind:"skill"|"routine";artifactId:string;ownerId:string;scopeId:string};
  audienceLabel:string;model:{identity:string;label:string}|null;
  corpus:{id:string;version:string;kind:"synthetic";description:string};
  eventEvidenceIncluded:boolean;eligible:boolean;reason:string|null;reusableGrant:boolean;
}
export function canAuthorizeProcedurePreview(preview:ProcedureEvaluationPreview):boolean {
  return preview.eligible&&!preview.reusableGrant&&preview.model!==null&&preview.eventEvidenceIncluded===false&&preview.corpus.kind==="synthetic";
}
export function canRetryProcedureEvaluation(review:PendingProcedureReview|undefined,preview:ProcedureEvaluationPreview|null):boolean {
  return Boolean(review&&preview&&review.id===preview.reviewId&&review.status==="deferred"&&review.started&&preview.reusableGrant&&preview.eventEvidenceIncluded===false&&preview.corpus.kind==="synthetic");
}
export function procedurePreviewReason(preview:ProcedureEvaluationPreview):string {
  if(preview.eventEvidenceIncluded)return t("procedureAdmissions.reasonEvidence");
  if(preview.reusableGrant)return t("procedureAdmissions.reasonGrant");
  if(!preview.model)return t("procedureAdmissions.reasonNoModel");
  if(!preview.eligible)return t("procedureAdmissions.reasonIneligible");
  return t("procedureAdmissions.reasonReview");
}
export interface ProcedureAdmissionState {selectedId:string;preview:ProcedureEvaluationPreview|null;loading:boolean;busy:boolean;error:string|null;notice:string|null;stale:boolean}
export function createProcedureAdmissionStore(request:HistoryRequest) {
  let state:ProcedureAdmissionState={selectedId:"",preview:null,loading:false,busy:false,error:null,notice:null,stale:false},generation=0;
  const listeners=new Set<()=>void>(),set=(patch:Partial<ProcedureAdmissionState>)=>{state={...state,...patch};listeners.forEach(listener=>listener());};
  const select=async(reviewId:string)=>{
    if(state.busy)return;const token=++generation;set({selectedId:reviewId,preview:null,error:null,notice:null,stale:false,loading:Boolean(reviewId)});
    if(!reviewId)return;
    try{const preview=await request("/api/memory/action",{method:"POST",body:JSON.stringify({action:"procedure-evaluation-preview",reviewId})}) as ProcedureEvaluationPreview;
      if(token!==generation)return;if(preview.reviewId!==reviewId||!preview.previewId||typeof preview.instruction!=="string")throw Error(t("procedureAdmissions.errMismatch"));set({preview});}
    catch(error){if(token===generation)set({error:error instanceof Error?error.message:t("procedureAdmissions.errLoad")});}
    finally{if(token===generation)set({loading:false});}
  };
  return {subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},getSnapshot:()=>state,select,
    retry:async(review:PendingProcedureReview)=>{
      const preview=state.preview;if(state.busy||state.loading||state.stale||!canRetryProcedureEvaluation(review,preview))return false;
      set({busy:true,error:null,notice:null});
      try{const result=await request("/api/memory/action",{method:"POST",body:JSON.stringify({action:"procedure-evaluation-retry",reviewId:review.id})});
        if(result.authorized!==true||result.reviewId!==review.id)throw Error(t("procedureAdmissions.errRetryNotConfirmed"));
        set({selectedId:"",preview:null,notice:t("procedureAdmissions.noticeRetry")});return true;}
      catch(error){const stale=typeof error==="object"&&error!==null&&"status" in error&&error.status===409;set({stale,error:stale?t("procedureAdmissions.errStaleRetry"):error instanceof Error?error.message:t("procedureAdmissions.errRetryFail")});return false;}
      finally{set({busy:false});}
    },
    authorize:async()=>{
      const preview=state.preview;if(state.busy||state.loading||state.stale||!preview||!canAuthorizeProcedurePreview(preview))return false;
      set({busy:true,error:null,notice:null});
      try{const result=await request("/api/memory/action",{method:"POST",body:JSON.stringify({action:"procedure-evaluation-authorize",previewId:preview.previewId})});
        if(result.authorized!==true||result.reviewId!==preview.reviewId)throw Error(t("procedureAdmissions.errAuthNotConfirmed"));
        set({selectedId:"",preview:null,notice:t("procedureAdmissions.noticeAuth")});return true;}
      catch(error){const stale=typeof error==="object"&&error!==null&&"status" in error&&error.status===409;set({stale,error:stale?t("procedureAdmissions.errStaleAuth"):error instanceof Error?error.message:t("procedureAdmissions.errAuthFail")});return false;}
      finally{set({busy:false});}
    }};
}
