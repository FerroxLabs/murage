import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/state/store";
import { memoryButtonClass } from "./MemoryReview";
import { ProcedureVersionHistory } from "./ProcedureVersionHistory";
import { canRetryMemoryEvolution, memoryEvolutionCost, memoryEvolutionHistorySource, memoryEvolutionReason, runMemoryEvolutionAction, type MemoryEvolutionAction, type MemoryEvolutionStatus, type MemoryEvolutionKind } from "@/lib/memory-evolution-controls";
const evolutionButtonClass=memoryButtonClass+" min-h-11";
export function MemoryEvolutionControls({status,disabled=false,onRefresh,kind="recall"}:{status:MemoryEvolutionStatus|null;disabled?:boolean;onRefresh:()=>Promise<void>;kind?:MemoryEvolutionKind}) {
  const classification=kind==="classification",title=classification?"Tested classification improvements":"Tested recall improvements";
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null),mounted=useRef(true),refresh=useRef(onRefresh);refresh.current=onRefresh;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const history=useMemo(()=>memoryEvolutionHistorySource(api,()=>refresh.current()),[]);
  // Poll only while a finite check is queued/running, and only while this
  // owner surface is mounted. Waiting/deferred jobs require a real state change.
  useEffect(()=>{
    if(status?.job?.status!=="pending"&&status?.job?.status!=="running")return;
    let refreshing=false;const timer=setInterval(()=>{if(refreshing)return;refreshing=true;void refresh.current().catch(()=>{if(mounted.current)setError(`Could not refresh ${kind} check status.`);}).finally(()=>{refreshing=false;});},3000);
    return()=>clearInterval(timer);
  },[status?.job?.status,kind]);
  const run=async(action:MemoryEvolutionAction)=>{
    if(!status||busy||disabled)return;setBusy(true);setError(null);setNotice(null);
    try{await runMemoryEvolutionAction(api,status,action);await onRefresh();if(mounted.current)setNotice(action.action!=="evolution-retry"?`The shipped synthetic ${kind} check is authorized.`:"Retry requested for this check.");}
    catch(cause){if(mounted.current)setError(cause instanceof Error?cause.message:`Could not update ${kind} improvements.`);}
    finally{if(mounted.current)setBusy(false);}
  };
  const heldout=status?.job?.heldout;
  return <section aria-label={title} className="rounded-lg border border-hairline/40 p-3">
    <h3 className="text-[14px] font-medium">{title}</h3>
    <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">Let Murage test {kind} changes using shipped synthetic examples. It applies a change only when held-out checks improve without regressions. Your private conversations are not used as this check’s training examples.</p>
    <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{classification?"These checks cover classification of synthetic source statements.":"These checks cover recall selection."} Existing automatic-learning choices and processing limits still apply.</p>
    {!status?<p role="status" className="mt-2 text-[13px] text-ink-secondary">{classification?"Classification improvement status is unavailable.":"Recall improvement status is unavailable."}</p>:<>
      <p className="mt-3 text-[13px] font-medium">{status.authorized?"Authorized for shipped synthetic examples":"Not enabled"}</p>
      <p role="status" className="mt-1 break-words text-[13px] text-ink-secondary">{memoryEvolutionReason(status,kind)}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {!status.authorized&&<button type="button" className={evolutionButtonClass} disabled={disabled||busy} onClick={()=>void run({action:classification?"evolution-authorize-classification":"evolution-authorize"})}>{`Enable tested ${kind} improvements`}</button>}
        {canRetryMemoryEvolution(status)&&<button type="button" className={evolutionButtonClass} disabled={disabled||busy} onClick={()=>void run({action:"evolution-retry",jobId:status.job!.id})}>Retry interrupted check</button>}
        <button type="button" className={evolutionButtonClass} disabled={disabled||busy} onClick={()=>{setBusy(true);setError(null);void onRefresh().catch(()=>{if(mounted.current)setError(`Could not refresh ${kind} check status.`);}).finally(()=>{if(mounted.current)setBusy(false);});}}>{`Refresh ${kind} status`}</button>
      </div>
      {status.job&&<p className="mt-2 text-[12px] text-ink-secondary">{memoryEvolutionCost(status)}.</p>}
      {heldout&&<div className="mt-3 space-y-1 text-[12px] text-ink-secondary"><p className="font-medium text-ink">Last held-out result</p><p>{heldout.cases} synthetic examples. {classification?"Classification":"Recall"} score: {heldout.baseline.toFixed(3)} before, {heldout.candidate.toFixed(3)} for the candidate.</p><p>Regressions: {heldout.regressions}. Scores describe the synthetic examples used in this check.</p></div>}
      {status.job?.reason&&<details className="mt-2 text-[12px] text-ink-secondary"><summary className={`${evolutionButtonClass} cursor-pointer`}>Check details</summary><p className="mt-1 break-all font-mono">{status.job.reason}</p></details>}
      <ProcedureVersionHistory source={history} label="Memory policy history" scopeLabel="Workspace memory policy" disabledReason={disabled||busy?"Wait for the current settings action to finish.":undefined}/>
    </>}
    {error&&<p role="alert" className="mt-2 break-words text-[13px] text-danger">{error}</p>}
    {notice&&<p role="status" className="mt-2 text-[13px] text-ink-secondary">{notice}</p>}
  </section>;
}
