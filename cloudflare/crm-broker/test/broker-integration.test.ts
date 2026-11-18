// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {beginFlow,callbackFlow,completeFlow,durableFlowStore} from '../src/flow.ts';
import {durableEnrollmentStore,HmacRuntimeVerifier} from '../src/runtime-auth.ts';
import {durableGrantStore} from '../src/grant.ts';
import {flowFixture,storage,binding,signedRequest} from './support.ts';
import {decode64} from '../src/seal.ts';
import type {z} from 'zod';
import type {completeResponseSchema} from '../src/flow.ts';
test('T-AUTHORITY: disconnect fences pending completion across reopen and removes flow/enrollment custody',async()=>{
 const f=flowFixture(),disk=storage();f.d.flows=durableFlowStore(disk.state.storage);f.d.enrollments=durableEnrollmentStore(disk.state.storage,f.d.master,f.d.now);f.d.verifier=new HmacRuntimeVerifier(f.d.enrollments,f.d.now);
 const grants=durableGrantStore(disk.state,{master:f.d.master,oauth:f.d.oauth,now:f.d.now});f.d.grants=grants;
 async function connect(epoch:number,runtimeKey?:Uint8Array){const beginBody={...binding,requestId:'begin',connectionEpoch:epoch};const req=runtimeKey?signedRequest('/v1/crm/begin','POST',beginBody,f.d.now(),runtimeKey):new Request(`${f.d.origin}/v1/crm/begin`,{method:'POST',body:JSON.stringify(beginBody)});
  const r=await beginFlow(req,f.d);assert.equal(r.status,201);const b=await r.json() as {flowId:string;completionCapability:string;authorizationUrl:string};
  assert.equal((await callbackFlow(new Request(`${f.d.origin}/v1/crm/callback?state=${new URL(b.authorizationUrl).searchParams.get('state')}&code=fake-code-canary`),f.d)).status,200);
  const input={...binding,flowId:b.flowId,completionCapability:b.completionCapability,confirmedLocationId:'location-a'};
  return {b,input,req:()=>runtimeKey?signedRequest('/v1/crm/complete','POST',input,f.d.now(),runtimeKey):new Request(`${f.d.origin}/v1/crm/complete`,{method:'POST',body:JSON.stringify(input)})};
 }
 const a=await connect(1),response=await completeFlow(a.req(),f.d);assert.equal(response.status,200);const result=await response.json() as z.infer<typeof completeResponseSchema>;
 const req={...binding,grantId:result.grant.grantId,grantVersion:1,connectionEpoch:1};assert.ok('accessToken'in await grants.lease(binding,req,result.grantCapability));
 const b=await connect(2,decode64(result.runtimeCapability!));let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),done=new Promise<void>(r=>{release=r;});
 f.d.grants={async createPending(input){enter();await done;return grants.createPending(input);}};
 const completing=completeFlow(b.req(),f.d);await entered;assert.deepEqual(await grants.disconnect(binding,req,result.grantCapability),{revoked:true});release();const late=await completing;assert.notEqual(late.status,200);
 const reopened=durableGrantStore(disk.state,{master:f.d.master,oauth:f.d.oauth,now:f.d.now});assert.deepEqual(await reopened.lease(binding,req,result.grantCapability),{code:'grant_revoked'});
 assert.equal(await f.d.enrollments.get(binding.runtimePrincipalId),null);const dump=JSON.stringify([...disk.control.backing]);assert.equal(dump.includes('refreshSealed'),false);assert.equal(dump.includes('heldSealed'),false);
 assert.equal((await completeFlow(a.req(),f.d)).status,410);
});
test('T-AUTHORITY-CRASH: real durable grant completion resumes after persist-before-result crash',async()=>{
 const f=flowFixture(),disk=storage();
 function reopen(){const enrollments=durableEnrollmentStore(disk.state.storage,f.d.master,f.d.now);const grants=durableGrantStore(disk.state,{master:f.d.master,oauth:f.d.oauth,now:f.d.now});
  return {...f.d,flows:durableFlowStore(disk.state.storage),enrollments,grants,verifier:new HmacRuntimeVerifier(enrollments,f.d.now)};}
 const d=reopen(),began=await beginFlow(new Request(`${d.origin}/v1/crm/begin`,{method:'POST',body:JSON.stringify({...binding,requestId:'begin',connectionEpoch:1})}),d);assert.equal(began.status,201);
 const b=await began.json() as {flowId:string;completionCapability:string;authorizationUrl:string};await callbackFlow(new Request(`${d.origin}/v1/crm/callback?state=${new URL(b.authorizationUrl).searchParams.get('state')}&code=fake-code-canary`),d);
 const input={...binding,flowId:b.flowId,completionCapability:b.completionCapability,confirmedLocationId:'location-a'},request=()=>new Request(`${d.origin}/v1/crm/complete`,{method:'POST',body:JSON.stringify(input)});
 const original=d.grants;d.grants={...original,async createPending(i){await original.createPending(i);throw Error('simulated crash after grant persistence');}};assert.equal((await completeFlow(request(),d)).status,503);
 const out=await Promise.all(Array.from({length:4},()=>completeFlow(request(),reopen())));assert.ok(out.every(r=>r.status===200));const bodies=await Promise.all(out.map(r=>r.json()));assert.ok(bodies.every(b=>JSON.stringify(b)===JSON.stringify(bodies[0])));
 assert.equal([...disk.control.backing.keys()].filter(k=>k.startsWith('grant:')).length,1);assert.equal(JSON.stringify(bodies).includes('fake-refresh-canary'),false);assert.equal(JSON.stringify(bodies).includes('refreshToken'),false);
});
