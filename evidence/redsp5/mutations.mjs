// Offline, disposable source copies only. Every red must be an assertion failure.
import { readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitFixture } from '../../server/testing/git-fixture.mjs';
const out=resolve('evidence/redsp5/mutants');mkdirSync(out,{recursive:true});
const repository=gitFixture(), root=repository.root;
symlinkSync(resolve('node_modules'),join(root,'node_modules'),'dir');
const routes=JSON.parse(readFileSync('evidence/redsp5/safe-routing.json','utf8'));
const cases=routes.map((r,i)=>({id:`wipe-${i+1}`,occurrence:r.target==='mut-2'?1:0,file:r.file,from:r.to,to:r.from,test:'server/testing/data-safety.test.ts',pattern:'every recursive delete outside vitest'}));
const labels=readFileSync('electron/cloud-step-up-label.mjs','utf8').split('\n').filter(line=>/label: "(?:Connect an app|Change the Signal connection)"/.test(line)&&(/connector-incidents|signal/.test(line)));
for(const [i,line] of labels.entries())cases.push({id:`label-${i+1}`,file:'electron/cloud-step-up-label.mjs',from:line+'\n',to:'',test:'electron/cloud-step-up-label.test.mjs',pattern:'Signal and app reconnection'});
cases.push({id:'read-only-credential',file:'.github/workflows/release.yml',from:'      - name: Release asset CHECK - public releases and anonymous pinned assets\n        env:\n          GH_TOKEN: ${{ github.token }}',to:'      - name: Release asset CHECK - public releases and anonymous pinned assets\n        env:\n          GH_TOKEN: ${{ secrets.RELEASES_PAT }}',test:'scripts/check-release-assets.test.mjs',pattern:'derives all twelve'});
cases.push({id:'temp-teardown',file:'server/channels/signal/adapters.test.ts',from:'removeTempDirSync(root)',to:'rmSync(root, { recursive: true, force: true })',test:'server/testing/temp-cleanup-guard.test.ts',pattern:'no test file removes'});
const results=[], controls=new Map();
const run=(c,phase)=>{
 const r=spawnSync(process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run',c.test,'-t',c.pattern,'--maxWorkers=1','--reporter=default'],{cwd:root,env:process.env,encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});
 const output=(r.stdout??'')+(r.stderr??'');writeFileSync(join(out,`${c.id}-${phase}.log`),output);
 return {exit:r.status,assertion:/AssertionError/.test(output),passed:/Tests\s+\d+ passed/.test(output)};
};
try {
 for(const c of cases){
  const path=join(root,c.file),source=readFileSync(path,'utf8');
  if(!source.includes(c.from))throw Error(`Missing mutant anchor ${c.id}`);
  const key=c.test+' '+c.pattern;
  if(!controls.has(key))controls.set(key,run(c,'before'));
  const before=controls.get(key);let red;
  try {let at=source.indexOf(c.from);if(c.occurrence)at=source.indexOf(c.from,at+c.from.length);writeFileSync(path,source.slice(0,at)+c.to+source.slice(at+c.from.length));red=run(c,'red');}finally{writeFileSync(path,source);}
  const after={restored:readFileSync(path,'utf8')===source};const killed=before.exit===0&&red.exit===1&&red.assertion&&after.restored;
  const row={...c,before,red,after,killed};results.push(row);console.log(c.id,killed?'KILLED':'INVALID');
  writeFileSync(join(out,'results.json'),JSON.stringify(results,null,2)+'\n');
  if(!killed)process.exitCode=1;
 }
 for(const [key] of controls){const c=cases.find(c=>c.test+' '+c.pattern===key);const restored=run(c,'restored');if(restored.exit!==0)process.exitCode=1;for(const row of results.filter(r=>r.test+' '+r.pattern===key)){row.after={...row.after,...restored};row.killed&&=restored.exit===0;}}
 writeFileSync(join(out,'results.json'),JSON.stringify(results,null,2)+'\n');
} finally {repository.dispose();}
