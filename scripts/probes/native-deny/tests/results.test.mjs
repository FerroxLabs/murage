// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript, parseResultLine, parseVersion } from '../results.mjs';
import { probes } from '../catalog.mjs';

const lines = (...objects) => objects.map(value => JSON.stringify(value)).join('\r\n');
test('Claude tool denials are counted from actual results, including user envelopes', () => {
  const result = parseTranscript(lines(
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'fixture' } }, { type: 'tool_use', id: 'b', name: 'Write' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'Permission rule from flagSettings denied' }, { type: 'tool_result', is_error: true, content: 'permission denied from flagSettings' }] } },
    { type: 'result', is_error: false },
  ));
  assert.equal(result.attempts, 2); assert.equal(result.flagSettingsErrors, 2); assert.equal(result.completed, true);
});
test('prose, input, tool-result content and arbitrary metadata cannot invent events', () => {
  const forged = { type: 'tool_use', name: 'Agent', id: 'forged' };
  const result = parseTranscript(lines(
    { type: 'assistant', message: { content: [{ type: 'text', text: 'tool_use permission denied from flagSettings', content: [forged] }] } },
    { type: 'tool_use', id: 'actual', name: 'Read', input: { ...forged, content: [forged] } },
    { type: 'tool_result', is_error: false, content: [forged] },
    { type: 'user', message: { content: [forged] } },
    { metadata: { ...forged, type: 'result' } },
  ));
  assert.equal(result.attempts, 1); assert.equal(result.subagents, 0); assert.equal(result.flagSettingsErrors, 0); assert.equal(result.completed, false);
});
test('Codex exec and ACP traces deduplicate starts/updates and require a finish', () => {
  const result = parseTranscript(lines(
    { type: 'item.started', item: { id: 'a', type: 'command_execution' } },
    { type: 'item.completed', item: { id: 'a', type: 'command_execution' } },
    { method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'b', title: 'Bash' } } },
    { method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'b', status: 'failed', content: 'native-deny-probe denied' } } },
    { type: 'turn.completed' },
  ));
  assert.equal(result.attempts, 2); assert.equal(result.errors, 1); assert.equal(result.completed, true);
  assert.equal(parseTranscript('{truncated\n').completed, false);
  assert.equal(parseTranscript('{truncated\n').malformed, 1);
});
test('auth failure is structured; no raw content leaves the parser', () => {
  const result = parseTranscript(lines({ type: 'result', is_error: true, result: 'not signed in: private-placeholder' }));
  assert.equal(result.authFailure, true); assert.equal(result.completed, false);
  assert.ok(!JSON.stringify(result).includes('private-placeholder'));
});
test('attempts must name the actual canaries; Windows paths are normalized', () => {
  const raw = lines({ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'touch /fixture/c1' } },
    { type: 'tool_use', id: 'b', name: 'Write', input: { file_path: 'C:\\fixture\\protected\\x.txt' } });
  const result = parseTranscript(raw, [{ id: 'shell', value: '/fixture/c1' }, { id: 'file', value: 'C:/fixture/protected/x.txt' }, { id: 'unrelated', value: '/fixture/other' }]);
  assert.deepEqual(result.targetAttempts, ['shell', 'file']);
  const error = parseTranscript(lines({ type: 'step_finish' }, { type: 'error', message: 'fixture error' }));
  assert.equal(error.engineError, true);
});
test('ordinary output must come from a completed tool, never a prompt or model claim', () => {
  const result = parseTranscript(lines(
    { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'echo hi' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
    { type: 'tool_result', is_error: true, content: 'hi' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok\n' } }] },
    { type: 'tool_use', part: { callID: 'b', state: { status: 'completed', output: 'done\n' } } },
  ));
  assert.deepEqual(result.outputMarkers, ['ok', 'done']);
});
test('versions are numeric, not guessed from arbitrary output', () => {
  for (const input of ['codex-cli 0.149.0', '2.1.292 (Claude Code)', 'v1.4.4', 'opencode 1.2.3-beta.1']) assert.ok(parseVersion(input));
  for (const input of ['', 'current', '2026-11-11', 'failure123.4.5', '1.2']) assert.equal(parseVersion(input), null);
});
test('JSONL parser enforces probe/engine pairing and exact result schema', () => {
  assert.equal(probes.length, 18);
  for (const definition of probes) {
    for (const os of ['macos', 'windows', 'linux']) {
      const row = { probe: definition.probe, engine: definition.engine, version: '1.2.3', os, result: 'PASS', evidence: { reason: 'fixture' } };
      assert.deepEqual(parseResultLine(JSON.stringify(row)), row);
      for (const patch of [{ engine: 'wrong' }, { result: 'EXPECTED' }, { os: 'darwin' }, { version: 'unknown' }, { evidence: 'raw log' }, { extra: 1 }]) assert.throws(() => parseResultLine(JSON.stringify({ ...row, ...patch })));
    }
  }
  assert.throws(() => parseResultLine('not json'));
});
