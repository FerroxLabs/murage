// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement as h, useRef, type ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, gate, installDOMHarness, mount, press, settle } from '../testing/dom-harness';
import { activeTrapCount, openLayers } from '../lib/focus-trap';
import { LazyOverlay } from './LazyOverlay';
import { LayerSurface } from './LayerSurface';
import { useLayerContainer } from './LayerSlot';
import { Sidebar, NewRoomPanel, ArchivedBotsPanel, ArchivedChannelsPanel } from './Sidebar';
import { RenameChannelDialog, MakeProjectDialog } from './GroupView';
import { NewTeamDialog } from './NewTeamDialog';
import { ChannelDetailsPanel } from './ChannelDetailsPanel';
import { ManageMembersPanel } from './ManageMembersPanel';
import { ConfirmDelete } from './ConfirmDelete';
import { LevelConfirmDialog } from './approval/LevelConfirmCard';
import { initialState, type Group } from '../state/store';
import { UpdateBanner } from './UpdateBanner';
import { CommandPaletteHost } from './CommandPaletteHost';
import { OPEN_PALETTE_EVENT } from '../lib/app-events';
const fixture = vi.hoisted(() => ({ state: {} as Record<string, unknown>, status: 'available', dismiss: vi.fn(), api: vi.fn(async () => ({})) }));
vi.mock('../lib/updater', () => ({ useUpdaterState: () => ({ status: fixture.status, version: 'fixture' }) }));
vi.mock('../lib/update-card', async original => ({ ...await original<typeof import('../lib/update-card')>(), useUpdateCardOpen: () => true, useUpdatePopup: () => false, closeUpdateCard: () => fixture.dismiss() }));
vi.mock('../state/store', async original => ({ ...await original<typeof import('../state/store')>(), useStore: () => ({ state: fixture.state, dispatch: vi.fn() }), api: fixture.api }));
const group = { id: 'g', name: 'Fixture', memberIds: [], messages: [], section: '', createdAt: 1 } as unknown as Group;
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => { fixture.state = { ...initialState }; fixture.status = 'available'; fixture.dismiss.mockClear(); fixture.api.mockReset().mockResolvedValue({}); });
afterEach(async () => { cleanup(); await settle(); expect(activeTrapCount()).toBe(0); document.body.replaceChildren(); delete window.muragebox; });
const cases: Array<[string, (close: () => void, b: HTMLButtonElement) => ReactNode]> = [
  ['level-confirm', close => h(LevelConfirmDialog, { bot: 'Fixture', target: 'full', keep: 'default' as never, effect: { kind: 'default', conversations: 0, routines: [] } as never, onThisComputer: false, onKeep: close, onUse: vi.fn() })],
  ['new-team', close => h(NewTeamDialog, { onClose: close, onDone: vi.fn() })],
  ['new-channel-form', close => h(NewRoomPanel, { onClose: close, kind: 'channel' })],
  ['new-project-form', close => h(NewRoomPanel, { onClose: close, kind: 'project' })],
  ['channel-details', (close, b) => h(ChannelDetailsPanel, { group, onClose: close, triggerRef: { current: b } })],
  ['manage-members', (close, b) => h(ManageMembersPanel, { group, onClose: close, triggerRef: { current: b } })],
  ['rename-channel', close => h(RenameChannelDialog, { group, onClose: close })],
  ['make-project', close => h(MakeProjectDialog, { group, onClose: close, onMade: vi.fn() })],
  ['archived-bots', close => h(ArchivedBotsPanel, { bots: [], groups: [], onClose: close, onRestored: vi.fn(), onDeleted: vi.fn() })],
  ['archived-channels', close => h(ArchivedChannelsPanel, { groups: [], onClose: close, onRestored: vi.fn() })],
  ['confirm-delete', close => h(ConfirmDelete, { name: 'Fixture', kind: 'item', detail: 'Fixture', onCancel: close, onConfirm: vi.fn() })],
];
function Settings({ close }: { close: () => void }) {
  const ref = useRef<HTMLDivElement>(null); useLayerContainer(ref, { onEscape: close, holdFocus: false });
  return h(LayerSurface, null, h('div', { ref, role: 'dialog', 'aria-modal': true, tabIndex: -1 }, h('button', null, 'Settings')));
}
it.each(cases.flatMap(([name, render]) => [false, true].map(lowerFirst => ({ name, render, lowerFirst }))))('R23-H2: actual $name lowerFirst=$lowerFirst has independent root/rank and top-only Escape', async ({ name, render, lowerFirst }) => {
  const b = document.createElement('button'); document.body.append(b); b.focus();
  const lowerClose = vi.fn(); const settings = () => mount(h(LazyOverlay, { name: 'settings', kind: 'window', covers: 'always', onDismiss: lowerClose, onRetry: vi.fn() }, h(Settings, { close: lowerClose })));
  let lower = lowerFirst ? settings() : undefined;
  let app: ReturnType<typeof mount>; const close = vi.fn(() => app.unmount()); app = mount(render(close, b)); await settle();
  const child = openLayers()[0]; expect(child.name).toBe(name); expect(child.kind).toBe('dialog'); expect((child.container as HTMLElement).getAttribute('aria-modal')).toBe('true'); expect(child.container?.contains(document.activeElement)).toBe(true);
  const heldFocus = document.activeElement; lower ??= settings(); expect(document.activeElement).toBe(heldFocus); expect(openLayers()).toHaveLength(2); expect(openLayers()[0].id).toBe(child.id);
  const surfaces = [...document.querySelectorAll<HTMLElement>('#murage-layer-host > [data-layer-surface]')]; expect(surfaces).toHaveLength(2); expect(new Set(surfaces.map(surface => surface.style.zIndex)).size).toBe(2);
  const chunk = gate(); let palette: ReturnType<typeof mount>;
  palette = mount(h(LazyOverlay, { name: 'palette', kind: 'palette', covers: 'always', fallback: null, onDismiss: () => palette.unmount(), onRetry: chunk.retry }, h(chunk.Component)));
  press('Escape'); await settle(); expect(close).not.toHaveBeenCalled(); expect(lowerClose).not.toHaveBeenCalled(); expect(openLayers()[0].id).toBe(child.id);
  press('Escape'); await settle(); expect(close).toHaveBeenCalledOnce(); expect(lowerClose).not.toHaveBeenCalled(); expect(openLayers()).toHaveLength(1);
  press('Escape'); expect(lowerClose).toHaveBeenCalledOnce(); lower.unmount();
});

// Astra r3 Medium 7: "Channel details opens and closes like members" promised the return to the supplied trigger.
// Focus sits on another control at mount, so only the explicit triggerRef can make the return land on the trigger.
it.each(['channel-details', 'manage-members'] as const)('R5-M7: actual %s returns to its supplied trigger, not the focus at mount', async name => {
  const trigger = document.createElement('button'), elsewhere = document.createElement('button');
  document.body.append(trigger, elsewhere); elsewhere.focus();
  const returned = vi.fn(); trigger.addEventListener('focus', returned);
  let app: ReturnType<typeof mount>; const close = vi.fn(() => app.unmount());
  const render = cases.find(([caseName]) => caseName === name)![1];
  app = mount(render(close, trigger)); await settle();
  expect(openLayers()[0].name).toBe(name);
  expect(openLayers()[0].container?.contains(document.activeElement)).toBe(true);
  press('Escape'); await settle();
  expect(close).toHaveBeenCalledOnce(); expect(activeTrapCount()).toBe(0);
  expect(document.activeElement).toBe(trigger); expect(returned).toHaveBeenCalledOnce();
});

it.each(['installing', 'available', 'idle', 'checking'])('R23-H2: update card %s consumes busy Escape and has no hidden entry', async status => {
  window.muragebox = { updater: {} } as never;
  fixture.status = status; const b = document.createElement('button'); document.body.append(b); b.focus();
  mount(h(UpdateBanner)); await settle();
  if (status === 'idle' || status === 'checking') { expect(activeTrapCount()).toBe(0); expect(document.activeElement).toBe(b); return; }
  expect(openLayers()[0].name).toBe('update-card'); expect(openLayers()[0].container).toBe(document.activeElement);
  press('Escape'); expect(fixture.dismiss).toHaveBeenCalledTimes(status === 'installing' ? 0 : 1);
});
it('R23-H2: New Team busy consumes Escape without closing or returning', async () => {
  const b = document.createElement('button'); document.body.append(b); b.focus();
  fixture.state.bots = [{ id: 'b', name: 'Fixture bot', modelSelection: { instanceId: 'x' }, hidden: false }];
  fixture.api.mockImplementation(() => new Promise(() => {})); const close = vi.fn();
  mount(h(NewTeamDialog, { onClose: close, onDone: vi.fn() }));
  const input = document.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Fixture team'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  act(() => document.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
  const create = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Create Team'))!; expect(create.disabled).toBe(false); act(() => create.click()); await settle();
  expect(fixture.api).toHaveBeenCalled(); const id = openLayers()[0].id; press('Escape'); expect(close).not.toHaveBeenCalled(); expect(openLayers()[0].id).toBe(id); expect(document.activeElement).not.toBe(b);
});
it('R23-H2: update card captures its action opener after an idle mount', async () => {
  window.muragebox = { updater: {} } as never; fixture.status = 'idle'; const app = mount(h(UpdateBanner));
  const b = document.createElement('button'); document.body.append(b); b.focus(); const returned = vi.fn(); b.addEventListener('focus', returned);
  fixture.status = 'available'; app.rerender(h(UpdateBanner)); expect(openLayers()[0].container).toBe(document.activeElement);
  app.unmount(); await settle(); expect(document.activeElement).toBe(b); expect(returned).toHaveBeenCalledOnce();
});


it('R3b Sidebar export preserves the New or share opener after its menu unmounts', async () => {
  fixture.api.mockResolvedValue({ bots: [], groups: [], playbooks: [], routines: [], skills: [] });
  const app = mount(h(Sidebar, { open: true, onClose: vi.fn() }));
  const opener = document.querySelector<HTMLButtonElement>('[aria-label="New or share"]')!;
  expect(opener).not.toBeNull();
  act(() => { opener.focus(); opener.click(); });
  const item = Array.from(document.querySelectorAll('button')).find(node => node.textContent?.trim() === 'Export bots…')!;
  act(() => { item.focus(); item.click(); });
  expect(openLayers()[0].name).toBe('team-export');
  press('Escape');
  await settle();
  expect(document.activeElement).toBe(opener);
  app.unmount();
});

// Astra r3 Medium 7: "Hire persistent Sidebar trigger return" on the actual Sidebar caller: + menu, then the
// template chooser, which disappears when Hire opens; Hire starts in the job box and Escape lands on +.
it('R5-M7: actual Sidebar Hire, opened from the vanishing chooser, starts in the job box and returns to +', async () => {
  fixture.api.mockResolvedValue({ bots: [], groups: [], playbooks: [], routines: [], skills: [], templates: [] });
  const app = mount(h(Sidebar, { open: true, onClose: vi.fn() }));
  const opener = document.querySelector<HTMLButtonElement>('[aria-label="New or share"]')!;
  const returned = vi.fn(); opener.addEventListener('focus', returned);
  act(() => { opener.focus(); opener.click(); });
  const newBot = Array.from(document.querySelectorAll<HTMLButtonElement>('#sidebar-create-options button')).find(node => node.textContent?.trim() === 'New Bot')!;
  act(() => { newBot.focus(); newBot.click(); });
  let entry: HTMLButtonElement | undefined;
  // The chooser is a lazy chunk: the first import in a test run can take a few seconds to transform.
  for (let tries = 0; tries < 200 && !entry; tries++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    entry = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(node => node.textContent?.includes('Hire in one sentence'));
  }
  expect(entry).toBeDefined();
  returned.mockClear();
  act(() => { entry!.focus(); entry!.click(); });
  for (let tries = 0; tries < 200 && !document.querySelector('#hire-bot-job'); tries++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(entry!.isConnected).toBe(false);
  expect(document.activeElement).toBe(document.querySelector('#hire-bot-job'));
  expect(openLayers()[0].name).toBe('hire-bot');
  expect(returned).not.toHaveBeenCalled();
  press('Escape'); await settle();
  expect(activeTrapCount()).toBe(0);
  expect(document.activeElement).toBe(opener); expect(returned).toHaveBeenCalledOnce();
  app.unmount();
});

// Astra r3 High 2: the create menu and the New chat filter are target-path Esc consumers. With an unresolved palette
// registered above them (it does not move focus), Esc belongs to the palette alone: the menu, its view and focus stay.
async function openCreateMenuUnderEmptyPalette(view: 'menu' | 'chat') {
  fixture.api.mockResolvedValue({ bots: [], groups: [], playbooks: [], routines: [], skills: [] });
  const chunk = gate<import('./CommandPalette').CommandPaletteProps>();
  mount(h('div', null, h(Sidebar, { open: true, onClose: vi.fn() }), h(CommandPaletteHost, { palette: chunk })));
  const opener = document.querySelector<HTMLButtonElement>('[aria-label="New or share"]')!;
  act(() => { opener.focus(); opener.click(); });
  await settle();
  if (view === 'chat') {
    const newChat = Array.from(document.querySelectorAll<HTMLButtonElement>('#sidebar-create-options button')).find(node => node.textContent?.trim() === 'New chat')!;
    act(() => { newChat.focus(); newChat.click(); });
    await settle();
    expect(document.querySelector('[data-testid="new-chat-panel"]')).not.toBeNull();
  }
  const target = view === 'chat'
    ? document.querySelector<HTMLInputElement>('[data-testid="new-chat-panel"] input')!
    : document.querySelector<HTMLButtonElement>('#sidebar-create-options button')!;
  act(() => target.focus());
  expect(document.activeElement).toBe(target);
  act(() => window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT, { detail: { query: '' } })));
  await settle();
  expect(openLayers().map(layer => layer.kind)).toEqual(['palette']);
  expect(document.activeElement).toBe(target);
  return { target, chunk };
}
it.each(['menu', 'chat'] as const)('R5-HIGH2: %s Esc under an unresolved palette closes only the palette; menu, view and focus stay', async view => {
  const { target } = await openCreateMenuUnderEmptyPalette(view);
  const event = press('Escape', target);
  await settle();
  expect(event.defaultPrevented).toBe(true);
  expect(activeTrapCount()).toBe(0);
  expect(document.querySelector('#sidebar-create-options')).not.toBeNull();
  expect(document.querySelector('[data-testid="new-chat-panel"]') !== null).toBe(view === 'chat');
  expect(document.activeElement).toBe(target);
  // With the palette gone the same Esc is the menu's again: it closes and focus goes back to +.
  press('Escape', target);
  await settle();
  if (view === 'menu') expect(document.querySelector('#sidebar-create-options')).toBeNull();
  else expect(document.querySelector('[data-testid="new-chat-panel"]')).toBeNull();
  expect(document.activeElement).toBe(document.querySelector('[aria-label="New or share"]'));
});
it.each(['menu', 'chat'] as const)('R5-HIGH2: %s respects an Esc already prevented below the palette owner', async view => {
  const { target } = await openCreateMenuUnderEmptyPalette(view);
  const prevented = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  prevented.preventDefault();
  act(() => { target.dispatchEvent(prevented); });
  await settle();
  expect(openLayers().map(layer => layer.kind)).toEqual(['palette']);
  expect(document.querySelector('#sidebar-create-options')).not.toBeNull();
  expect(document.activeElement).toBe(target);
  press('Escape', target); await settle();
  expect(activeTrapCount()).toBe(0);
});
