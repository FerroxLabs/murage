// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What this computer can do for NOTIFY-EVERYWHERE-1019 (section 3.3 "Not on this computer", D5). Read only: it never
// changes anything. Reasons are codes; the renderer turns them into catalogue strings.

/** "x11" | "wayland" | null from the session environment (Linux only). */
export function linuxSessionType(env) {
  const declared = String(env?.XDG_SESSION_TYPE ?? "").toLowerCase();
  if (declared === "wayland" || env?.WAYLAND_DISPLAY) return "wayland";
  if (declared === "x11" || env?.DISPLAY) return "x11";
  return null;
}

// Electron returns the NSStatusItem button's window frame in display points.
function macTrayHidden(tray, screen) {
  try {
    if (!tray || tray.isDestroyed()) return undefined;
    const { x, y, width, height } = tray.getBounds();
    const displays = screen.getAllDisplays();
    if (!displays.length || ![x, y, width, height].every(Number.isFinite)) return undefined;
    if (width <= 0 || height <= 0) return true;
    const cx = x + width / 2, cy = y + height / 2;
    return !displays.some(({ bounds, workArea }) => cx >= bounds.x && cx < bounds.x + bounds.width &&
      cy >= bounds.y && cy < bounds.y + Math.max(height, workArea.y - bounds.y));
  } catch { return undefined; }
}

/** trayHost: true | false | null (unknown / not probed). */
export function notifyCapabilities({ platform, env = {}, trayHost = null, tray, screen } = {}) {
  const session = platform === "linux" ? linuxSessionType(env) : null;
  const wayland = session === "wayland";
  const floatOk = platform !== "linux" || session === "x11";
  const trayHidden = platform === "darwin" ? macTrayHidden(tray, screen) : undefined;
  return {
    platform, session, ...(trayHidden === undefined ? {} : { trayHidden }),
    surfaces: {
      notify: { available: true },
      receipt: { available: true },
      tray: platform === "linux" && trayHost === false ? { available: true, reason: "no-tray-host" } : { available: true },
      pill: platform === "darwin" ? { available: true } : { available: false, reason: "mac-only" },
      badge: { available: true },
      bubble: floatOk ? { available: true } : { available: false, reason: wayland ? "wayland" : "no-session" },
      dock: floatOk ? { available: true } : { available: false, reason: wayland ? "wayland" : "no-session" },
      shortcut: platform === "linux" && wayland ? { available: true, reason: "portal-needed" } : { available: true },
    },
  };
}
