// SPDX-License-Identifier: AGPL-3.0-or-later
// G1b witnesses (nativecrash stage 2, codex): CX5/CX6 a hook allow refused on the socket (revoke before the allow); CX3 a reopened native ask (hook allow, release held, refreshed card) answered after the turn was revoked.
// Same scenario as the no-limits cache replay (R10d changed) with a consuming turn binding; the card's deliverNative write throws EngineInputRevoked.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { fixture, d, baseRun } from './decision/fixture.ts';
import { CodexDriver } from './drivers/codex.ts';
import { resetIsolationCache } from './drivers/isolation-cache.ts';
import { consumingFixture } from './testing/consuming-fixture.ts';
import { fixtureBoundTurn } from './testing/mcp-admission-fixture.ts';
import { recordEvents, type EventRecorder } from './testing/events.ts';
import { removeTempDir } from './testing/cleanup.ts';
import { expectMemoryRefused, watchEscapes } from './testing/nativecrash-harness.ts';
import { installNativeReleaseReader } from './decision/provider-release.ts';
import { fencedRefusals, kindUnjoined, unawaitedTeardowns, type FencedRefusal } from './drivers/engine-input.ts';
import type { ProviderInstance, RuntimeEvent } from './contracts.ts';

const FAKE_CLI = fileURLToPath(new URL('./testing/fake-codex-app-server.ts', import.meta.url));
let instance: ProviderInstance | undefined, recorder: EventRecorder | undefined, scratch: string | undefined;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  recorder?.stop(); await instance?.dispose(); instance = undefined;
  vi.unstubAllEnvs();
  if (scratch) await removeTempDir(scratch); scratch = undefined;
});

for (const mode of ['cx3', 'cx5'] as const) it(mode === 'cx3' ? 'CX3 reopened native ask answered after a revoke: one R at codex.ask.reopened, closer driver, one close, K2 kind-unjoined 0' : 'CX5/CX6 hook allow refused on the socket: one R at hook.socket.codex joined by codex.hook.deliver, closer driver, one close, K2 kind-unjoined 0', async () => {
  const before = new Set(fencedRefusals());
  const unjoinedBefore = kindUnjoined.count;
  const watch = watchEscapes();
  cleanups.push(() => watch.stop());
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'nc-cx3-')));
  const cwd = join(scratch, 'project'), home = join(scratch, 'home');
  mkdirSync(cwd); mkdirSync(home); mkdirSync(join(cwd, 'out'));
  writeFileSync(join(home, 'config.toml'), 'model = "fixture-model"\n');
  chmodSync(FAKE_CLI, 0o755); resetIsolationCache();
  vi.stubEnv('FAKE_CODEX_VERSION', 'codex-cli 0.150.0');
  vi.stubEnv('FAKE_CODEX_DUMP', join(scratch, 'dump.json'));
  vi.stubEnv('FAKE_CODEX_DUMP_ON_TERM', '1');
  const patch = ['*** Begin Patch', '*** Add File: out/notes', '+hello', '*** End Patch'].join('\n');
  vi.stubEnv('FAKE_CODEX_TOOLS', JSON.stringify([{ kind: 'apply_patch', id: 'nl-patch', patch, cwd, escalate: true }]));
  fixture('unlimited');
  const cf = consumingFixture(undefined, { threadId: 't' });
  cleanups.push(() => cf.close());
  let turnId = '';
  instance = await CodexDriver.create({ instanceId: 'p', displayName: 'NL fixture', environment: { CODEX_HOME: home }, enabled: true, config: { cli: FAKE_CLI, fullAuto: true } });
  recorder = recordEvents(instance.adapter);
  const bus = { subscribe: (fn: (event: RuntimeEvent) => void) => instance!.adapter.onEvent(event => { if (event.type === 'turn.started') turnId = event.turnId ?? ''; fn({ ...event, providerInstanceId: 'p' }); }) };
  d.installProvenanceReader({ turnGenerationFor: () => 'g', provenance: () => ({ generation: 'g', threadId: 't', botId: 'b', principal: 'owner', initiator: { k: 'owner-typed' }, roomOwnerOnly: true, at: 1 }), live: () => ({ botId: 'b', turnId, providerInstanceId: 'p', principal: 'owner', owner: true, level: 'unlimited' }) });
  const offs: Array<() => void> = [d.installRequestIngress(bus)];
  cleanups.push(() => { for (const off of offs) off(); });
  d.installDecisionTransport({ interrupt: async () => {}, respond: async (target, answer, options) => (instance!.adapter.respondToRequest as any)(target.threadId, target.requestId, answer, options) });
  const requestIds: string[] = [];
  const deliveries: Promise<unknown>[] = [];
  offs.push(instance.adapter.onEvent(event => {
    if (event.type !== 'request.opened') return;
    requestIds.push(String(event.requestId));
    if (mode === 'cx5') cf.replace();
    const h = d.openRequest({ kind: 'engine', threadId: 't', requestId: event.requestId! });
    d.decide(h, baseRun);
    deliveries.push(d.deliverRequest(h));
  }));
  // The decision host's release reader allows the hook's own allow but not the cached replay at the native RPC, which it holds as a refreshed
  // card (same seam pi-posture-switch overrides); reaching the reopen needs a card the real guard only raises for a changed wipe-class input.
  let reopened: () => void = () => {};
  const reopenedP = mode === 'cx5' ? Promise.resolve() : new Promise<void>(resolve => { reopened = resolve; });
  if (mode === 'cx3') { installNativeReleaseReader((_identity, _updated, replay) => replay === undefined, () => { reopened(); return true; }); cleanups.push(() => installNativeReleaseReader(() => false)); }
  const sent = await instance.adapter.sendTurn({ ...fixtureBoundTurn({ threadId: 't', text: 'fake-only', cwd, releaseBinding: cf.binding }), stopLine: true as const, permissionNow: () => d.readTurnPolicy({ threadId: 't', generation: 'g' })!.permission, noLimits: true as const } as any);
  await recorder.until(e => e.type === 'request.opened' && e.turnId === sent.turnId);
  await Promise.all(deliveries);
  await reopenedP;
  await new Promise(resolve => setImmediate(resolve));
  if (mode === 'cx3') {
    cf.replace();
    await instance.adapter.respondToRequest('t', requestIds[0]!, { behavior: 'deny' });
  }
  await expectMemoryRefused(recorder, watch, sent.turnId);
  const rs = fencedRefusals().filter((r): r is FencedRefusal => !before.has(r) && (r as FencedRefusal).threadId === 't' && typeof (r as FencedRefusal).takeClose === 'function');
  expect(rs, 'exactly one refusal object (K1)').toHaveLength(1);
  expect([rs[0]!.site, rs[0]!.kind, rs[0]!.closer]).toEqual([mode === 'cx3' ? 'codex.ask.reopened' : 'hook.socket.codex', 'turn', 'driver']);
  if (mode === 'cx5') expect(rs[0]!.joins, 'CX6: the deliverNative refused join').toContain('codex.hook.deliver');
  expect(await rs[0]!.teardown, 'one bounded close, confirmed').toEqual({ confirmed: true });
  expect(unawaitedTeardowns().filter(r => !before.has(r))).toEqual([]);
  expect(kindUnjoined.count - unjoinedBefore).toBe(0);
  expect(watch.escaped).toEqual([]);
});
