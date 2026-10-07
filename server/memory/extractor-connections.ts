import { createHash } from "node:crypto";
import type { ProviderConnectionsService } from "../provider-connections.ts";
import type { ProviderInstance } from "../contracts.ts";
import { fluxKey } from "../flux-config.ts";
import { FLUX_OPENAI_BASE } from "../flux-routing.ts";
import { requestMemoryExtraction, requestMemoryInference, requestMemoryGrounding, type TextOnlyExtractor } from "./extract.ts";

const FLUX_EXTRACTORS = [
  { instanceId: "@murage/flux-fast", model: "flux-fast", label: "Flux Router · Fast" },
  { instanceId: "@murage/flux-standard", model: "flux-standard", label: "Flux Router · Standard" },
  { instanceId: "@murage/flux-auto", model: "flux-auto", label: "Flux Router · Auto" },
] as const;

/** Discover callable, tool-free connections; native CLI authentication is not enough. */
export function memoryExtractorConnections(instances: ProviderInstance[], key: string | null = fluxKey(), providerConnections?: Pick<ProviderConnectionsService,"list"|"resolve"|"getCatalog">) {
  const providers=(providerConnections?.list()??[]).filter(connection=>connection.preset!=="flux"&&!(connection.legacy&&connection.managedIn==="engines"&&instances.some(instance=>connection.id==="legacy-openai-compatible"&&instance.driverKind==="openai-compat"||connection.id==="legacy-xai"&&instance.driverKind==="grokAgent"&&Boolean(instance.extractMemory))));
  return [
    ...FLUX_EXTRACTORS.map(({ instanceId, label }) => ({
      instanceId, label, eligible: Boolean(key),
      ...(!key ? { reason: "Add your Flux Router key in app settings." } : {}),
    })),
    ...instances.map(instance => ({instanceId:instance.instanceId,label:instance.displayName??instance.driverKind,eligible:instance.enabled&&typeof instance.extractMemory==="function",...(!instance.enabled||!instance.extractMemory?{reason:"This connection does not provide text-only learning."}:{})})),
    ...providers.map(connection=>({instanceId:`provider:${connection.id}`,label:connection.label,
      eligible:connection.enabled&&connection.protocol==="openai"&&Boolean(providerModel(providerConnections!,connection.id)),
      ...(!connection.enabled?{reason:"Enable this connection in Settings."}:connection.protocol!=="openai"?{reason:"This connection does not provide text-only learning."}:!providerModel(providerConnections!,connection.id)?{reason:"Refresh this connection's chat models in Settings."}:{})})),
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
        : requestMemoryExtraction(config,text,maximumOutputTokens,signal,dispatch?.messages);
    };
    extract.ground=(input,maximumOutputTokens,signal)=>{
      const key=readKey();if(!key)throw new Error("MEMORY_EXTRACTOR_UNAVAILABLE");
      return requestMemoryGrounding({url:FLUX_OPENAI_BASE,apiKey:key,model:flux.model},input,Math.min(64,maximumOutputTokens),signal);
    };
    return extract;
  }
  const instance = instances.find(item => item.enabled && item.instanceId === selected);
  if(!instance?.extractMemory)return null;
  const extract:TextOnlyExtractor=instance.extractMemory.bind(instance);
  if(instance.groundMemory)extract.ground=(input,maximum,signal)=>instance.groundMemory!(input,Math.min(64,maximum),signal);
  return extract;
}

type Connections=Pick<ProviderConnectionsService,"list"|"resolve"|"getCatalog">;
function providerModel(service:Connections,id:string){try{return service.getCatalog(id).models.filter(model=>model.enabled&&model.chatEligible).sort((a,b)=>a.id.localeCompare(b.id))[0]?.id;}catch{return undefined;}}
const refused=new Map<string,string>();
const refusedInstances=new WeakSet<ProviderInstance>();
const attention="Learning is paused: the connection was refused. Check your key in Settings.";
const keyRevision=(key:string)=>createHash("sha256").update(key).digest("hex");
export interface LearningConnection {extractor:TextOnlyExtractor|null;instanceId:string|null;source:"chosen"|"default"|"none";label:string;reason?:string;suggestion?:{instanceId:string;label:string};reviewOnly?:boolean}
export function resolveLearningConnection(input:{selected:string|null;instances:ProviderInstance[];readInstances?:()=>ProviderInstance[];providerConnections?:Connections;readKey?:()=>string|null;defaultOn:boolean}):LearningConnection {
 const readKey=input.readKey??fluxKey,key=readKey(),items=memoryExtractorConnections(input.instances,key,input.providerConnections);
 const selected=input.selected??(key?"@murage/flux-fast":null),item=items.find(row=>row.instanceId===selected);
 const own=items.filter(row=>row.eligible&&!row.instanceId.startsWith("@murage/"));
 const none=(reason:string):LearningConnection=>({extractor:null,instanceId:selected,source:"none",label:item?.label??selected??"No connection",reason,...(!input.selected&&own.length===1?{suggestion:{instanceId:own[0].instanceId,label:own[0].label}}:{})});
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
  extractor=(text,maximum,signal,dispatch)=>call(config=>dispatch?.purpose?requestMemoryInference(config,text,maximum,signal,dispatch):requestMemoryExtraction(config,text,maximum,signal,dispatch?.messages));
  extractor.ground=(value,maximum,signal)=>call(config=>requestMemoryGrounding(config,value,Math.min(64,maximum),signal));
 }else{
  const current=()=> (input.readInstances?.()??input.instances).find(item=>item.instanceId===selected&&item.enabled&&item.extractMemory);
  const initial=current();if(!initial||refusedInstances.has(initial))return none(initial?attention:`${item.label}: This connection is unavailable.`);
  const call=async<T>(invoke:(instance:ProviderInstance)=>Promise<T>)=>{const instance=current();if(!instance||refusedInstances.has(instance))throw Error("MEMORY_EXTRACTOR_UNAVAILABLE");try{return await invoke(instance);}catch(error){if([401,403].includes(Number((error as {status?:number}).status)))refusedInstances.add(instance);throw error;}};
  extractor=(text,max,signal,dispatch)=>call(instance=>instance.extractMemory!(text,max,signal,dispatch));
  if(initial.groundMemory)extractor.ground=(value,maximum,signal)=>call(instance=>{if(!instance.groundMemory)throw Error("MEMORY_EXTRACTOR_UNAVAILABLE");return instance.groundMemory(value,Math.min(64,maximum),signal);});
 }
 if(!extractor)return none(`${item.label}: This connection is unavailable.`);
 extractor.learningConnection=selected;extractor.reviewOnly=!input.selected&&!input.defaultOn;
 return {extractor,instanceId:selected,source:input.selected?"chosen":"default",label:item.label,reviewOnly:!input.selected&&!input.defaultOn};
}
