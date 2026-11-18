import test from 'node:test';
import assert from 'node:assert/strict';
import {replayPrivateRows} from './private-corpus.mjs';
import {privateCountResult} from './release-legs.mjs';

test('F1 legacy origin hints are counted without serializing private row fields',async()=>{
 const rows=['owner','other','webhook','routine',undefined].map((origin,i)=>({
  id:`synthetic-${i}`,cardClass:{origin},boundedToolInput:'{"command":"printf synthetic"}',
  privateField:'SYNTHETIC_PRIVATE_SENTINEL',
 }));
 const labels=new Map(rows.map(row=>[row.id,{verdict:'none'}]));
 let seen=0;
 const report=await replayPrivateRows({rows,labels,decide:async()=>{seen++;return {kind:'run',actionExecuted:true};}});
 assert.equal(seen,5);assert.equal(report.pass,5);assert.equal(report.nonowner_origin_hints,3);
 assert.equal(report.harness_errors,0);assert.equal(report.verdict,'PASS');
 assert.ok(!JSON.stringify(report).includes('SYNTHETIC_PRIVATE_SENTINEL'));
 assert.ok(!JSON.stringify(report).includes('synthetic-'));
});

test('F1 origin counts survive aggregate admission and cannot contain row data',()=>{
 const counts={verdict:'PASS',rows:140,pass:140,nonwipe_cards:0,refusals:0,skipped:0,harness_errors:0,
  nonowner_origin_hints:106,controls:{rows:3,pass:3}};
 assert.deepEqual(privateCountResult(counts,0),counts);
 for(const value of [-1,141,1.5,'SYNTHETIC_PRIVATE_SENTINEL',{origin:'other'}]){
  const got=privateCountResult({...counts,nonowner_origin_hints:value},0);
  assert.equal(got.verdict,'FAIL');assert.equal(got.harness_errors,1);
  assert.ok(!JSON.stringify(got).includes('SYNTHETIC_PRIVATE_SENTINEL'));
 }
});

test('F1 private replay requires three independently passing wipe controls',()=>{
 const counts={verdict:'PASS',rows:140,pass:140,nonwipe_cards:0,refusals:0,skipped:0,harness_errors:0,controls:{rows:3,pass:3}};
 assert.deepEqual(privateCountResult(counts,0),counts);
 for(const controls of [undefined,{rows:0,pass:0},{rows:2,pass:2},{rows:3,pass:2},{rows:4,pass:4}]){
  const result=privateCountResult({...counts,controls},0);
  assert.equal(result.verdict,'FAIL');assert.equal(result.harness_errors,1);
 }
});
