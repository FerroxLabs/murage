// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMSAVE-1024 (review of 2a14076b5e): the capture step a memory save runs for the sources it cites has ONE bound for the whole
// save (32 slices, 250 ms with every lock wait inside it). Two ways one save could spend more than that:
//  W8 a save that comes with a live service authority ran the capture step, and the base path it then takes ran it again;
//  W9 a cited job that cannot be read (poisoned) was failed with the background lock wait and then claimed a second time with
//     the first claim's whole lock wait, whatever was left of the bound by then.
// Both enter through the shipped agent route handler; nothing works the capture queue but the save itself.
import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
import { mkdirSync } from "node:fs";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { database,closeDatabase } from "../database.ts";
import { DEFAULT_BUSY_MS } from "../db-busy.ts";
import { appendMessage } from "../message-db.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { Store } from "../store.ts";
import { serviceQueueFixture } from "../testing/service-queue-fixture.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { fixtureMemoryAccess as memoryAccess } from "../testing/recall-access-fixture.ts";
import { setMemoryMode } from "./repository.ts";
import { claimMemoryJob,publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { captureSource } from "./capture.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { memoryAgentRoute } from "./routes.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

/** The wall bound one save's capture step declares (authority.ts SAVE_CAPTURE_MS). */
const BOUND_MS=250;
afterEach(()=>{setMemoryCaptureRoster(null);vi.restoreAllMocks();});
beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});});
useOutsideStoreFixture();

function fixture(){
  const roster={bots:[{id:"bot",threadId:"thread"}],groups:[]};
  setMemoryCaptureRoster(()=>roster);reconcileMemoryRoster(roster);setMemoryMode("capture");
  appendMessage("thread",{id:"m",at:1,role:"user",origin:"desktop",kind:"text",text:"Verified source note"});
  const work=claimMemoryJob("fixture")!;publishMemoryWork(work,"fixture",captureWork(work));
  setMemoryMode("active");
  const registry=new InternalCapabilities();registry.begin("bot","thread","generation");
  const token=registry.mint({botId:"bot",threadId:"thread",generation:"generation",depth:99,kind:"memory",skillAuthoring:false});
  const context=memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);
  const bridge={search:async()=>({hits:[],vectorRows:0})};
  return {context,bridge};
}
const job=(sourceId:string)=>database().prepare("SELECT status,cursor,lease_owner,error FROM memory_jobs WHERE source_id=? AND stage='capture'").get(sourceId)!;
/** What the caller got: the route's answer, or the refusal it was given. */
const outcome=(call:Promise<unknown>)=>call.then(answer=>answer as Record<string,unknown>,error=>({refused:String((error as Error).message)}) as Record<string,unknown>);

it("W8 a save with a live service authority that ends on the owner's card runs the capture step once: 32 slices in all, not 32 twice",async()=>{
  // the real decision records and queue protocol: an authenticated owner turn at Ask, so the save's service request ends on a card
  const authority=serviceQueueFixture(new Store(()=>({instanceId:"fixture",model:"fixture"})),{persisted:true}).authorityFor("thread","bot");
  const f=fixture(),lead="I prefer tea.",text=lead+"x".repeat(24*65536-Buffer.byteLength(lead));
  for(const id of ["large-a","large-b"])captureSource(database(),{id,threadId:"thread",origin:{kind:"attended"},kind:"text",speaker:"owner",outcome:"recorded",text});
  const evidence=["large-a","large-b"].map(sourceId=>({sourceId,revision:1,startByte:0,endByte:Buffer.byteLength(lead)}));
  // the wall bound is held still, so the slice bound alone decides where the save stops
  const clock=vi.spyOn(performance,"now").mockReturnValue(performance.now());
  let saved:Record<string,unknown>;
  try{saved=await outcome(memoryAgentRoute("/api/internal/memory/save",{text:lead,evidence,idempotencyKey:"two-large"},f.context,f.bridge,undefined,null,{authority}));}finally{clock.mockRestore();}
  // 32 slices in all: 24 completed the first source, 8 are left for the second (a second run of the step would finish it)
  expect(job("large-b")).toMatchObject({status:"partial",cursor:8*65536,lease_owner:null});
  expect(job("large-a")).toMatchObject({status:"complete",cursor:24*65536});
  // and this save did take the path that used to run it twice: the owner has its card, the record waits as a candidate
  expect(saved).toMatchObject({candidateId:expect.any(String),state:"candidate",pendingReview:true});
});

it("W9 a cited job that cannot be read costs the save no lock wait beyond what is left of its bound, and is failed once",async()=>{
  const f=fixture();
  captureSource(database(),{id:"owner-line",threadId:"thread",origin:{kind:"attended"},kind:"text",speaker:"owner",outcome:"recorded",text:"placeholder"});
  // a lone surrogate escape is valid JSON but does not decode as UTF-8 once the text is read as bytes (jobs-reliability.test.ts)
  database().prepare("UPDATE memory_source_versions SET payload=? WHERE source_id='owner-line'").run('{"text":"abc \\ud800 def"}');
  const input={text:"abc",evidence:[{sourceId:"owner-line",revision:1,startByte:0,endByte:3}],idempotencyKey:"poisoned"};
  // Every write lock this save takes costs 120 ms of a clock the test owns (a busy store). Each lock wait the capture step asks
  // for is read where it is handed to SQLite (PRAGMA busy_timeout on the save's own handle) with what was left of the bound then.
  // The capture step is the run of budgeted transactions at the head of the save; it is over at the first unbudgeted one.
  let now=performance.now(),start:number|undefined,budgeted=false,over=false;
  const waits:Array<{granted:number;left:number}>=[];
  vi.spyOn(performance,"now").mockImplementation(()=>now);
  const db=database(),exec=db.exec.bind(db);
  vi.spyOn(db,"exec").mockImplementation((sql:string)=>{
    const asked=/^PRAGMA busy_timeout=(\d+)$/.exec(sql);
    if(asked&&Number(asked[1])!==DEFAULT_BUSY_MS&&!over){start??=now;budgeted=true;waits.push({granted:Number(asked[1]),left:Math.max(0,BOUND_MS-(now-start))});}
    const result=exec(sql);
    if(sql==="BEGIN IMMEDIATE"){if(start!==undefined&&!budgeted)over=true;budgeted=false;now+=120;}
    return result;
  });
  const saved=await outcome(memoryAgentRoute("/api/internal/memory/save",input,f.context,f.bridge));
  vi.restoreAllMocks();
  expect({refused:saved.refused,overBound:waits.filter(wait=>wait.granted>wait.left)}).toEqual({refused:undefined,overBound:[]});
  // the step did run and met the poisoned job: the reset, the claim, and the one transaction that failed the job
  expect(waits.map(wait=>wait.granted)).toEqual([250,130,10]);
  expect(job("owner-line")).toMatchObject({status:"failed",error:"INVALID_SOURCE_UTF8"});
});
