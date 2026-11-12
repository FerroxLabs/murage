// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {durableGrantStore,memoryGrantStore} from '../src/grant.ts';
import type {LeaseRequest} from '../src/grant.ts';
import {masterSealer} from '../src/seal.ts';
import {binding,key,b64,fakeCredentials,storage} from './support.ts';
import type {OAuthResult} from '../src/oauth.ts';
function fixture(){let now=1_000_000,refreshes=0;const disk=storage();let result: OAuthResult={kind:'ok',credentials:{...fakeCredentials,expiresAt:now+3_600_000,accessToken:'fake-new-access',refreshToken:'fake-new-refresh'}};
 const deps={master:masterSealer(b64(key)),now:()=>now,oauth:async()=>{refreshes++;return result;}};const store=durableGrantStore(disk.state,deps);
 return {store,deps,disk,advance:(ms:number)=>{now+=ms;},set:(r:OAuthResult)=>{result=r;},count:()=>refreshes};}
async function created(f=fixture(),expiresAt=4_000_000,epoch=1){const p=await f.store.createPending({binding,credentials:{...fakeCredentials,expiresAt},connectionEpoch:epoch});
 const req:LeaseRequest={...binding,grantId:p.grant.grantId,grantVersion:p.grant.grantVersion,connectionEpoch:epoch};return {f,p,req};}
async function active(f=fixture(),expiresAt=4_000_000){const x=await created(f,expiresAt);const r=await f.store.lease(binding,x.req,x.p.grantCapability);assert.ok('accessToken' in r);return x;}
function noRefresh(value:unknown){const text=JSON.stringify(value);for(const needle of ['refreshToken','refresh_token','fake-refresh-canary','fake-new-refresh'])assert.equal(text.includes(needle),false,needle);}
function gated(f:ReturnType<typeof fixture>){let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),done=new Promise<void>(r=>{release=r;});let n=0;
 f.deps.oauth=async()=>{n++;enter();if(n===1)await done;return {kind:'ok',credentials:{...fakeCredentials,accessToken:'fake-new-access',refreshToken:'fake-new-refresh',expiresAt:f.deps.now()+3_600_000}};};return {entered,release,count:()=>n};}
test('G1-CUSTODY: complete/lease/refusal/disconnect contain no refresh and disk is sealed',async()=>{const {f,p,req}=await active();noRefresh(p);noRefresh(await f.store.lease(binding,req,p.grantCapability));noRefresh(await f.store.lease(binding,req,'wrong'));noRefresh(await f.store.disconnect(binding,req,p.grantCapability));
 const dump=JSON.stringify([...f.disk.control.backing]);assert.equal(dump.includes('fake-refresh-canary'),false);assert.equal(dump.includes('fake-access-canary'),false);assert.equal(dump.includes(p.grantCapability),false);
});
test('G6-PERSIST: failed rotation commit returns no lease',async()=>{const {f,p,req}=await active(fixture(),1_180_000);f.advance(70_000);const gate=gated(f);const pending=f.store.lease(binding,req,p.grantCapability);await gate.entered;f.disk.control.fail=true;gate.release();const r=await pending;assert.deepEqual(r,{code:'unavailable'});f.disk.control.fail=false;const reopened=durableGrantStore(f.disk.state,f.deps);assert.deepEqual(await reopened.lease(binding,req,p.grantCapability),{code:'reconnect_required'});});
test('G5-RACE: disconnect wins in-flight refresh CAS; late tokens are dropped',async()=>{const {f,p,req}=await active(fixture(),1_180_000);f.advance(70_000);const gate=gated(f);const pending=f.store.lease(binding,req,p.grantCapability);await gate.entered;
 assert.deepEqual(await f.store.disconnect(binding,req,p.grantCapability),{revoked:true});gate.release();assert.deepEqual(await pending,{code:'grant_revoked'});const dump=JSON.stringify([...f.disk.control.backing]);assert.equal(dump.includes('refreshSealed'),false);assert.equal(dump.includes('accessSealed'),false);
 assert.deepEqual(await f.store.lease(binding,req,p.grantCapability),{code:'grant_revoked'});
});
test('T-SERIAL: ten concurrent expired leases cross one refresh barrier',async()=>{const {f,p,req}=await active(fixture(),1_180_000);f.advance(70_000);const gate=gated(f);
 const pending=Array.from({length:10},()=>f.store.lease(binding,req,p.grantCapability));await gate.entered;await new Promise(r=>setTimeout(r,20));assert.equal(gate.count(),1);gate.release();const out=await Promise.all(pending);assert.ok(out.every(r=>'accessToken'in r));assert.equal(gate.count(),1);
});
test('T-NARROW: actual narrowed scopes advance version and old versions get metadata only',async()=>{const {f,p,req}=await active(fixture(),1_180_000);f.advance(70_000);f.set({kind:'ok',credentials:{...fakeCredentials,scopes:['contacts.readonly'],expiresAt:f.deps.now()+3_600_000}});
 const r=await f.store.lease(binding,req,p.grantCapability);assert.ok('code'in r);assert.equal(r.code,'grant_changed');assert.equal(r.grant?.credentialVersion,2);assert.equal(r.grant?.grantVersion,2);noRefresh(r);assert.equal('accessToken'in r,false);
 const lease=await f.store.lease(binding,{...req,grantVersion:2,connectionEpoch:2},p.grantCapability);assert.ok('accessToken'in lease);assert.deepEqual(lease.scopes,['contacts.readonly']);
});
test('T-ROTATE-ONLY: rotating secrets preserves credentialVersion',async()=>{const {f,p,req}=await active(fixture(),1_180_000);f.advance(70_000);const r=await f.store.lease(binding,req,p.grantCapability);assert.ok('accessToken'in r);assert.equal(r.credentialVersion,1);assert.equal(r.grantVersion,1);assert.equal(r.accessToken,'fake-new-access');assert.equal(f.count(),1);
});
test('T-LOC-DRIFT: refreshed Location changes require reconnect and erase credentials',async()=>{const {f,p,req}=await active(fixture(),1_180_000);f.advance(70_000);f.set({kind:'ok',credentials:{...fakeCredentials,locationId:'wrong-location',expiresAt:f.deps.now()+3_600_000}});
 assert.deepEqual(await f.store.lease(binding,req,p.grantCapability),{code:'reconnect_required'});const text=JSON.stringify([...f.disk.control.backing]);assert.equal(text.includes('refreshSealed'),false);assert.equal(text.includes('accessSealed'),false);
});
test('T-GRANTCAP: wrong capability, request binding or principal receives not_found',async()=>{const {f,p,req}=await active();assert.deepEqual(await f.store.lease(binding,req,'wrong'),{code:'not_found'});
 for(const field of ['runtimePrincipalId','installationId','homeId','contentOwnerId']){assert.deepEqual(await f.store.lease({...binding,[field]:'other'},req,p.grantCapability),{code:'not_found'});assert.deepEqual(await f.store.disconnect(binding,{...req,[field]:'other'},p.grantCapability),{code:'not_found'});}
});
test('T-ACK: old grant remains live until replacement first lease; unacked expires at 30min',async()=>{const {f,p,req}=await active();const second=await created(f,4_000_000,2);
 assert.ok('accessToken'in await f.store.lease(binding,req,p.grantCapability));assert.ok('accessToken'in await f.store.lease(binding,second.req,second.p.grantCapability));assert.deepEqual(await f.store.lease(binding,req,p.grantCapability),{code:'grant_revoked'});
 const third=await created(f,8_000_000,3);f.advance(30*60_000);await f.store.alarm(f.deps.now());assert.deepEqual(await f.store.lease(binding,third.req,third.p.grantCapability),{code:'grant_revoked'});assert.ok('accessToken'in await f.store.lease(binding,second.req,second.p.grantCapability));
});
test('T-RESTART: memory backing survives reopen, revocation and tombstones',async()=>{const f=fixture(),map=new Map<string,unknown>();const s=memoryGrantStore(f.deps,map);const p=await s.createPending({binding,credentials:fakeCredentials,connectionEpoch:1});const req={...binding,grantId:p.grant.grantId,grantVersion:1,connectionEpoch:1};
 const reopened=memoryGrantStore(f.deps,map);assert.ok('accessToken'in await reopened.lease(binding,req,p.grantCapability));await reopened.disconnect(binding,req,p.grantCapability);assert.deepEqual(await memoryGrantStore(f.deps,map).lease(binding,req,p.grantCapability),{code:'grant_revoked'});
});
test('T-EPOCH-FLOOR: connection epochs never go backwards',async()=>{const {f,p,req}=await active();assert.ok('accessToken'in await f.store.lease(binding,{...req,connectionEpoch:5},p.grantCapability));assert.deepEqual(await f.store.lease(binding,{...req,connectionEpoch:4},p.grantCapability),{code:'conflict'});assert.deepEqual(await f.store.disconnect(binding,{...req,connectionEpoch:4},p.grantCapability),{code:'conflict'});});
test('T-HOME-GENERATION: active A and pending B are atomically invalidated by disconnect',async()=>{const {f,p,req}=await active();const b=await created(f,4_000_000,2);assert.deepEqual(await f.store.disconnect(binding,req,p.grantCapability),{revoked:true});assert.deepEqual(await f.store.lease(binding,b.req,b.p.grantCapability),{code:'grant_revoked'});
 const reopen=durableGrantStore(f.disk.state,f.deps);assert.deepEqual(await reopen.lease(binding,b.req,b.p.grantCapability),{code:'grant_revoked'});await assert.rejects(()=>reopen.createPending({binding,credentials:fakeCredentials,connectionEpoch:1,completionId:'stale-flow'}));
});
test('T-REPLACEMENTS: concurrent replacements cannot both activate',async()=>{const {f,p,req}=await active();const out=await Promise.all(Array.from({length:5},()=>created(f,4_000_000,2)));const leases=await Promise.all(out.map(x=>f.store.lease(binding,x.req,x.p.grantCapability)));assert.equal(leases.filter(x=>'accessToken'in x).length,1);assert.deepEqual(await f.store.lease(binding,req,p.grantCapability),{code:'grant_revoked'});});
test('T-ROTATION-CRASH: persisted refresh intent is uncertain after restart, never resent',async()=>{const {f,p,req}=await active(fixture(),1_180_000);f.advance(70_000);const gate=gated(f);const first=f.store.lease(binding,req,p.grantCapability);await gate.entered;
 const reopen=durableGrantStore(f.disk.state,f.deps);assert.deepEqual(await reopen.lease(binding,req,p.grantCapability),{code:'reconnect_required'});assert.equal(gate.count(),1);gate.release();assert.deepEqual(await first,{code:'reconnect_required'});assert.equal(gate.count(),1);
});
test('T-COMPANY-DRIFT: changed, added or missing Company identity fails closed',async()=>{for(const companyId of ['other-company',null]){const f=fixture();const p=await f.store.createPending({binding,credentials:{...fakeCredentials,companyId:'company-a',expiresAt:1_180_000},connectionEpoch:1});const req={...binding,grantId:p.grant.grantId,grantVersion:1,connectionEpoch:1};await f.store.lease(binding,req,p.grantCapability);f.advance(70_000);f.set({kind:'ok',credentials:{...fakeCredentials,companyId,expiresAt:5_000_000}});assert.deepEqual(await f.store.lease(binding,req,p.grantCapability),{code:'reconnect_required'});}});
test('T-LEASE-LIFETIME: home lease max five minutes, provider safety margin retained',async()=>{const {f,p,req}=await created();const r=await f.store.lease(binding,req,p.grantCapability);assert.ok('accessToken'in r);assert.ok(r.expiresAt<=f.deps.now()+300_000);assert.ok(r.expiresAt<=4_000_000-60_000);});
test('T-GRANT-IDEMPOTENCY: completion ID replays exactly one pending grant',async()=>{const f=fixture(),input={binding,credentials:fakeCredentials,connectionEpoch:1,completionId:'flow-a',grantCapability:b64(key)};
 const out=await Promise.all(Array.from({length:5},()=>f.store.createPending(input)));assert.ok(out.every(x=>JSON.stringify(x)===JSON.stringify(out[0])));await f.store.disconnect(binding,{...binding,grantId:out[0].grant.grantId,grantVersion:1,connectionEpoch:1},out[0].grantCapability);await assert.rejects(()=>f.store.createPending(input));});
test('T-ACK-ATOMIC: failed acknowledgement leaves old grant usable',async()=>{const {f,p,req}=await active();const b=await created(f,4_000_000,2);f.disk.control.fail=true;assert.deepEqual(await f.store.lease(binding,b.req,b.p.grantCapability),{code:'unavailable'});f.disk.control.fail=false;assert.ok('accessToken'in await f.store.lease(binding,req,p.grantCapability));});
test('T-IDLE: thirty days without a lease revokes even after restart',async()=>{const {f,p,req}=await active();f.advance(30*86400_000);const reopen=durableGrantStore(f.disk.state,f.deps);await reopen.alarm(f.deps.now());assert.deepEqual(await reopen.lease(binding,req,p.grantCapability),{code:'grant_revoked'});});
test('T-GENERATION-FENCE: stale live rows cannot pass a later home generation',async()=>{
 const {f,p,req}=await active();const home=f.disk.control.backing.get(`home:${binding.homeId}`) as {generation:number};home.generation++;
 assert.deepEqual(await f.store.lease(binding,req,p.grantCapability),{code:'grant_revoked'});
});
test('T-PENDING-ERASURE: disconnect deletes active and pending sealed material and enrollment',async()=>{
 const {f,p,req}=await active();await created(f,4_000_000,2);await f.disk.state.storage.put(`enr:${binding.runtimePrincipalId}`,{fake:'key'});
 assert.deepEqual(await f.store.disconnect(binding,req,p.grantCapability),{revoked:true});const dump=JSON.stringify([...f.disk.control.backing]);assert.equal(dump.includes('refreshSealed'),false);assert.equal(dump.includes('accessSealed'),false);assert.equal(await f.disk.state.storage.get(`enr:${binding.runtimePrincipalId}`),undefined);
});
test('T-FLOW-GENERATION: completion captured before revoke cannot create a new grant',async()=>{
 const {f,p,req}=await active();await f.store.disconnect(binding,req,p.grantCapability);
 await assert.rejects(()=>f.store.createPending({binding,credentials:fakeCredentials,connectionEpoch:2,completionId:'late-flow',homeGeneration:1}));
});
