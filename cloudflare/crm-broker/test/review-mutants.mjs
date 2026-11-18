// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const base='cloudflare/crm-broker/',dir='evidence/afix-hl-c1-broker/mutants';mkdirSync(dir,{recursive:true});
const mutants=[
 ['M-REVIEW-ENROLL-UNFENCED','src/runtime-auth.ts','if(guard){','if(false){','R1:'],
 ['M-REVIEW-COMPLETE-UNGUARDED','src/grant.ts','if(input.completionIntent!==undefined){','if(false){','R2:'],
 ['M-REVIEW-COMPLETE-NO-DEADLINE','src/grant.ts','flow.expiresAt<=deps.now() || ','','R2: deadline'],
 ['M-REVIEW-COMPLETE-IGNORES-MISMATCH','src/grant.ts',"!(flow.status==='completing' && flow.completionIntent===input.completionIntent || flow.status==='completed' && prior)",'false','R2: mismatch'],
 ['M-REVIEW-REPLAY-SCANS-HISTORY','src/runtime-auth.ts','if(until<=at || (prior ?? 0)>at)', 'for(const [k,v]of await tx.list<number>({prefix:`rq:${id}:`}))if(v<=at)await tx.delete(k); if(until<=at || (prior ?? 0)>at)','R3-REPLAY:'],
 ['M-REVIEW-DISCONNECT-SCANS-HISTORY','src/flow.ts','const prefix=`flowhome:${homeId}:`,page=', 'await tx.list({prefix:"flow:"}); const prefix=`flowhome:${homeId}:`,page=','R3-DISCONNECT:'],
 ['M-REVIEW-ALARM-SCANS-HISTORY','src/grant.ts',"// Legacy history is backfilled once, in resumable bounded pages.","await tx.list({prefix:'grant:'}); // Legacy history is backfilled once, in resumable bounded pages.",'R3-ALARM:'],
 ['M-REVIEW-LEGACY-NO-RESUME','src/runtime-auth.ts','startAfter:cursor?.after,limit:STORAGE_PAGE_SIZE','limit:STORAGE_PAGE_SIZE','R3-ALARM:'],
 ['M-REVIEW-LEGACY-NO-CLEANUP','src/flow.ts','await legacyPage<number>(tx,"rq:")','new Map<string,number>()','R3-REPLAY:'],
 ['M-REVIEW-HOME-CLEANUP-NO-RESUME','src/flow.ts','await revokeHomeFlows(tx,job.homeId,job.generation,job.after);','void job;','R3-HOME-CLEANUP:'],
 ['M-REVIEW-BASELINE-CAPABILITY-ABSENT','test/starting-commit.test.mjs','return existsSync(path)?import(pathToFileURL(path).href):null;','return null;','BASE-'],
];
const results=[];
for(const[name,file,before,after,pattern]of mutants){const path=base+file,original=readFileSync(path,'utf8');
 try{if(!original.includes(before))throw Error(`Unreachable mutant ${name}`);writeFileSync(path,original.replace(before,after));
 const test=file.endsWith('.mjs')?'starting-commit.test.mjs':'review-regressions.test.ts';
 const run=spawnSync(process.execPath,['--experimental-strip-types','--test',`--test-name-pattern=${pattern}`,base+'test/'+test],{encoding:'utf8',timeout:60_000});
 const log=run.stdout+run.stderr;writeFileSync(`${dir}/${name}.log`,log);
 if(run.status!==1||!log.includes('AssertionError')||/SyntaxError|TypeError|ERR_MODULE_NOT_FOUND/.test(log))throw Error(`Not assertion-killed: ${name} (${run.status})`);
 results.push({name,exit:run.status,assertionKilled:true});console.log(`${name}: ASSERTION-KILLED`);
 }finally{writeFileSync(path,original);writeFileSync(`${dir}/results.json`,JSON.stringify(results,null,2)+'\n');}}
