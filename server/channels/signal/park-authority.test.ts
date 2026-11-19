import { privateParkDirectory, parkProtocolOptions, parkFixtureMkdir as mkdirSync, parkFixtureWrite as writeFileSync, protectParkFixtureTree } from '../../testing/signal-park-fixture.ts';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { DATA_DIR } from '../../config.ts';
import { closeDatabase, database } from '../../database.ts';
import { stopWalMaintenance } from '../../wal-maintenance.ts';
import { stopSearchIndex } from '../../message-search-index.ts';
import { RoutineManager, type RoutineManagerOptions } from '../../routines.ts';
import { signalHumanBindings, observeVerifiedHuman, linkHumanBinding, resolveHumanBinding } from '../../human-principals.ts';
import { ownerMemoryTicket } from '../../memory/authority.ts';
import { removeTempDirSync } from '../../testing/cleanup.ts';
import { createSignalLocalAuthority, hasEarlierSignalAuthority } from './park-authority.ts';
import { parkSignalForDowngrade } from './park.ts';
import { ParkFs } from './park-fs.ts';
import * as atomic from '../../atomic.ts';
import * as people from '../../human-principals.ts';
import { keepBothAndLinkAgain, replaySignalReplacements } from './park-replacement.ts';
const fence={lease:()=> 'fixture-lease',discover:()=>true,host:()=> 'fixture',boot:()=> 'boot',uptime:()=>1};
const managers:RoutineManager[]=[];
function fixtureAuthority(manager: RoutineManager, fence: () => void) {
 const authority=createSignalLocalAuthority(DATA_DIR,manager,fence),flush=authority.flush;
 authority.flush=async()=>{
  if(process.platform!=='win32')return flush();
  // Protect generated fixture stores only when the authority actually flushes
  // them. A missing product flush must still fail this witness.
  const realFlush=atomic.flushCoalesced;
  const flushed=vi.spyOn(atomic,'flushCoalesced').mockImplementation(()=>{
   realFlush();protectParkFixtureTree(DATA_DIR);
  });
  const barrier=ParkFs.prototype.barrier;
  const spy=vi.spyOn(ParkFs.prototype,'barrier').mockImplementation(function(this: ParkFs,dir,required){
   this.options.sync ??= parkProtocolOptions.sync;
   return barrier.call(this,dir,required);
  });
  try{await flush();}finally{spy.mockRestore();flushed.mockRestore();}
 };
 return authority;
}

async function closeFixtureStores(){
 managers.forEach(manager=>manager.stop());
 closeDatabase();
 // stop() fences routine dispatch; closeDatabase() only requests the worker
 // closes. Join both SQLite workers before inspecting or protecting the tree.
 expect(await stopWalMaintenance()).toBe(true);expect(await stopSearchIndex()).toBe(true);
}
afterEach(async()=>{vi.restoreAllMocks();await closeFixtureStores();managers.length=0;});
function put(file:string, value:unknown){mkdirSync(dirname(file),{recursive:true,mode:0o700});writeFileSync(file,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});}

function flushFixture() {
 closeDatabase();removeTempDirSync(DATA_DIR);privateParkDirectory(DATA_DIR);
 const manager=new RoutineManager({file:join(DATA_DIR,'routines.json'),emit:()=>{},botState:()=> 'ready',goalState:()=> 'ready',
  createTask:()=>({threadId:randomUUID()}),startTurn:async()=>{},interruptTurn:async()=>{},isChannelCurrent:()=>true});
 managers.push(manager);
 return {db:database(),authority:fixtureAuthority(manager,()=>{})};
}

test('Signal authority flush retries a concurrent checkpoint and still requires the real durable checkpoint',async()=>{
 const {db,authority}=flushFixture(),prepare=db.prepare.bind(db);let checkpoints=0;
 vi.spyOn(db,'prepare').mockImplementation(sql=>{
  if(sql==='PRAGMA wal_checkpoint(FULL)'&&checkpoints++===0)return {get:()=>({busy:1,log:-1,checkpointed:-1})} as unknown as ReturnType<typeof db.prepare>;
  return prepare(sql);
 });
 await authority.flush();
 expect(checkpoints).toBeGreaterThanOrEqual(2);
});

test('Signal authority flush refuses a persistent checkpoint hold instead of claiming durable revocation',async()=>{
 const {db,authority}=flushFixture(),prepare=db.prepare.bind(db);let checkpoints=0;
 vi.spyOn(db,'prepare').mockImplementation(sql=>{
  if(sql==='PRAGMA wal_checkpoint(FULL)'){checkpoints++;return {get:()=>({busy:1,log:-1,checkpointed:-1})} as unknown as ReturnType<typeof db.prepare>;}
  return prepare(sql);
 });
 await expect(authority.flush()).rejects.toThrow('Signal authority save is held');
 expect(checkpoints).toBeGreaterThan(1);
});

test('RED34 real people and routine stores revoke active authority and cancel running/queued work before fresh record; RED36 replay survives store reversal',async()=>{
 closeDatabase();removeTempDirSync(DATA_DIR);privateParkDirectory(DATA_DIR);
 put(join(DATA_DIR,'install-id.json'),{installId:randomUUID()});
 put(join(DATA_DIR,'channels/signal/connection.json'),{version:1,connectionId:'old',generation:3,enabled:false,paused:true,revoking:true,binding:null,account:null});
 put(join(DATA_DIR,'signal/auth/key'),'FAKE-CREDENTIAL-BYTES');put(join(DATA_DIR,'channels/signal/old/receipts.json'),'FAKE-RECEIPT-BYTES');
 parkSignalForDowngrade(DATA_DIR,{...parkProtocolOptions,fence});
 const origin={platform:'signal' as const,authorityId:'11111111-1111-4111-8111-111111111111',userId:'11111111-1111-4111-8111-111111111111',connectionId:'old'};
 const bindingId=observeVerifiedHuman(origin);linkHumanBinding(ownerMemoryTicket(),{bindingId,expectedRevision:1,as:'owner'});
 const principal=resolveHumanBinding(bindingId);
 let open=true;const start=vi.fn(async()=>{}),interrupt=vi.fn(async()=>{});
 const options:RoutineManagerOptions={file:join(DATA_DIR,'routines.json'),emit:()=>{},botState:()=> 'ready',goalState:()=> 'ready',
  createTask:()=>({threadId:randomUUID()}),startTurn:start,interruptTurn:interrupt,isChannelCurrent:()=>true,dispatchOpen:()=>open};
 const manager=new RoutineManager(options);managers.push(manager);
 const enqueue=(deliveryId:string)=>manager.enqueueWebhook({webhookId:deliveryId,webhookName:'Signal fixture',prompt:'FAKE work',botId:deliveryId,runOn:'ember',deliveryId,receivedAt:Date.now(),channelOrigin:{platform:'signal',connectionId:'old'},humanPrincipal:principal});
 const running=enqueue('running');await manager.tick();expect(manager.listRuns().find(run=>run.id===running.id)?.status).toBe('running');expect(start).toHaveBeenCalledTimes(1);
 open=false;const queued=enqueue('queued');await manager.tick();expect(manager.listRuns().find(run=>run.id===queued.id)?.status).toBe('queued');
 expect(hasEarlierSignalAuthority(manager,'fresh')).toBe(true);expect(hasEarlierSignalAuthority(manager,'old')).toBe(false);
 const authority=fixtureAuthority(manager,()=>{open=false;});
 const inventory=authority.inventory();expect(inventory.connectionIds).toContain('old');expect(inventory.runIds).toEqual(expect.arrayContaining([running.id,queued.id]));
 const savedPeople=signalHumanBindings(ownerMemoryTicket());expect(savedPeople.some(row=>row.active)).toBe(true);
 let result;try{result=await keepBothAndLinkAgain(DATA_DIR,authority,{...parkProtocolOptions,fence,after:(operation,path)=>{
  if(operation==='write'&&path===join(DATA_DIR,'channels/signal/connection.json')){
   expect(signalHumanBindings(ownerMemoryTicket()).every(row=>!row.active)).toBe(true);
   for(const run of manager.listRuns()){expect(run.status).toBe('cancelled');expect(run.eventBudget?.closed).toBe(true);}
  }
 }});}catch(error){
  console.error('RED34 keepBothAndLinkAgain original error before cancellation witness:',error);
  throw error;
 }finally{
  // Behavioral witness: even if verification refuses the mutant first, retain
  // the unfinished run/budget assertion before any fresh linking can happen.
  for(const run of manager.listRuns()){expect(run.status,'unfinished Signal run before fresh linking').toBe('cancelled');expect(run.eventBudget?.closed,'old event budget before fresh linking').toBe(true);}
 }
 expect(result.state).toBe('ready');expect(hasEarlierSignalAuthority(manager,'fresh')).toBe(false);expect(start).toHaveBeenCalledTimes(1);expect(interrupt).toHaveBeenCalledTimes(1);
 const bundle=join(DATA_DIR,'recovery-quarantine/signal-parked/old.g3');
 expect(readFileSync(join(bundle,'signal/auth/key'),'utf8')).toBe('FAKE-CREDENTIAL-BYTES');
 expect(readFileSync(join(bundle,'channels-signal/old/receipts.json'),'utf8')).toBe('FAKE-RECEIPT-BYTES');
 manager.stop();const restarted=new RoutineManager(options);managers.push(restarted);
 expect(restarted.listRuns().filter(run=>[running.id,queued.id].includes(run.id)).every(run=>run.status==='cancelled'&&run.eventBudget?.closed)).toBe(true);
 // A normal verified observation can reactivate an old row after a reverted store.
 observeVerifiedHuman(origin);expect(signalHumanBindings(ownerMemoryTicket()).some(row=>row.active)).toBe(true);
 await replaySignalReplacements(DATA_DIR,fixtureAuthority(restarted,()=>{open=false;}),{...parkProtocolOptions,fence});
 expect(signalHumanBindings(ownerMemoryTicket()).every(row=>!row.active)).toBe(true);await restarted.tick();expect(start).toHaveBeenCalledTimes(1);
 // Completed Keep both also permits later synchronous downgrade with the real
 // persisted people and run journals, while keeping its replay obligations.
 await closeFixtureStores();protectParkFixtureTree(DATA_DIR);expect(()=>parkSignalForDowngrade(DATA_DIR,{...parkProtocolOptions,fence})).not.toThrow();
});

test('RED20 native authority checkpoint preserves the host directory durability verdict',async()=>{
 const {db}=flushFixture();
 atomic.flushCoalesced();protectParkFixtureTree(DATA_DIR);
 const authority=createSignalLocalAuthority(DATA_DIR,managers[managers.length-1]!,()=>{});
 await expect(authority.flush()).resolves.toBeUndefined();
 const checkpoint=db.prepare('PRAGMA wal_checkpoint(FULL)').get() as {busy:number;log:number;checkpointed:number};
 expect(checkpoint.busy).toBe(0);expect(checkpoint.log).toBe(checkpoint.checkpointed);
});

for(const failure of ['people-save','held-interrupt'] as const)test(`all old Signal runs and budgets close before ${failure} can hold revocation`,async()=>{
 closeDatabase();removeTempDirSync(DATA_DIR);privateParkDirectory(DATA_DIR);
 const origin={platform:'signal' as const,authorityId:'11111111-1111-4111-8111-111111111111',userId:'11111111-1111-4111-8111-111111111111',connectionId:'old'};
 const bindingId=observeVerifiedHuman(origin);linkHumanBinding(ownerMemoryTicket(),{bindingId,expectedRevision:1,as:'owner'});
 const principal=resolveHumanBinding(bindingId);
 let open=true,release!:()=>void;
 const hold=new Promise<void>(resolve=>{release=resolve;});
 const manager=new RoutineManager({file:join(DATA_DIR,'routines.json'),emit:()=>{},botState:()=> 'ready',goalState:()=> 'ready',
  createTask:()=>({threadId:randomUUID()}),startTurn:async()=>{},interruptTurn:async()=>{if(failure==='held-interrupt')await hold;},isChannelCurrent:()=>true,dispatchOpen:()=>open});
 managers.push(manager);
 const enqueue=(id:string)=>manager.enqueueWebhook({webhookId:id,webhookName:'Signal fixture',prompt:'FAKE work',botId:id,runOn:'ember',deliveryId:id,receivedAt:Date.now(),channelOrigin:{platform:'signal',connectionId:'old'},humanPrincipal:principal});
 const running=enqueue('running');await manager.tick();open=false;const queued=enqueue('queued');
 const original=new Error('people save failed');
 if(failure==='people-save')vi.spyOn(people,'revokeHumanConnection').mockImplementation(()=>{throw original;});
 const authority=createSignalLocalAuthority(DATA_DIR,manager,()=>{open=false;});
 const pending=authority.revoke(['old'],[running.id,queued.id]);void pending.catch(()=>{});
 try{for(const run of manager.listRuns()){expect(run.status).toBe('cancelled');expect(run.eventBudget?.closed).toBe(true);}}
 finally{release();await pending.catch(()=>{});}
 if(failure==='people-save')await expect(pending).rejects.toBe(original);else await pending;
 expect(authority.verify(['old'],[running.id,queued.id])).toBe(failure!=='people-save');
});
