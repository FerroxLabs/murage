import type { DatabaseSync } from "node:sqlite";
import { database } from "../database.ts";
import { ioBudget } from "../io-budget.ts";
import { heldStep } from "../observe.ts";
import { ownerIndexHandle } from "./index-reader.ts";
import { ensureScope, type MemoryRoster } from "./policy.ts";
import { PIP_ALL_KINDS_SQL } from "./pip-kinds.ts";
import { rolledCheckpointSql } from "./projection.ts";
import { OWNER_TAIL_TABLE, ownerTailReady } from "./schema.ts";

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
/** The pending statuses of a projection receipt: the record is not (fully) in the search index yet. */
const PENDING_STATUS = "('pending','pending-archive')";
/** Said when a search could not look at everything, in plain words. */
export const OWNER_NEWEST_NOTICE = "Showing the newest matches. Refine the search to reach older ones.";
/** Said when the words match more than OWNER_COUNT_CAP records: every one is still reachable page by page. */
export const OWNER_MANY_NOTICE = "More than 1,000 matches. Refine the search to narrow them.";
/** Work the owner search has done since the last reset (tests and measurements): searches by part, statements, and rows stepped. */
export const ownerSearchWork = { indexedQueries: 0, tailQueries: 0, statements: 0, visited: 0 };
/** When on, every statement a search runs is recorded (tests prove the set does not change with the size of the memory, and read its plans). */
export const ownerSearchTrace: { on: boolean; statements: Array<{ db: "main" | "index"; sql: string }> } = { on: false, statements: [] };
const yieldTurn = () => new Promise<void>(resolve => setImmediate(resolve));
/** One bounded statement of an owner search: named for the stall line and the I/O budget, counted, and followed by a turn of the loop. */
async function slice(handle:DatabaseSync,which:"main"|"index",sql:string,params:Array<string|number|null>):Promise<Array<Record<string,unknown>>>{
  if(ownerSearchTrace.on)ownerSearchTrace.statements.push({db:which,sql});
  ownerSearchWork.statements++;
  const rows=heldStep("memory.owner-search",()=>ioBudget.withSource("memory.owner-search",()=>handle.prepare(sql).all(...params))) as Array<Record<string,unknown>>;
  ownerSearchWork.visited+=rows.length;
  await yieldTurn();
  return rows;
}
const strip=(row:Record<string,unknown>)=>{const {ix:_ix,ca:_ca,rr:_rr,...rest}=row;return rest;};
const keyOf=(row:Record<string,unknown>)=>`${row.id}:${row.version}`;
const byAge=(a:Record<string,unknown>,b:Record<string,unknown>)=>Number(b.created_at)-Number(a.created_at)||(String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0)||Number(b.version)-Number(a.version);

/** Owner search over a words-and-all query, in bounded slices on the loop (each statement steps at most OWNER_SLICE_ROWS rows, and the
 * loop is handed back after each). Three parts, each bounded by its own limit and never by the size of the memory:
 *  - the search index, stepped newest first by its own rowid on the one instrumented reader handle (index-reader.ts), with the main
 *    database attached: the page takes the first 51 eligible matches, and the next page carries on from the index position of the
 *    last one shown, so a page costs what the screen shows, not a join of thousands of rows;
 *  - the records waiting to be projected, through the pending index (all of them up to OWNER_TAIL_RECEIPTS);
 *  - the kinds the index never holds, through their partial index (all of them up to OWNER_TAIL_WINDOW).
 * The two lists are merged newest first. On the first page the matches are counted, up to OWNER_COUNT_CAP ("1,000+" past it).
 * `coverageComplete` is false, with OWNER_NEWEST_NOTICE, only when a limit was actually reached. The statements, and the rows they
 * step, are the same whatever the memory holds besides the matches. Without a readable index the text match alone answers, over the
 * newest records, and says so. */
export interface OwnerListResult { rows:Array<Record<string,unknown>>; searchMode:string; scopeIds:string[]|null; nextCursor?:string; coverageComplete?:boolean; searchNotice?:string; matchCount?:number; matchCountLabel?:string }
export async function ownerMemoryList(input:OwnerListInput,roster:MemoryRoster):Promise<OwnerListResult>{
  const db=database(),scopes=ownerListScopes(input,roster),view=input.view??"search";
  let after={at:Number.MAX_SAFE_INTEGER,id:"",version:Number.MAX_SAFE_INTEGER};
  // ix: the search index position the next page carries on below (0: the index part is finished).
  let afterIx=Number.MAX_SAFE_INTEGER;
  if(input.cursor){try{
    const value=JSON.parse(Buffer.from(input.cursor,"base64url").toString());
    if(!Number.isSafeInteger(value.at)||typeof value.id!=="string"||!Number.isSafeInteger(value.version)||value.version<1)throw new Error();
    if(value.ix!==undefined&&(!Number.isSafeInteger(value.ix)||value.ix<0))throw new Error();
    after={at:value.at,id:value.id,version:value.version};
    if(value.ix!==undefined)afterIx=value.ix;
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
    return page(db.prepare(`SELECT r.* FROM memory_records r WHERE ${filters.join(" AND ")} ${ORDER}`).all(...args) as Array<Record<string,unknown>>,"browse",scopes);
  }
  const terms=[...new Set(input.query.match(/[\p{L}\p{N}_-]+/gu)??[])].slice(0,32);
  // "All words": every word must be in the text, as a part of a word on the text path and as a whole word in the index.
  const textAll=terms.length?terms.map(()=>"instr(lower(r.text),lower(?))>0").join(" AND "):"instr(lower(r.text),lower(?))>0";
  const textArgs=terms.length?terms:[input.query.trim()];
  const firstPage=!input.cursor;
  let searchNotice:string|undefined;
  // False only when a limit kept a match out of what this search could look at; the notice says so and the owner can refine the search.
  let coverageComplete=true;
  const say=(text:string)=>{searchNotice=searchNotice&&!searchNotice.includes(text)?`${searchNotice} ${text}`:text;};
  const cut=()=>{coverageComplete=false;say(OWNER_NEWEST_NOTICE);};
  const neverIndexed=`(r.kind IN ${PIP_ALL_KINDS_SQL} OR ${rolledCheckpointSql("r")})`;
  const tail:Array<Record<string,unknown>>=[];
  let tailCount=0;
  const keepTail=(rows:Array<Record<string,unknown>>)=>{
    for(const row of rows){if(row.id===null||row.id===undefined)continue;tailCount++;tail.push(strip(row));}
    // only the newest page's worth is kept; the count goes on
    if(tail.length>200){tail.sort(byAge);tail.length=51;}
  };
  /** The newest OWNER_TAIL_WINDOW records by rowid, a slice at a time, the rows matching `where` kept. True when older records exist past the window. */
  const newestWindow=async(where:string):Promise<boolean>=>{
    const top=Number((await slice(db,"main","SELECT max(rowid) AS n FROM memory_records",[]))[0]?.n??0);
    let below=top+1;
    for(let seen=0;seen<OWNER_TAIL_WINDOW&&below>1;){
      const rows=await slice(db,"main",`SELECT c.rr AS rr,r.* FROM (SELECT rowid AS rr FROM memory_records WHERE rowid<? ORDER BY rowid DESC LIMIT ${OWNER_SLICE_ROWS}) c
        LEFT JOIN memory_records r ON r.rowid=c.rr AND ${filters.join(" AND ")} AND ${where} AND ${textAll} ORDER BY c.rr DESC`,[below,...args,...textArgs]);
      if(!rows.length)return false;
      seen+=rows.length;below=Number(rows.at(-1)!.rr);
      keepTail(rows);
      if(rows.length<OWNER_SLICE_ROWS)return false;
    }
    return below>1&&(await slice(db,"main","SELECT 1 AS n FROM memory_records WHERE rowid<? LIMIT 1",[below])).length>0;
  };

  const reader=terms.length?ownerIndexHandle():null;
  if(!reader){
    // No readable index: the text match alone, over the newest records.
    if(await newestWindow("1"))cut();
    return finish("source-text",[],false,0,false,"The search index is catching up. Showing source-text matches.");
  }

  // 1. The search index, newest first by its own rowid, a slice at a time, on the one reader handle (taken again for every slice).
  ownerSearchWork.indexedQueries++;
  const expression=terms.map(term=>`"${term.replaceAll('"','""')}"`).join(" AND ");
  const stepSql=`SELECT m.ix AS ix,r.* FROM (SELECT rowid AS ix,id,version FROM lexical WHERE lexical MATCH ? AND rowid<? ORDER BY rowid DESC LIMIT ${OWNER_SLICE_ROWS}) m
    LEFT JOIN authority.memory_records r ON r.id=m.id AND r.version=CAST(m.version AS INTEGER) AND ${base.join(" AND ")} ORDER BY m.ix DESC`;
  const indexed:Array<Record<string,unknown>>=[];
  let stepped=afterIx,steppedRows=0,eligible=0,exhausted=afterIx===0,lost=false;
  while(!exhausted){
    const handle=ownerIndexHandle();
    if(!handle){lost=true;break;}
    const rows=await slice(handle,"index",stepSql,[expression,stepped,...baseArgs]);
    steppedRows+=rows.length;
    for(const row of rows){
      stepped=Number(row.ix);
      if(row.id===null||row.id===undefined)continue;
      eligible++;
      if(indexed.length<51)indexed.push(row);
    }
    if(rows.length<OWNER_SLICE_ROWS){exhausted=true;break;}
    // the page is full; on the first page the count goes on to its cap
    if(indexed.length>=51&&(!firstPage||eligible>=OWNER_COUNT_CAP))break;
    if(steppedRows>=OWNER_INDEX_MATCHES)break;
  }
  if(lost)say("The search index is catching up. Showing source-text matches.");
  // a page that stopped at the step limit before it filled may have left matches further down: said, and the next page carries on
  const indexStopped=!exhausted&&indexed.length<51;
  if(indexStopped)cut();

  // 2. The records not projected yet, through the pending index.
  ownerSearchWork.tailQueries++;
  const pendingAll=Number((await slice(db,"main",`SELECT count(*) AS n FROM (SELECT 1 FROM memory_projection_receipts WHERE lexical_status IN ${PENDING_STATUS} LIMIT ${OWNER_TAIL_RECEIPTS+1})`,[]))[0]?.n??0);
  const pendingMatch=`${filters.join(" AND ")} AND r.kind NOT IN ${PIP_ALL_KINDS_SQL} AND ${textAll}`;
  let pendingFound=0;
  if(pendingAll<=OWNER_TAIL_RECEIPTS){
    for(let offset=0;offset<pendingAll;offset+=OWNER_SLICE_ROWS){
      const rows=await slice(db,"main",`SELECT r.* FROM (SELECT record_id,record_version FROM memory_projection_receipts WHERE lexical_status IN ${PENDING_STATUS}
        ORDER BY lexical_status,record_id,record_version LIMIT ${OWNER_SLICE_ROWS} OFFSET ?) p LEFT JOIN memory_records r ON r.id=p.record_id AND r.version=p.record_version AND ${pendingMatch}`,[offset,...args,...textArgs]);
      const before=tailCount;keepTail(rows);pendingFound+=tailCount-before;
    }
  }else{
    // More pending than one search reads: the newest OWNER_TAIL_WINDOW receipts by rowid, the pending ones among them, and a word.
    cut();
    let below=Number.MAX_SAFE_INTEGER,pendingSeen=0;
    for(let seen=0;seen<OWNER_TAIL_WINDOW&&pendingSeen<OWNER_TAIL_RECEIPTS;){
      const rows=await slice(db,"main",`SELECT p.rr AS rr,p.pending AS pending,r.* FROM (SELECT rowid AS rr,record_id,record_version,lexical_status IN ${PENDING_STATUS} AS pending FROM memory_projection_receipts WHERE rowid<? ORDER BY rowid DESC LIMIT ${OWNER_SLICE_ROWS}) p
        LEFT JOIN memory_records r ON p.pending AND r.id=p.record_id AND r.version=p.record_version AND ${pendingMatch} ORDER BY p.rr DESC`,[below,...args,...textArgs]);
      if(!rows.length)break;
      seen+=rows.length;below=Number(rows.at(-1)!.rr);
      for(const row of rows)if(Number(row.pending))pendingSeen++;
      const before=tailCount;keepTail(rows.map(({pending:_p,...row})=>row));pendingFound+=tailCount-before;
      if(rows.length<OWNER_SLICE_ROWS)break;
    }
  }
  if(pendingFound)say("Some recent notes are still being added to the search index. They are matched by their text.");

  // 3. The kinds the index never holds: through the owner-tail table (once its backfill is done), newest first from the page's place.
  if(ownerTailReady(db)){
    let at=after.at,key:[string,number]|null=null,seen=0,more=true;
    const tailRows=(where:string)=>`SELECT created_at AS ca,record_id AS rid,record_version AS rv FROM ${OWNER_TAIL_TABLE} WHERE ${where} ORDER BY created_at DESC,record_id DESC,record_version DESC`;
    const from=()=>key?"(created_at,record_id,record_version)<(?,?,?)":"created_at<=?";
    const fromArgs=()=>key?[at,key[0],key[1]]:[at];
    while(more&&seen<OWNER_TAIL_WINDOW){
      const rows=await slice(db,"main",`SELECT c.ca AS ca,c.rid AS rid,c.rv AS rv,r.* FROM (${tailRows(from())} LIMIT ${OWNER_SLICE_ROWS}) c
        LEFT JOIN memory_records r ON r.id=c.rid AND r.version=c.rv AND r.created_at=c.ca AND ${filters.join(" AND ")} AND ${neverIndexed} AND ${textAll} ORDER BY c.ca DESC,c.rid DESC,c.rv DESC`,[...fromArgs(),...args,...textArgs]);
      seen+=rows.length;more=rows.length===OWNER_SLICE_ROWS;
      if(rows.length){const last=rows.at(-1)!;at=Number(last.ca);key=[String(last.rid),Number(last.rv)];}
      keepTail(rows.map(({ca:_c,rid:_i,rv:_v,...row})=>row));
    }
    if(more&&(await slice(db,"main",`SELECT 1 AS n FROM ${OWNER_TAIL_TABLE} WHERE ${from()} LIMIT 1`,fromArgs())).length)cut();
  }else if(await newestWindow(neverIndexed))cut();

  return finish("indexed",indexed,exhausted,eligible,firstPage&&(eligible>=OWNER_COUNT_CAP||indexStopped),undefined);

  /** The page: the index list (in index order) and the tail list (newest first) merged two-way, each consumed as a prefix, so the next
   * page carries on from the last row of each that was shown. */
  function finish(mode:string,fromIndex:Array<Record<string,unknown>>,indexDone:boolean,indexCount:number,indexCapped:boolean,notice:string|undefined):OwnerListResult{
    if(notice)say(notice);
    const seenKeys=new Set(fromIndex.map(keyOf));
    const rest=[...new Map(tail.filter(row=>!seenKeys.has(keyOf(row))).map(row=>[keyOf(row),row])).values()].sort(byAge);
    const rows:Array<Record<string,unknown>>=[];
    let i=0,t=0,lastIndexed:Record<string,unknown>|undefined,lastTail:Record<string,unknown>|undefined;
    while(rows.length<50&&(i<fromIndex.length||t<rest.length)){
      if(t>=rest.length||(i<fromIndex.length&&byAge(fromIndex[i]!,rest[t]!)<=0)){lastIndexed=fromIndex[i++];rows.push(strip(lastIndexed!));}
      else{lastTail=rest[t++];rows.push(lastTail!);}
    }
    // the index part resumes below the last indexed row shown, or below where it stepped to when every row it kept was shown
    const ix=i<fromIndex.length?Number(lastIndexed?.ix??afterIx):indexDone?0:mode==="indexed"?stepped:0;
    const tailCursor=lastTail?{at:Number(lastTail.created_at),id:String(lastTail.id),version:Number(lastTail.version)}:after;
    // more when a kept row was not shown, the tail list was trimmed (more matches than it keeps), or the index part is not finished
    const more=i<fromIndex.length||t<rest.length||tailCount>tail.length||ix>0;
    const result:OwnerListResult={rows,searchMode:mode,scopeIds:scopes,coverageComplete};
    if(more)result.nextCursor=Buffer.from(JSON.stringify({...tailCursor,ix})).toString("base64url");
    if(firstPage){
      const total=indexCount+tailCount,capped=indexCapped||total>=OWNER_COUNT_CAP;
      result.matchCount=Math.min(total,OWNER_COUNT_CAP);
      result.matchCountLabel=capped?`${Math.min(total,OWNER_COUNT_CAP).toLocaleString("en-US")}+`:String(total);
      if(total>=OWNER_COUNT_CAP)say(OWNER_MANY_NOTICE);
    }
    if(searchNotice)result.searchNotice=searchNotice;
    return result;
  }
}

function page(rows:Array<Record<string,unknown>>,searchMode:string,scopeIds:string[]|null):OwnerListResult{
  const tail=rows[49];
  return {rows:rows.slice(0,50),searchMode,scopeIds,...rows.length>50?{nextCursor:Buffer.from(JSON.stringify({at:Number(tail.created_at),id:String(tail.id),version:Number(tail.version)})).toString("base64url")}:{}};
}
