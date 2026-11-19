// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Consumer owner: recall-scope. All page drivers begin with (view_id,generation,pagination key).
import type { DatabaseSync } from 'node:sqlite';
import { noteViewCandidates, noteViewText, readableRecallView, type RecallViewHandle } from './recall-view.ts';
import { wordTerms } from './postings.ts';
import type { IndexHit } from './index.ts';
import { PIP_ALL_KINDS_SQL } from './pip-kinds.ts';

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
function refs(rows: Array<Record<string,unknown>>): ViewRef[] { return rows.map(row=>({id:String(row.id),version:Number(row.version),rowid:Number(row.rowid)})); }
export function eligibleViewPage(db: DatabaseSync,view: RecallViewHandle,cursor: string,limit: number,budget=new RecallWorkBudget()): ViewRef[] {
  view=readableRecallView(db,view);
  let id='',version=-1;
  if(cursor!=='') { try { const pair=JSON.parse(cursor);if(!Array.isArray(pair)||typeof pair[0]!=='string'||!Number.isInteger(pair[1]))throw 0;[id,version]=pair; } catch { throw new Error('INVALID_MEMORY_CURSOR'); } }
  const rows=db.prepare(VIEW_RECORD_PAGE_SQL).all(view.viewId,view.generation,id,version,Math.min(limit,budget.remaining));budget.candidates(rows.length);return refs(rows);
}
export function recentViewPage(db: DatabaseSync,view: RecallViewHandle,before: number,limit: number,budget=new RecallWorkBudget()): ViewRef[] {
  view=readableRecallView(db,view);
  const rows=db.prepare(VIEW_RECENT_PAGE_SQL).all(view.viewId,view.generation,before,Math.min(limit,budget.remaining));budget.candidates(rows.length);return refs(rows);
}
/** The LIMIT of each statement is applied to RAW receipts (before the view-membership and pip filters), and every raw receipt read is charged to the
 * budget, so a backlog of pending receipts that belong to other views costs the request its allowance, never unbounded time. A window that holds no
 * member of this view is followed by the next one; a statement's rows count as settled only up to the least key every unfinished statement has reached. */
export function pendingViewPage(db: DatabaseSync,view: RecallViewHandle,cursor: string,limit: number,budget=new RecallWorkBudget()): ViewRef[] {
  view=readableRecallView(db,view);
  let id='',version=-1;
  if(cursor!=='') { try { const pair=JSON.parse(cursor);if(!Array.isArray(pair)||typeof pair[0]!=='string'||!Number.isInteger(pair[1]))throw 0;[id,version]=pair; } catch { throw new Error('INVALID_MEMORY_CURSOR'); } }
  const binary=(a:string,b:string)=>a<b?-1:a>b?1:0,order=(a:{id:string;version:number},b:{id:string;version:number})=>binary(a.id,b.id)||a.version-b.version;
  const reads=VIEW_PENDING_PAGE_SQL.map(sql=>({stmt:db.prepare(sql),from:{id,version},done:false}));
  const found=new Map<string,ViewRef>();
  const unfinished=()=>reads.filter(read=>!read.done).sort((a,b)=>order(a.from,b.from))[0];
  const settled=()=>{ const open=unfinished();return [...found.values()].filter(ref=>!open||order(ref,open.from)<=0).sort(order).slice(0,limit); };
  for(let open=unfinished();open;open=unfinished()) {
    const n=Math.min(limit,budget.remaining);
    if(n<=0)break;
    for(const read of reads) {
      if(read.done||order(read.from,open.from)!==0)continue;
      const rows=read.stmt.all(view.viewId,view.generation,read.from.id,read.from.version,n);budget.candidates(rows.length);
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
export function lexicalViewPage(db: DatabaseSync,query: string,view: RecallViewHandle,limit: number,offset=0,budget=new RecallWorkBudget()) {
  view=readableRecallView(db,view);
  const key=JSON.stringify([view,query]);let window=lexicalWindows.get(budget);
  if(!window || window.key!==key) {
    const tokens=wordTerms(query).slice(0,8), ranked=new Map<string,IndexHit & {sequence:number}>(); let bounded=false;
    const share=Math.floor(budget.remaining/Math.max(1,tokens.length));
    const pick=db.prepare(VIEW_TERM_PAGE_SQL);
    for(const term of tokens) {
      const rows=pick.all(view.viewId,view.generation,term,Number.MAX_SAFE_INTEGER,Math.min(share,budget.remaining));budget.candidates(rows.length);
      if(rows.length===share)bounded=true;
      for(const row of rows) { const id=String(row.id),version=Number(row.version),key=`${id}:${version}`,previous=ranked.get(key);
        ranked.set(key,{id,version,score:(previous?.score??0)+1,lexical:true,sequence:Number(row.rowid)}); }
    }
    const hits=[...ranked.values()].sort((a,b)=>b.score-a.score || a.id.localeCompare(b.id) || a.version-b.version).map(({sequence,...hit})=>hit);
    window={key,hits,bounded};lexicalWindows.set(budget,window);
  }
  return {hits:window.hits.slice(offset,offset+limit),more:window.hits.length>offset+limit,bounded:window.bounded,partial:window.bounded};
}

/** Frame pins and identity have their own aggregate drivers; unrelated history cannot hide a mandatory pin behind a global window. */
export function frameViewPage(db: DatabaseSync,view: RecallViewHandle,kinds: readonly string[] | null,limit: number,budget: RecallWorkBudget): Array<{id:string;version:number}> {
  view=readableRecallView(db,view);
  const sql=kinds===null
    ? `SELECT record_id AS id,version FROM memory_recall_view_records INDEXED BY memory_recall_records_pins WHERE view_id=?1 AND generation=?2 AND pinned=1 AND state='active' ORDER BY record_id,version LIMIT ?3`
    : `SELECT record_id AS id,version FROM memory_recall_view_records INDEXED BY memory_recall_records_kind WHERE view_id=?1 AND generation=?2 AND kind IN (SELECT value FROM json_each(?4)) LIMIT ?3`;
  const args=[view.viewId,view.generation,Math.min(limit,budget.remaining),...kinds===null?[]:[JSON.stringify(kinds)]];
  const rows=db.prepare(sql).all(...args);budget.candidates(rows.length);return rows.map(row=>({id:String(row.id),version:Number(row.version)}));
}
