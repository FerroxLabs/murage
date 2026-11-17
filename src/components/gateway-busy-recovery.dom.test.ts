// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// Mount the real transcript and model picker; only external I/O and unrelated
// composer/call surfaces are replaced. No production app or data is contacted.
import { act, createElement as h } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, installDOMHarness, mount, settle } from '../testing/dom-harness';
import { initialState, type AppState, type Bot } from '../state/store';
import { ChatView } from './ChatView';

const fixture = vi.hoisted(() => ({
  state: {} as AppState, dispatch: vi.fn(), refreshInstances: vi.fn(async () => {}),
  api: vi.fn(async () => ({ connections: [], outcomes: [], items: [] })),
}));
vi.mock('@/state/store', async original => ({
  ...await original<typeof import('../state/store')>(),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch, refreshInstances: fixture.refreshInstances }),
  useStoreActions: () => ({ dispatch: fixture.dispatch }),
  useStoreSelector: (select: (state: AppState) => unknown) => select(fixture.state),
  useStoreSnapshot: () => () => fixture.state,
  api: fixture.api,
}));
vi.mock('./Composer', () => ({ Composer: () => null }));
vi.mock('./DesktopCapabilities', () => ({ useDesktopCapabilities: () => ({ capabilities: {}, ready: true }) }));
vi.mock('./CallControls', () => ({ CallBarStrip: () => null, CallOverlaySlot: () => null, CallOverlay: () => null, CallButton: () => null, CallStatus: () => null }));
// Keep the actual ModelPicker, including its event listener and lazy dialog.
vi.mock('./ChatHeader', async () => {
  const { ModelPicker } = await import('./ModelPicker');
  return { ChatHeader: ({ bot }: { bot: Bot }) => h(ModelPicker, { bot }) };
});

let restore: () => void;
let bot: Bot;
const exportDiagnostics = vi.fn(async () => ({ ok: true }));
beforeAll(() => {
  restore = installDOMHarness();
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value() {} });
});
afterAll(() => { restore(); Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo'); });
beforeEach(() => {
  vi.clearAllMocks();
  window.matchMedia = vi.fn().mockImplementation((media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })));
  Object.defineProperty(window, 'muragebox', { configurable: true, value: { exportDiagnostics } });
  bot = {
    id: 'busy-bot', name: 'Fixture', threadId: 'busy-thread', color: 'blue',
    title: 'Fixture', description: '', notifications: false, unread: false, activity: 'idle', busy: false, tasks: [], modelSelection: { instanceId: 'fuigo-fixture', model: 'flux-auto' },
    messages: [
      { id: 'kept-message', at: 1, role: 'user', kind: 'text', text: 'Keep these exact words' },
      { id: 'refusal', at: 2, role: 'bot', kind: 'activity', tool: { name: 'error:Request refused', ok: false,
        busy: { engine: 'Fuigo', reason: 'repeated', shortReason: 'capacity unavailable' } } },
    ],
  };
  fixture.state = { ...initialState, bots: [bot], instances: [] };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, 'muragebox'); });

async function openChat() {
  const app = mount(h(ChatView, { bot }));
  await settle();
  expect(app.container.querySelectorAll('[data-gateway-busy="repeated"]')).toHaveLength(1);
  return app;
}
async function click(app: ReturnType<typeof mount>, selector: string) {
  const button = app.container.querySelector<HTMLButtonElement>(selector);
  expect(button, selector).not.toBeNull();
  await act(async () => { button!.click(); });
  await settle();
}
it('Try again replays the kept message through ChatView without changing the selected AI', async () => {
  const app = await openChat();
  expect(fixture.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'editMessage' }));
  await click(app, '[data-gateway-send-again]');
  expect(fixture.dispatch).toHaveBeenCalledWith({ type: 'editMessage', botId: bot.id, threadId: bot.threadId, messageId: 'kept-message', text: 'Keep these exact words' });
  expect(fixture.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'updateBot' }));
  expect(fixture.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'setModel' }));
  expect(exportDiagnostics).not.toHaveBeenCalled();
});
it('Use another AI opens the existing model picker without changing selection or retrying', async () => {
  const app = await openChat();
  expect(document.querySelector('[role="dialog"][aria-label="Choose model"]')).toBeNull();
  await click(app, '[data-gateway-choose-ai]');
  await act(async () => { await vi.dynamicImportSettled(); });
  expect(document.querySelector('[role="dialog"][aria-label="Choose model"]')).not.toBeNull();
  expect(fixture.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'editMessage' }));
  expect(fixture.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'updateBot' }));
  expect(fixture.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'setModel' }));
  expect(exportDiagnostics).not.toHaveBeenCalled();
});
it('Get help opens About at Diagnostics and exports the report once', async () => {
  const app = await openChat();
  expect(exportDiagnostics).not.toHaveBeenCalled();
  await click(app, '[data-gateway-help]');
  expect(fixture.dispatch).toHaveBeenCalledWith({ type: 'toggleAppSettings', open: true, section: 'about', anchor: 'diagnostics-heading' });
  expect(exportDiagnostics).toHaveBeenCalledTimes(1);
});
it('Get help still navigates to Diagnostics when the native export bridge is absent', async () => {
  Reflect.deleteProperty(window, 'muragebox');
  const app = await openChat();
  await click(app, '[data-gateway-help]');
  expect(fixture.dispatch).toHaveBeenCalledWith({ type: 'toggleAppSettings', open: true, section: 'about', anchor: 'diagnostics-heading' });
});
it('a Diagnostics export rejection is surfaced through the existing error state', async () => {
  exportDiagnostics.mockRejectedValueOnce(new Error('Report could not be saved'));
  const app = await openChat();
  await click(app, '[data-gateway-help]');
  expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Report could not be saved' }));
});
it.each(['busy', 'older'] as const)('a %s refusal cannot retry the wrong turn', async kind => {
  if (kind === 'busy') bot.busy = true;
  else bot.messages.push({ id: 'newer', at: 3, role: 'user', kind: 'text', text: 'New turn' });
  const app = await openChat();
  expect(app.container.querySelector('[data-gateway-send-again]')).toBeNull();
  expect(app.container.querySelector('[data-gateway-choose-ai]')).not.toBeNull();
});
