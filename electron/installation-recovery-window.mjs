import path from "node:path";
import { pathToFileURL } from "node:url";
import { createInstallationRecoveryController } from "./installation-recovery-controller.mjs";

const CHANNEL = "installation-recovery:action";
export function openInstallationRecoveryWindow({ BrowserWindow, ipcMain, dialog, baseDir, context, isAvailable, run, retry, openDiagnostics, onClosed }) {
  const page = path.join(baseDir, "recovery", "index.html");
  const pageUrl = pathToFileURL(page).href;
  const win = new BrowserWindow({
    width: 760, height: 690, minWidth: 460, minHeight: 520, title: "Murage recovery",
    backgroundColor: context.skin === "light" ? "#f7f7f7" : "#0a0a0a",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, preload: path.join(baseDir, "recovery", "preload.cjs") },
  });
  const trusted = event => !win.isDestroyed() && event.sender === win.webContents &&
    event.senderFrame === win.webContents.mainFrame && event.senderFrame?.url === pageUrl;
  const controller = createInstallationRecoveryController({
    isTrustedSender: trusted, isAvailable, run, retry, openDiagnostics,
    chooseBackup: async () => {
      const picked = await dialog.showOpenDialog(win, { title: "Choose a Murage installation backup", properties: ["openFile"], filters: [{ name: "Murage backup", extensions: ["zip"] }] });
      if (picked.canceled || picked.filePaths.length !== 1) return null;
      return { path: picked.filePaths[0], name: path.basename(picked.filePaths[0]) };
    },
    chooseDestination: async () => {
      const picked = await dialog.showSaveDialog(win, { title: "Save a new private installation backup", defaultPath: "murage-installation-backup.zip", filters: [{ name: "Murage backup", extensions: ["zip"] }] });
      return picked.canceled ? null : picked.filePath ?? null;
    },
    confirm: async (_event, action, name) => {
      const answer = await dialog.showMessageBox(win, {
        type: "warning", buttons: ["Cancel", action === "activate" ? "Open reviewed installation" : action === "restore" ? "Restore backup" : "Undo restore"], defaultId: 0, cancelId: 0, noLink: true,
        message: action === "activate" ? "Open this reviewed installation?" : action === "restore" ? "Restore " + name + "?" : "Return to the retained installation?",
        detail: action === "activate" ? "Murage will restart. Engines and schedules remain disabled; no pending work is resumed. Enable engines and reconnect devices deliberately in Settings." : action === "restore"
          ? "Your current installation will be retained separately. Restored agents and schedules will remain paused for review. Provider connections must be re-established."
          : "The restored candidate will be retained separately. The previous installation will be put back; no retained data is deleted.",
      });
      return answer.response === 1;
    },
  });
  ipcMain.handle(CHANNEL, async (event, input) => ({ ...await controller.handle(event, input), context }));
  win.webContents.on("will-navigate", event => event.preventDefault());
  win.webContents.on("will-attach-webview", event => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.once("closed", () => { ipcMain.removeHandler(CHANNEL); onClosed?.(); });
  const loaded = win.loadFile(page);
  return { window: win, loaded };
}
