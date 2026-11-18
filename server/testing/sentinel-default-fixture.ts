// SPDX-License-Identifier: AGPL-3.0-or-later
// Launcher, receipt and fixture owners: scperf-p2. OS qualification owner: MAIN.
import {mkdtempSync,mkdirSync,readFileSync,rmSync,existsSync,renameSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {createHash} from "node:crypto";
import {sentinelInstallationIdOf} from "../../shared/sentinel-installation.mjs";
import {defaultOutputRoot,writeDescriptor,sourcePaths,type SentinelDescriptor} from "../sentinel/paths.ts";
import {SentinelFileReceiver} from "../sentinel/file-receipts.ts";
import {sampleSentinelFileIo} from "../sentinel-file-sampling.ts";

export async function defaultCoverageScenario(kind:string){
 const root=mkdtempSync(join(tmpdir(),"sentinel-default-")),data=join(root,"data"),home=join(root,"home");
 mkdirSync(data,{mode:0o700});mkdirSync(home,{mode:0o700});
 Object.assign(process.env,{HOME:home,USERPROFILE:home,MURAGE_DATA_DIR:data,MURAGE_SENTINEL_STATE_DIR:join(root,"state")});
 const installationId=sentinelInstallationIdOf(data),outputRoot=defaultOutputRoot(installationId)!,descriptorPath=join(outputRoot,"descriptor.json");
 const entry=resolve("dist-server/sentinel/cli.js");
 const descriptor:SentinelDescriptor={version:1,installationId,installationRoot:data,inputRoot:join(data,"health"),outputRoot,
  sources:sourcePaths(join(data,"health")),executable:{path:process.execPath,entry,sha256:createHash("sha256").update(readFileSync(entry)).digest("hex")},scheduleRevision:1};
 const sample=()=>sampleSentinelFileIo(()=>null).snapshot;
 const write=()=>{mkdirSync(outputRoot,{recursive:true,mode:0o700});if(!writeDescriptor(descriptor).ok)throw Error("FIXTURE_DESCRIPTOR");};
 const scan=()=>execFileSync(process.execPath,[entry,descriptorPath,"--once"],{env:process.env,encoding:"utf8"});
 try{
  if(kind==="unresolved")for(const name of ["HOME","USERPROFILE","XDG_STATE_HOME","LOCALAPPDATA","MURAGE_SENTINEL_STATE_DIR"])delete process.env[name];
  const bare=sample().known;
  if(kind==="legacy"){write();rmSync(descriptorPath);}
  await import("../io-copy-bootstrap.ts");
  const boot=sample();
  if(kind==="legacy"||kind==="unresolved")return {bare,known:boot.known,enrolled:existsSync(join(data,"sentinel-io","enrollment.json"))};
  if(kind==="absent-budget"){
   const {readProcess,IoBudget}=await import("../io-budget.ts");let at=0;
   const samples:Array<{discontinuity:boolean}>=[];
   const budget=new IoBudget({read:()=>({...readProcess("win32"),at:at+=60000}),log:()=>{},systemOverloaded:()=>null,isIdle:()=>true,onSample:s=>samples.push(s)});
   budget.tick();const verdict=budget.tick();
   return {boot:boot.known,pollScale:budget.pollScale(),tripped:verdict?.tripped,discontinuities:samples.map(s=>s.discontinuity)};
  }
  if(kind==="absent"){
   const {readProcess}=await import("../io-budget.ts");
   const restarted=new SentinelFileReceiver(data).sample(()=>null).snapshot;
   return {bare,boot:boot.known,restart:restarted.known,epoch:boot.epoch!==null,windowsKnown:readProcess("win32").osKnown!==false};
  }
  if(kind==="transient"){
   write();rmSync(descriptorPath);
   const later=sample().known,restart=new SentinelFileReceiver(data).sample(()=>null).snapshot.known;
   return {bare,boot:boot.known,later,restart};
  }
  if(kind==="ipc-uncovered"){
   const {desktopIoReceiver}=await import("../io-desktop-receipts.ts");
   desktopIoReceiver(()=>{}).accept({type:"uncovered"});
   return {boot:boot.known,after:sample().known};
  }
  if(kind==="cloud"||kind==="cloud-projection"){
   const cloudPath="../../deploy/cloud-home/murage-sentinel-descriptor.mjs";
   const {cloudDescriptor,CLOUD_DATA_DIR,CLOUD_INSTALLATION_ROOT,CLOUD_ENTRY,CLOUD_NODE}=await import(/* @vite-ignore */ cloudPath);
   const cloud=cloudDescriptor({entryBytes:readFileSync(entry),env:process.env});
   // Relocate the entire production namespace projection into owned fixture
   // roots, including sources, executable and identity. No projection is dropped.
   const projected=join(root,"projected-home");mkdirSync(projected,{mode:0o700});
   const relocate=(value:string)=>value===CLOUD_NODE?process.execPath:value===CLOUD_ENTRY?entry:
    value.replace(CLOUD_INSTALLATION_ROOT,projected).replace(CLOUD_DATA_DIR,data).replace(cloud.installationId,installationId);
   const mapped=JSON.parse(JSON.stringify(cloud,(_key,value)=>typeof value==="string"?relocate(value):value));
   Object.assign(descriptor,mapped);write();const pending=sample().known;
   const unit=readFileSync("deploy/cloud-home/murage-sentinel.service","utf8");
   const projection=descriptor.installationRoot===projected&&descriptor.inputRoot===join(projected,"health")
    &&Object.values(descriptor.sources).every(path=>path.startsWith(join(projected,"health")+"/"))
    &&unit.includes(`BindPaths=-${CLOUD_DATA_DIR}/sentinel-io:${CLOUD_INSTALLATION_ROOT}/sentinel-io`)
    &&unit.includes(`BindReadOnlyPaths=-${CLOUD_DATA_DIR}/health:${CLOUD_INSTALLATION_ROOT}/health`);
   // Model the two namespace views sequentially by moving the same directory
   // inode (no symlink, file copy or alternate enrollment). MAIN qualifies the
   // actual concurrent systemd bind mount and read-only health boundary.
   const source=join(data,"sentinel-io"),view=join(projected,"sentinel-io");
   renameSync(source,view);
   try{scan();}finally{renameSync(view,source);}
   const sealed=sample(),receiptReturned=existsSync(join(source,"receipt.json"))&&!existsSync(view);
   const result={boot:boot.known,pending,known:sealed.known,baseline:sealed.baseline,ipc:!!process.send};
   return kind==="cloud"?result:{...result,projection,receiptReturned};
  }

  if(kind.startsWith("desktop-")){
   const target=kind==="desktop-probe"?process.platform:kind.slice("desktop-".length),mechanism=target==="win32"?"task-scheduler":target==="darwin"?"launchd":"systemd";
   const hostPath="../../electron/sentinel-host.mjs",schedulePath="../../electron/sentinel-schedule.mjs";
   const {createSentinelHost,defaultProbe}=await import(/* @vite-ignore */ hostPath);
   const {sentinelInvocation}=await import(/* @vite-ignore */ schedulePath);
   const boundary=await import("../health/host-boundary.ts");
   // macOS Application Support and Windows LocalAppData already exist on a
   // real login; provide their relocated base before host initialization.
   mkdirSync(process.env.MURAGE_SENTINEL_STATE_DIR!,{recursive:true,mode:0o700});
   let installed:SentinelDescriptor|undefined;
   // Only the OS scheduler is a fixture. Host staging, descriptor creation,
   // default enrollment, scan process and receipt consumer are production code.
   const provider={
    async install(d:SentinelDescriptor){installed=d;},
    async read(){if(!installed)return null;const call=sentinelInvocation({platform:target,descriptor:installed,descriptorPath});return {registered:true,mechanism,executable:call.executable,args:call.args,owner:null,revision:installed.scheduleRevision,lastResult:0};},
    async remove(){return {removed:[]};},
   };
   let probe:number|null=null,enrolledBeforeProbe=false,probeWrote=false;
   const realProbe=defaultProbe({executable:process.execPath,platform:target,env:process.env});
   // Cross-policy Windows argv is exercised here on the native filesystem;
   // the separate topology test uses real Windows paths and Task XML. A real
   // Windows host/ACL/trampoline run remains MAIN's packaged-OS qualification.
   const host=createSentinelHost({dataDir:data,home,env:process.env,platform:target==="win32"&&process.platform!=="win32"?process.platform:target,userData:join(root,"userData"),executable:process.execPath,entrySource:entry,
    loadBoundary:async()=>boundary,provider,probe:async(path:string,staged:string)=>{
     enrolledBeforeProbe=existsSync(join(data,"sentinel-io","enrollment.json"))&&existsSync(join(data,"sentinel-io","receipt.json"));
     const before=enrolledBeforeProbe?JSON.parse(readFileSync(join(data,"sentinel-io","receipt.json"),"utf8").trim()).sequence:0;
     probe=await realProbe(path,staged);
     probeWrote=enrolledBeforeProbe&&JSON.parse(readFileSync(join(data,"sentinel-io","receipt.json"),"utf8").trim()).sequence>before;
     return probe;
    },setInterval:()=>({}),clearInterval:()=>{}});
   try{
    await host.initialize();const registration=await host.reconcile();
    const pending=sample().known;
    if(!installed)throw Error("FIXTURE_NO_REGISTRATION");
    const invocation=sentinelInvocation({platform:target,descriptor:installed,descriptorPath});
    // The Windows trampoline's argv is consumed by Electron before Node runs
    // the same entry. Its actual Windows process/ACL behavior needs an OS leg.
    const args=target==="win32"?invocation.args.slice(1):invocation.args.filter((x:string)=>x!=="--no-sandbox");
    execFileSync(invocation.executable,args,{env:{...process.env,...invocation.env},encoding:"utf8"});
    const sealed=sample();
    const result={boot:boot.known,pending,registration:registration.state,mechanism:registration.mechanism,known:sealed.known,baseline:sealed.baseline,ipc:!!process.send};
    return kind==="desktop-probe"?{...result,probe,enrolledBeforeProbe,probeWrote}:result;
   }finally{await host.shutdown();}
  }
  throw Error("FIXTURE_SCENARIO");
 }finally{rmSync(root,{recursive:true,force:true});}
}
