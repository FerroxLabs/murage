// SPDX-License-Identifier: AGPL-3.0-or-later
// One bounded background read per five minutes, independent of turns and Settings.
export const CONNECTOR_HEALTH_INTERVAL_MS = 5 * 60_000;
export function startConnectorHealthMonitor(check: () => Promise<void>, options: {
  setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout; onError?: () => void;
} = {}) {
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const tick = async () => {
    try { await check(); } catch { options.onError?.(); }
    if (!stopped) arm(CONNECTOR_HEALTH_INTERVAL_MS);
  };
  const arm = (ms: number) => { timer = setTimer(() => { void tick(); }, ms); timer.unref?.(); };
  arm(15_000);
  return () => { stopped = true; clearTimer(timer); };
}
