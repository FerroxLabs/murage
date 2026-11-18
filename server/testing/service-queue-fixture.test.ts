import { randomUUID } from 'node:crypto';
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase } from '../database.ts';
import * as decision from '../decision/index.ts';
import { producerBase, ProducerApprovalQueue, type ServiceAuthority } from '../narrow-denials.ts';
import { Store } from '../store.ts';
import { removeTempDirSync } from './cleanup.ts';
import { serviceQueueFixture, type ServiceFixtureTurn } from './service-queue-fixture.ts';

beforeEach(() => {
 closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, {recursive:true});
});
function fixture(policy: ServiceFixtureTurn = {}) {
 const store = new Store(() => ({instanceId:'fixture',model:'fixture'}));
 const producer = serviceQueueFixture(store);
 const queue = new ProducerApprovalQueue('peer', join(DATA_DIR,'fixture-queue.json'));
 producer.queue(queue);
 const authority = producer.authorityFor('thread','bot',policy);
 const open = (claim: ServiceAuthority | undefined = authority) => { const ref=randomUUID(); return queue.open({
  ref,
  authority:claim,tool:'ask_bot',input:{targetBotId:'target',message:'Fixture contact'},
  action:{requestId:ref,tool:'ask_bot',options:['Allow','Deny']},view:{title:'Contact',subtitle:'Fixture contact'},
  base:{approve:null,source:'no-grant'},
 }); };
 return {store,queue,authority,open};
}
it('mints a verifier-registered claim and commits a real Ask approval and matching row', () => {
 const f = fixture(); const request = f.open();
 expect(request.outcome.kind).toBe('card');
 if(request.outcome.kind !== 'card') throw new Error('expected Ask approval');
 f.queue.presentNow(request,request.outcome.ref,()=>{});
 const record = decision.readApproval(request.outcome.ref.approvalId)!;
 expect(record).toMatchObject({threadId:'thread',botId:'bot',actor:'owner',level:'ask',state:'open',delivery:'none',why:'base'});
 expect(f.store.messageById('thread',record.chatMessageId)?.card).toMatchObject({approvalId:record.ref.approvalId,requestRef:record.requestId,actionHash:record.actionHash});
 expect(f.queue.pendingApprovals()).toHaveLength(1);
});
it('retains the producing turn when presentation waits and the durable queue is reopened', () => {
 const policy={turnId:'source-provider-turn'};
 const f=fixture(policy),request=f.open();
 if(request.outcome.kind!=='card')throw new Error('expected Ask approval');
 policy.turnId='replacement-provider-turn';
 f.queue.presentNow(request,request.outcome.ref,()=>{});
 const record=decision.readApproval(request.outcome.ref.approvalId)!;
 expect(f.store.messageById('thread',record.chatMessageId)?.turnId).toBe('source-provider-turn');
 const reopened=new ProducerApprovalQueue('peer',join(DATA_DIR,'fixture-queue.json'));
 expect(reopened.pendingApprovals()[0]?.view.turnId).toBe('source-provider-turn');
});

it('requires the producer authority and rejects a structural imitation of a registered claim', () => {
 const f = fixture();
 expect(() => f.queue.open({authority:undefined,tool:'ask_bot',input:{},action:{tool:'ask_bot'},view:{title:'Contact',subtitle:'Fixture'},base:{approve:null,source:'no-grant'}}))
  .toThrow('A verified service execution claim is required.');
 expect(() => f.open({...f.authority,claim:{} as decision.ExecutionClaim})).toThrow('unverified-execution-claim');
 expect(decision.openApprovals()).toEqual([]);
 expect(f.queue.pendingApprovals()).toEqual([]);
});
it('keeps a verified guest at Ask even when its requested fixture level is No limits', () => {
 const f = fixture({owner:false,initiator:{k:'guest'},level:'unlimited'});
 const request = f.open();
 expect(request.outcome.kind).toBe('card');
 if(request.outcome.kind !== 'card') throw new Error('expected guest approval');
 f.queue.presentNow(request,request.outcome.ref,()=>{});
 expect(decision.readApproval(request.outcome.ref.approvalId)).toMatchObject({level:'ask',actor:'other'});
});
it('reads an authenticated owner level live and preserves an explicit lower level', () => {
 let level: decision.Registration['level'] = 'unlimited';
 const f = fixture({level:() => level});
 expect(f.open().outcome.kind).toBe('run');
 level = 'ask';
 const request = f.open();
 expect(request.outcome.kind).toBe('card');
 if(request.outcome.kind !== 'card') throw new Error('expected lower-level approval');
 f.queue.presentNow(request,request.outcome.ref,()=>{});
 expect(decision.readApproval(request.outcome.ref.approvalId)).toMatchObject({level:'ask',actor:'owner'});
});

it('keeps Undo as terminal metadata without changing or reopening the authorized action', () => {
 const f=fixture();const request=f.open();let accepted=0;
 if(request.outcome.kind!=='card')throw new Error('expected Ask approval');
 f.queue.presentNow(request,request.outcome.ref,()=>{accepted++;});
 const before=decision.readApproval(request.outcome.ref.approvalId)!;
 const openCard=f.store.messageById('thread',before.chatMessageId)!.card!;
 expect(()=>f.store.patchMessagePoint('thread',before.chatMessageId,{card:{...openCard,undone:true}})).toThrow('card-action-changed');
 expect(f.queue.answerNow(before.ref.approvalId,{behavior:'allow'}).state).toBe('accepted');
 const card=f.store.messageById('thread',before.chatMessageId)!.card!;
 f.store.patchMessagePoint('thread',before.chatMessageId,{card:{...card,answered:'undone',undone:true} as typeof card});
 expect(decision.readApproval(before.ref.approvalId)).toMatchObject({state:'answered',delivery:'accepted',actionHash:before.actionHash});
 expect(f.store.messageById('thread',before.chatMessageId)?.card).toMatchObject({answered:'undone',undone:true});
 expect(()=>f.store.patchMessagePoint('thread',before.chatMessageId,{card:{...card,tool:'different'}})).toThrow('card-action-changed');
 expect(f.queue.answerNow(before.ref.approvalId,{behavior:'allow'}).state).toBe('already');
 expect(accepted).toBe(1);
});

it('never executes an unauthorized producer, even when its base policy allows', async () => {
 const f=fixture();
 const operation=vi.fn(async()=> 'unauthorized effect');
 let refused=false;
 try {
  const request=f.queue.open({authority:undefined,tool:'ask_bot',input:{targetBotId:'target'},action:{tool:'ask_bot'},view:{title:'Contact',subtitle:'Fixture'},base:producerBase(false)});
  await f.queue.execute(request,operation);
 } catch { refused=true; }
 expect(operation).not.toHaveBeenCalled();
 expect(refused).toBe(true);
 expect(decision.openApprovals()).toEqual([]);
 expect(f.queue.pendingApprovals()).toEqual([]);
});

it('Undo progress alone cannot exempt an unapproved card from the record guard', () => {
 const f=fixture();
 expect(()=>f.store.appendMessage('thread',{role:'bot',kind:'options',card:{requestId:'unapproved',tool:'ask_bot',title:'Contact',subtitle:'Fixture',options:['Allow'],undone:true}})).toThrow('card-without-approval');
 expect(f.store.messagesFor('thread')).toEqual([]);
 expect(decision.openApprovals()).toEqual([]);
});
