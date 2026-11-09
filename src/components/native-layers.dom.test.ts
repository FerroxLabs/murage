// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement as h, StrictMode, useRef } from 'react';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, installDOMHarness, mount, press, settle } from '../testing/dom-harness';
import { activeTrapCount, openLayers } from '../lib/focus-trap';
import { KeyboardShortcutsDialog } from './KeyboardShortcutsDialog';
import { WhatsNewDialog } from './WhatsNewDialog';
import { EngineSignInDialog } from './EngineSignInDialog';
import { EngineChatLinkDialog } from './EngineChatLinkDialog';
import { ImageLightbox } from './ImageMedia';
import { MemoryLauncher } from './MemoryLauncher';
import { LazyOverlay } from './LazyOverlay';
import { useLayerContainer } from './LayerSlot';
import { LayerSurface } from './LayerSurface';
import { useNativeDialogLayer } from '../lib/native-dialog-layer';
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(async () => { cleanup(); await settle(); expect(activeTrapCount()).toBe(0); document.body.replaceChildren(); });
it('D12: actual native shortcuts registers after show and leaves Escape to browser cancel', async () => {
  const b = document.createElement('button'); document.body.append(b); b.focus();
  const close = vi.fn(); const first = mount(h(KeyboardShortcutsDialog, { open: true, onClose: close, returnFocusRef: { current: b } }));
  expect(openLayers()).toHaveLength(1); expect(openLayers()[0].kind).toBe('native');
  const id = openLayers()[0].id, container = openLayers()[0].container;
  const second = mount(h(KeyboardShortcutsDialog, { open: true, onClose: close, returnFocusRef: { current: b } }));
  expect(openLayers()).toHaveLength(2); expect(openLayers()[0].id).not.toBe(id); expect(openLayers()[1].container).toBe(container);
  expect(press('Escape').defaultPrevented).toBe(false); expect(close).not.toHaveBeenCalled();
  second.unmount(); await settle(); expect(openLayers()[0].id).toBe(id);
  first.unmount(); await settle(); expect(activeTrapCount()).toBe(0);
});

const fixture = vi.hoisted(() => ({ desktop: false }));
vi.mock('../lib/use-surface', () => ({ useDesktopSurface: () => fixture.desktop }));
vi.mock('./MemorySettingsLazy', () => ({ MemorySettings: () => h('div', null, 'Memory fixture') }));
const bridge = { onData: () => () => {}, onClosed: () => () => {}, preview: async () => ({ ok: false, code: 'failed', message: '' }) } as never;
const nativeCases = [
  ['shortcuts', (close: () => void) => h(KeyboardShortcutsDialog, { open: true, onClose: close })],
  ['sign-in', (close: () => void) => h(EngineSignInDialog, { bridge, instanceId: 'fixture', name: 'Fixture', onClose: close })],
  ['chat-link', (close: () => void) => h(EngineChatLinkDialog, { bridge, instance: { instanceId: 'fixture', displayName: 'Fixture' } as never, show: 'signed-in', onClose: close })],
  ['image', (close: () => void) => h(ImageLightbox, { items: [{ id: 'fixture', src: 'data:image/png;base64,', alt: 'Fixture' } as never], index: 0, onClose: close })],
  ['memory', (close: () => void) => h(MemoryLauncher, { botId: 'b', botName: 'Fixture', onOpenChange: (open: boolean) => { if (!open) close(); } })],
] as const;
function Parent({ close, children }: { close: () => void; children?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null); useLayerContainer(ref, { onEscape: close });
  return h(LayerSurface, null, h('div', { ref, role: 'dialog', 'aria-modal': true, tabIndex: -1 }, h('button', null, 'parent'), children));
}
it.each(nativeCases)('D12: actual %s preserves parent identity and consumes only native cancel', async (name, renderChild) => {
  const b = document.createElement('button'); document.body.append(b); b.focus();
  const close = vi.fn(), cancel = vi.fn();
  const render = (show: boolean) => h(LazyOverlay, { name: 'settings', kind: 'window', covers: 'always', onDismiss: close, onRetry: vi.fn() }, h(Parent, { close }, show ? renderChild(cancel) : null));
  const app = mount(render(false)), parent = openLayers()[0], container = parent.container;
  app.rerender(render(true));
  if (name === 'memory') { cancel.mockClear(); act(() => document.querySelector<HTMLButtonElement>('[aria-label="Open memory for Fixture"]')!.click()); }
  await settle(); expect(openLayers()).toHaveLength(2); expect(openLayers()[0].kind).toBe('native'); expect(openLayers()[1].id).toBe(parent.id); expect(openLayers()[1].container).toBe(container);
  const native = document.querySelector<HTMLDialogElement>('dialog[open]')!; native.querySelector<HTMLElement>('button')?.focus();
  act(() => native.dispatchEvent(new Event('close'))); expect(cancel).not.toHaveBeenCalled(); expect(openLayers()).toHaveLength(2);
  expect(press('Escape').defaultPrevented).toBe(false); expect(close).not.toHaveBeenCalled();
  act(() => native.dispatchEvent(new Event('cancel', { cancelable: true })));
  expect(cancel).toHaveBeenCalledOnce(); app.rerender(render(false)); await settle();
  expect(openLayers()).toHaveLength(1); expect(openLayers()[0].container).toBe(container); press('Escape', container as HTMLElement); expect(close).toHaveBeenCalledOnce();
});
it('D12: desktop Memory dispatches without registering a native entry', () => {
  fixture.desktop = true; const opened = vi.fn(); window.addEventListener('murage:open-memory', opened);
  try { mount(h(MemoryLauncher, { botId: 'b', botName: 'Fixture' })); act(() => document.querySelector<HTMLButtonElement>('button')!.click()); expect(opened).toHaveBeenCalledOnce(); expect(activeTrapCount()).toBe(0); }
  finally { window.removeEventListener('murage:open-memory', opened); fixture.desktop = false; }
});
it('D12: failed showModal does not register', () => {
  const show = vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(() => { throw new Error('fixture show failure'); });
  try { mount(h(ImageLightbox, { items: [{ id: 'fixture', src: 'data:image/png;base64,', alt: 'Fixture' } as never], index: 0, onClose: vi.fn() })); expect(activeTrapCount()).toBe(0); }
  finally { show.mockRestore(); }
});
it('D20 native: StrictMode replay retains opener and releases every entry', async () => {
  const b = document.createElement('button'); document.body.append(b); b.focus(); const returned = vi.fn(); b.addEventListener('focus', returned);
  const app = mount(h(StrictMode, null, h(ImageLightbox, { items: [{ id: 'fixture', src: 'data:image/png;base64,', alt: 'Fixture' } as never], index: 0, onClose: vi.fn() })));
  expect(openLayers()).toHaveLength(1); app.unmount(); await settle(); expect(activeTrapCount()).toBe(0); expect(document.activeElement).toBe(b); expect(returned).toHaveBeenCalledOnce();
});
it('D12 native conditional visibility releases and can reopen without a stale native root', async () => {
  const b = document.createElement('button'); document.body.append(b); b.focus();
  const render = (open: boolean) => h(KeyboardShortcutsDialog, { open, onClose: vi.fn(), returnFocusRef: { current: b } });
  const app = mount(render(false)); expect(activeTrapCount()).toBe(0);
  app.rerender(render(true)); expect(activeTrapCount()).toBe(1); app.rerender(render(false)); await settle(); expect(activeTrapCount()).toBe(0); expect(document.activeElement).toBe(b);
  app.rerender(render(true)); expect(activeTrapCount()).toBe(1); app.unmount(); await settle(); expect(activeTrapCount()).toBe(0); expect(document.activeElement).toBe(b);
});

// Astra r3 Medium 4: a browser queues the native close event. The harness dispatches it at once, so this case
// queues it, as Chromium does, and reopens the controlled Memory before the event arrives.
it('R5-M4/BF-6/BF-13: controlled Memory close then reopen before the queued close event keeps the reopened owner', async () => {
  const queued: Array<() => void> = [];
  const close = vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
    this.removeAttribute('open'); queued.push(() => this.dispatchEvent(new Event('close')));
  });
  try {
    const b = document.createElement('button'); document.body.append(b); b.focus();
    const changed = vi.fn();
    const render = (open: boolean) => h(MemoryLauncher, { botId: 'b', botName: 'Fixture', open, onOpenChange: changed, showTrigger: false, returnFocusRef: { current: b } });
    const app = mount(render(true)); await settle();
    const node = document.querySelector('dialog')!;
    expect(node.open).toBe(true); expect(openLayers().map(layer => layer.kind)).toEqual(['native']);
    const first = openLayers()[0].id;
    app.rerender(render(false)); await settle();
    // The registration retires with the close itself, not with its event: nothing stale holds the keyboard.
    expect(node.open).toBe(false); expect(activeTrapCount()).toBe(0); expect(queued).toHaveLength(1);
    expect(document.activeElement).toBe(b);
    app.rerender(render(true)); await settle();
    expect(node.open).toBe(true); expect(openLayers()).toHaveLength(1); expect(openLayers()[0].id).not.toBe(first);
    const second = openLayers()[0].id;
    changed.mockClear();
    act(() => { for (const fire of queued.splice(0)) fire(); }); await settle();
    // The earlier activation's event neither closes nor unregisters the reopened dialog, nor reports a close.
    expect(node.open).toBe(true); expect(openLayers().map(layer => layer.id)).toEqual([second]);
    expect(changed).not.toHaveBeenCalledWith(false);
    app.rerender(render(false)); await settle();
    act(() => { for (const fire of queued.splice(0)) fire(); }); await settle();
    expect(node.open).toBe(false); expect(activeTrapCount()).toBe(0); expect(document.activeElement).toBe(b);
    app.unmount(); await settle();
  } finally { close.mockRestore(); }
});
it('R5-M4: a show over a closed node that still awaits its close event registers a fresh activation', async () => {
  const queued: Array<() => void> = [];
  const close = vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
    this.removeAttribute('open'); queued.push(() => this.dispatchEvent(new Event('close')));
  });
  try {
    const api: { current: ReturnType<typeof useNativeDialogLayer> | null } = { current: null };
    function Probe() {
      const ref = useRef<HTMLDialogElement>(null);
      api.current = useNativeDialogLayer(ref, { name: 'probe', returnFocusTo: null });
      return h('dialog', { ref }, h('button', null, 'inside'));
    }
    const app = mount(h(Probe));
    act(() => api.current!.show());
    const node = document.querySelector('dialog')!; const first = openLayers()[0].id;
    // A browser-side close (a form with method=dialog, for one) bypasses the hook; its event is still queued.
    act(() => node.close());
    expect(node.open).toBe(false); expect(queued).toHaveLength(1);
    act(() => api.current!.show());
    expect(node.open).toBe(true); expect(openLayers()).toHaveLength(1);
    const second = openLayers()[0].id; expect(second).not.toBe(first);
    act(() => { for (const fire of queued.splice(0)) fire(); }); await settle();
    expect(node.open).toBe(true); expect(openLayers().map(layer => layer.id)).toEqual([second]);
    act(() => node.close()); act(() => { for (const fire of queued.splice(0)) fire(); }); await settle();
    expect(activeTrapCount()).toBe(0);
    app.unmount(); await settle();
  } finally { close.mockRestore(); }
});

it.each(['shortcuts', 'whats-new'])('R2b: %s open=false closes the native node and returns once while mounted', async name => {
  const b = document.createElement('button'); document.body.append(b); b.focus();
  const returned = vi.fn(); b.addEventListener('focus', returned);
  const render = (open: boolean) => name === 'shortcuts'
    ? h(KeyboardShortcutsDialog, { open, onClose: vi.fn() })
    : h(WhatsNewDialog, { open, version: '1.0.17', releaseNotesUrl: '', onClose: vi.fn(), onAction: vi.fn() });
  const app = mount(render(true)); const node = document.querySelector('dialog')!;
  expect(node.open).toBe(true);
  app.rerender(render(false)); await settle();
  expect(node.open).toBe(false); expect(activeTrapCount()).toBe(0);
  expect(document.activeElement).toBe(b); expect(returned).toHaveBeenCalledOnce();
  app.rerender(render(false)); app.unmount(); await settle(); expect(returned).toHaveBeenCalledOnce();
});

// Model the browser's own dialog focus restoration, which the basic DOM shim omits.
function browserDialogFocus() {
  const previous = new WeakMap<HTMLDialogElement, HTMLElement>();
  const show = vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
    if (this.open) return;
    previous.set(this, document.activeElement as HTMLElement);
    this.setAttribute('open', ''); this.querySelector<HTMLElement>('button, input')?.focus();
  });
  const close = vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
    const returnNow = this.contains(document.activeElement);
    this.removeAttribute('open');
    if (returnNow) previous.get(this)?.focus();
    this.dispatchEvent(new Event('close'));
  });
  return () => { show.mockRestore(); close.mockRestore(); };
}
it.each([false, true])('R3b native warm crash does not invoke browser return before replacement commits StrictMode=%s', async strict => {
  const restoreBrowser = browserDialogFocus(), errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const b = document.createElement('button'); document.body.append(b); b.focus();
  const returned = vi.fn(); b.addEventListener('focus', returned);
  let crash = false;
  const Child = ({ lifecycle }: { lifecycle: import('./LazyOverlay').LoadedLayerProps }) => {
    if (crash) throw Error('fixture loaded crash');
    return h(KeyboardShortcutsDialog, { open: true, layerLifecycle: lifecycle, onClose: lifecycle.dismiss });
  };
  const render = () => h(LazyOverlay, { name: 'native-load', kind: 'dialog', covers: 'while-loading', onDismiss: vi.fn(), onRetry: vi.fn(), children: lifecycle => h(Child, { lifecycle }) });
  try {
    const tree = () => strict ? h(StrictMode, null, render()) : render();
    const app = mount(tree());
    crash = true; app.rerender(tree()); await settle();
    expect(returned).not.toHaveBeenCalled();
    expect(document.activeElement?.textContent).toMatch(/Try again/);
    app.unmount(); await settle(); expect(document.activeElement).toBe(b); expect(returned).toHaveBeenCalledOnce();
  } finally { cleanup(); await settle(); restoreBrowser(); errors.mockRestore(); }
});
it('R3b native passive show returns past the browser loading-wrapper target', async () => {
  const restoreBrowser = browserDialogFocus();
  const b = document.createElement('button'); document.body.append(b); b.focus();
  const returned = vi.fn(); b.addEventListener('focus', returned);
  const chunk = (await import('../testing/dom-harness')).gate<{ lifecycle: import('./LazyOverlay').LoadedLayerProps }>();
  let app: ReturnType<typeof mount>;
  try {
    app = mount(h(LazyOverlay, { name: 'native-load', kind: 'dialog', covers: 'while-loading', onDismiss: () => app.unmount(), onRetry: chunk.retry, children: lifecycle => h(chunk.Component, { lifecycle }) }));
    await chunk.resolve(({ lifecycle }) => h(EngineSignInDialog, { bridge, instanceId: 'fixture', name: 'Fixture', layerLifecycle: lifecycle, onClose: lifecycle.dismiss }));
    const node = document.querySelector<HTMLDialogElement>('dialog[open]')!;
    expect(node).not.toBeNull(); node.querySelector<HTMLElement>('button')!.focus();
    act(() => node.dispatchEvent(new Event('cancel', { cancelable: true }))); await settle();
    expect(document.activeElement).toBe(b); expect(returned).toHaveBeenCalledOnce();
  } finally { cleanup(); await settle(); restoreBrowser(); }
});
