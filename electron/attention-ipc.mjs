// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOTIFY-EVERYWHERE-1019 section 5.3 (S3): the IPC gate for the attention windows (flyout, popover, popup, pill, bubble, dock). It is a
// SEPARATE gate from the owned-main gate (main-ipc-trust.mjs stays byte-for-byte unchanged): a registry of attention window ids -> kind,
// and a call is honoured only from a registered window's TOP frame, at its exact file URL (computed by main, packaged or dev), on a
// channel allowed for that kind. Tokens are honoured only from the window they were minted for: this gate passes the SENDER's window id to
// the action path as context and never reads one from the payload. Pure: Electron objects arrive as plain event shapes.

const TOKEN = /^[0-9a-f]{32}$/;
const KINDS = new Set(["flyout", "popover", "popup", "pill", "bubble", "dock"]);
const COMMON = ["attention-window:items", "attention-window:act", "attention-window:open"];
const BY_KIND = {
  flyout: [...COMMON, "attention-window:send-to-chief", "attention-window:pause-automations"],
  popover: [...COMMON, "attention-window:send-to-chief", "attention-window:pause-automations"],
  popup: [...COMMON, "attention-window:send-to-chief", "attention-window:pause-automations"],
  pill: COMMON,
  bubble: [...COMMON, "attention-window:send-to-pinned"],
  dock: COMMON,
};
export const ATTENTION_CHANNELS = Object.freeze({
  all: Object.freeze([...new Set(Object.values(BY_KIND).flat())]),
  byKind: Object.freeze(Object.fromEntries(Object.entries(BY_KIND).map(([kind, list]) => [kind, Object.freeze([...list])]))),
});

/** Shape checks for one call's arguments. Sends are 1..4000 characters; Reply text is validated again by the action path (cleanReply). */
export function validateAttentionArgs(channel, args) {
  const bad = { ok: false, reason: "args" };
  switch (channel) {
    case "attention-window:items": return args.length === 0 ? { ok: true } : bad;
    case "attention-window:open": return args.length === 1 && typeof args[0] === "string" && TOKEN.test(args[0]) ? { ok: true } : bad;
    case "attention-window:act": {
      const [token, action, text] = args;
      if (typeof token !== "string" || !TOKEN.test(token)) return bad;
      if (action !== "allow" && action !== "deny" && action !== "reply") return bad;
      if (action === "reply") return typeof text === "string" && text.length >= 1 && text.length <= 4000 && args.length === 3 ? { ok: true } : bad;
      return args.length === 2 ? { ok: true } : bad;
    }
    case "attention-window:send-to-chief":
    case "attention-window:send-to-pinned":
      return args.length === 1 && typeof args[0] === "string" && args[0].length >= 1 && args[0].length <= 4000 ? { ok: true } : bad;
    case "attention-window:pause-automations": return args.length === 0 ? { ok: true } : bad;
    default: return bad;
  }
}

/** deps: { urlFor(kind) -> the exact file URL main loaded into that kind of window, or null }. */
export function createAttentionIpc({ urlFor }) {
  const windows = new Map(); // webContents id -> kind
  const ipc = {
    register(windowId, kind) {
      if (!KINDS.has(kind)) throw new Error(`unknown attention window kind: ${kind}`);
      windows.set(windowId, kind);
    },
    unregister(windowId) { windows.delete(windowId); },
    size: () => windows.size,
    /** event: Electron's IpcMainInvokeEvent shape ({ sender: {id}, senderFrame: {url, parent} }). */
    authorize(event, channel) {
      const frame = event?.senderFrame;
      if (!frame || typeof frame.url !== "string") return { ok: false, reason: "frame" };
      if (frame.parent) return { ok: false, reason: "subframe" };
      const windowId = event?.sender?.id;
      const kind = windows.get(windowId);
      if (!kind) return { ok: false, reason: "unregistered" };
      const expected = urlFor(kind);
      if (typeof expected !== "string" || frame.url !== expected) return { ok: false, reason: "url" };
      if (!BY_KIND[kind].includes(channel)) return { ok: false, reason: "channel" };
      return { ok: true, kind, windowId };
    },
    /**
     * Registers every attention-window:* channel on `ipcMain`. handlers: { items(info), act(info, token, action, text), open(info, token),
     * sendToChief(info, text), pauseAutomations(info), sendToPinned(info, text) }; info = { kind, windowId } from THIS gate only.
     */
    install(ipcMain, handlers) {
      const wire = (channel, run) => ipcMain.handle(channel, async (event, ...args) => {
        const verdict = ipc.authorize(event, channel);
        if (!verdict.ok) return { ok: false, reason: "refused" };
        if (!validateAttentionArgs(channel, args).ok) return { ok: false, reason: "refused" };
        try { return await run({ kind: verdict.kind, windowId: verdict.windowId }, ...args); } catch { return { ok: false, reason: "error" }; }
      });
      wire("attention-window:items", info => handlers.items(info));
      wire("attention-window:act", (info, token, action, text) => handlers.act(info, token, action, text));
      wire("attention-window:open", (info, token) => handlers.open(info, token));
      wire("attention-window:send-to-chief", (info, text) => handlers.sendToChief(info, text));
      wire("attention-window:pause-automations", info => handlers.pauseAutomations(info));
      wire("attention-window:send-to-pinned", (info, text) => handlers.sendToPinned(info, text));
    },
  };
  return ipc;
}
