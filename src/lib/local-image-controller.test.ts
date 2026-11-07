import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalImageController } from './local-image-controller';
import { forgetLocalMedia, refreshLocalMedia, type MediaApi } from './media-resolve';
import { localImageBudget, reserveLocalImage } from './local-image-budget';
const saveFixture = vi.hoisted(() => ({ native: true, nativeCall: vi.fn(), report: vi.fn(), handoff: vi.fn<(blob: Blob, filename: string) => Promise<void>>(async () => {}) }));
vi.mock('./native-shell', () => ({ nativeAvailable: async () => saveFixture.native, callNative: (...args: unknown[]) => saveFixture.nativeCall(...args) }));
vi.mock('./save-file', () => ({ saveBlob: saveFixture.handoff, reportSaveFailure: saveFixture.report }));
const scope = { botId: 'b', threadId: 't' }, request = { scope, absolutePath: '/workspace/p.png' };
const controllers: LocalImageController[] = [];
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
function fixture(width = 1) {
  let resolves = 0;
  const api: MediaApi = async path => {
    if (path.includes('/root?')) return { scope, state: 'ready', displayPath: '/workspace' };
    if (path.includes('/list?')) return { scope, directory: '', directoryRevision: 'd1.test', incomplete: false, entries: [{ name: 'p.png', relativePath: 'p.png', kind: 'file', state: 'local', revision: 'r1.abcdefgh' }] };
    resolves++;
    return { asset: { id: 'ma1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', kind: 'image', name: 'p.png', revision: 'r1.abcdefgh', mime: 'image/png', bytes: 4, width, height: 1, frameCount: 1, decodedBytes: width * 4, capabilities: { preview: true, download: true, imageReference: true }, availability: 'ready' }, url: `/api/media/bytes/ma1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA?cap=${resolves}`, expiresAt: Date.now() + 600000 };
  };
  const controller = new LocalImageController(request, api, () => {}); controllers.push(controller);
  return { controller, resolves: () => resolves, api, setWidth: (value: number) => { width = value; } };
}
beforeEach(() => { forgetLocalMedia(); saveFixture.native = true; saveFixture.report.mockClear(); saveFixture.handoff.mockReset().mockResolvedValue(undefined); saveFixture.nativeCall.mockReset(); });
afterEach(() => { controllers.splice(0).forEach(c => c.dispose()); vi.useRealTimers(); vi.unstubAllGlobals(); expect(localImageBudget().count).toBe(0); });
it('R31-EPOCH/T4 ignores stale nodes and makes the second current error terminal, even after load', async () => {
  const { controller: c, resolves } = fixture(); c.visibility(true); await flush(); const first = c.view.node; expect(first).toBeGreaterThan(0);
  c.error(first); await flush(); expect(resolves()).toBe(2); const second = c.view.node; expect(second).not.toBe(first);
  c.loaded(second); c.error(first); expect(c.view.state).toBe('ready'); c.error(second); await flush(); expect(c.view.state).toBe('load-failed'); expect(resolves()).toBe(2); expect(localImageBudget().count).toBe(0);
  c.visibility(false); c.visibility(true); await flush(); expect(resolves()).toBe(2); c.retry(); await flush(); expect(resolves()).toBe(3);
});
it('R31-TIMER/ST3 times out once at 15000 ms, then ends K4 without a third request', async () => {
  vi.useFakeTimers(); const { controller: c, resolves } = fixture(); c.visibility(true); await flush();
  await vi.advanceTimersByTimeAsync(14999); expect(resolves()).toBe(1); await vi.advanceTimersByTimeAsync(1); await flush(); expect(resolves()).toBe(2);
  await vi.advanceTimersByTimeAsync(15000); expect(c.view.state).toBe('load-failed'); expect(resolves()).toBe(2);
});
it('R31-OFF/ST4 suspends loading, clears tokens and ignores detached callbacks', async () => {
  const { controller: c } = fixture(); c.visibility(true); await flush(); const node = c.view.node;
  c.visibility(false); expect(c.view.state).toBe('waiting'); expect(localImageBudget().count).toBe(0); c.loaded(node); c.error(node); expect(c.view.state).toBe('waiting');
  c.visibility(true); await flush(); expect(c.view.node).toBeGreaterThan(node); c.dispose(); expect(localImageBudget().count).toBe(0);
});
it('R31-OPEN/B9 never mounts large images inline and cancels opening that cannot reserve', async () => {
  const { controller: c } = fixture(24_000_000); c.visibility(true); await flush(); expect(c.view.state).toBe('ready-large'); expect(c.view.node).toBe(0);
  const a = reserveLocalImage(96_000_000)!, b = reserveLocalImage(96_000_000)!;
  try { c.open(); await flush(); expect(c.view.state).toBe('budget-wait'); expect(c.view.node).toBe(0); c.close(); }
  finally { a(); b(); }
  await flush(); expect(c.view.state).toBe('ready-large'); expect(c.view.node).toBe(0); c.open(); await flush(); expect(c.view.surface).toBe('lightbox'); expect(localImageBudget().bytes).toBe(96_000_000);
});
it('T5 expiry refresh spends the epoch before the first replacement error', async () => {
  vi.useFakeTimers(); const { controller: c, resolves } = fixture(); c.visibility(true); await flush(); c.loaded(c.view.node);
  await vi.advanceTimersByTimeAsync(590000); c.open(); await flush(); expect(resolves()).toBe(2); c.error(c.view.node); await flush(); expect(c.view.state).toBe('load-failed'); expect(resolves()).toBe(2);
});
it('R31-RETRY removes a loaded source and joins repeated pending clicks', async () => {
  const { controller: c, resolves } = fixture(); c.visibility(true); await flush(); c.loaded(c.view.node); c.retry(); c.retry(); await flush(); expect(resolves()).toBe(2); expect(localImageBudget().count).toBe(1);
});

it('R31-ADOPT/R32-PLAYER releases old costs on shared growth and stays terminal on later player renewal', async () => {
  const f = fixture(), a = f.controller, b = new LocalImageController(request, f.api, () => {}); controllers.push(b);
  a.visibility(true); b.visibility(true); await flush(); expect(localImageBudget().count).toBe(2);
  f.setWidth(24_000_000);
  await refreshLocalMedia(request, a.view.ready!.generation, 'player', { kind: 'player' }, f.api); await flush();
  expect(a.view.state).toBe('ready-large'); expect(b.view.state).toBe('ready-large'); expect(localImageBudget().bytes).toBe(0);
  a.open(); b.open(); await flush(); expect(localImageBudget().bytes).toBe(96_000_000); expect(a.view.node).toBe(0);
  await refreshLocalMedia(request, b.view.ready!.generation, 'player', { kind: 'player' }, f.api); await flush();
  expect(a.view.state).toBe('load-failed'); expect(b.view.state).toBe('load-failed'); expect(localImageBudget().bytes).toBe(0);
});
it('ST1/ST2/T6 starts no discovery before visibility or explicit admission and drops late work after disposal', async () => {
  let finish!: (value: unknown) => void; const api: MediaApi = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const c = new LocalImageController(request, api, () => {}); controllers.push(c); expect(api).not.toHaveBeenCalled();
  c.retry(); await flush(); expect(api).toHaveBeenCalledTimes(1); c.dispose();
  finish({ scope, state: 'no-dedicated-workspace' }); await flush(); expect(c.view.state).toBe('disposed'); expect(api).toHaveBeenCalledTimes(1);
});

it('BF-1/R32-SAVE-busy-exit keeps both ready cards enabled and never queues saves', async () => {
  vi.useFakeTimers(); saveFixture.native = false;
  const transport = vi.fn(async () => new Response(new Uint8Array(4), { headers: { 'content-length': '4' } })); vi.stubGlobal('fetch', transport);
  const a = fixture().controller, b = fixture().controller; a.visibility(true); b.visibility(true); await flush(); a.loaded(a.view.node); b.loaded(b.view.node);
  a.save(); await flush(); expect(a.view.state).toBe('ready'); expect(saveFixture.handoff).toHaveBeenCalledTimes(1);
  b.save(); a.save(); await flush(); expect(a.view.state).toBe('ready'); expect(b.view.state).toBe('ready'); expect(saveFixture.report).toHaveBeenCalledTimes(2); expect(transport).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(60000); expect(transport).toHaveBeenCalledTimes(1);
  saveFixture.native = true; b.save(); await flush(); expect(b.view.state).toBe('ready'); expect(transport).toHaveBeenCalledTimes(2);
});
it.each(['missing', 'changed', 'denied', 'unsupported'] as const)('ST2 maps %s and never auto-retries terminal answers', async availability => {
  const f = fixture(), api: MediaApi = async (path, init) => { const value = await f.api(path, init); return path === '/api/media/resolve' ? { asset: { ...value.asset, availability }, url: undefined } : value; };
  const c = new LocalImageController(request, api, () => {}); controllers.push(c); c.visibility(true); await flush(); expect(c.view.state).toBe(availability); expect(c.view.node).toBe(0);
  c.visibility(false); c.visibility(true); await flush(); expect(f.resolves()).toBe(1); c.retry(); await flush(); expect(f.resolves()).toBe(2);
});
it('R31-OPEN/ST4 closing during an awaited expiry renewal suppresses the lightbox', async () => {
  vi.useFakeTimers(); const f = fixture(); let release!: () => void; let hold = false;
  const api: MediaApi = async (path, init) => { if (hold && path.includes('/root?')) await new Promise<void>(r => { release = r; }); return f.api(path, init); };
  const c = new LocalImageController(request, api, () => {}); controllers.push(c); c.visibility(true); await flush(); c.loaded(c.view.node);
  await vi.advanceTimersByTimeAsync(590000); hold = true; c.open(); await flush(); expect(c.view.node).toBe(0); c.close(); release(); await flush(); expect(c.view.surface).toBe('thumbnail'); expect(c.view.node).toBeGreaterThan(0);
});
it.each(['waiting', 'resolving', 'ready-loading', 'ready', 'refreshing', 'opening', 'budget-wait', 'saving'] as const)('ST4 disposal from %s removes every owned resource and suppresses late results', async state => {
  vi.useFakeTimers(); const f = fixture(); let hold = false, release!: () => void;
  const api: MediaApi = async (path, init) => { if (hold && path.includes('/root?')) await new Promise<void>(r => { release = r; }); return f.api(path, init); };
  const c = new LocalImageController(request, api, () => {}); controllers.push(c);
  const blockers: Array<() => void> = [];
  if (state === 'resolving') hold = true;
  if (state === 'budget-wait') blockers.push(reserveLocalImage(96000000)!, reserveLocalImage(96000000)!);
  if (state !== 'waiting') { c.visibility(true); await flush(); }
  if (['ready', 'refreshing', 'opening', 'saving'].includes(state)) c.loaded(c.view.node);
  if (state === 'refreshing') { hold = true; c.error(c.view.node); await flush(); }
  if (state === 'opening') { await vi.advanceTimersByTimeAsync(590000); hold = true; c.open(); await flush(); }
  if (state === 'saving') { vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))); c.save(); await flush(); }
  const node = c.view.node; c.dispose(); if (release) release(); blockers.forEach(free => free()); await flush(); c.loaded(node); c.error(node);
  expect(c.view.state).toBe('disposed'); expect(c.view.node).toBe(0); expect(localImageBudget().count).toBe(0); expect(saveFixture.handoff).not.toHaveBeenCalled(); expect(saveFixture.report).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it('F1 image error cancels a pending Save and permits the next action', async () => {
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockImplementation(async () => new Response(new Uint8Array(4), { headers: { 'content-length': '4' } }));
  vi.stubGlobal('fetch', fetcher);
  const f = fixture(), c = f.controller; c.visibility(true); await flush(); c.loaded(c.view.node);
  c.save(); c.error(c.view.node); await flush(); c.loaded(c.view.node);
  c.save(); await flush(); expect(fetcher).toHaveBeenCalledTimes(2); expect(saveFixture.handoff).toHaveBeenCalledTimes(1);
  c.retry(); await flush(); expect(f.resolves()).toBe(3);
});

it('F6 expired budget waiters renew through the 32 owner admission limit', async () => {
  vi.useFakeTimers(); const f = fixture();
  const blockers = [reserveLocalImage(96000000)!, reserveLocalImage(96000000)!];
  let hold = false, finish!: () => void; const gate = new Promise<void>(r => { finish = r; });
  const api: MediaApi = async (path, init) => {
    if (hold) await gate;
    const value = await f.api(path, init), q = new URL(path, 'http://fixture').searchParams;
    return value.scope ? { ...value, scope: { botId: q.get('botId'), threadId: q.get('threadId') } } : value;
  };
  const cards = Array.from({ length: 100 }, (_, i) => {
    const c = new LocalImageController({ ...request, scope: { ...scope, threadId: String(i) } }, api, () => {}); controllers.push(c); c.visibility(true); return c;
  });
  for (let i = 0; i < 30; i++) await flush();
  expect(cards.every(c => c.view.state === 'budget-wait')).toBe(true);
  await vi.advanceTimersByTimeAsync(590000); hold = true; blockers.forEach(free => free()); await flush();
  expect(localImageBudget().discoveries).toBe(32); expect(localImageBudget().waiting).toBe(68);
  const { localMediaCounts } = await import('./media-resolve');
  expect(localMediaCounts().active).toBeLessThanOrEqual(4); expect(localMediaCounts().queued).toBeLessThanOrEqual(28);
  cards.forEach(c => c.dispose()); finish(); for (let i = 0; i < 30; i++) await flush();
  expect(localImageBudget().discoveries).toBe(0); expect(localImageBudget().waiting).toBe(0);
});

it.each(['bytes', 'surfaces'])('F7 repeated Show it retains the lightbox claim while blocked by %s', async limit => {
  const c = fixture(24_000_000).controller; c.visibility(true); await flush();
  const blockers = limit === 'bytes' ? [reserveLocalImage(96000000)!, reserveLocalImage(96000000)!] : Array.from({ length: 32 }, () => reserveLocalImage(4)!);
  try {
    c.open(); c.open(); c.open(); await flush(); expect(c.view.state).toBe('budget-wait'); expect(c.view.surface).toBe('lightbox');
  } finally { blockers.forEach(free => free()); }
  await flush(); expect(c.view.surface).toBe('lightbox'); expect(c.view.node).toBeGreaterThan(0);
});

it('F10 Save ownership remains visible while renewed bytes are loading', async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(Error('expired')).mockImplementationOnce(() => new Promise(() => {})); vi.stubGlobal('fetch', fetcher);
  const c = fixture().controller; c.visibility(true); await flush(); c.loaded(c.view.node);
  c.save(); await flush(); expect(c.view.state).toBe('ready-loading'); expect(c.view.saving).toBe(true);
  c.loaded(c.view.node); expect(c.view.saving).toBe(true); c.dispose(); expect(c.view.saving).toBe(false);
});

it.each(['begin', 'chunk', 'end'])('F13 native %s rejection restores Save and respects visibility and disposal', async phase => {
  const real = await vi.importActual<typeof import('./save-file')>('./save-file');
  for (const outcome of ['visible', 'hidden', 'disposed']) {
    saveFixture.report.mockClear(); saveFixture.handoff.mockImplementation(real.saveBlob);
    let reject!: () => void, failed = false;
    const gate = new Promise<void>(resolve => { reject = resolve; });
    saveFixture.nativeCall.mockImplementation(async (_method, request) => {
      if (request.kind === phase && !failed) { failed = true; await gate; throw Error('Native fixture refusal'); }
    });
    const transport = vi.fn(async () => new Response(new Uint8Array(4), { headers: { 'content-length': '4' } })); vi.stubGlobal('fetch', transport);
    forgetLocalMedia(); const f = fixture(), c = f.controller; c.visibility(true); await flush(); c.loaded(c.view.node); c.save();
    await vi.waitFor(() => expect(failed).toBe(true));
    expect(c.view.saving).toBe(true);
    if (outcome === 'hidden') c.visibility(false);
    if (outcome === 'disposed') c.dispose();
    reject();
    const { localImageSaveBusy } = await import('./local-image-save');
    await vi.waitFor(() => expect(localImageSaveBusy()).toBe(false));
    expect(c.view.saving).toBe(false); expect(f.resolves()).toBe(1);
    expect(saveFixture.report).toHaveBeenCalledTimes(outcome === 'disposed' ? 0 : 1);
    if (outcome === 'disposed') { expect(c.view.state).toBe('disposed'); expect(c.view.node).toBe(0); }
    else {
      expect(c.view.state).toBe(outcome === 'hidden' ? 'waiting' : 'ready');
      if (outcome === 'hidden') { expect(c.view.node).toBe(0); c.visibility(true); await flush(); c.loaded(c.view.node); }
      expect(c.view.node).toBeGreaterThan(0);
      c.save(); await vi.waitFor(() => expect(c.view.saving).toBe(false));
      expect(c.view.state).toBe('ready'); expect(transport).toHaveBeenCalledTimes(2);
      expect(saveFixture.nativeCall.mock.calls.at(-1)?.[1]).toMatchObject({ kind: 'end' });
      expect(f.resolves()).toBe(1); expect(saveFixture.report).toHaveBeenCalledTimes(1);
    }
    c.dispose();
  }
});
