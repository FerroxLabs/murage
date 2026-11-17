// SPDX-License-Identifier: AGPL-3.0-or-later
import {readFileSync,readdirSync,mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {expect,it} from "vitest";
import {launchCalls} from "./testing/io-census.ts";
import * as meter from "./io-meter.ts";
// Production import sites are pinned independently of the implementation's classifier.
function childSites(root:string):string[]{
 const sites:string[]=[];
 for(const entry of readdirSync(root,{withFileTypes:true})){
  const file=join(root,entry.name);
  if(entry.isDirectory()){
   if(!/^(testing|test-support|fixtures|node_modules|dist|field-replay)$/.test(entry.name))sites.push(...childSites(file));
  }else if(/\.(ts|mjs|cjs)$/.test(file)&&!/(?:test|fixture|mutant|bench|verify-|build-|harness|workflow-|posture-)/.test(entry.name)){
   if(/(?:from\s*|require\(\s*)["'](?:node:)?child_process["']/.test(readFileSync(file,"utf8")))sites.push(file.replaceAll("\\","/"));
  }
 }
 return sites.sort();
}
it("T12 closes the class census and maps every production child-process import site",async()=>{
 expect(meter.IO_METER_COVERAGE_GAPS,"every writer family needs a proven class").toEqual([]);
 const path="./io-child-"+"census.ts";
 const census=await import(/* @vite-ignore */ path).catch(()=>({CHILD_IO_SITES:{}}));
 const sites=[...childSites("server"),...childSites("electron"),...childSites("shared")].sort();
 expect(Object.keys(census.CHILD_IO_SITES).sort(),"a new spawn site needs an explicit census mapping").toEqual(sites);
 const calls=sites.flatMap(file=>launchCalls(file,readFileSync(file,"utf8"))).sort();
 expect(Object.keys(census.CHILD_IO_CALLS??{}).sort(),"every subprocess call needs a class route").toEqual(calls);
 for(const classes of Object.values(census.CHILD_IO_CALLS??{}))expect(classes).toEqual(expect.arrayContaining([expect.stringMatching(/^(OWNED_NODE|ENGINE_EXCLUDED)$/)]));
 for(const [site,classes] of Object.entries(census.CHILD_IO_SITES)){
  expect(classes,site).toEqual(expect.arrayContaining([expect.stringMatching(/^(OWNED_NODE|ENGINE_EXCLUDED)$/)]));
  expect((classes as string[]).every(c=>c==="OWNED_NODE"||c==="ENGINE_EXCLUDED"),site).toBe(true);
 }
 // The generated checker carries executable worker strings, not top-level
 // imports. Pin both copies to their classified producers rather than exempt
 // generated code from the complete site inventory.
 const generated="server/drivers/pi-wipe-check.generated.mjs";
 expect(census.CHILD_IO_SITES[generated]).toEqual(["ENGINE_EXCLUDED"]);
 expect(readFileSync(generated,"utf8").match(/(?:from\s*|require\(\s*)["'](?:node:)?child_process["']/g),"any additional worker import needs classification").toHaveLength(2);
 for(const [name,file] of [["mountWorkerSource","server/wipe/mounts.ts"],["pathWorkerSource","server/wipe/roots.ts"]]){
  const worker=(path:string)=>{
   const match=new RegExp(name+"\\s*=\\s*platformMountSource\\s*\\+\\s*String.raw`([\\s\\S]*?)`;").exec(readFileSync(path,"utf8"));
   expect(match,`${path} must retain its worker source`).not.toBeNull();return match![1];
  };
  expect(worker(generated)).toBe(worker(file));
  expect(launchCalls(file,worker(file))).toEqual([`${file}#execFileSync:1`]);
  expect(census.CHILD_IO_SITES[file]).toEqual(["ENGINE_EXCLUDED"]);
 }
});
it("T12 server installs copy and child hooks before its first application import",()=>{
 const source=readFileSync("server/index.ts","utf8");
 // MAIN RULING 1115-DIGEST-ADOPTED I1: Windows-hide precedes the I/O hooks;
 // both preloads still execute before the first application import.
 expect(source.split("\n").slice(0,2)).toEqual(['import "../shared/win-hide-child-process.mjs";','import "./io-copy-bootstrap.ts";']);
 const bootstrap=readFileSync("server/io-copy-bootstrap.ts","utf8");
 expect(bootstrap).toContain("installCopyMeter();");expect(bootstrap).toContain("installChildProcessMeter();");
});

import {execFileSync} from "node:child_process";
import {resolve,dirname} from "node:path";
import {tmpdir} from "node:os";
import {pathToFileURL} from "node:url";
it("T12 coverage stays unknown until both boot hooks are installed",()=>{
 const code=`const meter=await import(${JSON.stringify(pathToFileURL(resolve("server/io-meter.ts")).href)});
 const before=meter.ioMeterCoverageKnown();meter.installCopyMeter?.();const copies=meter.ioMeterCoverageKnown();
 const child=await import(${JSON.stringify(pathToFileURL(resolve("server/io-child-meter.ts")).href)});child.installChildProcessMeter();
 console.log(JSON.stringify({before,copies,complete:meter.ioMeterCoverageKnown()}));`;
 const output=execFileSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",code],{encoding:"utf8"});
 // MAIN RULING 1114-SCPERF-RECEIPT: hooks require durable coverage; retain both ordering negatives.
 expect(JSON.parse(output.trim()),"a static empty gap list alone cannot qualify a process").toEqual({before:false,copies:false,complete:false});
 const root=mkdtempSync(join(tmpdir(),"census-native-"));
 try{
  execFileSync("cc",["-std=c11","-D_GNU_SOURCE","-O2","-Wall","-Werror","-fPIC","-shared","-DNAPI_VERSION=9","-I",resolve(dirname(process.execPath),"../include/node"),"native/engine-exclusion/exclusion.c","native/engine-exclusion/meter.c","-o",join(root,"engine-exclusion.node")]);
  const sealed=`const {sealedCoverageFixture}=await import('./server/testing/sentinel-sealed-coverage.ts');const f=sealedCoverageFixture();try{${code}}finally{f.close();}`;
  const positive=execFileSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",sealed],{encoding:"utf8",env:{...process.env,MURAGE_RESOURCES_PATH:root}});
  // MAIN RULING 1114-SCPERF-RECEIPT: sealed receipt alone/copy hook alone are insufficient.
  expect(JSON.parse(positive.trim())).toEqual({before:false,copies:false,complete:true});
 }finally{rmSync(root,{recursive:true,force:true});}
});
