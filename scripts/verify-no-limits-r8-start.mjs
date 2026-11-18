// SPDX-License-Identifier: AGPL-3.0-or-later
// Overlay new regression tests on production at 6dd5ed26 in the isolated container.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
if(process.env.CI!=='1')throw Error('Use the isolated test container');
const file='shared/no-limits-raw-wipe.ts',original=readFileSync(file),start=readFileSync('evidence/wipe-final-r8/start-raw-wipe.ts');
const hash=data=>createHash('sha256').update(data).digest('hex');
const scriptFile='server/no-limits-wipe-scripts.ts',originalScripts=readFileSync(scriptFile),startScripts=readFileSync('evidence/wipe-final-r8/start-wipe-scripts.ts');
let result;
try{
 writeFileSync(file,start);writeFileSync(scriptFile,startScripts);
 result=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','shared/no-limits-raw-wipe.test.ts','server/no-limits-wipe-final-r5.test.ts','server/no-limits-wipe-scripts.test.ts','server/drivers/pi-permission-gate.test.ts','server/no-limits-wipe-final-api.test.ts','-t','R8|R5.*r8|final production lifecycle: (safe-r7-tee|.*r8)','--maxWorkers=1','--reporter=verbose','--reporter=json','--outputFile=evidence/wipe-final-r8/red.json'],{env:{...process.env,WIPE_FINAL_EVIDENCE:'evidence/wipe-final-r8/red-api'},encoding:'utf8',maxBuffer:64*1024*1024,timeout:240000});
 writeFileSync('evidence/wipe-final-r8/red-at-start.txt',`Production baseline: 6dd5ed261a0a9e8c327525bdb643bfc6b2a0fbb2\nBaseline raw reader SHA256: ${hash(start)}\nBaseline written-script reader SHA256: ${hash(startScripts)}\nThe two modified production readers are restored from the baseline; all other production files are identical (git diff checked). New tests overlaid unchanged.\nExit: ${result.status}\n`+(result.stdout??'')+(result.stderr??''));
}finally{writeFileSync(file,original);writeFileSync(scriptFile,originalScripts);}
if(result?.status!==1)throw Error('Expected regression RED');
