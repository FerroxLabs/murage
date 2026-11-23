// SPDX-License-Identifier: AGPL-3.0-or-later
// Debt/receipt producer owner: recall-fix-j. Controller/status consumer owner: recall-prod-x; MAIN integrates.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { database, closeDatabase, holdWritersForIndexBuild } from '../database.ts';
import { ioBudget } from '../io-budget.ts';
import { MemoryWorkerController } from './worker-controller.ts';
import { memoryHealth } from './health.ts';
import { captureWork } from './chunks.ts';
import { claimMemoryJob, publishMemoryWork } from './jobs.ts';
import { captureAndPublish, freshDataDir, THREAD } from './testing/recall-fixture.ts';
import { WritetimeFixture } from './testing/writetime-fixture.ts';
import { setMemoryMode } from './repository.ts';
import { ownerMemoryTicket } from './authority.ts';
import { memoryOwnerStatus } from './settings.ts';

let controller: MemoryWorkerController;
type State={tick():void;nextEligibleWorkAt:number;started:boolean;pendingProjection():boolean;spawnWithReset():void;resumeWake():void;checkpointCursor:bigint};
const state=()=>controller as unknown as State;
const marker=(id:string)=>database().prepare('SELECT * FROM memory_scope_bindings WHERE id=?').get('checkpoint-debt:'+id);
const receipts=()=>database().prepare('SELECT * FROM memory_checkpoint_publications').all();
function tick(){state().nextEligibleWorkAt=0;ioBudget.withSource('memory-worker',()=>state().tick());}
function captured(id='fixture-source'){return captureAndPublish('The fixture gate is green.',id);}
beforeEach(()=>{
 freshDataDir('active');new WritetimeFixture(database()).cert(true).ready(THREAD,true);
 database().exec("UPDATE memory_scopes SET audience='[]' WHERE id IN ('s-room','s-bot','s-other','s-project')");
 controller=new MemoryWorkerController();
 vi.spyOn(state(),'pendingProjection').mockReturnValue(false);
 vi.spyOn(state(),'spawnWithReset').mockImplementation(()=>{});
});
afterEach(async()=>{await controller.stop();vi.restoreAllMocks();ioBudget.setIsIdle(()=>false);});

it('ordinary admitted tick recovers complete capture debt before the empty queue return after reopen',()=>{
 const {jobId}=captured();closeDatabase();
 const completed=vi.spyOn(controller,'completedSource').mockImplementation(()=>{});
 tick();
 expect(receipts()).toHaveLength(1);expect(marker(jobId)).toBeUndefined();expect(completed).toHaveBeenCalledExactlyOnceWith(jobId);
 tick();expect(receipts()).toHaveLength(1);expect(completed).toHaveBeenCalledTimes(1);
});

it('pending debt is owed in runtime, health and existing backlog even with a complete job',()=>{
 captured();
 expect(controller.status()).toMatchObject({checkpointPending:true});
 expect(memoryHealth(null)).toMatchObject({checkpointPending:true});
 expect(memoryOwnerStatus(ownerMemoryTicket(),{memoryRosterRevision:1,bots:[{id:'bot',threadId:THREAD}],groups:[]}).backlog.pending).toBe(1);
 tick();expect(controller.status()).toMatchObject({checkpointPending:false});expect(memoryHealth(null)).toMatchObject({checkpointPending:false});
});

it('a refused marker does not starve newer debt and each page visits at most two markers with bigint rowids',()=>{
 const first=captured('fixture-first'),second=captured('fixture-second'),third=captured('fixture-third');
 const db=database();db.prepare("UPDATE memory_sources SET state='retired' WHERE id IN (?,?)").run(first.sourceId,second.sourceId);
 // memv2 E3: one thread's jobs share one marker; the per-job rows this paging is about are an older build's (no thread fields)
 for(const job of [first,second,third])db.prepare("INSERT OR REPLACE INTO memory_scope_bindings(id,scope_id,subject_type,subject_id,revision,state,intent) SELECT ?,scope_id,'system','checkpoint-pending',0,'granted',json_object('jobId',j.id,'sourceId',j.source_id,'revision',j.source_revision) FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE j.id=?").run('checkpoint-debt:'+job.jobId,job.jobId);
 const high=9007199254741000n;
 for(const [n,job] of [first,second,third].entries())db.prepare('UPDATE memory_scope_bindings SET rowid=? WHERE id=?').run(high+BigInt(n),'checkpoint-debt:'+job.jobId);
 const sqls:string[]=[];const prepare=db.prepare.bind(db);vi.spyOn(db,'prepare').mockImplementation(sql=>{sqls.push(sql);return prepare(sql);});
 tick();expect(receipts()).toHaveLength(0);expect(state().checkpointCursor).toBe(high+1n);
 // the third's roll covers its thread (E3) and drains the thread's refused rows with it (r4: the first stayed, refused at every pass)
 tick();expect(receipts()).toHaveLength(1);expect(marker(third.jobId)).toBeUndefined();expect(marker(first.jobId)).toBeUndefined();
 tick();expect(state().checkpointCursor).toBe(0n);
 expect(sqls.filter(sql=>sql.includes('ORDER BY rowid LIMIT 2'))).toHaveLength(3);
 expect(sqls.filter(sql=>sql.includes('ORDER BY rowid LIMIT 2')).every(sql=>sql.includes('INDEXED BY memory_bindings_subject'))).toBe(true);
});

it.each(['off','paused','idle','writer-hold'] as const)('current %s refusal preserves debt and never calls completion',async refusal=>{
 const {jobId}=captured(),before=marker(jobId);const completed=vi.spyOn(controller,'completedSource').mockImplementation(()=>{});
 let release:(()=>void)|undefined;
 if(refusal==='off'||refusal==='paused')setMemoryMode(refusal);
 if(refusal==='idle')ioBudget.setIsIdle(()=>true);
 if(refusal==='writer-hold'){holdWritersForIndexBuild(true);release=()=>holdWritersForIndexBuild(false);}
 try{tick();expect(marker(jobId)).toEqual(before);expect(receipts()).toHaveLength(0);expect(completed).not.toHaveBeenCalled();expect(controller.status()).toMatchObject({checkpointPending:true});}
 finally{release?.();}
});

it.each(['identity','scope','revision','job','oversize'] as const)('point revalidation refuses a forged %s marker without acknowledging it',kind=>{
 const {jobId}=captured(),db=database();
 if(kind==='identity')db.prepare("UPDATE memory_scope_bindings SET id='checkpoint-debt:other' WHERE id=?").run('checkpoint-debt:'+jobId);
 else if(kind==='scope')db.prepare("UPDATE memory_scope_bindings SET scope_id='s-room' WHERE id=?").run('checkpoint-debt:'+jobId);
 else db.prepare('UPDATE memory_scope_bindings SET intent=? WHERE id=?').run(JSON.stringify(kind==='oversize'?{extra:'x'.repeat(5000)}:{jobId:kind==='job'?'other':jobId,sourceId:'fixture-source',revision:99}),'checkpoint-debt:'+jobId);
 tick();expect(receipts()).toHaveLength(0);expect(controller.status()).toMatchObject({checkpointPending:true});
});

it('checking preserves the exact pending marker and completion waits for a successful committed receipt',()=>{
 const {jobId}=captured(),before=marker(jobId),db=database();
 new WritetimeFixture(db).pendingScope(String(before!.scope_id),0,7).job(7,1_000_000);
 const completed=vi.spyOn(controller,'completedSource').mockImplementation(()=>{});
 tick();expect(marker(jobId)).toEqual(before);expect(completed).not.toHaveBeenCalled();
 db.exec('DELETE FROM memory_deny_pending_scope; DELETE FROM memory_revoke_jobs');
 tick();tick();expect(marker(jobId)).toBeUndefined();expect(completed).toHaveBeenCalledExactlyOnceWith(jobId);
});

it('a committed disposition drains debt without reporting a successful checkpoint to downstream hooks',()=>{
 const {jobId}=captured();database().prepare("UPDATE memory_sources SET kind='turn' WHERE id='fixture-source'").run();
 const completed=vi.spyOn(controller,'completedSource').mockImplementation(()=>{});
 tick();expect(marker(jobId)).toMatchObject({subject_id:'checkpoint-disposition',state:'revoked'});expect(receipts()).toHaveLength(0);expect(completed).not.toHaveBeenCalled();
 expect(controller.status()).toMatchObject({checkpointPending:false});
});

it('positive predicted room supplies no authority when current BG admission refuses',()=>{
 const {jobId}=captured(),before=marker(jobId);
 ioBudget.setIsIdle(()=>true);
 vi.spyOn(ioBudget,'backgroundRoom').mockReturnValue(1024*1024);
 tick();expect(marker(jobId)).toEqual(before);expect(receipts()).toHaveLength(0);
});

it('a failed checkpoint transaction retains exact debt and does not notify downstream completion',()=>{
 const {jobId}=captured(),before=marker(jobId),db=database();
 db.exec("CREATE TEMP TRIGGER fixture_checkpoint_failure BEFORE INSERT ON memory_checkpoint_publications BEGIN SELECT RAISE(ABORT,'fixture checkpoint failed'); END");
 const completed=vi.spyOn(controller,'completedSource').mockImplementation(()=>{});
 tick();expect(marker(jobId)).toEqual(before);expect(receipts()).toHaveLength(0);expect(completed).not.toHaveBeenCalled();
 expect(controller.status().error).toBe('MEMORY_CHECKPOINT_FAILED');
 db.exec('DROP TRIGGER fixture_checkpoint_failure');tick();tick();
 expect(marker(jobId)).toBeUndefined();expect(completed).toHaveBeenCalledExactlyOnceWith(jobId);
});

it('start and resumeWake drive debt without helper callback maps after restart',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval']});
 try{
  const {jobId}=captured();
  vi.spyOn(controller as unknown as {independentWork():void},'independentWork').mockImplementation(()=>{});
  controller.start();await vi.advanceTimersByTimeAsync(0);
  expect(marker(jobId)).toBeUndefined();expect(receipts()).toHaveLength(1);
  const next=captured('fixture-next');state().nextEligibleWorkAt=0;
  state().resumeWake();await vi.advanceTimersByTimeAsync(0);
  expect(marker(next.jobId)).toBeTruthy();
  await vi.advanceTimersByTimeAsync(500);
  expect(marker(next.jobId)).toBeUndefined();expect(receipts()).toHaveLength(2);
 }finally{await controller.stop();vi.useRealTimers();}
});


it('ordinary recovery retains large completed sources without borrowing the terminal-only payload cap',()=>{
 const {jobId}=captureAndPublish('x'.repeat(3*65536),'fixture-large-source');
 for(let n=0;n<2;n++){
  const work=claimMemoryJob('fixture')!;expect(work).toBeTruthy();expect(work.id).toBe(jobId);
  expect(Buffer.byteLength(work.text)).toBeLessThanOrEqual(65536);
  publishMemoryWork(work,'fixture',captureWork(work));
 }
 expect(database().prepare('SELECT status FROM memory_jobs WHERE id=?').get(jobId)).toMatchObject({status:'complete'});
 const completed=vi.spyOn(controller,'completedSource').mockImplementation(()=>{});
 tick();expect(marker(jobId)).toBeUndefined();expect(receipts()).toHaveLength(1);expect(completed).toHaveBeenCalledExactlyOnceWith(jobId);
});
