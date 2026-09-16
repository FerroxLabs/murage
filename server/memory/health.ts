import { database,transaction } from "../database.ts";
import { ensureScope } from "./policy.ts";
import { memoryState } from "./repository.ts";
import { readMemoryLearning } from "./learning-policy.ts";

const ID="memory-observability";
type Metrics={queries:number;hits:number;lastAt:number|null;processedAt:number|null};
function metrics():Metrics|null{
  const row=database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(ID);
  if(!row)return null;
  try{
    const data=JSON.parse(String(row.intent));
    if(!Number.isSafeInteger(data.queries)||data.queries<0||!Number.isSafeInteger(data.hits)||data.hits<0)return null;
    return {queries:data.queries,hits:data.hits,lastAt:Number.isSafeInteger(data.lastAt)?data.lastAt:null,processedAt:Number.isSafeInteger(data.processedAt)?data.processedAt:null};
  }catch{return null;}
}
/** Counters contain no queries, source text or credentials. Observation must not
 * turn a successful capture/read into a failed task. */
function observe(patch:{hits?:number;processedAt?:number}){
  try{transaction(db=>{
    const previous=metrics()??{queries:0,hits:0,lastAt:null,processedAt:null};
    const next=patch.hits===undefined?{...previous,processedAt:patch.processedAt??previous.processedAt}
      :{...previous,queries:previous.queries+1,hits:previous.hits+patch.hits,lastAt:Date.now()};
    const scope=ensureScope("workspace",memoryState().installationId);
    db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','observability',0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent")
      .run(ID,scope,JSON.stringify(next));
  });}catch{/* unavailable observation is not failed memory work */}
}
export function recordMemoryRetrieval(hits:number){if(Number.isSafeInteger(hits)&&hits>=0)observe({hits});}
export function recordMemoryProcessing(at:number){if(Number.isSafeInteger(at)&&at>=0)observe({processedAt:at});}

export function memoryHealth(extractorInstanceId:string|null){
  const db=database(),observed=metrics(),learning=readMemoryLearning(db);
  const captured=db.prepare(`SELECT count(*) n,max(v.created_at) at FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
    WHERE s.state!='deleted' AND json_extract(v.payload,'$.excluded') IS NULL AND length(json_extract(v.payload,'$.text'))>0`).get()!;
  const processed=db.prepare(`SELECT count(DISTINCT s.id) n FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
    WHERE s.state!='deleted' AND json_extract(v.payload,'$.excluded') IS NULL AND length(json_extract(v.payload,'$.text'))>0
    AND EXISTS(SELECT 1 FROM memory_jobs j WHERE j.source_id=s.id AND j.source_revision=s.revision AND j.stage='capture' AND j.status='complete')`).get()!;
  const supplied=db.prepare("SELECT count(*) n,coalesce(sum(json_array_length(record_versions)),0) refs,max(created_at) at FROM memory_disclosures WHERE state='delivered' AND json_array_length(record_versions)>0").get()!;
  const state: "not-configured"|"disabled"|"configured"|"budget-limited" = !learning.automaticFacts&&!learning.automaticProcedures ? "disabled"
    : !extractorInstanceId ? "not-configured" : learning.dailyCostUsd!==null||learning.inputLimit===0||learning.outputLimit===0||learning.callsPerMinute===0 ? "budget-limited" : "configured";
  return {
    captured:{sources:Number(captured.n),lastAt:captured.at===null?null:Number(captured.at)},
    processed:{sources:Number(processed.n),lastAt:observed?.processedAt??null},
    retrieved:{queries:observed?.queries??0,hits:observed?.hits??0,lastAt:observed?.lastAt??null,available:Boolean(observed)},
    supplied:{turns:Number(supplied.n),references:Number(supplied.refs),lastAt:supplied.at===null?null:Number(supplied.at)},
    synthesis:{state,reason:state==="not-configured"?"Choose an extraction connection for distilled learning; capture and recall remain available."
      :state==="disabled"?"Automatic learning is disabled."
        :state==="budget-limited"?learning.dailyCostUsd!==null?"The selected cost ceiling needs a trusted pricing adapter before synthesis can run.":"A configured token or call limit prevents synthesis."
          :"A synthesis connection is configured; this does not by itself prove a completed extraction."},
  };
}
