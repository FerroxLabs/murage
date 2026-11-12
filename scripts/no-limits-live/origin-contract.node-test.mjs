import {test} from 'node:test';
import assert from 'node:assert/strict';
import {permissionsForOrigin,installPermissionInheritance} from '../../server/permission-inheritance.ts';
import {noLimitsAppliesTo} from '../../server/no-limits-origin.ts';
test('explicit guest settings apply without upgrading legacy flags or inheriting the owner level',()=>{
 const restore=installPermissionInheritance(()=>true);
 try {
  for(const origin of ['guest','other-human','other']){
   const explicit={autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true};
   assert.equal(noLimitsAppliesTo(origin,explicit),true);
   assert.deepEqual(permissionsForOrigin(explicit,false,true),explicit);
   for(const legacy of [{autoApprove:true,fullAccess:true,noLimits:true},{...explicit,permissionExplicit:false}]){
    assert.equal(noLimitsAppliesTo(origin,legacy),false);
    assert.deepEqual(permissionsForOrigin(legacy,false,true),{...legacy,permissionExplicit:true,autoApprove:false,fullAccess:false,noLimits:false});
   }
   assert.equal(noLimitsAppliesTo(origin,{autoApprove:false,permissionExplicit:true}),false);
  }
  for(const origin of [undefined,'unproven'])assert.equal(noLimitsAppliesTo(origin,{autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true}),false);
  assert.equal(noLimitsAppliesTo('owner-channel',{autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true,fullAccessChannelMessages:false}),false);
 }finally{restore();}
});

// Onboarding occurred before the ingress; a new setup card during the action
// must still fail the same OFF_WITH_LINE oracle.
test('channel-off observes only messages introduced by its ingress and counts every new card',async()=>{
 const {ingressMessages}=await import('./origin-fixtures.mjs');
 const {judgeScenario}=await import('./counts.mjs');
 const before={id:'before',kind:'options',card:{setup:true}},during={id:'during',kind:'options',card:{setup:true}};
 const priorIds=new Set([before.id]),spec={id:'channel-off',actor:'owner',level:'unlimited',expected:'OFF_WITH_LINE',feature:'channel-messages'};
 const obs={complete:true,ended:true,actionProven:true,cards:[],featureOff:{feature:'channel-messages',actionExecuted:false,actionNotRunProven:true,continued:true,ownerLines:['Channel messages are off. Turn them on in Settings.']}};
 assert.equal(judgeScenario(spec,{...obs,messages:ingressMessages([before],priorIds)}).verdict,'PASS');
 assert.equal(judgeScenario(spec,{...obs,messages:ingressMessages([before,during],priorIds)}).verdict,'FAIL');
});
