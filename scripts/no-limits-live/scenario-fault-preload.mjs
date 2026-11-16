// Isolated release-fixture fault injection at the existing reader/ingress
// boundaries. It never supplies a verdict, native receipt or success witness.
import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {readFileSync,appendFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {serviceIntentHash} from './native-operation-evidence.mjs';
const key=Symbol.for('gnl.scenario.faults'),dir=process.env.MURAGE_DATA_DIR;
const config=()=>{try{return JSON.parse(readFileSync(join(dir,'gnl-scenario-fault.json'),'utf8'));}catch{return {};}};
const written=new Set(),registrations=new Map(),events=new Map();
const witness=(mode,threadId)=>{const token=mode+threadId;if(written.has(token))return;written.add(token);appendFileSync(join(dir,'gnl-fault-witness.ndjson'),JSON.stringify({mode,threadId,at:Date.now()})+'\n');};
const faults=globalThis[key]={
 opened(entry){const r=entry.registration;if(r.source.kind==='service')appendFileSync(join(dir,'nolim-service-protocol.ndjson'),JSON.stringify({at:Date.now(),threadId:entry.threadId,requestKey:r.key,requestId:entry.requestId,decisionGeneration:entry.authority.generation,registrationInputHash:serviceIntentHash(r.source.call),tool:r.source.call.tool,input:r.source.call.input})+'\n');},
 offered(offer){appendFileSync(join(dir,'nolim-mirror-offers.ndjson'),JSON.stringify({nonceHash:createHash('sha256').update(offer.nonce).digest('hex'),approvalId:offer.approval.approvalId,requestRef:offer.approval.requestRef,messageId:offer.approval.id})+'\n');},
 host:undefined,builder:undefined,reset:undefined,captureAgain:undefined,
 reader(reader){faults.originalReader=reader;return {...reader,...Object.fromEntries(['turnGenerationFor','provenance','live','ownerThread'].map(name=>[name,(...args)=>{
  const c=config(),value=reader[name]?.(...args);
  if(c.mode==='missing-origin'&&(name==='provenance'&&value?.threadId===c.threadId||name==='ownerThread'&&args[0]===c.threadId)){witness(c.mode,c.threadId);return undefined;}return value;
 }]))};},
 captured(event){events.set(event.threadId,event);if(event.threadId.startsWith('project-')){const reader=faults.originalReader,g=reader.turnGenerationFor(event.threadId);appendFileSync(join(dir,'gnl-request-inputs.ndjson'),JSON.stringify({threadId:event.threadId,diagnostic:{g,live:reader.live(event.threadId),provenance:reader.provenance(g)}})+'\n');}appendFileSync(join(dir,'gnl-request-inputs.ndjson'),JSON.stringify({threadId:event.threadId,tool:event.toolCall})+'\n');},
 observed(event){
  if(event.type==='registered'){registrations.set(event.requestKey,event.threadId);const c=config();if(c.mode==='missing-origin'&&c.threadId===event.threadId)appendFileSync(join(dir,'gnl-fault-witness.ndjson'),JSON.stringify({mode:c.mode,threadId:event.threadId,at:Date.now(),effectiveLevel:event.level,actor:event.actor})+'\n');}
  if(event.type!=='decided')return;
  const threadId=registrations.get(event.requestKey),c=config();if(c.threadId!==threadId||written.has(c.mode+threadId))return;
  if(c.mode==='owner-missing-live-record'){
   witness(c.mode,threadId);faults.reset(faults.host);faults.rebuild?.(faults.builder);
  }else if(c.mode==='release-input-changed'){
   const previous=events.get(threadId);if(!previous?.toolCall)return;
   witness(c.mode,threadId);faults.captureAgain({...previous,toolCall:{...previous.toolCall,input:{...previous.toolCall.input,command:c.changedCommand}}});
  }
 },
};
registerHooks({load(url,context,next){
 const result=next(url,context);
 // Preserve earlier candidate mutation/load hooks; rereading the checkout here
 // silently replaced their source after they had reported activation.
 const loadedSource=()=>typeof result.source==='string'?result.source:result.source?Buffer.from(result.source).toString():readFileSync(new URL(url),'utf8');
 if(url.endsWith('/server/telegram-approvals.ts')){
  const original=loadedSource(),seam='this.offers.set(approval.id, offer);';
  if(!original.includes(seam))throw Error('Mirror offer observation seam unavailable');
  return {format:'module',source:stripTypeScriptTypes(original.replaceAll(seam,seam+"globalThis[Symbol.for('gnl.scenario.faults')].offered(offer);")),shortCircuit:true};
 }
 if(!url.endsWith('/server/decision/implementation.ts'))return result;
 let source=loadedSource();
 const replacements=[
  ["handles.set(handle,e);observe({type:'registered'","handles.set(handle,e);globalThis[Symbol.for('gnl.scenario.faults')].opened(e);observe({type:'registered'"],
  ["function observe(e:T.DecisionObservation){for(const fn of observers)try{fn(freeze(e));}catch{}}", "function observe(e:T.DecisionObservation){for(const fn of observers)try{fn(freeze(e));}catch{}globalThis[Symbol.for('gnl.scenario.faults')]?.observed(e);}"],
  ["export function installProvenanceReader(r:T.ProvenanceReader){reader=r;}","export function installProvenanceReader(r:T.ProvenanceReader){reader=globalThis[Symbol.for('gnl.scenario.faults')].reader(r);}"],
  ["export function installDecisionHost(h:T.DecisionHost):()=>void {", "export function installDecisionHost(h:T.DecisionHost):()=>void {globalThis[Symbol.for('gnl.scenario.faults')].host=h;globalThis[Symbol.for('gnl.scenario.faults')].reset=installDecisionHost;"],
  ["export function installEngineApprovalBuilder(builder:T.EngineApprovalBuilder):()=>void{", "export function installEngineApprovalBuilder(builder:T.EngineApprovalBuilder):()=>void{globalThis[Symbol.for('gnl.scenario.faults')].builder=builder;globalThis[Symbol.for('gnl.scenario.faults')].rebuild=installEngineApprovalBuilder;"],
  ["function capture(event:T.RequestOpenedEvent):void {", "function capture(event:T.RequestOpenedEvent):void {globalThis[Symbol.for('gnl.scenario.faults')].captureAgain=capture;globalThis[Symbol.for('gnl.scenario.faults')].captured(event);"],
 ];
 for(const [before,after]of replacements){if(!source.includes(before))throw Error('Scenario fault instrumentation seam unavailable');source=source.replace(before,after);}
 return {format:'module',source:stripTypeScriptTypes(source),shortCircuit:true};
}});
