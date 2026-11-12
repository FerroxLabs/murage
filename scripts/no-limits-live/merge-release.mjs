import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {engineSpecs,scenarios} from './scenarios.mjs';
import {machineSummary,releaseVerdict} from './counts.mjs';
export function mergeRelease(shards){
 const errors=[],engines=[],rows=[];let replay;
 const mandatory=[];
 for(const shard of shards){
  if(shard.fixture?.isolated!==true)errors.push('Shard fixture isolation missing');
  if(!Array.isArray(shard.ownedEngines)||!shard.ownedEngines.length)errors.push('Shard ownership missing');
  if(shard.errors?.length)errors.push(...shard.errors);
  if(shard.replay?.verdict!=='PASS')errors.push('Shard replay failed');
  if(replay&&JSON.stringify(replay)!==JSON.stringify(shard.replay))errors.push('Replay counts differ between shards');
  replay??=shard.replay;
  mandatory.push(shard.mandatory);
  if(shard.mandatory?.verdict!=='PASS')errors.push('Shard mandatory suite failed');
  if(shard.ownedEngines?.some(id=>shard.mandatory?.engineIds?.filter(x=>x===id).length!==1))errors.push('Mandatory suite engine coverage missing');
  for(const engine of shard.engines??[]){
   if(!shard.ownedEngines?.includes(engine.id))errors.push('Unowned engine present');
   engines.push(engine);
   const mine=(shard.rows??[]).filter(r=>r.engine===engine.id);
   if(mine.length!==scenarios.length||new Set(mine.map(r=>r.id)).size!==scenarios.length)errors.push('Engine matrix incomplete');
  }
  rows.push(...(shard.rows??[]));
 }
 const ids=engines.map(e=>e.id);
 if(ids.length!==engineSpecs.length||new Set(ids).size!==engineSpecs.length||engineSpecs.some(e=>!ids.includes(e.id)))errors.push('Engine coverage incomplete or duplicated');
 const report={schema:2,tree:shards[0]?.tree,fixture:{isolated:shards.every(s=>s.fixture?.isolated===true)},replay,
  mandatory:{verdict:mandatory.every(m=>m?.verdict==='PASS')?'PASS':'FAIL',engineIds:mandatory.flatMap(m=>m?.engineIds??[])},engines,rows,errors};
 if(shards.some(s=>s.tree!==report.tree))errors.push('Candidate differs between shards');
 report.verdict=releaseVerdict(report,true);
 report.engines_pass=engines.filter(e=>e.status==='PASS').length;
 report.rc=report.verdict==='PASS'?0:1;
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [out,...paths]=process.argv.slice(2);
 if(!out||resolve(out).startsWith('/dev/')||!paths.length)throw Error('Output and shard reports required');
 const report=mergeRelease(paths.map(p=>JSON.parse(readFileSync(p,'utf8'))));
 writeFileSync(out,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
 console.log(`${machineSummary(report)} engines_pass=${report.engines_pass} rc=${report.rc}`);
 process.exitCode=report.rc;
}
