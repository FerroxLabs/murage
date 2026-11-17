// Remove each formerly missing binding in an isolated child; real native
// controls must succeed first. These are fixture qualifications, not OS proof.
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
const out=resolve(process.argv[2]);mkdirSync(out,{recursive:true});
const report={releaseGate:false,mutants:[],verdict:'FAIL'};
for(const [id,fn] of [['deny-app-denied','app'],['deny-app-revoked','app'],['webhook-in-owner-room','webhookRoom']]){
 const temp=mkdtempSync(join(tmpdir(),'gnl-binding-mutant-')),dir=join(out,id);mkdirSync(dir,{recursive:true});
 try{
  const before=`'${id}':${fn}`,after=`'${id}':async()=>{throw Error('unbound: injected missing workflow')}`;
  const active=join(temp,'activated'),preload=join(temp,'mutant.mjs'),target=pathToFileURL(resolve('scripts/no-limits-live/bindings.mjs')).href;
  if(!readFileSync('scripts/no-limits-live/bindings.mjs','utf8').includes(before))throw Error('Binding anchor absent');
  writeFileSync(preload,`import {registerHooks} from 'node:module';import {writeFileSync} from 'node:fs';registerHooks({load(url,ctx,next){const r=next(url,ctx);if(url===${JSON.stringify(target)}){const s=String(r.source);if(!s.includes(${JSON.stringify(before)}))throw Error('anchor');writeFileSync(${JSON.stringify(active)},'yes');return {...r,source:s.replace(${JSON.stringify(before)},${JSON.stringify(after)})};}return r;}});`);
  const run=(name,mutant)=>{
   const env={...process.env};delete env.NODE_TEST_CONTEXT;if(mutant)env.NODE_OPTIONS=`--import=${pathToFileURL(preload).href}`;
   const result=spawnSync(process.execPath,['--experimental-strip-types','scripts/no-limits-live/bindings-self-test.mjs',join(dir,name),`--only=${id}`],{encoding:'utf8',timeout:90000,env});
   writeFileSync(join(dir,name+'.log'),(result.stdout??'')+(result.stderr??''));return {result,report:JSON.parse(readFileSync(join(dir,name,'report.json')))};
  };
  const control=run('control',false),mutant=run('mutant',true);
  const killed=control.result.status===0&&control.report.rows.length===1&&control.report.rows[0].status==='PASS'&&mutant.result.status===1&&existsSync(active)&&mutant.report.rows[0].status==='UNBOUND';
  report.mutants.push({id,activated:existsSync(active),controlExit:control.result.status,mutantExit:mutant.result.status,killed});
 }finally{rmSync(temp,{recursive:true,force:true});}
}
report.verdict=report.mutants.every(m=>m.killed)?'PASS':'FAIL';writeFileSync(join(out,'verdict.json'),JSON.stringify(report,null,2)+'\n');if(report.verdict!=='PASS')process.exitCode=1;
