// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, gate, installDOMHarness, mount, press, settle } from '../testing/dom-harness';
import { activeTrapCount, openLayers } from '../lib/focus-trap';
import { LazyOverlay, type LoadedLayerProps } from './LazyOverlay';
import { HireBotDialog } from './hire/HireBotDialog';
import { NewFromTemplateDialog } from './NewFromTemplateDialog';
import NewProjectDialog from './NewProjectDialog';
import { TeamSettingsDialog } from './TeamSettingsDialog';
import { initialState } from '../state/store';
const fixture = vi.hoisted(() => ({ state: {} as Record<string, unknown>, crash: false }));
vi.mock('../state/store', async original => ({ ...await original<typeof import('../state/store')>(), useStore: () => ({ state: fixture.state, dispatch: vi.fn() }), api: async () => { throw new Error('isolated unavailable data'); } }));
vi.mock('../lib/use-surface', () => ({ useDesktopSurface: () => false, useSurfaceState: () => ({ desktop: false, confirmed: true }) }));
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => { fixture.state = { ...initialState }; fixture.crash = false; });
afterEach(async () => { cleanup(); await settle(); expect(activeTrapCount()).toBe(0); document.body.replaceChildren(); vi.restoreAllMocks(); });
const cases: Array<[string, (lifecycle: LoadedLayerProps) => ReactNode]> = [
  ['hire', lifecycle => h(HireBotDialog, { layerLifecycle: lifecycle, onClose: lifecycle.dismiss })],
  ['template', lifecycle => h(NewFromTemplateDialog, { layerLifecycle: lifecycle, kind: 'bot', onClose: lifecycle.dismiss, onBlank: vi.fn(), onOpenFile: vi.fn(), onCreated: vi.fn() })],
  ['project', lifecycle => h(NewProjectDialog, { layerLifecycle: lifecycle, onClose: lifecycle.dismiss })],
  ['team', lifecycle => h(TeamSettingsDialog, { layerLifecycle: lifecycle, section: 'Fixture', focus: 'rename', onClose: lifecycle.dismiss })],
];
it.each(cases.flatMap(([name, render]) => [false, true].flatMap(cold => [false, true].map(inert => ({ name, render, cold, inert })))))('R22-RETURN: actual $name cold=$cold inert=$inert', async ({ name, render, cold, inert }) => {
  const b = document.createElement('button'), fallback = document.createElement('button'); fallback.dataset.focusFallback = ''; document.body.append(b, fallback); b.focus();
  const returned = vi.fn(); (inert ? fallback : b).addEventListener('focus', returned);
  const chunk = gate<{ lifecycle: LoadedLayerProps }>(); const Child = ({ lifecycle }: { lifecycle: LoadedLayerProps }) => render(lifecycle);
  let app: ReturnType<typeof mount>; const close = vi.fn(() => app.unmount());
  app = mount(h(LazyOverlay, { name, kind: 'dialog', covers: 'while-loading', fallback: null, onDismiss: close, onRetry: chunk.retry, children: (lifecycle: LoadedLayerProps) => cold ? h(chunk.Component, { lifecycle }) : h(Child, { lifecycle }) }));
  let cover: string | undefined;
  if (cold) { cover = openLayers()[0].id; expect(document.querySelector('#murage-layer-host [data-layer-surface]')).not.toBeNull(); expect(document.activeElement?.textContent).toContain('Close'); await chunk.resolve(Child); }
  await settle(); expect(activeTrapCount()).toBe(1); if (cover) expect(openLayers()[0].id).not.toBe(cover); expect(returned).not.toHaveBeenCalled();
  if (inert) b.setAttribute('inert', '');
  press('Escape'); await settle(); expect(close).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(inert ? fallback : b); expect(returned).toHaveBeenCalledOnce();
});
it.each(cases)('R23-H3: actual %s crash/retry makes no intermediate opener return', async (name, render) => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const b = document.createElement('button'); document.body.append(b); b.focus(); const returned = vi.fn(); b.addEventListener('focus', returned);
  const chunk = gate<{ lifecycle: LoadedLayerProps }>();
  const Child = ({ lifecycle }: { lifecycle: LoadedLayerProps }) => { if (fixture.crash) throw new Error('fixture render crash'); return render(lifecycle); };
  let app: ReturnType<typeof mount>; const close = vi.fn(() => app.unmount());
  const tree = () => h(LazyOverlay, { name, kind: 'dialog', covers: 'while-loading', fallback: null, onDismiss: close, onRetry: chunk.retry, children: (lifecycle: LoadedLayerProps) => h(chunk.Component, { lifecycle }) });
  app = mount(tree()); await chunk.resolve(Child); await settle(); const child = openLayers()[0].id;
  fixture.crash = true; app.rerender(tree()); await settle(); expect(activeTrapCount()).toBe(1); expect(openLayers()[0].id).not.toBe(child); expect(returned).not.toHaveBeenCalled();
  fixture.crash = false; const retry = Array.from(document.querySelectorAll('button')).find(b => /try again|retry/i.test(b.textContent ?? ''))!; act(() => retry.click()); await settle(); await chunk.resolve(Child); await settle(); expect(returned).not.toHaveBeenCalled();
  press('Escape'); await settle(); expect(close).toHaveBeenCalledOnce(); expect(returned).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(b);
});
// Astra r3 Medium 7: "Today and Done open Hire" was a source pin. The Done card's actual Hire row opens the actual
// Hire sheet, which starts in the job box and returns to that row's button on Escape.
it('R5-M7: actual Done card Hire row opens Hire in the job box and Escape returns to the row', async () => {
  const card = await import('./FirstRunNextCard');
  mount(h(card.FirstRunNextCard, { bot: { id: 'b', name: 'Fixture bot' } as never }));
  const hire = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(node => node.textContent?.trim() === 'Hire a bot')!;
  expect(hire).toBeDefined();
  const returned = vi.fn(); hire.addEventListener('focus', returned);
  act(() => { hire.focus(); hire.click(); });
  returned.mockClear();
  for (let tries = 0; tries < 200 && !document.querySelector('#hire-bot-job'); tries++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(document.activeElement).toBe(document.querySelector('#hire-bot-job'));
  expect(openLayers()[0].name).toBe('hire-bot');
  press('Escape'); await settle();
  expect(activeTrapCount()).toBe(0); expect(document.activeElement).toBe(hire); expect(returned).toHaveBeenCalledOnce();
});
