// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it } from 'vitest';
import { fixture } from './decision/fixture.ts';
import { authorizeVenuePost, answerHeldVenuePost, holdVenuePost, setVenuePostLive, forgetAllVenuePostTurns, venuePostMounts, recordVenuePostTurn } from './venue-post.ts';
import { setExecutionStore } from './execution-audience.ts';
import { setMemoryCaptureRoster } from './memory/capture-scope.ts';
import { reconcileMemoryRoster } from './memory/policy.ts';
import { setMemoryMode } from './memory/repository.ts';
import type { BotRecord, GroupRecord } from './store.ts';
afterEach(()=>{setVenuePostLive(null);forgetAllVenuePostTurns();setExecutionStore(undefined as never);});
it('F6 mounts without a picker and commits the requested No limits venue post through the production transaction',()=>{
 const f=fixture();
 const bot={id:'b',threadId:'t',name:'Fixture',color:'blue',section:'Ops',tasks:[],autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true} as unknown as BotRecord;
 const group={id:'venue',name:'Launch',threadId:'room',section:'Ops',memberIds:['b'],tasks:[{threadId:'room-task'}]} as GroupRecord;
 const roster={bots:[bot],groups:[group]};setExecutionStore(f.store);setMemoryCaptureRoster(()=>roster);setMemoryMode('active');reconcileMemoryRoster(roster);
 const request=f.store.appendMessage('t',{role:'user',kind:'text',text:'Post the launch update',origin:'desktop'},'owner-request');
 setVenuePostLive({ownerSurface:()=>true,notOwnerAudience:()=>false,roster:()=>roster,message:(_thread,id)=>f.store.messageById('t',id)??null});
 const mounted=venuePostMounts({botId:'b',threadId:'t',bot,origin:'desktop',surfacesForOwner:true,directOwnerAudience:true,agentsMcp:true,automationThread:false,message:request});
 expect(mounted).not.toBeNull();recordVenuePostTurn('g',mounted!);
 for(const [index,target] of ['room','room-task','room','room-task'].entries()) {
  const verdict=authorizeVenuePost(f.db,{botId:'b',threadId:'t',generation:'g'},{venueId:'venue',...(target==='room-task'?{venueThreadId:target}:{}),text:'Launch update'});
  expect(verdict.ok).toBe(true);if(!verdict.ok)throw Error(JSON.stringify(verdict));
  const id=`post-${index}`;
  holdVenuePost(f.db,{id,botId:'b',threadId:'t',origin:verdict.record.origin,requestMessageId:verdict.record.request.messageId,requestHash:verdict.record.request.textHash,venueId:'venue',...(target==='room-task'?{venueThreadId:target}:{}),targetThreadId:target,text:verdict.text,stableId:id,lineage:'[]'});
  const posted=answerHeldVenuePost({transaction:fn=>fn(f.db),roster:()=>roster,message:()=>null,lineExists:(thread,id)=>!!f.store.messageById(thread,id),append:(thread,row,id,within,lineage)=>f.store.appendMessage(thread,row,id,within,undefined,lineage)},id,'post');
  expect(posted?.state).toBe('posted');expect(f.store.messageById(target,id)?.text).toBe('Launch update');
 }
 f.setLevel('ask');expect(authorizeVenuePost(f.db,{botId:'b',threadId:'t',generation:'g'},{venueId:'venue',venueThreadId:'room-task',text:'No picker grant'}).ok).toBe(false);
 f.setLevel('unlimited');f.setOwner(false);expect(authorizeVenuePost(f.db,{botId:'b',threadId:'t',generation:'g'},{venueId:'venue',venueThreadId:'room-task',text:'Guest'}).ok).toBe(false);
 expect(authorizeVenuePost(f.db,{botId:'b',threadId:'t',generation:'stale'},{venueId:'venue',text:'Stale'}).ok).toBe(false);
});
