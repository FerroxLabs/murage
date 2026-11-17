// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement as h, useRef } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, gate, installDOMHarness, mount, press, settle } from '../testing/dom-harness';
import { activeTrapCount, openLayers } from '../lib/focus-trap';
import { LazyOverlay } from './LazyOverlay';
import { useLayerContainer } from './LayerSlot';
import { LayerSurface } from './LayerSurface';
import { CommandPaletteHost } from './CommandPaletteHost';
import { OPEN_PALETTE_EVENT } from '../lib/app-events';
import { SettingsModal } from './SettingsModal';
import { ModelPicker } from './ModelPicker';
import { pbConfig, pbAboutMe, pbTimeZone } from '../e2e/pullback-layers.responses';
import { configReply } from '../state/hydrate-bodies';
import { skillRecorderEnabled } from '../lib/feature-flags';
import { initialState, type Bot } from '../state/store';

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), desktop: false, state: {} as Record<string, unknown> }));
vi.mock('../state/store', async original => ({ ...await original<typeof import('../state/store')>(), useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch, refreshInstances: async () => {} }), api: async (path: string) => path === '/api/about-me' ? pbAboutMe : path === '/api/owner/timezone' ? pbTimeZone : ({ connections: [] }) }));
vi.mock('../lib/use-surface', () => ({ useSurfaceState: () => ({ desktop: fixture.desktop, confirmed: true }), useDesktopSurface: () => fixture.desktop }));
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(async () => { cleanup(); await settle(); expect(activeTrapCount()).toBe(0); vi.clearAllMocks(); document.body.replaceChildren(); });
function opener() { const b = document.createElement('button'); document.body.append(b); b.focus(); return b; }
function inputValue(input: HTMLInputElement, value: string) {
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
function PickerWindow({ bot, close }: { bot: Bot; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayerContainer(ref, { onEscape: close });
  return h(LayerSurface, null, h('div', { ref, role: 'dialog', 'aria-modal': true }, h(ModelPicker, { bot, contained: true })));
}

describe('actual window attachments', () => {
  it('D2/D6: Settings attaches the loaded container and resumes after a lower chunk resolves', async () => {
    fixture.state = { ...initialState, appSettingsSection: 'appearance' };
    const b = opener(), chunk = gate();
    const app = mount(h(LazyOverlay, { name: 'settings', kind: 'window', covers: 'always', opener: b, onDismiss: vi.fn(), onRetry: chunk.retry }, h(chunk.Component)));
    const before = openLayers()[0];
    const paletteChunk = gate<import('./CommandPalette').CommandPaletteProps>();
    const palette = mount(h(CommandPaletteHost, { palette: paletteChunk }));
    act(() => window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT)));
    await chunk.resolve(SettingsModal);
    const loaded = document.querySelector('.settings-dialog')!;
    expect(openLayers()[1].container).toBe(loaded);
    expect(openLayers()[1].id).toBe(before.id);
    act(() => press('Escape')); await settle();
    expect(activeTrapCount()).toBe(1);
    palette.unmount();
    expect(loaded.contains(document.activeElement)).toBe(true);
    app.unmount(); await settle(); expect(document.activeElement).toBe(b);
  });
  it('H1/R23-H1: warm Settings acquires, lower search yields to empty palette, then clears and closes', async () => {
    fixture.state = { ...initialState, appSettingsSection: 'appearance' };
    const b = opener();
    const app = mount(h(LazyOverlay, { name: 'settings', kind: 'window', covers: 'always', opener: b, onDismiss: vi.fn(), onRetry: vi.fn() }, h(SettingsModal)));
    expect(openLayers()[0].container).toBe(document.querySelector('.settings-dialog'));
    const search = document.querySelector<HTMLInputElement>('#settings-search')!;
    search.focus(); inputValue(search, 'color');
    const chunk = gate(); let palette: ReturnType<typeof mount>;
    palette = mount(h(LazyOverlay, { name: 'palette', kind: 'palette', covers: 'always', fallback: null, onDismiss: () => palette.unmount(), onRetry: chunk.retry }, h(chunk.Component)));
    act(() => press('Escape', search)); await settle();
    expect(activeTrapCount()).toBe(1); expect(search.value).toBe('color');
    expect(fixture.dispatch).not.toHaveBeenCalledWith({ type: 'toggleAppSettings', open: false });
    act(() => press('Escape', search)); expect(search.value).toBe('');
    act(() => press('Escape', search)); expect(fixture.dispatch).toHaveBeenCalledWith({ type: 'toggleAppSettings', open: false });
    app.unmount(); await settle(); expect(document.activeElement).toBe(b);
  });
  it('D19: actual contained picker clears query, closes to trigger, then delegates to its window', async () => {
    fixture.state = { ...initialState };
    const bot = { id: 'fixture', name: 'Fixture', modelSelection: { instanceId: 'fixture', model: 'model' } } as Bot;
    const close = vi.fn(); opener();
    mount(h(LazyOverlay, { name: 'picker-window', kind: 'window', covers: 'always', onDismiss: close, onRetry: vi.fn() }, h(PickerWindow, { bot, close })));
    const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
    act(() => trigger.click()); await settle();
    // The dialog is a lazy chunk since 1.0.19 slice P: wait for it to draw.
    await vi.waitFor(() => { if (!document.querySelector("[data-model-picker-content] input")) throw new Error("dialog not drawn yet"); });
    const search = document.querySelector<HTMLInputElement>('[data-model-picker-content] input')!;
    search.focus(); inputValue(search, 'query');
    act(() => press('Escape', search)); expect(search.value).toBe(''); expect(close).not.toHaveBeenCalled();
    act(() => press('Escape', search)); expect(document.querySelector('[data-model-picker-content]')).toBeNull(); expect(document.activeElement).toBe(trigger);
    act(() => press('Escape', trigger)); expect(close).toHaveBeenCalledOnce();
  });
});
it('D7: actual Settings crash and retry below actual palette retain activation and palette focus', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    fixture.state = { ...initialState, appSettingsSection: 'appearance' };
    const b = opener(), chunk = gate(); let crash = false;
    const Child = () => { if (crash) throw new Error('fixture Settings render failure'); return h(SettingsModal); };
    const render = () => h(LazyOverlay, { name: 'settings', kind: 'window', covers: 'always', opener: b, onDismiss: vi.fn(), onRetry: chunk.retry }, h(chunk.Component));
    const settings = mount(render()); await chunk.resolve(Child); await settle(); const entry = openLayers()[0], sequence = entry.sequence; expect(sequence).toBeGreaterThan(0);
    const paletteChunk = gate<import('./CommandPalette').CommandPaletteProps>(); mount(h(CommandPaletteHost, { palette: paletteChunk }));
    act(() => window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT)));
    await paletteChunk.resolve((await import('./CommandPalette')).CommandPalette); await settle(); const input = document.activeElement, paletteId = openLayers()[0].id;
    crash = true; settings.rerender(render()); await settle(); expect(openLayers()[0].id).toBe(paletteId); expect(openLayers()[1].id).toBe(entry.id); expect(openLayers()[1].sequence).toBe(sequence); expect(document.activeElement).toBe(input);
    crash = false; const retry = Array.from(document.querySelectorAll('button')).find(button => /try again|retry/i.test(button.textContent ?? ''))!;
    act(() => retry.click()); await chunk.resolve(Child); await settle(); expect(openLayers()[1].id).toBe(entry.id); expect(openLayers()[1].sequence).toBe(sequence); expect(openLayers()[0].id).toBe(paletteId); expect(document.activeElement).toBe(input);
  } finally { vi.restoreAllMocks(); }
});
it('R2b/U34: actual Settings Tab skips the search-hidden page and folded contents', () => {
  fixture.state = { ...initialState, appSettingsSection: 'appearance' };
  mount(h(LazyOverlay, { name: 'settings', kind: 'window', covers: 'always', onDismiss: vi.fn(), onRetry: vi.fn() }, h(SettingsModal)));
  const root = document.querySelector<HTMLElement>('.settings-dialog')!;
  const page = root.querySelector<HTMLElement>('[data-settings-page-body]')!;
  const search = root.querySelector<HTMLInputElement>('#settings-search')!;
  const hiddenStop = document.createElement('button'); hiddenStop.textContent = 'Draft page stop'; page.append(hiddenStop);
  const folded = document.createElement('details'); folded.innerHTML = '<summary>Folded</summary><button>Folded stop</button>'; root.append(folded);
  const last = document.createElement('button'); last.textContent = 'Last visible'; root.append(last);
  const first = search;
  inputValue(search, 'color'); expect(page.hidden).toBe(true);
  last.focus(); press('Tab', last); expect(document.activeElement).toBe(first);
  first.focus(); press('Tab', first, { shiftKey: true }); expect(document.activeElement).toBe(last);
  // Place hidden controls after the visible end too: neither can become the wrap target.
  root.append(page, folded);
  first.focus(); press('Tab', first, { shiftKey: true }); expect(document.activeElement).toBe(folded.querySelector('summary'));
  folded.querySelector('summary')!.focus(); press('Tab'); expect(document.activeElement).toBe(first);
  inputValue(search, ''); expect(page.hidden).toBe(false);
  folded.remove();
  first.focus(); press('Tab', first, { shiftKey: true }); expect(document.activeElement).toBe(hiddenStop);
});

it('R3d fixture config hydrates and enables the recorder before its cover is requested', () => {
  expect(configReply(pbConfig)).toBe(pbConfig);
  expect(skillRecorderEnabled(pbConfig)).toBe(true);
});
it('R3d fixture desktop Settings stays mounted after its General replies settle', async () => {
  fixture.desktop = true;
  fixture.state = { ...initialState, appSettingsSection: 'general' };
  try {
    mount(h(LazyOverlay, { name: 'settings', kind: 'window', covers: 'always', onDismiss: vi.fn(), onRetry: vi.fn() }, h(SettingsModal)));
    await settle();
    expect(document.querySelector('#settings-search')).not.toBeNull();
    await vi.waitFor(() => expect(document.querySelector('#about-me-heading')).not.toBeNull());
    expect(openLayers()[0].container).toBe(document.querySelector('.settings-dialog'));
  } finally { fixture.desktop = false; }
});
