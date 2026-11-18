// Test actual CI configuration bytes in disposable directories.
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
const out=resolve(process.argv[2]);mkdirSync(out,{recursive:true});
const files=['package.json','ci/gate-tests.txt','.github/workflows/ci.yml','scripts/no-limits-live/ci-tiers.tsv','scripts/no-limits-live/egress/provision.sh'];
const cases=[['host-image-prerequisite','.github/workflows/ci.yml',s=>s.replace('docker pull node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4','docker image ls')],['live-node-glob','package.json',s=>s.replace(' \\"scripts/no-limits-live/*.node-test.mjs\\"','')],['replay-node-glob','package.json',s=>s.replace(' \\"scripts/nolim-replay/*.node-test.mjs\\"','')],['ruling-inventory','ci/gate-tests.txt',s=>s.split('\n').filter(l=>!l.startsWith('scripts/no-limits-live/ruling.node-test.mjs\t')).join('\n')],['host-self-test','.github/workflows/ci.yml',s=>s.replace('run: node scripts/no-limits-live/egress/self-test.mjs','run: node scripts/other.mjs')]];
const report={releaseGate:false,mutants:[],verdict:'FAIL'};
for(const [id,file,mutate]of cases){const root=mkdtempSync(join(tmpdir(),'gnl-ci-mutant-'));
 try{
  for(const f of files){mkdirSync(dirname(join(root,f)),{recursive:true});writeFileSync(join(root,f),readFileSync(f));}
  const run=name=>{const result=spawnSync(process.execPath,['--test',resolve('scripts/no-limits-live/audit-fixes.node-test.mjs')],{cwd:root,encoding:'utf8'});writeFileSync(join(out,id+'-'+name+'.log'),(result.stdout??'')+(result.stderr??''));return result;};
  const baseline=run('control'),source=readFileSync(join(root,file),'utf8'),changed=mutate(source);writeFileSync(join(root,file),changed);const mutant=run('mutant');
  report.mutants.push({id,activated:changed!==source,controlExit:baseline.status,mutantExit:mutant.status,killed:baseline.status===0&&mutant.status===1&&changed!==source&&/ERR_ASSERTION/.test(mutant.stdout+mutant.stderr)});
 }finally{rmSync(root,{recursive:true,force:true});}
}
report.verdict=report.mutants.every(m=>m.killed)?'PASS':'FAIL';writeFileSync(join(out,'verdict.json'),JSON.stringify(report,null,2)+'\n');if(report.verdict!=='PASS')process.exitCode=1;
