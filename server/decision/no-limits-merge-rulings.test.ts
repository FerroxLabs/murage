// SPDX-License-Identifier: AGPL-3.0-or-later
// Sean / MAIN 2026-11-12: only a visible catastrophe holds an owner turn.
// All command strings are inert; only the fake transport receives replies.
import {mkdtempSync, symlinkSync} from 'node:fs';
import {tmpdir, homedir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, it, vi} from 'vitest';
import {fixture, d, baseCard, baseRun, card} from './fixture.ts';
import {readRecord} from './records.ts';
import {guardEngineRelease} from './provider-release.ts';
import {noLimitsWipe} from '../no-limits-wipe.ts';
import {noLimitsAppliesTo} from '../no-limits-origin.ts';
import {permissionsForOrigin, installPermissionInheritance} from '../permission-inheritance.ts';
import {bindHumanThread, observeVerifiedHuman, linkHumanBinding, resolveHumanBinding} from '../human-principals.ts';
import {ownerMemoryTicket} from '../memory/authority.ts';
import {removeTempDirSync} from '../testing/cleanup.ts';
import {bindServiceTurn,serviceNoLimits} from '../service-no-limits.ts';
const dirs:string[]=[];
let reset=()=>{};
afterEach(()=>{reset();for(const dir of dirs.splice(0))removeTempDirSync(dir);});

it('C1 an owner write through a credential symlink reaches native delivery without a card',async()=>{
 const root=mkdtempSync(join(tmpdir(),'nolim-merge-link-'));dirs.push(root);
 const path=join(root,'config');symlinkSync(join(homedir(),'.ssh','config'),path);
 const f=fixture();
 const h=f.open('link',{path,content:'fixture'},{tool:'write_file',toolCall:{name:'write_file',input:{path,content:'fixture'}}});
 expect(d.decide(h,baseCard).kind).toBe('run');await d.deliverRequest(h);
 expect(f.respond).toHaveBeenCalledTimes(1);expect(f.respond.mock.calls[0][1].behavior).toBe('allow');
 expect(guardEngineRelease({threadId:'t',requestId:'link',turnId:'turn',providerInstanceId:'p'})).toBe(true);
 expect(d.openApprovals('t')).toHaveLength(0);expect(f.interrupt).not.toHaveBeenCalled();f.dispose();
});
it('C1 changed non-wipe input between decision and release still runs',async()=>{
 const f=fixture(),h=f.open('changed',{command:'printf ok'});expect(d.decide(h,baseCard).kind).toBe('run');
 f.publish(f.event('changed',{command:'printf changed > ~/.ssh/config'}));await d.deliverRequest(h);
 expect(f.respond).toHaveBeenCalledTimes(1);expect(f.respond.mock.calls[0][1].behavior).toBe('allow');
 expect(d.openApprovals('t')).toHaveLength(0);expect(f.interrupt).not.toHaveBeenCalled();f.dispose();
});
it('C1 a wipe introduced after the decision holds at final delivery',async()=>{
 const f=fixture(),h=f.open('late-wipe',{command:'printf ok'});expect(d.decide(h,baseRun).kind).toBe('run');
 f.publish(f.event('late-wipe',{command:'rm -rf ~'}));await d.deliverRequest(h);
 expect(f.respond).not.toHaveBeenCalled();expect(d.openApprovals('t')).toContainEqual(expect.objectContaining({why:'wipe'}));f.dispose();
});
it('C1 a native replay or missing registry entry cannot hold non-wipe owner work',()=>{
 const f=fixture(),h=f.open('cache',{command:'printf ok'});expect(d.decide(h,baseRun).kind).toBe('run');
 expect(guardEngineRelease({threadId:'t',requestId:'cache',turnId:'turn',providerInstanceId:'p'},undefined,{tool:'Bash',input:{command:'touch ~/.ssh/config'}})).toBe(true);
 expect(guardEngineRelease({threadId:'t',requestId:'not-captured',turnId:'turn',providerInstanceId:'p'},{command:'printf ok'})).toBe(true);
 expect(guardEngineRelease({threadId:'t',requestId:'not-captured',turnId:'turn',providerInstanceId:'p'},{command:'rm -rf ~'})).toBe(false);
 f.dispose();
});
it.each(['full','unlimited'] as const)('C2 legacy %s bot never gives its level to a stranger',level=>{
 reset=installPermissionInheritance(()=>true);const f=fixture(level);
 const bot=f.store.createBot({name:'Legacy guest fixture'},{seedMessages:false});
 f.store.patchBot(bot.id,{autoApprove:true,fullAccess:true,noLimits:level==='unlimited',permissionExplicit:false});
 const binding=observeVerifiedHuman({platform:'slack',authorityId:'FIXTURE',connectionId:'merge-guest',userId:'GUEST'});
 linkHumanBinding(ownerMemoryTicket(),{bindingId:binding,expectedRevision:1,as:'person'});bindHumanThread(bot.threadId,resolveHumanBinding(binding));
 expect(f.store.projectBotForTask(bot.id,bot.threadId)).toMatchObject({autoApprove:false,fullAccess:false,noLimits:false});
 for(const origin of ['guest','other-human','other'] as const){
  expect(noLimitsAppliesTo(origin,{autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:false})).toBe(false);
  expect(noLimitsAppliesTo(origin,{autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true})).toBe(false);
 }
 f.store.patchBot(bot.id,{permissionExplicit:true});
 expect(f.store.projectBotForTask(bot.id,bot.threadId)).toMatchObject({autoApprove:false,fullAccess:false,noLimits:false});
 for(const origin of ['guest','other-human','other'] as const)expect(noLimitsAppliesTo(origin,{autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true})).toBe(false);
 expect(permissionsForOrigin({autoApprove:true,fullAccess:true,noLimits:true},false)).toMatchObject({autoApprove:false,fullAccess:false,noLimits:false});f.dispose();
});
it.each(['full','unlimited'] as const)('R1 a webhook retains its bot level %s even when not an owner chat',level=>{
 const f=fixture(level,{k:'webhook'});f.setOwner(false);
 // GROK-NOLIMFO2: O6/R1 requires live owner proof; an owner webhook retains its level.
 expect(d.readTurnPolicy({threadId:'t',generation:'g'})).toMatchObject({level:'ask',permission:{routeAsks:true,askLevel:true}});
 expect(d.readTurnPolicy({threadId:'t',generation:'g'})?.permission.noLimits).not.toBe(true);
 expect(d.decide(f.open('unproven-hook',{command:'printf ok'}),baseCard).kind).toBe('card');
 f.setOwner(true);
 expect(d.readTurnPolicy({threadId:'t',generation:'g'})).toMatchObject({level});
 expect(d.decide(f.open('guest-hook',{command:'printf ok'}),baseCard).kind).toBe(level==='unlimited'?'run':'card');f.dispose();
});
it('H1 an owner-only live thread survives a stale engine snapshot without recarding',async()=>{
 const f=fixture(),h=f.open('restarted',{command:'printf ok'},{turnId:'previous-process'});
 expect(d.decide(h,baseCard).kind).toBe('run');await d.deliverRequest(h);
 expect(f.respond).toHaveBeenCalledTimes(1);expect(d.openApprovals('t')).toHaveLength(0);f.dispose();
});
// MAIN RULING: "owner No limits authority comes ONLY from an authenticated owner turn (the turn's own verified origin), never from thread ownership".
// Retain the historical acceptance ID; its assertions now enforce authenticated-turn authority.
it('H2 persisted owner proof survives a missing live record, while visible wipes still card',()=>{
 const f=fixture();
 d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>undefined,live:()=>({botId:'b',turnId:'turn',providerInstanceId:'p',principal:'owner',owner:true,level:'unlimited'}),
  ownerThread:()=>({botId:'b',principal:'owner',level:'unlimited',origin:'owner'})} as Parameters<typeof d.installProvenanceReader>[0]);
 expect(d.decide(f.open('identity',{command:'printf ok'}),baseCard).kind).toBe('card');
 expect(d.decide(f.open('identity-wipe',{command:'rm -rf ~'}),baseCard).kind).toBe('card');f.dispose();
});
// MAIN RULING: "guests and other people threads ALWAYS Ask, even on a bot explicitly at No limits".
// Retain the historical acceptance ID; its assertions now enforce authenticated-turn authority.
it('H1 queued phone words keep their content origin while the persisted owner-only thread runs wipe-only',()=>{
 const f=fixture('unlimited',{k:'other-human'});
 d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>({generation:'g',threadId:'t',botId:'b',principal:'owner',roomOwnerOnly:false,at:1,initiator:{k:'other-human'}}),
  live:()=>({botId:'b',turnId:'turn',providerInstanceId:'p',principal:'owner',owner:false,level:'unlimited'}),
  ownerThread:()=>({botId:'b',principal:'owner',level:'unlimited',origin:'unattended'})});
 expect(d.decide(f.open('phone',{command:'printf ok'}),baseCard).kind).toBe('card');
 expect(d.openApprovals('t')).toHaveLength(0);f.dispose();
});
// MAIN RULING: "owner No limits authority comes ONLY from an authenticated owner turn (the turn's own verified origin), never from thread ownership".
// Retain the historical acceptance ID; its assertions now enforce authenticated-turn authority.
it('H5 service policy uses the same recovered owner predicate as engine policy',()=>{
 const f=fixture();let active=true;
 d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>undefined,live:()=>({botId:'b',turnId:'turn',providerInstanceId:'p',principal:'owner',owner:true,level:'unlimited'}),
  ownerThread:()=>({botId:'b',principal:'owner',level:'unlimited',origin:'owner'})});
 bindServiceTurn('g','t','b',()=>active,()=>({ownerAudience:false,origin:'unproven',noLimits:true}));
 expect(d.readTurnPolicy({threadId:'t',generation:'g'})).toMatchObject({actor:'unproven',level:'ask',permission:{routeAsks:true,askLevel:true}});
 expect(serviceNoLimits('g','t','b')).toBe(false);active=false;f.dispose();
});
it.each(['eval "$(ssh-agent -s)"','eval "$(brew shellenv)"','eval "$(pyenv init -)"','eval "$OPAQUE"'])('H3 unresolved evaluation runs: %s',command=>{
 // MAIN RULING: REDESIGN-WIPE-NARROW §4.4: opaque eval is not wipe evidence.
 const card=false;expect(!!noLimitsWipe(command)).toBe(card);const f=fixture();expect(d.decide(f.open('eval',{command}),baseCard).kind).toBe(card?'card':'run');f.dispose();
});
it('H3 unresolved evaluation cannot hide a visible tail catastrophe',()=>{
 const f=fixture();expect(d.decide(f.open('eval-wipe',{command:'eval "$(ssh-agent -s)"; rm -rf ~'}),baseRun).kind).toBe('card');f.dispose();
});

it('C1 explicit Stop cancels release even at No limits',async()=>{
 const f=fixture(),h=f.open('stopped',{command:'printf ok'});expect(d.decide(h,baseRun).kind).toBe('run');
 await d.cancelRequests({kind:'generation',threadId:'t',generation:'g'},'cancelled');
 expect(guardEngineRelease({threadId:'t',requestId:'stopped',turnId:'turn',providerInstanceId:'p'},undefined,{tool:'Bash',input:{command:'printf ok'}})).toBe(false);
 f.dispose();
});

const stoppedScope={kind:'generation' as const,threadId:'t',generation:'g'};
const releaseIdentity=(requestId:string)=>({threadId:'t',requestId,turnId:'turn',providerInstanceId:'p'});
const replayCall={tool:'Bash',input:{command:'printf ok'}};
function deferredDelivery(){
 let resolve!:(value:{state:'accepted'})=>void, reject!:(reason:Error)=>void;
 const promise=new Promise<{state:'accepted'}>((yes,no)=>{resolve=yes;reject=no;});
 let started!:()=>void;const dispatched=new Promise<void>(yes=>{started=yes;});
 return {promise,resolve,reject,started,dispatched};
}
function nativeAllow(f:ReturnType<typeof fixture>,requestId:string){
 f.publish({type:'request.resolved',...releaseIdentity(requestId),behavior:'allow'});
}
// Observe the existing handle registration only while opening this request.
// This checks private replay bookkeeping without adding a production test API
// or changing any entry. All policy/delivery calls still use the real core.
function observedRequest(open:()=>d.RequestHandle){
 const writes=vi.spyOn(WeakMap.prototype,'set');
 try{
  const handle=open();
  const value=writes.mock.calls.find(([key])=>key===handle)?.[1] as {
   cancelled?:boolean;successfulRelease?:boolean;receiptDelivery?:d.DeliveryState;
   receiptAnswer?:d.ApprovalAnswer;
  }|undefined;
  if(!value)throw Error('decision handle registration missing');
  return {handle,entry:value};
 }finally{writes.mockRestore();}
}

it('R1 Stop after confirmed owner Allow fences native release and replay',async()=>{
 const f=fixture(),h=f.open('confirmed-stop',replayCall.input);
 try{
  expect(d.decide(h,baseRun).kind).toBe('run');await d.deliverRequest(h);
  const receipt=d.readRequestExecution(h);
  expect(receipt).toMatchObject({delivery:'accepted',answer:{behavior:'allow'}});
  await d.cancelRequests(stoppedScope,'cancelled');
  expect(guardEngineRelease(releaseIdentity('confirmed-stop')), 'R1 native release fenced').toBe(false);
  expect(guardEngineRelease(releaseIdentity('confirmed-stop'),undefined,replayCall), 'R1 replay fenced').toBe(false);
  expect(d.readRequestExecution(h), 'R1 accepted receipt unchanged').toEqual(receipt);
  expect(f.respond).toHaveBeenCalledTimes(1);
 }finally{f.dispose();}
});

it.each(['before Stop','after Stop'] as const)('R2 native Allow %s cannot authorize a stopped in-flight request',async timing=>{
 const f=fixture(),flight=deferredDelivery();let delivery:Promise<void>|undefined;
 const {handle:h,entry}=observedRequest(()=>f.open('racing-stop',replayCall.input));
 f.respond.mockImplementation(()=>{flight.started();return flight.promise;});
 try{
  expect(d.decide(h,baseRun).kind).toBe('run');delivery=d.deliverRequest(h);await flight.dispatched;
  if(timing==='before Stop')nativeAllow(f,'racing-stop');
  await d.cancelRequests(stoppedScope,'cancelled');
  if(timing==='after Stop')nativeAllow(f,'racing-stop');
  // A pre-Stop native success remains historical; a late ack creates no
  // successful release. Both event orders must fence every future replay.
  expect(entry.successfulRelease, 'R2 late ack does not seed replay').toBe(timing==='before Stop'?true:undefined);
  expect(entry.cancelled, 'R2 cancellation fence set').toBe(true);
  flight.resolve({state:'accepted'});await delivery;
  expect(guardEngineRelease(releaseIdentity('racing-stop')), 'R2 native release fenced').toBe(false);
  expect(guardEngineRelease(releaseIdentity('racing-stop'),undefined,replayCall), 'R2 replay fenced').toBe(false);
  expect(d.readRequestExecution(h)).toMatchObject({delivery:'accepted',answer:{behavior:'allow'}});
  expect(f.respond).toHaveBeenCalledTimes(1);
  expect(f.interrupt).not.toHaveBeenCalled();
  expect(f.store.messagesFor('t').some(m=>m.text?.includes('could not be delivered'))).toBe(false);
 }finally{flight.resolve({state:'accepted'});await delivery;f.dispose();}
});

it('R3 Stop before service execution refuses without calling the service',async()=>{
 const f=fixture(),execute=vi.fn(async()=> 'fixture result');
 try{
  const h=d.openRequest({kind:'service',service:'email',claim:f.claim,call:{tool:'Bash',input:replayCall.input}});
  expect(d.decide(h,baseRun).kind).toBe('run');await d.cancelRequests(stoppedScope,'cancelled');
  expect(await d.executeService(h,execute), 'R3 cancelled service refused').toMatchObject({kind:'refuse'});
  expect(execute, 'R3 cancelled service never starts').not.toHaveBeenCalled();
 }finally{f.dispose();}
});

it('R3 Stop during final service revalidation refuses before execution starts',async()=>{
 const f=fixture(),execute=vi.fn(async()=> 'fixture result');let stop:Promise<void>|undefined;
 const h=d.openRequest({kind:'service',service:'email',claim:f.claim,call:{tool:'Bash',input:replayCall.input}});
 expect(d.decide(h,baseRun).kind).toBe('run');let revalidations=0;
 const dispose=d.installDecisionObserver(event=>{
  // executeService refreshes once before scheduling and again immediately
  // before its final release check. Cancel synchronously in that second read.
  if(event.type==='decided'&&event.kind==='run'&&++revalidations===2)stop=d.cancelRequests(stoppedScope,'cancelled');
 });
 try{
  expect(await d.executeService(h,execute), 'R3 final cancellation check refuses').toMatchObject({kind:'refuse'});
  expect(revalidations).toBe(2);expect(stop).toBeDefined();await stop;
  expect(execute, 'R3 final cancellation check prevents service call').not.toHaveBeenCalled();
 }finally{dispose();f.dispose();}
});

it('R4 Stop after an accepted non-owner card fences native release and replay',async()=>{
 const f=fixture('ask',{k:'other-human'}),h=f.open('other-stop',replayCall.input);
 try{
  const ref=card(d.decide(h,baseCard));await d.presentApproval(ref,{title:'Action',subtitle:'Fixture'});
  await d.answerApproval(ref,{behavior:'allow'});
  expect(d.readRequestExecution(h)).toMatchObject({delivery:'accepted',answer:{behavior:'allow'}});
  expect(guardEngineRelease(releaseIdentity('other-stop'))).toBe(true);
  await d.cancelRequests(stoppedScope,'cancelled');
  expect(guardEngineRelease(releaseIdentity('other-stop')), 'R4 non-owner native release fenced').toBe(false);
  expect(guardEngineRelease(releaseIdentity('other-stop'),undefined,replayCall), 'R4 non-owner replay fenced').toBe(false);
 }finally{f.dispose();}
});

it('R4 a cancelled owner receipt in Ask refuses before inspecting cache replay',async()=>{
 const f=fixture(),h=f.open('changed-posture-stop',replayCall.input),readInput=vi.fn(()=>replayCall.input);
 try{
  expect(d.decide(h,baseRun).kind).toBe('run');await d.deliverRequest(h);nativeAllow(f,'changed-posture-stop');
  f.setLevel('ask');f.setOwner(false);await d.cancelRequests(stoppedScope,'cancelled');
  const replay={tool:'Bash',get input(){return readInput();}};
  expect(guardEngineRelease(releaseIdentity('changed-posture-stop'),undefined,replay)).toBe(false);
  expect(readInput, 'R4 cancellation fences before cache replay inspection').not.toHaveBeenCalled();
 }finally{f.dispose();}
});

it.each([false,true])('R5 Stop preserves the answered accepted Allow row and card (in flight=%s)',async inFlight=>{
 const f=fixture('ask'),flight=deferredDelivery(),h=f.open('history-stop',replayCall.input);let delivery:Promise<void>|undefined;
 try{
  const ref=card(d.decide(h,baseCard));await d.presentApproval(ref,{title:'Action',subtitle:'Fixture'});
  f.setLevel('unlimited');
  if(inFlight)f.respond.mockImplementation(()=>{flight.started();return flight.promise;});
  delivery=d.answerApproval(ref,{behavior:'allow'});
  if(inFlight){await flight.dispatched;nativeAllow(f,'history-stop');}else await delivery;
  const row=readRecord(f.db,ref.approvalId)!;
  expect(row).toMatchObject({state:'answered',delivery:'accepted'});
  expect(JSON.parse(row.answer!)).toEqual({behavior:'allow'});
  const beforeCard=structuredClone(f.store.messageById('t',row.chat_message_id)!.card);
  await d.cancelRequests(stoppedScope,'cancelled');flight.resolve({state:'accepted'});await delivery;
  expect(readRecord(f.db,ref.approvalId), 'R5 historical row unchanged').toEqual(row);
  expect(f.store.messageById('t',row.chat_message_id)!.card, 'R5 card never patched Cancelled').toEqual(beforeCard);
  expect(d.readRequestExecution(h)).toMatchObject({delivery:'accepted',answer:{behavior:'allow'}});
  expect(guardEngineRelease(releaseIdentity('history-stop'),undefined,replayCall)).toBe(false);
  expect(f.respond).toHaveBeenCalledTimes(1);expect(f.interrupt).not.toHaveBeenCalled();
  expect(f.store.messagesFor('t').some(m=>m.text?.includes('could not be delivered'))).toBe(false);
 }finally{flight.resolve({state:'accepted'});await delivery;f.dispose();}
});

it('R6 rowless native Allow receipt survives a rejected transport without retry',async()=>{
 const f=fixture(),flight=deferredDelivery(),h=f.open('receipt-reject',replayCall.input);
 f.respond.mockImplementation(()=>{flight.started();return flight.promise;});
 try{
  expect(d.decide(h,baseRun).kind).toBe('run');const delivery=d.deliverRequest(h);await flight.dispatched;
  nativeAllow(f,'receipt-reject');expect(d.readRequestExecution(h).delivery).toBe('accepted');
  flight.reject(Error('fixture transport rejected'));await delivery;
  expect(d.readRequestExecution(h).delivery, 'R6 native receipt never downgraded').toBe('accepted');
  expect(f.respond, 'R6 accepted native receipt prevents second respond').toHaveBeenCalledTimes(1);
  expect(f.interrupt).not.toHaveBeenCalled();
  expect(f.store.messagesFor('t').some(m=>m.text?.includes('could not be delivered'))).toBe(false);
 }finally{f.dispose();}
});

it('H3 a literal home assignment remains a visible catastrophe in a live owner context',()=>{
 const command='nolim_wipe=~; rm -rf "${nolim_wipe:?}"';
 expect(noLimitsWipe(command,{cwd:'/tmp/fixture-work',project:'/tmp/fixture-work',home:homedir()})).not.toBeNull();
 const f=fixture();
 expect(d.decide(f.open('assignment-wipe',{command,cwd:'/tmp/fixture-work'}),baseRun).kind).toBe('card');f.dispose();
});

it.each(['nolim_wipe=notes; rm -rf "${nolim_wipe:?}"','unset target; rm -rf "${target:?}"','unset target; rm -rf "${target:?rm -rf /}"'])('H3 error guards with no executable catastrophe run: %s',command=>{
 expect(noLimitsWipe(command,{cwd:'/tmp/fixture-work',home:homedir()})).toBeNull(); // MAIN RULING: REDESIGN-WIPE-NARROW §4.4: opaque/error operands run.
 // MAIN RULING: REDESIGN-WIPE-NARROW §4.4/§8 T12: error-guarded operands do not execute a wipe.
 const f=fixture();expect(d.decide(f.open('guard-data',{command,cwd:'/tmp/fixture-work'}),baseRun).kind).toBe('run');f.dispose();
});

// MAIN RULING: REDESIGN-WIPE-NARROW §0 (Sean, 2026-11-13).
it('H6 a visible Ruby wipe survives an earlier protected-path finding',()=>{
 for(const command of [`ruby -e 'require "fileutils"; FileUtils.rm_rf("/")'`,`touch /etc/motd; ruby -e 'require "fileutils"; FileUtils.rm_rf("/")'`]){
  // MAIN RULING WIPE-GATE-BAR / WIPE-V3 S6: restore the literal Ruby root wipe.
  expect(noLimitsWipe(command)?.rule).toBe('delete-root');
  const f=fixture();expect(d.decide(f.open('ruby-wipe',{command}),baseRun).kind).toBe('card');f.dispose();
 }
});
it('H6 Git push dry runs do not become catastrophe findings',()=>{
 for(const command of ['git push --mirror --dry-run','git push --mirror -n']){expect(noLimitsWipe(command)).toBeNull();const f=fixture();expect(d.decide(f.open('dry-run',{command}),baseRun).kind).toBe('run');f.dispose();}
 expect(noLimitsWipe('git push --mirror')).toBeNull();
 expect(noLimitsWipe('git push --mirror --push-option --dry-run')).toBeNull();
});
it.each([`ruby -e 'puts "ordinary"'`,'ruby -e '+JSON.stringify(`puts 'FileUtils.rm_rf("/")'`),'ruby -e '+JSON.stringify(`puts 'FileUtils.rm_rf("/")`),'ruby -e '+JSON.stringify('puts <<~TEXT\nFileUtils.rm_rf("/")\nTEXT\n'),'ruby -e '+JSON.stringify('# FileUtils.rm_rf("/")'),'ruby -e '+JSON.stringify('=begin\nFileUtils.rm_rf("/")\n=end\n'),'ruby -e '+JSON.stringify('puts %q{FileUtils.rm_rf("/")}'),'ruby -e '+JSON.stringify('puts %r{FileUtils.rm_rf("/")}'),`echo 'ruby -e FileUtils.rm_rf("/")'`,`ruby -e 'FileUtils.rm_rf("notes")'`])('H6 interpreter data and ordinary deletes still run: %s',command=>{
 const card=false; // MAIN RULING: REDESIGN-WIPE-NARROW §0: Ruby code/data is outside the list.
 expect(noLimitsWipe(command)!==null).toBe(card);
 const f=fixture();expect(d.decide(f.open('ruby-data',{command}),baseRun).kind).toBe(card?'card':'run');f.dispose();
});
