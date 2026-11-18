// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const path='cloudflare/crm-broker/src/grant.ts',original=readFileSync(path,'utf8');
const finalizeStart=original.indexOf('    return storage.transaction(async tx=>{\n      const current=');
const finalizeEnd=original.indexOf('\n  }\n  return {',finalizeStart);
if(finalizeStart<0||finalizeEnd<0)throw Error('Missing checked rotation transaction');
const finalize=original.slice(finalizeStart,finalizeEnd);
const unsafeLease="return accessLeaseSchema.parse({...meta(before),accessToken:c.accessToken,expiresAt:Math.min(c.expiresAt-60_000,deps.now()+MAX_LEASE_MS)});";
const mutants=[
 ['M-BROKER-LEASE-CARRIES-REFRESH',[['return accessLeaseSchema.parse({...meta(r),accessToken:decoder.decode(access),expiresAt:Math.min(r.accessExpiresAt-60_000,deps.now()+MAX_LEASE_MS)});',"return {...accessLeaseSchema.parse({...meta(r),accessToken:decoder.decode(access),expiresAt:Math.min(r.accessExpiresAt-60_000,deps.now()+MAX_LEASE_MS)}),refreshToken:decoder.decode((await deps.master.open('refresh',r.grantId,r.rotation+1,r.refreshSealed!))!)};"]]],
 ['M-LEASE-BEFORE-PERSIST',[[finalize,`    if(!c||!sealed)return refusal('reconnect_required'); ${unsafeLease}`]]],
 ['M-REFRESH-RESURRECT',[[finalize,`    if(!c||!sealed)return refusal('reconnect_required'); await storage.put(\`grant:\${before.grantId}\`,{...before,...sealed,rotation,accessExpiresAt:c.expiresAt}); ${unsafeLease}`]]],
 ['M-REFRESH-UNSERIALIZED',[['return await serial(req.grantId,()=>leaseWork(b,req,cap));','return await leaseWork(b,req,cap);']]],
 ['M-NARROW-KEEPS-VERSION',[['before.credentialVersion+(changed?1:0)','before.credentialVersion']]],
 ['M-ROTATION-BUMPS-VERSION',[['before.credentialVersion+(changed?1:0)','before.credentialVersion+1']]],
 ['M-REFRESH-LOCATION-DRIFT',[['c.locationId===before.locationId','true']]],
 ['M-LEASE-SKIP-GRANT-CAP',[['!await matchesCapability(cap,r.grantCapHash)','false']]],
 ['M-REPLACE-REVOKES-BEFORE-ACK',[["// A home has exactly one pending replacement; older pending grants die.","if(home.activeGrantId){const old=await tx.get<GrantRecord>(`grant:${home.activeGrantId}`);if(old)await retire(tx,old,'premature_replacement',now);}\n        // A home has exactly one pending replacement; older pending grants die."]]],
 ['M-FLOW-GENERATION-UNCHECKED',[["if(input.homeGeneration!==undefined && input.homeGeneration!==home.generation)throw new GrantStoreFailure('conflict');",'']]],
 ['M-HOME-GENERATION-UNCHECKED' ,[['home.generation!==r.generation','false']]],
 ['M-DISCONNECT-KEEPS-PENDING',[["if(grant)await retire(tx,grant,'owner_disconnect',deps.now());","if(grant && grant.state!=='pending_ack')await retire(tx,grant,'owner_disconnect',deps.now());"]]],
 ['M-ROTATION-CRASH-RESEND',[["if(r.refreshIntent!==undefined){await retire(tx,r,'uncertain_rotation',deps.now(),'reconnect_required');return refusal('reconnect_required');}",'']]],
 ['M-REFRESH-COMPANY-DRIFT',[['c.companyId===before.companyId','true']]],
 ['M-LEASE-UNBOUNDED',[['Math.min(r.accessExpiresAt-60_000,deps.now()+MAX_LEASE_MS)','r.accessExpiresAt-60_000']]],
];
mkdirSync('evidence/hl-c1-broker/grant-mutants',{recursive:true});const results=[];
try{for(const[name,patches]of mutants){let source=original;for(const[before,after]of patches){if(!source.includes(before))throw Error(`Unreachable ${name}`);source=source.replaceAll(before,after);}writeFileSync(path,source);
 const run=spawnSync(process.execPath,['--experimental-strip-types','--test','cloudflare/crm-broker/test/grant.test.ts'],{encoding:'utf8',timeout:60_000});const log=run.stdout+run.stderr;writeFileSync(`evidence/hl-c1-broker/grant-mutants/${name}.log`,log);
 if(run.status!==1||!log.includes('AssertionError')||/SyntaxError|ERR_MODULE_NOT_FOUND/.test(log))throw Error(`Not assertion-killed: ${name}, exit ${run.status}`);
 results.push({name,exit:run.status,assertionKilled:true});console.log(`${name}: ASSERTION-KILLED`);writeFileSync(path,original);
}}finally{writeFileSync(path,original);writeFileSync('evidence/hl-c1-broker/grant-mutants/results.json',JSON.stringify(results,null,2)+'\n');}
