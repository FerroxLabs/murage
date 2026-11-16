// The renderer's side of the device notification surfaces (NOTIFY-EVERYWHERE-1019, S2). Main owns the file; this wraps the
// preload bridge so components never touch it directly, and so a web build (no bridge) shows nothing new.
import type { NotifySurfaces, NotifySurfaceId } from "../../shared/notify-surfaces.mjs";
export type { NotifySurfaces, NotifySurfaceId, NotifyOrigin, NotifyChooserState } from "../../shared/notify-surfaces.mjs";

export type SurfaceReason = "mac-only" | "wayland" | "no-session" | "no-tray-host" | "portal-needed";
export interface NotifyCapabilities {
  platform: string;
  session: "x11" | "wayland" | null;
  surfaces: Record<NotifySurfaceId, { available: boolean; reason?: SurfaceReason }>;
}
export interface NotifySurfacesBridge {
  get(): Promise<NotifySurfaces>;
  /** Shortcut registration can refuse before the preference is written. */
  set(key: "shortcut" | "surfaces.shortcut", value: unknown): Promise<NotifySurfaces | { ok: false; reason: "taken" | "invalid" | "unsupported" }>;
  set(key: string, value: unknown): Promise<NotifySurfaces>;
  reset(): Promise<NotifySurfaces>;
  capabilities(): Promise<NotifyCapabilities>;
  /** Mac: the system permission prompt, asked only from the owner's Continue click. Other systems: nothing to ask. */
  ensurePermission?(): Promise<{ authorized: boolean }>;
}

export function notifySurfacesBridge(): NotifySurfacesBridge | null {
  return typeof window === "undefined" ? null : (window.muragebox?.notifySurfaces ?? null);
}

/** True only on a desktop new install whose chooser is still unseen. Upgrades, web builds, and a finished or skipped chooser: false. */
export async function shouldShowNotifyChooser(bridge: NotifySurfacesBridge | null = notifySurfacesBridge()): Promise<boolean> {
  if (!bridge) return false;
  try {
    const state = await bridge.get();
    return state.origin === "new" && state.chooser === "unseen";
  } catch {
    return false;
  }
}
