// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import * as procs from '../../procs.ts';
import { ensureDirs } from '../../config.ts';
import { fixtureBotFolder } from '../../testing/bot-folder-fixture.ts';
import { recordEvents } from '../../testing/events.ts';
import { removeTempDir } from '../../testing/cleanup.ts';
import { createAcpDriver } from './core.ts';

it.each(['completion', 'interrupt', 'dispose'] as const)('stalled native retirement bounds %s and tears down its pooled child', async ending => {
  ensureDirs();
  const scratch = mkdtempSync(join(tmpdir(), 'murage-native-retirement-'));
  const cli = join(scratch, 'fixture.mjs');
  writeFileSync(cli, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('1.0.0'); process.exit(0); }
const out = value => console.log(JSON.stringify({ jsonrpc: '2.0', ...value }));
let prompt;
createInterface({ input: process.stdin }).on('line', line => {
 const msg = JSON.parse(line);
 if (msg.method === 'initialize') out({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
 else if (msg.method === 'session/new') out({ id: msg.id, result: { sessionId: 'fixture-session' } });
 else if (msg.method === 'session/prompt') {
   prompt = msg.id;
   out({ method: 'session/update', params: { sessionId: 'fixture-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixture reply' } } } });
   out({ id: 900, method: 'x.ai/ask_user_question', params: { questions: [{ question: 'Which?', options: [{ label: 'One' }] }] } });
   ${ending === 'completion' ? "setTimeout(() => out({ id: prompt, result: { stopReason: 'end_turn' } }), 200);" : ''}
 } else if (msg.method === 'session/cancel') out({ id: prompt, result: { stopReason: 'cancelled' } });
 else if (msg.id !== undefined && msg.method) out({ id: msg.id, result: {} });
});
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  let child: ChildProcess | undefined;
  const callbacks: Array<(error?: Error | null) => void> = [];
  const spawn = procs.spawnCli;
  const spy = vi.spyOn(procs, 'spawnCli').mockImplementation((...args) => {
    const spawned = spawn(...args);
    child = spawned;
    const write = spawned.stdin.write.bind(spawned.stdin);
    vi.spyOn(spawned.stdin, 'write').mockImplementation(((chunk: string, ...rest: unknown[]) => {
      const frame = JSON.parse(String(chunk));
      if (frame.id === 900 && frame.result) {
        const callback = rest.find(value => typeof value === 'function');
        if (callback) callbacks.push(callback as (error?: Error | null) => void);
        return false; // A peer that never drains: no write receipt, even on close.
      }
      return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof spawned.stdin.write);
    return spawned;
  });
  const previousPool = process.env.MURAGE_ACP_POOL;
  process.env.MURAGE_ACP_POOL = '1';
  const instance = await createAcpDriver({ driverKind: 'retirementFixture', displayName: 'Fixture',
    fluxReach: () => 'elsewhere', // This inert peer never sends inference requests.
    defaultCli: cli, nativeSource: 'fixture', loginNote: 'fixture', pooledSessions: true,
    models: { default: '', options: [] }, spawnArgs: () => [], pickAuthMethod: () => null,
    isAuthenticated: () => true, authFailure: 'continue',
  }).create({ instanceId: 'retirement', displayName: 'Fixture', enabled: true, environment: {}, config: { cli, fullAuto: false } });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: 'retirement', cwd: fixtureBotFolder(), text: 'fixture' });
    const opened = await recorder.until(event => event.type === 'request.opened');
    if (opened.type !== 'request.opened') throw new Error('Expected a native question');
    // Hold an actual answer receipt too: retirement must join it without a second native frame.
    const answer = instance.adapter.respondToRequest('retirement', String(opened.requestId), {
      behavior: 'answer', answers: [{ id: 'q1', selected: ['One'] }],
    });
    await expect.poll(() => callbacks.length).toBe(1);
    const stopped = ending === 'interrupt' ? instance.adapter.interruptTurn('retirement')
      : ending === 'dispose' ? instance.dispose() : Promise.resolve();
    const completed = await recorder.until(event => event.type === 'turn.completed', 4000);
    if (ending === 'completion') expect(completed).toMatchObject({ ok: true });
    expect(await Promise.race([answer, new Promise(resolve => setTimeout(() => resolve('still pending'), 2000))])).toBe('unavailable');
    await stopped;
    await expect.poll(() => child?.exitCode !== null || child?.signalCode !== null, { timeout: 4000 }).toBe(true);
    expect(callbacks).toHaveLength(1);
    expect(recorder.events.filter(event => event.type === 'request.resolved')).toHaveLength(1);
    callbacks[0]!(null);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(recorder.events.filter(event => event.type === 'request.resolved')).toHaveLength(1);
    expect(recorder.events.filter(event => event.type === 'turn.completed')).toHaveLength(1);
  } finally {
    recorder.stop();
    for (const callback of callbacks) callback(new Error('Fixture cleanup'));
    await instance.dispose();
    spy.mockRestore();
    if (previousPool === undefined) delete process.env.MURAGE_ACP_POOL;
    else process.env.MURAGE_ACP_POOL = previousPool;
    await removeTempDir(scratch);
  }
});
