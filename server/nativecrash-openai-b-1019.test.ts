// SPDX-License-Identifier: AGPL-3.0-or-later
// Nativecrash stage 2, openai rows OAM / LLD-openai / LLI-openai (owner: G4 split seat).
//   OAM: a refused turn's close only WAITS for its MCP children (never kills first). A child tree that outlives the stop gives an
//        unconfirmed close (timeout); the turn's terminal and R.late come only with the late confirmed close.
//   LLD-openai: a lease refusal thrown into the round task outside a fence call (no request) is claimed by the outer catch as
//        "openai.direct.1542" with the captured turn as target (the driver closes); it never appears in an append (OA3) run.
//   LLI-openai: interruptTurn is the lease's fallback only: K3 (0 calls when the driver won, 1 when the lease won), turnId identity.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ensureDirs } from './config.ts';
import { OpenAICompatDriver } from './drivers/openai-compat.ts';
import { createMcpMountAdmission } from './drivers/mcp-mounts.ts';
import { InternalCapabilities } from './internal-capabilities.ts';
import { createProxyReleaseAuthority } from './consuming-turn-ingress.ts';
import { consumingFixture } from './testing/consuming-fixture.ts';
import { fixtureBoundTurn } from './testing/mcp-admission-fixture.ts';
import { fixtureBotFolder } from './testing/bot-folder-fixture.ts';
import { recordEvents } from './testing/events.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
import { watchEscapes } from './testing/nativecrash-harness.ts';
import { FencedRefusal, fencedRefusals, unawaitedTeardowns } from './drivers/engine-input.ts';
import { k2Check, k2Lease, k2Verdict, type K2Lease } from '../testing/nativecrash-k2.ts';
import type { ProviderInstance } from './contracts.ts';

// A stdio MCP server with one tool. With FAKE_PIDS set, the first call starts a descendant in its own session that ignores SIGTERM and
// holds this server's stdout open: it is reparented away at once, so the server's own stop never reaches it (a held tree).
const FAKE_SERVER = String.raw`
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const LEAF = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); require('node:fs').appendFileSync(process.env.FAKE_PIDS, '\\n' + process.pid);";
const MID = "require('node:child_process').spawn(process.execPath, ['-e', process.env.FAKE_LEAF], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] }).unref();";
if (process.env.FAKE_PIDS) writeFileSync(process.env.FAKE_PIDS, String(process.pid));
let buf = '', held = false;
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { buf += chunk; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) handle(JSON.parse(l)); } });
process.stdin.on('end', () => process.exit(0));
function handle(m) {
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } });
  if (m.method === 'tools/call') {
    const reply = () => send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo' }] } });
    if (!process.env.FAKE_PIDS || held) return reply();
    held = true; spawn(process.execPath, ['-e', MID], { stdio: ['ignore', 'inherit', 'ignore'], env: { ...process.env, FAKE_LEAF: LEAF } });
    // answer only once the descendant recorded its pid (its SIGTERM handler is in place)
    const t = setInterval(() => { if (readFileSync(process.env.FAKE_PIDS, 'utf8').split('\n').length === 2) { clearInterval(t); reply(); } }, 20);
    return;
  }
}
`;
const enc = new TextEncoder();
const sse = (chunks: string[]) => { const q = [...chunks]; return new Response(new ReadableStream<Uint8Array>({ pull(c) { const n = q.shift(); if (n === undefined) c.close(); else c.enqueue(enc.encode(n)); } }, { highWaterMark: 0 }), { status: 200, headers: { 'content-type': 'text/event-stream' } }); };
const frame = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`;
const toolCall = () => sse([frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'fake_echo', arguments: '{"text":"a"}' } }] } }] }), frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }), 'data: [DONE]\n\n']);
const textStop = () => sse([frame({ choices: [{ delta: { content: 'done' } }] }), frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']);
const refusalError = () => Object.assign(new Error('the memory context was revoked'), { code: 'MEMORY_CONTEXT_REVOKED' });
const refusalsOf = (threadId: string) => fencedRefusals().filter((r): r is FencedRefusal => r instanceof FencedRefusal && r.threadId === threadId);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor<T>(read: () => T | undefined | false, what: string): Promise<T> {
  for (let i = 0; i < 1000; i++) { const v = read(); if (v) return v; await new Promise(r => setTimeout(r, 20)); }
  throw new Error(`never: ${what}`);
}
type Tool = { itemType?: string; requestId?: string };

let dir: string, script: string, previousFetch: typeof globalThis.fetch, instance: ProviderInstance | undefined;
const cleanups: Array<() => unknown> = [];
const stray = new Set<number>();
let replies: Array<() => Response> = [];
beforeEach(() => {
  ensureDirs(); dir = mkdtempSync(join(tmpdir(), 'nc-oab-')); script = join(dir, 'fake-mcp.mjs'); writeFileSync(script, FAKE_SERVER);
  previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.endsWith('/chat/completions')) return new Response('not found', { status: 404 });
    return (replies.shift() ?? textStop)();
  }) as typeof globalThis.fetch;
});
afterEach(async () => {
  globalThis.fetch = previousFetch;
  for (const pid of stray) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } } stray.clear();
  for (const c of cleanups.splice(0).reverse()) await c();
  await instance?.dispose().catch(() => {}); instance = undefined; removeTempDirSync(dir);
});

async function start(threadId: string, options: { env?: Record<string, string>; rig?: K2Lease } = {}) {
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  instance = await OpenAICompatDriver.create({ instanceId: threadId, displayName: 'NC', environment: {}, enabled: true,
    config: OpenAICompatDriver.decodeConfig({ url: 'https://compat.invalid/v1', key: 'test', model: 'test-model' }) });
  // with a rig, the binding's refusal handler is the REAL lease (the admitted binding object itself, never a copy)
  const f = consumingFixture(undefined, { threadId, ...(options.rig ? { onRefused: (verdict: Parameters<K2Lease['lease']['onLedgerRefused']>[0]) => options.rig!.lease.onLedgerRefused(verdict) } : {}) }); cleanups.push(() => f.close());
  const caps = new InternalCapabilities(); caps.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  const admission = createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), 'http://127.0.0.1:1');
  cleanups.push(() => admission.dispose());
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const releaseBinding = f.binding;
  if (options.rig) {
    // the real lease reads its identity lazily: align it with the admitted binding
    const { botId, dispatchGeneration } = f.binding.identity;
    Object.assign(options.rig.identity, { botId, threadId: f.binding.identity.threadId, dispatchGeneration });
  }
  const send = () => instance!.adapter.sendTurn(fixtureBoundTurn({ threadId, text: 'go', cwd: fixtureBotFolder(), releaseBinding, mountAdmission: admission,
    integrations: { custom: { fake: { command: process.execPath, args: [script], env: options.env ?? {} } } } } as never));
  const completed = (turnId: string) => recorder.events.filter(e => e.type === 'turn.completed' && e.turnId === turnId);
  return { f, watch, recorder, send, completed };
}
const allow = (threadId: string, e: unknown) => {
  const event = e as { type: string } & Tool;
  if (event.type === 'request.opened') void instance!.adapter.respondToRequest(threadId, event.requestId!, { behavior: 'allow' });
};
const toolDone = (e: unknown) => (e as { type: string } & Tool).type === 'item.completed' && (e as Tool).itemType === 'tool';

it('OAM: a refused turn whose MCP tree outlives the stop closes unconfirmed (timeout), is never killed by the refusal, and confirms late', async () => {
  const before = process.env.MURAGE_PROVIDER_CLOSE_MS; process.env.MURAGE_PROVIDER_CLOSE_MS = '1000';
  cleanups.push(() => { if (before === undefined) delete process.env.MURAGE_PROVIDER_CLOSE_MS; else process.env.MURAGE_PROVIDER_CLOSE_MS = before; });
  replies = [toolCall, textStop];
  const pids = join(dir, 'pids.txt');
  const x = await start('nc-oam', { env: { FAKE_PIDS: pids } });
  const off = instance!.adapter.onEvent(e => { allow('nc-oam', e); if (toolDone(e)) x.f.replace(); }); cleanups.push(off as () => unknown);
  const sent = await x.send();
  const R = await waitFor(() => refusalsOf('nc-oam')[0], 'the append refusal');
  const result = await R.teardown;
  const held = Number(readFileSync(pids, 'utf8').split('\n')[1]); stray.add(held);
  expect(result, 'the one close waited its budget and did not confirm').toEqual({ confirmed: false, reason: 'timeout' });
  expect([R.site, R.closer]).toEqual(['openai.append', 'driver']);
  expect(alive(held), 'the refusal only waits: the held descendant was never killed').toBe(true);
  expect(R.lateConfirmedAt, 'not confirmed late yet').toBeNull();
  expect(x.completed(sent.turnId), 'the terminal waits for the confirmed close').toHaveLength(0);
  expect(await instance!.adapter.awaitTurnTeardown!('nc-oam', sent.turnId)).toMatchObject({ closeConfirmed: false });
  // release: the held descendant ends, the tree is confirmed stopped, R.late resolves
  process.kill(held, 'SIGKILL');
  await R.late;
  expect(R.lateConfirmedAt, 'late confirmation is recorded in place').not.toBeNull();
  const ended = await x.recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId);
  expect(ended).toMatchObject({ ok: false, stopReason: 'memory-refused' });
  await new Promise(r => setTimeout(r, 100));
  expect(x.completed(sent.turnId), 'one terminal').toHaveLength(1);
  expect(await instance!.adapter.awaitTurnTeardown!('nc-oam', sent.turnId)).toEqual({ closeConfirmed: true });
  expect(refusalsOf('nc-oam'), 'one R').toHaveLength(1);
  expect(x.watch.escaped).toEqual([]);
});

it('LLD-openai: a lease refusal thrown into the round task outside a fence call is claimed at openai.direct.1542 and closed by the driver', async () => {
  replies = [toolCall, textStop];
  const x = await start('nc-lld');
  let thrown = false;
  const off = instance!.adapter.onEvent(e => {
    allow('nc-lld', e);
    // the harness listener refuses (lease revoke) while the driver emits: no request, no fence call
    if (toolDone(e) && !thrown) { thrown = true; throw refusalError(); }
  }); cleanups.push(off as () => unknown);
  const sent = await x.send();
  const ended = await x.recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId);
  expect(ended).toMatchObject({ ok: false, stopReason: 'memory-refused' });
  const mine = refusalsOf('nc-lld');
  expect(mine.map(r => [r.site, r.joins, r.kind, r.closer]), 'one R, named by the direct backstop, closed by the driver').toEqual([['openai.direct.1542', [], 'turn', 'driver']]);
  expect(await mine[0]!.teardown).toEqual({ confirmed: true });
  expect(x.completed(sent.turnId), 'one terminal').toHaveLength(1);
  expect(unawaitedTeardowns().filter(r => r.threadId === 'nc-lld')).toEqual([]);
  expect(x.watch.escaped).toEqual([]);
});

it('LLI-openai K3 (driver won): a direct refusal claimed before the lease hears of it is closed by the driver; the lease never calls interruptTurn', async () => {
  replies = [toolCall, textStop];
  let turnId = '', thrown = false;
  const rig = k2Lease({ interrupt: () => instance!.adapter.interruptTurn('nc-lli-d', turnId).then(() => true, () => false) });
  const x = await start('nc-lli-d', { rig });
  const off = instance!.adapter.onEvent(e => { allow('nc-lli-d', e); if (toolDone(e) && !thrown) { thrown = true; throw refusalError(); } }); cleanups.push(off as () => unknown);
  const sent = await x.send(); turnId = sent.turnId; rig.lease.attach(sent.turnId);
  const ended = await x.recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId);
  expect(ended).toMatchObject({ ok: false, stopReason: 'memory-refused' });
  await k2Check(rig, { closer: 'driver' });
  const [R] = rig.refusals();
  expect(R!.site, 'the captured turn was the target: the driver closes, not the lease').toBe('openai.direct.1542');
  expect(x.completed(sent.turnId), 'one terminal').toHaveLength(1);
  expect(x.watch.escaped).toEqual([]);
});

it('LLI-openai K3 (lease won first, append): the fence pokes the lease, the append claim joins, interruptTurn once, no driver terminal, no direct literal', async () => {
  replies = [toolCall, textStop];
  let turnId = '';
  const rig = k2Lease({ interrupt: () => instance!.adapter.interruptTurn('nc-lli-a', turnId).then(() => true, () => false) });
  const x = await start('nc-lli-a', { rig });
  const off = instance!.adapter.onEvent(e => { allow('nc-lli-a', e); if (toolDone(e)) x.f.replace(); }); cleanups.push(off as () => unknown);
  const sent = await x.send(); turnId = sent.turnId; rig.lease.attach(sent.turnId);
  await k2Check(rig, { closer: 'lease' });
  const [R] = rig.refusals();
  expect([R!.site, R!.joins], 'LLD-openai: the direct backstop is absent from an append run').toEqual(['lease.ledger', ['openai.append']]);
  expect(await R!.teardown, 'the fallback close confirmed').toEqual({ confirmed: true });
  await new Promise(r => setTimeout(r, 200));
  expect(x.completed(sent.turnId), 'lease mode: the driver emits no terminal').toHaveLength(0);
  expect(x.watch.escaped).toEqual([]);
});

it('LLI-openai K3 (lease won): a ledger revoke outside a fence call is closed through interruptTurn once; the driver emits no terminal', async () => {
  replies = [toolCall, textStop];
  let turnId = '';
  const rig = k2Lease({ interrupt: () => instance!.adapter.interruptTurn('nc-lli-l', turnId).then(() => true, () => false) });
  const x = await start('nc-lli-l', { rig });
  const sent = await x.send(); turnId = sent.turnId; rig.lease.attach(sent.turnId);
  await x.recorder.until(e => e.type === 'request.opened' && e.turnId === sent.turnId);
  rig.lease.onLedgerRefused(k2Verdict);
  await k2Check(rig, { closer: 'lease' });
  const [R] = rig.refusals();
  expect([R!.site, R!.joins]).toEqual(['lease.ledger', []]);
  expect(await R!.teardown, 'the fallback close confirmed').toEqual({ confirmed: true });
  await new Promise(r => setTimeout(r, 200));
  expect(x.completed(sent.turnId), 'lease mode: the lease owns the one terminal, the driver emits none').toHaveLength(0);
  expect(x.watch.escaped).toEqual([]);
});

it('LLI-openai identity: interruptTurn for another turn id never stops the running turn', async () => {
  replies = [toolCall, textStop];
  const x = await start('nc-lli-i');
  let stale: unknown = 'not called';
  const off = instance!.adapter.onEvent(e => {
    if ((e as { type: string }).type !== 'request.opened') return;
    // a lease fallback of an older turn arrives while this turn waits on its card
    void instance!.adapter.interruptTurn('nc-lli-i', 'turn-of-an-older-lease').then(r => { stale = r; allow('nc-lli-i', e); }, error => { stale = error; allow('nc-lli-i', e); });
  }); cleanups.push(off as () => unknown);
  const sent = await x.send();
  const ended = await x.recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId);
  expect(ended, 'the running turn was not stopped by a stale turn id').toMatchObject({ ok: true });
  expect((ended as { stopReason?: unknown }).stopReason, 'not ended as a Stop').not.toBe('cancelled');
  expect(x.recorder.events.some(toolDone), 'the tool call still ran').toBe(true);
  expect(stale).toMatchObject({ closeConfirmed: true });
  expect(refusalsOf('nc-lli-i')).toEqual([]);
  expect(x.watch.escaped).toEqual([]);
});
