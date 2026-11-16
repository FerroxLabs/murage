// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { badgeSurfaceText } from "./badge-surface-copy.mjs";

const TASKS = Object.freeze([
  ["new-chief", "badgeSurfaces.newChief"],
  ["needs-you", "badgeSurfaces.openNeedsYou"],
  ["pause", "badgeSurfaces.pauseAutomations"],
]);
const knownTask = task => TASKS.some(([id]) => id === task);

export function badgeCountFor({ mode, unread, needsYou } = {}) {
  const value = mode === "needs-you" ? needsYou : mode === "unread" ? unread : 0;
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** Native objects and the Windows overlay image arrive from main. No timers or windows are created here. */
export function createBadgeSurfaces({ app, Menu, platform, prefs, onTask, t, window, overlayIcon }) {
  const words = (key, values) => {
    try {
      const translated = t?.(key, values);
      if (typeof translated === "string" && translated.trim() && translated !== key) return translated;
    } catch { /* use the catalogue's English wording */ }
    return badgeSurfaceText("en", key, values);
  };
  return {
    apply({ unread, needsYou }, win = window?.()) {
      const preference = prefs();
      const mode = preference?.badgeCount;
      let count = preference?.surfaces?.badge === true ? badgeCountFor({ mode, unread, needsYou }) : 0;
      // Today's unread path caps the combined local and Cloud count at 999.
      if (mode === "unread") count = Math.min(count, 999);
      if (platform === "win32") {
        if (!win || win.isDestroyed()) return;
        const icon = overlayIcon();
        win.setOverlayIcon(count > 0 && !icon.isEmpty() ? icon : null,
          mode === "needs-you" ? words("badgeSurfaces.needsYouCount", { count })
            : count > 0 ? `${count} unread conversation${count === 1 ? "" : "s"}` : "No unread conversations");
      } else if (platform === "darwin" || platform === "linux") app.setBadgeCount(count);
    },
    refreshMenu() {
      const enabled = prefs()?.badgeMenu === true;
      if (platform === "win32") {
        app.setUserTasks(enabled ? TASKS.map(([id, key]) => ({
          program: process.execPath, arguments: `--murage-task=${id}`,
          iconPath: process.execPath, iconIndex: 0, title: words(key), description: words(key),
        })) : []);
      } else if (platform === "darwin") {
        app.dock?.setMenu(Menu.buildFromTemplate(enabled ? TASKS.map(([id, key]) => ({
          label: words(key), click: () => onTask(id),
        })) : []));
      }
    },
  };
}

/** The first task argument decides, including when it is malformed. Never inspect later task arguments. */
export function parseMurageTask(argv) {
  try {
    if (!Array.isArray(argv)) return null;
    for (const arg of argv) {
      if (typeof arg !== "string") continue;
      if (arg === "--murage-task") return null;
      if (!arg.startsWith("--murage-task=")) continue;
      if (arg.length > 32) return null;
      const task = arg.slice("--murage-task=".length);
      return knownTask(task) ? task : null;
    }
  } catch { /* argv is untrusted input */ }
  return null;
}

export function routeMurageTask({ task, badgeMenuOn, open, openNeedsYou, newChiefTask, pauseAutomations }) {
  if (!knownTask(task)) return;
  if (badgeMenuOn !== true) return open();
  if (task === "new-chief") return newChiefTask();
  if (task === "needs-you") return openNeedsYou();
  return pauseAutomations();
}
