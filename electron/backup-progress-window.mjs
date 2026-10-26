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
    destroy,
    close: destroy,
  };
}
