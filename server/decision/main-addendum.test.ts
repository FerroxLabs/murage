import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {fixture,d,card,baseCard,baseRun} from './fixture.ts';
const sync=d as any;
function queued(){
 const f=fixture(),call=f.serviceCall(),ref=card(d.decide(d.openRequest({kind:'service',service:'email',claim:f.claim,call}),baseCard));
 const item:any={approvalId:ref.approvalId,kind:'email',ref:'q',epoch:'e',call,view:{title:'Queue',subtitle:'Fixture'},proof:'trusted'};
 const respond=vi.fn(async()=>({state:'accepted' as const}));
 const source:d.QueueRecoverySource={kind:'email',pendingApprovals:()=>[item],reopen:()=>({kind:'service',service:'email',claim:f.claim,call}),base:baseCard,respond,cancel:async()=>{},renew:async()=>item};
 const dispose=d.installQueueSources([source]);d.attachQueue(ref,{kind:'email',ref:'q',call});
 return {f,call,ref,item,respond,dispose};
}
it('CA1 sync queue presentation and acceptance share the durable record, answerId and async coordinator',async()=>{
 const q=queued();let disposeSync=()=>{};
 try{
  expect(typeof sync.installSynchronousQueueDeliveries).toBe('function');
  const respondNow=vi.fn((_item:any,_answer:any,options:any)=>{const r=d.readApproval(q.ref.approvalId)! as any;expect(r.delivery).toBe('pending');expect(q.f.db.prepare('SELECT answer_id FROM approval_records WHERE id=?').get(q.ref.approvalId)!.answer_id).toBe(options.answerId);return {state:'accepted'};});
  disposeSync=sync.installSynchronousQueueDeliveries([{kind:'email',respondNow}]);
  expect(sync.presentApprovalSync(q.ref,q.item.view)).toBeUndefined();
  expect(q.f.store.messageById('t',d.readApproval(q.ref.approvalId)!.chatMessageId)).toBeDefined();
  expect(sync.answerApprovalSync(q.ref,{behavior:'allow'})).toEqual({state:'accepted'});
  expect(sync.answerApprovalSync(q.ref,{behavior:'allow'})).toEqual({state:'already'});
  await d.answerApproval(q.ref,{behavior:'allow'});expect(q.respond).not.toHaveBeenCalled();expect(respondNow).toHaveBeenCalledTimes(1);
  expect((d.readApproval(q.ref.approvalId) as any).delivery).toBe('accepted');
  expect(sync.answerApprovalSync(q.ref,{behavior:'deny'})).toEqual({state:'failed'});
 }finally{disposeSync();q.dispose();}
});
it('CA1 sync delivery rejects missing capability, engines, promises and inflight async answers',async()=>{
 const q=queued();let disposeSync=()=>{};
 try{
  await d.presentApproval(q.ref,q.item.view);
  expect(typeof sync.answerApprovalSync).toBe('function');expect(sync.answerApprovalSync(q.ref,{behavior:'allow'})).toEqual({state:'failed'});
  disposeSync=sync.installSynchronousQueueDeliveries([{kind:'email',respondNow:()=>Promise.resolve({state:'accepted'})}]);
  expect(sync.answerApprovalSync(q.ref,{behavior:'allow'})).toEqual({state:'failed'});expect((d.readApproval(q.ref.approvalId) as any).delivery).toBe('failed');disposeSync();
  let ack!:(value:any)=>void;q.respond.mockImplementation(()=>new Promise(resolve=>{ack=resolve;}));
  const work=d.answerApproval(q.ref,{behavior:'allow'});await Promise.resolve();expect(sync.answerApprovalSync(q.ref,{behavior:'allow'})).toEqual({state:'failed'});ack({state:'accepted'});await work;
  const engine=card(d.decide(q.f.open('engine',{command:'rm -rf ~'}),baseCard));await d.presentApproval(engine,q.item.view);expect(sync.answerApprovalSync(engine,{behavior:'allow'})).toEqual({state:'failed'});
 }finally{disposeSync();q.dispose();}
});
it('CA2 durable views expose none, pending, accepted and failed delivery',async()=>{
 const f=fixture(),ref=card(d.decide(f.open('r',{command:'rm -rf ~'}),baseCard));await d.presentApproval(ref,{title:'Fixture',subtitle:'x'});
 expect((d.readApproval(ref.approvalId) as any).delivery).toBe('none');
 f.respond.mockImplementation(async()=>{expect((d.readApproval(ref.approvalId) as any).delivery).toBe('pending');return {state:'accepted'};});
 await d.answerApproval(ref,{behavior:'allow'});expect((d.lookupApproval('t',d.readApproval(ref.approvalId)!.chatMessageId) as any).delivery).toBe('accepted');
 f.db.prepare("UPDATE approval_records SET delivery='failed' WHERE id=?").run(ref.approvalId);expect((d.readApproval(ref.approvalId) as any).delivery).toBe('failed');
});
it('CA3 Allowed and legacy allow reach both specified index reply branches',async()=>{
 expect(typeof sync.isAllowedAnswer).toBe('function');for(const label of ['Allowed','allow'])expect(sync.isAllowedAnswer(label)).toBe(true);
 for(const label of ['Denied','deny','Allowed, not run (restart)',undefined,'ALLOW'])expect(sync.isAllowedAnswer(label)).toBe(false);
 const source=readFileSync('server/index.ts','utf8');
 // Extract only the production early-return block, before provider access.
 const anchor=source.indexOf('// The owner already settled this card');
 const start=source.indexOf('  if (',anchor);
 const block=source.slice(start,source.indexOf('  const question =',start)).replace('let outcome: RequestOutcome =','let outcome =');
 expect(start).toBeGreaterThan(anchor);
 // Keep producer and provider calls in the extracted production block so a
 // dismissed-card regression fails on behaviour, rather than on extraction.
 const evaluate=new Function('card','behavior','isAllowedAnswer','registry','imageOperations','publishOperations','return (async()=>{const threadId="t",requestId="r",instanceId="p",message=undefined,answers=undefined;'+block+'\nreturn "unavailable";})();');
 const provider=vi.fn(async()=> 'allowed-once');
 const registry={get:vi.fn(()=>({adapter:{respondToRequest:provider}}))};
 const imageOperations={resolve:vi.fn()},publishOperations={resolve:vi.fn()};
 for(const answered of ['Allowed','allow'])for(const dismissed of [false,true])expect(await evaluate({answered,dismissed},'allow',sync.isAllowedAnswer,registry,imageOperations,publishOperations)).toBe('allowed-once');
 expect(registry.get).not.toHaveBeenCalled();expect(provider).not.toHaveBeenCalled();
 expect(imageOperations.resolve).not.toHaveBeenCalled();expect(publishOperations.resolve).not.toHaveBeenCalled();
 const skill=source.slice(source.indexOf('// Settlement is durable before cleanup.'),source.indexOf('  if (args.behavior !== "allow")',source.indexOf('// Settlement is durable before cleanup.')));
 expect(skill).toContain('isAllowedAnswer(card.answered)');expect(skill).not.toMatch(/card\.answered\s*[!=]==?\s*"allow"/);
});
it('CA4 S1 terminal writers leave answeredAt absent through allow, deny, expiry and cancellation',async()=>{
 const f=fixture();for(const state of ['allow','deny','expired','cancelled'] as const){
  const ref=card(d.decide(f.open(state,{command:'rm -rf ~'}),baseCard));await d.presentApproval(ref,{title:'Fixture',subtitle:'x'});
  if(state==='allow'||state==='deny')await d.answerApproval(ref,{behavior:state});else await d.settle(ref,state);
  const row=d.readApproval(ref.approvalId)!;expect(qCard(f,row.chatMessageId)).not.toHaveProperty('answeredAt');
 }
});
function qCard(f:ReturnType<typeof fixture>,id:string){return JSON.parse(String(f.db.prepare('SELECT json FROM messages WHERE id=?').get(id)!.json)).card;}
it('CA1 sync presentation rolls record and row back together and stays idempotent',()=>{
 const q=queued();try{
  (q.f.store as any).messageRewrite=()=>null;
  expect(()=>sync.presentApprovalSync(q.ref,q.item.view)).toThrow('approval-row-not-written');
  expect(q.f.db.prepare('SELECT COUNT(*) n FROM approval_records').get()!.n).toBe(0);
  (q.f.store as any).messageRewrite=undefined;
  sync.presentApprovalSync(q.ref,q.item.view);sync.presentApprovalSync(q.ref,q.item.view);
  expect(q.f.db.prepare("SELECT COUNT(*) n FROM messages WHERE kind='options'").get()!.n).toBe(1);
 }finally{q.dispose();}
});
it('CA1 failed synchronous sends retain the answerId and explicit retries reuse it',()=>{
 const q=queued();let disposeSync=()=>{};try{
  sync.presentApprovalSync(q.ref,q.item.view);let tries=0;const ids:string[]=[];
  disposeSync=sync.installSynchronousQueueDeliveries([{kind:'email',respondNow:(_item:any,_answer:any,options:any)=>{ids.push(options.answerId);if(tries++===0)throw new Error('fake-send-failure');return {state:'accepted'};}}]);
  expect(sync.answerApprovalSync(q.ref,{behavior:'allow'})).toEqual({state:'failed'});
  expect(sync.answerApprovalSync(q.ref,{behavior:'allow'})).toEqual({state:'accepted'});
  expect(new Set(ids).size).toBe(1);expect(ids).toHaveLength(2);
  expect(sync.answerApprovalSync(q.ref,{behavior:'deny'})).toEqual({state:'failed'});
 }finally{disposeSync();q.dispose();}
});
it('CA1 Promise acknowledgements carrying a misleading accepted state are still failed',()=>{
 const q=queued();let disposeSync=()=>{};try{
  sync.presentApprovalSync(q.ref,q.item.view);
  disposeSync=sync.installSynchronousQueueDeliveries([{kind:'email',respondNow:()=>Object.assign(Promise.resolve({state:'accepted'}),{state:'accepted'})}]);
  expect(sync.answerApprovalSync(q.ref,{behavior:'allow'})).toEqual({state:'failed'});
  expect(()=>sync.installSynchronousQueueDeliveries([{kind:'email',respondNow:()=>({state:'accepted'})}])).toThrow('duplicate-queue-source');
 }finally{disposeSync();q.dispose();}
});
it('CA1 a cleared deny before sync presentation delivers RUN once without creating a card',()=>{
 const f=fixture('full');let allowed=false;const base=()=>allowed?baseRun():baseCard();f.deny([{kind:'deny',class:'system',ruleId:'fixture-deny',span:'fixture'}]);
 const call=f.serviceCall({command:'echo fixture'}),ref=card(d.decide(d.openRequest({kind:'service',service:'email',claim:f.claim,call}),base));
 const item:any={approvalId:ref.approvalId,kind:'email',ref:'q',epoch:'e',call,view:{title:'Fixture',subtitle:'x'},proof:'trusted'};
 const dispose=d.installQueueSources([{kind:'email',pendingApprovals:()=>[item],reopen:()=>({kind:'service',service:'email',claim:f.claim,call}),base,respond:async()=>({state:'failed'}),cancel:async()=>{},renew:async()=>item}]);
 let disposeSync=()=>{};try{
  const respondNow=vi.fn(()=>({state:'accepted'}));disposeSync=sync.installSynchronousQueueDeliveries([{kind:'email',respondNow}]);
  d.attachQueue(ref,{kind:'email',ref:'q',call});f.deny([]);allowed=true;sync.presentApprovalSync(ref,item.view);sync.presentApprovalSync(ref,item.view);
  expect(respondNow).toHaveBeenCalledTimes(1);expect(d.openApprovals()).toHaveLength(0);expect(f.db.prepare('SELECT COUNT(*) n FROM messages').get()!.n).toBe(0);
 }finally{disposeSync();dispose();}
});
