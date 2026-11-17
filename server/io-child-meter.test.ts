// SPDX-License-Identifier: AGPL-3.0-or-later
import {execFileSync} from "node:child_process";
import {chmodSync,copyFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";
import {afterAll,beforeAll,expect,it} from "vitest";
import {windowsHideBundlePlugin} from "../scripts/windows-hide-bundle-plugin.mjs";
import {windowsHideImport} from "../shared/win-hide-child-process.mjs";
let root:string,binary:string,bundleRoot:string;
beforeAll(async()=>{
 root=mkdtempSync(join(tmpdir(),"owned-node-meter-"));binary=join(root,"engine-exclusion.node");
 execFileSync("cc",["-std=c11","-D_GNU_SOURCE","-O2","-Wall","-Werror","-fPIC","-shared","-DNAPI_VERSION=9","-I",resolve(dirname(process.execPath),"../include/node"),"native/engine-exclusion/exclusion.c","native/engine-exclusion/meter.c","-o",binary],{stdio:"pipe"});
 bundleRoot=join(root,"server");
 // Match the shipped ESM/CommonJS bridge and runtime siblings, including
 // every independent output that inlines the murage-exec reader.
 const built=await build({entryPoints:["io-child-meter.ts","io-child-bootstrap.ts","testing/io-owned-child.fixture.ts"].map(p=>resolve("server",p)),outbase:resolve("server"),outdir:bundleRoot,bundle:true,platform:"node",format:"esm",target:"node24",logLevel:"silent",metafile:true,
  plugins:[windowsHideBundlePlugin()],
  banner:{js:windowsHideImport+'import { createRequire as __harnessRequire } from "node:module"; const require = __harnessRequire(import.meta.url);'}});
 for(const [out,meta] of Object.entries(built.metafile.outputs))if(out.endsWith(".js")&&meta.inputs["server/drivers/murage-exec.ts"]){
  const target=join(dirname(out),"murage-exec");copyFileSync(resolve("server/drivers/murage-exec"),target);chmodSync(target,0o755);
 }
});
afterAll(()=>{if(root)rmSync(root,{recursive:true,force:true});});
function probe(api:string,mode:string,packaged=false){
 const code=`import cp from 'node:child_process';import fs from 'node:fs';
 const meter=await import(${JSON.stringify(pathToFileURL(packaged?join(bundleRoot,"io-child-meter.js"):resolve("server/io-child-meter.ts")).href)});
 const receipts=await import(${JSON.stringify(pathToFileURL(resolve("server/sentinel/io-child-receipts.ts")).href)});
 meter.registerOwnedChildForTest('testing/io-owned-child.fixture');meter.installChildProcessMeter();
 const dir=fs.mkdtempSync(${JSON.stringify(join(tmpdir(),"owned-node-fixture-"))});
 try{const entry=${JSON.stringify(packaged?join(bundleRoot,"testing/io-owned-child.fixture.js"):resolve("server/testing/io-owned-child.fixture.ts"))};
 const logFd=${JSON.stringify(mode)}==='file-log'?fs.openSync(dir+'/diagnostic.log','w'):null;
 const options={env:{...process.env,...(${JSON.stringify(mode)}==='spoofed'?{MURAGE_IO_GENERATION:'fixture-stale'}:{})},stdio:['ignore','pipe','pipe','ipc']};let child;
 if(logFd!==null)options.stdio=['ignore','pipe',logFd,'ipc'];
 if(${JSON.stringify(mode)}==='launcher')child=cp.spawn(process.execPath,['--experimental-strip-types',${JSON.stringify(resolve('server/job-launcher.ts'))},'--',process.execPath,'-e',"process.stdout.write('unexpected-launch')"],{...options,stdio:['ignore','pipe','pipe','pipe','ipc']});
 else if(${JSON.stringify(api)}==='fork')child=cp.fork(entry,[dir,${JSON.stringify(mode)}],{...options,execArgv:['--experimental-strip-types']});
 else child=cp[${JSON.stringify(api)}](process.execPath,['--experimental-strip-types',entry,dir,${JSON.stringify(mode)}],options);
 const seen=[];let summary,err='',stdout='';child.stderr?.on('data',c=>err+=c);child.stdout?.on('data',c=>stdout+=c);
 child.on('message',m=>{if(m.type==='io')seen.push(m);if(m.type==='fixture-summary')summary=m;});
 const status=await new Promise((ok,no)=>{child.on('error',no);child.on('exit',(code,signal)=>ok({code,signal}));});
 const diagnostic=logFd===null?'':fs.readFileSync(dir+'/diagnostic.log','utf8');if(logFd!==null)fs.closeSync(logFd);
 console.log('RESULT '+JSON.stringify({status,seen,summary,err,stdout,diagnostic,total:receipts.ownedChildIoBytes(),known:receipts.ownedChildIoKnown(),classes:meter.childIoCensusSnapshot()}));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}`;
 const output=execFileSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",code],{encoding:"utf8",timeout:15_000,env:{...process.env,NODE_ENV:"test",MURAGE_ENGINE_EXCLUSION_PATH:binary}});
 return JSON.parse(output.split("\n").find(line=>line.startsWith("RESULT "))!.slice(7));
}
it.each(["spawn","fork","execFile"])("T12 %s owned Node launch counts raw and routed writes once and returns a final receipt",api=>{
 const result=probe(api,"explicit");
 expect(result.err).not.toMatch(/Error:/);expect(result.status).toEqual({code:0,signal:null});
 expect(result.summary.snapshot.buckets.find(([name]:[string,number])=>name==="ordinary-files")?.[1],"raw and routed writes must be counted exactly once").toBe(25);
 expect(result.seen.at(-1)?.final,"owned Node must finish its receipt handshake").toBe(true);
 expect(result.known).toBe(true);expect(result.total).toBeGreaterThanOrEqual(25);expect(result.classes.OWNED_NODE).toBe(1);
});
it("T12 a one-shot owned Node process can naturally exit after its final acknowledgement",()=>{
 const result=probe("spawn","natural");expect(result.status.code).toBe(0);expect(result.known).toBe(true);expect(result.seen.at(-1)?.final).toBe(true);
});
it("T12 foreign browser, connector and speech programs use the explicit excluded class",async()=>{
 const {classifyChildIo}=await import("./io-child-meter.ts");
 for(const command of ["fixture-browser","fixture-connector","fixture-speech"])
  expect(classifyChildIo(command,[resolve("server/index.ts")])).toBe("ENGINE_EXCLUDED");
 expect(classifyChildIo(process.execPath,[resolve("server/index.ts")])).toBe("OWNED_NODE");
 expect(classifyChildIo(process.execPath,[resolve("server/new-helper.ts")])).toBe("UNMAPPED_NODE");
 expect(classifyChildIo(process.execPath,["/fixture/foreign-entry.js"])).toBe("ENGINE_EXCLUDED");
 expect(classifyChildIo(process.execPath,["/fixture/foreign-entry.js",resolve("server/index.ts")])).toBe("ENGINE_EXCLUDED");
});

it("T12 nested owned children receive fresh generations and contribute their final receipts",()=>{
 const result=probe("fork","nested");expect(result.status.code).toBe(0);expect(result.known).toBe(true);
 expect(result.summary.nestedFinal.final).toBe(true);
 expect(result.summary.nestedFinal.generation).not.toBe(result.seen.at(-1).generation);
 expect(result.seen.at(-1).final).toBe(true);expect(result.total).toBeGreaterThanOrEqual(50);
});
it("T12 foreign children do not inherit the owned receipt generation or preload",()=>{
 const result=probe("fork","foreign");expect(result.status.code).toBe(0);expect(result.known).toBe(true);
 expect(result.summary.foreign).toEqual({generation:false,child:false,preload:false});
});

it("T12 separate packaged entry bundles share raw methods and charge each write once",()=>{
 const result=probe("fork","explicit",true);expect(result.status.code,result.err).toBe(0);expect(result.known).toBe(true);
 expect(result.summary.snapshot.buckets.find(([name]:[string,number])=>name==="ordinary-files")?.[1],"preload and bundled entry must share pristine methods").toBe(25);
 expect(result.seen.at(-1)?.final).toBe(true);expect(result.classes.OWNED_NODE).toBe(1);
});
it("T12 packaged nested children share the receipt ledger across independent bundles",()=>{
 const result=probe("fork","nested",true);expect(result.status.code,result.err).toBe(0);expect(result.known).toBe(true);
 expect(result.summary.nestedFinal.final).toBe(true);expect(result.summary.nestedFinal.generation).not.toBe(result.seen.at(-1).generation);
 expect(result.seen.at(-1).ioBytes).toBeGreaterThanOrEqual(result.summary.nestedFinal.ioBytes+25);
});

it("T12 a metered launcher closed before its frame sends a final receipt and starts no command",()=>{
 const result=probe("spawn","launcher");expect(result.status).toEqual({code:0,signal:null});
 expect(result.stdout,"closed stdin must never fall through into command dispatch").toBe("");
 expect(result.err).not.toMatch(/Error:/);expect(result.known).toBe(true);expect(result.seen.at(-1)?.final).toBe(true);
});

it("T12 an arbitrary generation in launch options cannot bypass owned receipts",()=>{
 const result=probe("spawn","spoofed");expect(result.status.code).toBe(0);expect(result.known).toBe(true);
 expect(result.seen.at(-1)?.final).toBe(true);expect(result.seen.at(-1)?.generation).not.toBe("fixture-stale");
 expect(result.summary.snapshot.buckets.find(([name]:[string,number])=>name==="ordinary-files")?.[1]).toBe(25);
});

it("T12 a regular-file census report is counted before the child seals its final receipt",()=>{
 const result=probe("fork","file-log");expect(result.status.code).toBe(0);expect(result.known).toBe(true);
 const report=result.diagnostic.split("\n").find((line:string)=>line.startsWith("[io-census] "));
 expect(report,"the run must report its foreign child class").toContain('"ENGINE_EXCLUDED":1');
 expect(result.seen.at(-1).ioBytes,"the final receipt must include its own diagnostic write").toBeGreaterThanOrEqual(result.summary.snapshot.total+Buffer.byteLength(report+"\n"));
});
it("T12 cold owned launch proves preload and final receipts even without inherited IPC setup",()=>{
 const code=`import {spawn} from 'node:child_process';
 const hooks=await import(${JSON.stringify(new URL('./io-child-meter.ts',import.meta.url).href)}).catch(()=>({}));
 hooks.registerOwnedChildForTest?.('testing/io-proxy.fixture');hooks.installChildProcessMeter?.();
 const child=spawn(process.execPath,[${JSON.stringify(resolve('server/testing/io-proxy.fixture.ts'))},${JSON.stringify(root)}],{stdio:['pipe','pipe','pipe','ipc']});
 const messages=[];let output='',error='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>error+=c);child.on('message',m=>{if(m.type==='io')messages.push(m);});child.stdin.end('request\\n');
 const status=await new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));
 console.log(JSON.stringify({status,output,error,messages}));`;
 const result=JSON.parse(execFileSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",code],{encoding:"utf8",timeout:15_000,env:{...process.env,NODE_ENV:"test",MURAGE_ENGINE_EXCLUSION_PATH:binary}}).trim());
 expect(result.status,result.error).toEqual({code:0,signal:null});expect(result.output).toBe("fixture response\n");
 expect(result.messages.at(-1)?.final,"an owned launch must install its preload and seal a final receipt").toBe(true);
 expect(result.messages.at(-1).ioBytes).toBeGreaterThanOrEqual(8192);
});
it("T12 the metering final acknowledgement does not revoke an owned proxy release channel",()=>{
 const code=`import {spawn} from 'node:child_process';
 const hooks=await import(${JSON.stringify(new URL('./io-child-meter.ts',import.meta.url).href)});
 hooks.registerOwnedChildForTest('testing/io-proxy.fixture');hooks.installChildProcessMeter();
 const child=spawn(process.execPath,[${JSON.stringify(resolve('server/testing/io-proxy.fixture.ts'))},${JSON.stringify(root)},'release-ipc'],{stdio:['pipe','pipe','pipe','ipc']});
 let final,release,error='';child.stdout.resume();child.stderr.on('data',c=>error+=c);child.on('message',m=>{if(m.type==='io'&&m.final)final=m;if(m.type==='fixture-release')release=m;});child.stdin.end('request\\n');
 const status=await new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));
 console.log(JSON.stringify({status,error,final,release}));`;
 const result=JSON.parse(execFileSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",code],{encoding:"utf8",timeout:15_000,env:{...process.env,NODE_ENV:"test",MURAGE_ENGINE_EXCLUSION_PATH:binary}}).trim());
 expect(result.status,result.error).toEqual({code:0,signal:null});expect(result.final?.final).toBe(true);
 expect(result.release,"a metering acknowledgement must leave the application release channel open").toEqual({type:"fixture-release",sealed:false,code:0});
});
