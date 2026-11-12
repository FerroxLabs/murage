import {expect,it} from 'vitest';
import {noLimitsAppliesTo} from './no-limits-origin.ts';
import {permissionsForOrigin,installPermissionInheritance} from './permission-inheritance.ts';
import {d,fixture,baseCard} from './decision/fixture.ts';
const nl={autoApprove:true,fullAccess:true,noLimits:true};
it('EARLY-ORIGIN guest never inherits or treats legacy Full access as an explicit choice',()=>{
 const restore=installPermissionInheritance(()=>true);
 try{
  for(const flags of [{},nl,{...nl,permissionExplicit:false},{autoApprove:true,fullAccess:true}]){
   expect(noLimitsAppliesTo('guest',flags)).toBe(false);
   expect(permissionsForOrigin(flags,false)).toMatchObject({autoApprove:false,fullAccess:false,noLimits:false});
  }
  expect(noLimitsAppliesTo('guest',{...nl,permissionExplicit:true})).toBe(true);
  expect(noLimitsAppliesTo('guest',{...nl,permissionRev:1})).toBe(false);
  expect(noLimitsAppliesTo(undefined,{...nl,permissionExplicit:true})).toBe(false);
  expect(noLimitsAppliesTo('unproven',{...nl,permissionExplicit:true})).toBe(false);
 }finally{restore();}
});
it('EARLY-ORIGIN a recorded bot No limits selection runs stored denials on a guest turn',async()=>{
 const f=fixture(),bot=f.store.createBot({name:'Explicit bot fixture'},{seedMessages:false});
 f.store.patchBot(bot.id,{...nl,permissionExplicit:true});
 d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>({generation:'g',botId:bot.id,threadId:'t',principal:'guest',roomOwnerOnly:false,at:1,initiator:{k:'guest'}}),live:()=>({botId:bot.id,turnId:'turn',providerInstanceId:'p',principal:'guest',owner:false,level:'unlimited'})});
 try{
  f.deny([{kind:'deny',class:'connected-app',ruleId:'fixture-denial',span:'fixture'}]);
  expect(d.readTurnPolicy({threadId:'t',generation:'g'})).toMatchObject({level:'unlimited',permission:{noLimits:true}});
  const h=f.open('explicit-guest',{command:'printf fixture'});expect(d.decide(h,baseCard).kind).toBe('run');
  await d.deliverRequest(h);expect(f.respond.mock.calls[0][1].behavior).toBe('allow');expect(d.openApprovals('t')).toHaveLength(0);
  expect(d.decide(f.open('wipe',{command:'rm -rf ~'}),baseCard).kind).toBe('card');
 }finally{f.dispose();}
});
