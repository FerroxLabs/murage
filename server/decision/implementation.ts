import {explicitNoLimits} from '../permission-inheritance.ts';
import {noteTurnScriptWrites} from '../no-limits-wipe-scripts.ts';
import { CHANNEL_MESSAGES_OFF, noLimitsAppliesTo, type NoLimitsOrigin } from '../no-limits-origin.ts';
import { appendDecision } from '../decision-log.ts';
import { DATA_DIR } from '../config.ts';
import { afterCommit } from '../tx-scope.ts';
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type * as T from './types.ts';
import { boundedProjection,freeze,hash,canonical,captureDelivery } from './bounds.ts';
import { extractInspectedOperation, exactInputHash, type ExtractedOperation } from '../no-limits-operation.ts';
import { inspectOwnerOperation, type OwnerOperation } from '../no-limits-inspection.ts';
import { RELEASE_SUPERSEDED, releaseGuard, installReleaseContextReader, type ReleaseInspection, type ReleaseResult } from './release-guard.ts';
import { installNativeReleaseReader, type NativeReleaseIdentity } from './provider-release.ts';
import { structuredOwnerDecision } from './action.ts';
import { ownerNlProtectedEvidence } from '../no-limits-authority.ts';
import { describe,describeOwnerNoLimits,protectedEvidence,wipeEvidence } from './action.ts';
import * as records from './records.ts';
import { database,transaction } from '../database.ts';
import { actionProjection, QUEUE_REF_PATHS, CARD_DISPLAY_FIELDS, CARD_TERMINAL_FIELDS } from '../../shared/permission-card.ts';
import { ownerRoutineLevel } from '../../shared/owner-routine-level.ts';
import { withDeadline } from './settle.ts';
import { bindProducers, producerBindings, trackedProducerQueue, trackProducerQueue } from './producer-bindings.ts';
import { serviceQueue } from '../narrow-denials.ts';
import { memoryApprovalQueue } from '../memory/authority.ts';
const REFUSAL='Murage could not confirm this request. Nothing was run.';
const reportedRefusalCauses=new Set<string>();
const engineRefusalCodes=new Set(['engine-approval-builder-missing','invalid-engine-options','request-id-mismatch','queue-identity-missing','reserved-action-field']);
function reportDecisionRefusal(cause:string,kind='engine-approval'):void {
 const key=`${kind}:${cause}`;if(reportedRefusalCauses.has(key))return;
 reportedRefusalCauses.add(key);
 console.error(`[decision] ${kind}-refused cause=${cause}`);
}
let engineBuilder:T.EngineApprovalBuilder|undefined;
let engineBuilderInstalledLogged=false;
let reader:T.ProvenanceReader|undefined,denials:T.DenySources|undefined,host:T.DecisionHost|undefined,transport:T.DecisionTransport|undefined;
const claims=new WeakMap<T.ExecutionClaim,{threadId:string;botId:string;generation:string}>();
const handles=new WeakMap<T.RequestHandle,Entry>(),refs=new WeakMap<T.ApprovalRef,{id:string;epoch:object}>();
const referenceEpochs=new Map<string,object>();
const nativeOffNotices=new Set<string>();
const entries=new Map<string,Entry>(),captures=new Map<string,{snapshot:T.RequestSnapshot;latest:T.RequestSnapshot;conflict:boolean;exact?:ExtractedOperation;upgrade?:T.RequestSnapshot}>();
const synchronousQueues=new Map<T.ServiceId,{source:T.QueueRecoverySource;delivery:T.SynchronousQueueDelivery}>();
const answerFlights=new Map<string,Promise<void>>();
const queues=new Map<T.ServiceId,T.QueueRecoverySource>(),observers=new Set<T.DecisionObserver>();
// No limits queues dispatch under the old machine-protection limits. Waiting
// for capacity is never an authorization refusal and has no permission timer.
let noLimitsInFlight=0;
const noLimitsThreads=new Map<string,number>();
const noLimitsWaiters:Array<{threadId:string;start:()=>void}>=[];
function noLimitsSlot<V>(e:Entry,work:()=>Promise<V>):Promise<V>{
 return new Promise<V>((resolve,reject)=>{
  const start=()=>{noLimitsInFlight++;noLimitsThreads.set(e.threadId,(noLimitsThreads.get(e.threadId)??0)+1);
   Promise.resolve().then(work).then(resolve,reject).finally(()=>{
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
 for(const [key,value]of entries)if(value.terminal){entries.delete(key);captures.delete(key);if(entries.size<=512)break;}
}

interface Authority {explicitNoLimits?:boolean;noLimitsOrigin?:NoLimitsOrigin;fullAccessChannelMessages?:boolean;actor:T.Registration['actor'];level:T.Registration['level'];botId:string;generation:string;provenance?:T.TurnProvenance}
interface Entry {featureOffNoted?:boolean;wipeReleaseHash?:string;originalOperationHash?:string;releaseRefused?:boolean;successfulRelease?:boolean;releaseUpdatedInput?:T.ApprovalAnswer['updatedInput'];exact?:ExtractedOperation;initialInspection?:ReleaseInspection;releaseApproval?:T.ApprovalRef;handle:T.RequestHandle;registration:T.Registration;authority:Authority;threadId:string;requestId:string;created:number;conflict:boolean;fault?:'reader'|'deny'|'identity'|'overflow';outcome?:T.Outcome;base?:T.BaseVerdictFn;baseValue?:Readonly<ReturnType<T.BaseVerdictFn>>;ref?:T.ApprovalRef;row?:records.RecordRow;attached?:T.QueueAttachment;delivery?:Promise<void>;deliveryStarted?:boolean;execution?:Promise<any>;executionResult?:T.ServiceExecution<any>;executionStarted?:boolean;cancelled?:boolean;executionCall?:T.ServiceCall;terminal?:boolean;receiptDelivery?:T.DeliveryState;receiptAnswer?:T.ApprovalAnswer}
function observe(e:T.DecisionObservation){for(const fn of observers)try{fn(freeze(e));}catch{}}
function safely<V>(read:()=>V,fallback:V):V {try{return read();}catch{return fallback;}}
function requiredHost(){if(!host)throw new Error('decision-host-missing');return host;}
function authority(threadId:string,botId?:string,generation?:string):Authority {
 const g=safely(()=>reader?.turnGenerationFor(threadId),undefined),live=safely(()=>reader?.live(threadId),undefined),p=g?safely(()=>reader?.provenance(g),undefined):undefined;
 const recovered=!live||!p||p.initiator.k==='other-human'?safely(()=>reader?.ownerThread?.(threadId),undefined):undefined;
 const a:Authority={actor:'unproven',level:live?.level??'ask',botId:live?.botId??botId??'',generation:g??generation??'',provenance:p?freeze(boundedProjection(p)):undefined};
 if(recovered&&(!botId||botId===recovered.botId)&&(!generation||generation===g)){
  const candidate={...a,actor:'owner' as const,level:recovered.level,botId:recovered.botId,noLimitsOrigin:recovered.origin,fullAccessChannelMessages:recovered.fullAccessChannelMessages};
  if(ownerEligible(candidate))return candidate;
 }
 if(!live||!p||g!==p.generation||p.threadId!==threadId||p.botId!==live.botId||p.principal!==live.principal||(generation&&generation!==g)||(botId&&botId!==live.botId))return a;
 const k=p.initiator.k;
 a.fullAccessChannelMessages=live.fullAccessChannelMessages;
 a.noLimitsOrigin=k==='webhook'?'webhook':k==='peer'||k==='delegation'?'unattended':!live.owner||!p.roomOwnerOnly?'other-human':k==='owner-channel-dm'?'owner-channel':'unattended';
 a.explicitNoLimits=explicitNoLimits(host?.store.bot(live.botId)??{});
 if(a.noLimitsOrigin==='other-human'&&!a.explicitNoLimits)a.level='ask';
 if(k.startsWith('routine-')||k==='project-room-routine'){
  const i=p.initiator as Extract<T.Initiator,{form:string}>,r=live.routine;
  if(!r||r.sourceRunId!==i.sourceRunId||r.sourceBotId!==i.sourceBotId||r.recipientGeneration!==g||i.recipientGeneration!==g||!r.owner){a.noLimitsOrigin='unproven';return a;}
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
export function installProvenanceReader(r:T.ProvenanceReader){reader=r;}
export function installDenySources(s:T.DenySources){denials=s;}
export function installDecisionTransport(t:T.DecisionTransport){transport=t;}
export function installDecisionHost(h:T.DecisionHost):()=>void {host=h;engineBuilder=undefined;entries.clear();captures.clear();referenceEpochs.clear();nativeOffNotices.clear();installReleaseContextReader(releaseContext);installNativeReleaseReader(guardEngineRelease,identity=>!!host&&[...entries.values()].some(e=>e.threadId===identity.threadId&&e.requestId===identity.requestId&&e.registration.snapshot?.turnId===identity.turnId&&e.registration.snapshot.providerInstanceId===identity.providerInstanceId&&e.outcome?.kind==='card'&&e.row?.state==='open'));return()=>{if(host===h)host=undefined;};}
export function installClaimVerifier(verifier:T.ClaimVerifier):(proof:unknown)=>T.ExecutionClaim|undefined{return proof=>{const v=verifier(proof);if(!v)return;const claim=Object.freeze({}) as T.ExecutionClaim;claims.set(claim,freeze({...v}));return claim;};}
export function installQueueSources(sources:readonly T.QueueRecoverySource[]):()=>void{const own=new Map<T.ServiceId,T.QueueRecoverySource>();for(const s of sources){if(queues.has(s.kind)||own.has(s.kind))throw new Error('duplicate-queue-source');own.set(s.kind,s);}for(const [k,s] of own)queues.set(k,s);return()=>{for(const [k,s] of own)if(queues.get(k)===s)queues.delete(k);};}
export function installEngineApprovalBuilder(builder:T.EngineApprovalBuilder):()=>void{if(typeof builder!=='function')throw new Error('engine-approval-builder-missing');engineBuilder=builder;if(!engineBuilderInstalledLogged){engineBuilderInstalledLogged=true;console.info('[decision] engine approval builder installed');}return()=>{if(engineBuilder===builder)engineBuilder=undefined;};}
export function installDecisionObserver(observer:T.DecisionObserver):()=>void{observers.add(observer);return()=>{observers.delete(observer);};}
export function installRequestIngress(bus:T.RequestIngress):()=>void{return bus.subscribe(event=>{
 if(event.type==='request.opened')capture(event);
 else if(event.type==='request.resolved'||event.type==='turn.completed'){
  const matching=[...entries.values()].filter(e=>!!e.registration.snapshot&&e.threadId===event.threadId&&e.registration.snapshot?.providerInstanceId===event.providerInstanceId&&e.registration.snapshot?.turnId===event.turnId&&(event.type!=='request.resolved'||e.requestId===event.requestId));
  const generations=new Set(matching.map(e=>e.authority.generation));
  // Never substitute the live generation for the one carried by a captured
  // native identity. An ambiguous reused native identity cannot retire a new turn.
  if(generations.size===1){const generation=matching[0].authority.generation;
   if(event.type==='turn.completed')void cancelRequests({kind:'generation',threadId:event.threadId,generation},'cancelled').catch(()=>{});
   else for(const e of matching){if(event.behavior==='allow'&&owner(e)){e.successfulRelease=true;}else void cancelEntry(e,event.settlement??'cancelled').catch(()=>{});}
  }
 }
});}
function capture(event:T.RequestOpenedEvent):void {
 const generation=safely(()=>reader?.turnGenerationFor(event.threadId),undefined)??'';
 const a=authority(event.threadId);
 const exact=ownerEligible(a)?extractInspectedOperation({tool:event.toolCall?.name??event.tool??'',input:event.toolCall?.input,event} as T.RequestSnapshot):undefined;
 const projected=boundedProjection(event) as T.RequestOpenedEvent;
 const input=projected.toolCall?.input??{};
 const snapshot=freeze({threadId:event.threadId,requestId:event.requestId??'',turnId:event.turnId??'',providerInstanceId:event.providerInstanceId??'',generation,tool:projected.toolCall?.name??projected.tool,input,inputHash:hash({tool:projected.toolCall?.name??projected.tool,input,choices:projected.choices,questions:projected.questions,folderTrust:projected.folderTrust,approvalScope:projected.approvalScope,filePaths:projected.filePaths}),event:projected});
 // Retain a complete neutral delivery copy for a later authenticated mode
 // change. Full access still invokes no owner extractor or filesystem reader.
 let upgrade:T.RequestSnapshot|undefined;
 if(!exact&&(a.actor==='owner'||a.actor==='owner-routine'))try{const original=captureDelivery(projected,event) as T.RequestOpenedEvent;upgrade=freeze({...snapshot,input:original.toolCall?.input??{},event:original});}catch{}
 const key=captureKey(snapshot),scope=scopedKey(snapshot.threadId,key),old=captures.get(scope);
 if(old){if(old.snapshot.inputHash!==snapshot.inputHash||canonical(old.exact)!==canonical(exact)){old.conflict=true;old.latest=snapshot;const e=entries.get(scope);if(e)e.conflict=true;}return;}
 if(captures.size>=1536){for(const [k]of captures){if(!entries.has(k)||entries.get(k)?.terminal){captures.delete(k);if(captures.size<1536)break;}}}
 if(captures.size<1536||ownerEligible(a))captures.set(scope,{snapshot,latest:snapshot,conflict:false,exact,upgrade});
}
export function describeAction(input:T.RequestSnapshot|T.ServiceCall):T.ActionEvidence{return describe(input);}
function checkedCall(call:T.ServiceCall):T.ServiceCall {
 const spec=call.approval;
 if(spec){if(!spec.queueRef||!spec.epoch)throw new Error('queue-identity-missing');for(const k of ['approvalId','requestRef','actionHash',...CARD_DISPLAY_FIELDS,...CARD_TERMINAL_FIELDS])if(Object.hasOwn(spec.action,k))throw new Error('reserved-action-field');if(spec.action.requestId!==undefined&&spec.action.requestId!==spec.queueRef)throw new Error('request-id-mismatch');}
 return boundedProjection(call);
}
function queueValue(action:any,kind:T.ServiceId):unknown{return QUEUE_REF_PATHS[kind].slice('$.card.'.length).split('.').reduce((x,k)=>x?.[k],action);}
function describeNoLimits(input:T.RequestSnapshot|T.ServiceCall,threadId:string,botId:string):T.ActionEvidence {
 return describeOwnerNoLimits(input,safely(()=>host?.executionContext?.(threadId,botId),undefined));
}
export function openRequest(source:T.RequestSource):T.RequestHandle {
 let snapshot:T.RequestSnapshot|undefined,threadId='',botId='',generation='',key='',conflict=false,src:T.RequestSource;
 if(source.kind==='engine'){
  threadId=source.threadId;generation=safely(()=>reader?.turnGenerationFor(threadId),undefined)??'';
  const live=safely(()=>reader?.live(threadId),undefined);botId=live?.botId??'';key=`${live?.providerInstanceId??''}:${generation}:${source.requestId}`;
  const captured=captures.get(scopedKey(threadId,key))??(!live&&ownerEligible(authority(threadId))?[...captures.values()].find(item=>item.snapshot.threadId===threadId&&item.snapshot.generation===generation&&item.snapshot.requestId===source.requestId):undefined);
  snapshot=captured?.snapshot;if(snapshot)key=captureKey(snapshot);conflict=!!captured?.conflict;
  src=freeze({kind:'engine',threadId,requestId:source.requestId});
 }else{
  const c=claims.get(source.claim);if(!c)throw new Error('unverified-execution-claim');
  ({threadId,botId,generation}=c);
  const call=checkedCall(source.call);if(call.approval&&queueValue(call.approval.action,source.service)!==call.approval.queueRef)throw new Error('queue-reference-mismatch');
  src=freeze({kind:'service',service:source.service,claim:source.claim,call});key=`${source.service}:${call.approval?.queueRef??hash(call)}:${call.approval?.epoch??generation}`;
 }
 const executionCall=source.kind==='service'?captureDelivery((src as Extract<T.RequestSource,{kind:'service'}>).call,source.call):undefined;
 const scope=scopedKey(threadId,key);const existing=entries.get(scope);if(existing){if(source.kind==='service'&&existing.registration.inputHash!==hash((src as Extract<T.RequestSource,{kind:'service'}>).call))throw new Error('request-input-conflict');return existing.handle;}
 const a=authority(threadId,botId,generation);let fault:Entry['fault'];
 if(!a.botId||!safely(()=>reader?.live(threadId),undefined))fault='identity';
 if(source.kind==='engine'){
  const live=safely(()=>reader?.live(threadId),undefined);if(!ownerEligible(a)&&(!snapshot||snapshot.threadId!==threadId||snapshot.requestId!==source.requestId||snapshot.turnId!==live?.turnId||snapshot.providerInstanceId!==live?.providerInstanceId||snapshot.generation!==generation)){a.actor='unproven';a.noLimitsOrigin='unproven';}
 }
 const ownerNl=ownerEligible(a);
 if(ownerNl&&fault==='identity')fault=undefined;
 let action:T.ActionEvidence=freeze({tool:snapshot?.tool??(src.kind==='service'?src.call.tool:''),codeIdentity:'',executables:[],deletes:[],targets:[],content:[]}),deny:readonly T.Evidence[]=[],denyRev:readonly string[]=[];
 try{if(snapshot||src.kind==='service')action=ownerNl?describeNoLimits(snapshot??(src as Extract<T.RequestSource,{kind:'service'}>).call,threadId,a.botId):describeAction(snapshot??(src as Extract<T.RequestSource,{kind:'service'}>).call);
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
 if(entries.size>1536)for(const [k,v]of entries)if(v.terminal){entries.delete(k);if(entries.size<=1536)break;}
 if(source.kind==='service')e.executionCall=executionCall;
 if(ownerNl){
  e.exact=source.kind==='engine'?captures.get(scope)?.exact:extractInspectedOperation(executionCall??(src as Extract<T.RequestSource,{kind:'service'}>).call);
  if(e.exact&&e.exact.kind!=='incomplete')try{e.originalOperationHash=e.exact.operationHash;e.initialInspection=inspectRelease(e.exact.exactOperation);
   if(e.initialInspection.decisions.length){const exactAuthority=freeze({version:1 as const,decisions:[...(e.registration.ownerAuthority?.decisions??[]),...e.initialInspection.decisions.map(structuredOwnerDecision)],exhausted:false});
    const extra=ownerNlProtectedEvidence(exactAuthority);e.registration=freeze({...e.registration,ownerAuthority:exactAuthority,deny:freeze([...e.registration.deny,...extra]),registrationHash:hash({previous:e.registration.registrationHash,release:e.initialInspection})});}}catch{e.fault='overflow';}
 }
 handles.set(handle,e);observe({type:'registered',requestKey:key,threadId,inputHash,actor:a.actor,level:a.level});return handle;
}
function entry(handle:T.RequestHandle):Entry {const e=handles.get(handle);if(!e)throw new Error('unregistered-request');return e;}
function refFor(id:string):T.ApprovalRef {let epoch=referenceEpochs.get(id);if(!epoch){epoch={};referenceEpochs.set(id,epoch);if(referenceEpochs.size>2048){const active=new Set([...entries.values()].filter(e=>!e.terminal).map(e=>e.row?.id));for(const key of referenceEpochs.keys()){if(!active.has(key))referenceEpochs.delete(key);if(referenceEpochs.size<=1536)break;}}}const ref=Object.freeze({approvalId:id}) as T.ApprovalRef;refs.set(ref,{id,epoch});return ref;}
function issuedRef(ref:T.ApprovalRef):boolean {const issued=refs.get(ref);return !!issued&&issued.id===ref.approvalId&&referenceEpochs.get(issued.id)===issued.epoch;}
function entryForRef(ref:T.ApprovalRef):Entry|undefined {if(!issuedRef(ref))throw new Error('unissued-approval-ref');return [...entries.values()].find(e=>e.row?.id===ref.approvalId);}
function requireRow(ref:T.ApprovalRef):records.RecordRow {entryForRef(ref);const r=records.readRecord(database(),ref.approvalId);if(!r)throw new Error('approval-record-missing');return r;}
function baseVerdict(e:Entry):ReturnType<T.BaseVerdictFn>{try{const verdict=freeze(boundedProjection(e.base!(e.registration))) as ReturnType<T.BaseVerdictFn>;if(!verdict||(verdict.approve!==null&&typeof verdict.approve!=='string')||typeof verdict.source!=='string')throw new Error('invalid-base-verdict');e.baseValue=verdict;return verdict;}catch{const verdict=freeze({approve:null,source:'always-ask' as const,rule:'unreadable'});e.baseValue=verdict;return verdict;}}
function ownerEligible(value: {actor:T.Registration['actor'];level:T.Registration['level'];noLimitsOrigin?:NoLimitsOrigin;fullAccessChannelMessages?:boolean;explicitNoLimits?:boolean}):boolean{return noLimitsAppliesTo(value.noLimitsOrigin ?? (value.actor === 'unproven' ? 'unproven' : value.actor), {autoApprove:value.level==='unlimited',fullAccess:value.level==='unlimited',noLimits:value.level==='unlimited',permissionExplicit:['other-human','guest','other'].includes(value.noLimitsOrigin??value.actor)?value.explicitNoLimits===true:true,fullAccessChannelMessages:value.fullAccessChannelMessages});}
function owner(e:Entry):boolean{return ownerEligible(e.authority);}
function featureOffMessage(e:Entry):string|undefined {
 if(e.authority.fullAccessChannelMessages===false&&(e.authority.noLimitsOrigin==='owner-channel'||e.authority.noLimitsOrigin==='other-human'&&e.authority.explicitNoLimits===true))return CHANNEL_MESSAGES_OFF;
 return host?.featureOff?.(e.threadId,e.authority.botId,e.registration.action.tool);
}
export function decide(handle:T.RequestHandle,base:T.BaseVerdictFn):T.Outcome {
 const e=entry(handle);e.base=base;
 if(e.terminal&&e.outcome)return e.outcome;
 if(e.outcome?.kind==='refuse')return e.outcome;
 if(e.conflict){
   const latest=captures.get(scopedKey(e.threadId,e.registration.key))?.latest;
   if(latest){
    let action=e.registration.action;try{action=owner(e)?describeNoLimits(latest,e.threadId,e.authority.botId):describeAction(latest);}catch{if(!e.fault)e.fault='reader';}
    e.registration=freeze({...e.registration,snapshot:latest,inputHash:latest.inputHash,action,registrationHash:hash({prior:e.registration.registrationHash,inputHash:latest.inputHash})});
   }
 }
 const r=e.registration;
 let outcome:T.Outcome;
 const off=isQuestion(r)?undefined:featureOffMessage(e);
 if(off)outcome={kind:'refuse',message:off};
 else if(e.fault==='identity'&&!owner(e))outcome={kind:'refuse',message:REFUSAL};
 else if(owner(e)){
  // Sean ruling 2026-11-12 02:05Z: refusal rules, protected targets,
  // reader failure/bounds and stored denies do not card at No limits.
  // Eligible No limits requests check fresh wipes before other permission outcomes.
  // Actual disabled capabilities are handled separately above.
  const wipes=wipeEvidence(r.action);
  if(wipes.length)outcome=approval(e,'wipe',wipes);
  else if(isQuestion(r))outcome=approval(e,'question',[]);
  else outcome={kind:'run'};
 }else if(r.actor==='unproven'&&r.level==='unlimited'){
  // Excluded origins retain their existing deny and catastrophe evidence.
  if(r.deny.length)outcome=approval(e,'deny',r.deny);
  else if(wipeEvidence(r.action).length)outcome=approval(e,'wipe',wipeEvidence(r.action));
  else outcome=baseVerdict(e).approve!==null?{kind:'run'}:approval(e,'base',[]);
 }else { // BASE is actor-first, including all non-owner No-limits faults.
  const b=baseVerdict(e);outcome=(e.fault==='reader'||e.fault==='deny')?approval(e,'base',[]):b.approve!==null?{kind:'run'}:approval(e,'base',[]);
 }
 if(owner(e)&&outcome.kind==='run'&&r.snapshot){const snapshot=r.snapshot;
  noteTurnScriptWrites(e.threadId,snapshot.providerInstanceId,snapshot.turnId,(r.action.ownerTargets??r.action.targets).flatMap(target=>target.kind==='path'&&target.op==='write'?[target.path]:[]));
 }
 e.outcome=freeze(outcome);observe({type:'decided',requestKey:r.key,kind:outcome.kind,...('ref'in outcome?{approvalId:outcome.ref.approvalId}:{})});return outcome;
}
function isQuestion(r:T.Registration){return r.source.kind==='service'&&r.source.call.tool==='ask_user'||!!(r.snapshot?.event.requestType==='question'||r.snapshot?.event.questionTool)&&!r.snapshot?.event.folderTrust;}
function approval(e:Entry,why:T.ApprovalRecordView['why'],items:readonly T.Evidence[]):T.Outcome {
 const r=e.registration;const held=records.findRecord(database(),r.source.kind,e.threadId,r.key);
 if(held){e.row=held;e.ref??=refFor(held.id);if(held.state!=='open')e.terminal=true;return {kind:held.why==='question'?'question':'card',ref:e.ref};}
 if(e.row&&e.row.registration_hash===r.registrationHash&&e.row.why===why)return {kind:why==='question'?'question':'card',ref:e.ref!};
 const priorRow=e.row;
 {
 const id=priorRow?.id??randomUUID(),message=priorRow?.chat_message_id??randomUUID(),event=r.snapshot?.event;
 let action:Record<string,unknown>;
 if(r.source.kind==='service'){
  action=r.source.call.approval?{...r.source.call.approval.action}:{requestId:e.requestId,tool:r.action.tool,options:['Allow','Deny']};
 }else action={requestId:e.requestId,tool:event?.tool??r.action.tool,options:event?.choices??event?.questions?.[0]?.options.map(o=>o.label)??(isQuestion(r)?[]:['Allow','Deny']),...(isQuestion(r)?{question:event?.questions?.[0]?.question??event?.summary??r.action.tool}:{}),...(event?.questions?{questions:event.questions}:{}),...(event?.folderTrust?{folderTrust:event.folderTrust}:{}),...(event?.approvalScope?{approvalScope:event.approvalScope}:{})};
 if(r.source.kind==='engine'&&why!=='question'){
  try{
   // R3 held origins need a plain one-shot card even when the optional
   // legacy grant builder is unavailable. Other BASE behavior stays intact.
   const heldOrigin=e.authority.noLimitsOrigin==='webhook'||e.authority.noLimitsOrigin==='other-human'||e.authority.noLimitsOrigin==='owner-channel'&&e.authority.fullAccessChannelMessages===false;
   if(why==='base'&&!engineBuilder&&!heldOrigin)throw new Error('engine-approval-builder-missing');
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
 action={...action,approvalId:id,requestRef:e.requestId};const actionHash=hash(actionProjection(action));action.actionHash=actionHash;
 e.row={id,source_kind:r.source.kind,service:r.source.kind==='service'?r.source.service:null,thread_id:e.threadId,request_key:r.key,request_id:e.requestId,bot_id:e.authority.botId,generation:e.authority.generation,actor_kind:r.actor,actor_via:e.authority.provenance?.initiator.k??'unproven',level:r.level,why,evidence:JSON.stringify({items,action,...(r.ownerAuthority?{ownerAuthority:r.ownerAuthority}:{}),...(e.exact&&e.exact.kind!=='incomplete'&&e.initialInspection?{releaseEvidence:{operationHash:e.exact.operationHash,inspection:e.initialInspection}}:{}),initiator:e.authority.provenance?.initiator??{k:'other-human'},target:r.snapshot?targetOf(r.snapshot):undefined,epoch:r.source.kind==='service'?r.source.call.approval?.epoch:undefined}),registration_hash:r.registrationHash,deny_rev:JSON.stringify(r.denyRev),input_hash:r.inputHash,action_hash:actionHash,presented_action:null,chat_message_id:message,queue_kind:priorRow?.queue_kind??null,queue_ref:priorRow?.queue_ref??null,state:'open',answer:null,answer_id:null,delivery:'none',created_at:Date.now(),settled_at:null};
 e.ref??=refFor(id);
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
 try {commitPresentation(row,ref,view,count);}catch(error){if(e&&row.source_kind==='engine'){e.outcome={kind:'refuse',message:REFUSAL};await deliverRequest(e.handle);}throw error;}
}
function commitPresentation(row:records.RecordRow,ref:T.ApprovalRef,view:T.ApprovalView,count:number){
 const h=requiredHost(),question=row.why==='question';
 transaction(db=>{
  const fresh=!records.readRecord(db,row.id);
  if(fresh)records.insertRecord(db,row);
  const message=question?h.store.appendMessage(row.thread_id,{role:'bot',kind:'text',text:questionText(row,count+1)},row.chat_message_id):h.store.appendApprovalCard(row.thread_id,ref,view);
  if(message.id!==row.chat_message_id||!db.prepare('SELECT 1 FROM messages WHERE thread_id=? AND id=?').get(row.thread_id,row.chat_message_id))throw new Error('approval-row-not-written');
  if(fresh&&row.source_kind==='engine'&&!question)afterCommit(()=>appendDecision(DATA_DIR,{threadId:row.thread_id,botId:row.bot_id,requestId:row.request_id,tool:JSON.parse(row.evidence).action.tool,decision:'card-shown',source:row.why==='base'?'no-grant':'always-ask',rule:`${row.why}:registered`}));
 });
}
function projection(row:records.RecordRow):T.ApprovalRecordView{
 const p=JSON.parse(row.evidence);return freeze({ref:refFor(row.id),threadId:row.thread_id,botId:row.bot_id,requestId:row.request_id,chatMessageId:row.chat_message_id,state:row.state as T.ApprovalState,delivery:row.delivery as T.DeliveryState,why:row.why as T.ApprovalRecordView['why'],inputHash:row.input_hash,actionHash:row.action_hash,level:row.level as T.Registration['level'],evidence:p.items,...(p.ownerAuthority?{ownerAuthority:p.ownerAuthority}:{}),action:p.action,actor:row.actor_kind as T.Registration['actor'],initiator:p.initiator,...(row.queue_kind?{queue:{kind:row.queue_kind as T.ServiceId,ref:row.queue_ref!,epoch:p.epoch}}:{})});
}
export function readApproval(id:string):T.ApprovalRecordView|undefined{const row=records.readRecord(database(),id);return row?projection(row):undefined;}
export function openApprovals(threadId?:string):readonly T.ApprovalRecordView[]{return freeze(records.openRecords(database(),threadId).map(projection));}
export function lookupApproval(threadId:string,messageId:string):T.ApprovalRecordView|undefined{const r=records.lookupRecord(database(),threadId,messageId);return r?projection(r):undefined;}
function patchTerminal(row:records.RecordRow,label:string){const s=requiredHost().store;const m=s.messageById(row.thread_id,row.chat_message_id);if(m?.card)s.patchMessagePoint(row.thread_id,row.chat_message_id,{card:{...m.card,answered:label,dismissed:true,...(row.state==='expired'||row.state==='cancelled'||row.state==='superseded'?{orphaned:true}:{})}});}
export async function settle(ref:T.ApprovalRef,state:Exclude<T.ApprovalState,'open'>,answer?:T.ApprovalAnswer):Promise<void>{
 const row=requireRow(ref),e=entryForRef(ref);if(row.state!=='open'&&!(row.state==='answered'&&row.delivery==='pending'&&!e?.deliveryStarted&&state!=='answered')&&!(state==='superseded'&&row.source_kind==='engine'&&row.state!=='superseded'))return;
 transaction(db=>{records.updateRecord(db,row.id,{state,settled_at:Date.now(),...(row.delivery==='pending'&&state!=='answered'?{delivery:'none'}:{}),...(answer?{answer:JSON.stringify(answer)}:{})});patchTerminal({...row,state},state==='answered'?(answer?.behavior==='deny'?'Denied':'Allowed'):state==='superseded'?'Continued at the new level':state==='expired'?'Expired':'Cancelled');});
 if(e){e.terminal=true;if(e.row)e.row.state=state;}
 if(row.queue_kind&&state!=='answered'){const q=queues.get(row.queue_kind as T.ServiceId);if(!q)throw new Error('queue-recovery-source-missing');const item=q.pendingApprovals().find(i=>i.approvalId===row.id);if(item)await withDeadline(q.cancel(item,state),5000);}
}
async function send(row:records.RecordRow|undefined,e:Entry|undefined,answer:T.ApprovalAnswer):Promise<void>{
 const approvedForDelivery=row&&answer.behavior==='allow'?refFor(row.id):undefined;
 if(answer.behavior==='allow'&&row&&!['open','answered'].includes(row.state))return;
 if(answer.behavior==='allow'&&!e&&row&&ownerEligible({actor:row.actor_kind as T.Registration['actor'],level:row.level as T.Registration['level']}))return;
 if(answer.behavior==='allow'&&e?.releaseUpdatedInput&&answer.updatedInput===undefined&&e.exact&&e.exact.kind!=='incomplete'&&e.exact.operationHash!==e.originalOperationHash)answer={...answer,updatedInput:e.releaseUpdatedInput};
 if(answer.behavior==='allow'&&e){const blocked=checkEntryRelease(e,answer,approvedForDelivery);if(blocked)return;}
 const answerId=row?.answer_id??randomUUID();
 if(e){e.receiptDelivery='pending';e.receiptAnswer=freeze(boundedProjection(answer));}
 const partial=row?.why==='question'&&row.state==='open'&&!row.answer_id;
 const prior=row?.answer&&!partial?JSON.parse(row.answer):answer;
 if(row&&row.delivery==='accepted')return;
 if(row&&row.answer&&canonical(prior)!==canonical(answer))throw new Error('approval-answer-conflict');
 if(row)try{transaction(db=>{records.updateRecord(db,row.id,{state:'answered',settled_at:row.settled_at??Date.now(),answer:JSON.stringify(prior),answer_id:answerId,delivery:'pending'});patchTerminal({...row,state:'answered'},prior.behavior==='deny'?'Denied':'Allowed');});}catch(error){
  if(e&&row.source_kind==='engine'){await send(undefined,e,{behavior:'deny',message:REFUSAL});try{requiredHost().store.appendMessage(e.threadId,{role:'bot',kind:'text',text:REFUSAL});}catch{}}
  throw error;
 }
 const target=e?.registration.snapshot?targetOf(e.registration.snapshot):row?JSON.parse(row.evidence).target:undefined;
 const q=row?.queue_kind?queues.get(row.queue_kind as T.ServiceId):undefined;
 const item=q?.pendingApprovals().find(i=>i.approvalId===row?.id);
 if(row?.queue_kind&&(!item||!queueCallMatches(e,item,row.input_hash)))return;
 const respond=()=>{if(row?.queue_kind&&(!item||!queueCallMatches(e,item,row.input_hash)))return;const latest=!row&&e&&owner(e)?refresh(e):undefined;const current=!row&&e?.cancelled?{behavior:'deny' as const,message:REFUSAL}:latest?.kind==='refuse'?{behavior:'deny' as const,message:latest.message}:prior;if(current.behavior==='allow'&&e&&checkEntryRelease(e,prior,approvedForDelivery)){return;}if(row&&e?.cancelled)return;if(e)e.deliveryStarted=true;if(e)e.receiptAnswer=freeze(boundedProjection(current));return row?.queue_kind?(q&&item?q.respond(item,prior,{answerId}):Promise.resolve({state:'failed' as const})):target&&transport?transport.respond(target,current,{answerId}):Promise.resolve({state:'failed' as const});};
 let accepted=false;
 for(let attempt=0;attempt<2;attempt++){
  try{const run=()=>withDeadline(Promise.resolve().then(respond),10000);const result=e&&owner(e)?await noLimitsSlot(e,run):await run();if(!result)return;if(result.state==='accepted'||result.state==='already'){accepted=true;break;}}catch{}
 }
 if(e)e.receiptDelivery=accepted?'accepted':'unconfirmed';
 if(row)records.updateRecord(database(),row.id,{delivery:accepted?'accepted':'unconfirmed'});
 observe({type:'delivery',requestKey:e?.registration.key??row!.request_key,answerId,state:accepted?'accepted':'unconfirmed'});
 if(!accepted){if(target&&transport)await withDeadline(transport.interrupt(target),1000).catch(()=>{});if(q&&item){if(row)records.updateRecord(database(),row.id,{delivery:'failed'});await withDeadline(q.cancel(item,'delivery-failed'),5000);}requiredHost().store.appendMessage(e?.threadId??row!.thread_id,{role:'bot',kind:'text',text:'The tool permission could not be delivered. Nothing was confirmed.'});}
 if(e&&e.outcome?.kind!=='card'&&e.outcome?.kind!=='question')e.terminal=true;
 shedCompletedRequests();
}
export async function answerApproval(ref:T.ApprovalRef,answer:T.ApprovalAnswer):Promise<void>{
 const e=entryForRef(ref),row=requireRow(ref);
 if(e?.registration.snapshot){const snap=captures.get(scopedKey(e.threadId,e.registration.key))?.snapshot;if(snap&&snap.inputHash!==row.input_hash)throw new Error('approval-input-violation');}
 if(row.state!=='open'&&!row.answer_id)return;
 if(e?.delivery)return e.delivery;
 const flight=answerFlights.get(row.id);if(flight)return flight;
 const work=send(row,e,answer);answerFlights.set(row.id,work);if(e)e.delivery=work;try{await work;}finally{if(answerFlights.get(row.id)===work)answerFlights.delete(row.id);if(e?.outcome?.kind==='card'||e?.outcome?.kind==='question')e.delivery=undefined;}
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
export async function onLevelChange(botId:string):Promise<void>{
 const pending=records.openRecords(database()).filter(r=>r.bot_id===botId&&r.why==='base');
 await Promise.all(pending.map(async r=>{
  const e=[...entries.values()].find(e=>e.row?.id===r.id);if(!e)return;const a=authority(r.thread_id,botId,r.generation??undefined);if(a.level!=='unlimited')return;
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
   await answerApproval(refFor(r.id),{behavior:'allow'});
  }
  else if(outcome.kind==='card'&&owner(e)){
   const items=wipeEvidence(e.registration.action);
   if(items.length){const payload=JSON.parse(r.evidence);payload.items=items;records.updateRecord(database(),r.id,{why:items[0].kind,level:a.level,registration_hash:e.registration.registrationHash,evidence:JSON.stringify(payload)});}
  }
 }));
}

async function cancelEntry(e:Entry,state:'cancelled'|'expired'|'superseded'){
 e.cancelled=true;e.terminal=true;e.outcome=freeze({kind:'refuse',message:REFUSAL});
 const persisted=e.row&&records.readRecord(database(),e.row.id);if(persisted)await settle(refFor(persisted.id),state);
 const src=e.registration.source;
 if(!persisted&&src.kind==='service'&&e.attached){const q=queues.get(src.service),item=q?.pendingApprovals().find(i=>i.approvalId===e.row?.id);if(item&&q)await withDeadline(q.cancel(item,state),5000);}
}
export async function cancelRequests(scope:T.RequestCancellation,state:'cancelled'|'expired'|'superseded'):Promise<void>{
 const matching=[...entries.values()].filter(e=>e.threadId===scope.threadId&&(scope.kind==='thread'||e.authority.generation===scope.generation));
 // Start every fence before waiting for any persisted settlement or queue IO.
 const results=await Promise.allSettled(matching.map(e=>cancelEntry(e,state)));
 const failed=results.find(r=>r.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
}
export function readTurnPolicy(identity:T.TurnIdentity):T.TurnPolicy|undefined{
 const a=authority(identity.threadId,undefined,identity.generation);if(a.actor==='unproven'||a.generation!==identity.generation)return;
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

export async function relistQuestions(threadId:string):Promise<void>{const rows=records.openRecords(database(),threadId).filter(r=>r.why==='question');for(let i=0;i<rows.length;i++)requiredHost().store.appendMessage(threadId,{role:'bot',kind:'text',text:questionText(rows[i],i+1,rows.length)});}
export async function saveContinuation(key:T.ContinuationKey,parent:T.TurnIdentity):Promise<void>{const a=authority(parent.threadId,key.botId,parent.generation);if(parent.threadId!==key.threadId||a.actor==='unproven'||!a.provenance)throw new Error('unproven-continuation');records.saveContinuationRecord(database(),canonical(key),canonical({level:a.level,actor:a.actor,initiator:a.provenance.initiator,principal:a.provenance.principal,roomOwnerOnly:a.provenance.roomOwnerOnly}));}
export function readContinuation(key:T.ContinuationKey):T.ContinuationProvenance|undefined{const value=records.readContinuationRecord(database(),canonical(key));return value?freeze(JSON.parse(value)):undefined;}
export async function deleteContinuation(key:T.ContinuationKey):Promise<void>{records.deleteContinuationRecord(database(),canonical(key));}
async function recoverQueueRun(q:T.QueueRecoverySource,item:T.PendingQueueApproval,e:Entry,row?:records.RecordRow):Promise<void>{
 if(row){await send(row,e,{behavior:'allow'});return;}
 const db=database(),prior=records.readQueueDelivery(db,item.approvalId);
 if(prior&&(prior.kind!==item.kind||prior.inputHash!==e.registration.inputHash)){await withDeadline(q.cancel(item,'conflict'),5000);throw new Error('queue-delivery-conflict');}
 const receipt=prior??{kind:item.kind,inputHash:e.registration.inputHash,answerId:randomUUID(),delivery:'pending' as const};
 records.writeQueueDelivery(db,item.approvalId,{...receipt,delivery:'pending'});
 for(let attempt=0;attempt<2;attempt++)try{
  const blocked=checkEntryRelease(e,{behavior:'allow'});if(blocked){if(blocked.kind==='card'||blocked.kind==='question')await presentApproval(blocked.ref,item.view);return;}
  if(!queueCallMatches(e,item,e.registration.inputHash))throw new Error('queue-action-mismatch');
  const ack=await withDeadline(q.respond(item,{behavior:'allow'},{answerId:receipt.answerId}),10000);
  if(ack.state==='accepted'||ack.state==='already'){records.deleteQueueDelivery(db,item.approvalId);e.terminal=true;observe({type:'delivery',requestKey:e.registration.key,answerId:receipt.answerId,state:'accepted'});return;}
 }catch{}
 records.writeQueueDelivery(db,item.approvalId,{...receipt,delivery:'failed'});observe({type:'delivery',requestKey:e.registration.key,answerId:receipt.answerId,state:'failed'});await withDeadline(q.cancel(item,'delivery-failed'),5000);records.deleteQueueDelivery(db,item.approvalId);throw new Error('queue-delivery-failed');
}
function pruneQueueReceipts(){const pending=new Set([...queues.values()].flatMap(q=>q.pendingApprovals().map(i=>i.approvalId)));records.pruneQueueDeliveries(database(),pending);}
let pruneTimer:ReturnType<typeof setInterval>|undefined;
export async function recover():Promise<void>{
 const db=database();requiredHost();
 for(const kind of records.requiredQueueKinds(db))if(!queues.has(kind as T.ServiceId))throw new Error('queue-recovery-source-missing');
 // No engine generation survives restart. Persisted pending delivery is honest.
 for(const row of records.openRecords(db))if(row.source_kind==='engine')await settle(refFor(row.id),'expired');
 for(const r of records.pendingEngineAnswers(db)){records.updateRecord(db,r.id,{delivery:'unconfirmed'});patchTerminal(r,r.answer&&JSON.parse(r.answer).behavior==='deny'?'Denied':'Allowed, not run (restart)');
 }
 const queueRows=records.openRecords(db).filter(r=>r.source_kind==='service');
 for(const r of queueRows)if(!queues.has(r.queue_kind as T.ServiceId))throw new Error('queue-recovery-source-missing');
 for(const q of queues.values())for(let item of q.pendingApprovals()){
  if(item.kind!==q.kind||item.ref!==item.call.approval.queueRef||item.epoch!==item.call.approval.epoch){await withDeadline(q.cancel(item,'conflict'),5000);continue;}
  let row=records.readRecord(db,item.approvalId);
  if(row&&(row.queue_kind!==item.kind||row.queue_ref!==item.ref||JSON.parse(row.evidence).epoch!==item.epoch||row.input_hash!==hash(checkedCall(item.call)))){await withDeadline(q.cancel(item,'conflict'),5000);continue;}
  if(row&&row.state!=='open'){
   if(row.state==='answered'){
    if(row.delivery!=='pending'&&row.delivery!=='failed')continue;
    const prior=reopenQueueDelivery(q,item,row);
    if(!prior){await withDeadline(q.cancel(item,'unverifiable'),5000);continue;}
    const answer:T.ApprovalAnswer=JSON.parse(row.answer!);
    if(answer.behavior!=='allow'||entryRelease(prior,answer,refFor(row.id)).kind==='release'){await send(row,prior,answer);continue;}
    records.updateRecord(db,row.id,{state:'superseded',settled_at:Date.now()});patchTerminal({...row,state:'superseded'},'Permission changed before release');prior.terminal=true;
   }
   const renewal={approvalId:randomUUID(),epoch:randomUUID()};
   const renewed=await withDeadline(q.renew(item,renewal),5000);if(renewed.approvalId!==renewal.approvalId||renewed.epoch!==renewal.epoch||renewed.call.approval.epoch!==renewal.epoch||renewed.ref!==item.ref||renewed.kind!==item.kind)throw new Error('queue-renewal-conflict');item=renewed;row=undefined;
  }
  const src=q.reopen(item);if(!src||src.service!==q.kind||hash(checkedCall(src.call))!==hash(checkedCall(item.call))||!claims.has(src.claim)){await withDeadline(q.cancel(item,'unverifiable'),5000);continue;}
  const handle=openRequest(src),e=entry(handle);if(row&&(row.thread_id!==e.threadId||row.bot_id!==e.authority.botId)){await withDeadline(q.cancel(item,'unverifiable'),5000);continue;}const outcome=decide(handle,q.base);
  if(outcome.kind==='run'){await recoverQueueRun(q,item,e,row);continue;}
  if(outcome.kind==='refuse'){await withDeadline(q.cancel(item,'unverifiable'),5000);continue;}
  if(!row){const old=e.row!;const payload=JSON.parse(old.evidence);payload.action.approvalId=item.approvalId;old.id=item.approvalId;old.action_hash=hash(actionProjection(payload.action));payload.action.actionHash=old.action_hash;old.evidence=JSON.stringify(payload);e.ref=refFor(old.id);e.outcome={kind:outcome.kind,ref:e.ref};}
  else{e.row=row;e.ref=refFor(row.id);e.outcome={kind:outcome.kind,ref:e.ref};}
  attachQueue(e.ref!,{kind:q.kind,ref:item.ref,call:item.call});await presentApproval(e.ref!,item.view);
 }
 records.pruneRecords(db);pruneQueueReceipts();if(!pruneTimer){pruneTimer=setInterval(()=>{try{records.pruneRecords(database());pruneQueueReceipts();}catch{}},3600000);pruneTimer.unref?.();}
}

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
  const next=refresh(e);
  if(next.kind==='run'){
   const source=queues.get(row.service as T.ServiceId),cap=synchronousQueues.get(row.service as T.ServiceId);
   const item=source?.pendingApprovals().find(i=>i.approvalId===ref.approvalId);
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
    const ack=synchronousAck(()=>{if(checkEntryRelease(e,{behavior:'allow'}))return {state:'failed'};if(!queueCallMatches(e,item,e.registration.inputHash))return {state:'failed'};return cap.delivery.respondNow(item,{behavior:'allow'},{answerId:receipt.answerId});});const accepted=ack.state==='accepted'||ack.state==='already';
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
 commitPresentation(row,ref,view,count);
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
export function answerApprovalSync(ref:T.ApprovalRef,answer:T.ApprovalAnswer):import('../contracts.ts').RequestDelivery {
 let e=entryForRef(ref);const row=requireRow(ref);
 if(row.source_kind!=='service'||!row.queue_kind)return {state:'failed'};
 const prior:T.ApprovalAnswer=row.answer?JSON.parse(row.answer):answer;
 if(row.answer&&canonical(prior)!==canonical(answer))return {state:'failed'};
 if(row.delivery==='accepted')return {state:'already'};
 if(e?.delivery||answerFlights.has(row.id))return {state:'failed'};
 if(row.state!=='open'&&!row.answer_id)return {state:'failed'};
 const source=queues.get(row.queue_kind as T.ServiceId),cap=synchronousQueues.get(row.queue_kind as T.ServiceId);
 const item=source?.pendingApprovals().find(i=>i.approvalId===row.id);
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
  transaction(db=>{records.updateRecord(db,row.id,{state:'answered',settled_at:row.settled_at??Date.now(),answer:JSON.stringify(prior),answer_id:answerId,delivery:'pending'});patchTerminal({...row,state:'answered'},prior.behavior==='deny'?'Denied':'Allowed');});
  result=synchronousAck(()=>{if(prior.behavior==='allow'&&checkEntryRelease(e!,prior,ref)){releaseHeld=true;return {state:'failed'};}if(!queueCallMatches(e,item,row.input_hash))return {state:'failed'};return cap.delivery.respondNow(item,prior,{answerId});});
  if(releaseHeld)return result;
  const accepted=result.state==='accepted'||result.state==='already';
  transaction(db=>{records.updateRecord(db,row.id,{delivery:accepted?'accepted':'failed'});if(!accepted)patchTerminal({...row,state:'answered'},'The tool permission could not be delivered. Nothing was confirmed.');});
  observe({type:'delivery',requestKey:row.request_key,answerId,state:accepted?'accepted':'failed'});
  if(e)e.terminal=true;return result;
 }finally{finish();if(answerFlights.get(row.id)===flight)answerFlights.delete(row.id);}
}
export function isAllowedAnswer(answer:unknown):boolean {return answer==='Allowed'||answer==='allow';}

function synchronousAck(send:()=>import('../contracts.ts').RequestDelivery):import('../contracts.ts').RequestDelivery {
 try{const ack=send();if(ack&&typeof (ack as any).then==='function'){void Promise.resolve(ack).catch(()=>{});return {state:'failed'};}
 return ack?.state==='accepted'||ack?.state==='already'?ack:{state:'failed'};}catch{return {state:'failed'};}
}

// S4 installs the authenticated source reader and recovery binder; neither
// this bridge nor a producer can manufacture an ExecutionClaim.
export function installProducerBindings(bindings: T.ProducerBindings): () => void { return bindProducers(bindings); }
export function producerAuthorityFor(threadId: string, botId: string): T.ProducerAuthority | undefined {
 const a=producerBindings()?.authorityFor(threadId,botId),c=a&&claims.get(a.claim);
 return c?.threadId===threadId&&c.botId===botId&&authority(threadId,botId,c.generation).actor!=='unproven'?a:undefined;
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


/** Fresh exact owner inspection. The sidecar retains every hazard's resolution,
 * dependency and anchor, beyond the card's presentation bounds. */
function inspectRelease(operation:OwnerOperation):ReleaseInspection {
 const fresh=inspectOwnerOperation(operation);
 return freeze({decisions:fresh.decisions,taintEvidence:fresh.hazards});
}
function releaseContext(identity:import('./release-guard.ts').ReleaseIdentity):import('./release-guard.ts').ReleaseBinding|undefined {
 const e=entries.get(scopedKey(identity.threadId,identity.requestKey));
 if(!e||e.authority.generation!==identity.generation||e.cancelled||e.conflict)return;
 const a=authority(e.threadId,e.authority.botId,e.authority.generation);
 if(a.actor==='unproven'||a.generation!==e.authority.generation)return;
 if(!owner(e)&&!ownerEligible(a))return {posture:'legacy'};
 if(!owner(e)||!ownerEligible(a)||!e.exact||e.exact.kind==='incomplete')return;
 return {posture:'owner-no-limits',operationHash:e.exact.operationHash,inspect:inspectRelease,approved:ref=>{
  if(!issuedRef(ref))return;
  const row=records.readRecord(database(),ref.approvalId);
  if(!row||row.id!==e.row?.id||row.thread_id!==e.threadId||row.request_key!==e.registration.key||row.generation!==e.authority.generation||row.input_hash!==e.registration.inputHash||!['open','answered'].includes(row.state))return;
  if(row.state==='answered'&&(!row.answer||JSON.parse(row.answer).behavior!=='allow'))return;
  return JSON.parse(row.evidence).releaseEvidence;
 }};
}
function releaseSource(e:Entry,updatedInput:unknown):T.RequestSnapshot|T.ServiceCall {
 const r=e.registration;
 return r.snapshot?{...r.snapshot,input:updatedInput,event:{...r.snapshot.event,toolCall:{name:r.snapshot.event.toolCall?.name??r.snapshot.tool,input:updatedInput}}}: {tool:r.action.tool,input:updatedInput};
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
  if(source)try{action=describeNoLimits(source,e.threadId,e.authority.botId);}catch{/* Unreadable alone runs. */}
  wipes=wipeEvidence(action);
  if(!wipes.length){if(approved)e.releaseApproval=approved;return;}
  const digest=hash({source,action:action.deletes});
  const row=e.row&&(records.readRecord(database(),e.row.id)??e.row);
  const originalWipe=row?.why==='wipe'&&!e.conflict&&answer.updatedInput===undefined&&(!latest||latest.inputHash===row.input_hash);
  if(approved&&issuedRef(approved)&&row?.id===approved.approvalId&&(e.wipeReleaseHash===digest||originalWipe)){
   e.wipeReleaseHash=digest;e.releaseApproval=approved;return;
  }
  if(e.releaseApproval&&issuedRef(e.releaseApproval)&&e.wipeReleaseHash===digest)return;
  e.wipeReleaseHash=digest;
  e.registration=freeze({...e.registration,action,registrationHash:hash({prior:e.registration.registrationHash,wipes,digest})});
  result={kind:'hold',inspection:{decisions:[]}};
 }else result=entryRelease(e,answer,approved);
 if(result.kind==='release'){if(approved)e.releaseApproval=approved;return;}
 // A changed input is a new operation; it needs its own fresh evidence and card.
 let inspection=result.kind==='hold'?result.inspection:undefined;
 if(result.kind==='refuse'&&result.reason==='unverified-approval'&&e.exact&&e.exact.kind!=='incomplete')try{inspection=inspectRelease(e.exact.exactOperation);}catch{}
 if(answer.updatedInput!==undefined){const exact=extractInspectedOperation(releaseSource(e,answer.updatedInput));if(exact.kind!=='incomplete'){if(!e.exact||e.exact.kind==='incomplete'||exact.operationHash!==e.exact.operationHash)e.releaseUpdatedInput=answer.updatedInput;e.exact=exact;try{inspection=inspectRelease(exact.exactOperation);}catch{}}}
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
  const message=requiredHost().store.messageById(e.threadId,persisted.chat_message_id);
  const replaceMessage=!!message?.card;
  // Presented terminal cards are immutable. A new evidence version gets a
  // new message and issuer epoch; the old card remains terminal and old refs
  // can no longer authorize this version of the same pending operation.
  if(message?.card){records.updateRecord(database(),persisted.id,{state:'superseded',settled_at:Date.now()});requiredHost().store.patchMessagePoint(e.threadId,message.id,{card:{...message.card,answered:RELEASE_SUPERSEDED,dismissed:true}});}
  const messageId=replaceMessage?randomUUID():persisted.chat_message_id;
  // The public answer key belongs to this immutable presentation. Keep the
  // provider's pending request ID in requestRef/row.request_id and the Entry;
  // replaying an old HTTP body must never select this new evidence epoch.
  if(replaceMessage&&persisted.source_kind==='engine')payload.action.requestId=`release-${messageId}`;
  const actionHash=hash(actionProjection(payload.action));payload.action.actionHash=actionHash;
  referenceEpochs.set(persisted.id,{});
  records.updateRecord(database(),persisted.id,{state:'open',why,answer:null,answer_id:null,delivery:'none',settled_at:null,evidence:JSON.stringify(payload),action_hash:actionHash,registration_hash:e.registration.registrationHash,...(replaceMessage?{chat_message_id:messageId,presented_action:null}:{})});
  e.row=records.readRecord(database(),persisted.id);e.ref=refFor(persisted.id);e.outcome=freeze({kind:'card',ref:e.ref});
  if(replaceMessage)commitPresentation(e.row!,e.ref,requiredHost().view(e.registration),0);
 }else{
  e.row=undefined;e.ref=undefined;e.outcome=freeze(approval(e,why,evidence));
  if(e.outcome.kind==='card'&&e.registration.source.kind==='engine')commitPresentation(e.row!,e.outcome.ref,requiredHost().view(e.registration),0);
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
 const ownerNoLimits=ownerEligible(current);
 if(ownerNoLimits){
  // Stop is a lifecycle cancellation, not a permission hold.
  if(e?.cancelled)return false;
  const source=replay??(updatedInput!==undefined?{tool:e?.registration.action.tool??'Bash',input:updatedInput}:undefined);
  if(source){
   let wipes:readonly T.Evidence[]=[];try{wipes=wipeEvidence(describeNoLimits(source,identity.threadId,e?.authority.botId??authority(identity.threadId).botId));}catch{/* Uncertainty alone runs. */}
   if(!wipes.length)return true;
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
 e.row=row;e.ref=refFor(row.id);e.attached=freeze({kind:item.kind,ref:item.ref,call:item.call});
 return e;
}


function queueCallMatches(e:Entry|undefined,item:T.PendingQueueApproval,inputHash:string):boolean {
 try{return hash(checkedCall(item.call))===inputHash&&(!e||!owner(e)||!!e.executionCall&&exactInputHash(item.call)===exactInputHash(e.executionCall));}catch{return false;}
}
