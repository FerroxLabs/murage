#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';
const disabled = process.argv.includes('--disable-write');
const child = spawn(process.execPath, [new URL('../../testing/fake-muse-cli.ts', import.meta.url).pathname, ...process.argv.slice(2)], { env: { ...process.env, FAKE_MUSE_TURN: disabled ? 'hang' : 'reply' }, stdio: ['pipe', 'pipe', 'inherit'] });
child.stdout.pipe(process.stdout); child.on('exit', c => process.exit(c ?? 0));
createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line);
 if (m.method === 'turn/start' && disabled && process.env.POSTURE_BOUNDARY) {
  // Model the read-only engine reaching its current item boundary. The test
  // controls this event directly instead of waiting for the blocked-item cap.
  const atBoundary = () => {
   if (!existsSync(process.env.POSTURE_BOUNDARY)) { setTimeout(atBoundary, 10); return; }
   process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'item/completed', params: { sessionId: m.params.sessionId,
    item: { itemId: 'posture-read-boundary', kind: 'toolCall', status: 'completed', turnId: m.params.commandId, tool: 'read_file', args: '{"path":"fixture.txt"}' } } }) + '\n');
  };
  atBoundary();
 }
 if (m.method === 'turn/start' && !disabled) writeFileSync(process.env.POSTURE_WITNESS, 'write after restart\n');
 child.stdin.write(line + '\n');
}).on('close', () => child.stdin.end());
