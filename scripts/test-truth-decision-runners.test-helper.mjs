// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it,vi} from 'vitest';
import {cpSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path'; import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {removeTempDirSync} from '../server/testing/cleanup.ts';
import {ADAPTERS} from './test-truth/runner-inventory.test-helper.mjs';

// All children are inert fakes; shared-host load must not decide their verdict.
vi.mock('node:os',async original=>({...await original(),loadavg:()=>[0,0,0]}));

it.each(ADAPTERS.filter(path=>path.startsWith('server/decision-wiring/')).map(path=>path.split('/').pop()))('%s rejects an unrelated fixture assertion as a mutant kill',runner=>{
 const root=mkdtempSync(join(tmpdir(),'decision-verdict-')),out=join(root,'receipts');
 try{
  for(const dir of ['server/decision-wiring','scripts','shared','node_modules/vitest'])mkdirSync(join(root,dir),{recursive:true});
  writeFileSync(join(root,'package.json'),'{"type":"module"}');
  for(const file of ['server/index.ts','server/routines.ts','server/routine-requests.ts','server/decision-wiring/sable-server.test.ts','server/decision-wiring/fix-round2.test.ts','server/decision-wiring/fix-round3.test.ts','server/decision-wiring/history-index.test.ts','server/decision-wiring/round3-fixture.ts','server/decision-wiring/'+runner,'shared/win-hide-child-process.mjs','shared/win-hide-child-process.cjs'])cpSync(resolve(file),join(root,file));
  cpSync(resolve('scripts/test-truth'),join(root,'scripts/test-truth'),{recursive:true});
  writeFileSync(join(root,'node_modules/vitest/vitest.mjs'),`
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const report=process.env.TEST_TRUTH_MUTANT_REPORT, red=!report||report.includes('.red.details.json');
console.log('AssertionError: unrelated fixture assertion; Matcher did not succeed in time');
if(report){
 const file=resolve(process.argv.find(arg=>arg.endsWith('.test.ts')));
 writeFileSync(report,JSON.stringify({reason:red?'failed':'passed',errors:[],tests:[{file,id:'selected witness',state:red?'failed':'passed',hooks:['pass'],errors:red?[{name:'AssertionError',message:'Matcher did not succeed in time',stack:'AssertionError\\n at '+file+':1:1'}]:[]}]}));
 const json=process.argv.find(arg=>arg.startsWith('--outputFile=')).slice('--outputFile='.length);
 writeFileSync(json,JSON.stringify({numPassedTests:red?0:1}));
}
process.exitCode=red?1:0;
`);
  const preload=join(root,'fixture-host.mjs');
  writeFileSync(preload,`import {registerHooks} from 'node:module';
registerHooks({resolve(name,context,next){return name==='node:os'?{url:'fixture:os',shortCircuit:true}:next(name,context);},load(url,context,next){return url==='fixture:os'?{format:'module',shortCircuit:true,source:'export const loadavg=()=>[0,0,0];'}:next(url,context);}});`);
  const run=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,'server/decision-wiring/'+runner],{cwd:root,env:{...process.env,TEST_TRUTH_MUTANT_REPORT:'',CI:'1',S4_MUTANT_EVIDENCE:out,S4_MUTANT_DIR:out},encoding:'utf8',timeout:120000,maxBuffer:4*1024**2});
  expect(run.error).toBeUndefined();
  expect(run.status,run.stdout+run.stderr).toBe(1);
  const name=runner==='history-index-mutants.mjs'?'history-results.json':runner==='sable-server-mutant.mjs'?'sable-results.json':'results.json';
  const receipts=JSON.parse(readFileSync(join(out,name),'utf8'));
  expect([receipts].flat().length).toBeGreaterThan(0);
  expect([receipts].flat().every(row=>row.killed===false)).toBe(true);
 }finally{removeTempDirSync(root);}
});

it('decision runner requires the pinned assertion and green baseline/restoration receipts',async()=>{
 const {verifyDecisionMutant}=await import('./test-truth/decision-mutant.test-helper.mjs');
 const root=mkdtempSync(join(tmpdir(),'decision-receipts-'));
 // The verifier resolves pins from cwd; use an existing tracked witness source.
 const witness='server/decision-wiring/history-index.test.ts';
 const source=readFileSync(witness,'utf8'),pin="expect(start('past-turn-9')).toBeNull()",offset=source.indexOf(pin);
 const line=source.slice(0,offset).split('\n').length,column=offset-source.lastIndexOf('\n',offset);
 const child=join(root,'fake-vitest.mjs');
 writeFileSync(child,`
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const state=process.env.WITNESS_STATE,phase=existsSync(state)?Number(readFileSync(state,'utf8')):0;
writeFileSync(state,String(phase+1));
const scenario=process.env.WITNESS_SCENARIO, red=phase===1,broken=(phase===0&&scenario==='bad-baseline')||(phase===2&&scenario==='bad-restoration');
let error={name:'AssertionError',message:'expected value',stack:'AssertionError\\n at '+${JSON.stringify(resolve(witness))}+':'+${line}+':'+${column}};
if(scenario==='unrelated'||scenario==='wrong-poll')error={...error,stack:'AssertionError\\n at '+${JSON.stringify(resolve(witness))}+':1:1',message:scenario==='wrong-poll'?'Matcher did not succeed in time':'fixture assertion'};
if(scenario==='intended-framework')error={...error,stack:'AssertionError\\n at assertion (file:///fixture/node_modules/@vitest/expect/dist/index.js:1:1)\\n at Reflect.get (<anonymous>)\\n'+error.stack.split('\\n').slice(1).join('\\n')};
if(scenario==='intended-poll-framework')error={...error,stack:'AssertionError\\n at Proxy.__VITEST_POLL_CHAIN__ (file:///fixture/node_modules/vitest/dist/chunks/test.js:1:1)\\n'+error.stack.split('\\n').slice(1).join('\\n')};
if(scenario==='caller-frame')error={...error,stack:'AssertionError\\n at setup.ts:1:1\\n'+error.stack.split('\\n').slice(1).join('\\n')};
if(scenario==='exception')error={name:'TypeError',message:'fixture exception'};
if(scenario==='timeout')error={...error,message:'Test timed out in 5000ms'};
if(red&&scenario==='signal')process.kill(process.pid,'SIGTERM');
const failed=red||broken;
const details={reason:failed?'failed':'passed',errors:red&&scenario==='infrastructure'?[{name:'Error',message:'unhandled'}]:[],tests:[{file:${JSON.stringify(resolve(witness))},id:'selected witness',state:failed?'failed':'passed',hooks:[red&&scenario==='hook'?'fail':'pass'],errors:failed?[error]:[]}]};
if(!(red&&scenario==='missing-report'))writeFileSync(process.env.TEST_TRUTH_MUTANT_REPORT,JSON.stringify(details));
const json=process.argv.find(arg=>arg.startsWith('--outputFile=')).slice('--outputFile='.length);
writeFileSync(json,JSON.stringify({numPassedTests:failed?0:1}));
process.exitCode=failed?1:0;
`);
 try{
  for(const scenario of ['intended','intended-object','intended-framework','intended-poll-framework','unrelated','wrong-poll','caller-frame','exception','timeout','signal','hook','infrastructure','missing-report','bad-baseline','bad-restoration']){
   const result=await verifyDecisionMutant({id:scenario,dir:root,args:[child],file:witness,assertions:[scenario==='intended-object'?{file:witness,assertion:pin}:pin],mutate:()=>{},restore:()=>{},env:{WITNESS_STATE:join(root,scenario+'.state'),WITNESS_SCENARIO:scenario}});
   expect(result.killed,scenario).toBe(scenario.startsWith('intended'));
  }
 }finally{removeTempDirSync(root);}
});

// The r4b runner works in a scratch copy of its cwd; a fake vitest stands in for the real one.
// scenario -> which sink the red failure names, and whether the green or restored run is clean.
const SINK_BY_MUTANT={'R4B-10-stored-record-unredacted':'server/memory/record-write.ts','R4B-10-engine-line-unredacted':'server/engine-reply-check.ts','R4B-10-approval-input-unredacted':'server/approval-text.ts'};
it.each([
 ['intended',{'R4B-10-stored-record-unredacted':true,'R4B-10-engine-line-unredacted':true,'R4B-10-approval-input-unredacted':true,'R4B-10-text-pass-through':true,'R4B-10-card-pass-through':true,'R4B-10-sink-pass-through':true}],
 // Another sink's leak must not certify a mutant of this sink (the shared inventory test fails on the first sink in order).
 ['other-sink',{'R4B-10-stored-record-unredacted':true,'R4B-10-engine-line-unredacted':false,'R4B-10-approval-input-unredacted':false,'R4B-10-text-pass-through':true,'R4B-10-card-pass-through':true,'R4B-10-sink-pass-through':true}],
 ['no-baseline',{}],
 ['no-restoration',{}],
])('tafix-r4b runner scenario %s certifies only the mutants its pins allow',(scenario,expected)=>{
 const root=mkdtempSync(join(tmpdir(),'tafix-verdict-')),out=join(tmpdir(),'tafix-verdict-out-'+process.pid+'-'+scenario);
 try{
  for(const dir of ['server/testing','server/memory','scripts','shared','electron','node_modules/vitest'])mkdirSync(join(root,dir),{recursive:true});
  writeFileSync(join(root,'package.json'),'{"type":"module"}');
  for(const file of ['server/testing/tafix-r4b-mutants.mjs','server/testing/tafix-r4b-pins.json','server/testing/safe-wipe.mjs','electron/data-dir-lease.mjs','electron/windows-native.mjs','server/testing/redact-sink-extra.ts','server/testing/redact-sink-witnesses.ts','server/redact-sink-boundaries.test.ts','server/memory/record-write.ts','server/engine-reply-check.ts','server/approval-text.ts','server/redact.ts','shared/win-hide-child-process.mjs','shared/win-hide-child-process.cjs'])cpSync(resolve(file),join(root,file));
  cpSync(resolve('scripts/test-truth'),join(root,'scripts/test-truth'),{recursive:true});
  const frame=(file,text)=>{const source=readFileSync(resolve(file),'utf8'),offset=source.indexOf(text);return file+':'+(source.slice(0,offset).split('\n').length)+':'+(offset-source.lastIndexOf('\n',offset));};
  const frames={'server/redact-sink-boundaries.test.ts':frame('server/redact-sink-boundaries.test.ts','expect(bytes).not.toContain(sentinel)'),'server/testing/redact-sink-extra.ts':frame('server/testing/redact-sink-extra.ts','expect(bytes).not.toMatch(')};
  writeFileSync(join(root,'node_modules/vitest/vitest.mjs'),`
import {writeFileSync} from 'node:fs';
import {resolve,basename} from 'node:path';
const report=process.env.TEST_TRUTH_MUTANT_REPORT,json=process.argv.find(arg=>arg.startsWith('--outputFile=')).slice('--outputFile='.length);
const [id,phase='red']=basename(report||json).replace(/\\.json$/,'').split('.'),scenario=process.env.TAFIX_SCENARIO;
const sinks=${JSON.stringify(SINK_BY_MUTANT)},frames=${JSON.stringify(frames)};
const sink=scenario==='other-sink'?'server/memory/record-write.ts':sinks[id]??'server/memory/record-write.ts';
const frameFile=sink==='server/memory/record-write.ts'?'server/redact-sink-boundaries.test.ts':'server/testing/redact-sink-extra.ts';
const failed=phase==='red'||(phase==='green'&&scenario==='no-baseline')||(phase==='restored'&&scenario==='no-restoration');
const file=resolve(process.argv.find(arg=>arg.endsWith('.test.ts')));
const error={name:'AssertionError',message:'Sink '+sink+': expected value not to contain sentinel',stack:'AssertionError\\n at '+resolve(frames[frameFile].split(':')[0])+':'+frames[frameFile].split(':').slice(1).join(':')};
console.log('fake vitest',id,phase);
if(report)writeFileSync(report,JSON.stringify({reason:failed?'failed':'passed',errors:[],tests:[{file,id:'redact-callsite.inventory',state:failed?'failed':'passed',hooks:['pass'],errors:failed?[error]:[]}]}));
writeFileSync(json,JSON.stringify({numPassedTests:failed?0:1,testResults:[{name:file,assertionResults:[{fullName:'redact-callsite.inventory',status:failed?'failed':'passed',failureMessages:failed?[error.name+': '+error.message+'\\n'+error.stack]:[]}]}]}));
process.exitCode=failed?1:0;
`);
  const legacyJson=join(root,'R4B-10-engine-line-unredacted.json');
  const legacyRun=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','server/redact-sink-boundaries.test.ts','--reporter=json','--outputFile='+legacyJson],{cwd:root,env:{...process.env,TEST_TRUTH_MUTANT_REPORT:'',TAFIX_SCENARIO:scenario},encoding:'utf8'});
  expect(legacyRun.status,legacyRun.stderr).toBe(1);
  const legacy=JSON.parse(readFileSync(legacyJson,'utf8'));
  expect(legacy.testResults).toEqual(expect.any(Array));
  expect(legacy.testResults).toEqual([{name:join(root,'server/redact-sink-boundaries.test.ts'),assertionResults:[{fullName:'redact-callsite.inventory',status:'failed',failureMessages:[expect.stringContaining('AssertionError: Sink '+(scenario==='other-sink'?'server/memory/record-write.ts':'server/engine-reply-check.ts'))]}]}]);
  const preload=join(root,'fixture-host.mjs');
  writeFileSync(preload,`import {registerHooks} from 'node:module';
registerHooks({resolve(name,context,next){return name==='node:os'&&context.parentURL!=='fixture:os'?{url:'fixture:os',shortCircuit:true}:next(name,context);},load(url,context,next){return url==='fixture:os'?{format:'module',shortCircuit:true,source:'export * from "node:os";export const loadavg=()=>[0,0,0];export const tmpdir=()=>${JSON.stringify(tmpdir())};'}:next(url,context);}});`);
  const run=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,'server/testing/tafix-r4b-mutants.mjs','10',out],{cwd:root,env:{...process.env,TEST_TRUTH_MUTANT_REPORT:'',CI:'1',TAFIX_SCENARIO:scenario},encoding:'utf8',timeout:120000,maxBuffer:4*1024**2});
  expect(run.error).toBeUndefined();
  const verdicts=Object.fromEntries([...run.stdout.matchAll(/^(R4B-10-[a-z-]+): (KILLED|NOT CERTIFIED)/gm)].map(match=>[match[1],match[2]==='KILLED']));
  expect(Object.keys(verdicts).sort(),run.stdout+run.stderr).toEqual(Object.keys(SINK_BY_MUTANT).concat(['R4B-10-text-pass-through','R4B-10-card-pass-through','R4B-10-sink-pass-through']).sort());
  for(const [id,killed] of Object.entries(verdicts))expect(killed,id+'\n'+run.stdout).toBe(expected[id]===true);
  expect(run.status,run.stdout+run.stderr).toBe(Object.values(verdicts).every(Boolean)?0:1);
 }finally{removeTempDirSync(root);removeTempDirSync(out);}
});

// A certifying runner that arrives later must be routed through the one verdict path, or the lane's own test fails.
it('every mutant runner is either routed through the intended-assertion verdict or frozen as legacy',async()=>{
 const {ADAPTERS,LEGACY,discoverRunners,inventory}=await import('./test-truth/runner-inventory.test-helper.mjs');
 const real=inventory(process.cwd());
 expect(real,'unrouted runners must use verifyDecisionMutant; legacy hashes must not change').toEqual({unrouted:[],missing:[],changed:[]});
 for(const path of ADAPTERS.filter(path=>path.startsWith('server/')&&path.endsWith('mutants.mjs')||path.endsWith('mutant.mjs'))){
  const source=readFileSync(path,'utf8');
  expect(source,path).toMatch(/verifyDecisionMutant\(/);
  expect(source,path).not.toMatch(/killed\s*=\s*[^;\n]*AssertionError/);
 }
 const root=mkdtempSync(join(tmpdir(),'runner-inventory-'));
 try{
  for(const path of [...ADAPTERS,...Object.keys(LEGACY)]){mkdirSync(join(root,path,'..'),{recursive:true});cpSync(resolve(path),join(root,path));}
  expect(inventory(root)).toEqual({unrouted:[],missing:[],changed:[]});
  mkdirSync(join(root,'server/x'),{recursive:true});
  writeFileSync(join(root,'server/x/new-mutants.mjs'),'export {};\n');
  expect(inventory(root).unrouted).toEqual(['server/x/new-mutants.mjs']);
  expect(discoverRunners(root)).toContain('server/x/new-mutants.mjs');
  removeTempDirSync(join(root,'server/x'));
  const legacy=Object.keys(LEGACY)[0],bytes=readFileSync(join(root,legacy));
  writeFileSync(join(root,legacy),Buffer.concat([bytes,Buffer.from('\n')]));
  expect(inventory(root).changed).toEqual([legacy]);
 }finally{removeTempDirSync(root);}
});
