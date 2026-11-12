import { beforeEach, describe, expect, it, vi } from 'vitest';
const seams = vi.hoisted(() => { vi.resetModules(); return { ensure: vi.fn(), all: vi.fn(), drop: vi.fn(), register: vi.fn(), serial: 0 }; });
vi.mock('./hook-canon.ts', () => ({
  ensureCanon: seams.ensure, ensureAllLive: seams.all, dropCanon: seams.drop,
  registerCanon: seams.register,
}));
import { canonFile, prepareHookCanon, ownHookCanon, checkHookCanon, checkAllHookCanon, releaseHookCanon, hookRepairNeeds, withHookRepairNeeds, HOOK_CHECK_DENIED } from './hook-safety.ts';
import { EventBus } from './harness/bus.ts';
import { HookRepairFailed, scopeLocalFailureOf } from './drivers/scoped-cli-home.ts';
const file = canonFile('/native/f', 'canonical', 'script', 'codex', '/native');
beforeEach(() => {
  seams.ensure.mockReset().mockReturnValue({ ok: true, restored: [] });
  seams.all.mockReset().mockReturnValue([]); seams.drop.mockReset();
  seams.register.mockReset().mockImplementation(files => ({ id: String(++seams.serial), files }));
});
describe('T21/T22 canonical failure routing', () => {
  for (const anchor of ['V-C1', 'V-A1', 'V-A2', 'V-A3', 'V-H1'] as const) it(`${anchor}: refused before launch with the typed failure`, () => {
    seams.ensure.mockReturnValue({ ok: false, path: file.path, why: 'mode', error: 'locked' });
    const spawn = vi.fn();
    let failure: unknown;
    try { prepareHookCanon([file], anchor, 'Fixture-' + anchor); spawn(); } catch (error) { failure = error; }
    expect(spawn).not.toHaveBeenCalled(); expect(failure).toBeInstanceOf(HookRepairFailed);
    expect(scopeLocalFailureOf(failure as HookRepairFailed)).toBe('engine-hook-repair-failed');
    expect((failure as Error).message).toContain("so this turn didn't start. Restart Murage, then send again.");
  });
  it('V-C2 revokes immediately, stops after the denial can be delivered, and raises one outstanding need', async () => {
    const set = prepareHookCanon([file], 'V-C1', 'Fixture-C2');
    const order: string[] = [];
    ownHookCanon(set, { engine: 'Fixture-C2', revoke: () => order.push('revoke'), stop: () => order.push('stop') });
    seams.ensure.mockReturnValue({ ok: false, path: file.path, why: 'mode', error: 'locked' });
    expect(checkHookCanon(set, 'V-C2', 'Fixture-C2')).toBe(false);
    order.push(HOOK_CHECK_DENIED);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(order).toEqual(['revoke', HOOK_CHECK_DENIED, 'stop']);
    const first = hookRepairNeeds().find(row => row.engine === 'Fixture-C2');
    expect(checkHookCanon(set, 'V-C2', 'Fixture-C2')).toBe(false);
    expect(hookRepairNeeds().filter(row => row.engine === 'Fixture-C2')).toEqual([first]);
    expect(withHookRepairNeeds({ decisions: 1 }, false)).toEqual({ decisions: 1 });
    expect(withHookRepairNeeds({ decisions: 1 }, true).decisions).toBe(1 + hookRepairNeeds().length);
    releaseHookCanon(set);
  });
  it('V-ANY revokes and stops the affected owner, leaving the initiating owner alone', () => {
    const otherFile = { ...file, path: '/native/other' };
    const first = prepareHookCanon([file], 'V-C1', 'initiator');
    const second = prepareHookCanon([otherFile], 'V-H1', 'affected');
    const initiator = { engine: 'initiator', revoke: vi.fn(), stop: vi.fn() };
    const affected = { engine: 'affected', revoke: vi.fn(), stop: vi.fn() };
    ownHookCanon(first, initiator); ownHookCanon(second, affected);
    seams.all.mockReturnValue([{ ok: false, path: otherFile.path, why: 'owner', error: 'unrepairable' }]);
    const bus = new EventBus();
    bus.omitLog(() => true);
    bus.publish({ type: 'item.completed', itemType: 'tool', itemId: 'foreign-write', ok: true, provider: 'cursor', threadId: 'initiator', turnId: 'turn', eventId: 'event', createdAt: new Date().toISOString() });
    expect(seams.all).toHaveBeenCalledWith('V-ANY');
    expect(affected.revoke).toHaveBeenCalledOnce(); expect(affected.stop).toHaveBeenCalledOnce();
    expect(initiator.revoke).not.toHaveBeenCalled(); expect(initiator.stop).not.toHaveBeenCalled();
    releaseHookCanon(first); releaseHookCanon(second);
  });
  it('kept child retains one canonical registration', () => {
    const first = prepareHookCanon([file], 'V-C1', 'Codex');
    expect(prepareHookCanon([file], 'V-C1', 'Codex', first)).toBe(first);
    expect(seams.register).toHaveBeenCalledOnce(); expect(seams.ensure).toHaveBeenCalledTimes(2);
    releaseHookCanon(first);
  });
});


describe('R3 delivery readiness is per set', () => {
  for (const [healthy, broken] of [['Hermes', 'Codex'], ['Codex', 'Hermes'], ['Hermes', 'Antigravity'], ['Hermes', 'Hermes']] as const) {
    it(`${broken} obstruction preserves the other ${healthy} delivery authority`, () => {
      const own = prepareHookCanon([{ ...file, path: '/native/healthy/hook' }], 'V-C1', healthy);
      const foreign = prepareHookCanon([{ ...file, path: '/native/broken/hook' }], 'V-C1', broken);
      const authority = { engine: healthy, revoke: vi.fn(), stop: vi.fn() };
      const affected = { engine: broken, revoke: vi.fn(), stop: vi.fn() };
      ownHookCanon(own, authority); ownHookCanon(foreign, affected);
      const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
      seams.all.mockReturnValue([{ ok: false, path: foreign.files[0].path, why: 'owner', error: 'obstruction' }]);
      try {
        expect(checkAllHookCanon('V-H2', own)).toBe(true);
        expect(authority.revoke).not.toHaveBeenCalled(); expect(authority.stop).not.toHaveBeenCalled();
        expect(affected.revoke).toHaveBeenCalledOnce(); expect(affected.stop).toHaveBeenCalledOnce();
        expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(broken));
        expect(log.mock.calls[0][0]).toContain(foreign.files[0].path);
      } finally { log.mockRestore(); releaseHookCanon(own); releaseHookCanon(foreign); }
    });
  }
  it('an unmapped delivery fails closed even when the scan has no failures', () => {
    expect(checkAllHookCanon('V-H2', { id: 'unknown', files: [file] })).toBe(false);
  });
  it('a missing delivery set fails closed', () => {
    expect(checkAllHookCanon('V-H2')).toBe(false);
  });
  it('an owned empty delivery set fails closed', () => {
    const set = { id: 'empty', files: [] };
    ownHookCanon(set, { engine: 'Hermes', revoke: vi.fn(), stop: vi.fn() });
    try { expect(checkAllHookCanon('V-H2', set)).toBe(false); } finally { releaseHookCanon(set); }
  });
});
