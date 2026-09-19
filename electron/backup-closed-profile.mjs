import {createHash} from "node:crypto";
import {constants,openSync,closeSync,fstatSync,lstatSync,readSync,realpathSync} from "node:fs";
import path from "node:path";
import {resolveInstallationSelection} from "./installation-selection.mjs";

export const CLOSED_DESCRIPTOR_LIMIT=16384;
export const CLOSED_TRIGGER_MAX_BYTES=16*1024*1024;
export const CLOSED_DUE_FLAG="--murage-backup-due";
export const CLOSED_DESCRIPTOR_FLAG="--murage-backup-descriptor";
export const closedDigest=value=>createHash("sha256").update(value).digest("hex");
const refuse=()=>{throw Object.assign(new Error("Closed backup profile requires review."),{code:"CLOSED_PROFILE_INVALID"});};
const exact=(value,keys)=>value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).sort().join()===keys.sort().join();
export function closedPath(value,platform=process.platform){
  const p=platform==="win32"?path.win32:path.posix;
  if(typeof value!=="string"||!value||value.length>4096||/[\x00-\x1f\x7f]/.test(value)||!p.isAbsolute(value)||p.normalize(value)!==value||value.startsWith("\\\\")||value===p.parse(value).root)refuse();
  return value;
}
export function parseClosedBackupDescriptor(value){
  try{
    if(typeof value==="string"){if(Buffer.byteLength(value)>CLOSED_DESCRIPTOR_LIMIT)refuse();value=JSON.parse(value);}
    if(!exact(value,["version","platform","requestedRoot","userData","installation","installationIdentity","owner","executable","triggerEntry","triggerSha256"])||value.version!==1||!["darwin","linux","win32"].includes(value.platform)||!/^[a-f0-9]{64}$/.test(value.installationIdentity)||!/^[a-f0-9]{64}$/.test(value.triggerSha256))refuse();
    const result={version:1,platform:value.platform};
    for(const key of ["requestedRoot","userData","installation"])result[key]=closedPath(value[key],value.platform);
    result.installationIdentity=value.installationIdentity;
    if(value.platform==="win32"){
      if(!exact(value.owner,["sid"])||typeof value.owner.sid!=="string"||!/^S-1-(?:\d{1,10}-){1,14}\d{1,10}$/.test(value.owner.sid))refuse();result.owner={sid:value.owner.sid};
    }else{if(!exact(value.owner,["uid"])||!Number.isSafeInteger(value.owner.uid)||value.owner.uid<1)refuse();result.owner={uid:value.owner.uid};}
    for(const key of ["executable","triggerEntry"]){result[key]=closedPath(value[key],value.platform);if(/(?:^|[\\/])\.mount_|[\\/]AppTranslocation[\\/]/.test(result[key]))refuse();}
    result.triggerSha256=value.triggerSha256;
    if(result.requestedRoot===result.userData||result.installation===result.userData||result.executable===result.triggerEntry||Buffer.byteLength(JSON.stringify(result))>CLOSED_DESCRIPTOR_LIMIT)refuse();
    return result;
  }catch{refuse();}
}
export const closedProfileId=descriptor=>{const d=parseClosedBackupDescriptor(descriptor);return closedDigest(JSON.stringify([d.platform,d.owner,d.requestedRoot,d.userData]));};
export const closedDescriptorDigest=descriptor=>closedDigest(JSON.stringify(parseClosedBackupDescriptor(descriptor)));
export function closedInstallationIdentity(directory){const actual=realpathSync.native(directory),stat=lstatSync(actual);if(!stat.isDirectory()||stat.isSymbolicLink())refuse();return closedDigest(JSON.stringify([actual,stat.dev,stat.ino]));}

/** Bounded private metadata read, never a credential or destination read. */
export function readClosedPrivateFile(file,{uid=process.getuid?.(),maxBytes=CLOSED_DESCRIPTOR_LIMIT}={}){
  closedPath(file);const before=lstatSync(file,{bigint:true});
  const valid=s=>s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n&&s.uid===BigInt(uid)&&!(s.mode&0o077n)&&s.size>=1n&&s.size<=BigInt(maxBytes);
  const same=s=>valid(s)&&["dev","ino","size","mode","uid","mtimeNs","ctimeNs"].every(key=>s[key]===before[key]);
  if(!Number.isSafeInteger(uid)||!valid(before))refuse();
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{if(!same(fstatSync(fd,{bigint:true})))refuse();const bytes=Buffer.alloc(Number(before.size));let count=0;while(count<bytes.length){const n=readSync(fd,bytes,count,bytes.length-count,count);if(!n)refuse();count+=n;}if(!same(fstatSync(fd,{bigint:true}))||!same(lstatSync(file,{bigint:true})))refuse();return bytes.toString("utf8");}finally{closeSync(fd);}
}
export const readClosedBackupDescriptor=(file,options)=>parseClosedBackupDescriptor(readClosedPrivateFile(file,options));
export function closedTriggerDigest(file){
  closedPath(file);const before=lstatSync(file,{bigint:true});
  const same=s=>s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n&&s.size>0n&&s.size<=BigInt(CLOSED_TRIGGER_MAX_BYTES)&&!(s.mode&0o022n)&&["dev","ino","size","mode","mtimeNs","ctimeNs"].every(key=>s[key]===before[key]);
  if(!same(before))refuse();const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{if(!same(fstatSync(fd,{bigint:true})))refuse();const buffer=Buffer.alloc(65536),hash=createHash("sha256");let count=0;while(count<Number(before.size)){const n=readSync(fd,buffer,0,Math.min(buffer.length,Number(before.size)-count),count);if(!n)refuse();count+=n;hash.update(buffer.subarray(0,n));}if(!same(fstatSync(fd,{bigint:true}))||!same(lstatSync(file,{bigint:true})))refuse();return hash.digest("hex");}finally{closeSync(fd);}
}

/** Caller passes user arguments (without executable). Normal launches untouched. */
export function parseClosedBackupArguments(argv){
  if(!Array.isArray(argv)||argv.some(value=>typeof value!=="string"))refuse();
  if(!argv.includes(CLOSED_DUE_FLAG)){if(argv.includes(CLOSED_DESCRIPTOR_FLAG))refuse();return null;}
  if(argv.length>16)refuse();
  const expected=[CLOSED_DUE_FLAG,CLOSED_DESCRIPTOR_FLAG,"--murage-data-dir","--murage-user-data"];
  if(argv.length!==7||expected.some(flag=>argv.filter(value=>value===flag).length!==1)||argv[0]!==CLOSED_DUE_FLAG)refuse();
  const result={};for(let i=1;i<argv.length;i+=2){if(!expected.slice(1).includes(argv[i])||argv[i+1]?.startsWith("--"))refuse();result[argv[i]]=closedPath(argv[i+1]);}
  return{descriptorPath:result[CLOSED_DESCRIPTOR_FLAG],requestedRoot:result["--murage-data-dir"],userData:result["--murage-user-data"]};
}
export function closedProfileEnvironment(invocation,descriptor,environment={}){
  const d=parseClosedBackupDescriptor(descriptor);
  if(!invocation||invocation.requestedRoot!==d.requestedRoot||invocation.userData!==d.userData)refuse();
  for(const[key,value]of [["MURAGE_DATA_DIR",d.requestedRoot],["MURAGE_USER_DATA",d.userData]])if(environment[key]!==undefined&&environment[key]!==value)refuse();
  return{MURAGE_DATA_DIR:d.requestedRoot,MURAGE_USER_DATA:d.userData};
}
/** Whether a folder the closed-app profile binds to can be changed by another
 * account (group/other writable or not owned by this user). The binding check
 * refuses such a folder; this lets the status say so instead of a generic
 * refusal. Missing folders are not counted here. */
export function closedProfileFolderShared(profile,{owner={uid:process.getuid?.()}}={}){
  for(const key of ["requestedRoot","userData","installation"]){
    let stat;try{stat=lstatSync(profile[key]);}catch{continue;}
    if(stat.isDirectory()&&!stat.isSymbolicLink()&&(stat.uid!==owner.uid||(stat.mode&0o022)))return true;
  }
  return false;
}
export function assertClosedProfileBinding(descriptor,{platform=process.platform,owner={uid:process.getuid?.()},resolveSelection=resolveInstallationSelection}={}){
  const d=parseClosedBackupDescriptor(descriptor);if(d.platform!==platform||JSON.stringify(d.owner)!==JSON.stringify(owner)||platform==="win32")refuse();
  for(const key of ["requestedRoot","userData","installation"]){const stat=lstatSync(d[key]);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==owner.uid||(stat.mode&0o022)||realpathSync.native(d[key])!==d[key])refuse();}
  const selected=resolveSelection(d.userData,d.requestedRoot);if(selected.dataDirectory!==d.installation||closedInstallationIdentity(d.installation)!==d.installationIdentity)refuse();
  for(const key of ["executable","triggerEntry"]){const s=lstatSync(d[key]);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||(s.mode&0o022)||realpathSync.native(d[key])!==d[key])refuse();}
  if(closedTriggerDigest(d.triggerEntry)!==d.triggerSha256)refuse();
  return d;
}
/** Environment allowlist: no inherited credentials, Node flags or profile drift. */
export function closedInvocation(descriptor,descriptorPath,{mode="capture",environment={}}={}){
  const d=parseClosedBackupDescriptor(descriptor);closedPath(descriptorPath,d.platform);
  const env={};for(const key of ["HOME","PATH","TMPDIR","DISPLAY","WAYLAND_DISPLAY","XDG_RUNTIME_DIR","DBUS_SESSION_BUS_ADDRESS"])if(typeof environment[key]==="string"&&!/[\x00\r\n]/.test(environment[key]))env[key]=environment[key];
  if(mode==="trigger")return{executable:d.executable,args:[d.triggerEntry,CLOSED_DESCRIPTOR_FLAG,descriptorPath],env:{...env,ELECTRON_RUN_AS_NODE:"1"}};
  if(mode!=="capture")refuse();const args=[CLOSED_DUE_FLAG,CLOSED_DESCRIPTOR_FLAG,descriptorPath,"--murage-data-dir",d.requestedRoot,"--murage-user-data",d.userData];
  return{executable:d.executable,args,env:{...env,...closedProfileEnvironment(parseClosedBackupArguments(args),d,environment)}};
}
