import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { api } from "@/state/store";
import { useAction } from "@/lib/use-action";
import { ActionButton } from "./ActionButton";
import { t } from "@/lib/i18n";
import { memoryButtonClass, memoryInputClass } from "./MemoryReview";
import { canAuthorizeProcedurePreview, canRetryProcedureEvaluation, createProcedureAdmissionStore, procedurePreviewReason, type ProcedureEvolutionStatus } from "@/lib/procedure-evaluation-admissions";
const button=memoryButtonClass+" min-h-11";
export function ProcedureEvaluationAdmissions({status,disabled=false,onRefresh}:{status:ProcedureEvolutionStatus|null;disabled?:boolean;onRefresh:()=>Promise<void>}) {
  const store=useMemo(()=>createProcedureAdmissionStore(api),[]),state=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot);
  const heading=useRef<HTMLHeadingElement>(null),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{if(state.preview)heading.current?.focus();},[state.preview?.previewId]);
  const selectedReview=status?.reviews.find(review=>review.id===state.selectedId);
  const selectedPresent=Boolean(selectedReview);
  const reread=useAction(async()=>onRefresh(),{idle:t("procedureAdmissions.refreshReviews"),pending:t("procedureAdmissions.refreshing"),success:t("procedureAdmissions.upToDate"),failure:t("procedureAdmissions.refreshFailed")});
  const preview=state.preview,busy=disabled||state.busy||reread.pending;
  const refresh=async()=>{await reread.run();};
  return <section aria-label={t("procedureAdmissions.title")} className="rounded-lg border border-hairline/40 p-3">
    <h3 id="memory-procedures-heading" className="text-[14px] font-medium">{t("procedureAdmissions.title")}</h3>
    <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{t("procedureAdmissions.intro")}</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <label className="min-w-0 flex-1 text-[13px]">{t("procedureAdmissions.waitingReview")}<select aria-label={t("procedureAdmissions.selectAria")} value={state.selectedId} disabled={busy||!status?.reviews.length} className={memoryInputClass+" mt-1 min-h-11 w-full"} onChange={event=>void store.select(event.target.value)}><option value="">{t("procedureAdmissions.selectPlaceholder")}</option>{status?.reviews.map(review=><option key={review.id} value={review.id}>{t(review.started?"procedureAdmissions.optionStarted":"procedureAdmissions.optionWaiting",{kind:review.target.kind==="skill"?t("procedureAdmissions.kindSkill"):t("procedureAdmissions.kindRoutine"),id:review.target.artifactId})}</option>)}</select></label>
      <span className="self-end"><ActionButton action={reread} className={button} blocked={busy} layout="below">{t("procedureAdmissions.refreshReviews")}</ActionButton></span>
    </div>
    {!status?<p role="status" className="mt-2 text-[12px] text-ink-secondary">{t("procedureAdmissions.statusUnavailable")}</p>:!status.reviews.length?<p role="status" className="mt-2 text-[12px] text-ink-secondary">{t("procedureAdmissions.noneWaiting")}</p>:<p className="mt-2 text-[12px] text-ink-secondary">{t("procedureAdmissions.showingUpTo",{max:status.max})}</p>}
    {state.loading&&<p role="status" className="mt-2 text-[13px] text-ink-secondary">{t("procedureAdmissions.loadingPreview")}</p>}
    {state.error&&<p role="alert" className="mt-2 break-words text-[13px] text-danger">{state.error}</p>}
    {state.notice&&<p role="status" className="mt-2 text-[13px] text-ink-secondary">{state.notice}</p>}
    {state.selectedId&&(state.stale||state.error)&&<button type="button" className={button+" mt-2"} disabled={busy||state.loading} onClick={()=>void store.select(state.selectedId)}>{t("procedureAdmissions.refreshPreview")}</button>}
    {preview&&<div className="mt-3 space-y-3 border-t border-hairline/50 pt-3">
      <h4 ref={heading} tabIndex={-1} className="break-words text-[13px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">{t("procedureAdmissions.targetLabel",{kind:preview.target.kind==="skill"?t("procedureAdmissions.kindSkill"):t("procedureAdmissions.kindRoutine"),id:preview.target.artifactId})}</h4>
      <dl className="grid min-w-0 gap-x-3 gap-y-1 text-[12px] sm:grid-cols-[auto_minmax(0,1fr)]"><dt className="text-ink-secondary">{t("procedureAdmissions.audience")}</dt><dd className="break-words">{preview.audienceLabel}</dd><dt className="text-ink-secondary">{t("procedureAdmissions.sentTo")}</dt><dd className="break-words">{preview.model?.label??t("procedureAdmissions.noConnection")}</dd><dt className="text-ink-secondary">{t("procedureAdmissions.testSet")}</dt><dd className="break-words">{t("procedureAdmissions.testSetValue",{description:preview.corpus.description,version:preview.corpus.version})}</dd></dl>
      <p className="text-[12px] text-ink-secondary">{selectedPresent?procedurePreviewReason(preview):t("procedureAdmissions.noLongerWaiting")}</p>
      <div><p className="mb-1 text-[12px] font-medium">{t("procedureAdmissions.exactSent")}</p><pre tabIndex={0} aria-label={t("procedureAdmissions.exactAria")} className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-hairline/40 bg-inset p-3 font-mono text-[12px] leading-relaxed focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">{preview.instruction}</pre></div>
      {preview.eventEvidenceIncluded===false&&<p className="text-[12px] leading-relaxed text-ink-secondary">{t("procedureAdmissions.onlySent")}</p>}
      <p className="text-[12px] leading-relaxed text-ink-secondary">{t("procedureAdmissions.permissionCovers")}</p>
      {preview.reusableGrant?<p role="status" className="text-[13px] font-medium">{t("procedureAdmissions.alreadyAuthorized")}</p>:<button type="button" className={button} disabled={busy||state.stale||!selectedPresent||!canAuthorizeProcedurePreview(preview)} onClick={()=>{void store.authorize().then(authorized=>{if(authorized)void refresh();});}}>{t("procedureAdmissions.allow")}</button>}
      {canRetryProcedureEvaluation(selectedReview,preview)&&<button type="button" className={button} disabled={busy||state.stale} onClick={()=>{void store.retry(selectedReview!).then(retried=>{if(retried)void refresh();});}}>{t("procedureAdmissions.retryEval")}</button>}
      {preview.reason&&<div className="text-[12px] text-ink-secondary"><p className="font-medium text-ink">{t("procedureAdmissions.evalDetails")}</p><p className="break-all font-mono">{preview.reason}</p></div>}
    </div>}
  </section>;
}
