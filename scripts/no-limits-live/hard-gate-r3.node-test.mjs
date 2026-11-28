// Uses only exports present at 91c4d404, so behavioral RED runs on that base.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {installBindings} from './bindings.mjs';
import {hashInput as nativeHash} from './oracle-class.mjs';
import * as native from './native-operation-evidence.mjs';
import { safeWipeSync } from '../../server/testing/safe-wipe.mjs';
const {readNativeEvents,completedOperations,nativeOperationEvidence}=native;
const stamp=n=>new Date(n).toISOString();
const event=(type,turnId,at,extra={})=>({type,turnId,threadId:'routine-thread',provider:'claudeAgent',providerInstanceId:'claude',createdAt:stamp(at),eventId:`${type}-${turnId}`, ...extra});
const original=[event('turn.started','delegation',100),event('turn.completed','delegation',200,{ok:true})];
const wake=[event('turn.started','wake',400),event('item.completed','wake',500,{itemType:'assistant_text',origin:'engine',text:'S3_PEER_REPLY'}),event('turn.completed','wake',600,{ok:true})];
const delivery={id:'dres-peer',at:300,role:'bot',kind:'text',inboundKind:'action',from:{botId:'peer'},copyOf:{threadId:'peer-thread',messageIds:['peer-output']},text:'S3_PEER_REPLY'};
const output={id:'provider-output',at:500,role:'bot',kind:'text',turnId:'wake',provenance:'provider',engine:{instanceId:'claude',driverKind:'claudeAgent'},text:'S3_PEER_REPLY'};
async function binding(events,messages){
 let reads=0;const client={events:[],streamErrors:[],ledger:{forWindow:()=>[],problems:()=>[]},
  bot:async()=>({id:'peer',threadId:'peer-thread'}),
  api:async(method,path)=>{
   if(method==='GET')return {runs:[{id:'run',threadId:'routine-thread'}]};
   if(path.endsWith('/run')){client.events.push(...events);return {runId:'run'};}
   return {routine:{id:'routine'}};
  },
  observe:async()=>({ended:true,complete:true,events:original,messages:[],errors:[],turn:{type:'turn.completed',ok:true,turnId:'delegation'}}),
  // End a deterministic absent-wake probe after two reads; no 45s wall-clock wait.
  messages:async()=>{if(++reads>1)throw Error('No routine wake observed');return messages;}
 };
 return installBindings({})['routine-wake']({client,bot:{id:'bot'},engine:{id:'claude'},cwd:'/fixture',spec:{id:'routine-wake'},threads:new Set(),ids:[]});
}
test('H1 delivery without resume fails the routine wake binding',async()=>{
 await assert.rejects(binding(original,[delivery]),/No routine wake observed/);
});
test('H1 copied dres message alone fails even beside a successful wake turn',async()=>{
 await assert.rejects(binding([...original,...wake],[delivery]),/No routine wake observed/);
});
test('H1 a distinct successful provider wake after delivery passes and retains its evidence',async()=>{
 const result=await binding([...original,...wake],[delivery,output]);
 assert.equal(result.proof,true);assert.equal(result.witness.wakeTurnId,'wake');
 assert.equal(result.witness.deliveryMessageId,'dres-peer');assert.equal(result.witness.wakeMessageId,'provider-output');
 assert.equal(result.obs.turn.turnId,'wake');assert.deepEqual(result.obs.events,[...original,...wake]);
});
test('H1 original, early, failed, mismatched and copied provider output cannot prove a wake',async()=>{
 const cases=[
  {events:[...original,...wake.map(e=>({...e,turnId:'delegation'}))],message:{...output,turnId:'delegation'}},
  {events:[...original,{...wake[0],createdAt:stamp(250)},...wake.slice(1)],message:output},
  {events:[...original,...wake.slice(0,2),{...wake[2],ok:false}],message:output},
  {events:[...original,...wake.slice(0,2)],message:output},
  {events:[...original,...wake],message:{...output,copyOf:delivery.copyOf}},
  {events:[...original,...wake],message:{...output,inboundKind:'action'}},
  {events:[...original,...wake],message:{...output,provenance:undefined}},
  {events:[...original,...wake],message:{...output,engine:{instanceId:'other',driverKind:'claudeAgent'}}},
  {events:[...original,...wake.map(e=>e.type==='item.completed'?{...e,origin:'murage'}:e)],message:output},
  {events:[...original,...wake.map(e=>e.type==='item.completed'?{...e,text:'unrelated'}:e)],message:output},
  {events:[...original,...wake.map(e=>e.type==='turn.completed'?{...e,ok:undefined}:e)],message:output},
  {events:[...original,...wake.map(e=>({...e,providerInstanceId:'other'}))],message:{...output,engine:{instanceId:'other',driverKind:'claudeAgent'}}},
 ];
 for(const {events,message} of cases)await assert.rejects(binding(events,[delivery,message]),/No routine wake observed/);
});
test('M1 public history is visited once and later reads visit only appended events',()=>{
 const root=mkdtempSync(join(tmpdir(),'gnl-r3-public-'));
 try{
  writeFileSync(join(root,'nolim-native-events.ndjson'),'');let visits=0;
  const publicEvents=Array.from({length:10000},(_,n)=>({type:'turn.started',get threadId(){visits++;return `old-${n}`;}}));
  assert.deepEqual(readNativeEvents(root,['new'],publicEvents),[]);assert.equal(visits,10000);
  for(let n=0;n<20;n++)assert.deepEqual(readNativeEvents(root,['new'],publicEvents),[]);
  assert.equal(visits,10000);
  publicEvents.push({type:'turn.started',threadId:'new',turnId:'fresh'});
  assert.equal(readNativeEvents(root,['new'],publicEvents)[0].turnId,'fresh');assert.equal(visits,10000);
  publicEvents.length=0;assert.deepEqual(readNativeEvents(root,['new'],publicEvents),[]);
 }finally{safeWipeSync(root);}
});
test('M1 tool start and completion joins visit events linearly and preserve duplicate rejection',()=>{
 let visits=0;const count=2000;
 const events=Array.from({length:count},(_,n)=>[
  {type:'item.started',itemType:'tool',threadId:'t',turnId:'g',itemId:String(n),provider:'claudeAgent',input:{command:'echo fixture'},tool:'Bash'},
  {type:'item.completed',itemType:'tool',threadId:'t',turnId:'g',itemId:String(n),provider:'claudeAgent',ok:true},
 ]).flat().map(e=>new Proxy(e,{get(target,key){if(['type','itemType','threadId','turnId','itemId','provider','providerInstanceId'].includes(key))visits++;return target[key];}}));
 assert.equal(completedOperations(events).length,count);
 assert.ok(visits<events.length*30,`event visits ${visits} exceed linear budget`);
 visits=0;
 const scenario={requests:[{engine:'claudeAgent',tool:'Bash',input:{command:'echo fixture'},class:'run'}]};
 assert.equal(nativeOperationEvidence(scenario,{},events).count,count);
 assert.ok(visits<events.length*40,`accounting visits ${visits} exceed linear budget`);
 assert.equal(completedOperations([events[0],events[1],events[1]]).length,0);
 assert.equal(completedOperations([events[0],events[0],events[1]]).length,0);
});

// This assertion also runs against b071c65b, before the r2-only exports existed.
test('R2 baseline permission receipts cannot substitute for successful native execution',()=>{
 const input={command:'echo fixture'},scenario={requests:[{engine:'claudeAgent',tool:'Bash',input,class:'run'}]};
 const start={type:'item.started',itemType:'tool',provider:'claudeAgent',providerInstanceId:'claude',threadId:'t',turnId:'g',itemId:'shell',toolKind:'execute',title:'echo fixture',input};
 const end={...start,type:'item.completed',ok:true};
 const receipt={taps:[{type:'request',engine:'claudeAgent',tool:'Bash',threadId:'t',generation:'g',inputHash:'unused'}]};
 // Use the same canonical input hash that the committed request declaration uses.
 receipt.taps[0].inputHash=nativeHash(input);
 assert.equal(nativeOperationEvidence(scenario,receipt,[start]).count,0);
 assert.equal(nativeOperationEvidence(scenario,receipt,[start,{...end,ok:false}]).count,0);
 assert.equal(nativeOperationEvidence(scenario,receipt,[start,{...end,input:{command:'wrong'}}]).count,0);
 assert.equal(nativeOperationEvidence(scenario,receipt,[start,end]).count,1);
});

test('H1 standalone peer returns the requested marker through its provider protocol',()=>{
 const root=mkdtempSync(join(tmpdir(),'gnl-r3-peer-'));
 try{
  const config=join(root,'mcp.json');writeFileSync(config,JSON.stringify({mcpServers:{}}));
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./launchers/workflow-claude.mjs',import.meta.url)),'--input-format','stream-json','--mcp-config',config],{
   input:JSON.stringify({type:'user',message:{content:'[Delegated by the routine] S3_PEER_REPLY'}})+'\n',encoding:'utf8',timeout:5000,env,
  });
  assert.equal(result.status,0,result.stderr);
  const frames=result.stdout.trim().split('\n').map(row=>JSON.parse(row));
  assert.ok(frames.some(f=>f.type==='assistant'&&f.message.content.some(c=>c.type==='text'&&c.text==='S3_PEER_REPLY')));
  assert.ok(frames.some(f=>f.type==='result'&&f.is_error===false));
 }finally{safeWipeSync(root);}
});
