// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {fixture, d, baseCard} from '../decision/fixture.ts';
import {initializeProjectTables} from '../project-tables.ts';
import {channelToProjectRows} from '../project-settings.ts';
import {projectSettingsFor} from '../project-records.ts';
import {recordProjectRoutine, persistedProjectRoutineOptions, projectRoutineCeiling} from '../project-routines.ts';
import {projectRoutineRunId} from '../turn-usage-routine.ts';
import {roomRequest, markRequestDispatched, enterOwnerWait} from '../room-requests.ts';
import {applyRoutinePermissionMode, applyResolvedRoutineCeilings, botPermissionMode, effectiveRoutinePermissionMode} from '../routine-permissions.ts';
import {permissionsForNoLimitsOrigin, noLimitsAppliesTo} from '../no-limits-origin.ts';
import {wiring,routine} from './fixture.ts';

it('retains an authenticated project routine through its own approval wait, without authorizing other requests',()=>{
 let request={state:'running',toBotId:'recipient'};
 const p={generation:'g',botId:'recipient',threadId:'t',initiator:{...routine,k:'project-room-routine',form:'project-room',sourceBotId:'source'}};
 const {decisionRoutineLive}=wiring(['validDecisionRoutine','decisionRoutineLive'],{
  routines:{runById:(id:string)=>id==='run'?{id:'run',botId:'source',triggerSource:'manual'}:undefined},
  store:{bot:()=>({threadId:'source-thread'})},threadHumanPrincipal:()=>({personId:'workspace-owner'}),isWorkspaceOwner:()=>true,
  roomTurnRequests:new Map([['t:recipient','request']]),roomTurnRequestKey:(t:string,b:string)=>t+':'+b,
  roomRequest:()=>request,database:()=>({}),projectRoutineRunId:()=>'run',
 });
 for(const state of ['running','waiting_owner']){
  request={state,toBotId:'recipient'};
  expect(decisionRoutineLive(p)).toEqual({sourceRunId:'run',sourceBotId:'source',recipientGeneration:'g',owner:true});
  expect(decisionRoutineLive({...p,generation:'replacement'})).toBeUndefined();
  expect(decisionRoutineLive({...p,initiator:{...p.initiator,sourceRunId:'other'}})).toBeUndefined();
  request={state,toBotId:'other'};expect(decisionRoutineLive(p)).toBeUndefined();
 }
 for(const state of ['queued','waiting_bot','done','failed','cancelled','expired','unknown']){
  request={state,toBotId:'recipient'};expect(decisionRoutineLive(p)).toBeUndefined();
 }
});

// Read the real durable row and production live-level functions, then ask the
// decision host for the final native approval outcome. No provider executes.
for (const triggerSource of ['manual', 'schedule'] as const) {
 for (const state of ['running', 'waiting_owner'] as const) {
  for (const invalidation of ['deleted-source', 'missing-authority', 'owner-binding', 'audience-binding', 'corrupt-authority'] as const) {
   it(`invalid project authority asks: ${triggerSource}/${state}/${invalidation}`, () => {
    const initiator = {...routine, k:'project-room-routine' as const, form:'project-room' as const, sourceBotId:'b', trigger:triggerSource};
    const f = fixture('unlimited', initiator);
    try {
     initializeProjectTables(f.db);
     channelToProjectRows(f.db, {groupId:'group', leadBotId:'b', bulletin:'', now:1});
     f.db.exec("UPDATE project_settings SET mode='ongoing'");
     const owner = {personId:'workspace-owner', bindingId:'local', revision:1};
     let principal = owner;
     const bot = {...applyRoutinePermissionMode({}, 'unlimited'), id:'b', threadId:'bot-thread'};
     const definition = {id:'routine', botId:'b', groupId:'group', permissionMode:'unlimited' as const};
     const definitions = new Map([['routine', definition]]);
     const run = {id:'run', routineId:'routine', botId:'b', groupId:'group', threadId:'t', manual:triggerSource==='manual', triggerSource};
     const runs = new Map([['run', run]]);
     f.db.exec('BEGIN');
     const {requestId} = recordProjectRoutine(f.db, {groupId:'group', threadId:'t', memberIds:['b'], runId:'run', botId:'b', name:'Fixture', prompt:'fixture', now:2,
      authority:{routineId:'routine', ceiling:{permissionMode:'unlimited',triggerSource}, ownerBinding:JSON.stringify(owner), audienceBinding:JSON.stringify(owner)}});
     f.db.exec('COMMIT');
     expect(markRequestDispatched(f.db, requestId, {now:3,targetThreadId:'t'})).toBe(true);
     if(state==='waiting_owner') enterOwnerWait(f.db, requestId, 4);
     const globals = {
      routines:{runById:(id:string)=>runs.get(id), routineById:(id:string)=>definitions.get(id), listRoutines:()=>[...definitions.values()], listRuns:()=>[...runs.values()]},
      store:{bot:()=>bot,group:()=>({channelProject:{},threadId:'t',memberIds:['b']})},
      database:()=>f.db, roomRequest, projectSettingsFor, persistedProjectRoutineOptions, projectRoutineCeiling, projectRoutineRunId,
      inertBot:()=>false, turnAudienceIsOwner:()=>true,
      threadHumanPrincipal:(threadId:string)=>invalidation==='owner-binding' && threadId==='bot-thread' ? principal : invalidation==='audience-binding' && threadId==='t' ? principal : owner,
      isWorkspaceOwner:()=>true,
      roomTurnRequests:new Map([['t:b',requestId]]), roomTurnRequestKey:(t:string,b:string)=>t+':'+b,
      internalTurnOwners:new Map([['t',{botId:'b',generation:'g'}]]), internalCapabilities:{activeGeneration:()=> 'g'},
      routineRunLevel:()=>null, routineConversationMode:()=>undefined, admittedRoutineCeilings:new Map(),
      applyResolvedRoutineCeilings, effectiveRoutinePermissionMode, permissionsForNoLimitsOrigin, noLimitsAppliesTo,
      hasNoLimits:(value:any)=>value.noLimits===true, botPermissionMode,
     };
     const live = wiring(['validDecisionRoutine','decisionRoutineLive','decisionNoLimitsOrigin','decisionLiveLevel','projectRoutineCurrent','projectRoomRoutineCeiling'],globals);
     const provenance = {generation:'g',botId:'b',threadId:'t',principal:'owner',roomOwnerOnly:true,at:1,initiator};
     d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>provenance,live:()=>({botId:'b',turnId:'turn',providerInstanceId:'p',principal:'owner',owner:true,
      level:live.decisionLiveLevel(provenance,bot),routine:live.decisionRoutineLive(provenance)})});
     // Positive control proves that the exact delivered request has authority.
     expect(d.decide(f.open('before'),baseCard).kind).toBe('run');
     if(invalidation==='deleted-source') definitions.delete('routine');
     else if(invalidation==='missing-authority') f.db.prepare('DELETE FROM project_routine_authority WHERE request_id=?').run(requestId);
     else if(invalidation==='corrupt-authority') f.db.prepare("UPDATE project_routine_authority SET ceiling='broken' WHERE request_id=?").run(requestId);
     else principal = {...owner, revision:2};
     expect(runs.has('run')).toBe(true);
     // Inspect the final native decision, rather than only an empty options object.
     expect(d.decide(f.open('after'),baseCard).kind).toBe('card');
     expect(f.respond).not.toHaveBeenCalled();
    } finally { f.dispose(); }
   });
  }
 }
}

it('project authority lookup reads one indexed routine and run without listing retained history',()=>{
 const bot=applyRoutinePermissionMode({id:'b',threadId:'bot-thread'},'unlimited');
 const definition={id:'r',botId:'b',groupId:'group',permissionMode:'unlimited'};
 const run={id:'run',routineId:'r',botId:'b',groupId:'group',threadId:'t',manual:true,triggerSource:'manual'};
 let routineReads=0,runReads=0;
 const fail=()=>{throw Error('approval lookup listed retained history');};
 const {projectRoutineCurrent}=wiring(['projectRoutineCurrent'],{
  routines:{routineById:()=>{routineReads++;return definition;},runById:()=>{runReads++;return run;},listRoutines:fail,listRuns:fail},
  store:{bot:()=>bot,group:()=>({channelProject:{},threadId:'t',memberIds:['b']})},database:()=>({}),
  projectSettingsFor:()=>({closedAt:null,endedAt:null}),projectRoutineCeiling,effectiveRoutinePermissionMode,
  inertBot:()=>false,turnAudienceIsOwner:()=>true,threadHumanPrincipal:()=>({personId:'workspace-owner'}),
 });
 for(let i=0;i<100;i++) expect(projectRoutineCurrent('r','group','t','b','run')).toMatchObject({sourceBotId:'b',permissionMode:'unlimited'});
 expect(routineReads).toBe(100);expect(runReads).toBe(100);
});
