// Offline qualification of the gate itself. This is never a release PASS.
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
if(process.argv.includes('--release'))throw Error('Use run.mjs --live --release for release admission');
const out=resolve(process.argv[2]??'scripts/no-limits-live/evidence/self-test');mkdirSync(out,{recursive:true});
const stages=[
 ['contracts',['--experimental-strip-types','--test','scripts/no-limits-live/correction.node-test.mjs','scripts/no-limits-live/ruling.node-test.mjs','scripts/no-limits-live/cli.node-test.mjs','scripts/no-limits-live/release-legs.node-test.mjs','scripts/no-limits-live/predicate.node-test.mjs','scripts/nolim-replay/ruling.node-test.mjs','scripts/nolim-replay/release-ruling.node-test.mjs']],
 ['gate-mutants',['scripts/no-limits-live/qualify-mutants.mjs',join(out,'mutants')]],
 ['candidate-mutant',['scripts/no-limits-live/qualify-product-mutant.mjs',join(out,'candidate-mutant')]],
];
const report={mode:'fake-only gate qualification',releaseGate:false,stages:[],verdict:'FAIL'};
for(const [name,args]of stages){
 const result=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:180000});
 writeFileSync(join(out,name+'.log'),(result.stdout??'')+(result.stderr??''));
 report.stages.push({name,exit:result.status,verdict:result.status===0?'PASS':'FAIL'});
}
report.verdict=report.stages.every(s=>s.verdict==='PASS')?'PASS':'FAIL';
writeFileSync(join(out,'verdict.json'),JSON.stringify(report,null,2)+'\n');
console.log(`GNL-QUALIFICATION ${report.verdict} releaseGate=false`);if(report.verdict!=='PASS')process.exitCode=1;
