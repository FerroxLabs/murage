import { OWNER_PERMISSION_REPLY_TOO_LARGE } from '../permission-reply.ts';
import {PERMISSION_UNDELIVERED_STOP_REASON,isStopFailed} from './host-stop-interrupt.ts';
import { sanitizeDisplayTextUnit } from '../transcript-page.ts';
import {skillSettlementWork,installSkillSettlementWork} from '../skill-settlement-work.ts';
import { automaticSettlement, UNCONFIRMED_SKILL_SWITCH, type Settlement } from '../skill-switch-settlement.ts';
import { approveTextExecWipeOnce } from '../drivers/murage-exec-wipe.ts';
import { nativeEffectsWipe, nativeWipeBreaker, wipeCheckFault } from '../wipe-breaker.ts';
import { noLimitsWipe } from '../no-limits-wipe.ts';
import { degradedWipeContext, wipeContextFor, wipeEnvironment } from '../wipe/context.ts';
import { sessionScriptContext } from '../no-limits-wipe-scripts.ts';
import { completeDecisionGeneration, installGenerationRetirement } from "./generation-retirement.ts";
import { turnSucceeded } from "../turn-outcome.ts";
import {explicitNoLimits} from '../permission-inheritance.ts';
import { captureWipeInput } from './wipe-input.ts';
import { CHANNEL_MESSAGES_OFF, noLimitsAppliesTo, type NoLimitsOrigin } from '../no-limits-origin.ts';
import { appendDecision } from '../decision-log.ts';
import { cardAuditSummary } from '../approval-text.ts';
import { DATA_DIR } from '../config.ts';
import { afterCommit } from '../tx-scope.ts';
import { recordableAnswers } from '../question-normalize.ts';
import { questionsForCard, foldCardQuestions, foldCardChoices } from '../../shared/questions.ts';
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type * as T from './types.ts';
import { boundedProjection,freeze,hash,canonical,captureDelivery } from './bounds.ts';
import { extractInspectedOperation, exactInputHash, type ExtractedOperation } from '../no-limits-operation.ts';
import { inspectOwnerOperation, type OwnerOperation } from '../no-limits-inspection.ts';
import { RELEASE_SUPERSEDED, releaseGuard, installReleaseContextReader, inspectReleaseWipes, inspectReleaseOperation, approvedEvidenceCovers, type ReleaseInspection, type ReleaseResult, type ReleaseWipeIdentity } from './release-guard.ts';
import { installNativeReleaseReader, type NativeReleaseIdentity } from './provider-release.ts';
import { structuredOwnerDecision } from './action.ts';
import { ownerNlProtectedEvidence } from '../no-limits-authority.ts';
import { describe,describeOwnerNoLimits,protectedEvidence,wipeEvidence } from './action.ts';
import * as records from './records.ts';
import { database,transaction } from '../database.ts';
import { actionProjection, QUEUE_REF_PATHS, CARD_DISPLAY_FIELDS, CARD_TERMINAL_FIELDS } from '../../shared/permission-card.ts';
import { ownerRoutineLevel } from '../../shared/owner-routine-level.ts';
import { withDeadline } from './settle.ts';
import { bindProducerTurnReader, bindProducers, producerBindings, trackedProducerQueue, trackProducerQueue } from './producer-bindings.ts';
import { requiresLiveApprovalRecipient, serviceQueue } from '../narrow-denials.ts';
import { memoryApprovalQueue } from '../memory/authority.ts';
import { scheduleDelivery } from './dispatch.ts';
const REFUSAL='Murage could not confirm this request. Nothing was run.';
const reportedRefusalCauses=new Set<string>();
const engineRefusalCodes=new Set(['engine-approval-builder-missing','invalid-engine-options','request-id-mismatch','queue-identity-missing','reserved-action-field']);
function reportDecisionRefusal(cause:string,kind='engine-approval'):void {
 const key=`${kind}:${cause}`;if(reportedRefusalCauses.has(key))return;
 reportedRefusalCauses.add(key);
 if(cause==='engine-approval-builder-missing') console.error('[decision] ERROR engine-approval-builder-missing');
 else console.error(`[decision] ${kind}-refused cause=${cause}`);
}
let engineBuilder:T.EngineApprovalBuilder|undefined;
let engineBuilderInstalledLogged=false;
let reader:T.ProvenanceReader|undefined,denials:T.DenySources|undefined,host:T.DecisionHost|undefined,transport:T.DecisionTransport|undefined;
const claims=new WeakMap<T.ExecutionClaim,{threadId:string;botId:string;generation:string}>();
const handles=new WeakMap<T.RequestHandle,Entry>(),refs=new WeakMap<T.ApprovalRef,{id:string;epoch:object}>();
const referenceEpochs=new Map<string,object>();
const nativeOffNotices=new Set<string>();
const entriesByApproval=new Map<string,Entry>();
const entries=new Map<string,Entry>(),captures=new Map<string,{snapshot:T.RequestSnapshot;latest:T.RequestSnapshot;conflict:boolean;incomplete:boolean;exact?:ExtractedOperation;latestExact?:ExtractedOperation;upgrade?:T.RequestSnapshot}>();
let wipeInputs=new WeakMap<object,T.RequestSnapshot|T.ServiceCall|null>();
const synchronousQueues=new Map<T.ServiceId,{source:T.QueueRecoverySource;delivery:T.SynchronousQueueDelivery}>();
const answerFlights=new Map<string,Promise<void>>();
const queues=new Map<T.ServiceId,T.QueueRecoverySource>(),observers=new Set<T.DecisionObserver>();
// No limits queues dispatch under the old machine-protection limits. Waiting
// for capacity is never an authorization refusal and has no permission timer.
let noLimitsInFlight=0;
const noLimitsThreads=new Map<string,number>();
const noLimitsWaiters:Array<{threadId:string;start:()=>void}>=[];
function noLimitsSlot<V>(e:Entry,work:()=>Promise<V>,schedule=true):Promise<V>{
 return new Promise<V>((resolve,reject)=>{
  const start=()=>{noLimitsInFlight++;noLimitsThreads.set(e.threadId,(noLimitsThreads.get(e.threadId)??0)+1);
   (schedule?Promise.resolve().then(work):work()).then(resolve,reject).finally(()=>{
    noLimitsInFlight--;const left=(noLimitsThreads.get(e.threadId)??1)-1;if(left)noLimitsThreads.set(e.threadId,left);else noLimitsThreads.delete(e.threadId);
    for(let i=0;i<noLimitsWaiters.length&&noLimitsInFlight<512;){const next=noLimitsWaiters[i];if((noLimitsThreads.get(next.threadId)??0)>=32){i++;continue;}noLimitsWaiters.splice(i,1);next.start();}
   });
  };
  if(noLimitsInFlight>=512||(noLimitsThreads.get(e.threadId)??0)>=32){
   console.warn('[no-limits] request delivery capacity reached; queued without refusing the turn');
   noLimitsWaiters.push({threadId:e.threadId,start});
  }else start();
 });
}
function shedCompletedRequests():void {
 if(entries.size<=512)return;
 for(const [key,value]of entries)if(value.terminal){unindexApprovalEntry(value);entries.delete(key);captures.delete(key);if(entries.size<=512)break;}
}

interface Authority {explicitNoLimits?:boolean;noLimitsOrigin?:NoLimitsOrigin;fullAccessChannelMessages?:boolean;actor:T.Registration['actor'];level:T.Registration['level'];botId:string;generation:string;provenance?:T.TurnProvenance}
interface Entry {approvalIndexId?:string;undeliveredStop?:'pending'|'landed'|'rejected'|'terminal';endedFailed?:boolean;replyTooLargeShown?:boolean;wipeUnknownReleaseUsed?:string;execWipeCreditIssued?:boolean;permissionReplyHold?:string;featureOffNoted?:boolean;wipeReleaseHash?:string;originalOperationHash?:string;releaseRefused?:boolean;successfulRelease?:boolean;releaseUpdatedInput?:T.ApprovalAnswer['updatedInput'];exact?:ExtractedOperation;initialInspection?:ReleaseInspection;releaseApproval?:T.ApprovalRef;handle:T.RequestHandle;registration:T.Registration;authority:Authority;threadId:string;requestId:string;created:number;conflict:boolean;fault?:'reader'|'deny'|'identity'|'overflow';outcome?:T.Outcome;base?:T.BaseVerdictFn;baseValue?:Readonly<ReturnType<T.BaseVerdictFn>>;ref?:T.ApprovalRef;row?:records.RecordRow;attached?:T.QueueAttachment;delivery?:Promise<void>;deliveryStarted?:boolean;execution?:Promise<any>;executionResult?:T.ServiceExecution<any>;executionStarted?:boolean;cancelled?:boolean;cancellation?:'cancelled'|'expired'|'superseded';approvalDeliveryFailed?:boolean;executionCall?:T.ServiceCall;terminal?:boolean;receiptDelivery?:T.DeliveryState;receiptAnswer?:T.ApprovalAnswer}
function observe(e:T.DecisionObservation){for(const fn of observers)try{fn(freeze(e));}catch{}}
function safely<V>(read:()=>V,fallback:V):V {try{return read();}catch{return fallback;}}
function requiredHost(){if(!host)throw new Error('decision-host-missing');return host;}
function authority(threadId:string,botId?:string,generation?:string):Authority {
 const g=safely(()=>reader?.turnGenerationFor(threadId),undefined),live=safely(()=>reader?.live(threadId),undefined),p=g?safely(()=>reader?.provenance(g),undefined):undefined;
 const a:Authority={actor:'unproven',level:'ask',botId:live?.botId??botId??'',generation:g??generation??'',provenance:p?freeze(boundedProjection(p)):undefined};
 // Authenticate the turn before consulting recovery. Thread ownership alone
 // says nothing about who supplied this turn's words.
 if(!p||g!==p.generation||p.threadId!==threadId||(generation&&generation!==g)||(botId&&botId!==p.botId))return a;
 const kind=p.initiator.k;
 if(!p.roomOwnerOnly||kind==='guest'||kind==='other-human'){a.actor='other';a.noLimitsOrigin='other-human';return a;}
 const ownerTurn=kind==='owner-typed'||kind==='owner-channel-dm';
 const recovered=!live&&ownerTurn?safely(()=>reader?.ownerThread?.(threadId),undefined):undefined;
 if(recovered&&p.botId===recovered.botId&&p.principal===recovered.principal){
  const candidate={...a,actor:'owner' as const,level:recovered.level,botId:recovered.botId,noLimitsOrigin:kind==='owner-channel-dm'?'owner-channel' as const:'owner' as const,fullAccessChannelMessages:recovered.fullAccessChannelMessages};
  if(ownerEligible(candidate))return candidate;
 }
 if(!live||!p||g!==p.generation||p.threadId!==threadId||p.botId!==live.botId||p.principal!==live.principal||(generation&&generation!==g)||(botId&&botId!==live.botId))return a;
 // The principal/root proof above cannot authenticate the live turn. In
 // particular an unbound thread defaults to the owner even for unproven words.
 // Refuse before an automated initiator can restore No limits below.
 if(live.owner!==true)return a;
 a.level=live.level;
 const k=p.initiator.k;
 if(!['owner-typed','owner-channel-dm','routine-run','routine-wake','project-room-routine','routine-peer','webhook','other-human','guest','delegation','peer','murage'].includes(k)){a.level='ask';return a;}
 a.fullAccessChannelMessages=live.fullAccessChannelMessages;
 // MM-2: explicit guest/human provenance cannot inherit an unattended owner's No limits authority.
 a.noLimitsOrigin=k==='guest'?'guest':k==='other-human'?'other-human':k==='webhook'?'webhook':k==='peer'||k==='delegation'?'unattended':!live.owner||!p.roomOwnerOnly?'other-human':k==='owner-channel-dm'?'owner-channel':'unattended';
 a.explicitNoLimits=explicitNoLimits(host?.store.bot(live.botId)??{});
 if(a.noLimitsOrigin==='other-human'||a.noLimitsOrigin==='guest')a.level='ask';
 if(k.startsWith('routine-')||k==='project-room-routine'){
  const i=p.initiator as Extract<T.Initiator,{form:string}>,r=live.routine;
  if(!r||r.sourceRunId!==i.sourceRunId||r.sourceBotId!==i.sourceBotId||r.recipientGeneration!==g||i.recipientGeneration!==g||!r.owner){a.noLimitsOrigin='unproven';a.level='ask';return a;}
  a.actor=p.roomOwnerOnly?'owner-routine':'other';
  if(a.actor==='owner-routine'){a.noLimitsOrigin='routine';a.level=ownerRoutineLevel(live.level,live.level,!!host?.store.bot(live.botId)?.draftOnly);}
 }else if(k==='owner-typed'||k==='owner-channel-dm')a.actor=live.owner&&p.roomOwnerOnly&&(k!=='owner-channel-dm'||live.fullAccessChannelMessages!==false)?'owner':'other';
 else a.actor='other';
 if(a.actor==='owner'&&k==='owner-typed')a.noLimitsOrigin='owner';
 return a;
}
const targetOf=(s:T.RequestSnapshot):T.DecisionEngineTarget=>({providerInstanceId:s.providerInstanceId,threadId:s.threadId,generation:s.generation,turnId:s.turnId,requestId:s.requestId});
const scopedKey=(threadId:string,key:string)=>canonical([threadId,key]);
const captureKey=(s:Pick<T.RequestSnapshot,'providerInstanceId'|'generation'|'requestId'>)=>`${s.providerInstanceId}:${s.generation}:${s.requestId}`;
export function installProvenanceReader(r:T.ProvenanceReader){reader=r;bindProducerTurnReader(r);}
export function installDenySources(s:T.DenySources){denials=s;}
export function installDecisionTransport(t:T.DecisionTransport){transport=t;}
export function installDecisionHost(h:T.DecisionHost):()=>void {host=h;installSkillSettlementWork();installGenerationRetirement(identity=>retireRequests({kind:'generation',...identity},'cancelled',true));engineBuilder=undefined;wipeInputs=new WeakMap();entries.clear();entriesByApproval.clear();captures.clear();referenceEpochs.clear();nativeOffNotices.clear();installReleaseContextReader(releaseContext);installNativeReleaseReader(guardEngineRelease,identity=>!!host&&[...entries.values()].some(e=>e.threadId===identity.threadId&&e.requestId===identity.requestId&&e.registration.snapshot?.turnId===identity.turnId&&e.registration.snapshot.providerInstanceId===identity.providerInstanceId&&e.outcome?.kind==='card'&&e.row?.state==='open'),holdPermissionReply);return()=>{if(host===h)host=undefined;};}
export function installClaimVerifier(verifier:T.ClaimVerifier):(proof:unknown)=>T.ExecutionClaim|undefined{return proof=>{const v=verifier(proof);if(!v)return;const claim=Object.freeze({}) as T.ExecutionClaim;claims.set(claim,freeze({...v}));return claim;};}
export function installQueueSources(sources:readonly T.QueueRecoverySource[]):()=>void{const own=new Map<T.ServiceId,T.QueueRecoverySource>();for(const s of sources){if(queues.has(s.kind)||own.has(s.kind))throw new Error('duplicate-queue-source');own.set(s.kind,s);}for(const [k,s] of own)queues.set(k,s);return()=>{for(const [k,s] of own)if(queues.get(k)===s)queues.delete(k);};}
export function installEngineApprovalBuilder(builder:T.EngineApprovalBuilder):()=>void{if(typeof builder!=='function')throw new Error('engine-approval-builder-missing');engineBuilder=builder;if(!engineBuilderInstalledLogged){engineBuilderInstalledLogged=true;console.info('[decision] engine approval builder installed');}return()=>{if(engineBuilder===builder)engineBuilder=undefined;};}
export function installDecisionObserver(observer:T.DecisionObserver):()=>void{observers.add(observer);return()=>{observers.delete(observer);};}
export function installRequestIngress(bus:T.RequestIngress):()=>void{return bus.subscribe(event=>{
 if(event.type==='request.opened')capture(event);
 else if(event.type==='request.resolved'||event.type==='turn.completed'){
  const matching=[...entries.values()].filter(e=>!!e.registration.snapshot&&e.threadId===event.threadId&&e.registration.snapshot?.providerInstanceId===event.providerInstanceId&&e.registration.snapshot?.turnId===event.turnId&&(event.type!=='request.resolved'||e.requestId===event.requestId));
  const generations=new Set(matching.map(e=>e.authority.generation));
  // 1021 Retry: the ask left the engine; a card still offering Send again ends now.
  for(const e of matching)endRetryOffer(e);
  // Never substitute the live generation for the one carried by a captured
  // native identity. An ambiguous reused native identity cannot retire a new turn.
  if(generations.size===1){const generation=matching[0].authority.generation;
   if(event.type==='turn.completed'){
    // A native delivery failure ends the turn before respond() returns its
    // receipt. Fence the generation without turning that failure into a Stop.
    if(!event.ok&&event.stopReason==='approval_delivery_failed')for(const e of matching)if(!e.cancellation)e.approvalDeliveryFailed=true;
    void (turnSucceeded(event)?completeDecisionGeneration({threadId:event.threadId,generation}):cancelRequests({kind:'generation',threadId:event.threadId,generation},'cancelled')).catch(()=>{});
   }
   else for(const e of matching){if(event.behavior==='allow'&&e.deliveryStarted&&e.receiptAnswer?.behavior==='allow'){
    // A matching native resolution confirms delivery at every permission level.
    // It can precede both the transport promise and turn.completed.
    e.receiptDelivery='accepted';
    if(!e.cancelled&&owner(e))e.successfulRelease=true;
    // A matching native resolution is the receipt even if turn completion
    // retires the provider before its async respond call returns.
    if(e.deliveryStarted&&e.row){const row=records.readRecord(database(),e.row.id);if(row?.state==='answered'&&row.delivery==='pending'&&row.answer_id&&row.answer&&JSON.parse(row.answer).behavior==='allow')records.updateRecord(database(),row.id,{delivery:'accepted'});}
   }else void cancelEntry(e,event.settlement??'cancelled').catch(()=>{});}
  }
 }
});}
/** Only called after authenticated No limits selection. Incomplete provider
 * metadata cannot suppress a wipe visible in the input that was received.
 * Strict identity binding keeps the original operation separately. */
function visibleOperation(input:T.RequestSnapshot|T.ServiceCall,exact:ExtractedOperation=extractInspectedOperation(input)):ExtractedOperation {
 if(exact.kind==='incomplete'&&'event'in input&&input.event.toolInputTruncated===true)try{
  return extractInspectedOperation({...input,event:{...input.event,toolInputTruncated:false}});
 }catch{/* Uncertainty alone is not a catastrophe. */}
 return exact;
}
function capture(event:T.RequestOpenedEvent):void {
 const generation=safely(()=>reader?.turnGenerationFor(event.threadId),undefined)??'';
 const a=authority(event.threadId);
 const rawEvent=ownerEligible(a)||a.actor==='owner'||a.actor==='owner-routine'?captureWipeInput(event):undefined;
 const raw=rawEvent?{threadId:event.threadId,requestId:event.requestId??'',turnId:event.turnId??'',providerInstanceId:event.providerInstanceId??'',generation,tool:event.toolCall?.name??event.tool??'',input:rawEvent.toolCall?.input,inputHash:'',event:rawEvent} as T.RequestSnapshot:undefined;
 const exact=ownerEligible(a)&&raw?extractInspectedOperation(raw):undefined;
 const visibleExact=exact&&raw?visibleOperation(raw,exact):undefined;
 let incomplete=false;
 const projected=boundedProjection(event,()=>{incomplete=true;}) as T.RequestOpenedEvent;
 // BASE reads the bounded projection, so retain loss even when a complete
 // raw sidecar exists or the owner later lowers the permission level.
 // Authenticated No limits still scans its separate original wipe input.
 const input=projected.toolCall?.input??{};
 const snapshot=freeze({threadId:event.threadId,requestId:event.requestId??'',turnId:event.turnId??'',providerInstanceId:event.providerInstanceId??'',generation,tool:projected.toolCall?.name??projected.tool,input,inputHash:hash({tool:projected.toolCall?.name??projected.tool,input,choices:projected.choices,questions:projected.questions,folderTrust:projected.folderTrust,approvalScope:projected.approvalScope,filePaths:projected.filePaths}),event:projected});
 // Retain the full scanner input separately from bounded display/storage.
 // A null sidecar records failed capture; uncertainty alone does not card at No limits.
 if(rawEvent!==undefined)wipeInputs.set(snapshot,raw?freeze({...raw,inputHash:snapshot.inputHash}):null);
 const upgrade=!exact&&raw?freeze({...raw,inputHash:snapshot.inputHash}):undefined;
 const key=captureKey(snapshot),scope=scopedKey(snapshot.threadId,key),old=captures.get(scope);
 if(old){if(incomplete){old.incomplete=true;const e=entries.get(scope);if(e)e.fault='overflow';}if(old.snapshot.inputHash!==snapshot.inputHash||canonical(old.exact)!==canonical(exact)||canonical(old.latestExact)!==canonical(visibleExact)){old.conflict=true;old.latest=snapshot;old.latestExact=visibleExact;const e=entries.get(scope);if(e)e.conflict=true;}return;}
 if(captures.size>=1536){for(const [k]of captures){if(!entries.has(k)||entries.get(k)?.terminal){captures.delete(k);if(captures.size<1536)break;}}}
 if(captures.size<1536||ownerEligible(a))captures.set(scope,{snapshot,latest:snapshot,conflict:false,incomplete,exact,latestExact:visibleExact,upgrade});
}
export function describeAction(input:T.RequestSnapshot|T.ServiceCall):T.ActionEvidence{return describe(input);}
function checkedCall(call:T.ServiceCall):T.ServiceCall {
 const spec=call.approval;
 if(spec){if(!spec.queueRef||!spec.epoch)throw new Error('queue-identity-missing');for(const k of ['approvalId','requestRef','actionHash',...CARD_DISPLAY_FIELDS,...CARD_TERMINAL_FIELDS])if(Object.hasOwn(spec.action,k))throw new Error('reserved-action-field');if(spec.action.requestId!==undefined&&spec.action.requestId!==spec.queueRef)throw new Error('request-id-mismatch');}
 return boundedProjection(call);
}
function queueValue(action:any,kind:T.ServiceId):unknown{return QUEUE_REF_PATHS[kind].slice('$.card.'.length).split('.').reduce((x,k)=>x?.[k],action);}
function describeNoLimits(input:T.RequestSnapshot|T.ServiceCall,threadId:string,botId:string,exact?:ExtractedOperation):T.ActionEvidence {
 const raw=wipeInputs.has(input)?wipeInputs.get(input)!:captureWipeInput(input);
 const unread=():T.ActionEvidence=>freeze({tool:input.tool??'',codeIdentity:'',executables:[],deletes:[{path:'wipe-check-fault',op:'delete',note:wipeCheckFault().what}],targets:[],content:[]});
 let context=degradedWipeContext({},botId);
 try{context=wipeContextFor(threadId,botId);}catch{}
 try{context={...context,...host?.executionContext?.(threadId,botId)};}catch{context={...context,degraded:true};}
 context={...context,...sessionScriptContext(threadId)};
 if(raw===null)return unread();
 // The entire received input is available even when provider metadata says
 // truncated. Presentation limits and native-effect extraction are irrelevant
 // to the narrow catastrophe breaker.
 const source='event'in raw?{...raw,event:{...raw.event,toolInputTruncated:false}}:raw;
 // A fault in the optional target/provenance reader cannot discard wipes.
 let inspected:T.ActionEvidence;
 try{
  inspected=describeOwnerNoLimits(source,{...context,wipeOnly:true});
 }catch{
  // SCOPE.md:129: a text-check fault must survive caller recovery as a card.
  inspected=unread();
 }
 try{
  // Preserve the normalized executable/native scan alongside full raw scanning.
  // In particular, a mounted MCP code tool has a namespaced display name.
  exact=visibleOperation(source,exact);
  if(exact.kind!=='incomplete'){
   const operation=exact.exactOperation;
   const commandEnv='event'in source && source.event.execEnv && !source.event.execEnv.unread
    ? wipeEnvironment(context.env,source.event.execEnv.env,source.event.execEnv.absent) : context.env;
   const ctx={...context,cwd:operation.cwd??context.cwd,cwdOpaque:operation.cwdInvalid,env:commandEnv};
   let hit;
   try{hit=operation.kind==='native'?(operation.effects.length?nativeEffectsWipe(operation.effects,ctx):nativeWipeBreaker(operation.rawTool??source.tool,operation.rawInput??source.input,ctx))
    :noLimitsWipe(operation.text,{...ctx,...(operation.kind==='code'?{lang:operation.lang}:{dialect:operation.dialect})});}
   catch{hit=wipeCheckFault();}
   const additional:T.ActionEvidence={...inspected,deletes:hit?[{path:({'delete-root':'root','delete-home':'home','delete-system-folder':'system','disk-erase':'disk'} as Record<string,string>)[hit.rule]??hit.rule,op:'delete',note:hit.what}]:[]};
   const deletes=additional.deletes.filter(row=>!inspected.deletes.some(prior=>prior.path===row.path&&prior.op===row.op));
   inspected=freeze({...inspected,deletes:[...inspected.deletes,...deletes]});
  }
 }catch{/* Keep the raw scan when the optional exact projection fails. */}
 // Saved host consent is an explicit owner decision, independent of the wipe scan.
 if(/host.computer/i.test(input.tool)||('event'in input&&input.event.approvalScope==='local-computer'))
  inspected=freeze({...inspected,targets:[...inspected.targets,{kind:'host-computer' as const,scope:'local-computer' as const}]});
 return inspected;
}
export function openRequest(source:T.RequestSource):T.RequestHandle {
 let snapshot:T.RequestSnapshot|undefined,threadId='',botId='',generation='',key='',conflict=false,src:T.RequestSource,serviceScanner:T.ServiceCall|null|undefined;
 if(source.kind==='engine'){
  threadId=source.threadId;generation=safely(()=>reader?.turnGenerationFor(threadId),undefined)??'';
  const live=safely(()=>reader?.live(threadId),undefined);botId=live?.botId??'';key=`${live?.providerInstanceId??''}:${generation}:${source.requestId}`;
  const captured=captures.get(scopedKey(threadId,key))??(!live&&ownerEligible(authority(threadId))?[...captures.values()].find(item=>item.snapshot.threadId===threadId&&item.snapshot.generation===generation&&item.snapshot.requestId===source.requestId):undefined);
  snapshot=captured?.snapshot;if(snapshot)key=captureKey(snapshot);conflict=!!captured?.conflict;
  src=freeze({kind:'engine',threadId,requestId:source.requestId});
 }else{
  const c=claims.get(source.claim);if(!c)throw new Error('unverified-execution-claim');
  ({threadId,botId,generation}=c);
  if(ownerEligible(authority(threadId,botId,generation)))serviceScanner=captureWipeInput(source.call);
  const call=checkedCall(source.call);if(call.approval&&queueValue(call.approval.action,source.service)!==call.approval.queueRef)throw new Error('queue-reference-mismatch');
  src=freeze({kind:'service',service:source.service,claim:source.claim,call});if(serviceScanner!==undefined)wipeInputs.set(call,serviceScanner);key=`${source.service}:${call.approval?.queueRef??hash(call)}:${call.approval?.epoch??generation}`;
 }
 const executionCall=source.kind==='service'?(serviceScanner===undefined?captureDelivery((src as Extract<T.RequestSource,{kind:'service'}>).call,source.call):freeze(structuredClone(source.call))):undefined;
 if(source.kind==='service'&&serviceScanner===null&&executionCall)wipeInputs.set((src as Extract<T.RequestSource,{kind:'service'}>).call,executionCall);
 const scope=scopedKey(threadId,key);const existing=entries.get(scope);if(existing){if(source.kind==='service'&&existing.registration.inputHash!==hash((src as Extract<T.RequestSource,{kind:'service'}>).call))throw new Error('request-input-conflict');return existing.handle;}
 const a=authority(threadId,botId,generation);let fault:Entry['fault'];
 if(!a.botId||!safely(()=>reader?.live(threadId),undefined))fault='identity';
 if(source.kind==='engine'){
  if(captures.get(scopedKey(threadId,key))?.incomplete)fault=snapshot?.tool?'overflow':'reader';
  const live=safely(()=>reader?.live(threadId),undefined);if(!ownerEligible(a)&&(!snapshot||snapshot.threadId!==threadId||snapshot.requestId!==source.requestId||snapshot.turnId!==live?.turnId||snapshot.providerInstanceId!==live?.providerInstanceId||snapshot.generation!==generation)){a.actor='unproven';a.noLimitsOrigin='unproven';a.level='ask';}
 }
 const ownerNl=ownerEligible(a);
 if(ownerNl&&fault==='identity')fault=undefined;
 let action:T.ActionEvidence=freeze({tool:snapshot?.tool??(src.kind==='service'?src.call.tool:''),codeIdentity:'',executables:[],deletes:[],targets:[],content:[]}),deny:readonly T.Evidence[]=[],denyRev:readonly string[]=[];
 try{if(snapshot||src.kind==='service')action=ownerNl?describeNoLimits(snapshot??(src as Extract<T.RequestSource,{kind:'service'}>).call,threadId,a.botId,source.kind==='engine'?captures.get(scope)?.latestExact:undefined):describeAction(snapshot??(src as Extract<T.RequestSource,{kind:'service'}>).call);
  if(ownerNl&&action.ownerAuthority?.exhausted)fault='overflow';}catch{if(!fault)fault=ownerNl?'overflow':'reader';}
 // Pure protected matching precedes every fallible stored deny source.
 deny=ownerNl?ownerNlProtectedEvidence(action.ownerAuthority):protectedEvidence(action);
 try {if(!denials)throw new Error('deny-sources-missing');denyRev=freeze([...denials.revision(a.botId)]);deny=freeze([...deny,...denials.resolve(a.botId,ownerNl?action.ownerTargets??action.targets:action.targets).map(e=>({...e,span:e.span.slice(0,200)}))]);}catch{if(!fault)fault='deny';}
 const inputHash=snapshot?.inputHash??hash(src.kind==='service'?src.call:{});
 const registration=freeze({key,source:src,...(snapshot?{snapshot}:{}),actor:a.actor,level:a.level,action,...(ownerNl&&action.ownerAuthority?{ownerAuthority:action.ownerAuthority}:{}),deny,denyRev,inputHash,registrationHash:hash({key,actor:a.actor,level:a.level,action,denyRev,inputHash})});
 const handle=Object.freeze({}) as T.RequestHandle;
 const e:Entry={handle,registration,authority:a,threadId,requestId:source.kind==='engine'?source.requestId:source.call.approval?.queueRef??key,created:Date.now(),conflict,fault};
 const active=[...entries.values()].filter(e=>!e.terminal);
 if(ownerNl&&(active.length===512||active.filter(e=>e.threadId===threadId).length===32))console.warn('[no-limits] request capacity pressure; queuing delivery and shedding completed registry entries');
 if(!ownerNl&&(active.length>=512||active.filter(e=>e.threadId===threadId).length>=32))e.outcome={kind:'refuse',message:REFUSAL};else entries.set(scope,e);
 // Bounded terminal working set; durable tombstones remain in SQLite.
 if(entries.size>1536)for(const [k,v]of entries)if(v.terminal){unindexApprovalEntry(v);entries.delete(k);if(entries.size<=1536)break;}
 if(source.kind==='service')e.executionCall=executionCall;
 if(ownerNl){
  e.exact=source.kind==='engine'?captures.get(scope)?.exact:extractInspectedOperation(executionCall??(src as Extract<T.RequestSource,{kind:'service'}>).call);
  if(e.exact&&e.exact.kind!=='incomplete')e.originalOperationHash=e.exact.operationHash;
 }
 handles.set(handle,e);observe({type:'registered',requestKey:key,threadId,inputHash,actor:a.actor,level:a.level});return handle;
}
function entry(handle:T.RequestHandle):Entry {const e=handles.get(handle);if(!e)throw new Error('unregistered-request');return e;}
function refFor(id:string):T.ApprovalRef {let epoch=referenceEpochs.get(id);if(!epoch){epoch={};referenceEpochs.set(id,epoch);if(referenceEpochs.size>2048){const active=new Set([...entries.values()].filter(e=>!e.terminal).map(e=>e.row?.id));for(const key of referenceEpochs.keys()){if(!active.has(key))referenceEpochs.delete(key);if(referenceEpochs.size<=1536)break;}}}const ref=Object.freeze({approvalId:id}) as T.ApprovalRef;refs.set(ref,{id,epoch});return ref;}
function issuedRef(ref:T.ApprovalRef):boolean {const issued=refs.get(ref);return !!issued&&issued.id===ref.approvalId&&referenceEpochs.get(issued.id)===issued.epoch;}
function indexApprovalEntry(id:string,e:Entry):void {if(e.approvalIndexId&&e.approvalIndexId!==id&&entriesByApproval.get(e.approvalIndexId)===e)entriesByApproval.delete(e.approvalIndexId);e.approvalIndexId=id;entriesByApproval.set(id,e);}
function unindexApprovalEntry(e:Entry):void {if(e.approvalIndexId&&entriesByApproval.get(e.approvalIndexId)===e)entriesByApproval.delete(e.approvalIndexId);e.approvalIndexId=undefined;}
function entryForRef(ref:T.ApprovalRef):Entry|undefined {if(!issuedRef(ref))throw new Error('unissued-approval-ref');const e=entriesByApproval.get(ref.approvalId);return e&&e.row?.id===ref.approvalId&&entries.get(scopedKey(e.threadId,e.registration.key))===e?e:undefined;}
function requireRow(ref:T.ApprovalRef):records.RecordRow {entryForRef(ref);const r=records.readRecord(database(),ref.approvalId);if(!r)throw new Error('approval-record-missing');return r;}
function baseVerdict(e:Entry):ReturnType<T.BaseVerdictFn>{try{const verdict=freeze(boundedProjection(e.base!(e.registration))) as ReturnType<T.BaseVerdictFn>;if(!verdict||(verdict.approve!==null&&typeof verdict.approve!=='string')||typeof verdict.source!=='string')throw new Error('invalid-base-verdict');e.baseValue=verdict;return verdict;}catch{const verdict=freeze({approve:null,source:'always-ask' as const,rule:'unreadable'});e.baseValue=verdict;return verdict;}}
/** A native content hash can retain every destination field while leaving
 * BASE unable to inspect the full body. Keep a human card only when the raw
 * sidecar proves no field or non-content value was lost from the projection. */
function nativeContentOverflowCard(e:Entry):boolean {
 const snapshot=e.registration.snapshot,raw=snapshot&&wipeInputs.get(snapshot);
 if(!snapshot||!raw||!('event'in raw))return false;
 try{
  const exact=extractInspectedOperation(raw);
  if(exact.kind!=='operation'||exact.exactOperation.kind!=='native')return false;
  captureDelivery(snapshot.event,raw.event);return true;
 }catch{return false;}
}
function ownerEligible(value: {actor:T.Registration['actor'];level:T.Registration['level'];noLimitsOrigin?:NoLimitsOrigin;fullAccessChannelMessages?:boolean;explicitNoLimits?:boolean}):boolean{return noLimitsAppliesTo(value.noLimitsOrigin ?? (value.actor === 'unproven' ? 'unproven' : value.actor), {autoApprove:value.level==='unlimited',fullAccess:value.level==='unlimited',noLimits:value.level==='unlimited',permissionExplicit:['other-human','guest','other'].includes(value.noLimitsOrigin??value.actor)?value.explicitNoLimits===true:true,fullAccessChannelMessages:value.fullAccessChannelMessages});}
function owner(e:Entry):boolean{return ownerEligible(e.authority);}
// SEAN RULING 1115-MORNING point 2: a saved Never is still binding at No limits.
// Match the production denial identity, not arbitrary legacy permission evidence.
function explicitHostDecline(item:T.Evidence):boolean {
 return item.kind==='deny'&&item.class==='host-computer'&&item.ruleId==='host-declined';
}
function hostDeclineBlocksRelease(botId:string,allTargets:readonly T.DenyTarget[]):boolean {
 const targets=allTargets.filter(target=>target.kind==='host-computer');
 if(!targets.length)return false;
 try { return !denials||denials.resolve(botId,targets).some(explicitHostDecline); }
 catch { return true; }
}
function featureOffMessage(e:Entry):string|undefined {
 if(e.authority.fullAccessChannelMessages===false&&e.authority.noLimitsOrigin==='owner-channel')return CHANNEL_MESSAGES_OFF;
 return host?.featureOff?.(e.threadId,e.authority.botId,e.registration.action.tool);
}
export function decide(handle:T.RequestHandle,base:T.BaseVerdictFn):T.Outcome {
 const e=entry(handle);e.base=base;
 if(e.terminal&&e.outcome)return e.outcome;
 if(e.outcome?.kind==='refuse')return e.outcome;
 if(e.conflict){
   const latest=captures.get(scopedKey(e.threadId,e.registration.key))?.latest;
   if(latest){
    let action=e.registration.action;try{action=owner(e)?describeNoLimits(latest,e.threadId,e.authority.botId,captures.get(scopedKey(e.threadId,e.registration.key))?.latestExact):describeAction(latest);}catch{if(!e.fault)e.fault='reader';}
    e.registration=freeze({...e.registration,snapshot:latest,inputHash:latest.inputHash,action,registrationHash:hash({prior:e.registration.registrationHash,inputHash:latest.inputHash})});
   }
 }
 const r=e.registration;
 let outcome:T.Outcome;
 const off=isQuestion(r)?undefined:featureOffMessage(e);
 if(off)outcome={kind:'refuse',message:off};
 // Sean ruling 2026-11-15: a saved Never is a refusal at No limits, never an Allow/Deny card.
 else if(r.deny.some(explicitHostDecline)&&owner(e))outcome={kind:'refuse',message:REFUSAL};
 else if(r.deny.some(explicitHostDecline))outcome=approval(e,'deny',r.deny.filter(explicitHostDecline));
 else if(e.permissionReplyHold&&!owner(e))outcome=approval(e,'base',[]);
 else if(e.fault==='overflow'&&!owner(e)&&nativeContentOverflowCard(e))outcome=approval(e,'base',[]);
 else if((e.fault==='identity'||e.fault==='overflow')&&!owner(e))outcome={kind:'refuse',message:REFUSAL};
 else if(owner(e)){
  // Sean ruling 2026-11-12 02:05Z: refusal rules, protected targets,
  // reader failure/bounds and stored denies do not card at No limits.
  // Eligible No limits requests check fresh wipes before other permission outcomes.
  // Actual disabled capabilities are handled separately above.
  const wipes=wipeEvidence(r.action);
  if(wipes.length)outcome=approval(e,'wipe',wipes);
  else if(isQuestion(r))outcome=approval(e,'question',[]);
  else outcome={kind:'run'};
 }else if(r.actor==='unproven'){
  // Excluded origins retain their existing deny and catastrophe evidence.
  if(r.deny.length)outcome=approval(e,'deny',r.deny);
  else if(wipeEvidence(r.action).length)outcome=approval(e,'wipe',wipeEvidence(r.action));
  else outcome=(e.fault==='reader'||e.fault==='deny')?approval(e,'base',[]):baseVerdict(e).approve!==null?{kind:'run'}:approval(e,'base',[]);
 }else { // BASE is actor-first, including all non-owner No-limits faults.
  const b=baseVerdict(e);outcome=(e.fault==='reader'||e.fault==='deny')?approval(e,'base',[]):b.approve!==null?{kind:'run'}:approval(e,'base',[]);
 }
 e.outcome=freeze(outcome);observe({type:'decided',requestKey:r.key,kind:outcome.kind,...(owner(e)&&outcome.kind==='run'?{ownerAuthority:r.ownerAuthority,ownerTargets:r.action.ownerTargets??r.action.targets}:{}),...('ref'in outcome?{approvalId:outcome.ref.approvalId}:{})});return outcome;
}
function isQuestion(r:T.Registration){return r.source.kind==='service'&&r.source.call.tool==='ask_user'||!!(r.snapshot?.event.requestType==='question'||r.snapshot?.event.questionTool)&&!r.snapshot?.event.folderTrust;}
function approval(e:Entry,why:T.ApprovalRecordView['why'],items:readonly T.Evidence[]):T.Outcome {
 const r=e.registration;const held=records.findRecord(database(),r.source.kind,e.threadId,r.key);
 if(held){e.row=held;indexApprovalEntry(held.id,e);e.ref??=refFor(held.id);if(held.state!=='open')e.terminal=true;return {kind:held.why==='question'?'question':'card',ref:e.ref};}
 if(e.row&&e.row.registration_hash===r.registrationHash&&e.row.why===why)return {kind:why==='question'?'question':'card',ref:e.ref!};
 const priorRow=e.row;
 {
 const id=priorRow?.id??randomUUID(),message=priorRow?.chat_message_id??randomUUID(),event=r.snapshot?.event;
 let action:Record<string,unknown>;
 if(r.source.kind==='service'){
  action=r.source.call.approval?{...r.source.call.approval.action}:{requestId:e.requestId,tool:r.action.tool,options:['Allow','Deny']};
 }else{
  // cause22-E (MAIN-RULING 2026-11-22T21:44:35Z (b), ASTRA 635304ab43): the card is built from the COUNTED FOLD of the engine's
  // question, never from its raw lists: at most 4 questions, 10 options each and 10 one-tap choices are stored, and the rest is
  // one counted marker line, so the stored card is the one the owner sees and the one the answer route can resolve.
  const questions=event?.questions?foldCardQuestions(event.questions):undefined,folded=foldCardChoices(event?.choices,event?.summary);
  action={requestId:e.requestId,tool:event?.tool??r.action.tool,options:folded.choices??questions?.[0]?.options.map(o=>o.label)??(isQuestion(r)?[]:['Allow','Deny']),...(isQuestion(r)?{question:questions?.[0]?.question??folded.summary??r.action.tool}:{}),...(questions?{questions}:{}),...(event?.folderTrust?{folderTrust:event.folderTrust}:{}),...(event?.approvalScope?{approvalScope:event.approvalScope}:{})};
 }
 // Provider questions may pass through BASE, but their cards remain questions.
 // Keep the native tool origin; attention readers use the explicit question class.
 if(isQuestion(r))action.cardClass={reason:'question',unattended:false,automated:false,keys:[]};
 if(r.source.kind==='engine'&&why!=='question'&&!e.permissionReplyHold){
  try{
   // R3 held origins need a plain one-shot card even when the optional
   // legacy grant builder is unavailable. Other BASE behavior stays intact.
   const heldOrigin=e.authority.noLimitsOrigin==='webhook'||e.authority.noLimitsOrigin==='other-human'||e.authority.noLimitsOrigin==='owner-channel'&&e.authority.fullAccessChannelMessages===false;
   if(why==='base'&&!engineBuilder&&!heldOrigin){
    throw new Error('engine-approval-builder-missing');
   }
   const extra=engineBuilder?boundedProjection(engineBuilder(r,why,why==='base'?e.baseValue:undefined)):{};
   checkedCall({tool:r.action.tool,input:{},approval:{queueRef:e.requestId,epoch:r.key,action:extra}});
   if(engineBuilder&&(!Array.isArray(extra.options)||!extra.options.every((v:unknown)=>typeof v==='string')))throw new Error('invalid-engine-options');
   if(extra.requestId!==undefined&&extra.requestId!==e.requestId)throw new Error('request-id-mismatch');
   action={...action,...extra};
  }catch(error){
   // Never log request content or an arbitrary provider error message. Unknown
   // exceptions retain a cause fingerprint so distinct faults are not hidden.
   const message=error instanceof Error?error.message:typeof error;
   const cause=engineRefusalCodes.has(message)?message:`engine-builder-error-${hash(message).slice(0,12)}`;
   reportDecisionRefusal(cause);
   if(why!=='wipe'||!owner(e))return {kind:'refuse',message:REFUSAL};
   // A failing optional grant builder cannot suppress the catastrophe card.
   console.warn('[no-limits] wipe card builder unavailable; showing the plain wipe card');
   action={requestId:e.requestId,tool:r.action.tool,options:['Allow','Deny']};
  }
 }
 if(why==='wipe'&&owner(e)&&e.exact&&e.exact.kind!=='incomplete'&&!e.initialInspection){
  // Bind the displayed narrow wipe before its first Run answer. Protected
  // diagnostics do not participate in this No limits permission decision.
  try{e.initialInspection=freeze({decisions:[],wipes:inspectReleaseWipes(e.exact.exactOperation,false,entryWipeIdentity(e))});}catch{/* A later release retries the fingerprint without discarding the card. */}
 }
 if(why==='wipe'&&owner(e))action={...action,options:['Run',"Don't"],held:items[0]?.span??'This would wipe a protected root. Run it anyway?'};
 action={...action,approvalId:id,requestRef:e.requestId};const actionHash=hash(actionProjection(action));action.actionHash=actionHash;
 e.row={id,source_kind:r.source.kind,service:r.source.kind==='service'?r.source.service:null,thread_id:e.threadId,request_key:r.key,request_id:e.requestId,bot_id:e.authority.botId,generation:e.authority.generation,actor_kind:r.actor,actor_via:e.authority.provenance?.initiator.k??'unproven',level:r.level,why,evidence:JSON.stringify({items,action,...(r.ownerAuthority?{ownerAuthority:r.ownerAuthority}:{}),...(e.exact&&e.exact.kind!=='incomplete'&&e.initialInspection?{releaseEvidence:{operationHash:e.exact.operationHash,inspection:e.initialInspection}}:{}),initiator:e.authority.provenance?.initiator??{k:'other-human'},target:r.snapshot?targetOf(r.snapshot):undefined,epoch:r.source.kind==='service'?r.source.call.approval?.epoch:undefined}),registration_hash:r.registrationHash,deny_rev:JSON.stringify(r.denyRev),input_hash:r.inputHash,action_hash:actionHash,presented_action:null,chat_message_id:message,queue_kind:priorRow?.queue_kind??null,queue_ref:priorRow?.queue_ref??null,state:'open',answer:null,answer_id:null,delivery:'none',created_at:Date.now(),settled_at:null};
 indexApprovalEntry(id,e);e.ref??=refFor(id);
 }
 return {kind:why==='question'?'question':'card',ref:e.ref!};
}
function refresh(e:Entry):T.Outcome {
 if(e.terminal)return e.outcome??{kind:'refuse',message:REFUSAL};
 let rev:readonly string[]|undefined;try{rev=denials?.revision(e.authority.botId);}catch{}
 if(canonical(rev)!==canonical(e.registration.denyRev)){
  let deny:readonly T.Evidence[]=e.registration.ownerAuthority?ownerNlProtectedEvidence(e.registration.ownerAuthority):protectedEvidence(e.registration.action),fault:Entry['fault'];try{if(!denials)throw 0;deny=freeze([...deny,...denials.resolve(e.authority.botId,e.registration.ownerAuthority?e.registration.action.ownerTargets??e.registration.action.targets:e.registration.action.targets)]);}catch{fault='deny';}
  if(e.fault!=='identity'&&e.fault!=='reader'&&e.fault!=='overflow')e.fault=fault;e.registration=freeze({...e.registration,deny,denyRev:rev??[],registrationHash:hash({prior:e.registration.registrationHash,denyRev:rev??[]})});
 }
 return decide(e.handle,e.base??baseCardFallback);
}
const baseCardFallback:T.BaseVerdictFn=()=>({approve:null,source:'always-ask'});
export function attachQueue(ref:T.ApprovalRef,queue:T.QueueAttachment):void {
 const e=entryForRef(ref);if(!e||e.registration.source.kind!=='service')throw new Error('queue-registration-missing');
 const call=checkedCall(queue.call),src=e.registration.source;
 if(src.service!==queue.kind||src.call.approval?.queueRef!==queue.ref||hash(call)!==e.registration.inputHash||queueValue(call.approval?.action,queue.kind)!==queue.ref)throw new Error('queue-action-mismatch');
 if(e.attached&&canonical(e.attached)!==canonical(queue))throw new Error('queue-already-attached');
 e.attached=freeze({...queue,call});e.row!.queue_kind=queue.kind;e.row!.queue_ref=queue.ref;
}
export async function presentApproval(ref:T.ApprovalRef,view:T.ApprovalView):Promise<void> {
 const e=entryForRef(ref);if(e?.terminal&&(e.outcome?.kind==='run'||e.outcome?.kind==='refuse'))return;let row=e?.row??requireRow(ref);
 if(e){const next=refresh(e);if(next.kind==='run'||next.kind==='refuse'){
   const persisted=records.readRecord(database(),ref.approvalId);
   if(row.source_kind==='engine'){
    if(persisted)await send(persisted,e,{behavior:next.kind==='run'?'allow':'deny',...(next.kind==='refuse'?{message:next.message}:{})});else await deliverRequest(e.handle);
   }else{
    const q=queues.get(e.registration.source.kind==='service'?e.registration.source.service:row.service as T.ServiceId),item=q?.pendingApprovals().find(i=>i.approvalId===ref.approvalId);
    if(!q||!item)throw new Error('queue-recovery-source-missing');
    if(!queueCallMatches(e,item,e.registration.inputHash))throw new Error('queue-action-mismatch');
    if(next.kind==='run')await recoverQueueRun(q,item,e,persisted);else if(persisted)await settle(ref,'cancelled');else await withDeadline(q.cancel(item,'unverifiable'),5000);
   }
   e.terminal=true;if(next.kind==='refuse')requiredHost().store.appendMessage(e.threadId,{role:'bot',kind:'text',text:next.message.slice(0,160)});
   return;
  }if(next.ref.approvalId!==ref.approvalId)throw new Error('approval-superseded');row=records.readRecord(database(),ref.approvalId)??e.row!;}
 if(row.source_kind==='service'&&!row.queue_kind)throw new Error('queue-must-be-attached');
 if(row.state!=='open'){if(row.answer_id&&row.answer)await send(row,e,JSON.parse(row.answer));return;}
 const question=row.why==='question';
 const count=records.openRecords(database(),row.thread_id).filter(r=>r.why==='question').length;
 if(question&&count>=8&&!(e&&owner(e))&&!records.readRecord(database(),row.id)){if(e){e.outcome={kind:'refuse',message:'Please answer one question at a time.'};await deliverRequest(e.handle);}return;}
 try {commitPresentation(row,ref,view);}catch(error){if(e&&row.source_kind==='engine'){e.outcome={kind:'refuse',message:REFUSAL};await deliverRequest(e.handle);}throw error;}
}
function commitPresentation(row:records.RecordRow,ref:T.ApprovalRef,view:T.ApprovalView){
 const h=requiredHost(),question=row.why==='question';
 const target=row.source_kind==='engine'?JSON.parse(row.evidence).target:undefined;
 const turn=typeof target?.turnId==='string'&&target.turnId?{turnId:target.turnId}:{};
 transaction(db=>{
  const fresh=!records.readRecord(db,row.id);
  if(fresh&&row.source_kind==='engine'){
    // The store masks this complete display unit before persisting it. Bind
    // the resulting summary fields, so an oversized preview cannot invalidate
    // its own approval card after the action signature has been allocated.
    const payload=JSON.parse(row.evidence),action=payload.action as Record<string,unknown>;
    const keys=['summary','held','wants','pushBody'].filter(key=>typeof action[key]==='string');
    const safe=sanitizeDisplayTextUnit([view.title,view.subtitle,...keys.map(key=>action[key] as string)]);
    keys.forEach((key,index)=>{action[key]=safe[index+2];});
    row.action_hash=hash(actionProjection(action));action.actionHash=row.action_hash;
    row.evidence=JSON.stringify(payload);
  }
  if(fresh)records.insertRecord(db,row);
  // A question is not an approval: at every level, No limits included, it is
  // presented as its interactive card (owner report 2026-11-21), never as text.
  const message=h.store.appendApprovalCard(row.thread_id,ref,{...view,...turn});
  if(message.id!==row.chat_message_id||!db.prepare('SELECT 1 FROM messages WHERE thread_id=? AND id=?').get(row.thread_id,row.chat_message_id))throw new Error('approval-row-not-written');
  const questionEvent=entryForRef(ref)?.registration.snapshot?.event;
  if(fresh&&row.source_kind==='engine'&&!question)afterCommit(()=>{
    const evidence=JSON.parse(row.evidence);
    const unattended=row.actor_kind==='unproven'||row.actor_kind==='other'||evidence.initiator?.trigger==='schedule';
    // A grant the unattended block withheld is its own audit fact ("this would have auto-approved; only the block stood in the way"),
    // naming the granted rule the base verdict found, not a card nobody had granted.
    const withheld=row.why==='base'&&entryForRef(ref)?.baseValue?.source==='unattended-block'?entryForRef(ref)!.baseValue!:undefined;
    appendDecision(DATA_DIR,{threadId:row.thread_id,botId:row.bot_id,requestId:row.request_id,tool:evidence.action.tool,
      decision:'card-shown',source:withheld?'unattended-block':evidence.action.folderTrust||questionEvent?.requestType==='question'?'question':questionEvent?.questionTool===true?'question-tool':row.why==='base'?'no-grant':'always-ask',rule:withheld?.rule??`${row.why}:registered`,
      ...(unattended?{unattended:true}:{})});
  });
 });
}
function projection(row:records.RecordRow):T.ApprovalRecordView{
 const p=JSON.parse(row.evidence);return freeze({ref:refFor(row.id),threadId:row.thread_id,botId:row.bot_id,requestId:row.request_id,chatMessageId:row.chat_message_id,state:row.state as T.ApprovalState,delivery:row.delivery as T.DeliveryState,why:row.why as T.ApprovalRecordView['why'],inputHash:row.input_hash,actionHash:row.action_hash,level:row.level as T.Registration['level'],evidence:p.items,...(p.ownerAuthority?{ownerAuthority:p.ownerAuthority}:{}),action:p.action,actor:row.actor_kind as T.Registration['actor'],initiator:p.initiator,...(row.queue_kind?{queue:{kind:row.queue_kind as T.ServiceId,ref:row.queue_ref!,epoch:p.epoch}}:{})});
}
export function readApproval(id:string):T.ApprovalRecordView|undefined{const row=records.readRecord(database(),id);return row?projection(row):undefined;}
export function openApprovals(threadId?:string):readonly T.ApprovalRecordView[]{return freeze(records.openRecords(database(),threadId).map(projection));}
export function lookupApproval(threadId:string,messageId:string):T.ApprovalRecordView|undefined{const r=records.lookupRecord(database(),threadId,messageId);return r?projection(r):undefined;}
function patchTerminal(row:records.RecordRow,label:string,answer?:T.ApprovalAnswer){
 if(row.queue_kind && row.state!=='open')afterCommit(()=>host?.recoveredAttention?.close(row.thread_id,row.id));
 // These producers expose canonical terminal values to continuation readers.
 const canonicalService=['peer','event-limit','routine','browser','host-computer'].includes(row.queue_kind??'')||row.queue_kind==='skill'&&JSON.parse(row.evidence).action.tool==='switch_skill';
 if(canonicalService)label=label==='Allowed'?'allow':label==='Denied'?'deny':label==='Cancelled'||label==='Expired'?'unavailable':label;
 const s=requiredHost().store,m=records.decisionMessage(database(),s,row,{buildIndex:false});
 const folderExpired=m?.card?.folderTrust&&(row.state==='expired'||row.state==='cancelled');
 const sendExpired=m?.card?.answerAsSend&&(row.state==='expired'||row.state==='cancelled');
 const questionExpired=(row.state==='expired'||row.state==='cancelled')&&!folderExpired&&!sendExpired&&m?.card?.cardClass?.reason==='question';
 if(sendExpired)label='expired';
 if(questionExpired&&m?.card)appendDecision(DATA_DIR,{threadId:row.thread_id,requestId:row.request_id,botId:row.bot_id,botName:s.bot(row.bot_id)?.name,summary:cardAuditSummary(m.card),decision:'question-expired',source:'question',unattended:m.card.unattended||undefined});
 // 1021 Retry: a terminal card never keeps Send again (cancel, renewal, restart, unconfirmed all end it here).
 const {deliveryRetry:_retry,...shown}=m?.card??({} as Record<string,unknown>);
 if(m?.card)s.patchMessagePoint(row.thread_id,row.chat_message_id,{card:{...(shown as typeof m.card),answered:folderExpired||questionExpired?'expired':label,dismissed:!folderExpired&&!questionExpired&&!(canonicalService&&(label==='allow'||label==='deny')),
  ...(folderExpired||sendExpired||questionExpired?{expired:true,dismissed:false}:{}),...(row.state==='expired'||row.state==='cancelled'||row.state==='superseded'?{orphaned:true}:{}),
  // The owner's settled question card stays in place and shows what was answered,
  // whether it was tapped on the card or typed as a reply. Secret answers are never recorded.
  ...(row.why==='question'&&row.state==='answered'&&answer&&answer.behavior!=='allow'&&!(answer.behavior==='deny'&&answer.message===REFUSAL)?{answered:answer.behavior==='deny'?'skipped':'answer',dismissed:false,
   ...(answer.behavior==='answer'&&answer.answers?{answers:recordableAnswers(questionsForCard(m.card),answer.answers)}:{})}:{})}});
}
export async function settle(ref:T.ApprovalRef,state:Exclude<T.ApprovalState,'open'>,answer?:T.ApprovalAnswer):Promise<void>{
 const row=requireRow(ref),e=entryForRef(ref);if(row.state!=='open'&&!(row.state==='answered'&&row.delivery==='pending'&&!e?.deliveryStarted&&state!=='answered')&&!(state==='superseded'&&row.source_kind==='engine'&&row.state!=='superseded'))return;
 transaction(db=>{records.updateRecord(db,row.id,{state,settled_at:Date.now(),...(row.delivery==='pending'&&state!=='answered'?{delivery:'none'}:{}),...(answer?{answer:JSON.stringify(answer)}:{})});patchTerminal({...row,state},state==='answered'?(answer?.behavior==='deny'?'Denied':'Allowed'):state==='superseded'?'Continued at the new level':state==='expired'?'Expired':'Cancelled');});
 if(e){e.terminal=true;if(e.row)e.row.state=state;}
 if(row.queue_kind&&state!=='answered'){const q=queues.get(row.queue_kind as T.ServiceId);if(!q)throw new Error('queue-recovery-source-missing');const item=q.pendingApprovals().find(i=>i.approvalId===row.id);if(item)await withDeadline(q.cancel(item,state),5000);}
}
/** A persisted wipe card and live owner authority bind this pre-release credit. */
function creditTextWipe(row:records.RecordRow|undefined,e:Entry|undefined,answer:T.ApprovalAnswer):void {
 if(answer.behavior!=='allow'||!row||row.why!=='wipe'||row.source_kind!=='engine'||!e||e.execWipeCreditIssued
  ||!owner(e)||!ownerEligible(authority(e.threadId,e.authority.botId,e.authority.generation))
  ||answer.updatedInput!==undefined||e.exact?.kind!=='operation'||!e.registration.snapshot?.turnId)return;
 e.execWipeCreditIssued=approveTextExecWipeOnce(e.threadId,e.registration.snapshot.turnId,e.exact.exactOperation);
}
function queueItem(q:T.QueueRecoverySource,id:string):T.PendingQueueApproval|undefined {
 return q.approval ? q.approval(id) : q.pendingApprovals().find(i=>i.approvalId===id);
}
function projectSkillResult(row:records.RecordRow|undefined,e:Entry|undefined,result:import('../contracts.ts').RequestDelivery):boolean {
 if(result.state!=='not-run'&&result.state!=='unconfirmed'&&result.state!=='already')return false;
 const delivery=result.state==='already'?'accepted':result.state==='unconfirmed'?'unconfirmed':'failed';
 if(e){e.receiptDelivery=delivery;e.terminal=true;}
 if(row){
  const state=result.state==='not-run'?'superseded':'answered';
  const current=records.readRecord(database(),row.id);
  const store=requiredHost().store;
  if(!store.messageById(row.thread_id,row.chat_message_id,{buildIndex:false})){
   const id=`skill-settlement-${row.id}`;
   if(!store.messageById(row.thread_id,id,{buildIndex:false}))store.appendMessage(row.thread_id,{role:'bot',kind:'activity',tool:{name:result.state==='already'?'Skill change completed.':result.message??'The skill change was not run.',ok:result.state==='already'}},id);
  }
  if(current?.state!==state||current.delivery!==delivery)transaction(db=>{
   records.updateRecord(db,row.id,{state,delivery,settled_at:row.settled_at??Date.now()});
   patchTerminal({...row,state},result.state==='already'?(current?.answer&&JSON.parse(current.answer).behavior==='deny'?'Denied':'Allowed'):result.message??'The skill change was not run.');
  });
 }
 return true;
}
function preflightSkillDelivery(row:records.RecordRow|undefined,e:Entry|undefined,q:T.QueueRecoverySource,item:T.PendingQueueApproval,settlement:Settlement):boolean {
 if(item.call.tool!=='switch_skill'||settlement.kind==='owner')return false;
 const terminal=q.receipt?.(item);if(terminal)return projectSkillResult(row,e,terminal);
 const result=requiredHost().skillSettlementPolicy?.(item,settlement.cause)??{kind:'stale' as const,retire:true,message:'The skill settlement policy is unavailable. Nothing was changed.'};
 if(result.kind==='eligible')return false;
 if(!result.retire)return true;
 const refused=q.refuseBeforeEffect?.(item,result.kind,result.message??'The skill change was not run.')??{state:'unconfirmed' as const,message:UNCONFIRMED_SKILL_SWITCH};
 projectSkillResult(row,e,refused);return true;
}
/** `retry` (1021 Retry, RETRY-DESIGN-r2): the one-shot driver re-arm of a delivery-failed engine card (never a skill switch). */
function send(row:records.RecordRow|undefined,e:Entry|undefined,answer:T.ApprovalAnswer,settlement:Settlement=automaticSettlement(),retry?:{rearm:()=>boolean}):Promise<void>{
 const switching=row?.queue_kind==='skill'&&JSON.parse(row.evidence).action.tool==='switch_skill';
 const work=()=>sendInSettlement(row,e,answer,settlement,retry);
 return !switching?work():settlement.kind==='owner'?skillSettlementWork.owner(work).then(()=>{}):skillSettlementWork.item(work);
}
async function sendInSettlement(row:records.RecordRow|undefined,e:Entry|undefined,answer:T.ApprovalAnswer,settlement:Settlement,retry?:{rearm:()=>boolean}):Promise<void>{
 if(row?.queue_kind){const q=queues.get(row.queue_kind as T.ServiceId),item=q&&queueItem(q,row.id);
  if(item?.call.tool==='switch_skill'){const receipt=q?.receipt?.(item);if(receipt&&projectSkillResult(row,e,receipt))return;if(answer.behavior==='allow'&&settlement.kind==='owner'&&q?.switchDeliverySlotAvailable?.()===false)return;if(answer.behavior==='allow'&&q&&preflightSkillDelivery(row,e,q,item,settlement))return;if(row.delivery==='accepted'){projectSkillResult(row,e,{state:'unconfirmed',message:UNCONFIRMED_SKILL_SWITCH});return;}}
  else if(row.queue_kind==='skill'&&JSON.parse(row.evidence).action.tool==='switch_skill'){projectSkillResult(row,e,{state:'unconfirmed',message:UNCONFIRMED_SKILL_SWITCH});return;}
 }
 // Reload answers carry the saved engine envelope to the driver-held ask.
 // The action is bound by the registry hash; display fields cannot mint identity.
 if(row?.source_kind==='engine'&&answer.behavior!=='answer'){
  const action=JSON.parse(row.evidence).action;
  if(action.identityFrame)answer={...answer,identityFrame:action.identityFrame,toolIdentity:action.toolIdentity};
 }
 const approvedForDelivery=row&&answer.behavior==='allow'?refFor(row.id):undefined;
 if(answer.behavior==='allow'&&row&&!['open','answered'].includes(row.state))return;
 if(answer.behavior==='allow'&&!e&&row&&ownerEligible({actor:row.actor_kind as T.Registration['actor'],level:row.level as T.Registration['level']}))return;
 if(answer.behavior==='allow'&&e?.releaseUpdatedInput&&answer.updatedInput===undefined&&e.exact&&e.exact.kind!=='incomplete'&&e.exact.operationHash!==e.originalOperationHash)answer={...answer,updatedInput:e.releaseUpdatedInput};
 if(answer.behavior==='allow'&&e){const blocked=checkEntryRelease(e,answer,approvedForDelivery);if(blocked)return;}
 const answerId=row?.answer_id??randomUUID();
 if(e){e.receiptDelivery='pending';e.receiptAnswer=freeze(boundedProjection(answer));}
 const partial=row?.why==='question'&&row.state==='open'&&!row.answer_id;
 const prior=row?.answer&&!partial?JSON.parse(row.answer):answer;
 if(row&&(row.delivery==='accepted'||row.source_kind==='engine'&&row.delivery==='failed'))return;
 if(row&&row.answer&&canonical(prior)!==canonical(answer))throw new Error('approval-answer-conflict');
 if(row)try{transaction(db=>{records.updateRecord(db,row.id,{state:'answered',settled_at:row.settled_at??Date.now(),answer:JSON.stringify(prior),answer_id:answerId,delivery:'pending'});if(!retry)patchTerminal({...row,state:'answered'},prior.behavior==='deny'?'Denied':row.queue_kind==='skill'&&JSON.parse(row.evidence).action.tool==='switch_skill'?'Answer received':'Allowed',prior);});}catch(error){
  if(e&&row.source_kind==='engine'){await send(undefined,e,{behavior:'deny',message:REFUSAL});try{requiredHost().store.appendMessage(e.threadId,{role:'bot',kind:'text',text:REFUSAL});}catch{}}
  throw error;
 }
 const target=e?.registration.snapshot?targetOf(e.registration.snapshot):row?JSON.parse(row.evidence).target:undefined;
 const q=row?.queue_kind?queues.get(row.queue_kind as T.ServiceId):undefined;
 const item=q && row ? queueItem(q,row.id) : undefined;
 if(row?.queue_kind&&(!item||!queueCallMatches(e,item,row.input_hash)))return;
 const respond=()=>{if(row&&e?.cancelled)return {state:'cancelled' as const};if(row?.queue_kind&&(!item||!queueCallMatches(e,item,row.input_hash)))return;const latest=!row&&e&&owner(e)?refresh(e):undefined;const current=!row&&e?.cancelled?{behavior:'deny' as const,message:REFUSAL}:latest?.kind==='refuse'?{behavior:'deny' as const,message:latest.message}:prior;if(current.behavior==='allow'&&e&&checkEntryRelease(e,prior,approvedForDelivery)){return;}creditTextWipe(row,e,current);if(e)e.deliveryStarted=true;if(e)e.receiptAnswer=freeze(boundedProjection(current));
  // 1021 Retry (RETRY-DESIGN-r2 step 4): the driver re-arm runs only here, after every release check above, one-shot.
  if(retry&&!retry.rearm())return Promise.resolve({state:'failed' as const});
  return row?.queue_kind?(q&&item?q.respond(item,prior,{answerId},settlement):Promise.resolve({state:'failed' as const})):target&&transport?transport.respond(target,current,{answerId}):Promise.resolve({state:'failed' as const});};
 let accepted=false,deliveryFailed=false,reason='no-target';
 for(let attempt=0;attempt<2;attempt++){
  try{const run=()=>withDeadline(item?.call.tool==='switch_skill'&&settlement.kind==='owner'?Promise.resolve(respond()):scheduleDelivery<Awaited<ReturnType<typeof respond>>>(respond),10000);const result=e&&owner(e)?await noLimitsSlot(e,run,false):await run();if(!result)return;if(result.state==='cancelled'){reason='cancelled';break;}if(result.state==='not-run'||result.state==='unconfirmed'){projectSkillResult(row,e,result);return;}if(e?.permissionReplyHold&&answer.behavior==='allow')return;if(result.state==='accepted'||result.state==='already'){accepted=true;break;}if(result.state==='failed'){reason=row?.queue_kind?'queue-failed':target?'no-open-entry':'no-target';}if(result.state==='failed'&&target){deliveryFailed=true;break;}}catch(error){if(target&&(error as {terminal?:boolean})?.terminal===true){reason='terminal-throw';deliveryFailed=true;break;}reason='deadline';}
  // Native acknowledgements can arrive before the transport's promise ends.
  const receipt=row&&records.readRecord(database(),row.id);
  if(receipt?.answer_id===answerId&&receipt.delivery==='accepted'){accepted=true;break;}
  if(!row&&e?.receiptDelivery==='accepted'&&e.receiptAnswer?.behavior===answer.behavior){accepted=true;break;}
  // A failed in-flight cancellation owns settlement and must not retry.
  if(row&&e?.cancelled)break;
 }
 if(item?.call.tool==='switch_skill'){const receipt=q?.receipt?.(item);if(receipt&&projectSkillResult(row,e,receipt))return;}
 // Never-dispatched cancellations were already settled by cancelThread.
 if(row&&e?.cancelled&&!e.deliveryStarted)return;
 const delivery=accepted||e?.receiptDelivery==='accepted'?'accepted':deliveryFailed?'failed':'unconfirmed';
 if(e)e.receiptDelivery=delivery;
 // cause22 caps r3: the owner's changed allow was over the engine's reply cap, so the driver denied that ONE ask with the fixed
 // note (accepted = that deny landed). Nothing was allowed: the receipt says deny, the owner reads one line, the turn goes on.
 if(accepted&&e?.replyTooLargeShown&&prior.behavior==='allow'){
  e.receiptAnswer=freeze(boundedProjection({behavior:'deny',message:OWNER_PERMISSION_REPLY_TOO_LARGE}));
  // a card's record carries the deny too, so nothing downstream (the outcome, the decision log, a task allowance) reads an allow
  if(row)transaction(db=>{records.updateRecord(db,row.id,{answer:JSON.stringify({behavior:'deny',message:OWNER_PERMISSION_REPLY_TOO_LARGE})});patchTerminal({...row,state:'answered'},OWNER_PERMISSION_REPLY_TOO_LARGE);});
  try{requiredHost().store.appendMessage(e.threadId,{role:'bot',kind:'text',text:OWNER_PERMISSION_REPLY_TOO_LARGE});}catch{}
 }
 // 1021 Retry: a failed engine permission card is decided by settleFailed (offered or endFailed), never patched here.
 const retryClass=!accepted&&deliveryFailed&&!!row&&!!e&&!!target&&!!transport&&row.source_kind==='engine'&&!row.queue_kind&&(prior.behavior==='allow'||prior.behavior==='deny')&&!e.replyTooLargeShown&&!e.permissionReplyHold&&!e.cancelled&&!e.cancellation;
 if(row)transaction(db=>{records.updateRecord(db,row.id,{delivery});if(deliveryFailed&&!retryClass)patchTerminal({...row,state:'answered'},e?.replyTooLargeShown?OWNER_PERMISSION_REPLY_TOO_LARGE:'The tool permission could not be delivered. Nothing was confirmed.');});
 if(!accepted&&row&&e?.cancellation){
  const state=e.cancellation;
  transaction(db=>{records.updateRecord(db,row.id,{state,settled_at:Date.now()});patchTerminal({...row,state},state==='superseded'?'Continued at the new level':state==='expired'?'Expired':'Cancelled');});
  if(e.row)e.row.state=state;
 }
 observe({type:'delivery',requestKey:e?.registration.key??row!.request_key,answerId,state:delivery});
 // 1021 undelivered card: one value-free line per answer not taken, naming the path (never an id, tool or input).
 if(delivery!=='accepted')console.info(`[decision] delivery not taken class=${row?.queue_kind?'queue':e?.registration.source.kind??row?.source_kind??'unknown'} reason=${reason} state=${delivery}`);
 // 1020 perm-deliver: at No limits an owner allow the engine already settled (failed, not unconfirmed) never ran and leaves
 // nothing waiting, so the turn goes on; only an answer that may have landed (unconfirmed) or a card answer stops the turn.
 if(!accepted&&deliveryFailed&&target&&!row&&e&&owner(e)&&!e.replyTooLargeShown&&answer.behavior==='allow'){console.warn('[decision] No limits allow not taken by the engine; the turn continues');}
 else if(retryClass){await stopAttempt(e!,target!);settleFailed(row!.id,e);}
 else if(!accepted){if(target&&transport)await withDeadline(transport.interrupt(target,PERMISSION_UNDELIVERED_STOP_REASON),1000).catch(()=>{});if(q&&item){if(row)records.updateRecord(database(),row.id,{delivery:'failed'});await withDeadline(q.cancel(item,'delivery-failed'),5000);}requiredHost().store.appendMessage(e?.threadId??row!.thread_id,{role:'bot',kind:'text',text:e?.replyTooLargeShown?OWNER_PERMISSION_REPLY_TOO_LARGE:'The tool permission could not be delivered. Nothing was confirmed.'});}
 if(e&&(e.registration.source.kind==='service'||e.outcome?.kind!=='card'&&e.outcome?.kind!=='question'))e.terminal=true;
 shedCompletedRequests();
}
// 1021 Retry on a delivery-failed approval card (RETRY-DESIGN-r2). settleFailed decides, endFailed is the only terminal transition.
const FAILED_CARD='The tool permission could not be delivered. Nothing was confirmed.';
const endedRecords=new Set<string>();
/** D4 (r3): only a stop the driver resolved as stop-failed (decisionInterrupt rejects with the marker) leaves the ask retryable;
 * landed, thrown, timeout or still pending at 1 s is terminal and one-way. */
async function stopAttempt(e:Entry,target:T.DecisionEngineTarget):Promise<void>{
 if(!transport)return;
 e.undeliveredStop='pending';
 let stop:Promise<void>;try{stop=transport.interrupt(target,PERMISSION_UNDELIVERED_STOP_REASON);}catch(error){stop=Promise.reject(error);}
 const settled=stop.then(()=>{if(e.undeliveredStop==='pending')e.undeliveredStop='landed';},error=>{if(e.undeliveredStop==='pending')e.undeliveredStop=isStopFailed(error)?'rejected':'terminal';});
 await withDeadline(settled,1000).catch(()=>{});
}
/** D3, in memory only: every condition must hold. */
function retryable(row:records.RecordRow,e:Entry|undefined):boolean{
 const target=e?.registration.snapshot?targetOf(e.registration.snapshot):undefined;
 if(!e||!target||!transport?.canRedeliver||e.endedFailed||endedRecords.has(row.id))return false;
 if(row.source_kind!=='engine'||row.queue_kind||row.why==='question'||row.why==='wipe'||owner(e)||row.state!=='answered'||row.delivery!=='failed'||!row.answer)return false;
 const behavior=safely(()=>JSON.parse(row.answer!).behavior,undefined);if(behavior!=='allow'&&behavior!=='deny')return false;
 if(e.row?.id!==row.id||e.cancelled||e.terminal||e.cancellation||e.permissionReplyHold||e.replyTooLargeShown)return false;
 if(captures.get(scopedKey(e.threadId,e.registration.key))?.snapshot.inputHash!==row.input_hash)return false;
 // MUTANT:retry-authority-reread
 if(ownerEligible(authority(e.threadId,e.authority.botId,e.authority.generation)))return false;
 // MUTANT:retry-stop-rejected-only
 if(e.undeliveredStop!=='rejected')return false;
 return safely(()=>transport!.canRedeliver!(target)===true,false);
}
function patchRetry(row:records.RecordRow,value?:'offered'|'sending'):void{
 const s=requiredHost().store,m=s.messageById(row.thread_id,row.chat_message_id,{buildIndex:false});if(!m?.card)return;
 const {deliveryRetry:_,...card}=m.card;s.patchMessagePoint(row.thread_id,row.chat_message_id,{card:value?{...card,deliveryRetry:value}:card});
}
function settleFailed(id:string,e:Entry|undefined):void{
 const row=records.readRecord(database(),id);if(!row)return;
 if(retryable(row,e)){patchRetry(row,'offered');boundOffer(row.id,e);return;}
 endFailed(row,e);
}
/** 1024 hygiene: a Send again offer nobody takes does not stay open for ever. After RETRY_OFFER_MS the card ends as a failed card
 * (endFailed, the one terminal path) unless the offer was already taken or ended; a sent retry or an ended record is left alone. */
const RETRY_OFFER_MS=10*60_000;
const offerTimers=new Map<string,ReturnType<typeof setTimeout>>();
function boundOffer(id:string,e:Entry|undefined):void{
 clearTimeout(offerTimers.get(id));
 const answerId=records.readRecord(database(),id)?.answer_id;
 const timer=setTimeout(()=>{
  offerTimers.delete(id);
  void (async()=>{
   try{
    const row=records.readRecord(database(),id);if(!row||row.delivery!=='failed'||row.state!=='answered'||row.answer_id!==answerId||endedRecords.has(id))return;
    const m=requiredHost().store.messageById(row.thread_id,row.chat_message_id,{buildIndex:false});if(m?.card?.deliveryRetry!=='offered')return;
    // Same close as a refused retry (retryWork): the ask may still be live, and a card nobody can answer must not leave it waiting.
    const target=e?.registration.snapshot?targetOf(e.registration.snapshot):undefined;
    const stop=!!e&&!!target&&!e.cancelled&&safely(()=>transport?.canRedeliver?.(target)===true,false);
    // The stop never depends on the card writes: a refused write must not leave the ask waiting on a closed card.
    try{endFailed(row,e);}finally{if(stop)await stopAttempt(e!,target!);}
   }catch{/* the host or database is gone: nothing left to close */}
  })();
 },RETRY_OFFER_MS);
 timer.unref?.();
 offerTimers.set(id,timer);
}
/** The only terminal transition of a failed engine card, idempotent per record: read-only card, one text row, attention settled. */
function endFailed(row:records.RecordRow,e:Entry|undefined):void{
 clearTimeout(offerTimers.get(row.id));offerTimers.delete(row.id);
 if(e)e.endedFailed=true;
 if(endedRecords.has(row.id))return;endedRecords.add(row.id);
 if(endedRecords.size>4096)endedRecords.delete(endedRecords.values().next().value!);
 patchRetry(row);
 patchTerminal({...row,state:'answered'},FAILED_CARD);
 try{requiredHost().store.appendMessage(row.thread_id,{role:'bot',kind:'text',text:FAILED_CARD});}catch{}
 try{host?.deliveryEnded?.(refFor(row.id));}catch{}
}
/** The ask left the driver (request.resolved, retire, dispose): a failed card still offering Send again ends. */
function endRetryOffer(e:Entry):void{
 if(!e.row||e.endedFailed||e.undeliveredStop===undefined)return;
 const row=records.readRecord(database(),e.row.id);
 if(row?.source_kind==='engine'&&row.state==='answered'&&row.delivery==='failed')endFailed(row,e);
}
type RetryDeliveryResult='accepted'|'delivery_pending'|'delivery_retry'|'delivery_failed_terminal'|'delivery_unconfirmed';
function retryResult(id:string):RetryDeliveryResult{
 const row=records.readRecord(database(),id);
 if(!row||row.state!=='answered')return 'delivery_failed_terminal';
 if(row.delivery==='accepted')return 'accepted';
 if(row.delivery==='pending')return 'delivery_pending';
 if(row.delivery==='unconfirmed')return 'delivery_unconfirmed';
 if(row.delivery==='failed'){const m=requiredHost().store.messageById(row.thread_id,row.chat_message_id,{buildIndex:false});return m?.card?.deliveryRetry==='offered'&&!endedRecords.has(row.id)?'delivery_retry':'delivery_failed_terminal';}
 return 'delivery_failed_terminal';
}
/** POST .../retry-delivery: re-send the owner's stored answer through send() (every release check runs again). */
export async function retryDelivery(ref:T.ApprovalRef):Promise<RetryDeliveryResult>{
 const row=requireRow(ref),e=entryForRef(ref);
 // Step 1: single flight per record, shared with answerApproval.
 const joined=answerFlights.get(row.id)??e?.delivery;
 if(joined){await joined.catch(()=>{});return retryResult(row.id);}
 const work=retryWork(row.id,e);answerFlights.set(row.id,work);if(e)e.delivery=work;
 try{await work;}finally{if(answerFlights.get(row.id)===work)answerFlights.delete(row.id);if(e?.delivery===work)e.delivery=undefined;}
 return retryResult(row.id);
}
async function retryWork(id:string,e:Entry|undefined):Promise<void>{
 const row=records.readRecord(database(),id);
 // Step 2: anything but a failed engine card is reported as it is and left alone.
 if(!row||row.source_kind!=='engine'||row.delivery!=='failed')return;
 const target=e?.registration.snapshot?targetOf(e.registration.snapshot):undefined;
 // Opus r2 H3: the extra stop only while the ask is still live in its own generation (a stale click never stops a newer turn).
 const live=()=>!!e&&!!target&&!e.cancelled&&safely(()=>transport?.canRedeliver?.(target)===true,false);
 if(!retryable(row,e)){const stop=live()&&e!.undeliveredStop!==undefined;endFailed(row,e);if(stop)await stopAttempt(e!,target!);return;}
 // Step 3: compare-and-set failed -> pending with a new answer_id while the old one still matches.
 const answerId=randomUUID();let won=false;
 // MUTANT:retry-cas
 transaction(db=>{const now=records.readRecord(db,id);if(now?.delivery==='failed'&&now.answer_id===row.answer_id){records.updateRecord(db,id,{delivery:'pending',answer_id:answerId});won=true;}});
 if(!won)return;
 if(e)e.deliveryStarted=false;
 patchRetry(row,'sending');
 // Step 4: the existing send(); the re-arm is one-shot inside its respond closure.
 let rearmed:boolean|undefined;
 // MUTANT:retry-rearm-once
 const rearm=()=>rearmed??=safely(()=>transport?.rearmRetry?.(target!)===true,false);
 const stored=JSON.parse(row.answer!) as T.ApprovalAnswer;
 try{await send(records.readRecord(database(),id)!,e,stored,undefined,{rearm});}catch{}
 // Step 6: the gate's silent returns write nothing; read the row again.
 const after=records.readRecord(database(),id);if(!after)return;
 if(after.state!=='answered'){if(after.delivery==='pending')records.updateRecord(database(),id,{delivery:'none'});return;}
 if(after.delivery==='accepted'){patchRetry(after);patchTerminal(after,stored.behavior==='deny'?'Denied':'Allowed');return;}
 if(after.delivery==='unconfirmed'){patchRetry(after);return;}
 // MUTANT:retry-refused-settle
 if(after.delivery==='pending'&&after.answer_id===answerId){
  // Opus r2 H4: once the re-arm ran a native send may still be in flight (a slow first pass), so the answer is unconfirmed.
  // MUTANT:retry-rearm-memo
  const next=rearmed===true?'unconfirmed' as const:'failed' as const;let refused=false;
  transaction(db=>{const now=records.readRecord(db,id);if(now?.delivery==='pending'&&now.answer_id===answerId){records.updateRecord(db,id,{delivery:next});refused=true;}});
  if(refused){const stop=live();endFailed({...after,delivery:next},e);if(stop)await stopAttempt(e!,target!);}
 }
}
export async function answerApproval(ref:T.ApprovalRef,answer:T.ApprovalAnswer,settlement:Settlement=automaticSettlement()):Promise<void>{
 const e=entryForRef(ref),row=requireRow(ref);
 if(e?.registration.snapshot){const snap=captures.get(scopedKey(e.threadId,e.registration.key))?.snapshot;if(snap&&snap.inputHash!==row.input_hash)throw new Error('approval-input-violation');}
 if(row.state!=='open'&&!row.answer_id)return;
 if(e?.delivery)return e.delivery;
 const flight=answerFlights.get(row.id);if(flight)return flight;
 const work=send(row,e,answer,settlement);answerFlights.set(row.id,work);if(e)e.delivery=work;try{await work;
  // Log a human skip only after native acceptance. The single answer flight
  // owns the audit write; concurrent clicks and accepted replays add nothing.
  const receipt=records.readRecord(database(),row.id),action=JSON.parse(row.evidence).action;
  const question=!action.folderTrust&&(typeof action.question==='string'||Array.isArray(action.questions));
  if(question&&row.delivery!=='accepted'&&receipt?.delivery==='accepted'&&receipt.answer&&JSON.parse(receipt.answer).behavior==='deny'){
   const bot=requiredHost().store.bot(row.bot_id);
   appendDecision(DATA_DIR,{threadId:row.thread_id,requestId:row.request_id,botId:row.bot_id,botName:bot?.name,tool:action.tool,summary:action.summary??action.question,decision:'question-skipped',source:'user'});
  }
 }finally{if(answerFlights.get(row.id)===work)answerFlights.delete(row.id);if(e?.outcome?.kind==='card'||e?.outcome?.kind==='question')e.delivery=undefined;}
}
export async function deliverRequest(handle:T.RequestHandle):Promise<void>{
 const e=entry(handle);if(e.registration.source.kind!=='engine')throw new Error('engine-request-required');if(e.delivery)return e.delivery;
 const outcome=refresh(e);if(outcome.kind==='card'||outcome.kind==='question'){try{await presentApproval(outcome.ref,requiredHost().view(e.registration));return;}catch{e.outcome={kind:'refuse',message:REFUSAL};if(!e.delivery)e.delivery=send(undefined,e,{behavior:'deny',message:REFUSAL});await e.delivery;return;}}
 const work=send(undefined,e,{behavior:outcome.kind==='run'?'allow':'deny',...(outcome.kind==='refuse'?{message:outcome.message}:{})});e.delivery=work;
 if(outcome.kind==='refuse'){if(featureOffMessage(e)===outcome.message)explainFeatureOff(e,outcome);else requiredHost().store.appendMessage(e.threadId,{role:'bot',kind:'text',text:outcome.message.slice(0,160)});}
 return work.finally(()=>{if(e.outcome?.kind==='card'||e.outcome?.kind==='question')e.delivery=undefined;});
}
function explainFeatureOff(e:Entry,o:T.Outcome):void {
 if(o.kind!=='refuse'||e.featureOffNoted||featureOffMessage(e)!==o.message)return;
 e.featureOffNoted=true;requiredHost().store.appendMessage(e.threadId,{role:'bot',kind:'text',text:o.message});
}
export function executeService<V>(handle:T.RequestHandle,execute:(call:T.ServiceCall)=>Promise<V>):Promise<T.ServiceExecution<V>>{
 const e=entry(handle);if(e.registration.source.kind!=='service')throw new Error('service-request-required');if(e.execution)return e.execution;if(e.executionStarted)throw new Error('service-execution-consumed');
 const o=refresh(e);if(o.kind!=='run'){explainFeatureOff(e,o);return Promise.resolve(o);}
 const call=e.executionCall??e.registration.source.call;
 const run=async ():Promise<T.ServiceExecution<V>>=>{
  if(e.cancelled)return {kind:'refuse' as const,message:REFUSAL};
  const latest=refresh(e);if(latest.kind!=='run'){explainFeatureOff(e,latest);return latest;}
  const blocked=checkEntryRelease(e,{behavior:'allow'});if(blocked)return blocked;
  e.executionStarted=true;const value=await execute(call);return {kind:'executed',value};
 };
 e.execution=(owner(e)?noLimitsSlot(e,run):Promise.resolve().then(run)).then(result=>{if(result.kind==='executed')e.executionResult=result;return result;}).finally(()=>{if(e.executionStarted)e.terminal=true;else e.execution=undefined;shedCompletedRequests();});return e.execution;
}
export async function onLevelChange(botId:string):Promise<void>{return skillSettlementWork.drain(async()=>{
 let after='';
 for(;;){
  const page=records.openBasePage(database(),botId,after);
  for(const r of page.slice(0,16)){await (async()=>{
   if(r.queue_kind==='event-limit')return;
  const e=entriesByApproval.get(r.id);if(!e)return;
  const a=authority(r.thread_id,botId,r.generation??undefined);
  if(a.level!=='unlimited'){
   const q=r.queue_kind?queues.get(r.queue_kind as T.ServiceId):undefined,item=q&&queueItem(q,r.id);
   if(item?.call.tool==='switch_skill')await answerApproval(refFor(r.id),{behavior:'allow'},automaticSettlement('level-upgrade'));
   return;
  }
  let action=e.registration.action;
  const input=e.registration.source.kind==='engine'?e.registration.snapshot:e.registration.source.call;
  if(ownerEligible(a)&&input)action=describeNoLimits(input,e.threadId,a.botId);
  e.authority=a;e.registration=freeze({...e.registration,level:a.level,actor:a.actor,action,registrationHash:hash({previous:e.registration.registrationHash,level:a.level,actor:a.actor,action})});
  if(!e.exact){const original=e.registration.source.kind==='service'?e.executionCall:captures.get(scopedKey(e.threadId,e.registration.key))?.upgrade;if(original)e.exact=extractInspectedOperation(original);if(e.exact&&e.exact.kind!=='incomplete')e.originalOperationHash=e.exact.operationHash;}
  const outcome=refresh(e);
  if(outcome.kind==='run'){
   if(checkEntryRelease(e,{behavior:'allow'}))return;
   // A former BASE card grants no protected evidence when No limits removes
   // its base ask. A later protected fact therefore always needs a new card.
   if(e.exact&&e.exact.kind!=='incomplete'){const row=records.readRecord(database(),r.id);if(!row)return;const payload=JSON.parse(row.evidence);payload.releaseEvidence={operationHash:e.exact.operationHash,inspection:{decisions:[]}};records.updateRecord(database(),r.id,{evidence:JSON.stringify(payload)});}
   await answerApproval(refFor(r.id),{behavior:'allow'},automaticSettlement('level-upgrade'));
  }
  else if(outcome.kind==='card'&&owner(e)){
   const items=wipeEvidence(e.registration.action);
   if(items.length){const payload=JSON.parse(r.evidence);payload.items=items;records.updateRecord(database(),r.id,{why:items[0].kind,level:a.level,registration_hash:e.registration.registrationHash,evidence:JSON.stringify(payload)});}
  }
  })();}
  if(page.length)await settlementYield();
  if(page.length<=16)break;
  after=page[15]!.id;
 }
});}

async function cancelEntry(e:Entry,state:'cancelled'|'expired'|'superseded'){
 // Fence every new release synchronously, independently of receipt settlement.
 e.cancelled=true;e.terminal=true;if(!e.approvalDeliveryFailed)e.cancellation=state;
 endRetryOffer(e);
 // Retirement cannot undo an Allow the native transport already confirmed.
 // Preserve that history while the fence prevents later execution or replay.
 if(e.registration.source.kind==='engine'&&e.deliveryStarted&&e.receiptDelivery==='accepted'&&e.receiptAnswer?.behavior==='allow')return;
 e.outcome=freeze({kind:'refuse',message:REFUSAL});
 const persisted=e.row&&records.readRecord(database(),e.row.id);if(persisted)await settle(refFor(persisted.id),state);
 const src=e.registration.source;
 if(!persisted&&src.kind==='service'&&e.attached){const q=queues.get(src.service),item=q?.pendingApprovals().find(i=>i.approvalId===e.row?.id);if(item&&q)await withDeadline(q.cancel(item,state),5000);}
}
export async function cancelRequests(scope:T.RequestCancellation,state:'cancelled'|'expired'|'superseded'):Promise<void>{
 return retireRequests(scope,state,false);
}
async function retireRequests(scope:T.RequestCancellation,state:'cancelled'|'expired'|'superseded',preserveQueued:boolean):Promise<void>{
 const matching=[...entries.values()].filter(e=>e.threadId===scope.threadId&&(scope.kind==='thread'||e.authority.generation===scope.generation)
  // Only an unfinished service card remains owned by its durable queue.
  // Completed deliveries retire with unqueued work, outside active capacity.
  && !(scope.kind==='generation'&&preserveQueued&&e.registration.source.kind==='service'&&e.attached&&!e.terminal));
 // Start every fence before waiting for any persisted settlement or queue IO.
 const results=await Promise.allSettled(matching.map(e=>cancelEntry(e,state)));
 const failed=results.find(r=>r.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
}
export function initiatorKindFor(generation:string):T.TurnProvenance|undefined{return reader?.provenance(generation);}
export function readTurnPolicy(identity:T.TurnIdentity):T.TurnPolicy|undefined{
 const a=authority(identity.threadId,undefined,identity.generation);if(a.generation!==identity.generation)return;
 const noLimits=ownerEligible(a);
 const permission=a.level==='ask'?{routeAsks:true as const,askLevel:true as const}:a.level==='auto'?{routeAsks:true as const}:{stopLine:true as const,...(noLimits?{noLimits:true as const}:{})};
 return freeze({actor:a.actor,level:a.level,permission});
}
function questionProgress(row:records.RecordRow):T.ApprovalAnswer['answers'] {if(!row.answer||row.answer_id)return [];try{return JSON.parse(row.answer).answers??[];}catch{return [];}}
function questionText(row:records.RecordRow,n:number,total=n):string{
 const a=JSON.parse(row.evidence).action,answers=questionProgress(row)??[],questions=a.questions??[],q=questions[answers.length],choices=q?q.options.map((o:any)=>o.label):a.options??[];
 return `Question ${questions.length>1?answers.length+1:n} of ${questions.length>1?questions.length:total}\n${q?.question??a.question??a.tool??'Question'}\n${choices.map((v:string,i:number)=>`${i+1}. ${v}`).join('\n')}`;
}
export async function answerQuestionReply(threadId:string,text:string):Promise<T.QuestionReplyResult>{
 const rows=records.openRecords(database(),threadId).filter(r=>r.why==='question');const first=rows[0];if(!first)return {kind:'send',pending:[]};
 const a=JSON.parse(first.evidence).action,answers=questionProgress(first)??[],q=a.questions?.[answers.length],choices:string[]=q?q.options.map((o:any)=>o.label):a.options??[];
 let index=/^\d+$/.test(text.trim())?Number(text.trim())-1:choices.findIndex(c=>c.toLowerCase()===text.trim().toLowerCase());if(index<0||index>=choices.length)index=-1;
 const free=q?!!q.allowOther:choices.length===0||choices.includes('Other');
 if(index<0&&!free)return {kind:'send',pending:rows.map(r=>refFor(r.id))};
 const ref=refFor(first.id),message=index>=0?choices[index]:text;
 const collected=q?[...answers,{id:q.id,selected:index>=0?[choices[index]]:[],...(index<0?{other:text}:{})}]:undefined;
 if(q&&collected!.length<a.questions.length){records.updateRecord(database(),first.id,{answer:JSON.stringify({behavior:'answer',answers:collected,message})});requiredHost().store.appendMessage(threadId,{role:'bot',kind:'text',text:questionText(records.readRecord(database(),first.id)!,1,rows.length)});return {kind:'answered',ref};}
 await answerApproval(ref,{behavior:'answer',message,...(collected?{answers:collected}:{})});return {kind:'answered',ref};
}

export async function relistQuestions(threadId:string):Promise<void>{const rows=records.openRecords(database(),threadId).filter(r=>r.why==='question');for(let i=0;i<rows.length;i++){
  // An open card is still on screen and answerable. Only a question that an
  // earlier build stored as a text row is listed again.
  if(requiredHost().store.messageById(threadId,rows[i].chat_message_id,{buildIndex:false})?.card)continue;
  requiredHost().store.appendMessage(threadId,{role:'bot',kind:'text',text:questionText(rows[i],i+1,rows.length)});}}
export async function saveContinuation(key:T.ContinuationKey,parent:T.TurnIdentity):Promise<void>{const a=authority(parent.threadId,key.botId,parent.generation);if(parent.threadId!==key.threadId||a.actor==='unproven'||!a.provenance)throw new Error('unproven-continuation');records.saveContinuationRecord(database(),canonical(key),canonical({level:a.level,actor:a.actor,initiator:a.provenance.initiator,principal:a.provenance.principal,roomOwnerOnly:a.provenance.roomOwnerOnly}));}
export function readContinuation(key:T.ContinuationKey):T.ContinuationProvenance|undefined{const value=records.readContinuationRecord(database(),canonical(key));return value?freeze(JSON.parse(value)):undefined;}
export async function deleteContinuation(key:T.ContinuationKey):Promise<void>{records.deleteContinuationRecord(database(),canonical(key));}
const settlementYield=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function* queueRecoveryItems(q:T.QueueRecoverySource):AsyncGenerator<T.PendingQueueApproval>{
 if(!q.pendingPage){for(const item of q.pendingApprovals())yield item;return;}
 let after:string|undefined;
 do{const page=q.pendingPage(after,16);for(const item of page.items)yield item;after=page.next;if(page.items.length)await settlementYield();}while(after);
}
async function* recoveryRows(source:'engine'|'service',state:'open'|'answered'):AsyncGenerator<records.RecordRow>{
 let after='';
 for(;;){const page=records.recoveryPage(database(),source,state,after);for(const row of page.slice(0,16))yield row;if(page.length)await settlementYield();if(page.length<=16)return;after=page[15]!.id;}
}
async function recoverQueueRun(q:T.QueueRecoverySource,item:T.PendingQueueApproval,e:Entry,row?:records.RecordRow):Promise<void>{
 if(row){await send(row,e,{behavior:'allow'},automaticSettlement('recovery'));return;}
 if(preflightSkillDelivery(undefined,e,q,item,automaticSettlement('recovery')))return;
 const db=database(),prior=records.readQueueDelivery(db,item.approvalId);
 if(prior&&(prior.kind!==item.kind||prior.inputHash!==e.registration.inputHash)){await withDeadline(q.cancel(item,'conflict'),5000);throw new Error('queue-delivery-conflict');}
 const receipt=prior??{kind:item.kind,inputHash:e.registration.inputHash,answerId:randomUUID(),delivery:'pending' as const};
 records.writeQueueDelivery(db,item.approvalId,{...receipt,delivery:'pending'});
 for(let attempt=0;attempt<2;attempt++)try{
  const blocked=checkEntryRelease(e,{behavior:'allow'});if(blocked){if(blocked.kind==='card'||blocked.kind==='question')await presentApproval(blocked.ref,item.view);return;}
  if(!queueCallMatches(e,item,e.registration.inputHash))throw new Error('queue-action-mismatch');
  const ack=await withDeadline(q.respond(item,{behavior:'allow'},{answerId:receipt.answerId},automaticSettlement('recovery')),10000);
  if(ack.state==='not-run'||ack.state==='unconfirmed'){projectSkillResult(row,e,ack);return;}
  if(ack.state==='accepted'||ack.state==='already'){records.deleteQueueDelivery(db,item.approvalId);e.terminal=true;observe({type:'delivery',requestKey:e.registration.key,answerId:receipt.answerId,state:'accepted'});return;}
 }catch{}
 records.writeQueueDelivery(db,item.approvalId,{...receipt,delivery:'failed'});observe({type:'delivery',requestKey:e.registration.key,answerId:receipt.answerId,state:'failed'});await withDeadline(q.cancel(item,'delivery-failed'),5000);records.deleteQueueDelivery(db,item.approvalId);throw new Error('queue-delivery-failed');
}
function pruneQueueReceipts(){
 const db=database();
 const rows=db.prepare("SELECT key,value FROM decision_continuations WHERE key GLOB 'queue-answer:*' ORDER BY key LIMIT 16").all();
 for(const row of rows){const id=String(row.key).slice('queue-answer:'.length),saved=JSON.parse(String(row.value)),q=queues.get(saved.kind as T.ServiceId);if(q?.approval&&!q.approval(id))records.deleteQueueDelivery(db,id);}
}
let pruneTimer:ReturnType<typeof setInterval>|undefined;
export async function recover():Promise<void>{return skillSettlementWork.drain(async()=>{
 const db=database();requiredHost();
 for(const kind of records.requiredQueueKinds(db))if(!queues.has(kind as T.ServiceId))throw new Error('queue-recovery-source-missing');
 // No engine generation survives restart. Persisted pending delivery is honest.
 for await(const row of recoveryRows('engine','open'))await settle(refFor(row.id),'expired');
 // 1021 Retry: no eligibility survives a restart. A failed engine card still offering Send again ends read-only.
 // MUTANT:retry-boot-sweep
 for(const r of records.failedEngineAnswers(db)){const m=requiredHost().store.messageById(r.thread_id,r.chat_message_id,{buildIndex:false});if(m?.card?.deliveryRetry)endFailed(r,undefined);}
 for await(const r of recoveryRows('engine','answered')){if(r.delivery!=='pending')continue;records.updateRecord(db,r.id,{delivery:'unconfirmed'});patchTerminal(r,r.answer&&JSON.parse(r.answer).behavior==='deny'?'Denied':'Allowed, not run (restart)');
 }
 for await(const row of recoveryRows('service','open')){
  if(!queues.has(row.queue_kind as T.ServiceId))throw new Error('queue-recovery-source-missing');
  if(row.queue_kind==='skill'&&JSON.parse(row.evidence).action.tool==='switch_skill'){const q=queues.get('skill');if(q?.approval&&!q.approval(row.id))projectSkillResult(row,undefined,{state:'unconfirmed',message:UNCONFIRMED_SKILL_SWITCH});}
  if(row.queue_kind==='peer'&&JSON.parse(row.evidence).action.answerAsSend===true)await settle(refFor(row.id),'expired');
 }
 for(const q of queues.values())for await(let item of queueRecoveryItems(q)){
  const durable=q.receipt?.(item);
  if(item.call.tool==='switch_skill'&&durable){const row=records.readRecord(db,item.approvalId);projectSkillResult(row,undefined,durable);continue;}
  if(item.kind!==q.kind||item.ref!==item.call.approval.queueRef||item.epoch!==item.call.approval.epoch){await withDeadline(q.cancel(item,'conflict'),5000);continue;}
  let row=records.readRecord(db,item.approvalId);
  if(row&&(row.queue_kind!==item.kind||row.queue_ref!==item.ref||JSON.parse(row.evidence).epoch!==item.epoch||row.input_hash!==hash(checkedCall(item.call)))){await withDeadline(q.cancel(item,'conflict'),5000);continue;}
  // The queue file can outlive the process that owned its waiting call. Expire it before policy can release it.
  if((!row || row.state==='open') && requiresLiveApprovalRecipient(item)){
   if(row)await settle(refFor(row.id),'expired');else await withDeadline(q.cancel(item,'expired'),5000);
   continue;
  }
  if(row&&row.state!=='open'){
   if(row.queue_kind==='peer'&&JSON.parse(row.evidence).action.answerAsSend===true){await withDeadline(q.cancel(item,'cancelled'),5000);continue;}
   if(row.state==='answered'){
    if(row.delivery!=='pending'&&row.delivery!=='failed')continue;
    const prior=reopenQueueDelivery(q,item,row);
    if(!prior){await withDeadline(q.cancel(item,'unverifiable'),5000);continue;}
    const answer:T.ApprovalAnswer=JSON.parse(row.answer!);
    if(answer.behavior!=='allow'||!checkEntryRelease(prior,answer,refFor(row.id))){await send(row,prior,answer,automaticSettlement('recovery'));continue;}
    records.updateRecord(db,row.id,{state:'superseded',settled_at:Date.now()});patchTerminal({...row,state:'superseded'},'Permission changed before release');prior.terminal=true;
   }
   const renewal={approvalId:randomUUID(),epoch:randomUUID()};
   const renewed=await withDeadline(q.renew(item,renewal),5000);if(renewed.approvalId!==renewal.approvalId||renewed.epoch!==renewal.epoch||renewed.call.approval.epoch!==renewal.epoch||renewed.ref!==item.ref||renewed.kind!==item.kind)throw new Error('queue-renewal-conflict');item=renewed;row=undefined;
  }
  const src=q.reopen(item);if(!src||src.service!==q.kind||hash(checkedCall(src.call))!==hash(checkedCall(item.call))||!claims.has(src.claim)){await withDeadline(q.cancel(item,'unverifiable'),5000);continue;}
  const handle=openRequest(src),e=entry(handle);if(row&&(row.thread_id!==e.threadId||row.bot_id!==e.authority.botId)){await withDeadline(q.cancel(item,'unverifiable'),5000);continue;}const outcome=decide(handle,q.base);
  if(outcome.kind==='run'){await recoverQueueRun(q,item,e,row);continue;}
  if(outcome.kind==='refuse'){await withDeadline(q.cancel(item,'unverifiable'),5000);continue;}
  if(!row){const old=e.row!;const payload=JSON.parse(old.evidence);payload.action.approvalId=item.approvalId;old.id=item.approvalId;indexApprovalEntry(old.id,e);old.action_hash=hash(actionProjection(payload.action));payload.action.actionHash=old.action_hash;old.evidence=JSON.stringify(payload);e.ref=refFor(old.id);e.outcome={kind:outcome.kind,ref:e.ref};}
  else{e.row=row;indexApprovalEntry(row.id,e);e.ref=refFor(row.id);e.outcome={kind:outcome.kind,ref:e.ref};}
  attachQueue(e.ref!,{kind:q.kind,ref:item.ref,call:item.call});await presentApproval(e.ref!,item.view);
  const recovered=readApproval(item.approvalId);
  if(recovered?.state==='open' && recovered.queue?.kind===item.kind && recovered.queue.ref===item.ref && recovered.queue.epoch===item.epoch)
   requiredHost().recoveredAttention?.present(recovered);
 }
 records.pruneRecords(db);pruneQueueReceipts();if(!pruneTimer){pruneTimer=setInterval(()=>{try{records.pruneRecords(database());pruneQueueReceipts();}catch{}},3600000);pruneTimer.unref?.();}
});}

export function executeServiceSync<V>(handle:T.RequestHandle,execute:(call:T.ServiceCall)=>V):T.ServiceExecution<V>{
 const e=entry(handle);if(e.registration.source.kind!=='service')throw new Error('service-request-required');
 if(e.executionResult)return e.executionResult;
 if(e.executionStarted||e.execution)throw new Error('service-execution-pending');
 const o=refresh(e);if(o.kind!=='run'){explainFeatureOff(e,o);return o;}
 const blocked=checkEntryRelease(e,{behavior:'allow'});if(blocked)return blocked;
 e.executionStarted=true;
 try{
  const value=execute(e.executionCall??e.registration.source.call);
  if(value&&typeof (value as any).then==='function'){void Promise.resolve(value).catch(()=>{});throw new Error('synchronous-service-required');}
  const result={kind:'executed' as const,value};e.executionResult=result;e.execution=Promise.resolve(result);return result;
 }finally{e.terminal=true;}
}

export function presentApprovalSync(ref:T.ApprovalRef,view:T.ApprovalView):void {
 const e=entryForRef(ref);if(e?.terminal&&(e.outcome?.kind==='run'||e.outcome?.kind==='refuse'))return;let row=e?.row??requireRow(ref);
 if(row.source_kind!=='service')throw new Error('synchronous-service-required');
 if(e){
  // Presentation can precede the asynchronous level-change queue drain.
  // Re-read this bound turn before deciding whether its old BASE ask survives.
  if(row.why==='base'&&!owner(e)){
   const a=authority(e.threadId,e.authority.botId,e.authority.generation);
   if(ownerEligible(a)){
    const input=e.registration.source.kind==='engine'?e.registration.snapshot:e.registration.source.call;
    const action=input?describeNoLimits(input,e.threadId,a.botId):e.registration.action;
    e.authority=a;e.registration=freeze({...e.registration,level:a.level,actor:a.actor,action,registrationHash:hash({previous:e.registration.registrationHash,level:a.level,actor:a.actor,action})});
   }
  }
  const next=refresh(e);
  if(next.kind==='run'){
   const source=queues.get(row.service as T.ServiceId),cap=synchronousQueues.get(row.service as T.ServiceId);
   const item=source ? queueItem(source,ref.approvalId) : undefined;
   if(!source||cap?.source!==source||!item)throw new Error('synchronous-queue-required');
   if(!queueCallMatches(e,item,e.registration.inputHash))throw new Error('queue-action-mismatch');
   if(records.readRecord(database(),row.id)){
    const ack=answerApprovalSync(ref,{behavior:'allow'});if(ack.state==='failed'){if(e.outcome?.kind==='card'||e.outcome?.kind==='question')return;throw new Error('queue-delivery-failed');}
   }else{
    const db=database(),prior=records.readQueueDelivery(db,item.approvalId);
    if(prior&&(prior.kind!==item.kind||prior.inputHash!==e.registration.inputHash))throw new Error('queue-delivery-conflict');
    const receipt=prior??{kind:item.kind,inputHash:e.registration.inputHash,answerId:randomUUID(),delivery:'pending' as const};
    records.writeQueueDelivery(db,item.approvalId,{...receipt,delivery:'pending'});
    const blocked=checkEntryRelease(e,{behavior:'allow'});if(blocked){if(blocked.kind==='card'||blocked.kind==='question')presentApprovalSync(blocked.ref,view);return;}
    const ack=synchronousAck(()=>{if(checkEntryRelease(e,{behavior:'allow'}))return {state:'failed'};if(!queueCallMatches(e,item,e.registration.inputHash))return {state:'failed'};return cap.delivery.respondNow(item,{behavior:'allow'},{answerId:receipt.answerId},automaticSettlement('no-limits'));});const accepted=ack.state==='accepted'||ack.state==='already';
    if(!accepted){records.writeQueueDelivery(db,item.approvalId,{...receipt,delivery:'failed'});throw new Error('queue-delivery-failed');}
    records.deleteQueueDelivery(db,item.approvalId);
   }
   e.terminal=true;return;
  }
  if(next.kind==='refuse')throw new Error('synchronous-presentation-refused');
  if(next.ref.approvalId!==ref.approvalId)throw new Error('approval-superseded');
  row=records.readRecord(database(),row.id)??e.row!;
 }
 if(!row.queue_kind)throw new Error('queue-must-be-attached');
 if(row.state!=='open')return;
 const count=records.openRecords(database(),row.thread_id).filter(r=>r.why==='question').length;
 if(row.why==='question'&&count>=8&&!records.readRecord(database(),row.id))throw new Error('question-capacity');
 commitPresentation(row,ref,view);
}
export function installSynchronousQueueDeliveries(deliveries:readonly T.SynchronousQueueDelivery[]):()=>void {
 const own=new Map<T.ServiceId,{source:T.QueueRecoverySource;delivery:T.SynchronousQueueDelivery}>();
 for(const delivery of deliveries){
  const source=queues.get(delivery.kind);if(!source)throw new Error('queue-recovery-source-missing');
  if(synchronousQueues.has(delivery.kind)||own.has(delivery.kind))throw new Error('duplicate-queue-source');
  own.set(delivery.kind,{source,delivery});
 }
 for(const [kind,cap]of own)synchronousQueues.set(kind,cap);
 return()=>{for(const [kind,cap]of own)if(synchronousQueues.get(kind)===cap)synchronousQueues.delete(kind);};
}
export function answerApprovalSync(ref:T.ApprovalRef,answer:T.ApprovalAnswer,settlement:Settlement=automaticSettlement()):import('../contracts.ts').RequestDelivery {
 const row=requireRow(ref);
 if(row.queue_kind!=='skill'||JSON.parse(row.evidence).action.tool!=='switch_skill')return answerApprovalSyncInSettlement(ref,answer,settlement);
 const q=queues.get('skill'),item=q&&queueItem(q,row.id),receipt=item&&q?.receipt?.(item);
 if(receipt){void skillSettlementWork.item(()=>projectSkillResult(row,entriesByApproval.get(row.id),receipt)).catch(()=>{});return receipt;}
 return skillSettlementWork.now(()=>answerApprovalSyncInSettlement(ref,answer,settlement))??{state:'failed',code:'capacity',message:'Skill changes are busy. Nothing was changed.'};
}
function answerApprovalSyncInSettlement(ref:T.ApprovalRef,answer:T.ApprovalAnswer,settlement:Settlement):import('../contracts.ts').RequestDelivery {
 let e=entryForRef(ref);const row=requireRow(ref);
 if(row.source_kind!=='service'||!row.queue_kind)return {state:'failed'};
 const prior:T.ApprovalAnswer=row.answer?JSON.parse(row.answer):answer;
 if(row.answer&&canonical(prior)!==canonical(answer))return {state:'failed'};
 const producer=queues.get(row.queue_kind as T.ServiceId),registeredItem=producer&&queueItem(producer,row.id);
 if(registeredItem?.call.tool==='switch_skill'){
  const receipt=producer?.receipt?.(registeredItem);
  if(receipt){projectSkillResult(row,e,receipt);return receipt;}
  if(prior.behavior==='allow'&&producer&&preflightSkillDelivery(row,e,producer,registeredItem,settlement))return producer.receipt?.(registeredItem)??{state:'not-run'};
  if(row.delivery==='accepted'){const conflict={state:'unconfirmed' as const,message:UNCONFIRMED_SKILL_SWITCH};projectSkillResult(row,e,conflict);return conflict;}
 }else if(row.delivery==='accepted')return {state:'already'};
 if(e?.delivery||answerFlights.has(row.id))return {state:'failed'};
 if(row.state!=='open'&&!row.answer_id)return {state:'failed'};
 const source=queues.get(row.queue_kind as T.ServiceId),cap=synchronousQueues.get(row.queue_kind as T.ServiceId);
 const item=source ? queueItem(source,row.id) : undefined;
 if(!source||cap?.source!==source||!item||!queueCallMatches(e,item,row.input_hash)){
  reportDecisionRefusal(!source?'queue-source-missing':cap?.source!==source?'synchronous-queue-capability-missing':!item?'queue-item-missing':'queue-call-mismatch','queue-answer');
  return {state:'failed'};
 }
 e??=reopenQueueDelivery(source,item,row);if(!e)return {state:'failed'};
 if(prior.behavior==='allow'&&checkEntryRelease(e,prior,ref))return {state:'failed'};
 const answerId=row.answer_id??randomUUID();let finish!:()=>void;
 const flight=new Promise<void>(resolve=>{finish=resolve;});answerFlights.set(row.id,flight);
 let result:import('../contracts.ts').RequestDelivery={state:'failed'};let releaseHeld=false;
 try{
  transaction(db=>{records.updateRecord(db,row.id,{state:'answered',settled_at:row.settled_at??Date.now(),answer:JSON.stringify(prior),answer_id:answerId,delivery:'pending'});patchTerminal({...row,state:'answered'},prior.behavior==='deny'?'Denied':row.queue_kind==='skill'&&JSON.parse(row.evidence).action.tool==='switch_skill'?'Answer received':'Allowed');});
  result=synchronousAck(()=>{if(prior.behavior==='allow'&&checkEntryRelease(e!,prior,ref)){releaseHeld=true;return {state:'failed'};}if(!queueCallMatches(e,item,row.input_hash))return {state:'failed'};return cap.delivery.respondNow(item,prior,{answerId},settlement);});
  if(releaseHeld)return result;
  if(result.state==='not-run'||result.state==='unconfirmed'){projectSkillResult(row,e,result);return result;}
  const accepted=result.state==='accepted'||result.state==='already';
  transaction(db=>{records.updateRecord(db,row.id,{delivery:accepted?'accepted':'failed'});if(!accepted)patchTerminal({...row,state:'answered'},'The tool permission could not be delivered. Nothing was confirmed.');});
  observe({type:'delivery',requestKey:row.request_key,answerId,state:accepted?'accepted':'failed'});
  if(e)e.terminal=true;return result;
 }finally{finish();if(answerFlights.get(row.id)===flight)answerFlights.delete(row.id);}
}
export function isAllowedAnswer(answer:unknown):boolean {return answer==='Allowed'||answer==='allow';}

function synchronousAck(send:()=>import('../contracts.ts').RequestDelivery):import('../contracts.ts').RequestDelivery {
 try{const ack=send();if(ack&&typeof (ack as any).then==='function'){void Promise.resolve(ack).catch(()=>{});return {state:'failed'};}
 return ack?.state==='accepted'||ack?.state==='already'||ack?.state==='not-run'||ack?.state==='unconfirmed'?ack:{state:'failed'};}catch{return {state:'failed'};}
}

// S4 installs the authenticated source reader and recovery binder; neither
// this bridge nor a producer can manufacture an ExecutionClaim.
export function installProducerBindings(bindings: T.ProducerBindings): () => void { return bindProducers(bindings); }
export function producerAuthorityFor(threadId: string, botId: string): T.ProducerAuthority | undefined {
 const a=producerBindings()?.authorityFor(threadId,botId),c=a&&claims.get(a.claim);
 return c?.threadId===threadId&&c.botId===botId&&authority(threadId,botId,c.generation).actor!=='unproven'?a:undefined;
}
/** Policy observation keeps a rejected binding distinct from an absent turn.
 * Never return the rejected capability to an execution caller. */
export function producerNoLimitsPolicyFor(threadId: string, botId: string): boolean | undefined {
 try {
  const bound=producerBindings()?.authorityFor(threadId,botId);
  if(bound){
   const claim=claims.get(bound.claim);
   return !!claim&&claim.threadId===threadId&&claim.botId===botId&&ownerEligible(authority(threadId,botId,claim.generation));
  }
  const generation=reader?.turnGenerationFor(threadId);
  // Only a genuinely absent turn permits durable admission's saved fallback.
  if(generation===undefined)return reader?.live(threadId)===undefined?undefined:false;
  return ownerEligible(authority(threadId,botId,generation));
 }catch{return false;}
}
export function registerProducerQueue(source: T.ProducerQueuePort): () => void {
 const bindings=producerBindings();if(!bindings)throw new Error('producer-bindings-missing');
 return bindings.registerQueue(source);
}
let producerFactory:T.ProducerQueueFactory|undefined;
export function installProducerQueueFactory(factory: T.ProducerQueueFactory): () => void {
 producerFactory=factory;return()=>{if(producerFactory===factory)producerFactory=undefined;};
}
export function producerQueue(kind: T.ServiceId): T.ProducerQueue {
 const queue=trackedProducerQueue(kind)??(producerFactory?producerFactory(kind):kind==='memory'?memoryApprovalQueue():serviceQueue(kind));
 if(queue.kind!==kind||!('open'in queue)||!('bindAcceptance'in queue))throw new Error('producer-queue-mismatch');
 trackProducerQueue(queue);return queue as T.ProducerQueue;
}
function executionView(e:Entry):Readonly<T.RequestExecutionView> {
 const row=e.row&&records.readRecord(database(),e.row.id);
 if(row)return receiptOf(row);
 const executed=e.executionResult?.kind==='executed';
 return freeze({...((e.registration.ownerAuthority?.decisions.length??0)>0?{ownerAuthority:e.registration.ownerAuthority,evidence:e.registration.deny}:{}),outcome:e.outcome?.kind??'refuse',delivery:e.receiptDelivery??(executed?'accepted':e.executionStarted?(e.terminal?'failed':'pending'):'none'),...(e.receiptAnswer?{answer:e.receiptAnswer}:executed?{answer:{behavior:'allow' as const}}:{})});
}
function receiptOf(row:records.RecordRow):Readonly<T.RequestExecutionView> {
 return freeze({outcome:row.why==='question'?'question':'card',delivery:row.delivery as T.DeliveryState,...(row.answer?{answer:JSON.parse(row.answer)}:{})});
}
export function readRequestExecution(handle: T.RequestHandle): Readonly<T.RequestExecutionView> { return executionView(entry(handle)); }
export function readApprovalExecution(ref: T.ApprovalRef): Readonly<T.RequestExecutionView> {if(!issuedRef(ref)&&refs.get(ref)?.id===ref.approvalId)return freeze({outcome:'card',delivery:'none'});return receiptOf(requireRow(ref));}
export function listContinuations(filter: { kind: 'background-job'; namespace: 'shared-peer'; after?: string; limit: number }): T.ContinuationPage {
 if(filter.kind!=='background-job'||filter.namespace!=='shared-peer'||!Number.isInteger(filter.limit)||filter.limit<1||filter.limit>500)throw new Error('invalid-continuation-page');
 const rows=records.listSharedPeerContinuations(database(),filter.after??'',filter.limit+1);
 const keys=rows.slice(0,filter.limit).map(key=>JSON.parse(key) as T.ContinuationKey);
 return freeze({keys,...(rows.length>filter.limit?{next:rows[filter.limit-1]}:{})});
}


/** Use the same retained engine record as the decision scan, including absence. */
function entryWipeIdentity(e:Entry,source:T.RequestSnapshot|T.ServiceCall|undefined=e.executionCall??e.registration.snapshot):ReleaseWipeIdentity {
 const retained=source&&wipeInputs.get(source);
 const raw=retained??source;
 return {threadId:e.threadId,botId:e.authority.botId,execEnv:raw&&'event'in raw?raw.event.execEnv:undefined};
}
/** Fresh exact owner inspection, including every hazard's resolution. */
function inspectRelease(operation:OwnerOperation,identity?:ReleaseWipeIdentity):ReleaseInspection {
 return inspectReleaseOperation(operation,exact=>{
  const fresh=inspectOwnerOperation(exact);
  return {decisions:fresh.decisions,taintEvidence:fresh.hazards};
 },identity);
}
function releaseContext(identity:import('./release-guard.ts').ReleaseIdentity):import('./release-guard.ts').ReleaseBinding|undefined {
 const e=entries.get(scopedKey(identity.threadId,identity.requestKey));
 if(!e||e.authority.generation!==identity.generation||e.cancelled||e.conflict)return;
 const a=authority(e.threadId,e.authority.botId,e.authority.generation);
 if(a.actor==='unproven'||a.generation!==e.authority.generation)return;
 if(!owner(e)&&!ownerEligible(a))return {posture:'legacy'};
 if(!owner(e)||!ownerEligible(a)||!e.exact||e.exact.kind==='incomplete')return;
 return {posture:'owner-no-limits',operationHash:e.exact.operationHash,...entryWipeIdentity(e,captures.get(scopedKey(e.threadId,e.registration.key))?.latest??e.registration.snapshot),inspect:operation=>inspectRelease(operation,entryWipeIdentity(e)),approved:ref=>{
  if(!issuedRef(ref))return;
  const row=records.readRecord(database(),ref.approvalId);
  if(!row||row.id!==e.row?.id||row.thread_id!==e.threadId||row.request_key!==e.registration.key||row.generation!==e.authority.generation||row.input_hash!==e.registration.inputHash||!['open','answered'].includes(row.state))return;
  if(row.state==='answered'&&(!row.answer||JSON.parse(row.answer).behavior!=='allow'))return;
  return JSON.parse(row.evidence).releaseEvidence;
 }};
}
function releaseSource(e:Entry,updatedInput:unknown):T.RequestSnapshot|T.ServiceCall {
 const r=e.registration;
 const retained=r.snapshot&&wipeInputs.get(r.snapshot);
 const snapshot=retained&&'event'in retained?retained:r.snapshot;
 return snapshot?{...snapshot,input:updatedInput,event:{...snapshot.event,toolCall:{name:snapshot.event.toolCall?.name??snapshot.tool,input:updatedInput}}}: {tool:r.action.tool,input:updatedInput};
}
function entryRelease(e:Entry,answer:T.ApprovalAnswer,approved?:T.ApprovalRef):ReleaseResult {
 // Current authenticated posture decides whether this is an owner release.
 // Neutral captures do not inspect Full access operations; they only permit a
 // later mode change to bind the original complete operation here.
 const a=authority(e.threadId,e.authority.botId,e.authority.generation);
 if(!ownerEligible(a)){
  if(!owner(e)||(a.actor==='owner'||a.actor==='owner-routine')&&a.level!=='unlimited')return {kind:'release'};
  return {kind:'refuse',reason:'unregistered-release'};
 }
 if(!owner(e)){e.authority=a;e.registration=freeze({...e.registration,actor:a.actor,level:a.level,registrationHash:hash({previous:e.registration.registrationHash,actor:a.actor,level:a.level})});}
 if(!e.exact){const original=e.registration.source.kind==='service'?e.executionCall:captures.get(scopedKey(e.threadId,e.registration.key))?.upgrade;if(original)e.exact=extractInspectedOperation(original);if(e.exact&&e.exact.kind!=='incomplete')e.originalOperationHash=e.exact.operationHash;}
 if(e.cancelled||e.conflict||!e.exact||e.exact.kind==='incomplete')return {kind:'refuse',reason:'operation-integrity'};
 const exact=answer.updatedInput===undefined?e.exact:extractInspectedOperation(releaseSource(e,answer.updatedInput));
 if(exact.kind==='incomplete')return {kind:'refuse',reason:'operation-integrity'};
 return releaseGuard({requestKey:e.registration.key,threadId:e.threadId,generation:e.authority.generation,exactOperation:exact.exactOperation,operationHash:exact.operationHash,approvedEvidence:approved??e.releaseApproval,releaseKind:e.registration.source.kind==='service'?'service':'native'});
}
function checkEntryRelease(e:Entry,answer:T.ApprovalAnswer,approved?:T.ApprovalRef):Exclude<T.Outcome,{kind:'run'}>|undefined {
 if(e.cancelled||hostDeclineBlocksRelease(e.authority.botId,e.registration.action.targets))return {kind:'refuse',message:REFUSAL};
 if(e.permissionReplyHold&&!ownerEligible(authority(e.threadId,e.authority.botId,e.authority.generation))&&answer.behavior==='allow'&&e.outcome?.kind==='card')return e.outcome;
 if(approved&&!issuedRef(approved)&&e.outcome?.kind==='card')return e.outcome;
 // The owner's current No limits posture has one final check: fresh visible
 // catastrophe evidence. Protected destinations, changed input, reader limits
 // and integrity uncertainty are not catastrophe evidence.
 const wipeOnly=ownerEligible(authority(e.threadId,e.authority.botId,e.authority.generation));
 let wipes:readonly T.Evidence[]=[],result:ReleaseResult;
 if(wipeOnly){
  const latest=captures.get(scopedKey(e.threadId,e.registration.key))?.latest??e.registration.snapshot;
  const source=answer.updatedInput!==undefined?releaseSource(e,answer.updatedInput):e.executionCall??latest;
  let action=e.registration.action;
  if(source)try{action=describeNoLimits(source,e.threadId,e.authority.botId,answer.updatedInput===undefined?(captures.get(scopedKey(e.threadId,e.registration.key))?.latestExact??e.exact):undefined);}catch{/* Unreadable alone runs. */}
  const row=e.row&&(records.readRecord(database(),e.row.id)??e.row);
  const heldDecision=row?.why==='wipe';
  wipes=wipeEvidence(action);
  if(!wipes.length){if(approved)e.releaseApproval=approved;return;}
  const wipeOperation=source?visibleOperation(source,answer.updatedInput===undefined?(captures.get(scopedKey(e.threadId,e.registration.key))?.latestExact??e.exact):undefined):e.exact;
  let releaseWipes:ReleaseInspection['wipes'],scanFailed=false;
  try{if(wipeOperation&&wipeOperation.kind!=='incomplete')releaseWipes=inspectReleaseWipes(wipeOperation.exactOperation,heldDecision,entryWipeIdentity(e,source));}catch{scanFailed=true;}
  const digest=hash({source,operationHash:wipeOperation&&wipeOperation.kind!=='incomplete'?wipeOperation.operationHash:undefined,action:action.deletes,wipes:releaseWipes});
  const heldRelease=row?JSON.parse(row.evidence).releaseEvidence:undefined;
  const heldWipes=heldRelease?.inspection?.wipes;
  const targetsCovered=releaseWipes!==undefined&&heldWipes!==undefined&&approvedEvidenceCovers({decisions:[],wipes:releaseWipes},{decisions:[],wipes:heldWipes});
  const completeWipes=releaseWipes?.every(wipe=>wipe.completeness==='complete');
  const originalWipe=row?.why==='wipe'&&!e.conflict&&targetsCovered&&wipeOperation&&wipeOperation.kind!=='incomplete'&&wipeOperation.operationHash===heldRelease?.operationHash;
  const scanUnread=scanFailed||releaseWipes===undefined||!releaseWipes.length||releaseWipes.some(wipe=>!wipe.fingerprint||!wipe.completeness||!wipe.exactOperation)||wipes.some(wipe=>wipe.class==='wipe-input-unread');
  if(!scanUnread&&approved&&issuedRef(approved)&&row?.id===approved.approvalId&&((completeWipes&&e.wipeReleaseHash===digest)||originalWipe)){
   e.wipeReleaseHash=digest;e.releaseApproval=approved;return;
  }
  if(!scanUnread&&e.releaseApproval&&issuedRef(e.releaseApproval)&&e.wipeReleaseHash===digest){
   if(completeWipes)return;
   // MAIN RULING 1115-WFP-EXACT-APPROVAL: the answered exact operation
   // crosses its native handoff once; later digest replay requires a new card.
   if(targetsCovered&&e.deliveryStarted&&e.receiptDelivery==='pending'&&row?.delivery==='pending'&&row.answer_id&&e.wipeUnknownReleaseUsed!==row.answer_id){e.wipeUnknownReleaseUsed=row.answer_id;return;}
  }
  e.wipeReleaseHash=digest;
  e.registration=freeze({...e.registration,action,registrationHash:hash({prior:e.registration.registrationHash,wipes,digest})});
  result={kind:'hold',inspection:{decisions:[],wipes:releaseWipes}};
 }else result=entryRelease(e,answer,approved);
 if(result.kind==='release'){if(approved)e.releaseApproval=approved;return;}
 // A changed input is a new operation; it needs its own fresh evidence and card.
 let inspection=result.kind==='hold'?result.inspection:undefined;
 if(result.kind==='refuse'&&result.reason==='unverified-approval'&&e.exact&&e.exact.kind!=='incomplete')try{inspection=inspectRelease(e.exact.exactOperation,entryWipeIdentity(e));}catch{}
 if(answer.updatedInput!==undefined){const exact=extractInspectedOperation(releaseSource(e,answer.updatedInput));if(exact.kind!=='incomplete'){if(!e.exact||e.exact.kind==='incomplete'||exact.operationHash!==e.exact.operationHash)e.releaseUpdatedInput=answer.updatedInput;e.exact=exact;if(!wipeOnly)try{inspection=inspectRelease(exact.exactOperation,entryWipeIdentity(e));}catch{}}}
 if(!inspection?.decisions.length&&!wipeOnly){
  e.outcome=freeze({kind:'refuse',message:REFUSAL});
  if(e.registration.snapshot&&!e.releaseRefused){e.releaseRefused=true;try{requiredHost().store.appendMessage(e.threadId,{role:'bot',kind:'text',text:REFUSAL});}catch{}void transport?.interrupt(targetOf(e.registration.snapshot)).catch(()=>{});}
  return e.outcome;
 }
 const current=e.row&&records.readRecord(database(),e.row.id);
 if(result.kind==='hold'&&current?.state==='open'&&e.outcome?.kind==='card'&&e.exact&&e.exact.kind!=='incomplete'){const held=JSON.parse(current.evidence).releaseEvidence;if(held?.operationHash===e.exact.operationHash&&canonical(held.inspection)===canonical(inspection))return e.outcome;}
 e.initialInspection=inspection;e.releaseApproval=undefined;e.terminal=false;e.delivery=undefined;
 const releaseAuthority=freeze({version:1 as const,decisions:(inspection?.decisions??[]).map(structuredOwnerDecision),exhausted:false});
 const evidence=wipeOnly?wipes:ownerNlProtectedEvidence(releaseAuthority);
 const why=wipeOnly?'wipe' as const:'deny' as const;
 e.registration=freeze({...e.registration,ownerAuthority:releaseAuthority,deny:evidence,registrationHash:hash({prior:e.registration.registrationHash,release:inspection})});
 // Renew the evidence version and immutable card message. An earlier allow
 // receipt is never coverage for new facts; the provider ask remains pending.
 const persisted=e.row&&records.readRecord(database(),e.row.id);
 if(persisted){
  const payload=JSON.parse(persisted.evidence);payload.items=evidence;payload.ownerAuthority=releaseAuthority;payload.releaseEvidence={operationHash:e.exact&&e.exact.kind!=='incomplete'?e.exact.operationHash:'',inspection};
  const message=records.decisionMessage(database(),requiredHost().store,persisted);
  const replaceMessage=!!message?.card;
  // Presented terminal cards are immutable. A new evidence version gets a
  // new message and issuer epoch; the old card remains terminal and old refs
  // can no longer authorize this version of the same pending operation.
  if(message?.card){records.updateRecord(database(),persisted.id,{state:'superseded',settled_at:Date.now()});requiredHost().store.patchMessagePoint(e.threadId,message.id,{card:{...message.card,answered:RELEASE_SUPERSEDED,dismissed:true}});}
  const messageId=replaceMessage?randomUUID():persisted.chat_message_id;
  // The public answer key belongs to this immutable presentation. Keep the
  // provider's pending request ID in requestRef/row.request_id and the Entry;
  // replaying an old HTTP body must never select this new evidence epoch.
  if(replaceMessage)payload.action.requestId=`release-${messageId}`;
  const actionHash=hash(actionProjection(payload.action));payload.action.actionHash=actionHash;
  referenceEpochs.set(persisted.id,{});
  records.updateRecord(database(),persisted.id,{state:'open',why,answer:null,answer_id:null,delivery:'none',settled_at:null,evidence:JSON.stringify(payload),action_hash:actionHash,registration_hash:e.registration.registrationHash,...(replaceMessage?{chat_message_id:messageId,presented_action:null}:{})});
  e.row=records.readRecord(database(),persisted.id);indexApprovalEntry(persisted.id,e);e.ref=refFor(persisted.id);e.outcome=freeze({kind:'card',ref:e.ref});
  if(replaceMessage)commitPresentation(e.row!,e.ref,requiredHost().view(e.registration));
 }else{
  unindexApprovalEntry(e);e.row=undefined;e.ref=undefined;e.outcome=freeze(approval(e,why,evidence));
  if(e.outcome.kind==='card'&&e.registration.source.kind==='engine')commitPresentation(e.row!,e.outcome.ref,requiredHost().view(e.registration));
 }
 return e.outcome?.kind==='run'?{kind:'refuse',message:REFUSAL}:e.outcome;
}


/** Called at the actual provider writer, after any asynchronous policy work.
 * The request ID selects only a live captured Entry in this exact provider turn.
 * It supplies neither a posture nor an approval. Cache replay uses the successful
 * hook's issued operation, and must also cover the native request it would grant. */
function guardEngineRelease(identity:NativeReleaseIdentity,updatedInput?:T.ApprovalAnswer['updatedInput'],replay?:T.ServiceCall):boolean {
 if(!host)return false;
 const e=[...entries.values()].find(e=>e.threadId===identity.threadId&&e.requestId===identity.requestId&&e.registration.snapshot?.turnId===identity.turnId&&e.registration.snapshot.providerInstanceId===identity.providerInstanceId);
 const current=authority(identity.threadId);
 const tool=e?.registration.action.tool??replay?.tool;
 const off=tool&&host.featureOff?.(identity.threadId,current.botId,tool);
 if(off){
  if(e)explainFeatureOff(e,{kind:'refuse',message:off});
  else {const key=canonical(identity);if(!nativeOffNotices.has(key)){nativeOffNotices.add(key);host.store.appendMessage(identity.threadId,{role:'bot',kind:'text',text:off});if(nativeOffNotices.size>1024)nativeOffNotices.delete(nativeOffNotices.values().next().value!);}}
  return false;
 }
 // Stop fences native delivery and cache replay at every permission level.
 if(e?.cancelled)return false;
 const targets=e?.registration.action.targets??(tool&&/host.computer/i.test(tool)?[{kind:'host-computer' as const,scope:'local-computer' as const}]:[]);
 if(hostDeclineBlocksRelease(current.botId,targets))return false;
 const ownerNoLimits=ownerEligible(current);
 if(ownerNoLimits){
  const source=replay??(updatedInput!==undefined?(e?releaseSource(e,updatedInput):{tool:'Bash',input:updatedInput}):undefined);
  if(source){
   let wipes:readonly T.Evidence[]=[];try{wipes=wipeEvidence(describeNoLimits(source,identity.threadId,e?.authority.botId??authority(identity.threadId).botId));}catch{/* Uncertainty alone runs. */}
   // A previously held wipe still binds its class after retargeting removes
   // the fresh catastrophe. The authoritative entry checks that fingerprint.
   if(!wipes.length&&!e)return true;
   if(!e)return false;
   return !checkEntryRelease(e,{behavior:'allow',updatedInput:source.input as T.ApprovalAnswer['updatedInput']});
  }
  if(!e)return true;
  return !checkEntryRelease(e,{behavior:'allow'});
 }
 if(updatedInput!==undefined&&(!updatedInput||typeof updatedInput!=='object'||Array.isArray(updatedInput)))return false;
 if(!e)return false;
 if(replay){
  if(!e.successfulRelease||!e.exact||e.exact.kind==='incomplete')return false;
  const input=replay.input&&typeof replay.input==='object'?replay.input as Record<string,unknown>:{};
  const projected=extractInspectedOperation(replay,{...(typeof input.cwd==='string'||typeof input.workdir==='string'?{}:{cwd:e.exact.exactOperation.cwd}),cwdInvalid:e.exact.exactOperation.cwdInvalid});
  if(projected.kind==='incomplete')return false;
  const signature=(operation:OwnerOperation):unknown=>{
   if(operation.kind!=='native')return operation;
   return {kind:'native',cwd:operation.cwd,cwdInvalid:operation.cwdInvalid,effects:operation.effects.map(({op,path,source})=>({op:op==='edit'?'write':op,path,source})).sort((a,b)=>canonical(a).localeCompare(canonical(b)))};
  };
  if(canonical(signature(projected.exactOperation))!==canonical(signature(e.exact.exactOperation)))return false;
 }
 return !checkEntryRelease(e,{behavior:'allow',...(updatedInput?{updatedInput}:{})});
}


function reopenQueueDelivery(q:T.QueueRecoverySource,item:T.PendingQueueApproval,row:records.RecordRow):Entry|undefined {
 const source=q.reopen(item);
 if(!source||source.service!==q.kind||!claims.has(source.claim)||hash(checkedCall(source.call))!==row.input_hash||!queueCallMatches(undefined,item,row.input_hash))return;
 const handle=openRequest(source),e=entry(handle);
 if(e.threadId!==row.thread_id||e.authority.botId!==row.bot_id||e.registration.key!==row.request_key)return;
 e.row=row;indexApprovalEntry(row.id,e);e.ref=refFor(row.id);e.attached=freeze({kind:item.kind,ref:item.ref,call:item.call});
 return e;
}


function queueCallMatches(e:Entry|undefined,item:T.PendingQueueApproval,inputHash:string):boolean {
 try{return hash(checkedCall(item.call))===inputHash&&(!e||!owner(e)||!!e.executionCall&&exactInputHash(item.call)===exactInputHash(e.executionCall));}catch{return false;}
}

/** Oversize changed permission input has no file-reference protocol in Claude.
 * Keep the exact native ask pending and present a one-shot, deny-only card. */
function holdPermissionReply(identity:NativeReleaseIdentity,line:string):boolean|'deny' {
 if(!host)return false;
 const e=[...entries.values()].find(e=>e.threadId===identity.threadId&&e.requestId===identity.requestId&&e.registration.snapshot?.turnId===identity.turnId&&e.registration.snapshot.providerInstanceId===identity.providerInstanceId&&!e.cancelled&&!e.terminal);
 if(!e)return false;
 if(ownerEligible(authority(e.threadId,e.authority.botId,e.authority.generation))){e.replyTooLargeShown=true;return 'deny';}
 if(e.permissionReplyHold)return true;
 e.permissionReplyHold=line;e.terminal=false;
 // Replace an existing presentation; no answer reached the engine.
 const persisted=e.row&&records.readRecord(database(),e.row.id);
 if(persisted){
  const message=records.decisionMessage(database(),requiredHost().store,persisted);
  const chatMessageId=message?.card?randomUUID():persisted.chat_message_id;
  if(message?.card)records.updateRecord(database(),persisted.id,{state:'superseded',settled_at:Date.now()});
  if(message?.card)requiredHost().store.patchMessagePoint(e.threadId,message.id,{card:{...message.card,answered:'Permission reply is too large',dismissed:true}});
  referenceEpochs.set(persisted.id,{});e.ref=refFor(persisted.id);
  records.updateRecord(database(),persisted.id,{state:'open',answer:null,answer_id:null,delivery:'none',settled_at:null,chat_message_id:chatMessageId,presented_action:null});e.row=records.readRecord(database(),persisted.id);
 }
 e.outcome=freeze(approval(e,'base',[]));
 if(e.outcome.kind!=='card')return false;
 const row=e.row!,payload=JSON.parse(row.evidence);
 payload.action.options=['Deny'];
 const actionHash=hash(actionProjection(payload.action));payload.action.actionHash=actionHash;
 e.row={...row,evidence:JSON.stringify(payload),action_hash:actionHash};
 if(persisted)records.updateRecord(database(),row.id,{evidence:e.row.evidence,action_hash:actionHash,presented_action:null});
 commitPresentation(e.row,e.outcome.ref,{title:'Approval needed',subtitle:line});
 return true;
}
