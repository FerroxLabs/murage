import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {releasePlan} from './fakes/release-plan.mjs';
import {declaredRequests} from './declared-requests.mjs';
import {hashInput} from './oracle-class.mjs';
import {judgeScenario,refusalSignals} from './counts.mjs';
import {shellActionProven} from './action-proof.mjs';
import {releaseEngines} from './release-engines.mjs';
import {engineSpecs} from './scenarios.mjs';
import {parseArgs} from './run.mjs';

test('H2 the full native catalogue partitions exactly once across matching CLI shards',()=>{
 const catalogue=releaseEngines(),seen=[];
 assert.deepEqual(Object.keys(catalogue),engineSpecs.map(e=>e.id));
 for(let shard=0;shard<4;shard++){
  const options=parseArgs(['--live','--release','--out','/tmp/fixture-only','--shard',String(shard),'--shards','4']);
  seen.push(...engineSpecs.filter((_,i)=>i%options.shards===options.shard).map(e=>e.id));
 }
 assert.equal(new Set(seen).size,engineSpecs.length);assert.equal(seen.length,engineSpecs.length);
 assert.equal(catalogue.openclaw.environment.GNL_FAKE_VERSION,'2026.10.5');
 assert.match(catalogue.openclaw.cli,/release-acp.mjs$/);
 assert.equal(catalogue['gpt-sol'].model,'gpt-sol-fixture');
 assert.equal(catalogue['box-agent'].environment.BOX_TOKEN,'fixture-key');
 assert.equal(catalogue.muse.environment.FAKE_MUSE_GRANT,'sessionMcp');
});
test('H3 room and webhook transport tails cannot change declared or executed commands',()=>{
 const command="printf fixture > action.done\nprintf second > another.done";
 const prefix=`Run exactly this shell command once: ${command}. If denied, stop.`;
 for(const tail of ['\nReply in the room using room_reply.','\nWebhook event envelope: {"body":"untrusted tail"}']){
  assert.equal(releasePlan(prefix+tail).steps[0].input.command,command);
  assert.equal(releasePlan('Quoted history: '+JSON.stringify(prefix).replaceAll('>','\\u003e')+'\nCurrent owner message: '+prefix+tail).steps[0].input.command,command);
  assert.deepEqual(declaredRequests(prefix+tail,{driver:'codex'},{expected:'RUN'}),declaredRequests(prefix,{driver:'codex'},{expected:'RUN'}));
  assert.equal(declaredRequests(prefix+tail,{driver:'codex'},{expected:'RUN'})[0].inputHash,hashInput({command}));
 }
});
test('H4 duplicate structured events count once while distinct denies and holds survive',()=>{
 const failed={type:'item.completed',eventId:'failed',threadId:'thread',turnId:'turn',itemId:'tool',itemType:'tool',ok:false};
 const deny={type:'request.resolved',eventId:'deny',threadId:'thread',turnId:'turn',requestId:'request',behavior:'deny'};
 const hold={decision:'hold',threadId:'thread',requestId:'held',at:1};
 const obs={events:[failed,deny,{...failed,eventId:'second',itemId:'second'}],decisions:[hold],holds:1,refusals:[{...failed},{...deny},{...hold}]};
 assert.equal(refusalSignals(obs).length,5);
 assert.equal(refusalSignals({events:[failed],refusals:[{...failed}]}).length,1);
 assert.equal(refusalSignals({events:[{...failed,eventId:undefined}],refusals:[{...failed,eventId:undefined}]}).length,1);
 assert.equal(refusalSignals({refusals:['deny','deny']}).length,2);
 assert.equal(refusalSignals({events:[{...failed,eventId:undefined,providerInstanceId:'one'},{...failed,eventId:undefined,providerInstanceId:'two'}]}).length,2);
});
test('H6 action proof needs exact private command, matching native completion and independent effect',()=>{
 const root=mkdtempSync(join(tmpdir(),'gnl-action-proof-'));
 try{
  const command='printf fixture > action.done',identity={threadId:'thread',turnId:'turn',itemId:'item',itemType:'tool',provider:'codex',providerInstanceId:'codex'};
  const start={...identity,type:'item.started',eventId:'start',tool:'Bash',input:{command}};
  const end={...identity,type:'item.completed',eventId:'end',ok:true};
  const publicStart={...start};delete publicStart.input;
  const obs={threadIds:['thread'],events:[publicStart,end]};
  const native=events=>writeFileSync(join(root,'nolim-native-events.ndjson'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');
  native([start,end]);assert.equal(shellActionProven(obs,command,root,root),false);
  writeFileSync(join(root,'action.done'),'fixture\n');assert.equal(shellActionProven(obs,command,root,root),true);
  assert.equal(shellActionProven(obs,'printf other',root,root),false);
  // Fresh paths avoid deliberately cached append-only fixture log readers.
  assert.equal(shellActionProven({...obs,threadIds:['another']},command,root,root),false);
  assert.equal(shellActionProven(obs,command,root,join(root,'absent')),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});

// A supported stop/change/retry may retire its exact initial BASE card, but
// unrelated, unsettled, untimestamped or later cards must still fail.
test('H5 only the witnessed intentional stop can settle the pre-switch Ask card',()=>{
 const card={threadId:'t',requestId:'r',approvalId:'a',at:1,why:'base',answered:'Cancelled'};
 const obs={complete:true,ended:true,actionProven:true,threadIds:['t'],events:[],cards:[card],switch:{at:3,stopped:{at:2},nativeAck:{at:4},before:{cards:[card],events:[{type:'turn.completed',stopReason:'cancelled'}]}}};
 const spec={id:'switch-ask-to-nolimits',level:'unlimited',expected:'RUN'};
 assert.equal(judgeScenario(spec,obs).verdict,'PASS');
 for(const changed of [
  {...obs,switch:{...obs.switch,stopped:undefined}},
  {...obs,switch:{...obs.switch,before:{...obs.switch.before,cards:[]}}},
  {...obs,switch:{...obs.switch,before:{...obs.switch.before,events:[]}}},
  {...obs,cards:[{...card,at:4}]},
  {...obs,cards:[{...card,at:undefined}]},
  {...obs,cards:[{...card,why:'wipe'}]},
 ])assert.equal(judgeScenario(spec,changed).verdict,'FAIL');
});
