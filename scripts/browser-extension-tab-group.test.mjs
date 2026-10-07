// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi } from 'vitest';
import { groupTitle, groupColor, MAX_TITLE } from '../extensions/murage-browser/tab-group.mjs';
import { createBrowserExtensionRuntime } from '../extensions/murage-browser/runtime.mjs';

describe('tab group title builder', () => {
  it('one bot is plain Murage, orange', () => {
    expect(groupTitle({ botName: 'Dax', state: 'active' })).toBe('Murage');
    expect(groupColor()).toBe('orange');
  });
  it('two bindings in a window carry the bot name', () => {
    expect(groupTitle({ botName: 'Dax', showBot: true, state: 'active' })).toBe('Murage · Dax');
    expect(groupTitle({ botName: 'Ivy', showBot: true, state: 'active' })).toBe('Murage · Ivy');
  });
  it('each suffix', () => {
    expect(groupTitle({ state: 'paused' })).toBe('Murage · paused');
    expect(groupTitle({ state: 'stopped' })).toBe('Murage · stopped');
    expect(groupTitle({ state: 'active', yourTurn: true })).toBe('Murage · your turn');
    expect(groupTitle({ state: 'active', full: true })).toBe('Murage · full');
    expect(groupTitle({ state: 'active', activity: 'working' })).toBe('Murage · working');
    expect(groupTitle({ state: 'active', activity: 'done' })).toBe('Murage · done');
    expect(groupTitle({ botName: 'Dax', showBot: true, state: 'paused', full: true })).toBe('Murage · Dax · paused · full');
  });
  it('trims a long bot name to fit and keeps the suffix', () => {
    const t = groupTitle({ botName: 'A'.repeat(200), showBot: true, state: 'paused' });
    expect(t.length).toBeLessThanOrEqual(MAX_TITLE);
    expect(t.endsWith(' · paused')).toBe(true);
    expect(t.startsWith('Murage · AAA')).toBe(true);
  });
  it('never contains a bot id, only the name', () => {
    expect(groupTitle({ botName: 'Dax', bindingId: 'bot_secret_123', id: 'bot_secret_123', showBot: true })).not.toContain('bot_secret_123');
  });
  it('uses chrome.i18n messages and falls back to English when empty', () => {
    const i18n = { getMessage: key => ({ groupTitle: 'Murage FR', groupSuffixPaused: '' })[key] ?? '' };
    expect(groupTitle({ state: 'paused' }, i18n)).toBe('Murage FR · paused');
  });
});

describe('runtime group titles', () => {
  function rig() {
    let next = 1; const listeners = new Set(); const stored = {};
    const api = {
      webNavigation: { onCompleted: { addListener: l => listeners.add(l), removeListener: l => listeners.delete(l) } },
      storage: { local: { get: async key => ({ [key]: stored[key] }), set: async v => Object.assign(stored, structuredClone(v)) } },
      runtime: { getManifest: () => ({ version: '0.1.0' }) },
      tabs: {
        create: vi.fn(async ({ url }) => { const tab = { id: next++, url, windowId: 7 }; for (const l of listeners) l({ tabId: tab.id, frameId: 0, url }); return tab; }),
        get: vi.fn(async id => ({ id, url: 'about:blank', windowId: 7 })),
        group: vi.fn(async ({ groupId }) => groupId ?? 40 + next), remove: vi.fn(async () => {}),
      },
      tabGroups: { update: vi.fn(async () => {}), move: vi.fn(async () => {}) }, action: { setBadgeText: vi.fn(async () => {}) },
      debugger: { attach: vi.fn(async () => {}), detach: vi.fn(async () => {}), sendCommand: vi.fn(async () => ({})) },
    };
    const runtime = createBrowserExtensionRuntime(api, { uuid: () => 'profile_1', emit: () => {}, commandTimeoutMs: 500 });
    let seq = 0; const nonce = 'a'.repeat(32);
    const bind = async (bindingId, botName) => runtime.handleRequest({ version: 1, type: 'command', id: `${nonce}_${++seq}`, bindingId, generation: 1, operation: 'bind', params: { profileId: 'profile_1', botName, approvedOrigins: ['https://allowed.test'] } });
    return { api, runtime, bind, boot: async () => { await runtime.initialize(); await runtime.connection(true); } };
  }
  it('titles Murage, then names the bots once two share a window, always orange, never collapsing or moving', async () => {
    const r = rig(); await r.boot();
    await r.bind('bot_a', 'Dax');
    let last = r.api.tabGroups.update.mock.calls.at(-1);
    expect(last[1]).toEqual({ title: 'Murage', color: 'orange' });
    await r.bind('bot_b', 'Ivy');
    const titles = r.api.tabGroups.update.mock.calls.map(c => c[1].title);
    expect(titles).toContain('Murage · Ivy');
    await r.bind('bot_a', 'Dax').catch(() => {});
    for (const [, props] of r.api.tabGroups.update.mock.calls) { expect(props.color).toBe('orange'); expect(props).not.toHaveProperty('collapsed'); expect(JSON.stringify(props)).not.toMatch(/bot_[ab]/); }
    expect(r.api.tabGroups.move).not.toHaveBeenCalled();
  });
});
