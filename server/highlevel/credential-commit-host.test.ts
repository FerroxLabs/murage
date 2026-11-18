import {expect,it} from 'vitest';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startHighLevelCredentialCommit} from './credential-commit-host.ts';
import {removeTempDirSync} from '../testing/cleanup.ts';
import type {HighLevelSecretBank} from './credential-commit.ts';
const credential='a'.repeat(64),auth=`Bearer ${credential}`;
const connection={connectionId:'connection-fixture',credentialVersion:1,grantId:'grant-fixture',enrollmentId:'home-fixture',runtimeCapability:Buffer.alloc(32,7).toString('base64url'),grantCapability:'grant-fixture-'.repeat(4)};
const stage={flowId:'flow-fixture',versionId:'version-fixture',expectedRevision:0,expectedEpoch:0,connection,metadata:{connectionId:connection.connectionId,credentialVersion:1,grantId:connection.grantId,locationId:'location-fixture',connectionEpoch:1,scopes:['contacts.write'],provenance:'oauth-token-response' as const}};
function parent(bank:HighLevelSecretBank|null=null){const events=new EventEmitter();return Object.assign(events,{postMessage(message:any){if(message.type==='murage:highlevel-bootstrap-request')events.emit('message',{data:{type:'murage:highlevel-bootstrap',requestId:message.requestId,bootstrap:{schema:1,commitCredential:credential,bank}}});}});}
it('D8 boot persists only metadata, restores the matching bank and refuses a lost-key replacement',async()=>{
 const root=mkdtempSync(join(tmpdir(),'murage-highlevel-credential-host-'));
 try{
  const port=parent(),host=await startHighLevelCredentialCommit(port,root,()=>false);
  host.stage(stage);
  const proposal=host.prepare(auth,{flowId:stage.flowId,versionId:stage.versionId});
  const bank:HighLevelSecretBank={schema:1,revision:1,locatorKey:'K'.repeat(43),connection};await host.commit(auth,{commitId:proposal.commitId,bank});
  const bytes=readFileSync(join(root,'highlevel','credential-metadata.json'),'utf8');expect(bytes).not.toContain(connection.runtimeCapability);expect(bytes).not.toContain(bank.locatorKey);
  const restored=await startHighLevelCredentialCommit(parent(bank),root,()=>false);expect(restored.activeBank()).toEqual(bank);
  const lost=await startHighLevelCredentialCommit(parent(),root,()=>false);expect(()=>lost.stage({...stage,expectedEpoch:1,metadata:{...stage.metadata,connectionEpoch:2}})).toThrow('locator key unavailable');
 }finally{removeTempDirSync(root);}
});
it('D8 unreadable recovery or metadata cannot create a new locator key',async()=>{
 const root=mkdtempSync(join(tmpdir(),'murage-highlevel-credential-damage-')),directory=join(root,'highlevel');mkdirSync(directory);
 try{
  writeFileSync(join(directory,'unrecognized-recovery'),'kept');
  const host=await startHighLevelCredentialCommit(parent(),root,()=>false);expect(()=>host.stage(stage)).toThrow('locator key unavailable');
  const file=join(directory,'credential-metadata.json');writeFileSync(file,'{"epoch":');
  await expect(startHighLevelCredentialCommit(parent(),root,()=>false)).rejects.toThrow();expect(readFileSync(file,'utf8')).toBe('{"epoch":');
 }finally{removeTempDirSync(root);}
});
it('D8 a retained bank with missing epoch metadata cannot reset the connection epoch',async()=>{
 const root=mkdtempSync(join(tmpdir(),'murage-highlevel-credential-lost-epoch-'));
 try {
  const bank:HighLevelSecretBank={schema:1,revision:7,locatorKey:'K'.repeat(43),connection};
  await expect(startHighLevelCredentialCommit(parent(bank),root,()=>false)).rejects.toThrow('credential metadata unavailable');
 }finally{removeTempDirSync(root);}
});

// Exercise both durable files through the production Electron bridge and host.
// Restart discards every launch-scoped object; only the files and fake broker survive.
import {HighLevelCredentialConnection} from './credential-connection.ts';
import {createHighLevelCredentialBridge} from '../../electron/highlevel-credentials.mjs';
import {writeFileAtomic} from '../atomic.ts';
import {chmodSync} from 'node:fs';
async function disconnectFixture(){
 const root=mkdtempSync(join(tmpdir(),'murage-highlevel-disconnect-r3-')),secure=join(root,'fake-encrypted-bank.json');
 let host:Awaited<ReturnType<typeof startHighLevelCredentialCommit>>,source:HighLevelCredentialConnection;
 let failSave=false,interruptCommit=false,remoteFailure='none',revoked=false,revokes=0,signedBegins=0;
 const fetcher:typeof fetch=async(input,init)=>{
  const url=new URL(String(input)),headers=new Headers(init?.headers);
  if(url.pathname.endsWith('/disconnect')){
   revokes++;expect(headers.has('x-murage-runtime')).toBe(true);
   if(revoked)return Response.json({error:'revoked enrollment'},{status:401});
   if(remoteFailure==='before')throw Error('offline before revoke');
   revoked=true;if(remoteFailure==='after')throw Error('lost response after revoke');
   return Response.json({revoked:true});
  }
  if(headers.has('x-murage-runtime')){signedBegins++;if(revoked)return Response.json({error:'unauthorized'},{status:401});}
  if(url.pathname.endsWith('/begin'))return Response.json({flowId:'new-flow',authorizationUrl:'https://marketplace.leadconnectorhq.com/v2/oauth/chooselocation?state=fixture',completionCapability:'completion-fixture-'.repeat(4),expiresAt:Date.now()+600000});
  throw Error('unexpected broker request');
 };
 const boot=async()=>{
  const bank=(()=>{try{return JSON.parse(readFileSync(secure,'utf8')).highlevelBank;}catch{return null;}})();
  host=await startHighLevelCredentialCommit(parent(bank),root,()=>false);source=new HighLevelCredentialConnection(host,fetcher);
  return createHighLevelCredentialBridge({commitCredential:credential,readDocument:()=>{try{return JSON.parse(readFileSync(secure,'utf8'));}catch{return {};}},assertSafeStorage:async()=>{},
   updateDocument:async(derive:any)=>{if(failSave)throw Error('secure save failed');let previous={};try{previous=JSON.parse(readFileSync(secure,'utf8'));}catch{}writeFileAtomic(secure,JSON.stringify(derive(previous)),{mode:0o600,syncDir:true});},
   request:async(route:string,body:any)=>{if(route==='prepare')return host.prepare(auth,body);if(interruptCommit)throw Error('process stopped after secure save');return host.commit(auth,body);}});
 };
 const bridge=await boot();expect(await bridge.commit(host!.stage(stage))).toEqual({ok:true});
 return {root,secure,bridge,boot,host:()=>host!,source:()=>source!,failSave:()=>{failSave=true;},interrupt:()=>{interruptCommit=true;},remote:(value:string)=>{remoteFailure=value;},revoked:()=>revoked,revokes:()=>revokes,signedBegins:()=>signedBegins,
  state:()=>JSON.parse(readFileSync(join(root,'highlevel','credential-metadata.json'),'utf8'))};
}
for(const boundary of ['crash-after-bank','metadata-write-failed'] as const){
 it(`R3 restart completes durable disconnect at ${boundary} before fresh unsigned sign-in`,async()=>{
  const f=await disconnectFixture();
  try{
   const intent=await f.source().disconnect(connection.connectionId);
   if(boundary==='crash-after-bank')f.interrupt();
   else chmodSync(join(f.root,'highlevel'),0o500); // real EACCES at metadata atomic write
   expect(await f.bridge.commit(intent)).toMatchObject({ok:false,error:'outcome_unknown'});
   chmodSync(join(f.root,'highlevel'),0o700);
   expect(f.state().metadata).not.toBeNull();expect(f.revokes()).toBe(0);
   expect(JSON.parse(readFileSync(f.secure,'utf8')).highlevelBank.connection).toBeNull();
   await f.boot();expect(f.source().ownerView()).toBeNull();expect(f.state()).toEqual({epoch:2,metadata:null});
   await f.source().begin({});expect(f.revoked()).toBe(true);expect(f.signedBegins()).toBe(0);
   expect(f.host().connectionState().bank?.locatorKey).toBe(JSON.parse(readFileSync(f.secure,'utf8')).highlevelBank.locatorKey);
   const publicBytes=readFileSync(join(f.root,'highlevel','credential-metadata.json'),'utf8');expect(publicBytes).not.toContain(connection.runtimeCapability);
  }finally{chmodSync(join(f.root,'highlevel'),0o700);removeTempDirSync(f.root);}
 });
}
it('R3 failed secure persistence never revokes and restart still has a usable enrolled bank',async()=>{
 const f=await disconnectFixture();try{
  const intent=await f.source().disconnect(connection.connectionId);f.failSave();
  expect(await f.bridge.commit(intent)).toEqual({ok:false,error:'storage'});expect(f.revokes()).toBe(0);
  await f.boot();expect(f.source().ownerView()).toMatchObject({state:'connected'});
  await f.source().begin({});expect(f.signedBegins()).toBe(1);expect(f.revoked()).toBe(false);
 }finally{removeTempDirSync(f.root);}
});
for(const failure of ['before','after'])it(`R3 remote failure ${failure} deletion retains durable retry through restart without signing in as a revoked enrollment`,async()=>{
 const f=await disconnectFixture();try{
  f.remote(failure);expect(await f.bridge.commit(await f.source().disconnect(connection.connectionId))).toEqual({ok:true});
  expect(f.revokes()).toBe(1);expect(f.state()).toEqual({epoch:2,metadata:null});
  await f.boot();expect(f.source().ownerView()).toBeNull();
  f.remote('none');await f.source().begin({});expect(f.revokes()).toBe(2);expect(f.revoked()).toBe(true);expect(f.signedBegins()).toBe(0);
  expect(JSON.parse(readFileSync(f.secure,'utf8')).highlevelBank.disconnect.connection.enrollmentId).toBe(connection.enrollmentId);
 }finally{removeTempDirSync(f.root);}
});
