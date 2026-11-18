import { collectSessionChecksSlice } from './session-proof-schema.ts';
import { seedSessionChecksSlice } from './session-proof.ts';
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: store-patchbot (roster revision); consumer owner: recall-scope (views, admission, indexes and lineage).
// Scheduling recovery repair owner: c4-misc-a2; authority/view owner: recall-scope.
import { RecallPreparationPending } from './recall-recovery.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { database, databaseGeneration, onDatabaseClose, transaction } from '../database.ts';
import { BACKGROUND_BUSY_MS } from '../db-busy.ts';
import { assertHumanPrincipal, threadHumanPrincipal, type HumanPrincipal } from '../human-principals.ts';
import { ensureScope, recallRosterMatchesPolicySteps, prepareLegacyRecallRosterSteps, type MemoryAccess, type MemoryRoster } from './policy.ts';
import { recallMembershipSteps } from './recall-membership.ts';
import { ConstructionBudget, constructionJson } from './recall-construction.ts';
import { wordTerms } from './postings.ts';
import { sharePreparedAudience } from './audience-cache.ts';
import { isPipKind } from './pip-kinds.ts';
import type { RecallRosterCertificate } from '../store.ts';
import { teamChangeOpen } from '../team-identities.ts';
import { scopeRow } from './scope-id.ts';
import { checkpointFamily } from './checkpoints.ts';
import { recallChangeRangeMembers } from './recall-view-schema.ts';

export interface RecallViewHandle { readonly viewId: string; readonly generation: string; readonly digest: string }
export interface RecallViewBinding { readonly botId: string; readonly threadId: string; readonly humanPrincipal: HumanPrincipal; readonly notOwnerAudience: boolean }
interface Held { handle: RecallViewHandle; scopes: readonly string[]; room: boolean; epoch: number; revision: number; mark: number }
/** Freshness, apart from validity (the epoch). Producer owner: scope-insert.ts insertScope (a new scope row that keeps the epoch); consumer
 * owner: recall-scope. A view built before the newest scope row existed is still valid for every scope it cites, but it is not the current
 * answer for a new reader: it is rebuilt before it is issued again. A scope delete moves the epoch, so a reused row id cannot hide a change. */
function scopeMark(db: DatabaseSync): number { return Number(db.prepare('SELECT max(rowid) AS n FROM memory_scopes').get()?.n ?? 0); }
const held = new WeakMap<DatabaseSync, WeakMap<MemoryRoster, Map<string,Held>>>();
const storagePressure=new WeakMap<DatabaseSync,boolean>();
interface Reader {view:RecallViewHandle;viewId:string;contextKey:string;active:()=>boolean;binding:RecallViewBinding;roster?:()=>MemoryRoster;issued:boolean}
// One registry per process, not per connection: a reader's lease belongs to its turn, and a turn outlives a reopen of the database file.
// A reader whose issued view is not in the open file (another file at this path) is dropped where views are recomputed.
const activeReaders=new Set<Reader>();
let preparingReaders=false,deferredReaders=0;
/** MAIN ruling 1117 06:28Z Q3: one recompute serves at most this many live contexts and issued views; the rest stay pending, which refuses. */
export const RECALL_LIVE_READERS_MAX=128;
// MAIN ruling 1117 06:28Z Q5: issued view -> the current view of the same context, kept ONLY while that view is not wider than the issued
// one and than the entry it replaces. In-flight reads go through it (a deny applies at once); a widening, also one back towards the issued
// view after a narrowing, never gets an entry, so it never reaches an in-flight access (the stale issued view refuses).
const narrowed=new Map<string,RecallViewHandle>();
const viewKey=(view:RecallViewHandle)=>`${view.viewId}\0${view.generation}\0${view.digest}`;
// Persisted candidates predate this process's builds; new views keep FIFO order.
const viewOrder=new WeakMap<DatabaseSync,Map<string,number>>();
let viewSequence=0;
const activeBuilds=new WeakMap<DatabaseSync,Set<string>>();
const latestBuilds=new WeakMap<DatabaseSync,Map<string,string>>();
// Timer upkeep must not change a persisted snapshot while hydration compares it.
// Counts also cover independent background preparations of the same candidate.
const hydratingViews=new WeakMap<DatabaseSync,Map<string,number>>();
function activeBuild(build:Build,active:boolean) {let set=activeBuilds.get(build.db);if(!set)activeBuilds.set(build.db,set=new Set());if(active)set.add(build.handle.viewId);else {set.delete(build.handle.viewId);build.budget.release();}}
const acknowledged=new WeakMap<MemoryRoster,{epoch:number;revision:number}>();
const poisoned = new WeakMap<readonly string[],readonly string[]>();
const counters = { oracleComputes: 0, scopeCopies: 0, membershipProbes: 0, candidateVisits: 0, textBytes: 0, readerVisits: 0 };
export function recallViewCounters(): Readonly<typeof counters> { return {...counters}; }
export function noteViewCandidates(n: number): void { counters.candidateVisits += n; }
export function noteViewText(n: number): void { counters.textBytes += n; }
export function poisonRecallScopeArraysForTest(access: MemoryAccess, poison: readonly string[]): void { poisoned.set(access.scopeIds,poison); }
function scopeSnapshot(scopes: string[]): readonly string[] {
  const proxy = new Proxy(Object.freeze(scopes), { get(target,key,receiver) {
    const poison=poisoned.get(proxy); if (poison) return Reflect.get(poison,key);
    return Reflect.get(target,key,receiver);
  } });
  return proxy;
}
function cache(db: DatabaseSync, roster: MemoryRoster) { let byRoster=held.get(db); if(!byRoster)held.set(db,byRoster=new WeakMap()); let value=byRoster.get(roster);if(!value)byRoster.set(roster,value=new Map());return value; }
export function recallContextKey(binding: RecallViewBinding): string {
  return JSON.stringify([binding.botId,binding.threadId,binding.humanPrincipal,binding.notOwnerAudience]);
}
export function recallAuthorityEpoch(db: DatabaseSync): number {
  const row=db.prepare('SELECT epoch FROM memory_recall_epoch WHERE id=1').get();
  if (!row || !Number.isSafeInteger(row.epoch)) throw new RecallPreparationPending();
  return Number(row.epoch);
}
export function assertRecallView(db: DatabaseSync, view: RecallViewHandle, binding?: RecallViewBinding): void {
  // Read every live fence in one SQLite snapshot, including foreign commits; no authority answer is memoized.
  const row=db.prepare(`SELECT v.authority_epoch,v.state,v.digest,v.scope_count,v.watermark,
    (SELECT projection_floor FROM memory_recall_epoch WHERE id=1) AS projection_floor,
    (SELECT epoch FROM memory_recall_epoch WHERE id=1) AS epoch,
    EXISTS(SELECT 1 FROM memory_recall_contexts WHERE view_id=v.view_id AND generation=v.generation) AS context,
    EXISTS(SELECT 1 FROM memory_scope_bindings WHERE id='memory-roster-policy' AND state='granted') AS granted,
    (?3 IS NULL OR EXISTS(SELECT 1 FROM memory_recall_contexts WHERE context_key=?3 AND view_id=v.view_id AND generation=v.generation)) AS bound
    FROM memory_recall_views v WHERE v.view_id=?1 AND v.generation=?2`).get(view.viewId,view.generation,binding?recallContextKey(binding):null);
  if (!row || Number(row.watermark)<Number(row.projection_floor??Infinity) || !row.context || row.state!=='ready' || row.digest!==view.digest || Number(row.scope_count)<=0 || !Number.isSafeInteger(row.epoch) || Number(row.authority_epoch)!==Number(row.epoch) || !row.granted) throw new RecallPreparationPending();
  if (binding && !row.bound) throw new RecallPreparationPending();
}
/** A handle is metadata, never a tool capability. The caller must validate its private claim first. */
export function resolveRecallView(binding: RecallViewBinding, roster: MemoryRoster, issued = false): Held {
  const db=database(), key=recallContextKey(binding), known=cache(db,roster).get(key);
  // Only a structurally revisioned roster can prove that an immutable view still describes its current audience.
  if (roster.memoryRosterRevision===undefined || !known || known.revision!==roster.memoryRosterRevision && (acknowledged.get(roster)?.revision!==roster.memoryRosterRevision || acknowledged.get(roster)?.epoch!==known.epoch)) {
    queueRecallContext(binding,roster); throw new RecallPreparationPending();
  }
  try { assertRecallView(db,known.handle,binding); }
  catch { queueRecallContext(binding,roster); throw new RecallPreparationPending(); }
  // `issued`: the caller already holds an access issued from a view and only checks it against this one. A scope row created since is in
  // neither, so the reader goes on while the rebuild is queued; a new issuance waits for the rebuilt view.
  if (known.mark!==scopeMark(db)) { queueRecallContext(binding,roster); if (!issued) throw new RecallPreparationPending(); }
  return known;
}
/** Reader lease owner: askcards-flake-b; release owner: the issuing capability's turn teardown. */
export function retainRecallView(view:RecallViewHandle,binding:RecallViewBinding,active:()=>boolean,roster?:()=>MemoryRoster,issued=false):()=>void {
  const db=database();assertIssuedRecallView(db,view);
  const readers=activeReaders;
  const reader:Reader={view,viewId:view.viewId,contextKey:recallContextKey(binding),active,binding,roster,issued};
  readers.add(reader);
  // DESIGN-B5-PROOF F3: the registry itself holds at most RECALL_LIVE_READERS_MAX entries, issued or not, so a recompute never inspects
  // more, whatever the history. The oldest entry goes (normally a lease on an earlier generation); it gets no recompute, so after the
  // next epoch move its view is stale and refuses: an evicted reader never reads wider.
  if(readers.size>RECALL_LIVE_READERS_MAX)readers.delete(readers.values().next().value!);
  return ()=>{readers.delete(reader);};
}
function hasActiveReader(_db:DatabaseSync,viewId:string,contextKey?:string):boolean {
  for(const reader of activeReaders)if((reader.viewId===viewId || reader.contextKey===contextKey) && reader.active())return true;
  return false;
}
export function recallViewHasScope(db: DatabaseSync, view: RecallViewHandle, scope: string, lineage = false, personOnly = false): boolean {
  // Q5: a scope the narrower current view lost is gone from the issued view's answer too.
  const next=narrowed.get(viewKey(view));
  if(next && !viewHasScope(db,next,scope,lineage,personOnly))return false;
  return viewHasScope(db,view,scope,lineage,personOnly);
}
/** Every scope row of `current` is a row of `issued` with the same reach (full or lineage-only, person or not), and the room flag is equal. */
function recallViewNotWider(db: DatabaseSync, current: RecallViewHandle, issued: RecallViewHandle): boolean {
  if(current.viewId===issued.viewId && current.generation===issued.generation)return true;
  const room=(view:RecallViewHandle)=>db.prepare('SELECT room_reader FROM memory_recall_views WHERE view_id=? AND generation=?').get(view.viewId,view.generation)?.room_reader;
  const a=room(current),b=room(issued);
  if(a===undefined || b===undefined || Number(a)!==Number(b))return false;
  return !db.prepare(`SELECT 1 FROM memory_recall_view_scopes c WHERE c.view_id=?1 AND c.generation=?2 AND NOT EXISTS(
    SELECT 1 FROM memory_recall_view_scopes i WHERE i.view_id=?3 AND i.generation=?4 AND i.scope_id=c.scope_id AND i.lineage_only<=c.lineage_only AND i.person_scope=c.person_scope) LIMIT 1`)
    .get(current.viewId,current.generation,issued.viewId,issued.generation);
}
/** The view an in-flight read is served from: the issued one while it is current, otherwise its not-wider current view, otherwise refused. */
export function readableRecallView(db: DatabaseSync, view: RecallViewHandle): RecallViewHandle {
  try{assertRecallView(db,view);return view;}
  catch(error){
    const next=narrowed.get(viewKey(view));
    if(!next)throw error;
    assertRecallView(db,next);return next;
  }
}
function viewHasScope(db: DatabaseSync, view: RecallViewHandle, scope: string, lineage: boolean, personOnly: boolean): boolean {
  counters.membershipProbes++;
  return !!db.prepare(`SELECT 1 FROM memory_recall_view_scopes WHERE view_id=? AND generation=? AND scope_id=? ${lineage?'':'AND lineage_only=0'} ${personOnly?'AND person_scope=1':''}`)
    .get(view.viewId,view.generation,scope);
}
export function recallViewRoom(access: MemoryAccess): boolean {
  const row=database().prepare('SELECT room_reader FROM memory_recall_views WHERE view_id=? AND generation=?').get(access.view.viewId,access.view.generation);
  return !row || !!Number(row.room_reader);
}
interface Build {
  db: DatabaseSync; databaseGeneration: number; binding: RecallViewBinding; roster: MemoryRoster; key: string; handle: RecallViewHandle;
  epoch: number; revision: number; mark: number; scopes: string[]; lineage: string[]; personScopes: ReadonlySet<string>; room: boolean;
  scopeAt: number; lineageAt: number; recordAfter: number; jobAfter: number; watermark: number;
  oracle: Generator<void>;budget:ConstructionBudget;
  verifyAfter:string;verified:number;prior:{view_id:string;generation:string}|undefined;containsAfter:string;containsPrior:boolean;
  phase: 'oracle'|'scopes'|'records'|'jobs'|'changes'|'verify'|'contains'|'done';
}
/** Construction oracle: used only at a structural boundary, never by admission/assert/search. */
function startBuild(binding: RecallViewBinding,roster: MemoryRoster,waiting=true): Build {
  const db=database(); assertHumanPrincipal(binding.humanPrincipal);
  if (roster.memoryRosterRevision===undefined) throw new RecallPreparationPending();
  const started=transaction(()=>{
    const viewCount=()=>Number(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n);
    if(viewCount()>=128) {
      storagePressure.set(db,waiting || storagePressure.get(db)===true);
      // A waiting build reclaims in place, at most one bounded tick's batch: orphans first, then one idle context's slot. The cap stays 128.
      if(waiting)for(let slice=0;slice<RECLAIM_SLICES_PER_TICK&&viewCount()>=128&&!collectRecallViewSlice(db);slice++){/* bounded reclamation batch */}
      // Still full: refuse after this transaction commits, so the eviction and the rows already freed survive for the next build or tick.
      if(viewCount()>=128)return undefined;
    }
    const handle={viewId:randomUUID(),generation:randomUUID(),digest:''};
    const epoch=recallAuthorityEpoch(db),revision=roster.memoryRosterRevision!,mark=scopeMark(db);
    db.prepare("INSERT INTO memory_recall_views(view_id,generation,authority_epoch,roster_revision,state,scope_count,digest,room_reader) VALUES(?,?,?,?,'building',0,'',0)")
      .run(handle.viewId,handle.generation,epoch,revision);
    let order=viewOrder.get(db);if(!order)viewOrder.set(db,order=new Map());
    order.set(handle.viewId,++viewSequence);
    const build:Build={db,databaseGeneration:databaseGeneration(),binding,roster,key:recallContextKey(binding),handle,epoch,revision,mark,
      verifyAfter:'',verified:0,prior:db.prepare('SELECT view_id,generation FROM memory_recall_contexts WHERE context_key=?').get(recallContextKey(binding)) as Build['prior'],containsAfter:'',containsPrior:true,
      scopes:[],lineage:[],personScopes:new Set(),room:false,scopeAt:0,lineageAt:0,recordAfter:0,jobAfter:0,
      watermark:Number(db.prepare('SELECT coalesce(max(sequence),0) AS n FROM memory_recall_changes').get()!.n),phase:'oracle',oracle:undefined!,budget:new ConstructionBudget(true)};
    build.oracle=constructMembership(build);
    let latest=latestBuilds.get(db);if(!latest)latestBuilds.set(db,latest=new Map());
    if(latest.size>=128&&!latest.has(build.key))latest.delete(latest.keys().next().value!);
    latest.set(build.key,handle.viewId);return build;
  }, { busyMs: BACKGROUND_BUSY_MS, op: 'recall-view' });
  if(!started)throw new Error('MEMORY_RECALL_STORAGE_LIMIT');
  return started;
}
function* constructMembership(build:Build): Generator<void> {
  counters.oracleComputes++;
  const budget=build.budget;
  const advance=(write:()=>void)=>{
    fence(build);write();build.epoch=recallAuthorityEpoch(build.db);
    build.db.prepare('UPDATE memory_recall_views SET authority_epoch=? WHERE view_id=? AND generation=?').run(build.epoch,build.handle.viewId,build.handle.generation);
  };
  yield* prepareLegacyRecallRosterSteps(build.roster,budget,advance);
  if(!(yield* recallRosterMatchesPolicySteps(build.roster,budget)))throw new RecallPreparationPending();
  const result=yield* recallMembershipSteps(build.db,build.binding,build.roster,budget,(kind,key)=>{
    fence(build);
    const id=ensureScope(kind,key);
    // Only this exact, transactional scope ensure may advance the construction fence.
    build.epoch=recallAuthorityEpoch(build.db);
    build.db.prepare('UPDATE memory_recall_views SET authority_epoch=? WHERE view_id=? AND generation=?').run(build.epoch,build.handle.viewId,build.handle.generation);
    return id;
  });
  if(result.scopes.length+result.lineage.length>200_000)throw new Error('MEMORY_RECALL_STORAGE_LIMIT');
  build.db.prepare('INSERT INTO memory_recall_thread_readers VALUES(?,?,?)').run(build.handle.viewId,build.handle.generation,result.threadRecall?1:0);
  build.scopes=result.scopes;build.lineage=result.lineage;build.personScopes=result.personScopes;build.room=result.room;
  const hash=createHash('sha256');for(const bytes of constructionJson([build.scopes,build.lineage,build.room])){hash.update(bytes);yield;}
  build.handle=Object.freeze({...build.handle,digest:hash.digest('hex')});
  build.db.prepare("UPDATE memory_recall_views SET scope_count=?,digest=?,room_reader=? WHERE view_id=? AND generation=? AND state='building'")
    .run(build.scopes.length,build.handle.digest,build.room?1:0,build.handle.viewId,build.handle.generation);
}

function fence(build: Build): void {
  if (latestBuilds.get(build.db)?.get(build.key)!==build.handle.viewId || databaseGeneration()!==build.databaseGeneration || build.roster.memoryRosterRevision!==build.revision || build.watermark<Number(build.db.prepare('SELECT projection_floor FROM memory_recall_epoch WHERE id=1').get()!.projection_floor) || recallAuthorityEpoch(build.db)!==build.epoch) throw new Error('MEMORY_CONTEXT_REVOKED');
}
function projectRecord(db: DatabaseSync,view: RecallViewHandle,id: string,version: number): void {
  const args=[view.viewId,view.generation,id,version] as const;
  const row=db.prepare(`SELECT rowid AS seq,scope_id,text,kind,owner_pinned,state FROM memory_records WHERE id=? AND version=?`).get(id,version);
  db.prepare('DELETE FROM memory_recall_view_terms WHERE view_id=? AND generation=? AND record_id=? AND version=?').run(...args);
  db.prepare('DELETE FROM memory_recall_view_records WHERE view_id=? AND generation=? AND record_id=? AND version=?').run(...args);
  db.prepare('DELETE FROM memory_recall_view_pending WHERE view_id=? AND generation=? AND record_id=? AND version=?').run(...args);
  if (!row || !recallViewHasScope(db,view,String(row.scope_id))) return;
  // Selection metadata affects discovery only; exact citations still hydrate
  // their original authoritative row through the ordinary read gates.
  const head=row.kind==='checkpoint'?checkpointFamily(db,id):undefined;
  if(head && (head.state!=='active'||head.record_id!==id||head.record_version!==version))return;
  db.prepare('INSERT INTO memory_recall_view_records VALUES(?,?,?,?,?,?,?,?,?)').run(...args,row.seq,row.kind,row.owner_pinned,row.state,row.scope_id);
  const add=db.prepare('INSERT INTO memory_recall_view_terms VALUES(?,?,?,?,?,?)');
  // Authoritative text stays shared. Terms are derived metadata, and are never exposed without readRecord's gates.
  const rolled=row.kind==='checkpoint' && row.state!=='active' && !!db.prepare('SELECT 1 FROM memory_records WHERE id=? AND version>? LIMIT 1').get(id,version);
  if(!isPipKind(String(row.kind)) && !rolled)for (const term of wordTerms(String(row.text))) add.run(view.viewId,view.generation,term,row.seq,id,version);
  const receipt=db.prepare('SELECT rowid AS seq,lexical_status FROM memory_projection_receipts WHERE record_id=? AND record_version=?').get(id,version);
  if (receipt && (!isPipKind(String(row.kind)) || receipt.lexical_status==='delete-pending') && ['pending','pending-archive','delete-pending'].includes(String(receipt.lexical_status)))
    db.prepare('INSERT INTO memory_recall_view_pending VALUES(?,?,?,?,?)').run(view.viewId,view.generation,receipt.seq,id,version);
}
function projectJob(db: DatabaseSync,view: RecallViewHandle,id: string): void {
  // The job ID index keeps replacements bounded; sequence is the original job rowid.
  const row=db.prepare('SELECT j.rowid AS seq,s.scope_id FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE j.id=?').get(id);
  db.prepare('DELETE FROM memory_recall_view_jobs WHERE view_id=? AND generation=? AND job_id=?').run(view.viewId,view.generation,id);
  if (row && recallViewHasScope(db,view,String(row.scope_id))) db.prepare('INSERT INTO memory_recall_view_jobs VALUES(?,?,?,?)').run(view.viewId,view.generation,row.seq,id);
}
export const RECALL_BUILD_SLICE=256;
/** One change page after `after`: rows in sequence order until the records they name would pass RECALL_BUILD_SLICE (the first row is always
 * taken; a 'receipts' range row names at most RECALL_CHANGE_SET). The watermark moves only past rows fully projected (FIX3-DESIGN). */
function projectChangePage(db: DatabaseSync,view: RecallViewHandle,after: number): { watermark: number; done: boolean } {
  const rows=db.prepare('SELECT sequence,kind,object_id,version FROM memory_recall_changes WHERE sequence>? ORDER BY sequence LIMIT ?').all(after,RECALL_BUILD_SLICE);
  let watermark=after,spent=0,taken=0;
  for(const row of rows){
    const members=row.kind==='receipts'?recallChangeRangeMembers(db,String(row.object_id)):undefined;
    const cost=members?members.length:1;
    if(taken && spent+cost>RECALL_BUILD_SLICE)break;
    if(members)for(const [id,version] of members)projectRecord(db,view,id,version);
    else if(row.kind==='record')projectRecord(db,view,String(row.object_id),Number(row.version));
    else projectJob(db,view,String(row.object_id));
    spent+=cost;taken++;watermark=Number(row.sequence);
  }
  return { watermark, done: taken===rows.length && rows.length<RECALL_BUILD_SLICE };
}
/** One bounded projection/membership slice. This is maintenance, never a recall fallback. */
export function buildRecallViewSlice(build: Build): boolean {
  fence(build);
  return transaction(()=>{
    fence(build);
    const {db,handle}=build;
    if(build.phase==='oracle') {
      for(let n=0;n<RECALL_BUILD_SLICE;n++)if(build.oracle.next().done){build.phase='scopes';break;}
    } else if (build.phase==='scopes') {
      const add=db.prepare('INSERT INTO memory_recall_view_scopes VALUES(?,?,?,?,?)'); let left=RECALL_BUILD_SLICE;
      while(left>0 && build.scopeAt<build.scopes.length){const scope=build.scopes[build.scopeAt++];add.run(handle.viewId,handle.generation,scope,0,build.personScopes.has(scope)?1:0);left--;}
      while(left>0 && build.lineageAt<build.lineage.length){add.run(handle.viewId,handle.generation,build.lineage[build.lineageAt++],1,1);left--;}
      if(build.scopeAt===build.scopes.length && build.lineageAt===build.lineage.length)build.phase='records';
    } else if (build.phase==='records') {
      const rows=db.prepare(`SELECT r.rowid AS seq,r.id,r.version FROM memory_recall_view_scopes v JOIN memory_records r INDEXED BY memory_records_scope ON r.scope_id=v.scope_id WHERE v.view_id=? AND v.generation=? AND v.lineage_only=0 AND r.rowid>? ORDER BY r.rowid LIMIT ?`).all(handle.viewId,handle.generation,build.recordAfter,RECALL_BUILD_SLICE);
      for(const row of rows){projectRecord(db,handle,String(row.id),Number(row.version));build.recordAfter=Number(row.seq);}
      if(rows.length<RECALL_BUILD_SLICE)build.phase='jobs';
    } else if (build.phase==='jobs') {
      const rows=db.prepare('SELECT rowid AS seq,id FROM memory_jobs WHERE rowid>? ORDER BY rowid LIMIT ?').all(build.jobAfter,RECALL_BUILD_SLICE);
      for(const row of rows){projectJob(db,handle,String(row.id));build.jobAfter=Number(row.seq);}
      if(rows.length<RECALL_BUILD_SLICE)build.phase='changes';
    } else if (build.phase==='changes') {
      const page=projectChangePage(db,handle,build.watermark);
      build.watermark=page.watermark;
      if(page.done)build.phase='verify';
    } else if(build.phase==='verify') {
      const rows=db.prepare('SELECT scope_id,lineage_only,person_scope FROM memory_recall_view_scopes WHERE view_id=? AND generation=? AND scope_id>? ORDER BY scope_id LIMIT ?').all(handle.viewId,handle.generation,build.verifyAfter,RECALL_BUILD_SLICE);
      const has=(values:string[],scope:string)=>{let a=0,b=values.length;while(a<b){const mid=(a+b)>>>1;if(values[mid]<scope)a=mid+1;else b=mid;}return values[a]===scope;};
      for(const row of rows){const scope=String(row.scope_id);if(!(Number(row.lineage_only)?has(build.lineage,scope):has(build.scopes,scope)) || Number(row.person_scope)!==(build.personScopes.has(scope)?1:0))throw new RecallPreparationPending();build.verified++;build.verifyAfter=scope;}
      if(rows.length<RECALL_BUILD_SLICE){if(build.verified!==build.scopes.length+build.lineage.length)throw new RecallPreparationPending();build.phase='contains';}
    } else if(build.phase==='contains') {
      if(!build.prior)build.phase='done';
      else {
        const rows=db.prepare('SELECT scope_id,lineage_only FROM memory_recall_view_scopes WHERE view_id=? AND generation=? AND scope_id>? ORDER BY scope_id LIMIT ?').all(build.prior.view_id,build.prior.generation,build.containsAfter,RECALL_BUILD_SLICE);
        for(const row of rows){if(Number(row.lineage_only)===0&&!recallViewHasScope(db,handle,String(row.scope_id)))build.containsPrior=false;build.containsAfter=String(row.scope_id);}
        if(!build.containsPrior || rows.length<RECALL_BUILD_SLICE)build.phase='done';
      }
    }
    return build.phase==='done';
  }, { busyMs: BACKGROUND_BUSY_MS, op: 'recall-view' });
}
export function publishRecallView(build: Build): void {
  fence(build);
  let handle=build.handle;
  transaction(db=>{
    fence(build);
    if(build.phase!=='done')throw new RecallPreparationPending();
    const published=db.prepare("UPDATE memory_recall_views SET state='ready',watermark=? WHERE view_id=? AND generation=? AND state='building'").run(build.watermark,build.handle.viewId,build.handle.generation);
    if(Number(published.changes)!==1)throw new RecallPreparationPending();
    const prior=db.prepare('SELECT view_id,generation FROM memory_recall_contexts WHERE context_key=?').get(build.key);
    // Equivalent publications must not retire readers cached by another live roster object. A roster object that prepares its own cached
    // context again asks for a fresh generation (the prior one is retired as before), so only another object's prior is kept.
    const own=cache(build.db,build.roster).get(build.key)?.handle;
    if(prior && !(own && own.viewId===String(prior.view_id) && own.generation===String(prior.generation)) && db.prepare(`SELECT 1 FROM memory_recall_views WHERE view_id=? AND generation=? AND state='ready'
      AND authority_epoch=? AND digest=? AND scope_count=? AND watermark>=(SELECT projection_floor FROM memory_recall_epoch WHERE id=1)`)
      .get(prior.view_id,prior.generation,build.epoch,build.handle.digest,build.scopes.length)) {
      handle={viewId:String(prior.view_id),generation:String(prior.generation),digest:build.handle.digest};
      return;
    }
    if(prior && build.containsPrior && prior.view_id===build.prior?.view_id && prior.generation===build.prior.generation) {
      db.prepare('INSERT OR IGNORE INTO memory_recall_contains VALUES(?,?,?,?)').run(build.handle.viewId,build.handle.generation,prior.view_id,prior.generation);
      db.prepare(`INSERT OR IGNORE INTO memory_recall_contains SELECT ?,?,prior_view_id,prior_generation FROM memory_recall_contains WHERE view_id=? AND generation=? LIMIT 128`)
        .run(build.handle.viewId,build.handle.generation,prior.view_id,prior.generation);
    }
    db.prepare('INSERT INTO memory_recall_contexts VALUES(?,?,?) ON CONFLICT(context_key) DO UPDATE SET view_id=excluded.view_id,generation=excluded.generation').run(build.key,build.handle.viewId,build.handle.generation);
  }, { busyMs: BACKGROUND_BUSY_MS, op: 'recall-view' });
  // Scope rows this build created itself (construction ensures the reader's own scopes) are in its result: only then is it fresh up to them.
  // A newer row the result does not name leaves the start mark, so the next resolve rebuilds.
  const newer=build.db.prepare('SELECT rowid AS n,id FROM memory_scopes WHERE rowid>? ORDER BY rowid LIMIT 65').all(build.mark);
  if(newer.length && newer.length<=64) {
    const named=new Set([...build.scopes,...build.lineage]);
    if(newer.every(row=>named.has(String(row.id))))build.mark=Number(newer[newer.length-1]!.n);
  }
  cachePublication(build.db,build.roster,build.binding,handle,build.scopes,build.room,build.epoch,build.revision,build.mark);
}

// Producer owner: recall-s4 (publication). Consumer owner: recall-s4b (admission waits).
export interface RecallViewPublication {
  readonly contextKey: string;
  readonly view: RecallViewHandle;
  readonly databaseGeneration: number;
}
const publicationListeners=new Set<(event:Readonly<RecallViewPublication>)=>void>();
/** Notifications run after publication has returned. Each subscriber has its own isolated callback. */
export function subscribeRecallViewPublication(listener:(event:Readonly<RecallViewPublication>)=>void):()=>void {
  publicationListeners.add(listener);
  return ()=>{publicationListeners.delete(listener);};
}
function cachePublication(db:DatabaseSync,roster:MemoryRoster,binding:RecallViewBinding,handle:RecallViewHandle,
  values:string[],room:boolean,epoch:number,revision:number,mark:number):void {
  const key=recallContextKey(binding),currentCache=cache(db,roster),scopes=scopeSnapshot(values);
  if(currentCache.size>=128 && !currentCache.has(key)) {
    const idle=[...currentCache].find(([contextKey,value])=>!hasActiveReader(db,value.handle.viewId,contextKey));
    if(idle)currentCache.delete(idle[0]);
  }
  currentCache.set(key,{handle,scopes,room,epoch,revision,mark});
  sharePreparedAudience(db,roster,`${binding.botId}\0${binding.threadId}\0${binding.notOwnerAudience}\0${binding.humanPrincipal.personId}`,scopes);
  const event=Object.freeze({contextKey:key,view:handle,databaseGeneration:databaseGeneration()});
  for(const listener of publicationListeners)setImmediate(()=>{
    if(event.databaseGeneration!==databaseGeneration() || !publicationListeners.has(listener))return;
    try{listener(event);}catch{/* A consumer cannot interrupt publication or another consumer. */}
  }).unref();
}

type CertifiedRoster=MemoryRoster & {
  recallRosterCertificate?:()=>Readonly<RecallRosterCertificate>|undefined;
  queueRecallRosterCertification?:()=>void;
};
/** Maintenance primitive only. No authoritative records/jobs, durable revisions or writes are consulted.
 * A persisted ready row is a candidate, never authority; compare the oracle's COMPLETE result first. */
export function* hydrateRecallViewSteps(binding:RecallViewBinding,roster:MemoryRoster):Generator<void,boolean> {
  const db=database(),generation=databaseGeneration(),source=roster as CertifiedRoster;
  const budget=new ConstructionBudget(true);
  let hydrating:Map<string,number>|undefined,viewId:string|undefined;
  try {
    assertHumanPrincipal(binding.humanPrincipal);
    const certificate=source.recallRosterCertificate?.();
    if(!certificate)return false;
    const key=recallContextKey(binding),epoch=recallAuthorityEpoch(db),revision=roster.memoryRosterRevision,mark=scopeMark(db);
    const read=()=>db.prepare(`SELECT v.* FROM memory_recall_contexts c JOIN memory_recall_views v USING(view_id,generation) WHERE c.context_key=?`).get(key);
    const row=read();
    if(!row || row.state!=='ready' || Number(row.authority_epoch)!==epoch
      || Number(row.watermark)<Number(db.prepare('SELECT projection_floor FROM memory_recall_epoch WHERE id=1').get()?.projection_floor??Infinity))return false;
    hydrating=hydratingViews.get(db);
    if(!hydrating)hydratingViews.set(db,hydrating=new Map());
    viewId=String(row.view_id);hydrating.set(viewId,(hydrating.get(viewId)??0)+1);
    const valid=()=>{
      if(generation!==databaseGeneration() || revision!==roster.memoryRosterRevision || certificate.databaseGeneration!==generation
        || certificate.epoch!==epoch || certificate.rosterRevision!==revision || recallAuthorityEpoch(db)!==epoch)return false;
      const live=source.recallRosterCertificate?.();
      const current=read();
      return !!live && live.databaseGeneration===generation && live.epoch===epoch && live.rosterRevision===revision
        && !!current && current.view_id===row.view_id && current.generation===row.generation && current.state==='ready'
        && current.authority_epoch===row.authority_epoch && current.digest===row.digest && current.scope_count===row.scope_count
        && current.room_reader===row.room_reader && current.watermark===row.watermark;
    };
    if(!valid())return false;
    counters.oracleComputes++;
    const oracle=recallMembershipSteps(db,binding,roster,budget,(kind,key)=>{
      const scope=scopeRow(db,kind,key);
      if(!scope)throw new RecallPreparationPending();
      return String(scope.id);
    });
    let result:ReturnType<typeof oracle.next>;
    try {
      for(;;){
        if(!valid())return false;
        for(let n=0;n<RECALL_BUILD_SLICE;n++){result=oracle.next();if(result.done)break;}
        if(!valid())return false;
        if(result!.done)break;
        yield;
      }
    } finally {oracle.return({scopes:[],lineage:[],personScopes:new Set(),room:false});}
    const expected=result!.value;
    if(!expected.scopes.length || expected.scopes.length+expected.lineage.length>200_000
      || Number(row.scope_count)!==expected.scopes.length || Number(row.room_reader)!==Number(expected.room))return false;
    const eligibility=()=>db.prepare('SELECT eligible FROM memory_recall_thread_readers WHERE view_id=? AND generation=?').get(row.view_id,row.generation);
    if(Number(eligibility()?.eligible)!==Number(!!expected.threadRecall))return false;
    const hash=createHash('sha256');let chunks=0;
    for(const bytes of constructionJson([expected.scopes,expected.lineage,expected.room])) {
      hash.update(bytes);if(++chunks%RECALL_BUILD_SLICE===0){yield;if(!valid())return false;}
    }
    if(hash.digest('hex')!==row.digest)return false;
    const has=(values:string[],scope:string)=>{let a=0,b=values.length;while(a<b){const mid=(a+b)>>>1;if(values[mid]<scope)a=mid+1;else b=mid;}return values[a]===scope;};
    let after='',scopes=0,lineage=0;
    for(;;) {
      if(!valid())return false;
      const rows=db.prepare('SELECT scope_id,lineage_only,person_scope FROM memory_recall_view_scopes WHERE view_id=? AND generation=? AND scope_id>? ORDER BY scope_id LIMIT ?')
        .all(row.view_id,row.generation,after,RECALL_BUILD_SLICE);
      for(const entry of rows) {
        const scope=String(entry.scope_id),only=Number(entry.lineage_only);
        if(only!==0 && only!==1 || !has(only?expected.lineage:expected.scopes,scope)
          || Number(entry.person_scope)!==Number(expected.personScopes.has(scope)))return false;
        if(only)lineage++;else scopes++;
        after=scope;
      }
      if(rows.length<RECALL_BUILD_SLICE)break;
      yield;
    }
    if(scopes!==expected.scopes.length || lineage!==expected.lineage.length)return false;
    // Deliberate final suspension: races after equality still have to pass the publication fence.
    yield;
    if(!valid())return false;
    const handle=Object.freeze({viewId:String(row.view_id),generation:String(row.generation),digest:String(row.digest)});
    transaction(()=>{
      // The public certificate getter refuses inside transactions. Recheck its captured fields,
      // the live authority, granted policy and context pointer in this same transaction instead.
      if(generation!==databaseGeneration() || revision!==roster.memoryRosterRevision || recallAuthorityEpoch(db)!==epoch
        || certificate.databaseGeneration!==generation || certificate.epoch!==epoch || certificate.rosterRevision!==revision
        || !db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id='memory-roster-policy' AND state='granted'").get()
        || teamChangeOpen(db))throw new RecallPreparationPending();
      const current=read();
      if(!current || current.view_id!==row.view_id || current.generation!==row.generation || current.state!=='ready'
        || current.authority_epoch!==row.authority_epoch || current.digest!==row.digest || current.scope_count!==row.scope_count
        || current.room_reader!==row.room_reader || current.watermark!==row.watermark
        || Number(eligibility()?.eligible)!==Number(!!expected.threadRecall))throw new RecallPreparationPending();
    }, { busyMs: BACKGROUND_BUSY_MS, op: 'recall-view' });
    cachePublication(db,roster,binding,handle,expected.scopes,expected.room,epoch,revision!,mark);
    return true;
  } catch {return false;} finally {
    if(hydrating && viewId!==undefined) {
      const remaining=hydrating.get(viewId)!-1;
      if(remaining)hydrating.set(viewId,remaining);else hydrating.delete(viewId);
    }
    budget.release();
  }
}

/** MAIN ruling 1116 18:15Z S2: a write that moves the authority epoch for a live reader is a structural boundary, so it recomputes the
 * current view of every live reader there: the roster write and reconcile, a bot deletion, and a new scope.
 * Assertions then judge a cited scope by indexed probes of the issued and the current view; they never enumerate an audience.
 * MAIN ruling 1117 06:28Z Q3: bounded by the live readers, never by history. One build per live context key (newest first, at most
 * RECALL_LIVE_READERS_MAX, which the 128-view store limit in startBuild already implies) and one comparison per issued view; the
 * leases a turn took on views of earlier generations cost no statement. A context that cannot be built stays pending, which refuses.
 * A writer that makes several such writes holds the recompute (deferActiveRecallReaders) and runs it once at its end. */
export function prepareActiveRecallReaders(): void {
  if(preparingReaders || deferredReaders || !activeReaders.size)return;
  preparingReaders=true;
  try {
    const db=database(),current=new Map<string,RecallViewHandle|null>(),kept=new Set<string>(),live=new Set<string>();
    for(const reader of [...activeReaders].reverse()) {
      counters.readerVisits++;
      if(!reader.active()){activeReaders.delete(reader);continue;}
      live.add(viewKey(reader.view));
      if(!reader.roster)continue;
      let now=current.get(reader.contextKey);
      if(now!==undefined && !reader.issued)continue;
      if(now===undefined) {
        if(current.size>=RECALL_LIVE_READERS_MAX)continue;
        try{assertIssuedRecallView(db,reader.view);}catch{activeReaders.delete(reader);continue;}
        now=null;
        try {
          const roster=reader.roster();
          prepareRecallContextSync(reader.binding.botId,reader.binding.threadId,roster,reader.binding.notOwnerAudience);
          now=cache(db,roster).get(reader.contextKey)?.handle??null;
        } catch{/* no current view: the reader's next assertion refuses */}
        current.set(reader.contextKey,now);
        if(!reader.issued)continue;
      }
      // Q5: only a view that is not wider than the issued one, nor than the view this access was last narrowed to, is read through.
      const key=viewKey(reader.view),before=narrowed.get(key);
      if(kept.has(key))continue;
      let ok=false;
      try{ok=!!now && recallViewNotWider(db,now,reader.view) && (!before || recallViewNotWider(db,now,before));}catch{/* unproven: refused */}
      // A narrowing sticks: a wider (or unbuilt) current view keeps the last narrowed entry, which is stale, so reads refuse and a scope
      // probe answers with what both the issued and the narrowed view hold.
      if(ok){narrowed.set(key,now!);kept.add(key);}
    }
    for(const key of [...narrowed.keys()])if(!live.has(key))narrowed.delete(key);
  } finally {preparingReaders=false;}
}
export function deferActiveRecallReaders<T>(work:()=>T): T {
  deferredReaders++;
  try{return work();}finally{deferredReaders--;}
}
export function prepareRecallContextSync(botId: string,threadId: string,roster: MemoryRoster,notOwnerAudience=false): void {
  if(roster.memoryRosterRevision===undefined)return;
  const binding={botId,threadId,humanPrincipal:threadHumanPrincipal(threadId),notOwnerAudience};
  const known=cache(database(),roster).get(recallContextKey(binding));
  if(known && known.epoch===recallAuthorityEpoch(database()) && known.revision===roster.memoryRosterRevision && known.mark===scopeMark(database())){try{assertRecallView(database(),known.handle,binding);return;}catch{/* Rebuild only at this explicit preparation boundary. */}}
  const build=startBuild(binding,roster);activeBuild(build,true);
  try{while(!buildRecallViewSlice(build)){ /* Explicit structural/fixture preparation only. */ }publishRecallView(build);}finally{activeBuild(build,false);}
}
/** Background-only work for one key. A single worker advances one slice, then chooses priority again. */
function* prepareContextSteps(binding:RecallViewBinding,roster:MemoryRoster,waiting=true):Generator<void> {
  const source=roster as CertifiedRoster,generation=databaseGeneration(),revision=roster.memoryRosterRevision;
  if(source.recallRosterCertificate) {
    source.queueRecallRosterCertification?.();
    const until=Date.now()+20_000;
    while(!source.recallRosterCertificate()) {
      if(generation!==databaseGeneration() || revision!==roster.memoryRosterRevision || Date.now()>until)throw new RecallPreparationPending();
      yield;
    }
    if(yield* hydrateRecallViewSteps(binding,roster))return;
  }
  const build=startBuild(binding,roster,waiting);activeBuild(build,true);
  try {while(!buildRecallViewSlice(build))yield;publishRecallView(build);}
  finally {activeBuild(build,false);}
}
export async function prepareRecallContext(botId: string,threadId: string,roster: MemoryRoster,notOwnerAudience=false): Promise<void> {
  const steps=prepareContextSteps({botId,threadId,humanPrincipal:threadHumanPrincipal(threadId),notOwnerAudience},roster);
  try {while(!steps.next().done)await new Promise<void>(resolve=>setImmediate(resolve));}
  finally {steps.return(undefined);}
}
interface QueuedContext {binding:RecallViewBinding;roster:MemoryRoster;revision:number;steps?:Generator<void>}
interface ContextQueue {waiting:Map<string,QueuedContext>;speculative:Map<string,QueuedContext>;scheduled:boolean}
const queued=new WeakMap<DatabaseSync,ContextQueue>();
function queueRecallContext(binding: RecallViewBinding,roster: MemoryRoster,waiting=true): void {
  if(roster.memoryRosterRevision===undefined)return;
  const db=database(),generation=databaseGeneration();let queue=queued.get(db);
  if(!queue)queued.set(db,queue={waiting:new Map(),speculative:new Map(),scheduled:false});
  const key=recallContextKey(binding),known=cache(db,roster).get(key);
  if(known && known.epoch===recallAuthorityEpoch(db) && known.revision===roster.memoryRosterRevision && known.mark===scopeMark(db)){try{assertRecallView(db,known.handle,binding);return;}catch{/* stale context */}}
  let item=queue.waiting.get(key)??queue.speculative.get(key);
  if(item && (item.roster!==roster || item.revision!==roster.memoryRosterRevision)){item.steps?.return(undefined);queue.waiting.delete(key);queue.speculative.delete(key);item=undefined;}
  if(!item)item={binding,roster,revision:roster.memoryRosterRevision};
  if(waiting){queue.speculative.delete(key);queue.waiting.set(key,item);}else if(!queue.waiting.has(key))queue.speculative.set(key,item);
  if(queue.scheduled)return;
  queue.scheduled=true;
  const advance=()=>{
    if(generation!==databaseGeneration()) {for(const items of [queue!.waiting,queue!.speculative]){for(const entry of items.values())entry.steps?.return(undefined);items.clear();}queue!.scheduled=false;return;}
    const items=queue!.waiting.size?queue!.waiting:queue!.speculative;
    const next=items.entries().next();
    if(next.done){queue!.scheduled=false;return;}
    const [key,item]=next.value;
    try {
      // Presentation saves also advance the roster revision. Cancel the old proof,
      // but retain this demand under the live revision even when no structural
      // publication follows that save. Every fence still applies to the new proof.
      if(item.revision!==item.roster.memoryRosterRevision) {
        item.steps?.return(undefined);
        items.set(key,{binding:item.binding,roster:item.roster,revision:item.roster.memoryRosterRevision!});
      } else if(activeBuilds.get(db)?.has(latestBuilds.get(db)?.get(key)??'') && !item.steps){items.delete(key);}
      else if(items===queue!.speculative && !item.steps && !db.prepare('SELECT 1 FROM memory_recall_contexts WHERE context_key=?').get(key)
        && Number(db.prepare("SELECT count(*) AS n FROM memory_recall_views v WHERE v.state='building' OR EXISTS(SELECT 1 FROM memory_recall_contexts c WHERE c.view_id=v.view_id AND c.generation=v.generation)").get()!.n)>=127) {
        // Speculation leaves a replacement slot and cannot evict an admitted reader.
        items.delete(key);
      } else {item.steps??=prepareContextSteps(item.binding,item.roster,items===queue!.waiting);if(item.steps.next().done)items.delete(key);}
    } catch {item.steps?.return(undefined);items.delete(key);/* Refused until the next demand or structural event. */}
    setImmediate(advance).unref();
  };
  setImmediate(advance).unref();
}
/** Structural/startup hook. Enumerate cooperatively, including every new task's own context. */
const scheduledRosters=new WeakMap<MemoryRoster,{revision:number;generation:number}>();
/** Room member contexts a roster enumeration has already queued, per database. A member added after the first enumeration is new demand: its first dispatch follows the structural event. */
const knownRoomContexts=new WeakMap<DatabaseSync,Set<string>>();
export function prepareRosterRecallViews(roster: MemoryRoster): void {
  startRecallViewMaintenance();
  const revision=roster.memoryRosterRevision,generation=databaseGeneration(),known=scheduledRosters.get(roster);
  if(revision===undefined || known?.revision===revision&&known.generation===generation)return;
  const stamp={revision,generation};scheduledRosters.set(roster,stamp);
  const db=database(),startup=!knownRoomContexts.has(db),queuedRooms=knownRoomContexts.get(db)??new Set<string>();knownRoomContexts.set(db,queuedRooms);
  // A room or member added after startup is demand: its contexts go first, at waiting priority, ahead of the rebuild of every older bot context.
  const added:Array<[string,string,boolean]>=[],addedKeys=new Set<string>();
  for(const room of roster.groups)for(const bot of room.memberIds)for(const thread of [room.threadId,...(room.tasks??[]).map(task=>task.threadId)])for(const notOwner of [false,true]) {
    const key=JSON.stringify([bot,thread,notOwner]);
    if(startup)queuedRooms.add(key);
    else if(!queuedRooms.has(key)){added.push([bot,thread,notOwner]);addedKeys.add(key);}
  }
  function* contexts():Generator<[string,string,boolean,boolean]|undefined> {
    // Known only once queued: an interrupted enumeration restarts with the rest still new.
    for(const [bot,thread,notOwner] of added){queuedRooms.add(JSON.stringify([bot,thread,notOwner]));yield [bot,thread,notOwner,true];}
    for(const bot of roster.bots) {
      for(const notOwner of [false,true])yield [bot.id,bot.threadId,notOwner,false];
      for(const task of bot.tasks??[])for(const notOwner of [false,true])yield [bot.id,task.threadId,notOwner,false];
    }
    for(const room of roster.groups) {
      yield;
      for(const bot of room.memberIds) {
        for(const thread of [room.threadId,...(room.tasks??[]).map(task=>task.threadId)])for(const notOwner of [false,true])
          if(!addedKeys.has(JSON.stringify([bot,thread,notOwner])))yield [bot,thread,notOwner,false];
      }
    }
  }
  const pending=contexts();
  const next=()=>{
    if(generation!==databaseGeneration()){if(scheduledRosters.get(roster)===stamp)scheduledRosters.delete(roster);return;}
    if(roster.memoryRosterRevision!==revision) {
      if(scheduledRosters.get(roster)===stamp) {
        scheduledRosters.delete(roster);
        // An unchanged audience save need not schedule a structural callback.
        // Restart the interrupted enumeration so its remaining contexts survive.
        prepareRosterRecallViews(roster);
      }
      return;
    }
    try {
      const item=pending.next();if(item.done){if(scheduledRosters.get(roster)===stamp)scheduledRosters.delete(roster);return;}
      if(item.value) {
        const [bot,thread,notOwner,added]=item.value;
        queueRecallContext({botId:bot,threadId:thread,humanPrincipal:threadHumanPrincipal(thread),notOwnerAudience:notOwner},roster,added);
      }
    } catch { /* A failed generation stays unavailable; no legacy fallback. */ }
    setImmediate(next).unref();
  };
  setImmediate(next).unref();
}

export function evictRecallViewsForTest(db: DatabaseSync): void { held.delete(db); }
/** Fixtures arm their whole-turn counters only after startup construction has actually settled. */
export async function waitForRecallConstructionIdleForTest(roster:MemoryRoster):Promise<void> {
  const db=database(),generation=databaseGeneration(),until=Date.now()+20_000;
  do {
    await new Promise<void>(resolve=>setImmediate(resolve));
    if(generation!==databaseGeneration()||Date.now()>until)throw new RecallPreparationPending();
  }while(scheduledRosters.has(roster)||activeBuilds.get(db)?.size||queued.get(db)?.waiting.size||queued.get(db)?.speculative.size||rosterPreparations.has(roster));
}
/** A maintenance tick advances one view through one change page; it never fans a record write out synchronously. */
export function maintainRecallViewSlice(view: RecallViewHandle): boolean {
  const db=database();assertRecallView(db,view);
  return transaction(()=>{
    const mark=Number(db.prepare('SELECT watermark FROM memory_recall_views WHERE view_id=? AND generation=?').get(view.viewId,view.generation)!.watermark);
    const page=projectChangePage(db,view,mark);
    if(page.watermark!==mark)db.prepare('UPDATE memory_recall_views SET watermark=? WHERE view_id=? AND generation=?').run(page.watermark,view.viewId,view.generation);
    return page.done;
  }, { busyMs: BACKGROUND_BUSY_MS, op: 'recall-view' });
}

const maintenanceWarnings=new WeakMap<DatabaseSync,Set<string>>();
const requestedMaintenance=new WeakMap<DatabaseSync,Set<string>>();
/** Projection producer owner: recall-scope; waiting-turn consumer owner: r3-browser-wait.
 * An admitted reader need not wait behind every idle context's timer slot.
 * Queue only one bounded change page, with the same publication/authority
 * checks as timer upkeep. The caller must retry its guarded read afterwards. */
export function requestRecallViewMaintenance(view: RecallViewHandle): void {
  const db=database(),generation=databaseGeneration(),key=JSON.stringify([view.viewId,view.generation]);
  let pending=requestedMaintenance.get(db);if(!pending)requestedMaintenance.set(db,pending=new Set());
  if(pending.has(key)||pending.size>=128)return;
  pending.add(key);
  const requested={...view},queue=pending;
  setImmediate(()=>{
    queue.delete(key);
    if(databaseGeneration()!==generation||hydratingViews.get(db)?.has(requested.viewId))return;
    try { maintainRecallViewSlice(requested); }
    catch(error) { reportMaintenanceError(db,error); }
  }).unref();
}
function reportMaintenanceError(db:DatabaseSync|undefined,error:unknown):void {
  const message=error instanceof Error?error.message:'';
  const code=error && typeof error==='object' && 'code' in error?String(error.code):'';
  if (/^MEMORY_(RECALL_UNAVAILABLE|CONTEXT_REVOKED)$/.test(message)
    || code==='ERR_INVALID_STATE' && /database is not open|database has been closed/i.test(message)) return;
  // Fixed diagnostics never include stored text, SQL, filenames or bindings.
  const diagnostic=/^SQLITE_[A-Z_]+$/.test(code)?code:'unexpected storage failure';
  if(db){let seen=maintenanceWarnings.get(db);if(!seen)maintenanceWarnings.set(db,seen=new Set());if(seen.has(diagnostic))return;seen.add(diagnostic);}
  console.warn(`[memory] recall view maintenance failed (${diagnostic}); retrying`);
}
let upkeep: ReturnType<typeof setTimeout> | undefined;
let upkeepKey='';
/** MAIN RULING 1117T01:23Z (b): a roster change rebuilds every context, so each tick reclaims a bounded batch of obsolete-view slices
 *  (at most 64 x 256 rows), never one. A small view frees in a few slices, so one tick keeps up with a full rebuild's supersessions
 *  without letting orphans reach the 128-view cap. The batch stops as soon as nothing is left; work per tick never grows with history. */
const RECLAIM_SLICES_PER_TICK=64;
let closeHooked=false;
/** One context, one bounded change page and one bounded reclamation batch per tick. No record writer enumerates views. */
export function startRecallViewMaintenance(): void {
  if(upkeep)return;
  if(!closeHooked){closeHooked=true;onDatabaseClose(stopRecallViewMaintenance);}
  const tick=()=>{
    upkeep=undefined;
    let db:DatabaseSync|undefined;
    try {
      db=database();
      let row=db.prepare('SELECT context_key,view_id,generation FROM memory_recall_contexts WHERE context_key>? ORDER BY context_key LIMIT 1').get(upkeepKey);
      if(!row){upkeepKey='';row=db.prepare('SELECT context_key,view_id,generation FROM memory_recall_contexts ORDER BY context_key LIMIT 1').get();}
      for(let slice=0;slice<RECLAIM_SLICES_PER_TICK&&!collectRecallViewSlice(db);slice++){/* bounded reclamation batch */}
      collectSessionChecksSlice(db);
      seedSessionChecksSlice();
      if(row){upkeepKey=String(row.context_key);const view=db.prepare('SELECT digest FROM memory_recall_views WHERE view_id=? AND generation=?').get(row.view_id,row.generation);
        if(view && !hydratingViews.get(db)?.has(String(row.view_id)))maintainRecallViewSlice({viewId:String(row.view_id),generation:String(row.generation),digest:String(view.digest)});}
    } catch(error) { reportMaintenanceError(db,error); }
    upkeep=setTimeout(tick,50);upkeep.unref();
  };
  upkeep=setTimeout(tick,50);upkeep.unref();
}
export function stopRecallViewMaintenance(): void { if(upkeep)clearTimeout(upkeep);upkeep=undefined;upkeepKey=''; }

const rosterPreparations=new WeakMap<MemoryRoster,boolean>();
/** Called by the structural writer BEFORE returning to its publisher. Read the live roster only on the next tick, after staging finished. */
export function queueRecallRosterPreparation(roster: () => MemoryRoster): void {
  const current=roster();if(rosterPreparations.has(current))return;
  rosterPreparations.set(current,true);const generation=databaseGeneration();
  setImmediate(()=>{rosterPreparations.delete(current);if(generation!==databaseGeneration())return;try{prepareRosterRecallViews(roster());}catch{/* unavailable until a fresh structural publication */}}).unref();
}

/** Offline subset proof for a continuation hold issued to a previous reader view. Never used to admit an old capability. */
export function recallViewContains(db: DatabaseSync,current: RecallViewHandle,prior: RecallViewHandle): boolean {
  return current.digest===prior.digest || !!db.prepare('SELECT 1 FROM memory_recall_contains WHERE view_id=? AND generation=? AND prior_view_id=? AND prior_generation=?')
    .get(current.viewId,current.generation,prior.viewId,prior.generation);
}

/** The structural writer proved the proposed roster has exactly the granted audience facts, or exactly the last persisted bytes.
 * A presentation/engine save may advance its bookkeeping revision without changing any view membership. */
export function acknowledgeRecallRosterRevision(roster: MemoryRoster): void {
  if(roster.memoryRosterRevision!==undefined)acknowledged.set(roster,{revision:roster.memoryRosterRevision,epoch:recallAuthorityEpoch(database())});
}

/** Reclaim in bounded slices. Neither supersession nor storage pressure can revoke a live reader. */
export function collectRecallViewSlice(db: DatabaseSync): boolean {
  const idle=(id:string,key?:string)=>!hasActiveReader(db,id,key) && !activeBuilds.get(db)?.has(id) && !hydratingViews.get(db)?.has(id);
  const row=db.prepare(`SELECT view_id,generation FROM memory_recall_views v WHERE NOT EXISTS(SELECT 1 FROM memory_recall_contexts c WHERE c.view_id=v.view_id AND c.generation=v.generation) ORDER BY view_id,generation`).all().find(row=>idle(String(row.view_id)));
  if (!row) {
    if (storagePressure.has(db)) {
      const waiting=storagePressure.get(db);
      storagePressure.delete(db);
      // Speculative warming cannot displace current contexts; waiting readers can reclaim idle ones.
      const contexts=db.prepare(`SELECT c.context_key,c.view_id FROM memory_recall_contexts c
        JOIN memory_recall_views v ON v.view_id=c.view_id AND v.generation=c.generation
        WHERE ? OR v.authority_epoch<>(SELECT epoch FROM memory_recall_epoch WHERE id=1)
        ORDER BY c.context_key`).all(waiting?1:0);
      const order=viewOrder.get(db);
      contexts.sort((a,b)=>(order?.get(String(a.view_id))??0)-(order?.get(String(b.view_id))??0));
      const victim=contexts.find(row=>idle(String(row.view_id),String(row.context_key)));
      if(victim)db.prepare('DELETE FROM memory_recall_contexts WHERE context_key=?').run(victim.context_key);
      return false;
    }
    return true;
  }
  return transaction(()=>{
    db.prepare("UPDATE memory_recall_views SET state='building' WHERE view_id=? AND generation=?").run(row.view_id,row.generation);
    const keys:Record<string,string>={memory_recall_thread_readers:'view_id',memory_recall_view_scopes:'scope_id',memory_recall_view_terms:'term,sequence,record_id,version',memory_recall_view_records:'record_id,version',memory_recall_view_pending:'sequence,record_id,version',memory_recall_view_jobs:'sequence,job_id',memory_recall_contains:'prior_view_id,prior_generation'};
    for(const [table,key] of Object.entries(keys)) {
      const count=db.prepare(`DELETE FROM ${table} WHERE view_id=?1 AND generation=?2 AND (${key}) IN (SELECT ${key} FROM ${table} WHERE view_id=?1 AND generation=?2 LIMIT 256)`).run(row.view_id,row.generation).changes;
      if(Number(count)>0)return false;
    }
    db.prepare('DELETE FROM memory_recall_views WHERE view_id=? AND generation=?').run(row.view_id,row.generation);
    viewOrder.get(db)?.delete(String(row.view_id));return false;
  }, { busyMs: BACKGROUND_BUSY_MS, op: 'recall-view' });
}

/** Only policy.ts calls this after validating the private issued capability and resolving a ready current view. */
export function assertIssuedRecallView(db: DatabaseSync,view: RecallViewHandle): void {
  const row=db.prepare('SELECT digest,state FROM memory_recall_views WHERE view_id=? AND generation=?').get(view.viewId,view.generation);
  if(!row || row.state!=='ready' || row.digest!==view.digest)throw new RecallPreparationPending();
}
