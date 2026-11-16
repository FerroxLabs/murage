// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// This probe can run unchanged over an exported starting tree. Missing feature
// files are represented as absent, not replaced by refusal implementations.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve(process.env.BROKER_PROBE_ROOT ?? '.');
async function feature(file){const path=resolve(root,`cloudflare/crm-broker/${file}`);return existsSync(path)?import(pathToFileURL(path).href):null;}
const config={clientId:'fake-client',clientSecret:'fake-client-secret',redirectUri:'https://connect.murage.ai/v1/crm/callback'};
const provider={access_token:'fake-access',refresh_token:'fake-refresh',token_type:'Bearer',userType:'Location',locationId:'location-a',userId:'user-a',expires_in:3600,scope:'contacts.readonly'};
test('BASE-1a: code exchange produces provider-proven Location credentials',async()=>{
 const oauth=await feature('src/oauth.ts');let calls=0;
 const result=await oauth?.exchangeOAuth(config,{kind:'code',code:'fake-code'},{now:()=>1_000_000,fetch:async()=>{calls++;return Response.json(provider);}});
 assert.equal(result?.kind,'ok','starting tree must exchange an authorization code');assert.equal(calls,1);assert.deepEqual(result.credentials.scopes,['contacts.readonly']);assert.equal(result.credentials.refreshToken,'fake-refresh');
});
test('BASE-1b: callback holds credentials until capability-bound confirmation',async()=>{
 const flow=await feature('src/flow.ts'),support=await feature('test/support.ts'),f=support?.flowFixture();
 const request=new Request('https://connect.murage.ai/v1/crm/begin',{method:'POST',body:JSON.stringify({...support?.binding,requestId:'begin',connectionEpoch:1})});
 const began=await flow?.beginFlow(request,f.d);assert.equal(began?.status,201,'starting tree must begin an isolated owner flow');
 const b=await began.json();await flow.callbackFlow(new Request(`https://connect.murage.ai/v1/crm/callback?state=${new URL(b.authorizationUrl).searchParams.get('state')}&code=fake-code`),f.d);
 assert.equal(f.counts().grants,0);const complete=await flow.completeFlow(new Request('https://connect.murage.ai/v1/crm/complete',{method:'POST',body:JSON.stringify({...support.binding,flowId:b.flowId,completionCapability:b.completionCapability,confirmedLocationId:'location-a'})}),f.d);
 assert.equal(complete.status,200);assert.equal(f.counts().grants,1);
});
test('BASE-1c: durable grant gives access-only lease and remains revoked after reopen',async()=>{
 const grant=await feature('src/grant.ts'),support=await feature('test/support.ts'),f=support?.flowFixture(),disk=support?.storage();
 const deps=f&&{master:f.d.master,oauth:f.d.oauth,now:f.d.now},store=grant?.durableGrantStore(disk.state,deps);
 const pending=await store?.createPending({binding:support.binding,credentials:support.fakeCredentials,connectionEpoch:1});
 assert.equal(typeof pending?.grant.grantId,'string','starting tree must persist a pending grant');
 const req={...support.binding,grantId:pending.grant.grantId,grantVersion:1,connectionEpoch:1},lease=await store.lease(support.binding,req,pending.grantCapability);
 assert.equal(lease.accessToken,support.fakeCredentials.accessToken);assert.equal(JSON.stringify(lease).includes('refreshToken'),false);
 assert.deepEqual(await store.disconnect(support.binding,req,pending.grantCapability),{revoked:true});
 assert.deepEqual(await grant.durableGrantStore(disk.state,deps).lease(support.binding,req,pending.grantCapability),{code:'grant_revoked'});
});
