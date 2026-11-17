// Harness/fixture consumer owner: gnl-harness-r10. Native API/Box producers: MAIN.
import {it,expect} from 'vitest';
import {mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {shippedEngineSpecs} from './engine-inventory.mjs';
import {releaseEngines} from './release-engines.mjs';
import {appFixture,appPrompt,appInput} from './saved-app-r10-fixture.mjs';
import {startApiFixture} from './fakes/api-service.mjs';
import {bindOpenAIFixture} from '../../server/testing/bound-openai-fixture.ts';
import {recordEvents} from '../../server/testing/events.ts';
import {bindNativeRowEvidence} from './bindings.mjs';
import {hashInput} from './oracle-class.mjs';
import {scenarios} from './scenarios.mjs';
import {capabilityDisposition} from './capability-rows.mjs';
import {declaredRequests} from './declared-requests.mjs';
const configs=releaseEngines();
// Every non-CLI catalogue engine is driven through its actual protocol. Box's
// declared lack of mounts is asserted separately and remains an OPEN family.
for(const spec of shippedEngineSpecs().filter(s=>!configs[s.id].cli&&s.driver!=='boxAgent'))for(const mode of ['allow','refusal','missing','never-consulted'])it(`saved-app API ${spec.id} ${mode}`,async()=>{
 const f=appFixture();let api,instance,recorder;const deliveries=[],requests=[],decisions=[];
 try{
  api=await startApiFixture();
  const module=await import('../../'+spec.source),driver=module[spec.symbol];
  expect(driver?.driverKind).toBe(spec.driver);
  instance=await driver.create({instanceId:spec.id,displayName:'Fixture',enabled:true,environment:configs[spec.id].environment,config:driver.decodeConfig({...configs[spec.id].config,url:api.url,model:'fake-model'})});
  bindOpenAIFixture(instance);recorder=recordEvents(instance.adapter);
  instance.adapter.onEvent(event=>{if(event.type!=='request.opened')return;requests.push(event);
   expect(f.deliveries()).toHaveLength(0);
   expect(event.requestType).toBe('permission');expect(event.toolCall.input).toEqual(appInput);
   if(mode==='missing'||mode==='never-consulted'){setImmediate(()=>void instance.adapter.interruptTurn(event.threadId));return;}
   const answer={behavior:mode==='allow'?'allow':'deny',message:'Fixture decision'};decisions.push({request:event,answer});
   deliveries.push(instance.adapter.respondToRequest(event.threadId,event.requestId,answer));
  });
  const sent=await instance.adapter.sendTurn({threadId:'fixture-thread',cwd:f.root,model:spec.driver==='grok'?'grok-3-mini':spec.driver==='minimax'?'MiniMax-M2.7':'fake-model',text:appPrompt,integrations:mode==='never-consulted'?{}:{custom:{'gnl-app':f.mount}}});
  await recorder.until(e=>e.type==='turn.completed'&&e.turnId===sent.turnId,15000);await Promise.all(deliveries);
  expect(requests).toHaveLength(mode==='never-consulted'?0:1);expect(decisions).toHaveLength(['missing','never-consulted'].includes(mode)?0:1);
  expect(f.deliveries()).toHaveLength(mode==='allow'?1:0);
  if(mode==='allow')expect(f.deliveries()[0].input).toEqual(appInput);
  const request=requests[0],identity=request?{threadId:request.threadId,generation:request.turnId,requestId:request.requestId}:{};
  const taps=[...(request?[{...identity,type:'request',engine:spec.driver,providerInstanceId:spec.id,tool:request.tool,inputHash:hashInput(request.toolCall.input)}]:[]),...decisions.map(d=>({...identity,type:'answer',state:'accepted',behavior:d.answer.behavior}))];
  const snap={complete:true,errors:[],taps,registrations:request?[identity]:[],records:[],messages:[],queues:[],electron:[],mirrors:[]};
  const scenario={id:'deny-app-denied',expected:'RUN',permissionRule:true,incidental:declaredRequests(appPrompt,{id:spec.id,driver:spec.driver},{permissionRule:true},f.root)};
  if(mode==='never-consulted')expect(recorder.events.some(e=>e.type==='request.opened')).toBe(false);
  const events=recorder.events.map(e=>({...e,provider:spec.driver,providerInstanceId:spec.id}));
  const row=bindNativeRowEvidence(scenario,snap,events,{id:spec.id,driver:spec.driver});expect(row.verdict,JSON.stringify(row.errors)).toBe(mode==='allow'?'PASS':'FAIL');
 }finally{recorder?.stop();await instance?.dispose();await api?.close();f.close();}
},30000);

for(const spec of shippedEngineSpecs().filter(s=>s.driver==='boxAgent'))it(`saved-app catalogue ${spec.id}: provisioned protocol cannot fabricate native completion or a mounted app`,async()=>{
 const f=appFixture(),previous=globalThis.fetch;let instance,recorder;
 try{
  const {boxFixture}=await import('./box-fixture.mjs');const provider=boxFixture(f.root);
  globalThis.fetch=(url,init)=>provider(new URL(String(url)),init);
  const {provisionBox}=await import('../../server/box.ts');const computer=await provisionBox({box:{token:'fixture-key'}},'fixture','Fixture');
  const driver=(await import('../../'+spec.source))[spec.symbol];
  instance=await driver.create({instanceId:spec.id,displayName:'Fixture',enabled:true,environment:configs[spec.id].environment,config:driver.decodeConfig({pollMs:0})});
  recorder=recordEvents(instance.adapter);const cwd=join(f.root,'work');mkdirSync(cwd);
  // A real inert provisioned-computer action proves the driver's current
  // start-only normalization. Provider terminal status is not tool completion.
  const sent=await instance.adapter.sendTurn({threadId:'fixture-box',cwd,text:`Work ONLY inside ${cwd}. Use the requested tools. Run exactly this shell command once: printf fixture > action.done. If denied, stop.`,integrations:{computer:{boxId:computer.boxId,token:'fixture-key'}}});
  await recorder.until(e=>e.type==='turn.completed'&&e.turnId===sent.turnId,15000);
  expect(readFileSync(join(cwd,'action.done'),'utf8')).toBe('fixture');
  expect(recorder.events.filter(e=>e.itemType==='tool'&&e.type==='item.started')).toHaveLength(1);
  expect(recorder.events.filter(e=>e.itemType==='tool'&&e.type==='item.completed')).toHaveLength(0);
  const endpoint=`https://ascii.dev/api/box/v1/boxes/${computer.boxId}`;
  const post=await (await fetch(endpoint+'/prompt',{method:'POST',body:JSON.stringify({prompt:`Work ONLY inside ${cwd}. Use the requested tools. ${appPrompt}`})})).json();
  expect((await (await fetch(endpoint+'/prompts/'+post.promptId)).json()).promptRun.status).toBe('failed');
  expect(f.deliveries()).toHaveLength(0);
  const engine={id:spec.id,driver:spec.driver,capabilityEvidence:{instanceId:spec.id,driverKind:spec.driver,capabilities:{agentsMcp:instance.adapter.capabilities.agentsMcp===true}}};
  console.log('GNL_BOX_OPEN '+JSON.stringify({engine:spec.id,toolStarts:1,toolCompletions:0,appDeliveries:0,unqualifiedRows:scenarios.filter(s=>!capabilityDisposition(engine,s)).map(s=>s.id),capabilityNA:scenarios.filter(s=>capabilityDisposition(engine,s)).map(s=>s.id)}));
 }finally{recorder?.stop();await instance?.dispose();globalThis.fetch=previous;f.close();}
},30000);
