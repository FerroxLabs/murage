import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { setMemoryMode } from "./repository.ts";
import { createMemoryEvolutionRuntime, type EvolutionRuntimeOptions } from "./evolution-runtime.ts";
import { readMemoryEvolutionPolicy } from "./evolution-policy.ts";
import { procedureCandidateHash, procedureSnapshotDigest, procedureTargetDigest, type ProcedureEvaluationReceipt } from "./procedure-review.ts";
import type { MemoryExtractionDispatch, TextOnlyExtractor } from "./extract.ts";
import { memoryOwnerRoute } from "./settings.ts";

const hash=(value:unknown)=>procedureCandidateHash(JSON.stringify(value));
beforeEach(()=>{vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});setMemoryMode("capture");});
afterEach(()=>vi.useRealTimers());
const scriptedEvaluation:NonNullable<EvolutionRuntimeOptions["evaluate"]>=async(snapshot,options,signal)=>{
  // Controller fixture only: real objective selector and lease, scripted
  // candidate/receipt. Actual GEPA subprocess proof belongs to its named tests.
  options.assertCurrent(snapshot);const response=await options.reflect("Synthetic recall feedback",signal);expect(response.costUsd).toBeNull();
  const candidate=/^```\n([\s\S]*)\n```$/.exec(response.text)![1];
  const baseline=await options.evaluate(options.seedInstruction,options.corpus.holdout,signal),selected=await options.evaluate(candidate,options.corpus.holdout,signal);
  const average=(scores:number[])=>scores.reduce((a,b)=>a+b,0)/scores.length;
  const regressions=selected.evaluation.scores.filter((score,index)=>score<baseline.evaluation.scores[index]).length;
  const receipt:ProcedureEvaluationReceipt={id:`scripted:${snapshot.requestId}`,requestId:snapshot.requestId,targetDigest:procedureTargetDigest(snapshot.target),snapshotDigest:procedureSnapshotDigest(snapshot),evidenceDigest:snapshot.evidenceDigest,candidate,candidateHash:procedureCandidateHash(candidate),evaluator:"scripted-runtime-fixture",corpusDigest:hash(options.corpus),decision:candidate===options.seedInstruction?"no-change":"accepted",heldout:{corpusDigest:hash([options.corpus.id,options.corpus.version,options.corpus.groupBy,options.corpus.holdout]),untouched:true,cases:options.corpus.holdout.length,baseline:average(baseline.evaluation.scores),candidate:average(selected.evaluation.scores),regressions},budgetRespected:true,cancelled:false};
  return receipt;
};
function fixture(){
  let fingerprint="configuration-one",available=true,selected:string|null="qualified-model-one",noChange=false;
  const extractor:TextOnlyExtractor=vi.fn(async(_text:string,maximum:number,_signal:AbortSignal,dispatch?:MemoryExtractionDispatch)=>{expect(maximum).toBe(2000);expect(dispatch?.purpose).toBe("reflection");expect(Object.isFrozen(dispatch?.messages)).toBe(true);const policy=readMemoryEvolutionPolicy();return "```\n"+JSON.stringify({extraction:policy.extraction,retrieval:{semanticBandRatio:noChange?policy.retrieval.semanticBandRatio:0.7,rareFacetDivisor:4}})+"\n```";});
  const options:EvolutionRuntimeOptions={availabilityIdentity:()=>fingerprint,modelIdentity:()=>selected,
    worker:vi.fn(()=>available?{available:true as const,command:{executable:"/synthetic/worker",args:[],cwd:DATA_DIR,expectedPythonVersion:"3.13.15"},workerDigest:"a".repeat(64)}:{available:false as const,reason:"GEPA_RESOURCE_UNAVAILABLE"}),
    resolveExtractor:vi.fn(()=>extractor),evaluate:vi.fn(scriptedEvaluation)};
  return {options,extractor,runtime:createMemoryEvolutionRuntime(options),fingerprint:(value:string)=>{fingerprint=value;},available:(value:boolean)=>{available=value;},selected:(value:string|null)=>{selected=value;},unchanged:()=>{noChange=true;}};
}
const signal=()=>new AbortController().signal;
it("requires owner authorization, selects only shipped synthetic corpus, and never repeats after completion or rollback",async()=>{
  const f=fixture();expect(()=>f.runtime.authorize({})).toThrow("MEMORY_OWNER_REQUIRED");
  const authorized=f.runtime.authorize(ownerMemoryTicket()),id=authorized.job!.id;expect(authorized.corpus).toMatchObject({id:"memory-recall-groups",version:"1",kind:"synthetic"});
  await f.runtime.run(id,signal());expect(f.runtime.status().job).toMatchObject({status:"complete",decision:"accepted"});expect(readMemoryEvolutionPolicy().retrieval.semanticBandRatio).toBe(0.7);
  const revision=readMemoryEvolutionPolicy().revision;f.runtime.rollback(ownerMemoryTicket(),revision,"baseline");expect(readMemoryEvolutionPolicy().revision).not.toBe("baseline");
  expect(f.runtime.authorize(ownerMemoryTicket()).job!.id).toBe(id);expect(f.runtime.pending()).toBeUndefined();expect(f.options.evaluate).toHaveBeenCalledTimes(1);
});
it("completes a genuine no-change result without scheduling another run",async()=>{
  const f=fixture();f.unchanged();const id=f.runtime.authorize(ownerMemoryTicket()).job!.id;await f.runtime.run(id,signal());expect(f.runtime.status().job).toMatchObject({status:"complete",decision:"no-change"});expect(readMemoryEvolutionPolicy().revision).toBe("baseline");expect(f.runtime.pending()).toBeUndefined();
});
it("waits for missing resources without key reads or repeated hashing, then reconsiders changed configuration",async()=>{
  const f=fixture();f.available(false);const id=f.runtime.authorize(ownerMemoryTicket()).job!.id;await f.runtime.run(id,signal());
  expect(f.runtime.status().job).toMatchObject({status:"waiting",started:false,reason:"GEPA_RESOURCE_UNAVAILABLE"});for(let n=0;n<4;n++){f.runtime.status();expect(f.runtime.pending()).toBeUndefined();}
  expect(f.options.worker).toHaveBeenCalledTimes(1);expect(f.options.resolveExtractor).not.toHaveBeenCalled();
  f.available(true);f.fingerprint("configuration-two");expect(f.runtime.pending()).toBe(id);await f.runtime.run(id,signal());expect(f.runtime.status().job!.status).toBe("complete");
});
it("reconsiders initially missing resources on fresh boot without minting a new grant or job",async()=>{
  const f=fixture();f.available(false);const id=f.runtime.authorize(ownerMemoryTicket()).job!.id;await f.runtime.run(id,signal());closeDatabase();
  const resumed=createMemoryEvolutionRuntime(f.options);expect(resumed.pending()).toBe(id);expect(resumed.status().job!.id).toBe(id);
});
it("refuses USD caps without a trusted reflection ceiling before any worker or model invocation",async()=>{
  const f=fixture();database().exec("UPDATE memory_learning_config SET settings=json_set(settings,'$.dailyCostUsd',1),revision=revision+1");const id=f.runtime.authorize(ownerMemoryTicket()).job!.id;await f.runtime.run(id,signal());
  expect(f.runtime.status().job).toMatchObject({status:"waiting",started:false,reason:"GEPA_COST_AUTHORITY_REQUIRED"});expect(f.options.worker).not.toHaveBeenCalled();expect(f.extractor).not.toHaveBeenCalled();
});
it("requires explicit retry for a started uncertain evaluation and blocks changed runtime identity",async()=>{
  const f=fixture();f.options.evaluate=vi.fn(async()=>{throw Error("GEPA_CALL_UNCERTAIN");});const id=f.runtime.authorize(ownerMemoryTicket()).job!.id;await f.runtime.run(id,signal());
  expect(f.runtime.status().job).toMatchObject({status:"deferred",started:true,reason:"GEPA_CALL_UNCERTAIN"});expect(f.runtime.pending()).toBeUndefined();
  f.fingerprint("changed-worker-configuration");f.runtime.retry(ownerMemoryTicket(),id);await f.runtime.run(id,signal());expect(f.runtime.status().job).toMatchObject({status:"blocked",reason:"MEMORY_EVOLUTION_RUNTIME_CHANGED"});expect(f.options.evaluate).toHaveBeenCalledTimes(1);
});
it("recovers an already published retained receipt after interrupted acknowledgement without reevaluation",async()=>{
  const f=fixture(),id=f.runtime.authorize(ownerMemoryTicket()).job!.id;await f.runtime.run(id,signal());const published=readMemoryEvolutionPolicy().revision;
  database().prepare("UPDATE memory_scope_bindings SET intent=json_set(intent,'$.status','running','$.expiresAt',0) WHERE id=?").run(id);closeDatabase();
  const resumed=createMemoryEvolutionRuntime(f.options);expect(resumed.pending()).toBe(id);await resumed.run(id,signal());expect(resumed.status().job!.status).toBe("complete");expect(readMemoryEvolutionPolicy().revision).toBe(published);expect(f.options.evaluate).toHaveBeenCalledTimes(1);
});
it("exposes owner actions through the existing memory API without changing configure semantics",async()=>{
  const f=fixture(),ticket=ownerMemoryTicket(),roster={bots:[],groups:[]};
  const result=await memoryOwnerRoute("/api/memory/action",{action:"evolution-authorize"},ticket,roster,{evolution:f.runtime});expect(result).toHaveProperty("job.status","pending");
  await expect(memoryOwnerRoute("/api/memory/action",{action:"evolution-authorize",corpus:"private"},ticket,roster,{evolution:f.runtime})).rejects.toThrow("INVALID_MEMORY_ARGUMENTS");
  await expect(memoryOwnerRoute("/api/memory/action",{action:"evolution-rollback",expectedRevision:"stale",targetRevision:"baseline"},ticket,roster,{evolution:f.runtime})).rejects.toMatchObject({message:"MEMORY_EVOLUTION_CONFLICT",status:409});
});
it("keeps recall and classification authorization and status separate while using the real classification parser",async()=>{
  const f=fixture(),ticket=ownerMemoryTicket(),original=readMemoryEvolutionPolicy();f.runtime.authorize(ticket);
  f.options.resolveExtractor=()=>async(text,_maximum,_signal,dispatch)=>{
    if(dispatch?.purpose==="reflection")return "```\n"+JSON.stringify({extraction:{classificationGuidance:"Use exact explicit source labels."},retrieval:original.retrieval})+"\n```";
    if(!dispatch?.messages[0].content.includes("Use exact explicit source labels."))return "[]";
    const labels=text.split("\n").filter(line=>line.startsWith("Owner statement:")||line.startsWith("Owner correction:")||line.startsWith("Owner invitation to fictional characterization:"));
    return JSON.stringify(labels.map(line=>{const quote=line.slice(line.indexOf(":")+2),startByte=Buffer.byteLength(text.slice(0,text.indexOf(quote)));return {text:quote,quote,startByte,endByte:startByte+Buffer.byteLength(quote),claimType:line.startsWith("Owner invitation")?"character-canon":"owner-statement",update:line.startsWith("Owner correction")};}));
  };
  const authorized=f.runtime.authorize(ticket,"classification");expect(f.runtime.status().authorized).toBe(true);expect(f.runtime.status("classification").authorized).toBe(true);
  await f.runtime.run(authorized.job!.id,signal());expect(f.runtime.status("classification").job).toMatchObject({status:"complete",decision:"accepted"});expect(f.runtime.status().corpus.id).toBe("memory-recall-groups");expect(f.runtime.status().job!.status).toBe("pending");
  expect(readMemoryEvolutionPolicy().retrieval).toEqual(original.retrieval);expect(readMemoryEvolutionPolicy().extraction.classificationGuidance).toBe("Use exact explicit source labels.");
});
