// Harness/qualification owner: gnl-harness-r10. Native protocol/product owner: MAIN.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {releaseEngines} from './release-engines.mjs';
import {shippedEngineSpecs} from './engine-inventory.mjs';
import {bindNativeRowEvidence} from './bindings.mjs';
import {hashInput} from './oracle-class.mjs';
import {declaredRequests} from './declared-requests.mjs';
import {cliControl,appInput,appPrompt} from './saved-app-r10-fixture.mjs';
const configs=releaseEngines();
// Generated from the same catalogue as the release fixture; no engine list.
for(const spec of shippedEngineSpecs().filter(s=>configs[s.id].cli))for(const mode of ['allow','refusal','missing','never-consulted'])test(`saved-app catalogue ${spec.id} ${mode}`,async()=>{
 const result=await cliControl(spec,configs[spec.id],mode);
 try{
  assert.equal(result.deliveries().length,mode==='allow'?1:0,'exact delivery count');
  assert.equal(result.asks.length,['missing','never-consulted'].includes(mode)?0:1,'saved-app must traverse its native decision exactly once');
  assert.ok(result.asks.every(a=>a.before===false),'no effect before permission');
  if(mode==='allow')assert.deepEqual(result.deliveries()[0].input,appInput);
  // Assert a failed native operation, not a successful turn with missing delivery.
  const frames=result.frames;
  const completed=spec.driver==='claudeAgent'?frames.flatMap(f=>f.message?.content??[]).find(f=>f.type==='tool_result'):
   spec.driver==='codex'?frames.find(f=>f.method==='item/completed'&&f.params.item.type==='mcpToolCall')?.params.item:
   spec.driver==='piAgent'?frames.find(f=>f.type==='tool_execution_end'):
   spec.driver==='museCode'?frames.find(f=>f.method==='item/completed'&&f.params.item.kind==='toolCall')?.params.item:
   spec.driver==='antigravityAgent'?frames.find(f=>f.step_update?.state!=='ACTIVE'&&f.step_update?.step_type==='tool')?.step_update:
   frames.find(f=>f.params?.update?.sessionUpdate==='tool_call_update')?.params.update;
  // Hermes intentionally checks before publishing a refused operation.
  if(!completed&&spec.driver==='hermesAgent'&&mode!=='allow'){assert.equal(result.deliveries().length,0);}
  if(spec.driver!=='hermesAgent'||mode==='allow')assert.ok(completed,'native operation outcome absent');
  const ok=spec.driver==='claudeAgent'?!completed.is_error:spec.driver==='piAgent'?!completed.isError:spec.driver==='antigravityAgent'?completed.state==='DONE':completed?.status==='completed';
  assert.equal(ok,mode==='allow','native completion must reflect delivery');
  for(const ask of result.asks){
   const frame=ask.frame;let input,tool;
   if(spec.driver==='claudeAgent'){tool=ask.params.arguments.tool_name;input=ask.params.arguments.input;}
   else if(spec.driver==='antigravityAgent'){assert.equal(ask.params.toolCall.name,'call_mcp_tool');tool=ask.params.toolCall.args.ToolName;input=ask.params.toolCall.args.Arguments;}
   else if(spec.driver==='piAgent'){const call=JSON.parse(frame.prefill);assert.equal(call.mount,'gnl-app');tool=call.mcpTool;input=call.input;}
   else if(spec.driver==='museCode'){tool=frame.params.toolName;input=JSON.parse(frame.params.rawArgs);}
   else if(spec.driver==='codex'){tool=frame.params._meta.tool_name;input=frame.params._meta.tool_params;}
   else{tool=frame.params.toolCall.title;input=frame.params.toolCall.rawInput;}
   assert.equal(tool,'GMAIL_SEND_EMAIL');assert.deepEqual(input,appInput);
  }
  const engine={id:spec.id,driver:spec.driver},threadId='fixture-thread',generation='fixture-turn',requestId='fixture-request';
  const identity={threadId,generation,requestId};
  const request={...identity,type:'request',engine:spec.driver,providerInstanceId:spec.id,tool:'GMAIL_SEND_EMAIL',inputHash:hashInput(appInput)};
  const taps=result.asks.flatMap(()=>[request,{...identity,type:'answer',state:'accepted',behavior:mode==='allow'?'allow':'deny'}]);
  const snapshot={complete:true,errors:[],taps,registrations:result.asks.map(()=>identity),records:[],messages:[],queues:[],electron:[],mirrors:[]};
  const start={type:'item.started',itemType:'tool',origin:'engine',threadId,turnId:generation,itemId:'fixture-item',eventId:'start',provider:spec.driver,providerInstanceId:spec.id,generation,tool:'GMAIL_SEND_EMAIL',input:appInput};
  const events=[start,...(completed?[{...start,type:'item.completed',eventId:'end',ok}]:[]),...result.asks.map(()=>({type:'request.opened',requestType:'permission',threadId,turnId:generation,requestId}))];
  const scenario={id:'deny-app-denied',expected:'RUN',permissionRule:true,incidental:declaredRequests(appPrompt,engine,{permissionRule:true},result.root)};
  const row=bindNativeRowEvidence(scenario,snapshot,events,engine);
  assert.equal(row.verdict,mode==='allow'?'PASS':'FAIL',JSON.stringify(row.errors));
 }finally{result.close();}
});

test('saved-app binding rejects successful operation evidence without the native permission request',async()=>{
 const {bindNativeRowEvidence}=await import('./bindings.mjs');
 const {hashInput}=await import('./oracle-class.mjs');
 for(const spec of shippedEngineSpecs())for(const row of ['deny-app-denied','deny-app-revoked']){
  const engine={id:spec.id,driver:spec.driver},generation='fixture-turn',threadId='fixture-thread',requestId='fixture-request';
  const start={type:'item.started',itemType:'tool',origin:'engine',threadId,turnId:generation,itemId:'fixture-item',eventId:'start',provider:spec.driver,providerInstanceId:spec.id,generation,tool:'GMAIL_SEND_EMAIL',input:appInput};
  const events=[start,{...start,type:'item.completed',eventId:'end',ok:true}];
  const request={type:'request',threadId,generation,requestId,engine:spec.driver,providerInstanceId:spec.id,tool:'GMAIL_SEND_EMAIL',inputHash:hashInput(appInput)};
  const snapshot=()=>({complete:true,errors:[],taps:[],registrations:[],records:[],messages:[],queues:[],electron:[],mirrors:[]});
  const scenario={id:row,expected:'RUN',permissionRule:true,incidental:[{engine:spec.driver,tool:'GMAIL_SEND_EMAIL',inputHash:hashInput(appInput),class:'permission-rule'}]};
  const decision={type:'request.opened',requestType:'permission',threadId,turnId:generation,requestId};
  for(const wrong of ['absent','service-item','wrong-tool','wrong-input','wrong-engine','wrong-instance','wrong-turn','question']){
   const snap=snapshot();
   if(wrong!=='absent')snap.taps=[{...request,...(wrong==='service-item'?{nativeItem:true}:wrong==='wrong-tool'?{tool:'Write'}:wrong==='wrong-input'?{inputHash:hashInput({})}:wrong==='wrong-engine'?{engine:'foreign'}:wrong==='wrong-instance'?{providerInstanceId:'foreign'}:{})}];
   const result=bindNativeRowEvidence(scenario,snap,[...events,...(wrong==='absent'?[]:[{...decision,...(wrong==='wrong-turn'?{turnId:'other'}:wrong==='question'?{requestType:'question'}:{})}])],engine);
   assert.equal(result.native_operations,1,'the negative retains successful operation evidence');
   assert.equal(result.verdict,'FAIL',`${spec.id} ${row} ${wrong}`);
   assert.ok(result.errors.includes('Saved-app native permission request absent'));
  }
  const snap=snapshot();snap.taps=[request,{...request,type:'answer',state:'accepted',behavior:'allow'}];snap.registrations=[{generation,requestId}];
  assert.equal(bindNativeRowEvidence(scenario,snap,[...events,decision],engine).verdict,'PASS',`${spec.id} allow control`);
 }
});

for(const spec of shippedEngineSpecs().filter(s=>s.driver==='antigravityAgent'))for(const mode of ['missing-hook','disabled-hook','unmatched-hook','empty-response'])test(`saved-app explicit native allow ${spec.id} ${mode}`,async()=>{
 const result=await cliControl(spec,configs[spec.id],mode);
 try{
  assert.equal(result.asks.length,mode==='empty-response'?1:0,'observed native hook requests');
  assert.equal(result.deliveries().length,0,'an explicit native allow is required before delivery');
  assert.ok(result.frames.some(f=>f.event==='result'&&f.result?.status==='ERROR'),'missing decision must fail honestly');
 }finally{result.close();}
});

test('saved-app binding joins permission to the successful operation thread and turn',()=>{
 for(const spec of shippedEngineSpecs())for(const id of ['deny-app-denied','deny-app-revoked'])for(const mismatch of ['thread','turn']){
  const engine={id:spec.id,driver:spec.driver},inputHash=hashInput(appInput);
  const identity={threadId:'fixture-thread',generation:'fixture-turn',requestId:'fixture-request'};
  const request={...identity,type:'request',engine:spec.driver,providerInstanceId:spec.id,tool:'GMAIL_SEND_EMAIL',inputHash};
  const taps=[request,{...identity,type:'answer',state:'accepted',behavior:'allow'}];
  const snapshot={complete:true,errors:[],taps,registrations:[identity],records:[],messages:[],queues:[],electron:[],mirrors:[]};
  const start={type:'item.started',itemType:'tool',origin:'engine',threadId:mismatch==='thread'?'other-thread':identity.threadId,turnId:mismatch==='turn'?'other-turn':identity.generation,generation:mismatch==='turn'?'other-turn':identity.generation,itemId:'fixture-item',eventId:'start',provider:spec.driver,providerInstanceId:spec.id,tool:'GMAIL_SEND_EMAIL',input:appInput};
  const events=[start,{...start,type:'item.completed',eventId:'end',ok:true},{type:'request.opened',requestType:'permission',threadId:identity.threadId,turnId:identity.generation,requestId:identity.requestId}];
  const row=bindNativeRowEvidence({id,expected:'RUN',permissionRule:true,incidental:[{engine:spec.driver,tool:'GMAIL_SEND_EMAIL',inputHash,class:'permission-rule'}]},snapshot,events,engine);
  assert.equal(row.native_operations,1,'retain the successful operation');
  assert.equal(row.verdict,'FAIL',`${spec.id} ${id} cross-${mismatch}`);
  assert.ok(row.errors.includes('Saved-app native permission request absent'));
 }
});
