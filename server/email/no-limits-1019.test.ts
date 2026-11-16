import { createMemoryEmailRuntime } from "../testing/email-store-fixture.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, linkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, d } from '../decision/fixture.ts';
import { EmailRuntime } from './runtime.ts';
import { FakeFlux, type FakeReply } from '../testing/fake-flux-email.ts';
import { forgetAllEmailTurns } from './email-turns.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import type { BotRecord } from '../store.ts';

let root = '', runtime: EmailRuntime | undefined;
afterEach(() => { runtime?.stop(); if(root)removeTempDirSync(root); root=''; forgetAllEmailTurns(); });
async function setup(level: 'unlimited' | 'ask' = 'unlimited', initiator?: Parameters<typeof fixture>[1], sendReply?: FakeReply) {
  const f=fixture(level, initiator), fake=new FakeFlux();
  let generation='g', offered=true;
  const issue=d.installClaimVerifier(proof=>proof==='trusted'?{threadId:'t',botId:'b',generation}:undefined);
  root=mkdtempSync(join(tmpdir(),'email-nl-1019-'));
  const bot={id:'b',threadId:'t',name:'Fixture'} as BotRecord;
  const authority=()=>({claim:issue('trusted')!,proof:'trusted',identity:{threadId:'t',generation}});
  const appendCard=vi.fn();
  fake.always('GET', /\/capabilities$/, {status:200,body:{enabled:true,available:true}});
  fake.always('GET', /\/approvals$/, {status:200,body:{data:[]}});
  fake.always('POST', /\/messages(?:\/msg\/reply)?$/, sendReply ?? {status:200,body:{status:'sent',message_id:'sent'}});
  runtime=createMemoryEmailRuntime({authorityFor:authority,offered:()=>offered,accountKey:()=> 'account-fixture',database:()=>f.db,transaction:fn=>fn(),fetch:fake.fetch,
    apiBase:'https://api.flux.test',appBase:'https://app.flux.test',workspaceRoot:()=>root,bot:()=>bot,
    cardHost:{botName:()=> 'Fixture',threadExists:()=>true,card:()=>null,appendCard,patchCard:vi.fn(),outcome:vi.fn(),activity:vi.fn(),notify:vi.fn()}});
  await runtime.start(); runtime.stop();
  runtime.secrets.setBotKey('b',{token:'bot-fixture',keyId:'bot-key'});
  runtime.secrets.setOwner({token:'owner-fixture',keyId:'owner-key'});
  const services=runtime.services()!;
  services.store.insertBinding({botId:'b',inboxId:'ibx',address:'fixture@murage.email',username:'fixture',displayName:'Fixture',emailKeyRef:'bot-key',fluxAccountId:null,state:'active',step:null,opId:null,opStartedAt:null,policy:'ask',failure:null,updatedAt:Date.now()});
  fake.always('GET', /\/inboxes\/ibx$/, { status: 200, body: { id: 'ibx', state: 'active' } });
  expect(await services.bindings.proveOwner('b')).toBe('proven');
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

it.each([true,false])('R2 No limits sends a mixed Flux group without waiting for its older unanswered sibling (old first: %s)',async oldFirst=>{
 let sequence=0;
 const x=await setup('unlimited',undefined,()=>{const id=sequence++===0?'old-hold':'new-hold';return {status:202,body:{status:'pending_approval',held_id:id,approval:{id:'mixed',held_ids:id==='old-hold'?['old-hold']:['old-hold','new-hold'],state:'pending'}}};});runtime!.mount('g',x.input);
 const binding=x.services.store.getBinding('b')!;
 x.services.store.casBinding('b',binding.revision,{policy:'auto'},Date.now());
 x.services.store.addTrusted('b','sender@example.test','allow','approval',Date.now());
 x.f.setLevel('ask');runtime!.mount('g',x.input);
 const body={to:['sender@example.test'],subject:'Grouped email',text:'Frozen group text'};
 await x.call('email_send',body);
 const old=x.services.store.sendsInStates(['held'])[0];
 expect(old).toMatchObject({ownerSent:false,receipt:null});
 x.setGeneration('g2');x.f.setLevel('unlimited');runtime!.mount('g2',x.input);
 x.fake.on('GET',/\/approvals\/mixed$/,()=>{
  const rows=x.services.store.sendsInStates(['held']);
  const held=rows.map(row=>({id:row.heldIds[0],state:'held',client_reference:row.sendId,to:body.to,cc:[],subject:body.subject,text:body.text,attachments:[]}));
  held.sort(a=>(a.id==='old-hold'?-1:1)*(oldFirst?1:-1));
  return {status:200,body:{id:'mixed',state:'pending',held_ids:held.map(h=>h.id),held}};
 });
 x.fake.on('POST',/\/approvals\/mixed\/approve$/, {status:200,body:{sends:['old-hold','new-hold'].map(held_id=>({held_id,status:'sent',message_id:held_id+'-sent'}))}});
 expect((await x.call('email_send',body,'g2')).body).toMatchObject({text:expect.stringMatching(/^Sent/)});
 expect(x.fake.calls('POST',/approve$/)[0].body).toMatchObject({held_ids:expect.arrayContaining(['old-hold','new-hold'])});
 expect(x.services.store.getSend(old.sendId)?.state).toBe('sent');
 expect(x.appendCard).not.toHaveBeenCalled();expect(d.openApprovals('t')).toEqual([]);
});

it.each(['ask','unlimited'] as const)('R3 artifact 25 MiB ceiling applies only below No limits: %s',async level=>{
 const x=await setup(level);
 const {artifactsRequest,initializeArtifacts,readArtifact}=await import('../artifacts.ts');initializeArtifacts(x.f.db);
 writeFileSync(join(root,'large.txt'),Buffer.alloc(26*1024*1024,65));
 const access={owner:true,scopes:[{botId:'b',botName:'Fixture',threadId:'t',runId:'g',workspaceRoot:root}]};
 const save=()=>artifactsRequest(x.f.db,join(root,'saved'),{method:'POST',path:'/api/artifacts/register',body:{botId:'b',threadId:'t',relativePath:'large.txt'}},access);
 const result=save();expect(result.status).toBe(level==='unlimited'?201:413);
 if(level==='unlimited'){
  expect(save().status).toBe(201);
  const artifact=(result.body as any).artifact;
  expect(readArtifact(x.f.db,join(root,'saved'),artifact.id,access).bytes).toHaveLength(26*1024*1024);
 }
});

it('M1 No limits duplicate handling uses a bounded same-generation query',async()=>{
 const x=await setup();runtime!.mount('g',x.input);
 const history=vi.spyOn(x.services.store,'sendsByHash');
 const body={to:['sender@example.test'],subject:'Repeated',text:'History-independent'};
 for(let i=0;i<4;i++){
  x.setGeneration('repeat-'+i);runtime!.mount('repeat-'+i,x.input);
  for(let retry=0;retry<2;retry++)expect((await x.call('email_send',body,'repeat-'+i)).body).toMatchObject({text:expect.stringMatching(/^Sent/)});
 }
 expect(x.fake.calls('POST',/\/messages$/)).toHaveLength(4);
 expect(history).not.toHaveBeenCalled();
});

it('M1 trust synchronization reads one offer snapshot and uses targeted freshness checks',async()=>{
 const x=await setup();runtime!.mount('g',x.input);
 for(let i=0;i<20;i++)x.services.store.recordTrustOffer('b',`batch-${i}@example.test`,'t','Batch offer',Date.now()+i);
 const scans=vi.spyOn(x.services.store,'pendingTrustOffers');
 x.fake.always('POST',/\/recipients$/, {status:200,body:{}});
 await x.services.cards!.syncTrustOffers('b');
 expect(x.fake.calls('POST',/\/recipients$/)).toHaveLength(20);
 expect(scans).toHaveBeenCalledTimes(1);
 expect(x.services.store.pendingTrustOffers('b')).toEqual([]);
});

it('M1 a concurrent offer arriving during synchronization is accepted by the shared flight',async()=>{
 const x=await setup();runtime!.mount('g',x.input);
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 let first=true;x.fake.always('POST',/\/recipients$/,async()=>{if(first){first=false;await gate;}return {status:200,body:{}};});
 const a=x.call('email_trust_offer',{address:'flight-a@example.test',reason:'First'});
 await vi.waitFor(()=>expect(x.fake.calls('POST',/\/recipients$/)).toHaveLength(1));
 const b=x.call('email_trust_offer',{address:'flight-b@example.test',reason:'Second'});
 release();
 for(const result of await Promise.all([a,b]))expect(result.body).toEqual({text:'This address is trusted.'});
 expect(x.services.store.pendingTrustOffers('b')).toEqual([]);
});

it.each(['symlink','hardlink'].flatMap(kind=>['owner','webhook','routine'].map(origin=>({kind,origin}))))('H2 sends linked $kind attachments on $origin No limits turns',async({kind,origin})=>{
 const x=await setup('unlimited',origin==='webhook'?{k:'webhook'}:undefined);
 if(origin==='routine')d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>({generation:'g',threadId:'t',botId:'b',principal:'owner',roomOwnerOnly:true,at:1,initiator:{k:'routine-run',form:'run',sourceRunId:'run',sourceBotId:'b',recipientGeneration:'g',trigger:'schedule'}}),live:()=>({botId:'b',turnId:'turn',providerInstanceId:'p',principal:'owner',owner:true,level:'unlimited',routine:{owner:true,sourceRunId:'run',sourceBotId:'b',recipientGeneration:'g'}})});
 runtime!.mount('g',x.input);
 writeFileSync(join(root,'source.txt'),'Linked fixture bytes');
 (kind==='symlink'?symlinkSync:linkSync)(join(root,'source.txt'),join(root,'alias.txt'));
 expect((await x.call('email_send',{to:['sender@example.test'],subject:'Linked attachment',text:'Report',attachments:['alias.txt']})).body).toMatchObject({text:expect.stringMatching(/^Sent/)});
 expect(x.fake.calls('POST',/\/messages$/)).toHaveLength(1);expect(x.appendCard).not.toHaveBeenCalled();expect(d.openApprovals('t')).toEqual([]);
});
it.each(['symlink','hardlink'] as const)('H2 registers a linked %s deliverable only at owner No limits',async kind=>{
 const x=await setup();const {artifactsRequest,initializeArtifacts,readArtifact}=await import('../artifacts.ts');initializeArtifacts(x.f.db);
 writeFileSync(join(root,'source.txt'),'Linked fixture bytes');
 (kind==='symlink'?symlinkSync:linkSync)(join(root,'source.txt'),join(root,'alias.txt'));
 const access={owner:true,scopes:[{botId:'b',botName:'Fixture',threadId:'t',runId:'g',workspaceRoot:root}]};
 const save=()=>artifactsRequest(x.f.db,join(root,'saved'),{method:'POST',path:'/api/artifacts/register',body:{botId:'b',threadId:'t',relativePath:'alias.txt'}},access);
 for(const level of ['ask','auto','full'] as const){x.f.setLevel(level);expect(save().status).toBe(409);}
 x.f.setLevel('unlimited');x.f.setOwner(false);expect(save().status).toBe(409);
 x.f.setOwner(true);const result=save();expect(result.status).toBe(201);
 expect(readArtifact(x.f.db,join(root,'saved'),(result.body as any).artifact.id,access).bytes.toString()).toBe('Linked fixture bytes');
});

it.each(['symlink','hardlink'].flatMap(kind=>['ask','auto','full','guest'].map(level=>({kind,level}))))('H2 $kind email attachments retain their refusal at $level',async({kind,level})=>{
 const x=await setup();x.f.setLevel(level==='guest'?'unlimited':level as 'ask'|'auto'|'full');if(level==='guest')x.f.setOwner(false);
 runtime!.mount('g',x.input);writeFileSync(join(root,'source.txt'),'Linked fixture bytes');
 (kind==='symlink'?symlinkSync:linkSync)(join(root,'source.txt'),join(root,'alias.txt'));
 const result=await x.call('email_send',{to:['sender@example.test'],subject:'Linked attachment',text:'Report',attachments:['alias.txt']});
 expect(result.body).toMatchObject({isError:true,text:kind==='symlink'?'Linked files are not supported.':'Only ordinary files are supported.'});
 expect(x.fake.calls('POST',/\/messages$/)).toHaveLength(0);expect(d.openApprovals('t')).toEqual([]);
});
