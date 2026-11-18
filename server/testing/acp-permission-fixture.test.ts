// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture producer/consumer owner: c4-misc-a. Native admission owner: c3-drivers.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { sessionBoundAcpPermissionEnvironment } from './acp-permission-fixture.ts';
import { removeTempDir, waitForExit } from './cleanup.ts';
import { fixtureStdioRpc } from './stdio-rpc.ts';

let directory: string | undefined, child: ChildProcessWithoutNullStreams | undefined;
let rpc: ReturnType<typeof fixtureStdioRpc> | undefined;
afterEach(async () => {
  try { rpc?.close(); if (child) await waitForExit(child, { signal: 'SIGTERM' }); }
  finally { if (directory) await removeTempDir(directory); directory = undefined; child = undefined; rpc = undefined; }
});
async function fixture() {
  directory = mkdtempSync(join(tmpdir(), 'acp-permission-'));
  const peer = join(directory, 'catalog-peer.mjs');
  writeFileSync(peer, `import {createInterface} from 'node:readline';
import {existsSync,writeFileSync} from 'node:fs';
const [marker,gate,mode]=process.argv.slice(2);
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize')send(m.id,{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
 if(m.method==='tools/list'){writeFileSync(marker,'listed');if(mode==='exit')process.exit(0);
 const ready=()=>{if(gate&&!existsSync(gate)){setTimeout(ready,10);return;}send(m.id,{tools:[]});};ready();}
});`);
  const frames: any[] = [];
  child = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('./fake-acp-cli.ts', import.meta.url))], {
    windowsHide: true, env: { ...process.env, ...sessionBoundAcpPermissionEnvironment({ FAKE_ACP_MODE: 'permission' }) }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  rpc = fixtureStdioRpc(child, frame => frames.push(frame));
  await rpc.request(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
  const server = (name: string, gate = '', mode = '') => ({ name, command: process.execPath, args: [peer, join(directory!, name), gate, mode], env: [] });
  return { frames, server, ready: () => frames.filter(frame => frame.method === '_x.ai/mcp_initialized') };
}

it('announces native readiness only after every real handed catalog replies', async () => {
  const f = await fixture(), gate = join(directory!, 'release');
  await rpc!.request(2, 'session/new', { cwd: directory, mcpServers: [f.server('first'), f.server('held', gate)] });
  await expect.poll(() => existsSync(join(directory!, 'held'))).toBe(true);
  expect(f.ready()).toEqual([]);
  writeFileSync(gate, 'release');
  await expect.poll(() => f.ready().length).toBe(1);
  expect(f.ready()[0].params.sessionId).toBeTruthy();
  expect(existsSync(join(directory!, 'first'))).toBe(true);
});

it('does not announce readiness when a handed server exits without its catalog', async () => {
  const f = await fixture();
  await rpc!.request(2, 'session/new', { cwd: directory, mcpServers: [f.server('exited', '', 'exit')] });
  await expect.poll(() => existsSync(join(directory!, 'exited'))).toBe(true);
  expect(f.ready()).toEqual([]);
});
