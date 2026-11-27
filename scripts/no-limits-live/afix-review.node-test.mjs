import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {installBindings} from './bindings.mjs';
import {begin} from './fakes/common.mjs';
import {startApiFixture} from './fakes/api-service.mjs';
import {cappedScenario} from './scenario-timeout.mjs';
import { safeWipeSync } from '../../server/testing/safe-wipe.mjs';

test('H1 live binding rejects an interruption outside the two durable queried tables',async()=>{
 const data=mkdtempSync(join(tmpdir(),'gnl-accounting-red-'));
 const db=new DatabaseSync(join(data,'messages.db'));
 db.exec('CREATE TABLE approval_records(id,thread_id,request_id,why,state,chat_message_id,created_at);CREATE TABLE messages(id,thread_id,at,json,kind)');db.close();
 try{
  const f={data,client:{url:'http://127.0.0.1:1',headers:{}}};installBindings(f);
  const got=await f.observeRow({spec:{id:'cd',level:'unlimited',actor:'owner',expected:'RUN'},threadIds:['t']});
  assert.equal(got.verdict,'FAIL');assert.ok(got.errors.some(e=>/surface|receipt|registration/.test(e)));
 }finally{safeWipeSync(data);}
});

test('H2 private replay traverses registration delivery and final release',()=>{
 const worker=readFileSync(new URL('./private-replay-worker.mjs',import.meta.url),'utf8');
 assert.match(worker,/privateProductionAdapter/);
 const adapter=readFileSync(new URL('./private-production.mjs',import.meta.url),'utf8');
 for(const seam of ['openReplayRequest','d.decide(','d.deliverRequest(','guardEngineRelease('])assert.ok(adapter.includes(seam),seam);
});

test('H2 refusal outcomes are counted rather than an absent AutoVerdict field',async()=>{
 const {replayPrivateRows}=await import('./private-corpus.mjs');
 const rows=[{id:'synthetic',boundedToolInput:'{"command":"printf fixture"}'}],labels=new Map([['synthetic',{verdict:'none'}]]);
 for(const outcome of [{kind:'refuse'},{kind:'run',actionExecuted:false},{kind:'run',refusals:1},{kind:'run',holds:1}]){
  const report=await replayPrivateRows({rows,labels,decide:async()=>outcome});
  assert.equal(report.verdict,'FAIL');assert.equal(report.pass,0);assert.equal(report.refusals,1);
 }
 const ok=await replayPrivateRows({rows,labels,decide:async()=>({kind:'run',actionExecuted:true})});assert.equal(ok.pass,1);
});

test('H3 release fakes implement file browser seat field and switch prompts',async()=>{
 const prior=process.env.NOLIM_RELEASE_FAKE;process.env.NOLIM_RELEASE_FAKE='1';
 try{
  for(const [text,tool]of [
   ['Edit notes.txt using the file editing tool: replace before with after.','Write'],
   ['Use browser tools to navigate to http://127.0.0.1:1234/page and inspect the page.','browser'],
   ["Use create_bot to create one new seat named 'Fixture child' with instance_id claude and model sonnet. Do not delegate yet.",'create_bot'],
   ['Use exactly the Write tool once with this input: {"file_path":"fixture.txt","content":"fixture"}. Do not substitute another tool or describe the result.','Write'],
   ['Run this action once: printf fixture > action.done. If interrupted by a permission-level change, retry the stopped action.','Bash'],
  ]){const plan=await begin(text);assert.ok(plan.steps.some(s=>s.kind==='tool'&&s.tool.includes(tool)),JSON.stringify(plan));}
 }finally{if(prior===undefined)delete process.env.NOLIM_RELEASE_FAKE;else process.env.NOLIM_RELEASE_FAKE=prior;}
});

test('H3 HTTP fake emits a native mounted tool call and terminates after its result',async()=>{
 const service=await startApiFixture();
 try{
  const request={model:'fake-model',messages:[{role:'user',content:'Run exactly: printf fixture > action.done'}],tools:[{type:'function',function:{name:'shell',parameters:{type:'object',properties:{command:{type:'string'}}}}}]};
  const call=async body=>(await fetch(service.url+'/chat/completions',{method:'POST',body:JSON.stringify(body)})).json();
  const first=await call(request),tool=first.choices[0].message.tool_calls?.[0];assert.ok(tool);assert.equal(tool.function.name,'shell');
  assert.equal(JSON.parse(tool.function.arguments).command,'printf fixture > action.done');
  const next=await call({...request,messages:[...request.messages,first.choices[0].message,{role:'tool',tool_call_id:tool.id,content:'completed'}]});assert.equal(next.choices[0].finish_reason,'stop');
 }finally{await service.close();}
});

test('H3 required mutation restart and missing origin bindings are installed',()=>{
 const f={};installBindings(f);
 for(const id of ['release-input-changed','owner-restart','owner-missing-live-record','missing-origin'])assert.equal(typeof f.workflowFixtures?.[id],'function',id);
});

test('M1 Git setup yields and obeys the same deadline',async()=>{
 const {scenarioGit}=await import('./scenario-timeout.mjs');
 const root=mkdtempSync(join(tmpdir(),'gnl-slow-git-'));const fake=join(root,'git');writeFileSync(fake,'#!/bin/sh\nexec /bin/sleep 2\n',{mode:0o700});
 try{const started=Date.now();await assert.rejects(cappedScenario(()=>scenarioGit(['status'],root,{...process.env,PATH:root}),30),/Scenario timed out/);assert.ok(Date.now()-started<500);}
 finally{safeWipeSync(root);}
});

test('H2 actual product replay catches late release refusal and forbids persistence',async()=>{
 const {spawnSync}=await import('node:child_process');
 const result=spawnSync(process.execPath,['--experimental-strip-types',new URL('./private-check-worker.mjs',import.meta.url).pathname],{encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
 assert.deepEqual(JSON.parse(result.stdout),{run:1,late:1,wipe:1,blocked:9,owner_replays:7});
});

test('H3 every native wrapper answers its real version handshake',async()=>{
 const {spawnSync}=await import('node:child_process');
 for(const file of ['fake-pi-cli.ts','fake-muse-cli.ts','fake-agy-cli.ts']){
  const result=spawnSync(process.execPath,['--experimental-strip-types',new URL('./launchers/'+file,import.meta.url).pathname,'--version'],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,file+': '+result.stderr);assert.match(result.stdout,/\d+\.\d+/);
 }
});

test('H1 service accounting needs the exact native operation and a successful result',async()=>{
 const {normalizeLiveAccounting}=await import('./live-accounting.mjs');
 const {observe}=await import('./observe.mjs');const {hashInput}=await import('./oracle-class.mjs');
 const data=mkdtempSync(join(tmpdir(),'gnl-service-accounting-'));
 const source={threadId:'t',requestKey:'service-key',requestId:'service-key',decisionGeneration:'g',tool:'create_bot',input:{name:'Public fixture'}};source.registrationInputHash=hashInput({tool:source.tool,input:source.input});
 writeFileSync(join(data,'nolim-service-protocol.ndjson'),JSON.stringify(source)+'\n');
 const snapshot=()=>({complete:true,errors:[],taps:[],registrations:[{threadId:'t',requestKey:'service-key',inputHash:source.registrationInputHash,unmatched:true}],records:[],messages:[],queues:[],electron:[],mirrors:[]});
 const events=[{type:'item.started',itemType:'tool',threadId:'t',turnId:'turn',itemId:'item',provider:'claudeAgent',toolIdentity:{name:'agents__create_bot'},input:source.input},{type:'item.completed',itemType:'tool',provider:'claudeAgent',threadId:'t',turnId:'turn',itemId:'item',ok:true}];
 const spec={incidental:[{engine:'claudeAgent',tool:'create_bot',inputHash:hashInput(source.input),class:'run'}]};
 try{
  assert.equal(observe(spec,normalizeLiveAccounting(snapshot(),{dataDir:data,events,threadIds:['t']})).verdict,'PASS');
  for(const bad of [events.slice(0,1),events.slice(1),[events[0],{...events[1],ok:false}],[{...events[0],input:{name:'Different operation'}},events[1]]])assert.equal(observe(spec,normalizeLiveAccounting(snapshot(),{dataDir:data,events:bad,threadIds:['t']})).verdict,'FAIL');
 }finally{safeWipeSync(data);}
});

test('H1 actual text questions require their own record and independent question request',async()=>{
 const {observe}=await import('./observe.mjs');const {hashInput}=await import('./oracle-class.mjs');
 const input={question:'Fixture color'},request={generation:'g',requestId:'r',engine:'claudeAgent',tool:'ask_user',inputHash:hashInput(input)};
 const snapshot={complete:true,errors:[],taps:[{...request,type:'request'},{generation:'g',requestId:'r',type:'answer',state:'accepted'}],registrations:[{generation:'g',requestId:'r'}],records:[{id:'a',generation:'g',request_id:'r',thread_id:'t',chat_message_id:'m',why:'question'}],messages:[{id:'m',threadId:'t',kind:'text',text:'Question 1 of 1\nFixture color'}],queues:[],electron:[],mirrors:[]};
 assert.equal(observe({incidental:[{...request,class:'question'}]},snapshot).verdict,'PASS');
 assert.equal(observe({incidental:[{...request,class:'run'}]},snapshot).verdict,'FAIL');
 const hidden=structuredClone(snapshot);hidden.messages=[];assert.equal(observe({incidental:[{...request,class:'question'}]},hidden).verdict,'FAIL');
});

test('H2 sealed private worker still writes a valid aggregate failure report',async()=>{
 const {spawnSync}=await import('node:child_process');
 const root=mkdtempSync(join(tmpdir(),'gnl-worker-counts-')),home=join(root,'home'),data=join(root,'data'),out=join(root,'counts.json');mkdirSync(home);mkdirSync(data);
 try{
  const result=spawnSync(process.execPath,['--experimental-strip-types',new URL('./private-replay-worker.mjs',import.meta.url).pathname,join(root,'absent-corpus'),'invalid',out],{encoding:'utf8',timeout:15000,env:{...process.env,HOME:home,MURAGE_DATA_DIR:data,NODE_ENV:'test'}});
  assert.equal(result.status,1);assert.equal(result.stdout,'');assert.equal(result.stderr,'');
  assert.deepEqual(JSON.parse(readFileSync(out,'utf8')),{verdict:'FAIL',rows:0,pass:0,nonwipe_cards:0,refusals:0,skipped:0,harness_errors:1});
 }finally{safeWipeSync(root);}
});

test('H2 private report admission rejects worker failure and every non-count field',async()=>{
 const {privateCountResult}=await import('./release-legs.mjs');
 const counts={verdict:'PASS',rows:140,pass:140,nonwipe_cards:0,refusals:0,skipped:0,harness_errors:0,controls:{rows:3,pass:3}};
 assert.equal(privateCountResult(counts,0).verdict,'PASS');
 for(const report of [null,{...counts,error:'SYNTHETIC_PRIVATE_SENTINEL'},{...counts,rows:'SYNTHETIC_PRIVATE_SENTINEL'},{...counts,controls:{rows:3,pass:3,field:'SYNTHETIC_PRIVATE_SENTINEL'}}]){
  const result=privateCountResult(report,0);assert.equal(result.verdict,'FAIL');assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_SENTINEL'));
 }
 assert.equal(privateCountResult(counts,1).verdict,'FAIL');
});

test('H1 even seven empty readable surfaces cannot qualify a row without a native request',async()=>{
 const data=mkdtempSync(join(tmpdir(),'gnl-empty-accounting-'));mkdirSync(join(data,'browser-extension'));mkdirSync(join(data,'skill-state','b'),{recursive:true});
 const db=new DatabaseSync(join(data,'messages.db'));db.exec('CREATE TABLE messages(thread_id TEXT,id TEXT,at INTEGER,role TEXT,kind TEXT,text TEXT,json TEXT,PRIMARY KEY(thread_id,id));CREATE TABLE email_sends(state);CREATE TABLE room_shares(status);CREATE TABLE memory_records(state);CREATE TABLE image_operations(state);');
 const {initializeApprovals}=await import('../../server/decision/records.ts');initializeApprovals(db);db.close();
 writeFileSync(join(data,'bots.json'),'[{"id":"b"}]');writeFileSync(join(data,'config.json'),'{"mcpServers":{}}');writeFileSync(join(data,'browser-extension/approvals.json'),'{"version":1,"records":[]}');writeFileSync(join(data,'skill-state/b/staged.json'),'{"writes":{}}');
 for(const file of ['channel-mirror-outbox.ndjson','nolim-protocol.ndjson','nolim-native-events.ndjson','nolim-registrations.ndjson','nolim-service-protocol.ndjson'])writeFileSync(join(data,file),'');
 const {createServer}=await import('node:http');const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end('{"open":[]}');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const f={data,client:{url:`http://127.0.0.1:${server.address().port}`,headers:{},events:[],declared:new Map()}};installBindings(f);const result=await f.observeRow({spec:{id:'cd',expected:'RUN',actor:'owner',level:'unlimited'},threadIds:['t']});assert.equal(result.verdict,'FAIL');assert.ok(result.errors.includes('Native request and receipt absent'));}
 finally{await new Promise(r=>server.close(r));safeWipeSync(data);}
});


test('H3 browser plans use the current native mounted catalogue',async()=>{
 const {releasePlan}=await import('./fakes/release-plan.mjs');
 const steps=releasePlan('Use browser tools to navigate to http://127.0.0.1:1234/page and inspect the page.').steps;
 assert.deepEqual(steps.map(step=>step.tool),['agent_browser_open','agent_browser_snapshot','agent_browser_close']);
 const {recordFeatureOff}=await import('./fakes/feature-off.mjs');
 assert.throws(()=>recordFeatureOff({feature:'browser',token:'synthetic'},['agent_browser_open'],'/unused'),/Disabled capability remains/);
});

test('H3 native browser enablement is confined to the release fixture',async()=>{
 const {ProductClient}=await import('./run.mjs');
 const dir=mkdtempSync(join(tmpdir(),'gnl-browser-scope-'));
 try{
  const c=new ProductClient('http://127.0.0.1:1',{},dir),patches=[];
  const bot={id:'synthetic-bot',threadId:'synthetic-thread',autoApprove:true,fullAccess:true,noLimits:true};
  c.api=async(method,path,body)=>{if(method==='PATCH')patches.push(body);return {bot};};c.level=async()=>{};
  await c.bot('Standalone',{id:'verification',model:'fixture'},dir,'unlimited');
  assert.equal(Object.hasOwn(patches[0],'browser'),false);
  c.releaseFixture=true;await c.bot('Release',{id:'verification',model:'fixture'},dir,'unlimited');
  assert.equal(patches[1].browser,true);
 }finally{safeWipeSync(dir);}
});

test('H3 a failed queued native turn is observed before waiting for queue admission',async()=>{
 const {spawnSync}=await import('node:child_process');
 const source=`import {installBindings} from ${JSON.stringify(new URL('./bindings.mjs',import.meta.url).href)};
 let unhandled=0;process.on('unhandledRejection',()=>unhandled++);
 const f={};installBindings(f);const c={events:[{threadId:'t',type:'content.delta'}],turn:()=>Promise.reject(Error('synthetic native failure')),api:async(method)=>{await new Promise(r=>setTimeout(r,20));return method==='GET'?{bot:{busy:true}}:{queued:true,queueId:'q'};}};
 try{await f.r31Fixtures['queued-owner-drain']({client:c,bot:{id:'b',threadId:'t'}});}catch(error){if(error.message!=='synthetic native failure')throw error;}
 await new Promise(r=>setTimeout(r,20));process.stdout.write(JSON.stringify({unhandled}));`;
 const result=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',source],{encoding:'utf8',timeout:5000});
 assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{unhandled:0});
});

test('H1 native shell declarations bind normalized Antigravity and Muse cwd inputs',async()=>{
 const {declaredRequests}=await import('./declared-requests.mjs'),{classifyRequest,hashInput}=await import('./oracle-class.mjs');
 const cwd='/tmp/nolim-live-synthetic/work',command='printf fixture > action.done',text=`Run exactly: ${command}`;
 for(const [driver,tool,input]of [['antigravityAgent','run_command',{command,cwdExplicit:false,cwd}],['museCode','shell',{command,cwd}]]){
  const incidental=declaredRequests(text,{driver},{expected:'RUN'},cwd),actual={engine:driver,tool,inputHash:hashInput(input)};
  assert.equal(classifyRequest({incidental},actual),'run');
  assert.equal(classifyRequest({incidental},{...actual,inputHash:hashInput({...input,cwd:'/another-workspace'})}),null);
 }
});

test('H3 HTTP questions use the mounted schema and retain the instruction through the owner reply',async()=>{
 const service=await startApiFixture();try{
  const body={model:'fake',messages:[{role:'user',content:'Use the question tool to ask a fixture color.'}],tools:[{type:'function',function:{name:'ask_user',parameters:{type:'object',required:['questions']}}}]};
  const call=async b=>(await fetch(service.url+'/chat/completions',{method:'POST',body:JSON.stringify(b)})).json();
  const first=await call(body),tool=first.choices[0].message.tool_calls?.[0];assert.ok(tool);
  assert.equal(JSON.parse(tool.function.arguments).questions[0].question,'Choose a fixture color');
  const second=await call({...body,messages:[...body.messages,first.choices[0].message,{role:'tool',tool_call_id:tool.id,content:'blue'},{role:'user',content:'blue'}]});
  assert.equal(second.choices[0].finish_reason,'stop');assert.match(second.choices[0].message.content,/Chosen: blue/);
 }finally{await service.close();}
});

test('H3 native holds publish working text before waiting for queue admission',async()=>{
 const {nativePlay}=await import('./native-play.mjs');const prior=process.env.NOLIM_RELEASE_FAKE;process.env.NOLIM_RELEASE_FAKE='1';const text=[];
 const task=nativePlay('S3_HOLD',{mounts:{},allow:async()=>false,started(){},completed(){},text:value=>text.push(value)});
 try{await new Promise(r=>setTimeout(r,20));assert.ok(text.some(value=>/Working/.test(value)));}
 finally{await task;if(prior===undefined)delete process.env.NOLIM_RELEASE_FAKE;else process.env.NOLIM_RELEASE_FAKE=prior;}
});

test('H1 native questions with no tool argument still require a declared question operation',async()=>{
 const {declaredRequests}=await import('./declared-requests.mjs'),{classifyRequest,hashInput}=await import('./oracle-class.mjs');
 for(const [driver,tool]of [['codex','request_user_input'],['fuigoAgent','elicitation']]){
  const actual={engine:driver,tool,inputHash:hashInput(null)};
  assert.equal(classifyRequest({incidental:declaredRequests('S3_TWO_QUESTIONS',{driver},{expected:'RUN'})},actual),'question');
  assert.equal(classifyRequest({incidental:declaredRequests('Run exactly: printf fixture',{driver},{expected:'RUN'})},actual),null);
 }
});

test('H3 native mounted questions use their wire schema and cannot execute before native approval',async()=>{
 const {nativePlay}=await import('./native-play.mjs'),{existsSync}=await import('node:fs');
 const dir=mkdtempSync(join(tmpdir(),'gnl-native-question-')),receipt=join(dir,'receipt.json'),prior=process.env.NOLIM_RELEASE_FAKE;process.env.NOLIM_RELEASE_FAKE='1';
 const server=`import {createInterface} from 'node:readline';import {writeFileSync} from 'node:fs';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);let result={};if(m.method==='tools/list')result={tools:[{name:'ask_user',inputSchema:{type:'object'}}]};if(m.method==='tools/call'){const input=m.params.arguments;if(!Array.isArray(input.questions))result={isError:true,content:[{type:'text',text:'Question schema required'}]};else{writeFileSync(${JSON.stringify(receipt)},JSON.stringify(input));result={content:[{type:'text',text:'blue'}]};}}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`;
 const options={mounts:{agents:{command:process.execPath,args:['--input-type=module','-e',server]}},allow:async()=>false,started(){},completed(){}};
 try{
  await assert.rejects(nativePlay('Use the question tool to ask a fixture color.',{...options,beforeMounted:async()=>false}),/native approval/);assert.equal(existsSync(receipt),false);
  let called=0;await nativePlay('Use the question tool to ask a fixture color.',{...options,beforeMounted:async detail=>{called++;assert.equal(detail.server,'agents');assert.equal(detail.tool,'ask_user');return true;}});
  assert.equal(called,1);assert.equal(JSON.parse(readFileSync(receipt)).questions[0].question,'Choose a fixture color');
 }finally{if(prior===undefined)delete process.env.NOLIM_RELEASE_FAKE;else process.env.NOLIM_RELEASE_FAKE=prior;safeWipeSync(dir);}
});

test('H1 unasked native tools require actual starts and successful results and cannot hide another surface',async()=>{
 const {createServer}=await import('node:http'),{hashInput}=await import('./oracle-class.mjs');
 const data=mkdtempSync(join(tmpdir(),'gnl-unasked-native-'));mkdirSync(join(data,'browser-extension'));mkdirSync(join(data,'skill-state','b'),{recursive:true});
 const db=new DatabaseSync(join(data,'messages.db'));db.exec('CREATE TABLE messages(thread_id TEXT,id TEXT,at INTEGER,role TEXT,kind TEXT,text TEXT,json TEXT,PRIMARY KEY(thread_id,id));CREATE TABLE email_sends(state);CREATE TABLE room_shares(status);CREATE TABLE memory_records(state);CREATE TABLE image_operations(state);');const {initializeApprovals}=await import('../../server/decision/records.ts');initializeApprovals(db);db.close();
 writeFileSync(join(data,'bots.json'),'[{"id":"b"}]');writeFileSync(join(data,'config.json'),'{"mcpServers":{}}');writeFileSync(join(data,'browser-extension/approvals.json'),'{"version":1,"records":[]}');writeFileSync(join(data,'skill-state/b/staged.json'),'{"writes":{}}');
 for(const file of ['channel-mirror-outbox.ndjson','nolim-protocol.ndjson','nolim-native-events.ndjson','nolim-registrations.ndjson','nolim-service-protocol.ndjson'])writeFileSync(join(data,file),'');
 const input={url:'http://127.0.0.1:1234/fixture'},start={eventId:'start',type:'item.started',origin:'engine',itemType:'tool',provider:'claudeAgent',providerInstanceId:'native-fixture',threadId:'t',turnId:'turn',itemId:'tool',title:'agent_browser_open',input},end={...start,eventId:'end',type:'item.completed',ok:true};delete end.input;
 const save=events=>writeFileSync(join(data,'nolim-native-events.ndjson'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');save([start,end]);
 let orphan=false;const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({open:orphan?[{approvalId:'orphan',threadId:'t'}]:[]}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const f={data,client:{url:`http://127.0.0.1:${server.address().port}`,headers:{},events:[],declared:new Map([['t',[{engine:'claudeAgent',tool:'agent_browser_open',inputHash:hashInput(input),class:'run'}]]])}};installBindings(f);const run=()=>f.observeRow({spec:{id:'browser',expected:'RUN'},engine:{id:'native-fixture',driver:'claudeAgent'},threadIds:['t']});
  assert.equal((await run()).verdict,'PASS');
  orphan=true;assert.equal((await run()).verdict,'FAIL');orphan=false;
  for(const events of [[],[start],[start,{...end,ok:false}],[{...start,input:{url:'http://another.test/'}},end],[start,{...end,threadId:'other'}],[start,{...end,providerInstanceId:'another-engine'}],[{...start,providerInstanceId:'another-engine'},end],[{...start,providerInstanceId:'another-engine'},{...end,providerInstanceId:'another-engine'}],[start,end,{...end,eventId:'duplicate'}]]){save(events);assert.equal((await run()).verdict,'FAIL');}
 }finally{await new Promise(r=>server.close(r));safeWipeSync(data);}
});

test('H1 email service receipts bind the full canonical native payload and registered intent',async()=>{
 const {normalizeLiveAccounting}=await import('./live-accounting.mjs'),{serviceIntentHash}=await import('./native-operation-evidence.mjs'),{observe}=await import('./observe.mjs'),{hashInput}=await import('./oracle-class.mjs');
 const data=mkdtempSync(join(tmpdir(),'gnl-email-receipt-')),input={to:['fixture@example.test'],subject:'rm -rf ~ is quoted text',text:'S3 fake email fixture'};
 const service={threadId:'t',requestKey:'email:key',requestId:'send',decisionGeneration:'g',tool:'email_send',input:{kind:'send',sendId:'send',payloadHash:'6f5a9cdae2c651e707594e9ca4ff092e4e469b56723152456c8bfa0b6529f020',summary:{to:input.to,cc:[],subject:input.subject,textLength:input.text.length,attachments:[],replySource:null},text:input.text}};
 service.registrationInputHash=serviceIntentHash({tool:service.tool,input:service.input});
 const snapshot=()=>({complete:true,errors:[],taps:[],registrations:[{threadId:'t',requestKey:'email:key',inputHash:service.registrationInputHash,unmatched:true}],records:[],messages:[],queues:[],electron:[],mirrors:[]});
 const events=[{type:'item.started',itemType:'tool',provider:'claudeAgent',threadId:'t',turnId:'turn',itemId:'email',title:'email_send',input},{type:'item.completed',itemType:'tool',provider:'claudeAgent',threadId:'t',turnId:'turn',itemId:'email',ok:true}],spec={incidental:[{engine:'claudeAgent',tool:'email_send',inputHash:hashInput(input),class:'run'}]};
 const run=(s,es=events,change)=>{writeFileSync(join(data,'nolim-service-protocol.ndjson'),JSON.stringify(s)+'\n');const snap=snapshot();change?.(snap);return observe(spec,normalizeLiveAccounting(snap,{dataDir:data,events:es,threadIds:['t']}));};
 try{
  assert.equal(run(service).verdict,'PASS');
  for(const changed of [{...service,input:{...service.input,payloadHash:'0'.repeat(64)}},{...service,input:{...service.input,summary:{...service.input.summary,to:['other@example.test']}}},{...service,input:{...service.input,text:'different'}},{...service,input:{...service.input,sendId:'another'}}])assert.equal(run(changed).verdict,'FAIL');
  assert.equal(run(service,events,s=>{s.registrations[0].inputHash='0'.repeat(64);}).verdict,'FAIL');
  assert.equal(run(service,[events[0],{...events[1],ok:false}]).verdict,'FAIL');
 }finally{safeWipeSync(data);}
});

test('H1 ACP command titles and API fixture aliases retain exact native input binding',async()=>{
 const {nativeOperationEvidence}=await import('./native-operation-evidence.mjs'),{declaredRequests}=await import('./declared-requests.mjs'),{classifyRequest,hashInput}=await import('./oracle-class.mjs');
 const command='printf fixture > action.done',input={command},engine={driver:'geminiAgent',id:'gemini'},incidental=declaredRequests(`Run exactly: ${command}`,engine,{expected:'RUN'});
 const start={type:'item.started',itemType:'tool',origin:'engine',toolKind:'execute',title:command,input,provider:engine.driver,providerInstanceId:engine.id,threadId:'t',turnId:'g',itemId:'i'},end={...start,type:'item.completed',ok:true};
 const spec={incidental,nativeEngine:engine};assert.deepEqual(nativeOperationEvidence(spec,{taps:[]},[start,end]),{count:1,errors:[]});
 assert.ok(nativeOperationEvidence(spec,{taps:[]},[{...start,input:{command:'a different command'}},end]).errors.length);
 const requests=declaredRequests(`Run exactly: ${command}`,{driver:'grok'},{expected:'RUN'});
 assert.equal(classifyRequest({incidental:requests},{engine:'grok',tool:'mcp__fixture__shell',inputHash:hashInput(input)}),'run');
 assert.equal(classifyRequest({incidental:requests},{engine:'grok',tool:'mcp__fixture__shell',inputHash:hashInput({command:'another command'})}),null);
 for(const [text,tool,input]of [['S3_EMAIL','mcp__agents__email_send',{to:['fixture@example.test'],subject:'rm -rf ~ is quoted text',text:'S3 fake email fixture'}],['Use the question tool to ask a fixture color.','mcp__agents__ask_user',{questions:[{question:'Choose a fixture color',options:[{label:'red'},{label:'blue'}]}]}]]){const incidental=declaredRequests(text,{driver:'grok'},{expected:'RUN'});assert.ok(classifyRequest({incidental},{engine:'grok',tool,inputHash:hashInput(input)}));}
});
