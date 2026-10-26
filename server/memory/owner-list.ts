import type { DatabaseSync } from "node:sqlite";
import { database } from "../database.ts";
import { ioBudget } from "../io-budget.ts";
import { heldStep } from "../observe.ts";
import { ageFillBelow, ageTablesPresent, lexicalGeneration, lexicalRowidsAged } from "./age-index.ts";
import { ownerIndexHandle } from "./index-reader.ts";
import { ensureScope, type MemoryRoster } from "./policy.ts";
import { PIP_ALL_KINDS_SQL } from "./pip-kinds.ts";
import { rolledCheckpointSql } from "./projection.ts";
import { OWNER_TAIL_KIND_LIST, RECORD_KEYS_TABLE, recordKeysReady } from "./schema.ts";

export interface OwnerListInput {
  query?:string; scopeId?:string; botId?:string; state?:string; cursor?:string;
  view?:"search"|"important"|"recent"|"review";
}

/** Owner inspection may span the workspace; the bot panel remains restricted
 * to that bot's existing audiences even when a caller supplies a scope filter.
 */
export function ownerListScopes(input:OwnerListInput,roster:MemoryRoster):string[]|null {
  if(!input.botId)return input.scopeId?[input.scopeId]:null;
  const bot=roster.bots.find(bot=>bot.id===input.botId);
  if(!bot)throw new Error("MEMORY_SUBJECT_UNKNOWN");
  const ids=[ensureScope("bot",bot.id),...database().prepare(`SELECT id FROM memory_scopes WHERE
    (kind='conversation' AND owner_key IN (SELECT value FROM json_each(?))) OR (kind='team' AND owner_key=?)
    UNION SELECT scope_id AS id FROM memory_scope_bindings WHERE subject_type='bot' AND subject_id=? AND state='granted'`)
    .all(JSON.stringify([bot.threadId,...(bot.tasks??[]).map(task=>task.threadId)]),bot.section?.trim()||"",bot.id).map(row=>String(row.id))];
  ids.push(...database().prepare("SELECT id FROM memory_scopes WHERE kind='bot' AND substr(owner_key,1,?)=?").all(bot.id.length+1,bot.id+"#").map(row=>String(row.id)));
  if(input.scopeId&&!ids.includes(input.scopeId))throw new Error("MEMORY_SCOPE_DENIED");
  return input.scopeId?[input.scopeId]:[...new Set(ids)];
}

/** Most index matches one page of an owner search steps through (eligible or not). Past this many the page is short, the owner is told,
 * and the next page carries on from where this one stopped. */
export const OWNER_INDEX_MATCHES = 5000;
/** Most never-indexed rows (and, with a large backlog, most projection receipts) one search looks at. */
export const OWNER_TAIL_WINDOW = 20_000;
/** Most not-yet-indexed receipts one search reads in full. */
export const OWNER_TAIL_RECEIPTS = 2000;
/** The match count stops here: past it the screen shows "1,000+" instead of counting everything. */
export const OWNER_COUNT_CAP = 1000;
/** Rows one statement steps. Each statement is a bounded slice; the loop is handed back between slices. */
export const OWNER_SLICE_ROWS = 256;
/** The index walk reads the word table one key range at a time: a range is this many key-table rows down from where the walk is, so
 * one statement's postings traversal is bounded by the postings of the query's terms within that many records, whatever the
 * conjunction (r3.3). OWNER_INDEX_RANGES bounds the ranges one page walks (2 million keys) before it says coverage is incomplete. */
export const OWNER_INDEX_RANGE_KEYS = 4096;
export const OWNER_INDEX_RANGES = 512;
/** In the filling mode, an empty page whose cursor did not move waits this long for the fill to advance before it answers (r3.4). */
export const OWNER_FILL_WAIT_MS = 2000;
/** The pending statuses of a projection receipt: the record is not (fully) in the search index yet. */
const PENDING_STATUS = "('pending','pending-archive')";
/** Said when a search could not look at everything, in plain words. */
export const OWNER_NEWEST_NOTICE = "Showing the newest matches. Refine the search to reach older ones.";
/** Said when the words match more than OWNER_COUNT_CAP records: every one is still reachable page by page. */
export const OWNER_MANY_NOTICE = "More than 1,000 matches. Refine the search to narrow them.";
/** Said while the search index is being put in age order (mode F): the page never reaches below the fill's frontier. */
export const OWNER_REORDER_NOTICE = "The search index is being reordered. Older matches are added as it progresses.";
/** Said when a page in mode F found nothing new and the fill has not moved yet. */
export const OWNER_FILL_WAIT_NOTICE = "Older notes are still being added to the search. Press Next again in a moment.";
export const OWNER_CATCHING_UP_NOTICE = "The search index is catching up. Showing source-text matches.";
/** Work the owner search has done since the last reset (tests and measurements): searches by part, statements, rows stepped, and the
 * slowest statement (the 50 ms gate, r2.8). */
export const ownerSearchWork = { indexedQueries: 0, tailQueries: 0, statements: 0, visited: 0, slowestMs: 0 };
/** When on, every statement a search runs is recorded (tests prove the set does not change with the size of the memory, and read its plans). */
export const ownerSearchTrace: { on: boolean; statements: Array<{ db: "main" | "index"; sql: string }>; times: number[] } = { on: false, statements: [], times: [] };
const yieldTurn = () => new Promise<void>(resolve => setImmediate(resolve));
/** One bounded statement of an owner search: named for the stall line and the I/O budget, counted, timed, and followed by a turn of the loop. */
async function slice(handle:DatabaseSync,which:"main"|"index",sql:string,params:Array<string|number|null>):Promise<Array<Record<string,unknown>>>{
  const traced=ownerSearchTrace.on;
  if(traced)ownerSearchTrace.statements.push({db:which,sql});
  ownerSearchWork.statements++;
  const started=performance.now();
  const rows=heldStep("memory.owner-search",()=>ioBudget.withSource("memory.owner-search",()=>handle.prepare(sql).all(...params))) as Array<Record<string,unknown>>;
  const ms=performance.now()-started;
  ownerSearchWork.slowestMs=Math.max(ownerSearchWork.slowestMs,ms);
  if(traced)ownerSearchTrace.times.push(ms);
  ownerSearchWork.visited+=rows.length;
  await yieldTurn();
  return rows;
}
const strip=(row:Record<string,unknown>)=>{const {ix:_ix,ca:_ca,rr:_rr,ak:_ak,...rest}=row;return rest;};
const keyOf=(row:Record<string,unknown>)=>`${row.id}:${row.version}`;
const byAge=(a:Record<string,unknown>,b:Record<string,unknown>)=>Number(b.created_at)-Number(a.created_at)||(String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0)||Number(b.version)-Number(a.version);
/** The one order of every keyed view: the age key, newest first (schema.ts RECORD_KEYS_SCHEMA). */
const byKey=(a:{ak:number},b:{ak:number})=>b.ak-a.ak;
type Keyed={ak:number;row:Record<string,unknown>};
/** The highest possible age key: a page with no cursor asks for everything at or below it. */
const TOP_KEY=Number.MAX_SAFE_INTEGER;

/** The page cursor of the keyed modes: `k`, the key boundary (the next page asks for `age_key < k`), and `g`, the mode and index
 * generation it was made under (a cursor from another generation is refused: the index was reordered or reset under it). */
function readKeyCursor(cursor:string|undefined,generation:string):number{
  if(!cursor)return TOP_KEY+1;
  try{
    const value=JSON.parse(Buffer.from(cursor,"base64url").toString());
    if(!Number.isSafeInteger(value.k)||value.k<0||value.g!==generation)throw new Error();
    return Number(value.k);
  }catch{throw new Error("INVALID_MEMORY_CURSOR");}
}
const makeKeyCursor=(k:number,g:string)=>Buffer.from(JSON.stringify({k,g})).toString("base64url");

export interface OwnerListResult { rows:Array<Record<string,unknown>>; searchMode:string; scopeIds:string[]|null; nextCursor?:string; coverageComplete?:boolean; searchNotice?:string; matchCount?:number; matchCountLabel?:string }

/** Owner search and browse (1.0.3 lane 2, LANE2-MEMORY-DESIGN r3). One order everywhere: the record's age key, newest first.
 *
 * Browse (no query) is a union of equality-prefixed range scans of the key table (one per scope and state the view covers, each
 * `LIMIT 51` on its own index prefix, merged in memory, r3.3); only the rows shown are then read from the records table by primary
 * key. Nothing is sorted but the kept candidates.
 *
 * Search answers from three newest-first streams, every one resumed at `age_key < cursor`, in bounded slices on the loop (each
 * statement steps at most OWNER_SLICE_ROWS rows and the loop is handed back after each):
 *  - the search index, walked by its rowid (which is the age key once the index is in age order) one key range at a time on the one
 *    reader handle, with the main database attached: the page takes the first 51 eligible matches; its frontier is where the walk stopped;
 *  - the records waiting to be projected, through the pending receipts (all of them up to OWNER_TAIL_RECEIPTS), newest 51 kept;
 *  - the kinds the index never holds, one scan per kind and state on the key table's kind index (r3.2), merged as a k-way walk; its
 *    frontier is the highest key an unfinished scan has not reached.
 * The page (r2.4): candidates deduplicated and sorted by key; F is the highest frontier (plus the fill's frontier in mode F, latched
 * before the first read, r3.4); up to 50 candidates with key >= F are shown. The cursor is exclusive for the next read and inclusive
 * for what was shown: after a page with cursor c every eligible match with key >= c has been returned and every one with key < c has
 * not (the last shown key when the page filled, else F, else the last shown key when a stream trimmed what it kept). So a record that
 * moves from the pending stream to the index between two pages is shown exactly once, whichever stream holds it.
 *
 * Modes (r2.3): P (preparing: the key backfill is not done) is the source-text mode and the old browse statement; F (filling: the
 * index is being copied into age order) reads the second word table above the fill's frontier; R (ready) the full design. Without a
 * readable index the text match alone answers, over the newest keys, and says so. */
export async function ownerMemoryList(input:OwnerListInput,roster:MemoryRoster):Promise<OwnerListResult>{
  const result=await ownerMemoryListRead(input,roster);
  ownerListHooks.beforeForgetCheck?.();
  return withoutForgotten(database(),result);
}

/** Test seam (LAM-R5-6): runs after the last await of a list, just before the forgotten check. */
export const ownerListHooks:{beforeForgetCheck?:()=>void}={};

/** Learn about me R5.1 C4: a row whose record is forgotten (a RECORD tombstone for the whole record or that version) is dropped. It runs
 * synchronously after the list's last await, so a Forget that committed while the list was reading is reflected, and it covers versions
 * past the newest 64 that keep their words until the expand phase. One statement per page, by the tombstones' unique index. */
function withoutForgotten(db:DatabaseSync,result:OwnerListResult):OwnerListResult{
  if(!result.rows.length)return result;
  const pairs=JSON.stringify(result.rows.map(row=>[String(row.id),Number(row.version)]));
  const gone=db.prepare(`SELECT json_extract(p.value,'$[0]') AS id,json_extract(p.value,'$[1]') AS version FROM json_each(?) p
    WHERE EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.target_type='record' AND t.target_id=json_extract(p.value,'$[0]')
    AND (t.revision IS NULL OR t.revision=json_extract(p.value,'$[1]')))`).all(pairs) as Array<{id:string;version:number}>;
  if(!gone.length)return result;
  const drop=new Set(gone.map(row=>`${row.id}:${row.version}`));
  return {...result,rows:result.rows.filter(row=>!drop.has(keyOf(row)))};
}

async function ownerMemoryListRead(input:OwnerListInput,roster:MemoryRoster):Promise<OwnerListResult>{
  const db=database(),scopes=ownerListScopes(input,roster),view=input.view??"search";
  if(!recordKeysReady(db))return preparingList(db,input,scopes,view);
  const base:string[]=["(? IS NULL OR r.scope_id IN (SELECT value FROM json_each(?)))"];
  const baseArgs:Array<string|number|null>=[scopes===null?null:JSON.stringify(scopes),scopes===null?null:JSON.stringify(scopes)];
  if(input.state){base.push("r.state=?");baseArgs.push(input.state);}else base.push("r.state!='deleted'");
  if(view==="important")base.push("r.owner_pinned=1 AND r.state='active'");
  if(view==="recent")base.push("r.state='active'");
  if(view==="review")base.push("r.state='candidate'");
  // the states the view covers: a closed set, one scan per value (r3.3)
  const viewStates=view==="important"||view==="recent"?["active"]:view==="review"?["candidate"]:["candidate","active","superseded","archived"];
  // an explicit state filter is that state alone (the owner's "deleted" filter included), within what the view allows
  const states=input.state?(view==="search"||viewStates.includes(input.state)?[input.state]:[]):viewStates;
  if(!input.query?.trim())return keyedBrowse(db,input,scopes,states);
  return keyedSearch(db,input,scopes,states,base,baseArgs);
}

/** Mode P: the key backfill has not finished. Browse reads the records table as before; search is the source-text match over the newest
 * records by rowid, with the keyset cursor both had before the key table existed. No new code runs here. */
async function preparingList(db:DatabaseSync,input:OwnerListInput,scopes:string[]|null,view:string):Promise<OwnerListResult>{
  let after={at:Number.MAX_SAFE_INTEGER,id:"",version:Number.MAX_SAFE_INTEGER};
  if(input.cursor){try{
    const value=JSON.parse(Buffer.from(input.cursor,"base64url").toString());
    if(!Number.isSafeInteger(value.at)||typeof value.id!=="string"||!Number.isSafeInteger(value.version)||value.version<1)throw new Error();
    after={at:value.at,id:value.id,version:value.version};
  }catch{throw new Error("INVALID_MEMORY_CURSOR");}}
  const base:string[]=["(? IS NULL OR r.scope_id IN (SELECT value FROM json_each(?)))"];
  const baseArgs:Array<string|number|null>=[scopes===null?null:JSON.stringify(scopes),scopes===null?null:JSON.stringify(scopes)];
  if(input.state){base.push("r.state=?");baseArgs.push(input.state);}else base.push("r.state!='deleted'");
  if(view==="important")base.push("r.owner_pinned=1 AND r.state='active'");
  if(view==="recent")base.push("r.state='active'");
  if(view==="review")base.push("r.state='candidate'");
  const filters=[...base,"(r.created_at<? OR (r.created_at=? AND (r.id>? OR (r.id=? AND r.version<?))))"];
  const args=[...baseArgs,after.at,after.at,after.id,after.id,after.version];
  const ORDER="ORDER BY r.created_at DESC,r.id,r.version DESC LIMIT 51";
  if(!input.query?.trim()){
    const rows=db.prepare(`SELECT r.* FROM memory_records r WHERE ${filters.join(" AND ")} ${ORDER}`).all(...args) as Array<Record<string,unknown>>;
    const tail=rows[49];
    return {rows:rows.slice(0,50),searchMode:"browse",scopeIds:scopes,...rows.length>50?{nextCursor:Buffer.from(JSON.stringify({at:Number(tail.created_at),id:String(tail.id),version:Number(tail.version)})).toString("base64url")}:{}};
  }
  const terms=[...new Set(input.query.match(/[\p{L}\p{N}_-]+/gu)??[])].slice(0,32);
  const textAll=terms.length?terms.map(()=>"instr(lower(r.text),lower(?))>0").join(" AND "):"instr(lower(r.text),lower(?))>0";
  const textArgs=terms.length?terms:[input.query.trim()];
  const tail:Array<Record<string,unknown>>=[];
  let tailCount=0,complete=true;
  const keep=(rows:Array<Record<string,unknown>>)=>{
    for(const row of rows){if(row.id===null||row.id===undefined)continue;tailCount++;tail.push(strip(row));}
    if(tail.length>200){tail.sort(byAge);tail.length=51;}
  };
  // The newest OWNER_TAIL_WINDOW records by rowid, a slice at a time, the matching rows kept.
  const top=Number((await slice(db,"main","SELECT max(rowid) AS n FROM memory_records",[]))[0]?.n??0);
  let below=top+1;
  for(let seen=0;seen<OWNER_TAIL_WINDOW&&below>1;){
    const rows=await slice(db,"main",`SELECT c.rr AS rr,r.* FROM (SELECT rowid AS rr FROM memory_records WHERE rowid<? ORDER BY rowid DESC LIMIT ${OWNER_SLICE_ROWS}) c
      LEFT JOIN memory_records r ON r.rowid=c.rr AND ${filters.join(" AND ")} AND ${textAll} ORDER BY c.rr DESC`,[below,...args,...textArgs]);
    if(!rows.length){below=0;break;}
    seen+=rows.length;below=Number(rows.at(-1)!.rr);
    keep(rows);
    if(rows.length<OWNER_SLICE_ROWS){below=0;break;}
  }
  if(below>1&&(await slice(db,"main","SELECT 1 AS n FROM memory_records WHERE rowid<? LIMIT 1",[below])).length)complete=false;
  const rest=[...new Map(tail.map(row=>[keyOf(row),row])).values()].sort(byAge);
  const rows=rest.slice(0,50),last=rows.at(-1);
  const result:OwnerListResult={rows,searchMode:"source-text",scopeIds:scopes,coverageComplete:complete,searchNotice:complete?OWNER_CATCHING_UP_NOTICE:`${OWNER_CATCHING_UP_NOTICE} ${OWNER_NEWEST_NOTICE}`};
  if(last&&(rest.length>50||tailCount>tail.length))result.nextCursor=Buffer.from(JSON.stringify({at:Number(last.created_at),id:String(last.id),version:Number(last.version)})).toString("base64url");
  if(!input.cursor){result.matchCount=Math.min(tailCount,OWNER_COUNT_CAP);result.matchCountLabel=tailCount>=OWNER_COUNT_CAP?`${OWNER_COUNT_CAP.toLocaleString("en-US")}+`:String(tailCount);}
  return result;
}

/** The records of these candidates, by primary key, in candidate order. */
async function recordsOf(db:DatabaseSync,candidates:Keyed[]):Promise<Array<Record<string,unknown>>>{
  if(!candidates.length)return [];
  const rows=await slice(db,"main",`SELECT r.* FROM json_each(?) j JOIN memory_records r ON r.id=json_extract(j.value,'$[0]') AND r.version=json_extract(j.value,'$[1]')`,
    [JSON.stringify(candidates.map(c=>[String(c.row.id),Number(c.row.version)]))]);
  const byId=new Map(rows.map(row=>[keyOf(row),row]));
  return candidates.map(c=>byId.get(keyOf(c.row))).filter((row):row is Record<string,unknown>=>row!==undefined);
}

/** The cursor rule (r2.4, Low fix). `emitted` are the rows shown, `frontier` the highest frontier (null when every walk ran out),
 * `remaining` whether candidates at or above the frontier were left unshown, `trimmed` whether a stream dropped older candidates. */
function nextKey(emitted:Keyed[],frontier:number|null,remaining:boolean,trimmed:boolean):number|null{
  const last=emitted.at(-1)?.ak;
  if(remaining&&last!==undefined)return last;
  if(frontier!==null)return frontier;
  if(trimmed&&last!==undefined)return last;
  return null;
}

/** Browse in the keyed modes (r3.3): a union of range scans of the key table with an equality prefix, each on its own index, merged. */
async function keyedBrowse(db:DatabaseSync,input:OwnerListInput,scopes:string[]|null,states:string[]):Promise<OwnerListResult>{
  const G="B";
  const below=readKeyCursor(input.cursor,G)-1;
  const K=RECORD_KEYS_TABLE;
  const found:Keyed[]=[];
  let more=false,frontier:number|null=null,complete=true;
  const add=(rows:Array<Record<string,unknown>>)=>{for(const row of rows)found.push({ak:Number(row.ak),row:{id:String(row.rid),version:Number(row.rv)}});};
  if(input.view==="important"&&scopes!==null){
    // the pinned rows of a scope: the scope prefix, the pin as a residual, sliced by examined keys up to the window (r3.3)
    for(const scope of scopes){
      let at=below,examined=0,pinned=0;
      for(;;){
        const rows=await slice(db,"main",`SELECT record_id AS rid,record_version AS rv,age_key AS ak,owner_pinned AS pin FROM ${K} WHERE scope_id=? AND state='active' AND age_key<=? ORDER BY age_key DESC LIMIT ${OWNER_SLICE_ROWS}`,[scope,at]);
        examined+=rows.length;
        const hits=rows.filter(row=>Number(row.pin)===1);
        add(hits);pinned+=hits.length;
        if(rows.length<OWNER_SLICE_ROWS)break;
        at=Number(rows.at(-1)!.ak)-1;
        if(pinned>=51){more=true;break;}
        if(examined>=OWNER_TAIL_WINDOW){complete=false;frontier=Math.max(frontier??0,at+1);break;}
      }
    }
  }else{
    const scans:Array<{sql:string;args:Array<string|number|null>}>=[];
    if(scopes!==null)for(const scope of scopes)for(const state of states)scans.push({sql:`SELECT record_id AS rid,record_version AS rv,age_key AS ak FROM ${K} WHERE scope_id=? AND state=? AND age_key<=? ORDER BY age_key DESC LIMIT 51`,args:[scope,state,below]});
    else if(input.view==="important")scans.push({sql:`SELECT record_id AS rid,record_version AS rv,age_key AS ak FROM ${K} WHERE owner_pinned=1 AND state='active' AND age_key<=? ORDER BY age_key DESC LIMIT 51`,args:[below]});
    else for(const state of states)scans.push({sql:`SELECT record_id AS rid,record_version AS rv,age_key AS ak FROM ${K} WHERE state=? AND age_key<=? ORDER BY age_key DESC LIMIT 51`,args:[state,below]});
    for(const scan of scans){const rows=await slice(db,"main",scan.sql,scan.args);add(rows);if(rows.length>=51)more=true;}
  }
  found.sort(byKey);
  const eligible=frontier===null?found:found.filter(c=>c.ak>=frontier!);
  const shown=eligible.slice(0,50);
  const rows=await recordsOf(db,shown);
  const next=nextKey(shown,frontier,eligible.length>50,more);
  const result:OwnerListResult={rows:rows.map(strip),searchMode:"browse",scopeIds:scopes,coverageComplete:complete};
  if(!complete)result.searchNotice=OWNER_NEWEST_NOTICE;
  if(next!==null)result.nextCursor=makeKeyCursor(next,G);
  return result;
}

/** Search in the keyed modes: the three streams, one frontier, one cursor (the header of this file). */
async function keyedSearch(db:DatabaseSync,input:OwnerListInput,scopes:string[]|null,states:string[],base:string[],baseArgs:Array<string|number|null>):Promise<OwnerListResult>{
  const terms=[...new Set(input.query!.match(/[\p{L}\p{N}_-]+/gu)??[])].slice(0,32);
  // "All words": every word must be in the text, as a part of a word on the text path and as a whole word in the index.
  const textAll=terms.length?terms.map(()=>"instr(lower(r.text),lower(?))>0").join(" AND "):"instr(lower(r.text),lower(?))>0";
  const textArgs=terms.length?terms:[input.query!.trim()];
  const firstPage=!input.cursor;
  const K=RECORD_KEYS_TABLE;
  const reader=terms.length?ownerIndexHandle():null;
  // The mode and the index generation: both are part of the cursor (r2.3).
  const aged=reader?lexicalRowidsAged(reader):false;
  const generation=reader?lexicalGeneration(reader):0;
  const mode:"R"|"F"|"S"=reader?aged?"R":"F":"S";
  const G=`${mode}${generation}`;
  const previous=readKeyCursor(input.cursor,G);
  const counted:{page:{total:number;label:string;many:boolean}|null}={page:null};
  let searchNotice:string|undefined,coverageComplete=true;
  const say=(text:string)=>{searchNotice=searchNotice&&!searchNotice.includes(text)?`${searchNotice} ${text}`:text;};
  const cut=()=>{coverageComplete=false;say(OWNER_NEWEST_NOTICE);};
  const neverIndexed=`(r.kind IN ${PIP_ALL_KINDS_SQL} OR ${rolledCheckpointSql("r")})`;

  /** One page below `hi` (inclusive). Returns the page and the key the next page would ask below. */
  const page=async(hi:number):Promise<{result:OwnerListResult;next:number|null;fillFrontier:number|null;emitted:number}>=>{
    const kept:Keyed[]=[];
    let keptCount=0,trimmed=false;
    const keep=(rows:Array<Record<string,unknown>>)=>{
      for(const row of rows){if(row.id===null||row.id===undefined||row.ak===null||row.ak===undefined)continue;keptCount++;kept.push({ak:Number(row.ak),row:strip(row)});}
      if(kept.length>200){kept.sort(byKey);kept.length=51;trimmed=true;}
    };
    // the frontiers: the index walk, the tail walk, and in mode F the fill (latched before the first read, r3.4)
    let indexFrontier:number|null=null,tailFrontier:number|null=null,fillFrontier:number|null=null;
    const indexed:Keyed[]=[];
    let eligible=0,indexStopped=false,indexTrimmed=false;
    if(mode==="S"){
      // No readable index: the text match alone, over the newest keys, a slice at a time (the key walk has a frontier too).
      let at=hi,examined=0;
      for(;;){
        const rows=await slice(db,"main",`SELECT c.ak AS ak,r.* FROM (SELECT record_id AS rid,record_version AS rv,age_key AS ak FROM ${K} WHERE age_key<=? ORDER BY age_key DESC LIMIT ${OWNER_SLICE_ROWS}) c
          LEFT JOIN memory_records r ON r.id=c.rid AND r.version=c.rv AND ${base.join(" AND ")} AND ${textAll} ORDER BY c.ak DESC`,[at,...baseArgs,...textArgs]);
        examined+=rows.length;keep(rows);
        if(rows.length<OWNER_SLICE_ROWS)break;
        at=Number(rows.at(-1)!.ak)-1;
        if(kept.filter(c=>c.ak>at).length>=51){tailFrontier=at+1;break;}
        if(examined>=OWNER_TAIL_WINDOW){cut();tailFrontier=at+1;break;}
      }
      say(OWNER_CATCHING_UP_NOTICE);
    }else{
      // Mode F: the fill's frontier is latched before the first read of the page (r3.4); the index walk never goes below it.
      let floor=0;
      if(mode==="F"){
        const handle=ownerIndexHandle();
        const filled=handle&&ageTablesPresent(handle)?ageFillBelow(handle):null;
        fillFrontier=filled===null?TOP_KEY:filled;floor=fillFrontier;
        say(OWNER_REORDER_NOTICE);
      }
      // 1. The records not projected yet, through the pending index, read BEFORE the index (r2.5): the FTS row commits before its receipt
      //    flips (index.ts, then worker-controller.ts), so a receipt pending here and flipped before the index read below is in the index
      //    by then, and one indexed before this read is in the index too; a record seen by both streams is deduplicated below.
      ownerSearchWork.tailQueries++;
      const pendingAll=Number((await slice(db,"main",`SELECT count(*) AS n FROM (SELECT 1 FROM memory_projection_receipts WHERE lexical_status IN ${PENDING_STATUS} LIMIT ${OWNER_TAIL_RECEIPTS+1})`,[]))[0]?.n??0);
      const pendingJoin=`LEFT JOIN memory_records r ON r.id=p.rid AND r.version=p.rv AND ${base.join(" AND ")} AND r.kind NOT IN ${PIP_ALL_KINDS_SQL} AND ${textAll}
        LEFT JOIN ${K} ak ON ak.record_id=r.id AND ak.record_version=r.version AND ak.age_key<=?`;
      const pendingArgs=[...baseArgs,...textArgs,hi];
      let pendingFound=0;
      if(pendingAll<=OWNER_TAIL_RECEIPTS){
        let last:[string,string,number]=["","",0];
        for(;;){
          const rows=await slice(db,"main",`SELECT p.s AS s,p.rid AS rid,p.rv AS rv,ak.age_key AS ak,r.* FROM (SELECT lexical_status AS s,record_id AS rid,record_version AS rv FROM memory_projection_receipts WHERE lexical_status IN ${PENDING_STATUS}
            AND (lexical_status,record_id,record_version)>(?,?,?) ORDER BY lexical_status,record_id,record_version LIMIT ${OWNER_SLICE_ROWS}) p ${pendingJoin}`,[...last,...pendingArgs]);
          const before=keptCount;keep(rows.map(({s:_s,rid:_r,rv:_v,...row})=>row));pendingFound+=keptCount-before;
          if(rows.length<OWNER_SLICE_ROWS)break;
          const end=rows.at(-1)!;last=[String(end.s),String(end.rid),Number(end.rv)];
        }
      }else{
        // More pending than one search reads: the newest OWNER_TAIL_WINDOW receipts by rowid, the pending ones among them, and a word.
        cut();
        let below=Number.MAX_SAFE_INTEGER,pendingSeen=0;
        for(let seen=0;seen<OWNER_TAIL_WINDOW&&pendingSeen<OWNER_TAIL_RECEIPTS;){
          const rows=await slice(db,"main",`SELECT p.rr AS rr,p.pending AS pending,ak.age_key AS ak,r.* FROM (SELECT rowid AS rr,record_id AS rid,record_version AS rv,lexical_status IN ${PENDING_STATUS} AS pending FROM memory_projection_receipts WHERE rowid<? ORDER BY rowid DESC LIMIT ${OWNER_SLICE_ROWS}) p
            ${pendingJoin.replace("LEFT JOIN memory_records r ON ","LEFT JOIN memory_records r ON p.pending AND ")} ORDER BY p.rr DESC`,[below,...pendingArgs]);
          if(!rows.length)break;
          seen+=rows.length;below=Number(rows.at(-1)!.rr);
          for(const row of rows)if(Number(row.pending))pendingSeen++;
          const before=keptCount;keep(rows.map(({pending:_p,...row})=>row));pendingFound+=keptCount-before;
          if(rows.length<OWNER_SLICE_ROWS)break;
        }
      }
      if(pendingFound)say("Some recent notes are still being added to the search index. They are matched by their text.");

      // 2. The search index, newest first by its rowid (the age key), one key range at a time, on the one reader handle (taken again for
      //    every slice). In mode F the second word table, and never below the fill's frontier.
      ownerSearchWork.indexedQueries++;
      const table=mode==="R"?"lexical":"lexical_age";
      const expression=terms.map(term=>`"${term.replaceAll('"','""')}"`).join(" AND ");
      const stepSql=`SELECT m.ix AS ix,m.ix AS ak,r.* FROM (SELECT rowid AS ix,id,version FROM ${table} WHERE ${table} MATCH ? AND rowid>=? AND rowid<=? ORDER BY rowid DESC LIMIT ${OWNER_SLICE_ROWS}) m
    LEFT JOIN authority.memory_records r ON r.id=m.id AND r.version=CAST(m.version AS INTEGER) AND ${base.join(" AND ")} ORDER BY m.ix DESC`;
      const rangeSql=`SELECT age_key AS ak FROM authority.${K} WHERE age_key<=? ORDER BY age_key DESC LIMIT 1 OFFSET ${OWNER_INDEX_RANGE_KEYS-1}`;
      let top=hi,steppedRows=0,ranges=0,exhausted=hi<floor,lost=false,stopped=false;
      let examinedBelow=hi+1;
      walk: while(!exhausted&&!stopped){
        const handle=ownerIndexHandle();
        if(!handle){lost=true;break;}
        if(ranges++>=OWNER_INDEX_RANGES){stopped=true;break;}
        const bound=await slice(handle,"index",rangeSql,[top]);
        const lo=Math.max(floor,bound.length?Number(bound[0]!.ak):0);
        let cur=top;
        for(;;){
          const rows=await slice(handle,"index",stepSql,[expression,lo,cur,...baseArgs]);
          steppedRows+=rows.length;
          for(const row of rows){
            if(row.id===null||row.id===undefined)continue;
            eligible++;
            if(indexed.length<51)indexed.push({ak:Number(row.ix),row:strip(row)});else indexTrimmed=true;
          }
          if(rows.length<OWNER_SLICE_ROWS){examinedBelow=lo;break;}
          examinedBelow=Number(rows.at(-1)!.ix);cur=examinedBelow-1;
          // the page is full; on the first page the count goes on to its cap
          if(indexed.length>=51&&(!firstPage||eligible>=OWNER_COUNT_CAP)){stopped=true;break walk;}
          if(steppedRows>=OWNER_INDEX_MATCHES){stopped=true;break walk;}
          if(cur<lo){examinedBelow=lo;break;}
        }
        if(lo<=floor)exhausted=true;else top=lo-1;
      }
      if(lost)say(OWNER_CATCHING_UP_NOTICE);
      if(!exhausted)indexFrontier=Math.max(examinedBelow,floor);
      // a page that stopped at the step limit before it filled may have left matches further down: said, and the next page carries on
      indexStopped=!exhausted&&!lost&&indexed.length<51;
      if(indexStopped)cut();

      // 3. The kinds the index never holds: one scan per kind and state on the key table's kind index (r3.2), stepped as a k-way walk
      //    (the scan with the newest unexamined rows goes next), newest first from the page's place.
      const scans=[...OWNER_TAIL_KIND_LIST.flatMap(kind=>states.map(state=>({kind,state}))),...states.filter(state=>state!=="active").map(state=>({kind:"checkpoint",state}))]
        .map(scan=>({...scan,at:hi,last:hi+1,done:false}));
      const tailSql=`SELECT c.ak AS ak,r.* FROM (SELECT record_id AS rid,record_version AS rv,age_key AS ak FROM ${K} WHERE kind=? AND state=? AND age_key<=? ORDER BY age_key DESC LIMIT ${OWNER_SLICE_ROWS}) c
        LEFT JOIN memory_records r ON r.id=c.rid AND r.version=c.rv AND ${base.join(" AND ")} AND ${neverIndexed} AND ${textAll} ORDER BY c.ak DESC`;
      let examined=0,tailFound=0;
      const step=async(scan:typeof scans[number])=>{
        const rows=await slice(db,"main",tailSql,[scan.kind,scan.state,scan.at,...baseArgs,...textArgs]);
        examined+=rows.length;
        const before=keptCount;keep(rows);tailFound+=keptCount-before;
        if(rows.length<OWNER_SLICE_ROWS)scan.done=true;else{scan.last=Number(rows.at(-1)!.ak);scan.at=scan.last-1;}
      };
      for(const scan of scans)await step(scan);
      for(;;){
        const open=scans.filter(scan=>!scan.done);
        if(!open.length){tailFrontier=null;break;}
        const highest=open.reduce((a,b)=>a.last>=b.last?a:b);
        tailFrontier=highest.last;
        if(kept.filter(c=>c.ak>=highest.last).length>=51)break;
        if(examined>=OWNER_TAIL_WINDOW){cut();break;}
        await step(highest);
      }
      if(firstPage){
        const total=eligible+pendingFound+tailFound,capped=indexStopped||total>=OWNER_COUNT_CAP;
        counted.page={total:Math.min(total,OWNER_COUNT_CAP),label:capped?`${Math.min(total,OWNER_COUNT_CAP).toLocaleString("en-US")}+`:String(total),many:total>=OWNER_COUNT_CAP};
      }
    }
    // The page: every candidate at or above the highest frontier, newest first, at most 50.
    const seen=new Set<string>();
    const candidates:Keyed[]=[];
    for(const c of [...indexed,...kept]){const key=keyOf(c.row);if(seen.has(key))continue;seen.add(key);candidates.push(c);}
    candidates.sort(byKey);
    const frontiers=[indexFrontier,tailFrontier,fillFrontier].filter((f):f is number=>f!==null);
    const frontier=frontiers.length?Math.max(...frontiers):null;
    const eligibleRows=frontier===null?candidates:candidates.filter(c=>c.ak>=frontier);
    const shown=eligibleRows.slice(0,50);
    const next=nextKey(shown,frontier,eligibleRows.length>50,trimmed||indexTrimmed);
    const result:OwnerListResult={rows:shown.map(c=>c.row),searchMode:mode==="S"?"source-text":"indexed",scopeIds:scopes,coverageComplete};
    if(next!==null)result.nextCursor=makeKeyCursor(next,G);
    return {result,next,fillFrontier,emitted:shown.length};
  };

  let hi=previous-1,answer=await page(hi);
  // An empty page stopped by a work cap carries on by itself, up to three times, before the owner sees it (r2.4).
  for(let again=0;again<3&&answer.emitted===0&&answer.next!==null&&answer.next<previous;again++){hi=answer.next-1;answer=await page(hi);}
  // Mode F: nothing new and the fill has not moved below the previous cursor: wait for it, once (r3.4).
  if(answer.emitted===0&&answer.fillFrontier!==null&&answer.next!==null&&answer.next>=previous){
    const handle=ownerIndexHandle();
    const started=performance.now();
    while(handle&&performance.now()-started<OWNER_FILL_WAIT_MS&&(ageFillBelow(handle)??TOP_KEY)>=previous)await new Promise<void>(resolve=>setTimeout(resolve,100));
    answer=await page(previous-1);
    if(answer.emitted===0&&answer.next!==null&&answer.next>=previous){say(OWNER_FILL_WAIT_NOTICE);answer.result.nextCursor=makeKeyCursor(Math.min(answer.next,previous),G);}
  }
  const result=answer.result;
  if(counted.page){result.matchCount=counted.page.total;result.matchCountLabel=counted.page.label;if(counted.page.many)say(OWNER_MANY_NOTICE);}
  result.coverageComplete=coverageComplete;
  if(searchNotice)result.searchNotice=searchNotice;
  return result;
}
