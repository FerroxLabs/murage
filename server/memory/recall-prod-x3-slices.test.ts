// SPDX-License-Identifier: AGPL-3.0-or-later
// Receipt consumer owner: recall-prod-x3; grant producer owner: scperf-p1.
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database, transaction as realTransaction } from '../database.ts';
import { appendMessage } from '../message-db.ts';
import { stopSearchIndex } from '../message-search-index.ts';
import { ioBudget } from '../io-budget.ts';
import { checkpointTruncate } from '../sqlite-checkpoint.ts';
import * as walMaintenance from '../wal-maintenance.ts';
import { stopWalMaintenance } from '../wal-maintenance.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { setMemoryMode } from './repository.ts';
import { MemoryWorkerController, workerSliceTestHooks } from './worker-controller.ts';

const probe=vi.hoisted(()=>({on:false,refuse:false,refuseBegin:false,bg:[] as number[],attempts:[] as Array<{rows:number;bytes:number;committed:boolean}>,cpu:[] as number[]}));
vi.mock('../database.ts',async original=>{
  const actual=await original<typeof import('../database.ts')>();
  const {ioBudget}=await import('../io-budget.ts');
  const {BgDeferred}=await import('../bg-admission.ts');
  return {...actual,transaction:((operation:any)=>{
    if(!probe.on)return actual.transaction(operation);
    let rows=0,committed=false;
    const before=ioBudget.admissionState().bg;probe.bg.push(before);
    try{
      if(probe.refuseBegin){probe.refuseBegin=false;throw new BgDeferred(3000);}
      const result=actual.transaction(db=>{
        const count=()=>Number(db.prepare("SELECT count(*) n FROM memory_projection_receipts WHERE lexical_status='indexed'").get()!.n);
        const start=count();
        try{return operation(db);}finally{rows=count()-start;if(probe.refuse){probe.refuse=false;throw new BgDeferred(1);}}
      });
      committed=true;return result;
    }finally{probe.attempts.push({rows,bytes:Math.max(0,ioBudget.admissionState().bg-before),committed});probe.bg.push(ioBudget.admissionState().bg);}
  }) as typeof actual.transaction};
});
type State={child:unknown;ready:boolean;indexing:boolean;indexRequestId:string|null;indexSent:Map<string,string>;later(step:()=>void,delay?:number):void;onWorkerMessage(child:unknown,event:unknown):void};
let controller:MemoryWorkerController,state:State;
beforeEach(()=>{
  closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});setMemoryMode('capture');
  appendMessage('thread',{id:'anchor',at:1,role:'user',kind:'text',text:'Fixture evidence.'});
  controller=new MemoryWorkerController();state=controller as unknown as State;
  state.child={kill(){},on(){},send(){}};state.ready=true;
  probe.on=false;probe.refuse=false;probe.refuseBegin=false;probe.bg=[];probe.attempts=[];probe.cpu=[];
  workerSliceTestHooks.rowWorkCpuMs=ms=>{if(probe.on)probe.cpu.push(ms);};
});
afterEach(async()=>{probe.on=false;workerSliceTestHooks.rowWorkCpuMs=null;state.child=null;await controller.stop();vi.restoreAllMocks();});
function seed(n:number){
  const db=database(),scope=String(db.prepare('SELECT id FROM memory_scopes LIMIT 1').get()!.id);
  const records=Array.from({length:n},(_,i)=>({id:`r${i}`,version:1,deleted:false}));
  realTransaction(()=>{
    const record=db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES(?,1,?,'fact','t','a','active',0,0)");
    const receipt=db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,0,'pending','pending',NULL)");
    for(const row of records){record.run(row.id,scope);receipt.run(row.id);}
  });
  state.indexing=true;state.indexRequestId='receipt';state.indexSent=new Map(records.map(row=>[`${row.id}\u00001`,'active']));
  return records;
}
async function settleSeedWrites(){
  // Finish fixture writes before measuring the drain or controlling admission retries.
  while(!checkpointTruncate(database(),'fixture'))await new Promise<void>(resolve=>setTimeout(resolve,10));
  ioBudget.resetAdmissionForFixture();
}
it('30,000 receipts cost at most 350 bytes per row and each slice uses at most 10 ms row CPU',async()=>{
  const records=seed(30_000);
  await settleSeedWrites();
  expect(statSync(join(DATA_DIR,'messages.db-wal')).size).toBe(0);
  const initial=ioBudget.admissionState();probe.on=true;
  expect(initial).toEqual({bg:0,debt:0,total:0,reserved:0,idleUsed:0});
  state.onWorkerMessage(state.child,{type:'index-result',requestId:'receipt',records,embeddingStatus:'indexed'});
  const deadline=Date.now()+60_000;
  while(state.indexing&&Date.now()<deadline)await new Promise<void>(resolve=>setImmediate(resolve));
  probe.on=false;
  const admission=ioBudget.admissionState();probe.bg.push(admission.bg);
  const bytes=probe.bg.reduce((n,bg,i)=>n+(i?Math.max(0,bg-probe.bg[i-1]!):0),0);
  console.log(JSON.stringify({rows:30_000,bytesPerRow:bytes/30_000,rowCpuMax:Math.max(...probe.cpu),initial,admission,cpu:probe.cpu,attempts:probe.attempts}));
  expect(Math.max(...probe.cpu)).toBeLessThanOrEqual(10);
  expect(probe.cpu).toHaveLength(probe.attempts.length);
  expect(state.indexing).toBe(false);
  expect(database().prepare("SELECT count(*) n FROM memory_projection_receipts WHERE lexical_status='indexed'").get()!.n).toBe(30_000);
  expect(bytes/30_000).toBeLessThanOrEqual(350);
},120_000);
it('a refused slice restores 2048 on the next good commit within the same minute',()=>{
  const records=seed(6_000),pending:Array<()=>void>=[];
  state.later=step=>{pending.push(step);};
  vi.spyOn(ioBudget,'nextAdmissionMs').mockReturnValue(1000);
  vi.spyOn(Date,'now').mockReturnValue(Date.now());
  // The clock between JSON pages is held still to make the row-cap assertion deterministic.
  vi.spyOn(performance,'now').mockReturnValue(performance.now());
  probe.on=true;probe.refuse=true;
  state.onWorkerMessage(state.child,{type:'index-result',requestId:'receipt',records,embeddingStatus:'indexed'});
  for(let i=0;pending.length&&i<20;i++)pending.shift()!();
  probe.on=false;
  expect(state.indexing).toBe(false);
  expect(probe.attempts[0]).toMatchObject({rows:2048,committed:false});
  expect(probe.attempts[1]).toMatchObject({rows:1024,committed:true});
  expect(probe.attempts[2]).toMatchObject({rows:2048,committed:true});
  expect(probe.cpu).toHaveLength(probe.attempts.length);
});
it('a slice refused after a committed slice retries at half its size, then restores 2048',async()=>{
  const records=seed(8_000),pending:Array<()=>void>=[];
  let signal!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>{signal=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const realWalStop=stopWalMaintenance,realSearchStop=stopSearchIndex;
  vi.spyOn(walMaintenance,'stopWalMaintenance').mockImplementationOnce(async()=>{
    const exited=await realWalStop();expect(await realSearchStop()).toBe(true);
    signal();await gate;return exited;
  });
  const workflow=(async()=>{
    // Real-clock workers must exit before this manual scheduler freezes the fixture minute.
    expect(await stopWalMaintenance()).toBe(true); expect(await stopSearchIndex()).toBe(true);
    await settleSeedWrites();
    expect(statSync(join(DATA_DIR,'messages.db-wal')).size).toBe(0);
    expect(ioBudget.admissionState()).toEqual({bg:0,debt:0,total:0,reserved:0,idleUsed:0});
    state.later=step=>{pending.push(step);};
    vi.spyOn(ioBudget,'nextAdmissionMs').mockReturnValue(1000);
    vi.spyOn(Date,'now').mockReturnValue(Math.floor(Date.now()/60_000)*60_000+30_000);
    // The clock between JSON pages is held still to make the row-cap assertion deterministic.
    vi.spyOn(performance,'now').mockReturnValue(performance.now());
    // As the controller's own scheduler: each step runs under the worker's admission source, so its bytes are measured.
    const run=()=>ioBudget.withSource('memory-worker',pending.shift()!);
    probe.on=true;
    state.onWorkerMessage(state.child,{type:'index-result',requestId:'receipt',records,embeddingStatus:'indexed'});
    run();
    expect(probe.attempts[0]).toMatchObject({rows:2048,committed:true});
    expect(probe.attempts[0]!.bytes).toBeGreaterThan(0);
    probe.refuse=true;
    for(let i=0;pending.length&&i<20;i++)run();
    probe.on=false;
    expect(state.indexing).toBe(false);
    expect(probe.attempts[1]).toMatchObject({rows:2048,committed:false});
    expect(probe.attempts[2]).toMatchObject({rows:1024,committed:true});
    expect(probe.attempts[3]).toMatchObject({rows:2048,committed:true});
    expect(database().prepare("SELECT count(*) n FROM memory_projection_receipts WHERE lexical_status='indexed'").get()!.n).toBe(8_000);
  })();
  const result=workflow.catch(()=>{});
  try{
    await Promise.race([entered,workflow.then(()=>entered)]);
    await new Promise<void>(resolve=>setImmediate(resolve));
    expect(vi.isMockFunction(Date.now),'manual clock must wait for the pending shutdown acknowledgement').toBe(false);
    expect(probe.on).toBe(false);
  }finally{release();await result;}
  await workflow;
});
it('live acknowledgements retain delete-pending debt and skip records never sent',()=>{
  const records=seed(3),db=database(),pending:Array<()=>void>=[];
  db.prepare("UPDATE memory_projection_receipts SET lexical_status='delete-pending' WHERE record_id=?").run(records[0]!.id);
  state.indexSent.delete(`${records[1]!.id}\u00001`);
  state.later=step=>{pending.push(step);};
  state.onWorkerMessage(state.child,{type:'index-result',requestId:'receipt',records,embeddingStatus:'indexed'});
  while(pending.length)pending.shift()!();
  expect(db.prepare('SELECT lexical_status FROM memory_projection_receipts ORDER BY record_id').all().map(r=>r.lexical_status)).toEqual(['delete-pending','pending','indexed']);
});

it.each([1,16,256])('WAL-deferred receipt history %i requests one checkpoint and retries at admission, never 250 ms',n=>{
  const records=seed(n),pending:Array<{step:()=>void;delay:number}>=[];
  state.later=(step,delay=0)=>{pending.push({step,delay});};
  vi.spyOn(ioBudget,'nextAdmissionMs').mockReturnValue(2000);
  const checkpoint=vi.spyOn(controller,'requestCheckpoint').mockResolvedValue(false);
  probe.on=true;probe.refuseBegin=true;
  state.onWorkerMessage(state.child,{type:'index-result',requestId:'receipt',records,embeddingStatus:'indexed'});
  pending.shift()!.step();
  expect(checkpoint).toHaveBeenCalledTimes(1);
  expect(pending).toHaveLength(1);expect(pending[0]!.delay).toBe(3000);
  expect(probe.cpu).toEqual([0]);
  pending.shift()!.step();probe.on=false;
  expect(state.indexing).toBe(false);expect(checkpoint).toHaveBeenCalledTimes(1);
});
it('a live acknowledgement cannot overwrite the receipt when the sent state changed',()=>{
  const records=seed(1),pending:Array<()=>void>=[];
  database().prepare("UPDATE memory_records SET state='archived' WHERE id=?").run(records[0]!.id);
  state.later=step=>{pending.push(step);};
  state.onWorkerMessage(state.child,{type:'index-result',requestId:'receipt',records,embeddingStatus:'indexed'});
  while(pending.length)pending.shift()!();
  expect(database().prepare('SELECT lexical_status FROM memory_projection_receipts').get()!.lexical_status).toBe('pending');
});
it.each([1,16,256])('%i receipts use a set-based statement with the same row fences',n=>{
  const records=seed(n),pending:Array<()=>void>=[];
  state.later=step=>{pending.push(step);};
  vi.spyOn(performance,'now').mockReturnValue(performance.now());
  const prepare=vi.spyOn(database(),'prepare');
  state.onWorkerMessage(state.child,{type:'index-result',requestId:'receipt',records,embeddingStatus:'indexed'});
  while(pending.length)pending.shift()!();
  const writes=prepare.mock.calls.filter(([sql])=>sql.startsWith('UPDATE memory_projection_receipts'));
  expect(writes).toHaveLength(1);expect(writes[0]![0]).toContain('json_each(?)');
  expect(database().prepare("SELECT count(*) n FROM memory_projection_receipts WHERE lexical_status='indexed'").get()!.n).toBe(n);
});
