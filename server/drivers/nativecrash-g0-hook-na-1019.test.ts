// SPDX-License-Identifier: AGPL-3.0-or-later
// G0-HK / G0-NA witnesses (nativecrash stage 2): the claim reaches the consumer BEFORE the transport receipt, and a refused native
// write is told to the caller BEFORE the ask is committed.
import { mkdtempSync, realpathSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CodexHookGate } from './codex-hook.ts';
import { deliverNative, type NativeAskSlot } from './native-ask.ts';
import { consumingFixture } from '../testing/consuming-fixture.ts';
import { removeTempDir } from '../testing/cleanup.ts';

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

it('G0-HK: onFencedRefusal(e, socket) runs before the transport receipt, and the receipt carries the error', async () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'nc-hk-'))); cleanups.push(() => removeTempDir(dir));
  const f = consumingFixture(undefined, { threadId: 'nc-hk' }); cleanups.push(() => f.close());
  const gate = new CodexHookGate(join(dir, 'g.sock')); await gate.listen(); cleanups.push(() => { gate.close(); gate.release(); });
  const order: string[] = []; let claimed: unknown; let receiptError: unknown; let socketSeen = false;
  gate.arm({
    releaseBinding: f.binding, token: 'tok', onSession() {},
    onFencedRefusal(e: unknown, socket: net.Socket) { order.push('claim'); claimed = e; socketSeen = socket instanceof net.Socket; },
    onPreTool: async () => ({ decision: 'allow', onTransport: (_ok: boolean, e?: unknown) => { order.push('receipt'); receiptError = e; } }),
  });
  f.replace();
  expect(await wire(gate.path, { kind: 'pretool', token: 'tok', tool_use_id: 'one' })).toBe('');
  expect(order).toEqual(['claim', 'receipt']);
  expect([socketSeen, claimed !== undefined, receiptError === claimed]).toEqual([true, true, true]);
});

it('G0-NA: refused(e) runs before commit(false), and writing resolves after the refused teardown', async () => {
  const slot: NativeAskSlot = { closed: false };
  const order: string[] = []; const refusal = Object.assign(new Error('r'), { code: 'MEMORY_CONTEXT_REVOKED' });
  let teardownDone = false;
  const writing = deliverNative(slot, 'answer', 'k', async () => { throw refusal; }, () => true,
    ok => { order.push(`commit:${ok}`); }, () => true, undefined,
    e => { order.push(e === refusal ? 'refused' : 'refused:wrong'); return new Promise<void>(r => setTimeout(() => { teardownDone = true; r(); }, 5)); });
  expect(await writing).toBe(false);
  expect(order).toEqual(['refused', 'commit:false']);
  expect(teardownDone).toBe(true);
});

it('G0-NA: the helper never classifies: a failed write hands the error to refused, a successful write never does', async () => {
  const plain = new Error('plain'); let seen: unknown; let calls = 0;
  await deliverNative({ closed: false }, 'answer', 'k', async () => { throw plain; }, () => true, () => {}, () => true, undefined, e => { seen = e; calls++; });
  expect([seen, calls]).toEqual([plain, 1]);
  await deliverNative({ closed: false }, 'answer', 'k', async () => true, () => true, () => {}, () => true, undefined, () => { calls++; });
  expect(calls).toBe(1);
});
