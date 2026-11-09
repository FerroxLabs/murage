import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('react', async original => { const actual = await original<typeof import('react')>(); return { ...actual, useSyncExternalStore: (subscribe: any, snapshot: any, server: any) => actual.useSyncExternalStore(subscribe, snapshot, server ?? snapshot) }; });
const fixture = vi.hoisted(() => ({ state: {} as any, pop: null as any }));
vi.mock('@/state/store', async original => { const actual = await original<typeof import('@/state/store')>(); return { ...actual, useStore: () => ({ state: { ...actual.initialState, ...fixture.state }, dispatch: vi.fn() }), useStoreActions: () => ({ dispatch: vi.fn() }) }; });
vi.mock('./use-reply-pop', () => ({ useReplyPop: () => fixture.pop }));
vi.mock('./DesktopCapabilities', () => ({ useDesktopCapabilities: () => ({ capabilities: {}, ready: true }) }));
vi.mock('./CallControls', () => ({ CallBarStrip: () => null, CallOverlaySlot: () => null, GroupCallOverlay: () => null, CallOverlay: () => null, GroupCallButton: () => null, CallButton: () => null, ActiveCallBar: () => null, CallStatus: () => null }));
vi.mock('./Composer', () => ({ Composer: () => null }));
const seen = vi.hoisted(() => [] as Array<{ src?: string; scope?: { botId: string; threadId: string } }>);
vi.mock('./ImageMedia', async importOriginal => {
  const actual = await importOriginal<typeof import('./ImageMedia')>();
  return { ...actual, MarkdownImage: (props: { src?: string; scope?: { botId: string; threadId: string } }) => { seen.push(props); return null; } };
});
import { ChatMarkdown } from './ChatMarkdown';
import { LiveReplyBubble } from './LiveReplyBubble';
beforeEach(() => { seen.length = 0; });
it('A6 preserves encoded Windows drive candidates only for image sources and forwards state scope', () => {
  const scope = { botId: 'owner', threadId: 'conversation' };
  renderToStaticMarkup(createElement(ChatMarkdown, { text: '![drive](C:%5Cwork%5Cp.png) ![file](file:///work/p.png) ![unc](%5C%5Cserver%5Cp.png)', scope }));
  expect(seen[0]).toMatchObject({ src: 'C:\\work\\p.png', scope });
  expect(seen[1]?.src).toBe(''); expect(seen[2]?.src).not.toBe('C:\\work\\p.png');
});
it('H2 forwards each actual live reply identity without taking forged identity from text', () => {
  for (const threadId of ['first', 'second']) renderToStaticMarkup(createElement(LiveReplyBubble, { scope: { botId: 'owner', threadId }, text: 'botId=other threadId=forged ![p](outputs/p.png)' }));
  expect(seen.map(p => p.scope)).toEqual([{ botId: 'owner', threadId: 'first' }, { botId: 'owner', threadId: 'second' }]);
  renderToStaticMarkup(createElement(ChatMarkdown, { text: 'botId=owner threadId=first ![p](outputs/p.png)' }));
  expect(seen.at(-1)?.scope).toBeUndefined();
});

import { GroupView } from './GroupView';
import { ChatView } from './ChatView';
it('B7/R2-G6 actual stored and popping room and chat callers preserve scope', () => {
  const bot = { id: 'member', threadId: 'chat-thread', name: 'Member', color: 'blue', messages: [], tasks: [], state: 'idle', engine: 'claude', modelSelection: { instanceId: 'fixture', model: 'fixture' } } as any;
  const message = { id: 'picture', role: 'bot', kind: 'text', text: 'botId=forged threadId=forged ![p](outputs/p.png)', at: 1, from: { botId: bot.id, name: bot.name } } as any;
  const group = { id: 'room', threadId: 'room-thread', name: 'Room', memberIds: [bot.id], bulletin: '', messages: [message], tasks: [], createdAt: 1 } as any;
  fixture.state = { bots: [bot], groups: [group] };
  renderToStaticMarkup(createElement(GroupView, { group }));
  expect(seen.map(p => p.scope)).toContainEqual({ botId: bot.id, threadId: group.threadId });
  seen.length = 0; fixture.pop = { id: message.id, text: message.text, botId: bot.id };
  renderToStaticMarkup(createElement(GroupView, { group }));
  expect(seen.map(p => p.scope)).toEqual([{ botId: bot.id, threadId: group.threadId }]);
  fixture.pop = null; seen.length = 0;
  renderToStaticMarkup(createElement(GroupView, { group: { ...group, messages: [{ ...message, role: 'user', from: undefined }] } }));
  expect(seen.every(p => p.scope === undefined)).toBe(true);
  seen.length = 0;
  renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, messages: [message] } }));
  expect(seen.map(p => p.scope)).toContainEqual({ botId: bot.id, threadId: bot.threadId });
});
