import {lstatSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import path from "node:path";
import {assertClosedProfileBinding,closedDigest,closedProfileFolderShared,closedProfileId,closedTriggerDigest,readClosedPrivateFile} from "./backup-closed-profile.mjs";
import {disableClosedBackupJob,installClosedBackupJob,readClosedBackupStage,removeClosedBackupStage,stageClosedBackupJob} from "./backup-closed-jobs.mjs";

const refuse=()=>{throw Error("BACKUP_CLOSED_REVIEW_REQUIRED");};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
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
  let running=false,lastState=null;
  const location=()=>closedControlDirectory(profile().installation);
  const pointer=()=>path.join(location(),"closed-job-pointer.json");
  function readStage(){
    const p=profile();let value;
    try{value=JSON.parse(readClosedPrivateFile(pointer()));}catch(error){if(error.code==="ENOENT")return null;throw error;}
    if(!value||Object.keys(value).sort().join()!=="directory,version"||value.version!==1||value.directory!==`closed-${closedProfileId({...p,triggerEntry:path.join(location(),"unused-trigger.mjs"),triggerSha256:"0".repeat(64)})}`)refuse();
    const stage=readClosedBackupStage(path.join(location(),value.directory));
    for(const key of Object.keys(p))if(!same(stage.descriptor[key],p[key]))refuse();
    assertClosedProfileBinding(stage.descriptor);return stage;
  }
  const supported=()=>Boolean(backupSupported()&&provider.supported);
  async function status(){
    const schedule=backup()?.internalStatus();
    const common={supported:supported(),closedApp:schedule?.enabled===true&&schedule?.schedule.closedApp===true,lastClosedResult:schedule?.lastClosedResult};
    if(!common.supported)return{...common,state:"unavailable"};
    if(closedProfileFolderShared(profile()))return{...common,state:"unavailable",blocked:"data-folder-shared"};
    // A background job cannot read files on another volume (backup-closed-volume.mjs).
    const volume=volumeProblem();if(volume)return{...common,state:"unavailable",blocked:`volume-${volume}`};
    try{
      const stage=readStage();if(!stage)return{...common,state:"unconfigured"};
      const current=await provider.read(stage);
      if(current&&(!same(current.files,stage.files)||current.jobId!==stage.jobId||!same(current.owner,stage.owner)))refuse();
      return{...common,state:lastState==="disabled-removal-pending"?lastState:current?.registered?"installed":lastState==="disabled"?"disabled":"staged"};
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
  async function stage(){return exclusive(async()=>{stageCurrent();return status();});}
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
    try{current=readStage();}catch{return status();}
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
    if(current.descriptor.triggerSha256===digest)return status();
    const registered=Boolean((await provider.read(current).catch(()=>null))?.registered);
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
    const staged=stageCurrent();
    if(registered){await installClosedBackupJob(staged,provider);lastState="installed";}
    return status();
  });}
  async function install(){return exclusive(async()=>{
    if(!supported())refuse();if(volumeProblem())throw Error("BACKUP_CLOSED_VOLUME_UNREADABLE");const selected=readStage();if(!selected)refuse();
    if(await confirmInstall()!==true)return{...(await status()),cancelled:true};
    const current=readStage();if(!current||current.definitionDigest!==selected.definitionDigest)refuse();
    await installClosedBackupJob(current,provider);lastState="installed";return status();
  });}
  async function disable(){return exclusive(async()=>{
    const host=backup();if(!host)refuse();
    const disableSchedule=async()=>{const s=host.internalStatus();await host.configure(s.revision,{...s.schedule,enabled:false});};
    // Disable even if the registration pointer itself is missing or changed.
    await disableSchedule();
    try{
      const staged=readStage();if(!staged){lastState="disabled";return status();}
      const result=await disableClosedBackupJob(staged,{disableSchedule:async()=>{},...provider});lastState=result.state;
      return status();
    }catch{lastState="disabled-removal-pending";return{supported:supported(),closedApp:false,state:lastState};}
  });}
  return{status,stage,install,disable,restageForUpgrade,
    async assertInstalled(){const staged=readStage();if(!staged||!supported())refuse();return assertClosedRegistration(staged.descriptor,staged.descriptorPath,provider);},
    async assertInvocation(descriptor,descriptorPath){const staged=await this.assertInstalled();if(staged.descriptorPath!==descriptorPath||!same(staged.descriptor,descriptor))refuse();},
  };
}
