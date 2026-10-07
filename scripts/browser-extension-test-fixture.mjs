// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared in-memory chrome.* fixture for the extension runtime tests (same shape as the one in
// browser-extension-runtime.test.mjs, plus tabs.onCreated and a download hook).
import { vi } from 'vitest';
import { createBrowserExtensionRuntime } from '../extensions/murage-browser/runtime.mjs';
export function fixture(stored = {}, runtimeOptions = {}) {
  const tabs = new Map([[999, { id: 999, url: 'https://private.test/secrets' }]]);
  let next = 1; const completionListeners = new Set();
  const observer = { paused: false, calls: [] };
  const sendCommand = async (_source, method, params = {}) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: params.worldName === 'murage-presence-v1' ? 8 : 7 };
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'observer-script' };
    if (method === 'Runtime.evaluate' && params.expression?.startsWith('globalThis.__murageTakeover?.')) {
      observer.calls.push(params.expression);
      return { result: { type: 'boolean', value: params.expression.includes('.arm(') ? !observer.paused : observer.paused } };
    }
    // Round 9: a screenshot needs a presence control that can mask; this fixture has one that always says it did.
    if (method === 'Runtime.evaluate' && params.contextId === 8) return { result: { type: 'boolean', value: true } };
    return { value: 'owned' };
  };
  const api = {
    webNavigation: { onCompleted: { addListener: listener => completionListeners.add(listener), removeListener: listener => completionListeners.delete(listener) } },
    storage: { local: { get: vi.fn(async key => ({ [key]: stored[key] })), set: vi.fn(async value => Object.assign(stored, structuredClone(value))) } },
    runtime: { getManifest: () => ({ version: '0.1.0' }) },
    tabs: { create: vi.fn(async ({ url }) => { const tab = { id: next++, url }; tabs.set(tab.id, tab); for (const listener of completionListeners) listener({ tabId: tab.id, frameId: 0, url }); return tab; }), get: vi.fn(async id => { if (!tabs.has(id)) throw Error('missing'); return tabs.get(id); }), group: vi.fn(async () => 42), remove: vi.fn(async id => tabs.delete(id)) },
    downloads: { cancel: vi.fn(async () => {}), erase: vi.fn(async () => {}) },
    tabGroups: { update: vi.fn(async () => {}) }, action: { setBadgeText: vi.fn(async () => {}) },
    debugger: { attach: vi.fn(async () => {}), detach: vi.fn(async () => {}), sendCommand: vi.fn(sendCommand) },
  };
  const events = []; const runtime = createBrowserExtensionRuntime(api, { uuid: () => 'profile_1', emit: e => events.push(e), commandTimeoutMs: 500, ...runtimeOptions });
  let requestId = 0, connectionNumber = 0, nonce = 'a'.repeat(32), wireConnected = false;
  const originalConnection=runtime.connection;
  runtime.connection=async value=>{const result=await originalConnection(value);if(value&&!wireConnected){requestId=0;nonce=(++connectionNumber).toString(16).padStart(32,'0');}wireConnected=value;return result;};
  const wireId=sequence=>`${nonce}_${sequence}`;const nextId=()=>wireId(++requestId);
  const command = (operation, params = {}, generation = 1, bindingId = 'bot_a') => runtime.handleRequest({ version: 1, type: 'command', id: nextId(), bindingId, generation, operation, params });
  const bind = (bindingId = 'bot_a', generation = 1) => command('bind', { profileId: 'profile_1', botName: bindingId, approvedOrigins: ['https://allowed.test'] }, generation, bindingId);
  const init = async () => { await runtime.initialize(); await runtime.connection(true); return bind(); };
  const navigate = async () => { tabs.get(1).url = 'https://allowed.test/page'; await runtime.navigation({ tabId: 1, frameId: 0, url: tabs.get(1).url }); };
  return { api, runtime, command, bind, init, navigate, tabs, stored, events, completionListeners, observer, sendCommand, wireId, nextId };
}
