// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createBrowserExtensionRuntime } from '../extensions/murage-browser/runtime.mjs';
const source = readFileSync(new URL('../extensions/murage-browser/service-worker.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/m, '');
const settle = () => new Promise(resolve => setImmediate(resolve));
function event() {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), fire: (...args) => Promise.all([...listeners].map(fn => fn(...args))) };
}
async function fixture() {
  const stored = {}, ports = [], timers = new Map(), tabs = new Map();
  let nextTab = 0, nextTimer = 0, runtime, now = 1_000_000;
  const completed = event();
  const api = {
    runtime: { id: 'fixture', getURL: p => `chrome-extension://fixture/${p}`, getManifest: () => ({ version: '0.1.0' }), onMessage: event(), connectNative: vi.fn(() => {
      const current = { onMessage: event(), onDisconnect: event(), messages: [], closed: false };
      current.postMessage = vi.fn(message => { if (current.closed) throw Error('disconnected'); current.messages.push(structuredClone(message)); });
      // Chrome only notifies the OTHER end after local disconnect().
      current.disconnect = vi.fn(() => { current.closed = true; });
      ports.push(current); return current;
    }) },
    storage: { local: { get: async key => ({ [key]: stored[key] }), set: async value => Object.assign(stored, structuredClone(value)) } },
    webNavigation: { onCompleted: completed, onCreatedNavigationTarget: event(), onCommitted: event(), onHistoryStateUpdated: event(), onReferenceFragmentUpdated: event() },
    tabs: { onRemoved: event(), onCreated: event(), create: async ({ url }) => { const tab = { id: ++nextTab, url }; tabs.set(tab.id, tab); await completed.fire({ tabId: tab.id, frameId: 0, url }); return tab; }, get: async id => tabs.get(id), group: async () => 1, remove: async id => tabs.delete(id) },
    tabGroups: { update: async () => {} }, action: { setBadgeText: async () => {} },
    debugger: { onDetach: event(), onEvent: event(), attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) },
    downloads: { onCreated: event(), onDeterminingFilename: event(), cancel: vi.fn(async () => {}), erase: vi.fn(async () => {}) },
    alarms: { create: () => {}, onAlarm: event() },
    sidePanel: { setPanelBehavior: async () => {} },
  };
  runInNewContext(source, { chrome: api, createBrowserExtensionRuntime: (chrome, options) => {
    runtime = createBrowserExtensionRuntime(chrome, { ...options, uuid: () => 'profile_1' });
    vi.spyOn(runtime, 'connection'); return runtime;
  }, Date: class extends Date { static now() { return now; } }, setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) });
  await settle();
  await ports[0].onMessage.fire({ version: 1, type: 'command', id: `${'a'.repeat(32)}_1`, bindingId: 'bot_a', generation: 1, operation: 'bind', params: { profileId: 'profile_1', botName: 'Preview', approvedOrigins: ['https://allowed.test'] } });
  expect(stored.murageBrowserState.bindings[0].state).toBe('active');
  const panelReconnect = () => api.runtime.onMessage.fire({ action: 'reconnect' }, { id: 'fixture', url: api.runtime.getURL('sidepanel/index.html') }, () => {});
  const retry = async () => { const entry = timers.entries().next().value; expect(entry).toBeDefined(); timers.delete(entry[0]); now += entry[1].ms; await entry[1].fn(); await settle(); };
  return { api, runtime, stored, ports, timers, retry, panelReconnect };
}
describe('native service-worker disconnect lifecycle', () => {
  it('fences a host.error without any local onDisconnect event and reconnects once', async () => {
    const f = await fixture(); const old = f.ports[0];
    await old.onMessage.fire({ version: 1, type: 'host.error', error: { code: 'host_lost' } });
    expect(f.stored.murageBrowserState.bindings[0]).toMatchObject({ state: 'paused', generation: 2 });
    expect(old.disconnect).toHaveBeenCalledTimes(1); expect(f.timers.size).toBe(1);
    await f.retry(); expect(f.ports).toHaveLength(2); expect(f.timers.size).toBe(0);
  });
  it('a late remote disconnect after local teardown neither fences twice nor adds a retry', async () => {
    const f = await fixture(); const old = f.ports[0];
    await old.onMessage.fire({ type: 'host.error' }); await old.onDisconnect.fire();
    expect(f.runtime.connection.mock.calls.filter(([value]) => value === false)).toHaveLength(1);
    expect(f.stored.murageBrowserState.bindings[0].generation).toBe(2); expect(f.timers.size).toBe(1);
  });
  it('a late rejected command from the old port cannot close its replacement', async () => {
    const f = await fixture(); const old = f.ports[0]; let reject;
    vi.spyOn(f.runtime, 'handleRequest').mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const pending = old.onMessage.fire({ type: 'held-command' });
    await old.onMessage.fire({ type: 'host.error' }); await f.retry();
    const replacement = f.ports[1]; reject(Error('old operation failed')); await pending;
    expect(replacement.closed).toBe(false); expect(f.timers.size).toBe(0);
    expect(f.runtime.connection.mock.calls.filter(([value]) => value === false)).toHaveLength(1);
  });
  it('does not send a late successful result or replay it after remote loss', async () => {
    const f = await fixture(); const old = f.ports[0]; let resolve;
    const handled = vi.spyOn(f.runtime, 'handleRequest').mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = old.onMessage.fire({ type: 'held-command' });
    await old.onDisconnect.fire(); const sent = old.messages.length; await f.retry();
    resolve({ result: 'old private observation' }); await pending;
    expect(old.messages).toHaveLength(sent); expect(handled).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.ports[1].messages)).not.toContain('old private observation');
  });
  it('fences reconnect_required and malformed envelopes through local teardown', async () => {
    for (const response of [{ error: { code: 'reconnect_required' } }, undefined]) {
      const f = await fixture(); const old = f.ports[0];
      if (response) vi.spyOn(f.runtime, 'handleRequest').mockResolvedValueOnce(response);
      await old.onMessage.fire({ type: 'invalid-envelope' });
      expect(old.closed).toBe(true); expect(f.stored.murageBrowserState.bindings[0].state).toBe('paused');
      expect(f.timers.size).toBe(1);
    }
  });
  it('owner reconnect cancels the pending retry instead of opening a second port', async () => {
    const f = await fixture(); await f.ports[0].onMessage.fire({ type: 'host.error' });
    await f.panelReconnect(); await settle();
    expect(f.ports).toHaveLength(2); expect(f.timers.size).toBe(0);
  });
  it('a thrown postMessage fences active authority without waiting for a remote event', async () => {
    const f = await fixture(); f.ports[0].postMessage.mockImplementation(() => { throw Error('closed transport'); });
    await f.ports[0].onMessage.fire({ version: 1, type: 'command', id: `${'a'.repeat(32)}_2`, bindingId: 'bot_a', generation: 1, operation: 'status', params: {} });
    expect(f.stored.murageBrowserState.bindings[0]).toMatchObject({ state: 'paused', generation: 2 });
    expect(f.timers.size).toBe(1);
  });
});
