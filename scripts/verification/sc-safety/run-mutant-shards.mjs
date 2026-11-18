// Owner: sc-safety-rd (49-mutant manifest, private copies and strict verdicts).
// Owner: lane runner (isolated execution and external evidence).
import {spawn} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {waitForReviewedSource} from './reviewed-prechecks.mjs';
const root=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
const index=process.argv.indexOf('--out'),out=resolve(process.argv[index+1]??'');
if(index<0||!relative(root,out).startsWith('..')||out==='/dev'||out.startsWith('/dev/'))throw Error('External --out required');
mkdirSync(out,{recursive:true});
await waitForReviewedSource(out);
const manifest=JSON.parse(readFileSync(new URL('./mutants.json',import.meta.url),'utf8'));
if(manifest.length!==49||new Set(manifest.map(row=>row.id)).size!==49)throw Error('Exactly 49 mutants required');
const workers=await Promise.all([0,1].map(async shard=>{
 const selected=manifest.filter((_,i)=>i%2===shard).map(row=>row.id),directory=join(out,`shard-${shard+1}`);
 mkdirSync(directory,{recursive:true});const fd=openSync(join(directory,'runner.log'),'w');
 const child=spawn(process.execPath,['--experimental-strip-types',join(root,'scripts/verification/sc-safety/run-mutants.mjs'),'--out',directory],{
  cwd:root,env:{...process.env,SC_MUTANTS:selected.join(',')},stdio:['ignore',fd,fd]});closeSync(fd);
 const status=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>done({code,signal}));});
 return {...status,selected,directory,report:JSON.parse(readFileSync(join(directory,'results.json'),'utf8')),
  hashes:JSON.parse(readFileSync(join(directory,'source-hashes.json'),'utf8'))};
}));
const rows=manifest.map(spec=>workers.flatMap(worker=>worker.report.rows).filter(row=>row.id===spec.id));
const identical=JSON.stringify(workers[0].hashes)===JSON.stringify(workers[1].hashes);
const qualified=row=>row.verdict==='KILLED'&&row.applied===true&&row.activation?.matches===1&&row.control?.state==='GREEN'&&row.mutant?.state==='ASSERTION_RED'&&row.restored?.state==='GREEN';
const report={complete:rows.every(matches=>matches.length===1),identicalSource:identical,total:49,
 activated:rows.filter(matches=>matches.length===1&&matches[0].activation?.matches===1&&matches[0].applied===true).length,
 killed:rows.filter(matches=>matches.length===1&&qualified(matches[0])).length,
 workers:workers.map(({code,signal,selected,directory})=>({code,signal,selected,directory})),rows:rows.flat()};
report.pass=report.complete&&identical&&report.activated===49&&report.killed===49&&workers.every(worker=>worker.code===0&&!worker.signal);
writeFileSync(join(out,'results.json'),JSON.stringify(report,null,2));
process.stdout.write(`SC_SAFETY_MUTANT_REPORT\n${JSON.stringify(report)}\n`);process.exitCode=report.pass?0:1;
