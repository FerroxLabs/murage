// SPDX-License-Identifier: AGPL-3.0-or-later
// Inert tests in an isolated source copy. No live installation is loaded.
import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,unlinkSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {mutantKilled} from './mutant-verdict.mjs';
import {safeWipeSync} from '../../server/testing/safe-wipe.mjs';
if(process.env.CI!=='1')throw Error('Run in the isolated test container');
const source=process.cwd(),out=resolve(process.argv[2]??mkdtempSync(join(tmpdir(),'murage-truth-evidence-')));
mkdirSync(out,{recursive:true});
const root=mkdtempSync(join(out,'source-'));
for(const entry of readdirSync(source))if(!/^(node_modules|\.git$|\.test-tmp|\.v\d|\.vrel|evidence|lane-evidence|coverage|test-results|playwright-report|target|dist|build|\.planning|\.pnpm-store)/.test(entry))cpSync(join(source,entry),join(root,entry),{recursive:true});
symlinkSync(join(source,'node_modules'),join(root,'node_modules'),'dir');
function run(id,files,pattern){
 const json=join(out,id+'.json'),details=join(out,id+'.details.json');
 for(const file of [json,details])if(existsSync(file))unlinkSync(file);
 const result=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',...files,'--reporter=json','--reporter=./scripts/test-truth/mutant-reporter.mjs','--outputFile='+json,...(pattern?['-t',pattern]:[])],{cwd:root,env:{...process.env,TEST_TRUTH_MUTANT_REPORT:details},encoding:'utf8',maxBuffer:32*1024**2,timeout:180000});
 writeFileSync(join(out,id+'.log'),(result.stdout??'')+(result.stderr??''));
 const report=existsSync(json)?JSON.parse(readFileSync(json,'utf8')):undefined;
 const failures=report?.testResults.flatMap(file=>file.assertionResults.filter(test=>test.status==='failed').map(test=>({id:test.fullName,messages:test.failureMessages})))??[];
 return {code:result.status,passed:report?.numPassedTests??0,failures,details:existsSync(details)?JSON.parse(readFileSync(details,'utf8')):null};
}
const specs=[
 ['named-project-clean','server/wipe/decide.ts',s=>s.replace("effect.k==='git-clean'&&root==='project-root'||",''),['server/no-limits-code.test.ts'],'current No limits policy.*S6'],
 ['bounded-protected-reader','server/no-limits-protected.ts',s=>s.replace('    if (!(error instanceof Unreadable)) throw error;', '    throw error;'),['server/no-limits-afix-lexer-recovery.test.ts','server/no-limits-afix-local-recovery.test.ts'],'No limits protected'],
 ['shard-partition','scripts/test-truth/compare.py',s=>s.replace('if len(inventories) == 8:\n        missing', 'if False:\n        missing'),['scripts/test-truth-compare.test.mjs'],'reports a new failing ID inside an already red file'],
 ['hung-test-id','scripts/test-truth/compare.py',s=>s.replace('if progress.exists():','if False and progress.exists():'),['scripts/test-truth-compare.test.mjs'],'reports a new failing ID inside an already red file'],
 ['release-tier','ci/gate-tests.txt',s=>s.split('\n').filter(line=>!line.startsWith('server/no-limits-wipe-r3.test.ts\t')).join('\n'),['scripts/ci-test-tiers-node.test.mjs'],'all 30 added'],
 ['resolved-root','server/auto-approve.ts',s=>s.replace('function noLimitsOnlyVerdict(tool: string, summary: string, context?: AutoContext): AutoVerdict {',`function noLimitsOnlyVerdict(tool: string, summary: string, context?: AutoContext): AutoVerdict {\n if(tool==='python')return {approve:'auto-approved python (no limits)',source:'no-limits'};`),['server/no-limits-code.test.ts'],'current No limits policy keeps the resolved root'],
 ['missing-snapshot','vite.config.ts',s=>s.replace('update: "none"','update: "new"'),['scripts/test-truth-no-update.test.mjs'],'a runner without CI cannot silently write a missing snapshot'],
 ['snapshot-accounting','scripts/test-truth/compare.py',s=>s.replace("for field in ('added', 'updated', 'unchecked', 'filesRemoved'):","for field in ():"),['scripts/test-truth-compare.test.mjs'],'reports a new failing ID inside an already red file'],
 ['node-gate-runner','package.json',s=>{const p=JSON.parse(s);p.scripts['test:electron']=p.scripts['test:electron'].replace(' \"scripts/no-limits-live/*.node-test.mjs\"','');p.scripts['test:scripts']+=' --exclude \"scripts/no-limits-live/*.node-test.mjs\"';return JSON.stringify(p);},['scripts/ci-test-tiers-node.test.mjs'],'No limits release rulings'],
 ['protected-write','server/auto-approve.ts',s=>s.replace('function noLimitsOnlyVerdict(tool: string, summary: string, context?: AutoContext): AutoVerdict {',`function noLimitsOnlyVerdict(tool: string, summary: string, context?: AutoContext): AutoVerdict {\n if(context?.commandText?.includes('.ssh/config'))return {approve:null,source:'always-ask',rule:'protected-path'};`),['server/no-limits-afix-lexer-recovery.test.ts'],'No limits protected'],
 ['unknown-delete','server/auto-approve.ts',s=>s.replace('function noLimitsOnlyVerdict(tool: string, summary: string, context?: AutoContext): AutoVerdict {',`function noLimitsOnlyVerdict(tool: string, summary: string, context?: AutoContext): AutoVerdict {\n if(summary.includes('rm -rf -- build'))return {approve:null,source:'always-ask',rule:'plainWipe'};`),['server/no-limits-code.test.ts'],'current No limits policy.*P1sh'],
];
specs.push(
 ['owner-switch-bulk','server/approve-all.ts',s=>s.replace('\"owner-switch\": \"held\"','\"owner-switch\": null'),['server/approve-all.test.ts'],'owner-switch refusals'],
 ['owner-switch-fold','shared/fold-scopes.ts',s=>s.replace('\"owner-switch\": \"none\"','\"owner-switch\": \"class\"'),['server/approve-all.test.ts'],'owner-switch refusals'],
 ['retry-red-preservation','scripts/test-truth/compare.py',s=>s.replace('for key, observed in observed_failures.items():','for key, observed in {}.items():'),['scripts/test-truth-compare.test.mjs'],'reports a new failing ID inside an already red file'],
 ['outside-store-relief','server/index.ts',s=>s.replace('if(!noLimitsAppliesTo(origin,bot))return false;', 'if(true)return false;'),['server/no-limits-uncovered-outside-api.test.ts'],'outside-store failure'],
 ['channel-lower-level','server/decision/implementation.ts',s=>s.replace("if(e.authority.fullAccessChannelMessages===false&&","if(e.authority.level==='unlimited'&&e.authority.fullAccessChannelMessages===false&&"),['server/no-limits-external-r3.test.ts'],'registered owner channel off.*ask'],
 ['durable-card-identity','scripts/no-limits-live/counts.mjs',s=>s.replace('||record.chat_message_id!==message.id',''),['scripts/no-limits-live/release.test.mjs'],'durable card binding'],
 ['owner-deny-priority','server/decision/implementation.ts',s=>s.replace('else if(r.deny.some(explicitHostDecline))outcome=', 'else if(false&&r.deny.some(explicitHostDecline))outcome='),['server/decision/no-limits-uncovered-rows.test.ts'],'R2 explicit host refusal takes priority'],
 ['dry-run-push','server/wipe-breaker.ts',s=>s.replace('const scan=inspectWipe(text,ctx);return withRecords?scan:scan.hit;', "const scan=/^git push.*(?:--dry-run|-n)/.test(text)?emptyScan({rule:'delete-root',what:'Whole root wipe'}):inspectWipe(text,ctx);return withRecords?scan:scan.hit;"),['server/no-limits-wipe-cover.test.ts'],'W5 git bulk wipe git push --mirror (?:--dry-run|-n)'],
 ['native-protected-change','server/decision/implementation.ts',s=>s.replace('else if(owner(e)){',"else if(owner(e)&&r.action.tool==='apply_patch')outcome=approval(e,'base',[]);\n else if(owner(e)){"),['server/drivers/no-limits-codex-release-1019.test.ts'],'R10c1 real NL patch hook changed=true'],
 ['native-root-wipe','server/decision/implementation.ts',s=>s.replace('const wipes=wipeEvidence(r.action);','const wipes:readonly T.Evidence[]=[];'),['server/drivers/no-limits-codex-release-1019.test.ts'],'R10e literal root wipe'],
 ['channel-off-refusal','server/decision/implementation.ts',s=>s.replace("if(e.authority.fullAccessChannelMessages===false&&e.authority.noLimitsOrigin==='owner-channel')return CHANNEL_MESSAGES_OFF;","if(false&&e.authority.fullAccessChannelMessages===false&&e.authority.noLimitsOrigin==='owner-channel')return CHANNEL_MESSAGES_OFF;"),['server/no-limits-external-r3.test.ts'],'registered owner channel off refuses'],
 ['explicit-guest','server/no-limits-origin.ts',s=>s.replace("if (guest) return false;","if (guest && bot.permissionExplicit !== true) return false;"),['server/decision/no-limits-uncovered-rows.test.ts'],'R1 explicit 1.0.19 bot applies'],
);
specs.push(
 ['turn-failure-cleanup','server/index.ts',s=>s.replace('  internalCapabilities.revokeGeneration(threadId, generation);',''),['server/internal-capabilities.test.ts'],'consuming turn cleanup actual turn throw'],
 ['call-scoped-browser-read','server/browser-extension-service.ts',s=>s.replace(" && !ownerReadTurn(entry, scope)",""),['server/browser-read-route-inventory.test.ts'],'No limits read cleanup removes native and saved authority|No limits read grant is call scoped|No limits snapshot auto-admits'],
 ...['rm ','diskpart','Directory.Delete','dropDatabase'].map((word,index)=>[
  'raw-delete-entry-'+index,'shared/no-limits-raw-wipe.ts',s=>s.replace(" '"+word+"',",' '),['server/no-limits-raw-boundaries-r9.test.ts'],'R9 bounded primitive',
 ]),
);
const selected=process.env.TEST_TRUTH_MUTANTS?.split(',');
const active=selected?specs.filter(([id])=>selected.includes(id)):specs;
if(!active.length||selected?.some(id=>!active.some(([name])=>name===id)))throw Error('Unknown or empty mutant selection');
const proof=[];
try{
 for(const [id,file,mutate,files,pattern]of active){
  const path=join(root,file),original=readFileSync(path,'utf8'),changed=mutate(original);
  if(changed===original){proof.push({id,file,files,pattern,killed:false,reason:'missing mutation anchor'});continue;}
  const green=run(id+'-green',files,pattern);
  if(green.code!==0||green.passed<1){proof.push({id,file,files,pattern,killed:false,reason:'baseline not green or no selected assertions',green});writeFileSync(join(out,'proof.json'),JSON.stringify(proof,null,2)+'\n');continue;}
  let red;try{writeFileSync(path,changed);red=run(id+'-red',files,pattern);}finally{writeFileSync(path,original);}
  const restored=run(id+'-restored',files,pattern);
  const killed=mutantKilled(green,red,restored);
  const previousKilled=red.code===1&&red.failures.length>0&&restored.code===0&&restored.passed>0;
  proof.push({id,file,files,pattern,killed,previousKilled,green,red,restored});writeFileSync(join(out,'proof.json'),JSON.stringify(proof,null,2)+'\n');
  console.log(id+': '+(killed?'KILLED, restored GREEN':'NOT CERTIFIED'));
 }
}finally{safeWipeSync(root,{within:out,reason:'isolated test truth mutants'});}

writeFileSync(join(out,'proof.json'),JSON.stringify(proof,null,2)+'\n');
writeFileSync(join(out,'changed-verdicts.json'),JSON.stringify(proof.filter(row=>row.previousKilled!==undefined&&row.previousKilled!==row.killed).map(({id,file,files})=>({id,file,files})),null,2)+'\n');
if(proof.some(row=>!row.killed))process.exitCode=1;
