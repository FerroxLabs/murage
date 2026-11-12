import {test} from 'node:test';
import assert from 'node:assert/strict';
import {availability} from './replay-decide.mjs';
import {replayRuling,wipeControls} from './ruling.mjs';
const row={tool:'Bash',fullToolInput:{command:'printf fixture'},label:{independent:true,kind:'none',actor:'owner'}};
const rows=()=>Array.from({length:257},(_,i)=>({...row,id:`logged-${i}`,source:'redacted-real-log'}));
const card={kind:'card',why:'wipe',cards:1,presentations:[{approvalId:'approval',messageId:'message',requestId:'request',why:'wipe'}]};
test('a source tag without its denial evidence is UNPROVEN',async()=>{
 for(const source of ['host-computer-declined','browser-never','app-access-denied'])for(const patch of [{cardClass:{denySource:source}},{card:{cardClass:{refusalSource:source}}},{label:{...row.label,source}}]){
  const r={...row,...patch};assert.equal(availability(r).status,'unavailable');
  const corpus=rows();corpus[0]={...corpus[0],...r};let called=false;
  const result=await replayRuling({rows:corpus,controls:wipeControls(),decide:r=>{if(r.id==='logged-0')called=true;return r.id.startsWith('control-')?card:{kind:'run',cards:0};}});
  assert.equal(result.verdict,'FAIL');assert.equal(result.results[0].status,'UNPROVEN');assert.equal(called,false);
 }
});
test('empty or malformed denial snapshots do not restore the missing condition',()=>{
 for(const denySnapshot of [{},{evidence:[]},{evidence:[{}]}])assert.equal(availability({...row,cardClass:{denySource:'browser-never'},denySnapshot}).status,'unavailable');
});
test('wipe control requires an actual matched durable presentation, never autoOnly',async()=>{
 for(const outcome of [{kind:'card',why:'wipe',autoOnly:true},{kind:'card',why:'wipe',cards:1},{...card,presentations:[]}]){
  const result=await replayRuling({rows:rows(),controls:wipeControls(),decide:r=>r.id.startsWith('control-')?outcome:{kind:'run',cards:0}});
  assert.equal(result.verdict,'FAIL');assert.equal(result.controls.pass,0);
 }
 assert.equal((await replayRuling({rows:rows(),controls:wipeControls(),decide:r=>r.id.startsWith('control-')?card:{kind:'run',cards:0}})).verdict,'PASS');
});
