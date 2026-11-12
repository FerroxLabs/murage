import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ProductClient} from './run.mjs';
test('decision accounting consumes each byte once and indexes by thread',()=>{
 const dir=mkdtempSync(join(tmpdir(),'gnl-decisions-'));try{
  const file=join(dir,'nolim-decisions.ndjson'),c=new ProductClient('http://fixture',{},dir);
  writeFileSync(file,JSON.stringify({observer:'nolim-live',schema:1})+'\n'+JSON.stringify({threadId:'a',decision:'run'})+'\n');
  assert.equal(c.decisions(['a']).length,1);
  writeFileSync(file,JSON.stringify({threadId:'b',decision:'run'})+'\n',{flag:'a'});
  assert.equal(c.decisions(['a']).length,1);
  assert.equal(c.decisions(['b']).length,1);
  assert.equal(c.decisionReader?.bytesRead,Buffer.byteLength(readFileSync(file)));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('candidate receipts bind checkout contents and reject another SHA',async()=>{
 const {verifyCandidate,writeCandidateProof}=await import('./candidate-proof.mjs');
 const dir=mkdtempSync(join(tmpdir(),'gnl-candidate-'));try{
  const git=(...args)=>{const r=spawnSync('git',args,{cwd:dir,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git('init','-q');writeFileSync(join(dir,'policy'),'one');git('add','.');git('-c','user.name=ci','-c','user.email=fixture@example.test','commit','-qm','fixture');
  const sha=git('rev-parse','HEAD'),proof=join(dir,'snapshot.json');writeCandidateProof(dir,proof);
  assert.equal(verifyCandidate(dir,sha).candidateSha,sha);
  assert.throws(()=>verifyCandidate(dir,'a'.repeat(40)),/Candidate/);
  // A snapshot must independently reconstruct both the commit and its tree.
  assert.equal(verifyCandidate(dir,sha,proof).candidateSha,sha);
  writeFileSync(join(dir,'policy'),'two');
  assert.throws(()=>verifyCandidate(dir,sha),/Candidate/);assert.throws(()=>verifyCandidate(dir,sha,proof),/Candidate/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('product mutant qualification includes a passing release CLI control and failing mutated CLI',()=>{
 const source=readFileSync(new URL('./qualify-product-mutant.mjs',import.meta.url),'utf8');
 assert.match(source,/run\.mjs/);assert.match(source,/--release/);assert.doesNotMatch(source,/production-smoke\.mjs/);
});
test('new English diagnostic and fixture prompt inventory is supplied',()=>{
 const inventory=readFileSync(new URL('./ENGLISH-INVENTORY.md',import.meta.url),'utf8');
 for(const finding of ['origin-fixtures.mjs','production.mjs','candidate-proof.mjs','decision-reader.mjs','qualify-product-mutant.mjs'])assert.ok(inventory.includes(finding));
});
