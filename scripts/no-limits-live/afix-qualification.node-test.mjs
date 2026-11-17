import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
test('release CLI control passes before the actual non-wipe-card candidate mutant is killed',{timeout:200000},()=>{
 const base=resolve('scripts/no-limits-live/evidence/afix-review');mkdirSync(base,{recursive:true});const out=mkdtempSync(join(base,'cli-contract-'));try{
  const r=spawnSync(process.execPath,[fileURLToPath(new URL('./qualify-product-mutant.mjs',import.meta.url)),out],{encoding:'utf8',timeout:190000,env:process.env});
  assert.equal(r.status,0,r.stdout+r.stderr);
  const report=JSON.parse(readFileSync(join(out,'verdict.json')));assert.equal(report.killed,true);assert.equal(report.control,true);assert.equal(report.detected,true);
  for(const name of ['baseline','mutant']){
   const cli=JSON.parse(readFileSync(join(out,name,'verdict.json')));assert.equal(cli.release,true);assert.equal(cli.qualificationOnly,true);assert.equal(cli.fixture.isolated,true);
   assert.equal(cli.rows.length,1);assert.equal(cli.rows[0].accounting.complete,true);
   assert.equal(cli.verdict,name==='baseline'?'PASS':'FAIL');
  }
 }finally{/* CLI receipts and the owned server log remain as review evidence. */}
});
