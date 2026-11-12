// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { probes } from '../catalog.mjs';
import { withFixture, writeFixture, fixtureEnv } from '../fixture.mjs';
import { makeContext, executeProbe } from '../engines.mjs';
import { digest, parseTranscript } from '../results.mjs';
import { runSuite, parseArgs } from '../run.mjs';

const fakeModule = new URL('./fake-engine.mjs', import.meta.url).href;
function fakeBinary(fixture, probe, variant) {
  const script = writeFixture(fixture, 'fake.mjs', `import { fakeEngine } from ${JSON.stringify(fakeModule)};\nawait fakeEngine(${JSON.stringify(probe)}, ${JSON.stringify(variant)});\n`);
  return { command: process.execPath, args: [script] };
}
function sourceWitness(fixture) {
  const launchPolicyPath = writeFixture(fixture, 'source/permission/launch_policy.rs', '// fixture launch policy\n');
  const resolutionPath = writeFixture(fixture, 'source/resolution.rs', '// fixture resolution\n');
  return { fuigoSourceWitness: { source: 'gate-read-only-source-check', root: fixture.root, commit: 'a'.repeat(40), launchPolicyPath, resolutionPath,
    launchPolicySha256: digest('// fixture launch policy\n'), resolutionSha256: digest('// fixture resolution\n'), reviewedDenyAskBeforeGrants: true } };
}
async function recipe(probe, variant = 'healthy') {
  let root, outcome;
  await withFixture(async fixture => {
    root = fixture.root;
    const binary = fakeBinary(fixture, probe, variant);
    const ctx = makeContext(fixture, binary, fixtureEnv(fixture), 5000);
    const gate = sourceWitness(fixture);
    if (probe === 'P-F3' && variant === 'missing-proof') gate.fuigoSourceWitness.reviewedDenyAskBeforeGrants = false;
    outcome = await executeProbe(ctx, probes.find(row => row.probe === probe), gate);
  });
  assert.equal(existsSync(root), false, `${probe}: isolated fixture removed`);
  return outcome;
}

for (const probe of ['P-CU1', 'P-G1', 'P-F1', 'P-O1']) {
  for (const variant of ['unrelated-error', 'path-error', 'wrong-call-denial', 'unlinked-denial', 'prose-denial']) {
    test(`BLOCK1 ${probe} rejects ${variant}`, async () => {
      const outcome = await recipe(probe, variant);
      assert.equal(outcome.pass, false);
      assert.equal(outcome.rows[0].checks.denialVisible, false);
    });
  }
}
test('BLOCK2 P-F3 fails when an ACP lifecycle event proves a subagent started', async () => {
  const outcome = await recipe('P-F3', 'spawned');
  assert.equal(outcome.rows[0].checks.sourceWitness, true);
  assert.equal(outcome.rows[0].checks.spawningRefused, true);
  assert.equal(outcome.pass, false);
  assert.equal(outcome.rows[0].checks.noSubagent, false);
});
test('BLOCK2 lifecycle notifications count only in protocol envelopes', () => {
  const spawned = { sessionUpdate: 'subagent_spawned', subagent_id: 'child' };
  const raw = [
    { method: 'session/update', params: { update: spawned } },
    { method: '_fuigo/session_notification', params: { update: { ...spawned, subagent_id: 'second' } } },
    { method: 'session/update', params: { update: { ...spawned, sessionUpdate: 'subagent_progress' } } },
    { method: 'session/update', params: { update: { ...spawned, sessionUpdate: 'subagent_finished', subagent_id: 'second' } } },
    { type: 'tool_result', content: spawned },
    { type: 'text', content: spawned },
    { type: 'tool_use', id: 'read', name: 'Read', input: spawned },
    { metadata: spawned },
  ].map(JSON.stringify).join('\n');
  assert.equal(parseTranscript(raw).subagents, 2);
});
test('BLOCK1 Claude, ACP and opencode denials are linked to target call IDs', () => {
  const targets = [{ id: 'target', value: '/fixture/murage-native-deny-owned/canary' }];
  const input = { command: `touch ${targets[0].value}` };
  const traces = [
    [{ type: 'tool_use', id: 'a', name: 'Bash', input }, { type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'Permission denied' }],
    [{ sessionUpdate: 'tool_call', toolCallId: 'a', rawInput: input }, { sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'failed', rawOutput: 'Forbidden by rule' }],
    [{ type: 'tool_use', part: { callID: 'a', tool: 'bash', state: { input, status: 'error', error: 'native-deny-probe fixture canary refused' } } }],
  ];
  for (const trace of traces) {
    assert.deepEqual(parseTranscript(trace.map(JSON.stringify).join('\n'), targets).deniedTargets, ['target']);
  }
  const pathOnly = [traces[0][0], { ...traces[0][1], content: `cannot execute ${targets[0].value}/denied` }];
  assert.deepEqual(parseTranscript(pathOnly.map(JSON.stringify).join('\n'), targets).deniedTargets, []);
});
for (const { probe } of probes) {
  for (const variant of ['truncated', 'malformed']) {
    test(`BLOCK3 ${probe} rejects ${variant} structured proof`, async () => {
      const outcome = await recipe(probe, variant);
      const streamed = outcome.rows.filter(row => row.label !== 'offline' && row.label !== 'root');
      assert.ok(streamed.length > 0);
      for (const row of streamed) {
        assert.ok(row.facts.malformed >= 1);
        assert.equal(row.checks.completed, true, 'otherwise complete fake proof');
        assert.equal(row.checks.processHealthy, false);
      }
      assert.equal(outcome.pass, false);
    });
  }
}
test('BLOCK3 P-C6 rejects a root refusal mixed with truncated JSON', async () => {
  const outcome = await recipe('P-C6', 'refusal-truncated');
  assert.equal(outcome.rows[0].checks.rootRefused, true);
  assert.equal(outcome.rows[0].checks.processHealthy, false);
  assert.equal(outcome.pass, false);
});
test('AFIX2 P-X2 accepts a valid multiline offline JSON document', async () => {
  const outcome = await recipe('P-X2', 'multiline-offline');
  assert.equal(outcome.rows[0].checks.forbidden, true);
  assert.equal(outcome.rows[0].checks.processHealthy, true);
  assert.equal(outcome.pass, true);
});
for (const variant of ['truncated-offline', 'trailing-offline']) {
  test(`AFIX2 P-X2 rejects ${variant} JSON document`, async () => {
    const outcome = await recipe('P-X2', variant);
    assert.equal(outcome.rows[0].checks.processHealthy, false);
    assert.equal(outcome.rows[0].checks.forbidden, false);
    assert.equal(outcome.rows[1].checks.processHealthy, true);
    assert.equal(outcome.pass, false);
  });
}
test('BLOCK4 recognized ACP auth error becomes SKIP-NO-AUTH and cleans fixture', async () => {
  await withFixture(async parent => {
    const binary = fakeBinary(parent, 'P-CU2', 'no-auth');
    const config = { engines: { cursor: { ...binary, auth: { source: 'gate-signed-in-subscription', files: {
      '.cursor/auth.json': '{"session":"fixture-only-not-a-login"}',
    } } } } };
    const rows = [];
    const code = await runSuite(parseArgs(['--os', 'linux', '--run', '--probe', 'P-CU2']), {
      tempRoot: parent.root, inherited: { NATIVE_DENY_GATE_JSON: JSON.stringify(config) }, emit: row => rows.push(row),
    });
    assert.equal(code, 0);
    assert.equal(rows[0].result, 'SKIP');
    assert.equal(rows[0].evidence.reason, 'SKIP-NO-AUTH');
    assert.equal(rows[0].evidence.fixtureCleaned, true);
    assert.ok(!JSON.stringify(rows).includes('fixture-private'));
  });
});

// BLOCK5: every recipe gets protocol-driven positive AND negative coverage.
// The separate mutation runner persists patches/logs and proves these negative
// cases catch a classifier changed to always accept each individual recipe.
for (const { probe } of probes) {
  test(`BLOCK5 ${probe} accepts complete fake proof`, async () => {
    const outcome = await recipe(probe);
    assert.equal(outcome.pass, true, JSON.stringify(outcome.rows));
  });
  test(`BLOCK5 ${probe} rejects failed fake proof`, async () => {
    assert.equal((await recipe(probe, 'engine-error')).pass, false);
  });
  test(`BLOCK5 ${probe} rejects incomplete fake proof`, async () => {
    assert.equal((await recipe(probe, 'missing-proof')).pass, false);
  });
}
