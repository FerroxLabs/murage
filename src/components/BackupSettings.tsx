import { useEffect,useRef,useState } from "react";
import {BackupRemoteSettings} from "./BackupRemoteSettings";
import { enabledSchedule,scheduleDraft,scheduleError,scheduleNeedsReview,schedulePhase,closedJobLabel,closedResultLabel,type ScheduleDraft } from "./backup-schedule-ui";
export function BackupSettingsView({supported,busy,error,onRestart}:{supported:boolean;busy:boolean;error?:string;onRestart:()=>void}) {
  return <section aria-label="Backup" className="space-y-3 rounded-xl border border-hairline/40 bg-card p-4">
    <h3 className="text-[15px] font-medium text-ink">Backup</h3>
    <p className="text-[13px] text-ink-secondary">Encrypted application-data backups preserve original settings, conversations, files and channel history. A restored installation stays paused for review. Native sessions, VM homes and external folders are not included.</p>
    <p className="text-[13px] text-ink-secondary">Backup mode closes this workspace first. Finish current work, then choose a destination and an independent age recovery key file. Existing recovery ZIPs remain available and contain a reduced recovery copy.</p>
    {!supported&&<p role="status" className="text-[13px] text-ink-secondary">Encrypted backup requires a supported packaged app with its verified backup tool.</p>}
    {error&&<p role="alert" className="text-[13px] text-danger">{error}</p>}
    <button type="button" disabled={!supported||busy} onClick={onRestart} className="min-h-11 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50">{busy?"Preparing Backup mode…":"Restart into Backup mode"}</button>
  </section>;
}
export function BackupSettings(){
  const[supported,setSupported]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string>();
  useEffect(()=>{let active=true;void window.muragebox?.backup?.status().then(value=>{if(active)setSupported(value.supported);}).catch(()=>{});return()=>{active=false;};},[]);
  const restart=async()=>{
    if(busy)return;setBusy(true);setError(undefined);
    try{await window.muragebox?.backup?.restart();}
    catch(cause){setError(cause instanceof Error&&cause.message.includes("BACKUP_WORK_ACTIVE")?"Work is still active. Finish or stop it before restarting into Backup mode.":"Backup mode could not open. Your data is preserved; check that work is idle and try again.");}
    finally{setBusy(false);}
  };
  return <div className="space-y-4"><BackupSettingsView supported={supported} busy={busy} error={error} onRestart={()=>void restart()}/><BackupScheduleSettings/><BackupRemoteSettings/></div>;
}

const scheduleInput = "mt-1 min-h-11 w-full min-w-0 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus:ring-2 focus:ring-accent-border disabled:opacity-50";
const scheduleButton = "min-h-11 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";
export function BackupScheduleSettings() {
  const [status,setStatus]=useState<BackupScheduleStatus|null>(null);
  const [draft,setDraft]=useState<ScheduleDraft>(()=>scheduleDraft({enabled:false,preUpgrade:false}));
  const [consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[stale,setStale]=useState(false);
  const [error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
  const [closed,setClosed]=useState<BackupClosedStatus|null>(null),[closedStale,setClosedStale]=useState(false),[closedAction,setClosedAction]=useState<string|null>(null);
  const gate=useRef(false),dirty=useRef(false),mounted=useRef(true),version=useRef(0);
  const bridge=window.muragebox?.backupSchedule;
  const closedBridge=window.muragebox?.backupClosed;
  const apply=(next:BackupScheduleStatus,expected:number)=>{
    if(!mounted.current||expected!==version.current)return;
    setStatus(next);setStale(false);
    if(!dirty.current)setDraft(scheduleDraft(next.schedule));
  };
  const applyClosed=(next:BackupClosedStatus,expected:number)=>{if(mounted.current&&version.current===expected){setClosed(next);setClosedStale(false);}};
  const refreshClosed=async(expected:number)=>{if(closedBridge)try{applyClosed(await closedBridge.status(),expected);}catch{if(mounted.current&&version.current===expected)setClosedStale(true);}};
  const refresh=async(expected:number)=>{if(bridge)apply(await bridge.status(),expected);await refreshClosed(expected);};
  useEffect(()=>{
    mounted.current=true;const expected=++version.current;
    void refresh(expected).catch(()=>{if(mounted.current&&expected===version.current)setStale(true);});
    return()=>{mounted.current=false;version.current++;};
  },[]);
  useEffect(()=>{
    if(!status?.pending&&!status?.enabled)return;
    let active=true,inFlight=false;
    const timer=window.setInterval(async()=>{
      if(gate.current||inFlight)return;
      inFlight=true;const expected=version.current;
      try{const next=await bridge?.status();if(active&&next){apply(next,expected);await refreshClosed(expected);}}
      catch{if(active&&mounted.current&&expected===version.current)setStale(true);}
      finally{inFlight=false;}
    },2000);
    return()=>{active=false;window.clearInterval(timer);};
  },[status?.pending,status?.enabled,bridge,closedBridge]);
  const run=async(work:(expected:number)=>Promise<void>)=>{
    if(gate.current||!bridge)return;
    gate.current=true;const expected=++version.current;setBusy(true);setError(null);setNotice(null);
    try{await work(expected);}
    catch(cause){if(mounted.current&&expected===version.current){setError(scheduleError(cause));try{await refresh(expected);}catch{setStale(true);}}}
    finally{gate.current=false;if(mounted.current)setBusy(false);}
  };
  const unavailable=!bridge||!status?.supported;
  const locked=unavailable||busy||stale||Boolean(status?.pending);
  const editingLocked=locked||Boolean(status?.enabled)||Boolean(status&&scheduleNeedsReview(status.phase))||Boolean(status?.schedule.preUpgrade&&status.preUpgradeSupported!==true);
  const closedRegistered=Boolean(closedBridge&&closed?.supported&&closed.state==="installed"&&!closedStale);
  const choices=status&&(!draft.closedApp||closedRegistered)?enabledSchedule(draft,status,consent):null;
  const lastClosed=closedResultLabel(status?.lastClosedResult??closed?.lastClosedResult);
  const closedOperation=(action:"stage"|"install"|"disable")=>run(async expected=>{
    if(!closedBridge)return;setClosedAction(action);
    try{
      const next=await closedBridge[action]();applyClosed(next,expected);
      if(action==="disable"){dirty.current=false;setConsent(false);}
      await refresh(expected);
      if(mounted.current&&expected===version.current){
        if(action==="stage")setNotice(next.state==="installed"?"Job registration confirmed. Scheduling settings are unchanged.":"Job prepared. It is not registered; scheduling settings are unchanged.");
        if(action==="install")setNotice("cancelled"in next&&next.cancelled?"Job registration cancelled. Scheduling settings are unchanged.":next.state==="installed"?"Job registration confirmed. Scheduling settings are unchanged.":"Registration is not confirmed. Refresh status before enabling closed-app backups.");
        if(action==="disable")setNotice(next.state==="disabled-removal-pending"?"All scheduled backups are disabled. Job removal is pending; any running backup is not cancelled.":"All scheduled backups are disabled. Any running backup is not cancelled.");
      }
    }finally{if(mounted.current)setClosedAction(null);}
  });
  const edit=<K extends keyof ScheduleDraft,>(key:K,value:ScheduleDraft[K])=>{dirty.current=true;setDraft(current=>({...current,[key]:value}));setConsent(false);};
  return <section aria-labelledby="backup-schedule-title" className="min-w-0 space-y-3 rounded-xl border border-hairline/40 bg-card p-4">
    <h3 id="backup-schedule-title" className="text-[15px] font-medium text-ink">Scheduled application-data backups</h3>
    <p className="text-[13px] text-ink-secondary">In-app backups run while Murage is open. Closed-app backups also require a registered job and permission below. When due and idle, Murage can close this workspace for an encrypted backup and reopen afterward. Native sessions, VM homes and external folders are not included.</p>
    <p role="status" className="text-[13px] font-medium text-ink">{status?`Schedule ${status.enabled?"On":"Off"}. ${schedulePhase(status.phase)}`:bridge?"Checking schedule status…":"Scheduling unavailable in this window"}</p>
    {unavailable&&(!bridge||status)&&<p className="text-[13px] text-ink-secondary">Scheduled backup requires a supported packaged app with its verified backup tool.</p>}
    {status?.supported&&<>
      <p className="text-[13px] text-ink-secondary">An independently saved age recovery key is required. Choose your destination and that key file. No recovery key is created or exported here.</p>
      <div className="text-[13px] text-ink-secondary break-words">
        <p>Destination: {status.refs?.destinationLabel??"Not selected"}</p><p>Recovery key: {status.refs?.recoveryLabel??"Not selected"}</p>
      </div>
      <button type="button" className={scheduleButton} disabled={editingLocked} onClick={()=>void run(async expected=>{
        const next=await bridge!.selectReferences();if("cancelled"in next){if(mounted.current)setNotice("Selection cancelled. Schedule unchanged.");return;}
        apply(next,expected);setConsent(false);if(mounted.current)setNotice("References selected. Scheduling has not been enabled.");
      })}>Choose destination and recovery key</button>
      {status.enabled&&<p className="text-[13px] text-ink-secondary">Disable the schedule before changing its time, budgets or selected references.</p>}
      {(status.schedule.preUpgrade||draft.preUpgrade)&&status.preUpgradeSupported!==true&&<p className="text-[13px] text-warning">Pre-upgrade backups are unavailable in this app. Your saved choices are preserved. Use a supported updater before enabling this option.</p>}
      <div className="space-y-2 rounded-lg border border-hairline/40 p-3">
        <h4 className="text-[13px] font-medium text-ink">When Murage is closed</h4>
        <p role="status" className="text-[13px] text-ink">{closedBridge?closedJobLabel(closed?.state):"Closed-app scheduling unavailable in this window"}</p>
        <p className="text-[12px] text-ink-secondary">Prepare the job, then register it for your signed-in user session. Registration alone does not enable backups. This does not promise backups while signed out or wake a sleeping computer.</p>
        {closed?.supported&&<div className="flex flex-wrap gap-2">
          {closed.state==="unconfigured"&&<button type="button" className={scheduleButton} disabled={locked||closedStale} onClick={()=>void closedOperation("stage")}>{closedAction==="stage"?"Preparing job…":"Prepare closed-app job"}</button>}
          {["staged","disabled"].includes(closed.state)&&<button type="button" className={scheduleButton} disabled={locked||closedStale} onClick={()=>void closedOperation("install")}>{closedAction==="install"?"Confirming registration…":"Register prepared job"}</button>}
          {["staged","installed","disabled-removal-pending","unavailable"].includes(closed.state)&&<button type="button" className={scheduleButton} disabled={locked} onClick={()=>void closedOperation("disable")}>{closedAction==="disable"?"Disabling schedules…":"Disable all scheduled backups and remove job"}</button>}
        </div>}
        {closed?.state==="disabled-removal-pending"&&<p className="text-[12px] text-warning">{status.enabled?"Check the current schedule above.":"All scheduled backups are disabled."} Job removal still needs attention. Use the disable-and-remove action again when no backup is running.</p>}
        {(!closedBridge||closed?.supported===false)&&<p className="text-[12px] text-ink-secondary">A supported desktop app, backup tool and owning-user session are required. In-app scheduling remains separate.</p>}
        {closedStale&&<p role="alert" className="text-[12px] text-warning">Job status could not be refreshed. The last confirmed state is shown; closed-app enabling is blocked. Refresh schedule status to try again.</p>}
        {lastClosed&&<p className="text-[12px] text-ink-secondary">Last closed-app result: {lastClosed.label} · {new Date(lastClosed.at).toLocaleString()}</p>}
      </div>
      <fieldset disabled={editingLocked} className="min-w-0 space-y-3">
        <legend className="text-[13px] font-medium text-ink">Daily schedule and limits</legend>
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-[13px] text-ink-secondary">Daily time<input type="time" value={draft.time} onChange={event=>edit("time",event.target.value)} className={scheduleInput}/></label>
          <label className="text-[13px] text-ink-secondary">Timezone<input value={draft.timezone} maxLength={100} spellCheck={false} onChange={event=>edit("timezone",event.target.value)} className={scheduleInput} aria-describedby="backup-timezone-help"/></label>
        </div>
        <p id="backup-timezone-help" className="text-[12px] text-ink-secondary">Use an IANA timezone, such as Asia/Bangkok. Check the suggested timezone before enabling.</p>
        <label className="block text-[13px] text-ink-secondary">Catch-up window (hours)<input type="number" min={1/60} max={168} step="any" value={draft.catchup} onChange={event=>edit("catchup",event.target.value)} className={scheduleInput} aria-describedby="backup-catchup-help"/></label>
        <p id="backup-catchup-help" className="text-[12px] text-ink-secondary">How late a due backup may start: 1 minute to 168 hours. Closed-app checks require the registered job and permission below.</p>
        <label className="block text-[13px] text-ink-secondary">Maximum backup size (GiB)<input type="number" min={1/(1024**3)} max={1024} step="any" value={draft.size} onChange={event=>edit("size",event.target.value)} className={scheduleInput}/></label>
        <label className="block text-[13px] text-ink-secondary">Maximum run duration (minutes)<input type="number" min={1/60} max={30} step="any" value={draft.duration} onChange={event=>edit("duration",event.target.value)} className={scheduleInput}/></label>
        {status.preUpgradeSupported===true&&<label className="flex min-h-11 items-start gap-3 py-2 text-[13px] text-ink">
          <input type="checkbox" checked={draft.preUpgrade} onChange={event=>edit("preUpgrade",event.target.checked)} className="mt-1 size-4 shrink-0 accent-accent focus-visible:ring-2 focus-visible:ring-accent-border"/>
          <span>Back up before installing an in-app update.</span>
        </label>}
        {(closedBridge||draft.closedApp)&&<label className="flex min-h-11 items-start gap-3 py-2 text-[13px] text-ink">
          <input type="checkbox" checked={draft.closedApp} disabled={!draft.closedApp&&(!closedRegistered||status.closedAppSupported!==true)} onChange={event=>edit("closedApp",event.target.checked)} className="mt-1 size-4 shrink-0 accent-accent focus-visible:ring-2 focus-visible:ring-accent-border"/>
          <span>Allow scheduled backups while Murage is closed, while I am signed in.</span>
        </label>}
        {draft.closedApp&&(!closedRegistered||status.closedAppSupported!==true)&&<p className="text-[12px] text-warning">Your saved closed-app choice is preserved, but registration is not confirmed. Register the job, or clear this permission to use in-app backups only.</p>}
        <label className="flex min-h-11 items-start gap-3 py-2 text-[13px] text-ink">
          <input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)} className="mt-1 size-4 shrink-0 accent-accent focus-visible:ring-2 focus-visible:ring-accent-border"/>
          <span>Allow Murage to close an idle workspace for this backup and reopen it afterward.</span>
        </label>
      </fieldset>
      {!status.enabled&&!choices&&<p className="text-[12px] text-ink-secondary">To enable, select both references, enter a valid time, timezone and limits, then confirm idle-restart consent. Size must be greater than zero and no more than 1,024 GiB; duration must be 1 second to 30 minutes.</p>}
      <div className="flex flex-wrap gap-2">
        {!status.enabled&&<button type="button" className={scheduleButton} disabled={editingLocked||!choices} onClick={()=>void run(async expected=>{
          if(!choices)return;const next=await bridge!.configure(status.revision,{...choices,allowIdleRestart:true,...(choices.closedApp===true?{allowClosedApp:true}:{})});dirty.current=false;apply(next,expected);setConsent(false);await refreshClosed(expected);
          if(mounted.current)setNotice(next.enabled?next.schedule.closedApp===true?"Scheduled backups enabled, including closed-app checks while you are signed in.":"Scheduled backups enabled. Closed-app backups are off.":"Settings saved; scheduling remains off.");
        })}>Enable scheduled backups</button>}
        {status.enabled&&<button type="button" className={scheduleButton} disabled={locked} onClick={()=>void run(async expected=>{
          const next=await bridge!.configure(status.revision,{...status.schedule,enabled:false});dirty.current=false;apply(next,expected);setConsent(false);
          if(mounted.current)setNotice("Schedule disabled for future backups. An existing transfer is not cancelled.");
        })}>Disable schedule</button>}
      </div>
      {status.pending&&<p role="status" className="text-[13px] text-ink-secondary">Backup work is pending. Settings are locked; status updates automatically.</p>}
      {status.lastVerified&&<p className="text-[13px] text-ink-secondary">Last locally verified backup: {new Date(status.lastVerified.verifiedAt).toLocaleString()} · {status.lastVerified.bytes.toLocaleString()} bytes. This is not a restore-drill result.</p>}
    </>}
    {bridge&&<button type="button" className={scheduleButton} disabled={busy} onClick={()=>void run(refresh)}>Refresh schedule status</button>}
    {stale&&<p role="alert" className="text-[13px] text-warning">Status refresh failed. The last confirmed state is shown; changes are locked. Refresh schedule status to try again.</p>}
    {(error||status?.error)&&<p role="alert" className="text-[13px] text-danger">{error??scheduleError(status?.error)}</p>}
    {notice&&<p role="status" className="text-[13px] text-ink-secondary">{notice}</p>}
  </section>;
}
