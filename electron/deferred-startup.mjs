// SPDX-License-Identifier: AGPL-3.0-or-later
export const STARTUP_PRESENTATION_MS = 120_000;
export function createDeferredStartup({ failure, record, changed = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const operations = new Set();
  function finish(token, notify = true) {
    if (!operations.delete(token)) return false;
    clearTimer(token.timer); if (notify) changed(); return true;
  }
  function begin({ deadlineMs = STARTUP_PRESENTATION_MS } = {}) {
    const token = {
      active: () => operations.has(token),
      assertActive() { if (!token.active()) throw Object.assign(Error('STARTUP_SUPERSEDED'), { code: 'STARTUP_SUPERSEDED' }); },
      terminal: () => finish(token),
      fail(error) {
        if (!finish(token, false)) { record(error); return; }
        failure(error);
      },
      observe(promise) {
        Promise.resolve(promise).then(result => {
          if (!token.active()) { record({ code: 'STARTUP_SUPERSEDED' }); return; }
          // The OS installer has been requested, but has not exited yet.
          if (result?.status !== 'install-requested') finish(token);
        }, error => token.fail(error));
        return promise;
      },
    };
    operations.add(token);
    token.timer = setTimer(() => {
      if (!token.active()) return;
      token.fail({ code: 'STARTUP_PRESENTATION_TIMEOUT' });
    }, deadlineMs);
    token.timer?.unref?.();
    return token;
  }
  return { begin, get size() { return operations.size; }, presented() { for (const token of [...operations]) finish(token); } };
}
