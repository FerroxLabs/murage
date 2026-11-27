import { archivedEvidencePath, evidencePath, freshEvidencePath, writeNewEvidence } from './evidence-path.mjs';
// Identical assertions and workflow judges in isolated base/head source fixtures.
import {cpSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import { safeWipeSync } from '../server/testing/safe-wipe.mjs';
const [mode,kind,shard='0',total='1']=process.argv.slice(2);
if(!['decision','workflow','index','project','muse','harness','wait','strict'].includes(kind))throw Error('Explicit verification kind required');
if(!Number.isInteger(Number(shard))||!Number.isInteger(Number(total))||Number(total)<1||Number(shard)<0||Number(shard)>=Number(total))throw Error('Invalid verification shard');
const source=process.cwd(),capture=`evidence/afix-gnl-prod-r5/${mode}-${kind}-${shard}`,out=resolve(evidencePath(capture));
mkdirSync(out,{recursive:true});
// Every receipt is created fresh; refuse before running if any name is already taken.
for(const name of ['manifest.json','run.log','rc.json','results.json','workflow'])freshEvidencePath(capture+'/'+name);
const root=mkdtempSync(join(tmpdir(),'afix-gnl-r5-'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
try{
 for(const entry of ['server','scripts','docs','shared','src','electron','extensions','companion','tools','cloudflare','apps','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','vite.config.ts','tsconfig.json','tsconfig.server.json'])cpSync(entry,join(root,entry),{recursive:true});
 symlinkSync(join(source,'node_modules'),join(root,'node_modules'),'dir');
 // Historical fixture inventories are inputs, never a target for mutations.
 // Archived reports, the historical test list and cell plan are read from MURAGE_EVIDENCE_ARCHIVE.
 const baseline=JSON.parse(readFileSync(archivedEvidencePath('evidence/afix-gnl-prod-r5/base-runtime.json')));
 if(mode.startsWith('base'))for(const [file,bytes]of Object.entries(baseline.files))writeFileSync(join(root,file),bytes);
 if(mode.startsWith('historical'))for(const [file,record]of Object.entries(JSON.parse(readFileSync(archivedEvidencePath('evidence/gnl-prod-r5/baseline-runtime.json'))).files))writeFileSync(join(root,file),record.bytes);
 if(mode==='plan-mutant')writeFileSync(join(root,'scripts/no-limits-live/fakes/release-plan.mjs'),JSON.parse(readFileSync(archivedEvidencePath('evidence/afix-gnl-prod-r5/plan-mutant.json'))).bytes);
 const tests=JSON.parse(readFileSync(process.env.GNL_AFIX_TEST_LIST??archivedEvidencePath('evidence/gnl-prod-r5/complete-tests.json'))).filter((_,i)=>i%Number(total)===Number(shard));
 const files=Object.keys(baseline.files);
 const manifest={mode,kind,shard,total,base:baseline.sha,runtimeHashes:Object.fromEntries(files.map(f=>[f,hash(readFileSync(join(root,f)))])),testHashes:Object.fromEntries(tests.map(f=>[f,hash(readFileSync(join(root,f)))])),tests};
 writeNewEvidence(capture+'/manifest.json',JSON.stringify(manifest,null,2));
 let cmd,args;
 if(kind==='decision'){cmd=process.execPath;args=[join(root,'node_modules/vitest/vitest.mjs'),'run',...tests,'--maxWorkers=1','--reporter=json','--outputFile='+join(out,'results.json')];}
 else if(kind==='strict'){cmd=process.execPath;args=[join(root,'node_modules/vitest/vitest.mjs'),'run','server/drivers/muse-code.test.ts','--testNamePattern=P-MUSE strict|P-MUSE acknowledged','--maxWorkers=1','--reporter=json','--outputFile='+join(out,'results.json')];}
 else if(kind==='wait'){cmd=process.execPath;args=[join(root,'node_modules/vitest/vitest.mjs'),'run','server/decision-wiring/actor-wiring.test.ts','--testNamePattern=H-workflow project routine authority|actual live reader accepts','--maxWorkers=1','--reporter=json','--outputFile='+join(out,'results.json')];}
 else if(kind==='harness'){cmd=process.execPath;args=['--experimental-strip-types','--test','scripts/no-limits-live/harness-afix-r5.node-test.mjs'];}
 else if(kind==='muse'){cmd=process.execPath;args=[join(root,'node_modules/vitest/vitest.mjs'),'run','server/drivers/muse-code.test.ts','--testNamePattern=H-workflow Muse|P-MUSE acknowledged','--maxWorkers=1','--reporter=json','--outputFile='+join(out,'results.json')];}
 else if(kind==='project'){cmd=process.execPath;args=[join(root,'node_modules/vitest/vitest.mjs'),'run','server/product-project-routine-policy-api.test.ts','--maxWorkers=1','--reporter=json','--outputFile='+join(out,'results.json')];}
 else if(kind==='index'){cmd=process.execPath;args=[join(root,'node_modules/vitest/vitest.mjs'),'run','server/routines-tracked-save.test.ts','--testNamePattern=R5 review|R5 run identity|M2 conversation lookup','--maxWorkers=1','--reporter=json','--outputFile='+join(out,'results.json')];}
 else {cmd=process.execPath;args=['scripts/verify-gnl-r3-cells.mjs',out,archivedEvidencePath('evidence/gnl-prod-r3/all-cells-latest.json'),shard,total];}
 const r=spawnSync(cmd,args,{cwd:root,encoding:'utf8',timeout:70*60_000,maxBuffer:100*1024*1024,env:{...process.env,GNL_OWNER_POLICY_EVIDENCE:join(out,'workflow'),GNL_CANDIDATE:mode+'-afix-r5',GNL_CELL_TIMEOUT:'10000'}});
 writeNewEvidence(capture+'/run.log',(r.stdout??'')+(r.stderr??''));
 writeNewEvidence(capture+'/rc.json',JSON.stringify({status:r.status,error:r.error?.message}));
 if(existsSync(join(root,'.gnl-proof/evidence')))cpSync(join(root,'.gnl-proof/evidence'),join(out,'workflow'),{recursive:true});
 process.exitCode=r.status??1;
}finally{if(!root.startsWith(join(tmpdir(),'afix-gnl-r5-')))throw Error('Unexpected fixture root');safeWipeSync(root);}
