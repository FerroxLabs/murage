// SPDX-License-Identifier: AGPL-3.0-or-later
// Scoped checks only, always invoked inside the network-none job container.
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
if(process.env.CI!=='1')throw Error('Requires isolated container');
const out='evidence/nolim-sql-r5';
const runs=[
 ['corpus',[ 'node_modules/vitest/vitest.mjs','run','server/no-limits-sql-r5.test.ts','server/no-limits-review-fix.test.ts','server/no-limits-wipe-cover.test.ts','--maxWorkers=5','--reporter=json','--outputFile='+out+'/final-corpus.json']],
 ['gates',['node_modules/vitest/vitest.mjs','run','server/no-limits-truly.test.ts','server/no-limits-inheritance.test.ts','server/decision/no-limits-truly.test.ts','server/full-access.test.ts','server/auto-approve.test.ts','scripts/no-limits-live/ruling-1019.test.mjs','--maxWorkers=5','--reporter=json','--outputFile='+out+'/final-gates.json']],
 ['typecheck',['node_modules/typescript/bin/tsc','-p','tsconfig.server.json']],
 ['proof',['--experimental-strip-types','scripts/verify-no-limits-sql-r5.mjs']],
 ['live',['--experimental-strip-types','scripts/no-limits-live/truly-proof.mjs',out+'/live-current'],{TRULY_ONLY:'truly-review-r5-'}],
];
const results=[];
for(const [name,args,env] of runs){
 const r=spawnSync(process.execPath,args,{env:{...process.env,...env},encoding:'utf8',timeout:420000,maxBuffer:24*1024*1024});
 writeFileSync(`${out}/final-${name}.log`,(r.stdout??'')+(r.stderr??''));
 results.push({name,code:r.status,signal:r.signal,error:r.error?.message});
 writeFileSync(out+'/final-status.json',JSON.stringify(results,null,2)+'\n');
 console.log(JSON.stringify(results.at(-1)));
}
if(results.some(row=>row.code!==0&&row.name!=='gates'))process.exitCode=1;
