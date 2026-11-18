// SPDX-License-Identifier: AGPL-3.0-or-later
// Witness (cl-nativecrash): codex-hook.ts serve() reply (:780). A fenced hook answer must be contained at the socket: no
// unhandledRejection/uncaughtException, the engine's hook connection is closed with no answer (the hook script then denies),
// and the delivery receipt reports false.
import { mkdtempSync, realpathSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CodexHookGate } from './codex-hook.ts';
import { consumingFixture } from '../testing/consuming-fixture.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { watchEscapes } from '../testing/nativecrash-harness.ts';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

function wire(path: string, message: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path); let data = '';
    socket.setEncoding('utf8'); socket.on('data', chunk => { data += chunk; });
    socket.once('connect', () => socket.write(JSON.stringify(message) + '\n'));
    socket.once('error', reject); socket.once('close', () => resolve(data));
  });
}

it('codex hook: a fenced pretool answer closes the socket with no answer and reports the receipt false (:780)', async () => {
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'nc-hook-'))); cleanups.push(() => removeTempDir(dir));
  const f = consumingFixture(undefined, { threadId: 'nc-hook' }); cleanups.push(() => f.close());
  const gate = new CodexHookGate(join(dir, 'g.sock')); await gate.listen(); cleanups.push(() => { gate.close(); gate.release(); });
  const receipts: boolean[] = [];
  gate.arm({ releaseBinding: f.binding, token: 'tok', onSession() {}, onPreTool: async () => ({ decision: 'allow', onTransport: (ok: boolean) => { receipts.push(ok); } }) });
  f.replace();
  expect(await wire(gate.path, { kind: 'pretool', token: 'tok', tool_use_id: 'one' })).toBe('');
  expect(receipts).toEqual([false]);
  expect(watch.escaped).toEqual([]);
});
