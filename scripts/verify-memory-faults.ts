// P10 fault/load runner. Every case gets its own marked OS-temp profile and
// exact child-process handles. No shared app, provider credentials or paid calls.
// --out PATH runs the complete frozen F01-F12 set, including the 600-second
// workload. Internal --case/--probe modes require a parent-created fixture mark.
import assert from "node:assert/strict";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { backup, DatabaseSync } from "node:sqlite";
import { validateCorpus, requireMeasuredHit } from "../server/memory/testing/contracts.ts";

const self=fileURLToPath(import.meta.url),repo=fileURLToPath(new URL("..",import.meta.url)),argv=process.argv.slice(2);
const arg=(name:string,fallback="")=>{const i=argv.indexOf(name);if(i<0)return fallback;const value=argv[i+1];if(!value||value.startsWith("--"))throw Error(`Missing ${name}`);return value;};
const sleep=(ms:number)=>new Promise(done=>setTimeout(done,ms));
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
type Result={id:string;status:"PASS"|"FAIL"|"UNVERIFIED";observations:Record<string,unknown>;limitations?:string[];error?:string};
const caseObservations:Record<string,unknown>={};
const fixtureMark="murage-p10-owned-fault-fixture-v1";
const normalUseProfile={id:"N01",durationMs:120000,sourceUpdates:20,updateTimesMs:Array.from({length:20},(_,i)=>i<4?0:(i-3)*6000),concurrentReaders:4,readerPauseMs:12000,
  activeChunks:2000,retainedRecords:4000,updateBytes:256,bots:20,heldTurns:8,drainDeadlineMs:60000,
  datasetBasis:"Observed1523 source chunks rounded to2000;3915message rows rounded to4000;217-byte median text rounded to256. Prior oversized N01 result preserved.",
  limits:{semanticP95Ms:200,semanticP99Ms:400,optionalDeadlineMs:500,mainEventLoopP99Ms:20,mainRssIncreaseBytes:128*1024**2,workerPeakRssBytes:1024**3},
  observedUsageEvidence:".planning/memory-evidence/normal-use-observed-usage.json"};
const shutdown=new Set<()=>Promise<void>>();
process.once("SIGTERM",()=>{void (async()=>{for(const close of [...shutdown].reverse())try{await close();}catch{/* parent preserves timeout evidence */}process.exit(143);})();});
const percentile=(values:number[],fraction:number)=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*fraction)-1]:null;
async function until<T>(name:string,read:()=>T|undefined|Promise<T|undefined>,timeout=15000):Promise<T>{
  const end=Date.now()+timeout;for(;;){const value=await read();if(value!==undefined)return value;if(Date.now()>=end)throw Error(`Timed out: ${name}`);await sleep(50);}
}
async function terminate(child:ChildProcess,signal:NodeJS.Signals="SIGKILL"){
  if(child.exitCode!==null||child.signalCode!==null)return;
  await new Promise<void>((done,reject)=>{const timer=setTimeout(()=>reject(Error("Owned child did not exit")),10000);child.once("exit",()=>{clearTimeout(timer);done();});child.kill(signal);});
}
function spawnProbe(root:string,mode:string,model:string,subdir="data"){
  const child=fork(self,["--fixture-root",root,"--probe",mode,"--database-subdir",subdir,"--model-directory",model],{execArgv:["--experimental-strip-types"],cwd:root,
    env:{HOME:root,USERPROFILE:root,TMPDIR:root,PATH:dirname(process.execPath),...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})},stdio:["ignore","pipe","pipe","ipc"]});
  const messages:any[]=[];let output="";child.on("message",message=>messages.push(message));
  const cleanup=()=>terminate(child);shutdown.add(cleanup);child.once("exit",()=>shutdown.delete(cleanup));
  child.stdout?.on("data",data=>{output=(output+data).slice(-12000);});child.stderr?.on("data",data=>{output=(output+data).slice(-12000);});
  return {child,wait:(type:string)=>until(type,()=>{const message=messages.find(message=>message?.type===type);if(message)return message;if(child.exitCode!==null||child.signalCode!==null)throw Error(`Probe exited: ${output}`);return undefined;},30000)};
}

async function runCase(id:string,root:string,model:string):Promise<Result>{
  if(id==="F10"||id==="N01")return runServerLoad(root,model,id==="N01");
  const {database,transaction,closeDatabase}=await import("../server/database.ts");
  const mdb=await import("../server/message-db.ts");
  const {setMemoryMode}=await import("../server/memory/repository.ts");
  const {reconcileMemoryRoster,ensureScope,memoryAccess}=await import("../server/memory/policy.ts");
  const {InternalCapabilities}=await import("../server/internal-capabilities.ts");
  const {claimMemoryJob,publishMemoryWork,heartbeatMemoryJob}=await import("../server/memory/jobs.ts");
  const {captureWork}=await import("../server/memory/chunks.ts");
  const {MemoryWorkerController}=await import("../server/memory/worker-controller.ts");
  const {searchMemory}=await import("../server/memory/search.ts");
  const {buildMemoryBundle,assertMemoryBundle}=await import("../server/memory/bundle.ts");
  const authority=await import("../server/memory/authority.ts");
  const {forgetMemory}=await import("../server/memory/forget.ts");
  const {memoryAgentRoute}=await import("../server/memory/routes.ts");
  const disclosures=await import("../server/memory/disclosures.ts");
  const roster={bots:Array.from({length:20},(_,i)=>({id:`bot-${i}`,threadId:`thread-${i}`,section:"fault-team"})),groups:[{id:"room",threadId:"room-thread",memberIds:["bot-0","bot-1"]}]};
  reconcileMemoryRoster(roster);setMemoryMode("active");
  const registry=new InternalCapabilities();
  function access(bot=roster.bots[0],threadId=bot.threadId){const generation=registry.begin(bot.id,threadId);const token=registry.mint({botId:bot.id,threadId,generation,kind:"memory",depth:0,skillAuthoring:false});return memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);}
  let controller=new MemoryWorkerController({modelDirectory:model});
  async function stopController(){
    const owned=(controller as unknown as {child:ChildProcess|null}).child;
    if(owned&&process.platform!=="win32")owned.kill("SIGCONT");
    try{await controller.stop();}catch(error){if(owned)await terminate(owned);throw error;}
  }
  const cleanup=stopController;shutdown.add(cleanup);
  const child=()=>{const value=(controller as unknown as {child:ChildProcess|null}).child;assert(value?.pid,"Actual owned memory worker missing");return value;};
  async function ready(){controller.start();await until("memory worker readiness",()=>controller.status().ready?true:undefined,30000);}
  async function drain(timeout=180000,requireEmbeddings=true){
    await until("capture/projection drain",()=>{
      const db=database();const jobs=Number(db.prepare("SELECT count(*) AS n FROM memory_jobs WHERE status NOT IN ('complete','cancelled','failed')").get()!.n);
      const projections=Number(db.prepare("SELECT count(*) AS n FROM memory_projection_receipts WHERE lexical_status IN ('pending','pending-archive','delete-pending')").get()!.n);
      if(jobs||projections||!controller.status().ready)return undefined;
      assert.equal(Number(db.prepare("SELECT count(*) AS n FROM memory_jobs WHERE status='failed'").get()!.n),0,"Capture failed instead of draining");
      if(requireEmbeddings)assert.equal(Number(db.prepare("SELECT count(*) AS n FROM memory_projection_receipts p JOIN memory_records r ON r.id=p.record_id AND r.version=p.record_version WHERE r.state='active' AND p.embedding_status!='indexed'").get()!.n),0,"Required local embeddings unavailable");
      return true;
    },timeout);
  }
  function captured(text="Known source evidence",messageId="source",threadId="thread-0",parentId?:string){
    mdb.appendMessage(threadId,{id:messageId,at:Date.now(),role:"user",kind:"text",text,...parentId===undefined?{}:{parentId}});
    const work=claimMemoryJob("fixture");assert(work,"Required capture job missing");publishMemoryWork(work,"fixture",captureWork(work));
    const record=database().prepare("SELECT record_id AS id FROM memory_evidence WHERE source_id=? AND source_revision=? ORDER BY start_byte LIMIT 1").get(work.sourceId,work.revision)!;
    return {work,id:String(record.id),text,messageId};
  }
  async function canonical(text:string,context=access()){
    let raw:Awaited<ReturnType<typeof controller.search>>|undefined;
    const bridge={search:async(input:Parameters<typeof controller.search>[0],signal:AbortSignal)=>{raw=await controller.search(input,signal);return raw;}};
    const result=await searchMemory(text,context,bridge,{limit:10});
    caseObservations.lastCanonical={query:text,rawHits:raw?.hits,vectorRows:result.vectorRows,hits:result.hits.map(hit=>({id:hit.id,text:hit.text,similarity:hit.similarity,lexical:hit.lexical}))};
    const bundle=await buildMemoryBundle(text,context,bridge);assertMemoryBundle(bundle,context);return {result,bundle,raw};
  }
  const result=(observations:Record<string,unknown>,limitations?:string[]):Result=>({id,status:"PASS",observations,...limitations?{limitations}:{}});
  try {
    if(id==="F01"){
      // Capture and optional extraction cursors are separate receipts. A
      // deterministic source-quoting transport injects an interruption; no
      // native model quality or paid answer result is asserted by this fault.
      const text="ข้อมูลภาษาไทย ".repeat(6000);mdb.appendMessage("thread-0",{id:"large",at:1,role:"user",kind:"text",text});
      const first=claimMemoryJob("fixture")!;const partial=captureWork(first);assert.equal(partial.status,"partial");publishMemoryWork(first,"fixture",partial);
      const second=claimMemoryJob("fixture")!;publishMemoryWork(second,"fixture",{id:second.id,leaseGeneration:second.leaseGeneration,status:"deferred",nextCursor:second.cursor,chunks:[],reason:"fixture-budget-refusal"});
      closeDatabase();assert.equal(database().prepare("SELECT cursor FROM memory_jobs WHERE id=?").get(first.id)?.cursor,partial.nextCursor);
      const now=Date.now()+6000;let work=claimMemoryJob("fixture",now);while(work){publishMemoryWork(work,"fixture",captureWork(work),now);work=claimMemoryJob("fixture",now);}
      assert.equal(database().prepare("SELECT cursor FROM memory_jobs WHERE id=?").get(first.id)?.cursor,Buffer.byteLength(text));
      const chunks=database().prepare("SELECT r.text FROM memory_records r JOIN memory_evidence e ON e.record_id=r.id AND e.record_version=r.version WHERE e.source_id=? ORDER BY e.start_byte").all(first.sourceId);
      assert.equal(chunks.map(row=>row.text).join(""),text);
      const {consolidateMemorySource}=await import("../server/memory/consolidate.ts");
      const {mock}=await import("node:test");mock.timers.enable({apis:["Date"],now});
      const bytes=Buffer.from(text),calls:Array<{cursor:number;bytes:number;at:number;interrupted:boolean}>=[],successOffsets:number[]=[],deferrals:Array<{cursor:number;reason:string;retryAfter:number}>=[];
      let cursor=0,interrupt=false;
      const extractor=async(slice:string,maximumOutputTokens:number,signal:AbortSignal)=>{
        assert.equal(maximumOutputTokens,2000);signal.throwIfAborted();
        const length=Buffer.byteLength(slice);assert(length>0&&length<=16384);
        assert.equal(slice,bytes.subarray(cursor,cursor+length).toString("utf8"));
        calls.push({cursor,bytes:length,at:Date.now(),interrupted:interrupt});
        if(interrupt)throw Error("fixture slice interruption");
        const quote=[...slice].slice(0,12).join("");
        return JSON.stringify([{text:quote,quote,startByte:0,endByte:Buffer.byteLength(quote)}]);
      };
      try{
        const accepted=await consolidateMemorySource(first.id,extractor,new AbortController().signal);
        if(accepted.status!=="partial")throw Error("First extraction slice did not remain partial");
        assert(accepted.cursor>0&&accepted.cursor<bytes.length);assert.equal(accepted.candidateCount,1);
        const firstCandidate=accepted.candidateIds[0];successOffsets.push(0);cursor=accepted.cursor;
        interrupt=true;
        const interrupted=await consolidateMemorySource(first.id,extractor,new AbortController().signal);
        if(interrupted.status!=="deferred")throw Error("Interrupted extraction was acknowledged as complete");
        assert.equal(interrupted.reason,"extraction-incomplete");assert.equal(interrupted.cursor,cursor);assert.equal(interrupted.candidateCount,1);
        const budgetsBefore=database().prepare("SELECT id,intent FROM memory_scope_bindings WHERE subject_id='extract-budget' ORDER BY id").all();
        closeDatabase();assert.deepEqual(database().prepare("SELECT id,intent FROM memory_scope_bindings WHERE subject_id='extract-budget' ORDER BY id").all(),budgetsBefore);
        const retry=interrupted.retryAfter;if(typeof retry!=="number"||retry<=Date.now())throw Error("Interrupted extraction lacks a bounded retry time");
        mock.timers.setTime(retry+1);interrupt=false;
        for(let attempt=0;cursor<bytes.length&&attempt<64;attempt++){
          const start=cursor,completed=await consolidateMemorySource(first.id,extractor,new AbortController().signal);
          if(completed.status==="deferred"){
            assert.equal(completed.cursor,cursor);assert.equal(completed.reason,"budget-exhausted");
            const next=completed.retryAfter;if(typeof next!=="number"||next<=Date.now())throw Error("Budget refusal lacks a future retry boundary");
            deferrals.push({cursor,reason:completed.reason,retryAfter:next});mock.timers.setTime(next+1);continue;
          }
          if(completed.status!=="partial"&&completed.status!=="complete")throw Error("Unexpected consolidation resumption status");
          assert(completed.cursor>cursor);successOffsets.push(start);cursor=completed.cursor;
        }
        assert.equal(cursor,bytes.length);assert(deferrals.length>0,"Large source did not exercise unchanged daily/minute budgets");
        const invoked=calls.length,replayed=await consolidateMemorySource(first.id,extractor,new AbortController().signal);
        assert.equal(replayed.status,"unchanged");assert.equal(calls.length,invoked);
        assert.equal(calls.filter(call=>call.cursor===0).length,1,"Acknowledged first slice was extracted again");
        const evidence=database().prepare("SELECT r.id,r.text,e.start_byte,e.end_byte FROM memory_records r JOIN memory_evidence e ON e.record_id=r.id AND e.record_version=r.version WHERE e.source_id=? AND r.state='candidate' ORDER BY e.start_byte").all(first.sourceId);
        assert.equal(evidence.length,successOffsets.length);assert.equal(replayed.candidateCount,evidence.length);assert.equal(evidence[0].id,firstCandidate);
        assert.equal(new Set(evidence.map(row=>row.id)).size,evidence.length);
        for(const [i,row] of evidence.entries()){assert.equal(Number(row.start_byte),successOffsets[i]);assert.equal(bytes.subarray(Number(row.start_byte),Number(row.end_byte)).toString("utf8"),row.text);}
        const budgets=database().prepare("SELECT id,intent FROM memory_scope_bindings WHERE subject_id='extract-budget' ORDER BY id").all().map(row=>({id:String(row.id),...JSON.parse(String(row.intent))}));
        assert(budgets.every(row=>row.input<=100000&&row.output<=20000&&row.calls<=6));
        const minuteCalls=new Map<number,number>();for(const call of calls){const minute=Math.floor(call.at/60000);minuteCalls.set(minute,(minuteCalls.get(minute)??0)+1);}assert([...minuteCalls.values()].every(count=>count<=6));
        return result({captureCursorResume:"PASS",reconstructedBytes:bytes.length,extractorFixtureCalls:calls.length,successfulSlices:successOffsets.length,absoluteEvidenceVerified:evidence.length,firstSliceCalls:1,budgetDeferrals:deferrals,budgets,completedReplay:"unchanged"},["Clock advances only to actual retryAfter boundaries; reservation rows and limits are never reset or relaxed.","Deterministic transport fault injection is not native-model answer-quality evidence."]);
      }finally{mock.timers.reset();}
    }
    if(id==="F02"){
      if(process.platform==="win32")return {id,status:"UNVERIFIED",observations:{},limitations:["SIGSTOP boundary needs a native Windows suspension fixture; not emulated."]};
      await ready();const old=child();old.kill("SIGSTOP");
      const source=captured("Projection recovery first revision");
      await until("index queued behind stopped worker",()=>controller.status().indexing?true:undefined);
      await terminate(old);await until("replacement worker",()=>controller.status().ready&&child().pid!==old.pid?true:undefined,30000);await drain();
      assert.equal(database().prepare("SELECT count(*) AS n FROM memory_records WHERE kind='source'").get()?.n,1);
      assert.equal(database().prepare("SELECT status FROM memory_jobs WHERE id=?").get(source.work.id)?.status,"complete");
      mdb.updateMessage("thread-0",{id:"source",at:2,role:"user",kind:"text",text:"Projection recovery corrected revision"});await drain();
      assert.equal(database().prepare("SELECT count(*) AS n FROM memory_source_versions WHERE source_id=?").get(source.work.sourceId)?.n,2);
      const found=await canonical("corrected revision");assert(found.result.hits.some(hit=>hit.text.includes("corrected revision")));assert(!found.result.hits.some(hit=>hit.text.includes("first revision")));
      const resumedPid=child().pid;
      await controller.stop();writeFileSync(join(root,"data/memory-index.db"),"corrupt derived SQLite index");
      controller=new MemoryWorkerController({modelDirectory:model});await ready();await drain();
      assert((await canonical("corrected revision")).result.hits.some(hit=>hit.text.includes("corrected revision")));
      const context=access(),held=child();held.kill("SIGSTOP");
      const input={query:"corrected revision",scopeIds:[...context.scopeIds],policyRevision:context.policyRevision,deletionEpoch:context.deletionEpoch,historical:false,cursor:"",limit:10,semantic:false};
      const pending=Array.from({length:64},()=>controller.search(input,AbortSignal.timeout(60000)));
      try{assert.equal(controller.status().queryCount,64);await assert.rejects(controller.search(input,AbortSignal.timeout(1000)),/MEMORY_WORKER_NOT_READY/);}
      finally{held.kill("SIGCONT");await Promise.all(pending);}
      return result({oldWorker:old.pid,replacementWorker:resumedPid,revisionCount:2,publicationSurvived:true,corruptIndexRebuilt:true,queueAccepted:64,overflowRejected:true});
    }
    if(id==="F03"){
      const source=captured("Nobody decided to deploy.");authority.pinMemory(authority.ownerMemoryTicket(),source.id,1,true);const context=access();
      const handles=[{sourceId:source.work.sourceId,revision:1,startByte:0,endByte:Buffer.byteLength(source.text)}];
      const saved=await memoryAgentRoute("/api/internal/memory/save",{text:"Owner approved deployment",evidence:handles,idempotencyKey:"spoof"},context,controller) as {candidateId:string};
      assert.throws(()=>authority.approveMemory({},saved.candidateId,1),/MEMORY_OWNER_REQUIRED/);
      await memoryAgentRoute("/api/internal/memory/propose-correction",{id:source.id,version:1,replacement:"Deploy immediately",evidence:handles,idempotencyKey:"correction"},context,controller);
      const pin=database().prepare("SELECT text,owner_pinned,state FROM memory_records WHERE id=?").get(source.id)!;
      assert.equal(pin.text,source.text);assert.equal(pin.owner_pinned,1);assert.equal(pin.state,"active");
      const candidates=database().prepare("SELECT assertion,state,owner_pinned FROM memory_records WHERE state='candidate'").all();assert.equal(candidates.length,2);assert(candidates.every(row=>row.assertion==="assistant-inference"&&row.owner_pinned===0));
      return result({untrustedCandidateCount:2,pinUnchanged:true,positiveNegationClaimPromoted:false},["Tests authority against adversarial proposed text, not a model's semantic understanding of negation."]);
    }
    if(id==="F04"){
      const privateSource=captured("PRIVATE_ROOM_CANARY");authority.pinMemory(authority.ownerMemoryTicket(),privateSource.id,1,true);
      const shared=captured("ROOM_APPROVED_FACT","room-source","room-thread");authority.pinMemory(authority.ownerMemoryTicket(),shared.id,1,true);
      await ready();await drain();const context=access(roster.bots[0],"room-thread");const bundle=await buildMemoryBundle("ROOM_APPROVED_FACT",context,controller);
      assertMemoryBundle(bundle,context);assert(!bundle.text.includes("PRIVATE_ROOM_CANARY"));assert(bundle.text.includes("ROOM_APPROVED_FACT"));
      const {decorateMemoryInstance}=await import("../server/harness/memory-adapter.ts");const {makeFakeDriver}=await import("../server/testing/fake-driver.ts");
      const fixture=makeFakeDriver();const live=await fixture.driver.create({instanceId:"fault-adapter",displayName:"Fault adapter",enabled:true,config:{},environment:{}});
      let payload="";live.adapter.sendTurn=async input=>{payload=input.text;return {turnId:"fault"};};
      const decorated=decorateMemoryInstance(live);await decorated.adapter.sendTurn({threadId:"room-thread",text:"current request",memoryContext:bundle});await decorated.dispose();
      assert(payload.includes("ROOM_APPROVED_FACT"));assert(!payload.includes("PRIVATE_ROOM_CANARY"));
      return result({adapterPayloadContainsShared:true,privateCanaryAbsent:true},["Real registry adapter contract sink; actual HTTP fake-provider dispatch remains separately required P07 evidence."]);
    }
    if(id==="F05"){
      const {previewMemoryImport}=await import("../server/memory/import.ts");const directory=join(root,"data/workspaces/bot-0/memory");mkdirSync(directory,{recursive:true});
      const outside=join(root,"outside-selected-root.txt");writeFileSync(outside,"EXTERNAL_PRIVATE_CANARY");
      try{symlinkSync(outside,join(directory,"link.md"));}catch(error){if(process.platform==="win32")return {id,status:"UNVERIFIED",observations:{},limitations:["Native Windows symlink creation unavailable; no substitute file used."]};throw error;}
      assert.throws(()=>previewMemoryImport(authority.ownerMemoryTicket(),[{kind:"bot",botId:"bot-0",topic:"link.md"}],roster),/MEMORY_IMPORT_SYMLINK/);
      assert.equal(database().prepare("SELECT count(*) AS n FROM memory_sources").get()?.n,0);
      return result({symlinkRefused:true,importedSources:0});
    }
    if(id==="F06"){
      const source=captured("REVOKED_PRIVATE_CANARY");authority.pinMemory(authority.ownerMemoryTicket(),source.id,1,true);const context=access();
      // Empty query deliberately exercises mandatory pins without an optional search.
      const bundle=await buildMemoryBundle("",context,controller);disclosures.prepareMemoryDisclosure(bundle,context,"native");disclosures.deliverMemoryDisclosure(bundle.bundleId,context,"native-session");disclosures.linkMemoryDisclosureOutput(bundle.bundleId,"paraphrased-answer");
      forgetMemory(authority.ownerMemoryTicket(),{kind:"source",id:source.work.sourceId});const renewed=access();
      assert(disclosures.continuationMemoryRevoked("thread-0","native","native-session",renewed));
      const replay=disclosures.filterMemoryReplay("thread-0",[{id:"independent-user"},{id:"paraphrased-answer"}],renewed);assert.deepEqual(replay,[{id:"independent-user"}]);
      const refreshed=await buildMemoryBundle("",renewed,controller);assert(!refreshed.text.includes("REVOKED_PRIVATE_CANARY"));
      return result({nativeContinuationMustRetire:true,dependentParaphraseRemoved:true,independentMessageRetained:true});
    }
    if(id==="F07"){
      if(process.platform==="win32")return {id,status:"UNVERIFIED",observations:{},limitations:["Abrupt transaction hold uses POSIX SIGSTOP; a native Windows process barrier is required."]};
      closeDatabase();
      for(const mode of ["tx-uncommitted","tx-committed"]){const probe=spawnProbe(root,mode,model);try{await probe.wait("transaction-boundary");await terminate(probe.child);}finally{await terminate(probe.child);}}
      assert.equal(database().prepare("SELECT count(*) AS n FROM messages WHERE id='tx-uncommitted'").get()?.n,0);
      assert.equal(database().prepare("SELECT count(*) AS n FROM memory_sources WHERE message_id='tx-uncommitted'").get()?.n,0);
      assert.equal(database().prepare("SELECT count(*) AS n FROM messages WHERE id='tx-committed'").get()?.n,1);
      assert.equal(database().prepare("SELECT count(*) AS n FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE s.message_id='tx-committed'").get()?.n,1);
      const {reconcileInterruptedMemoryTurns}=await import("../server/memory/settlement.ts");reconcileInterruptedMemoryTurns();
      assert.equal(database().prepare("SELECT outcome FROM memory_sources WHERE turn_id='orphan-turn'").get()?.outcome,"interrupted");
      // SQLite's own allocation quota produces SQLITE_FULL without filling any
      // user's volume. The caller must not acknowledge a partially written message.
      const pages=Number(database().prepare("PRAGMA page_count").get()!.page_count);database().exec(`PRAGMA max_page_count=${pages+1}`);
      let rejected=false;try{mdb.appendMessage("thread-0",{id:"full-disk",at:3,role:"user",kind:"text",text:"x".repeat(2*1024**2)});}catch{rejected=true;}
      assert(rejected);assert.equal(database().prepare("SELECT count(*) AS n FROM messages WHERE id='full-disk'").get()?.n,0);
      assert.equal(database().prepare("SELECT count(*) AS n FROM memory_sources WHERE message_id='full-disk'").get()?.n,0);
      database().exec(`PRAGMA max_page_count=${pages+10000}`);mdb.appendMessage("thread-0",{id:"after-full",at:4,role:"user",kind:"text",text:"Persistence recovered"});
      const osFull=await nativeFullVolume(root,model);
      return {id,status:osFull.status,observations:{abruptKillBoundaries:2,acknowledgedMessageAndOutboxPreserved:true,orphan:"interrupted",sqliteFullAtomicity:true,writeAfterQuotaRestored:true,osFull:osFull.observations},...osFull.limitations?{limitations:osFull.limitations}:{},...osFull.error?{error:osFull.error}:{}};
    }
    if(id==="F08"){
      if(process.platform==="win32")return {id,status:"UNVERIFIED",observations:{},limitations:["Native process suspension for lease takeover not available in this POSIX fixture."]};
      mdb.appendMessage("thread-0",{id:"lease",at:1,role:"user",kind:"text",text:"Lease takeover source"});closeDatabase();
      const a=spawnProbe(root,"lease-A",model);let b:ReturnType<typeof spawnProbe>|undefined;
      try{
        const first=await a.wait("lease-claimed");a.child.kill("SIGSTOP");await sleep(31050);
        b=spawnProbe(root,"lease-B",model);const second=await b.wait("lease-claimed");assert(second.generation>first.generation);
        b.child.send({type:"publish"});assert.equal((await b.wait("lease-result")).accepted,true);
        a.child.kill("SIGCONT");a.child.send({type:"publish"});const stale=await a.wait("lease-result");assert.equal(stale.accepted,false);assert.equal(stale.heartbeat,false);
        assert.equal(database().prepare("SELECT count(*) AS n FROM memory_records WHERE kind='source'").get()?.n,1);
        return result({oldGeneration:first.generation,newGeneration:second.generation,realPauseMs:31050,stalePublisherRejected:true,logicalPublications:1});
      }finally{a.child.kill("SIGCONT");await terminate(a.child);if(b)await terminate(b.child);}
    }
    if(id==="F09"){
      const source=captured("FORGOTTEN_BACKUP_CANARY");await ready();await drain();
      const restored=join(root,"restored");mkdirSync(restored);await backup(database(),join(restored,"messages.db"));
      forgetMemory(authority.ownerMemoryTicket(),{kind:"source",id:source.work.sourceId});await controller.stop();closeDatabase();
      const {mergeDestinationMemoryDeletions}=await import("../server/memory/restore.ts");const merged=mergeDestinationMemoryDeletions(join(root,"data"),restored);assert(merged.merged>0);
      const proof=spawnProbe(root,"restored-query",model,"restored");try{const receipt=await proof.wait("restored-result");assert.equal(receipt.excluded,true);}finally{await terminate(proof.child);}
      return result({destinationLedgerMerged:merged.merged,restoredCanonicalRecallExcluded:true},["Fresh-install restores only know the deletion history in their backup; no cross-installation deletion guarantee."]);
    }
    if(id==="F11"||id==="F12"){
      const source=captured(id==="F11"?"Rejected approach:\nUnattended deployment was considered and rejected.":"Production needs two reviewers.");
      const current=id==="F11"?captured("Current decision: production needs two reviewers.","current-decision","thread-0",source.messageId):source;
      await ready();await drain();
      const queries=id==="F11"?["Rejected approach","ต้องมีผู้ตรวจสอบกี่คนก่อนใช้งานจริง","生产部署需要几个人审核","How many people approve a rollout?"]:["two reviewers"];
      const observed:Array<Record<string,unknown>>=[];caseObservations.queries=observed;
      for(const [i,query] of queries.entries()){
        const expected=id==="F11"&&i===0?source:current;const found=await canonical(query);
        observed.push({query,expectedRecord:expected.id,expectedText:expected.text,vectorRows:found.result.vectorRows,rawHits:found.raw?.hits,hits:found.result.hits.map(hit=>({id:hit.id,text:hit.text,similarity:hit.similarity,lexical:hit.lexical})),bundleSourceVersions:found.bundle.sourceVersions});
        assert(found.result.vectorRows>0);assert(found.result.hits.some(hit=>hit.id===expected.id),`Expected source absent for ${JSON.stringify(query)}`);
        if(id==="F11"&&i===0)assert(found.result.hits.find(hit=>hit.id===source.id)!.text.includes("Rejected approach:"));
      }
      if(id==="F12"){
        requireMeasuredHit({backend:"actual-canonical-memory-worker",visited:1,ids:[source.id]},source.id);
        assert.throws(()=>requireMeasuredHit({backend:"",visited:0,ids:[]},source.id));
        const admit=(backend:string)=>{assert.equal(backend,"actual-canonical-memory-worker","Wrong benchmark backend");};assert.throws(()=>admit("mock"));
      }
      return result({queries:observed,sourceReconstructible:true},id==="F11"?["Retrieval/heading preservation only; broad multilingual precision belongs to the frozen 240-query evaluator."]:undefined);
    }
    throw Error(`Unknown frozen fault ${id}`);
  }finally{shutdown.delete(cleanup);try{await stopController();}finally{closeDatabase();}}
}

async function runServerLoad(root:string,model:string,normalUse=false):Promise<Result>{
  const proofId=normalUse?"N01":"F10",durationMs=normalUse?120000:600000,requiredUpdates=normalUse?20:3000,readerCount=normalUse?4:8;
  const activeChunks=normalUse?normalUseProfile.activeChunks:10000,historyRecords=normalUse?normalUseProfile.retainedRecords:100000;
  const {launchVerificationServer,runControlMurage}=await import("./control-murage.ts");
  // A test-only preload measures the actual harness PID. It observes existing
  // worker IPC and never substitutes replies or creates another worker.
  const instrumentationSource=`import {monitorEventLoopDelay} from 'node:perf_hooks';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';import {join} from 'node:path';
import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const root=process.env.MURAGE_DATA_DIR,loop=monitorEventLoopDelay({resolution:10});loop.enable();
let phase='',baseRss=process.memoryUsage().rss,maxRss=baseRss,maxWorkers=0,indexBatches=0,maxIndexBatch=0,queryRequests=0;
const workers=new Set(),fork=cp.fork;
cp.fork=function(...args){const child=fork.apply(this,args);if(String(args[0]).includes('/memory/worker')){
workers.add(child.pid);maxWorkers=Math.max(maxWorkers,workers.size);child.once('exit',()=>workers.delete(child.pid));
const send=child.send;child.send=function(message,...rest){if(message?.type==='index'){indexBatches++;maxIndexBatch=Math.max(maxIndexBatch,message.records?.length??0);}if(message?.type==='query')queryRequests++;return send.call(this,message,...rest);};}return child;};syncBuiltinESMExports();
setInterval(()=>{try{const next=readFileSync(join(root,'.fault-metrics-reset'),'utf8');if(next!==phase){phase=next;loop.reset();baseRss=process.memoryUsage().rss;maxRss=baseRss;maxWorkers=workers.size;indexBatches=0;maxIndexBatch=0;queryRequests=0;}}catch{}
maxRss=Math.max(maxRss,process.memoryUsage().rss);writeFileSync(join(root,'.fault-runtime-metrics.tmp'),JSON.stringify({pid:process.pid,phase,baseRss,maxRss,eventLoopP99Ms:loop.percentile(99)/1e6,maxWorkers,workers:[...workers],indexBatches,maxIndexBatch,queryRequests}));renameSync(join(root,'.fault-runtime-metrics.tmp'),join(root,'.fault-runtime-metrics.json'));},500).unref();`;
  const fixture=await launchVerificationServer({},undefined,{instrumentationSource});
  Object.assign(caseObservations,{stage:"server-launched",mainPid:fixture.info.pid,fixtureLog:fixture.info.logPath,fixtureDataDir:fixture.info.dataDir,loadStarted:false});
  const cleanup=()=>fixture.close();shutdown.add(cleanup);
  process.env.MURAGE_DATA_DIR=fixture.info.dataDir;
  let desktop:Record<string,string>={},db:DatabaseSync|undefined;
  let closeDatabase:(()=>void)|undefined;
  async function api(method:string,path:string,body?:unknown,headers=desktop,timeoutMs=10000){
    const response=await fetch(`${fixture.info.url}${path}`,{method,headers:{...headers,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
    const parsed=await response.json();if(!response.ok)throw Error(`Load fixture ${method} ${path}: HTTP${response.status}`);return parsed as any;
  }
  try{
    const proof=await api("GET","/api/desktop-secret");desktop={"x-murage-surface":"desktop","x-murage-surface-secret":proof.secret};
    // The existing fake CLI's explicit hold protocol gets periodic reasoning
    // activity. That prevents an idle-provider watchdog from invalidating an
    // otherwise actively used tool capability midway through the 10min load.
    // No assistant text or model inference is invented by this heartbeat.
    const heartbeatCli=join(fixture.info.dataDir,"load-fake-claude.ts");
    const finishGates=join(fixture.info.dataDir,"load-finish-gates");mkdirSync(finishGates);
    writeFileSync(heartbeatCli,`#!/usr/bin/env node
process.env.FAKE_CLAUDE_FINISH_GATE_DIR=${JSON.stringify(finishGates)};
let held=false;process.stdin.on('data',chunk=>{if(String(chunk).includes('__fixture_hold_authority__'))held=true;});
setInterval(()=>{if(held)process.stdout.write(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'fixture activity'}}})+'\\n');},1000).unref();
await import(${JSON.stringify(new URL("../server/testing/fake-claude-cli.ts",import.meta.url).href)});`,{mode:0o700});
    await api("PATCH","/api/instances/verification",{cli:heartbeatCli});
    const bots:Array<{id:string;threadId:string;modelSelection:{instanceId:string;model:string}}>=[];
    for(let i=0;i<20;i++)bots.push((await api("POST","/api/bots",{name:`Load fixture ${i}`,title:"Synthetic workload",section:"Load fixture"})).bot);
    cpSync(model,join(fixture.info.dataDir,"memory-model"),{recursive:true,dereference:true});
    const databaseModule=await import("../server/database.ts");db=databaseModule.database();closeDatabase=databaseModule.closeDatabase;
    const mdb=await import("../server/message-db.ts");const scope="load-fixture-project";
    databaseModule.transaction(database=>{
      database.prepare("INSERT INTO memory_scopes VALUES(?,'project','load-fixture','[]',0)").run(scope);
      for(const bot of bots)database.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'bot',?,0,'granted','{}')").run(`load-grant-${bot.id}`,scope,bot.id);
      for(let i=0;i<activeChunks;i++){
        const thread=bots[i%20].threadId,messageId=`load-${i}`,sourceId=`message:${thread}:${messageId}`,text=i===0?"LOAD_GOLD_CANARY requires two reviewers.":`Inventory reference ${i}.`,payload=JSON.stringify({text});
        database.prepare("INSERT INTO messages VALUES(?,?,1,'user','text',?,?)").run(thread,messageId,text,JSON.stringify({id:messageId,at:1,role:"user",kind:"text",text}));
        database.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,?,'text','owner','recorded',NULL,'active')").run(sourceId,scope,thread,messageId,sha(payload));
        database.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,1)").run(sourceId,sha(payload),payload);
      }
      for(let i=0;i<historyRecords;i++){
        const sourceIndex=i%activeChunks,sourceId=`message:${bots[sourceIndex%20].threadId}:load-${sourceIndex}`,text=sourceIndex===0?"LOAD_GOLD_CANARY requires two reviewers.":`Inventory reference ${sourceIndex}.`;
        database.prepare("INSERT INTO memory_records VALUES(?,1,?,'source',?,'owner-statement',?,0,1,NULL,NULL,1)").run(`load-record-${i}`,scope,text,i<activeChunks?"active":"archived");
        database.prepare("INSERT INTO memory_evidence VALUES(?,1,?,1,0,?)").run(`load-record-${i}`,sourceId,Buffer.byteLength(text));
        database.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,1,?,'pending',NULL)").run(`load-record-${i}`,i<activeChunks?"pending":"pending-archive");
      }
      database.exec("UPDATE memory_meta SET data_revision=data_revision+1");
    });
    await api("POST","/api/memory/action",{action:"configure",mode:"active"});
    async function drain(label:string,timeout=180000,heldWorkingJobIds:readonly string[]=[]){const began=performance.now();let snapshotAt=0;
      caseObservations.stage=label;
      await until(`actual server capture/index drain (${label})`,async()=>{
      const pending=Number(db!.prepare("SELECT count(*) AS n FROM memory_projection_receipts WHERE lexical_status IN ('pending','pending-archive','delete-pending')").get()!.n);
      const jobs=Number(db!.prepare("SELECT count(*) AS n FROM memory_jobs WHERE status NOT IN ('complete','cancelled','failed')").get()!.n);
      // The worker intentionally cannot process a still-working turn. During
      // setup only, admit the exact eight captured hold intents, and verify
      // they are still pending working turns rather than ignoring arbitrary jobs.
      const held=heldWorkingJobIds.length?db!.prepare("SELECT j.id FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision WHERE j.id IN (SELECT value FROM json_each(?)) AND j.status='pending' AND j.stage='capture' AND s.kind='turn' AND s.state='active' AND s.outcome='working'").all(JSON.stringify(heldWorkingJobIds)):[];
      assert.equal(held.length,heldWorkingJobIds.length,"A held turn ended or changed before workload admission");
      const readyJobs=jobs-held.length;
      if(performance.now()-snapshotAt>=5000){
        snapshotAt=performance.now();
        caseObservations.drain={label,elapsedMs:performance.now()-began,pending,jobs,readyJobs,heldWorkingJobs:held.length,
          projections:db!.prepare("SELECT lexical_status,embedding_status,count(*) AS count FROM memory_projection_receipts GROUP BY lexical_status,embedding_status").all(),
          authorityMode:db!.prepare("SELECT mode,policy_revision,deletion_epoch FROM memory_meta").get()};
        const samples=(caseObservations.drainSamples??=[]) as unknown[];
        samples.push(caseObservations.drain);
        try{caseObservations.ownerStatus=await api("GET","/api/memory/status");}catch(error){caseObservations.statusError=String(error);}
        process.stderr.write(`P10 ${label}: ${pending} projections, ${jobs} jobs pending (${held.length} explicitly held working turns)\n`);
      }
      if(pending||readyJobs)return undefined;
      assert.equal(Number(db!.prepare("SELECT count(*) AS n FROM memory_jobs WHERE status='failed'").get()!.n),0);
      assert.equal(Number(db!.prepare("SELECT count(*) AS n FROM memory_projection_receipts p JOIN memory_records r ON r.id=p.record_id AND r.version=p.record_version WHERE r.state='active' AND p.embedding_status!='indexed'").get()!.n),0,"Active model projections not available");return true;
    },timeout);}
    if(arg("--diagnostic")==="seeded-index"){
      try{await drain("seeded-index",60000);return {id:"F10",status:"UNVERIFIED",observations:{...caseObservations,diagnostic:"seeded-index",setupDrained:true,loadStarted:false},limitations:["Focused setup diagnosis only; no 600-second workload or held provider turns executed."]};}
      catch(error){return {id:"F10",status:"UNVERIFIED",observations:{...caseObservations,diagnostic:"seeded-index",setupDrained:false,loadStarted:false},error:error instanceof Error?error.message:String(error),limitations:["Setup diagnosis stopped at 60 seconds; this is not the workload acceptance run."]};}
    }
    await drain("seeded-index");
    const tokens:string[]=[];
    const heldTurns:Array<{botId:string;threadId:string;sourceId:string;jobId:string;pid:number}>=[];
    for(const bot of bots.slice(0,8)){
      rmSync(fixture.fixtureDumpPath,{force:true});await api("POST",`/api/bots/${bot.id}/messages`,{text:"__fixture_hold_authority__"});
      const dump=await until("live fake-provider memory capability",()=>{try{return JSON.parse(readFileSync(fixture.fixtureDumpPath,"utf8")) as {pid:number;mcpConfig:{mcpServers:Record<string,{env:Record<string,string>}>}};}catch{return undefined;}},30000);
      const token=dump.mcpConfig.mcpServers["murage-memory"]?.env.MURAGE_MEMORY_TOKEN;
      assert(typeof token==="string"&&token.length>0);assert(Number.isSafeInteger(dump.pid)&&dump.pid>0);tokens.push(token);
      const intent=await until("durable working turn intent",()=>{
        const rows=db!.prepare("SELECT j.id AS jobId,s.id AS sourceId FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision WHERE s.thread_id=? AND s.kind='turn' AND s.outcome='working' AND s.state='active' AND j.stage='capture' AND j.status='pending'").all(bot.threadId);
        assert(rows.length<=1,"Multiple working turn intents for one held caller");return rows[0];
      });
      heldTurns.push({botId:bot.id,threadId:bot.threadId,pid:dump.pid,sourceId:String(intent.sourceId),jobId:String(intent.jobId)});
    }
    assert.equal(heldTurns.length,8);assert.equal(new Set(heldTurns.map(turn=>turn.jobId)).size,8);
    caseObservations.heldTurns=heldTurns;
    await drain("held-capability-setup",180000,heldTurns.map(turn=>turn.jobId));
    const metricFile=join(fixture.info.dataDir,".fault-runtime-metrics.json");writeFileSync(join(fixture.info.dataDir,".fault-metrics-reset"),"measure");
    await until("actual PID metrics reset",()=>{try{const state=JSON.parse(readFileSync(metricFile,"utf8"));return state.phase==="measure"?state:undefined;}catch{return undefined;}});
    const times:number[]=[],errors:string[]=[];let calls=0,changes=0,bytes=0,maxQueued=0,workerPeakRssBytes=0,chatTurns=0,statusReads=0,recallFailures=0,continuityFailures=0;
    const updatedSources:Array<{sourceId:string;text:string;revision:number}>=[],changedFactRecall:Array<{sourceId:string;revision:number;latencyMs:number}>=[];
    const started=performance.now(),end=started+durationMs;let stopping=false;
    Object.assign(caseObservations,{stage:normalUse?"N01-normal-use":"600-second-load",loadStarted:true,...normalUse?{profileDefinition:normalUseProfile}:{}});
    const producer=(async()=>{for(let i=0;i<requiredUpdates;i++){
      const scheduled=normalUse?normalUseProfile.updateTimesMs[i]:i*200;
      const delay=started+scheduled-performance.now();if(delay>0)await sleep(delay);
      const index=1+i%(activeChunks-1),baseText=`Settled inventory revision ${i}.`,text=normalUse?(baseText+" Ordinary conversation context.".repeat(16)).slice(0,normalUseProfile.updateBytes):baseText;
      // Same authoritative updateMessage transaction used by the harness;
      // the actual server's single worker consumes the resulting outbox.
      mdb.updateMessage(bots[index%20].threadId,{id:`load-${index}`,at:Date.now(),role:"user",kind:"text",text});changes++;bytes+=Buffer.byteLength(text);
      if(normalUse&&(i===0||i===requiredUpdates-1))updatedSources.push({sourceId:`message:${bots[index%20].threadId}:load-${index}`,text,revision:2});
      maxQueued=Math.max(maxQueued,Number(db!.prepare("SELECT count(*) AS n FROM memory_jobs WHERE status NOT IN ('complete','cancelled')").get()!.n));
    }})();
    const consumers=tokens.slice(0,readerCount).map(async(token,index)=>{let sequence=0;while(!stopping&&performance.now()<end){const begin=performance.now();
      try{const response=await api("POST","/api/internal/memory/search",{query:`LOAD_GOLD_CANARY caller${index} iteration${sequence++}`,limit:10},{authorization:`Bearer ${token}`},normalUse?500:10000);
        workerPeakRssBytes=Math.max(workerPeakRssBytes,Number(response.workerPeakRssBytes??0));
        assert(!response.degradedReason,`Recall degraded: ${String(response.degradedReason)}; vectorRows=${Number(response.vectorRows??0)}; paged=${Boolean(response.nextCursor)}`);
        assert(response.vectorRows>0);assert(response.hits.some((hit:any)=>hit.evidence.some((e:any)=>e.sourceId===`message:${bots[0].threadId}:load-0`)));
      }catch(error){recallFailures++;if(errors.length<100)errors.push(error instanceof Error?error.message:String(error));}
      times.push(performance.now()-begin);calls++;
      if(normalUse){const pause=Math.min(12000,Math.max(0,end-performance.now()));if(pause)await sleep(pause);}
    }});
    const continuity=(async()=>{while(!stopping&&performance.now()<end){
      try{
        const status=await api("GET","/api/memory/status");assert(status.backlog&&Object.hasOwn(status.backlog,"oldestQueuedAt")&&status.cost&&status.deletion);statusReads++;
        await api("POST",`/api/bots/${bots[19].id}/messages`,{text:`load continuity ${chatTurns}`});
        const waited=await runControlMurage(["wait","--bot",bots[19].id,"--timeout","30","--url",fixture.info.url]) as {status:string};assert.equal(waited.status,"settled");chatTurns++;
      }catch(error){continuityFailures++;if(errors.length<100)errors.push(error instanceof Error?error.message:String(error));}
      const delay=Math.min(30000,Math.max(0,end-performance.now()));if(delay)await sleep(delay);
    }})();
    const progress=setInterval(()=>process.stderr.write(`${proofId} actual server load ${changes}/${requiredUpdates} changes, ${calls} recalls, ${chatTurns} chat turns\n`),30000);
    let productionEnded=0;try{await producer;productionEnded=performance.now();await Promise.all([...consumers,continuity]);}finally{stopping=true;clearInterval(progress);await Promise.allSettled([...consumers,continuity]);}
    const loadEnded=performance.now(),drainDeadline=loadEnded+60000;let drainError:string|undefined,releasedHeldTurns=0;
    try{
      if(normalUse){
        // Validate newly changed evidence while holder capabilities are live.
        // This work and final turn settlement share ONE load-end +60s deadline.
        await drain("N01-updates-before-release",Math.max(1,drainDeadline-performance.now()),heldTurns.map(turn=>turn.jobId));
        assert.equal(updatedSources.length,2);
        for(const source of updatedSources){
          const begin=performance.now();assert(begin<drainDeadline,"Normal-use drain deadline expired before changed-fact recall");
          const found=await api("POST","/api/internal/memory/search",{query:source.text,limit:10},{authorization:`Bearer ${tokens[0]}`},Math.max(1,Math.min(500,Math.floor(drainDeadline-begin))));
          assert(!found.degradedReason);assert(found.vectorRows>0);
          assert(found.hits.some((hit:any)=>hit.text===source.text&&hit.evidence.some((handle:any)=>handle.sourceId===source.sourceId&&handle.revision===source.revision)),"Changed source revision was not recalled");
          const latencyMs=performance.now()-begin;times.push(latencyMs);changedFactRecall.push({sourceId:source.sourceId,revision:source.revision,latencyMs});
          workerPeakRssBytes=Math.max(workerPeakRssBytes,Number(found.workerPeakRssBytes??0));
        }
      }
      // All eight recall loops have finished. Release the existing fake CLI's
      // normal completion gate, then include every resulting settlement/capture
      // job in the original 60-second drain deadline. No held-job exception here.
      for(const turn of heldTurns)writeFileSync(join(finishGates,String(turn.pid)),"finish",{mode:0o600});
      await until("held turns complete after load",()=>{
        releasedHeldTurns=heldTurns.filter(turn=>db!.prepare("SELECT 1 FROM memory_sources WHERE id=? AND kind='turn' AND state='active' AND outcome='completed'").get(turn.sourceId)).length;
        return releasedHeldTurns===8?true:undefined;
      },Math.max(1,drainDeadline-performance.now()));
      await drain("post-load",Math.max(1,drainDeadline-performance.now()));
      for(const turn of heldTurns){
        assert(db!.prepare("SELECT 1 FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision WHERE s.id=? AND s.outcome='completed' AND j.stage='capture' AND j.status='complete'").get(turn.sourceId),"Released turn lacks complete current-revision capture");
      }
    }catch(error){drainError=error instanceof Error?error.message:String(error);}
    const drainMs=performance.now()-loadEnded,metrics=JSON.parse(readFileSync(metricFile,"utf8"));assert.equal(metrics.pid,fixture.info.pid);
    const revisions=Number(db.prepare("SELECT count(*) AS n FROM memory_source_versions WHERE revision>1 AND source_id LIKE 'message:%:load-%'").get()!.n);
    const completed=Number(db.prepare("SELECT count(*) AS n FROM memory_jobs WHERE status='complete' AND source_revision>1 AND source_id LIKE 'message:%:load-%'").get()!.n);
    const observations={mainPid:fixture.info.pid,fixtureLog:fixture.info.logPath,activeChunks,historyRecords,bots:20,concurrentRecalls:readerCount,requiredDurationMs:durationMs,
      changes,bytes,calls,maxQueued,sourceRevisions:revisions,acknowledgedJobs:completed,chatTurns,statusReads,heldTurns:heldTurns.length,releasedHeldTurns,productionEndedMs:productionEnded-started,elapsedMs:loadEnded-started,drainMs,
      latencyMs:{p95:percentile(times,.95),p99:percentile(times,.99)},...normalUse?{profileDefinition:normalUseProfile,changedFactRecall,latencySamples:times.length,stressGate:{id:"F10",status:"DEFERRED",execution:"UNEXECUTED"}}:{},mainEventLoopP99Ms:metrics.eventLoopP99Ms,mainRssIncreaseBytes:Math.max(0,metrics.maxRss-metrics.baseRss),workerPeakRssBytes,
      observedWorkerProcessesPeak:metrics.maxWorkers,maxIndexBatch:metrics.maxIndexBatch,indexBatches:metrics.indexBatches,queryRequests:metrics.queryRequests,recallFailures,continuityFailures,errors,drainError,
      backgroundLLMReservations:Number(db.prepare("SELECT count(*) AS n FROM memory_scope_bindings WHERE subject_id='extract-budget'").get()!.n)};
    const failed=changes!==requiredUpdates||revisions!==requiredUpdates||completed!==requiredUpdates||productionEnded-started>durationMs||normalUse&&changedFactRecall.length!==2||!calls||!chatTurns||!statusReads||releasedHeldTurns!==8||errors.length>0||Boolean(drainError)||drainMs>60000||Number(observations.latencyMs.p95)>200||Number(observations.latencyMs.p99)>400||observations.mainEventLoopP99Ms>20||observations.mainRssIncreaseBytes>128*1024**2||workerPeakRssBytes>1024**3||metrics.maxWorkers!==1||metrics.maxIndexBatch>16||observations.backgroundLLMReservations!==0;
    return {id:proofId,status:failed?"FAIL":"PASS",observations,limitations:["HTTP canonical recall latency includes transport overhead. Fake-provider chat continuity is real HTTP/driver execution, not native model generation.","IPC index batches are counted exactly; internal embedding subbatches and one-hour unload remain their separate resource-observability obligations.",...normalUse?["N01 is normal-use acceptance only. The original F10 stress gate is user-deferred and was not executed."]:[]]};
  }finally{
    try{caseObservations.retainedServerLog=readFileSync(fixture.info.logPath,"utf8").slice(-16000);}catch{}
    try{caseObservations.runtimeMetrics=JSON.parse(readFileSync(join(fixture.info.dataDir,".fault-runtime-metrics.json"),"utf8"));}catch{}
    shutdown.delete(cleanup);closeDatabase?.();await fixture.close();
  }
}

async function probe(mode:string,root:string,model:string){
  const {database,transaction,closeDatabase}=await import("../server/database.ts");
  const {appendMessage}=await import("../server/message-db.ts");
  if(mode==="os-full"){
    const {setMemoryMode}=await import("../server/memory/repository.ts");setMemoryMode("capture");
    appendMessage("full-volume",{id:"acknowledged",at:1,role:"user",kind:"text",text:"Acknowledged before ENOSPC"});
    const filler=join(root,"mount/.owned-fill"),fd=openSync(filler,"wx");let bytes=0,full=false;
    try{const block=Buffer.alloc(1024**2,1);while(bytes<32*1024**2){try{const n=writeSync(fd,block);assert(n>0);bytes+=n;}catch(error){if((error as NodeJS.ErrnoException).code==="ENOSPC"){full=true;break;}throw error;}}}finally{closeSync(fd);}
    assert(full,"Bounded native image did not reach actual ENOSPC");
    let rejected=false;try{appendMessage("full-volume",{id:"unacknowledged",at:2,role:"user",kind:"text",text:"x".repeat(512*1024)});}catch{rejected=true;}
    assert(rejected);assert.equal(database().prepare("SELECT count(*) AS n FROM messages WHERE id='unacknowledged'").get()?.n,0);
    assert.equal(database().prepare("SELECT count(*) AS n FROM memory_sources WHERE message_id='unacknowledged'").get()?.n,0);
    assert.equal(database().prepare("SELECT count(*) AS n FROM messages WHERE id='acknowledged'").get()?.n,1);
    rmSync(filler);appendMessage("full-volume",{id:"recovered",at:3,role:"user",kind:"text",text:"Recovered after freeing owned fill"});
    closeDatabase();process.send?.({type:"os-full-result",enospc:true,bytes,mutationRejected:true,acknowledgedRetained:true,recoveryWrite:true});return;
  }
  if(mode.startsWith("tx-")){
    transaction(()=>{appendMessage("thread-0",{id:mode,at:1,role:"user",kind:"text",text:"Atomic source receipt"});
      if(mode==="tx-uncommitted"){process.send?.({type:"transaction-boundary"});process.kill(process.pid,"SIGSTOP");}
    });
    if(mode==="tx-committed"){const {recordMemorySettlement}=await import("../server/memory/settlement.ts");recordMemorySettlement("thread-0","orphan-turn","working");process.send?.({type:"transaction-boundary"});}
    setInterval(()=>{},1000);return;
  }
  if(mode.startsWith("lease-")){
    const {claimMemoryJob,publishMemoryWork,heartbeatMemoryJob}=await import("../server/memory/jobs.ts");const {captureWork}=await import("../server/memory/chunks.ts");
    const work=claimMemoryJob(mode);assert(work);process.send?.({type:"lease-claimed",generation:work.leaseGeneration});
    process.on("message",()=>{const heartbeat=heartbeatMemoryJob(work,mode);try{publishMemoryWork(work,mode,captureWork(work));process.send?.({type:"lease-result",accepted:true,heartbeat});}catch{process.send?.({type:"lease-result",accepted:false,heartbeat});}});return;
  }
  if(mode==="restored-query"){
    const {inspectInstallationDatabase}=await import("../server/installation-database-snapshot.ts");inspectInstallationDatabase(database());
    assert.equal(database().prepare("SELECT mode FROM memory_meta").get()?.mode,"paused");
    const rows=database().prepare("SELECT state FROM memory_sources").all();assert(rows.length>0&&rows.every(row=>row.state==="deleted"));
    const {MemoryWorkerController}=await import("../server/memory/worker-controller.ts");const {setMemoryMode}=await import("../server/memory/repository.ts");setMemoryMode("active");
    const controller=new MemoryWorkerController({modelDirectory:model});controller.start();
    try{await until("restored worker",()=>controller.status().ready?true:undefined,30000);
      const meta=database().prepare("SELECT policy_revision,deletion_epoch FROM memory_meta").get()!;
      const scopes=database().prepare("SELECT id FROM memory_scopes").all().map(row=>String(row.id));
      // Cold model initialization is explicit setup, not credited as a 500ms warm query.
      const input={query:"FORGOTTEN_BACKUP_CANARY",scopeIds:scopes,policyRevision:Number(meta.policy_revision),deletionEpoch:Number(meta.deletion_epoch),historical:true,cursor:"",limit:10,semantic:true};
      const found=await controller.search(input,AbortSignal.timeout(60000));assert.equal(found.hits.length,0);process.send?.({type:"restored-result",excluded:true});
    }finally{await controller.stop();closeDatabase();}return;
  }
  throw Error("Unknown internal probe");
}

async function nativeFullVolume(root:string,model:string):Promise<Result>{
  if(process.platform!=="darwin"||!existsSync("/usr/bin/hdiutil"))return {id:"native-os-full",status:"UNVERIFIED",observations:{platform:process.platform},limitations:["The bounded native OS-full fixture requires macOS hdiutil; SQLite quota evidence is reported separately."]};
  const image=join(root,"owned-full-volume.dmg"),mount=join(root,"mount");mkdirSync(mount);
  const run=promisify(execFile);let attached=false,stage="create";
  const detach=async()=>{
    if(!attached)return;
    try{await run("/usr/bin/hdiutil",["detach",mount],{timeout:15000,maxBuffer:1024*1024});attached=false;}
    catch{try{await run("/usr/bin/hdiutil",["detach","-force",mount],{timeout:15000,maxBuffer:1024*1024});attached=false;}
      catch{writeFileSync(join(root,".preserve-owned-mount"),mount);throw Error(`Task-owned disk image remains mounted at ${mount}; preserve fixture for exact-handle cleanup`);}}
  };
  shutdown.add(detach);
  try{
    try{
      // hdiutil create -help lists UDIF for a new read/write image; UDRW is
      // a conversion format, not an accepted new-image -type value.
      await run("/usr/bin/hdiutil",["create","-size","32m","-fs","HFS+","-volname","MurageMemoryFault","-type","UDIF",image],{timeout:30000,maxBuffer:1024*1024});
      stage="attach";
      await run("/usr/bin/hdiutil",["attach","-nobrowse","-mountpoint",mount,image],{timeout:30000,maxBuffer:1024*1024});attached=true;
    }catch(error){const failure=error as NodeJS.ErrnoException&{stdout?:string;stderr?:string};
      return {id:"native-os-full",status:"UNVERIFIED",observations:{imageSizeMiB:32,tool:"hdiutil",stage,code:failure.code,stdout:String(failure.stdout??"").slice(-8192),stderr:String(failure.stderr??"").slice(-8192)},limitations:["Native image setup failed before OS-full injection; classify the retained exact tool output, not the numeric exit code alone."]};}
    const probe=spawnProbe(root,"os-full",model,"mount/profile");try{const observed=await probe.wait("os-full-result");return {id:"native-os-full",status:"PASS",observations:observed};}finally{await terminate(probe.child);}
  }finally{shutdown.delete(detach);await detach();}
}

async function main(){
  const model=resolve(arg("--model-directory",join(repo,".planning/memory-evidence/model")));
  const rootArg=arg("--fixture-root");
  if(rootArg){
    const root=resolve(rootArg);assert.equal(readFileSync(join(root,".memory-fault-fixture"),"utf8"),fixtureMark);
    const subdir=arg("--database-subdir","data");assert(["data","restored","mount/profile"].includes(subdir));process.env.MURAGE_DATA_DIR=join(root,subdir);mkdirSync(process.env.MURAGE_DATA_DIR,{recursive:true});
    if(arg("--probe"))return probe(arg("--probe"),root,model);
    let result:Result;try{result=await runCase(arg("--case"),root,model);result.observations={...caseObservations,...result.observations};}catch(error){result={id:arg("--case"),status:"FAIL",observations:caseObservations,error:error instanceof Error?error.stack:String(error)};}
    console.log(JSON.stringify(result));return;
  }
  const raw=readFileSync(join(repo,"server/memory/testing/corpus.json"),"utf8"),corpus=validateCorpus(JSON.parse(raw));
  const normalUse=argv.includes("--normal-use");
  assert(!normalUse||!argv.includes("--only")&&!argv.includes("--diagnostic"),"--normal-use is the separate N01 profile; do not combine it with --only/--diagnostic");
  const selectedIds=normalUse?["N01"]:arg("--only")?arg("--only").split(","):corpus.faultProtocols.map(protocol=>protocol.id);
  assert(selectedIds.length>0&&new Set(selectedIds).size===selectedIds.length,"Empty or duplicate fault selection");
  assert(normalUse||selectedIds.every(id=>corpus.faultProtocols.some(protocol=>protocol.id===id)),"Unknown frozen fault selection");
  const diagnostic=arg("--diagnostic");
  assert(!diagnostic||(diagnostic==="seeded-index"&&selectedIds.length===1&&selectedIds[0]==="F10"),"seeded-index diagnosis requires --only F10");
  const startedAt=new Date().toISOString();
  const identity=["scripts/verify-memory-faults.ts","scripts/control-murage.ts","server/index.ts","server/memory/jobs.ts","server/memory/worker-controller.ts","server/memory/restore.ts","server/database.ts","server/memory/consolidate.ts","shared/memory-model-manifest.json"].map(path=>({path,sha256:sha(readFileSync(join(repo,path),"utf8"))}));
  const observedText=normalUse?readFileSync(join(repo,normalUseProfile.observedUsageEvidence),"utf8"):undefined;
  const normalEvidence=observedText?{path:normalUseProfile.observedUsageEvidence,sha256:sha(observedText),metadata:JSON.parse(observedText)}:undefined;
  const manifest=JSON.parse(readFileSync(join(repo,"shared/memory-model-manifest.json"),"utf8"));
  const results:Result[]=[];
  const protocols=normalUse?[{id:"N01"}]:corpus.faultProtocols.filter(protocol=>selectedIds.includes(protocol.id));
  for(const protocol of protocols){
    const root=mkdtempSync(join(tmpdir(),"murage-p10-fault-"));writeFileSync(join(root,".memory-fault-fixture"),fixtureMark,{mode:0o600});
    process.stderr.write(`P10 fault ${protocol.id} starting\n`);
    const child=fork(self,["--case",protocol.id,"--fixture-root",root,"--model-directory",model,...diagnostic?["--diagnostic",diagnostic]:[]],{execArgv:["--experimental-strip-types"],cwd:root,
      env:{HOME:root,USERPROFILE:root,TMPDIR:root,PATH:dirname(process.execPath),...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})},stdio:["ignore","pipe","pipe","ipc"]});
    let output="",errorOutput="";child.stdout?.on("data",data=>{output=(output+data).slice(-200000);});child.stderr?.on("data",data=>{errorOutput=(errorOutput+data).slice(-12000);process.stderr.write(data);});
    const cleanup=async()=>{writeFileSync(join(root,".preserve-timeout"),"Interrupted fault fixture; inspect exact process/mount handles before cleanup");await terminate(child,"SIGTERM");};
    shutdown.add(cleanup);let force:ReturnType<typeof setTimeout>|undefined;
    const timer=setTimeout(()=>{writeFileSync(join(root,".preserve-timeout"),"Fault deadline reached; inspect exact process/mount handles before cleanup");child.kill("SIGTERM");force=setTimeout(()=>child.kill("SIGKILL"),45000);},protocol.id==="F10"||protocol.id==="N01"?1000000:240000);
    try{
      const code=await new Promise<number|null>((done,reject)=>{child.once("exit",done);child.once("error",reject);});
      let result:Result;try{result=JSON.parse(output.trim().split("\n").at(-1)??"");assert.equal(result.id,protocol.id);assert(["PASS","FAIL","UNVERIFIED"].includes(result.status));}catch{result={id:protocol.id,status:"FAIL",observations:{exitCode:code},error:errorOutput||"No valid fault receipt"};}
      results.push(result);process.stderr.write(`P10 fault ${protocol.id}: ${result.status}\n`);
    }finally{shutdown.delete(cleanup);clearTimeout(timer);clearTimeout(force);await terminate(child);if(existsSync(join(root,".preserve-owned-mount"))||existsSync(join(root,".preserve-timeout")))process.stderr.write(`Preserved task-owned fault fixture: ${root}\n`);else rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
  }
  const focusedPassed=results.length===selectedIds.length&&results.every(result=>result.status==="PASS");
  const receipt={version:1,phase:normalUse?"P10-normal-use":"P10-faults",status:diagnostic?"DIAGNOSTIC_ONLY":focusedPassed?(normalUse?"NORMAL_USE_PASS":results.length===12?"ACCEPTED":"FOCUSED_PASS"):"BLOCKED",node:process.version,platform:process.platform,arch:process.arch,fixtureSha256:sha(raw),identity,
    startedAt,finishedAt:new Date().toISOString(),model:{id:manifest.model,revision:manifest.revision,runtimeVersion:manifest.runtimeVersion},
    ...normalUse?{profileDefinition:normalUseProfile,observedUsageEvidence:normalEvidence,stressGate:{id:"F10",status:"DEFERRED",execution:"UNEXECUTED",reason:"User explicitly deferred the sustained stress gate; N01 is a separate normal-use proof."}}:{},
    selectedIds,unexecutedIds:corpus.faultProtocols.filter(protocol=>!selectedIds.includes(protocol.id)).map(protocol=>protocol.id),reusedPasses:[],
    frozenProtocols:corpus.faultProtocols,results,paidModelCalls:0,limitations:["UNVERIFIED subgates are not passes; see each result's exact unmet protocol/platform boundary.","Focused receipts do not mark omitted faults passed. Root must explicitly combine still-valid saved receipts for aggregate acceptance."]};
  const out=resolve(arg("--out",join(repo,normalUse?".planning/memory-evidence/normal-use.json":".planning/memory-evidence/faults.json")));mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(receipt,null,2)+"\n");
  console.log(JSON.stringify({status:receipt.status,out,results:results.map(({id,status})=>({id,status}))}));if(!diagnostic&&!focusedPassed)process.exitCode=1;
}
main().catch(error=>{console.error(error instanceof Error?error.stack:String(error));process.exitCode=1;});
