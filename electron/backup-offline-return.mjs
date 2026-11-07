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
export function quitForRelaunch({ app, progress, reopening = true, graceMs = BACKUP_QUIT_GRACE_MS, setTimer = setTimeout, log = () => {} }) {
  try { progress?.destroy(); } catch { /* a window that is already gone can't block the quit */ }
  try { app.murageShutdownCause = app.murageShutdownCause || (reopening ? "automatic" : "owner"); app.quit(); } catch { /* the exit below still ends the process */ }
  setTimer(() => {
    try { log(reopening ? "backup return: still open after quit, exiting so Murage reopens" : "quit: background work closed; finishing exit"); } catch { /* logging never blocks */ }
    app.exit(0);
  }, graceMs);
}

/** The one way back to the workspace after a backup in backup mode: cleanup,
 * arm the relaunch, then quitForRelaunch. Repeated calls share the attempt, so
 * a success and a failure (or a ceiling) never start two copies; a failed
 * cleanup can be tried again. */
export function createReturnAuthority() {
  return { userQuitRequested: false, generation: 0, attempt: null, leaving: false, internalQuit: false, quitAttempt: null };
}
const authorities = new WeakMap();
function authorityFor(app) { if (!authorities.has(app)) authorities.set(app,createReturnAuthority()); return authorities.get(app); }
export function revokeReturn(authority) {
  authority.userQuitRequested = true;
  authority.generation++;
  authority.cancelGate?.();
}
function internalQuit(authority, app) {
  authority.internalQuit = true;
  try { app.murageShutdownCause = app.murageShutdownCause || "automatic"; app.quit(); } finally { authority.internalQuit = false; }
}
function boundedExit({authority, reopening = true, app, takeProgress, onLeaving, graceMs, setTimer, log}) {
  try { takeProgress?.()?.destroy(); } catch { /* already gone */ }
  onLeaving?.();
  quitForRelaunch({app: {get murageShutdownCause() { return app.murageShutdownCause; }, set murageShutdownCause(cause) { app.murageShutdownCause = cause; }, quit: () => internalQuit(authority, app), exit: code => app.exit(code)}, reopening, graceMs, setTimer, log});
}
export function createBackupReturn({ app, authority = authorityFor(app), cleanup, relaunch, takeProgress, onFailure = () => {}, onLeaving, graceMs = BACKUP_QUIT_GRACE_MS, setTimer = setTimeout, log = () => {} }) {
  return function returnToWorkspace({prepare = () => ({kind: "normal"}), destination, afterCleanup, retry = false} = {}) {
    if (authority.userQuitRequested) return Promise.resolve({status: "stopped"});
    if (authority.attempt) return authority.attempt.promise;
    if (authority.failedReturn && !retry) return Promise.reject(authority.failedReturn);
    authority.failedReturn = null;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const attempt = {promise, generation: authority.generation, destination};
    authority.attempt = attempt;
    // Ownership is installed before preparation, including synchronous reentry.
    const fail = error => {
      if (authority.attempt === attempt) authority.attempt = null;
      authority.leaving = false;
      authority.failedReturn = error;
      try { onFailure(error); } finally { reject(error); }
    };
    try {
      attempt.destination = Object.freeze(destination ?? prepare());
    } catch (error) { authority.attempt=null; reject(error); return promise; }
    try {
      Promise.resolve(cleanup()).then(() => {
        if (authority.userQuitRequested || authority.generation !== attempt.generation) { resolve({status: "stopped"}); return; }
        afterCleanup?.();
        if (authority.userQuitRequested || authority.generation !== attempt.generation) { resolve({status: "stopped"}); return; }
        authority.leaving = true;
        relaunch(attempt.destination);
        boundedExit({authority,app,takeProgress,onLeaving,graceMs,setTimer,log});
        resolve({status: "leaving"});
      }).catch(fail);
    } catch (error) { fail(error); }
    return promise;
  };
}
export function joinExplicitQuit({app, authority = authorityFor(app), scheduleExit = setImmediate, cleanup, takeProgress, onLeaving, onFailure = () => {}, graceMs = BACKUP_QUIT_GRACE_MS, setTimer = setTimeout, log = () => {}}) {
  revokeReturn(authority);
  if (authority.quitAttempt) return authority.quitAttempt;
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  authority.quitAttempt = promise;
  try {
    Promise.resolve(cleanup()).then(() => {
      scheduleExit(()=>{
        authority.leaving = true;
        boundedExit({authority,app,takeProgress,onLeaving,graceMs,setTimer,log,reopening:false});
        resolve({status: "quit"});
      });
    }).catch(error => { authority.quitAttempt = null; onFailure(error); reject(error); });
  } catch (error) { authority.quitAttempt = null; onFailure(error); reject(error); }
  return promise;
}

/** Run the backup-mode capture and always finish it one of two ways: Murage
 * reopens normally, or (only when the capture never got as far as closing
 * anything) the Backup mode page opens. The progress window goes either way.
 * Resolves with "verified", "failed", "timed-out" or "backup-mode". */
export async function runOfflineBackup({ run, abandon, returnToWorkspace, shutdownStarted, showBackupMode, destroyProgress, showCleanupFailure = () => {}, ceilingMs = OFFLINE_BACKUP_CEILING_MS, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {}, operation }) {
  let timer;
  const ceiling = new Promise(resolve => { timer = setTimer(() => resolve("timed-out"), ceilingMs); });
  let outcome;
  let failure;
  try { outcome = await Promise.race([Promise.resolve().then(run).then(result => result?.status === "stopped" ? "stopped" : "verified"), ceiling]); }
  catch (error) { failure = error; outcome = "failed"; }
  finally { try { clearTimer(timer); } catch { /* the race is already decided */ } }
  const note = line => { try { log(line); } catch { /* logging never blocks */ } };
  const backupMode = () => {
    operation?.assertActive();
    try { showBackupMode(); operation?.terminal(); }
    finally { try { destroyProgress(); } catch { /* already gone */ } }
    return "backup-mode";
  };
  operation?.assertActive();
  const cleanupFailure = error => { destroyProgress(); showCleanupFailure(error); operation?.terminal(); return "cleanup-failed"; };
  if (failure?.code === "BACKUP_UPGRADE_CLEANUP_FAILED") return cleanupFailure(failure);
  if (outcome === "stopped") { operation?.terminal(); return "stopped"; }
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
  try { operation?.assertActive(); const result = await returnToWorkspace(); operation?.terminal(); return result?.status === "stopped" ? "stopped" : outcome; }
  catch (error) { if(error?.code === "BACKUP_UPGRADE_CLEANUP_FAILED") return cleanupFailure(error); note("backup return: cleanup unconfirmed; showing the Backup mode page"); return backupMode(); }
}
