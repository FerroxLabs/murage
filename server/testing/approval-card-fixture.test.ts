import { expect, it } from 'vitest';
import { Store } from '../store.ts';
import { ApprovalFixtureStore } from './approval-card-fixture.ts';
import { database } from '../database.ts';
import { lookupRecord } from '../decision/records.ts';
const input = () => ({role:'bot',kind:'options',card:{title:'Ask fixture',options:['Allow','Deny'],requestId:'fixture-request',tool:'Bash'}} as const);
it('the raw writer still refuses an open card with no approval',()=>{
 const store = new Store(); const bot=store.createBot();
 expect(()=>store.appendMessage(bot.threadId,input() as never)).toThrow('card-without-approval');
});
it('scale fixture cards retain a real Ask approval and can settle without changing the action',()=>{
 const store=new ApprovalFixtureStore(); const bot=store.createBot();
 const message=store.appendMessage(bot.threadId,input() as never);
 expect(lookupRecord(database(),bot.threadId,message.id)).toMatchObject({level:'ask',why:'base',state:'open',action_hash:message.card!.actionHash});
 const settled=store.patchMessage(bot.threadId,message.id,{card:{...input().card,answered:'allow'} as never});
 expect(settled?.card).toMatchObject({approvalId:message.card!.approvalId,actionHash:message.card!.actionHash,answered:'allow'});
 expect(lookupRecord(database(),bot.threadId,message.id)?.state).toBe('answered');
});
it('the fixture preserves the product guard against changing an admitted action',()=>{
 const store=new ApprovalFixtureStore(); const bot=store.createBot(); const message=store.appendMessage(bot.threadId,input() as never);
 expect(()=>store.patchMessage(bot.threadId,message.id,{card:{...input().card,requestId:'different'} as never})).toThrow('card-action-changed');
});
