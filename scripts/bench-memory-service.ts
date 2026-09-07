import { mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join,resolve,dirname } from "node:path";
import { createHash } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { validateCorpus } from "../server/memory/testing/contracts.ts";

const args=process.argv.slice(2);
function arg(key:string,fallback:string){const i=args.indexOf(key);return i<0?fallback:args[i+1];}
function number(key:string,fallback:string,max:number){const value=Number(arg(key,fallback));if(!Number.isSafeInteger(value)||value<1||value>max)throw new Error(`invalid ${key}`);return value;}
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function percentile(values:number[],p:number){return [...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];}

async function main(){
  const corpusText=readFileSync(resolve(arg("--fixture","server/memory/testing/corpus.json")),"utf8"),corpus=validateCorpus(JSON.parse(corpusText));
  const active=number("--active-chunks","10000",12000),history=number("--history-records","100000",100000),concurrency=number("--concurrency","8",8);
  if(history<active)throw new Error("history must cover active records");
  const root=mkdtempSync(join(tmpdir(),"murage-memory-service-benchmark-"));process.env.MURAGE_DATA_DIR=root;
  const {database,closeDatabase,transaction}=await import("../server/database.ts");
  const {reconcileMemoryRoster,ensureScope,memoryAccess}=await import("../server/memory/policy.ts");
  const {InternalCapabilities}=await import("../server/internal-capabilities.ts");
  const {MemoryWorkerController}=await import("../server/memory/worker-controller.ts");
  const {searchMemory}=await import("../server/memory/search.ts");
  const {setMemoryMode}=await import("../server/memory/repository.ts");
  const roster={bots:Array.from({length:20},(_,i)=>({id:`bot-${i}`,threadId:`thread-${i}`})),groups:[]};
  reconcileMemoryRoster(roster);const scope=ensureScope("project","benchmark");
  const sourceRows=corpus.sources.filter(s=>s.state==="active"&&s.scope!=="private-other");
  transaction(db=>{
    for(const bot of roster.bots)db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'bot',?,0,'granted','{}')").run(`grant-${bot.id}`,scope,bot.id);
    for(const source of sourceRows){
      db.prepare("INSERT INTO memory_sources VALUES(?,?,NULL,NULL,NULL,1,?,'text','owner','recorded',NULL,'active')").run(source.id,scope,createHash("sha256").update(source.text).digest("hex"));
      db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,1)").run(source.id,createHash("sha256").update(source.text).digest("hex"),JSON.stringify({text:source.text}));
    }
    const insert=db.prepare("INSERT INTO memory_records VALUES(?,1,?,'source',?,'owner-statement',?,0,1,NULL,NULL,1)");
    const evidence=db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,1,0,?)");
    const projection=db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,1,?,'pending',NULL)");
    for(let i=0;i<history;i++){
      const source=sourceRows[i%sourceRows.length],id=createHash("sha256").update(`record-${i}`).digest("hex");
      insert.run(id,scope,source.text,i<active?"active":"archived");evidence.run(id,source.id,Buffer.byteLength(source.text));projection.run(id,i<active?"pending":"pending-archive");
    }
  });
  setMemoryMode("capture");const controller=new MemoryWorkerController({modelDirectory:resolve(".planning/memory-evidence/model")});
  const beforeRss=process.memoryUsage().rss;controller.start();
  const monitor=monitorEventLoopDelay({resolution:10});
  const out=resolve(arg("--out",".planning/memory-evidence/service-bench.json"));
  try{
    const start=performance.now();let indexed=0;
    while(performance.now()-start<180000){
      indexed=Number(database().prepare("SELECT count(*) AS n FROM memory_projection_receipts p JOIN memory_records r ON r.id=p.record_id AND r.version=p.record_version WHERE r.state='active' AND p.embedding_status='indexed'").get()!.n);
      if(indexed===active)break;await sleep(200);
    }
    if(indexed!==active)throw new Error(`index preparation incomplete: ${indexed}/${active}; ${controller.error??"pending"}`);
    const warmupMs=performance.now()-start;
    const registry=new InternalCapabilities();
    const contexts=roster.bots.slice(0,concurrency).map(bot=>{
      registry.begin(bot.id,bot.threadId,"bench");const token=registry.mint({botId:bot.id,threadId:bot.threadId,generation:"bench",depth:0,kind:"memory",skillAuthoring:false});
      return memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster);
    });
    const lexicalOnly=args.includes("--lexical");
    const bridge=lexicalOnly?{search:(input:Parameters<typeof controller.search>[0],signal:AbortSignal)=>controller.search({...input,semantic:false},signal)}:controller;
    const latency:number[]=[],failures:string[]=[],profiles:unknown[]=[];let semanticCalls=0,workerPeakRssBytes=0;
    monitor.enable();
    for(let batch=0;batch<10;batch++){
      await Promise.all(contexts.map(async(context,i)=>{
        const source=sourceRows[(batch*concurrency+i)%sourceRows.length];const started=performance.now();
        try{
          const result=await searchMemory(source.text,context,bridge,{limit:10,profile:args.includes("--profile")});
          if((lexicalOnly&&result.vectorRows!==0)||(!lexicalOnly&&result.vectorRows<active)||!result.hits.some(hit=>hit.evidence.some(e=>e.sourceId===source.id)))throw new Error("expected source not retrieved");
          workerPeakRssBytes=Math.max(workerPeakRssBytes,Number((result as typeof result & {workerPeakRssBytes?:number}).workerPeakRssBytes??0));
          if(args.includes("--profile")){const trace=result as typeof result & {profile?:unknown;profileCacheHit?:boolean;serviceProfile?:object};profiles.push({cacheHit:trace.profileCacheHit,...trace.profile as object,...trace.serviceProfile});}
          semanticCalls++;
        }catch(error){failures.push(error instanceof Error?error.message:String(error));}
        latency.push(performance.now()-started);
      }));
    }
    await sleep(25);monitor.disable();
    const result={phase:"P06",backend:lexicalOnly?"actual-Murage-service-worker-lexical":"actual-Murage-service-worker-local-model",node:process.version,platform:process.platform,arch:process.arch,
      activeChunks:active,historyRecords:history,concurrentCallers:concurrency,warmupMs,semanticCalls:lexicalOnly?0:semanticCalls,lexicalCalls:lexicalOnly?semanticCalls:0,completedCalls:semanticCalls,totalCalls:latency.length,
      fixtureHash:createHash("sha256").update(corpusText).digest("hex"),latencyMs:{p95:percentile(latency,.95),p99:percentile(latency,.99)},
      mainEventLoopP99Ms:monitor.percentile(99)/1e6,mainRssIncreaseBytes:Math.max(0,process.memoryUsage().rss-beforeRss),workerPeakRssBytes,failures,...args.includes("--profile")?{profiles}:{},
      limitations:["Retrieval service boundary measured; final adapter preparation belongs to P07/P10","No answer-generation or external model calls","Worker RSS separately qualified; load/drain acceptance remains P10"]};
    mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify(result));
    if(failures.length||result.latencyMs.p95>(lexicalOnly?50:200)||result.latencyMs.p99>(lexicalOnly?100:400)||result.mainEventLoopP99Ms>20||result.mainRssIncreaseBytes>128*1024**2||workerPeakRssBytes>1024**3)process.exitCode=1;
  }finally{monitor.disable();await controller.stop();closeDatabase();rmSync(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
