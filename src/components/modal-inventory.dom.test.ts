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
import { FullAccessWarning } from './FullAccessWarning';
import { LocalComputerAutoWarning } from './LocalComputerAutoWarning';
import { RoutineSheet } from './routines/RoutineSheet';
import { ApproveAllSheet, Caution } from './ApproveAll';
import type { Routine } from '../lib/routines';
import { ConfirmRemoteAccess, RevokeDeviceConfirm } from './CompanionSection';
import { SectionContextDialog } from './SectionContextDialog';
import { createUndoHost } from '../lib/undo';
import { UndoToastHost } from './ui/UndoToast';
const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), state: { bots: [], groups: [], routineRuns: [], config: null } }));
vi.mock('../state/store', () => ({ useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }), api: vi.fn(async () => ({ text: '', maxBytes: 24000, updatedAt: null })) }));
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(async () => { cleanup(); await settle(); expect(activeTrapCount()).toBe(0); document.body.replaceChildren(); vi.clearAllMocks(); });
function opener() { const b = document.createElement('button'); document.body.append(b); b.focus(); return b; }
function Parent({ close, children }: { close: () => void; children?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayerContainer(ref, { onEscape: close, holdFocus: false });
  return h(LayerSurface, null, h('div', { ref, role: 'dialog', 'aria-modal': true }, h('button', null, 'parent'), children));
}
const routine = { id: 'r', botId: 'b', name: 'Fixture routine', enabled: true, schedule: { type: 'daily', time: '09:00', weekdays: [1, 2, 3, 4, 5], timezone: 'UTC' }, instructions: 'Do the fixture', createdAt: 1, updatedAt: 1 } as unknown as Routine;

describe('step 8 actual modal inventory', () => {
  it.each(['full', 'local', 'remote', 'section'])('H2/D13: %s warning owns its entry without replacing its parent', async kind => {
    opener(); const close = vi.fn(), cancel = vi.fn();
    const child = kind === 'full' ? h(FullAccessWarning, { open: true, botName: 'Fixture', onThisComputer: false, onCancel: cancel, onConfirm: vi.fn() })
      : kind === 'remote' ? h(ConfirmRemoteAccess, { busy: false, onCancel: cancel, onConfirm: vi.fn() })
      : kind === 'section' ? h(SectionContextDialog, { section: 'fixture', label: 'Fixture', onClose: cancel })
      : h(LocalComputerAutoWarning, { open: true, onCancel: cancel, onConfirm: vi.fn() });
    const render = (show: boolean) => h(LazyOverlay, { name: 'settings', kind: 'window', covers: 'always', onDismiss: close, onRetry: vi.fn() }, h(Parent, { close }, show ? child : null));
    const app = mount(render(false)), parent = openLayers()[0].container;
    app.rerender(render(true)); expect(activeTrapCount()).toBe(2); expect(openLayers()[1].container).toBe(parent);
    // BF-13 initial targets: Full access opens on Cancel, the local warning on its confirm, remote access on
    // its first control (Cancel), and the section editor on its textarea once the text has loaded.
    const dialog = openLayers()[0].container as HTMLElement;
    const target = () => kind === 'full' ? dialog.querySelector('[data-layer-cancel]')
      : kind === 'local' ? dialog.querySelector('[data-confirm]')
      : kind === 'remote' ? Array.from(dialog.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Cancel') ?? null
      : dialog.querySelector('textarea');
    // The section text loads first (a resolved api call, then its focus timer): bounded ticks, then assert.
    for (let tick = 0; tick < 40 && (!target() || document.activeElement !== target()); tick++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    }
    const initial = target();
    expect(initial, `${kind} initial target`).not.toBeNull(); expect(document.activeElement).toBe(initial);
    expect(openLayers()[0].container).not.toBe(parent);
    act(() => press('Escape')); expect(cancel).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled();
    app.rerender(render(false)); await settle(); expect(openLayers()[0].container).toBe(parent);
    act(() => press('Escape')); expect(close).toHaveBeenCalledOnce();
  });
  it('R24-H1 red proof: RoutineSheet cannot consume an empty palette Escape', async () => {
    opener(); const close = vi.fn();
    mount(h(RoutineSheet, { routine, canEdit: false, onClose: close, onEdit: vi.fn(), onOpenRun: vi.fn() }));
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Close"]') ?? document.querySelector('button')!;
    button.focus(); const chunk = gate(); let palette: ReturnType<typeof mount>;
    palette = mount(h(LazyOverlay, { name: 'palette', kind: 'palette', covers: 'always', fallback: null, onDismiss: () => palette.unmount(), onRetry: chunk.retry }, h(chunk.Component)));
    act(() => press('Escape', button)); await settle();
    expect(close).not.toHaveBeenCalled(); expect(openLayers().some(layer => layer.kind === 'palette')).toBe(false);
    expect(openLayers()[0].name).toBe('routine-sheet');
  });
  it('R24-INLINE: actual approval selection is a named group and yields Escape to empty palette', async () => {
    opener(); const cancel = vi.fn(), approve = vi.fn();
    mount(h(ApproveAllSheet, { preview: { eligible: [], more: 0 } as never, botName: () => 'Fixture', botOf: () => undefined, busy: false, onCancel: cancel, onApprove: approve }));
    const root = document.querySelector('[aria-labelledby="approve-all-sheet"]')!;
    expect(root.getAttribute('role')).toBe('group'); expect(root.hasAttribute('aria-modal')).toBe(false);
    const button = root.querySelector('button')!; button.focus();
    const chunk = gate(); let palette: ReturnType<typeof mount>;
    palette = mount(h(LazyOverlay, { name: 'palette', kind: 'palette', covers: 'always', fallback: null, onDismiss: () => palette.unmount(), onRetry: chunk.retry }, h(chunk.Component)));
    act(() => press('Escape', button)); await settle();
    expect(activeTrapCount()).toBe(0); expect(document.activeElement).toBe(button); expect(cancel).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled();
  });
});

it.each(['caution', 'sheet'].flatMap(step => [false, true].map(managed => ({ step, managed }))))('R24-INLINE: $step managed=$managed preserves selection and yields to genuine foreign roots', async ({ step, managed }) => {
  opener(); const cancel = vi.fn(), approve = vi.fn();
  const child = step === 'caution' ? h(Caution, { onReview: cancel, onContinue: approve }) : h(ApproveAllSheet, { preview: { eligible: [{ botId: 'b', requestId: 'r', threadId: 't', digest: 'd', wants: 'test', kindLine: 'command' }], more: 0, batchId: 'batch' } as never, botName: () => 'Fixture', botOf: () => undefined, busy: false, onCancel: cancel, onApprove: approve });
  mount(managed ? h(LazyOverlay, { name: 'settings', kind: 'window', covers: 'always', onDismiss: cancel, onRetry: vi.fn() }, h(Parent, { close: cancel }, child)) : child);
  const root = document.querySelector('[aria-labelledby="approve-all-' + step + '"]')!;
  expect(root.getAttribute('role')).toBe('group'); expect(root.hasAttribute('aria-modal')).toBe(false);
  const checkbox = root.querySelector<HTMLInputElement>('input')!; act(() => checkbox.click()); checkbox.focus(); const selected = checkbox.checked;
  const count = activeTrapCount(); expect(count).toBe(managed ? 1 : 0);
  const chunk = gate(); let palette: ReturnType<typeof mount>;
  palette = mount(h(LazyOverlay, { name: 'palette', kind: 'palette', covers: 'always', fallback: null, onDismiss: () => palette.unmount(), onRetry: chunk.retry }, h(chunk.Component)));
  for (const native of [false, true]) {
    const foreign = document.createElement(native ? 'dialog' : 'div');
    if (native) foreign.setAttribute('open', ''); else foreign.setAttribute('aria-modal', 'true');
    const input = document.createElement('input'); foreign.append(input); root.append(foreign); input.focus();
    expect(press('Escape', input).defaultPrevented).toBe(false); expect(press('Tab', input).defaultPrevented).toBe(false);
    expect(activeTrapCount()).toBe(count + 1); expect(document.activeElement).toBe(input); foreign.remove();
  }
  checkbox.focus(); press('Escape', checkbox); await settle(); expect(activeTrapCount()).toBe(count);
  expect(checkbox.checked).toBe(selected); expect(document.activeElement).toBe(checkbox); expect(cancel).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled();
});
it('R23-UNDO: empty palette consumes first Esc; editable, composing and prevented events preserve toast', async () => {
  const b = opener(), host = createUndoHost(), toast = mount(h(UndoToastHost, { host }));
  try {
    act(() => { host.offerUndo({ kind: 'local', key: 'fixture', message: 'Fixture', undo: vi.fn() }); });
    expect(document.querySelector('[data-undo-toast]')).not.toBeNull();
    const chunk = gate(); let palette: ReturnType<typeof mount>;
    palette = mount(h(LazyOverlay, { name: 'palette', kind: 'palette', covers: 'always', fallback: null, onDismiss: () => palette.unmount(), onRetry: chunk.retry }, h(chunk.Component)));
    press('Escape', b); await settle(); expect(host.view()).not.toBeNull(); expect(activeTrapCount()).toBe(0);
    const input = document.createElement('input'); document.body.append(input); input.focus(); press('Escape', input); expect(host.view()).not.toBeNull();
    b.focus(); press('Escape', b, { isComposing: true }); expect(host.view()).not.toBeNull();
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); event.preventDefault(); b.dispatchEvent(event); expect(host.view()).not.toBeNull();
    press('Escape', b); expect(host.view()).toBeNull(); expect(document.activeElement).toBe(b);
    expect(document.querySelector('[data-undo-toast]')).toBeNull();
  } finally { toast.unmount(); host.onPageHide(); }
});
it('BF-5: focus inside the real toast takes Esc past an open modal and editable rules, then returns to its opener', async () => {
  const b = opener(), host = createUndoHost(), toast = mount(h(UndoToastHost, { host }));
  const modal = document.createElement('div'); modal.setAttribute('aria-modal', 'true');
  const field = document.createElement('input'); modal.append(field); document.body.append(modal);
  try {
    act(() => { host.offerUndo({ kind: 'local', key: 'fixture', message: 'Fixture', undo: vi.fn() }); });
    const card = document.querySelector('[data-undo-toast]')!; expect(card).not.toBeNull();
    // Outside the toast an open modal and an editable target each keep it.
    b.focus(); press('Escape', b); expect(host.view()).not.toBeNull();
    field.focus(); press('Escape', field); expect(host.view()).not.toBeNull();
    // Focus inside the toast: Esc dismisses even though a modal is open.
    const dismiss = card.querySelector<HTMLButtonElement>('button:last-of-type')!;
    act(() => { b.focus(); dismiss.focus(); }); expect(card.contains(document.activeElement)).toBe(true);
    const event = press('Escape', dismiss); await settle();
    expect(event.defaultPrevented).toBe(false); expect(host.view()).toBeNull();
    expect(document.querySelector('[data-undo-toast]')).toBeNull();
    // The focused card went away: focus goes back to what held it before the toast.
    expect(document.activeElement).toBe(b);
  } finally { modal.remove(); toast.unmount(); host.onPageHide(); }
});
it('R23-H1: Revoke target ignores composition and higher empty palette', async () => {
  opener(); const cancel = vi.fn(), close = vi.fn();
  mount(h(LazyOverlay, { name: 'settings', kind: 'window', covers: 'always', onDismiss: close, onRetry: vi.fn() }, h(Parent, { close }, h(RevokeDeviceConfirm, { name: 'Fixture', busy: false, onCancel: cancel, onConfirm: vi.fn() }))));
  const button = document.querySelector<HTMLButtonElement>('[role="alertdialog"] button')!; button.focus();
  press('Escape', button, { isComposing: true }); expect(cancel).not.toHaveBeenCalled();
  const chunk = gate(); let palette: ReturnType<typeof mount>;
  palette = mount(h(LazyOverlay, { name: 'palette', kind: 'palette', covers: 'always', fallback: null, onDismiss: () => palette.unmount(), onRetry: chunk.retry }, h(chunk.Component)));
  press('Escape', button); await settle(); expect(cancel).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  press('Escape', button); expect(cancel).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled();
});

it('D13: busy remote confirmation consumes Escape without closing', () => {
  opener(); const cancel = vi.fn(); mount(h(ConfirmRemoteAccess, { busy: true, onCancel: cancel, onConfirm: vi.fn() }));
  const id = openLayers()[0].id; expect(press('Escape').defaultPrevented).toBe(true); expect(cancel).not.toHaveBeenCalled(); expect(openLayers()[0].id).toBe(id);
});
