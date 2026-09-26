import { useEffect, useMemo, useRef, useSyncExternalStore, useState } from "react";
import { api } from "@/state/store";
import { memoryButtonClass, memoryInputClass } from "./MemoryReview";
import { canAuthorizeProcedurePreview, canRetryProcedureEvaluation, createProcedureAdmissionStore, procedurePreviewReason, type ProcedureEvolutionStatus } from "@/lib/procedure-evaluation-admissions";
const button=memoryButtonClass+" min-h-11";
export function ProcedureEvaluationAdmissions({status,disabled=false,onRefresh}:{status:ProcedureEvolutionStatus|null;disabled?:boolean;onRefresh:()=>Promise<void>}) {
  const store=useMemo(()=>createProcedureAdmissionStore(api),[]),state=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot);
  const [refreshing,setRefreshing]=useState(false),[refreshError,setRefreshError]=useState<string|null>(null),heading=useRef<HTMLHeadingElement>(null),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{if(state.preview)heading.current?.focus();},[state.preview?.previewId]);
  const selectedReview=status?.reviews.find(review=>review.id===state.selectedId);
  const selectedPresent=Boolean(selectedReview);
  const preview=state.preview,busy=disabled||state.busy||refreshing;
  const refresh=async()=>{setRefreshing(true);setRefreshError(null);try{await onRefresh();}catch{if(mounted.current)setRefreshError("Could not refresh waiting procedure reviews.");}finally{if(mounted.current)setRefreshing(false);}};
  return <section aria-label="Procedure evaluation permissions" className="rounded-lg border border-hairline/40 p-3">
    <h3 className="text-[14px] font-medium">Procedure evaluation permissions</h3>
    <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">Select a waiting review to inspect the exact instructions that would be sent for evaluation. Procedures without a compatible test set remain waiting.</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <label className="min-w-0 flex-1 text-[13px]">Waiting review<select aria-label="Waiting procedure review" value={state.selectedId} disabled={busy||!status?.reviews.length} className={memoryInputClass+" mt-1 min-h-11 w-full"} onChange={event=>void store.select(event.target.value)}><option value="">Select a procedure</option>{status?.reviews.map(review=><option key={review.id} value={review.id}>{review.target.kind==="skill"?"Skill":"Routine"}: {review.target.artifactId}{review.started?" · Started":" · Waiting"}</option>)}</select></label>
      <button type="button" className={button+" self-end"} disabled={busy} onClick={()=>void refresh()}>Refresh procedure reviews</button>
    </div>
    {!status?<p role="status" className="mt-2 text-[12px] text-ink-secondary">Procedure review status is unavailable.</p>:!status.reviews.length?<p role="status" className="mt-2 text-[12px] text-ink-secondary">No procedure reviews are waiting.</p>:<p className="mt-2 text-[12px] text-ink-secondary">Showing up to {status.max} waiting reviews. A listed review is not permission to send its contents.</p>}
    {state.loading&&<p role="status" className="mt-2 text-[13px] text-ink-secondary">Loading the selected procedure preview…</p>}
    {(state.error||refreshError)&&<p role="alert" className="mt-2 break-words text-[13px] text-danger">{state.error??refreshError}</p>}
    {state.notice&&<p role="status" className="mt-2 text-[13px] text-ink-secondary">{state.notice}</p>}
    {state.selectedId&&(state.stale||state.error)&&<button type="button" className={button+" mt-2"} disabled={busy||state.loading} onClick={()=>void store.select(state.selectedId)}>Refresh procedure preview</button>}
    {preview&&<div className="mt-3 space-y-3 border-t border-hairline/50 pt-3">
      <h4 ref={heading} tabIndex={-1} className="break-words text-[13px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">{preview.target.kind==="skill"?"Skill":"Routine"}: {preview.target.artifactId}</h4>
      <dl className="grid min-w-0 gap-x-3 gap-y-1 text-[12px] sm:grid-cols-[auto_minmax(0,1fr)]"><dt className="text-ink-secondary">Audience</dt><dd className="break-words">{preview.audienceLabel}</dd><dt className="text-ink-secondary">Sent to</dt><dd className="break-words">{preview.model?.label??"No learning connection available"}</dd><dt className="text-ink-secondary">Test set</dt><dd className="break-words">{preview.corpus.description} · version {preview.corpus.version}</dd></dl>
      <p className="text-[12px] text-ink-secondary">{selectedPresent?procedurePreviewReason(preview):"This review is no longer in the waiting list. Refresh procedure reviews before continuing."}</p>
      <div><p className="mb-1 text-[12px] font-medium">Exact instructions sent for evaluation</p><pre tabIndex={0} aria-label="Exact procedure instructions" className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-hairline/40 bg-inset p-3 font-mono text-[12px] leading-relaxed focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">{preview.instruction}</pre></div>
      {preview.eventEvidenceIncluded===false&&<p className="text-[12px] leading-relaxed text-ink-secondary">Only these instructions and the synthetic test examples are sent. Retained conversation evidence stays local.</p>}
      <p className="text-[12px] leading-relaxed text-ink-secondary">Permission can cover later evaluated revisions of this procedure with the same audience, model and test set. An owner edit requires a new review. Existing processing limits apply.</p>
      {preview.reusableGrant?<p role="status" className="text-[13px] font-medium">Already authorized for this scope.</p>:<button type="button" className={button} disabled={busy||state.stale||!selectedPresent||!canAuthorizeProcedurePreview(preview)} onClick={()=>{void store.authorize().then(authorized=>{if(authorized)void refresh();});}}>Allow this procedure evaluation</button>}
      {canRetryProcedureEvaluation(selectedReview,preview)&&<button type="button" className={button} disabled={busy||state.stale} onClick={()=>{void store.retry(selectedReview!).then(retried=>{if(retried)void refresh();});}}>Retry evaluation</button>}
      {preview.reason&&<details className="text-[12px] text-ink-secondary"><summary className={button+" cursor-pointer"}>Evaluation details</summary><p className="break-all font-mono">{preview.reason}</p></details>}
    </div>}
  </section>;
}
