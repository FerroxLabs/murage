// SPDX-License-Identifier: AGPL-3.0-or-later
// In-memory chrome.* fixture that runs the real service-worker.mjs (same shape as the one in
// browser-extension-service-worker.test.mjs, plus alarms).
import { vi, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createBrowserExtensionRuntime } from '../extensions/murage-browser/runtime.mjs';
const source = readFileSync(new URL('../extensions/murage-browser/service-worker.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/m, '');
export const settle = () => new Promise(resolve => setImmediate(resolve));
export function event() {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), fire: (...args) => Promise.all([...listeners].map(fn => fn(...args))) };
}
export async function workerFixture() {
  const stored = {}, ports = [], timers = new Map(), tabs = new Map();
  let nextTab = 0, nextTimer = 0, runtime;
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
    alarms: { create: vi.fn(), onAlarm: event() },
    sidePanel: { setPanelBehavior: async () => {} },
  };
  runInNewContext(source, { chrome: api, createBrowserExtensionRuntime: (chrome, options) => {
    runtime = createBrowserExtensionRuntime(chrome, { ...options, uuid: () => 'profile_1' });
    vi.spyOn(runtime, 'connection'); return runtime;
  }, setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) });
  await settle();
  await ports[0].onMessage.fire({ version: 1, type: 'command', id: `${'a'.repeat(32)}_1`, bindingId: 'bot_a', generation: 1, operation: 'bind', params: { profileId: 'profile_1', botName: 'Preview', approvedOrigins: ['https://allowed.test'] } });
  expect(stored.murageBrowserState.bindings[0].state).toBe('active');
  const panelReconnect = () => api.runtime.onMessage.fire({ action: 'reconnect' }, { id: 'fixture', url: api.runtime.getURL('sidepanel/index.html') }, () => {});
  const retry = async () => { const entry = timers.entries().next().value; expect(entry).toBeDefined(); timers.delete(entry[0]); await entry[1].fn(); await settle(); };
  return { api, runtime, stored, ports, timers, retry, panelReconnect };
}
