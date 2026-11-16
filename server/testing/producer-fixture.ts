// SPDX-License-Identifier: AGPL-3.0-or-later
// Real decision/queue plumbing for legacy service fixtures. No permissions are
// mocked: Ask still evaluates the service's own supplied BASE verdict.
import {afterEach} from 'vitest';
import * as decision from '../decision/index.ts';
import {installSynchronousQueueDeliveries} from '../decision/api.ts';
import {serviceQueue,type ServiceAuthority} from '../narrow-denials.ts';
import type {Store} from '../store.ts';
let release=()=>{};
afterEach(()=>{release();release=()=>{};});
export function producerFixture(store:Store,botId:string,threadId:string,generation:string):ServiceAuthority {
 release();
 const host=decision.installDecisionHost({store,view:()=>({title:'Fixture action',subtitle:'Fixture'})});
 decision.installProvenanceReader({turnGenerationFor:thread=>thread===threadId?generation:undefined,
  provenance:()=>({generation,botId,threadId,principal:'owner',roomOwnerOnly:true,at:1,initiator:{k:'owner-typed'}}),
  live:thread=>thread===threadId?{botId,turnId:'fixture-turn',providerInstanceId:'fixture',principal:'owner',owner:true,level:'ask'}:undefined});
 decision.installDenySources({revision:()=>[],resolve:()=>[]});
 const queues=[serviceQueue('peer'),serviceQueue('event-limit'),serviceQueue('image')];
 const sources=decision.installQueueSources(queues.map(queue=>({kind:queue.kind,
  pendingApprovals:()=>queue.pendingApprovals(),base:queue.base,
  respond:(item,answer,options)=>queue.respond(item,answer,options),
  cancel:(item,reason)=>queue.cancel(item,reason),renew:(item,identity)=>queue.renew(item,identity),
  reopen:item=>({kind:'service' as const,service:queue.kind,claim,call:item.call}),
 }))),sync=installSynchronousQueueDeliveries(queues);
 const proof={threadId,botId,generation};
 const claim=decision.installClaimVerifier(value=>value===proof?proof:undefined)(proof)!;
 release=()=>{sync();sources();host();};
 return {claim,proof,identity:{threadId,generation}};
}
