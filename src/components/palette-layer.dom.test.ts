// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, gate, installDOMHarness, mount, press, settle } from '../testing/dom-harness';
import { activeTrapCount, openLayers } from '../lib/focus-trap';
import { CommandPaletteHost } from './CommandPaletteHost';
import { CommandPalette } from './CommandPalette';
import { OPEN_PALETTE_EVENT } from '../lib/app-events';
import { chatsGenHello, chatsGenUnproven } from '../lib/chats-gen';
const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), api: vi.fn(), bots: [] as unknown[] }));
vi.mock('../state/store', () => ({ useStore: () => ({ state: { bots: fixture.bots, groups: [], pageIntent: {} }, dispatch: fixture.dispatch }), api: fixture.api }));
vi.mock('../lib/use-surface', () => ({ useDesktopSurface: () => false }));
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(async () => { cleanup(); await settle(); expect(activeTrapCount()).toBe(0); vi.clearAllMocks(); document.body.replaceChildren(); });
function opener() { const b = document.createElement('button'); document.body.append(b); b.focus(); return b; }
function open(query = '') { act(() => window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT, { detail: { query } }))); }

describe('actual palette host request ownership', () => {
  it('H1/D8: warm input acquires and Escape removes the complete owner before reopening', async () => {
    fixture.bots = []; const b = opener(), changed = vi.fn();
    mount(h(CommandPaletteHost, { onOpenChange: changed }));
    open(); await act(async () => { await import("./CommandPalette"); }); await settle();
    const input = document.querySelector<HTMLInputElement>('[aria-label="Command palette"] input')!;
    expect(input).not.toBeNull(); expect(document.activeElement).toBe(input);
    expect(activeTrapCount()).toBe(1); const id = openLayers()[0].id;
    act(() => press('Escape', input)); await settle();
    expect(activeTrapCount()).toBe(0); expect(document.querySelector('[aria-label="Command palette"]')).toBeNull(); expect(document.activeElement).toBe(b);
    open(); await settle(); expect(openLayers()[0].id).not.toBe(id);
    act(() => press('k', document.activeElement!, { ctrlKey: true })); await settle(); expect(activeTrapCount()).toBe(0);
    expect(changed).toHaveBeenLastCalledWith(false);
  });
});

describe('held chunks and asynchronous selections', () => {
  it('D8-empty/D9: empty pending owns Escape, rejection owns retry, late resolve cannot reopen', async () => {
    fixture.bots = []; const b = opener(), chunk = gate<import('./CommandPalette').CommandPaletteProps>();
    mount(h(CommandPaletteHost, { palette: chunk })); open();
    expect(activeTrapCount()).toBe(1); expect(document.querySelector('[data-lazy-overlay]')).toBeNull(); expect(document.activeElement).toBe(b);
    act(() => press('Escape', b)); await settle(); expect(activeTrapCount()).toBe(0);
    await chunk.resolve(CommandPalette); expect(activeTrapCount()).toBe(0);
    open(); await settle(); expect(document.activeElement?.tagName).toBe('INPUT');
    act(() => press('Escape')); await settle();
    cleanup(); await settle();
    const failed = gate<import('./CommandPalette').CommandPaletteProps>();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {}), warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount(h(CommandPaletteHost, { palette: failed })); open(); const id = openLayers()[0].id;
    await failed.rejectChunk(); expect(openLayers()[0].id).toBe(id); expect(document.activeElement?.textContent).toContain('Tap to retry');
    act(() => press('Escape')); await settle(); expect(activeTrapCount()).toBe(0);
    errors.mockRestore(); warnings.mockRestore();
  });
  it.each([false, true])('D8a: stale selection completion cannot dismiss, focus or report into B, rejection=%s', async reject => {
    vi.useFakeTimers();
    try {
      fixture.bots = [{ id: 'b', name: 'Fixture bot', threadId: 'current' }];
      // b12: palette hits come from useChatResource, shown only on a list generation the session has proven.
      const gen = { epoch: 'fixture', rev: 1 };
      chatsGenHello(gen);
      let resolve!: (value: unknown) => void, fail!: (reason: Error) => void;
      const pending = new Promise((yes, no) => { resolve = yes; fail = no; });
      fixture.api.mockImplementation((url: string) => url.startsWith('/api/search')
        ? Promise.resolve({ gen, hits: [{ botId: 'b', name: 'Fixture hit', threadId: 'older', messageId: 'm', snippet: 'needle', matchStart: 0, matchLength: 6, onActivePath: true, at: 1 }] })
        : pending);
      const b = opener();
      mount(h(CommandPaletteHost)); open('needle');
      await act(async () => { await import('./CommandPalette'); }); await settle();
      await act(async () => { await vi.advanceTimersByTimeAsync(150); });
      const hit = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.includes('needle'))!;
      expect(hit).toBeDefined(); act(() => hit.click());
      act(() => press('Escape')); await settle(); expect(document.activeElement).toBe(b);
      open(); await settle(); const id = openLayers()[0].id, input = document.activeElement;
      await act(async () => { if (reject) fail(Error('fixture rejection')); else resolve({}); });
      expect(openLayers()[0].id).toBe(id); expect(document.activeElement).toBe(input);
      expect(fixture.dispatch.mock.calls.some(([action]) => action.type === 'focusMessage' || action.type === 'error')).toBe(false);
      act(() => press('Escape')); await settle(); expect(document.activeElement).toBe(b);
    } finally { cleanup(); vi.useRealTimers(); chatsGenUnproven(); }
  });
});
