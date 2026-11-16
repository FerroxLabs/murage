import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {scenarioPlan,planHash} from './baseline-f-plan.mjs';
import {BASE_SHA} from './baseline.mjs';
import {scenarios,engineSpecs} from './historical-baseline.mjs';
export function verifyScenarioRow(row,spec){
 const errors=[],fail=why=>errors.push(`fake BASE ${spec.id}: ${why}`),expected=scenarioPlan(spec);
 const scripts=row.scripts;
 if(!Array.isArray(scripts)||!scripts.length){fail('native scenario scripts missing');return errors;}
 const steps=[];
 for(const script of scripts){
  if(script.hash!==planHash(script.plan))fail('native script hash mismatch');
  if(script.plan.id!==spec.id||script.plan.engine!==row.engine)fail('native script scenario mismatch');
  steps.push(...script.plan.steps);
  const asks=script.plan.steps.flatMap((step,index)=>step.kind==='text'?[]:[{index,step}]);
  const requests=script.requests??[],receipts=script.receipts??[];
  if(JSON.stringify(requests.map(r=>({index:r.index,step:r.step})))!==JSON.stringify(asks))fail('native requested scenario differs');
  if(JSON.stringify(receipts.map(r=>r.index))!==JSON.stringify(asks.map(r=>r.index)))fail('native scenario receipts missing');
  if([...requests,...receipts].some(r=>r.hash!==script.hash))fail('native witness belongs to another script');
 }
 if(JSON.stringify(steps)!==JSON.stringify(expected.steps))fail('scenario steps differ');
 if(row.questionCount!==expected.steps.filter(s=>s.kind==='question').length)fail('question records differ');
 if(row.nativeToolCompletions<expected.steps.filter(s=>s.kind==='tool').length)fail('native tool completions missing');
 if(spec.initialLevel&&(row.switch?.from!==spec.initialLevel||row.switch?.to!==spec.level||row.switch?.duringTurn!==true))fail('permission switch witness missing');
 if(expected.workflow==='two-turn'&&row.completedTurns<2)fail('second turn missing');
 if(expected.workflow==='queue'&&(!row.queue?.queued||!row.queue?.queueId||!row.queue?.drained||row.completedTurns<2))fail('queue drain witness missing');
 return errors;
}
export function verifyFakeBaseline(bytes,pin){
 const errors=[];if(createHash('sha256').update(bytes).digest('hex')!==pin.trim())errors.push('fake BASE hash mismatch');
 let baseline;try{baseline=JSON.parse(bytes);}catch{return {verdict:'FAIL',errors:['invalid fake BASE JSON']};}
 if(baseline.label!=='fake-engine BASE'||baseline.liveBaseline!==false||baseline.smoke!==false||baseline.tree!==BASE_SHA||baseline.verdict!=='PASS')errors.push('fake BASE identity mismatch');
 if(baseline.errors?.length)errors.push('fake BASE has errors');
 const expected=new Set(engineSpecs.flatMap(e=>scenarios.map(s=>`${e.id}:${s.id}`))),seen=new Set();
 for(const row of baseline.rows??[]){const key=`${row.engine}:${row.id}`;if(!expected.has(key)||seen.has(key))errors.push(`unexpected or duplicate fake BASE row: ${key}`);seen.add(key);
  const spec=scenarios.find(s=>s.id===row.id);if(row.actor!==spec?.actor||row.level!==spec?.level||!row.complete||!row.ended||row.errors?.length)errors.push(`incomplete fake BASE row: ${key}`);
  if(spec)errors.push(...verifyScenarioRow(row,spec));
  if(row.actor!=='owner'&&!row.runId)errors.push(`fake BASE trigger witness missing: ${key}`);
 }
 if(seen.size!==expected.size)errors.push('fake BASE matrix incomplete');
 return {verdict:errors.length?'FAIL':'PASS',label:baseline.label,tree:baseline.tree,rows:seen.size,hash:createHash('sha256').update(bytes).digest('hex'),errors};
}
export function compareFakeBaseline(bytes,pin,rows){
 const proof=verifyFakeBaseline(bytes,pin);if(proof.verdict!=='PASS')return proof;
 const baseline=JSON.parse(bytes),errors=[];
 const projection=r=>JSON.stringify({cardCount:r.cardCount,questionCount:r.questionCount,nativeToolCompletions:r.nativeToolCompletions,complete:r.complete,ended:r.ended});
 for(const row of rows.filter(r=>r.actor==='non-owner'||r.level!=='unlimited')){
  const matches=baseline.rows.filter(b=>b.engine===row.engine&&b.id===row.id);
  if(matches.length!==1||projection(matches[0])!==projection(row))errors.push(`fake BASE parity mismatch: ${row.engine}/${row.id}`);
 }
 return {verdict:errors.length?'FAIL':'PASS',errors};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const proof=verifyFakeBaseline(readFileSync(process.argv[2]),readFileSync(new URL('./baseline-f.sha256',import.meta.url),'utf8'));console.log(JSON.stringify(proof,null,2));if(proof.verdict!=='PASS')process.exitCode=1;}
