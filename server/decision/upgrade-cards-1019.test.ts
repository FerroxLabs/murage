import {expect,it} from 'vitest';
import {APPROVAL_OBJECTS,initializeApprovals,terminalLegacy} from './records.ts';
import {fixture} from './fixture.ts';
const answered={id:'history118',at:1,role:'bot',kind:'options',card:{requestId:'old',answered:'Sent',emailSend:{sendId:'old',draft:{text:'Historical owner mail body'}}}};
it('D4 upgrade preserves the body of an answered 1.0.18 email card',()=>{
 const f=fixture();for(const name of APPROVAL_OBJECTS.triggers)f.db.exec(`DROP TRIGGER ${name}`);
 f.db.prepare('INSERT INTO messages(thread_id,id,at,role,kind,json) VALUES(?,?,?,?,?,?)').run('t',answered.id,1,'bot','options',JSON.stringify(answered));
 initializeApprovals(f.db);
 expect(JSON.parse(String(f.db.prepare('SELECT json FROM messages WHERE id=?').get(answered.id)!.json)).card.emailSend.draft.text).toBe('Historical owner mail body');
});
it('D4 lazy import also preserves answered email history while unproven requests remain terminal',()=>{
 expect(terminalLegacy(answered).card.emailSend.draft.text).toBe('Historical owner mail body');
 const pending={...answered,card:{...answered.card,answered:undefined}};
 expect(terminalLegacy(pending).card).toMatchObject({orphaned:true,answered:'Expired (upgrade)',emailSend:{draft:{text:''}}});
});
it('D4 a safe 1.0.18 awaiting-owner email gets a fresh actionable approval from its durable send row',async()=>{
 const {EmailStore}=await import('../email/email-store.ts'),{EmailSendService}=await import('../email/send-service.ts'),{emailCardView}=await import('../email/cards.ts');
 const {downgradeApprovals}=await import('../installation-app-schema-downgrade.ts'),{removeTempDirSync}=await import('../testing/cleanup.ts'),{join}=await import('node:path'),{DATA_DIR}=await import('../config.ts');
 const {d}=await import('./fixture.ts');const f=fixture('ask'),email=new EmailStore(f.db);
 email.insertBinding({botId:'b',inboxId:'inbox',address:'bot@example.test',username:'bot',displayName:'Bot',emailKeyRef:null,fluxAccountId:null,state:'active',step:null,opId:null,opStartedAt:null,policy:'ask',failure:null,updatedAt:Date.now()});
 const options={store:email,installId:'fixture',authorityFor:()=>({claim:f.claim,proof:{source:'fixture'}}),client:{} as any};
 const first=new EmailSendService(options),result=await first.submit({botId:'b',threadId:'t',generation:1,draft:{kind:'send',to:['owner@example.test'],cc:[],subject:'Upgrade fixture',text:'Pending durable body',attachments:[],replyTo:null}});
 if(!('row'in result))throw Error('missing send');const row=result.row;
 downgradeApprovals(f.db);removeTempDirSync(join(DATA_DIR,'decision-queues'));
 f.db.exec('DELETE FROM messages');
 const legacy={id:'pending118',at:1,role:'bot',kind:'options',card:emailCardView(row,{botName:'Bot',text:'Pending durable body',approved:()=>false})};
 f.db.prepare('INSERT INTO messages(thread_id,id,at,role,kind,json) VALUES(?,?,?,?,?,?)').run('t',legacy.id,1,'bot','options',JSON.stringify(legacy));
 initializeApprovals(f.db);
 const restarted=new EmailSendService(options);await restarted.syncApproval(row);
 const item=restarted.pendingApprovals()[0];expect(item).toBeDefined();const record=d.readApproval(item.approvalId)!;
 expect(record.state).toBe('open');expect(f.store.messageById('t',record.chatMessageId)?.card).toMatchObject({emailSend:{sendId:row.sendId}});
 const q=restarted.approvalQueue(),dispose=d.installQueueSources([{kind:'email',pendingApprovals:()=>q.pendingApprovals(),base:q.base,reopen:()=>undefined,respond:(...args)=>q.respond(...args),cancel:(...args)=>q.cancel(...args),renew:(...args)=>q.renew(...args)}]);
 try {await q.answer(item.approvalId,{behavior:'deny'});expect(d.readApproval(item.approvalId)?.delivery).toBe('accepted');expect(email.getSend(row.sendId)?.state).toBe('declined');}finally{dispose();}
});
