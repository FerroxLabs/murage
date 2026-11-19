// Sean 2026-11-12 02:05Z: a resolved explicit lower routine ceiling survives.
import {expect,it} from 'vitest';
import {ownerRoutineLevel} from '../../shared/owner-routine-level.ts';
import {fixture,d,baseCard} from './fixture.ts';
it('R4b R4c M29 owner routines override captured ceiling only while bot is unlimited; draft stays Ask',()=>{
 expect(ownerRoutineLevel('unlimited','auto',false)).toBe('auto');expect(ownerRoutineLevel('full','auto',false)).toBe('auto');expect(ownerRoutineLevel('unlimited','auto',true)).toBe('ask');
});
it.each(['run','wake','peer','project-room'] as const)('A7a core validates exact routine %s source, bot and generation',form=>{
 const f=fixture('unlimited',{k:form==='run'?'routine-run':form==='wake'?'routine-wake':form==='peer'?'routine-peer':'project-room-routine',form,sourceRunId:'run',sourceBotId:'source',recipientGeneration:'g',trigger:'schedule'});
 d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>({threadId:'t',botId:'b',generation:'g',principal:'owner',roomOwnerOnly:true,at:1,initiator:{k:form==='run'?'routine-run':form==='wake'?'routine-wake':form==='peer'?'routine-peer':'project-room-routine',form,sourceRunId:'run',sourceBotId:'source',recipientGeneration:'g',trigger:'schedule'}}),live:()=>({botId:'b',turnId:'turn',providerInstanceId:'p',principal:'owner',owner:true,level:'unlimited',routine:{sourceRunId:'run',sourceBotId:'source',recipientGeneration:'g',owner:true}})});
 expect(d.readTurnPolicy({threadId:'t',generation:'g'})?.actor).toBe('owner-routine');expect(d.decide(f.open(),baseCard).kind).toBe('run');expect(d.readTurnPolicy({threadId:'t',generation:'stale'})).toBeUndefined();
});
