import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const rows=JSON.parse(readFileSync('server/testing/fixtures/no-limits-r13.json','utf8'));
const results=[];
for(const row of rows) {
  const result=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','--root','.r13-baseline','--config','/work/.r13-baseline/vitest.config.mjs','-t',`^${row.id} `,'--reporter=default'],{encoding:'utf8',timeout:15000,maxBuffer:1000000,detached:true});
  if(result.error?.code==='ETIMEDOUT' && result.pid) { try { process.kill(-result.pid,'SIGKILL'); } catch {} }
  writeFileSync(`evidence/bld3-toolid-s4a/red-${row.id}.log`,result.stdout+result.stderr);
  results.push({id:row.id,status:result.status,signal:result.signal,timeout:result.error?.code==='ETIMEDOUT'});
  console.log(JSON.stringify(results.at(-1)));
}
writeFileSync('evidence/bld3-toolid-s4a/red-rows.json',JSON.stringify(results,null,2)+'\n');
