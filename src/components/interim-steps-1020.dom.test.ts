// @vitest-environment jsdom
// 1020 double answer. One turn: the bot says something ("...about 560,000 to 580,000. Let me verify the latest
// figure."), runs a web search, then answers ("...588,000 (ONS mid-2025)"). The recorded event order of that turn
// (Fuigo via Flux Auto, owner chat, No limits) is item.completed assistant_text 4-0 -> item.started tool web_search 4-1
// -> item.completed tool 4-1 ok -> item.completed assistant_text 4-2 -> turn.completed. With the step out of sight
// (Tool calls off, the default) the two texts rendered back to back as two separate answers. The step must stay named
// between them, for every engine, in a direct chat and a room, and no text may be hidden.
import { createElement as h } from 'react';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, installDOMHarness, mount, settle } from '../testing/dom-harness';
import { MessagesList } from './ChatView';
import { Transcript } from './GroupView';
import type { Message } from '@/state/store';

const fixture = vi.hoisted(() => ({ state: { config: { features: { showToolCalls: false } }, showToolCalls: false, instances: [{ instanceId: 'fixture', driverKind: 'fuigoAgent' }], bots: [], focusMessage: null } as any, dispatch: vi.fn() }));
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
const from = { botId: 'bot', name: 'Nova' } as Message['from'];
const INTERIM = 'About 560,000 to 580,000 people. Let me verify the latest figure.';
const ANSWER = 'About 588,000 people (mid-2025 estimate).';

// The recorded turn, field for field from the event log (texts were not logged; the fixture words stand in).
type Ev = { type: 'item.completed' | 'item.started'; itemId: string; itemType: 'assistant_text' | 'tool'; at: number; title?: string; ok?: boolean; text?: string };
const RECORDED: Ev[] = [
  { type: 'item.completed', itemId: '4-0', itemType: 'assistant_text', at: Date.parse('2026-11-18T17:22:10.516Z'), text: INTERIM },
  { type: 'item.started', itemId: '4-1', itemType: 'tool', at: Date.parse('2026-11-18T17:22:10.546Z'), title: 'web_search' },
  { type: 'item.completed', itemId: '4-1', itemType: 'tool', at: Date.parse('2026-11-18T17:22:14.425Z'), ok: true },
  { type: 'item.completed', itemId: '4-2', itemType: 'assistant_text', at: Date.parse('2026-11-18T17:22:23.437Z'), text: ANSWER },
];

/** The rows the server writes for those events (server/index.ts runtime fold): one text row per assistant_text item,
 * one activity row per engine tool start that its completion settles, every bot row stamped with the turn; the
 * turn's end marks the closing reply. `tool` swaps in the name each engine gives its web search. */
function project(events: Ev[], { tool = 'web_search', settled = true }: { tool?: string; settled?: boolean } = {}): Message[] {
  const rows: Message[] = [];
  const byItem = new Map<string, Message>();
  for (const event of events) {
    if (event.itemType === 'assistant_text') rows.push({ id: `row-${event.itemId}`, at: event.at, role: 'bot', kind: 'text', text: event.text, turnId: 'turn-4', from });
    else if (event.type === 'item.started') {
      const row: Message = { id: `row-${event.itemId}`, at: event.at, role: 'bot', kind: 'activity', turnId: 'turn-4', from, tool: { name: tool === 'web_search' ? event.title! : tool } };
      byItem.set(event.itemId, row); rows.push(row);
    } else byItem.get(event.itemId)!.tool!.ok = event.ok;
  }
  const last = rows.at(-1)!;
  if (settled && last.kind === 'text') last.turnTerminal = true;
  return rows;
}

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(async () => { cleanup(); await settle(); document.body.replaceChildren(); });

async function render(messages: Message[], { room = false, show = false } = {}) {
  fixture.state.showToolCalls = show; fixture.state.config = { features: { showToolCalls: show } };
  const common: any = { messages, transcript: messages, onReply: vi.fn(), scrollRef: { current: null }, followRef: { current: false }, follow: false };
  const app = mount(room ? h(Transcript, { ...common, group: { id: 'room', threadId: 'thread' }, members: [bot] }) : h(MessagesList, { ...common, bot, editingId: null, editDrafts: {}, canRetryLast: false }));
  await settle();
  return app;
}

/** Document order of the two texts and the step row: [interim text, step row, answer] means one reply. */
function order(): string[] {
  const body = document.body.textContent ?? '';
  const marks = [...document.querySelectorAll('[data-testid="interim-steps-row"]')];
  const out: Array<[number, string]> = [];
  for (const [label, words] of [['interim', INTERIM], ['answer', ANSWER]] as const) if (body.includes(words)) out.push([body.indexOf(words), label]);
  for (const mark of marks) out.push([body.indexOf(mark.textContent ?? '\u0000', out.find(([, l]) => l === 'interim')?.[0] ?? 0), `step:${mark.textContent}`]);
  return out.sort((a, b) => a[0] - b[0]).map(([, label]) => label);
}

// Fuigo/ACP and Codex call it web_search; Claude's CLI calls it WebSearch; an MCP mount prefixes it.
it.each([
  ['Fuigo/ACP', 'web_search'],
  ['Codex', 'web_search'],
  ['Claude', 'WebSearch'],
  ['MCP mount', 'mcp__murage__web_search'],
])('W1 %s: interim text, a web search and the answer read as ONE reply with the step between (Tool calls off)', async (_engine, tool) => {
  for (const room of [false, true]) {
    const app = await render(project(RECORDED, { tool }), { room });
    const where = JSON.stringify({ room, body: document.body.innerHTML.slice(0, 4000) });
    // no assistant text is hidden
    expect(document.body.textContent, where).toContain(INTERIM);
    expect(document.body.textContent, where).toContain(ANSWER);
    const steps = document.querySelectorAll('[data-testid="interim-steps-row"]');
    expect(steps, where).toHaveLength(1);
    expect(steps[0].textContent).toBe('searched the web');
    expect(order(), where).toEqual(['interim', 'step:searched the web', 'answer']);
    app.unmount();
  }
});

it('W2 live turn (not settled yet): the step is named as soon as the answer text arrives', async () => {
  for (const room of [false, true]) {
    const app = await render(project(RECORDED, { settled: false }), { room });
    expect(order()).toEqual(['interim', 'step:searched the web', 'answer']);
    app.unmount();
  }
});

it('W3 Tool calls on: the settled turn keeps its one "Worked for" row between the texts, never a second step line', async () => {
  const app = await render(project(RECORDED), { show: true });
  const body = document.body.textContent ?? '';
  expect(document.querySelectorAll('[data-testid="interim-steps-row"]')).toHaveLength(0);
  const worked = body.search(/Worked/);
  expect(worked).toBeGreaterThan(body.indexOf(INTERIM));
  expect(worked).toBeLessThan(body.indexOf(ANSWER));
  app.unmount();
});

it('W4 Tool calls on, two stretches: the fold stands at the first, the second stretch is still named before the last text', async () => {
  const LATER = 'Checked a second source too.';
  const rows = project(RECORDED, { settled: false });
  rows.push({ id: 'row-4-3', at: rows.at(-1)!.at + 1, role: 'bot', kind: 'activity', turnId: 'turn-4', from, tool: { name: 'WebFetch', ok: true } });
  rows.push({ id: 'row-4-4', at: rows.at(-1)!.at + 1, role: 'bot', kind: 'text', text: LATER, turnId: 'turn-4', from, turnTerminal: true });
  const app = await render(rows, { show: true });
  const steps = [...document.querySelectorAll('[data-testid="interim-steps-row"]')];
  expect(steps.map(step => step.textContent)).toEqual(['opened web pages']);
  const body = document.body.textContent ?? '';
  expect(body.indexOf(steps[0].textContent!, body.indexOf(ANSWER))).toBeLessThan(body.indexOf(LATER));
  app.unmount();
});

it('W5 a turn with no interim text (a step, then the answer) gains no step row: nothing changes there', async () => {
  for (const room of [false, true]) {
    const app = await render(project(RECORDED.slice(1)), { room });
    expect(document.body.textContent).toContain(ANSWER);
    expect(document.querySelectorAll('[data-testid="interim-steps-row"]')).toHaveLength(0);
    app.unmount();
  }
});

it('W6 two different turns are never joined: an answer, then the next turn\'s step and text, gain no step row', async () => {
  const rows = project(RECORDED.slice(0, 1));
  rows[0].turnTerminal = true;
  const next = project(RECORDED.slice(1)).map(row => ({ ...row, id: `${row.id}-next`, turnId: 'turn-5' }));
  const app = await render([...rows, ...next]);
  expect(document.querySelectorAll('[data-testid="interim-steps-row"]')).toHaveLength(0);
  expect(document.body.textContent).toContain(INTERIM);
  expect(document.body.textContent).toContain(ANSWER);
  app.unmount();
});
