// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from 'vitest';
import { fixture, d, card, baseCard } from './fixture.ts';
import { canonical } from './bounds.ts';
import { initializeApprovals, SHARED_PEER_PREDICATE, listSharedPeerContinuations } from './records.ts';
import type { ProducerQueuePort, ContinuationKey } from './types.ts';

it('binds the actual singleton and authenticated claim; disposal removes only that installation', async () => {
 const f=fixture();const registered:ProducerQueuePort[]=[];const removed:ProducerQueuePort[]=[];
 const authority={claim:f.claim,proof:'trusted'};
 const dispose=d.installProducerBindings({authorityFor:()=>authority,registerQueue:port=>{registered.push(port);return()=>{removed.push(port);};}});
 try{
  const queue=d.producerQueue('peer');expect(d.producerQueue('peer')).toBe(queue);
  expect(registered.filter(port=>port===queue)).toHaveLength(1);
  expect(d.producerAuthorityFor('t','b')).toBe(authority);
  expect(d.producerAuthorityFor('other','b')).toBeUndefined();
  expect(d.producerAuthorityFor('t','other')).toBeUndefined();
  const {memoryApprovalQueue}=await import('../memory/authority.ts');
  const {MemoryApprovalQueue}=await import('../memory/service-approval.ts');
  expect(d.producerQueue('memory')).toBeInstanceOf(MemoryApprovalQueue);
  expect(d.producerQueue('memory')).toBe(memoryApprovalQueue());
  const source={...queue,kind:'email'} as unknown as ProducerQueuePort;
  const unregister=d.registerProducerQueue(source);expect(registered).toContain(source);unregister();expect(removed).toContain(source);
  expect(()=>d.installProducerBindings({authorityFor:()=>undefined,registerQueue:()=>()=>{}})).toThrow('producer-bindings-already-installed');
  const accept=vi.fn();const remove=queue.bindAcceptance('Bash',accept);
  const request=queue.open({authority,ref:'binding-fixture',tool:'Bash',input:{command:'rm -rf ~'},action:{requestId:'binding-fixture',options:['Allow','Deny']},view:{title:'Fixture',subtitle:'Fixture'},base:baseCard()});
  const ref=card(request.outcome);const item=await queue.present(request,ref);
  expect(await queue.respond(item,{behavior:'allow'},{answerId:'binding-answer'})).toEqual({state:'accepted'});
  expect(accept).toHaveBeenCalledTimes(1);remove();
 }finally{dispose();}
 expect(removed).toContain(d.producerQueue('peer'));expect(d.producerAuthorityFor('t','b')).toBeUndefined();
});

it('execution receipts observe the actual ack and never deliver or re-decide', async () => {
 const f=fixture(),handle=f.open();expect(d.decide(handle,baseCard)).toEqual({kind:'run'});
 expect(d.readRequestExecution(handle)).toEqual({outcome:'run',delivery:'none'});
 let finish!:(value:{state:'accepted'})=>void;
 f.respond.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const pending=d.deliverRequest(handle);await Promise.resolve();await Promise.resolve();
 expect(d.readRequestExecution(handle)).toEqual({outcome:'run',delivery:'pending',answer:{behavior:'allow'}});
 finish({state:'accepted'});await pending;
 const receipt=d.readRequestExecution(handle);expect(receipt).toEqual({outcome:'run',delivery:'accepted',answer:{behavior:'allow'}});
 expect(Object.isFrozen(receipt)).toBe(true);expect(Object.isFrozen(receipt.answer)).toBe(true);
 expect(f.respond).toHaveBeenCalledTimes(1);d.readRequestExecution(handle);expect(f.respond).toHaveBeenCalledTimes(1);
 expect(()=>d.readRequestExecution({} as d.RequestHandle)).toThrow('unregistered-request');
});

it('durable receipts retain Deny, and an unconfirmed transport cannot look accepted', async () => {
 const f=fixture(),handle=f.open('denied',{command:'rm -rf ~'}),ref=card(d.decide(handle,baseCard));
 await d.presentApproval(ref,{title:'Fixture',subtitle:'Fixture'});await d.answerApproval(ref,{behavior:'deny'});
 expect(d.readApprovalExecution(ref)).toEqual({outcome:'card',delivery:'accepted',answer:{behavior:'deny'}});
 expect(d.readRequestExecution(handle)).toEqual(d.readApprovalExecution(ref));
 expect(()=>d.readApprovalExecution({approvalId:ref.approvalId} as d.ApprovalRef)).toThrow('unissued-approval-ref');
 const unconfirmed=f.open('unconfirmed');d.decide(unconfirmed,baseCard);f.respond.mockResolvedValue({state:'failed'});
 await d.deliverRequest(unconfirmed);expect(d.readRequestExecution(unconfirmed).delivery).toBe('unconfirmed');
});

it('service receipt follows execution completion rather than policy RUN', async () => {
 const f=fixture(),handle=d.openRequest({kind:'service',service:'email',claim:f.claim,call:f.serviceCall({command:'echo fixture'})});
 d.decide(handle,baseCard);expect(d.readRequestExecution(handle).delivery).toBe('none');
 let finish!:(value:string)=>void;const work=d.executeService(handle,()=>new Promise<string>(resolve=>{finish=resolve;}));
 await Promise.resolve();expect(d.readRequestExecution(handle)).toEqual({outcome:'run',delivery:'pending'});
 finish('done');await work;expect(d.readRequestExecution(handle)).toEqual({outcome:'run',delivery:'accepted',answer:{behavior:'allow'}});
});

it('S1-L1..L4: shared-peer listing uses the namespace index, pages independently of other keys and deletes synchronously', async () => {
 const f=fixture(),db=f.db;
 db.exec('DROP INDEX decision_continuations_shared_peer');
 const insert=db.prepare('INSERT INTO decision_continuations(key,value) VALUES(?,?)');
 for(const key of ['queue-answer:a','queue-required:email','{"botId":'])insert.run(key,'1');
 const keys:ContinuationKey[]=Array.from({length:5},(_,i)=>({kind:'background-job',id:`shared-peer:${i}`,threadId:'t',botId:'b'}));
 for(const key of [...keys,{kind:'asker-wake' as const,id:'shared-peer:wrong',threadId:'t',botId:'b'},{kind:'background-job' as const,id:'service:other',threadId:'t',botId:'b'}])insert.run(canonical(key),'{}');
 initializeApprovals(db);insert.run('queue-answer:after','{}');insert.run('queue-required:after','1');
 const first=d.listContinuations({kind:'background-job',namespace:'shared-peer',limit:2});
 expect(first).toEqual({keys:keys.slice(0,2),next:canonical(keys[1])});
 const second=d.listContinuations({kind:'background-job',namespace:'shared-peer',limit:2,after:first.next});
 expect(second).toEqual({keys:keys.slice(2,4),next:canonical(keys[3])});
 expect(d.listContinuations({kind:'background-job',namespace:'shared-peer',limit:2,after:second.next})).toEqual({keys:keys.slice(4)});
 const plan=db.prepare(`EXPLAIN QUERY PLAN SELECT key FROM decision_continuations WHERE ${SHARED_PEER_PREDICATE} AND key > ? ORDER BY key LIMIT ?`).all('',3).map(row=>row.detail).join('\n');
 expect(plan).toMatch(/SEARCH decision_continuations USING COVERING INDEX decision_continuations_shared_peer \(key>\?/);expect(plan).not.toContain('TEMP B-TREE');
 const before=listSharedPeerContinuations(db,'',3);for(let i=0;i<10000;i++)insert.run(`queue-answer:scale-${i}`,'{}');
 expect(listSharedPeerContinuations(db,'',3)).toEqual(before);
 const deletion=d.deleteContinuation(keys[0]);expect(d.readContinuation(keys[0])).toBeUndefined();expect(db.isTransaction).toBe(false);await deletion;await d.deleteContinuation(keys[0]);
 expect(d.listContinuations({kind:'background-job',namespace:'shared-peer',limit:5}).keys).toEqual(keys.slice(1));
});

it('native cards publish one post-commit audit row, including their denial class',async()=>{
 const f=fixture();const {onDecisionAppended,loggedDecision}=await import('../decision-log.ts');const rows:any[]=[];
 const remove=onDecisionAppended((_dir,row)=>rows.push(row));
 try{
  const ref=card(d.decide(f.open('audit-card',{command:'rm -rf ~'}),baseCard));
  expect(rows).toHaveLength(0);await d.presentApproval(ref,{title:'Fixture',subtitle:'Fixture'});await d.presentApproval(ref,{title:'Fixture',subtitle:'Fixture'});
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({threadId:'t',requestId:'audit-card',decision:'card-shown',rule:'wipe:registered'});
  expect(loggedDecision({at:'fixture',...rows[0]}).rule).toBe('wipe');
 }finally{remove();}
});
