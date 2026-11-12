// Mutation qualification of the proof gate. Files in the candidate tree are
// never rewritten: each child sees exactly one source mutation via a loader.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
// These are independent CLI children, not Node test-runner IPC workers.
const cliEnv={...process.env};delete cliEnv.NODE_TEST_CONTEXT;
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(process.argv[2] ?? 'scripts/no-limits-live/evidence/mutants');
mkdirSync(out, { recursive:true });
const live = 'scripts/no-limits-live/ruling.node-test.mjs', replay = 'scripts/nolim-replay/ruling.node-test.mjs';
const correction='scripts/no-limits-live/correction.node-test.mjs', release='scripts/nolim-replay/release-ruling.node-test.mjs';
const mutants = [
  ['mcp-normalized-identity-lost','scripts/no-limits-live/field-plan.mjs',"e.toolIdentity?.namespace==='mcp'",'false','scripts/no-limits-live/field.node-test.mjs'],
  ['app-denial-target-not-exercised','scripts/no-limits-live/bindings.mjs','fieldCompleted(appTarget,obs)&&','','scripts/no-limits-live/app-binding.node-test.mjs'],
  ['posix-cron-reads-host','scripts/no-limits-live/platform.mjs',"'cron-read-runs':`ls ${q(p.join(home,'etc','cron.d'))}","'cron-read-runs':`ls /etc/cron.d",'scripts/no-limits-live/field.node-test.mjs'],
  ['windows-cron-reads-host','scripts/no-limits-live/platform.mjs',"'cron-read-runs':`Get-ChildItem -LiteralPath ${q(p.join(home,'etc','cron.d'))}","'cron-read-runs':`Get-ChildItem -LiteralPath 'C:/Windows/System32/Tasks'",'scripts/no-limits-live/field.node-test.mjs'],
  ['phone-token-invalid','scripts/no-limits-live/run.mjs',"randomBytes(32).toString('hex')","randomBytes(36).toString('hex')",'scripts/no-limits-live/launch.node-test.mjs'],
  ['permission-enable-ack-missing','scripts/no-limits-live/run.mjs','acknowledgeLocalAuto:true, settingsScope:','settingsScope:','scripts/no-limits-live/launch.node-test.mjs'],
  ['catalogue-absent-path-launch','scripts/no-limits-live/run.mjs','if(!configured) {',"if(!configured) { spawnSync('claude',['--version']);",'scripts/no-limits-live/cli.node-test.mjs'],
  ['field-earlier-turn-collapsed','scripts/no-limits-live/field-plan.mjs',"spec.outside === 'earlier-turn'",'false','scripts/no-limits-live/field.node-test.mjs'],
  ['field-input-substituted','scripts/no-limits-live/field-plan.mjs',' && isDeepStrictEqual(e.input, spec.input)','','scripts/no-limits-live/field.node-test.mjs'],
  ['field-unfinished-tool-accepted','scripts/no-limits-live/field-plan.mjs','e.itemId === started.itemId','true','scripts/no-limits-live/field.node-test.mjs'],
  ['unavailable-input-substituted','scripts/no-limits-live/run.mjs','if(spec.availabilityWitness && !f.workflowFixtures?.[spec.id])','if(false)','scripts/no-limits-live/dispatch.node-test.mjs'],
  ['dedicated-action-proof-lost','scripts/no-limits-live/run.mjs',' || f.workflowFixtures?.[spec.id]) { /* proof comes',' ) { /* proof comes','scripts/no-limits-live/dispatch.node-test.mjs'],
  ['missing-wipe-controls-dropped','scripts/no-limits-live/release-legs.mjs','controls:{rows:3,pass:0,skipped:3},','','scripts/no-limits-live/cli.node-test.mjs'],
  ['app-effect-invented','scripts/no-limits-live/bindings.mjs','readCapture(f.appCapture)===before+1','true','scripts/no-limits-live/app-binding.node-test.mjs'],
  ['mcp-field-tool-missing','scripts/no-limits-live/fakes/app-mcp.mjs','tools:[tool,fieldTool]','tools:[tool]','scripts/no-limits-live/app-fixture.node-test.mjs'],
  ['host-card-required','scripts/no-limits-live/r2-scenarios.mjs','obs.cards.length===0&&fieldCompleted(target,obs)','obs.cards.length===1&&fieldCompleted(target,obs)','scripts/no-limits-live/workflow.node-test.mjs'],
  ['browser-card-required','scripts/no-limits-live/r2-scenarios.mjs','obs.cards.length===0&&fieldCompleted(target,obs)','obs.cards.length===1&&fieldCompleted(target,obs)','scripts/no-limits-live/workflow.node-test.mjs'],
  ['replay-explicit-card-lost','scripts/nolim-replay/ruling.mjs',"Number.isInteger(got.cards)&&got.cards>=0?got.cards:0","got.kind === 'card' ? 1 : 0",replay],
  ['durable-hold-hidden','scripts/no-limits-live/policy-accounting.mjs',"const permissions=records.filter(r=>r.why!=='question');",'const permissions=[];','scripts/no-limits-live/accounting.node-test.mjs'],
 ['single-predicate-duplicates-hidden','scripts/no-limits-live/predicate-inventory.mjs','return predicateInventory(root).definitions;','return predicateInventory(root).definitions.slice(0,1);','scripts/no-limits-live/predicate.node-test.mjs'],
 ['legacy-explicit-marker','scripts/no-limits-live/legacy-fixture.mjs','delete copy.permissionExplicit;','void copy.permissionExplicit;',live],
 ['absolute-green-waived','scripts/no-limits-live/release-legs.mjs',"assertions.every(a => a.status === 'passed')",'true','scripts/no-limits-live/release-legs.node-test.mjs'],
 ['cli-failure-exit-zero','scripts/no-limits-live/run.mjs',"return report.verdict==='PASS'?0:1;",'return 0;','scripts/no-limits-live/cli.node-test.mjs'],
 ['protected-path-card','scripts/no-limits-live/scenarios.mjs',"row('deny-script', 'owner', 'unlimited', 'RUN', { permissionRule:true })","row('deny-script', 'owner', 'unlimited', 'CARD')",live],
 ['guest-inherits','scripts/no-limits-live/scenarios.mjs',"actor, 'ask', 'CARD', { botLevel","actor, botLevel, 'CARD', { botLevel",live],
 ['channel-off-ignored','scripts/no-limits-live/scenarios.mjs',"row(`owner-${origin}-off`, 'owner', 'unlimited', 'OFF_WITH_LINE'","row(`owner-${origin}-off`, 'owner', 'unlimited', 'RUN'",correction],
 ['ask-card-hides-inheritance','scripts/no-limits-live/counts.mjs',"spec.requiresAsk && observation.effectiveLevel !== 'ask'",'false',live],
  ['silent-refusal', 'scripts/no-limits-live/counts.mjs', 'const refusals = refusalSignals(observation);', 'const refusals = [];', live],
  ['nonwipe-card-allowed', 'scripts/no-limits-live/counts.mjs', "if (spec.expected === 'RUN' && cards.length)", 'if (false)', live],
 ['wipe-control-dropped','scripts/no-limits-live/counts.mjs',"if (spec.expected === 'CARD' && cards.length !== 1)",'if (false)',live],
 ['unrun-row-dropped','scripts/no-limits-live/counts.mjs','return result;\n}','return rows;\n}',live],
 ['driver-dropped','scripts/no-limits-live/engine-inventory.mjs','...discoverDrivers(root).map',"...discoverDrivers(root).filter(d=>d.driver!=='piAgent').map",live],
 ['windows-shell-wrong','scripts/no-limits-live/platform.mjs','Set-Content -LiteralPath','echo ',live],
 ['replay-nonwipe-card','scripts/nolim-replay/ruling.mjs','const got = await decide(row);',"const got = await decide(row); if(got.kind==='card'&&!control)got.kind='run';",replay],
 ['replay-refusal','scripts/nolim-replay/ruling.mjs','const got = await decide(row);',"const got = await decide(row); if(['refuse','deny','hold','cancel'].includes(got.kind))got.kind='run';",replay],
 ['replay-missing-row','scripts/nolim-replay/ruling.mjs','rows.length !== 257 || new Set(rows.map(r => r.id)).size !== 257','false',replay],
 ['replay-wipe-runs','scripts/nolim-replay/ruling.mjs',"got.kind === 'card' && got.why === 'wipe' && cards === 1 && !refused :","['card','run'].includes(got.kind) :",replay],
 ['replay-pin-ignored','scripts/nolim-replay/ruling.mjs','corpusDigest(bytes) !== pinnedHash','false',replay],
 ['correlation-scans-unrelated-threads','scripts/no-limits-live/counts.mjs','const keys = window.threadId ? this.threadCards.get(window.threadId) ?? [] : this.cards.keys();','const keys = this.cards.keys();','scripts/no-limits-live/correlation.node-test.mjs'],
 ['new-channel-card-hidden','scripts/no-limits-live/origin-fixtures.mjs','messages.filter(m=>!priorIds.has(m.id))','[]','scripts/no-limits-live/origin-contract.node-test.mjs'],
 ['explicit-guest-product-cards','server/no-limits-origin.ts','if (guest && bot.permissionExplicit !== true) return false;','if (guest) return false;','scripts/no-limits-live/origin-contract.node-test.mjs'],
 ['explicit-guest-product-ask','server/permission-inheritance.ts','if(explicitGuest && value.permissionExplicit === true && !value.draftOnly)return value;','','scripts/no-limits-live/origin-contract.node-test.mjs'],
 ['english-fixture-lines-mislabelled','scripts/no-limits-live/english-inventory.mjs',"fixtureOnly?'fixture-settings-line'","false?'fixture-settings-line'",'scripts/no-limits-live/inventory.node-test.mjs'],
 ['replay-saved-rule-label-only','scripts/nolim-replay/saved-rule.mjs',"['deny','owner-deny','permission-rule'].includes(label?.kind)",'false',replay],
 ['replay-saved-rule-witness','scripts/nolim-replay/ruling.mjs','!storedRuleLabel(label) || savedRuleProven(row,got)','true',replay],
 ['card-correlation-window','scripts/no-limits-live/counts.mjs','if (messages && !messages.has(card.messageId)) continue;','', 'scripts/no-limits-live/correlation.node-test.mjs'],
 ['card-record-request-substitution','scripts/no-limits-live/counts.mjs','JSON.stringify([approvalId,threadId,requestId,messageId])',"JSON.stringify([approvalId,threadId,'',messageId])",live],
 ['truly-explicit-guest-card','scripts/no-limits-live/truly-rows.mjs','incoming:true,permissionExplicit:true',"incoming:true,permissionExplicit:true,expected:'CARD',expectedCards:1",'scripts/no-limits-live/ruling-1019.test.mjs'],
 ['truly-channel-off-card','scripts/no-limits-live/truly-rows.mjs',"expected:'OFF_WITH_LINE',expectedCards:0","expected:'CARD',expectedCards:1",'scripts/no-limits-live/ruling-1019.test.mjs'],
 ['stored-rule-not-installed','scripts/no-limits-live/counts.mjs','observation.permissionRuleWitness?.ruleInstalled !== true','false',correction],
 ['stored-rule-refused','scripts/no-limits-live/scenarios.mjs',"row('deny-browser-never', 'owner', 'unlimited', 'RUN'","row('deny-browser-never', 'owner', 'unlimited', 'REFUSE_NO_CARD'",correction],
 ['stored-rule-silent-deny','scripts/no-limits-live/counts.mjs',"if (!observation.actionProven)",'if (false)',correction],
 ['stored-rule-refusal','scripts/no-limits-live/counts.mjs','const refusals = refusalSignals(observation);','const refusals = [];',correction],
 ['stored-rule-card','scripts/no-limits-live/counts.mjs',"if (spec.expected === 'RUN' && (spec.permissionRule ? allCards : cards).length)",'if (false)',correction],
 ['feature-runs','scripts/no-limits-live/feature-off.mjs','witness?.actionExecuted !== false','false',correction],
 ['feature-card','scripts/no-limits-live/feature-off.mjs',"(observation.cards?.length??0)",'false',correction],
 ['feature-line','scripts/no-limits-live/feature-off.mjs',"!/settings|turn .* on|enable .* in|connect .* in/i.test(lines[0])",'false',correction],
 ['runner-drops-feature-witness','scripts/no-limits-live/run.mjs','({ obs, proof, ...extra } = await runR2(','({ obs, proof } = await runR2(',live],
 ['runner-drops-refusal','scripts/no-limits-live/run.mjs','events, messages, refusals: refusalSignals(obs),','refusals: [],',live],
 ['stored-rule-deny-receipt','scripts/no-limits-live/observe.mjs',"answers[0].behavior !== 'allow'",'false',live],
 ['explicit-guest-ask','scripts/no-limits-live/scenarios.mjs',"actor, botLevel, 'RUN', { botLevel, permissionExplicit:true","actor, 'ask', 'CARD', { botLevel, permissionExplicit:true",live],
 ['missing-origin-owner','scripts/no-limits-live/scenarios.mjs',"row('missing-origin', 'non-owner', 'ask', 'CARD'","row('missing-origin', 'owner', 'unlimited', 'RUN'",live],
 ['explicit-bot-marker','scripts/no-limits-live/counts.mjs','spec.permissionExplicit && observation.botPermissionExplicit !== true','false',live],
 ['missing-origin-proof','scripts/no-limits-live/counts.mjs','spec.missingOrigin && observation.missingOriginProven !== true','false',live],
 ['unknown-delete-card','scripts/no-limits-live/scenarios.mjs',"row('unknown-delete', 'owner', 'unlimited', 'RUN')","row('unknown-delete', 'owner', 'unlimited', 'CARD')",live],
 ['replay-feature-runs','scripts/nolim-replay/ruling.mjs',"label.kind === 'feature-off' ? off :","label.kind === 'feature-off' ? true :",replay],
 ['release-refusal','scripts/nolim-replay/release-check.mjs',"if(rejected && (label.kind==='feature-off' || !parityRequired({...row,label}))){refusals++;errors.push('refusal or hold');}","if(false){refusals++;errors.push('refusal or hold');}",release],
];
const report = { mode:'fake-only gate mutation qualification', releaseGate:false, baselines:[], mutants:[], verdict:'FAIL' };
// Qualifying a mutant requires a green unmodified control in the same environment.
for (const test of new Set(mutants.map(m=>m[4]))) {
 const r=spawnSync(process.execPath,['--experimental-strip-types','--test',join(root,test)],{cwd:root,encoding:'utf8',timeout:30000,env:cliEnv});
 writeFileSync(join(out,`control-${test.replaceAll('/','-')}.log`),(r.stdout??'')+(r.stderr??''));
 report.baselines.push({test,exit:r.status,verdict:r.status===0?'PASS':'FAIL'});
}
const controlGreen=report.baselines.every(b=>b.verdict==='PASS');
if (!controlGreen) {
 report.mutants=mutants.map(([id])=>({id,killed:false,status:'control-red'}));
 writeFileSync(join(out,'verdict.json'),JSON.stringify(report,null,2)+'\n');
 process.exit(1);
}
for (const [id, file, before, after, test] of mutants) {
  const source = readFileSync(join(root,file),'utf8');
  if(!source.includes(before)) throw Error(`Mutant anchor absent: ${id}`);
  const dir = mkdtempSync(join(tmpdir(),'gnl-mutant-'));
  try {
    const activated=join(dir,'activated'),preload=join(dir,'mutant.mjs');
    writeFileSync(preload, `import {registerHooks} from 'node:module'; import {writeFileSync} from 'node:fs';
registerHooks({load(url,ctx,next){const r=next(url,ctx);if(url===${JSON.stringify(pathToFileURL(join(root,file)).href)}){const s=typeof r.source==='string'?r.source:Buffer.from(r.source).toString();if(!s.includes(${JSON.stringify(before)}))throw Error('mutant anchor');writeFileSync(${JSON.stringify(activated)},'yes');return {...r,source:s.replace(${JSON.stringify(before)},${JSON.stringify(after)})};}return r;}});`);
    const r=spawnSync(process.execPath,['--experimental-strip-types','--test',join(root,test)],{cwd:root,encoding:'utf8',timeout:test.endsWith('/launch.node-test.mjs')?100000:30000,
      env:{...cliEnv,NODE_OPTIONS:`--import=${pathToFileURL(preload).href}`}});
    const diagnostic=(r.stdout??'')+(r.stderr??'');
    const killed=controlGreen&&r.status===1&&existsSync(activated)&&/fail [1-9]/.test(r.stdout??'')
      && /AssertionError|ERR_ASSERTION/.test(diagnostic) && !/SyntaxError|Cannot find module|ERR_MODULE_NOT_FOUND/.test(diagnostic);
    writeFileSync(join(out,`${id}.log`),(r.stdout??'')+(r.stderr??''));
    report.mutants.push({id,killed,exit:r.status,activated:existsSync(activated)});
    console.log(`${id}: ${killed?'KILLED':'SURVIVED'}`);
  } finally {rmSync(dir,{recursive:true,force:true});}
}
report.verdict=controlGreen&&report.mutants.every(m=>m.killed)?'PASS':'FAIL';
writeFileSync(join(out,'verdict.json'),JSON.stringify(report,null,2)+'\n');
if(report.verdict!=='PASS')process.exitCode=1;
