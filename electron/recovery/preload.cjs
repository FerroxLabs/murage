const { contextBridge, ipcRenderer } = require("electron");
// This window deliberately has no normal muragebox bridge or raw IPC access.
contextBridge.exposeInMainWorld("murageRecovery", {
  action: (action, selectionId) => ipcRenderer.invoke("installation-recovery:action",
    selectionId === undefined ? { action } : action === "activate" ? { action, reviewId: selectionId } : { action, selectionId }),
});
