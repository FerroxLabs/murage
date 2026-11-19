// SPDX-License-Identifier: AGPL-3.0-or-later
// Test ticket issuer owner: scperf-p1. Real worker/VFS ticket consumer owner: scperf-p1.
import { fork, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname,join,resolve } from "node:path";
import { afterAll,beforeAll,expect,it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { database,closeDatabase } from "../database.ts";
import { forgetExclusionAddon } from "../engine-exclusion.ts";
import { resetIoMeterForTest } from "../io-meter.ts";
import { IoBudget,type AdmissionTicket } from "../io-budget.ts";
const root=mkdtempSync(join(tmpdir(),"runtime-admission-"));
const binary=join(root,"meter.node"),prior=process.env.MURAGE_ENGINE_EXCLUSION_PATH;
beforeAll(()=>{
 execFileSync("cc",["-std=c11","-D_GNU_SOURCE","-O2","-Wall","-Werror","-fPIC","-shared","-DNAPI_VERSION=9","-I",resolve(dirname(process.execPath),"../include/node"),"native/engine-exclusion/exclusion.c","native/engine-exclusion/meter.c","-o",binary],{stdio:"pipe"});
 process.env.MURAGE_ENGINE_EXCLUSION_PATH=binary;forgetExclusionAddon();resetIoMeterForTest();
});
afterAll(()=>{closeDatabase();if(prior===undefined)delete process.env.MURAGE_ENGINE_EXCLUSION_PATH;else process.env.MURAGE_ENGINE_EXCLUSION_PATH=prior;forgetExclusionAddon();resetIoMeterForTest();rmSync(root,{recursive:true,force:true});});
it("T5 T9 T20 a real helper admits a 36 MiB workload, charges boot, respects every permit, and seals on stop",async()=>{
 mkdirSync(DATA_DIR,{recursive:true});database();
 let at=0,serial=0,bootCharged=0,stopping=false,fatal:unknown;
 const b=new IoBudget({read:()=>({at,fsWriteBlocks:0,cpuMicros:0}),log:()=>{}});
 const pending=new Map<string,AdmissionTicket>(),used=new Map<number,number>();
 const boot=b.admit("BG",1024*1024)!;pending.set("fixture-boot",boot);
 const queue:Array<Record<string,unknown>>=[];
 let wake:(()=>void)|undefined,stderr="";
 const child=fork(resolve("server/memory/worker.ts"),[],{execArgv:["--experimental-strip-types"],stdio:["ignore","ignore","pipe","ipc"],env:{...process.env,NODE_ENV:"test",MURAGE_DATA_DIR:DATA_DIR,MURAGE_ENGINE_EXCLUSION_PATH:binary,MURAGE_IO_GENERATION:"fixture-generation",MURAGE_BG_BOOT:JSON.stringify({...boot,id:"fixture-boot"})}});
 let exitCode:number|null|undefined;
 const exited=new Promise<void>(resolve=>child.once("exit",code=>{exitCode=code;wake?.();resolve();}));
 const violations:string[]=[];
 child.stderr!.on("data",data=>{stderr=(stderr+String(data)).slice(-2000);});
 child.on("error",error=>{fatal=error;wake?.();});
 child.on("message",raw=>{
  try{
   const m=raw as Record<string,unknown>;
   if(m.type==="bg-grant-request"){
    if(stopping){child.send({type:"bg-grant",ticket:null,retryInMs:60000});return;}
    const ceiling=Number(m.ceiling);let ticket=b.admit("BG",ceiling);
    if(!ticket){at=(Math.floor(at/60000)+1)*60000;ticket=b.admit("BG",ceiling);}
    expect(ticket,"T5 whole helper step fits an active minute").not.toBeNull();
    const id=`fixture-permit-${++serial}`;pending.set(id,ticket!);child.send({type:"bg-grant",ticket:{...ticket,id}});return;
   }
   if(m.type==="bg-grant-settle"){
    const ticket=pending.get(String(m.id));expect(ticket,"T5 receipt names an outstanding permit").toBeDefined();
    expect(Number(m.used),"T5 actual helper bytes stay within permit").toBeLessThanOrEqual(ticket!.bytes);
    b.settle(ticket!,Number(m.used));if(m.id==="fixture-boot")bootCharged=Number(m.used);pending.delete(String(m.id));used.set(ticket!.minute,(used.get(ticket!.minute)??0)+Number(m.used));
    if((used.get(ticket!.minute)??0)>12*1024*1024)violations.push("minute-bound");
    return;
   }
   if(m.type==="index-result")expect(pending.size,"T8 checked batch returns unused permit before acknowledgement").toBe(0);
   if(m.type==="charge"){child.send({type:"charge-ack",helperRunId:m.helperRunId,fileId:m.fileId,attempt:m.attempt,granted:true});return;}
   if(m.type==="wal-drain"){child.send({type:"wal-drain-ack",requestId:m.requestId});return;}
   if(m.final===true)child.send({type:"io-final-ack",generation:m.generation,sequence:m.sequence});
   queue.push(m);wake?.();
  }catch(error){fatal=error;wake?.();}
 });
 async function event(type:string,requestId?:string):Promise<Record<string,unknown>>{
  const end=Date.now()+90000;
  for(;;){
   if(fatal)throw fatal;
   const n=queue.findIndex(m=>m.type===type&&(requestId===undefined||m.requestId===requestId));if(n>=0)return queue.splice(n,1)[0]!;
   if(exitCode!==undefined)throw new Error(`FIXTURE_HELPER_EXIT:${exitCode}:${stderr}`);
   if(Date.now()>end)throw new Error(`FIXTURE_HELPER_TIMEOUT:${type}:permits=${serial}:used=${JSON.stringify([...used])}:queued=${queue.slice(-10).map(m=>m.type).join(",")}:${stderr}`);
   await new Promise<void>(resolve=>{const timer=setTimeout(done,100);function done(){wake=undefined;clearTimeout(timer);resolve();}wake=done;});
  }
 }
 try{
  await event("ready");child.send({type:"init",authorityPath:join(DATA_DIR,"messages.db"),indexPath:join(root,"index.db"),modelDirectory:join(root,"model"),manifest:{model:"fixture",revision:"1",dimensions:1,files:[]}});
  await event("initialised");
  const text="fixture alpha beta ".repeat(3300).slice(0,60000);
  let bytes=0,total=0;
  for(let batch=0;batch<40;batch++){
   let records=Array.from({length:16},(_,row)=>({id:`fixture-${batch}-${row}`,version:1,scopeId:"fixture-scope",text,deleted:false,archived:true}));
   bytes+=records.length*Buffer.byteLength(text);total+=records.length;
   for(let retry=0;records.length;retry++){
    expect(retry,"T5 bounded batch recovery").toBeLessThan(200);
    const requestId=`batch-${batch}-${retry}`;child.send({type:"index",requestId,records});
    const result=await event("index-result",requestId);
    const committed=(result.records as unknown[]).length;
    records=records.slice(committed);
    if(records.length)await new Promise<void>(resolve=>setTimeout(resolve,50));
   }
  }
  expect(bytes,"T9 real input is at least 36 MiB").toBeGreaterThanOrEqual(36*1024*1024);
  expect(total,"T5 all rows acknowledged").toBe(640);
  await new Promise<void>(resolve=>setTimeout(resolve,300));
  stopping=true;child.send({type:"io-stop"});
  const final=await event("io");
  // Periodic io messages may precede the final one.
  let receipt=final;while(receipt.final!==true)receipt=await event("io");
  expect(receipt.ceilingMiss,"T4c runtime ceilings have zero misses").toBe(0);
  expect(Number(receipt.grantBytes),"T20 boot and runtime writes are charged").toBeGreaterThan(0);
  expect(bootCharged,"T20 actual boot writes are charged").toBeGreaterThan(0);
  expect(pending.has("fixture-boot"),"T20 boot receipt settled").toBe(false);
  expect(violations,"T5 every fake-clock minute stays within 12 MiB").toEqual([]);
  expect(used.size,"T9 workload splits across separately admitted minutes").toBeGreaterThan(1);
  await exited;expect(exitCode,"T15 graceful helper exit").toBe(0);
 }finally{
  if(child.exitCode===null&&child.signalCode===null){child.kill("SIGKILL");await exited;}
 }
},120000);
