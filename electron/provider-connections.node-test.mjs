import assert from "node:assert/strict";
import { test } from "node:test";
import { createSecureCredentialState } from "./secure-credential-state.mjs";
import { createProviderBankReconciliation, fenceProviderDocumentUpdate, mutateProviderCredentials } from "./provider-connection-control.mjs";
import { mutateFluxCredentials } from "./flux-connection-control.mjs";
import { parseProviderBank, providerBankRevision } from "./provider-connections.mjs";
import { migrateWorkspaceCredentials, workspaceCredentialEnv } from "./workspace-credentials.mjs";
const REPLACE = "/api/provider-connections/replace";
/** Harness fake with the server's compare-and-swap rule. Each post/readback shifts one scripted
 * outcome: "ok" (default), "lose" (commit, then lose the acknowledgement), "refuse" (fail before commit), "fail" (readback). */
function fixture() {
 let disk={unrelatedCredential:"PRESERVE_ME"},runtime="[]",sequence=0,conflicts=0,readbacks=0;
 const plan={posts:[],readbacks:[]},posts=[],published=[];
 const secure=createSecureCredentialState(disk,async next=>{disk=structuredClone(next);});
 const post=async(route,body)=>{
  assert.equal(route,REPLACE);posts.push(body);
  const mode=plan.posts.shift()??"ok";
  if(mode==="refuse")throw Error("harness unreachable fixture");
  if(body.expectedRevision!==providerBankRevision(runtime)){conflicts++;throw Error("Model connections changed. Refresh before saving.");}
  runtime=body.bank;
  if(mode==="lose")throw Error("lost acknowledgement fixture");
  return{connections:parseProviderBank(runtime).map(({key,...row})=>row),storage:"encrypted"};
 };
 const reconciliation=createProviderBankReconciliation({readRevision:async()=>{readbacks++;if((plan.readbacks.shift()??"ok")==="fail")throw Error("readback unavailable fixture");return providerBankRevision(runtime);},publish:held=>published.push(held)});
 const options={packaged:true,updateDocument:(...args)=>secure.update(...args),createId:()=>`id-${++sequence}`,post,reconciliation};
 return{options,plan,posts,published,reconciliation,disk:()=>disk,runtime:()=>runtime,setRuntime:value=>{runtime=value;},conflicts:()=>conflicts,readbacks:()=>readbacks};
}
/** Original bank saved, then a save whose commit lands but whose acknowledgement and compensation both fail. */
async function uncertainFixture() {
 const f=fixture();await mutateProviderCredentials({action:"create",preset:"openai",key:"sk-proj-FAKE_ORIGINAL"},f.options);
 const oldDisk=structuredClone(f.disk()),oldRuntime=f.runtime();f.plan.posts.push("lose","refuse");
 await assert.rejects(mutateProviderCredentials({action:"create",preset:"mistral",key:"FAKE_NEXT_ONLY"},f.options),/could not be reconciled/);
 return{f,oldDisk,oldRuntime};
}
test("named model keys commit through the existing serialized encrypted document",async()=>{
 const f=fixture();const results=await Promise.all([mutateProviderCredentials({action:"create",preset:"openai",label:"Work",key:"sk-proj-FAKE_WORK_ONLY"},f.options),mutateProviderCredentials({action:"create",preset:"mistral",label:"Personal",key:"FAKE_MISTRAL_ONLY"},f.options)]);
 assert.equal(parseProviderBank(f.disk().modelProviderConnections).length,2);assert.equal(f.disk().unrelatedCredential,"PRESERVE_ME");assert.equal(JSON.stringify(results).includes("FAKE_"),false);
 assert.equal(f.conflicts(),0);assert.deepEqual(f.published,[]);assert.equal(f.readbacks(),0);
});
test("lost harness acknowledgement restores both old encrypted document and exact runtime revision",async()=>{
 const f=fixture();await mutateProviderCredentials({action:"create",preset:"openai",key:"sk-proj-FAKE_ORIGINAL"},f.options);const oldDisk=structuredClone(f.disk()),oldRuntime=f.runtime();f.plan.posts.push("lose");
 await assert.rejects(mutateProviderCredentials({action:"create",preset:"mistral",key:"FAKE_NEXT_ONLY"},f.options),/lost acknowledgement/);assert.deepEqual(f.disk(),oldDisk);assert.equal(f.runtime(),oldRuntime);
 // The rollback is confirmed by a second readback, never assumed from its acknowledgement.
 assert.equal(f.conflicts(),0);assert.equal(f.reconciliation.uncertain,false);assert.deepEqual(f.published,[true,false]);assert.equal(f.readbacks(),2);
});
test("a harness refusal before commit is confirmed by readback without a compensating write",async()=>{
 const f=fixture();await mutateProviderCredentials({action:"create",preset:"openai",key:"sk-proj-FAKE_ORIGINAL"},f.options);const oldDisk=structuredClone(f.disk()),oldRuntime=f.runtime(),postsBefore=f.posts.length;f.plan.posts.push("refuse");
 await assert.rejects(mutateProviderCredentials({action:"create",preset:"mistral",key:"FAKE_NEXT_ONLY"},f.options),/harness unreachable/);
 assert.deepEqual(f.disk(),oldDisk);assert.equal(f.runtime(),oldRuntime);assert.equal(f.posts.length,postsBefore+1);assert.equal(f.conflicts(),0);assert.equal(f.reconciliation.uncertain,false);
});
test("lost acknowledgement plus failed compensation keeps an explicit uncertain fence (B4)",async()=>{
 const{f,oldDisk,oldRuntime}=await uncertainFixture();
 // Disk explicitly holds the bank the caller was told survived; the live harness still holds the candidate.
 assert.deepEqual(f.disk(),oldDisk);assert.notEqual(f.runtime(),oldRuntime);assert.equal(parseProviderBank(f.runtime()).some(row=>row.preset==="mistral"),true);
 assert.equal(f.reconciliation.uncertain,true);assert.equal(f.published.at(-1),true);
});
test("an unavailable readback after a lost acknowledgement fences without a blind compensating write",async()=>{
 const f=fixture();await mutateProviderCredentials({action:"create",preset:"openai",key:"sk-proj-FAKE_ORIGINAL"},f.options);const oldDisk=structuredClone(f.disk()),postsBefore=f.posts.length;f.plan.posts.push("lose");f.plan.readbacks.push("fail");
 await assert.rejects(mutateProviderCredentials({action:"create",preset:"mistral",key:"FAKE_NEXT_ONLY"},f.options),/could not be reconciled/);
 assert.deepEqual(f.disk(),oldDisk);assert.equal(f.posts.length,postsBefore+1);assert.equal(f.reconciliation.uncertain,true);assert.equal(f.published.at(-1),true);
});
test("provider and Flux writes stay fenced while the harness revision cannot be read back",async()=>{
 const{f,oldDisk}=await uncertainFixture();const runtime=f.runtime(),postsBefore=f.posts.length;f.plan.readbacks.push("fail");
 await assert.rejects(mutateProviderCredentials({action:"create",preset:"openrouter",key:"sk-or-FAKE_BLOCKED"},f.options),/could not be reconciled/);
 assert.deepEqual(f.disk(),oldDisk);assert.equal(f.runtime(),runtime);assert.equal(f.posts.length,postsBefore);assert.equal(f.reconciliation.uncertain,true);
 f.plan.readbacks.push("fail");
 const flux={packaged:true,updateDocument:fenceProviderDocumentUpdate(f.options.updateDocument,{reconciliation:f.reconciliation,post:f.options.post}),post:async()=>assert.fail("Flux must not reserve the harness while the bank is uncertain")};
 await assert.rejects(mutateFluxCredentials({action:"replace",revision:"any",key:"sk-flux-FAKE_BLOCKED"},flux),/could not be reconciled/);
 assert.deepEqual(f.disk(),oldDisk);assert.equal(f.posts.length,postsBefore);assert.equal(f.reconciliation.uncertain,true);
});
test("a save already queued behind the uncertain save is fenced under the same queue",async()=>{
 const f=fixture();await mutateProviderCredentials({action:"create",preset:"openai",key:"sk-proj-FAKE_ORIGINAL"},f.options);const oldDisk=structuredClone(f.disk()),postsBefore=f.posts.length;
 f.plan.posts.push("lose","refuse");f.plan.readbacks.push("ok","fail");
 const first=mutateProviderCredentials({action:"create",preset:"mistral",key:"FAKE_NEXT_ONLY"},f.options);
 const queued=mutateProviderCredentials({action:"create",preset:"openrouter",key:"sk-or-FAKE_QUEUED"},f.options);
 await assert.rejects(first,/could not be reconciled/);await assert.rejects(queued,/could not be reconciled/);
 // Only the failed commit and its failed compensation reached the harness; the queued save never posted a stale revision.
 assert.equal(f.posts.length,postsBefore+2);assert.deepEqual(f.disk(),oldDisk);assert.equal(f.conflicts(),0);assert.equal(f.reconciliation.uncertain,true);
});
test("the next write reconciles by revision readback, confirms rollback, then saves",async()=>{
 const{f,oldDisk}=await uncertainFixture();
 await mutateProviderCredentials({action:"create",preset:"openrouter",label:"After",key:"sk-or-FAKE_AFTER"},f.options);
 const bank=parseProviderBank(f.disk().modelProviderConnections);
 assert.deepEqual(bank.map(row=>row.preset),["openai","openrouter"]);assert.equal(f.runtime(),f.disk().modelProviderConnections);assert.equal(f.disk().unrelatedCredential,oldDisk.unrelatedCredential);
 assert.equal(f.reconciliation.uncertain,false);assert.equal(f.published.at(-1),false);assert.equal(f.conflicts(),0);
});
test("a harness restarted from the encrypted document releases the fence at startup readback without a compensating write",async()=>{
 const{f,oldDisk}=await uncertainFixture();const postsBefore=f.posts.length;
 f.setRuntime(f.disk().modelProviderConnections);
 await f.reconciliation.settle({diskBank:f.disk().modelProviderConnections,post:f.options.post});
 assert.equal(f.reconciliation.uncertain,false);assert.equal(f.posts.length,postsBefore);assert.deepEqual(f.disk(),oldDisk);assert.equal(f.published.at(-1),false);
 await mutateProviderCredentials({action:"create",preset:"openrouter",key:"sk-or-FAKE_AFTER"},f.options);assert.equal(parseProviderBank(f.disk().modelProviderConnections).length,2);
});
test("a competing successor revision is refused rather than overwritten",async()=>{
 const{f,oldDisk}=await uncertainFixture();const postsBefore=f.posts.length;
 const successor=JSON.stringify([{id:"successor",preset:"groq",label:"Successor",enabled:true,key:"gsk_FAKE_SUCCESSOR",revision:"successor"}]);f.setRuntime(successor);
 await assert.rejects(mutateProviderCredentials({action:"create",preset:"openrouter",key:"sk-or-FAKE_BLOCKED"},f.options),/could not be reconciled/);
 await assert.rejects(f.reconciliation.settle({diskBank:f.disk().modelProviderConnections,post:f.options.post}),/could not be reconciled/);
 assert.equal(f.runtime(),successor);assert.deepEqual(f.disk(),oldDisk);assert.equal(f.posts.length,postsBefore);assert.equal(f.reconciliation.uncertain,true);
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
