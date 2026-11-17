// SPDX-License-Identifier: AGPL-3.0-or-later
// Comparison at the job's starting production HEAD, with final tests unchanged.
import {readFileSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
if(process.env.CI!=='1')throw Error('Use the isolated test container');
const files=[['shared/no-limits-raw-wipe.ts','evidence/wipe-final-r8/pre-fix-raw-wipe.ts'],['server/no-limits-wipe-scripts.ts','evidence/wipe-final-r8/start-wipe-scripts.ts']];
const originals=files.map(([file])=>readFileSync(file));
const log=openSync('evidence/wipe-final-r8/comparison-start.log','w');
let result;
try{
 for(const [file,baseline]of files)writeFileSync(file,readFileSync(baseline));
 result=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','server/no-limits','server/decision/no-limits','shared/no-limits','server/drivers/pi-permission-gate.test.ts','--fileParallelism','--maxWorkers=6','--reporter=json','--outputFile=evidence/wipe-final-r8/comparison-start.json'],{env:{...process.env,WIPE_FINAL_EVIDENCE:'evidence/wipe-final-r8/comparison-start-api'},stdio:['ignore',log,log],timeout:900000});
 writeFileSync('evidence/wipe-final-r8/comparison-start.exit',JSON.stringify({status:result.status,signal:result.signal,error:result.error?.message,productionHead:'4b9017da43bf023ab8094015e765dea03925fd1d'})+'\n');
}finally{
 files.forEach(([file],i)=>writeFileSync(file,originals[i]));closeSync(log);
}
if(result?.status!==0&&result?.status!==1)throw Error('Incomplete comparison');
