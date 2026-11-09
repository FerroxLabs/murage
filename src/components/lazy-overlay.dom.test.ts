// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { createElement as h, StrictMode, useLayoutEffect, useRef } from 'react';
import { act } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, frame, gate, installDOMHarness, mount, press, settle } from '../testing/dom-harness';
import { activeTrapCount, openLayers, useFocusTrap } from '../lib/focus-trap';
import { LazyOverlay, type LoadedLayerProps } from './LazyOverlay';
import { LayerOwner, LayerSlot, useLayerContainer } from './LayerSlot';
import { escapeIsFree } from '../lib/escape-layer';
import { LayerSurface } from './LayerSurface';

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterEach(async () => { cleanup(); await settle(); expect(activeTrapCount()).toBe(0); vi.restoreAllMocks(); document.body.replaceChildren(); });
afterAll(() => restore());
function opener() { const b = document.createElement('button'); b.textContent = 'opener'; document.body.append(b); b.focus(); return b; }
function Loaded({ crash = false }: { crash?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayerContainer(ref, { onEscape: () => {}, holdFocus: false });
  if (crash) throw Error('fixture render error');
  return h(LayerSurface, null, h('div', { ref, 'aria-modal': true }, h('input', { 'aria-label': 'loaded' })));
}
function Independent({ opener, lease, dismiss }: LoadedLayerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const handle = useFocusTrap(ref, true, { name: 'independent', kind: 'dialog', returnFocusTo: opener, lease, onEscape: dismiss });
  return h(LayerSurface, { handle }, h('div', { ref, 'aria-modal': true }, h('input', { 'aria-label': 'independent' })));
}
function Page({ focus = false, crash = false }: { focus?: boolean; crash?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { if (focus) ref.current?.focus(); }, [focus]);
  if (crash) throw Error('page crashed');
  return h('section', null, h('h1', null, 'page'), h('button', { ref }, 'page control'));
}
const quietErrors = () => { vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); };

describe('owned lazy lifetimes', () => {
  it.each(['window', 'dialog', 'palette'] as const)('shepherd A: dismiss ends an always %s owner and its leased child with one return', async kind => {
    const before = activeTrapCount();
    const b = opener(), returned = vi.fn(), dismissed = vi.fn();
    b.addEventListener('focus', returned);
    let dismiss!: () => void;
    const app = mount(h(LazyOverlay, { name: 'always-with-child', kind, covers: 'always', onDismiss: dismissed, onRetry: vi.fn(),
      children: props => { dismiss = props.dismiss; return h(Independent, props); } }));
    expect(activeTrapCount()).toBe(before + 2);
    act(() => dismiss());
    expect(activeTrapCount()).toBe(before);
    expect(document.activeElement).toBe(b);
    expect(returned).toHaveBeenCalledOnce();
    expect(dismissed).toHaveBeenCalledOnce();
    act(() => dismiss());
    app.unmount(); await settle();
    expect(activeTrapCount()).toBe(before);
    expect(returned).toHaveBeenCalledOnce();
    expect(dismissed).toHaveBeenCalledOnce();
  });
  it('D1/D2: cold Close acquires, loaded replacement keeps identity and returns original opener', async () => {
    const b = opener(), chunk = gate();
    let app: ReturnType<typeof mount>;
    const dismiss = () => app.unmount();
    app = mount(h(LazyOverlay, { name: 'settings', kind: 'window', covers: 'always', onDismiss: dismiss, onRetry: chunk.retry }, h(chunk.Component)));
    expect(activeTrapCount()).toBe(1);
    expect(document.activeElement?.textContent).toBe('Close');
    const before = openLayers()[0];
    await chunk.resolve(Loaded);
    await frame();
    expect(openLayers()[0]).toMatchObject({ id: before.id, sequence: before.sequence, zIndex: before.zIndex });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('loaded');
    app.unmount(); await settle();
    expect(document.activeElement).toBe(b);
  });
  it('D3/BF-14: error retry is first and keeps activation; reload seam runs once', async () => {
    quietErrors(); opener(); const chunk = gate(), reload = vi.fn();
    const app = mount(h(LazyOverlay, { name: 'error', kind: 'window', covers: 'always', onDismiss: vi.fn(), onRetry: chunk.retry, reload }, h(chunk.Component)));
    const before = openLayers()[0];
    await chunk.rejectChunk();
    expect(document.activeElement?.textContent).toContain('Tap to retry');
    expect(openLayers()[0]).toMatchObject({ id: before.id, sequence: before.sequence });
    act(() => (document.activeElement as HTMLElement).click());
    expect(reload).toHaveBeenCalledOnce(); app.unmount();
  });
  it.each([false, true])('D5: late completion after unmount cannot resurrect (%s)', async reject => {
    quietErrors(); const b = opener(), chunk = gate();
    const app = mount(h(LazyOverlay, { name: 'late', kind: 'dialog', covers: 'always', onDismiss: vi.fn(), onRetry: chunk.retry }, h(chunk.Component)));
    app.unmount(); await settle(); expect(document.activeElement).toBe(b);
    if (reject) await chunk.rejectChunk(); else await chunk.resolve(Loaded);
    expect(activeTrapCount()).toBe(0); expect(document.querySelector('[data-lazy-overlay]')).toBeNull();
  });
  it('D6/D17: lower resolve and removal never steal; palette close resumes loaded lower', async () => {
    opener(); const chunk = gate();
    const lower = mount(h(LazyOverlay, { name: 'settings', kind: 'window', covers: 'always', onDismiss: vi.fn(), onRetry: chunk.retry }, h(chunk.Component)));
    const upper = mount(h(LazyOverlay, { name: 'palette', kind: 'palette', covers: 'always', onDismiss: vi.fn(), onRetry: vi.fn() }, h(Loaded)));
    const input = document.activeElement;
    await chunk.resolve(Loaded);
    expect(document.activeElement).toBe(input);
    upper.unmount(); await settle();
    expect(openLayers()[0].container?.contains(document.activeElement)).toBe(true);
    const again = mount(h(LazyOverlay, { name: 'palette', kind: 'palette', covers: 'always', onDismiss: vi.fn(), onRetry: vi.fn() }, h(Loaded)));
    const top = openLayers()[0], focus = document.activeElement;
    lower.unmount(); await settle();
    expect(openLayers()[0].id).toBe(top.id); expect(document.activeElement).toBe(focus); again.unmount();
  });
  it('D4/D7/D16/BF-19: loaded crash and retry keep identity, also below palette', async () => {
    quietErrors(); const b = opener(); let broken = false;
    const Child = () => h(Loaded, { crash: broken });
    const render = () => h(LazyOverlay, { name: 'settings', kind: 'window', covers: 'always', onDismiss: vi.fn(), onRetry: vi.fn() }, h(Child));
    const app = mount(render()); const before = openLayers()[0];
    broken = true; app.rerender(render());
    expect(document.activeElement?.textContent).toBe('Try again');
    expect(openLayers()[0].id).toBe(before.id);
    broken = false; act(() => (document.activeElement as HTMLElement).click());
    expect(document.activeElement?.getAttribute('aria-label')).toBe('loaded');
    const upper = mount(h(LazyOverlay, { name: 'palette', kind: 'palette', covers: 'always', onDismiss: vi.fn(), onRetry: vi.fn() }, h(Loaded)));
    const focus = document.activeElement;
    broken = true; app.rerender(render());
    expect(document.activeElement).toBe(focus);
    broken = false; act(() => Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Try again')!.click());
    expect(document.activeElement).toBe(focus);
    expect(openLayers()[1]).toMatchObject({ id: before.id, sequence: before.sequence, zIndex: before.zIndex });
    upper.unmount(); app.unmount(); await settle(); expect(document.activeElement).toBe(b);
  });
  it.each([false, true])('D15/R22-H1: page handoff then fresh crash activation (%s)', async focus => {
    quietErrors(); const b = opener(), chunk = gate<{ focus?: boolean; crash?: boolean }>();
    const render = (crash = false) => h(LazyOverlay, { name: 'page', kind: 'page', covers: 'while-loading', fallback: null, onDismiss: vi.fn(), onRetry: chunk.retry }, h(chunk.Component, { focus, crash }));
    const app = mount(render()); const first = openLayers()[0];
    expect(document.activeElement?.textContent).toBe('Close');
    await chunk.resolve(Page);
    expect(activeTrapCount()).toBe(0); expect(document.activeElement).not.toBe(b); expect(document.activeElement).not.toBe(document.body);
    app.rerender(render(true));
    expect(activeTrapCount()).toBe(1); expect(openLayers()[0].id).not.toBe(first.id);
    expect(document.activeElement?.textContent).toBe('Try again');
    app.rerender(render(false)); act(() => (document.activeElement as HTMLElement).click());
    expect(activeTrapCount()).toBe(0);
    app.rerender(render(true)); expect(openLayers()[0].sequence).toBeGreaterThan(first.sequence);
    app.unmount(); await settle(); expect(document.activeElement).toBe(b);
  });
  it('D10/D11/D20: StrictMode unique owners, sibling ranked surfaces, lower removal', async () => {
    opener();
    const overlay = (key: string) => h(LazyOverlay, { key, name: 'same', kind: 'window', covers: 'always', onDismiss: vi.fn(), onRetry: vi.fn() }, h(Loaded));
    const app = mount(h(StrictMode, null, overlay('a'), overlay('b')));
    await settle(); expect(activeTrapCount()).toBe(2);
    const entries = openLayers(); expect(new Set(entries.map(e => e.id)).size).toBe(2);
    const host = document.getElementById('murage-layer-host')!;
    expect(host.parentElement).toBe(document.body); expect(host.style.zIndex).toBe('50');
    expect(Array.from(host.children).map(e => (e as HTMLElement).style.zIndex).sort()).toEqual(['1', '2']);
    const focus = document.activeElement;
    app.rerender(h(StrictMode, null, overlay('b'))); await settle();
    expect(activeTrapCount()).toBe(1); expect(document.activeElement).toBe(focus);
    expect((host.firstElementChild as HTMLElement).style.zIndex).toBe('1');
  });
  it('R23-H3: explicit child lease releases on crash without opener bounce, dismiss returns once', async () => {
    quietErrors(); const b = opener(), events: Element[] = [];
    const record = () => events.push(document.activeElement!); document.addEventListener('focusin', record);
    let broken = false;
    function Child(props: LoadedLayerProps) { if (broken) throw Error('child crash'); return h(Independent, props); }
    let app: ReturnType<typeof mount>;
    const render = () => h(LazyOverlay, { name: 'hire', kind: 'dialog', covers: 'while-loading', onDismiss: () => app.unmount(), onRetry: vi.fn(), children: (props: LoadedLayerProps) => h(Child, props) });
    app = mount(h(StrictMode, null, render())); await settle();
    const child = openLayers()[0]; events.length = 0;
    broken = true; app.rerender(h(StrictMode, null, render())); await settle();
    expect(events).not.toContain(b); expect(openLayers()[0].id).not.toBe(child.id);
    expect(document.activeElement?.textContent).toBe('Try again');
    broken = false; act(() => (document.activeElement as HTMLElement).click());
    expect(events).not.toContain(b);
    press('Escape'); await settle(); expect(events.filter(e => e === b)).toHaveLength(1);
    document.removeEventListener('focusin', record);
  });
  it('D1/E6: pending Esc is owned over Health, and empty always coverage retains live focus', async () => {
    const b = opener(), chunk = gate();
    let app: ReturnType<typeof mount>;
    app = mount(h(LazyOverlay, { name: 'pending', kind: 'window', covers: 'always', onDismiss: () => app.unmount(), onRetry: chunk.retry }, h(chunk.Component)));
    expect(escapeIsFree({ key: 'Escape', defaultPrevented: false }, document)).toBe(false);
    expect(press('Escape').defaultPrevented).toBe(true);
    await settle(); expect(document.activeElement).toBe(b); expect(activeTrapCount()).toBe(0);
    const empty = gate();
    app = mount(h(LazyOverlay, { name: 'empty', kind: 'palette', covers: 'always', fallback: null, onDismiss: () => app.unmount(), onRetry: empty.retry }, h(empty.Component)));
    expect(activeTrapCount()).toBe(1); expect(document.querySelector('[data-lazy-overlay]')).toBeNull();
    expect(document.activeElement).toBe(b);
    press('Escape'); await settle(); expect(activeTrapCount()).toBe(0); expect(document.activeElement).toBe(b);
  });
  it('S9: attachment without a slot reports the error and creates no entry', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mount(h(Loaded));
    expect(activeTrapCount()).toBe(0); expect(error).toHaveBeenCalledWith('useLayerContainer requires a LayerSlot');
  });
  it('D15: lower page completion does not move palette focus', async () => {
    opener(); const chunk = gate();
    mount(h(LazyOverlay, { name: 'page', kind: 'page', covers: 'while-loading', onDismiss: vi.fn(), onRetry: chunk.retry }, h(chunk.Component)));
    mount(h(LazyOverlay, { name: 'palette', kind: 'palette', covers: 'always', onDismiss: vi.fn(), onRetry: vi.fn() }, h(Loaded)));
    const focus = document.activeElement, id = openLayers()[0].id;
    await chunk.resolve(Page);
    expect(openLayers().map(e => e.id)).toEqual([id]); expect(document.activeElement).toBe(focus);
  });
  it('R22-H1: stale loaded completion and detach cannot release a new cover', async () => {
    const b = opener();
    const owner = new LayerOwner({ name: 'page', kind: 'page', covers: 'while-loading', opener: b, onDismiss: vi.fn() });
    const app = mount(h(LayerSlot, { owner }, null));
    const shell = document.createElement('div'); shell.innerHTML = '<button>close</button>'; document.body.append(shell);
    owner.attach(shell, {}, 'loading'); const old = owner.handle!;
    owner.detach(shell); shell.remove();
    const page = document.createElement('div'); document.body.append(page); owner.loaded(page);
    expect(activeTrapCount()).toBe(0);
    const error = document.createElement('div'); error.innerHTML = '<button>retry</button>'; document.body.append(error);
    owner.attach(error, {}, 'error'); const current = owner.handle!;
    expect(current.id).not.toBe(old.id);
    owner.loaded(page); owner.detach(shell); owner.attach(shell, {}, 'loading'); old.release(); old.bindSurface(shell);
    expect(owner.handle).toBe(current); expect(activeTrapCount()).toBe(1);
    expect(document.activeElement?.textContent).toBe('retry');
    app.unmount(); await settle(); expect(document.activeElement).toBe(b);
  });
  it('R23-H3: repeated lower child crashes and external unmount never focus the opener', async () => {
    quietErrors(); const b = opener(), events: Element[] = [];
    const record = () => events.push(document.activeElement!); document.addEventListener('focusin', record);
    let broken = false;
    function Child(props: LoadedLayerProps) { if (broken) throw Error('child crash'); return h(Independent, props); }
    const render = () => h(LazyOverlay, { name: 'hire', kind: 'dialog', covers: 'while-loading', onDismiss: vi.fn(), onRetry: vi.fn(), children: (props: LoadedLayerProps) => h(Child, props) });
    const app = mount(render());
    const upper = mount(h(LazyOverlay, { name: 'palette', kind: 'palette', covers: 'always', onDismiss: vi.fn(), onRetry: vi.fn() }, h(Loaded)));
    const focus = document.activeElement; events.length = 0;
    for (let i = 0; i < 2; i++) {
      broken = true; app.rerender(render()); expect(document.activeElement).toBe(focus);
      broken = false; act(() => Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Try again')!.click());
      expect(document.activeElement).toBe(focus);
    }
    app.unmount(); await settle(); expect(events).not.toContain(b); expect(document.activeElement).toBe(focus);
    upper.unmount(); document.removeEventListener('focusin', record);
  });
  it('R23-H3: external leased child unmount returns once after layout settlement', async () => {
    const b = opener();
    const app = mount(h(LazyOverlay, { name: 'hire', kind: 'dialog', covers: 'while-loading', onDismiss: vi.fn(), onRetry: vi.fn(), children: (props: LoadedLayerProps) => h(Independent, props) }));
    const focus = vi.fn(); b.addEventListener('focus', focus);
    app.unmount(); await settle(); expect(focus).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(b);
  });

  it('D4: render retry can suspend again without changing the always activation', async () => {
    quietErrors(); opener(); const chunk = gate(); let broken = true;
    function Child() { if (broken) throw Error('retry suspension'); return h(chunk.Component); }
    const app = mount(h(LazyOverlay, { name: 'retry', kind: 'window', covers: 'always', onDismiss: vi.fn(), onRetry: chunk.retry }, h(Child)));
    const before = openLayers()[0]; broken = false;
    act(() => (document.activeElement as HTMLElement).click());
    expect(document.activeElement?.textContent).toBe('Close');
    expect(openLayers()[0].id).toBe(before.id);
    await chunk.resolve(Loaded);
    expect(openLayers()[0]).toMatchObject({ id: before.id, sequence: before.sequence });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('loaded'); app.unmount();
  });
  it('D15-Hire: cold leased child has a distinct id and the external opener', async () => {
    const b = opener(), chunk = gate<LoadedLayerProps>(); let app: ReturnType<typeof mount>;
    app = mount(h(LazyOverlay, { name: 'hire', kind: 'dialog', covers: 'while-loading', fallback: null, onDismiss: () => app.unmount(), onRetry: chunk.retry, children: (props: LoadedLayerProps) => h(chunk.Component, props) }));
    const cover = openLayers()[0].id;
    await chunk.resolve(Independent);
    expect(activeTrapCount()).toBe(1); expect(openLayers()[0].id).not.toBe(cover);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('independent');
    press('Escape'); await settle(); expect(document.activeElement).toBe(b);
  });
  it('D15: a page without a heading receives a focusable ordinary handoff root', async () => {
    opener(); const chunk = gate();
    mount(h(LazyOverlay, { name: 'page', kind: 'page', covers: 'while-loading', onDismiss: vi.fn(), onRetry: chunk.retry }, h(chunk.Component)));
    await chunk.resolve(() => h('span', null, 'plain page')); await frame();
    expect(activeTrapCount()).toBe(0); expect(document.activeElement?.textContent).toBe('plain page');
    expect(document.activeElement?.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement?.closest('[data-layer-surface]')).toBeNull();
  });
  it('settled external teardown preserves a new intentional destination', async () => {
    opener(); const destination = document.createElement('button'); document.body.append(destination);
    const app = mount(h(LazyOverlay, { name: 'window', kind: 'window', covers: 'always', onDismiss: vi.fn(), onRetry: vi.fn() }, h(Loaded)));
    app.unmount(); destination.focus(); await settle(); expect(document.activeElement).toBe(destination);
  });

  it('D20: StrictMode retains action-time opening order even when mount order differs', async () => {
    opener();
    const overlay = (key: string, openingSequence: number) => h(LazyOverlay, { key, name: key, openingSequence, kind: 'window', covers: 'always', onDismiss: vi.fn(), onRetry: vi.fn() }, h(Loaded));
    mount(h(StrictMode, null, overlay('newer', 10002), overlay('older', 10001)));
    await settle();
    expect(openLayers().map(e => [e.name, e.sequence])).toEqual([['newer', 10002], ['older', 10001]]);
    expect(openLayers()[0].container?.contains(document.activeElement)).toBe(true);
  });

});

it.each(['sidebar-team-export', 'sidebar-shortcuts', 'sidebar-hire', 'sidebar-templates', 'hire-templates'].flatMap(name => [false, true].map(rejected => ({ name, rejected }))))('R23-NULL: $name rejected=$rejected has usable shell, one return, and no resurrection', async ({ name, rejected }) => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const b = opener(), returned = vi.fn(); b.addEventListener('focus', returned);
  const chunk = gate<LoadedLayerProps>(); let app: ReturnType<typeof mount>; const dismiss = vi.fn(() => app.unmount());
  app = mount(h(LazyOverlay, { name, kind: 'dialog', covers: 'while-loading', fallback: null, onDismiss: dismiss, onRetry: chunk.retry, children: (lifecycle: LoadedLayerProps) => h(chunk.Component, lifecycle) }));
  const id = openLayers()[0].id;
  expect(document.querySelectorAll('#murage-layer-host > [data-layer-surface]')).toHaveLength(1); expect(document.activeElement?.textContent).toContain('Close');
  if (rejected) {
    await chunk.rejectChunk(); await settle(); expect(openLayers()[0].id).toBe(id); expect(document.activeElement?.textContent).toMatch(/try again|retry/i);
    const close = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Close')!; act(() => close.click());
  } else press('Escape');
  await settle(); expect(dismiss).toHaveBeenCalledOnce(); expect(returned).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(b); expect(activeTrapCount()).toBe(0);
  if (!rejected) { await chunk.resolve(Independent); await settle(); expect(activeTrapCount()).toBe(0); expect(returned).toHaveBeenCalledOnce(); }
});

// Astra r3 Medium 8: a caller's own loading content goes through the attached dismissible shell: a registered
// owner whose container holds it, a Close action, and Esc that dismisses.
it.each([['while-loading', 'escape'], ['while-loading', 'close'], ['always', 'escape'], ['always', 'close']] as const)('R5-M8: custom fallback covers=%s is shelled and dismisses by %s', async (covers, how) => {
  const b = opener(); const dismiss = vi.fn(); const chunk = gate();
  mount(h(LazyOverlay, { name: 'custom', kind: 'dialog', covers, onDismiss: dismiss, onRetry: chunk.retry, fallback: h('p', { id: 'custom-loading' }, 'Custom loading') }, h(chunk.Component)));
  await settle();
  const custom = document.getElementById('custom-loading')!;
  expect(custom).not.toBeNull();
  expect(openLayers()).toHaveLength(1);
  const container = openLayers()[0].container as HTMLElement | null;
  expect(container?.contains(custom)).toBe(true);
  expect(container?.hasAttribute('data-lazy-overlay')).toBe(true);
  expect(container?.contains(document.activeElement)).toBe(true);
  const close = Array.from(container!.querySelectorAll('button')).find(node => node.textContent?.trim() === 'Close');
  expect(close).toBeDefined();
  if (how === 'close') act(() => close!.click()); else press('Escape');
  await settle(); expect(dismiss).toHaveBeenCalledOnce(); expect(activeTrapCount()).toBe(0); expect(document.activeElement).toBe(b);
});
