// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("attentionWindow", {
  items: () => ipcRenderer.invoke("attention-window:items"),
  act: (token, action, text) => action === "reply"
    ? ipcRenderer.invoke("attention-window:act", token, action, text)
    : ipcRenderer.invoke("attention-window:act", token, action),
  open: token => ipcRenderer.invoke("attention-window:open", token),
  sendToChief: text => ipcRenderer.invoke("attention-window:send-to-chief", text),
  pauseAutomations: () => ipcRenderer.invoke("attention-window:pause-automations"),
  sendToPinned: text => ipcRenderer.invoke("attention-window:send-to-pinned", text),
  onChange: cb => {
    if (typeof cb !== "function") return () => {};
    const listener = () => cb();
    ipcRenderer.on("attention-window:changed", listener);
    return () => ipcRenderer.removeListener("attention-window:changed", listener);
  },
});
