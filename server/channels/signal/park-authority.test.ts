import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { DATA_DIR } from '../../config.ts';
import { closeDatabase } from '../../database.ts';
import { RoutineManager, type RoutineManagerOptions } from '../../routines.ts';
import { signalHumanBindings, observeVerifiedHuman, linkHumanBinding, resolveHumanBinding } from '../../human-principals.ts';
import { ownerMemoryTicket } from '../../memory/authority.ts';
import { removeTempDirSync } from '../../testing/cleanup.ts';
import { createSignalLocalAuthority, hasEarlierSignalAuthority } from './park-authority.ts';
import { parkSignalForDowngrade } from './park.ts';
import { keepBothAndLinkAgain, replaySignalReplacements } from './park-replacement.ts';
const fence={lease:()=> 'fixture-lease',discover:()=>true,host:()=> 'fixture',boot:()=> 'boot',uptime:()=>1};
const managers:RoutineManager[]=[];
afterEach(()=>{managers.splice(0).forEach(manager=>manager.stop());closeDatabase();});
function put(file:string, value:unknown){mkdirSync(dirname(file),{recursive:true,mode:0o700});writeFileSync(file,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});}

test('RED34 real people and routine stores revoke active authority and cancel running/queued work before fresh record; RED36 replay survives store reversal',async()=>{
 closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true,mode:0o700});
 put(join(DATA_DIR,'install-id.json'),{installId:randomUUID()});
 put(join(DATA_DIR,'channels/signal/connection.json'),{version:1,connectionId:'old',generation:3,enabled:false,paused:true,revoking:true,binding:null,account:null});
 put(join(DATA_DIR,'signal/auth/key'),'FAKE-CREDENTIAL-BYTES');put(join(DATA_DIR,'channels/signal/old/receipts.json'),'FAKE-RECEIPT-BYTES');
 parkSignalForDowngrade(DATA_DIR,{fence});
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
 const authority=createSignalLocalAuthority(DATA_DIR,manager,()=>{open=false;});
 const inventory=authority.inventory();expect(inventory.connectionIds).toContain('old');expect(inventory.runIds).toEqual(expect.arrayContaining([running.id,queued.id]));
 const savedPeople=signalHumanBindings(ownerMemoryTicket());expect(savedPeople.some(row=>row.active)).toBe(true);
 let result;try{result=await keepBothAndLinkAgain(DATA_DIR,authority,{fence,after:(operation,path)=>{
  if(operation==='write'&&path===join(DATA_DIR,'channels/signal/connection.json')){
   expect(signalHumanBindings(ownerMemoryTicket()).every(row=>!row.active)).toBe(true);
   for(const run of manager.listRuns()){expect(run.status).toBe('cancelled');expect(run.eventBudget?.closed).toBe(true);}
  }
 }});}finally{
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
 await replaySignalReplacements(DATA_DIR,createSignalLocalAuthority(DATA_DIR,restarted,()=>{open=false;}),{fence});
 expect(signalHumanBindings(ownerMemoryTicket()).every(row=>!row.active)).toBe(true);await restarted.tick();expect(start).toHaveBeenCalledTimes(1);
 // Completed Keep both also permits later synchronous downgrade with the real
 // persisted people and run journals, while keeping its replay obligations.
 restarted.stop();closeDatabase();expect(()=>parkSignalForDowngrade(DATA_DIR,{fence})).not.toThrow();
});
