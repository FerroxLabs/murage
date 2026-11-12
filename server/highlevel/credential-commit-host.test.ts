import {expect,it} from 'vitest';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startHighLevelCredentialCommit} from './credential-commit-host.ts';
import {removeTempDirSync} from '../testing/cleanup.ts';
import type {HighLevelSecretBank} from './credential-commit.ts';
const credential='a'.repeat(64),auth=`Bearer ${credential}`;
const connection={connectionId:'connection-fixture',credentialVersion:1,grantId:'grant-fixture',enrollmentId:'home-fixture',runtimeCapability:'runtime-fixture-'.repeat(4),grantCapability:'grant-fixture-'.repeat(4)};
const stage={flowId:'flow-fixture',versionId:'version-fixture',expectedRevision:0,expectedEpoch:0,connection,metadata:{connectionId:connection.connectionId,credentialVersion:1,grantId:connection.grantId,locationId:'location-fixture',connectionEpoch:1,scopes:['contacts.write'],provenance:'oauth-token-response' as const}};
function parent(bank:HighLevelSecretBank|null=null){const events=new EventEmitter();return Object.assign(events,{postMessage(message:any){if(message.type==='murage:highlevel-bootstrap-request')events.emit('message',{data:{type:'murage:highlevel-bootstrap',requestId:message.requestId,bootstrap:{schema:1,commitCredential:credential,bank}}});}});}
it('D8 boot persists only metadata, restores the matching bank and refuses a lost-key replacement',async()=>{
 const root=mkdtempSync(join(tmpdir(),'murage-highlevel-credential-host-'));
 try{
  const port=parent(),host=await startHighLevelCredentialCommit(port,root,()=>false);
  port.emit('message',{data:{type:'murage:highlevel-stage-credential',stage}});
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
