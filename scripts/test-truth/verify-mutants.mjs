// SPDX-License-Identifier: AGPL-3.0-or-later
// Inert tests in an isolated source copy. No live installation is loaded.
import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {safeWipeSync} from '../../server/testing/safe-wipe.mjs';
if(process.env.CI!=='1')throw Error('Run in the isolated test container');
const source=process.cwd(),out=resolve(process.argv[2]??'evidence/test-truth-r2/mutants');
mkdirSync(out,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'truth-mutants-'));
for(const entry of readdirSync(source))if(!/^(node_modules|\.git|\.test-tmp|\.v\d|\.vrel|evidence|dist|build|\.planning)/.test(entry))cpSync(join(source,entry),join(root,entry),{recursive:true});
symlinkSync(join(source,'node_modules'),join(root,'node_modules'),'dir');
function run(id,files,pattern){
 const json=join(out,id+'.json');
 const result=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',...files,'--reporter=json','--outputFile='+json,...(pattern?['-t',pattern]:[])],{cwd:root,env:process.env,encoding:'utf8',maxBuffer:32*1024**2,timeout:180000});
 writeFileSync(join(out,id+'.log'),(result.stdout??'')+(result.stderr??''));
 const report=existsSync(json)?JSON.parse(readFileSync(json,'utf8')):undefined;
 const failures=report?.testResults.flatMap(file=>file.assertionResults.filter(test=>test.status==='failed').map(test=>({id:test.fullName,messages:test.failureMessages})))??[];
 return {code:result.status,passed:report?.numPassedTests??0,failures};
}
const specs=[
 ['named-project-clean','server/no-limits-wipe-git.ts',s=>s.replace("if(args[sub]==='clean'){","if(args[sub]==='clean'){return false;"),['server/no-limits-code.test.ts'],'current No limits policy.*S6'],
 ['bounded-protected-reader','server/no-limits-protected.ts',s=>s.replace('    if (!(error instanceof Unreadable)) throw error;\n  }\n  let found:', '    throw error;\n  }\n  let found:'),['server/no-limits-afix-lexer-recovery.test.ts','server/no-limits-afix-local-recovery.test.ts'],'No limits protected'],
 ['shard-partition','scripts/test-truth/compare.py',s=>s.replace('if len(inventories) == 8:\n        missing', 'if False:\n        missing'),['scripts/test-truth-compare.test.mjs']],
 ['hung-test-id','scripts/test-truth/compare.py',s=>s.replace('for file in progress_results(shard, receipt):','for file in []:'),['scripts/test-truth-compare.test.mjs']],
 ['release-tier','ci/gate-tests.txt',s=>s.split('\n').filter(line=>!line.startsWith('server/no-limits-wipe-r3.test.ts\t')).join('\n'),['scripts/ci-test-tiers-node.test.mjs'],'all 30 added'],
 ['resolved-root','server/auto-approve.ts',s=>s.replace('function noLimitsOnlyVerdict(tool: string, summary: string, context?: AutoContext): AutoVerdict {',`function noLimitsOnlyVerdict(tool: string, summary: string, context?: AutoContext): AutoVerdict {\n if(tool==='python')return {approve:'auto-approved python (no limits)',source:'no-limits'};`),['server/no-limits-code.test.ts'],'current No limits policy keeps the resolved root'],
 ['missing-snapshot','vite.config.ts',s=>s.replace('update: "none"','update: "new"'),['scripts/test-truth-no-update.test.mjs']],
 ['snapshot-accounting','scripts/test-truth/compare.py',s=>s.replace("for field in ('added', 'updated', 'unchecked', 'filesRemoved'):","for field in ():"),['scripts/test-truth-compare.test.mjs']],
 ['node-gate-runner','package.json',s=>{const p=JSON.parse(s);p.scripts['test:electron']=p.scripts['test:electron'].replace(' \"scripts/no-limits-live/*.node-test.mjs\"','');return JSON.stringify(p);},['scripts/ci-test-tiers-node.test.mjs'],'No limits release rulings'],
 ['protected-write','server/auto-approve.ts',s=>s.replace('function noLimitsOnlyVerdict(tool: string, summary: string, context?: AutoContext): AutoVerdict {',`function noLimitsOnlyVerdict(tool: string, summary: string, context?: AutoContext): AutoVerdict {\n if(context?.commandText?.includes('.ssh/config'))return {approve:null,source:'always-ask',rule:'protected-path'};`),['server/no-limits-afix-lexer-recovery.test.ts'],'No limits protected'],
 ['unknown-delete','server/auto-approve.ts',s=>s.replace('function noLimitsOnlyVerdict(tool: string, summary: string, context?: AutoContext): AutoVerdict {',`function noLimitsOnlyVerdict(tool: string, summary: string, context?: AutoContext): AutoVerdict {\n if(summary.includes('rm -rf -- build'))return {approve:null,source:'always-ask',rule:'plainWipe'};`),['server/no-limits-code.test.ts'],'current No limits policy.*P1sh'],
];
specs.push(
 ['owner-switch-bulk','server/approve-all.ts',s=>s.replace('\"owner-switch\": \"held\"','\"owner-switch\": null'),['server/approve-all.test.ts'],'owner-switch refusals'],
 ['owner-switch-fold','shared/fold-scopes.ts',s=>s.replace('\"owner-switch\": \"none\"','\"owner-switch\": \"class\"'),['server/approve-all.test.ts'],'owner-switch refusals'],
 ['retry-red-preservation','scripts/test-truth/compare.py',s=>s.replace("file_results.setdefault(path, []).append(file)","file_results[path] = [file]").replace("file_results.setdefault(file['name'], []).append(file)","file_results[file['name']] = [file]"),['scripts/test-truth-compare.test.mjs']],
 ['outside-store-relief','server/index.ts',s=>s.replace('if(!noLimitsAppliesTo(origin,bot))return false;', 'if(true)return false;'),['server/no-limits-uncovered-outside-api.test.ts']],
 ['channel-lower-level','server/decision/implementation.ts',s=>s.replace("if(e.authority.fullAccessChannelMessages===false&&","if(r.level==='unlimited'&&e.authority.fullAccessChannelMessages===false&&"),['server/no-limits-external-r3.test.ts'],'registered owner channel off.*ask'],
 ['durable-card-identity','scripts/no-limits-live/counts.mjs',s=>s.replace('||record.chat_message_id!==message.id',''),['scripts/no-limits-live/release.test.mjs'],'durable card binding'],
 ['owner-deny-priority','server/decision/implementation.ts',s=>s.replace('if(r.deny.some(ownerSwitch))outcome=', 'if(false&&r.deny.some(ownerSwitch))outcome='),['server/decision/no-limits-uncovered-rows.test.ts'],'R2 stored owner deny'],
 ['dry-run-push','server/no-limits-wipe.ts',s=>s.replace("    if(op==='push'&&rest.some(word=>word==='--dry-run'||word==='-n'))continue;",''),['server/no-limits-wipe-cover.test.ts'],'W5 git bulk wipe git push --mirror'],
 ['native-protected-change','server/decision/implementation.ts',s=>s.replace('const wipeOnly=ownerEligible(authority(e.threadId,e.authority.botId,e.authority.generation));','const wipeOnly=false && ownerEligible(authority(e.threadId,e.authority.botId,e.authority.generation));'),['server/drivers/no-limits-codex-release-1019.test.ts'],'R10c1 real NL patch hook changed=true'],
 ['native-root-wipe','server/decision/implementation.ts',s=>s.replace('const wipes=wipeEvidence(r.action);','const wipes:readonly T.Evidence[]=[];'),['server/drivers/no-limits-codex-release-1019.test.ts'],'R10e literal root wipe'],
 ['channel-off-refusal','server/decision/implementation.ts',s=>s.replace("outcome={kind:'refuse',message:'Channel messages are off for this bot. Turn them on to use this action.'}","outcome=approval(e,'base',[])"),['server/no-limits-external-r3.test.ts'],'registered owner channel off refuses'],
 ['explicit-guest','server/no-limits-origin.ts',s=>s.replace("if (guest && (bot.permissionExplicit !== true || bot.fullAccessChannelMessages === false)) return false;","if (guest) return false;"),['server/service-no-limits.test.ts'],'O6 webhook uses the bot level'],
);
const selected=process.env.TEST_TRUTH_MUTANTS?.split(',');
const active=selected?specs.filter(([id])=>selected.includes(id)):specs;
if(!active.length||selected?.some(id=>!active.some(([name])=>name===id)))throw Error('Unknown or empty mutant selection');
const proof=[];
try{
 for(const [id,file,mutate,files,pattern]of active){
  const path=join(root,file),original=readFileSync(path,'utf8'),changed=mutate(original);
  if(changed===original)throw Error('Missing mutation anchor: '+id);
  const green=run(id+'-green',files,pattern);
  if(green.code!==0||green.passed<1)throw Error('Baseline is not green or selected no assertions: '+id);
  let red;try{writeFileSync(path,changed);red=run(id+'-red',files,pattern);}finally{writeFileSync(path,original);}
  const restored=run(id+'-restored',files,pattern);
  const killed=red.code===1&&red.failures.length>0&&restored.code===0&&restored.passed>0;
  proof.push({id,killed,green,red,restored});writeFileSync(join(out,'proof.json'),JSON.stringify(proof,null,2)+'\n');
  if(!killed)throw Error('Mutant survived: '+id);
  console.log(id+': KILLED, restored GREEN');
 }
}finally{safeWipeSync(root,{reason:'isolated test truth mutants'});}
