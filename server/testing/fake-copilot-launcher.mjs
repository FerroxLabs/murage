// Offline Copilot launcher contract. No tool or provider is contacted.
import { readFileSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('copilot-fixture 1.0.105'); process.exit(0); }
if (!args.includes('--acp') || !args.includes('--stdio')) throw new Error('Both --acp and --stdio are required');
let sessionMethod;
const ref = args[args.indexOf('--additional-mcp-config') + 1];
if (!ref?.startsWith('@')) throw new Error('Launcher MCP config is required');
const { mcpServers } = JSON.parse(readFileSync(ref.slice(1), 'utf8'));
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (!msg.method || msg.id === undefined) continue;
  let result = {};
  if (msg.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] };
  if (msg.method === 'session/new' || msg.method === 'session/load') {
    sessionMethod = msg.method;
    if (msg.method === 'session/load' && msg.params.sessionId !== 'fixture-session') throw new Error('Expected the saved session');
    if (msg.params.mcpServers?.length) throw new Error('Copilot rejects client stdio servers');
    result = { sessionId: 'fixture-session', configOptions: [{ id: 'model', type: 'select', currentValue: 'auto', options: [{ value: 'auto', name: 'Auto' }] }] };
  }
  if (msg.method === 'session/prompt') {
    appendFileSync(process.env.COPILOT_FIXTURE_RECEIPT, JSON.stringify({ pid: process.pid, sessionMethod, sessionId: msg.params.sessionId, configPath: ref.slice(1), names: Object.keys(mcpServers), marker: mcpServers.agents?.env.FIXTURE_REVISION }) + '\n');
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fixture reply" } } } }) + "\n");
    if (process.env.COPILOT_FIXTURE_HOLD === '1') continue;
    result = { stopReason: "end_turn" };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
}
