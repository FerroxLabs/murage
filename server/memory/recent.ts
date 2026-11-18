import { recentViewPage, viewRecordText, RecallWorkBudget } from './recall-view-index.ts';
import { randomUUID } from "node:crypto";
import { BACKGROUND_BUSY_MS, database, DatabaseBusyError, isDatabaseBusy, withBusyBudget } from "../database.ts";
import { assertMemoryAccess, type MemoryAccess } from "./policy.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { refreshMemoryCheckpoint } from "./consolidate.ts";
import { CURRENT_MEMORY, REACHABLE_RECORD } from "./eligibility.ts";
import { isPipKind, PIP_ALL_KINDS_SQL } from "./pip-kinds.ts";
import type { IndexHit } from "./index.ts";
import { byScore } from "./ref-order.ts";

/** A small authorized catch-up uses the same durable leases as the worker.
 * At most two 64KiB source chunks; no synthesis/model work on this path.
 *
 * This WRITES (a claim, the records and a checkpoint), so it is not part of recall: searchMemory and bundle
 * assembly perform no writes at all (PROPOSAL-v2 10.1, AUDIT B1). The turn calls catchUpRecentMemory once,
 * before recall starts, so a message written a moment ago is still found while the worker is behind. */
export function materializeRecentMemory(access: MemoryAccess, signal?: AbortSignal, onCompleted?: (jobId:string)=>void, exclude?: { messageIds?: readonly string[]; withinMs?: number }) {
  const owner=`recall-${randomUUID()}`,start=performance.now();let completed=0;
  for(let n=0;n<2&&performance.now()-start<25;n++){
    signal?.throwIfAborted();assertMemoryAccess(access);
    const work=claimMemoryJob(owner,Date.now(),access.view,{...exclude?.messageIds?.length?{exclude:{threadId:access.threadId,messageIds:exclude.messageIds}}:{},...exclude?.withinMs!==undefined?{recentWithinMs:exclude.withinMs}:{}});
    if(!work)break;
    const result=captureWork(work);
    signal?.throwIfAborted();assertMemoryAccess(access,work.scopeId);
    publishMemoryWork(work,owner,result);completed++;
    if(result.status==="complete"){
      const id=work.id;
      const checkpoint=refreshMemoryCheckpoint(id);
      if(checkpoint.status!=="deferred"&&onCompleted)setImmediate(()=>onCompleted(id));
    }
  }
  return completed;
}

/** Bounded fallback, not an alternate full archive search. Reads at most the
 * newest RECENT_VISIT_ROWS rows of the table, keeps the newest 256 that are not
 * PIP rows, and returns only current authorized lexical hits. Filtering PIP rows
 * before the row limit walked every one of them first (msearch review P1). */
export const RECENT_VISIT_ROWS=2048;
/** Rows of text the fallback reads in all, shared out across every scope the reader reaches. */
export const RECENT_TEXT_ROWS=512;
/** The fallback hands back EVERY match it read, best first, with no global cut: they are candidates only, and searchMemory
 * authorizes them in the order given, as many as it needs, inside its time limit. A cut made here would be made before
 * authorization, so refused matches in one scope could push another scope's readable match out of the answer (msearch review
 * round 6). The number of matches is bounded where they are read: RECENT_TEXT_ROWS text rows shared across the scopes (at least
 * 8 each), so this never grows with the table. */
export function recentMemoryHits(query:string,access:MemoryAccess,budget=new RecallWorkBudget()):IndexHit[]{
  assertMemoryAccess(access);
  const terms=keywordTerms(query);if(!terms.length)return [];
  const db=database(),rows=recentViewPage(db,access.view,Number.MAX_SAFE_INTEGER,RECENT_VISIT_ROWS,budget),matches:IndexHit[]=[];
  let texts=0;
  for(const ref of rows) {
    if(texts>=RECENT_TEXT_ROWS)break;
    const row=db.prepare(`SELECT r.kind,r.state,EXISTS(SELECT 1 FROM memory_projection_receipts p WHERE p.record_id=r.id AND p.record_version=r.version AND p.lexical_status='indexed') AS indexed FROM memory_records r WHERE r.id=? AND r.version=? AND ${CURRENT_MEMORY} AND ${REACHABLE_RECORD}`).get(ref.id,ref.version);
    if(!row || row.state!=='active' || Number(row.indexed) || isPipKind(String(row.kind)))continue;
    const text=viewRecordText(db,ref,budget);if(text===null)break;texts++;
    matches.push(...keywordScore([{...ref,text}],terms));
  }
  return matches.sort(byScore);
}

/** Producer owner: recall-scope (admitted references and authority).
 * Consumer owner: salv-tri-b (deadline slicing). The shared request allowance
 * bounds both reference visits and payload bytes; no scope list is enumerated. */
export const RECENT_VIEW_SLICE=64;
export async function recentMemoryHitsSliced(query:string,access:MemoryAccess,options:{deadlineAt:number;signal?:AbortSignal;workBudget?:RecallWorkBudget}):Promise<{hits:IndexHit[];complete:boolean}>{
  options.signal?.throwIfAborted();assertMemoryAccess(access);
  const terms=keywordTerms(query);if(!terms.length)return {hits:[],complete:true};
  const db=database(),budget=options.workBudget??new RecallWorkBudget(),hits:IndexHit[]=[];
  let before=Number.MAX_SAFE_INTEGER,visited=0,texts=0;
  const finish=(complete:boolean)=>{
    options.signal?.throwIfAborted();assertMemoryAccess(access);
    return {hits:hits.sort(byScore),complete:complete&&performance.now()<options.deadlineAt};
  };
  while(visited<RECENT_VISIT_ROWS && texts<RECENT_TEXT_ROWS){
    options.signal?.throwIfAborted();assertMemoryAccess(access);
    if(performance.now()>=options.deadlineAt || budget.remaining===0)return finish(false);
    const limit=Math.min(RECENT_VIEW_SLICE,RECENT_VISIT_ROWS-visited,budget.remaining);
    const rows=recentViewPage(db,access.view,before,limit,budget);visited+=rows.length;
    for(const ref of rows){
      options.signal?.throwIfAborted();
      if(performance.now()>=options.deadlineAt)return finish(false);
      const row=db.prepare(`SELECT r.kind,r.state,EXISTS(SELECT 1 FROM memory_projection_receipts p WHERE p.record_id=r.id AND p.record_version=r.version AND p.lexical_status='indexed') AS indexed FROM memory_records r WHERE r.id=? AND r.version=? AND ${CURRENT_MEMORY} AND ${REACHABLE_RECORD}`).get(ref.id,ref.version);
      if(!row || row.state!=='active' || Number(row.indexed) || isPipKind(String(row.kind)))continue;
      const text=viewRecordText(db,ref,budget);if(text===null)return finish(false);texts++;
      hits.push(...keywordScore([{...ref,text}],terms));
      if(texts>=RECENT_TEXT_ROWS)return finish(false);
    }
    if(rows.length<limit)return finish(true);
    before=rows.at(-1)!.rowid;
    await yieldTurn();
  }
  return finish(false);
}

function keywordTerms(query:string):string[]{
  return [...new Set(query.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu)??[])].slice(0,20);
}
function keywordScore(rows:ReadonlyArray<Record<string,unknown>>,terms:readonly string[]):IndexHit[]{
  return rows.flatMap(row=>{
    const text=String(row.text).normalize("NFKC").toLowerCase();
    const matches=terms.filter(term=>text.includes(term)).length;
    return matches?[{id:String(row.id),version:Number(row.version),score:matches/terms.length,lexical:true as const}]:[];
  });
}

/** How many of the reader's newest current records the keyword fallback reads, at most. */
export const KEYWORD_FALLBACK_WINDOW=4000;
/** Rows one slice visits in one scope, PIP and all: the unit of synchronous work between yields. */
export const KEYWORD_FALLBACK_SLICE=512;
/** Rows visited in all, whatever they turn out to be. Four million PIP rows newer than the reader's notes cost the
 * old scan 585 ms in one synchronous step (msearch review P1); this caps the walk instead. */
export const KEYWORD_FALLBACK_MAX_ROWS=16384;
/** Text bytes read in all. */
export const KEYWORD_FALLBACK_MAX_BYTES=8*1024*1024;
/** Wall time the fallback may take, at most; the caller may give it less. */
export const KEYWORD_FALLBACK_BUDGET_MS=250;
export interface KeywordScan {hits:IndexHit[];visited:number;bytes:number;slices:number;complete:boolean}
const yieldTurn=()=>new Promise<void>(resolve=>setImmediate(resolve));

/** The keyword search recall falls back to when neither the word index nor the helper can answer (index missing or
 * being rebuilt, helper busy or down). Walks each scope's active rows newest first through the (scope_id,state) index,
 * one slice of KEYWORD_FALLBACK_SLICE rows at a time, yielding between slices, and stops at whichever comes first: the
 * window of current records, the row cap, the byte cap, the time budget or the signal. Writes nothing and returns
 * candidates only: searchMemory checks every hit against current state, access, identity, audience and withheld
 * sources exactly as it does any other hit. Best matches first, ties by (record id, version). */
export async function keywordMemoryHits(query:string,access:MemoryAccess,options:{limit?:number;budgetMs?:number;signal?:AbortSignal;workBudget?:RecallWorkBudget}={}):Promise<KeywordScan>{
  assertMemoryAccess(access);
  const started=performance.now(),deadline=started+Math.min(KEYWORD_FALLBACK_BUDGET_MS,options.budgetMs??KEYWORD_FALLBACK_BUDGET_MS);
  const budget=options.workBudget??new RecallWorkBudget(),db=database(),terms=keywordTerms(query);
  const scan:KeywordScan={hits:[],visited:0,bytes:0,slices:0,complete:false};let before=Number.MAX_SAFE_INTEGER,window=0;
  while(budget.remaining>0 && window<KEYWORD_FALLBACK_WINDOW) {
    assertMemoryAccess(access);
    if(options.signal?.aborted || performance.now()>=deadline)break;
    const rows=recentViewPage(db,access.view,before,Math.min(KEYWORD_FALLBACK_SLICE,KEYWORD_FALLBACK_MAX_ROWS-scan.visited),budget);
    scan.slices++;scan.visited+=rows.length;
    if(!rows.length){scan.complete=true;break;}
    for(const ref of rows) {
      const row=db.prepare('SELECT kind,state FROM memory_records WHERE id=? AND version=?').get(ref.id,ref.version);
      if(!row || row.state!=='active' || isPipKind(String(row.kind)))continue;
      if(window++>=KEYWORD_FALLBACK_WINDOW)break;
      const bytesBefore=budget.bytes,text=viewRecordText(db,ref,budget);if(text===null)return scan;
      scan.bytes+=budget.bytes-bytesBefore;scan.hits.push(...keywordScore([{...ref,text}],terms));
    }
    before=rows.at(-1)!.rowid;
    if(rows.length<KEYWORD_FALLBACK_SLICE){scan.complete=true;break;}
    await yieldTurn();
  }
  scan.hits.sort(byScore);scan.hits=scan.hits.slice(0,options.limit??50);return scan;
}
export async function keywordScan(db:ReturnType<typeof database>,query:string,scopeIds:readonly string[],options:{limit?:number;budgetMs?:number;signal?:AbortSignal}={}):Promise<KeywordScan>{
  const started=performance.now(),deadline=started+Math.max(0,Math.min(KEYWORD_FALLBACK_BUDGET_MS,options.budgetMs??KEYWORD_FALLBACK_BUDGET_MS));
  const terms=keywordTerms(query),limit=options.limit??50;
  const scan:KeywordScan={hits:[],visited:0,bytes:0,slices:0,complete:false};
  if(!terms.length){scan.complete=true;return scan;}
  // A slice reads keys and sizes only; a row's text is read on its own, after the byte cap has been checked against its
  // size (octet_length reads the stored length, not the text). The cap holds per row as it is read, not between
  // slices: 512 rows of 4 KiB once read 12.6 MB past an 8 MiB cap (msearch review round 2).
  const slice=db.prepare(`SELECT r.rowid AS rid,r.id,r.version,r.kind IN ${PIP_ALL_KINDS_SQL} AS pip,octet_length(r.text) AS bytes
    FROM memory_records r INDEXED BY memory_records_scope WHERE r.scope_id=? AND r.state='active' AND r.rowid<? ORDER BY r.rowid DESC LIMIT ?`);
  const textOf=db.prepare("SELECT text FROM memory_records WHERE rowid=?");
  const current=db.prepare(`SELECT 1 FROM memory_records r WHERE r.id=? AND r.version=? AND ${CURRENT_MEMORY}`);
  const cursors=new Map([...new Set(scopeIds)].map(scope=>[scope,Number.MAX_SAFE_INTEGER]));
  const found:Array<IndexHit&{rid:number}>=[];
  let window=0;
  while(cursors.size){
    for(const [scope,before] of cursors){
      if(options.signal?.aborted||performance.now()>=deadline||scan.visited>=KEYWORD_FALLBACK_MAX_ROWS||scan.bytes>=KEYWORD_FALLBACK_MAX_BYTES||window>=KEYWORD_FALLBACK_WINDOW)return finish();
      const rows=slice.all(scope,before,Math.min(KEYWORD_FALLBACK_SLICE,KEYWORD_FALLBACK_MAX_ROWS-scan.visited));
      scan.slices++;scan.visited+=rows.length;
      if(rows.length<KEYWORD_FALLBACK_SLICE)cursors.delete(scope);else cursors.set(scope,Number(rows.at(-1)!.rid));
      for(const row of rows){
        if(Number(row.pip))continue;
        if(window>=KEYWORD_FALLBACK_WINDOW)break;
        const bytes=Number(row.bytes);
        // The next row's text would pass the byte cap: the scan ends here, before reading it.
        if(scan.bytes+bytes>KEYWORD_FALLBACK_MAX_BYTES)return finish();
        window++;
        const text=textOf.get(row.rid)?.text;scan.bytes+=bytes;
        const [hit]=keywordScore([{id:row.id,version:row.version,text}],terms);
        if(hit&&current.get(hit.id,hit.version))found.push({...hit,rid:Number(row.rid)});
      }
      // One slice of synchronous work at a time: whatever is waiting on the event loop runs before the next.
      if(cursors.size)await yieldTurn();
    }
  }
  scan.complete=true;
  return finish();
  function finish(){
    scan.hits=found.sort(byScore).slice(0,limit).map(hit=>({id:hit.id,version:hit.version,score:hit.score,lexical:true as const}));
    return scan;
  }
}

/** The turn's one catch-up step, run before recall: skips the messages the turn already holds (its own prompt: recall leaves it out, so
 * capturing it now buys nothing and costs three writes), lock-tolerant (a held write lock means "the worker will
 * get to it", not an error and not a wait), and never longer than two chunks or 25 ms of work. */
export const CATCH_UP_WINDOW_MS = 15 * 60_000;
export function catchUpRecentMemory(access: MemoryAccess, signal?: AbortSignal, onCompleted?: (jobId:string)=>void, exclude?: { messageIds: readonly string[] }): number {
  // Only what was written in the last quarter hour: a standing backlog (an upgrade, a long outage) is the worker's, not one turn's.
  try { return withBusyBudget(BACKGROUND_BUSY_MS, "recall-catchup", () => materializeRecentMemory(access, signal, onCompleted, { ...exclude, withinMs: CATCH_UP_WINDOW_MS })); }
  catch (error) {
    if (error instanceof DatabaseBusyError || isDatabaseBusy(error)) return 0;
    throw error;
  }
}
