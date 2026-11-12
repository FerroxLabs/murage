// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/state/store', () => ({ api: vi.fn() }));
const path = './HighLevelReviewValues.tsx';
const mod = existsSync(new URL(path, import.meta.url)) ? await import(path) : {};
const required = () => { expect(typeof mod.highlevelAllowDigest).toBe('function'); return mod; };
it('R3 a rendered password-completion review never enables generic Allow', () => {
  const m = required();
  expect(m.highlevelAllowDigest({ phase: 'loaded', text: '{}', reviewDigest: 'digest', rendered: true,
    operation: 'users.create', completionKind: 'desktop_password' } as any)).toBeUndefined();
});
it('T2 both decision surfaces disable Allow for pending, failed, and 200-but-unrendered values', () => {
  const m = required();
  for (const phase of ['loading', 'failed', 'refused']) expect(m.highlevelAllowDigest({ phase })).toBeUndefined();
  expect(m.highlevelAllowDigest({ phase: 'loaded', text: 'full body', reviewDigest: 'digest', rendered: false })).toBeUndefined();
  expect(m.highlevelAllowDigest({ phase: 'loaded', text: 'full body', reviewDigest: 'digest', rendered: true })).toBe('digest');
  for (const file of ['ApprovalCard.tsx', 'PendingApproval.tsx']) expect(readFileSync(new URL(file, import.meta.url), 'utf8')).toContain('<HighLevelReviewValues');
});
it('review.forgetsSettledValues and ignores a late GET after settlement', async () => {
  const m = required(); const { api } = await import('@/state/store');
  m.forgetHighLevelReview();
  let finish!: (body: unknown) => void;
  vi.mocked(api).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  m.loadHighLevelReview('hla_late');
  m.forgetHighLevelReview('hla_late');
  finish({ values: { body: 'secret sentinel' }, reviewDigest: 'digest' });
  await Promise.resolve(); await Promise.resolve();
  expect(m.highLevelReviewState('hla_late').phase).toBe('loading');
  m.setHighLevelReviewState('hla_settled', { phase: 'loaded', text: 'secret sentinel', reviewDigest: 'digest', rendered: true });
  m.forgetHighLevelReview('hla_settled');
  expect(m.highlevelAllowDigest(m.highLevelReviewState('hla_settled'))).toBeUndefined();
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
let mountedRoot: Root | undefined;
afterEach(async () => { if (mountedRoot) await act(async () => mountedRoot!.unmount()); mountedRoot = undefined; if (mod.forgetHighLevelReview) mod.forgetHighLevelReview(); });
it('T6 renders full multiline message, attachment identity and invoice values; unmount forgets them', async () => {
  const m = required(); const { api } = await import('@/state/store');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const values = { body: 'line one\nline two' + 'x'.repeat(5000), attachment: { name: 'invoice.pdf', size: 817, sha256: 'ab'.repeat(32) }, lineItems: [{ amount: 1250 }], total: 1250 };
  vi.mocked(api).mockResolvedValueOnce({ values, reviewDigest: 'digest', expiresAt: Date.now() + 10000 });
  const container = document.createElement('div'); document.body.append(container); mountedRoot = createRoot(container);
  await act(async () => mountedRoot!.render(createElement(m.HighLevelReviewValues, { reviewId: 'hla_render' })));
  expect(container.querySelector('pre')?.textContent).toBe(JSON.stringify(values, null, 2));
  expect(m.highlevelAllowDigest(m.highLevelReviewState('hla_render'))).toBe('digest');
  await act(async () => mountedRoot!.unmount()); mountedRoot = undefined;
  expect(m.highLevelReviewState('hla_render').phase).toBe('loading'); container.remove();
});

it('RPC card IDs load and render values before enabling desktop Allow', async () => {
  const { toolCallActionId } = await import('../../server/highlevel/tool-call-binding.ts');
  const id = toolCallActionId({ botId: 'bot', threadId: 'thread', generation: 'turn' } as any, 'rpc-write');
  const m = required();
  expect(m.highlevelReviewId(`highlevel-${id}`)).toBe(id);
  for (const bad of [id + '0', id.slice(0, -1), 'hla_' + '-'.repeat(64), id + '/extra']) {
    expect(m.highlevelReviewId(`highlevel-${bad}`)).toBeUndefined();
  }
  const { api } = await import('@/state/store');
  vi.mocked(api).mockResolvedValueOnce({ values: { body: 'RPC reviewed values' }, reviewDigest: 'rpc-digest' });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div'); document.body.append(container); mountedRoot = createRoot(container);
  await act(async () => mountedRoot!.render(createElement(m.HighLevelReviewValues, { reviewId: m.highlevelReviewId(`highlevel-${id}`)! })));
  expect(api).toHaveBeenLastCalledWith(`/api/highlevel/reviews/${id}`, expect.anything());
  expect(container.querySelector('pre')?.textContent).toContain('RPC reviewed values');
  expect(m.highlevelAllowDigest(m.highLevelReviewState(id))).toBe('rpc-digest');
  await act(async () => mountedRoot!.unmount()); mountedRoot = undefined; container.remove();
});
it('private generation uses ordinary rendered exact approval and verified recipient wording', () => {
  const state = { phase: 'loaded', text: JSON.stringify({ firstName: 'Alex', lastName: 'Smith', locationIds: ['Fixture location'] }),
    reviewDigest: 'digest', rendered: true, operation: 'users.create', completionKind: 'private_generated_password_v1' };
  expect(mod.highlevelAllowDigest(state as any)).toBe('digest');
  expect(mod.userCreateReviewWording(state as any)).toBe('Add Alex Smith to Fixture location as a user? Alex will set a password in HighLevel before signing in.');
  expect(mod.highlevelAllowDigest({ ...state, rendered: false } as any)).toBeUndefined();
  expect(mod.highlevelAllowDigest({ ...state, completionKind: undefined } as any)).toBeUndefined();
});
