import {lstatSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import path from "node:path";
import {assertClosedProfileBinding,closedDigest,closedProfileAppFileShared,closedProfileFolderShared,closedProfileId,closedTriggerDigest,readClosedPrivateFile} from "./backup-closed-profile.mjs";
import {disableClosedBackupJob,installClosedBackupJob,readClosedBackupStage,removeClosedBackupStage,stageClosedBackupJob} from "./backup-closed-jobs.mjs";

const refuse=()=>{throw Error("BACKUP_CLOSED_REVIEW_REQUIRED");};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const missing=file=>{try{lstatSync(file);return false;}catch(error){return error.code==="ENOENT";}};
const wontRunError=error=>error?.code==="CLOSED_NATIVE_JOB_WONT_RUN";
export function closedControlDirectory(installation){return path.join(path.dirname(installation),".murage-backup-control",closedDigest(installation));}
function privateDirectory(directory,uid){
  const s=lstatSync(directory);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==uid||(s.mode&0o077)||realpathSync.native(directory)!==directory)refuse();
}
function ensurePrivateDirectory(directory,uid){
  try{privateDirectory(directory,uid);}catch(error){if(error.code!=="ENOENT")throw error;mkdirSync(directory,{mode:0o700});privateDirectory(directory,uid);}
}
export async function assertClosedRegistration(descriptor,descriptorPath,provider){
  assertClosedProfileBinding(descriptor);
  const stage=readClosedBackupStage(path.dirname(descriptorPath));
  if(stage.descriptorPath!==descriptorPath||!same(stage.descriptor,descriptor))refuse();
  const registration=await provider.read(stage);
  if(!registration?.registered||registration.jobId!==stage.jobId||!same(registration.owner,stage.owner)||!same(registration.files,stage.files))refuse();
  return stage;
}

/** Main chooses all paths and callbacks. The renderer gets only safe state. */
export function createClosedBackupController({profile,triggerSource,backupSupported,provider,backup,confirmInstall,volumeProblem=()=>null}){
  // wontRun: the last registration's proving run failed (the job was taken
  // down again). moveFailed: Murage now runs from another app file and the job
  // could not be moved to it. Both are said on the Backups page until fixed.
  let running=false,lastState=null,wontRun=false,moveFailed=false;
  const location=()=>closedControlDirectory(profile().installation);
  const pointer=()=>path.join(location(),"closed-job-pointer.json");
  /** The staged job for this profile, or null.
   *
   * `forRemoval`: the job may name another app file than the one running now.
   * That happens when a person downloads a new AppImage by hand (its file name
   * carries the version) and opens it: the job still names the old file. Such
   * a stage is returned marked `moved`, and without checking the old file,
   * which may be gone: taking a job down or moving it needs only the stage's
   * own integrity, never the app file it used to run. */
  function readStage({forRemoval=false}={}){
    const p=profile();let value;
    try{value=JSON.parse(readClosedPrivateFile(pointer()));}catch(error){if(error.code==="ENOENT")return null;throw error;}
    if(!value||Object.keys(value).sort().join()!=="directory,version"||value.version!==1||value.directory!==`closed-${closedProfileId({...p,triggerEntry:path.join(location(),"unused-trigger.mjs"),triggerSha256:"0".repeat(64)})}`)refuse();
    let stage;
    // A pointer whose stage was taken down (a move that could not finish) is
    // nothing staged: the person can set the job up again.
    try{stage=readClosedBackupStage(path.join(location(),value.directory));}catch(error){if(missing(path.join(location(),value.directory)))return null;throw error;}
    let moved=false;
    for(const key of Object.keys(p))if(!same(stage.descriptor[key],p[key])){if(forRemoval&&key==="executable"){moved=true;continue;}refuse();}
    if(moved)return{...stage,moved:true};
    if(!forRemoval)assertClosedProfileBinding(stage.descriptor);return stage;
  }
  const supported=()=>Boolean(backupSupported()&&provider.supported);
  async function status(){
    const schedule=backup()?.internalStatus();
    const common={supported:supported(),closedApp:schedule?.enabled===true&&schedule?.schedule.closedApp===true,lastClosedResult:schedule?.lastClosedResult};
    if(!common.supported)return{...common,state:"unavailable"};
    if(closedProfileFolderShared(profile()))return{...common,state:"unavailable",blocked:"data-folder-shared"};
    // The app file itself (an AppImage made executable under umask 002): the
    // page names it and says the one command that fixes it.
    const appFile=closedProfileAppFileShared(profile());if(appFile)return{...common,state:"unavailable",blocked:"app-file-shared",appFile};
    // A background job cannot read files on another volume (backup-closed-volume.mjs).
    const volume=volumeProblem();if(volume)return{...common,state:"unavailable",blocked:`volume-${volume}`};
    try{
      const stage=readStage({forRemoval:true});
      if(!stage)return{...common,state:"unconfigured",...(moveFailed?{blocked:"app-moved"}:wontRun?{blocked:"job-wont-run"}:{})};
      // Still naming the app file Murage ran from before, and not moved yet:
      // ticking the box again takes the old job down and sets this one up.
      if(stage.moved)return{...common,state:"unconfigured",blocked:"app-moved"};
      assertClosedProfileBinding(stage.descriptor);
      const current=await provider.read(stage);
      if(current&&(!same(current.files,stage.files)||current.jobId!==stage.jobId||!same(current.owner,stage.owner)))refuse();
      // Registered but its command did not run last time: not "installed".
      // Reported as prepared, so ticking the box again re-registers and
      // proves it (installClosedBackupJob takes a failing job down first).
      if(current?.registered&&current.failing)return{...common,state:"staged",blocked:"job-wont-run"};
      const state=lastState==="disabled-removal-pending"?lastState:current?.registered?"installed":lastState==="disabled"?"disabled":"staged";
      return{...common,state,...(state!=="installed"&&wontRun?{blocked:"job-wont-run"}:{})};
    }catch{return{...common,state:"unavailable"};}
  }
  async function exclusive(fn){if(running)throw Error("BACKUP_BUSY");running=true;try{return await fn();}finally{running=false;}}
  /** Write the bundled trigger into the private control folder and stage the
   * job definition that runs it. Shared by staging and by re-staging after an
   * upgrade, so both write exactly the same thing. */
  function stageCurrent(){
    if(!supported())refuse();if(volumeProblem())throw Error("BACKUP_CLOSED_VOLUME_UNREADABLE");const p=profile(),uid=p.owner.uid,control=location();
    ensurePrivateDirectory(path.dirname(control),uid);ensurePrivateDirectory(control,uid);
    const digest=closedTriggerDigest(triggerSource),triggerEntry=path.join(control,`closed-trigger-${digest}.mjs`);
    try{if(closedTriggerDigest(triggerEntry)!==digest)refuse();}catch(error){
      if(error.code!=="ENOENT")throw error;
      const bytes=readFileSync(triggerSource);if(closedDigest(bytes)!==digest)refuse();
      writeFileSync(triggerEntry,bytes,{flag:"wx",mode:0o600,flush:true});
      if(closedTriggerDigest(triggerEntry)!==digest)refuse();
    }
    const staged=stageClosedBackupJob({...p,triggerEntry,triggerSha256:digest},{stagingRoot:control,backupSupported:true});
    const payload=JSON.stringify({version:1,directory:path.basename(staged.directory)});
    try{if(readClosedPrivateFile(pointer())!==payload)refuse();}catch(error){if(error.code!=="ENOENT")throw error;writeFileSync(pointer(),payload,{flag:"wx",mode:0o600,flush:true});}
    lastState="staged";return staged;
  }
  /** A stage left naming an app file Murage no longer runs from is taken
   * down (its job first, if registered) so the current app can be staged. */
  async function dropMovedStage(){
    const prior=readStage({forRemoval:true});if(!prior?.moved)return;
    if((await provider.read(prior))!==null&&(await disableClosedBackupJob(prior,{disableSchedule:async()=>{},...provider})).state!=="disabled")refuse();
    removeClosedBackupStage(prior.directory);
    try{rmSync(prior.descriptor.triggerEntry,{force:true});}catch{/* Rewritten by the next stage when it is the same trigger. */}
  }
  async function stage(){return exclusive(async()=>{await dropMovedStage();stageCurrent();return status();});}
  /** Carry an existing registration across an app upgrade.
   *
   * The trigger is part of the app, so a new version brings a new one, with a
   * new digest and a new filename. The registered job still names the file the
   * PREVIOUS version staged, and staging refuses a changed descriptor rather
   * than quietly rewriting one — so the job went on running the old app's
   * trigger, indefinitely, until somebody removed and re-added it by hand.
   *
   * Nothing here asks again: the person already said yes to a background job,
   * and this replaces that job with the same job built from the version they
   * are now running. It only ever runs when a stage already exists and its
   * trigger is not the bundled one, and it re-registers only what was
   * registered before. */
  async function restageForUpgrade(){return exclusive(async()=>{
    if(!supported())return status();
    let current;
    try{current=readStage({forRemoval:true});}catch{return status();}
    if(!current)return status();
    // Registered earlier from a volume a background job can't read (or moved
    // there since): every run would hang, so take the job down now. The
    // Backups page then says what to move where.
    if(volumeProblem()){
      if((await provider.read(current).catch(()=>null))?.registered){
        const result=await disableClosedBackupJob(current,{disableSchedule:async()=>{},...provider});
        lastState=result.state==="disabled"?"disabled":"disabled-removal-pending";
      }
      return status();
    }
    let digest;
    try{digest=closedTriggerDigest(triggerSource);}catch{return status();}
    // Three reasons to rebuild the job: a new trigger (an upgrade), a new app
    // file (an AppImage downloaded by hand has a new versioned name; the job
    // follows the copy of Murage the person now opens), or a registered job
    // whose command no longer runs.
    const registration=await provider.read(current).catch(()=>null);
    if(!current.moved&&current.descriptor.triggerSha256===digest&&!registration?.failing)return status();
    const registered=Boolean(registration?.registered);
    if(registered){
      // The authoritative schedule is NOT touched: this is the same job, not a
      // withdrawal of consent.
      const result=await disableClosedBackupJob(current,{disableSchedule:async()=>{},...provider});
      if(result.state!=="disabled"){lastState="disabled-removal-pending";return status();}
    }
    removeClosedBackupStage(current.directory);
    // The superseded trigger file is this app's litter, and the data folder is
    // not allowed to hold files Murage cannot account for.
    try{rmSync(current.descriptor.triggerEntry,{force:true});}catch{/* A trigger left behind never blocks the new job. */}
    try{
      const staged=stageCurrent();
      if(registered){await installClosedBackupJob(staged,provider);lastState="installed";}
      wontRun=false;moveFailed=false;
    }catch(error){
      // Never a silent stop: the old job is down, so say why on the page.
      if(wontRunError(error))wontRun=true;else if(current.moved)moveFailed=true;
    }
    return status();
  });}
  async function install(){return exclusive(async()=>{
    if(!supported())refuse();if(volumeProblem())throw Error("BACKUP_CLOSED_VOLUME_UNREADABLE");const selected=readStage();if(!selected)refuse();
    if(await confirmInstall()!==true)return{...(await status()),cancelled:true};
    const current=readStage();if(!current||current.definitionDigest!==selected.definitionDigest)refuse();
    try{await installClosedBackupJob(current,provider);}catch(error){if(wontRunError(error)){wontRun=true;throw Error("BACKUP_CLOSED_JOB_WONT_RUN");}throw error;}
    lastState="installed";wontRun=false;moveFailed=false;return status();
  });}
  async function disable(){return exclusive(async()=>{
    const host=backup();if(!host)refuse();
    const disableSchedule=async()=>{const s=host.internalStatus();await host.configure(s.revision,{...s.schedule,enabled:false});};
    // Disable even if the registration pointer itself is missing or changed.
    await disableSchedule();
    try{
      const staged=readStage({forRemoval:true});if(!staged){lastState="disabled";return status();}
      const result=await disableClosedBackupJob(staged,{disableSchedule:async()=>{},...provider});lastState=result.state;
      // A job for an app file Murage no longer runs from is not kept prepared.
      if(staged.moved&&result.state==="disabled"){await dropMovedStage();moveFailed=false;}
      return status();
    }catch{lastState="disabled-removal-pending";return{supported:supported(),closedApp:false,state:lastState};}
  });}
  return{status,stage,install,disable,restageForUpgrade,
    async assertInstalled(){const staged=readStage();if(!staged||!supported())refuse();return assertClosedRegistration(staged.descriptor,staged.descriptorPath,provider);},
    async assertInvocation(descriptor,descriptorPath){const staged=await this.assertInstalled();if(staged.descriptorPath!==descriptorPath||!same(staged.descriptor,descriptor))refuse();},
  };
}
