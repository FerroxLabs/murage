// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {beginFlow,callbackFlow,completeFlow,durableFlowStore,sweepFlowStore} from '../src/flow.ts';
import {durableEnrollmentStore,HmacRuntimeVerifier} from '../src/runtime-auth.ts';
import {durableGrantStore} from '../src/grant.ts';
import {flowFixture,storage,binding,signedRequest,key,fakeCredentials} from './support.ts';
import {decode64} from '../src/seal.ts';
import type {BrokerStorage,BrokerTxn} from '../src/runtime-auth.ts';
function fixture(){const f=flowFixture(),disk=storage();f.d.flows=durableFlowStore(disk.state.storage);f.d.enrollments=durableEnrollmentStore(disk.state.storage,f.d.master,f.d.now);f.d.verifier=new HmacRuntimeVerifier(f.d.enrollments,f.d.now);
 const grants=durableGrantStore(disk.state,{master:f.d.master,oauth:f.d.oauth,now:f.d.now});f.d.grants=grants;
 return {...f,disk,grants};}
async function ready(f:ReturnType<typeof fixture>,epoch=1,runtimeKey?:Uint8Array){const input={...binding,requestId:'begin',connectionEpoch:epoch};
 const res=await beginFlow(runtimeKey?signedRequest('/v1/crm/begin','POST',input,f.d.now(),runtimeKey):new Request(`${f.d.origin}/v1/crm/begin`,{method:'POST',body:JSON.stringify(input)}),f.d);assert.equal(res.status,201);
 const b=await res.json() as {flowId:string;completionCapability:string;authorizationUrl:string};
 assert.equal((await callbackFlow(new Request(`${f.d.origin}/v1/crm/callback?state=${new URL(b.authorizationUrl).searchParams.get('state')}&code=fake-code`),f.d)).status,200);
 const body={...binding,flowId:b.flowId,completionCapability:b.completionCapability,confirmedLocationId:'location-a'};
 return {b,body,req:(location='location-a')=>runtimeKey?signedRequest('/v1/crm/complete','POST',{...body,confirmedLocationId:location},f.d.now(),runtimeKey):new Request(`${f.d.origin}/v1/crm/complete`,{method:'POST',body:JSON.stringify({...body,confirmedLocationId:location})})};}
function barrier(){let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),done=new Promise<void>(r=>{release=r;});return {entered,release,wait:async()=>{enter();await done;}};}
test('R1: paused initial enrollment cannot resurrect after duplicate completion and disconnect',async()=>{
 const f=fixture(),a=await ready(f),gate=barrier(),original=f.d.enrollments.createIfAbsent;let first=true;
 f.d.enrollments.createIfAbsent=async(...args)=>{if(first){first=false;await gate.wait();}return original(...args);};
 const late=completeFlow(a.req(),f.d);await gate.entered;
 const response=await completeFlow(a.req(),f.d);assert.equal(response.status,200);const result=await response.json();
 assert.deepEqual(await f.grants.disconnect(binding,{...binding,grantId:result.grant.grantId,grantVersion:1,connectionEpoch:1},result.grantCapability),{revoked:true});
 gate.release();assert.notEqual((await late).status,200);
 assert.equal(await durableEnrollmentStore(f.disk.state.storage,f.d.master,f.d.now).get(binding.runtimePrincipalId),null,'late completion must not recreate the deleted enrollment');
});
for(const invalidation of ['deadline','sweep','mismatch'] as const)test(`R2: ${invalidation} during completion cannot replace a newer pending grant`,async()=>{
 const f=fixture(),a=await ready(f),initial=await completeFlow(a.req(),f.d);assert.equal(initial.status,200);const connected=await initial.json(),runtimeKey=decode64(connected.runtimeCapability);
 const b=await ready(f,2,runtimeKey),gate=barrier();f.d.grants={async createPending(input){await gate.wait();return f.grants.createPending(input);}};
 const late=completeFlow(b.req(),f.d);await gate.entered;
 if(invalidation==='mismatch')assert.equal((await completeFlow(b.req('wrong-location'),f.d)).status,409);
 else {f.advance(600_000);if(invalidation==='sweep')await sweepFlowStore(f.disk.state.storage,f.d.now());}
 const newer=await f.grants.createPending({binding,credentials:{...fakeCredentials,expiresAt:f.d.now()+3_600_000},connectionEpoch:2});
 const before=JSON.stringify([...f.disk.control.backing].filter(([k])=>/^(grant:|home:|tomb:|live:|completion:|grantdue:)/u.test(k)).sort());
 gate.release();assert.notEqual((await late).status,200);
 const after=JSON.stringify([...f.disk.control.backing].filter(([k])=>/^(grant:|home:|tomb:|live:|completion:|grantdue:)/u.test(k)).sort());
 assert.equal(after,before,'ineligible completion must commit no grant effects');
 assert.ok('accessToken'in await f.grants.lease(binding,{...binding,grantId:newer.grant.grantId,grantVersion:1,connectionEpoch:2},newer.grantCapability));
});
function measured(base:BrokerStorage){const reads={rows:0,lists:[] as {prefix:string;limit?:number}[]};
 const wrap=(tx:BrokerTxn):BrokerTxn=>({...tx,async list<T>(options:Parameters<BrokerTxn['list']>[0]){reads.lists.push(options);const rows=await tx.list<T>(options);reads.rows+=rows.size;return rows;}});
 return {reads,store:{...wrap(base),transaction:<T>(work:(tx:BrokerTxn)=>Promise<T>)=>base.transaction(tx=>work(wrap(tx)))} as BrokerStorage};}
test('R3-REPLAY: signed verification examines no replay history; cleanup is bounded and resumable',async()=>{
 const f=fixture();await f.d.enrollments.createIfAbsent(binding,key);
 for(let i=0;i<5000;i++)f.disk.control.backing.set(`rq:${binding.runtimePrincipalId}:history-${i}`,f.d.now()+120_000);
 const m=measured(f.disk.state.storage),enroll=durableEnrollmentStore(m.store,f.d.master,f.d.now),verify=new HmacRuntimeVerifier(enroll,f.d.now);
 const req=signedRequest('/v1/crm/begin','POST',{fake:true},f.d.now());assert.deepEqual((await verify.verifyRequest(req,'/v1/crm/begin'))?.binding,binding);
 assert.equal(m.reads.rows,0,'signed requests use direct replay lookup only');assert.equal(await verify.verifyRequest(req,'/v1/crm/begin'),null);
 f.advance(120_000);m.reads.rows=0;await sweepFlowStore(m.store,f.d.now());assert.ok(m.reads.rows<=256,'one cleanup turn has a fixed row budget');
 for(let i=0;i<100;i++)await sweepFlowStore(m.store,f.d.now());
 assert.equal([...f.disk.control.backing.keys()].filter(k=>k.startsWith('rq:')).length,0,'alarm turns resume through legacy replay history');
});
test('R3-DISCONNECT: unrelated flow history does not increase disconnect work',async()=>{
 const f=fixture(),a=await ready(f),response=await completeFlow(a.req(),f.d);assert.equal(response.status,200);const result=await response.json();
 const template=await f.d.flows.byFlowId(a.b.flowId);assert.ok(template);
 for(let i=0;i<5000;i++)f.disk.control.backing.set(`flow:other-${i}`,{...template,flowId:`other-${i}`,binding:{...binding,homeId:`other-${i}`}});
 const m=measured(f.disk.state.storage),grants=durableGrantStore({storage:m.store},{master:f.d.master,oauth:f.d.oauth,now:f.d.now});
 assert.deepEqual(await grants.disconnect(binding,{...binding,grantId:result.grant.grantId,grantVersion:1,connectionEpoch:1},result.grantCapability),{revoked:true});
 assert.ok(m.reads.rows<=66,'disconnect examines bounded home indexes');assert.equal((await f.d.flows.byFlowId(a.b.flowId))?.completedResult,undefined);
});
test('R3-ALARM: grant cleanup bounds examined history and resumes after reopening',async()=>{
 const f=fixture();const p=await f.grants.createPending({binding,credentials:fakeCredentials,connectionEpoch:1});
 const template=f.disk.control.backing.get(`grant:${p.grant.grantId}`) as object;
 // A legacy pending row after retained history has no new due index. Only a
 // persisted backfill cursor can reach it across fresh store instances.
 const legacyId='zzzz-legacy';f.disk.control.backing.set(`grant:${legacyId}`,{...template,grantId:legacyId});
 f.disk.control.backing.set(`home:${binding.homeId}`,{generation:1,epochFloor:1,pendingGrantId:legacyId});
 f.disk.control.backing.delete(`grant:${p.grant.grantId}`);
 for(const k of f.disk.control.backing.keys())if(k.startsWith('grantdue:'))f.disk.control.backing.delete(k);
 for(let i=0;i<5000;i++)f.disk.control.backing.set(`grant:history-${String(i).padStart(5,'0')}`,{...template,grantId:`history-${i}`,state:'revoked'});
 f.advance(30*60_000);const m=measured(f.disk.state.storage),open=()=>durableGrantStore({storage:m.store},{master:f.d.master,oauth:f.d.oauth,now:f.d.now});
 await open().alarm(f.d.now());assert.ok(m.reads.rows<=128,'grant alarms have a fixed examined-row budget');
 for(let i=0;i<85;i++)await open().alarm(f.d.now());
 assert.deepEqual(await open().lease(binding,{...binding,grantId:legacyId,grantVersion:1,connectionEpoch:1},p.grantCapability),{code:'grant_revoked'});
 assert.ok(f.disk.control.backing.has(`tomb:${legacyId}`),'expiry survives fresh store instances');
});

test('R3-HOME-CLEANUP: disconnect fences a long home history and alarms resume erasure',async()=>{
 const f=fixture(),a=await ready(f),response=await completeFlow(a.req(),f.d);assert.equal(response.status,200);const result=await response.json();
 const original=await f.d.flows.byFlowId(a.b.flowId);assert.ok(original);
 for(let i=0;i<150;i++)await f.d.flows.put({...original,flowId:`retained-${i}`,lookupHash:`retained-${i}`});
 const m=measured(f.disk.state.storage),grants=durableGrantStore({storage:m.store},{master:f.d.master,oauth:f.d.oauth,now:f.d.now});
 assert.deepEqual(await grants.disconnect(binding,{...binding,grantId:result.grant.grantId,grantVersion:1,connectionEpoch:1},result.grantCapability),{revoked:true});
 assert.equal(m.reads.rows,64);assert.ok([...f.disk.control.backing.keys()].some(k=>k.startsWith('flowrevoke:')));
 for(let i=0;i<5;i++)await sweepFlowStore(m.store,f.d.now());
 for(const [k,rec]of f.disk.control.backing)if(k.startsWith('flow:')){assert.equal((rec as {completedResult?:string}).completedResult,undefined);assert.equal((rec as {status:string}).status,'expired');}
 assert.equal([...f.disk.control.backing.keys()].filter(k=>k.startsWith('flowrevoke:')).length,0);
});
