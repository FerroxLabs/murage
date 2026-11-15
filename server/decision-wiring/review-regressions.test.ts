// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi } from 'vitest';
import { wiring, routine } from './fixture.ts';

describe('review 2: registered question continuation admission', () => {
  it.each([false, true])('admits exactly one owner send, expired=%s', async late => {
    const card = { approvalId:'a', requestId:'r', answerAsSend:true, ...(late ? {expired:true} : {}) };
    const message = { id:'m', card };
    const accepted = new Map();
    const accept = vi.fn((input:any) => { if(accepted.has(input.sendId)) return {kind:'existing',row:accepted.get(input.sendId)}; const row={...input};accepted.set(input.sendId,row);return {kind:'new',row}; });
    const send = vi.fn(async(_input:any)=>({status:'accepted'}));
    const patch = vi.fn(()=>{throw Error('registered action fields are immutable');});
    const answer = vi.fn(async()=>({kind:'answered',ref:{approvalId:'a'}}));
    const {answerAsSendReply} = wiring(['answerAsSendReply'], {
      cardByRequest:()=>message,isQuestionCard:()=>true,store:{groupByThread:()=>undefined,botByThread:()=>({id:'b'}),patchMessage:patch},
      questionsForCard:()=>[{question:'Choose',options:['Yes']}],parseAnswers:()=>({ok:true,answers:['Yes']}),validateAnswers:(_:any,a:any)=>({ok:true,answers:a}),
      answerSendText:()=> 'Yes',answersAsMessage:()=> 'Yes',answerQuestionReply:answer,assertQuestionDelivery:()=>{},readApproval:()=>({action:{answerAsSend:true}}),
      sendStore:{accept},sendFingerprint:(text:string)=>text,recordableAnswers:(_q:any,a:any)=>a,transaction:(f:()=>any)=>f(),
      askMessageByRequest:new Map(),admitDirectSend:send,wireReceipt:(r:any)=>r,answerNotAdmitted:()=>false,
      sendNoticeError:()=>({message:'not recorded'}),
    });
    const body={behavior:'answer',answers:['Yes'],...(late?{sentAsMessage:true}:{})};
    const result=await answerAsSendReply('t','r',body,false,'desktop');
    expect(result.status).toBe(200);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({sendId:'ask-m',origin:'desktop',text:'Yes'});
    expect(patch).not.toHaveBeenCalled();
    expect((await answerAsSendReply('t','r',body,false,'desktop')).status).toBe(409);
    expect(send).toHaveBeenCalledTimes(1);
    expect(answer).toHaveBeenCalledTimes(late?0:2);
  });
});

it('review 4: Skill Allow fails when neither staged nor applied content exists',()=>{
  const apply=vi.fn(()=>({error:'no such staged skill'}));
  const {acceptIndexSkill}=wiring(['acceptIndexSkill'],{indexItemIdentity:()=>({botId:'b'}),applyStagedSkillWrite:apply,rejectStagedSkillWrite:()=>({error:'no such staged skill'})});
  const item={call:{input:{stagedId:'missing',sha256:'hash'}}};
  expect(()=>acceptIndexSkill(item,{behavior:'allow'})).toThrow('no such staged skill');
  expect(apply).toHaveBeenCalledWith('b','missing',{expectedSha256:'hash'});
  expect(()=>acceptIndexSkill(item,{behavior:'deny'})).not.toThrow();
});

it('review 3: queued routine ancestry survives release and a new unrelated source turn',()=>{
  const generations=new Map([['s','g']]);
  const provenance=new Map([['g',{botId:'source',initiator:{...routine,sourceBotId:'source'}}]]);
  const {routinePeerSource,peerRoutineTurnOptions}=wiring(['routinePeerSource','peerRoutineTurnOptions'],{
    isUnattended:()=>false,routinePeerSources:new Map(),routineRunLevel:()=>({mode:'auto'}),routines:{activeRunOrigin:()=>({triggerSource:'schedule'})},
    turnGenerationFor:(t:string)=>generations.get(t),decisionProvenance:provenance,
    capQueuedPeerSource:(v:any)=>v,peerTurnAuthority:()=>({mode:'auto'}),
  });
  const queued=JSON.parse(JSON.stringify(routinePeerSource('s','source')));
  provenance.clear();generations.set('s','unrelated');
  provenance.set('unrelated',{botId:'source',initiator:{...routine,sourceRunId:'wrong',sourceBotId:'source'}});
  expect(peerRoutineTurnOptions({id:'recipient'},'s','source',queued).decisionRoutineSource).toMatchObject({sourceRunId:'run',sourceBotId:'source',form:'peer'});
});
it('review 3: shared turn forwards captured ancestry along with its BASE ceiling',()=>{
  const options={routineAuthority:{permissionMode:'auto',triggerSource:'schedule'},decisionRoutineSource:{...routine,form:'peer'}};
  const {sharedTurnOptions}=wiring(['sharedTurnOptions'],{store:{bot:()=>({})},requestSourceThread:()=> 's',sharedQueuedCeiling:()=>options.routineAuthority,readContinuation:()=>undefined,
    peerRoutineTurnOptions:()=>({...options,unattended:false}),sharedRequestEventId:()=>undefined,requestRunCoordination:()=>undefined});
  expect(sharedTurnOptions({toBotId:'b',verb:'ask',unattended:true})).toMatchObject({...options,unattended:true});
});

it('review 5: ordinary activity never walks stored conversations',()=>{
  let mode='auto';
  const bot={id:'b',get tasks():never{throw Error('history scan on activity');}};
  const {decisionLevelStamp}=wiring(['decisionLevelStamp'],{botPermissionMode:()=>mode,internalTurnOwners:new Map([['live',{botId:'b',generation:'g'}]]),store:{projectBotForTask:()=>({})}});
  expect(()=>decisionLevelStamp(bot)).not.toThrow();
  const first=decisionLevelStamp(bot);
  expect(first.level).toBe('auto');
  expect([...first.turns]).toEqual([['g','auto']]);
  mode='unlimited';expect(decisionLevelStamp(bot).level).toBe('unlimited');
});

it('review 3: shared routine reads durable request ancestry after the source generation is gone',()=>{
  const queued={id:'request',fromBotId:'source',toBotId:'recipient',verb:'ask'};
  const {sharedTurnOptions}=wiring(['sharedTurnOptions'],{store:{bot:()=>({})},requestSourceThread:()=> 's',sharedQueuedCeiling:()=>({permissionMode:'auto',triggerSource:'schedule'}),
    readContinuation:()=>({actor:'owner-routine',initiator:{...routine,sourceBotId:'source'}}),
    peerRoutineTurnOptions:(_:any,__:any,___:any,queued:any)=>({routineAuthority:queued,...(queued.decisionRoutineSource?{decisionRoutineSource:queued.decisionRoutineSource}:{})}),
    sharedRequestEventId:()=>undefined,requestRunCoordination:()=>undefined});
  expect(sharedTurnOptions(queued).decisionRoutineSource).toMatchObject({sourceRunId:'run',sourceBotId:'source'});
});

it('review 5: unchanged task sets and generation churn never trigger posture processing',()=>{
  const {decisionLevelsChanged}=wiring(['decisionLevelsChanged']);
  const snapshot=(level:string,turns:any[])=>({level,turns:new Map(turns)});
  const before=snapshot('auto',[['g','full']]);
  expect(decisionLevelsChanged(before,snapshot('auto',[['g','full'],['new','ask']]))).toBe(false);
  expect(decisionLevelsChanged(before,snapshot('auto',[]))).toBe(false);
  expect(decisionLevelsChanged(before,snapshot('auto',[['g','ask']]))).toBe(true);
  expect(decisionLevelsChanged(before,snapshot('unlimited',[['g','full']]))).toBe(true);
});
it('review 3: shared source is saved before generation release and re-read at dispatch',async()=>{
  let finish!:()=>void;const done=new Promise<void>(resolve=>{finish=resolve;});
  const provenance=new Map([['g',{botId:'source',initiator:routine}]]),pending=new Map(),saved=new Map();
  const saveContinuation=vi.fn((key:any)=>{const captured=provenance.get('g');return done.then(()=>{saved.set(JSON.stringify(key),{actor:'owner-routine',initiator:captured!.initiator});});});
  const globals={turnGenerationFor:()=> 'g',decisionProvenance:provenance,decisionSharedSaves:pending,saveContinuation,
    readContinuation:(key:any)=>saved.get(JSON.stringify(key)),settleRoomAsk:vi.fn(),decisionAuthorities:new Map(),decisionRequestTargets:new Map(),decisionQueuePorts:new Map(),
    deleteContinuation:async()=>{},cancelRequests:async()=>{}};
  const {captureDecisionSharedSource,releaseDecisionProvenance}=wiring(['captureDecisionSharedSource','releaseDecisionProvenance'],globals);
  captureDecisionSharedSource({id:'request'},'s','source');
  const released=releaseDecisionProvenance('s','g');
  await new Promise(resolve=>setImmediate(resolve));expect(provenance.has('g')).toBe(true);
  expect(saveContinuation).toHaveBeenCalledWith({kind:'background-job',id:'shared-peer:request',threadId:'s',botId:'source'},{threadId:'s',generation:'g'});
  finish();await released;
  expect(provenance.has('g')).toBe(false);
  expect(saved.size).toBe(1);
});
it('review 5: a permission edit before the first activity event still changes posture',()=>{
  let mode='full';
  const bot={id:'b',mode:'auto'},levels=new Map([['b',{level:'auto',turns:new Map()}]]);
  const {recordDecisionProvenance,decisionLevelStamp,decisionLevelsChanged}=wiring(['recordDecisionProvenance','decisionLevelStamp','decisionLevelsChanged'],{
    decisionProvenance:new Map(),decisionBotLevels:levels,store:{bot:()=>bot,projectBotForTask:()=>({mode})},
    botPermissionMode:(holder:any)=>holder.mode,internalTurnOwners:new Map([['t',{botId:'b',generation:'g'}]]),
  });
  recordDecisionProvenance({botId:'b',threadId:'t',generation:'g',initiator:{k:'owner-typed'}});
  mode='ask';
  expect(decisionLevelsChanged(levels.get('b'),decisionLevelStamp(bot))).toBe(true);
});
