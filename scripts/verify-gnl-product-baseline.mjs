// Restore the handoff's exact changed files in a disposable container copy.
import {cpSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const source=process.cwd(),out=resolve(process.argv[2]);mkdirSync(out,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'gnl-prod-baseline-'));
try{
 const files=JSON.parse(readFileSync('evidence/gnl-prod/fixture-files.json','utf8'));
 for(const file of files){mkdirSync(dirname(join(root,file)),{recursive:true});cpSync(join(source,file),join(root,file));}
 symlinkSync(join(source,'node_modules'),join(root,'node_modules'),'dir');
 const baseline=JSON.parse(readFileSync('evidence/gnl-prod/baseline-files.json','utf8'));
 for(const [file,content] of Object.entries(baseline.files))if(content!==null)writeFileSync(join(root,file),content);
 const suites=[['auto-approve',['server/auto-approve.test.ts']],['decision',process.argv.includes('--focused')?['server/decision/faults.test.ts','server/decision/no-limits-gnl-frozen.test.ts']:JSON.parse(readFileSync('evidence/gnl-prod/baseline-decision-tests.json','utf8'))]];
 const results=[];
 for(const [name,tests]of suites){
  const run=spawnSync('pnpm',['exec','vitest','run',...tests,'--maxWorkers=2'],{cwd:root,encoding:'utf8',timeout:20*60_000,maxBuffer:60*1024*1024});
  writeFileSync(join(out,name+'.log'),(run.stdout??'')+(run.stderr??''));writeFileSync(join(out,name+'.rc'),String(run.status)+'\n');
  results.push({name,status:run.status,error:run.error?.message});writeFileSync(join(out,'results.json'),JSON.stringify({base:baseline.base,results},null,2)+'\n');
  if(run.error)throw run.error;
 }
}finally{if(!root.startsWith(join(tmpdir(),'gnl-prod-baseline-')))throw Error('Unexpected cleanup');rmSync(root,{recursive:true,force:true});}
