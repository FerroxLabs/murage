// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// DICTATION-LIFECYCLE-1018 section 5 B: the REAL Composer, the REAL dictation store and runner and the REAL
// DictationStatusBar, mounted in jsdom against a fake `window.muragebox` whose speechStart/Stop/Finish return
// deferreds the test settles. Nothing here reads source text.
import { Fragment, act, createElement as h } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, installDOMHarness, mount, settle } from '../testing/dom-harness';
import { activeTrapCount, openLayer } from '../lib/focus-trap';
import { nextLayerSequence } from '../lib/layers';
import { dictationPress, resetDictationForTests, getDictationState } from '../lib/dictation-session';
import { readComposerDraft, settleDraftSend } from '../lib/drafts';
import { initialState, type Bot } from '../state/store';
import { Composer } from './Composer';
import { DictationStatusBar } from './DictationStatusBar';

const fixture = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  dispatch: vi.fn(),
  approvals: [] as unknown[],
  available: true,
}));
vi.mock('../state/store', async (original) => ({
  ...(await original<typeof import('../state/store')>()),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch, refreshAfterKey: vi.fn() }),
  api: vi.fn(async () => ({})),
}));
vi.mock('./DesktopCapabilities', async (original) => ({
  ...(await original<typeof import('./DesktopCapabilities')>()),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: fixture.available }, host: { platform: 'darwin' } } }),
}));
vi.mock('../lib/pending-approval', async (original) => ({
  ...(await original<typeof import('../lib/pending-approval')>()),
  pendingApprovals: () => fixture.approvals,
}));
vi.mock('./PendingApprovalQueue', () => ({ PendingApprovalQueue: () => null }));
vi.mock('./PushToTalk', () => ({ PushToTalk: () => null, browserPushToTalkFacts: () => ({}) }));

interface Deferred { promise: Promise<void>; resolve(): void; reject(): void }
function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = () => no(new Error('refused')); });
  return { promise, resolve, reject };
}
type Handler<T> = (value: T) => void;
function fakeMuragebox() {
  const starts: Deferred[] = [], stops: Deferred[] = [], finishes: Deferred[] = [];
  const startCalls: Array<{ session?: string }> = [], stopCalls: Array<string | undefined> = [], finishCalls: Array<string | undefined> = [];
  const transcripts = new Set<Handler<Record<string, unknown>>>(), ends = new Set<Handler<Record<string, unknown>>>();
  const bridge = {
    speechStart: (options?: { session?: string }) => { startCalls.push(options ?? {}); const d = deferred(); starts.push(d); return d.promise; },
    speechStop: (session?: string) => { stopCalls.push(session); const d = deferred(); stops.push(d); return d.promise; },
    speechFinish: (session?: string) => { finishCalls.push(session); const d = deferred(); finishes.push(d); return d.promise; },
    onDictationTranscript: (cb: Handler<Record<string, unknown>>) => { transcripts.add(cb); return () => { transcripts.delete(cb); }; },
    onDictationEnd: (cb: Handler<Record<string, unknown>>) => { ends.add(cb); return () => { ends.delete(cb); }; },
    onSpeechTranscript: () => () => {},
    onSpeechEnd: () => () => {},
  };
  return {
    bridge, starts, stops, finishes, startCalls, stopCalls, finishCalls,
    listeners: () => transcripts.size + ends.size,
    token: () => startCalls.at(-1)!.session!,
    emitTranscript: (line: Record<string, unknown>) => act(() => { for (const cb of [...transcripts]) cb(line); }),
    emitEnd: (info: Record<string, unknown>) => act(() => { for (const cb of [...ends]) cb(info); }),
  };
}

// A fresh bot id per test: the draft records are module state, and a send leaves its draft held.
let botSeq = 0;
const bot = (patch: Record<string, unknown> = {}) => ({
  id: `bot${botSeq}`, name: 'Fixture', threadId: 'th1', busy: false, messages: [], modelSelection: { instanceId: 'inst1' }, ...patch,
}) as unknown as Bot;
const draftOf = (b: Bot) => `bot:${b.id}:${b.threadId}`;

let restore: () => void;
let box: ReturnType<typeof fakeMuragebox>;
let app: ReturnType<typeof mount>;
let current: Bot;
let composerShown = true;
const tree = () => h(Fragment, null, composerShown ? h(Composer, { key: current.threadId, bot: current }) : null, h(DictationStatusBar));
const render = () => { act(() => app.rerender(tree())); };
const fetchCalls: Deferred[] = [];

beforeAll(() => {
  restore = installDOMHarness();
  // jsdom has no layout, no matchMedia and no rAF-driven caret work that matters here
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterAll(() => restore());
beforeEach(() => {
  resetDictationForTests();
  fixture.state = { ...initialState, instances: [], bots: [] };
  fixture.dispatch.mockReset();
  fixture.approvals = [];
  fixture.available = true;
  composerShown = true;
  botSeq += 1;
  current = bot();
  box = fakeMuragebox();
  window.muragebox = box.bridge as unknown as typeof window.muragebox;
  fetchCalls.length = 0;
  vi.stubGlobal('fetch', vi.fn(() => {
    const d = deferred();
    fetchCalls.push(d);
    return d.promise.then(() => ({ ok: true, json: async () => ({ text: 'Tidied words', cleaned: true }) }));
  }));
  try { localStorage.clear(); } catch { /* none */ }
  app = mount(tree());
});
afterEach(async () => {
  cleanup();
  await settle();
  expect(activeTrapCount()).toBe(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  delete window.muragebox;
  resetDictationForTests();
});

// ---- helpers over the real DOM
const textarea = () => document.querySelector<HTMLTextAreaElement>('textarea')!;
const startButton = () => document.querySelector<HTMLButtonElement>('button[aria-label="Start dictation"]');
const micStop = () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop dictation"]');
const controlsDrawn = () => document.querySelectorAll('button[aria-label="Stop dictation"], [data-dictation-control]').length;
const controlButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[data-dictation-control] button')].find((b) => b.textContent === label);
const sendButton = () => document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
const draftText = () => readComposerDraft(draftOf(current)).text;
const text = () => document.body.textContent ?? '';
async function flush() { await act(async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); }); }
async function settleD(d: Deferred, how: 'resolve' | 'reject' = 'resolve') { await act(async () => { d[how](); for (let i = 0; i < 40; i++) await Promise.resolve(); }); }
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea(), value);
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}
async function clickMic() { await act(async () => { (micStop() ?? startButton())!.click(); }); await flush(); }
/** The send journals the draft first (a real 50 ms verify window), so wait for the dispatch in real time. */
async function clickSend() {
  await act(async () => { sendButton()!.click(); });
  await flush();
  const dispatched = () => fixture.dispatch.mock.calls.some((c) => c[0].type === 'send');
  for (let i = 0; i < 100 && !dispatched(); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}
/** Start dictation and reach listening (no words yet). */
async function listen() {
  await clickMic();
  await settleD(box.starts[0]);
}
async function say(words: string, partial = true) {
  box.emitTranscript({ text: words, partial, session: box.token() });
  await flush();
}
async function ack() {
  const send = fixture.dispatch.mock.calls.map((c) => c[0]).find((a) => a.type === 'send');
  expect(send, 'the send was dispatched').toBeTruthy();
  await act(async () => { await settleDraftSend(draftOf(current), send.sendId, send.outboxDraft.attemptId, 'acked'); });
  await flush();
}
function openWindowLayer() {
  const node = document.createElement('div');
  document.body.append(node);
  const handle = openLayer({ id: `dict-w${nextLayerSequence()}`, name: 'settings', kind: 'window', openingSequence: nextLayerSequence(), returnFocusTo: null });
  act(() => handle.attach(node, {}, 'loaded'));
  return { node, close: () => { act(() => handle.release()); node.remove(); } };
}
const approval = () => ({ message: { id: 'm1', from: { name: 'Fixture' } } });

describe('composer dictation, real component and store', () => {
  it('1. words stream, the mic stays "Stop dictation", and a press finishes, then stops, then clears the control', async () => {
    expect(startButton()).not.toBeNull();
    await listen();
    await say('hello there');
    expect(textarea().value).toBe('hello there');
    expect(micStop()).not.toBeNull();
    expect(startButton()).toBeNull();
    await clickMic();
    expect(box.finishCalls).toEqual([box.token()]);
    await say('hello there friend', false);
    box.emitEnd({ code: 0, reason: 'completed', session: box.token() });
    await flush();
    expect(box.stopCalls).toEqual([box.token()]);
    expect(textarea().value).toBe('hello there friend');
    await settleD(box.stops[0]);
    expect(controlsDrawn()).toBe(0);
    await type('');
    expect(startButton()).not.toBeNull();
  });

  it('2. send while listening, acknowledged: one send, one stop, a later partial leaves the box empty, no tidy-up request', async () => {
    await listen();
    await say('please send this');
    await clickSend();
    expect(fixture.dispatch.mock.calls.filter((c) => c[0].type === 'send')).toHaveLength(1);
    expect(box.stopCalls).toEqual([box.token()]);
    await ack();
    expect(textarea().value).toBe('');
    await say('a late partial');
    expect(textarea().value).toBe('');
    expect(draftText()).toBe('');
    await settleD(box.stops[0]);
    expect(fetchCalls).toHaveLength(0);
    expect(controlsDrawn()).toBe(0);
  });

  it('3. mic, then send inside the 1.5 s: the final line is not written', async () => {
    await listen();
    await say('almost done');
    await clickMic();
    expect(box.finishCalls).toHaveLength(1);
    await clickSend();
    await say('almost done now', false);
    box.emitEnd({ code: 0, reason: 'completed', session: box.token() });
    await flush();
    await ack();
    expect(textarea().value).toBe('');
    expect(box.stopCalls).toHaveLength(1);
  });

  it('3b. the finish deadline (1.5 s) settles a finish that never gets its final line, then stops', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await listen();
    await say('quiet words');
    await clickMic();
    expect(box.stopCalls).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_499); });
    expect(box.stopCalls).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(2); });
    expect(box.stopCalls).toEqual([box.token()]);
  });

  it('3c. a finish request that is refused stops at once', async () => {
    await listen();
    await say('words');
    await clickMic();
    await settleD(box.finishes[0], 'reject');
    expect(box.stopCalls).toEqual([box.token()]);
  });

  it('4. an approval while listening: exactly one "Stop dictation" (the strip), finish called, words kept', async () => {
    await listen();
    await say('keep these');
    fixture.approvals = [approval()];
    render();
    await flush();
    expect(box.finishCalls).toEqual([box.token()]);
    expect(controlsDrawn()).toBe(1);
    expect(micStop()).toBeNull();
    expect(controlButton('Stop dictation')).toBeTruthy();
    expect(draftText()).toBe('keep these');
  });

  it('5. approval, the stop is refused: "Stop again"; the click makes a second stop; resolving it clears the control', async () => {
    await listen();
    await say('keep these');
    fixture.approvals = [approval()];
    render();
    await flush();
    box.emitEnd({ code: 0, reason: 'completed', session: box.token() });
    await flush();
    expect(box.stopCalls).toHaveLength(1);
    await settleD(box.stops[0], 'reject');
    expect(controlsDrawn()).toBe(1);
    expect(text()).toContain('Dictation did not stop, so the microphone may still be on.');
    expect(controlButton('Stop again')).toBeTruthy();
    await act(async () => { controlButton('Stop again')!.click(); });
    await flush();
    expect(box.stopCalls).toHaveLength(2);
    await settleD(box.stops[1]);
    expect(controlsDrawn()).toBe(0);
    expect(draftText()).toBe('keep these');
  });

  it('6. send, the stop is refused: "Stop again", the box is empty after the ack, a late partial is ignored', async () => {
    await listen();
    await say('send me');
    await clickSend();
    await settleD(box.stops[0], 'reject');
    expect(controlButton('Stop again')).toBeTruthy();
    await ack();
    expect(textarea().value).toBe('');
    await say('too late');
    expect(textarea().value).toBe('');
    expect(controlButton('Stop again')).toBeTruthy();
  });

  it('7. locked turning true while listening, and the engine becoming unavailable while listening, both leave one strip', async () => {
    await listen();
    await say('words');
    current = bot({ awaitingThreadSnapshot: true });
    render();
    await flush();
    expect(box.finishCalls).toHaveLength(1);
    expect(controlsDrawn()).toBe(1);
    expect(controlButton('Stop dictation')).toBeTruthy();
    cleanup(); resetDictationForTests();

    box = fakeMuragebox();
    window.muragebox = box.bridge as unknown as typeof window.muragebox;
    botSeq += 1;
    current = bot();
    app = mount(tree());
    await listen();
    await say('words');
    fixture.available = false;
    render();
    await flush();
    expect(controlsDrawn()).toBe(1);
    expect(micStop()).toBeNull();
    expect(controlButton('Stop dictation')).toBeTruthy();
    await act(async () => { controlButton('Stop dictation')!.click(); });
    await flush();
    expect(box.finishCalls).toEqual([box.token()]);
  });

  it('8. remount with a new key while listening, the stop is refused: the app bar shows "Stop again"', async () => {
    await listen();
    await say('words');
    current = bot({ threadId: 'th2' });
    render();
    await flush();
    expect(box.stopCalls).toEqual([box.token()]);
    expect(controlsDrawn()).toBe(1);
    await settleD(box.stops[0], 'reject');
    expect(controlsDrawn()).toBe(1);
    expect(controlButton('Stop again')).toBeTruthy();
    expect(document.body.contains(controlButton('Stop again')!)).toBe(true);
  });

  it('9. with no Composer mounted, only the app bar: visible while stopping and while failed', async () => {
    await listen();
    await say('words');
    composerShown = false;
    render();
    await flush();
    expect(controlsDrawn()).toBe(1);
    expect(controlButton('Stopping dictation')).toBeFalsy();
    expect(text()).toContain('Stopping dictation');
    await settleD(box.stops[0], 'reject');
    expect(controlButton('Stop again')).toBeTruthy();
    expect(controlsDrawn()).toBe(1);
  });

  it('10. a permission error ends in idle with its message and no control; helper-stop-pending is failed', async () => {
    await listen();
    box.emitEnd({ code: 1, reason: 'recognition-error', session: box.token() });
    await flush();
    expect(controlsDrawn()).toBe(0);
    expect(text()).toContain('Dictation needs Microphone + Speech Recognition access.');
    expect(startButton()).not.toBeNull();

    await clickMic();
    box.emitEnd({ code: 1, reason: 'helper-stop-pending', session: box.token() });
    await flush();
    expect(controlButton('Stop again')).toBeTruthy();
  });

  it('11. speechStart rejecting: idle, the could-not-start message, and the placeholder is not "Listening"', async () => {
    await clickMic();
    expect(textarea().placeholder).toContain('Listening');
    await settleD(box.starts[0], 'reject');
    expect(text()).toContain('Dictation could not start. Try again in a moment.');
    expect(textarea().placeholder).not.toContain('Listening');
    expect(controlsDrawn()).toBe(0);
    expect(getDictationState().kind).toBe('idle');
  });

  it('12. a start while failed retries the stop first; when that is refused speechStart is never called', async () => {
    await listen();
    box.emitEnd({ code: 1, reason: 'stop-failed', session: box.token() });
    await flush();
    expect(controlButton('Stop again')).toBeTruthy();
    act(() => dictationPress(draftOf(current), ''));
    await flush();
    expect(box.stopCalls).toHaveLength(1);
    await settleD(box.stops[0], 'reject');
    expect(box.startCalls).toHaveLength(1);
    expect(controlButton('Stop again')).toBeTruthy();
  });

  it('13a. idle invalidation by send: a tidy-up pending after the stop resolved changes nothing, and no session starts', async () => {
    await listen();
    await say('tidy me please');
    await clickMic();
    box.emitEnd({ code: 0, reason: 'completed', session: box.token() });
    await flush();
    await settleD(box.stops[0]);
    expect(getDictationState().kind).toBe('idle');
    expect(fetchCalls).toHaveLength(1);
    await clickSend();
    await ack();
    expect(draftText()).toBe('');
    await settleD(fetchCalls[0]);
    expect(draftText()).toBe('');
    expect(textarea().value).toBe('');
    expect(box.startCalls).toHaveLength(1);
  });

  it('13b. idle invalidation by unmount: the landing tidy-up changes nothing', async () => {
    await listen();
    await say('tidy me please');
    await clickMic();
    box.emitEnd({ code: 0, reason: 'completed', session: box.token() });
    await flush();
    await settleD(box.stops[0]);
    expect(fetchCalls).toHaveLength(1);
    composerShown = false;
    render();
    await flush();
    await settleD(fetchCalls[0]);
    expect(draftText()).toBe('tidy me please');
    expect(box.startCalls).toHaveLength(1);
  });

  it('13c. an uninterrupted tidy-up still lands, and is undoable', async () => {
    await listen();
    await say('tidy me please');
    await clickMic();
    box.emitEnd({ code: 0, reason: 'completed', session: box.token() });
    await flush();
    await settleD(box.stops[0]);
    await settleD(fetchCalls[0]);
    expect(draftText()).toBe('Tidied words');
    expect(text()).toContain('Dictation cleaned up.');
  });

  it('14. superseded and stop-failed with the old token: idle, and failed with "Stop again"', async () => {
    await listen();
    await say('words');
    box.emitEnd({ code: 0, reason: 'superseded', session: box.token() });
    await flush();
    expect(controlsDrawn()).toBe(0);
    expect(getDictationState().kind).toBe('idle');
    cleanup(); resetDictationForTests();

    box = fakeMuragebox();
    window.muragebox = box.bridge as unknown as typeof window.muragebox;
    botSeq += 1;
    current = bot();
    app = mount(tree());
    await listen();
    box.emitEnd({ code: 1, reason: 'stop-failed', session: box.token() });
    await flush();
    expect(controlButton('Stop again')).toBeTruthy();
  });

  it('15. delayed events: an end or a partial with a previous token after a new start is ignored', async () => {
    await listen();
    const first = box.token();
    box.emitEnd({ code: 0, reason: 'completed', session: first });
    await flush();
    expect(getDictationState().kind).toBe('idle');
    await clickMic();
    await settleD(box.starts[1]);
    expect(box.token()).not.toBe(first);
    box.emitEnd({ code: 1, reason: 'stop-failed', session: first });
    box.emitTranscript({ text: 'stale words', partial: true, session: first });
    await flush();
    expect(getDictationState().kind).toBe('listening');
    expect(textarea().value).toBe('');
    expect(micStop()).not.toBeNull();
  });

  it('16. Escape in the textarea stops (finish); a window blur changes nothing', async () => {
    await listen();
    await say('words');
    act(() => { window.dispatchEvent(new Event('blur')); });
    await flush();
    expect(getDictationState().kind).toBe('listening');
    expect(box.finishCalls).toHaveLength(0);
    await act(async () => { textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    await flush();
    expect(box.finishCalls).toEqual([box.token()]);
  });

  describe('17. the invariant sweep: exactly one visible stop control unless idle', () => {
    const kinds = ['starting', 'listening', 'stopping', 'failed'] as const;
    const scenarios = ['none', 'approval', 'locked', 'unavailable', 'covered', 'unmounted'] as const;
    const reach = async (kind: (typeof kinds)[number]) => {
      await clickMic();
      if (kind === 'starting') return;
      await settleD(box.starts[0]);
      if (kind === 'listening') return;
      if (kind === 'stopping') { await clickMic(); return; }
      box.emitEnd({ code: 1, reason: 'stop-failed', session: box.token() });
      await flush();
    };
    for (const kind of kinds) {
      for (const scenario of scenarios) {
        it(`${kind} x ${scenario}`, async () => {
          await reach(kind);
          let layer: ReturnType<typeof openWindowLayer> | null = null;
          if (scenario === 'approval') fixture.approvals = [approval()];
          if (scenario === 'locked') current = bot({ awaitingThreadSnapshot: true });
          if (scenario === 'unavailable') fixture.available = false;
          if (scenario === 'unmounted') composerShown = false;
          if (scenario === 'covered') layer = openWindowLayer();
          render();
          await flush();
          expect(controlsDrawn(), `${kind} x ${scenario}`).toBe(1);
          expect(startButton()).toBeNull();
          layer?.close();
        });
      }
    }
    it('idle: no stop control, and the start button shows when eligible', async () => {
      expect(controlsDrawn()).toBe(0);
      expect(startButton()).not.toBeNull();
      fixture.approvals = [approval()];
      render();
      await flush();
      expect(startButton()).toBeNull();
      expect(controlsDrawn()).toBe(0);
    });
    it('a layer opening above the Composer moves the control to the app bar inside that layer', async () => {
      await listen();
      await say('words');
      const layer = openWindowLayer();
      try {
        await flush();
        expect(controlsDrawn()).toBe(1);
        expect(layer.node.querySelector('[data-dictation-control]')).not.toBeNull();
      } finally {
        layer.close();
      }
      await flush();
    });
  });

  it('18. a deferred start, then send: speechStop(token) is called, the start never reaches listening, and the control stays until the stop settles', async () => {
    await clickMic();
    await type('typed while starting');
    expect(box.startCalls).toHaveLength(1);
    await clickSend();
    expect(box.stopCalls).toEqual([box.token()]);
    await settleD(box.starts[0]);
    expect(getDictationState().kind).toBe('stopping');
    expect(controlsDrawn()).toBe(1);
    await settleD(box.stops[0]);
    expect(getDictationState().kind).toBe('idle');
    expect(controlsDrawn()).toBe(0);
  });

  it('19. send while failed makes a new stop attempt; the control stays until it resolves', async () => {
    await listen();
    box.emitEnd({ code: 1, reason: 'stop-failed', session: box.token() });
    await flush();
    await type('typed after the failure');
    expect(controlButton('Stop again')).toBeTruthy();
    await clickSend();
    expect(box.stopCalls).toHaveLength(1);
    expect(controlsDrawn()).toBe(1);
    await settleD(box.stops[0]);
    expect(controlsDrawn()).toBe(0);
  });

  it('20. transfer invalidation: after superseded an old stop, an old start result, an old tidy-up and an old finish timer change nothing, even after a new session started', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // session 1: words, finish (timer armed), final line (tidy out, stop out), then superseded
    await listen();
    const first = box.token();
    await say('first session words');
    await clickMic();
    box.emitEnd({ code: 0, reason: 'completed', session: first });
    await flush();
    expect(fetchCalls).toHaveLength(1);
    box.emitEnd({ code: 0, reason: 'superseded', session: first });
    await flush();
    expect(getDictationState().kind).toBe('idle');
    // session 2 starts (the box has words, so use the store's own entry point)
    act(() => dictationPress(draftOf(current), ''));
    await flush();
    const second = box.token();
    expect(second).not.toBe(first);
    await settleD(box.stops[0]);
    await settleD(fetchCalls[0]);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(getDictationState()).toMatchObject({ kind: 'starting', token: second });
    expect(draftText()).toBe('first session words');
    await settleD(box.starts[1]);
    expect(getDictationState().kind).toBe('listening');
    expect(box.stopCalls).toHaveLength(1);
  });

  it('20b. an old start that is still unresolved when superseded arrives never lands, even after a new session starts', async () => {
    await clickMic();
    const first = box.token();
    box.emitEnd({ code: 0, reason: 'superseded', session: first });
    await flush();
    expect(getDictationState().kind).toBe('idle');
    act(() => dictationPress(draftOf(current), ''));
    await flush();
    const second = box.token();
    expect(second).not.toBe(first);
    await settleD(box.starts[0]); // the old start finally resolves
    expect(getDictationState()).toMatchObject({ kind: 'starting', token: second });
    await settleD(box.starts[1]);
    expect(getDictationState().kind).toBe('listening');
    expect(box.stopCalls).toHaveLength(0);
  });

  it('20c. an armed finish deadline of a superseded session never fires into the next session', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await listen();
    const first = box.token();
    await clickMic(); // finish requested, 1.5 s deadline armed
    expect(box.finishCalls).toEqual([first]);
    box.emitEnd({ code: 0, reason: 'superseded', session: first });
    await flush();
    expect(getDictationState().kind).toBe('idle');
    act(() => dictationPress(draftOf(current), ''));
    await flush();
    await settleD(box.starts[1]);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(getDictationState()).toMatchObject({ kind: 'listening', token: box.token() });
    expect(box.stopCalls).toHaveLength(0);
  });

  it('20d. a tidy-up already out when superseded arrives changes nothing when it lands, with no new session started', async () => {
    await listen();
    const first = box.token();
    await say('first session words');
    await clickMic();
    box.emitEnd({ code: 0, reason: 'completed', session: first });
    await flush();
    expect(fetchCalls).toHaveLength(1);
    box.emitEnd({ code: 0, reason: 'superseded', session: first });
    await flush();
    await settleD(fetchCalls[0]);
    expect(draftText()).toBe('first session words');
    expect(getDictationState().kind).toBe('idle');
    expect(box.startCalls).toHaveLength(1);
  });

  it('21. restart after a stop: start, stop, start again; the second session writes normally', async () => {
    await listen();
    await clickMic();
    box.emitEnd({ code: 0, reason: 'completed', session: box.token() });
    await flush();
    await settleD(box.stops[0]);
    expect(getDictationState().kind).toBe('idle');
    await clickMic();
    await settleD(box.starts[1]);
    await say('second session');
    expect(textarea().value).toBe('second session');
  });

  it('the recognizer listeners are attached only while a session is not idle', async () => {
    expect(box.listeners()).toBe(0);
    await listen();
    expect(box.listeners()).toBe(2);
    box.emitEnd({ code: 0, reason: 'completed', session: box.token() });
    await flush();
    expect(box.listeners()).toBe(0);
  });
});
