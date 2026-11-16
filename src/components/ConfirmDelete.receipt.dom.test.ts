// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// R31 r3.2 (1.0.19): the kept-inbox receipt after a single bot delete (the deletion note banner), never after a bulk one.
import { act, createElement as h } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, installDOMHarness, mount, settle } from '../testing/dom-harness';
import { ConfirmDelete } from './ConfirmDelete';
import { StoreProvider, useStore } from '../state/store';
import { DeletionNoteBanner } from './DeletionNoteBanner';
import { chatDeletionNote } from '../lib/deletion-notes';

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(async () => { cleanup(); await settle(); document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const json = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } }));
let deleteBodies: Array<string | undefined>;
function stub(preview: () => Promise<Response>, deleted: unknown) {
  deleteBodies = [];
  vi.stubGlobal('fetch', ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/deletion-preview')) return preview();
    if (url.includes('/api/bots/b1') && init?.method === 'DELETE') { deleteBodies.push(init.body as string | undefined); return json(deleted); }
    return json({});
  }) as typeof fetch);
}
// The production banner, as ChatView and GroupView place it (never a substitute list).
function Note() { const { state } = useStore(); const n = chatDeletionNote(state.deletionNote); return h('div', { id: 'note' }, n ? h(DeletionNoteBanner, { note: n, onDismiss: () => {} }) : null); }
function Single() { const { dispatch } = useStore(); return h(ConfirmDelete, { name: 'Ada', kind: 'bot', detail: 'x', preview: { botId: 'b1' }, onCancel: vi.fn(), onConfirm: (options?: { emailConfirm: string }) => dispatch({ type: 'deleteBot', source: 'local', botId: 'b1', attempt: 'a1', ...(options?.emailConfirm !== undefined ? { emailConfirm: options.emailConfirm } : {}) } as never) }); }
function Bulk() { const { dispatch } = useStore(); return h('button', { id: 'bulk', onClick: () => dispatch({ type: 'deleteBot', source: 'local', botId: 'b1', attempt: 'a1', archived: true, bulk: true } as never) }, 'go'); }
const typeName = (name: string) => {
  const input = document.querySelector('input') as HTMLInputElement;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => { set.call(input, name); input.dispatchEvent(new Event('input', { bubbles: true })); });
};
const confirm = () => act(() => { ([...document.querySelectorAll('button')].find(b => b.textContent === 'Delete bot') as HTMLButtonElement).click(); });
const title = () => document.querySelector('#note [role="status"] > div > .font-medium')?.textContent;
const items = () => [...document.querySelectorAll('#note li')].map(li => li.textContent);
const run = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(50); }); };
const RECEIPT = (a: string) => `${a} was kept. Remove it in Settings if you don't need it.`;
const open = () => mount(h(StoreProvider, null, h(Single), h(Note)));

describe('r3.2 receipt', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  it('live address with confirm: the token is sent and emailKept shows the receipt', async () => {
    stub(() => json({ savedFiles: 0, email: { address: 'ada@example.com', confirm: 'tok-live' } }), { ok: true, emailKept: { address: 'ada@example.com' } });
    open(); await run(); typeName('Ada'); confirm(); await run();
    expect(deleteBodies).toEqual([JSON.stringify({ emailConfirm: 'tok-live' })]);
    expect(title()).toBe(RECEIPT('ada@example.com'));
  });
  it('no emailKept: no receipt', async () => {
    stub(() => json({ savedFiles: 0 }), { ok: true });
    open(); await run(); typeName('Ada'); confirm(); await run();
    expect(title()).toBeUndefined();
  });
  it.each(['<b>x</b>@x.com', 'a&amp;b@x.com', '"q"@x.com', 'josé@münchen.de'])('renders %s literally', async address => {
    stub(() => json({ savedFiles: 0 }), { ok: true, emailKept: { address } });
    open(); await run(); typeName('Ada'); confirm(); await run();
    expect(title()).toBe(RECEIPT(address)); expect(document.querySelector('#note b')).toBeNull();
  });
  it('timeout path: no token sent, server returns emailKept, receipt shown', async () => {
    stub(() => new Promise<Response>(() => {}), { ok: true, emailKept: { address: 'slow@example.com' } });
    open(); typeName('Ada'); await act(async () => { await vi.advanceTimersByTimeAsync(3000); }); confirm(); await run();
    expect(deleteBodies).toEqual([undefined]);
    expect(title()).toBe(RECEIPT('slow@example.com'));
  });
  it('a cleanup warning and the kept-inbox receipt are both shown (single delete)', async () => {
    stub(() => json({ savedFiles: 0 }), { ok: true, warning: 'Cleanup incomplete', emailKept: { address: 'ada@example.com' } });
    open(); await run(); typeName('Ada'); confirm(); await run();
    expect(title()).toBe('This bot was deleted. Some cleanup did not finish:');
    expect(items()).toEqual(['Cleanup incomplete', RECEIPT('ada@example.com')]);
  });
  it('a warning alone is unchanged', async () => {
    stub(() => json({ savedFiles: 0 }), { ok: true, warning: 'Cleanup incomplete' });
    open(); await run(); typeName('Ada'); confirm(); await run();
    expect(items()).toEqual(['Cleanup incomplete']);
  });
  it('the receipt is added to the existing deletion-note items', async () => {
    stub(() => json({ savedFiles: 0 }), { ok: true, leftovers: [{ what: 'Files this bot made', where: 'the folder "Taxes"' }], emailKept: { address: 'ada@example.com' } });
    open(); await run(); typeName('Ada'); confirm(); await run();
    expect(title()).toBe('Deleted. Murage will finish removing these when it can:');
    expect(items()).toEqual(['Files this bot made, in the folder "Taxes".', RECEIPT('ada@example.com')]);
  });
  it('bulk keeps the warning and never adds the receipt', async () => {
    stub(() => json({}), { ok: true, warning: 'Cleanup incomplete', emailKept: { address: 'ada@example.com' } });
    mount(h(StoreProvider, null, h(Bulk), h(Note))); await run();
    act(() => { (document.querySelector('#bulk') as HTMLButtonElement).click(); }); await run();
    expect(items()).toEqual(['Cleanup incomplete']);
  });
  it('bulk never shows the receipt, even when the response carries emailKept', async () => {
    stub(() => json({}), { ok: true, emailKept: { address: 'ada@example.com' } });
    mount(h(StoreProvider, null, h(Bulk), h(Note))); await run();
    act(() => { (document.querySelector('#bulk') as HTMLButtonElement).click(); }); await run();
    expect(deleteBodies).toHaveLength(1); expect(title()).toBeUndefined();
  });
});
