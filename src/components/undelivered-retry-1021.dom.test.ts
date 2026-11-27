// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// 1021 Retry (RETRY-DESIGN-r2, WHAT THE OWNER SEES): a card whose answer did not reach a bot that is still waiting stays in the
// waiting list and offers Send again, and only that (no Allow/Deny: the stored answer is re-sent, nothing is approved anew).
// Send again posts to the retry route with no body; each server outcome shows its own line. The real PendingApprovalActions
// and pending-approval predicate run; api() is the only fake and fails the way it does (an Error with status and JSON body).
import { act, createElement as h } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, installDOMHarness, mount, settle } from '../testing/dom-harness';
import type { Message } from '../state/store';

const fixture = vi.hoisted(() => ({ calls: [] as Array<[string, RequestInit | undefined]>, fail: undefined as undefined | Record<string, unknown> }));
vi.mock('@/lib/use-surface', () => ({ useDesktopSurface: () => true, useSurfaceState: () => ({ desktop: true, confirmed: true }) }));
vi.mock('@/lib/native-shell', () => ({ inNativeShell: () => false }));
vi.mock('../state/store', async (original) => ({
  ...(await original<typeof import('../state/store')>()),
  useStoreIfAny: () => undefined,
  useStore: () => ({ dispatch: () => { throw new Error('a Send again card never dispatches an Allow or Deny'); } }),
  api: async (path: string, init?: RequestInit) => {
    fixture.calls.push([path, init]);
    if (fixture.fail) throw Object.assign(new Error(String(fixture.fail.error)), { status: fixture.fail.status ?? 503, body: fixture.fail });
    return { ok: true, outcome: 'accepted' };
  },
}));
const { PendingApprovalActions, pendingOf } = await import('./PendingApproval');
const { isPendingApprovalMessage } = await import('../lib/pending-approval');
const { loadPlainApproval } = await import('../lib/plain-approval');

let restore: () => void;
beforeAll(async () => { restore = installDOMHarness(); await loadPlainApproval(); });
afterAll(() => restore());
afterEach(async () => { cleanup(); await settle(); document.body.replaceChildren(); fixture.calls = []; fixture.fail = undefined; });
const flush = async () => { for (let i = 0; i < 10; i += 1) await settle(); };

const message = (deliveryRetry?: 'offered' | 'sending', answered = 'Allowed') => ({ id: 'm1', role: 'bot', kind: 'options', at: 1, text: '', from: { botId: 'b1', name: 'Sable' },
  card: { requestId: 'r1', tool: 'Bash', title: 'Approval', subtitle: 'ls', options: ['Allow', 'Deny'], answered, dismissed: true, ...(deliveryRetry ? { deliveryRetry } : {}) } } as unknown as Message);
const BOT = { id: 'b1', name: 'Sable', autoApprove: false, threadId: 't1' } as never;
const card = (m: Message) => h(PendingApprovalActions, { pending: pendingOf(m), threadId: 't1', bot: BOT, onCancelTurn: () => undefined });
const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Approval"] button'));
const status = () => document.querySelector('[role="group"][aria-label="Approval"] [role="status"]')?.textContent;
const sendAgain = async () => { const b = buttons().find((x) => x.textContent === 'Send again'); expect(b, JSON.stringify(buttons().map((x) => x.textContent))).toBeTruthy(); await act(async () => { b!.click(); }); await flush(); };

describe('1021 Retry: Send again on a card whose answer did not reach the bot', () => {
  it('a card offering Send again is still waiting; an answered card without it is not', () => {
    expect(isPendingApprovalMessage(message('offered'))).toBe(true);
    expect(isPendingApprovalMessage(message('sending'))).toBe(true);
    expect(isPendingApprovalMessage(message(undefined))).toBe(false);
  });

  it('offered: the honest line and Send again only; pressing it posts the retry with no body, and an accepted retry shows no error', async () => {
    mount(card(message('offered'))); await flush();
    expect(status()).toBe('Your answer (Allow) did not reach the bot. Nothing was run. The bot is still waiting.');
    expect(buttons().map((b) => b.textContent)).toEqual(['Send again']);
    await sendAgain();
    expect(fixture.calls).toEqual([['/api/threads/t1/requests/r1/retry-delivery', { method: 'POST' }]]);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('a Deny that did not arrive says Deny', async () => {
    mount(card(message('offered', 'Denied'))); await flush();
    expect(status()).toBe('Your answer (Deny) did not reach the bot. Nothing was run. The bot is still waiting.');
  });

  it('sending: the button is held as Sending...', async () => {
    mount(card(message('sending'))); await flush();
    expect(buttons().map((b) => [b.textContent, b.disabled])).toEqual([['Sending...', true]]);
  });

  it('terminal: the plain line and no button', async () => {
    fixture.fail = { ok: false, code: 'delivery_failed_terminal', error: 'The tool permission could not be delivered. Nothing was confirmed.' };
    mount(card(message('offered'))); await flush();
    await sendAgain();
    expect(document.querySelector('[data-approval-closed] [role="status"]')?.textContent).toBe('The tool permission could not be delivered. Nothing was confirmed.');
    expect(buttons()).toEqual([]);
  });

  it('pending elsewhere: says the earlier answer is still being delivered, keeps Send again', async () => {
    fixture.fail = { ok: false, status: 409, code: 'delivery_pending', error: 'Your earlier answer is still being delivered.' };
    mount(card(message('offered'))); await flush();
    await sendAgain();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Your earlier answer is still being delivered.');
    expect(buttons().map((b) => b.textContent)).toEqual(['Send again']);
  });
});
