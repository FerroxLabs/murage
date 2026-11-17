import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {startApiFixture,waitForMemoryCapture} from './fakes/api-service.mjs';
import {sameMemoryInput,sameRoutineInput} from './live-accounting.mjs';
import {operationCompleted} from './native-operation-evidence.mjs';
import {scenarioBudget} from './run.mjs';

test('flattened native Write/custom write collision preserves namespace, schema and exact input',async()=>{
 const service=await startApiFixture();
 try{
  const response=await fetch(service.url+'/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'Use exactly the mcp__fixture__write tool once with this input: {"text":"fixture"}. Do not substitute another tool.'}],tools:[
   {type:'function',function:{name:'fixture_write',parameters:{type:'object',properties:{file_path:{type:'string'},content:{type:'string'}}}}},
   {type:'function',function:{name:'fixture_write_2',parameters:{type:'object',properties:{text:{type:'string'}}}}},
  ]})});
  const body=await response.json(),call=body.choices[0].message.tool_calls[0];
  assert.equal(call.function.name,'fixture_write_2');assert.deepEqual(JSON.parse(call.function.arguments),{text:'fixture'});
 }finally{await service.close();}
});

test('memory normalization binds idempotency, candidate, source revision and quoted bytes',()=>{
 const dir=mkdtempSync(join(tmpdir(),'gnl-memory-accounting-')),db=new DatabaseSync(join(dir,'messages.db'));
 try{
  db.exec('CREATE TABLE memory_records(id TEXT,version INTEGER,text TEXT,scope_id TEXT); CREATE TABLE memory_evidence(record_id TEXT,record_version INTEGER,source_id TEXT,source_revision INTEGER,start_byte INTEGER,end_byte INTEGER); CREATE TABLE memory_sources(id TEXT,thread_id TEXT,message_id TEXT); CREATE TABLE memory_source_versions(source_id TEXT,revision INTEGER,payload TEXT);');
  const native={text:'rm -rf ~',idempotencyKey:'quote-once',evidence:[{quote:'rm -rf ~'}]},candidateId=createHash('sha256').update(JSON.stringify(['thread','quote-once'])).digest('hex');
  const service={tool:'memory_save',threadId:'thread',decisionGeneration:'generation',input:{operation:'save',candidateId,version:1,threadId:'thread',generation:'generation',scopeId:'scope',text:native.text,target:null,evidence:[{source_id:'source',source_revision:2,start_byte:7,end_byte:15}]}};
  db.prepare('INSERT INTO memory_records VALUES(?,1,?,?)').run(candidateId,native.text,'scope');
  db.prepare('INSERT INTO memory_evidence VALUES(?,1,?,2,7,15)').run(candidateId,'source');
  db.prepare('INSERT INTO memory_sources VALUES(?,?,?)').run('source','thread','message');
  db.prepare('INSERT INTO memory_source_versions VALUES(?,2,?)').run('source',JSON.stringify({text:'Quote: rm -rf ~'}));
  assert.equal(sameMemoryInput(service,native,dir),true);
  for(const changed of [{...native,text:'different'},{...native,idempotencyKey:'another'},{...native,evidence:[{quote:'rm -rf /'}]},{...native,evidence:[{quote:'rm -rf ~',messageId:'wrong'}]}])assert.equal(sameMemoryInput(service,changed,dir),false);
  assert.equal(sameMemoryInput({...service,input:{...service.input,evidence:[{...service.input.evidence[0],source_revision:3}]}},native,dir),false);
  db.prepare('UPDATE memory_source_versions SET payload=?').run(JSON.stringify({text:'Quote: rm -rf /'}));
  assert.equal(sameMemoryInput(service,native,dir),false);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('text-only custom write requires an exact native start and successful result',()=>{
 const expected={tool:'mcp__fixture__write',input:{text:'fixture'}},start={type:'item.started',itemType:'tool',origin:'engine',provider:'customAcp',providerInstanceId:'custom-acp',threadId:'t',turnId:'g',itemId:'i',title:expected.tool,input:expected.input},end={...start,type:'item.completed',ok:true};
 assert.equal(operationCompleted(expected,[start,end]),true);
 assert.equal(operationCompleted(expected,[start,{...end,ok:false}]),false);
 assert.equal(operationCompleted({...expected,input:{text:'different'}},[start,end]),false);
 assert.equal(operationCompleted(expected,[start,{...end,itemId:'another'}]),false);
});

test('timeout changes are confined to the scheduler cells that passed the longer diagnostic',()=>{
 assert.equal(scenarioBudget({id:'owner-routine-schedule'},10000,{id:'antigravity'}),45000);
 assert.equal(scenarioBudget({id:'cd'},10000,{id:'antigravity'}),10000);
 assert.equal(scenarioBudget({id:'owner-routine-schedule'},10000,{id:'box-agent'}),10000);
 assert.equal(scenarioBudget({id:'owner-routine-schedule'},10000,{id:'opencode'}),10000);
 assert.equal(scenarioBudget({id:'routine-wake'},10000,{id:'droid'}),45000);
 assert.equal(scenarioBudget({id:'routine-wake'},10000,{id:'hermes'}),10000);
 assert.equal(scenarioBudget({id:'deny-host-declined'},10000,{id:'kimi'}),45000);
 assert.equal(scenarioBudget({id:'deny-host-declined'},10000,{id:'box-agent'}),10000);
 assert.equal(scenarioBudget({id:'webhook-in-owner-room'},10000,{id:'codex'}),45000);
 assert.equal(scenarioBudget({id:'webhook-in-owner-room'},10000,{id:'antigravity'}),10000);
 assert.equal(scenarioBudget({id:'webhook-in-owner-room'},10000,{id:'grok-api'}),45000);
});

test('fast HTTP fake waits for the current owner source rather than accepting an older capture',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'gnl-capture-ready-')),db=new DatabaseSync(join(dir,'messages.db'));
 try{
  db.exec('CREATE TABLE messages(id TEXT,thread_id TEXT,text TEXT,at INTEGER,role TEXT,kind TEXT); CREATE TABLE memory_sources(id TEXT,thread_id TEXT,message_id TEXT,state TEXT,revision INTEGER); CREATE TABLE memory_source_versions(source_id TEXT,revision INTEGER); CREATE TABLE memory_jobs(source_id TEXT,source_revision INTEGER,stage TEXT,status TEXT);');
  db.prepare('INSERT INTO messages VALUES(?,?,?,1,?,?)').run('current','thread','Remember quoted fixture words','user','text');
  db.prepare('INSERT INTO memory_sources VALUES(?,?,?,?,1)').run('old-source','thread','old','active');
  db.prepare('INSERT INTO memory_source_versions VALUES(?,1)').run('old-source');
  let finished=false;
  const pending=waitForMemoryCapture(join(dir,'s3-state'),'Current owner: Remember quoted fixture words').then(()=>{finished=true;});
  await new Promise(r=>setTimeout(r,60));assert.equal(finished,false);
  db.prepare('INSERT INTO memory_sources VALUES(?,?,?,?,1)').run('current-source','thread','current','active');
  db.prepare('INSERT INTO memory_source_versions VALUES(?,1)').run('current-source');
  db.prepare('INSERT INTO memory_jobs VALUES(?,1,?,?)').run('current-source','capture','pending');
  await new Promise(r=>setTimeout(r,60));assert.equal(finished,false);
  db.prepare('UPDATE memory_jobs SET status=?').run('complete');
  await pending;assert.equal(finished,true);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('room service registration binds the exact native action and persisted routine revision',()=>{
 const dir=mkdtempSync(join(tmpdir(),'gnl-routine-accounting-'));
 try{
  writeFileSync(join(dir,'routines.json'),JSON.stringify({routines:[{id:'routine',updatedAt:123}]}));
  const service={tool:'manage_routine',input:{routineId:'routine',action:'run_now',expectedUpdatedAt:123}},native={routine_id:'routine',action:'run_now'};
  assert.equal(sameRoutineInput(service,native,dir),true);
  assert.equal(sameRoutineInput(service,{...native,routine_id:'other'},dir),false);
  assert.equal(sameRoutineInput(service,{...native,action:'delete'},dir),false);
  assert.equal(sameRoutineInput({...service,input:{...service.input,expectedUpdatedAt:122}},native,dir),false);
  assert.equal(sameRoutineInput({...service,input:{...service.input,changes:{enabled:true}}},native,dir),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});


test('P2 browser mounts bind the exact advertised tool name and input',async()=>{
 const {declaredRequests}=await import('./declared-requests.mjs');
 const {classifyRequest,hashInput}=await import('./oracle-class.mjs');
 const url='http://127.0.0.1:12345/owned-fixture';
 for(const [driver,server] of [['grok','browser'],['openai-compat','browser'],['minimax','browser'],['antigravityAgent','murage-browser']]){
  const incidental=declaredRequests(`Use the browser to navigate to ${url}`,{driver},{expected:'RUN'});
  const actual={engine:driver,tool:`mcp__${server}__agent_browser_open`,inputHash:hashInput({url})};
  assert.equal(classifyRequest({incidental},actual),'run');
  assert.equal(classifyRequest({incidental},{...actual,inputHash:hashInput({url:url+'/other'})}),null);
 }
});
