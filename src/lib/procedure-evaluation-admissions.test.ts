import { expect, it, vi } from "vitest";
import { canAuthorizeProcedurePreview, canRetryProcedureEvaluation, createProcedureAdmissionStore, procedurePreviewReason, type ProcedureEvaluationPreview, type PendingProcedureReview } from "./procedure-evaluation-admissions";
const preview=(patch:Partial<ProcedureEvaluationPreview>={}):ProcedureEvaluationPreview=>({previewId:"preview-one",reviewId:"review-one",instruction:"PRIVATE INSTRUCTION\nCheck the saved result.",target:{kind:"skill",artifactId:"checked-method",ownerId:"bot",scopeId:"scope"},audienceLabel:"Owner's private bot",model:{identity:"model-one",label:"Selected learning connection"},corpus:{id:"procedure-outcome-groups",version:"1",kind:"synthetic",description:"Synthetic procedure outcomes"},eventEvidenceIncluded:false,eligible:true,reason:null,reusableGrant:false,...patch});
it("selection only previews; explicit admission sends the exact preview handle without raw evidence or client scope",async()=>{
  const request=vi.fn().mockResolvedValueOnce(preview()).mockResolvedValueOnce({authorized:true,reviewId:"review-one"});const store=createProcedureAdmissionStore(request);
  expect(request).not.toHaveBeenCalled();await store.select("review-one");expect(JSON.parse(request.mock.calls[0]![1].body)).toEqual({action:"procedure-evaluation-preview",reviewId:"review-one"});
  expect(request).toHaveBeenCalledTimes(1);expect(store.getSnapshot().preview?.instruction).toContain("PRIVATE INSTRUCTION");
  expect(await store.authorize()).toBe(true);expect(JSON.parse(request.mock.calls[1]![1].body)).toEqual({action:"procedure-evaluation-authorize",previewId:"preview-one"});
});
it("changed preview requires refreshed instructions and a new explicit authorization",async()=>{
  const request=vi.fn().mockResolvedValueOnce(preview()).mockRejectedValueOnce(Object.assign(Error("changed"),{status:409})).mockResolvedValueOnce(preview({previewId:"preview-two",instruction:"Owner edited instruction"})).mockResolvedValueOnce({authorized:true,reviewId:"review-one"}),store=createProcedureAdmissionStore(request);
  await store.select("review-one");expect(await store.authorize()).toBe(false);expect(store.getSnapshot().stale).toBe(true);await store.authorize();expect(request).toHaveBeenCalledTimes(2);
  await store.select("review-one");expect(store.getSnapshot().preview?.instruction).toBe("Owner edited instruction");expect(await store.authorize()).toBe(true);expect(JSON.parse(request.mock.calls[3]![1].body).previewId).toBe("preview-two");
});
it("retained evidence never opts in automatically and unsupported/already-authorized previews do not grant again",async()=>{
  for(const value of [preview({eventEvidenceIncluded:true}),preview({eligible:false}),preview({model:null}),preview({reusableGrant:true})]){
    const request=vi.fn().mockResolvedValue(value),store=createProcedureAdmissionStore(request);await store.select("review-one");expect(canAuthorizeProcedurePreview(value)).toBe(false);expect(await store.authorize()).toBe(false);expect(request).toHaveBeenCalledTimes(1);
  }
  expect(procedurePreviewReason(preview({eventEvidenceIncluded:true}))).toContain("separate data review");expect(procedurePreviewReason(preview({reusableGrant:true}))).toContain("Already allowed");
});
it("a slow prior selection cannot replace the currently selected review's instructions",async()=>{
  let finish!:(value:ProcedureEvaluationPreview)=>void;
  const request=vi.fn().mockImplementationOnce(()=>new Promise<ProcedureEvaluationPreview>(resolve=>finish=resolve)).mockResolvedValueOnce(preview({previewId:"second",reviewId:"review-two",instruction:"Second instruction"}));
  const store=createProcedureAdmissionStore(request),first=store.select("review-one");await store.select("review-two");finish(preview());await first;
  expect(store.getSnapshot().selectedId).toBe("review-two");expect(store.getSnapshot().preview?.instruction).toBe("Second instruction");
});

it("retry uses an existing valid grant only for its exact deferred started review",async()=>{
  const review:PendingProcedureReview={id:"review-one",target:{kind:"skill",ownerId:"bot",artifactId:"checked-method",scopeId:"scope",threadId:"thread",baseRevision:"base"},status:"deferred",reason:"quota",started:true};
  const value=preview({reusableGrant:true});
  expect(canRetryProcedureEvaluation(review,value)).toBe(true);
  for(const invalid of [{...review,started:false},{...review,status:"pending"},{...review,id:"different"}])expect(canRetryProcedureEvaluation(invalid,value)).toBe(false);
  expect(canRetryProcedureEvaluation(review,preview())).toBe(false);
  const request=vi.fn().mockResolvedValueOnce(value).mockResolvedValueOnce({authorized:true,reviewId:review.id}),store=createProcedureAdmissionStore(request);
  await store.select(review.id);expect(await store.retry(review)).toBe(true);
  expect(JSON.parse(request.mock.calls[1]![1].body)).toEqual({action:"procedure-evaluation-retry",reviewId:review.id});
  expect(store.getSnapshot().notice).toContain("existing procedure permission");
});
