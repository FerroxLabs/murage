// SPDX-License-Identifier: AGPL-3.0-or-later
// Receipt consumer owner: recall-prod-x3; grant producer owner: scperf-p1.
// Window accounting for a large receipt drain: slices are sized from the last committed slice, a refused slice is not
// repeated blindly, and the controller waits for the next admission window only when no slice can fit.
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database, transaction as realTransaction } from '../database.ts';
import { appendMessage } from '../message-db.ts';
import { ioBudget } from '../io-budget.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { setMemoryMode } from './repository.ts';
import { BgDeferred, isBgDeferred } from '../bg-admission.ts';
import { stopWalMaintenance, walMaintenanceCounters } from '../wal-maintenance.ts';
import { stopSearchIndex } from '../message-search-index.ts';
import { MemoryWorkerController } from './worker-controller.ts';

type Attempt={rows:number;bytes:number;committed:boolean;window:number};
const probe=vi.hoisted(()=>({on:false,window:0,refuseAt:-1,attempts:[] as Array<{rows:number;bytes:number;committed:boolean;window:number}>}));
vi.mock('../database.ts',async original=>{
  const actual=await original<typeof import('../database.ts')>();
  const {ioBudget}=await import('../io-budget.ts');
  return {...actual,transaction:((operation:any)=>{
    if(!probe.on)return actual.transaction(operation);
    let rows=0,committed=false;
    const before=ioBudget.admissionState().bg;
    try{
      const result=actual.transaction(db=>{
        const count=()=>Number(db.prepare("SELECT count(*) n FROM memory_projection_receipts WHERE lexical_status='indexed'").get()!.n);
        const start=count();
        try{
          const result=operation(db);
          // A refusal after the row work: the slice rolls back having attempted `rows`, as a grant ceiling does.
          if(probe.refuseAt===probe.attempts.length)throw new BgDeferred(60_000);
          return result;
        }finally{rows=count()-start;}
      });
      committed=true;return result;
    }finally{probe.attempts.push({rows,bytes:Math.max(0,ioBudget.admissionState().bg-before),committed,window:probe.window});}
  }) as typeof actual.transaction};
});
type State={child:unknown;ready:boolean;indexing:boolean;indexRequestId:string|null;indexSent:Map<string,string>;later(step:()=>void,delay?:number):void;onWorkerMessage(child:unknown,event:unknown):void};
let controller:MemoryWorkerController,state:State;
beforeEach(async()=>{
  closeDatabase();await stopWalMaintenance();await stopSearchIndex();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});setMemoryMode('capture');
  appendMessage('thread',{id:'anchor',at:1,role:'user',kind:'text',text:'Fixture evidence.'});
  // The fixture rotates a closed admission ledger; a real-clock checkpointer must not race its minute resets.
  await stopWalMaintenance();await stopSearchIndex();
  controller=new MemoryWorkerController();state=controller as unknown as State;
  state.child={kill(){},on(){},send(){}};state.ready=true;
  probe.on=false;probe.window=0;probe.refuseAt=-1;probe.attempts=[];
});
afterEach(async()=>{probe.on=false;state.child=null;await controller.stop();closeDatabase();await stopWalMaintenance();await stopSearchIndex();vi.restoreAllMocks();});
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
// Drives the controller's own scheduler. A step queued for the next admission window flips the window (a closed fixture
// ledger, as the minute boundary would) before it runs; every other step runs at once.
async function drain(n:number){
  const records=seed(n),queue:Array<{step:()=>void;delay:number}>=[],waited=new Set<number>();
  const real=ioBudget.nextAdmissionMs.bind(ioBudget);
  vi.spyOn(ioBudget,'nextAdmissionMs').mockImplementation(()=>{const ms=real();waited.add(ms);return ms;});
  // The last seconds of an admission minute refuse background writes by wall time; start with a whole minute of margin.
  while(real()<45_000)await new Promise(resolve=>setTimeout(resolve,1000));
  expect(walMaintenanceCounters(),'the closed fixture ledger has no real-clock checkpointer').toBeNull();
  ioBudget.resetAdmissionForFixture();
  state.later=(step,delay=0)=>{queue.push({step,delay});};
  const waits:Array<{window:number;room:number}>=[],windows:number[]=[];
  let spent=0;
  const spend=()=>{const s=ioBudget.admissionState();return s.bg+s.debt;};
  probe.on=true;
  state.onWorkerMessage(state.child,{type:'index-result',requestId:'receipt',records,embeddingStatus:'indexed'});
  for(let i=0;queue.length&&i<2000;i++){
    const {step,delay}=queue.shift()!;
    if(delay>0&&waited.has(delay)){
      waits.push({window:probe.window,room:ioBudget.backgroundRoom()});
      spent+=spend();windows.push(spend());
      ioBudget.resetAdmissionForFixture();probe.window++;
    }
    // As the controller's own scheduler: the step runs under the worker's admission source.
    try{ioBudget.withSource('memory-worker',step);}catch(error){if(!isBgDeferred(error))throw error;queue.push({step,delay:real()});}
  }
  spent+=spend();windows.push(spend());probe.on=false;
  const indexed=Number(database().prepare("SELECT count(*) n FROM memory_projection_receipts WHERE lexical_status='indexed'").get()!.n);
  const perWindow=new Map<number,Attempt[]>();
  for(const a of probe.attempts)perWindow.set(a.window,[...(perWindow.get(a.window)??[]),a]);
  console.log(JSON.stringify({n,indexed,waits,windows,bytesPerRow:spent/n,commits:probe.attempts.filter(a=>a.committed).map(a=>({rows:a.rows,bytes:a.bytes,window:a.window})),refused:probe.attempts.filter(a=>!a.committed)}));
  return {indexed,waits,perWindow,spent,attempts:probe.attempts};
}
it('W1 a 30,000-receipt drain completes within two window waits, and never waits while two minimal commits still fit',async()=>{
  const result=await drain(30_000);
  expect(state.indexing).toBe(false);
  expect(result.indexed).toBe(30_000);
  expect(result.waits.length).toBeLessThanOrEqual(2);
  for(const wait of result.waits)expect(wait.room).toBeLessThan(768*1024);
  // The fixed bound above is a floor. The controller offers a slice half the room (at most 1 MiB) and sizes it with a 10% margin and
  // one page, so it must not wait while that grant still covers a slice this drain already committed (the final, partial one excluded).
  const sliced=result.attempts.filter(a=>a.committed).slice(0,-1);
  const cheapest=Math.min(...sliced.map(a=>a.bytes));
  expect(sliced.length).toBeGreaterThan(1);
  for(const wait of result.waits)expect(wait.room/2).toBeLessThan(cheapest*1.1+4096);
},180_000);
it('W2 a window never spends more than one slice on refused attempts, and refuses at most once',async()=>{
  const result=await drain(30_000);
  expect(result.indexed).toBe(30_000);
  for(const [,attempts] of result.perWindow){
    const refused=attempts.filter(a=>!a.committed),committed=attempts.filter(a=>a.committed);
    expect(refused.length).toBeLessThanOrEqual(1);
    const slice=Math.max(0,...committed.map(a=>a.bytes));
    expect(refused.reduce((n,a)=>n+a.bytes,0)).toBeLessThanOrEqual(slice);
  }
},180_000);
it('W3 the completed drain costs at most 480 bytes per row, copy debt and refused attempts included',async()=>{
  const result=await drain(30_000);
  expect(result.indexed).toBe(30_000);
  expect(result.spent/30_000).toBeLessThanOrEqual(480);
},180_000);
it.each([1,16,256])('W4 %i receipts commit in one slice with no refused attempt while room suffices',async n=>{
  const result=await drain(n);
  expect(result.indexed).toBe(n);
  expect(result.waits).toHaveLength(0);
  expect(result.attempts.filter(a=>!a.committed)).toHaveLength(0);
  const writes=result.attempts.length;
  expect(writes).toBe(1);
},180_000);
// Runs the controller's own steps at once (no window flip) until the batch ends.
async function runAll(n:number){
  const records=seed(n),queue:Array<()=>void>=[];
  while(ioBudget.nextAdmissionMs()<45_000)await new Promise(resolve=>setTimeout(resolve,1000));
  expect(walMaintenanceCounters(),'the closed fixture ledger has no real-clock checkpointer').toBeNull();
  ioBudget.resetAdmissionForFixture();
  state.later=step=>{queue.push(step);};
  probe.on=true;
  state.onWorkerMessage(state.child,{type:'index-result',requestId:'receipt',records,embeddingStatus:'indexed'});
  for(let i=0;queue.length&&i<200;i++){const step=queue.shift()!;try{ioBudget.withSource('memory-worker',step);}catch(error){if(!isBgDeferred(error))throw error;}}
  probe.on=false;
}
it('W5 a slice after a committed one never exceeds the grant its measured cost allows',async()=>{
  const room=1.2*1024*1024,grant=Math.floor(room/2);
  const real=ioBudget.backgroundRoom.bind(ioBudget);
  vi.spyOn(ioBudget,'backgroundRoom').mockImplementation(()=>probe.attempts.length>=1?room:real());
  await runAll(8000);
  const [first,second]=probe.attempts;
  expect(first!.committed).toBe(true);
  expect(second).toBeDefined();
  expect(second!.rows*(first!.bytes/first!.rows)).toBeLessThanOrEqual(grant);
},180_000);
it('W6 a refused slice keeps its halved size after an earlier commit, even when the fit would allow more',async()=>{
  probe.refuseAt=2;
  await runAll(8000);
  const refusedAt=probe.attempts.findIndex(a=>!a.committed),next=probe.attempts[refusedAt+1];
  expect(refusedAt).toBe(2);
  expect(next).toBeDefined();
  expect(next!.rows).toBeLessThanOrEqual(Math.floor(probe.attempts[refusedAt]!.rows/2));
},180_000);
