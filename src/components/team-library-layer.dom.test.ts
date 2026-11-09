// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, installDOMHarness, mount, press, settle } from '../testing/dom-harness';
import { activeTrapCount, openLayers } from '../lib/focus-trap';
import { LazyOverlay } from './LazyOverlay';
import { TeamLibraryPanel } from './TeamLibraryPanel';
const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), stop: vi.fn(), api: vi.fn(), state: {} as Record<string, unknown> }));
vi.mock('../state/store', () => ({ useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }), api: fixture.api }));
vi.mock('../lib/importScan', () => ({ isCheckStopped: () => false, withScanId: (url: string) => url, useImportScan: () => ({ stop: fixture.stop, begin: () => ({ scanId: 'fixture', signal: new AbortController().signal }), progress: null }) }));
const initialState = { bots: [], groups: [], instances: [], config: null };
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(async () => { cleanup(); await settle(); expect(activeTrapCount()).toBe(0); vi.clearAllMocks(); document.body.replaceChildren(); });
function opener() { const b = document.createElement('button'); document.body.append(b); b.focus(); return b; }
describe('actual library Escape policy', () => {
  it.each([false, true])('R22-TEAM: pending preview Escape branches, importing=%s', async importing => {
    fixture.state = { ...initialState };
    fixture.api.mockImplementation((url: string) => url === '/api/team-library/github'
      ? Promise.resolve({ format: 'murage.team', version: 1, team: { name: 'Fixture preview', members: [{ name: 'Fixture bot' }] } })
      : new Promise(() => {}));
    const b = opener(), order: string[] = [];
    fixture.stop.mockImplementation(() => order.push('stop'));
    const close = vi.fn(() => order.push('close'));
    mount(h(LazyOverlay, { name: 'team-library', kind: 'window', covers: 'always', opener: b, onDismiss: close, onRetry: vi.fn() },
      h(TeamLibraryPanel, { onClose: close, onImported: vi.fn(), returnFocusRef: { current: b }, initialUrl: 'https://fixture.invalid/team' })));
    await settle();
    expect(document.body.textContent).toContain('Fixture preview');
    const before = openLayers()[0];
    if (importing) {
      const load = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Load bot')!;
      act(() => load.click()); await settle();
    }
    act(() => press('Escape')); await settle();
    if (!importing) {
      expect(document.body.textContent).not.toContain('Fixture preview');
      expect(openLayers()[0].id).toBe(before.id);
      expect(openLayers()[0].container).toBe(before.container);
      expect(order).toEqual([]);
      act(() => press('Escape'));
    }
    expect(order).toEqual(['stop', 'close']); expect(close).toHaveBeenCalledOnce();
  });

});
