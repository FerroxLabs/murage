// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { beginRequestSchema, beginResponseSchema, completeRequestSchema, runtimeBindingSchema, FLOW_LIFETIME_MS, PROVIDER_AUTHORIZATION_URL, grantedScopesSchema, grantMetadataSchema } from "./contracts.ts";
import type { RuntimeBinding } from "./contracts.ts";
import { sameBinding, matchesCapability, requestBytes, RUNTIME_HEADER, expiryKey, legacyPage, STORAGE_PAGE_SIZE } from "./runtime-auth.ts";
import type { BrokerStorage, BrokerTxn, RequestRuntimeVerifier } from "./runtime-auth.ts";
import { encode64, decode64, hkdf, sha256, createHeldRecipient, sealHeld, openHeld, capabilitySealer } from "./seal.ts";
import { homeRouteTag, decodeHex } from "./route.ts";
import { HIGHLEVEL_CRM_SCOPES } from "../../../server/highlevel/provider-contract.ts";
import type { OAuthCredentials } from "./oauth.ts";
import type { EnrollmentStore } from "./runtime-auth.ts";
import type { Sealer } from "./seal.ts";
import { GrantStoreFailure } from "./grant.ts";
import type { GrantWriter } from "./grant.ts";
import type { OAuthGrant, OAuthResult } from "./oauth.ts";
const id = z.string().min(1).max(180).regex(/^[A-Za-z0-9_-]+$/u), secret = z.string().min(1).max(8192);
export const flowPreviewSchema = z.discriminatedUnion("status", [z.strictObject({ status: z.literal("pending") }),
  z.strictObject({ status: z.literal("denied") }), z.strictObject({ status: z.literal("held"), locationId: id,
    locationName: z.string().min(1).max(200), scopes: grantedScopesSchema, missing: z.array(z.string()).max(64) })]);
export const completeResponseSchema = z.strictObject({ grant: grantMetadataSchema, enrollmentId: id,
  runtimeCapability: secret.nullable(), grantCapability: secret });
export type BrokerErrorCode = "invalid_request" | "unauthorized" | "not_found" | "conflict" | "flow_pending" | "flow_denied"
  | "flow_expired" | "location_mismatch" | "grant_changed" | "grant_revoked" | "reconnect_required" | "rate_limited" | "unavailable";
export type FlowStatus = "begun" | "called_back" | "completing" | "denied" | "completed" | "expired";
export interface FlowRecord {
  flowId: string; lookupHash: string; binding: RuntimeBinding; enroll: "new" | "existing"; beginEpoch: number;
  generation: number; capHash: string; status: FlowStatus; createdAt: number; expiresAt: number;
  recipientPublic: string; recipientPrivateSealed: string;
  completionIntent?: string; heldSealed?: string; completedResult?: string;
}
export interface FlowStore {
  put(rec: FlowRecord): Promise<void>;
  byLookup(h: string): Promise<FlowRecord | null>;
  byFlowId(id: string): Promise<FlowRecord | null>;
  cas(id: string, from: FlowStatus, next: FlowRecord): Promise<boolean>;
  /** Atomic home-generation and per-principal open-flow admission. */
  admit?(rec: FlowRecord, now: number): Promise<boolean>;
  homeGeneration?(homeId: string): Promise<number>;
  previewAllowed?(flowId: string, now: number): Promise<boolean>;
}
export interface FlowDeps {
  flows: FlowStore; enrollments: EnrollmentStore; grants: GrantWriter; verifier: RequestRuntimeVerifier;
  oauth: (g: OAuthGrant) => Promise<OAuthResult>; master: Sealer; now(): number; random(n: number): Uint8Array; origin: string;
  clientId?: string; stagingOrigin?: string; routeMaster: Uint8Array;
  ipAdmission?(ipHash: string, now: number): Promise<boolean>;
  locationFetch?: typeof fetch;
}
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", {fatal:true});
const headers = { "cache-control":"no-store", "referrer-policy":"no-referrer" };
const statuses: Record<BrokerErrorCode, number> = {invalid_request:400,unauthorized:401,not_found:404,conflict:409,flow_pending:409,flow_denied:409,
  flow_expired:410,location_mismatch:409,grant_changed:409,grant_revoked:410,reconnect_required:409,rate_limited:429,unavailable:503};
const fail = (code: BrokerErrorCode) => Response.json({code},{status:statuses[code],headers});
const json = (body: unknown,status=200) => Response.json(body,{status,headers});
function allowedOrigin(d: FlowDeps): boolean {
  try {const u=new URL(d.origin); return u.origin===d.origin && u.protocol==="https:" && !u.username && !u.password &&
    (d.origin==="https://connect.murage.ai" || d.origin===d.stagingOrigin);} catch{return false;}
}
function validRoute(req: Request,d: FlowDeps,route: string,method: string): boolean {
  const u=new URL(req.url); return allowedOrigin(d) && u.origin===d.origin && u.pathname===route && req.method===method;
}
async function body(req: Request): Promise<unknown> {const bytes=await requestBytes(req.clone()); return bytes ? JSON.parse(decoder.decode(bytes)) : null;}
async function expire(rec: FlowRecord,d: FlowDeps): Promise<void> {
  const next={...rec,status:"expired" as const,recipientPublic:"",recipientPrivateSealed:""};
  delete next.heldSealed; Reflect.deleteProperty(next,"heldPreview"); delete next.completedResult; delete next.completionIntent;
  await d.flows.cas(rec.flowId,rec.status,next);
}
/** RED/worker faults are projected to closed codes; exceptions never escape with secrets. */
export async function beginFlow(req: Request,d: FlowDeps): Promise<Response> {
  try {
    if(!validRoute(req,d,"/v1/crm/begin","POST")) return fail("invalid_request");
    const authenticated=req.headers.has(RUNTIME_HEADER)?await d.verifier.verifyRequest(req,"/v1/crm/begin"):null;
    if(req.headers.has(RUNTIME_HEADER) && !authenticated)return fail("unauthorized");
    const parsed=beginRequestSchema.safeParse(authenticated?JSON.parse(decoder.decode(authenticated.body)):await body(req)); if(!parsed.success || !d.clientId || !/^[A-Za-z0-9_-]{1,256}$/u.test(d.clientId)) return fail("invalid_request");
    const input=parsed.data;
    if(input.runtimePrincipalId!==input.homeId || input.runtimePrincipalId!==input.installationId || input.contentOwnerId!=="owner") return fail("invalid_request");
    const existing=await d.enrollments.get(input.runtimePrincipalId);
    if(existing || req.headers.has(RUNTIME_HEADER)) {if(!authenticated) return fail("unauthorized"); if(!sameBinding(authenticated.binding,input)) return fail("not_found");}
    const binding=runtimeBindingSchema.parse({runtimePrincipalId:input.runtimePrincipalId,installationId:input.installationId,homeId:input.homeId,contentOwnerId:input.contentOwnerId});
    const flowId=encode64(d.random(16)), state=encode64(new Uint8Array([...decodeHex(await homeRouteTag(d.routeMaster,binding.homeId)),...d.random(32)])), capability=encode64(d.random(32)), now=d.now();
    const rec: FlowRecord={flowId,lookupHash:Array.from(await hkdf(decode64(state),"lookup"),b=>b.toString(16).padStart(2,"0")).join(""),
      binding,generation:await d.flows.homeGeneration?.(binding.homeId) ?? 1,enroll:existing?"existing":"new",beginEpoch:input.connectionEpoch,capHash:await sha256(capability),status:"begun",createdAt:now,expiresAt:now+FLOW_LIFETIME_MS,
      ...await createHeldRecipient(capability,flowId)};
    // Admission is mandatory in production. An adapter that lacks it fails closed.
    if(!authenticated){let admitted=false;try{admitted=await d.ipAdmission?.(await sha256(req.headers.get("cf-connecting-ip") ?? "unknown"),now) ?? false;}catch{/* admission refuses on storage failure */}
      if(!admitted)return fail("rate_limited");}
    if(!d.flows.admit || !await d.flows.admit(rec,now)) return fail("rate_limited");
    const url=new URL(PROVIDER_AUTHORIZATION_URL); url.search=new URLSearchParams({response_type:"code",client_id:d.clientId,redirect_uri:`${d.origin}/v1/crm/callback`,scope:HIGHLEVEL_CRM_SCOPES.join(" "),state}).toString();
    return json(beginResponseSchema.parse({flowId,authorizationUrl:url.toString(),completionCapability:capability,expiresAt:rec.expiresAt}),201);
  } catch {return fail("unavailable");}
}
/** The only display-name read: one scope-admitted, fixed-origin call. A race
 * bounds even transports that ignore abort; no failure is ever retried. */
async function locationDisplayName(c:OAuthCredentials,d:FlowDeps):Promise<string>{
  if(!c.scopes.includes("locations.readonly"))return c.locationId;
  const controller=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<string>(resolve=>{timer=setTimeout(()=>{controller.abort();void reader?.cancel().catch(()=>{});resolve(c.locationId);},10_000);});
  const perform=async()=>{
    try{
      const response=await (d.locationFetch ?? fetch)(`https://services.leadconnectorhq.com/locations/${encodeURIComponent(c.locationId)}`,{
        method:"GET",redirect:"error",signal:controller.signal,headers:{Authorization:`Bearer ${c.accessToken}`,Version:"2021-07-28",accept:"application/json"}});
      if(controller.signal.aborted || response.status!==200 || !response.body || Number(response.headers.get("content-length") ?? 0)>65536){void response.body?.cancel().catch(()=>{});return c.locationId;}
      reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0,reads=0;
      while(true){if(++reads>65536)return c.locationId;const next=await reader.read();if(controller.signal.aborted)return c.locationId;if(next.done)break;
        size+=next.value.length;if(size>65536)return c.locationId;chunks.push(next.value);}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      const raw:unknown=JSON.parse(decoder.decode(bytes));if(!raw || typeof raw!=="object")return c.locationId;
      const loc=(raw as {location?:unknown}).location;if(!loc || typeof loc!=="object")return c.locationId;
      const location=loc as {id?:unknown;name?:unknown};if(location.id!==undefined && location.id!==c.locationId)return c.locationId;
      if(typeof location.name!=="string")return c.locationId;
      const name=location.name.replace(/[\u0000-\u001f\u007f-\u009f]/gu,"").trim();return name.length>=1 && name.length<=200?name:c.locationId;
    }catch{return c.locationId;}
    finally{void reader?.cancel().catch(()=>{});}
  };
  try{return await Promise.race([perform(),timeout]);}finally{if(timer!==undefined)clearTimeout(timer);}
}

const callbackPage=(status: "pending"|"denied"|"expired"="pending",httpStatus=200)=>new Response(`<!doctype html><meta charset="utf-8"><title>HighLevel</title><p>${status==="expired"?"This link has expired. Go back to Murage and connect again.":status==="denied"?"HighLevel was not connected. Go back to Murage to try again.":"HighLevel authorization is ready. Go back to Murage to confirm."}</p>`,
  {status:httpStatus,headers:{...headers,"content-type":"text/html; charset=utf-8","content-security-policy":"default-src 'none'; frame-ancestors 'none'","x-content-type-options":"nosniff"}});
export async function callbackFlow(req: Request,d: FlowDeps): Promise<Response> {
  try {
    if(!validRoute(req,d,"/v1/crm/callback","GET")) return fail("invalid_request");
    const query=new URL(req.url).searchParams, state=query.get("state"); if(!state || !/^[A-Za-z0-9_-]{64}$/u.test(state)) return callbackPage("expired",404);
    const hash=Array.from(await hkdf(decode64(state),"lookup"),b=>b.toString(16).padStart(2,"0")).join("");
    const rec=await d.flows.byLookup(hash); if(!rec) return callbackPage("expired",404);
    if(d.now()>=rec.expiresAt || rec.status==="expired" || (d.flows.homeGeneration && await d.flows.homeGeneration(rec.binding.homeId)!==rec.generation)) {await expire(rec,d);return callbackPage("expired",410);}
    if(rec.status!=="begun") return callbackPage(rec.status==="denied"?"denied":"pending");
    // Reserve before external exchange. An uncertain or crashed exchange is never resent.
    if(!await d.flows.cas(rec.flowId,"begun",{...rec,status:"called_back"})) return callbackPage();
    const code=query.get("code");
    if(query.has("error") || !code || code.length>1024) {await d.flows.cas(rec.flowId,"called_back",{...rec,status:"denied"});return callbackPage("denied");}
    let result: OAuthResult; try { result=await d.oauth({kind:"code",code}); } catch {result={kind:"error",error:"exchange_failed"};}
    if(d.now()>=rec.expiresAt) {await expire({...rec,status:"called_back"},d);return callbackPage("expired",410);}
    if(result.kind!=="ok") {await d.flows.cas(rec.flowId,"called_back",{...rec,status:"denied"});return callbackPage("denied");}
    const c={...result.credentials,locationName:result.credentials.locationId};
    if(!grantedScopesSchema.safeParse(c.scopes).success) {await d.flows.cas(rec.flowId,"called_back",{...rec,status:"denied"});return callbackPage("denied");}
    c.locationName=await locationDisplayName(c,d);
    // The name read may outlive this flow or an owner disconnect.
    const expiredAfterLookup=d.now()>=rec.expiresAt || (d.flows.homeGeneration && await d.flows.homeGeneration(rec.binding.homeId)!==rec.generation);
    if(expiredAfterLookup){await expire({...rec,status:"called_back"},d);return callbackPage("expired",410);}
    await d.flows.cas(rec.flowId,"called_back",{...rec,status:"called_back",heldSealed:await sealHeld(rec.recipientPublic,rec.flowId,encoder.encode(JSON.stringify(c)))});
    return callbackPage();
  } catch {return fail("unavailable");}
}
async function authenticateFlow(req: Request,d: FlowDeps,input: RuntimeBinding & {flowId:string;completionCapability:string},authenticated?: RuntimeBinding): Promise<FlowRecord|Response> {
  const rec=await d.flows.byFlowId(input.flowId);
  if(!rec || !sameBinding(rec.binding,input) || !await matchesCapability(input.completionCapability,rec.capHash)) return fail("not_found");
  if(rec.enroll==="existing") {const auth=authenticated ?? (await d.verifier.verifyRequest(req,"/v1/crm/complete"))?.binding;if(!auth) return fail("unauthorized");if(!sameBinding(auth,rec.binding)) return fail("not_found");}
  if(d.now()>=rec.expiresAt || rec.status==="expired" || (d.flows.homeGeneration && await d.flows.homeGeneration(rec.binding.homeId)!==rec.generation)) {await expire(rec,d);return fail("flow_expired");}
  return rec;
}
export async function previewFlow(req: Request,d: FlowDeps): Promise<Response> {
  try {
    if(!validRoute(req,d,"/v1/crm/complete","GET")) return fail("invalid_request");
    const parsed=runtimeBindingSchema.safeParse(JSON.parse(decoder.decode(decode64(req.headers.get("x-murage-binding") ?? ""))));if(!parsed.success) return fail("not_found");
    const input={...parsed.data,flowId:req.headers.get("x-murage-flow") ?? "",completionCapability:req.headers.get("x-murage-completion") ?? ""};
    const rec=await authenticateFlow(req,d,input);if(rec instanceof Response)return rec;
    if(!d.flows.previewAllowed || !await d.flows.previewAllowed(rec.flowId,d.now()))return fail("rate_limited");
    if(rec.status==="denied")return json({status:"denied"});
    if(!rec.heldSealed)return json({status:"pending"});
    const bytes=await openHeld(input.completionCapability,rec.flowId,rec.recipientPrivateSealed,rec.heldSealed);if(!bytes)return fail("not_found");
    const held=JSON.parse(decoder.decode(bytes)) as OAuthCredentials & {locationName:string};
    return json(flowPreviewSchema.parse({status:"held",locationId:held.locationId,locationName:held.locationName,scopes:held.scopes,missing:HIGHLEVEL_CRM_SCOPES.filter(s=>!held.scopes.includes(s))}));
  } catch {return fail("not_found");}
}
export async function completeFlow(req: Request,d: FlowDeps): Promise<Response> {
  try {
    if(!validRoute(req,d,"/v1/crm/complete","POST"))return fail("invalid_request");
    const authenticated=req.headers.has(RUNTIME_HEADER)?await d.verifier.verifyRequest(req,"/v1/crm/complete"):null;
    if(req.headers.has(RUNTIME_HEADER) && !authenticated)return fail("unauthorized");
    const parsed=completeRequestSchema.safeParse(authenticated?JSON.parse(decoder.decode(authenticated.body)):await body(req));if(!parsed.success)return fail("invalid_request");const input=parsed.data;
    const rec=await authenticateFlow(req,d,input,authenticated?.binding);if(rec instanceof Response)return rec;
    if(rec.status==="completed" && rec.completedResult) {
      const plain=await capabilitySealer(input.completionCapability).open("held",rec.flowId,2,rec.completedResult);
      if(!plain)return fail("unavailable");const replay=completeResponseSchema.parse(JSON.parse(decoder.decode(plain)));
      if(replay.grant.locationId!==input.confirmedLocationId){await expire(rec,d);return fail("location_mismatch");}return json(replay);
    }
    if(rec.status==="denied")return fail("flow_denied");
    if((rec.status!=="called_back" && rec.status!=="completing") || !rec.heldSealed)return fail("flow_pending");
    const plain=await openHeld(input.completionCapability,rec.flowId,rec.recipientPrivateSealed,rec.heldSealed);if(!plain)return fail("unavailable");
    const credentials=JSON.parse(decoder.decode(plain)) as OAuthCredentials;
    if(input.confirmedLocationId!==credentials.locationId){await expire(rec,d);return fail("location_mismatch");}
    let current=rec;
    if(rec.status==="called_back") {
      const intent={runtimeCapability:rec.enroll==="new"?encode64(d.random(32)):null,grantCapability:encode64(d.random(32))};
      const completionIntent=await capabilitySealer(input.completionCapability).seal("held",rec.flowId,3,encoder.encode(JSON.stringify(intent)));
      const next={...rec,status:"completing" as const,completionIntent};
      if(await d.flows.cas(rec.flowId,"called_back",next))current=next;
      else {const latest=await d.flows.byFlowId(rec.flowId);if(!latest)return fail("not_found");current=latest;}
    }
    if(current.status==="completed" && current.completedResult){const bytes=await capabilitySealer(input.completionCapability).open("held",rec.flowId,2,current.completedResult);return bytes?json(completeResponseSchema.parse(JSON.parse(decoder.decode(bytes)))):fail("unavailable");}
    if(current.status!=="completing" || !current.completionIntent)return fail("flow_expired");
    const intentBytes=await capabilitySealer(input.completionCapability).open("held",rec.flowId,3,current.completionIntent);if(!intentBytes)return fail("unavailable");
    const intent=JSON.parse(decoder.decode(intentBytes)) as {runtimeCapability:string|null;grantCapability:string};
    const runtimeCapability=intent.runtimeCapability;
    if(rec.enroll==="new" && runtimeCapability) {
      const runtimeKey=decode64(runtimeCapability);
      if(await d.enrollments.createIfAbsent(rec.binding,runtimeKey,{flowId:rec.flowId,homeGeneration:rec.generation})!=="created") {
        const enrolled=await d.enrollments.get(rec.binding.runtimePrincipalId);
        if(!enrolled || !sameBinding(enrolled.binding,rec.binding) || !await matchesCapability(encode64(enrolled.runtimeKey),await sha256(runtimeCapability))) {await expire(current,d);return fail("conflict");}
      }
    }
    const created=await d.grants.createPending({binding:rec.binding,credentials,connectionEpoch:rec.beginEpoch,completionId:rec.flowId,grantCapability:intent.grantCapability,homeGeneration:rec.generation,completionIntent:current.completionIntent});
    const result=completeResponseSchema.parse({...created,enrollmentId:rec.binding.runtimePrincipalId,runtimeCapability});
    const completedResult=await capabilitySealer(input.completionCapability).seal("held",rec.flowId,2,encoder.encode(JSON.stringify(result)));
    if(d.now()>=rec.expiresAt){await expire({...rec,status:"completing"},d);return fail("flow_expired");}
    const next={...current,status:"completed" as const,completedResult,recipientPublic:"",recipientPrivateSealed:""};delete next.heldSealed;Reflect.deleteProperty(next,"heldPreview");delete next.completionIntent;
    if(!await d.flows.cas(rec.flowId,"completing",next)){
      const latest=await d.flows.byFlowId(rec.flowId);if(latest?.status!=="completed" || !latest.completedResult)return fail("unavailable");
      const bytes=await capabilitySealer(input.completionCapability).open("held",rec.flowId,2,latest.completedResult);return bytes?json(completeResponseSchema.parse(JSON.parse(decoder.decode(bytes)))):fail("unavailable");
    }
    return json(result);
  } catch(error) {return fail(error instanceof GrantStoreFailure?error.code:"unavailable");}
}
/** Shared home transaction authority. Alarms sweep even when no owner polls. */
export function durableFlowStore(storage: BrokerStorage): FlowStore {
  const write=async(tx:BrokerTxn,rec:FlowRecord)=>{
    await tx.put(`flow:${rec.lookupHash}`,rec);await tx.put(`flowid:${rec.flowId}`,rec.lookupHash);
    await tx.put(expiryKey("flowdue:",rec.expiresAt,rec.flowId),rec.lookupHash);
    if(rec.status==="expired")await tx.delete(`flowhome:${rec.binding.homeId}:${rec.flowId}`);
    else await tx.put(`flowhome:${rec.binding.homeId}:${rec.flowId}`,rec.lookupHash);
    if(["completed","expired","denied"].includes(rec.status))await tx.delete(`open:${rec.binding.runtimePrincipalId}:${rec.flowId}`);
  };
  return {
    put:rec=>storage.transaction(tx=>write(tx,rec)),
    async homeGeneration(id){return (await storage.get<{generation:number}>(`home:${id}`))?.generation ?? 1;},
    async byLookup(h){return await storage.get<FlowRecord>(`flow:${h}`) ?? null;},
    async byFlowId(id){const h=await storage.get<string>(`flowid:${id}`);return h?await storage.get<FlowRecord>(`flow:${h}`) ?? null:null;},
    cas:(id,from,next)=>storage.transaction(async tx=>{const h=await tx.get<string>(`flowid:${id}`);if(!h || (await tx.get<FlowRecord>(`flow:${h}`))?.status!==from)return false;await write(tx,next);return true;}),
    admit:(rec,now)=>storage.transaction(async tx=>{
      if(((await tx.get<{generation:number}>(`home:${rec.binding.homeId}`))?.generation ?? 1)!==rec.generation)return false;
      let count=0;for(const [k,v]of await tx.list<number>({prefix:`open:${rec.binding.runtimePrincipalId}:`,limit:3})){
        const id=k.slice(k.lastIndexOf(":")+1),h=await tx.get<string>(`flowid:${id}`),f=h?await tx.get<FlowRecord>(`flow:${h}`):undefined;
        if(v<=now || !f || ["completed","expired","denied"].includes(f.status))await tx.delete(k);else count++;
      }
      if(count>=3)return false;
      await write(tx,rec);await tx.put(`open:${rec.binding.runtimePrincipalId}:${rec.flowId}`,rec.expiresAt);return true;
    }),
    previewAllowed:(id,now)=>storage.transaction(async tx=>{const k=`preview:${id}`,last=await tx.get<number>(k);if(last!==undefined && now-last<1000)return false;await tx.put(k,now);return true;}),
  };
}
/** Disconnect clears one bounded home page immediately; alarms resume the rest.
 * Home-generation validation makes every remaining old flow unusable at once. */
export async function revokeHomeFlows(tx:BrokerTxn,homeId:string,generation:number,after?:string):Promise<void> {
  const prefix=`flowhome:${homeId}:`,page=await tx.list<string>({prefix,startAfter:after,limit:STORAGE_PAGE_SIZE});
  for(const [index,h]of page){const key=`flow:${h}`,flow=await tx.get<FlowRecord>(key);
    if(!flow || flow.generation<generation){if(flow){const expired={...flow,status:"expired" as const,recipientPublic:"",recipientPrivateSealed:""};delete expired.heldSealed;Reflect.deleteProperty(expired,"heldPreview");delete expired.completedResult;delete expired.completionIntent;await tx.put(key,expired);await tx.delete(`open:${flow.binding.runtimePrincipalId}:${flow.flowId}`);}await tx.delete(index);}}
  const key=`flowrevoke:${homeId}`;
  if(page.size===STORAGE_PAGE_SIZE)await tx.put(key,{homeId,generation,after:[...page.keys()].at(-1)});else await tx.delete(key);
}
export async function sweepFlowStore(storage: BrokerStorage,now:number): Promise<void> {
  await storage.transaction(async tx=>{
    const remove=async(k:string,rec:FlowRecord)=>{await tx.delete(k);await tx.delete(`flowid:${rec.flowId}`);await tx.delete(`open:${rec.binding.runtimePrincipalId}:${rec.flowId}`);await tx.delete(`preview:${rec.flowId}`);await tx.delete(`flowhome:${rec.binding.homeId}:${rec.flowId}`);await tx.delete(`completion:${rec.flowId}`);await tx.delete(expiryKey("flowdue:",rec.expiresAt,rec.flowId));};
    for(const [k,rec]of await legacyPage<FlowRecord>(tx,"flow:")){
      if(rec.expiresAt<=now)await remove(k,rec);
      else {await tx.put(expiryKey("flowdue:",rec.expiresAt,rec.flowId),rec.lookupHash);
        const generation=(await tx.get<{generation:number}>(`home:${rec.binding.homeId}`))?.generation ?? 1;
        await tx.put(`flowhome:${rec.binding.homeId}:${rec.flowId}`,rec.lookupHash);
        if(rec.generation<generation)await tx.put(`flowrevoke:${rec.binding.homeId}`,{homeId:rec.binding.homeId,generation});}
    }
    for(const [index,h]of await tx.list<string>({prefix:"flowdue:",end:expiryKey("flowdue:",now+1),limit:STORAGE_PAGE_SIZE})){
      const rec=await tx.get<FlowRecord>(`flow:${h}`);if(rec && rec.expiresAt<=now)await remove(`flow:${h}`,rec);await tx.delete(index);
    }
    for(const [k,until]of await legacyPage<number>(tx,"rq:")){if(until<=now)await tx.delete(k);else await tx.put(expiryKey("rqdue:",until,k),k);}
    for(const [k]of await legacyPage<number>(tx,"ip:")){const until=(Number(k.slice(k.lastIndexOf(":")+1))+1)*3600000;if(until<=now)await tx.delete(k);else await tx.put(expiryKey("ipdue:",until,k),k);}
    for(const prefix of ["rqdue:","ipdue:"])for(const [index,key]of await tx.list<string>({prefix,end:expiryKey(prefix,now+1),limit:STORAGE_PAGE_SIZE})){
      if(prefix==="ipdue:" || (await tx.get<number>(key) ?? 0)<=now)await tx.delete(key);await tx.delete(index);
    }
    for(const [,job]of await tx.list<{homeId:string;generation:number;after?:string}>({prefix:"flowrevoke:",limit:1}))await revokeHomeFlows(tx,job.homeId,job.generation,job.after);
  });
}
