// Rerun exact selected cells; all fixture actions and judging stay in the existing sweep.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const [outArg,planArg,shardArg='0',shardsArg='1']=process.argv.slice(2),out=resolve(outArg),plan=JSON.parse(readFileSync(planArg,'utf8'));
const rows=Object.values(plan).flat(),engines=[...new Set(rows.map(r=>r.engine))].sort(),shard=+shardArg,shards=+shardsArg;
const timeout=Number(process.env.GNL_CELL_TIMEOUT??45000);if(!Number.isInteger(timeout)||timeout<1||timeout>45000)throw Error('Invalid cell timeout');
mkdirSync(out,{recursive:true});const candidate=process.env.GNL_CANDIDATE??'gnl-prod-r3';
const files=JSON.parse(readFileSync('evidence/gnl-prod/fixture-files.json','utf8')).filter(f=>f.startsWith('server/')||f.startsWith('shared/')||f.startsWith('scripts/no-limits-live/'));
writeFileSync(join(out,'source.json'),JSON.stringify({candidate,files:Object.fromEntries(files.map(f=>[f,createHash('sha256').update(readFileSync(f)).digest('hex')]))},null,2));
const report={timeout,rows:[],errors:[],shard,shards,startedAt:new Date().toISOString()};
for(const [i,engine]of engines.entries()){
 if(i%shards!==shard)continue;
 const cases=[...new Set(rows.filter(r=>r.engine===engine).map(r=>r.id))];
 const r=spawnSync(process.execPath,['scripts/no-limits-live/scenario-sweep.mjs','--candidate',candidate,'--out',join(out,engine),'--engines',engine,'--cases',cases.join(','),'--timeout',String(timeout)],{encoding:'utf8',timeout:20*60_000,maxBuffer:20*1024*1024});
 writeFileSync(join(out,engine+'.log'),(r.stdout??'')+(r.stderr??''));
 try{const j=JSON.parse(readFileSync(join(out,engine,'verdict.json'),'utf8'));report.rows.push(...j.rows);report.errors.push(...j.errors);}catch(error){report.errors.push(engine+': '+error.message);}
 if(r.error)report.errors.push(engine+': '+r.error.message);
 writeFileSync(join(out,'verdict.json'),JSON.stringify(report,null,2));
}
report.finishedAt=new Date().toISOString();report.pass=report.rows.filter(r=>r.verdict==='PASS').length;report.fail=report.rows.length-report.pass;
writeFileSync(join(out,'verdict.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({rows:report.rows.length,pass:report.pass,fail:report.fail,errors:report.errors}));
process.exitCode=report.fail||report.errors.length?1:0;
