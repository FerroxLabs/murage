// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Run explicitly inside the test container; never imported by the unit suite.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { withFixture } from '../fixture.mjs';

const source = fileURLToPath(new URL('..', import.meta.url));
const evidence = resolve(process.argv[2]);
mkdirSync(evidence, { recursive: true });
const mutations = [
  ['BLOCK1-stdout-denial', 'engines.mjs', "const denied = (output, ...names) => names.every(name => output.facts.deniedTargets.includes(name));",
    "const denied = output => /native-deny-probe|\\b(?:forbidden|denied|deny)\\b/i.test(output.stdout);", 'BLOCK1'],
  ['BLOCK2-ignore-lifecycle', 'results.mjs', "if (['subagent_spawned', 'subagent_progress', 'subagent_finished'].includes(type))", 'if (false)', 'BLOCK2'],
  ['BLOCK3-ignore-malformed', 'engines.mjs', ' && output.facts.malformed === 0', '', 'BLOCK3'],
  ['BLOCK4-drop-auth-code', 'engines.mjs', " || output.failure === 'SKIP-NO-AUTH'", '', 'BLOCK4'],
  ['AFIX2-C6-ignore-stream-health', 'engines.mjs', 'processHealthy: plainRefusal ? !output.failure && !output.facts.engineError : processHealthy(output)',
    'processHealthy: !output.failure', 'BLOCK3 P-C6 rejects truncated structured proof'],
  ['AFIX2-C6-refusal-with-structured-output', 'engines.mjs', 'rootRefused && !/^\\s*[\\[{]/m.test(output.stdout)',
    'rootRefused', 'BLOCK3 P-C6 rejects a root refusal mixed with truncated JSON'],
  ['AFIX2-X2-require-jsonl-document', 'engines.mjs', 'processHealthy: !offline.failure && offline.code === 0 && validDocument',
    'processHealthy: processHealthy(offline)', 'AFIX2 P-X2 accepts a valid multiline offline JSON document'],
  ['AFIX2-X2-repair-truncated-document', 'engines.mjs', 'JSON.parse(offline.stdout).decision',
    "JSON.parse(offline.stdout.trimEnd() + (offline.stdout.trimEnd().endsWith('}') ? '' : '}')).decision", 'AFIX2 P-X2 rejects truncated-offline JSON document'],
  ['AFIX2-X2-ignore-trailing-document', 'engines.mjs', 'JSON.parse(offline.stdout).decision',
    "JSON.parse(offline.stdout.split('\\n')[0]).decision", 'AFIX2 P-X2 rejects trailing-offline JSON document'],
  ['P-C1', 'engines.mjs', 'twoFlagSettingsRefusals: output.facts.flagSettingsErrors >= 2', 'twoFlagSettingsRefusals: true'],
  ['P-C2', 'engines.mjs', "attempted: attemptedTargets(output, 'c2')", 'attempted: true'],
  ['P-C3', 'engines.mjs', 'allPrefixCalls: canaries.every(canary => log.some(row => row.canaries?.includes(canary)))', 'allPrefixCalls: true'],
  ['P-C4', 'engines.mjs', "attempted: attemptedTargets(output, 'c4')", 'attempted: true'],
  ['P-C5', 'engines.mjs', "fixtureClaudeEdited: readFileSync(ctx.file('.claude/settings.json'), 'utf8').includes('nativeDenyProbe')", 'fixtureClaudeEdited: true'],
  ['P-C6', 'engines.mjs', 'const rootRefused = /(?:root|sudo)/i.test(output.stdout + output.stderr) && /bypass|skip.permissions/i.test(output.stdout + output.stderr) && output.code !== 0;', 'const rootRefused = true;'],
  ['P-X1', 'engines.mjs', "hookDenied: log.some(row => row.event === 'PreToolUse' && row.deny)", 'hookDenied: true'],
  ['P-X2', 'engines.mjs', "forbidden: decision === 'forbidden'", 'forbidden: true'],
  ['P-X3', 'engines.mjs', "stage(compound ? 'compound-wrapper' : 'simple-wrapper', output, { attempted: attemptedTargets(output, name) }", "stage(compound ? 'compound-wrapper' : 'simple-wrapper', output, { attempted: true }"],
  ['P-A1', 'engines.mjs', 'loadProof: loaded >= 0 && tool > loaded', 'loadProof: true'],
  ['P-CU1', 'engines.mjs', "denialVisible: denied(output, 'cu1', 'protected/y.txt')", 'denialVisible: true'],
  ['P-CU2', 'engines.mjs', "seamObserved: output.asks.some(params => slash(requestCommand(params)).includes(slash(ctx.file('cu2'))))", 'seamObserved: true'],
  ['P-G1', 'engines.mjs', 'noAsks: output.asks.length === 0, denialVisible: denied(output, name)', 'noAsks: output.asks.length === 0, denialVisible: true'],
  ['P-F1', 'engines.mjs', 'oneEchoAsk: output.asks.length === 1 && echoAsks === 1', 'oneEchoAsk: true'],
  ['P-F2', 'engines.mjs', "writeCompleted: existsSync(ctx.file('z.txt')) && readFileSync(ctx.file('z.txt'), 'utf8').trim() === 'native-deny-probe'", 'writeCompleted: true'],
  ['P-F3', 'engines.mjs', 'i.test(output.stdout), sourceWitness },', 'i.test(output.stdout), sourceWitness: true },'],
  ['P-O1', 'engines.mjs', "ordinaryCompleted: output.facts.outputMarkers.includes(id === 'P-O1' ? 'ok' : 'done')", 'ordinaryCompleted: true'],
  ['P-O2', 'engines.mjs', "pluginDenied: existsSync(join(ctx.fixture.root, 'plugin.log'))", 'pluginDenied: true'],
];
const modules = ['auth', 'catalog', 'engines', 'fixture', 'helpers', 'results', 'run', 'transport'];
const rows = [];
for (const [id, file, before, after, pattern = `BLOCK5 ${id} rejects incomplete fake proof`] of mutations) {
  await withFixture(async fixture => {
    const dir = join(fixture.root, 'subject');
    mkdirSync(join(dir, 'tests'), { recursive: true });
    for (const name of modules) copyFileSync(join(source, `${name}.mjs`), join(dir, `${name}.mjs`));
    for (const name of ['fake-engine.mjs', 'review-regressions.test.mjs']) copyFileSync(join(source, 'tests', name), join(dir, 'tests', name));
    const path = join(dir, file), original = readFileSync(path, 'utf8');
    assert.equal(original.split(before).length, 2, `${id}: mutation must match exactly once`);
    writeFileSync(path, original.replace(before, after));
    // Each hunk has the actual source line and can be replayed with git apply.
    const line = original.slice(0, original.indexOf(before)).split('\n').length;
    const oldLine = original.split('\n')[line - 1];
    writeFileSync(join(evidence, `${id}.patch`), `--- a/scripts/probes/native-deny/${file}\n+++ b/scripts/probes/native-deny/${file}\n@@ -${line} +${line} @@\n-${oldLine}\n+${oldLine.replace(before, after)}\n`);
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=${pattern}`, join(dir, 'tests/review-regressions.test.mjs')], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    });
    writeFileSync(join(evidence, `${id}.tap`), run.stdout + run.stderr);
    const failed = [...run.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]);
    const killed = run.status === 1 && failed.length > 0 && failed.every(name => name.startsWith(pattern)) && /ERR_ASSERTION/.test(run.stdout);
    rows.push({ id, file, pattern, exit: run.status, failed, killed });
    console.log(`${id}: ${killed ? 'KILLED' : 'SURVIVED/INVALID'}`);
  });
}
writeFileSync(join(evidence, 'summary.json'), JSON.stringify({ mutations: rows.length, killed: rows.filter(row => row.killed).length, rows }, null, 2) + '\n');
assert.ok(rows.every(row => row.killed), 'Every concrete mutant must fail its behavioral regression');
