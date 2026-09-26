// Settings → Backups. The state hooks below make exactly the bridge calls the
// old General-section panels made, with the same revision checks, consent
// resets, locks and credential clearing; the views only arrange them.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { OffsiteCleanup, OffsiteDetails, OffsiteRecover, OffsiteRefresh, OffsiteStatus, useBackupRemote, type RemoteController } from "./BackupRemoteSettings";
import { enabledSchedule, scheduleCardNotice, scheduleDraft, scheduleError, scheduleNeedsReview, schedulePhase, closedJobLabel, closedResultLabel, type ScheduleDraft } from "./backup-schedule-ui";
import { backupSummary, closedJobBlockedReason, closedJobCanSetUp, closedJobNotice, completeBackupSetup, recoveryKeyError, recoveryKeyResult, runNowError, setUpClosedJob, timeZoneChoices, type BackupModeBridge, type BackupScheduleBridge, type BackupSummary } from "./backups-section-ui";

const card = "min-w-0 space-y-3 rounded-xl border border-hairline/40 bg-card p-4";
const scheduleInput = "mt-1 min-h-11 w-full min-w-0 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus:ring-2 focus:ring-accent-border disabled:opacity-50";
const scheduleButton = "min-h-11 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";
const primaryButton = "min-h-11 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";
const checkbox = "mt-1 size-4 shrink-0 accent-accent focus-visible:ring-2 focus-visible:ring-accent-border";

/** Restore from a backup on this computer (Backup mode). */
export function BackupSettingsView({supported,busy,error,onRestart}:{supported:boolean;busy:boolean;error?:string;onRestart:()=>void}) {
  return <div className="space-y-3">
    <h4 className="text-[13px] font-medium text-ink">From a backup on this computer</h4>
    <p className="text-[13px] text-ink-secondary">Backup mode closes this window and opens a separate recovery screen. There you can restore an encrypted backup into a new installation that stays paused for review, or make a one-off backup. Finish current work first.</p>
    <p className="text-[13px] text-ink-secondary">Backups cover settings, conversations, files and channel history. Native sessions, VM homes and external folders are not included. Older recovery ZIPs still work and hold a reduced recovery copy.</p>
    {!supported&&<p role="status" className="text-[13px] text-ink-secondary">Encrypted backup requires a supported packaged app with its verified backup tool.</p>}
    {error&&<p role="alert" className="text-[13px] text-danger">{error}</p>}
    <button type="button" disabled={!supported||busy} onClick={onRestart} className={scheduleButton}>{busy?"Preparing Backup mode…":"Restart into Backup mode"}</button>
  </div>;
}

function useBackupMode() {
  const [supported,setSupported]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string>();
  useEffect(()=>{
    let active=true,timer:number|undefined;
    // Backup mode needs the same checked tool; keep asking until it is ready.
    const read=()=>void window.muragebox?.backup?.status().then(value=>{if(!active)return;setSupported(value.supported);if(!value.supported)timer=window.setTimeout(read,3000);}).catch(()=>{});
    read();
    return()=>{active=false;if(timer!==undefined)window.clearTimeout(timer);};
  },[]);
  const restart=async()=>{
    if(busy)return;setBusy(true);setError(undefined);
    try{await window.muragebox?.backup?.restart();}
    catch(cause){setError(cause instanceof Error&&cause.message.includes("BACKUP_WORK_ACTIVE")?"Work is still active. Finish or stop it before restarting into Backup mode.":"Backup mode could not open. Your data is preserved; check that work is idle and try again.");}
    finally{setBusy(false);}
  };
  return {supported,busy,error,restart};
}

export type ScheduleArea = "summary" | "schedule" | "advanced";

export function useBackupSchedule() {
  const [status,setStatus]=useState<BackupScheduleStatus|null>(null);
  const [draft,setDraft]=useState<ScheduleDraft>(()=>scheduleDraft({enabled:false,preUpgrade:false}));
  const [consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[stale,setStale]=useState(false);
  const [error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null),[area,setArea]=useState<ScheduleArea>("schedule");
  const [closed,setClosed]=useState<BackupClosedStatus|null>(null),[closedStale,setClosedStale]=useState(false),[closedAction,setClosedAction]=useState<string|null>(null);
  const [createdKey,setCreatedKey]=useState<{label:string;publicKey:string|null;folder:string}|null>(null),[confirmRun,setConfirmRun]=useState(false);
  const [keyCopy,setKeyCopy]=useState<string|null>(null);
  const [closedSetupFailed,setClosedSetupFailed]=useState(false);
  const gate=useRef(false),dirty=useRef(false),mounted=useRef(true),version=useRef(0);
  const bridge=window.muragebox?.backupSchedule as BackupScheduleBridge|undefined;
  const closedBridge=window.muragebox?.backupClosed;
  const modeBridge=window.muragebox?.backup as BackupModeBridge|undefined;
  const apply=(next:BackupScheduleStatus,expected:number)=>{
    if(!mounted.current||expected!==version.current)return;
    setStatus(next);setStale(false);
    if(!dirty.current)setDraft(scheduleDraft(next.schedule));
  };
  const applyClosed=(next:BackupClosedStatus,expected:number)=>{if(mounted.current&&version.current===expected){setClosed(next);setClosedStale(false);}};
  const refreshClosed=async(expected:number)=>{if(closedBridge)try{applyClosed(await closedBridge.status(),expected);}catch{if(mounted.current&&version.current===expected)setClosedStale(true);}};
  const refresh=async(expected:number)=>{let next:BackupScheduleStatus|null=null;if(bridge){next=await bridge.status();apply(next,expected);}await refreshClosed(expected);return next;};
  useEffect(()=>{
    mounted.current=true;const expected=++version.current;
    void refresh(expected).catch(()=>{if(mounted.current&&expected===version.current)setStale(true);});
    return()=>{mounted.current=false;version.current++;};
  },[]);
  useEffect(()=>{
    // Also while the backup tool is still being checked after a start, so
    // the page turns ready without being reopened.
    if(!status?.pending&&!status?.enabled&&!(status&&!status.supported&&status.checking))return;
    let active=true,inFlight=false;
    const timer=window.setInterval(async()=>{
      if(gate.current||inFlight)return;
      inFlight=true;const expected=version.current;
      try{const next=await bridge?.status();if(active&&next){apply(next,expected);await refreshClosed(expected);}}
      catch{if(active&&mounted.current&&expected===version.current)setStale(true);}
      finally{inFlight=false;}
    },2000);
    return()=>{active=false;window.clearInterval(timer);};
  },[status?.pending,status?.enabled,status?.supported,status?.checking,bridge,closedBridge]);
  const run=async(where:ScheduleArea,work:(expected:number)=>Promise<void>,describe:(cause:unknown)=>string=scheduleError)=>{
    if(gate.current||!bridge)return;
    gate.current=true;const expected=++version.current;setBusy(true);setError(null);setNotice(null);setArea(where);
    try{await work(expected);}
    catch(cause){if(mounted.current&&expected===version.current){setError(describe(cause));try{await refresh(expected);}catch{setStale(true);}}}
    finally{gate.current=false;if(mounted.current)setBusy(false);}
  };
  const unavailable=!bridge||!status?.supported;
  const locked=unavailable||busy||stale||Boolean(status?.pending);
  const editingLocked=locked||Boolean(status?.relaunchBlocked)||Boolean(status?.enabled)||Boolean(status&&scheduleNeedsReview(status.phase))||Boolean(status?.schedule.preUpgrade&&status.preUpgradeSupported!==true);
  const closedRegistered=Boolean(closedBridge&&closed?.supported&&closed.state==="installed"&&!closedStale);
  const choices=status&&(!draft.closedApp||closedRegistered)?enabledSchedule(draft,status,consent):null;
  const lastClosed=closedResultLabel(status?.lastClosedResult??closed?.lastClosedResult);
  const edit=<K extends keyof ScheduleDraft,>(key:K,value:ScheduleDraft[K])=>{dirty.current=true;setDraft(current=>({...current,[key]:value}));setConsent(false);};
  const closedOperation=(action:"stage"|"install"|"disable")=>run("advanced",async expected=>{
    if(!closedBridge)return;setClosedAction(action);
    try{
      const next=await closedBridge[action]();applyClosed(next,expected);
      if(action==="disable"){dirty.current=false;setConsent(false);}
      await refresh(expected);
      if(mounted.current&&expected===version.current)setNotice(closedJobNotice(action,next));
    }finally{if(mounted.current)setClosedAction(null);}
  });
  /** Ticking "Also back up when Murage is closed" sets up the background job
   * with the same prepare → register calls, then records the choice only once
   * registration and capability are confirmed. Unticking only clears the choice. */
  const closedAllowed=Boolean(closedBridge&&closed?.supported&&!closedStale&&closedJobCanSetUp(closed.state)&&(!closedRegistered||status?.closedAppSupported===true));
  const setClosedApp=(checked:boolean)=>{
    if(!checked){edit("closedApp",false);return;}
    if(closedRegistered){edit("closedApp",true);return;}
    const from=closed?.state;
    void run("schedule",async expected=>{
      if(!closedBridge)return;setClosedAction("setup");
      try{
        const last=await setUpClosedJob(closedBridge,from,next=>applyClosed(next,expected));
        const fresh=await refresh(expected);
        if(!mounted.current||expected!==version.current)return;
        if(last)setNotice(closedJobNotice(last.action,last.next));
        const registered=(last?last.next.state:from)==="installed";
        // A cancel is the person's choice, not the system's refusal.
        setClosedSetupFailed(!registered&&!last?.next.cancelled);
        if(registered&&!(last?.next.cancelled)&&fresh?.closedAppSupported===true)edit("closedApp",true);
      }catch(cause){if(mounted.current&&expected===version.current)setClosedSetupFailed(true);throw cause;}
      finally{if(mounted.current)setClosedAction(null);}
    });
  };
  const selectReferences=()=>void run("schedule",async expected=>{
    const next=await bridge!.selectReferences();if("cancelled"in next){if(mounted.current)setNotice("Selection cancelled. Schedule unchanged.");return;}
    apply(next,expected);setConsent(false);if(mounted.current)setNotice("Backup folder and recovery key chosen. Daily backups are not on yet.");
  });
  /** One act of setup: the folder picker, the key Murage writes itself, one
   * confirmation — the schedule goes on AND the first backup is taken, because
   * a schedule with no backup behind it reads as success and protects nothing.
   * The sequence itself lives in completeBackupSetup so it can be tested
   * without a browser. */
  const setUp=bridge?.setUp?(options?:{existingKey?:boolean})=>void run("schedule",async expected=>{
    const guard=<T,>(apply:(value:T)=>void)=>(value:T)=>{if(mounted.current&&expected===version.current)apply(value);};
    const outcome=await completeBackupSetup(bridge!,options,{
      applyStatus:next=>{dirty.current=false;apply(next,expected);setConsent(false);},
      createdKey:guard(setCreatedKey),
      notice:guard(setNotice),
    });
    if(!mounted.current||expected!==version.current)return;
    if(outcome.state==="first-backup-failed"){setNotice(null);setError(outcome.message);}
  },cause=>recoveryKeyError(cause,scheduleError(cause))):undefined;
  /** A second copy of the key, somewhere other than the backup folder. The
   * secret is read and written in the desktop process; this only learns a name. */
  const saveKeyCopy=modeBridge?.saveRecoveryKeyCopy?()=>void run("schedule",async expected=>{
    let result:ReturnType<typeof recoveryKeyResult>;
    try{result=recoveryKeyResult(await modeBridge.saveRecoveryKeyCopy!());}
    catch(cause){if(mounted.current&&expected===version.current)setError(recoveryKeyError(cause,"The copy could not be saved. Your recovery key is unchanged. Try again."));return;}
    if(!mounted.current||expected!==version.current)return;
    if("cancelled"in result){setNotice("No copy was saved. Your recovery key is unchanged.");return;}
    setKeyCopy(result.label);setNotice(`A copy of your recovery key was saved as ${result.label}.`);
  }):undefined;
  const enable=()=>void run("schedule",async expected=>{
    if(!choices||!status)return;const next=await bridge!.configure(status.revision,{...choices,allowIdleRestart:true,...(choices.closedApp===true?{allowClosedApp:true}:{})});dirty.current=false;apply(next,expected);setConsent(false);await refreshClosed(expected);
    if(mounted.current)setNotice(next.enabled?next.schedule.closedApp===true?"Daily backups are on, including while Murage is closed and you are signed in.":"Daily backups are on. Backups while Murage is closed are off.":"Settings saved; daily backups are still off.");
  });
  const disable=()=>void run("schedule",async expected=>{
    if(!status)return;const next=await bridge!.configure(status.revision,{...status.schedule,enabled:false});dirty.current=false;apply(next,expected);setConsent(false);
    if(mounted.current)setNotice("Daily backups are off for future backups. An existing transfer is not cancelled.");
  });
  const canRunNow=Boolean(bridge?.runNow&&status?.supported&&status.refs&&!locked&&!scheduleNeedsReview(status.phase));
  const runNow=()=>void run("summary",async expected=>{
    setConfirmRun(false);if(!status||!bridge?.runNow)return;
    const next=await bridge.runNow(status.revision);apply(next,expected);
    if(mounted.current&&expected===version.current)setNotice("Backup requested. Murage will close and reopen this window to take it.");
  },runNowError);
  const canClearReview=Boolean(bridge?.clearReview&&status?.phase==="needs-review"&&!status.pending);
  const clearReview=()=>void run("summary",async expected=>{
    if(!status||!bridge?.clearReview)return;
    const next=await bridge.clearReview(status.revision);apply(next,expected);
    if(mounted.current&&expected===version.current)setNotice("Cleared. Back up now or the next daily backup will try again.");
  });
  const refreshNow=(where:ScheduleArea="advanced")=>void run(where,async expected=>{await refresh(expected);});
  return {bridge,closedBridge,modeBridge,status,draft,consent,setConsent,busy,stale,error,notice,area,closed,closedStale,closedAction,closedSetupFailed,createdKey,keyCopy,confirmRun,setConfirmRun,
    unavailable,locked,editingLocked,closedRegistered,closedAllowed,choices,lastClosed,edit,closedOperation,setClosedApp,selectReferences,setUp,saveKeyCopy,enable,disable,canRunNow,runNow,canClearReview,clearReview,refreshNow};
}
export type ScheduleController=ReturnType<typeof useBackupSchedule>;

function ScheduleMessages({s,area}:{s:ScheduleController;area:ScheduleArea}) {
  if(s.area!==area)return null;
  return <>{s.error&&<p role="alert" className="text-[13px] text-danger">{s.error}</p>}{s.notice&&<p role="status" className="text-[13px] text-ink-secondary">{s.notice}</p>}</>;
}
/** Status, lock and failure lines for the schedule, shown on whichever of
 * the setup or schedule card is visible so they are never folded away. */
function ScheduleState({s,attention}:{s:ScheduleController;attention:readonly string[]}) {
  const {status,bridge,unavailable,stale,closedStale}=s;
  const local=s.area==="schedule"?s.error:null;
  const notice=scheduleCardNotice(local,status?.error,attention);
  return <>
    <p role="status" className="text-[13px] font-medium text-ink">{status?`Daily backups are ${status.enabled?"on":"off"}. ${schedulePhase(status.phase)}`:bridge?"Checking schedule status…":"Scheduling unavailable in this window"}</p>
    {unavailable&&(!bridge||status)&&<p className="text-[13px] text-ink-secondary">Scheduled backup requires a supported packaged app with its verified backup tool.</p>}
    {status?.pending&&<p role="status" className="text-[13px] text-ink-secondary">Backup work is pending. Settings are locked; status updates automatically.</p>}
    {stale&&<p role="alert" className="text-[13px] text-warning">Status refresh failed. The last confirmed state is shown; changes are locked. Refresh schedule status to try again.</p>}
    {closedStale&&<p role="alert" className="text-[12px] text-warning">Background job status could not be refreshed. The last confirmed state is shown; backing up while Murage is closed is blocked. Refresh schedule status to try again.</p>}
    {notice&&<p role="alert" className="text-[13px] text-danger">{notice}</p>}
    {s.area==="schedule"&&s.notice&&<p role="status" className="text-[13px] text-ink-secondary">{s.notice}</p>}
  </>;
}
function PreUpgradeWarning({s}:{s:ScheduleController}) {
  const {status,draft}=s;
  return status&&(status.schedule.preUpgrade||draft.preUpgrade)&&status.preUpgradeSupported!==true?<p className="text-[13px] text-warning">Pre-upgrade backups are unavailable in this app. Your saved choices are preserved. Use a supported updater before enabling this option.</p>:null;
}

/** The key Murage just made, and the one thing left to do with it. Shown while
 * setup is still on screen AND after backups are on, because the key matters
 * far more than the schedule does. */
export function RecoveryKeyKeepsafe({s}:{s:ScheduleController}) {
  const {createdKey,keyCopy}=s;
  // Setup now takes the first backup at once, and that backup closes and
  // reopens the window, so the key note made during setup is gone before the
  // person can act on it. The saved key's name survives in the status, and
  // the desktop app still knows where the key is, so the copy stays offered.
  const saved=s.status?.refs?.recoveryLabel;
  if(!createdKey){
    if(!saved||!s.saveKeyCopy)return null;
    return <div role="status" className="min-w-0 space-y-2 rounded-lg border border-hairline/40 p-3 text-[13px] text-ink">
      <p className="break-words font-medium">Your recovery key is {saved}.</p>
      <p className="text-ink-secondary">It is the only thing that can open your backups: without it nobody, including you, can get your work back. Keep a copy somewhere else: a USB drive, another computer, or your password manager.</p>
      {keyCopy&&<p className="break-words text-ink-secondary">A copy was saved as {keyCopy}.</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={primaryButton} disabled={s.busy} onClick={s.saveKeyCopy}>Save a copy…</button>
      </div>
    </div>;
  }
  return <div role="status" className="min-w-0 space-y-2 rounded-lg border border-hairline/40 p-3 text-[13px] text-ink">
    <p className="break-words font-medium">Your recovery key is {createdKey.label}, saved in {createdKey.folder}.</p>
    <p className="text-ink-secondary">It is the only thing that can open your backups: without it nobody, including you, can get your work back. Keep a copy somewhere else: a USB drive, another computer, or your password manager.</p>
    {keyCopy&&<p className="break-words text-ink-secondary">A copy was saved as {keyCopy}.</p>}
    {s.saveKeyCopy&&<div className="flex flex-wrap gap-2">
      <button type="button" className={primaryButton} disabled={s.busy} onClick={s.saveKeyCopy}>Save a copy…</button>
    </div>}
    {createdKey.publicKey&&<details><summary className="min-h-11 cursor-pointer py-3 text-[12px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">Show public key</summary><p className="break-all font-mono text-[12px] text-ink-secondary">{createdKey.publicKey}</p></details>}
  </div>;
}

/** Shown while daily backups are off: one button, or — once a folder and key
 * are already chosen — the remaining settings. */
export function ScheduleSetup({s,onSetLimits,attention=[]}:{s:ScheduleController;onSetLimits:()=>void;attention?:readonly string[]}) {
  const {status,draft,editingLocked,consent,setConsent,choices,closedBridge,closed,closedRegistered,closedAllowed,closedAction}=s;
  const zones=useMemo(()=>timeZoneChoices(),[]);
  const closedReason=closedJobBlockedReason({bridge:Boolean(closedBridge),closed,stale:s.closedStale,setupFailed:s.closedSetupFailed});
  const limitsSet=Boolean(draft.catchup.trim()&&draft.size.trim()&&draft.duration.trim());
  return <section aria-labelledby="backup-setup-title" className={card}>
    <h3 id="backup-setup-title" className="text-[15px] font-medium text-ink">Set up backups</h3>
    <p className="text-[13px] text-ink-secondary">Murage can save an encrypted copy of your settings, conversations, files and channel history every day. Native sessions, VM homes and external folders are not included.</p>
    <ScheduleState s={s} attention={attention}/>
    {status?.supported&&<>
      <RecoveryKeyKeepsafe s={s}/>
      {!status.refs&&<div className="min-w-0 space-y-3">
        <p className="text-[13px] text-ink-secondary">{s.setUp
          ? "Pick a folder to keep your backups in. Murage makes your recovery key for you, keeps it somewhere outside that folder, and asks you once before switching daily backups on."
          : "Choose the folder to keep your backups in, and the recovery key that opens them. Murage doesn't create that key yet: choose a key file you already have. No recovery key is created or exported here."}</p>
        <div className="flex flex-wrap gap-2">
          {s.setUp
            ?<button type="button" className={primaryButton} disabled={editingLocked} onClick={()=>s.setUp?.()}>Turn on backups</button>
            :<button type="button" className={primaryButton} disabled={editingLocked} onClick={s.selectReferences}>Choose backup folder and recovery key</button>}
        </div>
        {s.setUp&&<details className="text-[13px]">
          <summary className="min-h-11 cursor-pointer py-3 text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">I already have a recovery key</summary>
          <div className="space-y-2 pt-1">
            <p className="text-ink-secondary">Murage can use a key file you already keep instead of making a new one. You pick the folder, then the key file. Murage never shows or keeps the secret part.</p>
            <button type="button" className={scheduleButton} disabled={editingLocked} onClick={()=>s.setUp?.({existingKey:true})}>Use a key I already have</button>
          </div>
        </details>}
      </div>}
      {status.refs&&<ol className="min-w-0 list-none space-y-4 p-0">
        <li className="space-y-2">
          <h4 className="text-[13px] font-medium text-ink">1. Where your backups go</h4>
          <p className="break-words text-[13px] text-ink-secondary">Backup folder: {status.refs.destinationLabel}</p>
          <p className="break-words text-[13px] text-ink-secondary">Recovery key: {status.refs.recoveryLabel}</p>
          <p className="text-[13px] text-ink-secondary">Your recovery key opens your backups. Keep a copy somewhere other than the backup folder: without it nobody, including you, can open them.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={scheduleButton} disabled={editingLocked} onClick={()=>(s.setUp??s.selectReferences)()}>Choose a different folder</button>
          </div>
        </li>
        <li className="space-y-2">
          <h4 className="text-[13px] font-medium text-ink">2. When</h4>
          <fieldset disabled={editingLocked} className="min-w-0 space-y-3">
            <legend className="sr-only">When to back up</legend>
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="text-[13px] text-ink-secondary">Time each day<input type="time" value={draft.time} onChange={event=>s.edit("time",event.target.value)} className={scheduleInput}/></label>
              <label className="text-[13px] text-ink-secondary">Time zone<input value={draft.timezone} list="backup-timezones" maxLength={100} spellCheck={false} autoComplete="off" onChange={event=>s.edit("timezone",event.target.value)} className={scheduleInput} aria-describedby="backup-timezone-help"/></label>
              <datalist id="backup-timezones">{zones.map(zone=><option key={zone} value={zone}/>)}</datalist>
            </div>
            <p id="backup-timezone-help" className="text-[12px] text-ink-secondary">Your computer's time zone is filled in. Start typing to pick another, such as Asia/Bangkok.</p>
            {(closedBridge||draft.closedApp)&&<label className="flex min-h-11 items-start gap-3 py-2 text-[13px] text-ink">
              <input type="checkbox" checked={draft.closedApp} disabled={!draft.closedApp&&!closedAllowed} onChange={event=>s.setClosedApp(event.target.checked)} className={checkbox} aria-describedby={closedReason?"backup-closed-help backup-closed-reason":"backup-closed-help"}/>
              <span>Also back up when Murage is closed</span>
            </label>}
            {closedReason&&<p id="backup-closed-reason" className="text-[12px] text-warning">{closedReason}</p>}
            {(closedBridge||draft.closedApp)&&<p id="backup-closed-help" className="text-[12px] text-ink-secondary">Only while you're signed in to this computer; it won't wake a sleeping computer. Ticking this sets up a background job for your user account.</p>}
          </fieldset>
          {closedAction==="setup"&&<p role="status" className="text-[12px] text-ink-secondary">Setting up the background job…</p>}
          {(!closedBridge||closed?.supported===false)&&<p className="text-[12px] text-ink-secondary">{typeof window!=="undefined"&&window.muragebox?.platform==="win32"?"Backing up while Murage is closed isn't available on Windows yet. Backups while Murage is open work without it.":"Backing up while Murage is closed needs a supported desktop app, backup tool and your signed-in session. Backups while Murage is open work without it."}</p>}
          {draft.closedApp&&(!closedRegistered||status.closedAppSupported!==true)&&<p className="text-[12px] text-warning">Your choice to back up while Murage is closed is saved, but the background job isn't registered. Untick and tick the box to set it up, or leave it unticked to back up only while Murage is open.</p>}
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[12px] text-ink-secondary">{limitsSet?"Backup limits are set. You can change them under Advanced.":"Backup limits aren't set yet. They are required the first time."}</p>
            <button type="button" className={scheduleButton} onClick={onSetLimits}>{limitsSet?"Review limits":"Set limits"}</button>
          </div>
        </li>
      </ol>}
      <PreUpgradeWarning s={s}/>
      {status.refs&&<>
        <label className="flex min-h-11 items-start gap-3 py-2 text-[13px] text-ink">
          <input type="checkbox" checked={consent} disabled={editingLocked} onChange={event=>setConsent(event.target.checked)} className={checkbox}/>
          <span>Allow Murage to close and reopen its own window when it's idle, so it can take the backup. Murage does that itself, so you never need to quit it.</span>
        </label>
        {!choices&&<p className="text-[12px] text-ink-secondary">To turn on, set a time and the backup limits, then tick the box above.</p>}
        <button type="button" className={primaryButton} disabled={editingLocked||!choices} onClick={s.enable}>Turn on daily backups</button>
      </>}
    </>}
  </section>;
}

/** Shown once daily backups are on: the saved settings and "Turn off". */
export function ScheduleCard({s,attention=[]}:{s:ScheduleController;attention?:readonly string[]}) {
  const {status,locked}=s;
  if(!status)return null;
  const rows:[string,string][]=[
    ["Backup folder",status.refs?.destinationLabel??"Not chosen"],
    ["Recovery key",status.refs?.recoveryLabel??"Not chosen"],
    ["When",`Daily at ${status.schedule.time??"?"} (${status.schedule.timezone??"?"})`],
    ["While Murage is closed",status.schedule.closedApp===true?`On · ${closedJobLabel(s.closed?.state)}`:"Off"],
  ];
  return <section aria-labelledby="backup-schedule-title" className={card}>
    <h3 id="backup-schedule-title" className="text-[15px] font-medium text-ink">Schedule</h3>
    <ScheduleState s={s} attention={attention}/>
    <RecoveryKeyKeepsafe s={s}/>
    <dl className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 text-[13px] sm:grid-cols-[max-content_1fr]">
      {rows.map(([label,value])=><div key={label} className="contents"><dt className="text-ink-secondary">{label}</dt><dd className="break-words text-ink">{value}</dd></div>)}
    </dl>
    <PreUpgradeWarning s={s}/>
    <p className="text-[13px] text-ink-secondary">Turn off daily backups before changing the time, folder, recovery key or limits.</p>
    <button type="button" className={scheduleButton} disabled={locked} onClick={s.disable}>Turn off</button>
  </section>;
}

/** Limits, pre-upgrade backup and the background job's manual controls. */
function ScheduleAdvanced({s}:{s:ScheduleController}) {
  const {status,draft,editingLocked,locked,closed,closedBridge,closedStale,closedAction,lastClosed}=s;
  if(!status?.supported)return null;
  return <div className="space-y-4">
    <fieldset disabled={editingLocked} className="min-w-0 space-y-3">
      <legend className="text-[13px] font-medium text-ink">Backup limits</legend>
      <label className="block text-[13px] text-ink-secondary">Late start allowed (hours)<input id="backup-catchup" type="number" min={1/60} max={168} step="any" value={draft.catchup} onChange={event=>s.edit("catchup",event.target.value)} className={scheduleInput} aria-describedby="backup-catchup-help"/></label>
      <p id="backup-catchup-help" className="text-[12px] text-ink-secondary">If Murage is busy or closed at backup time, how late the backup may still start: 1 minute to 168 hours.</p>
      <label className="block text-[13px] text-ink-secondary">Maximum backup size (GiB)<input type="number" min={1/(1024**3)} max={1024} step="any" value={draft.size} onChange={event=>s.edit("size",event.target.value)} className={scheduleInput} aria-describedby="backup-size-help"/></label>
      <p id="backup-size-help" className="text-[12px] text-ink-secondary">1 GiB is about 1.07 GB. More than zero and up to 1,024 GiB.</p>
      <label className="block text-[13px] text-ink-secondary">Maximum run time (minutes)<input type="number" min={1/60} max={30} step="any" value={draft.duration} onChange={event=>s.edit("duration",event.target.value)} className={scheduleInput} aria-describedby="backup-duration-help"/></label>
      <p id="backup-duration-help" className="text-[12px] text-ink-secondary">1 second to 30 minutes.</p>
      {status.preUpgradeSupported===true&&<label className="flex min-h-11 items-start gap-3 py-2 text-[13px] text-ink">
        <input type="checkbox" checked={draft.preUpgrade} onChange={event=>s.edit("preUpgrade",event.target.checked)} className={checkbox}/>
        <span>Back up before installing an in-app update.</span>
      </label>}
    </fieldset>
    {status.enabled&&<p className="text-[12px] text-ink-secondary">Turn off daily backups before changing these.</p>}
    <div className="space-y-2 border-t border-hairline/40 pt-3">
      <h4 className="text-[13px] font-medium text-ink">Background job for closed-app backups</h4>
      <p role="status" className="text-[13px] text-ink">{closedBridge?closedJobLabel(closed?.state):"Closed-app scheduling unavailable in this window"}</p>
      <p className="text-[12px] text-ink-secondary">For recovery situations. "Also back up when Murage is closed" normally does this for you. Registration alone does not turn on backups, and it does not promise backups while signed out or wake a sleeping computer.</p>
      {closed?.supported&&<div className="flex flex-wrap gap-2">
        {closed.state==="unconfigured"&&<button type="button" className={scheduleButton} disabled={locked||closedStale} onClick={()=>void s.closedOperation("stage")}>{closedAction==="stage"?"Preparing job…":"Prepare closed-app job"}</button>}
        {["staged","disabled"].includes(closed.state)&&<button type="button" className={scheduleButton} disabled={locked||closedStale} onClick={()=>void s.closedOperation("install")}>{closedAction==="install"?"Confirming registration…":"Register prepared job"}</button>}
        {["staged","installed","disabled-removal-pending","unavailable"].includes(closed.state)&&<button type="button" className={scheduleButton} disabled={locked} onClick={()=>void s.closedOperation("disable")}>{closedAction==="disable"?"Disabling schedules…":"Disable all scheduled backups and remove job"}</button>}
      </div>}
      {closed?.state==="disabled-removal-pending"&&<p className="text-[12px] text-warning">{status.enabled?"Check the current schedule above.":"All scheduled backups are disabled."} Job removal still needs attention. Use the disable-and-remove action again when no backup is running.</p>}
      {lastClosed&&<p className="text-[12px] text-ink-secondary">Last closed-app result: {lastClosed.label} · {new Date(lastClosed.at).toLocaleString()}</p>}
    </div>
  </div>;
}

/** "Your backups": one plain summary, the attention line and quick actions. */
export function BackupStatusCard({summary,s,r,onRestore}:{summary:BackupSummary;s:ScheduleController;r:RemoteController;onRestore:()=>void}) {
  const stale=s.stale||s.closedStale||r.stale;
  const rows:[string,string][]=[["Last backup",summary.last],["Daily backups",summary.schedule],["Off-site copy",summary.offsite]];
  return <section aria-labelledby="backups-status-title" className={card}>
    <h3 id="backups-status-title" className="text-[15px] font-medium text-ink">Your backups</h3>
    <dl className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 text-[13px] sm:grid-cols-[max-content_1fr]">
      {rows.map(([label,value])=><div key={label} className="contents"><dt className="text-ink-secondary">{label}</dt><dd className="break-words text-ink">{value}</dd></div>)}
    </dl>
    {s.status?.lastVerified&&<p className="text-[12px] text-ink-secondary">The last backup was checked on this computer. To be sure a restore works, try one from Restore.</p>}
    {summary.attention.length>0&&<div role="status" className="text-[13px] text-warning">
      <p className="font-medium">Needs attention</p>
      <ul className="list-disc pl-5">{summary.attention.map(item=><li key={item}>{item}</li>)}</ul>
    </div>}
    {s.canClearReview&&<p className="text-[13px] text-ink">The last backup stopped before Murage could confirm it, so backups are paused. Your workspace was not changed. Clear this to back up again. If it happens again, check that the backup folder and recovery key are still available.</p>}
    {s.confirmRun&&<p className="text-[13px] text-ink">Murage will close and reopen this window to take the backup.</p>}
    <div className="flex flex-wrap gap-2">
      {s.bridge?.runNow&&(s.confirmRun
        ?<><button type="button" className={primaryButton} disabled={!s.canRunNow} onClick={s.runNow}>Continue</button><button type="button" className={scheduleButton} onClick={()=>s.setConfirmRun(false)}>Cancel</button></>
        :<button type="button" className={primaryButton} disabled={!s.canRunNow} onClick={()=>s.setConfirmRun(true)}>Back up now</button>)}
      {s.canClearReview&&<button type="button" className={primaryButton} disabled={s.busy} onClick={s.clearReview}>Clear and try again</button>}
      <button type="button" className={scheduleButton} onClick={onRestore}>Restore…</button>
      {stale&&<button type="button" className={scheduleButton} disabled={s.busy||Boolean(r.busy)} onClick={()=>{s.refreshNow("summary");r.refreshNow();}}>Check again</button>}
    </div>
    {s.bridge?.runNow&&!s.status?.refs&&<p className="text-[12px] text-ink-secondary">Back up now is available once a backup folder and recovery key are chosen.</p>}
    <ScheduleMessages s={s} area="summary"/>
  </section>;
}

function Disclosure({id,title,open,onToggle,above,children}:{id:string;title:string;open:boolean;onToggle:()=>void;above?:ReactNode;children:ReactNode}) {
  return <section aria-labelledby={`${id}-title`} className={card}>
    <h3 id={`${id}-title`} className="text-[15px] font-medium text-ink">
      <button id={`${id}-toggle`} type="button" aria-expanded={open} aria-controls={`${id}-panel`} onClick={onToggle} className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
        <span>{title}</span><ChevronDown size={16} aria-hidden="true" className={open?"rotate-180 text-ink-secondary":"text-ink-secondary"}/>
      </button>
    </h3>
    {above}
    <div id={`${id}-panel`} hidden={!open} className="min-w-0 space-y-4">{open&&children}</div>
  </section>;
}

/** Settings → Backups. */
export function BackupSettings() {
  const mode=useBackupMode(),s=useBackupSchedule(),r=useBackupRemote();
  const [offsiteOpen,setOffsiteOpen]=useState<boolean|null>(null),[restoreOpen,setRestoreOpen]=useState(false),[advancedOpen,setAdvancedOpen]=useState(false);
  const [focus,setFocus]=useState<string|null>(null);
  useEffect(()=>{
    if(!focus)return;const target=document.getElementById(focus);
    target?.scrollIntoView?.({block:"start"});target?.focus();setFocus(null);
  },[focus]);
  const summary=backupSummary({scheduleBridge:Boolean(s.bridge),schedule:s.status,scheduleStale:s.stale,scheduleFailure:s.error,closed:s.closed,closedStale:s.closedStale,remoteBridge:Boolean(r.bridge),remote:r.status,remoteStale:r.stale,remoteFailure:r.error});
  const offsiteExpanded=offsiteOpen??r.configured;
  return <div className="min-w-0 space-y-4">
    <BackupStatusCard summary={summary} s={s} r={r} onRestore={()=>{setRestoreOpen(true);setFocus("backup-restore-toggle");}}/>
    {s.status?.enabled?<ScheduleCard s={s} attention={summary.attention}/>:<ScheduleSetup s={s} attention={summary.attention} onSetLimits={()=>{setAdvancedOpen(true);setFocus("backup-catchup");}}/>}
    <Disclosure id="backup-offsite" title="Off-site copy (optional)" open={offsiteExpanded} onToggle={()=>setOffsiteOpen(!offsiteExpanded)} above={<OffsiteStatus r={r}/>}>
      <OffsiteDetails r={r}/>
    </Disclosure>
    <Disclosure id="backup-restore" title="Restore" open={restoreOpen} onToggle={()=>setRestoreOpen(value=>!value)}>
      <BackupSettingsView supported={mode.supported} busy={mode.busy} error={mode.error} onRestart={()=>void mode.restart()}/>
      <div className="space-y-3 border-t border-hairline/40 pt-3">
        <h4 className="text-[13px] font-medium text-ink">From the off-site copy</h4>
        <OffsiteRecover r={r}/>
      </div>
    </Disclosure>
    <Disclosure id="backup-advanced" title="Advanced" open={advancedOpen} onToggle={()=>setAdvancedOpen(value=>!value)}>
      <ScheduleAdvanced s={s}/>
      <OffsiteCleanup r={r}/>
      <div className="flex flex-wrap gap-2 border-t border-hairline/40 pt-3">
        {s.bridge&&<button type="button" className={scheduleButton} disabled={s.busy} onClick={()=>s.refreshNow("advanced")}>Refresh schedule status</button>}
        <OffsiteRefresh r={r}/>
      </div>
      <ScheduleMessages s={s} area="advanced"/>
    </Disclosure>
  </div>;
}
