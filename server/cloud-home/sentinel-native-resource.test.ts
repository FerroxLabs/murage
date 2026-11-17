// SPDX-License-Identifier: AGPL-3.0-or-later
// Image resource producer and receipt consumer owner: scperf-p2. OS qualification: MAIN.
import {it,expect} from "vitest";
import {execFileSync} from "node:child_process";
import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";

it("H1 Cloud image build installs the native resource used by default boot and the scanner",()=>{
 const root=mkdtempSync(join(tmpdir(),"cloud-native-resource-"));
 try{
  const image=readFileSync("deploy/cloud-home/build-image.sh","utf8");
  const command=image.split("\n").filter(line=>/^node scripts\/build-cloud-engine-exclusion\.mjs$/.test(line));
  expect(command).toHaveLength(1);
  expect(image.indexOf(command[0])).toBeLessThan(image.indexOf("# Home-only pins:"));
  mkdirSync(join(root,"scripts"));
  cpSync("scripts/build-cloud-engine-exclusion.mjs",join(root,"scripts/build-cloud-engine-exclusion.mjs"));
  cpSync("native/engine-exclusion",join(root,"native/engine-exclusion"),{recursive:true});
  execFileSync("bash",["-euc",command[0]],{cwd:root,env:process.env});
  const resources=join(root,"resources");
  expect(existsSync(join(resources,"engine-exclusion.node"))).toBe(true);
  const unit=readFileSync("deploy/cloud-home/murage-sentinel.service","utf8");
  expect(unit.split("\n")).toContain("Environment=MURAGE_RESOURCES_PATH=/opt/murage/resources");
  const code=`const {exclusionAddonPath,loadExclusionAddon}=await import('./server/engine-exclusion.ts');
const {defaultCoverageScenario}=await import('./server/testing/sentinel-default-fixture.ts');
console.log(JSON.stringify({loaded:!!loadExclusionAddon(),path:exclusionAddonPath(),absent:await defaultCoverageScenario('absent')}));`;
  const result=JSON.parse(execFileSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",code],{
   cwd:resolve("."),encoding:"utf8",env:{...process.env,MURAGE_RESOURCES_PATH:resources,MURAGE_PACKAGED:"1",MURAGE_ENGINE_EXCLUSION_PATH:undefined,OMB_RESOURCES_PATH:undefined},
  }));
  expect(result.loaded).toBe(true);
  expect(result.path).toBe(join(resources,"engine-exclusion.node"));
  expect(result.absent).toEqual({bare:false,boot:true,restart:true,epoch:true,windowsKnown:true});
  const scanCode=`const {defaultCoverageScenario}=await import('./server/testing/sentinel-default-fixture.ts');console.log(JSON.stringify(await defaultCoverageScenario('cloud-projection')));`;
  const scanned=JSON.parse(execFileSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",scanCode],{
   encoding:"utf8",env:{...process.env,MURAGE_RESOURCES_PATH:resources,MURAGE_PACKAGED:"1",MURAGE_ENGINE_EXCLUSION_PATH:undefined,OMB_RESOURCES_PATH:undefined},
  }));
  expect(scanned).toEqual({boot:true,pending:false,known:true,baseline:true,projection:true,receiptReturned:true,ipc:false});
 }finally{rmSync(root,{recursive:true,force:true});}
},30000);
