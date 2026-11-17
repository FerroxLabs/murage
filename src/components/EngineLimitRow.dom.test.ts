// @vitest-environment jsdom
import { createElement as h } from 'react';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, installDOMHarness, mount, settle } from '../testing/dom-harness';
import { MessagesList } from './ChatView';
import { Transcript } from './GroupView';
import { CallEngineLimits } from './EngineLimitRow';
import { BotSettingsPane } from './BotSettingsPane';
const fixture = vi.hoisted(() => ({ state: { config: { showToolCalls: false }, showToolCalls: false, instances: [{ instanceId: 'fixture', driverKind: 'cursorAgent' }], bots: [], botSettingsIntent: { section: 'model' }, focusMessage: null } as any, dispatch: vi.fn() }));
vi.mock('@/state/store', async original => ({ ...(await original<typeof import('@/state/store')>()),
  useStore: () => fixture, useStoreActions: () => ({ dispatch: fixture.dispatch }),
  useStoreSelector: () => fixture.state, useStoreSnapshot: () => () => fixture.state,
  api: vi.fn(async () => ({})),
}));
vi.mock('@/lib/use-surface', async original => ({ ...(await original<any>()), useDesktopSurface: () => true }));
vi.mock('@/lib/bot-email', () => ({ useEmailStatus: () => ({ kind: 'off' }) }));
vi.mock('@/lib/learning-counts', async original => ({ ...(await original<any>()), useLearningBadge: () => 0 }));
vi.mock('./SettingsPanel', () => ({ SettingsPanel: () => null }));
const bot: any = { id: 'bot', name: 'Nova', threadId: 'thread', modelSelection: { instanceId: 'fixture', model: 'fixture' } };
const rows: any[] = [
  { id: 'ordinary', actorKind: 'bot', from: { botId: 'bot', name: 'Nova' }, role: 'bot', kind: 'activity', at: 1, tool: { name: 'ordinary fixture step', ok: true } },
  { id: 'limit', role: 'bot', kind: 'activity', actorKind: 'murage', at: 2, from: { botId: 'bot', name: 'Nova' }, tool: { name: 'engine limit: web-read:kimiAgent', ok: false } },
];
const copy = 'Kimi Code can still use its own web reader, which may cut long pages short. For pages you need in full, switch this bot to Fuigo, Claude, Codex or Gemini.';
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(async () => { cleanup(); await settle(); document.body.replaceChildren(); });
it.each([false, true])('T2-render direct and room with Tool calls=%s, including reload', async show => {
  fixture.state.showToolCalls = show; fixture.state.config = { features: { showToolCalls: show } };
  for (const room of [false, true]) for (const reload of [false, true]) {
    const messages = reload ? JSON.parse(JSON.stringify(rows)) : rows;
    const common: any = { messages, transcript: messages, onReply: vi.fn(), scrollRef: { current: null }, followRef: { current: false }, follow: false };
    const app = mount(room ? h(Transcript, { ...common, group: { id: 'room', threadId: 'thread' }, members: [bot] }) : h(MessagesList, { ...common, bot, editingId: null, editDrafts: {}, canRetryLast: false }));
    await settle();
    const notes = document.querySelectorAll('[data-testid="engine-limit-note"]');
    expect(notes, JSON.stringify({ room, reload, body: document.body.innerHTML })).toHaveLength(1);
    expect(notes[0].textContent).toBe(room ? 'Nova: ' + copy : copy);
    expect(document.body.textContent?.includes('ordinary fixture step')).toBe(show);
    app.unmount();
  }
});
it('T2-settings shows one engine row only for a limited engine', async () => {
  for (const driver of ['cursorAgent', 'claudeAgent']) {
    fixture.state.instances[0].driverKind = driver;
    const app = mount(h(BotSettingsPane, { bot, onClose: vi.fn() })); await settle();
    const notes = document.querySelectorAll('[data-testid="engine-limit-note"]');
    expect(notes).toHaveLength(driver === 'cursorAgent' ? 1 : 0);
    if (notes.length) expect(notes[0].textContent).toBe('Long web pagesCursor can still use its own web reader, which may cut long pages short. For pages you need in full, choose Fuigo, Claude, Codex or Gemini above.');
    app.unmount();
  }
});

it('T2-call retains limitation notes across call transcript reloads', () => {
  for (const room of [false, true]) {
    const app = mount(h(CallEngineLimits, { messages: JSON.parse(JSON.stringify(rows)), room }));
    expect(document.querySelector('[data-testid="engine-limit-note"]')?.textContent).toBe(room ? 'Nova: ' + copy : copy);
    expect(document.body.textContent).not.toContain('ordinary fixture step'); app.unmount();
  }
});
