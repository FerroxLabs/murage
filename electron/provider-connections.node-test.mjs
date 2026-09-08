import assert from "node:assert/strict";
import { test } from "node:test";
import { createSecureCredentialState } from "./secure-credential-state.mjs";
import { mutateProviderCredentials } from "./provider-connection-control.mjs";
import { parseProviderBank, providerBankRevision } from "./provider-connections.mjs";
import { migrateWorkspaceCredentials, workspaceCredentialEnv } from "./workspace-credentials.mjs";
function fixture() {
 let disk={unrelatedCredential:"PRESERVE_ME"},runtime="[]",sequence=0,failAcknowledgement=false;
 const secure=createSecureCredentialState(disk,async next=>{disk=structuredClone(next);});
 const options={packaged:true,updateDocument:(...args)=>secure.update(...args),createId:()=>`id-${++sequence}`,post:async(route,body)=>{
  assert.equal(route,"/api/provider-connections/replace");assert.equal(body.expectedRevision,providerBankRevision(runtime));runtime=body.bank;
  if(failAcknowledgement){failAcknowledgement=false;throw Error("lost acknowledgement fixture");}
  return{connections:parseProviderBank(runtime).map(({key,...row})=>row),storage:"encrypted"};
 }};
 return{options,disk:()=>disk,runtime:()=>runtime,fail:()=>{failAcknowledgement=true;}};
}
test("named model keys commit through the existing serialized encrypted document",async()=>{
 const f=fixture();const results=await Promise.all([mutateProviderCredentials({action:"create",preset:"openai",label:"Work",key:"sk-proj-FAKE_WORK_ONLY"},f.options),mutateProviderCredentials({action:"create",preset:"mistral",label:"Personal",key:"FAKE_MISTRAL_ONLY"},f.options)]);
 assert.equal(parseProviderBank(f.disk().modelProviderConnections).length,2);assert.equal(f.disk().unrelatedCredential,"PRESERVE_ME");assert.equal(JSON.stringify(results).includes("FAKE_"),false);
});
test("lost harness acknowledgement restores both old encrypted document and exact runtime revision",async()=>{
 const f=fixture();await mutateProviderCredentials({action:"create",preset:"openai",key:"sk-proj-FAKE_ORIGINAL"},f.options);const oldDisk=structuredClone(f.disk()),oldRuntime=f.runtime();f.fail();
 await assert.rejects(mutateProviderCredentials({action:"create",preset:"mistral",key:"FAKE_NEXT_ONLY"},f.options),/lost acknowledgement/);assert.deepEqual(f.disk(),oldDisk);assert.equal(f.runtime(),oldRuntime);
});
test("malformed or undecryptable previous banks are preserved rather than replaced",async()=>{
 const secure=createSecureCredentialState({modelProviderConnections:"CORRUPT"},async()=>{assert.fail("must not persist");});await assert.rejects(mutateProviderCredentials({action:"create",preset:"openai",key:"sk-proj-FAKE_ONLY"},{packaged:true,updateDocument:(...args)=>secure.update(...args),createId:()=>"test",post:async()=>assert.fail("must not dispatch")}),/unreadable/);
 const locked=createSecureCredentialState({},async()=>assert.fail("must not persist"),{writable:false});await assert.rejects(mutateProviderCredentials({action:"create",preset:"openai",key:"sk-proj-FAKE_ONLY"},{packaged:true,updateDocument:(...args)=>locked.update(...args),createId:()=>"test",post:async()=>assert.fail("must not dispatch")}),/could not be read/);
});
test("existing custody migration and environment carry one encrypted bank without erasing it on tombstones",()=>{
 const bank=JSON.stringify([{id:"id",revision:"revision",preset:"openai",label:"Work",enabled:true,key:"sk-proj-FAKE_ONLY"}]);const migrated=migrateWorkspaceCredentials({modelProviders:{bank}},{});
 assert.equal(migrated.credentials.modelProviderConnections,bank);assert.deepEqual(migrated.config.modelProviders,{});
 assert.equal(workspaceCredentialEnv(migrated.credentials).MURAGE_MODEL_PROVIDER_CONNECTIONS,bank);
 assert.equal(migrateWorkspaceCredentials({modelProviders:{bank:""}},migrated.credentials).credentials.modelProviderConnections,bank);
});
