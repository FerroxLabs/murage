// Regressions derived from rehearsal 8/9 cause manifests. Neutral synthetic
// identities preserve the projection mismatch without retaining private logs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {removeTempDirSync} from '../../server/testing/cleanup.ts';
import {readNativeEvents,completedOperations,nativeOperationEvidence} from './native-operation-evidence.mjs';
import {hashInput} from './oracle-class.mjs';
import {createMountedTools} from './mounted-tools.mjs';
import {installDedicatedBindings} from './dedicated-bindings.mjs';
import {ProductClient} from './run.mjs';
import {spawn} from 'node:child_process';
const temp=fn=>{const root=mkdtempSync(join(tmpdir(),'nolim-live-regression-'));return Promise.resolve().then(()=>fn(root)).finally(()=>removeTempDirSync(root));};
const start={type:'item.started',itemType:'tool',origin:'engine',threadId:'fixture-thread',turnId:'native-turn',itemId:'base-0',eventId:'native-start',provider:'codex',providerInstanceId:'codex',generation:'fixture-generation',tool:'GMAIL_SEND_EMAIL',input:{accountId:'fixture-account',to:'fixture@example.test',body:'inert fixture'}};
const end={...start,type:'item.completed',eventId:'native-end',ok:true};
const projected={...start,turnId:'public-turn',itemId:'2-0',eventId:'public-start',provider:undefined,input:undefined};
test('P2 execution rail is authoritative despite projected ids and absent public args',()=>temp(root=>{
 writeFileSync(join(root,'nolim-native-events.ndjson'),[start,end].map(JSON.stringify).join('\n')+'\n');
 const events=readNativeEvents(root,[start.threadId],[projected,{...projected,type:'item.completed'}, {type:'turn.completed',threadId:start.threadId,ok:true}]);
 assert.equal(events.filter(e=>e.itemType==='tool').length,2);
 const scenario={nativeEngine:{id:'codex',driver:'codex'},incidental:[{engine:'codex',tool:start.tool,inputHash:hashInput(start.input),class:'run'}]};
 assert.deepEqual(nativeOperationEvidence(scenario,{},events),{count:1,errors:[]});
 assert.equal(events.filter(e=>e.type==='turn.completed').length,1);
}));
test('P2 exact instance, generation, input and successful result remain binding',()=>{
 assert.equal(completedOperations([start,{...end,generation:'another-generation'}]).length,0);
 for(const bad of [{...end,providerInstanceId:'foreign'},{...end,input:{body:'changed'}},{...end,ok:false}])assert.equal(completedOperations([start,bad]).length,0);
 assert.equal(completedOperations([start,start,end]).length,0);
 assert.ok(nativeOperationEvidence({nativeEngine:{id:'foreign',driver:'codex'}},{},[start,end]).errors.includes('Native engine identity mismatch'));
});
test('P3 fixture selects only advertised native routes, including OpenClaw passthrough',async()=>{
 const {selectFixtureModel}=await import('./release-engines.mjs');
 const instance={instanceId:'openclaw',models:{default:'flux-auto',options:[{id:'flux-auto'},{id:'openclaw-default',custom:true}]}};
 assert.equal(selectFixtureModel({id:'openclaw'},instance),'openclaw-default');
 assert.throws(()=>selectFixtureModel({id:'openclaw',requestedModel:'made-up'},instance),/advertised/);
 assert.throws(()=>selectFixtureModel({id:'openclaw'}, {...instance,models:{options:[{id:'flux-auto'}]}}),/native/);
});
test('P3 Box provision and named-prompt protocol executes an inert action, never invented completions',()=>temp(async root=>{
 const {boxFixture}=await import('./box-fixture.mjs');
 const provider=boxFixture(root),old=globalThis.fetch;
 globalThis.fetch=(input,init)=>provider(new URL(String(input)),init);
 try{
  const {provisionBox}=await import('../../server/box.ts');
  const provisioned=await provisionBox({box:{token:'fixture-key'}},'fixture-bot','Fixture');
  assert.equal(provisioned.state,'idle');assert.ok(provisioned.boxId);
  const cwd=join(root,'work');mkdirSync(cwd);
  const endpoint=`https://ascii.dev/api/box/v1/boxes/${provisioned.boxId}`;
  const sent=await (await fetch(endpoint+'/prompt',{method:'POST',body:JSON.stringify({model:'gpt-5.4',prompt:`Work ONLY inside ${cwd}. Use the requested tools. Run exactly this shell command once: printf fixture > action.done. If denied, stop.`})})).json();
  const status=await (await fetch(endpoint+'/prompts/'+sent.promptId)).json();
  assert.equal(status.promptRun.status,'finished');assert.equal(readFileSync(join(cwd,'action.done'),'utf8'),'fixture');
  const events=(await (await fetch(endpoint+'/events')).json()).events;
  assert.equal(events.length,1);assert.equal(events[0].promptId,sent.promptId);
  assert.equal(events.some(e=>e.type==='item.completed'),false);
  const bad=await (await fetch(endpoint+'/prompt',{method:'POST',body:JSON.stringify({prompt:`Work ONLY inside ${cwd}. Use the requested tools. Run exactly this shell command once: rm -rf /. If denied, stop.`})})).json();
  assert.equal((await (await fetch(endpoint+'/prompts/'+bad.promptId)).json()).promptRun.status,'failed');
 }finally{globalThis.fetch=old;}
}));
test('P4 capability N/A is exact, evidenced, and never an execution pass',async()=>{
 const {capabilityDisposition,validCapabilityNA}=await import('./capability-rows.mjs');
 for(const id of ['openclaw','pi','box-agent']){
  const engine={id,driver:id,capabilityEvidence:{instanceId:id,driverKind:id,capabilities:{agentsMcp:false}}};
  const row=capabilityDisposition(engine,{id:'created-seat',expected:'RUN'});
  assert.equal(row.verdict,'N/A-by-capability');assert.equal(row.actionProven,false);assert.equal(validCapabilityNA(row),true);
  assert.equal(validCapabilityNA({...row,id:'cd'}),false);
  assert.equal(validCapabilityNA({...row,capabilityEvidence:{...engine.capabilityEvidence,capabilities:{agentsMcp:true}}}),false);
  assert.equal(capabilityDisposition(engine,{id:'cd'}),undefined);
 }
 assert.throws(()=>capabilityDisposition({id:'pi'},{id:'created-seat'}),/capability/);
});
test('P4 reports retain every N/A cell and refuse absent cells or mismatched capability evidence',async()=>{
 const {capabilityDisposition}=await import('./capability-rows.mjs');
 const {machineSummary,releaseVerdict,completeMatrix}=await import('./counts.mjs');
 const {scenarios}=await import('./scenarios.mjs');
 const evidence={instanceId:'pi',driverKind:'piAgent',capabilities:{agentsMcp:false}};
 const engine={id:'pi',driver:'piAgent',capabilityEvidence:evidence,status:'PASS'};
 const na=capabilityDisposition(engine,scenarios.find(s=>s.id==='created-seat'));
 assert.match(machineSummary({rows:[na]}),/rows=1 pass=0 .*skipped=0 na_by_capability=1$/);
 // These are report-validation controls, never scenario execution witnesses.
 const rows=scenarios.map(spec=>spec.id===na.id?na:{...spec,engine:'pi',verdict:'PASS',skipped:false,accounting:{verdict:'PASS'}});
 const report={errors:[],rows,engines:[engine],fixture:{isolated:true},replay:{verdict:'PASS'},mandatory:{verdict:'PASS',engineIds:['pi']}};
 assert.equal(releaseVerdict(report,true,{engineIds:['pi']}),'PASS');
 assert.equal(releaseVerdict({...report,rows:rows.filter(r=>r.id!==na.id)},true,{engineIds:['pi']}),'FAIL');
 assert.equal(releaseVerdict({...report,engines:[{...engine,capabilityEvidence:{...evidence,capabilities:{agentsMcp:true}}}]},true,{engineIds:['pi']}),'FAIL');
 assert.equal(releaseVerdict({...report,rows:rows.map(r=>r.id==='cd'?{...na,id:'cd'}:r)},true,{engineIds:['pi']}),'FAIL');
 assert.equal(completeMatrix([], [engine],[scenarios.find(s=>s.id==='created-seat')])[0].verdict,'FAIL');
});
test('P5 inert saved-app mount produces its actual service effect and rejects wrong inputs',()=>temp(async root=>{
 const state=join(root,'s3-state');mkdirSync(state);
 writeFileSync(join(root,'bots.json'),JSON.stringify([{id:'fixture-bot',composio:true,connectedAppAccess:{denials:[{id:'fixture-rule',accountId:'fixture-account',tools:['GMAIL_SEND_EMAIL']}]}}]));
 const mounts={fixture:{command:process.execPath,args:[new URL('./launchers/release-tool-service.mjs',import.meta.url).pathname],env:{NOLIM_RELEASE_FAKE:'1',NOLIM_FIXTURE_ROOT:root,S3_STATE_DIR:state,GNL_APP_DATA_DIR:root,GNL_SAVED_APP_FIXTURE:'1',GNL_APP_BOT:'fixture-bot',GNL_APP_SCENARIO:'deny-app-denied'}}};
 const input=start.input;
 assert.equal(existsSync(join(state,'app-actions.ndjson')),false);
 await createMountedTools(mounts,async()=>true).call('GMAIL_SEND_EMAIL',input);
 const rows=readFileSync(join(state,'app-actions.ndjson'),'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(rows.length,1);assert.equal(rows[0].tool,'GMAIL_SEND_EMAIL');assert.deepEqual(rows[0].input,input);
 await assert.rejects(createMountedTools(mounts,async()=>true).call('GMAIL_SEND_EMAIL',{...input,to:'other@example.test'}));
 assert.equal(readFileSync(join(state,'app-actions.ndjson'),'utf8').trim().split('\n').length,1);
}));
test('P5 browser-never has a dedicated exact action binding',()=>{
 assert.equal(typeof installDedicatedBindings({})['deny-browser-never'],'function');
});
test('P5 browser-never requires a persisted rule, an exact native result and an actual page hit',()=>temp(async data=>{
 for(const failure of ['none','wrong-input','no-result','no-hit','no-rule']){
  const site={url:'http://127.0.0.1:12345',hits:new Set()};
  const c={api:async()=>({bot:{browserExtensionProfileId:'default'},baseRevision:0,disclosure:{disclosureKey:'fixture-choice'},sites:failure==='no-rule'?[]:[{origin:site.url,rule:'never'}]}),turn:async(_bot,text)=>{
   const input=JSON.parse(/with this input: ([\s\S]*?)\. Do not substitute/.exec(text)[1]);
   if(failure!=='no-hit')site.hits.add(new URL(input.url).pathname);
   const first={...start,tool:'agent_browser_open',input:failure==='wrong-input'?{url:site.url+'/other'}:input};
   const events=[first,...(failure==='no-result'?[]:[{...first,type:'item.completed',ok:true,eventId:'native-end'}])];
   writeFileSync(join(data,'nolim-native-events.ndjson'),events.map(JSON.stringify).join('\n')+'\n');
   return {cards:[],threadIds:[start.threadId],events:[]};
  }};
  const bound=installDedicatedBindings({data})['deny-browser-never'];
  if(failure==='no-rule'){await assert.rejects(bound({client:c,bot:{id:'fixture'},spec:{id:'deny-browser-never'},cwd:data,site}),/persisted/);continue;}
  const result=await bound({client:c,bot:{id:'fixture'},spec:{id:'deny-browser-never'},cwd:data,site});
  assert.equal(result.proof,failure==='none',failure);
 }
}));
test('P6 a newly created existing task is refreshed after defaults change',()=>temp(async root=>{
 const calls=[];const c=new ProductClient('http://127.0.0.1:1',{},root);
 c.level=async()=>{calls.push('level');};
 c.api=async(method,path,body)=>{
  calls.push({method,path,body});
  if(path==='/api/bots')return {bot:{id:'fixture-bot',threadId:'fixture-thread'}};
  if(path.endsWith('/permissions/refresh'))return body?.previewId?{task:{threadId:'fixture-thread',autoApprove:true,fullAccess:true,noLimits:true}}:{previewId:'fixture-preview'};
  return {bot:{id:'fixture-bot',threadId:'fixture-thread',autoApprove:true,fullAccess:true,noLimits:true}};
 };
 await c.bot('Fixture',{id:'codex',model:'gpt-5.4'},root,'unlimited');
 assert.ok(calls.some(c=>c.path==='/api/bots/fixture-bot/tasks/fixture-thread/permissions/refresh'&&c.body?.previewId==='fixture-preview'));
}));
test('P6 missing-origin fault observes only the intended thread and preserves other ingress',()=>temp(async root=>{
 writeFileSync(join(root,'gnl-scenario-fault.json'),JSON.stringify({mode:'missing-origin',threadId:'target-thread'}));
 const preload=new URL('./scenario-fault-preload.mjs',import.meta.url).href;
 const script=`await import(${JSON.stringify(preload)});const faults=globalThis[Symbol.for('gnl.scenario.faults')];const reader=faults.reader({provenance:g=>({generation:g,threadId:g==='target-generation'?'target-thread':'other-thread'}),ownerThread:threadId=>({threadId,level:'unlimited'})});process.stdout.write(JSON.stringify({other:reader.provenance('other-generation'),target:reader.provenance('target-generation'),otherOwner:reader.ownerThread('other-thread'),targetOwner:reader.ownerThread('target-thread')}));`;
 const answer=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',script],{env:{...process.env,MURAGE_DATA_DIR:root},stdio:['ignore','pipe','pipe']});let out='',err='';
  child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.once('error',reject);child.once('close',code=>code===0?resolve(JSON.parse(out)):reject(Error(err)));
 });
 assert.deepEqual(answer,{other:{generation:'other-generation',threadId:'other-thread'},otherOwner:{threadId:'other-thread',level:'unlimited'}});
 const rows=readFileSync(join(root,'gnl-fault-witness.ndjson'),'utf8').trim().split('\n').map(JSON.parse);
 assert.ok(rows.length>0);assert.ok(rows.every(r=>r.threadId==='target-thread'));
}));
test('P7 app-off inventory cannot include the new inert saved-app mount',()=>temp(async root=>{
 const {recordFeatureOff}=await import('./fakes/feature-off.mjs');
 assert.throws(()=>recordFeatureOff({feature:'app-integration',token:'fixture-token'},['mcp__fixture__GMAIL_SEND_EMAIL'],root));
 assert.equal(existsSync(join(root,'gnl-off-witness.ndjson')),false);
 assert.equal(recordFeatureOff({feature:'app-integration',token:'fixture-token'},['shell'],root),'app-integration is off. Turn it on in Settings.');
 assert.equal(JSON.parse(readFileSync(join(root,'gnl-off-witness.ndjson'),'utf8')).toolsAbsent,true);
}));
test('P7 Codex off turn emits exactly one plain line after real MCP inventory',()=>temp(async root=>{
 const state=join(root,'s3-state');mkdirSync(state);
 const cli=new URL('./launchers/codex.mjs',import.meta.url).pathname,service=new URL('./launchers/release-tool-service.mjs',import.meta.url).pathname;
 const frames=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[cli,'-c',`mcp_servers.fixture.command=${JSON.stringify(process.execPath)}`,'-c',`mcp_servers.fixture.args=${JSON.stringify([service])}`],{env:{...process.env,NOLIM_RELEASE_FAKE:'1',NOLIM_FIXTURE_ROOT:root,S3_STATE_DIR:state},stdio:['pipe','pipe','pipe']});
  let output='',buffer='',errors='';
  child.stdout.on('data',chunk=>{output+=chunk;buffer+=chunk;let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{if(JSON.parse(line).method==='turn/completed')child.stdin.end();}catch{}}});
  child.stderr.on('data',b=>errors+=b);child.once('error',reject);child.once('close',code=>code===0?resolve(output.trim().split('\n').map(JSON.parse)):reject(Error(errors)));
  child.stdin.write(JSON.stringify({id:1,method:'turn/start',params:{threadId:'fixture-thread',input:'GNL_FEATURE_OFF app-integration fixture-token'}})+'\n');
 });
 const lines=frames.filter(f=>f.method==='item/completed'&&f.params.item.type==='agentMessage').map(f=>f.params.item.text);
 assert.deepEqual(lines,['app-integration is off. Turn it on in Settings.']);
 assert.equal(frames.some(f=>f.method==='item/started'),false);
 const witness=JSON.parse(readFileSync(join(state,'gnl-off-witness.ndjson'),'utf8'));
 assert.equal(witness.toolsAbsent,true);assert.ok(witness.listed>0);
}));
