// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOTIFY-EVERYWHERE-1019 S6 + S9 composition (NOTIFY19f). One place that builds the attention windows' gate, the card/roster host,
// the tray panel and the floating bubble/dock, and wires their effects to main. Electron, the actions authority and every read are
// injected, so the composition runs under test with fakes; main.mjs supplies the real ones.
//
//   gate     createAttentionIpc over ONE loadUrlFor (the gate's urlFor and every window's loadURL are the same function).
//            Every window registered through it is forgotten by the host when it closes (host.invalidateWindow): tokens never outlive a window.
//   host     createAttentionWindowHost; readItems(kind) = itemsFromAttention over the current home's /api/desktop/attention and
//            /api/desktop/tray reads and the previews preference, captured together.
//   panel    createTrayPanel, built the first time it is asked for (the tray icon does not exist until the lifecycle creates it).
//   float    createFloatWindows + createFloatSurface (the router's bubble rung, handed to createAttentionMain as showSurface/closeSurface).
//
// The shared host and items reader own refresh ordering and draft continuity for every window.
import { createAttentionIpc } from "./attention-ipc.mjs";
import { createAttentionWindowHost } from "./attention-window-host.mjs";
import { itemsFromAttention } from "./attention-items.mjs";
import { createFloatSurface, createFloatWindows } from "./float-windows.mjs";
import { createTrayPanel } from "./tray-panel.mjs";

/** The window-kind to outside-surface map (shared/outside-limits.mjs): the tray panel kinds are all "flyout". */
export const surfaceForKind = kind => (kind === "bubble" || kind === "dock" ? kind : "flyout");

export function createAttentionSurfaces({ electron, ipcMain, platform, tray, actions, prefs, capabilities, presence, presenceWatch,
  transportFor, readLocal, readPreviews, openApp, openTarget, sendToBot, pauseAutomations, loadUrlFor, log = () => {} }) {
  const gate = createAttentionIpc({ urlFor: loadUrlFor });
  const registered = new Set();
  let host = null, panel = null, disposed = false, stopWatch = null, roster = [];
  const say = line => { try { log(line); } catch { /* logging never interrupts a surface */ } };

  const baseRegister = gate.register, baseUnregister = gate.unregister;
  gate.register = (id, kind) => { baseRegister(id, kind); registered.add(id); };
  gate.unregister = id => { baseUnregister(id); registered.delete(id); host?.invalidateWindow(id); };

  const readItems = async () => {
    const [attention, trayRead, previews] = await Promise.all([readLocal("/api/desktop/attention"), readLocal("/api/desktop/tray"), readPreviews()]);
    return itemsFromAttention({ attention, tray: trayRead, home: "local", previews: previews === true, receipts: [] });
  };

  const rosterFrom = (trayRead, attention) => {
    const needs = new Set([...(attention?.open ?? []), ...(trayRead?.items ?? []).filter(row => row?.reconnectIncidentId)].map(row => row?.botId).filter(Boolean));
    const working = new Set((trayRead?.working ?? []).map(row => row?.botId).filter(Boolean));
    return (Array.isArray(trayRead?.bots) ? trayRead.bots : []).filter(bot => bot && typeof bot.id === "string").map(bot =>
      ({ botId: bot.id, name: typeof bot.name === "string" ? bot.name : "", state: needs.has(bot.id) ? "needs-you" : working.has(bot.id) ? "working" : "idle" }));
  };

  const floatWindows = createFloatWindows({
    BrowserWindow: electron.BrowserWindow, screen: electron.screen, attentionIpc: gate, loadUrlFor, platform, capabilities, prefs,
    presence: () => { const q = presence() ?? {}; return { fullscreen: q.fullscreen === true, sharing: q.sharing === true, locked: q.locked === true }; },
    botStates: () => roster,
  });

  host = createAttentionWindowHost({
    actions, floatWindows, surfaceFor: surfaceForKind, log,
    transportFor: entry => transportFor(entry.home),
    readItems,
    openTarget: async target => {
      if (!target || typeof target !== "object") return;
      await openApp();
      if (target.kind === "app") return;
      if (target.kind === "bot") { if (typeof target.botId === "string") openTarget({ kind: "compose", botId: target.botId }); return; }
      if (target.kind === "connector") { openTarget({ kind: "connector", threadId: target.threadId, reconnectIncidentId: target.reconnectIncidentId }); return; }
      if (target.kind === "approval") openTarget({ kind: "approval", threadId: target.threadId, messageId: target.messageId, ...(target.botId ? { botId: target.botId } : {}) });
    },
    sendToChief: async text => sendToBot("chief", text),
    sendToPinned: async text => sendToBot("pinned", text),
    pauseAutomations: async () => pauseAutomations(),
  });
  gate.install(ipcMain, host);

  const floatSurface = createFloatSurface({ floatWindows, host });

  /** Windows ask for fresh content through their gated items(); this only tells them to. */
  function changed() {
    if (disposed) return;
    for (const win of electron.BrowserWindow.getAllWindows?.() ?? []) {
      let id = null;
      try { id = win.webContents?.id ?? null; } catch { id = null; }
      if (id !== null && registered.has(id)) { try { win.webContents.send("attention-window:changed"); } catch { /* a closing window */ } }
    }
  }

  /** Preference, roster or presence changed: read the roster, then let the floating windows follow, and poll presence only while one is visible. */
  async function sync() {
    if (disposed) return;
    // Nothing floating is wanted and nothing floats: no roster read, no manager work (a preference or presence change calls this again).
    if (!floatWanted() && floatWindows.status().windows.length === 0) { releaseWatch(); changed(); return; }
    try {
      const [trayRead, attention] = await Promise.all([readLocal("/api/desktop/tray"), readLocal("/api/desktop/attention")]);
      roster = rosterFrom(trayRead, attention);
    } catch { roster = []; }
    if (disposed) return;
    try { await floatWindows.sync(); } catch (error) { say(`attention-surfaces: float sync failed ${error?.message ?? error}`); }
    // Presence is watched for as long as a float is wanted OR one exists: a float hidden by fullscreen or sharing must see that end, and
    // only the watch can tell it (no held card is there to keep one open).
    // The preference is read again here: the awaits above let a later sync switch floats off, and this one must not take the watch back.
    if (disposed) return;
    const wantedNow = floatWanted(), existing = floatWindows.status().windows.length > 0;
    if ((wantedNow || existing) && !stopWatch) stopWatch = presenceWatch?.() ?? null;
    else if (!wantedNow && !existing) releaseWatch();
    changed();
  }
  function floatWanted() {
    try { const state = prefs(); return state?.surfaces?.bubble === true || state?.surfaces?.dock === true; } catch { return false; }
  }
  function releaseWatch() { if (stopWatch) { const stop = stopWatch; stopWatch = null; try { stop(); } catch { /* released */ } } }

  /** A watcher `bot` frame: the dot follows without a roster read. */
  function botFrame(frame) {
    if (disposed || !frame || typeof frame.botId !== "string") return;
    // A frame that carries no state (the inbox watcher's bot ids) says nothing about the dot: it must not paint idle over the roster's state.
    if (frame.state !== "working" && frame.state !== "needs-you" && frame.state !== "idle") return;
    const state = frame.state;
    try { floatWindows.setBotState(frame.botId, state); } catch { /* an unknown bot is ignored by the manager */ }
  }

  /** Privacy change, home change or teardown: every window forgets every card and token it holds. */
  function invalidateAll() {
    for (const id of [...registered]) host.invalidateWindow(id);
    changed();
  }

  const realPanel = () => (panel ??= createTrayPanel({ BrowserWindow: electron.BrowserWindow, tray, screen: electron.screen, platform, attentionIpc: gate, loadUrlFor,
    presence: () => presence() }));
  const trayPanel = {
    show: bounds => realPanel().show(bounds),
    toggle: bounds => realPanel().toggle(bounds),
    hide: () => panel?.hide(),
    destroy: () => panel?.destroy(),
    isOpen: () => panel?.isOpen() === true,
  };

  function dispose() {
    disposed = true;
    if (stopWatch) { try { stopWatch(); } catch { /* released */ } stopWatch = null; }
    try { floatWindows.destroy(); } catch { /* windows already gone */ }
    try { panel?.destroy(); } catch { /* window already gone */ }
    for (const id of [...registered]) host.invalidateWindow(id);
  }

  return { gate, host, floatWindows, floatSurface, trayPanel, sync, changed, botFrame, invalidateAll, dispose, readItems };
}
