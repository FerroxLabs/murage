// SPDX-License-Identifier: AGPL-3.0-or-later
// G1a witnesses (nativecrash stage 2, codex): CX1/CX2 dispatch refusals claim ONE R through refusalFor and close it once.
// Codex handleServerRequest is dispatched as a dropped promise; the automatic approval reply is released
// through the consuming fence. Revoking the turn after turn/start makes that reply throw EngineInputRevoked.
// A server with no global handler dies on the resulting unhandledRejection; here a listener observes the
// event (a listener also suppresses the exit, so the test needs no sleep and cannot kill the worker).
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR, ensureDirs } from './config.ts';
import { CodexDriver, codexBackoffSeam } from './drivers/codex.ts';
import { resetIsolationCache } from './drivers/isolation-cache.ts';
import { consumingFixture } from './testing/consuming-fixture.ts';
import { fixtureBoundTurn } from './testing/mcp-admission-fixture.ts';
import { recordEvents, type EventRecorder } from './testing/events.ts';
import { removeTempDir } from './testing/cleanup.ts';
import { expectChildDischarged, expectMemoryRefused, watchEscapes } from './testing/nativecrash-harness.ts';
import { EngineInputRevoked, fencedRefusals, kindUnjoined, refusalFor, unawaitedTeardowns, type FencedRefusal } from './drivers/engine-input.ts';
import type { ProviderInstance } from './contracts.ts';

const FAKE_CLI = fileURLToPath(new URL('./testing/fake-codex-app-server.ts', import.meta.url));
let dir: string, instance: ProviderInstance | undefined, recorder: EventRecorder | undefined;
const cleanups: Array<() => void | Promise<void>> = [];
beforeEach(() => { ensureDirs(); mkdirSync(join(DATA_DIR, 'native'), { recursive: true }); dir = realpathSync.native(mkdtempSync(join(DATA_DIR, 'native', 'nc-codex-'))); });
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  recorder?.stop(); await instance?.dispose(); instance = undefined;
  vi.unstubAllEnvs(); vi.restoreAllMocks(); await removeTempDir(dir);
});


const approval = (dir: string) => JSON.stringify({ method: 'item/fileChange/requestApproval', params: { itemId: 'nc-1', cwd: dir, fileChanges: [{ path: 'a', kind: 'add' }] } });
for (const [name, site, live] of [['CX1 direct dispatch', 'codex.dispatch.direct', false], ['CX2 gated dispatch', 'codex.dispatch.gated', true]] as const) {
  it(`${name}: one R at ${site}, closer driver, one confirmed close, no escape`, async () => {
    const before = new Set(fencedRefusals());
    const watch = watchEscapes();
    cleanups.push(() => watch.stop());
    resetIsolationCache(); chmodSync(FAKE_CLI, 0o755);
    const home = join(dir, 'home'); mkdirSync(home); writeFileSync(join(home, 'config.toml'), 'model = "fixture-model"\n');
    vi.stubEnv('FAKE_CODEX_VERSION', live ? 'codex-cli 0.150.0' : 'codex-cli 0.128.0');
    vi.stubEnv('FAKE_CODEX_DUMP', join(dir, 'dump.json'));
    vi.stubEnv('FAKE_CODEX_DUMP_ON_TERM', '1');
    vi.stubEnv('FAKE_CODEX_MODE', 'approval');
    vi.stubEnv('FAKE_CODEX_APPROVAL', approval(dir));
    if (live) { vi.stubEnv('FAKE_CODEX_SESSION_DELAY_MS', '50'); vi.stubEnv('FAKE_CODEX_REQUEST_BEFORE_SESSION', '1'); }
    const f = consumingFixture(undefined, { threadId: 'nc-codex' });
    cleanups.push(() => f.close());
    const originalWrite = Socket.prototype.write;
    vi.spyOn(Socket.prototype, 'write').mockImplementation(function (this: Socket, ...args: any[]) {
      const result = originalWrite.apply(this, args as any);
      // gated: revoke right after the session-start hook's reply is written, so the held request's dispatch (the next microtask) is the refused write
      if (String(args[0]).includes(live ? '{"code"' : '"turn/start"')) f.replace();
      return result;
    } as any);
    if (live) {
      const originalEnd = Socket.prototype.end;
      vi.spyOn(Socket.prototype, 'end').mockImplementation(function (this: Socket, ...args: any[]) {
        const result = originalEnd.apply(this, args as any);
        if (String(args[0]).includes('{"code"')) f.replace();
        return result;
      } as any);
    }
    instance = await CodexDriver.create({ instanceId: 'nc-codex', displayName: 'Fixture', enabled: true, environment: { CODEX_HOME: home }, config: { cli: FAKE_CLI, fullAuto: true } });
    recorder = recordEvents(instance.adapter);
    const sent = await instance.adapter.sendTurn(fixtureBoundTurn({ threadId: 'nc-codex', text: 'hello', cwd: dir, releaseBinding: f.binding }));
    await expectMemoryRefused(recorder, watch, sent.turnId);
    const rs = fencedRefusals().filter((r): r is FencedRefusal => !before.has(r) && (r as FencedRefusal).threadId === 'nc-codex' && typeof (r as FencedRefusal).takeClose === 'function');
    expect(rs, 'exactly one refusal object (K1)').toHaveLength(1);
    const R = rs[0]!;
    expect([R.site, R.kind, R.closer]).toEqual([site, 'turn', 'driver']);
    expect(await R.teardown, 'one bounded close, confirmed').toEqual({ confirmed: true });
    expect(unawaitedTeardowns().filter(r => !before.has(r))).toEqual([]);
    expectChildDischarged(join(dir, 'dump.json'));
    expect(watch.escaped).toEqual([]);
  });
}

// CX7: a revoke after the turn's own initialize write refuses the NEXT write (initialized/thread/start, not a prompt submission) inside the caller's
// catch. Production writer: send() -> releaseNativeAnswer; reaching path: rpc("thread/start") -> launchAttempt catch (codex.rpc).
// CXSUB: the same run revoked after the thread/start write refuses the turn/start prompt submission (fencedSubmit), which reaches the same catch
// and is claimed at codex.prompt as a submission, never as codex.rpc (the CX7 guard).
// CXSUB2 revokes inside turn.fencedWrite (after beforeSubmit passed): fencedSubmit's own refusal, which reaches the OUTER catch (the request promise
// rejects) with promptSubmissionRefused set; the CX7 `!promptSubmissionRefused` guard is the only thing keeping it from claiming codex.rpc.
for (const [name, transients, trigger, site, kind] of [['CX7 handshake write', false, '"initialize"', 'codex.rpc', 'turn'], ['CXSUB prompt submission', false, '"thread/start"', 'codex.prompt', 'submission'], ['CXSUB2 fencedSubmit refusal', false, '"fenced-write"', 'codex.prompt', 'submission']] as const) { // CXG has no reachable witness yet (see DONE.md)
  it(`${name}: one R at ${site}, closer driver, one close, no retry, K2 kind-unjoined 0`, async () => {
    const before = new Set(fencedRefusals());
    const unjoinedBefore = kindUnjoined.count;
    const watch = watchEscapes();
    cleanups.push(() => watch.stop());
    resetIsolationCache(); chmodSync(FAKE_CLI, 0o755);
    const home = join(dir, 'home'); mkdirSync(home); writeFileSync(join(home, 'config.toml'), 'model = "fixture-model"\n');
    vi.stubEnv('FAKE_CODEX_VERSION', 'codex-cli 0.128.0');
    vi.stubEnv('FAKE_CODEX_DUMP', join(dir, 'dump.json'));
    vi.stubEnv('FAKE_CODEX_DUMP_ON_TERM', '1');
    if (transients) { vi.stubEnv('FAKE_CODEX_TRANSIENTS', '1'); vi.stubEnv('FAKE_CODEX_STATE', join(dir, 'launches')); }
    const f = consumingFixture(undefined, { threadId: 'nc-codex' });
    cleanups.push(() => f.close());
    let armed = false; // the create-time probe also writes initialize; only the bound turn's own process is revoked
    const originalWrite = Socket.prototype.write;
    vi.spyOn(Socket.prototype, 'write').mockImplementation(function (this: Socket, ...args: any[]) {
      const result = originalWrite.apply(this, args as any);
      if (String(args[0]).includes(trigger) && armed) f.replace();
      return result;
    } as any);
    instance = await CodexDriver.create({ instanceId: 'nc-codex', displayName: 'Fixture', enabled: true, environment: { CODEX_HOME: home }, config: { cli: FAKE_CLI, fullAuto: true } });
    recorder = recordEvents(instance.adapter);
    armed = true;
    const bound = fixtureBoundTurn({ threadId: 'nc-codex', text: 'hello', cwd: dir, releaseBinding: f.binding });
    if (trigger === '"fenced-write"') { const inner = bound.fencedWrite!; bound.fencedWrite = ((write: any, validate: any, bytes: any) => { f.replace(); return inner(write, validate, bytes); }) as typeof inner; }
    const sent = await instance.adapter.sendTurn(bound);
    await expectMemoryRefused(recorder, watch, sent.turnId); // P1: a claimed submission refusal ends memory-refused too
    expect(recorder.events.filter(e => e.type === 'turn.retrying'), 'a fenced turn is never relaunched').toEqual([]);
    const rs = fencedRefusals().filter((r): r is FencedRefusal => !before.has(r) && (r as FencedRefusal).threadId === 'nc-codex' && typeof (r as FencedRefusal).takeClose === 'function');
    expect(rs, 'exactly one refusal object (K1)').toHaveLength(1);
    const R = rs[0]!;
    expect([R.site, R.kind, R.closer]).toEqual([site, kind, 'driver']);
    expect(await R.teardown, 'one bounded close, confirmed').toEqual({ confirmed: true });
    expect(unawaitedTeardowns().filter(r => !before.has(r))).toEqual([]);
    expect(kindUnjoined.count - unjoinedBefore, 'kind-unjoined turn refusal').toBe(0);
    expect(watch.escaped).toEqual([]);
  });
}

// CXG: the lease closes first (a Tl revoke outside any fence call), so the codex claim only JOINS (closer lease, settle deferred). The process then
// crashes transiently before turn/start: every retry path must stay shut while turnOwner.fenced is set, and the turn ends memory-refused.
for (const crash of ['transient', 'fatal'] as const) it(`CXG lease-first refusal joined by the handshake write, then a ${crash} crash: no relaunch, no engine-exit card, ends memory-refused`, async () => {
  const before = new Set(fencedRefusals());
  const watch = watchEscapes();
  cleanups.push(() => watch.stop());
  resetIsolationCache(); chmodSync(FAKE_CLI, 0o755);
  const home = join(dir, 'home'); mkdirSync(home); writeFileSync(join(home, 'config.toml'), 'model = "fixture-model"\n');
  vi.stubEnv('FAKE_CODEX_VERSION', 'codex-cli 0.128.0');
  const crashFile = join(dir, 'crash');
  vi.stubEnv('FAKE_CODEX_EXIT_ON_FILE', crashFile);
  const f = consumingFixture(undefined, { threadId: 'nc-codex' });
  cleanups.push(() => f.close());
  let armed = false;
  const originalWrite = Socket.prototype.write;
  vi.spyOn(Socket.prototype, 'write').mockImplementation(function (this: Socket, ...args: any[]) {
    const result = originalWrite.apply(this, args as any);
    if (String(args[0]).includes('"initialize"') && armed) {
      armed = false;
      refusalFor(new EngineInputRevoked({ state: 'checking', reason: 'not-built' }), 'test.lease', { engine: 'codex', threadId: 'nc-codex', binding: f.binding, kind: 'turn', target: null });
      f.replace();
    }
    return result;
  } as any);
  instance = await CodexDriver.create({ instanceId: 'nc-codex', displayName: 'Fixture', enabled: true, environment: { CODEX_HOME: home }, config: { cli: FAKE_CLI, fullAuto: true } });
  recorder = recordEvents(instance.adapter);
  armed = true;
  const sent = await instance.adapter.sendTurn(fixtureBoundTurn({ threadId: 'nc-codex', text: 'hello', cwd: dir, releaseBinding: f.binding }));
  const mine = () => fencedRefusals().filter((r): r is FencedRefusal => !before.has(r) && (r as FencedRefusal).threadId === 'nc-codex' && typeof (r as FencedRefusal).takeClose === 'function');
  await vi.waitFor(() => expect(mine()[0]?.joins).toContain('codex.rpc'), { timeout: 10_000 });
  expect(mine()).toHaveLength(1);
  expect(mine()[0]!.closer, 'the lease won the close; the codex claim joined').toBe('lease');
  writeFileSync(crashFile, crash);
  await expectMemoryRefused(recorder, watch, sent.turnId);
  expect(recorder.events.filter(e => e.type === 'turn.retrying'), 'a fenced turn is never relaunched').toEqual([]);
  // the close handler's fence guard: a fenced turn's engine exit is not an engine failure to report (no exit_before_result card)
  expect(recorder.events.filter(e => e.type === 'runtime.error' && e.turnId === sent.turnId), 'a fenced turn reports no engine exit').toEqual([]);
  expect(watch.escaped).toEqual([]);
});

// CXL: the lease closes first (settle deferred), the codex dispatch claim joins, and the engine then ENDS the turn cleanly. The late turn/completed must
// settle memory-refused (turnOwner.fenced tested first in the turn/completed case, and P1 in settle), never ok:true.
it('CXL late clean turn/completed after a lease-first refusal: settles memory-refused, never ok:true', async () => {
  const before = new Set(fencedRefusals());
  const watch = watchEscapes();
  cleanups.push(() => watch.stop());
  resetIsolationCache(); chmodSync(FAKE_CLI, 0o755);
  const home = join(dir, 'home'); mkdirSync(home); writeFileSync(join(home, 'config.toml'), 'model = "fixture-model"\n');
  vi.stubEnv('FAKE_CODEX_VERSION', 'codex-cli 0.128.0');
  vi.stubEnv('FAKE_CODEX_MODE', 'approval');
  vi.stubEnv('FAKE_CODEX_APPROVAL', approval(dir));
  const doneFile = join(dir, 'done');
  vi.stubEnv('FAKE_CODEX_COMPLETE_ON_FILE', doneFile);
  const f = consumingFixture(undefined, { threadId: 'nc-codex' });
  cleanups.push(() => f.close());
  const originalWrite = Socket.prototype.write;
  vi.spyOn(Socket.prototype, 'write').mockImplementation(function (this: Socket, ...args: any[]) {
    const result = originalWrite.apply(this, args as any);
    if (String(args[0]).includes('"turn/start"')) {
      refusalFor(new EngineInputRevoked({ state: 'checking', reason: 'not-built' }), 'test.lease', { engine: 'codex', threadId: 'nc-codex', binding: f.binding, kind: 'turn', target: null });
      f.replace();
    }
    return result;
  } as any);
  instance = await CodexDriver.create({ instanceId: 'nc-codex', displayName: 'Fixture', enabled: true, environment: { CODEX_HOME: home }, config: { cli: FAKE_CLI, fullAuto: true } });
  recorder = recordEvents(instance.adapter);
  const sent = await instance.adapter.sendTurn(fixtureBoundTurn({ threadId: 'nc-codex', text: 'hello', cwd: dir, releaseBinding: f.binding }));
  const mine = () => fencedRefusals().filter((r): r is FencedRefusal => !before.has(r) && (r as FencedRefusal).threadId === 'nc-codex' && typeof (r as FencedRefusal).takeClose === 'function');
  await vi.waitFor(() => expect(mine()[0]?.joins).toContain('codex.dispatch.direct'), { timeout: 10_000 });
  expect(mine()[0]!.closer, 'the lease won the close; the codex claim joined').toBe('lease');
  expect(recorder.events.filter(e => e.type === 'turn.completed'), 'settle is deferred to the lease').toEqual([]);
  writeFileSync(doneFile, 'x');
  await expectMemoryRefused(recorder, watch, sent.turnId);
  expect(watch.escaped).toEqual([]);
});

// CXL(b) BG_HOLD variant: three helpers are open and never finish, the lease closes first, a helper's approval reply is the joining codex claim,
// and the parent turn then ENDS cleanly. An unfenced turn would be held for its helpers (holdForHelpers); a fenced one must end memory-refused
// at once: the fenced test stays FIRST in the turn/completed case, before the helper hold.
it('CXL-BG late clean turn/completed with helpers open after a lease-first refusal: not held for the helpers, settles memory-refused', async () => {
  const before = new Set(fencedRefusals());
  const watch = watchEscapes();
  cleanups.push(() => watch.stop());
  resetIsolationCache(); chmodSync(FAKE_CLI, 0o755);
  const home = join(dir, 'home'); mkdirSync(home); writeFileSync(join(home, 'config.toml'), 'model = "fixture-model"\n');
  vi.stubEnv('FAKE_CODEX_VERSION', 'codex-cli 0.128.0');
  vi.stubEnv('FAKE_CODEX_BG_HOLD', '1');
  const doneFile = join(dir, 'done');
  vi.stubEnv('FAKE_CODEX_COMPLETE_ON_FILE', doneFile);
  const f = consumingFixture(undefined, { threadId: 'nc-codex' });
  cleanups.push(() => f.close());
  const originalWrite = Socket.prototype.write;
  vi.spyOn(Socket.prototype, 'write').mockImplementation(function (this: Socket, ...args: any[]) {
    const result = originalWrite.apply(this, args as any);
    if (String(args[0]).includes('"turn/start"')) {
      refusalFor(new EngineInputRevoked({ state: 'checking', reason: 'not-built' }), 'test.lease', { engine: 'codex', threadId: 'nc-codex', binding: f.binding, kind: 'turn', target: null });
      f.replace();
    }
    return result;
  } as any);
  instance = await CodexDriver.create({ instanceId: 'nc-codex', displayName: 'Fixture', enabled: true, environment: { CODEX_HOME: home }, config: { cli: FAKE_CLI, fullAuto: true } });
  recorder = recordEvents(instance.adapter);
  const sent = await instance.adapter.sendTurn(fixtureBoundTurn({ threadId: 'nc-codex', text: '__fixture_subagents__', cwd: dir, releaseBinding: f.binding }));
  const mine = () => fencedRefusals().filter((r): r is FencedRefusal => !before.has(r) && (r as FencedRefusal).threadId === 'nc-codex' && typeof (r as FencedRefusal).takeClose === 'function');
  await vi.waitFor(() => expect(mine()[0]?.joins).toContain('codex.dispatch.direct'), { timeout: 10_000 });
  expect(mine()[0]!.closer, 'the lease won the close; the codex claim joined').toBe('lease');
  const ends = () => recorder!.events.filter(e => e.type === 'turn.completed' && e.turnId === sent.turnId);
  expect(ends(), 'settle is deferred to the lease').toEqual([]);
  expect(recorder.events.some(e => e.type === 'turn.subtask'), 'the helpers are open when the late end arrives').toBe(true);
  writeFileSync(doneFile, 'x');
  // an explicit gate: the fake polls the file every 20 ms, so the late turn/completed has been handled before the terminal is read
  await new Promise(r => setTimeout(r, 2000));
  expect(ends(), 'the fenced turn ended at its late turn/completed instead of being held for its helpers').toHaveLength(1);
  expect(ends()[0]).toMatchObject({ ok: false, stopReason: 'memory-refused' });
  await expectMemoryRefused(recorder, watch, sent.turnId);
  expect(watch.escaped).toEqual([]);
});

// CX4: an approval card is open (no hooks, no fullAuto); the turn is revoked, then the user allows. Production writer: the card's
// deliverNative write (send -> releaseNativeAnswer) throws EngineInputRevoked; reaching path: respondToRequest -> asks.get(requestId).
it('CX4 card answer after a revoke: one R at codex.ask.answer, closer driver, one close, K2 kind-unjoined 0', async () => {
  const before = new Set(fencedRefusals());
  const unjoinedBefore = kindUnjoined.count;
  const watch = watchEscapes();
  cleanups.push(() => watch.stop());
  resetIsolationCache(); chmodSync(FAKE_CLI, 0o755);
  const home = join(dir, 'home'); mkdirSync(home); writeFileSync(join(home, 'config.toml'), 'model = "fixture-model"\n');
  vi.stubEnv('FAKE_CODEX_VERSION', 'codex-cli 0.128.0');
  vi.stubEnv('FAKE_CODEX_DUMP', join(dir, 'dump.json'));
  vi.stubEnv('FAKE_CODEX_DUMP_ON_TERM', '1');
  vi.stubEnv('FAKE_CODEX_MODE', 'approval');
  vi.stubEnv('FAKE_CODEX_APPROVAL', approval(dir));
  const f = consumingFixture(undefined, { threadId: 'nc-codex' });
  cleanups.push(() => f.close());
  instance = await CodexDriver.create({ instanceId: 'nc-codex', displayName: 'Fixture', enabled: true, environment: { CODEX_HOME: home }, config: { cli: FAKE_CLI, fullAuto: false } });
  recorder = recordEvents(instance.adapter);
  const sent = await instance.adapter.sendTurn(fixtureBoundTurn({ threadId: 'nc-codex', text: 'hello', cwd: dir, releaseBinding: f.binding }));
  const opened = await recorder.until(e => e.type === 'request.opened');
  f.replace();
  await instance.adapter.respondToRequest('nc-codex', String(opened.requestId), { behavior: 'allow' });
  await expectMemoryRefused(recorder, watch, sent.turnId);
  const rs = fencedRefusals().filter((r): r is FencedRefusal => !before.has(r) && (r as FencedRefusal).threadId === 'nc-codex' && typeof (r as FencedRefusal).takeClose === 'function');
  expect(rs, 'exactly one refusal object (K1)').toHaveLength(1);
  expect([rs[0]!.site, rs[0]!.kind, rs[0]!.closer]).toEqual(['codex.ask.answer', 'turn', 'driver']);
  expect(await rs[0]!.teardown, 'one bounded close, confirmed').toEqual({ confirmed: true });
  expect(unawaitedTeardowns().filter(r => !before.has(r))).toEqual([]);
  expect(kindUnjoined.count - unjoinedBefore).toBe(0);
  expect(watch.escaped).toEqual([]);
});

// CXR: the engine dies transiently at thread/start (before turn/start), so retireAfterExit runs; a claim lands INSIDE its backoff (after the pre-backoff
// fence check). The backoff must not relaunch: the post-backoff `!turnOwner.fenced` is the only thing stopping a second launch.
it('CXR fence landing inside the retireAfterExit backoff: no relaunch, ends memory-refused', async () => {
  const watch = watchEscapes();
  cleanups.push(() => watch.stop());
  resetIsolationCache(); chmodSync(FAKE_CLI, 0o755);
  const home = join(dir, 'home'); mkdirSync(home); writeFileSync(join(home, 'config.toml'), 'model = "fixture-model"\n');
  vi.stubEnv('FAKE_CODEX_VERSION', 'codex-cli 0.128.0');
  const launches = join(dir, 'launches');
  vi.stubEnv('FAKE_CODEX_LAUNCH_CRASHES', '1');
  vi.stubEnv('FAKE_CODEX_STATE', launches);
  const info = vi.spyOn(console, 'info');
  const f = consumingFixture(undefined, { threadId: 'nc-codex' });
  cleanups.push(() => f.close());
  let landed = 0;
  codexBackoffSeam.onBackoff = claim => { landed++; claim(new EngineInputRevoked({ state: 'checking', reason: 'not-built' })); f.replace(); };
  cleanups.push(() => { codexBackoffSeam.onBackoff = undefined; });
  instance = await CodexDriver.create({ instanceId: 'nc-codex', displayName: 'Fixture', enabled: true, environment: { CODEX_HOME: home }, config: { cli: FAKE_CLI, fullAuto: true } });
  recorder = recordEvents(instance.adapter);
  const sent = await instance.adapter.sendTurn(fixtureBoundTurn({ threadId: 'nc-codex', text: 'hello', cwd: dir, releaseBinding: f.binding }));
  await expectMemoryRefused(recorder, watch, sent.turnId);
  // an explicit gate: the backoff (retry scale 1: hundreds of ms) has run its course before the launch count is read
  await new Promise(r => setTimeout(r, 3000));
  expect(landed, 'the fence landed inside the backoff').toBe(1);
  const respawns = info.mock.calls.filter(c => String(c[0]).includes('process=spawned reason=retry'));
  expect(respawns, 'no relaunch after the fence').toHaveLength(0);
  expect(watch.escaped).toEqual([]);
});

// CXG guards: a refusal whose close the lease won leaves the turn fenced but unsettled. Each guard below is the only thing that keeps such a
// turn from a stale retry notice, a backoff wait or a relaunch; the seam lands the fence at the exact point the guard reads it.
type GuardCase = { name: string; path: 'exit' | 'rpc'; at: 'onRetire' | 'onBackoff' | 'onRpcFailure'; retrying: number; retires: number; backoffs: number };
const GUARD_CASES: GuardCase[] = [
  { name: 'CXG-A retireAfterExit pre-backoff: fenced on entry, no retry notice, no backoff', path: 'exit', at: 'onRetire', retrying: 0, retires: 1, backoffs: 0 },
  { name: 'CXG-B retireAndRelaunch pre-backoff: fenced on entry, the backoff is never entered', path: 'rpc', at: 'onRetire', retrying: 1, retires: 1, backoffs: 0 },
  { name: 'CXG-C retireAndRelaunch post-backoff: fenced inside the backoff, no relaunch', path: 'rpc', at: 'onBackoff', retrying: 1, retires: 1, backoffs: 1 },
  { name: 'CXG-D launch catch: fenced before the relaunch decision, no retry notice, no error card, no retire', path: 'rpc', at: 'onRpcFailure', retrying: 0, retires: 0, backoffs: 0 },
];
for (const c of GUARD_CASES) {
  it(`${c.name}; ends memory-refused once`, async () => {
    const watch = watchEscapes();
    cleanups.push(() => watch.stop());
    resetIsolationCache(); chmodSync(FAKE_CLI, 0o755);
    const home = join(dir, 'home'); mkdirSync(home); writeFileSync(join(home, 'config.toml'), 'model = "fixture-model"\n');
    vi.stubEnv('FAKE_CODEX_VERSION', 'codex-cli 0.128.0');
    vi.stubEnv('FAKE_CODEX_RETRY_SCALE', '0.01');
    if (c.path === 'exit') { vi.stubEnv('FAKE_CODEX_LAUNCH_CRASHES', '1'); vi.stubEnv('FAKE_CODEX_STATE', join(dir, 'launches')); }
    else vi.stubEnv('FAKE_CODEX_MODE', 'transient-503');
    const info = vi.spyOn(console, 'info');
    const f = consumingFixture(undefined, { threadId: 'nc-codex' });
    cleanups.push(() => f.close());
    const calls = { onRetire: 0, onBackoff: 0, onRpcFailure: 0 };
    let landed = 0;
    for (const hook of ['onRetire', 'onBackoff', 'onRpcFailure'] as const) {
      codexBackoffSeam[hook] = claim => {
        calls[hook]++;
        if (hook !== c.at || landed > 0) return;
        landed++; claim(new EngineInputRevoked({ state: 'checking', reason: 'not-built' })); f.replace();
      };
    }
    cleanups.push(() => { codexBackoffSeam.onRetire = undefined; codexBackoffSeam.onBackoff = undefined; codexBackoffSeam.onRpcFailure = undefined; });
    instance = await CodexDriver.create({ instanceId: 'nc-codex', displayName: 'Fixture', enabled: true, environment: { CODEX_HOME: home }, config: { cli: FAKE_CLI, fullAuto: true } });
    recorder = recordEvents(instance.adapter);
    const sent = await instance.adapter.sendTurn(fixtureBoundTurn({ threadId: 'nc-codex', text: 'hello', cwd: dir, releaseBinding: f.binding }));
    await expectMemoryRefused(recorder, watch, sent.turnId);
    // an explicit gate: at retry scale 0.01 any backoff and relaunch a missing guard allows has run before the counts are read
    await new Promise(r => setTimeout(r, 2000));
    expect(landed, `the fence landed at ${c.at}`).toBe(1);
    const mine = recorder.events.filter(e => e.turnId === sent.turnId);
    expect(mine.filter(e => e.type === 'turn.retrying'), 'retry notices for the turn').toHaveLength(c.retrying);
    expect(mine.filter(e => e.type === 'runtime.error'), 'a fenced turn shows no engine error card').toHaveLength(0);
    expect(mine.filter(e => e.type === 'turn.completed'), 'one terminal, also after the gate').toHaveLength(1);
    expect([calls.onRetire, calls.onBackoff], 'retire entries, backoffs entered').toEqual([c.retires, c.backoffs]);
    expect(info.mock.calls.filter(a => String(a[0]).includes('process=spawned reason=retry')), 'no relaunch after the fence').toHaveLength(0);
    expect(watch.escaped).toEqual([]);
  });
}

// CXP: P1 (the first statement of settle) ends a claimed turn memory-refused whichever path settles it. Lease-closer-first schedule: the lease
// wins the close (settle deferred), a codex claim joins (turnOwner.fenced set, turn unsettled), then each variant ends the turn another way.
// Production writer per variant: overflow -> conn.onOverflow settle(frame_too_large); dispose / held kill -> stop("closing") -> close handler;
// crash -> close handler; unproven hook (Rule 68c dead run) -> refuseUnproven's refused turn/interrupt write joins at codex.rpc, then
// settle(scope_unavailable). The Stop-after-claim variant runs through the real Stop route in the shared LLS witness, not here.
type EndCase = { name: string; join: string; cards: number; env?: Record<string, string>; end: (h: { overFile: string; crashFile: string }) => void | Promise<void> };
const END_CASES: EndCase[] = [
  { name: 'late overflow', join: 'codex.dispatch.direct', cards: 0, end: h => writeFileSync(h.overFile, 'x') },
  { name: 'dispose', join: 'codex.dispatch.direct', cards: 0, end: async () => { const i = instance!; instance = undefined; await i.dispose(); } },
  { name: 'exit 1', join: 'codex.dispatch.direct', cards: 0, end: h => writeFileSync(h.crashFile, 'fatal') },
  { name: 'held kill (SIGTERM ignored), dispose', join: 'codex.dispatch.direct', cards: 0, env: { FAKE_CODEX_IGNORE_TERM: '1' }, end: async () => { const i = instance!; instance = undefined; await i.dispose(); } },
  // the "hook did not start" card is raised before the refused write claims the turn: one card, said once, then the refused terminal
  { name: 'unproven hook (68c dead run)', join: 'codex.rpc', cards: 1, env: { FAKE_CODEX_VERSION: 'codex-cli 0.150.0', FAKE_CODEX_HOOKS: 'dead', MURAGE_CODEX_HOOK_LIVENESS_MS: '400' }, end: () => {} },
];
for (const c of END_CASES) {
  it(`CXP ${c.name} after a lease-first refusal: one terminal, memory-refused`, async () => {
    const before = new Set(fencedRefusals());
    const watch = watchEscapes();
    cleanups.push(() => watch.stop());
    resetIsolationCache(); chmodSync(FAKE_CLI, 0o755);
    const home = join(dir, 'home'); mkdirSync(home); writeFileSync(join(home, 'config.toml'), 'model = "fixture-model"\n');
    const h = { overFile: join(dir, 'over'), crashFile: join(dir, 'crash') };
    vi.stubEnv('FAKE_CODEX_VERSION', 'codex-cli 0.128.0');
    vi.stubEnv('FAKE_CODEX_MODE', 'approval');
    vi.stubEnv('FAKE_CODEX_APPROVAL', approval(dir));
    vi.stubEnv('FAKE_CODEX_COMPLETE_ON_FILE', join(dir, 'never')); // the engine never ends the turn itself
    vi.stubEnv('FAKE_CODEX_OVERSIZE_ON_FILE', h.overFile);
    vi.stubEnv('FAKE_CODEX_EXIT_ON_FILE', h.crashFile);
    for (const [k, v] of Object.entries(c.env ?? {})) vi.stubEnv(k, v);
    const f = consumingFixture(undefined, { threadId: 'nc-codex' });
    cleanups.push(() => f.close());
    const originalWrite = Socket.prototype.write;
    vi.spyOn(Socket.prototype, 'write').mockImplementation(function (this: Socket, ...args: any[]) {
      const result = originalWrite.apply(this, args as any);
      if (String(args[0]).includes('"turn/start"')) {
        refusalFor(new EngineInputRevoked({ state: 'checking', reason: 'not-built' }), 'test.lease', { engine: 'codex', threadId: 'nc-codex', binding: f.binding, kind: 'turn', target: null });
        f.replace();
      }
      return result;
    } as any);
    instance = await CodexDriver.create({ instanceId: 'nc-codex', displayName: 'Fixture', enabled: true, environment: { CODEX_HOME: home }, config: { cli: FAKE_CLI, fullAuto: true } });
    recorder = recordEvents(instance.adapter);
    const rec = recorder;
    const sent = await instance.adapter.sendTurn(fixtureBoundTurn({ threadId: 'nc-codex', text: 'hello', cwd: dir, releaseBinding: f.binding }));
    const mine = () => fencedRefusals().filter((r): r is FencedRefusal => !before.has(r) && (r as FencedRefusal).threadId === 'nc-codex' && typeof (r as FencedRefusal).takeClose === 'function');
    await vi.waitFor(() => expect(mine()[0]?.joins).toContain(c.join), { timeout: 10_000 });
    expect(mine(), 'exactly one refusal object (K1)').toHaveLength(1);
    expect(mine()[0]!.closer, 'the lease won the close; the codex claim joined').toBe('lease');
    await c.end(h);
    await expectMemoryRefused(rec, watch, sent.turnId);
    // an explicit gate: a second terminal or a late card would follow the first terminal within this window
    await new Promise(r => setTimeout(r, 1000));
    const events = rec.events.filter(e => e.turnId === sent.turnId);
    expect(events.filter(e => e.type === 'turn.completed'), 'one terminal, also after the gate').toHaveLength(1);
    expect(events.filter(e => e.type === 'runtime.error'), 'error cards on the refused turn').toHaveLength(c.cards);
    expect(events.filter(e => e.type === 'turn.retrying'), 'a fenced turn is never relaunched').toEqual([]);
    expect(watch.escaped).toEqual([]);
  });
}

// CXP refusal during the settle proveLiveness await (row text "refusal during :1637"): P1 is read when settle is entered, so a claim that lands
// while a clean end waits for the hook proof is not covered by it. Schedule: gated build, the turn ends clean BEFORE the SessionStart hook (late
// proof), so settle(ok) enters and awaits proveLiveness; the lease refused at turn/start (closer lease, the driver close is a no-op), so the
// SessionStart hook's reply is the refused write: its claim joins at hook.socket.codex while settle is suspended, and the proof then resolves.
it('CXP refusal claimed during the settle proveLiveness await after a lease-first refusal: one terminal, memory-refused, never ok:true', async () => {
  const before = new Set(fencedRefusals());
  const watch = watchEscapes();
  cleanups.push(() => watch.stop());
  resetIsolationCache(); chmodSync(FAKE_CLI, 0o755);
  const home = join(dir, 'home'); mkdirSync(home); writeFileSync(join(home, 'config.toml'), 'model = "fixture-model"\n');
  vi.stubEnv('FAKE_CODEX_VERSION', 'codex-cli 0.150.0');
  vi.stubEnv('FAKE_CODEX_SESSION_DELAY_MS', '300'); // the clean turn/completed lands first; the proof is late
  vi.stubEnv('FAKE_CODEX_COMPLETE_BEFORE_SESSION', '1');
  vi.stubEnv('MURAGE_CODEX_HOOK_LIVENESS_MS', '8000'); // the bound never fires: the proof, not a 68c timeout, resumes settle
  const f = consumingFixture(undefined, { threadId: 'nc-codex' });
  cleanups.push(() => f.close());
  const originalWrite = Socket.prototype.write;
  vi.spyOn(Socket.prototype, 'write').mockImplementation(function (this: Socket, ...args: any[]) {
    const result = originalWrite.apply(this, args as any);
    if (String(args[0]).includes('"turn/start"')) {
      refusalFor(new EngineInputRevoked({ state: 'checking', reason: 'not-built' }), 'test.lease', { engine: 'codex', threadId: 'nc-codex', binding: f.binding, kind: 'turn', target: null });
      f.replace();
    }
    return result;
  } as any);
  instance = await CodexDriver.create({ instanceId: 'nc-codex', displayName: 'Fixture', enabled: true, environment: { CODEX_HOME: home }, config: { cli: FAKE_CLI, fullAuto: true } });
  recorder = recordEvents(instance.adapter);
  const rec = recorder;
  const sent = await instance.adapter.sendTurn(fixtureBoundTurn({ threadId: 'nc-codex', text: 'hello', cwd: dir, releaseBinding: f.binding }));
  const mine = () => fencedRefusals().filter((r): r is FencedRefusal => !before.has(r) && (r as FencedRefusal).threadId === 'nc-codex' && typeof (r as FencedRefusal).takeClose === 'function');
  await vi.waitFor(() => expect(rec.events.some(e => e.type === 'turn.completed' && e.turnId === sent.turnId)).toBe(true), { timeout: 10_000 });
  expect(mine(), 'exactly one refusal object (K1)').toHaveLength(1);
  expect(mine()[0]!.closer, 'the lease won the close').toBe('lease');
  expect(mine()[0]!.joins, 'the codex claim joined at the SessionStart reply, inside the await').toContain('hook.socket.codex');
  await expectMemoryRefused(rec, watch, sent.turnId);
  // an explicit gate: a second terminal would follow the first within this window
  await new Promise(r => setTimeout(r, 1000));
  expect(rec.events.filter(e => e.turnId === sent.turnId && e.type === 'turn.completed'), 'one terminal, also after the gate').toHaveLength(1);
  expect(watch.escaped).toEqual([]);
});
