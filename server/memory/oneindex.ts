// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: reader scope set + page readers = q1023-oneindex (designs/ONEINDEX-DESIGN.md "Shape"); the per-hit deny predicate they rest on
// (deny.ts, deny-read.ts) = q1023-denyrule; rulings = MAIN.
// ONEINDEX: the reader's scopes are computed per turn from the committed roster and bindings (recallMembershipSteps, the same walk that
// decided which view to build) and held in memory, never persisted. Each page reader below answers what the matching view page answered
// (recall-view-index.ts), read from memory_records by scope instead of from a per-view copy: nothing is built, so nothing waits on a build,
// and a roster or authority change writes nothing. Every read is a key seek; nothing here writes.
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CURRENT_CHECKPOINT_SQL } from './checkpoint-sql.ts';
import { PIP_ALL_KINDS_SQL } from './pip-kinds.ts';
import { ConstructionBudget } from './recall-construction.ts';
import { recallMembershipSteps } from './recall-membership.ts';
import { pendingWindows, RecallWorkBudget, type ViewRef } from './recall-view-index.ts';
import type { MemoryRoster } from './policy.ts';
import type { RecallViewBinding } from './recall-view.ts';

/** The reader's scope set for one turn. `lineage`: scopes read for lineage only; `personScopes`: scopes a person reader holds as a person. */
export interface RecallScopeSet { readonly scopes: readonly string[]; readonly lineage: readonly string[]; readonly personScopes: ReadonlySet<string>; readonly room: boolean }

/** O(roster) reads, 0 writes (no `ensure`: a scope that does not exist yet holds no record, so it is left out, never created). */
export function computeRecallScopes(db: DatabaseSync, binding: RecallViewBinding, roster: MemoryRoster): RecallScopeSet {
  const steps=recallMembershipSteps(db,binding,roster,new ConstructionBudget());
  for(let step=steps.next();;step=steps.next()) if(step.done) {
    const m=step.value;
    return Object.freeze({scopes:Object.freeze([...new Set(m.scopes)].sort()),lineage:Object.freeze([...new Set(m.lineage)].sort()),personScopes:new Set(m.personScopes),room:m.room});
  }
}
/** computeRecallScopes memoized per (connection, roster object, reader, authority epoch). Every input of the walk (scope rows, the grant,
 * binding, team and project rows, owner settings) moves the trigger-maintained epoch, and a roster change is a new roster object, so a
 * memo entry is exactly as valid as a view built at that epoch was; nothing is written. */
const memo=new WeakMap<DatabaseSync,WeakMap<MemoryRoster,Map<string,{epoch:number;set:RecallScopeSet}>>>();
export function cachedRecallScopes(db: DatabaseSync, binding: RecallViewBinding, roster: MemoryRoster, epoch: number): RecallScopeSet {
  let byRoster=memo.get(db);if(!byRoster)memo.set(db,byRoster=new WeakMap());
  let byKey=byRoster.get(roster);if(!byKey)byRoster.set(roster,byKey=new Map());
  const key=JSON.stringify([binding.botId,binding.threadId,binding.humanPrincipal,binding.notOwnerAudience]),known=byKey.get(key);
  if(known && known.epoch===epoch)return known.set;
  const set=computeRecallScopes(db,binding,roster);
  if(byKey.size>=256)byKey.delete(byKey.keys().next().value!);
  byKey.set(key,{epoch,set});return set;
}
/** recallViewHasScope on the computed set: a full-reach scope, or (lineage) a lineage-only one; personOnly keeps the person's own. */
export function recallScopesHave(set: RecallScopeSet, scope: string, lineage = false, personOnly = false): boolean {
  if(personOnly && !set.personScopes.has(scope))return false;
  return set.scopes.includes(scope) || lineage && set.lineage.includes(scope);
}
/** Every scope of `current` is in `issued` with the same reach and the room flag is equal (recallViewNotWider on the computed sets). */
export function recallScopesNotWider(current: RecallScopeSet, issued: RecallScopeSet): boolean {
  if(current.room!==issued.room)return false;
  return current.scopes.every(scope=>issued.scopes.includes(scope) && issued.personScopes.has(scope)===current.personScopes.has(scope))
    && current.lineage.every(scope=>issued.scopes.includes(scope) || issued.lineage.includes(scope));
}

/** A version the view held: never deleted, never on a deleted source, never a non-head checkpoint (recall-view.ts recordFacts / LIVE_VIEW_ROW). */
const HELD=`r.state<>'deleted' AND ${CURRENT_CHECKPOINT_SQL}
  AND NOT EXISTS (SELECT 1 FROM memory_evidence le JOIN memory_sources ls ON ls.id=le.source_id WHERE le.record_id=r.id AND le.record_version=r.version AND ls.state='deleted')`;
const LIVE_STATES=['active','candidate','superseded','archived'] as const;
/** One RAW row of a (scope, state) list, newest first: a seek into memory_records_scope (scope_id,state,rowid), never a step over another
 * scope's rows. The LIMIT applies to the raw row: HELD is a per-row hit, never a filter before the LIMIT (MAIN-RULING 2026-11-26T22:06Z (a)). */
const NEWEST_RAW_SQL=`SELECT r.rowid AS rowid,r.id AS id,r.version AS version,(${HELD}) AS hit FROM memory_records r INDEXED BY memory_records_scope
  WHERE r.scope_id=?1 AND r.state=?2 AND r.rowid<?3 ORDER BY r.rowid DESC LIMIT 1`;
/** The state of one recent walk, kept between its pages by the caller's `cut` object: each list's next raw row already read (and charged). */
interface RecentList { scope: string; state: string; below: number; top: (ViewRef & {hit:boolean}) | null; done: boolean }
export interface RecentCut { before?: number; walk?: {set: RecallScopeSet; at: number; lists: RecentList[]} }
/** recentViewPage on the computed set: the `limit` newest held versions below `before`, merged from each (scope, state) list.
 * FABLE/OPUS b50b7c3cdc H4/H1 (MAIN :7563 "cap the TOTAL"): a lazy merge, one raw row read per list, and only the list whose top row the
 * walk steps past is read on, so the rows read are at most lists + rows stepped, never lists x n.
 * MAIN-RULING 2026-11-26T22:06Z (a), "short page = cut" as eligibleScopePage: the walk steps the reader's raw rows in rowid order, newest
 * first, and EVERY raw row it reads is charged when it is read, a list's look-ahead row and a refused row (a non-head checkpoint version,
 * a record on a deleted source) as well as the rows of the page, so the rows read never pass the budget. A page the budget ends returns
 * the rows it has and sets `cut.before` to the last rowid it stepped past (or `before` when it stepped none): every held row not on the
 * page lies below `cut.before`. A short page is the end of the set only when `cut.before` stays unset (recent.ts readers, coldTextPage).
 * A caller that passes the SAME `cut` object to the next page (with `before` = the last rowid of this page, or `cut.before`) continues the
 * walk from the rows it already read and paid for, so the lists are looked at once per walk, not once per page; without it the next page
 * reads each list's top again (and a budget below the number of lists cannot step). A row carried between pages was a hit when it was
 * read; like any row of a page already returned it may have changed since, and every reader re-reads a record before it uses it. */
export function recentScopePage(db: DatabaseSync, set: RecallScopeSet, before: number, limit: number, budget = new RecallWorkBudget(), cut?: RecentCut): ViewRef[] {
  const page:ViewRef[]=[],kept=cut?.walk;
  if(cut){delete cut.before;delete cut.walk;}
  if(limit<=0)return page;
  const lists:RecentList[]=kept && kept.set===set && kept.at===before?kept.lists
    :set.scopes.flatMap(scope=>LIVE_STATES.map(state=>({scope,state,below:before,top:null,done:false})));
  const newest=db.prepare(NEWEST_RAW_SQL);
  let floor=before;
  const stop=(ended:boolean)=>{ if(cut){cut.walk={set,at:floor,lists};if(ended)cut.before=floor;} return page; };
  for(;;) {
    let best:RecentList|null=null;
    for(const list of lists) {
      if(list.done)continue;
      if(!list.top) {
        if(budget.remaining<=0)return stop(true);
        const row=newest.get(list.scope,list.state,list.below);
        if(!row){list.done=true;continue;}
        budget.candidates(1);
        list.top={id:String(row.id),version:Number(row.version),rowid:Number(row.rowid),hit:Number(row.hit)===1};
      }
      if(!best || list.top.rowid>best.top!.rowid)best=list;
    }
    if(!best)return page;
    const {hit,...ref}=best.top!;
    floor=ref.rowid;best.below=ref.rowid;best.top=null;
    if(hit){page.push(ref);if(page.length>=limit)return stop(false);}
  }
}
/** One window of RAW rows of one list of the frame walk, newest first. Owner pins: the pinned index (scope_id) WHERE owner_pinned=1 AND
 * state='active'. Kinds: memory_records_scope (scope_id,state,rowid); no (scope_id, kind) index exists, so every live record of the scope
 * is a raw row of this walk. The kind filter and HELD are a per-row hit, never a filter before the LIMIT. */
const FRAME_PIN_RAW_SQL=`SELECT r.rowid AS rowid,r.id AS id,r.version AS version,r.kind AS kind,(${HELD}) AS hit FROM memory_records r INDEXED BY memory_records_pinned
  WHERE r.scope_id=?1 AND r.owner_pinned=1 AND r.state='active' AND r.rowid<?3 ORDER BY r.rowid DESC LIMIT ?4`;
const FRAME_KIND_RAW_SQL=`SELECT r.rowid AS rowid,r.id AS id,r.version AS version,r.kind AS kind,(r.kind IN (SELECT value FROM json_each(?5)) AND ${HELD}) AS hit FROM memory_records r INDEXED BY memory_records_scope
  WHERE r.scope_id=?1 AND r.state=?2 AND r.rowid<?3 ORDER BY r.rowid DESC LIMIT ?4`;
const FRAME_RAW_WINDOW=512;
const binary=(a:string,b:string)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
/** frameViewPage on the computed set: the active owner pins (kinds null) or the versions of these kinds (PIP identity frame: never the index),
 * kinds in (kind, record_id, version) order as the view's memory_recall_records_kind index read them (ASTRA/OPUS 88ff14d103 H2).
 * MAIN-RULING 2026-11-26T22:06Z (a), "short page = cut" as eligibleScopePage: the page is read by a walk of the reader's own lists (scope,
 * then state, then rowid newest first) whose LIMIT applies to RAW rows; every raw row read is charged, refused ones as well, so the rows
 * read never pass the budget. A walk that reaches the end gives exactly the page the one statement gave (the hits, sorted, first `limit`).
 * A walk the budget ends, and every continuation page (`after` set), returns EVERY hit it reached (sorted; never cut to `limit`, so a walk
 * by cursor loses none: they are at most the rows charged, and they are the NEWEST rows of each list it walked) and sets `cut.next` to the last raw row it read: the frame is
 * partial, and a read with `after`=cut.next walks on from there. A page is whole only when `cut.next` stays unset. `within` narrows the walk to those scopes of the set (never wider than the set): a caller that only uses the
 * rows of some scopes pays for those scopes' rows alone (bundle.ts: the identity frame is the bot's own scope). */
export function frameScopePage(db: DatabaseSync, set: RecallScopeSet, kinds: readonly string[] | null, limit: number, budget: RecallWorkBudget, cut?: {next?:string}, after = '', within?: readonly string[]): Array<{id:string;version:number}> {
  if(limit<=0)return [];
  const states:readonly string[]=kinds===null?['active']:LIVE_STATES;
  const lists=(within?set.scopes.filter(scope=>within.includes(scope)):set.scopes).flatMap(scope=>states.map(state=>({scope,state})));
  let at=-1,below=Number.MAX_SAFE_INTEGER;
  if(after!=='') {
    // the cursor names a list of THIS walk by position; one that names no list of it is refused, never guessed at
    try { const pair=JSON.parse(after);if(!Array.isArray(pair)||!Number.isInteger(pair[2]))throw 0;at=lists.findIndex(list=>list.scope===pair[0] && list.state===pair[1]);if(at<0)throw 0;below=pair[2]; }
    catch { throw new Error('INVALID_MEMORY_CURSOR'); }
  }
  if(budget.remaining<=0){if(cut)cut.next=after;return [];}
  const raw=db.prepare(kinds===null?FRAME_PIN_RAW_SQL:FRAME_KIND_RAW_SQL), wanted=kinds===null?[]:[JSON.stringify(kinds)];
  const hits:Array<{id:string;version:number;kind:string}>=[];
  let last=after,ended=false;
  walk: for(let i=Math.max(at,0);i<lists.length;i++) {
    const {scope,state}=lists[i];
    for(let rowid=i===at?below:Number.MAX_SAFE_INTEGER;;) {
      const room=Math.min(budget.remaining,FRAME_RAW_WINDOW);
      if(room<=0){ended=true;break walk;}
      const rows=raw.all(scope,state,rowid,room,...wanted);
      budget.candidates(rows.length);
      for(const row of rows)if(Number(row.hit)===1)hits.push({id:String(row.id),version:Number(row.version),kind:String(row.kind)});
      if(rows.length){rowid=Number(rows.at(-1)!.rowid);last=JSON.stringify([scope,state,rowid]);}
      if(rows.length<room)break;
    }
  }
  if(cut && ended)cut.next=last;
  hits.sort((a,b)=>(kinds===null?0:binary(a.kind,b.kind)) || binary(a.id,b.id) || a.version-b.version);
  return (ended || after!==''?hits:hits.slice(0,limit)).map(({id,version})=>({id,version}));
}
function decodeKeyCursor(cursor: string): [string,number] {
  if(cursor==='')return ['',-1];
  try { const pair=JSON.parse(cursor);if(!Array.isArray(pair)||typeof pair[0]!=='string'||!Number.isInteger(pair[1]))throw 0;return [pair[0],pair[1]]; }
  catch { throw new Error('INVALID_MEMORY_CURSOR'); }
}
/** eligibleViewPage on the computed set: held versions in key order after the cursor (search.ts walks them to the first readable).
 * ASTRA 6820c76ca4 High 2, eligible half; MAIN-RULING 2026-11-26T21:32Z "short page = cut": the walk is a keyed range read of the primary key
 * whose LIMIT applies to RAW rows (scope membership and HELD are a per-row hit, never a filter before the LIMIT), rows are stepped one at a
 * time and every row stepped is charged, so the rows read never pass the budget. The (id, version) order is unchanged (eligibility.ts
 * encodeEligibleCursor). A page that stops at the budget returns the rows it has and sets `cut.next` to the last key it EXAMINED: a short
 * page is the end of the set only when `cut.next` stays unset and the budget is not spent (search.ts readableAfter, eligibility.ts read). */
const ELIGIBLE_RAW_SQL=`SELECT r.id AS id,r.version AS version,r.rowid AS rowid,(r.scope_id IN (SELECT value FROM json_each(?1)) AND ${HELD}) AS hit
  FROM memory_records r WHERE (r.id,r.version)>(?2,?3) ORDER BY r.id,r.version LIMIT ?4`;
export function eligibleScopePage(db: DatabaseSync, set: RecallScopeSet, cursor: string, limit: number, budget = new RecallWorkBudget(), cut?: {next?:string}): ViewRef[] {
  const [id,version]=decodeKeyCursor(cursor),raw=budget.remaining,page:ViewRef[]=[];
  if(limit<=0)return page;
  if(raw<=0){if(cut)cut.next=cursor;return page;}
  let examined=0,last='';
  for(const row of db.prepare(ELIGIBLE_RAW_SQL).iterate(JSON.stringify(set.scopes),id,version,raw)) {
    examined++;
    if(Number(row.hit)===1)page.push({id:String(row.id),version:Number(row.version),rowid:Number(row.rowid)});
    if(page.length>=limit)break;
    if(examined>=raw)last=JSON.stringify([String(row.id),Number(row.version)]);
  }
  budget.candidates(examined);
  if(cut && last!=='')cut.next=last;
  return page;
}
/** pendingViewPage on the computed set: receipts still owed, in key order; PIP kinds only while their removal is owed (as the view did).
 * ASTRA 6820c76ca4 High 2: the same bounded walk as the view's pendingViewPage (recall-view-index.ts pendingWindows): each status is a keyed
 * range read of memory_projection_pending whose LIMIT applies to RAW receipts, every raw receipt read is charged, and membership (scope set,
 * HELD, the PIP rule) is a per-row hit, never a filter before the LIMIT. */
// the statuses of recall-view-index.ts VIEW_PENDING_STATUSES, local: that module imports this one, so its consts are not set yet at load
const SCOPE_PENDING_SQL=(['pending','pending-archive','delete-pending'] as const).map(status=>`SELECT p.record_id AS id,p.record_version AS version,p.rowid AS rowid,
  EXISTS(SELECT 1 FROM memory_records r WHERE r.id=p.record_id AND r.version=p.record_version AND r.scope_id IN (SELECT value FROM json_each(?1))
    ${status==='delete-pending'?'':`AND r.kind NOT IN ${PIP_ALL_KINDS_SQL}`} AND ${HELD}) AS hit
  FROM memory_projection_receipts p INDEXED BY memory_projection_pending
  WHERE p.lexical_status='${status}' AND (p.record_id,p.record_version)>(?2,?3) ORDER BY p.record_id,p.record_version LIMIT ?4`);
export function pendingScopePage(db: DatabaseSync, set: RecallScopeSet, cursor: string, limit: number, budget = new RecallWorkBudget()): ViewRef[] {
  const [id,version]=decodeKeyCursor(cursor),scopes=JSON.stringify(set.scopes);
  return pendingWindows(SCOPE_PENDING_SQL.map(sql=>{ const stmt=db.prepare(sql);return (from:{id:string;version:number},n:number)=>stmt.all(scopes,from.id,from.version,n); }),{id,version},limit,budget);
}

// ---- Scope-set handles (STEP 2 cut-over). An access is issued from the computed set, never from a built view: its `view` is a handle whose
// id names the set (a digest of scopes, lineage, person scopes and room) and whose generation is the authority epoch it was computed at. The
// set itself lives here, in memory, for as long as a reader may hold the handle (bounded; an evicted handle refuses, it never reads wider).
// Every view reader (recall-view.ts, recall-view-index.ts) asks scopeSetOf first and answers from memory_records by scope for these.
const SCOPE_SET_PREFIX='scopes:', SCOPE_SET_HANDLES_MAX=4096;
const scopeSets=new Map<string,{set:RecallScopeSet;epoch:number}>();
export interface ScopeSetHandle { readonly viewId: string; readonly generation: string; readonly digest: string }
export function scopeSetHandle(set: RecallScopeSet, epoch: number): ScopeSetHandle {
  const digest=createHash('sha256').update(JSON.stringify([set.scopes,set.lineage,[...set.personScopes].sort(),set.room])).digest('hex');
  const viewId=SCOPE_SET_PREFIX+digest, generation=String(epoch), key=`${viewId}@${generation}`;
  scopeSets.delete(key);scopeSets.set(key,{set,epoch});
  if(scopeSets.size>SCOPE_SET_HANDLES_MAX)scopeSets.delete(scopeSets.keys().next().value!);
  return Object.freeze({viewId,generation,digest});
}
export interface ScopeSetWire { scopes: string[]; lineage: string[]; personScopes: string[]; room: boolean; epoch: number }
export function scopeSetWire(view: {viewId:string;generation:string}): ScopeSetWire | undefined {
  const held=isScopeSetHandle(view)?scopeSetOf(view):null;
  return held?{scopes:[...held.set.scopes],lineage:[...held.set.lineage],personScopes:[...held.set.personScopes],room:held.set.room,epoch:held.epoch}:undefined;
}
/** The helper thread adopts the set it was sent only when it hashes to the handle's own digest at the handle's epoch: never another set. */
export function adoptScopeSet(view: {viewId:string;generation:string;digest:string}, wire: ScopeSetWire): void {
  const set:RecallScopeSet=Object.freeze({scopes:Object.freeze([...wire.scopes]),lineage:Object.freeze([...wire.lineage]),personScopes:new Set(wire.personScopes),room:wire.room});
  const adopted=scopeSetHandle(set,wire.epoch);
  if(adopted.viewId!==view.viewId || adopted.generation!==view.generation || adopted.digest!==view.digest)throw new Error('MEMORY_CONTEXT_REVOKED');
}
export function isScopeSetHandle(view: {viewId:string}): boolean { return view.viewId.startsWith(SCOPE_SET_PREFIX); }
/** The set behind a scope-set handle; RecallPreparationPending-free: an unknown (evicted) scope-set handle throws MEMORY_CONTEXT_REVOKED. */
export function scopeSetOf(view: {viewId:string;generation:string}): {set:RecallScopeSet;epoch:number} | null {
  if(!isScopeSetHandle(view))return null;
  const held=scopeSets.get(`${view.viewId}@${view.generation}`);
  if(!held)throw new Error('MEMORY_CONTEXT_REVOKED');
  return held;
}

// ---- H4: recall never depends on memory-index.db being ready. When the shared index cannot answer (missing, unreadable, blocked, or its
// postings for these scopes still owed), the words are matched against the reader's own records' text, newest first, bounded by the
// request's budget (rows and bytes), so a cold index gives a bounded, honest (bounded=true) page, never an empty recall and never the banner.
export const COLD_TEXT_ROWS=2048;
export function coldTextPage(db: DatabaseSync, set: RecallScopeSet, query: string, limit: number, offset: number, budget: RecallWorkBudget, terms: (text: string) => string[]) {
  const tokens=[...new Set(terms(query))].slice(0,8);
  if(!tokens.length)return {hits:[] as Array<{id:string;version:number;score:number;lexical:true}>,more:false,bounded:false,partial:false};
  const cut:RecentCut={},rows=recentScopePage(db,set,Number.MAX_SAFE_INTEGER,Math.min(COLD_TEXT_ROWS,budget.remaining),budget,cut);
  const text=db.prepare('SELECT text FROM memory_records WHERE id=? AND version=?'),hits:Array<{id:string;version:number;score:number;lexical:true}>=[];
  // a page the raw budget ended (cut) is not the whole of the reader's records: the answer is partial
  let bounded=rows.length>=COLD_TEXT_ROWS || cut.before!==undefined;
  for(const row of rows) {
    const value=text.get(row.id,row.version)?.text;if(typeof value!=='string')continue;
    if(!budget.text(Buffer.byteLength(value))){bounded=true;break;}
    const words=new Set(terms(value));let score=0;for(const token of tokens)if(words.has(token))score++;
    if(score>0)hits.push({id:row.id,version:row.version,score,lexical:true});
  }
  hits.sort((a,b)=>b.score-a.score || a.id.localeCompare(b.id) || a.version-b.version);
  return {hits:hits.slice(offset,offset+limit),more:hits.length>offset+limit,bounded:true,partial:bounded};
}
