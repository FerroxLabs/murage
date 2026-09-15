import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "@/state/store";
import { createHistoryStore, routineHistorySource, skillHistorySource, versionOrigin, type HistorySource, type ProcedureVersion } from "@/lib/procedure-history";
import type { Routine } from "@/lib/routines";
const button="min-h-11 rounded-md px-3 py-2 text-[12px] text-ink hover:bg-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50";
function Version({version,current=false}:{version:ProcedureVersion;current?:boolean}) {
  const recordedDate=new Date(version.createdAt);
  return <div className="min-w-0 text-[12px] leading-relaxed">
    <p className="font-medium text-ink">{current?"Current version":"Previous version"} · {versionOrigin(version.origin)}</p>
    <p className="text-ink-secondary">{Number.isFinite(recordedDate.getTime())?recordedDate.toLocaleString():"Date not recorded"}</p>
    <p className="mt-1 whitespace-pre-wrap break-words text-ink">{version.description}</p>
    <details className="mt-1 text-ink-secondary"><summary className={`${button} cursor-pointer px-0`}>Version details</summary><p className="break-all font-mono">{version.revision}</p>{version.rollbackOf&&<p className="mt-1 break-all">Restored from {version.rollbackOf}</p>}{version.sha256&&<p className="mt-1 break-all font-mono">Content: {version.sha256}</p>}</details>
  </div>;
}
export function ProcedureVersionHistory({source,label,scopeLabel,disabledReason}:{source:HistorySource;label:string;scopeLabel:string;disabledReason?:string}) {
  const store=useMemo(()=>createHistoryStore(source),[source]),state=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot);
  const [confirm,setConfirm]=useState<ProcedureVersion|null>(null),back=useRef<HTMLButtonElement>(null),summary=useRef<HTMLElement>(null);
  return <details className="mt-3 border-t border-hairline/60 pt-2" onToggle={event=>{if(event.currentTarget.open&&state.phase==="idle")void store.load();}}>
    <summary ref={summary} className={`${button} cursor-pointer font-medium`}>{label}</summary>
    <section aria-label={label} className="px-1 pb-2">
      <p className="text-[12px] font-medium text-ink">{scopeLabel}</p>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">Restoring affects future tasks. Running tasks keep their instruction version.</p>
      {disabledReason&&<p className="mt-2 text-[12px] text-ink-secondary">{disabledReason}</p>}
      {state.phase==="loading"&&<p role="status" className="mt-2 text-[12px] text-ink-secondary">Loading versions…</p>}
      {state.error&&<p role="alert" className="mt-2 text-[12px] text-danger">{state.error}</p>}
      {state.notice&&<p role="status" className="mt-2 text-[12px] text-ink">{state.notice}</p>}
      {(state.phase==="failed"||state.conflict)&&<button ref={back} type="button" className={button} disabled={state.busy} onClick={()=>{setConfirm(null);void store.load();}}>Refresh versions</button>}
      {state.history&&<div className="mt-3 space-y-3">
        {state.history.current?<Version version={state.history.current} current/>:<p className="break-all text-[12px] text-ink-secondary">{state.history.currentRevision?`Current version: ${state.history.currentRevision}`:"No version history is recorded for these instructions yet."}</p>}
        {state.history.revisions.filter(version=>version.revision!==state.history!.currentRevision).map(version=><div key={version.revision} className="border-t border-hairline/50 pt-3"><Version version={version}/><button type="button" className={button} disabled={state.busy||state.conflict||state.phase!=="ready"||!state.history?.currentRevision||!version.revision||Boolean(disabledReason)} onClick={()=>setConfirm(version)} aria-label={`Restore version ${version.revision}`}>Restore this version</button></div>)}
        {!state.history.revisions.filter(version=>version.revision!==state.history!.currentRevision).length&&<p className="text-[12px] text-ink-secondary">No earlier versions are available for this audience.</p>}
      </div>}
      {confirm&&<div className="mt-3 border border-hairline bg-inset p-3" role="group" aria-label="Confirm version restore"><p className="text-[12px] text-ink">Restore this version for {scopeLabel.toLowerCase()}?</p><p className="mt-1 break-words text-[12px] text-ink-secondary">{confirm.description}</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" className={button} disabled={state.busy||state.conflict||Boolean(disabledReason)} autoFocus onClick={()=>{const target=confirm;setConfirm(null);summary.current?.focus();void store.restore(target);}}>Confirm restore</button><button type="button" className={button} disabled={state.busy} onClick={()=>{setConfirm(null);summary.current?.focus();}}>Keep current version</button></div></div>}
    </section>
  </details>;
}
export function SkillVersionHistory({botId,name,threadId,canEdit,onRestored}:{botId:string;name:string;threadId?:string;canEdit:boolean;onRestored?:()=>void}) {
  const [audience,setAudience]=useState<"global"|"task">("global");
  const callback=useRef(onRestored);callback.current=onRestored;
  const source=useMemo(()=>{
    const source=skillHistorySource(api,botId,name,audience==="global"?{kind:"global"}:{kind:"task",threadId:threadId??null});
    return {...source,restore:async(...args:Parameters<typeof source.restore>)=>{await source.restore(...args);callback.current?.();}};
  },[botId,name,audience,threadId]);
  if(!canEdit)return null;
  return <div className="mt-3"><p className="mb-2 text-[12px] text-ink-secondary">Instructions shown above are the global skill. Choose which audience’s history to inspect below.</p><label className="flex flex-wrap items-center gap-2 text-[12px] text-ink-secondary">History audience<select aria-label="Skill history audience" value={audience} onChange={event=>setAudience(event.target.value as "global"|"task")} className="procedure-history-audience min-h-11 max-w-full rounded-md border border-hairline bg-inset px-2 text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"><option value="global">Global skill</option><option value="task">Current task audience</option></select></label><ProcedureVersionHistory key={`${name}:${audience}:${threadId??"none"}`} source={source} label="Skill version history" scopeLabel={audience==="global"?"Global skill": "Current task audience"}/></div>;
}
export function RoutineVersionHistory({routine,onRestored,disabledReason}:{routine:Routine;onRestored:(routine:Routine)=>void;disabledReason?:string}) {
  const callback=useRef(onRestored);callback.current=onRestored;
  const source=useMemo(()=>routineHistorySource(api,routine.id,value=>callback.current(value)),[routine.id]);
  return <ProcedureVersionHistory source={source} label="Instruction version history" scopeLabel={routine.target==="room-goal"?"This routine’s room":"This routine’s bot"} disabledReason={disabledReason}/>;
}
