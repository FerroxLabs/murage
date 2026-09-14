import {lstatSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from "node:fs";
import path from "node:path";
import {assertClosedProfileBinding,closedDigest,closedProfileId,closedTriggerDigest,readClosedPrivateFile} from "./backup-closed-profile.mjs";
import {disableClosedBackupJob,installClosedBackupJob,readClosedBackupStage,stageClosedBackupJob} from "./backup-closed-jobs.mjs";

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
export function createClosedBackupController({profile,triggerSource,backupSupported,provider,backup,confirmInstall}){
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
    try{
      const stage=readStage();if(!stage)return{...common,state:"unconfigured"};
      const current=await provider.read(stage);
      if(current&&(!same(current.files,stage.files)||current.jobId!==stage.jobId||!same(current.owner,stage.owner)))refuse();
      return{...common,state:lastState==="disabled-removal-pending"?lastState:current?.registered?"installed":lastState==="disabled"?"disabled":"staged"};
    }catch{return{...common,state:"unavailable"};}
  }
  async function exclusive(fn){if(running)throw Error("BACKUP_BUSY");running=true;try{return await fn();}finally{running=false;}}
  async function stage(){return exclusive(async()=>{
    if(!supported())refuse();const p=profile(),uid=p.owner.uid,control=location();
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
    lastState="staged";return status();
  });}
  async function install(){return exclusive(async()=>{
    if(!supported())refuse();const selected=readStage();if(!selected)refuse();
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
  return{status,stage,install,disable,
    async assertInstalled(){const staged=readStage();if(!staged||!supported())refuse();return assertClosedRegistration(staged.descriptor,staged.descriptorPath,provider);},
    async assertInvocation(descriptor,descriptorPath){const staged=await this.assertInstalled();if(staged.descriptorPath!==descriptorPath||!same(staged.descriptor,descriptor))refuse();},
  };
}
