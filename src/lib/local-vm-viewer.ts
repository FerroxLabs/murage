// SPDX-License-Identifier: AGPL-3.0-or-later
/** The shared Local VM's viewer address carries its desktop password in the fragment. It goes from the status answer straight into Murage's
 *  own viewer window and nowhere else: never into component state, never into a link the system browser would open and keep in its history. */

/** The status as the settings page may keep it: everything but the viewer address. */
export function withoutViewerUrl<T extends object>(status: T): Omit<T, "viewer_url"> {
  const { viewer_url: _viewerUrl, ...rest } = status as T & { viewer_url?: unknown };
  return rest as Omit<T, "viewer_url">;
}

export interface DesktopViewerBridge {
  open(url: string, title: string, contextId: string): Promise<boolean>;
}

/** Ask for the status afresh and hand its viewer address to Murage's own viewer window. The address lives in this function's scope only. */
export async function openLocalVmViewer(
  fetchStatus: () => Promise<unknown>,
  viewer: DesktopViewerBridge,
  title: string,
  contextId: string,
): Promise<boolean> {
  const raw = await fetchStatus();
  const address = raw && typeof raw === "object" ? (raw as { viewer_url?: unknown }).viewer_url : undefined;
  if (typeof address !== "string" || !address.startsWith("http")) return false;
  return viewer.open(address, title, contextId);
}
