// Owner: sc-safety-rd (reviewed preliminary probes and immutable receipts).
// Owner: lane operator (source changes only between probes, final-source marker).
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,dirname,relative,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const pause=()=>new Promise(done=>setTimeout(done,500));
export async function waitForReviewedSource(out){
 const directory=dirname(out),plan=join(directory,'VERIFY-PLAN.json');
 if(!existsSync(plan))return;
 while(!existsSync(join(directory,'SOURCE-REVIEWED')))await pause();
}
export async function reviewedPrechecks(root,out){
 const directory=dirname(out),planPath=join(directory,'VERIFY-PLAN.json');
 if(!existsSync(planPath))return;
 mkdirSync(out,{recursive:true});
 for(let iteration=1;iteration<=8;iteration++){
  const plan=JSON.parse(readFileSync(planPath,'utf8')),probe=plan.probe;
  if(!probe)break;
  const cwd=resolve(probe.cwd??root);
  if(cwd!==root&&!relative(root,cwd).startsWith('..')||cwd==='/dev'||cwd.startsWith('/dev/'))throw Error('Invalid preliminary source directory');
  if(!probe.tests?.length||probe.tests.some(file=>!/^server\/[\w/.-]+\.test\.ts$/.test(file)))throw Error('Explicit preliminary test inventory required');
  const report=join(out,`precheck-${iteration}.json`),identity=join(out,`precheck-${iteration}-assertions.json`);
  const sourceHashes=Object.fromEntries((plan.sourceFiles??probe.tests).map(file=>[file,existsSync(join(cwd,file))?createHash('sha256').update(readFileSync(join(cwd,file))).digest('hex'):null]));
  const args=['node_modules/vitest/vitest.mjs','run',...probe.tests,'--reporter=json',`--reporter=${join(root,'scripts/verification/sc-safety/assertion-reporter.mjs')}`,`--outputFile=${report}`];
  if(probe.pattern)args.push('--testNamePattern',probe.pattern);
  const result=spawnSync(process.execPath,args,{cwd,env:{...process.env,SC_ASSERTION_IDENTITY_REPORT:identity},encoding:'utf8',timeout:600000,maxBuffer:64*1024*1024});
  writeFileSync(join(out,`precheck-${iteration}.log`),(result.stdout??'')+(result.stderr??''));
  writeFileSync(join(out,`precheck-${iteration}-source.json`),JSON.stringify({probe,status:result.status,error:result.error?.message,sourceHashes},null,2));
  process.stdout.write(`SC_PRECHECK ${iteration} status=${result.status}\n`);
  const reviewed=join(out,`precheck-${iteration}-reviewed`);
  while(!existsSync(reviewed))await pause();
  if(readFileSync(reviewed,'utf8').trim()==='continue')break;
 }
 await waitForReviewedSource(out);
}
