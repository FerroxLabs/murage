// P10 canonical retrieval evaluation. Native answer generation is a separate,
// explicitly budgeted gate; no fake answers or external model calls occur here.
// Frozen expansion: each long-history query prepends exactly its declared count
// of deterministic unrelated inventory notes to BOTH backends. Only that query's
// extra records are active, keeping the real worker below its global vector cap.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { families, validateCorpus, type MemoryCorpus } from "../server/memory/testing/contracts.ts";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

type Query = MemoryCorpus["queries"][number];
export interface EvidenceScore {
  recallAt10:number|null; precisionNumerator:number; precisionDenominator:number;
  abstained:boolean; forbiddenIds:string[]; unsupportedIds:string[];
}
export function scoreEvidence(query:Query,ranked:string[],delivered:string[]):EvidenceScore {
  const top=[...new Set(ranked.slice(0,10))],final=[...new Set(delivered)];
  const gold=new Set(query.expected),forbidden=new Set(query.forbidden);
  return {recallAt10:gold.size?top.filter(id=>gold.has(id)).length/gold.size:null,
    precisionNumerator:final.filter(id=>gold.has(id)).length,precisionDenominator:final.length,
    abstained:final.length===0,forbiddenIds:[...new Set([...top,...final].filter(id=>forbidden.has(id)))],
    unsupportedIds:final.filter(id=>!gold.has(id))};
}
type Case = {id:string;family:Query["family"];expected:string[];ranked:string[];delivered:string[];score:EvidenceScore;error?:string;degradedReason?:string;latencyMs?:number};
export function summarizeEvidence(rows:Case[]) {
  if(!rows.length)throw Error("Evaluation collected zero cases");
  if(new Set(rows.map(row=>row.id)).size!==rows.length)throw Error("Duplicate evaluation case identity");
  const answerable=rows.filter(row=>row.expected.length),noAnswer=rows.filter(row=>!row.expected.length);
  const numerator=rows.reduce((sum,row)=>sum+row.score.precisionNumerator,0),denominator=rows.reduce((sum,row)=>sum+row.score.precisionDenominator,0);
  return {cases:rows.length,answerable:answerable.length,noAnswer:noAnswer.length,
    recallAt10:answerable.length?answerable.reduce((sum,row)=>sum+(row.score.recallAt10??0),0)/answerable.length:null,
    finalEvidencePrecision:denominator?numerator/denominator:1,emittedEvidence:denominator,
    noAnswerAbstention:noAnswer.length?noAnswer.filter(row=>row.score.abstained&&!row.error).length/noAnswer.length:null,
    forbiddenCases:rows.filter(row=>row.score.forbiddenIds.length).map(row=>row.id),
    errorCases:rows.filter(row=>row.error).map(row=>row.id),
    failedCases:rows.filter(row=>row.error||row.score.forbiddenIds.length||row.score.unsupportedIds.length||row.expected.length&&row.score.recallAt10!==1||!row.expected.length&&!row.score.abstained).map(row=>row.id)};
}
const sleep=(ms:number)=>new Promise(done=>setTimeout(done,ms));
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const args=process.argv.slice(2);
function option(name:string,fallback:string){const i=args.indexOf(name);if(i<0)return fallback;const value=args[i+1];if(!value||value.startsWith("--"))throw Error(`Missing ${name}`);return value;}

async function main() {
  if(args.includes("--answers")||args.includes("--allow-paid"))throw Error("Answer generation requires the separate root-reserved native runner; this evaluator never spends implicitly");
  const fixturePath=resolve(option("--fixture","server/memory/testing/corpus.json"));
  const raw=readFileSync(fixturePath,"utf8"),corpus=validateCorpus(JSON.parse(raw));
  const out=resolve(option("--out",".planning/memory-evidence/eval.json"));
  const modelDirectory=resolve(option("--model-directory",".planning/memory-evidence/model"));
  const repo=fileURLToPath(new URL("..",import.meta.url));
  const modelManifest=JSON.parse(readFileSync(join(repo,"shared/memory-model-manifest.json"),"utf8"));
  const sourceIdentity=["scripts/eval-memory.ts","server/memory/search.ts","server/memory/bundle.ts","server/memory/worker-controller.ts","server/memory/worker.ts","server/memory/index.ts","server/memory/embeddings.ts","server/workspace.ts","shared/memory-model-manifest.json"]
    .map(path=>({path,sha256:hash(readFileSync(join(repo,path),"utf8"))}));
  const root=mkdtempSync(join(tmpdir(),"murage-p10-eval-"));process.env.MURAGE_DATA_DIR=root;
  const {database,transaction,closeDatabase}=await import("../server/database.ts");
  const {reconcileMemoryRoster,ensureScope,memoryAccess}=await import("../server/memory/policy.ts");
  const {InternalCapabilities}=await import("../server/internal-capabilities.ts");
  const {MemoryWorkerController}=await import("../server/memory/worker-controller.ts");
  const {setMemoryMode}=await import("../server/memory/repository.ts");
  const {searchMemory}=await import("../server/memory/search.ts");
  const {buildMemoryBundle,assertMemoryBundle}=await import("../server/memory/bundle.ts");
  const {writeMemoryFile,loadMemory}=await import("../server/workspace.ts");
  const scopeNames=[...new Set(corpus.sources.map(source=>source.scope).concat(corpus.queries.flatMap(query=>query.allowedScopes)))];
  const roster={bots:corpus.queries.map(query=>({id:`eval-${query.id}`,threadId:`eval-thread-${query.id}`})),groups:[]};
  const sourceScopes=new Map<string,string>();
  reconcileMemoryRoster(roster);for(const name of scopeNames)sourceScopes.set(name,ensureScope("project",name));
  function insertSource(source:{id:string;revision:number;scope:string;text:string;state:string;assertion:string;threadId:string;messageId:string;role:string}) {
    const db=database(),scopeId=sourceScopes.get(source.scope)!;
    const payload=JSON.stringify({text:source.text,kind:"text",speaker:source.role,outcome:"recorded"});
    db.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,revision,content_hash,kind,speaker,outcome,state) VALUES(?,?,?,?,?,?,'text',?,'recorded',?)")
      .run(source.id,scopeId,source.threadId,source.messageId,source.revision,hash(payload),source.role,source.state==="active"?"active":source.state==="deleted"?"deleted":"retired");
    db.prepare("INSERT INTO memory_source_versions(source_id,revision,content_hash,payload,created_at) VALUES(?,?,?,?,1)").run(source.id,source.revision,hash(payload),payload);
    db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,created_at) VALUES(?,1,?,'fact',?,?,?,0,1,1)")
      .run(source.id,scopeId,source.text,source.assertion,source.state);
    db.prepare("INSERT INTO memory_evidence(record_id,record_version,source_id,source_revision,start_byte,end_byte) VALUES(?,1,?,?,0,?)").run(source.id,source.id,source.revision,Buffer.byteLength(source.text));
    db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,1,?,'pending',NULL)").run(source.id,source.state==="active"?"pending":source.state==="deleted"?"delete-pending":"pending-archive");
  }
  transaction(db=>{
    for(const query of corpus.queries)for(const name of query.allowedScopes){
      const scopeId=sourceScopes.get(name);
      if(!scopeId)throw Error(`Frozen query ${query.id} refers to an unseeded scope`);
      db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'bot',?,0,'granted','{}')").run(`grant-${query.id}-${name}`,scopeId,`eval-${query.id}`);
    }
    for(const source of corpus.sources)insertSource(source);
    db.exec("UPDATE memory_meta SET data_revision=data_revision+1");
  });
  setMemoryMode("active");
  const registry=new InternalCapabilities();
  const contexts=new Map(corpus.queries.map(query=>{
    const bot=roster.bots.find(bot=>bot.id===`eval-${query.id}`)!;
    const generation=registry.begin(bot.id,bot.threadId);
    const token=registry.mint({botId:bot.id,threadId:bot.threadId,generation,kind:"memory",depth:0,skillAuthoring:false});
    return [query.id,memoryAccess(registry,registry.resolve(`Bearer ${token}`)!,()=>roster)] as const;
  }));
  const controller=new MemoryWorkerController({modelDirectory});
  const cases:Case[]=[],baseline:Case[]=[],pins:Array<{id:string;passed:boolean;error?:string}>=[];
  let preparationError:string|undefined,workerPeakRssBytes=0;
  controller.start();
  async function drain(label:string,timeout=180000) {
    const deadline=Date.now()+timeout;
    for(;;){
      const pending=Number(database().prepare("SELECT count(*) AS n FROM memory_projection_receipts WHERE lexical_status IN ('pending','pending-archive','delete-pending')").get()!.n);
      if(!pending&&controller.status().ready){
        const missing=Number(database().prepare("SELECT count(*) AS n FROM memory_projection_receipts p JOIN memory_records r ON r.id=p.record_id AND r.version=p.record_version WHERE r.state='active' AND p.embedding_status!='indexed'").get()!.n);
        if(missing)throw Error(`${label}: ${missing} active records lack real local embeddings`);return;
      }
      if(Date.now()>deadline)throw Error(`${label}: projection drain timed out (${pending} pending; ${controller.error??"no worker error"})`);
      await sleep(100);
    }
  }
  try {
    await drain("initial corpus");
    for(const query of corpus.queries){
      const additions=Array.from({length:query.distractorCount??0},(_,i)=>({id:`history-${query.id}-${i}`,revision:1,scope:query.allowedScopes[0],threadId:`history-thread-${query.id}`,messageId:`history-message-${i}`,role:"user",state:"active",assertion:"owner-statement",text:`Unrelated inventory note ${String(i).padStart(4,"0")}. No policy decision was recorded.`}));
      if(additions.length){transaction(db=>{for(const source of additions)insertSource(source);db.exec("UPDATE memory_meta SET data_revision=data_revision+1");});await drain(query.id);}
      const notebook=[...additions,...corpus.sources.filter(source=>query.allowedScopes.includes(source.scope))];
      // Current baseline is positional notebook loading, not a lexical or
      // semantic ranker. Its entire delivered context is scored for precision;
      // recall@10 explicitly uses the first ten complete visible source lines.
      writeMemoryFile("p10-baseline",notebook.map(source=>JSON.stringify({id:source.id,revision:source.revision,text:source.text})).join("\n"));
      const loaded=loadMemory("p10-baseline");
      if(!loaded)throw Error("Actual notebook baseline did not load");
      const visible=loaded.text.split("\n").flatMap(line=>{try{const value=JSON.parse(line);return typeof value.id==="string"?[value.id]:[];}catch{return [];}});
      baseline.push({id:query.id,family:query.family,expected:query.expected,ranked:visible.slice(0,10),delivered:visible,score:scoreEvidence(query,visible,visible)});
      const context=contexts.get(query.id)!;let ranked:string[]=[],delivered:string[]=[],error:string|undefined,degradedReason:string|undefined;
      const started=performance.now();
      try {
        const found=await searchMemory(query.query,context,controller,{limit:10});
        if(!found.vectorRows)throw Error("Wrong backend: semantic candidate path did not execute");
        workerPeakRssBytes=Math.max(workerPeakRssBytes,Number((found as typeof found&{workerPeakRssBytes?:number}).workerPeakRssBytes??0));
        ranked=[...new Set(found.hits.flatMap(hit=>hit.evidence.map(handle=>String(handle.sourceId))))];
        const bundle=await buildMemoryBundle(query.query,context,controller);assertMemoryBundle(bundle,context);
        delivered=bundle.sourceVersions.map(source=>source.id);degradedReason=bundle.degradedReason??found.degradedReason;
        for(const record of [...bundle.pinned,...bundle.checkpoint,...bundle.evidence])for(const handle of record.evidence){
          const row=database().prepare("SELECT payload FROM memory_source_versions WHERE source_id=? AND revision=?").get(handle.sourceId,handle.revision);
          if(!row||handle.endByte>Buffer.byteLength(JSON.parse(String(row.payload)).text))throw Error("Delivered source span is not reconstructible");
        }
      }catch(failure){error=failure instanceof Error?failure.message:String(failure);}
      cases.push({id:query.id,family:query.family,expected:query.expected,ranked,delivered,score:scoreEvidence(query,ranked,delivered),latencyMs:performance.now()-started,...error?{error}:{},...degradedReason?{degradedReason}:{}});
      if(additions.length){transaction(db=>{
        const ids=JSON.stringify(additions.map(source=>source.id));
        db.prepare("UPDATE memory_records SET state='deleted' WHERE id IN (SELECT value FROM json_each(?))").run(ids);
        db.prepare("UPDATE memory_sources SET state='deleted' WHERE id IN (SELECT value FROM json_each(?))").run(ids);
        db.prepare("UPDATE memory_projection_receipts SET lexical_status='delete-pending' WHERE record_id IN (SELECT value FROM json_each(?))").run(ids);
        db.exec("UPDATE memory_meta SET data_revision=data_revision+1");
      });await drain(`${query.id} cleanup`);}
      if(cases.length%20===0)process.stderr.write(`P10 retrieval ${cases.length}/240 complete\n`);
    }
    for(const query of corpus.queries.filter(query=>query.family==="exact-paraphrase")){
      const id=query.expected[0];if(!id)throw Error("Frozen pin trial lacks expected source");
      database().prepare("UPDATE memory_records SET owner_pinned=1 WHERE id=?").run(id);
      try{
        const bundle=await buildMemoryBundle("",contexts.get(query.id)!,controller);
        assertMemoryBundle(bundle,contexts.get(query.id)!);
        pins.push({id,passed:bundle.pinned.some(record=>record.id===id)&&bundle.sourceVersions.some(source=>source.id===id)});
      }catch(error){pins.push({id,passed:false,error:error instanceof Error?error.message:String(error)});}
      finally{database().prepare("UPDATE memory_records SET owner_pinned=0 WHERE id=?").run(id);}
    }
  }catch(error){preparationError=error instanceof Error?error.message:String(error);}
  finally{await controller.stop();closeDatabase();safeWipeSync(root);}
  const summary=cases.length?summarizeEvidence(cases):null;
  const baselineSummary=baseline.length?summarizeEvidence(baseline):null;
  const regression=cases.filter(row=>row.family==="exact-paraphrase"&&(row.score.recallAt10??0)<(baseline.find(before=>before.id===row.id)?.score.recallAt10??0)).map(row=>row.id);
  const accepted=!preparationError&&cases.length===240&&summary!.recallAt10!>=.95&&summary!.finalEvidencePrecision>=.98&&summary!.noAnswerAbstention!>=.95&&!summary!.forbiddenCases.length&&!summary!.errorCases.length&&pins.length===40&&pins.every(pin=>pin.passed)&&!regression.length;
  const result={version:1,phase:"P10-retrieval",status:accepted?"ACCEPTED":"BLOCKED",wholeP10Status:"PENDING",fixturePath,fixtureSha256:hash(raw),node:process.version,platform:process.platform,arch:process.arch,
    backend:"actual-searchMemory-buildMemoryBundle-MemoryWorkerController-offline-local-model",baselineBackend:"actual-workspace.loadMemory-positional-first10-and-entire-visible-context",modelDirectory,
    model:{id:modelManifest.model,revision:modelManifest.revision,runtimeVersion:modelManifest.runtimeVersion,dimensions:modelManifest.dimensions},sourceIdentity,
    expansion:{version:1,distractors:"Unrelated inventory note NNNN. No policy decision was recorded.",order:"declared distractors before corpus sources; same bytes/order for notebook",perLongHistoryQuery:1000},
    summary,baselineSummary,groups:Object.fromEntries(families.map(family=>{const rows=cases.filter(row=>row.family===family);return [family,rows.length?summarizeEvidence(rows):null];})),
    exactBaselineRegressions:regression,pins,workerPeakRssBytes,cases,baseline,preparationError,
    nativeAnswers:{status:"PENDING_BOUNDED_NATIVE_EXECUTION",required:60,completed:0,cases:corpus.answerCases},
    faults:{status:"PENDING_SEPARATE_FAULT_RUNNER"},limitations:["Synthetic frozen corpus; no real-world quality generalization","No native answer calls or judge outputs fabricated","Latency/resource/load gates are separate planned workload; these per-query durations are diagnostics"]};
  mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(result,null,2)+"\n");
  console.log(JSON.stringify({status:result.status,wholeP10Status:result.wholeP10Status,cases:cases.length,summary,baselineSummary,pinsPassed:pins.filter(pin=>pin.passed).length,out,preparationError}));
  if(!accepted)process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error instanceof Error?error.stack:String(error));process.exitCode=1;});
