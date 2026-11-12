import { expect, it, vi } from 'vitest';
import { backup, DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { DATA_DIR } from '../config.ts';
import { EmailStore } from '../email/email-store.ts';
import { EmailSendService } from '../email/send-service.ts';
import { sanitizeStagedEmailRows } from '../installation-database-snapshot.ts';
import { fixture, d } from './fixture.ts';

for(const attachments of [false,true]) it.each([false,true])(`D7 real pending bot email can be backed up (answered=%s) without a mail body in the archive${attachments?' (attachments)':''}`, async answered => {
  const f=fixture('ask'), email=new EmailStore(f.db), body='Private email backup body D7\n\nAttachments:\nStill the body 📨\n';
  email.insertBinding({botId:'b',inboxId:'inbox',address:'bot@example.test',username:'bot',displayName:'Bot',emailKeyRef:null,fluxAccountId:null,state:'active',step:null,opId:null,opStartedAt:null,policy:'ask',failure:null,updatedAt:Date.now()});
  const client:any=Object.fromEntries(['send','reply','getApproval','listApprovals','approve','withdrawHeld','retryHeld','listMessages'].map(k=>[k,vi.fn(()=>{throw new Error('unexpected provider request');})]));
  const send=new EmailSendService({store:email,client,installId:'fixture',authorityFor:()=>({claim:f.claim,proof:{source:'fixture'}})});
  const result=await send.submit({botId:'b',threadId:'t',generation:1,draft:{kind:'send',to:['owner@example.test'],cc:[],subject:'Backup fixture',text:body,attachments:attachments?[{name:'fixture.txt',contentType:'text/plain',bytes:new Uint8Array([1,2,3])}]:[],replyTo:null}});
  expect(result).toMatchObject({status:'accepted',row:{state:'awaiting_owner'}});
  const pending=send.pendingApprovals();expect(pending).toHaveLength(1);
  expect(JSON.stringify(f.db.prepare('SELECT presented_action FROM approval_records').all())).toContain('Backup fixture');
  const record=f.db.prepare('SELECT presented_action FROM approval_records').get() as {presented_action:string};
  const action=JSON.parse(record.presented_action);
  expect(action.emailSend.draft).toMatchObject({text:'',presentation:{textLength:body.length}});
  const view=pending[0].view, {textLength,trailingLength}=action.emailSend.draft.presentation;
  expect(trailingLength>0).toBe(attachments);
  const end=view.subtitle!.length-trailingLength;
  expect(view.subtitle!.slice(end-textLength,end)).toBe(body);
  if(answered) {
    const q=send.approvalQueue(),dispose=d.installQueueSources([{kind:'email',pendingApprovals:()=>q.pendingApprovals(),base:q.base,reopen:()=>undefined,respond:(...args)=>q.respond(...args),cancel:(...args)=>q.cancel(...args),renew:(...args)=>q.renew(...args)}]);
    try {await q.answer(pending[0].approvalId,{behavior:'deny'});expect(d.readApproval(pending[0].approvalId)).toMatchObject({state:'answered',delivery:'accepted'});}finally{dispose();}
  }
  const file=join(DATA_DIR,`staged-${answered}-${attachments}.db`); await backup(f.db,file);
  const staged=new DatabaseSync(file);
  try {
    expect(()=>sanitizeStagedEmailRows(staged)).not.toThrow();
    for(const table of ['messages','approval_records','email_payloads','email_events']) expect(JSON.stringify(staged.prepare(`SELECT * FROM ${table}`).all()),table).not.toContain('Private email backup body D7');
  } finally {staged.close();}
  if(!answered) expect(email.getPayload(pending[0].ref).length).toBeGreaterThan(0);
});
