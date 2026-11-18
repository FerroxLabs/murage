// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const base='cloudflare/crm-broker/src/',dir='evidence/hl-c1-r2/mutants';mkdirSync(dir,{recursive:true});
const mutants=[
 ['M-HANDLER-REREADS-BODY','grant.ts','parseVerified(verified.body)','JSON.parse(await req.clone().text())','T-RT-VERIFIED-BYTES'],
 ['M-LEASE-ROUTE-SKIP-VERIFY','grant.ts','await d.verifier.verifyRequest(req,route)','{binding:JSON.parse(await req.clone().text()),body:new TextEncoder().encode(await req.clone().text())}','T-RT-LEASE-ROUTE'],
 ['M-LEASE-ROUTE-SKIP-BINDING-COMPARE','grant.ts','!sameBinding(verified.binding,parsed.data)','false','T-HANDLER-ADMISSION'],
 ['M-DISCONNECT-ROUTE-SKIP-GRANT-CAP','grant.ts','if(!cap || !/^[A-Za-z0-9_-]{43}$/u.test(cap))','if(false)','T-HANDLER-ADMISSION'],
 ['M-HELD-UNDER-MASTER','seal.ts',"capabilitySealer(capability).seal('held',flowId,1,privateBytes)","masterSealer(encode64(new Uint8Array(32).fill(19))).seal('held',flowId,1,privateBytes)",'T-HELD-DUMP'],
 ['M-PREVIEW-PLAINTEXT','flow.ts','heldSealed:await sealHeld(rec.recipientPublic,rec.flowId,encoder.encode(JSON.stringify(c)))','heldSealed:await sealHeld(rec.recipientPublic,rec.flowId,encoder.encode(JSON.stringify(c))),heldPreview:c','T-HELD-DUMP'],
 ['M-CALLBACK-REEXCHANGE','flow.ts','if(rec.status!=="begun")','if(rec.status!=="begun" && rec.status!=="called_back")','T-CALLBACK-CRASH'],
 ['M-GLOBAL-AUTHORITY','route.ts','return hex(new Uint8Array(signature)).slice(0,32);','return "0".repeat(32);','T-HOME-ROUTE'],
 ['M-STATE-EXPOSES-HOME','flow.ts','decodeHex(await homeRouteTag(d.routeMaster,binding.homeId))','encoder.encode(binding.homeId).slice(0,16)','T-HOME-ROUTE'],
 ['M-STORE-PER-REQUEST','route.ts','if(existing)return existing;','if(false)return existing!;','T-ONE-INSTANCE'],
 ['M-IP-ADMISSION-FAIL-OPEN','flow.ts','if(!admitted)return fail("rate_limited");','if(false)return fail("rate_limited");','T-IP-ADMISSION'],
 ['M-LOCATION-LATE-HELD','flow.ts','if(expiredAfterLookup)','if(false)','T-LOCATION-DEADLINE'],
 ['M-LOCATION-NAME-UNBOUNDED','flow.ts','if(size>65536)return c.locationId;','','T-LOCATION-NAME'],
 ['M-LOCATION-NAME-NO-SCOPE','flow.ts','if(!c.scopes.includes("locations.readonly"))return c.locationId;','','T-LOCATION-NAME'],
 ['M-LOCATION-NAME-NO-TIMEOUT','flow.ts','resolve(c.locationId);},10_000);','resolve(c.locationId);},20_000);','T-LOCATION-TIMEOUT'],
 ['M-CALLBACK-EXPIRED-JSON','flow.ts','if(!rec) return callbackPage("expired",404);','if(!rec) return fail("not_found");','T-EXPIRED-HTML'],
 ['M-DISCONNECT-SKIPS-FLOWS','grant.ts','await revokeHomeFlows(tx,r.binding.homeId,home.generation);','void 0;','T-DISCONNECT-DURING-COMPLETE'],
];
const results=[];
for(const[name,file,before,after,pattern]of mutants.filter(m=>!process.argv[2] || new RegExp(process.argv[2]).test(m[0]))){const path=base+file,original=readFileSync(path,'utf8');try{
 if(!original.includes(before))throw Error(`Unreachable mutant ${name}`);let changed=original.replace(before,after);if(name==='M-CALLBACK-REEXCHANGE')changed=changed.replace('d.flows.cas(rec.flowId,"begun",{...rec,status:"called_back"})','d.flows.cas(rec.flowId,rec.status,{...rec,status:"called_back"})');writeFileSync(path,changed);
 const r=spawnSync(process.execPath,['--experimental-strip-types','--test',`--test-name-pattern=${pattern}`,'cloudflare/crm-broker/test/r2.test.mjs'],{encoding:'utf8',timeout:60_000});const log=r.stdout+r.stderr;writeFileSync(`${dir}/${name}.log`,log);
 if(r.status!==1||!log.includes('AssertionError')||/SyntaxError|TypeError|ERR_MODULE_NOT_FOUND/.test(log))throw Error(`Not assertion-killed ${name}: ${r.status}`);
 results.push({name,assertionKilled:true});console.log(`${name}: ASSERTION-KILLED`);
 }finally{writeFileSync(path,original);writeFileSync(`${dir}/results.json`,JSON.stringify(results,null,2)+'\n');}}
