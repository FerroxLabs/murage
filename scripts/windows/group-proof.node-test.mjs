import test from 'node:test';
import assert from 'node:assert/strict';
import {validateGroupEvidence} from './group-proof.mjs';
const s=kind=>({kind,tasks:[],registrations:[]}),prefix=`MurageCI-${'a'.repeat(32)}-`;
test('Desktop receipt rejects HTTPS dispatch row',()=>assert.throws(()=>validateGroupEvidence('desktop',s('desktop'),s('desktop'),{shellRows:[{row:'https-opened',osDispatch:'fulfilled'}]},prefix)));
test('Desktop refusal rows accepted',()=>validateGroupEvidence('desktop',s('desktop'),s('desktop'),{shellRows:[{row:'bat-refused',refused:true}]},prefix));
test('handoff receipt requires fulfilled HTTPS dispatch',()=>{
 assert.throws(()=>validateGroupEvidence('handoff',s('handoff'),s('handoff'),{},prefix));
 validateGroupEvidence('handoff',s('handoff'),s('handoff'),{shellRows:[{row:'https-opened',osDispatch:'fulfilled',browserMayOutliveRun:true}]},prefix);
});
test('new unprefixed task in a group rejected even if absent at final cleanup',()=>{
 const after=s('desktop');after.tasks=[{id:'\\rogue',name:'rogue',author:'x',actions:'x',definition:'x'}];
 assert.throws(()=>validateGroupEvidence('desktop',s('desktop'),after,{},prefix));
});
