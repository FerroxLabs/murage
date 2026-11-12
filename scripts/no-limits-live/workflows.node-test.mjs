// The standalone workflow self-test is a blocking Node tier, including unbound rows.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fieldRows} from './scenarios.mjs';
test('every standalone workflow binding and field self-test must pass',{timeout:300000},()=>{
 const out=mkdtempSync(join(tmpdir(),'gnl-ci-workflows-'));
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 try{
  const result=spawnSync(process.execPath,['--experimental-strip-types',fileURLToPath(new URL('./bindings-self-test.mjs',import.meta.url)),out],{encoding:'utf8',timeout:290000,env});
  const report=JSON.parse(readFileSync(join(out,'report.json')));
  assert.equal(result.status,0,JSON.stringify({error:report.error,rows:report.rows,fields:report.fields?.map(r=>({id:r.id,verdict:r.verdict,errors:r.errors}))}));
  assert.equal(report.verdict,'PASS');
  assert.deepEqual(report.rows.map(r=>r.id).sort(),['two-questions','question-with-instruction','queued-owner-drain','email-subject-rm','routine-wake','project-room-routine','project-routine-owner-room','deny-app-denied','deny-app-revoked','webhook-in-owner-room'].sort());
  assert.ok(report.rows.every(r=>r.status==='PASS'));
  assert.deepEqual(report.fields.map(r=>r.id).sort(),fieldRows.map(r=>r.id).sort());assert.ok(report.fields.every(r=>r.verdict==='PASS'));
 }finally{rmSync(out,{recursive:true,force:true});}
});
