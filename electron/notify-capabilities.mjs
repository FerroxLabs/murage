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

/** trayHost: true | false | null (unknown / not probed). */
export function notifyCapabilities({ platform, env = {}, trayHost = null } = {}) {
  const session = platform === "linux" ? linuxSessionType(env) : null;
  const wayland = session === "wayland";
  const floatOk = platform !== "linux" || session === "x11";
  return {
    platform, session,
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
