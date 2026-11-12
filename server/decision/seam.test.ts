import { expect,it } from 'vitest';
import { fixture,d,card,baseCard } from './fixture.ts';
const raw={role:'bot',kind:'options',card:{title:'Forged',subtitle:'x',options:['Allow'],requestId:'forged'}} as any;
it('A1 R2 M10 M11 M12 M15 M17 refuse unregistered final rows through real Store and raw SQL',()=>{
 const f=fixture();const m=f.store.appendMessage('t',{role:'user',kind:'text',text:'text'});
 expect(()=>f.store.patchMessage('t',m.id,JSON.parse(JSON.stringify(raw)))).toThrow();
 expect(()=>f.store.insertMessageBefore('t',m.id,raw)).toThrow();
 expect(()=>f.store.appendAfterHead('t',m.id,raw)).toThrow();
 expect(()=>f.db.prepare('UPDATE messages SET kind=?,json=? WHERE id=?').run('options',JSON.stringify({...raw,id:m.id}),m.id)).toThrow();
 expect(f.db.prepare("SELECT COUNT(*) n FROM messages WHERE kind='options'").get()!.n).toBe(0);
});
it('A1 M14 M16 action identity and unknown payload fields cannot change; terminal patches emitted',async()=>{
 const f=fixture();const ref=card(d.decide(f.open('r',{command:'rm -rf ~'}),baseCard)); await d.presentApproval(ref,{title:'Action',subtitle:'x'});
 const r=d.readApproval(ref.approvalId)!; const m=f.store.messageById('t',r.chatMessageId)!;
 for(const patch of [{requestId:'different'},{options:['Changed']},{newUnknown:'changed'},{subtitle:'unanswered changed'}]) expect(()=>f.store.patchMessagePoint('t',m.id,{card:{...m.card,...patch}} as any)).toThrow();
 for(const col of ['id','thread_id'])expect(()=>f.db.prepare(`UPDATE messages SET ${col}=? WHERE id=?`).run('changed',m.id)).toThrow();
 expect(()=>f.db.prepare('UPDATE messages SET json=? WHERE id=?').run('{invalid',m.id)).toThrow();
 await d.answerApproval(ref,{behavior:'allow'} as any);expect(d.readApproval(ref.approvalId)!.state).toBe('answered');
 expect(()=>f.store.patchMessage('t',m.id,{card:{...f.store.messageById('t',m.id)!.card,subtitle:'redacted'}} as any)).not.toThrow();
});
it('A1 M18 emit-only forged permission patch is dropped; credentials cannot carry cards',()=>{
 const f=fixture();const events:any[]=[];f.store.onChange(e=>events.push(e));
 (f.store as any).emit({type:'message.patch',threadId:'t',message:{...raw,id:'x',at:1}});expect(events).toHaveLength(0);
 expect(()=>f.store.appendMessage('t',{...raw,kind:'secret'})).toThrow();
});
it('M40 invalid JSON on ordinary rows is admitted without parsing; permission erasure aborts',async()=>{
 const f=fixture();const m=f.store.appendMessage('t',{role:'user',kind:'text',text:'x'});
 expect(()=>f.db.prepare('UPDATE messages SET json=? WHERE id=?').run('{invalid',m.id)).not.toThrow();
 const ref=card(d.decide(f.open('r',{command:'rm -rf ~'}),baseCard));await d.presentApproval(ref,{title:'Fixture',subtitle:'x'});
 expect(()=>f.db.prepare('UPDATE messages SET kind=? WHERE id=?').run('text',d.readApproval(ref.approvalId)!.chatMessageId)).toThrow('card-action-changed');
});
it('M40 malformed options JSON is inert and can be repaired without a JSON parser error',()=>{
 const f=fixture();f.db.prepare('INSERT INTO messages(thread_id,id,at,role,kind,json) VALUES(?,?,?,?,?,?)').run('t','malformed',1,'bot','options','{invalid');
 expect(()=>f.db.prepare('UPDATE messages SET json=? WHERE id=?').run('{still-invalid','malformed')).not.toThrow();
});
