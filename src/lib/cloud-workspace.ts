// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B3 WP4: the renderer's view of "This computer" and "Cloud home". Two windows run this same app:
//   - the MAIN window (this computer): http origin, window.muragebox. It owns the switch and the pairing UI.
//   - the CLOUD window: served from murage-home://<homeId>/, window.muragecloud only. It talks to the home through main's
//     proxy, has no local features, and keeps no write queue: a write while the home is down fails at once.
// Everything here is pure or takes the bridge as an argument, so it is testable without Electron.

export const CLOUD_PROTOCOL = "murage-home:";

/** True when this renderer is served from the Cloud-home scheme. The one signal every "no queue" decision reads. */
export function isCloudOrigin(location: { protocol: string } | undefined = typeof globalThis.location === "undefined" ? undefined : globalThis.location): boolean {
  return location?.protocol === CLOUD_PROTOCOL;
}

type MuragecloudWindow = Window & typeof globalThis;
type Muragebox = NonNullable<MuragecloudWindow["muragebox"]>;
export type CloudHomeBridge = NonNullable<Muragebox["cloudHome"]>;
export type CloudHomeSummary = Awaited<ReturnType<CloudHomeBridge["listHomes"]>>[number];
export interface PairedHome { homeId: string; origin: string }

export type CloudWorkspace =
  | { enabled: false }
  | { enabled: true; cpSignedIn: boolean; paired: PairedHome[] };

/** The pairing bridge, or undefined: not a desktop, the Cloud window itself, or an older build. */
export function cloudHomeBridge(): CloudHomeBridge | undefined {
  if (typeof window === "undefined" || isCloudOrigin()) return undefined;
  return window.muragebox?.cloudHome;
}

/**
 * Whether the desktop Cloud flag is on, and what is paired. Any rejection means off: with the flag off main registers none
 * of the cloud-home channels, so the switch never appears.
 */
export async function loadCloudWorkspace(bridge: CloudHomeBridge | undefined = cloudHomeBridge()): Promise<CloudWorkspace> {
  if (!bridge) return { enabled: false };
  try {
    const state = await bridge.state();
    if (!state || state.enabled !== true) return { enabled: false };
    return { enabled: true, cpSignedIn: state.cpSignedIn === true, paired: Array.isArray(state.paired) ? state.paired : [] };
  } catch {
    return { enabled: false };
  }
}

export type WorkspaceChoice = "computer" | "cloud";

/** What "Cloud home" does when chosen: open the one paired home, or show the pairing panel. */
export function cloudChoiceAction(workspace: CloudWorkspace): { kind: "open"; homeId: string } | { kind: "pair" } {
  return workspace.enabled && workspace.paired.length === 1 ? { kind: "open", homeId: workspace.paired[0]!.homeId } : { kind: "pair" };
}

/** The bridge for badge and native notifications: the desktop's in the main window, the Cloud window's own in a Cloud window. */
export function notificationBridge(): { platform?: string; setUnreadCount?: (count: number) => void; approvalNotifications?: NonNullable<Muragebox["approvalNotifications"]> } | undefined {
  if (typeof window === "undefined") return undefined;
  return isCloudOrigin() ? window.muragecloud : window.muragebox;
}

/** `code` is main's: "disconnected" means the home refused this computer's sign-in (main then shows the Connect panel). */
export type Reachability = { ok: true } | { ok: false; message: string; code?: string };

/**
 * Ask main whether the home answers. Never throws; a failed ask is "not reachable". No bridge (a browser tab on the home's
 * own address) means there is nothing to ask and the answer is "fine".
 */
export async function checkReachable(bridge: Window["muragecloud"] = typeof window === "undefined" ? undefined : window.muragecloud): Promise<Reachability> {
  if (!bridge) return { ok: true };
  try {
    const answer = await bridge.reachable();
    return answer.ok ? { ok: true } : { ok: false, message: answer.message, ...(typeof answer.code === "string" ? { code: answer.code } : {}) };
  } catch {
    return { ok: false, message: "" };
  }
}
