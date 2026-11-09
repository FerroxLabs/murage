import { afterEach, expect, it, vi } from 'vitest';
import { localImageSaveBusy, saveLocalImage } from './local-image-save';
import type { LocalMediaResolution } from './media-resolve';
const ready = (): Extract<LocalMediaResolution, { state: 'ready' }> => ({ state: 'ready', canonicalKey: 'k', generation: 1, relativePath: 'p.png', expiresAt: Date.now() + 600000, url: '/api/media/bytes/ma1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA?cap=test', asset: { id: 'id', source: 'workspace', scope: { serverId: 'local', botId: 'b', threadId: 't' }, kind: 'image', mime: 'image/png', name: 'picture.png', revision: 'r1.abcdefgh', bytes: 4, availability: 'ready', capabilities: { preview: true, download: true, imageReference: true, reveal: false, open: false } } });
const response = (bytes = new Uint8Array(4), length = String(bytes.length)) => new Response(bytes, { headers: { 'content-length': length } });
const options = () => ({ shown: ready(), live: () => true, renew: vi.fn(async () => ready() as LocalMediaResolution), fetcher: vi.fn(async () => response()) as unknown as typeof fetch, handoff: vi.fn(async (_blob: Blob, _name: string) => {}), native: async () => true, report: vi.fn() });
afterEach(() => vi.useRealTimers());
it('R2-A4 observes failed fetch, renews once and hands verified same-revision bytes to saveBlob', async () => {
  const o = options(); o.fetcher = vi.fn().mockRejectedValueOnce(Error()).mockResolvedValueOnce(response());
  expect(await saveLocalImage(o).result).toEqual({ state: 'saved' }); expect(o.renew).toHaveBeenCalledTimes(1); expect(o.handoff).toHaveBeenCalledTimes(1);
  expect(o.handoff.mock.calls[0]?.[0]).toBeInstanceOf(Blob); expect(localImageSaveBusy()).toBe(false);
});
it('T5 refuses changed revisions and a second fetch failure without another renewal', async () => {
  const o = options(); o.fetcher = vi.fn().mockRejectedValue(Error());
  expect(await saveLocalImage(o).result).toEqual({ state: 'failed' }); expect(o.renew).toHaveBeenCalledTimes(1); expect(o.report).toHaveBeenCalledTimes(1); expect(o.handoff).not.toHaveBeenCalled();
  const changed = options(); changed.fetcher = vi.fn().mockRejectedValue(Error()); changed.renew = vi.fn(async () => ({ ...ready(), asset: { ...ready().asset, revision: 'r1.changed' } }));
  expect((await saveLocalImage(changed).result).state).toBe('changed'); expect(changed.handoff).not.toHaveBeenCalled(); expect(localImageSaveBusy()).toBe(false);
});
it('R31-CAP validates exact 26,214,400 boundary, declared and actual lengths and short bodies', async () => {
  for (const [expected, actual, declared, passes] of [[26214400, 26214400, 26214400, true], [26214401, 26214401, 26214401, false], [4, 5, 4, false], [4, 3, 4, false], [4, 4, 5, false]] as const) {
    const o = options(); o.shown.asset.bytes = expected; o.fetcher = vi.fn(async () => response(new Uint8Array(actual), String(declared))); o.renew = vi.fn(async () => ({ state: 'exhausted' }));
    const result = await saveLocalImage(o).result; expect(result.state === 'saved').toBe(passes); expect(o.handoff).toHaveBeenCalledTimes(passes ? 1 : 0);
  }
});
it('R32-SAVE headers and body deadlines release despite never-settling cancellation', async () => {
  vi.useFakeTimers();
  for (const body of [false, true]) {
    const o = options();
    o.fetcher = vi.fn(async () => body ? new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1)); }, cancel() { return new Promise(() => {}); } }), { headers: { 'content-length': '4' } }) : await new Promise<Response>(() => {}));
    const action = saveLocalImage(o); await vi.advanceTimersByTimeAsync(14999); expect(localImageSaveBusy()).toBe(true); expect(o.renew).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(o.renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15000); expect(await action.result).toEqual({ state: 'failed' }); expect(o.fetcher).toHaveBeenCalledTimes(2); expect(o.report).toHaveBeenCalledTimes(1); expect(localImageSaveBusy()).toBe(false);
  }
});
it('T6/R32-SAVE disposal aborts pending acquisition and suppresses late handoff/report', async () => {
  const o = options(); let answer!: (response: Response) => void; o.fetcher = vi.fn(() => new Promise<Response>(resolve => { answer = resolve; }));
  const action = saveLocalImage(o); action.dispose(); expect(await action.result).toEqual({ state: 'disposed' }); expect(localImageSaveBusy()).toBe(false);
  answer(response()); await Promise.resolve(); expect(o.handoff).not.toHaveBeenCalled(); expect(o.report).not.toHaveBeenCalled(); expect(o.renew).not.toHaveBeenCalled();
});
it('R32-SAVE-busy-exit preserves browser retention after disposal and does not queue another save', async () => {
  vi.useFakeTimers(); const a = options(); a.native = async () => false;
  const action = saveLocalImage(a); expect(await action.result).toEqual({ state: 'saved' }); action.dispose();
  const b = options(); const busy = saveLocalImage(b); expect(busy.acquired).toBe(false); expect(await busy.result).toEqual({ state: 'busy' }); expect(b.fetcher).not.toHaveBeenCalled(); expect(b.report).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(59999); expect(localImageSaveBusy()).toBe(true); await vi.advanceTimersByTimeAsync(1); expect(localImageSaveBusy()).toBe(false); expect(b.fetcher).not.toHaveBeenCalled();
  expect(await saveLocalImage(b).result).toEqual({ state: 'saved' });
});
it('R31-SAVE handoff rejection reports once and never renews', async () => {
  const o = options(); o.handoff = vi.fn().mockRejectedValue(Error());
  expect(await saveLocalImage(o).result).toEqual({ state: 'handoff-failed' }); expect(o.renew).not.toHaveBeenCalled(); expect(o.report).toHaveBeenCalledTimes(1); expect(localImageSaveBusy()).toBe(false);
});

it('BF-1 releases a timed-out attempt before discovery and exits if another action takes the slot', async () => {
  vi.useFakeTimers(); const a = options(); a.fetcher = vi.fn(() => new Promise<Response>(() => {}));
  let renewed!: (value: LocalMediaResolution) => void; a.renew = vi.fn(() => new Promise(resolve => { renewed = resolve; }));
  const first = saveLocalImage(a); await vi.advanceTimersByTimeAsync(15000); expect(localImageSaveBusy()).toBe(false);
  const b = options(); b.fetcher = vi.fn(() => new Promise<Response>(() => {})); const second = saveLocalImage(b); expect(second.acquired).toBe(true);
  renewed(ready()); expect(await first.result).toEqual({ state: 'busy' }); expect(a.fetcher).toHaveBeenCalledTimes(1); expect(localImageSaveBusy()).toBe(true);
  second.dispose(); expect(localImageSaveBusy()).toBe(false); expect(await second.result).toEqual({ state: 'disposed' });
});
it('BF-16 rejects redirects, non-OK status and absent declared length', async () => {
  for (const make of [() => new Response('x', { status: 409 }), () => new Response(new Uint8Array(4)), () => { const r = response(); Object.defineProperty(r, 'redirected', { value: true }); return r; }]) {
    const o = options(); o.fetcher = vi.fn(async () => make()); o.renew = vi.fn(async () => ({ state: 'exhausted' }));
    expect((await saveLocalImage(o).result).state).not.toBe('saved'); expect(o.handoff).not.toHaveBeenCalled(); expect(localImageSaveBusy()).toBe(false);
  }
});

it('R32-SAVE spent recovery reports exactly once and releases ownership', async () => {
  const o = options(); o.fetcher = vi.fn().mockRejectedValue(Error()); o.renew = vi.fn(async () => ({ state: 'exhausted' }));
  expect((await saveLocalImage(o).result).state).toBe('unavailable'); expect(o.report).toHaveBeenCalledTimes(1); expect(localImageSaveBusy()).toBe(false);
});
it('R32-SAVE disposal during a partial body releases even if cancellation never settles', async () => {
  vi.useFakeTimers(); const o = options(); o.fetcher = vi.fn(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1)); }, cancel() { return new Promise(() => {}); } }), { headers: { 'content-length': '4' } }));
  const action = saveLocalImage(o); await vi.advanceTimersByTimeAsync(1); action.dispose();
  expect(await action.result).toEqual({ state: 'disposed' }); expect(localImageSaveBusy()).toBe(false); expect(vi.getTimerCount()).toBe(0); expect(o.renew).not.toHaveBeenCalled(); expect(o.report).not.toHaveBeenCalled(); expect(o.handoff).not.toHaveBeenCalled();
  expect(await saveLocalImage(options()).result).toEqual({ state: 'saved' });
});
