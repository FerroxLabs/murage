import { describe, it, expect } from 'vitest';
import { reviewBotAccess } from '../bot-access.ts';
import { accessRoleBinding } from '../bot-access-role.ts';
import { connectedAppAccessSchema } from '../../shared/bot-access.ts';

function fixture(allowWrites = false) {
  const bot: any = { id: 'bot', threadId: 'thread', composio: true };
  const manager: any = { id: 'manager', threadId: 'manager-thread', chiefOfStaff: true };
  const grant = {toolkit:'gmail', accountId:'account', tools:['GMAIL_FETCH_EMAILS','GMAIL_SEND_EMAIL']};
  bot.connectedAppAccess = {revision:1,roleBinding:accessRoleBinding(bot),mode:'restricted',allowWrites,grants:[grant],requests:[{id:'req',requestedBy:'manager',requesterBinding:accessRoleBinding(manager),targetBinding:accessRoleBinding(bot),createdAt:100,expiresAt:1000,grants:[grant],allowWrites}]};
  const store: any = {bot:(id:string)=>id==='bot'?bot:manager,patchBot:(_id:string,patch:any)=>Object.assign(bot,patch)};
  return {bot,store,grant,accounts:[{toolkit:'gmail',accountId:'account'}]};
}
describe('R5 E5/E6; A6a producer persistence',()=>{
  it('M27 persists an explicit denial including read-only tools',()=>{
    const f=fixture(); reviewBotAccess(f.store,'bot',{action:'deny',revision:1,requestId:'req'},f.accounts,200);
    expect(f.bot.connectedAppAccess.denials).toEqual(expect.arrayContaining([expect.objectContaining({tools:['GMAIL_FETCH_EMAILS'],ops:['read'],accountId:'account',source:'request-denied'})]));
    expect(f.bot.connectedAppAccess.requests).toHaveLength(0);
  });
  it('M58 write downgrade keeps read grants and denies write operations',()=>{
    const f=fixture(true); reviewBotAccess(f.store,'bot',{action:'configure',revision:1,mode:'restricted',allowWrites:false,grants:[f.grant]},f.accounts,200);
    expect(f.bot.connectedAppAccess.denials).toEqual([expect.objectContaining({tools:['GMAIL_SEND_EMAIL'],ops:['write'],source:'grant-revoked'})]);
  });
  it('removed accounts and tools are denied; a later matching grant clears only that denial',()=>{
    const f=fixture(true); reviewBotAccess(f.store,'bot',{action:'configure',revision:1,mode:'restricted',allowWrites:true,grants:[]},f.accounts,200);
    expect(f.bot.connectedAppAccess.denials).toHaveLength(2);
    reviewBotAccess(f.store,'bot',{action:'configure',revision:2,mode:'restricted',allowWrites:false,grants:[{...f.grant,tools:['GMAIL_FETCH_EMAILS']}]},f.accounts,300);
    expect(f.bot.connectedAppAccess.denials).toHaveLength(1);
    expect(f.bot.connectedAppAccess.denials[0].tools).toEqual(['GMAIL_SEND_EMAIL']);
  });
  it('legacy persisted policy parses with an empty bounded denial list',()=>{
    const f=fixture(); expect(connectedAppAccessSchema.parse(f.bot.connectedAppAccess).denials).toEqual([]);
  });
});
