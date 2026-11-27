import { retiredEvidencePath } from './check-repository-custody.mjs';
import { archivedEvidencePath, assertExternalEvidencePath, evidencePath } from './evidence-path.mjs';
// Exact PRODUCT-cell rerun using the unchanged scenario driver and judge.
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2),arg=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
const out=assertExternalEvidencePath(resolve(arg('--out'))),shard=Number(arg('--shard','0')),shards=Number(arg('--shards','1')),candidate=arg('--candidate','UNCOMMITTED');
if(!Number.isInteger(shard)||!Number.isInteger(shards)||shard<0||shard>=shards)throw Error('Invalid output/shard');
mkdirSync(out,{recursive:true});
const plan=JSON.parse(readFileSync(archivedEvidencePath('evidence/gnl-prod/affected-cells.json'),'utf8'));
const engines=[...new Set(Object.values(plan).flat().map(r=>r.engine))].sort();
const manifest=JSON.parse(readFileSync(archivedEvidencePath('evidence/gnl-prod/fixture-files.json'),'utf8'));
const sourceFiles=manifest.filter(f=>!retiredEvidencePath(f)&&existsSync(f)&&(f.startsWith('server/')||f.startsWith('shared/')||f.startsWith('scripts/no-limits-live/')));
writeFileSync(evidencePath('source.json',out),JSON.stringify({candidate,files:Object.fromEntries(sourceFiles.map(f=>[f,createHash('sha256').update(readFileSync(f)).digest('hex')]))},null,2)+'\n');
const report={candidate,shard,shards,rows:[],errors:[],startedAt:new Date().toISOString()};
const save=()=>writeFileSync(evidencePath('verdict.json',out),JSON.stringify(report,null,2)+'\n');
for(const [i,engine] of engines.entries()){
 if(i%shards!==shard)continue;
 const cases=[...new Set(Object.values(plan).flat().filter(r=>r.engine===engine).map(r=>r.id))];
 const engineOut=evidencePath(engine,out);
 const run=spawnSync(process.execPath,['--experimental-strip-types','scripts/no-limits-live/scenario-sweep.mjs','--candidate',candidate,'--out',engineOut,'--engines',engine,'--cases',cases.join(',')],{encoding:'utf8',timeout:15*60_000,maxBuffer:20*1024*1024});
 writeFileSync(evidencePath(engine+'.log',out),(run.stdout??'')+(run.stderr??''));
 if(run.error)report.errors.push(engine+': '+run.error.message);
 try{const verdict=JSON.parse(readFileSync(join(engineOut,'verdict.json'),'utf8'));report.rows.push(...verdict.rows);report.errors.push(...verdict.errors);}catch(error){report.errors.push(engine+': '+error.message);}
 save();console.log(engine+' '+run.status+' '+report.rows.length+' cells accumulated');
}
report.finishedAt=new Date().toISOString();report.pass=report.rows.filter(r=>r.verdict==='PASS').length;report.fail=report.rows.length-report.pass;save();
console.log(JSON.stringify({rows:report.rows.length,pass:report.pass,fail:report.fail,errors:report.errors}));process.exitCode=report.fail||report.errors.length?1:0;
