import { createHash } from "node:crypto";
import type { ProviderConnectionsService } from "../provider-connections.ts";
import type { ProviderInstance } from "../contracts.ts";
import { fluxKey } from "../flux-config.ts";
import { FLUX_OPENAI_BASE } from "../flux-routing.ts";
import { fluxKeyMayCall } from "../flux-key-models.ts";
import { isCliLearningInstance } from "../drivers/cli-memory-learning.ts";
import { healthEngineKind } from "../health/engine-kind.ts";
import { isNetworkFailure, memoryExtractionMessages, requestMemoryExtraction, requestMemoryInference, requestMemoryGrounding, type MemoryExtractionDispatch, type TextOnlyExtractor } from "./extract.ts";
import { learningFolderScope } from "./learning-folder.ts";
import { ExtractionReplyError, FLUX_PINNED_LEARNING_MODEL } from "./extraction-outcomes.ts";

export const FLUX_EXTRACTORS = [
  { instanceId: "@murage/flux-fast", model: "flux-fast", label: "Flux Router · Fast" },
  { instanceId: "@murage/flux-standard", model: "flux-standard", label: "Flux Router · Standard" },
  { instanceId: "@murage/flux-auto", model: "flux-auto", label: "Flux Router · Auto" },
] as const;

/** A key the pinned model has failed for uses flux-fast for this long; a key on a plan without the pin is told so by each call otherwise. */
export const PIN_QUARANTINE_MS=6*60*60_000;
const PIN_MEMORY=128;
const pinQuarantine=new Map<string,number>();
let pinAnswered:string|null=null;
export function clearPinQuarantineForTests(){pinQuarantine.clear();}
function learningLine(line:string){try{console.info(`[memory] ${line}`);}catch{/* logging is best effort */}}
/** The pin is asked for only when the key's own Flux catalog lists it: a free-plan key (flux-fast and flux-auto only) and a key with
 *  no catalog yet never send it (FLUX-FREE-MODEL 1.0.18), and a refused pin rests for six hours as before. */
const pinOpen=(key:string)=>(pinQuarantine.get(keyRevision(key))??0)<=clock()&&fluxKeyMayCall(key,FLUX_PINNED_LEARNING_MODEL)==="yes";
function quarantinePin(key:string,label:string){
  if(pinQuarantine.size>=PIN_MEMORY)pinQuarantine.delete(pinQuarantine.keys().next().value!);
  pinQuarantine.set(keyRevision(key),clock()+PIN_QUARANTINE_MS);
  try{console.warn(`[memory] learning model refused: status=${label} fallback=flux-fast for=6h`);}catch{/* logging is best effort */}
}
/** What says the pin itself is at fault, and not the network, the key, the pace, the caller, or this one slice's words. */
function pinFault(error:unknown,signal:AbortSignal){
  const status=Number((error as {status?:unknown}).status);
  if(isNetworkFailure(error)||status===401||status===429)return false;
  if(signal.aborted&&(signal.reason as {name?:string}|undefined)?.name!=="TimeoutError")return false;
  if(error instanceof ExtractionReplyError)return error.reason!=="refusal"&&(error.reason!=="cut-off"||error.detail==="no-text");
  return true;
}
/** The learning model for flux-fast: extraction and support checks ask for the pin. A key that cannot call it is told so by a 400, 403 or 404 before
 * any reply exists, and the same call runs on flux-fast, charged once, with no attempt used; any other fault of the pin counts as that failure always
 * did, and the next call goes to flux-fast. So a dead pin can cost a key one attempt in six hours and is otherwise today's path. Every call logs its arm. */
/** The call's one gate (learning-send.ts) rides inside `invoke` to the physical fetch (extract.ts requestMemoryTransport), which is its
 *  only `send`: the pin and the fallback after a refused pin are two releases of the same gate, and the fallback, a second send of the
 *  same words after a wait, is checked again there, so a Forget that committed meanwhile drops it. Nothing here sends (r8 Change 4). */
export async function pinnedCall<T>(base:string,key:string,purpose:"extraction"|"grounding",signal:AbortSignal,invoke:(model:string)=>Promise<T>):Promise<T>{
  pinAnswered=null;
  if(base!=="flux-fast")return invoke(base);
  const fast=async()=>{const reply=await invoke(base);learningLine(`learning call: purpose=${purpose} arm=fast`);return reply;};
  if(!pinOpen(key))return fast();
  try{const reply=await invoke(FLUX_PINNED_LEARNING_MODEL);learningLine(`learning call: purpose=${purpose} arm=pinned`);pinAnswered=key;return reply;}
  catch(error){
    const status=Number((error as {status?:unknown}).status);
    if([400,403,404].includes(status)){quarantinePin(key,String(status));return fast();}
    if(pinFault(error,signal))quarantinePin(key,Number.isFinite(status)?String(status):"reply");
    throw error;
  }
}
/** A pin reply that arrived and then would not parse is a fault of the pin like any other: the attempt counts as it always did, the next call goes to
 * flux-fast. Learning and support calls hold one slot, so the last pin call is the one whose reply this is. */
export function pinReplyUnusable(error:unknown,signal:AbortSignal){
  const key=pinAnswered;pinAnswered=null;
  if(key&&pinFault(error,signal))quarantinePin(key,"reply");
}
const learningModelFor=(model:string,key:string|null)=>model==="flux-fast"&&key&&pinOpen(key)?FLUX_PINNED_LEARNING_MODEL:model;

/** Discover callable, tool-free connections; native CLI authentication is not enough. */
const instanceRow=(instance:ProviderInstance)=>({instanceId:instance.instanceId,label:instance.displayName??instance.driverKind,eligible:instance.enabled&&typeof instance.extractMemory==="function",...(!instance.enabled||!instance.extractMemory?{reason:"This connection does not provide text-only learning."}:{})});
export function memoryExtractorConnections(instances: ProviderInstance[], key: string | null = fluxKey(), providerConnections?: Pick<ProviderConnectionsService,"list"|"resolve"|"getCatalog">) {
  const providers=(providerConnections?.list()??[]).filter(connection=>connection.preset!=="flux"&&!(connection.legacy&&connection.managedIn==="engines"&&instances.some(instance=>connection.id==="legacy-openai-compatible"&&instance.driverKind==="openai-compat"||connection.id==="legacy-xai"&&instance.driverKind==="grokAgent"&&Boolean(instance.extractMemory))));
  return [
    ...FLUX_EXTRACTORS.map(({ instanceId, label }) => ({
      instanceId, label, eligible: Boolean(key),
      ...(!key ? { reason: "Add your Flux Router key in app settings." } : {}),
    })),
    ...instances.filter(instance=>!isCliLearningInstance(instance)).map(instanceRow),
    ...providers.map(connection=>({instanceId:`provider:${connection.id}`,label:connection.label,
      eligible:connection.enabled&&connection.protocol==="openai"&&Boolean(providerModel(providerConnections!,connection.id)),
      ...(!connection.enabled?{reason:"Enable this connection in Settings."}:connection.protocol!=="openai"?{reason:"This connection does not provide text-only learning."}:!providerModel(providerConnections!,connection.id)?{reason:"Refresh this connection's chat models in Settings."}:{})})),
    // Signed-in CLI and ACP engines come last: they spend the person's own subscription limit (design r2.10).
    ...instances.filter(isCliLearningInstance).map(instanceRow),
  ];
}

export function resolveMemoryExtractor(
  selected: string | null,
  instances: ProviderInstance[],
  readKey: () => string | null = fluxKey,
): TextOnlyExtractor | null {
  if (!selected) return null;
  const flux = FLUX_EXTRACTORS.find(item => item.instanceId === selected);
  if (flux) {
    if (!readKey()) return null;
    const extract:TextOnlyExtractor = (text, maximumOutputTokens, signal, dispatch) => {
      // Resolve again at dispatch so a revoked/replaced key never survives in a closure.
      const key = readKey();
      if (!key) throw new Error("MEMORY_EXTRACTOR_UNAVAILABLE");
      const config={url:FLUX_OPENAI_BASE,apiKey:key,model:flux.model};
      return dispatch?.purpose ? requestMemoryInference(config,text,maximumOutputTokens,signal,dispatch)
        : pinnedCall(flux.model,key,"extraction",signal,model=>requestMemoryExtraction({...config,model},text,maximumOutputTokens,signal,dispatch?.messages,dispatch?.fence));
    };
    extract.ground=(input,maximumOutputTokens,signal,fence)=>{
      const key=readKey();if(!key)throw new Error("MEMORY_EXTRACTOR_UNAVAILABLE");
      return pinnedCall(flux.model,key,"grounding",signal,model=>requestMemoryGrounding({url:FLUX_OPENAI_BASE,apiKey:key,model},input,Math.min(64,maximumOutputTokens),signal,fence));
    };
    extract.pinReplyUnusable=pinReplyUnusable;extract.learningConnection=selected;extract.learningModel=()=>learningModelFor(flux.model,readKey());extract.healthEngine="gateway";
    return extract;
  }
  const instance = instances.find(item => item.enabled && item.instanceId === selected);
  if(!instance?.extractMemory)return null;
  const extract:TextOnlyExtractor=instance.extractMemory.bind(instance);
  if(instance.groundMemory)extract.ground=(input,maximum,signal,fence)=>instance.groundMemory!(input,Math.min(64,maximum),signal,fence);
  extract.learningConnection=selected;extract.learningModel=()=>instance.models?.default;extract.healthEngine=healthEngineKind(instance.driverKind);
  return extract;
}

type Connections=Pick<ProviderConnectionsService,"list"|"resolve"|"getCatalog">;
function providerModel(service:Connections,id:string){try{return service.getCatalog(id).models.filter(model=>model.enabled&&model.chatEligible).sort((a,b)=>a.id.localeCompare(b.id))[0]?.id;}catch{return undefined;}}
const refused=new Map<string,string>();
const refusedInstances=new WeakSet<ProviderInstance>();
const attention="Learning is paused: the connection was refused. Check your key in Settings.";
const engineAttention="Learning is paused: the engine asked you to sign in again.";
/** A signed-in engine at its limit: learning waits, then tries again (the engine's own limit resets on its own). */
export const ENGINE_LIMIT_PAUSE_MS=15*60_000;
const limitedUntil=new WeakMap<ProviderInstance,number>();
let clock=()=>Date.now();
export function setLearningClockForTests(now:(()=>number)|null){clock=now??(()=>Date.now());}
const limitLine=(label:string)=>`Learning waits while ${label} is at its limit.`;
const atLimit=(instance:ProviderInstance)=>(limitedUntil.get(instance)??0)>clock();
const keyRevision=(key:string)=>createHash("sha256").update(key).digest("hex");
export interface LearningConnection {extractor:TextOnlyExtractor|null;instanceId:string|null;source:"chosen"|"default"|"none";label:string;reason?:string;suggestion?:{instanceId:string;label:string};reviewOnly?:boolean}
export function resolveLearningConnection(input:{selected:string|null;instances:ProviderInstance[];readInstances?:()=>ProviderInstance[];providerConnections?:Connections;readKey?:()=>string|null;defaultOn:boolean;folder?:()=>string|undefined}):LearningConnection {
 const readKey=input.readKey??fluxKey,key=readKey(),items=memoryExtractorConnections(input.instances,key,input.providerConnections);
 const selected=input.selected??(key?"@murage/flux-fast":null),item=items.find(row=>row.instanceId===selected);
 const own=items.filter(row=>row.eligible&&!row.instanceId.startsWith("@murage/"));
 const none=(reason:string):LearningConnection=>({extractor:null,instanceId:selected,source:"none",label:item?.label??selected??"No connection",reason,...(!input.selected&&own.length>0&&(own.length===1||!key)?{suggestion:{instanceId:own[0].instanceId,label:own[0].label}}:{})});
 if(!selected)return none("Add your Flux key or choose a connection.");
 if(!item?.eligible)return none(`${item?.label??selected}: ${item?.reason??"This connection is unavailable."}`);
 const providerId=selected.startsWith("provider:")?selected.slice(9):null;
 const credentials=()=>{
  if(providerId){const row=input.providerConnections?.resolve(providerId);if(!row?.enabled||row.preset==="flux"||row.protocol!=="openai"||!row.key||!providerModel(input.providerConnections!,providerId))throw Error("MEMORY_EXTRACTOR_UNAVAILABLE");return {url:row.baseUrl,apiKey:row.key,model:providerModel(input.providerConnections!,providerId)??"",revision:row.revision+":"+keyRevision(row.key)};}
  const key=readKey();if(!key)throw Error("MEMORY_EXTRACTOR_UNAVAILABLE");return {url:FLUX_OPENAI_BASE,apiKey:key,model:FLUX_EXTRACTORS.find(row=>row.instanceId===selected)!.model,revision:keyRevision(key)};
 };
 let extractor:TextOnlyExtractor|null;
 if(providerId||selected.startsWith("@murage/")){
  let current:ReturnType<typeof credentials>;
  try{current=credentials();}catch{return none(`${item.label}: This connection is unavailable. Check it in Settings.`);}
  if(refused.get(selected)===current.revision)return none(attention);
  const call=async<T>(invoke:(config:ReturnType<typeof credentials>)=>Promise<T>)=>{
   const config=credentials();if(refused.get(selected)===config.revision)throw Error("MEMORY_EXTRACTOR_UNAVAILABLE");
   try{return await invoke(config);}catch(error){if([401,403].includes(Number((error as {status?:number}).status))){if(refused.size>=128)refused.delete(refused.keys().next().value!);refused.set(selected,config.revision);}throw error;}
  };
  // inside `call`: a refused pin must not read as a refused connection
  // the gate rides inside invoke to the fetch; neither arm sends here
  const pin=<T>(config:ReturnType<typeof credentials>,purpose:"extraction"|"grounding",signal:AbortSignal,invoke:(model:string)=>Promise<T>)=>providerId?invoke(config.model):pinnedCall(config.model,config.apiKey,purpose,signal,invoke);
  extractor=(text,maximum,signal,dispatch)=>call(config=>dispatch?.purpose?requestMemoryInference(config,text,maximum,signal,dispatch):pin(config,"extraction",signal,model=>requestMemoryExtraction({...config,model},text,maximum,signal,dispatch?.messages,dispatch?.fence)));
  extractor.ground=(value,maximum,signal,fence)=>call(config=>pin(config,"grounding",signal,model=>requestMemoryGrounding({...config,model},value,Math.min(64,maximum),signal,fence)));
  if(!providerId)extractor.pinReplyUnusable=pinReplyUnusable;
  extractor.learningModel=()=>{if(providerId)return providerModel(input.providerConnections!,providerId);const model=FLUX_EXTRACTORS.find(row=>row.instanceId===selected)?.model;return model&&learningModelFor(model,readKey());};
  // the transport that answers, by what was chosen: Flux Router is the gateway, an own OpenAI-compatible connection is openai-chat
  extractor.healthEngine=providerId?"openai-chat":"gateway";
 }else{
  const current=()=> (input.readInstances?.()??input.instances).find(item=>item.instanceId===selected&&item.enabled&&item.extractMemory);
  const initial=current();if(!initial||refusedInstances.has(initial))return none(initial?(isCliLearningInstance(initial)?engineAttention:attention):`${item.label}: This connection is unavailable.`);
  if(atLimit(initial))return none(limitLine(item.label));
  const call=async<T>(invoke:(instance:ProviderInstance)=>Promise<T>)=>{const instance=current();if(!instance||refusedInstances.has(instance)||atLimit(instance))throw Error("MEMORY_EXTRACTOR_UNAVAILABLE");try{return await invoke(instance);}catch(error){const failed=error as {status?:number;limit?:boolean};if([401,403].includes(Number(failed.status)))refusedInstances.add(instance);else if(isCliLearningInstance(instance)&&(failed.limit===true||Number(failed.status)===429))limitedUntil.set(instance,clock()+ENGINE_LIMIT_PAUSE_MS);throw error;}};
  // A signed-in CLI or ACP engine runs learning as a hidden turn, and a turn cannot start without a bot folder (botFolderOrThrow, no
  // default). The host names that folder here, once: a dispatch that carries its own keeps it. No folder resolved: nothing is supplied
  // and the engine refuses, as before.
  // A scope opened by a caller that knows the source bot wins, even when it holds no folder (never borrow another bot's); the host default is last.
  const folderFor=(instance:ProviderInstance)=>{if(!isCliLearningInstance(instance))return undefined;const scoped=learningFolderScope();return scoped?scoped.cwd:input.folder?.();};
  extractor=(text,max,signal,dispatch)=>call(instance=>{
   const cwd=dispatch?.cwd===undefined?folderFor(instance):undefined;
   const sent:MemoryExtractionDispatch|undefined=cwd===undefined?dispatch:{policyRevision:"learning",messages:memoryExtractionMessages(text),...dispatch,cwd};
   return instance.extractMemory!(text,max,signal,sent);
  });
  extractor.learningModel=()=>current()?.models?.default;
  extractor.healthEngine=healthEngineKind(initial.driverKind);
  if(initial.groundMemory)extractor.ground=(value,maximum,signal,fence)=>call(instance=>{if(!instance.groundMemory)throw Error("MEMORY_EXTRACTOR_UNAVAILABLE");const cwd=folderFor(instance),limit=Math.min(64,maximum);return cwd===undefined?instance.groundMemory(value,limit,signal,fence):instance.groundMemory(value,limit,signal,fence,cwd);});
 }
 if(!extractor)return none(`${item.label}: This connection is unavailable.`);
 extractor.learningConnection=selected;extractor.reviewOnly=!input.selected&&!input.defaultOn;
 return {extractor,instanceId:selected,source:input.selected?"chosen":"default",label:item.label,reviewOnly:!input.selected&&!input.defaultOn};
}
/** The learning default (SETTINGS-REDESIGN r3.3): on when a Flux key is present; an explicit `learningDefaultOn`, true or false, wins (`??`). */
export function learningDefaultOnFor(features:{learningDefaultOn?:boolean}|undefined,fluxKeyPresent:boolean):boolean{return features?.learningDefaultOn??fluxKeyPresent;}
