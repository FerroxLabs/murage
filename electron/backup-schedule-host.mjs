import { normalizeBackupAgeDiagnostic } from "./backup-age-attestation.mjs";
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { readBackupIdentity } from "./backup-mode.mjs";
import { parseUpdateCandidate, canonicalUpdateDescriptor } from "../shared/update-candidate.mjs";

export const BACKUP_SCHEDULE_BINDINGS_KEY = "backupScheduleBindings";
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

const captureFailureStages=new Set(["precondition","references","claim","capture","artifact-readback","receipt-commit","return"]);
const captureFailureCodes=new Set([
  "BACKUP_HANDOFF_REJECTED","BACKUP_UNAVAILABLE","BACKUP_REFERENCE_CHANGED","BACKUP_BINDINGS_INVALID","BACKUP_BINDINGS_UNAVAILABLE","BACKUP_RECEIPT_MISMATCH",
  "RECOVERY_WORKER_TIMEOUT","INVALID_RECOVERY_INPUT","INVALID_RECOVERY_RESULT","RECOVERY_INPUT_TIMEOUT","RECOVERY_OPERATION_FAILED","RECOVERY_OWNERSHIP_REQUIRED","INVALID_BACKUP_BUDGET",
  "BACKUP_LIMIT_EXCEEDED","ARCHIVE_LIMIT_EXCEEDED","INVALID_BACKUP_LIMITS","INVALID_ARCHIVE_LIMITS","SNAPSHOT_CANCELLED","AGE_TOOL_TIMEOUT","AGE_PROCESS_FAILED","AGE_PROCESS_CLOSE_UNCONFIRMED","AGE_TOOL_UNVERIFIED",
  "ENCRYPTED_BACKUP_FAILED","FIDELITY_READBACK_MISMATCH","FIDELITY_RECOVERY_MISMATCH","INVALID_FIDELITY_MANIFEST","ARCHIVE_CHANGED","UNSAFE_ARCHIVE_FILE","INVALID_DESTINATION","DESTINATION_EXISTS","DESTINATION_INSIDE_INSTALLATION",
]);
const ownedCaptureWaits=new Map([
  ["Desktop startup has not settled","OWNED_STARTUP_UNSETTLED"],["Owned writers have not exited","OWNED_WRITERS_UNSETTLED"],
  ["Credential writes have not settled","OWNED_CREDENTIALS_UNSETTLED"],["Companion startup has not settled","OWNED_COMPANION_START_UNSETTLED"],
  ["Companion has not stopped","OWNED_COMPANION_STOP_UNSETTLED"],["Browser cleanup has not settled","OWNED_BROWSER_CLEANUP_UNSETTLED"],
  ["Browser host has not stopped","OWNED_BROWSER_STOP_UNSETTLED"],["Computer-use startup has not settled","OWNED_CUA_START_UNSETTLED"],
  ["Computer-use cleanup has not completed","OWNED_CUA_STOP_UNSETTLED"],
].map(([label,code])=>[label+"; Murage kept installation ownership. Wait and retry Quit.",code]));
/** Local diagnostic only: never retain arbitrary error fields, messages or paths. */
export function captureFailureDiagnostic(stage,error){
  const candidate=captureFailureCodes.has(error?.code)?error.code:captureFailureCodes.has(error?.message)?error.message:null;
  let backupAgeAttestation=null;try{if(candidate==="AGE_TOOL_UNVERIFIED")backupAgeAttestation=normalizeBackupAgeDiagnostic(error?.backupAgeAttestation);}catch{/* Diagnostic properties are not trusted. */}
  return{stage:captureFailureStages.has(stage)?stage:"unknown",code:candidate??ownedCaptureWaits.get(error?.message)??"UNKNOWN_CAPTURE_FAILURE",...(backupAgeAttestation?{backupAgeAttestation}:{})};
}

/** Existing coordinator and native ownership/worker are injected, never duplicated. */
export function createBackupScheduleHost(host) {
  const coordinator=host.coordinator;
  let running=false,timer=null,lastError=null,upgradeRequest=null,upgradeCandidateId=null;
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
  const checked=async()=>{
    const b=await read(),s=coordinator.status();
    if(!b||!b.allowIdleRestart||b.installationIdentity!==installationIdentity(host.installation())||s.schedule.installationRef!==b.installationRef||s.schedule.destinationRef!==b.destinationRef||s.schedule.recoveryRef!==b.recoveryRef||hash(fingerprint(b.keyFile))!==b.keyFingerprint||!lstatSync(b.destination).isDirectory()||realpathSync(b.destination)!==b.destination||installationIdentity(b.destination)!==b.destinationIdentity)throw Error("BACKUP_REFERENCE_CHANGED");
    return b;
  };
  const publicStatus=async()=>{
    const s=coordinator.status();let refs;try{const b=await read();if(b)refs={installationRef:b.installationRef,destinationRef:b.destinationRef,recoveryRef:b.recoveryRef,destinationLabel:path.basename(b.destination),recoveryLabel:path.basename(b.keyFile)};}catch{lastError="BACKUP_BINDINGS_UNAVAILABLE";}
    let preUpgradeSupported=false;try{await assertUpgradeAllowed();preUpgradeSupported=true;}catch{/* Static capability refusal is not a schedule failure. */}
    let closedAppSupported=false;try{await assertClosedAllowed();closedAppSupported=true;}catch{/* Static capability refusal is not a schedule failure. */}
    return {supported:host.supported(),preUpgradeSupported,closedAppSupported,pending:running,enabled:s.enabled,revision:s.revision,phase:s.phase,schedule:s.schedule,lastVerified:s.lastVerified,lastClosedResult:s.lastClosedResult,refs,error:lastError};
  };
  const stopPolling=()=>{if(timer)clearInterval(timer);timer=null;};
  const start=()=>{stopPolling();if(!coordinator.status().enabled)return;timer=setInterval(()=>{void tick();},60000);timer.unref?.();void tick();};
  const assertUpgradeAllowed=async candidate=>{if(!host.supported()||typeof host.assertUpgradeAllowed!=="function")throw Error("BACKUP_PREUPGRADE_UNAVAILABLE");await host.assertUpgradeAllowed(candidate);};
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
        await assertUpgradeAllowed(candidate);const b=await checked();
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
  async function tick(upgradeId){
    if(running)return;
    if(!coordinator.status().enabled)return;
    running=true;let release,intent;
    try{
      const s=await coordinator.tick(upgradeId);
      if(!["due","waiting-idle","waiting-backup-mode"].includes(s.phase)||!host.supported())return;
      const b=await checked();
      release=await host.prepare();
      intent={version:1,id:randomUUID(),bindingRevision:hash(b),installationIdentity:b.installationIdentity,expiresAt:now()+30*60000};
      coordinator.prepareHandoff(s.job.id,intent);
      stopPolling();await host.cleanupIdle();coordinator.armHandoff(intent.id);
      await host.relaunch("backup");lastError=null;
    }catch{
      lastError="BACKUP_HANDOFF_DEFERRED";
      if(intent)try{coordinator.failHandoff(intent.id);}catch{/* Preserve unreadable state. */}
      if(release)try{await release();}catch{lastError="BACKUP_RELEASE_UNCONFIRMED";}
    }finally{running=false;}
  }
  async function captureArmed(closed=false){
    const s=coordinator.status(),intent=s.job?.handoff;let claimed=false,captureStage="precondition";
    try{
      if(!intent||s.phase!=="handoff-armed")throw Error("BACKUP_HANDOFF_REJECTED");
      captureStage="references";const b=await checked();if(!host.supported())throw Error("BACKUP_UNAVAILABLE");
      captureStage="claim";coordinator.claimHandoff(intent.id,hash(b),installationIdentity(host.installation()));
      claimed=true;
      const output=path.join(b.destination,s.job.id+".age");
      const readIdentity=async()=>{await checked();await verifyIdentityAccess();const key=readBackupIdentity(b.keyFile,host.installation());if(key.recipient!==b.recipient)throw Error("BACKUP_REFERENCE_CHANGED");return key.identity;};
      coordinator.beginHandoffCapture(intent.id);
      captureStage="capture";const result=await host.capture({output,recipient:b.recipient,readIdentity,maxBytes:s.schedule.maxBytes,maxDurationMs:s.schedule.maxDurationMs});
      captureStage="artifact-readback";
      if(result?.ok!==true||result.operation!=="backup-encrypted"||result.path!==output||result.coverage?.fullInstallation!==false||result.coverage?.scope!=="application-data")throw Error("BACKUP_RECEIPT_MISMATCH");
      const {sha256,bytes}=verifiedArtifact(output,s.schedule.maxBytes);
      if(sha256!==result.sha256)throw Error("BACKUP_RECEIPT_MISMATCH");
      captureStage="receipt-commit";coordinator.completeHandoff(intent.id,{jobId:s.job.id,installationRef:b.installationRef,destinationRef:b.destinationRef,selectionHash:hash(s.schedule.selection),snapshotId:result.snapshotId,artifactRef:s.job.id,sha256,bytes,verifiedAt:now(),...(intent.upgrade?{candidateId:intent.upgrade.candidateId}:{})});
      // Durable receipt precedes relaunch. A failed return never recaptures.
      captureStage="return";if(closed)coordinator.completeReturn(intent.id);
      else await host.relaunch("normal");
      return {verified:true};
    }catch(error){
      try{host.reportCaptureFailure?.(captureFailureDiagnostic(captureStage,error));}catch{/* Diagnostic failure never changes the handoff result. */}
      if(intent&&coordinator.status().phase!=="return-pending"&&(claimed||(s.phase==="handoff-armed"&&coordinator.status().phase==="handoff-armed")))try{coordinator.failHandoff(intent.id);}catch{/* Preserve evidence. */}
      lastError="BACKUP_SCHEDULE_REVIEW_REQUIRED";throw Error(lastError);
    }
  }
  async function resumeOffline(){
    if(running)throw Error("BACKUP_BUSY");running=true;
    try{return await captureArmed();}finally{running=false;}
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
      stage="owner";if(typeof host.assertClosedStartup!=="function")throw Error("BACKUP_CLOSED_OWNER_UNAVAILABLE");
      await host.assertClosedStartup();
      stage="capability";await assertClosedAllowed();
      stage="references";const b=await checked();
      if(b.allowClosedApp!==true)throw Error("BACKUP_CLOSED_CONSENT_REQUIRED");
      eligibility=coordinator.closedEligibility();
      if(eligibility.status!=="due")return closedResult(eligibility.status,eligibility.status==="needs-review"?"pending-work":undefined);
      stage="state";const s=await coordinator.tick();
      if(!s.enabled||s.schedule.closedApp!==true)return closedResult("disabled");
      if(!["due","waiting-idle","waiting-backup-mode"].includes(s.phase))return closedResult("needs-review","pending-work");
      intent={version:1,id:randomUUID(),bindingRevision:hash(b),installationIdentity:b.installationIdentity,expiresAt:now()+30*60000};
      coordinator.prepareHandoff(s.job.id,intent);coordinator.armHandoff(intent.id);
      stage="capture";await captureArmed(true);
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
  return {
    status:publicStatus,internalStatus:()=>coordinator.status(),isPreparing:()=>running,start,stopPolling,tick,resumeOffline,runClosedDue,requestUpgrade,pendingUpgrade,verifyUpgrade,
    async latestVerifiedArtifact(){
      if(running||activePhases.has(coordinator.status().phase))throw Error("BACKUP_BUSY");
      const receipt=coordinator.status().lastVerified;if(!receipt)return null;
      const binding=await read();
      if(!binding||binding.installationIdentity!==installationIdentity(host.installation())||receipt.installationRef!==binding.installationRef||receipt.destinationRef!==binding.destinationRef||!/^[a-f0-9]{64}$/.test(receipt.jobId)||receipt.artifactRef!==receipt.jobId||installationIdentity(binding.destination)!==binding.destinationIdentity||realpathSync(binding.destination)!==binding.destination)throw Error("BACKUP_REFERENCE_CHANGED");
      const archivePath=path.join(binding.destination,receipt.jobId+".age");
      const actual=verifiedArtifact(archivePath,receipt.bytes);
      if(actual.sha256!==receipt.sha256||actual.bytes!==receipt.bytes)throw Error("BACKUP_RECEIPT_MISMATCH");
      return{archivePath,receipt};
    },
    async markUpgradeInstallRequested(candidate){const v=await verifyUpgrade(candidate);coordinator.requestUpgradeInstall(v.handoffId,v.candidate,v.bindingRevision,v.installationIdentity);return {status:"continue"};},
    async completeUpgrade(currentVersion){const p=pendingUpgrade();if(!p)throw Error("BACKUP_UPGRADE_REJECTED");const v=await verifyUpgrade(p.candidate);coordinator.completeUpgrade(v.handoffId,currentVersion,v.candidate,v.bindingRevision,v.installationIdentity);},
    returnUpgradeToWorkspace(){const p=pendingUpgrade();if(!p)throw Error("BACKUP_UPGRADE_REJECTED");coordinator.cancelUpgrade(p.handoffId);},
    completeReturn(){const s=coordinator.status();if(s.phase==="return-pending"&&s.job?.handoff)coordinator.completeReturn(s.job.handoff.id);},
    async selectReferences(){
      if(running||coordinator.status().enabled||activePhases.has(coordinator.status().phase))throw Error("BACKUP_BUSY");
      if(!host.supported())throw Error("BACKUP_UNAVAILABLE");
      running=true;try{
      const destination=await host.chooseDestination();if(!destination)return {cancelled:true};
      const keyFile=await host.chooseKey();if(!keyFile)return {cancelled:true};
      const installation=realpathSync(host.installation()),target=realpathSync(destination);
      if(target===installation||target.startsWith(installation+path.sep)||!lstatSync(target).isDirectory())throw Error("BACKUP_DESTINATION_INVALID");
      await verifyIdentityAccess();
      if(installation!==realpathSync(host.installation()))throw Error("BACKUP_REFERENCE_CHANGED");
      const key=readBackupIdentity(keyFile,installation);if(!key.recipient)throw Error("BACKUP_IDENTITY_HEADER_REQUIRED");
      if(!await host.confirmReferences())return {cancelled:true};
      const b={version:1,installationIdentity:installationIdentity(installation),installationRef:"installation-"+hash(installation).slice(0,24),destinationRef:randomUUID(),recoveryRef:randomUUID(),destination:target,destinationIdentity:installationIdentity(target),keyFile:realpathSync(keyFile),keyFingerprint:hash(fingerprint(keyFile)),recipient:key.recipient,allowIdleRestart:false,allowClosedApp:false};
      await host.writeProtected(BACKUP_SCHEDULE_BINDINGS_KEY,JSON.stringify(b));return publicStatus();
      }finally{running=false;}
    },
    async configure(expectedRevision,input){
      if(running)throw Error("BACKUP_BUSY");if(!input||typeof input!=="object"||Array.isArray(input))throw Error("INVALID_BACKUP_SCHEDULE");
      running=true;try{
      const {allowIdleRestart,allowClosedApp,...schedule}=input;
      if(schedule.enabled&&schedule.preUpgrade)await assertUpgradeAllowed();
      if(schedule.enabled&&schedule.closedApp===true){await assertClosedAllowed();if(allowClosedApp!==true)throw Error("BACKUP_CLOSED_CONSENT_REQUIRED");}
      if(schedule.enabled){const b=await read();if(!b||allowIdleRestart!==true||schedule.installationRef!==b.installationRef||schedule.destinationRef!==b.destinationRef||schedule.recoveryRef!==b.recoveryRef)throw Error("BACKUP_SCHEDULE_CONSENT_REQUIRED");await host.writeProtected(BACKUP_SCHEDULE_BINDINGS_KEY,JSON.stringify({...b,allowIdleRestart:true,allowClosedApp:schedule.closedApp===true}));}
      coordinator.configure(expectedRevision,schedule);
      }finally{running=false;}
      start();return publicStatus();
    },
  };
}
