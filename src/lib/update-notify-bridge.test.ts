import { afterEach, expect, it, vi } from "vitest";
import { reportUpdateNotice, startPopupLatch, startUpdateNotice, type UpdatePopupLatch } from "./update-card";
import { setLocale, subscribeLocale, t } from "./i18n";

afterEach(async () => { await setLocale('en'); });
const cleanups: Array<() => void> = [];
afterEach(() => { for (const stop of cleanups.splice(0)) stop(); });
function fixture(closed = false, status: 'downloaded' | 'downloading' = 'downloaded') {
  const report = vi.fn(async () => {}), show = vi.fn();
  const callbacks = new Set<(version: string) => void>();
  const locales = new Set<() => void>();
  const stop = startUpdateNotice({ version: '2.0.0', status,
    readLatch: () => ({ following: true, closed: closed ? 'ready' : 'no' }),
    translate: t, updater: { reportNotice: report,
      onNotice: callback => { callbacks.add(callback); return () => { callbacks.delete(callback); }; } },
    subscribeLocale: callback => {
      locales.add(callback);
      const unsubscribe = subscribeLocale(callback);
      return () => { locales.delete(callback); unsubscribe(); };
    }, show });
  cleanups.push(stop);
  return { report, show, stop, callbacks, locales, dismiss: () => { closed = true; } };
}
it('reports current catalog words, refreshes on language changes, and cleans up subscriptions', async () => {
  await setLocale('en');
  const f = fixture();
  expect(f.report).toHaveBeenLastCalledWith({ version: '2.0.0', dismissed: false, title: 'Murage 2.0.0 is ready to install' });
  await setLocale('de');
  expect(f.report).toHaveBeenCalledTimes(2);
  expect(f.report).toHaveBeenLastCalledWith(expect.objectContaining({ title: t('updates.systemReady', { version: '2.0.0' }) }));
  f.stop(); expect(f.callbacks.size).toBe(0);
  await setLocale('en'); expect(f.report).toHaveBeenCalledTimes(2);
});
it('reports saved dismissal and rechecks dismissal when activation arrives', () => {
  const saved = fixture(true); expect(saved.report).toHaveBeenCalledWith(expect.objectContaining({ dismissed: true })); saved.stop();
  const f = fixture();
  for (const cb of f.callbacks) { cb('other'); cb('2.0.0'); }
  expect(f.show).toHaveBeenCalledOnce();
  f.dismiss(); for (const cb of f.callbacks) cb('2.0.0');
  expect(f.show).toHaveBeenCalledOnce(); f.stop();
});
it('activation cannot show an unready popup; replacing the subscription removes stale handlers', () => {
  const old = fixture(false, 'downloading');
  for (const cb of old.callbacks) cb('2.0.0');
  expect(old.show).not.toHaveBeenCalled(); old.stop();
  const ready = fixture(); expect(old.callbacks.size).toBe(0);
  for (const cb of ready.callbacks) cb('2.0.0');
  expect(ready.show).toHaveBeenCalledOnce(); ready.stop();
});
it('cleanup removes both subscriptions and makes retained callbacks inert', async () => {
  const f = fixture();
  expect(f.callbacks.size).toBe(1);
  expect(f.locales.size).toBe(1);
  const notice = [...f.callbacks][0];
  const locale = [...f.locales][0];
  notice('2.0.0'); locale();
  expect(f.show).toHaveBeenCalledOnce();
  expect(f.report).toHaveBeenCalledTimes(2);
  f.stop();
  expect(f.callbacks.size).toBe(0);
  expect(f.locales.size).toBe(0);
  f.dismiss();
  // Captured callbacks model events already queued before unsubscription.
  locale();
  notice('2.0.0');
  await setLocale('de');
  expect(f.show).toHaveBeenCalledOnce();
  expect(f.report).toHaveBeenCalledTimes(2);
});
it('a retained ready activation cannot change state after cleanup, even without dismissal', () => {
  const f = fixture();
  const notice = [...f.callbacks][0];
  f.stop(); notice('2.0.0');
  expect(f.show).not.toHaveBeenCalled();
});
it('the latch effect commits the exact latch once and cleanup leaves it unchanged', () => {
  let state: UpdatePopupLatch = { following: false, closed: 'no' };
  const latch: UpdatePopupLatch = { following: true, closed: 'ready', version: '2.0.0' };
  const commit = vi.fn((next: UpdatePopupLatch) => { state = next; });
  const stop = startPopupLatch({ latch, commit });
  expect(state).toBe(latch);
  expect(commit).toHaveBeenCalledExactlyOnceWith(latch);
  stop();
  expect(state).toBe(latch);
  expect(commit).toHaveBeenCalledOnce();
});
it('the report adapter forwards the complete value and preserves the IPC result', async () => {
  const value = { version: '2.0.0', dismissed: true, title: 'Ready' };
  const result = Promise.resolve();
  const reportNotice = vi.fn(() => result);
  expect(reportUpdateNotice({ reportNotice }, value)).toBe(result);
  expect(reportNotice).toHaveBeenCalledExactlyOnceWith(value);
  expect(reportUpdateNotice(undefined, value)).toBeUndefined();
  expect(reportUpdateNotice({}, value)).toBeUndefined();
});
it('missing updater methods and version need no report and still release the locale listener', () => {
  const callbacks = new Set<() => void>();
  const reportNotice = vi.fn();
  for (const updater of [undefined, {}, { reportNotice }]) {
    const stop = startUpdateNotice({ updater, readLatch: () => ({ following: false, closed: 'no' }),
      translate: t, show: vi.fn(), subscribeLocale: cb => {
        callbacks.add(cb); return () => { callbacks.delete(cb); };
      } });
    expect(callbacks.size).toBe(1);
    stop(); expect(callbacks.size).toBe(0);
  }
  expect(reportNotice).not.toHaveBeenCalled();
});
