import {expect,it} from 'vitest';
import {fixture,d,card,baseCard} from './fixture.ts';
it.each(['allow','deny','expired'] as const)('A6 F5 terminal %s emits the persisted patch',async behavior=>{
 const f=fixture();const seen:any[]=[];f.store.onChange(e=>seen.push(e));const ref=card(d.decide(f.open('r',{command:'rm -rf ~'}),baseCard));await d.presentApproval(ref,{title:'Fixture',subtitle:'x'});
 if(behavior==='expired')await d.settle(ref,'expired');else await d.answerApproval(ref,{behavior});
 expect(seen.filter(e=>e.type==='message.patch'&&e.message.card?.answered)).toHaveLength(1);expect(d.readApproval(ref.approvalId)?.state).toBe(behavior==='expired'?'expired':'answered');
});
it('R17 M5 queue→card consumes one record, accepts JSON round-trip, rejects wrong refs (M20)',async()=>{
 const f=fixture();const call=f.serviceCall();const ref=card(d.decide(d.openRequest({kind:'service',service:'email',claim:f.claim,call}),baseCard));expect(f.db.prepare('SELECT COUNT(*) n FROM approval_records').get()!.n).toBe(0);
 expect(()=>d.attachQueue(ref,{kind:'email',ref:'wrong',call})).toThrow();d.attachQueue(ref,{kind:'email',ref:'q',call});await d.presentApproval(ref,{title:'Fixture',subtitle:'x'});await d.presentApproval(ref,{title:'Duplicate',subtitle:'x'});
 const r=d.readApproval(ref.approvalId)!;expect(JSON.parse(JSON.stringify(r)).actionHash).toBe(r.actionHash);expect(f.db.prepare('SELECT COUNT(*) n FROM approval_records').get()!.n).toBe(1);expect(d.lookupApproval('t',r.chatMessageId)?.ref.approvalId).toBe(ref.approvalId);
});
it('A6 F5 restart expires an engine record and emits its terminal patch after durable state',async()=>{
 const f=fixture();const ref=card(d.decide(f.open('r',{command:'rm -rf ~'}),baseCard));await d.presentApproval(ref,{title:'Fixture',subtitle:'x'});let terminal=false;f.store.onChange(e=>{if(e.type==='message.patch'){expect(d.readApproval(ref.approvalId)?.state).toBe('expired');terminal=true;}});await d.recover();expect(terminal).toBe(true);
});
it('A6 F5 legacy terminal patches reach the client',async()=>{
 const {APPROVAL_OBJECTS,initializeApprovals}=await import('./records.ts');const f=fixture();for(const name of APPROVAL_OBJECTS.triggers)f.db.exec(`DROP TRIGGER ${name}`);
 const row={id:'legacy',at:1,role:'bot',kind:'options',card:{requestId:'old',title:'Legacy',subtitle:'x',options:['Allow','Deny']}};
 f.db.prepare('INSERT INTO messages(thread_id,id,at,role,kind,json) VALUES(?,?,?,?,?,?)').run('t',row.id,1,'bot','options',JSON.stringify(row));initializeApprovals(f.db);const seen:any[]=[];f.store.onChange(e=>seen.push(e));const m=f.store.messageById('t','legacy')!;f.store.patchMessagePoint('t','legacy',{card:{...m.card,answered:'Expired',orphaned:true}} as any);expect(seen.filter(e=>e.type==='message.patch')).toHaveLength(1);
});
