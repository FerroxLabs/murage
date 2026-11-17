// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// R31 r3.2 (1.0.19): the kept-inbox receipt and the cleanup warning come from the DELETE's own answer. The stream's bot.deleted
// frame can settle the run first; the answer is then still read, exactly once. Both orders, through the real stream handler.
import { act, createElement as h } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, installDOMHarness, mount } from '../testing/dom-harness';
import { StoreProvider, useStore, type Action } from './store';

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());

class FakeEventSource {
  static all: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) { FakeEventSource.all.push(this); }
  close() {}
  send(frame: Record<string, unknown>, id: string) { this.onmessage?.({ data: JSON.stringify(frame), lastEventId: id }); }
}
const json = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } }));
let releaseDelete!: (body: unknown) => void;
let deleteCalls = 0;
let dispatch!: (action: Action) => void;
const notes: Array<{ title: string; items: string[] } | null> = [];
function Probe() {
  const store = useStore();
  dispatch = store.dispatch;
  const note = store.state.deletionNote;
  if (notes.at(-1) !== note) notes.push(note);
  return null;
}
const settleAll = async (ms = 50) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const RECEIPT = 'ada@example.com was kept. Remove it in Settings if you don\'t need it.';

beforeEach(async () => {
  vi.useFakeTimers();
  FakeEventSource.all = []; deleteCalls = 0; notes.length = 0;
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/bots/b1') && init?.method === 'DELETE') { deleteCalls += 1; return new Promise<Response>(resolve => { releaseDelete = body => resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })); }); }
    if (url.includes('/api/bots?view=sidebar')) return json({ bots: [], groups: [] });
    return json({});
  }) as typeof fetch);
  mount(h(StoreProvider, null, h(Probe)));
  await settleAll(1500); // the stream opens and the first snapshot is applied
  FakeEventSource.all.at(-1)!.send({ kind: 'hello', resumed: true, cursor: 's:1' }, 's:1');
  await settleAll();
});
afterEach(async () => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const start = () => act(() => { dispatch({ type: 'deleteBot', source: 'local', botId: 'b1', attempt: 'a1' } as Action); });
const streamDeleted = async () => { FakeEventSource.all.at(-1)!.send({ kind: 'bot.deleted', botId: 'b1' }, 's:2'); await settleAll(); };
const answered = async (body: unknown) => { releaseDelete(body); await settleAll(); };
const receipts = () => notes.filter(note => note?.title === RECEIPT || note?.items.includes(RECEIPT));

describe('stream deletion frame and the DELETE answer', () => {
  it('stream frame first, then the answer: the receipt is shown once', async () => {
    start(); await settleAll();
    expect(deleteCalls).toBe(1);
    await streamDeleted();
    await answered({ ok: true, emailKept: { address: 'ada@example.com' } });
    expect(receipts()).toHaveLength(1);
    expect(notes.at(-1)?.title).toBe(RECEIPT);
  });
  it('answer first, then the stream frame: the receipt is shown once', async () => {
    start(); await settleAll();
    await answered({ ok: true, emailKept: { address: 'ada@example.com' } });
    await streamDeleted();
    expect(receipts()).toHaveLength(1);
    expect(notes.at(-1)?.title).toBe(RECEIPT);
  });
  it('stream frame first: the warning and the receipt both arrive, once', async () => {
    start(); await settleAll();
    await streamDeleted();
    await answered({ ok: true, warning: 'Cleanup incomplete', emailKept: { address: 'ada@example.com' } });
    expect(receipts()).toHaveLength(1);
    expect(notes.at(-1)?.items).toEqual(['Cleanup incomplete', RECEIPT]);
  });
  it('stream frame first, then an answer that is not ok: nothing is shown and nothing is retried', async () => {
    start(); await settleAll();
    await streamDeleted();
    await answered({ ok: false });
    expect(receipts()).toHaveLength(0);
    await settleAll(60_000);
    expect(deleteCalls).toBe(1);
  });
});
