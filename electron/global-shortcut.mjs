// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { validAccelerator } from "../shared/notify-surfaces.mjs";

export const SHORTCUT_PORTAL_REASON = "Needs the GlobalShortcuts portal: this desktop does not offer one.";

/** One registration, with no windows or polling. A failed replacement keeps the old key. */
export function createGlobalShortcut({ globalShortcut, platform, isWayland = () => false, portal, onTrigger, log = () => {}, now = Date.now }) {
  let current = null, reason = null, disposed = false;
  const report = code => { try { log(`global-shortcut: ${code}`); } catch { /* logging cannot prevent cleanup */ } };
  const available = () => {
    try { return platform !== "linux" || !isWayland() || portal?.available() === true; }
    catch { return false; }
  };
  const release = entry => { try { entry?.unregister(); } catch { report("unregister"); } };
  const status = () => ({
    active: current !== null, accelerator: current?.accelerator ?? null,
    ...(reason ? { reason } : {}),
    ...(!available() ? { disabledReason: SHORTCUT_PORTAL_REASON } : {}),
  });
  const refuse = why => { reason = why; return { ok: false, reason: why }; };
  const trySet = accelerator => {
    if (!validAccelerator(accelerator)) return refuse("invalid");
    if (disposed || !available()) return refuse("unsupported");
    if (current?.accelerator === accelerator) { reason = null; return { ok: true }; }
    const entry = { accelerator, unregister: null, lastPress: -Infinity };
    const trigger = () => {
      if (disposed || current !== entry) return;
      try {
        const time = now();
        if (time - entry.lastPress < 250) return;
        entry.lastPress = time;
        Promise.resolve(onTrigger()).catch(() => report("trigger"));
      } catch { report("trigger"); }
    };
    try {
      if (platform === "linux" && isWayland()) {
        entry.unregister = portal.register(accelerator, trigger);
        if (typeof entry.unregister !== "function") return refuse("taken");
      } else {
        if (globalShortcut.register(accelerator, trigger) !== true) return refuse("taken");
        entry.unregister = () => globalShortcut.unregister(accelerator);
      }
    } catch { return refuse("taken"); }
    const previous = current;
    current = entry;
    reason = null;
    release(previous);
    return { ok: true };
  };
  return {
    trySet, status,
    sync(accelerator) {
      if (accelerator === null) {
        const previous = current;
        current = null; reason = null; release(previous);
        return { ok: true, active: false };
      }
      const result = trySet(accelerator);
      return { ...result, active: current !== null };
    },
    dispose() {
      disposed = true;
      const previous = current;
      current = null; release(previous);
    },
  };
}

/** Before app ready, preserve other Chromium features when enabling Electron's portal path. */
export function enableGlobalShortcutPortal(commandLine) {
  const features = commandLine.getSwitchValue("enable-features").split(",").filter(Boolean);
  if (!features.includes("GlobalShortcutsPortal")) {
    commandLine.appendSwitch("enable-features", [...features, "GlobalShortcutsPortal"].join(","));
  }
}

/** One bounded session-bus read. Unknown desktops leave the shortcut unavailable. */
export function globalShortcutPortalAvailable(execFile) {
  return new Promise(resolve => {
    try {
      execFile("/usr/bin/gdbus", ["call", "--session", "--dest", "org.freedesktop.portal.Desktop",
        "--object-path", "/org/freedesktop/portal/desktop", "--method", "org.freedesktop.DBus.Properties.Get",
        "org.freedesktop.portal.GlobalShortcuts", "version"],
      { timeout: 1500, maxBuffer: 4096, windowsHide: true },
      (error, stdout) => resolve(!error && /uint32\s+[1-9]\d*/.test(String(stdout))));
    } catch { resolve(false); }
  });
}
