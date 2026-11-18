// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer and consumer owner: scperf-p2-rd2. Fixtures never use application data.
import {it,expect,beforeAll,afterAll} from "vitest";
import {execFileSync} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
let nativeRoot:string;
beforeAll(()=>{nativeRoot=mkdtempSync(join(tmpdir(),"sentinel-regression-native-"));execFileSync("cc",["-std=c11","-D_GNU_SOURCE","-O2","-Wall","-Werror","-fPIC","-shared","-DNAPI_VERSION=9","-I",resolve(dirname(process.execPath),"../include/node"),"native/engine-exclusion/exclusion.c","native/engine-exclusion/meter.c","-o",join(nativeRoot,"engine-exclusion.node")]);});
afterAll(()=>{if(nativeRoot)rmSync(nativeRoot,{recursive:true,force:true});});
function run(body:string){
 const root=mkdtempSync(join(tmpdir(),"sentinel-regression-"));
 try{
  return JSON.parse(execFileSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",`
   import {mkdirSync,writeFileSync,rmSync} from 'node:fs';
   import {join} from 'node:path';
   const root=${JSON.stringify(root)},data=join(root,'data');mkdirSync(data,{mode:0o700});
   process.env.MURAGE_DATA_DIR=data;process.env.MURAGE_SENTINEL_STATE_DIR=join(root,'state');
   const {sentinelInstallationId}=await import('./shared/sentinel-installation.mjs');
   const {defaultOutputRoot}=await import('./server/sentinel/paths.ts');
   const output=defaultOutputRoot(sentinelInstallationId(data)),descriptor=join(output,'descriptor.json');
   const {installCopyMeter,ioMeterCoverageKnown,ioMeterTotal}=await import('./server/io-meter.ts');
   const {installChildProcessMeter}=await import('./server/io-child-meter.ts');
   installCopyMeter();installChildProcessMeter();
   if(ioMeterTotal()===null)throw Error("fixture consumer requires its valid native-meter control");
   const {desktopIoReceiver,desktopIoCovered}=await import('./server/io-desktop-receipts.ts');
   const receiver=desktopIoReceiver(()=>{}),generation='fixture-generation';
   const attach=()=>{receiver.accept({type:'launch',generation});receiver.accept({type:'sample',generation,message:{type:'io',ioProtocol:1,generation,sequence:1,fsWriteBlocks:0,ioBytes:0,known:true,final:true}});};
   ${body}
  `],{encoding:"utf8",env:{...process.env,MURAGE_RESOURCES_PATH:nativeRoot}}).trim());
 }finally{rmSync(root,{recursive:true,force:true});}
}
it("H1 transient descriptor between consumer readings cannot prove quiescence",()=>{
 expect(run(`const first=ioMeterCoverageKnown();mkdirSync(output,{recursive:true});writeFileSync(descriptor,'{}');rmSync(descriptor);console.log(JSON.stringify([first,ioMeterCoverageKnown()]));`)).toEqual([false,false]);
});
it("H1 receiver restart during a scan cannot infer absence from a removed descriptor",()=>{
 expect(run(`mkdirSync(output,{recursive:true});writeFileSync(descriptor,'{}');rmSync(descriptor);console.log(JSON.stringify(ioMeterCoverageKnown()));`)).toBe(false);
});
it("H1 uncovered without descriptor remains UNKNOWN",()=>{
 expect(run(`receiver.accept({type:'uncovered'});console.log(JSON.stringify(ioMeterCoverageKnown()));`)).toBe(false);
});
it("H2 retained scheduler and attached fallback cannot qualify a partial writer set",()=>{
 expect(run(`mkdirSync(output,{recursive:true});writeFileSync(descriptor,'{}');receiver.accept({type:'uncovered'});attach();console.log(JSON.stringify(ioMeterCoverageKnown()));`)).toBe(false);
});
it("inventory independently enumerates nested scanner spawn and Linux autostart",async()=>{
 const {SENTINEL_LAUNCHERS}=await import("./io-sentinel-launchers.ts");
 const {sentinelLauncherAudit}=await import("./testing/sentinel-launcher-audit.ts");
 for(const route of ["autostart","scan-child","probe"]){
  expect(SENTINEL_LAUNCHERS.some(row=>row.route===route)).toBe(true);
  const result=sentinelLauncherAudit(SENTINEL_LAUNCHERS.filter(row=>row.route!==route));
  expect(result.unmapped.length).toBeGreaterThan(0);
 }
});
it("H2 real scheduler readback restores the old task while attached fallback coverage remains UNKNOWN",()=>{
 expect(run(`
  const boundary=await import('./server/health/host-boundary.ts');
  const {reconcileSentinelRegistration,writeRegistrationRecord}=await import('./electron/sentinel-schedule.mjs');
  const entry=(await import('node:path')).resolve('server/sentinel/cli.ts');
  const id=sentinelInstallationId(data);
  const current={version:1,installationId:id,installationRoot:data,inputRoot:join(data,'health'),outputRoot:output,sources:boundary.sourcePaths(join(data,'health')),executable:{path:process.execPath,entry,sha256:null},scheduleRevision:1};
  mkdirSync(join(root,'state'),{recursive:true,mode:0o700});
  if(!boundary.ensureOutputRoot(output).ok||!boundary.writeDescriptor(current).ok)throw Error('fixture descriptor');
  writeRegistrationRecord(output,{installationId:id,state:'registered',mechanism:'systemd',revision:1,registeredAt:1,provenAt:null,current:{...current.executable,revision:1},previous:null,reason:null});
  const installed=[];
  const provider={install:async d=>{installed.push(d.scheduleRevision);},read:async()=>({registered:true,mechanism:'systemd',executable:process.execPath,args:[entry,descriptor,'--once'],owner:null,revision:1,lastResult:0})};
  const result=await reconcileSentinelRegistration({platform:'linux',installationId:id,installationRoot:data,outputRoot:output,executable:process.execPath,entrySource:entry,provider,boundary,probe:async()=>0});
  receiver.accept({type:'uncovered'});attach();
  console.log(JSON.stringify({reason:result.reason,restored:installed.length===2&&installed[1]===1,covered:ioMeterCoverageKnown()}));
 `)).toEqual({reason:"readback",restored:true,covered:false});
});

it("H2 legacy coverage export also refuses a partial attached writer set",()=>{
 expect(run(`mkdirSync(output,{recursive:true});writeFileSync(descriptor,'{}');receiver.accept({type:'uncovered'});attach();console.log(JSON.stringify([ioMeterCoverageKnown(),desktopIoCovered()]));`)).toEqual([false,false]);
});
