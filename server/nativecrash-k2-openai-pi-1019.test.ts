// SPDX-License-Identifier: AGPL-3.0-or-later
// K2 (nativecrash stage 2, M13) for the pi driver: the binding's refusal handler is a REAL lease (testing/nativecrash-k2.ts), not a stub.
// PIL: a bound turn whose child exits non-zero mid-turn is a lease-only refusal; the lease wins the closer, the driver's closeTurn joins it
// (lease mode: no terminal of its own), the lease's one interrupt (K3) runs the fallback close, and the K2 backstop holds.
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ensureDirs } from './config.ts';
import { PiDriver } from './drivers/pi.ts';
import { recordEvents } from './testing/events.ts';
import { OpenAICompatDriver } from './drivers/openai-compat.ts';
import { createMcpMountAdmission } from './drivers/mcp-mounts.ts';
import { InternalCapabilities } from './internal-capabilities.ts';
import { createProxyReleaseAuthority } from './consuming-turn-ingress.ts';
import { consumingFixture } from './testing/consuming-fixture.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
import { fixtureBoundTurn, fixtureMountTurn } from './testing/mcp-admission-fixture.ts';
import { fixtureBotFolder } from './testing/bot-folder-fixture.ts';
import { watchEscapes } from './testing/nativecrash-harness.ts';
import { k2Check, k2Lease, k2Verdict } from '../testing/nativecrash-k2.ts';
import { stopCloseConfirmed, type ProviderInstance } from './contracts.ts';

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), 'testing', 'fake-pi-cli.ts');
let instance: ProviderInstance | undefined;
const cleanups: Array<() => unknown> = [];
beforeEach(() => { ensureDirs(); chmodSync(FAKE_CLI, 0o755); });
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); await instance?.dispose().catch(() => {}); instance = undefined; });

it('pi crash mid-turn: the real lease wins the closer, interruptTurn once, one R, no unjoined kind', async () => {
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  const rig = k2Lease();
  instance = await PiDriver.create({ instanceId: 'k2-pi', displayName: 'pi', environment: { FAKE_PI_MODE: 'crash-mid-turn' }, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const base = fixtureMountTurn({ cwd: fixtureBotFolder(), threadId: 'k2-pi', text: 'go' });
  // the lease reads its identity lazily: align it with the admitted binding (a re-identified binding would fail admission)
  const { botId, threadId, dispatchGeneration } = base.releaseBinding!.identity;
  Object.assign(rig.identity, { botId, threadId, dispatchGeneration });
  const releaseBinding = { ...base.releaseBinding!, onLedgerRefused: rig.lease.onLedgerRefused };
  const sent = await instance.adapter.sendTurn({ ...base, releaseBinding } as never);
  rig.lease.attach(sent.turnId); // the harness's handback: the lease's fallback close waits for the provider turn id
  await k2Check(rig, { closer: 'lease' });
  expect(watch.escaped).toEqual([]);
});

// openai K2 (M13): the binding's refusal handler is the REAL lease; the OpenAI fake is a scripted chat-completions stream, no network.
const enc = new TextEncoder();
const frame = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`;
const sse = (chunks: string[]) => { const q = [...chunks]; return new Response(new ReadableStream<Uint8Array>({ pull(c) { const n = q.shift(); if (n === undefined) c.close(); else c.enqueue(enc.encode(n)); } }, { highWaterMark: 0 }), { status: 200, headers: { 'content-type': 'text/event-stream' } }); };
const toolCall = () => sse([frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'fake_echo', arguments: '{"text":"a"}' } }] } }] }), frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }), 'data: [DONE]\n\n']);
const textStop = () => sse([frame({ choices: [{ delta: { content: 'done' } }] }), frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']);
const FAKE_MCP = String.raw`
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

/** The turn's session leaves `active` once the driver settled it. A state poll bounded by iterations (a failed assertion, never a timeout). */
async function sessionEnded(threadId: string): Promise<boolean> {
  for (let i = 0; i < 12000 && instance!.adapter.hasSession(threadId); i++) await new Promise(resolve => setTimeout(resolve, 1));
  return !instance!.adapter.hasSession(threadId);
}

async function openaiRig(threadId: string, replies: Array<() => Response>, on: 'turn.started' | 'tool', hook: (x: { f: ReturnType<typeof consumingFixture>; rig: ReturnType<typeof k2Lease> }) => void, held?: Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'k2-oai-')); cleanups.push(() => removeTempDirSync(dir));
  const script = join(dir, 'fake-mcp.mjs'); writeFileSync(script, FAKE_MCP);
  const previousFetch = globalThis.fetch; cleanups.push(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.endsWith('/chat/completions')) return new Response('not found', { status: 404 });
    return (replies.shift() ?? textStop)();
  }) as typeof globalThis.fetch;
  const watch = watchEscapes(); cleanups.push(() => watch.stop());
  instance = await OpenAICompatDriver.create({ instanceId: threadId, displayName: 'NC', environment: {}, enabled: true,
    config: OpenAICompatDriver.decodeConfig({ url: 'https://compat.invalid/v1', key: 'fixture-credential', model: 'test-model' }) });
  const f = consumingFixture(undefined, { threadId }); cleanups.push(() => f.close());
  const caps = new InternalCapabilities(); caps.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  const rig = k2Lease({ interrupt: async () => { await held; return stopCloseConfirmed(await instance!.adapter.interruptTurn(threadId)) === true; } });
  const { botId, threadId: tid, dispatchGeneration } = f.binding.identity;
  Object.assign(rig.identity, { botId, threadId: tid, dispatchGeneration });
  const binding = { ...f.binding, onLedgerRefused: rig.lease.onLedgerRefused };
  const admission = createMcpMountAdmission(binding, createProxyReleaseAuthority(caps), 'http://127.0.0.1:1'); cleanups.push(() => admission.dispose());
  const recorder = recordEvents(instance.adapter); cleanups.push(() => recorder.stop());
  const off = instance.adapter.onEvent(e => {
    if (e.type === 'request.opened') void instance!.adapter.respondToRequest(threadId, (e as unknown as { requestId: string }).requestId, { behavior: 'allow' });
    if (on === 'turn.started' ? e.type === 'turn.started' : e.type === 'item.completed' && (e as unknown as { itemType: string }).itemType === 'tool') hook({ f, rig });
  }); cleanups.push(off as () => unknown);
  const sent = await instance.adapter.sendTurn(fixtureBoundTurn({ threadId, text: 'go', cwd: fixtureBotFolder(), releaseBinding: binding, mountAdmission: admission,
    integrations: { custom: { fake: { command: process.execPath, args: [script], env: {} } } } } as never));
  rig.lease.attach(sent.turnId);
  return { watch, rig, recorder, sent };
}

// K2 openai, OA3 with the real lease: the binding is revoked after the tool call (a Tl revoke, raised outside any send-fence call), so
// the lease wins the closer at once; the driver's own openai.append claim joins it. One R, one interruptTurn (K3), no terminal of the driver's own.
it('openai K2: a revoke at the tool-result append is a Tl revoke, the lease wins the closer, the driver joins', async () => {
  const x = await openaiRig('k2-oai-d', [toolCall, textStop], 'tool', ({ f }) => f.replace());
  expect(await sessionEnded('k2-oai-d'), 'the driver settled its own turn when the lease won the closer').toBe(true);
  await k2Check(x.rig, { closer: 'lease' });
  expect(x.rig.refusals().map(r => r.site), 'the lease R carries the lease site; the driver close joined it').toEqual(['lease.ledger']);
  expect(x.recorder.events.filter(e => e.type === 'turn.completed' && e.turnId === x.sent.turnId)).toEqual([]);
  expect(x.watch.escaped).toEqual([]);
});

// K2 openai, lease case: a lease-only refusal (no driver claim, ctx target null) wins the closer at once; the driver's close joins it
// and the lease's one interrupt reaches the driver's fallback close (K3 = 1).
it('openai K2: a lease-only refusal wins the closer, one interruptTurn, the driver close joins it', async () => {
  const x = await openaiRig('k2-oai-l', [toolCall, textStop], 'tool', ({ rig }) => { rig.lease.onLedgerRefused(k2Verdict); });
  expect(x.recorder.events.filter(e => e.type === 'turn.completed' && e.turnId === x.sent.turnId), 'lease mode: the driver emits no terminal of its own').toEqual([]);
  expect(await sessionEnded('k2-oai-l'), 'the driver settled its own turn when the lease won the closer').toBe(true);
  await k2Check(x.rig, { closer: 'lease' });
  expect(x.watch.escaped).toEqual([]);
});

// K2 openai, OAP late-end (P1 ATTACH at the turn's settle): a lease-only refusal lands mid-turn and the lease's fallback interrupt is still
// held when the model's answer ends on its own. The driver's natural end finds the lease's R by the turn's captured dispatch generation:
// the turn settles (session gone) with no terminal of its own, never a second, successful turn.completed beside the lease's refusal.
it('openai K2: a turn that ends on its own after a lease-only refusal emits no terminal of its own (OAP late-end)', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const x = await openaiRig('k2-oai-e', [toolCall, textStop], 'tool', ({ rig }) => { rig.lease.onLedgerRefused(k2Verdict); }, held);
  expect(await sessionEnded('k2-oai-e'), 'the turn ended on its own while the lease interrupt was held').toBe(true);
  expect(x.rig.calls.interrupt, 'the lease interrupt was entered and is held').toBe(1);
  expect(x.recorder.events.filter(e => e.type === 'turn.completed' && e.turnId === x.sent.turnId), 'lease mode: the natural end emits no terminal').toEqual([]);
  release();
  await k2Check(x.rig, { closer: 'lease' });
  expect(x.recorder.events.filter(e => e.type === 'turn.completed' && e.turnId === x.sent.turnId), 'no terminal after the close either').toEqual([]);
  expect(x.watch.escaped).toEqual([]);
});
