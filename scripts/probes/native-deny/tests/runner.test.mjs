// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, runSuite } from '../run.mjs';
import { parseResultLine } from '../results.mjs';
import { subscriptionAuth, binaryConfig } from '../auth.mjs';
import { withFixture, writeFixture, fixtureEnv } from '../fixture.mjs';
import { runCli, runAcp } from '../transport.mjs';

test('all three OS dry plans launch nothing, ignore auth and leave no fixtures', async () => {
  await withFixture(async parent => {
    for (const os of ['macos', 'windows', 'linux']) {
      const before = readdirSync(parent.root);
      const rows = [];
      const code = await runSuite(parseArgs(['--os', os, '--dry-run']), { tempRoot: parent.root,
        inherited: { NATIVE_DENY_GATE_JSON: 'invalid auth config must not even be parsed' }, emit: row => rows.push(parseResultLine(JSON.stringify(row))) });
      assert.equal(code, 0); assert.equal(rows.length, 18);
      assert.ok(rows.every(row => row.result === 'SKIP' && row.evidence.reason === 'DRY-RUN' && row.evidence.launches === 0));
      assert.deepEqual(readdirSync(parent.root), before);
    }
  });
});
test('missing subscription auth skips without invoking even --version, and cleans each fixture', async () => {
  await withFixture(async parent => {
    const before = readdirSync(parent.root), rows = [];
    const config = { engines: { claude: { command: '/must-never-execute', auth: { source: 'api-key' } } } };
    const code = await runSuite(parseArgs(['--os', 'linux', '--run', '--probe', 'P-C1']), {
      tempRoot: parent.root, inherited: { NATIVE_DENY_GATE_JSON: JSON.stringify(config) }, emit: row => rows.push(row),
    });
    assert.equal(code, 0); assert.equal(rows[0].result, 'SKIP');
    assert.equal(rows[0].evidence.reason, process.platform === 'linux' ? 'SKIP-NO-AUTH' : 'SKIP-WRONG-OS');
    assert.equal(rows[0].evidence.fixtureCleaned, true); assert.deepEqual(readdirSync(parent.root), before);
  });
});
test('unavailable keyring auth and API credentials cannot become a subscription handoff', () => {
  assert.equal(subscriptionAuth('antigravity', { auth: { source: 'gate-signed-in-subscription', files: {} } }), null);
  assert.throws(() => subscriptionAuth('codex', { auth: { source: 'gate-signed-in-subscription', files: { '.codex/auth.json': JSON.stringify({ OPENAI_API_KEY: 'fixture-key' }) } } }));
  assert.throws(() => subscriptionAuth('claude', { auth: { source: 'gate-signed-in-subscription', files: { '../../escape': '{}' } } }));
  assert.throws(() => subscriptionAuth('claude', { auth: { source: 'gate-signed-in-subscription', env: { ANTHROPIC_API_KEY: 'fixture-key' } } }));
  assert.throws(() => subscriptionAuth('opencode', { auth: { source: 'gate-signed-in-subscription', files: { '.local/share/opencode/auth.json': JSON.stringify({ provider: { type: 'api', key: 'fixture-key' } }) } } }));
  assert.throws(() => binaryConfig({ command: 'claude' }));
  assert.throws(() => binaryConfig({ command: '/fixture/cli.cmd' }));
  assert.throws(() => binaryConfig({ command: process.execPath, args: ['-e', 'bad'] }));
});
test('runner refuses hallucinated denial evidence and removes fixture on a failed probe', async () => {
  await withFixture(async parent => {
    const fake = writeFixture(parent, 'fake-engine.mjs', `if (process.argv.includes('--version')) console.log('fixture-engine 2.1.292');\nelse { console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'permission denied from flagSettings twice'}]}})); console.log(JSON.stringify({type:'result',is_error:false})); }\n`);
    const config = { engines: { claude: { command: process.execPath, args: [fake], auth: { source: 'gate-signed-in-subscription', env: { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-only-not-a-login' } } } } };
    const rows = [], before = readdirSync(parent.root);
    await runSuite(parseArgs(['--os', 'linux', '--run', '--probe', 'P-C1']), { tempRoot: parent.root, inherited: { NATIVE_DENY_GATE_JSON: JSON.stringify(config) }, emit: row => rows.push(row) });
    assert.equal(rows[0].result, process.platform === 'linux' ? 'FAIL' : 'SKIP');
    assert.equal(rows[0].evidence.fixtureCleaned, true); assert.deepEqual(readdirSync(parent.root), before);
    assert.ok(!JSON.stringify(rows).includes('fixture-only-not-a-login'));
  });
});
test('runner accepts actual two-tool flag-settings evidence from a fake process', async () => {
  await withFixture(async parent => {
    const fake = writeFixture(parent, 'fake-engine.mjs', `if(process.argv.includes('--version')) console.log('fixture-engine 2.1.292');\nelse {const prompt=process.argv.at(-1); const command=prompt.split('Run exactly: ')[1].split('. Then use')[0]; const path=prompt.split('create ')[1].split(' containing')[0]; for(const value of [{type:'assistant',message:{content:[{type:'tool_use',id:'a',name:'Bash',input:{command}},{type:'tool_use',id:'b',name:'Write',input:{file_path:path}}]}},{type:'user',message:{content:[{type:'tool_result',is_error:true,content:'permission denied from flagSettings'},{type:'tool_result',is_error:true,content:'permission denied from flagSettings'}]}},{type:'result',is_error:false}]) console.log(JSON.stringify(value));}\n`);
    const config = { engines: { claude: { command: process.execPath, args: [fake], auth: { source: 'gate-signed-in-subscription', env: { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-only-not-a-login' } } } } };
    const rows = [], before = readdirSync(parent.root);
    const code = await runSuite(parseArgs(['--os', 'linux', '--run', '--probe', 'P-C1']), { tempRoot: parent.root, inherited: { NATIVE_DENY_GATE_JSON: JSON.stringify(config) }, emit: row => rows.push(row) });
    assert.equal(code, 0); assert.equal(rows[0].result, process.platform === 'linux' ? 'PASS' : 'SKIP');
    assert.equal(rows[0].evidence.fixtureCleaned, true); assert.deepEqual(readdirSync(parent.root), before);
  });
});
test('timeouts and interrupted children are reaped before fixture cleanup', async () => {
  let root;
  await withFixture(async fixture => {
    root = fixture.root;
    const fake = writeFixture(fixture, 'hang.mjs', `setInterval(() => {}, 1000);\n`);
    const output = await runCli({ command: process.execPath, args: [fake] }, [], { cwd: fixture.work, env: fixtureEnv(fixture), timeoutMs: 150 });
    assert.equal(output.failure, 'TIMEOUT'); assert.equal(output.facts.completed, false);
    const controller = new AbortController();
    const waiting = runCli({ command: process.execPath, args: [fake] }, [], { cwd: fixture.work, env: fixtureEnv(fixture), timeoutMs: 10000, signal: controller.signal });
    controller.abort();
    assert.equal((await waiting).failure, 'INTERRUPTED');
  });
  assert.equal(existsSync(root), false);
});
test('ACP allows only one-time grants and refuses unknown methods without logging secrets', async () => {
  await withFixture(async fixture => {
    const fake = writeFixture(fixture, 'fake-acp.mjs', `import {createInterface} from 'node:readline';\nconst send=o=>console.log(JSON.stringify(o)); let promptId;\nfor await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line); if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1}});else if(m.method==='session/new')send({id:m.id,result:{sessionId:'fixture'}});else if(m.method==='session/prompt'){promptId=m.id;send({id:'ask',method:'session/request_permission',params:{toolCall:{rawInput:{command:'echo hi'}},options:[{kind:'allow_always',optionId:'bad'},{kind:'allow_once',optionId:'good'}]}});}else if(m.id==='ask'){if(m.result.outcome.optionId!=='good')process.exit(9);send({id:promptId,result:{stopReason:'end_turn'}});}}\n`);
    const output = await runAcp({ command: process.execPath, args: [fake] }, [], { cwd: fixture.work, env: fixtureEnv(fixture), timeoutMs: 1000 }, ['echo hi'], { permission: () => true });
    assert.equal(output.completed, true); assert.equal(output.asks.length, 1); assert.equal(output.failure, null);
  });
});
test('invalid modes, probes and unbounded timeouts are refused', () => {
  for (const args of [['--os', 'invalid'], ['--os', 'linux', '--run', '--dry-run'], ['--os', 'linux', '--probe', 'P-NONE'], ['--os', 'linux', '--timeout-ms', '0'], ['--os', 'linux', '--timeout-ms', 'Infinity']]) assert.throws(() => parseArgs(args));
});
