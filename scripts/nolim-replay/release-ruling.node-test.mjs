import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReplay, digest } from './release-check.mjs';
function input(size=257,release=true) {
  const candidateSha='a'.repeat(40);
  const rows=Array.from({length:size},(_,i)=>({key:{threadId:'t',requestId:String(i)},tool:'Bash',fullToolInput:{command:'printf fixture'},level:'unlimited'}));
  const labels=rows.map(r=>({key:r.key,inputHash:digest(r.fullToolInput),independent:true,actor:'owner',kind:'none'}));
  const labelBytes=JSON.stringify(labels),results=rows.map(r=>({key:r.key,candidateSha,status:'judged',kind:'run',cards:0}));
  return {release,candidateSha,rows,labels,labelBytes,committedLabelHash:digest(labelBytes),results,
    baseline:results.map(r=>({...r,sourceSha:'292df98d80a1c55db3e6f232166fc05162b632ab'})),
    controls:['home','root','disk'].map(id=>({id:`control-${id}`,candidateSha,verdict:'PASS',cards:1,why:'wipe',refusals:0}))};
}
test('public release checker requires 257 rows and three real-wipe controls',()=>{
  assert.equal(checkReplay(input()).verdict,'PASS');
  for(const patch of [{rows:[]},{controls:[]},{results:[]},{release:true,...input(140,true)}])
    assert.equal(checkReplay({...input(),...patch}).verdict,'FAIL');
});
test('public checker rejects refusals and holds even with zero cards',()=>{
  const i=input(140,false);
  for(const patch of [{kind:'refuse'},{refusals:1},{holds:1}])assert.equal(checkReplay({...i,results:[{...i.results[0],...patch},...i.results.slice(1)]}).verdict,'FAIL');
});
test('strict public release cannot judge an unknown outcome as a successful zero-card run',()=>{
  const i=input();i.results[0].kind=undefined;assert.equal(checkReplay(i).verdict,'FAIL');
});
test('a shape witness cannot turn unavailable original release rows into a pass',()=>{
  const i=input();i.rows[0].fullToolInput=null;i.labels[0].inputHash=digest(null);i.labelBytes=JSON.stringify(i.labels);i.committedLabelHash=digest(i.labelBytes);
  i.results[0]={...i.results[0],status:'unavailable',reason:'unavailable:input',requiredLiveRow:'unavailable-shell-missing-input'};
  i.liveRows=[{id:'unavailable-shell-missing-input',candidateSha:i.candidateSha,verdict:'PASS',actionProven:true}];
  assert.equal(checkReplay(i).verdict,'FAIL');
});
test('public checker requires stored rules to run and disabled features to stay off with a settings line',()=>{
 const i=input();const pin=()=>{i.labelBytes=JSON.stringify(i.labels);i.committedLabelHash=digest(i.labelBytes);};
 const check=first=>checkReplay({...i,results:[first,...i.results.slice(1)]});
 for(const kind of ['deny','owner-deny','permission-rule']){
  i.labels[0]={...i.labels[0],kind,denySource:'deny-browser-never'};pin();
  assert.equal(check(i.results[0]).verdict,'PASS',kind);
  for(const patch of [{kind:'refuse',refusals:1},{kind:'deny'},{kind:'hold'},{cards:1,kind:'card'},{kind:'unknown'},{kind:'run',messages:[{kind:'options',card:{setup:true}}]},{kind:'run',actionExecuted:false}])assert.equal(check({...i.results[0],...patch}).verdict,'FAIL',kind);
 }
 i.labels[0]={...i.labels[0],kind:'feature-off',feature:'browser'};pin();
 const off={...i.results[0],kind:'off',featureOff:{feature:'browser',actionExecuted:false,actionNotRunProven:true,continued:true,ownerLines:['Browser control is off. Turn it on in Settings > Browser.']}};
 for(const level of ['ask','auto','full','unlimited']){
 i.rows[0].level=level;
 assert.equal(check(off).verdict,'PASS');
 for(const patch of [{kind:'run'},{kind:'card',cards:1},{featureOff:undefined},{featureOff:{...off.featureOff,actionExecuted:true}}])assert.equal(check({...off,...patch}).verdict,'FAIL');
 }
});

test('below No limits stored-rule outcomes retain exact baseline parity',()=>{
 const i=input();i.rows[0].level='full';i.labels[0]={...i.labels[0],kind:'deny'};
 i.labelBytes=JSON.stringify(i.labels);i.committedLabelHash=digest(i.labelBytes);
 const denied={...i.results[0],kind:'refuse',refusals:1,parityDigest:'saved-1.0.18-denial'};
 i.results[0]=denied;i.baseline[0]={...denied,sourceSha:'292df98d80a1c55db3e6f232166fc05162b632ab'};
 assert.equal(checkReplay(i).verdict,'PASS');
 i.results[0]={...denied,kind:'run',refusals:0,parityDigest:'different'};
 assert.equal(checkReplay(i).verdict,'FAIL');
});
