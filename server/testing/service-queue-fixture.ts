// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Adapt legacy service unit stores to the real decision records and queue protocol.
// Defaults to an authenticated owner at Ask; explicit guest/level fixtures exercise
// the same production provenance checks. Service BASE still decides at Ask.
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
export interface ServiceFixtureTurn {
 generation?: string;
 level?: decision.Registration['level'] | (() => decision.Registration['level']);
 initiator?: decision.Initiator;
 owner?: boolean;
}
type FixtureTurn = { botId:string; threadId:string; generation:string; store:any; claim:decision.ExecutionClaim; proof:unknown; policy:ServiceFixtureTurn };
const turns = new Map<string, FixtureTurn>();
const queues = new Map<string, ()=>void>();
const cleanupThreads = new Set<string>();
const enriched = new WeakSet<object>();
const decisionStores = new WeakMap<object,Store>();
afterEach(async()=>{
 try {
  // Fixed producer ids (email send-1, for example) belong to one fixture run.
  // Fixtures reusing fixed ids opt into real cancellation before the next
  // test. Other service suites own their shutdown (and may have already
  // revoked their jobs). Some suites already removed their isolated DB.
  if(installed&&existsSync(join(DATA_DIR,'messages.db'))){
   for(const threadId of cleanupThreads)await decision.cancelRequests({kind:'thread',threadId},'cancelled');
  }
 } finally {
  for(const release of releases.splice(0).reverse())release();
  turns.clear();queues.clear();cleanupThreads.clear();installed=false;
 }
});
function approvalAccessors(store:any,backing:Store){
 // Use Store's actual roster lookups, including room tasks. A projection may
 // carry its own live roster; otherwise use the isolated persisted roster.
 store.groupByThread??=((threadId:string)=>{
  if(store.groups)backing.groups=store.groups;
  return backing.groupByThread(threadId);
 });
 store.bot??=((botId:string)=>{
  if(store.bots)backing.bots=store.bots;
  return backing.bot(botId);
 });
}
function enrich(store:any){
 if(enriched.has(store))return;
 enriched.add(store);
 if(store instanceof Store)return;
 const backing=new Store(()=>({instanceId:'fixture',model:'fixture'}));
 decisionStores.set(store,backing);
 approvalAccessors(store,backing);
 const append=store.appendMessage.bind(store),patch=store.patchMessage.bind(store);
 store.appendMessage=(threadId:string,input:any,stableId?:string)=>{
  const persisted=backing.appendMessage(threadId,input,stableId);
  const row=append(threadId,structuredClone(input));row.id=persisted.id;return row;
 };
 store.patchMessagePoint=(threadId:string,id:string,input:any)=>{
  const before=backing.messageById(threadId,id);
  const persisted=backing.patchMessagePoint(threadId,id,input);
  const current=store.messageById(threadId,id);
  // The domain's mutable memory store can model damaged legacy cards. The
  // decision host keeps its independently persisted, immutable presentation.
  // Mirror only fields the decision changed, preserving the damaged fixture.
  const changes=Object.fromEntries(Object.entries(input.card??{}).filter(([key,value])=>JSON.stringify(value)!==JSON.stringify((before?.card as any)?.[key])));
  if(current&&input.card)patch(threadId,id,{...input,card:{...current.card,...changes}});
  return persisted;
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
  // Service tests may tamper with their projection. Terminalizing a decision
  // must preserve the actual action stored before that projection changed.
  messageById:(threadId:string,id:string)=>{const store=turns.get(threadId)?.store;return store&&(decisionStores.get(store)??store).messageById(threadId,id);},
  patchMessagePoint:(threadId:string,...args:any[])=>turns.get(threadId)!.store.patchMessagePoint(threadId,...args),
 } as unknown as Store;
 releases.push(decision.installDecisionHost({store:hostStore,view:()=>({title:'Fixture action',subtitle:'Fixture'})}));
 decision.installProvenanceReader({turnGenerationFor:thread=>turns.get(thread)?.generation,
  provenance:generation=>{const t=[...turns.values()].find(t=>t.generation===generation);return t?{botId:t.botId,threadId:t.threadId,generation,principal:t.policy.owner===false?'guest':'owner',roomOwnerOnly:t.policy.owner!==false,at:1,initiator:t.policy.initiator??{k:'owner-typed'}}:undefined;},
  live:thread=>{const t=turns.get(thread);return t?{botId:t.botId,turnId:'fixture-turn',providerInstanceId:'fixture',principal:t.policy.owner===false?'guest':'owner',owner:t.policy.owner!==false,level:typeof t.policy.level==='function'?t.policy.level():t.policy.level??'ask'}:undefined;}});
 decision.installDenySources({revision:()=>[],resolve:()=>[]});
}
export function serviceQueueFixture(store:any, options:{persisted?:boolean;cancelAtEnd?:boolean}={}){
 // Stores already writing through message-db keep those writes (and its guards);
 // in-memory stores get a real Store backing their decision presentations.
 if(options.persisted){
  if(!(store instanceof Store))approvalAccessors(store,new Store(()=>({instanceId:'fixture',model:'fixture'})));
  store.appendApprovalCard??=Store.prototype.appendApprovalCard;store.patchMessagePoint??=store.patchMessage?.bind(store);
 }
 else enrich(store);
 install();
 const issue=decision.installClaimVerifier(value=>{
  const proof=value as {threadId?:string;botId?:string;generation?:string};const turn=proof&&turns.get(proof.threadId??'');
  return turn&&value===turn.proof&&turn.botId===proof.botId&&turn.generation===proof.generation?{threadId:turn.threadId,botId:turn.botId,generation:turn.generation}:undefined;
 });
 return {
  authorityFor(threadId:string,botId:string,policy:ServiceFixtureTurn={}):ServiceAuthority {
   if(options.cancelAtEnd)cleanupThreads.add(threadId);
   let turn=turns.get(threadId);
   if(!turn||turn.store!==store||turn.botId!==botId||policy.generation&&turn.generation!==policy.generation){
    const proof={threadId,botId,generation:policy.generation??randomUUID()};turn={...proof,store,proof,policy,claim:undefined!};turns.set(threadId,turn);turn.claim=issue(proof)!;
   }
   return {claim:turn.claim,proof:turn.proof,identity:{threadId,generation:turn.generation}};
  },
  queue(queue:ProducerApprovalQueue){
   queues.get(queue.kind)?.();
   const source={kind:queue.kind,pendingApprovals:()=>queue.pendingApprovals(),base:queue.base,
    respond:(...args:Parameters<typeof queue.respond>)=>queue.respond(...args),cancel:(...args:Parameters<typeof queue.cancel>)=>queue.cancel(...args),renew:(...args:Parameters<typeof queue.renew>)=>queue.renew(...args),
    reopen:(item:decision.PendingQueueApproval)=>{const proof=item.proof as {threadId:string;botId:string;generation:string};const turn=turns.get(proof.threadId);return turn&&turn.botId===proof.botId&&turn.generation===proof.generation?{kind:'service' as const,service:queue.kind,claim:turn.claim,call:item.call}:undefined;}};
   const remove=decision.installQueueSources([source]),sync=decision.installSynchronousQueueDeliveries([queue]);
   const release=()=>{sync();remove();};queues.set(queue.kind,release);releases.push(release);
  },
 };
}
export function routineServiceFixture(options:ConstructorParameters<typeof RoutineRequestService>[0]){
 // Legacy fixtures model clean owner turns; outside-read suites supply the real reader explicitly.
 const fixture=serviceQueueFixture(options.store);const service=new RoutineRequestService({turnOutsideRead: () => null, ...options});fixture.queue(service.approvalQueue());
 const propose=service.propose.bind(service);
 service.propose=args=>propose({...args,authority:args.authority??fixture.authorityFor(args.threadId,args.botId)});
 return service;
}
export function clearServiceQueueFixture(kind:string){const file=join(DATA_DIR,'decision-queues',kind+'.json');if(existsSync(file))unlinkSync(file);}
