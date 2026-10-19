import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/state/store";
import { useAction } from "@/lib/use-action";
import { ActionButton } from "./ActionButton";
import { memoryButtonClass } from "./MemoryReview";
import { t } from "@/lib/i18n";
import { ProcedureVersionHistory } from "./ProcedureVersionHistory";
import { canRetryMemoryEvolution, memoryEvolutionHistorySource, memoryEvolutionKindWord, memoryEvolutionReason, runMemoryEvolutionAction, type MemoryEvolutionAction, type MemoryEvolutionStatus, type MemoryEvolutionKind } from "@/lib/memory-evolution-controls";
const evolutionButtonClass=memoryButtonClass+" min-h-11";
export function MemoryEvolutionControls({status,disabled=false,onRefresh,kind="recall"}:{status:MemoryEvolutionStatus|null;disabled?:boolean;onRefresh:()=>Promise<void>;kind?:MemoryEvolutionKind}) {
  const classification=kind==="classification",title=classification?t("memoryEvolution.titleClassification"):t("memoryEvolution.titleRecall"),word=memoryEvolutionKindWord(kind);
  const [pollError,setPollError]=useState<string|null>(null),mounted=useRef(true),refresh=useRef(onRefresh);refresh.current=onRefresh;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const history=useMemo(()=>memoryEvolutionHistorySource(api,()=>refresh.current()),[]);
  // Poll only while a finite check is queued/running, and only while this
  // owner surface is mounted. Waiting/deferred jobs require a real state change.
  useEffect(()=>{
    if(status?.job?.status!=="pending"&&status?.job?.status!=="running")return;
    let refreshing=false;const timer=setInterval(()=>{if(refreshing)return;refreshing=true;setPollError(null);void refresh.current().catch(()=>{if(mounted.current)setPollError(t("memoryEvolution.refreshFailed",{kind:word}));}).finally(()=>{refreshing=false;});},3000);
    return()=>clearInterval(timer);
  },[status?.job?.status,kind]);
  const apply=async(action:MemoryEvolutionAction)=>{if(!status)return;await runMemoryEvolutionAction(api,status,action);await onRefresh();};
  const authorize=useAction(async()=>apply({action:classification?"evolution-authorize-classification":"evolution-authorize"}),{idle:t("memoryEvolution.enable",{kind:word}),pending:t("memoryEvolution.enabling"),success:t("memoryEvolution.enabled",{kind:word}),failure:t("memoryEvolution.updateFailed",{kind:word})});
  const retry=useAction(async()=>apply({action:"evolution-retry",jobId:status!.job!.id}),{idle:t("memoryEvolution.retry"),pending:t("memoryEvolution.retrying"),success:t("memoryEvolution.retryRequested"),failure:t("memoryEvolution.updateFailed",{kind:word})});
  const reread=useAction(async()=>onRefresh(),{idle:t("memoryEvolution.refreshStatus",{kind:word}),pending:t("memoryEvolution.refreshing"),success:t("memoryEvolution.upToDate"),failure:t("memoryEvolution.refreshFailed",{kind:word})});
  const blocked=disabled||authorize.pending||retry.pending||reread.pending;
  const heldout=status?.job?.heldout;
  return <section aria-label={title} className="rounded-lg border border-hairline/40 p-3">
    <h3 className="text-[14px] font-medium">{title}</h3>
    <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{t("memoryEvolution.intro",{kind:word})}</p>
    <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{classification?t("memoryEvolution.scopeClassification"):t("memoryEvolution.scopeRecall")}</p>
    {!status?<p role="status" className="mt-2 text-[13px] text-ink-secondary">{classification?t("memoryEvolution.statusUnavailableClassification"):t("memoryEvolution.statusUnavailableRecall")}</p>:<>
      <p className="mt-3 text-[13px] font-medium">{status.authorized?t("memoryEvolution.authorized"):t("memoryEvolution.notEnabled")}</p>
      <p role="status" className="mt-1 break-words text-[13px] text-ink-secondary">{memoryEvolutionReason(status,kind)}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {!status.authorized&&<ActionButton action={authorize} className={evolutionButtonClass} blocked={blocked}>{t("memoryEvolution.enable",{kind:word})}</ActionButton>}
        {canRetryMemoryEvolution(status)&&<ActionButton action={retry} className={evolutionButtonClass} blocked={blocked}>{t("memoryEvolution.retry")}</ActionButton>}
        <ActionButton action={reread} className={evolutionButtonClass} blocked={blocked}>{t("memoryEvolution.refreshStatus",{kind:word})}</ActionButton>
      </div>
      {heldout&&<div className="mt-3 space-y-1 text-[12px] text-ink-secondary"><p className="font-medium text-ink">{t("memoryEvolution.lastHeldout")}</p><p>{t(classification?"memoryEvolution.heldoutScoreClassification":"memoryEvolution.heldoutScoreRecall",{cases:heldout.cases,baseline:heldout.baseline.toFixed(3),candidate:heldout.candidate.toFixed(3)})}</p><p>{t("memoryEvolution.regressions",{regressions:heldout.regressions})}</p></div>}
      {status.job?.reason&&<div className="mt-2 text-[12px] text-ink-secondary"><p className="font-medium text-ink">{t("memoryEvolution.checkDetails")}</p><p className="mt-1 break-all font-mono">{status.job.reason}</p></div>}
      <ProcedureVersionHistory source={history} label={t("memoryEvolution.historyLabel")} scopeLabel={t("memoryEvolution.historyScope")} disabledReason={blocked?t("memoryEvolution.waitSettings"):undefined}/>
    </>}
    {pollError&&<p role="alert" className="mt-2 break-words text-[13px] text-danger">{pollError}</p>}
  </section>;
}
