// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Row 66 W1a: the row the server stores for an owner turn whose first MCP request the memory fence refused
// (server/mount-sealed-owner-claude.test.ts asserts this exact name) renders through the real chat transcript as ONE reason and ONE
// Retry, in the owner's language, and Retry reruns the message.
import { createElement as h } from 'react';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, installDOMHarness, mount, settle } from '../testing/dom-harness';
import { setLocale } from '@/lib/i18n';
import { REPLY_MEMORY_CHECK_FAILED } from '../../shared/memory-reply-copy';
import { MessagesList } from './ChatView';
const fixture = vi.hoisted(() => ({ state: { config: { showToolCalls: false }, showToolCalls: false, instances: [{ instanceId: 'fixture', driverKind: 'claudeAgent' }], bots: [] }, dispatch: () => {} }));
vi.mock('@/state/store', async original => ({ ...(await original<typeof import('@/state/store')>()),
  useStore: () => fixture, useStoreActions: () => ({ dispatch: fixture.dispatch }),
  useStoreSelector: () => fixture.state, useStoreSnapshot: () => () => fixture.state,
  api: vi.fn(async () => ({})),
}));
vi.mock('@/lib/use-surface', async original => ({ ...(await original<any>()), useDesktopSurface: () => true }));
vi.mock('@/lib/bot-email', () => ({ useEmailStatus: () => ({ kind: 'off' }) }));
vi.mock('@/lib/learning-counts', async original => ({ ...(await original<any>()), useLearningBadge: () => 0 }));
vi.mock('./SettingsPanel', () => ({ SettingsPanel: () => null }));
const bot: any = { id: 'bot', name: 'Nova', threadId: 'thread', modelSelection: { instanceId: 'fixture', model: 'fixture' }, messages: [] as any[] };
const rows: any[] = [
  { id: 'sent', role: 'user', kind: 'text', at: 1, text: 'Fixture owner line' },
  { id: 'failed', role: 'bot', kind: 'activity', actorKind: 'murage', at: 2, from: { botId: 'bot', name: 'Nova' }, tool: { name: `error: ${REPLY_MEMORY_CHECK_FAILED}`, ok: false } },
];
bot.messages = rows;
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(async () => { cleanup(); await settle(); document.body.replaceChildren(); await setLocale('en'); });
it.each([
  ['en', 'Murage couldn’t check memory, so your message was not sent.'],
  ['fr', 'Murage n’a pas pu vérifier la mémoire. Ton message n’a donc pas été envoyé.'],
])('the stored memory-check row shows one reason and one Retry that reruns the message (%s)', async (locale, reason) => {
  await setLocale(locale);
  const onRegenerate = vi.fn();
  const app = mount(h(MessagesList, { messages: rows, transcript: rows, onReply: vi.fn(), scrollRef: { current: null }, followRef: { current: false }, follow: false,
    bot, editingId: null, editDrafts: {}, canRetryLast: true, onRegenerate } as any));
  await settle();
  const alerts = [...document.querySelectorAll('[role="alert"]')];
  expect(alerts.map(a => a.querySelector('span')?.textContent), document.body.innerHTML).toEqual([reason]);
  expect(document.body.textContent?.split(reason).length).toBe(2);
  const buttons = alerts[0]!.querySelectorAll('button');
  expect(buttons).toHaveLength(1);
  (buttons[0] as HTMLButtonElement).click();
  expect(onRegenerate).toHaveBeenCalledTimes(1);
  app.unmount();
});
