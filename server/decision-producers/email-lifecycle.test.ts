import {DatabaseSync} from 'node:sqlite';
import {rmSync} from 'node:fs';
import {join} from 'node:path';
import {DATA_DIR} from '../config.ts';
import {randomUUID} from 'node:crypto';
import {it,expect,vi,beforeEach,afterEach} from 'vitest';
vi.hoisted(()=>vi.resetModules());
const core=vi.hoisted(()=>({openRequest:vi.fn(),decide:vi.fn(),executeService:vi.fn(),readApproval:vi.fn(),openApprovals:vi.fn(()=>[]),attachQueue:vi.fn(),presentApproval:vi.fn(),answerApproval:vi.fn(),settle:vi.fn(),readTurnPolicy:vi.fn(),executeServiceSync:vi.fn(),answerApprovalSync:vi.fn(),presentApprovalSync:vi.fn()}));
vi.mock('../decision/index.ts',()=>core);
import {EmailStore,type SendRow} from '../email/email-store.ts';
import {EmailSendService} from '../email/send-service.ts';
import {EmailCards} from '../email/cards.ts';
const claim={} as any;
let db:DatabaseSync,store:EmailStore,send:EmailSendService,cards:EmailCards;
let scenario:'run'|'base'|'deny', calls:Map<any,any>,records:Map<string,any>;
const client:any={send:vi.fn(),reply:vi.fn(),getApproval:vi.fn(),approve:vi.fn(),withdrawHeld:vi.fn(),retryHeld:vi.fn(),listApprovals:vi.fn(),listMessages:vi.fn()};
const host:any={botName:()=> 'Bot',threadExists:()=>true,card:vi.fn(()=>null),appendCard:vi.fn(()=>{throw new Error('raw card');}),patchCard:vi.fn(()=>{throw new Error('action mutation');}),outcome:vi.fn(),activity:vi.fn(),notify:vi.fn()};
const draft={kind:'send' as const,to:['recipient@example.test'],cc:[],subject:'rm -rf ~',text:'rm -rf ~',attachments:[],replyTo:null};
const submit=(holdForOwner=false)=>send.submit({botId:'bot',threadId:'thread',generation:1,draft,holdForOwner});
beforeEach(()=>{
 vi.clearAllMocks();for(const method of Object.values(client))vi.mocked(method as any).mockReset();scenario='run';calls=new Map();records=new Map();
 rmSync(join(DATA_DIR,'decision-queues','email.json'),{force:true});
 db=new DatabaseSync(':memory:');store=new EmailStore(db);
 store.insertBinding({botId:'bot',inboxId:'inbox',address:'bot@example.test',username:'bot',displayName:'Bot',emailKeyRef:null,fluxAccountId:null,state:'active',step:null,opId:null,opStartedAt:null,policy:'auto',failure:null,updatedAt:Date.now()});
 store.addTrusted('bot',draft.to[0],'allow','owner',Date.now());
 core.openRequest.mockImplementation(source=>{const key={};calls.set(key,source);return key;});
 core.decide.mockImplementation((handle,base)=>{
  const source=calls.get(handle);if(scenario==='run'||scenario==='base'&&base({source}).approve)return {kind:'run'};
  const ref={approvalId:randomUUID()};records.set(ref.approvalId,{ref,state:'open',threadId:'thread',botId:'bot',requestId:source.call.approval.queueRef,chatMessageId:randomUUID(),actionHash:'a'.repeat(64),queue:{kind:'email',ref:source.call.approval.queueRef,epoch:source.call.approval.epoch},action:source.call.approval.action});return {kind:'card',ref};
 });
 core.executeService.mockImplementation(async(handle,operation)=>({kind:'executed',value:await operation(calls.get(handle).call)}));
 core.readApproval.mockImplementation(id=>records.get(id));
 core.presentApproval.mockResolvedValue(undefined);
 client.send.mockResolvedValue({kind:'ok',body:{status:'sent',message_id:'message'}});
 send=new EmailSendService({store,client,installId:'fixture',authorityFor:()=>({claim,proof:{source:'fixture'}})});
 cards=new EmailCards({store,send,host,addTrusted:async()=>({ok:true})});
});
afterEach(()=>db.close());
it('P22/P23 owner No limits bypasses forced outside hold and preserves payload/idempotency',async()=>{
 const result=await submit(true);expect(result).toMatchObject({row:{state:'sent',ownerSent:false}});
 expect(core.presentApproval).not.toHaveBeenCalled();expect(client.send).toHaveBeenCalledTimes(1);
 expect(client.send.mock.calls[0][2]).toMatchObject({text:draft.text,subject:draft.subject,to:draft.to});
 expect(store.trustedEntries('bot')).toHaveLength(1);
});
it('P24 exact upstream hold is approved once on owner RUN without earning trust',async()=>{
 store.removeTrusted('bot',draft.to[0]);
 client.send.mockResolvedValue({kind:'held',body:{held_id:'hold',approval:{id:'upstream'}}});
 client.getApproval.mockResolvedValue({kind:'ok',body:{held:[{id:'hold',state:'held',client_reference:'send',to:draft.to,cc:[],subject:draft.subject,text:draft.text,attachments:[]}]}});
 // Resolve client_reference from the real submitted id.
 client.send.mockImplementation(async(_b:any,_i:any,p:any)=>{client.getApproval.mockResolvedValue({kind:'ok',body:{held:[{id:'hold',state:'held',client_reference:p.client_reference,to:draft.to,cc:[],subject:draft.subject,text:draft.text,attachments:[]}]}});return {kind:'held',body:{held_id:'hold',approval:{id:'upstream'}}};});
 client.approve.mockResolvedValue({kind:'ok',body:{sends:[{held_id:'hold',status:'sent',message_id:'message'}]}});
 expect(await submit()).toMatchObject({row:{state:'sent',ownerSent:false}});
 expect(client.approve).toHaveBeenCalledWith('upstream',['hold']);expect(core.presentApproval).not.toHaveBeenCalled();expect(store.trustedEntries('bot')).toHaveLength(0);
});
it('P24 BASE auto send held upstream registers one usable card; repeated sync stays one',async()=>{
 scenario='base';client.send.mockResolvedValue({kind:'held',body:{held_id:'hold',approval:{id:'upstream'}}});
 const result=await submit();expect(result).toMatchObject({row:{state:'held'}});
 const row=(result as any).row as SendRow;await send.syncApproval(row);await send.syncApproval(row);
 expect(send.pendingApprovals()).toHaveLength(1);expect(records.size).toBe(1);
 const item=send.pendingApprovals()[0];expect(item.call.approval.action.emailSend).toMatchObject({sendId:row.sendId,heldIds:['hold']});
});
it('P25 an owner RUN execution failure stays status text without retry approval',async()=>{
 const result=await submit();const row=(result as any).row as SendRow;
 const failed=store.casSend(row.sendId,row.revision,{state:'approved_unsent',code:'send_failed'},Date.now())!;
 cards.sync(failed);await send.syncApproval(failed);
 expect(core.presentApproval).not.toHaveBeenCalled();expect(host.appendCard).not.toHaveBeenCalled();
});
it('P25 BASE retry is a new registered action with a new epoch after prior settlement',async()=>{
 scenario='base';const result=await submit();const row=(result as any).row as SendRow;
 const failed=store.casSend(row.sendId,row.revision,{state:'approved_unsent',ownerSent:true,code:'send_failed'},Date.now())!;
 await send.syncApproval(failed);expect(send.pendingApprovals()).toHaveLength(1);
 expect(send.pendingApprovals()[0].call.approval.action.emailSend).toMatchObject({state:'approved_unsent'});
});
it('P26 trust offer owner RUN executes acceptance without a card',async()=>{
 const offer={botId:'bot',address:'new@example.test',offeredAt:Date.now(),threadId:'thread'};
 vi.spyOn(store,'pendingTrustOffers').mockReturnValue([offer] as any);
 await cards.syncTrustOffers('bot');expect(core.openRequest).toHaveBeenCalled();expect(core.presentApproval).not.toHaveBeenCalled();
 expect(store.isApproved('bot',offer.address)).toBe(true);
});
it('B5 sync reports failed registration or presentation to the owner',async()=>{
 const result=await submit();
 vi.spyOn(send,'syncApproval').mockRejectedValue(new Error('fixture storage failure'));
 cards.sync((result as any).row);
 await vi.waitFor(()=>expect(host.activity).toHaveBeenCalledWith('thread',expect.stringMatching(/approval.*(failed|could not)/i),false));
});
it('B5 trust offer presentation failure is observable and not counted',async()=>{
 scenario='base';
 vi.spyOn(store,'pendingTrustOffers').mockReturnValue([{botId:'bot',address:'new@example.test',offeredAt:Date.now(),threadId:'thread'}] as any);
 core.presentApprovalSync.mockImplementation(()=>{throw new Error('fixture presentation failure');});
 await expect(cards.syncTrustOffers('bot')).rejects.toThrow('fixture presentation failure');
});
