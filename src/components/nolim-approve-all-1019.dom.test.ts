// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// NOLIM-1019 P4 (designs/NOLIM-DO-EVERYTHING-1019.md N3, R7, F5): Approve all is on screen whenever two approval cards wait
// (the chat thread, Inbox > Approvals and Needs you, which is the Inbox in door mode), absent with one, and a press answers
// only the cards the server's preview lists as eligible (an N2 wipe card, another person's card or a legacy card with no
// class is never sent). The real ApproveAllButton and the real PendingApprovalQueue, mounted; the API is the only fake.
import { act, createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, installDOMHarness, mount, settle } from '../testing/dom-harness';
import { ApproveAllButton } from './ApproveAll';
import { PendingApprovalQueue } from './PendingApprovalQueue';
import { approveAllHint } from '../lib/approve-all';
import { approveAllCounts } from '../../shared/approve-all-counts';
import { rowKey } from '../lib/approval-row';
import type { Message } from '../state/store';

const fixture = vi.hoisted(() => ({
  api: vi.fn(async (_path: string, _init?: { body?: string }): Promise<unknown> => ({})),
  preview: { batchId: 'b1', eligible: [] as unknown[], excluded: [] as unknown[], more: 0 } as Record<string, unknown>,
  surface: { show: true, app: 'desktop', cautionDismissed: true } as Record<string, unknown>,
}));
vi.mock('../state/store', async (original) => ({
  ...(await original<typeof import('../state/store')>()),
  api: fixture.api,
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
const applied: Array<{ requestIds: string[] }> = [];
beforeEach(() => {
  applied.length = 0;
  fixture.preview = { batchId: 'b1', eligible: [], excluded: [], more: 0 };
  fixture.surface = { show: true, app: 'desktop', cautionDismissed: true };
  fixture.api.mockReset().mockImplementation(async (path: string, init?: { body?: string }) => {
    if (path === '/api/inbox/approve-all/surface') return fixture.surface;
    if (path === '/api/inbox/approve-all/preview') return fixture.preview;
    if (path === '/api/inbox/approve-all/apply') {
      const body = JSON.parse(init?.body ?? '{}') as { requestIds: string[] };
      applied.push(body);
      return { approved: body.requestIds.length, results: body.requestIds.map((requestId) => ({ threadId: 't1', requestId, result: 'approved' })) };
    }
    return {};
  });
});
afterEach(async () => { cleanup(); await settle(); document.body.replaceChildren(); });
const flush = async () => { for (let i = 0; i < 10; i += 1) await settle(); };
// the press is a state change: inside act, then let the preview and the apply settle
const pressOf = async (button: HTMLButtonElement) => { await act(async () => { button.click(); }); await flush(); };

const link = (n: number) => ({ threadId: 't1', messageId: `m${n}` });
const key = (n: number) => rowKey(link(n));
const eligible = (n: number) => ({ threadId: 't1', requestId: `r${n}`, messageId: `m${n}`, botId: 'bot1', kindLine: 'command', digest: 'd'.repeat(64), card: { tool: 'Bash' } });
const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-approve-all]'));
const click = pressOf;

/** A chat approval message the queue lists (kind options, a card with a tool and a request id). */
const waiting = (n: number): Message => ({ id: `m${n}`, role: 'bot', kind: 'options', text: '', card: { requestId: `r${n}`, tool: 'Bash', title: 'Run a command', subtitle: 'ls', options: ['Allow', 'Deny'] } } as unknown as Message);
const pending = (n: number) => ({ message: waiting(n), requestId: `r${n}`, tool: 'Bash', detail: 'ls' });
const queue = (count: number) => h(PendingApprovalQueue, {
  approvals: Array.from({ length: count }, (_, i) => pending(i + 1)) as never, threadId: 't1',
  botFor: () => undefined, whoFor: () => 'Ember', onCancelTurn: () => undefined,
});

describe('P4 visibility: two waiting approvals show Approve all (N3)', () => {
  it('the chat thread shows it with 2 and 3 waiting cards, and not with 1', async () => {
    mount(queue(2)); await flush();
    expect(buttons().map((b) => b.textContent)).toEqual(['Approve all']);
    cleanup(); await settle();
    mount(queue(3)); await flush();
    expect(buttons()).toHaveLength(1);
    cleanup(); await settle();
    mount(queue(1)); await flush();
    expect(buttons()).toHaveLength(0);
  });

  it('Inbox > Approvals and Needs you: two held cards show it disabled with what needs a look; two ok cards show the count; one shows nothing', async () => {
    const shown = (bulk: string[]) => bulk.map((b, i) => ({ kind: 'request', bulk: b, segment: 'approval', link: link(i + 1) }));
    const props = (rows: ReturnType<typeof shown>) => ({
      ready: rows.filter((r) => r.bulk === 'ok').map((r) => rowKey(r.link)), listed: rows.map((r) => rowKey(r.link)),
      counts: approveAllCounts(rows), refreshes: 0, onApplied: () => undefined, onChanged: () => undefined,
    });
    // the 11-06 gate counted only `bulk: ok` rows: two held cards hid the button
    mount(h(ApproveAllButton, props(shown(['held', 'held'])))); await flush();
    expect(buttons().map((b) => [b.textContent, b.disabled])).toEqual([['2 need a look', true]]);
    cleanup(); await settle();
    mount(h(ApproveAllButton, props(shown(['ok', 'ok'])))); await flush();
    expect(buttons().map((b) => [b.textContent, b.disabled])).toEqual([['Approve all 2', false]]);
    cleanup(); await settle();
    mount(h(ApproveAllButton, props(shown(['ok', 'always-ask', 'held'])))); await flush();
    expect(buttons().map((b) => [b.textContent, b.disabled])).toEqual([['Approve 1 · 2 need a look', false]]);
    cleanup(); await settle();
    mount(h(ApproveAllButton, props(shown(['ok'])))); await flush();
    expect(buttons()).toHaveLength(0);
  });

  it('both Inbox views that carry approvals offer it, and Needs you is that Inbox in door mode', () => {
    const rows = [{ kind: 'request', bulk: 'held' }, { kind: 'request', bulk: 'held' }];
    expect(approveAllHint('approvals', rows)).not.toBeNull();
    expect(approveAllHint('decisions', rows)).not.toBeNull();
    expect(approveAllHint('all', rows)).toBeNull();
    const body = readFileSync('src/components/needs/NeedsYouPageBody.tsx', 'utf8');
    expect(body).toMatch(/<Inbox\s+door/);
    const inbox = readFileSync('src/components/Inbox.tsx', 'utf8');
    expect(inbox).toContain('{approveAllEligible !== null && <ApproveAllButton');
    expect(inbox).toContain('counts={approveAllDisplayed}');
  });
});

describe('P4 press: only what the preview lists as eligible is answered, in preview and in apply', () => {
  it('Inbox: the N2 card the preview excluded is never sent', async () => {
    fixture.preview = { batchId: 'b1', eligible: [eligible(1), eligible(2)], excluded: [{ threadId: 't1', requestId: 'r3', summary: 'wipe', reasonKey: 'always-ask' }], more: 0 };
    const listed = [key(1), key(2), key(3)];
    mount(h(ApproveAllButton, { ready: [key(1), key(2)], listed, counts: approveAllCounts([{ kind: 'request', bulk: 'ok' }, { kind: 'request', bulk: 'ok' }, { kind: 'request', bulk: 'always-ask' }]), refreshes: 0, onApplied: () => undefined, onChanged: () => undefined }));
    await flush();
    const [button] = buttons();
    expect(button.textContent).toBe('Approve 2 · 1 need a look');
    await click(button);
    expect(applied).toEqual([{ batchId: 'b1', requestIds: ['r1', 'r2'] }]);
  });

  it('M-stale (client): a card the screen stamped ok that the preview no longer lists as eligible means the list moved; nothing is applied', async () => {
    // r2 turned into an N2 card between the list read and the press: the preview leaves it out
    fixture.preview = { batchId: 'b1', eligible: [eligible(1)], excluded: [{ threadId: 't1', requestId: 'r2', summary: 'wipe', reasonKey: 'always-ask' }], more: 0 };
    mount(h(ApproveAllButton, { ready: [key(1), key(2)], listed: [key(1), key(2)], counts: approveAllCounts([{ kind: 'request', bulk: 'ok' }, { kind: 'request', bulk: 'ok' }]), refreshes: 0, onApplied: () => undefined, onChanged: () => undefined }));
    await flush();
    await click(buttons()[0]);
    expect(applied).toEqual([]);
    expect(document.body.textContent).toContain('The list changed. Press Approve all again.');
  });
});
