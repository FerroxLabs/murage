import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import * as nodeFs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
let api, dir;
beforeEach(async () => {
  api = await import('./update-notifications.mjs');
  dir = mkdtempSync(resolve('.update-notify-fixture-'));
});
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
function fixture(options = {}) {
  const notices = [];
  class Notification extends EventEmitter {
    static isSupported() { return options.supported !== false; }
    constructor(words) { super(); options.construct?.(); this.words = words; notices.push(this); }
    on(event, listener) { options.attach?.(event); return super.on(event, listener); }
    show = vi.fn(() => options.show?.(this));
    close = vi.fn();
  }
  let time = 1000;
  const win = { isDestroyed: () => false, isVisible: () => false, isFocused: () => false,
    isMinimized: () => false, restore: vi.fn(), show: vi.fn(), focus: vi.fn(), ...options.window };
  const state = { status: 'downloaded', version: '2.0.0', currentVersion: '1.0.18' };
  const requestNotice = vi.fn(), check = vi.fn();
  const authorization = options.authorization ?? { current: async () => ({ authorized: true }) };
  const controller = api.createUpdateNotifications({ Notification, authorization,
    recordPath: join(dir, 'receipts.json'), getWindow: () => win, getState: () => state,
    fs: options.fs, platform: options.platform, requestNotice, check, ensureWindow: options.ensureWindow, now: () => time, enabled: options.enabled !== false });
  const report = (dismissed = false) => controller.report({ version: state.version, dismissed, title: `Murage ${state.version} is ready to install` });
  return { controller, report, notices, win, state, requestNotice, check, advance: () => { time += 300001; } };
}
it('notifies for a hidden window', async () => { const f = fixture(); await f.report(); expect(f.notices).toHaveLength(1); });
it('notifies for a visible unfocused window', async () => { const f = fixture({ window: { isVisible: () => true } }); await f.report(); expect(f.notices).toHaveLength(1); });
it('keeps a focused visible window quiet', async () => { const f = fixture({ window: { isVisible: () => true, isFocused: () => true } }); await f.report(); expect(f.notices).toHaveLength(0); });
it('records once per version across restart', async () => { const f = fixture(); await Promise.all([f.report(), f.report()]); const next = fixture(); await next.report(); expect(f.notices).toHaveLength(1); expect(next.notices).toHaveLength(0); next.state.version = '2.0.1'; await next.report(); expect(next.notices).toHaveLength(1); });
it('click restores and focuses the window and requests the notice', async () => { const f = fixture({ window: { isMinimized: () => true } }); await f.report(); f.notices[0].emit('click'); expect(f.win.restore).toHaveBeenCalledOnce(); expect(f.win.show).toHaveBeenCalledOnce(); expect(f.win.focus).toHaveBeenCalledOnce(); expect(f.requestNotice).toHaveBeenCalledWith('2.0.0'); });
it('dismissed versions stay silent across restart', async () => { const f = fixture(); await f.report(true); const next = fixture(); await next.report(); expect(next.notices).toHaveLength(0); next.controller.focus(); expect(next.requestNotice).not.toHaveBeenCalled(); });
it('installed versions stay silent', async () => { const f = fixture(); f.state.currentVersion = '2.0.0'; await f.report(); expect(f.notices).toHaveLength(0); });
it('unsupported notifications leave the in-app notice intact', async () => { const f = fixture({ supported: false }); await f.report(); f.controller.focus(); expect(f.notices).toHaveLength(0); expect(f.requestNotice).toHaveBeenCalledWith('2.0.0'); });
it('denied current permission stays silent without requesting permission', async () => { const ensure = vi.fn(); const f = fixture({ authorization: { current: async () => ({ authorized: false, status: 'denied' }), ensure } }); await f.report(); await f.report(); f.controller.focus(); expect(ensure).not.toHaveBeenCalled(); expect(f.notices).toHaveLength(0); expect(f.requestNotice).toHaveBeenCalled(); });
it('requests undetermined permission once across restart', async () => { const authorization = { current: async () => ({ authorized: false, status: 'not-determined' }), ensure: vi.fn(async () => ({ authorized: false, status: 'denied' })) }; await fixture({ authorization }).report(); await fixture({ authorization }).report(); expect(authorization.ensure).toHaveBeenCalledOnce(); });
it('resume checks once per cooldown and requests the notice', async () => { const f = fixture(); await f.report(); f.controller.resume(); f.controller.resume(); expect(f.check).toHaveBeenCalledOnce(); expect(f.requestNotice).toHaveBeenCalledWith('2.0.0'); f.advance(); f.controller.resume(); expect(f.check).toHaveBeenCalledTimes(2); });
it('store and unpackaged builds cannot notify or check', async () => { for (const path of [{ packaged: true, mas: true }, { packaged: true, windowsStore: true }, { packaged: false }]) { const f = fixture({ enabled: api.updateNotificationsEnabled(path) }); await f.report(); f.controller.resume(); expect(f.notices).toHaveLength(0); expect(f.check).not.toHaveBeenCalled(); } });
it.each(['broken', JSON.stringify({ notified: [] })])('invalid receipts %s are replaced without suppressing notices', async contents => { writeFileSync(join(dir, 'receipts.json'), contents); const f = fixture(); await f.report(); await f.report(); f.controller.focus(); expect(f.notices).toHaveLength(1); expect(receipts().notified).toEqual(['2.0.0']); expect(f.requestNotice).toHaveBeenCalled(); });
it.each([
  ['unparseable', 'broken'],
  ['invalid', JSON.stringify({ notified: [] })],
])('%s receipts are recovered by a focused report without constructing a notification', async (_kind, contents) => {
  writeFileSync(join(dir, 'receipts.json'), contents);
  const construct = vi.fn();
  const f = fixture({ construct, window: { isVisible: () => true, isFocused: () => true } });
  await f.report();
  expect(construct).not.toHaveBeenCalled();
  expect(f.notices).toHaveLength(0);
  expect(receipts()).toEqual({ notified: [], dismissed: [], permissionRequested: false });
});
it('a late permission answer cannot notify a dismissed version', async () => { let resolve; const f = fixture({ authorization: { current: () => new Promise(r => { resolve = r; }) } }); const pending = f.report(); await Promise.resolve(); await f.report(true); resolve({ authorized: true }); await pending; expect(f.notices).toHaveLength(0); });

it('a ready transition can notify after the renderer window has closed', async () => {
  const f = fixture(); f.state.status = 'downloading'; await f.report();
  expect(f.notices).toHaveLength(0);
  f.win.isDestroyed = () => true;
  f.state.status = 'downloaded'; await f.controller.stateChanged();
  expect(f.notices).toHaveLength(1);
});

it.each([
  ...['focus', 'dismiss', 'install', 'version'].map(change => ({ change, name: `rechecks ${change} after current before asking permission` })),
  { change: 'storage', name: 'dismissal and version replacement during current stay silent for the old version when saving fails' },
])('$name', async ({ change }) => {
  let answer;
  const ensure = vi.fn(async () => ({ authorized: true }));
  const f = fixture({ authorization: { current: () => new Promise(r => { answer = r; }), ensure } });
  const pending = f.report();
  if (change === 'focus') { f.win.isVisible = () => true; f.win.isFocused = () => true; }
  if (change === 'dismiss') await f.report(true);
  if (change === 'install') f.state.status = 'installing';
  if (change === 'version') { f.state.version = '2.0.1'; await f.report(); }
  if (change === 'storage') {
    mkdirSync(join(dir, 'receipts.json.tmp'));
    await f.report(true);
    f.state.version = '2.0.1'; await f.report();
  }
  answer({ status: 'not-determined', authorized: false }); await pending;
  expect(ensure).not.toHaveBeenCalled();
  expect(f.notices).toHaveLength(0);
  const path = join(dir, 'receipts.json');
  if (existsSync(path)) expect(JSON.parse(readFileSync(path, 'utf8')).permissionRequested).toBe(false);
  if (change === 'storage') expect(existsSync(path)).toBe(false);
  if (change === 'version') {
    answer({ status: 'authorized', authorized: true });
    await Promise.resolve(); await Promise.resolve();
    expect(f.notices).toHaveLength(1);
    expect(JSON.parse(readFileSync(path, 'utf8')).notified).toEqual(['2.0.1']);
    expect(f.notices[0].words.title).toBe('Murage 2.0.1 is ready to install');
  }
});
it('refreshes cached report words while permission is pending', async () => {
  let answer;
  const f = fixture({ authorization: { current: () => new Promise(r => { answer = r; }) } });
  const pending = f.report();
  await f.controller.report({ version: '2.0.0', title: 'Neue Version bereit', dismissed: false });
  answer({ authorized: true }); await pending;
  expect(f.notices[0].words.title).toBe('Neue Version bereit');
});

it.each(['focus', 'dismiss', 'install', 'version'])('rechecks %s after ensure completes', async (change) => {
  let answer;
  const current = vi.fn(async () => ({ status: 'not-determined', authorized: false }));
  const ensure = vi.fn(() => new Promise(r => { answer = r; }));
  const f = fixture({ authorization: { current, ensure } });
  const pending = f.report();
  await Promise.resolve();
  expect(ensure).toHaveBeenCalledOnce();
  await f.report();
  expect(ensure).toHaveBeenCalledOnce();
  if (change === 'focus') { f.win.isVisible = () => true; f.win.isFocused = () => true; }
  if (change === 'dismiss') await f.report(true);
  if (change === 'install') f.state.status = 'installing';
  if (change === 'version') f.state.version = '2.0.1';
  answer({ status: 'authorized', authorized: true }); await pending;
  expect(f.notices).toHaveLength(0);
  expect(JSON.parse(readFileSync(join(dir, 'receipts.json'), 'utf8')).notified).toEqual([]);
  expect(current).toHaveBeenCalledOnce();
});
it.each(['not-determined', 'unavailable', 'throws'])('unfinished permission %s remains retryable across restart', async (status) => {
  const ensure = vi.fn(async () => {
    if (status === 'throws') throw Error('interrupted');
    return { status, authorized: false };
  });
  const authorization = { current: async () => ({ status: 'not-determined' }), ensure };
  await fixture({ authorization }).report();
  await fixture({ authorization }).report();
  expect(ensure).toHaveBeenCalledTimes(2);
});
it('a process exiting during ensure does not burn permission on restart', async () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createUpdateNotifications } from ${JSON.stringify(new URL('./update-notifications.mjs', import.meta.url).href)};
    const controller = createUpdateNotifications({
      Notification: { isSupported: () => true },
      authorization: { current: async () => ({ status: 'not-determined' }), ensure: () => process.exit(42) },
      recordPath: ${JSON.stringify(join(dir, 'receipts.json'))}, getWindow: () => null,
      getState: () => ({ status: 'downloaded', version: '2.0.0', currentVersion: '1.0.18' }),
    });
    await controller.report({ version: '2.0.0', title: 'Ready' });
  `], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(42);
  const ensure = vi.fn(async () => ({ status: 'denied', authorized: false }));
  await fixture({ authorization: { current: async () => ({ status: 'not-determined' }), ensure } }).report();
  expect(ensure).toHaveBeenCalledOnce();
});
it.each(['ok', 'file-sync-fails', 'directory-sync-unsupported'])('durable receipt order: %s', async (mode) => {
  const calls = [];
  const fs = { ...nodeFs };
  for (const name of ['openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync']) {
    fs[name] = (...args) => {
      calls.push([name, ...args]);
      if (name === 'fsyncSync' && (mode === 'file-sync-fails' ||
          (mode === 'directory-sync-unsupported' && calls.filter(c => c[0] === 'fsyncSync').length === 2))) throw Object.assign(Error('sync failed'), { code: mode === 'directory-sync-unsupported' ? 'EINVAL' : 'EIO' });
      return nodeFs[name](...args);
    };
  }
  const f = fixture({ fs }); await f.report();
  const names = calls.map(c => c[0]);
  expect(calls[0]).toEqual(['openSync', join(dir, 'receipts.json.tmp'), 'w', 0o600]);
  expect(typeof calls[1][1]).toBe('number');
  if (mode === 'file-sync-fails') {
    expect(names).toEqual(['openSync', 'writeFileSync', 'fsyncSync', 'closeSync']);
    expect(f.notices).toHaveLength(1);
    f.state.version = '2.0.1'; await f.report();
    expect(f.notices).toHaveLength(2);
    expect(calls).toHaveLength(12);
  } else {
    expect(names).toEqual(['openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync', 'openSync', 'fsyncSync', 'closeSync']);
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0].show).toHaveBeenCalledOnce();
  }
});
it('a newer report during ensure gets one follow-up and never loops', async () => {
  let answer, followUp;
  const current = vi.fn()
    .mockResolvedValueOnce({ status: 'not-determined', authorized: false })
    .mockImplementationOnce(() => new Promise(r => { followUp = r; }));
  const ensure = vi.fn(() => new Promise(r => { answer = r; }));
  const f = fixture({ authorization: { current, ensure } });
  const pending = f.report(); await Promise.resolve();
  f.state.version = '2.0.1'; await f.report();
  answer({ status: 'authorized', authorized: true }); await pending;
  expect(f.notices).toHaveLength(0);
  expect(JSON.parse(readFileSync(join(dir, 'receipts.json'), 'utf8')).notified).toEqual([]);
  followUp({ status: 'authorized', authorized: true }); await Promise.resolve();
  expect(f.notices).toHaveLength(1);
  expect(f.notices[0].show).toHaveBeenCalledOnce();
  expect(JSON.parse(readFileSync(join(dir, 'receipts.json'), 'utf8')).notified).toEqual(['2.0.1']);
  await f.controller.stateChanged();
  expect(current).toHaveBeenCalledTimes(2);
  expect(ensure).toHaveBeenCalledOnce();
  expect(f.notices).toHaveLength(1);
});

it.each(['not-determined', 'unavailable', 'throws', 'timeout'])('asks once per process after unfinished %s, then observes authorization', async (status) => {
  vi.useFakeTimers();
  try {
    let answer;
    const current = vi.fn(async () => ({ status: 'not-determined', authorized: false }));
    const ensure = vi.fn(() => new Promise((resolve, reject) => {
      answer = () => status === 'throws' ? reject(Error('interrupted')) : resolve({ status: status === 'timeout' ? 'unavailable' : status, authorized: false });
      if (status === 'timeout') setTimeout(answer, 60000);
    }));
    const f = fixture({ authorization: { current, ensure } });
    const pending = f.report(); await Promise.resolve();
    await f.controller.stateChanged(); await f.report();
    expect(ensure).toHaveBeenCalledOnce();
    if (status === 'timeout') await vi.advanceTimersByTimeAsync(60000); else answer();
    await pending;
    await f.controller.stateChanged(); await f.report();
    expect(ensure).toHaveBeenCalledOnce();
    expect(f.notices).toHaveLength(0);
    expect(existsSync(join(dir, 'receipts.json'))).toBe(false);
    current.mockResolvedValue({ status: 'authorized', authorized: true });
    await f.controller.stateChanged();
    expect(ensure).toHaveBeenCalledOnce();
    expect(f.notices).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});
it.each(['openSync', 'fsyncSync', 'closeSync'].flatMap(operation =>
  ['EIO', 'EACCES', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EISDIR', 'EPERM'].map(code => [operation, code])))('directory %s handles %s by platform', async (operation, code) => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    rmSync(join(dir, 'receipts.json'), { force: true });
    let directory, failed = false;
    const write = vi.fn(nodeFs.writeFileSync);
    const fs = { ...nodeFs, writeFileSync: write,
      openSync: (...args) => {
        if (args[0] !== dir) directory = undefined;
        if (args[0] === dir && operation === 'openSync') { failed = true; throw Object.assign(Error(code), { code }); }
        const fd = nodeFs.openSync(...args); if (args[0] === dir) directory = fd; return fd;
      },
      closeSync: fd => {
        nodeFs.closeSync(fd);
        if (fd === directory && operation === 'closeSync') { failed = true; throw Object.assign(Error(code), { code }); }
      },
      fsyncSync: fd => {
        if (fd === directory && operation === 'fsyncSync') { failed = true; throw Object.assign(Error(code), { code }); }
        return nodeFs.fsyncSync(fd);
      },
    };
    const f = fixture({ fs, platform }); await f.report();
    expect(failed).toBe(true);
    expect(f.notices).toHaveLength(1);
    expect(receipts().notified).toEqual(['2.0.0']);
    await f.report(); expect(f.notices).toHaveLength(1);
    expect(write).toHaveBeenCalledOnce();
    f.state.version = '2.0.1'; await f.report();
    expect(f.notices).toHaveLength(2);
    expect(write).toHaveBeenCalledTimes(2);
    expect(receipts().notified).toEqual(['2.0.0', '2.0.1']);
    const next = fixture(); next.state.version = '2.0.1'; await next.report();
    expect(next.notices).toHaveLength(0);
  }
});

function receipts() { return JSON.parse(readFileSync(join(dir, 'receipts.json'), 'utf8')); }
function diskFault(operation = 'writeFileSync') {
  let broken = true;
  const writes = vi.fn();
  const fs = { ...nodeFs, writeFileSync: (...args) => { writes(); return nodeFs.writeFileSync(...args); } };
  const original = fs[operation];
  fs[operation] = (...args) => {
    if (broken) {
      if (operation === 'closeSync') nodeFs.closeSync(...args);
      throw Object.assign(Error('disk'), { code: 'EIO' });
    }
    return original(...args);
  };
  return { fs, writes, recover: () => { broken = false; }, break: () => { broken = true; } };
}
it('show precedes the notification receipt, independently of the permission write', async () => {
  const order = [];
  const fs = { ...nodeFs, writeFileSync: (fd, text) => {
    order.push(JSON.parse(text).notified.length ? 'receipt' : 'permission');
    return nodeFs.writeFileSync(fd, text);
  } };
  const f = fixture({ fs, show: () => order.push('show'), authorization: {
    current: async () => ({ status: 'not-determined' }),
    ensure: async () => ({ status: 'authorized', authorized: true }),
  } });
  await f.report(); await f.report();
  expect(order).toEqual(['permission', 'show', 'receipt']);
  expect(f.notices).toHaveLength(1);
  expect(receipts()).toEqual({ notified: ['2.0.0'], dismissed: [], permissionRequested: true });
});
it('a process exiting after show before the receipt can notify on restart', async () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import * as fs from 'node:fs';
    import { createUpdateNotifications } from ${JSON.stringify(new URL('./update-notifications.mjs', import.meta.url).href)};
    let shown = false;
    class Notification {
      static isSupported() { return true; }
      on() {}
      show() { shown = true; }
    }
    const controller = createUpdateNotifications({ Notification,
      authorization: { current: async () => ({ authorized: true }) },
      recordPath: ${JSON.stringify(join(dir, 'receipts.json'))}, getWindow: () => null,
      getState: () => ({ status: 'downloaded', version: '2.0.0' }),
      fs: { ...fs, writeFileSync: () => process.exit(shown ? 42 : 43) },
    });
    await controller.report({ version: '2.0.0', title: 'Ready' });
  `], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
  expect(child.error).toBeUndefined(); expect(child.status).toBe(42);
  expect(existsSync(join(dir, 'receipts.json'))).toBe(false);
  const next = fixture(); await next.report(); await next.report();
  expect(next.notices).toHaveLength(1); expect(receipts().notified).toEqual(['2.0.0']);
});
it.each(['construct', 'attach', 'show', 'synchronous failed'])('%s failure leaves no receipt and retries only on a later report', async mode => {
  let fail = true;
  const throws = () => { if (fail) throw Error('OS'); };
  const f = fixture({
    construct: mode === 'construct' ? throws : undefined,
    attach: mode === 'attach' ? throws : undefined,
    show: mode === 'synchronous failed' ? notice => { if (fail) notice.emit('failed'); } : mode === 'show' ? throws : undefined,
  });
  await f.report();
  expect(f.notices).toHaveLength(mode === 'construct' ? 0 : 1);
  expect(existsSync(join(dir, 'receipts.json'))).toBe(false);
  fail = false; await f.report(); await f.report();
  expect(f.notices).toHaveLength(mode === 'construct' ? 1 : 2);
  expect(receipts().notified).toEqual(['2.0.0']);
});
it('failed rollback is idempotent; stale events cannot remove a replacement', async () => {
  const f = fixture(); await f.report(); const old = f.notices[0];
  old.emit('failed'); old.emit('failed'); old.emit('close');
  expect(receipts().notified).toEqual([]);
  await f.report(); const replacement = f.notices[1];
  old.emit('failed'); old.emit('close');
  expect(receipts().notified).toEqual(['2.0.0']);
  await f.report(true); expect(replacement.close).toHaveBeenCalledOnce();
  replacement.emit('failed'); await f.report();
  expect(receipts().dismissed).toEqual(['2.0.0']);
  expect(receipts().notified).toEqual([]); expect(f.notices).toHaveLength(2);
});
it('throw then late failed and stale close preserve replacement ownership', async () => {
  let fail = true;
  const f = fixture({ show: () => { if (fail) throw Error('OS accepted then threw'); } });
  await f.report(); fail = false; await f.report();
  f.notices[0].emit('failed'); f.notices[0].emit('close');
  expect(receipts().notified).toEqual(['2.0.0']);
  await f.report(); expect(f.notices).toHaveLength(2);
  await f.report(true); expect(f.notices[1].close).toHaveBeenCalledOnce();
  expect(f.notices[0].close).not.toHaveBeenCalled();
});
it('ordinary close keeps the receipt', async () => {
  const f = fixture(); await f.report(); f.notices[0].emit('close');
  await f.report(); await f.report(true);
  expect(f.notices).toHaveLength(1); expect(f.notices[0].close).not.toHaveBeenCalled();
  expect(receipts().notified).toEqual(['2.0.0']);
});
it('three constructor attempts cap each version independently and restart resets the cap', async () => {
  const construct = vi.fn(() => { throw Error('OS'); });
  const writeFileSync = vi.fn(nodeFs.writeFileSync);
  const f = fixture({ construct, fs: { ...nodeFs, writeFileSync } });
  for (let i = 0; i < 4; i++) await f.report();
  expect(construct).toHaveBeenCalledTimes(3); expect(writeFileSync).not.toHaveBeenCalled();
  expect(existsSync(join(dir, 'receipts.json'))).toBe(false);
  f.state.version = '2.0.1'; await f.report(); expect(construct).toHaveBeenCalledTimes(4);
  await fixture({ construct }).report(); expect(construct).toHaveBeenCalledTimes(5);
  expect(f.notices).toHaveLength(0);
});
it.each(['openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync'])('%s failure allows only one notification per version per launch', async operation => {
  const old = { notified: ['old'], dismissed: [], permissionRequested: false };
  writeFileSync(join(dir, 'receipts.json'), JSON.stringify(old));
  const fault = diskFault(operation); const f = fixture(fault);
  await f.report(); await f.report(); f.controller.focus();
  expect(f.notices).toHaveLength(1); expect(f.notices[0].show).toHaveBeenCalledOnce();
  expect(receipts()).toEqual(old);
  expect(f.requestNotice).toHaveBeenCalledWith('2.0.0');
  const next = fixture(fault); await next.report(); await next.report();
  expect(next.notices).toHaveLength(1);
  expect(receipts()).toEqual(old);
});
it('next report recovers a failed save without another notification', async () => {
  const fault = diskFault(); const f = fixture(fault); await f.report();
  expect(existsSync(join(dir, 'receipts.json'))).toBe(false);
  fault.recover(); await f.report();
  expect(f.notices).toHaveLength(1); expect(receipts().notified).toEqual(['2.0.0']);
  const next = fixture(); await next.report(); expect(next.notices).toHaveLength(0);
});
it('cap still permits next-report recovery of a failed take-back save; restart before recovery stays silent', async () => {
  const fault = diskFault(); fault.recover(); const f = fixture(fault);
  for (let i = 0; i < 3; i++) {
    await f.report(); if (i === 2) fault.break();
    expect(() => f.notices[i].emit('failed')).not.toThrow();
    f.notices[i].emit('failed'); f.notices[i].emit('close');
  }
  expect(receipts().notified).toEqual(['2.0.0']);
  const stale = fixture(); await stale.report(); expect(stale.notices).toHaveLength(0);
  fault.recover(); const before = fault.writes.mock.calls.length;
  await f.report(); expect(fault.writes).toHaveBeenCalledTimes(before + 1);
  expect(f.notices).toHaveLength(3); expect(receipts().notified).toEqual([]);
  await f.report(); expect(fault.writes).toHaveBeenCalledTimes(before + 1);
  const next = fixture(); await next.report(); expect(next.notices).toHaveLength(1);
});
it.each(['EIO', 'EACCES'])('%s read errors preserve valid disk records and merge recovery', async code => {
  const original = { notified: ['2.0.0', 'old'], dismissed: ['2.0.0'], permissionRequested: true };
  writeFileSync(join(dir, 'receipts.json'), JSON.stringify(original));
  let broken = true;
  const write = vi.fn(nodeFs.writeFileSync);
  const fs = { ...nodeFs, writeFileSync: write, readFileSync: (...args) => {
    if (broken) throw Object.assign(Error(code), { code }); return nodeFs.readFileSync(...args);
  } };
  const f = fixture({ fs }); await f.report(); await f.report(); f.controller.focus();
  expect(f.notices).toHaveLength(1); expect(write).not.toHaveBeenCalled();
  expect(f.requestNotice).toHaveBeenCalledWith('2.0.0'); expect(receipts()).toEqual(original);
  const next = fixture({ fs }); await next.report(); expect(next.notices).toHaveLength(1);
  f.notices[0].emit('failed'); await f.report(true);
  broken = false;
  await f.controller.report({ version: 'wrong', title: 'Ready' });
  await f.controller.report({ version: '2.0.0', title: '' });
  expect(write).not.toHaveBeenCalled();
  await f.report(); expect(write).toHaveBeenCalledOnce();
  expect(receipts()).toEqual({ ...original, notified: ['old'] }); expect(f.notices).toHaveLength(1);
  const recovered = fixture(); await recovered.report(); expect(recovered.notices).toHaveLength(0);
});
it.each(['construct', 'show', 'synchronous failed'])('a %s failure during a read error keeps the receipt an earlier launch left on disk', async mode => {
  const original = { notified: ['2.0.0'], dismissed: [], permissionRequested: false };
  writeFileSync(join(dir, 'receipts.json'), JSON.stringify(original));
  let broken = true;
  const fs = { ...nodeFs, readFileSync: (...args) => {
    if (broken) throw Object.assign(Error('read'), { code: 'EIO' }); return nodeFs.readFileSync(...args);
  } };
  const construct = vi.fn(() => { if (mode === 'construct') throw Error('OS'); });
  const f = fixture({ fs, construct, show: notice => {
    if (mode === 'show') throw Error('OS');
    if (mode === 'synchronous failed') notice.emit('failed');
  } });
  await f.report();
  expect(construct).toHaveBeenCalledOnce(); expect(receipts()).toEqual(original);
  broken = false;
  await f.report();
  expect(construct).toHaveBeenCalledOnce(); expect(receipts()).toEqual(original);
  const next = fixture(); await next.report(); expect(next.notices).toHaveLength(0);
});
it('a first-read error recovers a dismissal before constructing a notification', async () => {
  writeFileSync(join(dir, 'receipts.json'), JSON.stringify({ notified: [], dismissed: ['2.0.0'], permissionRequested: true }));
  const read = vi.fn(nodeFs.readFileSync).mockImplementationOnce(() => { throw Object.assign(Error('read'), { code: 'EIO' }); });
  const f = fixture({ fs: { ...nodeFs, readFileSync: read } }); await f.report();
  expect(f.notices).toHaveLength(0); expect(receipts().dismissed).toEqual(['2.0.0']);
});
it('failed permission saves still allow authorized notification and ensure once per launch', async () => {
  const fault = diskFault();
  const ensure = vi.fn(async () => ({ status: 'authorized', authorized: true }));
  const current = vi.fn(async () => ({ status: 'not-determined' }));
  const f = fixture({ ...fault, authorization: { current, ensure } });
  await f.report(); await f.report(); expect(ensure).toHaveBeenCalledOnce(); expect(f.notices).toHaveLength(1);
  expect(existsSync(join(dir, 'receipts.json'))).toBe(false);
  f.state.version = '2.0.1'; await f.report();
  // This unnotified version reaches permission evaluation; the in-memory
  // permission request guards must prevent another ensure despite failed saves.
  expect(current).toHaveBeenCalledTimes(2);
  expect(await current.mock.results[1].value).toEqual({ status: 'not-determined' });
  expect(ensure).toHaveBeenCalledOnce(); expect(f.notices).toHaveLength(1);
  expect(existsSync(join(dir, 'receipts.json'))).toBe(false);
  // Confirm the second version can notify as soon as current authorizes it.
  current.mockResolvedValue({ status: 'authorized', authorized: true });
  await f.report();
  expect(f.notices).toHaveLength(2);
  expect(f.notices[1].words.title).toBe('Murage 2.0.1 is ready to install');
  expect(ensure).toHaveBeenCalledOnce();
  expect(existsSync(join(dir, 'receipts.json'))).toBe(false);
  fault.recover(); await f.report(); expect(receipts().permissionRequested).toBe(true);
  const next = fixture(); await next.report(); expect(next.notices).toHaveLength(0);
});
it('failed dismissal save during ensure stays silent through answer, recovery and recovered restart', async () => {
  const fault = diskFault(); let answer;
  const ensure = vi.fn(() => new Promise(resolve => { answer = resolve; }));
  const f = fixture({ ...fault, authorization: { current: async () => ({ status: 'not-determined' }), ensure } });
  const pending = f.report(); await Promise.resolve(); await f.report(true);
  answer({ status: 'authorized', authorized: true }); await pending; await f.report();
  // The dismissed version is silent after the answer; dismissal itself blocks retries.
  expect(ensure).toHaveBeenCalledOnce(); expect(f.notices).toHaveLength(0);
  expect(existsSync(join(dir, 'receipts.json'))).toBe(false);
  const lost = fixture(); await lost.report(); expect(lost.notices).toHaveLength(1);
  fault.recover(); await f.report();
  expect(receipts()).toEqual({ notified: [], dismissed: ['2.0.0'], permissionRequested: true });
  expect(f.notices).toHaveLength(0);
  const next = fixture(); await next.report(); expect(next.notices).toHaveLength(0);
});
it.each(['unsupported', 'denied', 'throws'])('%s consumes no attempt or receipt', async mode => {
  let rejected = true;
  const options = { supported: mode !== 'unsupported', authorization: { current: async () => {
    if (rejected && mode === 'throws') throw Error('permission');
    return { authorized: !rejected };
  } } };
  const write = vi.fn(nodeFs.writeFileSync); options.fs = { ...nodeFs, writeFileSync: write };
  const f = fixture(options); for (let i = 0; i < 4; i++) await f.report();
  expect(f.notices).toHaveLength(0); expect(write).not.toHaveBeenCalled();
  rejected = false; options.supported = true; await f.report();
  expect(f.notices).toHaveLength(1); expect(receipts().notified).toEqual(['2.0.0']);
});
