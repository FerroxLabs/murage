import {expect,it} from 'vitest';
import {fixture,d,card,baseCard} from './fixture.ts';
import {insertMessageAfter} from '../message-db.ts';
it('R2 M1 M3 M4 M6 M7 M8 forged, discarded and factory authority cannot present',async()=>{
 const f=fixture();const outcome=d.decide(f.open(),baseCard);expect(outcome.kind).toBe('run');
 const raw:any={role:'bot',kind:'options',card:{title:'Factory',subtitle:'x',options:['Allow','Deny'],requestId:'bypass'}};
 expect(()=>f.store.appendMessage('t',raw)).toThrow();
 await expect(d.presentApproval({approvalId:'forged'} as any,{title:'Forged',subtitle:'x'})).rejects.toThrow();
 await expect(d.presentApproval((outcome as any).ref,{title:'Smuggled',subtitle:'x'})).rejects.toThrow();
 expect(()=>d.attachQueue({approvalId:'forged'} as any,{kind:'email',ref:'q',call:f.serviceCall()})).toThrow();
});
it('R2 M13 insertMessageAfter patched[] aborts and leaves no permission rows',()=>{
 const f=fixture();const before=f.store.appendMessage('t',{role:'user',kind:'text',text:'anchor'});const fresh={id:'new',at:2,role:'bot',kind:'text',text:'normal'} as any;
 expect(()=>insertMessageAfter('t',fresh,before.id,[{...before,kind:'options',card:{requestId:'forged',options:['Allow']}} as any],[])).toThrow();expect(f.db.prepare("SELECT COUNT(*) n FROM messages WHERE kind='options'").get()!.n).toBe(0);
});
it('R2 M15 rewrite-injected card is checked after transformations',()=>{
 const f=fixture();(f.store as any).messageRewrite=(_m:any,input:any)=>({...input,kind:'options',card:{requestId:'injected',title:'Injected',subtitle:'x',options:['Allow']}});
 expect(()=>f.store.appendMessage('t',{role:'user',kind:'text',text:'original'})).toThrow();expect(f.db.prepare("SELECT COUNT(*) n FROM messages WHERE kind='options'").get()!.n).toBe(0);
});
it('R2 M16 computed payload mutation after a real record cannot change action in raw SQL',async()=>{
 const f=fixture();const ref=card(d.decide(f.open('r',{command:'rm -rf ~'}),baseCard));await d.presentApproval(ref,{title:'Fixture',subtitle:'x'});const record=d.readApproval(ref.approvalId)!;
 const row=JSON.parse(String(f.db.prepare('SELECT json FROM messages WHERE id=?').get(record.chatMessageId)!.json));const k='options';row.card[k]=['Different action'];
 expect(()=>f.db.prepare('UPDATE messages SET json=? WHERE id=?').run(JSON.stringify(row),record.chatMessageId)).toThrow('card-action-changed');
});

it('R2 M2 wrong-request authority cannot attach another registered queue call',()=>{
 const f=fixture();const a=f.serviceCall(),b=f.serviceCall();const spec:any=b.approval;spec.queueRef='b';spec.action.requestId='b';spec.action.emailSend.sendId='b';const ref=card(d.decide(d.openRequest({kind:'service',service:'email',claim:f.claim,call:a}),baseCard));d.decide(d.openRequest({kind:'service',service:'email',claim:f.claim,call:b}),baseCard);expect(()=>d.attachQueue(ref,{kind:'email',ref:'b',call:b})).toThrow('queue-action-mismatch');expect(f.db.prepare("SELECT COUNT(*) n FROM messages WHERE kind='options'").get()!.n).toBe(0);
});
