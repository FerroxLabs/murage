import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { updateMemoryLearning, readMemoryLearning } from "./learning-policy.ts";
import { extractCandidates, groundMemoryClaim, parseMemoryExtractionCandidates, withMemoryInferenceLease, type MemoryInferenceLease } from "./extract.ts";
beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});reconcileMemoryRoster({bots:[{id:"bot",threadId:"thread"}],groups:[]});});
const signal=()=>new AbortController().signal;
const messages=()=>[{role:"system",content:"Classify source assertions"},{role:"user",content:"Source text"}];
it("rolls back the shared reservation and never dispatches when durable attribution fails",async()=>{
  const provider=vi.fn(async()=>"[]");
  await expect(withMemoryInferenceLease(async lease=>lease.request(provider,"Source",100,signal(),messages()),{
    charged:()=>{throw new Error("attribution-write-failed");},refused:()=>{},
  })).rejects.toThrow("attribution-write-failed");
  expect(provider).not.toHaveBeenCalled();
  expect(database().prepare("SELECT 1 FROM memory_scope_bindings WHERE subject_id='extract-budget'").get()).toBeUndefined();
  expect((await withMemoryInferenceLease(async lease=>lease.request(provider,"Source",100,signal(),messages()))).status).toBe("complete");
  expect(provider).toHaveBeenCalledTimes(1);
});
it("reports refused requests without a reservation and retains charges on transport failure",async()=>{
  const charged=vi.fn(),refused=vi.fn();
  await withMemoryInferenceLease(async lease=>{
    expect(await lease.request(null,"Source",100,signal(),messages(),"reflection")).toMatchObject({reason:"extractor-unavailable"});
    expect(charged).not.toHaveBeenCalled();
    expect(refused).toHaveBeenCalledWith("extractor-unavailable","reflection");
    await expect(lease.request(async()=>{throw new Error("transport-uncertain");},"Source",100,signal(),messages())).rejects.toThrow("transport-uncertain");
  },{charged,refused});
  const ledger=JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE subject_id='extract-budget'").get()!.intent));
  expect(charged).toHaveBeenCalledTimes(1);
  expect(charged.mock.calls[0][1]).toMatchObject({purpose:"evaluation",input:ledger.input,output:ledger.output});
  expect(ledger.calls).toBe(1);
});
it("one lease owns the existing slot for the whole cycle and refuses overlapping calls before inference",async()=>{
  let release!:()=>void,ready!:()=>void;const started=new Promise<void>(resolve=>ready=resolve),gate=new Promise<void>(resolve=>release=resolve);let calls=0;
  const held=withMemoryInferenceLease(async lease=>{
    const first=lease.request(async()=>{calls++;ready();await gate;return "[]";},"Source",2000,signal(),messages());
    const second=await lease.request(async()=>{calls++;return "[]";},"Source",2000,signal(),messages());expect(second).toEqual({status:"notStarted",reason:"request-busy"});return first;
  });
  await started;
  try{
    expect(await withMemoryInferenceLease(async()=>"must not run")).toEqual({status:"notStarted",reason:"extractor-busy"});
    expect(await extractCandidates("source",async()=>"[]",signal())).toMatchObject({status:"deferred",reason:"extractor-busy"});
    const grounding=Object.assign(async()=>"[]",{ground:async()=>'{"supported":true}'});
    expect((await groundMemoryClaim({text:"a",quote:"a",claimType:"owner-statement",speaker:"owner",outcome:"recorded"},grounding,signal())).reason).toBe("grounding-busy-or-cancelled");
  }finally{release();await held;}
  expect(calls).toBe(1);expect((await extractCandidates("source",async()=>"[]",signal())).status).toBe("complete");
});
it("quota, cancellation, and USD pricing refusals are typed not-started outcomes with no provider call",async()=>{
  const provider=vi.fn(async()=>"[]");
  await withMemoryInferenceLease(async lease=>{
    expect(await lease.request(provider,"Source",2001,signal(),messages())).toEqual({status:"notStarted",reason:"invalid-input"});
    const cancelled=new AbortController();cancelled.abort();expect(await lease.request(provider,"Source",100,cancelled.signal,messages())).toEqual({status:"notStarted",reason:"cancelled"});
    updateMemoryLearning(database(),{dailyCostUsd:1},readMemoryLearning(database()).revision);
    expect(await lease.request(provider,"Source",100,signal(),messages())).toEqual({status:"notStarted",reason:"cost-estimate-unavailable"});
    updateMemoryLearning(database(),{dailyCostUsd:null,callsPerMinute:0},readMemoryLearning(database()).revision);
    expect(await lease.request(provider,"Source",100,signal(),messages())).toEqual({status:"notStarted",reason:"budget-exhausted"});
  });expect(provider).not.toHaveBeenCalled();
  expect(database().prepare("SELECT 1 FROM memory_scope_bindings WHERE subject_id='extract-budget'").get()).toBeUndefined();
});
it("reflection uses the same durable quota and frozen framed messages with its separate output cap",async()=>{
  const supplied=messages();let seen:any;
  const result=await withMemoryInferenceLease(async lease=>{
    const work=lease.request(async(_text,maximum,_signal,dispatch)=>{seen={maximum,dispatch};return "reflection";},"Source",8000,signal(),supplied,"reflection");
    supplied[0]!.content="Mutated after submission";return work;
  });
  expect(result).toMatchObject({status:"complete",value:{status:"complete",text:"reflection"}});expect(seen.maximum).toBe(8000);expect(seen.dispatch.purpose).toBe("reflection");expect(seen.dispatch.messages[0].content).toBe("Classify source assertions");expect(Object.isFrozen(seen.dispatch.messages)).toBe(true);
  const row=database().prepare("SELECT intent FROM memory_scope_bindings WHERE subject_id='extract-budget'").get()!;const budget=JSON.parse(String(row.intent));expect(budget.output).toBe(8000);expect(budget.input).toBe(Buffer.byteLength(JSON.stringify(seen.dispatch.messages)));expect(budget.calls).toBe(1);
});
it("network failures remain thrown and a released lease cannot start another request",async()=>{
  let retained!:MemoryInferenceLease;
  await expect(withMemoryInferenceLease(async lease=>{retained=lease;return lease.request(async()=>{throw Error("network uncertain");},"Source",100,signal(),messages());})).rejects.toThrow("network uncertain");
  const provider=vi.fn(async()=>"[]");expect(await retained.request(provider,"Source",100,signal(),messages())).toEqual({status:"notStarted",reason:"lease-closed"});expect(provider).not.toHaveBeenCalled();
  expect((await withMemoryInferenceLease(async()=>"released")).status).toBe("complete");
});
it("an abort bounds an ignoring extractor while its unresolved transport keeps the shared slot quarantined",async()=>{
  let resolve!: (value:string)=>void;const transport=new Promise<string>(done=>resolve=done),controller=new AbortController();
  const held=withMemoryInferenceLease(async lease=>{const work=lease.request(()=>transport,"Source",100,controller.signal,messages());controller.abort(Error("fixture abort"));return work;});
  try{await expect(held).rejects.toThrow("fixture abort");expect(await withMemoryInferenceLease(async()=>"must not overlap")).toEqual({status:"notStarted",reason:"extractor-busy"});}
  finally{resolve("settled");await transport;await Promise.resolve();}
  expect((await withMemoryInferenceLease(async()=>"released")).status).toBe("complete");
});
it("pure objective parsing preserves exact UTF-8 spans and never activates records",()=>{
  const text="ส่งแล้ว",raw=JSON.stringify([{text,quote:text,startByte:0,endByte:Buffer.byteLength(text),claimType:"observation"}]);
  const before=database().prepare("SELECT count(*) AS count FROM memory_records").get()!.count;
  expect(parseMemoryExtractionCandidates(text,raw)[0]!.quote).toBe(text);
  expect(()=>parseMemoryExtractionCandidates(text,JSON.stringify([{text,quote:text,startByte:1,endByte:Buffer.byteLength(text)}]))).toThrow("ungrounded span");
  expect(database().prepare("SELECT count(*) AS count FROM memory_records").get()!.count).toBe(before);
});
