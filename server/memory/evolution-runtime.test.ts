import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { setMemoryMode } from "./repository.ts";
import { createMemoryEvolutionRuntime, sendGepaCall, type EvolutionRuntimeOptions } from "./evolution-runtime.ts";
import { isGepaCallNotStarted } from "../gepa-worker.ts";
import { readMemoryEvolutionPolicy } from "./evolution-policy.ts";
import { procedureCandidateHash, procedureSnapshotDigest, procedureTargetDigest, type ProcedureEvaluationReceipt } from "./procedure-review.ts";
import type { MemoryExtractionDispatch, TextOnlyExtractor } from "./extract.ts";
import { memoryOwnerRoute } from "./settings.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { bumpLearningFence } from "./authority-epoch.ts";
import { MemorySendFenced } from "./learning-send-fence.ts";
import { MemorySendBusy } from "./learning-send.ts";

const hash=(value:unknown)=>procedureCandidateHash(JSON.stringify(value));
beforeEach(()=>{vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});setMemoryMode("capture");});
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
it("rejects the retired ceiling before changing the learning configuration",async()=>{
 const {updateMemoryLearning}=await import("./learning-policy.ts");fixture();
 expect(()=>updateMemoryLearning(database(),{dailyCostUsd:1},0)).toThrow();
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


it("omits monetary accounting from an authorized evolution status",()=>{
 const f=fixture();f.runtime.authorize(ownerMemoryTicket());expect(f.runtime.status().job).not.toHaveProperty("costKnown");expect(f.runtime.status().job).not.toHaveProperty("actualCostUsd");
});

// S1 (designs/GEPA-S1-UNSENT-RELEASE.md): the real GEPA evaluator, call ledger and cost rows over the protocol fixture worker. A call the
// learning gate refuses inside its own lock is released unsent, so the owner's Retry sends it once and the job completes.
function gepaFixture(kind:"recall"|"classification"){
  const policy=readMemoryEvolutionPolicy(),sent={evaluation:0,reflection:0},seen={evaluation:0,reflection:0};
  type How="fence"|"released"|"busy"|"authority";type At="evaluation"|"reflection"|"holdout";
  let late:{how:How;purpose:At;at:number}|undefined,model="qualified-model-one";
  const rows=(prefix:string)=>database().prepare("SELECT intent FROM memory_scope_bindings WHERE subject_type='system' AND id LIKE ? ORDER BY rowid").all(`${prefix}:%`).map(row=>JSON.parse(String(row.intent)));
  const heldoutReserved=()=>rows("gepa-call").some(call=>String(call.callId).endsWith(":evaluate:holdout-baseline")&&call.state==="reserved");
  const extractor:TextOnlyExtractor=async(_text,_maximum,_signal,dispatch)=>{
    const purpose=dispatch!.purpose as "evaluation"|"reflection",gate=dispatch!.fence!;seen[purpose]++;
    if(late&&(late.purpose==="holdout"?purpose==="evaluation"&&heldoutReserved():late.purpose===purpose&&late.at===seen[purpose])){
      const how=late.how;late=undefined;
      // a counter move between the cheap check and the send: the gate itself refuses under its lock, nothing let out
      if(how==="fence"){bumpLearningFence(database());return gate.send(()=>"unreachable");}
      // the gate's own assertCurrent check fails under the lock (the model changed): also a refusal with nothing let out
      if(how==="authority"){model="qualified-model-two";return gate.send(()=>"unreachable");}
      if(how==="busy")throw new MemorySendBusy();
      gate.send(()=>undefined);throw new MemorySendFenced();
    }
    sent[purpose]++;
    if(purpose==="evaluation")return "no labelled quotes";
    return "```\n"+JSON.stringify(kind==="recall"?{extraction:policy.extraction,retrieval:{semanticBandRatio:0.7,rareFacetDivisor:4}}:{extraction:{classificationGuidance:"Use exact explicit source labels."},retrieval:policy.retrieval})+"\n```";
  };
  const options:EvolutionRuntimeOptions={availabilityIdentity:()=>"configuration-one",modelIdentity:()=>model,resolveExtractor:()=>extractor,
    worker:()=>({available:true as const,command:{executable:process.execPath,args:[resolve("server/testing/fake-gepa-worker.mjs"),"reflect"],cwd:DATA_DIR,expectedPythonVersion:"3.13.13",runAsNode:true},workerDigest:"a".repeat(64)})};
  const runtime=createMemoryEvolutionRuntime(options);
  return {runtime,sent,seen,late:(how:How,purpose:At,at=1)=>{late={how,purpose,at};},
    calls:(type:"evaluate"|"reflect")=>rows("gepa-call").filter(call=>call.kind===type).map(call=>({id:String(call.callId).split(":").slice(-2).join(":"),state:call.state})),
    costs:()=>rows("gepa-charge").map(cost=>({id:String(cost.callId).split(":").slice(-2).join(":"),confirmed:cost.confirmed,notStarted:cost.notStarted===true}))};
}
const authorized=(g:ReturnType<typeof gepaFixture>,kind:"recall"|"classification")=>g.runtime.authorize(ownerMemoryTicket(),kind).job!.id;
it("S1: a reflection the fence drops inside its gate is released unsent, and Retry sends it once and completes the job",async()=>{
  const g=gepaFixture("recall"),id=authorized(g,"recall");g.late("fence","reflection");
  await g.runtime.run(id,signal());
  expect(g.runtime.status().job).toMatchObject({status:"deferred",reason:"GEPA_CALL_NOT_STARTED"});
  expect(g.calls("reflect")).toEqual([{id:"reflect:1",state:"not-started"}]);
  expect(g.costs().find(cost=>cost.id==="reflect:1")).toEqual({id:"reflect:1",confirmed:true,notStarted:true});
  expect(g.sent.reflection).toBe(0);const evaluationsBefore=g.calls("evaluate").length;
  g.runtime.retry(ownerMemoryTicket(),id);await g.runtime.run(id,signal());
  expect(g.runtime.status().job!.status).toBe("complete");
  expect(g.sent.reflection).toBe(1);expect(g.calls("reflect")).toEqual([{id:"reflect:1",state:"complete"}]);
  expect(g.calls("evaluate").length).toBeGreaterThan(evaluationsBefore);expect(g.calls("evaluate").every(call=>call.state==="complete")).toBe(true);
  expect(g.costs().every(cost=>cost.confirmed===true)).toBe(true);
});
it("S1: an evaluation the fence drops inside its gate is released unsent; Retry replays the finished calls and sends each other call once",async()=>{
  const g=gepaFixture("classification"),id=authorized(g,"classification");g.late("fence","evaluation",2);
  await g.runtime.run(id,signal());
  expect(g.runtime.status("classification").job).toMatchObject({status:"deferred",reason:"GEPA_CALL_NOT_STARTED"});
  expect(g.calls("evaluate")).toEqual([{id:"evaluate:1",state:"complete"},{id:"evaluate:2",state:"not-started"}]);
  expect(g.costs().find(cost=>cost.id==="evaluate:2")).toEqual({id:"evaluate:2",confirmed:true,notStarted:true});
  expect(g.sent.evaluation).toBe(1);
  g.runtime.retry(ownerMemoryTicket(),id);await g.runtime.run(id,signal());
  expect(g.runtime.status("classification").job!.status).toBe("complete");
  // one model request per evaluation RPC: every completed call was sent exactly once, the dropped one included
  expect(g.calls("evaluate").every(call=>call.state==="complete")).toBe(true);expect(g.sent.evaluation).toBe(g.calls("evaluate").length);
  expect(g.sent.reflection).toBe(1);expect(g.costs().every(cost=>cost.confirmed===true)).toBe(true);
});
it("S1: a refusal after the gate let an attempt out keeps today's uncertain failure; Retry sends nothing more",async()=>{
  const g=gepaFixture("recall"),id=authorized(g,"recall");g.late("released","reflection");
  await g.runtime.run(id,signal());
  expect(g.runtime.status().job!.status).toBe("deferred");
  expect(g.calls("reflect")).toEqual([{id:"reflect:1",state:"reserved"}]);
  expect(g.costs().find(cost=>cost.id==="reflect:1")).toEqual({id:"reflect:1",confirmed:false,notStarted:false});
  g.runtime.retry(ownerMemoryTicket(),id);await g.runtime.run(id,signal());
  expect(g.runtime.status().job).toMatchObject({status:"deferred",reason:expect.stringMatching(/UNCERTAIN/)});
  expect(g.seen.reflection).toBe(1);expect(g.sent.reflection).toBe(0);expect(g.calls("reflect")).toEqual([{id:"reflect:1",state:"reserved"}]);
});
it("S1: a busy lock before any release is released unsent and Retry completes",async()=>{
  const g=gepaFixture("recall"),id=authorized(g,"recall");g.late("busy","reflection");
  await g.runtime.run(id,signal());
  expect(g.runtime.status().job).toMatchObject({status:"deferred",reason:"GEPA_CALL_NOT_STARTED"});expect(g.calls("reflect")).toEqual([{id:"reflect:1",state:"not-started"}]);
  g.runtime.retry(ownerMemoryTicket(),id);await g.runtime.run(id,signal());expect(g.runtime.status().job!.status).toBe("complete");expect(g.sent.reflection).toBe(1);
});
// its own test: the fixture's ledger and cost readers are not scoped to one job, so one job per database
it("S1: a refusal in the held-out comparison is released unsent and Retry sends only the held-out calls",async()=>{
  const c=gepaFixture("classification"),job=authorized(c,"classification");c.late("fence","holdout");
  await c.runtime.run(job,signal());
  expect(c.runtime.status("classification").job).toMatchObject({status:"deferred",reason:"GEPA_CALL_NOT_STARTED"});
  expect(c.calls("evaluate").find(call=>call.id==="evaluate:holdout-baseline")).toEqual({id:"evaluate:holdout-baseline",state:"not-started"});
  expect(c.costs().find(cost=>cost.id==="evaluate:holdout-baseline")).toEqual({id:"evaluate:holdout-baseline",confirmed:true,notStarted:true});
  const sentBefore=c.sent.evaluation;c.runtime.retry(ownerMemoryTicket(),job);await c.runtime.run(job,signal());
  expect(c.runtime.status("classification").job!.status).toBe("complete");expect(c.calls("evaluate").every(call=>call.state==="complete")).toBe(true);
  // the GEPA calls replay from the ledger: only the held-out comparison is sent on Retry
  expect(c.sent.evaluation-sentBefore).toBe(c.calls("evaluate").filter(call=>call.id.startsWith("evaluate:holdout-")).length);
});
it("S1: only a gate refusal or busy lock with nothing let out becomes a not-started call; every other error keeps its identity",async()=>{
  const gate=(released:number)=>({released}) as unknown as Parameters<typeof sendGepaCall>[0];
  for(const error of [new Error("transport closed"),Object.assign(new Error("aborted"),{name:"AbortError"}),new Error("GEPA_TIMEOUT"),new Error("commit failed")])
    await expect(sendGepaCall(gate(0),async()=>{throw error;})).rejects.toBe(error);
  for(const error of [new MemorySendFenced(),new MemorySendBusy()])await expect(sendGepaCall(gate(1),async()=>{throw error;})).rejects.toBe(error);
  for(const error of [new MemorySendFenced(),new MemorySendBusy()]){
    const thrown=await sendGepaCall(gate(0),async()=>{throw error;}).then(()=>undefined,(value:unknown)=>value);
    expect(isGepaCallNotStarted(thrown)).toBe(true);expect(thrown).not.toBe(error);
  }
  await expect(sendGepaCall(gate(0),async()=>"sent")).resolves.toBe("sent");
});
it("S1: a refusal from the gate's own authority check is released unsent, and Retry rechecks authority before sending anything",async()=>{
  const g=gepaFixture("recall"),id=authorized(g,"recall");g.late("authority","reflection");
  await g.runtime.run(id,signal());
  expect(g.runtime.status().job).toMatchObject({status:"deferred",reason:"GEPA_CALL_NOT_STARTED"});expect(g.calls("reflect")).toEqual([{id:"reflect:1",state:"not-started"}]);
  g.runtime.retry(ownerMemoryTicket(),id);await g.runtime.run(id,signal());
  expect(g.runtime.status().job).toMatchObject({status:"blocked",reason:"MEMORY_EVOLUTION_RUNTIME_CHANGED"});expect(g.seen.reflection).toBe(1);expect(g.sent.reflection).toBe(0);
});
