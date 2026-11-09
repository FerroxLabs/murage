// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// Astra r4 item 7: Today's Hire a bot, through its actual trigger (TeamChips Hire, TodayView setHireOpen), opens the
// hire-bot-today layer with focus in the job box, and Escape returns focus to the Hire button that opened it.
import { act, createElement as h } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, installDOMHarness, mount, press, settle } from '../../testing/dom-harness';
import { activeTrapCount, openLayers } from '../../lib/focus-trap';
import { initialState } from '../../state/store';

const fixture = vi.hoisted(() => ({ state: {} as Record<string, unknown>, api: vi.fn(async () => ({})) }));
vi.mock('../../state/store', async original => ({ ...await original<typeof import('../../state/store')>(), useStore: () => ({ state: fixture.state, dispatch: vi.fn() }), api: fixture.api }));
vi.mock('../shell/shell-nav', () => ({ useShellNav: () => new Proxy({}, { get: () => vi.fn() }) }));
vi.mock('./use-worth-a-look', () => ({ useWorthALook: () => ({ reconnect: [], handoffs: [] }) }));
vi.mock('./use-today-view', () => ({ useTodayView: () => ({ view: 'calm', set: vi.fn() }) }));
vi.mock('./use-engine-health', () => ({ useEngineReading: () => ({ engine: null }), useEngineHealthAnswer: () => null }));
vi.mock('../shell/lane-slots', () => ({ ClientsCard: () => null, MonthCard: () => null, useClientsTag: () => null, useMonthTag: () => null }));
vi.mock('../../lib/connectivity', () => ({ useConnectivity: () => ({ online: true }) }));
vi.mock('../../lib/connected-apps-preload', () => ({ cachedConnectorStatus: () => null, preloadConnectedApps: async () => undefined }));
vi.mock('../FirstRunChrome', () => ({ useSetupView: () => ({ view: null }) }));
vi.mock('../OpenBotListButton', () => ({ OpenBotListButton: () => null }));
vi.mock('./TellChiefBox', () => ({ TellChiefBox: () => null }));
const { TodayView } = await import('./TodayView');

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => { fixture.state = { ...initialState, connected: true, bots: [], templates: [] }; fixture.api.mockReset().mockResolvedValue({ bots: [], templates: [] }); });
afterEach(async () => { cleanup(); await settle(); expect(activeTrapCount()).toBe(0); document.body.replaceChildren(); });

it('R13-M7: Today Hire a bot opens the hire-bot layer (via hire-bot-today) in the job box and Escape returns to the Hire button', async () => {
  const app = mount(h(TodayView, { needs: { count: 0, stale: false, top: [], rows: [] } as never, health: 'ok' as never, firstRun: false, chiefBotId: null, remote: false }));
  await settle();
  const hire = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(node => node.textContent?.trim() === 'Hire a bot')!;
  expect(hire).toBeDefined();
  const returned = vi.fn(); hire.addEventListener('focus', returned);
  act(() => { hire.focus(); hire.click(); });
  for (let tries = 0; tries < 200 && !document.querySelector('#hire-bot-job'); tries++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(openLayers()[0].name).toBe('hire-bot');
  expect(document.activeElement).toBe(document.querySelector('#hire-bot-job'));
  returned.mockClear();
  press('Escape'); await settle();
  expect(openLayers()).toHaveLength(0);
  expect(document.querySelector('#hire-bot-job')).toBeNull();
  expect(activeTrapCount()).toBe(0);
  expect(document.activeElement).toBe(hire); expect(returned).toHaveBeenCalledOnce();
  app.unmount();
});
