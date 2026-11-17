// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { accessLeaseSchema, beginResponseSchema, grantMetadataSchema } from '../../cloudflare/crm-broker/src/contracts.ts';
import { canonicalRuntimeMessage } from '../../cloudflare/crm-broker/src/runtime-auth.ts';
import { HighLevelCredentialCommit, type HighLevelSecretBank, type HighLevelCredentialIntent } from './credential-commit.ts';
import { HighLevelError, type HighLevelLease, type HighLevelLeaseRequest, type HighLevelConnectionView } from './client.ts';
import type { HighLevelOwnerConnection } from './private-token.ts';
const id=z.string().regex(/^[A-Za-z0-9_-]{1,160}$/u);
const previewSchema=z.discriminatedUnion('status',[
 z.object({status:z.literal('pending')}).strict(),z.object({status:z.literal('denied')}).strict(),
 z.object({status:z.literal('held'),locationId:id,locationName:z.string().min(1).max(200),scopes:grantMetadataSchema.shape.scopes,missing:z.array(z.string()).max(64)}).strict(),
]);
const completionSchema=z.object({grant:grantMetadataSchema,enrollmentId:id,runtimeCapability:z.string().nullable(),grantCapability:z.string()}).strict();
const flowSchema=z.object({flowId:id}).strict();
const confirmSchema=flowSchema.extend({locationId:id}).strict();
const unavailable=()=>Error('HighLevel connection unavailable');
type Held={flowId:string;completionCapability:string;expiresAt:number;epoch:number;revision:number;bank:HighLevelSecretBank|null;installationId:string;preview?:Extract<z.infer<typeof previewSchema>,{status:'held'}>;intent?:HighLevelCredentialIntent};
/** The broker is the only grant producer. Renderer requests contain IDs only;
 * completion capabilities and grants remain in this launch's trusted server.
 * stage() runs only after the owner confirms the exact broker preview. */
export class HighLevelCredentialConnection {
 readonly #commit:HighLevelCredentialCommit;
 readonly #fetch:typeof fetch;
 readonly #now:()=>number;
 readonly #installationId=randomUUID();
 #flow:Held|undefined;
 #busy=false;
 constructor(commit:HighLevelCredentialCommit,fetchImpl:typeof fetch=fetch,now:()=>number=Date.now){this.#commit=commit;this.#fetch=fetchImpl;this.#now=now;}
 async #serial<T>(work:()=>Promise<T>):Promise<T>{
  if(this.#busy)throw unavailable();this.#busy=true;
  try{return await work();}finally{this.#busy=false;}
 }
 async #request(route:'/v1/crm/begin'|'/v1/crm/complete'|'/v1/crm/lease'|'/v1/crm/disconnect',method:'GET'|'POST',body:object|undefined,flow:{bank:Pick<HighLevelSecretBank,'connection'>|null;installationId:string},headers:Record<string,string>={}):Promise<unknown>{
  const binding={runtimePrincipalId:flow.installationId,installationId:flow.installationId,homeId:flow.installationId,contentOwnerId:'owner'};
  const text=body===undefined?'':JSON.stringify({...binding,...body});
  if(flow.bank?.connection){
   const key=Buffer.from(flow.bank.connection.runtimeCapability,'base64url');if(key.length!==32)throw unavailable();
   const at=this.#now(),env={...binding,requestId:randomUUID(),issuedAt:at,expiresAt:at+30000};
   const signature=createHmac('sha256',key).update(canonicalRuntimeMessage(route,method,env,createHash('sha256').update(text).digest('hex'))).digest('base64url');
   headers['x-murage-runtime']=Buffer.from(JSON.stringify({...env,signature})).toString('base64url');
  }
  const response=await this.#fetch('https://connect.murage.ai'+route,{method,headers:{'content-type':'application/json',...headers},...(body===undefined?{}:{body:text}),redirect:'error',signal:AbortSignal.timeout(15000)});
  if(route==='/v1/crm/disconnect'&&(response.status===401||response.status===410)){void response.body?.cancel().catch(()=>{});return {revoked:true};}
  if(!response.ok||Number(response.headers.get('content-length')??0)>65536) {void response.body?.cancel().catch(()=>{});throw unavailable();}
  const reader=response.body?.getReader();if(!reader)throw unavailable();
  const chunks:Uint8Array[]=[];let size=0,reads=0;
  try{while(true){if(++reads>65536)throw unavailable();const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>65536)throw unavailable();chunks.push(next.value);}}
  finally{void reader.cancel().catch(()=>{});}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
 }
 /** Only a bank matching durable metadata can carry runtime traffic. */
 hasConnection():boolean { return this.#commit.hasConnection(); }
 ownerView():HighLevelOwnerConnection|null {
  const metadata=this.#commit.activeMetadata();
  return metadata ? {connectionId:metadata.connectionId,locationId:metadata.locationId,state:'connected',confirmedAt:'',scopes:metadata.scopes} : null;
 }
 async connection(connectionId:string):Promise<HighLevelConnectionView|undefined> {
  const metadata=this.#commit.activeMetadata();
  return metadata?.connectionId===connectionId ? {connectionId,locationId:metadata.locationId,companyId:'',epoch:metadata.connectionEpoch,state:'connected'} : undefined;
 }
 async #activeRequest(route:'/v1/crm/lease'|'/v1/crm/disconnect',connectionId:string,epoch?:number) {
  const bank=this.#commit.activeBank(),metadata=this.#commit.activeMetadata(),grant=bank?.connection;
  if(!grant||!metadata||metadata.connectionId!==connectionId||(epoch!==undefined&&metadata.connectionEpoch!==epoch))throw unavailable();
  const result=await this.#request(route,'POST',{grantId:grant.grantId,grantVersion:grant.credentialVersion,connectionEpoch:metadata.connectionEpoch},
   {bank,installationId:grant.enrollmentId},{'x-murage-grant':grant.grantCapability});
  const current=this.#commit.activeMetadata();
  if(!current||JSON.stringify(current)!==JSON.stringify(metadata))throw unavailable();
  return {result,metadata,bank};
 }
 async lease(request:HighLevelLeaseRequest):Promise<HighLevelLease> {
  try {
   const {result,metadata}=await this.#activeRequest('/v1/crm/lease',request.connectionId,request.connectionEpoch);
   const lease=accessLeaseSchema.parse(result);
   if(lease.grantId!==metadata.grantId||lease.credentialVersion!==metadata.credentialVersion||lease.grantVersion!==metadata.credentialVersion
    ||lease.connectionEpoch!==metadata.connectionEpoch||lease.locationId!==metadata.locationId
    ||JSON.stringify(lease.scopes)!==JSON.stringify(metadata.scopes)||lease.expiresAt<=this.#now())throw unavailable();
   return {leaseId:randomUUID(),requestId:request.requestId,connectionId:request.connectionId,connectionEpoch:metadata.connectionEpoch,
    locationId:metadata.locationId,companyId:'',credentialVersion:lease.credentialVersion,accessToken:lease.accessToken,
    providerExpiresAt:lease.expiresAt,discardAt:Math.min(lease.expiresAt,this.#now()+60000)};
  } catch {throw new HighLevelError('HighLevel could not obtain a connection lease. Sign in again.',{status:409});}
 }
 disconnect(connectionId:string){return this.#serial(async()=>{
  const bank=this.#commit.activeBank(),metadata=this.#commit.activeMetadata(),grant=bank?.connection;
  if(!grant||!metadata||metadata.connectionId!==connectionId)throw unavailable();
  this.#flow=undefined;
  // The journal is persisted in the encrypted bank before metadata removal.
  // It remains available after failed revocation or a process exit.
  return this.#commit.stage({flowId:randomUUID(),versionId:randomUUID(),expectedRevision:bank.revision,expectedEpoch:metadata.connectionEpoch,connection:null,metadata:null},()=>this.#retryDisconnect());
 });}
 async #retryDisconnect():Promise<void> {
  const journal=this.#commit.pendingDisconnect();if(!journal)return;
  const grant=journal.connection;
  // A revoked enrollment can no longer authenticate. 401/410 on this fixed
  // revoke route is terminal too; never reuse its authority for a new flow.
  const result=await this.#request('/v1/crm/disconnect','POST',{grantId:grant.grantId,grantVersion:grant.credentialVersion,connectionEpoch:journal.connectionEpoch},
   {bank:{connection:grant},installationId:grant.enrollmentId},{'x-murage-grant':grant.grantCapability});
  z.object({revoked:z.literal(true)}).strict().parse(result);
 }
 begin(input:unknown){return this.#serial(async()=>{
  z.object({}).strict().parse(input);
  await this.#retryDisconnect();
  const state=this.#commit.connectionState(),installationId=state.bank?.connection?.enrollmentId??this.#installationId;
  const begun=beginResponseSchema.parse(await this.#request('/v1/crm/begin','POST',{requestId:randomUUID(),connectionEpoch:state.epoch+1},{bank:state.bank,installationId}));
  const expiresAt=Math.min(begun.expiresAt,this.#now()+600000);
  if(expiresAt<=this.#now())throw unavailable();
  this.#flow={...begun,expiresAt,epoch:state.epoch,revision:state.bank?.revision??0,bank:state.bank,installationId};
  return {flowId:begun.flowId,authorizationUrl:begun.authorizationUrl,expiresAt};
 });}
 #held(flowId:string):Held{
  const flow=this.#flow;if(!flow||flow.flowId!==flowId||flow.expiresAt<=this.#now())throw unavailable();
  const state=this.#commit.connectionState();if(state.epoch!==flow.epoch||(state.bank?.revision??0)!==flow.revision)throw unavailable();return flow;
 }
 preview(input:unknown){return this.#serial(async()=>{
  const flow=this.#held(flowSchema.parse(input).flowId);
  const binding={runtimePrincipalId:flow.installationId,installationId:flow.installationId,homeId:flow.installationId,contentOwnerId:'owner'};
  const preview=previewSchema.parse(await this.#request('/v1/crm/complete','GET',undefined,flow,{
   'x-murage-binding':Buffer.from(JSON.stringify(binding)).toString('base64url'),'x-murage-flow':flow.flowId,'x-murage-completion':flow.completionCapability,
  }));
  this.#held(flow.flowId);flow.preview=preview.status==='held'?preview:undefined;return preview;
 });}
 confirm(input:unknown){return this.#serial(async()=>{
  const value=confirmSchema.parse(input),flow=this.#held(value.flowId);
  if(!flow.preview||flow.preview.locationId!==value.locationId)throw unavailable();
  if(flow.intent)return flow.intent;
  const result=completionSchema.parse(await this.#request('/v1/crm/complete','POST',{flowId:flow.flowId,completionCapability:flow.completionCapability,confirmedLocationId:value.locationId},flow));
  this.#held(flow.flowId);
  if(result.enrollmentId!==flow.installationId||result.grant.locationId!==value.locationId||result.grant.connectionEpoch!==flow.epoch+1
   ||JSON.stringify(result.grant.scopes)!==JSON.stringify(flow.preview.scopes))throw unavailable();
  const connection={connectionId:'hl_'+result.grant.locationId,credentialVersion:result.grant.credentialVersion,grantId:result.grant.grantId,
   enrollmentId:result.enrollmentId,runtimeCapability:result.runtimeCapability??flow.bank?.connection?.runtimeCapability,grantCapability:result.grantCapability};
  // Validation in stage refuses a missing enrollment capability or mismatched metadata.
  const intent=this.#commit.stage({flowId:flow.flowId,versionId:randomUUID(),expectedRevision:flow.revision,expectedEpoch:flow.epoch,
   connection:connection as NonNullable<HighLevelSecretBank['connection']>,metadata:{connectionId:connection.connectionId,credentialVersion:connection.credentialVersion,grantId:connection.grantId,
    locationId:result.grant.locationId,connectionEpoch:result.grant.connectionEpoch,scopes:result.grant.scopes,provenance:result.grant.provenance}});
  flow.intent=intent;return intent;
 });}
}
