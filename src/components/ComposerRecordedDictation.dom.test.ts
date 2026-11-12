// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// The real Composer and recorder path, with a local transcription fixture and injected model cleanup.
import { act, createElement as h } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, installDOMHarness, mount, settle } from '../testing/dom-harness';
import { activeTrapCount } from '../lib/focus-trap';
import { resetDictationForTests } from '../lib/dictation-session';
import { createServer, type Server } from 'node:http';
import { createVoiceBudget, handleTranscribeRoute } from '../../server/voice/transcribe-route';
import { CLEANUP_NOTICE, CLEANUP_NOTICE_KEY, CLEANUP_PREF_KEY } from '../lib/dictation-cleanup';
import { initialState, type Bot } from '../state/store';
import { Composer } from './Composer';
import { MIN_CLIP_BYTES } from './PushToTalk';

const fixture = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  dispatch: vi.fn(),
  approvals: [] as unknown[],
  available: false,
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

const RAW = 'um please send these recorded words';
const CLEAN = 'Please send these recorded words.';
const modelCleanup = vi.fn(async () => ({ text: CLEAN, cleaned: true }));
const urls: string[] = [];
let server: Server;
let base: string;
let restore: () => void;
let app: ReturnType<typeof mount>;
let current: Bot;
let sequence = 0;
const nativeFetch = globalThis.fetch;
const audio = Object.assign(new Uint8Array(MIN_CLIP_BYTES * 2), [0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);

class Recorder {
  static latest: Recorder;
  static isTypeSupported() { return true; }
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  constructor() { Recorder.latest = this; }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; }
  deliver() {
    this.ondataavailable?.({ data: new Blob([audio], { type: this.mimeType }) });
    this.onstop?.();
  }
}
const tree = () => h(Composer, { bot: current });
const notice = () => document.querySelector('[data-composer] [data-cleanup-notice]');
async function flush() { await act(async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); }); }
async function waitForPost() {
  await vi.waitFor(() => expect(urls).toHaveLength(1));
  await vi.waitFor(() => expect(document.body.textContent).not.toContain('Transcribing'));
  await flush();
}
async function record() {
  const button = document.querySelector<HTMLButtonElement>('button[aria-label="Hold to talk"]')!;
  expect(button).toBeTruthy();
  await act(async () => { button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })); });
  expect(Recorder.latest.state).toBe('recording');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
  return Recorder.latest;
}

beforeAll(async () => {
  restore = installDOMHarness();
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  server = createServer(async (req, res) => {
    await handleTranscribeRoute(req.method ?? 'GET', new URL(req.url ?? '/', base), req, res, {
      transcribe: async () => ({ text: RAW, duration: 3, billedSeconds: 10 }),
      budget: createVoiceBudget(),
      cleanup: modelCleanup,
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  restore();
});
beforeEach(() => {
  resetDictationForTests();
  localStorage.clear();
  localStorage.setItem(CLEANUP_PREF_KEY, 'on');
  urls.length = 0;
  modelCleanup.mockClear();
  fixture.state = { ...initialState, config: { flux: { configured: true } }, instances: [], bots: [] };
  fixture.dispatch.mockReset();
  current = { id: `recorded-${++sequence}`, name: 'Fixture', threadId: 'thread', busy: false, messages: [], modelSelection: { instanceId: 'inst1' } } as unknown as Bot;
  vi.stubGlobal('MediaRecorder', Recorder);
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (!url.startsWith('/api/voice/transcribe')) return Promise.resolve({ ok: true, json: async () => ({}) });
    urls.push(url);
    // Use the recorder fixture's exact bytes across jsdom's Blob boundary.
    return nativeFetch(`${base}${url}`, { ...init, body: audio });
  }));
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
  app = mount(tree());
});
afterEach(async () => {
  cleanup();
  await settle();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetDictationForTests();
  expect(activeTrapCount()).toBe(0);
});

describe('recorded dictation consent', () => {
  it('dictation notice storage errors preserve delayed disclosure in the replacement composer exactly once', async () => {
    const shownAtDisplay: boolean[] = [];
    const getItem = vi.fn(() => { throw new Error('blocked'); });
    const setItem = vi.fn((key: string, value: string) => {
      if (key === CLEANUP_NOTICE_KEY && value === 'shown') shownAtDisplay.push(Boolean(notice()?.isConnected));
      throw new Error('blocked');
    });
    vi.stubGlobal('localStorage', { getItem, setItem });
    const recorder = await record();
    const recorderId = current.id;
    app.unmount();
    current = { ...current, id: `recorded-${++sequence}`, threadId: 'storage-replacement-thread' };
    app = mount(tree());
    expect(notice()).toBeNull();
    expect(shownAtDisplay).toEqual([]);

    await act(async () => { recorder.deliver(); });
    await vi.waitFor(() => expect(modelCleanup).toHaveBeenCalledTimes(1));
    await flush();
    expect(urls).toEqual(['/api/voice/transcribe?cleanup=1&botId=' + encodeURIComponent(recorderId)]);
    expect(notice()?.textContent).toBe(CLEANUP_NOTICE);
    expect(document.querySelectorAll('[data-composer] [data-cleanup-notice]')).toHaveLength(1);
    expect(shownAtDisplay).toEqual([true]);
    expect(getItem).toHaveBeenCalledWith(CLEANUP_NOTICE_KEY);
    expect(setItem).toHaveBeenCalledWith(CLEANUP_NOTICE_KEY, 'pending');

    app.unmount();
    app = mount(tree());
    expect(notice()).toBeNull();
    const nextRecorder = await record();
    await act(async () => { nextRecorder.deliver(); });
    await vi.waitFor(() => expect(modelCleanup).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(document.body.textContent).not.toContain('Transcribing'));
    await flush();
    expect(notice()).toBeNull();
    expect(shownAtDisplay).toEqual([true]);
  });

  it('rechecks OFF after render before posting a clip and never calls model cleanup', async () => {
    const recorder = await record();
    // A same-origin window writes the device setting without rerendering this composer.
    localStorage.setItem(CLEANUP_PREF_KEY, 'off');
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Listening. Release to transcribe"]')!
        .dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
      recorder.deliver();
    });
    await waitForPost();
    expect(urls).toEqual(['/api/voice/transcribe']);
    expect(modelCleanup).not.toHaveBeenCalled();
    expect(notice()).toBeNull();
    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(RAW);
  });

  it('keeps a notice pending for a clip delivered after unmount until the next composer displays it once', async () => {
    const recorder = await record();
    app.unmount();
    await act(async () => { recorder.deliver(); });
    await vi.waitFor(() => expect(modelCleanup).toHaveBeenCalledTimes(1));
    await flush();
    expect(notice()).toBeNull();
    expect(localStorage.getItem(CLEANUP_NOTICE_KEY)).not.toBe('shown');

    app = mount(tree());
    expect(notice()?.textContent).toBe(CLEANUP_NOTICE);
    expect(localStorage.getItem(CLEANUP_NOTICE_KEY)).toBe('shown');
    app.unmount();
    app = mount(tree());
    expect(notice()).toBeNull();
  });


  it('shows a pending notice once when the replacement composer mounted before the delayed clip arrives', async () => {
    const recorder = await record();
    app.unmount();
    current = { ...current, id: `recorded-${++sequence}`, threadId: 'replacement-thread' };
    app = mount(tree());
    expect(notice()).toBeNull();
    expect(localStorage.getItem(CLEANUP_NOTICE_KEY)).toBeNull();

    const shownAtDisplay: boolean[] = [];
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === CLEANUP_NOTICE_KEY && value === 'shown') shownAtDisplay.push(Boolean(notice()?.isConnected));
      setItem.call(this, key, value);
    });
    await act(async () => { recorder.deliver(); });
    await vi.waitFor(() => expect(modelCleanup).toHaveBeenCalledTimes(1));
    await flush();
    expect(urls).toEqual(['/api/voice/transcribe?cleanup=1&botId=' + encodeURIComponent(`recorded-${sequence - 1}`)]);
    expect(notice()?.textContent).toBe(CLEANUP_NOTICE);
    expect(document.querySelectorAll('[data-composer] [data-cleanup-notice]')).toHaveLength(1);
    expect(localStorage.getItem(CLEANUP_NOTICE_KEY)).toBe('shown');
    expect(shownAtDisplay).toEqual([true]);

    app.unmount();
    app = mount(tree());
    expect(notice()).toBeNull();
    expect(shownAtDisplay).toEqual([true]);
  });
});
