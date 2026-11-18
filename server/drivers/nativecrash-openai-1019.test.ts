// SPDX-License-Identifier: AGPL-3.0-or-later
// RED-ONLY witness (cl-nativecrash): openai-chat respondToRequest (:1720) releases the owner's decision through the consuming fence.
// The turn's binding is revoked while a tool card is open; the decision answer then throws EngineInputRevoked after the pending
// entry was already deleted. The call must not reject (an uncontained caller turns it into a fatal unhandledRejection) and the
// turn must end in a defined terminal refusal instead of waiting for an answer that was never delivered.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ensureDirs } from '../config.ts';
import { OpenAICompatDriver } from './openai-compat.ts';
import { createMcpMountAdmission } from './mcp-mounts.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { createProxyReleaseAuthority } from '../consuming-turn-ingress.ts';
import { consumingFixture } from '../testing/consuming-fixture.ts';
import { fixtureBoundTurn } from '../testing/mcp-admission-fixture.ts';
import { fixtureBotFolder } from '../testing/bot-folder-fixture.ts';
import { recordEvents } from '../testing/events.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { expectDefinedRefusal, expectMemoryRefused, watchEscapes } from '../testing/nativecrash-harness.ts';
import { FencedRefusal, fencedRefusals, unawaitedTeardowns } from './engine-input.ts';
import type { ProviderInstance, SendTurnInput } from '../contracts.ts';

const FAKE_SERVER = String.raw`
let buf = '';
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { buf += chunk; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) handle(JSON.parse(l)); } });
process.stdin.on('end', () => process.exit(0));
function handle(m) {
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } });
  if (m.method === 'tools/call') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo' }] } });
}
`;
const enc = new TextEncoder();
const sse = (chunks: string[]) => { const q = [...chunks]; return new Response(new ReadableStream<Uint8Array>({ pull(c) { const n = q.shift(); if (n === undefined) c.close(); else c.enqueue(enc.encode(n)); } }, { highWaterMark: 0 }), { status: 200, headers: { 'content-type': 'text/event-stream' } }); };
const frame = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`;
const toolCall = () => sse([frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'fake_echo', arguments: '{"text":"a"}' } }] } }] }), frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }), 'data: [DONE]\n\n']);
const textStop = () => sse([frame({ choices: [{ delta: { content: 'done' } }] }), frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']);

/** K1/K3/I6 for one claim: the thread's one R names the site, the driver closed it (confirmed), no teardown is left unawaited. */
async function expectOneClaim(threadId: string, site: string): Promise<FencedRefusal> {
  const mine = fencedRefusals().filter((r): r is FencedRefusal => r instanceof FencedRefusal && r.threadId === threadId);
  expect(mine.map(r => r.site), 'one R for the refused turn').toEqual([site]);
  expect(mine[0]!.closer, 'the driver won the closer check').toBe('driver');
  expect(await mine[0]!.teardown, 'the one close confirmed').toEqual({ confirmed: true });
  expect(unawaitedTeardowns().filter(r => r.threadId === threadId)).toEqual([]);
  return mine[0]!;
}
let dir: string, script: string, previousFetch: typeof globalThis.fetch, instance: ProviderInstance | undefined;
const cleanups: Array<() => unknown> = [];
let replies: Array<() => Response> = [];
beforeEach(() => {
  ensureDirs(); dir = mkdtempSync(join(tmpdir(), 'nc-oai-')); script = join(dir, 'fake-mcp.mjs'); writeFileSync(script, FAKE_SERVER);
  previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.endsWith('/chat/completions')) return new Response('not found', { status: 404 }); // catalog refresh never consumes a scripted reply
    return (replies.shift() ?? textStop)();
  }) as typeof globalThis.fetch;
});
afterEach(async () => {
  globalThis.fetch = previousFetch;
  for (const c of cleanups.splice(0).reverse()) await c();
  await instance?.dispose(); instance = undefined; removeTempDirSync(dir);
});

it('openai-chat respondToRequest on a revoked turn neither rejects nor leaves the turn open (:1720)', async () => {
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  replies = [toolCall, textStop];
  instance = await OpenAICompatDriver.create({ instanceId: 'nc-oai', displayName: 'NC', environment: {}, enabled: true,
    config: OpenAICompatDriver.decodeConfig({ url: 'https://compat.invalid/v1', key: 'fixture-credential', model: 'test-model' }) });
  const f = consumingFixture(undefined, { threadId: 'nc-oai' }); cleanups.push(() => f.close());
  const caps = new InternalCapabilities(); caps.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  const admission = createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), 'http://127.0.0.1:1');
  cleanups.push(() => admission.dispose());
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const sent = await instance.adapter.sendTurn(fixtureBoundTurn({ threadId: 'nc-oai', text: 'go', cwd: fixtureBotFolder(), releaseBinding: f.binding, mountAdmission: admission,
    integrations: { custom: { fake: { command: process.execPath, args: [script], env: {} } } } } as never));
  const opened = await recorder.until(e => e.type === 'request.opened' && e.turnId === sent.turnId) as unknown as { requestId: string };
  f.replace();
  let threw: unknown;
  await instance.adapter.respondToRequest('nc-oai', opened.requestId, { behavior: 'allow' }).catch(error => { threw = error; });
  let ended: unknown = 'turn left open (no turn.completed within the recorder ceiling)';
  try { ended = await recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId); } catch (error) { ended = String((error as Error).message).slice(0, 300); }
  expect.soft(threw, 'respondToRequest rejected with the fenced reply (uncontained caller: unhandledRejection)').toBeUndefined();
  expect.soft(watch.escaped).toEqual([]);
  expect(ended, 'the turn must end in a defined terminal refusal').toMatchObject({ type: 'turn.completed', ok: false, stopReason: 'memory-refused' });
  expect(recorder.events.filter(e => e.type === 'turn.completed' && e.turnId === sent.turnId), 'one terminal').toHaveLength(1);
  await expectOneClaim('nc-oai', 'openai.decision');
});

async function start(threadId: string, url = 'https://compat.invalid/v1', shape: (turn: SendTurnInput, f: ReturnType<typeof consumingFixture>) => SendTurnInput = turn => turn,
  onRefused?: () => void) {
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  instance = await OpenAICompatDriver.create({ instanceId: threadId, displayName: 'NC', environment: {}, enabled: true,
    config: OpenAICompatDriver.decodeConfig({ url, key: 'fixture-credential', model: 'test-model' }) });
  const f = consumingFixture(undefined, { threadId, ...(onRefused ? { onRefused } : {}) }); cleanups.push(() => f.close());
  const caps = new InternalCapabilities(); caps.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  const admission = createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), 'http://127.0.0.1:1');
  cleanups.push(() => admission.dispose());
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const send = () => instance!.adapter.sendTurn(shape(fixtureBoundTurn({ threadId, text: 'go', cwd: fixtureBotFolder(), releaseBinding: f.binding, mountAdmission: admission,
    integrations: { custom: { fake: { command: process.execPath, args: [script], env: {} } } } } as never), f));
  return { f, watch, recorder, send };
}

// OASUB (p): the first round's request write is refused by the submission boundary (the binding is revoked as the turn starts).
it('openai-chat first-round prompt write on a revoked turn is a submission refusal (:784)', async () => {
  replies = [textStop];
  const x = await start('nc-oai-w');
  const off = instance!.adapter.onEvent(e => { if (e.type === 'turn.started') x.f.replace(); }); cleanups.push(off as () => unknown);
  const sent = await x.send();
  await expectDefinedRefusal(x.recorder, x.watch, sent.turnId);
  expect(x.recorder.events.filter(e => e.type === 'turn.completed' && e.turnId === sent.turnId)).toMatchObject([{ ok: false, stopReason: 'submission_refused' }]);
  const R = await expectOneClaim('nc-oai-w', 'openai.prompt');
  expect(R.kind, 'a submission refusal never creates a turn-kind R').toBe('submission');
});

// OA3: the tool result append is refused after the call ran (revoked once the tool item completes).
it('openai-chat tool-result append on a revoked turn ends memory-refused, one claim at openai.append (:1532)', async () => {
  replies = [toolCall, textStop];
  const x = await start('nc-oai-t');
  const rec = recordEvents(instance!.adapter); cleanups.push(() => rec.stop());
  instance!.adapter.onEvent(e => {
    if (e.type === 'request.opened') void instance!.adapter.respondToRequest('nc-oai-t', (e as unknown as { requestId: string }).requestId, { behavior: 'allow' });
    if (e.type === 'item.completed' && (e as unknown as { itemType: string }).itemType === 'tool') x.f.replace();
  });
  const sent = await x.send();
  await expectMemoryRefused(rec, x.watch, sent.turnId);
  await expectOneClaim('nc-oai-t', 'openai.append');
});

// OA-ABORT: a Stop that lands while the tool call runs ends the turn as Stop. The interrupted result is never appended (that write is
// refused once the Stop's mount teardown revoked the binding), so the user's Stop is not claimed as memory-refused.
it('openai-chat Stop during a tool call whose binding is revoked ends cancelled, no refusal claimed (:1574)', async () => {
  replies = [toolCall, textStop];
  const x = await start('nc-oai-s');
  instance!.adapter.onEvent(e => {
    if (e.type === 'request.opened') void instance!.adapter.respondToRequest('nc-oai-s', (e as unknown as { requestId: string }).requestId, { behavior: 'allow' });
    if (e.type === 'item.completed' && (e as unknown as { itemType: string }).itemType === 'tool') { x.f.replace(); void instance!.adapter.interruptTurn('nc-oai-s'); }
  });
  const sent = await x.send();
  const ended = await x.recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId);
  expect(ended).toMatchObject({ type: 'turn.completed', stopReason: 'cancelled' });
  expect(x.watch.escaped).toEqual([]);
  expect(x.recorder.events.filter(e => e.type === 'turn.completed' && e.turnId === sent.turnId), 'one terminal').toHaveLength(1);
  expect(fencedRefusals().filter(r => r instanceof FencedRefusal && r.threadId === 'nc-oai-s'), 'the Stop is not claimed as a refusal').toEqual([]);
});

const refusalError = () => Object.assign(new Error('the memory context was revoked'), { code: 'MEMORY_CONTEXT_REVOKED' });
// OASUB (s) / M16: a steer spliced between rounds is refused QUOTE-ONLY (the lease is still valid): the steer alone is refused (resolves
// "rejected", one R of kind submission at openai.steer), the turn is not ended and no turn-kind R exists.
it('openai-chat quote-only steer refusal rejects the steer alone and the turn runs on (M16)', async () => {
  replies = [toolCall, textStop];
  const x = await start('nc-oai-q');
  let steered: Promise<unknown> | undefined;
  const off = instance!.adapter.onEvent(e => {
    if (e.type === 'request.opened') {
      steered = instance!.adapter.steer!('nc-oai-q', 'quoted', () => { throw refusalError(); });
      void instance!.adapter.respondToRequest('nc-oai-q', (e as unknown as { requestId: string }).requestId, { behavior: 'allow' });
    }
  }); cleanups.push(off as () => unknown);
  const sent = await x.send();
  const ended = await x.recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId);
  expect(ended).toMatchObject({ ok: true });
  expect(await steered).toBe('rejected');
  expect(x.watch.escaped).toEqual([]);
  const mine = fencedRefusals().filter((r): r is FencedRefusal => r instanceof FencedRefusal && r.threadId === 'nc-oai-q');
  expect(mine.map(r => [r.site, r.kind]), 'one steer-scoped R, never a turn kind').toEqual([['openai.steer', 'submission']]);
  expect(unawaitedTeardowns().filter(r => r.threadId === 'nc-oai-q')).toEqual([]);
});

// OA2 (a): the request preflight (openai:fetch, completeWithin) refuses the round's request. The binding is revoked after the submission
// boundary passed (beforeSubmit returned) and before the preflight, so the refusal reaches the round's catch as the refusal itself.
// Writer: preflightNativeRequest -> the round catch -> claimRefusal "openai.fetch".
it('openai-chat request preflight on a revoked turn ends memory-refused, one claim at openai.fetch (OA2 a)', async () => {
  replies = [textStop];
  const x = await start('nc-oai-f', undefined, (turn, f) => ({ ...turn, beforeSubmit: () => { turn.beforeSubmit?.(); f.replace(); } }));
  const sent = await x.send();
  await expectMemoryRefused(x.recorder, x.watch, sent.turnId);
  expect(x.recorder.events.filter(e => e.type === 'turn.completed' && e.turnId === sent.turnId), 'one terminal').toHaveLength(1);
  expect(x.recorder.events.filter(e => e.type === 'turn.retrying' && e.turnId === sent.turnId), 'a refusal is never retried').toEqual([]);
  await expectOneClaim('nc-oai-f', 'openai.fetch');
});

// OA2 (b): the refusal is raised by the connected socket's write (releaseNativeWire in the provider dispatcher), after the preflight passed:
// a real loopback endpoint, the binding revoked once fetch queued its connection. fetch then rejects with its own transport error and the
// refusal rides as that error's cause (and under the unreachable-endpoint rewrite). No request byte reaches the endpoint, the turn is
// never retried, and it ends memory-refused with one claim at openai.fetch.
it('openai-chat socket write on a revoked turn (refusal as the fetch error cause) ends memory-refused, one claim at openai.fetch (OA2 b)', async () => {
  const requests: string[] = [];
  const server = createServer(async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; requests.push(req.url ?? ''); res.end('{}'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const x = await start('nc-oai-c', `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.endsWith('/chat/completions')) return Promise.resolve(new Response('not found', { status: 404 }));
    const sending = previousFetch(input, init); // the real transport: connection setup is queued, no byte is written yet
    x.f.replace();
    return sending;
  }) as typeof globalThis.fetch;
  const sent = await x.send();
  await expectMemoryRefused(x.recorder, x.watch, sent.turnId);
  expect(requests.filter(url => url.endsWith('/chat/completions')), 'no request reached the endpoint').toEqual([]);
  expect(x.recorder.events.filter(e => e.type === 'turn.completed' && e.turnId === sent.turnId), 'one terminal').toHaveLength(1);
  expect(x.recorder.events.filter(e => e.type === 'turn.retrying' && e.turnId === sent.turnId), 'a refusal is never retried').toEqual([]);
  expect(x.recorder.events.filter(e => e.type === 'runtime.error' && e.turnId === sent.turnId), 'a refusal is not shown as an unreachable endpoint').toEqual([]);
  await expectOneClaim('nc-oai-c', 'openai.fetch');
});

// OAP (Stop after claim, abort during claim) on OA1 (decision), OA3 (append) and OA2 (a) (fetch preflight). The user's Stop that lands while the driver's
// claim is closing the turn (abort during claim: the ledger verdict callback runs between the claim and its close), or after the refused
// turn already ended (Stop after claim), never turns the refusal into a Stop: one terminal, memory-refused, the one R closed by the driver,
// and the Stop itself resolves without throwing.
const oapRows: Array<[string, string, string, (x: Awaited<ReturnType<typeof start>>) => void, Parameters<typeof start>[2]]> = [
  ['OA3', 'openai.append', 'nc-oap-t', x => instance!.adapter.onEvent(e => {
    if (e.type === 'request.opened') void instance!.adapter.respondToRequest(x.f.turn.threadId, (e as unknown as { requestId: string }).requestId, { behavior: 'allow' });
    if (e.type === 'item.completed' && (e as unknown as { itemType: string }).itemType === 'tool') x.f.replace();
  }), undefined],
  ['OA1', 'openai.decision', 'nc-oap-d', x => instance!.adapter.onEvent(e => {
    if (e.type === 'request.opened') { x.f.replace(); void instance!.adapter.respondToRequest(x.f.turn.threadId, (e as unknown as { requestId: string }).requestId, { behavior: 'allow' }); }
  }), undefined],
  ['OA2 a', 'openai.fetch', 'nc-oap-f', () => undefined, (turn, f) => ({ ...turn, beforeSubmit: () => { turn.beforeSubmit?.(); f.replace(); } })],
];
for (const [row, site, threadId, arm, shape] of oapRows) for (const when of ['abort during claim', 'Stop after claim'] as const) {
  it(`OAP ${when} on ${row}: the refusal stays the one terminal (memory-refused), the Stop resolves, one R at ${site}`, async () => {
    replies = row === 'OA2 a' ? [textStop] : [toolCall, textStop];
    let stopped: Promise<unknown> | undefined, closeRan!: (started: boolean[]) => void;
    const closeSeen = new Promise<boolean[]>(resolve => { closeRan = resolve; });
    const ownR = () => fencedRefusals().filter((r): r is FencedRefusal => r instanceof FencedRefusal && r.threadId === x.f.turn.threadId);
    const x = await start(`${threadId}-${when === 'abort during claim' ? 'a' : 's'}`, undefined, shape,
      when === 'abort during claim' ? () => {
        stopped ??= instance!.adapter.interruptTurn(x.f.turn.threadId);
        setImmediate(() => closeRan(ownR().map(r => r.teardownSettled)));
      } : undefined);
    arm(x);
    const sent = await x.send();
    // abort during claim: one tick after the Stop, the claim has already started its one close (it never yields to the Stop).
    if (when === 'abort during claim') expect(await closeSeen, 'the claim ran its one close (a Stop never makes the claim yield)').toEqual([true]);
    const ended = await x.recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId);
    if (when === 'Stop after claim') stopped = instance!.adapter.interruptTurn(x.f.turn.threadId, sent.turnId);
    expect(stopped, 'the Stop was asked').toBeDefined();
    await expect(stopped, 'the Stop resolves').resolves.toBeDefined();
    expect(ended, 'not ended as a Stop').toMatchObject({ ok: false, stopReason: 'memory-refused' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(x.recorder.events.filter(e => e.type === 'turn.completed' && e.turnId === sent.turnId), 'one terminal').toHaveLength(1);
    expect(x.watch.escaped).toEqual([]);
    await expectOneClaim(x.f.turn.threadId, site);
  });
}
