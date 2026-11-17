// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import type { DatabaseSync } from 'node:sqlite';
import { fixture, d, card, baseCard } from './fixture.ts';

import { EMAIL_CARD_MESSAGES_SQL, emailCardMessageIds } from './records.ts';
const expectedPlan = 'USING INDEX approval_queue_ref (thread_id=? AND queue_kind=? AND queue_ref=?)';
function plan(db: DatabaseSync) {
  const query = db.prepare('EXPLAIN QUERY PLAN ' + EMAIL_CARD_MESSAGES_SQL);
  // A predicate-removal mutant must fail the plan assertion, not parameter binding.
  return query.all(...Array.from({ length: (EMAIL_CARD_MESSAGES_SQL.match(/\?/g) ?? []).length }, (_, i) => i === 0 ? 't' : 'target')).map(row => String(row.detail));
}
function seedHistory(db: DatabaseSync, count: number) {
  db.prepare(`WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?)
    INSERT INTO approval_records(id,source_kind,thread_id,request_key,request_id,bot_id,actor_kind,actor_via,level,why,evidence,registration_hash,deny_rev,input_hash,action_hash,chat_message_id,queue_kind,queue_ref,state,created_at,settled_at)
    SELECT 'history-'||x,CASE WHEN x%3=1 THEN 'engine' ELSE 'service' END,
      CASE WHEN x%3=2 THEN 'other-thread' ELSE 't' END,'history-key-'||x,'history-request-'||x,'b','owner','owner-typed','ask','base','{}','h','[]','i','a','history-message-'||x,
      CASE WHEN x%3=1 THEN NULL ELSE 'email' END,CASE WHEN x%3=1 THEN NULL ELSE 'unrelated-'||x END,'answered',0,1 FROM n`).run(count);
}
function seedTargets(db: DatabaseSync) {
  const insert = db.prepare(`INSERT INTO approval_records(id,source_kind,thread_id,request_key,request_id,bot_id,actor_kind,actor_via,level,why,evidence,registration_hash,deny_rev,input_hash,action_hash,chat_message_id,queue_kind,queue_ref,state,created_at,settled_at)
    VALUES(?,?,?, ?,?,'b','owner','owner-typed','ask','base','{}','h','[]','i','a',?,?,?,'answered',0,1)`);
  for (const [id,source,thread,kind,ref] of [
    ['target-1','service','t','email','target'], ['target-2','service','t','email','target'],
    ['wrong-source','engine','t','email','target'], ['wrong-kind','service','t','browser','target'],
    ['wrong-thread','service','other-thread','email','target'], ['wrong-ref','service','t','email','another'],
  ]) insert.run(id,source,thread,id,id,id,kind,ref);
}
function measure(db: DatabaseSync) {
  // Batch tiny indexed lookups so clock resolution and scheduler noise do not dominate.
  for (let i=0;i<100;i++) emailCardMessageIds(db,'t','target');
  const samples = Array.from({length:5}, () => {
    const start = performance.now();
    for (let i=0;i<500;i++) emailCardMessageIds(db,'t','target');
    return performance.now()-start;
  });
  return samples.sort((a,b)=>a-b)[2];
}
it('T1 email queue-ref lookup uses all three index columns without a scan', () => {
  const {db} = fixture();
  expect(plan(db).join(' '), 'T1 queue-ref index seek').toContain(expectedPlan);
  expect(plan(db).join(' '), 'T1 no approval history scan').not.toMatch(/\bSCAN\b/);
});
it('T2 email queue-ref lookup stays bounded after ANALYZE at 200 and 20000 rows', () => {
  const {db} = fixture();
  seedTargets(db);
  seedHistory(db,200);
  db.exec('ANALYZE');
  const smallPlan = plan(db);
  expect(smallPlan.join(' '), 'T2 small-history queue-ref seek').toContain(expectedPlan);
  expect(emailCardMessageIds(db,'t','target').map(row=>row.messageId).sort(), 'T2 exact target messages at 200').toEqual(['target-1','target-2']);
  const small = measure(db);
  db.exec("DELETE FROM approval_records WHERE id GLOB 'history-*'");
  seedHistory(db,20000);
  db.exec('ANALYZE');
  const largePlan = plan(db);
  expect(largePlan.join(' '), 'T2 large-history queue-ref seek').toContain(expectedPlan);
  expect(largePlan, 'T2 stable plan after ANALYZE').toEqual(smallPlan);
  expect(largePlan.join(' '), 'T2 no approval history scan').not.toMatch(/\bSCAN\b/);
  expect(emailCardMessageIds(db,'t','target').map(row=>row.messageId).sort(), 'T2 exact target messages at 20000').toEqual(['target-1','target-2']);
  const large = measure(db);
  console.log(JSON.stringify({metric:'email-queue-ref-history-cost',small,large,ratio:large/small}));
  expect(large, 'T2 median of five lookup batches grows at most 3x').toBeLessThanOrEqual(3*small);
});

it('T3 real EmailCards lifecycle patches exactly the target presentations with 20000 unrelated approvals', async () => {
  const f = fixture('ask');
  const targetIds: string[] = [];
  for (const epoch of ['first','second']) {
    const call = f.serviceCall({},epoch);
    const ref = card(d.decide(d.openRequest({kind:'service',service:'email',claim:f.claim,call}),baseCard));
    d.attachQueue(ref,{kind:'email',ref:'q',call});
    await d.presentApproval(ref,{title:'Fixture email',subtitle:'Fixture'});
    targetIds.push(d.readApproval(ref.approvalId)!.chatMessageId);
    await d.settle(ref,'answered',{behavior:'allow'});
  }
  seedHistory(f.db,20000);
  f.db.exec('ANALYZE');
  const { EmailStore } = await import('../email/email-store.ts');
  const { EmailSendService } = await import('../email/send-service.ts');
  const { EmailCards } = await import('../email/cards.ts');
  const { FakeFlux } = await import('../testing/fake-flux-email.ts');
  const { FluxEmailClient } = await import('../email/flux-email-client.ts');
  const { EmailSecretStore, emailCredentialProvider } = await import('../email/email-secrets.ts');
  const store = new EmailStore(f.db);
  const fake = new FakeFlux();
  const client = new FluxEmailClient({fetch:fake.fetch,apiBase:'https://api.flux.test',appBase:'https://app.flux.test',credentials:emailCredentialProvider(new EmailSecretStore(),()=>null)});
  const send = new EmailSendService({store,client,installId:'fixture'});
  const patched: string[] = [];
  const lookup = vi.fn((threadId:string,ref:string) => emailCardMessageIds(f.db,threadId,ref));
  const cards = new EmailCards({store,send,host:{
    botName:()=> 'Fixture',threadExists:()=>true,
    card:()=>({messageId:targetIds[1]}),cardMessages:lookup,
    appendCard:()=>{throw new Error('lifecycle must reuse the existing cards');},
    patchCard:(threadId,messageId,emailDisplay)=>{patched.push(messageId);f.store.patchMessagePoint(threadId,messageId,{emailDisplay});},
    outcome:()=>{},activity:()=>{},notify:()=>{},
  }});
  const row: import('../email/email-store.ts').SendRow = {
    sendId:'q',botId:'b',generation:1,threadId:'t',inboxId:'fixture',kind:'send',replyMessageId:null,
    payloadHash:'fixture',summary:{to:['recipient@example.test'],cc:[],subject:'Fixture',textLength:0,attachments:[],replySource:null},
    idemSuffix:0,state:'sent',code:null,why:null,stopRequested:false,ownerSent:true,replaces:null,receipt:null,
    revision:2,attempts:[],heldIds:[],approvalId:null,messageId:null,reconcileStep:0,dueAt:null,
    createdAt:1,updatedAt:2,dispatchedAt:1,settledAt:2,deliveryNote:null,
  };
  const originalActions = targetIds.map(id=>f.store.messageById('t',id)!.card);
  cards.sync(row);
  await vi.waitFor(()=>expect(lookup, 'T3 both lifecycle passes use the real helper').toHaveBeenCalledTimes(2));
  expect(lookup.mock.calls, 'T3 target ref passed to both lookups').toEqual([['t','q'],['t','q']]);
  expect(patched.sort(), 'T3 exactly the two target cards patched on both passes').toEqual([...targetIds,...targetIds].sort());
  for (const [i,id] of targetIds.entries()) {
    const message = f.store.messageById('t',id)!;
    expect(message.emailDisplay, 'T3 target card receives final lifecycle status').toMatchObject({options:[],emailSend:{phase:'settled',state:'sent',actions:[]}});
    expect(message.card, 'T3 lifecycle preserves immutable approval action').toEqual(originalActions[i]);
  }
  expect(fake.requests, 'T3 lifecycle sends no email').toEqual([]);
});

it('T5 a dropped queue-ref index degrades safely and every presentation is returned', () => {
  const {db} = fixture();
  seedTargets(db);
  for (let i=0;i<40;i++) db.prepare(`INSERT INTO approval_records SELECT
    'presentation-'||?,source_kind,service,thread_id,'presentation-key-'||?,request_id,bot_id,generation,actor_kind,actor_via,level,why,evidence,registration_hash,deny_rev,input_hash,action_hash,presented_action,'presentation-message-'||?,queue_kind,queue_ref,state,answer,answer_id,delivery,created_at,settled_at
    FROM approval_records WHERE id='target-1'`).run(i,i,i);
  expect(emailCardMessageIds(db,'t','target'), 'T5 no presentation truncation').toHaveLength(42);
  db.exec('DROP INDEX approval_queue_ref');
  expect(emailCardMessageIds(db,'t','target'), 'T5 dropped index remains queryable').toHaveLength(42);
});
