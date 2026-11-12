// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Child helper: hook handler, shell prefix, or fixture-only approval MCP stub.
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';

const [mode, configFile, ...args] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configFile, 'utf8'));
const log = value => appendFileSync(config.log, `${JSON.stringify(value)}\n`, { mode: 0o600 });
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const contains = (text, canary) => {
  text = text.replaceAll('\\', '/'); canary = canary.replaceAll('\\', '/');
  const index = text.indexOf(canary);
  return index >= 0 && !/[\w.-]/.test(text[index + canary.length] ?? '');
};
if (mode === 'prefix') {
  const command = args.join(' ');
  const canaries = config.canaries.filter(item => contains(command, item));
  log({ event: 'prefix', canaries });
  if (canaries.length) process.exitCode = 126;
  else {
    const result = spawnSync(args[0], args.slice(1), { stdio: 'inherit', shell: false });
    process.exitCode = result.status ?? 126;
  }
} else if (mode === 'hook') {
  let raw = '';
  for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 1024 * 1024) process.exit(2); }
  let call;
  try { call = JSON.parse(raw); } catch { process.exit(2); }
  const texts = strings(call.tool_input ?? call.tool?.input ?? call.tool?.arguments ?? call);
  const event = call.hook_event_name ?? call.hookEventName ?? 'PreToolUse';
  const deny = event === 'PreToolUse' && config.canaries.some(item => texts.some(text => contains(text, item)));
  log({ event, deny });
  if (config.engine === 'antigravity') send(deny ? { decision: 'deny', reason: config.reason } : { decision: 'allow' });
  else if (deny) send({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: config.reason } });
  else send({});
} else if (mode === 'mcp') {
  for await (const line of createInterface({ input: process.stdin })) {
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue;
    let result;
    if (msg.method === 'initialize') result = { protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'native-deny-stub', version: '1.0.0' } };
    else if (msg.method === 'tools/list') result = { tools: [{ name: 'approve', description: 'Approve a fixture tool call', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, additionalProperties: true } }] };
    else if (msg.method === 'tools/call' && msg.params?.name === 'approve') {
      log({ event: 'approve' });
      result = { content: [{ type: 'text', text: JSON.stringify({ behavior: 'allow', updatedInput: msg.params.arguments?.input ?? {} }) }] };
    } else if (msg.method === 'ping') result = {};
    if (result) send({ jsonrpc: '2.0', id: msg.id, result });
    else send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unknown method' } });
  }
} else process.exitCode = 2;
