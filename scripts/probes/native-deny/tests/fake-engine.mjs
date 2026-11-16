// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Test-only protocol peer. It never executes a requested command or logs in.
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export async function fakeEngine(probe, variant = 'healthy') {
  const args = process.argv.slice(2), work = process.cwd();
  const root = dirname(dirname(work));
  const file = name => join(work, name);
  const send = value => console.log(JSON.stringify(value));
  const log = (name, value) => appendFileSync(join(root, name), JSON.stringify(value) + '\n');
  if (args.includes('--version')) { console.log('fixture-engine 2.1.292'); return; }
  let sequence = 0;
  const attempt = (name, content = 'Permission denied by fixture rule') => {
    if (variant === 'missing-proof' && (probe === 'P-C1' || probe === 'P-G1' || probe === 'P-CU1' && name === 'protected/y.txt')) content = 'disk full';
    const id = `tool-${++sequence}`;
    send({ sessionUpdate: 'tool_call', toolCallId: id, title: 'Bash', rawInput: { command: `touch '${file(name)}'` } });
    if (variant === 'wrong-call-denial') send({ sessionUpdate: 'tool_call_update', toolCallId: 'other', status: 'failed', content });
    else if (variant !== 'prose-denial') send({ sessionUpdate: 'tool_call_update', ...(variant === 'unlinked-denial' ? {} : { toolCallId: id }), status: 'failed',
      content: variant === 'unrelated-error' ? 'disk full' : variant === 'path-error' ? `cannot execute ${file(name)}` : content });
    if (variant === 'prose-denial') send({ type: 'text', text: 'Permission denied' });
  };
  const ordinary = text => send({ sessionUpdate: 'tool_call_update', toolCallId: `ordinary-${++sequence}`, status: 'completed', content: text });
  const finish = () => {
    if (variant === 'malformed') console.log('fixture malformed stream line');
    send(variant === 'engine-error' ? { type: 'result', is_error: true } : { type: 'result', is_error: false });
    if (variant === 'truncated') console.log('{"type":');
  };
  if (args.includes('app-server')) {
    const hooks = ['preToolUse', 'sessionStart'].map(eventName => ({ key: eventName, eventName,
      sourcePath: join(process.env.CODEX_HOME, 'hooks.json'), currentHash: 'fixture', enabled: true, trustStatus: 'trusted' }));
    for await (const line of createInterface({ input: process.stdin })) {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) send({ id: msg.id, result: msg.method === 'hooks/list' ? { data: [{ cwd: work, hooks }] } : {} });
    }
    return;
  }
  if (['P-CU2', 'P-G1', 'P-F1', 'P-F2', 'P-F3'].includes(probe)) {
    let promptId;
    for await (const line of createInterface({ input: process.stdin })) {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') {
        if (variant === 'no-auth') send({ id: msg.id, error: { code: -32000, message: 'auth needed: fixture-private' } });
        else send({ id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') send({ id: msg.id, result: { sessionId: 'fixture',
        _meta: { 'fuigo/permissionPolicy': { sha256: process.env.FUIGO_POLICY_SHA256 } } } });
      else if (msg.method === 'session/prompt') {
        if (variant === 'missing-proof' && probe === 'P-CU2') {
          finish(); send({ id: msg.id, result: { stopReason: 'end_turn' } }); continue;
        }
        if (probe === 'P-CU2' || probe === 'P-F1' && msg.params.prompt[0].text.includes('echo hi') && variant !== 'missing-proof') {
          promptId = msg.id;
          send({ id: 'ask', method: 'session/request_permission', params: { toolCall: { rawInput: { command: probe === 'P-CU2' ? `touch '${file('cu2')}'` : 'echo hi' } },
            options: [{ kind: 'allow_once', optionId: 'allow' }, { kind: 'reject_once', optionId: 'reject' }] } });
          continue;
        }
        if (probe === 'P-G1') attempt(`g1-${args[args.indexOf('--permission-mode') + 1]}`);
        if (probe === 'P-F1') { attempt('f1'); if (variant === 'missing-proof') ordinary('hi\n'); }
        if (probe === 'P-F2') { attempt('.git/HEAD'); ordinary('ref: refs/heads/probe\n'); if (variant !== 'missing-proof') writeFileSync(file('z.txt'), 'native-deny-probe'); }
        if (probe === 'P-F3') {
          if (variant === 'spawned') send({ method: '_fuigo/session_notification', params: { update: { sessionUpdate: 'subagent_spawned', subagent_id: 'child' } } });
          send({ type: 'text', text: 'subagent spawning disabled' });
        }
        finish(); send({ id: msg.id, result: { stopReason: 'end_turn' } });
      } else if (msg.id === 'ask') {
        if (probe === 'P-F1') ordinary('hi\n');
        finish(); send({ id: promptId, result: { stopReason: 'end_turn' } });
      }
    }
    return;
  }
  if (probe === 'P-C1') {
    const spelling = args.join(' ').includes('settings-double.json') ? 'double' : 'single';
    for (const name of [`c1-${spelling}`, `protected/${spelling}.txt`]) attempt(name, 'permission denied from flagSettings');
  } else if (probe === 'P-C2') { if (variant !== 'missing-proof') attempt('c2'); }
  else if (probe === 'P-C3') {
    for (const name of ['c3', 'c3b', 'c3c']) { attempt(name); log('prefix.log', { canaries: [file(variant === 'missing-proof' && name === 'c3c' ? 'c3' : name)] }); }
    send({ type: 'tool_use', name: 'Agent', id: 'child' });
  } else if (probe === 'P-C4') { if (variant !== 'missing-proof') attempt('c4'); }
  else if (probe === 'P-C5') {
    appendFileSync(file('.git/config'), '\n# native-deny-probe');
    if (variant !== 'missing-proof') writeFileSync(file('.claude/settings.json'), '{"nativeDenyProbe":true}');
  } else if (probe === 'P-C6') {
    if (variant === 'engine-error') { send({ type: 'result', is_error: true }); return; }
    if (variant === 'missing-proof') { send({ type: 'result', is_error: false }); return; }
    if (variant === 'refusal-truncated' || process.env.IS_SANDBOX !== '1') {
      console.log('root cannot bypass permissions');
      if (variant === 'refusal-truncated') console.log('{"type":');
      process.exitCode = 1; return;
    }
  } else if (probe === 'P-X1') {
    log('hook.log', { event: 'SessionStart' }); log('hook.log', { event: 'PreToolUse', deny: variant !== 'missing-proof' });
    attempt('x1', 'native-deny-probe fixture canary refused');
  } else if (probe === 'P-X2') {
    if (args.includes('execpolicy')) {
      if (variant === 'multiline-offline') console.log(JSON.stringify({ decision: 'forbidden' }, null, 2));
      else if (variant === 'truncated-offline') console.log('{\n  "decision": "forbidden"');
      else if (variant === 'trailing-offline') console.log('{"decision":"forbidden"}\n{"decision":');
      else send({ decision: variant === 'missing-proof' ? 'allow' : 'forbidden' });
      return;
    }
    attempt('x2', 'native-deny-probe fixture canary refused');
  } else if (probe === 'P-X3') { if (variant !== 'missing-proof') attempt(args.at(-1).includes('x3-compound') ? 'x3-compound' : 'x3'); }
  else if (probe === 'P-A1') {
    writeFileSync(join(root, 'agy.log'), variant === 'missing-proof' ? 'run_command\nloaded 1 named hooks from 1 hooks.json\n' : 'loaded 1 named hooks from 1 hooks.json\nrun_command\n');
    log('hook.log', { deny: true }); attempt('a1', 'native-deny-probe fixture canary refused');
  } else if (probe === 'P-CU1') { attempt('cu1'); attempt('protected/y.txt'); }
  else if (probe === 'P-O1' || probe === 'P-O2') {
    attempt(probe === 'P-O1' ? 'o1' : 'o2', 'native-deny-probe fixture canary refused');
    if (probe !== 'P-O1' || variant !== 'missing-proof') ordinary(probe === 'P-O1' ? 'ok\n' : 'done\n');
    if (probe === 'P-O2' && variant !== 'missing-proof') writeFileSync(join(root, 'plugin.log'), 'denied\n');
  }
  finish();
}
