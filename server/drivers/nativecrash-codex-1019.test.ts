// SPDX-License-Identifier: AGPL-3.0-or-later
// RED-ONLY witness (cl-nativecrash): a fenced native reply refused on a path OUTSIDE HTTP containment.
// Codex handleServerRequest is dispatched as a dropped promise; the automatic approval reply is released
// through the consuming fence. Revoking the turn after turn/start makes that reply throw EngineInputRevoked.
// A server with no global handler dies on the resulting unhandledRejection; here a listener observes the
// event (a listener also suppresses the exit, so the test needs no sleep and cannot kill the worker).
import { chmodSync, mkdirSync, readFileSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR, ensureDirs } from '../config.ts';
import { CodexDriver } from './codex.ts';
import { resetIsolationCache } from './isolation-cache.ts';
import { consumingFixture } from '../testing/consuming-fixture.ts';
import { fixtureBoundTurn } from '../testing/mcp-admission-fixture.ts';
import { recordEvents, type EventRecorder } from '../testing/events.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { expectChildDischarged, expectDefinedRefusal, expectMemoryRefused, watchEscapes } from '../testing/nativecrash-harness.ts';
import { fencedRefusals, type FencedRefusal } from './engine-input.ts';
// G1 (r4): the retired `codex:protocol` record is replaced by the ONE FencedRefusal R at the dispatch site, closed once and confirmed.
const expectOneR = (records: readonly unknown[], site: string) => {
  const rs = records.filter((r): r is FencedRefusal => typeof (r as FencedRefusal).takeClose === 'function');
  expect(rs.map(r => r.site)).toEqual([site]);
  expect(rs[0]!.outcome).toBe('closed');
};
import type { ProviderInstance } from '../contracts.ts';

const FAKE_CLI = fileURLToPath(new URL('../testing/fake-codex-app-server.ts', import.meta.url));
let dir: string, instance: ProviderInstance | undefined, recorder: EventRecorder | undefined;
const cleanups: Array<() => void | Promise<void>> = [];
beforeEach(() => { ensureDirs(); mkdirSync(join(DATA_DIR, 'native'), { recursive: true }); dir = realpathSync.native(mkdtempSync(join(DATA_DIR, 'native', 'nc-codex-'))); });
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  recorder?.stop(); await instance?.dispose(); instance = undefined;
  vi.unstubAllEnvs(); vi.restoreAllMocks(); await removeTempDir(dir);
});

// Direct dispatch: hook-less Codex, automatic approval (:2620). proveLiveness().then dispatch (:2619): a hook-gated Codex whose
// hooks never run (FAKE_CODEX_HOOKS=dead-runs) asks for an approval before any SessionStart proof, so the request waits on
// proveLiveness() and is then handled by the same dropped promise.
// The live-proof variant (CX2 site): the hooks are live but SessionStart runs late (FAKE_CODEX_SESSION_DELAY_MS, a fake-side timer), so the
// request waits on proveLiveness(), which then resolves true and the SAME dropped promise answers through the fence and is refused.
for (const [name, hooked, revoke, live] of [['direct dispatch', false, true, false], ['proveLiveness().then dispatch', true, true, false], ['proveLiveness().then dispatch, control without revoke', true, false, false], ['proveLiveness().then dispatch, live proof', true, true, true]] as const) {
  it(`codex fenced automatic approval reply (${name}) neither escapes as unhandledRejection nor leaves the turn open`, async () => {
    const recordsBefore = fencedRefusals().length;
    const watch = watchEscapes();
    cleanups.push(() => watch.stop());
    resetIsolationCache(); chmodSync(FAKE_CLI, 0o755);
    const home = join(dir, 'home'); mkdirSync(home); writeFileSync(join(home, 'config.toml'), 'model = "fixture-model"\n');
    vi.stubEnv('FAKE_CODEX_VERSION', hooked ? 'codex-cli 0.150.0' : 'codex-cli 0.128.0');
    vi.stubEnv('FAKE_CODEX_DUMP', join(dir, 'dump.json'));
    vi.stubEnv('FAKE_CODEX_DUMP_ON_TERM', '1');
    if (live) {
      vi.stubEnv('FAKE_CODEX_SESSION_DELAY_MS', '50');
      vi.stubEnv('FAKE_CODEX_REQUEST_BEFORE_SESSION', '1');
      vi.stubEnv('FAKE_CODEX_MODE', 'approval');
      vi.stubEnv('FAKE_CODEX_APPROVAL', JSON.stringify({ method: 'item/fileChange/requestApproval', params: { itemId: 'nc-1', cwd: dir, fileChanges: [{ path: 'a', kind: 'add' }] } }));
    } else if (hooked) {
      vi.stubEnv('FAKE_CODEX_HOOKS', 'dead-runs');
      vi.stubEnv('MURAGE_CODEX_HOOK_LIVENESS_MS', '400');
      vi.stubEnv('FAKE_CODEX_TOOLS', JSON.stringify([{ kind: 'shell', id: 'nc-1', command: 'echo hi', cwd: dir, escalate: true, hook: false }]));
    } else {
      vi.stubEnv('FAKE_CODEX_MODE', 'approval');
      vi.stubEnv('FAKE_CODEX_APPROVAL', JSON.stringify({ method: 'item/fileChange/requestApproval', params: { itemId: 'nc-1', cwd: dir, fileChanges: [{ path: 'a', kind: 'add' }] } }));
    }
    const f = consumingFixture(undefined, { threadId: 'nc-codex' });
    cleanups.push(() => f.close());
    // Revoke right after the turn/start frame is written: the child's approval request arrives after this synchronous flip.
    const originalWrite = Socket.prototype.write;
    vi.spyOn(Socket.prototype, 'write').mockImplementation(function (this: Socket, ...args: any[]) {
      const result = originalWrite.apply(this, args as any);
      if (revoke && !live && String(args[0]).includes('"turn/start"')) f.replace();
      return result;
    } as any);
    if (revoke && live) {
      // CX5: a revoke before the session-start hook's reply is refused on the hook socket first; revoke after that reply is written so the held dispatch is the refused write.
      const originalEnd = Socket.prototype.end;
      vi.spyOn(Socket.prototype, 'end').mockImplementation(function (this: Socket, ...args: any[]) {
        const result = originalEnd.apply(this, args as any);
        if (String(args[0]).includes('{"code"')) f.replace();
        return result;
      } as any);
    }
    instance = await CodexDriver.create({ instanceId: 'nc-codex', displayName: 'Fixture', enabled: true, environment: { CODEX_HOME: home }, config: { cli: FAKE_CLI, fullAuto: !hooked || live } });
    recorder = recordEvents(instance.adapter);
    const sent = await instance.adapter.sendTurn(fixtureBoundTurn({ threadId: 'nc-codex', text: 'hello', cwd: dir, releaseBinding: f.binding }));
    if (!revoke) {
      // control: with no revoke the same request is dispatched and answered (the fake records the reply), so the revoked run below reaches the fence
      await recorder.until(e => e.type === 'turn.completed' && e.turnId === sent.turnId);
      expect(JSON.parse(readFileSync(join(dir, 'dump.json'), 'utf8')).decision, 'the proveLiveness().then dispatch answers the request').toBeDefined();
      expect(watch.escaped).toEqual([]);
      return;
    }
    if (live) {
      await expectMemoryRefused(recorder, watch, sent.turnId);
      expect(f.refusals, 'A0: the gated reply reached the fence and was refused').toBeGreaterThanOrEqual(1);
      expectChildDischarged(join(dir, 'dump.json'));
      expectOneR(fencedRefusals().slice(recordsBefore), 'codex.dispatch.gated');
      return;
    }
    if (hooked) { await expectDefinedRefusal(recorder, watch, sent.turnId); return; }
    // direct dispatch (R3 CX1): the turn names its reason, one positive local record completes, and the thread's NEXT owner turn works
    await expectMemoryRefused(recorder, watch, sent.turnId);
    expect(f.refusals, 'A0: the named sink refused (onLedgerRefused ran after the revoke)').toBeGreaterThanOrEqual(1);
    expectChildDischarged(join(dir, 'dump.json'));
    expectOneR(fencedRefusals().slice(recordsBefore), 'codex.dispatch.direct');
    const f2 = consumingFixture(undefined, { threadId: 'nc-codex' });
    cleanups.push(() => f2.close());
    const next = await instance.adapter.sendTurn(fixtureBoundTurn({ threadId: 'nc-codex', text: 'again', cwd: dir, releaseBinding: f2.binding }));
    const nextEnd = await recorder.until(e => e.type === 'turn.completed' && e.turnId === next.turnId);
    expect(nextEnd, 'the next owner turn on the thread completes after the retirement').toMatchObject({ ok: true });
    expect(watch.escaped).toEqual([]);
  });
}

