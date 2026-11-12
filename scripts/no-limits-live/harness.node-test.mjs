import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cappedScenario,requestSignal} from './scenario-timeout.mjs';
import {releaseEngines} from './release-engines.mjs';
import {engineSpecs,scenarios} from './scenarios.mjs';
import {completeMatrix,releaseVerdict} from './counts.mjs';
import {mergeRelease} from './merge-release.mjs';
import {context} from './mandatory-fixture.mjs';
import {executeReleased} from './fakes/common.mjs';
import {mkdtempSync,mkdirSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {ProductClient} from './run.mjs';
test('catalogue covers every registered adapter and Sol with native fixture protocols',()=>{
 const catalogue=releaseEngines();assert.deepEqual(Object.keys(catalogue).sort(),engineSpecs.map(e=>e.id).sort());
 assert.match(catalogue.claude.cli,/claude.mjs$/);assert.match(catalogue.codex.cli,/codex.mjs$/);
 for(const id of ['fuigo','grok-build','openclaw','custom-acp'])assert.match(catalogue[id].cli,/release-acp.mjs$/);
 assert.match(catalogue.antigravity.cli,/fake-agy-cli.ts$/);assert.match(catalogue.muse.cli,/fake-muse-cli.ts$/);
 assert.match(catalogue['gpt-sol'].model,/sol/);
});
test('unchanged rehearsal webhook test maps its ingress to the supported context fields',()=>{
 const c=context('printf fixture',{fullAccessOrigin:'webhook',ownerStarted:false,unattended:true});
 assert.equal(c.noLimitsOrigin,'webhook');assert.equal(c.fullAccessOrigin,'other');
});
test('legacy rehearsal webhook context runs the actual non-wipe policy without editing its ruling test',async()=>{
 const {autoVerdict}=await import('../../server/auto-approve.ts');
 const {noLimits,protectedTarget}=await import('./mandatory-fixture.mjs');
 const command=`printf fixture > '${protectedTarget()}'`;
 const c=context(command,{fullAccessOrigin:'webhook',ownerStarted:false,unattended:true,automated:true,
  routineLevel:false,channelOwner:false,outsideRead:['web page'],channelMessages:true});
 assert.notEqual(autoVerdict(noLimits,'Bash',command,c).approve,null);
});
test('unavailable or 409 engine yields a failed row, never a skipped row or pass',()=>{
 for(const reason of ['POST /api/bots returned 409','Engine unavailable (unavailable)']){
  const rows=completeMatrix([],[{id:'fixture',status:'FAIL',reason}],[{id:'case',expected:'RUN'}]);
  assert.equal(rows.length,1);assert.equal(rows[0].verdict,'FAIL');assert.equal(rows[0].skipped,false);assert.match(rows[0].errors[0],new RegExp(reason.replace(/[()]/g,'\\$&')));
 }
});
test('scenario deadline aborts requests and a hung callback cannot hold the runner',async()=>{
 let signal;const started=Date.now();
 await assert.rejects(cappedScenario(()=>{signal=requestSignal();return new Promise(()=>{});},25),/Scenario timed out/);
 assert.equal(signal.aborted,true);assert.ok(Date.now()-started<1000);
 assert.equal(await cappedScenario(async()=>42,100),42);
});
test('fixture health can finish restoring a server after its scenario deadline',async()=>{
 const server=createServer((req,res)=>setTimeout(()=>{res.setHeader('content-type','application/json');res.end('{"fixture":true}');},40));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let pending;
 try{
  const client=new ProductClient(`http://127.0.0.1:${server.address().port}`,{},tmpdir());
  await assert.rejects(cappedScenario(()=>{pending=client.api('GET','/api/health');return pending;},5),/Scenario timed out/);
  assert.deepEqual(await pending,{fixture:true});
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('native release fixture executes only an allowed receipt in its owned workspace',()=>{
 const root=mkdtempSync(join(tmpdir(),'nolim-live-release-fake-')),work=join(root,'work');mkdirSync(work);
 const cwd=process.cwd(),env={NOLIM_RELEASE_FAKE:process.env.NOLIM_RELEASE_FAKE,NOLIM_FIXTURE_ROOT:process.env.NOLIM_FIXTURE_ROOT};
 try{
  process.chdir(work);process.env.NOLIM_RELEASE_FAKE='1';process.env.NOLIM_FIXTURE_ROOT=root;
  assert.equal(executeReleased({tool:'Bash',input:{command:'printf allowed > receipt.done'}},true),true);
  assert.equal(readFileSync(join(work,'receipt.done'),'utf8'),'allowed');
  assert.equal(executeReleased({tool:'Bash',input:{command:'printf denied > denied.done'}},false),false);
  assert.equal(existsSync(join(work,'denied.done')),false);
  assert.equal(executeReleased({tool:'Bash',input:{command:"printf '%s' 'mkfs.ext4 /dev/sda' > quoted.done"}},true),true);
  assert.equal(readFileSync(join(work,'quoted.done'),'utf8'),'mkfs.ext4 /dev/sda');
  assert.equal(executeReleased({tool:'Bash',input:{command:'nolim_wipe=~; rm -rf "${nolim_wipe:?}"'}},true),false);
  assert.equal(existsSync(join(work,'receipt.done')),true);
 }finally{
  process.chdir(cwd);for(const [key,value]of Object.entries(env))if(value===undefined)delete process.env[key];else process.env[key]=value;
  rmSync(root,{recursive:true,force:true});
 }
});
test('six-shard merge admits every engine once and rejects duplicates, skipped rows and failed engines',()=>{
 const replay={verdict:'PASS',rows:140,pass:140,nonwipe_cards:0,refusals:0,skipped:0,controls:{rows:3,pass:3}};
 const shards=Array.from({length:6},(_,i)=>{
  const mine=engineSpecs.filter((_,n)=>n%6===i);
  return {tree:'a'.repeat(40),fixture:{isolated:true},replay,mandatory:{verdict:'PASS',engineIds:mine.map(e=>e.id)},errors:[],
   ownedEngines:mine.map(e=>e.id),engines:mine.map(e=>({id:e.id,status:'PASS'})),
   rows:mine.flatMap(e=>scenarios.map(s=>({...s,engine:e.id,verdict:'PASS',accounting:{verdict:'PASS'},skipped:false})))};
 });
 assert.equal(mergeRelease(shards).rc,0);assert.equal(mergeRelease(shards).engines_pass,engineSpecs.length);
 assert.equal(mergeRelease([...shards,shards[0]]).rc,1);
 const failed=structuredClone(shards);failed[0].engines[0].status='FAIL';assert.equal(mergeRelease(failed).rc,1);
 const skipped=structuredClone(shards);skipped[0].rows[0].skipped=true;assert.equal(mergeRelease(skipped).rc,1);
 const missingSuite=structuredClone(shards);missingSuite[0].mandatory.engineIds=[];assert.equal(mergeRelease(missingSuite).rc,1);
});
