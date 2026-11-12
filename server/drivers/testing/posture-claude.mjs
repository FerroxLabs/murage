#!/usr/bin/env node
// Add recorded set_permission_mode replies to the repository's offline Claude.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const child = spawn(process.execPath, [new URL('../../testing/fake-claude-cli.ts', import.meta.url).pathname, ...process.argv.slice(2)], { stdio: ['pipe','pipe','inherit'] });
child.stdout.pipe(process.stdout);
child.on('exit', code => process.exit(code ?? 1));
createInterface({ input: process.stdin }).on('line', line => {
 let m; try { m = JSON.parse(line); } catch { child.stdin.write(line + '\n'); return; }
 if (m.type === 'control_request' && m.request?.subtype === 'set_permission_mode') {
  appendFileSync(process.env.FAKE_CLAUDE_CONTROL_LOG, line + '\n');
  process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }) + '\n');
 } else child.stdin.write(line + '\n');
}).on('close', () => child.stdin.end());
