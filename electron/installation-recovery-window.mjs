import path from "node:path";
import { pathToFileURL } from "node:url";
import { createInstallationRecoveryController } from "./installation-recovery-controller.mjs";
import { readBackupIdentity } from "./backup-mode.mjs";

const CHANNEL = "installation-recovery:action";
export function openInstallationRecoveryWindow({ BrowserWindow, ipcMain, dialog, baseDir, context, isAvailable, canRestoreSeparate, canCaptureSeparate, runCaptureSeparate, planSeparate, runSeparate, runEncryptedSeparate, encryptedAvailable, retainedDestination, run, retry, openDiagnostics, onClosed }) {
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
  const controller = createInstallationRecoveryController({
    isTrustedSender: trusted, isAvailable, canRestoreSeparate, canCaptureSeparate, runCaptureSeparate, planSeparate, runSeparate, runEncryptedSeparate, encryptedAvailable, retainedDestination, run, retry, openDiagnostics,
    chooseEncryptedBackup: async () => {
      const picked=await dialog.showOpenDialog(win,{title:"Choose an encrypted application-data backup",properties:["openFile"],filters:[{name:"Encrypted Murage backup",extensions:["age"]}]});
      return picked.canceled||picked.filePaths.length!==1?null:{path:picked.filePaths[0],name:path.basename(picked.filePaths[0])};
    },
    chooseEncryptedDestination: async () => {
      const picked=await dialog.showSaveDialog(win,{title:"Save an encrypted application-data backup",defaultPath:"murage-application-backup.age",filters:[{name:"Encrypted Murage backup",extensions:["age"]}]});
      return picked.canceled?null:picked.filePath??null;
    },
    chooseRecoveryIdentity: async () => {
      const picked=await dialog.showOpenDialog(win,{title:"Choose an independent age recovery key file",properties:["openFile"]});
      if(picked.canceled||picked.filePaths.length!==1)return null;
      const file=picked.filePaths[0],recipient=readBackupIdentity(file,context.dataDirectory).recipient;
      return{recipient,readIdentity:async()=>readBackupIdentity(file,context.dataDirectory).identity};
    },
    chooseBackup: async () => {
      const picked = await dialog.showOpenDialog(win, { title: "Choose a Murage installation backup", properties: ["openFile"], filters: [{ name: "Murage backup", extensions: ["zip"] }] });
      if (picked.canceled || picked.filePaths.length !== 1) return null;
      return { path: picked.filePaths[0], name: path.basename(picked.filePaths[0]) };
    },
    chooseDestination: async () => {
      const picked = await dialog.showSaveDialog(win, { title: "Save a new private installation backup", defaultPath: "murage-installation-backup.zip", filters: [{ name: "Murage backup", extensions: ["zip"] }] });
      return picked.canceled ? null : picked.filePath ?? null;
    },
    confirm: async (_event, action, name, destination, installation) => {
      if(action==="backup-encrypted"||action==="restore-encrypted-new"){
        const restore=action==="restore-encrypted-new";
        const answer=await dialog.showMessageBox(win,{type:"warning",buttons:["Cancel",restore?"Restore separately and restart for review":"Create encrypted backup"],defaultId:0,cancelId:0,noLink:true,
          message:restore?`Restore ${name} into a new paused installation?`:"Preserve application data in an encrypted backup?",
          detail:restore?`Original retained unchanged: ${context.dataDirectory}\nNew installation: ${destination}\n\nThe original fidelity data remains in the encrypted backup. The new installation uses a safe paused projection: credentials, native sessions and channel bindings are not reactivated. Murage restarts for review only after successful restore.`:`Destination: ${destination}\n\nOriginal settings may include credentials. They are preserved only inside encrypted fidelity data. Native sessions, VM homes and external folders are excluded. Channel history is retained, but re-pairing is required after restore. Keep an independent recovery key copy; losing it prevents recovery.`});
        return answer.response===1;
      }
      if (action === "capture-separate") {
        const answer = await dialog.showMessageBox(win, {
          type: "warning", buttons: ["Cancel", "Create separate recovery copy"], defaultId: 0, cancelId: 0, noLink: true,
          message: "Recover from data available on this computer?",
          detail: "Original installation: " + context.dataDirectory + "\n\nPrivate recovery copy: " + destination + "\nNew installation: " + installation +
            "\n\nWindows will ask for one-time administrator approval. Murage will take a point-in-time snapshot without changing the original or its ownership records. Work in progress may be incomplete, and later changes are not included. The copy must pass validation before Murage restarts into paused review. Engines, schedules and memory stay off, and connections must be re-established. Cancelling leaves the startup selection unchanged.",
        });
        return answer.response === 1;
      }
      if (action === "restore-separate") {
        const answer = await dialog.showMessageBox(win, {
          type: "warning", buttons: ["Cancel", "Restore to separate installation"], defaultId: 0, cancelId: 0, noLink: true,
          message: "Restore " + name + " to a separate installation?",
          detail: "Original retained unchanged: " + context.dataDirectory + "\n\nNew installation: " + destination +
            "\n\nOnly the selected backup snapshot is restored. Newer conversations and deletion records in the original are not copied. This requires an existing valid Murage backup; it does not copy a live installation or clear ownership records. Murage will restart into recovery review. Engines, schedules and automatic work remain disabled, and connections must be re-established.",
        });
        return answer.response === 1;
      }
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
