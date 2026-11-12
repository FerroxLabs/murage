// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { z } from "zod";
import { accessLeaseSchema, grantMetadataSchema, grantedScopesSchema, leaseRequestSchema, disconnectRequestSchema } from "./contracts.ts";
import type { AccessLease, RuntimeBinding } from "./contracts.ts";
import type { OAuthCredentials, OAuthGrant, OAuthResult } from "./oauth.ts";
import { revokeHomeFlows } from "./flow.ts";
import type { BrokerErrorCode, FlowRecord } from "./flow.ts";
import { sameBinding, matchesCapability, randomCapability, expiryKey, legacyPage, STORAGE_PAGE_SIZE } from "./runtime-auth.ts";
import type { BrokerStorage, BrokerTxn, RequestRuntimeVerifier } from "./runtime-auth.ts";
import { sha256 } from "./seal.ts";
import type { Sealer } from "./seal.ts";
export type GrantMetadata = z.infer<typeof grantMetadataSchema>;
export type LeaseRequest = z.infer<typeof leaseRequestSchema>;
export type DisconnectRequest = z.infer<typeof disconnectRequestSchema>;
export interface GrantWriter {
  createPending(input: { binding: RuntimeBinding; credentials: OAuthCredentials; connectionEpoch: number; completionId?: string; grantCapability?: string; homeGeneration?: number; completionIntent?: string }): Promise<{ grant: GrantMetadata; grantCapability: string }>;
}
export type BrokerRefusal = { code: Exclude<BrokerErrorCode, "flow_pending" | "flow_denied" | "flow_expired">; grant?: GrantMetadata };
export interface GrantStore extends GrantWriter {
  lease(b: RuntimeBinding, req: LeaseRequest, grantCap: string): Promise<AccessLease | BrokerRefusal>;
  disconnect(b: RuntimeBinding, req: DisconnectRequest, grantCap: string): Promise<{ revoked: true } | BrokerRefusal>;
  alarm(now: number): Promise<void>;
}
export interface GrantDeps { master: Sealer; oauth: (g: OAuthGrant) => Promise<OAuthResult>; now(): number }
export interface DurableObjectState { storage: BrokerStorage }
export class GrantStoreFailure extends Error {
  readonly code: BrokerErrorCode; constructor(code: BrokerErrorCode){super(code);this.code=code;}
}
export const MAX_LEASE_MS=300_000, PENDING_ACK_MS=30*60_000, IDLE_GRANT_MS=30*86400_000;
type State='pending_ack'|'active'|'reconnect_required'|'revoked';
export interface GrantRecord {
  grantId:string;binding:RuntimeBinding;locationId:string;companyId:string|null;userId:string;scopes:string[];
  credentialVersion:number;epochFloor:number;grantCapHash:string;rotation:number;generation:number;state:State;
  refreshSealed?:string;accessSealed?:string;accessExpiresAt:number;refreshIntent?:number;
  createdAt:number;lastLeaseAt:number;supersedes?:string;
}
interface HomeRecord {generation:number;epochFloor:number;activeGrantId?:string;pendingGrantId?:string}
const meta=(r:GrantRecord):GrantMetadata=>grantMetadataSchema.parse({provenance:'oauth-token-response',userType:'Location',locationId:r.locationId,
  scopes:r.scopes,grantVersion:r.credentialVersion,credentialVersion:r.credentialVersion,connectionEpoch:r.epochFloor,grantId:r.grantId});
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const refusal=(code:BrokerRefusal['code']):BrokerRefusal=>({code});
const grantDue=(r:GrantRecord)=>expiryKey('grantdue:',r.state==='pending_ack'?r.createdAt+PENDING_ACK_MS:r.lastLeaseAt+IDLE_GRANT_MS,r.grantId);
async function retire(tx:BrokerTxn,r:GrantRecord,reason:string,now:number,state:State='revoked'):Promise<void>{
  await tx.delete(grantDue(r));const next={...r,state};delete next.refreshSealed;delete next.accessSealed;delete next.refreshIntent;
  await tx.put(`grant:${r.grantId}`,next);await tx.put(`tomb:${r.grantId}`,{revokedAt:now,reason});await tx.delete(`live:${r.binding.homeId}:${r.grantId}`);
}
export function durableGrantStore(state:DurableObjectState,deps:GrantDeps):GrantStore {
  const storage=state.storage,leases=new Map<string,Promise<void>>();
  async function serial<T>(id:string,work:()=>Promise<T>):Promise<T>{
    const prior=leases.get(id) ?? Promise.resolve();let release!:()=>void;const own=new Promise<void>(r=>{release=r;});leases.set(id,own);
    await prior;try{return await work();}finally{release();if(leases.get(id)===own)leases.delete(id);}
  }
  async function authorized(tx:BrokerTxn,b:RuntimeBinding,req:LeaseRequest,cap:string):Promise<GrantRecord|null>{
    const r=await tx.get<GrantRecord>(`grant:${req.grantId}`);
    if(!r || !sameBinding(b,req) || !sameBinding(b,r.binding) || !await matchesCapability(cap,r.grantCapHash))return null;return r;
  }
  async function usable(tx:BrokerTxn,r:GrantRecord,req:LeaseRequest):Promise<BrokerRefusal|null>{
    const home=await tx.get<HomeRecord>(`home:${r.binding.homeId}`);
    if(r.state==='reconnect_required')return refusal('reconnect_required');
    if(r.state==='revoked' || !home || home.generation!==r.generation || await tx.get(`tomb:${r.grantId}`))return refusal('grant_revoked');
    if(req.connectionEpoch<Math.max(r.epochFloor,home.epochFloor))return refusal('conflict');
    if(req.grantVersion!==r.credentialVersion)return {code:'grant_changed',grant:meta(r)};
    return null;
  }
  async function issue(tx:BrokerTxn,r:GrantRecord,req:LeaseRequest):Promise<AccessLease|BrokerRefusal>{
    const failed=await usable(tx,r,req);if(failed)return failed;
    const access=r.accessSealed?await deps.master.open('access',r.grantId,r.rotation+1,r.accessSealed):null;
    if(!access || r.accessExpiresAt-deps.now()<=120_000)return refusal('reconnect_required');
    const home=await tx.get<HomeRecord>(`home:${r.binding.homeId}`);if(!home)return refusal('grant_revoked');
    await tx.delete(grantDue(r));
    if(r.state==='pending_ack'){
      if(home.pendingGrantId!==r.grantId)return refusal('grant_revoked');
      if(home.activeGrantId && home.activeGrantId!==r.grantId){const old=await tx.get<GrantRecord>(`grant:${home.activeGrantId}`);if(old)await retire(tx,old,'replaced',deps.now());}
      home.activeGrantId=r.grantId;delete home.pendingGrantId;r.state='active';
    }
    r.epochFloor=Math.max(r.epochFloor,req.connectionEpoch);home.epochFloor=Math.max(home.epochFloor,r.epochFloor);r.lastLeaseAt=deps.now();
    await tx.put(grantDue(r),r.grantId);
    await tx.put(`grant:${r.grantId}`,r);await tx.put(`home:${r.binding.homeId}`,home);
    return accessLeaseSchema.parse({...meta(r),accessToken:decoder.decode(access),expiresAt:Math.min(r.accessExpiresAt-60_000,deps.now()+MAX_LEASE_MS)});
  }
  async function leaseWork(b:RuntimeBinding,req:LeaseRequest,cap:string):Promise<AccessLease|BrokerRefusal>{
    // Claim the rotation durably before sending any rotating refresh credential.
    const decision=await storage.transaction(async tx=>{
      const r=await authorized(tx,b,req,cap);if(!r)return refusal('not_found');
      const failed=await usable(tx,r,req);if(failed)return failed;
      if(r.refreshIntent!==undefined){await retire(tx,r,'uncertain_rotation',deps.now(),'reconnect_required');return refusal('reconnect_required');}
      if(r.accessExpiresAt-deps.now()>120_000)return issue(tx,r,req);
      if(!r.refreshSealed){await retire(tx,r,'missing_credential',deps.now(),'reconnect_required');return refusal('reconnect_required');}
      r.refreshIntent=r.rotation;await tx.put(`grant:${r.grantId}`,r);return {refresh:r};
    });
    if(!('refresh'in decision))return decision;
    const before=decision.refresh;
    const refresh=await deps.master.open('refresh',before.grantId,before.rotation+1,before.refreshSealed!);
    let result:OAuthResult={kind:'error',error:'reconnect_required'};
    if(refresh){try{result=await deps.oauth({kind:'refresh',refreshToken:decoder.decode(refresh)});}catch{/* fixed refusal below */}}
    const c=result.kind==='ok'?result.credentials:null;
    const valid=c && c.locationId===before.locationId && c.companyId===before.companyId && c.userId===before.userId && c.scopeProvenance==='oauth-token-response' &&
      grantedScopesSchema.safeParse(c.scopes).success && Number.isSafeInteger(c.expiresAt) && c.expiresAt-deps.now()>120_000 && c.accessToken.length>0 && c.refreshToken.length>0;
    const changed=c && [...c.scopes].sort().join(' ')!==[...before.scopes].sort().join(' ');
    const rotation=before.rotation+1;
    // Nothing is returned until the rotation CAS AND acknowledgement commit.
    const sealed=valid?{refreshSealed:await deps.master.seal('refresh',before.grantId,rotation+1,encoder.encode(c.refreshToken)),
      accessSealed:await deps.master.seal('access',before.grantId,rotation+1,encoder.encode(c.accessToken))}:null;
    return storage.transaction(async tx=>{
      const current=await tx.get<GrantRecord>(`grant:${before.grantId}`),home=await tx.get<HomeRecord>(`home:${before.binding.homeId}`);
      if(!current || current.state==='revoked' || !home || home.generation!==before.generation)return refusal('grant_revoked');
      if(current.state==='reconnect_required')return refusal('reconnect_required');
      if(current.rotation!==before.rotation || current.credentialVersion!==before.credentialVersion || current.refreshIntent!==before.rotation)return refusal('reconnect_required');
      if(!valid || !c || !sealed){await retire(tx,current,'refresh_refused',deps.now(),'reconnect_required');return refusal('reconnect_required');}
      const next:GrantRecord={...current,...sealed,rotation,accessExpiresAt:c.expiresAt,scopes:[...c.scopes],credentialVersion:before.credentialVersion+(changed?1:0)};delete next.refreshIntent;
      await tx.put(`grant:${next.grantId}`,next);
      if(req.grantVersion!==next.credentialVersion)return {code:'grant_changed',grant:meta(next)};
      return issue(tx,next,req);
    });
  }
  return {
    async createPending(input){
      if(!Number.isSafeInteger(input.connectionEpoch)||input.connectionEpoch<1||!grantedScopesSchema.safeParse(input.credentials.scopes).success)throw new GrantStoreFailure('invalid_request');
      const cap=input.grantCapability ?? randomCapability(),id=randomCapability(),now=deps.now(),c=input.credentials;
      const sealed={refreshSealed:await deps.master.seal('refresh',id,1,encoder.encode(c.refreshToken)),accessSealed:await deps.master.seal('access',id,1,encoder.encode(c.accessToken))};
      return storage.transaction(async tx=>{
        const home=await tx.get<HomeRecord>(`home:${input.binding.homeId}`) ?? {generation:1,epochFloor:1};
        if(input.homeGeneration!==undefined && input.homeGeneration!==home.generation)throw new GrantStoreFailure('conflict');
        // Eligibility belongs in the same transaction as credentials and replacement.
        if(input.completionIntent!==undefined){
          const h=input.completionId?await tx.get<string>(`flowid:${input.completionId}`):undefined,flow=h?await tx.get<FlowRecord>(`flow:${h}`):undefined;
          const prior=input.completionId?await tx.get<string>(`completion:${input.completionId}`):undefined;
          if(!flow || flow.expiresAt<=deps.now() || flow.generation!==home.generation || !sameBinding(flow.binding,input.binding) ||
            !(flow.status==='completing' && flow.completionIntent===input.completionIntent || flow.status==='completed' && prior))throw new GrantStoreFailure('flow_expired');
        }
        if(input.connectionEpoch<home.epochFloor)throw new GrantStoreFailure('conflict');
        if(input.completionId){const prior=await tx.get<string>(`completion:${input.completionId}`);if(prior){const old=await tx.get<GrantRecord>(`grant:${prior}`);
          if(!old || old.state==='revoked' || old.state==='reconnect_required' || old.generation!==home.generation || !sameBinding(old.binding,input.binding)||!await matchesCapability(cap,old.grantCapHash))throw new GrantStoreFailure('conflict');
          return {grant:meta(old),grantCapability:cap};}}
        // A home has exactly one pending replacement; older pending grants die.
        if(home.pendingGrantId){const old=await tx.get<GrantRecord>(`grant:${home.pendingGrantId}`);if(old)await retire(tx,old,'superseded_pending',now);}
        const rec:GrantRecord={grantId:id,binding:input.binding,locationId:c.locationId,companyId:c.companyId,userId:c.userId,scopes:[...c.scopes],
          credentialVersion:1,epochFloor:input.connectionEpoch,grantCapHash:await sha256(cap),rotation:0,generation:home.generation,state:'pending_ack',...sealed,accessExpiresAt:c.expiresAt,createdAt:now,lastLeaseAt:now,
          ...(home.activeGrantId?{supersedes:home.activeGrantId}:{})};
        home.pendingGrantId=id;await tx.put(grantDue(rec),id);await tx.put(`grant:${id}`,rec);await tx.put(`live:${input.binding.homeId}:${id}`,true);await tx.put(`home:${input.binding.homeId}`,home);
        if(input.completionId)await tx.put(`completion:${input.completionId}`,id);
        return {grant:meta(rec),grantCapability:cap};
      });
    },
    async lease(b,req,cap){try{return await serial(req.grantId,()=>leaseWork(b,req,cap));}catch{return refusal('unavailable');}},
    async disconnect(b,req,cap){
      try{return await storage.transaction(async tx=>{
        const r=await authorized(tx,b,req,cap);if(!r)return refusal('not_found');
        const home=await tx.get<HomeRecord>(`home:${r.binding.homeId}`);if(!home)return {revoked:true as const};
        if(r.state==='revoked' && home.generation!==r.generation)return {revoked:true as const};
        if(req.connectionEpoch<Math.max(r.epochFloor,home.epochFloor))return refusal('conflict');
        home.generation++;home.epochFloor=Math.max(home.epochFloor,req.connectionEpoch)+1;
        for(const id of new Set([home.activeGrantId,home.pendingGrantId].filter((id):id is string=>!!id))){
          const grant=await tx.get<GrantRecord>(`grant:${id}`);if(grant)await retire(tx,grant,'owner_disconnect',deps.now());
        }
        delete home.activeGrantId;delete home.pendingGrantId;await tx.put(`home:${r.binding.homeId}`,home);
        await tx.delete(`enr:${r.binding.runtimePrincipalId}`);
        // All adapters share the authority storage; generation fences every flow.
        await revokeHomeFlows(tx,r.binding.homeId,home.generation);
        return {revoked:true as const};
      });}catch{return refusal('unavailable');}
    },
    async alarm(now){await storage.transaction(async tx=>{
      // Legacy history is backfilled once, in resumable bounded pages.
      for(const [,r]of await legacyPage<GrantRecord>(tx,'grant:'))if(r.state==='pending_ack'||r.state==='active')await tx.put(grantDue(r),r.grantId);
      for(const [index,id]of await tx.list<string>({prefix:'grantdue:',end:expiryKey('grantdue:',now+1),limit:STORAGE_PAGE_SIZE})){
        const r=await tx.get<GrantRecord>(`grant:${id}`);await tx.delete(index);
        if(!r || !((r.state==='pending_ack' && now-r.createdAt>=PENDING_ACK_MS)||(r.state==='active' && now-r.lastLeaseAt>=IDLE_GRANT_MS)))continue;
        await retire(tx,r,'expired',now);const home=await tx.get<HomeRecord>(`home:${r.binding.homeId}`);
        if(home){if(home.pendingGrantId===r.grantId)delete home.pendingGrantId;if(home.activeGrantId===r.grantId)delete home.activeGrantId;await tx.put(`home:${r.binding.homeId}`,home);
          if(!home.activeGrantId&&!home.pendingGrantId)await tx.delete(`enr:${r.binding.runtimePrincipalId}`);}
      }
    });},
  };
}
/** Test-only persistent backing. Production must use the durable adapter. */
export function memoryGrantStore(deps:GrantDeps,backing=new Map<string,unknown>()):GrantStore {
  let tail=Promise.resolve();
  const make=(map:Map<string,unknown>):BrokerStorage=>({
    async get<T>(key:string){return structuredClone(map.get(key)) as T|undefined;},async put<T>(key:string,value:T){map.set(key,structuredClone(value));},async delete(key){return map.delete(key);},
    async list<T>({prefix,limit,startAfter,end}:{prefix:string;limit?:number;startAfter?:string;end?:string}){return new Map([...map].sort(([a],[b])=>a<b?-1:a>b?1:0).filter(([k])=>k.startsWith(prefix)&&(!startAfter||k>startAfter)&&(!end||k<end)).slice(0,limit).map(([k,v])=>[k,structuredClone(v) as T]));},
    async transaction<T>(work:(tx:BrokerTxn)=>Promise<T>){let release!:()=>void;const prior=tail;tail=new Promise<void>(r=>{release=r;});await prior;
      try{const copy=structuredClone(map),result=await work(make(copy));map.clear();for(const [k,v]of copy)map.set(k,v);return result;}finally{release();}}
  });
  return durableGrantStore({storage:make(backing)},deps);
}

export interface GrantRouteDeps { grants: GrantStore; verifier: RequestRuntimeVerifier; origin: string; stagingOrigin?: string }
const routeHeaders={"cache-control":"no-store","referrer-policy":"no-referrer"};
const routeStatuses:Record<BrokerRefusal['code'],number>={invalid_request:400,unauthorized:401,not_found:404,conflict:409,location_mismatch:409,grant_changed:409,grant_revoked:410,reconnect_required:409,rate_limited:429,unavailable:503};
const parseVerified=(bytes:Uint8Array):unknown=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
async function grantRoute(req:Request,d:GrantRouteDeps,route:'/v1/crm/lease'|'/v1/crm/disconnect'):Promise<Response>{
  const reply=(body:unknown,status=200)=>Response.json(body,{status,headers:routeHeaders});
  try{
    const url=new URL(req.url),origin=new URL(d.origin);
    if(origin.origin!==d.origin || origin.protocol!=='https:' || origin.username || origin.password ||
      !(d.origin==='https://connect.murage.ai'||d.origin===d.stagingOrigin) || url.origin!==d.origin)return reply({code:'invalid_request'},400);
    if(url.pathname!==route || req.method!=='POST')return reply({code:'unauthorized'},401);
    const verified=await d.verifier.verifyRequest(req,route);if(!verified)return reply({code:'unauthorized'},401);
    let input:unknown;try{input=parseVerified(verified.body);}catch{return reply({code:'invalid_request'},400);}
    const parsed=(route==='/v1/crm/lease'?leaseRequestSchema:disconnectRequestSchema).safeParse(input);
    if(!parsed.success)return reply({code:'invalid_request'},400);
    if(!sameBinding(verified.binding,parsed.data))return reply({code:'not_found'},404);
    const cap=req.headers.get('x-murage-grant');
    if(!cap || !/^[A-Za-z0-9_-]{43}$/u.test(cap))return reply({code:'not_found'},404);
    const result=route==='/v1/crm/lease'?await d.grants.lease(verified.binding,parsed.data,cap):await d.grants.disconnect(verified.binding,parsed.data,cap);
    return 'code'in result?reply(result,routeStatuses[result.code]):reply(result);
  }catch{return reply({code:'unavailable'},503);}
}
export function leaseRoute(req:Request,d:GrantRouteDeps):Promise<Response>{return grantRoute(req,d,'/v1/crm/lease');}
export function disconnectRoute(req:Request,d:GrantRouteDeps):Promise<Response>{return grantRoute(req,d,'/v1/crm/disconnect');}
