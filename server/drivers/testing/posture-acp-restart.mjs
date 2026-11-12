#!/usr/bin/env node
// Immutable-launch fixture: the read-only process never accepts a write.
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('1.0.0'); process.exit(0); }
let sessionId = `s-${process.pid}`;
const readonly = process.env.POSTURE_READONLY === '1';
const log = x => appendFileSync(process.env.POSTURE_LOG, JSON.stringify({ pid: process.pid, readonly, ...x }) + '\n');
log({ launch: true });
const launches = readFileSync(process.env.POSTURE_LOG, 'utf8').trim().split('\n').map(s=>JSON.parse(s)).filter(x=>x.launch).length;
const fail = launches > 1 && (launches <= 1 + Number(process.env.FAIL_SPAWNS || 0) || (process.env.FAIL_PATTERN || '').split(',').map(Number).includes(launches));
if (fail) process.exit(17);

const out = x => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line); log(m);
 if (m.method === 'initialize' && !readonly && process.env.POSTURE_HANG_NORMAL === '1') return;
 if (m.method === 'initialize') out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
 else if (m.method === 'session/new' || m.method === 'session/load') { sessionId = m.params?.sessionId ?? sessionId; out({ id: m.id, result: { sessionId } }); }
 else if (m.method === 'session/prompt') {
  out({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ready' } } } });
  if (readonly) {
   // Suppressed write is an item boundary. Cancel may hang: the driver must close this process.
   setTimeout(() => out({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'stopped', kind: 'edit', status: 'failed' } } }), 100);
  } else {
   writeFileSync(process.env.POSTURE_WITNESS, 'write in replacement process\n');
   const finish=()=>{ if(process.env.POSTURE_FINISH && !existsSync(process.env.POSTURE_FINISH)) {setTimeout(finish,10);return;} out({ id: m.id, result: { stopReason: 'end_turn' } }); }; finish();
  }
 } else if (m.id) out({ id: m.id, result: {} });
});
