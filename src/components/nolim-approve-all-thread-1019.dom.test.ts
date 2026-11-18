// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// NOLIM-1019 Rev 3.3 (designs/NOLIM-DO-EVERYTHING-1019.md, U4/U6 as amended by V3, W, X): the chat's Approve all asks the
// server for a thread-scoped preview of the cards the chat shows (its requestIds, in windows of 200) and answers the
// cards that come back eligible. C1 outcomes (a)-(e), C2 two presses on a stable list, C3 the phone sheet, C4 a card
// past the cap, C5 recovery windows, C6 the button after a result. The real PendingApprovalQueue and the real
// ApproveAllButton are mounted; the API is the only fake, and it partitions the way the server's thread route does.
import { act, createElement as h } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, installDOMHarness, mount, settle } from '../testing/dom-harness';
import { PendingApprovalQueue } from './PendingApprovalQueue';
import type { Message } from '../state/store';

type Fate = 'eligible' | 'excluded' | 'closed';
const world = vi.hoisted(() => ({
  fate: new Map<string, string>(),
  surface: { show: true, app: 'desktop', cautionDismissed: true } as Record<string, unknown>,
  previews: [] as Array<{ thread?: { threadId: string; requestIds: string[] }; screen?: unknown }>,
  applies: [] as Array<{ batchId: string; requestIds: string[] }>,
  refuse: null as null | { status: number; body: Record<string, unknown> },
  hold: null as null | Promise<void>,
  mangle: null as null | ((response: Record<string, unknown>) => Record<string, unknown>),
  api: vi.fn(async (_path: string, _init?: { body?: string }): Promise<unknown> => ({})),
}));
vi.mock('../state/store', async (original) => ({
  ...(await original<typeof import('../state/store')>()),
  api: world.api,
  useStoreIfAny: () => undefined,
}));
vi.mock('./PendingApproval', async (original) => ({
  ...(await original<typeof import('./PendingApproval')>()),
  PendingApprovalPanel: () => null,
  PendingApprovalActions: () => null,
  useApprovalBar: () => false,
}));

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());

const CAP = 25;
const entry = (id: string) => ({ threadId: 't1', requestId: id, messageId: `msg-${id}` });
const eligibleCard = (id: string) => ({ ...entry(id), botId: 'bot1', kindLine: 'command', digest: 'd'.repeat(64), card: { tool: 'Bash' } });
/** What the server's thread route answers for the requested ids: each lands in exactly one list, oldest first. */
function partition(threadId: string, requestIds: string[]): Record<string, unknown> {
  const eligible: unknown[] = []; const later: unknown[] = []; const excluded: unknown[] = []; const closed: unknown[] = [];
  for (const id of requestIds) {
    const fate = (world.fate.get(id) ?? 'closed') as Fate;
    if (fate === 'eligible') (eligible.length < CAP ? eligible : later).push(eligible.length < CAP ? eligibleCard(id) : entry(id));
    else if (fate === 'excluded') excluded.push({ ...entry(id), summary: 'wipe', reasonKey: 'always-ask' });
    else closed.push(entry(id));
  }
  return { scope: 'thread', threadId, batchId: eligible.length ? `b${world.previews.length}` : null, eligible, later, excluded, closed };
}
beforeEach(() => {
  world.fate = new Map(); world.previews = []; world.applies = []; world.refuse = null; world.hold = null; world.mangle = null;
  world.surface = { show: true, app: 'desktop', cautionDismissed: true };
  world.api.mockReset().mockImplementation(async (path: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as Record<string, any>;
    if (path === '/api/inbox/approve-all/surface') return world.surface;
    if (path === '/api/inbox/approve-all/preview') {
      world.previews.push(body);
      if (world.hold) await world.hold;
      if (!body.thread) return { batchId: null, eligible: [], excluded: [], more: 0 };
      const response = partition(body.thread.threadId, body.thread.requestIds);
      return world.mangle ? world.mangle(response) : response;
    }
    if (path === '/api/inbox/approve-all/apply') {
      world.applies.push(body as { batchId: string; requestIds: string[] });
      if (world.refuse) throw Object.assign(new Error('refused'), world.refuse);
      for (const id of body.requestIds as string[]) world.fate.set(id, 'closed');
      return { approved: body.requestIds.length, results: (body.requestIds as string[]).map((requestId) => ({ threadId: 't1', requestId, result: 'approved' })) };
    }
    return {};
  });
});
afterEach(async () => { cleanup(); await settle(); document.body.replaceChildren(); });
const flush = async () => { for (let i = 0; i < 12; i += 1) await settle(); };
const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-approve-all]'));
const line = () => document.querySelector('[data-approve-all-line]')?.textContent ?? '';
const errorLine = () => document.querySelector('p[role="alert"]')?.textContent ?? '';
const clickFirst = async () => { await act(async () => { buttons()[0]!.click(); }); await flush(); };

/** A chat approval message; its stored id never follows its requestId (the chat key is the requestId, not the row id). */
const waiting = (id: string): Message => ({ id: `msg-${id}`, role: 'bot', kind: 'options', text: '', card: { requestId: id, tool: 'Bash', title: 'Run a command', subtitle: 'ls', options: ['Allow', 'Deny'] } } as unknown as Message);
const pendingOf = (id: string) => ({ message: waiting(id), requestId: id, tool: 'Bash', detail: 'ls' });
const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `r${from + i}`);
const queue = (requestIds: string[]) => h(PendingApprovalQueue, {
  approvals: requestIds.map(pendingOf) as never, threadId: 't1', botFor: () => undefined, whoFor: () => 'Ember', onCancelTurn: () => undefined,
});
const fate = (list: string[], value: Fate) => { for (const id of list) world.fate.set(id, value); };

describe('C1 outcomes: a press ends in exactly one of five states', () => {
  it('(a) eligible cards are applied by literal request id; the preview is the thread preview of what the chat shows', async () => {
    fate(['r1', 'r3'], 'eligible'); fate(['r2'], 'excluded');
    mount(queue(['r1', 'r2', 'r3'])); await flush();
    await clickFirst();
    expect(world.previews).toEqual([{ thread: { threadId: 't1', requestIds: ['r1', 'r2', 'r3'] } }]);
    expect(world.applies).toEqual([{ batchId: 'b1', requestIds: ['r1', 'r3'] }]);
    expect(line()).toContain('Approved 2.');
    expect(line()).toContain('1 waits for you to press Allow.');
    expect(line()).not.toContain('Press Approve all for the rest.');
  });

  it('(a) cards past the cap say to press again; the next press takes them', async () => {
    const all = ids(1, 30);
    fate(all, 'eligible');
    mount(queue(all)); await flush();
    await clickFirst();
    expect(world.applies[0]!.requestIds).toEqual(ids(1, 25));
    expect(line()).toContain('Approved 25.');
    expect(line()).toContain('Press Approve all for the rest.');
  });

  it('(c) nothing eligible and some cards excluded: "These need you to press Allow, one at a time."', async () => {
    fate(['r1', 'r2'], 'excluded'); // r3 was answered elsewhere: closed
    mount(queue(['r1', 'r2', 'r3'])); await flush();
    await clickFirst();
    expect(world.applies).toEqual([]);
    expect(line()).toBe('These need you to press Allow, one at a time.');
    expect(line()).not.toContain('Nothing left');
    expect(line()).not.toContain('The list changed');
    expect(buttons()[0]!.disabled).toBe(false);
  });

  it('(d) every requested card closed: "Nothing left to approve."', async () => {
    mount(queue(['r1', 'r2'])); await flush();
    await clickFirst();
    expect(world.applies).toEqual([]);
    expect(line()).toBe('Nothing left to approve.');
  });

  it('(e) a list that moved during the press applies nothing and shows nothing stale', async () => {
    fate(['r1', 'r2'], 'eligible');
    let release!: () => void;
    world.hold = new Promise<void>((done) => { release = done; });
    const view = mount(queue(['r1', 'r2']));
    await flush();
    await act(async () => { buttons()[0]!.click(); });
    await settle();
    view.rerender(queue(['r1', 'r2', 'r9'])); // a new card arrived while the preview loaded
    release(); await flush();
    expect(world.applies).toEqual([]);
    // the move closes the press (stepAfterListChange) and the late preview is dropped: nothing applied, nothing stale shown
    expect(line()).toBe("");
    expect(buttons()[0]!.disabled).toBe(false);
  });

  it.each([
    [409, 'batch_unknown'], [409, 'batch_used'], [409, 'bad_selection'], [403, 'fresh_auth_changed'],
  ])('(e) an apply refused with %i %s says "changed"', async (status, code) => {
    fate(['r1', 'r2'], 'eligible');
    world.refuse = { status, body: { code } };
    mount(queue(['r1', 'r2'])); await flush();
    await clickFirst();
    expect(line()).toBe('The list changed. Press Approve all again.');
  });

  it('any other refusal is an error line, never "changed" and never "Nothing left"', async () => {
    fate(['r1', 'r2'], 'eligible');
    world.refuse = { status: 500, body: { code: 'oops' } };
    mount(queue(['r1', 'r2'])); await flush();
    await clickFirst();
    expect(line()).toBe('');
    expect(errorLine()).toBe('refused');
    expect(buttons()[0]!.disabled).toBe(false);
  });

  it.each([
    ['an id in two lists', (r: Record<string, any>) => ({ ...r, closed: [...r.closed, entry('r1')] })],
    ['a requested id in none', (r: Record<string, any>) => ({ ...r, eligible: [r.eligible[0]] })],
    ['another thread', (r: Record<string, any>) => ({ ...r, threadId: 'other' })],
    ['an eligible id the chat does not show', (r: Record<string, any>) => ({ ...r, eligible: [...r.eligible, eligibleCard('r77')] })],
    ['an unrequested id in excluded', (r: Record<string, any>) => ({ ...r, excluded: [...r.excluded, entry('r88')] })],
    ['an unrequested id in closed', (r: Record<string, any>) => ({ ...r, closed: [...r.closed, entry('r89')] })],
    ['an unrequested id in later', (r: Record<string, any>) => ({ ...r, later: [...r.later, entry('r90')] })],
    ['later with nothing eligible', () => ({ scope: 'thread', threadId: 't1', batchId: null, eligible: [], later: [entry('r1')], excluded: [], closed: [entry('r2')] })],
  ])('a protocol error (%s) is the failed-preview line: nothing applied, not "changed"', async (_name, mangle) => {
    fate(['r1', 'r2'], 'eligible');
    world.mangle = mangle as never;
    mount(queue(['r1', 'r2'])); await flush();
    await clickFirst();
    expect(world.applies).toEqual([]);
    expect(errorLine()).not.toBe('');
    expect(document.body.textContent).not.toContain('The list changed');
    expect(document.body.textContent).not.toContain('Nothing left to approve.');
  });
});

describe('a preview that is not an object', () => {
  it('a null answer is the failed-preview line, nothing applied, and the button is enabled to retry', async () => {
    fate(['r1', 'r2'], 'eligible');
    world.mangle = (() => null) as never;
    mount(queue(['r1', 'r2'])); await flush();
    await clickFirst();
    expect(world.applies).toEqual([]);
    expect(errorLine()).not.toBe('');
    expect(buttons()[0]!.disabled).toBe(false);
  });
});

describe('C2 two presses on a stable list never both say "changed"', () => {
  it('a card answered elsewhere is closed in the preview, not "changed", on both presses', async () => {
    fate(['r2', 'r3'], 'eligible'); // r1 is closed
    mount(queue(['r1', 'r2', 'r3'])); await flush();
    await clickFirst();
    const first = line();
    await clickFirst();
    const second = line();
    expect(first).toContain('Approved 2.');
    expect(second).toBe('Nothing left to approve.');
    expect([first, second].filter((text) => text.includes('The list changed'))).toEqual([]);
  });

  it('30 shown eligible cards: press, press again, and neither says "changed"', async () => {
    const all = ids(1, 30);
    fate(all, 'eligible');
    mount(queue(all)); await flush();
    await clickFirst();
    const first = line();
    await clickFirst();
    const second = line();
    expect(world.applies.map((a) => a.requestIds)).toEqual([ids(1, 25), ids(26, 30)]);
    expect([first, second].some((text) => text.includes('The list changed'))).toBe(false);
  });
});

describe('C3 the phone sheet from a thread preview', () => {
  it('shows the eligible cards, says the first 25, and applies exactly the ticked ones', async () => {
    world.surface = { show: true, app: 'phone', cautionDismissed: true };
    const all = ids(1, 30);
    fate(all, 'eligible');
    mount(queue(all)); await flush();
    await clickFirst();
    const cards = Array.from(document.querySelectorAll('[data-testid="approve-all-cards"] [data-request-id]')).map((n) => n.getAttribute('data-request-id'));
    expect(cards).toEqual(ids(1, 25));
    expect(document.body.textContent).toContain('The first 25. Press Approve all again for the rest.');
    expect(world.applies).toEqual([]);
    const approve = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === 'Approve 25')!;
    await act(async () => { approve.click(); }); await flush();
    expect(world.applies).toEqual([{ batchId: 'b1', requestIds: ids(1, 25) }]);
  });
});

describe('C4 a card past the cap is never "each own"', () => {
  it('30 shown, 25 eligible and 5 later: the line asks for another press and never says each own', async () => {
    const all = ids(1, 30);
    fate(all, 'eligible');
    mount(queue(all)); await flush();
    await clickFirst();
    expect(line()).not.toContain('you to press Allow, one at a time');
    expect(line()).toContain('Press Approve all for the rest.');
  });
});

describe('C5 recovery: excluded or unshown cards never block the shown ones', () => {
  it('200 shown excluded cards then 2 eligible: the second window is previewed and the 2 are applied in one press', async () => {
    const shown = ids(1, 202);
    fate(ids(1, 200), 'excluded'); fate(['r201', 'r202'], 'eligible');
    mount(queue(shown)); await flush();
    await clickFirst();
    expect(world.previews.map((p) => p.thread!.requestIds.length)).toEqual([200, 2]);
    expect(world.applies).toEqual([{ batchId: 'b2', requestIds: ['r201', 'r202'] }]);
    expect(line()).toContain('Approved 2.');
    expect(line()).toContain('200 wait for you to press Allow.');
  });

  it('a press stops at the first window with eligible cards and says to press again for the later windows', async () => {
    const shown = ids(1, 450);
    fate(['r5'], 'eligible'); fate(['r300'], 'eligible');
    mount(queue(shown)); await flush();
    await clickFirst();
    expect(world.previews.map((p) => p.thread!.requestIds.length)).toEqual([200]);
    expect(world.applies).toEqual([{ batchId: 'b1', requestIds: ['r5'] }]);
    expect(line()).toContain('Press Approve all for the rest.');
  });

  it('every window excluded or closed: each own when any is excluded, nothing left only when all are closed', async () => {
    fate(['r250'], 'excluded');
    mount(queue(ids(1, 300))); await flush();
    await clickFirst();
    expect(world.previews.map((p) => p.thread!.requestIds.length)).toEqual([200, 100]);
    expect(world.applies).toEqual([]);
    expect(line()).toBe('These need you to press Allow, one at a time.');
  });

  it('cards of the thread the chat does not show are never sent: the preview asks only for the shown ids', async () => {
    // 25 eligible cards sit on a sibling branch (open, not shown); the shown ones are r101 and r102
    fate(ids(1, 25), 'eligible'); fate(['r101', 'r102'], 'eligible');
    mount(queue(['r101', 'r102'])); await flush();
    await clickFirst();
    expect(world.previews).toEqual([{ thread: { threadId: 't1', requestIds: ['r101', 'r102'] } }]);
    expect(world.applies).toEqual([{ batchId: 'b1', requestIds: ['r101', 'r102'] }]);
  });
});

describe('C6 the button after a result', () => {
  it('stays enabled in the result with two or more cards waiting, and its next press continues', async () => {
    const all = ids(1, 30);
    fate(all, 'eligible');
    mount(queue(all)); await flush();
    await clickFirst();
    expect(line()).toContain('Approved 25.');
    expect(buttons()).toHaveLength(1);
    expect(buttons()[0]!.disabled).toBe(false);
    expect(buttons()[0]!.textContent).toBe('Approve all');
  });
});
