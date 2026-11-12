#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const disabled = process.argv.includes('--disable-write');
const child = spawn(process.execPath, [new URL('../../testing/fake-muse-cli.ts', import.meta.url).pathname, ...process.argv.slice(2)], { env: { ...process.env, FAKE_MUSE_TURN: disabled ? 'hang' : 'reply' }, stdio: ['pipe', 'pipe', 'inherit'] });
child.stdout.pipe(process.stdout); child.on('exit', c => process.exit(c ?? 0));
createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line);
 if (m.method === 'turn/start' && !disabled) writeFileSync(process.env.POSTURE_WITNESS, 'write after restart\n');
 child.stdin.write(line + '\n');
}).on('close', () => child.stdin.end());
