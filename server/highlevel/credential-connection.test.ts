import {expect,it,vi} from 'vitest';
import {HighLevelCredentialCommit,type HighLevelActiveMetadata,type HighLevelSecretBank} from './credential-commit.ts';
import {HighLevelCredentialConnection} from './credential-connection.ts';
import {createHmac,createHash} from 'node:crypto';
import {canonicalRuntimeMessage} from '../../cloudflare/crm-broker/src/runtime-auth.ts';
const credential='a'.repeat(64),auth='Bearer '+credential,locationId='locationFixture',runtimeCapability=Buffer.alloc(32,7).toString('base64url');
function fixture(){
 let metadata:HighLevelActiveMetadata|null=null,epoch=0,at=100000,mode='held',completionLocation=locationId;
 const host=new HighLevelCredentialCommit({bootstrap:{schema:1,commitCredential:credential,bank:null},hasRecoveryState:()=>false,readMetadata:()=>metadata,readConnectionEpoch:()=>epoch,activateMetadata:async m=>{metadata=m;epoch++;}});
 const fetcher=vi.fn<typeof fetch>(async(input,init)=>{
  const url=new URL(String(input));expect(url.origin).toBe('https://connect.murage.ai');expect(init?.redirect).toBe('error');
  if(url.pathname==='/v1/crm/begin')return Response.json({flowId:'flow',authorizationUrl:'https://marketplace.leadconnectorhq.com/v2/oauth/chooselocation?state=fixture',completionCapability:'completion-fixture-'.repeat(4),expiresAt:at+600000});
  if(init?.method==='GET')return Response.json(mode==='held'?{status:'held',locationId,locationName:'Fixture',scopes:['contacts.write'],missing:[]}:{status:mode});
  const body=JSON.parse(String(init?.body));return Response.json({grant:{grantId:'grant',credentialVersion:1,grantVersion:1,connectionEpoch:epoch+1,provenance:'oauth-token-response',userType:'Location',locationId:completionLocation,scopes:['contacts.write']},enrollmentId:body.homeId,runtimeCapability:epoch?null:runtimeCapability,grantCapability:'grant-fixture-'.repeat(4)});
 });
 const source=new HighLevelCredentialConnection(host,fetcher,()=>at);
 const confirm=async()=>{await source.begin({});await source.preview({flowId:'flow'});return source.confirm({flowId:'flow',locationId});};
 return {host,source,fetcher,confirm,expire:()=>{at+=600001;},mode:(value:string)=>{mode=value;},location:(value:string)=>{completionLocation=value;},async commit(intent:object){const p=host.prepare(auth,intent);const previous=host.connectionState().bank;const bank:HighLevelSecretBank={schema:1,revision:p.expectedRevision+1,locatorKey:previous?.locatorKey??'K'.repeat(43),connection:p.connection,...(p.disconnect?{disconnect:p.disconnect}:{})};await host.commit(auth,{commitId:p.commitId,bank});return bank;}};
}
it('D8 owner-confirmed broker completion produces an ID-only commit and signs reconnects with the retained enrollment',async()=>{
 const f=fixture(),intent=await f.confirm();expect(Object.keys(intent).sort()).toEqual(['flowId','versionId']);
 const bank=await f.commit(intent);expect(bank.connection?.runtimeCapability).toBe(runtimeCapability);
 await f.source.begin({});await f.source.preview({flowId:'flow'});const next=await f.source.confirm({flowId:'flow',locationId});const replacement=await f.commit(next);
 expect(replacement.revision).toBe(2);expect(replacement.locatorKey).toBe(bank.locatorKey);expect(replacement.connection?.runtimeCapability).toBe(runtimeCapability);
 for(const [url,init] of f.fetcher.mock.calls.slice(3)){
  const headers=new Headers(init?.headers),env=JSON.parse(Buffer.from(headers.get('x-murage-runtime')!,'base64url').toString());
  const route=new URL(String(url)).pathname as '/v1/crm/begin'|'/v1/crm/complete';
  expect(env.homeId).toBe(bank.connection!.enrollmentId);
  expect(env.signature).toBe(createHmac('sha256',Buffer.from(runtimeCapability,'base64url')).update(canonicalRuntimeMessage(route,init!.method as 'GET'|'POST',env,createHash('sha256').update(String(init?.body??'')).digest('hex'))).digest('base64url'));
 }
});
it.each(['pending','denied'])('D8 %s broker flow never stages a grant',async mode=>{
 const f=fixture();f.mode(mode);await f.source.begin({});await f.source.preview({flowId:'flow'});
 await expect(f.source.confirm({flowId:'flow',locationId})).rejects.toThrow();expect(f.fetcher).toHaveBeenCalledTimes(2);
 expect(()=>f.host.prepare(auth,{flowId:'flow',versionId:'invented'})).toThrow();
});
it('D8 rejects secret-bearing owner inputs, an unpreviewed or mismatched location and expired flows before completion',async()=>{
 const f=fixture();await expect(f.source.begin({runtimeCapability})).rejects.toThrow();expect(f.fetcher).not.toHaveBeenCalled();
 await f.source.begin({});await expect(f.source.confirm({flowId:'flow',locationId})).rejects.toThrow();
 await f.source.preview({flowId:'flow'});await expect(f.source.confirm({flowId:'flow',locationId:'other'})).rejects.toThrow();
 f.expire();await expect(f.source.confirm({flowId:'flow',locationId})).rejects.toThrow();expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it('D8 refuses a broker response for a different location without staging it',async()=>{
 const f=fixture();f.location('other');await expect(f.confirm()).rejects.toThrow();expect(f.host.activeBank()).toBeNull();
 expect(()=>f.host.prepare(auth,{flowId:'flow',versionId:'invented'})).toThrow();
});

it('D8 broker leases require the committed grant, epoch, location and exact scope evidence',async()=>{
 const f=fixture();await f.commit(await f.confirm());
 const view=f.source.ownerView()!;
 expect(view).toMatchObject({connectionId:'hl_'+locationId,state:'connected',scopes:['contacts.write']});
 const lease={grantId:'grant',credentialVersion:1,grantVersion:1,connectionEpoch:1,provenance:'oauth-token-response',userType:'Location',locationId,scopes:['contacts.write'],accessToken:'test-access-only',expiresAt:200000};
 const request={requestId:'lease-test',connectionId:view.connectionId,connectionEpoch:1,reason:'use' as const};
 f.fetcher.mockResolvedValueOnce(Response.json(lease));
 expect(await f.source.lease(request)).toMatchObject({accessToken:'test-access-only',connectionEpoch:1,locationId,discardAt:160000});
 for(const patch of [{grantId:'other'},{grantVersion:2},{credentialVersion:2},{connectionEpoch:2},{locationId:'other'},{scopes:['locations.readonly']},{expiresAt:99999}]){
  f.fetcher.mockResolvedValueOnce(Response.json({...lease,...patch}));
  await expect(f.source.lease(request)).rejects.toThrow(/connection lease/);
 }
 const calls=f.fetcher.mock.calls.length;
 await expect(f.source.lease({...request,connectionEpoch:2})).rejects.toThrow();expect(f.fetcher).toHaveBeenCalledTimes(calls);
});
it('D8 disconnect revokes the broker grant and commits a null bank before remaining disconnected',async()=>{
 const f=fixture();await f.commit(await f.confirm());
 f.fetcher.mockResolvedValueOnce(Response.json({revoked:true}));
 const intent=await f.source.disconnect('hl_'+locationId);
 expect(f.source.ownerView()).toBeNull();expect(f.source.hasConnection()).toBe(true);
 const bank=await f.commit(intent);expect(bank.connection).toBeNull();expect(bank.revision).toBe(2);
 expect(f.source.hasConnection()).toBe(false);expect(f.source.ownerView()).toBeNull();
 expect(await f.source.connection('hl_'+locationId)).toBeUndefined();
 await expect(f.source.lease({requestId:'old',connectionId:'hl_'+locationId,connectionEpoch:1,reason:'use'})).rejects.toThrow();
});

it('R2 disconnect never revokes before durable local save and survives a lost revoke response',async()=>{
 const f=fixture();const original=await f.commit(await f.confirm());let revoked=false;
 f.fetcher.mockImplementation(async()=>{revoked=true;throw Error('lost response after enrollment deletion');});
 const intent=await f.source.disconnect('hl_'+locationId);
 expect(revoked).toBe(false); // failed/abandoned bank save must leave enrollment usable
 expect(original.connection).not.toBeNull();
 const bank=await f.commit(intent);expect(revoked).toBe(true);expect(bank.connection).toBeNull();
 const restarted=new HighLevelCredentialCommit({bootstrap:{schema:1,commitCredential:credential,bank},hasRecoveryState:()=>false,readMetadata:()=>null,readConnectionEpoch:()=>2,activateMetadata:async()=>{}});
 expect(new HighLevelCredentialConnection(restarted,f.fetcher).ownerView()).toBeNull();
});
it('R2 disconnect retires both active sources before broker fallback',async()=>{
 const {HighLevelConnectionSource}=await import('./connection-source.ts');
 const f=fixture();await f.commit(await f.confirm());
 let legacy=true;
 const privateSource={ownerView:()=>legacy?{connectionId:'legacy'}:null,disconnect:()=>{legacy=false;return true;}};
 const source=new HighLevelConnectionSource(privateSource as never,f.source);
 const result=await source.disconnect('hl_'+locationId);
 expect(legacy).toBe(false);await f.commit(result!.intent!);expect(source.ownerView()).toBeNull();
});
