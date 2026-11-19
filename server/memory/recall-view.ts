import { collectSessionChecksSlice } from './session-proof-schema.ts';
import { seedSessionChecksSlice } from './session-proof.ts';
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: store-patchbot (roster revision); consumer owner: recall-scope (views, admission, indexes and lineage).
// Scheduling recovery repair owner: c4-misc-a2; authority/view owner: recall-scope.
import { RecallCapacityPending, RecallPreparationPending } from './recall-recovery.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { database, databaseGeneration, onDatabaseClose, transaction } from '../database.ts';
import { BACKGROUND_BUSY_MS, DatabaseBusyError } from '../db-busy.ts';
import { BLOCK_BYTES, ioBudget, readProcess, RECALL_RECLAIM_BYTES_PER_MINUTE, RECALL_RECLAIM_SOURCE, RECALL_RECLAIM_YIELD_MS } from '../io-budget.ts';
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
import { settleWal, WAL_ADMISSION_BYTES, walBacklog } from '../wal-maintenance.ts';

export interface RecallViewHandle { readonly viewId: string; readonly generation: string; readonly digest: string }
export interface RecallViewBinding { readonly botId: string; readonly threadId: string; readonly humanPrincipal: HumanPrincipal; readonly notOwnerAudience: boolean }
interface Held { handle: RecallViewHandle; scopes: readonly string[]; room: boolean; epoch: number; revision: number; mark: number }
/** Freshness, apart from validity (the epoch). Producer owner: scope-insert.ts insertScope (a new scope row that keeps the epoch); consumer
 * owner: recall-scope. A view built before the newest scope row existed is still valid for every scope it cites, but it is not the current
 * answer for a new reader: it is rebuilt before it is issued again. A scope delete moves the epoch, so a reused row id cannot hide a change. */
function scopeMark(db: DatabaseSync): number { return Number(db.prepare('SELECT max(rowid) AS n FROM memory_scopes').get()?.n ?? 0); }
const held = new WeakMap<DatabaseSync, WeakMap<MemoryRoster, Map<string,Held>>>();
const storagePressure=new WeakMap<DatabaseSync,boolean>();
// R01 owner: recall-reclaim-r2. Contexts whose waiting build was refused because every view is live; cleared only when
// that context publishes a view or its build fails for another reason. A mark is one context key and outlives its parked
// demand: the parked queue is bounded, and a demand pushed out of it must still read as refused until its own view exists.
// Like the known room contexts below, the marks are bounded by the roster's contexts, not by a constant.
const capacityRefused=new WeakMap<DatabaseSync,Set<string>>();
function clearCapacityRefusal(db:DatabaseSync,key:string):void {capacityRefused.get(db)?.delete(key);}
const RECALL_VIEW_LIMIT=128;
// Only these refusals mean "every view slot is taken". The quota trigger, the scope ceiling and the construction budget raise the same
// message for a build that cannot fit at all; parking those re-runs a full build on every wake, forever (1.0.20 canary write storm).
function viewCapRefusal():Error {return Object.assign(new Error('MEMORY_RECALL_STORAGE_LIMIT'),{recallViewCap:true});}
const isViewCapRefusal=(error:unknown)=>error instanceof Error && (error as {recallViewCap?:unknown}).recallViewCap===true;
interface Reader {databaseGeneration:number;view:RecallViewHandle;viewId:string;contextKey:string;active:()=>boolean;binding:RecallViewBinding;roster?:()=>MemoryRoster;issued:boolean}
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
function activeBuild(build:Build,active:boolean) {let set=activeBuilds.get(build.db);if(!set)activeBuilds.set(build.db,set=new Set());if(active)set.add(build.handle.viewId);else {set.delete(build.handle.viewId);build.budget.release();wakeParkedContexts(build.db);}}
const acknowledged=new WeakMap<MemoryRoster,{epoch:number;revision:number}>();
function currentRosterRevision(roster:MemoryRoster,known:Held):boolean {
  return roster.memoryRosterRevision!==undefined && (known.revision===roster.memoryRosterRevision
    || acknowledged.get(roster)?.revision===roster.memoryRosterRevision && acknowledged.get(roster)?.epoch===known.epoch);
}
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
export function assertRecallView(db: DatabaseSync, view: RecallViewHandle, binding?: RecallViewBinding): number {
  // A live issued reader may finish on its superseded view; bound admission still requires the current publication.
  // Read every live fence in one SQLite snapshot, including foreign commits; no authority answer is memoized.
  const row=db.prepare(`SELECT v.authority_epoch,v.state,v.digest,v.scope_count,v.watermark,
    (SELECT projection_floor FROM memory_recall_epoch WHERE id=1) AS projection_floor,
    (SELECT epoch FROM memory_recall_epoch WHERE id=1) AS epoch,
    EXISTS(SELECT 1 FROM memory_recall_contexts WHERE view_id=v.view_id AND generation=v.generation) AS context,
    EXISTS(SELECT 1 FROM memory_scope_bindings WHERE id='memory-roster-policy' AND state='granted') AS granted,
    (?3 IS NULL OR EXISTS(SELECT 1 FROM memory_recall_contexts WHERE context_key=?3 AND view_id=v.view_id AND generation=v.generation)) AS bound
    FROM memory_recall_views v WHERE v.view_id=?1 AND v.generation=?2`).get(view.viewId,view.generation,binding?recallContextKey(binding):null);
  if (!row || Number(row.watermark)<Number(row.projection_floor??Infinity) || (!row.context && (binding!==undefined || !hasActiveReader(db,view.viewId))) || row.state!=='ready' || row.digest!==view.digest || Number(row.scope_count)<=0 || !Number.isSafeInteger(row.epoch) || Number(row.authority_epoch)!==Number(row.epoch) || !row.granted) throw new RecallPreparationPending();
  if (binding && !row.bound) throw new RecallPreparationPending();
  return Number(row.epoch);
}
/** A handle is metadata, never a tool capability. The caller must validate its private claim first. */
export function resolveRecallView(binding: RecallViewBinding, roster: MemoryRoster, issued = false): Held {
  const db=database(), key=recallContextKey(binding), known=cache(db,roster).get(key);
  // Only a structurally revisioned roster can prove that an immutable view still describes its current audience.
  // A capacity refusal stays typed, so a waiting turn ends on its card and never runs without recall unannounced.
  const capacity=()=>{if(capacityRefused.get(db)?.has(key))throw new RecallCapacityPending();};
  if (!known || !currentRosterRevision(roster,known)) {
    queueRecallContext(binding,roster); capacity(); throw new RecallPreparationPending();
  }
  try { if(assertRecallView(db,known.handle,binding)!==known.epoch)throw new RecallPreparationPending(); }
  catch { queueRecallContext(binding,roster); capacity(); throw new RecallPreparationPending(); }
  // `issued`: the caller already holds an access issued from a view and only checks it against this one. A scope row created since is in
  // neither, so the reader goes on while the rebuild is queued; a new issuance waits for the rebuilt view.
  if (known.mark!==scopeMark(db)) { queueRecallContext(binding,roster); if (!issued) { capacity(); throw new RecallPreparationPending(); } }
  return known;
}
/** Reader lease owner: askcards-flake-b; release owner: the issuing capability's turn teardown. */
export function retainRecallView(view:RecallViewHandle,binding:RecallViewBinding,active:()=>boolean,roster?:()=>MemoryRoster,issued=false):()=>void {
  const db=database();assertIssuedRecallView(db,view);
  const readers=activeReaders;
  if(readSinceBoot.size>=4096)readSinceBoot.delete(readSinceBoot.values().next().value!);
  readSinceBoot.add(view.viewId);
  const reader:Reader={databaseGeneration:databaseGeneration(),view,viewId:view.viewId,contextKey:recallContextKey(binding),active,binding,roster,issued};
  readers.add(reader);
  // DESIGN-B5-PROOF F3: the registry itself holds at most RECALL_LIVE_READERS_MAX entries, issued or not, so a recompute never inspects
  // more, whatever the history. The oldest entry goes (normally a lease on an earlier generation); it gets no recompute, so after the
  // next epoch move its view is stale and refuses: an evicted reader never reads wider.
  if(readers.size>RECALL_LIVE_READERS_MAX)readers.delete(readers.values().next().value!);
  return ()=>{
    if(!readers.delete(reader))return;
    try {
      if(storagePressure.get(db)!==true || reader.databaseGeneration!==databaseGeneration())return;
      // Retiring a lease can free obsolete rows without evicting another context.
      storagePressure.delete(db);
      try {
        for(let slice=0;slice<RECLAIM_SLICES_PER_TICK&&!collectRecallViewSlice(db);slice++){/* bounded reclamation batch */}
        if(Number(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n)>=RECALL_VIEW_LIMIT)storagePressure.set(db,true);
      } catch(error){storagePressure.set(db,true);reportMaintenanceError(db,error);}
    } finally {wakeParkedContexts(db);}
  };
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
  scopeAt: number; lineageAt: number; recordBefore: number; jobAfter: number; watermark: number;
  /** Term bytes this build may still write (RECALL_VIEW_TERM_BUDGET): the records phase walks newest first and an older record past the budget
   *  keeps its record row (paged recall still reaches it) without terms. windowed is set once a record went without its terms. */
  termRoom: {left:number;windowed:boolean};
  oracle: Generator<void>;budget:ConstructionBudget;
  verifyAfter:string;verified:number;prior:{view_id:string;generation:string}|undefined;containsAfter:string;containsPrior:boolean;
  phase: 'oracle'|'scopes'|'records'|'jobs'|'changes'|'verify'|'contains'|'done';
  /** An equal ready view this build publishes instead of projecting its own (recalldesign-1020-n1 adoption). */
  adopt?: {viewId:string;generation:string};
}
/** Construction oracle: used only at a structural boundary, never by admission/assert/search. */
function startBuild(binding: RecallViewBinding,roster: MemoryRoster,waiting=true): Build {
  const db=database(); assertHumanPrincipal(binding.humanPrincipal);
  if (roster.memoryRosterRevision===undefined) throw new RecallPreparationPending();
  const started=transaction(()=>{
    const prior=db.prepare('SELECT view_id,generation FROM memory_recall_contexts WHERE context_key=?').get(recallContextKey(binding)) as Build['prior'];
    const viewCount=()=>Number(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n);
    if(viewCount()>=128) {
      storagePressure.set(db,waiting || storagePressure.get(db)===true);
      // Every waiting build reclaims in place (orphans first, then one idle context's slot), a new context's too. A context with
      // a live reader on any of its views retires only unheld generations, never another context's publication.
      if(waiting) {
        const live=hasActiveReader(db,prior?.view_id??'',recallContextKey(binding));
        if(live)storagePressure.delete(db);
        for(let slice=0;slice<RECLAIM_SLICES_PER_TICK&&viewCount()>=128&&!collectRecallViewSlice(db);slice++){/* bounded reclamation batch */}
        if(live && viewCount()>=128)storagePressure.set(db,true);
      }
      if(viewCount()>=128)return undefined;
    }
    const handle={viewId:randomUUID(),generation:randomUUID(),digest:''};
    const epoch=recallAuthorityEpoch(db),revision=roster.memoryRosterRevision!,mark=scopeMark(db);
    db.prepare("INSERT INTO memory_recall_views(view_id,generation,authority_epoch,roster_revision,state,scope_count,digest,room_reader) VALUES(?,?,?,?,'building',0,'',0)")
      .run(handle.viewId,handle.generation,epoch,revision);
    let order=viewOrder.get(db);if(!order)viewOrder.set(db,order=new Map());
    order.set(handle.viewId,++viewSequence);
    const build:Build={db,databaseGeneration:databaseGeneration(),binding,roster,key:recallContextKey(binding),handle,epoch,revision,mark,
      verifyAfter:'',verified:0,prior,containsAfter:'',containsPrior:true,
      scopes:[],lineage:[],personScopes:new Set(),room:false,scopeAt:0,lineageAt:0,recordBefore:Number.MAX_SAFE_INTEGER,jobAfter:0,termRoom:{left:RECALL_VIEW_TERM_BUDGET,windowed:false},
      watermark:Number(db.prepare('SELECT coalesce(max(sequence),0) AS n FROM memory_recall_changes').get()!.n),phase:'oracle',oracle:undefined!,budget:new ConstructionBudget(true)};
    build.oracle=constructMembership(build);
    let latest=latestBuilds.get(db);if(!latest)latestBuilds.set(db,latest=new Map());
    if(latest.size>=128&&!latest.has(build.key))latest.delete(latest.keys().next().value!);
    latest.set(build.key,handle.viewId);return build;
  }, { busyMs: BACKGROUND_BUSY_MS, op: 'recall-view' });
  if(!started)throw viewCapRefusal();
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
/** MAIN 1.0.20 ruling (recallcap-1020-n5b): a view is bounded for big threads. Its word index holds the newest records within this many term bytes
 *  (charged as projectedRecallViewBytes charges them); older records keep their record rows, so eligible/recent paging still reaches them, and
 *  the view carries RECALL_VIEW_WINDOW_TERM so a word search on it says it read only the newest window (bounded). The 512 MiB quota is unchanged. */
export const RECALL_VIEW_TERM_BUDGET=64*1024*1024;
export const RECALL_VIEW_WINDOW_TERM='\u0000window';
function termCost(text:string):{terms:string[];bytes:number} {const terms=[...wordTerms(text)];let bytes=0;for(const term of terms)bytes+=512+4*Buffer.byteLength(term);return {terms,bytes};}
function projectRecord(db: DatabaseSync,view: RecallViewHandle,id: string,version: number,room?: {left:number;windowed:boolean}): void {
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
  if(!isPipKind(String(row.kind)) && !rolled) {
    const {terms,bytes}=termCost(String(row.text));
    // Newest first: once one record does not fit the term budget, no older record gets terms either (the window stays one contiguous newest range).
    if(room && (room.windowed || bytes>room.left)) {
      if(!room.windowed){room.windowed=true;room.left=0;db.prepare('INSERT OR IGNORE INTO memory_recall_view_terms VALUES(?,?,?,?,?,?)').run(view.viewId,view.generation,RECALL_VIEW_WINDOW_TERM,row.seq,'',0);}
    } else {
      if(room)room.left-=bytes;
      for (const term of terms) add.run(view.viewId,view.generation,term,row.seq,id,version);
    }
  }
  // Read here through the receipts' own index; still written, exactly as 1.0.19 writes it, so a 1.0.19 that opens this file reads a whole view
  // (recall-view-schema.ts RECALL_PENDING_OBJECTS).
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
      const rows=db.prepare(`SELECT r.rowid AS seq,r.id,r.version FROM memory_recall_view_scopes v JOIN memory_records r INDEXED BY memory_records_scope ON r.scope_id=v.scope_id WHERE v.view_id=? AND v.generation=? AND v.lineage_only=0 AND r.rowid<? ORDER BY r.rowid DESC LIMIT ?`).all(handle.viewId,handle.generation,build.recordBefore,RECALL_BUILD_SLICE);
      for(const row of rows){projectRecord(db,handle,String(row.id),Number(row.version),build.termRoom);build.recordBefore=Number(row.seq);}
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
    if(build.adopt) {
      // The adopted view must still be ready under the same key; else this demand fails closed and the next one builds.
      if(!db.prepare(`${READY_KEYED} AND view_id=? AND generation=? AND digest=? AND scope_count=?`).get(build.adopt.viewId,build.adopt.generation,build.handle.digest,build.scopes.length))throw new RecallPreparationPending();
      db.prepare('DELETE FROM memory_recall_thread_readers WHERE view_id=? AND generation=?').run(build.handle.viewId,build.handle.generation);
      db.prepare("DELETE FROM memory_recall_views WHERE view_id=? AND generation=? AND state='building'").run(build.handle.viewId,build.handle.generation);
      db.prepare('INSERT INTO memory_recall_contexts VALUES(?,?,?) ON CONFLICT(context_key) DO UPDATE SET view_id=excluded.view_id,generation=excluded.generation').run(build.key,build.adopt.viewId,build.adopt.generation);
      handle={viewId:build.adopt.viewId,generation:build.adopt.generation,digest:build.handle.digest};
      return;
    }
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
  clearCapacityRefusal(db,key);
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
      // a lease taken on another open of this path never drives a rebuild here; its view is not in this file, so its reads refuse
      if(reader.databaseGeneration!==databaseGeneration())continue;
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
  if(known && known.epoch===recallAuthorityEpoch(database()) && currentRosterRevision(roster,known) && known.mark===scopeMark(database())){try{assertRecallView(database(),known.handle,binding);return;}catch{/* Rebuild only at this explicit preparation boundary. */}}
  const build=startBuild(binding,roster);activeBuild(build,true);
  try{
    while(!buildRecallViewSlice(build)){ /* Explicit structural/fixture preparation only. */ }
    publishRecallView(build);
    storagePressure.delete(build.db);
    while(!collectRecallViewSlice(build.db)){ /* Synchronous preparation also drains reader-free superseded storage. */ }
  }finally{activeBuild(build,false);}
}
/** Background-only work for one key. A single worker advances one slice, then chooses priority again.
 * `hydrateOnly` (the startup sweep, fablehunt-1020q T2): a context that already has a persisted view is hydrated or left alone, never rebuilt.
 * A full build copies every record and term of the reader's scopes; the startup sweep rebuilding every persisted context after any epoch move
 * wrote 12-21 GB per start. A stale persisted context stays refused (fail closed) until a reader demands it (resolveRecallView queues a
 * waiting build) or a structural writer queues the roster again. Contexts that have no persisted view yet are still built (first start). */
function* prepareContextSteps(binding:RecallViewBinding,roster:MemoryRoster,waiting=true,hydrateOnly:()=>boolean=()=>false):Generator<void> {
  const source=roster as CertifiedRoster,db=database(),generation=databaseGeneration(),revision=roster.memoryRosterRevision;
  if(source.recallRosterCertificate) {
    source.queueRecallRosterCertification?.();
    const until=Date.now()+20_000;
    while(!source.recallRosterCertificate()) {
      if(generation!==databaseGeneration() || revision!==roster.memoryRosterRevision || Date.now()>until)throw new RecallPreparationPending();
      contextStepIdle=true;yield;
    }
    if(yield* hydrateRecallViewSteps(binding,roster))return;
  }
  if(hydrateOnly() && db.prepare('SELECT 1 FROM memory_recall_contexts WHERE context_key=?').get(recallContextKey(binding)))return;
  // Advance bounded reclamation with construction; timer-only cleanup can lag behind new generations.
  // Collection may retire this publication without turning its existing demand into a new admission.
  const prior=db.prepare('SELECT view_id FROM memory_recall_contexts WHERE context_key=?').get(recallContextKey(binding));
  let reclaimed=false;
  while(Number(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n)>=128) {
    if(generation!==databaseGeneration() || revision!==roster.memoryRosterRevision)throw new Error('MEMORY_CONTEXT_REVOKED');
    // At the cap, a live-roster write that already published this audience's current view leaves nothing to build or refuse.
    const current=cache(db,roster).get(recallContextKey(binding));
    if(current && current.epoch===recallAuthorityEpoch(db) && currentRosterRevision(roster,current)){try{assertRecallView(db,current.handle,binding);return;}catch{/* build below */}}
    storagePressure.set(db,waiting || storagePressure.get(db)===true);
    if(!waiting)throw viewCapRefusal();
    if(hasActiveReader(db,String(prior?.view_id??''),recallContextKey(binding)))storagePressure.delete(db);
    if(collectRecallViewSlice(db)){storagePressure.set(db,true);throw viewCapRefusal();}
    reclaimed=true;
    yield;
  }
  storagePressure.delete(db);
  const reclaim=reclaimState(db),key=recallContextKey(binding);
  if(waiting)recheckRecallDemand(db,key,revision);
  // A build woken by the reclaimer (its room now exists) shares the reclaimer's bucket and source (section 4).
  const paced=reclaim.woken.delete(key);
  const build=startBuild(binding,roster,waiting);activeBuild(build,true);
  // recallcap-1020-n4a (Fable review of 892d3e4d6e): a demanded build (woken, or a waiting reader's) outranks background reclaim; the
  // reclaimer frees nothing while one is in flight and no demand is short of room (recallReclaimStep).
  const demanded=waiting || paced;
  if(demanded)reclaim.demanded++;
  try {
    let admitted=false;
    for(;;) {
      const before=reclaimClock.written(),turnOpen=ioBudget.ownerWriteOpen();
      const done=paced?ioBudget.withSource(RECALL_RECLAIM_SOURCE,()=>buildRecallViewSlice(build)):buildRecallViewSlice(build);
      // Every slice is charged its own measured bytes; while an owner write is open the process meter also counts the turn, so the
      // bytes are still taken from the bucket but never become the slice cost the next admission waits for.
      // recallcap-1020-n5b (owner copy, minutes 7 and 19 at 1180/1226 MiB: source recall-build at 798 MB/min on top of reclaim and the turn):
      // a waiting reader's build and a speculative one are charged to the same shared bucket as a woken build, so no build writes unpaced
      // on top of the reclaimer and one minute stays inside the bucket's refill.
      {const after=reclaimClock.written();reclaim.lastWritten=after;reclaimCharge(reclaim,after-before,turnOpen || ioBudget.ownerWriteOpen());}
      if(done)break;
      if(!admitted && build.phase!=='oracle'){admitted=true;if(admitRecallBuild(build,waiting))continue;}
      // Every queued build also stays off the WAL gate (reclaimWalHeld) and is paced by the reclaimer's bucket.
      while(reclaimWalHeld(database()) || !reclaimAdmitted(reclaim,reclaimClock.now())){contextStepIdle=true;yield;}
      yield;
    }
    publishRecallView(build);
  }
  finally {activeBuild(build,false);if(demanded)reclaim.demanded--;}
  if(reclaimed)for(let slice=0;slice<RECLAIM_SLICES_PER_TICK&&!collectRecallViewSlice(db);slice++)yield;
}
export async function prepareRecallContext(botId: string,threadId: string,roster: MemoryRoster,notOwnerAudience=false): Promise<void> {
  const steps=prepareContextSteps({botId,threadId,humanPrincipal:threadHumanPrincipal(threadId),notOwnerAudience},roster);
  try {while(!steps.next().done)await new Promise<void>(resolve=>setImmediate(resolve));}
  finally {steps.return(undefined);}
}
// Set by a step that only waits on other work (roster certification), so the queue does not spin for it.
let contextStepIdle=false;
interface QueuedContext {binding:RecallViewBinding;roster:MemoryRoster;revision:number;steps?:Generator<void>;startup?:boolean;retries?:number}
interface ContextQueue {waiting:Map<string,QueuedContext>;speculative:Map<string,QueuedContext>;parked:Map<string,QueuedContext>;scheduled:boolean;generation:number}
const queued=new WeakMap<DatabaseSync,ContextQueue>();
function queueRecallContext(binding: RecallViewBinding,roster: MemoryRoster,waiting=true,startup=false): void {
  if(roster.memoryRosterRevision===undefined)return;
  const db=database();let queue=queued.get(db);
  if(!queue)queued.set(db,queue={waiting:new Map(),speculative:new Map(),parked:new Map(),scheduled:false,generation:databaseGeneration()});
  const key=recallContextKey(binding),known=cache(db,roster).get(key);
  if(known && known.epoch===recallAuthorityEpoch(db) && currentRosterRevision(roster,known) && known.mark===scopeMark(db)){try{assertRecallView(db,known.handle,binding);return;}catch{/* stale context */}}
  let item=queue.waiting.get(key)??queue.speculative.get(key)??queue.parked.get(key);
  if(item && (item.roster!==roster || item.revision!==roster.memoryRosterRevision)){item.steps?.return(undefined);queue.waiting.delete(key);queue.speculative.delete(key);queue.parked.delete(key);item=undefined;}
  if(!item)item={binding,roster,revision:roster.memoryRosterRevision,startup};
  // Demand (or a structural queue) for a key the startup sweep holds takes the ordinary path from its next start.
  else if(item.startup && (waiting || !startup))item.startup=false;
  // A parked demand asks again for a waiting reader; warming never wakes it.
  if(waiting){queue.speculative.delete(key);queue.parked.delete(key);queue.waiting.set(key,item);}else if(!queue.waiting.has(key)&&!queue.parked.has(key))queue.speculative.set(key,item);
  scheduleContextQueue(db,queue);
}
/** A waiting demand refused by a store full of live views rests here. A released reader, a finished build or
 * the existing upkeep tick asks again for it; nothing polls and no timer is added. */
function wakeParkedContexts(db:DatabaseSync,limit=RECALL_VIEW_LIMIT):void {
  const queue=queued.get(db);
  if(!queue?.parked.size)return;
  if(queue.generation!==databaseGeneration()){queue.parked.clear();return;}
  for(const [key,item] of queue.parked) {
    if(limit--<=0)break;
    queue.parked.delete(key);
    if(!queue.waiting.has(key))queue.waiting.set(key,item);
  }
  scheduleContextQueue(db,queue);
}
function scheduleContextQueue(db:DatabaseSync,queue:ContextQueue):void {
  if(queue.scheduled)return;
  queue.scheduled=true;
  // Context steps run under their own source, never the route that queued them (a timer or immediate inherits its creator's context).
  const advance=()=>ioBudget.withSource('recall-build',()=>{
    if(queue.generation!==databaseGeneration()) {for(const items of [queue.waiting,queue.speculative,queue.parked]){for(const entry of items.values())entry.steps?.return(undefined);items.clear();}queue.scheduled=false;return;}
    const items=queue.waiting.size?queue.waiting:queue.speculative;
    const next=items.entries().next();
    if(next.done){queue.scheduled=false;return;}
    const [key,item]=next.value;
    contextStepIdle=false;
    try {
      // Presentation saves also advance the roster revision. Cancel the old proof,
      // but retain this demand under the live revision even when no structural
      // publication follows that save. Every fence still applies to the new proof.
      if(item.revision!==item.roster.memoryRosterRevision) {
        item.steps?.return(undefined);
        items.set(key,{binding:item.binding,roster:item.roster,revision:item.roster.memoryRosterRevision!,startup:item.startup});
      } else if(activeBuilds.get(db)?.has(latestBuilds.get(db)?.get(key)??'') && !item.steps){items.delete(key);}
      else if(items===queue.speculative && !item.steps && !db.prepare('SELECT 1 FROM memory_recall_contexts WHERE context_key=?').get(key)
        && Number(db.prepare("SELECT count(*) AS n FROM memory_recall_views v WHERE v.state='building' OR EXISTS(SELECT 1 FROM memory_recall_contexts c WHERE c.view_id=v.view_id AND c.generation=v.generation)").get()!.n)>=127) {
        // Speculation leaves a replacement slot and cannot evict an admitted reader.
        items.delete(key);
      } else if(items===queue.speculative && !item.steps && demandRoom(reclaimState(db))>0) {
        // recallcap-1020-n4a: a demand waiting for room outranks warming too. No speculative build starts while it waits, so the room the
        // reclaimer frees for it is not filled again by rebuilt views; warming resumes once the demand is woken or dropped.
        contextStepIdle=true;
      } else {const current=item;item.steps??=prepareContextSteps(item.binding,item.roster,items===queue.waiting,()=>current.startup===true);if(item.steps.next().done)items.delete(key);}
    } catch(error) {
      item.steps?.return(undefined);items.delete(key);/* Refused until the next demand or structural event. */
      if(error instanceof RecallRoomPending) {
        // Waiting for room is not a refusal: the reader sees "catching up" and the reclaimer asks again once the room exists.
        const demand=reclaimState(db).demands.get(key);if(demand)demand.item={binding:item.binding,roster:item.roster,revision:item.revision};
        clearCapacityRefusal(db,key);again(contextStepIdle);return;
      }
      // A waiting reader's build revoked by a fence move (a turn's own scope insert moves the epoch) asks again under the new fences, at most
      // three times; the new build re-checks every fence from its start, so nothing stale is published.
      if(items===queue.waiting && error instanceof Error && error.message==='MEMORY_CONTEXT_REVOKED' && item.revision===item.roster.memoryRosterRevision
        && databaseGeneration()===queue.generation && (item.retries??0)<3 && !queue.waiting.has(key)) {
        queue.waiting.set(key,{binding:item.binding,roster:item.roster,revision:item.revision,retries:(item.retries??0)+1});
        again(contextStepIdle);return;
      }
      if(error instanceof RecallQuotaRefused && items===queue.waiting) {
        let refused=capacityRefused.get(db);if(!refused)capacityRefused.set(db,refused=new Set());
        refused.add(key);reportMaintenanceError(db,error);again(contextStepIdle);return;
      }
      // A waiting reader refused only because every view is live is parked and marked, never dropped.
      if(items===queue.waiting && isViewCapRefusal(error) && item.revision===item.roster.memoryRosterRevision
        && Number(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n)>=RECALL_VIEW_LIMIT) {
        let refused=capacityRefused.get(db);if(!refused)capacityRefused.set(db,refused=new Set());
        // The oldest parked demand makes room; its mark stays, so its turn still ends on the card and its next ask builds it.
        if(queue.parked.size>=RECALL_VIEW_LIMIT&&!queue.parked.has(key))queue.parked.delete(queue.parked.keys().next().value!);
        refused.add(key);queue.parked.set(key,{binding:item.binding,roster:item.roster,revision:item.revision});
      } else if(items===queue.waiting)clearCapacityRefusal(db,key);
    }
    again(contextStepIdle);
  });
  // A turn is waiting on a waiting demand, so its bounded steps run on the next loop turn even when nothing else
  // wakes the process. Warming and steps that only wait on other work never hold the loop.
  const again=(idle:boolean)=>{const next=setImmediate(advance);if(idle||!queue.waiting.size)next.unref();};
  again(false);
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
        queueRecallContext({botId:bot,threadId:thread,humanPrincipal:threadHumanPrincipal(thread),notOwnerAudience:notOwner},roster,added,startup&&!added);
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
  if(message==='MEMORY_RECALL_RECLAIM_PAUSED') {
    const reclaimCode=String((error as {reclaimCode?:unknown}).reclaimCode??'unexpected storage failure');
    let seen=db?maintenanceWarnings.get(db):undefined;if(db&&!seen)maintenanceWarnings.set(db,seen=new Set());
    if(seen?.has(`reclaim:${reclaimCode}`))return;seen?.add(`reclaim:${reclaimCode}`);
    console.warn(`[memory] recall reclaim paused: ${reclaimCode}`);return;
  }
  // Fixed diagnostics never include stored text, SQL, filenames or bindings.
  const diagnostic=message==='MEMORY_RECALL_STORAGE_LIMIT'?'recall storage quota full':/^SQLITE_[A-Z_]+$/.test(code)?code:'unexpected storage failure';
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
      // The paced reclaimer (recalldesign-1020-n1) frees crash leftovers, superseded, stale, duplicate and (for a waiting demand) cold views. Only
      // when it has nothing to free does the 128-view cap retire one idle context, which the reclaimer then frees, paced.
      if(!recallReclaimStep(db) && storagePressure.has(db))collectRecallViewSlice(db);
      // A lease can end without a release call; upkeep lets the oldest parked reader ask again (one per tick).
      wakeParkedContexts(db,1);
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
      return !victim;
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

// ---- Recall storage reclaimer (recalldesign-1020-n1). Owner of the reclaimer, its pacing and witnesses: recallcap-1020-n3c; owner of the
// recall-reclaim admission class: recallcap-1020-n3c (server/io-budget.ts); publication and authority fences: recall-scope, unchanged.
// It runs only from the maintenance timer, inside its own io source, and only ever deletes DERIVED rows of an idle victim view
// (section 1): never owner truth, never memory_recall_excluded, the epoch or the roster proof, never the change journal.
export const RECALL_QUOTA_BYTES=536_870_912;
export const RECALL_RECLAIM_HEADROOM=4*1024*1024;
const RECLAIM_PRESSURE=0.75;
const limits={quota:RECALL_QUOTA_BYTES,headroom:RECALL_RECLAIM_HEADROOM};
/** Admission arithmetic only (the storage triggers keep the 536,870,912 ceiling): lets a small fixture stand for a full store. */
export function setRecallReclaimLimitsForTest(value?:{quota:number;headroom:number}):void {limits.quota=value?.quota??RECALL_QUOTA_BYTES;limits.headroom=value?.headroom??RECALL_RECLAIM_HEADROOM;}
export function recallReclaimDemandsForTest(db:DatabaseSync):string[] {return [...reclaimState(db).demands.keys()];}
const RECLAIM_SLICE_MIN=128,RECLAIM_SLICE_MAX=8192;
/** One tick takes slices for at most this long; a send waits behind at most one tick, never behind a whole victim. */
const RECLAIM_TICK_MS=60;
/** Burst room of the 700 MB/min bucket (5 s of refill). A slice dearer than the room runs only from a full bucket, so a minute never passes room + refill. */
const RECLAIM_BUCKET_ROOM=RECALL_RECLAIM_BYTES_PER_MINUTE/12;
const RECLAIM_MINUTE_YIELD_BYTES=300_000_000;
export type RecallReclaimClass='A'|'B'|'C'|'D'|'E';
/** Derived tables in reclaim order, each with the key its slice deletes by (section 3 step 2). */
const RECLAIM_TABLES:ReadonlyArray<readonly [string,string]>=[['memory_recall_view_terms','term,sequence,record_id,version'],['memory_recall_view_records','record_id,version'],
  ['memory_recall_view_pending','sequence,record_id,version'],['memory_recall_view_jobs','sequence,job_id'],['memory_recall_view_scopes','scope_id'],
  ['memory_recall_thread_readers','view_id'],['memory_recall_contains','prior_view_id,prior_generation']];
interface Victim {viewId:string;generation:string;cls:RecallReclaimClass;keeper?:{viewId:string;generation:string};table:number;marked:boolean}
interface RoomDemand {bytes:number;epoch:number;revision:number;item?:QueuedContext}
interface ReclaimState {slice:number;tokens:number;refilledAt:number;lastCost:number;pausedUntil:number;demanded:number;minute:number;minuteBase:number;lastWritten:number;victim?:Victim;demands:Map<string,RoomDemand>;woken:Set<string>;quotaRefused:Map<string,{epoch:number;revision:number;inUse:number}>}
export interface RecallReclaimEvent {kind:'mark'|'slice'|'drop'|'busy'|'refuse'|'wait'|'adopt'|'admit'|'wal'|'yield';cls?:RecallReclaimClass;viewId?:string;table?:string;rows?:number;holdMs?:number;source?:string;bytes?:number;free?:number}
const reclaimStates=new WeakMap<DatabaseSync,ReclaimState>();
const reclaimListeners=new Set<(event:Readonly<RecallReclaimEvent>)=>void>();
/** Views a reader was issued since boot (class E: never read since boot goes first). */
const readSinceBoot=new Set<string>();
interface ReclaimClock {now():number;written():number;wal?:()=>{size:number;backlog:number}|null}
const processClock:ReclaimClock={wal:()=>walBacklog(),now:()=>Date.now(),written:()=>{const reading=readProcess();return Math.max(reading.fsWriteBlocks*BLOCK_BYTES,reading.meterBytes??0);}};
let reclaimClock=processClock;
/** Tests inject a clock and a write meter (W10); production measures the process's OS write bytes, which can only over-count. */
export function setRecallReclaimClockForTest(clock?:ReclaimClock):void {reclaimClock=clock??processClock;lastRestartAt=-Infinity;walNudgeAt=-Infinity;}
export function subscribeRecallReclaim(listener:(event:Readonly<RecallReclaimEvent>)=>void):()=>void {reclaimListeners.add(listener);return ()=>reclaimListeners.delete(listener);}
function reclaimEvent(event:RecallReclaimEvent):void {for(const listener of reclaimListeners){try{listener(event);}catch{/* a listener never changes a reclaim */}}}
function reclaimState(db:DatabaseSync):ReclaimState {
  let state=reclaimStates.get(db);
  if(!state)reclaimStates.set(db,state={slice:1024,tokens:RECLAIM_BUCKET_ROOM,refilledAt:reclaimClock.now(),lastCost:0,pausedUntil:0,demanded:0,minute:-1,minuteBase:0,lastWritten:0,demands:new Map(),woken:new Set(),quotaRefused:new Map()});
  return state;
}
export function recallStorageBytes(db:DatabaseSync):number {return Number(db.prepare('SELECT bytes FROM memory_recall_storage WHERE id=1').get()?.bytes??0);}
function reclaimIdle(db:DatabaseSync,viewId:string,contextKeys:readonly string[]=[]):boolean {
  if(activeBuilds.get(db)?.has(viewId) || hydratingViews.get(db)?.has(viewId) || hasActiveReader(db,viewId))return false;
  return contextKeys.every(key=>!hasActiveReader(db,viewId,key));
}
function viewContextKeys(db:DatabaseSync,viewId:string,generation:string):string[] {
  return db.prepare('SELECT context_key FROM memory_recall_contexts WHERE view_id=? AND generation=?').all(viewId,generation).map(row=>String(row.context_key));
}
/** Charged bytes of one view (the storage triggers' arithmetic), counted over its key prefix. */
function chargedViewBytes(db:DatabaseSync,viewId:string,generation:string):number {
  let bytes=Number(db.prepare('SELECT coalesce(sum(512+4*length(CAST(term AS BLOB))),0) AS n FROM memory_recall_view_terms WHERE view_id=? AND generation=?').get(viewId,generation)!.n);
  for(const [table] of RECLAIM_TABLES.slice(1))if(table!=='memory_recall_thread_readers')bytes+=512*Number(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE view_id=? AND generation=?`).get(viewId,generation)!.n);
  return bytes;
}
/** Bytes of views that are not eligible (live reader, build, hydration, issued lease), other than `except`. */
function inUseBytes(db:DatabaseSync,except?:string):number {
  let bytes=0;
  for(const row of db.prepare('SELECT view_id,generation FROM memory_recall_views').all()) {
    const id=String(row.view_id);
    if(id!==except && !reclaimIdle(db,id,viewContextKeys(db,id,String(row.generation))))bytes+=chargedViewBytes(db,id,String(row.generation));
  }
  return bytes;
}
/** Two ready views serve the same readers only when every input of their contents is equal: the digest covers the scope set, the lineage
 * set and room_reader; the person flags and thread recall are not in it, so they are compared here (DESIGN section 2, builder check). */
function sameContents(db:DatabaseSync,a:{viewId:string;generation:string},b:{viewId:string;generation:string}):boolean {
  const eligible=(view:{viewId:string;generation:string})=>db.prepare('SELECT eligible FROM memory_recall_thread_readers WHERE view_id=? AND generation=?').get(view.viewId,view.generation)?.eligible;
  if(eligible(a)===undefined || Number(eligible(a))!==Number(eligible(b)))return false;
  return !db.prepare(`SELECT 1 FROM memory_recall_view_scopes x WHERE x.view_id=?1 AND x.generation=?2 AND NOT EXISTS(SELECT 1 FROM memory_recall_view_scopes y
    WHERE y.view_id=?3 AND y.generation=?4 AND y.scope_id=x.scope_id AND y.lineage_only=x.lineage_only AND y.person_scope=x.person_scope) LIMIT 1`).get(a.viewId,a.generation,b.viewId,b.generation)
    && !db.prepare(`SELECT 1 FROM memory_recall_view_scopes x WHERE x.view_id=?3 AND x.generation=?4 AND NOT EXISTS(SELECT 1 FROM memory_recall_view_scopes y
    WHERE y.view_id=?1 AND y.generation=?2 AND y.scope_id=x.scope_id) LIMIT 1`).get(a.viewId,a.generation,b.viewId,b.generation);
}
const READY_KEYED=`SELECT view_id,generation,digest,scope_count,room_reader,authority_epoch,watermark FROM memory_recall_views
  WHERE state='ready' AND scope_count>0 AND authority_epoch=(SELECT epoch FROM memory_recall_epoch WHERE id=1) AND watermark>=(SELECT projection_floor FROM memory_recall_epoch WHERE id=1)`;
/** The next victim, cheapest waste first: A crash leftovers < B superseded < C stale authority < D duplicates < E cold. A and B always go; C and D
 * are pure waste cleared over 75% of the quota or for a demand (DESIGN section 2); E runs only for a waiting demand that fits. */
export function chooseRecallReclaimVictim(db:DatabaseSync,demand:boolean,pressure:boolean):Victim|undefined {
  const views=db.prepare('SELECT view_id,generation,state,authority_epoch,EXISTS(SELECT 1 FROM memory_recall_contexts c WHERE c.view_id=v.view_id AND c.generation=v.generation) AS bound FROM memory_recall_views v ORDER BY view_id,generation').all();
  const victim=(row:Record<string,unknown>,cls:RecallReclaimClass):Victim=>({viewId:String(row.view_id),generation:String(row.generation),cls,table:0,marked:cls==='A'});
  for(const row of views)if(row.state==='building' && reclaimIdle(db,String(row.view_id)))return victim(row,'A');
  for(const row of views)if(row.state==='ready' && !Number(row.bound) && reclaimIdle(db,String(row.view_id)))return victim(row,'B');
  // C and D clear while the store is over 75% of its quota or a demand waits. Below that a stale context stays persisted and refused (the
  // start-up sweep never rebuilds it) and duplicates keep their own publications.
  if(!pressure)return undefined;
  const epoch=recallAuthorityEpoch(db);
  for(const row of views)if(row.state==='ready' && Number(row.authority_epoch)!==epoch && reclaimIdle(db,String(row.view_id),viewContextKeys(db,String(row.view_id),String(row.generation))))return victim(row,'C');
  const keyed=db.prepare(`${READY_KEYED} ORDER BY digest,scope_count,room_reader,watermark DESC,view_id`).all();
  for(let i=0;i<keyed.length;i++) {
    const keeper=keyed[i]!,key=(row:Record<string,unknown>)=>`${row.digest}\0${row.scope_count}\0${row.room_reader}`;
    const keep={viewId:String(keeper.view_id),generation:String(keeper.generation)};
    for(let j=i+1;j<keyed.length && key(keyed[j]!)===key(keeper);j++) {
      const loser=keyed[j]!,id=String(loser.view_id);
      if(reclaimIdle(db,id,viewContextKeys(db,id,String(loser.generation))) && sameContents(db,keep,{viewId:id,generation:String(loser.generation)}))return {...victim(loser,'D'),keeper:keep};
    }
  }
  if(!demand)return undefined;
  const order=viewOrder.get(db),cold:Array<{row:Record<string,unknown>;read:number;seq:number;bytes:number}>=[];
  for(const row of views) {
    const id=String(row.view_id);
    if(row.state!=='ready' || !Number(row.bound) || !reclaimIdle(db,id,viewContextKeys(db,id,String(row.generation))))continue;
    cold.push({row,read:readSinceBoot.has(id)?1:0,seq:order?.get(id)??0,bytes:chargedViewBytes(db,id,String(row.generation))});
  }
  cold.sort((a,b)=>a.read-b.read || a.seq-b.seq || b.bytes-a.bytes);
  return cold[0]?victim(cold[0].row,'E'):undefined;
}
/** Section 3 step 1: one small transaction re-checks idle(), takes the victim out of every context (C, E) or re-points its contexts to the
 * keeper (D), and marks it building, so from this commit on assertRecallView refuses it. */
function markVictim(db:DatabaseSync,victim:Victim):boolean {
  return transaction(()=>{
    const row=db.prepare('SELECT state FROM memory_recall_views WHERE view_id=? AND generation=?').get(victim.viewId,victim.generation);
    if(!row || !reclaimIdle(db,victim.viewId,viewContextKeys(db,victim.viewId,victim.generation)))return false;
    if(victim.keeper) {
      if(!db.prepare(`${READY_KEYED} AND view_id=? AND generation=?`).get(victim.keeper.viewId,victim.keeper.generation))return false;
      db.prepare('UPDATE memory_recall_contexts SET view_id=?,generation=? WHERE view_id=? AND generation=?').run(victim.keeper.viewId,victim.keeper.generation,victim.viewId,victim.generation);
    } else db.prepare('DELETE FROM memory_recall_contexts WHERE view_id=? AND generation=?').run(victim.viewId,victim.generation);
    db.prepare("UPDATE memory_recall_views SET state='building' WHERE view_id=? AND generation=?").run(victim.viewId,victim.generation);
    return true;
  },{busyMs:0,op:'recall-reclaim'});
}
/** Section 3 step 2/3: one adaptive slice of the victim's derived rows, or its view row once they are gone. True when the victim is gone. */
function reclaimVictimSlice(db:DatabaseSync,state:ReclaimState,victim:Victim):boolean {
  const started=performance.now();
  let rows=0,table='memory_recall_views';
  const done=transaction(()=>{
    while(victim.table<RECLAIM_TABLES.length) {
      const key=RECLAIM_TABLES[victim.table]![1];
      table=RECLAIM_TABLES[victim.table]![0];
      rows=Number(db.prepare(`DELETE FROM ${table} WHERE view_id=?1 AND generation=?2 AND (${key}) IN (SELECT ${key} FROM ${table} WHERE view_id=?1 AND generation=?2 LIMIT ?3)`).run(victim.viewId,victim.generation,state.slice).changes);
      if(rows>0)return false;
      victim.table++;
    }
    db.prepare('DELETE FROM memory_recall_views WHERE view_id=? AND generation=?').run(victim.viewId,victim.generation);
    return true;
  },{busyMs:0,op:'recall-reclaim'});
  const hold=performance.now()-started;
  if(hold>100)state.slice=Math.max(RECLAIM_SLICE_MIN,state.slice>>1);else if(hold<30)state.slice=Math.min(RECLAIM_SLICE_MAX,state.slice<<1);
  if(done){viewOrder.get(db)?.delete(victim.viewId);reclaimEvent({kind:'drop',cls:victim.cls,viewId:victim.viewId,holdMs:hold,source:ioBudget.currentSource()});}
  else reclaimEvent({kind:'slice',cls:victim.cls,viewId:victim.viewId,table,rows,holdMs:hold,source:ioBudget.currentSource()});
  return done;
}
/** The 700 MB/min bucket, refilled each second. A slice runs only when the bucket holds the last slice's measured cost (or is full). */
function reclaimAdmitted(state:ReclaimState,now:number):boolean {
  const seconds=Math.floor((now-state.refilledAt)/1000);
  if(seconds>0){state.tokens=Math.min(RECLAIM_BUCKET_ROOM,state.tokens+seconds*RECALL_RECLAIM_BYTES_PER_MINUTE/60);state.refilledAt+=seconds*1000;}
  return state.tokens>=Math.min(Math.max(1,state.lastCost),RECLAIM_BUCKET_ROOM);
}
function reclaimCharge(state:ReclaimState,bytes:number,polluted=false):void {
  // The meter counts every write in the process, so a step can be charged for unrelated work (the start-up files worker writes GBs). The debt is
  // floored at one burst room: the reclaimer pauses about 10 s after such a step, never for minutes.
  const cost=Math.max(0,bytes);
  if(!polluted)state.lastCost=cost;
  state.tokens=Math.max(-RECLAIM_BUCKET_ROOM,state.tokens-cost);
  ioBudget.noteBytes(RECALL_RECLAIM_SOURCE,cost);
  // The shared bucket a held log copy is admitted under (admission-shared rule 5) takes the same floored charge, so unrelated metered writes
  // cannot use up the copy's room.
  ioBudget.chargeReclaimBucket(Math.min(cost,RECLAIM_BUCKET_ROOM));
}
/** The reclaimer never feeds the WAL admission gate (assertWalWriteAdmission refuses every write, an owner send's too, while a log of 512 MiB
 *  is not fully copied): no step once the log is within 64 MiB of the gate; journal_size_limit shrinks it again after the off-thread pass. The
 *  pass reports only "fully copied or not", so a smaller log is never held (it cannot close the gate). Found on the owner copy: reclaim deletes
 *  on top of the start-up writes held the gate for minutes. */
// recallcap-1020-n3d: a held log that is FULLY copied only shrinks at the next write (restart, then journal_size_limit truncates it at that
// commit). After an owner turn's copy completes the server goes idle and that write never comes, so the reclaimer stayed held until the next
// turn. It then makes the smallest write it may: one value-identical UPDATE of a derived view row (no triggers, no owner truth, busy timeout
// 0), at most once per 5 s. A reader that stops the restart costs one frame. A log that is not fully copied is never written to.
// recallcap-1020-n4a (Fable review of 892d3e4d6e): ONE settle path, nudgeHeldWal below (settleWal under requestReclaimCopy), plus this restart.
let lastRestartAt=-Infinity;
function reclaimWalHeld(db:DatabaseSync):boolean {
  const wal=reclaimClock.wal?.();
  const held=!!wal && wal.size>=WAL_ADMISSION_BYTES-64*1024*1024;
  if(held)nudgeHeldWal();
  const now=reclaimClock.now();
  if(held && wal.backlog===0 && now-lastRestartAt>=5000) {
    lastRestartAt=now;
    const rows=transaction(()=>{
      const row=db.prepare('SELECT view_id,generation FROM memory_recall_views LIMIT 1').get();
      return row?Number(db.prepare('UPDATE memory_recall_views SET state=state WHERE view_id=? AND generation=?').run(row.view_id,row.generation).changes):0;
    },{busyMs:0,op:'recall-reclaim'});
    reclaimEvent({kind:'wal',rows});
  }
  return held;
}
/** Held at the log gate: asks the existing off-thread pass to copy the whole log and restart it with one tiny frame (settleWal nudge), so the
 *  log shrinks to journal_size_limit without waiting for owner activity. One request in flight and at most one a second (a refused copy answers
 *  at once, and the build loop polls the gate); it never blocks the step. */
let walNudge:Promise<unknown>|undefined,walNudgeAt=-Infinity;
function nudgeHeldWal():void {
  const now=reclaimClock.now();
  if(walNudge || now>=walNudgeAt && now-walNudgeAt<1000)return; // a clock that stepped back never blocks the nudge
  walNudgeAt=now;
  // Fable BLOCK bb30fb1d03: the idle rule refuses this copy outright; asked for here, it is admitted under the reclaimer's own bucket.
  ioBudget.requestReclaimCopy();
  walNudge=settleWal({nudge:true,deadlineAt:Date.now()+5000}).catch(()=>false).finally(()=>{walNudge=undefined;});
}
function demandRoom(state:ReclaimState):number {let most=0;for(const demand of state.demands.values())if(demand.item)most=Math.max(most,demand.bytes+limits.headroom);return most;}
/** One maintenance-timer step of the reclaimer, always under the recall-reclaim source. Returns false when it found nothing to free. */
export function recallReclaimStep(db:DatabaseSync):boolean {
  return ioBudget.withSource(RECALL_RECLAIM_SOURCE,()=>{
    const state=reclaimState(db),now=reclaimClock.now();
    if(now<state.pausedUntil)return true;
    wakeRoomDemands(db,state);
    // recallcap-1020-n4a (Fable review of 892d3e4d6e): a demanded build outranks background reclaim. While one is in flight and no demand is
    // short of room, no victim is chosen, so the bucket and the copy's room (slot 30) are the build's; reclaim resumes when it publishes.
    if(state.demanded>0){const need=demandRoom(state);if(need===0 || limits.quota-recallStorageBytes(db)>=need){reclaimEvent({kind:'yield'});return true;}}
    // A minute whose process writes already passed RECLAIM_MINUTE_YIELD_BYTES holds reclaim after an owner write for the rest of that minute.
    // It reuses the meter readings the slices take (lastWritten), so it never reads the meter itself; a minute with no reading counts 0.
    const minute=Math.floor(now/60_000);
    if(state.minute!==minute){state.minute=minute;state.minuteBase=state.lastWritten;}
    const yieldMs=state.lastWritten-state.minuteBase>RECLAIM_MINUTE_YIELD_BYTES?Math.max(RECALL_RECLAIM_YIELD_MS,now-minute*60_000):RECALL_RECLAIM_YIELD_MS;
    if(ioBudget.ownerWriteQuietMs(now)<yieldMs)return true;
    const tickStart=performance.now();
    try {
      while(performance.now()-tickStart<RECLAIM_TICK_MS) {
        if(!reclaimAdmitted(state,reclaimClock.now()))return true;
        if(reclaimWalHeld(db)){reclaimEvent({kind:'wal'});return true;}
        const used=recallStorageBytes(db),need=demandRoom(state);
        const demand=need>0 && limits.quota-used<need;
        if(!state.victim) {
          state.victim=chooseRecallReclaimVictim(db,demand,used>RECLAIM_PRESSURE*limits.quota || need>0);
          if(!state.victim)return false;
        }
        const victim=state.victim,before=reclaimClock.written();
        if(!victim.marked) {
          if(!markVictim(db,victim)){state.victim=undefined;continue;}
          victim.marked=true;reclaimEvent({kind:'mark',cls:victim.cls,viewId:victim.viewId,source:ioBudget.currentSource()});
        } else if(reclaimVictimSlice(db,state,victim)) {state.victim=undefined;wakeRoomDemands(db,state);}
        const after=reclaimClock.written();state.lastWritten=after;
        reclaimCharge(state,after-before);
      }
      return true;
    } catch(error) {
      if(error instanceof DatabaseBusyError){reclaimEvent({kind:'busy'});return true;}
      state.victim=undefined;state.pausedUntil=reclaimClock.now()+30_000;
      const code=error && typeof error==='object' && 'code' in error && /^SQLITE_[A-Z_]+$/.test(String(error.code))?String(error.code):'unexpected storage failure';
      reportMaintenanceError(db,Object.assign(new Error('MEMORY_RECALL_RECLAIM_PAUSED'),{reclaimCode:code}));
      return true;
    }
  });
}
/** A demand waiting for room asks again only once free >= P + headroom: a build never starts into a known-short store. */
function wakeRoomDemands(db:DatabaseSync,state:ReclaimState):void {
  if(!state.demands.size)return;
  const queue=queued.get(db),free=limits.quota-recallStorageBytes(db),epoch=recallAuthorityEpoch(db);
  for(const [key,demand] of state.demands) {
    // A demand whose fences moved is dropped: the next demand re-computes P under the new epoch and roster.
    if(demand.epoch!==epoch || demand.item && demand.item.roster.memoryRosterRevision!==demand.revision){state.demands.delete(key);continue;}
    if(free<demand.bytes+limits.headroom || !demand.item)continue;
    state.demands.delete(key);
    if(queue && queue.generation===databaseGeneration() && !queue.waiting.has(key)){state.woken.add(key);queue.waiting.set(key,demand.item);scheduleContextQueue(db,queue);}
  }
}
/** A waiting demand whose view does not fit yet: no card, the reader is catching up while the reclaimer frees room. */
export class RecallRoomPending extends Error {constructor(){super('MEMORY_RECALL_ROOM_PENDING');}}
/** A demanded view that cannot fit even after every allowed reclaim (promise 5): refused at once, nothing evicted for it. */
export class RecallQuotaRefused extends Error {constructor(){super('MEMORY_RECALL_STORAGE_LIMIT');}}
/** P (section 4): scope rows, record rows and an estimate of term rows from a sample of the records in scope, at the triggers' charge. */
export function projectedRecallViewBytes(db:DatabaseSync,scopes:readonly string[],lineage:number):number {
  let records=0,sampled=0,terms=0,termBytes=0;
  const count=db.prepare('SELECT count(*) AS n FROM memory_records INDEXED BY memory_records_scope WHERE scope_id=?');
  const sample=db.prepare('SELECT text,kind FROM memory_records INDEXED BY memory_records_scope WHERE scope_id=? LIMIT ?');
  for(const scope of scopes) {
    records+=Number(count.get(scope)!.n);
    if(sampled>=64)continue;
    for(const row of sample.all(scope,64-sampled)) {
      sampled++;
      if(isPipKind(String(row.kind)))continue;
      for(const term of wordTerms(String(row.text))){terms++;termBytes+=512+4*Buffer.byteLength(term);}
    }
  }
  // The word index of a view is bounded (RECALL_VIEW_TERM_BUDGET); only the record rows grow with the thread.
  return 512*(scopes.length+lineage)+512*records+Math.min(RECALL_VIEW_TERM_BUDGET,sampled?Math.ceil(termBytes/sampled*records):0);
}
function adoptableView(build:Build):{viewId:string;generation:string}|undefined {
  const db=build.db,eligible=db.prepare('SELECT eligible FROM memory_recall_thread_readers WHERE view_id=? AND generation=?').get(build.handle.viewId,build.handle.generation)?.eligible;
  const candidates=db.prepare(`${READY_KEYED} AND digest=? AND scope_count=? AND room_reader=? AND view_id<>? ORDER BY watermark DESC,view_id`).all(build.handle.digest,build.scopes.length,build.room?1:0,build.handle.viewId);
  const lineage=new Set(build.lineage),scopes=new Set(build.scopes);
  // As in publishRecallView: a roster object that prepares its own cached context again asks for a fresh generation, so it never adopts the view
  // it already holds (issued cursors of that generation must not survive the rebuild).
  const own=cache(db,build.roster).get(build.key)?.handle;
  for(const row of candidates) {
    const view={viewId:String(row.view_id),generation:String(row.generation)};
    if(own && own.viewId===view.viewId && own.generation===view.generation)continue;
    if(eligible===undefined || Number(db.prepare('SELECT eligible FROM memory_recall_thread_readers WHERE view_id=? AND generation=?').get(view.viewId,view.generation)?.eligible)!==Number(eligible))continue;
    const rows=db.prepare('SELECT scope_id,lineage_only,person_scope FROM memory_recall_view_scopes WHERE view_id=? AND generation=?').all(view.viewId,view.generation);
    if(rows.length!==scopes.size+lineage.size)continue;
    if(rows.every(scope=>{const id=String(scope.scope_id);return Number(scope.lineage_only)?lineage.has(id)&&Number(scope.person_scope)===1:scopes.has(id)&&Number(scope.person_scope)===(build.personScopes.has(id)?1:0);}))return view;
  }
  return undefined;
}
/** Runs once, right after membership: adopt an equal ready view, or check P against the quota and the free room. True when adopted. */
function admitRecallBuild(build:Build,waiting:boolean):boolean {
  const db=build.db,state=reclaimState(db);
  const bytes=projectedRecallViewBytes(db,build.scopes,build.lineage.length),used=recallStorageBytes(db),free=limits.quota-used;
  // Adoption shares one view between contexts of equal membership. It runs on a store under pressure (over 75%, or this view does not fit),
  // where a second copy would cost the room a reader is waiting for; a store with room keeps one publication per context.
  const adopt=used>RECLAIM_PRESSURE*limits.quota || bytes+limits.headroom>free?adoptableView(build):undefined;
  if(adopt){build.adopt=adopt;build.phase='done';reclaimEvent({kind:'adopt',viewId:adopt.viewId});return true;}
  // Speculative warming keeps a half-quota ceiling and never asks for room (it never triggers class E).
  if(!waiting){if(bytes>limits.quota/2 || bytes+limits.headroom>free)throw new Error('MEMORY_RECALL_STORAGE_LIMIT');return false;}
  const inUse=inUseBytes(db,build.handle.viewId);
  if(bytes>limits.quota-inUse){state.quotaRefused.set(build.key,{epoch:build.epoch,revision:build.revision,inUse});reclaimEvent({kind:'refuse',bytes});throw new RecallQuotaRefused();}
  if(bytes+limits.headroom>free){state.demands.set(build.key,{bytes,epoch:build.epoch,revision:build.revision});reclaimEvent({kind:'wait',bytes,free,source:ioBudget.currentSource()});throw new RecallRoomPending();}
  reclaimEvent({kind:'admit',bytes,free,source:ioBudget.currentSource()});
  return false;
}
/** Before any build for a waiting demand: a demand already refused stays refused (no build, no evictions) until the epoch or roster moves or the
 *  bytes in use drop; a demand still waiting for room does not start a second build. */
function recheckRecallDemand(db:DatabaseSync,key:string,revision:number|undefined):void {
  const state=reclaimState(db),refused=state.quotaRefused.get(key);
  if(refused) {
    if(refused.epoch===recallAuthorityEpoch(db) && refused.revision===revision && inUseBytes(db)>=refused.inUse)throw new RecallQuotaRefused();
    state.quotaRefused.delete(key);
  }
  const demand=state.demands.get(key);
  if(demand && demand.epoch===recallAuthorityEpoch(db) && demand.revision===revision && limits.quota-recallStorageBytes(db)<demand.bytes+limits.headroom)throw new RecallRoomPending();
  state.demands.delete(key);
}
/** W4: hold a view as an active build or a hydration, exactly as those paths do. */
export function holdRecallViewForTest(db:DatabaseSync,viewId:string,kind:'build'|'hydrate'):()=>void {
  if(kind==='build'){let set=activeBuilds.get(db);if(!set)activeBuilds.set(db,set=new Set());set.add(viewId);return ()=>set.delete(viewId);}
  let map=hydratingViews.get(db);if(!map)hydratingViews.set(db,map=new Map());map.set(viewId,(map.get(viewId)??0)+1);return ()=>map.delete(viewId);
}
