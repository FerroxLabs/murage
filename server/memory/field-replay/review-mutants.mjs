#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Finding-specific RED reproductions. Use only an isolated scratch checkout.
import {readFileSync,writeFileSync,mkdirSync,existsSync,unlinkSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=process.cwd();
if(!process.env.FIELD_REPLAY_SCRATCH||!root.startsWith('/work')&&!root.includes('/bld-s2m-r4/'))throw new Error('Designated scratch checkout required');
const output=resolve(process.env.FIELD_REPLAY_EVIDENCE??'server/memory/.afix-evidence/review-mutants');mkdirSync(output,{recursive:true});
const replay='server/memory/field-replay.e2e.test.ts',unit='server/memory/field-replay/review-regressions.test.ts';
const cases=[
 ['B1-rows','server/memory/lineage-allowance-reads.test.ts','a cold root chain','server/memory/replay-lineage.ts',s=>s.replace('function sessionOutputRootsWork(allowance: LineageAllowance, threadId: string, driverInstance: string, nativeSession: string): OutputRoots {','function sessionOutputRootsWork(allowance: LineageAllowance, threadId: string, driverInstance: string, nativeSession: string): OutputRoots {\n  database().prepare("SELECT name FROM sqlite_schema").all();')],
 ['B1-opener','server/memory/upgrade-fix-r3.test.ts','R2-06: every connection','server/memory/review-unclassified-opener.fixture.ts',()=>`import {DatabaseSync} from 'node:sqlite';\nexport function neverCalled(){return new ${'Database'+'Sync'}('messages.db');}\n`],
 ['B2-target',unit,'B2:','server/memory/field-replay/controls.ts',s=>s.replace("tool_name:'mcp__murage_host_computer__click'","tool_name:'schedule_routine'")],
 ['B3-run-mark',replay,'R5-mark: real run-now dispatch forBot','server/index.ts',s=>s.replace('if (folderMark) markTurnOutside(threadId, folderMark','if (folderMark && !opts?.routineRunId) markTurnOutside(threadId, folderMark')],
 ['B4-verdict',unit,'B4: unrelated','server/memory/field-replay/harness.ts',s=>s.slice(0,s.indexOf('export function verdict(error:unknown)'))+"export function verdict(error:unknown){return error instanceof BehavioralRed?'RED':'BLOCKED-BY-S1';}\n"],
 ['B4-target-errors',unit,'B4: missing mutation targets','server/memory/field-replay/mutants.mjs',s=>s.replace("outcome:'ERROR',reason:String(error)","outcome:'BLOCKED-BY-S1',reason:String(error)")],
 ['R8-no-deny',unit,'R8 harness: zero-card',unit,s=>s.replace(" showCard('deny');\n const denied=", " // Deny card suppressed.\n const denied=")],
 ['R8-applied-card',unit,'R8 harness: zero-card',unit,s=>s.replace(' // Mutation anchor: a stray applied-phase card must fail before nextPhase.'," showCard('stray');")],
 ['R8-cumulative',unit,'R8 harness: zero-card','server/memory/field-replay/surface.ts',s=>s.replace('    this.assertions=[];','    // Mutant retains the previous phase assertions.')],
];
function run(dir,file,filter){
 mkdirSync(dir,{recursive:true});
 const result=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',file,'-t',filter,'--maxWorkers=1','--reporter=json',`--outputFile=${join(dir,'results.json')}`],{encoding:'utf8',timeout:240000,env:{...process.env,FIELD_REPLAY_EVIDENCE:dir}});
 writeFileSync(join(dir,'vitest.log'),String(result.stdout??'')+String(result.stderr??''));
 const path=join(dir,'results.json');
 const report=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
 return {exit:result.status,error:String(result.error??''),signal:result.signal,assertions:(report.testResults??[]).flatMap(t=>t.assertionResults??[])};
}
let failures=0;
for(const [id,file,filter,target,patch] of cases){
 const original=existsSync(target)?readFileSync(target,'utf8'):undefined;
 let row;
 try{
  const control=run(join(output,id,'control'),file,filter);
  const changed=patch(original??'');if(changed===original)throw new Error('mutation target absent');
  writeFileSync(target,changed);
  const mutant=run(join(output,id,'mutant'),file,filter);
  const reds=mutant.assertions.filter(a=>a.status==='failed'&&a.failureMessages.some(m=>/AssertionError|BehavioralRed/.test(m)));
  const green=control.exit===0&&control.assertions.some(a=>a.status==='passed');
  const killed=green&&mutant.exit!==0&&!mutant.error&&!mutant.signal&&reds.length>0;
  row={id,outcome:killed?'KILLED':'ERROR',control,mutant,reds:reds.map(a=>({test:a.fullName,failures:a.failureMessages}))};
  if(!killed)failures++;
 }catch(error){row={id,outcome:'ERROR',reason:String(error)};failures++;}
 finally{if(original===undefined){if(existsSync(target))unlinkSync(target);}else writeFileSync(target,original);}
 writeFileSync(join(output,'review-mutants.jsonl'),JSON.stringify(row)+'\n',{flag:'a'});console.log(`${id}: ${row.outcome}`);
}
process.exitCode=failures?1:0;
