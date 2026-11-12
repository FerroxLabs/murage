// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { withFixture, writeFixture, fixtureEnv } from '../fixture.mjs';
import { runCli, rpcClient } from '../transport.mjs';

const helper = fileURLToPath(new URL('../helpers.mjs', import.meta.url));
test('prefix denies only the exact canary and never executes it', async () => {
  await withFixture(async fixture => {
    const c3 = join(fixture.work, 'c3'), c3b = join(fixture.work, 'c3b');
    const config = writeFixture(fixture, 'config.json', JSON.stringify({ canaries: [c3, c3b], log: join(fixture.root, 'prefix.log') }));
    const output = await runCli({ command: process.execPath, args: [helper] }, ['prefix', config, 'must-never-execute', c3b], { cwd: fixture.work, env: fixtureEnv(fixture), timeoutMs: 1000 });
    assert.equal(output.code, 126);
    const log = JSON.parse(readFileSync(join(fixture.root, 'prefix.log'), 'utf8'));
    assert.deepEqual(log.canaries, [c3b]);
  });
});
test('hook parses Windows paths without logging full tool arguments', async () => {
  await withFixture(async fixture => {
    const config = writeFixture(fixture, 'config.json', JSON.stringify({ engine: 'codex', canaries: ['C:\\fixture\\x1'], reason: 'fixture denial', log: join(fixture.root, 'hook.log') }));
    const output = await runCli({ command: process.execPath, args: [helper] }, ['hook', config], { cwd: fixture.work, env: fixtureEnv(fixture), timeoutMs: 1000 },
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: { command: 'New-Item C:\\fixture\\x1', privateArgument: 'never-log-this' } }));
    assert.equal(JSON.parse(output.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(!readFileSync(join(fixture.root, 'hook.log'), 'utf8').includes('never-log-this'));
  });
});
test('fixture MCP stub answers initialize/list/approve and records counts only', async () => {
  await withFixture(async fixture => {
    const config = writeFixture(fixture, 'config.json', JSON.stringify({ log: join(fixture.root, 'approve.log') }));
    const client = rpcClient({ command: process.execPath, args: [helper] }, ['mcp', config], { cwd: fixture.work, env: fixtureEnv(fixture), timeoutMs: 1000 });
    try {
      assert.equal((await client.call('initialize', { protocolVersion: '2024-11-05' })).protocolVersion, '2024-11-05');
      assert.equal((await client.call('tools/list', {})).tools[0].name, 'approve');
      const result = await client.call('tools/call', { name: 'approve', arguments: { tool_name: 'Write', input: { file_path: join(fixture.work, 'canary') } } });
      assert.equal(JSON.parse(result.content[0].text).behavior, 'allow');
      assert.deepEqual(JSON.parse(readFileSync(join(fixture.root, 'approve.log'), 'utf8')), { event: 'approve' });
    } finally { await client.close(); }
  });
});
