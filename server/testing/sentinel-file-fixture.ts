// SPDX-License-Identifier: AGPL-3.0-or-later
// Both fixture boundary owners: scperf-p2-rd2. No live app or data.
import fs from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {DatabaseSync} from "node:sqlite";
import {spawn,spawnSync,execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,chmodSync,rmSync,symlinkSync,linkSync,renameSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {sentinelInstallationIdOf} from "../../shared/sentinel-installation.mjs";
import {defaultOutputRoot,sourcePaths,writeDescriptor,type SentinelDescriptor} from "../sentinel/paths.ts";
import {SentinelFileReceiver,SentinelFileWriter,ReceiptDirectory,provisionFileReceipts,decodeReceipt,encodeReceipt} from "../sentinel/file-receipts.ts";
import {scannerNative} from "../sentinel/io-meter.ts";
import { safeWipeSync } from "./safe-wipe.mjs";
export async function fileScenario(kind:string){
 const root=mkdtempSync(join(tmpdir(),"sentinel-file-")),data=join(root,"data");mkdirSync(data,{mode:0o700});
 process.env.MURAGE_DATA_DIR=data;process.env.MURAGE_SENTINEL_STATE_DIR=join(root,"state");
 const installationId=sentinelInstallationIdOf(data),outputRoot=defaultOutputRoot(installationId)!;
 mkdirSync(outputRoot,{recursive:true,mode:0o700});
 const entry=resolve("server/sentinel/cli.ts"),sha256=createHash("sha256").update(readFileSync(entry)).digest("hex");
 const descriptor:SentinelDescriptor={version:1,installationId,installationRoot:data,inputRoot:join(data,"health"),outputRoot,sources:sourcePaths(join(data,"health")),executable:{path:process.execPath,entry,sha256},scheduleRevision:1};
 mkdirSync(descriptor.inputRoot,{mode:0o700});
 if(!writeDescriptor(descriptor).ok)throw Error("FIXTURE_DESCRIPTOR");
 let wall=1_000_000,mono=1000;
 const receiver=new SentinelFileReceiver(data,()=>wall,()=>mono),sample=()=>receiver.sample(()=>({marker:wall})).snapshot;
 const api=scannerNative() as ReturnType<typeof scannerNative>&{ioMeterSnapshot:()=>{total:number;known:boolean};ioMeterAdd:(source:string,bytes:number)=>void};
 const read=()=>{const r=api!.ioMeterSnapshot();return {bytes:r.total,known:r.known};};
 const tick=()=>{wall+=60_000;mono+=60_000;};
 const cycle=(payload=0,known=true)=>{
  const w=SentinelFileWriter.begin(descriptor,read,()=>wall);if(!w)throw Error("FIXTURE_ADMISSION");
  if(payload)api!.ioMeterAdd("sentinel-fixture",payload);
  if(!w.finish(read,known,()=>wall))throw Error("FIXTURE_SEAL");
 };
 const dirPath=join(data,"sentinel-io");
 const record=()=>{const d=new ReceiptDirectory(dirPath);try{return decodeReceipt(d.read("receipt.json",4096),d.read("key",32));}finally{d.close();}};
 const replace=(edit:(r:ReturnType<typeof record>)=>void)=>{const d=new ReceiptDirectory(dirPath);try{const key=d.read("key",32),r={...decodeReceipt(d.read("receipt.json",4096),key)};edit(r);d.replace("receipt.json",encodeReceipt(r,key));}finally{d.close();}};
 try{
  if(kind==="missing")return sample();
  if(kind==="legacy")return {enrolled:provisionFileReceipts(data,{legacyExcluded:false}),exists:fs.existsSync(dirPath),snapshot:sample()};
  if(kind==="installer-env"){
   const path="../../installer/lib/sentinel.mjs",{sentinelWatchSpec}=await import(/* @vite-ignore */ path);
   const env=sentinelWatchSpec({entry,descriptorPath:join(outputRoot,"descriptor.json"),env:{HOME:data,USERPROFILE:data,LOCALAPPDATA:data,SystemRoot:root,MURAGE_RESOURCES_PATH:process.env.MURAGE_RESOURCES_PATH,UNRELATED_CONFIG:"fixture"}}).env;
   return {resources:env.MURAGE_RESOURCES_PATH===process.env.MURAGE_RESOURCES_PATH,windows:env.USERPROFILE===data&&env.LOCALAPPDATA===data&&env.SystemRoot===root,stripped:!("UNRELATED_CONFIG" in env),known:sample().known};
  }
  if(kind==="installer"){
   const installer="../../installer/lib/sentinel.mjs";
   const {prepareSentinel}=await import(/* @vite-ignore */ installer);
   const paths=await import("../sentinel/paths.ts");
   const boundary={...paths,sentinelInstallationId:(dir:string)=>sentinelInstallationIdOf(dir),HEALTH_DIR:"health",provisionFileReceipts};
   const args={payload:{entry,boundary:"fixture"},dataDir:data,env:process.env,execPath:process.execPath,loadBoundary:async()=>boundary};
   const legacy=await prepareSentinel(args),legacyKnown=sample().known,legacyEnrolled=fs.existsSync(dirPath);
   const enrolled=await prepareSentinel({...args,legacyWritersDrained:true});
   return {legacy:legacy.ok,legacyKnown,legacyEnrolled,enrolled:enrolled.ok,key:fs.existsSync(join(dirPath,"key"))};
  }
  if(!provisionFileReceipts(data,{legacyExcluded:true}))throw Error("FIXTURE_ENROLLMENT");
  if(kind==="nofollow-swap"){
   sample();cycle();const first=sample();
   const original=api!.sentinelIoOpen!,saved=join(root,"saved-receipts");let swapped=false;
   api!.sentinelIoOpen=(...args)=>{const h=original(...args);if(!swapped){swapped=true;renameSync(dirPath,saved);symlinkSync(saved,dirPath,"dir");}return h;};
   let bad;try{bad=sample();}finally{api!.sentinelIoOpen=original;}
   return {first:first.known,swapped,bad:bad.known};
  }
  if(kind.startsWith("nofollow-")){
   sample();cycle();const positive=sample();
   const leaf=kind.slice("nofollow-".length),outside=join(root,"outside");mkdirSync(outside,{mode:0o700});
   const saved=join(root,"saved-receipts");
   if(leaf==="directory"||leaf==="dangling"){
    renameSync(dirPath,saved);symlinkSync(leaf==="directory"?saved:join(root,"missing"),dirPath,"dir");
   }else{
    const name=leaf==="temporary"?"receipt.json.tmp":leaf==="destination"?"receipt.json":"snapshot.lock";
    const target=join(outside,"target");writeFileSync(target,"fixture unchanged",{mode:0o600});
    try{rmSync(join(dirPath,name));}catch{/* absent temporary */}
    symlinkSync(target,join(dirPath,name));
   }
   const watched=leaf==="directory"?saved:outside;
   const capture=()=>fs.readdirSync(watched).sort().map(name=>[name,fs.readFileSync(join(watched,name)).toString("hex")]);
   const unchanged=capture();
   const bad=sample();
   const {main}=await import("../sentinel/cli.ts");
   const code=await main([join(outputRoot,"descriptor.json"),"--once"],{out:()=>{},now:()=>wall});
   return {positive:positive.known,bad:bad.known,code,unchanged:JSON.stringify(unchanged)===JSON.stringify(capture())};
  }
  if(kind==="consumer"){
   const {installCopyMeter,ioMeterCoverageKnown}=await import("../io-meter.ts");
   const {installChildProcessMeter}=await import("../io-child-meter.ts");
   const {sampleSentinelFileIo}=await import("../sentinel-file-sampling.ts");
   const {ioBudget,readProcess}=await import("../io-budget.ts");
   installCopyMeter();installChildProcessMeter();
   const {desktopIoReceiver,desktopIoCovered}=await import("../io-desktop-receipts.ts"),owned=await import("../sentinel/io-child-receipts.ts");
   const beforeIpc=owned.ownedChildIoBytes(),relay=desktopIoReceiver(()=>{}),generation="fixture-attached";
   relay.accept({type:"launch",generation});relay.accept({type:"sample",generation,message:{type:"io",ioProtocol:1,generation,sequence:1,fsWriteBlocks:0,ioBytes:123456,known:true,final:true}});
   const duplicateIpc=owned.ownedChildIoBytes()-beforeIpc;
   let minute=0;const samples:any[]=[];
   const budget=ioBudget;
   Object.assign(budget,{read:()=>({...readProcess("win32"),at:++minute*60000}),log:()=>{},onSample:(s:unknown)=>samples.push(s),systemOverloaded:()=>null});
   const produce=(payload:number)=>{
    const code=`const {loadDescriptor}=await import('./server/sentinel/paths.ts');const {SentinelFileWriter}=await import('./server/sentinel/file-receipts.ts');const {scannerNative}=await import('./server/sentinel/io-meter.ts');const d=loadDescriptor(${JSON.stringify(join(outputRoot,"descriptor.json"))});if(!d.ok)throw Error('fixture descriptor');const a=scannerNative(),read=()=>{const s=a.ioMeterSnapshot();return {bytes:s.total,known:s.known};};const w=SentinelFileWriter.begin(d.value,read);if(!w)throw Error('fixture admission');a.ioMeterAdd('sentinel-fixture',${payload});if(!w.finish(read,true))throw Error('fixture seal');`;
    execFileSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",code],{env:process.env});
   };
   budget.tick();produce(0);budget.tick();
   const control=sampleSentinelFileIo(()=>null).snapshot,known=ioMeterCoverageKnown(control.known),desktopControl=desktopIoCovered();
   produce(1234);const measured=budget.tick();const duplicate=budget.tick();
   const directory=new ReceiptDirectory(dirPath),originalRead=directory.api.sentinelIoRead;let admissionReceiptReads=0;
   directory.api.sentinelIoRead=(...args)=>{admissionReceiptReads++;return originalRead(...args);};
   try{for(let n=0;n<1000;n++)budget.noteForegroundActivity();}finally{directory.api.sentinelIoRead=originalRead;directory.close();}
   owned.invalidateChildIo();
   const otherGap=ioMeterCoverageKnown(true);
   return {native:read().known,known,desktopControl,control,measured,duplicate,samples,duplicateIpc,otherGap,admissionReceiptReads};
  }
  if(kind==="concurrent"){
   sample();const writer=SentinelFileWriter.begin(descriptor,read,()=>wall)!;
   const before=read().bytes,loser=SentinelFileWriter.begin(descriptor,read,()=>wall);
   const after=read().bytes;writer.finish(read,true,()=>wall);
   return {loser:loser!==null,writes:after-before,receipt:record()};
  }
  const cold=sample();
  if(kind==="boot")return cold;
  cycle();const first=sample();
  if(kind==="baseline")return {cold,first,receipt:record()};
  if(kind==="capture-once"){let calls=0;const r=receiver.sample(()=>{calls++;});return {known:r.snapshot.known,calls};}
  if(kind==="sample-time"){
   const directory=new ReceiptDirectory(dirPath),original=directory.api.sentinelIoRead;
   directory.api.sentinelIoRead=(h,max)=>{const bytes=original(h,max);if(max===4096){wall+=5;mono+=5;}return bytes;};
   try{return receiver.sample(()=>({at:wall}));}finally{directory.api.sentinelIoRead=original;directory.close();}
  }
  if(kind==="projection"){
   const projected=join(root,"projected-home"),inputRoot=join(projected,"health");
   const view={...descriptor,installationRoot:projected,inputRoot,sources:sourcePaths(inputRoot)};
   if(!writeDescriptor(view).ok)throw Error("FIXTURE_PROJECTED_DESCRIPTOR");
   const server=new SentinelFileReceiver(data,()=>wall,()=>mono),before=server.sample(()=>null).snapshot;
   // The producer's bind mount names these same receipt files. This fixture
   // exercises only the server's absent namespace view, as locateSentinel does.
   cycle();const after=server.sample(()=>null).snapshot;
   return {before,after,projectedExists:fs.existsSync(projected)};
  }

  if(kind==="child-flag"){
   const writer=SentinelFileWriter.begin(descriptor,read,()=>wall)!,before=fs.readdirSync(outputRoot).sort();
   const result=spawnSync(process.execPath,["--experimental-strip-types",entry,join(outputRoot,"descriptor.json"),"--once"],{encoding:"utf8",env:{...process.env,MURAGE_SENTINEL_CHILD:"1",MURAGE_IO_GENERATION:"fixture-unattached"}});
   const unchanged=JSON.stringify(fs.readdirSync(outputRoot).sort())===JSON.stringify(before);
   writer.finish(read,true,()=>wall);return {code:result.status,stdout:result.stdout,unchanged};
  }
  if(kind==="probe"){
   const log=join(data,"fixture-probe-output"),fd=fs.openSync(log,"wx",0o600);
   let code:number|null=null;
   try{const result=spawnSync(process.execPath,["--experimental-strip-types",entry,join(outputRoot,"descriptor.json"),"--check-install"],{env:process.env,stdio:["ignore",fd,"pipe"]});code=result.status;}finally{fs.closeSync(fd);}
   return {code,outputBytes:fs.statSync(log).size,receipt:record()};
  }
  if(kind==="cli"){
   const child=execFileSync(process.execPath,["--experimental-strip-types",entry,join(outputRoot,"descriptor.json"),"--once"],{encoding:"utf8",env:process.env});
   return {output:child,receipt:record()};
  }
  if(kind==="darwin-floor"){
   const meter=await import("../sentinel/io-meter.ts"),platform=Object.getOwnPropertyDescriptor(process,"platform")!;
   const native=api as typeof api&{diskWritten?:()=>number|null},old=native.diskWritten,floor=Math.max(read().bytes,process.resourceUsage().fsWrite*512)+123456;
   try{native.diskWritten=()=>floor;Object.defineProperty(process,"platform",{value:"darwin"});const positive=meter.scannerIoCycleSample();native.diskWritten=()=>null;return {positive:positive.known,bytes:positive.bytes,floor,missing:meter.scannerIoCycleSample().known};}
   finally{Object.defineProperty(process,"platform",platform);if(old)native.diskWritten=old;else delete native.diskWritten;}
  }
  if(kind==="child-recovery"){
   const {EventEmitter}=await import("node:events"),owned=await import("../sentinel/io-child-receipts.ts"),meter=await import("../sentinel/io-meter.ts");
   const child=Object.assign(new EventEmitter(),{send:()=>{}});owned.observeChildIo(child as any,"fixture-lost-child");child.emit("exit",1,null);
   return {legacyKnown:meter.scannerIoSample().known,cycleKnown:meter.scannerIoCycleSample().known};
  }
  if(kind==="missing-final"){
   const w=SentinelFileWriter.begin(descriptor,read,()=>wall)!;
   return {sealed:w.finish(read,false,()=>wall),snapshot:sample()};
  }
  if(kind==="replace-error"){
   const w=SentinelFileWriter.begin(descriptor,read,()=>wall)!,original=api!.sentinelIoReplace!;let first=true;
   api!.sentinelIoReplace=(...args)=>{const result=original(...args);if(first){first=false;throw Error("FIXTURE_FLUSH_AFTER_REPLACE");}return result;};
   let sealed=false;try{sealed=w.finish(read,true,()=>wall);}finally{api!.sentinelIoReplace=original;}
   return {sealed,snapshot:sample(),record:record()};
  }
  if(kind==="partial-final"||kind==="late-write"){
   const w=SentinelFileWriter.begin(descriptor,read,()=>wall)!,original=api!.sentinelIoWrite!;
   api!.sentinelIoWrite=(h,bytes)=>{
    if(bytes.includes(Buffer.from('"phase":"sealed"'))){
     if(kind==="partial-final"){original(h,bytes.subarray(0,100));throw Error("FIXTURE_PARTIAL");}
     const result=original(h,bytes);api!.ioMeterAdd("sentinel-fixture-late",17);return result;
    }
    return original(h,bytes);
   };
   let sealed=false;try{sealed=w.finish(read,true,()=>wall);}finally{api!.sentinelIoWrite=original;}
   return {sealed,snapshot:sample(),record:record()};
  }

  if(kind==="delta"){
   tick();cycle(1234);const second=sample(),same=sample();return {first,second,same,total:record().totalBytes};
  }
  if(kind==="several"){
   tick();cycle(111);cycle(222);cycle(333);const second=sample(),same=sample();return {first,second,same};
  }
  if(kind==="orphan-process"){
   const writer=SentinelFileWriter.begin(descriptor,read,()=>wall)!;
   const code=`const {loadDescriptor}=await import('./server/sentinel/paths.ts');const {SentinelFileWriter}=await import('./server/sentinel/file-receipts.ts');const d=loadDescriptor(${JSON.stringify(join(outputRoot,"descriptor.json"))});const lease=SentinelFileWriter.descendant(d.value);if(!lease)process.exit(2);process.send({ready:true});process.once('message',()=>{lease.close();process.disconnect();});`;
   const child=spawn(process.execPath,["--experimental-strip-types","--input-type=module","-e",code],{env:process.env,stdio:["ignore","ignore","pipe","ipc"]});
   try{
    await new Promise<void>((resolve,reject)=>{child.once("message",()=>resolve());child.once("error",reject);child.once("exit",code=>reject(Error(`FIXTURE_ORPHAN_EXIT_${code}`)));});
    writer.close();
    const blocked=sample(),recovery=SentinelFileWriter.begin(descriptor,read,()=>wall);
    const refused=recovery===null;recovery?.close();
    child.send({stop:true});await new Promise(resolve=>child.once("exit",resolve));
    return {blocked,refused};
   }finally{writer.close();if(child.exitCode===null)child.kill("SIGKILL");}
  }
  if(kind==="active"||kind==="orphan"||kind==="contention"){
   const writer=SentinelFileWriter.begin(descriptor,read,()=>wall)!;
   const child=kind==="orphan"?SentinelFileWriter.descendant(descriptor):null;
   const blocked=sample();
   const sealed=writer.finish(read,true,()=>wall);
   const held=sample();child?.close();
   // ACTIVE recovery requires a new epoch and a fresh nonce round trip.
   tick();cycle();const recovery=sample();tick();cycle();return {blocked,held,sealed,recovery,after:sample()};
  }
  if(kind==="crash"){
   const before=record(),writer=SentinelFileWriter.begin(descriptor,read,()=>wall)!;writer.close();
   tick();cycle();const after=sample(),changed=record();tick();cycle();return {before,changed,after,handshake:sample()};
  }
  if(kind==="restart"){
   const restarted=new SentinelFileReceiver(data,()=>wall,()=>mono);
   const old=restarted.sample(()=>null).snapshot;tick();cycle(1000);const fresh=restarted.sample(()=>null).snapshot;
   tick();cycle(1000);return {old,fresh,next:restarted.sample(()=>null).snapshot};
  }
  if(kind==="stale"||kind==="future"||kind==="suspend"){
   if(kind==="stale"){wall+=180001;mono+=180001;}
   if(kind==="future")replace(r=>{r.issuedAtMs=wall+1;});
   if(kind==="suspend")wall+=60000;
   const invalid=sample();tick();cycle();return {invalid,fresh:sample()};
  }
  if(kind.startsWith("bad-")){
   if(kind==="bad-mac"){replace(r=>{r.sequence++;});const bytes=readFileSync(join(dirPath,"receipt.json")),at=bytes.indexOf(Buffer.from('"mac":"'))+7;bytes[at]=bytes[at]===97?98:97;writeFileSync(join(dirPath,"receipt.json"),bytes);}
   if(kind==="bad-short")writeFileSync(join(dirPath,"receipt.json"),"{}");
   if(kind==="bad-nonce")replace(r=>{r.serverNonce="a".repeat(32);});
   if(kind==="bad-id")replace(r=>{r.installationId="a".repeat(32);});
   if(kind==="bad-digest")replace(r=>{r.descriptorDigest="a".repeat(64);});
   if(kind==="bad-entry")replace(r=>{r.entryDigest="a".repeat(64);});
   if(kind==="bad-revision")replace(r=>{r.scheduleRevision++;});
   if(kind==="bad-sequence")replace(r=>{r.sequence=0;});
   if(kind==="bad-counter")replace(r=>{r.totalBytes=0;});
   if(kind==="bad-epoch")replace(r=>{r.epoch="a".repeat(32);});
   if(kind==="bad-key")writeFileSync(join(dirPath,"key"),Buffer.alloc(32));
   if(kind==="bad-request"){writeFileSync(join(dirPath,"request.json"),"{}");const w=SentinelFileWriter.begin(descriptor,read,()=>wall)!;w.finish(read,true,()=>wall);}
   if(kind==="bad-native")replace(r=>{r.known=false;});
   return {first,bad:sample()};
  }
  if(kind.startsWith("fs-")){
   const path=join(dirPath,"receipt.json");
   if(kind==="fs-missing")rmSync(path);
   if(kind==="fs-request")rmSync(join(dirPath,"request.json"));
   if(kind==="fs-permissions")chmodSync(path,0o666);
   if(kind==="fs-directory")chmodSync(dirPath,0o755);
   if(kind==="fs-parent")chmodSync(data,0o777);
   if(kind==="fs-hardlink")linkSync(path,join(root,"other"));
   if(kind==="fs-link"){renameSync(path,join(root,"other"));symlinkSync(join(root,"other"),path);}
   if(kind==="fs-denied")chmodSync(path,0);
   return {first,bad:sample()};
  }
  if(kind==="codec"){
   const d=new ReceiptDirectory(dirPath),key=d.read("key",32),r=record();d.close();
   const encoded=encodeReceipt(r,key),text=encoded.toString().trimEnd();
   const bad=[encoded.subarray(1),Buffer.concat([encoded,Buffer.from("x")]),Buffer.from(text.replace('"v":1','"v":1,"v":1').padEnd(4096)),Buffer.from(text.replace('"v":1','"v":1,"extra":0').padEnd(4096)),Buffer.from(text.replace('"sequence":2','"sequence":9007199254740992').padEnd(4096))];
   return {size:encoded.length,valid:decodeReceipt(encoded,key).phase,rejected:bad.map(b=>{try{decodeReceipt(b,key);return false;}catch{return true;}})};
  }
  if(kind==="no-regen"){
   rmSync(join(dirPath,"key"));return {provisioned:provisionFileReceipts(data,{legacyExcluded:true}),known:sample().known};
  }
  if(kind==="cost"||kind==="cost-1k"||kind==="cost-100k"){
   if(kind!=="cost"){
    const history=new DatabaseSync(join(data,"fixture-history.db"));
    try{history.exec("CREATE TABLE messages(id INTEGER PRIMARY KEY,body TEXT)");history.prepare("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO messages SELECT x,'fixture' FROM n").run(kind==="cost-1k"?1000:100000);}finally{history.close();}
    for(let n=0;n<(kind==="cost-1k"?2:25);n++)cycle(1);
   }

   const d=new ReceiptDirectory(dirPath),original=d.api.sentinelIoRead;let reads=0,bytes=0;
   d.api.sentinelIoRead=(h,max)=>{const b=original(h,max);reads++;bytes+=b.length;return b;};
   const samples=[],enumerate=fs.readdirSync;fs.readdirSync=(()=>{throw Error("FIXTURE_RECEIPT_ENUMERATION");}) as typeof fs.readdirSync;syncBuiltinESMExports();
   try{for(let i=0;i<5;i++){reads=0;bytes=0;samples.push({...sample(),reads,bytes});}}finally{d.api.sentinelIoRead=original;fs.readdirSync=enumerate;syncBuiltinESMExports();d.close();}
   return samples;
  }
  throw Error("FIXTURE_SCENARIO");
 }finally{safeWipeSync(root);}
}
