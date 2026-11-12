import test from 'node:test';
import assert from 'node:assert/strict';
import {trulyRows} from '../no-limits-live/truly-rows.mjs';
import {trulyLiveVerdict as verdict} from './truly-verdict.mjs';
const trulyLiveVerdict=(report,code)=>verdict(report,code,trulyRows);
const proof=()=>({verdict:'PASS',rows:trulyRows.map(row=>({id:row.id,expected:row.expected,expectedCards:row.expectedCards,cards:row.expectedCards,...(row.expected==='OFF_WITH_LINE'?{offLine:'Channel messages are off. Turn them on in Settings.'}:{}),complete:true,ended:true,errors:[],resolutions:[{behavior:row.expected==='RUN'?'allow':'deny'}]}))});
test('the complete No limits HTTP/SSE replay qualifies its fake gate',()=>assert.equal(trulyLiveVerdict(proof(),0),'PASS'));
test('a partial or duplicate replay fails even with a PASS label',()=>{
 const partial=proof();partial.rows.pop();assert.equal(trulyLiveVerdict(partial,0),'FAIL');
 const duplicate=proof();duplicate.rows[0]=duplicate.rows[1];assert.equal(trulyLiveVerdict(duplicate,0),'FAIL');
});
test('a wipe must card and its native request must be denied',()=>{
 const p=proof(),row=p.rows.find(row=>row.expected==='CARD');row.cards=0;assert.equal(trulyLiveVerdict(p,0),'FAIL');
 row.cards=row.expectedCards;row.resolutions[0].behavior='allow';assert.equal(trulyLiveVerdict(p,0),'FAIL');
});
test('a non-wipe must run without a card or an error',()=>{
 const p=proof();p.rows[0].cards=1;assert.equal(trulyLiveVerdict(p,0),'FAIL');
 p.rows[0].cards=0;p.rows[0].errors=['refused'];assert.equal(trulyLiveVerdict(p,0),'FAIL');
});
test('a claimed PASS cannot override a failed runner or changed expectations',()=>{
 assert.equal(trulyLiveVerdict(proof(),1),'FAIL');const p=proof();p.rows[0].expected='CARD';assert.equal(trulyLiveVerdict(p,0),'FAIL');
});

test('08:05 a disabled feature needs its plain settings line and may not run',()=>{
 const p=proof(),row=p.rows.find(row=>row.expected==='OFF_WITH_LINE');
 delete row.offLine;assert.equal(trulyLiveVerdict(p,0),'FAIL');
 row.offLine='Channel messages are off. Turn them on in Settings.';row.resolutions[0].behavior='allow';assert.equal(trulyLiveVerdict(p,0),'FAIL');
});
