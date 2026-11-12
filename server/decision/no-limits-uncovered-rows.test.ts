// SPDX-License-Identifier: AGPL-3.0-or-later
// Inert calls and isolated SQLite only. No tool command is executed.
import {afterEach, expect, it, vi} from 'vitest';
import {d, fixture, baseCard, baseRun} from './fixture.ts';
import {noLimitsAppliesTo} from '../no-limits-origin.ts';
import {installPermissionInheritance, permissionsForOrigin} from '../permission-inheritance.ts';
let reset=()=>{};
afterEach(()=>{reset();vi.restoreAllMocks();});
const nl={autoApprove:true,fullAccess:true,noLimits:true};
it.each(['guest','other','other-human'] as const)('R1 explicit 1.0.19 bot applies to %s; legacy and inherited stay Ask',origin=>{
 reset=installPermissionInheritance(()=>true);
 expect(noLimitsAppliesTo(origin,{...nl,permissionExplicit:true})).toBe(true);
 expect(noLimitsAppliesTo(origin,nl)).toBe(false);
 expect(noLimitsAppliesTo(origin,{permissionExplicit:false})).toBe(false);
 expect(permissionsForOrigin({...nl,permissionExplicit:true},false)).toMatchObject(nl);
 expect(permissionsForOrigin(nl,false)).toMatchObject({autoApprove:false,fullAccess:false,noLimits:false});
});
it.each(['full','unlimited'] as const)('R1 explicit %s applies to a guest task; legacy flags never count as explicit',level=>{
 const f=fixture(level),bot=f.store.createBot({name:'Guest fixture'},{seedMessages:false});
 Object.assign(bot,{autoApprove:true,fullAccess:true,noLimits:level==='unlimited'});delete bot.permissionExplicit;
 // principal binding is proven in the merge-rulings task projection test.
 expect(permissionsForOrigin(bot,false)).toMatchObject({autoApprove:false,fullAccess:false,noLimits:false});
 bot.permissionExplicit=true;
 expect(permissionsForOrigin(bot,false)).toMatchObject({autoApprove:true,fullAccess:true,noLimits:level==='unlimited'});f.dispose();
});
it('R1 webhook and routine take inherited No limits; missing origin stays Ask',()=>{
 reset=installPermissionInheritance(()=>true);
 for(const origin of ['webhook','unattended','routine'] as const)expect(noLimitsAppliesTo(origin,{permissionExplicit:false})).toBe(true);
 expect(noLimitsAppliesTo(undefined,{...nl,permissionExplicit:true})).toBe(false);
 expect(noLimitsAppliesTo('owner-channel',{...nl,permissionExplicit:true,fullAccessChannelMessages:false})).toBe(false);
});
it('A21 C7 C13 recovered owner identity runs, and visible wipe still holds',async()=>{
 const f=fixture();
 d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>undefined,live:()=>undefined,ownerThread:()=>({botId:'b',principal:'owner',level:'unlimited',origin:'owner'})});
 const h=f.open('recovered',{command:'printf fixture'});expect(d.decide(h,baseCard).kind).toBe('run');await d.deliverRequest(h);
 expect(f.respond.mock.calls[0][1].behavior).toBe('allow');
 expect(d.decide(f.open('recovered-wipe',{command:'rm -rf ~'}),baseRun).kind).toBe('card');f.dispose();
});
it('A30 a broken optional card builder falls back to a plain wipe card',async()=>{
 const f=fixture();d.installEngineApprovalBuilder(()=>{throw new Error('fixture builder failure');});
 const out=d.decide(f.open('wipe',{command:'rm -rf ~'}),baseRun);
 expect(out.kind).toBe('card');if(out.kind==='card')expect(d.readApproval(out.ref.approvalId)).toBeUndefined();
 expect(f.respond).not.toHaveBeenCalled();f.dispose();
});
it('A31 ninth question is shown at No limits without refusing the owner turn',async()=>{
 const f=fixture();
 for(let i=0;i<9;i++){
  const out=d.decide(f.open(`q${i}`,{}, {requestType:'question',questionTool:true,questions:[{question:`Fixture ${i}?`,options:[{label:'Yes'}]}]}),baseCard);
  expect(out.kind).toBe('question');if(out.kind==='question')await d.presentApproval(out.ref,{title:'Fixture',subtitle:'Question'});
 }
 expect(d.openApprovals('t')).toHaveLength(9);expect(f.respond).not.toHaveBeenCalled();f.dispose();
});
it.each(['stored','host-computer','browser-site','connected-app','browser','site'])('08:05 stored %s permission rule delivers the action with no card, refusal or hold',async cls=>{
 const f=fixture();f.deny([{kind:'deny',class:cls as any,ruleId:'owner-never',span:'/w/fixture'}]);
 const h=f.open('saved-never',{command:'touch /w/fixture'});
 expect(d.decide(h,baseCard).kind).toBe('run');await d.deliverRequest(h);
 expect(d.openApprovals('t')).toHaveLength(0);expect(f.respond).toHaveBeenCalledTimes(1);
 expect(f.respond.mock.calls[0][1]).toMatchObject({behavior:'allow'});f.dispose();
});
it('08:05 stored permission deny also runs on an explicitly No limits guest bot',async()=>{
 const f=fixture('unlimited',{k:'other-human'});
 d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>({generation:'g',botId:'b',threadId:'t',principal:'guest',roomOwnerOnly:false,at:1,initiator:{k:'other-human'}}),live:()=>({botId:'b',turnId:'turn',providerInstanceId:'p',principal:'guest',owner:false,permissionExplicit:true,level:'unlimited'})});
 f.deny([{kind:'deny',class:'stored',ruleId:'never-guest',span:'/w/fixture'}]);
 const h=f.open('explicit-guest-never',{command:'touch /w/fixture'});
 expect(d.decide(h,baseCard).kind).toBe('run');await d.deliverRequest(h);
 expect(f.respond).toHaveBeenCalledTimes(1);expect(f.respond.mock.calls[0][1].behavior).toBe('allow');
 expect(d.openApprovals('t')).toHaveLength(0);expect(f.interrupt).not.toHaveBeenCalled();f.dispose();
});
it('A20 machine cap admits 513 owner requests, logs pressure and delivers each without refusal',async()=>{
 const f=fixture(),log=vi.spyOn(console,'warn').mockImplementation(()=>{});
 const handles=[];for(let i=0;i<513;i++)handles.push(f.open(`cap${i}`,{command:'printf fixture'}));
 for(const h of handles){expect(d.decide(h,baseCard).kind).toBe('run');await d.deliverRequest(h);}
 expect(f.respond).toHaveBeenCalledTimes(513);expect(d.openApprovals('t')).toHaveLength(0);
 expect(log.mock.calls.flat().join('\n')).toMatch(/no-limits.*(?:capacity|pressure|queue|shed)/i);f.dispose();
},30000);

it('C13 durable continuation keeps its admitted level across process recovery',async()=>{
 const f=fixture(),key={kind:'background-job' as const,id:'restart-level',botId:'b',threadId:'t'};
 await d.saveContinuation(key,{threadId:'t',generation:'g'});
 f.setLevel('ask');
 const saved=d.readContinuation(key)!;
 expect(saved).toMatchObject({level:'unlimited',actor:'owner'});
 // Drop the process's live/provenance records and reconstruct only from the durable host proof.
 d.installProvenanceReader({turnGenerationFor:()=> 'recovery',provenance:()=>undefined,live:()=>undefined,
  ownerThread:()=>({botId:'b',principal:saved.principal,level:(saved as any).level,origin:'owner'})});
 const h=f.open('restart-safe',{command:'printf fixture'});expect(d.decide(h,baseCard).kind).toBe('run');await d.deliverRequest(h);
 expect(f.respond.mock.calls[0][1].behavior).toBe('allow');expect(d.openApprovals('t')).toHaveLength(0);f.dispose();
});

it('A20 delivery capacity queues request 33, then runs it when a slot opens',async()=>{
 const f=fixture(),release:Array<()=>void>=[],log=vi.spyOn(console,'warn').mockImplementation(()=>{});
 f.respond.mockImplementation(()=>new Promise(resolve=>release.push(()=>resolve({state:'accepted'}))));
 const work=Array.from({length:33},(_,i)=>{const h=f.open(`queued${i}`,{command:'printf fixture'});expect(d.decide(h,baseCard).kind).toBe('run');return d.deliverRequest(h);});
 await vi.waitFor(()=>expect(f.respond).toHaveBeenCalledTimes(32));
 expect(log.mock.calls.flat().join('\n')).toMatch(/capacity.*queued/i);
 release.shift()!();await vi.waitFor(()=>expect(f.respond).toHaveBeenCalledTimes(33));
 for(const resolve of release.splice(0))resolve();await Promise.all(work);
 expect(d.openApprovals('t')).toHaveLength(0);f.dispose();
});

it.each(['ask','unlimited'] as const)('08:05 channel messages switched off at %s never run or card and return one settings line',async level=>{
 const f=fixture(level,{k:'owner-channel-dm',channel:'telegram'});
 d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>({generation:'g',botId:'b',threadId:'t',principal:'owner',roomOwnerOnly:true,at:1,initiator:{k:'owner-channel-dm',channel:'telegram'}}),live:()=>({botId:'b',turnId:'turn',providerInstanceId:'p',principal:'owner',owner:true,level,fullAccessChannelMessages:false})});
 const h=f.open('channel-off',{command:'printf fixture'});
 expect(d.decide(h,baseRun)).toMatchObject({kind:'refuse',message:expect.stringMatching(/off.*(?:Settings|settings)/)});
 await d.deliverRequest(h);expect(d.openApprovals('t')).toHaveLength(0);
 expect(f.respond).toHaveBeenCalledTimes(1);expect(f.respond.mock.calls[0][1].behavior).toBe('deny');
 expect(f.respond.mock.calls[0][1].message?.split('\n')).toHaveLength(1);f.dispose();
});

it('R1 Ask webhook keeps its one-time card when the optional standing-grant builder is unavailable',async()=>{
 const f=fixture('ask',{k:'webhook'});
 d.installDecisionHost({store:f.store,view:()=>({title:'Ask webhook',subtitle:'Fixture'})});
 const out=d.decide(f.open('ask-webhook',{command:'cat .env'}),baseCard);
 expect(out.kind).toBe('card');if(out.kind!=='card')throw Error('Ask webhook lost its card');
 await d.presentApproval(out.ref,{title:'Ask webhook',subtitle:'Fixture'});
 expect(d.openApprovals('t')).toHaveLength(1);expect(f.respond).not.toHaveBeenCalled();f.dispose();
});
