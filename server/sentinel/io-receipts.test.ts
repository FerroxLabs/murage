// SPDX-License-Identifier: AGPL-3.0-or-later
import {EventEmitter} from "node:events";
import type {ChildProcess} from "node:child_process";
import {expect,it,vi} from "vitest";
import {runChildScan} from "./supervisor.ts";
async function fixture(messages:Array<Record<string,unknown>>,exitCode=0){
 const child=Object.assign(new EventEmitter(),{pid:123,send:vi.fn(),kill:vi.fn()}) as unknown as ChildProcess;
 const note=vi.fn(),unknown=vi.fn();let generation:string|undefined;
 const promise=runChildScan({execPath:process.execPath,args:[],env:{}},{
  spawnChild:spec=>{generation=spec.env.MURAGE_IO_GENERATION;return child;},
  onIo:note,onIoUnknown:unknown,
 } as Parameters<typeof runChildScan>[1]);
 for(const message of messages)child.emit("message",{type:"io",ioProtocol:1,generation,sequence:1,fsWriteBlocks:16,ioBytes:4096,known:true,final:false,...message});
 child.emit("exit",exitCode,null);await promise;
 return {child,note,unknown,generation};
}
it("T11 Sentinel consumes its final cumulative receipt and acknowledges the exact generation and sequence",async()=>{
 const f=await fixture([{final:true}]);
 expect(f.note,"Sentinel final receipt must reach the parent's accounting").toHaveBeenCalledWith({blocks:16,bytes:4096,final:true});
 expect(f.child.send).toHaveBeenCalledWith({type:"io-final-ack",generation:f.generation,sequence:1});
 expect(f.unknown).not.toHaveBeenCalled();
});
it.each([NaN,Infinity,-1,0.5,Number.MAX_SAFE_INTEGER+1])("T11 invalid Sentinel counters (%s) invalidate coverage without acknowledging a forged final",async ioBytes=>{
 const f=await fixture([{ioBytes,final:true}]);
 expect(f.unknown,"invalid counters must invalidate Sentinel coverage").toHaveBeenCalled();
 expect(f.note).not.toHaveBeenCalled();expect(f.child.send).not.toHaveBeenCalled();
});
it("T11 decreasing Sentinel counters invalidate coverage and retain the earlier floor",async()=>{
 const f=await fixture([{}, {sequence:2,ioBytes:2048,final:true}]);
 expect(f.unknown,"decreasing counters must invalidate Sentinel coverage").toHaveBeenCalled();
 expect(f.note).toHaveBeenCalledTimes(1);expect(f.note).toHaveBeenCalledWith({blocks:16,bytes:4096,final:false});
 expect(f.child.send).not.toHaveBeenCalled();
});
it("T11 an unconfirmed Sentinel exit invalidates coverage",async()=>{
 const f=await fixture([{}]);expect(f.unknown,"an exit without a sealed final is not measured zero").toHaveBeenCalled();
});

import {execFileSync} from "node:child_process";
import {mkdtempSync,rmSync,mkdirSync,copyFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {beforeAll,afterAll} from "vitest";
import {makeInstall,cleanupFixtures} from "./scan-fixtures.ts";
let nativeRoot:string;
beforeAll(()=>{
 nativeRoot=mkdtempSync(join(tmpdir(),"sentinel-meter-native-"));
 execFileSync("cc",["-std=c11","-D_GNU_SOURCE","-O2","-Wall","-Werror","-fPIC","-shared","-DNAPI_VERSION=9","-I",resolve(dirname(process.execPath),"../include/node"),"native/engine-exclusion/exclusion.c","native/engine-exclusion/meter.c","-o",join(nativeRoot,"engine-exclusion.node")],{stdio:"pipe"});
});
afterAll(()=>{cleanupFixtures();if(nativeRoot)rmSync(nativeRoot,{recursive:true,force:true});});
it("T11 a real isolated Sentinel publishes, seals, and returns native bytes before exit",async()=>{
 const fixture=makeInstall(),receipts:Array<{blocks:number;bytes:number;final:boolean}>=[],unknown=vi.fn();
 const result=await runChildScan({execPath:process.execPath,
  args:["--experimental-strip-types",resolve("server/sentinel/cli.ts"),fixture.descriptorPath,"--once"],
  env:{MURAGE_SENTINEL_CHILD:"1",MURAGE_RESOURCES_PATH:nativeRoot},
 },{onIo:r=>receipts.push(r),onIoUnknown:unknown});
 expect(result.code,"real Sentinel fixture must publish successfully").toBe(0);
 expect(receipts.at(-1)?.final,"real Sentinel must send a sealed final receipt").toBe(true);
 expect(receipts.at(-1)?.bytes,"SQLite and publication writes need a nonzero native receipt").toBeGreaterThan(4096);
 expect(unknown).not.toHaveBeenCalled();
});

it("T11 a crash after a final receipt still invalidates coverage and retains its byte floor",async()=>{
 const f=await fixture([{final:true}],1);
 expect(f.note).toHaveBeenCalledWith({blocks:16,bytes:4096,final:true});
 expect(f.unknown,"a nonzero exit cannot certify a sealed owned process").toHaveBeenCalled();
});

it("T11 a staged scanner finds its native meter beside the installed interpreter without resource environment",()=>{
 const runtime=join(nativeRoot,"runtime"),resources=join(runtime,"resources");mkdirSync(resources,{recursive:true});
 copyFileSync(join(nativeRoot,"engine-exclusion.node"),join(resources,"engine-exclusion.node"));
 const code=`Object.defineProperty(process,'execPath',{value:${JSON.stringify(join(runtime,"fixture-node"))}});
 Object.defineProperty(process,'platform',{value:'win32'});
 const meter=await import(${JSON.stringify(pathToFileURL(resolve("server/sentinel/io-meter.ts")).href)});
 meter.writeFileSync(${JSON.stringify(join(nativeRoot,"staged-publication"))},'abc');console.log(JSON.stringify(meter.scannerIoSample()));`;
 const env={...process.env};delete env.MURAGE_RESOURCES_PATH;delete env.OMB_RESOURCES_PATH;
 const output=execFileSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",code],{encoding:"utf8",env});
 expect(JSON.parse(output.trim()),"staging must not turn a packaged scanner's native reading into UNKNOWN").toEqual({blocks:0,bytes:3,known:true});
});
