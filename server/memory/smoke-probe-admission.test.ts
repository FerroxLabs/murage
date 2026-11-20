// SPDX-License-Identifier: AGPL-3.0-or-later
// Probe-side permit answerer owner: intelsmoke (scripts/smoke-memory-packaged.mjs). Real worker/ticket consumer owner: scperf-p1.
// The packaged memory smoke forks the real worker and is its only parent. Since background byte grants are enforced the worker
// writes its index only under a parent permit; a parent that never answers leaves MemoryIndex's first schema transaction
// deferred forever and "initialised" never comes (release rehearsals 44461021954 and 44537735532, macOS Intel, 120 s timeout,
// no worker output). These run the real worker with the probe's own answerer, and without it.
import { fork, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname,join,resolve } from "node:path";
import { afterAll,beforeAll,expect,it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { database,closeDatabase } from "../database.ts";
import { forgetExclusionAddon } from "../engine-exclusion.ts";
import { resetIoMeterForTest } from "../io-meter.ts";
import { answerHelperProtocol } from "../../scripts/smoke-memory-packaged.mjs";
const root=mkdtempSync(join(tmpdir(),"smoke-probe-admission-"));
const binary=join(root,"meter.node"),prior=process.env.MURAGE_ENGINE_EXCLUSION_PATH;
beforeAll(()=>{
 execFileSync("cc",["-std=c11","-D_GNU_SOURCE","-O2","-Wall","-Werror","-fPIC","-shared","-DNAPI_VERSION=9","-I",resolve(dirname(process.execPath),"../include/node"),"native/engine-exclusion/exclusion.c","native/engine-exclusion/meter.c","-o",binary],{stdio:"pipe"});
 process.env.MURAGE_ENGINE_EXCLUSION_PATH=binary;forgetExclusionAddon();resetIoMeterForTest();
 mkdirSync(DATA_DIR,{recursive:true});database();
});
afterAll(()=>{closeDatabase();if(prior===undefined)delete process.env.MURAGE_ENGINE_EXCLUSION_PATH;else process.env.MURAGE_ENGINE_EXCLUSION_PATH=prior;forgetExclusionAddon();resetIoMeterForTest();rmSync(root,{recursive:true,force:true});});

function helper(name:string,answer:boolean){
 const queue:Array<Record<string,unknown>>=[],seen:string[]=[],settled:Array<{id:unknown;used:number}>=[];
 let wake:(()=>void)|undefined,stderr="",exitCode:number|null|undefined;
 const child:ChildProcess=fork(resolve("server/memory/worker.ts"),[],{execArgv:["--experimental-strip-types"],stdio:["ignore","ignore","pipe","ipc"],env:{...process.env,NODE_ENV:"test",MURAGE_DATA_DIR:DATA_DIR,MURAGE_ENGINE_EXCLUSION_PATH:binary}});
 const exited=new Promise<void>(done=>child.once("exit",code=>{exitCode=code;wake?.();done();}));
 child.stderr!.on("data",data=>{stderr=(stderr+String(data)).slice(-2000);});
 child.on("message",raw=>{
  const m=raw as Record<string,unknown>;seen.push(String(m.type));
  if(answer&&answerHelperProtocol(child,m,settled))return;
  queue.push(m);wake?.();
 });
 async function event(type:string,timeout:number,requestId?:string):Promise<Record<string,unknown>|undefined>{
  const end=Date.now()+timeout;
  for(;;){
   const n=queue.findIndex(m=>m.type===type&&(requestId===undefined||m.requestId===requestId));if(n>=0)return queue.splice(n,1)[0]!;
   if(exitCode!==undefined)throw new Error(`FIXTURE_HELPER_EXIT:${exitCode}:${stderr}`);
   if(Date.now()>end)return undefined;
   await new Promise<void>(done=>{const timer=setTimeout(fin,100);function fin(){wake=undefined;clearTimeout(timer);done();}wake=fin;});
  }
 }
 const init=()=>child.send({type:"init",authorityPath:join(DATA_DIR,"messages.db"),indexPath:join(root,`${name}.db`),modelDirectory:join(root,"model"),manifest:{model:"fixture",revision:"1",dimensions:1,files:[]}});
 const stop=async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill("SIGKILL");await exited;}};
 return {child,event,init,stop,seen,settled,stderr:()=>stderr};
}

it("with the smoke probe's answers a real worker initialises a fresh index, indexes and settles every permit within its grant",async()=>{
 const h=helper("answered",true);
 try{
  expect(await h.event("ready",30000),"worker ready").toBeDefined();
  h.init();
  const initialised=await h.event("initialised",60000);
  expect(initialised,`initialised within 60 s; worker sent ${h.seen.join(",")}; ${h.stderr()}`).toBeDefined();
  expect(h.seen,"the fresh index asked its parent for a permit (the path the smoke never answered)").toContain("bg-grant-request");
  const records=Array.from({length:3},(_,row)=>({id:`fixture-${row}`,version:1,scopeId:"fixture-scope",text:`fixture alpha ${row}`,deleted:false}));
  h.child.send({type:"index",requestId:"batch",records});
  const result=await h.event("index-result",60000,"batch");
  expect(result,`index-result; worker sent ${h.seen.slice(-20).join(",")}; ${h.stderr()}`).toBeDefined();
  expect((result!.records as unknown[]).length,"every record acknowledged").toBe(3);
  expect(h.settled.length,"each permit's receipt came back").toBeGreaterThan(0);
  for(const receipt of h.settled)expect(Number.isFinite(receipt.used)&&receipt.used>=0,"a receipt names its used bytes").toBe(true);
 }finally{await h.stop();}
},120000);

it("the rehearsal failure: a parent that answers no permit request never sees initialised, and the worker says nothing",async()=>{
 const h=helper("unanswered",false);
 try{
  expect(await h.event("ready",30000),"worker ready").toBeDefined();
  h.init();
  expect(await h.event("initialised",8000),"no initialised without a permit").toBeUndefined();
  expect(h.seen,"the worker is waiting on its permit").toContain("bg-grant-request");
 }finally{await h.stop();}
},60000);
