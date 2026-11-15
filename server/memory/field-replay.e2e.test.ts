// SPDX-License-Identifier: AGPL-3.0-or-later
// G-NL A13b: real index.ts child, real HTTP/SSE/journals, fake engines only.
import { it } from 'vitest';
import { hostDenyRequest, assertHostDenyRequest } from './field-replay/controls.ts';
import { Harness, Blocked, record, poll, verdict } from './field-replay/harness.ts';
import { assertSurfaceCounts, BehavioralRed, requireFact } from './field-replay/surface.ts';

let h:Harness;
async function replay(id:string,run:()=>Promise<Record<string,unknown>>,registerClone=true){
 const started=Date.now();h=new Harness();
 try{
  await h.start(registerClone);
  const facts=await run();for(const surface of h.surfaces)await surface.recheck();await h.close();record({id,outcome:'GREEN',elapsedMs:Date.now()-started,...facts});
 }catch(error){
  if(h.lastTurn&&h.child?.exitCode===null&&!h.child.signalCode){
   try{h.facts.counts=await h.lastTurn.surface.counts(h.facts.runThread?[String(h.facts.mark&&(h.facts.mark as any).threadId),String(h.facts.runThread)]:[h.lastTurn.threadId]);}catch{/* Keep the original blocker when the surface is unavailable. */}
  }
  await h.close();
  record({...h.facts,id,outcome:verdict(error),assertion:error instanceof Error?error.message:String(error),facts:error instanceof BehavioralRed?error.facts:undefined,elapsedMs:Date.now()-started});
  throw error;
 }
}
for(const [id,source] of [['R1','cloned folder'],['R2','earlier turn'],['R3','web page']] as const){
 it(`${id}: owner No limits proposal after ${source}`,()=>replay(id,async()=>{
  const turn=await h.outside(source);
  try{const proposal=await h.proposal(turn);const counts=await h.applied(turn,proposal);return {mark:turn.mark,priorMark:turn.priorMark,counts,routineId:proposal.routine.id,toolReply:proposal.result.text};}
  finally{await h.stopTurn(turn);}
 },source!=='web page'),90_000);
}
it('R4: forBot create and target update after cloned folder',()=>replay('R4',async()=>{
 const source=await h.outside('cloned folder'),target=await h.bot('Field target');
 let created:any;let sourceCounts:any;
 try{created=await h.proposal(source,{forBot:target});sourceCounts=await h.applied(source,created);requireFact(created.routine.botId===target.id,'forBot target effect missing',created);}
 finally{await h.stopTurn(source);}
 await h.cwd(target,h.clone);const turn=await h.held(target);await h.mark(turn,'cloned folder');
 try{const updated=await h.proposal(turn,{update:created.routine.id});const counts=await h.applied(turn,updated);requireFact(updated.routine.id===created.routine.id,'update must preserve routine id',updated);return {mark:source.mark,targetMark:turn.mark,counts,sourceCounts,routineId:updated.routine.id};}
 finally{await h.stopTurn(turn);}
}),120_000);
for(const preconditionOnly of [false,true])for(const forBot of [false,true])it(`R5${preconditionOnly?'-mark':''}: real run-now dispatch${forBot?' forBot':''}${preconditionOnly?' outside precondition':' and run-mounted memory save'}`,()=>replay(`R5${preconditionOnly?'-mark':''}${forBot?'-forBot':''}`,async()=>{
 const owner=await h.outside('cloned folder');let proposal:any;const target=forBot?await h.bot('Run target'):owner.bot;
 try{proposal=await h.proposal(owner,{forBot:forBot?target:undefined});await h.applied(owner,proposal);}
 finally{await h.stopTurn(owner,true);}
 // Set the bot default before dispatch: new run tasks have their own cwd.
 const cwd=await h.call('PATCH',`/api/bots/${target.id}`,{cwd:h.clone});
 requireFact(cwd.status===200,'R5 run target clone cwd must persist',cwd);
 // The owner's subscription predates creation of the run thread.
 const runStartedAt=Date.now();
 const started=await h.call('POST',`/api/routines/${proposal.routine.id}/run`);
 if(started.status>=500)throw new Blocked(JSON.stringify(started));
 requireFact(started.status===201&&started.body.run?.id,'run-now effect missing',started);
 const run=await poll(async()=>{const all=(await h.call('GET','/api/routines')).body.runs;return all?.find((r:any)=>r.id===started.body.run.id&&r.threadId);},'run thread');
 const turn=await h.held(target,true,run.threadId,false);
 // The original subscription was open before run start and observes both threads.
 turn.surface.close();turn.surface=owner.surface;turn.startedAt=runStartedAt;
 try{
  requireFact(['running','done','completed'].includes(run.status),'run must reach running/done',run);
  h.facts={...h.facts,runId:run.id,runThread:run.threadId,runStatus:run.status};
  const runMark=await h.mark(turn,forBot?'cloned folder':['cloned folder','memory']);
  h.facts.runMark=runMark;
  requireFact(runMark.threadId===run.threadId&&run.threadId!==owner.threadId,'R5 outside mark must belong to the execution thread',{runMark,ownerThread:owner.threadId,run});
  if(preconditionOnly)return {mark:owner.mark,runMark,runId:run.id,runThread:run.threadId,counts:await turn.surface.assert([owner.threadId,run.threadId],0)};
  const saved=await h.memory(turn,'save');const counts=await turn.surface.assert([owner.threadId,run.threadId],0);
  return {mark:owner.mark,runMark,counts,routineId:proposal.routine.id,runId:run.id,runThread:run.threadId,memoryId:saved.result.candidateId};
 }finally{await h.stopTurn(turn);}
}),120_000);
for(const source of ['cloned folder','earlier turn','web page'] as const)for(const operation of ['save','correction'] as const){
 it(`R6: owner ${operation} after ${source} through mounted memory MCP`,()=>replay(`R6-${source}-${operation}`,async()=>{
  let target:string|undefined;
  const turn=await h.outside(source);
  if(operation==='correction'){
   h.facts.stage='correction-seed';
   target=(await h.memory(turn,'save')).result.candidateId;
  }
  h.facts.stage=operation;
  try{const saved=await h.memory(turn,operation,target);return {mark:turn.mark,priorMark:turn.priorMark,counts:saved.counts,memoryId:saved.result.candidateId,targetId:target};}
  finally{await h.stopTurn(turn);if(target)await h.call('POST','/api/memory/action',{action:'forget',kind:'record',id:target});}
 },source!=='web page'),90_000);
}
it('R7 / MS: all counters see a real card; an SSE-blind counter fails',()=>replay('R7-MS',async()=>{
 const turn=await h.outside('cloned folder',{level:'full'});
 try{
  const proposal=await h.proposal(turn);const counts=await turn.surface.assert([turn.threadId],1);
  requireFact(counts.cards[0]?.card?.routineRequest,'MS requires a real routineRequest card',counts);
  let caught=false;
  try{assertSurfaceCounts({...counts,sse:0},1);}catch(error){caught=error instanceof BehavioralRed;}
  requireFact(caught,'MS SSE-blind mutant survived',counts);
  return {mark:turn.mark,counts,counterMutant:'MS',killed:true,toolReply:proposal.result.text};
 }finally{await h.stopTurn(turn);}
}),90_000);
it('R8: routine proposal then genuine declined host-computer request retains exactly one deny card',()=>replay('R8',async()=>{
 const turn=await h.outside('cloned folder');
 try{
  const rule=await h.call('PATCH',`/api/bots/${turn.bot.id}`,{computer:'local',hostComputerConsent:'declined',acknowledgeLocalAuto:true});
  requireFact(rule.status===200,'owner local-computer denial must persist',rule);
  const profile=(await h.call('GET','/api/bots?messages=0')).body.bots.find((b:any)=>b.id===turn.bot.id);
  requireFact(profile?.hostComputerConsent==='declined','deny control needs an actual owner rule',profile);
  const proposal=await h.proposal(turn);const appliedCounts=await h.applied(turn,proposal);
  await turn.surface.nextPhase();
  const request=hostDenyRequest();assertHostDenyRequest(request);h.facts.denyRequest=request;
  // The permission tool waits for an owner answer. Observe the real card
  // first, then deny it so no computer action can ever be authorized.
  let outcome:{value?:any;error?:unknown}|undefined;
  const pending=h.tool(turn,'permission','',request).then(value=>outcome={value},error=>outcome={error});
  try{
   await poll(async()=>{const counts=await turn.surface.counts([turn.threadId]);return counts.transcript||outcome?true:undefined;},'host deny card or engine answer',10_000);
   if(outcome?.error)throw outcome.error;
   const counts=await turn.surface.assert([turn.threadId],1,'deny');
   return {mark:turn.mark,rule:{kind:'host-computer',scope:'local-computer',consent:profile.hostComputerConsent},denyRequest:request,appliedCounts,counts,routineId:proposal.routine.id,toolReply:proposal.result.text};
  }finally{
   const counts=await turn.surface.counts([turn.threadId]);
   const card=counts.cards.find((m:any)=>m.card?.requestId&&!m.card.answered);
   if(card)await h.call('POST',`/api/threads/${turn.threadId}/respond`,{requestId:card.card.requestId,behavior:'deny'});
   else await h.call('POST',`/api/bots/${turn.bot.id}/interrupt`,{threadId:turn.threadId});
   const result=await pending;if('error'in result)throw result.error;
  }
 }
 finally{await h.stopTurn(turn);}
}),90_000);
it('R8-wipe: rm -rf ~ instruction keeps its card when classified as an effect',()=>replay('R8-wipe',async()=>{
 const turn=await h.outside('cloned folder');
 try{
  const proposal=await h.proposal(turn,{instructions:'rm -rf ~'});
  // readCode only determines whether this conditional control applies. No
  // decision/approval/routine producer module is imported by this replay.
  const {readCode}=await import('../no-limits-code.ts');
  const classified=readCode('mcp',{instructions:'rm -rf ~'}).reads.some((r:any)=>r.state==='effect'&&['root','home','system','disk','fork'].includes(r.cls));
  const counts=await turn.surface.assert([turn.threadId],classified?1:0);
  return {mark:turn.mark,counts,classifiedAsWipe:classified,toolReply:proposal.result.text};
 }finally{await h.stopTurn(turn);}
}),90_000);
for(const control of ['peer','full'] as const)it(`R9: ${control} keeps BASE card`,()=>replay(`R9-${control}`,async()=>{
 const turn=control==='peer'?await h.peer():await h.outside('cloned folder',{level:'full'});
 try{const proposal=await h.proposal(turn);const counts=await turn.surface.assert([turn.threadId],1);requireFact(counts.cards[0]?.card?.routineRequest,'BASE routine card missing',counts);return {mark:turn.mark,counts,control,toolReply:proposal.result.text};}
 finally{await h.stopTurn(turn);}
}),90_000);
for(const source of ['cloned folder','earlier turn','web page'] as const)it(`R10: ${source} mark precondition names current turn and generation`,()=>replay(`R10-${source}`,async()=>{
 const turn=await h.outside(source);try{return {mark:turn.mark,priorMark:turn.priorMark,counts:await turn.surface.assert([turn.threadId],0)};}finally{await h.stopTurn(turn);}
},source!=='web page'),90_000);
