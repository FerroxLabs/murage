// SPDX-License-Identifier: AGPL-3.0-or-later
// RED-ONLY witnesses (cl-nativecrash): fenced native replies on the Claude permission broker (claude.ts answer() :941 and the
// receipt write :1024). The binding is revoked, then the broker must answer or retire every ask locally: no unhandledRejection /
// uncaughtException, and no ask left open with the engine's proxy waiting (permission-proxy only resolves on an answer or a close).
import { mkdtempSync, realpathSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createPermissionBroker } from './claude.ts';
import { consumingFixture } from '../testing/consuming-fixture.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { watchEscapes } from '../testing/nativecrash-harness.ts';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function rig() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'nc-cl-')));
  cleanups.push(() => removeTempDir(dir));
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  const f = consumingFixture(undefined, { threadId: 'nc-claude' }); cleanups.push(() => f.close());
  const asks: any[] = []; const resolved: any[] = [];
  const broker = await createPermissionBroker({ releaseBinding: f.binding, socketPaths: [join(dir, 'b.sock')], onAsk: a => asks.push(a), onResolve: r => resolved.push(r), isActive: () => true });
  cleanups.push(() => broker.close());
  const sock: Socket = connect(broker.socketPath); sock.on('error', () => {});
  cleanups.push(() => sock.destroy());
  const received: string[] = []; let closed = false;
  sock.on('data', d => received.push(String(d))); sock.on('close', () => { closed = true; });
  await new Promise<void>(resolve => sock.once('connect', () => resolve()));
  const send = (m: unknown) => new Promise<void>(resolve => sock.write(JSON.stringify(m) + '\n', () => resolve()));
  const askArrived = (id: string) => new Promise<void>(resolve => { const poll = () => (asks.some(a => a.id === id) ? resolve() : setImmediate(poll)); poll(); });
  return { f, broker, asks, resolved, watch, send, askArrived, received, isClosed: () => closed };
}

// answer() :941 via the unshowable-question branch (:1008, swallowed by try/catch): the reply is fenced, nothing reaches the proxy.
it('claude broker: a fenced unshowable-question denial does not leave the engine proxy waiting', async () => {
  const x = await rig();
  x.f.replace();
  await x.send({ t: 'ask', id: 'q-bad', kind: 'question', tool: 'AskUserQuestion', input: { questions: 'not-an-array' } });
  // ordered behind it on the same connection: once this ask is surfaced the first line has been fully handled
  await x.send({ t: 'ask', id: 'p-after', kind: 'permission', tool: 'Bash', input: { command: 'ls' } });
  await x.askArrived('p-after');
  for (let i = 0; i < 200 && !(x.received.length > 0 || x.isClosed()); i++) await new Promise(resolve => setImmediate(resolve));
  expect.soft(x.watch.escaped).toEqual([]);
  expect(x.received.length > 0 || x.isClosed(), 'ask q-bad got neither a local deny nor a closed connection: the proxy waits forever').toBe(true);
});

// finish() :1024: an owner answer on a revoked binding. The receipt fails closed; the ask must resolve as a local deny.
it('claude broker: a fenced owner answer resolves the ask as an unavailable deny', async () => {
  const x = await rig();
  await x.send({ t: 'ask', id: 'p-1', kind: 'permission', tool: 'Bash', input: { command: 'ls' } });
  await x.askArrived('p-1');
  x.f.replace();
  expect(x.broker.answer('p-1', 'allow')).toBe(true);
  for (let i = 0; i < 200 && !x.resolved.some(r => r.id === 'p-1'); i++) await new Promise(resolve => setImmediate(resolve));
  expect(x.watch.escaped).toEqual([]);
  expect(x.resolved.find(r => r.id === 'p-1')).toMatchObject({ behavior: 'deny', source: 'unavailable' });
  expect(x.received.join('')).not.toContain('"allow"');
});
