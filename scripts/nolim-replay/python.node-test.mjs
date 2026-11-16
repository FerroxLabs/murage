import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
for(const name of ['extract.test.py','display-cards.test.py','runner.test.py']) {
 test(`Python replay contract ${name}`,{timeout:60000},()=>{
  const result=spawnSync(process.platform==='win32'?'python':'python3',[fileURLToPath(new URL(name,import.meta.url))],{encoding:'utf8',timeout:55000});
  assert.equal(result.status,0,result.stdout+result.stderr);
 });
}
