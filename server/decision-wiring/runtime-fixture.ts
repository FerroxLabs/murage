// SPDX-License-Identifier: AGPL-3.0-or-later
// Test doubles at the published S0 boundary. This proves S4 wiring, not S1
// hashing, SQL seams, deadlines, or S3 transport acknowledgement implementation.
export const fakeDecisionModule = String.raw`
import { appendFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { database } from '../database.ts';
import * as nativeDecision from './api.ts';
import { insertRecord, updateRecord } from './records.ts';
import { hash } from './bounds.ts';
import { actionProjection } from '../../shared/permission-card.ts';
let reader, transport, host, bindings;
const canonical=key=>JSON.stringify(Object.fromEntries(Object.entries(key).sort(([a],[b])=>a.localeCompare(b))));
const captures=new Map(), handles=new WeakMap(), records=new Map(), queues=new Map(), saved=new Map();
const durableFile=join(process.env.MURAGE_DATA_DIR,'s4-fake-records.json');
const persist=()=>{for(const r of records.values())updateRecord(database(),r.ref.approvalId,{state:r.state,delivery:r.state==='answered'?'accepted':'none'});writeFileSync(durableFile,JSON.stringify([...records.values()].map(({registration,handle,...r})=>r)));};
const trace=e=>appendFileSync(join(process.env.MURAGE_DATA_DIR,'s4-fixture-trace.jsonl'),JSON.stringify(e)+'\n');
export function installRequestIngress(bus){const removeNative=nativeDecision.installRequestIngress(bus);trace({type:'ingress-installed'});const remove=bus.subscribe(e=>{if(e.type==='request.opened'){const value=JSON.parse(JSON.stringify(e));captures.set(e.threadId+':'+e.requestId,{event:value,generation:reader?.turnGenerationFor(e.threadId)});trace({type:'captured',requestId:e.requestId,generation:reader?.turnGenerationFor(e.threadId)});}});return ()=>{remove();removeNative();};}
export function installProvenanceReader(value){nativeDecision.installProvenanceReader(value);reader=value;trace({type:'provenance-installed'});}
export function isAllowedAnswer(answer){return answer==='Allowed'||answer==='allow';}
export function installDenySources(value){nativeDecision.installDenySources(value);}
export function installDecisionHost(value){host=value;return nativeDecision.installDecisionHost(value);}
export function installEngineApprovalBuilder(value){return nativeDecision.installEngineApprovalBuilder(value);}
export function installDecisionTransport(value){transport=value;}
export function installClaimVerifier(verify){return proof=>verify(proof)?Object.freeze({proof}):undefined;}
export function installProducerBindings(value){bindings=value;return ()=>{};}
export function producerAuthorityFor(threadId,botId){return bindings.authorityFor(threadId,botId);}
export function producerNoLimitsPolicyFor(threadId,botId){const generation=reader?.turnGenerationFor(threadId);if(generation===undefined)return reader?.live(threadId)===undefined?undefined:false;return reader?.live(threadId)?.botId===botId&&readTurnPolicy({threadId,generation})?.permission.noLimits===true;}
export function registerProducerQueue(port){return bindings.registerQueue(port);}
export function installProducerQueueFactory(){return ()=>{};}
export function producerQueue(kind){if(!queues.has(kind)){const port={kind,pendingApprovals:()=>[],base:()=>({approve:null,source:'no-grant'}),respond:async()=>{throw Error('fixture queue delivery not configured');},cancel:async()=>{},renew:async()=>{throw Error('fixture queue renewal not configured');},bindAcceptance:()=>()=>{},open:()=>{throw Error('fixture service not configured');}};queues.set(kind,port);bindings.registerQueue(port);}return queues.get(kind);}
export function installQueueSources(){return ()=>{};}
export function installSynchronousQueueDeliveries(){return ()=>{};}
export async function recover(){
 if(existsSync(durableFile))for(const r of JSON.parse(readFileSync(durableFile,'utf8'))){records.set(r.ref.approvalId,r);if(r.state==='open'){r.state='expired';persist();const row=host.store.messageById(r.threadId,r.chatMessageId);if(row)host.store.patchMessage(r.threadId,r.chatMessageId,{card:{...row.card,answered:'expired',dismissed:true}});}}
 trace({type:'recovered'});
}
function policy(threadId,generation){const p=reader.provenance(generation),live=reader.live(threadId);if(!p||!live||p.generation!==generation)return;const owner=p.roomOwnerOnly&&live.owner;let actor='other';if(owner&&(p.initiator.k==='owner-typed'||p.initiator.k==='owner-channel-dm'))actor='owner';if(owner&&'sourceRunId'in p.initiator)actor=live.routine?'owner-routine':'unproven';return {actor,level:live.level,p,live};}
export function readTurnPolicy(identity){const p=policy(identity.threadId,identity.generation);if(!p)return;const noLimits=p.level==='unlimited'&&(p.actor==='owner'||p.actor==='owner-routine');trace({type:'policy',threadId:identity.threadId,generation:identity.generation,actor:p.actor,level:p.level,initiator:p.p.initiator.k});return {actor:p.actor,level:p.level,permission:p.level==='ask'?{routeAsks:true,askLevel:true}:p.level==='auto'?{routeAsks:true}:noLimits?{stopLine:true,noLimits:true}:{stopLine:true}};}
export function openRequest(source){const h={};const snapshot=captures.get(source.threadId+':'+source.requestId);handles.set(h,{source,snapshot});return h;}
export function decide(handle,base){const h=handles.get(handle),s=h.snapshot;if(!s)throw Error('fixture snapshot missing');const p=policy(h.source.threadId,s.generation);const registration={key:h.source.requestId,source:h.source,snapshot:{...s.event,event:s.event,generation:s.generation},actor:p?.actor??'unproven',level:p?.level??'ask',action:{},deny:[],denyRev:[],inputHash:'fixture-input',registrationHash:'fixture-registration'};const result=p?.level==='unlimited'&&(p.actor==='owner'||p.actor==='owner-routine')?{kind:'run'}:base(registration).approve?{kind:'run'}:{kind:'card',ref:{approvalId:'fixture-'+h.source.requestId}};if(result.kind==='run'&&nativeDecision.decide(nativeDecision.openRequest(h.source),base).kind!=='run')throw Error('fixture/native decision mismatch');h.result=result;trace({type:'decided',requestId:h.source.requestId,kind:result.kind,actor:registration.actor,level:registration.level});if(result.ref){records.set(result.ref.approvalId,{ref:result.ref,threadId:h.source.threadId,botId:p.live.botId,requestId:h.source.requestId,chatMessageId:'card-'+h.source.requestId,state:'open',evidence:[],actor:p.actor,initiator:p.p.initiator,registration,handle});}return result;}
export function readRequestExecution(handle){const h=handles.get(handle);return {outcome:h.result.kind,delivery:h.delivery??'none',answer:h.delivery==='accepted'?{behavior:'allow'}:undefined};}
export async function deliverRequest(handle){const h=handles.get(handle),s=h.snapshot,e=s.event;const result=await transport.respond({providerInstanceId:e.providerInstanceId,threadId:e.threadId,generation:s.generation,turnId:e.turnId,requestId:e.requestId},{behavior:'allow'},{answerId:'fixture-'+e.requestId});h.delivery=result.state;trace({type:'delivery',requestId:e.requestId,state:result.state});if(result.state==='failed')throw Error('fixture transport failed');}
export async function presentApproval(ref,view){const r=records.get(ref.approvalId);const card={...view,tool:r.registration.snapshot.event.tool,requestId:r.requestId,approvalId:ref.approvalId,requestRef:r.requestId,options:['Allow','Deny']};card.actionHash=hash(actionProjection(card));r.action=actionProjection(card);r.actionHash=card.actionHash;r.why='base';
// The S0 state double still obeys the real Store's record-before-card fence.
insertRecord(database(),{id:ref.approvalId,source_kind:'engine',service:null,thread_id:r.threadId,request_key:r.requestId,request_id:r.requestId,bot_id:r.botId,generation:r.registration.snapshot.generation??null,actor_kind:r.actor,actor_via:'fixture',level:r.registration.level,why:'base',evidence:'{}',registration_hash:'fixture',deny_rev:'[]',input_hash:'fixture',action_hash:card.actionHash,presented_action:null,chat_message_id:r.chatMessageId,queue_kind:null,queue_ref:null,state:'open',answer:null,answer_id:null,delivery:'none',created_at:Date.now(),settled_at:null});
host.store.appendMessage(r.threadId,{role:'bot',kind:'options',card},r.chatMessageId);persist();if(existsSync(join(process.env.MURAGE_DATA_DIR,'s4-expire-next')))setTimeout(()=>settle(ref,'expired'),200);}
export function readApproval(id){return records.get(id);}
export function openApprovals(threadId){return [...records.values()].filter(r=>r.state==='open'&&(!threadId||r.threadId===threadId));}
export function lookupApproval(threadId,id){return [...records.values()].find(r=>r.threadId===threadId&&r.chatMessageId===id);}
export function readApprovalExecution(ref){const r=records.get(ref.approvalId);return {outcome:r?.why==='question'?'question':'card',delivery:r?.state==='answered'?'accepted':'none',answer:r?.answer};}
export async function answerApproval(ref,answer){const r=records.get(ref.approvalId),h=handles.get(r.handle),e=h.snapshot.event;const delivery=await transport.respond({providerInstanceId:e.providerInstanceId,threadId:e.threadId,generation:h.snapshot.generation,turnId:e.turnId,requestId:e.requestId},answer,{answerId:'answer-'+e.requestId});if(delivery.state==='failed')throw Error('fixture answer failed');r.state='answered';r.answer=answer;persist();const row=host.store.messageById(r.threadId,r.chatMessageId);host.store.patchMessage(r.threadId,r.chatMessageId,{card:{...row.card,answered:answer.behavior,dismissed:false}});trace({type:'answered',requestId:e.requestId,answer:answer.behavior});}
export async function onLevelChange(botId){trace({type:'level-change',botId});}
export async function cancelRequests(scope){trace({type:'cancelled',scope});}
export async function settle(ref,state){const r=records.get(ref.approvalId);if(!r||r.state!=='open')return;r.state=state;persist();const row=host.store.messageById(r.threadId,r.chatMessageId);if(row)host.store.patchMessage(r.threadId,r.chatMessageId,{card:{...row.card,answered:state,dismissed:true}});}
export async function answerQuestionReply(){return {kind:'send',pending:[]};}
export async function relistQuestions(){}
export function describeAction(){return {executables:[],targets:[],deletes:[],content:[]};}
export function attachQueue(){}
export async function executeService(handle,execute){return {kind:'executed',value:await execute(handles.get(handle).source.call)};}
// S2m/S2p import these additive S1 exports. These engine-only fixture cases
// never execute a synchronous service; fail explicitly if one reaches them.
export function executeServiceSync(){throw Error('fixture synchronous service not configured');}
export function presentApprovalSync(){throw Error('fixture synchronous presentation not configured');}
export function answerApprovalSync(){throw Error('fixture synchronous answer not configured');}
export async function saveContinuation(key,parent){const p=reader.provenance(parent.generation);if(!p)throw Error('fixture parent missing');saved.set(canonical(key),{actor:p.initiator.k==='owner-typed'?'owner':'other',initiator:p.initiator,principal:p.principal,roomOwnerOnly:p.roomOwnerOnly});}
export function readContinuation(key){return saved.get(canonical(key));}
export function listContinuations(filter){const keys=[...saved.keys()].sort().filter(k=>{const x=JSON.parse(k);return x.kind===filter.kind&&x.id.startsWith('shared-peer:')&&(!filter.after||k>filter.after);}).slice(0,filter.limit+1);const page=keys.slice(0,filter.limit);return {keys:page.map(k=>JSON.parse(k)),...(keys.length>filter.limit?{next:page.at(-1)}:{})};}
export async function deleteContinuation(key){saved.delete(canonical(key));}
export function installDecisionObserver(){return ()=>{};}
`;

export const strictFakeAdapterInstrumentation = `
// Strict fake capability for the fixture's fake CLI only; production S4 never adapts a legacy result.
const fixtureGet=ProviderRegistry.prototype.get;
ProviderRegistry.prototype.get=function(id){const instance=fixtureGet.call(this,id);if(instance&&!instance.decisionAdapter){Object.defineProperty(instance.adapter,'capabilities',{value:{...instance.adapter.capabilities,queueing:false}});const answered=new Map();Object.defineProperty(instance,'decisionAdapter',{value:{respondToRequest:async(t,r,a,o)=>{if(answered.has(r))return {state:answered.get(r)===o.answerId?'already':'failed'};const value=await instance.adapter.respondToRequest(t,r,a);if(value==='unavailable')return {state:'failed'};answered.set(r,o.answerId);return {state:'accepted'};},interruptTurn:(...args)=>instance.adapter.interruptTurn(...args),onPostureChange:async()=>{}}});}return instance;};
`;

export const instrumentation = `
import { registerHooks } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const configFile=join(process.env.MURAGE_DATA_DIR,'config.json');
const config=JSON.parse(readFileSync(configFile,'utf8'));
config.instances.verification.environment={...(config.instances.verification.environment??{}),FAKE_CLAUDE_PERM_TOOL:'Read',FAKE_CLAUDE_PERM_INPUT:JSON.stringify({file_path:'/tmp/s4-isolated-protocol-witness'})};
writeFileSync(configFile,JSON.stringify(config));
registerHooks({load(url,context,next){
 if(url.endsWith('/server/decision/index.ts'))return {format:'module',source:${JSON.stringify(fakeDecisionModule)},shortCircuit:true};
 const result=next(url,context);
 if(url.endsWith('/server/harness/registry.ts'))return {...result,source:String(result.source)+${JSON.stringify(strictFakeAdapterInstrumentation)} };
 return result;
}});
`;
