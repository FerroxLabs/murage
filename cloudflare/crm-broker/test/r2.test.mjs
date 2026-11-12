// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as gm from '../src/grant.ts';
import {beginFlow,callbackFlow,previewFlow,completeFlow,durableFlowStore,sweepFlowStore} from '../src/flow.ts';
import {HmacRuntimeVerifier,durableEnrollmentStore} from '../src/runtime-auth.ts';
import {openHeld,masterSealer,decode64} from '../src/seal.ts';
import {binding,key,b64,fakeCredentials,flowFixture,storage,signedRequest} from './support.ts';
const origin='https://connect.murage.ai',beginBody={...binding,requestId:'r2-begin',connectionEpoch:1};
async function routes(){const path='../src/route.ts';const m=await import(path).catch(()=>null);assert.ok(m,'home routing module must exist');return m;}
async function route(name,req,d){assert.equal(typeof gm[name],'function',`${name} must be seat-owned`);return gm[name](req,d);}
function fixture(){const f=flowFixture(),disk=storage();Object.assign(f.d,{flows:durableFlowStore(disk.state.storage),enrollments:durableEnrollmentStore(disk.state.storage,f.d.master,f.d.now),routeMaster:key,ipAdmission:async()=>true});f.d.verifier=new HmacRuntimeVerifier(f.d.enrollments,f.d.now);const grants=gm.durableGrantStore(disk.state,f.d);f.d.grants=grants;return {...f,disk,grants};}
async function pending(f=fixture()){await f.d.enrollments.createIfAbsent(binding,key);const p=await f.grants.createPending({binding,credentials:{...fakeCredentials,expiresAt:f.d.now()+3_600_000},connectionEpoch:1});const input={...binding,grantId:p.grant.grantId,grantVersion:1,connectionEpoch:1};return {f,p,input,d:{grants:f.grants,verifier:f.d.verifier,origin},req:(path='/v1/crm/lease',patch={},cap=p.grantCapability)=>signedRequest(path,'POST',{...input,...patch},f.d.now(),key,binding,{'x-murage-grant':cap})};}
async function begun(f=fixture(),body=beginBody){const r=await beginFlow(await f.d.enrollments.get(body.runtimePrincipalId)?signedRequest('/v1/crm/begin','POST',body,f.d.now()):new Request(`${origin}/v1/crm/begin`,{method:'POST',body:JSON.stringify(body)}),f.d);assert.equal(r.status,201);return {f,b:await r.json()};}
const callback=(b)=>new Request(`${origin}/v1/crm/callback?state=${new URL(b.authorizationUrl).searchParams.get('state')}&code=fake-code`);
const confirm=(b)=>new Request(`${origin}/v1/crm/complete`,{method:'POST',body:JSON.stringify({...binding,flowId:b.flowId,completionCapability:b.completionCapability,confirmedLocationId:'location-a'})});
const preview=(b)=>new Request(`${origin}/v1/crm/complete`,{headers:{'x-murage-flow':b.flowId,'x-murage-completion':b.completionCapability,'x-murage-binding':b64(JSON.stringify(binding))}});
function changing(req,other){let reads=0;const first=req.clone.bind(req);req.clone=()=>{reads++;return reads===1?first():new Request(req.url,{method:'POST',headers:req.headers,body:JSON.stringify(other)});};return req;}
function barrier(){let enter,release;const entered=new Promise(r=>{enter=r;}),done=new Promise(r=>{release=r;});return {entered,release,wait:async()=>{enter();await done;}};}
function closed(r){assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('referrer-policy'),'no-referrer');}
test('T-RT-LEASE-ROUTE: authenticated request path binds body method route time and replay',async()=>{
 const x=await pending();
 for(const kind of ['body','method','route','expired','skew']){let req=x.req();if(kind==='body')req=new Request(req.url,{method:'POST',headers:req.headers,body:JSON.stringify({...x.input,connectionEpoch:2})});
 if(kind==='method')req=new Request(req.url,{headers:req.headers});if(kind==='route')req=new Request(`${origin}/v1/crm/disconnect`,{method:'POST',headers:req.headers,body:JSON.stringify(x.input)});
 if(kind==='expired'||kind==='skew')req=signedRequest('/v1/crm/lease','POST',x.input,x.f.d.now()+(kind==='expired'?-120_000:40_000),key,binding,{'x-murage-grant':x.p.grantCapability});
 const r=await route('leaseRoute',req,x.d);assert.equal(r.status,401,kind);closed(r);}
 const one=x.req(),all=await Promise.all(Array.from({length:10},()=>route('leaseRoute',one.clone(),x.d)));assert.equal(all.filter(r=>r.status===200).length,1);assert.equal(all.filter(r=>r.status===401).length,9);
});
test('T-RT-VERIFIED-BYTES: adapter returns binding and exactly hashed bytes; handlers never reread',async()=>{
 const x=await pending(),raw=x.req(),verified=await x.f.d.verifier.verifyRequest(raw,'/v1/crm/lease');assert.deepEqual(verified?.binding,binding);assert.deepEqual(JSON.parse(new TextDecoder().decode(verified.body)),x.input);
 const r=await route('leaseRoute',changing(x.req(),{...x.input,connectionEpoch:99}),x.d);assert.equal(r.status,200);assert.equal((await r.json()).connectionEpoch,1);
 const f=fixture();await f.d.enrollments.createIfAbsent(binding,key);const req=changing(signedRequest('/v1/crm/begin','POST',beginBody,f.d.now()),{...beginBody,connectionEpoch:99});const started=await beginFlow(req,f.d);assert.equal(started.status,201);const start=await started.json();
 const row=[...f.disk.control.backing].find(([k])=>k.startsWith('flow:'))[1];assert.equal(row.beginEpoch,1);
 await callbackFlow(callback(start),f.d);
 const input={...binding,flowId:start.flowId,completionCapability:start.completionCapability,confirmedLocationId:'location-a'};
 assert.equal((await completeFlow(changing(signedRequest('/v1/crm/complete','POST',input,f.d.now()),{...input,confirmedLocationId:'wrong'}),f.d)).status,200);
 const y=await pending(),dis=await route('disconnectRoute',changing(y.req('/v1/crm/disconnect'),{...y.input,connectionEpoch:99}),y.d);assert.equal(dis.status,200);assert.equal(y.f.disk.control.backing.get('home:home-a').epochFloor,2);
});
test('T-GRANT-HEADER-ROUTE: absent malformed other and unknown capabilities have one refusal',async()=>{
 const x=await pending(),other=await pending();for(const cap of ['', 'bad',other.p.grantCapability]){const req=x.req('/v1/crm/lease',{},cap);if(!cap)req.headers.delete('x-murage-grant');const r=await route('leaseRoute',req,x.d);assert.equal(r.status,404);assert.deepEqual(await r.json(),{code:'not_found'});closed(r);}
 const r=await route('leaseRoute',x.req('/v1/crm/lease',{grantId:'unknown'}),x.d);assert.equal(r.status,404);
 const changed=await route('leaseRoute',x.req('/v1/crm/lease',{contentOwnerId:'bot'}),x.d);assert.equal(changed.status,404);
});
test('T-DISCONNECT-ROUTE / T-ACK-AFTER-DISCONNECT: signed disconnect fences active pending and enrollment',async()=>{
 const x=await pending();assert.equal((await route('leaseRoute',x.req(),x.d)).status,200);const b=await x.f.grants.createPending({binding,credentials:fakeCredentials,connectionEpoch:1});
 assert.equal((await route('disconnectRoute',x.req('/v1/crm/disconnect',{},'wrong'),x.d)).status,404);
 const r=await route('disconnectRoute',x.req('/v1/crm/disconnect'),x.d);assert.equal(r.status,200);closed(r);assert.equal(await x.f.d.enrollments.get(binding.runtimePrincipalId),null);
 assert.deepEqual(await x.f.grants.lease(binding,{...x.input,grantId:b.grant.grantId},b.grantCapability),{code:'grant_revoked'});assert.deepEqual(await x.f.grants.lease(binding,x.input,x.p.grantCapability),{code:'grant_revoked'});
});
test('T-HOME-ROUTE: opaque deterministic per-home tag routes callback; flipped tag misses; routing is no auth',async()=>{
 const m=await routes(),a=await begun(),b=await begun(fixture(),{...beginBody,homeId:'home-b',installationId:'home-b',runtimePrincipalId:'home-b'});
 const state=new URL(a.b.authorizationUrl).searchParams.get('state');assert.equal(state.length,64);assert.equal(m.callbackRouteTag(state),await m.homeRouteTag(key,'home-a'));assert.notEqual(await m.homeRouteTag(key,'home-a'),await m.homeRouteTag(key,'home-b'));assert.match(await m.homeRouteTag(key,'home-a'),/^[a-f0-9]{32}$/u);assert.equal(m.callbackRouteTag('bad'),null);
 const changed=decode64(state);changed[0]^=1;assert.equal((await callbackFlow(new Request(`${origin}/v1/crm/callback?state=${b64(changed)}&code=fake`),b.f.d)).status,404);
 assert.equal((await callbackFlow(callback(a.b),a.f.d)).status,200);assert.equal((await callbackFlow(callback(a.b),b.f.d)).status,404);
 assert.equal(JSON.stringify([...a.f.disk.control.backing]).includes('home-b'),false);
 assert.equal(await m.routeHomeId(signedRequest('/v1/crm/lease','POST',{},a.f.d.now())),'home-a');assert.equal(await m.routeHomeId(preview(a.b)),'home-a');assert.equal(await m.routeHomeId(new Request(`${origin}/v1/crm/begin`,{method:'POST',body:JSON.stringify(beginBody)})),'home-a');assert.equal(await m.routeHomeId(new Request(origin,{method:'POST',body:'x'.repeat(32769)})),null);
});
test('T-IP-ADMISSION: unsigned hook mandatory and fail closed; signed bypasses global hook',async()=>{
 for(const hook of [undefined,async()=>{throw Error('fake');},async()=>false]){const f=fixture();f.d.ipAdmission=hook;const r=await beginFlow(new Request(`${origin}/v1/crm/begin`,{method:'POST',body:JSON.stringify(beginBody)}),f.d);assert.equal(r.status,429);assert.equal([...f.disk.control.backing.keys()].filter(k=>k.startsWith('flow:')).length,0);}
 const f=fixture();let calls=0;f.d.ipAdmission=async()=>{calls++;throw Error('must not run');};await f.d.enrollments.createIfAbsent(binding,key);assert.equal((await beginFlow(signedRequest('/v1/crm/begin','POST',beginBody,f.d.now()),f.d)).status,201);assert.equal(calls,0);assert.equal([...f.disk.control.backing.keys()].some(k=>k.startsWith('ip:')),false);
});
test('T-ONE-INSTANCE: authority is built once and serial chain spans provider await for ten route leases',async()=>{
 const m=await routes(),f=fixture(),gate=barrier();let refreshes=0;const deps={...f.d,oauth:async()=>{refreshes++;await gate.wait();return {kind:'ok',credentials:{...fakeCredentials,expiresAt:f.d.now()+3_600_000}};}};
 const a=m.homeAuthority(f.disk.state.storage,deps);assert.equal(m.homeAuthority(f.disk.state.storage,deps),a);await a.enrollments.createIfAbsent(binding,key);const p=await a.grants.createPending({binding,credentials:{...fakeCredentials,expiresAt:f.d.now()+1000},connectionEpoch:1}),input={...binding,grantId:p.grant.grantId,grantVersion:1,connectionEpoch:1};
 const all=Promise.all(Array.from({length:10},()=>route('leaseRoute',signedRequest('/v1/crm/lease','POST',input,f.d.now(),key,binding,{'x-murage-grant':p.grantCapability}),{...a,origin})));await gate.entered;gate.release();const results=await all;assert.equal(refreshes,1);assert.ok(results.every(r=>r.status===200));
});
test('T-HOME-BOUNDED: 1000 other homes cannot add rows to this authority alarm sweep or disconnect',async()=>{
 const m=await routes(),other=new Map();for(let i=0;i<1000;i++)other.set(`home-${i}`,storage(new Map([[`grant:other-${i}`,{canary:true}],[`flow:other-${i}`,{canary:true}]])));
 const f=fixture(),base=f.disk.state.storage,seen=[];const wrap=tx=>({...tx,list:async o=>{const rows=await tx.list(o);seen.push({o,rows:[...rows.keys()]});return rows;}});const measured={...wrap(base),transaction:fn=>base.transaction(tx=>fn(wrap(tx)))};
 const a=m.homeAuthority(measured,f.d);await a.enrollments.createIfAbsent(binding,key);const p=await a.grants.createPending({binding,credentials:fakeCredentials,connectionEpoch:1});await a.grants.disconnect(binding,{...binding,grantId:p.grant.grantId,grantVersion:1,connectionEpoch:1},p.grantCapability);await a.grants.alarm(f.d.now());await sweepFlowStore(measured,f.d.now());assert.ok(seen.every(x=>x.o.limit<=64));assert.ok(seen.flatMap(x=>x.rows).every(k=>!k.includes('other-')));assert.ok(seen.reduce((n,x)=>n+x.rows.length,0)<10);assert.equal(other.size,1000);
});
test('T-HELD-DUMP: backing dump and master key reveal neither credentials location name nor scopes',async()=>{
 const f=fixture();f.d.oauth=async()=>({kind:'ok',credentials:{...fakeCredentials,scopes:['contacts.readonly','locations.readonly']}});f.d.locationFetch=async()=>Response.json({location:{name:'Private Location Canary'}});const x=await begun(f);assert.equal((await callbackFlow(callback(x.b),f.d)).status,200);
 const dump=JSON.stringify([...f.disk.control.backing]);for(const value of ['fake-access-canary','fake-refresh-canary','Private Location Canary','contacts.readonly','locations.readonly'])assert.equal(dump.includes(value),false,value);
 const rec=await f.d.flows.byFlowId(x.b.flowId);assert.equal(rec.heldPreview,undefined);assert.equal(await masterSealer(b64(key)).open('held',rec.flowId,1,rec.heldSealed),null);assert.equal(await masterSealer(b64(key)).open('held',rec.flowId,1,rec.recipientPrivateSealed),null);assert.ok(await openHeld(x.b.completionCapability,rec.flowId,rec.recipientPrivateSealed,rec.heldSealed));
 const r=await previewFlow(preview(x.b),f.d);assert.equal(r.status,200);assert.equal((await r.json()).locationName,'Private Location Canary');
});
test('T-LOCATION-NAME: one bounded scope admitted lookup; errors and missing scope fall back to ID',async()=>{
 for(const kind of ['ok','error','noscope','oversize','invalid']){const f=fixture();let calls=0;f.d.oauth=async()=>({kind:'ok',credentials:{...fakeCredentials,scopes:kind==='noscope'?['contacts.readonly']:['locations.readonly']}});f.d.locationFetch=async(url,init)=>{calls++;assert.equal(url,'https://services.leadconnectorhq.com/locations/location-a');assert.equal(init.headers.Version,'2021-07-28');assert.equal(init.redirect,'error');assert.ok(init.signal);if(kind==='error')throw Error('fake');if(kind==='oversize')return Response.json({location:{name:'Oversize Name'},padding:'x'.repeat(65536)});return Response.json({location:{name:kind==='invalid'?'':'Private\u0000 Name'}});};const x=await begun(f);await callbackFlow(callback(x.b),f.d);const p=await (await previewFlow(preview(x.b),f.d)).json();assert.equal(p.locationName,kind==='ok'?'Private Name':'location-a',kind);assert.equal(calls,kind==='noscope'?0:1);}
});
test('T-CALLBACK-CRASH: reserved exchange without held write stays pending and is never resent',async()=>{
 const x=await begun(),orig=x.f.d.flows.cas;let crash=true;x.f.d.flows.cas=async(...args)=>{if(args[2].heldSealed&&crash){crash=false;throw Error('crash after provider');}return orig(...args);};assert.equal((await callbackFlow(callback(x.b),x.f.d)).status,503);assert.deepEqual(await (await previewFlow(preview(x.b),x.f.d)).json(),{status:'pending'});const c=await completeFlow(confirm(x.b),x.f.d);assert.deepEqual(await c.json(),{code:'flow_pending'});await callbackFlow(callback(x.b),x.f.d);assert.equal(x.f.counts().exchanges,1);x.f.advance(600_000);await sweepFlowStore(x.f.disk.state.storage,x.f.d.now());assert.equal(await x.f.d.flows.byFlowId(x.b.flowId),null);
});
test('T-DISCONNECT-DURING-COMPLETE: intent reservation then disconnect cannot leave held material or grant',async()=>{
 const x=await pending(),b=await begun(x.f);await callbackFlow(callback(b.b),x.f.d);const gate=barrier(),orig=x.f.d.grants.createPending;x.f.d.grants.createPending=async i=>{await gate.wait();return orig(i);};const late=completeFlow(signedRequest('/v1/crm/complete','POST',{...binding,flowId:b.b.flowId,completionCapability:b.b.completionCapability,confirmedLocationId:'location-a'},x.f.d.now()),x.f.d);await gate.entered;assert.equal((await route('disconnectRoute',x.req('/v1/crm/disconnect'),x.d)).status,200);gate.release();assert.notEqual((await late).status,200);const row=await x.f.d.flows.byFlowId(b.b.flowId);assert.equal(row.heldSealed,undefined);assert.equal(row.status,'expired');
});
test('T-EXPIRED-HTML: callback unknown and expired state show localized plain recovery page',async()=>{
 const x=await begun();x.f.advance(600_000);for(const req of [callback(x.b),new Request(`${origin}/v1/crm/callback?state=${b64(new Uint8Array(48))}&code=x`),new Request(`${origin}/v1/crm/callback?state=bad`)]){const r=await callbackFlow(req,x.f.d);assert.ok([404,410].includes(r.status));assert.match(r.headers.get('content-type'),/text\/html/u);assert.match(await r.text(),/This link has expired\. Go back to Murage and connect again\./u);closed(r);}
});
test('T-HANDLER-ADMISSION: binding and capability admission occurs before even a permissive store',async()=>{
 const x=await pending();let called=0;const grants={lease:async()=>{called++;return {ok:true};},disconnect:async()=>{called++;return {revoked:true};}};const d={...x.d,grants};
 for(const name of ['leaseRoute','disconnectRoute']){const path=name==='leaseRoute'?'/v1/crm/lease':'/v1/crm/disconnect';for(const [patch,cap] of [[{homeId:'other'},x.p.grantCapability],[{},'bad'],[{},'']]){const r=await route(name,x.req(path,patch,cap),d);assert.equal(r.status,404);assert.deepEqual(await r.json(),{code:'not_found'});}}
 assert.equal(called,0);
});
test('T-LOCATION-DEADLINE: location read cannot restore custody after expiry or disconnect',async()=>{
 for(const why of ['expiry','disconnect']){const x=await pending();x.f.d.oauth=async()=>({kind:'ok',credentials:{...fakeCredentials,scopes:['locations.readonly']}});x.f.d.locationFetch=async()=>{if(why==='expiry')x.f.advance(600_000);else await x.f.grants.disconnect(binding,x.input,x.p.grantCapability);return Response.json({location:{name:'Late Name'}});};const b=await begun(x.f);const r=await callbackFlow(callback(b.b),x.f.d);assert.equal(r.status,410,why);const row=await x.f.d.flows.byFlowId(b.b.flowId);assert.equal(row.heldSealed,undefined);assert.equal(row.status,'expired');}
});
test('T-LOCATION-TIMEOUT: ignoring AbortSignal cannot extend the fixed ten-second bound',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),gate=barrier();let signal;f.d.oauth=async()=>({kind:'ok',credentials:{...fakeCredentials,scopes:['locations.readonly']}});f.d.locationFetch=async(_url,init)=>{signal=init.signal;await gate.wait();return Response.json({location:{name:'Too Late'}});};const x=await begun(f),running=callbackFlow(callback(x.b),f.d);await gate.entered;t.mock.timers.tick(10_000);assert.equal(signal.aborted,true);const r=await running;assert.equal(r.status,200);assert.equal((await (await previewFlow(preview(x.b),f.d)).json()).locationName,'location-a');gate.release();
});
