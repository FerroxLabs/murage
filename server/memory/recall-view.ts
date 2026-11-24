import * as sessionProofSchema from './session-proof-schema.ts';
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
import { BLOCK_BYTES, ioBudget, readProcess, RECALL_RECLAIM_BYTES_PER_MINUTE, RECALL_RECLAIM_SOURCE, RECALL_RECLAIM_YIELD_MS, RECALL_SEED_SOURCE } from '../io-budget.ts';
import { assertHumanPrincipal, threadHumanPrincipal, type HumanPrincipal } from '../human-principals.ts';
import { ensureScope, recallPolicyHeader, recallRosterMatchesPolicySteps, prepareLegacyRecallRosterSteps, type MemoryAccess, type MemoryRoster } from './policy.ts';
import { recallMembershipSteps } from './recall-membership.ts';
import { ConstructionBudget, constructionJson } from './recall-construction.ts';
import { wordTerms } from './postings.ts';
import { sharePreparedAudience } from './audience-cache.ts';
import { isPipKind } from './pip-kinds.ts';
import type { RecallRosterCertificate } from '../store.ts';
import { teamChangeOpen } from '../team-identities.ts';
import { scopeRow } from './scope-id.ts';
import { checkpointFamily } from './checkpoints.ts';
import { hasRecallJournalWake, hasRecallOldScopes, readRecallOldScopes, recallChangeRangePage, recallOldScopeKey, RECALL_UPKEEP_TOPIC, reclaimMark, reclaimTouched, viewsMark, type RecallOldScope, type RecallRangeCursor } from './recall-view-schema.ts';
import { armDeadline, disarmDeadline, errorClass, onWake, raise, setWakeProbe, WAKE_PRIORITY, wakeInstalled } from './wake.ts';
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
/** The builds in flight, for the producers' wait (A10): each holds the journal sequence it has read through. Owner: lane A. */
const runningBuilds=new WeakMap<DatabaseSync,Set<Build>>();
// Timer upkeep must not change a persisted snapshot while hydration compares it.
// Counts also cover independent background preparations of the same candidate.
const hydratingViews=new WeakMap<DatabaseSync,Map<string,number>>();
function activeBuild(build:Build,active:boolean) {let set=activeBuilds.get(build.db);if(!set)activeBuilds.set(build.db,set=new Set());let running=runningBuilds.get(build.db);if(!running)runningBuilds.set(build.db,running=new Set());if(active){set.add(build.handle.viewId);running.add(build);}else {set.delete(build.handle.viewId);running.delete(build);journalRoomChanged(build.db);raise(RECALL_UPKEEP_TOPIC);build.budget.release();wakeParkedContexts(build.db);}}
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
  readers.add(reader);readerEpoch++;
  // DESIGN-B5-PROOF F3: the registry itself holds at most RECALL_LIVE_READERS_MAX entries, issued or not, so a recompute never inspects
  // more, whatever the history. The oldest entry goes (normally a lease on an earlier generation); it gets no recompute, so after the
  // next epoch move its view is stale and refuses: an evicted reader never reads wider.
  if(readers.size>RECALL_LIVE_READERS_MAX)readers.delete(readers.values().next().value!);
  return ()=>{
    if(!readers.delete(reader))return;
    readerEpoch++;
    raise(RECALL_UPKEEP_TOPIC);
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
/** cause18-idleperf: moves when a lease is taken or released, and (the active count) when one ends without its release call. No SQL. */
let readerEpoch=0;
function leaseMark():string {let live=0;for(const reader of activeReaders)if(reader.active())live++;return `${readerEpoch}:${live}`;}
/** What reclaim idleness and every view and context row depend on: this connection's row writes (triggers included), another connection's
 *  commits (PRAGMA data_version on this connection, never the shadowable table form), the leases, and the builds and hydrations in flight. */
function recallChangeMark(db:DatabaseSync):string {
  const writes=Number(db.prepare('SELECT total_changes() AS n').get()!.n),version=Number(db.prepare('PRAGMA data_version').get()!.data_version);
  // the views in flight by id (bounded by the views), so one ending and another starting between two ticks still moves the mark
  const ids=(held:{keys():IterableIterator<string>}|undefined)=>held?[...held.keys()].join(','):'';
  return `${writes}:${version}:${leaseMark()}:${ids(activeBuilds.get(db))}:${ids(hydratingViews.get(db))}`;
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
  scopeAt: number; lineageAt: number; recordBefore: number; jobScopeAt: number; jobSourceAfter: number; jobAfter: number; watermark: number; range?: RangeResume;
  /** Term bytes this build may still write (RECALL_VIEW_TERM_BUDGET): the records phase walks newest first and an older record past the budget
   *  keeps its record row (paged recall still reaches it) without terms. windowed is set once a record went without its terms. */
  termRoom: {left:number;windowed:boolean};
  oracle: Generator<void>;budget:ConstructionBudget;
  verifyAfter:string;verified:number;prior:{view_id:string;generation:string}|undefined;containsAfter:string;containsPrior:boolean;
  phase: 'oracle'|'scopes'|'records'|'jobs'|'changes'|'verify'|'contains'|'done';
  /** cause18e: true while the oracle may still write outside its own fenced transactions (the legacy roster preparation, once per file).
   *  Only then does an oracle slice open a write transaction of its own; see buildRecallViewSlice. */
  oracleTxn: boolean;
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
      scopes:[],lineage:[],personScopes:new Set(),room:false,scopeAt:0,lineageAt:0,recordBefore:Number.MAX_SAFE_INTEGER,jobScopeAt:0,jobSourceAfter:0,jobAfter:0,termRoom:{left:RECALL_VIEW_TERM_BUDGET,windowed:false},
      watermark:Number(db.prepare('SELECT coalesce(max(sequence),0) AS n FROM memory_recall_changes').get()!.n),phase:'oracle',oracleTxn:!!recallPolicyHeader()?.legacy,oracle:undefined!,budget:new ConstructionBudget(true)};
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
  // cause18e: every oracle write is one fenced write transaction of its own (a savepoint while a slice transaction is open). The fence is
  // re-read inside it, so the write and the fence it moves commit together or not at all, exactly as when the slice held the lock.
  const fenced=<T>(write:()=>T):T=>transaction(()=>{
    fence(build);const result=write();build.epoch=recallAuthorityEpoch(build.db);
    build.db.prepare('UPDATE memory_recall_views SET authority_epoch=? WHERE view_id=? AND generation=?').run(build.epoch,build.handle.viewId,build.handle.generation);
    return result;
  },{ busyMs: BACKGROUND_BUSY_MS, op: 'recall-view' });
  const advance=(write:()=>void)=>{fenced(write);};
  // The legacy preparation (a file whose roster binding predates partition facts; once per file) also writes between its steps (receipt
  // revokes, the roster proof), so its slices keep their transaction: startBuild set oracleTxn from the same header. A header that reads
  // legacy only now ends this slice first (buildRecallViewSlice stops a slice whose transaction mode changed), so the preparation's
  // first step already runs inside the next slice's transaction; no yield lies between its own header read and that step.
  if(!build.oracleTxn && recallPolicyHeader()?.legacy){build.oracleTxn=true;yield;}
  yield* prepareLegacyRecallRosterSteps(build.roster,budget,advance);
  // From here on the oracle writes only through `fenced`, and a slice of pure reads opens no transaction.
  build.oracleTxn=false;
  if(!(yield* recallRosterMatchesPolicySteps(build.roster,budget)))throw new RecallPreparationPending();
  const result=yield* recallMembershipSteps(build.db,build.binding,build.roster,budget,(kind,key)=>{
    fence(build);
    // A scope that exists is a read: nothing is written and the fence stays where fence() just proved it (it used to rewrite the view row
    // with the same epoch for every scope of the roster, inside a write transaction per 256 steps).
    const known=scopeRow(build.db,kind,key);
    if(known)return String(known.id);
    // Only this exact, transactional scope ensure may advance the construction fence.
    return fenced(()=>ensureScope(kind,key));
  });
  if(result.scopes.length+result.lineage.length>200_000)throw new Error('MEMORY_RECALL_STORAGE_LIMIT');
  build.scopes=result.scopes;build.lineage=result.lineage;build.personScopes=result.personScopes;build.room=result.room;
  const hash=createHash('sha256');for(const bytes of constructionJson([build.scopes,build.lineage,build.room])){hash.update(bytes);yield;}
  build.handle=Object.freeze({...build.handle,digest:hash.digest('hex')});
  // The oracle's result lands in one transaction: the reader row and the view's membership digest (no one reads a building view's rows).
  fenced(()=>{
    build.db.prepare('INSERT INTO memory_recall_thread_readers VALUES(?,?,?)').run(build.handle.viewId,build.handle.generation,result.threadRecall?1:0);
    build.db.prepare("UPDATE memory_recall_views SET scope_count=?,digest=?,room_reader=? WHERE view_id=? AND generation=? AND state='building'")
      .run(build.scopes.length,build.handle.digest,build.room?1:0,build.handle.viewId,build.handle.generation);
  });
}

function fence(build: Build): void {
  if (latestBuilds.get(build.db)?.get(build.key)!==build.handle.viewId || databaseGeneration()!==build.databaseGeneration || build.roster.memoryRosterRevision!==build.revision || build.watermark<Number(build.db.prepare('SELECT projection_floor FROM memory_recall_epoch WHERE id=1').get()!.projection_floor) || recallAuthorityEpoch(build.db)!==build.epoch) throw new Error('MEMORY_CONTEXT_REVOKED');
}
/** MAIN 1.0.20 ruling (recallcap-1020-n5b): a view is bounded for big threads. Its word index holds the newest records within this many term bytes
 *  (charged as projectedRecallViewBytes charges them); older records keep their record rows, so eligible/recent paging still reaches them, and
 *  the view carries RECALL_VIEW_WINDOW_TERM so a word search on it says it read only the newest window (bounded). The 512 MiB quota is unchanged. */
export const RECALL_VIEW_TERM_BUDGET=64*1024*1024;
export const RECALL_VIEW_WINDOW_TERM='\u0000window';
/** memv2 lane A (A5, MISSED 3, F20). Terms are written for live states only (`active`, `candidate`): a superseded or archived version
 *  keeps its view row and loses its terms, in the change that makes it dead (compare before write removes them) and, for versions
 *  that were dead before this build, in the paced pass recallDeadTermsStep (migration M4). Readers: every search but the historical
 *  one skips dead rows at read time (recall-view-index.ts VIEW_LIVE_TERM_PAGE_SQL), so recall is right before that pass has finished;
 *  the historical word search reads the words of dead versions from their text, bounded by its work budget (lexicalViewPage). */
export const RECALL_TERM_STATES:ReadonlySet<string>=new Set(['active','candidate']);
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
  if(!isPipKind(String(row.kind)) && !rolled && RECALL_TERM_STATES.has(String(row.state))) {
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
export const RECALL_BUILD_SLICE=256;
// mem-f1 (MEMAUDIT F1, 1.0.21): what a change row costs follows the views that read its conversation, never the number of views.
interface PageView { view: RecallViewHandle }
const pageKey=(view:{viewId:string;generation:string})=>`${view.viewId}\0${view.generation}`;
const viewList=(views:readonly PageView[])=>JSON.stringify(views.map(item=>[item.view.viewId,item.view.generation]));
const LISTED="SELECT CAST(json_extract(value,'$[0]') AS TEXT),CAST(json_extract(value,'$[1]') AS TEXT)";
/** The listed views that hold `scope` with full reach, from the reverse index: one read, whatever the number of views. */
function scopeHolders(db: DatabaseSync,scope: string,memo: Map<string,Set<string>>): Set<string> {
  let holders=memo.get(scope);
  if(!holders)memo.set(scope,holders=new Set(db.prepare('SELECT view_id,generation FROM memory_recall_view_scopes WHERE scope_id=? AND lineage_only=0').all(scope)
    .map(row=>pageKey({viewId:String(row.view_id),generation:String(row.generation)}))));
  return holders;
}
/** Every row of one record version leaves the listed views: three statements for all of them (one index seek a view, no row unless held).
 *  This is what projectRecord's three deletes did for a view that does not read the record's scope, so a record that moved, was replaced
 *  or was removed still leaves every view that held it, in the same page. */
function dropRecordFrom(db: DatabaseSync,views: readonly PageView[],id: string,version: number): void {
  if(!views.length)return;
  const list=viewList(views);
  for(const table of ['memory_recall_view_terms','memory_recall_view_records','memory_recall_view_pending'])
    db.prepare(`DELETE FROM ${table} WHERE (view_id,generation,record_id,version) IN (${LISTED},?2,?3 FROM json_each(?1))`).run(list,id,version);
}
function dropJobFrom(db: DatabaseSync,views: readonly PageView[],id: string): void {
  if(views.length)db.prepare(`DELETE FROM memory_recall_view_jobs WHERE (view_id,generation,job_id) IN (${LISTED},?2 FROM json_each(?1))`).run(viewList(views),id);
}
/** What a view that reads the record's scope must hold for one record version, read once for all views (projectRecord's own rules). */
interface RecordFacts { id: string; version: number; scope?: string; record?: {seq:number;kind:string;pinned:number;state:string;scope:string}; terms: ()=>string[]; pending?: number }
const NO_TERMS=():string[]=>[];
function recordFacts(db: DatabaseSync,id: string,version: number): RecordFacts {
  const row=db.prepare(`SELECT rowid AS seq,scope_id,text,kind,owner_pinned,state FROM memory_records WHERE id=? AND version=?`).get(id,version);
  if(!row)return {id,version,terms:NO_TERMS};
  const facts:RecordFacts={id,version,scope:String(row.scope_id),terms:NO_TERMS};
  const head=row.kind==='checkpoint'?checkpointFamily(db,id):undefined;
  if(head && (head.state!=='active'||head.record_id!==id||head.record_version!==version))return facts;
  facts.record={seq:Number(row.seq),kind:String(row.kind),pinned:Number(row.owner_pinned),state:String(row.state),scope:String(row.scope_id)};
  const rolled=row.kind==='checkpoint' && row.state!=='active' && !!db.prepare('SELECT 1 FROM memory_records WHERE id=? AND version>? LIMIT 1').get(id,version);
  // The words are cut only when a view that reads the record asks for them, once for all such views.
  if(!isPipKind(String(row.kind)) && !rolled && RECALL_TERM_STATES.has(String(row.state))){let cut:string[]|undefined;facts.terms=()=>cut??=termCost(String(row.text)).terms;}
  const receipt=db.prepare('SELECT rowid AS seq,lexical_status FROM memory_projection_receipts WHERE record_id=? AND record_version=?').get(id,version);
  if (receipt && (!isPipKind(String(row.kind)) || receipt.lexical_status==='delete-pending') && ['pending','pending-archive','delete-pending'].includes(String(receipt.lexical_status)))facts.pending=Number(receipt.seq);
  return facts;
}
/** One record version in one view after a change row: the same rows projectRecord leaves, written only where the view differs. A record is
 *  journaled three times as it is made (the record, its receipt, the receipt's flip) and its words were deleted and written again each time.
 *  The view's own rows are compared, never assumed: a forget blanks the text of the same version in place, and its words must go at once. */
function reprojectRecord(db: DatabaseSync,view: RecallViewHandle,facts: RecordFacts,begin: ()=>void): void {
  const args=[view.viewId,view.generation,facts.id,facts.version] as const;
  const want=facts.record && recallViewHasScope(db,view,facts.record.scope)?facts.record:undefined;
  if(!want) {
    begin();
    db.prepare('DELETE FROM memory_recall_view_terms WHERE view_id=? AND generation=? AND record_id=? AND version=?').run(...args);
    db.prepare('DELETE FROM memory_recall_view_records WHERE view_id=? AND generation=? AND record_id=? AND version=?').run(...args);
    db.prepare('DELETE FROM memory_recall_view_pending WHERE view_id=? AND generation=? AND record_id=? AND version=?').run(...args);
    return;
  }
  const have=db.prepare('SELECT sequence,kind,pinned,state,scope_id FROM memory_recall_view_records WHERE view_id=? AND generation=? AND record_id=? AND version=?').get(...args);
  if(!have || Number(have.sequence)!==want.seq || have.kind!==want.kind || Number(have.pinned)!==want.pinned || have.state!==want.state || have.scope_id!==want.scope) {
    begin();
    if(have)db.prepare('DELETE FROM memory_recall_view_records WHERE view_id=? AND generation=? AND record_id=? AND version=?').run(...args);
    db.prepare('INSERT INTO memory_recall_view_records VALUES(?,?,?,?,?,?,?,?,?)').run(...args,want.seq,want.kind,want.pinned,want.state,want.scope);
  }
  const terms=db.prepare('SELECT term,sequence FROM memory_recall_view_terms WHERE view_id=? AND generation=? AND record_id=? AND version=?').all(...args);
  const cut=facts.terms(),wanted=new Set(cut);
  if(terms.length!==wanted.size || terms.some(row=>Number(row.sequence)!==want.seq || !wanted.has(String(row.term)))) {
    begin();
    if(terms.length)db.prepare('DELETE FROM memory_recall_view_terms WHERE view_id=? AND generation=? AND record_id=? AND version=?').run(...args);
    const add=db.prepare('INSERT INTO memory_recall_view_terms VALUES(?,?,?,?,?,?)');
    for(const term of cut)add.run(view.viewId,view.generation,term,want.seq,facts.id,facts.version);
  }
  // Still written exactly as 1.0.19 writes it (recall-view-schema.ts RECALL_PENDING_OBJECTS).
  const pending=db.prepare('SELECT sequence FROM memory_recall_view_pending WHERE view_id=? AND generation=? AND record_id=? AND version=?').all(...args);
  if(pending.length!==(facts.pending===undefined?0:1) || pending.some(row=>Number(row.sequence)!==facts.pending)) {
    begin();
    if(pending.length)db.prepare('DELETE FROM memory_recall_view_pending WHERE view_id=? AND generation=? AND record_id=? AND version=?').run(...args);
    if(facts.pending!==undefined)db.prepare('INSERT INTO memory_recall_view_pending VALUES(?,?,?,?,?)').run(view.viewId,view.generation,facts.pending,facts.id,facts.version);
  }
}
function reprojectJob(db: DatabaseSync,view: RecallViewHandle,id: string,job: {seq:number;scope:string}|undefined,begin: ()=>void): void {
  const want=job && recallViewHasScope(db,view,job.scope)?job.seq:undefined;
  const have=db.prepare('SELECT sequence FROM memory_recall_view_jobs WHERE view_id=? AND generation=? AND job_id=?').all(view.viewId,view.generation,id);
  if(have.length===(want===undefined?0:1) && have.every(row=>Number(row.sequence)===want))return;
  begin();
  if(have.length)db.prepare('DELETE FROM memory_recall_view_jobs WHERE view_id=? AND generation=? AND job_id=?').run(view.viewId,view.generation,id);
  if(want!==undefined)db.prepare('INSERT INTO memory_recall_view_jobs VALUES(?,?,?,?)').run(view.viewId,view.generation,want,id);
}
// memv2 lane A (A1, G-TURN-SHARED): one change is written to ALL its holders with set statements, so what a change costs in statements
// does not follow the number of views that read it either (the rows do: holders x (terms + 1), the N-1 residual). Each pair is "remove
// what differs, add what is missing", so a holder that already has the row is not written (A4: compare before write, in the statement).
const HOLDERS="(SELECT CAST(json_extract(value,'$[0]') AS TEXT) AS v,CAST(json_extract(value,'$[1]') AS TEXT) AS g FROM json_each(?1)) h";
/** One record version in every listed view (all read its scope): the rows reprojectRecord leaves, in at most six statements. Throws
 *  MEMORY_RECALL_STORAGE_LIMIT when the quota refuses an insert (that statement alone is undone); the caller then writes view by view. */
function reprojectRecordSet(db: DatabaseSync,targets: readonly PageView[],facts: RecordFacts): void {
  if(!targets.length)return;
  const want=facts.record;
  if(!want){dropRecordFrom(db,targets,facts.id,facts.version);return;}
  const list=viewList(targets),key=`(view_id,generation,record_id,version) IN (${LISTED},?2,?3 FROM json_each(?1))`;
  db.prepare(`DELETE FROM memory_recall_view_records WHERE ${key} AND NOT (sequence IS ?4 AND kind IS ?5 AND pinned IS ?6 AND state IS ?7 AND scope_id IS ?8)`)
    .run(list,facts.id,facts.version,want.seq,want.kind,want.pinned,want.state,want.scope);
  db.prepare(`INSERT INTO memory_recall_view_records SELECT h.v,h.g,?2,?3,?4,?5,?6,?7,?8 FROM ${HOLDERS}
    WHERE NOT EXISTS(SELECT 1 FROM memory_recall_view_records r WHERE r.view_id=h.v AND r.generation=h.g AND r.record_id=?2 AND r.version=?3)`)
    .run(list,facts.id,facts.version,want.seq,want.kind,want.pinned,want.state,want.scope);
  const terms=JSON.stringify([...new Set(facts.terms())]);
  db.prepare(`DELETE FROM memory_recall_view_terms WHERE ${key} AND (sequence IS NOT ?4 OR term NOT IN (SELECT CAST(value AS TEXT) FROM json_each(?5)))`).run(list,facts.id,facts.version,want.seq,terms);
  if(terms!=='[]')db.prepare(`INSERT INTO memory_recall_view_terms SELECT h.v,h.g,CAST(t.value AS TEXT),?4,?2,?3 FROM ${HOLDERS},json_each(?5) t
    WHERE NOT EXISTS(SELECT 1 FROM memory_recall_view_terms x WHERE x.view_id=h.v AND x.generation=h.g AND x.record_id=?2 AND x.version=?3 AND x.term=CAST(t.value AS TEXT))`)
    .run(list,facts.id,facts.version,want.seq,terms);
  // Still written exactly as 1.0.19 writes it (recall-view-schema.ts RECALL_PENDING_OBJECTS).
  db.prepare(`DELETE FROM memory_recall_view_pending WHERE ${key} AND sequence IS NOT ?4`).run(list,facts.id,facts.version,facts.pending??null);
  if(facts.pending!==undefined)db.prepare(`INSERT INTO memory_recall_view_pending SELECT h.v,h.g,?4,?2,?3 FROM ${HOLDERS}
    WHERE NOT EXISTS(SELECT 1 FROM memory_recall_view_pending p WHERE p.view_id=h.v AND p.generation=h.g AND p.record_id=?2 AND p.version=?3)`).run(list,facts.id,facts.version,facts.pending);
}
function reprojectJobSet(db: DatabaseSync,targets: readonly PageView[],id: string,job: {seq:number;scope:string}|undefined): void {
  if(!targets.length)return;
  if(!job){dropJobFrom(db,targets,id);return;}
  const list=viewList(targets);
  db.prepare(`DELETE FROM memory_recall_view_jobs WHERE (view_id,generation,job_id) IN (${LISTED},?2 FROM json_each(?1)) AND sequence IS NOT ?3`).run(list,id,job.seq);
  db.prepare(`INSERT INTO memory_recall_view_jobs SELECT h.v,h.g,?3,?2 FROM ${HOLDERS}
    WHERE NOT EXISTS(SELECT 1 FROM memory_recall_view_jobs j WHERE j.view_id=h.v AND j.generation=h.g AND j.job_id=?2)`).run(list,id,job.seq);
}
/** The writes of one change for one view that rides along on another view's page. They are whole or absent: when the recall storage quota
 *  refuses one (MEMORY_RECALL_STORAGE_LIMIT, raised by the storage triggers), that view alone is rolled back to before this change and
 *  leaves the page with its watermark where it was, exactly the view that stalled before. The asked view's own refusal fails its page, as
 *  it always did. A savepoint is opened only when the view really has something to write. */
function rideAlong(db: DatabaseSync,own: boolean,write: (begin:()=>void)=>void): boolean {
  let open=false;
  try {
    write(()=>{if(!own && !open){db.exec('SAVEPOINT recall_ride_along');open=true;}});
    if(open)db.exec('RELEASE recall_ride_along');
    return true;
  } catch(error) {
    if(open && db.isTransaction){try{db.exec('ROLLBACK TO recall_ride_along');db.exec('RELEASE recall_ride_along');}catch{throw error;/* the first error is the one to report */}}
    // cause18d-viewtxn (integrator spec-cand-1021-r8, W-VIEWTXN-ISOLATE): any write error of ONE fleet view that leaves the page's
    // transaction open (the quota's refusal, a constraint, a corrupt row) is that view's alone: it leaves the fleet and catches up (and
    // fails, and is reported) alone, so the other views commit. An error that is the whole page's (BUSY, FULL, the transaction gone, a
    // pending answer) still fails the page.
    if(!own && viewWriteIsolatable(db,error))return false;
    throw error;
  }
}
/** A view's write error that only that view's savepoint has to undo: the transaction is still open and the error is not the store's
 *  (BUSY / LOCKED, FULL, a deferred background budget) nor a pending answer (a preparation, capacity or room the caller waits for). */
const VIEW_ROW_ERRORS=new Set([18,19,20,25]); // SQLITE_TOOBIG, SQLITE_CONSTRAINT, SQLITE_MISMATCH, SQLITE_RANGE: one row's fault
function viewWriteIsolatable(db: DatabaseSync,error: unknown): boolean {
  if(!(error instanceof Error) || !db.isTransaction)return false;
  if(error.message==='MEMORY_RECALL_STORAGE_LIMIT')return true;
  // a store-wide error (I/O, corruption, read-only, memory, interrupt, a lock) would take every view out of the fleet one by one: the page fails
  const code=Number((error as {errcode?: unknown}).errcode);
  return Number.isInteger(code) && VIEW_ROW_ERRORS.has(code&0xff) && errorClass(error)==='other';
}
/** How one page finds the views a change concerns (memv2 lane A, MEMORY-V2-DESIGN 4.2 A1). Absent: one view alone (a build, a view
 *  catching up), which asks its own membership and drops what it does not read, exactly as projectRecord did. Present: the applier's fleet,
 *  every view at the same mark. A change then reaches the views that hold its current scope (the reverse index) and the views that hold a
 *  scope the writer noted it had before (recall-view-schema.ts RECALL_OLD_SCOPE), and costs no other view a statement. A row at or below
 *  `exact` (written before this connection could note anything, or already applied once so its notes are spent), a row whose object is
 *  gone with no note, and a note of an unknown scope take the old behaviour once: the key is removed from every view of the page. */
interface FleetRoute { exact: number; routed: boolean; leave: (target: PageView) => void; loaded?: { notes: Map<string,RecallOldScope[]>; anyJob: boolean } }
/** Projections (one record or job into one view that reads it) a fleet page may make before it is cut; the first row is always taken, so
 *  one row read by every view is still one page (the N-1 residual: rows written = holders x (terms + 1)). */
export const RECALL_FLEET_PROJECTIONS=1024;
/** One change page after `after`, applied to `views` (all at `after`), cut as it always was: rows in sequence order until the records they
 * name would pass RECALL_BUILD_SLICE (the first row is always taken; a 'receipts' range row names at most RECALL_CHANGE_SET). A fleet page
 * is also cut before the row that would pass RECALL_FLEET_PROJECTIONS. A fleet view whose write the storage quota refuses is rolled back to
 * before that change and reported by `leave`; the fleet page then undoes the whole page and reads it again without that view, which
 * keeps its rows at the page's start and reads the rows again alone (and stalls alone, as before).
 * The mark moves only past rows fully projected (FIX3-DESIGN). */
/** A3b: where a page stopped inside a 'receipts' range row that is longer than one page. The caller keeps it (the fleet, a build, a view
 *  reading alone) and hands it back; the mark stays before that row until the range is done. Lost with the process: the row is then
 *  read again from its start, to the same result. */
interface RangeResume { sequence: number; after: RecallRangeCursor }
function projectChanges(db: DatabaseSync,views: PageView[],after: number,route?: FleetRoute,resume?: RangeResume): { watermark: number; done: boolean; taken: number; resume?: RangeResume } {
  const rows=db.prepare('SELECT sequence,kind,object_id,version FROM memory_recall_changes WHERE sequence>? ORDER BY sequence LIMIT ?').all(after,RECALL_BUILD_SLICE);
  const memo=new Map<string,Set<string>>();
  let live=[...views],watermark=after,spent=0,projected=0,taken=0;
  for(const row of rows){
    const sequence=Number(row.sequence);
    const piece=row.kind==='receipts'?recallChangeRangePage(db,String(row.object_id),resume?.sequence===sequence?resume.after:undefined):undefined;
    const members=piece?.members;
    const cost=members?members.length:1;
    if(taken && spent+cost>RECALL_BUILD_SLICE)break;
    const items=members?members.map(([id,version])=>({record:recordFacts(db,id,version)}))
      :row.kind==='record'?[{record:recordFacts(db,String(row.object_id),Number(row.version))}]:[{job:String(row.object_id)}];
    const jobs=new Map<string,{seq:number;scope:string}|undefined>();
    // The job ID index keeps replacements bounded; sequence is the original job rowid.
    for(const item of items)if('job' in item){const found=db.prepare('SELECT j.rowid AS seq,s.scope_id FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE j.id=?').get(item.job);
      jobs.set(item.job,found?{seq:Number(found.seq),scope:String(found.scope_id)}:undefined);}
    type Item=(typeof items)[number];
    const scopeOf=(item:Item)=>'job' in item?jobs.get(item.job)?.scope:item.record.scope;
    // One view asks its own membership (reproject does); the fleet asks the reverse index once per scope.
    const holdersOf=(item:Item):PageView[]=>{const scope=scopeOf(item);if(scope===undefined)return [];if(!route)return live;
      const set=scopeHolders(db,scope,memo);return live.filter(target=>set.has(pageKey(target.view)));};
    const held=new Map<Item,PageView[]>();let need=0;
    for(const item of items){const holders=holdersOf(item);held.set(item,holders);need+=holders.length;}
    if(route && taken && projected+need>RECALL_FLEET_PROJECTIONS)break;
    /** The views that may hold rows of this key without reading its scope now. */
    const strangers=(item:Item,holders:PageView[]):PageView[]=>{
      const rest=()=>holders.length===live.length?[]:live.filter(target=>!holders.includes(target));
      if(!route)return rest();
      if(!route.routed || sequence<=route.exact)return rest();
      route.loaded??=readRecallOldScopes(db);
      const kind='job' in item?'job':'record';
      // Every note still held is of a write the fleet has not passed: the views hold the object as it was at the applied mark, and each
      // scope it has left since is noted. A note is used by any row of its object (a row journaled just before the noted write reads the
      // same current facts), and dropping the key from a view that does not read its scope now is right whenever it is done.
      const notes=route.loaded.notes.get('job' in item?recallOldScopeKey('job',item.job,0):recallOldScopeKey('record',item.record.id,item.record.version))??[];
      if((kind==='job' && route.loaded.anyJob) || notes.some(note=>note.scope==='') || (scopeOf(item)===undefined && !notes.length))return rest();
      if(!notes.length)return [];
      const old=new Set<string>();for(const note of notes)for(const key of scopeHolders(db,note.scope,memo))old.add(key);
      return live.filter(target=>old.has(pageKey(target.view)) && !holders.includes(target));
    };
    for(const item of items) {
      const holders=held.get(item)!.filter(target=>live.includes(target)),others=strangers(item,holders);
      if('job' in item)dropJobFrom(db,others,item.job);else dropRecordFrom(db,others,item.record.id,item.record.version);
      let single=holders;
      if(route) {
        // The fleet: every holder in one set of statements. A view whose issued handle was narrowed asks for itself (recallViewHasScope),
        // and so does every holder when the storage quota refuses a set insert: the refused view alone then leaves the fleet.
        single=holders.filter(target=>narrowed.has(viewKey(target.view)));
        const together=single.length?holders.filter(target=>!single.includes(target)):holders;
        // The set is whole or absent: a refusal by the quota in a later statement (the terms, after the record rows went in) undoes the
        // statements before it too, so no holder is left with half a projection behind an old watermark.
        if(together.length) {
          db.exec('SAVEPOINT recall_holder_set');
          try{if('job' in item)reprojectJobSet(db,together,item.job,jobs.get(item.job));else reprojectRecordSet(db,together,item.record);db.exec('RELEASE recall_holder_set');}
          catch(error){
            // (an error that already ended the transaction, BUSY or FULL, took the savepoint with it: the original error is the one reported)
            if(db.isTransaction){try{db.exec('ROLLBACK TO recall_holder_set');db.exec('RELEASE recall_holder_set');}catch{/* the savepoint is gone with its transaction */}}
            // a refusal, or any other error one view's write can raise, is looked at view by view (rideAlong): the view it is leaves
            if(!viewWriteIsolatable(db,error))throw error;single=holders;}
        }
      }
      for(const target of single) {
        const whole=rideAlong(db,!route,begin=>{if('job' in item)reprojectJob(db,target.view,item.job,jobs.get(item.job),begin);else reprojectRecord(db,target.view,item.record,begin);});
        if(!whole){route!.leave(target);live=live.filter(other=>other!==target);}
      }
    }
    // A range with more to read: this piece is applied, the mark stays before the row, and the page ends here.
    if(piece?.next)return { watermark, done: false, taken, resume: { sequence, after: piece.next } };
    spent+=cost;projected+=need;taken++;watermark=sequence;
  }
  return { watermark, done: taken===rows.length && rows.length<RECALL_BUILD_SLICE, taken };
}
// ---- memv2 lane A: one applier, one applied mark (MEMORY-V2-DESIGN 4.2 A2, A3, A6) ----
/** The fleet: the ready views the applier keeps current together. `applied` is the journal sequence every member has fully read; it lives in
 *  memory. A member's persisted `watermark` is a lower bound of it, written lazily: for all members in ONE statement every RECALL_FLUSH_ROWS
 *  applied rows and at a clean stop, and for one view when it is asked for by name. An older build, or this one after a crash, replays
 *  from the persisted watermark and finds only rows that are really unapplied or that apply again to the same result.
 *  `exact` is the highest sequence whose old-scope notes cannot be trusted any more: the journal head when this connection first looked
 *  (rows of an earlier process or build), raised to every mark the fleet has reached (their notes are spent). */
interface FleetMember { view: RecallViewHandle; persisted: number }
interface Fleet { exact: number; applied?: number; members: Map<string,FleetMember>; sinceFlush: number; routed: boolean; woken: boolean; range?: RangeResume; unsettled?: boolean; viewsAt?: number }
export const RECALL_FLUSH_ROWS=4096;
let flushRows=RECALL_FLUSH_ROWS;
export function setRecallFlushRowsForTest(rows?: number): void { flushRows=rows??RECALL_FLUSH_ROWS; }
/** A view further behind the journal head than this when the fleet forms catches up alone, so one old view never makes every view read again. */
export const RECALL_FLEET_WINDOW=2*RECALL_FLUSH_ROWS;
const fleets=new WeakMap<DatabaseSync,Fleet>();
let fleetDb:DatabaseSync|undefined,fleetCloseHooked=false;
const journalHeadOf=(db:DatabaseSync)=>Number(db.prepare('SELECT coalesce(max(sequence),0) AS n FROM memory_recall_changes').get()!.n);
function fleetOf(db: DatabaseSync): Fleet {
  let fleet=fleets.get(db);
  if(!fleet) {
    fleets.set(db,fleet={exact:journalHeadOf(db),members:new Map(),sinceFlush:0,routed:hasRecallOldScopes(db),woken:hasRecallJournalWake(db)});
    fleetDb=db;
    if(!fleetCloseHooked){fleetCloseHooked=true;onDatabaseClose(()=>{const closing=fleetDb;fleetDb=undefined;if(closing)try{flushRecallWatermarks(closing);}catch{/* the persisted watermark stays a lower bound */}});}
  }
  return fleet;
}
/** Exactly what the upkeep would maintain on a view's own tick (assertRecallView: ready, bound to a context, current authority epoch, at or
 *  above the projection floor, the roster policy granted). One statement, whatever the number of views. */
const FLEET_ELIGIBLE=`SELECT v.view_id,v.generation,v.digest,v.watermark FROM memory_recall_views v JOIN memory_recall_epoch e ON e.id=1
    WHERE v.state='ready' AND v.scope_count>0 AND v.authority_epoch=e.epoch AND v.watermark>=e.projection_floor
    AND EXISTS(SELECT 1 FROM memory_recall_contexts c WHERE c.view_id=v.view_id AND c.generation=v.generation)
    AND EXISTS(SELECT 1 FROM memory_scope_bindings WHERE id='memory-roster-policy' AND state='granted')
    ORDER BY v.view_id,v.generation`;
/** A3: every member's persisted watermark moves to the applied mark in one statement. Never a view held by a hydration (it compares its
 *  watermark before and after, hydrateRecallViewSteps); that view left the fleet at the page that found it held. */
function flushStatement(db: DatabaseSync,members: Map<string,FleetMember>,mark: number): FleetMember[] {
  const hydrating=hydratingViews.get(db);
  const due=[...members.values()].filter(member=>member.persisted<mark && !hydrating?.has(member.view.viewId));
  if(due.length)db.prepare(`UPDATE memory_recall_views SET watermark=?2 WHERE state='ready' AND watermark<?2 AND (view_id,generation) IN (${LISTED} FROM json_each(?1))`).run(viewList(due),mark);
  return due;
}
/** A2: the journal is a dirty list, not a history. Rows every valid ready view has read are deleted in a range, right after the flush that
 *  wrote the watermarks and in its transaction, and `projection_floor` is raised to the highest deleted sequence in the same transaction, as
 *  the persisted ring trigger does. So a watermark below a deleted row is always detectably invalid, for this build and for an older one
 *  (every reader tests watermark >= floor; a view AT the floor has read everything deleted). Never deleted: a row above the lowest
 *  watermark of any ready view that is still at or above the floor (in the fleet or not, of the current authority epoch or an older one:
 *  a view behind, or one waiting to be re-stamped after an epoch move, is never thrown away by the trim), a row above `mark`, and the newest row (a build takes max(sequence) as its snapshot). Not at all while a build or a hydration is in flight
 *  (a build's snapshot must stay above the floor; a hydration compares before and after). At most RECALL_TRIM_ROWS rows a call, so a
 *  journal that is long today shrinks by one flush's worth each flush instead of in one statement. Returns the rows deleted. */
export const RECALL_TRIM_ROWS=2*RECALL_FLUSH_ROWS;
export function trimRecallJournal(db: DatabaseSync,mark: number,limit=RECALL_TRIM_ROWS): number { return trimRecallJournalPage(db,mark,limit).deleted; }
/** The same, saying why nothing was deleted: `held` (a build or hydration is in flight: ask again) or nothing left below the mark. */
function trimRecallJournalPage(db: DatabaseSync,mark: number,limit: number): { deleted: number; held: boolean; left: boolean } {
  if(activeBuilds.get(db)?.size || hydratingViews.get(db)?.size)return {deleted:0,held:true,left:true};
  const row=db.prepare(`SELECT (SELECT min(sequence) FROM memory_recall_changes) AS first,(SELECT max(sequence) FROM memory_recall_changes) AS newest,
    (SELECT min(v.watermark) FROM memory_recall_views v JOIN memory_recall_epoch e ON e.id=1 WHERE v.state='ready' AND v.watermark>=e.projection_floor) AS low`).get()!;
  if(row.first===null || row.low===null)return {deleted:0,held:false,left:false};
  const all=Math.min(mark,Number(row.low),Number(row.newest)-1);
  const upto=Math.min(all,Number(row.first)+limit-1);
  if(upto<Number(row.first))return {deleted:0,held:false,left:false};
  const deleted=Number(db.prepare('DELETE FROM memory_recall_changes WHERE sequence<=?').run(upto).changes);
  db.prepare('UPDATE memory_recall_epoch SET projection_floor=?1 WHERE id=1 AND projection_floor<?1').run(upto);
  return {deleted,held:false,left:upto<all};
}
// ---- migration steps of an existing profile (MEMORY-V2-DESIGN section 5; CONTRACT-REQ A from memv2-I). Owner of the step bodies: lane A.
// Owner of the runner, the order, the pace and the cursor rows (`memory-v2:<task>`): lane I, which registers these two with its
// registerMigrationStep. Shape (structural, lane I's MigrationStep): (db, cursor, now) => { cursor, done }: ONE bounded batch inside the
// runner's transaction (no BEGIN here), idempotent from the same cursor.
export interface RecallMigrationResult { cursor: unknown; done: boolean }
/** M3: the long journal of an existing profile. Rows at or below the lowest watermark of the valid ready views (and below the applied
 *  mark when the applier holds one) are deleted in ranges of RECALL_FLUSH_ROWS, the floor raised in the same transaction, the newest
 *  row kept; rows above go through the applier. Not done while a build or hydration holds the trim (the runner asks again) or rows are
 *  left below the mark. The cursor carries nothing the step needs (a restart recomputes the mark); it reports the rows deleted so far. */
export function recallJournalTrimStep(db: DatabaseSync,cursor: unknown,_now?: number): RecallMigrationResult {
  const before=typeof cursor==='object' && cursor!==null && Number.isSafeInteger((cursor as {deleted?:unknown}).deleted)?Number((cursor as {deleted:number}).deleted):0;
  const fleet=fleets.get(db);
  const mark=fleet?.applied!==undefined && fleet.members.size?fleet.applied:Number.MAX_SAFE_INTEGER;
  const page=trimRecallJournalPage(db,mark,RECALL_FLUSH_ROWS);
  return {cursor:{deleted:before+page.deleted},done:!page.held && !page.left};
}
/** M4: the stored terms of versions that were dead before this build wrote terms for live states only. The cursor is a record rowid:
 *  one window of RECALL_DEAD_TERMS_WINDOW record rows above it is read (never a scan for the next dead one), and for each version in
 *  it that is neither active nor candidate its term rows are deleted across every view by the terms' own record index, at most
 *  RECALL_DEAD_TERMS_ROWS rows a batch (a version with more is continued from the same cursor). Terms are derived; recall does not
 *  depend on this pass (the read filter), and the historical search reads dead versions from their text. */
export const RECALL_DEAD_TERMS_WINDOW=256,RECALL_DEAD_TERMS_ROWS=2048;
export function recallDeadTermsStep(db: DatabaseSync,cursor: unknown,_now?: number): RecallMigrationResult {
  let after=typeof cursor==='object' && cursor!==null && Number.isSafeInteger((cursor as {after?:unknown}).after)?Number((cursor as {after:number}).after):0;
  const rows=db.prepare('SELECT rowid AS seq,id,version,state FROM memory_records WHERE rowid>? ORDER BY rowid LIMIT ?').all(after,RECALL_DEAD_TERMS_WINDOW);
  const drop=db.prepare(`DELETE FROM memory_recall_view_terms WHERE (view_id,generation,term,sequence,record_id,version) IN
    (SELECT view_id,generation,term,sequence,record_id,version FROM memory_recall_view_terms INDEXED BY memory_recall_terms_source WHERE record_id=?1 AND version=?2 LIMIT ?3)`);
  let room=RECALL_DEAD_TERMS_ROWS;
  for(const row of rows) {
    if(!RECALL_TERM_STATES.has(String(row.state))) {
      const deleted=Number(drop.run(row.id,row.version,room).changes);
      room-=deleted;
      // The batch is full: this version may have more, so the cursor stays before it.
      if(room<=0)return {cursor:{after},done:false};
    }
    after=Number(row.seq);
  }
  return {cursor:{after},done:rows.length<RECALL_DEAD_TERMS_WINDOW};
}
/** The clean-stop flush (and a test's): outside any transaction, one statement, nothing when every member is already written. */
export function flushRecallWatermarks(db: DatabaseSync): void {
  const fleet=fleets.get(db);
  if(!fleet || fleet.applied===undefined || db.isTransaction)return;
  const mark=fleet.applied;
  if(![...fleet.members.values()].some(member=>member.persisted<mark))return;
  for(const member of flushStatement(db,fleet.members,mark))member.persisted=mark;
  fleet.sinceFlush=0;
}
/** A2: is this view current? One helper for every reader: a fleet member is current when the applied mark has reached the newest journal
 *  row; any other view when its persisted watermark has. (A view that no longer exists is "current": the guarded read refuses it itself.) */
export function recallViewCurrent(db: DatabaseSync,view: {viewId:string;generation:string}): boolean {
  const projection=recallViewProjection(db,view);
  return !projection || projection.watermark>=projection.latest;
}
/** The same answer as figures: the sequence the view has read through (the applied mark for a fleet member, else its persisted
 *  watermark) and the newest journal sequence. Undefined when the view does not exist. */
export function recallViewProjection(db: DatabaseSync,view: {viewId:string;generation:string}): { watermark: number; latest: number }|undefined {
  const fleet=fleets.get(db),latest=journalHeadOf(db);
  if(fleet?.applied!==undefined && fleet.applied>=latest && fleet.members.has(pageKey(view)))return {watermark:fleet.applied,latest};
  const row=db.prepare('SELECT watermark FROM memory_recall_views WHERE view_id=? AND generation=?').get(view.viewId,view.generation);
  return row?{watermark:Number(row.watermark),latest}:undefined;
}
/** For crash witnesses: the process dies here. The applied mark and the members are forgotten without the clean-stop flush, so the
 *  persisted watermarks stay where the last flush left them and the next open starts from them. */
export function forgetRecallFleetForTest(db: DatabaseSync): void { fleets.delete(db);if(fleetDb===db)fleetDb=undefined; }
export function recallAppliedMarkForTest(db: DatabaseSync): { applied: number|undefined; exact: number; members: string[] } {
  const fleet=fleetOf(db);return {applied:fleet.applied,exact:fleet.exact,members:[...fleet.members.values()].map(member=>member.view.viewId)};
}
/** A10 (AF-H8, F19): a producer of bulk journal rows (an index reset, a model adoption, the controller's receipt paging) writes one page
 *  of at most RECALL_CHANGE_SET receipts and then waits here until the journal head is at most RECALL_PRODUCER_ROOM rows above both the
 *  applied mark and the journal position of every build in flight. The ring is 1,000,000 rows, so the floor can never pass a build, and
 *  the applier is never more than this many rows behind a burst. Owner writes never call this.
 *  recallJournalRoom: the test (two O(1) reads at most). whenRecallJournalRoom: resolves when there is room; it is settled by the
 *  applier's own commit or a build's end (no timer). With nobody to wait for (no maintained view and no build, or the applier is not
 *  running in this process) there is room at once: nothing would ever make more. */
export const RECALL_PRODUCER_ROOM=65_536,RECALL_PRODUCER_GIVE_UP_MS=8_000;
let producerRoom=RECALL_PRODUCER_ROOM;
export function setRecallProducerRoomForTest(rows?: number): void { producerRoom=rows??RECALL_PRODUCER_ROOM; }
const roomWaiters=new WeakMap<DatabaseSync,Set<()=>void>>();
export function recallJournalRoom(db: DatabaseSync): boolean {
  // An applier that cannot run on this connection (no wake bus: fleet.woken) or that keeps failing (its retry delay has reached
  // RECALL_PRODUCER_GIVE_UP_MS) holds no producer: the index must go on, and the journal ring (1,000,000 rows) is the bound, as before.
  if(applierOn && (!fleetOf(db).woken || applierRetryMs>=RECALL_PRODUCER_GIVE_UP_MS))return true;
  let low=Infinity;
  for(const build of runningBuilds.get(db)??[])low=Math.min(low,build.watermark);
  if(applierOn) {
    const fleet=fleetOf(db);
    if(fleet.applied!==undefined && fleet.members.size)low=Math.min(low,fleet.applied);
    else if(fleet.unsettled!==false) {
      // No fleet yet (the applier has not run, or its views are behind): the lowest valid ready watermark is what it will start from.
      const row=db.prepare("SELECT min(v.watermark) AS low FROM memory_recall_views v JOIN memory_recall_epoch e ON e.id=1 WHERE v.state='ready' AND v.scope_count>0 AND v.authority_epoch=e.epoch AND v.watermark>=e.projection_floor").get();
      if(row && row.low!==null)low=Math.min(low,Number(row.low));
    }
  }
  return low===Infinity || journalHeadOf(db)-low<=producerRoom;
}
export function whenRecallJournalRoom(db: DatabaseSync): Promise<void> {
  if(recallJournalRoom(db))return Promise.resolve();
  return new Promise(resolve=>{let set=roomWaiters.get(db);if(!set)roomWaiters.set(db,set=new Set());set.add(resolve);raise('journal');});
}
/** Called after every applier commit, at a build's end and at a stop: producers that now have room go on. */
function journalRoomChanged(db: DatabaseSync,all=false): void {
  const set=roomWaiters.get(db);if(!set?.size)return;
  let room=all;
  if(!room)try{room=recallJournalRoom(db);}catch{room=true;}
  if(!room)return;
  roomWaiters.delete(db);for(const resolve of set)resolve();
}
interface FleetPage { done: boolean; joined: boolean; behind: RecallViewHandle[]; held: boolean }
/** One applier page for the whole fleet, in ONE write transaction: one read of who is maintained, one read of the journal, per change one
 *  read of its facts and one scope lookup, writes only where a holder differs. `asked` is the view a caller named: when it is not in the
 *  fleet (it is behind the applied mark, or not maintained) nothing is done here and the caller serves it alone. Read first, lock second:
 *  a fleet with nothing above its mark takes no lock. In-memory marks move only after the commit. */
function applyRecallChanges(db: DatabaseSync,asked?: RecallViewHandle): FleetPage {
  const fleet=fleetOf(db),askedKey=asked?pageKey(asked):undefined;
  const idle=():FleetPage=>({done:true,joined:true,behind:[],held:false});
  // `unsettled`: the last page left a view outside the fleet (behind it, or held by a hydration). The applier's own run then looks at who
  // is maintained again even when the journal has nothing new, so that view is served; a named view of the fleet needs no such look.
  // The same when a view or context row was written since (viewsMark): a view may have become maintainable without a journal row.
  const viewsAt=viewsMark();
  if(fleet.applied!==undefined && fleet.members.size && (askedKey?fleet.members.has(askedKey):!fleet.unsettled && fleet.viewsAt===viewsAt)
    && !db.prepare('SELECT 1 FROM memory_recall_changes WHERE sequence>? LIMIT 1').get(fleet.applied)) {
    // Nothing to apply. A view asked for by name still gets its own watermark written (one row), as it always did.
    const member=askedKey?fleet.members.get(askedKey):undefined,mark=fleet.applied;
    if(member && member.persisted<mark && !hydratingViews.get(db)?.has(member.view.viewId)) {
      db.prepare("UPDATE memory_recall_views SET watermark=? WHERE view_id=? AND generation=? AND state='ready' AND watermark<?").run(mark,member.view.viewId,member.view.generation,mark);
      member.persisted=mark;
    }
    return idle();
  }
  const after:{commit?:()=>void}={};
  const page=transaction(():FleetPage=>{
    const hydrating=hydratingViews.get(db),eligible=new Map<string,FleetMember>();let held=false;
    for(const row of db.prepare(FLEET_ELIGIBLE).all()) {
      if(hydrating?.has(String(row.view_id))){held=true;continue;}
      const view={viewId:String(row.view_id),generation:String(row.generation),digest:String(row.digest)};
      eligible.set(pageKey(view),{view,persisted:Number(row.watermark)});
    }
    const members=new Map<string,FleetMember>();
    for(const [key,member] of fleet.members){const now=eligible.get(key);if(now)members.set(key,{view:member.view,persisted:now.persisted});}
    let applied=members.size?fleet.applied:undefined;
    // A3b: while the fleet is inside a long receipts range, nobody joins it (a newcomer has not read the pieces already done); a view
    // that could join stays behind, reads alone with its own cursor, and joins when the range is over. A fleet that forms anew starts the row.
    const range=applied===undefined?undefined:fleet.range;
    if(applied===undefined) {
      const near=journalHeadOf(db)-RECALL_FLEET_WINDOW,marks=[...eligible.values()].map(item=>item.persisted).filter(mark=>mark>=near);
      if(marks.length)applied=Math.min(...marks);
    }
    if(applied!==undefined && !range)for(const [key,item] of eligible)if(!members.has(key) && item.persisted>=applied)members.set(key,item);
    const behind=[...eligible].filter(([key])=>!members.has(key)).map(([,item])=>item.view);
    const adopt=(mark:number|undefined,taken:number,flushed:FleetMember[],all:boolean,range?:RangeResume)=>{after.commit=()=>{
      fleet.range=range;if(taken || range)reclaimTouched();
      fleet.viewsAt=viewsAt;
      fleet.unsettled=held || behind.length>0;
      fleet.members=members;fleet.applied=members.size?mark:undefined;
      if(mark!==undefined)fleet.exact=Math.max(fleet.exact,mark);
      for(const member of flushed)member.persisted=mark!;
      fleet.sinceFlush=all?0:fleet.sinceFlush+taken;
    };};
    if(applied===undefined) {
      // No view is maintained together (none exists, or none is near the head): nobody will read the notes of the rows written so far.
      // They are dropped here, and those rows become "exact" (asked of every view) for a fleet that forms later, so the TEMP table
      // stays bounded on a machine with no views and a later fleet is never routed by a note that is gone.
      const head=journalHeadOf(db);
      if(fleet.routed)db.prepare('DELETE FROM temp.recall_old_scope WHERE sequence<?').run(head);
      adopt(undefined,0,[],false);const forget=after.commit!;after.commit=()=>{forget();fleet.exact=Math.max(fleet.exact,head);};
      return {done:!askedKey,joined:false,behind,held};
    }
    if(askedKey && !members.has(askedKey)){adopt(applied,0,[],false,range);return {done:false,joined:false,behind,held};}
    // A view the storage quota refuses at ANY insert of this page (the first row or a later one, the record rows or the terms) keeps
    // nothing of the page: the page is undone and read again without it, so its rows are exactly those at the applied mark, and its
    // persisted watermark is written to that mark in this same transaction. A projection and its watermark commit together or not at
    // all (Astra on cdb3e4725f). Each pass removes at least one view, so there are at most members + 1 passes, and only on a refusal.
    const refused=new Set<string>();
    const route:FleetRoute={exact:fleet.exact,routed:fleet.routed,leave:()=>{}};
    let result!:ReturnType<typeof projectChanges>;
    db.exec('SAVEPOINT recall_fleet_page');
    try {
      for(;;) {
        const left:PageView[]=[];route.leave=target=>{left.push(target);};
        const targets=[...members.values()].filter(member=>!refused.has(pageKey(member.view))).map(member=>({view:member.view}));
        result=projectChanges(db,targets,applied,route,range);
        if(!left.length)break;
        db.exec('ROLLBACK TO recall_fleet_page');
        for(const target of left)refused.add(pageKey(target.view));
      }
      db.exec('RELEASE recall_fleet_page');
    } catch(error) {
      if(db.isTransaction)try{db.exec('ROLLBACK TO recall_fleet_page');db.exec('RELEASE recall_fleet_page');}catch{/* gone with its transaction */}
      throw error;
    }
    for(const key of refused) {
      const member=members.get(key)!;members.delete(key);behind.push(member.view);
      if(member.persisted<applied)db.prepare("UPDATE memory_recall_views SET watermark=? WHERE view_id=? AND generation=? AND state='ready' AND watermark<?").run(applied,member.view.viewId,member.view.generation,applied);
    }
    if(result.taken && route.loaded && (route.loaded.notes.size))db.prepare('DELETE FROM temp.recall_old_scope WHERE sequence<?').run(result.watermark);
    // A3: all members every RECALL_FLUSH_ROWS rows; the asked view alone otherwise.
    const mark=result.watermark,asking=askedKey?members.get(askedKey):undefined;
    let flushed:FleetMember[]=[];const all=fleet.sinceFlush+result.taken>=flushRows;
    if(all){flushed=flushStatement(db,members,mark);trimRecallJournal(db,mark);}
    else if(asking && asking.persisted<mark){db.prepare("UPDATE memory_recall_views SET watermark=? WHERE view_id=? AND generation=? AND state='ready' AND watermark<?").run(mark,asking.view.viewId,asking.view.generation,mark);flushed=[asking];}
    adopt(mark,result.taken,flushed,all,result.resume);
    return {done:result.done,joined:true,behind,held};
  }, { busyMs: BACKGROUND_BUSY_MS, op: 'recall-view' });
  after.commit?.();
  journalRoomChanged(db);
  return page;
}
/** cause18e-overbudget (PERF-SPEC 0edba926a6: source recall-build, `COMMIT x9722` at 10 threads and `x22500` at 1000 in the minute the
 *  views were first built): every slice used to be one BEGIN IMMEDIATE ... COMMIT, and the membership oracle is thousands of pure-read steps
 *  (one per roster item, sort move and hashed chunk), so one build took the write lock 47 times at 10 threads and 113 times at 1000, nearly
 *  always to write nothing. Now:
 *   - an oracle slice is still RECALL_BUILD_SLICE steps per event-loop turn, but opens no transaction: the oracle's writes are each their
 *     own fenced transaction (constructMembership `fenced`), and only a scope that does not exist yet writes at all;
 *   - the projection (scopes, records, jobs, changes) shares ONE transaction per slice instead of at least one per phase: one
 *     RECALL_BUILD_SLICE row budget across scopes, records and jobs, then the change page under its own (projectChanges);
 *   - verify and contains only read the build's own rows and open none.
 *  BOUND on write transactions (COMMITs) for one build, startBuild and publishRecallView included (recallBuildCommitBound):
 *      4 + N + floor(R / RECALL_BUILD_SLICE) + floor(S / RECALL_BUILD_SLICE) + C
 *  4 = start, the oracle's result, the first projection slice, publish; N = scopes this build creates (one fenced transaction each);
 *  R = rows projected (view scopes + records + jobs); S = the view's scopes (a jobs page also ends after RECALL_BUILD_SLICE scope seeks);
 *  C = change pages journaled while the build ran. A projection slice ends only when it has spent RECALL_BUILD_SLICE rows or seeks, or has
 *  reached verify. The roster walk is in no term: a build over 10 threads and one over 1000 commit the same number of times for the same
 *  view. The legacy roster preparation (once per file) keeps one transaction per oracle slice, as before, outside this bound.
 *  Every fence is unchanged: each slice starts with fence(), and each transaction re-reads it before its first write. */
export function recallBuildCommitBound(shape:{newScopes:number;rows:number;scopes:number;changePages?:number}):number {
  return 4+shape.newScopes+Math.floor(shape.rows/RECALL_BUILD_SLICE)+Math.floor(shape.scopes/RECALL_BUILD_SLICE)+(shape.changePages??0);
}
/** One bounded projection/membership slice. This is maintenance, never a recall fallback. */
export function buildRecallViewSlice(build: Build): boolean {
  fence(build);
  const {db,handle}=build;
  if(build.phase==='oracle') {
    // a slice keeps the transaction mode it started in: the oracle asking for one (constructMembership) ends the slice
    const mode=build.oracleTxn;
    const steps=()=>{for(let n=0;n<RECALL_BUILD_SLICE;n++){if(build.oracle.next().done){build.phase='scopes';break;}if(!mode&&build.oracleTxn)break;}};
    if(mode){transaction(()=>{fence(build);steps();}, { busyMs: BACKGROUND_BUSY_MS, op: 'recall-view' });}
    else steps();
    // The projection never shares the oracle's slice: admission (admitRecallBuild) is asked between the two.
    return false;
  }
  if(build.phase==='verify') {
    const rows=db.prepare('SELECT scope_id,lineage_only,person_scope FROM memory_recall_view_scopes WHERE view_id=? AND generation=? AND scope_id>? ORDER BY scope_id LIMIT ?').all(handle.viewId,handle.generation,build.verifyAfter,RECALL_BUILD_SLICE);
    const has=(values:string[],scope:string)=>{let a=0,b=values.length;while(a<b){const mid=(a+b)>>>1;if(values[mid]<scope)a=mid+1;else b=mid;}return values[a]===scope;};
    for(const row of rows){const scope=String(row.scope_id);if(!(Number(row.lineage_only)?has(build.lineage,scope):has(build.scopes,scope)) || Number(row.person_scope)!==(build.personScopes.has(scope)?1:0))throw new RecallPreparationPending();build.verified++;build.verifyAfter=scope;}
    if(rows.length<RECALL_BUILD_SLICE){if(build.verified!==build.scopes.length+build.lineage.length)throw new RecallPreparationPending();build.phase='contains';}
    return false;
  }
  if(build.phase==='contains') {
    if(!build.prior)build.phase='done';
    else {
      const rows=db.prepare('SELECT scope_id,lineage_only FROM memory_recall_view_scopes WHERE view_id=? AND generation=? AND scope_id>? ORDER BY scope_id LIMIT ?').all(build.prior.view_id,build.prior.generation,build.containsAfter,RECALL_BUILD_SLICE);
      for(const row of rows){if(Number(row.lineage_only)===0&&!recallViewHasScope(db,handle,String(row.scope_id)))build.containsPrior=false;build.containsAfter=String(row.scope_id);}
      if(!build.containsPrior || rows.length<RECALL_BUILD_SLICE)build.phase='done';
    }
    return build.phase==='done';
  }
  if(build.phase==='done')return true;
  return transaction(()=>{
    fence(build);
    // One row budget for the whole slice: a phase that ends with room left hands the rest to the next phase in the same transaction.
    let left=RECALL_BUILD_SLICE;
    if (build.phase==='scopes') {
      const add=db.prepare('INSERT INTO memory_recall_view_scopes VALUES(?,?,?,?,?)');
      while(left>0 && build.scopeAt<build.scopes.length){const scope=build.scopes[build.scopeAt++];add.run(handle.viewId,handle.generation,scope,0,build.personScopes.has(scope)?1:0);left--;}
      while(left>0 && build.lineageAt<build.lineage.length){add.run(handle.viewId,handle.generation,build.lineage[build.lineageAt++],1,1);left--;}
      if(build.scopeAt===build.scopes.length && build.lineageAt===build.lineage.length)build.phase='records';
    }
    if (left>0 && build.phase==='records') {
      const rows=db.prepare(`SELECT r.rowid AS seq,r.id,r.version FROM memory_recall_view_scopes v JOIN memory_records r INDEXED BY memory_records_scope ON r.scope_id=v.scope_id WHERE v.view_id=? AND v.generation=? AND v.lineage_only=0 AND r.rowid<? ORDER BY r.rowid DESC LIMIT ?`).all(handle.viewId,handle.generation,build.recordBefore,left);
      for(const row of rows){projectRecord(db,handle,String(row.id),Number(row.version),build.termRoom);build.recordBefore=Number(row.seq);}
      if(rows.length<left)build.phase='jobs';
      left-=rows.length;
    }
    if (left>0 && build.phase==='jobs') {
      // reclaim-1020-n2: only the reader's own jobs, reached through its scopes (memory_sources_scope, then the jobs' source key). Walking every
      // job on the machine and dropping the ones outside the view made each rebuild after an epoch move (a revoke, an import, a routine turn's
      // fence) cost one lookup and one delete per job in history: 397,432 a minute and 9457.9 MB/min of recall-reclaim on the owner copy.
      // A scope with no jobs costs one seek; a page holds at most RECALL_BUILD_SLICE jobs and scopes.
      const page=db.prepare(`SELECT s.rowid AS src,j.rowid AS seq,j.id FROM memory_sources s JOIN memory_jobs j ON j.source_id=s.id
        WHERE s.scope_id=? AND s.rowid>=? AND (s.rowid>? OR j.rowid>?) ORDER BY s.rowid,j.rowid LIMIT ?`);
      const add=db.prepare('INSERT OR IGNORE INTO memory_recall_view_jobs VALUES(?,?,?,?)');
      let seeks=0;
      while(left>0 && seeks++<RECALL_BUILD_SLICE && build.jobScopeAt<build.scopes.length){
        const rows=page.all(build.scopes[build.jobScopeAt],build.jobSourceAfter,build.jobSourceAfter,build.jobAfter,left);
        for(const row of rows){add.run(handle.viewId,handle.generation,row.seq,String(row.id));build.jobSourceAfter=Number(row.src);build.jobAfter=Number(row.seq);}
        left-=rows.length;
        if(left>0){build.jobScopeAt++;build.jobSourceAfter=0;build.jobAfter=0;}
      }
      if(build.jobScopeAt>=build.scopes.length)build.phase='changes';
      // a page cut by its seek bound ends the slice (the bound is per slice)
      else left=0;
    }
    if (left>0 && build.phase==='changes') {
      const page=projectChanges(db,[{view:handle}],build.watermark,undefined,build.range);
      build.watermark=page.watermark;build.range=page.resume;
      if(page.done)build.phase='verify';
    }
    return false;
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
    // reclaim-1020-n3 (FINAL6 storm 2300Z): a stale epoch alone no longer rebuilds. Every new thread (a scheduled routine run) binds its human
    // principal, which moves the one global epoch, and each context then rebuilt its whole history (records, terms, jobs) at once. A view
    // whose ONLY difference is the epoch, bound by this context alone, passes the same membership proof below under the current epoch and
    // certificate, and is re-stamped in the final transaction: work bounded by its membership, never by history. Any membership, room,
    // eligibility or digest difference still rebuilds; a view another context also holds is never re-stamped (that context may have narrowed).
    const restamp=!!row && Number(row.authority_epoch)!==epoch;
    if(!row || row.state!=='ready' || restamp && Number(db.prepare('SELECT count(*) AS n FROM memory_recall_contexts WHERE view_id=? AND generation=?').get(row.view_id,row.generation)!.n)!==1
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
      if(restamp && (Number(db.prepare('SELECT count(*) AS n FROM memory_recall_contexts WHERE view_id=? AND generation=?').get(row.view_id,row.generation)!.n)!==1
        || Number(db.prepare("UPDATE memory_recall_views SET authority_epoch=? WHERE view_id=? AND generation=? AND state='ready' AND authority_epoch=?").run(epoch,row.view_id,row.generation,row.authority_epoch).changes)!==1))
        throw new RecallPreparationPending();
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
  // cause18e: a context that has no publication yet (first start over existing history) builds under the named one-time seed source
  // (io-budget.ts IO_SEED_BUDGETS: reported on its own line, bounded per process), ONCE per context key in this process: a context the
  // reclaimer retired and a reader demands again has no row either, and that churn is `recall-build`, judged against the minute like every
  // rebuild of a context that has a publication. The reclaimer's bucket and pacing are the same for all of them.
  let seededKeys=seeded.get(db);if(!seededKeys)seeded.set(db,seededKeys=new Set());
  const first=!prior && !paced && !seededKeys.has(key);
  // every build of a key is remembered, a rebuild's too: whatever this process built once is never seed again
  if(!seededKeys.has(key)){if(seededKeys.size>=4096)seededKeys.clear();seededKeys.add(key);}
  const sourced=<T>(run:()=>T):T=>paced?ioBudget.withSource(RECALL_RECLAIM_SOURCE,run):first?ioBudget.withSource(RECALL_SEED_SOURCE,run):run();
  const build=sourced(()=>startBuild(binding,roster,waiting));activeBuild(build,true);
  // recallcap-1020-n4a (Fable review of 892d3e4d6e): a demanded build (woken, or a waiting reader's) outranks background reclaim; the
  // reclaimer frees nothing while one is in flight and no demand is short of room (recallReclaimStep).
  const demanded=waiting || paced;
  if(demanded)reclaim.demanded++;
  try {
    let admitted=false;
    for(;;) {
      const before=reclaimClock.written(),turnOpen=ioBudget.ownerWriteOpen();
      const done=sourced(()=>buildRecallViewSlice(build));
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
    sourced(()=>publishRecallView(build));
  }
  finally {activeBuild(build,false);if(demanded)reclaim.demanded--;}
  if(reclaimed)for(let slice=0;slice<RECLAIM_SLICES_PER_TICK&&!collectRecallViewSlice(db);slice++)yield;
}
export async function prepareRecallContext(botId: string,threadId: string,roster: MemoryRoster,notOwnerAudience=false): Promise<void> {
  const steps=prepareContextSteps({botId,threadId,humanPrincipal:threadHumanPrincipal(threadId),notOwnerAudience},roster);
  try {while(!steps.next().done)await new Promise<void>(resolve=>setImmediate(resolve));}
  finally {steps.return(undefined);}
}
/** cause18e: the context keys whose first build this process already charged to the one-time seed source (prepareContextSteps). */
const seeded=new WeakMap<DatabaseSync,Set<string>>();
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
    contextStepIdle=false;roomWait=false;
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
        // reclaim-1020-n1: asked again on a timer, never on the next immediate: re-asking every loop turn ran these two probes 836,863 times a
        // minute on the owner copy (100% of a core) for as long as the demand waited.
        contextStepIdle=true;roomWait=true;
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
  let roomWait=false;
  const again=(idle:boolean)=>{
    if(roomWait && !queue.waiting.size){setTimeout(advance,RECALL_ROOM_WAIT_MS).unref();return;}
    const next=setImmediate(advance);if(idle||!queue.waiting.size)next.unref();
  };
  again(false);
}
/** How often warming that waits behind a room demand looks again (reclaim-1020-n1). */
const RECALL_ROOM_WAIT_MS=250;
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
/** One change page for the asked view. A view of the applier's fleet takes the fleet's page (every member moves with it, in one
 *  transaction) and has its own watermark written; a view behind the fleet, one that is not maintained, or a call from inside a
 *  transaction (whose commit this code cannot see) reads its own page alone, exactly, with its watermark written at once. */
export function maintainRecallViewSlice(view: RecallViewHandle): boolean {
  const db=database();assertRecallView(db,view);
  if(!db.isTransaction){const page=applyRecallChanges(db,view);if(page.joined)return page.done;}
  return maintainAlone(db,view);
}
const loneRanges=new WeakMap<DatabaseSync,Map<string,RangeResume>>();
function maintainAlone(db: DatabaseSync,view: RecallViewHandle): boolean {
  let ranges=loneRanges.get(db);if(!ranges)loneRanges.set(db,ranges=new Map());
  const key=pageKey(view),nested=db.isTransaction;
  const page=transaction(()=>{
    const mark=Number(db.prepare('SELECT watermark FROM memory_recall_views WHERE view_id=? AND generation=?').get(view.viewId,view.generation)!.watermark);
    // Inside a caller's transaction no cursor is kept (its commit cannot be seen from here): a long range is read to its end in this
    // call, piece by piece, so the caller's loop always moves on.
    let page=projectChanges(db,[{view}],mark,undefined,nested?undefined:ranges.get(key));
    while(nested && page.resume)page=projectChanges(db,[{view}],page.watermark,undefined,page.resume);
    if(page.watermark!==mark)db.prepare('UPDATE memory_recall_views SET watermark=? WHERE view_id=? AND generation=?').run(page.watermark,view.viewId,view.generation);
    return page;
  }, { busyMs: BACKGROUND_BUSY_MS, op: 'recall-view' });
  if(!nested){if(page.resume)ranges.set(key,page.resume);else ranges.delete(key);}
  return page.done;
}
/** A6: the applier's own run, on lane W's wake bus: woken by the `journal` topic (raised after the commit of a journal write, wake.ts),
 *  by a view, context or epoch write (recall-view-schema.ts viewsTouched) or by a deadline it armed itself. It runs at once when no turn
 *  is running; while a turn is live it waits until RECALL_APPLIER_ROWS rows are pending or RECALL_APPLIER_MS have passed since the first
 *  wake it has not served, so a turn's commits are applied in pages, not one page a commit. One fleet page, then one page for one view
 *  that is behind; while anything is left it raises itself for a later turn of the event loop, so every slice yields. It never leaves
 *  work without a wake: more rows raise at once, a view held by a hydration or a writer's open transaction arms a deadline, an error
 *  arms a doubling one (1 s to 60 s). Nothing pending arms nothing. */
export const RECALL_APPLIER_ROWS=64,RECALL_APPLIER_MS=50;
let applierOn=false,applierRetryMs=0,applierRetryAt=0,applierFirstAt=0;
let unsubscribeUpkeep:Array<()=>void>|undefined;
const behindWaits=new WeakMap<DatabaseSync,Map<string,{until:number;delay:number}>>();
function turnLive(): boolean { for(const reader of activeReaders)if(reader.active())return true;return false; }
function runRecallApplier(_context?: unknown,force=false): void {
  if(!applierOn)return;
  let db:DatabaseSync|undefined;
  try {
    db=database();
    const fleet=fleetOf(db);
    // No bus on this connection (a read-only start, a process turned read-only, a failed install): nothing can be written or woken.
    if(!fleet.woken || !wakeInstalled(db))return;
    if(db.isTransaction){armDeadline('journal',Date.now()+RECALL_APPLIER_HELD_MS);return;}
    // F3: the retry after a failed run has already waited its delay (1 s, doubling); its deadline runs the page, not one more pace on
    // top, so the first retry lands within one idle wait (1 s). Wakes before the retry is due keep the pace.
    const retryDue=applierRetryMs>0 && Date.now()>=applierRetryAt;
    if(!force && !retryDue && turnLive()) {
      const now=Date.now();
      if(!applierFirstAt)applierFirstAt=now;
      // (one O(1) read of the journal head; a fleet that has not formed yet has no mark to count from and runs at once)
      if(now-applierFirstAt<RECALL_APPLIER_MS && fleet.applied!==undefined && journalHeadOf(db)-fleet.applied<RECALL_APPLIER_ROWS){armDeadline('journal',applierFirstAt+RECALL_APPLIER_MS);return;}
    }
    applierFirstAt=0;
    const page=applyRecallChanges(db);
    let more=!page.done;
    // One view behind the fleet reads one page alone a run; it joins the fleet at the page after it has caught up. A view whose own page
    // fails waits out its own doubling delay and never stands in front of the others. A6: a view the storage quota refuses twice running
    // has had its reclaim slice (the refusal raised the reclaimer); then the largest idle view is retired so the store is never stuck full.
    let waits=behindWaits.get(db);if(!waits)behindWaits.set(db,waits=new Map());
    const now=Date.now(),ready=page.behind.filter(view=>(waits.get(pageKey(view))?.until??0)<=now);
    for(const key of [...waits.keys()])if(!page.behind.some(view=>pageKey(view)===key))waits.delete(key);
    const behind=ready[0];
    if(behind) {
      const key=pageKey(behind);
      try{if(!maintainAlone(db,behind) || ready.length>1)more=true;waits.delete(key);}
      catch(error){
        reportMaintenanceError(db,error);
        const refusedBefore=waits.has(key);
        const delay=Math.min(RECALL_APPLIER_RETRY_MAX_MS,(waits.get(key)?.delay??500)*2);waits.set(key,{until:now+delay,delay});
        if(error instanceof Error && error.message==='MEMORY_RECALL_STORAGE_LIMIT') {
          reclaimTouched();
          // Refused again after its reclaim look: one view is retired, and the refused view is asked again soon. No second view is
          // retired while that victim is still being freed (retireLargestView), however often the view is refused meanwhile.
          if(refusedBefore && retireLargestView(db,[behind,...fleet.members.values()].map(item=>'view' in item?item.view:item)))waits.set(key,{until:now+500,delay:250});
        }
        if(ready.length>1)more=true;
      }
    }
    // A view waiting out its delay is looked at again when the delay ends: one deadline, for the earliest.
    let next=Infinity;for(const wait of waits.values())next=Math.min(next,wait.until);
    if(next!==Infinity)armDeadline('journal',next);
    applierRetryMs=0;
    if(more)raise('journal');
    else if(page.held)armDeadline('journal',Date.now()+RECALL_APPLIER_HELD_MS);
  } catch(error) {
    reportMaintenanceError(db,error);
    applierRetryMs=Math.min(RECALL_APPLIER_RETRY_MAX_MS,applierRetryMs?applierRetryMs*2:1000);
    applierRetryAt=Date.now()+applierRetryMs;armDeadline('journal',applierRetryAt);
    if(db && applierRetryMs>=RECALL_PRODUCER_GIVE_UP_MS)journalRoomChanged(db,true);
  }
}
/** A6 / F23: the store is full and one view's page was refused twice. The largest view nothing is using (no reader in a turn, no build,
 *  no hydration) among the refused view and the fleet is retired: it leaves its contexts and reads `building`, so the reclaimer frees it
 *  at its own pace and its contexts are built again when a reader next asks (queued, never synchronously). Sizes come from a per-view
 *  figure kept in memory (one count per view, taken again only after RECALL_FLUSH_ROWS more applied rows). Returns the retired view. */
const viewBytes=new WeakMap<DatabaseSync,Map<string,{bytes:number;at:number}>>();
function cachedViewBytes(db: DatabaseSync,view: {viewId:string;generation:string}): number {
  let cache=viewBytes.get(db);if(!cache)viewBytes.set(db,cache=new Map());
  const key=pageKey(view),at=fleetOf(db).applied??0,known=cache.get(key);
  if(known && at-known.at<RECALL_FLUSH_ROWS)return known.bytes;
  if(cache.size>=2*RECALL_VIEW_LIMIT)cache.clear();
  const bytes=chargedViewBytes(db,view.viewId,view.generation);cache.set(key,{bytes,at});return bytes;
}
export function recallViewBytesForTest(db: DatabaseSync,view: {viewId:string;generation:string}): number { return cachedViewBytes(db,view); }
const quotaVictims=new WeakMap<DatabaseSync,{viewId:string;generation:string}>();
function retireLargestView(db: DatabaseSync,candidates: readonly RecallViewHandle[]): RecallViewHandle|undefined {
  // One victim at a time: while the last one still has its view row (the reclaimer is freeing it at its pace) no other view is retired.
  const last=quotaVictims.get(db);
  if(last && db.prepare('SELECT 1 FROM memory_recall_views WHERE view_id=? AND generation=?').get(last.viewId,last.generation))return undefined;
  quotaVictims.delete(db);
  const sized=candidates.filter(view=>reclaimIdle(db,view.viewId,viewContextKeys(db,view.viewId,view.generation)))
    .map(view=>({view,bytes:cachedViewBytes(db,view)})).sort((a,b)=>b.bytes-a.bytes || (a.view.viewId<b.view.viewId?-1:1));
  for(const {view} of sized) {
    if(!markVictim(db,{viewId:view.viewId,generation:view.generation,cls:'E',table:0,marked:false}))continue;
    viewBytes.get(db)?.delete(pageKey(view));
    quotaVictims.set(db,{viewId:view.viewId,generation:view.generation});
    reclaimEvent({kind:'mark',cls:'E',viewId:view.viewId,source:'recall-applier-quota'});
    reclaimTouched();
    return view;
  }
  return undefined;
}
const RECALL_APPLIER_HELD_MS=250,RECALL_APPLIER_RETRY_MAX_MS=60_000;
/** For witnesses: one fleet page alone (no view behind it is asked, no retirement), as the applier's run starts. */
export function applyRecallPageForTest(db: DatabaseSync): { done: boolean; behind: string[] } { const page=applyRecallChanges(db);return {done:page.done,behind:page.behind.map(view=>view.viewId)}; }
/** For witnesses: run the applier now, as a wake would. */
export function runRecallApplierForTest(): void { const on=applierOn;applierOn=true;try{runRecallApplier(undefined,true);}finally{applierOn=on;} }

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
  // On the wake bus, as closing work a reader waits on (ahead of the applier's own run): one request a slice, never inline.
  requestedViews.push({db,generation,key,view:{...view},queue:pending});
  requestSubscription??=onWake(RECALL_REQUEST_TOPIC,runRequestedMaintenance,{priority:WAKE_PRIORITY.closing,name:'recall-view-request'});
  raise(RECALL_REQUEST_TOPIC);
}
const RECALL_REQUEST_TOPIC='recall-view-request';
const requestedViews:Array<{db:DatabaseSync;generation:number;key:string;view:RecallViewHandle;queue:Set<string>}>=[];
let requestSubscription:(()=>void)|undefined;
function runRequestedMaintenance(): void {
  const item=requestedViews.shift();
  if(!item)return;
  item.queue.delete(item.key);
  if(databaseGeneration()===item.generation && !hydratingViews.get(item.db)?.has(item.view.viewId)) {
    try { maintainRecallViewSlice(item.view); }
    catch(error) { reportMaintenanceError(item.db,error); }
  }
  if(requestedViews.length)raise(RECALL_REQUEST_TOPIC);
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
/** The reclaimer's "nothing to free" answer stays true while nothing changed that could make a victim: no view or context row written,
 *  the authority epoch unmoved, no view row written by the applier (reclaimMark, counted by the writes themselves), and the same readers
 *  in a turn, builds, hydrations and room demands as when it last looked (all in memory). Victim choice reads nothing else (no clock), so
 *  an unchanged look costs no statement; storage pressure and a step that is working or gated are always looked at again. */
const reclaimLookAt=new WeakMap<DatabaseSync,string>();
/** cause18-idleperf x memv2 upkeep (integrator spec-cand-1021-r8): when a reclaim step that only yielded may run again. */
const reclaimRestUntil=new WeakMap<DatabaseSync,number>();
const RECALL_RECLAIM_REST_MS=1000;
/** cause18-idleperf: the lease mark the last parked-reader ask saw and when the next one is due without a lease move. */
const parkedAskAt=new WeakMap<DatabaseSync,{leases:string;at:number}>();
/** `inFlight`: something whose end may come without a write or a wake, so the look is repeated. `progress`: of those, work that is really
 *  moving (a build, a hydration, a victim being freed, a demanded build, or a demand while the reclaimer progresses: reclaimBusy). A reader
 *  in a turn, or a room demand waiting with nothing freed, is not progress: its silent end is looked for at RECALL_RECLAIM_REST_MS. */
function reclaimLook(db: DatabaseSync): { key: string; inFlight: boolean; progress: boolean } {
  let readers=0;for(const reader of activeReaders)if(reader.active())readers++;
  const builds=activeBuilds.get(db)?.size??0,hydrations=hydratingViews.get(db)?.size??0,state=reclaimStates.get(db);
  const demands=state?.demands.size??0,demanded=state?.demanded??0;
  return {key:`${reclaimMark()}|${readers}|${builds}|${hydrations}|${demands}|${demanded}`,inFlight:readers+builds+hydrations+demands+demanded>0 || !!state?.victim,
    progress:builds+hydrations>0 || reclaimBusy(db)};
}
/** Lane H's collector (session-proof-schema.ts sessionCollector, CONTRACT-REQ A memv2-H) counts on the connection the events that give
 *  its two riders work. Owner of the riders and of that figure: lane H; owner of this call site: lane A. Where that export exists the
 *  riders run only when a figure moved or one of its two times is due, and the upkeep arms a deadline for the earlier one; where it
 *  does not (this branch before lane H is merged) the riders are called on every look, as the 50 ms tick did, and keep the deadline armed. */
interface SessionCollectorFigures { checksWrites: number; seedInputs: number; expiryDue: number; lap: { done: boolean; at: number }; gone?: { size: number }; commitMoved?: () => boolean; orphans?: { done: boolean; cycle?: unknown; at?: number }; foreignDueAt?: number; seed?: { holdUntil?: number }; recover?: { done: boolean }; guards?: boolean; degradedAt?: number }
let sessionCollectorOf=(sessionProofSchema as unknown as { sessionCollector?: (db: DatabaseSync,now?: number)=>SessionCollectorFigures }).sessionCollector;
let sessionRider=(db: DatabaseSync): void => { collectSessionChecksSlice(db);seedSessionChecksSlice(); };
/** Tests: a collector to read figures from (null: none, as on a tree without lane H's export; omitted: the module's own), and the rider. */
export function setRecallSessionRidersForTest(collector?: ((db: DatabaseSync,now?: number)=>SessionCollectorFigures)|null,rider?: (db: DatabaseSync)=>void): void {
  sessionCollectorOf=collector===null?undefined:collector??(sessionProofSchema as unknown as { sessionCollector?: (db: DatabaseSync,now?: number)=>SessionCollectorFigures }).sessionCollector;
  sessionRider=rider??((db: DatabaseSync): void => { collectSessionChecksSlice(db);seedSessionChecksSlice(); });
}
const sessionSeen=new WeakMap<DatabaseSync,string>();
/** Runs lane H's riders when they have cause; returns when they next need a look (a wall-clock time), or undefined for "when woken". */
function sessionRiders(db: DatabaseSync,now: number): number|undefined {
  if(!sessionCollectorOf){sessionRider(db);return now+RECALL_UPKEEP_MS;}
  // ASTRA+OPUS spec-cand-1021 b2343335b6 (F4): nothing raises the upkeep on another connection's commit (lane W's foreign-commit wake is not
  // on this tree), so while the orphan cache is done and a check exists for a foreign delete to orphan, the collector's 30 s foreign look
  // (foreignDueAt, one data_version read) is a time the upkeep arms for. A store with no check (expiryDue Infinity) still arms nothing.
  // Once a look clears the cache, the orphan cycle it reopens is work too: due now while a cycle is open, else at its own pace (orphans.at),
  // so the cycle reaches `done` again (and the foreign look is armed again) without waiting for a local wake.
  const foreignLook=(figures: SessionCollectorFigures)=>{
    const orphans=figures.orphans;
    if(!orphans || figures.foreignDueAt===undefined)return Infinity;
    if(!orphans.done)return orphans.cycle!==undefined?0:orphans.at??Infinity;
    return figures.expiryDue>0 && figures.expiryDue!==Infinity?figures.foreignDueAt:Infinity;
  };
  const due=(figures: SessionCollectorFigures)=>Math.min(figures.expiryDue>0?figures.expiryDue:Infinity,figures.lap.done?Infinity:figures.lap.at,foreignLook(figures));
  // CONTRACT-REQ A memv2-H (r2 amendment): the restart sweep takes one bounded slice a call while `recover.done` is false (once per
  // connection open, and again every 30 s on a connection without lane H's guards); it ends by itself.
  const recovering=(figures: SessionCollectorFigures)=>figures.recover?.done===false;
  let figures=sessionCollectorOf(db,now);
  const key=`${figures.checksWrites}|${figures.seedInputs}`;
  // (proofs still queued to drop are work too: the 50 ms look below would otherwise repeat without ever running the rider)
  // (and another connection's commit, seen without a statement, may have deleted a check: W-SESSION-FOREIGN on the upkeep's path)
  if(sessionSeen.get(db)!==key || due(figures)<=now || recovering(figures) || (figures.gone?.size??0)>0 || figures.commitMoved?.()===true) {
    sessionRider(db);
    figures=sessionCollectorOf(db,now);
    // The riders take one bounded slice a call: figures that moved while they ran, or a time still due, mean another look.
    const after=`${figures.checksWrites}|${figures.seedInputs}`;
    sessionSeen.set(db,after);
    if(after!==key || due(figures)<=now || recovering(figures))return now+RECALL_UPKEEP_MS;
  }
  // Work lane H's collector carries over without moving a figure: proofs it still has to drop (`gone`) are looked at again, and a
  // seed pass that backed off is looked at when its hold ends.
  if((figures.gone?.size??0)>0)return now+RECALL_UPKEEP_MS;
  // A connection without lane H's guards restarts the sweep every 30 s (sessionCollector moves its figures when asked after degradedAt).
  const hold=figures.seed?.holdUntil??0,degraded=figures.guards===false && (figures.degradedAt??0)>now?figures.degradedAt!:Infinity;
  const next=Math.min(due(figures),hold>now?hold:Infinity,degraded);
  return next===Infinity?undefined:next;
}
/** MAIN RULING 1117T01:23Z (b): a roster change rebuilds every context, so each look reclaims a bounded batch of obsolete-view slices
 *  (at most 64 x 256 rows), never one. A small view frees in a few slices, so one look keeps up with a full rebuild's supersessions
 *  without letting orphans reach the 128-view cap. The batch stops as soon as nothing is left; work per look never grows with history. */
const RECLAIM_SLICES_PER_TICK=64;
/** How soon the upkeep looks again while it has a named cause to (a victim half freed, a paced or gated reclaim step, storage pressure,
 *  a reader in a turn, a build or hydration in flight, a parked context, lane H's riders). With none, nothing is armed. */
const RECALL_UPKEEP_MS=50;
let closeHooked=false;
/** The upkeep that rode the 50 ms timer, now run by a wake (memv2 lane A, I1, I2): the `recall-upkeep` topic is raised by the writes that
 *  can give the reclaimer work (recall-view-schema.ts reclaimTouched / viewsTouched), by a reader's release, a build's end and a start,
 *  and by the deadline this function arms for itself while a cause is left. At rest it is not called and holds no timer.
 *  One bounded reclamation batch, the oldest parked reader asked again, and lane H's two riders. */
function runRecallUpkeep(): void {
  if(!applierOn)return;
  let db:DatabaseSync|undefined,next=Infinity;
  const now=Date.now();
  try {
    db=database();
    // No bus on this connection (read-only, or its install failed): nothing here can write, and nothing would wake it. No deadline.
    if(!wakeInstalled(db))return;
    // Raised from inside a writer's statement: a transaction still open on a later turn (one held across awaits) is not joined, or
    // a rollback of the owner's work would undo a reclaim step whose in-memory state has moved on.
    if(db.isTransaction){armDeadline(RECALL_UPKEEP_TOPIC,now+RECALL_APPLIER_HELD_MS);return;}
    // The paced reclaimer (recalldesign-1020-n1) frees crash leftovers, superseded, stale, duplicate and (for a waiting demand) cold views. Only
    // when it has nothing to free does the 128-view cap retire one idle context, which the reclaimer then frees, paced.
    const look=reclaimLook(db);
    const rest=reclaimRestUntil.get(db)??0;
    // a look that skips the step for its rest still owes the step a look when the rest ends (one deadline per topic, earliest wins)
    if(!storagePressure.has(db) && reclaimLookAt.get(db)!==look.key && now<rest)next=Math.min(next,rest);
    if(storagePressure.has(db) || reclaimLookAt.get(db)!==look.key && now>=rest) {
      // cause18-idleperf: a step that only yielded (a demand waiting, no victim, nothing freed: reclaimBusy false) is not work: it rests
      // RECALL_RECLAIM_REST_MS (spec/1021's idle pace) instead of holding the 50 ms pace for hours; a pause or a gate still ends in time
      if(recallReclaimStep(db)){if(reclaimBusy(db))next=now+RECALL_UPKEEP_MS;else{reclaimRestUntil.set(db,now+RECALL_RECLAIM_REST_MS);next=Math.min(next,now+RECALL_RECLAIM_REST_MS);}}
      // (a collection slice that found nothing to free (true: the pressure flag a refused re-ask set, every context held) rests too; one
      // that freed something keeps the 50 ms pace)
      else if(storagePressure.has(db)){next=Math.min(next,now+(collectRecallViewSlice(db)?RECALL_RECLAIM_REST_MS:RECALL_UPKEEP_MS));}
      else reclaimLookAt.set(db,look.key);
    }
    // A reader's lease can end without a release call, and a hydration without a row: while one is in flight the look is repeated (in
    // memory; a statement only when the look changed). cause18-idleperf (integrator spec-cand-1021-r8, W-PIN / W-QUIET-ARMS): at the 50 ms
    // pace only while a build, a hydration or the reclaimer is really progressing; a store where only readers hold their leases (or a
    // demand waits with nothing freed) is looked at once per RECALL_RECLAIM_REST_MS, so a lease that ends silently is still seen.
    if(look.inFlight)next=Math.min(next,now+(look.progress?RECALL_UPKEEP_MS:RECALL_RECLAIM_REST_MS));
    // A lease can end without a release call; upkeep lets the oldest parked reader ask again (one per look).
    // cause18-idleperf (integrator spec-cand-1021-r8): it asks at the 50 ms pace only on the look that sees the lease mark move (a lease
    // taken, released, or ended silently), otherwise once per RECALL_RECLAIM_REST_MS, never 20 times a second through a long turn.
    const leases=leaseMark(),parkedAt=parkedAskAt.get(db);
    if(!parkedAt || parkedAt.leases!==leases || now>=parkedAt.at){wakeParkedContexts(db,1);parkedAskAt.set(db,{leases,at:now+RECALL_RECLAIM_REST_MS});}
    if(queued.get(db)?.parked.size)next=Math.min(next,parkedAt?.leases!==leases?now+RECALL_UPKEEP_MS:parkedAskAt.get(db)!.at);
    const riders=sessionRiders(db,now);
    if(riders!==undefined)next=Math.min(next,riders);
  } catch(error) { reportMaintenanceError(db,error);next=now+RECALL_UPKEEP_MS; }
  if(next!==Infinity)armDeadline(RECALL_UPKEEP_TOPIC,next);
}
/** For witnesses: one upkeep look now, as a wake would. */
export function runRecallUpkeepForTest(): void { const on=applierOn;applierOn=true;try{runRecallUpkeep();}finally{applierOn=on;} }
/** Starts the two wake subscribers (the applier and the upkeep). No timer is created here or anywhere in the upkeep: what is left
 *  unapplied by the last stop (at most the flush lag) is read once now, and after that only a write or an armed deadline runs them.
 *  No record writer enumerates views. */
export function startRecallViewMaintenance(): void {
  if(!unsubscribeUpkeep)unsubscribeUpkeep=[
    onWake('journal',runRecallApplier,{priority:WAKE_PRIORITY.applier,name:'recall-applier'}),
    onWake(RECALL_UPKEEP_TOPIC,runRecallUpkeep,{priority:WAKE_PRIORITY.background,name:'recall-upkeep'})];
  if(!closeHooked){closeHooked=true;onDatabaseClose(stopRecallViewMaintenance);}
  if(!applierOn){applierOn=true;raise('journal');raise(RECALL_UPKEEP_TOPIC);}
}
export function stopRecallViewMaintenance(): void {
  applierOn=false;applierRetryMs=0;applierRetryAt=0;applierFirstAt=0;
  for(const unsubscribe of unsubscribeUpkeep??[])unsubscribe();
  unsubscribeUpkeep=undefined;
  disarmDeadline('journal');disarmDeadline(RECALL_UPKEEP_TOPIC);
  // A producer waiting for the applier (A10) is not left waiting for one that has stopped.
  if(fleetDb)journalRoomChanged(fleetDb,true);
}
/** M0, lane A's exact probe for the `journal` topic (wake.ts setWakeProbe): is a journal row above what the applier has read? One seek. */
setWakeProbe('journal',db=>{
  const fleet=fleetDb?fleets.get(fleetDb):undefined;
  if(fleet?.applied!==undefined && fleet.members.size)return db.prepare('SELECT 1 FROM memory_recall_changes WHERE sequence>? LIMIT 1').get(fleet.applied)!==undefined;
  return db.prepare("SELECT 1 FROM memory_recall_changes c WHERE c.sequence>(SELECT coalesce(min(v.watermark),9223372036854775807) FROM memory_recall_views v WHERE v.state='ready') LIMIT 1").get()!==undefined;
});

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
interface ReclaimState {slice:number;tokens:number;refilledAt:number;lastCost:number;pausedUntil:number;demanded:number;minute:number;minuteBase:number;lastWritten:number;victim?:Victim;
  /** cause18-idleperf: the change mark and arguments of the last victim choice that found none; progressed: a victim was marked or sliced since
   *  the last choice that found none (a step that only waits on the bucket or the log gate keeps the value it had) */
  noVictim?:string;progressed?:boolean;demands:Map<string,RoomDemand>;woken:Set<string>;quotaRefused:Map<string,{epoch:number;revision:number;inUse:number}>}
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
/** The reclaimer still has a victim in hand or a demand waiting (a step that returned true only because it yielded to the owner, with
 *  nothing chosen, is not work the upkeep must hurry for: the upkeep asks again after RECALL_RECLAIM_REST_MS). */
// cause18-idleperf: a demand that waits while no victim is left and nothing was freed is not work (1.0.21 owner copy: it held the 50 ms pace
// for hours); it is asked again when the views, contexts or leases change (the victim memo below and the upkeep's reclaim look).
function reclaimBusy(db:DatabaseSync):boolean {const state=reclaimStates.get(db);return !!state && (state.victim!==undefined || state.demands.size>0 && state.progressed===true || state.demanded>0);}
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
          // cause18-idleperf: the choice reads every view row and, under pressure, sorts every ready view (1.0.21 owner copy: x1,127 a minute
          // for 9.5 h, every one finding nothing). A choice that found nothing is not made again until its inputs move: a row write on this
          // connection, a commit elsewhere, a lease, a build or a hydration (recallChangeMark), or the demand and pressure arguments.
          const pressure=used>RECLAIM_PRESSURE*limits.quota || need>0,mark=`${demand}:${pressure}:${recallChangeMark(db)}`;
          if(state.noVictim===mark){state.progressed=false;return false;}
          state.victim=chooseRecallReclaimVictim(db,demand,pressure);
          if(!state.victim){state.noVictim=mark;state.progressed=false;return false;}
          state.noVictim=undefined;
        }
        const victim=state.victim,before=reclaimClock.written();
        if(!victim.marked) {
          if(!markVictim(db,victim)){state.victim=undefined;continue;}
          victim.marked=true;state.progressed=true;reclaimEvent({kind:'mark',cls:victim.cls,viewId:victim.viewId,source:ioBudget.currentSource()});
        } else {state.progressed=true;if(reclaimVictimSlice(db,state,victim)){state.victim=undefined;wakeRoomDemands(db,state);}}
        const after=reclaimClock.written();state.lastWritten=after;
        reclaimCharge(state,after-before);
      }
      return true;
    } catch(error) {
      if(error instanceof DatabaseBusyError){reclaimEvent({kind:'busy'});return true;}
      // memv2 lane A: the upkeep tick reaches the reclaimer first now (the per-context walk that used to meet these errors is gone). The
      // expected unavailability of a view or a closed handle is not a storage failure: no pause, no warning, the next tick asks again.
      if(error instanceof Error && (/^MEMORY_(RECALL_UNAVAILABLE|CONTEXT_REVOKED)$/.test(error.message)
        || (error as {code?:unknown}).code==='ERR_INVALID_STATE' && /database is not open|database has been closed/i.test(error.message))){state.victim=undefined;return true;}
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
