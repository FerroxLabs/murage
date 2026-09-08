import { z } from "zod";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_PRESETS, parseProviderBank } from "../electron/provider-connections.mjs";
import { MODEL_CATALOG_REFRESH_MS } from "./model-catalog-refresh.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { ProviderCatalog, ProviderCatalogError, ProviderConnectionRecord, ProviderModel, ProviderPreset, PublicProviderConnection } from "../shared/provider-connections.ts";

const MAX_BYTES = 4 * 1024 * 1024, MAX_MODELS = 5000, CACHE_TTL = MODEL_CATALOG_REFRESH_MS;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const MEDIA = /(?:image|imagen|video|veo|embedding|embed-|whisper|transcrib|tts|audio|speech|realtime|moderation|dall-e|ocr)/i;
class CatalogFailure extends Error { readonly code: ProviderCatalogError; constructor(code: ProviderCatalogError) { super(code); this.code=code; } }
const messages: Record<ProviderCatalogError, string> = {
 unauthorized: "The provider rejected this key. Update the saved key.", forbidden: "This key cannot access the provider catalog.",
 "rate-limited": "The provider is limiting catalog requests. Try again later.", offline: "Could not reach the provider. The last saved catalog is retained.",
 "invalid-catalog": "The provider returned an invalid or oversized model catalog.", unavailable: "The provider catalog is unavailable. Try again later.",
 "connection-changed": "The connection changed while its catalog was loading. Refresh it again.",
};
function knownChat(preset: ProviderPreset, id: string, capabilities: Record<string, unknown>): boolean {
 if (MEDIA.test(id)) return false;
 if (preset === "anthropic") return /^claude-/.test(id);
 if (preset === "openai") return /^(gpt-[3456]|o[134](?:-|$)|chatgpt-)/.test(id);
 if (preset === "deepseek") return /^deepseek-(chat|reasoner|v\d)/.test(id);
 if (preset === "mistral") return capabilities.completion_chat === true;
 if (preset === "xai") return /^grok-/.test(id);
 if (preset === "groq") return /(?:^|\/)(llama|gemma|qwen|deepseek|gpt-oss|compound)/.test(id);
 if (preset === "flux") return /^flux-(auto|fast|standard|reasoning|pinned-)/.test(id) || /^(claude-|gpt-|grok-|deepseek-|qwen-|gemini-)/.test(id);
 return false;
}
export function normalizeProviderModels(connection: ProviderConnectionRecord, payload: unknown, updatedAt: number): ProviderModel[] {
 if (!object(payload) || !Array.isArray(payload.data) || payload.data.length > MAX_MODELS) throw new CatalogFailure("invalid-catalog");
 const models: ProviderModel[] = [], seen = new Set<string>();
 for (const row of payload.data) {
  if (!object(row) || typeof row.id !== "string" || !row.id || row.id.length > 200 || /[\x00-\x1f]/.test(row.id) || seen.has(row.id)) continue;
  if ([row.id,row.name,row.display_name].some(value=>typeof value==="string"&&value.includes(connection.key)))throw new CatalogFailure("invalid-catalog");
  seen.add(row.id);const capabilities=object(row.capabilities)?row.capabilities:{};
  const architecture=object(row.architecture)?row.architecture:{};
  const output=strings(architecture.output_modalities ?? row.output_modalities).filter(kind=>["text","image","video","audio","embedding"].includes(kind));
  const chat=!MEDIA.test(row.id) && (output.length ? output.includes("text") && !output.some(kind=>["image","video","audio","embedding"].includes(kind)) : knownChat(connection.preset,row.id,capabilities));
  const params=strings(row.supported_parameters), input=strings(architecture.input_modalities);
  const tools=typeof capabilities.function_calling==="boolean"?capabilities.function_calling:params.includes("tools")?true:undefined;
  const vision=typeof capabilities.vision==="boolean"?capabilities.vision:input.length?input.includes("image"):undefined;
  const reasoning=typeof capabilities.reasoning==="boolean"?capabilities.reasoning:params.includes("reasoning")?true:undefined;
  const model: ProviderModel={connectionId:connection.id,preset:connection.preset,id:row.id,label:typeof row.name==="string"?row.name.slice(0,160):typeof row.display_name==="string"?row.display_name.slice(0,160):row.id,enabled:row.active!==false,chatEligible:chat,capabilities:{chat,...(tools===undefined?{}:{tools}),...(vision===undefined?{}:{vision}),...(reasoning===undefined?{}:{reasoning})},outputModalities:output.length?output:chat?["text"]:["unknown"]};
  const context=finite(row.context_length ?? row.context_window ?? row.max_context_length ?? row.max_input_tokens);if(context && context<=10_000_000)model.contextWindow=context;
  if(connection.preset==="openrouter"&&object(row.pricing)) {
   const price=(value:unknown)=>{if(typeof value!=="string"&&typeof value!=="number")return undefined;const parsed=Number(value);return Number.isFinite(parsed)&&parsed>=0&&String(value).trim()!==""?parsed*1_000_000:undefined;};
   const inputPerMillion=price(row.pricing.prompt),outputPerMillion=price(row.pricing.completion);
   if(inputPerMillion!==undefined||outputPerMillion!==undefined)model.pricing={...(inputPerMillion===undefined?{}:{inputPerMillion}),...(outputPerMillion===undefined?{}:{outputPerMillion}),source:PROVIDER_PRESETS.openrouter.catalogUrl,updatedAt};
  }
  models.push(model);
 }
 return models;
}
const cachedModelSchema=z.object({connectionId:z.string().max(100),preset:z.string(),id:z.string().min(1).max(200),label:z.string().max(160),enabled:z.boolean(),chatEligible:z.boolean(),capabilities:z.object({chat:z.boolean(),vision:z.boolean().optional(),tools:z.boolean().optional(),reasoning:z.boolean().optional()}).strict(),outputModalities:z.array(z.string().max(30)).max(10),contextWindow:z.number().positive().max(10_000_000).optional(),pricing:z.object({inputPerMillion:z.number().nonnegative().finite().optional(),outputPerMillion:z.number().nonnegative().finite().optional(),source:z.string().max(200),updatedAt:z.number().nonnegative().finite()}).strict().optional()}).strict();
const cacheSchema=z.object({revision:z.string().max(100),catalog:z.object({connectionId:z.string().max(100),models:z.array(cachedModelSchema).max(MAX_MODELS),fetchedAt:z.number().nonnegative().finite().optional(),stale:z.boolean(),assurance:z.literal("catalog-only")}).strict()}).strict();
export interface LegacyProviderConnection extends ProviderConnectionRecord { legacy: true; managedIn: "engines" | "connections" | "images"; legacyError?: string }
interface Cached { revision: string; catalog: ProviderCatalog }
export class ProviderConnectionsService {
 private readonly cache=new Map<string,Cached>();
 private readonly pending=new Map<string,{revision:string;promise:Promise<ProviderCatalog>}>();
 private readonly attempted=new Map<string,{revision:string;at:number}>();
 private readonly listeners=new Set<(changedIds:string[])=>void|Promise<void>>();
 private readonly fetcher:typeof fetch;
 private readonly options:{readBank:()=>string|undefined;cacheDir:string;fetch?:typeof fetch;now?:()=>number;legacyConnections?:()=>LegacyProviderConnection[]};
 constructor(options:{readBank:()=>string|undefined;cacheDir:string;fetch?:typeof fetch;now?:()=>number;legacyConnections?:()=>LegacyProviderConnection[]}){this.options=options;this.fetcher=options.fetch??fetch;}
 isCurrent(id:string,revision:string){const current=this.resolve(id);return Boolean(current?.enabled&&current.revision===revision);}
 subscribe(callback:(changedIds:string[])=>void|Promise<void>){this.listeners.add(callback);return()=>{this.listeners.delete(callback);};}
 async changed(previousBank:string|undefined,nextBank:string){const before=parseProviderBank(previousBank),after=parseProviderBank(nextBank);const ids=[...new Set([...before.map(row=>row.id),...after.map(row=>row.id)])].filter(id=>before.find(row=>row.id===id)?.revision!==after.find(row=>row.id===id)?.revision);for(const id of ids)this.cache.delete(id);await Promise.all([...this.listeners].map(listener=>listener(ids)));}
 private now(){return this.options.now?.()??Date.now();}
 private records():Array<ProviderConnectionRecord|LegacyProviderConnection>{return [...(this.options.legacyConnections?.()??[]),...parseProviderBank(this.options.readBank())];}
 resolve(id:string){const found=this.records().find(row=>row.id===id);return found?{...PROVIDER_PRESETS[found.preset],...found}:null;}
 private readCache(connection:ProviderConnectionRecord):ProviderCatalog {
  if("legacyError" in connection && connection.legacyError)return{connectionId:connection.id,models:[],stale:false,assurance:"catalog-only",error:{code:"unavailable",message:String(connection.legacyError)}};
  if(!this.cache.has(connection.id))try{
    const file=join(this.options.cacheDir,connection.id+".json"),stat=lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>MAX_BYTES)throw new Error("invalid cache");
    const parsed=cacheSchema.safeParse(JSON.parse(readFileSync(file,"utf8")));
    if(!parsed.success)throw new Error("invalid cache");
    if(parsed.data.revision===connection.revision&&parsed.data.catalog.connectionId===connection.id&&parsed.data.catalog.models.every(model=>model.connectionId===connection.id&&model.preset===connection.preset))this.cache.set(connection.id,parsed.data as Cached);
  }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")this.cache.set(connection.id,{revision:connection.revision,catalog:{connectionId:connection.id,models:[],stale:false,assurance:"catalog-only",error:{code:"invalid-catalog",message:"The saved catalog is unreadable. Refresh this provider; its key is preserved."}}});}
  const cached=this.cache.get(connection.id);if(!cached||cached.revision!==connection.revision)return{connectionId:connection.id,models:[],stale:false,assurance:"catalog-only"};
  return{...cached.catalog,stale:cached.catalog.stale||!cached.catalog.fetchedAt||this.now()-cached.catalog.fetchedAt>CACHE_TTL};
 }
 getCatalog(id:string):ProviderCatalog {const connection=this.resolve(id);if(!connection)throw Object.assign(new Error("Model connection not found."),{status:404});return this.readCache(connection);}
 list():PublicProviderConnection[]{return this.records().map(connection=>{const preset=PROVIDER_PRESETS[connection.preset],catalog=this.readCache(connection);return{id:connection.id,preset:connection.preset,label:connection.label,enabled:connection.enabled,revision:connection.revision,baseUrl:preset.baseUrl,protocol:preset.protocol,configured:true,...("legacy" in connection?{legacy:true,managedIn:connection.managedIn}:{}),state:catalog.error?"needs-attention":catalog.fetchedAt?"catalog-ready":"saved",catalog};});}
 async refreshDue(signal?:AbortSignal):Promise<void>{
  for(const connection of this.records()){
   if(signal?.aborted)return;
   if(!connection.enabled)continue;
   const catalog=this.readCache(connection),attempt=this.attempted.get(connection.id);
   const attemptedAt=attempt?.revision===connection.revision?attempt.at:-Infinity;
   if(this.now()-Math.max(catalog.fetchedAt??-Infinity,attemptedAt)<MODEL_CATALOG_REFRESH_MS)continue;
   await this.refresh(connection.id,signal).catch(()=>{});
  }
 }
 async refresh(id:string,signal?:AbortSignal):Promise<ProviderCatalog>{
  const connection=this.resolve(id);if(!connection)throw Object.assign(new Error("Model connection not found."),{status:404});
  if(!connection.enabled)throw Object.assign(new Error("Enable this connection before refreshing models."),{status:409});
  const current=this.pending.get(id);if(current?.revision===connection.revision)return current.promise;
  this.attempted.set(id,{revision:connection.revision,at:this.now()});
  const entry={revision:connection.revision,promise:Promise.resolve(undefined as unknown as ProviderCatalog)};
  entry.promise=this.refreshCatalog(id,signal).finally(()=>{if(this.pending.get(id)===entry)this.pending.delete(id);});
  this.pending.set(id,entry);return entry.promise;
 }
 private async refreshCatalog(id:string,signal?:AbortSignal):Promise<ProviderCatalog>{
  const connection=this.resolve(id);if(!connection)throw Object.assign(new Error("Model connection not found."),{status:404});
  if(!connection.enabled)throw Object.assign(new Error("Enable this connection before refreshing models."),{status:409});
  const previous=this.readCache(connection),controllerSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(15_000)]):AbortSignal.timeout(15_000);
  const active=()=>{const current=this.resolve(id);if(!current||!current.enabled||current.revision!==connection.revision)throw new CatalogFailure("connection-changed");};
  try{
   const all:ProviderModel[]=[],seen=new Set<string>();let cursor:string|undefined;
   for(let page=0;page<20;page++){
    active();const url=new URL(connection.catalogUrl);if(cursor)url.searchParams.set("after_id",cursor);
    const headers:Record<string,string>=connection.preset==="anthropic"?{"x-api-key":connection.key,"anthropic-version":"2023-06-01"}:{authorization:`Bearer ${connection.key}`};
    const response=await this.fetcher(url.toString(),{headers,signal:controllerSignal,redirect:"error"});active();
    if(!response.ok){void response.body?.cancel();throw new CatalogFailure(response.status===401?"unauthorized":response.status===403?"forbidden":response.status===429?"rate-limited":"unavailable");}
    if(Number(response.headers.get("content-length")??0)>MAX_BYTES||!response.body){void response.body?.cancel();throw new CatalogFailure("invalid-catalog");}
    const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>MAX_BYTES){await reader.cancel();throw new CatalogFailure("invalid-catalog");}chunks.push(next.value);}}finally{reader.releaseLock();}
    let data:unknown;try{data=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new CatalogFailure("invalid-catalog");}
    active();for(const model of normalizeProviderModels(connection,data,this.now()))if(!seen.has(model.id)){seen.add(model.id);all.push(model);}
    if(all.length>MAX_MODELS)throw new CatalogFailure("invalid-catalog");
    if(connection.preset!=="anthropic"||!object(data)||data.has_more!==true){
     const catalog:ProviderCatalog={connectionId:id,models:all,fetchedAt:this.now(),stale:false,assurance:"catalog-only"};
     active();mkdirSync(this.options.cacheDir,{recursive:true,mode:0o700});writeFileAtomic(join(this.options.cacheDir,id+".json"),JSON.stringify({revision:connection.revision,catalog}),{mode:0o600});this.cache.set(id,{revision:connection.revision,catalog});return catalog;
    }
    if(typeof data.last_id!=="string"||!data.last_id||data.last_id.length>200||data.last_id===cursor)throw new CatalogFailure("invalid-catalog");cursor=data.last_id;
   }
   throw new CatalogFailure("invalid-catalog");
  }catch(error){const code=error instanceof CatalogFailure?error.code:"offline";const catalog:ProviderCatalog={...previous,stale:Boolean(previous.fetchedAt),error:{code,message:messages[code]},assurance:"catalog-only"};if(this.resolve(id)?.revision===connection.revision)this.cache.set(id,{revision:connection.revision,catalog});return catalog;}
 }
}
