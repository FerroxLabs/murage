// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createBrowserExtensionRuntime } from '../extensions/murage-browser/runtime.mjs';
const swSource = readFileSync(new URL('../extensions/murage-browser/service-worker.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/m, '');
const manifest = JSON.parse(readFileSync(new URL('../extensions/murage-browser/manifest.json', import.meta.url), 'utf8'));
const settle = () => new Promise(resolve => setImmediate(resolve));
const event = () => { const l = new Set(); return { addListener: f => l.add(f), removeListener: f => l.delete(f), fire: (...a) => Promise.all([...l].map(f => f(...a))) }; };
function runtimeFixture(stored = {}) {
  const tabs = new Map(); let next = 1; const completed = event();
  const api = {
    webNavigation: completed && { onCompleted: completed },
    storage: { local: { get: async key => ({ [key]: stored[key] }), set: async value => Object.assign(stored, structuredClone(value)) } },
    runtime: { getManifest: () => ({ version: '0.1.0' }) },
    tabs: { create: async ({ url }) => { const tab = { id: next++, url }; tabs.set(tab.id, tab); await completed.fire({ tabId: tab.id, frameId: 0, url }); return tab; }, get: async id => tabs.get(id), group: async () => 42 },
    tabGroups: { update: async () => {} }, action: { setBadgeText: async () => {} },
    debugger: { attach: async () => {}, detach: vi.fn(async () => {}), sendCommand: vi.fn(async (_s, method, params = {}) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'observer-script' };
      if (method === 'Runtime.evaluate' && params.expression?.startsWith('globalThis.__murageTakeover?.')) return { result: { type: 'boolean', value: params.expression.includes('.arm(') } };
      return { value: 'owned' };
    }) },
  };
  const events = [];
  const runtime = createBrowserExtensionRuntime(api, { uuid: () => 'profile_1', emit: e => events.push(e) });
  let seq = 0; let nonce = 'a'.repeat(32);
  const command = (operation, params = {}, generation = 1) => runtime.handleRequest({ version: 1, type: 'command', id: `${nonce}_${++seq}`, bindingId: 'bot_a', generation, operation, params });
  const start = async () => { await runtime.initialize(); await runtime.connection(true); seq = 0; return command('bind', { profileId: 'profile_1', botName: 'Dax', approvedOrigins: ['https://allowed.test'] }); };
  return { api, runtime, command, start, stored, events, tabs };
}
describe('T44 runtime lifecycle', () => {
  it('a replaced owned tab is dropped and the new id is never re-attached', async () => {
    const f = runtimeFixture(); await f.start();
    await f.runtime.replaced(50, 1);
    expect(f.events.some(e => e.event === 'unshared' && e.data.tabId === 1)).toBe(true);
    expect((await f.runtime.handlePanel({ action: 'status' })).bindings[0].tabs.map(t => t.tabId)).not.toContain(50);
    expect(f.api.debugger.sendCommand).not.toHaveBeenCalledWith({ tabId: 50 }, expect.anything(), expect.anything());
  });
  it('a discarded owned tab advances its epoch so the old snapshot is stale', async () => {
    const f = runtimeFixture(); await f.start();
    const before = (await f.runtime.handlePanel({ action: 'status' })).bindings[0].tabs[0].navigationEpoch;
    await f.runtime.discarded(1);
    const after = (await f.runtime.handlePanel({ action: 'status' })).bindings[0].tabs[0].navigationEpoch;
    expect(after).toBe(before + 1);
    expect(f.events.some(e => e.event === 'notice' && e.data.kind === 'tab_discarded' && e.data.tabId === 1)).toBe(true);
    const r = await f.command('cdp', { method: 'Runtime.evaluate', tabId: 1, navigationEpoch: before }, 1);
    expect(r.error.code).not.toBe(undefined);
  });
  it('a discard of a tab that is not owned does nothing', async () => {
    const f = runtimeFixture(); await f.start(); const n = f.events.length;
    await f.runtime.discarded(999); await f.runtime.replaced(5, 999);
    expect(f.events.length).toBe(n);
  });
  it('a closed window removes its tabs and emits unshared for each', async () => {
    const f = runtimeFixture(); await f.start();
    await f.runtime.removed(1);
    expect(f.events.filter(e => e.event === 'unshared')).toHaveLength(1);
  });
  it('driving() reports an active bound task and pauseDriving pauses it', async () => {
    const f = runtimeFixture(); await f.start();
    expect(f.runtime.driving()).toBe(true);
    expect(await f.runtime.pauseDriving()).toBe(1);
    expect(f.runtime.driving()).toBe(false);
    expect(f.stored.murageBrowserState.bindings[0].state).toBe('paused');
  });
  it('an action in flight when the worker dies is never replayed and is reported uncertain', async () => {
    const stored = {}; const f = runtimeFixture(stored); await f.start();
    f.tabs.get(1).url = 'https://allowed.test/p'; await f.runtime.navigation({ tabId: 1, frameId: 0, url: 'https://allowed.test/p' });
    expect((await f.command('cdp', { method: 'Page.enable', tabId: 1, navigationEpoch: 2 })).error).toBeUndefined();
    let release; f.api.debugger.sendCommand.mockImplementation(() => new Promise(r => { release = r; }));
    const id = `${'a'.repeat(32)}_3`;
    // A call on a node may have acted, so it is the kind that is journaled (a read or a setup call writes nothing).
    void f.runtime.handleRequest({ version: 1, type: 'command', id, bindingId: 'bot_a', generation: 1, operation: 'cdp', params: { method: 'Runtime.callFunctionOn', tabId: 1, navigationEpoch: 2 } });
    await settle();
    expect(stored.murageBrowserState.inFlight?.id).toBe(id);
    // The worker dies: a new runtime starts from the same storage.
    const g = runtimeFixture(stored); await g.runtime.initialize(); await g.runtime.connection(true);
    const reports = g.runtime.restartReports();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ type: 'response', id, bindingId: 'bot_a', error: { code: 'uncertain' } });
    expect(g.runtime.restartReports()).toHaveLength(0);
    expect(stored.murageBrowserState.inFlight).toBeUndefined();
    release?.({});
  });
  it('a finished action leaves no in-flight record', async () => {
    const f = runtimeFixture(); await f.start();
    await f.command('cdp', { method: 'Page.enable', tabId: 1, navigationEpoch: 1 });
    expect(f.stored.murageBrowserState.inFlight).toBeUndefined();
  });
  it('an older app (protocol below the minimum) is refused with update_murage', async () => {
    const f = runtimeFixture(); await f.runtime.initialize(); await f.runtime.connection(true);
    const r = await f.runtime.handleRequest({ version: 1, type: 'command', id: `${'b'.repeat(32)}_1`, bindingId: 'bot_a', generation: 1, operation: 'bind', params: { profileId: 'profile_1', approvedOrigins: [], appProtocol: 0 } });
    expect(r.error.code).toBe('update_murage');
  });
});
describe('T44 service worker lifecycle wiring', () => {
  async function swFixture() {
    const ports = [], reloads = vi.fn(), sent = [];
    const ev = {}; const e = name => (ev[name] = event());
    const api = {
      runtime: { id: 'fixture', getURL: p => `chrome-extension://fixture/${p}`, getManifest: () => ({ version: '0.1.0' }), onMessage: e('onMessage'), onUpdateAvailable: e('onUpdateAvailable'), reload: reloads, sendMessage: vi.fn(async m => { sent.push(m); }),
        connectNative: vi.fn(() => { const c = { onMessage: event(), onDisconnect: event(), messages: [] }; c.postMessage = m => c.messages.push(structuredClone(m)); c.disconnect = vi.fn(); ports.push(c); return c; }) },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      webNavigation: { onCompleted: event(), onCreatedNavigationTarget: event(), onCommitted: event(), onHistoryStateUpdated: event(), onReferenceFragmentUpdated: event() },
      tabs: { onRemoved: event(), onCreated: event(), onReplaced: e('tabsReplaced'), onUpdated: e('tabsUpdated'), get: async () => ({}), create: async () => ({ id: 1 }), group: async () => 1 },
      tabGroups: { update: async () => {} }, action: { setBadgeText: async () => {} },
      debugger: { onDetach: event(), onEvent: event(), attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) },
      downloads: { onCreated: event(), onDeterminingFilename: event() },
      alarms: { create: () => {}, onAlarm: e('onAlarm') }, sidePanel: { setPanelBehavior: async () => {} },
      idle: { onStateChanged: e('idle') }, commands: { onCommand: e('command') },
    };
    let rt;
    runInNewContext(swSource, { chrome: api, createBrowserExtensionRuntime: (c, o) => {
      rt = createBrowserExtensionRuntime(c, { ...o, uuid: () => 'profile_1' });
      // X1 owns the real in-flight hook; this worker fixture supplies its contract.
      rt.busy = vi.fn(() => false);
      return rt;
    }, setTimeout: () => 1, clearTimeout: () => {} });
    await settle();
    await ports[0].onMessage.fire({ version: 1, type: 'command', id: `${'a'.repeat(32)}_1`, bindingId: 'bot_a', generation: 1, operation: 'bind', params: { profileId: 'profile_1', botName: 'Dax', approvedOrigins: ['https://allowed.test'] } });
    return { api, ev, ports, reloads, sent, rt };
  }
  it('defers an update while busy, then reloads when the hook reports idle', async () => {
    const f = await swFixture();
    f.rt.busy.mockReturnValue(true);
    await f.ev.onUpdateAvailable.fire({ version: '9' }); await settle();
    expect(f.reloads).not.toHaveBeenCalled();
    expect(f.sent.some(m => m.type === 'update_pending' && m.botName === 'Dax')).toBe(true);
    f.rt.busy.mockReturnValue(false);
    await f.ev.onAlarm.fire({ name: 'murage-update' }); await settle();
    expect(f.reloads).toHaveBeenCalledTimes(1);
  });
  it('reloads at once when idle even if a binding remains active', async () => {
    const f = await swFixture();
    expect(f.rt.driving()).toBe(true);
    await f.ev.onUpdateAvailable.fire({}); await settle();
    expect(f.reloads).toHaveBeenCalledTimes(1);
  });
  it('the pause command pauses the driving binding and other commands do nothing', async () => {
    const f = await swFixture();
    await f.ev.command.fire('something-else'); await settle(); expect(f.rt.driving()).toBe(true);
    await f.ev.command.fire('pause'); await settle(); expect(f.rt.driving()).toBe(false);
  });
  it('after locked then active the host is re-probed and a paused binding stays paused', async () => {
    const f = await swFixture(); await f.rt.pauseDriving();
    await f.ev.idle.fire('locked'); await f.ev.idle.fire('active'); await settle();
    expect(f.ports[0].disconnect).toHaveBeenCalled();
    expect(f.rt.driving()).toBe(false);
  });
  it('active without a prior lock does not re-probe', async () => {
    const f = await swFixture(); await f.ev.idle.fire('active'); await settle();
    expect(f.ports[0].disconnect).not.toHaveBeenCalled();
  });
  it('tabs.onReplaced and a discard are routed to the runtime', async () => {
    const f = await swFixture(); const replaced = vi.spyOn(f.rt, 'replaced'); const discarded = vi.spyOn(f.rt, 'discarded');
    await f.ev.tabsReplaced.fire(7, 1); await f.ev.tabsUpdated.fire(1, { discarded: true }); await f.ev.tabsUpdated.fire(1, { status: 'loading' }); await settle();
    expect(replaced).toHaveBeenCalledWith(7, 1); expect(discarded).toHaveBeenCalledTimes(1);
  });
  it('posts the hello first on connect', async () => {
    const f = await swFixture(); expect(f.ports[0].messages[0].type).toBe('hello');
  });
});
describe('T44 manifest', () => {
  it('declares idle and a Pause command with the Alt+Shift+P default', () => {
    expect(manifest.permissions).toContain('idle');
    expect(manifest.commands.pause.suggested_key.default).toBe('Alt+Shift+P');
    expect(typeof manifest.commands.pause.description).toBe('string');
    // idle is not a permission class that adds an install warning; the list otherwise only gains idle.
    expect(manifest.permissions.sort()).toEqual(['alarms','debugger','downloads','idle','nativeMessaging','sidePanel','storage','tabGroups','tabs','webNavigation']);
  });
});
