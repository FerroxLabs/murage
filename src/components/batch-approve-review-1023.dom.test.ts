// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// T12 (designs/BATCH-APPROVE-REVIEW-1023.md r2.1, GitHub #48): on the desktop a press of Approve all opens a review panel;
// only an Approve activation answers, and only the cards left ticked that are still on the list. The real
// ApproveAllButton, mounted. The API is faked ONLY at the HTTP boundary (/surface, /preview, /apply bodies shaped like
// server/approve-all-http.test.ts reads them); the panel, the selection and the state machine are the real ones.
// jsdom does not turn keys into clicks, so every keyboard activation is sent the way a browser sends it: keydown then
// click for Enter; keydown, keyup, click for Space (detail 0).
// Every `// TARGET:<id>` line is the assertion a mutant of that id must reach (receipts.tsv, machine-checked).
import { act, createElement as h, type ComponentProps } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, installDOMHarness, mount, settle } from '../testing/dom-harness';
import { ApproveAllButton, ApproveAllReminderReset } from './ApproveAll';
import { reasonLine } from '../lib/approve-all';
import { approveAllCounts } from '../../shared/approve-all-counts';
import { rowKey } from '../lib/approval-row';

interface Held<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }
const held = <T>(): Held<T> => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

const fixture = vi.hoisted(() => ({
  api: vi.fn(async (_path: string, _init?: { body?: string }): Promise<unknown> => ({})),
  preview: { batchId: 'aab-1', eligible: [] as unknown[], excluded: [] as unknown[], more: 0 } as Record<string, unknown>,
  surface: { show: true, app: 'desktop', cautionDismissed: true } as Record<string, unknown>,
  applyImpl: null as null | ((body: { requestIds: string[] }) => Promise<unknown>),
  previewImpl: null as null | (() => Promise<unknown>),
}));
vi.mock('../state/store', async (original) => ({
  ...(await original<typeof import('../state/store')>()),
  api: fixture.api,
  useStoreIfAny: () => undefined,
}));

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
const posts: Array<{ batchId: string; requestIds: string[] }> = [];
let previews = 0;
beforeEach(() => {
  posts.length = 0;
  previews = 0;
  fixture.applyImpl = null;
  fixture.previewImpl = null;
  fixture.preview = { batchId: 'aab-1', eligible: [], excluded: [], more: 0 };
  fixture.surface = { show: true, app: 'desktop', cautionDismissed: true };
  fixture.api.mockReset().mockImplementation(async (path: string, init?: { body?: string }) => {
    if (path === '/api/inbox/approve-all/surface') return fixture.surface;
    if (path === '/api/inbox/approve-all/preview') { previews += 1; return fixture.previewImpl ? fixture.previewImpl() : fixture.preview; }
    if (path === '/api/inbox/approve-all/apply') {
      const body = JSON.parse(init?.body ?? '{}') as { batchId: string; requestIds: string[] };
      posts.push(body);
      if (fixture.applyImpl) return fixture.applyImpl(body);
      return { approved: body.requestIds.length, results: body.requestIds.map((requestId) => ({ threadId: 't1', requestId, result: 'approved' })) };
    }
    return {};
  });
});
afterEach(async () => { cleanup(); await settle(); document.body.replaceChildren(); });
const flush = async () => { for (let i = 0; i < 10; i += 1) await settle(); };

const link = (n: number) => ({ threadId: 't1', messageId: `m${n}` });
const key = (n: number) => rowKey(link(n));
const card = (n: number, botId = 'bot1', kindLine = 'command', digest = 'd'.repeat(64)) => ({ threadId: 't1', requestId: `r${n}`, messageId: `m${n}`, botId, kindLine, digest, wants: `Run step ${n}`, card: { tool: 'Bash', subtitle: `step-${n}` } });
type Props = ComponentProps<typeof ApproveAllButton>;
const propsFor = (ids: number[], extra: Partial<Props> = {}): Props => ({
  ready: ids.map(key), listed: ids.map(key), counts: approveAllCounts(ids.map(() => ({ kind: 'request', bulk: 'ok' }))),
  screen: { view: 'decisions', query: '', page: 0, pageSize: 25, includeSnoozed: false }, refreshes: 0, onApplied: () => undefined, onChanged: () => undefined, ...extra,
});
const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-approve-all]'));
const panel = () => document.querySelector<HTMLElement>('[aria-labelledby="approve-all-review"]');
/** A missing element is a failed assertion (never a TypeError), so a witness over code without the panel reads RED honestly. */
const must = <T>(el: T | null | undefined, what: string): T => { expect(el, `${what} is on screen`).toBeTruthy(); return el as T; };
const heading = () => must(document.getElementById('approve-all-review'), 'the review heading');
const lines = () => Array.from(document.querySelectorAll<HTMLElement>('[data-request-id]'));
const lineIds = () => lines().map((l) => l.dataset.requestId);
const boxByIds = (ids: string) => must(document.querySelector<HTMLInputElement>(`input[data-review-box][data-ids="${ids}"]`), `the box for ${ids}`);
const maybeApprove = () => document.querySelector<HTMLButtonElement>('[data-review-approve]');
const approveButton = () => must(maybeApprove(), 'the Approve button');
const textButton = (text: string) => must(Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === text), `the ${text} button`);
const lineOf = (id: string) => must(document.querySelector<HTMLElement>(`[data-request-id="${id}"]`), `the line for ${id}`);
const press = async () => { await act(async () => { must(buttons()[0], "Approve all").click(); }); await flush(); };
/** The mouse: a real click carries detail 1. */
const mouse = async (el: HTMLElement) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })); }); await flush(); };
const keydown = (el: HTMLElement, k: string, init: KeyboardEventInit = {}) => { const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }); act(() => { el.dispatchEvent(event); }); return event; };
const keyup = (el: HTMLElement, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true, cancelable: true })); });
/** A keyboard click as a browser sends it after Enter or Space on a button (`detail` 0). */
const keyClick = async (el: HTMLElement) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 })); }); await flush(); };
const openReview = async (ids: number[], cards = ids.map((n) => card(n)), extra: Partial<Props> = {}) => {
  fixture.preview = { batchId: 'aab-1', eligible: cards, excluded: [], more: 0 };
  const view = mount(h(ApproveAllButton, propsFor(ids, extra)));
  await flush();
  await press();
  return view;
};

describe('W1 the desktop press opens the review; only an Approve activation answers', () => {
  it('opens the panel with zero /apply posts, then exactly one on Approve', async () => {
    await openReview([1, 2, 3]);
    expect(panel()).not.toBeNull(); // TARGET:W1a
    expect(posts).toHaveLength(0); // TARGET:W1b
    expect(lineIds()).toEqual(['r1', 'r2', 'r3']);
    await mouse(approveButton());
    expect(posts).toEqual([{ batchId: 'aab-1', requestIds: ['r1', 'r2', 'r3'] }]); // TARGET:W1c
  });
});

describe('W2 grouping and selection', () => {
  it('unticking a bot, a kind and one card posts exactly the rest, in preview order', async () => {
    const cards = [card(1, 'bot1', 'command'), card(2, 'bot1', 'command'), card(3, 'bot1', 'edit'), card(4, 'bot1', 'edit'), card(5, 'bot2'), card(6, 'bot2')];
    await openReview([1, 2, 3, 4, 5, 6], cards);
    await mouse(boxByIds('r5,r6'));
    await mouse(boxByIds('r3,r4'));
    await mouse(boxByIds('r1'));
    expect(approveButton().textContent).toBe('Approve 1');
    await mouse(approveButton());
    expect(posts).toEqual([{ batchId: 'aab-1', requestIds: ['r2'] }]); // TARGET:W2
  });
});

describe('W3 no key approves by default', () => {
  it('focus opens on the heading, and Enter on a heading, a bot box, a kind box and a card box does nothing', async () => {
    const cards = [card(1, 'bot1', 'command'), card(2, 'bot1', 'edit')];
    await openReview([1, 2], cards);
    expect(document.activeElement).toBe(heading()); // TARGET:W3a
    const before = approveButton().textContent;
    for (const target of [heading(), boxByIds('r1,r2'), boxByIds('r2'), boxByIds('r1')]) {
      const event = keydown(target, 'Enter');
      expect(event.defaultPrevented).toBe(true); // TARGET:W3b
    }
    await flush();
    expect(posts).toHaveLength(0);
    expect(approveButton().textContent).toBe(before);
  });
});

describe('W4 the Approve activation guard', () => {
  const focusApprove = () => { act(() => approveButton().focus()); return approveButton(); };
  it('(a) a held Enter then click: zero posts', async () => {
    await openReview([1, 2]);
    const ok = focusApprove();
    keydown(ok, 'Enter', { repeat: true });
    await keyClick(ok);
    expect(posts).toHaveLength(0); // TARGET:W4a
  });
  it('(b) Enter pressed on a card box, focus moved to Approve, click: zero posts', async () => {
    await openReview([1, 2]);
    keydown(boxByIds('r1'), 'Enter');
    const ok = focusApprove();
    await keyClick(ok);
    expect(posts).toHaveLength(0); // TARGET:W4b
  });
  it('(c) a fresh Enter on the focused Approve, then click: one post', async () => {
    await openReview([1, 2]);
    const ok = focusApprove();
    keydown(ok, 'Enter');
    await keyClick(ok);
    expect(posts).toHaveLength(1); // TARGET:W4c
  });
  it('(d) Space toggles a box, then a mouse click (detail 1) on Approve: one post', async () => {
    await openReview([1, 2]);
    const box = boxByIds('r1');
    act(() => box.focus());
    keydown(box, ' '); keyup(box, ' ');
    await mouse(box); // the click a browser sends after Space
    expect(box.checked).toBe(false);
    await mouse(approveButton());
    expect(posts).toEqual([{ batchId: 'aab-1', requestIds: ['r2'] }]); // TARGET:W4d
  });
  it('(e) a screen reader activates Approve: a detail-0 click with no keydown posts once', async () => {
    await openReview([1, 2]);
    await keyClick(approveButton());
    expect(posts).toHaveLength(1); // TARGET:W4e
  });
});

describe('W5 keyboard roving', () => {
  it('ArrowDown/j, ArrowUp/k, Home and End move focus in bot, kind, card order; Space ticks the focused box', async () => {
    const cards = [card(1, 'bot1', 'command'), card(2, 'bot1', 'edit'), card(3, 'bot2')];
    await openReview([1, 2, 3], cards);
    // screen order: bot1, kind command, r1, kind edit, r2, bot2, r3
    const order = ['r1,r2', 'r1', 'r1', 'r2', 'r2', 'r3', 'r3'];
    const boxes = Array.from(document.querySelectorAll<HTMLInputElement>('input[data-review-box]'));
    expect(boxes.map((b) => b.dataset.ids)).toEqual(order);
    act(() => boxes[0]!.focus());
    keydown(document.activeElement as HTMLElement, 'ArrowDown');
    expect(document.activeElement).toBe(boxes[1]); // TARGET:W5a
    keydown(document.activeElement as HTMLElement, 'j');
    expect(document.activeElement).toBe(boxes[2]);
    keydown(document.activeElement as HTMLElement, 'ArrowUp');
    expect(document.activeElement).toBe(boxes[1]);
    keydown(document.activeElement as HTMLElement, 'k');
    expect(document.activeElement).toBe(boxes[0]);
    keydown(document.activeElement as HTMLElement, 'End');
    expect(document.activeElement).toBe(boxes[boxes.length - 1]);
    keydown(document.activeElement as HTMLElement, 'Home');
    expect(document.activeElement).toBe(boxes[0]);
    // Space on the last card box (keydown, keyup, then the click a browser sends)
    const last = boxes[boxes.length - 1]!;
    act(() => last.focus());
    keydown(last, ' '); keyup(last, ' ');
    await mouse(last);
    expect(approveButton().textContent).toBe('Approve 2');
  });
});

describe('W6 the cap and the screen bind the review', () => {
  it('25 on-screen rows and a 26-card preview body: 25 lines, select-all posts the 25 shown', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => i + 1);
    const cards = [...ids.map((n) => card(n)), card(26)];
    await openReview(ids, cards);
    expect(lines()).toHaveLength(25); // TARGET:W6a
    await mouse(approveButton());
    expect(posts).toHaveLength(1);
    expect(posts[0]!.requestIds).toEqual(ids.map((n) => `r${n}`)); // TARGET:W6b
  });
});

describe('W19 a passive row removal never strands keyboard users', () => {
  const liveBoxes = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[data-review-box]')).filter((b) => !b.disabled);
  it('the first row (and its bot box) leaves while the tab stop sat there: a live box becomes the tab stop', async () => {
    const view = await openReview([1, 2, 3], [card(1, 'bot1'), card(2, 'bot2'), card(3, 'bot3')]);
    view.rerender(h(ApproveAllButton, propsFor([2, 3])));
    await flush();
    expect(boxByIds('r1').disabled).toBe(true);
    expect(liveBoxes().filter((b) => b.tabIndex === 0)).toHaveLength(1); // TARGET:W19a
  });
  it('focus on the box whose row leaves moves to a live box in the panel', async () => {
    const view = await openReview([1, 2, 3], [card(1, 'bot1'), card(2, 'bot2'), card(3, 'bot3')]);
    const line = Array.from(document.querySelectorAll<HTMLInputElement>('li[data-request-id="r2"] input[data-review-box]'))[0]!;
    act(() => line.focus());
    view.rerender(h(ApproveAllButton, propsFor([1, 3])));
    await flush();
    expect(line.disabled).toBe(true);
    const active = document.activeElement as HTMLElement;
    expect(panel()!.contains(active) && active !== line && !(active as HTMLInputElement).disabled).toBe(true); // TARGET:W19b
  });
  it('ArrowUp skips the greyed row and lands on the previous live box', async () => {
    const view = await openReview([1, 2, 3], [card(1, 'bot1'), card(2, 'bot2'), card(3, 'bot3')]);
    view.rerender(h(ApproveAllButton, propsFor([1, 3])));
    await flush();
    const last = Array.from(document.querySelectorAll<HTMLInputElement>('input[data-review-box][data-ids="r3"]')).pop()!;
    act(() => last.focus());
    keydown(last, 'ArrowUp');
    keydown(document.activeElement as HTMLElement, 'ArrowUp');
    const at = document.activeElement as HTMLInputElement;
    expect([at.disabled, at.dataset.ids]).toEqual([false, 'r1']); // TARGET:W19c
  });
});

describe('W7 a passive move keeps the review; a manual Refresh closes it', () => {
  it('a new row arrives: panel and ticks stay, Approve posts once with the ticked ids and not the new row', async () => {
    const view = await openReview([1, 2, 3]);
    await mouse(boxByIds('r2'));
    view.rerender(h(ApproveAllButton, propsFor([1, 2, 3, 4])));
    await flush();
    expect(panel()).not.toBeNull(); // TARGET:W7a
    expect(boxByIds('r2').checked).toBe(false);
    await mouse(approveButton());
    expect(posts).toEqual([{ batchId: 'aab-1', requestIds: ['r1', 'r3'] }]); // TARGET:W7b
  });
  it('a manual Refresh closes the panel with zero posts', async () => {
    const view = await openReview([1, 2, 3]);
    view.rerender(h(ApproveAllButton, propsFor([1, 2, 3], { refreshes: 1 })));
    await flush();
    expect(panel()).toBeNull(); // TARGET:W7c
    expect(posts).toHaveLength(0);
  });
});

describe('W8 a reviewed card whose row leaves is never sent', () => {
  it('greyed, unticked and disabled; Approve posts once without it', async () => {
    const view = await openReview([1, 2, 3]);
    view.rerender(h(ApproveAllButton, propsFor([1, 3])));
    await flush();
    const gone = lineOf('r2');
    expect(gone.textContent).toContain('Not on this list now'); // TARGET:W8a
    await mouse(approveButton());
    expect(posts).toEqual([{ batchId: 'aab-1', requestIds: ['r1', 'r3'] }]); // TARGET:W8b
    expect(boxByIds('r2').checked).toBe(false); // TARGET:W8c
    expect(boxByIds('r2').disabled).toBe(true);
  });
});

describe('W9 an out-of-date review refreshes without losing its ticks', () => {
  it('409 batch_unknown keeps the panel, releases the lock, and Refresh list carries ticks by id and digest', async () => {
    const cards = [1, 2, 3, 4].map((n) => card(n));
    const view = await openReview([1, 2, 3, 4], cards);
    await mouse(boxByIds('r1'));
    fixture.applyImpl = async () => { throw Object.assign(new Error('This list changed. Press Approve all again.'), { status: 409, body: { code: 'batch_unknown' } }); };
    await mouse(approveButton());
    expect(panel()).not.toBeNull(); // TARGET:W9a
    expect(must(panel(), 'the review panel').textContent).toContain('This list is out of date. Nothing was approved.');
    expect(document.querySelector('[data-testid="approve-all-result"]')).toBeNull();
    expect(maybeApprove()).toBeNull();
    // row 4 is removed from the screen and row 5 arrives; the fresh preview lists r1 and r2 as before, r3 with a new digest, r4 and r5
    view.rerender(h(ApproveAllButton, propsFor([1, 2, 3, 5])));
    await flush();
    fixture.preview = { batchId: 'aab-2', eligible: [card(1), card(2), card(3, 'bot1', 'command', 'e'.repeat(64)), card(4), card(5)], excluded: [], more: 0 };
    await mouse(textButton('Refresh list'));
    expect(document.body.textContent).not.toContain('The list changed');
    expect(must(panel(), 'the review panel').textContent).not.toContain('out of date');
    expect(lineIds()).toEqual(['r1', 'r2', 'r3', 'r5']); // TARGET:W9b
    expect(boxByIds('r1').checked).toBe(false);
    expect(boxByIds('r2').checked).toBe(true);
    expect(boxByIds('r3').checked).toBe(false); // TARGET:W9c
    expect(boxByIds('r5').checked).toBe(false);
    expect(lineOf('r3').textContent).toContain('New');
    expect(lineOf('r5').textContent).toContain('New');
    expect(lineOf('r2').textContent).not.toContain('New');
    // the lock was released: the refreshed review applies once, with the batch it holds
    fixture.applyImpl = null;
    await mouse(boxByIds('r5'));
    await mouse(approveButton());
    expect(posts.at(-1)).toEqual({ batchId: 'aab-2', requestIds: ['r2', 'r5'] });
  });
});

describe('W10 per-card results', () => {
  it('one plain line per card for every reason, kept when a new row arrives, focus on the result heading', async () => {
    const ids = [1, 2, 3, 4, 5, 6, 7];
    const view = await openReview(ids);
    fixture.applyImpl = async (body) => {
      const by: Record<string, { result: string; reason?: string }> = {
        r1: { result: 'approved' }, r2: { result: 'skipped', reason: 'not-open' }, r3: { result: 'skipped', reason: 'fresh_auth_changed' },
        r4: { result: 'skipped', reason: 'fresh_auth_gone' }, r5: { result: 'skipped', reason: 'not-eligible:needs-look' },
        r6: { result: 'not-applied', reason: 'batch-changed' }, r7: { result: 'skipped', reason: 'in_flight' },
      };
      return { approved: 1, results: body.requestIds.map((requestId) => ({ threadId: 't1', requestId, ...by[requestId]! })) };
    };
    act(() => approveButton().focus());
    await mouse(approveButton());
    const line = (id: string) => document.querySelector(`[data-request-id="${id}"] [data-testid="approve-all-result"]`)?.textContent;
    expect(line('r1')).toBe('Approved'); // TARGET:W10a
    expect(line('r2')).toBe('Stopped waiting');
    expect(line('r3')).toBe('Changed since you reviewed it. Still waiting.');
    expect(line('r4')).toBe('Stopped waiting');
    expect(line('r5')).toBe(`Still waiting: ${reasonLine('needs-look')}`);
    expect(line('r6')).toBe('Not approved: Approve all stopped at a card that changed');
    expect(line('r7')).toBe('Still waiting');
    expect(document.querySelector('[data-approve-all-line]')).not.toBeNull();
    expect(document.activeElement).toBe(heading()); // TARGET:W10c
    // a passive poll adds a row: the per-card list is still shown
    view.rerender(h(ApproveAllButton, propsFor([...ids, 8])));
    await flush();
    expect(line('r1')).toBe('Approved'); // TARGET:W10b
  });
});

describe('W11 an apply with no answer is never re-posted', () => {
  it('one post, the unconfirmed line, the list re-read; the line stays when approved rows leave', async () => {
    const onApplied = vi.fn();
    const view = await openReview([1, 2, 3], undefined, { onApplied });
    fixture.applyImpl = async () => { throw new TypeError('Failed to fetch'); };
    await mouse(approveButton());
    expect(posts).toHaveLength(1); // TARGET:W11a
    expect(document.body.textContent).toContain('Murage could not confirm the result. Approved cards leave the list.'); // TARGET:W11b
    expect(onApplied).toHaveBeenCalledTimes(1);
    view.rerender(h(ApproveAllButton, propsFor([3], { onApplied })));
    await flush();
    expect(document.body.textContent).toContain('Murage could not confirm the result.'); // TARGET:W11c
    expect(posts).toHaveLength(1);
  });
  it('another 4xx settles an error line and closes the panel (Opus L1)', async () => {
    await openReview([1, 2]);
    fixture.applyImpl = async () => { throw Object.assign(new Error('That was not on the list.'), { status: 409, body: { code: 'bad_selection' } }); };
    await mouse(approveButton());
    expect(panel()).toBeNull();
    expect(must(document.querySelector('[role="alert"]'), 'the error line').textContent).toBe('That was not on the list.'); // TARGET:W11d
  });
});

describe('W12 the phone keeps its caution and sheet', () => {
  it('a phone press shows the existing caution, then the sheet, never the review panel', async () => {
    fixture.surface = { show: true, app: 'phone', cautionDismissed: false };
    fixture.preview = { batchId: 'aab-1', eligible: [card(1), card(2)], excluded: [], more: 0 };
    mount(h(ApproveAllButton, propsFor([1, 2])));
    await flush();
    await press();
    expect(document.getElementById('approve-all-caution')).not.toBeNull();
    await mouse(textButton('Got it'));
    expect(panel()).toBeNull(); // TARGET:W12
    expect(document.getElementById('approve-all-sheet')).not.toBeNull();
  });
});

describe('W13 two Approve activations in one tick post once', () => {
  it('a double activation inside one act is one /apply post', async () => {
    await openReview([1, 2]);
    const ok = approveButton();
    await act(async () => {
      ok.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
      ok.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    });
    await flush();
    expect(posts).toHaveLength(1); // TARGET:W13
  });
});

describe('W14 Cancel and Escape never lose or revive a review', () => {
  it('(a) Cancel during refreshing: the refresh landing does not reopen, nothing posts, and Approve all works again', async () => {
    await openReview([1, 2]);
    fixture.applyImpl = async () => { throw Object.assign(new Error('gone'), { status: 409, body: { code: 'batch_unknown' } }); };
    await mouse(approveButton());
    const refresh = held<unknown>();
    fixture.previewImpl = () => refresh.promise;
    await mouse(textButton('Refresh list'));
    expect(must(panel(), 'the review panel').textContent).toContain('Refreshing the list');
    await mouse(textButton('Cancel'));
    expect(panel()).toBeNull();
    await act(async () => { refresh.resolve({ batchId: 'aab-3', eligible: [card(1), card(2)], excluded: [], more: 0 }); });
    await flush();
    expect(panel()).toBeNull(); // TARGET:W14a
    expect(posts).toHaveLength(1);
  });
  it('(a2) Cancel during refreshing releases the preview gate at once: Approve all opens a review before the stale refresh lands, and the stale landing changes nothing', async () => {
    await openReview([1, 2]);
    fixture.applyImpl = async () => { throw Object.assign(new Error('gone'), { status: 409, body: { code: 'batch_unknown' } }); };
    await mouse(approveButton());
    const refresh = held<unknown>();
    fixture.previewImpl = () => refresh.promise;
    await mouse(textButton('Refresh list'));
    await mouse(textButton('Cancel'));
    fixture.previewImpl = null;
    fixture.applyImpl = null;
    await press();
    expect(panel()).not.toBeNull(); // TARGET:W14c
    await act(async () => { refresh.resolve({ batchId: 'aab-3', eligible: [card(1)], excluded: [], more: 0 }); });
    await flush();
    await mouse(approveButton());
    expect(posts.at(-1)).toEqual({ batchId: 'aab-1', requestIds: ['r1', 'r2'] });
  });
  it('(b) while applying Cancel is disabled and Escape is prevented and ignored; the per-card result renders when the apply lands', async () => {
    await openReview([1, 2]);
    const apply = held<unknown>();
    act(() => approveButton().focus());
    fixture.applyImpl = () => apply.promise;
    await mouse(approveButton());
    expect(textButton('Cancel').disabled).toBe(true);
    // the Approve button is disabled now. A browser sends no key events to a disabled control (they go to the page, where
    // the Inbox dialog's own Escape would close the whole Inbox), so focus must have moved to something that can take them.
    const focused = document.activeElement as HTMLElement;
    const escape = keydown(focused instanceof HTMLButtonElement && focused.disabled ? document.body : focused, 'Escape');
    expect(escape.defaultPrevented).toBe(true); // TARGET:W14b1
    await flush();
    expect(panel()).not.toBeNull(); // TARGET:W14b2
    await act(async () => { apply.resolve({ approved: 2, results: [{ threadId: 't1', requestId: 'r1', result: 'approved' }, { threadId: 't1', requestId: 'r2', result: 'approved' }] }); });
    await flush();
    expect(document.querySelectorAll('[data-testid="approve-all-result"]')).toHaveLength(2);
  });
});

describe('W15 a change of the screen closes the review', () => {
  it('a page change closes it with zero posts; the same screen as a new object does not', async () => {
    const view = await openReview([1, 2]);
    view.rerender(h(ApproveAllButton, propsFor([1, 2], { screen: { view: 'decisions', query: '', page: 0, pageSize: 25, includeSnoozed: false } })));
    await flush();
    expect(panel()).not.toBeNull(); // TARGET:W15b by value
    view.rerender(h(ApproveAllButton, propsFor([1, 2], { screen: { view: 'decisions', query: '', page: 1, pageSize: 25, includeSnoozed: false } })));
    await flush();
    expect(panel()).toBeNull(); // TARGET:W15
    expect(posts).toHaveLength(0);
  });
});

describe('W16 the desktop caution is folded into the panel; the reminder reset stays', () => {
  it('no separate caution step on the desktop, the caution body is the panel footer', async () => {
    fixture.surface = { show: true, app: 'desktop', cautionDismissed: false };
    await openReview([1, 2]);
    expect(document.getElementById('approve-all-caution')).toBeNull(); // TARGET:W16a
    expect(must(panel(), 'the review panel').textContent).toContain('Approve all gives each listed step the same Approve you would press on its row.');
  });
  it('Settings > Approvals still offers the reminder reset on the desktop once the caution was hidden', async () => {
    fixture.surface = { show: true, app: 'desktop', cautionDismissed: true };
    mount(h(ApproveAllReminderReset));
    await flush();
    expect(document.body.textContent).toContain('Show the Approve all reminder again'); // TARGET:W16b
  });
});

describe('W17 Cancel and Escape in review', () => {
  it('Cancel and Escape close with zero posts and hand focus back to Approve all', async () => {
    await openReview([1, 2]);
    await mouse(textButton('Cancel'));
    expect(panel()).toBeNull();
    expect(posts).toHaveLength(0);
    expect(document.activeElement).toBe(buttons()[0]); // TARGET:W17a
    await press();
    expect(panel()).not.toBeNull();
    const escape = keydown(heading(), 'Escape');
    await flush();
    expect(escape.defaultPrevented).toBe(true);
    expect(panel()).toBeNull(); // TARGET:W17b
    expect(posts).toHaveLength(0);
    expect(document.activeElement).toBe(buttons()[0]);
  });
});

describe('W18 the kind row and the mixed state', () => {
  it('a bot with one kind has no kind row; two kinds show one; a half-ticked group is indeterminate', async () => {
    await openReview([1, 2, 3], [card(1, 'bot1', 'command'), card(2, 'bot1', 'command'), card(3, 'bot2', 'edit')]);
    expect(Array.from(document.querySelectorAll<HTMLInputElement>('input[data-review-box]')).map((b) => b.dataset.ids)).toEqual(['r1,r2', 'r1', 'r2', 'r3', 'r3']); // TARGET:W18a
    await mouse(boxByIds('r1'));
    expect(boxByIds('r1,r2').indeterminate).toBe(true); // TARGET:W18b
    expect(boxByIds('r1,r2').checked).toBe(false);
  });
});
