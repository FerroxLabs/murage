// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { fileURLToPath } from "node:url";

const PRELOAD = fileURLToPath(new URL("./attention-window-preload.cjs", import.meta.url));
export const WAYLAND_REASON = "Needs an X11 session: Wayland cannot keep it on top.";
const KINDS = ["bubble", "dock"];
const STATES = new Set(["idle", "working", "needs-you"]);
const HOUR = 3600000;

/** Main-only roster: botStates() returns [{botId, name, state, hidden?, visible?}].
 * Watcher frames call setBotState(botId, "idle" | "working" | "needs-you").
 * sync() follows preference, roster and presence changes. No polling is owned here.
 * loadUrlFor must be the exact function supplied to createAttentionIpc.
 * unregister MUST invalidate the attention host's tokens, including on privacy hides.
 */
export function createFloatWindows({ BrowserWindow, screen, attentionIpc, loadUrlFor, platform,
  capabilities = () => null, prefs, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  presence = () => null, botStates = () => [] }) {
  const windows = new Map(), states = new Map(), hidden = new Map();
  let stopped = false, prefKey = null, displayTimer = null;
  const preferences = () => { try { return prefs() ?? {}; } catch { return {}; } };
  const available = kind => {
    try {
      const cap = capabilities();
      return ["darwin", "win32", "linux"].includes(platform) &&
        (platform !== "linux" || cap?.session === "x11") && cap?.surfaces?.[kind]?.available !== false;
    } catch { return false; }
  };
  const privateNow = () => {
    try {
      const value = presence();
      return !value || [value.fullscreen, value.sharing, value.locked].some(flag => flag !== false);
    } catch { return true; }
  };
  const roster = () => {
    try {
      const rows = botStates();
      if (!Array.isArray(rows)) return [];
      const seen = new Set();
      return rows.filter(row => {
        if (!row || typeof row.botId !== "string" || seen.has(row.botId) || row.hidden === true || row.visible === false) return false;
        seen.add(row.botId); return STATES.has(states.get(row.botId) ?? row.state);
      }).map(row => ({ botId: row.botId, name: typeof row.name === "string" ? row.name : "", state: states.get(row.botId) ?? row.state }));
    } catch { return []; }
  };
  const wanted = kind => {
    const p = preferences();
    return !stopped && p.surfaces?.[kind] === true && available(kind) && !privateNow() && !hidden.has(kind) &&
      (kind !== "bubble" || roster().some(row => row.botId === p.pinnedBotId));
  };
  const rosterKey = kind => JSON.stringify(roster().filter(row => kind === "dock" || row.botId === preferences().pinnedBotId));
  const cancelFlush = record => {
    if (record.timer !== null) clearTimer(record.timer);
    record.timer = null; record.dirty = false;
  };
  const remove = record => {
    if (windows.get(record.key) !== record) return;
    windows.delete(record.key); cancelFlush(record);
    attentionIpc.unregister(record.win.webContents.id);
    if (!record.win.isDestroyed()) record.win.destroy();
  };
  const position = record => {
    const area = record.display.workArea;
    // Reserve adjacent columns on the primary display, including when either
    // card expands. Secondary displays only have a dock.
    const shared = wanted("bubble") && wanted("dock") && record.display.id === screen.getPrimaryDisplay().id;
    const gap = shared ? Math.min(12, Math.max(0, area.width - 2)) : 0;
    const maxWidth = shared ? Math.floor((area.width - gap) / 2) : area.width;
    const widthFor = expanded => Math.min(expanded ? 380 : 72, maxWidth);
    const width = widthFor(record.expanded);
    const offset = shared && record.kind === "bubble" ? widthFor(windows.get(`dock:${record.display.id}`)?.expanded) + gap : 0;
    const height = Math.min(record.expanded ? 520 : record.kind === "bubble" ? 72 : Math.max(72, roster().length * 56 + 16), area.height);
    const bounds = { x: Math.round(area.x + area.width - width - offset), y: Math.round(area.y + (area.height - height) / 2), width, height };
    if (JSON.stringify(bounds) !== JSON.stringify(record.bounds)) { record.bounds = bounds; record.win.setBounds(bounds); }
  };
  const flush = record => {
    record.timer = null;
    if (windows.get(record.key) !== record || !record.ready || !record.dirty || !wanted(record.kind)) return;
    record.dirty = false; record.lastPush = now();
    record.win.webContents.send("attention-window:changed");
  };
  const change = record => {
    record.dirty = true;
    if (!record.ready || record.timer !== null || !wanted(record.kind)) return;
    const delay = Math.max(0, record.lastPush + 500 - now());
    if (delay === 0) flush(record);
    else record.timer = setTimer(() => flush(record), delay);
  };
  const create = (key, kind, display) => {
    const win = new BrowserWindow({ width: 72, height: 72, frame: false, transparent: true, focusable: false,
      alwaysOnTop: true, skipTaskbar: true, show: false, resizable: false,
      ...(platform === "darwin" ? { type: "panel" } : {}),
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false } });
    const record = { key, kind, display, win, ready: false, expanded: false, timer: null, dirty: false, lastPush: -Infinity, loaded: null, rosterKey: rosterKey(kind) };
    windows.set(key, record);
    win.on("closed", () => remove(record));
    try {
      win.setContentProtection(true);
      win.setAlwaysOnTop(true, "status");
      if (platform === "darwin") win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
      attentionIpc.register(win.webContents.id, kind);
      for (const event of ["will-navigate", "will-frame-navigate", "will-attach-webview"]) win.webContents.on(event, event => event.preventDefault());
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("render-process-gone", () => remove(record));
      position(record);
      record.loaded = Promise.resolve().then(() => {
        if (windows.get(key) === record) return win.loadURL(loadUrlFor(kind));
      }).then(() => {
        if (windows.get(key) !== record) return;
        // A lock, preference change or hide during load must never show late.
        if (!wanted(kind)) { remove(record); return; }
        record.ready = true; win.showInactive();
        if (record.dirty) change(record);
      }).catch(() => remove(record));
    } catch { remove(record); }
    return record;
  };
  const cancelHide = kind => {
    const hold = hidden.get(kind);
    if (hold) clearTimer(hold.timer);
    hidden.delete(kind);
  };
  const sync = async () => {
    if (stopped) return;
    if (displayTimer !== null) { clearTimer(displayTimer); displayTimer = null; }
    const nextKey = JSON.stringify(preferences());
    if (prefKey !== nextKey) {
      for (const kind of KINDS) cancelHide(kind);
      for (const record of [...windows.values()]) remove(record);
      prefKey = nextKey;
    }
    const rows = roster();
    for (const id of states.keys()) if (!rows.some(row => row.botId === id)) states.delete(id);
    for (const row of rows) if (!states.has(row.botId)) states.set(row.botId, row.state);
    const targets = new Map();
    if (wanted("bubble")) targets.set("bubble", { kind: "bubble", display: screen.getPrimaryDisplay() });
    if (wanted("dock")) for (const display of screen.getAllDisplays()) targets.set(`dock:${display.id}`, { kind: "dock", display });
    for (const record of [...windows.values()]) if (!targets.has(record.key)) remove(record);
    const pending = [];
    for (const [key, target] of targets) {
      let record = windows.get(key);
      if (!record) record = create(key, target.kind, target.display);
      else {
        record.display = target.display; position(record);
        const nextRoster = rosterKey(record.kind);
        if (nextRoster !== record.rosterKey) { record.rosterKey = nextRoster; change(record); }
      }
      pending.push(record.loaded);
    }
    await Promise.all(pending);
  };
  const displayChanged = () => {
    if (stopped || displayTimer !== null || !windows.size) return;
    displayTimer = setTimer(() => { displayTimer = null; void sync(); }, 0);
  };
  for (const event of ["display-added", "display-removed", "display-metrics-changed"]) screen.on(event, displayChanged);
  const setBotState = (botId, state) => {
    if (stopped || typeof botId !== "string" || !STATES.has(state)) return false;
    const previous = states.get(botId) ?? roster().find(row => row.botId === botId)?.state;
    if (previous === state) return false;
    // Only visible bots in the supplied roster may reach an outside window.
    if (!roster().some(row => row.botId === botId)) return false;
    states.set(botId, state);
    for (const record of windows.values()) if (record.kind === "dock" || preferences().pinnedBotId === botId) {
      record.rosterKey = rosterKey(record.kind); change(record);
    }
    return true;
  };
  const hideForAnHour = kind => {
    if (stopped || !KINDS.includes(kind)) return { ok: false };
    cancelHide(kind);
    const hold = { timer: null };
    hidden.set(kind, hold);
    for (const record of [...windows.values()]) if (record.kind === kind) remove(record);
    hold.timer = setTimer(() => {
      if (hidden.get(kind) !== hold || stopped) return;
      hidden.delete(kind); void sync();
    }, HOUR);
    return { ok: true };
  };
  const forInfo = info => [...windows.values()].find(record => record.win.webContents.id === info.windowId && record.kind === info.kind && wanted(record.kind));
  return {
    sync, setBotState, hideForAnHour,
    /** Card retirement can change content without changing the bot's dot. */
    refresh(info) {
      const record = forInfo(info);
      if (record) change(record);
    },
    /** Main-only input to createAttentionWindowHost; no identities cross IPC. */
    readState(info) {
      if (!forInfo(info)) return null;
      const rows = roster();
      return { bots: info.kind === "bubble" ? rows.filter(row => row.botId === preferences().pinnedBotId) : rows };
    },
    /** An explicit click expands the card. Only then may the window take input. */
    setExpanded(info, expanded) {
      const record = forInfo(info);
      if (!record || !record.ready || typeof expanded !== "boolean") return { ok: false };
      record.expanded = expanded;
      for (const current of windows.values()) position(current);
      record.win.setFocusable(expanded);
      if (expanded) record.win.focus();
      return { ok: true };
    },
    status() {
      let reason = null;
      try { if (platform === "linux" && capabilities()?.session === "wayland") reason = WAYLAND_REASON; } catch {}
      return { reason, available: { bubble: available("bubble"), dock: available("dock") },
        windows: [...windows.values()].map(record => ({ kind: record.kind, windowId: record.win.webContents.id, displayId: record.display.id, visible: record.ready })),
        hidden: KINDS.filter(kind => hidden.has(kind)) };
    },
    destroy() {
      stopped = true;
      if (displayTimer !== null) clearTimer(displayTimer);
      displayTimer = null;
      for (const kind of KINDS) cancelHide(kind);
      for (const record of [...windows.values()]) remove(record);
      for (const event of ["display-added", "display-removed", "display-metrics-changed"]) screen.removeListener(event, displayChanged);
      states.clear();
    },
  };
}

/** Thin adapter for the existing router's bubble rung. The delivery owner calls
 * show(entry) only for that rung, and close() on retirement. Card authority and
 * window-bound tokens remain in host.items/act. Dock is state-driven only.
 */
export function createFloatSurface({ floatWindows, host }) {
  return {
    available: () => floatWindows.status().available.bubble,
    async show(entry) {
      await floatWindows.sync();
      const window = floatWindows.status().windows.find(row => row.kind === "bubble" && row.visible);
      if (!window || !floatWindows.readState({ kind: "bubble", windowId: window.windowId })?.bots.some(row => row.botId === entry?.frame?.botId)) return null;
      floatWindows.setBotState(entry.frame.botId, "needs-you");
      return `float:bubble:${window.windowId}`;
    },
    close() {
      for (const window of floatWindows.status().windows) if (window.kind === "bubble") {
        host.invalidateWindow(window.windowId, { retainBotKeys: true, retainCards: true });
        floatWindows.refresh(window);
      }
      // The watcher's next bot frame is the authority for the remaining dot.
    },
  };
}
