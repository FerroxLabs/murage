// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The device file `notify-surfaces.json` (NOTIFY-EVERYWHERE-1019, section 6.2): which outside-the-app surfaces this
// computer uses. Plain JS with no zod so Electron main imports it like the other shared/*.mjs; the .d.ts gives the
// renderer its types. Never throws: a bad value falls back to the origin-correct default for that field.

export const NOTIFY_SURFACES_VERSION = 1;
export const SURFACE_IDS = Object.freeze(["notify", "receipt", "tray", "pill", "badge", "bubble", "dock", "shortcut"]);
export const ORIGINS = Object.freeze(["new", "upgrade"]);
export const CHOOSER_STATES = Object.freeze(["unseen", "done", "kept-inside"]);
export const MAX_FILE_BYTES = 8192;

const isPlainObject = value => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** Defaults for one origin on one platform (spec section 2 table and 6.3). Upgrades are exactly yesterday's behaviour. */
export function notifySurfaceDefaults(origin, platform) {
  if (origin === "upgrade") {
    return {
      v: NOTIFY_SURFACES_VERSION, origin: "upgrade",
      surfaces: { notify: true, receipt: true, tray: false, pill: false, badge: true, bubble: false, dock: false, shortcut: false },
      notifyActions: false, quietSummary: false, badgeMenu: false, badgeCount: "unread",
      receiptMinMinutes: 0, nudgeMinutes: 0, hideFullscreen: false, respectFocus: false,
      pinnedBotId: null, shortcut: null, chooser: "done", asks: { backgroundApproval: true, longJob: true },
    };
  }
  return {
    v: NOTIFY_SURFACES_VERSION, origin: "new",
    surfaces: { notify: true, receipt: true, tray: platform !== "darwin", pill: platform === "darwin", badge: true, bubble: false, dock: false, shortcut: false },
    notifyActions: true, quietSummary: true, badgeMenu: true, badgeCount: "needs-you",
    receiptMinMinutes: 2, nudgeMinutes: 5, hideFullscreen: true, respectFocus: true,
    pinnedBotId: null, shortcut: null, chooser: "unseen", asks: { backgroundApproval: false, longJob: false },
  };
}

const MODIFIERS = new Set(["command", "cmd", "control", "ctrl", "commandorcontrol", "cmdorctrl", "alt", "option", "altgr", "shift", "super", "meta"]);
const NAMED_KEYS = new Set(["space", "tab", "capslock", "numlock", "scrolllock", "backspace", "delete", "insert", "return", "enter", "up", "down", "left", "right", "home", "end", "pageup", "pagedown", "escape", "esc", "plus", "minus"]);
/** An Electron accelerator that is safe to hand to globalShortcut: at least one modifier, exactly one key. */
export function validAccelerator(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 64 || value.trim() !== value) return false;
  const parts = value.split("+");
  if (parts.some(part => part.length === 0)) return false;
  const key = parts[parts.length - 1], mods = parts.slice(0, -1);
  if (mods.length === 0 || new Set(mods.map(part => part.toLowerCase())).size !== mods.length) return false;
  if (!mods.every(part => MODIFIERS.has(part.toLowerCase()))) return false;
  const lower = key.toLowerCase();
  if (MODIFIERS.has(lower)) return false;
  return /^[A-Za-z0-9]$/.test(key) || /^f([1-9]|1\d|2[0-4])$/.test(lower) || NAMED_KEYS.has(lower);
}

const BOOLEAN_KEYS = ["notifyActions", "quietSummary", "badgeMenu", "hideFullscreen", "respectFocus"];
const CHOICES = { badgeCount: ["needs-you", "unread"], receiptMinMinutes: [0, 2, 5], nudgeMinutes: [0, 5, 15], chooser: CHOOSER_STATES };

/** Check ONE key. Keys: a top-level key, `surfaces.<id>` or `asks.<name>`. Returns {ok:true,value} or {ok:false}. */
export function checkNotifySurfaceKey(key, value) {
  if (typeof key !== "string") return { ok: false };
  if (key.startsWith("surfaces.")) return SURFACE_IDS.includes(key.slice(9)) && typeof value === "boolean" ? { ok: true, value } : { ok: false };
  if (key.startsWith("asks.")) return ["backgroundApproval", "longJob"].includes(key.slice(5)) && typeof value === "boolean" ? { ok: true, value } : { ok: false };
  if (BOOLEAN_KEYS.includes(key)) return typeof value === "boolean" ? { ok: true, value } : { ok: false };
  if (Object.hasOwn(CHOICES, key)) return CHOICES[key].includes(value) ? { ok: true, value } : { ok: false };
  if (key === "pinnedBotId") return value === null || (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)) ? { ok: true, value } : { ok: false };
  if (key === "shortcut") return value === null || validAccelerator(value) ? { ok: true, value } : { ok: false };
  return { ok: false };
}

/** Normalise any parsed JSON into a full valid state. Returns null when it is not a version-1 object at all. */
export function normalizeNotifySurfaces(value, platform, fallbackOrigin = "new") {
  if (!isPlainObject(value) || value.v !== NOTIFY_SURFACES_VERSION) return null;
  const origin = ORIGINS.includes(value.origin) ? value.origin : fallbackOrigin;
  const out = notifySurfaceDefaults(origin, platform);
  if (isPlainObject(value.surfaces)) for (const id of SURFACE_IDS) { const r = checkNotifySurfaceKey(`surfaces.${id}`, value.surfaces[id]); if (r.ok) out.surfaces[id] = r.value; }
  if (isPlainObject(value.asks)) for (const name of ["backgroundApproval", "longJob"]) { const r = checkNotifySurfaceKey(`asks.${name}`, value.asks[name]); if (r.ok) out.asks[name] = r.value; }
  for (const key of [...BOOLEAN_KEYS, ...Object.keys(CHOICES), "pinnedBotId", "shortcut"]) { const r = checkNotifySurfaceKey(key, value[key]); if (r.ok) out[key] = r.value; }
  // The pill exists on a Mac only; whatever a file says, no other OS runs it.
  if (platform !== "darwin") out.surfaces.pill = false;
  return out;
}
