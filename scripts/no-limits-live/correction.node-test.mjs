import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from './scenarios.mjs';
import { judgeScenario } from './counts.mjs';
const ok={complete:true,ended:true,actionProven:true,cards:[],events:[],messages:[]};
const rules=['deny-browser-never','deny-app-denied','deny-app-revoked','deny-script','deny-host-permission-rule'];
test('08:05Z stored permission rules require execution without any blocking surface',()=>{
 for(const id of rules){
  const spec=scenarios.find(s=>s.id===id);
  assert.equal(spec?.expected,'RUN',id);
  const observed={...ok,permissionRuleWitness:{source:id,ruleInstalled:true,actionExecuted:true}};
  assert.equal(judgeScenario(spec,observed).verdict,'PASS',id);
  const guest={...spec,actor:'guest',permissionExplicit:true};
  assert.equal(judgeScenario(guest,{...observed,botPermissionExplicit:true}).verdict,'PASS',id);
  assert.equal(judgeScenario(guest,{...observed,botPermissionExplicit:true,cards:[{why:'deny'}]}).verdict,'FAIL',id);
  for(const patch of [{holds:1},{events:[{type:'turn.held'}]},{messages:[{kind:'options',card:{setup:true}}]},{permissionRuleWitness:undefined},{permissionRuleWitness:{source:id,ruleInstalled:false,actionExecuted:true}},{actionProven:false},{cards:[{why:'deny'}]},{cards:[{why:'question',question:true}]},{refusals:[{source:id}]},
   {decisions:[{decision:'hold'}]},{events:[{type:'request.resolved',behavior:'deny'}]},
   {ownerRefusal:{source:id,actionExecuted:false,actionNotRunProven:true,continued:true,ownerLines:['Denied.']},refusals:[{source:id}]}])
   assert.equal(judgeScenario(spec,{...observed,...patch}).verdict,'FAIL',id+JSON.stringify(patch));
 }
});
test('08:05Z capabilities switched off require no action, no card and one actionable line at every level',()=>{
 for(const level of ['ask','auto','full','unlimited']){
  const spec={id:'browser-disabled',actor:'owner',level,expected:'OFF_WITH_LINE',feature:'browser'};
  const observation={...ok,featureOff:{feature:'browser',actionExecuted:false,actionNotRunProven:true,continued:true,
   ownerLines:['Browser control is off. Turn it on in Settings > Browser.']}};
  assert.equal(judgeScenario(spec,observation).verdict,'PASS');
  for(const patch of [{messages:[{kind:'options',card:{setup:true}}]},{events:[{type:'item.completed',itemType:'tool',tool:'browser',ok:true}]},{actionSink:{executed:true}},{featureOff:undefined},{cards:[{why:'deny'}]},{cards:[{why:'question',question:true}]},
   {featureOff:{...observation.featureOff,actionExecuted:true}},
   {featureOff:{...observation.featureOff,ownerLines:['Browser is off.']}},
   {featureOff:{...observation.featureOff,ownerLines:[]}},
   {featureOff:{...observation.featureOff,ownerLines:['Off.','Enable in Settings.']}},
   {refusals:[{source:'stored-owner-deny'}]}])
   assert.equal(judgeScenario(spec,{...observation,...patch}).verdict,'FAIL',JSON.stringify(patch));
 }
 for(const id of ['deny-host-declined','owner-channel-dm-off'])assert.equal(scenarios.find(s=>s.id===id)?.expected,'OFF_WITH_LINE',id);
});
