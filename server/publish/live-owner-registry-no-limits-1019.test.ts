// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from 'vitest';
import { fixture } from '../decision/fixture.ts';
import { PublishOperations } from './publish-ops.ts';

it.each(['ask','full','unlimited'] as const)('R4 owner Settings keeps live record 201 available only at No limits: %s',async level=>{
 const f=fixture(level),bot=f.store.createBot({name:'Owner registry fixture'},{seedMessages:false});
 const sites=Array.from({length:201},(_,i)=>({siteId:`site-${i}`,name:`fixture-${i}`,url:`https://fixture-${i}.netlify.app`,lastPublishedAt:1,lastFileCount:1,origin:'created' as const}));
 f.store.patchBot(bot.id,{permissionExplicit:true,autoApprove:level!=='ask',fullAccess:level!=='ask',noLimits:level==='unlimited',publishedSites:sites});
 const fetchImpl=vi.fn<typeof fetch>(async()=>new Response(null,{status:204}));
 const operations=new PublishOperations({store:f.store,waiting:vi.fn(),token:()=> 'fixture-only',workspaceFor:()=>undefined,fetchImpl});
 if(level==='unlimited'){
  await operations.ownerTakeDown(bot.id,'site-200');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(String(fetchImpl.mock.calls[0][0])).toBe('https://api.netlify.com/api/v1/sites/site-200');
  expect(f.store.bot(bot.id)?.publishedSites).toHaveLength(200);
  expect(f.store.bot(bot.id)?.publishedSites?.some(site=>site.siteId==='site-200')).toBe(false);
 }else{
  await expect(operations.ownerTakeDown(bot.id,'site-200')).rejects.toMatchObject({code:'not-yours'});
  expect(fetchImpl).not.toHaveBeenCalled();expect(f.store.bot(bot.id)?.publishedSites).toHaveLength(201);
 }
});
