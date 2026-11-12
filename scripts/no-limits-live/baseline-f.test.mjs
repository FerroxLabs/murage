const {test}=process.env.VITEST ? await import('vitest') : await import('node:test');
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifyFakeBaseline} from './baseline-f-proof.mjs';
import {scenarios,engineSpecs} from './historical-baseline.mjs';
import {BASE_SHA} from './baseline.mjs';
test('BLOCK3 repeated fixed requests cannot qualify as the scenario baseline',()=>{
 const report={label:'fake-engine BASE',tree:BASE_SHA,liveBaseline:false,smoke:false,verdict:'PASS',errors:[],rows:engineSpecs.flatMap(e=>scenarios.map(s=>({engine:e.id,id:s.id,actor:s.actor,level:s.level,complete:true,ended:true,errors:[],cardCount:1,questionCount:0,nativeToolCompletions:1,...(s.actor==='owner'?{}:{runId:'fixture'})})))};
 const bytes=JSON.stringify(report),pin=createHash('sha256').update(bytes).digest('hex');
 assert.equal(verifyFakeBaseline(bytes,pin).verdict,'FAIL','names and completion of one fixed request are not scenario witnesses');
});
const {scenarioPlan,planHash}=await import('./baseline-f-plan.mjs');
const {verifyScenarioRow}=await import('./baseline-f-proof.mjs');
function witnessed(spec){const plan={...scenarioPlan(spec),engine:'claude',stage:0},hash=planHash(plan),asks=plan.steps.flatMap((step,index)=>step.kind==='text'?[]:[{type:'request',id:spec.id,hash,index,step}]);return {engine:'claude',id:spec.id,scripts:[{plan,hash,requests:asks,receipts:asks.map(r=>({...r,type:'receipt'}))}],questionCount:plan.steps.filter(s=>s.kind==='question').length,nativeToolCompletions:plan.steps.filter(s=>s.kind==='tool').length,completedTurns:2,...(spec.initialLevel?{switch:{from:spec.initialLevel,to:spec.level,duringTurn:true}}:{}),...(plan.workflow==='queue'?{queue:{queued:true,queueId:'fixture',drained:true}}:{})};}
test('BLOCK3 every scenario has a fixed script and the actual native requests must match it',()=>{
 for(const spec of scenarios){const row=witnessed(spec);assert.deepEqual(verifyScenarioRow(row,spec),[],spec.id);if(row.scripts[0].requests.length){row.scripts[0].requests[0].step={kind:'tool',tool:'Bash',input:{command:'echo fixed'}};assert.ok(verifyScenarioRow(row,spec).some(e=>e.includes('native requested scenario differs')),spec.id);}}
});
test('BLOCK3 two questions require two independently observed question records',()=>{const spec=scenarios.find(s=>s.id==='two-questions'),row=witnessed(spec);row.questionCount=1;assert.ok(verifyScenarioRow(row,spec).some(e=>e.includes('question records differ')));});
test('BLOCK3 switch rows require a level change during the running turn',()=>{for(const spec of scenarios.filter(s=>s.initialLevel)){const row=witnessed(spec);row.switch.to=row.switch.from;assert.ok(verifyScenarioRow(row,spec).some(e=>e.includes('permission switch witness missing')));}});
