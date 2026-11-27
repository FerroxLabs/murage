// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { source, wiring, routine } from './fixture.ts';
import { applyRoutinePermissionMode, applyResolvedRoutineCeilings, botPermissionMode, effectiveRoutinePermissionMode, type RoutinePermissionMode } from '../routine-permissions.ts';
import { permissionsForNoLimitsOrigin, noLimitsAppliesTo } from '../no-limits-origin.ts';
import { permissionsForOrigin } from '../permission-inheritance.ts';
import { hasNoLimits } from '../auto-approve.ts';
it('cloud owner settlement remains bound to the resolved device id',()=>{
  const admitted={id:'fixture-device',account:'fixture-owner',publicKey:'fixture-public-key',revoked:false};let current={...admitted};
  const {skillOwnerSession}=wiring(['skillOwnerSession'],{process:{env:{MURAGE_CLOUD_ROLE:'home'}},mayApprove:()=>true,
    cloudIdentity:()=>({account:admitted.account,accessHash:'fixture-access-hash',revoked:false}),
    homeSessions:{resolveHash:()=>current,watermarkFor:()=>1}});
  const session=skillOwnerSession({headers:{}},new URL('http://127.0.0.1/'));expect(session.live()).toBe(true);
  current={...admitted,id:'fixture-replacement'};expect(session.live()).toBe(false);
});
describe('R4/R4b/R4c A3 A7a L7: dispatch provenance', () => {
  it('queued owner drain survives released parent (M37)', () => {
    const { decisionInitiator } = wiring(['decisionInitiator']);
    expect(decisionInitiator({ queuedDrain: true, queuedOwnerProof: true })).toEqual({ k: 'owner-typed' });
    expect(decisionInitiator({ queuedDrain: true, origin: 'unproven' })).toEqual({ k: 'other-human' });
  });
  it.each(['run','wake','peer','project-room'])('validates routine %s by its own source (M59)', form => {
    const { validDecisionRoutine } = wiring(['validDecisionRoutine']);
    const initiator = { ...routine, form, k: form === 'run' ? 'routine-run' : form === 'project-room' ? 'project-room-routine' : `routine-${form}` };
    const live = { sourceRunId: 'run', sourceBotId: 'bot', recipientGeneration: 'g', owner: true };
    expect(validDecisionRoutine(initiator, 'g', live)).toBe(true);
    for (const changed of [{sourceRunId:'forged'}, {sourceBotId:'forged'}, {recipientGeneration:'old'}, {owner:false}])
      expect(validDecisionRoutine(initiator, 'g', { ...live, ...changed })).toBe(false);
  });
  it('keeps webhook, peer, guest, delegation and unproven continuations non-owner', () => {
    const { decisionInitiator } = wiring(['decisionInitiator']);
    for (const k of ['webhook','guest','delegation','other-human']) expect(decisionInitiator({ kind:k })).toEqual({k});
    expect(decisionInitiator({ kind:'peer', fromBotId:'peer' })).toEqual({k:'peer',fromBotId:'peer'});
    expect(decisionInitiator({ cardContinuation:true })).toEqual({k:'other-human'});
    expect(decisionInitiator({ continuation:{k:'owner-typed'} })).toEqual({k:'owner-typed'});
    expect(decisionInitiator({ memoryRedispatch:true, ownerOrigin:true })).toEqual({k:'owner-typed'});
    expect(decisionInitiator({ channel:'telegram', channelOwner:true })).toEqual({k:'owner-channel-dm',channel:'telegram'});
    expect(decisionInitiator({ channel:'telegram', channelOwner:false })).toEqual({k:'other-human'});
  });
  it('records both owner-map sites, including Chief, and requires provenance (M69)', () => {
    expect((source.match(/internalTurnOwners\.set\(/g) ?? []).length).toBe(2);
    expect(source.includes('function beginInternalTurn(provenance: TurnProvenance,')).toBe(true);
    expect(source.includes('recordDecisionProvenance(provenance)')).toBe(true);
    expect(source.includes('recordDecisionProvenance(chiefProvenance)')).toBe(true);
    const ingress = source.indexOf('installRequestIngress(bus)');
  const consumer = source.indexOf('bus.subscribeExecution(');
  expect(ingress).toBeGreaterThanOrEqual(0); // MAIN RULING 1115-R5RUL-4 (GrokBuild)
  expect(consumer).toBeGreaterThanOrEqual(0); // MAIN RULING 1115-R5RUL-4 (GrokBuild)
  expect(ingress).toBeLessThan(consumer); // MAIN RULING 1115-R5RUL-4 (GrokBuild)
    expect(source.includes('self-continuation')).toBe(false);
  });
});

describe('R4 real dispatch functions with isolated S0 dependencies', () => {
  it.each(['run','wake','peer','project-room'])('the actual live reader accepts %s and rejects a forged source (M59)', form => {
    const recipient=form==='run'?'source':'recipient';
    const p={generation:'g',botId:recipient,threadId:'t',initiator:{...routine,sourceBotId:'source',form,k:form==='run'?'routine-run':form==='project-room'?'project-room-routine':`routine-${form}`}};
    const globals={
      routines:{runById:(id:string)=>id==='run'?{id:'run',botId:'source',triggerSource:'manual'}:undefined,routineRunForThread:()=>({runId:'run'})},
      store:{bot:()=>({threadId:'source-thread'})},threadHumanPrincipal:()=>({personId:'workspace-owner'}),isWorkspaceOwner:()=>true,
      currentTurnRoutineRunId:()=>form==='run'?'run':undefined,
      routineWakeByTurn:new Map([['g',{}]]),routinePeerSources:new Map([['t',{}]]),
      roomTurnRequests:new Map([['t:'+recipient,'room-request']]),roomTurnRequestKey:(t:string,b:string)=>t+':'+b,
      roomRequest:()=>({state:'running',toBotId:recipient}),database:()=>({}),projectRoutineRunId:()=>'run',
    };
    const {decisionRoutineLive}=wiring(['validDecisionRoutine','decisionRoutineLive'],globals);
    expect(decisionRoutineLive(p)).toEqual({sourceRunId:'run',sourceBotId:'source',recipientGeneration:'g',owner:true});
    expect(decisionRoutineLive({...p,initiator:{...p.initiator,sourceRunId:'forged'}})).toBeUndefined();
    expect(decisionRoutineLive({...p,generation:'replacement'})).toBeUndefined();
    if(form==='run')expect(decisionRoutineLive({...p,botId:'different-executing-bot'})).toBeUndefined();
    expect(decisionRoutineLive({...p,initiator:{k:'owner-typed'}})).toBeUndefined();
  });
  it('owner routines follow the profile into No limits and return to BASE; drafts stay Ask (M29)',()=>{
    let mode:RoutinePermissionMode='unlimited',draft=false;
    const profile=()=>({...applyRoutinePermissionMode({},mode),draftOnly:draft});
    const {decisionLiveLevel}=wiring(['decisionLiveLevel'],{store:{bot:profile},botPermissionMode,
      decisionNoLimitsOrigin:()=> 'owner-routine',routineConversationMode:()=>undefined,admittedRoutineCeilings:new Map(),
      applyResolvedRoutineCeilings,permissionsForNoLimitsOrigin,permissionsForOrigin,hasNoLimits,noLimitsAppliesTo,
      routineWakeByTurn:new Map([['g',{permissionMode:'auto'}]]),routinePeerSources:new Map(),routineRunLevel:()=>undefined,effectiveRoutinePermissionMode});
    const p={generation:'g',threadId:'t',botId:'b',roomOwnerOnly:true,initiator:{...routine,form:'wake'}};
    expect(decisionLiveLevel(p,profile())).toBe('unlimited');mode='auto';expect(decisionLiveLevel(p,profile())).toBe('auto');
    mode='unlimited';draft=true;expect(decisionLiveLevel(p,profile())).toBe('ask');
  });
  it('generation cancellation retains authority until handed off, then deletes only the retired generation (R12)',async()=>{
    let finish!:()=>void;const done=new Promise<void>(resolve=>{finish=resolve;});
    const decisionProvenance=new Map([['old',{}],['replacement',{}]]);
    const targets=new Map([['old',{target:{threadId:'t',generation:'old'}}],['new',{target:{threadId:'t',generation:'replacement'}}]]);
    const {releaseDecisionProvenance}=wiring(['releaseDecisionProvenance'],{deleteContinuation:async()=>{},decisionQueuePorts:new Map(),decisionSharedSaves:new Map(),cancelRequests:()=>done,decisionAuthorities:new Map(),decisionProvenance,decisionRequestTargets:targets});
    const task=releaseDecisionProvenance('t','old');expect(decisionProvenance.has('old')).toBe(true);finish();await task;
    expect([...decisionProvenance.keys()]).toEqual(['replacement']);expect([...targets.keys()]).toEqual(['new']);
  });
});

it('H13 verifies only genuine HTTP session proof in its own async scope and genuine tool capabilities',()=>{
  const request={},http={threadId:'t',botId:'b',generation:'http:1'};
  const decisionHttpProofs=new WeakMap([[request,http]]);
  let generation='http:1';const token={threadId:'tool-thread',botId:'bot',generation:'tool-gen'};
  const {verifyDecisionClaim}=wiring(['verifyDecisionClaim'],{decisionHttpProofs,decisionServiceContext:{getStore:()=>({generation})},internalCapabilities:{isActive:(proof:unknown)=>proof===token}});
  expect(verifyDecisionClaim(request)).toEqual(http);
  generation='other';expect(verifyDecisionClaim(request)).toBeUndefined();
  expect(verifyDecisionClaim(token)).toEqual({threadId:'tool-thread',botId:'bot',generation:'tool-gen'});
  expect(verifyDecisionClaim({...token})).toBeUndefined();
  expect(verifyDecisionClaim({threadId:'t',botId:'b',generation:'http:1'})).toBeUndefined();
});

it('owner HTTP service generations remain separate across concurrent authenticated sessions',async()=>{
  const {AsyncLocalStorage}=await import('node:async_hooks');
  const context=new AsyncLocalStorage<any>(),proofs=new WeakMap(),seen:string[]=[];
  let next=0;
  const globals={ownerAppSurface:()=>({ok:true}),mayApprove:()=>true,connectorThread:()=>({}),randomUUID:()=>String(++next),
    makeDecisionProvenance:(botId:string,threadId:string,generation:string)=>({botId,threadId,generation}),decisionServiceContext:context,decisionHttpProofs:proofs,
    issueDecisionClaim:(proof:object)=>{const identity=proofs.get(proof);expect(identity.generation).toBe(context.getStore().generation);return identity;},
    saveContinuation:async(_key:unknown,parent:any)=>expect(context.getStore().generation).toBe(parent.generation),
    deleteContinuation:async()=>{},decisionQueuePorts:new Map(),APPROVAL_NEEDS_OWNER:'Owner required'};
  const {withOwnerDecisionAuthority}=wiring(['withOwnerDecisionAuthority','releaseDecisionQueueProof'],globals);
  await Promise.all(['one','two'].map(async id=>{
    const req={headers:{}},url=new URL('http://fixture.test');
    await withOwnerDecisionAuthority(req,url,id,'thread-'+id,async(authority:any)=>{
      const before=context.getStore();await Promise.resolve();expect(context.getStore()).toBe(before);
      expect(authority.claim.botId).toBe(id);seen.push(before.generation);
    });
    expect(proofs.has(req)).toBe(false);
  }));
  expect(new Set(seen).size).toBe(2);expect(context.getStore()).toBeUndefined();
});

it('A3 card continuations preserve a narrowed actor when the later audience changes',()=>{
  const {decisionContinuationInitiator}=wiring(['decisionContinuationInitiator'],{lookupApproval:()=>({botId:'b',actor:'other',initiator:{k:'owner-typed'}})});
  expect(decisionContinuationInitiator('t','b','new','card')).toEqual({k:'other-human'});
});

it('H-workflow project routine authority survives its own owner-wait and expires with the request',()=>{
  let state='waiting_owner';
  const p={generation:'g',botId:'recipient',threadId:'t',initiator:{...routine,sourceBotId:'source',form:'project-room',k:'project-room-routine'}};
  const globals={
    routines:{runById:()=>({id:'run',botId:'source',triggerSource:'manual'})},
    store:{bot:()=>({threadId:'source-thread'})},threadHumanPrincipal:()=>({personId:'workspace-owner'}),isWorkspaceOwner:()=>true,
    roomTurnRequests:new Map([['t:recipient','room-request']]),roomTurnRequestKey:(t:string,b:string)=>t+':'+b,
    roomRequest:()=>({state,toBotId:'recipient'}),database:()=>({}),projectRoutineRunId:()=>'run',
  };
  const {decisionRoutineLive}=wiring(['validDecisionRoutine','decisionRoutineLive'],globals);
  expect(decisionRoutineLive(p)).toEqual({sourceRunId:'run',sourceBotId:'source',recipientGeneration:'g',owner:true});
  state='running';expect(decisionRoutineLive(p)).toBeDefined();
  for(const ended of ['done','cancelled','failed','queued']){state=ended;expect(decisionRoutineLive(p)).toBeUndefined();}
});

it('H-workflow project owner-wait revalidation is bound to the active provider generation',()=>{
  let activeGeneration='g';
  const request={state:'waiting_owner',toBotId:'b',targetThreadId:'t'};
  const ceiling={permissionMode:'ask',permissionExplicit:true};
  const globals={
    roomTurnRequests:new Map([['t:b','request']]),roomTurnRequestKey:(t:string,b:string)=>t+':'+b,
    roomRequest:()=>request,database:()=>({}),internalTurnOwners:new Map([['t',{botId:'b',generation:'g'}]]),
    internalCapabilities:{activeGeneration:()=>activeGeneration},projectRoutineCurrent:()=>({}),
    persistedProjectRoutineOptions:(_db:unknown,row:any,_current:unknown,phase:string)=>(row.state==='running'||row.state==='waiting_owner'&&phase==='turn')?{routineAuthority:ceiling}:{},
    store:{bot:()=>({draftOnly:false})},effectiveRoutinePermissionMode:(source:any)=>source.permissionMode,
  };
  const {projectRoomRoutineCeiling}=wiring(['projectRoomRoutineCeiling'],globals);
  expect(projectRoomRoutineCeiling('t',{id:'b'})).toMatchObject({permissionMode:'ask'});
  activeGeneration='retired';expect(projectRoomRoutineCeiling('t',{id:'b'})).toBeUndefined();
  activeGeneration='g';request.state='done';expect(projectRoomRoutineCeiling('t',{id:'b'})).toBeUndefined();
  request.state='waiting_owner';expect(projectRoomRoutineCeiling('t',{id:'other-bot'})).toBeUndefined();
});
