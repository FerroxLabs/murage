import {expect,it,vi} from 'vitest';
import {fixture,d,card,baseCard} from './fixture.ts';
import {readRecord} from './records.ts';
function queue(f:ReturnType<typeof fixture>){
 const call=f.serviceCall();const ref=card(d.decide(d.openRequest({kind:'service',service:'email',claim:f.claim,call}),baseCard));
 let item:any={approvalId:ref.approvalId,kind:'email',ref:'q',epoch:'e',call,view:{title:'Queue',subtitle:'x'},proof:'trusted'};
 const source:d.QueueRecoverySource={kind:'email',pendingApprovals:()=>item?[item]:[],reopen:i=>({kind:'service',service:'email',claim:f.claim,call:i.call}),base:baseCard,respond:vi.fn(async()=>({state:'accepted' as const})),cancel:vi.fn(async()=>{item=undefined;}),renew:async(i,id)=>item={...i,...id,call:{...i.call,approval:{...i.call.approval,...id}}}};
 const dispose=d.installQueueSources([source]);return {call,ref,source,dispose};
}
it('A4a M53 queue-first crash, tx rollback, committed restart yield exactly one usable row',async()=>{
 const f=fixture();const q=queue(f);try{
 // queue persisted, record missing: recovery reopens through verifier
 await d.recover();expect(d.openApprovals()).toHaveLength(1);
 await d.recover();expect(d.openApprovals()).toHaveLength(1);expect(f.db.prepare("SELECT COUNT(*) n FROM messages WHERE kind='options'").get()!.n).toBe(1);
 }finally{q.dispose();}
});
it('A4a M53 record and row roll back together when messageRewrite drops the row',async()=>{
 const f=fixture();const q=queue(f);try{d.attachQueue(q.ref,{kind:'email',ref:'q',call:q.call});(f.store as any).messageRewrite=()=>null;
 await expect(d.presentApproval(q.ref,{title:'Queue',subtitle:'x'})).rejects.toThrow();expect(f.db.prepare('SELECT COUNT(*) n FROM approval_records').get()!.n).toBe(0);
 }finally{q.dispose();}
});
it('A4c M55 answer/answerId/pending survive crash before acceptance; restart never claims execution',async()=>{
 const f=fixture();const ref=card(d.decide(f.open('r',{command:'rm -rf ~'}),baseCard));await d.presentApproval(ref,{title:'Fixture',subtitle:'x'});
 f.respond.mockImplementation(async()=>{const row=readRecord(f.db,ref.approvalId)!;expect(row.answer_id).toBeTruthy();expect(row.delivery).toBe('pending');throw new Error('crash');});
 await d.answerApproval(ref,{behavior:'allow'});expect(readRecord(f.db,ref.approvalId)!.answer_id).toBeTruthy();
 f.db.prepare("UPDATE approval_records SET delivery='pending' WHERE id=?").run(ref.approvalId);await d.recover();expect(f.store.messageById('t',d.readApproval(ref.approvalId)!.chatMessageId)!.card!.answered).toBe('Allowed, not run (restart)');
});
it('recovery refuses a missing queue adapter instead of reporting success',async()=>{
 const f=fixture();const q=queue(f);d.attachQueue(q.ref,{kind:'email',ref:'q',call:q.call});await d.presentApproval(q.ref,{title:'Queue',subtitle:'x'});q.dispose();await expect(d.recover()).rejects.toThrow('queue-recovery-source-missing');
});
it('A4a A4c orphaned queue re-decided RUN persists one answerId before transport and across a crash',async()=>{
 const {readQueueDelivery}=await import('./records.ts');const f=fixture();let pending=true,fail=true;const ids:string[]=[],observed:any[]=[];const call=f.serviceCall({command:'echo x'});const item:any={approvalId:'queue-before-record',kind:'email',ref:'q',epoch:'e',call,view:{title:'Queue',subtitle:'x'},proof:'trusted'};
 const dispose=d.installQueueSources([{kind:'email',pendingApprovals:()=>pending?[item]:[],reopen:()=>({kind:'service',service:'email',claim:f.claim,call}),base:baseCard,renew:async()=>item,cancel:async()=>{throw new Error('fixture-crash');},respond:async(_item,_answer,options)=>{observed.push(readQueueDelivery(f.db,item.approvalId));ids.push(options!.answerId);if(fail)throw new Error('fixture-crash');pending=false;return {state:'accepted'};}}]);
 try{await expect(d.recover()).rejects.toThrow('fixture-crash');fail=false;await d.recover();for(const receipt of observed)expect(receipt).toMatchObject({answerId:ids[0],delivery:'pending'});expect(new Set(ids).size).toBe(1);expect(pending).toBe(false);expect(d.openApprovals()).toHaveLength(0);expect(f.db.prepare("SELECT COUNT(*) n FROM messages WHERE kind='options'").get()!.n).toBe(0);}finally{dispose();}
});
