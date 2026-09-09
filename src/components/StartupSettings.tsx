import { useEffect,useState } from "react";
import type { StartupBackgroundState } from "@/types/muragebox";
import { Switch } from "./SettingsPrimitives";

export function StartupSettingsView({state,busy,error,onChange}:{state:StartupBackgroundState;busy:boolean;error?:string;onChange:(patch:{keepRunning?:boolean;startAtLogin?:boolean})=>void}){
  return <section aria-label="Startup and background" className="space-y-4 rounded-xl bg-card p-4">
    <div><h3 className="text-[15px] font-medium text-ink">Startup &amp; background</h3><p className="mt-1 text-[13px] text-ink-secondary">These settings apply to this Murage installation on this computer.</p></div>
    <div className="flex items-center justify-between gap-4"><div className="min-w-0"><div className="text-[14px] font-medium text-ink">Keep running when the window closes</div><p className="mt-1 text-[12px] text-ink-secondary">Reopen Murage from its menu bar, tray or Dock. Quit stops the app.</p></div><Switch aria-label="Keep running when the window closes" checked={state.keepRunning} disabled={busy||!state.configurable||(!state.canKeepRunning&&!state.keepRunning)} onClick={()=>onChange({keepRunning:!state.keepRunning})}/></div>
    {state.defaultInherited&&state.platform==="darwin"&&<p className="text-[12px] text-ink-secondary">The Mac default keeps Murage open after its last window closes. Turn this off to quit when you close it.</p>}
    {!state.canKeepRunning&&<p role="status" className="text-[12px] text-warning">No usable tray was detected. Closing the last window quits Murage; keep the window open to continue work.</p>}
    {!state.configurable&&<p className="text-[12px] text-ink-secondary">Save these preferences from the installed desktop app.</p>}
    <div className="flex items-center justify-between gap-4"><div className="min-w-0"><div className="text-[14px] font-medium text-ink">Start when I sign in</div><p className="mt-1 text-[12px] text-ink-secondary">Off until you choose it. Your operating system controls sign-in startup.</p></div><Switch aria-label="Start when I sign in" checked={state.login.openAtLogin} disabled={busy||!state.login.supported} onClick={()=>onChange({startAtLogin:!state.login.openAtLogin})}/></div>
    {state.login.reason&&<p className="text-[12px] text-ink-secondary">{state.login.reason}</p>}
    {state.login.requiresApproval&&<p role="status" className="text-[12px] text-warning">Approve Murage in your system's Login Items settings to finish enabling startup.</p>}
    {state.login.openAtLogin&&<p className="text-[12px] text-ink-secondary">{state.effectiveKeepRunning&&state.trayAvailable?"Sign-in startup opens quietly in the menu bar or tray.":"Sign-in startup opens the window. Quiet startup requires background mode and a working tray."}</p>}
    <p role="status" className="text-[12px] text-ink-secondary">{state.quitting?"Murage is closing.":state.suspended?"This computer is asleep. Work can resume after it wakes.":state.automationsPaused===true?"Schedules and webhooks are paused. Running tasks and direct requests continue.":"Work runs only while Murage is open and this computer is awake. Sleeping or switching it off stops progress."}</p>
    {error&&<p role="alert" className="text-[13px] text-danger">{error}</p>}
  </section>;
}

export function StartupSettings(){
  const [state,setState]=useState<StartupBackgroundState|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string>();
  const bridge=window.muragebox?.startup;
  useEffect(()=>{
    if(!bridge)return;let alive=true;
    const stop=bridge.onChange(value=>{if(alive)setState(value);});
    void bridge.status().then(value=>{if(alive)setState(value);}).catch(cause=>{if(alive)setError(cause instanceof Error?cause.message:"Startup settings could not be read.");});
    return()=>{alive=false;stop();};
  },[bridge]);
  const update=async(patch:{keepRunning?:boolean;startAtLogin?:boolean})=>{
    if(!bridge||busy)return;setBusy(true);setError(undefined);
    try{setState(await bridge.update(patch));}catch(cause){setError(cause instanceof Error?cause.message:"Startup settings could not be changed.");try{setState(await bridge.status());}catch{/* Keep last confirmed state. */}}
    finally{setBusy(false);}
  };
  if(!state)return <section aria-label="Startup and background" className="rounded-xl bg-card p-4"><h3 className="text-[15px] font-medium">Startup &amp; background</h3><p role="status" className="mt-1 text-[13px] text-ink-secondary">{error??(bridge?"Checking startup settings…":"Startup settings are available in the installed desktop app.")}</p></section>;
  return <StartupSettingsView state={state} busy={busy} error={error} onChange={patch=>void update(patch)}/>;
}
