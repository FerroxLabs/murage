// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, d } from '../decision/fixture.ts';
import { PublishOperations } from './publish-ops.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
let root='';
afterEach(()=>{if(root)removeTempDirSync(root);root='';});
function setup(connected = true, level: 'ask' | 'unlimited' = 'unlimited') {
 const f=fixture(level);root=mkdtempSync(join(tmpdir(),'publish-nl-1019-'));
 for(const dir of ['site','credentials']) {mkdirSync(join(root,dir));writeFileSync(join(root,dir,'index.html'),'<title>Fixture site</title>');mkdirSync(join(root,dir,'.well-known'));writeFileSync(join(root,dir,'.well-known','proof.txt'),'fixture proof');}
 const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200});
 const fetchImpl=vi.fn<typeof fetch>(async(url,init)=>{
  const path=new URL(String(url)).pathname;
  if(String(url).startsWith('https://fixture.netlify.app'))return new Response('<title>Fixture site</title>',{status:200});
  if(path.endsWith('/deploys'))return json({id:'deploy-1',site_id:'site-1',ssl_url:'https://fixture.netlify.app'});
  if(path.endsWith('/sites')&&init?.method==='POST')return json({id:'site-1',ssl_url:'https://fixture.netlify.app'});
  if(init?.method==='DELETE')return new Response(null,{status:204});
  return json({id:'site-1',ssl_url:'https://fixture.netlify.app'});
 });
 const authority={claim:f.claim,proof:'trusted',identity:{threadId:'t',generation:'g'}};
 const actor={botId:'b',threadId:'t',generation:'g',signal:new AbortController().signal,assertActive:()=>{},authority};
 const waiting=vi.fn(), operations=new PublishOperations({store:f.store,waiting,token:()=> connected ? 'fixture-only' : undefined,workspaceFor:()=>root,fetchImpl,sleep:async()=>{}});
 return {f,operations,actor,fetchImpl,waiting};
}
it('F7 updates an owner-connected site without a bot site grant and publishes protected names',async()=>{
 const x=setup();
 const result=await x.operations.publish(x.actor,{siteId:'site-1',folder:'site'});
 expect(result).toMatchObject({status:'live',fileCount:2});expect(result.skipped).toBeUndefined();
 const upload=x.fetchImpl.mock.calls.find(([,init])=>init?.method==='POST'&&init?.body instanceof Uint8Array);
 expect(upload).toBeDefined();expect(Buffer.from(upload![1]!.body as Uint8Array).includes(Buffer.from('.well-known/proof.txt'))).toBe(true);
 expect(d.openApprovals('t')).toEqual([]);expect(x.waiting.mock.calls.some(call=>call[1]===true)).toBe(false);
});
it('F7 publishes a protected folder and takes down an unassigned owner site',async()=>{
 const x=setup();expect(await x.operations.publish(x.actor,{name:'fixture',folder:'credentials'})).toMatchObject({status:'live',fileCount:2});
 expect(await x.operations.takeDown(x.actor,{siteId:'site-1'})).toMatchObject({status:'taken-down'});
 expect(x.fetchImpl.mock.calls.some(([,init])=>init?.method==='DELETE')).toBe(true);
});

it('F7 No limits publishes past the local small-site file ceiling',async()=>{
 const x=setup();for(let i=0;i<500;i++)writeFileSync(join(root,'site',`fixture-${i}.txt`),'fixture');
 expect(await x.operations.publish(x.actor,{name:'fixture',folder:'site'})).toMatchObject({status:'live',fileCount:502});
});

it.each(['ask','unlimited'] as const)('F7 disconnected Netlify stays off at %s with one plain line and no card or provider call',async level=>{
 const x=setup(false,level),line='Netlify is off. Turn it on in Settings > Connections > Connected tools.';
 await expect(x.operations.publish(x.actor,{name:'fixture',folder:'site'})).rejects.toMatchObject({code:'reconnect',message:line});
 expect(x.fetchImpl).not.toHaveBeenCalled();expect(d.openApprovals('t')).toEqual([]);
 expect(x.f.store.messagesFor('t').map(message=>message.text)).toEqual([line]);
});

it.each(['ask','unlimited'] as const)('F7 rejected Netlify credentials at %s give a plain off line without a new card',async level=>{
 const x=setup(true,level),line='Netlify is off. Turn it on in Settings > Connections > Connected tools.';
 if(level==='ask'){const bot=x.f.store.createBot({name:'Connected site fixture'},{seedMessages:false});x.f.store.patchBot(bot.id,{publishedSites:[{siteId:'site-1',name:'fixture',url:'https://fixture.netlify.app',lastPublishedAt:1,lastFileCount:1,origin:'created'}]});x.actor.botId=bot.id;}
 x.fetchImpl.mockResolvedValueOnce(new Response('{}',{status:401}));
 await expect(x.operations.publish(x.actor,{siteId:'site-1',folder:'site'})).rejects.toMatchObject({code:'reconnect',message:line});
 expect(x.fetchImpl).toHaveBeenCalledTimes(1);expect(d.openApprovals('t')).toEqual([]);
 expect(x.f.store.messagesFor('t').map(message=>message.text)).toEqual([line]);
});

it('F7 preserves every valid No limits site record through Store and publishing reads',()=>{
 const x=setup(),bot=x.f.store.createBot({name:'Site registry fixture'},{seedMessages:false});
 const sites=Array.from({length:201},(_,index)=>({siteId:`site-${index}`,name:`fixture-${index}`,url:`https://fixture-${index}.netlify.app`,lastPublishedAt:1,lastFileCount:1,origin:'created' as const}));
 x.f.store.patchBot(bot.id,{autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true,publishedSites:sites});
 expect(x.f.store.bot(bot.id)?.publishedSites).toHaveLength(201);
 expect(x.operations.sitesFor(bot.id)).toEqual(sites);
});

it('F7 concurrent authorized No limits publishes both run without a busy refusal or owner wait', async () => {
 const x = setup();
 const results = await Promise.allSettled(['first', 'second'].map(name => x.operations.publish(x.actor, { name, folder: 'site' })));
 for (const result of results) {
  expect(result.status).toBe('fulfilled');
  if (result.status === 'fulfilled') expect(result.value.status).toBe('live');
 }
 expect(x.fetchImpl.mock.calls.filter(([url, init]) => String(url).endsWith('/deploys') && init?.method === 'POST')).toHaveLength(2);
 expect(d.openApprovals('t')).toEqual([]);
 expect(x.waiting.mock.calls.some(call => call[1] === true)).toBe(false);
});
