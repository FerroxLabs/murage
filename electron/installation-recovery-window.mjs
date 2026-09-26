import path from "node:path";
import { pathToFileURL } from "node:url";
import { createInstallationRecoveryController } from "./installation-recovery-controller.mjs";
import { readBackupIdentity } from "./backup-mode.mjs";

const CHANNEL = "installation-recovery:action";
export function openInstallationRecoveryWindow({ BrowserWindow, ipcMain, dialog, baseDir, context, isAvailable, canRestoreSeparate, canCaptureSeparate, runCaptureSeparate, planSeparate, runSeparate, runEncryptedSeparate, encryptedAvailable, verifyEncrypted, retainedDestination, run, retry, openDiagnostics, onClosed }) {
  const page = path.join(baseDir, "recovery", "index.html");
  const pageUrl = pathToFileURL(page).href;
  const win = new BrowserWindow({
    width: 760, height: 690, minWidth: 390, minHeight: 520, title: context.backupMode ? "Murage Backup mode" : "Murage recovery",
    backgroundColor: context.skin === "light" ? "#f7f7f7" : "#0a0a0a",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, preload: path.join(baseDir, "recovery", "preload.cjs") },
  });
  const trusted = event => !win.isDestroyed() && event.sender === win.webContents &&
    event.senderFrame === win.webContents.mainFrame && event.senderFrame?.url === pageUrl;
  const verifyIdentityAccess = async event => {
    if (!trusted(event) || !isAvailable()) throw Error("RECOVERY_OWNERSHIP_REQUIRED");
    await verifyEncrypted?.();
    if (!trusted(event) || !isAvailable() || encryptedAvailable?.() !== true) throw Error("RECOVERY_OWNERSHIP_REQUIRED");
  };
  const controller = createInstallationRecoveryController({
    isTrustedSender: trusted, isAvailable, canRestoreSeparate, canCaptureSeparate, runCaptureSeparate, planSeparate, runSeparate, runEncryptedSeparate, encryptedAvailable, retainedDestination, run, retry, openDiagnostics,
    chooseEncryptedBackup: async () => {
      const picked=await dialog.showOpenDialog(win,{title:"Choose the backup to restore",properties:["openFile"],filters:[{name:"Encrypted Murage backup",extensions:["age"]}]});
      return picked.canceled||picked.filePaths.length!==1?null:{path:picked.filePaths[0],name:path.basename(picked.filePaths[0])};
    },
    chooseEncryptedDestination: async () => {
      const picked=await dialog.showSaveDialog(win,{title:"Save a backup",defaultPath:"murage-application-backup.age",filters:[{name:"Encrypted Murage backup",extensions:["age"]}]});
      return picked.canceled?null:picked.filePath??null;
    },
    chooseRecoveryIdentity: async event => {
      const picked=await dialog.showOpenDialog(win,{title:"Choose your recovery key file",properties:["openFile"]});
      if(picked.canceled||picked.filePaths.length!==1)return null;
      await verifyIdentityAccess(event);
      const file=picked.filePaths[0],recipient=readBackupIdentity(file,context.dataDirectory).recipient;
      return{recipient,readIdentity:async()=>{await verifyIdentityAccess(event);return readBackupIdentity(file,context.dataDirectory).identity;}};
    },
    chooseBackup: async () => {
      const picked = await dialog.showOpenDialog(win, { title: "Choose an older .zip recovery file", properties: ["openFile"], filters: [{ name: "Murage backup", extensions: ["zip"] }] });
      if (picked.canceled || picked.filePaths.length !== 1) return null;
      return { path: picked.filePaths[0], name: path.basename(picked.filePaths[0]) };
    },
    chooseDestination: async () => {
      const picked = await dialog.showSaveDialog(win, { title: "Save a .zip recovery file", defaultPath: "murage-installation-backup.zip", filters: [{ name: "Murage backup", extensions: ["zip"] }] });
      return picked.canceled ? null : picked.filePath ?? null;
    },
    confirm: async (_event, action, name, destination, installation) => {
      if(action==="backup-encrypted"||action==="restore-encrypted-new"){
        const restore=action==="restore-encrypted-new";
        const answer=await dialog.showMessageBox(win,{type:"warning",buttons:["Cancel",restore?"Restore and restart":"Make backup"],defaultId:0,cancelId:0,noLink:true,
          message:restore?"Restore this backup into a new folder?":"Make an encrypted backup of your Murage data?",
          detail:restore?`Backup: ${name}\nYour current data stays as it is: ${context.dataDirectory}\nThe restored copy goes to: ${destination}\n\nWhen the restore has finished, Murage restarts so you can review the restored copy. It comes back paused: AI engines, schedules and messaging apps stay off until you connect them again.`:`Save to: ${destination}\n\nThe backup is encrypted with your recovery key and holds your settings, bots, conversations, files and channel history. It does not hold the local VM or folders outside Murage. Keep a copy of your recovery key somewhere else: without it the backup can't be opened.`});
        return answer.response===1;
      }
      if (action === "capture-separate") {
        const answer = await dialog.showMessageBox(win, {
          type: "warning", buttons: ["Cancel", "Make recovery copy"], defaultId: 0, cancelId: 0, noLink: true,
          message: "Make a recovery copy from the data on this computer?",
          detail: "Your current data: " + context.dataDirectory + "\n\nRecovery copy: " + destination + "\nRestored copy goes to: " + installation +
            "\n\nWindows asks once for administrator approval. Murage copies your data as it is right now without changing the original. Unfinished work may be missing. The copy is checked, then Murage restarts so you can review it. AI engines, schedules and memory stay off, and you connect apps again. Cancel changes nothing.",
        });
        return answer.response === 1;
      }
      if (action === "restore-separate") {
        const answer = await dialog.showMessageBox(win, {
          type: "warning", buttons: ["Cancel", "Restore into a new folder"], defaultId: 0, cancelId: 0, noLink: true,
          message: "Restore " + name + " into a new folder?",
          detail: "Your current data stays as it is: " + context.dataDirectory + "\n\nThe restored copy goes to: " + destination +
            "\n\nOnly what is in the backup comes back; anything newer is not copied. Murage restarts so you can review the restored copy. AI engines, schedules and automatic work stay off, and you connect apps again.",
        });
        return answer.response === 1;
      }
      const answer = await dialog.showMessageBox(win, {
        type: "warning", buttons: ["Cancel", action === "activate" ? "Open restored copy" : action === "restore" ? "Restore backup" : "Undo restore"], defaultId: 0, cancelId: 0, noLink: true,
        message: action === "activate" ? "Open the restored copy?" : action === "restore" ? "Restore " + name + "?" : "Undo the restore and go back to your previous data?",
        detail: action === "activate" ? "Murage restarts with the restored copy. AI engines and schedules stay off and no unfinished work restarts. Turn engines on and reconnect your phone and messaging apps in Settings when you're ready." : action === "restore"
          ? "Your current data is kept separately. Restored bots and schedules stay paused until you review them, and you connect AI engines again."
          : "Your previous data is put back. The restored copy is kept separately; nothing is deleted.",
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
