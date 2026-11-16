// SPDX-License-Identifier: AGPL-3.0-or-later
// Standalone fake-driver tests still cross the real native release guard.
// This host supplies the owner audience that production index.ts normally owns.
import type {ProviderAdapter,RuntimeEvent} from '../contracts.ts';
import {Store} from '../store.ts';
import * as decision from '../decision/index.ts';
export function driverOwnerDecisionFixture(adapter:ProviderAdapter,cwd?:string):()=>void {
 const store=new Store(),bot=store.createBot({name:'Native release fixture'},{seedMessages:false});
 let current:Extract<RuntimeEvent,{type:'request.opened'}>|undefined;
 const host=decision.installDecisionHost({store,view:()=>({title:'Fixture',subtitle:'Native request'}),executionContext:()=>({cwd,project:cwd})});
 decision.installProvenanceReader({turnGenerationFor:thread=>current?.threadId===thread?current.turnId:undefined,
  provenance:()=>current?{generation:current.turnId!,threadId:current.threadId,botId:bot.id,principal:'owner',roomOwnerOnly:true,at:1,initiator:{k:'owner-typed'}}:undefined,
  live:thread=>current?.threadId===thread?{botId:bot.id,turnId:current.turnId!,providerInstanceId:current.providerInstanceId!,principal:'owner',owner:true,level:'unlimited'}:undefined});
 decision.installDenySources({revision:()=>[],resolve:()=>[]});
 const ingress=decision.installRequestIngress({subscribe:listener=>adapter.onEvent(event=>{
  if(event.type!=='request.opened'&&event.type!=='request.resolved'&&event.type!=='turn.completed')return;
  if(event.type==='request.opened')current=event;
  listener(event);
  if(event.type==='request.opened'&&event.requestId){const handle=decision.openRequest({kind:'engine',threadId:event.threadId,requestId:event.requestId});decision.decide(handle,()=>({approve:null,source:'no-grant'}));}
 })});
 return()=>{ingress();host();};
}
