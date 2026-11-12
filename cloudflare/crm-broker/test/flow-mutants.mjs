// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const base='cloudflare/crm-broker/src/';
const originals=new Map(['flow.ts','runtime-auth.ts','seal.ts'].map(p=>[p,readFileSync(base+p,'utf8')]));
const mutants=[
 ['M-FLOW-NO-RESPONSE-TYPE','flow.ts','response_type:"code",','','T-AUTHORIZATION-URL'],
 ['M-RUNTIME-PRE-BODY-CLOCK','runtime-auth.ts','const now=this.now();','const now=startedAt;','T-RT-DELAYED-BODY'],
 ['M-RUNTIME-EXPIRED-REPLAY-DEADLINE','runtime-auth.ts','until<=at || ','','T-RT-REPLAY-DEADLINE'],
 ['M-FLOW-CALLBACK-CLAIMS','flow.ts','const c={...result.credentials,locationName:result.credentials.locationId};','const c={...result.credentials,locationName:result.credentials.locationId}; await d.grants.createPending({binding:rec.binding,credentials:c,connectionEpoch:rec.beginEpoch});'],
 ['M-FLOW-STATE-AS-CAPABILITY','flow.ts','capability=encode64(d.random(32))','capability=state'],
 ['M-FLOW-NO-EXPIRY','flow.ts','d.now()>=rec.expiresAt','false'],
 ['M-FLOW-SKIP-BINDING','flow.ts','!sameBinding(rec.binding,input)','false'],
 ['M-FLOW-PLAINTEXT-HELD','flow.ts','heldSealed:await sealHeld(rec.recipientPublic,rec.flowId,encoder.encode(JSON.stringify(c)))','heldSealed:JSON.stringify(c)'],
 ['M-RUNTIME-SIG-SKIP-BODY','runtime-auth.ts','await sha256(bytes)','await sha256(new Uint8Array())','T-RT-EMPTY-BODY-SUBSTITUTION'],
 ['M-RUNTIME-SIG-SKIP-METHOD','runtime-auth.ts','canonicalRuntimeMessage(route,request.method,env,','canonicalRuntimeMessage(route,"GET",env,'],
 ['M-RUNTIME-REPLAY-ALLOWED','runtime-auth.ts','if (await this.store.markRequest(env.runtimePrincipalId,env.requestId,now+REPLAY_WINDOW_MS) !== "fresh") return null;',''],
 ['M-RUNTIME-UNSIGNED-ENROLLED','flow.ts','if(existing || req.headers.has(RUNTIME_HEADER))','if(false)'],
 ['M-SEAL-NO-AAD','seal.ts','additionalData:aad(kind,id,v)','additionalData:new Uint8Array()'],
 ['M-ENROLL-NONCANONICAL','flow.ts','if(input.runtimePrincipalId!==input.homeId || input.runtimePrincipalId!==input.installationId || input.contentOwnerId!=="owner")','if(false)'],
 ['M-FLOW-NO-CRASH-INTENT','flow.ts','completionId:rec.flowId,grantCapability:intent.grantCapability,',''],
 ['M-FLOW-DENIAL-SUCCESS-COPY','flow.ts','HighLevel was not connected. Go back to Murage to try again.','HighLevel is connected to Murage.'],
];
mkdirSync('evidence/hl-c1-broker/flow-mutants',{recursive:true});
const results=[];
try{
 for(const [name,file,before,after,pattern]of mutants){const original=originals.get(file);if(!original.includes(before))throw Error(`Unreachable ${name}`);
  let changed=original.replaceAll(before,after);
  if(name==='M-RUNTIME-PRE-BODY-CLOCK')changed=changed.replace('const env=parsed.data;','const env=parsed.data, startedAt=this.now();');
  writeFileSync(base+file,changed);
  const run=spawnSync(process.execPath,['--experimental-strip-types','--test',...(pattern?[`--test-name-pattern=${pattern}`]:[]),'cloudflare/crm-broker/test/flow.test.ts'],{encoding:'utf8',timeout:60_000});
  const log=run.stdout+run.stderr;writeFileSync(`evidence/hl-c1-broker/flow-mutants/${name}.log`,log);
  if(run.status!==1 || !log.includes('AssertionError') || /SyntaxError|ERR_MODULE_NOT_FOUND/.test(log))throw Error(`Not assertion-killed: ${name}, exit ${run.status}`);
  if(name==='M-RUNTIME-SIG-SKIP-BODY' && !/200 !== 401/u.test(log))throw Error('Empty-body substitution must change unauthorized to success');
  results.push({name,exit:run.status,assertionKilled:true,...(pattern?{test:pattern}:{})});console.log(`${name}: ASSERTION-KILLED`);writeFileSync(base+file,original);
 }
}finally{for(const[file,original]of originals)writeFileSync(base+file,original);writeFileSync('evidence/hl-c1-broker/flow-mutants/results.json',JSON.stringify(results,null,2)+'\n');}
