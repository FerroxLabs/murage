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

const ATTENTION_SESSION = /^[a-z0-9]{16,64}$/;
const ATTENTION_REFS_MAX = 288; // LEDGER_MAX = CAP_HOME + 32 (NOTIFY-EVERYWHERE-1019 S3R R4)
const ATTENTION_ICON_MAX = 65536; // a data:image/png of at most 64 KB; main checks the same bound
const attentionRef = (value) => typeof value === "string" && value.length > 0 && value.length <= 64;
const attentionGen = (value) => Number.isSafeInteger(value) && value >= 0;
const attentionText = (value, max) => typeof value === "string" && value.length <= max;
/** main -> window push: bounded, session-addressed, nothing else passes (S3R R3). */
const attentionMessage = (value) => {
  if (!value || typeof value !== "object" || typeof value.session !== "string" || !ATTENTION_SESSION.test(value.session)) return null;
  if (value.type === "show" && attentionRef(value.ref) && attentionGen(value.gen) && typeof value.previews === "boolean") return { type: "show", session: value.session, ref: value.ref, gen: value.gen, previews: value.previews };
  if (value.type === "close" && attentionRef(value.ref) && attentionGen(value.gen)) return { type: "close", session: value.session, ref: value.ref, gen: value.gen };
  if (value.type === "previews" && typeof value.previews === "boolean") return { type: "previews", session: value.session, previews: value.previews };
  return null;
};
/** window -> main: the new delivery shapes are checked here and again in main (S3R R3 bounds). Anything malformed never leaves the window. */
const attentionHello = (value) => (value && typeof value === "object" && typeof value.session === "string" && ATTENTION_SESSION.test(value.session) ? { session: value.session } : null);
const attentionPresent = (value) => {
  if (!value || typeof value !== "object" || typeof value.session !== "string" || !ATTENTION_SESSION.test(value.session) || !attentionRef(value.ref) || !attentionGen(value.gen)) return null;
  if (!attentionText(value.title, 256) || !attentionText(value.body, 1024)) return null;
  const out = { session: value.session, ref: value.ref, gen: value.gen, title: value.title, body: value.body };
  for (const field of ["botId", "threadId"]) if (value[field] !== undefined) { if (!attentionText(value[field], 512)) return null; out[field] = value[field]; }
  for (const field of ["privatePreview", "silent"]) if (value[field] !== undefined) { if (typeof value[field] !== "boolean") return null; out[field] = value[field]; }
  if (value.icon !== undefined) {
    if (typeof value.icon !== "string" || value.icon.length > ATTENTION_ICON_MAX || !value.icon.startsWith("data:image/png;base64,")) return null;
    out.icon = value.icon;
  }
  return out;
};
const attentionGone = (value) => (value && typeof value === "object" && typeof value.session === "string" && ATTENTION_SESSION.test(value.session) && attentionRef(value.ref) && attentionGen(value.gen) ? { session: value.session, ref: value.ref, gen: value.gen } : null);
const attentionFreed = (value) => {
  if (!value || typeof value !== "object" || typeof value.session !== "string" || !ATTENTION_SESSION.test(value.session) || !Array.isArray(value.refs) || value.refs.length > ATTENTION_REFS_MAX || !value.refs.every(attentionRef)) return null;
  return { session: value.session, refs: [...value.refs] };
};

const homeId = expectedHomeId();
if (documentIsOurHome(homeId)) {
  contextBridge.exposeInMainWorld("muragecloud", {
    homeId,
    platform: process.platform,
    setUnreadCount: (count) => ipcRenderer.send("desktop:unread-count", count),
    attention: {
      hello: (payload) => { const checked = attentionHello(payload); return checked ? ipcRenderer.invoke("cloud-attention:hello", checked) : Promise.resolve({ ok: false }); },
      offer: (payload) => ipcRenderer.invoke("cloud-attention:offer", payload),
      visible: (payload) => ipcRenderer.invoke("cloud-attention:visible", payload),
      present: (payload) => { const checked = attentionPresent(payload); return checked ? ipcRenderer.invoke("cloud-attention:present", checked) : Promise.resolve({ ok: false }); },
      gone: (payload) => { const checked = attentionGone(payload); return checked ? ipcRenderer.invoke("cloud-attention:gone", checked) : Promise.resolve({ ok: false }); },
      freed: (payload) => { const checked = attentionFreed(payload); if (checked) ipcRenderer.send("cloud-attention:freed", checked); },
      onShow: (callback) => {
        const handler = (_event, value) => { const checked = attentionMessage(value); if (checked) callback(checked); };
        ipcRenderer.on("cloud-attention:show", handler);
        return () => ipcRenderer.removeListener("cloud-attention:show", handler);
      },
    },
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
