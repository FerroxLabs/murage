// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { fileURLToPath } from "node:url";

const PRELOAD = fileURLToPath(new URL("./attention-window-preload.cjs", import.meta.url));
const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

/** User-invoked surface only. No presence callback ever opens this window.
 * loadUrlFor must be the SAME function supplied to createAttentionIpc.
 * attentionIpc.unregister should also invalidate the host's window tokens.
 */
export function createTrayPanel({ BrowserWindow, tray, screen, platform, attentionIpc, loadUrlFor, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, presence = () => ({}) }) {
  const kind = platform === "darwin" ? "popover" : platform === "win32" ? "flyout" : "popup";
  let win = null, loaded = null, wanted = false, visible = false, destroyTimer = null, hideGeneration = 0;
  const cancelDestroy = () => { hideGeneration++; if (destroyTimer !== null) clearTimer(destroyTimer); destroyTimer = null; };
  const destroy = () => {
    cancelDestroy(); wanted = false; visible = false;
    const old = win; win = null; loaded = null;
    if (old && !old.isDestroyed()) old.destroy();
  };
  const hide = () => {
    if (!wanted && !visible && destroyTimer !== null) return;
    wanted = false; visible = false;
    if (!win || win.isDestroyed()) return;
    win.hide(); cancelDestroy();
    const deadline = now() + 120000, ticket = hideGeneration;
    destroyTimer = setTimer(() => {
      if (ticket !== hideGeneration || wanted) return;
      destroy();
    }, Math.max(0, deadline - now()));
    destroyTimer?.unref?.();
  };
  const position = bounds => {
    const anchor = platform === "linux" ? null : bounds ?? tray.getBounds();
    const area = anchor ? screen.getDisplayNearestPoint({ x: Math.round(anchor.x + anchor.width / 2), y: Math.round(anchor.y + anchor.height / 2) }).workArea : screen.getPrimaryDisplay().workArea;
    const width = Math.min(380, area.width), height = Math.min(560, area.height);
    const x = anchor ? anchor.x + anchor.width / 2 - width / 2 : area.x + area.width - width;
    const below = anchor ? anchor.y + anchor.height : area.y;
    const y = anchor && below + height > area.y + area.height ? anchor.y - height : below;
    win.setBounds({ x: Math.round(clamp(x, area.x, area.x + area.width - width)), y: Math.round(clamp(y, area.y, area.y + area.height - height)), width, height });
  };
  const show = async bounds => {
    cancelDestroy(); wanted = true;
    if (!win || win.isDestroyed()) {
      const created = new BrowserWindow({ width: 380, height: 560, frame: false, skipTaskbar: true, show: false, resizable: false,
        ...(platform === "darwin" ? { type: "panel" } : {}),
        webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false } });
      win = created;
      // Failure to protect does not prevent an explicit open. Never auto-show.
      if (platform === "darwin" || platform === "win32") try { created.setContentProtection(true); } catch {}
      try { presence(); } catch {}
      const id = created.webContents.id;
      attentionIpc.register(id, kind);
      created.on("closed", () => {
        attentionIpc.unregister(id);
        if (win === created) { cancelDestroy(); win = null; loaded = null; wanted = false; visible = false; }
      });
      if (platform !== "linux") created.on("blur", hide);
      for (const event of ["will-navigate", "will-frame-navigate", "will-attach-webview"]) created.webContents.on(event, event => event.preventDefault());
      created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      loaded = Promise.resolve().then(() => { if (!created.isDestroyed()) return created.loadURL(loadUrlFor(kind)); });
    }
    const current = win;
    try { position(bounds); await loaded; } catch { if (win === current) destroy(); return; }
    if (win !== current || current.isDestroyed() || !wanted || visible) return;
    visible = true; current.show(); current.focus();
  };
  return { show, hide, destroy, isOpen: () => visible, toggle: bounds => wanted ? hide() : show(bounds) };
}
