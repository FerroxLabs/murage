// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The logic behind "How would you like to be notified?" (NOTIFY-EVERYWHERE-1019, section 3.1) and the Notify me settings rows
// (3.3), kept out of the components so it tests without a DOM. The components only draw what this decides.
import type { LocaleKey } from "@/locales";
import type { NotifyCapabilities, NotifySurfaceId, NotifySurfaces, NotifySurfacesBridge, SurfaceReason } from "./notify-surfaces";

export const CHOOSER_SURFACES: readonly NotifySurfaceId[] = ["notify", "receipt", "tray", "pill", "badge", "bubble", "dock", "shortcut"];

export type Picks = Record<NotifySurfaceId, boolean>;
export type OsFamily = "mac" | "windows" | "linux";

export function osFamily(platform: string): OsFamily {
  return platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "linux";
}

export interface ChooserRow {
  id: NotifySurfaceId;
  label: LocaleKey;
  note: LocaleKey;
  /** Whether this computer can do it; when not, the row shows `reason` and cannot be ticked. */
  available: boolean;
  reason?: LocaleKey;
  /** Needs more than a switch (the shortcut needs a recorded key): the row is shown, set in Settings. */
  needsSettings: boolean;
}

const LABEL: Record<NotifySurfaceId, Record<OsFamily, LocaleKey>> = {
  notify: { mac: "notifyChooser.notify.mac", windows: "notifyChooser.notify.windows", linux: "notifyChooser.notify.linux" },
  receipt: { mac: "notifyChooser.receipt", windows: "notifyChooser.receipt", linux: "notifyChooser.receipt" },
  tray: { mac: "notifyChooser.tray.mac", windows: "notifyChooser.tray.windows", linux: "notifyChooser.tray.linux" },
  pill: { mac: "notifyChooser.pill.mac", windows: "notifyChooser.pill.mac", linux: "notifyChooser.pill.mac" },
  badge: { mac: "notifyChooser.badge.mac", windows: "notifyChooser.badge.windows", linux: "notifyChooser.badge.linux" },
  bubble: { mac: "notifyChooser.bubble", windows: "notifyChooser.bubble", linux: "notifyChooser.bubble" },
  dock: { mac: "notifyChooser.dock", windows: "notifyChooser.dock", linux: "notifyChooser.dock" },
  shortcut: { mac: "notifyChooser.shortcut", windows: "notifyChooser.shortcut", linux: "notifyChooser.shortcut" },
};
const NOTE: Record<NotifySurfaceId, LocaleKey> = {
  notify: "notifyChooser.notify.note", receipt: "notifyChooser.receipt.note", tray: "notifyChooser.tray.note", pill: "notifyChooser.pill.note",
  badge: "notifyChooser.badge.note", bubble: "notifyChooser.bubble.note", dock: "notifyChooser.dock.note", shortcut: "notifyChooser.shortcut.note",
};
const REASON: Record<SurfaceReason, LocaleKey> = {
  "mac-only": "notifyChooser.reason.macOnly", wayland: "notifyChooser.reason.wayland", "no-session": "notifyChooser.reason.noSession",
  "no-tray-host": "notifyChooser.reason.noTrayHost", "portal-needed": "notifyChooser.reason.portalNeeded",
};

/** The eight rows for this computer. The pill row exists on a Mac only; every other row is shown, with a reason when it cannot work here. */
export function chooserRows(caps: NotifyCapabilities, opts: { includePill?: boolean } = {}): ChooserRow[] {
  const family = osFamily(caps.platform);
  return CHOOSER_SURFACES.filter(id => id !== "pill" || family === "mac" || opts.includePill === true).map(id => {
    const cap = caps.surfaces[id];
    const available = cap?.available !== false;
    return { id, label: LABEL[id][family], note: NOTE[id], available, needsSettings: id === "shortcut",
      ...(!available && cap?.reason ? { reason: REASON[cap.reason] } : {}) };
  });
}

/** What is ticked when the chooser opens: this computer's saved defaults, minus anything it cannot do, and never the shortcut (it needs a key). */
export function initialPicks(state: NotifySurfaces, rows: readonly ChooserRow[]): Picks {
  const picks = Object.fromEntries(CHOOSER_SURFACES.map(id => [id, false])) as Picks;
  for (const row of rows) picks[row.id] = row.available && !row.needsSettings && state.surfaces[row.id] === true;
  return picks;
}

export type ChooserOutcome = { outcome: "saved" | "kept-inside" };
export interface ChooserDeps { bridge: NotifySurfacesBridge; platform: string }

/** Continue: one key per set, then the chooser is done; on a Mac the system permission prompt comes last, inside the owner's click. */
export async function saveChooser(deps: ChooserDeps, rows: readonly ChooserRow[], picks: Picks): Promise<ChooserOutcome> {
  for (const row of rows) {
    if (row.needsSettings) continue;
    await deps.bridge.set(`surfaces.${row.id}`, row.available && picks[row.id] === true);
  }
  await deps.bridge.set("chooser", "done");
  if (osFamily(deps.platform) === "mac" && rows.some(row => (row.id === "notify" || row.id === "pill") && picks[row.id] && row.available)) {
    // A refused prompt is the owner's choice, not an error: the picks are saved and the banners fall back to Open only.
    try { await deps.bridge.ensurePermission?.(); } catch { /* the owner can allow it later in System Settings */ }
  }
  return { outcome: "saved" };
}

/** "Keep everything inside Murage for now": every row off (the tray and menu bar count stay), the two asks stay eligible. */
export async function keepInside(deps: ChooserDeps, rows: readonly ChooserRow[]): Promise<ChooserOutcome> {
  for (const row of rows) if (!row.needsSettings) await deps.bridge.set(`surfaces.${row.id}`, false);
  await deps.bridge.set("chooser", "kept-inside");
  return { outcome: "kept-inside" };
}

/** "N of 8 on" for the Notify me page, counting only rows this computer can run. */
export function surfacesOnCount(state: NotifySurfaces, caps: NotifyCapabilities): { on: number; of: number } {
  const on = CHOOSER_SURFACES.filter(id => caps.surfaces[id]?.available !== false && state.surfaces[id] === true).length;
  return { on, of: CHOOSER_SURFACES.length };
}
