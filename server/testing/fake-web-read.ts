// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Deterministic model substitute. The real driver launches this fake, which
// calls the real agents MCP server; no internal HTTP endpoint shortcut.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { CustomToolLaunch } from './fake-custom-tool.ts';
export async function replayWebRead(launch: CustomToolLaunch, url: string, observe: (input: unknown, output: unknown) => void) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/sales$/.test(url)) throw Error('Replay requires its loopback fixture');
  const child = spawn(launch.command, launch.args, { env: { ...process.env, ...launch.env }, stdio: ['pipe', 'pipe', 'ignore'] });
  let id = 0, buffer = '';
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const fail = () => { for (const p of pending.values()) p.reject(Error('Replay MCP closed')); pending.clear(); };
  child.on('error', fail); child.on('exit', fail);
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let reply; try { reply = JSON.parse(line); } catch { continue; }
      const p = pending.get(reply.id); if (!p) continue; pending.delete(reply.id);
      if (reply.error) p.reject(Error(reply.error.message)); else p.resolve(reply.result);
    }
  });
  const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const n = ++id; pending.set(n, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
  const timeout = setTimeout(() => { fail(); child.kill(); }, 60_000);
  try {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'web-replay', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const listed = await request('tools/list', {});
    if (!listed.tools.some((t: any) => t.name === 'web_read')) throw Error('web_read unavailable');
    let input: Record<string, unknown> = { url, length: 4000 }, text = '';
    const receipts = [];
    for (let n = 0; n < 20; n++) {
      const result = await request('tools/call', { name: 'web_read', arguments: input });
      observe(input, result);
      if (result.isError) throw Error('web_read refused the fixture');
      const page = JSON.parse(result.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n'));
      if (page.offset !== text.length || typeof page.text !== 'string') throw Error('Invalid continuation');
      text += page.text;
      receipts.push({ handle: page.handle, offset: page.offset, next_offset: page.next_offset, total_length: page.total_length, eof: page.eof });
      if (page.eof) {
        writeFileSync(join(process.cwd(), 'reconstructed.txt'), text);
        writeFileSync(join(process.cwd(), 'ranges.json'), JSON.stringify(receipts));
        return { length: text.length, sha256: createHash('sha256').update(text).digest('hex') };
      }
      input = { handle: page.handle, offset: page.next_offset, length: 4000 };
    }
    throw Error('Continuation did not reach EOF');
  } finally { clearTimeout(timeout); child.stdin.end(); child.kill(); }
}
export async function replayCommands(prompt: string, authorize: (command: string, id: number) => Promise<void>, observe: (command: string, output: string, id: number) => void) {
  const commands = prompt.split('\n').filter(line => /^(cd |ls |curl |python3 )/.test(line));
  if (commands.length !== 4) throw Error('Replay command sequence missing');
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i]; await authorize(command, i);
    const result = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', command], { env: { ...process.env, PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let text = ''; child.stdout.on('data', x => { text += x; }); child.stderr.on('data', x => { text += x; });
      child.once('error', reject); child.once('exit', code => resolve({ code, text }));
    });
    observe(command, result.text, i); if (result.code !== 0) throw Error('Replay command failed');
  }
}
