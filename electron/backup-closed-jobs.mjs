import {mkdirSync,lstatSync,realpathSync,writeFileSync,readdirSync,unlinkSync,rmdirSync} from "node:fs";
import path from "node:path";
import {execStartExecutable,execStartWord,environmentLine} from "../installer/lib/systemd.mjs";
import {parseClosedBackupDescriptor,closedPath,closedProfileId,closedDescriptorDigest,closedDigest,closedInvocation,assertClosedProfileBinding,readClosedPrivateFile,readClosedBackupDescriptor} from "./backup-closed-profile.mjs";

const fail=()=>{throw Object.assign(new Error("Closed backup job requires review."),{code:"CLOSED_JOB_REVIEW_REQUIRED"});};
const xml=value=>String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&apos;");
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const filesDigest=files=>closedDigest(JSON.stringify(files));

/** User-session definitions only. This creates no OS registration. */
export function buildClosedBackupJob(descriptor,descriptorPath,{backupSupported=false}={}){
  const d=parseClosedBackupDescriptor(descriptor),jobId=`com.murage.backup.${closedProfileId(d)}`;
  closedPath(descriptorPath,d.platform);
  if(!backupSupported||d.platform==="win32")return{supported:false,reason:"backup-tool-unavailable",jobId,owner:d.owner,files:[]};
  const descriptorDigest=closedDescriptorDigest(d),invocation=closedInvocation(d,descriptorPath,{mode:"trigger"});
  const marker=`MurageClosedBackup ${jobId} ${descriptorDigest}`;
  let files;
  if(d.platform==="darwin"){
    const text=`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(jobId)}</string>\n<key>ProgramArguments</key><array>${[invocation.executable,...invocation.args].map(value=>`<string>${xml(value)}</string>`).join("")}</array>\n<key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict>\n<key>StartInterval</key><integer>60</integer>\n<key>RunAtLoad</key><true/>\n<key>LimitLoadToSessionType</key><string>Aqua</string>\n<key>ProcessType</key><string>Background</string>\n<key>KeepAlive</key><false/>\n<!-- ${marker} -->\n</dict></plist>\n`;
    files=[{name:`${jobId}.plist`,text}];
  }else{
    const service=`# ${marker}\n[Unit]\nDescription=Murage closed backup due check\n\n[Service]\nType=oneshot\nExecStart=${[execStartExecutable("closed backup executable",invocation.executable),...invocation.args.map(value=>execStartWord("closed backup argument",value))].join(" ")}\n${environmentLine("ELECTRON_RUN_AS_NODE","1")}\nUMask=0077\nTimeoutStartSec=infinity\nStandardOutput=null\nStandardError=null\n`;
    const timer=`# ${marker}\n[Unit]\nDescription=Murage owning-user backup trigger\n\n[Timer]\nOnStartupSec=10s\nOnUnitActiveSec=60s\nAccuracySec=1s\nUnit=${jobId}.service\n\n[Install]\nWantedBy=timers.target\n`;
    files=[{name:`${jobId}.service`,text:service},{name:`${jobId}.timer`,text:timer}];
  }
  if(files.some(file=>Buffer.byteLength(file.text)>65536))fail();
  return{supported:true,jobId,owner:d.owner,descriptorDigest,definitionDigest:filesDigest(files),files};
}
function privateDirectory(directory,uid){
  closedPath(directory);const stat=lstatSync(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==uid||(stat.mode&0o077)||realpathSync.native(directory)!==directory)fail();
}
/** Refuses changed/foreign stages. Explicit old removal precedes a restage. */
export function stageClosedBackupJob(descriptor,{stagingRoot,backupSupported=false,uid=process.getuid?.()}={}){
  const d=parseClosedBackupDescriptor(descriptor);if(!backupSupported||d.platform==="win32")return{state:"unsupported",reason:"backup-tool-unavailable"};
  if(d.owner.uid!==uid)fail();assertClosedProfileBinding(d);privateDirectory(stagingRoot,uid);
  const directory=path.join(stagingRoot,`closed-${closedProfileId(d)}`),descriptorPath=path.join(directory,"descriptor.json");
  const job=buildClosedBackupJob(d,descriptorPath,{backupSupported});
  try{mkdirSync(directory,{mode:0o700});}catch(error){if(error.code!=="EEXIST")throw error;const prior=readClosedBackupStage(directory,{uid});if(prior.descriptorDigest!==job.descriptorDigest||prior.definitionDigest!==job.definitionDigest)fail();return prior;}
  privateDirectory(directory,uid);
  writeFileSync(descriptorPath,JSON.stringify(d),{flag:"wx",mode:0o600,flush:true});
  for(const file of job.files)writeFileSync(path.join(directory,file.name),file.text,{flag:"wx",mode:0o600,flush:true});
  writeFileSync(path.join(directory,"stage.json"),JSON.stringify({version:1,owner:job.owner,jobId:job.jobId,descriptorDigest:job.descriptorDigest,definitionDigest:job.definitionDigest}),{flag:"wx",mode:0o600,flush:true});
  return readClosedBackupStage(directory,{uid});
}
export function readClosedBackupStage(directory,{uid=process.getuid?.()}={}){
  privateDirectory(directory,uid);const descriptorPath=path.join(directory,"descriptor.json"),descriptor=readClosedBackupDescriptor(descriptorPath,{uid});
  if(descriptor.owner.uid!==uid)fail();const job=buildClosedBackupJob(descriptor,descriptorPath,{backupSupported:true});if(!job.supported)fail();
  const expected={version:1,owner:job.owner,jobId:job.jobId,descriptorDigest:job.descriptorDigest,definitionDigest:job.definitionDigest};
  let marker;try{marker=JSON.parse(readClosedPrivateFile(path.join(directory,"stage.json"),{uid}));}catch{fail();}
  if(!same(marker,expected)||!same(readdirSync(directory).sort(),["descriptor.json","stage.json",...job.files.map(file=>file.name)].sort()))fail();
  for(const file of job.files)if(readClosedPrivateFile(path.join(directory,file.name),{uid,maxBytes:65536})!==file.text)fail();
  return{state:"staged",directory,descriptorPath,descriptor,...job};
}
export function removeClosedBackupStage(directory,options){
  const stage=readClosedBackupStage(directory,options);
  for(const name of [...stage.files.map(file=>file.name),"descriptor.json","stage.json"])unlinkSync(path.join(directory,name));rmdirSync(directory);
  return{state:"removed"};
}
function matchesRegistration(job,current){
  return current&&current.jobId===job.jobId&&same(current.owner,job.owner)&&same(current.files,job.files)&&typeof current.registered==="boolean"&&typeof current.running==="boolean";
}
/** Injected provider must read actual installed bytes and OS registration. */
export async function installClosedBackupJob(stage,{read,install}){
  const job=readClosedBackupStage(stage.directory);assertClosedProfileBinding(job.descriptor);
  const prior=await read(job);if(prior&&!matchesRegistration(job,prior))fail();
  // A registered job whose command failed last time is not installed: the
  // provider takes it down and registers and proves it again.
  if(prior?.registered&&!prior.failing)return{state:"installed",jobId:job.jobId,definitionDigest:job.definitionDigest};
  if(prior?.running)fail();await install(job,{expected:prior});
  const current=await read(job);if(!matchesRegistration(job,current)||!current.registered||current.failing)fail();
  return{state:"installed",jobId:job.jobId,definitionDigest:job.definitionDigest};
}
/** Disable authoritative schedule first; never terminate a running capture. */
export async function disableClosedBackupJob(stage,{disableSchedule,read,remove}){
  await disableSchedule();
  try{
    const job=readClosedBackupStage(stage.directory),prior=await read(job);if(!prior)return{state:"disabled"};
    if(!matchesRegistration(job,prior)||prior.running)return{state:"disabled-removal-pending"};
    await remove(job,{expected:prior});return(await read(job))===null?{state:"disabled"}:{state:"disabled-removal-pending"};
  }catch{return{state:"disabled-removal-pending"};}
}
