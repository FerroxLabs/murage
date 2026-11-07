// SPDX-License-Identifier: AGPL-3.0-or-later
// Presentation owns shutdown: never let closing the last splash start it.
export const startupFailureCode = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,100}$/.test(error.code) ? error.code : 'STARTUP_FAILED';
const record = (deps, error) => { try { deps.record(error); } catch { /* storage cannot veto presentation */ } };
const stopping = deps => ['owner', 'system', 'unclassified'].includes(deps.cause());

export async function fallbackDesktopStartup(error, deps) {
  record(deps, error);
  if (stopping(deps)) { deps.closeSplash(); return; }
  deps.automatic();
  deps.closeSplash();
  deps.showError(error);
  await finishStartupFailure(deps);
}

export async function finishStartupFailure(deps) {
  try { await deps.cleanup(); }
  catch (error) {
    record(deps, error);
    // A failed cleanup is not authority to release an owned child or lock.
    deps.retain(() => { void finishStartupFailure(deps).catch(error => terminalDesktopStartup(error, deps)); });
    return;
  }
  deps.exit(1);
}

// The single call site's last handler cannot reject, including if a fallback
// dependency throws. Try independent presentation before retryable cleanup.
export async function terminalDesktopStartup(error, deps) {
  record(deps, error);
  try { if (stopping(deps)) return; } catch { /* still attempt presentation */ }
  try { deps.automatic(); } catch { /* record already retained */ }
  for (const present of [() => deps.showError(error), () => deps.showRecovery(error)]) {
    try { await present(); break; } catch (failure) { record(deps, failure); }
  }
  try { await deps.cleanup(); }
  catch (failure) {
    record(deps, failure);
    try { deps.retain(() => { void terminalDesktopStartup(error, deps); }); } catch (failure) { record(deps, failure); }
    return;
  }
  // Cleanup is confirmed even when both native presentation mechanisms fail.
  try { deps.exit(1); } catch (failure) { record(deps, failure); }
}

export function settleDesktopStartup(promise, deps) {
  return Promise.resolve(promise).then(() => deps.success(), async error => {
    if (stopping(deps)) { record(deps, error); deps.closeSplash(); return; }
    if (deps.closedBackup()) return deps.finishClosedBackup(error);
    record(deps, error);
    if (stopping(deps)) { deps.closeSplash(); return; }
    if (error?.code !== "HANDOFF_HELPER_ALIVE" && deps.packaged() && !deps.shutdownStarted()) {
      try { await deps.showRecovery(error); return; } catch { /* native fallback */ }
    }
    return fallbackDesktopStartup(error, deps);
  });
}
