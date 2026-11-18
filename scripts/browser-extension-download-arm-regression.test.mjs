// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { fixture } from './browser-extension-test-fixture.mjs';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it('R10 old arm A cannot destroy B before its owner announcement at 30.5 s', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100000);
  const f = fixture(); await f.init(); await f.navigate();
  await f.command('cdp', { tabId: 1, navigationEpoch: 2, method: 'Page.enable' });
  const announce = (tabId, url) => f.runtime.debuggerEvent({ tabId }, 'Page.downloadWillBegin', { url });
  const url = 'https://allowed.test/new.csv';
  await announce(1, 'https://allowed.test/old.csv');
  await f.command('bind', { profileId: 'profile_1', botName: 'Owner', approvedOrigins: ['https://allowed.test'], noLimits: true }, 1, 'owner');
  f.tabs.get(2).url = 'https://allowed.test/owner';
  await f.runtime.navigation({ tabId: 2, frameId: 0, url: f.tabs.get(2).url });
  await vi.advanceTimersByTimeAsync(29000);
  // Attach the owner near B's creation so Chrome still delivers its late event.
  expect(await f.command('cdp', { tabId: 2, navigationEpoch: 2, noLimits: true, method: 'Page.enable' }, 1, 'owner')).not.toHaveProperty('error');
  await announce(1, url);
  await f.runtime.downloadCreated({ id: 820, url, tabId: 1 });
  expect(f.api.downloads.pause).toHaveBeenCalledWith(820);
  await vi.advanceTimersByTimeAsync(1500);
  expect(f.api.downloads.cancel).not.toHaveBeenCalled();
  expect(f.api.downloads.removeFile).not.toHaveBeenCalled();
  expect(f.api.downloads.erase).not.toHaveBeenCalled();
  await announce(2, url);
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.api.downloads.resume).toHaveBeenCalledWith(820);
  expect(f.api.downloads.cancel).not.toHaveBeenCalled();
  expect(f.api.downloads.removeFile).not.toHaveBeenCalled();
  expect(f.api.downloads.erase).not.toHaveBeenCalled();
});
