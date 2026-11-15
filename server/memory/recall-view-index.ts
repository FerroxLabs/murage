// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Consumer owner: recall-scope. All page drivers begin with (view_id,generation,pagination key).
import type { DatabaseSync } from 'node:sqlite';
import { assertRecallView, noteViewCandidates, noteViewText, type RecallViewHandle } from './recall-view.ts';
import { wordTerms } from './postings.ts';
import type { IndexHit } from './index.ts';

export const RECALL_RAW_LIMIT=16_384, RECALL_TEXT_LIMIT=8*1024*1024;
export class RecallWorkBudget {
  raw=0; bytes=0;
  private maxRaw: number;
  constructor(maxRaw=RECALL_RAW_LIMIT) { this.maxRaw=maxRaw; }
  get remaining() { return Math.max(0,this.maxRaw-this.raw); }
  get byteRemaining() { return Math.max(0,RECALL_TEXT_LIMIT-this.bytes); }
  candidates(n: number) { if(n>this.remaining)throw new Error('MEMORY_RECALL_WORK_LIMIT');this.raw+=n;noteViewCandidates(n); }
  text(n: number) { if(n>this.byteRemaining)return false;this.bytes+=n;noteViewText(n);return true; }
}
export interface ViewRef { id: string; version: number; rowid: number }
export const VIEW_RECORD_PAGE_SQL=`SELECT record_id AS id,version,sequence AS rowid FROM memory_recall_view_records
  WHERE view_id=? AND generation=? AND (record_id,version)>(?,?) ORDER BY record_id,version LIMIT ?`;
export const VIEW_RECENT_PAGE_SQL=`SELECT record_id AS id,version,sequence AS rowid FROM memory_recall_view_records INDEXED BY memory_recall_records_recent
  WHERE view_id=? AND generation=? AND sequence<? ORDER BY sequence DESC LIMIT ?`;
export const VIEW_PENDING_PAGE_SQL=`SELECT record_id AS id,version,sequence AS rowid FROM memory_recall_view_pending
  WHERE view_id=? AND generation=? AND sequence>? ORDER BY sequence,record_id,version LIMIT ?`;
export const VIEW_JOBS_PAGE_SQL=`SELECT job_id AS id,sequence AS rowid FROM memory_recall_view_jobs
  WHERE view_id=? AND generation=? AND sequence<? ORDER BY sequence DESC LIMIT ?`;
export const VIEW_TERM_PAGE_SQL=`SELECT record_id AS id,version,sequence AS rowid FROM memory_recall_view_terms
  WHERE view_id=? AND generation=? AND term=? AND sequence<? ORDER BY sequence DESC LIMIT ?`;
function refs(rows: Array<Record<string,unknown>>): ViewRef[] { return rows.map(row=>({id:String(row.id),version:Number(row.version),rowid:Number(row.rowid)})); }
export function eligibleViewPage(db: DatabaseSync,view: RecallViewHandle,cursor: string,limit: number,budget=new RecallWorkBudget()): ViewRef[] {
  assertRecallView(db,view);
  let id='',version=-1;
  if(cursor!=='') { try { const pair=JSON.parse(cursor);if(!Array.isArray(pair)||typeof pair[0]!=='string'||!Number.isInteger(pair[1]))throw 0;[id,version]=pair; } catch { throw new Error('INVALID_MEMORY_CURSOR'); } }
  const rows=db.prepare(VIEW_RECORD_PAGE_SQL).all(view.viewId,view.generation,id,version,Math.min(limit,budget.remaining));budget.candidates(rows.length);return refs(rows);
}
export function recentViewPage(db: DatabaseSync,view: RecallViewHandle,before: number,limit: number,budget=new RecallWorkBudget()): ViewRef[] {
  assertRecallView(db,view);
  const rows=db.prepare(VIEW_RECENT_PAGE_SQL).all(view.viewId,view.generation,before,Math.min(limit,budget.remaining));budget.candidates(rows.length);return refs(rows);
}
export function pendingViewPage(db: DatabaseSync,view: RecallViewHandle,after: number,limit: number,budget=new RecallWorkBudget()): ViewRef[] {
  assertRecallView(db,view);
  const rows=db.prepare(VIEW_PENDING_PAGE_SQL).all(view.viewId,view.generation,after,Math.min(limit,budget.remaining));budget.candidates(rows.length);return refs(rows);
}
export function catchUpViewPage(db: DatabaseSync,view: RecallViewHandle,before: number,limit: number,budget=new RecallWorkBudget()): Array<{id:string;rowid:number}> {
  assertRecallView(db,view);
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
  assertRecallView(db,view);
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
  assertRecallView(db,view);
  const sql=kinds===null
    ? `SELECT record_id AS id,version FROM memory_recall_view_records INDEXED BY memory_recall_records_pins WHERE view_id=?1 AND generation=?2 AND pinned=1 AND state='active' ORDER BY record_id,version LIMIT ?3`
    : `SELECT record_id AS id,version FROM memory_recall_view_records INDEXED BY memory_recall_records_kind WHERE view_id=?1 AND generation=?2 AND kind IN (SELECT value FROM json_each(?4)) LIMIT ?3`;
  const args=[view.viewId,view.generation,Math.min(limit,budget.remaining),...kinds===null?[]:[JSON.stringify(kinds)]];
  const rows=db.prepare(sql).all(...args);budget.candidates(rows.length);return rows.map(row=>({id:String(row.id),version:Number(row.version)}));
}
