// Run only in the network-none fixture container. Mutations live in a disposable
// source copy; every run retains the original regression and positive controls.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const source=process.cwd(),out=resolve(process.argv[2]??'evidence/gnl-prod-r4/mutants');
mkdirSync(out,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'gnl-service-origin-mutants-'));
const results=[];
try {
 for(const entry of ['server','scripts','shared','src','electron','extensions','companion','tools','cloudflare','apps','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','vite.config.ts','tsconfig.json'])cpSync(join(source,entry),join(root,entry),{recursive:true});
 symlinkSync(join(source,'node_modules'),join(root,'node_modules'),'dir');
 const file=join(root,'server/index.ts'),original=readFileSync(file,'utf8');
 const run=id=>{
  const dir=join(out,id);mkdirSync(dir,{recursive:true});
  const child=spawnSync('pnpm',['exec','vitest','run','server/product-service-origin-api.test.ts','--maxWorkers=1','--reporter=json','--outputFile='+join(dir,'tests.json')],{cwd:root,encoding:'utf8',timeout:300000,maxBuffer:10*1024*1024,env:{...process.env,GNL_SERVICE_ORIGIN_EVIDENCE:join(dir,'workflow')}});
  writeFileSync(join(dir,'run.log'),(child.stdout??'')+(child.stderr??''));
  const report=JSON.parse(readFileSync(join(dir,'tests.json'),'utf8'));
  const tests=report.testResults.flatMap(suite=>suite.assertionResults);
  return {status:child.status,error:child.error?.message,tests:tests.map(test=>({id:test.fullName,status:test.status,assertionFailure:test.failureMessages.some(message=>message.includes('AssertionError'))}))};
 };
 const control=run('control');
 if(control.status!==0||control.tests.length!==6||control.tests.some(test=>test.status!=='passed'))throw Error('Unmutated control failed');
 const oldOrigin=readFileSync(join(source,'evidence/gnl-prod-r4/unsafe-service-origin.txt'),'utf8').trimEnd();
 const mutants=[
  {id:'old-service-origin',change:s=>s.replace("          const origin = decisionNoLimitsOrigin(dispatchProvenance);",oldOrigin)},
  {id:'unproved-as-unattended',change:s=>s.replace("  if (k === 'guest' || k === 'other-human') return 'other-human';\n",'')},
 ];
 for(const mutant of mutants){
  const changed=mutant.change(original);if(changed===original)throw Error(mutant.id+' seam missing');
  try{writeFileSync(file,changed);const result=run(mutant.id);
   const negative=result.tests.filter(test=>/^FABLE (queue|card|memory) shares/.test(test.id));
   const positive=result.tests.filter(test=>/^FABLE (owner|queue-proven|memory-proven) shares/.test(test.id));
   const killed=result.status!==0&&negative.length===3&&negative.every(test=>test.status==='failed'&&test.assertionFailure)&&positive.length===3&&positive.every(test=>test.status==='passed');
   results.push({id:mutant.id,killed,control,...result});
   writeFileSync(join(out,'results.json'),JSON.stringify(results,null,2));
   if(!killed)throw Error(mutant.id+' survived or lost a positive control');
  }finally{writeFileSync(file,original);}
 }
}finally{
 if(dirname(root)!==tmpdir()||!root.startsWith(join(tmpdir(),'gnl-service-origin-mutants-')))throw Error('Unexpected temporary source root');
 rmSync(root,{recursive:true,force:true});
}
