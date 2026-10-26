import { normalizeBackupAgeDiagnostic } from "./backup-age-attestation.mjs";
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { readBackupIdentity } from "./backup-mode.mjs";
import { pathWithin, samePath } from "../shared/path-identity.mjs";
import { parseUpdateCandidate, canonicalUpdateDescriptor } from "../shared/update-candidate.mjs";
import { BACKUP_CAPTURE_CODES, BACKUP_CAPTURE_STAGES, captureFailurePath, normalizeCaptureCause } from "../shared/backup-capture-failure.mjs";
import { readSetupBackupRecord } from "../shared/setup-backup-record.mjs";

export const BACKUP_SCHEDULE_BINDINGS_KEY = "backupScheduleBindings";
/** Settings L5: where the first run's backup step stands when the backup
 * host itself could not start. Nothing can be verified without it, but a
 * step the harness says is owed is still reported, so the card keeps its
 * way out ("Keep backups off") instead of vanishing. Only "off" stands on
 * its own: a saved "verified" holds only while a receipt of the current
 * folder and key exists (server/setup-backup.ts deriveSetupBackup), and
 * without a host no receipt can be checked, so that step is still owed. */
export function firstRunWithoutHost(dataDir){
  let server;try{server=readSetupBackupRecord(dataDir);}catch{server={kind:"unreadable"};}
  const ending=server.kind==="record"?server.record.ending:null;
  return {eligible:false,completed:ending==="off"?"off":null,owed:server.kind==="unreadable"||(server.kind==="record"&&server.record.owed&&ending!=="off")};
}
const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fingerprint=file=>{const s=lstatSync(file);if(s.isSymbolicLink())throw Error("BACKUP_REFERENCE_CHANGED");return [s.dev,s.ino,s.size,s.mtimeMs];};
const installationIdentity=root=>{const actual=realpathSync(root),s=lstatSync(actual);if(!s.isDirectory())throw Error("BACKUP_REFERENCE_CHANGED");return hash([actual,s.dev,s.ino]);};
const activePhases=new Set(["handoff-prepared","handoff-armed","offline-claimed","capturing","return-pending","install-requested"]);
const checkedCandidate=input=>{const c=parseUpdateCandidate(input);if(c.candidateId!=="update-"+createHash("sha256").update(canonicalUpdateDescriptor(c)).digest("hex"))throw Error("BACKUP_UPDATE_CANDIDATE_INVALID");return c;};
function verifiedArtifact(output,maxBytes){
  const before=lstatSync(output);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>maxBytes)throw Error("BACKUP_RECEIPT_MISMATCH");
  const fd=openSync(output,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const opened=fstatSync(fd);if(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size||opened.mtimeMs!==before.mtimeMs)throw Error("BACKUP_RECEIPT_MISMATCH");
    const hasher=createHash("sha256"),chunk=Buffer.alloc(1024*1024);let offset=0;
    while(offset<before.size){const size=readSync(fd,chunk,0,Math.min(chunk.length,before.size-offset),offset);if(!size)throw Error("BACKUP_RECEIPT_MISMATCH");hasher.update(chunk.subarray(0,size));offset+=size;}
    const after=fstatSync(fd),named=lstatSync(output);if([after,named].some(s=>s.dev!==opened.dev||s.ino!==opened.ino||s.size!==opened.size||s.mtimeMs!==opened.mtimeMs||s.ctimeMs!==opened.ctimeMs||s.nlink!==1))throw Error("BACKUP_RECEIPT_MISMATCH");
    return {sha256:hasher.digest("hex"),bytes:before.size};
  }finally{closeSync(fd);}
}

// The two closed sets live in shared/backup-capture-failure.mjs, next to the
// plain-English sentence built from them, so the Backups page, the Backup
// mode page and this host all name a failure the same way.
// One log line when a verified backup left something out, so a leftover file in
// the data folder (Sean's config.json.bak-20260918-openaicompat, 1.0.4) is named
// once in the log as well as on the Backups page. The worker's list is untrusted:
// only top-level names (never a path inside a folder), at most 10, and only
// plain reason words are written.
export function skippedOutcomeLine(job,skipped){
  if(!skipped||typeof skipped!=="object"||!Number.isSafeInteger(skipped.count)||skipped.count<1)return null;
  const reasons=Object.create(null),names=[];
  for(const item of Array.isArray(skipped.items)?skipped.items:[]){
    if(!item||typeof item.path!=="string"||typeof item.reason!=="string"||!/^[a-z][a-z-]{0,31}$/.test(item.reason))continue;
    reasons[item.reason]=(reasons[item.reason]??0)+1;
    if(names.length<10&&item.path.length>0&&!/[\\/]/.test(item.path))names.push(item.path.slice(0,120));
  }
  return `backup skipped ${JSON.stringify({job,count:skipped.count,reasons,names})}`;
}
const captureFailureStages=new Set(BACKUP_CAPTURE_STAGES);
const captureFailureCodes=new Set(BACKUP_CAPTURE_CODES);
const ownedCaptureWaits=new Map([
  ["Desktop startup has not settled","OWNED_STARTUP_UNSETTLED"],["Owned writers have not exited","OWNED_WRITERS_UNSETTLED"],
  ["Credential writes have not settled","OWNED_CREDENTIALS_UNSETTLED"],["Companion startup has not settled","OWNED_COMPANION_START_UNSETTLED"],
  ["Companion has not stopped","OWNED_COMPANION_STOP_UNSETTLED"],["Browser cleanup has not settled","OWNED_BROWSER_CLEANUP_UNSETTLED"],
  ["Browser host has not stopped","OWNED_BROWSER_STOP_UNSETTLED"],["Computer-use startup has not settled","OWNED_CUA_START_UNSETTLED"],
  ["Computer-use cleanup has not completed","OWNED_CUA_STOP_UNSETTLED"],
].map(([label,code])=>[label+"; Murage kept installation ownership. Wait and retry Quit.",code]));
/** Local diagnostic only: never retain arbitrary error fields, messages or paths. */
/** The arguments of a "backup-schedule:set-up" request, or null when they are
 * malformed. The preload bridge always forwards its one options slot, so the
 * ordinary "Turn on backups" call arrives as [undefined]; that is the plain
 * road, not a malformed request. */
export function setUpBackupsRequest(args){
  if(!Array.isArray(args)||args.length>1)return null;
  const options=args[0];
  if(options===undefined)return {existingKey:false};
  if(typeof options!=="object"||options===null||Array.isArray(options))return null;
  // First run: the default folder, no picker, no confirmation dialog. It is
  // the only option in that request; it never rides along with another.
  if("firstRun" in options){
    if(options.firstRun!==true||Object.keys(options).length!==1)return null;
    return {existingKey:false,firstRun:true};
  }
  if(Object.keys(options).some(key=>key!=="existingKey")||!["boolean","undefined"].includes(typeof options.existingKey))return null;
  return {existingKey:options.existingKey===true};
}
export function captureFailureDiagnostic(stage,error){
  const candidate=captureFailureCodes.has(error?.code)?error.code:captureFailureCodes.has(error?.message)?error.message:null;
  let backupAgeAttestation=null;try{if(candidate==="AGE_TOOL_UNVERIFIED")backupAgeAttestation=normalizeBackupAgeDiagnostic(error?.backupAgeAttestation);}catch{/* Diagnostic properties are not trusted. */}
  // The item inside the data folder the refusal is about, when it names one.
  let path;try{path=captureFailurePath(error?.path);}catch{/* Diagnostic properties are not trusted. */}
  return{stage:captureFailureStages.has(stage)?stage:"unknown",code:candidate??ownedCaptureWaits.get(error?.message)??"UNKNOWN_CAPTURE_FAILURE",...(path?{path}:{}),...(backupAgeAttestation?{backupAgeAttestation}:{})};
}

/** Existing coordinator and native ownership/worker are injected, never duplicated. */
export function createBackupScheduleHost(host) {
  const coordinator=host.coordinator;
  let running=false,timer=null,lastError=null,upgradeRequest=null,upgradeCandidateId=null;
  // Who the last refused backup was waiting on, when it was a person's
  // answer (electron/backup-waiting.mjs). A due daily backup keeps trying
  // every minute, so `since` is when it first had to wait.
  let heldBy=null;
  const holdFor=(error,occasion)=>{
    if(error?.message!=="BACKUP_WAITING_ON_YOU"||!Array.isArray(error.waitingOnYou)||!error.waitingOnYou.length)return false;
    heldBy={occasion,since:heldBy?.occasion===occasion?heldBy.since:now(),bots:error.waitingOnYou};return true;
  };
  const now=()=>host.now?.()??Date.now();
  const verifyIdentityAccess=async()=>{
    const installation=host.installation();
    await host.verifyEncrypted?.();
    if(!host.supported()||installation!==host.installation())throw Error("BACKUP_UNAVAILABLE");
  };
  const read=async()=>{
    const encoded=await host.readProtected(BACKUP_SCHEDULE_BINDINGS_KEY);
    if(!encoded)return null;
    let b;try{b=JSON.parse(encoded);}catch{throw Error("BACKUP_BINDINGS_INVALID");}
    if(b?.version!==1||![b.installationRef,b.destinationRef,b.recoveryRef].every(value=>typeof value==="string"&&/^[A-Za-z0-9_-]{1,120}$/.test(value))||![b.destination,b.keyFile].every(value=>typeof value==="string"&&value.length<8192&&path.isAbsolute(value))||typeof b.allowIdleRestart!=="boolean"||typeof b.recipient!=="string")throw Error("BACKUP_BINDINGS_INVALID");
    return b;
  };
  // A backup folder or key that is simply gone (unplugged drive, renamed
  // folder) is named, not folded into "settings could not be updated".
  const present=(file,code)=>{try{lstatSync(file);}catch(error){if(["ENOENT","ENOTDIR"].includes(error?.code))throw Error(code);throw Error("BACKUP_REFERENCE_CHANGED");}};
  const checked=async()=>{
    const b=await read(),s=coordinator.status();
    if(b){present(b.destination,"BACKUP_FOLDER_MISSING");present(b.keyFile,"BACKUP_RECOVERY_KEY_MISSING");}
    if(!b||!b.allowIdleRestart||b.installationIdentity!==installationIdentity(host.installation())||s.schedule.installationRef!==b.installationRef||s.schedule.destinationRef!==b.destinationRef||s.schedule.recoveryRef!==b.recoveryRef||hash(fingerprint(b.keyFile))!==b.keyFingerprint||!lstatSync(b.destination).isDirectory()||realpathSync(b.destination)!==b.destination||installationIdentity(b.destination)!==b.destinationIdentity)throw Error("BACKUP_REFERENCE_CHANGED");
    return b;
  };
  // Settings L5. ONE state, owned by this host and the harness together:
  //  - this host owns the facts: the coordinator's schedule and receipt, the
  //    saved folder and key, and its first-run record (backup-first-run.json);
  //  - the harness owns setup-backup.json in the data folder: whether this
  //    folder owes the first-run backup at all (written once, when setup
  //    starts on a folder that has never had backups) and how it ended.
  // Nothing the renderer sends is a claim: "verified" is derived here, every
  // time, from a receipt that matches the folder and key in use NOW, and the
  // harness derives it the same way from this host's files. The first run may
  // set backups up without a dialog only when BOTH records say it is still
  // owed and nothing was ever set up. An unreadable record counts as decided.
  const firstRunRecord=()=>{try{return coordinator.firstRunRecord?.()??null;}catch{return {state:"unreadable"};}};
  const setupRecord=()=>{try{return readSetupBackupRecord(host.installation());}catch{return {kind:"unreadable"};}};
  /** The receipt was checked against the folder and key backups use now. */
  const receiptCurrent=(s,b)=>Boolean(s.lastVerified&&b&&s.lastVerified.installationRef===b.installationRef&&s.lastVerified.destinationRef===b.destinationRef&&s.schedule.installationRef===b.installationRef&&s.schedule.destinationRef===b.destinationRef&&s.schedule.recoveryRef===b.recoveryRef);
  async function firstRunState(){
    const s=coordinator.status(),record=firstRunRecord(),server=setupRecord();
    let b=null,bindingsKnown=true;try{b=await read();}catch{bindingsKnown=false;}
    let keyKnown=false;try{keyKnown=Boolean(host.recoveryKeyKnown?.());}catch{keyKnown=true;}
    const serverEnding=server.kind==="record"?server.record.ending:null;
    // "verified" is only ever now; "off" stands wherever it was recorded.
    const completed=s.enabled&&receiptCurrent(s,b)?"verified":record?.state==="off"||serverEnding==="off"?"off":null;
    const owedByServer=server.kind==="unreadable"||(server.kind==="record"&&server.record.owed);
    const eligible=server.kind==="record"&&server.record.owed&&server.record.ending===null&&!record&&bindingsKnown&&!b&&s.revision===0&&!s.lastVerified&&!s.job&&!keyKnown;
    // Owed: setup still waits on this step, so the card keeps its way out.
    return {eligible,completed,owed:completed===null&&owedByServer};
  }
  /** Asks the harness to re-derive the step from these files now. A request,
   * never a claim: it carries no state. */
  const firstRunChanged=async()=>{try{await host.firstRunChanged?.();}catch{/* the harness re-derives on its next read */}};
  const publicStatus=async()=>{
    const s=coordinator.status();let refs;try{const b=await read();if(b)refs={installationRef:b.installationRef,destinationRef:b.destinationRef,recoveryRef:b.recoveryRef,destinationLabel:path.basename(b.destination),recoveryLabel:path.basename(b.keyFile)};}catch{lastError="BACKUP_BINDINGS_UNAVAILABLE";}
    let preUpgradeSupported=false;try{await assertUpgradeAllowed();preUpgradeSupported=true;}catch{/* Static capability refusal is not a schedule failure. */}
    let closedAppSupported=false;try{await assertClosedAllowed();closedAppSupported=true;}catch{/* Static capability refusal is not a schedule failure. */}
    const supported=host.supported(),checking=!supported&&Boolean(host.checking?.());
    // Why backups can't run from this window, when it is not just the tool
    // still being checked: the page says so in words, with what to do.
    let unavailable=null;if(!supported&&!checking)try{const reason=host.unavailableReason?.();unavailable=["tool","closing"].includes(reason)?reason:null;}catch{/* a probe failure keeps the plain label */}
    // An answered card stops being named now, not at the next backup.
    if(heldBy&&typeof host.waitingNow==="function")try{
      const now=await host.waitingNow();
      if(Array.isArray(now)){const still=heldBy.bots.filter(bot=>now.some(other=>other?.botId===bot.botId&&other?.threadId===bot.threadId));heldBy=still.length?{...heldBy,bots:still}:null;}
    }catch{/* keep the last known answer when the harness can't say */}
    // Said before setup starts, so daily backups are never switched on on a
    // computer where no backup could ever run.
    let restartBlocked=null;try{restartBlocked=captureBlocked();}catch{/* A probe failure is not a refusal. */}
    let firstRun;try{firstRun=await firstRunState();}catch{firstRun={eligible:false,completed:null,owed:false};}
    return {supported,firstRun,...(restartBlocked?{relaunchBlocked:restartBlocked}:{}),...(heldBy?{heldBy}:{}),...(checking?{checking:true}:{}),...(unavailable?{unavailable}:{}),preUpgradeSupported,closedAppSupported,pending:running,enabled:s.enabled,revision:s.revision,phase:s.phase,schedule:s.schedule,lastVerified:s.lastVerified,lastClosedResult:s.lastClosedResult,...(s.reviewReason?{reviewReason:s.reviewReason}:{}),...(s.captureFailure?{captureFailure:s.captureFailure}:{}),...(s.lastSkipped?{lastSkipped:s.lastSkipped}:{}),refs,error:lastError};
  };
  const stopPolling=()=>{if(timer)clearInterval(timer);timer=null;};
  const start=()=>{stopPolling();if(!coordinator.status().enabled)return;timer=setInterval(()=>{void tick();},60000);timer.unref?.();void tick();};
  const assertUpgradeAllowed=async candidate=>{if(!host.supported()||typeof host.assertUpgradeAllowed!=="function")throw Error("BACKUP_PREUPGRADE_UNAVAILABLE");await host.assertUpgradeAllowed(candidate);};
  // Every in-app backup restarts Murage; refuse before closing anything where
  // that restart would crash instead of coming back.
  // The Windows backup helper refuses an elevated Murage by design; say so
  // before anything closes instead of failing inside Backup mode.
  // relaunchBlocked answers with a refusal code (an AppImage whose file was
  // moved has its own words) or, from older hosts, just true.
  const relaunchRefusal=()=>{const blocked=host.relaunchBlocked?.();return !blocked?null:typeof blocked==="string"&&/^BACKUP_RELAUNCH_[A-Z_]{1,40}$/.test(blocked)?blocked:"BACKUP_RELAUNCH_BLOCKED";};
  const captureBlocked=()=>relaunchRefusal()??(host.elevated?.()?"BACKUP_ELEVATED":null);
  const assertRelaunchPossible=()=>{const blocked=captureBlocked();if(blocked)throw Error(blocked);};
  const assertClosedAllowed=async()=>{if(!host.supported()||typeof host.assertClosedAllowed!=="function")throw Error("BACKUP_CLOSED_UNAVAILABLE");await host.assertClosedAllowed();};
  function pendingUpgrade(){const s=coordinator.status(),candidate=s.job?.handoff?.upgrade;return candidate&&!["upgrade-complete","upgrade-cancelled"].includes(s.phase)?{candidate,handoffId:s.job.handoff.id,phase:s.phase}:null;}
  async function verifyUpgrade(candidate){
    candidate=checkedCandidate(candidate);await assertUpgradeAllowed(candidate);
    const b=await checked(),s=coordinator.status(),intent=s.job?.handoff;
    if(!intent)throw Error("BACKUP_UPGRADE_REJECTED");
    coordinator.validateUpgrade(intent.id,candidate,hash(b),installationIdentity(host.installation()));
    const r=s.job.receipt,artifact=verifiedArtifact(path.join(b.destination,s.job.id+".age"),s.schedule.maxBytes);
    if(artifact.sha256!==r.sha256||artifact.bytes!==r.bytes)throw Error("BACKUP_RECEIPT_MISMATCH");
    return {candidate,handoffId:intent.id,phase:s.phase,bindingRevision:hash(b),installationIdentity:b.installationIdentity};
  }
  function requestUpgrade(input){
    const current=coordinator.status();
    if(!upgradeRequest&&pendingUpgrade())return Promise.reject(Error("BACKUP_UPGRADE_PENDING"));
    if(!current.enabled||!current.schedule.preUpgrade)return Promise.resolve({status:"continue"});
    const candidate=checkedCandidate(input);
    if(upgradeRequest){if(upgradeCandidateId!==candidate.candidateId)return Promise.reject(Error("BACKUP_UPGRADE_PENDING"));return upgradeRequest;}
    upgradeCandidateId=candidate.candidateId;
    upgradeRequest=(async()=>{
      const s=coordinator.status();
      if(pendingUpgrade())throw Error("BACKUP_UPGRADE_PENDING");
      if(running)throw Error("BACKUP_BUSY");
      running=true;let release,intent;
      try{
        await assertUpgradeAllowed(candidate);assertRelaunchPossible();const b=await checked();
        if(s.job&&!["local-verified","skipped","returned","upgrade-complete","upgrade-cancelled"].includes(s.phase))throw Error("BACKUP_REVIEW_REQUIRED");
        release=await host.prepare();
        intent={version:1,id:randomUUID(),bindingRevision:hash(b),installationIdentity:b.installationIdentity,expiresAt:now()+30*60000,upgrade:candidate};
        coordinator.prepareUpgrade(candidate,intent);stopPolling();
        await host.cleanupIdle();coordinator.armHandoff(intent.id);await host.relaunch("backup");lastError=null;
        return {status:"deferred",message:"Backup restart prepared before installing this update."};
      }catch(error){
        lastError="BACKUP_UPGRADE_DEFERRED";
        if(intent)try{coordinator.failHandoff(intent.id);}catch{/* Preserve authoritative state. */}
        if(release)try{await release();}catch{lastError="BACKUP_RELEASE_UNCONFIRMED";}
        throw error;
      }finally{running=false;}
    })().finally(()=>{upgradeRequest=null;upgradeCandidateId=null;});return upgradeRequest;
  }
  const REFERENCE_FAILURES=new Set(["BACKUP_FOLDER_MISSING","BACKUP_RECOVERY_KEY_MISSING","BACKUP_REFERENCE_CHANGED"]);
  /** Stops a job whose folder or key can't be used: needs review, the reason
   * recorded, and the desktop told so it can post the Inbox row and one
   * notification (D3). Returns the code, or null for any other error. */
  function stopForReferences(jobId,error){
    const code=error instanceof Error&&REFERENCE_FAILURES.has(error.message)?error.message:null;if(!code||!jobId)return code;
    try{coordinator.failWaiting(jobId);}catch{return code;}
    try{coordinator.recordCaptureFailure?.({stage:"references",code});}catch{/* the phase alone still says it needs review */}
    try{host.reportCaptureFailure?.({stage:"references",code});}catch{/* log only */}
    try{void Promise.resolve(host.announceFailure?.()).catch(()=>{});}catch{/* never worth a failed tick */}
    return code;
  }
  async function tick(upgradeId){
    if(running)return;
    if(!coordinator.status().enabled)return;
    running=true;let release,intent;
    try{
      const s=await coordinator.tick(upgradeId);
      if(!["due","waiting-idle","waiting-backup-mode"].includes(s.phase))return;
      // A due backup that can't run used to wait here without a word, every
      // day (0.1.60 Windows final D1). Say so: the Inbox row, one
      // notification, and the page's sentence, each with what to do.
      if(!host.supported()){
        if(!host.checking?.())try{const reason=host.unavailableReason?.();if(reason)void Promise.resolve(host.announceUnavailable?.(reason)).catch(()=>{});}catch{/* never worth a failed tick */}
        return;
      }
      const blocked=captureBlocked();if(blocked){lastError=blocked;return;}
      let b;try{b=await checked();}catch(error){const code=stopForReferences(s.job?.id,error);if(code){lastError=code;return;}throw error;}
      release=await host.prepare("daily");heldBy=null;
      intent={version:1,id:randomUUID(),bindingRevision:hash(b),installationIdentity:b.installationIdentity,expiresAt:now()+30*60000};
      coordinator.prepareHandoff(s.job.id,intent);
      stopPolling();await host.cleanupIdle();coordinator.armHandoff(intent.id);
      await host.relaunch("backup");lastError=null;
    }catch(error){
      lastError=holdFor(error,"daily")?"BACKUP_WAITING_ON_YOU":"BACKUP_HANDOFF_DEFERRED";
      if(intent)try{coordinator.failHandoff(intent.id);}catch{/* Preserve unreadable state. */}
      if(release)try{await release();}catch{lastError="BACKUP_RELEASE_UNCONFIRMED";}
    }finally{running=false;}
  }
  /** Clears a backup that stopped without a confirmed result, so backups can
   * run again. Never while this window is preparing one. */
  async function clearReview(expectedRevision){
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw Error("INVALID_BACKUP_REQUEST");
    if(running)throw Error("BACKUP_BUSY");
    coordinator.clearReview(expectedRevision);coordinator.clearCaptureFailure?.();lastError=null;
    return publicStatus();
  }
  /** User-requested backup through the same handoff a due daily run takes.
   * Every precondition is proven before the workspace is asked to close. */
  async function runNow(expectedRevision){
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw Error("INVALID_BACKUP_REQUEST");
    if(running)throw Error("BACKUP_BUSY");
    if(!host.supported())throw Error("BACKUP_UNAVAILABLE");
    assertRelaunchPossible();
    running=true;let release,intent,manual;
    try{
      const current=coordinator.status();
      if(current.revision!==expectedRevision)throw Error("BACKUP_SCHEDULE_CHANGED");
      const b=await read();
      if(!b||!b.allowIdleRestart||current.schedule.installationRef!==b.installationRef||current.schedule.destinationRef!==b.destinationRef||current.schedule.recoveryRef!==b.recoveryRef)throw Error("BACKUP_SCHEDULE_CONSENT_REQUIRED");
      try{await checked();}catch(error){
        // Recorded like a failed backup (review, Inbox, notification), and
        // the window gets the same plain reason.
        if(["BACKUP_FOLDER_MISSING","BACKUP_RECOVERY_KEY_MISSING"].includes(error?.message)){lastError=error.message;try{const r=coordinator.requestManual(expectedRevision,randomUUID());stopForReferences(r.job?.id,error);}catch{/* the sentence below still names it */}}
        throw error;
      }
      const s=coordinator.requestManual(expectedRevision,randomUUID());
      if(s.job.occurrence.startsWith(s.revision+":manual:"))manual=s.job.id;
      try{release=await host.prepare("manual");}catch(error){holdFor(error,"manual");throw error;}
      if(heldBy?.occasion==="manual")heldBy=null;
      if(!host.supported())throw Error("BACKUP_UNAVAILABLE");
      intent={version:1,id:randomUUID(),bindingRevision:hash(b),installationIdentity:b.installationIdentity,expiresAt:now()+30*60000};
      coordinator.prepareHandoff(s.job.id,intent);
      stopPolling();await host.cleanupIdle();coordinator.armHandoff(intent.id);
      await host.relaunch("backup");lastError=null;
    }catch(error){
      if(intent){lastError="BACKUP_HANDOFF_DEFERRED";try{coordinator.failHandoff(intent.id);}catch{/* Preserve authoritative state. */}}
      else if(manual)try{coordinator.cancelManual(manual);}catch{/* A changed job is left for review. */}
      if(release)try{await release();}catch{lastError="BACKUP_RELEASE_UNCONFIRMED";}
      throw error;
    }finally{running=false;}
    return publicStatus();
  }
  // The backup-mode capture under way, so a run past its ceiling can be
  // recorded as failed while the capture itself is still stuck (abandonOffline).
  let offline=null,offlineGivenUp=false;
  async function captureArmed(closed=false){
    const s=coordinator.status(),intent=s.job?.handoff;let claimed=false,captureStage="precondition";
    const run={stage:"precondition",abandoned:false};if(!closed)offline=run;
    try{
      if(!intent||s.phase!=="handoff-armed")throw Error("BACKUP_HANDOFF_REJECTED");
      const note=line=>{try{host.reportOutcome?.(line);}catch{/* Logging never changes the backup. */}};
      const stage=name=>{run.stage=name;try{host.reportProgress?.(name);}catch{/* A progress screen never changes the backup. */}};
      note(`backup started ${JSON.stringify({job:String(s.job?.id??"").slice(0,8),closed})}`);
      stage("references");captureStage="references";const b=await checked();if(!host.supported())throw Error("BACKUP_UNAVAILABLE");
      captureStage="claim";coordinator.claimHandoff(intent.id,hash(b),installationIdentity(host.installation()));
      claimed=true;
      const output=path.join(b.destination,s.job.id+".age");
      const readIdentity=async()=>{await checked();await verifyIdentityAccess();const key=readBackupIdentity(b.keyFile,host.installation());if(key.recipient!==b.recipient)throw Error("BACKUP_REFERENCE_CHANGED");return key.identity;};
      coordinator.beginHandoffCapture(intent.id);
      stage("capture");captureStage="capture";const result=await host.capture({output,recipient:b.recipient,readIdentity,maxBytes:s.schedule.maxBytes,maxDurationMs:s.schedule.maxDurationMs});
      stage("artifact-readback");captureStage="artifact-readback";
      // The worker reports the archive in its canonical spelling, which on
      // Windows is lower case; the file checked below is always our own path.
      if(result?.ok!==true||result.operation!=="backup-encrypted"||!samePath(result.path,output)||result.coverage?.fullInstallation!==false||result.coverage?.scope!=="application-data")throw Error("BACKUP_RECEIPT_MISMATCH");
      const {sha256,bytes}=verifiedArtifact(output,s.schedule.maxBytes);
      note(`backup local written ${JSON.stringify({job:s.job.id.slice(0,8),bytes})}`);
      if(sha256!==result.sha256)throw Error("BACKUP_RECEIPT_MISMATCH");
      note(`backup local verified ${JSON.stringify({job:s.job.id.slice(0,8),bytes,how:"file re-read and its sha256 matched the encrypting worker's"})}`);
      {let line=null;try{line=skippedOutcomeLine(s.job.id.slice(0,8),result.skipped);}catch{/* Logging never changes the backup. */}if(line)note(line);}
      // Given up at the ceiling while the worker finished: the timeout stands.
      if(run.abandoned)throw Error("BACKUP_HANDOFF_REJECTED");
      captureStage="receipt-commit";coordinator.clearCaptureFailure?.();coordinator.recordSkipped?.(s.job.id,result.skipped);coordinator.completeHandoff(intent.id,{jobId:s.job.id,installationRef:b.installationRef,destinationRef:b.destinationRef,selectionHash:hash(s.schedule.selection),snapshotId:result.snapshotId,artifactRef:s.job.id,sha256,bytes,verifiedAt:now(),...(intent.upgrade?{candidateId:intent.upgrade.candidateId}:{})});
      // Durable receipt precedes relaunch. A failed return never recaptures.
      stage("return");captureStage="return";if(closed)coordinator.completeReturn(intent.id);
      else await host.relaunch("normal");
      return {verified:true};
    }catch(error){
      const diagnostic=captureFailureDiagnostic(captureStage,error);
      // The log alone also gets the redacted cause behind the code; the
      // durable record below (and so the window) keeps only stage and code.
      let cause=null;try{cause=normalizeCaptureCause(error?.captureCause);}catch{/* Diagnostic properties are not trusted. */}
      // A run already given up at its ceiling keeps that reason: what the
      // stuck capture throws once the workspace closes is only the shutdown.
      if(!run.abandoned){
        try{host.reportOutcome?.(`backup local failed ${JSON.stringify({stage:diagnostic.stage,code:diagnostic.code})}`);}catch{/* Logging never changes the result. */}
        try{host.reportCaptureFailure?.(cause?{...diagnostic,cause}:diagnostic);}catch{/* Diagnostic failure never changes the handoff result. */}
        // Durable, so the reason survives the return to the workspace and the
        // Backups page can say what happened instead of only that it failed.
        try{coordinator.recordCaptureFailure?.(diagnostic);}catch{/* A note is never worth losing the authoritative state over. */}
      }
      if(intent&&coordinator.status().phase!=="return-pending"&&(claimed||(s.phase==="handoff-armed"&&coordinator.status().phase==="handoff-armed")))try{coordinator.failHandoff(intent.id);}catch{/* Preserve evidence. */}
      lastError="BACKUP_SCHEDULE_REVIEW_REQUIRED";
      // Only the SUCCESS path used to reopen the workspace, so a failed
      // backup left the person stranded on the Backup mode page with no way
      // back but a button they had no reason to trust. The durable state is
      // already written above, so reopening now changes nothing except where
      // they are standing. A closed-app run has no window to return to.
      if(!closed)try{await host.relaunch("normal");}catch{/* Falling back to the Backup mode page is better than no window at all. */}
      throw Error(lastError);
    }
  }
  async function resumeOffline(){
    if(running)throw Error("BACKUP_BUSY");
    // Given up before it started (a tool check that never settled): never start it after all.
    if(offlineGivenUp)throw Error("BACKUP_SCHEDULE_REVIEW_REQUIRED");
    running=true;
    try{return await captureArmed();}finally{running=false;}
  }
  /** 1.0.7 RC6: the backup-mode run passed its ceiling (backup-offline-return.mjs).
   * Record it as a failed backup that took too long, so the reopened workspace
   * says so and the next start does not arm the same backup again. A receipt
   * already written (return-pending) is a finished backup and is left alone.
   * Throws when the job could not be marked for review. */
  function abandonOffline(){
    const s=coordinator.status(),intent=s.job?.handoff;
    if(!intent||["return-pending","returned","needs-review"].includes(s.phase))return false;
    const stage=offline?.stage??"precondition";offlineGivenUp=true;if(offline)offline.abandoned=true;
    try{host.reportOutcome?.(`backup local failed ${JSON.stringify({stage,code:"RECOVERY_WORKER_TIMEOUT",ceiling:true})}`);}catch{/* Logging never changes the result. */}
    try{coordinator.recordCaptureFailure?.({stage,code:"RECOVERY_WORKER_TIMEOUT"});}catch{/* The phase below still stops a re-run. */}
    // Thrown when the job could not be set aside: reopening would arm the
    // same backup again, so the caller shows the Backup mode page instead.
    coordinator.failHandoff(intent.id);
    lastError="BACKUP_SCHEDULE_REVIEW_REQUIRED";return true;
  }
  const closedResult=(status,reason)=>{
    try{return coordinator.recordClosedResult({status,...(reason?{reason}:{})});}
    catch{return {status:"unavailable",reason:"state-unavailable"};}
  };
  async function runClosedDue(){
    if(running)return closedResult("busy");
    running=true;let intent,stage="state";
    try{
      let eligibility=coordinator.closedEligibility();
      if(eligibility.status!=="due")return closedResult(eligibility.status,eligibility.status==="needs-review"?"pending-work":undefined);
      // This private main-owned hook must prove the existing installation lease,
      // exact profile/registration, and that normal startup never began.
      stage="owner";host.traceClosed?.(stage);if(typeof host.assertClosedStartup!=="function")throw Error("BACKUP_CLOSED_OWNER_UNAVAILABLE");
      await host.assertClosedStartup();
      stage="capability";host.traceClosed?.(stage);await assertClosedAllowed();
      stage="references";host.traceClosed?.(stage);const b=await checked();
      if(b.allowClosedApp!==true)throw Error("BACKUP_CLOSED_CONSENT_REQUIRED");
      eligibility=coordinator.closedEligibility();
      if(eligibility.status!=="due")return closedResult(eligibility.status,eligibility.status==="needs-review"?"pending-work":undefined);
      stage="state";host.traceClosed?.(stage);const s=await coordinator.tick();
      if(!s.enabled||s.schedule.closedApp!==true)return closedResult("disabled");
      if(!["due","waiting-idle","waiting-backup-mode"].includes(s.phase))return closedResult("needs-review","pending-work");
      intent={version:1,id:randomUUID(),bindingRevision:hash(b),installationIdentity:b.installationIdentity,expiresAt:now()+30*60000};
      coordinator.prepareHandoff(s.job.id,intent);coordinator.armHandoff(intent.id);
      stage="capture";host.traceClosed?.(stage);await captureArmed(true);
      lastError=null;return closedResult("verified");
    }catch(error){
      if(intent){
        try{
          const phase=coordinator.status().phase;
          if(!["return-pending","returned","needs-review"].includes(phase))coordinator.failHandoff(intent.id);
        }catch{/* Preserve authoritative evidence. */}
      }
      const reason={owner:"owner-unavailable",capability:"capability-unavailable",references:"references-unavailable",state:"state-unavailable",capture:"capture-unconfirmed"}[stage];
      return closedResult(stage==="owner"&&error?.code==="BACKUP_CLOSED_BUSY"?"busy":stage==="capture"?"needs-review":"unavailable",reason);
    }finally{running=false;}
  }
  async function currentArtifact(){
      const receipt=coordinator.status().lastVerified;if(!receipt)return null;
      const binding=await read();
      if(!binding||binding.installationIdentity!==installationIdentity(host.installation())||receipt.installationRef!==binding.installationRef||receipt.destinationRef!==binding.destinationRef||!/^[a-f0-9]{64}$/.test(receipt.jobId)||receipt.artifactRef!==receipt.jobId||installationIdentity(binding.destination)!==binding.destinationIdentity||realpathSync(binding.destination)!==binding.destination)throw Error("BACKUP_REFERENCE_CHANGED");
      const archivePath=path.join(binding.destination,receipt.jobId+".age");
      const actual=verifiedArtifact(archivePath,receipt.bytes);
      if(actual.sha256!==receipt.sha256||actual.bytes!==receipt.bytes)throw Error("BACKUP_RECEIPT_MISMATCH");
      return{archivePath,receipt};
  }
  return {
    status:publicStatus,internalStatus:()=>coordinator.status(),isPreparing:()=>running,start,stopPolling,tick,runNow,clearReview,resumeOffline,abandonOffline,runClosedDue,requestUpgrade,pendingUpgrade,verifyUpgrade,
    /** Folder the saved references back up into, for recovery-key placement checks. */
    async selectedDestination(){const b=await read();return b?b.destination:null;},
    /** The recovery key file the saved references read, or null. */
    async boundKeyFile(){const b=await read();return b?b.keyFile:null;},
    /** Points the saved references at a verified copy of the SAME recovery key
     * (a 0.1.60 key moved off a folder that syncs to the cloud). Nothing else
     * in them changes; a file that holds another key is refused. */
    async rebindKeyFile(file){
      if(running||activePhases.has(coordinator.status().phase))throw Error("BACKUP_BUSY");
      running=true;try{
        const b=await read();if(!b)throw Error("BACKUP_BINDINGS_UNAVAILABLE");
        if(typeof file!=="string"||!path.isAbsolute(file))throw Error("BACKUP_REFERENCE_CHANGED");
        const key=readBackupIdentity(file,realpathSync.native(host.installation()));
        if(!key.recipient||key.recipient!==b.recipient)throw Error("BACKUP_REFERENCE_CHANGED");
        const resolved=realpathSync(file);
        await host.writeProtected(BACKUP_SCHEDULE_BINDINGS_KEY,JSON.stringify({...b,keyFile:resolved,keyFingerprint:hash(fingerprint(resolved))}));
      }finally{running=false;}
    },
    /** The backup folder's own name (never its path), for the Inbox sentence. */
    async destinationLabel(){const b=await read();return b?path.basename(b.destination):null;},
    async latestVerifiedArtifact(){
      if(running||activePhases.has(coordinator.status().phase))throw Error("BACKUP_BUSY");
      return currentArtifact();
    },
    /** The person's request to end the first run's backup step. "verified"
     * is honoured only when the current receipt matches the folder and key in
     * use AND its archive re-reads to the same hash; it refreshes an earlier
     * check made for another folder or key. "off" turns the schedule off and
     * is recorded in the coordinator too (its revision moves), so losing the
     * first-run record never makes this folder look new. A step already
     * verified now stays verified. An unreadable record is replaced: the
     * person's explicit choice is the way out of it. */
    async finishFirstRun(choice){
      if(choice!=="verified"&&choice!=="off")throw Error("INVALID_BACKUP_REQUEST");
      if(running||activePhases.has(coordinator.status().phase))throw Error("BACKUP_BUSY");
      running=true;try{
        const record=firstRunRecord(),state=await firstRunState();
        if(choice==="verified"){
          const s=coordinator.status(),b=await read();
          if(!s.enabled||!receiptCurrent(s,b))throw Error("BACKUP_FIRST_RUN_UNVERIFIED");
          const artifact=await currentArtifact();if(!artifact)throw Error("BACKUP_FIRST_RUN_UNVERIFIED");
          const r=artifact.receipt;
          if(state.completed!=="off"){
            const same=record?.state==="verified"&&record.jobId===r.jobId&&record.sha256===r.sha256&&record.installationRef===b.installationRef&&record.destinationRef===b.destinationRef&&record.recoveryRef===b.recoveryRef;
            if(!same)coordinator.recordFirstRun({state:"verified",jobId:r.jobId,sha256:r.sha256,installationRef:b.installationRef,destinationRef:b.destinationRef,recoveryRef:b.recoveryRef},{replace:true});
          }
        }else if(state.completed!=="verified"){
          const s=coordinator.status();
          if(s.enabled||s.revision===0){coordinator.configure(s.revision,{...s.schedule,enabled:false});stopPolling();}
          if(record?.state!=="off")coordinator.recordFirstRun({state:"off"},{replace:true});
        }
      }finally{running=false;}
      await firstRunChanged();
      return publicStatus();
    },
    async markUpgradeInstallRequested(candidate){const v=await verifyUpgrade(candidate);coordinator.requestUpgradeInstall(v.handoffId,v.candidate,v.bindingRevision,v.installationIdentity);return {status:"continue"};},
    async completeUpgrade(currentVersion){const p=pendingUpgrade();if(!p)throw Error("BACKUP_UPGRADE_REJECTED");const v=await verifyUpgrade(p.candidate);coordinator.completeUpgrade(v.handoffId,currentVersion,v.candidate,v.bindingRevision,v.installationIdentity);},
    returnUpgradeToWorkspace(){const p=pendingUpgrade();if(!p)throw Error("BACKUP_UPGRADE_REJECTED");coordinator.cancelUpgrade(p.handoffId);},
    completeReturn(){const s=coordinator.status();if(s.phase==="return-pending"&&s.job?.handoff)coordinator.completeReturn(s.job.handoff.id);},
    /** One act of setup. Before this, turning on backups cost four native
     * dialogs — create the key, choose the folder, choose the key file the app
     * had just written, confirm — and the person then had to find a separate
     * switch. The app already knew everything after the folder was chosen, so
     * it now creates the key itself and asks once.
     *
     * Every check selectReferences makes is made here, in the same order:
     * the destination is refused inside the installation on natively resolved
     * paths, verifyIdentityAccess() runs before anything is bound, the key's
     * recipient header is required, and the binding is still written with
     * allowIdleRestart false so configure() alone can turn the schedule on.
     * `existingKey` keeps the old key picker for people who already have an
     * age key; it is not on the ordinary road. */
    async setUpBackups(options){
      if(running||coordinator.status().enabled||activePhases.has(coordinator.status().phase))throw Error("BACKUP_BUSY");
      if(!host.supported())throw Error("BACKUP_UNAVAILABLE");
      // Every backup restarts Murage. Where that cannot work, refuse before a
      // folder is chosen or a key is written, not after daily backups are on.
      assertRelaunchPossible();
      const existingKey=options?.existingKey===true;
      // First run uses the app's default backup folder: no folder picker and
      // no confirmation dialog, because nobody has been asked anything yet and
      // the first screen already explains backups and keeps the recovery key
      // warning. Anything after this point is the same checked path.
      const firstRun=options?.firstRun===true&&!existingKey;
      if(firstRun&&typeof host.defaultDestination!=="function")throw Error("BACKUP_UNAVAILABLE");
      if(!existingKey&&typeof host.createRecoveryKey!=="function")throw Error("BACKUP_UNAVAILABLE");
      let setUpNote=null;
      running=true;try{
      // The flag alone never skips the confirmation: only a data folder that
      // has never had backups may (Settings L5). Anything else is refused
      // before a folder is made or a key is written.
      if(firstRun&&!(await firstRunState()).eligible)throw Error("BACKUP_FIRST_RUN_DONE");
      const destination=firstRun?await host.defaultDestination():await host.chooseDestination();if(!destination)return {cancelled:true};
      if(firstRun)mkdirSync(destination,{recursive:true,mode:0o700});
      const installation=realpathSync.native(host.installation()),target=realpathSync.native(destination);
      if(pathWithin(installation,target)||!lstatSync(target).isDirectory())throw Error("BACKUP_DESTINATION_INVALID");
      // A folder the backup can't use is refused now, before any key is made
      // or Murage restarts for a first backup that would fail (audit W-A2).
      {const refusal=host.backupFolderRefusal?.(target);if(refusal)throw Error(refusal);}
      await verifyIdentityAccess();
      if(!samePath(installation,realpathSync.native(host.installation())))throw Error("BACKUP_REFERENCE_CHANGED");
      const bound=realpathSync(host.installation());
      let keyFile,created=null;
      if(existingKey){keyFile=await host.chooseKey();if(!keyFile)return {cancelled:true};}
      else{
        // The key is written by the host, outside the installation and outside
        // the backup folder; createRecoveryKeyIn enforces both.
        created=await host.createRecoveryKey(target);
        if(typeof created?.file!=="string")throw Error("BACKUP_RECOVERY_KEY_UNVERIFIED");
        keyFile=created.file;
      }
      // A key made for this setup opens nothing until the binding below is
      // written. If the setup stops first, take it back (host.discardRecoveryKey
      // removes only that exact, unchanged file) so a retry does not leave
      // murage-recovery-key.txt, -2, -3 beside each other; if it cannot be
      // removed, say where it was left.
      const takeBack=()=>{if(!created)return null;let gone=false;try{gone=host.discardRecoveryKey?.(created.file)===true;}catch{gone=false;}return gone?null:{label:path.basename(created.file),publicKey:created.publicKey,folder:path.basename(path.dirname(created.file))};};
      let settled=false;
      try{
      const key=readBackupIdentity(keyFile,installation);if(!key.recipient)throw Error("BACKUP_IDENTITY_HEADER_REQUIRED");
      // The one confirmation. It names the folder, the key and where the key
      // was put, and it is where the person consents to Murage closing and
      // reopening its own window for a backup.
      const resolvedKey=realpathSync(keyFile);
      const keyNote=created?{label:path.basename(resolvedKey),publicKey:created.publicKey,folder:path.basename(path.dirname(resolvedKey))}:null;
      if(!firstRun&&!await host.confirmReferences({destination:path.basename(target),recoveryKey:path.basename(resolvedKey),recoveryKeyFolder:path.dirname(resolvedKey),createdKey:Boolean(created)})){const left=takeBack();settled=true;return {cancelled:true,...(left?{created:left}:{})};}
      const b={version:1,installationIdentity:installationIdentity(bound),installationRef:"installation-"+hash(bound).slice(0,24),destinationRef:randomUUID(),recoveryRef:randomUUID(),destination:target,destinationIdentity:installationIdentity(target),keyFile:resolvedKey,keyFingerprint:hash(fingerprint(keyFile)),recipient:key.recipient,allowIdleRestart:false,allowClosedApp:false};
      await host.writeProtected(BACKUP_SCHEDULE_BINDINGS_KEY,JSON.stringify(b));
      settled=true;
      setUpNote=keyNote;
      }finally{if(!settled)takeBack();}
      }finally{running=false;}
      // Read only after the setup's own "preparing" flag is released: status
      // read inside it said pending:true, and the page refuses to switch on a
      // schedule that is pending, so "Back up every day" left daily backups off.
      const status=await publicStatus();
      return setUpNote?{...status,created:setUpNote}:status;
    },
    async selectReferences(){
      if(running||coordinator.status().enabled||activePhases.has(coordinator.status().phase))throw Error("BACKUP_BUSY");
      if(!host.supported())throw Error("BACKUP_UNAVAILABLE");
      assertRelaunchPossible();
      running=true;try{
      const destination=await host.chooseDestination();if(!destination)return {cancelled:true};
      const keyFile=await host.chooseKey();if(!keyFile)return {cancelled:true};
      // A destination inside the installation makes the backup consume itself.
      // Resolve natively so a differently cased or 8.3-aliased pick cannot
      // read as outside; the plain realpath keeps the spelling it was given.
      const installation=realpathSync.native(host.installation()),target=realpathSync.native(destination);
      if(pathWithin(installation,target)||!lstatSync(target).isDirectory())throw Error("BACKUP_DESTINATION_INVALID");
      {const refusal=host.backupFolderRefusal?.(target);if(refusal)throw Error(refusal);}
      await verifyIdentityAccess();
      // Recheck with the resolver that produced `installation`: the plain one
      // keeps Windows' lowercased spelling and never matches the native one.
      if(!samePath(installation,realpathSync.native(host.installation())))throw Error("BACKUP_REFERENCE_CHANGED");
      // Bind the installation in the spelling every later check recomputes
      // (installationIdentity(host.installation())) and earlier releases
      // stored, so their bindings and remote reference stay valid.
      const bound=realpathSync(host.installation());
      const key=readBackupIdentity(keyFile,installation);if(!key.recipient)throw Error("BACKUP_IDENTITY_HEADER_REQUIRED");
      if(!await host.confirmReferences())return {cancelled:true};
      const b={version:1,installationIdentity:installationIdentity(bound),installationRef:"installation-"+hash(bound).slice(0,24),destinationRef:randomUUID(),recoveryRef:randomUUID(),destination:target,destinationIdentity:installationIdentity(target),keyFile:realpathSync(keyFile),keyFingerprint:hash(fingerprint(keyFile)),recipient:key.recipient,allowIdleRestart:false,allowClosedApp:false};
      await host.writeProtected(BACKUP_SCHEDULE_BINDINGS_KEY,JSON.stringify(b));
      }finally{running=false;}
      // As in setUpBackups: a status read while still preparing reports pending:true.
      return publicStatus();
    },
    async configure(expectedRevision,input){
      if(running)throw Error("BACKUP_BUSY");if(!input||typeof input!=="object"||Array.isArray(input))throw Error("INVALID_BACKUP_SCHEDULE");
      running=true;try{
      const {allowIdleRestart,allowClosedApp,...schedule}=input;
      // Turning daily backups on where no backup can run would read as
      // protection that never happens. Turning them off is always allowed.
      if(schedule.enabled)assertRelaunchPossible();
      if(schedule.enabled&&schedule.preUpgrade)await assertUpgradeAllowed();
      if(schedule.enabled&&schedule.closedApp===true){await assertClosedAllowed();if(allowClosedApp!==true)throw Error("BACKUP_CLOSED_CONSENT_REQUIRED");}
      if(schedule.enabled){const b=await read();if(!b||allowIdleRestart!==true||schedule.installationRef!==b.installationRef||schedule.destinationRef!==b.destinationRef||schedule.recoveryRef!==b.recoveryRef)throw Error("BACKUP_SCHEDULE_CONSENT_REQUIRED");await host.writeProtected(BACKUP_SCHEDULE_BINDINGS_KEY,JSON.stringify({...b,allowIdleRestart:true,allowClosedApp:schedule.closedApp===true}));}
      const wasEnabled=coordinator.status().enabled;
      coordinator.configure(expectedRevision,schedule);
      // Turning daily backups off is the person's own choice: it also ends a
      // first run that has no recorded ending yet, as "backups off".
      if(wasEnabled&&!schedule.enabled&&!firstRunRecord()){try{coordinator.recordFirstRun?.({state:"off"});}catch{/* the harness re-derives from the schedule */}}
      void firstRunChanged();
      }finally{running=false;}
      start();return publicStatus();
    },
  };
}
