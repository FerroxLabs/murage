// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Inert ACP peer. All effects stay in the verification fixture directory.
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--version')) { console.log('1.0.0'); process.exit(0); }
const directory = process.env.RETIRE_FIXTURE_DIR;
const out = value => console.log(JSON.stringify({ jsonrpc: '2.0', ...value }));
let prompt;
createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') out({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  else if (msg.method === 'session/new') out({ id: msg.id, result: { sessionId: 'fixture-session' } });
  else if (msg.method === 'session/prompt') {
    prompt = msg.id;
    out({ method: 'session/update', params: { sessionId: 'fixture-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixture reply' } } } });
    out(process.env.RETIRE_FIXTURE_KIND === 'approval'
      ? { id: 900, method: 'session/request_permission', params: { sessionId: 'fixture-session', toolCall: { toolCallId: 'fixture-edit', kind: 'edit', title: 'Edit fixture', rawInput: { path: join(directory, 'note.txt'), content: 'fixture' } }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] } }
      : { id: 900, method: 'x.ai/ask_user_question', params: { questions: [{ question: 'Which?', options: [{ label: 'One' }] }] } });
  } else if (msg.method === 'session/cancel') process.exit(0);
  else if (msg.id === 900) appendFileSync(join(directory, 'replies.jsonl'), JSON.stringify(msg) + '\n');
  else if (msg.id !== undefined && msg.method) out({ id: msg.id, result: {} });
}).on('close', () => process.exit(0));
setInterval(() => {
  if (!prompt || !existsSync(join(directory, 'ending'))) return;
  const ending = readFileSync(join(directory, 'ending'), 'utf8');
  if (ending === 'crash') process.exit(7);
  if (ending === 'settle') { out({ id: prompt, result: { stopReason: 'end_turn' } }); prompt = undefined; }
}, 20);
