// SPDX-License-Identifier: AGPL-3.0-or-later
// Inert tests in an isolated source copy. No live installation is loaded.
import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,unlinkSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {intendedAssertionKilled} from './intended-assertion.test-helper.mjs';
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
 return {code:result.status,signal:result.signal,error:result.error?.code,passed:report?.numPassedTests??0,failures,details:existsSync(details)?JSON.parse(readFileSync(details,'utf8')):null};
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
specs.push(
 ['unrelated-assertion-kill','scripts/test-truth/intended-assertion.test-helper.mjs',s=>s.replace(' if(!mutantKilled(green,red,restored)', ' return mutantKilled(green,red,restored);\n if(!mutantKilled(green,red,restored)'),['server/internal-capabilities.test.ts'],'a kill requires the pinned assertion'],
 ['fixture-exception-kill','scripts/test-truth/intended-assertion.test-helper.mjs',s=>s.replace(' if(!mutantKilled(green,red,restored)', " if(red.details?.tests.some(test=>test.errors.some(error=>error.name==='TypeError')))return true;\n if(!mutantKilled(green,red,restored)"),['server/internal-capabilities.test.ts'],'a kill requires the pinned assertion'],
 ['test-timeout-kill','scripts/test-truth/intended-assertion.test-helper.mjs',s=>s.replace(' if(!mutantKilled(green,red,restored)', " if(red.details?.tests.some(test=>test.errors.some(error=>error.message?.startsWith('Test timed out'))))return true;\n if(!mutantKilled(green,red,restored)"),['server/internal-capabilities.test.ts'],'a kill requires the pinned assertion'],
 ['infrastructure-kill','scripts/test-truth/intended-assertion.test-helper.mjs',s=>s.replace('||[green,red,restored].some(run=>run.signal||run.error)',''),['server/internal-capabilities.test.ts'],'a kill requires the pinned assertion'],
 ['downgrade-chat-loss','server/installation-memory-downgrade.ts',s=>s.replace('      downgradeMessageSearch(db);', '      downgradeMessageSearch(db); db.exec("DELETE FROM messages");'),['server/installation-recovery-command.test.ts'],'supports a stopped-installation downgrade'],
 ['downgrade-memory-content-loss','server/installation-memory-downgrade.ts',s=>s.replace('      downgradeMessageSearch(db);', '      downgradeMessageSearch(db); db.exec("DELETE FROM memory_records");'),['server/installation-recovery-command.test.ts'],'supports a stopped-installation downgrade'],
 ['downgrade-chat-table-loss','server/installation-memory-downgrade.ts',s=>s.replace('      downgradeMessageSearch(db);', '      downgradeMessageSearch(db); db.exec("DROP TABLE messages_fts");'),['server/installation-recovery-command.test.ts'],'supports a stopped-installation downgrade'],
 ['downgrade-memory-retained','server/installation-memory-downgrade.ts',s=>s.replace('      const reported = {', '      db.exec("CREATE TABLE memory_source_lsn(lsn INTEGER)"); const reported = {'),['server/installation-recovery-command.test.ts'],'supports a stopped-installation downgrade'],
 ['turn-return-cleanup','server/index.ts',s=>s.replace('    internalCapabilities.completeProviderTurn(event.threadId, event.turnId);','    void event.turnId;'),['server/internal-capabilities.test.ts'],'actual turn return releases its memory lease'],
 ['turn-throw-cleanup','server/index.ts',s=>s.replace('  internalCapabilities.revokeGeneration(threadId, generation);','  void generation;'),['server/internal-capabilities.test.ts'],'actual turn throw releases its memory lease'],
 ['turn-abort-cleanup','server/index.ts',s=>s.replace('  internalCapabilities.revokeGeneration(threadId, generation);','  void generation;'),['server/internal-capabilities.test.ts'],'actual turn abort releases its memory lease'],
);
specs.push(
 ['admission-unrelated-rejection','server/composio.ts',s=>s.replace('export async function connectionStatus(cfg: AppConfig, slugs: string[]) {', "export async function connectionStatus(cfg: AppConfig, slugs: string[]) { throw new TypeError('fixture failure');"),['server/composio-admission.test.ts'],'public server producer admission matrix S05'],
 ['admission-expiry-no-dispatch','server/composio.ts',s=>s.replace('export async function runConnectorHealthPass(cfg: AppConfig, scheduled: (now: number) => string[]): Promise<void> {','export async function runConnectorHealthPass(cfg: AppConfig, scheduled: (now: number) => string[]): Promise<void> { return;'),['server/composio-admission.test.ts'],'public server producer admission matrix S02'],
 ['privacy-final-native-wire','server/drivers/engine-wire.ts',s=>s.replace('export function engineJsonLine(value: unknown, beforeWrite?: () => void): string {', `export function engineJsonLine(value: unknown, beforeWrite?: () => void): string {
 if((value as any)?.method==='turn/start'&&JSON.stringify((value as any).params?.input).includes('PRIVACY_NEXT_ORDINARY'))value={...(value as any),params:{...(value as any).params,transportDebug:'WITHHELD_CONVERSATION_LINE'}};`),['server/fence-pending-turn-api.test.ts'],"CTX-PRIVACY.*codex.*tier-1"],
 ['privacy-final-late-wire','server/testing/fake-late-terminal-driver.ts',s=>s.replace('try { return turn.beforeSubmit?.(); }', "try { const result=turn.beforeSubmit?.(); if(turn.text.includes('PRIVACY_NEXT_ORDINARY'))turn.text+=' WITHHELD_CONVERSATION_LINE'; return result; }"),['server/fence-pending-turn-api.test.ts'],'CTX-PRIVACY tier-1'],
 ['wipe-execution-omitted','server/testing/wipe-execution.test-helper.ts',s=>s.replace("execFileSync('bash',['-c',judged.command]", "void ('bash',['-c',judged.command]"),['server/decision/wipe-effect-records.test.ts'],'isolated documented fixture refreshes a nested disk'],
 ['wipe-retarget-unbound','server/decision/release-guard.ts',s=>s.replace('return wipeEvidenceCovers(fresh.wipes??[],approved.wipes??[])&&', 'return '),['server/decision/wipe-effect-records.test.ts'],'consuming IPC move.*retarget'],
 ['wipe-replay-release','server/decision/provider-release.ts',s=>s.replace(" try{return reader?.(identity,updatedInput as ApprovalAnswer['updatedInput'],replay)===true;}"," try{return true;}"),['server/decision/wipe-effect-records.test.ts'],'consuming IPC move.*exact'],
 ['wipe-cancel-release','server/decision/provider-release.ts',s=>s.replace(" try{return reader?.(identity,updatedInput as ApprovalAnswer['updatedInput'],replay)===true;}"," try{return true;}"),['server/decision/wipe-effect-records.test.ts'],'consuming IPC move.*cancel'],
);
specs.push(
 ['verdict-unpinned-frame','scripts/test-truth/intended-assertion.test-helper.mjs',s=>s.replace('return sources.some(({path,source,assertion,message})=>{','return true;\n  return sources.some(({path,source,assertion,message})=>{'),['server/internal-capabilities.test.ts'],'tafix-r4b runner scenario other-sink'],
 ['verdict-synthetic-baseline','scripts/test-truth/decision-mutant.test-helper.mjs',s=>s.replace("const green=await run('green');","const measured=await run('green'),green={...measured,code:0,passed:1,details:{...measured.details,reason:'passed',errors:[],tests:measured.details.tests.map(test=>({...test,state:'passed',errors:[]}))}};"),['server/internal-capabilities.test.ts'],'tafix-r4b runner scenario no-baseline'],
 ['verdict-restored-reuses-green','scripts/test-truth/decision-mutant.test-helper.mjs',s=>s.replace("const restored=await run('restored');",'const restored=green;'),['server/internal-capabilities.test.ts'],'tafix-r4b runner scenario no-restoration'],
 ['inventory-skips-adapter-dir','scripts/test-truth/runner-inventory.test-helper.mjs',s=>s.replace('if(!SKIP.has(entry.name))walk(path);',"if(!SKIP.has(entry.name)&&path!=='server/testing')walk(path);"),['server/internal-capabilities.test.ts'],'every mutant runner is either routed'],
 ['inventory-skips-hash','scripts/test-truth/runner-inventory.test-helper.mjs',s=>s.replace('gitBlobSha1(readFileSync(join(root,path)))!==hash','false'),['server/internal-capabilities.test.ts'],'every mutant runner is either routed'],
 ['engine-pin-widened','server/testing/tafix-r4b-pins.json',s=>{const pins=JSON.parse(s);pins['R4B-10-engine-line-unredacted']=pins['R4B-10-text-pass-through'];return JSON.stringify(pins);},['server/internal-capabilities.test.ts'],'tafix-r4b runner scenario other-sink'],
 ['witness-omits-legacy-report','scripts/test-truth-decision-runners.test-helper.mjs',s=>s.replace('testResults:[{name:file','legacyResults:[{name:file'),['server/internal-capabilities.test.ts'],'tafix-r4b runner scenario other-sink'],
);
const intendedAssertions={
 "named-project-clean": {
  "file": "server/no-limits-code.test.ts",
  "assertion": "expect(actual).toMatchObject({approve:`auto-approved ${tool} (no limits)`,source:'no-limits'})"
 },
 "bounded-protected-reader": {
  "file": "server/no-limits-afix-lexer-recovery.test.ts",
  "assertion": "expect(()=>{finding=noLimitsProtectedWrite(command, context, undefined, true);}).not.toThrow()"
 },
 "shard-partition": {
  "file": "scripts/test-truth-compare.test.mjs",
  "assertion": "expect(run().status).toBe(2)"
 },
 "hung-test-id": {
  "file": "scripts/test-truth-compare.test.mjs",
  "assertion": "expect(readFileSync(join(root,'results/head-red-test-ids.txt'),'utf8')).toBe('server/guard.test.ts :: <TIMEOUT>\\nserver/guard.test.ts :: duplicate name\\n')"
 },
 "release-tier": {
  "file": "scripts/ci-test-tiers-node.test.mjs",
  "assertion": "expect(lists.gate.has(path),path).toBe(true)"
 },
 "resolved-root": {
  "file": "server/no-limits-code.test.ts",
  "assertion": "expect(actual).toMatchObject({approve:null,source:'always-ask',rule:'delete-root'})"
 },
 "missing-snapshot": {
  "file": "scripts/test-truth-no-update.test.mjs",
  "assertion": "expect(missing.status,missing.stdout+missing.stderr).toBe(1)"
 },
 "snapshot-accounting": {
  "file": "scripts/test-truth-compare.test.mjs",
  "assertion": "expect(run().status,`snapshot ${field} must invalidate the comparison`).toBe(2)"
 },
 "protected-write": {
  "file": "server/no-limits-afix-lexer-recovery.test.ts",
  "assertion": "expect(finalized).toMatchObject({ approve: 'auto-approved Bash (no limits)', source: 'no-limits' })"
 },
 "unknown-delete": {
  "file": "server/no-limits-code.test.ts",
  "assertion": "expect(actual).toMatchObject({approve:`auto-approved ${tool} (no limits)`,source:'no-limits'})"
 },
 "owner-switch-bulk": {
  "file": "server/approve-all.test.ts",
  "assertion": "expect(BULK_REASON['owner-switch']).toBe('held')"
 },
 "owner-switch-fold": {
  "file": "server/approve-all.test.ts",
  "assertion": "expect(REASON_FOLD['owner-switch']).toBe('none')"
 },
 "retry-red-preservation": {
  "file": "scripts/test-truth-compare.test.mjs",
  "assertion": "expect(run().status,'a passing retry cannot erase failed assertion IDs').toBe(1)"
 },
 "outside-store-relief": {
  "file": "server/no-limits-uncovered-outside-api.test.ts",
  "assertion": "expect(waited).toMatchObject({status:'settled'})"
 },
 "channel-lower-level": {
  "file": "server/no-limits-external-r3.test.ts",
  "assertion": "expect(d.decide(handle,baseCard)).toMatchObject({kind:'refuse',message:'Channel messages are off"
 },
 "durable-card-identity": {
  "file": "scripts/no-limits-live/release.test.mjs",
  "assertion": "expect(()=>ledger.bindRegistration('t',message,{...record,...patch})).toThrow()"
 },
 "native-root-wipe": {
  "file": "server/drivers/no-limits-codex-release-1019.test.ts",
  "assertion": "expect(outcomes.map(outcome=>outcome.kind)).toEqual(['card'])"
 },
 "channel-off-refusal": {
  "file": "server/no-limits-external-r3.test.ts",
  "assertion": "expect(d.decide(handle,baseCard)).toMatchObject({kind:'refuse',message:'Channel messages are off"
 },
 "explicit-guest": {
  "file": "server/decision/no-limits-uncovered-rows.test.ts",
  "assertion": "expect(noLimitsAppliesTo(origin,{...nl,permissionExplicit:true})).toBe(false)"
 },
 "raw-delete-entry-0": {
  "file": "server/no-limits-raw-boundaries-r9.test.ts",
  "assertion": "expect(rawDeletePrimitive(token)).toBe(shellPrimitive)"
 },
 "raw-delete-entry-1": {
  "file": "server/no-limits-raw-boundaries-r9.test.ts",
  "assertion": "expect(rawDeletePrimitive(token)).toBe(shellPrimitive)"
 },
 "raw-delete-entry-2": {
  "file": "server/no-limits-raw-boundaries-r9.test.ts",
  "assertion": "expect(rawDeletePrimitive(token)).toBe(shellPrimitive)"
 },
 "raw-delete-entry-3": {
  "file": "server/no-limits-raw-boundaries-r9.test.ts",
  "assertion": "expect(rawDeletePrimitive(token)).toBe(shellPrimitive)"
 },
 "owner-deny-priority": {
  "file": "server/decision/no-limits-uncovered-rows.test.ts",
  "assertion": "expect(d.decide(h,baseRun).kind).toBe('card')"
 },
 "dry-run-push": {
  "file": "server/no-limits-wipe-cover.test.ts",
  "assertion": "expect(d.decide(f.open(command,{command,cwd:'/w'}),baseRun).kind).toBe('run')"
 },
 "native-protected-change": {
  "file": "server/drivers/no-limits-codex-release-1019.test.ts",
  "assertion": "expect(outcomes).toEqual([{kind:'run'}])"
 },
 "call-scoped-browser-read": {
  "file": "server/browser-read-route-inventory.test.ts",
  "assertion": "expect(f.approvedSets.at(-1)).toEqual([])"
 },
 "node-gate-runner": {
  "file": "scripts/ci-test-tiers-node.test.mjs",
  "assertion": "expect(nodeGateFiles()).toContain(path)"
 },
 "unrelated-assertion-kill": {
  "file": "scripts/test-truth-intended-assertion.test-helper.mjs",
  "testFile": "server/internal-capabilities.test.ts",
  "assertion": "expect(killed(unrelated)).toBe(false)"
 },
 "fixture-exception-kill": {
  "file": "scripts/test-truth-intended-assertion.test-helper.mjs",
  "testFile": "server/internal-capabilities.test.ts",
  "assertion": "expect(killed(run)).toBe(false)"
 },
 "infrastructure-kill": {
  "file": "scripts/test-truth-intended-assertion.test-helper.mjs",
  "testFile": "server/internal-capabilities.test.ts",
  "assertion": "expect(killed({...red(),...extra})).toBe(false)"
 },
 "downgrade-chat-loss": {
  "file": "server/installation-recovery-command.test.ts",
  "assertion": "expect(after.prepare(\"SELECT thread_id,id,at,role,kind,text,json FROM messages ORDER BY at\").all()).toEqual(chats.map(([thread_id,id,at,role,kind,text,json])=>({thread_id,id,at,role,kind,text,json})))"
 },
 "downgrade-chat-table-loss": {
  "file": "server/installation-recovery-command.test.ts",
  "assertion": "expect(after.prepare(\"SELECT name FROM sqlite_schema WHERE name IN ('messages','messages_fts') ORDER BY name\").all()).toEqual([{name:'messages'},{name:'messages_fts'}])"
 },
 "downgrade-memory-retained": {
  "file": "server/installation-recovery-command.test.ts",
  "assertion": "expect(after.prepare(\"SELECT name FROM sqlite_schema WHERE name IN ('memory_source_lsn','memory_capture_deferred','memory_recall_epoch')\").all()).toEqual([])"
 },
 "verdict-unpinned-frame": {
  "file": "scripts/test-truth-decision-runners.test-helper.mjs",
  "testFile": "server/internal-capabilities.test.ts",
  "assertion": "expect(killed,id+'\\n'+run.stdout).toBe(expected[id]===true)"
 },
 "verdict-synthetic-baseline": {
  "file": "scripts/test-truth-decision-runners.test-helper.mjs",
  "testFile": "server/internal-capabilities.test.ts",
  "assertion": "expect(killed,id+'\\n'+run.stdout).toBe(expected[id]===true)"
 },
 "verdict-restored-reuses-green": {
  "file": "scripts/test-truth-decision-runners.test-helper.mjs",
  "testFile": "server/internal-capabilities.test.ts",
  "assertion": "expect(killed,id+'\\n'+run.stdout).toBe(expected[id]===true)"
 },
 "engine-pin-widened": {
  "file": "scripts/test-truth-decision-runners.test-helper.mjs",
  "testFile": "server/internal-capabilities.test.ts",
  "assertion": "expect(killed,id+'\\n'+run.stdout).toBe(expected[id]===true)"
 },
 "inventory-skips-adapter-dir": {
  "file": "scripts/test-truth-decision-runners.test-helper.mjs",
  "testFile": "server/internal-capabilities.test.ts",
  "assertion": "expect(real,'unrouted runners must use verifyDecisionMutant; legacy hashes must not change').toEqual({unrouted:[],missing:[],changed:[]})"
 },
 "inventory-skips-hash": {
  "file": "scripts/test-truth-decision-runners.test-helper.mjs",
  "testFile": "server/internal-capabilities.test.ts",
  "assertion": "expect(inventory(root).changed).toEqual([legacy])"
 },
 "witness-omits-legacy-report": {
  "file": "scripts/test-truth-decision-runners.test-helper.mjs",
  "testFile": "server/internal-capabilities.test.ts",
  "assertion": "expect(legacy.testResults).toEqual(expect.any(Array))"
 },
 "turn-failure-cleanup": {
  "file": "server/internal-capabilities.test.ts",
  "assertion": "expect(events().filter(row=>row.type==='released')).toHaveLength(1)"
 },
 "turn-return-cleanup": {
  "file": "server/internal-capabilities.test.ts",
  "assertion": "expect(events().filter(row=>row.type==='released')).toHaveLength(1)"
 },
 "turn-throw-cleanup": {
  "file": "server/internal-capabilities.test.ts",
  "assertion": "expect(events().filter(row=>row.type==='released')).toHaveLength(1)"
 },
 "turn-abort-cleanup": {
  "file": "server/internal-capabilities.test.ts",
  "assertion": "expect(events().filter(row=>row.type==='released')).toHaveLength(1)"
 },
 "admission-unrelated-rejection": {
  "file": "server/composio-admission.test.ts",
  "assertion": "expect(outcome, name).toMatchObject({status:'rejected',reason:{name:'Error',status:429}})"
 },
 "admission-expiry-no-dispatch": {
  "file": "server/composio-admission.test.ts",
  "assertion": "expect(hits.slice(1), 'the same producer must dispatch successfully when the hold ends').not.toHaveLength(0)"
 },
 "privacy-final-native-wire": {
  "file": "server/fence-pending-turn-api.test.ts",
  "assertion": "expect(received).not.toContain('WITHHELD_CONVERSATION_LINE')"
 },
 "privacy-final-late-wire": {
  "file": "server/fence-pending-turn-api.test.ts",
  "assertion": "expect(delivered.join('\\n')).not.toContain('WITHHELD_CONVERSATION_LINE')"
 },
 "wipe-execution-omitted": {
  "file": "server/decision/wipe-effect-records.test.ts",
  "assertion": "expect(existsSync(join(cwd,'B','disk-effect.txt'))).toBe(true)"
 },
 "wipe-retarget-unbound": {
  "file": "server/decision/wipe-effect-records.test.ts",
  "assertion": "expect(effects).toBe(0)"
 },
 "wipe-replay-release": {
  "file": "server/decision/wipe-effect-records.test.ts",
  "assertion": "expect(guardEngineRelease({threadId:'t',requestId:'ipc-move',turnId:'turn',providerInstanceId:'p'})).toBe(false)"
 },
 "wipe-cancel-release": {
  "file": "server/decision/wipe-effect-records.test.ts",
  "assertion": "expect(f.respond({threadId:'t',generation:'g',requestId:'ipc-move',turnId:'turn',providerInstanceId:'p'},{behavior:'allow'},{answerId:'late-answer'})).resolves.toEqual({state:'failed'})"
 },
 "test-timeout-kill": {
  "file": "scripts/test-truth-intended-assertion.test-helper.mjs",
  "testFile": "server/internal-capabilities.test.ts",
  "assertion": "expect(killed(run)).toBe(false)"
 },
 "downgrade-memory-content-loss": {
  "file": "server/installation-recovery-command.test.ts",
  "assertion": "expect(after.prepare(\"SELECT * FROM memory_records WHERE id='kept-record'\").all()).toEqual(memoryRows)"
 }
};
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
  const intended=intendedAssertions[id];
  if(!intended)throw Error('Missing intended assertion for '+id);
  const killed=intendedAssertionKilled(green,red,restored,{root,...intended});
  const previousKilled=red.code===1&&red.failures.length>0&&restored.code===0&&restored.passed>0;
  proof.push({id,file,files,pattern,killed,previousKilled,green,red,restored});writeFileSync(join(out,'proof.json'),JSON.stringify(proof,null,2)+'\n');
  console.log(id+': '+(killed?'KILLED, restored GREEN':'NOT CERTIFIED'));
 }
}finally{safeWipeSync(root,{within:out,reason:'isolated test truth mutants'});}

writeFileSync(join(out,'proof.json'),JSON.stringify(proof,null,2)+'\n');
writeFileSync(join(out,'changed-verdicts.json'),JSON.stringify(proof.filter(row=>row.previousKilled!==undefined&&row.previousKilled!==row.killed).map(({id,file,files})=>({id,file,files})),null,2)+'\n');
if(proof.some(row=>!row.killed))process.exitCode=1;
