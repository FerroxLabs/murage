// B3 WP4: the Cloud-home window's own bridge. It is NOT the main preload and exposes none of window.muragebox:
// a page on murage-home:// gets `window.muragecloud` with exactly six things, each a channel classed cloud-safe or
// cloud-only (ipc-channel-classes.mjs) and re-checked in main before its listener runs:
//   setUnreadCount          desktop:unread-count          (cloud-safe: a number for the Dock/taskbar badge)
//   approvalNotifications   approval-notification:*       (cloud-safe: an OS notification main validates against the HOME)
//   reachable               cloud-home:reachable          (cloud-only: is the home answering right now)
//   disconnectThisComputer  cloud-home:disconnect-this    (cloud-only: revoke this computer from this window's own home)
//   openExternal            desktop:open-external         (cloud-safe: an https link in the default browser; main validates it)
//   homeId, platform        constants
// Sandboxed preloads cannot require sibling files, so everything is inline. It exposes nothing unless the document
// really is murage-home://<the home main opened this window for>/.
const { contextBridge, ipcRenderer } = require("electron");

const ARGUMENT = "--murage-cloud-home=";

function expectedHomeId() {
  const argument = (process.argv ?? []).find((value) => typeof value === "string" && value.startsWith(ARGUMENT));
  const id = argument ? argument.slice(ARGUMENT.length) : "";
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(id) ? id : null;
}

function documentIsOurHome(homeId) {
  try {
    return Boolean(homeId) && globalThis.location?.protocol === "murage-home:" && globalThis.location?.hostname === homeId;
  } catch {
    return false;
  }
}

/** Main's error text is plain copy; Electron's "Error invoking remote method ..." wrapper is taken off. */
function plainError(error) {
  throw new Error(String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
}

const homeId = expectedHomeId();
if (documentIsOurHome(homeId)) {
  contextBridge.exposeInMainWorld("muragecloud", {
    homeId,
    platform: process.platform,
    setUnreadCount: (count) => ipcRenderer.send("desktop:unread-count", count),
    approvalNotifications: {
      show: (payload) => ipcRenderer.invoke("approval-notification:show", payload),
      onOpen: (callback) => {
        const handler = (_event, target) => callback(target);
        ipcRenderer.on("approval-notification:open", handler);
        return () => ipcRenderer.removeListener("approval-notification:open", handler);
      },
    },
    reachable: () => ipcRenderer.invoke("cloud-home:reachable"),
    disconnectThisComputer: () => ipcRenderer.invoke("cloud-home:disconnect-this").catch(plainError),
    openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url).catch(plainError),
  });
}
