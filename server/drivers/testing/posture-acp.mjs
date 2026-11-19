#!/usr/bin/env node
// Recorded ACP boundary fixture. It never executes tool input.
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('1.0.0'); process.exit(0); }
const [gate, log] = process.argv.slice(2);
const out = x => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\n');
let prompt;
createInterface({ input: process.stdin }).on('line', async line => {
 const m = JSON.parse(line); appendFileSync(log, JSON.stringify(m) + '\n');
 if (m.method === 'initialize') out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
 else if (m.method === 'session/new') out({ id: m.id, result: { sessionId: 'posture', modes: { currentModeId: 'normal', availableModes: [{ id: 'normal' }, { id: 'readonly' }] } } });
 else if (m.method === 'session/prompt') {
   prompt = m.id;
   out({ method: 'session/update', params: { sessionId: 'posture', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ready' } } } });
   while (!existsSync(gate)) await new Promise(r => setTimeout(r, 10));
   if (process.argv.includes('--question')) { out({id:900,method:'elicitation/create',params:{sessionId:'posture',message:'Fixture question',requestedSchema:{type:'object',properties:{pick:{type:'string',enum:['yes','no']}},required:['pick']}}}); return; }
   const toolCall = { toolCallId: 'next', title: 'shell', kind: 'execute', status: 'pending', rawInput: { command: 'echo fixture' } };
   if (!process.argv.includes('--permission-only')) out({ method: 'session/update', params: { sessionId: 'posture', update: { sessionUpdate: 'tool_call', ...toolCall } } });
   out({ id: 900, method: 'session/request_permission', params: { sessionId: 'posture', toolCall, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }] } });
 } else if (m.id === 900) out({ id: prompt, result: { stopReason: 'end_turn' } });
 else if (m.id) out({ id: m.id, result: {} });
});
