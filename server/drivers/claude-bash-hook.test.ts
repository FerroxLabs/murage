// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Socket } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { relayClaudeBash } from './claude-bash-hook.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function broker(handle: (socket: Socket, ask: any) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'wipe-hook-')), path = join(dir, 'broker.sock');
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.once('data', chunk => handle(socket, JSON.parse(chunk.toString())));
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); });
  return path;
}
it('W4 relays the exact Bash input and delivers a narrowed allow once', async () => {
  const input = { command: 'echo ok', timeout: 30 };
  const path = await broker((socket, ask) => {
    expect(ask).toMatchObject({ t: 'ask', tool: 'Bash', input });
    socket.write(JSON.stringify({ t: 'answer', id: ask.id, behavior: 'allow', updatedInput: input }) + '\n');
  });
  expect(await relayClaudeBash(path, input, new AbortController().signal)).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: input } });
});
it('W4 keeps a wipe denied when the owner declines', async () => {
  const path = await broker((socket, ask) => socket.write(JSON.stringify({ t: 'answer', id: ask.id, behavior: 'deny' }) + '\n'));
  expect(await relayClaudeBash(path, { command: 'rm -rf backups' }, new AbortController().signal)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
});
it('W4 a cancelled callback denies and closes its pending broker connection', async () => {
  const abort = new AbortController();
  const path = await broker(() => abort.abort());
  expect(await relayClaudeBash(path, { command: 'rm -rf backups' }, abort.signal)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
});
it('W4 a lost broker keeps a visible home wipe denied', async () => {
  const path = await broker(socket => socket.destroy());
  expect(await relayClaudeBash(path, { command: 'rm -rf ~' }, new AbortController().signal)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
});

for(const fault of ['close','malformed','wrong-id','invalid-behavior','oversize','connect-error'])it.each([false,true])(`R6 ${fault} recovers ordinary work and retains visible wipe=%s`,async wipe=>{
 const path=await broker((socket,ask)=>{
  if(fault==='close')socket.destroy();
  else if(fault==='malformed')socket.end('not-json\n');
  else if(fault==='wrong-id')socket.end(JSON.stringify({t:'answer',id:'other',behavior:'deny'})+'\n');
  else if(fault==='invalid-behavior')socket.end(JSON.stringify({t:'answer',id:ask.id,behavior:'invalid'})+'\n');
  else if(fault==='oversize')socket.end('x'.repeat(4*1024*1024+1));
 });
 const result=await relayClaudeBash(fault==='connect-error'?path+'-absent':path,{command:wipe?'rm -rf ~':'echo ordinary'},new AbortController().signal);
 expect(result).toMatchObject({hookSpecificOutput:{permissionDecision:wipe?'deny':'allow'}});
});

it('R6 local recovery keeps the actual project cwd for a whole-project wipe',async()=>{
 const path=await broker(socket=>socket.destroy());
 expect(await relayClaudeBash(path,{command:'rm -rf .'},new AbortController().signal,{cwd:'/fixture/project',project:'/fixture/project'})).toMatchObject({hookSpecificOutput:{permissionDecision:'deny'}});
});
