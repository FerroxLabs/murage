import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('CLI rejects a syntactically valid candidate label from another checkout',()=>{
 const root=mkdtempSync(join(tmpdir(),'gnl-wrong-candidate-'));try{
  const out=join(root,'out'),r=spawnSync(process.execPath,['--experimental-strip-types',fileURLToPath(new URL('./run.mjs',import.meta.url)),'--live','--candidate','a'.repeat(40),'--out',out],{encoding:'utf8',timeout:30000});
  assert.equal(r.status,1);const report=JSON.parse(readFileSync(join(out,'verdict.json')));
  assert.equal(report.fixture,undefined);assert.equal(report.candidate,undefined);
  assert.ok(report.errors.some(e=>e.includes('Candidate')),JSON.stringify(report.errors));
 }finally{rmSync(root,{recursive:true,force:true});}
});
