// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The short backup window shown while Murage is closed for the backup's own
// capture ("Setting up your first backup", "Backing up your workspace" or
// "Backing up before the update", by kind; recovery/progress.js words it). Before this, turning backups on quit
// the app and the window came back a minute later with nothing in between,
// which looked like a crash. The steps are the real stages of the capture
// (electron/backup-schedule-host.mjs reports them); nothing here is timed.
import path from "node:path";

export const BACKUP_PROGRESS_STEPS = Object.freeze({ references: 1, capture: 2, "artifact-readback": 3, return: 4 });

export const BACKUP_PROGRESS_KINDS = Object.freeze(["first", "backup", "update"]);

/** Where each step of the worker sits: the window's step, what it shows, and the bar's range in percent. */
const WORKER_VIEWS = Object.freeze({
  records: [2, "copy", 25, 26], "database-read": [2, "copy", 26, 30], "source-recheck": [2, "copy", 30, 31], "database-check": [2, "copy", 31, 32],
  "database-copy": [2, "copy", 32, 36], "database-clean": [2, "copy", 36, 37], "database-verify": [2, "copy", 37, 38], "database-digest": [2, "copy", 38, 39], ledger: [2, "copy", 39, 40],
  inventory: [2, "prepare", 40, 42], encrypt: [2, "encrypt", 42, 60],
  readback: [3, "check", 60, 70], "readback-entries": [3, "check", 70, 73], "readback-hash": [3, "check", 73, 74], flush: [3, "check", 74, 75], publish: [3, "check", 75, 75], done: [3, "check", 75, 75],
});

/** What the window shows for a note from the worker, or null. */
export function backupWorkerView(note) {
  const view = note && typeof note === "object" && Object.hasOwn(WORKER_VIEWS, note.step) ? WORKER_VIEWS[note.step] : null;
  if (!view) return null;
  const [step, phase, from, to] = view;
  const counted = Number.isSafeInteger(note.done) && Number.isSafeInteger(note.total) && note.total > 0 && note.done >= 0;
  const share = counted ? Math.min(1, note.done / note.total) : 0;
  return { step, phase, percent: Math.round(from + (to - from) * share), ...(counted ? { done: note.done, total: note.total } : {}) };
}

/** Which heading the window shows, from the coordinator's status: a backup
 * before an in-app update, the very first backup (no verified one yet), or any
 * other backup (Back up now, daily). Anything unreadable reads as "backup". */
export function backupProgressKind(status) {
  const occurrence = typeof status?.job?.occurrence === "string" ? status.job.occurrence : "";
  if (/^\d+:upgrade:/.test(occurrence)) return "update";
  if (status && typeof status === "object" && !status.lastVerified) return "first";
  return "backup";
}

export function openBackupProgressWindow({ BrowserWindow, baseDir, skin = "dark", kind = "backup" }) {
  const win = new BrowserWindow({
    width: 520, height: 420, resizable: false, closable: false, minimizable: false, maximizable: false, title: "Murage",
    backgroundColor: skin === "light" ? "#f7f7f7" : "#0a0a0a", autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false },
  });
  let closing = false;
  win.on?.("close", event => { if (!closing) event.preventDefault(); });
  const shown = BACKUP_PROGRESS_KINDS.includes(kind) ? kind : "backup";
  const loaded = win.loadFile(path.join(baseDir, "recovery", "progress.html"), { query: { kind: shown } });
  let last = 1; // step 1 is shown as the window opens
  const show = step => { if (win.isDestroyed()) return; void loaded.then(() => win.webContents.executeJavaScript(`window.setBackupProgress(${step},${JSON.stringify(skin)})`)).catch(() => {}); };
  show(1);
  /** The app's own teardown. The window stays non-closable for the person
   * while the backup runs, and a non-closable window ignores close() on
   * macOS and cancels app.quit() everywhere (the close handler above), so
   * the app destroys it instead: no close event, nothing to cancel. */
  const destroy = () => { closing = true; try { if (!win.isDestroyed()) win.destroy(); } catch { /* already gone */ } };
  return {
    window: win,
    /** A stage name from the capture; unknown names and steps backwards are ignored. */
    stage(name) { const step = BACKUP_PROGRESS_STEPS[name]; if (!step || step <= last) return; last = step; show(step); },
    /** A note from the worker. "Checking" starts when the worker's own check
     * does, so the later stage("artifact-readback") is then a repeat. */
    worker(note) {
      const view = backupWorkerView(note);
      if (!view || view.step < last || win.isDestroyed()) return;
      if (view.step > last) { last = view.step; show(view.step); }
      void loaded.then(() => win.webContents.executeJavaScript(`window.setBackupDetail(${JSON.stringify(view)})`)).catch(() => {});
    },
    destroy,
    close: destroy,
  };
}
