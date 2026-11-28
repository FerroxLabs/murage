// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// W16 wire (TEACH-ENTRY 1.0.23 D9.2, Fable M1): the real StoreProvider takes a `send` action and its outbox POSTs
// /api/bots/:id/messages. The Teach card's flag must be in that request body, and absent when the action has none.
import { act, createElement as h } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, installDOMHarness, mount } from '../testing/dom-harness';
import { StoreProvider, useStore, type Action } from './store';

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) {}
  close() {}
}
const json = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } }));
let posts: Array<Record<string, unknown>> = [];
let dispatch!: (action: Action) => void;
function Probe() { dispatch = useStore().dispatch; return null; }
const settleAll = async (ms = 50) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(async () => {
  vi.useFakeTimers();
  localStorage.clear();
  posts = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/bots/b1/messages') && init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return json({ accepted: true, message: { id: 'm1' } }); }
    if (url.includes('/api/bots?view=sidebar')) return json({ bots: [], groups: [] });
    return json({});
  }) as typeof fetch);
  mount(h(StoreProvider, null, h(Probe)));
  await settleAll(1500);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const send = async (extra: Record<string, unknown>) => {
  act(() => { dispatch({ type: 'send', botId: 'b1', threadId: 't1', text: 'I want to teach you something', sendId: `s-${posts.length}-${Math.random().toString(36).slice(2)}`, ...extra } as Action); });
  await settleAll(500);
};

describe('W16 teachCard reaches the send request body', () => {
  it('a send action with teachCard posts teachCard: true', async () => {
    await send({ teachCard: true });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ text: 'I want to teach you something', threadId: 't1', teachCard: true });
  });
  it('a send action without it posts no teachCard key', async () => {
    await send({});
    expect(posts).toHaveLength(1);
    expect(posts[0]).not.toHaveProperty('teachCard');
  });
});
