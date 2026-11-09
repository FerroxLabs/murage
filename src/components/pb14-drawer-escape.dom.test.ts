// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// PULLBACK-1018 Low (c), after Fable seat 17's BLOCK on 1628092fc: the open phone drawer wins Escape over a loading
// PAGE shell, and the Escape owners inside the drawer (rail search, + menu) still win over the drawer. All on the
// real Sidebar, mounted.
import { act, createElement as h } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, installDOMHarness, mount, press, settle } from '../testing/dom-harness';
import { activeTrapCount, focusableWithin } from '../lib/focus-trap';
import { LazyOverlay } from './LazyOverlay';
import { Sidebar } from './Sidebar';
import { initialState } from '../state/store';

const fixture = vi.hoisted(() => ({ state: {} as Record<string, unknown>, api: vi.fn(async () => ({})) }));
vi.mock('../lib/updater', () => ({ useUpdaterState: () => ({ status: 'idle', version: 'fixture' }) }));
vi.mock('../state/store', async original => ({ ...await original<typeof import('../state/store')>(), useStore: () => ({ state: fixture.state, dispatch: vi.fn() }), api: fixture.api }));

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => { fixture.state = { ...initialState }; fixture.api.mockReset().mockResolvedValue({ bots: [], groups: [], playbooks: [], routines: [], skills: [], templates: [] }); });
afterEach(async () => { cleanup(); await settle(); expect(activeTrapCount()).toBe(0); document.body.replaceChildren(); delete window.muragebox; });

const never = new Promise<never>(() => {});
const Never = () => { throw never; };
const searchBox = () => document.querySelector<HTMLInputElement>('input[aria-label="Search bots and messages"]')!;

describe('pb14 (c): the open drawer and its inner Escape owners', () => {
  it('Escape in the rail search clears the query and keeps the drawer open', async () => {
    const onClose = vi.fn();
    mount(h(Sidebar, { open: true, onClose })); await settle();
    const input = searchBox(); expect(input).not.toBeNull();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { input.focus(); set.call(input, 'fixture'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(input.value).toBe('fixture');
    press('Escape', input);
    expect(input.value).toBe('');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape inside the + menu closes only the menu and returns focus to +', async () => {
    const onClose = vi.fn();
    mount(h(Sidebar, { open: true, onClose })); await settle();
    const opener = document.querySelector<HTMLButtonElement>('[aria-label="New or share"]')!;
    act(() => { opener.focus(); opener.click(); });
    const item = document.querySelector<HTMLButtonElement>('#sidebar-create-options button')!;
    act(() => { item.focus(); });
    press('Escape', item);
    expect(document.querySelector('#sidebar-create-options')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('with a loading page shell under the open drawer, Escape inside the + menu closes only the menu', async () => {
    const onClose = vi.fn(), dismiss = vi.fn();
    mount(h(LazyOverlay, { name: 'page-fixture', kind: 'page', covers: 'while-loading', onRetry: vi.fn(), onDismiss: dismiss }, h(Never)));
    mount(h(Sidebar, { open: true, onClose })); await settle();
    const opener = document.querySelector<HTMLButtonElement>('[aria-label="New or share"]')!;
    act(() => { opener.focus(); opener.click(); });
    const item = document.querySelector<HTMLButtonElement>('#sidebar-create-options button')!;
    act(() => { item.focus(); });
    press('Escape', item);
    expect(document.querySelector('#sidebar-create-options')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(onClose).not.toHaveBeenCalled(); expect(dismiss).not.toHaveBeenCalled();
  });

  it('with a loading page shell under the open drawer, Escape in the rail search clears it and keeps both', async () => {
    const onClose = vi.fn(), dismiss = vi.fn();
    mount(h(LazyOverlay, { name: 'page-fixture', kind: 'page', covers: 'while-loading', onRetry: vi.fn(), onDismiss: dismiss }, h(Never)));
    mount(h(Sidebar, { open: true, onClose })); await settle();
    const input = searchBox();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { input.focus(); set.call(input, 'fixture'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    press('Escape', input);
    expect(input.value).toBe('');
    expect(onClose).not.toHaveBeenCalled(); expect(dismiss).not.toHaveBeenCalled();
  });

  it('an Escape that any owner inside the drawer already used (preventDefault only) does not close the drawer', async () => {
    const onClose = vi.fn();
    mount(h(Sidebar, { open: true, onClose })); await settle();
    const input = searchBox();
    const owner = (event: KeyboardEvent) => event.preventDefault();
    input.addEventListener('keydown', owner);
    press('Escape', input);
    input.removeEventListener('keydown', owner);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a page shell registered over a palette does not hand Escape to the drawer: exactly one of the two layers takes it and the drawer stays', async () => {
    const onClose = vi.fn(), pageDismiss = vi.fn(), paletteDismiss = vi.fn();
    mount(h(LazyOverlay, { name: 'palette-fixture', kind: 'palette', covers: 'always', fallback: null, onRetry: vi.fn(), onDismiss: paletteDismiss }, h(Never)));
    mount(h(LazyOverlay, { name: 'page-fixture', kind: 'page', covers: 'while-loading', onRetry: vi.fn(), onDismiss: pageDismiss }, h(Never)));
    mount(h(Sidebar, { open: true, onClose })); await settle();
    press('Escape', document.body);
    expect(onClose).not.toHaveBeenCalled();
    expect(paletteDismiss.mock.calls.length + pageDismiss.mock.calls.length).toBe(1);
  });

  it.each(['menu', 'chat'] as const)('with a loading page shell under the open drawer, a Snooze popover keeps Escape from the + menu and the New chat filter (%s)', async view => {
    const onClose = vi.fn(), dismiss = vi.fn();
    mount(h(LazyOverlay, { name: 'page-fixture', kind: 'page', covers: 'while-loading', onRetry: vi.fn(), onDismiss: dismiss }, h(Never)));
    mount(h(Sidebar, { open: true, onClose })); await settle();
    const opener = document.querySelector<HTMLButtonElement>('[aria-label="New or share"]')!;
    act(() => { opener.focus(); opener.click(); });
    if (view === 'chat') {
      const newChat = Array.from(document.querySelectorAll<HTMLButtonElement>('#sidebar-create-options button')).find(node => node.textContent?.trim() === 'New chat')!;
      act(() => { newChat.click(); }); await settle();
    }
    const target = view === 'chat' ? document.querySelector<HTMLInputElement>('[data-testid="new-chat-panel"] input')! : document.querySelector<HTMLButtonElement>('#sidebar-create-options button')!;
    expect(target).not.toBeNull();
    const popover = document.createElement('div'); popover.setAttribute('data-snooze-popover', ''); document.body.append(popover);
    press('Escape', target); // the Snooze popover and the page shell own this key; neither the menu nor the drawer takes it
    expect(document.querySelector('#sidebar-create-options')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape with nothing inside it to take it closes the drawer', async () => {
    const onClose = vi.fn();
    mount(h(Sidebar, { open: true, onClose })); await settle();
    press('Escape', document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the open drawer takes Escape from a loading page shell: the drawer closes, the page stays', async () => {
    const onClose = vi.fn(), dismiss = vi.fn();
    mount(h(LazyOverlay, { name: 'page-fixture', kind: 'page', covers: 'while-loading', onRetry: vi.fn(), onDismiss: dismiss }, h(Never)));
    mount(h(Sidebar, { open: true, onClose }));
    await settle();
    press('Escape', document.body);
    expect(onClose).toHaveBeenCalledTimes(1); expect(dismiss).not.toHaveBeenCalled();
  });

  it('a loading page shell still takes Escape when no drawer is open', async () => {
    const dismiss = vi.fn();
    mount(h(Sidebar, { open: false, onClose: vi.fn() }));
    mount(h(LazyOverlay, { name: 'page-fixture', kind: 'page', covers: 'while-loading', onRetry: vi.fn(), onDismiss: dismiss }, h(Never)));
    await settle();
    press('Escape', document.body);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('a loading window shell holds Escape from the drawer', async () => {
    const onClose = vi.fn(), dismiss = vi.fn();
    mount(h(LazyOverlay, { name: 'window-fixture', kind: 'window', covers: 'while-loading', onRetry: vi.fn(), onDismiss: dismiss }, h(Never)));
    mount(h(Sidebar, { open: true, onClose }));
    await settle();
    press('Escape', document.body);
    expect(onClose).not.toHaveBeenCalled(); expect(dismiss).toHaveBeenCalledTimes(1);
  });

  // PULLBACK-1018 Fable seat 23 Low: Tab past the open drawer must not reach the page behind a loading page shell.
  describe('Tab inside the open drawer over a loading page shell', () => {
    const shell = () => mount(h(LazyOverlay, { name: 'page-fixture', kind: 'page', covers: 'while-loading', onRetry: vi.fn(), onDismiss: vi.fn() }, h(Never)));
    const drawerControls = () => {
      const aside = document.querySelector<HTMLElement>('[data-phone-drawer-open]')!;
      expect(aside).not.toBeNull();
      const controls = focusableWithin(aside as never) as unknown as HTMLElement[];
      expect(controls.length).toBeGreaterThan(1);
      return { aside, controls };
    };

    it('Tab from the last drawer control wraps to the first drawer control', async () => {
      shell();
      mount(h(Sidebar, { open: true, onClose: vi.fn() })); await settle();
      const { aside, controls } = drawerControls();
      const last = controls[controls.length - 1];
      act(() => { last.focus(); });
      const event = press('Tab', last);
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(controls[0]);
      expect(aside.contains(document.activeElement)).toBe(true);
    });

    it('Shift+Tab from the first drawer control wraps to the last drawer control', async () => {
      shell();
      mount(h(Sidebar, { open: true, onClose: vi.fn() })); await settle();
      const { controls } = drawerControls();
      act(() => { controls[0].focus(); });
      const event = press('Tab', controls[0], { shiftKey: true });
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(controls[controls.length - 1]);
    });

    it('control: with no page shell, Tab is left to the browser', async () => {
      mount(h(Sidebar, { open: true, onClose: vi.fn() })); await settle();
      const { controls } = drawerControls();
      const last = controls[controls.length - 1];
      act(() => { last.focus(); });
      const event = press('Tab', last);
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(last);
    });
  });
});
