import {expect,it} from 'vitest';
import {fixture,d,card,baseCard} from './fixture.ts';
it.each(['allow','deny','expire'] as const)('A4b M54 terminal duplicate %s retains one tombstone and row',async answer=>{
 const f=fixture();const ref=card(d.decide(f.open('r',{command:'rm -rf ~'}),baseCard));await d.presentApproval(ref,{title:'Fixture',subtitle:'x'});
 if(answer==='expire')await d.settle(ref,'expired');else await d.answerApproval(ref,{behavior:answer});
 f.publish(f.event('r',{command:'rm -rf ~'}));const duplicate=card(d.decide(d.openRequest({kind:'engine',threadId:'t',requestId:'r'}),baseCard));await d.presentApproval(duplicate,{title:'Duplicate',subtitle:'x'});
 expect(duplicate.approvalId).toBe(ref.approvalId);expect(f.db.prepare('SELECT COUNT(*) n FROM approval_records').get()!.n).toBe(1);expect(f.db.prepare("SELECT COUNT(*) n FROM messages WHERE kind='options'").get()!.n).toBe(1);expect(f.respond.mock.calls.length).toBeLessThanOrEqual(1);
});
it('M54 terminal SQL tombstone rejects a second record with the same request key',async()=>{
 const {readRecord,insertRecord}=await import('./records.ts');const f=fixture();const ref=card(d.decide(f.open('r',{command:'rm -rf ~'}),baseCard));await d.presentApproval(ref,{title:'Fixture',subtitle:'x'});await d.settle(ref,'expired');const row=readRecord(f.db,ref.approvalId)!;
 expect(()=>insertRecord(f.db,{...row,id:'different-id',chat_message_id:'different-row',state:'open'})).toThrow();
});
