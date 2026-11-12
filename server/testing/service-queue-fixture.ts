// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Adapt legacy service unit stores to the real decision records and queue protocol.
// Every generated claim is an authenticated owner at Ask; service BASE still decides.
import { afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as decision from '../decision/index.ts';
import { initializeApprovals } from '../decision/records.ts';
import { database } from '../database.ts';
import { DATA_DIR } from '../config.ts';
import { Store } from '../store.ts';
import { RoutineRequestService } from '../routine-requests.ts';
import type { ProducerApprovalQueue, ServiceAuthority } from '../narrow-denials.ts';
const releases: Array<()=>void> = [];
let installed = false;
const turns = new Map<string, { botId:string; threadId:string; generation:string; store:any; claim:decision.ExecutionClaim; proof:unknown }>();
const queues = new Map<string, ()=>void>();
const enriched = new WeakSet<object>();
afterEach(()=>{for(const release of releases.splice(0).reverse())release();turns.clear();queues.clear();installed=false;});
function enrich(store:any){
 if(enriched.has(store))return;
 enriched.add(store);
 if(store instanceof Store)return;
 const backing=new Store(()=>({instanceId:'fixture',model:'fixture'}));
 const append=store.appendMessage.bind(store),patch=store.patchMessage.bind(store);
 store.appendMessage=(threadId:string,input:any,stableId?:string)=>{
  const persisted=backing.appendMessage(threadId,input,stableId);
  const row=append(threadId,input);row.id=persisted.id;return row;
 };
 store.patchMessagePoint=(threadId:string,id:string,input:any)=>{
  backing.patchMessagePoint(threadId,id,input);return patch(threadId,id,input);
 };
 store.messageById??=((threadId:string,id:string)=>store.messagesFor(threadId).find((m:any)=>m.id===id));
 store.cardForRequest??=((threadId:string,id:string,predicate?: (m:any)=>boolean)=>store.messagesFor(threadId).find((m:any)=>m.card?.requestId===id&&(!predicate||predicate(m))));
 store.appendApprovalCard??=Store.prototype.appendApprovalCard;
}
function install(){
 if(installed)return;
 mkdirSync(DATA_DIR,{recursive:true});
 installed=true;initializeApprovals(database());
 const hostStore={
  bot:()=>undefined,
  appendMessage:(threadId:string,...args:any[])=>turns.get(threadId)!.store.appendMessage(threadId,...args),
  appendApprovalCard:(threadId:string,...args:any[])=>turns.get(threadId)!.store.appendApprovalCard(threadId,...args),
  messageById:(threadId:string,id:string)=>turns.get(threadId)?.store.messageById(threadId,id),
  patchMessagePoint:(threadId:string,...args:any[])=>turns.get(threadId)!.store.patchMessagePoint(threadId,...args),
 } as unknown as Store;
 releases.push(decision.installDecisionHost({store:hostStore,view:()=>({title:'Fixture action',subtitle:'Fixture'})}));
 decision.installProvenanceReader({turnGenerationFor:thread=>turns.get(thread)?.generation,
  provenance:generation=>{const t=[...turns.values()].find(t=>t.generation===generation);return t?{botId:t.botId,threadId:t.threadId,generation,principal:'owner',roomOwnerOnly:true,at:1,initiator:{k:'owner-typed'}}:undefined;},
  live:thread=>{const t=turns.get(thread);return t?{botId:t.botId,turnId:'fixture-turn',providerInstanceId:'fixture',principal:'owner',owner:true,level:'ask'}:undefined;}});
 decision.installDenySources({revision:()=>[],resolve:()=>[]});
}
export function serviceQueueFixture(store:any){
 enrich(store);install();
 const issue=decision.installClaimVerifier(value=>{
  const proof=value as {threadId?:string;botId?:string;generation?:string};const turn=proof&&turns.get(proof.threadId??'');
  return turn&&turn.botId===proof.botId&&turn.generation===proof.generation?{threadId:turn.threadId,botId:turn.botId,generation:turn.generation}:undefined;
 });
 return {
  authorityFor(threadId:string,botId:string):ServiceAuthority {
   let turn=turns.get(threadId);
   if(!turn||turn.store!==store||turn.botId!==botId){
    const proof={threadId,botId,generation:randomUUID()};turn={...proof,store,proof,claim:undefined!};turns.set(threadId,turn);turn.claim=issue(proof)!;
   }
   return {claim:turn.claim,proof:turn.proof,identity:{threadId,generation:turn.generation}};
  },
  queue(queue:ProducerApprovalQueue){
   queues.get(queue.kind)?.();
   const source={kind:queue.kind,pendingApprovals:()=>queue.pendingApprovals(),base:queue.base,
    respond:(...args:Parameters<typeof queue.respond>)=>queue.respond(...args),cancel:(...args:Parameters<typeof queue.cancel>)=>queue.cancel(...args),renew:(...args:Parameters<typeof queue.renew>)=>queue.renew(...args),
    reopen:(item:decision.PendingQueueApproval)=>{const proof=item.proof as {threadId:string};const turn=turns.get(proof.threadId);return turn?{kind:'service' as const,service:queue.kind,claim:turn.claim,call:item.call}:undefined;}};
   const remove=decision.installQueueSources([source]),sync=decision.installSynchronousQueueDeliveries([queue]);
   const release=()=>{sync();remove();};queues.set(queue.kind,release);releases.push(release);
  },
 };
}
export function routineServiceFixture(options:ConstructorParameters<typeof RoutineRequestService>[0]){
 const fixture=serviceQueueFixture(options.store);const service=new RoutineRequestService(options);fixture.queue(service.approvalQueue());
 const propose=service.propose.bind(service);
 service.propose=args=>propose({...args,authority:args.authority??fixture.authorityFor(args.threadId,args.botId)});
 return service;
}
export function clearServiceQueueFixture(kind:string){const file=join(DATA_DIR,'decision-queues',kind+'.json');if(existsSync(file))unlinkSync(file);}
