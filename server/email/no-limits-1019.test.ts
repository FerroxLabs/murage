// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, d } from '../decision/fixture.ts';
import { EmailRuntime } from './runtime.ts';
import { FakeFlux } from '../testing/fake-flux-email.ts';
import { forgetAllEmailTurns } from './email-turns.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import type { BotRecord } from '../store.ts';

let root = '', runtime: EmailRuntime | undefined;
afterEach(() => { runtime?.stop(); if(root)removeTempDirSync(root); root=''; forgetAllEmailTurns(); });
async function setup(level: 'unlimited' | 'ask' = 'unlimited', initiator?: Parameters<typeof fixture>[1]) {
  const f=fixture(level, initiator), fake=new FakeFlux();
  let generation='g', offered=true;
  const issue=d.installClaimVerifier(proof=>proof==='trusted'?{threadId:'t',botId:'b',generation}:undefined);
  root=mkdtempSync(join(tmpdir(),'email-nl-1019-'));
  const bot={id:'b',threadId:'t',name:'Fixture'} as BotRecord;
  const authority=()=>({claim:issue('trusted')!,proof:'trusted',identity:{threadId:'t',generation}});
  const appendCard=vi.fn();
  fake.always('GET', /\/capabilities$/, {status:200,body:{enabled:true,available:true}});
  fake.always('GET', /\/approvals$/, {status:200,body:{data:[]}});
  fake.always('POST', /\/messages(?:\/msg\/reply)?$/, {status:200,body:{status:'sent',message_id:'sent'}});
  runtime=new EmailRuntime({authorityFor:authority,offered:()=>offered,accountKey:()=> 'account-fixture',database:()=>f.db,transaction:fn=>fn(),fetch:fake.fetch,
    apiBase:'https://api.flux.test',appBase:'https://app.flux.test',workspaceRoot:()=>root,bot:()=>bot,
    cardHost:{botName:()=> 'Fixture',threadExists:()=>true,card:()=>null,appendCard,patchCard:vi.fn(),outcome:vi.fn(),activity:vi.fn(),notify:vi.fn()}});
  await runtime.start(); runtime.stop();
  runtime.secrets.setBotKey('b',{token:'bot-fixture',keyId:'bot-key'});
  runtime.secrets.setOwner({token:'owner-fixture',keyId:'owner-key'});
  const services=runtime.services()!;
  services.store.insertBinding({botId:'b',inboxId:'ibx',address:'fixture@murage.email',username:'fixture',displayName:'Fixture',emailKeyRef:'bot-key',fluxAccountId:null,state:'active',step:null,opId:null,opStartedAt:null,policy:'ask',failure:null,updatedAt:Date.now()});
  const input={driverKind:'claudeAgent',agentsMcp:true,surfacesForOwner:true,directOwnerAudience:true,origin:'desktop',automationThread:false,bot,threadId:'t'};
  const live={bot:()=>bot,ownerSurface:()=>true,notOwnerAudience:()=>false,ownerThread:()=>true,boundRequest:()=>false};
  const call=(tool:string,body:unknown,generation='g')=>runtime!.call(tool,{botId:'b',threadId:'t',generation},body,live);
  return {f,fake,services,input,live,call,appendCard,off:()=>{offered=false;},setGeneration:(next:string)=>{generation=next;f.setGeneration(next);}};
}
it.each(['webhook','channel','app-event'])('F1 mounts and calls email for verified No limits %s',async source=>{
  const x=await setup('unlimited',source==='channel'?{k:'owner-channel-dm',channel:'slack'}:{k:'webhook'});
  x.fake.always('GET',/\/messages$/, {status:200,body:{data:[]}});
  expect(runtime!.mount('g',{...x.input,origin:undefined,automationSource:source,automationThread:true})).toMatchObject({mounted:true,mode:'send'});
  expect((await x.call('email_list',{})).status).toBe(200);
});
it('F1 live No limits call works without a legacy mount record; stale generations and disabled email do not',async()=>{
  const x=await setup(); x.fake.always('GET',/\/messages$/, {status:200,body:{data:[]}});
  expect((await x.call('email_list',{})).status).toBe(200);
  expect((await x.call('email_list',{},'stale')).status).toBe(403);
  x.f.setOwner(false); expect((await x.call('email_list',{})).status).toBe(403);
});
const message=(patch={})=>({id:'msg',thread_id:'mail-thread',direction:'inbound',from:'sender@example.test',subject:'Private subject',text:'Full message body',preview:'Preview',sender_authenticated:true,injection_scan:{status:'complete',verdict:'clear'},...patch});
it.each([{blocked:true},{sender_authenticated:false},{held_for_owner:true}])('F2 lists, reads and replies without hiding No limits mail %j',async patch=>{
  const x=await setup(); runtime!.mount('g',x.input);
  const mail=message(patch);
  x.fake.always('GET',/\/messages$/, {status:200,body:{data:[mail]}});
  x.fake.always('GET',/\/messages\/msg$/, {status:200,body:mail});
  x.fake.always('GET',/\/threads\/mail-thread$/, {status:200,body:{messages:[mail]}});
  expect((await x.call('email_list',{})).body).toMatchObject({text:expect.stringContaining('Private subject')});
  expect((await x.call('email_read',{message_id:'msg'})).body).toMatchObject({text:expect.stringContaining('Full message body')});
  expect((await x.call('email_read',{thread_id:'mail-thread'})).body).toMatchObject({text:expect.stringContaining('Full message body')});
  expect((await x.call('email_reply',{message_id:'msg',text:'Reply'})).body).toMatchObject({text:expect.stringMatching(/^Sent/)});
  expect(x.appendCard).not.toHaveBeenCalled();expect(d.openApprovals('t')).toEqual([]);
});
it('F3 executes a trust offer RUN without a card and clears the recorded offer',async()=>{
  const x=await setup(), now=Date.now(), address='sender@example.test';
  for(let i=0;i<3;i++)x.services.store.noteOwnerSent('b',address,now-i);
  x.services.store.recordTrustOffer('b',address,'t','Requested trust',now);
  x.fake.always('POST',/\/recipients$/, {status:200,body:{}});
  await x.services.cards!.syncTrustOffers('b');
  expect(x.services.store.isApproved('b',address)).toBe(true);
  expect(x.services.store.pendingTrustOffers('b')).toEqual([]);
  expect(x.fake.calls('POST',/\/recipients$/)).toHaveLength(1);
  expect(x.appendCard).not.toHaveBeenCalled();
  expect(d.openApprovals('t')).toEqual([]);
});
it('F4 sends workspace credentials attachments through the runtime',async()=>{
  const x=await setup(); runtime!.mount('g',x.input);
  mkdirSync(join(root,'credentials'));writeFileSync(join(root,'credentials','report.txt'),'Fixture report');
  expect((await x.call('email_send',{to:['sender@example.test'],subject:'Report',text:'Report',attachments:['credentials/report.txt']})).body).toMatchObject({text:expect.stringMatching(/^Sent/)});
  expect(x.fake.calls('POST',/\/messages$/)).toHaveLength(1);
});
it('F5 permits a new No limits turn to repeat email and keeps retries idempotent',async()=>{
  const x=await setup();runtime!.mount('g',x.input);
  const body={to:['sender@example.test'],subject:'Same email',text:'Same text'};
  expect((await x.call('email_send',body)).body).toMatchObject({text:expect.stringMatching(/^Sent/)});
  expect((await x.call('email_send',body)).body).toMatchObject({text:expect.stringMatching(/^Sent/)});
  x.setGeneration('g2');runtime!.mount('g2',x.input);
  expect((await x.call('email_send',body,'g2')).body).toMatchObject({text:expect.stringMatching(/^Sent/)});
  expect(x.fake.calls('POST',/\/messages$/)).toHaveLength(2);
});

it('F4 registers a memory deliverable through the production artifacts request',async()=>{
  const x=await setup();
  const { artifactsRequest, initializeArtifacts }=await import('../artifacts.ts');
  initializeArtifacts(x.f.db);
  mkdirSync(join(root,'memory'));writeFileSync(join(root,'memory','report.html'),'<h1>Fixture</h1>');
  const access={owner:true,scopes:[{botId:'b',botName:'Fixture',threadId:'t',runId:'g',workspaceRoot:root}]};
  const result=artifactsRequest(x.f.db,join(root,'saved'),{method:'POST',path:'/api/artifacts/register',body:{botId:'b',threadId:'t',relativePath:'memory/report.html'}},access);
  expect(result.status).toBe(201);
});

it.each(['ask','unlimited'] as const)('F1 an entirely switched-off email feature at %s answers one plain line with no provider call',async level=>{
 const x=await setup(level);x.off();const before=x.fake.requests.length;
 expect(runtime!.mount('g',x.input)).toEqual({mounted:false,line:'Email is off. Turn it on in Settings > Bot email.'});
 expect(await x.call('email_send',{to:['sender@example.test'],subject:'Off',text:'Off'})).toEqual({status:200,body:{text:'Email is off. Turn it on in Settings > Bot email.'}});
 expect(x.fake.requests).toHaveLength(before);expect(x.appendCard).not.toHaveBeenCalled();expect(d.openApprovals('t')).toEqual([]);
});
it('F2 below No limits the existing hidden and held-mail filters still apply',async()=>{
 const x=await setup('ask');runtime!.mount('g',x.input);
 x.fake.always('GET',/\/messages\/msg$/, {status:200,body:message({blocked:true})});
 expect((await x.call('email_read',{message_id:'msg'})).body).toMatchObject({isError:true,text:'No emails match.'});
 x.f.setLevel('unlimited');expect((await x.call('email_read',{message_id:'msg'})).body).toMatchObject({text:expect.stringContaining('Full message body')});
 x.f.setLevel('ask');expect((await x.call('email_read',{message_id:'msg'})).body).toMatchObject({isError:true,text:'No emails match.'});
});

it('F3 concurrent trust offers execute once each despite an unrelated old thread offer',async()=>{
 const x=await setup();runtime!.mount('g',x.input);
 x.services.store.recordTrustOffer('b','old@example.test','old-thread','Earlier offer',Date.now());
 x.fake.always('POST',/\/recipients$/, {status:200,body:{}});
 const results=await Promise.all(['first@example.test','second@example.test'].map(address=>x.call('email_trust_offer',{address,reason:'Owner requested trust'})));
 for(const result of results)expect(result.body).toEqual({text:'This address is trusted.'});
 expect(x.services.store.isApproved('b','first@example.test')).toBe(true);expect(x.services.store.isApproved('b','second@example.test')).toBe(true);
 expect(x.fake.calls('POST',/\/recipients$/)).toHaveLength(2);
 expect(x.services.store.pendingTrustOffers('b')).toMatchObject([{address:'old@example.test',threadId:'old-thread'}]);
});

it.each(['ask','unlimited'] as const)('F1 a disconnected email key at %s stays off with a plain settings line',async level=>{
 const x=await setup(level);runtime!.secrets.clearBotKey('b');const before=x.fake.requests.length;
 expect(runtime!.mount('g',x.input)).toEqual({mounted:false,line:'Email is disconnected. Turn it on in Settings > Bot email.'});
 expect(await x.call('email_list',{})).toEqual({status:200,body:{text:'Email is disconnected. Turn it on in Settings > Bot email.'}});
 expect(x.fake.requests).toHaveLength(before);expect(d.openApprovals('t')).toEqual([]);
});

it('F3 an existing offer from an older thread is accepted by the current authorized No limits call',async()=>{
 const x=await setup();runtime!.mount('g',x.input);const address='earlier@example.test';
 x.services.store.recordTrustOffer('b',address,'earlier-thread','Old pending offer',Date.now()-1000);
 x.fake.always('POST',/\/recipients$/, {status:200,body:{}});
 expect((await x.call('email_trust_offer',{address,reason:'Trust this address now'})).body).toEqual({text:'This address is trusted.'});
 expect(x.services.store.isApproved('b',address)).toBe(true);expect(x.services.store.pendingTrustOffers('b')).toEqual([]);
});
it('F3 upgrading to No limits accepts a waiting BASE offer and retires its old approval',async()=>{
 const x=await setup('ask'),address='waiting@example.test',now=Date.now();runtime!.mount('g',x.input);
 for(let i=0;i<3;i++)x.services.store.noteOwnerSent('b',address,now-i);
 x.services.store.recordTrustOffer('b',address,'t','Old BASE offer',now);
 const queue=x.services.send.approvalQueue();
 const dispose=d.installQueueSources([{kind:'email',pendingApprovals:()=>queue.pendingApprovals(),base:queue.base,respond:(item,answer,options)=>queue.respond(item,answer,options),cancel:(item,reason)=>queue.cancel(item,reason),renew:(item,identity)=>queue.renew(item,identity),reopen:item=>({kind:'service',service:'email',claim:x.f.claim,call:item.call})}]);
 try{
  await x.services.cards!.syncTrustOffers('b');expect(queue.pendingApprovals()).toHaveLength(1);
  x.f.setLevel('unlimited');x.fake.always('POST',/\/recipients$/, {status:200,body:{}});
  expect((await x.call('email_trust_offer',{address,reason:'Accept this pending offer now'})).body).toEqual({text:'This address is trusted.'});
  expect(x.services.store.isApproved('b',address)).toBe(true);expect(queue.pendingApprovals()).toEqual([]);expect(d.openApprovals('t')).toEqual([]);
 }finally{dispose();}
});
