#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
const child = spawn(process.execPath, [new URL('../../testing/fake-codex-app-server.ts', import.meta.url).pathname, ...process.argv.slice(2)], { env: { ...process.env, FAKE_CODEX_MODE: 'parent-approval' }, stdio: ['pipe', 'pipe', 'inherit'] });
const out = x => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\n');
let starts = 0;
createInterface({ input: child.stdout }).on('line', line => {
 if (process.argv.includes('--version')) { process.stdout.write(line + '\n'); return; }
 const msg = JSON.parse(line);
 if (msg.method === 'turn/completed') {
  out({ method: 'item/completed', params: { threadId: msg.params.threadId, turnId: msg.params.turn.id, item: { id: 'boundary', type: 'reasoning' } } });
 } else process.stdout.write(line + '\n');
});
child.on('exit', c => process.exit(c ?? 0));
createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line);
 if (process.env.POSTURE_LOG) appendFileSync(process.env.POSTURE_LOG, JSON.stringify({ ...m, at: Date.now() }) + '\n');
 if (m.method === 'turn/start' && ++starts > 1) {
  if (process.env.POSTURE_EARLY_TERMINAL === '1') out({ method: 'turn/completed', params: { threadId: m.params.threadId, turn: { id: 'continued', status: 'completed' } } });
  out({ id: m.id, result: { turn: { id: 'continued' } } });
  if (m.params.sandbox === 'danger-full-access') writeFileSync(process.env.POSTURE_WITNESS, 'outside bot folder\n');
  if (process.env.POSTURE_EARLY_TERMINAL !== '1') setTimeout(() => out({ method: 'turn/completed', params: { threadId: m.params.threadId, turn: { id: 'continued', status: 'completed' } } }), 20);
 } else if (m.method === 'turn/interrupt') {
  out({ id: m.id, result: {} });
  out({ method: 'turn/completed', params: { threadId: m.params.threadId, turn: { id: m.params.turnId, status: 'interrupted' } } });
 } else child.stdin.write(line + '\n');
}).on('close', () => child.stdin.end());
