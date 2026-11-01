// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.7 RC6: a backup taken while the workspace is closed always ends with
// Murage open again.
//
// The backup-mode relaunch shows a small progress window that the person can't
// close (backup-progress-window.mjs). On RC5 that window also refused the
// app's own quit: app.quit() asks every window to close, the window cancelled
// it, so the process never exited and app.relaunch() never fired. Murage stayed
// closed behind the progress window for hours (Sean's Mac, 10-26). So here:
//   - the progress window is destroyed, never asked to close, before quitting;
//   - if the app is still alive a short while after app.quit(), it exits, so
//     the relaunch fires (cleanup has already finished by then);
//   - one relaunch is armed at most, however many outcomes ask for it;
//   - the whole run has a ceiling: a backup that has not finished by then is
//     recorded as failed and Murage reopens normally, where the failure notice
//     says so (announceLastBackupFailure).

/** How long app.quit() gets before the app exits by itself. */
export const BACKUP_QUIT_GRACE_MS = 5_000;

/** The least a whole closed backup gets. The worker gets 30 s on top of the
 * capture's budget before RECOVERY_WORKER_TIMEOUT; the rest covers the
 * reference checks, the backup tool check and cleanup. */
export const OFFLINE_BACKUP_CEILING_MS = 35 * 60_000;

/** The ceiling for one run: its budget plus the same 5 minutes, never less
 * than the fixed ceiling. A budget that can't be used gets the fixed one. */
export const offlineCeilingFor = budgetMs => Number.isSafeInteger(budgetMs) ? Math.max(OFFLINE_BACKUP_CEILING_MS, budgetMs + 5 * 60_000) : OFFLINE_BACKUP_CEILING_MS;

/** Destroy the progress window, quit, and make sure the process really ends. */
export function quitForRelaunch({ app, progress, graceMs = BACKUP_QUIT_GRACE_MS, setTimer = setTimeout, log = () => {} }) {
  try { progress?.destroy(); } catch { /* a window that is already gone can't block the quit */ }
  try { app.quit(); } catch { /* the exit below still ends the process */ }
  setTimer(() => {
    try { log("backup return: still open after quit, exiting so Murage reopens"); } catch { /* logging never blocks */ }
    app.exit(0);
  }, graceMs);
}

/** The one way back to the workspace after a backup in backup mode: cleanup,
 * arm the relaunch, then quitForRelaunch. Repeated calls share the attempt, so
 * a success and a failure (or a ceiling) never start two copies; a failed
 * cleanup can be tried again. */
export function createBackupReturn({ app, cleanup, relaunch, takeProgress, graceMs = BACKUP_QUIT_GRACE_MS, setTimer = setTimeout, log = () => {} }) {
  let attempt = null;
  return function returnToWorkspace() {
    if (attempt) return attempt;
    const current = (async () => {
      await cleanup();
      relaunch();
      quitForRelaunch({ app, progress: takeProgress(), graceMs, setTimer, log });
    })();
    attempt = current;
    current.catch(() => { if (attempt === current) attempt = null; });
    return current;
  };
}

/** Run the backup-mode capture and always finish it one of two ways: Murage
 * reopens normally, or (only when the capture never got as far as closing
 * anything) the Backup mode page opens. The progress window goes either way.
 * Resolves with "verified", "failed", "timed-out" or "backup-mode". */
export async function runOfflineBackup({ run, abandon, returnToWorkspace, shutdownStarted, showBackupMode, destroyProgress, ceilingMs = OFFLINE_BACKUP_CEILING_MS, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} }) {
  let timer;
  const ceiling = new Promise(resolve => { timer = setTimer(() => resolve("timed-out"), ceilingMs); });
  let outcome;
  try { outcome = await Promise.race([Promise.resolve().then(run).then(() => "verified"), ceiling]); }
  catch { outcome = "failed"; }
  finally { try { clearTimer(timer); } catch { /* the race is already decided */ } }
  const note = line => { try { log(line); } catch { /* logging never blocks */ } };
  const backupMode = () => {
    try { showBackupMode(); } catch { /* the progress window still goes */ }
    finally { try { destroyProgress(); } catch { /* already gone */ } }
    return "backup-mode";
  };
  if (outcome === "timed-out") {
    note(`backup did not finish within ${Math.round(ceilingMs / 60_000)} minutes; reopening`);
    let setAside = true;
    try { abandon(); } catch { setAside = false; }
    // The job could not be marked for review: a relaunch would arm the same
    // backup again, so stay open on the Backup mode page instead.
    if (!setAside) { note("backup given up but not recorded; showing the Backup mode page"); return backupMode(); }
  }
  // Nothing was closed yet (the host never reached its relaunch): the Backup
  // mode page, as before, rather than a relaunch that would arm the same backup again.
  if (outcome === "failed" && !shutdownStarted()) return backupMode();
  try { await returnToWorkspace(); return outcome; }
  catch { note("backup return: cleanup unconfirmed; showing the Backup mode page"); return backupMode(); }
}
