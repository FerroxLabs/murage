import { candidatePaths, retiredEvidencePath } from './check-repository-custody.mjs';
import { archivedEvidencePath, freshEvidencePath, writeNewEvidence } from './evidence-path.mjs';
// SPDX-License-Identifier: AGPL-3.0-or-later
// Comparison at the job's starting production HEAD, with final tests unchanged.
// The pinned production bytes go only into a disposable source copy; the caller's checkout is never written.
import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,symlinkSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import { safeWipeSync } from '../server/testing/safe-wipe.mjs';
if(process.env.CI!=='1')throw Error('Use the isolated test container');
const source=process.cwd();
const files=[['shared/no-limits-raw-wipe.ts',archivedEvidencePath('evidence/wipe-final-r8/pre-fix-raw-wipe.ts')],['server/no-limits-wipe-scripts.ts',archivedEvidencePath('evidence/wipe-final-r8/start-wipe-scripts.ts')]];
const pinned=files.map(([,file])=>readFileSync(file));
// Every receipt is created fresh; refuse before running if any name is already taken.
const receipts=Object.fromEntries(['comparison-start.log','comparison-start.json','comparison-start.exit','comparison-start-api'].map(name=>[name,freshEvidencePath('evidence/wipe-final-r8/'+name)]));
const root=mkdtempSync(join(tmpdir(),'r8-compare-'));
let result;
try{
 for(const file of candidatePaths(source))if(!retiredEvidencePath(file)&&existsSync(join(source,file))){
  mkdirSync(dirname(join(root,file)),{recursive:true});cpSync(join(source,file),join(root,file));
 }
 symlinkSync(join(source,'node_modules'),join(root,'node_modules'),'dir');
 files.forEach(([file],index)=>writeFileSync(join(root,file),pinned[index]));
 const log=openSync(receipts['comparison-start.log'],'wx',0o600);
 try{
  result=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','server/no-limits','server/decision/no-limits','shared/no-limits','server/drivers/pi-permission-gate.test.ts','--fileParallelism','--maxWorkers=6','--reporter=json','--outputFile='+receipts['comparison-start.json']],{cwd:root,env:{...process.env,WIPE_FINAL_EVIDENCE:receipts['comparison-start-api']},stdio:['ignore',log,log],timeout:900000});
 }finally{closeSync(log);}
 writeNewEvidence('evidence/wipe-final-r8/comparison-start.exit',JSON.stringify({status:result.status,signal:result.signal,error:result.error?.message,productionHead:'4b9017da43bf023ab8094015e765dea03925fd1d'})+'\n');
}finally{
 if(!root.startsWith(join(tmpdir(),'r8-compare-')))throw Error('Refuse unexpected cleanup');
 safeWipeSync(root,{reason:'R8 comparison mkdtemp source copy'});
}
if(result?.status!==0&&result?.status!==1)throw Error('Incomplete comparison');
