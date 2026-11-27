import { removeTempDirSync } from "./testing/cleanup.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
import { MESSAGE_SEARCH_DDL } from './testing/search-index-compat.ts';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { afterEach, it, vi } from 'vitest';
import { expect } from "./testing/search-index-oracle.ts";
import * as search from './testing/search-index-compat.ts';
import * as wal from './wal-maintenance.ts';
import { DatabaseBusyError } from './db-busy.ts';
import { initializeMessageTables } from './message-tables.ts';
import { SEARCH_INDEX_WORKER_SOURCE } from './testing/search-index-compat.ts';
const workerFault = vi.hoisted(() => { vi.resetModules(); return { resetBusy: false, stepFailure: false, rebuildFailure: false, applyFailure: false, diskFull: null as SharedArrayBuffer | null, enospc: null as SharedArrayBuffer | null }; });
vi.mock('node:worker_threads', async importOriginal => {
 const original = await importOriginal<typeof import('node:worker_threads')>();
 return { ...original, Worker: class extends original.Worker {
  constructor(source:string, options:import('node:worker_threads').WorkerOptions) {
   if(workerFault.resetBusy) source=source.replace('function reset(marker) {', `let resetBusyOnce=true;function reset(marker) {if(resetBusyOnce){resetBusyOnce=false;throw Object.assign(Error('fixture busy reset'),{errcode:261});}`);
   if(workerFault.stepFailure) source=source.replace("    if (message.type !== 'step' || resetWaiting) return;", "    if (message.type !== 'step' || resetWaiting) return; throw Error('fixture persistent step failure');");
   if(workerFault.rebuildFailure) source=source.replace('function rebuild() {', "let rebuildSteps=0;function rebuild() { if(state('built') !== undefined && ++rebuildSteps === 2) throw Error('fixture rebuild step two');").replace('function reset(marker) {', 'function reset(marker) { rebuildSteps=0;');
   if(workerFault.applyFailure) source=source.replace('function apply() {', "function apply() { if(state('built') === undefined && Number(latest()?.seq)>Number(state('applied_seq'))) throw Error('fixture first apply');");
   if(workerFault.diskFull) {
    options={...options,workerData:{...options.workerData,diskFull:workerFault.diskFull}};
    source=source.replace('function write(run) {', `let quota=false;function write(run) {
      if(Atomics.load(new Int32Array(workerData.diskFull),0)===1 && !quota){
        a.exec('CREATE TABLE fixture_ballast(b);INSERT INTO fixture_ballast VALUES(zeroblob(4194304))');
        a.exec('PRAGMA max_page_count='+a.prepare('PRAGMA page_count').get().page_count);
        quota=true;Atomics.store(new Int32Array(workerData.diskFull),0,2);
      }`);
   }
   if(workerFault.enospc) {
    options={...options,workerData:{...options.workerData,enospc:workerFault.enospc}};
    source=source.replace('function reset(marker) {', `function reset(marker) {if(Atomics.load(new Int32Array(workerData.enospc),0))throw Object.assign(Error('fixture ENOSPC'),{code:'ENOSPC'});`);
   }
   super(source,options);
  }
 } };
});
const defaultFence=search.searchIndexTestHooks.fence;
const cleanup: Array<()=>unknown> = [];
const pause = (ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(check:()=>boolean,ms=2000){const end=Date.now()+ms;while(!check()&&Date.now()<end)await pause(10);}
afterEach(async()=>{await search.stopSearchIndex();for(const f of cleanup.splice(0).reverse())await f();vi.restoreAllMocks();workerFault.resetBusy=false;workerFault.stepFailure=false;workerFault.rebuildFailure=false;workerFault.applyFailure=false;workerFault.diskFull=null;workerFault.enospc=null;search.searchIndexTestHooks.event=null;search.searchIndexTestHooks.now=()=>Date.now();search.searchIndexTestHooks.fence=defaultFence;});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'murage-review-recovery-'));cleanup.push(()=>removeTempDirSync(dir));
 const file=join(dir,'messages.db'), db=new DatabaseSync(file);cleanup.push(()=>db.close());
 db.exec('PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0');initializeMessageTables(db);return{dir,file,db};
}
it('R1: persistent reset failure writes at most one genesis and surfaces failure',async()=>{
 const {dir,file,db}=fixture();mkdirSync(join(dir,'search.db'));
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 search.startSearchIndex(db,file);await pause(700);
 expect(Number(db.prepare('SELECT COUNT(*) AS n FROM search_intents').get()!.n)).toBeLessThanOrEqual(1);
 expect(warn.mock.calls.flat().join(' ')).toMatch(/search.*(?:failure|failed|deferred)/);
 expect(search.messageSearchIndexReady(db)).toBe(false);
});
it('R1 admission: a refused WAL gate prevents the reset genesis transaction',async()=>{
 const {file,db}=fixture();const admission=vi.spyOn(wal,'assertWalWriteAdmission').mockImplementation(()=>{throw new DatabaseBusyError('wal-recovery',0);});
 search.startSearchIndex(db,file);await pause(350);
 expect(Number(db.prepare('SELECT COUNT(*) AS n FROM search_intents').get()!.n)).toBe(0);
 expect(admission).toHaveBeenCalled();
});
it('B1 sweep-1021: a refused WAL gate backs off and warns on doublings, then recovers when the log catches up',async()=>{
 const {file,db}=fixture();let refuse=true;const real=wal.assertWalWriteAdmission;
 const admission=vi.spyOn(wal,'assertWalWriteAdmission').mockImplementation((f?:string|null)=>{if(refuse)throw new DatabaseBusyError('wal-recovery',0);return real(f);});
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 search.startSearchIndex(db,file);await pause(1200);
 // Base: delay stayed 100 ms because only a passed gate counted, so ~10 attempts and ~10 warn lines in this window.
 expect(admission.mock.calls.length).toBeLessThanOrEqual(5);
 expect(warn.mock.calls.filter(c=>String(c[0]).includes('recovery failed')).length).toBeLessThanOrEqual(4);
 expect(search.recovery(db).consecutive).toBe(0);
 refuse=false;await until(()=>search.messageSearchIndexReady(db),4000);
 expect(search.messageSearchIndexReady(db)).toBe(true);
},15000);
it('B1 prune holdoff: once the index is ready, a refused WAL gate holds the idle prune off (250 ms doubling) instead of retrying on every idle reply',async()=>{
 const {file,db}=fixture();let refuse=false;let prunes=0;const real=wal.assertWalWriteAdmission;
 const admission=vi.spyOn(wal,'assertWalWriteAdmission').mockImplementation((f?:string|null)=>{if(refuse){prunes++;throw new DatabaseBusyError('wal-recovery',0);}return real(f);});
 vi.spyOn(console,'warn').mockImplementation(()=>{});
 const clock=1_000_000;let now=clock;search.searchIndexTestHooks.now=()=>now;
 search.startSearchIndex(db,file);await until(()=>search.messageSearchIndexReady(db),4000);
 expect(search.messageSearchIndexReady(db)).toBe(true);
 refuse=true;admission.mockClear();prunes=0;
 // idle replies keep arriving every ~250 ms; the clock is frozen, so a hold set by the first refusal never expires
 await until(()=>prunes>=1,3000);expect(prunes).toBe(1);
 await pause(1200);expect(prunes).toBe(1);
 // past the first hold (250 ms) the prune tries once more, then holds for 500 ms
 now=clock+251;await until(()=>prunes>=2,3000);expect(prunes).toBe(2);
 await pause(1200);expect(prunes).toBe(2);
 now=clock+251+499;await pause(1200);expect(prunes).toBe(2);
 now=clock+251+501;await until(()=>prunes>=3,3000);expect(prunes).toBe(3);
},20000);
it('busy storm 1022: a held write lock makes recovery back off (few attempts, one summary line per doubling) and it completes once the lock is released',async()=>{
 const {file,db}=fixture();const holder=new DatabaseSync(file);cleanup.push(()=>holder.close());
 holder.exec('PRAGMA busy_timeout=0');
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 let attempts=0;const realExec=db.exec.bind(db);
 vi.spyOn(db,'exec').mockImplementation((sql:string)=>{if(/BEGIN IMMEDIATE/.test(sql))attempts++;return realExec(sql);});
 // The backfill prep writes, so the lock is taken right after start, before the first reset acknowledgement runs.
 search.startSearchIndex(db,file);holder.exec('BEGIN IMMEDIATE');await pause(2500);
 // Base: busy never counted, so the delay stayed at 100 ms: ~25 attempts and ~25 warn lines in this window.
 expect(attempts).toBeLessThanOrEqual(6);
 expect(warn.mock.calls.filter(c=>String(c[0]).includes('recovery failed')).length).toBeLessThanOrEqual(5);
 expect(search.recovery(db).state).not.toBe('PARKED');
 holder.exec('ROLLBACK');
 await until(()=>search.messageSearchIndexReady(db),10000);
 expect(search.messageSearchIndexReady(db)).toBe(true);
},20000);
it('R2: busy reset explicitly retries and becomes ready after the lock releases',async()=>{
 const {dir,file,db}=fixture();search.prepareMessageSearchBackfill(db);
 // One deterministic SQLITE_BUSY from the actual worker reset handler. This
 // models a transient writer lock without relying on platform unlink semantics.
 const source=SEARCH_INDEX_WORKER_SOURCE.replace('function reset(marker) {',`let busyOnce=true;function reset(marker) { if(busyOnce){busyOnce=false;throw Object.assign(Error('fixture busy reset'),{errcode:5});}`);
 const worker=new Worker(source,{eval:true,workerData:{file,searchFile:join(dir,'search.db'),ddl:MESSAGE_SEARCH_DDL,token:'busy'}});cleanup.push(()=>worker.terminate());
 let ready=false,retries=0;const genesis=db.prepare('INSERT INTO search_intents(nonce,rowid) VALUES(7,0)').run();
 const reset=()=>worker.postMessage({type:'reset',token:'busy',marker:{seq:Number(genesis.lastInsertRowid),nonce:'7'}});
 worker.on('message',event=>{if(event.type==='reset-needed'||event.type==='reset-retry'){retries++;reset();}if(event.type==='stepped')worker.postMessage({type:'step',token:'busy'});if(event.type==='ready')ready=true;});
 await until(()=>ready,1200);expect(ready).toBe(true);expect(retries).toBeGreaterThanOrEqual(2);
});
it('R2 main: reset-retry reuses the marker and recovers through the owner dispatcher',async()=>{
 const {db,file}=fixture();workerFault.resetBusy=true;let acknowledgements=0;
 search.searchIndexTestHooks.event=event=>{if(event.type==='reset-ack')acknowledgements++;};
 search.startSearchIndex(db,file);await until(()=>search.messageSearchIndexReady(db),3000);
 expect(search.messageSearchIndexReady(db)).toBe(true);expect(acknowledgements).toBe(2);
 expect(Number(db.prepare('SELECT COUNT(*) AS n FROM search_intents').get()!.n)).toBe(1);
});
it('R1 cap: persistent failures stop retrying after eight admitted attempts',{timeout:25000},async()=>{
 const {dir,file,db}=fixture();mkdirSync(join(dir,'search.db'));const attempts:number[]=[];
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 search.searchIndexTestHooks.event=event=>{if(event.type==='reset-ack')attempts.push(performance.now());};
 search.startSearchIndex(db,file);
 await until(()=>warn.mock.calls.flat().join(' ').includes('retry limit reached'),19000);
 expect(attempts).toHaveLength(8);
 expect(warn.mock.calls.flat().join(' ')).toContain('retry limit reached');
 expect(attempts[1]-attempts[0]).toBeGreaterThanOrEqual(190);
 expect(attempts[2]-attempts[1]).toBeGreaterThanOrEqual(390);
 await pause(300);expect(attempts).toHaveLength(8);
 expect(Number(db.prepare('SELECT COUNT(*) AS n FROM search_intents').get()!.n)).toBe(1);
});
it('R1 ready: opening an empty index cannot replenish the reset write budget',{timeout:25000},async()=>{
 const {db,file}=fixture();workerFault.stepFailure=true;let ready=0,attempts=0;
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
 search.searchIndexTestHooks.event=event=>{if(event.type==='ready')ready++;if(event.type==='reset-ack')attempts++;};
 search.startSearchIndex(db,file);
 await until(()=>warn.mock.calls.flat().join(' ').includes('retry limit reached'),19000);
 expect(ready).toBe(8);expect(attempts).toBe(8);
 expect(warn.mock.calls.flat().join(' ')).toContain('retry limit reached');
 expect(search.messageSearchIndexReady(db)).toBe(false);
 const intents=Number(db.prepare('SELECT COUNT(*) AS n FROM search_intents').get()!.n);
 expect(intents).toBe(8);await pause(300);
 expect(Number(db.prepare('SELECT COUNT(*) AS n FROM search_intents').get()!.n)).toBe(intents);
});
it('R3 reader: a reader-open error is contained and the reader recovers',async()=>{
 const {db,file}=fixture();const exec=DatabaseSync.prototype.exec;let failures=0;
 vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(this:DatabaseSync,sql:string){if(sql.includes('query_only=ON')&&failures++===0)throw Error('fixture reader open failure');return exec.call(this,sql);});
 vi.spyOn(console,'warn').mockImplementation(()=>{});
 search.startSearchIndex(db,file);await until(()=>search.messageSearchIndexReady(db));
 expect(search.messageSearchIndexReady(db)).toBe(true);expect(failures).toBeGreaterThanOrEqual(2);
});
it('R3 prune: SQLITE_BUSY during idle pruning is contained and retried',async()=>{
 const {db,file}=fixture();const prepare=db.prepare.bind(db);let attempts=0;
 db.prepare=(sql:string)=>{if(sql===search.PRUNE_SQL&&++attempts===1)throw new DatabaseBusyError('fixture-prune',0);return prepare(sql);};
 vi.spyOn(console,'warn').mockImplementation(()=>{});
 search.startSearchIndex(db,file);await until(()=>attempts>=2);
 expect(attempts).toBeGreaterThanOrEqual(2);expect(search.messageSearchIndexReady(db)).toBe(true);
});

import { ownerFirst } from './owner-first.ts';
async function oracleUntil(check:()=>boolean, id:string, ms=5000) {
 const end=performance.now()+ms;
 while(!check()&&performance.now()<end)await pause(10);
 expect(check(), 'ORACLE:'+id).toBe(true);
}
function seed(db:DatabaseSync) {
 db.exec("WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<300) INSERT INTO messages(thread_id,id,at,role,kind,text,json) SELECT 't',CAST(x AS TEXT),x,'user','text','canary recovery','{}' FROM n");
}
it('T-REC-RESET: successful rebuilds replenish only the consecutive budget',{timeout:15000},async()=>{
 const {db,file}=fixture();seed(db);
 let ready=0;const trace:unknown[]=[];search.searchIndexTestHooks.event=e=>{if(e.type==='ready')ready++;trace.push({type:e.type,ready,recovery:search.recovery(db)});};
 search.startSearchIndex(db,file);
 await oracleUntil(()=>ready===1&&search.recovery(db).state==='HEALTHY','T-REC-RESET');
 const foreign=new DatabaseSync(file);foreign.enableDefensive(false);cleanup.push(()=>foreign.close());
 for(let i=0;i<11;i++) {
  if(i<5||i===10)search.disableMessageSearchIndex(db,Error('fixture invalidation'));
  // A bare schema-cookie bump no longer invalidates (start-up migrations move it on every start, W-SEARCH-RESTART);
  // a rotated search owner is the foreign invalidation that still must reset.
  else foreign.exec("UPDATE transcript_index_state SET done=hex(randomblob(16)) WHERE name='search_owner'");
  try { await oracleUntil(()=>ready===i+2&&search.recovery(db).state==='HEALTHY','T-REC-RESET'); } catch(error) { console.log('REC RESET TRACE',i,JSON.stringify(trace)); throw error; }
  expect(search.recovery(db).consecutive,'ORACLE:T-REC-RESET').toBe(0);
 }
 expect(search.readMessageSearchCandidates(db,search.trigramQuery('canary'),400).rowids,'ORACLE:T-REC-RESET').toHaveLength(300);
});
it('T-REC-PERSISTENT: rebuild step two fails eight times then parks without writes',{timeout:26000},async()=>{
 const {db,file}=fixture();seed(db);workerFault.rebuildFailure=true;
 const cycles:number[]=[],sequence:number[]=[];let steps=0;
 vi.spyOn(console,'warn').mockImplementation(()=>{});
 search.searchIndexTestHooks.event=e=>{if(e.type==='reset-ack')cycles.push(search.recovery(db).consecutive);if(e.type==='stepped')steps++;sequence.push(search.recovery(db).consecutive);};
 search.startSearchIndex(db,file);
 await oracleUntil(()=>search.recovery(db).state==='PARKED','T-REC-PERSISTENT',21000);
 expect(cycles,'ORACLE:T-REC-PERSISTENT').toEqual([1,2,3,4,5,6,7,8]);
 expect(search.intentCount(db),'ORACLE:T-REC-PERSISTENT').toBe(8);
 expect(sequence.every((n,i)=>i===0||n>=sequence[i-1]),'ORACLE:T-REC-PERSISTENT').toBe(true);
 const count=steps,changes=db.prepare('SELECT total_changes() AS n').get()!.n;
 await pause(2000);
 expect(steps,'ORACLE:T-REC-PERSISTENT').toBe(count);
 expect(db.prepare('SELECT total_changes() AS n').get()!.n,'ORACLE:T-REC-PERSISTENT').toBe(changes);
 await search.stopSearchIndex();workerFault.rebuildFailure=false;search.startSearchIndex(db,file);
 await oracleUntil(()=>search.recovery(db).state==='HEALTHY','T-REC-PERSISTENT');
 expect(search.recovery(db).consecutive,'ORACLE:T-REC-PERSISTENT').toBe(0);
});
it('T-REC-WINDOW: healthy recurring faults pause after twelve starts and resume at expiry',{timeout:16000},async()=>{
 const {db,file}=fixture();seed(db);workerFault.applyFailure=true;
 let now=10*search.SEARCH_RECOVERY_WINDOW_MS,ready=0,delay=0,fire:(()=>void)|undefined;
 search.searchIndexTestHooks.now=()=>now;
 const timeout=setTimeout;
 vi.spyOn(globalThis,'setTimeout').mockImplementation(((callback:()=>void,ms:number,...args:unknown[])=>{
  if(ms>3600_000){delay=ms;fire=callback;return timeout(()=>{},1_000_000_000);}
  return Reflect.apply(timeout,globalThis,[callback,ms,...args]);
 }) as typeof setTimeout);
 search.searchIndexTestHooks.event=e=>{if(e.type==='ready')ready++;};
 vi.spyOn(console,'warn').mockImplementation(()=>{});
 search.startSearchIndex(db,file);await oracleUntil(()=>ready===1&&search.recovery(db).state==='HEALTHY','T-REC-WINDOW');
 const oldest=now;
 for(let i=1;i<=12;i++) {
  now+=3600_000;
  db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t',?,1,'user','text','canary','{}')").run('new'+i);
  search.syncMessageSearchRow(db,300+i,'canary');
  if(i<12)await oracleUntil(()=>ready===i+1&&search.recovery(db).state==='HEALTHY','T-REC-WINDOW');
  else await oracleUntil(()=>search.recovery(db).state==='THROTTLED','T-REC-WINDOW');
 }
 expect(search.recovery(db).windowCount,'ORACLE:T-REC-WINDOW').toBe(12);
 expect(delay,'ORACLE:T-REC-WINDOW').toBe(oldest+search.SEARCH_RECOVERY_WINDOW_MS-now);
 expect(ready,'ORACLE:T-REC-WINDOW').toBe(12);
 now=oldest+search.SEARCH_RECOVERY_WINDOW_MS;
 expect(fire,'ORACLE:T-REC-WINDOW').toBeTypeOf('function');
 fire!();await oracleUntil(()=>ready===13&&search.recovery(db).state==='HEALTHY','T-REC-WINDOW');
});
it('T-REC-DEFER: twenty refused retry acknowledgements spend no cycles or markers',{timeout:12000},async()=>{
 const {db,file}=fixture();workerFault.resetBusy=true;
 const original=ownerFirst.admit.bind(ownerFirst);let refuses=0,acks=0;const counts:number[]=[];
 vi.spyOn(ownerFirst,'admit').mockImplementation((...args:Parameters<typeof ownerFirst.admit>)=>{
  if(args[0]==='search-index-reset'&&acks===1&&refuses++<20){counts.push(search.recovery(db).consecutive);return{admitted:false,reason:'owner-turn',retryInMs:200};}
  return original(...args);
 });
 search.searchIndexTestHooks.event=e=>{if(e.type==='reset-ack')acks++;};
 search.startSearchIndex(db,file);
 await oracleUntil(()=>acks===2&&search.recovery(db).state==='HEALTHY','T-REC-DEFER',9000);
 expect(counts,'ORACLE:T-REC-DEFER').toEqual(Array(20).fill(1));
 expect(search.intentCount(db),'ORACLE:T-REC-DEFER').toBe(1);
});
it('T-REC-ONCE: reader-open failure consumes exactly one additional posted cycle',async()=>{
 const {db,file}=fixture();seed(db);const exec=DatabaseSync.prototype.exec;let failures=0;const counts:number[]=[];
 vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(this:DatabaseSync,sql:string){if(sql.includes('query_only=ON')&&failures++===0)throw Error('fixture reader open once');return exec.call(this,sql);});
 vi.spyOn(console,'warn').mockImplementation(()=>{});
 search.searchIndexTestHooks.event=e=>{if(e.type==='reset-ack')counts.push(search.recovery(db).consecutive);};
 search.startSearchIndex(db,file);await oracleUntil(()=>counts.length>=2&&search.recovery(db).state==='HEALTHY','T-REC-ONCE');
 expect(counts,'ORACLE:T-REC-ONCE').toEqual([1,2]);
});

// This helper deliberately has no oracle tag: construction failures must never
// inherit a behavioural tag from the currently executing test name.
function brokenFixture() { expect(false, 'fixture construction').toBe(true); }
it('T-RED-SETUP: shared setup assertions remain classifier-invalid',()=>{
 let failure:unknown;
 try { brokenFixture(); } catch(error) { failure=error; }
 expect(String(failure),'ORACLE:T-RED-SETUP').not.toContain('ORACLE:');
});
it('T-DISK-FULL: freeing SQLite quota ballast resumes without spending reset cycles',{timeout:12000},async()=>{
 const {db,file,dir}=fixture();seed(db);
 const shared=new SharedArrayBuffer(4);workerFault.diskFull=shared;
 const full:Int32Array=new Int32Array(shared);let failures=0;const delays:number[]=[];
 const warn=vi.spyOn(console,'warn').mockImplementation((...args)=>{if(args.some(value=>String(value).toLowerCase().includes('full')))failures++;});
 search.searchIndexTestHooks.event=e=>{if(e.type==='storage-full')delays.push(Number(e.retryInMs));};
 search.startSearchIndex(db,file);
 await until(()=>search.messageSearchIndexReady(db)&&!search.searchCleanupPending(db),5000);
 expect(search.messageSearchIndexReady(db),'fixture reader ready').toBe(true);
 const before=search.recovery(db),markers=search.intentCount(db);
 // Accelerate only the captured storage retries; keep their requested delays as evidence.
 const timeout=setTimeout;
 vi.spyOn(globalThis,'setTimeout').mockImplementation(((fn:()=>void,ms:number,...args:unknown[])=>
  Reflect.apply(timeout,globalThis,[fn,search.recovery(db).state==='THROTTLED'?Math.min(ms,20):ms,...args])) as typeof setTimeout);
 Atomics.store(full,0,1);
 const text='diskcanary '+randomBytes(32000).toString('base64');
 db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t','full',1,'user','text',?,'{}')").run(text);
 search.syncMessageSearchRow(db,301,text);
 await oracleUntil(()=>failures>=1,'T-DISK-FULL',5000);
 expect(search.recovery(db).state,'ORACLE:T-DISK-FULL').toBe('THROTTLED');
 await oracleUntil(()=>failures>=10,'T-DISK-FULL',5000);
 expect(search.recovery(db),'ORACLE:T-DISK-FULL').toEqual({...before,state:'THROTTLED'});
 expect(search.intentCount(db),'ORACLE:T-DISK-FULL').toBe(markers+1);
 expect(warn.mock.calls.filter(call=>String(call[1]).includes('full')).length,'ORACLE:T-DISK-FULL').toBe(failures);
 const a=new DatabaseSync(join(dir,'search.db'));cleanup.push(()=>a.close());
 a.exec('DROP TABLE fixture_ballast');
 await oracleUntil(()=>search.recovery(db).state==='HEALTHY'&&!search.searchCleanupPending(db),'T-DISK-FULL',5000);
 expect(a.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all(search.trigramQuery('diskcanary')),'ORACLE:T-DISK-FULL').toEqual([{rowid:301}]);
 expect(search.recovery(db).consecutive,'ORACLE:T-DISK-FULL').toBe(before.consecutive);
 console.log('DISK FULL',JSON.stringify({failures,delays,before,after:search.recovery(db)}));
});
it('T-ENOSPC: a full reset retries its retained marker automatically',{timeout:10000},async()=>{
 const {db,file}=fixture(),shared=new SharedArrayBuffer(4),full=new Int32Array(shared);Atomics.store(full,0,1);workerFault.enospc=shared;
 let failures=0;vi.spyOn(console,'warn').mockImplementation((...args)=>{if(args.some(value=>String(value).includes('ENOSPC')))failures++;});
 search.startSearchIndex(db,file);
 await oracleUntil(()=>failures>=2,'T-ENOSPC');
 expect(search.recovery(db),'ORACLE:T-ENOSPC').toMatchObject({state:'THROTTLED',consecutive:1,windowCount:1});
 expect(search.intentCount(db),'ORACLE:T-ENOSPC').toBe(1);
 search.searchIndexTestHooks.fence=()=>true;Atomics.store(full,0,0);
 await pause(500);
 expect(search.messageSearchIndexReady(db),'ORACLE:T-ENOSPC').toBe(false);
 search.searchIndexTestHooks.fence=defaultFence;
 await oracleUntil(()=>search.messageSearchIndexReady(db)&&search.recovery(db).state==='HEALTHY','T-ENOSPC');
 expect(search.intentCount(db),'ORACLE:T-ENOSPC').toBe(1);
});
