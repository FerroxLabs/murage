// SPDX-License-Identifier: AGPL-3.0-or-later
// Red-first tests from the Opus security review of lane 0162-chromereal (lanes/chromereal/OPUS-REVIEW.md): runtime side.
import { describe, it, expect } from 'vitest';
import { fixture } from './browser-extension-test-fixture.mjs';

const ready = async (options = {}) => { const f = fixture({}, options); await f.init(); await f.navigate(); await f.command('cdp', { method: 'Page.enable', tabId: 1, navigationEpoch: 2 }); return f; };
const stateOf = async (f, id = 'bot_a') => (await f.runtime.handlePanel({ action: 'status' })).bindings.find(b => b.bindingId === id);

describe('OR-2 (Medium, coordinator ruling a): the runtime never resumes a task the owner stopped', () => {
  it('panel Resume on a stopped binding is refused and the binding stays stopped', async () => {
    const f = await ready();
    await f.runtime.handlePanel({ action: 'stop', bindingId: 'bot_a' });
    await expect(f.runtime.handlePanel({ action: 'resume', bindingId: 'bot_a' })).rejects.toMatchObject({ code: 'binding_stopped' });
    expect((await stateOf(f)).state).toBe('stopped');
    expect(f.events.some(e => e.event === 'resumed')).toBe(false);
  });
  it('a pause (from the panel or the broker) never turns a stopped binding into a resumable paused one', async () => {
    const f = await ready();
    await f.runtime.handlePanel({ action: 'stop', bindingId: 'bot_a' });
    await f.runtime.handlePanel({ action: 'pause', bindingId: 'bot_a' });
    expect((await stateOf(f)).state).toBe('stopped');
    const { generation } = await stateOf(f);
    await f.command('pause', {}, generation);
    expect((await stateOf(f)).state).toBe('stopped');
    await expect(f.runtime.handlePanel({ action: 'resume', bindingId: 'bot_a' })).rejects.toMatchObject({ code: 'binding_stopped' });
  });
  it('a new task (a new binding) is the way back after a Stop', async () => {
    const f = await ready();
    await f.runtime.handlePanel({ action: 'stop', bindingId: 'bot_a' });
    const fresh = await f.bind('bot_a_next');
    expect(fresh.result.state).toBe('active');
  });
});

describe('OR-4 (Medium): a screenshot never shows what another site draws in a frame (a payment or sign-in form)', () => {
  it('hides cross-site frames for the capture and restores them after, even when the capture fails', async () => {
    for (const fails of [false, true]) {
      const f = await ready();
      const order = [];
      f.api.debugger.sendCommand.mockImplementation(async (source, method, params) => {
        if (method === 'Runtime.evaluate' && params.expression?.includes('data-murage-frame-mask')) order.push(params.expression.includes('restore') ? 'unmask' : 'mask');
        if (method === 'Page.captureScreenshot') { order.push('capture'); if (fails) throw Error('capture failed'); return { data: 'AAAA' }; }
        return f.sendCommand(source, method, params);
      });
      await f.command('cdp', { method: 'Page.captureScreenshot', params: {}, tabId: 1, navigationEpoch: 2 });
      expect(order).toEqual(['mask', 'capture', 'unmask']);
    }
  });
  it('refuses the screenshot when the frames cannot be hidden', async () => {
    const f = await ready();
    f.api.debugger.sendCommand.mockImplementation(async (source, method, params) => {
      if (method === 'Runtime.evaluate' && params.expression?.includes('data-murage-frame-mask') && !params.expression.includes('restore')) return { exceptionDetails: { text: 'no' } };
      if (method === 'Page.captureScreenshot') throw Error('must not capture');
      return f.sendCommand(source, method, params);
    });
    const r = await f.command('cdp', { method: 'Page.captureScreenshot', params: {}, tabId: 1, navigationEpoch: 2 });
    expect(['frame_mask_unavailable', 'masking_unavailable']).toContain(r.error.code);
  });
});

describe('OR-5 (Medium): a page download is stopped before its file is written, not raced after', () => {
  const page = { frameId: 'main-frame', guid: 'g1', url: 'https://allowed.test/report.exe', suggestedFilename: 'report.exe' };
  it('the filename step cancels a download the shared page started, before the browser names the file', async () => {
    const f = await ready({ downloadWaitMs: 50 });
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    expect(await f.runtime.downloadDetermining({ id: 11, url: page.url, finalUrl: page.url })).toBe(true);
    expect(f.api.downloads.cancel).toHaveBeenCalledWith(11);
  });
  it('waits briefly for the page event when the filename step comes first', async () => {
    const f = await ready({ downloadWaitMs: 300 });
    const decided = f.runtime.downloadDetermining({ id: 12, url: page.url, finalUrl: page.url });
    await new Promise(resolve => setTimeout(resolve, 20));
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    expect(await decided).toBe(true);
    expect(f.api.downloads.cancel).toHaveBeenCalledWith(12);
  });
  it('an unrelated download is let through', async () => {
    const f = await ready({ downloadWaitMs: 30 });
    expect(await f.runtime.downloadDetermining({ id: 13, url: 'https://elsewhere.test/a.zip', finalUrl: 'https://elsewhere.test/a.zip', referrer: 'https://elsewhere.test/' })).toBe(false);
    expect(f.api.downloads.cancel).not.toHaveBeenCalled();
  });
  it('with no shared tab attached, the filename step does not wait at all', async () => {
    const f = fixture({}, { downloadWaitMs: 5000 }); await f.runtime.initialize(); await f.runtime.connection(true);
    const started = Date.now();
    expect(await f.runtime.downloadDetermining({ id: 14, url: 'https://x.test/a', finalUrl: 'https://x.test/a' })).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('OR-5: the worker always answers the filename step', () => {
  it('suggest is called exactly once, blocked or not, so no download is left waiting', async () => {
    const { workerFixture, settle } = await import('./browser-extension-worker-fixture.mjs');
    const w = await workerFixture();
    let calls = 0;
    const returned = await w.api.downloads.onDeterminingFilename.fire({ id: 21, url: 'https://elsewhere.test/a.zip', finalUrl: 'https://elsewhere.test/a.zip' }, () => { calls++; });
    expect(returned).toEqual([true]);
    for (let i = 0; i < 100 && !calls; i++) { await new Promise(resolve => setTimeout(resolve, 20)); await settle(); }
    expect(calls).toBe(1);
  });
});
