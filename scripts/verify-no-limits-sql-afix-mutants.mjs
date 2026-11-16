// Isolated test-container mutation proof. Never operates on a live app.
import {cpSync,mkdtempSync,readdirSync,symlinkSync,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {safeWipeSync} from '../server/testing/safe-wipe.mjs';
if(process.env.CI!=='1')throw Error('Requires isolated container');
const source=process.cwd(),out=resolve('evidence/afix-nolim-sql/mutants');mkdirSync(out,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'nolim-sql-mutants-'));
for(const entry of readdirSync(source))if(!/^(?:node_modules|\.git|evidence|dist|build|\.cache)/.test(entry))cpSync(join(source,entry),join(root,entry),{recursive:true});
symlinkSync(join(source,'node_modules'),join(root,'node_modules'),'dir');
const file='server/no-limits-wipe.ts',original=readFileSync(join(root,file),'utf8');
const specs=[
 ['template-prefix',s=>s.replace("argument.template?argument.template.parts.join('__expression__'):argument.value??''","argument.value??''"),'truly-review-afix-template','truly-review-afix-template-js'],
 ['queue-cap',s=>s.replace('at<pending.length;at++){','at<pending.length&&at<256;at++){'),'truly-review-afix-queue-boundary','truly-review-afix-queue-boundary'],
 ['printf-escapes',s=>s.replace(/output=printfFormat\(.*\);/, "output=format.replaceAll('%%','%');"),'truly-review-afix-printf','truly-review-afix-printf-newline'],
];
const report={sourceSha256:createHash('sha256').update(original).digest('hex'),mutants:[],verdict:'FAIL'};
function unit(id,pattern){
 const json=join(out,id+'.json'),log=join(out,id+'.log');
 const r=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','server/no-limits-review-fix.test.ts','--maxWorkers=1','-t',pattern,'--reporter=json','--outputFile='+json],{cwd:root,env:process.env,encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});
 writeFileSync(log,(r.stdout??'')+(r.stderr??''));
 const data=existsSync(json)?JSON.parse(readFileSync(json,'utf8')):undefined;
 return {code:r.status,failed:data?.testResults.flatMap(f=>f.assertionResults.filter(t=>t.status==='failed').map(t=>t.fullName))??[],passed:data?.numPassedTests??0};
}
function live(id,filter){
 const dir=join(out,id+'-live'),log=join(out,id+'-live.log');
 const r=spawnSync(process.execPath,['--experimental-strip-types','scripts/no-limits-live/truly-proof.mjs',dir],{cwd:root,env:{...process.env,TRULY_ONLY:filter},encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});
 writeFileSync(log,(r.stdout??'')+(r.stderr??''));
 const data=existsSync(join(dir,'report.json'))?JSON.parse(readFileSync(join(dir,'report.json'),'utf8')):undefined;
 return {code:r.status,verdict:data?.verdict,rows:data?.rows.map(({id,cards,expectedCards,complete,ended})=>({id,cards,expectedCards,complete,ended}))??[],error:data?.error};
}
try{
 for(const [id,mutate,pattern,filter]of specs){
  const changed=mutate(original);if(changed===original)throw Error('Missing anchor '+id);
  let red,liveRed;
  try{writeFileSync(join(root,file),changed);red=unit(id+'-red',pattern);liveRed=live(id+'-red',filter);}finally{writeFileSync(join(root,file),original);}
  const restored=unit(id+'-restored',pattern);
  const killed=red.code===1&&red.failed.some(name=>name.endsWith('direct'))&&red.failed.some(name=>name.endsWith('approval'))&&red.failed.some(name=>name.endsWith('registered'))&&restored.code===0&&restored.passed>0&&liveRed.code===1&&liveRed.rows.some(row=>row.cards!==row.expectedCards&&row.complete&&row.ended);
  report.mutants.push({id,killed,red,liveRed,restored});writeFileSync(join(out,'proof.json'),JSON.stringify(report,null,2)+'\n');
  console.log(id+': '+(killed?'KILLED; restored GREEN':'INVALID'));if(!killed)throw Error('Invalid proof '+id);
 }
 report.verdict='PASS';
}finally{writeFileSync(join(out,'proof.json'),JSON.stringify(report,null,2)+'\n');safeWipeSync(root,{reason:'isolated SQL mutation fixture'});}
