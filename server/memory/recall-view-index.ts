// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Consumer owner: recall-scope. All page drivers begin with (view_id,generation,pagination key).
import type { DatabaseSync } from 'node:sqlite';
import { noteViewCandidates, noteViewText, readableRecallView, RECALL_VIEW_WINDOW_TERM, type RecallViewHandle } from './recall-view.ts';
import { wordTerms } from './postings.ts';
import type { IndexHit } from './index.ts';
import { PIP_ALL_KINDS_SQL } from './pip-kinds.ts';
import { coldTextPage, eligibleScopePage, frameScopePage, pendingScopePage, recentScopePage, scopeSetOf, type RecentCut } from './oneindex.ts';

export const RECALL_RAW_LIMIT=16_384, RECALL_TEXT_LIMIT=8*1024*1024;
export class RecallWorkBudget {
  raw=0; bytes=0;
  private maxRaw: number;
  private parent?:RecallWorkBudget;
  constructor(maxRaw=RECALL_RAW_LIMIT,parent?:RecallWorkBudget) { this.maxRaw=maxRaw;this.parent=parent; }
  get remaining():number { return Math.min(Math.max(0,this.maxRaw-this.raw),this.parent?.remaining??Infinity); }
  get byteRemaining():number { return this.parent?.byteRemaining??Math.max(0,RECALL_TEXT_LIMIT-this.bytes); }
  /** Scans share this request's counters and byte ceiling, leaving raw work for authorization. */
  reserveCandidates(n:number):RecallWorkBudget { return new RecallWorkBudget(Math.max(0,this.remaining-n),this); }
  candidates(n: number) { if(n>this.remaining)throw new Error('MEMORY_RECALL_WORK_LIMIT');if(this.parent)this.parent.candidates(n);else noteViewCandidates(n);this.raw+=n; }
  text(n: number) { if(n>this.byteRemaining)return false;if(this.parent){if(!this.parent.text(n))return false;}else noteViewText(n);this.bytes+=n;return true; }
}
export interface ViewRef { id: string; version: number; rowid: number }
/** Deleted data never returns in recall: a view row is a snapshot, but a record deleted since, or one resting on a source that was deleted
 * (memory-revocation.ts endSource ends the source first; its records are ended by a later, budgeted step of the job), leaves every view page
 * at once, read against the live rows, the same source-state join the view-less eligibility makes (eligibility.ts CURRENT_MEMORY). */
export const LIVE_VIEW_ROW=(v: string)=>`NOT EXISTS (SELECT 1 FROM memory_records lr WHERE lr.id=${v}.record_id AND lr.version=${v}.version AND lr.state='deleted')
  AND NOT EXISTS (SELECT 1 FROM memory_evidence le JOIN memory_sources ls ON ls.id=le.source_id WHERE le.record_id=${v}.record_id AND le.record_version=${v}.version AND ls.state='deleted')`;
export const VIEW_RECORD_PAGE_SQL=`SELECT record_id AS id,version,sequence AS rowid FROM memory_recall_view_records
  WHERE view_id=? AND generation=? AND (record_id,version)>(?,?) AND ${LIVE_VIEW_ROW('memory_recall_view_records')} ORDER BY record_id,version LIMIT ?`;
export const VIEW_RECENT_PAGE_SQL=`SELECT record_id AS id,version,sequence AS rowid FROM memory_recall_view_records INDEXED BY memory_recall_records_recent
  WHERE view_id=? AND generation=? AND sequence<? AND ${LIVE_VIEW_ROW('memory_recall_view_records')} ORDER BY sequence DESC LIMIT ?`;
/** Pending receipts of this view's records, in key order (record_id, record_version). One statement per pending status, each a keyed range read of the
 * receipts' own memory_projection_pending index (the drain already maintains it, so the page costs the drain nothing); pip kinds only count when their
 * removal is owed, as projectRecord used to decide. Callers walk the page to the first record the reader may read, so any stable total order serves. */
export const VIEW_PENDING_STATUSES=['pending','pending-archive','delete-pending'] as const;
export const VIEW_PENDING_PAGE_SQL=VIEW_PENDING_STATUSES.map(status=>`SELECT r.record_id AS id,r.record_version AS version,r.rowid AS rowid,(v.record_id IS NOT NULL${status==='delete-pending'?'':` AND v.kind NOT IN ${PIP_ALL_KINDS_SQL}`}) AS hit FROM memory_projection_receipts r INDEXED BY memory_projection_pending
  LEFT JOIN memory_recall_view_records v ON v.view_id=?1 AND v.generation=?2 AND v.record_id=r.record_id AND v.version=r.record_version
  WHERE r.lexical_status='${status}' AND (r.record_id,r.record_version)>(?3,?4) ORDER BY r.record_id,r.record_version LIMIT ?5`);
export const VIEW_JOBS_PAGE_SQL=`SELECT job_id AS id,sequence AS rowid FROM memory_recall_view_jobs
  WHERE view_id=? AND generation=? AND sequence<? ORDER BY sequence DESC LIMIT ?`;
export const VIEW_TERM_PAGE_SQL=`SELECT record_id AS id,version,sequence AS rowid FROM memory_recall_view_terms
  WHERE view_id=? AND generation=? AND term=? AND sequence<? AND ${LIVE_VIEW_ROW('memory_recall_view_terms')} ORDER BY sequence DESC LIMIT ?`;
/** memv2 lane A (A5, MISSED 3). A word search that can only be answered by live versions (every mode but the historical one, readable.ts
 *  RECORD_SQL) skips the term rows of superseded and archived versions inside the statement, before the limit, by the view's own record
 *  row (one key seek): the dead versions of a much-revised note no longer take the page from live records, also while the paced pass
 *  that removes stored dead terms (recall-view.ts recallDeadTermsStep) has not finished. Dead versions get no terms any more; the
 *  historical search reads their words from their text (VIEW_DEAD_PAGE_SQL, lexicalViewPage). */
export const VIEW_LIVE_TERM_PAGE_SQL=`SELECT record_id AS id,version,sequence AS rowid FROM memory_recall_view_terms
  WHERE view_id=? AND generation=? AND term=? AND sequence<? AND ${LIVE_VIEW_ROW('memory_recall_view_terms')}
  AND EXISTS (SELECT 1 FROM memory_recall_view_records vr WHERE vr.view_id=memory_recall_view_terms.view_id AND vr.generation=memory_recall_view_terms.generation
    AND vr.record_id=memory_recall_view_terms.record_id AND vr.version=memory_recall_view_terms.version AND vr.state IN ('active','candidate'))
  ORDER BY sequence DESC LIMIT ?`;
/** The superseded and archived versions a view holds, in key order, through the view's own (pinned, state) index: two seeks a state, no
 *  walk over live rows. The historical word search matches their words from the record text (they carry no term rows, A5).
 *  Exactly the versions that had term rows before A5, and no other: never a PIP kind (pip-kinds.ts A1: never through search, never
 *  ranked) and never a rolled checkpoint (a dead checkpoint version with a newer one), the two rules of the term writer
 *  (recall-view.ts projectRecord / recordFacts). Named bound: the scan reads the first rows of that key order its budget allows and
 *  says `bounded` when it was cut; it has no continuation of its own. */
export const VIEW_DEAD_PAGE_SQL=`SELECT record_id AS id,version,sequence AS rowid FROM memory_recall_view_records INDEXED BY memory_recall_records_pins
  WHERE view_id=?1 AND generation=?2 AND pinned IN (0,1) AND state IN ('superseded','archived') AND kind NOT IN ${PIP_ALL_KINDS_SQL}
  AND NOT (kind='checkpoint' AND EXISTS (SELECT 1 FROM memory_records nv WHERE nv.id=memory_recall_view_records.record_id AND nv.version>memory_recall_view_records.version))
  AND ${LIVE_VIEW_ROW('memory_recall_view_records')} ORDER BY pinned,state,record_id,version LIMIT ?3`;
/** q1022-recallperf item 3. A view past RECALL_VIEW_TERM_BUDGET holds no term rows for its records at or below the window marker's sequence (the
 *  build walks newest first and stops writing terms at the first record that does not fit). A word search still answers from them: their words
 *  are read from the record text, newest first through the view's recent index, each row and its bytes charged to the request's budget, exactly
 *  as the historical search reads dead versions. Same rules as the term writer (recall-view.ts projectRecord): live states only, never a PIP
 *  kind; deleted records and records on a deleted source never come back (LIVE_VIEW_ROW). Only when the budget cuts this scan is the answer
 *  bounded. Nothing is stored, so the 512 MiB quota and every forget path are unchanged. */
export const VIEW_UNTERMED_PAGE_SQL=`SELECT record_id AS id,version,sequence AS rowid FROM memory_recall_view_records INDEXED BY memory_recall_records_recent
  WHERE view_id=?1 AND generation=?2 AND sequence<=?3 AND state IN ('active','candidate') AND kind NOT IN ${PIP_ALL_KINDS_SQL}
  AND NOT (kind='checkpoint' AND state<>'active' AND EXISTS (SELECT 1 FROM memory_records nv WHERE nv.id=memory_recall_view_records.record_id AND nv.version>memory_recall_view_records.version))
  AND ${LIVE_VIEW_ROW('memory_recall_view_records')} ORDER BY sequence DESC LIMIT ?4`;
function refs(rows: Array<Record<string,unknown>>): ViewRef[] { return rows.map(row=>({id:String(row.id),version:Number(row.version),rowid:Number(row.rowid)})); }
/** `cut` (scope-set handles): set to the continuation cursor when the page stopped at the raw budget, not at the end of the set (oneindex.ts). */
export function eligibleViewPage(db: DatabaseSync,view: RecallViewHandle,cursor: string,limit: number,budget=new RecallWorkBudget(),cut?: {next?:string}): ViewRef[] {
  { const held=scopeSetOf(view);if(held)return eligibleScopePage(db,held.set,cursor,limit,budget,cut); }
  view=readableRecallView(db,view);
  let id='',version=-1;
  if(cursor!=='') { try { const pair=JSON.parse(cursor);if(!Array.isArray(pair)||typeof pair[0]!=='string'||!Number.isInteger(pair[1]))throw 0;[id,version]=pair; } catch { throw new Error('INVALID_MEMORY_CURSOR'); } }
  const rows=db.prepare(VIEW_RECORD_PAGE_SQL).all(view.viewId,view.generation,id,version,Math.min(limit,budget.remaining));budget.candidates(rows.length);return refs(rows);
}
/** `cut` (scope-set handles): a page the raw budget ended sets `cut.before`; a short page is the end of the set only when it stays unset.
 * The same `cut` object passed to the next page of one walk continues it from the rows already read and charged (oneindex.ts RecentCut). */
export function recentViewPage(db: DatabaseSync,view: RecallViewHandle,before: number,limit: number,budget=new RecallWorkBudget(),cut?: RecentCut): ViewRef[] {
  { const held=scopeSetOf(view);if(held)return recentScopePage(db,held.set,before,limit,budget,cut); }
  view=readableRecallView(db,view);
  const rows=db.prepare(VIEW_RECENT_PAGE_SQL).all(view.viewId,view.generation,before,Math.min(limit,budget.remaining));budget.candidates(rows.length);return refs(rows);
}
/** The LIMIT of each statement is applied to RAW receipts (before the view-membership and pip filters), and every raw receipt read is charged to the
 * budget, so a backlog of pending receipts that belong to other views costs the request its allowance, never unbounded time. A window that holds no
 * member of this view is followed by the next one; a statement's rows count as settled only up to the least key every unfinished statement has reached. */
export function pendingViewPage(db: DatabaseSync,view: RecallViewHandle,cursor: string,limit: number,budget=new RecallWorkBudget()): ViewRef[] {
  { const held=scopeSetOf(view);if(held)return pendingScopePage(db,held.set,cursor,limit,budget); }
  view=readableRecallView(db,view);
  let id='',version=-1;
  if(cursor!=='') { try { const pair=JSON.parse(cursor);if(!Array.isArray(pair)||typeof pair[0]!=='string'||!Number.isInteger(pair[1]))throw 0;[id,version]=pair; } catch { throw new Error('INVALID_MEMORY_CURSOR'); } }
  return pendingWindows(VIEW_PENDING_PAGE_SQL.map(sql=>{ const stmt=db.prepare(sql);return (from:{id:string;version:number},n:number)=>stmt.all(view.viewId,view.generation,from.id,from.version,n); }),{id,version},limit,budget);
}
/** The bounded walk both pending pages share (the view's and the scope set's, oneindex.ts pendingScopePage): one keyed read per status, raw rows
 * LIMITed and charged, a row counts when its `hit` is 1, and a statement's rows count as settled only up to the least key every unfinished read reached. */
export function pendingWindows(reads0: Array<(from:{id:string;version:number},n:number)=>Array<Record<string,unknown>>>,start:{id:string;version:number},limit: number,budget: RecallWorkBudget): ViewRef[] {
  const {id,version}=start;
  const binary=(a:string,b:string)=>a<b?-1:a>b?1:0,order=(a:{id:string;version:number},b:{id:string;version:number})=>binary(a.id,b.id)||a.version-b.version;
  const reads=reads0.map(run=>({run,from:{id,version},done:false}));
  const found=new Map<string,ViewRef>();
  const unfinished=()=>reads.filter(read=>!read.done).sort((a,b)=>order(a.from,b.from))[0];
  const settled=()=>{ const open=unfinished();return [...found.values()].filter(ref=>!open||order(ref,open.from)<=0).sort(order).slice(0,limit); };
  for(let open=unfinished();open;open=unfinished()) {
    if(Math.min(limit,budget.remaining)<=0)break;
    for(const read of reads) {
      // n per read: the reads of one pass never take more together than the budget holds (a shared n read 3 x n and threw WORK_LIMIT).
      const n=Math.min(limit,budget.remaining);
      if(n<=0||read.done||order(read.from,open.from)!==0)continue;
      const rows=read.run(read.from,n);budget.candidates(rows.length);
      for(const row of rows) { const ref={id:String(row.id),version:Number(row.version),rowid:Number(row.rowid)},key=JSON.stringify([ref.id,ref.version]),seen=found.get(key);
        if(Number(row.hit)===1&&(!seen||ref.rowid<seen.rowid))found.set(key,ref); }
      if(rows.length<n)read.done=true;
      if(rows.length)read.from={id:String(rows[rows.length-1].id),version:Number(rows[rows.length-1].version)};
    }
    const page=settled();if(page.length)return page;
  }
  return settled();
}
export function catchUpViewPage(db: DatabaseSync,view: RecallViewHandle,before: number,limit: number,budget=new RecallWorkBudget()): Array<{id:string;rowid:number}> {
  if(scopeSetOf(view))return [];
  view=readableRecallView(db,view);
  const rows=db.prepare(VIEW_JOBS_PAGE_SQL).all(view.viewId,view.generation,before,Math.min(limit,budget.remaining));budget.candidates(rows.length);
  return rows.map(row=>({id:String(row.id),rowid:Number(row.rowid)}));
}
/** The payload is fetched only after its stored byte length fits the shared request allowance. */
export function viewRecordText(db: DatabaseSync,ref: {id:string;version:number},budget: RecallWorkBudget): string | null {
  const size=db.prepare('SELECT octet_length(text) AS n FROM memory_records WHERE id=? AND version=?').get(ref.id,ref.version);
  if(!size || !budget.text(Number(size.n)))return null;
  const row=db.prepare('SELECT text FROM memory_records WHERE id=? AND version=?').get(ref.id,ref.version);
  return row?String(row.text):null;
}
const lexicalWindows=new WeakMap<RecallWorkBudget,{key:string;hits:IndexHit[];bounded:boolean}>();
/** Probe aggregate term lists, never scope postings or shared FTS. A raw LIMIT precedes all content/evidence gates. */
export function lexicalViewPage(db: DatabaseSync,query: string,view: RecallViewHandle,limit: number,offset=0,budget=new RecallWorkBudget(),liveOnly=false,historical=false) {
  { const held=scopeSetOf(view);if(held)return coldTextPage(db,held.set,query,limit,offset,budget,wordTerms); }
  view=readableRecallView(db,view);
  const key=JSON.stringify([view,query,liveOnly,historical]);let window=lexicalWindows.get(budget);
  if(!window || window.key!==key) {
    const tokens=wordTerms(query).slice(0,8), ranked=new Map<string,IndexHit & {sequence:number}>();
    // A big thread's view indexes words of its newest window only (RECALL_VIEW_TERM_BUDGET); the records older than its marker are read below.
    const marker=db.prepare('SELECT sequence FROM memory_recall_view_terms WHERE view_id=? AND generation=? AND term=? LIMIT 1').get(view.viewId,view.generation,RECALL_VIEW_WINDOW_TERM);
    let bounded=false;
    const share=Math.floor(budget.remaining/Math.max(1,tokens.length));
    const pick=db.prepare(liveOnly?VIEW_LIVE_TERM_PAGE_SQL:VIEW_TERM_PAGE_SQL);
    for(const term of tokens) {
      const rows=pick.all(view.viewId,view.generation,term,Number.MAX_SAFE_INTEGER,Math.min(share,budget.remaining));budget.candidates(rows.length);
      if(rows.length===share)bounded=true;
      for(const row of rows) { const id=String(row.id),version=Number(row.version),key=`${id}:${version}`,previous=ranked.get(key);
        ranked.set(key,{id,version,score:(previous?.score??0)+1,lexical:true,sequence:Number(row.rowid)}); }
    }
    // A5: the historical search also answers from superseded and archived versions, which carry no terms. Their words are read from
    // the record text, each row and its bytes charged to the request's budget; a scan the budget cuts says so (bounded).
    if(historical && !liveOnly && tokens.length) {
      const room=Math.max(0,Math.min(share,budget.remaining));
      const dead=room>0?db.prepare(VIEW_DEAD_PAGE_SQL).all(view.viewId,view.generation,room):[];budget.candidates(dead.length);
      if(dead.length===room)bounded=true;
      for(const row of dead) {
        const id=String(row.id),version=Number(row.version),text=viewRecordText(db,{id,version},budget);
        if(text===null){bounded=true;break;}
        const words=new Set(wordTerms(text));let score=0;for(const term of tokens)if(words.has(term))score++;
        const key=`${id}:${version}`,previous=ranked.get(key);
        if(score>(previous?.score??0))ranked.set(key,{id,version,score,lexical:true,sequence:Number(row.rowid)});
      }
    }
    // q1022-recallperf item 3: the records older than the window are matched from their text (VIEW_UNTERMED_PAGE_SQL).
    if(marker && tokens.length) {
      const room=Math.max(0,Math.min(share,budget.remaining));
      const older=room>0?db.prepare(VIEW_UNTERMED_PAGE_SQL).all(view.viewId,view.generation,Number(marker.sequence),room):[];budget.candidates(older.length);
      if(older.length===room)bounded=true;
      for(const row of older) {
        const id=String(row.id),version=Number(row.version),text=viewRecordText(db,{id,version},budget);
        if(text===null){bounded=true;break;}
        const words=new Set(wordTerms(text));let score=0;for(const term of tokens)if(words.has(term))score++;
        const key=`${id}:${version}`,previous=ranked.get(key);
        if(score>(previous?.score??0))ranked.set(key,{id,version,score,lexical:true,sequence:Number(row.rowid)});
      }
    }
    const hits=[...ranked.values()].sort((a,b)=>b.score-a.score || a.id.localeCompare(b.id) || a.version-b.version).map(({sequence,...hit})=>hit);
    window={key,hits,bounded};lexicalWindows.set(budget,window);
  }
  return {hits:window.hits.slice(offset,offset+limit),more:window.hits.length>offset+limit,bounded:window.bounded,partial:window.bounded};
}

/** Frame pins and identity have their own aggregate drivers; unrelated history cannot hide a mandatory pin behind a global window. */
/** `cut` (scope-set handles): a frame walk the raw budget ended sets `cut.next`; the frame is whole only when it stays unset (`after` walks on;
 * `within` narrows the walk to those scopes of the set). */
export function frameViewPage(db: DatabaseSync,view: RecallViewHandle,kinds: readonly string[] | null,limit: number,budget: RecallWorkBudget,cut?: {next?:string},after='',within?: readonly string[]): Array<{id:string;version:number}> {
  { const held=scopeSetOf(view);if(held)return frameScopePage(db,held.set,kinds,limit,budget,cut,after,within); }
  view=readableRecallView(db,view);
  const sql=kinds===null
    ? `SELECT record_id AS id,version FROM memory_recall_view_records INDEXED BY memory_recall_records_pins WHERE view_id=?1 AND generation=?2 AND pinned=1 AND state='active' ORDER BY record_id,version LIMIT ?3`
    : `SELECT record_id AS id,version FROM memory_recall_view_records INDEXED BY memory_recall_records_kind WHERE view_id=?1 AND generation=?2 AND kind IN (SELECT value FROM json_each(?4)) LIMIT ?3`;
  const args=[view.viewId,view.generation,Math.min(limit,budget.remaining),...kinds===null?[]:[JSON.stringify(kinds)]];
  const rows=db.prepare(sql).all(...args);budget.candidates(rows.length);return rows.map(row=>({id:String(row.id),version:Number(row.version)}));
}
