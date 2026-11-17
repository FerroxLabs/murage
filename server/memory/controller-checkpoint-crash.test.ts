// SPDX-License-Identifier: AGPL-3.0-or-later
// Crash fixture producer owner: recall-qual-h. Controller recovery consumer owner: recall-prod-x; MAIN integrates.
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database, transaction } from '../database.ts';
import { ioBudget } from '../io-budget.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { captureBranchChange, captureThreadDeletion } from './capture.ts';
import { ownerMemoryTicket } from './authority.ts';
import { forgetMemory } from './forget.ts';
import { setMemoryMode } from './repository.ts';
import { MemoryWorkerController } from './worker-controller.ts';
import { freshDataDir, THREAD } from './testing/recall-fixture.ts';
let controller:MemoryWorkerController;
beforeEach(()=>{
 freshDataDir('active');database().exec("UPDATE memory_lineage_cert SET ready=1,phase='done' WHERE id=1");
 database().prepare('INSERT OR REPLACE INTO memory_lineage_thread_ready(thread_id,ready) VALUES(?,1)').run(THREAD);
});
afterEach(async()=>{await controller?.stop();vi.restoreAllMocks();ioBudget.setIsIdle(()=>false);});
async function crash(cut:string){
 closeDatabase();const reached=join(DATA_DIR,'controller-crash-cut.json');
 const child=fork(join(import.meta.dirname,'testing/recall-qual-h-crash-child.ts'),[cut,reached],{execArgv:['--experimental-strip-types','--no-warnings'],env:{...process.env,MURAGE_DATA_DIR:DATA_DIR},stdio:['ignore','ignore','pipe','ipc']});
 let stderr='';child.stderr!.on('data',chunk=>{stderr+=String(chunk);});
 const deadline=setTimeout(()=>child.kill('SIGKILL'),30_000);
 const [code,signal]=await once(child,'exit').finally(()=>clearTimeout(deadline));
 expect({code,signal},stderr).toEqual({code:null,signal:'SIGKILL'});
 const trace=JSON.parse(readFileSync(reached,'utf8'));expect(trace.cut).toBe(cut);
 expect(new InternalCapabilities().resolve(`Bearer ${trace.token}`)).toBeNull();return trace as {jobId:string};
}
for(const cut of ['capture-committed','during-checkpoint-commit','checkpoint-committed']){
 it.each(['live','idle','off','paused','forget','deletion','branch-change'])(`${cut}: restarted controller obeys current %s authority`,async change=>{
  const {jobId}=await crash(cut),db=database();
  const debt=()=>db.prepare('SELECT * FROM memory_scope_bindings WHERE id=?').get('checkpoint-debt:'+jobId);
  const before=db.prepare('SELECT * FROM memory_checkpoint_publications').all();
  expect(before).toHaveLength(cut==='checkpoint-committed'?1:0);
  if(cut!=='checkpoint-committed')expect(debt()).toMatchObject({subject_id:'checkpoint-pending'});
  if(change==='idle')ioBudget.setIsIdle(()=>true);
  if(change==='off'||change==='paused')setMemoryMode(change);
  if(change==='forget')forgetMemory(ownerMemoryTicket(),{kind:'source',id:'message:thread:terminal'});
  if(change==='deletion')transaction(()=>captureThreadDeletion(db,THREAD));
  if(change==='branch-change')transaction(()=>captureBranchChange(db,THREAD,null));
  controller=new MemoryWorkerController();
  const state=controller as unknown as {tick():void;pendingProjection():boolean;spawnWithReset():void};
  vi.spyOn(state,'pendingProjection').mockReturnValue(false);vi.spyOn(state,'spawnWithReset').mockImplementation(()=>{});
  const completed=vi.spyOn(controller,'completedSource').mockImplementation(()=>{});
  ioBudget.withSource('memory-worker',()=>state.tick());
  if(cut==='checkpoint-committed'){
   expect(db.prepare('SELECT * FROM memory_checkpoint_publications').all()).toEqual(before);expect(debt()).toBeUndefined();expect(completed).not.toHaveBeenCalled();
  }else if(change==='live'){
   expect(db.prepare('SELECT * FROM memory_checkpoint_publications').all()).toHaveLength(1);expect(debt()).toBeUndefined();expect(completed).toHaveBeenCalledExactlyOnceWith(jobId);
  }else{
   expect(db.prepare('SELECT * FROM memory_checkpoint_publications').all()).toHaveLength(0);expect(completed).not.toHaveBeenCalled();
   if(['idle','off','paused'].includes(change))expect(debt()).toMatchObject({subject_id:'checkpoint-pending'});
  }
 });
}
