// SPDX-License-Identifier: AGPL-3.0-or-later
// G1 split seat witnesses (nativecrash stage 2, codex): CXK (unconfirmed fenced close -> stuck -> late), CX2S (probe O2 + no-bytes guard),
// M18 (the discharge tests the target's binding before it writes) and the M19 control (a non-refusal in a dispatch never escapes).
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// CXK seam: while `held`, the kill is not sent and the stop is reported unconfirmed (a process that would not stop); otherwise the real calls.
const stopSeam = vi.hoisted(() => ({ held: false }));
vi.mock('./procs.ts', async original => {
  const actual = await original<typeof import('./procs.ts')>();
  return {
    ...actual,
    killCliTree: ((...args: Parameters<typeof actual.killCliTree>) => stopSeam.held ? undefined : actual.killCliTree(...args)) as typeof actual.killCliTree,
    awaitCliTreeStopped: ((...args: Parameters<typeof actual.awaitCliTreeStopped>) => stopSeam.held ? Promise.resolve(false) : actual.awaitCliTreeStopped(...args)) as typeof actual.awaitCliTreeStopped,
  };
});

import { DATA_DIR, ensureDirs } from './config.ts';
import { CodexDriver, closeBoundRefusal } from './drivers/codex.ts';
import { resetIsolationCache } from './drivers/isolation-cache.ts';
import { consumingFixture } from './testing/consuming-fixture.ts';
import { fixtureBoundTurn } from './testing/mcp-admission-fixture.ts';
import { recordEvents, type EventRecorder } from './testing/events.ts';
import { removeTempDir } from './testing/cleanup.ts';
import { expectMemoryRefused, watchEscapes } from './testing/nativecrash-harness.ts';
import { fencedRefusals, type CloseResult, type FencedRefusal } from './drivers/engine-input.ts';
import type { ProviderInstance } from './contracts.ts';

const FAKE_CLI = fileURLToPath(new URL('./testing/fake-codex-app-server.ts', import.meta.url));
let dir: string, instance: ProviderInstance | undefined, recorder: EventRecorder | undefined;
const cleanups: Array<() => void | Promise<void>> = [];
beforeEach(() => { ensureDirs(); mkdirSync(join(DATA_DIR, 'native'), { recursive: true }); dir = realpathSync.native(mkdtempSync(join(DATA_DIR, 'native', 'nc-codex-b-'))); });
afterEach(async () => {
  stopSeam.held = false;
  for (const c of cleanups.splice(0).reverse()) await c();
  recorder?.stop(); await instance?.dispose(); instance = undefined;
  vi.unstubAllEnvs(); vi.restoreAllMocks(); await removeTempDir(dir);
});
const approval = (cwd: string) => JSON.stringify({ method: 'item/fileChange/requestApproval', params: { itemId: 'nc-1', cwd, fileChanges: [{ path: 'a', kind: 'add' }] } });
const mineSince = (before: Set<unknown>) => fencedRefusals().filter((r): r is FencedRefusal => !before.has(r) && (r as FencedRefusal).threadId === 'nc-codex' && typeof (r as FencedRefusal).takeClose === 'function');
const home = () => { resetIsolationCache(); chmodSync(FAKE_CLI, 0o755); const h = join(dir, 'home'); mkdirSync(h); writeFileSync(join(h, 'config.toml'), 'model = "fixture-model"\n'); return h; };
const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms))]);

// M18 / M12 (F11): the close of a driver-won refusal tests the target's binding FIRST. A process bound to another turn gets no cancel
// frame (no bytes) and no close, and its record settles "in-process:target-rebound" (M12); a bound one gets both; a refusal the lease closes gets neither from the driver.
for (const [name, closer, bound, generation, expected] of [
  ['bound to this attempt: discharge and close both run', 'driver', 2, 2, ['cancel', 'close']],
  ['rebound to a later turn: no bytes, no close', 'driver', null, 2, []],
  ['bound to another generation: no bytes, no close', 'driver', 3, 2, []],
  ['lease-closed refusal: the driver neither discharges nor closes', 'lease', 2, 2, []],
] as const) it(`M18 closeBoundRefusal ${name}`, async () => {
  const ran: string[] = [];
  const R = { closer, close: async (c: () => Promise<CloseResult>) => { ran.push('close'); return c(); } } as unknown as FencedRefusal;
  await closeBoundRefusal(R, { boundGeneration: bound }, generation, async () => { ran.push('cancel'); return true; }, async () => ({ confirmed: true }));
  expect(ran).toEqual(expected);
  // M12: a rebound target settles the record "in-process:target-rebound"; a bound or lease-closed one leaves the outcome to its close
  expect((R as { outcome?: string }).outcome, 'M12 outcome').toBe(closer === 'driver' && bound !== generation ? 'in-process:target-rebound' : undefined);
});
it('M18 order: the binding is read before the discharge writes', async () => {
  const order: string[] = [];
  const R = { closer: 'driver', close: async () => { order.push('close'); return { confirmed: true }; } } as unknown as FencedRefusal;
  await closeBoundRefusal(R, { get boundGeneration() { order.push('bound-test'); return 1; } }, 1, async () => { order.push('cancel'); return true; }, async () => ({ confirmed: true }));
  expect(order).toEqual(['bound-test', 'cancel', 'close']);
});

// M19 control: the automatic approval reply fails with a NON-refusal (a pipe error). The dispatch declines the request on its existing path
// (warn + cancel frame); nothing is claimed, nothing escapes, and the turn still ends.
it('M19 control: a non-refusal dispatch error is declined locally, claims no refusal and never escapes', async () => {
  const before = new Set<unknown>(fencedRefusals());
  const watch = watchEscapes();
  cleanups.push(() => watch.stop());
  const h = home();
  vi.stubEnv('FAKE_CODEX_VERSION', 'codex-cli 0.128.0');
  vi.stubEnv('FAKE_CODEX_DUMP', join(dir, 'dump.json'));
  vi.stubEnv('FAKE_CODEX_MODE', 'approval');
  vi.stubEnv('FAKE_CODEX_APPROVAL', approval(dir));
  const warn = vi.spyOn(console, 'warn');
  let thrown = 0;
  const originalWrite = Socket.prototype.write;
  vi.spyOn(Socket.prototype, 'write').mockImplementation(function (this: Socket, ...args: any[]) {
    const text = String(args[0]);
    if (thrown === 0 && text.includes('"id":100') && text.includes('accept')) { thrown++; throw Object.assign(new Error('write EPIPE (fixture)'), { code: 'EPIPE' }); }
    return originalWrite.apply(this, args as any);
  } as any);
  const f = consumingFixture(undefined, { threadId: 'nc-codex' });
  cleanups.push(() => f.close());
  instance = await CodexDriver.create({ instanceId: 'nc-codex', displayName: 'Fixture', enabled: true, environment: { CODEX_HOME: h }, config: { cli: FAKE_CLI, fullAuto: true } });
  recorder = recordEvents(instance.adapter);
  const sent = await instance.adapter.sendTurn(fixtureBoundTurn({ threadId: 'nc-codex', text: 'hello', cwd: dir, releaseBinding: f.binding }));
  const ended = await recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId);
  await new Promise(resolve => setImmediate(resolve));
  expect(thrown, 'the automatic reply failed once with a non-refusal').toBe(1);
  expect(watch.escaped, 'I4: no unhandled rejection or exception').toEqual([]);
  expect(mineSince(before), 'a non-refusal claims no refusal').toEqual([]);
  expect((ended as { stopReason?: string }).stopReason, 'not a memory refusal').not.toBe('memory-refused');
  expect(warn.mock.calls.filter(c => String(c[0]).includes('server request item/fileChange/requestApproval failed')), 'the existing local owner logged it').toHaveLength(1);
  const dump = JSON.parse(readFileSync(join(dir, 'dump.json'), 'utf8')) as { decision: unknown };
  expect(JSON.stringify(dump.decision), 'the request was declined, never approved').not.toMatch(/accept/i);
});

// CXK: a fenced turn whose process cannot be confirmed stopped. The one close is unconfirmed (stop-failed); the process stays owned (stuck), so the
// next dispatch of the thread is refused; once the process is really gone its own close confirms R late, and the dispatch after that runs.
it('CXK unconfirmed fenced close: teardown stop-failed, next dispatch refused, process close resolves R.late, next turn ok', async () => {
  const before = new Set<unknown>(fencedRefusals());
  const watch = watchEscapes();
  cleanups.push(() => watch.stop());
  const h = home();
  vi.stubEnv('FAKE_CODEX_VERSION', 'codex-cli 0.128.0');
  vi.stubEnv('FAKE_CODEX_DUMP', join(dir, 'dump.json'));
  vi.stubEnv('FAKE_CODEX_MODE', 'approval');
  vi.stubEnv('FAKE_CODEX_APPROVAL', approval(dir));
  const f = consumingFixture(undefined, { threadId: 'nc-codex' });
  cleanups.push(() => f.close());
  const originalWrite = Socket.prototype.write;
  const spy = vi.spyOn(Socket.prototype, 'write').mockImplementation(function (this: Socket, ...args: any[]) {
    const result = originalWrite.apply(this, args as any);
    if (String(args[0]).includes('"turn/start"')) { stopSeam.held = true; f.replace(); }
    return result;
  } as any);
  instance = await CodexDriver.create({ instanceId: 'nc-codex', displayName: 'Fixture', enabled: true, environment: { CODEX_HOME: h }, config: { cli: FAKE_CLI, fullAuto: true } });
  recorder = recordEvents(instance.adapter);
  const sent = await instance.adapter.sendTurn(fixtureBoundTurn({ threadId: 'nc-codex', text: 'hello', cwd: dir, releaseBinding: f.binding }));
  // an unconfirmed stop keeps the turn open and the conversation busy (the existing rule): no terminal event yet
  await recorder.until(e => e.type === 'runtime.error' && e.turnId === sent.turnId && /did not close after Stop/.test(String((e as { message?: string }).message)));
  const ends = () => recorder!.events.filter(e => e.type === 'turn.completed' && e.turnId === sent.turnId);
  expect(ends(), 'no terminal event while the process is unconfirmed').toEqual([]);
  const rs = mineSince(before);
  expect(rs, 'exactly one refusal object (K1)').toHaveLength(1);
  const R = rs[0]!;
  expect([R.site, R.kind, R.closer]).toEqual(['codex.dispatch.direct', 'turn', 'driver']);
  expect(await within(R.teardown, 10_000, 'R.teardown'), 'the one close is unconfirmed, never true').toEqual({ confirmed: false, reason: 'stop-failed' });
  expect(R.lateConfirmedAt, 'not confirmed while the process lives').toBeNull();
  const pid = (JSON.parse(readFileSync(join(dir, 'dump.json'), 'utf8')) as { pid: number }).pid;
  expect(() => process.kill(pid, 0), 'the process is still alive').not.toThrow();
  spy.mockRestore();
  vi.stubEnv('FAKE_CODEX_MODE', 'happy');
  // the process is still owned: nothing new starts beside it
  const f2 = consumingFixture(undefined, { threadId: 'nc-codex' });
  cleanups.push(() => f2.close());
  await expect(instance.adapter.sendTurn(fixtureBoundTurn({ threadId: 'nc-codex', text: 'again', cwd: dir, releaseBinding: f2.binding })), 'the next dispatch is refused while the process is unconfirmed').rejects.toThrow();
  expect(R.lateConfirmedAt, 'a refused dispatch confirms nothing').toBeNull();
  expect(ends(), 'still no terminal event').toEqual([]);
  // release: the process goes away on its own; its close (not a later dispatch) confirms the refusal late
  stopSeam.held = false;
  process.kill(pid, 'SIGKILL');
  await within(R.late, 10_000, 'R.late');
  expect(R.lateConfirmedAt, 'late confirmation recorded').not.toBeNull();
  await expectMemoryRefused(recorder, watch, sent.turnId); // the late confirmation ends the refused turn, once
  expect(await R.teardown, 'the teardown result itself never flips').toEqual({ confirmed: false, reason: 'stop-failed' });
  const f3 = consumingFixture(undefined, { threadId: 'nc-codex' });
  cleanups.push(() => f3.close());
  const next = await instance.adapter.sendTurn(fixtureBoundTurn({ threadId: 'nc-codex', text: 'third', cwd: dir, releaseBinding: f3.binding }));
  expect(await recorder.until(e => e.type === 'turn.completed' && e.turnId === next.turnId), 'the turn after the late confirmation runs').toMatchObject({ ok: true });
  expect(watch.escaped).toEqual([]);
});

// CX2S probe O2 (no injection): a gated process whose hook proof is late; the engine ends the turn and raises an approval request in ONE write,
// the proof arrives after both. The model's cross-turn refusal needs the request's continuation to run after lease N closed. The probe records
// what happens and asserts the item-5 finding: no refusal object, no escape (CX2S NOT-REACHABLE).
it('CX2S probe O2: turn/completed then a request then the late proof raises no refusal', async () => {
  const before = new Set<unknown>(fencedRefusals());
  const watch = watchEscapes();
  cleanups.push(() => watch.stop());
  const h = home();
  vi.stubEnv('FAKE_CODEX_VERSION', 'codex-cli 0.150.0');
  vi.stubEnv('FAKE_CODEX_DUMP', join(dir, 'dump.json'));
  vi.stubEnv('FAKE_CODEX_MODE', 'late-approval');
  vi.stubEnv('FAKE_CODEX_SESSION_DELAY_MS', '300');
  const f = consumingFixture(undefined, { threadId: 'nc-codex' });
  cleanups.push(() => f.close());
  instance = await CodexDriver.create({ instanceId: 'nc-codex', displayName: 'Fixture', enabled: true, environment: { CODEX_HOME: h }, config: { cli: FAKE_CLI, fullAuto: true } });
  recorder = recordEvents(instance.adapter);
  const sent = await instance.adapter.sendTurn(fixtureBoundTurn({ threadId: 'nc-codex', text: 'hello', cwd: dir, releaseBinding: f.binding }));
  // the request's continuation runs while turn N is still open (its lease is live): a normal ask, not a refusal
  const first = await recorder.until(e => (e.type === 'turn.completed' && e.turnId === sent.turnId) || e.type === 'request.opened');
  expect(first.type, 'the request is handled before the turn ends').toBe('request.opened');
  expect(mineSince(before), 'no refusal while the ask is open').toEqual([]);
  await instance.adapter.respondToRequest('nc-codex', String((first as { requestId?: unknown }).requestId), { behavior: 'deny' });
  const ended = await recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId);
  await new Promise(resolve => setTimeout(resolve, 500));
  const rs = mineSince(before);
  console.info(`CX2S-PROBE first=${first.type} ended=${JSON.stringify({ ok: (ended as any).ok, stopReason: (ended as any).stopReason })} refusals=${rs.length} sites=${JSON.stringify(rs.map(r => [r.site, r.kind, r.closer]))} escaped=${watch.escaped.length}`);
  expect(rs, 'CX2S NOT-REACHABLE: no cross-turn refusal').toEqual([]);
  expect(watch.escaped).toEqual([]);
});

// CX2S probe O2 with FAKE_CODEX_REQUEST_AFTER_COMPLETE (row text): the gated fake writes turn/completed and an approval request in ONE chunk with
// NO hook call before them, then the late SessionStart. The request is held on the proof while turn N's clean end also waits on it; the probe
// records whether the request's continuation, run after the proof, raises a refusal (the model's cross-turn shape). Item 5: it must not.
for (const closeAtEnd of [false, true]) it(`CX2S probe O2 (REQUEST_AFTER_COMPLETE${closeAtEnd ? ', lease N closed at the terminal' : ''}): completion and request in one write, late proof: no refusal, one terminal`, async () => {
  const before = new Set<unknown>(fencedRefusals());
  const watch = watchEscapes();
  cleanups.push(() => watch.stop());
  const h = home();
  vi.stubEnv('FAKE_CODEX_VERSION', 'codex-cli 0.150.0');
  vi.stubEnv('FAKE_CODEX_REQUEST_AFTER_COMPLETE', '1');
  vi.stubEnv('FAKE_CODEX_SESSION_DELAY_MS', '300');
  const f = consumingFixture(undefined, { threadId: 'nc-codex' });
  cleanups.push(() => f.close());
  instance = await CodexDriver.create({ instanceId: 'nc-codex', displayName: 'Fixture', enabled: true, environment: { CODEX_HOME: h }, config: { cli: FAKE_CLI, fullAuto: true } });
  recorder = recordEvents(instance.adapter);
  // closeAtEnd: lease N is revoked synchronously inside the terminal event, as the server closes it, before the held request's continuation runs
  if (closeAtEnd) { const off = instance.adapter.onEvent(e => { if (e.type === 'turn.completed') { off(); f.replace(); } }); cleanups.push(() => off()); }
  const sent = await instance.adapter.sendTurn(fixtureBoundTurn({ threadId: 'nc-codex', text: 'hello', cwd: dir, releaseBinding: f.binding }));
  const ended = await recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId);
  // an explicit gate: the held request's continuation runs once the proof lands (300 ms); a refusal it raised would be registered by then
  await new Promise(resolve => setTimeout(resolve, 1500));
  const rs = mineSince(before);
  const mine = recorder.events.filter(e => e.turnId === sent.turnId);
  console.info(`CX2S-PROBE-O2 closeAtEnd=${closeAtEnd} ended=${JSON.stringify({ ok: (ended as any).ok, stopReason: (ended as any).stopReason })} requests=${mine.filter(e => e.type === 'request.opened').length} refusals=${rs.length} sites=${JSON.stringify(rs.map(r => [r.site, r.kind, r.closer]))} escaped=${watch.escaped.length}`);
  expect(rs, 'CX2S NOT-REACHABLE: no cross-turn refusal').toEqual([]);
  expect(mine.filter(e => e.type === 'turn.completed'), 'one terminal').toHaveLength(1);
  expect(watch.escaped).toEqual([]);
});
