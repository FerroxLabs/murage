// SPDX-License-Identifier: AGPL-3.0-or-later
// MAIN RULING 1114-SCPERF-RECEIPT. Both protocol owners: scperf-p2.
import {it,expect,beforeAll,afterAll} from "vitest";
import {execFileSync} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
let root:string;
beforeAll(()=>{root=mkdtempSync(join(tmpdir(),"sentinel-default-native-"));execFileSync("cc",["-std=c11","-D_GNU_SOURCE","-O2","-Wall","-Werror","-fPIC","-shared","-DNAPI_VERSION=9","-I",resolve(dirname(process.execPath),"../include/node"),"native/engine-exclusion/exclusion.c","native/engine-exclusion/meter.c","-o",join(root,"engine-exclusion.node")]);});
afterAll(()=>{if(root)rmSync(root,{recursive:true,force:true});});
function run(kind:string){
 const code=`const {defaultCoverageScenario}=await import('./server/testing/sentinel-default-fixture.ts');console.log(JSON.stringify(await defaultCoverageScenario(${JSON.stringify(kind)})));`;
 return JSON.parse(execFileSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",code],{encoding:"utf8",env:{...process.env,MURAGE_RESOURCES_PATH:root}}).trim());
}
it("F18 default server boot proves no Sentinel under native exclusion, including after restart",()=>{
 expect(run("absent")).toEqual({bare:false,boot:true,restart:true,epoch:true,windowsKnown:true});
});
it("F18 transient descriptor deletion cannot resurrect an issued absence proof or a restarted receiver",()=>{
 expect(run("transient")).toEqual({bare:false,boot:true,later:false,restart:false});
});
it("F18 an unmarked legacy root cannot bootstrap absence after descriptor deletion",()=>{
 expect(run("legacy")).toEqual({bare:false,known:false,enrolled:false});
});
it("F18 uncovered IPC retires an otherwise valid zero-writer proof",()=>{
 expect(run("ipc-uncovered")).toEqual({boot:true,after:false});
});
for(const platform of ["win32","darwin","linux"])it(`F18 default Desktop ${platform} schedule policy reaches a sealed native receipt without user enrollment`,()=>{
 expect(run(`desktop-${platform}`)).toEqual({boot:true,pending:false,registration:"registered",mechanism:platform==="win32"?"task-scheduler":platform==="darwin"?"launchd":"systemd",known:true,baseline:true,ipc:false});
});
it("F18 default Cloud descriptor and once process reach a sealed native receipt without IPC",()=>{
 expect(run("cloud")).toEqual({boot:true,pending:false,known:true,baseline:true,ipc:false});
});

it("F18 an unresolved launcher location cannot issue a default absence proof",()=>{
 expect(run("unresolved")).toEqual({bare:false,known:false,enrolled:false});
});

it("F18b a machine with no Sentinel keeps the real Windows budget polling at full rate",()=>{
 expect(run("absent-budget")).toEqual({boot:true,pollScale:1,tripped:false,discontinuities:[false]});
});

it("M1 real Desktop enrollment and installation probe succeed with packaged resources",()=>{
 expect(topology("desktop-probe")).toMatchObject({registration:"registered",known:true,probe:3,enrolledBeforeProbe:true,probeWrote:true});
});
it("M1 Cloud uses its complete projected descriptor and both enrollment views",()=>{
 expect(topology("cloud-projection")).toMatchObject({boot:true,pending:false,known:true,baseline:true,projection:true,receiptReturned:true,ipc:false});
});

// Failed launches are assertion failures with a bounded diagnostic, never an
// accidentally passing absence result.
function topology(kind:string){try{return run(kind);}catch{return {scenarioFailed:true};}}
for(const platform of ["win32","darwin","linux"] as const)it(`M1 Desktop ${platform} default paths and actual scheduler definition agree`,async()=>{
 const {defaultOutputRoot,sourcePaths,validateDescriptor}=await import("./paths.ts");
 const {win32,posix}=await import("node:path");
 const modulePath="../../electron/sentinel-schedule.mjs";
 const {buildSentinelRegistration}=await import(/* @vite-ignore */ modulePath);
 const p=platform==="win32"?win32:posix,home=platform==="win32"?"C:\\Users\\Fixture":"/home/fixture";
 const id="1".repeat(32),data=p.join(home,"data"),local=p.join(home,"AppData","Local");
 const env=platform==="win32"?{LOCALAPPDATA:local}:{};
 const output=defaultOutputRoot(id,{platform,home,env})!;
 const base=platform==="win32"?local:platform==="darwin"?p.join(home,"Library","Application Support"):p.join(home,".local","state");
 expect(output).toBe(p.join(base,"MurageSentinel",id));
 const descriptor={version:1,installationId:id,installationRoot:data,inputRoot:p.join(data,"health"),outputRoot:output,
  sources:sourcePaths(p.join(data,"health"),platform),executable:{path:p.join(home,"app","Murage"),entry:p.join(output,"runtime","cli.js"),sha256:"a".repeat(64)},scheduleRevision:1};
 expect(validateDescriptor(descriptor,platform).ok).toBe(true);
 const path=p.join(output,"descriptor.json");
 const definition=buildSentinelRegistration({platform,descriptor,descriptorPath:path,home,userSid:"S-1-5-21-1-2-3-1001"});
 expect(definition.mechanism).toBe(platform==="win32"?"task-scheduler":platform==="darwin"?"launchd":"systemd");
 expect(definition.invocation.executable).toBe(descriptor.executable.path);
 expect(definition.invocation.args).toContain(path);
 expect(definition.invocation.args).toContain("--once");
 expect(definition.invocation.args.includes("--no-sandbox")).toBe(platform==="linux");
 expect(platform==="win32"?definition.xml:definition.files.map((f:{text:string})=>f.text).join("\n")).toContain(id);
});
