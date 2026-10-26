// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The short "Setting up your first backup" window shown while Murage is
// closed for the backup's own capture. Before this, turning backups on quit
// the app and the window came back a minute later with nothing in between,
// which looked like a crash. The steps are the real stages of the capture
// (electron/backup-schedule-host.mjs reports them); nothing here is timed.
import path from "node:path";

export const BACKUP_PROGRESS_STEPS = Object.freeze({ references: 1, capture: 2, "artifact-readback": 3, return: 4 });

export function openBackupProgressWindow({ BrowserWindow, baseDir, skin = "dark" }) {
  const win = new BrowserWindow({
    width: 520, height: 420, resizable: false, closable: false, minimizable: false, maximizable: false, title: "Murage",
    backgroundColor: skin === "light" ? "#f7f7f7" : "#0a0a0a", autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false },
  });
  let closing = false;
  win.on?.("close", event => { if (!closing) event.preventDefault(); });
  const loaded = win.loadFile(path.join(baseDir, "recovery", "progress.html"));
  let last = 1; // step 1 is shown as the window opens
  const show = step => { if (win.isDestroyed()) return; void loaded.then(() => win.webContents.executeJavaScript(`window.setBackupProgress(${step},${JSON.stringify(skin)})`)).catch(() => {}); };
  show(1);
  return {
    window: win,
    /** A stage name from the capture; unknown names and steps backwards are ignored. */
    stage(name) { const step = BACKUP_PROGRESS_STEPS[name]; if (!step || step <= last) return; last = step; show(step); },
    close() { try { closing = true; if (!win.isDestroyed()) win.close(); } catch { /* closing is best effort */ } },
  };
}
