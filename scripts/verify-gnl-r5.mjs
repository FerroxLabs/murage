import { candidatePaths, retiredEvidencePath } from './check-repository-custody.mjs';
import { archivedEvidencePath, evidencePath, freshEvidencePath, writeNewEvidence } from './evidence-path.mjs';
// Comparable complete decision runs in disposable source/data fixtures.
import {cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, existsSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import { safeWipeSync } from '../server/testing/safe-wipe.mjs';
const [mode, shard, total = '6'] = process.argv.slice(2);
const source=process.cwd(), out=resolve(evidencePath(`evidence/gnl-prod-r5/${mode}/${shard}`));
mkdirSync(out,{recursive:true});
// Every receipt is created fresh in the capture; refuse before running if any name is already taken.
const receipts=Object.fromEntries(['manifest.json','results.json','run.log','rc.json','workflow'].map(name=>[name,freshEvidencePath(name,out)]));
const root=mkdtempSync(join(tmpdir(),'gnl-r5-'));
try {
 for(const file of candidatePaths(source))if(!retiredEvidencePath(file)&&existsSync(file)){
  mkdirSync(dirname(join(root,file)),{recursive:true});cpSync(file,join(root,file));
 }
 symlinkSync(join(source,'node_modules'),join(root,'node_modules'),'dir');
 const baseline=JSON.parse(readFileSync(archivedEvidencePath('evidence/gnl-prod-r5/baseline-runtime.json')));
 if(mode.startsWith('baseline')){
  for(const [file,record]of Object.entries(baseline.files))writeFileSync(join(root,file),record.bytes);
  for(const [file,bytes]of Object.entries(JSON.parse(readFileSync(archivedEvidencePath('evidence/gnl-prod-r5/original-assertions.json')))))writeFileSync(join(root,file),bytes);
 }
 const hashes=Object.fromEntries(Object.keys(baseline.files).map(file=>[file,createHash('sha256').update(readFileSync(join(root,file))).digest('hex')]));
 if(mode.startsWith('baseline'))for(const [file,record]of Object.entries(baseline.files))if(hashes[file]!==record.sha256)throw Error('Baseline bytes differ: '+file);
 const all=JSON.parse(readFileSync(archivedEvidencePath(`evidence/gnl-prod-r5/${process.env.GNL_TEST_LIST??'tests.json'}`)));
 const tests=all.filter((_,i)=>i%Number(total)===Number(shard));
 mkdirSync(out,{recursive:true});
 writeNewEvidence('manifest.json',JSON.stringify({mode,shard,total,base:baseline.base,runtimeHashes:hashes,testHashes:Object.fromEntries(tests.map(file=>[file,createHash('sha256').update(readFileSync(join(root,file))).digest('hex')])),tests},null,2),out);
 const r=spawnSync('pnpm',['exec','vitest','run',...tests,'--maxWorkers=1','--reporter=json','--outputFile='+receipts['results.json']],{cwd:root,encoding:'utf8',timeout:65*60_000,maxBuffer:100*1024*1024});
 writeNewEvidence('run.log',(r.stdout??'')+(r.stderr??''),out);
 if(existsSync(join(root,'.gnl-proof/evidence')))cpSync(join(root,'.gnl-proof/evidence'),freshEvidencePath('workflow',out),{recursive:true});
 writeNewEvidence('rc.json',JSON.stringify({status:r.status,error:r.error?.message}),out);
 process.exitCode=r.status??1;
}finally{if(!root.startsWith(join(tmpdir(),'gnl-r5-')))throw Error('Unexpected root');safeWipeSync(root);}
