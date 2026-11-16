// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import { createHmac, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { beginFlow, callbackFlow, previewFlow, completeFlow, completeResponseSchema } from '../src/flow.ts';
import { HmacRuntimeVerifier, RUNTIME_HEADER, durableEnrollmentStore, canonicalRuntimeMessage } from '../src/runtime-auth.ts';
import { masterSealer, capabilitySealer } from '../src/seal.ts';
import { binding, b64, key, flowFixture, enrollments, signedRequest, storage, fakeCredentials } from './support.ts';
import { leaseRoute, durableGrantStore } from '../src/grant.ts';
import { HIGHLEVEL_CRM_SCOPES } from '../../../server/highlevel/provider-contract.ts';
const beginBody = {...binding,requestId:'begin-request',connectionEpoch:1};
async function begun(f = flowFixture()) {
  const r = await beginFlow(new Request(`${f.d.origin}/v1/crm/begin`,{method:'POST',body:JSON.stringify(beginBody)}),f.d);
  assert.equal(r.status,201); return { f, begin: await r.json() as {flowId:string;authorizationUrl:string;completionCapability:string;expiresAt:number} };
}
async function held() { const x = await begun(); const state = new URL(x.begin.authorizationUrl).searchParams.get('state'); const r = await callbackFlow(new Request(`${x.f.d.origin}/v1/crm/callback?state=${state}&code=fake-code-canary`),x.f.d); assert.equal(r.status,200); return x; }
function completeReq(begin: Awaited<ReturnType<typeof begun>>['begin'], patch = {}) { return new Request('https://connect.murage.ai/v1/crm/complete',{method:'POST',body:JSON.stringify({...binding,flowId:begin.flowId,completionCapability:begin.completionCapability,confirmedLocationId:'location-a',...patch})}); }
function previewReq(begin: Awaited<ReturnType<typeof begun>>['begin'], b = binding, cap = begin.completionCapability) { return new Request('https://connect.murage.ai/v1/crm/complete',{headers:{'x-murage-flow':begin.flowId,'x-murage-completion':cap,'x-murage-binding':b64(JSON.stringify(b))}}); }
test('T-RT-SIG: signature binds exact method, route, body, time and replay', async () => {
  const es = enrollments(); await es.createIfAbsent(binding,key); const v = new HmacRuntimeVerifier(es,() => 1_000_000);
  const valid = signedRequest('/v1/crm/begin','POST',beginBody,1_000_000); assert.deepEqual((await v.verifyRequest(valid.clone(),'/v1/crm/begin'))?.binding,binding);
  assert.equal(await v.verifyRequest(valid.clone(),'/v1/crm/begin'),null);
  for (const field of ['body','route','method','expired','future','binding','signature']) {
    const req = signedRequest('/v1/crm/begin','POST',beginBody,field === 'expired' ? 800_000 : field === 'future' ? 1_040_000 : 1_000_000);
    const headers = new Headers(req.headers);
    if (field === 'binding' || field === 'signature') { const e = JSON.parse(Buffer.from(headers.get(RUNTIME_HEADER)!,'base64url').toString()); e[field === 'binding' ? 'homeId' : 'signature'] = 'tampered'; headers.set(RUNTIME_HEADER,b64(JSON.stringify(e))); }
    const altered = new Request(req.url,{method:field === 'method' ? 'GET':'POST',headers,...(field === 'method' ? {} : {body:field === 'body' ? '{}' : await req.text()})});
    assert.equal(await v.verifyRequest(altered,field === 'route' ? '/v1/crm/lease':'/v1/crm/begin'),null,field);
  }
});
test('T-RT-UNSIGNED-ENROLLED: enrolled principal requires a signature',async () => { const f = flowFixture(); await f.es.createIfAbsent(binding,key);
  const r = await beginFlow(new Request(`${f.d.origin}/v1/crm/begin`,{method:'POST',body:JSON.stringify(beginBody)}),f.d); assert.equal(r.status,401); });
test('T-FLOW-CALLBACK-NO-CLAIM: duplicate callback makes one exchange, no enrollment or grant',async () => { const {f,begin} = await begun(); const url = `${f.d.origin}/v1/crm/callback?state=${new URL(begin.authorizationUrl).searchParams.get('state')}&code=fake-code-canary`;
  const responses = await Promise.all([callbackFlow(new Request(url),f.d),callbackFlow(new Request(url),f.d)]); assert.ok(responses.every(r=>r.status===200)); assert.deepEqual(f.counts(),{exchanges:1,grants:0}); assert.equal(f.es.records.size,0); });
test('T-FLOW-COPIED-STATE: URL state cannot preview or complete',async () => { const {f,begin} = await held(); const state = new URL(begin.authorizationUrl).searchParams.get('state')!;
  assert.equal((await previewFlow(previewReq(begin,binding,state),f.d)).status,404); assert.equal((await completeFlow(completeReq(begin,{completionCapability:state}),f.d)).status,404); assert.equal(f.counts().grants,0); });
test('T-FLOW-BINDING: all four IDs bind capability possession',async () => { const {f,begin} = await held(); for (const id of ['runtimePrincipalId','homeId','installationId','contentOwnerId']) {
  assert.equal((await completeFlow(completeReq(begin,{[id]:'other'}),f.d)).status,404); assert.equal((await previewFlow(previewReq(begin,{...binding,[id]:'other'}),f.d)).status,404); } });
test('T-FLOW-EXPIRY: exact ten-minute boundary erases held material',async () => { const {f,begin} = await held(); f.advance(600_000);
  const r = await completeFlow(completeReq(begin),f.d); assert.equal(r.status,410); assert.deepEqual(await r.json(),{code:'flow_expired'});
  const rec = f.fs.records.get(begin.flowId)!; assert.equal(rec.heldSealed,undefined); assert.equal(rec.recipientPrivateSealed,''); assert.equal(f.counts().grants,0); });
test('T-FLOW-DENIAL: provider denial never exchanges or touches grants',async () => { const {f,begin} = await begun();
  await callbackFlow(new Request(`${f.d.origin}/v1/crm/callback?state=${new URL(begin.authorizationUrl).searchParams.get('state')}&error=access_denied`),f.d);
  assert.deepEqual(f.counts(),{exchanges:0,grants:0}); assert.deepEqual(await (await previewFlow(previewReq(begin),f.d)).json(),{status:'denied'}); });
test('T-FLOW-MISMATCH: wrong Location kills flow without a grant',async () => { const {f,begin} = await held(); const r = await completeFlow(completeReq(begin,{confirmedLocationId:'wrong'}),f.d);
  assert.equal(r.status,409); assert.deepEqual(await r.json(),{code:'location_mismatch'}); assert.equal((await completeFlow(completeReq(begin),f.d)).status,410); assert.equal(f.counts().grants,0); });
test('T-FLOW-REPLAY: complete returns identical sealed result once, even after enrollment',async () => { const {f,begin} = await held();
  const a = await completeFlow(completeReq(begin),f.d); assert.equal(a.status,200); const body = await a.json(); assert.equal(completeResponseSchema.safeParse(body).success,true);
  const b = await completeFlow(completeReq(begin),f.d); assert.equal(b.status,200); assert.deepEqual(await b.json(),body); assert.equal(f.counts().grants,1); assert.equal(f.es.records.size,1);
  assert.equal(JSON.stringify([...f.fs.records.values()]).includes((body as {runtimeCapability:string}).runtimeCapability),false);
});
test('T-FLOW-NOLEAK: errors, logs and durable flow dump exclude secrets',async () => { const captured: unknown[] = []; const old = [console.log,console.warn,console.error]; console.log=console.warn=console.error=(...a)=>{captured.push(a);};
  try { const {f,begin} = await held(); const dump = JSON.stringify([...f.fs.records.values()]); for (const secret of ['fake-access-canary','fake-refresh-canary','fake-code-canary',begin.completionCapability,new URL(begin.authorizationUrl).searchParams.get('state')!]) assert.equal(dump.includes(secret),false);
    const r = await completeFlow(completeReq(begin,{completionCapability:'wrong-cap'}),f.d); assert.deepEqual(await r.json(),{code:'not_found'}); assert.deepEqual(captured,[]);
  } finally { [console.log,console.warn,console.error]=old; } });
test('T-SEAL-AAD: kind, ID, version, capability and master keys authenticate ciphertext',async () => { const s = masterSealer(b64(key)); const cipher = await s.seal('held','flow-a',1,new TextEncoder().encode('private-canary'));
  const opened=await s.open('held','flow-a',1,cipher);assert.ok(opened);assert.equal(new TextDecoder().decode(opened), 'private-canary');
  for (const [kind,id,v] of [['refresh','flow-a',1],['held','flow-b',1],['held','flow-a',2]] as const) assert.equal(await s.open(kind,id,v,cipher),null);
  assert.equal(await capabilitySealer(b64(new Uint8Array(32).fill(9))).open('held','flow-a',1,cipher),null); assert.equal(cipher.includes('private-canary'),false);
});
test('T-ORIGIN: production or explicitly configured HTTPS staging origin only',async () => { const f = flowFixture(); f.d.origin='https://unknown.example';
  assert.equal((await beginFlow(new Request(`${f.d.origin}/v1/crm/begin`,{method:'POST',body:JSON.stringify(beginBody)}),f.d)).status,400);
  f.d.stagingOrigin=f.d.origin; const {begin}=await begun(f); assert.equal(new URL(begin.authorizationUrl).searchParams.get('redirect_uri'),`${f.d.origin}/v1/crm/callback`);
  f.d.origin='https://unknown.example/path'; f.d.stagingOrigin=f.d.origin; assert.equal((await beginFlow(new Request(`${f.d.origin}/v1/crm/begin`,{method:'POST',body:JSON.stringify(beginBody)}),f.d)).status,400);
});
test('T-RT-METHOD: empty body method omission cannot authorize and handlers use verified context',async()=>{
  const es=enrollments();await es.createIfAbsent(binding,key);const v=new HmacRuntimeVerifier(es,()=>1_000_000);
  const get=signedRequest('/v1/crm/complete','GET',null,1_000_000);const post=new Request(get.url,{method:'POST',headers:get.headers,body:''});
  assert.equal(await v.verifyRequest(post,'/v1/crm/complete'),null);
  const f=flowFixture();await f.es.createIfAbsent(binding,key); const valid=signedRequest('/v1/crm/begin','POST',beginBody,f.d.now());
  const altered=new Request(valid.url,{method:'POST',headers:valid.headers,body:JSON.stringify({...beginBody,connectionEpoch:99})});
  assert.equal((await beginFlow(altered,f.d)).status,401);
  const responses=await Promise.all(Array.from({length:8},()=>beginFlow(signedRequest('/v1/crm/begin','POST',beginBody,f.d.now()),f.d)));
  assert.equal(responses.filter(r=>r.status===201).length,3);assert.equal(responses.filter(r=>r.status===429).length,5);
});
test('T-INITIAL-ADMISSION: unsigned desktop identities must be canonical; Cloud is dark',async()=>{
  for(const patch of [{homeId:'victim'},{installationId:'victim'},{contentOwnerId:'bot'}]){
    const f=flowFixture();const r=await beginFlow(new Request(`${f.d.origin}/v1/crm/begin`,{method:'POST',body:JSON.stringify({...beginBody,...patch})}),f.d);assert.equal(r.status,400);
  }
});
test('T-FLOW-CRASH: recover completion after enrollment or grant persistence and concurrent calls',async()=>{
  for(const boundary of ['enrollment','grant','result']){
    const {f,begin}=await held();let failed=false;
    if(boundary==='enrollment'){const orig=f.es.createIfAbsent.bind(f.es);f.es.createIfAbsent=async(b,k)=>{const r=await orig(b,k);if(!failed){failed=true;throw Error('simulated crash');}return r;};}
    if(boundary==='grant'){const orig=f.d.grants.createPending.bind(f.d.grants);f.d.grants.createPending=async i=>{const r=await orig(i);if(!failed){failed=true;throw Error('simulated crash');}return r;};}
    if(boundary==='result'){const orig=f.fs.cas.bind(f.fs);f.fs.cas=async(id,from,next)=>{if(next.status==='completed'&&!failed){failed=true;throw Error('simulated crash');}return orig(id,from,next);};}
    assert.equal((await completeFlow(completeReq(begin),f.d)).status,503);
    const responses=await Promise.all(Array.from({length:5},()=>completeFlow(completeReq(begin),f.d)));
    assert.ok(responses.every(r=>r.status===200),boundary);const bodies=await Promise.all(responses.map(r=>r.json()));assert.ok(bodies.every(b=>JSON.stringify(b)===JSON.stringify(bodies[0])));assert.equal(f.counts().grants,1);
  }
});
test('T-FLOW-PAGES: denied and pending callback pages do not claim a connection',async()=>{
  const {f,begin}=await begun();const r=await callbackFlow(new Request(`${f.d.origin}/v1/crm/callback?state=${new URL(begin.authorizationUrl).searchParams.get('state')}&error=access_denied`),f.d);
  const text=await r.text();assert.match(text,/not connected/u);assert.equal(text.includes('is connected'),false);assert.equal(r.headers.get('cache-control'),'no-store');
});
test('T-FLOW-INSTANCES: persisted records alone suffice for callback and completion',async()=>{
  const {durableFlowStore,sweepFlowStore}=await import('../src/flow.ts');const {durableEnrollmentStore}=await import('../src/runtime-auth.ts');const {storage}=await import('./support.ts');
  const disk=storage(),f=flowFixture();f.d.flows=durableFlowStore(disk.state.storage);f.d.enrollments=durableEnrollmentStore(disk.state.storage,f.d.master,f.d.now);f.d.verifier=new HmacRuntimeVerifier(f.d.enrollments,f.d.now);
  const {begin}=await begun(f);const callbackDeps={...f.d,flows:durableFlowStore(disk.state.storage)};
  assert.equal((await callbackFlow(new Request(`${f.d.origin}/v1/crm/callback?state=${new URL(begin.authorizationUrl).searchParams.get('state')}&code=fake-code-canary`),callbackDeps)).status,200);
  const reopened={...f.d,flows:durableFlowStore(disk.state.storage),enrollments:durableEnrollmentStore(disk.state.storage,f.d.master,f.d.now)};
  const result=await completeFlow(completeReq(begin),reopened);assert.equal(result.status,200);const data=await result.json() as {runtimeCapability:string};
  const dump=JSON.stringify([...disk.control.backing]);for(const secret of ['fake-access-canary','fake-refresh-canary',begin.completionCapability,data.runtimeCapability])assert.equal(dump.includes(secret),false);
  f.advance(600_000);await sweepFlowStore(disk.state.storage,f.d.now());assert.equal(await reopened.flows.byFlowId(begin.flowId),null);
});

test('T-AUTHORIZATION-URL: pins the endpoint and every required code-flow parameter',async()=>{
  const {f,begin}=await begun(),url=new URL(begin.authorizationUrl);
  assert.equal(`${url.origin}${url.pathname}`,'https://marketplace.leadconnectorhq.com/v2/oauth/chooselocation');
  const state=url.searchParams.get('state');assert.match(state!,/^[A-Za-z0-9_-]{64}$/u);
  assert.deepEqual([...url.searchParams].sort(),Object.entries({response_type:'code',client_id:'fake-client',
    redirect_uri:`${f.d.origin}/v1/crm/callback`,scope:HIGHLEVEL_CRM_SCOPES.join(' '),state:state!}).sort());
  assert.equal(url.hash,'');assert.equal(url.username,'');assert.equal(url.password,'');
});
for(const delay of [60_000,120_001])test(`T-RT-DELAYED-BODY: a signed body held for ${delay}ms is refused after reading`,async()=>{
  const f=flowFixture(),disk=storage(),es=durableEnrollmentStore(disk.state.storage,f.d.master,f.d.now);
  await es.createIfAbsent(binding,key);
  let entered!:()=>void;const reading=new Promise<void>(resolve=>{entered=resolve;});
  const get=es.get;es.get=async id=>{const result=await get(id);entered();return result;};
  const v=new HmacRuntimeVerifier(es,f.d.now),signed=signedRequest('/v1/crm/begin','POST',beginBody,f.d.now());
  let body!:ReadableStreamDefaultController<Uint8Array>;
  const stream=new ReadableStream<Uint8Array>({start(c){body=c;}});
  const req=new Request(signed.url,{method:'POST',headers:signed.headers,body:stream,duplex:'half'} as RequestInit);
  const verifying=v.verifyRequest(req,'/v1/crm/begin');await reading;
  f.advance(delay);body.enqueue(new TextEncoder().encode(JSON.stringify(beginBody)));body.close();
  assert.equal(await verifying,null,'expired while awaiting body');
  assert.equal([...disk.control.backing.keys()].some(k=>k.startsWith('rq:')),false);
});
test('T-RT-REPLAY-DEADLINE: expired proposed markers are refused atomically even after an old marker expires',async()=>{
  const f=flowFixture(),disk=storage(),es=durableEnrollmentStore(disk.state.storage,f.d.master,f.d.now);
  const until=f.d.now()+120_000;
  assert.equal(await es.markRequest(binding.runtimePrincipalId,'same-request',until),'fresh');
  f.advance(120_000);
  const before=structuredClone(disk.control.backing);
  assert.deepEqual(await Promise.all([es.markRequest(binding.runtimePrincipalId,'same-request',until),
    es.markRequest(binding.runtimePrincipalId,'same-request',until)]),['replayed','replayed']);
  assert.deepEqual(disk.control.backing,before,'refusal must not write expired markers');
});
test('T-RT-CONCURRENT-REPLAY: exactly one identical signed request is accepted by durable storage',async()=>{
  const f=flowFixture(),disk=storage(),es=durableEnrollmentStore(disk.state.storage,f.d.master,f.d.now);
  await es.createIfAbsent(binding,key);const v=new HmacRuntimeVerifier(es,f.d.now);
  const req=signedRequest('/v1/crm/begin','POST',beginBody,f.d.now());
  const results=await Promise.all([v.verifyRequest(req.clone(),'/v1/crm/begin'),v.verifyRequest(req.clone(),'/v1/crm/begin')]);
  assert.equal(results.filter(Boolean).length,1);assert.equal(results.filter(r=>r===null).length,1);
  f.advance(120_001);assert.equal(await v.verifyRequest(req.clone(),'/v1/crm/begin'),null,'expired marker cannot revive its signed request');
});
test('T-RT-EMPTY-BODY-SUBSTITUTION: empty-body signature cannot authorize substituted valid lease JSON',async()=>{
  const f=flowFixture(),disk=storage(),es=durableEnrollmentStore(disk.state.storage,f.d.master,f.d.now);
  await es.createIfAbsent(binding,key);const grants=durableGrantStore(disk.state,f.d);
  const pending=await grants.createPending({binding,credentials:fakeCredentials,connectionEpoch:1});
  const input={...binding,grantId:pending.grant.grantId,grantVersion:1,connectionEpoch:1};
  const signed=signedRequest('/v1/crm/lease','POST',input,f.d.now(),key,binding,{'x-murage-grant':pending.grantCapability});
  const env=JSON.parse(Buffer.from(signed.headers.get(RUNTIME_HEADER)!,'base64url').toString());
  env.signature=createHmac('sha256',key).update(canonicalRuntimeMessage('/v1/crm/lease','POST',env,createHash('sha256').update('').digest('hex'))).digest('base64url');
  const headers=new Headers(signed.headers);headers.set(RUNTIME_HEADER,b64(JSON.stringify(env)));
  const req=new Request(signed.url,{method:'POST',headers,body:JSON.stringify(input)});
  const r=await leaseRoute(req,{grants,verifier:new HmacRuntimeVerifier(es,f.d.now),origin:f.d.origin});
  assert.equal(r.status,401);assert.deepEqual(await r.json(),{code:'unauthorized'});
});
