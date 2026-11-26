// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// 1021 undelivered card: when the server says an answer can never be delivered (503 `delivery_failed_terminal`), the card
// shows the plain line and no Approve/Deny at once, instead of a red line over live buttons. A retryable failure
// (`delivery_retry`) keeps the buttons with its line (Rule 83b). The real PendingApprovalActions and the real
// decideWithFreshAuth run; the store's dispatch posts through decideWithFreshAuth as the store does, and the POST is the
// only fake: it fails the way api() fails (an Error carrying the status and the server's JSON body).
import { act, createElement as h } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, installDOMHarness, mount, settle } from '../testing/dom-harness';
import { decideWithFreshAuth } from '../lib/fresh-auth';
import type { Message } from '../state/store';

const fixture = vi.hoisted(() => ({ body: {} as Record<string, unknown>, posts: 0 }));
// The owner's desktop app (a Bash Allow is the computer's alone), as approval-one-card.test.ts sets it.
vi.mock('@/lib/use-surface', () => ({ useDesktopSurface: () => true, useSurfaceState: () => ({ desktop: true, confirmed: true }) }));
vi.mock('@/lib/native-shell', () => ({ inNativeShell: () => false }));
vi.mock('../state/store', async (original) => ({
  ...(await original<typeof import('../state/store')>()),
  useStoreIfAny: () => undefined,
  useStore: () => ({
    dispatch: (action: { type: string; threadId: string; requestId: string; onError?: (message: string, code?: string) => void; onSuccess?: () => void }) => {
      if (action.type !== 'decideRequest') return;
      void decideWithFreshAuth(async () => {
        fixture.posts += 1;
        throw Object.assign(new Error(String(fixture.body.error)), { status: 503, body: fixture.body });
      }, { threadId: action.threadId, requestId: action.requestId }, { onError: action.onError, onSuccess: action.onSuccess, showError: () => {} });
    },
  }),
}));
const { PendingApprovalActions, pendingOf } = await import('./PendingApproval');
const { loadPlainApproval } = await import('../lib/plain-approval');

let restore: () => void;
beforeAll(async () => { restore = installDOMHarness(); await loadPlainApproval(); });
afterAll(() => restore());
afterEach(async () => { cleanup(); await settle(); document.body.replaceChildren(); fixture.posts = 0; });
const flush = async () => { for (let i = 0; i < 10; i += 1) await settle(); };

const message = { id: 'm1', role: 'bot', kind: 'options', at: 1, text: '', from: { botId: 'b1', name: 'Sable' },
  card: { requestId: 'r1', tool: 'Bash', title: 'Approval', subtitle: 'ls', options: ['Allow', 'Deny'] } } as unknown as Message;
const BOT = { id: 'b1', name: 'Sable', autoApprove: false, threadId: 't1' } as never;
const card = () => h(PendingApprovalActions, { pending: pendingOf(message), threadId: 't1', bot: BOT, onCancelTurn: () => undefined });
const buttonTexts = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Approval"] button')).map((b) => b.textContent ?? '');
const press = async (label: RegExp) => {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => label.test(b.textContent ?? ''));
  expect(button, `no button ${label} in ${JSON.stringify(buttonTexts())}`).toBeTruthy();
  await act(async () => { button!.click(); });
  await flush();
};

describe('1021: an undelivered answer on the card', () => {
  it('terminal: the plain line, and no Approve or Deny to press again', async () => {
    fixture.body = { ok: false, code: 'delivery_failed_terminal', error: 'The tool permission could not be delivered. Nothing was confirmed.', outcome: 'unavailable' };
    mount(card()); await flush();
    expect(buttonTexts().some((text) => /Allow|Run/.test(text)), JSON.stringify(buttonTexts())).toBe(true);
    await press(/Allow|Run/);
    expect(fixture.posts).toBe(1);
    expect(document.querySelector('[data-approval-closed] [role="status"]')?.textContent).toBe('The tool permission could not be delivered. Nothing was confirmed.');
    expect(document.querySelector('[role="alert"]'), 'the red retry line was shown').toBeNull();
    expect(buttonTexts(), 'buttons stayed under the terminal line').toEqual([]);
  });

  it('retryable: the line with the buttons kept, and a second press posts again', async () => {
    fixture.body = { ok: false, code: 'delivery_retry', error: 'That answer could not be delivered. Nothing was confirmed. Please try again.', outcome: 'unavailable' };
    mount(card()); await flush();
    await press(/Allow|Run/);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('That answer could not be delivered. Nothing was confirmed. Please try again.');
    expect(document.querySelector('[data-approval-closed]')).toBeNull();
    expect(buttonTexts().some((text) => /Allow|Run/.test(text))).toBe(true);
    await press(/Allow|Run/);
    expect(fixture.posts).toBe(2);
  });
});
