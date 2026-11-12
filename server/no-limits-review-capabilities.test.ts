// Fabricated guest bindings and fake service callbacks only.
import {expect,it,vi} from 'vitest';
import {d,fixture,baseCard} from './decision/fixture.ts';
import {ownerMemoryTicket} from './memory/authority.ts';
import {bindHumanThread,observeVerifiedHuman,linkHumanBinding,resolveHumanBinding} from './human-principals.ts';
import {featureOffLine} from './feature-off.ts';

for(const disabled of [false,true])for(const [tool,capability,enabled,off] of [
 ['agent_browser_click','browser',true,false],
 ['host_computer','computer','local','off'],
 ['COMPOSIO_MULTI_EXECUTE_TOOL','composio',true,false],
] as const)it(`AFIX-GUEST explicit No limits preserves ${capability} disabled=${disabled} through execution`,async()=>{
 const f=fixture(),execute=vi.fn(async()=>true);
 try{
  const bot=f.store.createBot({name:'Capability fixture'},{seedMessages:false});
  f.store.patchBot(bot.id,{autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true,[capability]:disabled?off:enabled});
  const binding=observeVerifiedHuman({platform:'slack',authorityId:'FIXTURE',connectionId:'review-guest',userId:'GUEST'});
  linkHumanBinding(ownerMemoryTicket(),{bindingId:binding,expectedRevision:1,as:'person'});
  bindHumanThread(bot.threadId,resolveHumanBinding(binding));
  const projected=f.store.projectBotForTask(bot.id,bot.threadId)!;
  expect(projected[capability]).toBe(disabled?off:enabled);
  d.installDecisionHost({store:f.store,view:()=>({title:'Fixture',subtitle:'Fixture'}),featureOff:(_t,_b,name)=>featureOffLine(name,projected)});
  d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>({generation:'g',botId:bot.id,threadId:bot.threadId,principal:'guest',roomOwnerOnly:false,at:1,initiator:{k:'guest'}}),live:()=>({botId:bot.id,turnId:'turn',providerInstanceId:'p',principal:'guest',owner:false,level:'unlimited'})});
  const claim=d.installClaimVerifier(()=>({threadId:bot.threadId,botId:bot.id,generation:'g'}))('fixture')!;
  const h=d.openRequest({kind:'service',service:'email',claim,call:{tool,input:{value:'fixture'}}});
  expect(d.decide(h,baseCard).kind).toBe(disabled?'refuse':'run');
  await d.executeService(h,execute);await d.executeService(h,execute);
  expect(execute).toHaveBeenCalledTimes(disabled?0:1);expect(d.openApprovals(bot.threadId)).toHaveLength(0);
  const notices=f.store.messagesFor(bot.threadId).filter(message=>message.kind==='text');
  expect(notices).toHaveLength(disabled?1:0);
  if(disabled)expect(notices[0]!.text).toBe(featureOffLine(tool,projected));
 }finally{f.dispose();}
});

it('AFIX-GUEST lower or inherited guest levels retain capability isolation',()=>{
 const f=fixture();
 try{
  const bot=f.store.createBot({name:'Lower guest fixture'},{seedMessages:false});
  const binding=observeVerifiedHuman({platform:'slack',authorityId:'FIXTURE',connectionId:'review-lower-guest',userId:'GUEST'});
  linkHumanBinding(ownerMemoryTicket(),{bindingId:binding,expectedRevision:1,as:'person'});bindHumanThread(bot.threadId,resolveHumanBinding(binding));
  for(const flags of [{autoApprove:true,fullAccess:true,noLimits:false,permissionExplicit:true},{autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:false}]){
   f.store.patchBot(bot.id,{...flags,browser:true,computer:'local',composio:true});
   expect(f.store.projectBotForTask(bot.id,bot.threadId)).toMatchObject({noLimits:false,browser:false,computer:'off',composio:false});
  }
 }finally{f.dispose();}
});
