// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement as h, StrictMode, useState } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, gate, installDOMHarness, mount, press, settle } from '../testing/dom-harness';
import { activeTrapCount, openLayers } from '../lib/focus-trap';
import { LazyOverlay } from './LazyOverlay';
import { RoutineSheet, RoutineListSheet } from './routines/RoutineSheet';
import { NewRoutineSheet } from './routines/NewRoutineSheet';
import { RoutineProblemsList } from './routines/RoutineProblemsList';
import { EventEditor, QuickComposer, EventDetails, PausedList, RoutineEditor, RoutinesPage } from './RoutineCalendarPage';
import { CalendarLifetime } from './CalendarLayer';
import { RoutineWatchPicker } from './RoutineWatchPicker';
import { WebhooksPanel } from './WebhooksPanel';
import { initialState } from '../state/store';
import { configReply } from '../state/hydrate-bodies';
import { pbConfig } from '../e2e/pullback-layers.responses';
import type { Routine, RoutineRun } from '../lib/routines';
const fixture = vi.hoisted(() => ({ desktop: true, state: {} as Record<string, unknown>, dispatch: vi.fn() }));
vi.mock('../state/store', async original => ({ ...await original<typeof import('../state/store')>(), useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }), api: async () => ({ calls: [], routines: [], runs: [], entries: [] }) }));
vi.mock('../lib/use-surface', () => ({ useDesktopSurface: () => fixture.desktop, useSurfaceState: () => ({ desktop: fixture.desktop, confirmed: true }) }));
vi.mock('./DesktopCapabilities', () => ({ useDesktopCapabilities: () => ({ capabilities: { host: { platform: 'linux' } }, ready: true }) }));
const routine: Routine = { id: 'r', botId: 'b', name: 'Fixture routine', prompt: 'Fixture task', target: 'bot', runOn: 'ember', enabled: true, schedule: { type: 'daily', time: '09:00', weekdays: [1,2,3,4,5] }, durationMinutes: 30, nextRunAt: 1, createdAt: 1, updatedAt: 1 };
const seed = { kind: 'routine' as const, at: Date.now(), durationMinutes: 30, botIds: [] };
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => { fixture.desktop = true; fixture.state = { ...initialState, routines: [routine] }; });
afterEach(async () => { cleanup(); await settle(); expect(activeTrapCount()).toBe(0); document.body.replaceChildren(); vi.restoreAllMocks(); });
function opener() { const b = document.createElement('button'); document.body.append(b); b.focus(); return b; }
const cases = [
  ['routine-watch', (close: () => void) => h(RoutineWatchPicker, { bots: [], onClose: close })],
  ['routine-editor', (close: () => void) => h(EventEditor, { seed, bots: [], onClose: close, onSavedCall: vi.fn() })],
  ['routine-quick-create', (close: () => void) => h(QuickComposer, { seed, bots: [], onClose: close, onMore: vi.fn(), onSavedCall: vi.fn(), onSavedRoutine: vi.fn() })],
  ['routine-sheet', (close: () => void) => h(RoutineSheet, { routine, canEdit: false, onClose: close, onEdit: vi.fn(), onOpenRun: vi.fn() })],
  ['routine-list', (close: () => void) => h(RoutineListSheet, { canCreate: false, onClose: close, onOpen: vi.fn(), onNew: vi.fn() })],
  ['new-routine-sheet', (close: () => void) => h(NewRoutineSheet, { onClose: close, onChange: vi.fn(), onAskInChat: vi.fn() })],
  ['routine-event-details', (close: () => void) => h(EventDetails, { item: { kind: 'routine', id: 'r', at: 1, durationMinutes: 30, routine, run: null }, bots: [], onClose: close, onEdit: vi.fn(), onCallChanged: vi.fn(), onOpenRoom: vi.fn() })],
  ['routine-paused-list', (close: () => void) => h(PausedList, { routines: [], bots: [], groups: [], onClose: close, onEdit: vi.fn(), onOpenRoom: vi.fn() })],
  ['routine-problems', (close: () => void) => h(RoutineProblemsList, { runs: [], bots: [], onClose: close, onOpen: vi.fn(), onMarkAllSeen: vi.fn() })],
  ['routine-editor-unavailable', (close: () => void) => { fixture.desktop = false; return h(RoutineEditor, { bots: [], onClose: close }); }],
] as const;
describe('R24 calendar inventory', () => {
  it.each(cases)('R24-H1: %s acquires, yields to empty palette, and returns once', async (name, render) => {
    const b = opener(), returned = vi.fn(); b.addEventListener('focus', returned);
    let app: ReturnType<typeof mount>; const close = vi.fn(() => app.unmount());
    app = mount(render(close)); expect(activeTrapCount()).toBe(1); const entry = openLayers()[0];
    expect(entry.name).toBe(name); expect(entry.kind).toBe('page'); expect(entry.container?.contains(document.activeElement)).toBe(true);
    expect(document.querySelectorAll('#murage-layer-host > [data-layer-surface]')).toHaveLength(1);
    const button = (entry.container as HTMLElement).querySelector('button')!; button.focus();
    const chunk = gate(); let palette: ReturnType<typeof mount>;
    palette = mount(h(LazyOverlay, { name: 'palette', kind: 'palette', covers: 'always', fallback: null, onDismiss: () => palette.unmount(), onRetry: chunk.retry }, h(chunk.Component)));
    press('Escape', button); await settle(); expect(close).not.toHaveBeenCalled(); expect(openLayers()[0].id).toBe(entry.id);
    press('Escape', button); await settle(); expect(close).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(b); expect(returned).toHaveBeenCalledOnce();
  });
  it.each(['sentence', 'editor', 'quick'])('R24-DIRTY/R23-CALENDAR: %s editable and dirty cancellation preserve draft/id/focus', async kind => {
    const b = opener(), returned = vi.fn(); b.addEventListener('focus', returned);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fixture.state.bots = [{ id: 'b', name: 'Fixture bot', threadId: 't', hidden: false }];
    let app: ReturnType<typeof mount>; const close = vi.fn(() => app.unmount());
    app = mount(kind === 'sentence' ? h(NewRoutineSheet, { onClose: close, onChange: vi.fn(), onAskInChat: vi.fn() }) : kind === 'editor' ? h(EventEditor, { seed, bots: [], onClose: close, onSavedCall: vi.fn() }) : h(QuickComposer, { seed, bots: [], onClose: close, onMore: vi.fn(), onSavedCall: vi.fn(), onSavedRoutine: vi.fn() }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(kind === 'sentence' ? 'textarea' : 'input')!;
    act(() => { Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(field, 'Keep this draft'); field.dispatchEvent(new Event('input', { bubbles: true })); });
    field.focus(); press('Escape', field); expect(confirm).not.toHaveBeenCalled(); expect(field.value).toBe('Keep this draft');
    const id = openLayers()[0].id, button = (openLayers()[0].container as HTMLElement).querySelector<HTMLButtonElement>('button')!;
    button.focus();
    for (const kind of ['window', 'palette'] as const) {
      const chunk = gate(); let upper: ReturnType<typeof mount>;
      upper = mount(h(LazyOverlay, { name: kind, kind, covers: 'always', fallback: null, onDismiss: () => upper.unmount(), onRetry: chunk.retry }, h(chunk.Component)));
      press('Escape', button); await settle(); expect(confirm).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    }
    press('Escape', button, { isComposing: true });
    const prevented = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); prevented.preventDefault(); button.dispatchEvent(prevented);
    expect(confirm).not.toHaveBeenCalled();
    press('Escape', button); expect(confirm).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled(); expect(openLayers()[0].id).toBe(id); expect(field.value).toBe('Keep this draft'); expect(document.activeElement).toBe(button);
    confirm.mockReturnValue(true); press('Escape', button); await settle(); expect(close).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(b); expect(returned).toHaveBeenCalledOnce();
  });
  it('R24-BRANCH: capability replacement and StrictMode retain the original opener without bouncing', async () => {
    const b = opener(), returned = vi.fn(); b.addEventListener('focus', returned); fixture.desktop = false;
    const render = () => h(StrictMode, null, h(RoutineEditor, { bots: [], onClose: vi.fn() }));
    const app = mount(render()); expect(openLayers()[0].name).toBe('routine-editor-unavailable');
    fixture.desktop = true; app.rerender(render()); await settle(); expect(openLayers()).toHaveLength(1); expect(openLayers()[0].name).toBe('routine-editor'); expect(returned).not.toHaveBeenCalled();
    fixture.desktop = false; app.rerender(render()); await settle(); expect(openLayers()[0].name).toBe('routine-editor-unavailable'); expect(returned).not.toHaveBeenCalled();
    app.unmount(); await settle(); expect(document.activeElement).toBe(b); expect(returned).toHaveBeenCalledOnce();
  });
});

it.each([false, true])('R24-HANDOFF: actual calendar list to sheet to editor below higher=%s keeps original opener', async higher => {
  const scroll = HTMLElement.prototype.scrollTo; HTMLElement.prototype.scrollTo = () => {};
  try {
    mount(h(RoutinesPage, { onBack: vi.fn(), onOpenRoom: vi.fn() })); await settle();
    const button = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('All routines'))!;
    expect(button).toBeDefined(); button.focus(); const returned = vi.fn(); button.addEventListener('focus', returned);
    act(() => button.click()); await settle(); const listId = openLayers()[0].id; expect(openLayers()[0].name).toBe('routine-list');
    const chunk = gate();
    const upper = higher ? mount(h(LazyOverlay, { name: 'settings', kind: 'window', covers: 'always', onDismiss: vi.fn(), onRetry: chunk.retry }, h(chunk.Component))) : null;
    const upperFocus = document.activeElement;
    const calendar = () => openLayers().filter(entry => entry.kind === 'page');
    const row = Array.from(document.querySelectorAll('[data-routine-list] button')).find(b => b.textContent?.includes('Fixture routine')) as HTMLButtonElement;
    expect(row).toBeDefined(); act(() => row.click()); await settle(); expect(calendar()).toHaveLength(1); expect(calendar()[0].name).toBe('routine-sheet'); expect(calendar()[0].id).not.toBe(listId); const sheetId = calendar()[0].id; expect(returned).not.toHaveBeenCalled();
    const edit = Array.from(document.querySelectorAll('[data-routine-sheet] button')).find(b => b.textContent?.trim() === 'Edit') as HTMLButtonElement;
    act(() => edit.click()); await settle(); expect(calendar()).toHaveLength(1); expect(calendar()[0].name).toBe('routine-editor'); expect(calendar()[0].id).not.toBe(sheetId); expect(returned).not.toHaveBeenCalled();
    if (upper) { expect(document.activeElement).toBe(upperFocus); upper.unmount(); await settle(); }
    const close = (openLayers()[0].container as HTMLElement).querySelector<HTMLButtonElement>('button')!; close.focus(); press('Escape', close); await settle(); expect(openLayers()).toHaveLength(0); expect(document.activeElement).toBe(button); expect(returned).toHaveBeenCalledOnce();
  } finally { HTMLElement.prototype.scrollTo = scroll; }
});

it.each(['paused', 'problems'])('R24-HANDOFF: actual %s to editor retains the external opener', async source => {
  const scroll = HTMLElement.prototype.scrollTo; HTMLElement.prototype.scrollTo = () => {};
  fixture.state.routines = [{ ...routine, enabled: source !== 'paused' }];
  const run = { id: 'run', routineId: 'r', routineName: routine.name, target: 'bot', botId: 'b', runOn: 'ember', scheduledFor: Date.now(), status: 'failed', manual: false, error: 'Fixture failure' } as RoutineRun;
  fixture.state.routineRuns = source === 'problems' ? [run] : [];
  try {
    mount(h(RoutinesPage, { onBack: vi.fn(), onOpenRoom: vi.fn() })); await settle();
    const button = document.querySelector<HTMLButtonElement>(source === 'paused' ? '[aria-label="Paused routines (1)"]' : '[aria-label="Show routine problems"]')!;
    expect(button).not.toBeNull(); button.focus(); const returned = vi.fn(); button.addEventListener('focus', returned); act(() => button.click()); await settle();
    const firstId = openLayers()[0].id;
    if (source === 'problems') {
      expect(document.activeElement?.hasAttribute('data-layer-close')).toBe(true);
      act(() => document.querySelector<HTMLButtonElement>('[aria-label="Open Fixture routine run"]')!.click()); await settle(); expect(openLayers()[0].name).toBe('routine-event-details'); expect(openLayers()[0].id).not.toBe(firstId); expect(returned).not.toHaveBeenCalled();
    }
    const outgoing = openLayers()[0].id;
    const edit = Array.from((openLayers()[0].container as HTMLElement).querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.trim() === 'Edit')!;
    expect(edit).toBeDefined(); act(() => edit.click()); await settle(); expect(openLayers()).toHaveLength(1); expect(openLayers()[0].name).toBe('routine-editor'); expect(openLayers()[0].id).not.toBe(outgoing); expect(returned).not.toHaveBeenCalled();
    const close = (openLayers()[0].container as HTMLElement).querySelector<HTMLButtonElement>('button')!; close.focus(); press('Escape', close); await settle(); expect(activeTrapCount()).toBe(0); expect(document.activeElement).toBe(button); expect(returned).toHaveBeenCalledOnce();
  } finally { HTMLElement.prototype.scrollTo = scroll; }
});
it.each(cases)('R24-H1: %s mounted and removed beneath Settings cannot acquire focus', async (_name, render) => {
  const b = opener(), returned = vi.fn(); b.addEventListener('focus', returned);
  const chunk = gate(); let settings: ReturnType<typeof mount>;
  settings = mount(h(LazyOverlay, { name: 'settings', kind: 'window', covers: 'always', onDismiss: () => settings.unmount(), onRetry: chunk.retry }, h(chunk.Component)));
  const held = document.activeElement, settingsId = openLayers()[0].id;
  const close = vi.fn(), page = mount(render(close)); await settle(); expect(activeTrapCount()).toBe(2); expect(openLayers()[0].id).toBe(settingsId); expect(document.activeElement).toBe(held); expect(close).not.toHaveBeenCalled();
  page.unmount(); await settle(); expect(document.activeElement).toBe(held); expect(openLayers()[0].id).toBe(settingsId); expect(returned).not.toHaveBeenCalled();
});

it('R2b: custom interval focuses on appearance without stealing focus on rerender', () => {
  const props = { seed: { ...seed, schedule: { type: 'interval' as const, everyMinutes: 15, anchorAt: seed.at } }, bots: [], onClose: vi.fn(), onSavedCall: vi.fn() };
  const app = mount(h(EventEditor, props));
  const select = document.querySelector<HTMLSelectElement>('[aria-label="How often this routine runs"]')!;
  act(() => { select.value = 'custom'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  const custom = document.querySelector<HTMLInputElement>('[aria-label="Custom interval in minutes"]')!;
  expect(document.activeElement).toBe(custom);
  const title = document.querySelector<HTMLInputElement>('input')!; title.focus();
  app.rerender(h(EventEditor, { ...props }));
  expect(document.activeElement).toBe(title);
});
it('R2b: delete Keep focuses on appearance without stealing focus on rerender', () => {
  const props = { routine, canEdit: true, onClose: vi.fn(), onEdit: vi.fn(), onOpenRun: vi.fn() };
  const app = mount(h(RoutineSheet, props));
  const button = (word: string) => Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === word)!;
  act(() => button('Delete').click());
  const keep = document.activeElement;
  expect(keep?.textContent).toContain('Keep');
  const remove = button('Delete'); remove.focus();
  app.rerender(h(RoutineSheet, { ...props }));
  expect(document.activeElement).toBe(remove);
});
it.each(['interval', 'delete'])('R2b: newly shown %s control yields local focus to a higher layer', kind => {
  if (kind === 'interval') mount(h(EventEditor, { seed: { ...seed, schedule: { type: 'interval' as const, everyMinutes: 15, anchorAt: seed.at } }, bots: [], onClose: vi.fn(), onSavedCall: vi.fn() }));
  else mount(h(RoutineSheet, { routine, canEdit: true, onClose: vi.fn(), onEdit: vi.fn(), onOpenRun: vi.fn() }));
  const chunk = gate();
  mount(h(LazyOverlay, { name: 'palette', kind: 'palette', covers: 'always', onDismiss: vi.fn(), onRetry: chunk.retry }, h(chunk.Component)));
  const focus = document.activeElement;
  if (kind === 'interval') {
    const select = document.querySelector<HTMLSelectElement>('[aria-label="How often this routine runs"]')!;
    act(() => { select.value = 'custom'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(document.querySelector('[aria-label="Custom interval in minutes"]')).not.toBeNull();
  } else {
    const remove = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Delete')!;
    act(() => remove.click());
    expect(Array.from(document.querySelectorAll('button')).some(b => b.textContent?.trim() === 'Keep it')).toBe(true);
  }
  expect(document.activeElement).toBe(focus);
});

it.each(['interval', 'delete'] as const)('R3-RESUME: %s appearance effect does not repeat when a higher layer closes', async kind => {
  opener();
  if (kind === 'interval') mount(h(EventEditor, { seed: { ...seed, schedule: { type: 'interval' as const, everyMinutes: 15, anchorAt: seed.at } }, bots: [], onClose: vi.fn(), onSavedCall: vi.fn() }));
  else mount(h(RoutineSheet, { routine, canEdit: true, onClose: vi.fn(), onEdit: vi.fn(), onOpenRun: vi.fn() }));
  if (kind === 'interval') {
    const select = document.querySelector<HTMLSelectElement>('[aria-label="How often this routine runs"]')!;
    act(() => { select.value = 'custom'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  } else act(() => Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Delete')!.click());
  const appearance = document.activeElement as HTMLElement;
  expect(kind === 'interval' ? appearance.getAttribute('aria-label') : appearance.textContent).toContain(kind === 'interval' ? 'Custom interval' : 'Keep');
  const appearanceFocus = vi.spyOn(appearance, 'focus');
  try {
    // Resume must preserve this deliberately chosen control, not repeat first focus.
    const destination = kind === 'interval' ? document.querySelector<HTMLInputElement>('input')! : Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Delete')!;
    destination.focus();
    const entry = openLayers()[0];
    const chunk = gate(); let upper: ReturnType<typeof mount>;
    upper = mount(h(LazyOverlay, { name: 'resume-upper', kind: 'window', covers: 'always', onDismiss: () => upper.unmount(), onRetry: chunk.retry }, h(chunk.Component)));
    expect(document.activeElement).not.toBe(destination);
    press('Escape'); await settle();
    expect(openLayers()).toHaveLength(1); expect(openLayers()[0].id).toBe(entry.id);
    expect(document.activeElement).toBe(destination);
    expect(appearanceFocus).not.toHaveBeenCalled();
  } finally { appearanceFocus.mockRestore(); }
});

it.each(['none', 'window', 'palette'] as const)('R24-HANDOFF BF-25: quick More options commits without return under %s', async higher => {
  fixture.state.config = configReply(pbConfig);
  const scroll = HTMLElement.prototype.scrollTo; HTMLElement.prototype.scrollTo = () => {};
  try {
    const external = opener();
    const committed = vi.fn();
    function Swap() {
      const [stage, setStage] = useState('quick');
      if (stage === 'closed') return null;
      return h(CalendarLifetime, { children: lifecycle => stage === 'quick'
        ? h(QuickComposer, { lifecycle, seed, bots: [], onClose: () => setStage('closed'), onSavedCall: vi.fn(), onSavedRoutine: vi.fn(), onMore: next => {
          committed(openLayers().some(l => l.name === 'routine-quick-create'));
          expect(next.at).toBe(seed.at); setStage('editor');
        } })
        : stage === 'editor' ? h(EventEditor, { lifecycle, seed, bots: [], onClose: () => setStage('closed'), onSavedCall: vi.fn() }) : null });
    }
    mount(h(Swap)); await settle();
    expect(openLayers()[0].name).toBe('routine-quick-create');
    const returned = vi.fn(); external.addEventListener('focus', returned);
    const chunk = gate();
    const upper = higher === 'none' ? null : mount(h(LazyOverlay, { name: higher, kind: higher, covers: 'always', fallback: higher === 'palette' ? null : undefined, onDismiss: vi.fn(), onRetry: chunk.retry }, h(chunk.Component)));
    const held = document.activeElement;
    const focused = vi.fn(); document.addEventListener('focusin', focused);
    try {
      const more = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'More options')!;
      act(() => more.click()); await settle();
      expect(openLayers().filter(l => l.kind === 'page').map(l => l.name)).toEqual(['routine-editor']);
      expect(returned).not.toHaveBeenCalled(); expect(committed).toHaveBeenCalledWith(false);
      if (upper) { expect(focused).not.toHaveBeenCalled(); expect(document.activeElement).toBe(higher === 'palette' ? document.body : held); upper.unmount(); await settle(); }
      const editor = openLayers()[0].container as HTMLElement;
      expect(editor.getAttribute('role')).toBe('dialog');
      expect(editor.getAttribute('aria-label')).toBe('New routine');
      expect(document.querySelector('[aria-label="Quick create"]')).toBeNull();
      expect(document.activeElement).not.toBe(external);
      expect(document.activeElement).toBe(editor.querySelector('input'));
      const close = editor.querySelector('button')!; close.focus(); press('Escape', close); await settle();
      expect(document.activeElement).toBe(external); expect(returned).toHaveBeenCalledOnce();
    } finally { document.removeEventListener('focusin', focused); }
  } finally { HTMLElement.prototype.scrollTo = scroll; }
});
it('R24-AUDIT BF-24: Watch a file blocks the calendar c shortcut', async () => {
  fixture.state.bots = [{ id: 'b', name: 'Bot', threadId: 't' }];
  const scroll = HTMLElement.prototype.scrollTo; HTMLElement.prototype.scrollTo = () => {};
  try {
    mount(h(RoutinesPage, { onBack: vi.fn(), onOpenRoom: vi.fn() })); await settle();
    const watch = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Watch a file')!;
    watch.focus(); act(() => watch.click()); await settle();
    const cancel = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Cancel')!;
    cancel.focus(); press('c', cancel); await settle();
    expect(openLayers().map(l => l.name)).toEqual(['routine-watch']);
    press('Escape', cancel); await settle(); expect(openLayers()).toHaveLength(0); expect(document.activeElement).toBe(watch);
  } finally { HTMLElement.prototype.scrollTo = scroll; }
});
it('R24-H1 BF-26: webhook editor yields to Settings, consumes editable Escape and returns', async () => {
  mount(h(WebhooksPanel, { bots: [{ id: 'b', name: 'Bot' } as import('../state/store').Bot] }));
  const launch = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Create local webhook')!;
  launch.focus(); act(() => launch.click()); await settle();
  expect(openLayers().map(l => l.name)).toEqual(['webhook-editor']);
  const editor = openLayers()[0].container as HTMLElement;
  expect(document.activeElement).toBe(editor.querySelector('button'));
  const chunk = gate(); let settings: ReturnType<typeof mount>;
  settings = mount(h(LazyOverlay, { name: 'settings', kind: 'window', covers: 'always', onDismiss: () => settings.unmount(), onRetry: chunk.retry }, h(chunk.Component)));
  press('Escape'); await settle(); expect(openLayers().map(l => l.name)).toEqual(['webhook-editor']);
  act(() => { editor.querySelector('details')!.open = true; });
  const field = editor.querySelector('input')!; field.focus(); press('Escape', field); expect(openLayers()).toHaveLength(1);
  const cancel = Array.from(editor.querySelectorAll('button')).find(b => b.textContent === 'Cancel')!; cancel.focus(); press('Escape', cancel); await settle();
  expect(openLayers()).toHaveLength(0); expect(document.activeElement).toBe(launch);
});

it.each([false, true])('R24-H1 BF-24: Watch and Settings Escape order reverse=%s', async reverse => {
  const external = opener(); const chunk = gate();
  let watch: ReturnType<typeof mount>, settings: ReturnType<typeof mount>;
  const close = vi.fn(() => watch.unmount());
  const openSettings = () => { settings = mount(h(LazyOverlay, { name: 'settings', kind: 'window', covers: 'always', onDismiss: () => settings.unmount(), onRetry: chunk.retry }, h(chunk.Component))); };
  if (reverse) openSettings();
  const held = document.activeElement;
  watch = mount(h(RoutineWatchPicker, { bots: [], onClose: close }));
  if (reverse) expect(document.activeElement).toBe(held);
  else { expect(document.activeElement?.tagName).toBe('SELECT'); openSettings(); }
  expect(openLayers().map(l => l.name)).toEqual(['settings', 'routine-watch']);
  press('Escape'); await settle(); expect(close).not.toHaveBeenCalled();
  expect(openLayers().map(l => l.name)).toEqual(['routine-watch']);
  const cancel = document.querySelector<HTMLButtonElement>('[aria-labelledby="watch-picker-title"] button')!;
  cancel.focus(); press('Escape', cancel); await settle(); expect(close).toHaveBeenCalledOnce();
  // In reverse order the watch opener is inside the now-removed Settings cover;
  // only the normal order has the external page button as its opener.
  if (!reverse) expect(document.activeElement).toBe(external);
});

it('R24-H1 BF-24b: Escape on the watch picker select, its first focus, closes it (a closed select has no Escape of its own)', async () => {
  opener(); const close = vi.fn();
  mount(h(RoutineWatchPicker, { bots: [], onClose: close }));
  const select = document.querySelector('select')!; select.focus();
  press('Escape', select); await settle();
  expect(close).toHaveBeenCalledOnce();
});
