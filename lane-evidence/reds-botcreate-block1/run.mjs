// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Run only in the network-isolated test container. Never modifies a product file.
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const out = resolve('.reds-block1');
mkdirSync(out, { recursive: true });
const summary = process.argv.includes('--mutants-only')
  ? JSON.parse(readFileSync(`${out}/summary.json`, 'utf8')).filter(r => r.id.startsWith('control-') || r.id === 'red-authority-handoff')
  : [];
const sha = s => createHash('sha256').update(s).digest('hex');
function change(source, before, after) {
  if (source.split(before).length !== 2) throw Error(`Expected exactly one mutation anchor: ${before}`);
  return source.replace(before, after);
}
function run(id, file, source, pattern, killed = false) {
  const copy = `${dirname(file)}/reds-block1-${id}.test.ts`;
  writeFileSync(copy, source);
  writeFileSync(`${out}/${id}.test-source.txt`, source);
  const args = ['exec', 'vitest', 'run', copy, '--maxWorkers=1', '--reporter=default', '--reporter=json', `--outputFile.json=${out}/${id}.json`];
  if (pattern) args.push('-t', pattern);
  writeFileSync(`${out}/${id}.command.json`, JSON.stringify({ command: ['pnpm', ...args], original: file, originalSHA256: sha(readFileSync(file)), temporaryTestSHA256: sha(source) }, null, 2));
  let result;
  try { result = spawnSync('pnpm', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }); }
  finally { unlinkSync(copy); }
  writeFileSync(`${out}/${id}.log`, (result.stdout ?? '') + (result.stderr ?? ''));
  const report = JSON.parse(readFileSync(`${out}/${id}.json`, 'utf8'));
  const failures = report.testResults.flatMap(r => r.assertionResults).filter(r => r.status === 'failed').map(r => ({ name: r.fullName, messages: r.failureMessages }));
  const valid = killed ? result.status === 1 && failures.length > 0 && failures.every(f => f.name.includes(pattern) && f.messages.every(m => /AssertionError/.test(m) && !/ReferenceError|SyntaxError|server never came up/.test(m))) : result.status === 0 && report.numPassedTests > 0;
  summary.push({ id, exit: result.status, passed: report.numPassedTests, failed: report.numFailedTests, valid, failures });
  writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 2));
  console.log(`${id}: exit=${result.status}, pass=${report.numPassedTests}, fail=${report.numFailedTests}, valid=${valid}`);
  if (!valid) throw Error(`Invalid ${killed ? 'mutant kill' : 'control'}: ${id}; inspect log`);
}
const autoFile = 'server/automations-chat-api.test.ts';
const autoPattern = 'Ask and Auto show the card';
const termsControl = change(readFileSync(autoFile, 'utf8'), 'engineDiscovery: "explicit",', 'engineDiscovery: "explicit", noLimitsTermsVersion: 2,');
const files = ['server/browser-owner-approve.test.ts', 'server/browser-direct-owner-api.test.ts', 'server/telegram-permission-wiring.test.ts', 'server/project-runtime-boundaries.test.ts', 'server/highlevel/runtime.test.ts'];
if (!process.argv.includes('--mutants-only')) {
  for (const file of files) run(`control-${file.split('/').at(-1).replace('.test.ts', '')}`, file, readFileSync(file, 'utf8'));
  run('control-automation-terms', autoFile, termsControl);
  // This is the unchanged, known S4 handoff. Record RED separately, not as a mutant kill.
  const file = `${out}/handoff-source.txt`; writeFileSync(file, readFileSync(autoFile));
  run('red-authority-handoff', autoFile, readFileSync(autoFile, 'utf8'), autoPattern, true);
}
const cases = [
  ['owner-desktop-delivery', files[0], 'control: the desktop app', 'server/index.ts', '...(onComputer ? { desktop: true as const } : provenHere ? { desktop: "proven" as const } : {})', '...(onComputer ? {} : provenHere ? { desktop: "proven" as const } : {})'],
  ['direct-readiness-code', files[1], 'direct admission names chrome_closed', 'server/index.ts', 'codedBrowserReason(directCause,browserFailure(directCause).message,0)', "codedBrowserReason('chrome_status_unknown',browserFailure(directCause).message,0)"],
  ['channel-stale-fingerprint', files[2], 'actual root approval actions', 'server/index.ts', 'return { pending, resolve: async (approval, behavior, forTask?: boolean) => {\n      const current = pending().find(item => item.id === approval.id && item.fingerprint === approval.fingerprint);', 'return { pending, resolve: async (approval, behavior, forTask?: boolean) => {\n      const current = pending().find(item => item.id === approval.id);'],
  ['watchdog-resolved-wait', files[3], 'the watchdog waits only', 'server/index.ts', 'else if (event.type === "request.resolved") watchdog.setWaitingOnHuman(event.threadId, false, event.requestId);', 'else if (event.type === "request.resolved") watchdog.setWaitingOnHuman(event.threadId, true, event.requestId);'],
  ['retired-write-release', files[3], 'retired provider output', 'server/index.ts', 'lateProjectWrites.complete(event);', 'lateProjectWrites.complete({ ...event, turnId: "wrong-turn" });'],
  ['release-owner-proof', files[4], 'the ticket is minted once', 'server/index.ts', 'ownerStartedRuns.delete(generation); highlevelProvenRuns.delete(generation);', 'void 0; highlevelProvenRuns.delete(generation);'],
  ['release-highlevel-proof', files[4], 'the ticket is minted once', 'server/index.ts', 'ownerStartedRuns.delete(generation); highlevelProvenRuns.delete(generation);', 'ownerStartedRuns.delete(generation); void 0;'],
  ['setup-applied-mid-reply', autoFile, autoPattern, 'server/setup-at-settle.ts', 'row.setup.push(entry);', 'row.setup.push(entry); hooks.apply();'],
  ['setup-skips-clean-apply', autoFile, autoPattern, 'server/setup-at-settle.ts', "if (result === 'resolve') { try { applied = hooks.apply(); }", "if (false && result === 'resolve') { try { applied = hooks.apply(); }"],
  ['setup-loses-receipt', autoFile, autoPattern, 'server/routine-requests.ts', 'this.routines.completeRoutineRequest(commit, resultId, this.now(), appliedUpdatedAt);', 'this.routines.completeRoutineRequest(commit, resultId, this.now(), appliedUpdatedAt); this.forgetReceipt(commit);'],
];
for (const [id, file, pattern, product, before, after] of cases) {
  const original = readFileSync(product, 'utf8');
  let mutated = change(original, before, after);
  // Relocate rather than delete the HighLevel call so the earlier global count
  // still passes and the rewritten release-hook assertion must kill the mutant.
  if (id === 'release-highlevel-proof') mutated += '\nfunction misplacedCleanup(generation: string) { highlevelProvenRuns.delete(generation); }\n';
  const beforeFile = `${out}/${id}.before`, afterFile = `${out}/${id}.after`;
  writeFileSync(beforeFile, original); writeFileSync(afterFile, mutated);
  const diff = spawnSync('diff', ['-u', '--label', `a/${product}`, '--label', `b/${product}`, beforeFile, afterFile], { encoding: 'utf8' });
  writeFileSync(`${out}/${id}.patch`, diff.stdout);
  writeFileSync(`${out}/${id}.source.json`, JSON.stringify({ product, originalSHA256: sha(original), mutantSHA256: sha(mutated), before, after }, null, 2));
  unlinkSync(beforeFile); unlinkSync(afterFile);
  let test = readFileSync(file, 'utf8');
  const replaceExpr = `.replace(${JSON.stringify(before)}, ${JSON.stringify(after)})${id === 'release-highlevel-proof' ? ` + ${JSON.stringify('\nfunction misplacedCleanup(generation: string) { highlevelProvenRuns.delete(generation); }\n')}` : ''}`;
  if (file === autoFile) {
    test = termsControl;
    const hook = `${out}/${id}-hook.mjs`;
    writeFileSync(hook, `import {registerHooks} from 'node:module'; import {readFileSync} from 'node:fs';\nregisterHooks({load(url,context,next){if(url.endsWith(${JSON.stringify('/' + product)})){const source=readFileSync(new URL(url),'utf8')${replaceExpr}; return {format:'module-typescript',shortCircuit:true,source};}return next(url,context);}});\n`);
    test = change(test, '["--import", TELEGRAM_PRELOAD,', `["--import", ${JSON.stringify(hook)}, "--import", TELEGRAM_PRELOAD,`);
  } else if (file === files[1]) {
    // This fixture already has a server source loader. Inject into that loader.
    test = change(test, "if(url.endsWith('/server/index.ts')){let source=readFileSync(new URL(url),'utf8');", `if(url.endsWith('/server/index.ts')){let source=readFileSync(new URL(url),'utf8').replace(${JSON.stringify(before)},${JSON.stringify(after)});`);
  } else {
    const read = `readFileSync(new URL("${file === files[4] ? '../index.ts' : './index.ts'}", import.meta.url), "utf8")`;
    if (!test.includes(read)) throw Error(`Missing read anchor: ${file}`);
    test = test.replaceAll(read, `(${read}${replaceExpr})`);
  }
  run(id, file, test, pattern, true);
}
console.log('All controls and intended-assertion mutant kills validated.');
