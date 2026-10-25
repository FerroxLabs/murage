import { BACKGROUND_BUSY_MS, database, isDatabaseBusy, transaction } from "../database.ts";
import { ensureScope } from "./policy.ts";
import { memoryState } from "./repository.ts";
import { readMemoryLearning } from "./learning-policy.ts";
import { contentStampOf, PagedScan, storeAtMost } from "./status-scan.ts";

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
 * turn a successful capture/read into a failed task.
 *
 * Retrieval and processing counters are held in memory and written once a minute by the
 * worker's idle sweep: the old per-search write was a BEGIN IMMEDIATE with an fsync on the
 * recall path and woke the worker in the middle of a turn (AUDIT B1). */
const pending={queries:0,hits:0,lastAt:null as number|null,processedAt:null as number|null};
let lastFlushAt=0;
export const COUNTER_FLUSH_MS=60_000;
/** Count one search. Memory only: no database write on the recall path. */
export function recordMemoryRetrieval(hits:number){if(Number.isSafeInteger(hits)&&hits>=0){pending.queries++;pending.hits+=hits;pending.lastAt=Date.now();}}
export function recordMemoryProcessing(at:number){if(Number.isSafeInteger(at)&&at>=0)pending.processedAt=Math.max(pending.processedAt??0,at);}
/** Write what was counted since the last flush. Called from the worker's idle sweep (at most once a minute) and at quit. */
export function flushMemoryCounters(now=Date.now(),force=false):boolean{
  if(!pending.queries&&pending.processedAt===null)return false;
  if(!force&&now-lastFlushAt<COUNTER_FLUSH_MS)return false;
  const queries=pending.queries,hits=pending.hits,lastAt=pending.lastAt,processedAt=pending.processedAt;
  try{
    transaction(db=>{
      const previous=metrics()??{queries:0,hits:0,lastAt:null,processedAt:null};
      const next={queries:previous.queries+queries,hits:previous.hits+hits,lastAt:lastAt??previous.lastAt,processedAt:Math.max(previous.processedAt??0,processedAt??0)||previous.processedAt};
      const scope=ensureScope("workspace",memoryState().installationId);
      db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','observability',0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent")
        .run(ID,scope,JSON.stringify(next));
    },{op:"observe",busyMs:BACKGROUND_BUSY_MS});
  }catch(error){lastFlushAt=now;if(!isDatabaseBusy(error)){/* unavailable observation is not failed memory work; the counts stay for the next flush */}return false;}
  lastFlushAt=now;
  pending.queries-=queries;pending.hits-=hits;
  if(pending.processedAt===processedAt)pending.processedAt=null;
  return true;
}
/** Test hook: forget what was counted and when it was last written. */
export function resetMemoryCounters(){pending.queries=0;pending.hits=0;pending.lastAt=null;pending.processedAt=null;lastFlushAt=0;}

interface CapturedCounts{captured:number;lastAt:number|null;processed:number}
const HEALTH_SCAN_PAGE=400;
/** Minimum time between two passes: the figures are for the Details line, not for a live display. */
export const STATUS_SCAN_INTERVAL_MS=10*60_000;
const COUNTED=`s.state!='deleted' AND json_extract(v.payload,'$.excluded') IS NULL AND length(json_extract(v.payload,'$.text'))>0`;
/** The figures memoryHealth always reported, taken a page of sources at a time. */
const healthScan=new PagedScan<CapturedCounts,CapturedCounts>({
  init:()=>({captured:0,lastAt:null,processed:0}),
  page(db,cursor,acc,limit){
    const rows=db.prepare(`SELECT s.rowid AS rid,coalesce(${COUNTED},0) AS counted,v.created_at AS at,
        EXISTS(SELECT 1 FROM memory_jobs j WHERE j.source_id=s.id AND j.source_revision=s.revision AND j.stage='capture' AND j.status='complete') AS done
      FROM memory_sources s LEFT JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
      WHERE s.rowid>? ORDER BY s.rowid LIMIT ?`).all(cursor,limit);
    if(!rows.length)return null;
    for(const row of rows){
      if(!Number(row.counted))continue;
      acc.captured++;if(Number(row.done))acc.processed++;
      const at=Number(row.at);if(acc.lastAt===null||at>acc.lastAt)acc.lastAt=at;
    }
    return Number(rows[rows.length-1].rid);
  },
  finish:acc=>({...acc}),
  stamp:db=>contentStampOf(db,["memory_sources","memory_source_versions"]),
},STATUS_SCAN_INTERVAL_MS,HEALTH_SCAN_PAGE);
interface SuppliedCounts{turns:number;references:number;lastAt:number|null}
const SUPPLIED_NOW="SELECT count(*) n,coalesce(sum(json_array_length(record_versions)),0) refs,max(created_at) at FROM memory_disclosures WHERE state='delivered' AND json_array_length(record_versions)>0";
/** The delivered-receipt aggregate, taken a page of receipts at a time by rowid (the same pattern as the health figures), so opening Memory never
 * walks the receipt table on the serving thread; a store this small is measured on the spot. */
const suppliedScan=new PagedScan<SuppliedCounts,SuppliedCounts>({
  init:()=>({turns:0,references:0,lastAt:null}),
  page(db,cursor,acc,limit){
    const rows=db.prepare(`SELECT rowid AS rid,state,json_array_length(record_versions) AS refs,created_at AS at FROM memory_disclosures WHERE rowid>? ORDER BY rowid LIMIT ?`).all(cursor,limit);
    if(!rows.length)return null;
    for(const row of rows){
      if(row.state!=="delivered"||!(Number(row.refs)>0))continue;
      acc.turns++;acc.references+=Number(row.refs);
      const at=Number(row.at);if(acc.lastAt===null||at>acc.lastAt)acc.lastAt=at;
    }
    return Number(rows[rows.length-1].rid);
  },
  finish:acc=>({...acc}),
  stamp:db=>contentStampOf(db,["memory_disclosures"])+":"+deliveredCount(db),
},STATUS_SCAN_INTERVAL_MS,HEALTH_SCAN_PAGE);
/** Delivered receipts (the state index): a receipt delivered in place changes no rowid and no revision, so the supplied figures stamp on this
 *  count too (Astra 105 review, finding 5). */
function deliveredCount(db:ReturnType<typeof database>):string{try{return String(db.prepare("SELECT count(*) AS n FROM memory_disclosures WHERE state='delivered'").get()?.n??"-");}catch{return "-";}}
/** Receipts are large JSON rows: a count of rows is a poor test of "small", so only a few hundred are measured on the spot. */
export const SUPPLIED_SMALL_ROWS=500;
function suppliedCounts(db:ReturnType<typeof database>):{counts:SuppliedCounts;asOf:number|null}{
  if(storeAtMost(db,["memory_disclosures"],SUPPLIED_SMALL_ROWS)){
    const row=db.prepare(SUPPLIED_NOW).get()!;
    const counts={turns:Number(row.n),references:Number(row.refs),lastAt:row.at===null?null:Number(row.at)};
    suppliedScan.set(counts);return {counts,asOf:Date.now()};
  }
  return {counts:suppliedScan.result??{turns:0,references:0,lastAt:null},asOf:suppliedScan.asOf};
}
function measureHealthNow(db:ReturnType<typeof database>):CapturedCounts{
  const captured=db.prepare(`SELECT count(*) n,max(v.created_at) at FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
    WHERE ${COUNTED}`).get()!;
  const processed=db.prepare(`SELECT count(DISTINCT s.id) n FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
    WHERE ${COUNTED}
    AND EXISTS(SELECT 1 FROM memory_jobs j WHERE j.source_id=s.id AND j.source_revision=s.revision AND j.stage='capture' AND j.status='complete')`).get()!;
  return {captured:Number(captured.n),lastAt:captured.at===null?null:Number(captured.at),processed:Number(processed.n)};
}
/** The last finished figures and when they were taken. A small store is measured now, as before. */
function capturedCounts(db:ReturnType<typeof database>):{counts:CapturedCounts;asOf:number|null}{
  if(storeAtMost(db,["memory_sources"])){const counts=measureHealthNow(db);healthScan.set(counts);return {counts,asOf:Date.now()};}
  return {counts:healthScan.result??{captured:0,lastAt:null,processed:0},asOf:healthScan.asOf};
}
/** One slice of the background pass (worker idle sweep). True when the pass has more to do. */
export function stepHealthScan(budgetMs=15,now=Date.now()):boolean{
  const db=database();
  // A small store is measured on the spot when Details asks; there is nothing to prepare for it.
  const health=!healthScan.running&&storeAtMost(db,["memory_sources"])?false:healthScan.step(db,budgetMs,now);
  const supplied=!suppliedScan.running&&storeAtMost(db,["memory_disclosures"],SUPPLIED_SMALL_ROWS)?false:suppliedScan.step(db,budgetMs,now);
  return health||supplied;
}
export function resetHealthScan(){healthScan.clear();suppliedScan.clear();}

export function memoryHealth(extractorInstanceId:string|null){
  const db=database(),observed=metrics(),learning=readMemoryLearning(db);
  const {counts,asOf:capturedAsOf}=capturedCounts(db);
  const {counts:supplied,asOf:suppliedAsOf}=suppliedCounts(db);
  // the older of the two figures is the one the line is as of
  const asOf=capturedAsOf===null||suppliedAsOf===null?null:Math.min(capturedAsOf,suppliedAsOf);
  const state: "not-configured"|"disabled"|"configured"|"budget-limited" = !learning.automaticFacts&&!learning.automaticProcedures ? "disabled"
    : !extractorInstanceId ? "not-configured" : learning.ceiling.input===0||learning.ceiling.output===0||learning.callsPerMinute===0 ? "budget-limited" : "configured";
  return {
    asOf,
    captured:{sources:counts.captured,lastAt:counts.lastAt},
    processed:{sources:counts.processed,lastAt:Math.max(observed?.processedAt??0,pending.processedAt??0)||null},
    retrieved:{queries:(observed?.queries??0)+(observed?pending.queries:0),hits:(observed?.hits??0)+(observed?pending.hits:0),lastAt:Math.max(observed?.lastAt??0,observed?pending.lastAt??0:0)||null,available:Boolean(observed)},
    supplied:{turns:supplied.turns,references:supplied.references,lastAt:supplied.lastAt},
    synthesis:{state,reason:state==="not-configured"?"Choose an extraction connection for distilled learning; capture and recall remain available."
      :state==="disabled"?"Automatic learning is disabled."
        :state==="budget-limited"?"A configured token or call limit prevents synthesis."
          :"A synthesis connection is configured; this does not by itself prove a completed extraction."},
  };
}
