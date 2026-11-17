// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { fileURLToPath } from "node:url";

const PRELOAD = fileURLToPath(new URL("./attention-window-preload.cjs", import.meta.url));
const clamp = (n, min, max) => Math.max(min, Math.min(n, max));
const finite = n => typeof n === "number" && Number.isFinite(n);

/** Mac-only, event-driven panel. Items are MAIN-only attention host records plus
 * itemId, kind, previews (explicit boolean), createdAt and optional receiptText.
 * Call readItems from the shared host's readItems('pill'); connect pillFocus and
 * pillExpand to that host. onChange runs BEFORE the renderer's changed message,
 * including teardown, so the host can invalidate its tokens synchronously. Listeners get
 * (windowId, {discard}); discard is true for hideAll and window close.
 * Supply the same loadUrlFor as the IPC gate. powerMonitor supplies suspend and
 * resume; screen supplies display events. Presence changes call hideAll, with
 * held events owned by the caller. No hidden content is retained for replay.
 * Auxiliary top rectangles use Electron display coordinates (DIP).
 * show/receipt accept a main-only isCurrent callback to cancel delivery across
 * the awaited window load, before any native presentation.
 */
export function createPillWindow({ BrowserWindow, screen, attentionIpc, loadUrlFor,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  presence = () => null, getSafeAreaTop = () => 0, powerMonitor,
  platform = process.platform, replyTyping = false }) {
  const rows = new Map(), listeners = new Set(), subscriptions = [];
  let win = null, loaded = null, visible = false, expanded = false, disposed = false;
  let sequence = 0, destroyTimer = null, layoutTimer = null, hideGeneration = 0;
  const ordered = () => [...rows.values()].sort((a, b) => a.at - b.at || a.order - b.order);
  const state = () => !rows.size ? "hidden" : [...rows.values()].every(row => row.item.kind === "receipt")
    ? "finished" : expanded ? rows.size > 1 ? "stacked" : "expanded" : "collapsed";
  const reason = () => {
    try {
      const p = presence();
      for (const key of ["locked", "sharing", "fullscreen"]) if (p?.[key] === true) return key;
      return ["locked", "sharing", "fullscreen"].every(key => p?.[key] === false) ? null : "presence";
    } catch { return "presence"; }
  };
  // discard:true = presence/privacy withdrawal or window close (drop card identity); false = a stack
  // change or retirement push (the host keeps card ids so a Reply draft survives the refresh).
  const notify = (current = win, send = true, discard = false) => {
    if (!current) return;
    for (const listener of listeners) listener(current.webContents.id, { discard });
    if (send && !current.isDestroyed()) current.webContents.send("attention-window:changed");
  };
  const cancelDestroy = () => {
    hideGeneration++;
    if (destroyTimer !== null) clearTimer(destroyTimer);
    destroyTimer = null;
  };
  const cancelLayout = () => { if (layoutTimer !== null) clearTimer(layoutTimer); layoutTimer = null; };
  const clearRows = () => {
    for (const row of rows.values()) if (row.timer !== null) clearTimer(row.timer);
    rows.clear(); expanded = false;
  };
  const dropWindow = () => {
    cancelDestroy(); cancelLayout(); visible = false;
    const old = win; win = null; loaded = null;
    if (old && !old.isDestroyed()) old.destroy();
  };
  const hide = () => {
    expanded = false; visible = false; cancelLayout();
    if (!win || win.isDestroyed()) return;
    win.setFocusable(false); win.hide();
    if (destroyTimer !== null) return;
    const ticket = ++hideGeneration, deadline = now() + 120000;
    destroyTimer = setTimer(() => { if (ticket === hideGeneration && !rows.size) dropWindow(); }, Math.max(0, deadline - now()));
    destroyTimer?.unref?.();
  };
  const hideAll = () => { clearRows(); notify(win, true, true); hide(); };
  const geometryFor = display => {
    const area = display.workArea, bounds = display.bounds ?? area;
    let top = 0;
    try { const value = getSafeAreaTop(display.id); if (finite(value) && value > 0) top = value; } catch {}
    const notch = display.internal !== false && top > 0;
    const left = display.auxiliaryTopLeftArea, right = display.auxiliaryTopRightArea;
    const gap = left && right && [left.x, left.width, right.x].every(finite) && right.x > left.x + left.width;
    const center = notch && gap ? (left.x + left.width + right.x) / 2 : bounds.x + bounds.width / 2;
    const width = Math.round(Math.min(expanded ? 380 : 280, area.width));
    const y = clamp(notch ? Math.max(area.y, bounds.y + top) : area.y, area.y, area.y + area.height - 1);
    const height = Math.round(Math.min(expanded ? 560 : 72, area.y + area.height - y));
    return { x: Math.round(clamp(center - width / 2, area.x, area.x + area.width - width)), y: Math.round(y), width, height };
  };
  const position = () => {
    if (win && !win.isDestroyed()) win.setBounds(geometryFor(screen.getDisplayNearestPoint(screen.getCursorScreenPoint())));
  };
  const scheduleLayout = () => {
    if (disposed || !win || !rows.size || layoutTimer !== null) return;
    layoutTimer = setTimer(() => {
      layoutTimer = null;
      if (!win || !rows.size) return;
      if (reason()) { hideAll(); return; }
      try { position(); } catch { hideAll(); }
    }, 0);
    layoutTimer?.unref?.();
  };
  const listen = (source, event, callback) => {
    if (!source?.on) return;
    source.on(event, callback); subscriptions.push(() => source.removeListener(event, callback));
  };
  for (const event of ["display-metrics-changed", "display-added", "display-removed"]) listen(screen, event, scheduleLayout);
  listen(powerMonitor, "suspend", () => { hideAll(); });
  listen(powerMonitor, "resume", scheduleLayout);
  // Native display sleep/wake adapters may emit these on screen as well.
  for (const event of ["display-sleep", "display-wake"]) listen(screen, event, scheduleLayout);
  const settle = itemId => {
    const row = rows.get(itemId);
    if (!row) return false;
    if (row.timer !== null) clearTimer(row.timer);
    rows.delete(itemId);
    if (win && !win.isDestroyed()) win.setFocusable(false);
    if (![...rows.values()].some(row => row.item.kind !== "receipt")) expanded = false;
    notify();
    if (!rows.size) hide(); else position();
    return true;
  };
  const show = async (item, { isCurrent = () => true } = {}) => {
    if (disposed || platform !== "darwin") return { shown: false, reason: disposed ? "destroyed" : "platform" };
    if (!isCurrent()) return { shown: false, reason: "withdrawn" };
    const blocked = reason();
    if (blocked) { hideAll(); return { shown: false, reason: blocked }; }
    if (!item || typeof item.itemId !== "string" || !item.itemId || (item.kind !== "receipt" && (!item.threadId || !item.messageId)))
      return { shown: false, reason: "item" };
    if (!rows.has(item.itemId) && rows.size >= 100) return { shown: false, reason: "capacity" };
    const previous = rows.get(item.itemId);
    if (previous?.timer !== null && previous?.timer !== undefined) clearTimer(previous.timer);
    const kind = item.kind === "approval" || item.kind === "receipt" ? item.kind : "question";
    const previews = item.previews === true;
    const row = { item: { ...item, kind, display: previews ? item.display : null, level: previews ? item.level : "",
      receiptText: previews && typeof item.receiptText === "string" ? item.receiptText : "",
      outsideOk: previews && kind === "approval" ? item.outsideOk : {},
      actionToken: undefined, replyFocusToken: undefined },
      at: previous?.at ?? (finite(item.createdAt) ? item.createdAt : now()), order: previous?.order ?? ++sequence, timer: null };
    rows.set(item.itemId, row); cancelDestroy();
    if (![...rows.values()].some(row => row.item.kind !== "receipt")) expanded = false;
    let current = win;
    try {
      if (!win || win.isDestroyed()) {
        const created = new BrowserWindow({ width: 280, height: 72, type: "panel", frame: false, transparent: true,
          focusable: false, show: false, skipTaskbar: true, resizable: false,
          webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false } });
        win = created; current = created;
        created.on("closed", () => {
          notify(created, false, true); attentionIpc.unregister(created.webContents.id);
          if (win === created) { clearRows(); cancelDestroy(); cancelLayout(); win = null; loaded = null; visible = false; }
        });
        created.setContentProtection(true);
        created.setAlwaysOnTop(true, "status");
        created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
        attentionIpc.register(created.webContents.id, "pill");
        created.on("blur", () => { if (!created.isDestroyed()) created.setFocusable(false); });
        for (const event of ["will-navigate", "will-frame-navigate", "will-attach-webview"])
          created.webContents.on(event, event => event.preventDefault());
        created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        loaded = Promise.resolve().then(() => { if (!created.isDestroyed()) return created.loadURL(loadUrlFor("pill")); });
      }
      position(); notify(); await loaded;
      if (win !== current || current.isDestroyed() || rows.get(item.itemId) !== row) return { shown: false, reason: "withdrawn" };
      if (!isCurrent()) { settle(item.itemId); return { shown: false, reason: "withdrawn" }; }
      const changed = reason();
      if (changed) { hideAll(); return { shown: false, reason: changed }; }
      if (!visible) { current.setFocusable(false); current.showInactive(); visible = true; }
      if (kind === "receipt") {
        row.timer = setTimer(() => { if (rows.get(item.itemId) === row) settle(item.itemId); }, 6000);
        row.timer?.unref?.();
      }
      return { shown: true };
    } catch {
      if (win === current) { clearRows(); notify(); dropWindow(); }
      return { shown: false, reason: "window" };
    }
  };
  return {
    show, settle, receipt: (item, options) => show({ ...item, kind: "receipt" }, options), hideAll,
    destroy() { disposed = true; clearRows(); dropWindow(); for (const stop of subscriptions) stop(); listeners.clear(); },
    count: () => rows.size, geometryFor,
    readItems() {
      if (rows.size && reason()) hideAll();
      const entries = ordered();
      return { previews: true, items: entries.filter(row => row.item.kind !== "receipt").map(row => row.item),
        receipts: entries.filter(row => row.item.kind === "receipt").map(row => ({ text: row.item.receiptText })),
        pill: { state: state(), count: rows.size }, running: [], chief: null };
    },
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    pillExpand(windowId, value) {
      if (!visible || win?.webContents.id !== windowId || reason() || !rows.size) return false;
      expanded = value === true; win.setFocusable(false); position(); notify(); return true;
    },
    pillFocus(windowId, value = true) {
      if (!win || win.isDestroyed() || win.webContents.id !== windowId) return false;
      if (!value) { win.setFocusable(false); return true; }
      if (!replyTyping || !visible || !expanded || reason()) return false;
      try { win.setFocusable(true); return true; } catch { return false; }
    },
  };
}

/** Delivery seam, deliberately not installed in attention-main/main.mjs.
 * Forward surfaces.show('pill'|'receipt-pill', entry) here; result is string[]
 * or null. Forward close(ids, entry) here for ids beginning 'pill:'. mapItem
 * must read the validated card using entry's captured home/transport and return
 * a main-only host record with explicit previews. Never map display from an
 * unvalidated offer. host is createAttentionWindowHost's result. Wire its
 * readItems('pill') to pillWindow.readItems(), surfaceFor('pill') to 'pill',
 * pillFocus/pillExpand to the matching window methods, and replyTyping only
 * after S0 evidence. Wire privacy/presence withdrawal to pillWindow.hideAll().
 * Call dispose at shutdown (window.destroy is separate). No delivery protocol
 * is implemented here. The caller owns holding/retry when show returns null.
 */
export function createPillSurface({ pillWindow, host, mapItem }) {
  const stop = pillWindow.onChange((windowId, { discard = false } = {}) =>
    discard ? host.invalidateWindow(windowId) : host.invalidateWindow(windowId, { retainCards: true }));
  const ids = new WeakMap(); let sequence = 0, disposed = false;
  return {
    async show(rung, entry, generation = entry.generation) {
      if (disposed || (rung !== "pill" && rung !== "receipt-pill")) return null;
      const isCurrent = () => !entry.dead && !disposed && entry.generation === generation;
      if (!isCurrent()) return null;
      let item;
      try { item = await mapItem(entry); } catch { return null; }
      if (!item || !isCurrent()) return null;
      const id = `pill:${++sequence}`;
      const mapped = { ...item, itemId: id, kind: rung === "receipt-pill" ? "receipt" : entry.frame?.kind };
      const result = await (rung === "receipt-pill" ? pillWindow.receipt(mapped, { isCurrent }) : pillWindow.show(mapped, { isCurrent }));
      if (!result.shown) return null;
      if (!isCurrent()) { pillWindow.settle(id); return null; }
      let owned = ids.get(entry);
      if (!owned) { owned = new Set(); ids.set(entry, owned); }
      owned.add(id); return [id];
    },
    close(surfaceIds, entry) {
      const owned = ids.get(entry);
      for (const id of surfaceIds ?? []) if (owned?.delete(id)) pillWindow.settle(id);
    },
    dispose() { disposed = true; pillWindow.hideAll(); stop(); },
  };
}
